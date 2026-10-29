/**
 * tpc-similarity.js —— 动作相似度：和「这个学生自己」比
 *
 * ## 为什么是"和自己比"而不是"和标准动作比"
 *
 * 儿童之间的关节比例、柔韧度差距太大，绝对标准不可行：同一个动作，做得"标准"的
 * 样子在两个孩子身上根本不同。而"比上次做得怎么样"是公平的，也是老师真正关心的
 * —— 体育课不是选拔，是看进步。
 *
 * 代价必须接受：**跨学生不可比**。分数只说"这一次在他自己历来做的里面算什么水平"，
 * 不能说"他比同桌好"。界面与文档都要写明这一点，否则会被当成排名用。
 *
 * ## 和原方法的一处关键不同：锚点固定，而不是每次现测
 *
 * vision-demos 的双锚点是从**当前片段**现算的（0% = 相隔 ≥2 秒帧对的中位差异，
 * 100% = 片段自身差异的第 10 百分位）。那样分数只在本次视频内成立，跨视频不可比 ——
 * 而"看趋势"恰恰需要跨视频。原作者是一次性演示，不需要解决这个，我们必须补：
 *
 * **锚点在建立基线时算一次，之后一直复用。**
 *
 * 而且单人自我场景下，原作者的 0% 定义（"两个无关瞬间本来就有多像"）变了味道：
 * 那是多人同步场景的底噪修正。单人看趋势更合适的锚点是**他自己的离散度**，
 * 并且要有一个固定的语义落点：
 *
 *   100 分 = 差异为 0（完全复制模板，实践上不可达）
 *    60 分 = 差异等于他平时的中位值（"和平时一样"）
 *     0 分 = 差异达到 0 分锚点（他历来最差那一档）
 *
 * 把"和平时一样"定在 60 分是刻意的：定在 0 分会让一次毫无变化的动作看起来像退步，
 * 定在 100 分则让"进步"永远是 0。定标细节见 buildBaseline 里的注释与 ZERO_RATIO。
 *
 * ## 为什么按「主信号进度」分箱，而不是按时间
 *
 * 学生蹲到底歇了 3 秒再起来，按时间归一化会把那 3 秒摊到整个动作上，形状全歪。
 * 按主信号（膝角）等分进度则完全不受停顿影响：停多久都只是那一箱样本更多。
 * 这是本模块最重要的实现选择，`test-similarity.mjs` 用同一套动作加不同停顿验证它。
 */

export const SIM_SCHEMA = 'spc-baseline/1';
export const BASELINE_KEY = 'spc.baselines.v1';

/** 每段分几箱；两段合计 2×bins 个进度点 */
export const DEFAULT_BINS = 8;
/** 基线至少要做几次动作 —— 少于 3 次无法估离散度 */
export const MIN_REPS = 3;
/** 两锚点区间小于这个值就算"退化"（学生太稳定，分数没有分辨力） */
export const MIN_SPAN = 0.2;
/**
 * "0 分锚点"至少是"平时差异"的多少倍。
 *
 * 这个倍数是分数的**定标**：diff 等于他平时的中位差异时，得分 = 100×(1−1/2.5) = 60。
 * 取 2.5 是为了让"和平时一样"落在 60 分而不是 0 分或 100 分 —— 学生稳定时
 * p10 与 p90 会挤在一起，如果直接拿 p90 当 0 分，一次毫无变化的动作也会得 0 分，
 * 老师会以为他退步了。理由写在 test-similarity.mjs 的"定标"那一组里。
 */
export const ZERO_RATIO = 2.5;
/** 0 分锚点的绝对下限（自然抖动单位），防止极端稳定的学生把分母压成 0 */
const MIN_ZERO = 0.3;
/** 单信号自然波动的下限，防止某个信号恒定不变时除零 */
const MIN_SCALE = 1e-6;

/** 分位数（线性插值），入参需已排序 */
function quantile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const median = (arr) => quantile(arr.slice().sort((a, b) => a - b), 0.5);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

/**
 * 把一次动作的逐帧数据压成「按进度分箱的姿态向量序列」。
 *
 * @param {Array<{tMs:number, values:object}>} frames rep 窗口内的逐帧数据
 * @param {object} spec similarity 配置
 *   { primary, turn:'min'|'max', signals:[{name,weight}], bins }
 * @returns {{vec: Array<Array<number>>, filled: number, reason?: string} | null}
 *   vec 长度 = 2×bins，每项是按 signals 顺序排的数组
 */
