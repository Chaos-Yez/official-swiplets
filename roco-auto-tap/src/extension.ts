// 洛克王国 · 自动投掷 (Swiplet)
// ---------------------------------------------------------------------------
// 一键流程：跳转 com.tencent.nrc → 等游戏进入前台 → 立即每秒点击一次右下角
// 「投掷」按钮（带细微随机偏移，避开相邻按钮）。
// 停止：切换应用、拉下控制中心 / 通知中心、回到主屏等任何前台变化都会停止，
//       不再提供停止 / 切换 / 测试 / 状态等 Action 和 UI 条目。
//
// API 依据（swipt/api/*.d.ts 与 internal/device/foreground.go 逐字核对）：
//   device.launchApplication(bundleId, { signal, url?, restart? }): Promise<void>
//   device.foregroundApplication.get({ signal }): Promise<string>
//   device.applicationEvents({ signal }): AsyncIterable<{type:"launch"|"foreground"|"background", bundleId, ...}>
//   device.info({signal}).screen = { width, height, scale, orientation }
//   input.tap(point, { signal })
//   Swipt 底层用 com.apple.mobile.SubstantialTransition 判定前台变化，
//   源码注释明确包含「to and from the home screen, Notification Center and
//   the app switcher」——控制中心属于同类 SpringBoard 覆盖层。
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
/** 间隔随机抖动 ±ms。0 = 严格 1 秒 */
const INTERVAL_JITTER_MS = 0;
/** 跳转后等待游戏进入前台的最长时间 */
const LAUNCH_TIMEOUT_MS = 4000;
/** 启动后的事件宽限期，避免切换动画里的系统 UI 事件误停 */
const START_GRACE_MS = 500;

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

let loop: AbortController | null = null;
let graceUntil = 0;

/**
 * 把设备报告的屏幕尺寸校正成「横屏宽 > 高」的坐标系。
 * 少数固件在 landscape 下仍返回竖屏的 width/height，此时必须交换。
 */
function orientScreen(raw: DeviceScreen): ScreenSize {
  if (raw.orientation === "landscape" && raw.width < raw.height) {
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

/** 跳转后轮询前台，确认游戏真的显示出来了再开始点击 */
async function waitForGame(signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    const front = await device.foregroundApplication
      .get({ signal })
      .catch(() => "");
    if (front === GAME_BUNDLE_ID) return true;
    await sleep(100, signal);
  }
  return false;
}

function stopLoop(): void {
  if (loop === null) return;
  loop.abort();
  loop = null;
}

async function runLoop(signal: AbortSignal): Promise<void> {
  const info = await device.info({ signal });
  const screen = orientScreen(info.screen);
  while (!signal.aborted) {
    // 每次点击前再确认一次前台：切应用 / 系统覆盖层都会让这里不成立。
    // 读取失败时不误停（视为仍在游戏），由事件监听兜底。
    const front = await device.foregroundApplication
      .get({ signal })
      .catch(() => GAME_BUNDLE_ID);
    if (front !== GAME_BUNDLE_ID) break;
    try {
      await input.tap(pickPoint(screen), { signal });
    } catch (error) {
      if (signal.aborted) break;
    }
    const jitter =
      INTERVAL_JITTER_MS === 0
        ? 0
        : (Math.random() * 2 - 1) * INTERVAL_JITTER_MS;
    await sleep(Math.max(50, INTERVAL_MS + jitter), signal);
  }
}

function startLoop(): void {
  stopLoop(); // 重复触发不会叠加循环
  const controller = new AbortController();
  loop = controller;
  graceUntil = Date.now() + START_GRACE_MS;
  runLoop(controller.signal)
    .catch(() => {})
    .finally(() => {
      if (loop === controller) loop = null;
    });
}

/** 前台变化即停止：切应用、回主屏、控制中心 / 通知中心、App 切换器 */
async function watchApps(signal: AbortSignal): Promise<void> {
  try {
    for await (const event of device.applicationEvents({ signal })) {
      if (loop === null || Date.now() < graceUntil) continue;
      if (
        (event.type === "launch" && event.bundleId !== GAME_BUNDLE_ID) ||
        (event.type === "foreground" && event.bundleId !== GAME_BUNDLE_ID) ||
        (event.type === "background" && event.bundleId === GAME_BUNDLE_ID)
      ) {
        stopLoop();
      }
    }
  } catch {
    // 服务退出 / 设备断开时忽略
  }
}

export default defineExtension({
  // Swipt 自身托管服务生命周期，UI 不需要也不提供后台服务开关。
  async run({ signal }) {
    watchApps(signal).catch(() => {});
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
        await device.launchApplication(GAME_BUNDLE_ID, { signal });
        if (!(await waitForGame(signal))) {
          throw new Error(`未能切换到 ${GAME_BUNDLE_ID}`);
        }
        startLoop();
        return { started: true };
      },
    }),
  },
});
