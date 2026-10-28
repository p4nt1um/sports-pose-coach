/**
 * test-runlog.mjs — run.json 记录层回归（node 直跑）
 *
 * 为什么值得单独测：这一层是**事后排查的唯一凭据**。
 * 它坏了不会报错、界面上也看不出来，只会在某天需要复现问题时
 * 拿出一份字段全 null 的文件 —— 那时候已经晚了。
 *
 * 所以这里盯三件事：
 *   1) 节奏统计只认 activeMs（拿 rawMs 算，「歇了一下」会被算成「做得更慢」）
 *   2) closeRun 不污染入参（就地改过一次，历史里每次都显示最后一次的成绩）
 *   3) 空值/缺字段不炸，且不把 null 混进统计里
 *
 * 用法：node tools/test-runlog.mjs [--verbose]
 */

import {
  RUN_SCHEMA, summarizeRhythm, createRun, closeRun, runFile, describeRun,
} from '../shared/tpc-runlog.js';

const VERBOSE = process.argv.indexOf('--verbose') !== -1;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  :: ' + detail : ''));
}

const T = (label, activeMs, rawMs) => ({ label, activeMs, rawMs: rawMs === undefined ? activeMs : rawMs });

console.log('== 运行记录（run.json）回归 ==');
console.log('   存档格式 ' + RUN_SCHEMA + '\n');

console.log('[1] 节奏统计：只认 activeMs，不认 rawMs');
{
  const empty = summarizeRhythm([]);
  check('空输入 → samples=0、halves 为空', empty.samples === 0 && empty.halves.length === 0,
    JSON.stringify(empty));

  const r = summarizeRhythm([
    [T('下放', 700), T('起身', 760)],
    [T('下放', 800), T('起身', 770)],
    [T('下放', 900), T('起身', null)],
  ]);
  const down = r.halves.find((h) => h.label === '下放');
  const up = r.halves.find((h) => h.label === '起身');
  check('按动词分组，均值/极值都对',
    down.samples === 3 && down.avgMs === 800 && down.minMs === 700 && down.maxMs === 900,
    '下放 ' + JSON.stringify(down));
  check('半程缺数据（activeMs=null）不参与统计，也不把该组算成 0',
    up.samples === 2 && up.avgMs === 765,
    '起身 ' + JSON.stringify(up));
  check('samples 取最大的那一组（不把两个半程加起来）', r.samples === 3, 'samples=' + r.samples);

  // 关键：rawMs 远大时，若实现误用 rawMs，均值会被拉到 2000+
  const withPause = summarizeRhythm([[T('起身', 770, 3000), T('起身', 770, 3100)]]);
  check('底部歇了 2 秒也不会被算成「做得更慢」',
    withPause.halves[0].avgMs === 770,
    'avg=' + withPause.halves[0].avgMs + '（rawMs 是 3000/3100）');

  const dirty = summarizeRhythm([[T('下放', 0), T('下放', -5), { label: '下放', activeMs: 'x' },
    { label: '下放' }, null, T('下放', 600)]]);
  check('0 / 负数 / 非数字 / 缺字段都被跳过，不会把均值算歪',
    dirty.halves.length === 1 && dirty.halves[0].samples === 1 && dirty.halves[0].avgMs === 600,
    JSON.stringify(dirty.halves));

  const capped = summarizeRhythm([[
    T('下放', 100), T('下放', 200), T('下放', 300), T('下放', 400), T('下放', 500),
  ]], 3);
  check('样本数封顶生效（文件不会随上课时长无限变大）',
    capped.halves[0].samples === 3 && capped.halves[0].avgMs === 200,
    JSON.stringify(capped.halves[0]));
}

