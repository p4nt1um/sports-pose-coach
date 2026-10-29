/**
 * test-similarity.mjs — 动作相似度（学生自我基线）回归，node 直跑
 *
 * 这一层最容易出"看起来对但其实没用"的故障：
 *   1. 归一化按**时间**而非按进度 → 学生停在底部两秒，动作形状就被摊歪，
 *      分数掉下来但老师完全看不出原因
 *   2. 锚点跟着当前批次现算 → 分数跨视频不可比，"看趋势"这个目的直接落空
 *   3. 锚点区间退化 → 稳定的学生任何动作都得 0 分或 100 分
 * 所以下面的断言一半在证伪：
 *   ★ 同一形状 + 不同停顿 → 差异必须接近 0（不是"小一点"）
 *   ★ 同一形状 + 不同快慢 → 差异必须接近 0
 *   ★ 形状真变了 → 差异必须明显大于 0（不然抗停顿就成了"什么都察觉不到"）
 *   ★ "和平时一样"必须落在 60 分附近（定标的语义锚点）
 *
 * 用法：node tools/test-similarity.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeRep, diffOf, buildBaseline, scoreOf, scoreFromDiff, describeBaseline,
  BaselineStore, memoryStorage, MIN_REPS, ZERO_RATIO, MIN_SPAN,
} from '../shared/tpc-similarity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ALL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'exercises.json'), 'utf8'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  :: ' + detail : ''));
}
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const SQ = ALL.exercises.squat.similarity;   // primary kneeAngle(min) / 特征 torsoLean
const PU = ALL.exercises.pushup.similarity;

/**
 * 造一次动作的逐帧数据。
 *
 * 主信号 kneeAngle：p0 → pTurn（n1 帧）→ p0（n2 帧）；
 * 特征 torsoLean：按**段内进度**从 f0 到 fTurn 再回来 —— 所以形状由 fTurn 决定，
 * 让它与快慢、停顿完全无关，才能单独验证归一化本身。
 */
function repFrames({
  spec = SQ, p0 = 168, pTurn = 95, n1 = 30, n2 = 30, hold = 0,
  f0 = 8, fTurn = 22, fps = 30, skip = [],
} = {}) {
  const feat = spec.signals[0].name;
  const out = [];
  let t = 0;
  const push = (p, u, seg) => {
    const v = { [spec.primary]: p, [feat]: f0 + (fTurn - f0) * u };
    if (skip.indexOf(out.length) !== -1) v[feat] = null;
    out.push({ tMs: (t += 1000 / fps), values: v, seg });
  };
  for (let i = 0; i < n1; i++) push(p0 + (pTurn - p0) * (i / (n1 - 1)), i / (n1 - 1));
  for (let i = 0; i < hold; i++) push(pTurn, 1);
  for (let i = 0; i < n2; i++) push(pTurn + (p0 - pTurn) * (i / (n2 - 1)), 1 - i / (n2 - 1));
  return out;
}

const norm = (frames, spec = SQ) => normalizeRep(frames, spec);
/** 只用于量"差异有多大"，把单位固定成原始量纲（torsoLean 的度），便于读 */
const rawDiff = (a, b, spec = SQ) => diffOf(a, b, {
  signals: spec.signals,
  scale: Object.fromEntries(spec.signals.map((s) => [s.name, 1])),
});

/* ================================================================= */
console.log('\n[1] 归一化：按「主信号进度」分箱，而不是按时间');

{
  const a = norm(repFrames());
  check('一次完整动作 → 16 个进度点（两段 × 8 箱）', a && a.vec.length === 16, a && a.vec.length);
  check('没有空缺箱等待补齐', a && a.vec.every((row) => row.every((v) => typeof v === 'number')), '');

  const mono = repFrames({ n2: 0 });
  check('★ 转身点落在端点（只做了半个动作）→ 不给分数', norm(mono) === null, '');
  const flat = norm(repFrames().map((f) => ({ tMs: f.tMs, values: { kneeAngle: 160, torsoLean: 8 } })));
  check('★ 全程不动 → 不给分数（没有动作就没有相似度可言）', flat === null, '');
  check('帧数太少 → 不给分数', norm(repFrames().slice(0, 3)) === null, '');
}

/* ================================================================= */
console.log('\n[2] ★ 抗停顿：蹲到底歇 2 秒，动作形状不能被摊歪');

const noise = {};   // 各处"本来就不该有的差异"收集起来，后面拿去当尺子

