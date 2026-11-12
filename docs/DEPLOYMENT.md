---
created: 2026-04-10
updated: 2026-11-10
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
> 2026-09-10 更新前的備份點 = `963eb69`（分支 `backup-pre-preview-update-20260910`，已推至 preview remote）。
> **2026-10-03 更新前的備份點 = `6cb4a96`（分支 `backup-pre-preview-update-20261003`，已推至 preview remote）。**
> **2026-11-05 更新前的備份點 = `1c96150`（分支 `backup-pre-preview-update-20261105`，已推至 preview remote）；rules 回朔點 = ruleset `4d39928b-c4ba-4184-a1fd-86bd23bdab5f`（v2.8，原文存 `backups/rules/firestore.rules.live-4d39928b`）；正式庫備份 `backups/firestore/20261105-203341`。**
> 同日 firestore.rules 已發布 release → ruleset `0ad89275-0df4-46c6-99c8-825a6cc94889`
> **現行線上 release：`6c56e3da-bb2d-4dd7-810e-edf7371bcb1f`（2026-11-07 發布，rules v2.11）**。前一版 `d14e145f`（2026-11-05，v2.10）；再前 `4d39928b`（2026-10-07，v2.8）。更早：`08bbfa7d-ad35-4285-b82e-8acff8463449`（2026-07-31 Stage 0-5 上線時發布；2026-09-10 以 `firestore-deploy-rules.js --list` 查證仍為目前 release，且 `firestore.rules` 最後一次變動亦在 2026-07-31，故本地與線上一致。前一版 `bd1a6f7a-d662-48cf-8d6d-d2f87c055aab`，2026-07-29 發布）
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

### 帳單與自動斷線（2026-11-10 起）
- ⚠️ **2026-11-12 16:49（台灣）起帳單綁定已手動解除**，專案為免費方案、斷線函式停止運作（原因見 ISSUES_LOG 2026-11-12）。以下為解除前的設定，重新綁定後才生效。
- stsystem-9d5fe 綁定帳單帳戶「STsystem」`01A75D-93C4DE-69DE70`（Blaze）。
- 預算警報 TWD 250／300／500（只寄信）＋ **TWD 500 自動斷線**（2026-11-12 由 1000 調降）：Cloud Function `billing-kill-switch`（gen2，asia-east1，程式在 `cloud-functions/billing-kill-switch/`），當月實際花費達 500 即解除帳單綁定，全專案退回免費方案。觸發後的恢復步驟與重新部署指令見 [`BILLING-KILL-SWITCH.md`](./BILLING-KILL-SWITCH.md)。
- 本專案第一個也是唯一的伺服器端元件；不接觸 Firestore 資料。

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
- PapaParse 5.4.1 - CSV 解析
- SheetJS (xlsx) 0.20.3 - Excel 讀取（`cdn.sheetjs.com` 官方修補版；cdnjs 的 0.18.5 有 CVE-2023-30533／CVE-2024-22363 且已停止更新）
- jsPDF 3.0.3 - PDF 生成
- jsPDF-AutoTable 3.8.1 - PDF 表格
- html2canvas 1.4.1 - HTML 轉圖（PDF 中文支援）
- Firebase SDK 10.7.1 - 以動態 `import()` 自 `www.gstatic.com` 載入（無法加 SRI）

### 內容安全政策（CSP）與 SRI 維護規則（2026-11 P4 起）

`index.html` 以 `<meta http-equiv="Content-Security-Policy">` 限制可載入的來源，所有 CDN `<script>` 都鎖定確切版本並帶 `integrity="sha384-…"` 與 `crossorigin="anonymous"`。

