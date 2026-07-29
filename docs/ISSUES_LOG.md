---
created: 2026-04-10
updated: 2026-07-09
tags:
  - issues
  - troubleshooting
---

# 問題追蹤：國中調代課自動化系統

## 商用上線實戰化實測（2026-07-29）

第一次對 preview 站與 production Firestore 做真實三角色端到端實測（此前所有「待實機驗收」項目從未執行）。以下為實測發現。

### 全校請假紀錄的個資外洩（假別可被任一登入教師讀取）

- **日期**: 2026-07-29
- **狀態**: 🟢 已解決（commits `8e241f2` 資料層 + `e23f79d` UI 層，線上 ruleset `bd1a6f7a-d662-48cf-8d6d-d2f87c055aab`）
- **描述**: `firestore.rules` 對 `substituteRecords`（第 166 行）與 `pendingRequests`（第 198 行）的讀取規則是 `if isSignedIn()`，任一登入教師用瀏覽器開發者工具即可讀到全校同仁的調代課紀錄，其中 `leaveType` 含長期病假／喪假／事假／病假，屬敏感個資。前端的 `roleService.filterRecordsForCurrent` 只擋 UI、擋不住 API。
- **原因**: Firestore 安全規則無法做欄位級隱藏，敏感欄位與排課資訊放在同一份文件，就只能一起開放或一起關閉；而衝堂檢查與代課推薦需要全校的排課資訊，因此當初選擇整份開放。
- **解決方案**（使用者裁定範圍：只搬假別與事由，排課資訊維持全校可讀）:
  - 新增 `{substituteRecords|pendingRequests}/{id}/private/detail` 子文件，只放 `leaveType` / `leaveTypeName` / `reason`，外加 `allowedTeacherIds` 自帶 ACL
  - 讀取規則 `isApprover || myTeacherId in allowedTeacherIds`。**私有文件自帶 ACL** 的用意是讓規則不必 `get()` 父文件即可判斷，成本低，也避開「先寫父文件還是先寫子文件」的循環相依
  - 寫入順序刻意為「先 private 再父文件」：private 失敗即中止，不留下「紀錄存在但假別遺失」的狀態——假別遺失會讓月結算把不扣減的假別誤算為扣減
  - `approveRequest` 在交易外先讀出請求的私有明細並寫好新紀錄的私有文件（recordId 交易前已知），交易本身維持原狀，避免超出 Firestore 對交易的規則 document access 配額
  - UI 層以 `hydrateRecordsWithDetail` 依身份批次補讀（approver 全部、教師僅與己相關），併回 `_v2RecordsCache` 供月結算使用；產 PDF 前亦補讀。加世代守門避免補讀的 await 造成舊身份資料回填
  - 向後相容：讀取端一律 `detail?.leaveType ?? record.leaveType`，舊紀錄不會壞掉
- **額外收緊（審查自己的改動時發現）**: 私有文件的 create 規則若只要求「把自己列在 ACL 內」，教師可對尚無私有文件的紀錄補建一份，把假別注入為公假／長期病假／喪假來規避月結算的授課時數扣減——與 Phase 3 封掉的「自寫代課紀錄灌代課費」同類。已加上「非 approver 建立紀錄私有文件時假別必須是調課類」的限制，對應教師唯一能直接寫入 `substituteRecords` 的自我調課情境。代課請求不受此限，因為該路徑的控制點是組長審核。
- **驗證**: 教師讀非當事人的假別 DENY、讀排課資訊 ALLOW、組長讀假別 ALLOW；假別注入攻擊（公假／長期病假／喪假／事假）4/4 被擋，自我調課合法路徑（調課／swap）2/2 通過；既有那筆含「長期病假」的正式紀錄已遷移，父文件不再帶敏感欄位（原始值已備份）。
- **踩坑紀錄**: 用 PowerShell 5.1 測試時，字串型 request body 的中文未以 UTF-8 送出，導致 `leaveType in ['調課','swap']` 對合法路徑誤判為 DENY，一度誤以為規則寫錯。改以 `[Text.Encoding]::UTF8.GetBytes()` 送出位元組後結果正確。**測試含中文的規則條件時必須先確認編碼**，否則會得到假的失敗訊號。
- **相關檔案**: `firestore.rules`、`src/js/modules/v2/schoolDataService.js`、`src/js/modules/v2/pendingRequestService.js`、`src/js/modules/v2/schemaConstants.js`、`src/js/v2-app.js`