export function normalizeRep(frames, spec) {
  const cfg = spec || {};
  const primary = cfg.primary;
  /**
   * 主信号是**进度轴**，不能同时当特征。
   *
   * 每一箱是按主信号的取值切出来的，所以同一个箱里的主信号值在两次动作之间必然
   * 几乎相同 —— 把它当特征加进来的差异恒为 0，等于给一个空维度分配权重，
   * 悄悄稀释了真正有信息的那些信号。这里直接剔除（`test-config.mjs` 会拦住
   * 配置里这么写的情况，两处一起防：配置错了有人管，运行时也不产生垃圾分数）。
   */
  const sigs = (cfg.signals || []).filter((s) => s && s.name && s.name !== primary);
  const bins = cfg.bins || DEFAULT_BINS;
  const turn = cfg.turn === 'max' ? 'max' : 'min';

  if (!primary || !sigs.length) return null;
  const list = (frames || []).filter((f) => f && num((f.values || {})[primary]) !== null);
  if (list.length < 4) return null;

  const pv = list.map((f) => f.values[primary]);
  const iTurn = turn === 'max'
    ? pv.indexOf(Math.max(...pv))
    : pv.indexOf(Math.min(...pv));

  // 转身点落在端点 → 这一圈没走完（或信号单调），不可用。
  // 不返回"半个动作"的向量：半个动作和整个动作的相似度分数完全不同，
  // 混进来会让分数无缘无故掉下来，而老师看不出原因。
  if (iTurn <= 0 || iTurn >= list.length - 1) return null;

  // 两段：起始相 → 转身点、转身点 → 结束
  const segs = [
    { from: 0, to: iTurn, p0: pv[0], p1: pv[iTurn] },
    { from: iTurn, to: list.length - 1, p0: pv[iTurn], p1: pv[list.length - 1] },
  ];

  const vec = [];
  let filled = 0;
  for (const seg of segs) {
    const span = seg.p1 - seg.p0;
    // 按**值**等分而不是按时间等分：这是抗停顿的全部秘密
    const acc = Array.from({ length: bins }, () => sigs.map(() => ({ s: 0, n: 0 })));
    for (let i = seg.from; i <= seg.to; i++) {
      const denom = span;
      const raw = denom === 0 ? 0 : (pv[i] - seg.p0) / denom;
      const b = Math.min(bins - 1, Math.max(0, Math.floor(raw * bins)));
      for (let j = 0; j < sigs.length; j++) {
        const v = num(list[i].values[sigs[j].name]);
        if (v === null) continue;
        acc[b][j].s += v;
        acc[b][j].n++;
      }
    }
    for (let b = 0; b < bins; b++) {
      const row = acc[b].map((a) => (a.n ? a.s / a.n : null));
      if (row.some((v) => v !== null)) filled++;
      vec.push(row);
    }
  }

  // 缺箱用相邻箱补齐（遮挡几帧很常见）。缺一半以上就判这批数据不可用 ——
  // 插值补出来的形状是编的，拿去打分等于给假分数。
  const ok = fillGaps(vec);
  if (!ok) return null;
  if (filled < vec.length * 0.5) return null;
  return { vec, filled };
}

/** 每个信号的缺失箱用最近的已知箱线性补齐；某信号全缺则返回 false */
function fillGaps(vec) {
  const n = vec.length;
  const dim = vec[0].length;
  for (let j = 0; j < dim; j++) {
    const known = [];
    for (let i = 0; i < n; i++) if (vec[i][j] !== null) known.push(i);
    if (known.length < 2) return false;
    for (let i = 0; i < n; i++) {
      if (vec[i][j] !== null) continue;
      let a = known[0];
      let b = known[known.length - 1];
      for (const k of known) { if (k < i) a = k; }
      for (let k = known.length - 1; k >= 0; k--) { if (known[k] > i) b = known[k]; }
      const va = vec[a][j];
      const vb = vec[b][j];
      vec[i][j] = a === b ? va : va + (vb - va) * ((i - a) / (b - a));
    }
  }
  return true;
}

/**
 * 两条归一化序列的差异。
 *
 * 单位是「他自己这个信号的自然抖动」—— 所以不同量纲的信号可以直接相加，
 * 而且"差 1.0"这句话有确定含义：差了一个他自己做同一动作时的自然波动幅度。
 *
 * 箱空间里允许 ±1 箱的错位（取三者最小）：动作形状在快慢不同时会有轻微时间漂移，
 * 一点点错位不该算成"不像"。这就是原方法 ±2 帧容忍在归一化空间里的对应物。
 *
 * @param {number[][]} a
 * @param {number[][]} b
 * @param {{signals:Array<{name,weight}>, scale?:object}} spec scale 由 buildBaseline 估出
 */