- **新增或更換任何外部來源（CDN、字型、API、iframe）前，必須先更新 meta CSP 對應的指令**（`script-src`／`connect-src`／`frame-src`／`img-src`…），否則瀏覽器會直接擋下。不要用 `'unsafe-inline'`／`'unsafe-eval'` 放寬 `script-src`；函式庫若需要 eval，先回報再決定。
- 更換 CDN 函式庫版本時，要**實際下載該檔重新計算 sha384**（`openssl dgst -sha384 -binary 檔 | openssl base64 -A`），不可憑記憶填寫；版本號必須固定到 patch。
- 不可有 inline `<script>` 與 `onclick="…"` 之類的 inline 事件處理器；程式放到 `src/js/` 的模組或外部檔（`v2-redirect.js` 即為一例）。`style-src` 保留 `'unsafe-inline'`（專案有大量 inline style 屬性）。
- CSP 的 `connect-src` 內含 `http://127.0.0.1:9099`、`http://127.0.0.1:8080`：**這是本機 Firebase Emulator 專用**（`firebaseConfig.js` 只在 `localhost` + `?emu=1` 時連線），正式站不會用到，保留是為了讓同一份 `index.html` 能在本機跑 e2e；它們不會讓正式站多出攻擊面（只能連使用者本機）。
- meta CSP 不支援 `frame-ancestors`、`report-uri`；GitHub Pages 也無法設定回應標頭。
- 上線後第一次登入請檢查瀏覽器 console 有無 CSP 違規（Google 登入彈窗、App Check 的 reCAPTCHA、Firestore 長連線需連線才能驗證）。

### 本站不可被嵌入 iframe（2026-11 起的行為）