### 收尾 opus 對抗式審查發現（2026-07-29）

- **日期**: 2026-07-29
- **狀態**: 🟢 全數已修（commits `c273c1b`、`63d97bc`、`e63b0f1`）
- **描述**: 本次商用整備的 14 個 commit 由多個 agent 平行實作，收尾時派獨立 opus agent 做對抗式審查與商用就緒驗收，共找出 9 個問題。審查同時獨立查證並確認了 6 項實作者宣稱的假設（isMultiSwap 確為死欄位、batchId 時序正確、setSchoolName 僅使用者觸發、V1 行為完全不變、CSV 匯入冪等）。
- **已修問題**:
  1. 【critical】遷移來源挑選永遠挑錯——以 `lastModified` 決定「取較新者」，但 localStorage 的 payload 出自 `dataManager.exportToStorage()`，該物件根本沒有這個欄位，導致 localStorage 恆判為最舊、Firestore 永遠勝出。主任若長期離線用本機會靜默遷到舊快照。→ 改為兩來源都遷移取聯集，重疊由既有冪等鍵去重。
  2. 【critical】遷移卡片永久假警報——只看來源物件存在、不看筆數，而 V2 自己會持續重寫該 localStorage key。→ 只認 `substituteRecords` 非空的來源。
  3. 【major】`detectLegacyData()` 失敗會癱瘓整個教師管理頁（無 try/catch 且在 `innerHTML='載入中…'` 之後）。→ 降級為「無舊資料」。
  4. 【major】patched `getSubstituteRecords` 回傳內部快取參考而非複本，下游 `.sort()`/`.splice()` 會汙染衝堂檢查的資料源；且 `(startDate,endDate,teacherFilter)` 參數被靜默吞掉（`getMonthlyRecords` 內部正是帶參數呼叫）。→ 回傳複本並比照原實作套用篩選與排序。
  5. 【major】「確認學校名稱」會整包覆寫全校課表——`syncScheduleToV2` 寫本機完整快照且允許空課表寫入，若在遠端快照抵達前按下確認會用空課表覆蓋全校。→ 加 `requireSchedule` 守門，僅對 `setSchoolName` 啟用。
- **教訓**: 多個 agent 平行修改同一個檔案時，各自的假設可能互相衝突（例如「加進課表回寫白名單」這個修法對課表異動方法成立、對 setSchoolName 不成立）；收尾一定要派沒有參與實作的 agent 做對抗式審查，實作者的合理化說詞會讓自驗失效。
- **相關檔案**: `src/js/modules/v2/legacyMigrationService.js`、`src/js/v2-app.js`、`test/test-legacy-migration.mjs`

### 月結算學年度下拉寫死 114/113，新學年度將結不出帳

- **日期**: 2026-07-29
- **狀態**: 🟢 已解決（commit `63d97bc`）
- **描述**: 商用就緒驗收發現——`index.html` 的 `#settle-year` 只有 114 與 113 兩個寫死選項。發現當天是 2026-07-29（民國 115 年 7 月），下個月起即進入 115 學年度，屆時 `settlementCalculator` 的篩選永遠選不到當期資料，**上線第一個月的代課鐘點費就結不出來**。此缺陷 master 正式站同樣存在。
- **解決方案**: `src/js/app.js` 新增 `getCurrentAcademicYear()`（台灣學年度自 8 月起跳）與 `populateSettlementYearOptions()`，於 `bindSettlementEvents` 初始化時依實際日期產生「當前學年度 +1 ～ -2」共 4 個選項並預設選中當前學年度；`index.html` 的 select 清空改由 JS 填入。
- **驗證**: 邊界日期 2026-07-31→114、2026-08-01→115、2027-01-15→115 皆正確；V1 與 V2 模式實機皆產生 115/114/113/112 且選中 114。
- **相關檔案**: `src/js/app.js`、`index.html`

