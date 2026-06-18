---
created: 2026-04-10
updated: 2026-06-18
tags:
  - issues
  - troubleshooting
---

# 問題追蹤：國中調代課自動化系統

## 狀態說明

| 狀態 | 說明 |
|------|------|
| 🔴 待處理 | 已發現但尚未開始處理 |
| 🟡 處理中 | 正在調查或修復 |
| 🟢 已解決 | 已找到解決方案並修復 |
| ⚪ 設計權衡 | 因架構演進已不再相關，由新版本取代 |

---

## 雲端翻轉「九年級已畢業」開關時，已開啟的推薦/調課面板不即時重繪

- **日期**: 2026-06-18
- **狀態**: 🟢 已解決（v1.13.2）
- **描述**: 他機翻轉「九年級已畢業」開關後，本機即時同步雖更新記憶體資料，但已開啟的「代課推薦／調課互換」面板與課表灰底維持舊狀態，需手動重新觸發才更新。為 HANDOVER_2026-06-15.md 列出的未完成項。
- **原因**: realtime 路徑為 `onSnapshot → loadFromCloud → notifyDataChange → onDataChange 監聽器`，而該監聽器只做 `syncToCloud()`、不刷新任何 UI。`refreshUIAfterSync()`（下載/合併路徑）也只更新開關勾選框、未重繪面板與灰底。另查出 `handleGrade9Toggle()` 呼叫的 `renderEditorSchedule()` 方法不存在（latent bug），以及 `enableRealtimeSyncAndListen()` 每次呼叫都重複註冊監聽器（洩漏）。
- **解決方案**: 即時同步監聽器加開關狀態比對、翻轉時自動 `syncGrade9Toggle()` + 共用方法 `refreshGrade9DependentUI()` 重繪；`refreshUIAfterSync()` 末端一併呼叫；修正方法名為 `renderEditableScheduleGrid()`；以 `_dataChangeListenerBound` 旗標確保監聽器僅註冊一次。
- **驗證**: `test/test-grade9-refresh.mjs`（11 項）+ `test/test-grade9.mjs`（18 項回歸）通過；`node --check` 語法通過；high-effort 多 agent code review。
- **相關檔案**: `src/js/app.js`（`enableRealtimeSyncAndListen` ~362、`handleGrade9Toggle`/`refreshGrade9DependentUI`/`refreshActiveSubstitutePanels` ~3892、`refreshUIAfterSync` ~557）

---

## 正式站初始化中斷：esc is not defined（Google 登入／雲端同步全失效）

- **日期**: 2026-06-18
- **狀態**: 🟢 已解決（v1.13.1）
- **描述**: 正式站開啟後 JS 初始化即拋出 `ReferenceError: esc is not defined`（`app.js:3782`），`window.app` 未建立、`window.firebaseModules` 為 false。Google 登入按鈕顯示但無作用、雲端同步完全失效、localStorage 既有資料未載入。實機煙霧測試（CDP/puppeteer 連線正式站）確認。
- **原因**: v1.13.0「科目領域對應表」的 `renderSubjectDomainTable()` 以 template literal 呼叫 `esc()` 做 HTML 跳脫，但 `esc()` 從未在 `app.js` 任何處定義。此函式在 `bindDataManagementEvents()` 內被無條件呼叫，且位於 `init()` 中 `initFirebase()`（行 104）之前（行 90），建構子拋例外後整個 `init` 中止，行 90 之後的綁定/初始化全部未執行。當時 code review 僅跑 Node 單元測試、未實際渲染 DOM，故未攔截。
- **解決方案**: 於 `src/js/app.js` 模組層新增 `esc(value)` HTML 跳脫工具函式（`& < > " '` → HTML 實體，null/undefined 回空字串）。
- **驗證**: 本機 `http.server` + 瀏覽器（CDP）重測，無 `PAGEERROR`，初始化日誌完整輸出「Firebase 初始化成功／完成」、`window.app` 與 `firebaseModules` 皆正常，登入按鈕恢復綁定。
- **相關檔案**: `src/js/app.js`（esc 定義；renderSubjectDomainTable `app.js:3759`）

---

## 九年級畢業後課程擋住調代課

