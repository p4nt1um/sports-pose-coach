'use strict';

/**
 * tools/clean-start.js — 启动前清理：收掉上一次遗留的本项目服务进程
 *
 * 为什么需要它（不是洁癖）：
 *   `serve.js` 遇到端口被占**会自动顺延到下一个端口**（4322 → 4323 …）。
 *   于是「上次的窗口没关干净」看起来是启动成功，实际可能打开的是跑着旧代码的旧服务，
 *   或者新服务在 4323 而老师收藏的是 4322。两种症状都不报错、都难查。
 *   启动前先把占着端口的那一个收掉，端口才是确定的。
 *
 * 只动自己人的进程：
 *   仅当占用者是 node / python（本项目仅有的两种服务端实现）才结束它。
 *   占用者是别的程序时**一个也不动**，打印 PID 与映像名后以退出码 2 退出 ——
 *   随便 taskkill 一个不认识的进程，只是把「启动失败」换成「用户别的软件莫名退出」。
 *
 * 为什么先「试绑」再查 PID：
 *   `netstat` 的状态列在部分语言版本的 Windows 上是本地化的，而且在某些受限环境里
 *   监听套接字会被报成 Closed。所以判「端口能不能用」不靠读文本，而是**真的 bind 一次** ——
 *   这正是 serve.js 启动时要做的事，成不成它最清楚。查 PID 只在确实绑不上时才做。
 *
 * 用法： node tools/clean-start.js [--port 4322] [--dry-run]
 * 退出码：0 = 端口已空闲（本来就空，或清理成功）
 *         2 = 端口被别的程序占着 / 查不到占用者（没动它）
 *         1 = 想清理但没成功
 */

const net = require('net');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = parseInt(argOf('--port', '4322'), 10);
const DRY = argv.indexOf('--dry-run') !== -1;

/** 允许被我们结束的进程（本项目只有这两种服务端实现） */
const OWN_IMAGES = ['node.exe', 'python.exe', 'pythonw.exe'];

/** 跑一条命令，任何失败都返回空串 —— 清理是尽力而为，不该自己把启动搞崩 */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  } catch (e) {
    // 有输出但退出码非 0 时也会抛，输出仍要拿回来
    return (e && (e.stdout || e.stderr)) || '';
  }
}

/** 真的 bind 一次：能绑上就是空闲。用 serve.js 同一个地址，避免 IPv4/IPv6 的差异 */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    const done = (free) => { try { s.close(); } catch (e) { /* 已关 */ } resolve(free); };
    s.once('error', () => done(false));
    s.once('listening', () => done(true));
    s.listen(port, '127.0.0.1');
  });
}

/** PID 列表 → 只剩活着的、非系统进程 */
function aliveOnly(pids) {
  return pids.filter((p) => /^\d+$/.test(p) && p !== '0' && p !== '4');
}

/**
 * 找出监听该端口的 PID。
 *
 * 首选 `Get-NetTCPConnection`：它直接给 OwningProcess，不像 netstat 那样要按列解析，
 * 也不依赖本地化文本。**故意不加 `-State Listen` 过滤** —— 个别受限环境下监听套接字
 * 会被报成 Closed，加了过滤就一个都查不到；反正后面还要核对映像名，宽一点更安全。
 * 查不到再退回 netstat。
 */
function pidsOf(port) {
  const ps = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-NetTCPConnection -LocalPort ' + port +
    ' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess']);
  const fromPs = aliveOnly(ps.split(/\s+/).filter(Boolean));
  if (fromPs.length) return Array.from(new Set(fromPs));

  const out = run('netstat', ['-ano', '-p', 'tcp']);
  const pids = [];
  for (const raw of out.split(/\r?\n/)) {
    const cols = raw.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (!new RegExp(':' + port + '$').test(cols[1])) continue;
    const pid = cols[cols.length - 1];
    if (!/^\d+$/.test(pid)) continue;
    pids.push(pid);
  }
  return Array.from(new Set(aliveOnly(pids)));
}

/** PID → 映像名（小写）。取不到就给空串，绝不猜。 */
function imageOf(pid) {
  const out = run('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH']);
  const m = out.match(/^"([^"]+)"/m);
  return m ? m[1].toLowerCase() : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (await portFree(PORT)) {
    console.log('  端口 ' + PORT + ' 是空的，直接启动。');
    process.exit(0);
  }

  console.log('  端口 ' + PORT + ' 被占用，检查占用者：');
  const pids = pidsOf(PORT);

  if (!pids.length) {
    console.log('');
    console.log('  [ERROR] 端口 ' + PORT + ' 绑不上，但查不到是哪个进程占着它。');
    console.log('          （权限不足或受限环境时会出现这种情况）');
    console.log('');
    console.log('  处理办法：');
    console.log('    1) 关掉上次留下的命令行窗口（标题是 Sports Pose Coach），再启动；');
    console.log('    2) 或用管理员身份重新双击启动；');
    console.log('    3) 或换端口启动： node tools/serve.js --port 4400');
    process.exit(2);
  }

  const mine = [];
  const foreign = [];
  for (const pid of pids) {
    const img = imageOf(pid);
    const label = '    PID ' + pid + '  ' + (img || '(取不到映像名)');
    if (OWN_IMAGES.indexOf(img) !== -1) {
      mine.push({ pid, img });
      console.log(label + '  ← 上次遗留的本项目服务，准备结束');
    } else {
      foreign.push({ pid, img });
      console.log(label + '  ← 不是本项目的服务');
    }
  }

  if (foreign.length) {
    console.log('');
    console.log('  [ERROR] 端口 ' + PORT + ' 被别的程序占着，我没有动它：');
    for (const f of foreign) console.log('          PID ' + f.pid + '  ' + (f.img || '(未知)'));
    console.log('');
    console.log('  两种处理办法：');
    console.log('    1) 关掉上面那个程序，再双击启动；');
    console.log('    2) 换一个端口启动： node tools/serve.js --port 4400');
    process.exit(2);
  }

  if (DRY) {
    console.log('\n  --dry-run：本来会结束 ' + mine.length + ' 个进程，现在什么都没做。');
    process.exit(0);
  }

  for (const p of mine) run('taskkill', ['/F', '/T', '/PID', String(p.pid)]);

  // 等端口真的松开。taskkill 是同步返回的，但套接字有短暂滞后
  for (let i = 0; i < 25; i++) {
    await sleep(150);
    if (await portFree(PORT)) {
      console.log('  已结束 ' + mine.length + ' 个遗留进程（' +
        mine.map((p) => p.pid).join(', ') + '），端口已释放。');
      process.exit(0);
    }
  }

  console.log('  [ERROR] 结束进程后端口 ' + PORT + ' 仍被占用（PID ' +
    pidsOf(PORT).join(', ') + '）。可能是权限不足，请用管理员身份重试。');
  process.exit(1);
})();
