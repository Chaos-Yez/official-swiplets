// Swipt 内的状态页。
// 开关本身由快捷指令 / CLI / MCP 调用 Action 完成（见 extension.ts 末尾说明），
// 这里只显示运行状态，避免要求你在游戏之外再点一次屏幕。
import { Host, Text, VStack } from "@expo/ui/swift-ui";
import { useEffect, useState } from "react";
import { actions } from "@swipt/api/swiplet";
import type extension from "./extension";

const { status } = actions<typeof extension>();

export default function App() {
  const [state, setState] = useState("读取中…");

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      status().then(
        (s) => {
          if (!alive) return;
          setState(
            s.running
              ? `运行中 · 本次已点击 ${s.taps} 次`
              : `已停止 · 本次累计 ${s.taps} 次`,
          );
        },
        (error: Error) => {
          if (alive) setState(`状态读取失败：${error.message}`);
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <Host>
      <VStack>
        <Text>洛克王国 · 自动投掷</Text>
        <Text>{state}</Text>
        <Text>开 / 关：快捷指令里的「开始自动投掷」「停止自动投掷」</Text>
        <Text>每 1 秒点一次投掷按钮，随机偏移 ±10px，已避开相邻按钮</Text>
        <Text>目标坐标（2217×1024 参考图）：(1760, 780)</Text>
      </VStack>
    </Host>
  );
}