### approver 設定的學校名稱不回寫全校課表，導致全校教師永久卡在課表匯入頁

- **日期**: 2026-07-29
- **狀態**: 🟡 修補中
- **描述**: approver 依標準順序「上傳課表 → 填學校名稱 → 確認」之後，`schools/inhu/data/schedule.schoolName` 仍是空字串。所有教師端登入後只能停留在「課表匯入」頁，點其他任何頁籤都沒反應（toast 提示「請先設定學校名稱」，但教師根本沒有權限設定）。
- **原因**: `src/js/app.js:949-969` `canSwitchToTab()` 同時要求 `hasSchedule` 與 `schoolName`，缺一即擋下除 import/settings/schedule-editor 外的所有頁籤。使用者確認學校名稱走 `app.js:883` 的 `dataManager.setSchoolName(name)`，但 `src/js/v2-app.js` 觸發雲端回寫的方法白名單只有 `setScheduleData` / `addScheduleEntry` / `updateScheduleEntry` / `removeScheduleEntry` 四個，**不含 `setSchoolName`**。`syncScheduleToV2()` 的 payload 其實已經包含 `schoolName`，缺的只是觸發點。
- **嚴重度**: 上線第一天必然發生，且症狀（教師點頁籤沒反應）不會指向真正原因。
- **解決方案**: 把 `setSchoolName` 加進 v2-app.js 的課表回寫方法白名單。V2 專屬修改，不動 app.js。
- **相關檔案**: `src/js/v2-app.js`（wrapScheduleMutator 白名單、syncScheduleToV2）、`src/js/app.js`（canSwitchToTab、setSchoolName 呼叫點，唯讀參照）

### 多重調課全員同意在 UI 上永遠觸發不了，後端狀態機成死碼

- **日期**: 2026-07-29
- **狀態**: 🟡 修補中
- **描述**: 一般教師走「調課」流程送出後，理應詢問「是否還有其他教師需一併同意」的彈窗永遠不出現，只會建立雙簽 swap，無法升級為 multi_swap。Phase 3 實作的多重調課全員同意狀態機（含 firestore.rules 的相關條款）從 UI 完全無法到達。
- **原因**: `src/js/app.js:2923` `buildSwapRecord()` 對**單次與批次調課一律**寫死 `isMultiSwap: true`（該函式被 `app.js:2466` 單次與 `app.js:3219` 批次兩處共用），而 `src/js/v2-app.js:1140` 的守門條件含 `!record.isMultiSwap` → 恆為 false → modal 永不出現。`record.isMultiSwap` 在 V1 沒有任何讀取點（`this.isMultiSwapMode` 是另一個獨立的 UI 狀態屬性），屬誤導性死欄位。
- **驗證後端無誤**: 以直接呼叫應用層函式繞過此觸發點，multi_swap 請求在教師乙、組長丙皆同意後正確轉 approved，產生的紀錄 `affectedTeacherIds` 含三人——問題純粹在觸發條件。
- **解決方案**: 批次調課的紀錄在 `app.js:3224` 於 `addSubstituteRecord` 呼叫**之前**被賦予 `batchId`，單次調課沒有。守門條件改用 `!record.batchId` 精確區分，完全不需修改 app.js。
- **相關檔案**: `src/js/v2-app.js`（writeV2Record 的多重調課詢問守門）

### 三種審核流程首次端到端實測結果

