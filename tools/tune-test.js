'use strict';

/**
 * tools/tune-test.js — 参数调试台自检
 *
 * 分四段验证，覆盖四种不同性质的风险：
 *
 *  A. 模拟信号段（确定性）：把合成波形喂进页面里的真实链路
 *     SignalSet → PhaseFsm → 计数显示 → 曲线绘制 → 导出 JSON。
 *     node 单测已经验证过状态机本身，这里验证的是**浏览器里接线是否正确**。
 *     关键一条：改阈值后按**已缓存的信号**重算，计数立刻变化 —— 这是
 *     调试台的核心承诺（老师不必重做动作）。
 *
 *  B. 摄像头段（真实管线）：合成摄像头 + GPU 推理跑起来，
 *     断言不崩溃、0 外部请求、且**没有人时不产生任何计数**。
 *
 *  C. 参数存档段：调参 → **刷新页面 → 参数还在**（老师最关心的那条），
 *     以及恢复默认要清存档、损坏存档不能让页面打不开、导入要覆盖而非叠加、
 *     文件默认值变更时要报冲突而不能静默覆盖。
 *
 *  D. 首页入口段：一键启动后打开的那一页，入口链接不能是死链。
 *
 * 用法： node tools/tune-test.js [--port 4400] [--shot out.png]
 */

const path = require('path');
const { launch } = require('./pw.js');

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx !== -1 ? argv[portIdx + 1] : '4400';
const shotIdx = argv.indexOf('--shot');
const SHOT = shotIdx !== -1 ? argv[shotIdx + 1] : null;
const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -> ' + detail : ''));
}

