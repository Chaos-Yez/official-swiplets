// Swipt 内的控制页：装好插件后必须在这里（或快捷指令）点一次「开始」才会连点。
import { Button, Host, Text, Toggle, VStack } from "@expo/ui/swift-ui";
import { useCallback, useEffect, useState } from "react";
import { actions, useService } from "@swipt/api/swiplet";
import type extension from "./extension";

const { start, stop, toggle, tapOnce, status } = actions<typeof extension>();
type Snapshot = Awaited<ReturnType<typeof status>>;

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

  return (
    <Host>
      <VStack>
        <Text>洛克王国 · 自动投掷</Text>
        <Toggle
          label="后台服务（建议打开）"
          isOn={service.enabled}
          onIsOnChange={(enabled) => service.setEnabled(enabled)}
        />
        <Text>
          {`服务状态：${service.status}${service.error ? ` / ${service.error}` : ""}`}
        </Text>

        <Button label="开始（连点）" onPress={() => call(() => start(), "开始")} />
        <Button label="停止" onPress={() => call(() => stop(), "停止")} />
        <Button label="切换 开/关" onPress={() => call(() => toggle(), "切换")} />
        <Button
          label="测试点击一次"
          onPress={() => call(() => tapOnce(), "测试")}
        />

        <Text>
          {snap === null
            ? "读取中…"
            : snap.running
              ? `运行中 · 本次已点击 ${snap.taps} 次`
              : `已停止 · 本次累计 ${snap.taps} 次`}
        </Text>
        <Text>{`错误：${snap?.error || "无"}`}</Text>
        <Text>
          {snap?.screen
            ? `屏幕：${snap.screen.width}×${snap.screen.height} ${snap.screen.orientation} scale=${snap.screen.scale}`
            : "屏幕：尚未读取（点一次「测试点击一次」）"}
        </Text>
        <Text>
          {snap?.point
            ? `最近点击点：${Math.round(snap.point[0])}, ${Math.round(snap.point[1])}`
            : "最近点击点：无"}
        </Text>
        {message !== "" ? <Text>{message}</Text> : null}

        <Text>点「开始」后请立刻切回游戏画面；连点在后台每秒一次。</Text>
        <Text>也可在快捷指令 / 轻点背面里搜索「自动投掷」绑定开关。</Text>
      </VStack>
    </Host>
  );
}
