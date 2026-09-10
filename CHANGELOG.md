# 版本紀錄 (Changelog)

## [2026-09-10] 正式站（master）取得登入穩定性兩項修復

`feature/permission-system` 整條合併進 `master`（merge commit `59647c7`），正式站 https://uplilt31311227.github.io/STsystem/ 因此取得兩項生產缺陷修復：

- **登入不再因 Firebase 尚未初始化完成而直接失敗**（`5dae6cf`）。Firebase SDK 是啟動時才從 CDN 動態 import，網路慢時使用者按下登入會拿到「請先完成 Firebase 設定」，而且該操作**根本不會送出任何請求**。六個對外操作改為先 `await ensureFirebaseReady()`。
- **`initAuthService()` 重複掛載監聽器**（`18121a6`）。app.js 與 v2-app.js 各呼叫一次，每次都再掛一個 `onAuthStateChanged`，導致 V2 bootstrap 跑兩次並互相干擾；同時補上 `initializeFirebase()` 的 in-flight promise 併發保護。

**為何整條合併而非只挑那兩個 commit**：實測 cherry-pick `18121a6` 會在 `firebaseConfig.js` 衝突（它依賴前兩個 emulator 相關 commit），且它同時改了 master 上不存在的 `test/emulator/emu-client.mjs`。硬挑要手工解衝突並產出 master 專屬變體，與支線永久分岔。整條合併也符合此專案既有慣例（master 上既有的 5 個 commit 全是 merge 此支線）。

**帶進 master 的其餘 12 個 commit 全在 `test/` 與 `docs/`**，不影響正式站行為。唯一動到正式站會載入的檔案是 `authService.js` 與 `firebaseConfig.js`；後者的 emulator 分支對正式站是 dead code（`shouldUseEmulator()` 要求 hostname 為 localhost 或 127.0.0.1 **且**帶 `emu=1`）。`index.html` 與 `firestore.rules` 未被動到，線上 ruleset 沿用 `08bbfa7d`，無 rules 部署動作。

**順帶修好 CI**（`464e69c`）：情境測試併入 `npm test` 鏈之後會 `import papaparse`，但 `.github/workflows/test.yml` 從未安裝依賴——本機因為有 `node_modules` 所以一直沒發現，推上去才在 CI 露餡（`ERR_MODULE_NOT_FOUND`）。`package-lock.json` 未進版控，故用 `npm install --no-audit --no-fund --ignore-scripts`（`--ignore-scripts` 避免 playwright 在 CI 下載瀏覽器，E2E 本來就不在此 workflow 跑）。修復後 `Test` 轉綠。

**驗證**：本機 `npm run check` 39/39、`npm test` 全鏈通過（情境 1 與 3 共 37/37）；CI `Test` success；Pages deploy job success；線上 `authService.js` 的 `ensureFirebaseReady` 出現次數與本機一致（7）；瀏覽器實開正式站，V1 畫面正常、`Firebase 初始化成功`、console 無錯誤、無 V2 遮罩。

**未做**：`npm run test:e2e` 未重跑（需 emulator + 本機 server + seed）。

---

## [2026-09-10] Preview（V2）站同步至最新支線

`STsystem-preview` 這個獨立 repo 與其 GitHub Pages 站（https://uplilt31311227.github.io/STsystem-preview/）**先前就已建立並啟用**，只是 `main` 停在 2026-07-30 的 `963eb69`，落後 `feature/permission-system` 30 個 commit。本次以 `git push preview feature/permission-system:main` 快進到 `52e004c`（無需 force，舊 main 是新支線的祖先）。

**推上去的內容**：Stage 0-5 多租戶與學期資料生命週期、登入初始化競態與 `initAuthService()` 重複掛監聽器兩項生產缺陷修復、Emulator 情境測試 90 案、瀏覽器 e2e 28 案、LICENSE 與範例課表。

**回朔點**：`963eb69`（分支 `backup-pre-preview-update-20260910`，已推至 preview remote）；一鍵回朔 `git push preview backup-pre-preview-update-20260910:main -f`。