export function diffOf(a0, b0, spec) {
  const a = asVec(a0);
  const b = asVec(b0);
  if (!a || !b || a.length !== b.length) return null;
  const sigs = (spec && spec.signals) || [];
  const scale = (spec && spec.scale) || {};
  const dim = sigs.length;
  let wsum = 0;
  let total = 0;
  for (let j = 0; j < dim; j++) {
    const w = typeof sigs[j].weight === 'number' ? sigs[j].weight : 1;
    if (w <= 0) continue;
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      const cand = [i - 1, i, i + 1].filter((k) => k >= 0 && k < a.length)
        .map((k) => Math.abs(a[i][j] - b[k][j]));
      s += Math.min(...cand);
    }
    const sc = Math.max(MIN_SCALE, scale[sigs[j].name] || MIN_SCALE);
    total += w * (s / a.length) / sc;
    wsum += w;
  }
  return wsum > 0 ? total / wsum : null;
}

/**
 * 估每个信号的自然抖动（跨所有箱、所有 rep 的合并标准差）。
 *
 * 用"他自己"的抖动当单位，而不是硬编码一个绝对容忍度：不同学生的关键点噪声、
 * 动作幅度都不一样，硬编码会让安静的孩子永远 100 分、好动的孩子永远 0 分。
 */
function estimateScale(vecs, spec) {
  const sigs = (spec && spec.signals) || [];
  const out = {};
  for (let j = 0; j < sigs.length; j++) {
    let n = 0;
    let sum = 0;
    let sum2 = 0;
    for (const v of vecs) {
      for (const row of v) {
        const x = num(row[j]);
        if (x === null) continue;
        n++; sum += x; sum2 += x * x;
      }
    }
    const mean = n ? sum / n : 0;
    const varr = n > 1 ? Math.max(0, sum2 / n - mean * mean) : 0;
    out[sigs[j].name] = Math.sqrt(varr);
  }
  return out;
}

/**
 * 接受两种形状：`number[][]` 或 `normalizeRep()` 的返回值 `{vec}`。
 * 调用方常常直接把归一化结果列表递进来，不该被迫到处写 `.vec`。
 */
function asVec(v) {
  if (!v) return null;
  if (Array.isArray(v)) return v.length ? v : null;
  return Array.isArray(v.vec) && v.vec.length ? v.vec : null;
}

/**
 * 建立基线：N 次动作 → 模板 + 双锚点 + 每信号的自然抖动。
 *
 * @param {Array<number[][]|{vec:number[][]}>} vecs normalizeRep 的结果（至少 minReps 个）
 * @param {object} spec
 * @returns {object|null}
 */
export function buildBaseline(vecs, spec) {
  const list = (vecs || []).map(asVec).filter(Boolean);
  const quality = { ok: false, reasons: [], narrow: false };
  const need = (spec && spec.minReps) || MIN_REPS;
  if (list.length < need) {
    quality.reasons.push('有效动作只有 ' + list.length + ' 次，至少要 ' + need + ' 次');
    return { schema: SIM_SCHEMA, quality, template: null, anchors: null };
  }

  // 模板取每箱每信号的中位数 —— 平均值会被"某一次做歪了"整体拉偏
  const n = list[0].length;
  const dim = list[0][0].length;
  const template = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < dim; j++) {
      row.push(median(list.map((v) => v[i][j])));
    }
    template.push(row);
  }

  const scale = estimateScale(list, spec);
  const specWithScale = { ...spec, scale };
  const diffs = list.map((v) => diffOf(v, template, specWithScale)).filter((d) => d !== null);
  if (diffs.length < need) {
    quality.reasons.push('有效动作只有 ' + diffs.length + ' 次');
    return { schema: SIM_SCHEMA, quality, template: null, anchors: null };
  }

  const sorted = diffs.slice().sort((a, b) => a - b);
  const p10 = quantile(sorted, 0.1);
  const p50 = quantile(sorted, 0.5);
  const p90 = quantile(sorted, 0.9);

  /**
   * 锚点的定标（对原方法的一处明确修改，理由见文件头与 ZERO_RATIO 注释）：
   *
   *   100% = 差异为 0（完全复制模板，实践上不可达）
   *    60% = 差异等于他平时的中位值（"和平时一样"）
   *     0% = 差异达到 0 分锚点
   *
   * 0 分锚点取 max(p90, 平时×2.5, 绝对下限)：
   *   - p90 兜住"他确实有波动"的那一档；
   *   - 平时×2.5 兜住"他很稳定、p90 也很小"的情况，保证"和平时一样"仍有 60 分；
   *   - 绝对下限兜住"极其稳定"的极端情形，避免分母趋零导致分数乱跳。
   */
  const hundred = 0;
  const zero = Math.max(p90, p50 * ZERO_RATIO, MIN_ZERO);

  // 分辨力提示：他自己历来就没什么波动时，分数能表达的差别本来就很小。
  // 这不是故障，但界面要说实话，否则老师会把"95 分"当成"做得很好"。
  quality.narrow = (p90 - p10) < MIN_SPAN;

  quality.ok = true;
  return {
    schema: SIM_SCHEMA,
    createdAt: Date.now(),
    template,
    scale,
    anchors: { zero, hundred },
    spread: { p10, p50, p90 },
    reps: list.length,
    quality,
  };
}

