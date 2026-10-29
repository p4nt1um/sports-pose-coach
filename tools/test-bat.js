/*
 * test-bat.js — 实测 启动.bat 能否真正拉起本地服务
 *
 * 两段，因为"能启动"和"能干净地启动"是两件事：
 *   A. 端口空闲时：bat 起服务、打印地址、页面与 MIME 都对。
 *   B. 故意留一个旧服务在端口上：bat 必须先把它收掉，再在**同一个端口**上起来。
 *      这一段是「清理旧进程」的唯一真凭据 —— 只看代码读不出「serve.js 会不会
 *      悄悄顺延到 4323」，必须看它最后报的是哪个端口。
 *
 * 做法：真的 spawn cmd /c 启动.bat，从控制台输出里解析地址，发 HTTP 确认可用，
 *       最后把整棵进程树杀掉。
 *
 * 用法： node sports-pose-coach/tools/test-bat.js
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(process.cwd(), 'sports-pose-coach');
const BAT = path.join(ROOT, '启动.bat');
const SERVE = path.join(ROOT, 'tools', 'serve.js');
const PORT = '4322';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail === undefined ? '' : String(detail) });
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  :: ' + detail : ''));
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], bytes: n }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个服务，等它真的能响应，返回 child（拿不到就返回 null） */
async function startServer(args) {
  const child = spawn(process.execPath, [SERVE, ...args], { cwd: ROOT, windowsHide: true });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const r = await get('http://127.0.0.1:' + PORT + '/');
    if (r.status === 200) return child;
  }
  return null;
}

function killTree(pid) {
  return new Promise((r) => {
    if (!pid) return r();
    const k = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
    k.on('exit', () => r());
    k.on('error', () => r());
  });
}

/** 跑一次 bat，等到它打印出地址（或超时），返回 { out, port, child } */
async function runBat() {
  // SPC_NO_OPEN：bat 不该带参数，靠环境变量告诉 serve.js 别开浏览器 ——
  // 否则每跑一次自检就弹两个标签页，很烦，也容易让人以为"卡住了"。
  const child = spawn('cmd.exe', ['/d', '/c', BAT], {
    cwd: ROOT, windowsHide: true, env: { ...process.env, SPC_NO_OPEN: '1' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => { out += d.toString('utf8'); });
  const started = Date.now();
  let port = null;
  while (Date.now() - started < 40000) {
    const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) { port = m[1]; break; }
    await sleep(400);
  }
  return { out: () => out, port, child };
}

(async () => {
  console.log('== 实测 ' + path.basename(BAT) + ' ==\n');

  /* ---------------- A. 端口空闲 ---------------- */
  console.log('[A] 端口空闲时能否正常启动');
  const free = await get('http://127.0.0.1:' + PORT + '/');
  check('起点干净：端口上没有残留服务', !!free.error || free.status !== 200,
    free.error ? free.error : ('HTTP ' + free.status));

  const a = await runBat();
  const outA = a.out();
  check('bat 启动了服务并打印地址', !!a.port, a.port ? 'port ' + a.port : '未在 40s 内看到地址');
  check('★ 起在预期的端口上（没有顺延到 4323）', a.port === PORT, 'port=' + a.port);
  check('启动前先做了清理这一步', /端口 \d+ 是空的|已结束 \d+ 个遗留进程/.test(outA),
    (outA.match(/.*(是空的|已结束).*/) || [''])[0].trim());
  check('清理在启动之前（顺序不能反）', (() => {
    const iClean = outA.search(/端口 \d+ 是空的|已结束 \d+ 个遗留进程/);
    const iStart = outA.search(/本地服务已启动/);
    return iClean !== -1 && iStart !== -1 && iClean < iStart;
  })(), '');

  if (a.port) {
    const page = await get('http://127.0.0.1:' + a.port + '/m1-engine-check.html');
    check('M1 页面可访问', page.status === 200, page.error || ('HTTP ' + page.status + ' / ' + page.bytes + ' B'));
    check('M1 页面 MIME 正确', page.type === 'text/html; charset=utf-8', page.type || '');

    const wasm = await get('http://127.0.0.1:' + a.port + '/vendor/mediapipe/wasm/vision_wasm_internal.wasm');
    check('wasm 返回 application/wasm', wasm.type === 'application/wasm', wasm.type || (wasm.error || ''));

    const mjs = await get('http://127.0.0.1:' + a.port + '/vendor/mediapipe/vision_bundle.mjs');
    check('mjs 返回 text/javascript', /text\/javascript/.test(mjs.type || ''), mjs.type || (mjs.error || ''));

    check('控制台出现启动横幅', /本地服务已启动/.test(outA), '');
    check('bat 未要求安装 Node（说明探测器命中）', !/Neither Node\.js nor Python/.test(outA), '');
  }

  console.log('\n--- [A] bat 控制台输出 ---');
  console.log(outA.trim() || '(空)');
  await killTree(a.child && a.child.pid);
  await sleep(1200);   // 等端口彻底松开再进下一段

  /* ---------------- B. 端口被旧服务占着 ---------------- */
  console.log('\n[B] 端口上留着上一次的服务时，能否先收掉再起');
  const stale = await startServer(['--port', PORT, '--no-open']);
  check('已故意留下一个旧服务占住端口', !!stale, stale ? 'pid ' + stale.pid : '没能起起来');

  const b = await runBat();
  const outB = b.out();
  check('★ 认出了那个遗留进程并结束了它',
    /已结束 1 个遗留进程/.test(outB), (outB.match(/.*已结束.*/) || [''])[0].trim());
  check('★ 没有把别的程序误判成自己的（映像名核对过）', /node\.exe|python\.exe/.test(outB), '');
  check('★★ 仍然起在 4322 上 —— 没清理时这里会变成 4323', b.port === PORT, 'port=' + b.port);

  if (b.port === PORT) {
    const page = await get('http://127.0.0.1:' + PORT + '/');
    check('清理后新服务确实在响应', page.status === 200, page.error || ('HTTP ' + page.status));
  }

  console.log('\n--- [B] bat 控制台输出 ---');
  console.log(outB.trim() || '(空)');
  await killTree(b.child && b.child.pid);

  const failed = results.filter((r) => !r.ok);
  console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  process.exit(failed.length ? 1 : 0);
})();
