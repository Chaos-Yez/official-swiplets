// 极简控制页：只有一个「开始连点」按钮。
// 跳转游戏、连点、自动停止全部在 extension.ts 的 start Action 内完成。
import {
  Button,
  Form,
  Host,
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
import { actions, exit } from "@swipt/api/swiplet";
import type extension from "./extension";

const { start } = actions<typeof extension>();

const caption = [
  font({ textStyle: "caption" }),
  foregroundStyle({ type: "hierarchical", style: "secondary" }),
];

const hint =
  "点「开始连点」会自动跳转到洛克王国并立即开始每秒点击一次投掷按钮；" +
  "切换应用或拉下控制中心会自动停止。";

export default function App() {
  const [error, setError] = useState("");

  return (
    <Host style={{ flex: 1 }}>
      <NavigationStack>
        <Toolbar modifiers={[navigationTitle("自动投掷")]}>
          <Form>
            <Section
              footer={
                <Text modifiers={caption}>
                  {error === "" ? hint : `启动失败：${error}`}
                </Text>
              }
            >
              <Button
                label="开始连点"
                systemImage="play.fill"
                onPress={() => {
                  setError("");
                  start().catch((e: Error) => setError(e.message));
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
