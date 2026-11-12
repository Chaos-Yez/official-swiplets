// 连点器设置页。主页面只留主按钮和几个入口，
// 「坐标记录」「目标对象」「点击间隔」「点击偏移」各自再进一层子页面。
// 配置直接读写 dataDirectory，与 Action 引擎共享。
import {
  Button,
  Form,
  HStack,
  Host,
  Image,
  LabeledContent,
  List,
  NavigationDestination,
  NavigationLink,
  NavigationStack,
  Picker,
  ProgressView,
  RNHostView,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  Toolbar,
  ToolbarItem,
  VStack,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  clipShape,
  controlSize,
  font,
  foregroundStyle,
  frame,
  navigationTitle,
  onAppear,
  resizable,
  tag,
  textSelection,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useEffect, useState } from "react";
import { Image as RNImage } from "react-native";
import { actions, exit } from "@swipt/api/swiplet";
import { PointPicker } from "./PointPicker";
import {
  APP_VERSION,
  clampInterval,
  clampJitter,
  clearRecording,
  DEFAULT_JITTER_PX,
  makeGameId,
  MAX_GAMES,
  MAX_JITTER_PX,
  MAX_POINTS,
  pointName,
  readRecording,
  readSettings,
  recordImageFile,
  RECORD_TTL_MS,
  REF_H,
  REF_W,
  targetBundle,
  validBundleId,
  writeRecording,
  writeSettings,
  type Game,
  type Recording,
  type Settings,
} from "./settings";
import type extension from "./extension";

const { start, record, listApps } = actions<typeof extension>();

const caption = [
  font({ textStyle: "caption" }),
  foregroundStyle({ type: "hierarchical", style: "secondary" }),
];

const dragHint = [
  font({ textStyle: "caption", weight: "semibold" }),
  foregroundStyle({ type: "hierarchical", style: "secondary" }),
];

/** 官方「跳过广告」插件的应用行：圆角图标 + 名称 + 副标题 */
const appIcon = [
  resizable(),
  frame({ width: 40, height: 40 }),
  clipShape("roundedRectangle", 9),
];

/** 设置行内的小应用图标 */
const rowIcon = [
  resizable(),
  frame({ width: 24, height: 24 }),
  clipShape("roundedRectangle", 6),
];

const INTERVAL_OPTIONS: [number, string][] = [
  [300, "0.3 秒"],
  [500, "0.5 秒"],
  [800, "0.8 秒"],
  [1000, "1 秒（默认）"],
  [1500, "1.5 秒"],
  [2000, "2 秒"],
  [3000, "3 秒"],
  [5000, "5 秒"],
];

/** 点击偏移半径预设（参考截图像素） */
const JITTER_OPTIONS: [number, string][] = [
  [0, "关闭（精确点击）"],
  [5, "±5 像素"],
  [10, "±10 像素（默认）"],
  [15, "±15 像素"],
  [20, "±20 像素"],
  [30, "±30 像素"],
  [50, "±50 像素"],
];

interface InstalledApp {
  bundleId: string;
  name: string;
  /** cacheDirectory 里 PNG 的 file:// uri，取不到则为空串 */
  icon: string;
}

interface ImageSize {
  width: number;
  height: number;
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [shotSize, setShotSize] = useState<ImageSize | null>(null);
  const [coordX, setCoordX] = useState("");
  const [coordY, setCoordY] = useState("");
  const [targetIndex, setTargetIndex] = useState(0);
  const [customInterval, setCustomInterval] = useState("");
  const [customJitter, setCustomJitter] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [appsBusy, setAppsBusy] = useState(false);
  const [appFilter, setAppFilter] = useState("");

  useEffect(() => {
    readSettings().then(setSettings, () => setSettings(null));
    readRecording().then((value) => {
      setRecording(value);
      if (value !== null && value.x >= 0) {
        setCoordX(String(Math.round(value.x)));
        setCoordY(String(Math.round(value.y)));
      }
    }, () => setRecording(null));
  }, []);