/**
 * 差异 → 分数。抽成独立函数是为了能被精确断言：
 * 定标是这套方法的语义地基（"和平时一样"到底几分），不该只能靠"造一个差不多的动作"
 * 去间接验证 —— 那样测出来的是探针选得准不准，不是定标对不对。
 *
 * @param {number} diff
 * @param {{zero:number, hundred:number}} anchors
 * @returns {number|null} 0–100 的整数
 */
export function scoreFromDiff(diff, anchors) {
  if (typeof diff !== 'number' || !isFinite(diff) || !anchors) return null;
  const z = anchors.zero;
  const h = anchors.hundred || 0;
  const spanv = z - h;
  if (!(spanv > 0)) return null;
  const raw = ((z - diff) / spanv) * 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * 打分：这次动作在他自己历来做的里面算什么水平。
 *
 * @returns {{score:number, diff:number, level:'good'|'mid'|'low'} | null}
 */
export function scoreOf(vec, baseline, spec) {
  const v = asVec(vec);
  if (!v || !baseline || !baseline.template || !baseline.anchors) return null;
  if (!baseline.quality || !baseline.quality.ok) return null;
  const diff = diffOf(v, baseline.template, { ...spec, scale: baseline.scale });
  if (diff === null) return null;
  const score = scoreFromDiff(diff, baseline.anchors);
  if (score === null) return null;
  const level = score >= 70 ? 'good' : (score >= 40 ? 'mid' : 'low');
  return { score, diff: Math.round(diff * 100) / 100, level };
}

/** 一句话说清这份基线是什么（界面与运行记录共用） */
export function describeBaseline(b) {
  if (!b || !b.quality || !b.quality.ok) return '未建立';
  const s = b.spread || {};
  return b.reps + ' 次动作 · 平时差异 ' + (s.p50 || 0).toFixed(2) +
    ' · 0 分线 ' + b.anchors.zero.toFixed(2) +
    (b.quality.narrow ? '（动作很稳定，分数分辨力有限）' : '');
}

/* ============================ 存档 ============================ */

export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/**
 * 基线档案：按「学生 → 动作」两层存，与校准档案分开。
 *
 * 为什么分开存：两者的生命週期不同 —— 校准（阈值）改一次可以一直用；
 * 基线（相似度）会随着学生水平提高而"过时"，需要定期重建。
 * 混在一个 key 里，重建基线时会连带把校准覆盖掉。
 */
export class BaselineStore {
  constructor(storage) {
    this.storage = storage || null;
    this.lastError = null;
    this.data = this._load();
  }

  _load() {
    const empty = { v: 1, students: {} };
    if (!this.storage) return empty;
    try {
      const raw = this.storage.getItem(BASELINE_KEY);
      if (!raw) return empty;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !obj.students) return empty;
      return obj;
    } catch (e) {
      this.lastError = e;
      return empty;
    }
  }

  _save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(BASELINE_KEY, JSON.stringify(this.data));
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e;
      return false;
    }
  }

  /** 某学生有基线的动作列表（含建立时间，界面要提示"该重建了"） */
  list(studentId) {
    const s = this.data.students[studentId];
    if (!s || !s.ex) return [];
    return Object.entries(s.ex).map(([id, b]) => ({
      exerciseId: id,
      createdAt: b.createdAt || 0,
      reps: b.reps || 0,
      narrow: !!(b.quality && b.quality.narrow),
    })).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(studentId, exerciseId) {
    const s = this.data.students[studentId];
    if (!s || !s.ex) return null;
    return s.ex[exerciseId] || null;
  }

  save(studentId, exerciseId, baseline) {
    if (!studentId) throw new Error('BaselineStore.save: 缺少学生标识');
    const s = this.data.students[studentId] ||
      (this.data.students[studentId] = { ex: {} });
    s.ex[exerciseId] = baseline;
    return this._save();
  }

  remove(studentId, exerciseId) {
    const s = this.data.students[studentId];
    if (!s || !s.ex) return false;
    delete s.ex[exerciseId];
    if (!Object.keys(s.ex).length) delete this.data.students[studentId];
    return this._save();
  }

  removeStudent(studentId) {
    delete this.data.students[studentId];
    return this._save();
  }

  export() { return JSON.parse(JSON.stringify(this.data)); }

  import(obj) {
    if (!obj || typeof obj !== 'object' || !obj.students) {
      throw new Error('导入失败：不是基线存档');
    }
    this.data = { v: 1, students: JSON.parse(JSON.stringify(obj.students)) };
    return this._save();
  }
}
