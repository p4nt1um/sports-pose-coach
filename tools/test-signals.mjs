/**
 * test-signals.mjs — 信号层回归（关键点 → 一维信号）
 *
 * 为什么必须有这一套：
 *   test-counter.mjs 直接喂"已经算好的数值"，它验证的是状态机。
 *   于是「关键点变成数值」这一段在端到端自检里是**盲区** ——
 *   俯卧撑"怎么调都数不出来"就是这么漏出去的：状态机完全正确，
 *   错在它拿到的那个数从一开始就是错的。
 *
 * 这一套从 33 点关键点出发，覆盖三类真实机位缺陷：
 *   A 侧拍时远侧肢体被躯干遮挡 → 读数是猜的
 *   B 一侧置信度低 → 置信度聚合把整条信号判死
 *   C 单帧坏姿态 → 一帧决定一次判定
 *
 * 用法：node tools/test-signals.mjs [--verbose]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalSet } from '../shared/tpc-signals.js';
import { PhaseFsm } from '../shared/tpc-fsm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.indexOf('--verbose') !== -1;

const ALL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'exercises.json'), 'utf8'));
const EX = ALL.exercises;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  :: ' + detail : ''));
}
const near = (a, b, tol) => a !== null && a !== undefined && Math.abs(a - b) <= tol;
const fmt = (v) => (v === null || v === undefined ? 'null' : Number(v).toFixed(1));

/* ------------------------------------------------------------------ *
 * 合成关键点：把一个「二维骨架」展开成 MediaPipe 的 33 点格式
 *
 * 世界坐标（米）里画人，再线性映射到图像坐标，两条链路都能用。
 * 侧拍时相机在 +z，本人左侧朝相机（近侧），右侧被躯干压住（远侧）。
 * ------------------------------------------------------------------ */

const UPPER_ARM = 0.30;
const FOREARM = 0.27;
const FRAME_W = 3.0;   // 世界 x ∈ [-1.5, 1.5] → 图像 [0,1]
const FRAME_H = 1.8;   // 世界 y ∈ [0, 1.8]   → 图像 [1,0]

function armChain(wrist, elbowDeg) {
  const E = { x: wrist.x - 0.20, y: wrist.y + 0.20 };
  const toW = { x: wrist.x - E.x, y: wrist.y - E.y };
  const len = Math.hypot(toW.x, toW.y);
  const ux = toW.x / len;
  const uy = toW.y / len;
  const phi = (elbowDeg * Math.PI) / 180;
  const cands = [phi, -phi].map((f) => ({
    x: E.x + UPPER_ARM * (ux * Math.cos(f) - uy * Math.sin(f)),
    y: E.y + UPPER_ARM * (ux * Math.sin(f) + uy * Math.cos(f)),
  }));
  return { S: cands[0].y > cands[1].y ? cands[0] : cands[1], E };
}

function toImage(p) {
  return { x: (p.x + 1.5) / FRAME_W, y: 1 - p.y / FRAME_H, z: p.z || 0 };
}

/**
 * 造一帧俯卧撑姿态。
 * @param {object} o
 * @param {number} o.nearDeg 近侧手臂真实肘角
 * @param {number} o.farDeg  远侧手臂的读数（遮挡时是模型猜的，不是测的）
 * @param {number} o.nearVis 近侧可见度
 * @param {number} o.farVis  远侧可见度
 * @param {boolean} o.dropFar 远侧手臂整条缺失（彻底遮挡 / 出画）
 */
