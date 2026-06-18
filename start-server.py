#!/usr/bin/env python3
"""
簡易 HTTP 伺服器
用於本地測試國中調代課自動化系統

使用方式：
1. 在專案目錄執行：python start-server.py
2. 開啟瀏覽器訪問：http://localhost:8000
"""

import http.server
import socketserver
import webbrowser
import os

PORT = 8000

# 切換到腳本所在目錄
os.chdir(os.path.dirname(os.path.abspath(__file__)))

Handler = http.server.SimpleHTTPRequestHandler

# 設定 MIME 類型（確保 JavaScript 模組正確載入）
Handler.extensions_map.update({
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
})

print(f"啟動伺服器於 http://localhost:{PORT}")
print("按 Ctrl+C 停止伺服器")

# 自動開啟瀏覽器
webbrowser.open(f'http://localhost:{PORT}')

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n伺服器已停止")