**firestore.rules 未部署，也不需要**：本次 diff 相對 7/30 的 preview 快照確實有 +700/-60，但那些變更早在 2026-07-31 Stage 0-5 上線時就已發布到 Firebase。查證方式：`node scripts/firestore-deploy-rules.js --list` 顯示目前 release 指向 `08bbfa7d-ad35-4285-b82e-8acff8463449`（建立於 2026-07-31T14:19Z），而 `firestore.rules` 最後一次 commit 也在 2026-07-31。註：此為時間戳與 commit 日期吻合的推論，未取回線上 ruleset 內容做位元比對（部署腳本無此參數）。`docs/DEPLOYMENT.md` 原記載的「現行線上 release `618f5d1e`」已過期，一併更正。

**驗證**：Pages `builds/latest` 狀態 `built`、commit `52e004c`、無錯誤；curl 確認 `LICENSE`、`semesterUtils.js`、`schoolApplicationService.js` 三個新增檔皆回 200，`v2-app.js` 大小 291KB（新版）。靜態資源 `Cache-Control: max-age=600`，舊訪客最多 10 分鐘內仍可能吃到快取的舊 `v2-app.js`（其 `?v=0.1.11` cache-busting 參數未隨內容更動）。

**未做**：`master`（正式站）未動，兩項登入修復仍未上線正式站。

---

## [2026-08-12] 全流程操作測試補完：課表匯入、月結算、學期切換

新增 `test/e2e/e2e-03-admin-flows.mjs`（11 案，全數通過），補上先前缺的三塊操作情境：

- **月結算**：產生 115 學年度 9 月報表並確認列出教師與時數；暑假月份（8 月，上課週數 0）不會出現負數或 NaN；匯出 Excel 入口存在。
- **學期切換**：確認顯示目前作用中學期並帶出下一學期預設值；**目前學期仍有在途申請時按下「開新學期」會被擋下**，且擋下後 `config.currentSemester` 確實沒有被改動（直接讀 Firestore 驗證，不只看畫面提示）。
- **課表匯入**：缺少必要欄位的檔案被拒、只有標題列的空檔案被拒，兩者都確認**既有課表未被更動**；正常檔案匯入後班級數與節數正確更新，且新課表已同步到雲端（其他人也會看到）。
- **角色差異**：教學組長看不到「學期管理」與「清除所有資料」兩個主任專用區塊。

三組共用同一次主任登入（本機 emulator 的 bootstrap 要 8～75 秒，每案各登入一次不可行），順序刻意是「不改資料的先做」：月結算 → 學期切換（只驗證被擋，不真的切換）→ 課表匯入（會覆寫全校課表，放最後）；整組 runner 也把這個 suite 排在最後。

實作上兩個測試層的注意點：CSV 以 buffer 餵給 `<input type="file">`，不落地成實體檔案；驗證匯入結果改看 `dataManager` 的實際狀態而非畫面統計數字——上傳後畫面會切到匯入結果視圖，`#class-count` 那組元素會整個從 DOM 移除，讀畫面會得到假的失敗（畫面統計本身的正確性另有一案在初始狀態驗證）。

## [2026-08-11] 登入「卡住」的根因追查：兩個獨立問題，都已處理

先前 e2e 觀察到「登入成功率只有兩成、畫面卡在登入遮罩」，逐步追查後確認是**兩個互不相關的問題**，先前把它們混為一談才會得出「根因未定位」的結論。

**問題 1：Firebase 初始化競態（真實缺陷，已修）**。SDK 是啟動時才從 CDN 動態 import 的，初始化為非同步。`authService` 的六個對外操作（Google 登入／Email 登入／註冊／密碼重置／驗證信／建教師帳號）原本都是「沒初始化就丟 `請先完成 Firebase 設定`」——這是給開發者看的訊息，對使用者毫無意義（他們沒有任何「設定」可以完成），而且**該操作根本不會送出任何請求**（實測 Auth Emulator 完全沒收到登入請求），畫面只停在登入視窗。以瀏覽器在頁面載入後立刻登入，實測連續 6 次、6 次都是這個錯誤；網路慢時真實使用者同樣會踩到。修法：統一改為先 `await ensureFirebaseReady()`（`initializeFirebase()` 本身已有 in-flight promise 保護，重複呼叫共用同一次初始化），真的失敗才提示「系統尚未完成啟動，請稍候再試一次」。