function pushupPose({ nearDeg, farDeg, nearVis = 0.92, farVis = 0.30, dropFar = false, bodySag = 0.02 }) {
  const lm = [];
  const wl = [];
  for (let i = 0; i < 33; i++) {
    lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 0 });
    wl.push({ x: 0, y: 0, z: 0, visibility: 0 });
  }
  const put = (idx, p, vis) => {
    lm[idx] = { ...toImage(p), visibility: vis };
    wl[idx] = { x: p.x, y: p.y, z: p.z || 0, visibility: vis };
  };

  const wristL = { x: 0, y: 0, z: 0.18 };
  const wristR = { x: 0, y: 0, z: -0.18 };
  const near = armChain(wristL, nearDeg);
  const far = armChain(wristR, farDeg);

  put(11, { ...near.S, z: 0.18 }, nearVis);
  put(13, { ...near.E, z: 0.18 }, nearVis);
  put(15, wristL, nearVis);
  if (!dropFar) {
    put(12, { ...far.S, z: -0.18 }, farVis);
    put(14, { ...far.E, z: -0.18 }, farVis);
    put(16, wristR, farVis);
  }

  const sy = (near.S.y + far.S.y) / 2;
  // bodySag：髋相对肩的**额外**下沉量（米）。默认 0.02 是略微不直的常态
  const body = [
    { x: -0.42, y: sy - bodySag },
    { x: -0.84, y: sy - bodySag },
    { x: -1.24, y: sy - bodySag },
  ];
  [23, 25, 27].forEach((idx, k) => {
    put(idx, { ...body[k], z: 0.10 }, 0.9);
    put(idx + 1, { ...body[k], z: -0.10 }, 0.85);
  });
  put(0, { x: near.S.x + 0.18, y: sy + 0.10, z: 0 }, 0.9);
  return { landmarks: lm, worldLandmarks: wl };
}

/** 半个周期：从 a 角平滑走到 b 角 */
function ramp(a, b, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    out.push(a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * k)));
  }
  return out;
}

/**
 * 一整段俯卧撑：顶部与底部各停留几帧（真实动作都有，且中位数滤波需要）。
 * @returns {Array<{tMs:number, pose:object}>} 帧间隔 100ms（约 10fps 的最坏情况）
 */
function pushupSequence(o) {
  const {
    top = 160, bottom = 88, cycles = 3, n = 12,
    holdTop = 3, holdBottom = 3,
    farDeg = 115, farVis = 0.30, nearVis = 0.92, dropFar = false, bodySag = 0.02,
  } = o;
  const angles = [];
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < holdTop; i++) angles.push(top);
    angles.push(...ramp(top, bottom, n));
    for (let i = 0; i < holdBottom; i++) angles.push(bottom);
    angles.push(...ramp(bottom, top, n));
  }
  for (let i = 0; i < holdTop; i++) angles.push(top);
  return angles.map((a, i) => ({
    tMs: (i + 1) * 100,
    pose: pushupPose({ nearDeg: a, farDeg: farDeg === 'same' ? a : farDeg, farVis, nearVis, dropFar, bodySag }),
  }));
}

/* ------------------------------------------------------------------ *
 * 跑链路
 * ------------------------------------------------------------------ */

function makeSet(defs) {
  const d = {};
  for (const [k, v] of Object.entries(defs)) d[k] = { ...v };
  return new SignalSet(d);
}

/** 只跑信号层，返回逐帧读数 */
function readSignals(defs, seq) {
  const set = makeSet(defs);
  return seq.map(({ tMs, pose }) => {
    const r = set.evaluate(pose, tMs);
    return { tMs, ...r, autoSide: (set.state[Object.keys(defs)[0]] || {}).autoSide };
  });
}

/** 信号层 + 状态机，返回计数 */
function countReps(exCfg, seq) {
  const set = makeSet(exCfg.signals);
  const fsm = new PhaseFsm(exCfg.fsm);
  for (const { tMs, pose } of seq) {
    const { values, confidence } = set.evaluate(pose, tMs);
    fsm.update({ values, confidence, tMs });
  }
  return { count: fsm.count, reject: fsm.rejections, fsm };
}

console.log('\n[1] 侧拍遮挡：远侧手臂读数是猜的，主信号不能被它钳住');
{
  const cases = [
    { name: '远侧读 115°、可见度 0.30', farDeg: 115, farVis: 0.30 },
    { name: '远侧读 130°、可见度 0.55', farDeg: 130, farVis: 0.55 },
    { name: '远侧读 100°、可见度 0.42', farDeg: 100, farVis: 0.42 },
    { name: '远侧整条缺失（彻底遮挡）', farDeg: 115, farVis: 0, dropFar: true },
  ];
  for (const c of cases) {
    const seq = pushupSequence({ cycles: 2, ...c });
    const rows = readSignals(EX.pushup.signals, seq);
    const vals = rows.map((r) => r.values.elbowAngle).filter((v) => v != null);
    const confs = rows.map((r) => r.confidence.elbowAngle).filter((v) => v != null);
    const hi = Math.max(...vals);
    const lo = Math.min(...vals);
    const conf = Math.min(...confs);
    check('side:auto 在「' + c.name + '」下读到真实幅度',
      near(hi, 160, 6) && near(lo, 88, 6),
      '读数 ' + fmt(lo) + '~' + fmt(hi) + '°，置信度 ≥' + conf.toFixed(2));
  }
}