  // 截图保留期：到点销毁文件、清掉红色标记
  useEffect(() => {
    if (recording === null) return;
    const remain = RECORD_TTL_MS - (Date.now() - recording.time);
    if (remain <= 0) {
      clearRecording().catch(() => {});
      setRecording(null);
      setCoordX("");
      setCoordY("");
      return;
    }
    const timer = setTimeout(() => {
      clearRecording().catch(() => {});
      setRecording(null);
      setCoordX("");
      setCoordY("");
      setDetail("截图已过期，已自动销毁。需要时重新点「坐标记录」。");
    }, remain);
    return () => clearTimeout(timer);
  }, [recording?.time]);

  // 读图片的真实像素尺寸，按真实比例显示：竖屏截图不再被拉伸。
  // 测量完成后才挂载 RNHostView，避免宿主视图先按旧尺寸布局再改动。
  useEffect(() => {
    if (recording === null) {
      setShotSize(null);
      return;
    }
    let alive = true;
    setShotSize(null);
    const fallback = () => {
      // 读不到就用记录里的尺寸兜底，PointPicker 内部仍用 contain 防变形
      if (alive) {
        setShotSize({ width: recording.width, height: recording.height });
      }
    };
    try {
      RNImage.getSize(
        recordImageFile(recording.image).uri,
        (width, height) => {
          if (alive) setShotSize({ width, height });
        },
        fallback,
      );
    } catch {
      fallback();
    }
    return () => {
      alive = false;
    };
  }, [recording?.image, recording?.time, recording?.width, recording?.height]);

  const update = (next: Settings) => {
    setSettings(next);
    writeSettings(next).catch((error: Error) => setDetail(error.message));
  };

  const begin = () => {
    if (busy || settings === null) return;
    setBusy(true);
    setDetail("正在跳转勾选的目标对象并按已启用点位连点…");
    start().then(
      (report) => {
        setBusy(false);
        setDetail(
          `点击 ${report.taps} 次 / 启用 ${report.points} 个点位 · ${report.stopReason}\n` +
            `屏幕 ${report.screen}\n` +
            `最近点击 ${report.point}\n` +
            `前台 ${report.front}` +
            (report.lastError === "" ? "" : `\n错误：${report.lastError}`),
        );
      },
      (error: Error) => {
        setBusy(false);
        setDetail(error.message);
      },
    );
  };

  /** 坐标记录：跳勾选的目标对象 → 抓当前画面 → 自动回到设置页 */
  const capture = () => {
    if (recordingBusy) return;
    setRecordingBusy(true);
    setDetail("正在跳转勾选的目标对象，3 秒后抓取当前画面并回到本页…");
    record().then(
      async (shot) => {
        setRecordingBusy(false);
        const value = await readRecording();
        setRecording(value);
        setCoordX("");
        setCoordY("");
        setDetail(
          `已记录画面 ${shot.width}×${shot.height}；在下方画面上点一下会出现红色标记与坐标。`,
        );
      },
      (error: Error) => {
        setRecordingBusy(false);
        setDetail(`记录画面失败：${error.message}`);
      },
    );
  };

  /** 在游戏画面截图上点选位置 */
  const pick = (nx: number, ny: number) => {
    const x = Math.round(nx * REF_W);
    const y = Math.round(ny * REF_H);
    setCoordX(String(x));
    setCoordY(String(y));
    const next: Recording = {
      width: recording?.width ?? REF_W,
      height: recording?.height ?? REF_H,
      time: recording?.time ?? Date.now(),
      image: recording?.image ?? "",
      x,
      y,
    };
    setRecording(next);
    writeRecording(next).catch(() => {});
    setDetail(
      `已标记坐标 (${x}, ${y})：画面上会出现红色标记，长按坐标文字可复制，也可直接修改 X / Y。`,
    );
  };