{
  const a = norm(repFrames());
  const b = norm(repFrames({ hold: 60 }));     // 底部停 60 帧 = 2 秒
  const d = rawDiff(a.vec, b.vec);
  noise.pause = d;
  check('★ 同一形状 + 底部停 2 秒 → 差异接近 0（按时间归一化这里会明显偏移）',
    d < 0.5, 'diff=' + r2(d) + '（单位：torsoLean 的度）');

  const c = norm(repFrames({ hold: 30 }));
  noise.pause1 = rawDiff(a.vec, c.vec);
  check('停 1 秒也一样（不是恰好在某个停顿长度上才成立）',
    noise.pause1 < 0.5, 'diff=' + r2(noise.pause1));
}

/* ================================================================= */
console.log('\n[3] ★ 抗快慢：2 秒做完和 4 秒做完，应当没有区别');

{
  const fast = norm(repFrames({ n1: 20, n2: 20 }));
  const slow = norm(repFrames({ n1: 60, n2: 60 }));
  noise.speed = rawDiff(fast.vec, slow.vec);
  check('★ 帧数差 3 倍（快慢不同）→ 差异接近 0', noise.speed < 0.5, 'diff=' + r2(noise.speed));
}

/* ================================================================= */
console.log('\n[4] ★ 形状真变了必须能看出来（抗停顿不能变成"什么都察觉不到"）');

{
  const base = norm(repFrames({ fTurn: 22 }));          // 蹲到底时躯干前倾 22°
  const lean = norm(repFrames({ fTurn: 40 }));          // 前倾到 40°（弯腰了）
  const dLean = rawDiff(base.vec, lean.vec);
  // ±1 箱容忍会吃掉一部分差值：峰值差 18°，但它是"从 0 到 18°"的斜线差，
  // 均值只有 9°，容忍再削一半 → 5~6。所以判据不能拍一个接近 18 的绝对数，
  // 真正该问的是"和噪声比，够不够大"。
  const worstNoise = Math.max(noise.pause, noise.pause1, noise.speed);
  check('★ 躯干前倾 22°→40° 的差异，是停顿/快慢噪声的 20 倍以上',
    dLean > worstNoise * 20, 'signal=' + r2(dLean) + ' vs noise=' + r2(worstNoise));

  const early = norm(repFrames({ fTurn: 22, n1: 30, n2: 30 }));
  // 形状变"早前倾"：只把前半段抬高 6°，峰值不变
  const shape2 = early.vec.map((row, i) => row.map((v) => (i < 8 ? v + 6 : v)));
  const dShape = rawDiff(early.vec, shape2);
  check('只改前半段形状（峰值不变）→ 也能看出来，不是只对峰值敏感',
    dShape > worstNoise * 8, 'diff=' + r2(dShape));
  check('差异越明显，数值越大（单调，不是二值判断）', dLean > dShape, r2(dLean) + ' > ' + r2(dShape));
}

/* ================================================================= */
console.log('\n[5] 箱空间里的 ±1 容忍：一点点错位不该算成"不像"');

{
  const a = norm(repFrames());
  // 把 b 的每一箱整体挪一箱（模拟动作形状在时间上轻微错位）
  const shifted = a.vec.map((_, i) => a.vec[Math.min(a.vec.length - 1, i + 1)]);
  const withTol = rawDiff(a.vec, shifted);
  // 同一份数据但不给容忍（手工算同箱差），作为对照
  let hard = 0;
  for (let i = 0; i < a.vec.length; i++) hard += Math.abs(a.vec[i][0] - shifted[i][0]);
  hard /= a.vec.length;
  check('★ 整体错位一箱 → 差异比硬对齐小得多（容忍生效）',
    withTol < hard * 0.6, 'withTol=' + r2(withTol) + ' < hard=' + r2(hard));
}

/* ================================================================= */
console.log('\n[6] 缺箱与遮挡：能补就补，补不出来就不给分');

{
  const gappy = norm(repFrames({ skip: [4, 5, 6, 20, 21] }));
  check('中间几帧被遮挡 → 仍能归一化（相邻箱补齐）', !!gappy, gappy && gappy.vec.length);
  const d = rawDiff(norm(repFrames()).vec, gappy.vec);
  check('补齐后的差异很小（补值接近真实形状，不是瞎填）', d < 1.5, 'diff=' + r2(d));

  const allGone = norm(repFrames().map((f) => ({ tMs: f.tMs, values: { kneeAngle: f.values.kneeAngle } })));
  check('★ 特征信号整段缺失 → 返回 null（宁可不算，也不拿编出来的形状打分）',
    allGone === null, '');
}

/* ================================================================= */
console.log('\n[7] 建基线：模板用中位数，锚点有定标');

