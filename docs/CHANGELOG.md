---
created: 2026-03-12
updated: 2026-07-29
tags:
  - changelog
---

# 版本紀錄

---

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
