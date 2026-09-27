/*
 * test-bat.js — 实测 启动.bat 能否真正拉起本地服务
 *
 * 做法：真的 spawn 一次 cmd /c 启动.bat，从它的控制台输出里解析出
 *       serve.js 打印的地址，再发 HTTP 请求确认服务可用，最后整棵进程树杀掉。
 *
 * 用法： node sports-pose-coach/tools/test-bat.js
 */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(process.cwd(), 'sports-pose-coach');
const BAT = path.join(ROOT, '启动.bat');

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

console.log('== 实测 ' + path.basename(BAT) + ' ==\n');

let child;
try {
  child = spawn('cmd.exe', ['/d', '/c', BAT], { cwd: ROOT, windowsHide: true });
} catch (e) {
  console.log('  spawn 失败：' + e.message);
  process.exit(2);
}

let out = '';
let err = '';
let spawnError = null;
child.stdout.on('data', (d) => { out += d.toString('utf8'); });
child.stderr.on('data', (d) => { err += d.toString('utf8'); });
child.on('error', (e) => { spawnError = e.message; });
child.on('exit', (code) => { if (!/http:\/\/127\.0\.0\.1/.test(out)) out += '\n[exit code ' + code + ']'; });

const started = Date.now();

function waitForUrl() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearInterval(t); resolve(m[1]); }
      else if (Date.now() - started > 40000) { clearInterval(t); resolve(null); }
    }, 400);
  });
}

(async () => {
  const port = await waitForUrl();

  if (spawnError) check('cmd 可执行', false, spawnError);
  check('bat 启动了服务并打印地址', !!port, port ? 'port ' + port : '未在 40s 内看到地址');

  if (port) {
    const page = await get('http://127.0.0.1:' + port + '/m1-engine-check.html');
    check('M1 页面可访问', page.status === 200, page.error || ('HTTP ' + page.status + ' / ' + page.bytes + ' B'));
    check('M1 页面 MIME 正确', page.type === 'text/html; charset=utf-8', page.type || '');

    const wasm = await get('http://127.0.0.1:' + port + '/vendor/mediapipe/wasm/vision_wasm_internal.wasm');
    check('wasm 返回 application/wasm', wasm.type === 'application/wasm', wasm.type || (wasm.error || ''));

    const mjs = await get('http://127.0.0.1:' + port + '/vendor/mediapipe/vision_bundle.mjs');
    check('mjs 返回 text/javascript', /text\/javascript/.test(mjs.type || ''), mjs.type || (mjs.error || ''));

    check('控制台出现启动横幅', /本地服务已启动/.test(out), '');
    check('bat 未要求安装 Node（说明探测器命中）', !/Neither Node\.js nor Python/.test(out), '');
  }

  console.log('\n--- bat 控制台输出 ---');
  console.log(out.trim() || '(空)');
  if (err.trim()) console.log('\n--- stderr ---\n' + err.trim());

  if (child && child.pid) {
    await new Promise((r) => {
      const k = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
      k.on('exit', r);
      k.on('error', r);
    });
    console.log('\n（已终止进程树 pid=' + child.pid + '）');
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过');
  process.exit(failed.length ? 1 : 0);
})();
