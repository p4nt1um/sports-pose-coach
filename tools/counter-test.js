'use strict';

/**
 * tools/counter-test.js — 「上课用」计数主界面自检
 *
 * 这一页是老师真正会打开的页面，出错的代价比调试台大得多
 * （调试台你只在调参时看，计数页上课时一直开着）。所以覆盖面要更宽：
 *
 *  A. 骨架：动作下拉、默认动作、初始读数、界面无残留
 *  B. 计数：合成信号喂进页面里的真实链路，逐个动作验证
 *      —— 含高抬腿的**左右腿分通道**（这是唯一不能靠单信号实现的动作）
 *  C. 计时：马步 / 靠墙静蹲，读数与秒表对表
 *  D. 参数复用：与调试台共用一份存档 —— 这一页最容易被写漏的接线
 *  E. 成绩记录与 CSV 导出
 *  F. 摄像头：合成画面跑真实推理，且**画面里没有人时不能凭空计数**
 *  G. 首页入口可达
 *
 * 用法： node tools/counter-test.js [--port 4400] [--shot out.png]
 * 前置： node tools/serve.js --port 4400 --no-open
 */

const { launch } = require('./pw.js');

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx !== -1 ? argv[portIdx + 1] : '4400';
const shotIdx = argv.indexOf('--shot');
const SHOT = shotIdx !== -1 ? argv[shotIdx + 1] : null;
const BASE = 'http://127.0.0.1:' + PORT;
const PAGE = BASE + '/v1-counter.html';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -> ' + detail : ''));
}

/* ============================ 合成信号 ============================ */

const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, x)));

/**
 * 计数类动作的合成帧。
 * 一个周期 = 起始相位 → 极值 → 回到起始相位（与配置里的 minRepMs 口径一致）。
 * @param {string[]} signalNames 该动作的全部信号名（未驱动的一律置 null）
 * @param {object[]} driver [{signal, offsetMs}] —— 多通道用 offsetMs 错开相位
 */
function repsFrames(opts) {
  const {
    signalNames, driver, start, extreme,
    reps, periodMs, fps = 30, preMs = 900, postMs = 700,
  } = opts;
  const dt = 1000 / fps;
  const half = periodMs / 2;
  const maxOffset = Math.max(0, ...driver.map((d) => d.offsetMs || 0));
  const total = preMs + reps * periodMs + postMs + maxOffset;

  const at = (u) => {
    if (u < 0 || u >= reps * periodMs) return start;   // 前置/后置停在起始姿势
    const tl = u % periodMs;
    const d = tl < half ? ease(tl / half) : 1 - ease((tl - half) / half);
    return start + (extreme - start) * d;
  };

  const out = [];
  for (let t = 0; t <= total; t += dt) {
    const v = {};
    const c = {};
    for (const n of signalNames) { v[n] = null; c[n] = 0; }
    for (const d of driver) {
      v[d.signal] = at(t - preMs - (d.offsetMs || 0));
      c[d.signal] = 1;
    }
    out.push({ t: Math.round(t), v, c });
  }
  return out;
}

/** 计时类动作的合成帧：「不满足 → 保持 seconds 秒 → 不满足」 */
function holdFrames(opts) {
  const { signalNames, on, off, seconds, fps = 30, preMs = 900, postMs = 700 } = opts;
  const dt = 1000 / fps;
  const total = preMs + seconds * 1000 + postMs;
  const out = [];
  for (let t = 0; t <= total; t += dt) {
    const inside = t >= preMs && t < preMs + seconds * 1000;
    const v = {};
    const c = {};
    for (const n of signalNames) { v[n] = null; c[n] = 0; }
    const src = inside ? on : off;
    for (const k of Object.keys(src)) { v[k] = src[k]; c[k] = 1; }
    out.push({ t: Math.round(t), v, c });
  }
  return out;
}

/**
 * 计时类动作的「分段」合成帧：按 [{hold:ms},{brk:ms},…] 交替保持与断开。
 * 用来构造「中途姿势散过又抖回来」——这是 hold 侧唯一能被程序分辨的不合格特征，
 * 只有这样才能验证语音指导真的会在中断时报出原因，而不是永远沉默。
 */
function holdSegmentsFrames(opts) {
  const { signalNames, on, off, segments, fps = 30, preMs = 900, postMs = 700 } = opts;
  const dt = 1000 / fps;
  const plan = [];
  let t0 = preMs;
  for (const s of segments) {
    if (s.hold) { plan.push({ from: t0, to: t0 + s.hold, on: true }); t0 += s.hold; }
    if (s.brk) { plan.push({ from: t0, to: t0 + s.brk, on: false }); t0 += s.brk; }
  }
  const out = [];
  for (let t = 0; t <= t0 + postMs; t += dt) {
    const onNow = plan.some((p) => p.on && t >= p.from && t < p.to);
    const src = onNow ? on : off;
    const v = {};
    const c = {};
    for (const n of signalNames) { v[n] = null; c[n] = 0; }
    for (const k of Object.keys(src)) { v[k] = src[k]; c[k] = 1; }
    out.push({ t: Math.round(t), v, c });
  }
  return out;
}

