// 设置与录制结果的持久化。
// Swipt 的 Action 与 UI 是两个独立 JS 引擎，内存不共享；
// dataDirectory 按 swiplet 目录落地，两边读写同一份文件即可通信。
import { dataDirectory } from "@swipt/api/file-system";

/** 参考截图分辨率（横屏） */
export const REF_W = 2217;
export const REF_H = 1024;
export const MAX_POINTS = 8;

export interface TapPoint {
  id: string;
  name: string;
  /** 参考截图坐标系；-1 表示尚未设置 */
  x: number;
  y: number;
  enabled: boolean;
}

export interface Settings {
  intervalMs: number;
  points: TapPoint[];
}

/** 最近一次录制的画面与选中的坐标 */
export interface Recording {
  width: number;
  height: number;
  time: number;
  /** 参考截图坐标系；-1 表示尚未点选 */
  x: number;
  y: number;
}

const settingsFile = () => dataDirectory.file("settings.json");
const recordFile = () => dataDirectory.file("record.json");
export const recordImageFile = () => dataDirectory.file("record.png");

export function defaultSettings(): Settings {
  return {
    intervalMs: 1000,
    points: [
      { id: "p1", name: "投掷", x: 1760, y: 780, enabled: true },
      { id: "p2", name: "点位 2", x: -1, y: -1, enabled: false },
      { id: "p3", name: "点位 3", x: -1, y: -1, enabled: false },
      { id: "p4", name: "点位 4", x: -1, y: -1, enabled: false },
    ],
  };
}

export function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.min(60_000, Math.max(100, Math.round(value)));
}

function sanitize(value: unknown): Settings {
  const fallback = defaultSettings();
  if (typeof value !== "object" || value === null) return fallback;
  const raw = value as Partial<Settings>;
  if (!Array.isArray(raw.points) || raw.points.length === 0) return fallback;
  return {
    intervalMs: clampInterval(Number(raw.intervalMs)),
    points: raw.points.slice(0, MAX_POINTS).map((p, index) => {
      const item = (p ?? {}) as Partial<TapPoint>;
      const x = Number(item.x);
      const y = Number(item.y);
      return {
        id: typeof item.id === "string" ? item.id : `p${index + 1}`,
        name:
          typeof item.name === "string" && item.name !== ""
            ? item.name
            : `点位 ${index + 1}`,
        x: Number.isFinite(x) && x >= 0 ? Math.round(x) : -1,
        y: Number.isFinite(y) && y >= 0 ? Math.round(y) : -1,
        enabled: Boolean(item.enabled),
      };
    }),
  };
}

async function ensureDirectory(): Promise<void> {
  try {
    if (!(await dataDirectory.exists())) await dataDirectory.create();
  } catch {
    // 宿主已创建或并发创建，忽略
  }
}

export async function readSettings(): Promise<Settings> {
  try {
    return sanitize(JSON.parse(await settingsFile().text()));
  } catch {
    return defaultSettings();
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  await ensureDirectory();
  await settingsFile().write(JSON.stringify(settings));
}

export async function readRecording(): Promise<Recording | null> {
  try {
    const raw = JSON.parse(await recordFile().text());
    if (typeof raw?.width !== "number" || typeof raw?.height !== "number") {
      return null;
    }
    return {
      width: raw.width,
      height: raw.height,
      time: Number(raw.time) || 0,
      x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : -1,
      y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : -1,
    };
  } catch {
    return null;
  }
}

export async function writeRecording(recording: Recording): Promise<void> {
  await ensureDirectory();
  await recordFile().write(JSON.stringify(recording));
}
