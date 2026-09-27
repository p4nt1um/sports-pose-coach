#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/serve.py — 后备静态服务器（Node 不可用时使用）

与 serve.js 保持同样的关键配置：
  - .wasm 返回 application/wasm（否则 instantiateStreaming 失败）
  - .mjs 返回 text/javascript（否则 ES module import 被拒）
  - COOP/COEP 头，启用 SharedArrayBuffer
用标准库实现，无需任何依赖。
"""

import http.server
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
START_PORT = 4322

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map.update({
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.wasm': 'application/wasm',
        '.task': 'application/octet-stream',
        '.tflite': 'application/octet-stream',
        '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2',
        '.md': 'text/plain; charset=utf-8',
    })

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = START_PORT
    httpd = None
    for _ in range(24):
        try:
            httpd = Server(('127.0.0.1', port), Handler)
            break
        except OSError:
            port += 1
    if httpd is None:
        print('无法找到可用端口（4322-4345 均被占用）')
        return 1

    base = 'http://127.0.0.1:%d' % port
    line = '=' * 58
    print('\n' + line)
    print('  运动姿态识别 · 本地服务已启动（Python 后备模式）')
    print(line)
    print('  根目录    ' + ROOT)
    print('  首页      ' + base + '/')
    print('  动作计数   ' + base + '/v1-counter.html')
    print('  参数调试台 ' + base + '/tools/tune.html')
    print('  引擎验证   ' + base + '/m1-engine-check.html')
    print(line)
    print('  关闭本窗口或按 Ctrl+C 即停止服务\n')

    # 打开统一入口页 —— 而不是某个具体页面，否则老师看不到另外两页
    threading.Timer(0.8, lambda: webbrowser.open(base + '/')).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