為了防範點擊劫持（審計 L4），`src/js/v2-redirect.js` 在頁面被嵌入 `<iframe>` 時會嘗試把最上層導回本頁，導不了就把整份文件隱藏（`display: none`）。因此**本站無法被其他網站（含自己的其他頁面）以 iframe 內嵌**；若日後有內嵌需求（例如儀表板），必須先修改該檔的框架偵測邏輯。

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
| 2026-09-10 | v2.0.0（開發中） | Preview 站同步至 `52e004c`（先前停在 2026-07-30 的 `963eb69`，落後 30 個 commit）。本次內容：Stage 0-5 多租戶與學期生命週期、登入初始化競態與重複監聽器兩項修復、Emulator 情境測試 90 案與瀏覽器 e2e 28 案、LICENSE 與範例課表。回朔點 `963eb69`（分支 `backup-pre-preview-update-20260910`）；firestore.rules 自 2026-07-31 未再變動，線上 ruleset 沿用 `08bbfa7d-ad35-4285-b82e-8acff8463449`，本次無 rules 部署動作。Pages 建置狀態 `built`（commit `52e004c`），已 curl 驗證新增檔上線 |
| 2026-10-03 | v2.0.0（開發中） | Preview 站同步至 `6ef7115`（先前停在 2026-09-10 的 `6cb4a96`，落後 11 個 commit）。本次內容：代課推薦改五層順序（同科目→班導師→同任課班級→空堂→兼課）＋兼課教師欄位、多節代課班級聯改為每班一張、一般教師「原任課教師」鎖定本人、教師管理頁籤改 director 限定、CSS 相容別名移除、e2e-02 推薦標籤斷言修正。回朔點 `6cb4a96`（分支 `backup-pre-preview-update-20261003`，已推至 preview remote）；`firestore.rules` 自 2026-07-31 未再變動，線上 ruleset 沿用 `08bbfa7d-ad35-4285-b82e-8acff8463449`，本次無 rules 部署動作。**Production（master）刻意未動**，仍為 `6cb4a96`。Pages 建置狀態 `built`（commit `6ef7115`），已 curl 驗證線上 `recommendationEngine.js` 含「同任課班級」、`v2-app.js` 含 `applyOwnTeacherLock`、`tokens.css` 已無舊別名 |
| 2026-11-12 | preview | **Preview 站快轉至 `1e38682`（= master）**，補上 V1 寫入迴圈修正與 V1 轉址（先前停在 `7a215d4`，為 11/11 迴圈再發的來源，見 ISSUES_LOG 2026-11-12）。回朔點 `7a215d4`（分支 `backup-pre-preview-update-20261112`，已推至 preview remote）。Pages `built`，curl 確認線上 `app.js`／`dataManager.js` 含 `fromRealtime`。同日帳單綁定手動解除、斷線預算調為 TWD 500。 |
| 2026-11-07 | rules v2.11 | **Firestore rules v2.11 部署至正式專案**（使用者本人執行 `node scripts/firestore-deploy-rules.js`）：release → ruleset `6c56e3da-bb2d-4dd7-810e-edf7371bcb1f`（前一版 `d14e145f`，v2.10）。內容：組長可刪除目前學期的 substituteRecords（歷史學期仍限主任）。完整下載線上原文與本地 firestore.rules 比對一致；兩版原文存 `backups/rules/`。前端不需更新。 |
| 2026-11-07 | v1.14.3 / v2.0.0 | **Production（master）快轉至 `886c3fe`**（前一版 `93849b4`）：V2 多重調課核准／重印改整批淨結果、駁回撤回收尾。push 觸發的 Pages 部署因 GitHub 端「Deployment failed, try again later」失敗，rerun 再因同 run 重複 github-pages artifact 失敗；改以 workflow_dispatch 重新部署成功（run 42340766034），curl 確認新模組上線、無頭瀏覽器載入 V1／V2 無新錯誤。⚠ 日後部署失敗請直接 workflow_dispatch，不要 rerun --failed。 |
| 2026-11-06 | v1.14.3 / v2.0.0 | **Production（master）快轉至 `d73c923`**（前一版 `5cebe2b`，回朔分支 `backup-pre-prod-merge-20261105`）：feature 分支全部上線——課表匯入日期與版本紀錄、10/22 P0／P1、空課表狀態修正、多重調課通知單（master 原有）與合併驗收修正（待同意不產 PDF、批次 await、PDF XSS 入口跳脫）。rules 沿用 v2.10（`d14e145f`，11/05 已部署）。CI Test 與 Pages deploy 皆 success；curl 確認新模組與修正已上線；無頭瀏覽器載入 V1／V2 無新錯誤。Preview 同步至同版。 |
| 2026-11-05 | v2.0.0（開發中） | **rules v2.10 部署至正式專案**（含 v2.9 主任不可改自己 role、v2.10 `schedules/{semesterId}/imports` 子集合），release → ruleset `d14e145f-2111-4112-9762-b244ab22dcd4`（前一版 `4d39928b`，v2.8；與線上原文比對，非註解差異僅這兩處，對現行正式站 client 相容）。Preview 站同步至 `49eb867`（先前停在 2026-10-03 的 `1c96150`）：課表匯入日期與版本紀錄（可還原）、10/22 P0／P1 修正。部署前備份：正式庫 `backups/firestore/20261105-203341`、rules 原文 `backups/rules/`、preview 分支 `backup-pre-preview-update-20261105`、tag `pre-import-history-deploy-20261105`。Pages 建置 `built`（`49eb867`），無頭瀏覽器載入 V1／V2 無新錯誤。**Production（master）未動**。⚠ preview 與正式站共用 Firestore `stsystem-9d5fe`，在 preview 操作即寫入正式資料。同日再同步至 `acc3e15`（修正雲端空課表時畫面殘留本機舊課表數字），Pages `built` 並 curl 確認上線 |
| 2026-09-10 | v1.13.8 / v2.0.0（開發中） | **Production（master）** 合併 `feature/permission-system`（merge `59647c7`）：登入初始化競態與 `initAuthService()` 重複掛監聽器兩項修復上線；其餘為 test/ 與 docs/，`index.html`、`firestore.rules` 未變動，線上 ruleset 沿用 `08bbfa7d`。另修 CI（`464e69c`）：test workflow 補 `npm install`，修復 `npm test` 找不到 papaparse。驗證：CI Test success、Pages deploy job success、線上 authService.js 已含 `ensureFirebaseReady`、瀏覽器實測正式站 console 無錯 |
