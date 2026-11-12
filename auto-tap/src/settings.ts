// 设置与坐标记录结果的持久化。
// Swipt 的 Action 与 UI 是两个独立 JS 引擎，内存不共享；
// dataDirectory 按 swiplet 目录落地，两边读写同一份文件即可通信。
import { dataDirectory } from "@swipt/api/file-system";

/** 插件版本（与 package.json 的 version 保持一致） */
export const APP_VERSION = "0.1.0";

/** 参考截图分辨率（横屏） */
export const REF_W = 2217;
export const REF_H = 1024;
export const MAX_POINTS = 8;
export const MAX_GAMES = 8;
/** 默认跳转目标（可在「目标对象」里换成任意已安装应用） */
export const DEFAULT_BUNDLE_ID = "com.tencent.nrc";
/** 默认点击随机偏移半径（参考截图像素） */
export const DEFAULT_JITTER_PX = 10;
/** 点击偏移上限，避免误触相邻按钮 */
export const MAX_JITTER_PX = 200;
/** 坐标记录截图保留时长：10 分钟后自动销毁 */
export const RECORD_TTL_MS = 10 * 60 * 1000;

const SETTINGS_FILE = "settings.json";
const RECORD_FILE = "record.json";
/** code=6 及更早版本使用的固定截图名，清理时一并删除 */
export const LEGACY_RECORD_IMAGE = "record.png";

const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八"];

/** 点位统一按序号命名，拖拽排序后名称始终与顺序一致 */
export function pointName(index: number): string {
  return `点位${CN_NUM[index] ?? index + 1}`;
}

