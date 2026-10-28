/**
 * tpc-profile.js —— 自校准 profile：用「这个人自己的满程」当基准
 *
 * ## 为什么需要
 *
 * 现有阈值全是绝对值（膝角 100°、肘角 116°、踝距 1.25 肩宽）。对成年人有效，
 * 但小学低段和幼儿园的关节比例、柔韧度差异极大：**同一个 100° 膝角，
 * 对 6 岁和 12 岁是完全不同的动作幅度**。不做这层，就会不断收到
 * 「这孩子明明做对了却不计数」的反馈。
 *
 * ## 做法：把阈值从「角度」翻译成「在本人满程上的位置」
 *
 * 关键的一步不是"用学生的满程算阈值"，而是**先把现有绝对阈值反推成位置比例**：
 *
 *     t = (阈值 - 参考满程下限) / 参考满程跨度
 *     学生阈值 = 学生满程下限 + t × 学生满程跨度
 *
 * `refRange`（参考满程，即"标准成人"的满程）写在 exercises.json 里。
 * 这样做的两个好处：
 *
 * 1. **恒等性**：学生满程 == 参考满程时，算出来的阈值**与原值完全一致**。
 *    也就是说校准不会悄悄改动那些已经调了半天的参数 —— 这条被测试钉死。
 * 2. **单一来源**：绝对阈值仍然是唯一可读的那一份，比例是算出来的。
 *    若反过来存比例，改绝对值时比例会失同步，而且没人看得懂 `"at": 0.6263`。
 *
 * ## 只改「幅度判断」，不改「规范边界」
 *
 * guards 里有两种条件，长得一样但语义完全不同：
 *
 * | 类型 | 例子 | 要不要跟着校准走 |
 * |---|---|---|
 * | 规范要求（姿势） | 躯干前倾 ≤55°、膝盖弯曲 55–145°、身体成一条直线 | **不缩放** |
 * | 幅度要求（做满没有） | 俯卧撑「没完全撑直」`elbowAngle gte 150` | 理论上该缩放 |
 *
 * 所以本模块**只重写 phases / loose / qualify 三处的阈值，guards 一律不动**。
 * 第二类 guard 与 qualify 表达的是同一件事，目前数值并不一致（见
 * docs/参数依据.md 的已知问题），把它当成独立工作项，不在这里顺手改 ——
 * 顺手改会让"标记"和"合格"两套口径同时变动，出了问题查不清是谁的锅。
 */

export const PROFILE_SCHEMA = 'spc-profile/1';
export const PROFILE_KEY = 'spc.profiles.v1';

/** 校准至少要攒够的样本数（约 1 秒 @30fps）—— 太少算不出分位数 */
export const MIN_SAMPLES = 30;

/** 至少要观察到几次"下去又上来"，否则没法确认学生真的动了 */
export const MIN_REVERSALS = 2;

/* ============================ 学一个满程 ============================ */

/** 线性插值分位数。入参必须已排序 */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * 数「方向反转」的次数：用满程的 25% 当迟滞带，来回超过这个幅度才算一次反转。
 *
 * 为什么要迟滞：信号有抖动，若按"上一个点比当前点大"来数方向，一秒钟能数出几十次。
 * 为什么取 25%：小于这个幅度不可能构成一次动作的有效半程，数进来只是噪声。
 *
 * 实现上 hi / lo 必须分开记。第一版把"当前段极值"用一个变量存，方向未定时
 * max 和 min 两条追踪会同时生效，极值被拖到当前值 → 迟滞差永远是 0，
 * 方波也数不出一次起落（真踩过）。分开记之后，翻转时才把两端一起重置。
 */
function countReversals(values, span) {
  if (values.length < 3 || !(span > 0)) return 0;
  const band = span * 0.25;
  let dir = 0;                 // +1 上升中 / -1 下降中 / 0 还没定向
  let hi = values[0];
  let lo = values[0];
  let n = 0;
  for (const v of values) {
    if (v > hi) hi = v;
    if (v < lo) lo = v;
    if (dir !== -1 && hi - v >= band) { dir = -1; n++; hi = v; lo = v; }
    else if (dir !== 1 && v - lo >= band) { dir = 1; n++; hi = v; lo = v; }
  }
  return n;
}

/**
 * 从一段原始信号里学出「这个人的满程」。
 *
 * 取 p2 / p98 而不是 min / max：单个坏帧（关键点闪一下）就能把 min/max 拉飞，
 * 而 p2/p98 对这种离群值不敏感。代价是"真正的最深一次"会被削掉一点点 ——
 * 这里宁可偏保守，因为后续所有阈值都按这个跨度缩放，跨度虚大会让动作变得太容易。
 *
 * @param {Array<number|null>} samples 逐帧的主信号读数
 * @param {object} spec exercises.json 的 calibration 段
 * @returns {object} profile（含 quality 报告）
 */
