# 版本紀錄 (Changelog)

## [2026-07-30]（feature/permission-system）UI 重規劃 Stage 5：操作邏輯統一

依 `docs/PLAN.md` Stage 5，統一 5 種回饋機制（alert/confirm/prompt/toast/notify）並拆解批次送出鈕的雙重語意。獨立 commit、獨立驗證。

### 新增（A. 統一 confirm modal）
- `app.js` 新增 `confirmDialog({title, message, confirmText, cancelText, danger}) → Promise<boolean>`：單例（重複呼叫時前一個以 `resolve(false)` 關閉）、danger 時確認鈕掛 `.btn-danger` 否則 `.btn-primary`、點背景＝取消（跟 `course-edit-modal`／`record-detail-modal` 等既有 modal 一致；全站無 Esc 關閉慣例，故未新增 Esc 處理）
- `index.html` `#modal-root` 內新增靜態 `#confirm-modal`（`.modal>.modal-content>header/body/actions`，與現有 modal 結構一致）
- 取代 `app.js` 全部 11 處與 `v2-app.js` 全部 4 處原生 `confirm()`（含 `clearLocalData()` 兩層巢狀確認、`showMergeConfirmModal()` 的 `!modal` 防禦分支）。`alert()` 兩檔皆為 0 處（已無殘留）

### 新增（B. 殺 prompt()）
- `v2-app.js` 新增 `promptRejectReason()`（拒絕原因 textarea modal）與 `promptNewTeacherModal()`（新增教師姓名＋Email 雙欄位 modal），沿用檔內既有 `promptAdditionalConsentTeachers()`／`openAuthModal()` 的動態掛載 modal 慣例
- 拒絕原因刻意區分「取消」與「確定但留空」：取消／點背景 `resolve(null)` 中止拒絕動作；舊版 `prompt()` 不論取消或確定留空都會以空字串繼續執行拒絕，屬順手修正的行為收斂（非新增業務判斷）
- 取代 `v2-app.js` 全部 3 處原生 `prompt()`

### 新增（C. 移除假儲存鈕，F7）
- 移除 `#save-data-btn`（教師屬性表本就 change 即存，`saveDataManually()` 除呼叫 `saveDataToStorage()` 外只更新旁邊 `#save-status` 提示文字，無其他副作用），原位置改靜態文字「變更即時自動儲存」（沿用既有 `.hint` class，即任務所指「`.text-muted` 級樣式」在本專案的對應命名）
- `test/v2-approval-flows.mjs` 同步移除對已刪除按鈕的引用（原步驟 3c 會檢查其可見性並點擊驗證無生產環境寫入），避免既有 e2e 腳本因元素消失而卡死

### 新增（D. V2 紀錄頁補篩選＋週彙整入口，F1 方式）
- `v2-app.js` `renderRecordsTab()` 新增起訖日期＋教師 select 過濾（沿用 `.toolbar-row`/`.form-group-inline` 既有元件 class），過濾對象是函式內已經過權限過濾的 `visible` 集合，不觸碰 `dataSvc.listSubstituteRecords()` 資料層；教師選項取自 `visible` 內出現過的姓名，不另外呼叫 `listTeachers()`
- 新增「📄 列印本週彙整」鈕（`.v2-approver-only` 顯隱），呼叫既有 `window.app.openWeeklySummaryModal()`；確認 V2 下 `dataManager.getSubstituteRecords()` 已被 patch 為讀 `_v2RecordsCache`，PDF 彙整會拿到正確的即時同步資料

### 新增（E. 批次機制 UI 統一四動作，含 R2 安全關鍵）
- `index.html` `#confirm-substitute-btn` 旁新增 `#add-to-batch-btn`（初始 `.hidden` class，非原計畫草案的原生 `hidden` 屬性——`.btn{display:inline-flex}` 是一般優先度的作者樣式，會贏過瀏覽器對 `[hidden]` 的預設值，若照草案字面實作按鈕不會真的被隱藏；沿用全站既有 `.hidden{display:none!important}` 慣例才是有效寫法）
- `app.js` 新增 `setSubmitButtonMode(isBatch)` 統一 toggle 兩顆鈕的 `.hidden`，取代原本 4 處（非 3 處——多一處在 `resetSubstituteFlow()`）改寫 `#confirm-substitute-btn.textContent` 的寫法
- **[R2 致命·安全]** `v2-app.js` `interceptSubmitButton()` 改為對 `['confirm-substitute-btn', 'add-to-batch-btn']` 兩個 id 迴圈攔截，與新增按鈕同一 commit
- **[F4]** `onChangeTypeSelected(type)`：非代課（調課/多重調課皆走 `type==='swap'`）時隱藏 `.multi-course-toggle` 整個容器；若切換當下 `isMultiCourseMode` 仍為真，連帶 `checked=false` 並呼叫既有 `onMultiCourseModeToggle(false)` 清理路徑（不改 `confirmMultiCourseSubstitute()` 本身的 guard）
- 文案：「多節課模式」→「一次選多節（同一天）」（含 toggle 標籤與旁邊 hint 說明文字、`onMultiCourseModeToggle()` 內停用調課選項時的 tooltip）；`#multi-swap-batch-panel` 標題「多重調課批次」→「待送出的調課組合」
- `test/v2-approval-flows.mjs` 新增步驟 3d：教師甲把「原任課教師」選為教師乙（非本人）、切多重調課後點 `#add-to-batch-btn`，斷言 toast 出現攔截訊息且 `pendingRequests` 筆數未增加

### 新增（F. 手機 toast 遮 modal 關閉鈕）
- `index.html` `#course-edit-modal` 新增 `#course-modal-msg`（沿用既有 `.form-msg`/`.form-msg.error` class，非新命名）；`editorSaveCourse()` 兩處班級/科目驗證改寫入此元素而非 `showToast()`
- 訊息 3 秒自動清除、任一欄位下次輸入時清除、modal 開啟/關閉時清除（`openCourseEditModal()`/`closeCourseEditModal()`）

### 變更
- CSS 版本號 `?v=2.4.1` → `?v=2.5.0`

### 驗證
- `npm run check`（27/27）、`node test/v2-smoke-test.js`、`node test/ui-rwd-check.mjs`（7/7 無橫向溢出）、`npm test`（41/41）全數通過
- `grep -n "\balert(\|\bconfirm(\|\bprompt(" src/js/app.js src/js/v2-app.js` 只剩 3 處文件註解（描述被取代的舊機制），無任何實際呼叫殘留
- 另寫一次性 Playwright 腳本（未進 repo，跑完即刪）驗證 21 項斷言全數通過：教師表 change 即存且重整後保留、無 `#save-data-btn`；多重調課模式下加入批次鈕獨立可見/主送出鈕隱藏，切回代課後反轉且 `.multi-course-toggle` 恢復可見，調課模式下 toggle 確認消失；刪除紀錄跳出 `#confirm-modal`（非原生 dialog）、取消不刪、確認才刪；`editorSaveCourse()` 空班級時 `#course-modal-msg` 顯示紅字、無全域 toast 產生、modal 不被誤關閉
- 額外以 Playwright 檢查 `?v2=1` 下 `#add-to-batch-btn`／`#confirm-substitute-btn` 皆存在於 DOM 且無 console 錯誤（靜態驗證 `interceptSubmitButton()` 攔截清單可正確找到兩顆按鈕；R2 情境的完整權限攔截需要真實 Firebase 測試帳號，另補於 `test/v2-approval-flows.mjs` 步驟 3d，未實跑）

### 已知取捨
- R11 豁免清單：無。app.js 11 處＋v2-app.js 4 處 confirm()，逐處檢查呼叫端後全數確認可安全 async 化——要嘛呼叫端本身已在 async context 內（如 `confirmSubstitute()`、v2 各按鈕的 `async () => {}` click listener），要嘛是單純 fire-and-forget 的 click 綁定、沒有任何呼叫端依賴同步回傳值（`showMergeConfirmModal()` 的呼叫點在呼叫後立即 `return`，改 async 不影響時序）
- `saveDataManually()`（`app.js`）與 `#save-status`（`index.html`）移除按鈕後成為無呼叫點的死碼，比照 Stage 4 對 `onTeacherSelected()` 的處理方式，留待 Stage 6 死碼清理一併處理，不在本輪個別刪除
- `#change-type` 隱藏 select 未動（計畫列為 Stage 6 選配項目）

## [2026-07-29]（feature/permission-system）UI 重規劃 Stage 4 驗收缺陷修正

派獨立 agent 驗收 Stage 4（commit `8d0acb8`，手機專屬模式）後回報的 5 項缺陷，全數修復，獨立 commit、獨立驗證（含 playwright 量測，前後對照見下方驗證段落）。

