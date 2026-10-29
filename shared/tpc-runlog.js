/**
 * tpc-runlog.js — 把「这一次运行」落成一份可复现的快照（run.json）
 *
 * 为什么需要它：老师反馈「数不准」时，能给的只有一句话。而"数不准"可能来自
 * 参数（调试台改过）、机位（分辨率/比例）、硬件（CPU 还是 GPU、实际帧率），
 * 也可能是这一次刚好把某个动作切错了。没有这些信息，任何排查都是猜。
 *
 * 所以这份快照要能回答三个问题：
 *   1) 当时**真正生效**的参数是什么   → config.effective
 *   2) 和默认值**差在哪**            → config.patch + appliedCustom
 *   3) 跑在**什么环境**上            → engine + env
 *
 * 两个刻意的取舍：
 *
 * · **patch 与 effective 都存，不存其一。** patch 只有被改过的那几项，
 *   可读性好；但默认值会随版本变，拿旧 patch 套新版本会失真。
 *   effective 是当时合并后的全量，能一比一重跑。两者回答的是不同问题。
 *
 * · **不存逐帧数据。** 帧级轨迹是 MB 级，浏览器 localStorage 存不住，
 *   也没有必要 —— 拒绝计数 + 节奏统计 + 信号极值已经足够定位
 *   「是阈值不对还是机位不对」。真要逐帧数据，走调试台的实时曲线。
 *
 * 本模块不认识 DOM、不认识摄像头，只吃纯数据，因此能在 node 里单测
 * （tools/test-runlog.mjs）—— 与 tpc-guide.js 同一条设计线。
 */

/** 存档格式版本。字段增删时改这里，读旧文件的人能一眼看出来 */
export const RUN_SCHEMA = 'spc-run/1';

/** 单份 run 里每半程最多留多少个样本（够算均值/极值，又不让文件变大） */
const RHYTHM_CAP = 50;

