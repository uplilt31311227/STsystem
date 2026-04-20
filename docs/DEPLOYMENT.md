---
created: 2026-04-10
updated: 2026-04-20
tags:
  - deployment
---

# 部署文件：國中調代課自動化系統

## 部署環境總覽

| 環境 | URL | branch / repo | 說明 | 狀態 |
|------|-----|---------------|------|------|
| Production | GitHub Pages（本 repo master） | master | 組長穩定版1.0（v1.9.0） | 🟢 運行中 |
| Preview (V2) | https://uplilt31311227.github.io/STsystem-preview/ | STsystem-preview main（源自 feature/permission-system） | V2 權限系統 | 🟢 已部署 |
| Development | http://localhost:8000 | — | 本地開發伺服器 | — |

> V2 預覽站點詳見 [`V2_PERMISSION_SYSTEM.md`](./V2_PERMISSION_SYSTEM.md)。
> 更新 Preview：`git push preview feature/permission-system:main`

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
| 2026-04-09 | v1.7.0 | 教師課表手動編輯功能 |
| 2026-04-10 | v1.8.0 | 多重調課批次、任教領域編輯、衝突檢查 |
| 2026-04-13 | v1.9.0 | 全站緊湊布局改造、Toast 通知、備份還原 |
