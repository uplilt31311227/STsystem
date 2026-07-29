---
created: 2026-03-12
updated: 2026-07-09
tags:
  - changelog
---

# 版本紀錄

---

## [2026-07-29]（feature/permission-system）UI 重規劃 Stage 0-1：design token 基座與手機硬傷急救

依 `docs/PLAN.md` 六階段 UI 重規劃計畫，完成 Stage 0（token 基座）與 Stage 1（硬傷急救），
兩階段各自獨立 commit、獨立驗證。

### 新增
- **`src/css/tokens.css`**：色彩／字級／間距／圓角／陰影／z-index 單一來源，13 個舊 CSS
  變數以相容別名對應；其中 5 個（success/warning/danger 色與 shadow/shadow-lg）因新舊值
  有可辨差異保留舊字面值，確保零視覺變動。`index.html` 兩份樣式表加 `?v=2.0.0` 版本參數。
- **`test/ui-rwd-check.mjs`**：375×667 手機橫向溢出檢查腳本，注入含長班級名/長科目/長教師
  名/長假別事由的種子紀錄後走訪課表匯入、調代課申請、調代課紀錄、月結算、設定，斷言
  `scrollWidth <= innerWidth`。

### 修復（手機硬傷急救）
- 全站 0 個 `overflow-x` 導致表格手機直接撐破：新增 `.table-wrap` 包住 7 處表格（教師屬性、
  調代課紀錄、月結算、科目領域對應、V2 教師管理／操作日誌／全校紀錄、調課預覽 inline 表）
- 課表格子 `overflow:hidden` 裁切內容看不到：`.schedule-cell` 補 `min-width:0` +
  `overflow-wrap:anywhere`（`.schedule-grid` 本身的 `overflow:hidden` 不動）
- flex 子項無法收縮撐破容器：`.form-group`／`.recommendation-info` 補 `min-width:0`；6 處
  操作列（推薦項目、操作按鈕列、modal 操作列、教師/課表編輯操作列、備份還原列）補
  `flex-wrap:wrap`；移除 `.form-group input/select/textarea` 的 `min-width:180px`（原本手機
  版另立 767px 媒體查詢覆蓋，會違反 tokens.css 自訂「僅 640/1024 兩個斷點」的紀律，直接
  刪除改正，桌機由既有 flex/width 撐版面不受影響）
- z-index 打架與右上角三個 fixed overlay 物理重疊：全面換用 tokens.css 分層變數
  （`--z-sticky/--z-veil/--z-modal/--z-authgate/--z-authmodal/--z-toast`），並修正 V2 登入
  modal 蓋住 toast 的既有問題；同步中斷徽章從右上角 fixed 移入 header 使用者資訊區
  （`.user-auth-section`）內排版顯示
- `updateTabLockStatus()`（app.js）直接寫 inline `style.opacity/cursor` 蓋掉新 CSS：改為
  `classList.toggle('is-locked', ...)`，鎖定條件不變

### 驗收缺陷修正（同一批次追加）
- **`test/ui-rwd-check.mjs` 空轉測試**：原始版本在全新 localStorage 下走訪，調代課紀錄表格
  從未渲染出真正會撐寬版面的內容，導致「修復前/修復後」皆 6/6 通過；改為先注入 6 筆長字串
  種子紀錄再斷言，真正驗證到橫向溢出防護
- **sync 徽章位移桌機版面**：插入 `.header-top`（`justify-content:space-between` 的 flex
  容器）會把使用者資訊區從右緣擠向中央；改插入 `.user-auth-section` 內部，並移除對 flex
  item 無效的 `display:inline-block`/`vertical-align:middle` 宣告
- 補齊 2 處漏改的 z-index：`v2-app.js` 匯入教師 followup toast（`showGoToTeacherAdminToast`）、
  `style.css` 死碼 `.modal-overlay`

## [2026-07-29]（feature/permission-system）商用上線實戰化

首次對 preview 站與 production Firestore 進行真實三角色端到端實測——此前所有「待實機驗收」項目從未執行。

