/**
 * tpc-filter.js — 关键点平滑
 *
 * 用 One Euro Filter（Casiez et al. 2012）。选它而不是指数平滑（EMA）的原因：
 *   EMA 的平滑强度是固定的 —— 参数调大则静止时稳、运动时严重滞后；
 *   调小则运动跟得上、静止时抖。而静止抖动恰恰是计数误判的主因，
 *   运动滞后又会让峰值检测漏掉高抬腿这类快动作。
 *   One Euro 让截止频率随速度自适应：慢时强滤波，快时弱滤波。
 *
 * 参考：https://cristal.univ-lille.fr/~casiez/1euro/
 */

function alphaOf(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

class LowPass {
  constructor() { this.y = null; }
  filter(x, alpha) {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  reset() { this.y = null; }
}

export class OneEuroFilter {
  /**
   * @param {number} minCutoff 静止时的截止频率（Hz）。越小越稳、越迟钝
   * @param {number} beta      速度耦合系数。越大则运动中越跟手
   * @param {number} dCutoff   速度信号的截止频率（Hz）
   */
  constructor(minCutoff = 1.0, beta = 8.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xf = new LowPass();
    this.dxf = new LowPass();
  }

  reset() {
    this.xf.reset();
    this.dxf.reset();
  }

  /** @param {number} dt 与上一次调用的时间差，单位秒 */
  filter(x, dt) {
    if (!isFinite(x)) return this.xf.y;
    if (!isFinite(dt) || dt <= 0) dt = 1 / 30;
    if (dt > 0.5) dt = 1 / 30; // 长间隔（丢帧/切页）后不信任速度估计
    const prev = this.xf.y;
    const dValue = prev === null ? 0 : (x - prev) / dt;
    const edValue = this.dxf.filter(dValue, alphaOf(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edValue);
    return this.xf.filter(x, alphaOf(cutoff, dt));
  }
}

/**
 * 对一名被检测者的全部关键点做平滑。
 *
 * 图像坐标与世界坐标分别用不同参数：两者的数值量级差一个数量级
 * （图像坐标 0-1，世界坐标以米计），若共用一个 beta，其中一路必然失准。
 */
export class PoseFilter {
  constructor(opts = {}) {
    this.cfg = {
      image: { minCutoff: 1.0, beta: 8.0 },
      world: { minCutoff: 1.0, beta: 0.6 },
      visibility: { minCutoff: 0.6, beta: 0.2 },
      enabled: true,
      ...opts,
    };
    this.imgFilters = [];
    this.wldFilters = [];
    this.visFilters = [];
    this.lastT = null;
  }

  reset() {
    for (const f of this.imgFilters) f.reset();
    for (const f of this.wldFilters) f.reset();
    for (const f of this.visFilters) f.reset();
    this.lastT = null;
  }

  _ensure(arr, n, kind) {
    while (arr.length < n) {
      const c = this.cfg[kind];
      arr.push([new OneEuroFilter(c.minCutoff, c.beta), new OneEuroFilter(c.minCutoff, c.beta), new OneEuroFilter(c.minCutoff, c.beta)]);
    }
    return arr;
  }

  /**
   * @param {{landmarks:Array, worldLandmarks:Array}} pose
   * @param {number} timestampMs
   * @returns {{landmarks:Array, worldLandmarks:Array}} 平滑后的新对象
   */
  filter(pose, timestampMs) {
    if (!this.cfg.enabled || !pose || !pose.landmarks) return pose;

    const dt = this.lastT === null ? 1 / 30 : (timestampMs - this.lastT) / 1000;
    this.lastT = timestampMs;

    const src = pose.landmarks;
    const outImg = this._apply(src, this.imgFilters, 'image', dt, true);
    let outWld = pose.worldLandmarks;
    if (pose.worldLandmarks && pose.worldLandmarks.length) {
      outWld = this._apply(pose.worldLandmarks, this.wldFilters, 'world', dt, false);
    }
    return { ...pose, landmarks: outImg, worldLandmarks: outWld };
  }

  _apply(src, cache, kind, dt, smoothVisibility) {
    const filters = this._ensure(cache, src.length, kind);
    const out = new Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      const f = filters[i];
      const x = f[0].filter(p.x, dt);
      const y = f[1].filter(p.y, dt);
      const z = f[2].filter(p.z == null ? 0 : p.z, dt);
      let vis = p.visibility;
      if (smoothVisibility) {
        if (!this.visFilters[i]) {
          this.visFilters[i] = new OneEuroFilter(this.cfg.visibility.minCutoff, this.cfg.visibility.beta);
        }
        vis = this.visFilters[i].filter(p.visibility == null ? 1 : p.visibility, dt);
      }
      out[i] = {
        x, y, z,
        visibility: vis,
        presence: p.presence,
      };
    }
    return out;
  }
}