/** 生成一个不重复的条目 id */
export function makeGameId(): string {
  return `g${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

/** Bundle ID 只接受常见字符，避免误输入导致跳转失败 */
export function validBundleId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/**
 * 每张截图用带时间戳的独立文件名，写入前先清掉旧的。
 * 独立文件名可绕开 RN Image 对同一 file:// uri 的缓存，避免「覆盖后还显示上一张」。
 */
export function recordImageName(time: number): string {
  return `record-${time}.png`;
}

export const recordImageFile = (name: string) =>
  dataDirectory.file(name || LEGACY_RECORD_IMAGE);

export interface TapPoint {
  id: string;
  name: string;
  /** 参考截图坐标系；-1 表示尚未设置 */
  x: number;
  y: number;
  enabled: boolean;
}

/** 跳转目标白名单中的一款游戏 */
export interface Game {
  id: string;
  name: string;
  bundleId: string;
}

export interface Settings {
  intervalMs: number;
  /** 每次点击的随机偏移半径（参考截图像素），0 = 精确点击 */
  jitterPx: number;
  points: TapPoint[];
  games: Game[];
  /** 当前勾选、要跳转的游戏 id */
  targetGameId: string;
}

/** 最近一次记录的画面与选中的坐标 */
export interface Recording {
  width: number;
  height: number;
  time: number;
  /** 截图文件名（旧记录可能没有此字段） */
  image: string;
  /** 参考截图坐标系；-1 表示尚未点选 */
  x: number;
  y: number;
}

const settingsFile = () => dataDirectory.file(SETTINGS_FILE);
const recordFile = () => dataDirectory.file(RECORD_FILE);

export function defaultGames(): Game[] {
  return [
    { id: "sample", name: DEFAULT_BUNDLE_ID, bundleId: DEFAULT_BUNDLE_ID },
  ];
}

export function defaultSettings(): Settings {
  return {
    intervalMs: 1000,
    jitterPx: DEFAULT_JITTER_PX,
    points: [
      { id: "p1", name: pointName(0), x: 1760, y: 780, enabled: true },
      { id: "p2", name: pointName(1), x: -1, y: -1, enabled: false },
      { id: "p3", name: pointName(2), x: -1, y: -1, enabled: false },
      { id: "p4", name: pointName(3), x: -1, y: -1, enabled: false },
    ],
    games: defaultGames(),
    targetGameId: "sample",
  };
}

/** 取当前勾选游戏的 Bundle ID；数据异常时回退默认游戏 */
export function targetBundle(settings: Settings): string {
  const game = settings.games.find((g) => g.id === settings.targetGameId);
  return game && validBundleId(game.bundleId)
    ? game.bundleId
    : DEFAULT_BUNDLE_ID;
}

export function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.min(60_000, Math.max(100, Math.round(value)));
}

/** 偏移半径限幅；旧配置没有此字段（NaN）时回退默认值 */
export function clampJitter(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_JITTER_PX;
  return Math.min(MAX_JITTER_PX, Math.max(0, Math.round(value)));
}

function sanitizeGames(value: unknown): Game[] {
  if (!Array.isArray(value)) return defaultGames();
  const games: Game[] = [];
  for (const raw of value) {
    if (games.length >= MAX_GAMES) break;
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Partial<Game>;
    const bundleId = typeof item.bundleId === "string" ? item.bundleId.trim() : "";
    if (!validBundleId(bundleId) || games.some((g) => g.bundleId === bundleId)) {
      continue;
    }
    const rawName = typeof item.name === "string" ? item.name.trim() : "";
    games.push({
      id: typeof item.id === "string" && item.id !== ""
        ? item.id
        : makeGameId(),
      // 旧版本默认项的名字写死为「示例目标」；升级后统一改为按包名显示，清掉残留占位名
      name: rawName === "" || rawName === "示例目标" ? bundleId : rawName,
      bundleId,
    });
  }
  return games.length > 0 ? games : defaultGames();
}

function sanitize(value: unknown): Settings {
  const fallback = defaultSettings();
  if (typeof value !== "object" || value === null) return fallback;
  const raw = value as Partial<Settings>;
  if (!Array.isArray(raw.points) || raw.points.length === 0) return fallback;
  const games = sanitizeGames(raw.games);
  const targetGameId =
    typeof raw.targetGameId === "string" &&
    games.some((g) => g.id === raw.targetGameId)
      ? raw.targetGameId
      : games[0]!.id;
  return {
    intervalMs: clampInterval(Number(raw.intervalMs)),
    jitterPx: clampJitter(Number(raw.jitterPx)),
    points: raw.points.slice(0, MAX_POINTS).map((p, index) => {
      const item = (p ?? {}) as Partial<TapPoint>;
      const x = Number(item.x);
      const y = Number(item.y);
      return {
        id: typeof item.id === "string" ? item.id : `p${index + 1}`,
        // 旧的「投掷」等名称统一改回序号命名
        name: pointName(index),
        x: Number.isFinite(x) && x >= 0 ? Math.round(x) : -1,
        y: Number.isFinite(y) && y >= 0 ? Math.round(y) : -1,
        enabled: Boolean(item.enabled),
      };
    }),
    games,
    targetGameId,
  };
}

async function ensureDirectory(): Promise<void> {
  try {
    if (!(await dataDirectory.exists())) await dataDirectory.create();
  } catch {
    // 宿主已创建或并发创建，忽略
  }
}

/**
 * 销毁坐标记录：删掉记录文件与所有截图（含旧版 record.png）。
 * 每次抓新图前先调用，磁盘上永远只存在一张截图，不会越用越大。
 */
export async function clearRecording(): Promise<void> {
  try {
    const entries = await dataDirectory.list();
    for (const entry of entries) {
      if (
        entry.name === RECORD_FILE ||
        entry.name === LEGACY_RECORD_IMAGE ||
        /^record-\d+\.png$/.test(entry.name)
      ) {
        await entry.delete().catch(() => {});
      }
    }
  } catch {
    // 目录不存在 / 读取失败：没有需要清理的东西
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
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await recordFile().text()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const width: unknown = raw.width;
  const height: unknown = raw.height;
  if (typeof width !== "number" || typeof height !== "number") {
    return null;
  }
  const time = Number(raw.time) || 0;
  // 超过保留时长立即销毁，不把过期截图留在磁盘上、也不显示在界面上
  if (time <= 0 || Date.now() - time > RECORD_TTL_MS) {
    await clearRecording();
    return null;
  }
  return {
    width,
    height,
    time,
    image:
      typeof raw.image === "string" && raw.image !== ""
        ? raw.image
        : LEGACY_RECORD_IMAGE,
    x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : -1,
    y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : -1,
  };
}

export async function writeRecording(recording: Recording): Promise<void> {
  await ensureDirectory();
  await recordFile().write(JSON.stringify(recording));
}
