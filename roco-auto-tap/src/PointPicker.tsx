// 在游戏截图上点一下，返回相对坐标 (0~1)，并在点选处画出醒目的红色标记。
// iOS 不允许第三方监听其它 App 内的触摸，所以「坐标记录」采用
// 跳转游戏 → 抓取当前画面 → 回到设置页 → 在这张图上点选位置。
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

const DISPLAY_WIDTH = 320;
const RING = 28;

export interface Marker {
  /** 相对坐标 0~1 */
  x: number;
  y: number;
}

export function PointPicker({
  uri,
  width,
  height,
  marker,
  label,
  onPick,
}: {
  uri: string;
  width: number;
  height: number;
  marker: Marker | null;
  label: string;
  onPick: (nx: number, ny: number) => void;
}) {
  const displayHeight =
    width > 0 && height > 0
      ? Math.round((DISPLAY_WIDTH * height) / width)
      : Math.round(DISPLAY_WIDTH * 0.46);
  const mx = marker
    ? Math.min(1, Math.max(0, marker.x)) * DISPLAY_WIDTH
    : 0;
  const my = marker
    ? Math.min(1, Math.max(0, marker.y)) * displayHeight
    : 0;

  return (
    <View style={{ width: DISPLAY_WIDTH, height: displayHeight }}>
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

      {marker !== null && (
        // pointerEvents=none：标记只是看的，不挡住继续点选
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View style={[styles.crossH, { top: my - 0.5 }]} />
          <View style={[styles.crossV, { left: mx - 0.5 }]} />
          <View
            style={[
              styles.ringOuter,
              { left: mx - RING / 2, top: my - RING / 2 },
            ]}
          >
            <View style={styles.ringInner} />
          </View>
          <View style={[styles.dot, { left: mx - 3, top: my - 3 }]} />
          {label !== "" && (
            <View
              style={[
                styles.badge,
                {
                  left: Math.min(DISPLAY_WIDTH - 96, Math.max(0, mx + 16)),
                  top: Math.max(0, my - 34),
                },
              ]}
            >
              <Text style={styles.badgeText}>{label}</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // 红色十字线贯穿整张图，方便对齐要点的位置
  crossH: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(255, 45, 45, 0.9)",
  },
  crossV: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: "rgba(255, 45, 45, 0.9)",
  },
  // 外白内红双环，深浅画面上都醒目
  ringOuter: {
    position: "absolute",
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 3,
    borderColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  ringInner: {
    width: RING - 10,
    height: RING - 10,
    borderRadius: (RING - 10) / 2,
    borderWidth: 3,
    borderColor: "#FF2D2D",
  },
  dot: {
    position: "absolute",
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FF2D2D",
    borderWidth: 1,
    borderColor: "#FFFFFF",
  },
  badge: {
    position: "absolute",
    backgroundColor: "#FF2D2D",
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "bold",
  },
});
