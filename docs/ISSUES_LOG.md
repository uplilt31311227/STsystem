---
created: 2026-04-10
updated: 2026-05-29
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

## 已解決的問題

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
