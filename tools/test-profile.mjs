/**
 * test-profile.mjs — 自校准 profile 回归（node 直跑，无浏览器）
 *
 * 这一层最容易出两类静默故障：
 *   1. 换算把已调好的绝对值悄悄改了（没人会发现，因为"看起来动了"）
 *   2. 校准数据本身是垃圾，但被当成好数据用（满程学成噪声跨度 → 怎么动都算）
 * 所以下面的断言一半在证伪：
 *   ★ 恒等性：满程 == 参考满程时，算出来必须一模一样的原值
 *   ★ 方向性：学生满程小 → 阈值只能往"更容易"走，反向就是符号搞错了
 *   ★ guards 绝对不动（它们表达的是"姿势要求"，不随身材缩放）
 *
 * 用法：node tools/test-profile.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  learnProfile, deriveThresholds, applyProfile, describeProfile, isProfileUsable,
  ProfileStore, memoryStorage, MIN_SAMPLES,
} from '../shared/tpc-profile.js';
import { createTracker } from '../shared/tpc-counter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ALL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'exercises.json'), 'utf8'));
const EX = ALL.exercises;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  :: ' + detail : ''));
}
const clone = (o) => JSON.parse(JSON.stringify(o));

/** 造一份"正好等于参考满程"的 profile（用来验恒等性） */
function profileAt(ex, p2, p98) {
  return {
    schema: 'spc-profile/1', signal: ex.calibration.signal, learnedAt: 1,
    samples: 90, seconds: 3, p2, p98, range: +(p98 - p2).toFixed(3), reversals: 5,
    quality: { ok: true, reasons: [] },
  };
}

/* ================================================================= */
console.log('\n[1] 恒等性：满程等于参考满程时，阈值必须原封不动');

{
  let bad = [];
  let total = 0;
  for (const [id, ex] of Object.entries(EX)) {
    if (!ex.calibration) continue;
    const p = profileAt(ex, ex.calibration.refRange.min, ex.calibration.refRange.max);
    for (const d of deriveThresholds(ex, p)) {
      total++;
      if (d.to !== d.from) bad.push(id + '.' + d.path + ' ' + d.from + '→' + d.to);
    }
  }
  check('★ 五个动作的每一条阈值都等于原值（校准不会偷偷改参数）',
    bad.length === 0, bad.length ? bad.join(' / ') : total + ' 条全部恒等');

  const applied = applyProfile(EX.squat, profileAt(EX.squat, 70, 175));
  check('套上之后配置与原文完全相同（深进深比较）',
    JSON.stringify(applied.fsm.phases) === JSON.stringify(EX.squat.fsm.phases), '');
}

/* ================================================================= */
console.log('\n[2] 方向性：学生满程更小 → 阈值只能更宽容（不能反向）');

{
  const ex = EX.squat;               // stand.gte 158 / bottom.lte 100
  const kid = profileAt(ex, 90, 165); // 满程 75（成人参考 105）
  const got = {};
  for (const d of deriveThresholds(ex, kid)) got[d.path] = d.to;

  check('★ 站立阈值变小（原本要伸直 158°，这孩子 152.9° 就算站直）',
    got['phases.stand.enter.gte'] < 158, got['phases.stand.enter.gte'] + ' < 158');
  check('★ 下蹲阈值变大（原本要蹲到 100°，这孩子蹲到 111.4° 就算一次）',
    got['phases.bottom.enter.lte'] > 100, got['phases.bottom.enter.lte'] + ' > 100');
  check('宽松阈值也一起变大（136° → 137.1°），两者步调一致',
    got['loose.phases.bottom.enter.lte'] > 136, String(got['loose.phases.bottom.enter.lte']));

  const big = profileAt(ex, 65, 180);  // 满程 115，比成人还大
  const got2 = {};
  for (const d of deriveThresholds(ex, big)) got2[d.path] = d.to;
  check('反过来：满程更大的学生阈值更严（不能只顾一个方向）',
    got2['phases.stand.enter.gte'] > 158 && got2['phases.bottom.enter.lte'] < 100,
    got2['phases.stand.enter.gte'] + ' / ' + got2['phases.bottom.enter.lte']);
}

/* ================================================================= */
console.log('\n[3] 严格 / 宽松 / 合格的相对关系不能因为换算而错乱');

