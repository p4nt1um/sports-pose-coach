/**
 * tpc-signals.js — 特征层：把关键点转成「动作无关」的一维信号
 *
 * 为什么单独一层：
 *  1) 状态机不该认识关键点索引。它只吃一维数值（膝角、髋高、脚距…），
 *     于是同一套状态机代码能驱动所有计数动作，阈值全部来自 data/exercises.json。
 *  2) 这层是纯函数式的（输入关键点 → 输出数值），node 里可以直接喂合成信号做回归，
 *     不需要摄像头、不需要模型。计数准不准这件事因此变得可测。
 *
 * 坐标系的选择不是随手定的：
 *  - 关节类（jointAngle / torsoLean）默认用 **worldLandmarks（米制）**：
 *    关节角本身与拍摄距离无关，用世界坐标更抗透视畸变，阈值可跨人通用。
 *  - 位置类（pointHeight / spread）默认用 **图像坐标**：
 *    它们依赖"画面上 下 左 右"的语义，用归一化坐标才有稳定含义。
 *    再用同一坐标系里的一段长度（如腿长、肩宽）做归一化，消除距离影响。
 *
 * 左右侧的取法（side）是深蹲这类动作的关键：
 *  - "left"/"right" 取单侧
 *  - "min"/"max"/"mean" 两侧各算一次再归约
 *  侧拍时远侧腿常被遮挡，用 min（两膝取更小的角）比取平均稳得多。
 */

import { jointAngle, distance, midpoint, torsoInclination, clamp } from './tpc-math.js';
import { OneEuroFilter } from './tpc-filter.js';

/** 左右镜像配对表：用于把「左」索引换算成「右」索引 */
const MIRROR = {
  11: 12, 12: 11,   // 肩
  13: 14, 14: 13,   // 肘
  15: 16, 16: 15,   // 腕
  17: 18, 18: 17,
  19: 20, 20: 19,
  21: 22, 22: 21,
  23: 24, 24: 23,   // 髋
  25: 26, 26: 25,   // 膝
  27: 28, 28: 27,   // 踝
  29: 30, 30: 29,   // 脚跟
  31: 32, 32: 31,   // 脚尖
};

export function mirrorIndex(i) {
  return MIRROR[i] !== undefined ? MIRROR[i] : i;
}

/** side 展开成需要计算的侧别列表 */
function sideList(side) {
  switch (side) {
    case 'left': return ['L'];
    case 'right': return ['R'];
    default: return ['L', 'R'];   // min / max / mean 都要算两侧
  }
}

function reduce(values, side) {
  const v = values.filter((x) => x !== null && x !== undefined && isFinite(x));
  if (!v.length) return null;
  switch (side) {
    case 'left': return v[0];
    case 'right': return v[0];
    case 'min': return Math.min.apply(null, v);
    case 'max': return Math.max.apply(null, v);
    case 'mean': return v.reduce((a, b) => a + b, 0) / v.length;
    default: return Math.min.apply(null, v);
  }
}

/** 取某点在某坐标系下的位置；缺失或不可信返回 null */
function pointAt(pose, space, idx) {
  const arr = space === 'world' ? pose.worldLandmarks : pose.landmarks;
  if (!arr || !arr[idx]) return null;
  return arr[idx];
}

/** 关键点可信度：优先用图像坐标的 visibility（world 也带，但图像侧更直观） */
function visOf(pose, idx) {
  const p = (pose.landmarks && pose.landmarks[idx]) || (pose.worldLandmarks && pose.worldLandmarks[idx]);
  if (!p) return 0;
  return p.visibility == null ? 1 : p.visibility;
}

function minVis(pose, idxs) {
  let m = 1;
  for (const i of idxs) m = Math.min(m, visOf(pose, i));
  return m;
}