  /** 把当前 X/Y 保存到选中的点位（或新增一个点位） */
  const applyCoordinate = () => {
    if (settings === null) return;
    const x = Number(coordX);
    const y = Number(coordY);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > REF_W ||
      y > REF_H
    ) {
      setDetail(`请输入有效坐标：X 0~${REF_W}，Y 0~${REF_H}`);
      return;
    }
    const points = [...settings.points];
    if (targetIndex < 0 || targetIndex >= points.length) {
      if (points.length >= MAX_POINTS) {
        setDetail(`最多 ${MAX_POINTS} 个点位`);
        return;
      }
      points.push({
        id: `p${Date.now()}`,
        name: pointName(points.length),
        x,
        y,
        enabled: false,
      });
    } else {
      points[targetIndex] = { ...points[targetIndex]!, x, y };
    }
    update({ ...settings, points });
    setDetail(`坐标 (${x}, ${y}) 已保存，勾选启用后即会参与点击。`);
  };

  /** 点击间隔子页：应用自定义毫秒 */
  const applyCustomInterval = () => {
    if (settings === null) return;
    const value = Number(customInterval);
    if (
      customInterval.trim() === "" ||
      !Number.isFinite(value) ||
      value <= 0
    ) {
      setDetail("请输入有效的毫秒数");
      return;
    }
    const intervalMs = clampInterval(value);
    update({ ...settings, intervalMs });
    setDetail(`间隔已设为 ${intervalMs} 毫秒`);
  };

  /** 点击偏移子页：应用自定义像素 */
  const applyCustomJitter = () => {
    if (settings === null) return;
    const value = Number(customJitter);
    if (
      customJitter.trim() === "" ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      setDetail("请输入有效的像素数（0 表示关闭偏移）");
      return;
    }
    const jitterPx = clampJitter(value);
    update({ ...settings, jitterPx });
    setDetail(`点击偏移已设为 ±${jitterPx} 像素`);
  };

  const onMove = (sources: number[], destination: number) => {
    if (settings === null) return;
    const from = sources[0];
    if (from === undefined) return;
    const points = [...settings.points];
    const [item] = points.splice(from, 1);
    if (item === undefined) return;
    const to = Math.min(
      points.length,
      Math.max(0, from < destination ? destination - 1 : destination),
    );
    points.splice(to, 0, item);
    update({ ...settings, points });
  };

  const addPoint = () => {
    if (settings === null || settings.points.length >= MAX_POINTS) return;
    update({
      ...settings,
      points: [
        ...settings.points,
        {
          id: `p${Date.now()}`,
          name: pointName(settings.points.length),
          x: -1,
          y: -1,
          enabled: false,
        },
      ],
    });
  };

  /** 选中某个已安装应用作为目标对象；不存在则加入，超过上限自动淘汰最旧的 */
  const addGame = (name: string, bundleId: string) => {
    if (settings === null) return;
    const id = bundleId.trim();
    if (!validBundleId(id)) {
      setDetail(`「${id}」不是有效的 Bundle ID`);
      return;
    }
    const existing = settings.games.find((g) => g.bundleId === id);
    if (existing !== undefined) {
      update({ ...settings, targetGameId: existing.id });
      setDetail(`目标对象已设为 ${existing.name} (${id})。`);
      return;
    }
    const game: Game = {
      id: makeGameId(),
      name: name.trim() === "" ? id : name.trim(),
      bundleId: id,
    };
    const games = [...settings.games.slice(-(MAX_GAMES - 1)), game];
    update({ ...settings, games, targetGameId: game.id });
    setDetail(`目标对象已设为「${game.name}」(${id})。`);
  };

  const loadApps = () => {
    if (appsBusy) return;
    setAppsBusy(true);
    listApps().then(
      (apps) => {
        setInstalled(apps);
        setAppsBusy(false);
        setDetail(`读取到 ${apps.length} 个已安装应用；勾选一个即设为目标对象。`);
      },
      (error: Error) => {
        setAppsBusy(false);
        setDetail(`读取应用列表失败：${error.message}`);
      },
    );
  };

  const intervalOptions = [...INTERVAL_OPTIONS];
  if (
    settings !== null &&
    !intervalOptions.some(([ms]) => ms === settings.intervalMs)
  ) {
    intervalOptions.push([
      settings.intervalMs,
      `自定义 ${settings.intervalMs} 毫秒`,
    ]);
  }

  const jitterOptions = [...JITTER_OPTIONS];
  if (
    settings !== null &&
    !jitterOptions.some(([px]) => px === settings.jitterPx)
  ) {
    jitterOptions.push([
      settings.jitterPx,
      `自定义 ±${settings.jitterPx} 像素`,
    ]);
  }

  // 红色标记跟随 X / Y 输入框，手动改坐标也能立刻看到位置
  const parsedX = Number(coordX);
  const parsedY = Number(coordY);
  const hasMarker =
    coordX !== "" &&
    coordY !== "" &&
    Number.isFinite(parsedX) &&
    Number.isFinite(parsedY) &&
    parsedX >= 0 &&
    parsedY >= 0 &&
    parsedX <= REF_W &&
    parsedY <= REF_H;
  const marker = hasMarker
    ? { x: parsedX / REF_W, y: parsedY / REF_H }
    : null;

  const currentBundle = settings === null ? "" : targetBundle(settings);
  const targetGame =
    settings === null
      ? undefined
      : settings.games.find((g) => g.id === settings.targetGameId);
  const targetIcon =
    installed.find((app) => app.bundleId === currentBundle)?.icon ?? "";
  // 目标对象只显示应用名称：优先已安装应用里的真实名称，其次设置里的名字，最后回退包名
  const targetAppName =
    installed.find((app) => app.bundleId === currentBundle)?.name ?? "";
  const targetDisplayName =
    targetAppName !== ""
      ? targetAppName
      : targetGame !== undefined && targetGame.name !== currentBundle
        ? targetGame.name
        : currentBundle;
  const filter = appFilter.trim().toLowerCase();
  const filteredApps = installed
    .filter(
      (app) =>
        filter === "" ||
        app.name.toLowerCase().includes(filter) ||
        app.bundleId.toLowerCase().includes(filter),
    )
    .slice(0, 60);

  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack>
        {/* ============ 主页面 ============ */}
        <Toolbar modifiers={[navigationTitle("连点器"), onAppear(loadApps)]}>
          <List>
            {/* 最上方：居中、放大的主按钮 */}
            <Section
              footer={
                <Text modifiers={caption}>
                  {detail === ""
                    ? "点「开始连点」后约 3 秒开始自动连点。\n切回 Swipt、切到其他应用、锁屏或熄屏都会自动停止。"
                    : detail}
                </Text>
              }
            >
              <HStack modifiers={[frame({ maxWidth: Infinity })]}>
                <Spacer />
                <Button
                  label="开始连点"
                  systemImage="play.fill"
                  onPress={begin}
                  modifiers={[
                    buttonStyle("borderedProminent"),
                    tint("orange"),
                    controlSize("extraLarge"),
                    font({ size: 20, weight: "semibold" }),
                  ]}
                />
                <Spacer />
              </HStack>
            </Section>

            {/* 四个入口：点进去才展开各自的设置项 */}
            <Section title="设置">
              {/* 目标对象放第一行 */}
              <NavigationLink value="targets">
                <LabeledContent label="目标对象">
                  <HStack spacing={6}>
                    {targetIcon !== "" && (
                      <Image uiImage={targetIcon} modifiers={rowIcon} />
                    )}
                    <Text modifiers={caption}>{targetDisplayName}</Text>
                  </HStack>
                </LabeledContent>
              </NavigationLink>
              <NavigationLink value="record">
                <LabeledContent label="坐标记录">
                  <Text modifiers={caption}>
                    {recording === null
                      ? "尚未记录画面"
                      : `已有画面 · ${recording.width}×${recording.height}`}
                  </Text>
                </LabeledContent>
              </NavigationLink>
              <NavigationLink value="interval">
                <LabeledContent label="点击间隔">
                  <Text modifiers={caption}>
                    {settings === null ? "—" : `${settings.intervalMs} 毫秒`}
                  </Text>
                </LabeledContent>
              </NavigationLink>
              <NavigationLink value="offset">
                <LabeledContent label="点击偏移">
                  <Text modifiers={caption}>
                    {settings === null
                      ? "—"
                      : `±${settings.jitterPx} 像素`}
                  </Text>
                </LabeledContent>
              </NavigationLink>
            </Section>

            {/* 点击位置：勾选启用 + 拖拽排序 */}
            <Section
              title="点击位置"
              footer={
                <Text modifiers={caption}>
                  默认只有点位一启用。勾选其它点位即参与点击，按这里的顺序依次执行；
                  未设置坐标的点位会自动跳过。
                </Text>
              }
            >
              {/* 拖动提示放在最前头 */}
              <Text modifiers={dragHint}>
                ≡ 按住行首把手可拖动调整点击顺序，左滑可删除
              </Text>
              {settings !== null && (
                <List.ForEach
                  data={settings.points}
                  keyExtractor={(item) => item.id}
                  onMove={onMove}
                  onDelete={(indices) => {
                    const points = [...settings.points];
                    for (const index of [...indices].sort((a, b) => b - a)) {
                      if (points.length > 1) points.splice(index, 1);
                    }
                    update({ ...settings, points });
                  }}
                >
                  {({ item, index }) => (
                    // 一行从左到右：拖动把手 → 点位名 → 坐标 → 绿色开关
                    <HStack spacing={8}>
                      <Text modifiers={dragHint}>≡</Text>
                      <Text>{item.name}</Text>
                      <Spacer />
                      <Text modifiers={caption}>
                        {item.x >= 0
                          ? `(${item.x}, ${item.y})`
                          : "未设置坐标"}
                      </Text>
                      <Toggle
                        isOn={item.enabled}
                        onIsOnChange={(enabled) => {
                          const points = [...settings.points];
                          points[index] = { ...points[index]!, enabled };
                          update({ ...settings, points });
                        }}
                        modifiers={[frame({ width: 56 })]}
                      />
                    </HStack>
                  )}
                </List.ForEach>
              )}
              <HStack modifiers={[frame({ maxWidth: Infinity })]}>
                <Spacer />
                <Button
                  label="添加点位"
                  systemImage="plus"
                  onPress={addPoint}
                />
              </HStack>
            </Section>

            {/* 版本号 */}
            <Section>
              <LabeledContent label="版本">
                <Text modifiers={caption}>连点器 v{APP_VERSION}</Text>
              </LabeledContent>
            </Section>
          </List>
          <Toolbar.Content>
            <ToolbarItem placement="topBarTrailing">
              <Button
                label="完成"
                systemImage="xmark"
                role="close"
                onPress={exit}
              />
            </ToolbarItem>
          </Toolbar.Content>
        </Toolbar>

        {/* ============ 坐标记录子页面 ============ */}
        <NavigationDestination value="record">
          <Toolbar modifiers={[navigationTitle("坐标记录")]}>
            <List>
              <Section
                footer={
                  <Text modifiers={caption}>
                    {detail === ""
                      ? "1. 点「坐标记录」会跳转到目标对象，约 3 秒后自动抓取画面并返回。\n2. 在画面上点一下定位红色标记，按住标记可拖动精确定位。\n3. 选好要保存的点位后点「保存为点位」，最多 8 个。\n4. 再次抓取会覆盖上一张；截图 10 分钟后自动销毁。"
                      : detail}
                  </Text>
                }
              >
                <Button
                  label={recordingBusy ? "正在记录…" : "坐标记录（跳转对象）"}
                  systemImage="mappin.and.ellipse"
                  onPress={capture}
                  modifiers={[buttonStyle("bordered"), tint("orange")]}
                />
                {recording !== null && shotSize !== null && (
                  <RNHostView matchContents>
                    <PointPicker
                      key={recording.time}
                      uri={recordImageFile(recording.image).uri}
                      width={shotSize.width}
                      height={shotSize.height}
                      marker={marker}
                      label={
                        coordX === "" || coordY === ""
                          ? ""
                          : `${coordX}, ${coordY}`
                      }
                      onPick={pick}
                    />
                  </RNHostView>
                )}
                <LabeledContent label="记录的坐标">
                  <Text
                    modifiers={[
                      textSelection(true),
                      font({ design: "monospaced" }),
                    ]}
                  >
                    {coordX === "" || coordY === ""
                      ? "尚未记录"
                      : `${coordX}, ${coordY}`}
                  </Text>
                </LabeledContent>
                <TextField
                  placeholder={
                    coordX === "" ? "X 坐标" : `X 坐标（当前 ${coordX}）`
                  }
                  onTextChange={setCoordX}
                  modifiers={[]}
                />
                <TextField
                  placeholder={
                    coordY === "" ? "Y 坐标" : `Y 坐标（当前 ${coordY}）`
                  }
                  onTextChange={setCoordY}
                  modifiers={[]}
                />
                {settings !== null && (
                  <Picker<number>
                    label="保存到"
                    selection={targetIndex}
                    onSelectionChange={(value) => setTargetIndex(Number(value))}
                  >
                    {settings.points.map((p, index) => (
                      <Text key={p.id} modifiers={[tag(index)]}>
                        {p.name}
                      </Text>
                    ))}
                    {settings.points.length < MAX_POINTS && (
                      <Text modifiers={[tag(-1)]}>新增点位</Text>
                    )}
                  </Picker>
                )}
                <HStack modifiers={[frame({ maxWidth: Infinity })]}>
                  <Spacer />
                  <Button
                    label="保存为点位"
                    systemImage="square.and.arrow.down"
                    onPress={applyCoordinate}
                  />
                </HStack>
              </Section>
            </List>
          </Toolbar>
        </NavigationDestination>

        {/* ============ 目标对象子页面 ============ */}
        <NavigationDestination value="targets">
          <Toolbar modifiers={[navigationTitle("目标对象"), onAppear(loadApps)]}>
            <Form>
              <Section
                title="当前目标对象"
                footer={
                  <Text modifiers={caption}>
                    勾选后，「开始连点」和「坐标记录」都会跳转到它，自动停止的判断也以它为准。
                  </Text>
                }
              >
                <HStack spacing={12}>
                  {targetIcon !== "" && (
                    <Image uiImage={targetIcon} modifiers={appIcon} />
                  )}
                  <VStack alignment="leading" spacing={2}>
                    <Text>{targetDisplayName}</Text>
                    <Text modifiers={caption}>{currentBundle}</Text>
                  </VStack>
                  <Spacer />
                </HStack>
              </Section>

              <Section
                title="从已安装应用选择"
                footer={
                  <Text modifiers={caption}>
                    {detail === ""
                      ? "1. 使用前先在「当前目标对象」里选好要连点的应用。\n2. 点「开始连点」会先跳转过去，约 3 秒后开始自动连点。\n3. 切回 Swipt、切到其他应用、锁屏或屏幕熄灭都会自动停止。"
                      : detail}
                  </Text>
                }
              >
                <TextField
                  placeholder="搜索应用名称或 Bundle ID"
                  onTextChange={setAppFilter}
                  modifiers={[]}
                />
                {appsBusy && <ProgressView />}
                {installed.length > 0 && filteredApps.length === 0 && (
                  <Text modifiers={caption}>没有匹配的应用</Text>
                )}
                {filteredApps.map((app) => (
                  <Toggle
                    key={app.bundleId}
                    isOn={app.bundleId === currentBundle}
                    onIsOnChange={(on) => {
                      if (on) addGame(app.name, app.bundleId);
                    }}
                  >
                    <HStack spacing={12}>
                      {app.icon !== "" && (
                        <Image uiImage={app.icon} modifiers={appIcon} />
                      )}
                      <VStack alignment="leading" spacing={2}>
                        <Text>{app.name}</Text>
                        <Text modifiers={caption}>{app.bundleId}</Text>
                      </VStack>
                    </HStack>
                  </Toggle>
                ))}
                <HStack modifiers={[frame({ maxWidth: Infinity })]}>
                  <Spacer />
                  <Button
                    label={appsBusy ? "读取中…" : "刷新应用列表"}
                    systemImage="arrow.triangle.2.circlepath"
                    onPress={loadApps}
                    modifiers={[buttonStyle("bordered")]}
                  />
                </HStack>
              </Section>
            </Form>
          </Toolbar>
        </NavigationDestination>

        {/* ============ 点击间隔子页面 ============ */}
        <NavigationDestination value="interval">
          <Toolbar modifiers={[navigationTitle("点击间隔")]}>
            <Form>
              <Section
                title="间隔"
                footer={
                  <Text modifiers={caption}>
                    每一次点击之间的等待时间。间隔越短越像脚本，注意游戏风控。
                  </Text>
                }
              >
                {settings !== null && (
                  <Picker<number>
                    label="间隔"
                    selection={settings.intervalMs}
                    onSelectionChange={(value) =>
                      update({
                        ...settings,
                        intervalMs: clampInterval(Number(value)),
                      })
                    }
                  >
                    {intervalOptions.map(([ms, label]) => (
                      <Text key={ms} modifiers={[tag(ms)]}>
                        {label}
                      </Text>
                    ))}
                  </Picker>
                )}
                <LabeledContent label="当前间隔">
                  <Text>
                    {settings === null ? "—" : `${settings.intervalMs} 毫秒`}
                  </Text>
                </LabeledContent>
              </Section>

              <Section
                title="自定义"
                footer={
                  <Text modifiers={caption}>
                    可填 100 ~ 60000 毫秒；应用后即时保存，下一次连点生效。
                  </Text>
                }
              >
                <TextField
                  placeholder="自定义毫秒（100 ~ 60000）"
                  onTextChange={setCustomInterval}
                  modifiers={[]}
                />
                <HStack modifiers={[frame({ maxWidth: Infinity })]}>
                  <Spacer />
                  <Button
                    label="应用自定义间隔"
                    onPress={applyCustomInterval}
                    modifiers={[buttonStyle("bordered")]}
                  />
                </HStack>
              </Section>
            </Form>
          </Toolbar>
        </NavigationDestination>

        {/* ============ 点击偏移子页面 ============ */}
        <NavigationDestination value="offset">
          <Toolbar modifiers={[navigationTitle("点击偏移")]}>
            <Form>
              <Section
                title="偏移范围"
                footer={
                  <Text modifiers={caption}>
                    每次点击会在点位附近随机偏移，设 0 则每次都点在同一位置。
                    数值按参考截图像素计算，过大可能误触相邻按钮。
                  </Text>
                }
              >
                {settings !== null && (
                  <Picker<number>
                    label="偏移"
                    selection={settings.jitterPx}
                    onSelectionChange={(value) =>
                      update({
                        ...settings,
                        jitterPx: clampJitter(Number(value)),
                      })
                    }
                  >
                    {jitterOptions.map(([px, label]) => (
                      <Text key={px} modifiers={[tag(px)]}>
                        {label}
                      </Text>
                    ))}
                  </Picker>
                )}
                <LabeledContent label="当前偏移">
                  <Text>
                    {settings === null
                      ? `±${DEFAULT_JITTER_PX} 像素`
                      : `±${settings.jitterPx} 像素`}
                  </Text>
                </LabeledContent>
              </Section>

              <Section
                title="自定义"
                footer={
                  <Text modifiers={caption}>
                    可填 0 ~ {MAX_JITTER_PX} 像素；偏移为圆形随机分布，越靠中心概率越高。
                  </Text>
                }
              >
                <TextField
                  placeholder={`自定义像素（0 ~ ${MAX_JITTER_PX}）`}
                  onTextChange={setCustomJitter}
                  modifiers={[]}
                />
                <HStack modifiers={[frame({ maxWidth: Infinity })]}>
                  <Spacer />
                  <Button
                    label="应用自定义偏移"
                    onPress={applyCustomJitter}
                    modifiers={[buttonStyle("bordered")]}
                  />
                </HStack>
              </Section>
            </Form>
          </Toolbar>
        </NavigationDestination>
      </NavigationStack>
    </Host>
  );
}