- **日期**: 2026-07-29
- **狀態**: 🟢 代課單簽、調課雙簽、中途拒絕通過；多重調課因上述觸發缺陷卡關
- **描述**: Phase 3 審核工作流自 2026-07-09 完成後從未有真人或自動化跑過完整流程。本次以三個測試帳號在真實環境跑完，並留下 36 張截圖（`test/e2e-screenshots/`，已於 .gitignore 排除不進版控）。
- **結果**:
  - 代課單簽：教師發起 → 組長核准 → 正確產生 substituteRecords，狀態 approved
  - 調課雙簽：教師甲對教師乙發起 → 乙同意 → 組長核准 → 正確產生紀錄
  - 多重調課：UI 觸發點失效（見上一條），後端狀態機經繞過驗證正確
  - 中途拒絕：狀態正確轉 rejected，**未**產生 substituteRecords，發起人可見拒絕提示並可清除
  - 教師身份的「調代課紀錄」範圍正確受限（教師 9 筆 / 組長 10 筆）
  - 教師身份在「課表匯入」頁雖可見並點擊「+新增教師／儲存資料／匯入還原」，但實際點擊後 production 的 teachers 與 schedule 文件均無變化——rules 正確擋下，屬 UI 冗餘而非安全問題
- **相關檔案**: `test/v2-approval-flows.mjs`（本次新增的端到端腳本）

### 全校課表從未上傳，系統對教師是空殼

- **日期**: 2026-07-29
- **狀態**: 🟠 待使用者操作（非程式缺陷，但沒做等於沒上線）
- **描述**: `schools/inhu/data` 集合 0 筆——Phase 2「全校課表共享」標記完成，實際上從未有任何課表寫入。以測試教師帳號登入 preview 站後，所有頁籤點擊無反應，畫面停在「尚未載入課表資料，請先至『課表匯入』頁籤上傳課表檔案」。
- **原因**: `src/js/app.js:633` `canSwitchToTab()` 在無課表資料時鎖住所有頁籤。這是 V1 既有的正確行為，但 V2 的全校共享模式下，教師端不會自己上傳課表——必須由 approver 先上傳，教師才有東西可用。
- **解決方案**: 上線前置作業——由教務主任或教學組長登入後至「課表匯入」上傳當學期人力資源網 2.0 課表。實測已上傳測試課表驗證此路徑可行（上傳後 `data` 集合出現 1 筆，教師端即時同步取得）。
- **相關檔案**: `src/js/app.js`（canSwitchToTab）、`src/js/v2-app.js`（subscribeSchedule / applyRemoteSchedule）

### 月結算頁籤對一般教師可見（權限標記漏加）

- **日期**: 2026-07-29
- **狀態**: 🟢 已解決（commit `5ec4561`）
- **描述**: 以一般教師身份登入 preview 站，頁籤列出現「月結算」。
- **原因**: `src/js/v2-app.js` `injectV2Styles` 的註解本身就載明「`.v2-approver-only` — 限 director 或 section_chief 可見（核准 / 紀錄 / **月結算** / 操作日誌）」，`docs/PLAN_v2.0.0.md` §6 也把 settlement 列為 approver 限定，但 `index.html` 的月結算頁籤按鈕與面板從未加上這個類別。屬實作遺漏而非設計決策。
- **解決方案**: `index.html` 月結算頁籤按鈕（59-67 行區塊）與 `#settlement-tab` 面板各補 `v2-approver-only`。`.v2-approver-only` 的 CSS 以 `body.v2-active` 為前提且只存在於 V2 動態注入的 style，`src/css/style.css` 完全沒有 `.v2-` 規則，故 V1 正式站不受影響。
- **驗證**: 本機 `?v2=1` 實測——教師甲頁籤列為「課表匯入/調代課申請/調代課紀錄/待辦清單/設定」（月結算已消失），組長丙仍保有月結算、課表編輯、操作日誌。`test/v2-isolation-test.js` V1 隔離回歸通過。
- **相關檔案**: `index.html`

### 運維腳本檢查錯誤的學校路徑