**問題 2：本機 emulator 的 Firestore 查詢極慢（環境特性，非 app 缺陷）**。實測單一文件讀取只要 20～70ms，但集合查詢要數秒（實測 6.2s）；bootstrap 串行跑多個集合查詢，整段要 8～75 秒才完成，課表由即時訂閱送達要 41～61 秒。先前 e2e 只等 9～22 秒就判定「卡住」——**它不是卡死，只是還在跑**。把等待上限提高到 100 秒後，登入成功率由 2/6 變成 4/4（耗時 72s、7s、9s、36s），整組 e2e 12/12 通過。正式站連的是 Google 的 Firestore 而非本機 Java emulator，這裡的數字不構成正式環境的證據；也不宣稱正式環境一定沒有類似情形（不會拿正式站做這種驗證）。

追查過程中排除的方向：種子資料不完整、`projectId` 命名空間不符、`initAuthService()` 重複掛監聽器、`initializeFirebase()` 缺併發保護（前四項都是真的問題，已分別修正）、Firestore 改用 long-polling、重啟 emulator、每次全新瀏覽器、快取 Firebase SDK 避免重複下載（後四項試過，對症狀沒有影響）。

`test/e2e/README.md` 已改寫為完整的根因說明與實測數字；`docs/ISSUES_LOG.md` 原本「根因未定位」的條目已更正。

## [2026-08-11] 全流程操作測試（e2e）：真實瀏覽器操作，12 案通過

在 90 案的資料層／規則層測試之上，新增「真的開瀏覽器、真的點畫面」的操作測試。前端連本機 Emulator 靠網址參數 `?v2=1&emu=1`——`firebaseConfig.js` 的 `shouldUseEmulator()` 要求 hostname 是 localhost/127.0.0.1 **且**帶 `emu=1`，正式站無法命中，啟用時 console 印紅底警告並跳過 App Check 與離線持久化。

**涵蓋**：登入穩定度量測（刻意不重試）、三種角色的可見範圍、密碼錯誤、名冊外帳號被導向申請流程、跨校資料隔離、代課教師推薦的正確性（排除該時段有課者、標示同領域）、公假未填字號擋下送出、未選課程不可送出，以及**完整流程**：教師選課→選假別→挑代課教師→送出 → 組長在待辦看到 → 核准 → 進入調代課紀錄。12/12 通過。

**過程中修掉的生產缺陷**：(1) `initAuthService()` 被 app.js 與 v2-app.js 各呼叫一次，每次都再掛一個 Firebase `onAuthStateChanged`，而每個監聽器都會遍歷 `authStateCallbacks` 呼叫全部回呼——V2 的整段 bootstrap 因此跑兩次並互相干擾（實測每個步驟都印兩次），已加防重；(2) `initializeFirebase()` 缺併發保護，兩個呼叫端都在 `db` 賦值前通過「已初始化」檢查，整段初始化跑兩次，已改用 in-flight promise。兩者都與 emulator 無關，只是在本機的毫秒級回應下較容易顯現。

**測出的 UI 落差（非資料風險，規則層都有擋）**：一般教師的「原任課教師」下拉未鎖定為本人（可選全校 20 位）；「教師管理」頁籤對教學組長也可見。兩者的越權寫入都由 `firestore.rules` 擋下（情境 2/4 已驗證回 403），屬體驗問題。

**已知限制**：e2e 環境（headless Chromium ＋ 本機 Emulator）下登入成功率僅約兩到四成——Firebase 認證成功但 bootstrap 的某個 Firestore 一次性查詢永不回應，畫面停在登入遮罩。已排除種子資料、projectId 命名空間、上述兩個並發缺陷、long-polling、重啟 emulator、每次全新瀏覽器、快取 Firebase SDK 等原因，根因仍未定位；**無法判定正式環境是否受影響**，不會拿正式站驗證。操作測試以重試繞過，穩定度本身由 `e2e-00-login-stability` 專門量測並如實回報。詳見 `test/e2e/README.md`。

