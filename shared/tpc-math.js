/**
 * tpc-math.js — 几何与运动学工具
 *
 * 约定：
 *  - landmark 形如 { x, y, z, visibility }
 *  - 图像坐标 landmarks：x,y ∈ [0,1]（y 向下为正），z 为相对深度
 *  - 世界坐标 worldLandmarks：米制 3D，原点在两髋中点
 *  - 所有"角度"函数返回度数（0-180）
 *
 * 设计要点：角度与比值计算刻意避开对坐标轴正负的依赖
 * （例如躯干倾角用 |vy| 求与垂直轴的夹角），
 * 这样无论世界坐标的 y 轴朝上还是朝下都得到同一结果。
 */

export const RAD2DEG = 180 / Math.PI;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
}

export function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z || 0) + (b.z || 0)) / 2,
  };
}

/** 两点距离 */
export function distance(a, b) {
  return length(sub(a, b));
}

/**
 * 三点夹角，b 为顶点。返回度数。
 * 例：jointAngle(lm, 23, 25, 27) = 左髋-左膝-左踝 的膝角
 */
export function jointAngle(lm, ia, ib, ic) {
  const a = lm[ia], b = lm[ib], c = lm[ic];
  if (!a || !b || !c) return null;
  const v1 = sub(a, b);
  const v2 = sub(c, b);
  const n1 = length(v1);
  const n2 = length(v2);
  if (n1 < 1e-9 || n2 < 1e-9) return null;
  return Math.acos(clamp(dot(v1, v2) / (n1 * n2), -1, 1)) * RAD2DEG;
}

/** 向量与垂直轴的夹角（0-90 度），与 y 轴正负无关 */
export function tiltFromVertical(a, b) {
  const v = sub(a, b);
  const len = length(v);
  if (len < 1e-9) return null;
  return Math.acos(clamp(Math.abs(v.y) / len, -1, 1)) * RAD2DEG;
}

/**
 * 人体尺度。所有动作阈值都应除以这里的量再比较，
 * 从而与身高、拍摄距离解耦。
 * 传入世界坐标（米）时结果有物理意义；传入图像坐标时只作为无量纲比例使用。
 */
export function bodyMetrics(lm) {
  const m = {};
  const need = [11, 12, 23, 24, 25, 26, 27, 28];
  for (const i of need) {
    if (!lm[i]) return null;
  }
  m.shoulderWidth = distance(lm[11], lm[12]);
  m.hipWidth = distance(lm[23], lm[24]);
  m.torsoLength = distance(midpoint(lm[11], lm[12]), midpoint(lm[23], lm[24]));
  m.thighL = distance(lm[23], lm[25]);
  m.thighR = distance(lm[24], lm[26]);
  m.shankL = distance(lm[25], lm[27]);
  m.shankR = distance(lm[26], lm[28]);
  m.legL = m.thighL + m.shankL;
  m.legR = m.thighR + m.shankR;
  m.armL = lm[13] && lm[15] ? distance(lm[11], lm[13]) + distance(lm[13], lm[15]) : null;
  m.armR = lm[14] && lm[16] ? distance(lm[12], lm[14]) + distance(lm[14], lm[16]) : null;
  m.refLength = m.torsoLength > 1e-6 ? m.torsoLength : 1;
  m.refWidth = m.shoulderWidth > 1e-6 ? m.shoulderWidth : 1;
  return m;
}

/** 躯干相对垂直轴的倾角（度）。前倾/后仰/侧倾都算在内 */
export function torsoInclination(lm) {
  const sh = lm[11] && lm[12] ? midpoint(lm[11], lm[12]) : null;
  const hp = lm[23] && lm[24] ? midpoint(lm[23], lm[24]) : null;
  if (!sh || !hp) return null;
  return tiltFromVertical(sh, hp);
}

/** 躯干相对水平面的夹角（度）。仰卧起坐判定用：贴地≈0，坐起≈90 */
export function torsoFromHorizontal(lm) {
  const t = torsoInclination(lm);
  return t == null ? null : 90 - t;
}

/** 统计可见度达标的关键点数量 */
export function countVisible(lm, threshold) {
  if (!lm) return 0;
  const th = threshold == null ? 0.5 : threshold;
  let n = 0;
  for (const p of lm) {
    if ((p.visibility == null ? 1 : p.visibility) >= th) n++;
  }
  return n;
}

/** 指定关键点是否全部可信 */
export function allVisible(lm, indices, threshold) {
  const th = threshold == null ? 0.5 : threshold;
  for (const i of indices) {
    const p = lm[i];
    if (!p) return false;
    if ((p.visibility == null ? 1 : p.visibility) < th) return false;
  }
  return true;
}

/**
 * 镜像判定：MediaPipe 的 left/right 是"本人的左右"。
 * 当画面为镜像（自拍视角）时，本人的左肩在画面右侧。
 * 返回 true 表示当前画面的左肩确实在左侧（即非镜像或已翻转）。
 */
export function isEgoLeftOnScreenLeft(lm) {
  if (!lm[11] || !lm[12]) return null;
  return lm[11].x < lm[12].x;
}

/** 两点在画面上的水平间距与垂直间距（图像坐标） */
export function screenDelta(a, b) {
  return { dx: b.x - a.x, dy: b.y - a.y };
}

/** 取绝对值最大的分量，用于"高度差"类判定 */
export function verticalSpan(lm, ia, ib) {
  if (!lm[ia] || !lm[ib]) return null;
  return Math.abs(lm[ia].y - lm[ib].y);
}