/** 取一组点的均值坐标 */
function centroid(pose, space, idxs) {
  let x = 0, y = 0, z = 0, n = 0;
  for (const i of idxs) {
    const p = pointAt(pose, space, i);
    if (!p) return null;
    x += p.x; y += p.y; z += p.z || 0; n++;
  }
  if (!n) return null;
  return { x: x / n, y: y / n, z: z / n };
}

/* ------------------------------------------------------------------ *
 * 信号类型注册表
 * 每个求值器签名：(def, pose) => { value: number|null, conf: number }
 * 新增动作类型时在这里加原语，而不是去改状态机。
 * ------------------------------------------------------------------ */

export const SIGNAL_TYPES = {
  /** 三点夹角。chain 用「左」侧索引书写，side 决定取哪侧 */
  jointAngle(def, pose) {
    const space = def.space || 'world';
    const sides = sideList(def.side || 'min');
    const vals = [];
    let conf = 1;
    for (const s of sides) {
      const a = s === 'R' ? mirrorIndex(def.chain[0]) : def.chain[0];
      const b = s === 'R' ? mirrorIndex(def.chain[1]) : def.chain[1];
      const c = s === 'R' ? mirrorIndex(def.chain[2]) : def.chain[2];
      const lm = space === 'world' ? pose.worldLandmarks : pose.landmarks;
      let v = null;
      if (lm && lm[a] && lm[b] && lm[c]) v = jointAngle(lm, a, b, c);
      vals.push(v);
      conf = Math.min(conf, minVis(pose, [a, b, c]));
    }
    return { value: reduce(vals, def.side || 'min'), conf };
  },

  /** 某点相对参考点组的归一化高度。图像坐标 y 向下 → 值越大表示越靠下 */
  pointHeight(def, pose) {
    const space = def.space || 'image';
    const p = pointAt(pose, space, def.point);
    const ref = centroid(pose, space, def.refPoints);
    if (!p || !ref) return { value: null, conf: 0 };
    const scale = resolveScale(def.scale, pose, space, [def.point].concat(def.refPoints));
    if (!scale) return { value: null, conf: 0 };
    const idxs = [def.point].concat(def.refPoints);
    return { value: (p.y - ref.y) / scale, conf: minVis(pose, idxs) };
  },

  /** 两点间距，用某段人体长度归一化。开合跳用它看踝间距 / 肩宽 */
  spread(def, pose) {
    const space = def.space || 'image';
    const sides = sideList(def.side || 'min');
    const vals = [];
    let conf = 1;
    for (const s of sides) {
      const a = s === 'R' ? mirrorIndex(def.a[0]) : def.a[0];
      const b = s === 'R' ? mirrorIndex(def.b[0]) : def.b[0];
      const pa = pointAt(pose, space, a);
      const pb = pointAt(pose, space, b);
      if (!pa || !pb) { vals.push(null); conf = 0; continue; }
      const scale = resolveScale(def.scale, pose, space, [a, b]);
      vals.push(scale ? distance(pa, pb) / scale : null);
      conf = Math.min(conf, minVis(pose, [a, b]));
    }
    return { value: reduce(vals, def.side || 'min'), conf };
  },

  /**
   * 躯干倾角（度）。同一个物理量的两种读法，靠 def.from 选：
   *   from:'vertical'（默认）→ 与垂直轴的夹角：站立≈0、躺平≈90。
   *                            深蹲/马步/静蹲判「躯干是否直立」、仰卧起坐判「是否躺平」用它。
   *   from:'horizontal'       → 与水平面的夹角：躺平≈0、直立≈90。
   *                            俯卧撑判「身体是否成一条直线」用它更直观。
   * 两种都在这里换算，避免各动作各写一套 90-x。
   */
  torsoLean(def, pose) {
    const lm = pose.landmarks;
    if (!lm) return { value: null, conf: 0 };
    const v = torsoInclination(lm);
    if (v === null) return { value: null, conf: 0 };
    return {
      value: def.from === 'horizontal' ? 90 - v : v,
      conf: minVis(pose, [11, 12, 23, 24]),
    };
  },
};