新增指令 `npm run test:e2e`（需先 `npm run emu`、`python start-server.py`、`npm run seed`）。

## [2026-08-11] 完整假資料情境測試（Firebase Emulator，90 案全通過）

建立一套在本機 Firebase Emulator 上跑的情境測試，用固定 seed 產生的完整假資料涵蓋四類情境，**全程不觸及正式 Firestore**。動機是這套系統上線後，課表解析、三種審核流程狀態機、月結算的假別扣減、多租戶隔離與學期唯讀鎖都只靠人工點擊驗證過，缺乏可重複執行的回歸網；而唯一既有的規則測試 `test/v2-rules-matrix.mjs` 是直接打正式庫的（2026-07-30 事故來源）。

**安全設計（針對 2026-07-30 事故的結構性對策）**：`test/emulator/emu-client.mjs` 的 host 寫死 `127.0.0.1`、專案寫死 `demo-stsystem`（`demo-` 前綴使 Firebase CLI 進入離線模式，不可能連上真實專案），每次連線前先探測對端確實是 Emulator，失敗即中止，不 fallback、不讀任何憑證檔——沒有任何程式路徑可以指向正式庫。

**假資料**（`test/fixtures/`，全部固定 seed、日期寫死，可重現）：兩所學校（`demo-alpha` 9 班／`demo-beta` 6 班），各 22 位教師（主任／教學組長／一般教師／3 位未綁定 email／2 位不任課行政）、兩個學期的完整課表（排課器採 most-constrained-first 貪婪，產出後實際驗證無教師衝堂、無班級重複排課）、22 筆已成立紀錄（8 種假別，中英文代碼混用＋一般調課／自行調課）、6 筆待審請求（代課單簽／調課雙簽待同意／待核准／多重調課部分同意／已駁回／alpha 期舊格式）、操作日誌（欄位形狀對齊規則白名單）。另建平台管理者與「不屬於任何學校」的外部帳號。

**四類情境共 90 案，全數通過**：情境 1 課表匯入與解析 18 案（15 種 CSV 變體打真實 `ScheduleParser`：欄位別名、值別名、BOM、CRLF、缺必要欄、缺值、只有標題列、未知週次、衝堂、同名教師、校訂課程名稱優先、排除領域、前後空白、班級數值排序）；情境 2 調課／代課全流程 28 案（打真實 `firestore.rules`：三種申請類型狀態機、同意與核准、私有明細 ACL、偽造已核准／冒名發起／自我同意／灌代課鐘點／假冒自我調課等越權嘗試、學期唯讀鎖、稽核軌跡不可竄改）；情境 3 月結算與調代課單 19 案（民國學年換算、寒暑假週數、16 種假別代碼逐一驗證扣減與否、完整課表的結算不變量、週次推算與版面組裝）；情境 4 多學期與多校隔離 25 案（跨校讀寫全面阻斷、email 索引與學校歸屬自我限定、歷史學期唯讀與刪除權、平台管理者與開校申請的權限邊界）。

**測試骨架**：`harness.mjs` 的 deny 斷言強制要求 HTTP 403——被 400/404 等其他原因擋下不算通過，避免「測試綠燈但擋住它的其實不是權限規則」這種假保證。

**開發過程中修正的兩個會讓結論失效的問題**：(1) Firestore Emulator 要繞過 Security Rules 必須明確帶 `Authorization: Bearer owner`，不帶 header 是被當成「未登入使用者」並套用規則——原本的種子寫入因此全被規則擋下，第一版測試等於在空資料庫上跑，卻有 17/28 顯示通過（deny 案例在空庫上自然成立）；(2) 種子改用 `mustSetDoc()`，任何寫入失敗立刻中止，不再靜默略過。另訂正 fixture 的 `operationLogs.actor` 欄位形狀以對齊規則白名單。

