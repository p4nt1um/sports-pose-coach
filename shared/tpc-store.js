/**
 * tpc-store.js —— 「老师调好的参数」持久化、合并与冲突检测
 *
 * 目标只有一句：**调好的阈值下次进来还在**。
 * 但实现上有三个坑，这个模块存在的意义就是把它们一次处理干净：
 *
 *  1) 存差异，不存全量。
 *     存档只记「与 data/exercises.json 默认值不同的项」。
 *     这样以后我们改默认值时，老师没动过的项会自动跟随新默认值 ——
 *     若存全量，老师随便调一次就会把整份配置永久冻结在当时的默认值上。
 *
 *  2) 冲突要看见，不能静默覆盖。
 *     存档同时记录「保存那一刻文件里的默认值」（baseline）。
 *     载入时逐项比对：若文件侧后来也改过同一项，判为冲突 —— 仍然采用老师
 *     调的值（用户的调整优先），但把冲突列在界面上，让人知道发生了什么。
 *
 *  3) 持久层可注入、可降级。
 *     隐私模式 / 禁用站点存储时 localStorage 会抛异常，此时退化为内存存储
 *     （本次会话有效），由调用方在界面上说明 —— 而不是整页报错。
 *     存储可注入也让 node 单测不需要浏览器。
 *
 * 路径语言与 tools/tune.html 的滑块一致，形如：
 *   'fsm.phases.stand.enter.gte'
 *   'signals.kneeAngle.smooth.minCutoff'
 * 数组按索引展开（'fsm.guards.0.lte'），保证每个值都是原始类型、可直接 JSON 序列化。
 */

/** 存档格式版本。将来结构不兼容地变更时递增，并在此处写明迁移方式 */
export const STORE_VERSION = 1;

/** localStorage 键前缀。老师调好的参数与其它数据分开命名，便于整片清理 */
export const KEY_PREFIX = 'spc.tuned.';

/**
 * 只展开这几棵子树。
 * 其余字段（id / name / order / category / unit / camera / feedback）不是可调参数，
 * 存进存档只会造成噪音与假冲突。
 *
 * hold 必须在内：计时动作（马步、靠墙静蹲）**没有 fsm**，阈值全在 hold.conditions
 * 与 hold.minHoldMs 这些字段里。漏掉它的话，老师在调试台把计时动作调了半天，
 * 存档里一项都不会有 —— 表现为「调完刷新全没了」，且不报错。
 *
 * channels 故意不在内：那里只有 id/label/signal 这类结构字段，没有可调阈值。
 */
const PARAM_SECTIONS = ['signals', 'fsm', 'hold'];

/* ============================ 路径工具 ============================ */

export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, val) {
  const ks = String(path).split('.');
  const last = ks.pop();
  let o = obj;
  for (const k of ks) {
    if (o[k] == null) o[k] = /^\d+$/.test(k) ? [] : {};
    o = o[k];
  }
  o[last] = val;
  return obj;
}

/* ============================ 参数展开与差异 ============================ */

function walk(node, path, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, path + '.' + i, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, path ? path + '.' + k : k, out);
    return;
  }
  out[path] = node;
}

/** 把一份动作配置摊平成 { 路径: 原始值 }，只取 signals 与 fsm */
export function flattenParams(ex) {
  const out = {};
  if (!ex || typeof ex !== 'object') return out;
  for (const s of PARAM_SECTIONS) {
    if (ex[s] && typeof ex[s] === 'object') walk(ex[s], s, out);
  }
  return out;
}

/** 值比较。数组/对象用 JSON 串比较，因为 guards 这类会被展开成索引路径下的原始值，极少需要 */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }
  return false;
}

/**
 * 算出「当前配置相对默认值改了哪些项」—— 这就是存档的正文。
 * 老师把某项调回默认值时，它会自然从结果里消失，不需要额外清理逻辑。
 */