### 修復（中）
- **桌機表格操作欄 padding 退化**：`components.css` 640+ 層 `.data-table-cards td.cell-actions{padding-top:var(--sp-3)}` 與 `.data-table-compact.data-table-cards td{padding:.35rem var(--sp-2)}` 特異度同為 (0,2,1)，因載入順序在後蓋掉緊湊版的 0.35rem，5 張卡片化表格在桌機每列高度多出來、操作欄按鈕比同列 input 低。補一條 3-class 選擇器 `.data-table-compact.data-table-cards td.cell-actions{padding-top:.35rem}` 還原，特異度較高不受載入順序影響
- **手機 toast 蓋住 sticky action bar 送出鈕**：`#toast-container` 手機層改由 `top` 定位（`calc(var(--sp-4) + env(safe-area-inset-top))`），不再 `bottom` 釘底，避開申請頁步驟四 sticky action bar；640+ 桌機層明確補 `top:auto` 並保留原本右下角定位（避免同時吃到手機層 `top` 與桌機 `bottom` 兩個值，把 `position:fixed` 容器撐開拉伸）

### 修復（中低）
- **九年級開關路徑弄掉單日檢視**：`refreshGrade9DependentUI()` 原呼叫 `renderTeacherSchedule()`（`highlightWeekday=null`），會把申請頁課表的 `.schedule-grid-single` toggle 掉、當日高亮全失（手機下可見格數 16→48）。改呼叫 `showScheduleForDate(teacherName, subDate)` 保留 highlight 上下文；`sub-date` 尚未填寫時維持原本呼叫（`showScheduleForDate()` 對空日期不會拋錯，但會清空 `#selected-weekday` 且無條件顯示步驟三，等於在背景同步事件裡強行推進使用者流程，故加 guard 避免）

### 修復（低）
- **月結算表 sticky 首欄無效**：`.data-table{width:100%}` 讓表格壓到跟 `.table-wrap` 一樣窄（手機下永遠不會超出容器、表頭文字被迫斷成三行），sticky 首欄沒有橫捲可倚靠、視覺上完全無效。`features.css` 手機層補 `#settlement-table{min-width:640px}` 強制撐開表格，640+ 桌機寬度本來就超過 640px 不需另外還原
- **selection-tray 巢狀層級不一致**：批次調課清單的 `.selection-tray-header` 原本是 `#batch-swap-list` 的兄弟節點（浮在容器外，父層只是普通 `.card`），與「已選課程」tray（header 在 `.selection-tray` 容器內）不一致。`index.html` 新增外層 `.batch-swap-container.selection-tray` 包住標題列與 `#batch-swap-list`，巢狀層級與「已選課程」（`#selected-courses-list` 包住 header 與 `#selected-courses-chips`）一致；`#batch-swap-list` id、內部結構（`renderSwapBatch()` 的 innerHTML 綁定與內容）完全不動，原本掛在它身上的 `.selection-tray` 樣式與 `margin` 改由新外層 `.batch-swap-container` 承接（避免 `#batch-swap-list` 同時吃外層 padding 與自己的 margin，造成雙倍留白）

### 變更
- CSS 版本號 `?v=2.4.0` → `?v=2.4.1`

### 驗證
- `npm run check`（27/27）、`node test/v2-smoke-test.js`、`node test/ui-rwd-check.mjs`（7/7 無橫向溢出）、`npm test`（41/41）全數通過
- 另寫一次性 Playwright 腳本（未進 repo，跑完即刪）逐項量測 11 個斷言，並用 `git stash` 對照修復前（Stage 4 原始 commit）跑同一批量測，前後數字對照：
  - 桌機 1440：教師表列高 43.2px（緊湊水準）；刪除鈕與同列 input 垂直置中差 **0.00px**（修復前 3.20px）
  - 手機 375：toast 改置頂後 `top:16~bottom:132`，與 sticky action bar（`top:464~bottom:533`）明確不相交；修復前兩者僅相距 ~2px（`535` vs `533`），屬脆弱的擦邊不重疊，非穩固修復
  - 手機 375：呼叫 `window.app.refreshGrade9DependentUI()` 後 `.schedule-grid-single` 維持 `true`、可見格數維持 16/48 不變（修復前會變成 `false` 與 48/48，即單日檢視整個回退成整週）
  - 手機 375：`#settlement-table` 的 `.table-wrap` 橫向捲動 `scrollWidth 640 > clientWidth 303`、橫捲到底後首欄仍貼左（sticky 生效）、表頭列高回到 32.5px（修復前 `scrollWidth===clientWidth===303` 完全無法橫捲、表頭列高 74.1px 即「一字斷三行」）
  - selection-tray 結構比對＋截圖：批次調課 tray 的 `#batch-swap-list` 父層 class 修復前為 `"card"`（`batchParentHasTray:false`），修復後為 `"batch-swap-container selection-tray"`（`batchParentHasTray:true`），與「已選課程」tray 巢狀層級一致；`#batch-swap-list` 的 id 與 `renderSwapBatch()` 綁定目標全程不變

### 已知取捨
- `onTeacherSelected()`（`app.js:1724`）確認為死碼（全域無呼叫點），本次未刪，記入 `docs/ISSUES_LOG.md` 的「Stage 6 死碼待刪清單」，留待 Stage 6 統一處理

## [2026-07-29]（feature/permission-system）UI 重規劃 Stage 4：手機專屬模式

依 `docs/PLAN.md` Stage 4，補齊手機場景的三個重點：表格卡片化、課表單日檢視、modal 全螢幕；並順手修掉上輪驗收遺留的 2 個小缺陷。獨立 commit、獨立驗證。

### 前置小修（上輪複驗遺留）
- **`#google-signin-btn` 缺 `.btn` 基底**：Stage 3 收斂後這顆按鈕只掛 `.btn-google-signin`，沒有 `.btn`，桌機下沒有 `border-radius`（`.btn-google-signin` 自己從未定義圓角，圓角只在 `.btn`）。`index.html` 補回 `class="btn btn-google-signin"`
- **3 處 `display:revert`／`padding:revert` 換明確值**：`revert` 會整個跳過所有 author 層規則直接退回瀏覽器原生樣式，不是退回「下一條較低優先度的 author 規則」——`.btn-google-signin{padding:revert}` 若疊在新補上的 `.btn` 之上，會跳過 `.btn` 的 `padding` 直接吃瀏覽器原生 button padding，而非期待中的 `.btn` padding。`components.css`（`.btn-google-signin span`／`.btn-google-signin` padding）與 `base.css`（`.user-name`）三處改為明確值（`display:inline`／`padding:var(--sp-2) var(--sp-4)`）。v2-app.js `injectV2Styles()` 內角色顯隱用的 `display:revert`（3 處）維持不動——那是刻意設計，不在此列

### 新增（A. 表格手機卡片化）
- `components.css` 新增 `.data-table-cards`：手機（<640）td 轉 `display:flex` 卡片列，`::before` 顯示 `data-label` 中文欄名；640+ 還原 `display:table`/`table-row-group`/`table-row`/`table-cell`（**未採用原草案的 `revert`**——同樣的 revert 陷阱，且草案的還原值本身也沒考慮到 5 張目標表格都同時掛 `.data-table-compact`，若直接還原成 `.data-table td` 的 `--sp-3` 會讓緊湊表格意外變寬鬆，另補 `.data-table-compact.data-table-cards td` 更高特異度規則還原緊湊 padding）
- 5 支 render 函式共 31 個 `<td>` 補 `data-label`／`cell-primary`／`cell-actions`（只加屬性，不動 `.map()` 結構與綁定區塊）：`app.js` `renderRecordsTable`（8td）、`updateTeacherTable`（4td）；`v2-app.js` `renderTeachersAdminTab`（5td）、`renderLogsTab`（6td）、`renderRecordsTab`（8td）。對應 `<table>` 加 `data-table-cards`
- `renderLogsTab` 的 JSON `<code>` 欄補 line-clamp（3 行截斷＋`overflow-wrap:anywhere`）
- `#settlement-table`（不轉卡片，維持橫捲）補手機層首欄 sticky；一併補「有變動」列高亮色蓋到 sticky 欄的修正