新增指令：`npm run emu`（啟動 emulator）、`npm run seed`（只種資料，供 Emulator UI 手動檢視）、`npm run test:scenarios`（跑全部情境）。`firebase-tools` 與 `papaparse` 加為 devDependency（原全域 firebase-tools 安裝已損壞）。使用說明見 `test/emulator/README.md`。測試過程確認的 5 項系統既有行為（非測試失敗）記於 `docs/ISSUES_LOG.md`。

## [2026-07-31] hotfix：v2- 頁籤點擊無反應（P1，上線後即時修復）

`app.js` 1.13.7→1.13.8、`v2-app.js` 0.1.10→0.1.11。正式站課表為空時，「待辦/調代課紀錄/操作日誌」等 `v2-` 開頭頁籤點擊完全無反應（靜默 no-op）。根因是 `v2-app.js` `bootstrap()` 前段對 `window.app.canSwitchToTab` 的 monkey-patch 執行時 `window.app` 尚未建立（於 `initAuthService()` 之後才由 `app.js` 的 `DOMContentLoaded` 建立），patch 從未生效——這是 Stage 3 opus 重驗時已發現、記錄於 `docs/ISSUES_LOG.md` 但刻意另案處理的既有問題，此次因實際影響上線使用而修復。根治方案消除時序依賴：`app.js` `canSwitchToTab()` 原生加入 `if (tabId.startsWith('v2-')) return true;`（V1 模式沒有 `v2-` 頁籤，此檢查無害），`v2-app.js` 內原本從未生效的 monkey-patch 區塊整段刪除，原地留註解指向 app.js 的原生支援。已走讀確認 V1 模式行為、月結算等既有鎖定行為皆不受影響。`docs/ISSUES_LOG.md` 對應條目已更新為已解決。

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 4：多租戶開通（未 commit）