/** scale 解析：既支持关键字（用人体自身长度做归一化），也支持直接给数字 */
function resolveScale(scale, pose, space, fallbackIdxs) {
  if (typeof scale === 'number') return scale > 0 ? scale : null;
  const pick = (i, j) => {
    const a = pointAt(pose, space, i);
    const b = pointAt(pose, space, j);
    if (!a || !b) return null;
    return distance(a, b);
  };
  let v = null;
  switch (scale) {
    case 'legLength': v = pick(23, 27); break;
    case 'torsoLength': {
      const s = centroid(pose, space, [11, 12]);
      const h = centroid(pose, space, [23, 24]);
      v = s && h ? distance(s, h) : null;
      break;
    }
    case 'shoulderWidth': v = pick(11, 12); break;
    case 'hipWidth': v = pick(23, 24); break;
    case 'kneeToAnkle': v = pick(25, 27); break;
    default: v = null;
  }
  // 人体自身长度太小（关键点抖动/遮挡导致退化）时，视作无效，避免放大噪声
  if (v === null || v < 1e-6) {
    // 退化时退回：若给了 fallback 点对，用它们的间距兜底
    if (fallbackIdxs && fallbackIdxs.length >= 2) {
      const fb = pick(fallbackIdxs[0], fallbackIdxs[1]);
      if (fb && fb > 1e-6) return fb;
    }
    return null;
  }
  return v;
}

/* ------------------------------------------------------------------ *
 * SignalSet：按配置算出一组信号，并统一处理平滑与速度
 * ------------------------------------------------------------------ */

export class SignalSet {
  /**
   * @param {object} defs 形如 { kneeAngleMin: { type:'jointAngle', chain:[23,25,27], side:'min' } }
   */
  constructor(defs = {}) {
    this.defs = defs;
    this.names = Object.keys(defs);
    /** 每个信号的平滑器与状态 */
    this.state = {};
    this.reset();
  }

  reset() {
    this.state = {};
    for (const name of this.names) {
      const def = this.defs[name];
      const st = { filter: null, last: null, lastAt: 0, vel: null, velAt: 0 };
      if (def.smooth) {
        st.filter = new OneEuroFilter(
          def.smooth.minCutoff == null ? 1.0 : def.smooth.minCutoff,
          def.smooth.beta == null ? 0.007 : def.smooth.beta
        );
      }
      this.state[name] = st;
    }
  }

  /**
   * @param {object} pose {landmarks, worldLandmarks}
   * @param {number} tMs
   * @returns {{values:object, confidence:object}}
   */
  evaluate(pose, tMs) {
    const values = {};
    const confidence = {};

    for (const name of this.names) {
      const def = this.defs[name];
      const fn = SIGNAL_TYPES[def.type];
      const st = this.state[name];
      if (!fn) {
        values[name] = null;
        confidence[name] = 0;
        continue;
      }

      let { value, conf } = fn(def, pose);

      // 信号级平滑。注意：关键点已经在引擎层被 PoseFilter 平滑过，
      // 这里是第二道（可选）—— 调试台用它来对比"抖动 vs 延迟"的取舍。
      if (value !== null && st.filter) {
        value = st.filter.filter(value, tMs / 1000);
      }

      values[name] = value === null || !isFinite(value) ? null : value;
      confidence[name] = conf;

      // 速度：有限差分 + 轻 EMA。高抬腿的峰谷检测要用它
      if (def.velocity && value !== null) {
        const dt = st.velAt ? (tMs - st.velAt) / 1000 : 0;
        if (dt > 1e-4 && st.last !== null) {
          const raw = (value - st.last) / dt;
          st.vel = st.vel === null ? raw : st.vel + (raw - st.vel) * 0.35;
        }
        st.velAt = tMs;
        values[name + 'Vel'] = st.vel;
      }
      if (value !== null) { st.last = value; st.lastAt = tMs; }
    }

    return { values, confidence };
  }
}
