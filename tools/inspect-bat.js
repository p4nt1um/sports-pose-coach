/*
 * inspect-bat.js — 诊断 .bat 文件是否被写成了「字面量 \r\n 转义」的单行文件
 *
 * 症状：文件里没有真实换行（0x0A），而是把 \r\n 当成 4 个可见字符写进去了，
 *       cmd.exe 会把整份脚本当成一行，直接报错无法执行。
 * 修复：--fix 模式下只重写「无真实换行 且 含字面量 \r\n」的 .bat 文件。
 *
 * 用法： node sports-pose-coach/tools/inspect-bat.js [--fix]
 *        cwd 必须是项目根目录（路径从 process.cwd() 取，命令行里不出现非 ASCII）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.cwd(), 'sports-pose-coach');
const FIX = process.argv.indexOf('--fix') >= 0;
const SKIP_DIRS = new Set(['vendor', 'node_modules', '.git', '_original', 'tools']);
const SCAN_EXT = new Set(['.bat', '.cmd', '.js', '.mjs', '.html', '.md', '.json', '.py']);

const LIT_CRLF = Buffer.from('\\r\\n', 'ascii');
const LIT_LF = Buffer.from('\\n', 'ascii');

function walk(dir, out) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function countOccur(buf, needle) {
  let n = 0;
  let i = buf.indexOf(needle);
  while (i >= 0) {
    n++;
    i = buf.indexOf(needle, i + needle.length);
  }
  return n;
}

const BACKSLASH = String.fromCharCode(92);

/*
 * 把「一行塞满字面量 \r\n」的坏内容还原成真实换行的文本。
 * 关键约束：只还原行尾的 \r\n 和 \t，绝不还原孤立的 \n ——
 * 它是路径的一部分（binaries\node\versions、%%~fd\node.exe），还原会把内容劈碎。
 */
function unescapeBroken(text) {
  return text
    .replace(/(?:\r?\n)?\\r\\n/g, '\r\n')
    .replace(/\\t/g, '\t')
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r\n');
}

// 路径记号计数：反斜杠 + 字母（如 \node、\serve、\binaries）
// 计数前先剔除「转义序列本身」（\r\n、\t），否则分隔符里的 \r \n 会被误计
function pathMarks(text) {
  return (text.replace(/\\r\\n/g, '').replace(/\\t/g, '').match(/\\[a-zA-Z]/g) || []).length;
}

if (process.argv.indexOf('--selftest') >= 0) {
  const lit = BACKSLASH + 'r' + BACKSLASH + 'n';
  const fake = [
    '@echo off',
    'set "NODE_EXE="',
    'for /d %%d in ("%USERPROFILE%\\.workbuddy\\binaries\\node\\versions\\*") do (',
    '  if not defined NODE_EXE if exist "%%~fd\\node.exe" set "NODE_EXE=%%~fd\\node.exe"',
    ')',
    'if /i "%NODE_EXE%"=="node" (',
    '  node "tools\\serve.js"',
    ')',
    '',
  ].join(lit);
  const before = pathMarks(fake);
  const fixed = unescapeBroken(fake);
  const after = pathMarks(fixed);
  const lf = (fixed.match(/\n/g) || []).length;
  const ok =
    lf === 8 &&
    after === before &&
    fixed.indexOf(BACKSLASH + 'r' + BACKSLASH + 'n') === -1 &&
    fixed.indexOf('node.exe') !== -1 &&
    /binaries.node.versions/.test(fixed);
  console.log('== fixer 自测 ==');
  console.log('  输入：单行、字面量 ' + lit + ' x' + countOccur(Buffer.from(fake), LIT_CRLF));
  console.log('  输出：真实换行 ' + lf + ' 个');
  console.log('  路径记号 ' + before + ' -> ' + after + (before === after ? '（完好）' : '（被破坏！）'));
  console.log('  ' + (ok ? 'PASS 修复逻辑安全' : 'FAIL 修复逻辑有问题'));
  process.exit(ok ? 0 : 1);
}

const files = walk(ROOT, []);
const batFiles = files.filter((f) => /\.(bat|cmd)$/i.test(f));
const broken = [];
const scanned = [];

