# 全流程操作測試（e2e）

真的開瀏覽器、真的點畫面、真的送出表單，資料寫進本機 Emulator。
前端連 emulator 靠網址參數 `?v2=1&emu=1`（見 `src/js/modules/firebaseConfig.js` 的
`shouldUseEmulator()`：**必須** hostname 是 localhost/127.0.0.1 **且**帶 `emu=1`，
正式站無法命中）。

## 執行

```bash
# 三個都要開著
npm run emu                       # 終端機 A：Firebase Emulator
python start-server.py            # 終端機 B：本機網頁伺服器（port 8000）
npm run seed && npm run test:e2e  # 終端機 C：種資料後跑操作測試
```

## 網路防線：e2e 不得碰正式環境

防線有兩層（所有 e2e 都經過 `newPage()`）：
1. **阻擋**：一條窄範圍的 `page.route`（正規表示式，只比對 `googleapis.com`、`google.com`、`gstatic.com`、`firebaseapp.com`、`firebaseio.com`、`web.app`、`recaptcha.net` 及其子網域），命中就 abort 並記為違規；本機請求完全不經過它。
   SDK 快取的 route（`www.gstatic.com/firebasejs/**`）與各測試自己的 mock route（例如 e2e-07 的日曆 API）都是後註冊，優先於這條，所以 firebasejs 與被 mock 的請求不會被當成違規。
2. **偵測**：`page.on('request')`（只觀察）記錄「放行的外部主機」（cdnjs、cdn.sheetjs、www.gstatic.com firebasejs）。

不使用全域 catch-all route 或 Chromium DNS 規則（`--host-resolver-rules`）：實測沒有它們的好處（本機 emulator 的延遲與防線無關，見下一節），
全域攔截卻會讓每個本機請求都經過處理常式。

本機 emulator 偶發的 30～60 秒延遲：在「完全不裝防線」、甚至還原成 HEAD 的 `firestore.rules` 的對照下，瀏覽器內第一次 `getDocs(schedules)`
仍可能卡 30～60 秒（同一個 REST 讀取只要約 12 ms）。這是 emulator 環境問題（見下節 README 原有說明），不是 app 或防線的缺陷；
受影響的 e2e 因此把備份／還原的等待上限放寬（e2e-04 與 e2e-09 為 7 分鐘）。

分類如下：

| 請求目標 | 處理 |
|---|---|
| `localhost`／`127.0.0.1`（網頁伺服器、emulator）、`data:`／`blob:` | 放行 |
| `cdnjs.cloudflare.com`、`cdn.sheetjs.com`、`www.gstatic.com/firebasejs/`（SDK 本體，另有本機快取） | 放行 |
| `*.googleapis.com`、`*.firebaseapp.com`、`*.firebaseio.com`、`www.google.com/recaptcha`、`recaptcha.net`、`www.gstatic.com/recaptcha`、其他 `*.google.com` | **記為違規**（請求同時被第 1 層的 `page.route` abort 擋下）：`Suite.case` 偵測到案例期間有違規請求就把該案例判為失敗 |
| 其餘任何外部主機 | 只記錄（不判失敗）；命中封鎖清單網域者同樣被 abort |

緣由：`e2e-08` 曾前往不帶 `emu=1` 的網址，`v2-redirect.js` 轉址後（保留查詢參數，但本來就沒有 `emu=1`）app 以正式設定初始化，
向正式專案載入 reCAPTCHA、交換 App Check token。現在 e2e-08 所有案例的起始網址都帶 `emu=1`（轉址會保留它），
且最後一案會印出「違規請求」「被攔截的其他外部請求」「放行的外部主機」三份清單並斷言違規為空。
分類規則是純函式，`node test/test-e2e-netguard.mjs`（已掛進 `npm test`）離線驗證，
含 `v2-redirect.js` 保留 `emu=1` 的單元測試。新增 e2e 時：一律用 `newPage()`／`loginStable()` 建分頁，
網址一律帶 `?v2=1&emu=1`；不要自己 `browser.newPage()`，否則會繞過防線。

## 登入為什麼慢（根因已查明）

一度以為「登入卡住、成功率只有兩成」，實際追查後是**兩個獨立問題**，都已處理：

### 1. Firebase 初始化競態（真實缺陷，已修）

SDK 是啟動時才從 CDN 動態 import 的，初始化為非同步。使用者在完成前送出登入是
完全正常的操作，但 `authService` 的六個對外操作原本都是「沒初始化就丟
`請先完成 Firebase 設定`」——對使用者毫無意義的訊息，而且**登入請求根本不會送出**
（實測 Auth Emulator 完全沒收到請求），畫面只停在登入視窗。

實測連續登入 6 次、6 次都是這個錯誤。已改為先 `await ensureFirebaseReady()`。

### 2. 本機 emulator 的 Firestore 查詢極慢（環境特性，非 app 缺陷）