### 新增（B. 課表手機單日檢視）
- `renderTeacherScheduleWithHighlight`（申請頁）／`renderEditableScheduleGrid`（課表編輯器）樣板補 `is-day-active` class（標題列/課程格/空堂格）、容器 toggle／恆掛 `.schedule-grid-single`；`features.css` 新增對應規則：手機僅顯示節次欄＋當日欄，640+ 還原 5 欄週檢視
- 修一個實作中發現的隱藏漏洞：課表左上角「節次」標籤格只有 `.schedule-header` class（不是 `.schedule-period`），會被單日檢視的隱藏規則誤蓋掉；補 `.schedule-corner` class 並列入豁免清單
- 課表編輯器新增手機日切換器（`#editor-day-switcher`，5 顆按鈕），綁定寫在 `renderEditableScheduleGrid()` 內（每次 render 重建，不累積 listener）；新增 `this.editorActiveDay` 欄位（初始為今日星期，週末 fallback 週一）
- 新增 `.hidden-desktop` 通用工具 class（640+ 隱藏）；**用 `!important`**——`base.css` 載入順序在 `features.css` 之前，若無 `!important`，同特異度時後載入的 `.day-switcher{display:flex}` 會贏過先載入的隱藏規則（與現有 `.hidden` 用 `!important` 同一個理由，非新發明）
- 裸 `.schedule-grid`（無 highlight 情境，目前程式碼路徑理論上不會觸發）補 `overflow-x:auto` 防禦，640+ 還原 `hidden`

### 新增（C. Modal 手機全螢幕）
- `components.css` modal 段落改寫為 mobile-first：<640 佔滿視口（`100dvh`）、`.modal-actions` sticky bottom；640+ 還原為現行桌機值（500px/90%/80vh/`--r-md`，零視覺變動，未採用草案中不同的 340/520/85vh/`--r-lg`）。`#course-edit-modal` 桌機 420px 特例保留

### 新增（D. 申請頁 sticky action bar + selection-tray）
- 步驟四按鈕列（`#selected-course-info .action-buttons`，描述性選擇器避免誤中批次面板同名 class）手機 sticky bottom，640+ 還原 static
- 新增 `.selection-tray`／`.selection-tray-header` 共用視覺（surface/border/radius/標題列 flex），套用於「已選課程」與「多重調課批次清單」；批次清單新增標題列（含即時筆數 `#batch-swap-count`），「清除全部」鈕（`#batch-clear-btn`，id 不變）從底部移到標題列右上，與「已選課程」tray 對齊

### 變更
- CSS 版本號 `?v=2.3.1` → `?v=2.4.0`

### 驗證
- `npm run check`（27/27）、`node test/v2-smoke-test.js`、`node test/ui-rwd-check.mjs`（7/7 無橫向溢出）、`npm test`（41/41）全數通過
- 另寫一次性 Playwright 腳本（未進 repo）涵蓋驗收清單 2(a-f)/3(a-e)/4 共 33 項斷言，全數通過，含最易斷處「編輯器切換日後點格仍能開 `#course-edit-modal`」與「桌機下 5 張表回 `display:table`／課表回 6 欄且全部可見／modal 回置中卡片」
- V2 動態表（`?v2=1` 不登入看不到）以 fetch 原始碼靜態檢查 3 支 render 函式樣板字串皆含 `data-label` 與 `data-table-cards`

### 已知取捨
- `.v2-teacher-row input[type="email"]{max-width:220px}` 未移除：這是總計畫（`docs/PLAN.md` §4）列的項目，但本輪 Stage 4 任務說明只要求該表「姓名 cell-primary、操作 cell-actions」，且此上限不會造成手機溢出（純粹讓輸入框變窄），故留待之後視需要再處理
- selection-tray 的「清除鈕位置文案對齊」以移動既有 `#batch-clear-btn` 到新標題列實作（id 不變，無需改綁定），而非新增重複按鈕；批次清單與已選課程 tray 的底色未強制統一（各自既有底色因載入順序仍會覆蓋 `.selection-tray` 的預設 surface 底，避免抹掉既有重點色）

## [2026-07-29]（feature/permission-system）UI 重規劃 Stage 3 驗收缺陷修正

派獨立 agent 驗收 Stage 3（CSS 全面重寫＋元件收斂）後回報的 8 項缺陷，全數修復，獨立 commit。

### 修復（阻斷）
- **V2 Email 登入 modal 被登入遮罩蓋住**：`openAuthModal()` 的 `#v2-auth-modal-backdrop` 換 `.modal` class 後只吃到 `components.css` 的 `--z-modal`(1000)，被 `#v2-auth-gate` 的 `--z-authgate`(1100) 蓋住，Email 登入輸入框完全無法點擊。`features.css` 補 `#v2-auth-modal-backdrop{z-index:var(--z-authmodal)}`（id selector specificity 已高於 `.modal`，免 `!important`）

### 修復（中）
- **斷點紀律違規 5 條**：`base.css`（`.user-name`）、`components.css`（`.btn`／`.btn-google-signin`）、`features.css`（`.batch-swap-number`／`.conflict-options`／`.conflict-option`）的 `@media (max-width:639px)` 全數翻轉為 mobile-first（預設為手機值，`@media (min-width:640px)` 覆寫回桌機值）；`.user-name`／`.btn-google-signin span`／`.btn-google-signin` padding 三處改用 `display:revert`／`padding:revert` 精確還原「未寫任何規則」時的桌機原貌（經 638px/642px 雙寬度 computed style 比對，兩側視覺與翻轉前一致）
- **`.btn-sm` 手機觸控高度被蓋掉**：`.btn-sm{min-height:30px}` 蓋掉手機 44px 觸控規則（375 實測曾為 30px）。隨斷點翻轉一併修：手機層 `.btn`／`.btn-sm` 皆 `min-height:var(--ctl-h-touch)`（44px），`@media (min-width:640px)` 才各自降回 `--ctl-h`(36px)／`--ctl-h-sm`(30px)
- **行內連結變方塊鈕**：`index.html` 兩處句中操作入口（課表管理「備份與還原請至設定」、同步衝突「建議先匯出備份」）Stage 3 誤併入 `.btn.btn-ghost`，變成 64×37 方塊撐高段落。新增 `.btn-inline`（`display:inline`、無 padding/min-height、底線文字）取代，兩處 class 改用單一 `.btn-inline`（不再掛 `.btn`）

### 修復（低）
- **第三套 toast 收斂**：`v2-app.js` `showGoToTeacherAdminToast()` 自建 fixed toast（硬編 `#fffbeb`/`#d97706`/`#92400e`/`#78350f` + inline `position:fixed`/`z-index`）改掛進共用 `#toast-container`，套 `.toast.toast-warning` 結構 class 與淡入/淡出動畫，僅保留其特有的「前往教師管理」動作鈕（`showToast()`/`notify()` 現有簽章皆不支援附加動作鈕，故仍走自建 DOM，但視覺與生命週期完全併入共用 toast 系統）
- **測試斷言指認性**：`promptAdditionalConsentTeachers()` 的多重調課同意 modal 補專屬 id `#v2-extra-consent-modal`；`test/v2-approval-flows.mjs`／`test/v2-verify-fixes.mjs` 對應的 `.modal` 斷言（會誤中 `#modal-root` 內 5 個常駐但預設 hidden 的靜態 modal）改指向此 id
- **註解過時**：`tokens.css` 與 `test/v2-approval-flows.mjs`（3 處）仍提已刪除的 `style.css`，改為四檔（tokens/base/components/features）載入順序的描述
- **殘留色**：`features.css` `.schedule-course.multi-selected` 的 `box-shadow:0 0 0 2px rgba(14,165,233,.3)` 改 `var(--sh-focus)`

### 變更
- CSS 版本號 `?v=2.3.0` → `?v=2.3.1`（F9：防 GitHub Pages 快取舊 CSS 配新 HTML）

### 驗證
- `npm run check`（27/27）、`node test/v2-smoke-test.js`、`node test/ui-rwd-check.mjs`（7/7 無橫向溢出）、`npm test`（41/41）全數通過；`node --check` 過 `test/v2-approval-flows.mjs`／`test/v2-verify-fixes.mjs`
- Playwright 實測：`?v2=1` 點「使用 Email 登入」後 `#v2-modal-email` 可聚焦、`elementFromPoint` 命中輸入框本身、`type()` 成功寫入文字（z-index 實測 gate=1100 < modal=1200）；375px 下 `#search-records-btn`（`.btn.btn-primary.btn-sm`）`boundingClientRect.height`＝44；`#schedule-goto-settings-btn`／`#export-before-sync-btn` 兩處行內連結高度分別為 17px／21px
- `grep -nE '@media' src/css/*.css`：全部 23 條僅 `min-width:640px`／`min-width:1024px` 兩種，無 `max-width` 殘留

### 已知取捨
- `showGoToTeacherAdminToast()` 未採 (a) 方案（改走 `window.app.showToast`/`notify` 傳入自訂內容節點），因兩者現有簽章都只接受純文字訊息，硬加動作鈕支援會擴大 `app.js showToast()` 的改動面；改採 (b) 方案（保留自建 DOM，但完全併入共用容器/class/動畫）

## [2026-07-29]（feature/permission-system）UI 重規劃 Stage 3：CSS 全面重寫 + 元件收斂 + V2 樣式併入

