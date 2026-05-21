---
created: 2026-03-12
updated: 2026-05-20
tags:
  - changelog
---

# 版本紀錄

---

## [2026-05-20]

### 安全
- `app.js` 補上 11 處遺漏的 `esc()` 包裹（5/19 宣稱「全面包裹」但仍有殘留）：
  - `slotAInfo` 時段 A 摘要（日期 / 星期節次 / 班級 / 原任課教師）
  - `swapDateHint` 調課對應星期提示
  - `swapCourseSelect` option 與「沒有課程可調換」訊息
  - 可互換 / 衝堂課程 option label 與 hint 訊息
  - 「請選擇 XX 的日期」提示、「日期不符」警告、「日期已選定」確認
  - `class-datalist` 班級 option value
- `firebaseConfig.js` 補上註解：API key 為 client-side 公開 key，需在 Cloud Console 設定 HTTP referrer 限制（`uplilt31311227.github.io/*`）為主要防濫用機制

---

## [2026-05-19]

### 安全
- `app.js` 新增 `esc()` HTML 跳脫 helper，全面包裹所有 `innerHTML` 模板字面量，防止 XSS
- `firestore.rules` `operationLogs` 集合新增 schema 欄位驗證，限制寫入欄位與資料型別
- `firestore.rules` `operationLogs` 讀取限制為 admin-only，禁止一般使用者查閱操作日誌
- `firestore.rules` `operationLogs` 禁止 update / delete 操作，確保日誌不可竄改

### 變更
- `pyproject.toml` pandas 版本約束從 `>=3.0.1` 修正為 `>=2.2,<3`（3.x 尚無正式 release）
- **需執行 `firebase deploy --only firestore:rules`** 以套用新 Firestore 安全規則

---

> 完整版本紀錄請參考專案根目錄的 [CHANGELOG.md](../../CHANGELOG.md)

## 版本摘要

| 版本 | 日期 | 重點變更 |
|------|------|----------|
| v2.0.0-alpha2 (feature branch) | 2026-04-29 | Firestore 規則 v2.1（角色判讀）+ 部署 / 健康檢查腳本 + E2E checklist |
| v2.0.0-alpha (feature branch) | 2026-04-20 | 組長權限系統、教師 email 登入、調課同意流程、操作日誌（見 `docs/V2_PERMISSION_SYSTEM.md`） |
| v1.11.0 | 2026-05-20 | 週彙整通知單：一鍵產整週綜合 PDF + 半頁拼接版型優化（合併自 master） |
| v1.10.0 | 2026-05-20 | 衝突檢查強化：推薦引擎排除已派代課教師、送出前衝堂攔截、課表上傳班級衝突檢查（合併自 master） |
| v1.9.0 | 2026-04-13 | 全站緊湊布局改造、Toast 通知系統、資料備份還原 |
| v1.8.0 | 2026-04-10 | 多重調課批次、任教領域編輯、衝突檢查 |
| v1.7.0 | 2026-04-09 | 教師課表手動編輯 |
| v1.6.0 | 2026-03-27 | 多節課調代課模式 |
| v1.5.0 | 2026-03-25 | 登入資料同步智慧判斷、PDF 優化 |
| v1.4.0 | 2026-03-24 | Firebase 雲端同步（取代 Google Sheets） |
| v1.3.3 | 2026-03-23 | PDF 黑白列印優化、各聯差異化 |
| v1.3.2 | 2026-03-17 | 資料匯入功能 |
| v1.3.1 | 2026-03-16 | 調課日期分離、課表異動標示修復 |
| v1.3.0 | 2026-03-16 | 全新步驟式調代課申請介面 |
| v1.2.0 | 2026-03-13 | PDF 四聯單改版、學校名稱設定 |
| v1.1.0 | 2026-03-12 | 設定頁籤、紀錄查詢、月結算優化 |
| v1.0.0 | 2026-03-12 | 初始版本 |