(async () => {
  console.log('== 参数调试台自检 @ ' + BASE + '\n');

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

  // ---- 起点必须是干净的 ----
  // 参数存档会留存在 localStorage 里，上一次自检的调整会污染这一次。
  // 先借同源的首页清掉，否则"首次打开应与文件一致"这类断言毫无意义。
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      Object.keys(localStorage)
        .filter((k) => k.indexOf('spc.tuned.') === 0)
        .forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* 存储不可用时忽略；降级行为另有断言覆盖 */ }
  });

  const res = await page.goto(BASE + '/tools/tune.html', { waitUntil: 'domcontentloaded' });
  check('调试台可访问', res && res.status() === 200, res ? 'HTTP ' + res.status() : '无响应');

  await page.waitForFunction('window.__tune && window.__tune.booted === true', null, { timeout: 15000 });
  check('页面初始化完成（配置已从 JSON 载入）', true, '');

  const initial = await page.evaluate(() => ({
    primary: window.__tune.cfg.primary,
    cycle: window.__tune.cfg.fsm.cycle,
    standGte: window.__tune.cfg.fsm.phases.stand.enter.gte,
    bottomLte: window.__tune.cfg.fsm.phases.bottom.enter.lte,
    diff: window.__tune.diffCount(),
    saved: window.__tune.savedCount,
    degraded: window.__tune.storeDegraded,
  }));
  check('读到的配置与文件一致', initial.primary === 'kneeAngle' && initial.standGte > 0 && initial.bottomLte > 0,
    JSON.stringify(initial));
  check('首次打开（无存档）与文件无差异', initial.diff === 0, 'diff=' + initial.diff);
  check('本地存储可用，不会是降级模式', initial.degraded === false, 'degraded=' + initial.degraded);

  /* ---------------- A. 模拟信号段 ---------------- */

  console.log('\n[A] 模拟信号：页面内真实链路（信号层 → 状态机 → UI）');

  const sim30 = await page.evaluate(() => window.__tune.simRun({ reps: 30, periodMs: 2000 }));
  check('标准深蹲 30 次 → 计数 30', sim30.count === 30,
    'count=' + sim30.count + '，帧数=' + sim30.frames + '，拒绝=' + JSON.stringify(sim30.rejections));

  const domCount = await page.textContent('#hudCount');
  check('计数同步到界面', domCount.trim() === '30', '#hudCount="' + domCount.trim() + '"');

  const simHalf = await page.evaluate(() => window.__tune.simRun({ reps: 30, periodMs: 2000, bottom: 132 }));
  check('半蹲 30 次（只到 132°）→ 计数 0', simHalf.count === 0, 'count=' + simHalf.count);

  const simFast = await page.evaluate(() => window.__tune.simRun({ reps: 40, periodMs: 250 }));
  check('过快抖动 40 次 → 计数 0 且记入 too_fast', simFast.count === 0 && simFast.rejections.too_fast > 0,
    'count=' + simFast.count + '，too_fast=' + simFast.rejections.too_fast);

  const simStatic = await page.evaluate(() => window.__tune.simRun({ reps: 0, periodMs: 2000 }));
  check('静止不动 2 秒 → 计数 0', simStatic.count === 0, 'count=' + simStatic.count);

  // 核心承诺：改阈值不用重做动作，按缓存重算
  console.log('\n[A2] 核心承诺：改阈值 → 按已缓存信号重算，不必重做动作');
  const shallow = await page.evaluate(() => window.__tune.simRun({ reps: 30, periodMs: 2000, bottom: 110 }));
  check('深度 110° 的 30 次，在默认阈值 100° 下 → 0（判定为蹲得不到位）',
    shallow.count === 0, 'count=' + shallow.count);

  const framesBefore = await page.evaluate(() => window.__tune.frames);
  const after = await page.evaluate(() => {
    window.__tune.setParam('fsm.phases.bottom.enter.lte', 120);
    return { count: window.__tune.count, diff: window.__tune.diffCount(), frames: window.__tune.frames };
  });
  check('把下蹲阈值放宽到 120° 后，同一段缓存 → 立刻变成 30',
    after.count === 30, 'count=' + after.count + '（缓存未变化：' + framesBefore + ' → ' + after.frames + ' 帧）');
  check('缓存被复用而非重录', after.frames === framesBefore, framesBefore + ' vs ' + after.frames);
  check('导出 diff 能反映改动', after.diff === 1, 'diff=' + after.diff);

  const domAfter = await page.textContent('#hudCount');
  check('界面计数同步更新', domAfter.trim() === '30', '#hudCount="' + domAfter.trim() + '"');

  const jsonOut = await page.evaluate(() => JSON.parse(window.__tune.exportJson()));
  check('导出的 JSON 带上了改后的阈值', jsonOut.fsm.phases.bottom.enter.lte === 120,
    'lte=' + jsonOut.fsm.phases.bottom.enter.lte);
  check('导出的 JSON 结构完整', !!(jsonOut.id && jsonOut.signals && jsonOut.fsm && jsonOut.fsm.cycle.length === 2),
    Object.keys(jsonOut).join(','));

  const restored = await page.evaluate(() => ({ count: window.__tune.count, frames: window.__tune.frames }));

  // 曲线确实画了东西（此时缓存里还有 30 次深蹲的波形）
  const chartInk = await page.evaluate(() => {
    const c = document.getElementById('chart');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return { ink: n, w: c.width, h: c.height };
  });
  check('曲线已绘制（画布非空白）', chartInk.ink > 2000,
    '非透明像素 ' + chartInk.ink + ' @ ' + chartInk.w + 'x' + chartInk.h);

  // 时间窗 / Y 轴切换不应报错
  await page.selectOption('#selWindow', '30000');
  await page.selectOption('#selYRange', 'fixed');
  await page.waitForTimeout(200);
  check('切换时间窗与 Y 轴范围不报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '0 条');

  const resetRes = await page.evaluate(() => {
    const c = window.__tune.reset();
    return { c, frames: window.__tune.frames };
  });
  check('重置计数 → 清空缓存与计数（新会话）', resetRes.c === 0 && resetRes.frames === 0,
    'count=' + resetRes.c + '，缓存=' + resetRes.frames + ' 帧');
  const keepParam = await page.evaluate(() => window.__tune.getParam('fsm.phases.bottom.enter.lte'));
  check('重置不影响已调好的参数', keepParam === 120, 'lte=' + keepParam);

  const emptyInk = await page.evaluate(() => {
    const c = document.getElementById('chart');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  check('清空后曲线回到空状态（不再残留旧波形）', emptyInk < 1500,
    '非透明像素 ' + emptyInk + '（此前 ' + chartInk.ink + '）');

  /* ---------------- B. 摄像头段 ---------------- */

  console.log('\n[B] 摄像头：合成画面 + GPU 推理，真实管线');
  await page.evaluate(() => window.__tune.setSource('camera'));
  const afterSwitch = await page.evaluate(() => ({ count: window.__tune.count, frames: window.__tune.frames }));
  check('切换输入源会清空上一会话（模拟信号的计数不会带过来）',
    afterSwitch.count === 0 && afterSwitch.frames === 0,
    'count=' + afterSwitch.count + '，缓存=' + afterSwitch.frames + ' 帧');

  await page.click('#btnStart');

  let engineOk = false;
  try {
    await page.waitForFunction(
      'window.__tune.engineState === "running" && window.__tune.frames > 60',
      null, { timeout: 60000 }
    );
    engineOk = true;
  } catch (e) { /* 下面断言里报 */ }

  const cam = await page.evaluate(() => ({
    state: window.__tune.engineState,
    delegate: window.__tune.delegate,
    frames: window.__tune.frames,
    count: window.__tune.count,
    rejections: window.__tune.rejections,
  }));
  check('摄像头模式下推理循环跑起来', engineOk,
    'state=' + cam.state + '，delegate=' + cam.delegate + '，缓存 ' + cam.frames + ' 帧');
  check('后端为 GPU（回落也不报错）', cam.delegate === 'GPU' || cam.delegate === 'CPU', String(cam.delegate));
  check('合成画面（无人）不产生任何计数', cam.count === 0,
    'count=' + cam.count + '，拒绝=' + JSON.stringify(cam.rejections));

  if (SHOT) {
    await page.screenshot({ path: SHOT, fullPage: false });
    console.log('\n  截图已保存：' + SHOT);
  }

  console.log('\n[B2] 全局');
  // ★ 必须「先停引擎再查外部请求」。
  // MediaPipe 内置的使用统计上报器每 60 秒才 flush 一次，而 close() 会强制 flush ——
  // 只在运行中的几秒钟内查，是查不到它的（这正是一次漏检的成因）。
  await page.click('#btnStop');
  await page.waitForTimeout(500);

  const guard = await page.evaluate(() => ({
    installed: !!window.__offlineGuard,
    count: window.__offlineGuard ? window.__offlineGuard.count : 0,
    hosts: window.__offlineGuard ? window.__offlineGuard.hosts : [],
    last: window.__offlineGuard ? window.__offlineGuard.last() : null,
  }));
  check('页面上装了离线护栏', guard.installed, '');
  check('★ 停止引擎时 MediaPipe 的境外遥测上报被拦下（否则「完全离线」不成立）',
    guard.count > 0 && guard.hosts.some((h) => /pa\.googleapis\.com/.test(h)),
    guard.count + ' 次，主机：' + guard.hosts.join(', ') + '，最近通过 ' + (guard.last ? guard.last.how : '?'));

  check('零外部请求（完全离线）', externalRequests.length === 0,
    externalRequests.length ? externalRequests.slice(0, 3).join(' | ') : '0 个');
  check('无资源加载失败', failedRequests.length === 0,
    failedRequests.length ? failedRequests.slice(0, 3).join(' | ') : '0 个');
  check('无控制台错误', consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || '0 条');
  check('无未捕获异常', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | ') || '0 条');

  /* ---------------- C. 参数存档 ---------------- */

  console.log('\n[C] 参数存档：老师调好的参数，下次进入自动载入');

  await page.evaluate(() => window.__tune.clearSaved());
  const cleanState = await page.evaluate(() => ({
    count: window.__tune.savedCount,
    cls: window.__tune.storeBarClass,
    text: window.__tune.storeBarText,
  }));
  check('无存档时状态条说明「与文件默认值一致」',
    cleanState.count === 0 && /与文件默认值一致/.test(cleanState.text),
    cleanState.text || '(空)');

  // 调 2 项参数 → 应当自动保存
  const saved = await page.evaluate(() => {
    window.__tune.setParam('fsm.phases.stand.enter.gte', 152);
    window.__tune.setParam('fsm.phases.bottom.enter.lte', 118);
    return window.__tune.saveNow();
  });
  check('调 2 项后自动保存到本地', saved.ok && saved.count === 2,
    '存档项数=' + saved.count + '，cleared=' + saved.cleared);

  let rawRec = null;
  try { rawRec = JSON.parse(await page.evaluate(() => window.__tune.storeRaw)); } catch (e) { /* 下面断言报 */ }
  check('确认真的落盘（而非只存在内存变量）',
    !!rawRec && !!rawRec.patch && rawRec.patch['fsm.phases.stand.enter.gte'] === 152 &&
      rawRec.patch['fsm.phases.bottom.enter.lte'] === 118,
    rawRec ? Object.keys(rawRec.patch).length + ' 项，保存于 ' + rawRec.savedAtText : '读不到');

  // ---- 核心断言：刷新页面，参数必须还在 ----
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__tune && window.__tune.booted === true', null, { timeout: 15000 });
  const afterReload = await page.evaluate(() => ({
    stand: window.__tune.getParam('fsm.phases.stand.enter.gte'),
    bottom: window.__tune.getParam('fsm.phases.bottom.enter.lte'),
    minRep: window.__tune.getParam('fsm.minRepMs'),
    savedCount: window.__tune.savedCount,
    text: window.__tune.storeBarText,
    fileStand: window.__tune.fileDefaults.fsm.phases.stand.enter.gte,
  }));
  check('★ 刷新后自动载入上次调好的参数',
    afterReload.stand === 152 && afterReload.bottom === 118,
    '站立=' + afterReload.stand + '（文件默认 ' + afterReload.fileStand + '），下蹲=' + afterReload.bottom);
  check('未改动的项仍跟随文件默认值（这就是存差异而非全量的意义）',
    afterReload.minRep === 400, 'minRepMs=' + afterReload.minRep);
  check('状态条显示已保存的调整项', /已保存 2 项调整/.test(afterReload.text), afterReload.text);

  // ---- 恢复默认：参数回默认，存档也要清掉 ----
  await page.click('#btnDefaults');
  await page.waitForTimeout(200);
  const afterDefaults = await page.evaluate(() => ({
    stand: window.__tune.getParam('fsm.phases.stand.enter.gte'),
    bottom: window.__tune.getParam('fsm.phases.bottom.enter.lte'),
    savedCount: window.__tune.savedCount,
    raw: window.__tune.storeRaw,
    text: window.__tune.storeBarText,
  }));
  check('点「恢复默认」→ 参数回到文件默认值',
    afterDefaults.stand === 158 && afterDefaults.bottom === 100,
    '站立=' + afterDefaults.stand + '，下蹲=' + afterDefaults.bottom);
  check('同时清空存档（不会"恢复了默认却还存着旧调整"）',
    afterDefaults.savedCount === 0 && afterDefaults.raw === null,
    '存档=' + afterDefaults.savedCount + ' 项');

  // ---- 损坏的存档不能让页面打不开 ----
  await page.evaluate(() => { try { localStorage.setItem('spc.tuned.squat', '{ 这不是 JSON'); } catch (e) { /* 忽略 */ } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  let bootFailed = false;
  try {
    await page.waitForFunction('window.__tune && window.__tune.booted === true', null, { timeout: 15000 });
  } catch (e) { bootFailed = true; }
  const broken = await page.evaluate(() => ({
    stand: window.__tune.getParam('fsm.phases.stand.enter.gte'),
    savedCount: window.__tune.savedCount,
  }));
  check('损坏的存档：页面照常启动，回落到文件默认值',
    !bootFailed && broken.stand === 158 && broken.savedCount === 0,
    bootFailed ? '页面没能启动' : '站立=' + broken.stand + '，存档=' + broken.savedCount + ' 项');
  await page.evaluate(() => { try { localStorage.removeItem('spc.tuned.squat'); } catch (e) { /* 忽略 */ } });

  // ---- 载入存档文件（换电脑 / 同事之间传参数） ----
  const importPayload = JSON.stringify({
    v: 1, id: 'squat', savedAt: 1758400000000, savedAtText: '09-21 09:00',
    patch: { 'fsm.phases.bottom.enter.lte': 124, 'fsm.minRepMs': 550 },
    baseline: { 'fsm.phases.bottom.enter.lte': 100, 'fsm.minRepMs': 400 },
  });
  await page.setInputFiles('#loadFileInput', {
    name: 'squat.tuned.json', mimeType: 'application/json', buffer: Buffer.from(importPayload),
  });
  await page.waitForTimeout(500);
  const imported = await page.evaluate(() => ({
    bottom: window.__tune.getParam('fsm.phases.bottom.enter.lte'),
    stand: window.__tune.getParam('fsm.phases.stand.enter.gte'),
    minRep: window.__tune.getParam('fsm.minRepMs'),
    savedCount: window.__tune.savedCount,
    cls: window.__tune.storeBarClass,
  }));
  check('载入存档文件 → 参数立即生效', imported.bottom === 124 && imported.minRep === 550,
    '下蹲=' + imported.bottom + '，minRepMs=' + imported.minRep);
  check('载入即落盘（此后刷新仍然在）', imported.savedCount === 2, '存档=' + imported.savedCount + ' 项');
  check('载入是覆盖而非叠加（上一份的改动不留残迹）', imported.stand === 158, '站立=' + imported.stand);
  check('baseline 与文件一致时不误报冲突', imported.cls.indexOf('warn') === -1, 'class="' + imported.cls + '"');

  // ---- 文件默认值后来变过：要提示，但不能静默改用文件的值 ----
  const stalePayload = JSON.stringify({
    v: 1, id: 'squat', savedAtText: '09-01 08:00',
    patch: { 'fsm.phases.stand.enter.gte': 150 },
    baseline: { 'fsm.phases.stand.enter.gte': 999 },
  });
  await page.setInputFiles('#loadFileInput', {
    name: 'squat.stale.json', mimeType: 'application/json', buffer: Buffer.from(stalePayload),
  });
  await page.waitForTimeout(500);
  const conflicted = await page.evaluate(() => ({
    stand: window.__tune.getParam('fsm.phases.stand.enter.gte'),
    cls: window.__tune.storeBarClass,
    text: window.__tune.storeBarText,
    conflicts: ((window.__tune.loadReport && window.__tune.loadReport.conflicts) || []).length,
  }));
  check('检出冲突：文件默认值与存档记录的不一致', conflicted.conflicts === 1, 'conflicts=' + conflicted.conflicts);
  check('冲突时仍采用老师调的值（不静默覆盖）', conflicted.stand === 150, '站立=' + conflicted.stand);
  check('冲突在界面上一眼可见',
    conflicted.cls.indexOf('warn') !== -1 && /默认值后来被改过/.test(conflicted.text),
    conflicted.text.slice(0, 70));

  // 收尾：留一份干净的存档（截图里能看到状态条的真实样子）
  await page.setInputFiles('#loadFileInput', {
    name: 'squat.tuned.json', mimeType: 'application/json', buffer: Buffer.from(importPayload),
  });
  await page.waitForTimeout(500);
  const finalState = await page.evaluate(() => ({
    savedCount: window.__tune.savedCount,
    cls: window.__tune.storeBarClass,
  }));
  check('多次载入与冲突之后仍能回到正常状态',
    finalState.savedCount === 2 && finalState.cls.indexOf('warn') === -1,
    '存档=' + finalState.savedCount + ' 项，class="' + finalState.cls + '"');

  /* ---------------- E. 多动作 ---------------- */

  console.log('\n[E] 多动作：一份 JSON 驱动 7 个动作，页面代码不分支');

  const exList = await page.evaluate(() => window.__tune.exercises);
  check('调试台列出全部 7 个动作（动作选择器不再写死深蹲）',
    exList.length === 7, exList.map((e) => e.id).join(', '));
  check('区分计数与计时两类',
    exList.filter((e) => e.category === 'reps').length === 5 &&
      exList.filter((e) => e.category === 'hold').length === 2,
    exList.map((e) => e.name + '(' + e.category + ')').join(' '));

  // 先清空全部存档，免得上一个动作的调整串进下一个（各动作各存各的，但都同源）
  await page.evaluate(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    keys.filter((k) => k.indexOf('spc.tuned.') === 0).forEach((k) => localStorage.removeItem(k));
  });

  // 逐个动作切一遍：切得动、有滑块、建得出追踪器、模拟能跑
  const perEx = [];
  for (const ex of exList) {
    const r = await page.evaluate(async (id) => {
      await window.__tune.setExercise(id);
      window.__tune.setSource('sim');
      const isHold = window.__tune.mode === 'hold';
      const sim = window.__tune.simRun(isHold ? { reps: 3 } : { reps: 10, periodMs: 2000 });
      return {
        id: window.__tune.exerciseId,
        mode: window.__tune.mode,
        paths: window.__tune.paramPaths(),
        sim,
        savedCount: window.__tune.savedCount,
        barText: window.__tune.storeBarText,
        name: window.__tune.exerciseName,
      };
    }, ex.id);
    perEx.push(r);
  }

  check('切到每个动作后 id 都对得上',
    perEx.every((r, i) => r.id === exList[i].id), perEx.map((r) => r.id).join(', '));
  check('每个动作都生成了参数滑块（没有哪个动作是「空面板」）',
    perEx.every((r) => r.paths.length >= 5),
    perEx.map((r) => r.name + ' ' + r.paths.length + ' 项').join('，'));
  check('计数动作的滑块指的是 fsm.*，计时动作指的是 hold.*',
    perEx.filter((r) => r.mode === 'reps').every((r) => r.paths.some((p) => p.indexOf('fsm.') === 0)) &&
      perEx.filter((r) => r.mode === 'hold').every((r) => r.paths.some((p) => p.indexOf('hold.') === 0) &&
        !r.paths.some((p) => p.indexOf('fsm.') === 0)),
    perEx.map((r) => r.name + ':' + r.paths[0]).join(' | '));
  check('每个动作都跑得出模拟读数（无存档时不该出现自定义参数）',
    perEx.every((r) => r.savedCount === 0 && /与文件默认值一致/.test(r.barText)),
    perEx.map((r) => r.name + '=' + r.savedCount).join('，'));
  check('5 个计数动作模拟 10 次都能数出来',
    perEx.filter((r) => r.mode === 'reps').every((r) => r.sim.count === 10),
    perEx.filter((r) => r.mode === 'reps').map((r) => r.name + '=' + r.sim.count).join('，'));
  check('2 个计时动作模拟保持 3 秒都能计时（≈3.0s）',
    perEx.filter((r) => r.mode === 'hold').every((r) => Math.abs(r.sim.liveMs - 3000) <= 200),
    perEx.filter((r) => r.mode === 'hold').map((r) => r.name + '=' + r.sim.liveMs + 'ms').join('，'));

  // ---- 高抬腿：这一页必须按左右腿各出一条波形 ----
  console.log('\n[E2] 多通道：原地高抬腿（左右腿各一条信号、各一个状态机）');
  const hkProbe = await page.evaluate(async () => {
    await window.__tune.setExercise('high_knee');
    return {
      primary: window.__tune.cfg.primary,
      channels: (window.__tune.cfg.channels || []).map((c) => ({ id: c.id, signal: c.signal })),
      boxes: Array.from(document.querySelectorAll('#sigChecks label')).map((l) => ({
        text: l.innerText.replace(/\s+/g, ' ').trim(),
        checked: l.querySelector('input').checked,
      })),
    };
  });
  check('高抬腿配置了两条通道（左腿 / 右腿）',
    hkProbe.channels.length === 2 && hkProbe.channels.map((c) => c.signal).join(',') === 'kneeHeightL,kneeHeightR',
    hkProbe.channels.map((c) => c.id + '→' + c.signal).join(' '));
  check('曲线默认就把两条腿都画出来（只画主信号会看不出漏计）',
    hkProbe.boxes.filter((b) => b.checked && /kneeHeight/.test(b.text)).length === 2,
    hkProbe.boxes.filter((b) => b.checked).map((b) => b.text).join(' | '));
  check('信号旁标出所属通道名',
    hkProbe.boxes.some((b) => /左腿/.test(b.text)) && hkProbe.boxes.some((b) => /右腿/.test(b.text)),
    hkProbe.boxes.map((b) => b.text).join(' | '));

  const hkSim = await page.evaluate(() => window.__tune.simRun({ reps: 20, periodMs: 600 }));
  const hkCh = (hkSim.channels || []).map((c) => c.id + '=' + c.count).join(' ');
  check('模拟左右交替 20 次 → 合计 20', hkSim.count === 20, 'count=' + hkSim.count + '，' + hkCh);
  check('两条通道各 10 次（不是把 20 全记到一条腿上）',
    hkSim.channels && hkSim.channels.length === 2 &&
      hkSim.channels.every((c) => c.count === 10), hkCh);

  const hkHalf = await page.evaluate(() => window.__tune.simRun({ reps: 20, periodMs: 600, amplitude: 30 }));
  check('抬腿幅度只到 30% → 一次都不算（半程闸门有效）', hkHalf.count === 0, 'count=' + hkHalf.count);

  // ---- 计时动作的参数必须能存下来（hold 段曾被漏在展平之外） ----
  console.log('\n[E3] 计时动作的调参也要能存能取');
  const hsParam = await page.evaluate(async () => {
    await window.__tune.setExercise('horse_stance');
    const before = window.__tune.getParam('hold.minHoldMs');
    window.__tune.setParam('hold.minHoldMs', 300);
    const saved = window.__tune.saveNow();
    return { before, saved, raw: window.__tune.storeRaw };
  });
  check('马步调一项后能落盘（hold 子树必须被展平）',
    hsParam.saved.ok && hsParam.saved.count === 1,
    '存档项数=' + hsParam.saved.count + '（调前 minHoldMs=' + hsParam.before + '）');
  check('落盘内容确实是 hold 段的路径',
    !!hsParam.raw && JSON.parse(hsParam.raw).patch['hold.minHoldMs'] === 300,
    hsParam.raw ? Object.keys(JSON.parse(hsParam.raw).patch).join(',') : '读不到');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__tune && window.__tune.booted === true', null, { timeout: 15000 });
  check('刷新后默认回到第一个动作（深蹲），不会记错动作',
    (await page.evaluate(() => window.__tune.exerciseId)) === 'squat', '');

  const hsAfter = await page.evaluate(async () => {
    await window.__tune.setExercise('horse_stance');
    return {
      minHoldMs: window.__tune.getParam('hold.minHoldMs'),
      savedCount: window.__tune.savedCount,
      barText: window.__tune.storeBarText,
    };
  });
  check('★ 刷新后切回马步，上次调的 hold 参数还在',
    hsAfter.minHoldMs === 300 && hsAfter.savedCount === 1,
    'minHoldMs=' + hsAfter.minHoldMs + '，存档=' + hsAfter.savedCount + ' 项');
  check('状态条明说存了 1 项调整', /已保存 1 项调整/.test(hsAfter.barText), hsAfter.barText.slice(0, 60));

  const wallClean = await page.evaluate(async () => {
    await window.__tune.setExercise('wall_sit');
    return window.__tune.storeBarText;
  });
  check('马步的调整不会串到靠墙静蹲（各动作各存各的）',
    /与文件默认值一致/.test(wallClean), wallClean.slice(0, 50));

  // 收尾：清掉本段留下的存档，把深蹲那份放回去（下面截图看的还是深蹲）
  await page.evaluate((payload) => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    keys.filter((k) => k.indexOf('spc.tuned.') === 0).forEach((k) => localStorage.removeItem(k));
    localStorage.setItem('spc.tuned.squat', payload);
  }, importPayload);
  const backToSquat = await page.evaluate(async () => {
    await window.__tune.setExercise('squat');
    return { id: window.__tune.exerciseId, savedCount: window.__tune.savedCount };
  });
  check('切回深蹲后载入的是深蹲自己的存档', backToSquat.id === 'squat' && backToSquat.savedCount === 2,
    '存档=' + backToSquat.savedCount + ' 项');

  /* ---------------- D. 首页入口 ---------------- */

  console.log('\n[D] 首页入口（一键启动后打开的就是这一页）');
  const homeRes = await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  check('首页可访问（/ 直接给 index.html）', homeRes && homeRes.status() === 200,
    homeRes ? 'HTTP ' + homeRes.status() : '无响应');
  const links = await page.$$eval('a.card', (as) => as.map((a) => a.getAttribute('href')));
  check('首页列出了三个入口（含上课用的计数页）',
    links.indexOf('v1-counter.html') !== -1 &&
      links.indexOf('m1-engine-check.html') !== -1 && links.indexOf('tools/tune.html') !== -1,
    links.join(' | '));
  for (const href of links) {
    const r = await page.goto(BASE + '/' + href, { waitUntil: 'domcontentloaded' });
    check('入口可达：' + href, r && r.status() === 200, r ? 'HTTP ' + r.status() : '无响应');
  }

  if (SHOT) {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    const homeShot = SHOT.replace(/\.png$/i, '') + '-home.png';
    await page.screenshot({ path: homeShot, fullPage: true });
    console.log('\n  首页截图：' + homeShot);

    // 再给一张"有数据"的界面图：模拟信号跑 12 次，曲线/死区/相位带/计数标记都在
    await page.goto(BASE + '/tools/tune.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__tune && window.__tune.booted === true', null, { timeout: 15000 });
    await page.evaluate(() => { window.__tune.setSource('sim'); window.__tune.simRun({ reps: 12, periodMs: 2000 }); });
    await page.waitForTimeout(400);
    const simShot = SHOT.replace(/\.png$/i, '') + '-sim.png';
    await page.screenshot({ path: simShot, fullPage: false });
    console.log('  模拟信号界面截图：' + simShot);

    // 存档状态条：滚到参数卡，专门拍一张 —— 这是老师最需要看懂的一块
    await page.evaluate(() => {
      const b = document.getElementById('storeBar');
      if (b) b.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(300);
    const storeShot = SHOT.replace(/\.png$/i, '') + '-store.png';
    await page.screenshot({ path: storeShot, fullPage: false });
    console.log('  参数存档状态条截图：' + storeShot);
  }

  // 先出报告再关浏览器：页面一多 browser.close() 偶尔会挂住，
  // 放在它后面等于让结论跟着一起被吞掉。
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
