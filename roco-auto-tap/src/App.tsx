// 极简控制页：一个「开始连点」按钮 + 原来开关位置的状态行。
// 连点全程在 extension.ts 的 start Action 内 await，Action 结束（自动停止）
// 后才 resolve，届时把运行结果显示在这里，便于定位问题。
import {
  Button,
  Form,
  Host,
  LabeledContent,
  NavigationStack,
  Section,
  Text,
  Toolbar,
  ToolbarItem,
} from "@expo/ui/swift-ui";
import {
  buttonStyle,
  font,
  foregroundStyle,
  navigationTitle,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { useState } from "react";
import { actions, exit, useService } from "@swipt/api/swiplet";
import type extension from "./extension";

const { start } = actions<typeof extension>();

const caption = [
  font({ textStyle: "caption" }),
  foregroundStyle({ type: "hierarchical", style: "secondary" }),
];

const hint =
  "点「开始连点」会自动跳转到洛克王国并立即开始每秒点击一次投掷按钮；" +
  "切换应用或拉下控制中心会自动停止。回到本页可查看运行结果与诊断信息。";

type Phase = "idle" | "running" | "done" | "failed";
const phaseText: Record<Phase, string> = {
  idle: "待机",
  running: "运行中",
  done: "已停止",
  failed: "启动失败",
};

export default function App() {
  const service = useService<typeof extension>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  const serviceText =
    service.status === "running"
      ? "运行中"
      : service.status === "failed"
        ? `异常：${service.error ?? "未知错误"}`
        : service.status === "stopped"
          ? "已停止"
          : "启动中";

  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle("自动投掷")]}>
          <Form>
            <Section
              footer={
                <Text modifiers={caption}>
                  {detail === "" ? hint : detail}
                </Text>
              }
            >
              {/* 原「后台服务」开关位置：改成只读状态，开关由 Swipt 自身托管 */}
              <LabeledContent label="后台服务">
                <Text modifiers={caption}>{serviceText}</Text>
              </LabeledContent>
              <LabeledContent label="连点状态">
                <Text>{phaseText[phase]}</Text>
              </LabeledContent>
              <Button
                label="开始连点"
                systemImage="play.fill"
                onPress={() => {
                  if (busy) return;
                  setBusy(true);
                  setPhase("running");
                  setDetail("正在跳转游戏并开始连点…");
                  start().then(
                    (report) => {
                      setBusy(false);
                      setPhase("done");
                      setDetail(
                        `点击 ${report.taps} 次 · ${report.stopReason}\n` +
                          `屏幕 ${report.screen}\n` +
                          `点击点 (${report.point})\n` +
                          `前台 ${report.front}` +
                          (report.lastError === ""
                            ? ""
                            : `\n错误：${report.lastError}`),
                      );
                    },
                    (error: Error) => {
                      setBusy(false);
                      setPhase("failed");
                      setDetail(error.message);
                    },
                  );
                }}
                modifiers={[buttonStyle("borderedProminent"), tint("orange")]}
              />
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
