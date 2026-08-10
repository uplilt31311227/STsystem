---
created: 2026-03-12
updated: 2026-08-11
tags:
  - changelog
---

# 版本紀錄

---

## [2026-08-11] 完整假資料情境測試（Firebase Emulator，90 案全通過）

建立一套在本機 Firebase Emulator 上跑的情境測試，用固定 seed 產生的完整假資料涵蓋四類情境，**全程不觸及正式 Firestore**。動機是這套系統上線後，課表解析、三種審核流程狀態機、月結算的假別扣減、多租戶隔離與學期唯讀鎖都只靠人工點擊驗證過，缺乏可重複執行的回歸網；而唯一既有的規則測試 `test/v2-rules-matrix.mjs` 是直接打正式庫的（2026-07-30 事故來源）。

**安全設計（針對 2026-07-30 事故的結構性對策）**：`test/emulator/emu-client.mjs` 的 host 寫死 `127.0.0.1`、專案寫死 `demo-stsystem`（`demo-` 前綴使 Firebase CLI 進入離線模式，不可能連上真實專案），每次連線前先探測對端確實是 Emulator，失敗即中止，不 fallback、不讀任何憑證檔——沒有任何程式路徑可以指向正式庫。

**假資料**（`test/fixtures/`，全部固定 seed、日期寫死，可重現）：兩所學校（`demo-alpha` 9 班／`demo-beta` 6 班），各 22 位教師（主任／教學組長／一般教師／3 位未綁定 email／2 位不任課行政）、兩個學期的完整課表（排課器採 most-constrained-first 貪婪，產出後實際驗證無教師衝堂、無班級重複排課）、22 筆已成立紀錄（8 種假別，中英文代碼混用＋一般調課／自行調課）、6 筆待審請求（代課單簽／調課雙簽待同意／待核准／多重調課部分同意／已駁回／alpha 期舊格式）、操作日誌（欄位形狀對齊規則白名單）。另建平台管理者與「不屬於任何學校」的外部帳號。

**四類情境共 90 案，全數通過**：情境 1 課表匯入與解析 18 案（15 種 CSV 變體打真實 `ScheduleParser`：欄位別名、值別名、BOM、CRLF、缺必要欄、缺值、只有標題列、未知週次、衝堂、同名教師、校訂課程名稱優先、排除領域、前後空白、班級數值排序）；情境 2 調課／代課全流程 28 案（打真實 `firestore.rules`：三種申請類型狀態機、同意與核准、私有明細 ACL、偽造已核准／冒名發起／自我同意／灌代課鐘點／假冒自我調課等越權嘗試、學期唯讀鎖、稽核軌跡不可竄改）；情境 3 月結算與調代課單 19 案（民國學年換算、寒暑假週數、16 種假別代碼逐一驗證扣減與否、完整課表的結算不變量、週次推算與版面組裝）；情境 4 多學期與多校隔離 25 案（跨校讀寫全面阻斷、email 索引與學校歸屬自我限定、歷史學期唯讀與刪除權、平台管理者與開校申請的權限邊界）。

**測試骨架**：`harness.mjs` 的 deny 斷言強制要求 HTTP 403——被 400/404 等其他原因擋下不算通過，避免「測試綠燈但擋住它的其實不是權限規則」這種假保證。

**開發過程中修正的兩個會讓結論失效的問題**：(1) Firestore Emulator 要繞過 Security Rules 必須明確帶 `Authorization: Bearer owner`，不帶 header 是被當成「未登入使用者」並套用規則——原本的種子寫入因此全被規則擋下，第一版測試等於在空資料庫上跑，卻有 17/28 顯示通過（deny 案例在空庫上自然成立）；(2) 種子改用 `mustSetDoc()`，任何寫入失敗立刻中止，不再靜默略過。另訂正 fixture 的 `operationLogs.actor` 欄位形狀以對齊規則白名單。

新增指令：`npm run emu`（啟動 emulator）、`npm run seed`（只種資料，供 Emulator UI 手動檢視）、`npm run test:scenarios`（跑全部情境）。`firebase-tools` 與 `papaparse` 加為 devDependency（原全域 firebase-tools 安裝已損壞）。使用說明見 `test/emulator/README.md`。測試過程確認的 5 項系統既有行為（非測試失敗）記於 `docs/ISSUES_LOG.md`。

## [2026-07-31] hotfix：v2- 頁籤點擊無反應（P1，上線後即時修復）

`app.js` 1.13.7→1.13.8、`v2-app.js` 0.1.10→0.1.11。正式站課表為空時，「待辦/調代課紀錄/操作日誌」等 `v2-` 開頭頁籤點擊完全無反應（靜默 no-op）。根因是 `v2-app.js` `bootstrap()` 前段（原約第 4472-4476 行）對 `window.app.canSwitchToTab` 的 monkey-patch 執行時 `window.app` 尚未建立（於 `await authMod.initAuthService()` 之後才由 `app.js` 的 `DOMContentLoaded` 建立），`if (window.app && ...)` 防呆檢查本身失敗，patch 整段被跳過、從未真正生效。此問題於 Stage 3 opus 重驗時已發現並記錄於 `docs/ISSUES_LOG.md`（原判斷為「行為變化需另案評估、非本次修復範圍」），此次因正式站課表為空、缺陷實際影響使用而列為 P1 即時修復。

修法（根治，消除時序依賴）：
- `src/js/app.js` `canSwitchToTab()`（約 986 行起）原生加入 `if (tabId.startsWith('v2-')) return true;`，緊接在 `schedule`/`teachers`/`settings` 白名單之後。V1 模式沒有 `v2-` 開頭的頁籤，此檢查無害；註解說明這取代了原 v2-app.js 的 monkey-patch。
- `src/js/v2-app.js` `bootstrap()` 內原本的 monkey-patch 區塊（含其誤導性的時序註解）整段刪除，原地留一行註解指向 `app.js` 的原生支援。
- `docs/ISSUES_LOG.md` 對應條目（Stage 3 opus 重驗另案記錄）狀態更新為已解決，附修法與日期。

走讀確認：`v2-` 頁籤在 `scheduleData` 為空時可正常切換；V1 模式（無 `?v2=1`）完全不受影響（其頁籤本來就不以 `v2-` 開頭，新增的判斷分支不會命中）；月結算等既有 V1 頁籤的「需先匯入課表」鎖定行為不變（新分支只新增放行條件，不影響原有的 `schedule`/`teachers`/`settings`/鎖定判斷邏輯）。`npm run check`、`npm test` 皆通過。**只改上述範圍，未 commit。**

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 4：多租戶開通（未 commit）

依 `docs/RESEARCH-multitenancy-semester.md` §4（開放註冊的誠實風險評估）／§8 路線圖 Stage 4，與 `docs/RESEARCH-blaze-followup.md` 的補充查證（Blaze 無硬性支出上限、App Check 改選 classic reCAPTCHA v3 免費額度更高、實際部署區域 asia-east1 單價比原估的 nam5 便宜四成）。動機：開放 20+ 校自助申請使用。已定案設計：自助申請 + 平台管理者輕量審核（非全自助建校）。opus 驗收第一輪不通過（3 阻斷/3 高/5 中/6 輕），逐項修復詳見下方「修復」小節，本條目已含全部修復。**只寫程式碼，未寫 Firestore、未部署、未跑 `v2-rules-matrix.mjs`、未跑任何離線腳本、未 commit。**

### 新增

- **`src/js/modules/v2/schoolApplicationService.js`**（新檔）：統一負責三個頂層集合的 CRUD——`schoolApplications/{uid}`（申請開通新學校，doc id 綁申請人 uid）、`platformAdmins/{uid}`（client 唯讀）、`schoolDirectory/{schoolId}`（公開學校名錄）。核心函式 `approveApplication()` 分兩個循序 `writeBatch` 執行（非單一原子批次）：第一批建立 `schools/{id}/config/main` + `schoolDirectory/{id}`，第二批更新申請狀態 + 申請人 `userDirectory`——拆兩批的理由是不依賴「同一 batch 內 exists()/get() 能否看到批次內更早操作效果」這個未文件化的行為；也是本設計依賴的 schoolId 衝突防線（Firestore 對已存在文件送出寫入會判定為 update 而非 create，platformAdmin 的 create-only 權限自然拒絕）。失敗重試設計：第一批失敗無副作用可直接重試；第一批成功、第二批失敗時，重試會用「`schoolDirectory` 既有紀錄的 `schoolName` 是否與本申請相同」這個啟發式判斷是否要跳過第一批，已知限制（極端巧合誤判）寫在函式檔頭
- **登入遮罩改造**（`v2-app.js`）：`resolveIdentity()` 找不到教師配對時，不再呼叫 `signOutUser()` 直接登出，改由 `enterApplyFlow()` 導向**雙選項**畫面（opus 驗收 B1 修復後），保留 Firebase Auth session 供使用者在遮罩內完成：
  - email 未驗證 → 「請先驗證 email」畫面 + 寄送/重新寄送驗證信按鈕（`authService.sendVerificationEmail()`，新增）
  - **「加入既有學校」**（B1 新增，恆常顯示）：輸入學校代碼直接自寫 `userDirectory`（`dataSvc.upsertUserDirectoryEntry()`），成功後重新整理頁面重跑登入鏈——修復「新校第二位起教師從未登入過、永遠卡在查無教師配對」的阻斷級問題
  - 無申請紀錄或曾被駁回 → 「申請開通新學校」表單（學校名稱 + 學校代碼，代碼欄位失焦時即時查詢 `schoolDirectory` 提示是否已被使用）
  - 申請審核中 → 狀態卡片（學校名稱/代碼/送出時間）
  - 已核准（邊界情況）→ 提示重新嘗試登入
  - 所有分支底部皆有「登出，改用其他帳號」——是這個畫面唯一真正呼叫 `signOutUser()` 的入口
- **平台管理者審核頁**（`v2-app.js` `renderPlatformAdminReviewTab()`）：設定頁新增卡片（`index.html` 新增 `#v2-platform-admin-card`，預設 `display:none`，非平台管理者完全看不到痕跡），列出待審申請，核准/駁回各附 `confirmDialog()` 二次確認；駁回原因輸入沿用既有 `promptRejectReason()` textarea modal（Stage 5「殺 prompt()」統一成果），未新增 `window.prompt()` 用法。守門邏輯 `_v2IsPlatformAdmin` 獨立於 `roleService` 的校內角色判斷（一個人可能同時是某校 director 也是平台管理者）；opus 驗收 M3/M4 後改為惰性查詢（設定頁首次開啟才查一次並快取，之後每次切到設定頁重繪清單）。新增「疑難排解：已核准的申請」解套區塊（opus 驗收 H2）
- **App Check**（`firebaseConfig.js`）：新增 classic reCAPTCHA v3（非 Enterprise，依 `RESEARCH-blaze-followup.md` §3 查證，v3 免費額度每月 100 萬次遠高於 Enterprise 的 1 萬次，且超額 fail-open 不粗暴擋請求）的載入與初始化程式碼，站台金鑰為空字串佔位常數（`RECAPTCHA_V3_SITE_KEY`），空值時完全跳過初始化並 `console.info` 提示，**不影響任何現有登入/資料流程**；不啟用 enforcement（Console 端獨立開關，啟用步驟寫進 `docs/STAGE4-DEPLOY.md`）
- **緊急支出風控腳本**：`scripts/emergency-brake.js`（`--brake --yes` 把線上 `firestore.rules` 換成全 deny 版本並部署、`--restore --yes` 還原、`--status` 實際取回 ruleset 內容比對是否為全 deny；比照 `firestore-deploy-rules.js` 的 ruleset/release API 呼叫方式；opus 驗收 H1/M2）；`scripts/bootstrap-platform-admin.js`（`--uid=`/`--email=` 建立 platformAdmins 記錄，`--email=` 走 Identity Toolkit `accounts:lookup` REST API 查 uid，未實際驗證過此路徑的可靠性，文件已註明 `--uid=` 是更可靠的替代路徑；`--dry-run` 預設；另支援 `--list`/`--remove`，`--remove` 內建最後一位管理者保護，opus 驗收 L6）
- **`docs/STAGE4-DEPLOY.md`**（新檔）：部署順序（回填 → 規則 → 建立第一位平台管理者 → 前端）、App Check 啟用步驟（建站台/填金鑰/Console 註冊/觀察期/開 enforcement 時機）、支出風控（多門檻預算警報建議金額、緊急煞車操作、為何不採 Cloud Function 自動斷流）、已知限制（含孤兒學校人工清理程序）、三類族群全鏈走讀
- **`docs/STAGE0-DEPLOY.md`「附註：Stage 4」**：三類族群（現有 inhu 成員／新校成員／全新陌生人）× 四組合部署矩陣分析，並記錄 B1 修復後 `backfill-user-directory.js` 從建議提升為硬性前置條件

### 規則變更（`firestore.rules`，v2.6 → v2.7）

