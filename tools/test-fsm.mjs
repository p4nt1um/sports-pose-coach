/**
 * test-fsm.mjs — 计数状态机回归测试（node 直跑，不需要摄像头与模型）
 *
 * 为什么能这么测：特征层 + 状态机都不认识关键点，只吃一维数值。
 * 于是可以把「标准深蹲 30 次」「静立 60 秒」「走动 30 秒」这些验收场景
 * 合成为一维信号曲线，直接喂给状态机看它数成几次。
 *
 * 这比"录视频跑一遍"更严格：可以精确构造边界情况（阈值附近反复抖动、
 * 单帧尖峰、半蹲、蹲住不动、中途丢失…），而且结果可重复。
 *
 * 用法： node sports-pose-coach/tools/test-fsm.mjs [--verbose]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PhaseFsm, REJECT, activeWindowMs } from '../shared/tpc-fsm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.indexOf('--verbose') !== -1;

const all = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'exercises.json'), 'utf8'));
const SQUAT = all.exercises.squat;
const CFG = SQUAT.fsm;

/* ------------------------------ 合成信号 ------------------------------ */

/** 可复现的伪随机（避免每次跑出来的噪声不同，导致"这次过了"无法复现） */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

/**
 * 生成一段深蹲信号。
 * 每个周期内：下降 → 底部保持 → 上升 → 顶部保持，用余弦缓动，接近真人节奏。
 */
function squatSignal(opts) {
  const {
    reps = 0,
    periodMs = 2000,
    fps = 30,
    top = 172,
    bottom = 85,
    holdBottomMs = 0,
    holdTopMs = 0,
    preMs = 1000,
    postMs = 1000,
    noiseDeg = 0,
    seed = 1,
    startAngle = null,
  } = opts;

  const rand = rng(seed);
  const dt = 1000 / fps;
  const frames = [];
  const motionMs = Math.max(1, periodMs - holdBottomMs - holdTopMs);
  const half = motionMs / 2;
  const totalMs = preMs + reps * periodMs + (reps ? 0 : 1) * 0 + postMs;

  const angleAt = (tMs) => {
    const local = tMs - preMs;
    if (local < 0 || local >= reps * periodMs) return top;
    const tl = local % periodMs;
    let d;
    if (tl < half) d = ease(tl / half);
    else if (tl < half + holdBottomMs) d = 1;
    else if (tl < half + holdBottomMs + half) d = 1 - ease((tl - half - holdBottomMs) / half);
    else d = 0;
    return top - (top - bottom) * d;
  };

  for (let t = 0; t <= totalMs; t += dt) {
    const a = angleAt(t);
    const noise = noiseDeg ? (rand() * 2 - 1) * noiseDeg : 0;
    frames.push({ tMs: t, value: a + noise, conf: 1 });
  }
  if (startAngle !== null) frames[0].value = startAngle;
  return frames;
}

/** 任意函数的信号 */
function signal(fn, opts = {}) {
  const { durationMs = 10000, fps = 30, noiseDeg = 0, seed = 7, conf = 1, confFn = null } = opts;
  const rand = rng(seed);
  const dt = 1000 / fps;
  const frames = [];
  for (let t = 0; t <= durationMs; t += dt) {
    const noise = noiseDeg ? (rand() * 2 - 1) * noiseDeg : 0;
    frames.push({ tMs: t, value: fn(t) + noise, conf: confFn ? confFn(t) : conf });
  }
  return frames;
}

/* ------------------------------ 跑状态机 ------------------------------ */

function run(frames, cfg = CFG) {
  const fsm = new PhaseFsm(cfg);
  const counts = [];
  for (const f of frames) {
    const snap = fsm.update({
      values: { [cfg.signal]: f.value },
      confidence: { [cfg.signal]: f.conf == null ? 1 : f.conf },
      tMs: f.tMs,
    });
    for (const ev of snap.events) {
      if (ev.type === 'count') counts.push({ tMs: ev.tMs, durationMs: ev.durationMs, min: ev.signalMin });
    }
  }
  return { fsm, counts };
}