### 修復（上線阻斷級）
- **approver 設定的學校名稱不回寫全校課表**：`canSwitchToTab` 同時要求課表與學校名稱，但 `setSchoolName` 不在 V2 的雲端回寫觸發白名單，導致全校教師登入後只能停在「課表匯入」頁、點其他頁籤毫無反應。上線首日必然發生。
- **多重調課全員同意在 UI 上永遠觸發不了**：`buildSwapRecord` 對單次與批次調課一律寫死 `isMultiSwap: true`，使 V2 詢問「其他教師一併同意」的守門條件恆假，Phase 3 的 multi_swap 狀態機成為死碼。改以 `batchId` 區分批次與單次。
- **V2 模式下月結算永遠是空的**：`addSubstituteRecord` 被 patch 成不寫本地陣列，但月結算的資料來源 `getSubstituteRecords` 從未被接管——教學組長每月的主要工作（代課鐘點費結算）在 V2 上線後做不了。

### 修復（權限與運維）
- 月結算頁籤與面板補 `v2-approver-only`：一般教師原本看得到全校結算並可匯出 Excel
- 運維腳本 `firestore-snapshot` / `firestore-health-check` 路徑寫死 `schools/default`，改為 `--school=` 參數（預設 `inhu`）——先前的健檢「全綠」一直是對舊備份學校的結果
- 健檢的驗證邏輯停留在 alpha schema（兩層角色、單一 pending 狀態），對齊三角色與 Phase 3 狀態機，並將測試資料降級為 INFO 獨立統計
- `firestore-bootstrap-inhu` 修 teacherId 顯示被截斷的 bug（照著輸出操作會拿到 permission-denied 並誤判為規則缺陷）

### 新增
- **Phase 4b 教師名單 CSV 批次匯入**：dryRun 預覽後才寫入，姓名重複轉更新、email 衝突與非法角色逐列報錯，同一份 CSV 重跑收斂為全略過（48 項測試）
- **Phase 5 V1 資料遷移**：偵測 Firestore 與 localStorage 兩來源、強制先下載 JSON 備份、冪等鍵防重複匯入、姓名反查補 teacherId、紀錄頁 legacy 徽章與篩選（58 項測試）
- **統一錯誤回饋層** `uiFeedback.js`：四個 Firestore 即時監聽補上錯誤處理（原本斷線或權限被撤時 UI 完全靜默）、18 處阻斷式 alert 收斂為 toast、Firebase 錯誤碼翻成繁中人話、同步中斷徽章
- **`test/v2-rules-matrix.mjs`**：26 案 allow/deny 安全矩陣（12 正向 + 14 攻擊），首次為 `firestore.rules` 建立自動化閘門，**首跑 26/26 全數符合預期，未發現規則缺陷**
- **`test/v2-approval-flows.mjs`**：三種審核流 + 中途拒絕的端到端腳本
- **CI**：`.github/workflows/test.yml` 於 push/PR 跑 41 項單元測試與全檔語法檢查

### 文件
- `V2_E2E_CHECKLIST.md` 整份重寫為 A–G 七組 47 項（原版停留在 admin/teacher 兩角色，驗不到現行功能）
- `PLAN_v2.0.0.md` 裁定 Phase 4 拆 4a/4b、Phase 6 統一定義、過時的延後項與 ruleset 參照更正
- 根目錄與 docs 的 CHANGELOG/README 同步、`V2_PERMISSION_SYSTEM.md` 更新為 v2.2 三角色、`DEPLOYMENT.md` 修正自相矛盾的版本號
- 新增 `V2_ROSTER_CSV.md` 與範例 CSV

### 待決策（未修改，見 ISSUES_LOG）
- 全校調代課紀錄與待審請求在 `firestore.rules` 為任何登入者可讀，過濾僅在前端——教師可用 DevTools 讀到全校病假／喪假等敏感個資。收緊需同步改客戶端查詢與規則，屬架構級變更
- production 存在兩筆重複的主任教師檔（bootstrap 競態產生，其一為零引用孤兒）

---

## [2026-07-09]（feature/permission-system）

### 新增
- **V2 Phase 3 三種審核流程分支**（PLAN_v2.0.0.md §5 Phase 3 全項）：
  - 申請分流：代課（substitute）直接進組長核准；調課（swap）先對方同意再核准；多重調課（multi_swap）全員同意才進核准，任一人拒絕整批 rejected
  - 核准改為 approver（主任/組長）專用，`runTransaction` 原子完成「建紀錄 + 更新請求 + 寫日誌」；並發核准後到者顯示「已被處理」
  - UI 三段式：「待我同意」（swap / multi_swap 分列）、「待我審核」（approver 專用含數量徽章）、「我的申請」（含對象顯示與駁回 dismiss）
  - PDF 改於核准成功後產生（原為同意當下）
  - 舊 alpha 期 `status='pending'` 文件讀取期自動映射，免遷移

