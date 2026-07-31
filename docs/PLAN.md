# STsystem UI 全面重規劃計畫

## Context

使用者需求：「重新規劃 UI，重點放在實用、簡潔、操作邏輯清晰不衝突、在不同裝置能正確顯示、資料顯示恰當不超出」。

現況體檢（兩個 Explore agent + 抽查驗證）發現的核心問題：

- **操作邏輯衝突**：9 個分頁；教師 CRUD 分散 3 頁；4 種編輯/儲存模式並存；「多節課模式」與「多重調課」兩套批次機制重疊、同一顆按鈕兩種語意；alert/confirm/prompt/toast/notify 共 5 種回饋機制。
- **裝置顯示硬傷**：全站 0 個 `overflow-x`，7 種表格（最寬 8 欄+3 按鈕）手機直接撐破；課表格子容器 `overflow:hidden` 導致手機內容被裁切看不到；V2 三分頁樣式 JS 注入且零 media query；斷點混用 600/768/860/900。
- **資料溢出**：全站僅 3 處文字溢出保護、2 處 `min-width:0`；姓名/科目/事由/備註/JSON 都會撐破版面。
- **樣式失控**：按鈕 11 套、卡片 8 套、modal 4 套（`.modal` 定義兩次且語意相反）、表格 5 套、toast 2 套；灰階 slate/gray 雙軌；字級 20 種；z-index 打架、右上角三個 fixed overlay 物理重疊。

**使用者已決策**：(a) 手機是常用場景——表格手機轉卡片、課表單日檢視、申請流程手機優化；(b) 視覺不換風格，保留藍白教務風，建 design tokens 收斂。

**紅線**：不動業務邏輯（dataManager / scheduleParser / recommendationEngine / settlementCalculator / pdfGenerator / authService 及 v2/ 資料流）。app.js / v2-app.js 只改模板字串、class、DOM 結構，不改資料流與演算法。

## 探索期挖出的關鍵事實（實作時必須遵守）

| # | 事實 | 影響 |
|---|---|---|
| F1 | `v2-app.js:1473` 起 `getSubstituteRecords` 被 patch 成回傳全校未過濾紀錄（供推薦引擎，非安全邊界） | V2 紀錄篩選必須在 `renderRecordsTab()` 內自建，**不可**解除隱藏 `#records-content`（會重演 commit 8e241f2 修掉的個資外洩） |
| F2 | 所有 modal 都在 `.tab-content` 內（已驗證：record-detail/weekly-summary 在 `#records-content` 內、sync-conflict/merge-confirm 在 settings-tab 內） | 不在該分頁時 modal 顯示不出來（既有潛在 bug）；全部搬到 `<body>` 尾端 `#modal-root`。全靠 `getElementById` 存取，搬家不斷事件 |
| F3 | `v2-app.js:1023 interceptSubmitButton()` 對 `#confirm-substitute-btn` 用 capture + stopImmediatePropagation 做權限攔截 | 新增「加入批次」獨立按鈕時必須同步加入攔截清單，否則繞過權限閘門 |
| F4 | `confirmMultiCourseSubstitute()` (app.js:2476) 開頭 `if (!this.selectedSubstitute) return` | 「多節課模式」在調課下勾了也無效——改為僅代課時顯示該 toggle |
| F5 | `test/v2-smoke-test.js:32` 硬性斷言 `#v2-styles` 存在 | V2 樣式併入主 CSS 時保留 `#v2-styles` 元素（只縮減內容為角色顯隱規則） |
| F6 | `pdfGenerator.js` 把 inline-styled DOM 掛到 body 餵 html2canvas | 新 CSS 不得新增裸元素全域選擇器（`table{}`、`*{min-width:0}` 等），reset 維持現狀，否則 PDF 版面漂移 |
| F7 | `handleTeacherDataChange()` (app.js:1125) 每次 change 已自動存 | `#save-data-btn`「儲存資料」是冗餘假鈕，直接移除改為「變更已自動儲存」狀態文字 |
| F8 | `index.html:566` 用了 CSS 從未定義的 `.btn-default` | 收斂時改 `.btn-secondary` |
| F9 | style.css 的 `<link>` 無 `?v=` 版本參數 | Stage 0 就加 `?v=2.0.0`，每階段遞增，防 GitHub Pages 舊快取 CSS 配新 HTML |
| F10 | `updateTabLockStatus()` (app.js:920) 直接寫 inline `style.opacity/cursor` | 改為 toggle class `is-locked`，否則 inline 蓋掉新 CSS |

