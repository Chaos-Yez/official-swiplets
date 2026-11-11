// 洛克王国 · 自动投掷 (Swiplet)
// ---------------------------------------------------------------------------
// 一键流程：跳转 com.tencent.nrc → 等切换动画结束 → 每秒点击一次右下角
// 「投掷」按钮（带细微随机偏移，避开相邻按钮）。
// 停止：切换应用、游戏进入后台、拉下控制中心 / 通知中心、回到主屏。
//
// 【架构要点，别再改回去】
// Swipt 的 internal/automation/engine.go: Host.execute() 每次调用 Action 都会
// newEngine() 并 defer e.close()；Action 的 run() 一返回，这个 JS 引擎立即销毁。
// 因此连点循环必须 **await 在 Action 的 run() 里**，不能 fire-and-forget 起个
// 后台 Promise 就返回。另外 run() 常驻服务与 Action 是两个独立引擎，模块级
// 变量不共享，停止判定也必须放在同一个 Action 内。
//
// API 依据（swipt/api/*.d.ts、internal/automation/ops.go、internal/device/screen.go）：
//   device.launchApplication(bundleId, { signal }): Promise<void>
//   device.foregroundApplication.get({ signal }): Promise<string>
//   device.applicationEvents({ signal }): AsyncIterable<ApplicationStateEvent>
//   device.info({signal}).screen = { width, height, scale, orientation }
//   input.tap(point, { signal })；input.tap 与 device.info().screen 同坐标系
//   （ops.go deviceTap → TapPoint → touchPoint 用 screenGeometry 归一化）
// ---------------------------------------------------------------------------

import type { Point } from "@swipt/api";
import * as device from "@swipt/api/device";
import * as input from "@swipt/api/input";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

// ============ 只需改这里 ============
/** 洛克王国的 bundle id */
const GAME_BUNDLE_ID = "com.tencent.nrc";
/** 参考截图分辨率（横屏游戏截图） */
const REF_W = 2217;
const REF_H = 1024;
/** 截图里「投掷」按钮圆心（白色手掌 + 星形的大圆） */
const TARGET_REF: Point = [1760, 780];
/** 目标按钮半径约 94px；点击点限制在此半径内 */
const SAFE_RADIUS_PX = 40;
/** 每次点击的随机偏移半径（截图像素，约 ±10px） */
const JITTER_PX = 10;
/** 点击间隔（毫秒） */
const INTERVAL_MS = 1000;
/** 跳转后等待切换动画结束（毫秒）；不再靠轮询前台判定是否启动 */
const LAUNCH_SETTLE_MS = 1200;
/** 启动后的事件宽限期，避免切换动画里的系统 UI 事件误停 */
const GRACE_MS = 800;
/** 连续点击失败多少次后退出（避免「显示运行中但其实一次没点」） */
const MAX_FAILURES = 3;

/** 相邻按钮禁区（截图坐标，半径已加 8px 缓冲） */
const NEIGHBORS_REF: { center: Point; radius: number }[] = [
  { center: [1685, 710], radius: 33 + 8 }, // 左上：紫色投掷球切换
  { center: [1927, 674], radius: 68 + 8 }, // 右上：跳跃
  { center: [1924, 880], radius: 68 + 8 }, // 右下：翻滚 / 冲刺
];
// ====================================

interface ScreenSize {
  readonly width: number;
  readonly height: number;
}
interface DeviceScreen extends ScreenSize {
  readonly scale: number;
  readonly orientation: string;
}