/** 读当前动作的信号名列表 */
async function signalsOf(page) {
  return page.evaluate(() => Object.keys(window.__counter.cfg.signals));
}

/** 在当前动作上跑一段合成信号：先清零，再喂帧 */
async function runFrames(page, frames) {
  await page.evaluate(() => window.__counter.zero());
  return page.evaluate((f) => window.__counter.feed(f), frames);
}

/* ============================ 主流程 ============================ */

(async () => {
  console.log('== 计数主界面自检 @ ' + PAGE + '\n');

  const browser = await launch();
  const context = await browser.newContext({ permissions: ['camera'] });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const externalRequests = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (r) => failedRequests.push(r.url() + ' :: ' + ((r.failure() && r.failure().errorText) || '')));
  page.on('request', (r) => {
    const u = r.url();
    if (!/^https?:/.test(u)) return;
    if (u.indexOf(BASE) !== 0) externalRequests.push(u);
  });

  // 起点必须是干净的：上一次自检留下的调试台存档与成绩记录都会污染断言
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.indexOf('spc.') === 0)
        .forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* 存储不可用另有断言覆盖 */ }
  });

  /* ---------------- A. 骨架 ---------------- */

  console.log('[A] 页面骨架');
  const res = await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  check('计数页可访问', res && res.status() === 200, res ? 'HTTP ' + res.status() : '无响应');

  let booted = false;
  try {
    await page.waitForFunction('window.__counter && window.__counter.booted === true', null, { timeout: 15000 });
    booted = true;
  } catch (e) { /* 下面断言里报 */ }
  check('初始化完成（data/exercises.json 已载入）', booted, booted ? '' : '未能启动');

  const list = await page.evaluate(() => window.__counter.exercises);
  check('动作下拉列出 7 个动作',
    list.length === 7, list.map((x) => x.id).join(', '));
  check('动作含 5 个计数 + 2 个计时',
    list.filter((x) => x.mode === 'reps').length === 5 && list.filter((x) => x.mode === 'hold').length === 2,
    list.map((x) => x.name + '(' + x.mode + ')').join(' '));

  const domOptions = await page.$$eval('#selExercise option', (os) => os.map((o) => o.value));
  check('下拉 DOM 与配置一致（顺序按 order）',
    domOptions.join(',') === list.map((x) => x.id).join(','), domOptions.join(', '));

  const first = await page.evaluate(() => ({
    id: window.__counter.exerciseId,
    mode: window.__counter.mode,
    count: window.__counter.count,
    applied: window.__counter.appliedCustom,
  }));
  check('默认动作是深蹲（order 最小）', first.id === 'squat' && first.mode === 'reps', JSON.stringify(first));
  check('初始计数为 0', first.count === 0, 'count=' + first.count);
  check('无存档时不报「已套用自定义参数」', first.applied === 0, 'applied=' + first.applied);

  const initNum = await page.evaluate(() => window.__counter.bigNumText());
  check('大号读数初始显示 0 次', /^0\s*次?$/.test(initNum) || initNum.indexOf('0') === 0, '"' + initNum + '"');

  const hint = await page.evaluate(() => window.__counter.cameraHintText());
  check('机位提示取自配置（不是写死的文案）',
    hint.indexOf('深蹲') === -1 && hint.length > 8, hint.slice(0, 44) + '…');

  /* ---------------- B. 计数 ---------------- */

  console.log('\n[B] 计数：合成信号驱动页面里的真实链路');

  const sqSig = await signalsOf(page);
  const squat30 = await runFrames(page, repsFrames({
    signalNames: sqSig, driver: [{ signal: 'kneeAngle' }],
    start: 172, extreme: 85, reps: 30, periodMs: 2000,
  }));
  check('深蹲 30 次 → 计数 30', squat30.count === 30,
    'count=' + squat30.count + '，拒绝=' + JSON.stringify(squat30.rejections));

  const domAfter = await page.evaluate(() => window.__counter.bigNumText());
  check('计数同步到大号读数', domAfter.indexOf('30') === 0, '"' + domAfter + '"');

  const half30 = await runFrames(page, repsFrames({
    signalNames: sqSig, driver: [{ signal: 'kneeAngle' }],
    start: 172, extreme: 132, reps: 30, periodMs: 2000,
  }));
  check('半蹲 30 次（只到 132°）→ 一次都不算', half30.count === 0, 'count=' + half30.count);

  const fast40 = await runFrames(page, repsFrames({
    signalNames: sqSig, driver: [{ signal: 'kneeAngle' }],
    start: 172, extreme: 85, reps: 40, periodMs: 250,
  }));
  check('过快抖动 40 次 → 0，且「抖动被丢弃」有数',
    fast40.count === 0 && fast40.rejections.too_fast > 0,
    'count=' + fast40.count + '，too_fast=' + fast40.rejections.too_fast);

  // 必须紧接着读 DOM —— 下面一跑 runFrames 就会清零，诊断面板也随之归零
  const diagFast = await page.textContent('#diagFast');
  check('诊断面板把抖动数显示在界面上（老师能自己看懂为什么没计数）',
    Number(diagFast) > 0, '#diagFast=' + diagFast.trim());

  const still = await runFrames(page, repsFrames({
    signalNames: sqSig, driver: [{ signal: 'kneeAngle' }],
    start: 172, extreme: 172, reps: 0, periodMs: 2000,
  }));
  check('静立不动 → 0', still.count === 0, 'count=' + still.count);

  const zeroed = await page.evaluate(() => window.__counter.zero());
  check('清零 → 计数归零、界面同步', zeroed.count === 0, 'count=' + zeroed.count);
  const zeroNum = await page.evaluate(() => window.__counter.bigNumText());
  check('清零后大号读数回到 0', zeroNum.indexOf('0') === 0, '"' + zeroNum + '"');

  // ---- 多通道：原地高抬腿 ----
  console.log('\n[B2] 多通道：原地高抬腿（左右腿各跑一个状态机）');
  await page.evaluate(() => window.__counter.setExercise('high_knee'));
  const hkSig = await signalsOf(page);
  check('高抬腿的信号集含左右腿两条膝高',
    hkSig.indexOf('kneeHeightL') !== -1 && hkSig.indexOf('kneeHeightR') !== -1, hkSig.join(', '));

  const hk20 = await runFrames(page, repsFrames({
    signalNames: hkSig,
    driver: [{ signal: 'kneeHeightL' }, { signal: 'kneeHeightR', offsetMs: 300 }],
    start: 0.5, extreme: -0.15, reps: 10, periodMs: 600,
  }));
  check('左右交替 20 次（每腿 10 次）→ 合计 20', hk20.count === 20,
    'count=' + hk20.count + '，拒绝=' + JSON.stringify(hk20.rejections));

  const chCounts = (hk20.channels || []).map((c) => c.id + '=' + c.count).join(' ');
  check('两条通道各自计数正确（左 10 右 10）',
    hk20.channels && hk20.channels.length === 2 &&
      hk20.channels.find((c) => c.id === 'L').count === 10 &&
      hk20.channels.find((c) => c.id === 'R').count === 10,
    chCounts);

  const chanRowText = await page.textContent('#chanRow');
  check('界面上显示分腿计数', /左腿/.test(chanRowText) && /右腿/.test(chanRowText),
    chanRowText.replace(/\s+/g, ' ').trim());

  const hkLeftOnly = await runFrames(page, repsFrames({
    signalNames: hkSig, driver: [{ signal: 'kneeHeightL' }],
    start: 0.5, extreme: -0.15, reps: 10, periodMs: 600,
  }));
  check('只抬左腿 10 次 → 合计 10，右腿保持 0',
    hkLeftOnly.count === 10 &&
      hkLeftOnly.channels.find((c) => c.id === 'R').count === 0,
    (hkLeftOnly.channels || []).map((c) => c.id + '=' + c.count).join(' '));

  const hkLow = await runFrames(page, repsFrames({
    signalNames: hkSig,
    driver: [{ signal: 'kneeHeightL' }, { signal: 'kneeHeightR', offsetMs: 300 }],
    start: 0.5, extreme: 0.15, reps: 10, periodMs: 600,
  }));
  check('抬腿但膝未过髋（峰值 +0.15）→ 一次都不算', hkLow.count === 0, 'count=' + hkLow.count);

  // ---- 其余三个计数动作 ----
  console.log('\n[B3] 其余计数动作：同一套代码，只换配置');
  const cases = [
    { id: 'jumping_jack', name: '开合跳', signal: 'ankleSpread', start: 0.35, extreme: 1.8, periodMs: 1400 },
    { id: 'pushup', name: '俯卧撑', signal: 'elbowAngle', start: 170, extreme: 85, periodMs: 2000 },
    { id: 'situp', name: '仰卧起坐', signal: 'torsoTilt', start: 85, extreme: 20, periodMs: 2000 },
  ];
  for (const c of cases) {
    await page.evaluate((id) => window.__counter.setExercise(id), c.id);
    const sigs = await signalsOf(page);
    const r = await runFrames(page, repsFrames({
      signalNames: sigs, driver: [{ signal: c.signal }],
      start: c.start, extreme: c.extreme, reps: 15, periodMs: c.periodMs,
    }));
    check(c.name + ' 15 次 → 计数 15', r.count === 15, 'count=' + r.count + '，拒绝=' + JSON.stringify(r.rejections));
  }

  /* ---------------- C. 计时 ---------------- */

  console.log('\n[C] 计时：马步 / 靠墙静蹲');

  await page.evaluate(() => window.__counter.setExercise('horse_stance'));
  const hsSig = await signalsOf(page);
  check('切到计时动作后模式变为 hold', (await page.evaluate(() => window.__counter.mode)) === 'hold', '');

  const hsHold = await runFrames(page, holdFrames({
    signalNames: hsSig, on: { kneeAngle: 100, torsoLean: 5 }, off: { kneeAngle: 170, torsoLean: 3 },
    seconds: 5,
  }));
  check('马步保持 5 秒 → 计时 ≈ 5.0s（与秒表对表）',
    Math.abs(hsHold.liveMs - 5000) <= 150, 'liveMs=' + hsHold.liveMs + 'ms');
  check('结账后 totalMs 与 liveMs 一致',
    Math.abs(hsHold.totalMs - hsHold.liveMs) <= 1, 'total=' + hsHold.totalMs + '，live=' + hsHold.liveMs);
  check('识别出 1 个有效段', hsHold.sessions === 1, 'sessions=' + hsHold.sessions);

  const hsNum = await page.evaluate(() => window.__counter.bigNumText());
  check('大号读数以「秒」显示', /秒/.test(hsNum) && /5/.test(hsNum), '"' + hsNum + '"');

  const hsConds = await page.textContent('#holdConds');
  check('界面上逐条列出计时条件', (hsConds.match(/[✓✗]/g) || []).length >= 2,
    hsConds.replace(/\s+/g, ' ').trim().slice(0, 70) + '…');

  const hsBad = await runFrames(page, holdFrames({
    signalNames: hsSig, on: { kneeAngle: 170, torsoLean: 3 }, off: { kneeAngle: 170, torsoLean: 3 },
    seconds: 5,
  }));
  check('站直不动（膝角 170°）→ 不计时', hsBad.liveMs === 0, 'liveMs=' + hsBad.liveMs);

  const hsLean = await runFrames(page, holdFrames({
    signalNames: hsSig, on: { kneeAngle: 100, torsoLean: 45 }, off: { kneeAngle: 170, torsoLean: 3 },
    seconds: 5,
  }));
  check('膝角达标但躯干前倾 45° → 不计时', hsLean.liveMs === 0, 'liveMs=' + hsLean.liveMs);

  const hsShort = await runFrames(page, holdFrames({
    signalNames: hsSig, on: { kneeAngle: 100, torsoLean: 5 }, off: { kneeAngle: 170, torsoLean: 3 },
    seconds: 1,
  }));
  check('只保持 1.0 秒（短于最短有效段 1.5s）→ 不计入总时长',
    hsShort.liveMs === 0, 'liveMs=' + hsShort.liveMs);

  await page.evaluate(() => window.__counter.setExercise('wall_sit'));
  const wsSig = await signalsOf(page);
  const wsHold = await runFrames(page, holdFrames({
    signalNames: wsSig, on: { kneeAngle: 100, torsoLean: 8 }, off: { kneeAngle: 170, torsoLean: 3 },
    seconds: 5,
  }));
  check('靠墙静蹲保持 5 秒 → 计时 ≈ 5.0s', Math.abs(wsHold.liveMs - 5000) <= 150, 'liveMs=' + wsHold.liveMs + 'ms');

  const wsTilt = await runFrames(page, holdFrames({
    signalNames: wsSig, on: { kneeAngle: 100, torsoLean: 25 }, off: { kneeAngle: 170, torsoLean: 3 },
    seconds: 5,
  }));
  check('躯干只直立到 25°（未达贴墙标准 20°）→ 不计时', wsTilt.liveMs === 0, 'liveMs=' + wsTilt.liveMs);

  /* ---------------- D. 参数复用（这一页最容易被写漏的接线） ---------------- */

  console.log('\n[D] 参数复用：与调试台共用同一份存档');

  await page.evaluate(() => {
    localStorage.setItem('spc.tuned.squat', JSON.stringify({
      v: 1, id: 'squat', savedAt: Date.now(), savedAtText: '09-22 10:00',
      patch: { 'fsm.phases.bottom.enter.lte': 140 },
      baseline: { 'fsm.phases.bottom.enter.lte': 100 },
    }));
  });
  await page.evaluate(() => window.__counter.setExercise('squat'));

  const applied = await page.evaluate(() => ({
    applied: window.__counter.appliedCustom,
    lte: window.__counter.cfg.fsm.phases.bottom.enter.lte,
    note: window.__counter.paramNoteText(),
  }));
  check('调试台存下的参数被本页载入', applied.applied === 1 && applied.lte === 140,
    'applied=' + applied.applied + '，lte=' + applied.lte);
  check('界面上写明参数来源与保存时间（老师能确认「用的是我调的那套」）',
    /已套用 1 项调试台自定义参数/.test(applied.note) && /09-22 10:00/.test(applied.note),
    applied.note.slice(0, 60));

  const sqSig2 = await signalsOf(page);
  const halfNow = await runFrames(page, repsFrames({
    signalNames: sqSig2, driver: [{ signal: 'kneeAngle' }],
    start: 172, extreme: 132, reps: 30, periodMs: 2000,
  }));
  check('★ 阈值放宽到 140° 后，同一段「半蹲」开始计数（参数确实生效，不是只显示）',
    halfNow.count === 30, 'count=' + halfNow.count);

  // 计时动作的 hold 段参数也要能存能取 —— 这是回归保护：
  // flattenParams 曾经漏掉 hold 子树，导致计时动作「调完刷新全没了」且不报错
  await page.evaluate(() => {
    localStorage.setItem('spc.tuned.wall_sit', JSON.stringify({
      v: 1, id: 'wall_sit', savedAt: Date.now(), savedAtText: '09-22 10:05',
      patch: { 'hold.minSessionMs': 100 },
      baseline: { 'hold.minSessionMs': 1500 },
    }));
  });
  await page.evaluate(() => window.__counter.setExercise('wall_sit'));
  const wsApplied = await page.evaluate(() => ({
    applied: window.__counter.appliedCustom,
    minSessionMs: window.__counter.cfg.hold.minSessionMs,
  }));
  check('计时动作的 hold 段参数同样能被载入',
    wsApplied.applied === 1 && wsApplied.minSessionMs === 100,
    'applied=' + wsApplied.applied + '，minSessionMs=' + wsApplied.minSessionMs);

  const wsSig2 = await signalsOf(page);
  const wsShortNow = await runFrames(page, holdFrames({
    signalNames: wsSig2, on: { kneeAngle: 100, torsoLean: 8 }, off: { kneeAngle: 170, torsoLean: 3 },
    seconds: 1,
  }));
  check('★ 最短有效段改成 0.1s 后，同一段 1.0 秒的静蹲被计入了',
    wsShortNow.liveMs > 500, 'liveMs=' + wsShortNow.liveMs + 'ms（默认参数下是 0）');

  // 各动作各存各的：深蹲的存档不该影响静蹲
  const crossCheck = await page.evaluate(() => ({
    squat: JSON.parse(localStorage.getItem('spc.tuned.squat')).patch,
    wall: JSON.parse(localStorage.getItem('spc.tuned.wall_sit')).patch,
  }));
  check('存档按动作分开存（互不串味）',
    !('hold.minSessionMs' in crossCheck.squat) && !('fsm.phases.bottom.enter.lte' in crossCheck.wall),
    'squat: ' + Object.keys(crossCheck.squat).join(',') + ' | wall_sit: ' + Object.keys(crossCheck.wall).join(','));

  /* ---------------- E. 成绩记录与 CSV ---------------- */

  console.log('\n[E] 成绩记录与 CSV 导出');

  await page.evaluate(() => window.__counter.clearRecords());
  await page.evaluate(() => window.__counter.setExercise('squat'));
  const sqSig3 = await signalsOf(page);
  await runFrames(page, repsFrames({
    signalNames: sqSig3, driver: [{ signal: 'kneeAngle' }],
    start: 172, extreme: 132, reps: 12, periodMs: 2000,
  }));
  const recCount = await page.evaluate(() => window.__counter.record());
  check('记录当前成绩 → 列表里有 1 条', recCount === 1, 'records=' + recCount);

  const recRow = await page.textContent('#recList');
  check('记录表显示动作名与成绩',
    /深蹲/.test(recRow) && /12/.test(recRow), recRow.replace(/\s+/g, ' ').trim().slice(0, 60));

  // 计时动作也要能记录
  await page.evaluate(() => window.__counter.setExercise('horse_stance'));
  const hsSig3 = await signalsOf(page);
  await runFrames(page, holdFrames({
    signalNames: hsSig3, on: { kneeAngle: 100, torsoLean: 5 }, off: { kneeAngle: 170, torsoLean: 3 },
    seconds: 5,
  }));
  const rec2 = await page.evaluate(() => window.__counter.record());
  check('计时动作也能记录（记为秒数）', rec2 === 2, 'records=' + rec2);

  const csv = await page.evaluate(() => window.__counter.csvText());
  const body = csv.charCodeAt(0) === 0xFEFF ? csv.slice(1) : csv;   // 剥掉 BOM 再比对表头
  const lines = body.split('\r\n');
  check('CSV 带 UTF-8 BOM（Excel 打开不乱码）', csv.charCodeAt(0) === 0xFEFF, '首字符 U+' + csv.charCodeAt(0).toString(16).toUpperCase());
  check('CSV 表头齐全', lines[0].indexOf('时间,动作,模式,计数,时长(秒)') === 0, lines[0]);
  check('CSV 含 2 条记录且字段数一致',
    lines.length === 3 && lines.slice(1).every((l) => l.split(',').length === 6),
    lines.length - 1 + ' 行数据');
  check('CSV 里计数记数、计时记秒（不是同一个字段混着放）',
    lines.some((l) => l.indexOf('计数,12,') !== -1) && lines.some((l) => l.indexOf('计时,,5.0') !== -1),
    lines.slice(1).map((l) => l.replace(/^[^,]*,/, '')).join(' || '));

  const cleared = await page.evaluate(() => window.__counter.clearRecords());
  check('清空记录 → 归零', cleared === 0, 'records=' + cleared);
  const emptyRow = await page.textContent('#recList');
  check('清空后列表回到空状态', /还没有记录/.test(emptyRow), emptyRow.trim());

  /* ---------------- F. 摄像头 ---------------- */

  console.log('\n[F] 摄像头：合成画面 + 真实推理（画面里没有人）');
  await page.evaluate(() => window.__counter.setExercise('squat'));
  await page.click('#btnStart');

  let engineOk = false;
  try {
    await page.waitForFunction(
      'window.__counter.running === true && window.__counter.delegate !== null',
      null, { timeout: 60000 }
    );
    engineOk = true;
  } catch (e) { /* 下面断言里报 */ }

  const cam = await page.evaluate(() => ({
    running: window.__counter.running,
    delegate: window.__counter.delegate,
    count: window.__counter.count,
    badge: document.getElementById('badge').textContent,
  }));
  check('点击后引擎跑起来', engineOk, 'running=' + cam.running + '，delegate=' + cam.delegate);
  check('后端为 GPU（回落 CPU 也不报错）', cam.delegate === 'GPU' || cam.delegate === 'CPU', String(cam.delegate));

  await page.waitForTimeout(2500);
  const cam2 = await page.evaluate(() => ({ count: window.__counter.count, running: window.__counter.running }));
  check('★ 合成画面里没有人 → 不产生任何计数（这是「不误计」的底线）',
    cam2.count === 0, '跑了 2.5s，count=' + cam2.count);

  await page.click('#btnStop');
  await page.waitForTimeout(300);
  check('停止后状态回到未运行', (await page.evaluate(() => window.__counter.running)) === false, '');

  if (SHOT) {
    await page.evaluate(() => window.__counter.setExercise('high_knee'));
    const s = await signalsOf(page);
    await runFrames(page, repsFrames({
      signalNames: s,
      driver: [{ signal: 'kneeHeightL' }, { signal: 'kneeHeightR', offsetMs: 300 }],
      start: 0.5, extreme: -0.15, reps: 10, periodMs: 600,
    }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: SHOT, fullPage: false });
    console.log('\n  截图已保存：' + SHOT);
  }

  console.log('\n[F2] 全局（含「视频不出本机」这条对外承诺）');
  check('零外部请求（完全离线）', externalRequests.length === 0,
    externalRequests.length ? externalRequests.slice(0, 3).join(' | ') : '0 个');
  check('无资源加载失败', failedRequests.length === 0,
    failedRequests.length ? failedRequests.slice(0, 3).join(' | ') : '0 个');
  check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');
  check('无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0 条');

  // 离线护栏：MediaPipe 内置的使用统计上报器没有关闭开关，只能在传输层拦。
  // 它每 60 秒才 flush 一次、close() 会强制 flush —— 所以必须「停止引擎之后」再查，
  // 只看运行中的几秒钟是查不到的（这正是本条断言的由来）。
  const guard = await page.evaluate(() => ({
    installed: !!window.__offlineGuard,
    count: window.__offlineGuard ? window.__offlineGuard.count : 0,
    hosts: window.__offlineGuard ? window.__offlineGuard.hosts : [],
    last: window.__offlineGuard ? window.__offlineGuard.last() : null,
  }));
  check('页面上装了离线护栏（且它在任何模块之前执行）', guard.installed, '');
  check('★ 停止推理时 MediaPipe 的境外遥测上报被拦下（否则「视频不出本机」不成立）',
    guard.count > 0 && guard.hosts.some((h) => /pa\.googleapis\.com/.test(h)),
    guard.count + ' 次，主机：' + guard.hosts.join(', ') + '，最近一次通过 ' + (guard.last ? guard.last.how : '?'));

  /* ---------------- H. 语音指导 ---------------- */

  console.log('\n[H] 语音指导（报原因，与「语音播报」互不冲突）');

  // 先清掉开关存档与调参存档，再重新载入 —— 两件事：
  //   ① 验证「首次打开默认都是关的」；
  //   ② 让本段不依赖 [D] 留下的自定义阈值（它把 wall_sit 的最短有效段改成了 0.1s，
  //      不清掉的话下面「段太短」的用例会莫名其妙地变成有效段）。
  await page.evaluate(() => {
    try {
      localStorage.removeItem('spc.voice.v1');
      Object.keys(localStorage).filter((k) => k.indexOf('spc.tuned.') === 0)
        .forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* 忽略 */ }
  });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__counter && window.__counter.booted === true', null, { timeout: 15000 });

  const pref0 = await page.evaluate(() => ({
    voice: window.__counter.voice, guide: window.__counter.guide, raw: window.__counter.voiceStoreRaw(),
    applied: window.__counter.appliedCustom,
  }));
  check('★ 首次打开两个开关都是关的',
    pref0.voice === false && pref0.guide === false && pref0.raw === '',
    'voice=' + pref0.voice + '，guide=' + pref0.guide + '，存档=' + JSON.stringify(pref0.raw));
  check('本段跑在文件默认参数上（不受前面调参存档影响）', pref0.applied === 0,
    'applied=' + pref0.applied);

  // 发声换成立刻回调的桩：否则同步喂完几百帧时，第一句永远"正在播"，
  // 后面的话全被压进待播槽，自检会把「其实播了」误判成「没播」。
  await page.evaluate(() => window.__counter.setStubSpeech(true));

  const hSqSig = await signalsOf(page);
  // 稳定的「快抖」信号：60fps / 250ms 周期 → 12 次动作全部被判为抖动（0 计数、12 次不合格）。
  // 总时长 4.6s，短于 5s 冷却 → 「同一句只念一次」可以精确断言。
  const shakeOpts = {
    signalNames: hSqSig, driver: [{ signal: 'kneeAngle' }],
    start: 172, extreme: 85, reps: 12, periodMs: 250, fps: 60,
  };

  const h0 = await runFrames(page, repsFrames(shakeOpts));
  const h0Spoken = await page.evaluate(() => window.__counter.spoken);
  const h0Guide = await page.evaluate(() => window.__counter.guideText());
  check('两个开关都关时，一条语音也不发',
    h0Spoken.length === 0, 'spoken=' + h0Spoken.length);
  check('★ 开关关着也照样算出「该说什么原因」（开关只管发声，不改判定）',
    h0.count === 0 && h0.rejections.too_fast > 0 && h0Guide === '太快了，不算',
    'count=' + h0.count + '，too_fast=' + h0.rejections.too_fast + '，guideText=' + h0Guide);

  await page.evaluate(() => { window.__counter.guide = true; });
  const h1 = await runFrames(page, repsFrames(shakeOpts));
  const h1spoken = await page.evaluate(() => window.__counter.spoken);
  const h1blocked = await page.evaluate(() => window.__counter.spokenBlocked);
  const h1texts = h1spoken.map((s) => s.text);
  check('★ 打开「语音指导」后，一次都不计数的动作也会念出原因',
    h1.count === 0 && h1.rejections.too_fast > 0 && h1texts.indexOf('太快了，不算') !== -1,
    'count=' + h1.count + '，太慢/太快=' + h1.rejections.too_fast + '，spoken=' + JSON.stringify(h1texts));
  check('念的是原因，不是数字（与「语音播报」在内容上就能分辨）',
    h1spoken.every((s) => s.kind !== 'count' && !/^\d+$/.test(s.text)), JSON.stringify(h1texts));
  check('★ 同一句原因按冷却去重：被拒绝多次也只念一次',
    h1texts.filter((t) => t === '太快了，不算').length === 1 && h1blocked > 0,
    '念了 ' + h1texts.filter((t) => t === '太快了，不算').length + ' 次，被冷却挡下 ' + h1blocked + ' 次');

  const h1log = await page.evaluate(() => window.__counter.guideLogText());
  check('页面留了语音日志（老师事后能复盘到底报了什么）',
    h1log.indexOf('太快了，不算') !== -1, h1log.slice(0, 60));

  // 只开播报：确认原有功能没被改坏
  await page.evaluate(() => { window.__counter.guide = false; window.__counter.voice = true; });
  const h2 = await runFrames(page, repsFrames({
    signalNames: hSqSig, driver: [{ signal: 'kneeAngle' }],
    start: 172, extreme: 85, reps: 10, periodMs: 1400,
  }));
  const h2spoken = await page.evaluate(() => window.__counter.spoken);
  check('只开「语音播报」时，第 5 / 10 次仍照常报数字',
    h2.count === 10 && h2spoken.some((s) => s.text === '5') && h2spoken.some((s) => s.text === '10'),
    'count=' + h2.count + '，spoken=' + JSON.stringify(h2spoken.map((s) => s.text)));

  // 撞车：同一次动作既计上数、又打了规范标记。
  // 让 torsoLean 跟着同一路波形走（值域 85~172，远大于深蹲 guard 要求的 ≤55），
  // 于是每次计数都带一条「下蹲时躯干前倾过大」。
  await page.evaluate(() => { window.__counter.guide = true; });   // voice 仍为 true
  const h3 = await runFrames(page, repsFrames({
    signalNames: hSqSig,
    driver: [{ signal: 'kneeAngle' }, { signal: 'torsoLean' }],
    start: 172, extreme: 85, reps: 10, periodMs: 1400,
  }));
  const h3spoken = await page.evaluate(() => window.__counter.spoken);
  const h3texts = h3spoken.map((s) => s.text);
  check('两个开关同时打开、同一次动作既有计数又有规范标记 → 只出一条声',
    h3.count === 10 && h3texts.indexOf('下蹲时躯干前倾过大') !== -1 &&
    h3texts.indexOf('5') === -1 && h3texts.indexOf('10') === -1,
    'count=' + h3.count + '，spoken=' + JSON.stringify(h3texts));
  check('抢话时指导优先（纠正晚一秒就过期，数字下一轮还会再报）',
    h3spoken.every((s) => s.kind !== 'count'), JSON.stringify(h3spoken.map((s) => s.kind)));

  // 开关状态持久化
  const prefRaw = await page.evaluate(() => window.__counter.voiceStoreRaw());
  check('勾选后写入本地存档', /"guide":true/.test(prefRaw) && /"voice":true/.test(prefRaw), prefRaw);
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__counter && window.__counter.booted === true', null, { timeout: 15000 });
  const pref1 = await page.evaluate(() => ({ voice: window.__counter.voice, guide: window.__counter.guide }));
  check('★ 重新打开页面，勾选状态还在（首次默认关，勾过就记住）',
    pref1.voice === true && pref1.guide === true, 'voice=' + pref1.voice + '，guide=' + pref1.guide);
  await page.evaluate(() => window.__counter.setStubSpeech(true));   // 重新载入后桩要重新装

  // 计时类：段太短
  await page.evaluate(() => window.__counter.setExercise('horse_stance'));
  const hHsSig = await signalsOf(page);
  const hShort = await runFrames(page, holdFrames({
    signalNames: hHsSig, on: { kneeAngle: 100, torsoLean: 8 }, off: { kneeAngle: 170, torsoLean: 2 }, seconds: 1.0,
  }));
  const h4spoken = await page.evaluate(() => window.__counter.spoken);
  check('计时动作：没到最短有效段 → 念「时间太短，不算」',
    hShort.validSessions === 0 && h4spoken.some((s) => s.text === '时间太短，不算'),
    'validSessions=' + hShort.validSessions + '，spoken=' + JSON.stringify(h4spoken.map((s) => s.text)));

  // 计时类：中途姿势散过又抖回来（断 2 次）—— 这是 hold 侧唯一能分辨的不合格特征
  const hBroken = await runFrames(page, holdSegmentsFrames({
    signalNames: hHsSig, on: { kneeAngle: 100, torsoLean: 8 }, off: { kneeAngle: 170, torsoLean: 2 },
    segments: [{ hold: 2000 }, { brk: 200 }, { hold: 1500 }, { brk: 900 }],
  }));
  const h5spoken = await page.evaluate(() => window.__counter.spoken);
  check('计时动作：中途散过（断 ≥2 次）→ 念出是哪条条件没保持住',
    hBroken.validSessions === 1 && h5spoken.some((s) => /没保持住/.test(s.text)),
    'validSessions=' + hBroken.validSessions + '，spoken=' + JSON.stringify(h5spoken.map((s) => s.text)));

  // 计时类：正常结束（只断 1 次）不该被念 —— 分不清「主动站起来」与「散了」时就不猜
  const hNormal = await runFrames(page, holdFrames({
    signalNames: hHsSig, on: { kneeAngle: 100, torsoLean: 8 }, off: { kneeAngle: 170, torsoLean: 2 }, seconds: 5,
  }));
  const h6spoken = await page.evaluate(() => window.__counter.spoken);
  check('计时动作：正常完成一段 → 不念原因（正常结束与散掉在数据上分不清，就不猜）',
    hNormal.validSessions === 1 && !h6spoken.some((s) => /没保持住|时间太短/.test(s.text)),
    'validSessions=' + hNormal.validSessions + '，spoken=' + JSON.stringify(h6spoken.map((s) => s.text)));

  // 关掉指导后，计时类的不合格也不再念原因（沿用同一动作，默认最短有效段 1.5s）
  await page.evaluate(() => { window.__counter.guide = false; });
  const h7 = await runFrames(page, holdFrames({
    signalNames: hHsSig, on: { kneeAngle: 100, torsoLean: 8 }, off: { kneeAngle: 170, torsoLean: 2 }, seconds: 1.0,
  }));
  const h7spoken = await page.evaluate(() => window.__counter.spoken);
  check('关掉「语音指导」后，计时类的不合格也不再出声',
    h7.validSessions === 0 && h7spoken.length === 0,
    'validSessions=' + h7.validSessions + '，spoken=' + JSON.stringify(h7spoken.map((s) => s.text)));

  /* ---------------- G. 首页入口 ---------------- */

  console.log('\n[G] 首页入口');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const links = await page.$$eval('a.card', (as) => as.map((a) => a.getAttribute('href')));
  check('首页已挂上计数页入口', links.indexOf('v1-counter.html') !== -1, links.join(' | '));
  for (const href of links) {
    const r = await page.goto(BASE + '/' + href, { waitUntil: 'domcontentloaded' });
    check('入口可达：' + href, r && r.status() === 200, r ? 'HTTP ' + r.status() : '无响应');
  }

  /* ---------------- 汇总 ---------------- */

  // 先出报告，再关浏览器。
  // 顺序是有讲究的：页面一多（本脚本会加载 4 次计数页），browser.close() 偶尔会卡住，
  // 放在它后面等于让汇报内容跟着一起被吞掉 —— 跑了一分多钟却看不到结论。
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(64));
  console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  if (failed.length) {
    console.log('\n未通过：');
    for (const f of failed) console.log('  - ' + f.name + '  :: ' + f.detail);
  }
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 4000))]);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('自检异常中断：' + e.message);
  process.exit(2);
});
