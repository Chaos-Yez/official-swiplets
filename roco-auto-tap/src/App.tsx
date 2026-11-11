// 设置页：顶部居中的大号「开始连点」→ 坐标记录 → 点击间隔 → 可勾选 / 可拖拽排序的点击点。
// 配置直接读写 dataDirectory，与 Action 引擎共享。
import {
  Button,
  HStack,
  Host,
  LabeledContent,
  List,
  NavigationStack,
  Picker,
  RNHostView,
  Section,
  Spacer,
  Text,
  TextField,
  Toggle,
  Toolbar,
  ToolbarItem,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  controlSize,
  font,
  foregroundStyle,
  frame,
  navigationTitle,
  tag,
  textSelection,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useEffect, useState } from "react";
import { actions, exit } from "@swipt/api/swiplet";
import { PointPicker } from "./PointPicker";
import {
  clampInterval,
  clearRecording,
  MAX_POINTS,
  pointName,
  readRecording,
  readSettings,
  recordImageFile,
  RECORD_TTL_MS,
  REF_H,
  REF_W,
  writeRecording,
  writeSettings,
  type Recording,
  type Settings,
} from "./settings";
import type extension from "./extension";

const { start, record } = actions<typeof extension>();

const caption = [
  font({ textStyle: "caption" }),
  foregroundStyle({ type: "hierarchical", style: "secondary" }),
];

const dragHint = [
  font({ textStyle: "caption", weight: "semibold" }),
  foregroundStyle({ type: "hierarchical", style: "secondary" }),
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

type Phase = "idle" | "running" | "done" | "failed";
const phaseText: Record<Phase, string> = {
  idle: "待机",
  running: "运行中",
  done: "已停止",
  failed: "启动失败",
};

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [coordX, setCoordX] = useState("");
  const [coordY, setCoordY] = useState("");
  const [targetIndex, setTargetIndex] = useState(0);
  const [customInterval, setCustomInterval] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);

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

  // 截图只保留 10 分钟：到点销毁文件、清掉红色标记
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
      setDetail("截图已超过 10 分钟，已自动销毁。需要时重新点「坐标记录」。");
    }, remain);
    return () => clearTimeout(timer);
  }, [recording?.time]);

  const update = (next: Settings) => {
    setSettings(next);
    writeSettings(next).catch((error: Error) => setDetail(error.message));
  };

  const begin = () => {
    if (busy || settings === null) return;
    setBusy(true);
    setPhase("running");
    setDetail("正在跳转游戏并按已启用点位连点…");
    start().then(
      (report) => {
        setBusy(false);
        setPhase("done");
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
        setPhase("failed");
        setDetail(error.message);
      },
    );
  };

  /** 坐标记录：跳游戏 → 抓当前画面 → 自动回到设置页 */
  const capture = () => {
    if (recordingBusy) return;
    setRecordingBusy(true);
    setDetail("正在跳转游戏，3 秒后抓取当前画面并回到本页…");
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

  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle("自动投掷")]}>
          <List>
            {/* 最上方：居中、放大的主按钮 */}
            <Section
              footer={
                <Text modifiers={caption}>
                  {detail === ""
                    ? "点「开始连点」会跳转游戏，按下方已启用点位的顺序循环点击；切换应用或拉下控制中心自动停止。"
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
              <LabeledContent label="连点状态">
                <Text>{phaseText[phase]}</Text>
              </LabeledContent>
            </Section>

            {/* 坐标记录 */}
            <Section
              title="坐标记录"
              footer={
                <Text modifiers={caption}>
                  跳转游戏后 3 秒抓取当前画面并自动返回本页；在画面上点一下会出现红色标记与坐标。
                  截图只保留 10 分钟，到点自动销毁；再次抓取会覆盖前一张，不会越用越占空间。
                </Text>
              }
            >
              <Button
                label={recordingBusy ? "正在记录…" : "坐标记录（跳转游戏）"}
                systemImage="mappin.and.ellipse"
                onPress={capture}
                modifiers={[buttonStyle("bordered"), tint("orange")]}
              />
              {recording !== null && (
                <RNHostView matchContents>
                  <PointPicker
                    key={recording.time}
                    uri={recordImageFile(recording.image).uri}
                    width={recording.width}
                    height={recording.height}
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
              <Button
                label="保存为点位"
                systemImage="square.and.arrow.down"
                onPress={applyCoordinate}
              />
            </Section>

            {/* 点击间隔 */}
            <Section
              title="点击间隔"
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
              <TextField
                placeholder="自定义毫秒（100 ~ 60000）"
                onTextChange={setCustomInterval}
                modifiers={[]}
              />
              <Button
                label="应用自定义间隔"
                onPress={() => {
                  if (settings === null) return;
                  const value = Number(customInterval);
                  if (!Number.isFinite(value) || value <= 0) {
                    setDetail("请输入有效的毫秒数");
                    return;
                  }
                  update({
                    ...settings,
                    intervalMs: clampInterval(value),
                  });
                  setDetail(`间隔已设为 ${clampInterval(value)} 毫秒`);
                }}
              />
            </Section>

            {/* 点击点：勾选启用 + 拖拽排序 */}
            <Section
              title="点击点"
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
                    <HStack>
                      <Text modifiers={dragHint}>≡</Text>
                      <Text modifiers={caption}>
                        {item.x >= 0 ? `(${item.x}, ${item.y})` : "未设置"}
                      </Text>
                      <Toggle
                        label={item.name}
                        isOn={item.enabled}
                        onIsOnChange={(enabled) => {
                          const points = [...settings.points];
                          points[index] = { ...points[index]!, enabled };
                          update({ ...settings, points });
                        }}
                      />
                    </HStack>
                  )}
                </List.ForEach>
              )}
              <Button
                label="添加点位"
                systemImage="plus"
                onPress={addPoint}
              />
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
      </NavigationStack>
    </Host>
  );
}