{
  let bad = [];
  for (const [id, ex] of Object.entries(EX)) {
    if (!ex.calibration) continue;
    for (const [label, p2, p98] of [['小个子', 90, 165], ['大个子', 65, 180]]) {
      const p = profileAt(ex, p2, p98);
      const got = {};
      for (const d of deriveThresholds(ex, p)) got[d.path] = d.to;
      const cycle = ex.fsm.cycle;
      const end = cycle[cycle.length - 1];
      const strict = got['phases.' + end + '.enter.gte'] !== undefined
        ? got['phases.' + end + '.enter.gte'] : got['phases.' + end + '.enter.lte'];
      const loose = got['loose.phases.' + end + '.enter.gte'] !== undefined
        ? got['loose.phases.' + end + '.enter.gte'] : got['loose.phases.' + end + '.enter.lte'];
      const isGte = got['phases.' + end + '.enter.gte'] !== undefined;
      // 末相若用 gte（越大越难），宽松应该更小；用 lte 则宽松应该更大
      const ok = isGte ? loose < strict : loose > strict;
      if (!ok) bad.push(id + '/' + label + '：严格 ' + strict + ' 宽松 ' + loose);
    }
  }
  check('★ 换算后宽松仍是宽松（不会被压到比严格还严，那等于悄悄关掉宽松）',
    bad.length === 0, bad.length ? bad.join(' / ') : '五个动作 × 两档身材全部成立');

  // qualify 与严格计数线取同一个 t，换算后必然同值 —— 这是设计意图，不是巧合
  const p = profileAt(EX.squat, 90, 165);
  const got = {};
  for (const d of deriveThresholds(EX.squat, p)) got[d.path] = d.to;
  check('合格线与严格计数线换算后仍然同值（「合格」= 达到自己的严格线）',
    got['qualify.signalMin.lte'] === got['phases.bottom.enter.lte'],
    got['qualify.signalMin.lte'] + ' vs ' + got['phases.bottom.enter.lte']);
}

/* ================================================================= */
console.log('\n[4] guards 与时间类参数绝对不能动');

{
  const before = JSON.stringify(EX.squat.fsm.guards);
  const applied = applyProfile(EX.squat, profileAt(EX.squat, 90, 165));
  check('★ 深蹲「下蹲时躯干前倾过大」等 guards 一字未改',
    JSON.stringify(applied.fsm.guards) === before, applied.fsm.guards.length + ' 条');
  check('★ 俯卧撑「没有完全撑直」这条幅度 guard 也没被缩放（它与 qualify 同源，见文档已知问题）',
    JSON.stringify(applyProfile(EX.pushup, profileAt(EX.pushup, 110, 145)).fsm.guards) ===
      JSON.stringify(EX.pushup.fsm.guards), '');

  const a = applyProfile(EX.squat, profileAt(EX.squat, 90, 165));
  check('minRepMs / maxRepMs / minHoldFrames 不动（它们与身材无关）',
    a.fsm.minRepMs === EX.squat.fsm.minRepMs && a.fsm.maxRepMs === EX.squat.fsm.maxRepMs &&
    a.fsm.minHoldFrames === EX.squat.fsm.minHoldFrames, '');
  check('phaseMaxDwellMs 不动（那是节奏要求，不是幅度要求）',
    JSON.stringify(a.fsm.phaseMaxDwellMs) === JSON.stringify(EX.squat.fsm.phaseMaxDwellMs), '');
}

/* ================================================================= */
console.log('\n[5] 不该生效的时候必须一动不动');

{
  const ex = EX.squat;
  const a = applyProfile(ex, profileAt(ex, 90, 165));
  check('入参没被改（原对象的阈值还是 158/100）',
    ex.fsm.phases.stand.enter.gte === 158 && ex.fsm.phases.bottom.enter.lte === 100, '');
  check('返回的是新对象', a !== ex && a.fsm !== ex.fsm, '');

  check('没有 profile → 零差异', deriveThresholds(ex, null).length === 0, '');
  check('profile 质量不合格 → 零差异（宁可不校准，也不能用垃圾数据）',
    deriveThresholds(ex, { ...profileAt(ex, 90, 165), quality: { ok: false, reasons: ['幅度太小'] } }).length === 0, '');
  check('计时动作没有 calibration 段 → 零差异',
    deriveThresholds(EX.wall_sit, profileAt(ex, 90, 165)).length === 0, '');
  check('没有 calibration 段时 applyProfile 返回等价副本（调用方不必分情况）',
    JSON.stringify(applyProfile(EX.wall_sit, null)) === JSON.stringify(EX.wall_sit), '');
}

/* ================================================================= */
console.log('\n[6] 学满程：抗离群、闸门、起落计数');

