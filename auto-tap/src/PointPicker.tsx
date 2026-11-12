// 在游戏截图上点一下，返回相对坐标 (0~1)，并在点选处画出醒目的红色标记。
// iOS 不允许第三方监听其它 App 内的触摸，所以「坐标记录」采用
// 跳转应用 → 抓取当前画面 → 回到设置页 → 在这张图上点选位置。
//
// 显示规则：显示区域统一是竖屏大图。
//   · 竖屏截图：按原方向铺满显示区域。
//   · 横屏截图：顺时针转 90° 后同样是竖屏，铺满同一个显示区域。
// 触摸坐标为「截图原始方向」的归一化坐标：横屏图显示时已转动，所以这里按
// 显示方向反算回去（nx = v、ny = 1 - u），保证记录的坐标与真机点击位置一致。
//
// 【红点必须落在手指下面，别再只信 locationX】
// 这个 SwiftUI 宿主里，Pressable 给出的 locationX、locationY 并不保证是
// 「相对本容器」的坐标（实测红点会整体偏移）。所以落点统一走 onPress：
// 先用 locationX/locationY 落一点，再用 pageX/pageY 减掉容器在窗口里的真实
// 位置做自检，两套坐标差得多就按窗口坐标纠正。谁可信就用谁。
//
// 【触摸与红点必须共用同一个「图片显示框」】
// 容器尺寸是按 safeWidth/safeHeight 算的，正常情况图片正好铺满；万一真实
// 图片比例和记录不符，contain 会留边。这里把留边后的显示框（boxX/boxY/
// boxW/boxH）算出来，图片、触摸、红点三者全部按这个框换算，
// 保证「手指点在哪、红点就画在哪、记下的坐标就是那个像素」。
import { useRef } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { GestureResponderEvent } from "react-native";

/** 显示区域上限：尽量铺满，不再额外缩小 */
const MAX_WIDTH = 330;
const MAX_HEIGHT = 620;
const RING = 28;
/** 两套坐标差多少算「偏了」——小于这个值视为同一点，不动，避免把正确的落点改坏 */
const TOLERANCE = 6;

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

  // 转动后（也就是显示方向）图片的宽高比
  const shownW = landscape ? safeHeight : safeWidth;
  const shownH = landscape ? safeWidth : safeHeight;
  const aspect = shownW / shownH;
  // 图片在容器里的实际显示框：先按铺满算，比例不合就按 contain 缩到框内并居中
  let boxW = displayWidth;
  let boxH = displayWidth / aspect;
  if (boxH > displayHeight) {
    boxH = displayHeight;
    boxW = displayHeight * aspect;
  }
  const boxX = (displayWidth - boxW) / 2;
  const boxY = (displayHeight - boxH) / 2;

  // 标记位置：显示框坐标系里，横屏图要跟着图片一起转回来
  const mx = marker ? clamp01(marker.x) : 0;
  const my = marker ? clamp01(marker.y) : 0;
  const cx = boxX + (landscape ? 1 - my : mx) * boxW;
  const cy = boxY + (landscape ? mx : my) * boxH;

  // 回调用 ref 保存最新值：测量是异步回调，避免拿到过期的尺寸/回调
  const boxRef = useRef<View | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const sizeRef = useRef({ w: boxW, h: boxH, x: boxX, y: boxY, rot: landscape });
  sizeRef.current = { w: boxW, h: boxH, x: boxX, y: boxY, rot: landscape };

  const pickAt = (x: number, y: number) => {
    const box = sizeRef.current;
    const u = clamp01((x - box.x) / box.w);
    const v = clamp01((y - box.y) / box.h);
    // 竖屏图：显示方向就是原始方向；横屏图（顺时针转过 90°）要转回来
    onPickRef.current(box.rot ? v : u, box.rot ? 1 - u : v);
  };

  // 只保留「点一下标记」：按下即记录，不再支持拖动红点微调。
  const onPress = (event: GestureResponderEvent) => {
    const { pageX, pageY, locationX, locationY } = event.nativeEvent;
    // 先用 locationX/locationY 落点：多数情况下它就是容器内坐标
    pickAt(locationX, locationY);

    const node = boxRef.current;
    if (node === null) return;
    // 桥接未必实现 measureInWindow：取出来单独判断，缺了就直接用上面的落点
    const measure = (
      node as unknown as {
        measureInWindow?: (
          callback: (x: number, y: number, w: number, h: number) => void,
        ) => void;
      }
    ).measureInWindow;
    if (typeof measure !== "function") return;
    try {
      measure.call(node, (winX: number, winY: number) => {
        if (!Number.isFinite(winX) || !Number.isFinite(winY)) return;
        const lx = pageX - winX;
        const ly = pageY - winY;
        // 算出来跑到容器外面，说明这组测量/页面坐标不可信，保留原来的落点
        if (
          lx < -2 ||
          ly < -2 ||
          lx > displayWidth + 2 ||
          ly > displayHeight + 2
        ) {
          return;
        }
        // 两套坐标基本一致 → locationX 本来就是容器内坐标，不动
        if (
          Math.abs(lx - locationX) <= TOLERANCE &&
          Math.abs(ly - locationY) <= TOLERANCE
        ) {
          return;
        }
        // 偏差明显 → locationX 不是容器内坐标，按窗口坐标重新落点
        pickAt(lx, ly);
      });
    } catch {
      // 桥接不支持 measureInWindow：保留上面的落点
    }
  };

  return (
    <Pressable
      style={{
        width: displayWidth,
        height: displayHeight,
        backgroundColor: "#1C1C1E",
      }}
      onPress={onPress}
    >
      {/* 只用来量容器在窗口里的位置：铺满整块、不接收触摸 */}
      <View ref={boxRef} pointerEvents="none" style={StyleSheet.absoluteFill} />
      {landscape ? (
        // 横屏图顺时针转 90°：先按「转动前」的尺寸摆好，再绕自身中心转
        <View
          style={{
            position: "absolute",
            width: boxH,
            height: boxW,
            left: boxX + (boxW - boxH) / 2,
            top: boxY + (boxH - boxW) / 2,
            transform: [{ rotate: "90deg" }],
          }}
        >
          <Image
            source={{ uri }}
            // contain：即使上游传来的宽高不准，也只会留边、不会拉伸变形
            resizeMode="contain"
            style={{ width: boxH, height: boxW }}
          />
        </View>
      ) : (
        <Image
          source={{ uri }}
          resizeMode="contain"
          style={{
            position: "absolute",
            left: boxX,
            top: boxY,
            width: boxW,
            height: boxH,
          }}
        />
      )}

      {marker !== null && (
        // pointerEvents=none：标记只是看的，不挡住继续点选
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <View
            style={[styles.ring, { left: cx - RING / 2, top: cy - RING / 2 }]}
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
    </Pressable>
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