- 新增 helper：`isEmailVerified()`、`isPlatformAdmin()`（讀 `platformAdmins/{uid}` 是否存在）、`isValidNewSchoolConfigWrite()`、`isValidSchoolApplicationReviewFields()`（opus 驗收 L3 新增）
- `schools/{schoolId}/config/{docId}`：新增 `allow create: if isPlatformAdmin() && docId=='main' && isValidNewSchoolConfigWrite(...)`（opus 驗收 L2 補 `docId=='main'` 鎖），與既有 `allow write: if isDirector(schoolId)` 並存（OR 語意，互不影響——新校此刻沒有 director，兩分支不會同時命中同一次請求）
- 頂層 `userDirectory/{uid}`：自寫分支新增 `isEmailVerified()`（Stage 3 上線時刻意留白，本階段補上）；新增 `isPlatformAdmin()` 代寫分支（approval 時代寫申請人 userDirectory，不要求 email_verified——申請時已在 schoolApplications 驗證過一次）。權限面誠實揭露：platformAdmin 可代寫**任意** uid 的 userDirectory，不限申請中那一位，理由與風險評估寫在該 match 區塊完整註解
- `schools/{schoolId}/joinAttempts/{uid}`：create/update 新增 `isEmailVerified()`（opus 驗收 B3）
- 新增頂層 `platformAdmins/{uid}`：read 僅本人，write 恆 `false`
- 新增頂層 `schoolDirectory/{schoolId}`：read 拆 `get`（任何登入者）/`list`（僅 platformAdmin，opus 驗收 M1），write 僅 platformAdmin 且僅 create
- 新增頂層 `schoolApplications/{uid}`：create 需本人 + `isEmailVerified()` + 欄位白名單/型別/長度驗證 + `status=='pending'`；update 分 platformAdmin（`pending→{approved,rejected}` 或 `approved→rejected`，opus 驗收 H2 新增後者，僅能動流程欄位且審核欄位另有型別/長度驗證）與本人（僅限 `status=='rejected'` 時重新送出，`createdAt` 鎖定不可變，opus 驗收 L4）兩分支；delete 恆 `false`

### 測試

- `test/v2-rules-matrix.mjs` 新增 X31-X42（12 條攻擊案例，涵蓋 schoolApplications 的 applicantUid/欄位白名單/狀態機/讀寫越權/自我核准、platformAdmins 自我提權與越權讀取、schoolDirectory 與新校 config 的非 platformAdmin 建立嘗試、schoolDirectory update/delete 恆 DENY）。只寫碼未執行；絕大多數是 DENY 案例，唯一含正向 setup 步驟的 X40 依賴 email_verified 狀態（改用解析 idToken 的 email claim，不依賴憑證檔的 `.email` 欄位，opus 驗收 M5）；「platformAdmin 把已核准申請改成 rejected 以外的值應 DENY」因缺 platformAdmin 測試帳號如實記錄為已知覆蓋缺口（不硬湊誤導性案例）
- `npm run check`（38 檔語法檢查）與 `npm test`（既有 5 支測試，合計 99 案）皆通過（opus 驗收修復後重跑同樣全過）

### 修復（opus 驗收：3 阻斷、3 高、5 中、6 輕）

**阻斷**
- **[B1]** 原設計沒考慮到「新校第二位（含之後）教師從未登入過、無 `userDirectory` 條目」這一類使用者——`authGuardV2.resolveSchoolIdForUid()` 查無條目原本無條件 fallback `DEFAULT_SCHOOL_ID`（`inhu`），會讓這類教師的登入永遠去 `inhu` 的 `emailIndex` 找自己（查無所獲），永遠卡在查無教師配對，原 TODO 描述的目標行為從未實作。修復：查無條目（非讀取失敗、非部署過渡期 `permission-denied`）回傳 `null`，`resolveIdentity()` 直接回傳 `null` 且不寫 `joinAttempt`；`v2-app.js` 登入遮罩新增「加入既有學校」（輸入代碼 → 自寫 `userDirectory` → 重跑登入鏈）與既有「申請開通新學校」並列的雙選項畫面。相容紅線：`scripts/backfill-user-directory.js` 對 `inhu` 現有成員的執行從「建議」提升為部署硬性前置條件（否則未回填成員會被誤判為查無所屬學校），四份文件已同步記錄
- **[B2]** email 驗證完成後的「重新確認」按鈕原本只呼叫 `user.reload()`，只更新本機 `user` 物件的 `emailVerified` 屬性，未更新「已快取、附帶在後續請求上的 ID token」——Firestore 規則讀的是 `request.auth.token.email_verified`（token 內的 claim），需要 `getIdToken(true)` 強制刷新才會重新簽發。修復：補上 `await user.getIdToken(true)`，兩步都做才能讓緊接著的 `schoolApplications`/`joinAttempts`/`userDirectory` 寫入通過規則檢查
- **[B3]** B1 修復後陌生人不再誤打 `inhu` 的 `emailIndex`；`joinAttempts` 的 create/update 規則補 `isEmailVerified()`（與 `schoolApplications`/`userDirectory` 收緊方向一致）；查無所屬學校（`schoolId===null`）時不再寫入任何學校的 `joinAttempts`（沒有學校可歸屬）

**高**
- **[H1]** `scripts/emergency-brake.js` 原本裸執行（不帶參數）就是拉煞車——對一個「一鍵讓全平台斷線」的腳本，這個預設行為誤觸發代價過高。改為必須同時帶 `--brake --yes`（拉煞車）或 `--restore --yes`（還原）才會執行，裸執行只印用法說明；刪除檔頭「沒有 --dry 是設計取捨」的錯誤陳述
- **[H2]** `approveApplication()` 偵測到 `schoolDirectory` 同代碼同名紀錄時，原本靜默判定為「同一筆申請的重試」直接跳過第一批——但這個啟發式不是決定性證據，靜默跳過可能誤把一筆申請「綁」到另一筆不相關申請已建立的學校。修復：改丟 `SameNameConflictError`，`v2-app.js` 接住後顯示「該 schoolId 已存在同名學校，僅執行綁定」的二次確認，確認後才帶 `confirmedSkipFirstBatch:true` 重試；規則新增 platformAdmin 的 `approved→rejected` 解套分支，新增 `revertApprovedApplication()` 與對應 UI（「疑難排解：已核准的申請」區塊），供核准流程卡住或誤核准時撤銷（不會刪除已建立的學校資料）
- **[H3]** `rejectApplication()` 原本沒有檢查「這筆申請是否已對應到真實建立的學校」，可能造成「申請顯示已駁回，但它宣稱的學校卻真實存在」的孤兒資料。修復：簽章改吃完整 `application` 物件（需要 `desiredSchoolId`/`status`），駁回前檢查 `status==='approved'` 或 `schoolDirectory` 同代碼同名，符合任一即阻擋並提示改用核准或人工清理（`docs/STAGE4-DEPLOY.md` 補人工清理程序）

**中**
- **[M1]** `schoolDirectory` 的 read 拆成 `get`（任何登入者，供加入流程查單一代碼）與 `list`（僅 platformAdmin），原本 `allow read` 會讓任何登入者一次撈走全平台學校名單
- **[M2]** `emergency-brake.js --status` 原檔頭誤寫「本 API 不提供規則原始內容下載端點」——訂正：Rules API 的 `projects.rulesets.get` 本來就會回傳 `source.files[].content`，`--status` 改為實際取回目前線上 ruleset 內容並與 `DENY_ALL_RULES` 逐字比對，明確回報「目前是否處於緊急煞車狀態」
- **[M3]** `renderPlatformAdminReviewTab()` 原本只在 bootstrap 執行一次，設定頁重複開啟看到的是過期快照。接上既有的「設定」頁籤切換 hook（`bindV2TabSwitches()`），每次切到設定頁都重繪
- **[M4]** 平台管理者身份判斷（`isPlatformAdmin()`）原本在 bootstrap 對**每一位**登入者無條件查一次 `platformAdmins/{uid}`，絕大多數使用者都不是，等於白白多一次讀取。改為惰性查詢：`_v2IsPlatformAdmin` 初始為 `null`（尚未查過），只在第一次呼叫 `renderPlatformAdminReviewTab()` 時才查並快取，登出／身份切換時重置回 `null`
- **[M5]** `test/v2-rules-matrix.mjs` 補 X40（教師合法建立自己的 pending 申請後，自我更新為 approved 應 DENY，測 update 規則而非既有 X33 的 create 規則）、X41/X42（`schoolDirectory` update/delete 恆 DENY，不論文件是否存在）；「platformAdmin 把已核准申請改成 rejected 以外的值應 DENY」因本檔三個測試帳號皆非 platformAdmin、無法建立前置狀態，如實記錄為已知覆蓋缺口（不硬湊會因為錯誤理由才 DENY 的誤導性案例）

**輕**
- **[L1]** `test/v2-rules-matrix.mjs` 檔頭版本字串訂正為 v2.7（原本仍寫 v2.6，與 firestore.rules 實際版本不同步）
- **[L2]** `isValidNewSchoolConfigWrite()` 的 `initialAdminEmails` 原本只驗證「是 list 且非空」，未逐項驗證元素型別；Firestore 規則語言（CEL 子集）沒有確認可用的通用逐項述語語法（`.all()` 等 CEL 巨集未見官方文件列為 Firestore Security Rules 支援項目，貿然採用有部署期才發現語法錯誤的風險），改用「精確比對實際寫入形狀」：鎖 `size()==1` 並用陣列索引 `[0] is string` 驗證，比逐項驗證更嚴格且語法風險更低；另補 `docId=='main'` 鎖（見上方規則變更）
- **[L3]** `schoolApplications` 的 platformAdmin 審核欄位（`reviewedAt`/`reviewedBy`/`rejectReason`）原本只有 `hasOnly()` 白名單、無型別/長度驗證，新增 `isValidSchoolApplicationReviewFields()`（容忍欄位不存在或為 `null`，比照既有 `archives.note`/`substituteRecords.details` 的既有驗證模式）
- **[L4]** 申請人被駁回後重新申請（`update` 的本人分支）原本沒有鎖定 `createdAt`，理論上可被重寫成任意值；新增 `request.resource.data.createdAt == resource.data.createdAt`
- **[L5]** `docs/STAGE4-DEPLOY.md` App Check 啟用步驟補充提醒：`firebaseConfig.js`/`authService.js` 等子模組沒有 import 版本查詢參數（沿用 `docs/STAGE0-DEPLOY.md` 既有結論，不新增機制），部署後需硬重新整理才會載到新版
- **[L6]** `scripts/bootstrap-platform-admin.js` 的 `--remove` 補「最後一位平台管理者」保護——移除後若名冊會變空則預設拒絕，需明確加 `--force-remove-last` 才會放行，避免把系統鎖進「沒有任何人能審核學校申請」的狀態；檔頭補充本腳本以新增為主要用途的定位

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 3：SCHOOL_ID 動態化（未 commit）

依 `docs/RESEARCH-multitenancy-semester.md` §4（集合設計預告：頂層 `userDirectory`）／§8 Stage 3。動機：`SCHOOL_ID`（`schemaConstants.js:14`）原本是 import-time 常數，全 app 只能服務寫死的 `'inhu'`；要推廣多校（使用者已確定要做，Stage 4 開放註冊隨後即做），必須把「schoolId 從哪裡來」改為「登入後由使用者身份動態解析」。本階段是純鋪路，**不改變任何現有 `inhu` 使用者可觀察到的行為**——只是解析機制從寫死常數換成 runtime 解析 + 相容期 fallback。opus 重驗兩輪：第一輪 4 中／6 輕，第二輪 1 必修／4 小項＋1 筆另案記錄，本條目已含兩輪全部修復。**只寫程式碼，未寫 Firestore、未部署、未跑 `v2-rules-matrix.mjs`、未跑回填腳本、未 commit。**

### 修復（opus 重驗第二輪：1 必修、4 小項）
- **[必修1]** `resetV2ViewState()` 清空 `dm.scheduleData` 等欄位（第一輪中4修復）打破了「dm 內容與 `_v2LastAppliedScheduleSig` 恆一致」的不變式：同一分頁內登出後用同一帳號再登入，若新一輪課表快照與上次相同（`updatedAt`/長度都沒變），`applyRemoteSchedule()` 算出的簽章會跟殘留的舊值相等而提早 `return`，但 `dm.scheduleData` 已經被清空——本該回填的快照被誤判成「重複，不必套用」，畫面永久空白，且下次 approver 編輯課表時會把這份空快照當「本機完整快照」回寫、覆蓋全校雲端課表。修法：`resetV2ViewState()` 在 `_v2ScheduleReady = false;` 旁一併 `_v2LastAppliedScheduleSig = null;`
- **[輕2]** `applyV2LocalStorageKey(getActiveSchoolId())` 之後緊接呼叫 `window.app?.loadSavedData?.()`，從「這所學校」的 school-scoped 本機鏡像回填 `dataManager`——key 已切換到正確學校，不違反 school 隔離；同時修復 `resetV2ViewState()` 清空 dm 欄位後、Firestore 課表訂閱首次快照抵達前這段視窗內畫面空白閃爍，以及暫時離線時完全沒有本機資料可顯示的離線韌性下降。`loadSavedData()` 內部走 `dataManager.loadFromStorage()` 直接賦值，不經 `wrapScheduleMutator`，不觸發回寫，也不受 `_v2ScheduleReady` 影響（這批資料只用於顯示，是否放行回寫雲端仍然只看 `_v2ScheduleReady`）
- **[nit3]** 同 uid re-emit（`identityChanged===false`，Firebase SDK 本機快取還原/token 刷新等情境會觸發）路徑原本不會重置 `_v2ScheduleReady`（該旗標只在 `resetV2ViewState()`——即 `identityChanged===true`——內被清空），但 `clearSubs()` 在**每一次** `onAuthStateChange` 都會執行、無條件取消所有既有訂閱（含課表訂閱）。若 `identityChanged===false`，舊訂閱已停但旗標維持前一輪的 stale-true，於「舊訂閱已停、新訂閱還沒回報」的窗口內誤放行課表回寫。改為 `clearSubs()` 之後、判斷 `identityChanged` 之前，無條件把 `_v2ScheduleReady` 設為 `false`（與 `resetV2ViewState()` 內的重置疊加執行，冪等無害）
- **[nit4]** `authGuardV2.resolveSchoolIdForUid()` 的 `readFailed` 分支拋出的錯誤，原本只讓遮罩顯示通用文案「登入驗證時發生錯誤」。新增 `_v2GateErrorMessage` 記錄拋出的 `e.message`，`renderAuthGate()` 改顯示具體原因（例如「無法確認使用者所屬學校（讀取 userDirectory 失敗）」）；`unlockV2App()` 一併清除這個訊息；渲染去重的 `key` 併入訊息內容，避免兩次連續、訊息不同的失敗被誤判成「同一狀態」而跳過重繪
- **[nit5]** `userDirectory` 規則的白名單正則加上 `^`/`$` 錨點（`matches('^[a-z0-9_-]{1,50}$')`），不依賴「`.matches()` 文件上說隱含全字串匹配」的間接保證，直接在規則本文表達完整意圖，成本為零