for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  const isBat = /\.(bat|cmd)$/.test(ext);
  if (isBat || SCAN_EXT.has(ext)) {
    const buf = fs.readFileSync(f);
    const lf = countOccur(buf, Buffer.from([0x0a]));
    const cr = countOccur(buf, Buffer.from([0x0d]));
    const litCrlf = countOccur(buf, LIT_CRLF);
    const litLf = countOccur(buf, LIT_LF);
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const bad = lf === 0 && litCrlf > 0;
    scanned.push({ f, ext, bytes: buf.length, lf, cr, litCrlf, litLf, hasBom, bad });
    if (bad) broken.push({ f, buf, litCrlf, litLf });
  }
}

console.log('== 扫描 ' + path.basename(ROOT) + ' （' + files.length + ' 个文件，纳入检查 ' + scanned.length + ' 个）==\n');

const bats = scanned.filter((s) => /\.(bat|cmd)$/.test(s.ext));
console.log('[.bat / .cmd 文件] 共 ' + bats.length + ' 个');
for (const s of bats) {
  console.log(
    '  ' + (s.bad ? 'BROKEN' : 'ok    ') +
    '  ' + path.relative(ROOT, s.f) +
    '  bytes=' + s.bytes +
    '  LF=' + s.lf + ' CR=' + s.cr +
    '  literals(\\r\\n)=' + s.litCrlf + ' (\\n)=' + s.litLf +
    '  BOM=' + (s.hasBom ? 'yes' : 'no')
  );
}

const otherBroken = scanned.filter((s) => s.bad && !/\.(bat|cmd)$/.test(s.ext));
if (otherBroken.length) {
  console.log('\n[其他类型的单行文件，同样异常]');
  otherBroken.forEach((s) => console.log('  ' + path.relative(ROOT, s.f)));
} else {
  console.log('\n[其他类型文件] 均含真实换行，正常');
}

const nonAsciiBats = bats.filter((s) => {
  const buf = fs.readFileSync(s.f);
  for (const b of buf) if (b > 0x7e || (b < 0x20 && b !== 0x0d && b !== 0x0a && b !== 0x09)) return true;
  return false;
});
if (nonAsciiBats.length) {
  console.log('\n[注意] 以下 .bat 含非 ASCII 字节，chcp 与编码需人工确认：');
  nonAsciiBats.forEach((s) => console.log('  ' + path.relative(ROOT, s.f)));
}

if (!FIX) {
  console.log('\n结论：待修复 ' + broken.length + ' 个。加 --fix 执行修复。');
  process.exit(broken.length ? 1 : 0);
}

console.log('\n== 修复 ==');
console.log('  策略：只还原字面量 \\r\\n（行尾）与 \\t。');
console.log('  故意不还原孤立的 \\n —— 它是路径的组成部分（如 "binaries\\node\\versions"、');
console.log('  "%%~fd\\node.exe"），还原成换行会把 .bat 内容劈碎。');
console.log('');

for (const b of broken) {
  const before = b.buf.toString('utf8');
  // 统计行尾转义（其后是另一个转义或字符串末尾）与路径里的 \n，用于复核
  const pathTokensBefore = pathMarks(before);

  const text = unescapeBroken(before);

  const bytes = Buffer.from(text, 'utf8');
  const pathTokensAfter = pathMarks(text);

  // 一致性守卫：还原不应减少「反斜杠 + 字母」的路径记号
  if (pathTokensAfter < pathTokensBefore - 2) {
    console.log('  SKIP ' + path.relative(ROOT, b.f) +
      ' :: 还原会破坏路径记号（' + pathTokensBefore + ' -> ' + pathTokensAfter + '），已放弃自动修复');
    console.log('       建议改用 tools/write-bat.js 重新生成该文件。');
    continue;
  }

  fs.writeFileSync(b.f, bytes);
  const nb = fs.readFileSync(b.f);
  console.log(
    '  fixed ' + path.relative(ROOT, b.f) +
    '  bytes=' + nb.length + '  LF=' + countOccur(nb, Buffer.from([0x0a])) +
    '  残留字面量=' + countOccur(nb, LIT_CRLF) +
    '  路径记号=' + pathTokensBefore + ' -> ' + pathTokensAfter
  );
}

// 复核
let stillBad = 0;
for (const b of broken) {
  const nb = fs.readFileSync(b.f);
  if (countOccur(nb, Buffer.from([0x0a])) === 0) stillBad++;
}
console.log(stillBad ? '\n仍有 ' + stillBad + ' 个未修复' : '\n全部修复完成，均为真实 CRLF');
