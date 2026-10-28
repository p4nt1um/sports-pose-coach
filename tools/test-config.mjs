/**
 * test-config.mjs — 配置健全性 + 参数依据表一致性
 *
 * 为什么单独一套：
 *   「阈值都写在配置文件里」有一个副作用 —— 配置**只会越加越长**，
 *   而没有任何东西会阻止它长出**没人读的键**（本项目真出过两个：hipDrop、
 *   minBodyHeightRatio，都是排查缺陷时白追半天）。与之并列的另一个问题是
 *   「参数改了，文档里的理由没改」，时间一长依据表就变成了谎话。
 *
 * 这一套盯住三件事：
 *   1) 每个可调数值参数都在 docs/参数依据.md 里有条目，且**现值与 JSON 一致**
 *   2) 依据表里没有指向已不存在参数的残留行
 *   3) 每个信号要么被判定逻辑引用，要么显式标了 debugOnly
 *
 * 用法：node tools/test-config.mjs [--verbose]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNAL_TYPES } from '../shared/tpc-signals.js';
import { createTracker, modeOf } from '../shared/tpc-counter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.indexOf('--verbose') !== -1;

const ALL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'exercises.json'), 'utf8'));
const EX = ALL.exercises;
const DOC = path.join(ROOT, 'docs', '参数依据.md');
const docText = fs.readFileSync(DOC, 'utf8');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  :: ' + detail : ''));
}

/* ---------------- 1. 收集「可调数值参数」 ---------------- */

/** 这些键是结构性的（关键点索引、排序、版本），不是可调阈值，不需要写依据 */
const STRUCTURAL_KEYS = new Set(['chain', 'point', 'refPoints', 'a', 'b', 'c', 'order']);

function collectTunables() {
  const out = [];
  const walk = (node, p) => {
    if (node === null || typeof node !== 'object') {
      if (typeof node === 'number') out.push({ path: p.join('.'), value: node });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, p.concat(String(i))));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (STRUCTURAL_KEYS.has(k)) continue;
      walk(v, p.concat(k));
    }
  };
  for (const [id, ex] of Object.entries(EX)) walk(ex, [id]);
  return out;
}

/* ---------------- 2. 解析依据表 ---------------- */

function parseDoc() {
  const rows = new Map();
  const dup = [];
  for (const line of docText.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
    if (!m) continue;
    const key = m[1].replace(/`/g, '').trim();
    if (!/^[a-z_]+\.[A-Za-z0-9_.]+$/.test(key)) continue;   // 只认「动作.路径」形态
    if (!EX[key.split('.')[0]]) continue;                    // 排除概念性表格
    if (rows.has(key)) dup.push(key);
    rows.set(key, m[2].replace(/`/g, '').trim());
  }
  return { rows, dup };
}

const tunables = collectTunables();
const { rows, dup } = parseDoc();
const tunablePaths = new Set(tunables.map((t) => t.path));

console.log('\n[1] 参数依据表：每个可调数值都有条目，且现值与配置一致');
{
  const missing = tunables.filter((t) => !rows.has(t.path)).map((t) => t.path);
  check('全部 ' + tunables.length + ' 个可调参数都有依据条目', missing.length === 0,
    missing.length ? '缺 ' + missing.length + ' 条：' + missing.slice(0, 6).join(' / ') +
      (missing.length > 6 ? ' …' : '') : tunables.length + ' 条全覆盖');

  const mismatch = tunables.filter((t) => rows.has(t.path) && Number(rows.get(t.path)) !== t.value)
    .map((t) => t.path + '：配置 ' + t.value + ' / 文档 ' + rows.get(t.path));
  check('依据表里的「现值」与 exercises.json 完全一致', mismatch.length === 0,
    mismatch.length ? mismatch.slice(0, 6).join('；') : '一致');

  const stale = [...rows.keys()].filter((k) => !tunablePaths.has(k));
  check('依据表里没有指向已不存在参数的残留行', stale.length === 0,
    stale.length ? stale.join(' / ') : '无残留');

  check('依据表里没有重复路径', dup.length === 0, dup.length ? dup.join(' / ') : '无重复');
}

