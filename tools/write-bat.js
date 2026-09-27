/*
 * write-bat.js — 生成 启动.bat
 *
 * 为什么用脚本生成而不是直接写文件：
 *   .bat 是 CRLF 敏感的文件。任何一次「转义层数搞错」都会写出
 *   「一行里塞满字面量 \r\n」的废文件（cmd 直接报错无法执行）。
 *   这里把内容定义成「行数组」，换行符用 String.fromCharCode(13,10)
 *   在运行时构造，从根上避免这类问题。
 *
 * 另外两条硬约束（已内置校验）：
 *   - 文件必须是纯 ASCII：cmd 按当前代码页解码，非 ASCII 会乱码。
 *   - 不能带 BOM：BOM 会被 cmd 当成命令字符报错。
 *
 * 用法： node sports-pose-coach/tools/write-bat.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.cwd(), 'sports-pose-coach');
const OUT = path.join(ROOT, '启动.bat');

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const NL = CR + LF;

// 纯 ASCII：bat 内不出现中文，中文提示交给 serve.js 输出（chcp 65001 后正常显示）
const LINES = [
  '@echo off',
  'chcp 65001 >nul',
  'title Sports Pose Coach - local server',
  'cd /d "%~dp0"',
  '',
  'rem ============================================================',
  'rem  Sports Pose Coach / one-click launcher',
  'rem  Why a local server instead of double-clicking the HTML:',
  'rem    1) MediaPipe WASM is loaded via fetch, blocked under file://',
  'rem    2) getUserMedia (camera) needs a secure context',
  'rem  http://127.0.0.1 satisfies both.',
  'rem ============================================================',
  '',
  'if not exist "tools\\serve.js" (',
  '  echo.',
  '  echo   [ERROR] tools\\serve.js not found.',
  '  echo   Please keep this .bat in the project root folder.',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'set "NODE_EXE="',
  '',
  'rem --- 1) node on PATH ---',
  'where node >nul 2>nul',
  'if not errorlevel 1 set "NODE_EXE=node"',
  '',
  'rem --- 2) node bundled with WorkBuddy ---',
  'if not defined NODE_EXE (',
  '  for /d %%d in ("%USERPROFILE%\\.workbuddy\\binaries\\node\\versions\\*") do (',
  '    if not defined NODE_EXE if exist "%%~fd\\node.exe" set "NODE_EXE=%%~fd\\node.exe"',
  '  )',
  ')',
  '',
  'if not defined NODE_EXE goto :try_python',
  '',
  'echo.',
  'echo   Node.js : %NODE_EXE%',
  'echo   Starting local server...',
  'echo.',
  '',
  'if /i "%NODE_EXE%"=="node" (',
  '  node "tools\\serve.js"',
  ') else (',
  '  "%NODE_EXE%" "tools\\serve.js"',
  ')',
  'if errorlevel 1 goto :run_failed',
  'goto :stopped',
  '',
  ':try_python',
  'where python >nul 2>nul',
  'if errorlevel 1 goto :not_found',
  'echo.',
  'echo   [fallback] Node.js not found, using the Python server.',
  'echo.',
  'python "tools\\serve.py"',
  'if errorlevel 1 goto :run_failed',
  'goto :stopped',
  '',
  ':not_found',
  'echo.',
  'echo   [ERROR] Neither Node.js nor Python was found on this PC.',
  'echo   Install Node.js 18+ from https://nodejs.org and run this file again.',
  'echo.',
  'pause',
  'exit /b 1',
  '',
  ':run_failed',
  'echo.',
  'echo   [ERROR] The local server exited with an error. See messages above.',
  'echo   If the port is busy, close the other program and retry.',
  'echo.',
  'pause',
  'exit /b 1',
  '',
  ':stopped',
  'echo.',
  'echo   Server stopped.',
  'pause',
  'exit /b 0',
  '',
];

const text = LINES.join(NL);
const buf = Buffer.from(text, 'ascii');

// --- 自检 ---
const problems = [];
const decoded = buf.toString('ascii');
if (decoded.indexOf('\\r\\n') !== -1) problems.push('含字面量 \\r\\n');
let nonAscii = 0;
for (const b of buf) if (b > 0x7e) nonAscii++;
if (nonAscii) problems.push('含 ' + nonAscii + ' 个非 ASCII 字节');
if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) problems.push('带 BOM');
const lfCount = (text.match(/\n/g) || []).length;
if (lfCount < 10) problems.push('换行数异常 ' + lfCount);
if (text.indexOf('\r\n\r\n\r\n') !== -1) problems.push('存在空行堆积');

if (problems.length) {
  console.error('生成失败：' + problems.join('；'));
  process.exit(1);
}

fs.writeFileSync(OUT, buf);

console.log('已生成 ' + path.basename(OUT));
console.log('  bytes      ' + buf.length);
console.log('  LF 换行数  ' + lfCount + '（全部为 CRLF）');
console.log('  行数       ' + LINES.length);
console.log('  ASCII      ok（无 BOM、无字面量转义）');
