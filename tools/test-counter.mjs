/**
 * test-counter.mjs — 七个动作的计数 / 计时回归（node 直跑，无摄像头、无模型）
 *
 * 这是 M3 的核心验收。它成立的前提是 M2 那条架构约定：
 * **特征层与追踪层都不认识关键点索引**，只吃一维数值。
 * 于是「标准 30 次」「静立 60 秒」「只抬一条腿」这些场景都能合成为一维曲线，
 * 直接喂给 data/exercises.json 里的配置，看它数成几次、计了多少秒。
 *
 * 比录视频跑一遍更严格的地方：能精确构造边界（阈值附近抖动、单帧尖峰、
 * 半程、停住不动、中断宽限、丢失），而且完全可重复 —— 不依赖当天的光线和机位。
 *
 * 用法： node sports-pose-coach/tools/test-counter.mjs [--verbose]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTracker, modeOf } from '../shared/tpc-counter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.indexOf('--verbose') !== -1;

const ALL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'exercises.json'), 'utf8'));
const EX = ALL.exercises;

/* ============================== 合成信号 ============================== */

/** 可复现的伪随机 —— 避免每次跑出来的噪声不同，导致「这次过了」无法复现 */
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
 * 往复波形。
 * startAt='lo'：前导与收尾停在 lo，每个周期 低→高→保持→低，对应「起始相位是低位」的动作
 *              （深蹲站立、开合跳并腿、高抬腿落地）。
 * startAt='hi'：反之（俯卧撑撑起、仰卧起坐躺平）。
 * phaseShiftMs 用来生成左右腿反相的第二条信号。
 */
function osc(opts = {}) {
  const {
    cycles = 1, periodMs = 2000, fps = 30,
    hi = 1, lo = 0, startAt = 'lo',
    holdHiMs = 0, holdLoMs = 0,
    preMs = 800, postMs = 800,
    noise = 0, seed = 1, phaseShiftMs = 0,
  } = opts;

  const rand = rng(seed);
  const dt = 1000 / fps;
  const motionMs = Math.max(1, periodMs - holdHiMs - holdLoMs);
  const half = motionMs / 2;
  const startVal = startAt === 'lo' ? lo : hi;

  const wave = (u) => {
    const tl = u % periodMs;
    if (startAt === 'lo') {
      if (tl < half) return lo + (hi - lo) * ease(tl / half);
      if (tl < half + holdHiMs) return hi;
      if (tl < 2 * half + holdHiMs) return hi - (hi - lo) * ease((tl - half - holdHiMs) / half);
      return lo;
    }
    if (tl < half) return hi - (hi - lo) * ease(tl / half);
    if (tl < half + holdLoMs) return lo;
    if (tl < 2 * half + holdLoMs) return lo + (hi - lo) * ease((tl - half - holdLoMs) / half);
    return hi;
  };

  const total = preMs + cycles * periodMs + postMs;
  const out = [];
  for (let t = 0; t <= total; t += dt) {
    const u = t - preMs - phaseShiftMs;
    let v = (u < 0 || u >= cycles * periodMs) ? startVal : wave(u);
    if (noise) v += (rand() * 2 - 1) * noise;
    out.push({ tMs: Math.round(t * 1000) / 1000, value: v });
  }
  return out;
}

/** 恒定值（可带噪声），用于「静立」「保持不动」这类场景 */
function flat(value, opts = {}) {
  const { durationMs = 60000, fps = 30, noise = 0, seed = 5 } = opts;
  const rand = rng(seed);
  const dt = 1000 / fps;
  const out = [];
  for (let t = 0; t <= durationMs; t += dt) {
    out.push({ tMs: Math.round(t * 1000) / 1000, value: noise ? value + (rand() * 2 - 1) * noise : value });
  }
  return out;
}

/** 把单条信号序列包成追踪器要的帧格式，extra 里补上 guards 用到的其它信号 */
function pack(sig, name, extra, extraConf) {
  return sig.map((s) => ({
    tMs: s.tMs,
    values: Object.assign({ [name]: s.value }, extra || {}),
    conf: Object.assign({ [name]: s.conf == null ? 1 : s.conf }, extraConf || {}),
  }));
}