依 `docs/RESEARCH-multitenancy-semester.md` §4／§8 Stage 4，與 `docs/RESEARCH-blaze-followup.md` 的查證結果（Blaze 無硬性支出上限、App Check 改選 classic reCAPTCHA v3、實際部署區域 asia-east1 單價低於原估）。動機：開放 20+ 校自助申請使用，採「自助申請 + 平台管理者輕量審核」（非全自助建校，因配額/帳單全專案共享需人工把關）。前端新增 `schoolApplicationService.js` 統一負責三個頂層集合的 CRUD：`schoolApplications/{uid}`（doc id 綁申請人 uid，一人一申請）、`platformAdmins/{uid}`（client 完全唯讀，只能由 `scripts/bootstrap-platform-admin.js` 離線寫入）、`schoolDirectory/{schoolId}`（公開學校名錄，申請頁查重用）。登入遮罩改造：`resolveIdentity()` 找不到教師配對時，`v2-app.js` 不再直接登出，改由 `enterApplyFlow()` 導向「申請開通新學校」流程（驗證 email → 送出申請 → 查看審核狀態 → 被駁回可重新申請），唯一真正登出的路徑是流程內的「登出，改用其他帳號」按鈕。設定頁新增「學校申請審核」卡片（平台管理者專用，非校內角色，守門邏輯獨立於 `roleService`）：列出待審申請、核准（`approveApplication()`，分兩個循序 `writeBatch` 建立新學校 config/名錄、再更新申請狀態與申請人 `userDirectory`）／駁回（沿用既有 `promptRejectReason()` textarea modal，未用 `window.prompt()`）。規則新增：`config/{docId}` 補一條 platformAdmin **create-only** 分支（新校尚無 director，只有此分支能完成首次建立；Firestore 的 create 語意本身即為 schoolId 衝突防線）；`userDirectory` 自寫分支新增 `isEmailVerified()`（相容性見下）＋新增 platformAdmin 代寫分支。`firebaseConfig.js` 新增 App Check（classic reCAPTCHA v3）載入/初始化，站台金鑰為空字串佔位常數，**未啟用**（enforcement 留給 Console 端手動開啟）；`authService.js` 新增 `sendVerificationEmail()`。相容性：現有 `inhu` 成員的 `userDirectory` 已由 Stage 3 回填腳本離線建立，不受 client 端新收緊的 `isEmailVerified()` 規則影響（`if (!userDirectoryExisted)` 守門一律跳過該分支）；即使未回填的邊界情況命中，`upsertUserDirectoryEntry()` 失敗也不阻擋登入（既有 try/catch 設計），四組合部署矩陣分析詳見 `docs/STAGE0-DEPLOY.md`「附註：Stage 4」。`test/v2-rules-matrix.mjs` 新增 X31-X39 九條攻擊案例（刻意不含正向案例，理由見該區塊註解：測試帳號 email_verified 狀態未知、皆非 platformAdmin）。緊急支出風控：新增 `scripts/emergency-brake.js`（`--brake --yes` 拉煞車 / `--restore --yes` 還原 / `--status` 查現況）；`scripts/bootstrap-platform-admin.js`（建立/移除/列出平台管理者，`--dry-run` 預設，`--remove` 內建最後一位管理者保護）。部署 SOP、App Check 啟用步驟、多門檻預算警報建議金額詳見新增的 `docs/STAGE4-DEPLOY.md`。**opus 驗收不通過（3 阻斷/3 高/5 中/6 輕），逐項修復**：**[阻斷 B1]** 原設計沒考慮到「新校第二位（含之後）教師從未登入過、無 `userDirectory` 條目」這一類使用者——`resolveSchoolIdForUid()` 查無條目原本無條件 fallback `inhu`，會讓這類教師永遠卡在查無教師配對；改為查無條目回傳 `null`（不再 fallback），登入遮罩新增「加入既有學校」（輸入代碼直接自寫 `userDirectory`）與既有「申請開通新學校」並列的雙選項畫面，`backfill-user-directory.js` 因此從建議提升為部署硬性前置條件（否則既有 `inhu` 成員會被誤判）。**[阻斷 B2]** email 驗證完成後補 `getIdToken(true)` 強制刷新 token（原本只 `reload()` 更新本機 user 物件，token 內的 claim 未更新，後續寫入仍會被拒）。**[阻斷 B3]** `joinAttempts` create 補 `isEmailVerified()`；查無所屬學校時不再寫入任何學校的 `joinAttempts`。**[高 H1]** `emergency-brake.js` 改為必須 `--brake --yes`／`--restore --yes` 才執行，裸執行只印用法。**[高 H2]** `approveApplication()` 同名衝突不再靜默跳過第一批，改丟 `SameNameConflictError` 要求 UI 二次確認；規則加 platformAdmin 的 approved→rejected 解套分支＋對應的 `revertApprovedApplication()`。**[高 H3]** `rejectApplication()` 簽章改吃完整 application 物件，駁回前檢查是否已對應真實建立的學校，是則阻擋並提示改用核准或人工清理。**[中 M1]** `schoolDirectory` 讀取拆 `get`/`list`（list 限 platformAdmin）。**[中 M2]** `--status` 改用 Rules API 實際取回 ruleset 內容比對是否為全 deny（訂正原本「API 不提供」的錯誤陳述）。**[中 M3/M4]** 平台管理者身份查詢改惰性（設定頁首次開啟才查、之後每次切到設定頁重繪，不再於 bootstrap 對每個使用者無條件查一次）。**[中 M5]** 規則測試矩陣補 3 案（自我核准 update DENY、schoolDirectory update/delete 恆 DENY），另有 1 項因缺 platformAdmin 測試帳號而如實記錄為已知覆蓋缺口。**[輕 L1-L6]** 測試檔版號訂正 v2.7；`initialAdminEmails` 收緊為 size==1 且逐項型別檢查；審核欄位補型別/長度驗證；重送鎖 `createdAt` 不可變；部署文件補硬重整提醒；`bootstrap-platform-admin.js` 補最後一位管理者保護。四份文件（`docs/STAGE4-DEPLOY.md`／`docs/STAGE0-DEPLOY.md`／`CHANGELOG.md`／`docs/CHANGELOG.md`）已同步補上「新學校成員」第三類族群的全鏈走讀與部署矩陣。**只寫程式碼，未寫 Firestore、未部署、未跑 `v2-rules-matrix.mjs`、未跑任何離線腳本、未 commit。**

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 3：SCHOOL_ID 動態化（未 commit）