console.log('\n[2] createRun：开始时的快照');
{
  const cfg = {
    primary: 'kneeAngle',
    channels: [{ id: 'L', signal: 'kneeAngleL' }, { id: 'R', signal: 'kneeAngleR' }],
    fsm: { signal: 'kneeAngle', cycle: ['stand', 'bottom'], minRepMs: 400 },
    signals: { kneeAngle: { type: 'angle', chain: [23, 25, 27], side: 'min' } },
    camera: { view: '正面', minBodyHeightRatioLegacy: undefined },
  };
  const run = createRun({
    at: Date.parse('2026-10-28T06:00:00Z'),
    exercise: { id: 'squat', name: '深蹲', mode: 'reps' },
    cfg,
    appliedCustom: 3,
    patch: { 'fsm.phases.bottom.enter.lte': 96 },
    engine: { model: 'full', delegate: 'GPU', videoW: 1280, videoH: 720 },
    env: { dpr: 1, tzOffsetMin: -480 },
  });

  check('带存档格式版本', run.schema === RUN_SCHEMA, run.schema);
  check('开始时间是可读的 ISO（不是裸时间戳）',
    run.startedAt === '2026-10-28T06:00:00.000Z', run.startedAt);
  check('结束相关字段此刻都是 null（还没结束，不编造）',
    run.endedAt === null && run.durationMs === null && run.endReason === null,
    JSON.stringify([run.endedAt, run.durationMs, run.endReason]));

  check('★ patch 与 effective 都留了（一个答"改了什么"，一个答"当时生效什么"）',
    run.config.appliedCustom === 3 &&
    run.config.patch['fsm.phases.bottom.enter.lte'] === 96 &&
    run.config.effective.fsm.minRepMs === 400 &&
    run.config.effective.signals.kneeAngle.side === 'min',
    'appliedCustom=' + run.config.appliedCustom + '，effective.fsm 与 signals 都在');

  check('通道只留 id（信号定义在 signals 里，不重复存）',
    JSON.stringify(run.config.effective.channelIds) === '["L","R"]',
    JSON.stringify(run.config.effective.channelIds));

  check('画面比例算好存下（16:9 的偏差是"读出来是 60°"这类假故障的常见来源）',
    run.engine.aspect === 1.7778, 'aspect=' + run.engine.aspect);

  const bare = createRun({});
  check('什么都不传也不炸，字段给 null 而不是 undefined',
    bare.exercise.id === null && bare.config.effective.fsm === null &&
    bare.engine === null && bare.env === null,
    '空配置安全');
}