依 `docs/PLAN.md` Stage 3，將 2891 行 `style.css` 拆分為 tokens/base/components/features 四檔並全面 token 化，收斂按鈕/卡片/Modal/表格/Toast 五套重複系統為單一實作，斷點統一為 mobile-first 640/1024。獨立 commit、獨立驗證。

### 變更（檔案拆分）
- `style.css` 刪除（`git rm`），改為 `tokens.css`（73 行）/`base.css`（330 行）/`components.css`（507 行）/`features.css`（686 行）四檔，`index.html` 依序載入，全部 `?v=2.3.0`
- `v2-app.js` `injectV2Styles()` 內容由約 176 行縮減為約 20 行，只留角色顯隱規則與 R1 隱私邊界規則（保留 `#v2-styles` 元素，F5 斷言不受影響）；其餘視覺規則搬進 `components.css`/`features.css` 並 token 化
- `uiFeedback.js` 移除自建 CSS 注入（`injectStyles`/`stylesInjected`），fallback toast 改用共用 `#toast-container` 與 `.toast`/`.toast-{type}` class；同步中斷徽章樣式移入 `features.css` 靜態規則

### 變更（元件收斂，Tier B 改名，grep 全 repo 逐處同步）
- 按鈕：`.btn-more`→`btn-secondary`、`.btn-xs`→`btn-sm`、`.btn-default`→`btn-secondary`、`.btn-link`→`btn btn-ghost`、`.btn-signout`→`btn btn-ghost btn-sm`、`.v2-email-login-trigger`→`btn btn-ghost btn-sm`、v2 登入遮罩兩顆按鈕新增 `btn btn-google`／`btn btn-ghost btn-sm`；`.btn-success`（確認 0 引用）直接刪除
- 卡片：`.compact-card` 刪除定義並從 HTML/JS 移除 class 字串，併入 `.card` 統一緊湊 padding（新 token `--pad-card`）；`.notice-card` 留 alias 對應新 `.card-notice`（Stage 6 才刪別名）；`.v2-legacy-card` 直接改名 `.card-warning`；`.v2-pending-item`→`.list-item`(`-incoming`/`-outgoing`)
- Modal：刪除 box 版舊 `.modal` 定義與死碼 `.modal-overlay`；`v2-app.js` 三處動態 modal（CSV 匯入預覽／多重調課同意／Email 登入）全面改用 `.modal`/`.modal-content`/`.modal-actions`，並補 `.modal-body`（+ email/password 欄位補 `.form-group`）取得統一 padding 與表單樣式；`.v2-modal-links`→`.modal-links`、`.v2-modal-msg`→`.form-msg`
- 表格：刪除 `#teacher-table` nth-child 固定寬；`.multi-course-table`／`.v2-log-table` 補上 `.data-table.data-table-compact` 共用外觀（各自保留原 class 供特有樣式掛靠：前者 sticky 表頭、後者 code 欄字級）；`app.js` 調課預覽表改用 `.data-table`，移除全部 inline `style=`
- Toast：位置改為桌機右下、手機底部滿寬（含 `safe-area-inset-bottom`），修復與 header/登入 modal 疊放問題

### 修復（隨手清掉的死碼，遷移原則「死規則不帶過去」）
- `.import-layout`、`.firebase-status`(`-item`)、`.firebase-config-form`、`.error-message`、`.step-indicator`(`-dot`/`-line`)、`.v2-login-denied`、`.status-badge`、`.notice-icon`／非 compact 版 `.upload-icon`：全 repo 確認零引用，未搬入新檔
- `.schedule-grid` 手機字級覆寫（原 768px 斷點）因所有文字子元素皆各自有明確 `font-size` 而從未實際生效，改為直接在 `.schedule-cell` 上做 mobile-first 覆寫（行為修正為有效）

### 新增（tokens.css 微調）
- 補 3 個語意色階：`--c-success-100`/`--c-warning-100`/`--c-danger-100`（原散落多處的 `#dcfce7`/`#fef3c7`/`#fee2e2` 收斂於此）
- 新增 `--pad-card`（`.card` 統一緊湊 padding 別名）

### 驗證
- `npm run check`（27/27）、`node test/v2-smoke-test.js`、`node test/ui-rwd-check.mjs`（7/7 無橫向溢出）、`npm test`（41/41）全數通過
- Playwright 1440×900／375×667 各走訪 7 個畫面（含紀錄詳細 modal）+ V2 未登入遮罩，console 零 error
- PDF regression（F6）：代課通知單四聯正常產出，表格線/中文字/欄位對齊無破版
- hex 統計：`src/css/*.css` 由 183 降至 43（全部集中在 `tokens.css` 定義處），`base`/`components`/`features.css` 為 0

### 已知取捨
- `test/v2-approval-flows.mjs`、`test/v2-verify-fixes.mjs` 的 `.v2-modal-backdrop` 選擇器同步改為 `.modal`（非 `npm test` 涵蓋範圍，但屬 grep 全 repo 零殘留要求內的同步改動，未變更任何測試斷言邏輯）
- 部分色相收斂為主色藍（原 multi-course/批次面板區塊的青色系與靛色系），視為「重寫非搬運」授權下的色票收斂，非逐色還原；視覺風格不變（藍白教務風）

## [2026-07-29]（feature/permission-system）UI 重規劃 Stage 2 驗收缺陷修正

派獨立 agent 驗收 Stage 2（資訊架構重組）後回報的 10 項缺陷，全數修復，獨立 commit。

### 修復（高：權限功能回歸）
- **director 失去教師屬性編輯權**：Stage 2 原本讓教師管理頁的 V1 教師屬性表對 director 隱藏
  （只留 V2 帳號表），但 V2 帳號表的「領域」欄是唯讀顯示、沒有導師班欄，且 domains 是推薦
  引擎比對代課人選的依據——等於 director 完全無法編輯任教領域/導師班級。移除
  `body.v2-active.v2-director #teacher-editor-card{display:none}` 規則，director 現在同時
  看到教師屬性卡與 V2 帳號卡（職責不同、可共存）

### 修復（中）
- 分頁名 toast 文案：`app.js`「請先在『課表匯入』頁籤設定學校名稱」、`v2-app.js`「請先於
  『課表匯入』載入課表」均改為「課表管理」，跟上 Stage 2 的分頁改名
- 教師管理無資料時新增教師靜默失效：`#teacher-editor` 的初始 `hidden` 只在匯入課表後由
  `updateScheduleStatus()` 移除，尚未匯入課表就手動新增教師時新列不會顯示；
  `addNewTeacherRow()` 補一行移除 `hidden` 保底
- CSS 版本號 `tokens.css`／`style.css` `?v=2.0.0` → `?v=2.2.0`（F9：每階段遞增防 GitHub Pages
  快取舊 CSS 配新 HTML）

### 修復（低，含安全縱深與體驗細節）
- R1 規則加一層靜態 CSS 防線：`body.v2-active #records-no-data`／`#records-content
  {display:none!important}` 複製一份到 style.css（v2-app.js 注入版保留，兩者內容一致），
  萬一 JS 注入樣式因故未執行仍有靜態規則兜底；前綴 `body.v2-active` 對 V1 零影響
- 無課表點「課表編輯」加提示：`activateScheduleSubview` 因無資料把 'editor' 降級為 'import'
  時，補一個 `showToast('請先匯入課表', 'warning')`，避免使用者以為點擊沒反應
- **推翻 Stage 2 原預設**：課表管理分頁改為一律預設顯示 import view（即使已有課表資料）——
  原設計「有資料預設 editor」會讓回訪者落在空白編輯器（需先選教師才有內容），import view
  的課表狀態盒資訊量更高；使用者需要編輯課表時自行點「課表編輯」切換
- 全新載入時鎖定分頁補視覺：`init()` 的 `loadSavedData()` 後無條件呼叫一次
  `updateTabLockStatus()`，讓 substitute/records/settlement 三顆鎖定按鈕從第一次繪製起就有
  `is-locked` 灰化樣式（點擊攔截原本就有效，這裡只補視覺一致性）
- `teachers-tab` 補初始 `hidden` class，與其餘 7 個 tab-content 的寫法一致（Stage 2 疏漏，
  功能上原本就靠 `.tab-content{display:none}` 基礎規則隱藏，不影響顯示，純一致性修正）
- `docs/ISSUES_LOG.md` 新增 Stage 6 死碼待刪清單，把 `.backup-restore-card`／
  `.backup-restore-row` 與既有的 `.import-layout` 系列並列記錄

## [2026-07-29]（feature/permission-system）UI 重規劃 Stage 2：資訊架構重組 9→8 分頁

依 `docs/PLAN.md` 六階段 UI 重規劃計畫，完成 Stage 2（資訊架構重組），獨立 commit、獨立驗證。