/** 两条信号（左右腿）合并成帧 */
function pack2(sA, sB, nameA, nameB, extra) {
  const n = Math.min(sA.length, sB.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      tMs: sA[i].tMs,
      values: Object.assign({ [nameA]: sA[i].value, [nameB]: sB[i].value }, extra || {}),
      conf: { [nameA]: 1, [nameB]: 1 },
    });
  }
  return out;
}

/* ============================== 运行与断言 ============================== */

function run(cfg, frames) {
  const tr = createTracker(cfg);
  const counts = [];
  const hold = [];
  let lastT = 0;
  for (const f of frames) {
    lastT = f.tMs;
    const res = tr.update(f);
    for (const ev of (res && res.events) || []) {
      if (ev.type === 'count') counts.push(ev);
      if (ev.type === 'start' || ev.type === 'end' || ev.type === 'break') hold.push(ev);
    }
  }
  // 计时类要把「进行中的最后一段」结账。真实场景里人可能一直保持到停止，
  // 若不结账，totalMs 永远停在上一段的累计值。
  if (typeof tr.finalize === 'function') tr.finalize(lastT);
  return { tr, counts, hold, snap: tr.snapshot() };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  :: ' + detail : ''));
}

function expectReps(name, cfg, frames, want, tol = 0, extra) {
  const r = run(cfg, frames);
  const got = r.snap.count;
  const ok = Math.abs(got - want) <= tol;
  let detail = '期望 ' + want + (tol ? '±' + tol : '') + '，实得 ' + got;
  if (VERBOSE || !ok) detail += '；拒绝 ' + JSON.stringify(r.snap.rejections);
  if (extra) {
    const ex = extra(r);
    if (ex) detail += '；' + ex;
  }
  check(name, ok, detail);
  return r;
}

function expectHold(name, cfg, frames, wantMs, tolMs, extra) {
  const r = run(cfg, frames);
  const got = r.snap.totalMs;
  const ok = Math.abs(got - wantMs) <= tolMs;
  let detail = '期望 ' + wantMs + '±' + tolMs + 'ms，实得 ' + got + 'ms';
  if (extra) {
    const ex = extra(r);
    if (ex) detail += '；' + ex;
  }
  check(name, ok, detail);
  return r;
}

console.log('== 七个动作的计数 / 计时回归 （node，无摄像头 / 无模型）==');
console.log('   配置 ' + ALL.version + '，动作 ' + Object.keys(EX).length + ' 个\n');

/* ============================== 1. 深蹲 ============================== */
{
  const cfg = EX.squat;
  console.log('[1] 深蹲（kneeAngle，单通道）');
  // startAt:'hi' —— 起始相位是「站立」，前导期必须停在站姿。
  // 若前导期给成蹲姿，状态机开局会先认到「蹲到底」，第一次站起会被
  // PARTIAL 正确地拒掉（防御逻辑没错，是夹具摆错了初始姿势）。
  expectReps('标准 30 次（2s/次，172°→85°）', cfg,
    pack(osc({ cycles: 30, periodMs: 2000, hi: 172, lo: 85, startAt: 'hi' }), 'kneeAngle', { torsoLean: 20 }), 30);
  expectReps('30 次半蹲（只到 132°）→ 一次都不算', cfg,
    pack(osc({ cycles: 30, periodMs: 2000, hi: 172, lo: 132, startAt: 'hi' }), 'kneeAngle', { torsoLean: 20 }), 0);
  expectReps('静立 60 秒 → 0', cfg,
    pack(flat(172, { durationMs: 60000, noise: 1.5 }), 'kneeAngle', { torsoLean: 3 }), 0);
  expectReps('走动 30 秒（150°~175° 摆动）→ 0', cfg,
    pack(flat(172, { durationMs: 30000 }), 'kneeAngle', { torsoLean: 5 }), 0);
  expectReps('15fps 下的 30 次（采样率鲁棒性）', cfg,
    pack(osc({ cycles: 30, periodMs: 2000, hi: 172, lo: 85, fps: 15, startAt: 'hi' }), 'kneeAngle', { torsoLean: 20 }), 30);
}