- **日期**: 2026-07-29
- **狀態**: 🟢 已解決（commit `f85328b`）
- **描述**: `scripts/firestore-snapshot.js` 與 `scripts/firestore-health-check.js` 的集合路徑寫死 `schools/default`，但正式資料自 v2.0.0 起在 `schools/inhu`（`schemaConstants.js:14`）。
- **原因**: schoolId 從 default 遷移到 inhu 時只改了應用程式端，運維腳本沒有同步。
- **影響**: 健檢「全綠」一直是對 2026-04 alpha 期舊備份學校的結果，對正式環境毫無意義；快照備份也備錯對象。
- **解決方案**: 兩支腳本改為 `--school=` 參數（預設 `inhu`），並在輸出開頭印出實際檢查對象，保留 `--school=default` 可檢視舊備份。
- **相關檔案**: `scripts/firestore-snapshot.js`、`scripts/firestore-health-check.js`

### director 有兩筆重複教師檔

- **日期**: 2026-07-29
- **狀態**: 🟠 待使用者確認後清理（production 資料，未自行刪除）
- **描述**: `schools/inhu/teachers` 有兩筆同名同 email 同角色的主任檔：`tch_1780040513944_kl4wgr9`（`authProvider=google.com`，**使用中**——userMappings 指向它、既有正式紀錄的 `adminOperatorId` 也是它）與 `tch_1780040513944_qf7vp5g`（`authProvider` 空，**無任何文件引用**）。兩筆 `createdAt` 完全相同，應為 bootstrap 競態產生。
- **風險**: `schoolDataService.js:48-53` `findTeacherByEmail` 回傳第一筆符合者，目前靠文件 ID 字典序（`k` < `q`）碰巧命中正在使用的那筆。若排序改變或有人編輯孤兒檔，身份綁定會飄移；教師管理 UI 也會看到主任重複出現。
- **建議解法**: 確認無引用後刪除 `tch_1780040513944_qf7vp5g`（需 director 權限）。
- **相關檔案**: `src/js/modules/v2/schoolDataService.js`（findTeacherByEmail）、`src/js/modules/v2/authGuardV2.js`

### 全校調代課紀錄與待審請求對任何登入教師 API 可讀

- **日期**: 2026-07-29
- **狀態**: 🟠 設計層風險，待決策（不在本次修補範圍）
- **描述**: `firestore.rules:166` `substituteRecords allow read: if isSignedIn()`；`rules:198` `pendingRequests` 同樣全員可讀。規則註解自承「教師端由 `roleService.filterRecordsForCurrent` 過濾」——過濾只發生在前端。
- **影響**: 任一登入教師用瀏覽器 DevTools 直接查詢 Firestore，即可讀到全校同仁的調代課紀錄，其中 `leaveType` 含長期病假／喪假／事假／病假，屬敏感個資。UI 擋得住，API 擋不住。
- **為何未於本次修補**: Firestore 規則無法對 list 查詢逐列過濾，要收緊必須同時改客戶端查詢（改為 `array-contains` 自己的 teacherId）與規則，並且會影響衝堂檢查所依賴的全量 cache（`_v2RecordsCache`），屬架構級變更。
- **建議**: 上線前的風險決策點。若使用單位對個資要求嚴格，需排 v2.1 專案處理（可參考既有 `pendingConsentTeacherIds` 的 array-contains 設計）；若可接受，需在文件明載此限制並取得使用單位認可。
- **相關檔案**: `firestore.rules`（substituteRecords / pendingRequests 的 read）、`src/js/modules/v2/roleService.js:150-162`

### firestore.rules 安全矩陣首次自動化驗證：26/26 通過