console.log('\n[2] 旧配置 side:min 在同场景下的已知行为（说明俯卧撑为什么不能用 min）');
{
  const defs = { ...EX.pushup.signals, elbowAngle: { ...EX.pushup.signals.elbowAngle, side: 'min', median: 0 } };
  const seq = pushupSequence({ cycles: 2, farDeg: 115, farVis: 0.30 });
  const rows = readSignals(defs, seq);
  const hi = Math.max(...rows.map((r) => r.values.elbowAngle).filter((v) => v != null));
  check('min 会把上限钳在远侧那个坏值上（不到 132° 阈值 → 永远进不了「撑起」）',
    hi < 132, '上限 ' + fmt(hi) + '°，远侧读数 115°');
}

console.log('\n[3] 置信度归属：一侧遮挡不等于整条信号不可信');
{
  // 远侧可见度 0.30，但两侧读数一致（没有分歧）→ 输出值出自看得清的那一侧
  const defs = { elbowAngle: { type: 'jointAngle', chain: [11, 13, 15], side: 'left', space: 'world' } };
  const seq = pushupSequence({ cycles: 1, farDeg: 'same', farVis: 0.30 });
  const rows = readSignals(defs, seq);
  const conf = Math.min(...rows.map((r) => r.confidence.elbowAngle));
  check('side:left 只对近侧负责，置信度不被远侧拖低', conf >= 0.85, '置信度 ' + conf.toFixed(2));

  const defsMin = { elbowAngle: { type: 'jointAngle', chain: [11, 13, 15], side: 'min', space: 'world' } };
  const rowsMin = readSignals(defsMin, seq);
  const confMin = Math.min(...rowsMin.map((r) => r.confidence.elbowAngle));
  check('side:min 两侧读数一致时，置信度取被选中那一侧（不再取两侧最小值）',
    confMin >= 0.85, '置信度 ' + confMin.toFixed(2));
}

console.log('\n[4] 分歧过大：至少一侧是错的，此时都不信');
{
  const defs = { elbowAngle: { type: 'jointAngle', chain: [11, 13, 15], side: 'min', space: 'world' } };
  const seq = [{ tMs: 100, pose: pushupPose({ nearDeg: 160, farDeg: 100, nearVis: 0.92, farVis: 0.35 }) }];
  const rows = readSignals(defs, seq);
  const conf = rows[0].confidence.elbowAngle;
  check('两侧差 60° → 置信度退到较小的一侧', conf <= 0.4, '置信度 ' + conf.toFixed(2) + '（近侧 0.92 / 远侧 0.35）');
}

console.log('\n[5] auto 的粘滞：两侧置信度在阈值附近交叉时不许来回横跳');
{
  // 40 帧里近侧 0.90→0.42 线性下降，远侧 0.42→0.90 线性上升
  const seq = [];
  for (let i = 0; i < 40; i++) {
    const k = i / 39;
    seq.push({
      tMs: (i + 1) * 100,
      pose: pushupPose({ nearDeg: 150, farDeg: 150, nearVis: 0.90 - 0.48 * k, farVis: 0.42 + 0.48 * k }),
    });
  }
  const set = makeSet({ elbowAngle: { type: 'jointAngle', chain: [11, 13, 15], side: 'auto', space: 'world' } });
  const sides = [];
  for (const { tMs, pose } of seq) {
    set.evaluate(pose, tMs);
    sides.push(set.state.elbowAngle.autoSide);
  }
  let switches = 0;
  for (let i = 1; i < sides.length; i++) if (sides[i] !== sides[i - 1]) switches++;
  check('40 帧置信度交叉只换 1 次侧', switches <= 1, '切换 ' + switches + ' 次，最终 ' + sides[sides.length - 1]);
}

