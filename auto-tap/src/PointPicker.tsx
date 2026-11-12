// 在游戏截图上点一下，返回相对坐标 (0~1)，并在点选处画出醒目的红色标记。
// iOS 不允许第三方监听其它 App 内的触摸，所以「坐标记录」采用
// 跳转应用 → 抓取当前画面 → 回到设置页 → 在这张图上点选位置。
//
// 显示规则：显示区域统一是竖屏大图。
//   · 竖屏截图：按原方向铺满显示区域。
//   · 横屏截图：顺时针转 90° 后同样是竖屏，铺满同一个显示区域。
// 触摸坐标为「截图原始方向」的归一化坐标：横屏图显示时已转动，所以这里按
// 显示方向反算回去（nx = v、ny = 1 - u），保证记录的坐标与真机点击位置一致。
import { useRef } from "react";
import {
  Image,
  PanResponder,
  StyleSheet,
  Text,
  View,
} from "react-native";

/** 显示区域上限：尽量铺满，不再额外缩小 */
const MAX_WIDTH = 330;
const MAX_HEIGHT = 620;
const RING = 28;

export interface Marker {
  /** 相对坐标 0~1（截图原始方向） */
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
  const safeHeight = height > 0 ? height : Math.round(MAX_WIDTH * 2.1);
  // 横屏图要转 90° 才能竖屏显示：转完之后宽高互换
  const landscape = safeWidth > safeHeight;
  const scale = landscape
    ? Math.min(MAX_WIDTH / safeHeight, MAX_HEIGHT / safeWidth)
    : Math.min(MAX_WIDTH / safeWidth, MAX_HEIGHT / safeHeight);
  const displayWidth = Math.max(1, Math.round((landscape ? safeHeight : safeWidth) * scale));
  const displayHeight = Math.max(1, Math.round((landscape ? safeWidth : safeHeight) * scale));
  // 转动前图片自身在屏幕上的尺寸
  const rawWidth = Math.max(1, Math.round(safeWidth * scale));
  const rawHeight = Math.max(1, Math.round(safeHeight * scale));

  // 标记位置：横屏图显示时整体随图片转动，坐标同样反算
  const mx = marker ? clamp01(marker.x) : 0;
  const my = marker ? clamp01(marker.y) : 0;
  const cx = (landscape ? 1 - my : mx) * displayWidth;
  const cy = (landscape ? mx : my) * displayHeight;

  // 触摸与拖动统一走 PanResponder：按下即定位到触点，按住拖动则按位移实时精确定位。
  // 用 ref 保存最新回调与显示尺寸，避免拖动途中因重渲染重建手势导致中断。
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const sizeRef = useRef({ w: displayWidth, h: displayHeight, rot: landscape });
  sizeRef.current = { w: displayWidth, h: displayHeight, rot: landscape };
  const startRef = useRef({ x: 0, y: 0 });
  const pickAt = (x: number, y: number) => {
    const { w, h, rot } = sizeRef.current;
    const u = clamp01(x / w);
    const v = clamp01(y / h);
    // 竖屏图：显示方向就是原始方向；横屏图（顺时针转过 90°）要转回来
    onPickRef.current(rot ? v : u, rot ? 1 - u : v);
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
      {landscape ? (
        // 横屏图顺时针转 90°：容器按转动后的尺寸居中摆放，旋转绕自身中心
        <View
          style={{
            position: "absolute",
            width: rawWidth,
            height: rawHeight,
            left: (displayWidth - rawWidth) / 2,
            top: (displayHeight - rawHeight) / 2,
            transform: [{ rotate: "90deg" }],
          }}
        >
          <Image
            source={{ uri }}
            // contain：即使上游传来的宽高不准，也只会留边、不会拉伸变形
            resizeMode="contain"
            style={{ width: rawWidth, height: rawHeight }}
          />
        </View>
      ) : (
        <Image
          source={{ uri }}
          resizeMode="contain"
          style={{ width: displayWidth, height: displayHeight }}
        />
      )}

      {marker !== null && (
        // pointerEvents=none：标记只是看的，不挡住继续点选
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View
            style={[
              styles.ring,
              { left: cx - RING / 2, top: cy - RING / 2 },
            ]}
          >
            <View style={styles.dot} />
          </View>
          {label !== "" && (
            <View
              style={[
                styles.badge,
                {
                  left: Math.min(displayWidth - 96, Math.max(0, cx + 16)),
                  top: Math.max(0, cy - 34),
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