/* ------------------------------ 断言 ------------------------------ */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  :: ' + detail : ''));
}

function expectCount(name, { frames, want, tol = 0, cfg = CFG, extra }) {
  const { fsm, counts } = run(frames, cfg);
  const got = fsm.count;
  const ok = Math.abs(got - want) <= tol;
  const durs = counts.map((c) => Math.round(c.durationMs));
  let detail = '期望 ' + want + (tol ? '±' + tol : '') + '，实得 ' + got;
  if (durs.length) detail += '；完成段 ' + Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) + 'ms';
  if (VERBOSE && fsm.rejections) {
    detail += '；拒绝 ' + JSON.stringify(fsm.rejections);
  }
  if (extra) {
    const ex = extra(fsm, counts);
    if (ex) detail += '；' + ex;
  }
  check(name, ok, detail);
  return { fsm, counts, ok };
}

console.log('== 深蹲计数状态机回归 （node，无摄像头/无模型）==');
console.log('   配置：minRepMs=' + CFG.minRepMs + ' maxRepMs=' + CFG.maxRepMs +
  ' minHoldFrames=' + CFG.minHoldFrames + ' 相位阈值 ' +
  JSON.stringify(CFG.phases) + '\n');

console.log('[1] 正常计数与深度判据');
expectCount('标准深蹲 30 次（2s/次，172°→85°）', {
  frames: squatSignal({ reps: 30, periodMs: 2000 }),
  want: 30,
});
expectCount('标准深蹲 30 次 + 传感器噪声 ±2°', {
  frames: squatSignal({ reps: 30, periodMs: 2000, noiseDeg: 2, seed: 11 }),
  want: 30, tol: 1,
});
expectCount('30 次「半蹲」（只到 132°）→ 一次都不算', {
  frames: squatSignal({ reps: 30, periodMs: 2000, bottom: 132 }),
  want: 0,
});
expectCount('深浅交替：30 次到位 + 10 次半蹲', {
  frames: [].concat(
    squatSignal({ reps: 10, periodMs: 2000, top: 172, bottom: 85 }),
    squatSignal({ reps: 5, periodMs: 2000, top: 172, bottom: 132 }),
    squatSignal({ reps: 10, periodMs: 2000, top: 172, bottom: 85 }),
    squatSignal({ reps: 5, periodMs: 2000, top: 172, bottom: 132 }),
    squatSignal({ reps: 10, periodMs: 2000, top: 172, bottom: 85 })
  ),
  want: 30, tol: 1,
});
expectCount('15fps 采样下的 30 次（采样率鲁棒性）', {
  frames: squatSignal({ reps: 30, periodMs: 2000, fps: 15 }),
  want: 30,
});
expectCount('20fps 采样下的 30 次', {
  frames: squatSignal({ reps: 30, periodMs: 2000, fps: 20 }),
  want: 30,
});

console.log('\n[2] 误计数：这些都必须为 0');
expectCount('静立 60 秒（172° + ±1.5° 噪声）', {
  frames: signal((t) => 172, { durationMs: 60000, noiseDeg: 1.5, seed: 3 }),
  want: 0,
});
expectCount('走动 30 秒（膝角 150°~175° 摆动）', {
  frames: signal((t) => 162.5 + 12.5 * Math.sin((2 * Math.PI * t) / 1100), { durationMs: 30000 }),
  want: 0,
});
expectCount('在站立阈值附近反复抖动（155°↔162°）', {
  frames: signal((t) => 158.5 + 3.5 * Math.sin((2 * Math.PI * t) / 500), { durationMs: 20000 }),
  want: 0,
});
expectCount('在死区内来回（110°↔150°，不进任何相位区间）', {
  frames: signal((t) => 130 + 20 * Math.sin((2 * Math.PI * t) / 1600), { durationMs: 20000 }),
  want: 0,
});
expectCount('单帧尖峰：静立中偶发跌到 80° 又立刻回弹', {
  frames: (() => {
    const f = signal((t) => 172, { durationMs: 20000 });
    for (let i = 30; i < f.length; i += 47) f[i].value = 80;   // 孤立单帧
    return f;
  })(),
  want: 0,
});
expectCount('过快抖动：250ms 一次全幅度（快于 minRepMs）', {
  frames: squatSignal({ reps: 40, periodMs: 250 }),
  want: 0,
});
expectCount('蹲下后停住 10 秒才站起（>maxRepMs，判为停住不动）', {
  frames: squatSignal({ reps: 1, periodMs: 10500, holdBottomMs: 9000 }),
  want: 0,
  extra: (fsm) => '拒绝明细 ' + JSON.stringify(fsm.rejections),
});
expectCount('开局就蹲着，随后站起来（只有半个动作）', {
  frames: squatSignal({ reps: 1, periodMs: 2000, preMs: 0, postMs: 500 }).map((f, i, arr) =>
    i < 8 ? { ...f, value: 88 } : f
  ),
  want: 0,
  extra: (fsm) => '拒绝明细 ' + JSON.stringify(fsm.rejections),
});