### 另案記錄（不在本輪修，已寫入 `docs/ISSUES_LOG.md`）
- `v2-app.js` 的 `window.app.canSwitchToTab` patch 位於 `initAuthService()` 之前，該時點 `window.app` 尚未由 `app.js` 的 `DOMContentLoaded` 建立，patch 的防呆檢查 `if (window.app && ...)` 因此恆為假，patch 從未生效——Stage 3 之前就存在的既有問題，非本次改動引入。意外關聯：這正是必修 1 情境下（`dm.scheduleData` 短暫被清空）approver 仍能正常切換到課表管理／教師管理／學校設定等頁籤、沒有觀察到連鎖症狀的原因（`window.app.canSwitchToTab` 其實一直是原始 V1 版本，判斷條件不只看 `dm.scheduleData` 是否為空）。修復需要先評估「patch 真正生效後」各頁籤可進入性的完整變化範圍，是獨立的分析與驗證工作，故不在本輪 Stage 3 任務範圍內順手修，另案處理

### 新增（schoolId 解析，`schemaConstants.js`／`authGuardV2.js`／`schoolDataService.js`）
- `schemaConstants.js`：移除 `export const SCHOOL_ID = 'inhu'`，改為模組層狀態 `getActiveSchoolId()`／`setActiveSchoolId()`／`resetActiveSchoolId()` + `DEFAULT_SCHOOL_ID='inhu'`（未設定時的相容期 fallback）；`SCHEMA_PATHS` 全部 15 個路徑產生器改吃 `getActiveSchoolId()`；新增 `SCHEMA_PATHS.userDirectoryDoc(uid)` → `userDirectory/{uid}`（頂層路徑，刻意不依賴 schoolId——這正是它存在的意義：在還不知道 schoolId 之前就要能讀到它）
- `schoolDataService.js`：新增 `getUserDirectoryEntry(uid)`／`upsertUserDirectoryEntry(uid, schoolId)`；其餘既有函式**零改動**——已核實它們本來就只透過 `SCHEMA_PATHS.*()` 組路徑，從未直接引用 `SCHOOL_ID` 常數本身，全 app 只有 `v2-app.js` 一處匯出 meta 欄位直接引用過（已改 `getActiveSchoolId()`）
- `authGuardV2.js`：`resolveIdentity()` 開頭新增 `resolveSchoolIdForUid(uid)`——讀頂層 `userDirectory/{uid}` 取得 schoolId（讀取失敗一律 try/catch 接住，視同查無條目）→ `setActiveSchoolId()`，才繼續走既有的 `getInitialDirectorEmails()`/emailIndex/teachers/userMappings 配對流程（這些函式全部依賴 `SCHEMA_PATHS`，必須排在 `setActiveSchoolId()` 之後才會讀到正確學校的資料）；查無條目時 fallback 到 `DEFAULT_SCHOOL_ID`；登入成功（`teacher` 確定非 null）且 `userDirectory` 尚無條目時，補寫一筆（`upsertUserDirectoryEntry`，失敗不阻擋登入）——讓現有成員不必等到回填腳本執行才收斂，下一次登入即為穩定態
- `clear()` 新增 `resetActiveSchoolId()`（登出清空，實際登出路徑走 `v2-app.js` 的 `onAuthStateChange(user=null)` 分支直接呼叫，這裡是讓本函式自身行為完整，不依賴呼叫端多做一步）

### 新增（規則，`firestore.rules` v2.5 → v2.6）
- 新增頂層 `match /userDirectory/{uid}`（見檔頭第 8 點）：`read`／`create`／`update`／`delete` 皆限本人（`request.auth.uid == uid`）；`create`/`update` 欄位白名單 `hasOnly(['schoolId','createdAt'])`、`schoolId` 須為字串、不可含 `/`（防止字串插入路徑模板 `schools/$(schoolId)/config/main` 而使解析出的路徑段數偏離文件路徑必為偶數段的規則，比照 `schemaConstants.emailIndexDoc()` 對相同類型輸入的既有防禦）、且須通過 `configExists(schoolId)`（防止指向不存在的學校）
- 刻意未加 `email_verified` 收緊——本階段唯一寫入路徑是 `authGuardV2.upsertUserDirectoryEntry()`，只在既有 `isMember`/`isInitialDirector` 等機制已判定登入合法「之後」才呼叫，不是任意登入者可自由決定寫入任意 schoolId 的開放端點；留給 Stage 4（開放註冊，屆時任意登入者都可能觸發建校/加入流程）收緊

### 新增（localStorage 前綴化，`v2-app.js`／`app.js`）
- `app.js`：新增 `getLocalStorageKey()` 方法（V1 預設回傳未加前綴的 `'substituteSystemData'`，行為與 Stage 3 之前完全一致）；`loadSavedData()`／`saveDataToStorage()`／`clearLocalData()` 三處硬寫的字面值改呼叫這個方法
- `v2-app.js`：新增 `applyV2LocalStorageKey(schoolId)`，於身份解析成功後呼叫——僅對 `DEFAULT_SCHOOL_ID`（`'inhu'`）執行一次性遷移（新 key `substituteSystemData:{schoolId}` 不存在、舊 key 存在時，**複製**一份到新 key，刻意不刪除舊 key，讓 V1 模式維持舊 key 不動）；之後覆寫 `window.app.getLocalStorageKey` 回傳新 key。已知限制：app.js 建構子在 DOMContentLoaded 時的第一次 `loadSavedData()` 早於身份解析完成，無可避免仍讀舊 key，不影響正確性（V2 真相來源是 Firestore 訂閱，很快會覆蓋）
- `patchClearLocalData()` 改用 `this.getLocalStorageKey()` 清除 school-scoped key，不再清舊的未加前綴 key（V1 資料不受 V2 的「清除所有資料」波及）

### 新增（快取隔離，`v2-app.js`／`semesterState.js`）
- `resetV2ViewState()` 新增 `semesterState.setCurrentSemesterId(null)`——「school 切換」維度：schoolId 改變必然伴隨身份改變（不同 uid），本函式本來就在身份「實際改變」時無條件執行，故不需要額外判斷「schoolId 是否真的不同」，直接併入既有的清空範圍
- 登出分支（`onAuthStateChange(user=null)`）新增 `schemaConstants.resetActiveSchoolId()`
- `semesterState.js` 檔頭原本標記的 Stage 3 相依（「若 SCHOOL_ID 改成 runtime 解析，本模組須改為 `Map<schoolId, semesterId>`」）已重新評估並訂正：不需要改成 Map——「一個分頁同時只服務一所學校」這個前提在 Stage 3 之後依然成立（`getActiveSchoolId()` 本身也只有單一模組層級變數），真正需要處理的只是「切換時舊值不能殘留」，已透過上述 `resetV2ViewState()` 的新增一行解決

### 新增（回填腳本）
- `scripts/backfill-user-directory.js`：讀 `schools/{school}/userMappings`（既有成員），為每個 uid 建立 `userDirectory/{uid}` 條目；`--school=` 參數（預設 `inhu`）；`--dry-run` 預設要求；偵測「uid 已登記在其他 schoolId」的衝突並拒絕覆寫（目前只有一校，理論上不會觸發，防禦性設計）。**本次僅寫好腳本，未執行（含 --dry-run）**

### 四組合部署矩陣（`docs/STAGE0-DEPLOY.md`「附註：Stage 3」）
- 與 Stage 0（`emailIndex`）／Stage 2（`semesterId`）的「必須先部署 rules 再部署 client」不同：Stage 3 的 `resolveSchoolIdForUid()`／`upsertUserDirectoryEntry()` 呼叫兩邊都包 try/catch、失敗一律 fallback 或靜默略過、不 rethrow，四組合矩陣顯示**兩個部署順序皆安全**——「新 client × 舊 rules」時 `userDirectory` 讀寫皆被舊規則的預設 DENY 擋下，但 fallback 讓行為等同「舊 client × 舊 rules」；「舊 client × 新 rules」時舊 client 完全不知道這個新集合存在，新增的 match 區塊是純附加、不影響任何既有 match，行為同樣不受影響
- 回填腳本因此**不是部署前置條件**（與 Stage 0/2 的回填不同，那兩者缺席會造成功能性中斷或查詢遺漏）：新 client × 新 rules 且回填未跑時，首次登入靠 `getDoc` 對不存在文件回傳 `exists()===false`（不是 `permission-denied`）觸發 fallback，登入成功後自動補寫，下一次登入即為穩定態，全程不需要人工介入
- 建議部署順序仍維持與 Stage 0/2 一致的「rules → client」節奏，理由不是正確性風險（兩個順序都安全），而是減少「新 client × 舊 rules」這格會出現的、本身無害但屬雜訊的 `permission-denied` console 警告

### 修復（opus 驗收：4 中、6 輕）
- **[中1]** 「清除所有資料」（`patchClearLocalData()`）原本只清 school-scoped 新 key，不清未加前綴的舊 key——舊 key 在 Stage 3 之後不再被 V2 持續覆寫，成為「一次性遷移時複製過去」的永凍快照，若之後觸發 `legacyMigrationService` 的偵測流程，會把已清除的舊資料誤判成「V1 遺留資料」提供遷移，執行後等於把已刪除的紀錄復活寫回 Firestore。改為兩把 key 一起清；同步訂正 `legacyMigrationService.js` 檔頭一段寫反的風險結論（原文誤稱「風險變小」，實為「風險變大」，見該檔案修正後的完整說明）
- **[中2]** `resolveSchoolIdForUid()` 原本把「讀取失敗」與「查無條目」都 fallback 到 `DEFAULT_SCHOOL_ID`，混為一談。改為回傳值加 `readFailed` 旗標：`permission-denied`（部署過渡期已知情境）仍視同查無條目 fallback；其餘任何錯誤碼視為 `readFailed=true`，`resolveIdentity()` 據此 `throw`，沿用既有的「resolveIdentity 本身失敗」外層 catch（`_v2GateError` + 可重試，不 signOut）中止本次登入，不寫入 `joinAttempt`
- **[中3]** 新增自救機制：若 `userDirectory` 記錄的 schoolId（非 fallback 值）底下查無教師配對，改用 `DEFAULT_SCHOOL_ID` 再跑一次配對鏈（僅一次，不遞迴）。抽出 `attemptResolveTeacherForActiveSchool()` 共用邏輯，避免兩份幾乎一樣的配對程式碼；刻意不自動改寫 `userDirectory` 既有條目，避免掩蓋「教師檔本身被誤刪」這類真正的資料完整性問題
- **[中4]** school 切換未清 `window.app.dataManager` 記憶體 → A 校課表可能被 `setDoc` 進 B 校。`resetV2ViewState()` 新增直接欄位賦值清空 `scheduleData`/`teachers`/`classes`/`schoolName`/`substituteRecords`（比照 `applyRemoteSchedule()` 不經 mutator 的做法，避免觸發回寫）。**取捨**：未依原始要求把 `requireSchedule` 守門擴及 `setScheduleData`/`addScheduleEntry`/`updateScheduleEntry`/`removeScheduleEntry` 四個既有方法——實際走讀發現這會產生迴歸：`app.js editorDeleteTeacher()`／`v2-app.js` 教師刪除流程在「刪除全校唯一教師」這個合法邊界情況下會呼叫 `setScheduleData([])`，若這四個方法都套上 `requireSchedule`，這個合法的「清空」操作會被靜默擋下、不回寫雲端，與 `wrapScheduleMutator` 既有註解「這四者允許空課表寫入，那是正確的課表異動」直接衝突。改為更精準地命中風險視窗本身：新增 `_v2ScheduleReady` 旗標，`resetV2ViewState()` 時歸零，`subscribeSchedule()` 收到「目前這所學校」的第一次快照（不論是否為 null）才轉為 `true`；`queueScheduleSync()`（8 個 wrapped mutator 唯一共用的回寫入口）在旗標為 `false` 時一律不回寫。這同時涵蓋「空」與「非空但過期/錯校」兩種情況，且不影響任何既有 mutator 的 `requireSchedule` 語意。已完成走讀確認：「清除所有資料」（`clearAllSchoolData()`）課表歸零走 `dataSvc.saveSchedule()`，完全不經過 `wrapScheduleMutator`/`queueScheduleSync()`，不受這次改動影響；正常課表匯入/編輯發生在登入後的互動階段，`_v2ScheduleReady` 屆時早已為 `true`，不受影響
- **[輕5]** 登出分支新增 `delete window.app.getLocalStorageKey`，還原 `applyV2LocalStorageKey()` 對 `window.app` 的覆寫，避免同分頁登出後未整頁重新整理就換帳號登入時，短暫空窗期間沿用上一所學校的 key
- **[輕6]** `userDirectory` 規則的 schoolId 驗證原本用負面檢查 `!schoolId.matches('.*/.*')`，但 Firestore 規則的 `.matches()` 是 RE2 全字串匹配、`.` 預設不匹配換行字元，一個同時含 `\n` 與 `/` 的字串（例如 `"inhu\n/x"`）會讓 `.matches('.*/.*')` 因無法跨越 `\n` 而回傳 `false`，負面檢查因此被繞過（即使字串明明含 `/`）。改為正面白名單 `matches('^[a-z0-9_-]{1,50}$')`（opus 重驗 5 再加上 `^`/`$` 錨點，不依賴「文件說 `.matches()` 隱含全字串匹配」的間接保證），只允許小寫英數字/底線/連字號、長度 1-50，無繞過空間
- **[輕7]** `operationLogger.js` 新增匯出 `clearFailedLogs()`，`resetV2ViewState()` 呼叫——`failedLogs` 記的是「哪次寫入失敗」，身份/學校切換若不清空，操作日誌頁籤的「寫入失敗」橫幅會沿用上一位使用者（可能是不同學校）的殘留計數
- **[輕9]**（原編號 8 併入中1；此處為報告取捨記錄）`userDirectory/{uid}` 與報告 §4.2 規劃中的 `schoolOwners/{uid}` 高度重疊，Stage 4 收斂方向已記錄於下方「取捨與報告規格出入」
- **[中10]** 部署矩陣訂正：「新 client × 舊 rules」時每次登入的失敗請求數，原稿估計「兩次」，但 `onAuthStateChange` 在單次登入過程中會因 Firebase SDK 內部行為 re-emit 多次，實測環境下 `resolveIdentity()` 平均被觸發 2 次、每次各 2 次 `userDirectory` 請求，**實際約 4 次**，已於 `docs/STAGE0-DEPLOY.md`「附註：Stage 3」訂正；另補記 `userDirectory` 的 `configExists(schoolId)` 檢查構成一個 schoolId 存在性探測端點，歸入報告 §4.5 已列的「偵測式跨校探測」殘留風險類別（非新增破口），見同一份文件新增的「已知殘留風險」一節