- **日期**: 2026-06-15
- **狀態**: 🟢 已解決（v1.12.0）
- **描述**: 九年級學生畢業後，課表上仍保留「9年X班」課程，導致原任課老師在該時段被判定為忙碌，無法被推薦/安排代課，也造成調課衝堂誤判——調代課被不須上的課程擋住。
- **原因**: 所有教師空堂/衝堂判斷皆以完整 `scheduleData` 計算，未排除已畢業班級的課程。
- **解決方案**: 新增「九年級已畢業」手動開關（`settings.grade9Disabled`，持久化至 localStorage 與 Firebase）。開啟後以班級名稱前綴（9年X班/九年X班/9XX）判定九年級，提供 `getActiveScheduleData()` 回傳排除九年級的有效課表，並套用於所有調代課可用性計算：代課推薦、`getBusyTeachers`、`checkSubstituteTeacherConflict`、單次調課（`updateSwapCourseListForDate`）、批次調課（`checkBatchConflicts`）。月結算與 PDF 維持原始課表以保留歷史。資料保留可隨時還原。
- **驗證**: `test/test-grade9.mjs` 18 項單元測試通過；瀏覽器手動驗收。
- **相關檔案**: `src/js/modules/dataManager.js`、`src/js/app.js`、`index.html`、`src/css/style.css`、`docs/PLAN_grade9_graduation.md`

---

## 設計權衡與升級紀錄

### v1.11.0 單使用者資料隔離模型

- **日期**: 2026-05-29
- **狀態**: ⚪ 設計權衡（由 v2.0.0 多角色架構取代）

**背景**：
v1.x 系列把所有資料隔離在 `users/{uid}/data/substituteSystem`，每位 Google 登入者各有一份。當系統由「教學組長一人用」擴展為「全校教務主任 / 組長 / 一般教師共用」時，此模型造成資料無法共享、無審核流程、無權限分級。

**升級方向**：
v2.0.0 改採 `schools/{schoolId}/...` 共享路徑 + 三層角色 + 發起→同意→核准工作流。詳細規劃見 [PLAN_v2.0.0.md](./PLAN_v2.0.0.md)。

**回滾路徑**：
master 維持 v1.11.0 不動，tag `v1.11.0-stable` 可隨時 `git checkout v1.11.0-stable` 回到升級前狀態。GitHub Pages 部署來源若需切回單使用者版本，僅需將 Pages source 指向 master 即可。

---

## 九年級畢業後課程擋住調代課

- **日期**: 2026-06-15
- **狀態**: 🟢 已解決
- **描述**: 九年級學生畢業後，課表上仍保留「9年X班」課程，導致原任課老師在該時段被判定為忙碌，無法被推薦/安排代課，也造成調課衝堂誤判——調代課被不須上的課程擋住。
- **原因**: 所有教師空堂/衝堂判斷皆以完整 `scheduleData` 計算，未排除已畢業班級的課程。
- **解決方案**: 新增「九年級已畢業」手動開關（`settings.grade9Disabled`，持久化至 localStorage 與 Firebase）。開啟後以班級名稱前綴（9年X班/九年X班/9XX）判定九年級，提供 `getActiveScheduleData()` 回傳排除九年級的有效課表，並套用於所有調代課可用性計算：代課推薦、`getBusyTeachers`、`checkSubstituteTeacherConflict`、單次調課（`updateSwapCourseListForDate`）、批次調課（`checkBatchConflicts`）。月結算與 PDF 維持原始課表以保留歷史。資料保留可隨時還原。
- **驗證**: `test/test-grade9.mjs` 18 項單元測試通過；瀏覽器手動驗收。
- **相關檔案**: `src/js/modules/dataManager.js`、`src/js/app.js`、`index.html`、`src/css/style.css`、`docs/PLAN_grade9_graduation.md`

---

## V2 權限系統（feature/permission-system）已知限制與待辦

### Firestore 規則由「測試版（任何登入者皆可讀寫）」收緊為 v2.1

- **日期**: 2026-04-29
- **狀態**: 🟢 規則撰寫完成；部署需手動執行 `node scripts/firestore-deploy-rules.js`
- **描述**: V2 alpha 初版的安全規則僅檢查 `request.auth != null`，任何登入者都能改 schools/default 任意資料。雖然 schools 路徑不影響穩定版 master，但偽造請求即可越權。
- **解決方案**: 重寫 `firestore.rules` 加入 `isAdmin(schoolId)` / `myTeacherId` helper：
  - admin 由 `config.initialAdminEmails` 白名單或 `teachers/{tid}.role=='admin'` 判定
  - 教師寫 pending 強制 `initiatedBy == 自己`，更新限 `requiredApproverId`
  - 同意人寫 substituteRecord 強制 `approvedBy/requiredApproverId == 自己`，admin 編輯／刪除
  - userMappings 自己讀寫自己；operationLogs 任何登入者可寫不可改/刪