/* ============================== 2. 开合跳 ============================== */
{
  const cfg = EX.jumping_jack;
  console.log('\n[2] 开合跳（ankleSpread，单通道）');
  const std = () => pack(osc({ cycles: 30, periodMs: 700, hi: 1.8, lo: 0.35 }),
    'ankleSpread', { wristHeight: -0.4, kneeAngle: 170 });
  expectReps('标准 30 次（踝距 0.35↔1.8 肩宽，双手上举）', cfg, std(), 30);
  expectReps('20fps 下的 30 次', cfg,
    pack(osc({ cycles: 30, periodMs: 700, hi: 1.8, lo: 0.35, fps: 20 }),
      'ankleSpread', { wristHeight: -0.4, kneeAngle: 170 }), 30);
  expectReps('只开一半（0.35↔0.95）→ 一次都不算', cfg,
    pack(osc({ cycles: 30, periodMs: 700, hi: 0.95, lo: 0.35 }),
      'ankleSpread', { wristHeight: -0.4, kneeAngle: 170 }), 0);
  expectReps('静立 60 秒（踝距 0.45 抖 ±0.03）→ 0', cfg,
    pack(flat(0.45, { durationMs: 60000, noise: 0.03 }),
      'ankleSpread', { wristHeight: 0.25, kneeAngle: 172 }), 0);
  expectReps('原地踏步（踝距 0.35↔0.72）→ 0', cfg,
    pack(osc({ cycles: 40, periodMs: 500, hi: 0.72, lo: 0.35 }),
      'ankleSpread', { wristHeight: 0.2, kneeAngle: 165 }), 0);

  const noArm = run(cfg, std());
  const lastRep = noArm.snap.lastRep;
  check('双手未上举时只打标记、不阻断计数', !!lastRep && lastRep.flags.length === 0,
    '标准动作标记数 ' + (lastRep ? lastRep.flags.length : 'n/a') + '（应为 0）');
  const armDown = run(cfg, pack(osc({ cycles: 10, periodMs: 700, hi: 1.8, lo: 0.35 }),
    'ankleSpread', { wristHeight: 0.35, kneeAngle: 170 }));
  const flagged = armDown.snap.lastRep && armDown.snap.lastRep.flags.some((f) => f.signal === 'wristHeight');
  check('手垂着做开合跳 → 打「手臂未举过头顶」标记，仍然计数', flagged && armDown.snap.count === 10,
    'count=' + armDown.snap.count + '，标记 ' + JSON.stringify((armDown.snap.lastRep && armDown.snap.lastRep.flags || []).map((f) => f.label)));
}

/* ============================== 3. 俯卧撑 ============================== */
{
  const cfg = EX.pushup;
  console.log('\n[3] 俯卧撑（elbowAngle，单通道）');
  expectReps('标准 20 次（肘角 170°↔85°，身体水平）', cfg,
    pack(osc({ cycles: 20, periodMs: 1800, hi: 170, lo: 85, startAt: 'hi' }),
      'elbowAngle', { torsoTilt: 82, bodyLine: 8 }), 20);
  expectReps('浅俯卧撑（只到 130°）→ 一次都不算', cfg,
    pack(osc({ cycles: 20, periodMs: 1400, hi: 170, lo: 130, startAt: 'hi' }),
      'elbowAngle', { torsoTilt: 82, bodyLine: 8 }), 0);
  expectReps('撑住不动 60 秒 → 0', cfg,
    pack(flat(170, { durationMs: 60000, noise: 2 }),
      'elbowAngle', { torsoTilt: 82, bodyLine: 8 }), 0);

  const stand = run(cfg, pack(osc({ cycles: 15, periodMs: 1500, hi: 170, lo: 85, startAt: 'hi' }),
    'elbowAngle', { torsoTilt: 6, bodyLine: 84 }));
  const hasFlag = stand.snap.lastRep && stand.snap.lastRep.flags.some((f) => f.label.indexOf('躯干不够平') === 0);
  check('站着弯手臂做同样动作 → 计数但打「躯干不够平」标记', stand.snap.count === 15 && !!hasFlag,
    'count=' + stand.snap.count + '，标记 ' +
    JSON.stringify((stand.snap.lastRep && stand.snap.lastRep.flags || []).map((f) => f.label)));
}