## 方案總覽

### 1. 資訊架構：9 分頁 → 8 分頁（高頻 3 + 管理 5，中間分隔線）

| 群組 | 分頁 | data-tab | 組成 | 角色 |
|---|---|---|---|---|
| 高頻 | 調代課申請 | `substitute` | 不變 | 全部 |
| | 待辦 | `v2-pending` | 不變 | `v2-only` |
| | 調代課紀錄 | `records` | 不變 + V2 補回日期/教師篩選與週彙整入口 | 全部 |
| 管理 | 課表管理 | `schedule` | import-tab（上傳/校名）+ schedule-editor-tab（週課表編輯）合併為 sub-view | `v2-approver-only` |
| | 教師管理 | `teachers` | 教師屬性表 + 刪除教師 + V2 帳號/角色，集中一頁 | `v2-approver-only`（帳號欄 `v2-director-only`） |
| | 月結算 | `settlement` | 不變 | `v2-approver-only` |
| | 操作日誌 | `v2-logs` | 不變 | `v2-only v2-approver-only` |
| | 設定 | `settings` | 分權：學年度/科目領域/資料管理加 `v2-approver-only`，危險區加 `v2-director-only` | 全部 |

- 角色可見數：V1 單機 6、V2 教師 4、V2 組長/主任 8。
- 教師管理頁**不合併兩支 render 函式**（資料源與寫入語意不同）：同一分頁內 `#teacher-editor`（V1 render）與 `#v2-teachers-admin`（V2 director render）互斥顯示。V2 approver 非 director 看 V1 版。
- 手機導覽：**頂部可捲 tab bar**（不做底部導覽列——角色分頁數 4~8 動態，底部固定格會造出第二套顯隱規則）。`.nav-tabs` 加 overflow-x + scroll-snap，active tab `scrollIntoView`；現有三處 `.tab-btn` 查詢程式零改動。
- 手機拇指問題改以**申請頁 sticky action bar** 解決（步驟四按鈕列 `position:sticky;bottom:0`）。

### 2. Design tokens：新檔 `src/css/tokens.css`（第一個載入）

- **色彩**：品牌藍 6 階 + slate 中性 11 階（殺掉 gray 系，v2 的 #6b7280 等全部映射）+ 語意狀態各 4 階（success/warning/danger/info）+ 語意別名（bg/surface/border/text/accent）。
- **相容別名層**：現有 13 個舊變數（--primary-color 等）全部指向新 token → token 檔一加，2792 行舊 CSS 立即吃新色票、零視覺變動（Stage 0 成立的關鍵）。
- **字級**：7 階（11/12/13/14/16/18/22px 對應 rem），`html` 16px 基準、body 用 `--fs-md`（修 rem 脫鉤）。現 20 種混雜值吸附到最近階。
- **間距**：4px 基準 scale（--sp-1 ~ --sp-12）+ 卡片/頁面 padding 別名。
- **圓角/陰影/控高**：--r-xs~pill、--sh-1~3 + focus ring、--ctl-h 36 / --ctl-h-touch 44 / --ctl-h-sm 30。
- **斷點**：只有兩個，mobile-first 全 min-width：**640px**（卡片→表格、單日→週課表）、**1024px**（雙欄版面開啟）。CSS 註解集中宣告，禁止第三個數值。
- **z-index**：--z-sticky:100(header) / --z-veil:200(tab-locked，修與 header 同 100 打架) / --z-modal:1000 / --z-authgate:1100 / --z-authmodal:1200 / --z-toast:1300（修 toast 被登入 modal 蓋住）。

### 3. 元件收斂（三檔處置：A 保留名收斂實作 / B 一次全換 / C 刪死碼）