- **驗證**: 走完 `docs/V2_E2E_CHECKLIST.md` 情境 6（規則層權限攻擊測試）
- **相關檔案**: `firestore.rules`、`scripts/firestore-deploy-rules.js`、`scripts/firestore-health-check.js`、`docs/V2_E2E_CHECKLIST.md`、`docs/V2_PERMISSION_SYSTEM.md`

### V2 原「調代課紀錄」頁籤不顯示

- **日期**: 2026-04-20
- **狀態**: 🟢 已解決
- **描述**: V2 模式下 `dataManager.addSubstituteRecord` 被 patch 為不寫 local；原頁籤的本地紀錄表格會空。
- **解決方案**: V2 啟用時由 CSS 隱藏 `#records-tab > #records-no-data` 與 `#records-content`，V2 全校紀錄區塊改為頁籤主內容，避免空表格混淆。feature branch 獨立部署，不合併回 master，因此無需保留原表格。
- **相關檔案**: `src/js/v2-app.js` injectV2Styles / renderRecordsTab

### V2 衝堂檢查暫失效

- **日期**: 2026-04-20
- **狀態**: 🟢 已解決
- **描述**: 原 `checkExistingRecord` 查 local 陣列；V2 下 local 為空，無法檢測 V2 中已存在的調代課。
- **解決方案**: v2-app.js 建立同步 cache (`_v2RecordsCache` / `_v2PendingCache`)，由 onSnapshot 即時更新；`patchDataManager` 替換 `checkExistingRecord`，在 V2 模式下查詢 cache 而非 local 陣列；pending 也視為衝突（排除 rejected）。
- **相關檔案**: `src/js/v2-app.js` v2CheckExistingRecord / patchDataManager

---

## 已解決的問題

### Firestore 初始管理員設定與安全規則

- **日期**: 2026-04-20
- **狀態**: 🟢 已解決

**問題描述**：V2 權限系統需要兩項初始設定才能運作：
1. Firestore `schools/default/config/main` 文件（含 initialAdminEmails）
2. Firestore 安全規則允許 `schools/{schoolId}/` 讀寫（原規則僅涵蓋 `users/{uid}/`）

**解決方案**：使用 gcloud access token + Firestore / FirebaseRules REST API：

```bash
# 1. 建立 config 文件
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  ".../documents/schools/default/config/main" \
  --data-binary "@_firestore_init.json"

# 2. 建立並發布 ruleset
curl -X POST ".../rulesets" -d '{"source":{"files":[...]}}'
curl -X PATCH ".../releases/cloud.firestore" \
  -d '{"release":{"name":"...","rulesetName":"..."},"updateMask":"rulesetName"}'
```

**相關檔案**：`firestore.rules`（已提交）、`docs/V2_PERMISSION_SYSTEM.md`

### PDF 生成與 V2 pending 狀態

- **日期**: 2026-04-20
- **狀態**: 🟢 已解決（策略變更：pending 完全不產 PDF）

**原問題**：V2 教師發起後立即產生 PDF，但紀錄尚未成立（等對方同意），容易誤導使用者。

**最終決策**：
不再走「pending 加浮水印」方案。改為**同意前完全不產 PDF**：
- 教師發起 → pending，僅送出即時通知，不產 PDF
- 對方同意 → 正式成立 + 同意方當場下載 PDF
- 對方拒絕 → 不產 PDF，發起人可在「我已發起」看到「❌ 被拒絕」提示
- 組長代發起 / 自我調課 → 跳過同意流程，即時產 PDF（維持原行為）
- 紀錄列表新增「下載 PDF」按鈕，發起人可事後補下載

**相關檔案**：
- `src/js/modules/v2/pendingRequestService.js`（rejectRequest 改 soft-reject、新增 dismissRejectedRequest）
- `src/js/modules/v2/schoolDataService.js`（新增 updatePendingRequest）
- `src/js/v2-app.js`（v2NeedsApproval / patchPdfGenerators / approve 產 PDF / rejected 顯示 / 下載 PDF）

### 調代課紀錄查詢日期比較問題

- **日期**: 2026-03-27
- **狀態**: 🟢 已解決

**問題描述**：
調代課紀錄查詢時日期比較邏輯有誤，導致無法正確篩選特定日期的紀錄。

**解決方案**：
修復日期比較邏輯。

**相關 Commit**：
`4272740` - fix: 修復調代課紀錄查詢日期比較問題

---

### nul 檔案殘留

- **日期**: 2026-04-10
- **狀態**: 🟢 已解決

**問題描述**：
專案根目錄存在一個 0 byte 的 `nul` 檔案，為 Windows 系統誤建。

**解決方案**：
刪除 `nul` 檔案並加入 `.gitignore`。