export function learnProfile(samples, spec = {}) {
  const list = (samples || []).filter((v) => typeof v === 'number' && isFinite(v));
  const fps = spec.fps || 30;
  const seconds = +(list.length / fps).toFixed(1);

  const quality = { ok: false, reasons: [] };
  const base = {
    schema: PROFILE_SCHEMA,
    learnedAt: Date.now(),
    signal: spec.signal || null,
    samples: list.length,
    seconds,
    p2: null, p98: null, range: null, reversals: 0,
    quality,
  };

  if (list.length < MIN_SAMPLES) {
    quality.reasons.push('样本太少（' + list.length + ' 帧），至少需要 ' + MIN_SAMPLES + ' 帧');
    return base;
  }

  const sorted = list.slice().sort((a, b) => a - b);
  const p2 = quantile(sorted, 0.02);
  const p98 = quantile(sorted, 0.98);
  const range = p98 - p2;
  const reversals = countReversals(list, range);
  const minRange = spec.minRange;

  Object.assign(base, { p2: round(p2), p98: round(p98), range: round(range), reversals });

  // 幅度闸门：这一步不能省。学生若只抖了两下就结束，学出来的"满程"是噪声跨度，
  // 之后的阈值会全部塌到几乎不用动 —— 那比不做校准更糟，因为它看起来是"配好了"。
  if (typeof minRange === 'number' && range < minRange) {
    quality.reasons.push(
      '动作幅度太小（满程 ' + round(range) + '，至少要 ' + minRange + '），请重新做');
  }
  if (reversals < MIN_REVERSALS) {
    quality.reasons.push(
      '没看出完整动作（只数到 ' + reversals + ' 次起落），请完整做几次');
  }

  quality.ok = quality.reasons.length === 0;
  return base;
}

/** 这份 profile 能不能拿来用 */
export function isProfileUsable(profile) {
  return !!(profile && profile.quality && profile.quality.ok &&
    typeof profile.p2 === 'number' && typeof profile.p98 === 'number' &&
    profile.range > 0);
}

/* ============================ 换算阈值 ============================ */

/** 按数量级选小数位：角度 1 位、比值 2 位、膝高这类小量 3 位 */
function round(v) {
  if (typeof v !== 'number' || !isFinite(v)) return v;
  const a = Math.abs(v);
  const d = a < 2 ? 3 : (a < 5 ? 2 : 1);
  const m = Math.pow(10, d);
  return Math.round(v * m) / m;
}

const CMP_KEYS = ['gte', 'lte', 'gt', 'lt'];

/** 收集 fsm 里所有该被重写的阈值：phases / loose / qualify 三处，guards 不碰 */
function collectTargets(fsm) {
  const out = [];
  const pushEnter = (phaseMap, prefix) => {
    for (const [phase, def] of Object.entries(phaseMap || {})) {
      const enter = (def && def.enter) || {};
      for (const cmp of CMP_KEYS) {
        if (typeof enter[cmp] === 'number') {
          out.push({ path: prefix + phase + '.enter.' + cmp, from: enter[cmp] });
        }
      }
    }
  };
  pushEnter(fsm.phases, 'phases.');
  pushEnter(fsm.loose && fsm.loose.phases, 'loose.phases.');

  for (const field of ['signalMin', 'signalMax']) {
    const cond = (fsm.qualify || {})[field];
    if (!cond) continue;
    for (const cmp of CMP_KEYS) {
      if (typeof cond[cmp] === 'number') {
        out.push({ path: 'qualify.' + field + '.' + cmp, from: cond[cmp] });
      }
    }
  }
  return out;
}

/**
 * 算出「这个人的阈值应该是多少」，返回差异清单（不改入参）。
 *
 * @returns {Array<{path:string, from:number, to:number, t:number}>}
 *   t 是这条阈值在参考满程上的位置（0=最下端，1=最上端），排查时很有用：
 *   同一个动作里 t 的排序就是「哪个相更难进」。
 */
export function deriveThresholds(cfg, profile) {
  const spec = cfg && cfg.calibration;
  if (!spec || !isProfileUsable(profile)) return [];
  const ref = spec.refRange;
  if (!ref || typeof ref.min !== 'number' || typeof ref.max !== 'number') return [];
  const refMin = ref.min;
  const refSpan = ref.max - ref.min;
  if (!(refSpan > 0)) return [];

  const span = profile.p98 - profile.p2;
  return collectTargets(cfg.fsm || {}).map((t) => {
    const p = (t.from - refMin) / refSpan;
    return { path: t.path, from: t.from, to: round(profile.p2 + p * span), t: round(p) };
  });
}