- **按鈕 11→1**：`.btn` + variant（primary/secondary/danger/ghost/google/block）+ `.btn-sm`。`.btn/.btn-primary/...` 為 Tier A 保留名；`.btn-xs/.btn-more/.btn-default/.btn-link/.btn-signout/v2 gate 鈕` Tier B 換掉；`.btn-success`（0 引用）Tier C 刪。手機 `min-height:var(--ctl-h-touch)`。**禁止給列操作按鈕加子元素**（app.js:3443/3454/3466/3043 用 `e.target.dataset.id`，加 icon 會靜默失效）。
- **卡片 8+3→1**：`.card`（合併兩份定義，padding 採 compact 值）+ `.card-notice/.card-warning/.card-danger` + `.list-item`（v2-pending-item 改）。`.compact-card` 刪定義並移除 class 字串（含 v2-app.js:873）。互動選取卡（change-type/recommendation/batch-swap/conflict-option）保留各自名、統一 border/radius/hover/selected 宣告。
- **Modal 4→1**：刪 style.css:1037 的 box 版 `.modal` 與 :1024 死碼 `.modal-overlay`；保留 :1147 overlay 版為唯一定義；`.v2-modal*` 全換 `.modal/.modal-content/.modal-actions`。統一結構 `.modal > .modal-content > (.modal-header,.modal-body,.modal-actions)`。**手機全螢幕化**（100dvh、body 捲動、actions sticky bottom）。前置：5 個 modal 搬到 `#modal-root`。
- **表格 5→1**：`.data-table`(+`-compact`) 唯一實作；刪 `#teacher-table` nth-child 固定寬 470px；`.multi-course-table/.v2-log-table` 換 `.data-table-compact`；調課預覽 inline 表(app.js:1658)改 `.data-table`。新增 `.table-wrap`（overflow-x）與 `.data-table-cards`（手機卡片化）。
- **Toast 2→1**：`.toast` 唯一實作，位置改桌機右下/手機底部滿寬（避開 header 選單與 sticky bar）；uiFeedback.js 保留 fallback 程式路徑但共用 `#toast-container` 與 `.toast` class、刪其 CSS 注入；`#v2-sync-status-badge` 移入 header（解除右上角三疊）。

### 4. 表格手機卡片化（CSS-only data-label 法，已驗證可行）

所有表格事件綁定都用 class 選擇器或 `closest('tr').dataset.id`，無 nth-child 依賴 → 純加屬性即可，不動選擇器、不動 render 尾端綁定區塊。

- 轉卡片（5 表）：`#records-table`(app.js:3419, 8td)、V2 全校紀錄(v2-app.js:907, 8td)、V2 日誌(v2-app.js:850, 6td，JSON code 加 line-clamp)、V2 教師管理(v2-app.js:558, 5td，刪 email input 220px 硬寬)、`#teacher-tbody`(app.js:1078, 4td)。做法：`<td>` 加 `data-label`、操作欄加 `.cell-actions`、主欄加 `.cell-primary`、`<table>` 加 `data-table-cards`。共 5 支函式 31 個 td，純屬性新增。
- 不轉、用 `.table-wrap` 橫捲：`#settlement-table`（數值比較表 + 首欄 sticky）、科目領域表、multi-course-table（已夠窄）。

### 5. 課表手機單日檢視

- **申請頁 grid**（app.js:1724 `renderTeacherScheduleWithHighlight`）：已算出 `isActiveDay` → 樣板 3 處加 `is-day-active` class（標題列/有課格/空堂格，空堂格補 data-weekday）+ 容器 toggle `schedule-grid-single`。CSS：手機 `grid-template-columns:3.5rem 1fr` + 非 active 日 cell `display:none`；≥640px 恢復 5 欄週檢視。`.schedule-cell` 加 `min-width:0;overflow-wrap:anywhere`（修裁切）。
- **課表編輯 grid**（app.js:4255）：無日期上下文 → 加 `#editor-day-switcher`（手機才顯示的 5 顆日切換鈕，~25 行 JS）。切換器綁定寫在 `renderEditableScheduleGrid()` 內（沿用每次 render 重綁模式，不累積 listener）。桌機隱藏切換器、全週顯示。

### 6. 批次機制：不合併 JS，只做 UI 統一（已決策）

兩機制資料形狀不同（多節課=同日同師多節共用一位代課；多重調課=N 組跨日跨師配對），合併會跨紅線碰 V2 審核狀態機與 Firestore rules、重寫 43 案測試。UI 統一四動作：

1. **拆同鈕兩語意**：新增 `#add-to-batch-btn`（綁同一個 `confirmSubstitute()`，內部已依 mode 分流）；app.js:1194/1287/1201 改 toggle 兩鈕 hidden、移除 textContent 改寫。**F3 必辦**：`interceptSubmitButton` 攔截清單加入新鈕 id（安全性，同 commit + 補測試案）。
2. **修 F4**：`onChangeTypeSelected` 內——多節課 toggle 僅代課時顯示；切走時走 `onMultiCourseModeToggle(false)` 既有清理路徑。
3. **兩累積區共用 `.selection-tray` 元件**：統一標題列/清除鈕/容器樣式；手機 sticky bottom 收合為摘要條。
4. **文案去歧義**：「多節課模式」→「一次選多節（同一天）」；批次面板標題→「待送出的調課組合」。