function iso(at) {
  if (at == null) return new Date().toISOString();
  const d = at instanceof Date ? at : new Date(at);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const round = (v, digits = 0) => {
  const n = num(v);
  if (n == null) return null;
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
};

/**
 * 把多次动作的向心/离心时长汇总成「这个动作做了多快」。
 *
 * 按 label 分组而不是按 index 分组：label 是动词（「下放」「起身」），
 * 语义稳定；index 会因为动作换向而错位（高抬腿的 cycle 是 down→up，
 * 第一段是抬腿而不是下放）。
 *
 * 只统计 activeMs（扣掉停顿后的运动时间）—— 用 rawMs 的话，
 * 学生累了在底下多歇一会儿，均值就会被算成「做得更慢了」，这显然不对。
 *
 * @param {Array<Array<{label?:string, activeMs?:number|null}>>} listOfTransitions
 * @returns {{samples:number, halves:Array<{label:string, samples:number, avgMs:number, minMs:number, maxMs:number}>}}
 */
export function summarizeRhythm(listOfTransitions, cap = RHYTHM_CAP) {
  const byLabel = new Map();
  for (const ts of listOfTransitions || []) {
    for (const t of ts || []) {
      if (!t || typeof t.activeMs !== 'number' || !(t.activeMs > 0)) continue;
      const key = t.label || '?';
      if (!byLabel.has(key)) byLabel.set(key, []);
      const arr = byLabel.get(key);
      if (arr.length < cap) arr.push(t.activeMs);
    }
  }

  const halves = [];
  for (const [label, arr] of byLabel) {
    halves.push({
      label,
      samples: arr.length,
      avgMs: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
      minMs: Math.round(Math.min.apply(null, arr)),
      maxMs: Math.round(Math.max.apply(null, arr)),
    });
  }
  const samples = halves.length ? Math.max.apply(null, halves.map((h) => h.samples)) : 0;
  return { samples, halves };
}

/**
 * 开始一次运行时的快照（结束时补齐其余字段）。
 *
 * @param {object} meta
 * @param {number|Date} meta.at        开始时刻
 * @param {object} meta.exercise       { id, name, mode }
 * @param {object} meta.cfg            该动作的完整配置（exercises.json 的一项）
 * @param {number} [meta.appliedCustom] 套用了几项自定义参数
 * @param {object|null} [meta.patch]   被改动的参数（调试台存档里的 patch）
 * @param {object|null} [meta.engine]  { model, delegate, videoW, videoH }
 * @param {object|null} [meta.env]     { ua, dpr, screen, hwConcurrency, tzOffsetMin }
 */
export function createRun(meta = {}) {
  const { at, exercise = {}, cfg = {}, appliedCustom = 0, patch = null,
    profile = null, engine = null, env = null } = meta;
  return {
    schema: RUN_SCHEMA,
    startedAt: iso(at),
    endedAt: null,
    durationMs: null,
    endReason: null,
    exercise: {
      id: exercise.id || null,
      name: exercise.name || null,
      mode: exercise.mode || null,
    },
    config: {
      appliedCustom: Number(appliedCustom) || 0,
      // 两个都留：patch 回答"改了哪几项"，effective 回答"当时在用的到底是什么"
      patch: patch || null,
      /**
       * 学生校准。**必须留**：套了 profile 之后 effective.fsm 与 exercises.json
       * 对不上，谁看都会以为是配置坏了。这一段解释"为什么这次的阈值和文件不一样"。
       */
      profile: profile || null,
      effective: {
        primary: cfg.primary || null,
        channelIds: (cfg.channels || []).map((c) => c.id),
        fsm: cfg.fsm || null,
        hold: cfg.hold || null,
        signals: cfg.signals || null,
        camera: cfg.camera || null,
      },
    },
    engine: engine
      ? {
        model: engine.model || null,
        delegate: engine.delegate || null,
        videoW: num(engine.videoW),
        videoH: num(engine.videoH),
        aspect: engine.videoW && engine.videoH
          ? round(engine.videoW / engine.videoH, 4)
          : null,
      }
      : null,
    env: env || null,
    result: null,
    rhythm: null,
    /**
     * 相似度汇总（与本人基线比）。放顶层而不塞进 result：它是"和以前比"的语义，
     * 不是"这次做了多少"的统计，混进 result 会让看报表的人以为是又一个计数。
     */
    similarity: null,
  };
}

/**
 * 结束一次运行：把成绩、节奏、结束原因补进去。
 *
 * 刻意返回**新对象**而不是原地改：run 一旦写进历史就不该被后续动作污染。
 * （就地改过一次，结果是历史记录里的每一次都显示最后那一次的成绩。）
 *
 * @param {object} run              createRun 的返回值
 * @param {object} close
 * @param {number|Date} close.at    结束时刻
 * @param {object} [close.snapshot] tracker.snapshot()
 * @param {string} [close.reason]   stopped / switched / reloaded / error
 * @param {Array<Array<object>>} [close.reps] 各次动作的 transitions
 * @param {object|null} [close.inferMs] { last, p50, p95 }
 */
export function closeRun(run, close = {}) {
  const { at, snapshot = {}, reason = 'stopped', reps = [], inferMs = null, sim = null } = close;
  if (!run) return null;

  const endedAt = iso(at);
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt));

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const channels = Array.isArray(snapshot.channels) ? snapshot.channels : [];

  return {
    ...run,
    endedAt,
    durationMs,
    endReason: reason || 'stopped',
    engine: run.engine
      ? { ...run.engine, inferMs: inferMs || run.engine.inferMs || null }
      : run.engine,
    result: {
      mode: snapshot.mode || null,
      count: num(snapshot.count),
      /** 宽松计数才有的"做到位"次数；严格模式与 count 相等 */
      qualifiedCount: snapshot.qualifiedCount == null ? null : num(snapshot.qualifiedCount),
      loose: snapshot.loose == null ? null : !!snapshot.loose,
      totalMs: num(snapshot.totalMs),
      sessions: sessions.length,
      validSessions: sessions.filter((s) => s && s.valid).length,
      rejections: snapshot.rejections || null,
      channels: channels.map((c) => ({ id: c.id, label: c.label, count: num(c.count) })),
    },
    rhythm: summarizeRhythm(reps),
    similarity: sim || run.similarity || null,
  };
}

/**
 * 打包成可下载的文件内容。
 *
 * 带上 `appVersion` 与 `exportedAt`：一份旧文件里如果出现已经删掉的参数，
 * 第一件要确认的就是它出自哪个版本。
 */
export function runFile(runs, meta = {}) {
  const list = (runs || []).filter(Boolean);
  return {
    schema: RUN_SCHEMA,
    app: { name: 'sports-pose-coach', version: meta.appVersion || null },
    exportedAt: iso(meta.exportedAt),
    count: list.length,
    runs: list,
  };
}

/**
 * 一行人话摘要，用于界面「最近一次运行」那一行。
 * 目的是让老师不用打开 JSON 就知道自己导出的东西里有什么。
 */
export function describeRun(run) {
  if (!run || !run.result) return '';
  const sec = run.durationMs == null ? null : Math.round(run.durationMs / 1000);
  const bits = [];
  if (sec != null) bits.push(sec >= 60 ? Math.round(sec / 60) + ' 分钟' : sec + ' 秒');
  if (run.result.count != null) bits.push(run.result.count + ' 次');
  if (run.result.totalMs) bits.push((run.result.totalMs / 1000).toFixed(1) + ' 秒计时');
  if (run.rhythm && run.rhythm.halves.length) {
    // 这里是**均值**，保留两位不删尾零（0.70s）—— 报表里"0.7"会让人怀疑是不是四舍五入过
    bits.push(run.rhythm.halves.map((h) => h.label + ' ' + (h.avgMs / 1000).toFixed(2) + 's').join(' / '));
  }
  return bits.join(' · ');
}