console.log('\n[6] 中位数滤波：一帧坏姿态决定不了一次判定');
{
  const defs = { elbowAngle: { type: 'jointAngle', chain: [11, 13, 15], side: 'left', space: 'world', median: 5 } };
  // 稳定 150°，第 8 帧塌成 60°（关键点在一帧里被彻底认错）
  const seq = [];
  for (let i = 0; i < 15; i++) {
    seq.push({ tMs: (i + 1) * 100, pose: pushupPose({ nearDeg: i === 7 ? 60 : 150, farDeg: 150, farVis: 0.9 }) });
  }
  const rows = readSignals(defs, seq);
  const vals = rows.map((r) => r.values.elbowAngle);
  const dip = Math.min(...vals.slice(3));
  check('单帧 60° 尖峰被吃掉（输出仍在 150° 附近）', near(dip, 150, 8), '最低读 ' + fmt(dip) + '°');

  // 反向：真实台阶必须跟得上，不能因为滤波把动作抹平
  const step = [];
  for (let i = 0; i < 20; i++) {
    step.push({ tMs: (i + 1) * 100, pose: pushupPose({ nearDeg: i < 10 ? 150 : 95, farDeg: 95, farVis: 0.9 }) });
  }
  const r2 = readSignals(defs, step);
  const tail = r2[r2.length - 1].values.elbowAngle;
  check('真实台阶变化能跟上（末帧读到 95° 附近）', near(tail, 95, 8), '末帧 ' + fmt(tail) + '°');
}

console.log('\n[7] 端到端：真实配置下，20 次俯卧撑在各类机位下都要数得出来');
{
  const scenarios = [
    ['侧拍，远侧被挡（远侧读数 115° / 可见度 0.30）', { farDeg: 115, farVis: 0.30 }],
    ['侧拍，远侧被挡（远侧读数 130° / 可见度 0.55）', { farDeg: 130, farVis: 0.55 }],
    ['侧拍，远侧整条缺失', { farDeg: 115, farVis: 0, dropFar: true }],
    ['手机举得高、读数整体偏低 22°（160° 读成 138°）', { top: 138, bottom: 75 }],
    ['学生没完全撑直（顶部只到 145°）', { top: 145, bottom: 95 }],
    ['幅度偏大（底部到 75°）', { top: 160, bottom: 75 }],
  ];
  for (const [name, o] of scenarios) {
    const seq = pushupSequence({ cycles: 20, ...o });
    const r = countReps(EX.pushup, seq);
    check(name + ' → 20 次', r.count === 20, '实得 ' + r.count + (VERBOSE ? '；拒绝 ' + JSON.stringify(r.reject) : ''));
  }
}

console.log('\n[8] 端到端：该不数的仍然不数（放宽阈值不能变成乱数）');
{
  const skip = [
    ['浅俯卧撑（底部只到 130°）', { top: 170, bottom: 130 }],
    ['只弯手肘不下身（顶部 170° 底部 126°）', { top: 170, bottom: 126 }],
  ];
  for (const [name, o] of skip) {
    const seq = pushupSequence({ cycles: 5, ...o });
    const r = countReps(EX.pushup, seq);
    check(name + ' → 0 次', r.count === 0, '实得 ' + r.count);
  }
  // 撑住不动：平躺 60 秒
  const flatSeq = [];
  for (let i = 0; i < 600; i++) {
    flatSeq.push({ tMs: (i + 1) * 100, pose: pushupPose({ nearDeg: 165, farDeg: 165, farVis: 0.85 }) });
  }
  const rf = countReps(EX.pushup, flatSeq);
  check('撑住不动 60 秒 → 0 次', rf.count === 0, '实得 ' + rf.count);
}

console.log('\n[9] 端到端：分级与计数分离 —— 撑不直的次数要计入，同时打标记');
{
  const seq = pushupSequence({ cycles: 5, top: 145, bottom: 95, farDeg: 115, farVis: 0.30 });
  const r = countReps(EX.pushup, seq);
  const flags = (r.fsm.lastRep && r.fsm.lastRep.flags) || [];
  const hasLoose = flags.some((f) => f.label.indexOf('没有完全撑直') === 0);
  check('5 次都计入，且「没有完全撑直」标记出现', r.count === 5 && hasLoose,
    'count=' + r.count + '，标记 ' + JSON.stringify(flags.map((f) => f.label)));
}