### 取捨與報告規格出入
- **userDirectory 的 create 未加 `email_verified` 驗證**：報告 §4.1 把 `email_verified` 列為開放註冊（Stage 4）才需要的防線之一，但也提到「create 需 email_verified 可留到 Stage 4 再收緊」（本次任務規格原話）——本階段唯一的寫入路徑是登入已通過 `isMember`/`isInitialDirector` 驗證後才觸發的一次性收斂寫入，不是任意登入者可自由觸發的開放端點，故本階段不加，Stage 4 開放註冊時再收緊，已在規則與程式碼中留 TODO 註記
- **`userDirectory` 允許本人自行 `delete`**：報告 §4 沒有細談這個操作；本次判斷"本人可讀寫自己的"字面上涵蓋 delete，且目前沒有任何 client 路徑會呼叫刪除，開放此權限不構成額外風險（能刪的永遠只是自己那一份，刪除後下次登入會重新走 fallback），故予以開放，為未來「使用者主動離開學校」之類的功能保留彈性
- **`semesterState.js` 未改為 `Map<schoolId, semesterId>`**：該檔案 Stage 2 驗收修復（輕 11）曾預告 Stage 3 可能需要這個改動；重新評估後判斷不需要——理由見上方「新增（快取隔離）」一節，「一個分頁同時只服務一所學校」的前提沒有被 Stage 3 打破，用 `resetV2ViewState()` 補一行清空即可解決實際的殘留風險，改用 Map 只是換一種形式維護同一份「單一作用中值」的狀態，不會多解決任何問題，且會讓所有既有呼叫端（`getCurrentSemesterId()`/`setCurrentSemesterId()`）的呼叫介面被迫改變（本次任務範圍之外的擴大改動）
- **localStorage 遷移用「複製」而非「搬移」**：任務規格原文使用「搬移」一詞，但同時要求「V1 模式維持舊 key 不動」——若真的搬移（含刪除舊 key），使用者之後切回 V1 模式會看到資料消失，與後者要求直接衝突。判斷「複製、不刪除舊 key」才是唯一能同時滿足兩項要求的實作，已在程式碼與本文件中明確記錄這個字面出入
- **`userDirectory/{uid}` 與報告 §4.2 規劃中的 `schoolOwners/{uid}` 高度重疊**（opus 驗收 輕9）：兩者結構幾乎相同（doc id 綁 uid、記錄一段歸屬關係），差別只在 `schoolOwners` 多了「一人一校、只能 create 不能 update」這個更嚴格的硬約束（見報告 §4.2 的 `schoolOwners` 規則片段），是為「全自助建校」變體設計的節流閥。Stage 4 若採報告推薦的「變體 B：自助申請＋平台管理者審核開通」，`schoolOwners` 的「防止同一人建立第二所學校」語意仍有價值，但不必是獨立集合——建議收斂方向：**Stage 4 直接沿用 `userDirectory` 作為唯一的 uid→schoolId 反查來源，在其上加一個 `role: 'owner' | 'member'`（或等義）欄位區分「這個人是否為建校者」，或改用 create-only 的子規則（`userDirectory` 一旦建立 `schoolId` 後不可 update 改成別的學校）來實現「一人一校」的約束**，而不是維護兩個內容高度重疊、容易漂移不同步的頂層集合。此為 Stage 4 規劃階段的取捨方向記錄，本階段（Stage 3）不實作 `schoolOwners`，也不改動 `userDirectory` 現有的 `create`/`update` 皆允許的權限（本階段自救機制正需要 `update`，見 `authGuardV2.js` 的自救分支說明）

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 5：封存與生命週期工具（未 commit）

依 `docs/RESEARCH-multitenancy-semester.md` §6.2（封存流程＋三個陷阱）／§6.5（operationLogs 衝突解法 b）／§8 Stage 5。動機：完成「保留 3 年 → 期滿匯出封存 → 從雲端刪除」的生命週期閉環。設定頁新增「資料封存」卡片（director 專用，緊鄰「學期管理」）：選學期 → 匯出該學期完整資料（課表、`substituteRecords`/`pendingRequests` 含 private/detail、`operationLogs`）為單一 JSON → 選擇剛下載的檔案做 SHA-256 雜湊 + 雲端當下筆數雙重驗證 → 輸入學期代碼二次確認 → 執行刪除（僅限非目前學期；private/detail 先刪、父文件後刪，沿用既有 `deleteSubstituteRecordsBatch`/`deletePendingRequestsBatch`；課表 doc 一併刪除）→ 寫入不可改/刪的 `archives/{semesterId}` 封存紀錄與操作日誌。全流程每一步失敗或資料在期間漂移都 fail-closed 中止、不推進到可刪除狀態。`operationLogs` 不在 UI 刪除範圍內（client 規則本次未鬆綁「不可改/刪」），改由新增的離線腳本 `scripts/cleanup-operation-logs.js`（`--before=<日期>`，預設 dry-run、需 `--yes` 才實際刪除，永遠先匯出備份）以 gcloud REST 憑證清理，腳本頭註記已核實「gcloud OAuth 憑證不受 client Security Rules 限制」這個前提（引 `firestore-backup.js`/`backfill-semester-id.js` 既有行為為佐證）。opus 驗收第一輪不通過（2 阻斷/4 中/7 輕），第二輪重驗定案通過、追加 6 項非阻斷收尾（1 中/5 輕），本條目已含兩輪全部修復。**只寫程式碼，未寫 Firestore、未部署、未跑 `cleanup-operation-logs.js`、未 commit。**

### 修復（第二輪 opus 驗收：1 中、5 輕，重驗定案通過後的收尾）
- **[中2]** `docs/STAGE5-ARCHIVE.md` 原文誤稱「規則未部署時匯出完全正常、只有刪除受影響」——訂正：輕7+8 讓匯出前必先呼叫 `getArchiveRecord()`（讀 `archives/` 集合），該集合在舊規則下完全沒有 `match` 區塊、預設 `DENY`，規則未部署時**匯出本身就會被擋下**（`permission-denied`），不是只有刪除功能受影響。部署順序段落已改標「強制」而非「建議」，並新增驗證清單 5j 核對此行為
- **[輕1（原編號中1，重新分類為文件澄清）]** `schoolDataService.js` 的 `getRecordDetailsBulk()` 註解原本描述了一個從未存在的「`hasSensitive` 硬比對」機制（`hasSensitive` 只是 `splitSensitive()` 寫入當下的暫時判斷，從未落盤、讀取路徑上無法回頭比對）——刪除該段錯誤描述，改寫為如實的完整性保證機制：僅 `exists()===false` 視為「真的沒有 detail」，其餘任何錯誤一律中止
- **[輕3]** `getRecordDetailsBulkStrict()`/`getRequestDetailsBulkStrict()` 改用 `Promise.allSettled`（共用新輔助函式 `settleStrictDocReads()`）取代 `Promise.all`，彙整後只拋出第一個失敗原因——避免多筆同時 reject 時，未被 `await` 接住的其餘 rejection 被 JS runtime 記成 unhandled rejection 噪音
- **[輕4]** `batchDeleteRefGroups()` 改為依「累計操作數」（`MAX_OPS_PER_BATCH=500`，Firestore 官方硬上限）分塊，取代原本假設「每筆最多 2 個 ref」的固定筆數分塊（`CHUNK_SIZE_ITEMS=200`）——消除「未來若某筆 ref 數超過 2，200 筆可能就超過 500 上限」的隱患；分塊判斷仍在「加入這一筆之前」進行，同一筆的 ref 保證不被切開
- **[輕5]** `executeSemesterArchiveDelete()` 在寫入 `archives/{semesterId}` 封存紀錄前，新增一次刪除後複查（重用 `fetchSemesterArchiveSnapshot()`）：`substituteRecords`/`pendingRequests` 筆數與 `hasSchedule` 三項皆須為「空」才寫紀錄；任一項有殘留則中止、不寫紀錄，並提示人工檢視——避免 `archives` 這份 create-only、永久不可改/刪的紀錄，在資料實際上還有殘留時就被誤寫成「已完整封存」
- **[輕6]** `switchToNewSemester()` 的「`config` 更新成功、`schedules/{toId}` 建立失敗」分支新增呼叫 `showSemesterChangedBanner(toId)`（既有機制，強制提示使用者重新整理）——避免 `semesterState` 已切換到新學期，但 bootstrap 建立的即時訂閱仍綁定舊學期查詢條件的半套狀態被使用者忽略

### 修復（第一輪 opus 驗收：2 阻斷、4 中、7 輕）
- **[阻斷1，fail-open]** `collectSemesterArchiveData()` 原本用 `getSchedule(semesterId).catch(() => null)` 與一般版 `getRecordDetailsBulk`/`getRequestDetailsBulk`（吞掉 permission-denied）讀取封存資料——對執行封存的 director 而言，讀自己學校的 private/detail 理論上不可能合法遇到 permission-denied，若真的發生代表異常，卻會被靜默當成「沒有」，讓殘缺的匯出通過雜湊驗證後被拿去執行刪除。改為：課表改用不含 legacy fallback、不吞任何錯誤的 `getScheduleForSemesterStrict()`；私有明細改用新增的「零容忍」版本 `getRecordDetailsBulkStrict()`/`getRequestDetailsBulkStrict()`（只有 `snap.exists()===false` 才代表「真的沒有」，其餘任何錯誤一律 rethrow）。一般版 `getRecordDetailsBulk`/`getRequestDetailsBulk`（給一般教師 UI 讀取「不屬於自己」的紀錄容錯用）維持原行為不變，只是內部改自行呼叫 `getDoc()` 並顯式判斷 `isBenignReadError()`（僅 `permission-denied`/`not-found`）
- **[阻斷2，recount 未真正 gate 刪除清單]** 原設計是「recount（只查筆數）→ 比對通過 → 另外再查一次完整文件當刪除清單」，兩次查詢之間存在時間窗，刪除清單其實是 requery 當下的新狀態，並未真的被核對過。改為新函式 `fetchSemesterArchiveSnapshot()`：一次查回完整文件陣列＋筆數，**刪除步驟直接重用同一次查詢的結果去執行刪除，不再另外 requery**；並新增 `idSetsEqual()` 比對 ID 集合是否完全相同（不只是筆數相同——同一時間窗內刪一筆、加一筆，筆數不變但集合已不同）
- **[中3，讀取量修正]** `fetchSemesterArchiveSnapshot()` 不含 operationLogs（理由：歷史學期的 operationLogs 在寫入規則下結構上不可能再變動，見該函式註解），配合阻斷2 消除重複 query，大校情境下單次完整流程讀取量從約 46,503 降到約 24,603（降幅約 47%，`docs/STAGE5-ARCHIVE.md`「何時該做一次封存」一節已補上實算表訂正原版粗估）
- **[中4]** 新增 `getScheduleForSemesterStrict(semesterId)`：不含 `getSchedule()` 的 legacy fallback（避免歷史學期誤讀到不屬於自己的舊版單一課表文件，污染封存內容與 `hasSchedule` 判斷）
- **[中5]** `pendingRequests/{reqId}/private/detail` 的 `create`/`update` 補歷史學期唯讀鎖（新增 `parentPendingRequestCurrentSemester`/`parentAllowsNewPendingRequestPrivateDetail`，比照 `substituteRecords` 側 Stage 2 已有的同款函式），原本完全沒有學期鎖，approver 理論上可對歷史學期的待審請求私有明細任意補建/竄改
- **[中6]** `writeArchiveRecord()` 文件訂正：Firestore 規則判斷 create/update 看「文件此刻是否已存在」而非呼叫端用 `setDoc` 還是 `updateDoc`，故重試（該學期已有封存紀錄時）會被 `allow update: if false` 直接擋下失敗，不是原文誤寫的「整份覆寫也沒問題」；配合輕7+8 從 UI 源頭盡量避免走到重試路徑
- **[輕7+8]** `v2ListSemesterOptions()` 併入 `dataSvc.listArchivedSemesterIds()`（新增），修復封存刪除後該學期從所有下拉選單消失的問題；`renderArchiveAdminTab()` 新增 `getArchiveRecord()` 檢查，已封存學期停用匯出/刪除鈕並顯示封存摘要
- **[輕9]** `batchDeleteRefs(fs, refs)` 改為 `batchDeleteRefGroups(fs, refGroups)`：以「筆」而非攤平陣列的固定數量分塊——原本「CHUNK_SIZE 為偶數即可保證母子同批」的技巧，前提是每筆恆貢獻 2 個 ref，輕10 引入「只有真的有 detail 才刪 detail ref」後這個前提不再成立，必須改用依筆分塊
- **[輕10]** 新增 `deleteSubstituteRecordsBatchKnownDetail`/`deletePendingRequestsBatchKnownDetail`：只對「匯出當下已知有 private/detail」的 id 送出 detail 刪除請求，避免對沒有 detail 的紀錄發送必然 no-op 的刪除
- **[輕11]** `archives/{semesterId}` 規則的 `note` 欄位加 `is string && size() < 500`；訂正規則註解中「封存紀錄是完整匯出並刪除的證明」這類誇大說法，改為如實描述「是什麼、不是什麼」
- **[輕12]** `executeSemesterArchiveDelete()` 刪除前確認「目前作用中學期」改用新增的 `getConfigFromServer()`（強制直讀伺服器、略過本機快取，`firebaseV2.js` 新增 `getDocFromServer` 匯出）
- **[輕13，Stage 2 遺留]** `switchToNewSemester()` 寫入順序對調：`upsertConfig({currentSemester: toId})` 改到 `saveSchedule(toId)` 之前——原順序在規則部署後，`schedules/{toId}` 的寫入會因為當下 `config.currentSemester` 還是 `fromId` 而必定被 `isCurrentSemester()` 拒絕。若 `saveSchedule(toId)` 之後仍失敗，`config.currentSemester` 已指向新學期（可接受狀態，課表可稍後補上傳），錯誤訊息已改為明確說明「已切換但課表建立失敗」