{
  // 方波：170 → 80 来回 3 次，一个坏帧掉到 5°
  const build = (n, lo, hi, junk) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push((Math.floor(i / 12) % 2 === 0) ? hi : lo);
    if (junk !== undefined) out[Math.floor(n / 3)] = junk;
    return out;
  };
  const spec = EX.squat.calibration;

  const clean = learnProfile(build(120, 80, 170), spec);
  check('干净数据：满程 ≈ 90，质量合格',
    clean.quality.ok && Math.abs(clean.range - 90) <= 2, 'range=' + clean.range);
  check('数到了多次起落', clean.reversals >= 4, 'reversals=' + clean.reversals);

  const dirty = learnProfile(build(120, 80, 170, 5), spec);
  check('★ 一个坏帧掉到 5° 也没把满程拉飞（取 p2/p98 而不是 min/max）',
    Math.abs(dirty.range - 90) <= 6, 'range=' + dirty.range + '（不抗离群的话会是 165）');
  check('坏帧也不改变质量结论', dirty.quality.ok === true, '');

  const few = learnProfile(build(10, 80, 170), spec);
  check('样本太少 → 不合格，并说明原因',
    !few.quality.ok && /样本太少/.test(few.quality.reasons.join('')), few.quality.reasons.join('；'));

  const tiny = learnProfile(build(120, 140, 152), spec);
  check('★ 只动了 12° → 不合格（否则学出来的满程是噪声，之后怎么动都算一次）',
    !tiny.quality.ok && /幅度太小/.test(tiny.quality.reasons.join('')), tiny.quality.reasons.join('；'));

  const still = learnProfile(new Array(MIN_SAMPLES * 3).fill(160), spec);
  check('★ 站着不动 → 没有起落，不合格', !still.quality.ok && /完整动作/.test(still.quality.reasons.join('')), still.quality.reasons.join('；'));

  // 抖动：幅度只有满程的 10%。迟滞带是相对的，纯抖动时"满程"也被抖动撑大，
  // 所以起落计数拦不住它 —— 真正的闸门是 minRange 这个绝对下限。这一条是显式量化。
  const jitter = [];
  for (let i = 0; i < 120; i++) jitter.push(120 + (i % 2 ? 4 : -4));
  const j = learnProfile(jitter, spec);
  check('★ 纯抖动靠 minRange 拦住（起落计数拦不住：抖动本身就把满程撑大了）',
    !j.quality.ok && /幅度太小/.test(j.quality.reasons.join('')),
    'range=' + j.range + '，reversals=' + j.reversals + '，原因：' + j.quality.reasons[0]);

  check('null / 非数字被跳过（画面里没人时信号是 null）',
    learnProfile([null, undefined, NaN, ...build(120, 80, 170)].slice(0, 130), spec).quality.ok === true, '');
  check('isProfileUsable 对不合格的 profile 返回 false', !isProfileUsable(tiny), '');
}

/* ================================================================= */
console.log('\n[7] 学出来的 profile 真能驱动出可用的追踪器');

{
  const ex = EX.squat;
  // 学生满程 110°–168°：最低只到 110°，够不到原配置的 100° 线 —— 这就是"明明做对了却不计数"
  const build = () => {
    const out = [];
    for (let i = 0; i < 120; i++) out.push((Math.floor(i / 12) % 2 === 0) ? 168 : 110);
    return out;
  };
  const p = learnProfile(build(), ex.calibration);
  const applied = applyProfile(ex, p);

  const tr = createTracker(applied, { loose: true });
  const snap0 = tr.snapshot();
  check('套了 profile 的配置能建出追踪器，初始读数为 0',
    snap0.count === 0 && snap0.qualifiedCount === 0, '');

  // 学生按自己学到的幅度做 5 次（半程 600ms，过得了 minRepMs 400）
  const ACT = [166, 166, 166, 110, 110, 110, 166, 166, 166, 166];
  const feed = (tracker) => {
    let t = 0;
    for (let r = 0; r < 5; r++) {
      for (const v of ACT) {
        tracker.update({ values: { kneeAngle: v }, confidence: { kneeAngle: 1 }, tMs: (t += 200) });
      }
    }
  };
  feed(tr);
  const snap = tr.snapshot();
  check('★ 按自己学到的幅度做 5 次 → 数到 5 次（用成人阈值是 0 次）',
    snap.count === 5, 'count=' + snap.count);
  check('★ 并且 5 次全部合格（合格线也跟着换算到了本人尺度）',
    snap.qualifiedCount === 5 && snap.qualifyRate === 1,
    snap.qualifiedCount + '/' + snap.count);

  // 对照：同一串数据用原配置 —— 110° 碰不到 100° 的线
  const tr0 = createTracker(ex, { loose: false });
  feed(tr0);
  check('对照组：不校准时同一串动作一次都不算（这就是要校准的原因）',
    tr0.snapshot().count === 0, 'count=' + tr0.snapshot().count);
}