依 `docs/RESEARCH-multitenancy-semester.md` §4（集合設計預告）／§8 Stage 3。動機：`SCHOOL_ID` 原本是 `schemaConstants.js` 的 import-time 常數，全 app 只能服務寫死的 `'inhu'`，要推廣多校必須改為「登入後由使用者身份動態解析」——本階段是 Stage 4（開放註冊）的前置鋪路，本身不改變任何現有使用者可觀察到的行為。新增頂層集合 `userDirectory/{uid}`（欄位 `schoolId`/`createdAt`），`authGuardV2.resolveIdentity()` 登入時先讀這份索引取得 schoolId、呼叫新的 `schemaConstants.setActiveSchoolId()`，才繼續走既有的 emailIndex/teachers/userMappings 配對流程；`SCHOOL_ID` 常數移除，`SCHEMA_PATHS` 全部改吃 `getActiveSchoolId()`（`schoolDataService.js` 本身零改動，因為它本來就只透過 `SCHEMA_PATHS.*()` 組路徑）；查無 `userDirectory` 條目時 fallback 到 `DEFAULT_SCHOOL_ID='inhu'`（相容期策略，留 TODO 待 Stage 4 改為導向申請/加入流程），登入成功後自動補寫一筆，不需要每個人都跑過回填腳本才能運作。localStorage `substituteSystemData` 改為 `substituteSystemData:{schoolId}`，一次性遷移只複製（不刪除）舊 key、僅對 `inhu` 進行，V1 模式（無 `?v2=1`）完全不受影響（`app.js` 新增 `getLocalStorageKey()` 方法作為擴充點）；`resetV2ViewState()`／登出鏈新增「school 切換」清快取維度，`semesterState` 併入清空範圍。規則新增頂層 `match /userDirectory/{uid}`：self read/write，`schoolId` 需 `configExists()` 存在驗證且不可含 `/`（防路徑插入），本階段未加 `email_verified` 收緊（留給 Stage 4）。新增回填腳本 `scripts/backfill-user-directory.js`（`--dry-run` 預設，**本次未執行**）。四組合部署矩陣分析顯示與 Stage 0/2 不同——兩個部署順序皆安全（所有跨越尚未部署一方的請求都設計成 fallback／靜默略過，不會中斷任何請求鏈），詳見 `docs/STAGE0-DEPLOY.md`「附註：Stage 3」。opus 驗收兩輪：第一輪不通過（4 中/6 輕），逐項修復：舊 localStorage key 補進「清除所有資料」範圍（避免已刪紀錄被誤判成 V1 舊資料而遷移復活）；`resolveSchoolIdForUid()` 區分「讀取失敗」與「查無條目」（前者中止登入並提示重試，不再一律 fallback）；新增查無教師配對時改用 `DEFAULT_SCHOOL_ID` 重試一次的自救機制；`resetV2ViewState()` 直接清空 `dataManager` 的課表相關欄位並新增 `_v2ScheduleReady` 旗標守門所有課表回寫，堵住 school 切換時 A 校課表被寫進 B 校的路徑；`userDirectory` 規則的 schoolId 驗證改正面白名單（訂正原負面檢查的 RE2 換行繞過漏洞）；登出補還原 `getLocalStorageKey` 覆寫；新增 `operationLogger.clearFailedLogs()`；部署矩陣的失敗請求次數估計由 2 次訂正為實測的 4 次；記錄 `userDirectory` 與報告 §4.2 `schoolOwners` 的收斂方向。第二輪重驗：10 項全數通過，追加 1 必修（`resetV2ViewState()` 清 dm 欄位打破了與 `_v2LastAppliedScheduleSig` 的一致性，同步歸零，否則同帳號重登會課表永久空白甚至以空快照覆寫雲端）＋4 小項（`loadSavedData()` 銜接本機鏡像回填、同 uid re-emit 補歸零 `_v2ScheduleReady`、遮罩帶出具體錯誤訊息、規則正則加錨點）＋1 筆另案記錄（`canSwitchToTab` patch 時機早於 `window.app` 建立、從未生效的既有問題，寫入 `docs/ISSUES_LOG.md`，不在本輪修）。完整清單見 `docs/CHANGELOG.md` 同日條目。**只寫程式碼，未寫 Firestore、未部署、未跑 `v2-rules-matrix.mjs`、未跑回填腳本、未 commit。**