### 新增（規則，`firestore.rules` v2.4 → v2.5）
- `schedules/{semesterId}` 的 `write` 拆成 `create/update`（維持原「僅目前學期」鎖，行為不變）+ `delete`（新增：director 專用，且僅能刪「非目前學期」——供封存流程刪除歷史學期課表使用，目前學期課表不可被此規則刪除）
- 新增 `archives/{semesterId}`：`read` 限 approver；`create` 限 director + 欄位白名單/型別驗證（`semesterId`/`archivedAt`/`archivedBy`/`counts`/`jsonHash`/`note`，`note` 另加字數上限）；`update`/`delete` 恆 `false`，比照 `operationLogs` 的稽核軌跡不可改/刪設計
- `pendingRequests/{reqId}/private/detail` 的 `create`/`update` 補歷史學期唯讀鎖（見上方中5修復）
- `substituteRecords`/`pendingRequests` 既有 `delete` 規則（director-only／approver-or-initiator，皆無學期鎖）、`operationLogs` 的「不可改/刪」規則**皆未變動**，已核實對封存流程的刪除範圍放行

### 新增（`schoolDataService.js`）
- `deleteScheduleForSemester(semesterId)`：刪除 per-semester 課表文件
- `getScheduleForSemesterStrict(semesterId)`（中4新增）；`getConfigFromServer()`（輕12新增）
- `listSubstituteRecordsBySemesterForArchive`／`listPendingRequestsBySemesterForArchive`／`listLogsBySemesterForArchive`：封存專用的一次性查詢，刻意不帶 `orderBy`（只用單欄位 `where`，不需要額外複合索引，與既有「歷史學期檢視」用途的 `listSubstituteRecordsBySemester` 分開維護）
- `getRequestDetailsBulk`：`pendingRequests` 版本的批次讀取私有明細（比照既有 `getRecordDetailsBulk`）；`getRecordDetailsBulkStrict`/`getRequestDetailsBulkStrict`（阻斷1新增，零容忍版本，只給封存匯出鏈用）
- `listArchivedSemesterIds()`（輕7+8新增）
- `deleteSubstituteRecordsBatchKnownDetail`/`deletePendingRequestsBatchKnownDetail`（輕10新增）；`batchDeleteRefs`→`batchDeleteRefGroups`（輕9，改依筆分塊）
- `writeArchiveRecord`／`getArchiveRecord`：封存紀錄的寫入與讀取
- `SCHEMA_PATHS.archivesCol`／`archiveDoc`；`LOG_ACTIONS.SEMESTER_ARCHIVE`

### 新增（`v2-app.js`：`renderArchiveAdminTab()` 與封存流程狀態機）
- 三段狀態機 `null → 'exported' → 'verified'`：匯出（`runSemesterArchiveExport`，含進度顯示、`crypto.subtle` 計算 SHA-256、觸發下載）→ 驗證（`verifyArchiveExportFile`，比對雜湊 + 雲端當下筆數與 ID 集合，任一不符即中止且不解鎖刪除）→ 刪除（`executeSemesterArchiveDelete`，執行前重新讀 `config.currentSemester`（`getConfigFromServer`）確認非目前學期、重新核對筆數與 ID 集合抓漂移，任何一項失敗即 throw、不刪除）
- `fetchSemesterArchiveSnapshot`／`diffArchiveCounts`／`idSetsEqual`：驗證與刪除前的重新核對，刪除步驟直接重用查詢結果（阻斷2）
- 設定頁新卡片「資料封存」（`index.html` `#v2-archive-admin`，緊鄰 `#v2-semester-admin`）；已封存學期自動停用匯出/刪除鈕（輕7+8）；`resetV2ViewState()` 新增 `_archiveState` 清空與 `v2-archive-admin` 併入 `V2_IDENTITY_CONTENT_HOSTS`（身份切換不沿用前一位使用者的匯出狀態）
- 版本號 bump：`index.html` 的 `v2-app.js?v=0.1.8`

### 新增（離線腳本）
- `scripts/cleanup-operation-logs.js`：`--before=<YYYY-MM-DD> [--school=] [--yes] [--dry-run]`，比照 `firestore-backup.js`/`backfill-semester-id.js` 的 gcloud token + REST 慣例；永遠先匯出備份到 `backups/firestore/operationLogs-cleanup/`，`--yes` 才實際 DELETE；`timestamp` 缺席/格式異常的文件 fail-closed 略過不刪

### 新增（文件）
- `docs/STAGE5-ARCHIVE.md`：部署順序（規則先於前端）、3 年保留的封存 SOP（含 opus 驗收修正後的實算讀取量）、驗證清單（5a-5i）、已知限制（缺 `semesterId` 的舊日誌、director 信任邊界、雜湊驗證的侷限性、零容忍錯誤處理的適用範圍，皆誠實列出）

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 2：學期欄位化（含 opus 驗收修復，未 commit）

依 `docs/RESEARCH-multitenancy-semester.md` §5/§6.1/§8 Stage 2。動機：課表原本是單一文件整份覆寫（換學期即蓋掉舊課表）、紀錄無學期標記、`config.currentSemester` 是 bootstrap 寫入但 src/ 零讀取的死欄位。本次把學期升級為一級概念：`currentSemester` 活化為全 app 的「目前作用中學期」；課表改 per-semester 文件；`substituteRecords`/`pendingRequests`/`operationLogs` 新寫入一律帶 `semesterId`；規則層加學期唯讀鎖（歷史學期不可再新增/編輯）；紀錄頁新增歷史學期一次性檢視；設定頁新增「學期管理」（director 專用，開新學期）。opus 驗收第一輪不通過（2 阻斷/5 中/5 輕），第二輪重驗兩個阻斷已通過、追加 R1（阻斷級資料遺失）+ R2-R4（輕）+ R5-R6（文件註記），本條目已含兩輪全部修復。**只寫程式碼，未寫 Firestore、未部署、未跑 v2-rules-matrix.mjs、未 commit。**

### 修復（第二輪 opus 重驗：R1 阻斷、R2-R4 輕、R5-R6 文件註記）
- **[R1，阻斷級資料遺失]** `switchToNewSemester()` 原本用 `listKnownSemesterIds().catch(() => [])` 判斷 `schedules/{fromId}` 是否已存在，讀取失敗時 catch 吞掉錯誤回傳空陣列，會讓判斷誤成立、把可能已有真實課表資料的 `schedules/{fromId}` 整份覆寫成空殼——覆寫後 `fromId` 不再是目前學期，寫入規則禁止回寫，資料永久遺失。改為：用 `getSchedule(fromId)` 直接確認內容（含 per-semester 文件與 legacy fallback）；讀取失敗直接 rethrow 中止整個切換（fail-closed，與中 4 同一原則）；只有確認回傳 `null`（真的沒有任何資料）才建立空殼
- **[R2，輕]** `substituteRecords/{id}/private/detail` 的 **create** 規則也補上歷史學期鎖（原本只鎖了 update），擋「approver 為已鎖定的歷史紀錄事後補建 leaveType，藉此影響結算」。新增 `parentAllowsNewPrivateDetail()`——與 update 版本的 `parentSubstituteRecordCurrentSemester()` 刻意採不同的「父文件不存在」處理方式：`create` 時父文件本來就還沒寫入（`schoolDataService`/`pendingRequestService` 皆先寫 private/detail 後寫父文件），須放行；`update` 時父文件不存在屬異常狀態，維持拒絕
- **[R3，輕]** `isDeclaredLegacyWrite()` 原本在 `isDirector()` 定義「之前」就呼叫它（全檔唯一一處前向參考），改為移到 `isDirector()` 定義之後，避免任何規則引擎/工具鏈版本對前向參考支援度落差帶來部署期意外
- **[R4，輕]** `CHANGELOG.md`／`docs/CHANGELOG.md` 的「新增」段落訂正：`isDeclaredLegacyWrite` 描述補上 `isDirector`/`migratedFrom`/字串型別三條件（原文只寫「豁免」，是修復前的舊描述）；`substituteRecords` update 補上「須仍是目前作用中學期」（原文只提不可變，遺漏阻斷 2 修復的另一半）；`pendingRequests (status, createdAt)` 索引訂正為「保留」（原文寫「移除」，若照做部署會刪掉降級路徑需要的索引）；測試筆數「28 條」訂正為「34 條」（輕 12 又新增 6 條後未同步）
- **[R5，文件註記]** `parentSubstituteRecordCurrentSemester()` 補一行註解：父文件不存在時 `get(...).data` 求值錯誤、規則引擎視為條件不成立（deny），這是刻意接受的 fail-closed 行為，不需要额外用 `exists()` 放寬（因為對 update 而言父文件不存在代表資料異常）
- **[R6，文件註記]** `firestore.rules` 檔頭與 `README.md` 明寫信任根設計的既有事實：學期唯讀鎖對 director 不構成實質約束——`isDeclaredLegacyWrite()` 只要求 `isDirector(schoolId)` 成立即可豁免學期鎖，`config.currentSemester` 本身也只有 director 能改（`config/{docId}` 的 write 規則），一個惡意或被入侵的 director 帳號理論上可以宣告任意寫入為 legacy、或直接把 `currentSemester` 改成任意值再寫入——這與系統既有的其他 director-only 破壞性操作（刪除任何紀錄、刪除教師、清除所有資料）同一信任層級，不是這次新增的破口，只是首次被明確寫下來

### 修復（第一輪 opus 驗收：阻斷）
- **[阻斷1] `isDeclaredLegacyWrite` 可被自我宣告繞過學期鎖**：原本只檢查請求自帶的 `isLegacy==true`，任何通過父層 create 條件的寫入者（approver 或 isSelfSwap 分支的一般教師）都能靠自我宣告偽造任意歷史學期的紀錄。收緊為 `isDirector(schoolId) && isLegacy==true && migratedFrom 存在 && semesterId is string`（`firestore.rules`）；已核實 `legacyMigrationService.js` 的遷移入口本來就是 `roleService.canManageRoster()`（＝`isDirector()`），且寫入的 payload 本來就帶 `migratedFrom` 與（經 `createSubstituteRecord` fallback 保證的）字串 `semesterId`，收緊不影響既有流程
- **[阻斷2] substituteRecords update 只鎖了 semesterId 欄位、沒鎖住歷史紀錄本身**：原規則只保證 `semesterId` 不可被改，但沒檢查「這筆紀錄現在所屬的學期是否仍是目前作用中學期」——歷史紀錄的日期/教師/節次等其他欄位在修復前仍可被 approver 任意編輯。補上 `isCurrentSemester(schoolId, resource.data.semesterId)` 條件（含回填前 `!('semesterId' in resource.data)` 相容豁免）；`substituteRecords/{id}/private/detail` 的 update 同步補鎖（新增 `parentSubstituteRecordCurrentSemester()` 讀父文件判斷，這條路徑新增的唯一一次額外 `get()`）。同步修正 `README.md`／`firestore.rules` 檔頭原本「宣稱有鎖」但實際只鎖半套的不實描述

