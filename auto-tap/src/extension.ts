// 连点器 (Swiplet)
// ---------------------------------------------------------------------------
// start    : 跳转到「勾选的目标对象」→ 按已启用点位的顺序循环点击，间隔可配置。
// record   : 跳转同一个目标对象 → 抓一张当前画面 → 回到 Swipt 供点选记录坐标。
//            抓图前先销毁上一张，过期截图由设置页 / readRecording 自动清理。
// listApps : 读取设备已安装应用，供设置页维护跳转白名单。
// 自动停止由 watchStop() 四路并行监控：应用事件 / 前台 / 锁屏 / 屏幕状态，
// 任一命中立刻 abort 连点循环。
// 从快捷指令启动时，输入法（如 com.tencent.wetype）会占用前台身份，导致
// launchApplication 自带的 3.5s 校验误报「launched, but xxx is still in
// front」；目标其实已启动，见 confirmLaunched() 的容错，别改回直接 return。
// 注意：iOS 下拉控制中心不改变前台身份，也没有可靠事件，故不再尝试检测；
// 要停止请切回 Swipt / 切到别的应用 / 锁屏。
//
// 【架构要点，别再改回去】
// internal/automation/engine.go: Host.execute() 每次执行 Action 都会 newEngine()
// 并 defer e.close()。Action 的 run() 一返回，整个 JS 引擎立即销毁。
// 设置页调用（caller=app）的连点循环必须 await 在 Action 内，不能 fire-and-forget；
// 但快捷指令（caller=shortcuts）会让 iOS App Intent timeout，那条路径只做
// 跳转 + 写启动命令就立即返回，由常驻服务 run() 接手循环与「运行等待时间」。
// run() 常驻服务与 Action 是两个独立引擎，内存不共享；配置、坐标与启动命令
// 都通过 dataDirectory 里的文件传递。
//
// input.tap 与 device.info().screen 同一坐标系（ops.go deviceTap → TapPoint →
// touchPoint 用 screenGeometry 归一化，screen.go touchTurns 负责旋转）。
// ---------------------------------------------------------------------------

import type { Point } from "@swipt/api";
import * as device from "@swipt/api/device";
import { dataDirectory } from "@swipt/api/file-system";
import * as input from "@swipt/api/input";
import { defineAction, defineExtension } from "@swipt/api/swiplet";
import {
  clampLaunchDelay,
  clearRecording,
  readSettings,
  recordImageFile,
  recordImageName,
  REF_H,
  REF_W,
  targetBundle,
  writeRecording,
  type TapPoint,
} from "./settings";

/** Swipt 自身，抓取画面后跳回设置页用（官方 ownApps 正则里的前缀） */
const SWIPT_BUNDLE_ID = "io.nekohasekai.swipt";
/** 坐标记录：跳到游戏后留给用户切到目标画面的时间 */
const RECORD_DELAY_MS = 2000;
// 跳转后到首次点击之间的「运行等待时间」不在此处定义：
// 由 settings.launchDelayMs 提供（默认 3 秒，可在设置页自定义）。
/** 启动后的事件宽限期，避免切换动画里的系统 UI 事件误停 */
const GRACE_MS = 800;
/** 连续点击失败多少次后退出 */
const MAX_FAILURES = 3;

interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