console.log('\n[3] 数据丢失与低置信度');
expectCount('3 次 → 丢失 1 秒 → 再 3 次（丢失不产生幽灵计数）', {
  frames: (() => {
    const a = squatSignal({ reps: 3, periodMs: 2000 });
    const gapStart = a[a.length - 1].tMs;
    const gap = [];
    for (let t = gapStart + 33; t < gapStart + 1000; t += 33) gap.push({ tMs: t, value: null, conf: 0 });
    const b = squatSignal({ reps: 3, periodMs: 2000 }).map((f) => ({ ...f, tMs: f.tMs + gapStart + 1000 }));
    return a.concat(gap, b);
  })(),
  want: 6,
  extra: (fsm) => '丢失复位次数 ' + fsm.events.filter((e) => e.type === 'reset').length,
});
expectCount('每 5 帧插 1 帧低置信度，30 次仍应数满', {
  frames: squatSignal({ reps: 30, periodMs: 2000 }).map((f, i) => (i % 5 === 4 ? { ...f, conf: 0.2 } : f)),
  want: 30, tol: 2,
});
expectCount('连续 300ms 低置信度（未达复位阈值）不打断计数', {
  frames: squatSignal({ reps: 30, periodMs: 2000 }).map((f) => {
    const inGap = (f.tMs % 2000) > 300 && (f.tMs % 2000) <= 600;
    return inGap ? { ...f, conf: 0.1 } : f;
  }),
  want: 30, tol: 2,
});

console.log('\n[4] 与真人节奏的匹配度');
for (const [label, periodMs] of [['慢速 3.5s', 3500], ['中速 2.0s', 2000], ['快速 1.2s', 1200]]) {
  expectCount('真人节奏 ' + label + '，20 次', {
    frames: squatSignal({ reps: 20, periodMs }),
    want: 20,
  });
}
expectCount('底部停留 1.5 秒的 10 次（未超 1.8s 阈值，不打标记）', {
  frames: squatSignal({ reps: 10, periodMs: 3000, holdBottomMs: 1500 }),
  want: 10,
  extra: (fsm) => {
    const flagged = fsm.events.filter((e) => e.type === 'count').length;
    return '计数事件 ' + flagged;
  },
});

console.log('\n[5] 单信号局限的显式标记（不假装能分辨）');
{
  // 坐下 3 秒再站起：膝角曲线与深蹲相似，但底部停留异常长
  const frames = squatSignal({ reps: 1, periodMs: 4500, holdBottomMs: 3000, preMs: 1000, postMs: 800 });
  const { fsm } = run(frames);
  const rep = fsm.lastRep;
  const hasDwellFlag = !!(rep && rep.flags && rep.flags.some((f) => f.signal === 'dwellMs'));
  check('「坐下 3 秒再站起」被打上底部停留过久的标记', hasDwellFlag,
    '计数值 ' + fsm.count + '，标记 ' + JSON.stringify(rep && rep.flags ? rep.flags.map((f) => f.label) : []));
}