### 修復（中，opus 驗收）
- **[中3] 學期切換未跨 client 傳播**：`switchToNewSemester()` 只更新自己這個分頁的狀態＋reload，其他仍開著頁面的使用者不會知道學期已切換。新增 `schoolDataService.subscribeConfig()` 訂閱 `config/main`（單文件成本可忽略），bootstrap 掛入既有訂閱管理；偵測到 `currentSemester` 變更時顯示不會自動消失的橫幅（`showSemesterChangedBanner()`），要求重新整理。`STAGE0-DEPLOY.md` 補公告要求
- **[中4] 在途申請黑洞**：學期切換若在有未結案 `pendingRequests`（待同意/待核准）時發生，這些申請的 `semesterId` 會停在舊學期，日後核准會因學期不一致被規則拒絕。切換前先呼叫 `listOpenPendingRequests()` 檢查，非 0 筆就擋下並提示「請先處理完 N 筆在途申請」
- **[中5] 歷史學期在 UI 不可達**：學期選擇器的資料來源是 `schedules/` 集合，若「即將變成歷史」的舊學期從未有人上傳過課表，就沒有對應文件、選單裡完全選不到。`switchToNewSemester()` 改為先確保 `schedules/{fromId}` 存在（缺就補空殼，且必須在改 `config.currentSemester` 之前做——寫入規則只放行目前學期那一份文件，過了這個窗口就再也補不了）。`STAGE0-DEPLOY.md` 補充正式庫 `schedules/` 目前為空的現況與建議動作
- **[中6] rules 對未定義欄位的隱含依賴**：`substituteRecords`/`pendingRequests` create 規則原本直接存取 `request.resource.data.semesterId`，新 rules＋舊 client 過渡窗口內舊 client 不帶這個欄位，屬存取未定義 map key。補上 `('semesterId' in request.resource.data) &&` 顯式檢查，讓拒絕行為明確可預期；`STAGE0-DEPLOY.md` 補這段窗口「全校無法新增紀錄/申請」的說明與部署順序要求
- **[中7] 多項一致性修復**：`firestore.indexes.json` 恢復保留 `pendingRequests (status, createdAt)` 舊索引（給客戶端版本不同步的降級路徑用，不再標記移除）；`getSchedule`/`saveSchedule`/`subscribeSchedule`/`createSubstituteRecord`/`createPendingRequest` 在 `semesterId` 缺席時改為擲出明確訊息的錯誤（`requireScheduleSemesterId()`），不再是含糊的 `缺少 semesterId`；訂正 bootstrap 內「semesterState 未初始化時全面優雅退化」的過度樂觀宣稱——如實區分「查詢類確實會優雅退化」與「課表／新增寫入類其實是硬失敗」

### 修復（輕，opus 驗收）
- **[輕8]** 「清除所有資料」confirm 文案改為如實描述：課表僅清「目前學期」、紀錄與待審請求清全部學期、舊版 `data/schedule` 不受影響
- **[輕9]** `STAGE0-DEPLOY.md` 索引部署段落「四條」訂正為「三條」（不再移除舊索引，淨變動是新增 3 條、既有 3 條全部保留）
- **[輕10]** `queryRecordsByDateRange` 註解原主張「週彙整查一週不可能跨學期邊界」是錯的（1/31→2/1 這種邊界，一週的滾動區間可能同時涵蓋兩個學期）；訂正理由為「日期範圍 range query 本身語意正確完整，疊加 `semesterId` 條件反而會把橫跨邊界那週的合法紀錄濾掉」，結論（不加條件）不變但理由改對
- **[輕11]** `semesterState.js` 補註：目前是單一模組層級變數，成立前提是「一個分頁只服務一所學校」，Stage 3 `SCHOOL_ID` 動態化後需改為以 schoolId 為 key 的 Map
- **[輕12]** `dateToSemesterId` 補日期往返驗證（`new Date(y,m-1,d)` 反查），修正 `'2026-02-31'` 這類正則能過但日期不存在的輸入原本會被誤判為合法；`backfill-semester-id.js` 內重複定義的同款函式同步修正；新增 6 條單元測試（含閏年 2/29 正反例）

### 新增（學期推導，`src/js/modules/v2/semesterUtils.js`＋`semesterState.js`）
- `dateToSemesterId(dateStr)`／`todaySemesterId()`／`parseSemesterId`／`isValidSemesterId`／`compareSemesterId`／`nextSemesterId`：純函式，`semesterId` 格式沿用 bootstrap 既有的 `'114-2'`（民國學年-學期）。台灣學年度切分：8 月～翌年 1 月＝第 1 學期，2～7 月＝第 2 學期
- `semesterState.js`：session 記憶體快取目前作用中學期，供寫入/查詢路徑取用，不必每個呼叫點各自重讀 `config`
- `test/test-semester-utils.mjs`：34 條單元測試（含驗收修復 輕12 新增的 6 條日期往返驗證），涵蓋台灣學年度四個邊界（8/1、1/31、2/1、7/31）、民國年換算（與 `settlementCalculator._resolveMonth` 反向交叉驗證）、格式容錯、日期往返驗證（`2026-02-31`／`2026-04-31`／閏年 2/29 正反例）、`parseSemesterId`/`compareSemesterId`/`nextSemesterId`；已加入 `npm test`

### 新增（課表 per-semester 化，`schoolDataService.js`）
- `SCHEMA_PATHS.scheduleDocForSemester(sid)`／`schedulesCol()` 取代 `data/schedule` 單一文件；`getSchedule(semesterId)`/`saveSchedule(semesterId, data)`/`subscribeSchedule(semesterId, cb, onError)` 全改吃 `semesterId`
- 相容遷移雙保險：`getSchedule`/`subscribeSchedule` 內建一次性讀取 fallback（per-semester 文件不存在時退回讀舊 `data/schedule`）＋獨立腳本 `scripts/migrate-schedule-to-semester.js`（`--dry-run` 預設）
- `listKnownSemesterIds()`：讀 `schedules/` 集合當作學期註冊表，供學期選擇器下拉選單使用

### 新增（`semesterId` 欄位化＋查詢下推，`schoolDataService.js`）
- `createSubstituteRecord`/`createPendingRequest`：`semesterId` 未帶時自動蓋「寫入當下的目前學期」（`semesterState` 快取）；`updateSubstituteRecord` 防禦性剝除 patch 內的 `semesterId`（不可變欄位）
- `subscribeSubstituteRecords`/`listSubstituteRecordsPage`/`subscribePendingRequests`/`listOpenPendingRequests` 加 `semesterId==目前學期` 條件；新增 `listSubstituteRecordsBySemester(semesterId)`（歷史學期一次性查詢）
- 刻意不加 `semesterId` 條件的查詢與理由（各自函式已加註解）：`queryRecordsByExactDate`/`queryPendingRequestsByExactDate`（單一日期天然對應唯一學期）、`queryRecordsByDateRange`（呼叫端的日期範圍天然落在單一學期內）、`listPendingRequestsByInitiator`（用途就是要看橫跨學期的個人歷史）
- `operationLogger.log()` 加 `semesterId`（供 Stage 5 封存分批用）；`legacyMigrationService.js` 改依 `legacy.date` 反推 `semesterId`（歷史正確），不沿用「目前學期」預設值

### 新增（UI，`v2-app.js`＋`index.html`）
- 紀錄頁新增「學期」選擇器：當前學期沿用 Stage 1 即時訂閱＋分頁；選歷史學期改一次性查詢＋記憶體快取（`v2GetRecordsBySemester`），停用起訖日期篩選並提示「唯讀」
- 設定頁新增「學期管理」卡片（`v2-director-only`，`renderSemesterAdminTab`）：顯示目前學期、「開新學期」輸入框＋confirm modal（說明後果：舊學期變唯讀、新學期需重新上傳課表）；確認後建立空殼 `schedules/{new}`、更新 `config.currentSemester`、寫入操作日誌（新增 `LOG_ACTIONS.SEMESTER_SWITCH`）、`reload()` 頁面重建所有訂閱（沿用既有「清除所有資料」的 reload 慣例，不另寫原地重新訂閱機制）
- bootstrap 新增「學期設定」步驟：讀 `config.currentSemester`，缺席時 fallback 為 `semesterUtils.todaySemesterId()`（依今天日期推算，報告未給明確 fallback 規則時的取捨，見程式內註解）

### 新增（規則，`firestore.rules` → v2.4，以下為含全部驗收修復後的最終形狀——見上方阻斷/中/輕各項的修復過程）
- `isCurrentSemester(schoolId, sid)`：讀 `config/main`（已在 `isApprover`/`isInitialDirector` 判斷鏈中讀過一次，計費成本 0，理由同 §3.6）
- `isDeclaredLegacyWrite(schoolId, data)`：豁免 `legacyMigrationService` 的歷史資料遷移，須同時滿足 `isDirector(schoolId)` + 請求自帶 `isLegacy==true` + `migratedFrom` 欄位存在 + `semesterId` 為字串（阻斷 1 修復後的最終條件；只看自身欄位與已在權限鏈讀過的 `isDirector`，零額外 `get()`）
- `parentSubstituteRecordCurrentSemester()`／`parentAllowsNewPrivateDetail()`：`substituteRecords/{id}/private/detail` 的 update／create 各自的歷史學期鎖判斷（阻斷 2、R2 修復；後者對「父文件尚不存在」的處理刻意與前者相反，見 `firestore.rules` 兩函式定義處的說明）
- 新增 `schedules/{semesterId}` match 區塊：讀取全體成員，寫入限 approver 且僅能寫「目前學期」那一份
- `substituteRecords` create：`(isDeclaredLegacyWrite 豁免 || ('semesterId' in request.resource.data && isCurrentSemester))`；update：`semesterId` 不可變 **且該紀錄現在所屬的學期須仍是目前作用中學期**（阻斷 2 修復，原版只鎖了前者），含 `'semesterId' in resource.data` 短路豁免（回填腳本執行前的舊文件仍可正常編輯）
- `substituteRecords/{id}/private/detail` create：加 `parentAllowsNewPrivateDetail()`（R2 修復，擋「approver 為已鎖定的歷史紀錄事後補建 leaveType 影響結算」）
- `pendingRequests` create：同樣加學期鎖（超出報告 §6.1 明文只提到 `substituteRecords` 的範圍，見下方取捨）
- `operationLogs` create 欄位白名單加入 `semesterId`

### 新增（索引與腳本）
- `firestore.indexes.json`：新增 `substituteRecords (semesterId ASC, createdAt DESC)`／`(semesterId ASC, date DESC)`／`pendingRequests (semesterId ASC, status ASC, createdAt DESC)`；**既有的 `pendingRequests (status ASC, createdAt DESC)` 索引保留不動**（中 7 修復訂正——原稿曾規劃移除，實際判斷為降級路徑的安全網而保留，`firestore.indexes.json` 目前內容以保留為準，部署時不要依照任何早於本條目的敘述去移除它）；`docs/STAGE0-DEPLOY.md` 補「附註：Stage 2」記錄部署順序（本次未部署）
- `scripts/backfill-semester-id.js`：回填 `substituteRecords`/`pendingRequests`（依 `date`）／`operationLogs`（依 `timestamp`）的 `semesterId`，`--dry-run` 預設
- `scripts/migrate-schedule-to-semester.js`：舊 `data/schedule` → `schedules/{semesterId}`，`--dry-run` 預設

### 取捨與報告規格出入
- **stats 彙總文件（§5.5/§8 Stage 2 列）未實作**：報告 §8 的 Stage 2 列有提到，但本次 prompt 給的明確 8 條範圍未列入；跨學期統計是獨立的原子 increment + 重算按鈕功能，改動面不小，判斷為超出本次範圍，留待 Stage 5 或另行排期
- **pendingRequests 的學期唯讀鎖**：報告 §6.1 條文只明講 `substituteRecords`，但本次 prompt 第 5 項明確要求兩個集合都要鎖；已依 prompt 加上（cost 仍為 0，理由與 `substituteRecords` 相同），未違背報告，只是報告文字沒寫到這麼細
- **`subscribeSubstituteRecords`/`subscribePendingRequests` 排序**：報告 §5.4 示意用 `orderBy('date')`，Stage 1 實際程式碼已用 `orderBy('createdAt')`；本次維持 `createdAt`（與 Stage 1 一致、改動面最小），只在新增的 `listSubstituteRecordsBySemester`（歷史學期瀏覽）改用 `orderBy('date')`——差異與理由見 `schoolDataService.js` 該函式註解
- **approveRequest 的 `semesterId` 歸屬**：核准把 pendingRequest 轉成 substituteRecord 時，改用「核准當下」而非「申請當下」的目前學期（避免申請在途期間跨學期切換時被學期鎖擋下）；已知限制：極少數「申請在途、期間切換學期」的紀錄會被記到核准當時的學期，而非申請當時
- **`clearAllSchoolData` 的課表清除範圍**：多學期化後只重置「目前學期」`schedules/{cur}`，不觸及歷史學期課表——沿用該函式原本「只有一份 schedule doc」的既有語意，不在未被要求的情況下擴大成「刪除全部歷史課表」

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 1：讀取成本止血（含兩輪 opus 驗收修復）

依 `docs/RESEARCH-multitenancy-semester.md` §5.4/§5.6/§8 Stage 1。動機：§7.3 推算現行整集合訂閱模式下，`inhu` 單校已用掉 Spark 每日免費讀取額度約 78%，累積約 700 筆紀錄即撞頂——是現行系統的存續問題。核心改動：把「頁面載入」的讀取量從隨紀錄數線性成長改為有界。第一輪 opus 驗收不通過（3 阻斷/5 中/5 輕），修復後第二輪瀏覽器實測確認阻斷與多數項目已修好，另揪出 A-G 共 7 項（1 中偽陰性、1 中夾界方向錯、5 輕）。本條目已含兩輪全部修復。獨立驗證、尚未 commit。