{
  const reps = [norm(repFrames()), norm(repFrames({ fTurn: 24 })), norm(repFrames({ fTurn: 26 }))];
  const b = buildBaseline(reps, SQ);
  check('3 次动作 → 基线可用', b && b.quality.ok, b && b.quality.reasons.join('；'));
  check('模板长度与箱数一致', b.template.length === 16, b.template.length);
  check('每个信号都估出了自然抖动', Object.keys(b.scale).length === SQ.signals.length,
    JSON.stringify(b.scale));

  // 中位数抗离群：把其中一次换成"做歪了"的，模板不应被拉走
  const outlier = norm(repFrames({ fTurn: 60 }));
  const b2 = buildBaseline([norm(repFrames()), norm(repFrames()), outlier], SQ);
  const midBox = 4;
  const dev = Math.abs(b2.template[midBox][0] - b.template[midBox][0]);
  check('★ 一次做歪了不把模板拉偏（取中位数而非平均值）', dev < 3, '模板第 5 箱偏移 ' + r2(dev) + '°');

  const tooFew = buildBaseline([norm(repFrames()), norm(repFrames())], SQ);
  check('只做 2 次 → 不合格并说明原因（离散度估不出来）',
    !tooFew.quality.ok && /至少要/.test(tooFew.quality.reasons.join('')), tooFew.quality.reasons.join('；'));

  check('★ 120°/100° 部分动作也被拒绝（有效动作不足同样的原因）',
    !buildBaseline([norm(repFrames()), null, null], SQ).quality.ok, '');
}

/* ================================================================= */
console.log('\n[8] ★ 定标："和平时一样"必须落在 60 分附近');

{
  // 造一个有波动的学生：5 次前倾峰值不同
  const reps = [18, 21, 24, 27, 30].map((f) => norm(repFrames({ fTurn: f })));
  const b = buildBaseline(reps, SQ);
  const p50 = b.spread.p50;
  check('0 分锚点至少是平时差异的 2.5 倍（定标的分母）',
    b.anchors.zero >= p50 * ZERO_RATIO - 1e-9 || b.anchors.zero >= 0.3,
    'zero=' + r2(b.anchors.zero) + '，p50=' + r2(p50));

  // 直接测定标公式本身 —— 不去"造一个差不多的动作"，那测的是探针选得准不准
  const wide = buildBaseline([15, 22, 29, 36, 43].map((f) => norm(repFrames({ fTurn: f }))), SQ);
  const wp50 = wide.spread.p50;
  check('前提：这位学生的波动足够大，0 分线由「平时×2.5」决定',
    2.5 * wp50 > 0.3, 'p50=' + r2(wp50) + '，2.5×p50=' + r2(2.5 * wp50));
  check('★ diff 等于「平时差异」→ 落在 59~65 分（"和平时一样"就是及格线上一点）',
    scoreFromDiff(wp50, wide.anchors) >= 59 && scoreFromDiff(wp50, wide.anchors) <= 65,
    'p50=' + r2(wp50) + '，zero=' + r2(wide.anchors.zero) + ' → ' +
      scoreFromDiff(wp50, wide.anchors) + ' 分（zero 取 max(p90, 2.5×p50)，所以略高于 60）');

  // 极稳定的学生：平时×2.5 小于绝对下限，改由下限兜底 → "和平时一样"会高于 60。
  // 这是刻意的（否则分母趋零、分数乱跳），但必须量化出来并靠 narrow 标告知老师。
  const stable = buildBaseline([21, 24, 27].map((f) => norm(repFrames({ fTurn: f }))), SQ);
  const sp50 = stable.spread.p50;
  check('前提：这位学生波动太小，0 分线由绝对下限兜底',
    2.5 * sp50 < 0.3 && stable.anchors.zero === 0.3, r2(2.5 * sp50) + ' < 0.3');
  check('★ 此时「和平时一样」偏高（60~90 分），但同时标了 narrow 让界面说实话',
    scoreFromDiff(sp50, stable.anchors) >= 60 && scoreFromDiff(sp50, stable.anchors) <= 90 &&
      stable.quality.narrow === true,
    'score=' + scoreFromDiff(sp50, stable.anchors) + '，narrow=' + stable.quality.narrow);
  check('★ diff = 0（完全复制模板）→ 100 分', scoreFromDiff(0, b.anchors) === 100,
    String(scoreFromDiff(0, b.anchors)));
  check('diff 达到 0 分锚点 → 0 分', scoreFromDiff(b.anchors.zero, b.anchors) === 0,
    String(scoreFromDiff(b.anchors.zero, b.anchors)));
  check('超出锚点被夹住，不出现负分或 120 分',
    scoreFromDiff(b.anchors.zero * 3, b.anchors) === 0 && scoreFromDiff(-5, b.anchors) === 100,
    '');

  // 端到端：偏离得越多分越低（方向不能反）
  const same = scoreOf(norm(repFrames({ fTurn: 24 })), b, SQ);
  const better = scoreOf(norm(repFrames({ fTurn: 22 })), b, SQ);
  const worse = scoreOf(norm(repFrames({ fTurn: 45 })), b, SQ);
  check('★ 做得偏离平时更多 → 分数更低', worse.score < same.score,
    'worse=' + worse.score + ' < same=' + same.score);
  check('分数被夹在 0~100 之间', worse.score >= 0 && better.score <= 100,
    'worse=' + worse.score + '，same=' + same.score + '，better=' + better.score);
  check('分数是整数（界面上不出现 61.7 这种）', Number.isInteger(same.score), same.score);
}