{
  const frames = squatSignal({ reps: 5, periodMs: 2000 });
  const { fsm } = run(frames);
  const rep = fsm.lastRep;
  check('正常深蹲不打任何标记', !!(rep && rep.flags && rep.flags.length === 0),
    '标记 ' + JSON.stringify(rep && rep.flags ? rep.flags.map((f) => f.label) : []));
}

console.log('\n[6] 状态机不变量');
{
  const { fsm, counts } = run(squatSignal({ reps: 10, periodMs: 2000 }));
  check('计数事件数与 count 一致', counts.length === fsm.count, counts.length + ' vs ' + fsm.count);
  check('每次计数都有正周期', counts.every((c) => c.durationMs > 0),
    counts.map((c) => Math.round(c.durationMs)).join(','));
  check('每轮都记录到主信号最小值（用于回看蹲到位没有）',
    counts.every((c) => c.min !== null && c.min < CFG.phases.bottom.enter.lte),
    counts.map((c) => (c.min === null ? 'null' : Math.round(c.min))).join(','));
  check('结束后相位回到起始相位', fsm.phase === CFG.cycle[0], fsm.phase);
  check('结束后 armed 复位（防下一轮白送计数）', fsm.armed === false, String(fsm.armed));
}

console.log('\n[7] 参数鲁棒性：阈值整体挪动 ±10° 仍能数准');
for (const shift of [-10, 10]) {
  const cfg = JSON.parse(JSON.stringify(CFG));
  cfg.phases.stand.enter.gte += shift;
  cfg.phases.bottom.enter.lte += shift;
  expectCount('阈值整体 ' + (shift > 0 ? '+' : '') + shift + '° 后，30 次仍数准', {
    frames: squatSignal({ reps: 30, periodMs: 2000, top: 172 + shift / 2, bottom: 85 + shift / 2 }),
    want: 30, cfg,
  });
}

console.log('\n[8] 向心/离心拆解：先单测那一小块算法');
{
  const mk = (pairs) => pairs.map(([t, v]) => ({ t, v }));

  // 「动 → 停 → 动」：中间 2 秒停顿必须被剔掉。
  // 注意后半段要造得**明显更快**（250/s vs 100/s）：两段等速时峰值并列，
  // 算法只能挑一段，这不是缺陷而是必然 —— 等速的两段本来就无从区分。
  const dwell = mk([
    [0, 0], [100, 10], [200, 20], [300, 30], [400, 40], [500, 50],
    [600, 60], [700, 70], [800, 80], [900, 90], [1000, 100],
    [1100, 100], [1300, 100], [1500, 100], [1700, 100], [1900, 100],
    [2100, 100], [2300, 100], [2500, 100], [2700, 100], [2900, 100], [3000, 100],
    [3100, 135], [3200, 160], [3300, 185], [3400, 210], [3500, 235], [3600, 260],
  ]);
  const d = activeWindowMs(dwell);
  check('「动 1s → 停 2s → 动 0.6s」只认最后 0.6s', d.activeMs === 600 && d.rawMs === 3600,
    'activeMs=' + d.activeMs + ' rawMs=' + d.rawMs);

  // 匀速：整段都在动，不能凭空砍掉一段
  const steady = activeWindowMs(mk(Array.from({ length: 31 }, (_, i) => [i * 100, i * 10])));
  check('匀速运动时 activeMs 覆盖整段（不凭空截断）',
    steady.activeMs === steady.rawMs && steady.rawMs === 3000,
    'activeMs=' + steady.activeMs + ' rawMs=' + steady.rawMs);

  // 一动不动：返回 null 而不是 0 —— 「没动」与「动了 0 毫秒」是两件事
  const still = activeWindowMs(mk(Array.from({ length: 30 }, (_, i) => [i * 100, 100])));
  check('全程不动时返回 null（不假装测到 0）',
    still.activeMs === null && still.peakRate === 0,
    'activeMs=' + still.activeMs + ' peakRate=' + still.peakRate);

  check('样本太少时优雅降级（2 个点算不出速度）',
    activeWindowMs(mk([[0, 0], [100, 5]])).activeMs === null &&
    activeWindowMs(mk([[0, 0], [100, 5]])).rawMs === 100 &&
    activeWindowMs([]).rawMs === 0 &&
    activeWindowMs(null).activeMs === null, '4 种退化输入都没有异常');
}