- **日期**: 2026-07-29
- **狀態**: 🟢 通過（新增 `test/v2-rules-matrix.mjs`，commit `adf7fee`）
- **描述**: `firestore.rules`（353 行 v2.2）經 Phase 3 三輪對抗修補，但從未有自動化測試。本次建立 26 案例矩陣，以真實測試帳號的 idToken 直打 Firestore REST 驗證線上規則。
- **結果**: 12 個正向流程全 ALLOW、14 個攻擊全 DENY，**未發現任何規則缺陷**。攻擊涵蓋：自我提權、冒建教師檔、自帶 approvedBy、swap 跳過同意、自列唯一同意人、預填 swapConsents、同意人直寫 approved、竄改白名單外欄位、approved↔rejected 雙向終態鎖、教師自寫代課紀錄灌代課費、竄改稽核日誌、讀他人映射。
- **相關檔案**: `test/v2-rules-matrix.mjs`、`firestore.rules`

### 計畫文件記載的 Email/Password provider 卡點實際上不存在

- **日期**: 2026-07-29
- **狀態**: 🟢 已澄清（commit `f85328b`）
- **描述**: `docs/PLAN_v2.0.0.md` §0 表格長期把 Phase 1.6.b 標記為「需先在 Firebase Console 啟用 Email/Password provider」，被視為阻擋驗收的前置條件。
- **實況**: 查 Identity Toolkit admin API 得 `signIn.email.enabled=true`、`passwordRequired=true`，且三個測試帳號已實際以 email/密碼登入成功。該卡點不知何時已被解除但文件未更新，導致驗收一直沒有推進。
- **相關檔案**: `docs/PLAN_v2.0.0.md`

---

## V2 Phase 1 資安修補（2026-06-20，多 agent code review）

### operationLogs 稽核日誌全數寫入失敗

- **日期**: 2026-06-20
- **狀態**: 🟢 已解決（rules 已於 2026-06-25 部署並 byte 級驗證，release `05f9b203`）
- **描述**: V2 任何操作的稽核日誌都寫不進 `schools/inhu/operationLogs`，含 login_denied。
- **原因**: `firestore.rules` operationLogs create 的欄位白名單為 `['action','actor','timestamp','target','detail']` 且要求 `timestamp == request.time`、`detail is map`；但 `operationLogger.log()` 實際寫 `targetType/targetId/details` + ISO 字串 timestamp（roleService.filterLogsForCurrent 與 v2-app:418 也都讀此 schema）。三處不符 → `hasOnly` 失敗 → 寫入 DENY。
- **解決方案**: 改規則對齊程式碼一致使用的 schema：`hasOnly(['action','actor','timestamp','targetType','targetId','details'])`、`timestamp is string`、`actor is map`、`details is map`，保留 update/delete:false 的不可竄改性。
- **相關檔案**: `firestore.rules`（operationLogs match）、`src/js/modules/v2/operationLogger.js`

### userMappings 自寫提權（任一教師可提權為主任）

- **日期**: 2026-06-20
- **狀態**: 🟢 已解決（rules 已於 2026-06-25 部署並 byte 級驗證，release `05f9b203`）
- **描述**: 任一登入教師可透過 DevTools 對自己的 `userMappings/{uid}` 寫入，把 `linkedTeacherId` 指向某 director 教師的 teacherId，藉此取得 director 全權限（改學校設定、刪教師、刪正式紀錄）。
- **原因**: rules helper `myTeacherId/isDirector/isApprover` 全部信任使用者自寫的 `userMappings.linkedTeacherId`，而原 create/update 規則只檢查 `auth.uid == uid`、不限制欄位內容。屬與 operationLogs 同根因（規則漏限欄位）。
- **解決方案**: 自寫映射時新增條件——`linkedTeacherId` 指向的教師檔 `email` 必須等於本人登入 email（只能映射到自己）。director 代寫不受限；bootstrap 與正常 Google 登入不受影響。
- **相關檔案**: `firestore.rules`（userMappings match）、`src/js/modules/v2/authGuardV2.js`
- **延後項（Phase 3/4）**: `substituteRecords` 偽造已核准紀錄、`pendingRequests` 同意人全欄竄改 — ✅ 已於 2026-07-09 Phase 3 全數收緊完成（見下方 2026-07-09 條目）。

---

## V2 Phase 3 多輪對抗驗收與 code review 發現（2026-07-09）