/** 一次连点的运行结果，返回给界面显示 */
interface Report {
  taps: number;
  screen: string;
  point: string;
  front: string;
  stopReason: string;
  lastError: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把设备报告的屏幕尺寸校正成「横屏宽 > 高」的坐标系。
 * 少数固件在 landscape 下仍返回竖屏的 width/height，此时必须交换。
 */
function orientScreen(raw: DeviceScreen): ScreenSize {
  if (raw.width < raw.height) {
    return { width: raw.height, height: raw.width };
  }
  return { width: raw.width, height: raw.height };
}

/** 截图坐标 -> 当前屏幕坐标 */
function px([x, y]: Point, screen: ScreenSize): Point {
  return [(x * screen.width) / REF_W, (y * screen.height) / REF_H];
}
function scale(value: number, screen: ScreenSize): number {
  return (value * screen.width) / REF_W;
}

/** 可中断的 sleep */
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

/** 在目标按钮安全区内取一个随机点击点，落入相邻按钮禁区则重采样 */
function pickPoint(screen: ScreenSize): Point {
  const [cx, cy] = px(TARGET_REF, screen);
  const jitter = scale(JITTER_PX, screen);
  const safe = scale(SAFE_RADIUS_PX, screen);
  const forbidden: [number, number, number][] = NEIGHBORS_REF.map((n) => {
    const [nx, ny] = px(n.center, screen);
    return [nx, ny, scale(n.radius, screen)];
  });

  for (let i = 0; i < 24; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = jitter * Math.sqrt(Math.random());
    const point: Point = [
      cx + distance * Math.cos(angle),
      cy + distance * Math.sin(angle),
    ];
    if (Math.hypot(point[0] - cx, point[1] - cy) > safe) continue;
    const hitsNeighbor = forbidden.some(
      ([nx, ny, r]) => Math.hypot(point[0] - nx!, point[1] - ny!) < r!,
    );
    if (hitsNeighbor) continue;
    return point;
  }
  return [cx, cy];
}

/** 连点主循环：全程 await，直到停止条件满足 */
async function runTaps(signal: AbortSignal, report: Report): Promise<void> {
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
  while (!signal.aborted) {
    // 每次点击前确认前台。读取失败 / 空值不误停，由事件监听兜底。
    const front = await device.foregroundApplication
      .get({ signal })
      .catch(() => "");
    if (front !== "") {
      report.front = front;
      if (front !== GAME_BUNDLE_ID) {
        report.stopReason = `前台已切换为 ${front}`;
        return;
      }
    }

    const point = pickPoint(screen);
    report.point = `${Math.round(point[0])}, ${Math.round(point[1])}`;
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
    await sleep(INTERVAL_MS, signal);
  }
}

/** 前台变化即停止：切应用、回主屏、控制中心 / 通知中心、游戏进后台 */
async function watchApps(
  signal: AbortSignal,
  stop: AbortController,
  graceUntil: number,
  report: Report,
): Promise<void> {
  try {
    for await (const event of device.applicationEvents({ signal })) {
      if (signal.aborted || Date.now() < graceUntil) continue;
      if (event.type === "background" && event.bundleId === GAME_BUNDLE_ID) {
        report.stopReason = "游戏进入后台";
        stop.abort();
        return;
      }
      if (
        (event.type === "launch" || event.type === "foreground") &&
        event.bundleId !== GAME_BUNDLE_ID
      ) {
        report.stopReason = `切换到 ${event.bundleId}`;
        stop.abort();
        return;
      }
    }
  } catch {
    // 信号取消 / 设备断开时忽略
  }
}

export default defineExtension({
  // 常驻服务由 Swipt 自动托管，界面用 useService 显示它的状态。
  // 连点逻辑不放在这里：服务与 Action 是两个独立 JS 引擎，不共享内存。
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
        "跳转到洛克王国并开始每秒点击一次投掷按钮；切换应用或拉下控制中心自动停止",
      expose: ["shortcuts"],
      async run(_, { signal }) {
        const report: Report = {
          taps: 0,
          screen: "",
          point: "",
          front: "",
          stopReason: "已停止",
          lastError: "",
        };
        const stop = new AbortController();
        const loopSignal = AbortSignal.any([signal, stop.signal]);

        try {
          await device.launchApplication(GAME_BUNDLE_ID, { signal });
        } catch (error) {
          report.lastError = `跳转失败：${messageOf(error)}`;
          report.stopReason = "未能切换到游戏";
          return report;
        }

        // 只等动画，不再用 foregroundApplication 的精确匹配当启动门槛：
        // 该值可能因机型/固件返回不同格式，一旦不匹配就会一次都不点。
        await sleep(LAUNCH_SETTLE_MS, loopSignal);
        report.front =
          (await device.foregroundApplication
            .get({ signal })
            .catch(() => "")) || "(读取失败)";

        const watcher = watchApps(
          loopSignal,
          stop,
          Date.now() + GRACE_MS,
          report,
        );
        await runTaps(loopSignal, report);
        stop.abort();
        await watcher.catch(() => {});
        if (signal.aborted) report.stopReason = "已被系统终止";
        return report;
      },
    }),
  },
});