/* ================================================================= */
console.log('\n[8] 存档：学生的校准结果要能存、能取、能带走');

{
  const st = new ProfileStore(memoryStorage());
  const p = profileAt(EX.squat, 90, 165);

  check('空存档读出空列表', st.list().length === 0, '');
  st.save('s01', '小明', 'squat', p);
  st.save('s01', '小明', 'pushup', profileAt(EX.pushup, 110, 145));
  st.save('s02', '小红', 'squat', profileAt(EX.squat, 95, 168));

  check('存两份后列表有两个人', st.list().length === 2, st.list().map((s) => s.label).join(' / '));
  check('同一个人两个动作都记着',
    st.list().filter((s) => s.id === 's01')[0].exercises.sort().join(',') === 'pushup,squat', '');
  check('取回来还是那份数据', st.get('s01', 'squat').p2 === 90, '');
  check('取不存在的动作给 null（不是 undefined，界面判空更省事）',
    st.get('s01', 'situp') === null, '');
  // 排序按 updatedAt 降序。上面三次 save 可能落在同一毫秒，用显式时间戳单独验，
  // 免得把"机器快"当成"排序对"。
  const stOrder = new ProfileStore(memoryStorage());
  stOrder.import({ students: {
    old: { label: '旧', updatedAt: 1000, ex: {} },
    neu: { label: '新', updatedAt: 2000, ex: {} },
  } });
  check('最近更新的排在前面', stOrder.list()[0].id === 'neu', stOrder.list().map((s) => s.id).join(','));

  const dump = st.export();
  const st2 = new ProfileStore(memoryStorage());
  st2.import(dump);
  check('导出再导入，两个人的档案都还在', st2.list().length === 2 && st2.get('s01', 'squat').p2 === 90, '');

  st.removeExercise('s01', 'squat');
  check('删掉一个动作，另一个动作留着', st.get('s01', 'squat') === null && !!st.get('s01', 'pushup'), '');
  st.remove('s01');
  check('删掉学生，整条记录消失', st.list().length === 1, '');

  const bad = new ProfileStore({
    getItem: () => '{这不是 JSON',
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {},
  });
  check('存档坏了不崩，退回空档案并记下错误',
    bad.list().length === 0 && !!bad.lastError, String(bad.lastError && bad.lastError.message).slice(0, 24));

  check('导入垃圾数据会明确报错（而不是静默清空）', (() => {
    try { new ProfileStore(memoryStorage()).import({ foo: 1 }); return false; }
    catch (e) { return /不是校准存档/.test(e.message); }
  })(), '');
}

/* ================================================================= */
console.log('\n[9] 措辞与数值：界面和运行记录用同一句话，且不出现浮点尾巴');

{
  const p = profileAt(EX.squat, 90, 165);
  const text = describeProfile(p, EX.squat.calibration);
  check('描述里带上满程、上下限、起落次数',
    /满程 75°/.test(text) && /90°–165°/.test(text) && /起落/.test(text), '"' + text + '"');
  check('未校准 / 数据不合格时说「未校准」，不显示一串 null',
    describeProfile(null) === '未校准' && describeProfile({ quality: { ok: false } }) === '未校准', '');

  const applied = applyProfile(EX.squat, p);
  const flat = JSON.stringify(applied.fsm);
  check('★ 换算结果没有浮点尾巴（53.000000000000004 这种）',
    !/\d\.\d{5,}/.test(flat), (flat.match(/\d+\.\d{5,}/) || ['无'])[0]);
  check('_profile 记下了来路（谁校准的、改了几项）',
    applied._profile && applied._profile.applied === 4, JSON.stringify(applied._profile));
  check('没有 profile 时不写 _profile（避免运行记录里出现空对象）',
    applyProfile(EX.squat, null)._profile === undefined, '');
}

/* ================================================================= */

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('自校准回归：' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + '  :: ' + f.detail);
}
console.log('='.repeat(64) + '\n');
process.exit(failed.length ? 1 : 0);