### 新增（有界訂閱與分頁，`schoolDataService.js`）
- `subscribeSubstituteRecords` 加 `limit`（預設 50，callback 第二參數帶原生 `lastDoc` 供分頁 cursor 用）；`subscribePendingRequests` 改為只監聽「仍在途」狀態（`where status in [pending, pending_swap_consent, pending_approval]`），已核准／已拒絕的歷史不再即時監聽
- 新增 `listSubstituteRecordsPage()`（**原生 QueryDocumentSnapshot 游標**分頁，供紀錄頁「載入更多」）、`queryRecordsByDateRange()`（月結算／日期篩選按需查詢，**任一端缺席時以有給的一端往缺席方向推一年**（`resolveDateRangeBounds()`），起訖顛倒時短路並提示，不再退化成整表 scan，見下方 [中B]）、`listOpenPendingRequests()`、`listPendingRequestsByInitiator()`（單一教師的請求歷史，天然有界）
- 新增 `queryRecordsByExactDate(date)`／`queryPendingRequestsByExactDate(date)`：單欄位相等查詢（`date`），供衝堂檢查按日期一次性查詢用，不需複合索引
- `subscribeOperationLogs`／`listLogs` 預設筆數 200 → 50

### 修復（阻斷，opus 驗收）
- **[阻斷1] 衝堂檢查漏檢**：`v2CheckExistingRecord` 原本只看即時訂閱視窗（最近 50 筆 `createdAt`），提前 2 週以上建立的紀錄會漏檢，可能同節課重複建檔、月結算重複計費。改為 async，用 `queryRecordsByExactDate`/`queryPendingRequestsByExactDate` 按目標日期一次性查詢；`app.js` 三個呼叫點（`handleMultiCourseSelection`／`checkAndShowExistingRecordWarning`／`confirmSubstitute`）與 `dm.checkExistingRecord` patch 一併改 async
- **[阻斷2] 代課推薦資料來源有界截斷**：`showRecommendations` 改 `await getSubstituteRecordsAsync(date, date)` 單日按需查詢，不再用同步版讀即時訂閱視窗；函式改 async，加 `_recommendationsGen` 世代守門避免快速切課競態覆蓋
- **[阻斷3] 缺索引導致全站鎖死**：`renderPendingTab` 內 `listPendingRequestsByInitiator` 缺複合索引時會 `failed-precondition`，原本會冒泡到 bootstrap 外層致命 catch、`_v2GateError=true` 永久鎖死整個 app（驗收實測全站不可用）。修復：(a) 該查詢包區塊級 try/catch，失敗只讓「我的申請」顯示錯誤卡片＋重新整理鈕；(b) 新增 `safeBootstrapStep()`，bootstrap 內「身份解析成功之後」的所有渲染／訂閱／預讀步驟一律各自降級、不冒泡到外層致命 catch，只有 `resolveIdentity()` 本身失敗才維持鎖定；(c) `docs/STAGE0-DEPLOY.md` 改寫為「索引必須先於 client 上線」硬性順序，並補充 GitHub Pages push 即上線（無 CI 閘門）放大此風險的說明

### 修復（中，opus 驗收）
- **[中4] 日期範圍查詢快取無失效機制**：`_v2DateRangeQueryCache` 在 `subscribeSubstituteRecords` onSnapshot、`adminDeleteRecord`、`writeV2Record` 成功後皆 `clear()`，避免月結算／週彙整/篩選讀到過期快取
- **[中5] 單邊日期等於整表 scan**：`queryRecordsByDateRange` 任一端缺席時自動以「當前學年度起日」／「今天」夾住
- **[中6] 「載入更多」按鈕在總筆數為 50 倍數時永不消失**：改用 `_v2RecordsTabHasMore !== null` 判斷是否已真的查過一次，不再用 `_v2RecordsTabExtra.length > 0`（查回 0 筆新資料時該長度不變，會誤判成「還沒查過」而退回錯誤的樂觀猜測）
- **[中7] 合併顯示順序覆蓋新資料**：`[..._v2RecordsCache, ..._v2RecordsTabExtra]` 對調為 `[..._v2RecordsTabExtra, ..._v2RecordsCache]`，確保同一筆 recordId 同時存在時，即時視窗（較新）蓋掉載入更多當時的舊快照
- **[中8] 見上方阻斷3的 (c)**

### 修復（輕，opus 驗收）
- **[輕9]** 紀錄頁「無日期篩選＋查無紀錄＋非 approver」時顯示提示，說明可能是紀錄較舊、不在最近 50 筆全校視窗內，建議改用日期篩選；已知限制：尚未實作「一般教師預設查詢個人歷史」（`initiatedBy`/`affectedTeacherIds` 天然有界的替代查詢），評估後認為需要新複合索引＋新分頁邏輯，非小改動，暫列已知限制
- **[輕10]** `listSubstituteRecordsPage` 游標從值游標（`createdAt`）改為原生 `QueryDocumentSnapshot`，避免同毫秒建立的紀錄用值游標分頁時漏掉或重複跳過同值的一筆
- **[輕11]** `dm.getSubstituteRecordsAsync` 刪除死碼 `const norm`，補上「date 需為 YYYY-MM-DD、不做防禦性正規化」的註解
- **[輕12]** `updateWeeklySummaryPreview` async 化後加 `_weeklySummaryPreviewGen` 世代守門，避免快速切換週次時後發先至
- **[輕13]** `searchRecords`（V1 UI，`body.v2-active` 下 CSS 隱藏不可觸達）與 `dataManager.getMonthlyRecords`（全專案無呼叫端）維持同步視窗版，各加註警告說明限制與未來若要接上該怎麼改

### 修復（第二輪瀏覽器實測 A-G）
- **[中A] 待辦佇列假陰性**：`subscribePendingRequests` 與 bootstrap prefill（`listOpenPendingRequests`）兩個資料來源同時失敗時，`_v2PendingCache` 停在初始空陣列，「待我同意/待我審核」原本會誤顯示「目前沒有…」這種看似正常的空狀態文字（假陰性，比顯性錯誤更危險），且同步中斷徽章可能被其他訂閱（如課表）成功時洗成「已同步」。修復：新增 `_v2PendingSourceError` 旗標（訂閱 onError 與 prefill 失敗時設定，任一來源成功即清除），兩區塊改顯示錯誤卡片＋重試鈕（`retryPendingSource()`）；`uiFeedback.setSyncStatus(source, ok, reason)` 改為逐一記錄每條訂閱（`pending`/`records`/`schedule`）各自的健康狀態並新增 `resetSyncStatus()`，只要還有任一來源是壞的就不移除徽章；`updatePendingNavBadge` 支援 `count===null`（顯示「!」而非悄悄變 0）；訂正 `docs/STAGE0-DEPLOY.md` 原本「待我同意/待我審核正常」的描述——分開說明兩條複合索引各自缺席時的實際影響範圍
- **[中B] `queryRecordsByDateRange` 夾界方向錯**：原本「缺席端固定夾今天/當前學年度起日」的方向會產生兩種錯誤——只填起日時把缺席的迄日夾成「今天」，未來日期的紀錄（調代課本來就可能預先排定）查不到；只填迄日且該日期早於當前學年度起日時，會產生 `effectiveStart > effectiveEnd` 的恆 0 筆查詢且無任何提示。改為 `schoolDataService.js` 新增 `resolveDateRangeBounds()`：以使用者有給的那一端為基準往缺席方向推一年（缺迄日→起日+1年；缺起日→迄日−1年），並回傳 `valid`（`effectiveStart<=effectiveEnd`）；`queryRecordsByDateRange` 內部改用此函式、`valid===false` 時短路回傳空陣列不發查詢；`renderRecordsTab` 在兩個日期篩選欄位都有值但顛倒時，同步呼叫 `resolveDateRangeBounds` 提前判斷並顯示「起訖日期範圍無效」提示，不必先送一次注定 0 筆的查詢
- **[輕C]** `checkAndShowExistingRecordWarning`（單選模式）加 `this._courseSelectionGen` 世代守門，比照 `_recommendationsGen`；`handleMultiCourseSelection`（多選模式，允許同時多格在途、不適用單一世代計數器）改用 `this._inFlightMultiCourseKeys` Set，擋同一格課程在前一次 `await checkExistingRecord()` 還沒回來前被重複點擊而並行處理
- **[輕D]** 紀錄頁空狀態提示文字移除內部驗收編號「（輕 #9…見 CHANGELOG）」，只留對使用者有意義的說明
- **[輕E]** `uiFeedback.js` 的 `failed-precondition` 原本與 `unavailable` 共用「無法連線，恢復網路後會自動同步」——這句話對 `failed-precondition` 是誤導（本專案的實際觸發情境幾乎都是複合索引未建立，跟網路無關，恢復網路不會自動好）。改為獨立訊息：「查詢所需的資料庫索引尚未建立，請聯絡管理者」
- **[輕F]** bootstrap 的「紀錄清單預讀」（`listSubstituteRecordsPage`）回傳的 `nextCursor` 順手存進 `_v2RecordsLiveLastDoc`（`_v2RecordsLiveLastDoc` 為空時才寫入，訂閱首快照回來後會自然覆蓋成更新值）——原本只有 `subscribeSubstituteRecords` 的 `meta.lastDoc` 會寫入這個變數，若訂閱遲遲沒有首次快照或訂閱本身失敗，`_v2RecordsLiveLastDoc` 會一直是 `null`，使用者點「載入更多」時 cursor 退回 `null`，等於重查第一頁、把 prefill 剛載入的 50 筆整批重抓一次
- **[輕G]** 見下方「驗證」——CHANGELOG 先前的懸空引用（「見本次修復後的最終結果，下方『驗收回報』」，該段落實際不存在）改為兩輪修復後重新實測的實際數字

### 變更（`v2-app.js`）
- 全校紀錄頁籤（`renderRecordsTab`）不再每次重繪都整集合 `getDocs`：無日期篩選時讀即時訂閱視窗＋「載入更多」分頁；有日期篩選時改一次性下推查詢 Firestore（記憶體快取）
- 待辦頁籤（`renderPendingTab`）「待我同意／待我審核」改直接讀已有界的即時訂閱快取（零額外讀取）；「我的申請」（含歷史）改按發起人一次性查詢，不再整集合讀，且已包降級保護（見阻斷3）
- 操作日誌不再於 bootstrap 常駐 `onSnapshot`，且不再於「初次渲染」無條件預讀——改為真正進入日誌頁籤才讀（該頁籤本來就是一次性 `getDocs`）
- bootstrap 的「首次塞 cache」（onSnapshot 首快照前的暫時填充）改用有界查詢，並在填充完成後主動補一次 render，避免使用者看到空白列表閃爍；兩段 prefill 皆已包降級保護
- 新增 `dm.getSubstituteRecordsAsync()`（`dataManager.js` 定義預設、V2 模式覆寫）：有日期範圍時按需查 Firestore，不再假設「快取裡就是全部歷史」；`app.js` 的月結算（`generateSettlement`/`exportSettlementExcel`）與週彙整 PDF（`updateWeeklySummaryPreview`/`generateWeeklySummaryPDF`）改用此方法，避免查詢較舊月份/週次時因訂閱視窗有界而漏算金額

### 新增（`firestore.indexes.json`，未部署）
- `pendingRequests`：`(status ASC, createdAt DESC)`、`(initiatedBy ASC, createdAt DESC)` 兩條複合索引，供 `subscribePendingRequests`/`listOpenPendingRequests`/`listPendingRequestsByInitiator` 使用；**這是本輪唯一需要複合索引的查詢**——`substituteRecords` 的所有查詢（含衝堂檢查新增的 `queryRecordsByExactDate`）與 `queryPendingRequestsByExactDate` 皆為 range/where/orderBy 同欄位或單一相等條件，屬自動單欄位索引，不需額外部署
- `docs/STAGE0-DEPLOY.md` 改寫「Stage 1 索引部署」附註為硬性順序（索引部署＋Console 確認已啟用 → 才能 push client），並補充實測發現的「缺索引=全站鎖死」根因、修復後的降級行為、與 GitHub Pages 部署模型放大風險的說明

### 已知取捨
- 教師管理頁與紀錄頁的教師下拉選單，選項現在只反映「目前已載入範圍」內出現過的姓名，可能比改造前少（不另外呼叫 `listTeachers()` 換取下拉選單完整度）
- 一般教師的紀錄頁預設視圖（無日期篩選時）仍是「全校最近 50 筆中與自己相關的部分」，不是「自己的完整歷史」——見輕 #9
- 訂閱首快照與 bootstrap 「首次塞 cache」的重複讀取（同一批資料被讀兩次）為 Stage 1 之前既有的架構模式，本輪僅將其縮小到有界範圍（50 筆），未消除重複本身，列為已知殘留
- `legacyMigrationService.js`（一次性遷移）與 `scripts/firestore-backup.js`（離線備份）等低頻管理操作維持整集合讀取，不受本輪影響（合理，非頁面載入路徑）

### 驗證
- 兩輪修復後重新實測：`npm run check` 29/29 通過、`npm test` 65/65 通過（18+12+11+24）
- `index.html`：`src/js/app.js?v=1.13.5→1.13.6`、`src/js/v2-app.js?v=0.1.5→0.1.6`

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 0：成員資格隔離規則（isMember）

依 `docs/RESEARCH-multitenancy-semester.md` §3.3/§3.4/§8 Stage 0（commit `2aa88a2`，補記 changelog）。動機：現行 `teachers`／課表／`substituteRecords`／`pendingRequests` 的讀取規則只驗 `isSignedIn()`，任何登入者知道別校 `schoolId` 即可直讀他校資料；開放註冊前必須先補上這個破口。