## [2026-07-31]（feature/permission-system）多租戶研究 Stage 5：封存與生命週期工具（未 commit）

依 `docs/RESEARCH-multitenancy-semester.md` §6.2（封存流程＋三個陷阱）／§6.5（operationLogs 衝突解法 b）／§8 Stage 5。動機：完成「保留 3 年 → 期滿匯出封存 → 從雲端刪除」的生命週期閉環。設定頁新增「資料封存」卡片（director 專用，緊鄰「學期管理」）：選學期 → 匯出該學期完整資料（課表、`substituteRecords`/`pendingRequests` 含 private/detail、`operationLogs`）為單一 JSON → 選擇剛下載的檔案做 SHA-256 雜湊 + 雲端當下筆數雙重驗證 → 輸入學期代碼二次確認 → 執行刪除（僅限非目前學期；private/detail 先刪、父文件後刪，沿用既有 `deleteSubstituteRecordsBatch`/`deletePendingRequestsBatch`；課表 doc 一併刪除）→ 寫入不可改/刪的 `archives/{semesterId}` 封存紀錄與操作日誌。全流程每一步失敗或資料在期間漂移都 fail-closed 中止、不推進到可刪除狀態。`operationLogs` 不在 UI 刪除範圍內，改由新增的離線腳本 `scripts/cleanup-operation-logs.js`（`--before=<日期>`，預設 dry-run、需 `--yes` 才實際刪除，永遠先匯出備份）以 gcloud REST 憑證清理。規則新增：`schedules/{semesterId}` 的 `write` 拆成 `create/update` + `delete`（director 專用、僅能刪非目前學期）；新增 `archives/{semesterId}`（create-only、不可改/刪）。詳見 `docs/STAGE5-ARCHIVE.md`（部署順序、封存 SOP、驗證清單、已知限制）。opus 驗收第一輪不通過（2 阻斷/4 中/7 輕）：阻斷1 修復匯出鏈的 fail-open（讀取錯誤原本被靜默吞成「沒有資料」，改為零容忍版本 `getRecordDetailsBulkStrict`/`getRequestDetailsBulkStrict`/`getScheduleForSemesterStrict`）；阻斷2 修復「recount 之後又另外查一次刪除清單」的競態窗口（改用 `fetchSemesterArchiveSnapshot()` 一次查回、直接重用去刪除，並比對 ID 集合而非只比對筆數）；中3 移除 operationLogs 的重複核對，讀取量從約 46,503 降到約 24,603；中4-6、輕7-13 涵蓋 `pendingRequests` 私有明細補學期鎖、已封存學期停用匯出/刪除鈕、分塊方式改依筆分塊、`getConfigFromServer` 直讀伺服器、`switchToNewSemester` 寫入順序訂正等。第二輪重驗定案通過，追加 6 項非阻斷收尾：訂正「規則未部署時匯出仍正常」的錯誤描述（實為匯出也會被擋）、刪除一段描述不存在機制的錯誤註解、`Promise.allSettled` 避免 unhandled rejection 噪音、批次刪除改依累計操作數（非固定筆數）分塊、刪除後寫封存紀錄前補一次「應為 0 筆」複查、學期切換部分失敗時強制提示重新整理。完整清單見 `docs/CHANGELOG.md` 同日條目。**只寫程式碼，未寫 Firestore、未部署、未跑 `cleanup-operation-logs.js`、未 commit。**

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
