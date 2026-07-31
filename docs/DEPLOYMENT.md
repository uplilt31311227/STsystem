---
created: 2026-04-10
updated: 2026-07-29
tags:
  - deployment
---

# 部署文件：國中調代課自動化系統

## 部署環境總覽

| 環境 | URL | branch / repo | 說明 | 狀態 |
|------|-----|---------------|------|------|
| Production | GitHub Pages（本 repo master） | master | 組長穩定版1.0（v1.13.2） | 🟢 運行中 |
| Preview (V2) | https://uplilt31311227.github.io/STsystem-preview/ | STsystem-preview main（源自 feature/permission-system） | V2 權限系統（Phase 1-3：三層角色 + 全校課表共享 + 三種審核流程） | 🟢 已部署 |
| Development | http://localhost:8000 | — | 本地開發伺服器 | — |

> V2 預覽站點詳見 [`V2_PERMISSION_SYSTEM.md`](./V2_PERMISSION_SYSTEM.md)。
> 更新 Preview：`git push preview feature/permission-system:main`
>
> **回朔（rollback）**：每次更新 preview 前先把舊 main 存成備份分支。
> 2026-06-25 部署 Phase 1 前的備份點 = `90db3b4`（分支 `backup-pre-phase1-20260625`）。
> 2026-07-10 部署 Phase 3 前的備份點 = `614e4ff`（分支 `backup-pre-phase3-20260710`）；
> 同日 firestore.rules 已發布 release → ruleset `0ad89275-0df4-46c6-99c8-825a6cc94889`
> **現行線上 release：`618f5d1e-d350-4e8e-950e-b551eab97490`**（2026-07-29 重新部署，內容與 `0ad89275` 及本地 `firestore.rules` 經位元級比對完全相同，規則本身未變更）
> （前一版 ruleset = `05f9b203-10fb-4df0-bef3-ecfec905fe16`，rules 回朔可用 Firebase Console 或 PATCH release 指回）。
> 一鍵回朔：`git push preview 90db3b4:main -f`（或 `git push preview backup-pre-phase1-20260625:main -f`）。
> ⚠️ Google 登入需 `uplilt31311227.github.io` 在 Firebase Console → Authentication → Settings → Authorized domains 內（preview 站既有，通常已授權）。

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
- Firestore Database（V2 資料同步；master 仍用 Realtime DB / users path）
- 專案：`stsystem-9d5fe`

### Firebase Config
Firebase config 為前端公開設定（非機密），已包含在 `index.html` 中。

### Firestore 安全規則
規則檔 `firestore.rules` 為 source of truth。部署：
```bash
node scripts/firestore-deploy-rules.js          # 建立 ruleset 並發布 release
node scripts/firestore-deploy-rules.js --list   # 觀察目前 release 與最近 ruleset
node scripts/firestore-deploy-rules.js --dry    # 只建立 ruleset 不發布
```
認證：透過 `gcloud auth print-access-token --account=uplilt31311227@gmail.com`。
詳細權限分層見 [`V2_PERMISSION_SYSTEM.md`](./V2_PERMISSION_SYSTEM.md)。

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
| 2026-04-20 | v2.0.0-alpha | V2 權限系統初版，部署至獨立 preview repo |
| 2026-04-29 | v2.0.0-alpha2 | Firestore 規則 v2.1（角色判讀）+ 部署/健康檢查腳本 + E2E checklist |
| 2026-06-25 | v2.0.0 Phase 1 | Preview 部署三層角色 + rules v2.2 資安修補（commit `e00e89f`）；回朔點 `90db3b4`（分支 `backup-pre-phase1-20260625`） |
| 2026-07-10 | v2.0.0 Phase 3 | Preview 部署三種審核流程分支（代課單簽／調課雙簽／多重調課全員同意）+ firestore.rules 資安收緊；回朔點 `614e4ff`（分支 `backup-pre-phase3-20260710`）；同日 rules 發布 release → ruleset `0ad89275-0df4-46c6-99c8-825a6cc94889`（前一版 `05f9b203-10fb-4df0-bef3-ecfec905fe16`） |
| 2026-07-29 | v2.0.0（開發中，基準線查核） | 商用上線前基準線：查證 Firebase Email/Password provider 已啟用（`signIn.email.enabled=true`）；production `schools/inhu` 資料現況盤點（teachers 29 筆、pendingRequests 0、substituteRecords 1 等）；feature 分支再次合併 master（commit `12f8bb4`），不再落後；preview 回朔點沿用 `614e4ff` |
| 2026-07-30 | v2.0.0（開發中） | Preview 部署教師管理表合併（V1 教師屬性表與 V2 帳號管理表併為單一表、全欄位即時自動儲存、欄位級權限分層）+ 新增教師防重與同名帳號檔刪除保護；回朔點 `f6a37a7`（分支 `backup-pre-teachers-merge-20260730`）、`717bb2c`（分支 `backup-pre-preview-update-20260730`）；firestore.rules 未變更，線上 ruleset 沿用 `bd1a6f7a-d662-48cf-8d6d-d2f87c055aab` |
