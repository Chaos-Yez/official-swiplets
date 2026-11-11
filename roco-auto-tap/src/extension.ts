// 洛克王国 · 自动投掷 (Swiplet)
// ---------------------------------------------------------------------------
// start  : 跳转 com.tencent.nrc → 按「已启用点位」的顺序循环点击，间隔可配置。
// record : 跳转游戏 → 抓一张当前画面 → 回到 Swipt，供设置页点选并「记录坐标」。
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
  readSettings,
  recordImageFile,
  REF_H,
  REF_W,
  writeRecording,
  type TapPoint,
} from "./settings";

const GAME_BUNDLE_ID = "com.tencent.nrc";
/** Swipt 自身，抓取画面后跳回设置页用（官方 ownApps 正则里的前缀） */
const SWIPT_BUNDLE_ID = "io.nekohasekai.swipt";
/** 跳转后等待切换动画 */
const LAUNCH_SETTLE_MS = 1200;
/** 坐标记录：跳到游戏后留给用户切到目标画面的时间 */
const RECORD_DELAY_MS = 3000;
/** 启动后的事件宽限期，避免切换动画里的系统 UI 事件误停 */
const GRACE_MS = 800;
/** 每次点击的随机偏移半径（参考截图像素，约 ±10px） */
const JITTER_PX = 10;
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

/** 参考截图坐标 -> 当前屏幕坐标，并加一点随机偏移 */
function pointOf(p: TapPoint, screen: ScreenSize): Point {
  const jitter = (JITTER_PX * screen.width) / REF_W;
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

async function runTaps(signal: AbortSignal, report: Report): Promise<void> {
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
      if (front !== GAME_BUNDLE_ID) {
        report.stopReason = `前台已切换为 ${front}`;
        return;
      }
    }

    const target = active[index % active.length]!;
    const point = pointOf(target, screen);
    report.point = `${target.name} (${Math.round(point[0])}, ${Math.round(point[1])})`;
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

/** 前台变化即停止 */
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
    // 信号取消 / 设备断开
  }
}

export default defineExtension({
  // 常驻服务由 Swipt 自动托管；界面用 useService 显示状态。
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
        "跳转到洛克王国并按已启用点位的顺序循环点击；切换应用或拉下控制中心自动停止",
      expose: ["shortcuts"],
      async run(_, { signal }) {
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
          await device.launchApplication(GAME_BUNDLE_ID, { signal });
        } catch (error) {
          report.lastError = `跳转失败：${messageOf(error)}`;
          report.stopReason = "未能切换到游戏";
          return report;
        }
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

    /** 坐标记录：抓一张游戏当前画面，回到设置页后在图上点选位置 */
    record: defineAction({
      title: "坐标记录",
      description: "跳转到洛克王国并抓取当前画面，返回设置页后点图记录坐标",
      async run(_, { signal }) {
        await device.launchApplication(GAME_BUNDLE_ID, { signal });
        await sleep(RECORD_DELAY_MS, signal);
        const shot = await device.screenshot({ signal });
        const image = shot.width < shot.height ? shot.rotate(90) : shot;
        try {
          if (!(await dataDirectory.exists())) await dataDirectory.create();
        } catch {
          // 已存在
        }
        await image.save(recordImageFile(), { signal, format: "png" });
        await writeRecording({
          width: image.width,
          height: image.height,
          time: Date.now(),
          x: -1,
          y: -1,
        });
        // 回到 Swipt 设置页；失败也不影响，用户手动切回来一样能看到图
        await device
          .launchApplication(SWIPT_BUNDLE_ID, { signal })
          .catch(() => {});
        return { width: image.width, height: image.height };
      },
    }),
  },
});