/* ============================== 4. 仰卧起坐 ============================== */
{
  const cfg = EX.situp;
  console.log('\n[4] 仰卧起坐（torsoTilt，单通道）');
  expectReps('标准 20 次（躯干 85°↔20°）', cfg,
    pack(osc({ cycles: 20, periodMs: 2000, hi: 85, lo: 20, startAt: 'hi' }),
      'torsoTilt', { kneeAngle: 95, hipAngle: 95 }), 20);
  expectReps('只抬到 60°（坐起不够）→ 一次都不算', cfg,
    pack(osc({ cycles: 20, periodMs: 2000, hi: 85, lo: 60, startAt: 'hi' }),
      'torsoTilt', { kneeAngle: 95, hipAngle: 95 }), 0);
  expectReps('躺平不动 60 秒 → 0', cfg,
    pack(flat(88, { durationMs: 60000, noise: 1.5 }),
      'torsoTilt', { kneeAngle: 95, hipAngle: 95 }), 0);
  expectReps('站着 30 秒（躯干竖直，误匹配坐起相）→ 0', cfg,
    pack(flat(3, { durationMs: 30000, noise: 1 }),
      'torsoTilt', { kneeAngle: 172, hipAngle: 172 }), 0, 0,
    (r) => '拒绝明细 ' + JSON.stringify(r.snap.rejections));
}

/* ============================== 5. 高抬腿（双通道） ============================== */
{
  const cfg = EX.high_knee;
  console.log('\n[5] 原地高抬腿（kneeHeightL / kneeHeightR，双通道）');

  // 高抬腿：抬起时 kneeHeight ≈ -0.25（膝高于髋），落地时 ≈ 0.6
  const leg = (cycles, shift, seed) => osc({
    cycles, periodMs: 600, hi: -0.25, lo: 0.6, phaseShiftMs: shift, seed, preMs: 600, postMs: 600,
  });
  const dual = (cycles) => pack2(leg(cycles, 0, 1), leg(cycles, 300, 2), 'kneeHeightL', 'kneeHeightR', { torsoLean: 8 });

  expectReps('左右交替 20 次（每腿 10 次）→ 20', cfg, dual(10), 20);
  expectReps('左右交替 30 次（每腿 15 次）→ 30', cfg, dual(15), 30);
  expectReps('20fps 下的 20 次', cfg,
    pack2(
      osc({ cycles: 10, periodMs: 600, hi: -0.25, lo: 0.6, fps: 20, preMs: 600, postMs: 600 }),
      osc({ cycles: 10, periodMs: 600, hi: -0.25, lo: 0.6, fps: 20, phaseShiftMs: 300, preMs: 600, postMs: 600 }),
      'kneeHeightL', 'kneeHeightR', { torsoLean: 8 }), 20);

  // 只抬一条腿：右腿全程落地
  expectReps('只抬左腿 10 次（右腿不动）→ 10', cfg,
    pack2(leg(10, 0, 1), flat(0.6, { durationMs: 6600 }), 'kneeHeightL', 'kneeHeightR', { torsoLean: 8 }), 10);

  // 抬不到髋线（只到 +0.05）
  expectReps('抬腿但未过髋（峰值 +0.05）→ 一次都不算', cfg,
    pack2(
      osc({ cycles: 10, periodMs: 600, hi: 0.05, lo: 0.6, preMs: 600, postMs: 600 }),
      osc({ cycles: 10, periodMs: 600, hi: 0.05, lo: 0.6, phaseShiftMs: 300, preMs: 600, postMs: 600 }),
      'kneeHeightL', 'kneeHeightR', { torsoLean: 8 }), 0);

  expectReps('站立不动 60 秒 → 0', cfg,
    pack2(flat(0.6, { durationMs: 60000, noise: 0.04 }), flat(0.6, { durationMs: 60000, noise: 0.04 }),
      'kneeHeightL', 'kneeHeightR', { torsoLean: 4 }), 0);

  // 关键对照：把两腿合成一个「取大值」的单信号，看会漏多少
  {
    const sl = leg(10, 0, 1);
    const sr = leg(10, 300, 2);
    const n = Math.min(sl.length, sr.length);
    const merged = [];
    for (let i = 0; i < n; i++) {
      merged.push({
        tMs: sl[i].tMs,
        values: { kneeHeight: Math.max(sl[i].value, sr[i].value), torsoLean: 8 },
        conf: { kneeHeight: 1 },
      });
    }
    const single = JSON.parse(JSON.stringify(cfg));
    delete single.channels;
    single.fsm = Object.assign({}, single.fsm, { signal: 'kneeHeight' });
    single.signals = { kneeHeight: { type: 'pointHeight', point: 25, refPoints: [23, 24], scale: 'torsoLength', space: 'image' } };
    const r = run(single, merged);
    check('对照：合成 max(L,R) 单信号会漏计（验证双通道的必要性）',
      r.snap.count < 20,
      '同样的 20 次动作，单信号只数到 ' + r.snap.count + ' 次，双通道为 20 次');
  }

  const chans = run(cfg, dual(10)).snap.channels;
  check('双通道各自计数、合计正确', chans.length === 2 && chans[0].count === 10 && chans[1].count === 10,
    chans.map((c) => c.label + '=' + c.count).join('，'));
}