### 安全
- `firestore.rules` 收緊（§0.5 延後項全數完成 + 多輪對抗驗收發現）：
  - `substituteRecords` create 封掉教師自寫「已核准」紀錄；自我調課快速路徑鎖 type 與三個 teacherId 欄位，杜絕灌代課費
  - `pendingRequests` create 強制狀態機初始狀態、同意名單非空且不含發起人、禁止預填核准欄位
  - `pendingRequests` update 加 affectedKeys 欄位白名單（申請內容 create 後不可改）、status 轉換限制、approver 與同意人分支雙終態鎖（approved/rejected 不可復活）
  - requiredApproverId 相容條款收緊為僅 legacy 文件適用，已同意者不得再取得 update 權
  - `isValidRoleValue()` 接入 teachers create/update，杜絕列舉外 role
- 修復致命 bug：駁回操作因資料層自動注入 `updatedAt` 違反規則白名單而全面 permission-denied（改交易直寫）

### 重構
- 刪除死碼 `canApprove` 與 `REQUEST_STATUS.CANCELLED`；`genId` 匯出重用；pending 快取統一 normalize；`listTeachers` 單次化；核准後三個獨立 await 平行化

---

## [2026-07-06]（feature/permission-system）

### 新增
- **V2 P2 全校課表共享**：approver 上傳/編輯課表即時同步全校教師（commit 614e4ff）

### 安全
- 登出後以遮罩 + inert 鎖定整個 app，杜絕未登入操作月結算與報表下載（詳見 ISSUES_LOG 2026-07-06）
- 修補同頁切換身份的權限殘留與跨身份資料外洩（2026-07-05）

---

## [2026-06-15]

### 新增
- **九年級畢業停用課程**：設定頁新增「九年級已畢業」開關，停用九年級（9年X班/九年X班/9XX）課程，讓這些時段老師可正常被安排調代課，不被已畢業班級的課擋住。資料保留可還原，狀態同步雲端。影響代課推薦與所有衝堂判斷；月結算/PDF 維持原始課表保留歷史。詳見 root `CHANGELOG.md` 與 `docs/PLAN_grade9_graduation.md`。

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

## 進行中

| 版本 | 期間 | 內容 |
|------|------|------|
| v2.0.0 規劃 | 2026-05-29 ~ | 多角色協作（教務主任 / 教學組長 / 一般教師）+ 發起→同意→核准工作流。詳見 [PLAN_v2.0.0.md](./PLAN_v2.0.0.md)。master 維持 v1.11.0 給學校現場使用，所有開發在 `feature/permission-system` 分支。tag `v1.11.0-stable` 可隨時回滾。 |

## 版本摘要

| 版本 | 日期 | 重點變更 |
|------|------|----------|
| v2.0.0-alpha (feature branch) | 2026-04-20 ~ 持續 | 多角色權限系統：三層角色（主任/組長/教師）、email 登入、調課同意流程、操作日誌、Firestore 規則 v2.2、部署/健康檢查腳本 + E2E checklist（見 `docs/V2_PERMISSION_SYSTEM.md` / `PLAN_v2.0.0.md`）。已於 2026-06-18 合併 master 取得 v1.13.x |
| v1.13.2 | 2026-06-18 | 雲端翻轉「九年級已畢業」開關時即時重繪推薦/調課面板 + 即時同步監聽器洩漏修正 |
| v1.13.1 | 2026-06-18 | 修復 `esc is not defined` 導致正式站初始化中斷（Google 登入 / 雲端同步全失效） |
| v1.13.0 | 2026-06-15 | 科目領域對應表：匯入自動擷取「科目→領域」、課表編輯下拉自動帶領域 + 午休間隔橫列 |
| v1.12.0 | 2026-06-15 | 九年級畢業停用課程：設定頁「九年級已畢業」開關，停用 9年X班 課程讓調代課不被已畢業班級擋住；月結算/PDF 維持原始課表保留歷史 |
| v1.11.0 | 2026-05-20 | 週彙整通知單：一鍵產整週綜合 PDF，教學組裁切後分送各方，紙張大幅精簡 |
| v1.10.0 | 2026-05-20 | 衝突檢查強化：推薦引擎排除已派代課教師、送出前衝堂攔截、課表上傳班級衝突檢查 |
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