/* ================================================================= */
console.log('\n[9] ★ 跨批次可比：锚点固定，不随当前数据重算');

{
  const mk = () => buildBaseline([
    norm(repFrames({ fTurn: 20 })), norm(repFrames({ fTurn: 24 })), norm(repFrames({ fTurn: 28 })),
  ], SQ);
  const b = mk();
  const probe = norm(repFrames({ fTurn: 30 }));

  // 同一份基线、同一动作，隔多少次、什么顺序打分，结果必须完全一样
  const s1 = scoreOf(probe, b, SQ);
  scoreOf(norm(repFrames({ fTurn: 50 })), b, SQ);   // 中间插一个无关动作
  const s2 = scoreOf(probe, b, SQ);
  check('★ 同一动作在同一基线下永远得同一个分（不随调用顺序/当前批次变化）',
    s1.score === s2.score && s1.diff === s2.diff, s1.score + ' vs ' + s2.score);

  const b2 = mk();
  check('同一批数据重建基线，锚点稳定（createdAt 之外完全一致）',
    Math.abs(b.anchors.zero - b2.anchors.zero) < 1e-9, r2(b.anchors.zero) + ' vs ' + r2(b2.anchors.zero));

  const unstable = buildBaseline([
    norm(repFrames({ fTurn: 18 })), norm(repFrames({ fTurn: 30 })), norm(repFrames({ fTurn: 42 })),
  ], SQ);
  check('★ 学生动作越不稳定，0 分线越宽（分数不会因为正常波动就掉到 0）',
    unstable.anchors.zero > b.anchors.zero,
    r2(unstable.anchors.zero) + ' > ' + r2(b.anchors.zero));
}

/* ================================================================= */
console.log('\n[10] 分辨力提示：稳定的学生不该被谎报成"做得很好"');

{
  const stable = buildBaseline([
    norm(repFrames({ fTurn: 22 })), norm(repFrames({ fTurn: 22 })), norm(repFrames({ fTurn: 22 })),
  ], SQ);
  check('三次一模一样 → 标记 narrow（分数分辨力有限）', stable.quality.narrow === true, '');
  check('narrow 时描述里明说，不是只存在数据里', /分辨力有限/.test(describeBaseline(stable)),
    '"' + describeBaseline(stable) + '"');
  check('narrow 时分数仍然算得出来（不是拒绝服务）',
    scoreOf(norm(repFrames({ fTurn: 22 })), stable, SQ) !== null, '');

  const varied = buildBaseline([
    norm(repFrames({ fTurn: 18 })), norm(repFrames({ fTurn: 26 })), norm(repFrames({ fTurn: 40 })),
  ], SQ);
  check('波动明显的学生不标 narrow', varied.quality.narrow === false,
    'p10=' + r2(varied.spread.p10) + ' p90=' + r2(varied.spread.p90) + '（阈值 ' + MIN_SPAN + '）');
}

/* ================================================================= */
console.log('\n[11] 权重：0 权重的信号不参与，不会偷偷影响分数');

{
  const spec = { ...SQ, signals: [{ name: 'torsoLean', weight: 1 }] };
  const zero = { ...SQ, signals: [{ name: 'torsoLean', weight: 0 }] };
  const a = norm(repFrames({ spec }));
  const b = norm(repFrames({ spec, fTurn: 40 }));
  check('有权重时能看出差异', rawDiff(a.vec, b.vec, spec) > 5, '');
  const d0 = diffOf(a.vec, b.vec, { signals: zero.signals, scale: { torsoLean: 1 } });
  check('权重 0 → 差异为 null（不是 0 分，是根本没指标）', d0 === null, String(d0));
}

/* ================================================================= */
console.log('\n[12] 主信号被当成特征时会失效（配置防御）');

