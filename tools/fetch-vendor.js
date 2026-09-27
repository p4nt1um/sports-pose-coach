'use strict';

/**
 * 拉取 MediaPipe Tasks Vision 运行时 + Pose Landmarker 模型到本地 vendor/。
 * 目标：全离线运行，零 CDN 依赖。
 *
 * 用法： node sports-pose-coach/tools/fetch-vendor.js [--with-nosimd]
 *
 * 说明：默认只拉 SIMD 版 wasm（-10.45MB）。SIMD 自 2021 年起全平台可用
 * （Chrome/Edge 91+、Firefox 89+、Safari 16.4+），本项目无需兼容更老的浏览器。
 * 只有在必须支持老设备时才加 --with-nosimd。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const OUT_ROOT = path.join(__dirname, '..', 'vendor');
const NPM_PKG = '@mediapipe/tasks-vision';
const FALLBACK_VERSION = '0.10.14';

function fetchBuffer(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    if (redirects > 6) return reject(new Error('too many redirects: ' + url));
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0 (fetch-vendor)', Accept: '*/*' }, timeout: 120000 },
      function (res) {
        const code = res.statusCode;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchBuffer(new URL(res.headers.location, url).href, redirects + 1));
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + code + ' :: ' + url));
        }
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () { resolve(Buffer.concat(chunks)); });
      }
    );
    req.on('timeout', function () { req.destroy(new Error('timeout :: ' + url)); });
    req.on('error', reject);
  });
}

var manifest = [];

async function download(url, destRel) {
  const dest = path.join(OUT_ROOT, destRel);
  const buf = await fetchBuffer(url);
  if (buf.length < 512) throw new Error('suspiciously small payload (' + buf.length + ' B) :: ' + url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  manifest.push({ file: destRel.replace(/\\/g, '/'), bytes: buf.length, sha256: sha, source: url });
  const mb = (buf.length / 1048576).toFixed(2);
  console.log('  ok   ' + String(mb).padStart(7) + ' MB   ' + destRel);
}

async function resolveVersion() {
  try {
    const raw = await fetchBuffer('https://registry.npmjs.org/' + NPM_PKG + '/latest');
    const meta = JSON.parse(raw.toString('utf8'));
    if (meta && meta.version) return meta.version;
  } catch (e) {
    console.log('  ..   registry lookup failed (' + e.message + '), using fallback');
  }
  return FALLBACK_VERSION;
}

(async function main() {
  console.log('== fetch vendor -> ' + OUT_ROOT);
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const version = await resolveVersion();
  console.log('\n[1/3] ' + NPM_PKG + ' @ ' + version + '  (wasm 运行时)');
  const cdn = 'https://cdn.jsdelivr.net/npm/' + NPM_PKG + '@' + version;
  const withNosimd = process.argv.indexOf('--with-nosimd') !== -1;
  const runtimeFiles = [
    'vision_bundle.mjs',
    'wasm/vision_wasm_internal.js',
    'wasm/vision_wasm_internal.wasm',
  ];
  if (withNosimd) {
    runtimeFiles.push('wasm/vision_wasm_nosimd_internal.js');
    runtimeFiles.push('wasm/vision_wasm_nosimd_internal.wasm');
    console.log('      (含 nosimd 兼容版)');
  }
  for (const f of runtimeFiles) {
    await download(cdn + '/' + f, 'mediapipe/' + f);
  }

  console.log('\n[2/3] Pose Landmarker 模型');
  const modelBase = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
  const models = [
    ['lite', modelBase + '/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'],
    ['full', modelBase + '/pose_landmarker_full/float16/1/pose_landmarker_full.task'],
  ];
  for (const m of models) {
    await download(m[1], 'models/pose_landmarker_' + m[0] + '.task');
  }

  if (!withNosimd) {
    const stale = [
      'mediapipe/wasm/vision_wasm_nosimd_internal.js',
      'mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
    ];
    for (const rel of stale) {
      const p = path.join(OUT_ROOT, rel);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log('  del   nosimd  ' + rel);
      }
    }
  }

  console.log('\n[3/3] 扫描 vendor 实际文件并写入版本清单');
  const present = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.name === 'VERSION.json') continue;
      const buf = fs.readFileSync(full);
      present.push({
        file: path.relative(OUT_ROOT, full).replace(/\\/g, '/'),
        bytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      });
    }
  })(OUT_ROOT);

  const totalBytes = present.reduce(function (a, b) { return a + b.bytes; }, 0);
  const versionDoc = {
    fetchedAt: new Date().toISOString(),
    tasksVision: version,
    runtimeBase: 'mediapipe/',
    modelDir: 'models/',
    nosimdIncluded: withNosimd,
    note: '仅含 SIMD wasm；如需兼容 2021 年前的浏览器，用 --with-nosimd 重新拉取',
    totalBytes: totalBytes,
    files: present,
  };
  fs.writeFileSync(path.join(OUT_ROOT, 'VERSION.json'), JSON.stringify(versionDoc, null, 2), 'utf8');
  console.log('  ok   vendor/VERSION.json');

  console.log('\nDONE. vendor 共 ' + (totalBytes / 1048576).toFixed(2) + ' MB / ' + present.length + ' 个文件');
})().catch(function (err) {
  console.error('\nFAILED: ' + err.message);
  process.exit(1);
});
