// 洛克王国 · 自动投掷 (Swiplet)
// ---------------------------------------------------------------------------
// 启动后每 1 秒点击一次右下角「投掷」按钮，点击点带细微随机偏移，并避开相邻按钮。
//
// 触发：Swipt 内插件页的「开始 / 停止」按钮，或 iOS 快捷指令 / 轻点背面。
//       安装后不会自动开始，必须手动调用一次 start / toggle。
//
// API 依据（官方 api/*.d.ts 与 official-swiplets 源码逐字核对）：
//   defineAction({ title, expose?, run }) —— expose 默认空，要出现在快捷指令
//     必须显式写 expose: ["shortcuts"]
//   input.tap(point, { signal }) / device.info({signal}).screen
//   device.info().screen = { width, height, scale, orientation }
// ---------------------------------------------------------------------------

import type { Point } from "@swipt/api";
import * as device from "@swipt/api/device";
import * as input from "@swipt/api/input";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

// ============ 只需改这里 ============
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
/** 间隔随机抖动 ±ms。0 = 严格 1 秒；建议 60~120 更像人手、也更不易被识别 */
const INTERVAL_JITTER_MS = 0;

/** 相邻按钮禁区（截图坐标，半径已加 8px 缓冲） */
const NEIGHBORS_REF: { center: Point; radius: number }[] = [
  { center: [1685, 710], radius: 33 + 8 }, // 左上：紫色投掷球切换
  { center: [1927, 674], radius: 68 + 8 }, // 右上：跳跃
  { center: [1924, 880], radius: 68 + 8 }, // 右下：翻滚 / 冲刺
];

/**
 * 是否只在「游戏」前台时点击。
 * 默认 false —— 因为如果在 Swipt 内点「开始」，此刻的前台是 Swipt 自己，
 * 会被误记成游戏；切回真游戏后守卫一直判定「不在游戏」而永久暂停。
 * 想启用守卫：把 GAME_BUNDLE_ID 填成洛克王国的 bundle id，再把这里改成 true。
 */
const ONLY_WHEN_GAME_FOREGROUND = false;
/** 洛克王国的 bundle id（留空 = 取启动瞬间的前台应用） */
const GAME_BUNDLE_ID = "";
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
let watcher: AbortController | null = null;
let foregroundApp = "";
let gameApp = "";
let tapCount = 0;
let lastError = "";
let currentScreen: DeviceScreen | null = null;
let lastPoint: Point | null = null;
let deviceReady = false;

/**
 * 把设备报告的屏幕尺寸校正成「横屏宽 > 高」的坐标系。
 * 少数固件在 landscape 下仍返回竖屏的 width/height，此时必须交换，
 * 否则归一化后的点击点会整套落在屏幕左上角之外。
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
      ([nx, ny, r]) => Math.hypot(point[0] - nx, point[1] - ny) < r,
    );
    if (hitsNeighbor) continue;
    return point;
  }
  return [cx, cy];
}

/** 监听前后台切换（只在显式启用守卫时才影响点击） */
function ensureWatcher(): void {
  if (watcher !== null) return;
  const controller = new AbortController();
  watcher = controller;
  const { signal } = controller;
  (async () => {
    try {
      for await (const event of device.applicationEvents({ signal })) {
        if (event.type === "foreground") foregroundApp = event.bundleId;
        else if (event.type === "background" && foregroundApp === event.bundleId)
          foregroundApp = "";
      }
    } catch (error) {
      if (!signal.aborted) lastError = String(error);
    }
  })().catch(() => {});
}

async function readScreen(signal: AbortSignal): Promise<ScreenSize> {
  const info = await device.info({ signal });
  currentScreen = info.screen;
  deviceReady = true;
  return orientScreen(info.screen);
}

async function runLoop(signal: AbortSignal): Promise<void> {
  const screen = await readScreen(signal);
  while (!signal.aborted) {
    if (
      ONLY_WHEN_GAME_FOREGROUND &&
      gameApp !== "" &&
      foregroundApp !== gameApp
    ) {
      await sleep(200, signal);
      continue;
    }
    try {
      const point = pickPoint(screen);
      lastPoint = point;
      await input.tap(point, { signal });
      tapCount++;
      lastError = "";
    } catch (error) {
      if (signal.aborted) break;
      lastError = String(error);
    }
    const jitter =
      INTERVAL_JITTER_MS === 0
        ? 0
        : (Math.random() * 2 - 1) * INTERVAL_JITTER_MS;
    await sleep(Math.max(50, INTERVAL_MS + jitter), signal);
  }
}

function startLoop(): boolean {
  if (loop !== null) return false;
  ensureWatcher();
  lastError = "";
  gameApp = GAME_BUNDLE_ID || foregroundApp;
  const controller = new AbortController();
  loop = controller;
  runLoop(controller.signal)
    .catch((error) => {
      lastError = String(error);
    })
    .finally(() => {
      if (loop === controller) loop = null;
    });
  return true;
}

function stopLoop(): boolean {
  if (loop === null) return false;
  loop.abort();
  loop = null;
  return true;
}

function snapshot() {
  return {
    running: loop !== null,
    taps: tapCount,
    intervalMs: INTERVAL_MS,
    jitterPx: JITTER_PX,
    target: TARGET_REF,
    gameApp,
    foregroundApp,
    guarded: ONLY_WHEN_GAME_FOREGROUND && gameApp !== "",
    deviceReady,
    screen: currentScreen,
    point: lastPoint,
    error: lastError,
  };
}

export default defineExtension({
  // 服务保持存活，供 Swipt 把 Action 暴露给快捷指令与后台运行
  async run({ signal }) {
    ensureWatcher();
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  },

  actions: {
    start: defineAction({
      title: "开始自动投掷",
      description: "每秒点击一次投掷按钮，带随机偏移并避开相邻按钮",
      expose: ["shortcuts"],
      async run() {
        startLoop();
        return snapshot();
      },
    }),

    stop: defineAction({
      title: "停止自动投掷",
      expose: ["shortcuts"],
      async run() {
        stopLoop();
        return snapshot();
      },
    }),

    toggle: defineAction({
      title: "切换自动投掷",
      expose: ["shortcuts"],
      async run() {
        if (loop === null) startLoop();
        else stopLoop();
        return snapshot();
      },
    }),

    /** 只点一次，用来确认坐标 / 点击权限是否正常 */
    tapOnce: defineAction({
      title: "测试点击一次",
      expose: ["shortcuts"],
      async run(_, { signal }) {
        const screen = await readScreen(signal);
        const point = pickPoint(screen);
        lastPoint = point;
        await input.tap(point, { signal });
        tapCount++;
        lastError = "";
        return snapshot();
      },
    }),

    status: defineAction({
      title: "自动投掷状态",
      expose: ["shortcuts"],
      async run() {
        return snapshot();
      },
    }),
  },
});