### 7. 其他操作統一（Stage 5）

- **統一 confirm modal**：`confirmDialog({title,message,confirmText,danger}) → Promise<boolean>`，替換 12+5 處原生 confirm。**R11**：逐處確認呼叫端可 async 化；不能的保留原生並記豁免清單。
- **消滅 prompt()**：v2 拒絕原因 → textarea modal；v2 新增教師（v2-app.js:631）→ 雙欄位 modal。
- **儲存模式原則**：本機寫入=change 即存+微回饋（移除假儲存鈕 F7；科目領域表維持即存）；遠端交易=明確送出鈕（`.v2-save-teacher` 保留）。
- **V2 紀錄頁補篩選**（F1 方式）：`renderRecordsTab()` 內加起訖日+教師 select 過濾 `visible`；「列印本週彙整」鈕包 `v2-approver-only` 呼叫 `window.app.openWeeklySummaryModal()`（前提 Stage 2 modal 已搬家）。
- **`#change-type` 隱藏 select**：保留 + 註解（19 處讀寫的機械替換零使用者收益），列 Stage 6 選配。
- **備份還原去重**：只留設定頁那份（`_importContexts` 降為單 context，app.js:3729-3742 刪 tab 鍵與 6 個綁定）；課表管理頁放「備份還原請至設定」跳轉連結。

## 六階段實作（每階段獨立 commit、獨立驗證、獨立回滾）

| Stage | 內容 | 檔案 | 驗證 |
|---|---|---|---|
| **0 Token 基座** | tokens.css 全部 token + 13 舊變數別名；`<link>` 加 `?v=2.0.0` | 新 `src/css/tokens.css`、index.html | 逐頁截圖與改前比對應完全相同；`npm run check` |
| **1 硬傷急救** | `.table-wrap` 包 7 表；`.schedule-cell` min-width:0+overflow-wrap；全域補 min-width:0；清 768 下 min-width:180px；6 處 flex-wrap；email input 寬修正；z-index 換 token；sync badge 移 header；F10 inline→class | style.css（追加 hotfix 區塊）、index.html、app.js:920、v2-app.js、uiFeedback.js | 375×667 逐頁 `scrollWidth<=innerWidth`；三 overlay 互不遮蔽 |
| **2 資訊架構重組** | 9→8 分頁；教師 CRUD 集中；modal 搬 `#modal-root`；備份去重；設定頁分權；分頁鎖補 schedule；手機可捲 tab | index.html、app.js（624/920/949 區）、v2-app.js（78-79/951/977） | V1 六分頁+鎖正確；三角色可見數 4/8/8；**R1 斷言：教師身分下 `#records-content` computed display==='none'** |
| **3 CSS 重寫+元件收斂** | 拆 tokens/base/components/features 四檔刪 style.css；mobile-first 640/1024；Tier A/B/C 映射；54 hex→token；V2 注入樣式縮為角色顯隱規則（保留 `#v2-styles` F5） | 新 base/components/features.css、index.html、v2-app.js:28-190、uiFeedback.js、test/v2-smoke-test.js | check-syntax；smoke test；雙 viewport×8 分頁目視；**PDF 回歸比對**（F6） |
| **4 手機專屬模式** | 5 表卡片化（data-label）；課表單日檢視×2；modal 全螢幕；selection-tray；申請頁 sticky action bar | components.css、app.js（1078/3419/1724/4255）、v2-app.js（558/850/907）、index.html | 375 下卡片標籤正確；單日課表；編輯器日切換後格子仍可點開 modal（最易斷處）；640 以上復原 |
| **5 操作邏輯統一** | confirmDialog 替換 17 處；殺 prompt；假儲存鈕移除；V2 紀錄篩選+週彙整；批次 UI 四動作（含 interceptSubmitButton 同步 R2） | app.js、v2-app.js、index.html、components.css | grep 原生對話框只剩豁免清單；非本人點兩顆送出鈕都被攔；`node test/v2-approval-flows.mjs` |
| **6 清理** | 刪 Tier C 死碼與 Tier A alias（grep 確認零引用）；111 處 inline style 收 utility class；選配：#change-type 移除 | 全部 | `grep -c 'style="'` 降至個位數；全站截圖回歸 |