console.log('\n[10] 回归：其它动作的 side 归约没被改坏');
{
  // 深蹲：两侧膝角 170°/170° → min 得 170
  const pose = pushupPose({ nearDeg: 160, farDeg: 160, nearVis: 0.9, farVis: 0.9 });
  const set = makeSet({ k: { type: 'jointAngle', chain: [23, 25, 27], side: 'min', space: 'world' } });
  const out = set.evaluate(pose, 100);
  check('jointAngle side:min 仍取两侧较小值', out.values.k !== null && near(out.values.k, 170, 12),
    '膝角 ' + fmt(out.values.k) + '°（合成腿是直的）');

  const sp = makeSet({ s: { type: 'spread', a: [27], b: [28], scale: 'shoulderWidth', side: 'left', space: 'image' } });
  const out2 = sp.evaluate(pose, 100);
  check('spread side:left 仍可求值', out2.values.s !== null && out2.values.s > 0,
    '踝间距/肩宽 = ' + (out2.values.s === null ? 'null' : out2.values.s.toFixed(2)));

  const ph = makeSet({ p: { type: 'pointHeight', point: 11, refPoints: [23, 24], scale: 'torsoLength', space: 'image' } });
  const out3 = ph.evaluate(pose, 100);
  check('pointHeight 仍可求值（俯卧撑姿态下肩高于髋 → 负值）', out3.values.p !== null && out3.values.p < 0,
    '(肩-髋)/躯干长 = ' + (out3.values.p === null ? 'null' : out3.values.p.toFixed(2)));
}

console.log('\n[11] legLength：必须按线段长算，不能是 |髋→踝| 的直线距离');
{
  /**
   * 造一条腿：大腿 0.45m、小腿 0.42m，膝弯 bendDeg 度。
   * 髋固定在世界坐标 (0, 0.9)，膝在正下方，小腿从膝往斜下。
   */
  const THIGH = 0.45;
  const SHANK = 0.42;
  const legPose = (bendDeg) => {
    const H = { x: 0, y: 0.9, z: 0 };
    const K = { x: 0, y: H.y - THIGH, z: 0 };
    const t = (bendDeg * Math.PI) / 180;
    // 膝弯时小腿往 −x 方向折叠
    const A = { x: K.x - SHANK * Math.sin(t), y: K.y - SHANK * Math.cos(t), z: 0 };
    const lm = [];
    const wl = [];
    for (let i = 0; i < 33; i++) {
      lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 });
      wl.push({ x: 0, y: 0, z: 0, visibility: 0.9 });
    }
    for (const [idx, p] of [[23, H], [25, K], [27, A], [24, H], [26, K], [28, A]]) {
      lm[idx] = { ...toImage(p), visibility: 0.9 };
      wl[idx] = { ...p, visibility: 0.9 };
    }
    return { landmarks: lm, worldLandmarks: wl };
  };

  // 比值 = |髋−踝| / legLength。旧实现分母就是分子，恒为 1；修好后应随屈膝下降。
  const defs = { r: { type: 'spread', a: [23], b: [27], side: 'left', scale: 'legLength', space: 'world' } };
  const ratioOf = (bendDeg) => {
    const set = makeSet(defs);
    return set.evaluate(legPose(bendDeg), 100).values.r;
  };
  const straight = ratioOf(0);
  const bent90 = ratioOf(90);
  check('直腿时 |髋−踝| / legLength ≈ 1', near(straight, 1, 0.02), '比值 ' + (straight == null ? 'null' : straight.toFixed(3)));
  const expect90 = Math.hypot(THIGH - SHANK * Math.cos(Math.PI / 2), SHANK) / (THIGH + SHANK);
  check('膝弯 90° 时分母仍是大腿+小腿（比值明显小于 1，旧实现会恒等于 1）',
    near(bent90, expect90, 0.02) && bent90 < 0.95,
    '比值 ' + (bent90 == null ? 'null' : bent90.toFixed(3)) + '，理论 ' + expect90.toFixed(3));
}