/* ============================== 6. 马步（计时） ============================== */
{
  const cfg = EX.horse_stance;
  console.log('\n[6] 马步（保持计时）');
  const hold = (ms) => pack(
    [].concat(
      flat(170, { durationMs: 600, fps: 30 }),
      flat(100, { durationMs: ms, fps: 30, noise: 1.5 }),
      flat(170, { durationMs: 800, fps: 30 })
    ).map((s, i) => ({ ...s, tMs: i * (1000 / 30) })),
    'kneeAngle', { torsoLean: 10 });

  expectHold('保持 30 秒 → 与秒表误差 < 0.5s', cfg, hold(30000), 30030, 500);
  expectHold('保持 10 秒 → 误差 < 0.5s', cfg, hold(10000), 10030, 500);
  expectHold('站直 30 秒（膝角 170°）→ 不计时', cfg,
    pack(flat(170, { durationMs: 30000, noise: 1.5 }), 'kneeAngle', { torsoLean: 3 }), 0, 50);
  expectHold('蹲着但躯干前倾 45° → 不计时', cfg,
    pack(flat(100, { durationMs: 30000 }), 'kneeAngle', { torsoLean: 45 }), 0, 50);
  expectHold('只保持 1.2 秒（< minSessionMs 1.5s）→ 不计入总时长', cfg, hold(1200), 0, 50,
    (r) => '分段数 ' + r.snap.sessions.length + '（该段标记 valid=' + (r.snap.sessions[0] && r.snap.sessions[0].valid) + '）');

  // 断续：10s + 断开 3s + 10s → 两段，合计 20s
  {
    const dt = 1000 / 30;
    const seq = [].concat(
      flat(170, { durationMs: 600 }), flat(100, { durationMs: 10000 }), flat(170, { durationMs: 3000 }),
      flat(100, { durationMs: 10000 }), flat(170, { durationMs: 800 })
    ).map((s, i) => ({ ...s, tMs: i * dt }));
    expectHold('断续：保持 10s → 断开 3s → 再保持 10s → 计 20s 两段', cfg,
      pack(seq, 'kneeAngle', { torsoLean: 10 }), 20000, 500,
      (r) => '有效段 ' + r.snap.sessionCount + ' 段');
  }

  // 抖动：中断 200ms 小于宽限 500ms → 仍算一段
  {
    const dt = 1000 / 30;
    const seq = [].concat(
      flat(170, { durationMs: 600 }), flat(100, { durationMs: 5000 }), flat(170, { durationMs: 200 }),
      flat(100, { durationMs: 5000 }), flat(170, { durationMs: 800 })
    ).map((s, i) => ({ ...s, tMs: i * dt }));
    expectHold('中断 200ms（小于宽限期 500ms）→ 不算断开，仍是一段', cfg,
      pack(seq, 'kneeAngle', { torsoLean: 10 }), 10000, 500,
      (r) => '有效段 ' + r.snap.sessionCount + ' 段');
  }

  const r = run(cfg, pack(flat(100, { durationMs: 5000 }), 'kneeAngle', { torsoLean: 10 }));
  check('计时读数：totalMs / bestMs 一致且接近真实时长', r.snap.totalMs === r.snap.bestMs && r.snap.bestMs > 4500,
    'total=' + r.snap.totalMs + ' best=' + r.snap.bestMs + ' 段数=' + r.snap.sessionCount);

  // 「一直保持到停止」——最容易漏掉的一段
  {
    const frames = pack(flat(100, { durationMs: 5000 }), 'kneeAngle', { torsoLean: 10 });
    const tr = createTracker(cfg);
    for (const f of frames) tr.update(f);
    const live = tr.snapshot();
    check('未结账时 liveMs 已反映进行中的时长（界面实时读数靠它）',
      live.totalMs === 0 && live.liveMs > 4800 && live.holding === true,
      'totalMs=' + live.totalMs + '（尚未落账）liveMs=' + live.liveMs + ' holding=' + live.holding);
    tr.finalize();
    check('finalize 把进行中的最后一段落账', tr.snapshot().totalMs > 4800,
      '结账后 totalMs=' + tr.snapshot().totalMs);
  }
}

