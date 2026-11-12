// 在游戏截图上点一下，返回相对坐标 (0~1)，并在点选处画出醒目的红色标记。
// iOS 不允许第三方监听其它 App 内的触摸，所以「坐标记录」采用
// 跳转应用 → 抓取当前画面 → 回到设置页 → 在这张图上点选位置。
//
// 图片按真实像素比例等比缩放：宽、高各设上限，用 contain 渲染。
// 这样竖屏截图不会被硬拉成 320×数百的怪异形状，横屏效果保持不变。
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

/** 显示区域的两个上限，取较小的缩放比，保证任何方向上都不变形 */
const MAX_WIDTH = 320;
const MAX_HEIGHT = 300;
const RING = 28;

export interface Marker {
  /** 相对坐标 0~1 */
  x: number;
  y: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function PointPicker({
  uri,
  width,
  height,
  marker,
  label,
  onPick,
}: {
  uri: string;
  /** 图片真实像素宽高（由设置页读取文件得到） */
  width: number;
  height: number;
  marker: Marker | null;
  label: string;
  onPick: (nx: number, ny: number) => void;
}) {
  const safeWidth = width > 0 ? width : MAX_WIDTH;
  const safeHeight = height > 0 ? height : Math.round(MAX_WIDTH * 0.46);
  const scale = Math.min(MAX_WIDTH / safeWidth, MAX_HEIGHT / safeHeight);
  const displayWidth = Math.max(1, Math.round(safeWidth * scale));
  const displayHeight = Math.max(1, Math.round(safeHeight * scale));
  const mx = marker ? clamp01(marker.x) * displayWidth : 0;
  const my = marker ? clamp01(marker.y) * displayHeight : 0;

  return (
    <View
      style={{
        width: displayWidth,
        height: displayHeight,
        backgroundColor: "#1C1C1E",
      }}
    >
      <Pressable
        onPress={(event) => {
          const { locationX, locationY } = event.nativeEvent;
          onPick(
            clamp01(locationX / displayWidth),
            clamp01(locationY / displayHeight),
          );
        }}
      >
        <Image
          source={{ uri }}
          // contain：即使上游传来的宽高不准，也只会留边、不会拉伸变形
          resizeMode="contain"
          style={{ width: displayWidth, height: displayHeight }}
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
                  left: Math.min(displayWidth - 96, Math.max(0, mx + 16)),
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