### 變更（分頁重組）
- **9 分頁 → 8 分頁**：教師 CRUD 集中至新「教師管理」分頁；「課表匯入」與「課表編輯」合併為
  「課表管理」分頁下的兩個 sub-view（頂部 segmented control 切換，`#schedule-import-view`/
  `#schedule-editor-view`）；新 nav 順序：調代課申請／待辦／調課紀錄（高頻，中間分隔線
  `.nav-tabs__divider`）／課表管理／教師管理／月結算／操作日誌／設定（管理）
- **教師管理分頁**：`#teacher-editor-card`（V1 教師屬性表，可編輯任教領域/導師班級，全員可見）
  與 V2 教師帳號管理容器（`#v2-teachers-admin`，`v2-only v2-director-only`，管理 email/角色）
  同分頁並列顯示，職責不同、可共存；分頁本身 `v2-approver-only`（section_chief + director
  皆可進，較舊版僅 director 可見的「教師管理」範圍更廣）（*2026-07-29 驗收缺陷修正：原版本
  director 看不到教師屬性表會導致無法編輯領域/導師班，已改為兩卡並列，見下方 Stage 2
  驗收缺陷修正紀錄*）
- **課表編輯器刪除教師按鈕移除**：`#editor-delete-teacher-btn` 與其綁定移除，教師刪除統一由
  教師管理頁「刪除」鈕（`.delete-teacher-btn`，逐列已存在）處理——已知取捨：該鈕原本連帶清除
  該教師的課表資料，教師管理頁的列刪除目前只移除教師本身，不會清課表資料，兩者非完全等價
  行為（記錄於 Stage 2 收尾筆記，非本階段業務邏輯修改範圍）

### 修復（R1 致命風險：V2 個資外洩防線加固）
- `v2-app.js` 隱藏 V1 全校紀錄表的 CSS 規則，原用 `#records-tab > #records-content` 子代組合子，
  records-tab 內部 DOM 調整時會意外失效；改為純 `#records-content`/`#records-no-data` id 選擇器，
  不依賴任何 DOM 層級

### 修復（modal 搬家：F2 既有潛在 bug）
- 5 個 modal（`#course-edit-modal`／`#record-detail-modal`／`#weekly-summary-modal`／
  `#sync-conflict-modal`／`#merge-confirm-modal`）原本內嵌於各 `.tab-content` 內，非該分頁
  時因祖先 `display:none` 打不開；全部搬到 `<body>` 尾端新增的 `#modal-root`，全靠
  `getElementById` 存取，搬家未斷任何綁定

### 修復（既有缺陷，驗收時發現）
- `.v2-only{display:none}` 過去只存在於 v2-app.js 動態注入的樣式，純 V1 網址（無 `?v2=1`）下
  v2-app.js 提早 return 永不注入，導致「待辦」「操作日誌」兩顆 V2 專屬分頁按鈕在 V1 單機模式
  下一直可見（可點但內容空白）；改為 style.css 一律載入的靜態規則，V2 注入的同名規則
  cascade 順序仍正確覆蓋，行為不變

### 變更（其他）
- 備份還原去重：課表管理頁移除「資料備份還原卡」，改為一行提示連結導向設定頁；
  `app.js` `_importContexts` 對應的 `tab` context 與其 5 個 DOM 綁定一併移除，只留 settings 組
- 設定頁分權：「學年度管理」「科目領域對應表」「資料管理」三卡加 `v2-approver-only`；
  「危險操作區」（清除所有資料）加 `v2-director-only`
- 手機可捲頁籤列：`.nav-tabs` 改 `overflow-x:auto` + `scroll-snap`，≥1024px 恢復 `flex-wrap`；
  切換分頁時新作用中按鈕自動 `scrollIntoView`
- `canSwitchToTab`/`updateTabLockStatus` 分頁清單同步新結構：課表管理與教師管理維持不鎖
  （資料入口／無資料仍可用），substitute/records/settlement 三個維持原鎖定邏輯不變
- `test/v2-smoke-test.js`：`.tab-btn.v2-only` 數量斷言 3→2（教師管理不再是純 v2-only 頁籤）；
  `test/ui-rwd-check.mjs`：走訪清單新增「教師管理」分頁測量，等待訊號改用同 sub-view 內的
  `#schedule-status`；`test/v2-interactive-test.js`：`data-tab="v2-teachers"` → `"teachers"`

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

## [Unreleased - v2.0.0-alpha] - feature/permission-system branch

> 本段為 `feature/permission-system` 分支的 V2 多角色權限系統變更，尚未合併回 master 正式釋出。
> 註：午休間隔、科目領域對應表、九年級畢業停用課程、雲端即時重繪等功能已隨 master 正式釋出（見下方 v1.12.0–v1.13.2）；本分支已於 2026-06-18 合併 master 取得這些功能與修復。

### 資安修補（2026-06-20，Phase 1 多 agent code review）
- **🔴 修復 operationLogs 稽核日誌全數寫入失敗**：`firestore.rules` 的欄位白名單（`target/detail/request.time`）與 `operationLogger.log()` 實際 schema（`targetType/targetId/details` + ISO timestamp）不符，導致每筆日誌寫入被 DENY（含 login_denied）。改規則對齊程式碼實際 schema。
- **🔴 封堵 userMappings 自寫提權**：整套 `isDirector/isApprover/myTeacherId` 信任使用者自寫的 `userMappings/{uid}.linkedTeacherId`，原規則未限欄位 → 任一教師可映射到 director 的 teacherId 而提權為主任。改為自寫時 `linkedTeacherId` 必須指向 email 等於本人登入 email 的教師檔。
- **⚠️ 待重新部署**：以上只改 `firestore.rules` 檔，需 `node scripts/firestore-deploy-rules.js` 重新發布才生效。
- 已記錄延後 Phase 3/4 處理：`substituteRecords` 偽造已核准、`pendingRequests` 同意人全欄竄改（詳見 `docs/PLAN_v2.0.0.md` §0.5）。

### Phase 3：三種審核流程分支（2026-07-09）
- **申請分流**：代課（substitute）直接進組長核准；調課（swap）先對方同意再核准；多重調課（multi_swap）全員同意才進核准，任一人拒絕整批 rejected
- **核准改為 approver（主任/組長）專用**：`runTransaction` 原子完成「建紀錄 + 更新請求 + 寫日誌」；並發核准後到者顯示「已被處理」
- **UI 三段式**：「待我同意」（swap / multi_swap 分列）、「待我審核」（approver 專用含數量徽章）、「我的申請」（含對象顯示與駁回 dismiss）
- PDF 改於核准成功後產生（原為同意當下）
- **安全**：`firestore.rules` 收緊——`substituteRecords` create 封掉教師自寫「已核准」紀錄；`pendingRequests` create 強制狀態機初始狀態，update 加 `affectedKeys` 欄位白名單與雙終態鎖；`isValidRoleValue()` 接入 teachers create/update
- 修復致命 bug：駁回操作因資料層自動注入 `updatedAt` 違反規則白名單而全面 permission-denied（改交易直寫）
- 重構：刪除死碼 `canApprove` 與 `REQUEST_STATUS.CANCELLED`；pending 快取統一 normalize

### Phase 2：全校課表共享（2026-07-06）
- approver 上傳/編輯課表即時同步全校教師（commit `614e4ff`）
- 登出後以遮罩 + inert 鎖定整個 app，杜絕未登入操作月結算與報表下載
- 修補同頁切換身份的權限殘留與跨身份資料外洩（2026-07-05）

### 新增（V2 權限系統）
- **角色制度**：`admin`（組長）與 `teacher`（教師）雙角色
  - 組長識別依 `schools/default/config/main.initialAdminEmails` 或 `teachers/{id}.role`
  - 教師以 Google email 綁定 `teachers/{id}.email`
- **教師帳號管理頁籤（admin 專用）**：指派 email、切換角色、新增/刪除教師、從課表一鍵匯入教師
- **登入綁定機制（authGuardV2）**：未綁定 email 的 Google 帳號拒絕登入並提示
- **調課同意流程（pendingRequestService）**：教師發起 → 寫入 `pendingRequests` → 對方同意後轉為 `substituteRecords` → 或對方拒絕 / 發起人撤回
- **待辦清單頁籤**：顯示「待我同意」「我已發起」兩區塊
- **組長代發起模式**：組長可代任一教師直接建立紀錄，跳過同意流程
- **完整操作日誌**：所有寫入事件（create_request / approve / reject / cancel / admin_create / edit / delete / teacher_bind_email / role_change / login_denied / permission_denied 等）都寫入 `operationLogs` 集合；組長看全部、教師只看相關
- **三層角色擴充（接續路徑，2026-05-29 起）**：`director`（教務主任）/ `section_chief`（教學組長）/ `teacher`（教師）；SCHOOL_ID 從 `default` 改為 `inhu`；firestore.rules v2.2；Email/密碼雙軌登入 + 主任寄密碼信；課表匯入自動串接教師管理。詳見 `docs/PLAN_v2.0.0.md` §0 進度索引。
- **全新 Firestore Schema**：`schools/{schoolId}/`（與舊 `users/{uid}/data/…` 完全物理隔離）