console.log('\n[3] closeRun：结束时补齐，且不污染入参');
{
  const run = createRun({
    at: Date.parse('2026-10-28T06:00:00Z'),
    exercise: { id: 'squat', name: '深蹲', mode: 'reps' },
    cfg: { primary: 'kneeAngle', fsm: { signal: 'kneeAngle' } },
    engine: { model: 'full', delegate: 'GPU', videoW: 1280, videoH: 720 },
  });
  const snapshot = {
    mode: 'reps',
    count: 30,
    totalMs: null,
    rejections: { too_fast: 2, too_slow: 0, partial: 1, low_conf: 0 },
    sessions: [],
    channels: [{ id: 'L', label: '左腿', count: 30 }],
  };
  const done = closeRun(run, {
    at: Date.parse('2026-10-28T06:03:00Z'),
    snapshot,
    reason: 'stopped',
    reps: [[T('下放', 700), T('起身', 770)], [T('下放', 730), T('起身', 790)]],
    inferMs: { last: 21.3, p50: 20.1, p95: 33.4 },
  });

  check('时长按真实时间算（3 分钟 = 180000ms）', done.durationMs === 180000,
    'durationMs=' + done.durationMs);
  check('结束原因记下来', done.endReason === 'stopped', done.endReason);
  check('成绩按白名单取，不把整个 snapshot 塞进去',
    done.result.count === 30 && done.result.rejections.partial === 1 &&
    JSON.stringify(done.result.channels) === '[{"id":"L","label":"左腿","count":30}]',
    JSON.stringify(done.result.channels));
  check('节奏汇总进同一份文件（不用另开一个文件对时间）',
    done.rhythm.samples === 2 &&
    done.rhythm.halves.find((h) => h.label === '下放').avgMs === 715,
    JSON.stringify(done.rhythm.halves));
  check('推理耗时统计跟着引擎段落走', done.engine.inferMs.p95 === 33.4,
    JSON.stringify(done.engine.inferMs));

  check('★ 原对象没被改（历史记录不会被后续动作覆盖）',
    run.endedAt === null && run.result === null && run.rhythm === null,
    '原 run：result=' + run.result + '，rhythm=' + run.rhythm);

  const holdRep = closeRun(createRun({ at: Date.parse('2026-10-28T06:00:00Z') }), {
    at: Date.parse('2026-10-28T06:01:00Z'),
    snapshot: { mode: 'hold', count: 0, totalMs: 12000, sessions: [{ valid: true }, { valid: false }] },
    reason: 'switched',
  });
  check('计时动作记 totalMs 与有效段数（不是记 0 次）',
    holdRep.result.totalMs === 12000 && holdRep.result.sessions === 2 &&
    holdRep.result.validSessions === 1,
    'totalMs=' + holdRep.result.totalMs + '，段 ' + holdRep.result.validSessions + '/' + holdRep.result.sessions);
  check('没传 reps 时节奏为空，不报错',
    holdRep.rhythm.samples === 0 && holdRep.rhythm.halves.length === 0,
    JSON.stringify(holdRep.rhythm));

  check('closeRun(null) 返回 null（调用方不用自己做空判断）', closeRun(null, {}) === null);
  check('默认结束原因是 stopped',
    closeRun(createRun({ at: Date.now() }), { at: Date.now() }).endReason === 'stopped');
}

console.log('\n[4] runFile / describeRun：打包与一句话摘要');
{
  const a = closeRun(createRun({ at: Date.parse('2026-10-28T06:00:00Z'), exercise: { id: 'squat', name: '深蹲' } }), {
    at: Date.parse('2026-10-28T06:03:00Z'),
    snapshot: { mode: 'reps', count: 30 },
    reps: [[T('下放', 700), T('起身', 770)]],
  });
  const f = runFile([a, null, undefined], { appVersion: '0.4.0', exportedAt: Date.parse('2026-10-28T07:00:00Z') });

  check('打包时过滤掉空记录（不会导出 [null] 这种文件）',
    f.count === 1 && f.runs.length === 1, 'count=' + f.count);
  check('带上版本与导出时间（旧文件要先确认出自哪个版本）',
    f.app.version === '0.4.0' && f.exportedAt === '2026-10-28T07:00:00.000Z',
    f.app.version + ' @ ' + f.exportedAt);
  check('空列表也能打包', runFile(null).count === 0, JSON.stringify(runFile(null).count));

  check('摘要能一眼看出「做了什么、做了多久、多快」',
    describeRun(a) === '3 分钟 · 30 次 · 下放 0.70s / 起身 0.77s',
    '"' + describeRun(a) + '"');
  check('没结束的记录不编造摘要', describeRun(createRun({ at: Date.now() })) === '',
    '"' + describeRun(createRun({ at: Date.now() })) + '"');
  check('describeRun(null) 返回空串', describeRun(null) === '');
}

/* ------------------------------ 汇总 ------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(64));
console.log('运行记录回归：' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
if (failed.length) {
  console.log('\n失败项：');
  for (const f of failed) console.log('  · ' + f.name + '  :: ' + f.detail);
}
if (VERBOSE) {
  const run = closeRun(createRun({ at: Date.parse('2026-10-28T06:00:00Z'), exercise: { id: 'squat', name: '深蹲' } }), {
    at: Date.parse('2026-10-28T06:03:00Z'), snapshot: { mode: 'reps', count: 30 },
  });
  console.log('\n样例：\n' + JSON.stringify(run, null, 2).slice(0, 900));
}
process.exit(failed.length ? 1 : 0);
