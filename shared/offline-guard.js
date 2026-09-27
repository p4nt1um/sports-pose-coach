/**
 * shared/offline-guard.js — 离线护栏（**普通脚本，不是模块**，必须在页面 head 里最先加载）
 *
 * 为什么需要它：
 *
 *   MediaPipe 的 `vision_bundle.mjs` 内置了一个使用统计上报器，构造任务时无条件创建：
 *
 *     new Fh(apiKey)  →  setInterval(flush, 60_000)  →  fetch POST
 *     https://odml.pa.googleapis.com/v1/log   (Content-Type: application/x-protobuf)
 *
 *   它**不是**每次推理都发，而是攒着、每 60 秒 flush 一次，且 `close()` 会强制 flush。
 *   所以典型的暴露路径是：老师上完一节课点「停止」→ 那一刻上报被发出去。
 *   在浏览器里只跑几秒钟的自动化测试**看不到它**（还没到 60 秒），
 *   必须在「停止之后」再断言才抓得到 —— 这个坑就是这么发现的。
 *
 *   库没有暴露任何关闭开关（`enableLogging` / `logToConsole` 之类都不存在），
 *   唯一的办法是在传输层拦住。
 *
 *  上报内容与人体姿态无关（只有任务类型、耗时、设备信息、API key），
 *  但它确实是一次**从课堂电脑发往境外服务器的请求**。本项目的对外承诺是
 *  「视频不出本机、完全离线」，学校也会按这个承诺审。既然公开 API 关不掉，
 *  就在这一层把它拦死，并把拦截记录暴露出来供自检断言 —— 
 *  宁可显式地挡住并留下证据，也不要含糊地"应该不会发"。
 *
 * 允许的协议只有：
 *   - 与页面同源（本地服务 http://127.0.0.1:xxxx）
 *   - blob: / data: / about:（不产生网络请求）
 * 其余一律拒绝并在控制台记一条 warning，同时计入 window.__offlineGuard.blocked。
 */

(function () {
  'use strict';

  if (window.__offlineGuard) return;   // 防重复安装

  var PAGE_ORIGIN = location.origin;
  var blocked = [];

  function resolve(u) {
    try { return new URL(String(u), location.href); }
    catch (e) { return null; }
  }

  function allowed(u) {
    if (u == null || u === '') return true;      // 交给原始实现去报错
    var url = resolve(u);
    if (!url) return false;
    if (url.protocol === 'blob:' || url.protocol === 'data:' || url.protocol === 'about:') return true;
    return url.origin === PAGE_ORIGIN;
  }

  function record(u, how, extra) {
    var url = resolve(u);
    var item = {
      url: String(u),
      origin: url ? url.origin : '(无法解析)',
      how: how,
      at: Date.now(),
      stack: extra || null,
    };
    blocked.push(item);
    try {
      console.warn('[离线护栏] 已拦截外部请求（' + how + '）：' + item.url +
        ' —— 本项目承诺完全离线，如需放行请先确认这是有意为之。');
    } catch (e) { /* 控制台不可用也不影响拦截 */ }
    return item;
  }

  /* ---------- fetch ---------- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var u = (typeof input === 'string') ? input : (input && input.url);
      if (!allowed(u)) {
        record(u, 'fetch', new Error('blocked').stack);
        return Promise.reject(new TypeError('离线护栏拦截了外部请求：' + u));
      }
      return origFetch.apply(this, arguments);
    };
    window.fetch.__spcWrapped = true;
  }

  /* ---------- XMLHttpRequest ---------- */
  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    var origOpen = window.XMLHttpRequest.prototype.open;
    window.XMLHttpRequest.prototype.open = function (method, url) {
      if (!allowed(url)) {
        record(url, 'xhr', new Error('blocked').stack);
        throw new DOMException('离线护栏拦截了外部请求：' + url, 'SecurityError');
      }
      return origOpen.apply(this, arguments);
    };
  }

  /* ---------- sendBeacon（退出时上报最爱用的通道） ---------- */
  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (!allowed(url)) { record(url, 'sendBeacon'); return true; }   // 谎称已发，实际丢弃
      return origBeacon(url, data);
    };
  }

  /* ---------- WebSocket / EventSource ---------- */
  if (window.WebSocket) {
    var OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (!allowed(url)) {
        record(url, 'websocket');
        throw new DOMException('离线护栏拦截了外部连接：' + url, 'SecurityError');
      }
      return protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  }
  if (window.EventSource) {
    var OrigES = window.EventSource;
    window.EventSource = function (url, cfg) {
      if (!allowed(url)) {
        record(url, 'eventsource');
        throw new DOMException('离线护栏拦截了外部连接：' + url, 'SecurityError');
      }
      return new OrigES(url, cfg);
    };
    window.EventSource.prototype = OrigES.prototype;
  }

  /** 自检与排障出口 */
  window.__offlineGuard = {
    /** 被拦下的请求明细 [{url, origin, how, at, stack}] */
    blocked: blocked,
    get count() { return blocked.length; },
    /** 去重后的外部主机名，用来在界面上说清"拦了什么" */
    get hosts() {
      var seen = {};
      var out = [];
      for (var i = 0; i < blocked.length; i++) {
        var h = blocked[i].origin;
        if (!seen[h]) { seen[h] = true; out.push(h); }
      }
      return out;
    },
    last: function () { return blocked.length ? blocked[blocked.length - 1] : null; },
    reset: function () { blocked.length = 0; return true; },
  };
})();