console.log('\n[12] lineDeviation：髋偏离「肩—踝」连线的角度（塌腰为负、拱背为正）');
{
  /**
   * 用正方形画面（x、y 映射到同样的米数）造姿态，这样 pose.aspect=1 就是精确的，
   * 不必在测试里再引入宽高比的因素。
   */
  const H = 1.8;
  const sq = (p) => ({ x: 0.75 + p.x / H, y: 1 - p.y / H, z: 0 });
  const bodyPose = (sagM) => {
    const S = { x: 0, y: 0.9 };            // 肩中点（世界坐标，y 向上）
    const C = { x: -1.2, y: 0.9 };         // 踝中点
    const B = { x: -0.5, y: 0.9 - sagM };  // 髋中点，sagM > 0 表示比连线低
    const lm = [];
    const wl = [];
    for (let i = 0; i < 33; i++) {
      lm.push({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 });
      wl.push({ x: 0, y: 0, z: 0, visibility: 0.9 });
    }
    for (const [i, p] of [[11, S], [12, S], [23, B], [24, B], [27, C], [28, C]]) {
      lm[i] = { ...sq(p), visibility: 0.9 };
      wl[i] = { ...p, z: 0, visibility: 0.9 };
    }
    return { landmarks: lm, worldLandmarks: wl, aspect: 1 };
  };
  const defs = { d: { type: 'lineDeviation', a: [11, 12], b: [23, 24], c: [27, 28], space: 'image' } };
  const devOf = (sagM) => {
    const set = makeSet(defs);
    return set.evaluate(bodyPose(sagM), 100).values.d;
  };

  const flat = devOf(0);
  const sag = devOf(0.03);      // 髋比连线低 3cm
  const arch = devOf(-0.03);    // 髋比连线高 3cm
  const expect = Math.asin(0.03 / 0.5) * (180 / Math.PI);   // ≈3.44°
  check('三点共线 → 读数 ≈ 0', near(flat, 0, 0.5), '读数 ' + fmt(flat) + '°');
  check('髋低于连线 3cm → 负值（塌腰）', sag < -1 && near(Math.abs(sag), expect, 1.2),
    '读数 ' + fmt(sag) + '°，理论 ' + (-expect).toFixed(2) + '°');
  check('髋高于连线 3cm → 正值（拱背）', arch > 1 && near(arch, expect, 1.2),
    '读数 ' + fmt(arch) + '°，理论 ' + expect.toFixed(2) + '°');

  // 关键点对象整个缺失 → 必须 null。给 0 会被下游误读成"完美直线"。
  const gone = bodyPose(0);
  gone.landmarks[27] = null;
  gone.landmarks[28] = null;
  const set2 = makeSet(defs);
  const missing = set2.evaluate(gone, 100);
  check('踝点对象缺失 → null（不是 0，否则会被当成"完美直线"）',
    missing.values.d === null && missing.confidence.d === 0,
    'value=' + missing.values.d + '，conf=' + missing.confidence.d);

  // 关键点还在但"不可信"（MediaPipe 一定会给 33 个点，只是 visibility 很低）
  // → 值仍算得出来，但置信度必须是 0，由状态机决定不推进。
  const invisible = bodyPose(0);
  invisible.landmarks[27].visibility = 0;
  invisible.landmarks[28].visibility = 0;
  const set3 = makeSet(defs);
  const lowConf = set3.evaluate(invisible, 100);
  check('踝点不可信 → 置信度 0（值照算，是否采用由状态机按 minConfidence 决定）',
    lowConf.confidence.d === 0, 'conf=' + lowConf.confidence.d);
}

console.log('\n[13] 端到端：塌腰的俯卧撑会计数，但打「身体不成一条直线」标记');
{
  const good = countReps(EX.pushup, pushupSequence({ cycles: 5, bodySag: 0.02 }));
  const saggy = countReps(EX.pushup, pushupSequence({ cycles: 5, bodySag: 0.18 }));
  const flags = (saggy.fsm.lastRep && saggy.fsm.lastRep.flags) || [];
  const hasSag = flags.some((f) => f.label.indexOf('身体不成一条直线') === 0);
  const goodFlags = (good.fsm.lastRep && good.fsm.lastRep.flags) || [];
  const goodSag = goodFlags.some((f) => f.label.indexOf('身体不成一条直线') === 0);
  check('正常姿态不打「身体不成一条直线」', good.count === 5 && !goodSag,
    'count=' + good.count + '，标记 ' + JSON.stringify(goodFlags.map((f) => f.label)));
  check('髋下沉 18cm 仍计数 5 次，但打上标记（计数与分级分离）', saggy.count === 5 && hasSag,
    'count=' + saggy.count + '，标记 ' + JSON.stringify(flags.map((f) => f.label)));
}

/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('信号层回归：' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + '  :: ' + f.detail);
}
console.log('='.repeat(64) + '\n');
process.exit(failed.length ? 1 : 0);