## 風險與防範（實作時對照）

- **R1 致命｜V2 個資外洩**：Stage 2 動 records 結構時，v2-app.js:78-79 子代選擇器同步改（用明確 id），驗證強制含教師身分 display none 斷言。
- **R2 致命｜權限繞過**：`#add-to-batch-btn` 與 interceptSubmitButton 修改必同 commit，補測試案。
- **R3 高｜綁定靜默失效**：**綁定選擇器凍結清單**（不得改名）：app.js `.detail-btn .reprint-btn .delete-record-btn .teacher-input .delete-teacher-btn .subject-domain-input .subject-domain-del-btn .batch-remove-btn .schedule-course.selectable .editor-course .editor-empty .recommendation-item .toast-close`；v2-app.js `.v2-save-teacher .v2-delete-teacher .v2-send-reset .v2-consent-btn .v2-reject-btn .v2-final-approve-btn .v2-cancel-btn .v2-dismiss-btn .v2-download-pdf .v2-admin-delete .v2-email-input .v2-role-select .tab-btn .tab-content`；所有 #id（尤 `#confirm-substitute-btn #records-content #toast-container #v2-styles`）。
- **R4 高｜e.target 陷阱**：列操作鈕不加子元素。
- **R5 高｜PDF 漂移**：不新增裸元素全域選擇器；Stage 3 必做 PDF 比對。
- **R8 中｜display:revert**：不動 `.tab-content`/`.hidden` 的 display 語意。
- **R11 中｜confirm async 化**：不能安全改的保留原生並記豁免。
- **R12 低｜重複 listener**：切換器綁定寫在 render 函式內。

## 驗證計畫

- 環境：`python start-server.py` → http://localhost:8000（V1）與 `?v2=1`（V2）。
- 自動化：`npm run check`、`node test/v2-smoke-test.js`、`node test/v2-approval-flows.mjs`、`npm test`（三支業務測試全程不得變動——若需改即代表越線）。
- 矩陣：2 模式 × 3 viewport（375×667 / 768×1024 / 1440×900）× 8 分頁，用瀏覽器工具實測；每頁通用斷言：無橫向溢出、無文字裁切、可點目標 ≥44px（手機）、console 無 error。
- 關鍵流程實測：申請（含多節課/多重調課/權限攔截）、紀錄（V1 查詢、V2 三角色可見性）、課表管理（上傳 test-data.csv、編輯器日切換後點格開 modal）、教師管理（即存驗證、角色欄顯隱）、PDF 兩種各產一份比對。
- 建議新增 `test/ui-rwd-check.mjs`（playwright 走訪矩陣，斷言 scrollWidth/卡片化/單日 cell 數/R1 display none）。

## 執行方式

- 依 playbook 分工：主對話（Fable）負責決策與驗看；每 Stage 實作派 `sonnet` agent（帶本計畫對應段落 + 凍結清單 + F/R 事實）；Stage 完成後派 `opus` fresh agent 驗收（實跑 + 瀏覽器檢查清單）；驗收通過才 commit（`refactor:`/`feat:` 前綴、繁中描述）。
- 每 Stage 更新 CHANGELOG.md 與 docs/CHANGELOG.md；發現新問題記 docs/ISSUES_LOG.md。
- 計畫獲准後：先複製本計畫到專案 `docs/PLAN.md`（硬規則 5），再開 Stage 0。
- 全部完成後：跑 code-review skill、push、開瀏覽器展示成果。

## 關鍵檔案

- `src/css/style.css`（2792 行 → 拆 tokens/base/components/features 四檔）
- `index.html`（915 行：IA 重組、modal 搬家、表格 wrapper、inline style 清理）
- `src/js/app.js`（4852 行：樣板字串與綁定；重點行 624/920/949/1078/1194/1287/1332/1658/1724/2476/3419/3670/3729/3839/4255/4815）
- `src/js/v2-app.js`（1958 行：注入樣式 28-190、render 402/536/841/888、攔截 1023、records 隱藏 78-79）
- `src/js/modules/v2/uiFeedback.js`（toast 二號實作、sync badge）
- `test/v2-smoke-test.js`、`test/v2-approval-flows.mjs`（同步維護）