- **日期**: 2026-07-09
- **狀態**: 🟢 已解決（feature/permission-system，8 commits：f8dd218 → debe4cd）
- **描述**: Phase 3 審核工作流實作經三輪對抗驗收 + code-review（8 finder × 4 verifier）共修補 6 個資安/正確性缺陷，最嚴重者為：
  1. 【致命】駁回操作全面 permission-denied——`updatePendingRequest` wrapper 自動注入 `updatedAt`，不在新 rules affectedKeys 白名單 → 改 `runTransaction` 直寫 + status 終態防護
  2. 發起人可自帶 `pending_approval` + 空/含己同意名單跳過對方同意（create 端兩變體）→ rules 強制狀態機初始狀態 + 名單不含發起人
  3. isSelfSwap 快速路徑可自寫假「已核准代課」灌月結算代課費 → 鎖 type 為調課類 + 三個 teacherId 全鎖本人
  4. 已同意者可用殘留 `requiredApproverId` 身分清空名單跳過其餘同意人 → 相容條款收緊為僅 legacy 文件
  5. rejected 請求可被名單內同意人「復活」→ 同意人分支補對稱終態鎖
  6. `canConsentRequest` fallback 造成已同意者看到幽靈待辦 → 陣列存在時以陣列為唯一依據
- **教訓**: rules 的 update 白名單改動必須逐欄比對「所有實際寫入路徑」的 payload（含資料層 wrapper 自動注入的欄位）；create 端與 update 端要分開對抗測試。
- **已知可接受限制（延後）**:
  - isSelfSwap 紀錄的姓名字串欄位未鎖本人（僅污染顯示統計，無計費影響）
  - operationLog details 不再有 `requiredApproverId` 專屬欄位（資訊仍在 affectedTeacherIds）
  - `v2NeedsApproval` 與 `resolveApproverInfo` 平行維護「是否需審核」判斷，未來改規則需同步兩處
  - 多節課代課在 V2 下拆成 N 筆請求，approver 需逐筆核准、PDF 逐張產生
- **相關檔案**: `firestore.rules`、`src/js/modules/v2/pendingRequestService.js`、`src/js/modules/v2/roleService.js`、`src/js/v2-app.js`

---

## 狀態說明

| 狀態 | 說明 |
|------|------|
| 🔴 待處理 | 已發現但尚未開始處理 |
| 🟡 處理中 | 正在調查或修復 |
| 🟢 已解決 | 已找到解決方案並修復 |
| ⚪ 設計權衡 | 因架構演進已不再相關，由新版本取代 |

---

## 登出後整個 app 未鎖定，仍可操作本機頁面（月結算報表可下載）

- **日期**: 2026-07-06
- **狀態**: 🟢 已解決（feature/permission-system）
- **描述**: P1 驗收發現——登出後 app 沒有回到「未登入鎖定」狀態，非 V2 的頁籤（月結算等）仍完全可操作，甚至能下載月結算報表。屬登出後未鎖定的資料外洩。
- **原因**: V1 的登入模型是「app 永遠可用（localStorage），登入只為雲端同步」——`auth-logged-out`/`auth-logged-in` 只切換**表頭**登入按鈕，從不遮罩內容。V2 疊上強制登入但未處理登出鎖定，底層 V1 app 仍可操作本機記憶體資料。
- **解決方案**: `src/js/v2-app.js` 新增全視窗登入遮罩 `#v2-auth-gate`（z-index 9990，內含 Google/Email 登入入口）；`lockV2App/unlockV2App/setAppLocked` 單一入口在未授權時對 `.app-container` 上 `inert`（同時擋滑鼠/鍵盤/焦點）+ `body.v2-locked` 遮罩；授權身份確認**且初次渲染完成**才 `unlockV2App`。
- **high-effort code review 補強**（第二輪，5 CONFIRMED + 2 PLAUSIBLE）:
  - catch 路徑永不解鎖 → 授權者遇暫時性錯誤永久卡死：改 catch 設 `_v2GateError` + 維持鎖定並顯示「錯誤+重試」。
  - 遮罩只擋滑鼠、鍵盤可 Tab 到底層月結算：改用 `.app-container[inert]` 一併封鎖鍵盤/焦點。
  - 拒絕訊息依賴 signOut→re-emit 鏈，signOut 失敗則不顯示：改先 `lockV2App()` 保證顯示拒絕，再 try/catch 嘗試 signOut。
  - `dataManager.clearAll()` 只清記憶體不清 localStorage、且會導致再登入資料看似遺失/覆蓋：**移除 clearAll**，改以 inert+遮罩阻擋存取為真正邊界。
  - unlock 在 render 前 → render 丟錯留半渲染可操作畫面：unlock 移到 4 個初次渲染完成之後。
  - email 未逸出即入 innerHTML（XSS）：加 `escapeHtml`；`renderAuthGate` 加 renderKey 防重複重繪。