### V2 新增檔案
- `src/js/v2-app.js`、`src/js/modules/v2/`（schemaConstants / envDetector / firebaseV2 / schoolDataService / roleService / operationLogger / teacherAccountManager / pendingRequestService / authGuardV2 / README）
- `docs/V2_PERMISSION_SYSTEM.md`、`docs/V2_E2E_CHECKLIST.md`、`scripts/firestore-*.js`

### 相容性
- V2 僅在 URL `?v2=1` 或 hostname 含 `preview` 時啟動；穩定版 master 路徑完全未動
- 啟動時透過 `body.v2-active` class 顯示 V2 專屬頁籤

### 維護
- **2026-06-18 合併 master**：取得 v1.13.1（`esc()` 修復）與 v1.13.2（雲端即時重繪 + 監聽器洩漏修正），解決 feature 分支同樣會發生的初始化中斷問題。

---

## [1.13.2] - 2026-06-18

### 修復（雲端同步即時重繪）
- **雲端翻轉「九年級已畢業」開關時，已開啟的推薦/調課面板不即時重繪**：他機翻轉開關後，本機即時同步只回寫雲端、不刷新 UI，導致已開啟的「代課推薦／調課互換」面板與課表灰底維持舊狀態，需手動重新觸發。
  - 即時同步監聽器加入開關狀態比對，偵測雲端翻轉時自動同步勾選框並重繪相依 UI。
  - 抽出共用方法 `refreshGrade9DependentUI()`（課表編輯灰底／原課表灰底／推薦或調課面板），由本機切換、即時同步、雲端下載/合併三條路徑共用，行為一致。
  - 補強：`refreshUIAfterSync()`（下載/合併/衝突解決路徑）原本只更新開關勾選框，現一併重繪面板與灰底。
- **修掉 v1.12.0 潛在 bug**：`handleGrade9Toggle()` 呼叫的 `renderEditorSchedule()` 並不存在（正確為 `renderEditableScheduleGrid()`），編輯課表（已選教師）時切換開關會丟 `TypeError` 並中斷後續重繪與提示。
- **順帶修正即時同步監聽器洩漏**：`enableRealtimeSyncAndListen()` 原本每次呼叫都重複註冊 `onDataChange` 監聽器（5 個呼叫點），導致每次雲端變更觸發多次 `syncToCloud()` 寫入放大；改為僅註冊一次。

### 測試
- 新增 `test/test-grade9-refresh.mjs`（11 項通過，涵蓋翻轉偵測與面板重繪決策）；既有 `test/test-grade9.mjs`（18 項）回歸通過。
- 計畫文件：`docs/PLAN_grade9_realtime_refresh.md`。

## [1.13.1] - 2026-06-18

### 修復（嚴重：正式站初始化中斷）
- **`esc is not defined` 導致全站初始化停擺**：1.13.0 的「科目領域對應表」渲染呼叫了 `esc()` HTML 跳脫函式，但該函式從未被定義。`renderSubjectDomainTable()` 在 `bindDataManagementEvents()` 內被無條件呼叫，且位於 `init()` 中 `initFirebase()` 之前，導致建構子拋出 `ReferenceError` 後中止 —— **Firebase 未初始化、Google 登入按鈕未綁定、localStorage 既有資料未載入**，雲端同步完全失效。
- **修法**：於 `app.js` 模組層補上 `esc()` HTML 跳脫工具函式（`& < > " '` → 對應實體）。
- **驗證**：本機瀏覽器重測，初始化日誌完整輸出「Firebase 初始化成功／完成」，無任何 `PAGEERROR`，登入按鈕恢復綁定。

## [1.13.0] - 2026-06-15

### 新增（科目領域對應表）
- **科目↔領域對應設定表**（設定頁 → 科目領域對應表）：匯入課表時自動擷取「科目→領域」對應（依出現次數排序），存成可手動增修的對應表。
- **課表編輯下拉選科目自動帶領域**：課程編輯對話框的「科目」改為 datalist（可選可輸入）；選科目後依對應表自動帶出「領域」。一科目可對多個領域時，預設帶最常出現的，使用者仍可手動改選。
- **領域選項動態化**：領域下拉改為動態建立（標準領域 ∪ 對應表內所有領域），非標準領域（如「統整性主題/專題/議題探究」）也能正確顯示與選取。
- **設定頁可維護**：手動新增/編輯/刪除科目領域對應；「從目前課表重新擷取」（含確認）可依最新課表重建。編輯課程時新科目/新領域會非破壞性回饋進對應表。
- **持久化**：存入 `settings.subjectDomainMap`，同步至 localStorage 與 Firebase 雲端。
- **資料安全**：領域名含斜線不會被分隔符拆碎（分隔符限「、, ，」）；渲染全程 `esc()` 跳脫。

### 改善（課表編輯：午休間隔）
- 課表編輯的週課表在第四節與第五節之間，新增一條跨整列的灰色「午休」橫列，分隔上午/下午課程，提升辨識度。

### 測試
- 新增 `test/test-subject-domain.mjs`（12 項通過）。

## [1.12.0] - 2026-06-15

### 新增（九年級畢業停用課程）
- **「九年級已畢業」開關**（設定頁 → 學年度管理）：一鍵停用所有九年級（9年X班）課程，讓這些時段的老師可正常被安排調代課，不再被已畢業班級的課擋住。資料完整保留，可隨時關閉還原。
- **判斷依據**：班級名稱前綴，涵蓋 `9年X班` / `九年X班` / `9XX`（如 901）等格式。
- **影響範圍**（停用時排除九年級課的計算）：代課推薦、教師忙碌判斷、代課送出衝堂攔截、單次調課衝突清單、批次調課衝突檢查。
- **不影響**：月結算與 PDF 生成仍使用原始課表，保留歷史紀錄完整。
- **持久化**：開關狀態存入 `settings.grade9Disabled`，同步至 localStorage 與 Firebase 雲端（多裝置一致）。
- **視覺標記**：課表上九年級停用課以灰底＋刪除線顯示；課表編輯器中仍可點擊編輯以管理資料。
- 計畫文件：`docs/PLAN_grade9_graduation.md`；單元測試：`test/test-grade9.mjs`（18 項通過）。

## [1.11.0] - 2026-05-20

### 新增（週彙整通知單）
- **「列印本週彙整」按鈕**：在「調代課紀錄」頁籤 toolbar 新增按鈕，選週後一鍵產生整週綜合 PDF
- **週彙整 PDF 結構**：1 份 PDF、按收件方分頁
  - 第 1 頁起：教學組全校彙整（A4 直向，25 筆/頁自動切 chunk，含合計與簽核欄）
  - 接續：每班 1 頁（A4 橫向，左側班級週課表標異動 + 右側精簡列表）
  - 接續：每位原任課老師 1 頁（A4 橫向）
  - 接續：每位代課老師 1 頁（A4 橫向）
  - 教學組裁切後分送各方，紙張耗用由 4N 聯降為「教學組數 + 班數 + 原任課人數 + 代課人數」頁
- **保留既有單筆/多節 PDF 流程**：本功能為新增第二條出口，不取代既有按筆 PDF
- **PDF 模組新增方法**（`src/js/modules/pdfGenerator.js`）：
  - `generateWeeklySummaryForm(weekStart, records, scheduleData, teachers)` — 入口
  - `getWeekStart` / `getWeekRange` — 週範圍計算（週一到週五）
  - `getClassWeekSchedule` — 班級週課表（仿 `getTeacherWeekSchedule`）
  - `groupRecordsByRecipient` — 紀錄依教學組/班級/原任課老師/代課老師分群
  - `createAdminWeeklyPageHTML` / `createClassWeeklyPageHTML` / `createTeacherWeeklyPageHTML` — 三類頁面渲染
  - `createWeeklySummaryTableHTML` — 共用列表表格（支援 multiCourseGroupId 列分組視覺）
  - 格式 helper：`formatDate` / `formatMonthDay` / `formatWeekLabel`
- **PDF 模組修改**：`createMultiCourseScheduleTableHTML` 加 optional `options.colorFn` 與 `options.cellRenderer`，向後相容；代課用深灰、調課用淺灰
- **app.js 新增**：`openWeeklySummaryModal` / `closeWeeklySummaryModal` / `updateWeeklySummaryPreview` / `generateWeeklySummaryPDF`
  - 即時顯示「本週共 X 筆 → 預估 Y 頁」
  - 0 筆時禁用確認鈕
