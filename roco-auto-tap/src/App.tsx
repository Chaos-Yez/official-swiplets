// Swipt 内控制页：原生 iOS 设置风格，结构对齐官方 skip-chinese-ads 插件。
// 之前用裸 VStack + 一串蓝色文字按钮，全部挤在顶部且长文案被截断，现改为
// NavigationStack + Toolbar + Form + Section 分组，主操作用 prominent 按钮。
import {
  Button,
  DisclosureGroup,
  Form,
  HStack,
  Host,
  LabeledContent,
  NavigationStack,
  Section,
  Spacer,
  Text,
  Toggle,
  Toolbar,
  ToolbarItem,
  VStack,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  font,
  foregroundStyle,
  monospacedDigit,
  navigationTitle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useCallback, useEffect, useState } from "react";
import { actions, exit, useService } from "@swipt/api/swiplet";
import type extension from "./extension";

const { start, stop, toggle, tapOnce, status } = actions<typeof extension>();
type Snapshot = Awaited<ReturnType<typeof status>>;

const secondary = foregroundStyle({
  type: "hierarchical",
  style: "secondary",
});
const caption = [font({ textStyle: "caption" }), secondary];
const numeric = [font({ textStyle: "body" }), monospacedDigit()];
const headline = font({ textStyle: "headline" });
const bigNumber = [
  font({ textStyle: "title2", weight: "semibold", design: "rounded" }),
  monospacedDigit(),
];

export default function App() {
  const service = useService<typeof extension>();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback(() => {
    status().then(setSnap, (error: Error) => {
      setMessage(`状态读取失败：${error.message}`);
    });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const call = (fn: () => Promise<Snapshot>, label: string) => {
    fn().then(
      (s) => {
        setSnap(s);
        setMessage(`${label} 已完成`);
      },
      (error: Error) => setMessage(`${label} 失败：${error.message}`),
    );
  };

  const running = snap?.running ?? false;
  const taps = snap === null ? "—" : snap.taps.toLocaleString();
  const screen = snap?.screen;
  const point = snap?.point;

  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle("自动投掷")]}>
          <Form>
            <Section
              title="运行状态"
              footer={
                <Text modifiers={caption}>
                  点击次数从插件本次启动开始累计；Swipt 退出后归零。
                </Text>
              }
            >
              <HStack spacing={12}>
                <VStack alignment="leading" spacing={2}>
                  <Text
                    modifiers={[
                      headline,
                      running ? foregroundStyle("green") : secondary,
                    ]}
                  >
                    {snap === null
                      ? "读取中…"
                      : running
                        ? "● 运行中"
                        : "○ 已停止"}
                  </Text>
                  <Text modifiers={caption}>
                    {running
                      ? "每秒一次 · 自动带随机微偏移"
                      : "点下方「开始连点」后立刻切回游戏"}
                  </Text>
                </VStack>
                <Spacer />
                <Text modifiers={bigNumber}>{`${taps} 次`}</Text>
              </HStack>
            </Section>

            <Section
              title="控制"
              footer={
                <Text modifiers={caption}>
                  {message !== ""
                    ? message
                    : "开始后请立刻切回游戏画面；连点在后台运行，切出游戏不会自动停止。"}
                </Text>
              }
            >
              <Button
                label={running ? "停止连点" : "开始连点"}
                systemImage={running ? "stop.fill" : "play.fill"}
                role={running ? "destructive" : "default"}
                onPress={() =>
                  running
                    ? call(() => stop(), "停止")
                    : call(() => start(), "开始")
                }
                modifiers={
                  running
                    ? [buttonStyle("bordered"), tint("red")]
                    : [buttonStyle("borderedProminent"), tint("orange")]
                }
              />
              <Button
                label="测试点击一次"
                systemImage="hand.tap.fill"
                onPress={() => call(() => tapOnce(), "测试")}
              />
              <Button
                label="切换 开 / 关"
                systemImage="arrow.triangle.2.circlepath"
                onPress={() => call(() => toggle(), "切换")}
              />
            </Section>

            <Section
              title="后台服务"
              footer={
                <Text modifiers={caption}>
                  建议开启。若点「开始」后状态不变，先关再开一次，并确认环回 VPN 已连接。
                </Text>
              }
            >
              <Toggle
                label="启用后台服务"
                isOn={service.enabled}
                onIsOnChange={(enabled) => service.setEnabled(enabled)}
              />
              <LabeledContent label="服务状态">
                <Text modifiers={[secondary, monospacedDigit()]}>
                  {service.status}
                </Text>
              </LabeledContent>
              {service.status === "failed" && service.error ? (
                <Text modifiers={caption}>{service.error}</Text>
              ) : null}
            </Section>

            <Section
              title="诊断"
              footer={
                <Text modifiers={caption}>
                  次数在涨但游戏没反应时，把这里的数值发我，可一次定位坐标问题。
                </Text>
              }
            >
              <DisclosureGroup label="设备与坐标">
                <LabeledContent label="屏幕尺寸">
                  <Text modifiers={numeric}>
                    {screen ? `${screen.width} × ${screen.height}` : "尚未读取"}
                  </Text>
                </LabeledContent>
                <LabeledContent label="朝向 / 缩放">
                  <Text modifiers={numeric}>
                    {screen ? `${screen.orientation} · ${screen.scale}×` : "—"}
                  </Text>
                </LabeledContent>
                <LabeledContent label="最近点击点">
                  <Text modifiers={numeric}>
                    {point
                      ? `${Math.round(point[0])}, ${Math.round(point[1])}`
                      : "无"}
                  </Text>
                </LabeledContent>
                <LabeledContent label="设备就绪">
                  <Text modifiers={numeric}>
                    {snap?.deviceReady ? "是" : "否"}
                  </Text>
                </LabeledContent>
                <LabeledContent label="最近错误">
                  <Text modifiers={caption}>{snap?.error || "无"}</Text>
                </LabeledContent>
              </DisclosureGroup>
            </Section>

            <Section
              title="快捷指令 / 轻点背面"
              footer={
                <Text modifiers={caption}>
                  设置 → 辅助功能 → 触控 → 轻点背面：两下绑定「开始自动投掷」，三下绑定「停止自动投掷」。iOS 无法用音量键触发。
                </Text>
              }
            >
              <LabeledContent label="可用动作">
                <Text modifiers={caption}>
                  开始 / 停止 / 切换 / 状态 / 测试
                </Text>
              </LabeledContent>
              <LabeledContent label="投掷目标">
                <Text modifiers={caption}>右下角 · 已避开相邻按钮</Text>
              </LabeledContent>
            </Section>
          </Form>
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
