// 在游戏截图上点一下，返回相对坐标 (0~1)。
// iOS 不允许第三方监听其它 App 内的触摸，所以「坐标记录」采用
// 跳转游戏 → 抓取当前画面 → 回到设置页 → 在这张图上点选位置。
import { Image, Pressable } from "react-native";

const DISPLAY_WIDTH = 320;

export function PointPicker({
  uri,
  width,
  height,
  onPick,
}: {
  uri: string;
  width: number;
  height: number;
  onPick: (nx: number, ny: number) => void;
}) {
  const displayHeight =
    width > 0 && height > 0
      ? Math.round((DISPLAY_WIDTH * height) / width)
      : Math.round(DISPLAY_WIDTH * 0.46);
  return (
    <Pressable
      onPress={(event) => {
        const { locationX, locationY } = event.nativeEvent;
        onPick(
          Math.min(1, Math.max(0, locationX / DISPLAY_WIDTH)),
          Math.min(1, Math.max(0, locationY / displayHeight)),
        );
      }}
    >
      <Image
        source={{ uri }}
        resizeMode="stretch"
        style={{ width: DISPLAY_WIDTH, height: displayHeight }}
      />
    </Pressable>
  );
}
