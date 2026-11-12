// 在游戏截图上点一下，返回相对坐标 (0~1)，并在点选处画出醒目的红色标记。
// iOS 不允许第三方监听其它 App 内的触摸，所以「坐标记录」采用
// 跳转应用 → 抓取当前画面 → 回到设置页 → 在这张图上点选位置。
//
// 图片按真实像素比例等比缩放：宽、高各设上限，用 contain 渲染。
// 这样竖屏截图不会被硬拉成 320×数百的怪异形状，横屏效果保持不变。
import { useRef } from "react";
import { Image, PanResponder, StyleSheet, Text, View } from "react-native";

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

  // 触摸与拖动统一走 PanResponder：按下即定位到触点，按住拖动则按位移实时精确定位。
  // 用 ref 保存最新回调与显示尺寸，避免拖动途中因重渲染重建手势导致中断。
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const sizeRef = useRef({ w: displayWidth, h: displayHeight });
  sizeRef.current = { w: displayWidth, h: displayHeight };
  const startRef = useRef({ x: 0, y: 0 });
  const pickAt = (x: number, y: number) => {
    const { w, h } = sizeRef.current;
    onPickRef.current(clamp01(x / w), clamp01(y / h));
  };
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        const { locationX, locationY } = event.nativeEvent;
        startRef.current = { x: locationX, y: locationY };
        pickAt(locationX, locationY);
      },
      onPanResponderMove: (_event, gesture) => {
        pickAt(
          startRef.current.x + gesture.dx,
          startRef.current.y + gesture.dy,
        );
      },
    }),
  ).current;

  return (
    <View
      style={{
        width: displayWidth,
        height: displayHeight,
        backgroundColor: "#1C1C1E",
      }}
      {...panResponder.panHandlers}
    >
      <Image
        source={{ uri }}
        // contain：即使上游传来的宽高不准，也只会留边、不会拉伸变形
        resizeMode="contain"
        style={{ width: displayWidth, height: displayHeight }}
      />

      {marker !== null && (
        // pointerEvents=none：标记只是看的，不挡住继续点选
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View
            style={[styles.ring, { left: mx - RING / 2, top: my - RING / 2 }]}
          >
            <View style={styles.dot} />
          </View>
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
  // 简洁单环：红圈 + 中心红点，深浅画面上都醒目，且尽量不遮挡画面
  ring: {
    position: "absolute",
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 2.5,
    borderColor: "#FF2D2D",
    backgroundColor: "rgba(255, 45, 45, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FF2D2D",
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