- **index.html 新增**：`#print-weekly-summary-btn` 按鈕 + `#weekly-summary-modal`（input[type=date] + 預覽 + 確認/取消）

### 邊界處理
- 跨週 batch：以 `record.date` 各自歸週
- 調課 swapDate 在另一週：以時段 A 歸週；列表「類型」欄加註「↔ MM/DD 第 X 節」
- 自行調課 `isSelfSwap`：列表與週課表標示「(自調)」
- 多節 `isMultiCourse`：逐節展開，同 `multiCourseGroupId` 用淡灰背景視覺分組

### 檔名格式
- `調代課週彙整_YYYYMMDD-YYYYMMDD.pdf`（週一-週五的起迄）

### 排版調整（2026-05-21）
- **半頁拼接**：班/原任課/代課頁改為 A4 橫向左右兩式直切（每半頁 551×794），紙張耗用再砍半
- **變動格雙師顯示**：課表變動格同時顯示「原 X」+「代/調 Y」
- **未變動格顯示原任課**：老師頁顯示「班級/科目」、班級頁顯示「教師/科目」；資料缺漏顯示淺灰「—」
- **課表自動撐高**：移除固定 flex 比例（1.4:1），課表用自然高度、列表佔剩餘空間，列表容量從 ~13 列提升至 ~24 列
- **半頁中央分隔**：垂直虛線（無剪裁字樣）
- **聯別徽章**：老師聯顯示為「○○○老師 原任課聯／代課聯」
- **頁尾調整**：移除「本人簽：」欄、加入「列印日期」

---

## [1.10.0] - 2026-05-20

### 新增（衝突檢查強化）
- **代課教師重複指派檢查**：推薦引擎 `RecommendationEngine.getRecommendations` 新增 `substituteRecords` 參數；同日同節已被指派為代課/調課的教師會被視為 busy，不再出現在推薦清單，避免同時段重複指派造成實際衝堂
  - 新增 helper `getAssignedTeachers(substituteRecords, date, period)`
  - `app.js` `showRecommendations` 傳入 `this.dataManager.getSubstituteRecords()`
- **送出代課紀錄前的衝堂攔截（fail-safe）**：`saveAndProcessRecord` 與 `confirmMultiCourseSubstitute` 在寫入紀錄前最後檢查，攔截推薦邏輯被繞過的邊緣情況
  - 新增 `DataManager.checkSubstituteTeacherConflict(name, date, weekday, period, excludeId)`
  - 同時檢查（1）該老師原課表是否有自己的課；（2）同日同節是否已被指派為其他代課/調課
  - 衝突時顯示 toast 並阻擋送出
- **課表上傳：班級衝突檢查**：`checkScheduleConflicts` 除既有「同教師同時段多班級」外，新增「同班級同時段多教師」檢查（協同教學/課表錯誤可能來源），分區塊呈現
- **CSS**：新增 `.schedule-conflict-section` 樣式（衝突清單分區用）

---

## [1.9.0] - 2026-04-13

### 新增
- **課表匯入頁籤資料備份還原**：在左側面板新增「資料備份還原」區塊，可直接匯出備份或匯入 JSON 還原資料，含檔案預覽確認

### 介面改進
- **全站緊湊布局改造**：所有頁籤統一採用緊湊卡片、toolbar 化操作列、雙欄並排設計
  - 課表匯入：左右雙欄（上傳+備份 / 教師屬性）
  - 課表編輯：教師選擇 toolbar 化，操作按鈕移至課表標題行
  - 調代課申請：步驟一+步驟二並排顯示，異動類型卡片緊湊化
  - 調代課紀錄：篩選條件 toolbar 化（標題+日期+教師+查詢同一行）
  - 月結算：選擇條件 toolbar 化（標題+學年度+月份+按鈕同一行）
  - 設定：雲端同步+資料管理雙欄布局
- **Toast 通知系統**：全站通知改為右上角懸浮淡入淡出樣式，取代原有的 `alert()` 阻塞式對話框
  - 支援 success / error / warning / info 四種類型
  - 自動消失並可手動關閉

### 重構
- **移除課表編輯頁籤的新增教師功能**：統一由課表匯入頁籤管理教師資料

### 修復
- 修正設定匯入時呼叫不存在的 `saveData()` 方法導致匯入失敗（改為 `saveDataToStorage()`）
- 調代課申請步驟二固定顯示，不再隨教師選擇切換

---

## [1.8.0] - 2026-04-10

### 新增
- **多重調課批次功能**：支援一次處理多筆調課申請
- **任教領域可編輯**：教師的任教領域可手動修改
- **教師自行調課功能**：教師可自行發起調課申請
- **課表上傳衝突檢查**：上傳課表時自動檢查並提醒教師排課衝突
- **多重調課彈性選課**：移除選課強制限制，改為送出時整批檢查衝突

### 修復
- 修復多重調課批次面板被隱藏及流程中斷問題
- 修正多重調課衝突檢查誤報未涉及節次的原始排課衝突

---

## [1.7.0] - 2026-04-09

### 新增
- **教師課表手動編輯功能**：可直接在介面上編輯教師課表

### 維護
- 整理專案結構，建立 docs 文件目錄

---

## [1.6.0] - 2026-03-27

### 新增功能
- **多節課調代課模式**：一次操作可處理多節課的代課申請
  - 步驟三新增「多節課模式」切換開關
  - 開啟後可點擊選擇多節課程，再次點擊可取消選擇
  - 已選課程以藍色標籤 (chip) 顯示於課表下方
  - 可個別移除或一鍵清除全部已選課程

### 功能優化
- **多節課確認摘要**：步驟四顯示表格形式的多節課清單
  - 依節次排序，清楚顯示班級、科目
  - 共用同一位代課教師和假別
- **多節課 PDF 生成**：
  - 一份四聯 PDF 包含所有選中的課程
  - 週課表中同時標記多個異動節次
  - 班級/科目欄位以標籤形式列出所有課程
  - 檔名包含節次資訊（如：`調代課通知_20260327_王老師_1-3節.pdf`）

### 介面改進
- 新增 `.multi-course-toggle` 滑動切換開關樣式
- 新增 `.course-chip` 已選課程標籤樣式
- 新增 `.schedule-course.multi-selected` 多選狀態樣式（藍色 + 勾選標記）
- 新增 `.multi-course-summary` 多節課摘要表格
- 多節課模式下自動禁用「調課」選項（僅支援代課）

---

## [1.5.0] - 2026-03-25

### 新增功能
- **登入資料同步智慧判斷**：
  - 登入時自動比較本地與雲端的學校名稱
  - 學校名稱相同時：詢問是否合併資料
  - 學校名稱不同時：清除本地資料，載入雲端資料
  - 避免不同學校資料混淆

### 功能優化
- **PDF 課表表格放大**：提升課表可讀性
  - 表格整體字體從 12px 增加至 14px
  - 表頭 padding 從 6px 增加至 10px
  - 節次欄位寬度從 50px 增加至 60px
  - 異動格子字體從 9px 增加至 12px
  - 空白格子高度從 35px 增加至 45px
- **PDF 課表異動欄位**：同時顯示班級、科目及教師資訊
  - 格式：「班級 科目」+ 換行 +「原 OOO / 代 OOO」
- **PDF 表格欄位順序調整**：
  - 第一列：異動類型 | 原任課教師
  - 第二列：日期 | 代課教師

### 修復
- 修復代課教師推薦功能在選擇課程後無法顯示的問題
- 修復 checkExistingRecord 方法調用問題（瀏覽器快取相容性）

---

## [1.4.0] - 2026-03-24

### 重大變更
- **移除 Google Sheets 雲端同步**：改用 Firebase 實現更穩定的雲端同步
- **新增 Firebase 雲端同步**：
  - Google 帳號一鍵登入（Firebase Authentication）
  - Firebase Realtime Database 即時資料同步
  - 支援多設備共享調代課紀錄
  - 離線時自動切換本地儲存模式
- **內建 Firebase 設定**：使用者無需自行設定，開箱即用
- **新增網站底部製作者資訊**

---

## [1.3.3] - 2026-03-23

### 功能優化
- **PDF 通知單黑白列印優化**：全面改用灰階樣式，適合黑白印表機
  - 所有彩色元素改為灰階色調
  - 表頭、標籤等統一使用深灰色系
- **各聯網底標識**：以深灰網底標識各聯重點欄位，便於快速辨識
  - 原任課教師聯：「原任課教師」欄位加網底
  - 代（調）課教師聯：「代課教師」欄位加網底
  - 班級聯：「班級/科目」欄位加網底
  - 教學組聯：無特殊網底，顯示完整資訊
- **各聯資訊差異化顯示**：
  - 代（調）課教師聯：移除「公假字號」欄位
  - 班級聯：移除「請假假別」及「公假字號」欄位
