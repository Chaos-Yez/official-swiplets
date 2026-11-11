// 洛克王国 · 自动投掷 (Swiplet)
// ---------------------------------------------------------------------------
// 作用：启动后每 1 秒点击一次右下角「投掷」按钮，点击点带细微随机偏移，
//       且强制避开相邻按钮，不会误触。
//
// 开关方式：本插件暴露 4 个 Action —— start / stop / toggle / status，
//   可由 iOS 快捷指令、Swipt CLI、MCP 或 Swipt 内界面调用。
//   注意：iOS 第三方应用无法监听音量键，触发方式请见文件末尾注释。
//
// API 依据：官方 swipt-automation/official-swiplets 的 skip-chinese-ads/src/extension.ts
//   input.tap(point, { signal }) / device.info() / device.applicationEvents()
//   defineAction() / defineExtension()
// ---------------------------------------------------------------------------

import type { Point } from "@swipt/api";
import * as device from "@swipt/api/device";
import * as input from "@swipt/api/input";
import { defineAction, defineExtension } from "@swipt/api/swiplet";

// ============ 只需改这里 ============
/** 参考截图分辨率（用户提供的横屏游戏截图） */
const REF_W = 2217;
const REF_H = 1024;

/** 截图里「投掷」按钮的圆心（像素）。大圆：白色手掌 + 星形图标 */
const TARGET_REF: Point = [1760, 780];
/** 目标按钮半径约 94px；点击点被限制在此半径内，留了很大余量 */
const SAFE_RADIUS_PX = 40;

/** 每次点击的随机偏移半径（截图像素，约 ±10px，肉眼可见但不越界） */
const JITTER_PX = 10;
/** 点击间隔（毫秒） */
const INTERVAL_MS = 1000;
/** 间隔随机抖动 ±ms。设 0 = 严格 1 秒；设 60~120 更自然，也更不容易被识别为脚本 */
const INTERVAL_JITTER_MS = 0;

/** 相邻按钮禁区（截图坐标，半径已额外加 8px 缓冲） */
const NEIGHBORS_REF: { center: Point; radius: number }[] = [
  { center: [1685, 710], radius: 33 + 8 }, // 左上：紫色投掷球切换
  { center: [1927, 674], radius: 68 + 8 }, // 右上：跳跃
  { center: [1924, 880], radius: 68 + 8 }, // 右下：翻滚 / 冲刺
];

/** 只在游戏处于前台时点击；切出去自动暂停（不会点到别的应用） */
const ONLY_WHEN_GAME_FOREGROUND = true;
/** 可选：直接填游戏 bundle id。留空则取「启动瞬间的前台应用」 */
const GAME_BUNDLE_ID = "";
// ====================================

interface ScreenSize {
  readonly width: number;
  readonly height: number;
}

let loop: AbortController | null = null;
let watcher: AbortController | null = null;
let foregroundApp = "";
let gameApp = "";
let tapCount = 0;
let lastError = "";

/** 截图坐标 -> 当前屏幕坐标（pt）。用归一化换算，适配不同机型分辨率 */
function px([x, y]: Point, screen: ScreenSize): Point {
  return [(x * screen.width) / REF_W, (y * screen.height) / REF_H];
}
function scale(value: number, screen: ScreenSize): number {
  return (value * screen.width) / REF_W;
}

/** 可中断的 sleep：abort 时立刻 resolve，让循环自然退出 */
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

/** 在目标按钮安全区内取一个随机点击点，落入任一相邻按钮禁区则重采样 */
function pickPoint(screen: ScreenSize): Point {
  const [cx, cy] = px(TARGET_REF, screen);
  const jitter = scale(JITTER_PX, screen);
  const safe = scale(SAFE_RADIUS_PX, screen);
  const forbidden: [number, number, number][] = NEIGHBORS_REF.map((n) => {
    const [nx, ny] = px(n.center, screen);
    return [nx, ny, scale(n.radius, screen)];
  });

  for (let i = 0; i < 24; i++) {
    // sqrt 保证在圆盘内均匀分布，而不是往圆心挤
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
  // 兜底：永远返回圆心（实测圆心到最近相邻按钮边缘还有 70px，绝对安全）
  return [cx, cy];
}

/** 监听前后台切换，供 ONLY_WHEN_GAME_FOREGROUND 判断 */
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

async function runLoop(signal: AbortSignal): Promise<void> {
  const { screen } = await device.info({ signal });
  while (!signal.aborted) {
    // 切出游戏时暂停，不退出循环
    if (
      ONLY_WHEN_GAME_FOREGROUND &&
      gameApp !== "" &&
      foregroundApp !== gameApp
    ) {
      await sleep(200, signal);
      continue;
    }
    try {
      await input.tap(pickPoint(screen), { signal });
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
  if (loop !== null) return false; // 已在运行，忽略重复启动
  ensureWatcher();
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
    guarded: gameApp !== "",
    error: lastError,
  };
}

export default defineExtension({
  // 服务本体只负责前台监听；连点由 Action 显式启动/停止
  async run({ signal }) {
    ensureWatcher();
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  },

  actions: {
    /** 启动连点。重复调用不会叠加第二个循环 */
    start: defineAction({
      title: "开始自动投掷",
      async run() {
        startLoop();
        return snapshot();
      },
    }),

    /** 停止连点 */
    stop: defineAction({
      title: "停止自动投掷",
      async run() {
        stopLoop();
        return snapshot();
      },
    }),

    /** 一个 Action 搞定开/关，方便只绑一个快捷指令 */
    toggle: defineAction({
      title: "切换自动投掷",
      async run() {
        if (loop === null) startLoop();
        else stopLoop();
        return snapshot();
      },
    }),

    /** 查询运行状态 / 累计点击次数，便于校验 */
    status: defineAction({
      title: "自动投掷状态",
      async run() {
        return snapshot();
      },
    }),
  },
});

// ---------------------------------------------------------------------------
// 关于「音量键 + 启动 / 音量键 - 停止」
// iOS 没有公开 API 让第三方 App 监听音量键（快捷指令的触发条件里也没有音量键），
// 侧载 App 同样拿不到。所以上面用 Action 暴露开关，推荐这样绑：
//
//  1) 设置 → 辅助功能 → 触控 → 轻点背面 → 「轻点两下」= 开始自动投掷
//                                        「轻点三下」= 停止自动投掷
//     这是最接近「物理按键」的一键开关，不用解锁、不用打开任何 App。
//  2) 或把「开始 / 停止」做成主屏幕快捷指令小组件 / 锁屏小组件。
//  3) 或用 Swipt CLI / MCP 调用 toggle，适合调试。
//
// 如果是在 Windows 上用安卓模拟器玩，音量键反而好办（全局钩子捕获
// VK_VOLUME_UP / VK_VOLUME_DOWN），那需要另写一份 PC 端脚本。
//
// 风险提示：固定 1 秒连点属于典型的自动化脚本特征，游戏客户端可能判定为
// 外挂。请自行评估账号风险；建议把 INTERVAL_JITTER_MS 设成 80 左右。
// ---------------------------------------------------------------------------