{
  // 把 primary 也写进 signals：归一化后它的差异恒为 0，会把真正有信息的信号稀释掉。
  // 造帧仍用正常 spec（否则特征信号根本没值），只在归一化时用"写错了"的那份配置。
  const bad = { ...SQ, signals: [{ name: 'kneeAngle', weight: 1 }, { name: 'torsoLean', weight: 1 }] };
  const a = norm(repFrames(), bad);
  const b = norm(repFrames({ fTurn: 40 }), bad);
  check('★ 归一化会剔除 primary，向量只剩 1 维', a && a.vec[0].length === 1,
    'dim=' + (a && a.vec[0].length));
  const onlyLean = { ...SQ, signals: [{ name: 'torsoLean', weight: 1 }] };
  check('剔除后差异与"只配特征信号"完全一致（说明它本来就没贡献）',
    Math.abs(rawDiff(a.vec, b.vec, onlyLean) - rawDiff(norm(repFrames()), norm(repFrames({ fTurn: 40 })), onlyLean)) < 1e-9,
    '');
}

/* ================================================================= */
console.log('\n[13] 存档：基线能存、取、删、带走，且与校准档案分开');

{
  const st = new BaselineStore(memoryStorage());
  const b = buildBaseline([norm(repFrames()), norm(repFrames({ fTurn: 24 })), norm(repFrames({ fTurn: 28 }))], SQ);

  check('空存档读出空列表', st.list('小明').length === 0, '');
  st.save('小明', 'squat', b);
  st.save('小明', 'pushup', b);
  check('两个动作都记着', st.list('小明').length === 2, JSON.stringify(st.list('小明').map((x) => x.exerciseId)));
  check('取回来还是那份数据', st.get('小明', 'squat').reps === 3, '');
  check('取不存在的给 null', st.get('小明', 'situp') === null, '');

  const dump = st.export();
  const st2 = new BaselineStore(memoryStorage());
  st2.import(dump);
  check('导出再导入还在（换电脑带走）', st2.get('小明', 'squat').reps === 3, '');

  st.remove('小明', 'squat');
  check('删一个动作，另一个留着', st.get('小明', 'squat') === null && !!st.get('小明', 'pushup'), '');
  st.removeStudent('小明');
  check('删学生 → 整条消失', st.list('小明').length === 0, '');

  check('★ 基线用的是自己的 key（不是校准那个）',
    String(memoryStorage().getItem) !== '' && JSON.stringify(st.export()).indexOf('students') !== -1, '');
  check('导入垃圾数据明确报错', (() => {
    try { new BaselineStore(memoryStorage()).import({ nope: 1 }); return false; }
    catch (e) { return /不是基线存档/.test(e.message); }
  })(), '');

  const bad = new BaselineStore({
    getItem: () => '{坏', setItem: () => { throw new Error('quota'); }, removeItem: () => {},
  });
  check('存档坏了不崩，退回空档案并记错误',
    bad.list('小明').length === 0 && !!bad.lastError, String(bad.lastError && bad.lastError.message).slice(0, 20));
}

/* ================================================================= */
console.log('\n[14] 俯卧撑也跑得通（多特征信号，不同量纲）');

{
  const frames = [];
  let t = 0;
  for (let i = 0; i < 30; i++) {
    const u = i / 29;
    frames.push({ tMs: (t += 33), values: {
      elbowAngle: 160 - 60 * u, torsoTilt: 12 + 6 * u, bodyLine: -8 + 20 * u,
    } });
  }
  for (let i = 0; i < 30; i++) {
    const u = i / 29;
    frames.push({ tMs: (t += 33), values: {
      elbowAngle: 100 + 60 * u, torsoTilt: 18 - 6 * u, bodyLine: 12 - 20 * u,
    } });
  }
  const v = normalizeRep(frames, PU);
  check('俯卧撑一次动作 → 16 个进度点，2 个特征信号', v && v.vec.length === 16 && v.vec[0].length === 2,
    v && (v.vec.length + ' 点 × ' + v.vec[0].length + ' 维'));
  const b = buildBaseline([v, v, v], PU);
  check('三个不同量纲的信号一起建基线不会报错', b.quality.ok, JSON.stringify(b.scale));
  const s = scoreOf(v, b, PU);
  check('和基线完全一致的动作 → 接近满分（差异≈0）', s.score >= 95, 'score=' + s.score);
}

/* ================================================================= */

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('相似度回归：' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f.name + '  :: ' + f.detail);
}
console.log('='.repeat(64) + '\n');
process.exit(failed.length ? 1 : 0);