console.log('\n[9] 节奏拆解端到端：底部停顿不属于任何一半');
{
  const back = (r) => r.transitions[0];
  const forth = (r) => r.transitions[1];

  const plain = run(squatSignal({ reps: 5, periodMs: 2000 })).fsm.lastRep;
  check('无停顿：两个半程都拆出来，且与原始时长接近',
    !!plain && Array.isArray(plain.transitions) && plain.transitions.length === 2 &&
    Math.abs(back(plain).rawMs - back(plain).activeMs) <= 350 &&
    Math.abs(forth(plain).rawMs - forth(plain).activeMs) <= 350,
    '下放 raw ' + back(plain).rawMs + '/active ' + back(plain).activeMs +
    '，起身 raw ' + forth(plain).rawMs + '/active ' + forth(plain).activeMs);

  // 底部停 2 秒：raw 被撑长，active 仍是纯运动时间
  const dwellRep = run(squatSignal({ reps: 5, periodMs: 4000, holdBottomMs: 2000 })).fsm.lastRep;
  check('底部停 2 秒：raw 撑长了，active 没被撑长',
    forth(dwellRep).rawMs - forth(dwellRep).activeMs >= 1800 &&
    Math.abs(forth(dwellRep).activeMs - forth(plain).activeMs) <= 200,
    '起身 raw ' + forth(dwellRep).rawMs + ' → active ' + forth(dwellRep).activeMs +
    '（无停顿对照 ' + forth(plain).activeMs + '）');

  check('底部停 2 秒：下降段（前半）不受影响',
    Math.abs(back(dwellRep).rawMs - back(plain).rawMs) <= 200,
    '下放 raw ' + back(dwellRep).rawMs + ' vs 对照 ' + back(plain).rawMs);

  // 对称性：停顿搬到上边，就该由前半程吸收 —— 证明不是"固定扣某一边"
  const topRep = run(squatSignal({ reps: 5, periodMs: 4000, holdTopMs: 2000 })).fsm.lastRep;
  check('顶部停 2 秒：改由前半程吸收停顿（不是固定扣某一边）',
    back(topRep).rawMs - back(topRep).activeMs >= 1800 &&
    Math.abs(forth(topRep).activeMs - forth(plain).activeMs) <= 200,
    '下放 raw ' + back(topRep).rawMs + ' → active ' + back(topRep).activeMs +
    '，起身 active ' + forth(topRep).activeMs);

  // 动词来自 exercises.json，不是代码写死的
  check('两个半程都带教学动词（下放 / 起身）',
    back(plain).label === '下放' && forth(plain).label === '起身',
    JSON.stringify([back(plain).label, forth(plain).label]));

  check('transitions 的相位方向与 cycle 一致',
    back(plain).from === CFG.cycle[0] && back(plain).to === CFG.cycle[1] &&
    forth(plain).from === CFG.cycle[1] && forth(plain).to === CFG.cycle[0],
    back(plain).from + '→' + back(plain).to + ' / ' + forth(plain).from + '→' + forth(plain).to);

  // 被判「停住不动」的那次也该给得出节奏：拒绝与拆解互不干扰
  const tooSlow = run(squatSignal({ reps: 1, periodMs: 10500, holdBottomMs: 9000 })).fsm.lastRep;
  check('被判「停住不动」的那次也给得出节奏（拒绝与拆解互不干扰）',
    !!tooSlow && tooSlow.reject === REJECT.TOO_SLOW && Array.isArray(tooSlow.transitions) &&
    tooSlow.transitions.length === 2,
    'reject=' + (tooSlow && tooSlow.reject));
}

/* ------------------------------ 汇总 ------------------------------ */
const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) {
  console.log('\n未通过：');
  for (const f of failed) console.log('  - ' + f.name + '  :: ' + f.detail);
}
process.exit(failed.length ? 1 : 0);