export function diffPatch(current, base) {
  const cur = flattenParams(current);
  const bas = base ? flattenParams(base) : {};
  const patch = {};
  for (const [k, v] of Object.entries(cur)) {
    if (!(k in bas) || !sameValue(bas[k], v)) patch[k] = v;
  }
  return patch;
}

/** 从 baseline 里挑出 patch 用到的那些键，作为冲突检测的依据 */
function pickKeys(obj, keys) {
  const out = {};
  if (!obj) return out;
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

/**
 * 逐项比对「保存时的文件默认值」与「现在的文件默认值」，找出被两边都改过的项。
 * 只在文件侧确实变过时才算冲突 —— 老师自己调的不算。
 */
export function checkConflicts(patch, savedBaseline, currentBase) {
  const out = [];
  for (const p of Object.keys(patch || {})) {
    const sb = savedBaseline ? savedBaseline[p] : undefined;
    const cb = currentBase ? currentBase[p] : undefined;
    if (sb !== undefined && cb !== undefined && !sameValue(sb, cb)) {
      out.push({ path: p, baselineAtSave: sb, fileNow: cb, saved: patch[p] });
    }
  }
  return out;
}

/**
 * 把 patch 写进目标配置。
 * 路径在目标里不存在就跳过并记入 unknown —— 不凭空创建结构，
 * 这样一份陈旧或来自别的动作的存档最多是部分失效，不会把配置写坏。
 */
export function applyPatch(target, patch) {
  const applied = [];
  const unknown = [];
  for (const [p, v] of Object.entries(patch || {})) {
    if (getPath(target, p) === undefined) { unknown.push(p); continue; }
    setPath(target, p, v);
    applied.push(p);
  }
  return { applied, unknown };
}

/* ============================ 存储实现 ============================ */

/** 内存存储：降级模式与单测使用。接口与 localStorage 一致 */
export function memoryStorage() {
  const m = new Map();
  return {
    kind: 'memory',
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => Array.from(m.keys())[i] == null ? null : Array.from(m.keys())[i],
    get length() { return m.size; },
  };
}

/** 探测 localStorage 是否真的可用（隐私模式下存在但写入会抛） */
export function probeLocalStorage() {
  try {
    const s = typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
    if (!s) return null;
    const probe = '__spc.probe__';
    s.setItem(probe, '1');
    const ok = s.getItem(probe) === '1';
    s.removeItem(probe);
    return ok ? s : null;
  } catch (e) {
    return null;
  }
}

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* ============================ TunedStore ============================ */

export class TunedStore {
  /**
   * @param {object} [opts]
   * @param {object} [opts.storage] 注入存储（单测传 memoryStorage()）。默认探测 localStorage
   * @param {string} [opts.prefix]  键前缀
   * @param {Function} [opts.now]   时间源，单测可固定
   */
  constructor(opts = {}) {
    this.prefix = opts.prefix || KEY_PREFIX;
    this.now = opts.now || (() => Date.now());
    const real = opts.storage || probeLocalStorage();
    /** true = 只能用内存存档，刷新即丢。调用方必须在界面上告知老师 */
    this.degraded = !real;
    this.storage = real || memoryStorage();
    this.lastError = null;
  }

  keyOf(id) { return this.prefix + id; }

  /**
   * 保存一份调整。
   * @param {string} id 动作 id（如 'squat'）
   * @param {object} data { patch, baseline, cfgVersion }
   * @returns {{ok:boolean, record?:object, error?:Error, cleared?:boolean}}
   *   patch 为空 → 视为「无调整」并清除存档（cleared: true）
   */
  save(id, data = {}) {
    const baseline = data.baseline || null;
    const rawPatch = data.patch || {};
    const patch = {};
    for (const [k, v] of Object.entries(rawPatch)) {
      // 与默认值相同的项不入档，避免"存了一堆等于默认的值"这种假调整
      if (baseline && k in baseline && sameValue(baseline[k], v)) continue;
      patch[k] = v;
    }

    const keys = Object.keys(patch);
    if (!keys.length) {
      this.clear(id);
      return { ok: true, cleared: true, record: null };
    }

    const at = this.now();
    const record = {
      v: STORE_VERSION,
      id,
      savedAt: at,
      savedAtText: stamp(at),
      cfgVersion: data.cfgVersion || null,
      patch,
      baseline: pickKeys(baseline, keys),
    };

    try {
      this.storage.setItem(this.keyOf(id), JSON.stringify(record));
      this.lastError = null;
      return { ok: true, record };
    } catch (e) {
      this.lastError = e;
      return { ok: false, error: e, record };
    }
  }

  /** 读取存档。损坏或结构不对一律返回 null —— 一份坏存档不该让页面打不开 */
  load(id) {
    let raw = null;
    try {
      raw = this.storage.getItem(this.keyOf(id));
    } catch (e) {
      this.lastError = e;
      return null;
    }
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw);
      if (!rec || typeof rec !== 'object') return null;
      if (!rec.patch || typeof rec.patch !== 'object') return null;
      if (!Object.keys(rec.patch).length) return null;
      return rec;
    } catch (e) {
      this.lastError = e;
      return null;
    }
  }

  clear(id) {
    try { this.storage.removeItem(this.keyOf(id)); this.lastError = null; }
    catch (e) { this.lastError = e; }
  }

  /** 列出所有存过的动作 —— 给将来的管理界面与自检用 */
  list() {
    const out = [];
    let keys = [];
    try {
      const n = this.storage.length || 0;
      for (let i = 0; i < n; i++) {
        const k = this.storage.key(i);
        if (k) keys.push(k);
      }
    } catch (e) { this.lastError = e; }
    for (const k of keys) {
      if (k.indexOf(this.prefix) !== 0) continue;
      const id = k.slice(this.prefix.length);
      if (!id) continue;
      const rec = this.load(id);
      if (rec) out.push({ id, savedAt: rec.savedAt, count: Object.keys(rec.patch).length });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  /**
   * 把存档应用到目标配置上，并做冲突检测。
   * @returns {{applied:string[], unknown:string[], conflicts:object[]}}
   *   unknown   = 存档里的路径在当前配置里已不存在（配置文件结构变过）
   *   conflicts = 文件默认值与保存时不同，且老师也改了这一项
   */
  restore(target, record, baseConfig) {
    const patch = (record && record.patch) || {};
    const res = applyPatch(target, patch);
    const currentBase = flattenParams(baseConfig);
    return {
      applied: res.applied,
      unknown: res.unknown,
      conflicts: checkConflicts(patch, record && record.baseline, currentBase),
    };
  }

  /** 导出一份存档的 JSON 文本（含 patch 与 baseline，可跨机器迁移） */
  toText(record) {
    return JSON.stringify(record, null, 2);
  }

  /**
   * 解析一份导入的文件。接受两种格式：
   *   A) 存档（有 patch 字段）      —— 本模块导出的备份
   *   B) 完整动作配置（有 fsm/signals）—— 直接导出的 data/exercises.json 片段
   * @returns {{patch:object, baseline:object, id:string|null}}
   * @throws {Error} 格式无法识别
   */
  parseImport(text, currentBase) {
    let obj;
    try { obj = JSON.parse(text); }
    catch (e) { throw new Error('不是合法的 JSON 文件'); }
    if (!obj || typeof obj !== 'object') throw new Error('文件内容不是对象');

    if (obj.patch && typeof obj.patch === 'object') {
      return { patch: obj.patch, baseline: obj.baseline || currentBase || {}, id: obj.id || null };
    }
    if (obj.fsm || obj.signals) {
      return { patch: flattenParams(obj), baseline: currentBase || {}, id: obj.id || null };
    }
    throw new Error('文件里没有可识别的参数（既不是存档，也不是动作配置）');
  }
}

export default TunedStore;
