---
created: 2026-04-10
updated: 2026-04-10
tags:
  - deployment
---

# 部署文件：國中調代課自動化系統

## 部署環境總覽

| 環境 | URL | 說明 | 狀態 |
|------|-----|------|------|
| Production | GitHub Pages | 靜態前端部署 | 🟢 運行中 |
| Development | localhost | 本地開發伺服器 | - |

## 部署方式

### GitHub Pages

本專案為純前端應用，直接部署至 GitHub Pages：

1. 推送至 `master` 分支
2. GitHub Pages 自動部署 `index.html`

### 本地開發

```bash
# 方法一：Python HTTP Server
python -m http.server 8000

# 方法二：使用 start-server.py
python start-server.py
```

瀏覽器開啟 `http://localhost:8000`

## Firebase 設定

### 必要服務
- Firebase Authentication（Google 登入）
- Firebase Realtime Database（資料同步）

### Firebase Config
Firebase config 為前端公開設定（非機密），已包含在 `index.html` 中。

## 依賴

### 前端 CDN
- PapaParse - CSV 解析
- SheetJS (xlsx) - Excel 讀取
- jsPDF - PDF 生成
- jsPDF-AutoTable - PDF 表格
- Firebase SDK - 雲端同步

### 開發工具
- Node.js (可選，用於本地開發)
- Python (可選，用於 HTTP server)

## 部署歷史

| 日期 | 版本 | 變更內容 |
|------|------|----------|
| 2026-03-27 | v1.6.0 | 多節課調代課功能 |
| 2026-04-10 | v1.7.0 | 教師課表手動編輯功能 |