### 新增
- `firestore.rules`：R1–R7 讀取守門由裸 `isSignedIn()` 收緊為 `isMember(schoolId)`（`exists(userMappings/{uid})`）；新增 `emailIndex/{email}`（首登 email→teacherId 配對，只開放 `get` 自己一份，不開放 `list`）與 `joinAttempts/{uid}`（`login_denied` 改道，doc id 綁 uid 防灌爆）match block
- `authGuardV2.js`：首登流程改讀 `emailIndex` 配對（缺條目時以既有 `userMappings` 後備）
- `schoolDataService.js`：`teachers` 與 `emailIndex` 用 `writeBatch` 原子同步；新增 emailIndex／joinAttempts 的 CRUD
- 操作日誌頁新增「登入遭拒」區塊（僅 approver 可讀）
- `scripts/firestore-backfill-emailindex.js`（回填腳本）、`docs/STAGE0-DEPLOY.md`（部署 runbook：唯一可行順序「回填→部署規則→部署 client」、相容性矩陣、時間窗風險）

### 驗證
- 兩輪獨立驗收（含 17 項缺陷收斂）後定案；`--dry-run` 對正式庫唯讀實測（30 位教師、5 筆待建、0 衝突）
- 規則尚未部署，需依 `docs/STAGE0-DEPLOY.md` 順序執行（回填 → 部署 rules → 部署 client）

## [2026-07-30]（feature/permission-system）「清除所有資料」V2 重寫：根因修復＋兩輪驗收缺陷收斂

使用者回報「清除所有資料」清不乾淨。根因：舊版只清 2 個 localStorage key 就 reload，Firebase 登入 session 仍在，reload 後 `subscribeSchedule`／`subscribeSubstituteRecords`／`subscribePendingRequests` 等即時訂閱會立刻把全校 Firestore 資料整包灌回本機，等於沒清。本次改寫為 director 限定的全校雲端清除，並經兩輪獨立 agent 驗收，共修 10 項缺陷。獨立驗證、尚未 commit。

### 新增（改為全校雲端清除，`v2-app.js` `clearAllSchoolData()`／`patchClearLocalData()`）
- 課表 doc 歸零：`scheduleData`／`teachers`／`classes`／`subjectDomainMap` 清空，`schoolName` 沿用雲端現值（歸零不等於學校改名）
- 批次刪除 `substituteRecords`／`pendingRequests`（各自含 `private/detail` 子文件），改用 `schoolDataService.js` 新增的 `writeBatch` 分塊（≤400 筆/批）循序 `await`，取代原本無上限的 `Promise.all` 併發刪除
- 刪除自己（目前登入 uid）的 V1 個人雲端備份 `users/{uid}/data/substituteSystem`（`cloudSyncService.js` 新增 `deletePersonalCloudBackup()`）——這正是使用者原始抱怨「帳號內資料清不掉」的那份文件，V2 全校清除原本完全不觸碰它，換裝置/網址回舊版頁面會整包復活
- 刻意保留：`teachers/{id}` 帳號檔、`userMappings`、`config`、`operationLogs`（帳號與權限設定、稽核軌跡），成功後記一筆 `CLEAR_ALL_DATA` 稽核 log
- 僅 director 可執行（UI 隱藏 + 執行前重新檢查權限），兩層 `confirmDialog` 二次確認，文案註明「個人 V1 雲端備份也會一併刪除；其他使用者的個人備份不受影響」

### 修復（兩輪 opus 獨立驗收，共 10 項缺陷）
- **[高] 失敗後舊課表被靜默回灌雲端**：失敗路徑改為強制 `location.reload()`，讓本機透過即時訂閱與雲端當下實際狀態重新對齊，不再手動清 dataManager 欄位；原生 `alert()` 首版曾用於擋住畫面直到使用者看到錯誤內容，第二輪驗收指出全站已於 UI 重規劃 Stage 5 統一操作邏輯為 `confirmDialog`、不用原生對話框，已改回 `this.confirmDialog()`（`v2-app.js`）
- **[高] 稽核日誌寫入失敗誤報清除失敗**：`logger.log()` 移出 `try` 並加 `.catch(() => {})`，日誌失敗不影響清除結果判定
- **[中] `getSchedule()` 讀取失敗吞成 `null`，導致 `schoolName` 被空字串覆蓋**：改為讀取失敗直接中止（此時尚未寫入任何東西，安全）
- **[中] `orderBy('createdAt')` 排除缺該欄位的舊文件，清不乾淨**：`schoolDataService.js` 新增不帶 `orderBy` 的清除專用 `listAllSubstituteRecordsForClear()`／`listAllPendingRequestsForClear()`，既有列表函式不動
- **[中] V1 個人雲端備份未清**：見上方「新增」
- **[低] 「清除中」toast 疊在結果訊息上**：`app.js` `showToast()` 改為回傳 `dismiss` 函式，清除完成立即手動關閉；成功訊息延遲 800ms 才 `reload()`，讓使用者看得到
- **[低] 無重入保護／無批次上限**：新增模組級 `_v2ClearAllDataInFlight` 旗標；刪除改走 `writeBatch` 分塊（見上）。第二輪驗收另外指出成功路徑的 `finally` 會在 800ms 延遲 reload 前就解除旗標、留下可重入視窗，改為僅失敗路徑（`catch`）解除，成功路徑刻意不解除（反正即將整頁 reload，模組變數自然歸零）
- **[低] `schedule` doc 的 `meta` 形狀不一致**：`clearedBy*` vs `uploadedBy*` 互相覆寫，統一為 `{ lastAction: 'cleared'|'uploaded', byName, byTeacherId, at }`，`syncScheduleToV2()` 同步調整
- **[中] 快取版本號未 bump**：`index.html` `src/js/app.js?v=1.13.4→1.13.5`、`src/js/v2-app.js?v=0.1.4→0.1.5`（兩檔本次皆有改動，回訪使用者原本會載到舊 JS）

### 新增（`scripts/firestore-backup.js`）
- Firestore V2 完整備份／還原工具：`backup` 備份 `schools/{schoolId}` 底下課表、`substituteRecords`／`pendingRequests`（含 `private/detail`）與 `teachers`／`userMappings`／`config`／`operationLogs`；存 Firestore REST 的原始 `{name, fields, ...}` 格式（非 unwrap 後的人眼可讀格式），供 `restore` 原樣 `PATCH` 回去無損還原
- `restore` 預設只印還原計畫、不寫入，需帶 `--yes` 才真的執行；`--dry-run` 可強制只印計畫（測試用）

### 驗證
- `npm run check`（28/28）、`npm test`（65/65）全數通過
- 逐一核對「清除所有資料」所有 `return` 路徑的重入旗標狀態，確認未提前解除或漏解除（見上方低優先度缺陷說明）

### 已知取捨
- 驗證過程中執行 `test/v2-rules-matrix.mjs`（非 `npm test` 範圍）意外對正式 Firestore 寫入 16 筆 `zz_test_` 測試文件，詳見 `docs/ISSUES_LOG.md`
- 「無課表時不得新增教師」前置閘門已於 2026-07-30 以非破壞性方式實測通過；破壞性 E2E（實際清除全校資料）留待使用者親自執行

---

## [2026-07-30]（feature/permission-system）教師管理表合併、全欄位即時自動儲存與新增教師防重

教師管理頁原本並排兩張欄位重疊的表：V1 教師屬性表（姓名／領域／導師班級）與 V2 教師帳號管理表（姓名／Email／角色／領域），姓名與領域重複，且後者要按每列的「儲存」鈕才生效，兩張表的儲存語意不一致。本次併為單一表並統一為即時自動儲存。分兩個 commit：`d594973` 合併與即時儲存、`14108ad` 防重與刪除保護。

### 變更（合併與即時自動儲存，commit d594973）
- `index.html`：V1 教師屬性卡 `#teacher-editor-card` 加 `.v1-only`，V2 模式下隱藏（純 V1 單機模式行為不變）；V2 卡片權限由 `v2-director-only` 放寬為 `v2-approver-only`
- `base.css` + `v2-app.js injectV2Styles()`：新增 `body.v2-active .v1-only{display:none}`，比照 `.v2-only` 採「靜態 + 注入」雙份
- `v2-app.js renderTeachersAdminTab()` 改為 6 欄合併表：姓名／Email（登入帳號）／角色／任教領域／導師班級／操作，移除每列的「儲存」按鈕
- 新增 `bindAutoSaveField()`：change 即存，成功閃綠框 + ✓（1.4 秒後淡出）、失敗還原「上一次成功儲存的值」並提示。刻意不重繪整表——每格重繪會在連續編輯途中清掉焦點與捲動位置，改為局部更新角色標籤／待指派徽章／列醒目狀態
- 權限改為欄位級分層：領域／導師班級 approver 皆可編（`canEditSchedule`），Email／角色／新增／刪除／CSV 匯入限 director（`canManageRoster`）。組長看到的是 disabled 欄位且無操作欄
- 領域／導師班級的權威來源仍是 V1 dataManager（`recommendationEngine` 讀 `teacher.domains`／`teacher.homeroomClass` 做代課推薦），V2 集合同步寫一份副本；教師只在 V2 名單而未進課表時明確提示「設定要等課表匯入後才會套用到代課推薦」
- 姓名改為唯讀：V1 表原本可改名，但改名不會同步課表內的課程，會讓該教師的課全部變孤兒。更名請重新匯入課表（此為主動縮減的功能，已向使用者說明）
- 刪除改為完整刪除（帳號 + 教師屬性 + 其課表課程），修正 ISSUES_LOG 2026-07-29 記載的「兩個入口各刪一半、留下孤兒課程」功能退化
- 新增「只在課表中、尚未加入名單」的教師偵測提示，避免合併後靜默遺漏

### 修復（既有缺陷：教師屬性改動未回寫全校，commit d594973）
- `dataManager` 的 `updateTeacher`／`addTeacher`／`removeTeacher` 過去未被 `patchDataManager()` 包裝，approver 在教師屬性表改的領域只存在自己的 localStorage，全校教師拿到的 `teachers` 快照永遠是課表匯入當時的版本，代課推薦因此用錯領域。三者補上全校課表回寫，帶 `requireSchedule` 守門（避免空課表覆蓋全校）與新增的 `silent` 選項（逐格即時儲存不跳課表同步 toast，避免洗版）

### 修復（新增教師防重與同名帳號檔刪除保護，commit 14108ad）
- 根因：`authGuardV2.ensureDirectorTeacher()` 只依 email 查既有教師檔，而課表匯入產生的教師檔 email 是 `null`，初始主任首次登入時查不到自己那筆就另建一筆——這正對應 production「藍奕麟」兩筆的 `authProvider` 一為 `google.com`（登入時建）、一為空（課表匯入）。改用姓名補綁 email 會被 `firestore.rules` 的 `isInitialDirector` 分支擋下（該分支要求 `resource.data.email == userEmail()`，目標那筆是 null），修它需動 rules 並重新部署，未在本次處理
- `teacherAccountManager.createTeacher()` 補防重：建立前檢查姓名與 email 是否已被佔用，重複直接拋錯不建立（過去是裸建立，同名連按兩次就多一筆）；錯誤訊息指出佔用者姓名
- 合併表新增教師改為「兩邊都成功才算成功」：前置要求已有課表（課表是教師名單與代課推薦的資料來源，缺課表硬建帳號檔會留下對不起來的半套資料，而那正是重複建檔的溫床）；課表已有同名者導向「從課表匯入教師」；失敗時對稱回滾 V2 帳號檔與 V1 教師屬性
- 刪除加同名保護：V2 集合尚有其他同名帳號檔時只刪這一筆、不動 V1。V1 側以姓名為鍵、分不出是哪一筆帳號，此時清 V1 會把仍在使用中那筆的課表課程一起刪掉（前一 commit 引入的缺陷，發現於 production 實地檢視）
- 合併表新增同名重複警示，列出重複姓名並指引保留有登入紀錄的那筆

### 測試
- 新增 `test/test-teacher-dedup.mjs`（24 項）：以 `__testHooks` 記憶體替身涵蓋防重與回滾路徑，不碰 production Firestore；已接進 `npm test`。`createTeacher`／`deleteTeacher` 改走 `__testHooks` 以便測試
- 新增 `test/ui-teachers-merge-check.mjs`（10 項）：Playwright 走訪 V1／V2 兩模式，驗重複已消除（`.v1-only` 隱藏、可見教師表 ≤ 1）、V1 即時儲存無回歸、patch 未破壞 `addTeacher`／`updateTeacher`／`removeTeacher` 寫值、375 寬度無橫向溢出、無 console 錯誤
- 合計 216 項自動化檢查全綠

### production 實地驗收（2026-07-30，preview 站 v0.1.4）
- 合併表渲染確認：6 欄齊備、31 列、`.v2-save-teacher` 剩 0 個、V1 卡 `display:none`
- 清理「藍奕麟」重複帳號檔：刪除零引用孤兒 `tch_1780040513944_qf7vp5g`（`authProvider` 為空、從未被登入綁定），保留 `tch_1780040513944_kl4wgr9`（`authProvider=google.com`）。刪除後主任身份與該筆的領域資料完好，重複警示消失，完成 `V2_GO_LIVE.md` 上線前必做步驟 4
- 防重閘門實測：姓名已在課表 → 導向「從課表匯入教師」；V2 名單已有 → 「已存在於名單中」，兩者皆未新增任何列
- 即時儲存端到端持久化：改測試帳號領域欄 → 重新載入後值仍在（確認寫入 Firestore 而非 UI 假象）→ 已還原測試值

### 未處理（留待決策）
- `authGuardV2.ensureDirectorTeacher()` 的 bootstrap 重複建檔根因需改 `firestore.rules` 才能修，目前以 UI 警示讓重複無法被忽略
- 「無課表時不得新增教師」的前置閘門：2026-07-30 已以非破壞性方式實測通過（記憶體清空課表 → 點新增教師 → 閘門提示正確、未開啟新增流程），未觸發 `setScheduleData` 回寫全校課表 doc；破壞性 E2E（實際清除全校資料）由使用者親自執行

---

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