console.log('\n[2] 每个信号要么被判定逻辑引用，要么显式标 debugOnly');
{
  const problems = [];
  for (const [id, ex] of Object.entries(EX)) {
    const used = new Set();
    const ref = (s) => { if (s) used.add(s); };
    ref(ex.primary);
    if (ex.fsm) {
      ref(ex.fsm.signal);
      for (const g of ex.fsm.guards || []) ref(g.signal);
    }
    if (ex.hold) for (const c of ex.hold.conditions || []) ref(c.signal);
    for (const ch of ex.channels || []) ref(ch.signal);
    for (const [name, def] of Object.entries(ex.signals || {})) {
      if (used.has(name)) continue;
      if (def.debugOnly) continue;
      problems.push(id + '.' + name);
    }
  }
  check('没有「没人读也没声明」的死信号（历史上 hipDrop 就是这样混进来的）',
    problems.length === 0, problems.length ? problems.join(' / ') : '7 个动作全部干净');
}

console.log('\n[3] 结构自洽：信号类型 / side / 引用完整性');
{
  const badType = [];
  const badSide = [];
  const badRef = [];
  const SIDES = new Set(['left', 'right', 'min', 'max', 'mean', 'auto']);
  for (const [id, ex] of Object.entries(EX)) {
    for (const [name, def] of Object.entries(ex.signals || {})) {
      if (!SIGNAL_TYPES[def.type]) badType.push(id + '.' + name + ' → ' + def.type);
      if (def.side && !SIDES.has(def.side)) badSide.push(id + '.' + name + ' → ' + def.side);
    }
    const names = new Set(Object.keys(ex.signals || {}));
    const refs = [];
    if (ex.primary) refs.push(['primary', ex.primary]);
    if (ex.fsm) {
      refs.push(['fsm.signal', ex.fsm.signal]);
      (ex.fsm.guards || []).forEach((g, i) => refs.push(['fsm.guards.' + i, g.signal]));
    }
    if (ex.hold) (ex.hold.conditions || []).forEach((c, i) => refs.push(['hold.conditions.' + i, c.signal]));
    (ex.channels || []).forEach((c, i) => refs.push(['channels.' + i, c.signal]));
    for (const [where, s] of refs) if (!names.has(s)) badRef.push(id + '.' + where + ' → ' + s);
  }
  check('所有 signal type 都已注册', badType.length === 0, badType.length ? badType.join(' / ') : Object.keys(SIGNAL_TYPES).length + ' 种类型');
  check('所有 side 取值合法（含新增的 auto）', badSide.length === 0, badSide.length ? badSide.join(' / ') : '合法');
  check('primary / fsm / guards / hold / channels 引用的信号都存在', badRef.length === 0, badRef.length ? badRef.join(' / ') : '引用完整');
}

console.log('\n[4] 保持类参数的硬约束（量级不能混）');
{
  const bad = [];
  for (const [id, ex] of Object.entries(EX)) {
    if (!ex.hold) continue;
    const h = ex.hold;
    if (h.sessionGapMs < h.breakGraceMs) bad.push(id + '：sessionGapMs < breakGraceMs');
    if (h.sessionTimeoutMs <= h.sessionGapMs) bad.push(id + '：sessionTimeoutMs ≤ sessionGapMs');
    if (h.minSessionMs >= h.sessionTimeoutMs) bad.push(id + '：minSessionMs ≥ sessionTimeoutMs');
  }
  check('分段间隔 ≥ 抖动宽限、超时 > 分段间隔、最短段 < 超时', bad.length === 0,
    bad.length ? bad.join(' / ') : '两个保持类动作都自洽');
}

console.log('\n[5] 七个动作都能建出追踪器，且首帧读数为 0');
{
  const bad = [];
  for (const [id, ex] of Object.entries(EX)) {
    try {
      const tr = createTracker(ex);
      const mode = modeOf(ex);
      if (mode !== (ex.category === 'hold' ? 'hold' : 'reps')) bad.push(id + '：mode 不符');
      const snap = tr.snapshot();
      // 计数类看 count，保持类看 totalMs / sessionCount（两种快照形状不同）
      const dirty = mode === 'hold'
        ? snap.totalMs !== 0 || snap.sessionCount !== 0
        : snap.count !== 0;
      if (dirty) bad.push(id + '：初始读数非 0');
    } catch (e) {
      bad.push(id + '：' + (e && e.message ? e.message : e));
    }
  }
  check('七个动作配置自洽', bad.length === 0, bad.length ? bad.join(' / ') : Object.keys(EX).length + ' 个动作全部通过');
}

/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('配置回归：' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + '  :: ' + f.detail);
}
if (VERBOSE) {
  console.log('\n可调参数清单：');
  for (const t of tunables) console.log('  ' + t.path + ' = ' + t.value);
}
console.log('='.repeat(64) + '\n');
process.exit(failed.length ? 1 : 0);