- **課表午休分隔行**：在第四節與第五節之間新增「午休」橫向分隔行，方便辨識上午/下午課程
- **課表異動欄位優化**：顯示原教師與調代課教師姓名（上下兩行排列）
  - 代課模式：「原 OOO / 代 OOO」
  - 調課模式：「原 OOO / 調 OOO」

---

## [1.3.2] - 2026-03-17

### 新增功能
- **資料匯入功能**：支援從備份檔案還原所有資料
  - 選擇 JSON 備份檔案後顯示資料預覽
  - 預覽包含學校名稱、課表筆數、教師數、班級數、調代課紀錄數
  - 確認匯入前會提醒使用者先備份目前資料
  - 匯入完成後自動重新載入頁面套用變更

### 功能優化
- **資料管理區塊重新設計**：
  - 分為「匯出備份」、「匯入還原」、「危險操作」三個區塊
  - 每個功能都有清楚的說明文字
  - 匯入流程加入預覽確認步驟，避免誤操作

---

## [1.3.1] - 2026-03-16

### 修復
- **PDF 課表異動標示**：修正課表異動無法顯示的問題
  - 節次格式從阿拉伯數字改為中文數字（第1節→第一節）
  - 新增節次格式轉換對照表，支援多種格式輸入

### 功能優化
- **調課日期分離**：調課時段 A 與時段 B 可選擇不同日期
  - 時段 A 日期：原課程的調課日期
  - 時段 B 日期：互換課程的調課日期
  - 支援跨週調課，更符合實際調課需求
- **調課介面改進**：
  - 時段 A 資訊卡片（藍色）顯示已選課程與日期
  - 時段 B 選擇區（黃色）選擇互換日期與課程
  - 課程列表根據時段 B 日期對應的星期自動過濾
- **調課預覽表格**：顯示完整的日期與時段資訊
- **PDF 調課通知單**：顯示時段 A 和時段 B 各自的日期

---

## [1.3.0] - 2026-03-16

### 新增功能
- **調代課申請流程優化**：全新步驟式引導介面
  - 步驟一：選擇原任課教師與調課日期
  - 步驟二：選擇異動類型（代課/調課）與假別
  - 步驟三：從課表選擇課程（僅顯示對應日期的課程）
  - 步驟四：確認資訊並提交

### 功能優化
- **異動類型選擇器**：改用卡片式 Radio Button 設計
  - 圖示 + 標題 + 說明，更直觀易懂
  - 代課：👤 他人代理授課
  - 調課：🔄 同班級兩堂課互換時段
- **假別選擇前置**：假別選項移至選擇課程前，減少操作步驟
- **課表日期限制**：根據選定日期自動高亮該日課程
  - 當日課程以黃色邊框標示，可點擊選擇
  - 非當日課程灰色禁用，避免日期錯誤
  - 欄位標題高亮顯示當日星期
- **課程摘要卡片**：選中課程資訊以網格布局呈現，一目了然

### 介面改進
- 新增 `.change-type-selector` 卡片式選擇器樣式
- 新增 `.selected-course-summary` 課程摘要網格
- 新增 `.schedule-course.today-highlight` 當日課程高亮
- 新增 `.schedule-header.active-day` 當日欄位標題高亮
- 步驟卡片過渡動畫，提升使用體驗

---

## [1.2.0] - 2026-03-13

### 新增功能
- **公付假別擴充**：新增兩種不扣時數的公付假別
  - 長期病假（3日以上）：需填寫核准文號
  - 喪假：需填寫喪假證明
- 假別選擇器改為分組顯示（公付假別 / 一般假別）
- 字號欄位依假別類型動態調整標籤和提示文字
- **日期與星期驗證**：防止調課日期與課程星期不符
  - 選擇課程後清空日期，提示用戶選擇正確星期
  - 日期變更時即時驗證，顯示符合（綠色）或不符（紅色）提示
  - 確認提交時再次驗證，不符時提示並建議調整
- **PDF 通知單改版**：全新一式四聯版面設計
  - 每頁左右各一聯，共兩頁（原任課教師聯+代課教師聯、班級聯+教學組聯）
  - 標題區：學校名稱 + 代課通知單 + 聯單類型標籤
  - 基本資訊表格：異動類型、日期、教師、節次、班級/科目、假別、公假字號
  - 該週課表異動表格：僅標記異動課程（藍色），其他留空
  - 底部簽章區：列印日期、申請人、教務處
- **學校名稱設定**：PDF 通知單左上角學校名稱管理
  - 自動從匯入檔名解析學校名稱（支援「國中」「國民中學」「中學」「高中」關鍵字）
  - 於「課表匯入」頁籤提供手動編輯功能
  - 未設定學校名稱時鎖定其他功能頁籤，確保 PDF 輸出完整性
  - 學校名稱持久化存儲於 localStorage

### 修復
- **調課邏輯修正**：重新設計調課功能，符合實際教學調課需求
  - 調課定義：同班級兩個不同時段的課程互換
  - 選擇原課程後，顯示同班級所有其他時段課程供選擇
  - 調課預覽表格：清楚顯示調課前後的時段與教師變化
  - 調課後雙方教師總時數不變，僅授課順序調整
  - PDF 調課通知單：顯示時段 A/B 互換資訊，課表標記兩個異動時段

---

## [1.1.0] - 2026-03-12

### 新增功能
- **設定頁籤**：獨立的系統設定頁面
  - Google Sheets 雲端同步設定
  - 詳細設定教學彈窗（四步驟完整指南）
  - 資料管理功能（匯出備份、清除資料）

### 功能優化
- **調代課紀錄頁籤**：
  - 頁籤名稱改為「調代課紀錄」
  - 表格「事由」欄位改為「假別」
  - 新增「更多」按鈕顯示詳細資料彈窗（事由、公假字號、建立時間等）
  - 切換頁籤時自動載入本月資料
- **月結算頁籤**：
  - 有變動的教師以黃色背景標記
  - 代課增加時數以綠色顯示（+N）
  - 被代課減少時數以紅色顯示（-N）
  - 新增「僅顯示有變動的教師」勾選篩選功能
  - 顯示變動教師總數統計

### 修復
- 新增網站 favicon 圖標，避免 404 錯誤
- Google Sheets 同步 CORS 問題修復（改用 text/plain Content-Type）

### 變更
- Google Sheets 紀錄欄位改用繁體中文
  - 異動類型：substitute → 代課、swap → 調課
  - 假別代碼：official → 公假、personal → 事假、sick → 病假、rest → 休假、other → 其他
- 月結算計算模組支援中英文代碼相容

---

## [1.0.0] - 2026-03-12

### 新增功能
- **課表匯入**：支援人力資源網2.0匯出的 CSV/Excel 課表檔案
- **調代課申請**：
  - 智慧推薦演算法（同領域優先、導師班級加分、空堂教師篩選）
  - 異動類型區分：代課（他人代理授課）/ 調課（兩位教師互換）
  - 假別選擇：公假、事假、病假、休假、其他
  - 公假字號動態欄位（選擇公假時必填）
  - 調課班級驗證（僅顯示同時段有相同班級的教師可互換）
- **PDF 通知單生成**：
  - 四聯單輸出（原任課教師、代課教師、班級公告、教學組存查）
  - html2canvas 中文字型支援
  - 僅顯示異動課程，其他節次留空
- **調課紀錄**：依日期、教師篩選查詢
- **月結算報表**：
  - 假別區分計算邏輯
  - 公假/調課不扣時數（學校公費支付/互換）
  - 事假/病假/休假/其他扣減時數
  - Excel 匯出功能
- **Google Sheets 雲端同步**：
  - Apps Script Web App 後端
  - 支援新增、更新、刪除、批次同步
  - 欄位：ID、異動類型、日期、星期、節次、班級、科目、領域、原任課教師、代課教師、假別代碼、假別名稱、公假字號、事由、建立時間

### 技術架構
- 純前端 SPA（可部署於 GitHub Pages）
- ES6 模組化設計
- CDN 引入：PapaParse、jsPDF、jsPDF-AutoTable、SheetJS (xlsx)、html2canvas
- LocalStorage 本地儲存
- Playwright E2E 測試

### 檔案結構
```
STsystem/
├── index.html              # 主頁面
├── src/
│   ├── css/
│   │   └── style.css       # 樣式表
│   └── js/
│       ├── app.js          # 主應用程式
│       └── modules/
│           ├── dataManager.js         # 資料管理
│           ├── scheduleParser.js      # 課表解析
│           ├── recommendationEngine.js # 推薦引擎
│           ├── pdfGenerator.js        # PDF 生成
│           └── settlementCalculator.js # 月結算計算
├── google-apps-script/
│   └── Code.gs             # Google Apps Script 後端
└── test/
    ├── test-runner.html    # 測試頁面
    └── test-data.csv       # 測試資料
```