/* ============================== 7. 靠墙静蹲（计时） ============================== */
{
  const cfg = EX.wall_sit;
  console.log('\n[7] 靠墙静蹲（保持计时）');
  const hold = (ms, lean) => pack(
    [].concat(
      flat(170, { durationMs: 600 }), flat(100, { durationMs: ms, noise: 1.5 }), flat(170, { durationMs: 800 })
    ).map((s, i) => ({ ...s, tMs: i * (1000 / 30) })),
    'kneeAngle', { torsoLean: lean === undefined ? 8 : lean });

  expectHold('贴墙静蹲 30 秒 → 误差 < 0.5s', cfg, hold(30000), 30030, 500);
  expectHold('躯干只直立到 25°（未达贴墙标准 20°）→ 不计时', cfg, hold(30000, 25), 0, 50);
  expectHold('膝角 140°（蹲得太浅）→ 不计时', cfg,
    pack(flat(140, { durationMs: 30000 }), 'kneeAngle', { torsoLean: 8 }), 0, 50);
  expectHold('膝角 70°（蹲得过深）→ 不计时', cfg,
    pack(flat(70, { durationMs: 30000 }), 'kneeAngle', { torsoLean: 8 }), 0, 50);
}

/* ============================== 8. 配置健全性 ============================== */
{
  console.log('\n[8] 配置健全性（七个动作都能建出追踪器且参数自洽）');
  let allOk = true;
  const detail = [];
  for (const [id, cfg] of Object.entries(EX)) {
    try {
      const tr = createTracker(cfg);
      const snap = tr.snapshot();
      const mode = modeOf(cfg);
      const sigNames = Object.keys(cfg.signals || {});
      // 配置里用到的信号都必须已定义
      const used = new Set();
      if (mode === 'hold') {
        for (const c of cfg.hold.conditions) used.add(c.signal);
      } else {
        for (const c of (cfg.channels || [{ signal: cfg.fsm.signal }])) {
          used.add(c.signal || cfg.fsm.signal);
        }
        for (const g of (cfg.fsm.guards || [])) used.add(g.signal);
      }
      for (const g of (cfg.fsm && cfg.fsm.guards) || []) used.add(g.signal);
      for (const c of (cfg.hold && cfg.hold.conditions) || []) used.add(c.signal);
      const missing = Array.from(used).filter((n) => sigNames.indexOf(n) === -1);
      if (missing.length) { allOk = false; detail.push(id + ' 引用了未定义的信号 ' + missing.join(',')); }
      if (snap.mode !== mode) { allOk = false; detail.push(id + ' snapshot.mode 不一致'); }
      if (mode === 'reps' && snap.count !== 0) { allOk = false; detail.push(id + ' 初始计数不为 0'); }
      if (mode === 'hold' && snap.totalMs !== 0) { allOk = false; detail.push(id + ' 初始计时不为 0'); }
    } catch (e) {
      allOk = false;
      detail.push(id + ' 建追踪器失败：' + e.message);
    }
  }
  check('七个动作配置自洽（信号引用完整、初始读数为 0）', allOk,
    detail.length ? detail.join(' | ') : Object.keys(EX).length + ' 个动作全部通过对象名：' + Object.keys(EX).join('、'));
}

/* ============================== 汇总 ============================== */

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) {
  console.log('\n未通过：');
  for (const f of failed) console.log('  - ' + f.name + '  :: ' + f.detail);
}
process.exit(failed.length ? 1 : 0);