interface Report {
  taps: number;
  points: number;
  screen: string;
  point: string;
  front: string;
  stopReason: string;
  lastError: string;
  /** 诊断用：app / shortcuts / api，方便从快捷指令的返回值判断调用来源 */
  caller: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 键盘 / 输入法扩展会短暂占用「前台应用」身份。
 *
 * 从 iOS 快捷指令启动连点时，「运行 Swiplet 动作」带着输入框，微信输入法
 * com.tencent.wetype 可能一直挂在前台；官方 Phone.Launch 有写死的 3.5s
 * 前台校验，于是报 "com.tencent.nrc launched, but com.tencent.wetype is
 * still in front after 3.5s"。目标其实已经启动、游戏界面也在最前面，
 * 这种身份不该被当成「切走」。从插件设置页启动没有键盘，所以一直正常。
 *
 * launchApplication 没有参数可以关掉这个校验，只能在插件侧容错。
 */
const KEYBOARD_HINTS = [
  "wetype",
  "keyboard",
  "inputmethod",
  "sogou",
  "baidu.input",
  "iflytek",
];

function isKeyboardFront(front: string): boolean {
  const lower = front.toLowerCase();
  return KEYBOARD_HINTS.some((hint) => lower.includes(hint));
}

/** 前台为空（读取失败）、是目标 App、或只是输入法残留，都允许继续点击 */
function frontAllowsTapping(front: string, target: string): boolean {
  return front === "" || front === target || isKeyboardFront(front);
}

/** 切换过程中的过渡身份，不算真正切到别的应用 */
function isTransientFront(front: string): boolean {
  return (
    isKeyboardFront(front) ||
    front === SWIPT_BUNDLE_ID ||
    front === "com.apple.springboard"
  );
}

/**
 * launchApplication 抛错后自行确认前台，最多再等约 2 秒。
 * 只有确实切到另一个应用才算失败；输入法残留 / 前台读不到都按已跳转继续。
 */
async function confirmLaunched(
  signal: AbortSignal,
  target: string,
  report: Report,
): Promise<boolean> {
  let last = "";
  for (let attempt = 0; attempt < 5 && !signal.aborted; attempt += 1) {
    const front = await device.foregroundApplication
      .get({ signal })
      .catch(() => "");
    if (front !== "") {
      report.front = front;
      last = front;
    }
    // 输入法残留 / 目标已在前台 / 读不到：直接放行。
    // Swipt 自身或桌面属于切换中间态，再等一会儿让游戏真正到前台。
    if (front === "" || front === target || isKeyboardFront(front)) {
      return true;
    }
    await sleep(400, signal);
  }
  if (last !== "" && last !== target && !isTransientFront(last)) {
    report.stopReason = `前台仍为 ${last}`;
    return false;
  }
  return !signal.aborted;
}

/**
 * 屏幕尺寸 = input.tap 的坐标系，必须原样使用 device.info().screen 的宽高。
 *
 * 【别改回去，这是横屏点不准的根因】
 * Swipt 底层 internal/device/connection.go 里 screenGeometry 的 Width/Height
 * 直接取自 display info 的当前宽高，screen.go 的 touchTurns 会自己把这份
 * 坐标转成设备坐标。所以这里一旦按 orientation 自己判断横竖、把宽高对调，
 * 就会和底层重复旋转，横屏点位整体偏移。
 * 早期版本无条件转横屏、后来改成判断 orientation（值可能是 rot90/rot270，
 * 判断落空）都踩过这个坑。现在原样使用，任何方向都不需要自己换算。
 */
function screenOf(raw: {
  width: number;
  height: number;
  orientation: string;
}): ScreenSize {
  return { width: raw.width, height: raw.height };
}

/** 参考截图坐标 -> 当前屏幕坐标，并加上可配置的随机偏移 */
function pointOf(p: TapPoint, screen: ScreenSize, jitterPx: number): Point {
  const jitter = (jitterPx * screen.width) / REF_W;
  const angle = Math.random() * Math.PI * 2;
  const distance = jitter * Math.sqrt(Math.random());
  return [
    ((p.x + distance * Math.cos(angle)) * screen.width) / REF_W,
    ((p.y + distance * Math.sin(angle)) * screen.height) / REF_H,
  ];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runTaps(
  signal: AbortSignal,
  report: Report,
  target: string,
): Promise<void> {
  const settings = await readSettings();
  const active = settings.points.filter(
    (p) => p.enabled && p.x >= 0 && p.y >= 0,
  );
  report.points = active.length;
  if (active.length === 0) {
    report.stopReason = "没有已启用且已设置坐标的点位";
    return;
  }

  let screen: ScreenSize;
  try {
    const info = await device.info({ signal });
    report.screen = `${info.screen.width}×${info.screen.height} ${info.screen.orientation} scale=${info.screen.scale}`;
    screen = screenOf(info.screen);
  } catch (error) {
    report.lastError = `读取屏幕失败：${messageOf(error)}`;
    report.stopReason = "无法获取屏幕尺寸";
    return;
  }

  let failures = 0;
  let index = 0;
  while (!signal.aborted) {
    const front = await device.foregroundApplication
      .get({ signal })
      .catch(() => "");
    if (front !== "") {
      report.front = front;
      // 输入法残留仍占着前台身份时不要误判为「切走」
      if (!frontAllowsTapping(front, target)) {
        report.stopReason = `前台已切换为 ${front}`;
        return;
      }
    }

    const pointItem = active[index % active.length]!;
    const point = pointOf(pointItem, screen, settings.jitterPx);
    report.point = `${pointItem.name} (${Math.round(point[0])}, ${Math.round(point[1])})`;
    try {
      await input.tap(point, { signal });
      report.taps += 1;
      failures = 0;
      report.lastError = "";
    } catch (error) {
      if (signal.aborted) return;
      failures += 1;
      report.lastError = messageOf(error);
      if (failures >= MAX_FAILURES) {
        report.stopReason = `点击连续失败 ${MAX_FAILURES} 次`;
        return;
      }
    }
    index += 1;
    // 每个点位用自己的间隔；老数据没有该字段时兜底 1 秒
    await sleep(pointItem.intervalMs > 0 ? pointItem.intervalMs : 1000, signal);
  }
}

/**
 * 停止监控：并行监听应用事件、前台、锁屏、屏幕状态四路，任一命中立即 abort。
 * Swipt 源码 foreground.go 明确记录：下拉控制中心时游戏仍持有前台身份，
 * 应用事件与前台订阅都不会变化。code=12 曾尝试用无障碍快照检测系统面板，
 * 真机下拉控制中心仍不触发，已移除该路检测。控制中心不再作为停止方式，
 * 可靠的停止方式是切回 Swipt / 切到别的应用 / 锁屏。
 */
async function watchStop(
  signal: AbortSignal,
  stop: AbortController,
  graceUntil: number,
  report: Report,
  target: string,
): Promise<void> {
  const halt = (reason: string) => {
    if (stop.signal.aborted) return;
    report.stopReason = reason;
    stop.abort();
  };
  const ready = () => !signal.aborted && Date.now() >= graceUntil;

  const appEvents = (async () => {
    try {
      for await (const event of device.applicationEvents({ signal })) {
        if (!ready()) continue;
        if (event.type === "background" && event.bundleId === target) {
          halt("目标对象进入后台");
          return;
        }
        if (
          (event.type === "launch" || event.type === "foreground") &&
          event.bundleId !== target &&
          !isKeyboardFront(event.bundleId)
        ) {
          halt(`切换到 ${event.bundleId}`);
          return;
        }
      }
    } catch {
      // 信号取消 / 设备断开
    }
  })();

  const foreground = (async () => {
    try {
      for await (const front of device.foregroundApplication.values({ signal })) {
        if (!ready() || front === "") continue;
        report.front = front;
        if (!frontAllowsTapping(front, target)) {
          halt(`前台已切换为 ${front}`);
          return;
        }
      }
    } catch {
      // 信号取消 / 设备断开
    }
  })();

  const lockState = (async () => {
    try {
      for await (const isLocked of device.locked.values({ signal })) {
        if (!ready()) continue;
        if (isLocked) {
          halt("设备已锁屏");
          return;
        }
      }
    } catch {
      // 信号取消 / 设备断开
    }
  })();

  const display = (async () => {
    try {
      for await (const state of device.displayState.values({ signal })) {
        if (!ready()) continue;
        // dimmed 只是自动亮度变暗，游戏仍在正常显示，不当作离开
        if (state === "off" || state === "inactiveOn") {
          halt(`屏幕状态变为 ${state}`);
          return;
        }
      }
    } catch {
      // 信号取消 / 设备断开
    }
  })();

  await Promise.all([appEvents, foreground, lockState, display]);
}

// ---------------------------------------------------------------------------
// 快捷指令 / App Intents 的调用必须「尽快返回」。
// 官方 RunSwipletActionIntent.perform() 会 await 动作返回值，iOS 对 App Intent
// 有执行时限；无限循环的连点动作必然 timeout，信号一被取消连点就停。
// 所以从 shortcuts 调用时，Action 只做跳转 + 写一个启动命令就返回，
// 真正的循环交给常驻服务 run()（用的是服务的 signal，不受本次调用影响）。
// Action 与常驻服务是两个独立 JS 引擎，内存不共享，靠 dataDirectory 文件通信。
// ---------------------------------------------------------------------------
const COMMAND_FILE = "shortcut-start.json";

interface StartCommand {
  readonly seq: number;
  readonly target: string;
  /** 运行等待时间（毫秒）：等待放在常驻服务里，动作才能立刻返回 */
  readonly delayMs: number;
}

const commandFile = () => dataDirectory.file(COMMAND_FILE);

async function postStartCommand(target: string, delayMs: number): Promise<void> {
  try {
    if (!(await dataDirectory.exists())) await dataDirectory.create();
  } catch {
    // 已存在
  }
  await commandFile().write(
    JSON.stringify({ seq: Date.now(), target, delayMs }),
  );
}

/** 读一次命令就删除，避免服务重启后把旧命令又跑一遍 */
async function takeStartCommand(): Promise<StartCommand | null> {
  try {
    // 轮询很频繁，先用 stat 判存在，别每 250ms 抛一次「文件不存在」
    if ((await commandFile().stat()) === null) return null;
    const raw = JSON.parse(await commandFile().text()) as Partial<StartCommand>;
    if (typeof raw.seq !== "number" || typeof raw.target !== "string") {
      // 命令内容损坏就丢掉，别让轮询一直卡在同一个文件上
      await commandFile().delete().catch(() => {});
      return null;
    }
    await commandFile().delete().catch(() => {});
    return {
      seq: raw.seq,
      target: raw.target,
      // 兼容旧命令 / 脏数据：没有 delayMs 时按默认 3 秒处理
      delayMs: clampLaunchDelay(Number(raw.delayMs)),
    };
  } catch {
    return null;
  }
}

/**
 * 常驻服务接到命令后跑连点循环。跳转已由 Action 完成，这里先等前台稳定：
 * 动作返回后 iOS 可能把 Swipt 短暂拉回前台，直接开跑会被自动停止逻辑误判。
 */
async function runServiceLoop(
  signal: AbortSignal,
  target: string,
  delayMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < 10 && !signal.aborted; attempt += 1) {
    const front = await device.foregroundApplication
      .get({ signal })
      .catch(() => "");
    if (front === target || front === "" || isKeyboardFront(front)) break;
    await sleep(300, signal);
  }
  if (signal.aborted) return;

  // 「运行等待时间」放在常驻服务里等：Action 已经返回，等再久也不会让
  // App Intent timeout。设置页路径则直接在 Action 里等，两条路径行为一致。
  await sleep(delayMs, signal);
  if (signal.aborted) return;

  const stop = new AbortController();
  const loopSignal = AbortSignal.any([signal, stop.signal]);
  const report: Report = {
    taps: 0,
    points: 0,
    screen: "",
    point: "",
    front: "",
    stopReason: "已停止",
    lastError: "",
    caller: "service",
  };
  const watcher = watchStop(
    loopSignal,
    stop,
    Date.now() + GRACE_MS,
    report,
    target,
  );
  await runTaps(loopSignal, report, target);
  stop.abort();
  await watcher.catch(() => {});
}

export default defineExtension({
  // 常驻服务由 Swipt 自动托管；界面不再显示后台服务开关。
  async run({ signal }) {
    // 轮询快捷指令下发的启动命令。命令触发的连点循环用的是本服务的 signal，
    // 因此不会随 App Intent 超时一起被取消。
    while (!signal.aborted) {
      const command = await takeStartCommand();
      if (command !== null) {
        await runServiceLoop(signal, command.target, command.delayMs);
        // 丢掉循环期间堆积的命令，避免结束后又自动重跑一次
        await commandFile().delete().catch(() => {});
      }
      await sleep(250, signal);
    }
  },

  actions: {
    start: defineAction({
      title: "开始连点",
      description:
        "跳转到勾选的目标对象并按已启用点位的顺序循环点击；切换应用或锁屏自动停止",
      // 注册到 iOS 快捷指令 / App Intents，可在桌面一键启动
      expose: ["shortcuts"],
      async run(_, { signal, caller }) {
        const settings = await readSettings();
        const target = targetBundle(settings);
        // 设置页里可以自定义；老存档 sanitize 后自动回落到 3000
        const delayMs = clampLaunchDelay(settings.launchDelayMs);
        const report: Report = {
          taps: 0,
          points: 0,
          screen: "",
          point: "",
          front: "",
          stopReason: "已停止",
          lastError: "",
          caller,
        };
        const stop = new AbortController();
        const loopSignal = AbortSignal.any([signal, stop.signal]);
        try {
          await device.launchApplication(target, { signal });
        } catch (error) {
          // 官方 Launch 自带 3.5s 前台校验；快捷指令里输入法残留会误报失败，
          // 但错误信息会写明目标 "launched"。自行确认前台后再决定是否放弃。
          const message = messageOf(error);
          if (!(await confirmLaunched(loopSignal, target, report))) {
            report.lastError = `跳转失败：${message}`;
            if (report.stopReason === "已停止") {
              report.stopReason = `未能切换到 ${target}`;
            }
            return report;
          }
          // 已确认可以继续，别把误报留在返回值里干扰快捷指令的输出
          report.lastError = "";
        }
        // 设置页调用：按「运行等待时间」等一会儿再开跑。
        // 快捷指令路径不在这里等，改由常驻服务拿到命令后等待，
        // 否则动作迟迟不返回会被 iOS App Intent 判定 timeout。
        if (caller !== "shortcuts") {
          await sleep(delayMs, loopSignal);
        }
        report.front =
          (await device.foregroundApplication
            .get({ signal })
            .catch(() => "")) || "(读取失败)";

        if (caller === "shortcuts") {
          // App Intent 必须尽快返回，否则 iOS 会 timeout 并取消这次调用。
          // 跳转已经完成，把连点循环交给常驻服务 run()，动作立即返回。
          await postStartCommand(target, delayMs);
          // 稍等一下看命令是否被服务取走：没取走通常是插件常驻服务没开启
          await sleep(700, loopSignal);
          const pending = await commandFile().stat().catch(() => null);
          report.stopReason =
            pending === null
              ? "已交给常驻服务连点（快捷指令无需等待）"
              : "启动命令未被取走：请检查 Swipt 里本插件的常驻服务是否开启";
          return report;
        }

        const watcher = watchStop(
          loopSignal,
          stop,
          Date.now() + GRACE_MS,
          report,
          target,
        );
        await runTaps(loopSignal, report, target);
        stop.abort();
        await watcher.catch(() => {});
        if (signal.aborted) report.stopReason = "已被系统终止";
        return report;
      },
    }),

    /** 坐标记录：抓一张目标对象当前画面，回到设置页后在图上点选位置 */
    record: defineAction({
      title: "坐标记录",
      description:
        "跳转到勾选的目标对象并抓取当前画面，返回设置页后点图记录坐标",
      async run(_, { signal }) {
        const target = targetBundle(await readSettings());
        await device.launchApplication(target, { signal });
        await sleep(RECORD_DELAY_MS, signal);
        const shot = await device.screenshot({ signal });
        // 保持截图原始方向，宽高用真实像素值记录。
        // 点选时按原图归一化后直接映射到参考坐标（x = nx·REF_W，y = ny·REF_H），
        // 不做任何旋转换算；显示方向由设置页负责（横屏图也会转成竖屏显示），
        // 这样记录坐标与真机点击位置永远一致。
        const image = shot;
        const width = shot.width;
        const height = shot.height;
        try {
          if (!(await dataDirectory.exists())) await dataDirectory.create();
        } catch {
          // 已存在
        }
        // 先销毁旧截图与旧记录，再写新图：磁盘上永远只剩当前这一张
        await clearRecording();
        const time = Date.now();
        const imageName = recordImageName(time);
        await image.save(recordImageFile(imageName), {
          signal,
          format: "png",
        });
        await writeRecording({
          width,
          height,
          time,
          image: imageName,
          x: -1,
          y: -1,
        });
        // 回到 Swipt 设置页；失败也不影响，用户手动切回来一样能看到图
        await device
          .launchApplication(SWIPT_BUNDLE_ID, { signal })
          .catch(() => {});
        return { width, height };
      },
    }),

    /** 读取设备已安装应用及其图标，供设置页选择目标对象 */
    listApps: defineAction({
      title: "读取已安装应用",
      description: "列出设备上已安装的应用与图标，供设置页选择目标对象",
      async run(_, { signal }) {
        const apps = await device.installedApplications({ signal });
        // 与官方「跳过广告」插件一致：图标是 cacheDirectory 里的 PNG，
        // 把 file:// uri 交给设置页的 SwiftUI Image 显示。
        const list = await Promise.all(
          apps.map(async (app) => {
            let icon = "";
            try {
              icon = (await device.applicationIcon(app.bundleId, { signal })).uri;
            } catch {
              // 个别应用没有图标：留空，列表里只显示名称
            }
            return {
              bundleId: app.bundleId,
              name: app.name || app.bundleId,
              icon,
            };
          }),
        );
        list.sort((a, b) => a.name.localeCompare(b.name));
        return list;
      },
    }),
  },
});