function setDeep(obj, path, val) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = val;
}

/**
 * 把 profile 套到配置上，返回**新对象**（入参不动）。
 *
 * 没有 profile / profile 不可用 / 动作没配 calibration 时，返回的是一份等价副本 ——
 * 调用方不必分情况处理，但也不要指望"没变"能靠引用相等判出来。
 */
export function applyProfile(cfg, profile) {
  const next = JSON.parse(JSON.stringify(cfg));
  const diffs = deriveThresholds(cfg, profile);
  for (const d of diffs) setDeep(next, 'fsm.' + d.path, d.to);
  // 记下"这份配置被谁改过"，方便界面与运行记录说明来路
  if (diffs.length) {
    next._profile = {
      studentId: profile.studentId || null,
      learnedAt: profile.learnedAt || null,
      applied: diffs.length,
      p2: profile.p2, p98: profile.p98,
    };
  }
  return next;
}

/** 一句话说清学了什么 —— 界面与运行记录共用，避免两处措辞对不上 */
export function describeProfile(profile, spec = {}) {
  if (!isProfileUsable(profile)) return '未校准';
  const u = spec.unit || '';
  return '满程 ' + profile.range + u + '（' + profile.p2 + u + '–' + profile.p98 + u + '）' +
    ' · ' + profile.reversals + ' 次起落';
}

/* ============================ 存档 ============================ */

/** 内存版存储，测试用 */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/**
 * 学生校准档案。按「学生 → 动作」两层存。
 *
 * 为什么不按动作→学生：老师上课的心智是"这节课看这个孩子"，
 * 切换主语是学生，动作是被选的第二个维度。
 */
export class ProfileStore {
  constructor(storage) {
    this.storage = storage || null;
    this.lastError = null;
    this.data = this._load();
  }

  _load() {
    const empty = { v: 1, students: {} };
    if (!this.storage) return empty;
    try {
      const raw = this.storage.getItem(PROFILE_KEY);
      if (!raw) return empty;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !obj.students) return empty;
      return obj;
    } catch (e) {
      // 存档坏了不能让页面打不开 —— 界面会读 lastError 提示重新校准
      this.lastError = e;
      return empty;
    }
  }

  _save() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(PROFILE_KEY, JSON.stringify(this.data));
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e;
      return false;
    }
  }

  /** 学生列表（按最近更新排序；同一毫秒内保存的按下标兜底，保证顺序稳定） */
  list() {
    return Object.entries(this.data.students)
      .map(([id, s]) => ({
        id,
        label: s.label || id,
        updatedAt: s.updatedAt || 0,
        exercises: Object.keys(s.ex || {}),
      }))
      .sort((a, b) => (b.updatedAt - a.updatedAt) || String(a.id).localeCompare(String(b.id)));
  }

  get(studentId, exerciseId) {
    const s = this.data.students[studentId];
    if (!s || !s.ex) return null;
    return s.ex[exerciseId] || null;
  }

  /** 存一份。studentId 用老师输入的名字/座号，稳定就好 */
  save(studentId, label, exerciseId, profile) {
    if (!studentId) throw new Error('ProfileStore.save: 缺少学生标识');
    const s = this.data.students[studentId] ||
      (this.data.students[studentId] = { label: label || studentId, ex: {} });
    s.label = label || s.label || studentId;
    s.updatedAt = Date.now();
    s.ex[exerciseId] = { ...profile, studentId, exerciseId, savedAt: Date.now() };
    const ok = this._save();
    return ok;
  }

  remove(studentId) {
    delete this.data.students[studentId];
    return this._save();
  }

  removeExercise(studentId, exerciseId) {
    const s = this.data.students[studentId];
    if (!s || !s.ex) return false;
    delete s.ex[exerciseId];
    if (!Object.keys(s.ex).length) delete this.data.students[studentId];
    return this._save();
  }

  /** 整个存档导出（老师换电脑时带走） */
  export() {
    return JSON.parse(JSON.stringify(this.data));
  }

  import(obj) {
    if (!obj || typeof obj !== 'object' || !obj.students) {
      throw new Error('导入失败：不是校准存档');
    }
    this.data = { v: 1, students: JSON.parse(JSON.stringify(obj.students)) };
    return this._save();
  }
}