- **驗證**: `node --check` 全綠；兩輪 high-effort 多 agent code review。preview 站待使用者複測登出鎖定。
- **相關檔案**: `src/js/v2-app.js`（`injectV2AuthGate`/`renderAuthGate`/`setAppLocked`/`lockV2App`/`unlockV2App`、`onAuthStateChange`）、`src/js/modules/dataManager.js`（`clearAll` 660）

---

## 同頁面切換身份（登出主任→登入組長）未重整時，權限與敏感內容殘留

- **日期**: 2026-07-05
- **狀態**: 🟢 已解決（feature/permission-system）
- **描述**: P1 實機驗收發現——同一瀏覽器分頁先登入主任、登出後再登入組長，UI 權限未即時刷新：組長仍看得見「教師管理」頁籤與**主任階段渲染的真實教師名單**，需手動重新整理才恢復正常。屬跨身份資料外洩。
- **原因**: 兩層疊加問題。(1) **分類錯誤**：`index.html` 中「教師管理」頁籤按鈕與面板標 `v2-admin-only`（= approver 可見，含組長），應為 `v2-director-only`；「操作日誌」亦誤標 admin-only。(2) **切換殘留**：`onAuthStateChange` 只更新 body 角色 class，未清除前一身份已渲染的敏感容器，且登出分支提早 return、`body.v2-active` 未移除，當前作用中的受限 `.active` 面板（含個資）與其內容留在 DOM。high-effort 多 agent code review 另指出：初版修法只清 2 個容器（漏 `#v2-pending-list`、`#v2-records-section` → 待辦與全校紀錄仍外洩）、且對同帳號 re-emit 無條件重置會誤刪未存輸入、以及 in-flight 非同步渲染可能於清空後回填舊身份資料。
- **解決方案**:
  - `index.html`：教師管理改 `v2-director-only`、操作日誌改 `v2-approver-only`（組長維持可見）。
  - `src/js/v2-app.js`：新增 `resetV2ViewState()`，於身份**實際改變**時（`identityChanged` 守門、以 `lastAuthUid` 比對，避免同帳號 re-emit 誤刪輸入）清空全部四個含個資容器（`V2_IDENTITY_CONTENT_HOSTS`）+ 衝堂快取，並彈回中性頁籤「課表匯入」（等同重整初始頁）。
  - 新增身份世代計數器 `_v2IdentityGen` + `isStaleRender()`，四個 render 函式取回資料後、寫入 DOM 前檢查，身份已切換即放棄回填（杜絕 in-flight 渲染回填舊身份資料）。
- **驗證**: `node --check` 全綠；high-effort 多 agent code review（2 CONFIRMED 外洩 + 3 PLAUSIBLE 皆已據以修補）。preview 站三角色切換待使用者複測。
- **相關檔案**: `index.html`（v2-teachers/v2-logs 按鈕與面板 65-66、892-896）、`src/js/v2-app.js`（`resetV2ViewState`/`forceActivateTab`/`isStaleRender`、`onAuthStateChange`、四個 render 函式）

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