實測數字：

| 項目 | 耗時 |
|---|---|
| 單一文件讀取 `getDoc` | 20～70ms |
| 集合查詢 `getDocs` | **數秒**（實測 6.2s） |
| 整段 bootstrap（遮罩解除） | **8～75 秒** |
| 課表由即時訂閱送達 | **41～61 秒** |

bootstrap 會串行跑多個集合查詢，累積起來就是數十秒。先前 e2e 只等 9～22 秒就
判定「卡住」，才會得出「成功率兩成」的錯誤結論——**它不是卡死，只是還在跑**。

把等待上限提高到 100 秒後，登入成功率由 2/6 變成 **4/4**（耗時 72s、7s、9s、36s）。

**這是本機 emulator 的效能特性，不應套用到正式環境**——正式站連的是 Google 的
Firestore，不是跑在本機的 Java emulator。不會拿正式站做這種驗證，所以也不宣稱
正式環境一定沒有類似的慢；只是這裡量到的數字不構成任何正式環境的證據。

### 追查過程中排除的方向

種子資料不完整、`projectId` 命名空間不符（這兩項是真的問題，已修）、
`initAuthService()` 重複掛監聽器（真的問題，已修）、`initializeFirebase()` 缺併發保護
（真的問題，已修）、Firestore 改用 long-polling、重啟 emulator、每次全新瀏覽器、
快取 Firebase SDK 避免重複下載（後四項都試過，沒有影響）。

### 代價

整組 e2e 會跑很久（每次登入最久 100 秒）。這是為了得到可信結論所付的成本。


## 目前的內容

| 檔案 | 內容 | 狀態 |
|---|---|---|
| `e2e-00-login-stability.mjs` | 連續 4 次登入的耗時與成功率，**刻意不重試** | 可跑，如實回報數字 |
| `e2e-01-auth.mjs` | 三種角色可見範圍、密碼錯誤、名冊外帳號、跨校資料隔離 | 可跑 |
| `e2e-02-substitute-flow.mjs` | 代課推薦正確性、公假必填字號、未選課不可送出、教師的原任課教師欄位未鎖定、申請→待辦→核准 | 可跑 |
| `e2e-03-admin-flows.mjs` | 月結算（含暑假 0 週邊界）、學期切換（在途申請擋下）、課表匯入（缺欄位／空檔被拒且不影響既有課表、正常檔匯入並同步雲端）、組長看不到主任專用區塊 | 可跑 |
| `e2e-04-pdf-and-clear.mjs` | 調代課單 PDF 實際下載並驗證檔頭與大小、週彙整入口、**清除所有資料的兩道確認閘門**（各自取消都不動資料；兩道都確認才真的清空） | 可跑（**破壞性**） |
| `e2e-08-v1-no-weeks.mjs` | V1 網址轉址到 V2（保留 `emu=1`、其他參數與 hash，無轉址迴圈）；最後一案斷言整支期間沒有任何請求連到正式環境 | 可跑 |
| `e2e-09-backup-restore.mjs` | 雲端完整備份與還原：角色可見性、匯出內容與筆數、V1 舊格式與別校備份被拒、刪紀錄後以備份還原（預覽→確認字樣→還原前自動備份） | 可跑（破壞性，排在最後） |

`e2e-03` 的三組共用同一次主任登入（bootstrap 太慢，每案各登入一次不可行），
順序刻意是「不改資料的先做」：月結算 → 學期切換（只驗證被擋，不真的切換）→
課表匯入（會覆寫全校課表，放最後）。整組 runner 也把它排在最後。

⚠ `e2e-04` 的最後一案是**破壞性**的：兩道確認都通過後會真的清空全校紀錄與待審請求。
跑完之後資料庫已不是種子的原樣，要再跑其他情境必須先 `npm run seed`。
runner 已把它排在最後，順序不可調換（`e2e-03` 會覆寫課表、`e2e-04` 會清空資料）。

PDF 的驗證方式：實際攔截瀏覽器下載，檢查檔名、`%PDF` 檔頭與檔案大小
（實測產出 `調代課通知_20260921_厲阿福.pdf`，630 KB）。**內容文字無法驗證**——
本專案的 PDF 是 html2canvas 先轉成圖片再放進 jsPDF，PDF 裡沒有可擷取的文字層，
所以只能確認「有產出、格式正確、不是空白頁」，版面內容的正確性由
`scenario-03` 對 `createSheetHTML` 等版面函式的斷言涵蓋。

## 這組測試已經測出來的東西

即使沒跑完，過程中確實發現並修掉了三個真實問題（見 CHANGELOG 2026-08-11 條目），
其中兩個是與 emulator 無關的生產程式碼缺陷。另記錄一項 UI 落差：
「教師管理」頁籤對教學組長也可見（實際增刪改由規則擋下，規則層已由情境 2 驗證）。
