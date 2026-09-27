'use strict';

/**
 * tools/pw.js — 浏览器自检的公共引导
 *
 * 三个浏览器自检都要用：模块路径、Chromium 可执行文件、合成摄像头参数。
 * 抽出来避免每个测试各写一份，改路径时只改一处。
 *
 * 这里**不写死任何本机路径**（否则换台机器就跑不起来）。查找顺序：
 *   1. 环境变量 PW_MODULE / PW_CHROME（最优先，便于临时指定）
 *   2. 当前仓库 node_modules 里的 playwright-core / playwright
 *   3. 全局 node_modules
 *   4. Chromium：环境变量 → ms-playwright 缓存里最新的那份 → 交给 playwright 自己找
 *
 * 装不上时的提示见下方 missing()，README「开发命令」一节也有同样说明。
 */

const fs = require('fs');
const path = require('path');

/** 候选模块路径：按优先级从"最应该找得到"排到"最后兜底" */
function moduleCandidates() {
  const names = ['playwright-core', 'playwright'];
  const roots = [];
  if (process.env.PW_MODULE) roots.push(process.env.PW_MODULE);
  // 仓库根 node_modules（本文件在 tools/ 下）
  roots.push(path.join(__dirname, '..', 'node_modules'));
  // node 的全局 node_modules（npx / npm root -g 的常见位置）
  roots.push(path.join(path.dirname(process.execPath), 'node_modules'));
  roots.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'));
  const out = [];
  for (const r of roots) for (const n of names) out.push(path.join(r, n));
  // 裸模块名放最后：交给 node 自己的解析（含 NODE_PATH）
  out.push(...names);
  return out;
}

function missing(what) {
  return [
    '找不到 ' + what + '，浏览器自检无法运行。装一次即可：',
    '    npm install                      # 安装 devDependencies（playwright-core）',
    '    npx playwright install chromium   # 下载一份 Chromium',
    '若本机已有 Chromium，可用环境变量直接指过去：',
    '    PW_MODULE=<playwright-core 目录> PW_CHROME=<chrome.exe 路径> node tools/smoke-test.js',
  ].join('\n');
}

function loadPlaywright() {
  for (const c of moduleCandidates()) {
    try { return require(c); } catch (e) { /* 继续尝试下一个 */ }
  }
  throw new Error(missing('playwright-core / playwright'));
}

const { chromium } = loadPlaywright();

/** 在 ms-playwright 缓存目录里挑一个 Chromium（取目录名最大的那份，即最新） */
function scanBrowsers() {
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    process.env.HOME && path.join(process.env.HOME, '.cache', 'ms-playwright'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Local', 'ms-playwright'),
  ].filter(Boolean);

  const rels = [
    path.join('chrome-win64', 'chrome.exe'),
    path.join('chrome-win', 'chrome.exe'),
    path.join('chrome-linux', 'chrome'),
    path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ];

  for (const cache of caches) {
    let entries;
    try { entries = fs.readdirSync(cache); } catch (e) { continue; }
    const dirs = entries
      .filter((n) => n.startsWith('chromium-'))
      .sort((a, b) => {
        const na = parseInt(a.slice('chromium-'.length), 10) || 0;
        const nb = parseInt(b.slice('chromium-'.length), 10) || 0;
        return nb - na || b.localeCompare(a);
      });
    for (const d of dirs) {
      for (const rel of rels) {
        const p = path.join(cache, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined;
}

function findChrome() {
  if (process.env.PW_CHROME && fs.existsSync(process.env.PW_CHROME)) return process.env.PW_CHROME;
  return scanBrowsers(); // undefined = 交给 playwright 自己解析（含 PLAYWRIGHT_BROWSERS_PATH）
}

/** 带合成摄像头的浏览器。合成画面是滚动彩条，里面没有人 —— 正好也验证"无人时不误计数" */
async function launch(opts = {}) {
  return chromium.launch({
    executablePath: findChrome(),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
    ...opts,
  });
}

module.exports = { chromium, findChrome, loadPlaywright, launch, missing, scanBrowsers };
