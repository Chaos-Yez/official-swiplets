// 连点器 (Swiplet)
// ---------------------------------------------------------------------------
// start    : 跳转到「勾选的目标对象」→ 按已启用点位的顺序循环点击，间隔可配置。
// record   : 跳转同一个目标对象 → 抓一张当前画面 → 回到 Swipt 供点选记录坐标。
//            抓图前先销毁上一张，过期截图由设置页 / readRecording 自动清理。
// listApps : 读取设备已安装应用，供设置页维护跳转白名单。
// 自动停止由 watchStop() 四路并行监控：应用事件 / 前台 / 锁屏 / 屏幕状态，
// 任一命中立刻 abort 连点循环。
// 注意：iOS 下拉控制中心不改变前台身份，也没有可靠事件，故不再尝试检测；
// 要停止请切回 Swipt / 切到别的应用 / 锁屏。
//
// 【架构要点，别再改回去】
// internal/automation/engine.go: Host.execute() 每次执行 Action 都会 newEngine()
// 并 defer e.close()。Action 的 run() 一返回，整个 JS 引擎立即销毁。所以连点
// 循环必须 await 在 Action 内，不能 fire-and-forget。run() 常驻服务与 Action
// 是两个独立引擎，内存不共享；配置与坐标通过 dataDirectory 里的文件传递。
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
/** 跳转后等待切换动画并给用户准备时间 */
const LAUNCH_SETTLE_MS = 3000;
/** 坐标记录：跳到游戏后留给用户切到目标画面的时间 */
const RECORD_DELAY_MS = 3000;
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orientScreen(raw: {
  width: number;
  height: number;
  orientation: string;
}): ScreenSize {
  return raw.width < raw.height
    ? { width: raw.height, height: raw.width }
    : { width: raw.width, height: raw.height };
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
    screen = orientScreen(info.screen);
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
      if (front !== target) {
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
    await sleep(settings.intervalMs, signal);
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
          event.bundleId !== target
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
        if (front !== target) {
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

export default defineExtension({
  // 常驻服务由 Swipt 自动托管；界面不再显示后台服务开关。
  async run({ signal }) {
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  },

  actions: {
    start: defineAction({
      title: "开始自动投掷",
      description:
        "跳转到勾选的目标对象并按已启用点位的顺序循环点击；切换应用或锁屏自动停止",
      // 不写 expose：不再注册到 iOS 快捷指令 / 轻点背面，只从插件设置页触发
      async run(_, { signal }) {
        const target = targetBundle(await readSettings());
        const report: Report = {
          taps: 0,
          points: 0,
          screen: "",
          point: "",
          front: "",
          stopReason: "已停止",
          lastError: "",
        };
        const stop = new AbortController();
        const loopSignal = AbortSignal.any([signal, stop.signal]);
        try {
          await device.launchApplication(target, { signal });
        } catch (error) {
          report.lastError = `跳转失败：${messageOf(error)}`;
          report.stopReason = `未能切换到 ${target}`;
          return report;
        }
        await sleep(LAUNCH_SETTLE_MS, loopSignal);
        report.front =
          (await device.foregroundApplication
            .get({ signal })
            .catch(() => "")) || "(读取失败)";
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
        // 保持截图原始方向：横屏截图横屏显示，竖屏截图竖屏显示。
        // 记录页点选时按原图宽高归一化，竖屏再顺时针 90° 映射回横屏参考坐标，
        // 因此显示方向与点位坐标都和真机画面一致。
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
