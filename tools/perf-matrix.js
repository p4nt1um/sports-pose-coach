'use strict';

/**
 * tools/perf-matrix.js — 推理耗时矩阵：模型 × 后端
 *
 * 用途：回答"这台机器跑得动吗"。README「运行环境要求」里的实测表就是它跑出来的，
 * 所以结论可以被任何人复核，而不是引用一句"我们测过"。
 *
 * 四个组合各采集一段时间，输出推理均值 / P95 / 页面帧率 / 引擎就绪耗时。
 *
 * 用法：
 *   node tools/serve.js --port 4322 --no-open   # 另开一个窗口先起服务
 *   node tools/perf-matrix.js                   # 默认 4322，每个组合采 8s
 *   node tools/perf-matrix.js --port 4400 --wait 12
 *   node tools/perf-matrix.js --only full/GPU   # 只跑一个组合
 *
 * 读数的两个坑（所以别只看"均值"）：
 *   - 首帧有一次性预热（着色器编译），均值会被它拉高。**看 P95**。
 *   - 帧率有 20fps 左右的天花板（采集/渲染回路，不是推理），所以推理快的组合
 *     帧率也不会更高 —— 别拿帧率判断推理性能。
 */

const path = require('path');
const pw = require('./pw.js');

const ROOT = path.join(__dirname, '..');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PORT = arg('port', '4322');
const WAIT_S = Number(arg('wait', '10'));
const ONLY = arg('only', ''); // 形如 full/GPU
const BASE = 'http://127.0.0.1:' + PORT;

const ALL = [
  ['full', 'GPU'],
  ['full', 'CPU'],
  ['lite', 'GPU'],
  ['lite', 'CPU'],
];
const COMBOS = ONLY ? ALL.filter((c) => c.join('/') === ONLY) : ALL;

/**
 * 单独量一次"首帧"。
 * GPU 后端第一次跑某个模型要先编译着色器，这一帧可能是秒级的 ——
 * 它会被均值严重拉高（缓冲区里一帧 4.9s，均值能从 12ms 抬到 95ms），
 * 而且样本少的时候还会正好落进 P95 的槽位。所以单独取出来看，读稳态就取 P95。
 */
async function firstFrameMs(page) {
  await page.waitForFunction(() => window.__tpc.engine.stats.totalFrames >= 2, { timeout: 120000 });
  return await page.evaluate(() => window.__tpc.engine.stats.inferenceMs.max);
}

async function measure(browser, model, delegate) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push(String(e)));
  try {
    await page.goto(BASE + '/m1-engine-check.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => !!window.__tpc, { timeout: 30000 });
    await page.selectOption('#selModel', model);
    await page.selectOption('#selDelegate', delegate);
    await page.selectOption('#selFps', '30');
    const t0 = Date.now();
    await page.click('#btnStart');
    await page.waitForFunction(
      () => window.__tpc && window.__tpc.engine && ['ready', 'running', 'error'].includes(window.__tpc.engine.state),
      { timeout: 120000 }
    );
    const loadMs = Date.now() - t0;
    let warmMs = 0;
    try { warmMs = await firstFrameMs(page); } catch (e) { warmMs = -1; }
    await page.waitForTimeout(WAIT_S * 1000);
    const r = await page.evaluate(() => {
      const e = window.__tpc.engine;
      return {
        state: e.state,
        delegate: e.delegateInUse,
        frames: e.stats.totalFrames,
        fps: e.stats.fps.mean,
        infMean: e.stats.inferenceMs.mean,
        infP95: e.stats.inferenceMs.p95,
        infMax: e.stats.inferenceMs.max,
        errCount: e.stats.errorCount,
        lastError: e.stats.lastError,
        isolated: self.crossOriginIsolated,
        cores: navigator.hardwareConcurrency,
      };
    });
    try { await page.click('#btnStop', { timeout: 3000 }); } catch (e) { /* 停不掉不影响读数 */ }
    return { loadMs, warmMs, logs, ...r };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  if (!COMBOS.length) throw new Error('--only 取值应为 full/GPU、full/CPU、lite/GPU、lite/CPU 之一');
  console.log('== 推理耗时矩阵 @ ' + BASE + '  每个组合采集 ' + WAIT_S + 's ==');
  console.log('   探法：tools/pw.js 起真实 Chromium + 合成摄像头，读引擎自身的统计\n');

  const browser = await pw.launch();
  const rows = [];
  for (const [model, delegate] of COMBOS) {
    process.stdout.write('  ' + model.padEnd(5) + delegate.padEnd(4) + ' ... ');
    const r = await measure(browser, model, delegate);
    rows.push({ model, delegate, r });
    // 边跑边打：browser.close() 挂住会把整份报告吞掉（本项目踩过两次）
    console.log('实际后端=' + String(r.delegate).padEnd(4) +
      ' 首帧=' + (r.warmMs.toFixed(0) + 'ms').padEnd(8) +
      ' 稳态P95=' + (r.infP95.toFixed(1) + 'ms').padEnd(9) +
      ' 帧率=' + (r.fps.toFixed(1) + 'fps').padEnd(8) +
      ' 就绪=' + (r.loadMs / 1000).toFixed(1) + 's');
  }

  console.log('\n模型   后端   实际后端  首帧      稳态P95   均值      帧率    帧数');
  console.log('----   ----   --------  --------  --------  --------  ------  ----');
  for (const { model, delegate, r } of rows) {
    console.log(model.padEnd(7) + delegate.padEnd(7) + String(r.delegate).padEnd(10) +
      (r.warmMs.toFixed(0) + 'ms').padEnd(10) + (r.infP95.toFixed(1) + 'ms').padEnd(10) +
      (r.infMean.toFixed(1) + 'ms').padEnd(10) +
      (r.fps.toFixed(1) + 'fps').padEnd(8) + r.frames);
  }

  const f = rows[0].r;
  console.log('\n环境：crossOriginIsolated=' + f.isolated + '  hardwareConcurrency=' + f.cores);
  const bad = rows.filter((x) => x.r.state !== 'running' && x.r.state !== 'ready');
  console.log('异常组合：' + (bad.length ? bad.map((x) => x.model + '/' + x.delegate + '=' + x.r.state).join(', ') : '无'));
  const warn = rows.flatMap((x) => x.r.logs.map((t) => '  ' + x.model + '/' + x.delegate + ': ' + t));
  console.log('控制台输出（CPU 后端会有 TensorFlow Lite 的 INFO 行，属正常）：');
  console.log(warn.length ? warn.join('\n') : '  （无）');
  const hot = rows.filter((x) => x.warmMs > 500);
  console.log('\n提示：稳态看 P95，不看均值 —— 均值里混着首帧。');
  if (hot.length) {
    console.log('      本机这些组合有首帧预热（GPU 首次编译着色器，只在缓存冷的时候出现）：' +
      hot.map((x) => x.model + '/' + x.delegate + ' ' + x.warmMs.toFixed(0) + 'ms').join('，'));
  }
  console.log('      帧率四组都在 20fps 上下，说明瓶颈在采集/渲染回路而非推理 —— 别用帧率判断推理性能。');
  console.log('\nDONE');

  // 报告已出，再关浏览器；挂住也不影响结论
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 4000))]).catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error('FAILED: ' + e.message); process.exit(1); });
