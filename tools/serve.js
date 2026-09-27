'use strict';

/**
 * tools/serve.js — 项目自带静态服务器（零依赖）
 *
 * 为什么必须有它，而不是双击 HTML：
 *   1) MediaPipe 的 WASM 走 fetch 加载，file:// 下被 CORS 拦死；
 *   2) 摄像头 getUserMedia 需要安全上下文，file:// 在 Chrome 下被拒。
 *   本地 http://127.0.0.1 恰好满足这两条。
 *
 * 两个容易被忽略的配置：
 *   - .wasm 必须返回 application/wasm，否则 WebAssembly.instantiateStreaming 会失败；
 *   - 发送 COOP/COEP 头可启用 SharedArrayBuffer，MediaPipe 的多线程路径随之可用。
 *
 * 用法： node tools/serve.js [--port 4322] [--no-open]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argPort = (() => {
  const i = argv.indexOf('--port');
  if (i !== -1 && argv[i + 1]) return parseInt(argv[i + 1], 10);
  return null;
})();
const noOpen = argv.indexOf('--no-open') !== -1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, code, headers, body) {
  res.writeHead(code, {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...headers,
  });
  if (body) res.end(body); else res.end();
}

function renderDirList(dirUrl, entries) {
  const items = entries.map((e) => {
    const slash = e.isDir ? '/' : '';
    const href = dirUrl.replace(/\/?$/, '/') + encodeURIComponent(e.name) + slash;
    return `<li><a href="${href}">${e.name}${slash}</a></li>`;
  }).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>sports-pose-coach</title>
<style>body{font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;max-width:760px;margin:48px auto;padding:0 24px;color:#17191d}
h1{font-size:17px;font-weight:600}ul{list-style:none;padding:0}li{padding:6px 0;border-bottom:1px solid #eee}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
p{color:#6b7280;font-size:13px}</style></head><body>
<h1>sports-pose-coach · 本地服务</h1><p>目录：${dirUrl}</p><ul>${items}</ul></body></html>`;
}

function handle(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (e) {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request');
  }

  const target = path.normalize(path.join(ROOT, urlPath));
  // 防止跳出根目录
  if (!target.startsWith(ROOT)) {
    return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
  }

  fs.stat(target, (err, st) => {
    if (err) {
      return send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' },
        '<h1 style="font:16px system-ui;padding:40px">404 · ' + urlPath + '</h1>');
    }

    if (st.isDirectory()) {
      const indexPath = path.join(target, 'index.html');
      if (fs.existsSync(indexPath)) return serveFile(indexPath, res);
      const entries = fs.readdirSync(target, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, renderDirList(urlPath, entries));
    }

    return serveFile(target, res);
  });
}

function serveFile(file, res) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const size = fs.statSync(file).size;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    // 开发期禁用缓存：改完代码刷新即生效，避免"改了没变化"的假象
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  fs.createReadStream(file).pipe(res);
}

function listen(port, attempt) {
  const server = http.createServer(handle);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 24) {
      return listen(port + 1, attempt + 1);
    }
    console.error('服务启动失败：' + err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    onReady(port);
  });
}

function onReady(port) {
  const base = 'http://127.0.0.1:' + port;
  const line = '='.repeat(58);
  console.log('\n' + line);
  console.log('  运动姿态识别 · 本地服务已启动');
  console.log(line);
  console.log('  根目录    ' + ROOT);
  console.log('  首页      ' + base + '/');
  console.log('  动作计数   ' + base + '/v1-counter.html');
  console.log('  参数调试台 ' + base + '/tools/tune.html');
  console.log('  引擎验证   ' + base + '/m1-engine-check.html');
  console.log(line);
  console.log('  关闭本窗口或按 Ctrl+C 即停止服务\n');

  if (!noOpen) {
    try {
      const child = spawn('cmd', ['/c', 'start', '', base + '/'], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.unref();
    } catch (e) {
      console.log('（未能自动打开浏览器，请手动访问上面的地址）');
    }
  }
}

listen(argPort || 4322, 0);
