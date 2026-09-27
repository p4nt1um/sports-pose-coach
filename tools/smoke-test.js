'use strict';

/**
 * tools/smoke-test.js — M1 自检
 *
 * 用 Chromium 的合成摄像头（--use-fake-device-for-media-stream）跑一遍完整链路：
 * WASM 加载 → 模型加载 → 摄像头开启 → 推理循环。
 *
 * 合成画面里没有人，所以关键点必然为空 —— 这恰好也验证了「无人时不崩溃」。
 * 真实关键点质量需由使用者在真摄像头前验收。
 *
 * 用法： node tools/smoke-test.js [--port 4399] [--shot out.png]
 */

const path = require('path');
const { launch } = require('./pw.js');

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx !== -1 ? argv[portIdx + 1] : '4399';
const shotIdx = argv.indexOf('--shot');
const SHOT = shotIdx !== -1 ? argv[shotIdx + 1] : null;

const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -> ' + detail : ''));
}

(async () => {
  console.log('== M1 自检 @ ' + BASE + '\n');
  const browser = await launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({
    permissions: ['camera'],
    viewport: { width: 1440, height: 980 },
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const allRequests = [];
  const badMime = [];
  const httpErrors = [];

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('requestfailed', (r) => failedRequests.push(r.url() + ' :: ' + ((r.failure() && r.failure().errorText) || '')));
  page.on('request', (r) => allRequests.push(r.url()));
  page.on('response', async (r) => {
    const u = r.url();
    if (r.status() >= 400) httpErrors.push(r.status() + ' ' + u);
    if (/\.(wasm|mjs|task)$/.test(u)) {
      const ct = (r.headers()['content-type'] || '').split(';')[0].trim();
      const want = u.endsWith('.wasm') ? 'application/wasm'
        : u.endsWith('.mjs') ? 'text/javascript' : 'application/octet-stream';
      if (ct !== want) badMime.push(u.split('/').pop() + ' -> ' + ct + ' (期望 ' + want + ')');
    }
  });

  try {
    const resp = await page.goto(BASE + '/m1-engine-check.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    check('页面可访问', resp && resp.status() === 200, 'HTTP ' + (resp && resp.status()));

    await page.waitForTimeout(600);
    check('模块脚本已执行', await page.evaluate(() => !!window.__tpc), typeof await page.evaluate(() => typeof window.__tpc));

    console.log('\n-- 启动摄像头并加载引擎 --');
    await page.click('#btnStart');
    await page.waitForFunction(
      () => window.__tpc && window.__tpc.engine && ['ready', 'running', 'error'].includes(window.__tpc.engine.state),
      { timeout: 90000 }
    );

    const st = await page.evaluate(() => ({
      state: window.__tpc.engine.state,
      delegate: window.__tpc.engine.delegateInUse,
      err: window.__tpc.engine.stats.lastError,
    }));
    check('引擎加载完成', st.state === 'ready' || st.state === 'running', 'state=' + st.state + ' delegate=' + st.delegate);
    if (st.err) console.log('        lastError: ' + st.err);

    await page.waitForTimeout(9000);

    const perf = await page.evaluate(() => {
      const e = window.__tpc.engine;
      return {
        running: window.__tpc.running,
        frames: e.stats.totalFrames,
        fps: e.stats.fps.mean,
        infMean: e.stats.inferenceMs.mean,
        infP95: e.stats.inferenceMs.p95,
        errCount: e.stats.errorCount,
        poseCount: e.stats.poseCount,
        visCount: document.getElementById('kVisCount').textContent,
        stageHidden: document.getElementById('stageHint').style.display === 'none',
      };
    });

    check('推理循环在跑', perf.frames > 5, '累计 ' + perf.frames + ' 帧');
    check('推理耗时合理', perf.infMean > 0 && perf.infMean < 400,
      '均值 ' + perf.infMean.toFixed(1) + 'ms / P95 ' + perf.infP95.toFixed(1) + 'ms');
    check('无运行时异常', perf.errCount === 0, String(perf.errCount));
    check('合成画面下无人不崩溃', perf.poseCount === 0, '检出 ' + perf.poseCount + ' 人');

    const externals = allRequests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'));
    check('零外部请求（全离线）', externals.length === 0, externals.length ? externals.join(', ') : '0 个');
    check('关键资源 MIME 正确', badMime.length === 0, badMime.length ? badMime.join(' | ') : 'wasm/mjs/task 均正确');
    check('无资源加载失败', failedRequests.length === 0, failedRequests.length ? failedRequests.join(' | ') : '0 个');
    check('无 4xx/5xx 响应', httpErrors.length === 0, httpErrors.length ? httpErrors.join(' | ') : '0 个');
    check('无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');
    check('无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || '0 条');

    const loaded = allRequests.filter((u) => /pose_landmarker_(lite|full)\.task/.test(u)).map((u) => u.split('/').pop());
    check('模型文件已加载', loaded.length > 0, loaded.join(', '));

    if (SHOT) {
      await page.screenshot({ path: SHOT, fullPage: false });
      console.log('\n  截图已保存: ' + SHOT);
    }
  } catch (err) {
    check('测试执行完成', false, err.message);
  }

  // 先出报告再关浏览器：页面一多 browser.close() 偶尔会挂住，
  // 放在它后面等于让结论跟着一起被吞掉 —— 跑了一分钟却看不到通过数。
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(58));
  console.log('  结果: ' + (results.length - failed.length) + ' / ' + results.length + ' 通过');
  if (failed.length) {
    console.log('  失败项:');
    for (const f of failed) console.log('    - ' + f.name + '  -> ' + f.detail);
  }
  console.log('='.repeat(58));

  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 4000))]);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('致命错误: ' + e.stack);
  process.exit(1);
});
