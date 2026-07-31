---
created: 2026-07-31
updated: 2026-07-31
tags:
  - deployment
  - security
---

# Stage 0 部署 Runbook：成員資格隔離規則

> 對應設計：[`RESEARCH-multitenancy-semester.md`](./RESEARCH-multitenancy-semester.md) §3.3（逐條規則修改）、§3.4（首登配套）、§8 路線圖 Stage 0。
> 目的：把 `teachers` / `data`（課表）/ `substituteRecords` / `pendingRequests` / `operationLogs` 等讀取規則從「任何登入者」收緊為「該校成員（`isMember(schoolId)`）」，堵住「登入者組別校路徑直讀他校資料」的破口。
> 風險等級：**中高**。三個部署對象（回填資料、`firestore.rules`、前端 client）**必須依本文件指定的順序個別部署，不可合併成一次動作，也不可調換順序**——原因見下方「相容性矩陣」，這不是保守慣例，是實測推演出的唯一可行順序。

## 部署對象與為什麼要分三步

Stage 0 一次改動了三個各自獨立部署、但彼此耦合的東西：

1. **資料**：`emailIndex` 回填（`scripts/firestore-backfill-emailindex.js`）——寫入 Firestore 資料，不影響任何規則或程式碼行為，可獨立於另外兩者之外隨時執行、隨時重跑。
2. **`firestore.rules`**：透過 `scripts/firestore-deploy-rules.js` 部署到 Firestore 規則引擎，**立即全域生效**（沒有灰度、沒有版本並存）。
3. **前端 client**（`src/js/modules/v2/authGuardV2.js` 等）：透過 `git push preview feature/permission-system:main` 部署到 V2 Preview 站（`https://uplilt31311227.github.io/STsystem-preview/`），GitHub Pages 建置通常需 1-3 分鐘生效。**Stage 0 的程式碼變動只影響 V2（`schools/{id}/...`），與 master 上的穩定版 V1（`users/{uid}/...`）完全隔離，不需要、也不應該推 master。**

因為 (2) 是「立即全域生效」而 (3) 是「有建置延遲的漸進生效」，兩者之間必然存在一段「規則已是新版、client 還是舊版（或反過來）」的時間窗。下面矩陣列出四種組合 × 三種使用者情境的實際行為，用來證明「回填 → 部署 rules → 部署 client」是唯一不會讓既有成員斷線的順序。

## 相容性矩陣：四組合 × 三種使用者

三種使用者情境：
- **(i) 既有成員**：`schools/inhu/userMappings/{uid}` 已存在（正常日常登入）。
- **(ii) 已建檔未首登教師**：`teachers` 集合有對應 email 的教師檔，但這個 Google 帳號從未登入過、尚無 `userMappings`。
- **(iii) 完全陌生使用者**：不在 `teachers`、也不在 `initialAdminEmails` 白名單。

四種 client × rules 組合：

| 組合 | (i) 既有成員 | (ii) 已建檔未首登教師 | (iii) 完全陌生使用者 |
|---|---|---|---|
| ① 舊 client × 舊 rules（**現況**） | 正常 | 正常（`findTeacherByEmail` 掃 `teachers`，舊規則 `isSignedIn()` 開放讀取） | 正常拒絕，`login_denied` 寫入 `operationLogs`（舊規則對 create 也只驗 `isSignedIn()`） |
| ② 新 client × 舊 rules（**跳過先部署 rules、直接推 client 會落入此格**） | **正常**（驗收修復 S6 後備：直接讀自己的 `userMappings/{uid}`，這條 read 規則 Stage 0 未改動，舊規則本來就允許自己讀自己） | **失敗**：`emailIndex` 在舊規則裡沒有對應的 `match` 區塊，Firestore 對未匹配路徑預設 `DENY`，`getEmailIndexEntry` 讀不到（S5 的 try/catch 會把這個攔下來，視同查無配對，不會白屏當機，但**教師本人還是登入不了**）；新教師唯一的配對路徑（emailIndex）失效，S6 的 `userMappings` 後備對「從未登入過」的人不存在，兩條路都走不通 | 拒絕（結果正確：找不到 teacherId 就是拒絕），但 `joinAttempts` 寫入同樣落在未匹配路徑上被 `DENY`，`logJoinAttempt` 靜默吞掉錯誤——**拒絕本身正常，但這筆嘗試不會留下任何稽核紀錄** |
| ③ 舊 client × 新 rules（**先部署 rules、還沒推 client 的正常時間窗，落在此格**） | 正常（`isMember` 對既有成員恆為 true，舊 client 沿用的 `findTeacherByEmail`/`listTeachers` 等呼叫在 `isMember` 下一樣通過） | **顯示系統錯誤**（見下方 S2 一節：舊碼 `getInitialDirectorEmails()` 呼叫 `getConfig()` 沒有 try/catch；新規則下非成員讀 `config` 被 `isMemberOrBootstrapDirector` 拒絕，例外未被攔截，直接以未捕捉例外的形式炸給使用者，UI 上多半顯示「系統錯誤」而非清楚的「登入被拒」） | **同上，顯示系統錯誤**，且因為連 `getConfig()` 都過不去，根本走不到「查無教師」那一步，`operationLogs`（已改 `isMember` 守門，非成員也寫不進去）與 `joinAttempts`（舊 client 不知道這個集合存在）兩邊都不會留下紀錄 |
| ④ 新 client × 新 rules（**目標穩定態**） | 正常 | 正常（`emailIndex` 已回填且規則已開放 `get` 自己那份，`resolveIdentity` 走完整流程建立 `userMappings`） | 正常拒絕，`joinAttempts` 正確寫入一筆（`email`/`attemptedAt`/`reason`） |

### 從矩陣讀出的結論

1. **不可先部署 client 再部署 rules（① → ② → ④）**：組合②會讓「已建檔未首登教師」完全無法登入（不是系統錯誤，是靜默地卡住——沒有任何錯誤訊息可以讓使用者或管理者意識到問題所在，比③的「顯示系統錯誤」更難排查），且這段期間內任何拒絕嘗試都不會留下 `joinAttempts` 紀錄。**這是最差的順序，不可採用。**
2. **正確順序是 ① → ③ → ④，即「先部署 rules、再部署 client」**：組合③雖然會讓「已建檔未首登教師」與「陌生使用者」在時間窗內看到系統錯誤，但（a）既有成員完全不受影響——這是本次驗收修復 S6 帶來的直接效益，(b) 錯誤是**顯性**的（使用者知道登入失敗了，只是訊息不夠友善），不是靜默卡住，(c) 一旦 client 部署完成（通常 1-3 分鐘），問題自動消失，不需要額外動作。
3. **回填必須在 rules 部署之前完成**：回填本身（資料寫入）不影響組合①②③的任何行為（舊規則不讀 `emailIndex`，舊 client 不查 `emailIndex`），純粹是為了讓組合④生效時 `emailIndex` 已經就緒，所以「先回填」永遠是安全的第一步，沒有提前執行的副作用。

### 時間窗風險與壓縮方式（驗收修復 S2）

組合③（rules 已新、client 仍舊）的時間窗**只影響「已建檔未首登教師」與「陌生使用者」這兩種情境**，不影響任何既有成員的日常使用。影響本身是「登入失敗且看到不夠友善的錯誤訊息」，不是資料外洩或資料損毀，且使用者可以直接重試（一旦 client 部署完成即恢復正常）。

壓低時間窗的做法：

- rules 部署（步驟 2）與 client 部署（步驟 3）**排在同一次維運操作內連續執行**，中間不要插入其他任務或等待審核。
- rules 部署完成後**立刻**（`node scripts/firestore-deploy-rules.js --list` 確認 release 已指向新 ruleset 的當下）就推 client：`git push preview feature/permission-system:main`。
- 部署時段選在教師登入量低的時段（例如上課中、非上下班尖峰），降低「剛好在時間窗內嘗試首登」的機率。
- 若 Stage 0 上線當天有已知的「即將首登」教師（例如剛完成 CSV 匯入、要立刻上手的新進教師），**避開該時段**，或提前告知對方「若登入顯示錯誤，等 5 分鐘後重試」。

## 前置確認

- [ ] `npm run check` 全過（`node scripts/check-syntax.js`）
- [ ] `npm test` 全過（純本地測試，不碰正式 Firestore）
- [ ] `git status` 乾淨，本次 Stage 0 改動已 commit
- [ ] 現行線上 ruleset release 名稱已記錄（見下方「回退」一節，部署新規則前先跑一次 `--list` 記一次）
- [ ] 確認 §「驗證用測試對象」一節：目前正式庫（`schools/inhu`）**沒有可用的「已建檔未首登」測試對象**（見下一節說明），驗證步驟 4b 需先建立一個
- [ ] **`initialAdminEmails` 必須全小寫**（驗收修復 S5-R）：`firestore.rules` 的 `isInitialDirector()` 用 `userEmail().lower()` 比對白名單，但 Firestore 規則語言無法對陣列逐項轉小寫再比對，所以 `config/main.initialAdminEmails` 陣列本身的每個字串都必須已經是小寫，否則該筆白名單永遠比對不到、白名單主任會被擋在首登門外。部署前跑一次 `node scripts/firestore-bootstrap-inhu.js`（無 `--add-teacher` 旗標即可，該指令現在會自動偵測並修正大寫/重複值，見 `ensureConfig()`），確認輸出顯示「已存在且主任白名單就緒（已全小寫）」或「已正規化為全小寫」；若之後有人手動在 Firebase Console 編輯 `initialAdminEmails`，必須確保輸入全小寫

## 驗證用測試對象：目前正式庫的實際狀況（撰寫本文件時查證）

正式庫 `schools/inhu` 目前 30 位教師檔中，只有 5 位填有 email（其餘 25 位本來就沒有 email，**這是既有狀況、不是 Stage 0 造成的**，不影響這 25 位教師的既有功能——他們原本就不能用 Google 帳號登入，只能由 director/section_chief 代為操作）。查證這 5 位的 `userMappings` 後發現：

| Email | 教師 | 是否已有 userMappings（已登入過） |
|---|---|---|
| uplilt31311227@gmail.com | 藍奕麟（director） | 是 |
| uplilt313@gmail.com | 組長（uplilt313） | 是 |
| uplilt31311227+v2t1@gmail.com | [測試]教師甲 | 是 |
| uplilt31311227+v2t2@gmail.com | [測試]教師乙 | 是 |
| uplilt31311227+v2t3@gmail.com | [測試]組長丙 | 是 |

**結論：這 5 位全部已經登入過，正式庫目前沒有天然可用的「已建檔但從未首登」測試對象**，驗證步驟 4b（新教師首登）無法直接用現成帳號測試。

**改用測試 email 教師檔的做法**：驗證前，用 `scripts/firestore-bootstrap-inhu.js --add-teacher` 建立一個尚未使用過的測試 email（例如 `uplilt31311227+v2t4@gmail.com`，Gmail 的 `+` 別名寫入同一信箱、可實際收信登入），角色設 `teacher`：

```bash
node scripts/firestore-bootstrap-inhu.js --add-teacher --name "[測試]首登驗證" --email uplilt31311227+v2t4@gmail.com --role teacher
```

`firestore-bootstrap-inhu.js` 是直接呼叫 REST API 寫入 `teachers` 集合，**不會**同步寫入 `emailIndex`（那是 `schoolDataService.createTeacher` 這條 client 端路徑的行為，`bootstrap-inhu.js` 是獨立的 REST 腳本）。所以用這個指令建好測試教師檔後，**必須再跑一次回填腳本**（`node scripts/firestore-backfill-emailindex.js`）才能讓這位測試教師的 email 出現在 `emailIndex`，否則 4b 驗證仍然會失敗（且失敗原因是「忘記回填」而非規則有破口，排查時請先確認這一步）。

驗證完成後，若不需保留，由 director 帳號在教師管理頁刪除該筆測試教師檔（`deleteTeacher` 會自動清掉對應的 `emailIndex` 條目，見 S7 修復）。

## 上線順序（不可顛倒）

### 1. 跑 emailIndex 回填腳本

```bash
# 1a. 先跑 dry-run，核對將建立的條目數與是否有 email 衝突
node scripts/firestore-backfill-emailindex.js --dry-run

# 1b. 確認無誤（尤其「Email 衝突」欄必須是 0，否則先處理孤兒教師檔再重跑 dry-run）後，正式回填
node scripts/firestore-backfill-emailindex.js
```

**驗證**：

```bash
# 回填後重跑一次 dry-run，「待建立」「待更新」都應為 0，「已同步」筆數應等於教師總數扣未填 email 者
node scripts/firestore-backfill-emailindex.js --dry-run
```

若「Email 衝突」欄非 0：代表有多筆教師檔共用同一個 email（理應被 `teacherAccountManager` 的防重擋下，正常情況不應出現；若出現多半是遷移期遺留的孤兒檔，見 `docs/ISSUES_LOG.md` 教師防重修復紀錄）。**先手動刪除孤兒檔或改掉衝突 email，再重跑 dry-run 確認衝突清空，才能進下一步。**

**文件 ID 一致性核對（驗收修復 S4）**：回填完成後，到 Firebase Console → Firestore Database → `schools/inhu/emailIndex` 目視確認每筆文件的 ID 顯示為 `xxx@yyy.com` 這種原文格式，**不是** `xxx%40yyy.com`（腳本內部用 `encodeURIComponent` 組 REST 請求 URL，這是 HTTP 傳輸層編碼，Firestore 伺服器端會還原成原文字串才建立文件，與 client SDK 直接用原文字串定址寫入的是同一個文件 ID——但這個結論是依 HTTP/REST 標準路徑解碼行為推導，未能在正式庫實機驗證雙寫一致，所以這一步目視核對是必要的驗收關卡，不是可省略的形式動作）。若看到 `%40`，代表結論有誤，需暫停部署並重新檢視腳本的 URL 組法。

### 2. 部署 `firestore.rules`

回填確認無誤（dry-run 顯示 0 待建立、0 待更新、0 衝突）後才執行：

```bash
# 2a. 先只建立 ruleset 不發布，確認語法通過
node scripts/firestore-deploy-rules.js --dry

# 2b. 確認無誤後正式發布
node scripts/firestore-deploy-rules.js
```

**驗證**：

```bash
node scripts/firestore-deploy-rules.js --list
# 確認「目前 release」已指向剛建立的新 ruleset（★ 標記那一列）
```

**部署完成的這一刻起，進入「相容性矩陣」的組合③（舊 client × 新 rules）**。立刻進行步驟 3，把時間窗壓到最短（見上方「時間窗風險與壓縮方式」）。

### 3. 部署前端 client

```bash
git push preview feature/permission-system:main
```

等待 GitHub Pages 建置完成（通常 1-3 分鐘；可到 repo 的 Actions 頁籤或直接重新整理 Preview 站確認新版程式碼已生效，例如檢查瀏覽器 Network 面板載入的 `authGuardV2.js` 檔案內容含有 `emailIndex` 字樣）。

**部署完成後，進入相容性矩陣的組合④（目標穩定態），時間窗結束。**

**部署 client 後，公告使用者做一次硬重新整理（Ctrl+Shift+R）**：GitHub Pages 靜態資源快取 `max-age=600`，push 後約 10 分鐘內的回訪可能拿到新版 `v2-app.js`＋瀏覽器快取住的舊版子模組（例如本輪 `uiFeedback.js` 新增了具名匯出 `resetSyncStatus`，若回訪使用者的瀏覽器快取還是舊版 `uiFeedback.js`，新版 `v2-app.js` 的 `import { ..., resetSyncStatus } from './modules/v2/uiFeedback.js'` 會找不到這個具名匯出而整個模組載入失敗）。後果是 V2 權限系統靜默不啟動、頁面退回 V1 介面——**不是資安問題**（Firestore rules 仍在伺服器端把關，退回 V1 介面不會讓人讀到不該讀的資料），純粹是功能不可用，使用者體感是「怎麼跟公告的不一樣」。硬重新整理會強制略過瀏覽器快取、拿到成套的新版模組，立即恢復；就算沒公告，10 分鐘快取窗過後所有人自然也會自癒。

**取捨與治本方向**：不要在 import 路徑加 `?v=` 這類 cache-busting 參數（例如 `import ... from './modules/v2/uiFeedback.js?v=2'`）試圖繞開這個問題——ES module 的模組身份是以完整 specifier（含查詢字串）判斷同一份模組，同一支 `uiFeedback.js` 若同時被 `v2-app.js`（新版，帶 `?v=2`）與其他尚未跟進改 specifier 的呼叫端（舊版，不帶參數）載入，瀏覽器會建立**兩個獨立的模組實例**，`uiFeedback.js` 內的模組級狀態（例如 `_syncSourceStatus` Map，見本文件「Stage 1」附註的中 #A 修復）會分裂成兩份互不同步的複本——比原本的「10 分鐘快取窗、硬重整即解」還嚴重，且不會自己恢復。目前只有 `index.html` 的兩個直接 `<script>` 標籤（`app.js`／`v2-app.js`）有版本號，透過 import 語句載入的所有子模組完全沒有 cache-busting 機制，這是既有架構的既知限制，本次不處理；長期治本方向是為整個 V2 模組樹統一導入版本化機制（例如建置期在所有內部 import 路徑注入同一個版本號，或改走有雜湊檔名的打包流程），列為後續工作，不在本輪範圍。

### 4. 驗證清單（client 部署完成後立即執行）

| # | 情境 | 操作 | 預期結果 |
|---|---|---|---|
| 4a | **既有教師登入** | 用已綁定 `userMappings` 的既有帳號（例如 `uplilt31311227@gmail.com` 或任一 `v2t*` 測試帳號）正常登入 | 登入成功、身份與角色與部署前一致；瀏覽器 devtools 網路面板可見對 `teachers`/`data`/`substituteRecords` 的讀取回 200 |
| 4b | **新教師首登** | 見上方「驗證用測試對象」一節：先用 `firestore-bootstrap-inhu.js --add-teacher` 建立測試教師檔，**再跑一次回填腳本**，才用該 email 登入 | 登入成功、自動建立 `userMappings` |
| 4c | **跨校讀取被拒** | 用已登入的 `inhu` 帳號，在瀏覽器 console 對另一個不存在或非本人所屬的 `schoolId`（例如 `schools/some-other-school/teachers`）發 `getDoc`/`getDocs` | 回傳 `permission-denied`（HTTP 403），不是空結果、不是資料外洩 |
| 4d | **完全陌生使用者** | 用一個不在 `teachers` 集合、也不在 `initialAdminEmails` 白名單的 Google 帳號登入 | 登入被拒（`resolveIdentity` 回傳 `null`，前端 signOut），且 `schools/inhu/joinAttempts/{該帳號uid}` 有一筆紀錄（`email`/`attemptedAt`/`reason` 三欄），可在 V2「操作日誌」頁籤的「登入遭拒」區塊看到（驗收修復 S8） |
| 4e | **操作日誌讀取** | 用 director/section_chief 帳號打開「操作日誌」頁籤 | 正常顯示既有日誌（`operationLogs` 的 read 規則本次未變更，仍是 `isApprover`），並看到新增的「登入遭拒」區塊 |
| 4f | **emailIndex / joinAttempts 防灌爆** | 已登入教師在 devtools console 嘗試 `setDoc` 一個非白名單欄位到自己的 `emailIndex` 對應文件，或對不存在的 schoolId 嘗試寫 `joinAttempts` | 皆應 `permission-denied`（S3 的 `configExists`+欄位驗證、S9 的 `hasOnly(['teacherId'])`） |

驗證指令參考（瀏覽器 devtools console，登入後執行，僅示意，需替換成實際 Firebase SDK 呼叫方式或直接觀察 Network 面板的 Firestore 請求狀態碼）：

```js
// 4c 範例：跨校探測應回 permission-denied
import { getDoc, doc } from 'firebase/firestore';
try {
  await getDoc(doc(db, 'schools/not-my-school/teachers/whatever'));
  console.error('⚠️ 未被拒絕，規則有破口！');
} catch (e) {
  console.log('預期行為：', e.code); // 應為 'permission-denied'
}
```

### 5. 若驗證失敗：回退

**回退順序與部署順序相反**：先回退 client（若已部署），再回退 rules。

```bash
# 5a. client 回退（若步驟 3 已執行）：preview 分支指回 Stage 0 之前的備份點
git push preview <Stage0之前的備份commit或分支>:main -f
# 例如比照 docs/DEPLOYMENT.md 既有的備份點慣例：
#   git push preview backup-pre-phase3-20260710:main -f
# （Stage 0 上線前應先建立一個新的備份分支，例如 backup-pre-stage0-20260731）

# 5b. rules 回退：找回 Stage 0 之前的 commit，重新部署舊版 firestore.rules
git log --oneline -- firestore.rules
git show <Stage0之前的commit>:firestore.rules > /tmp/firestore.rules.rollback
cp /tmp/firestore.rules.rollback firestore.rules
node scripts/firestore-deploy-rules.js
# 部署完成後記得把工作目錄的 firestore.rules 復原回 Stage 0 版本（git checkout -- firestore.rules），
# 不要讓「已回退規則」與「本地檔案已是新版」的狀態不一致。
```

或直接用 `--list` 找到 Stage 0 部署前的 ruleset 名稱（部署前記得先跑一次 `--list` 存證），用 Firebase Console → Firestore → Rules → History 手動指回。

**回填腳本沒有對應的「回退」動作**：`emailIndex` 只是新增的索引集合，即使規則與 client 都回退到 Stage 0 之前（`teachers` 讀取重新開放給任何登入者），`emailIndex` 條目留著不影響任何現有功能，不需要清除。

**若只回退 rules、不回退 client**（即從組合④退回組合③再退回組合①，但 client 忘了退）：這會讓 client 暫時處於「新 client × 舊 rules」＝組合②——**既有成員仍正常（S6 後備），但新教師首登會再度失效**。若發現這個狀態，應盡快也把 client 退回，或乾脆重新走一次正確順序修好 rules，不要停留在組合②。

## 附註：與現行狀態的關係

- 部署前現行線上 ruleset release：見 `docs/DEPLOYMENT.md` 部署環境總覽區塊「現行線上 release」欄位（每次部署後應更新該欄位，含 ruleset 名稱與日期）。
- 本次改動不涉及 `schools/{schoolId}` 的寫入規則、`substituteRecords`/`pendingRequests` 的 create/update 規則、`userMappings` 的自建防提權邏輯——這些維持不變，Stage 0 只收緊「讀取」與 `operationLogs`/`emailIndex`/`joinAttempts` 的守門條件。
- Stage 0 完成後，下一步是 §8 路線圖的 Stage 1（讀取成本止血），與本次改動彼此獨立，可分開排程。

## 附註：Stage 1（讀取成本止血）新增的複合索引部署

Stage 1 對 `pendingRequests` 新增兩條查詢（`schoolDataService.js` 的 `subscribePendingRequests` /
`listOpenPendingRequests` 用 `where('status','in',[...]).orderBy('createdAt','desc')`；
`listPendingRequestsByInitiator` 用 `where('initiatedBy','==',teacherId).orderBy('createdAt','desc')`），
兩者的欄位（where 欄位≠orderBy 欄位）都需要複合索引，已宣告在 `firestore.indexes.json`（**本次未執行部署，未建立 `firebase.json`**）。

驗收另外新增的兩條衝堂檢查查詢（`queryRecordsByExactDate`／`queryPendingRequestsByExactDate`，皆為單一 `where('date','==',...)`）與 `substituteRecords` 的原有新查詢（`listSubstituteRecordsPage` 的
`orderBy('createdAt')+limit`、`queryRecordsByDateRange` 的 `where('date',...)+orderBy('date')`）
range/where/orderBy 皆同欄位或單欄位相等，屬 Firestore 自動建立的單欄位索引，**不需額外複合索引、不需部署任何東西**。**全部需要複合索引的查詢只有上述 `pendingRequests` 那兩條。**

### ⚠️ 索引必須先於 client 上線——硬性順序，不是建議

**依驗收實測結果，這是本文件唯一被明確訂正為「硬性規則」的一節**：`listPendingRequestsByInitiator`／`listOpenPendingRequests` 缺索引時，`getDocs()` 會直接 `reject`（`failed-precondition`）。**驗收在索引未部署的狀態下實測，發現的不是「待辦清單的『我的申請』區塊讀不到資料」這種局部失敗，而是整個 app 判定登入失敗、`_v2GateError=true`、永久 `lockV2App()`——所有使用者、所有頁籤全部被鎖死、無法使用，唯一恢復方式是重新整理後祈禱網路時序剛好不同（不可靠），或回退程式碼。**

根因是 bootstrap 的 `onAuthStateChange` 把「身份解析」與「身份解析成功後的所有渲染/訂閱/預讀」包在同一個 try/catch 裡：任何一步失敗都被外層 catch 判定成「登入失敗」。這個根因已在程式碼修復（`v2-app.js` 的 `safeBootstrapStep()`：身份解析之後的每一步各自獨立降級，不再冒泡到外層致命 catch）。**修復後不再有全站鎖死，但降級的具體範圍要看缺的是哪一條索引——兩條索引各自對應不同功能，不能混為一談**：

- **`pendingRequests (initiatedBy ASC, createdAt DESC)` 缺席**：只影響 `listPendingRequestsByInitiator`（待辦頁籤「我的申請」區塊唯一資料來源）。該查詢已包區塊級 try/catch，失敗時「我的申請」顯示錯誤卡片＋重新整理鈕；「待我同意/待我審核」讀的是 `_v2PendingCache`，跟這條索引無關，維持正常；全校紀錄、課表、寫入功能同樣不受影響。
- **`pendingRequests (status ASC, createdAt DESC)` 缺席**：影響 `subscribePendingRequests`（即時訂閱）與 `listOpenPendingRequests`（bootstrap prefill）——這兩者才是「待我同意/待我審核」的資料來源，缺這條索引時兩者都會失敗。**驗收另外指出（中 #A）**：這種情況原本會讓 `_v2PendingCache` 停在初始空陣列、「待我同意/待我審核」誤顯示「目前沒有…」這種看似正常的空狀態文字（假陰性，比顯性錯誤更危險——沒有人會去回報「一切正常」的畫面），且同步中斷徽章可能被其他訂閱（例如課表訂閱成功）洗成「已同步」而掩蓋問題。已修復：新增 `_v2PendingSourceError` 旗標（訂閱 onError 與 prefill 失敗時設定），「待我同意/待我審核」改顯示錯誤卡片＋重試鈕；`uiFeedback.setSyncStatus()` 改為逐一記錄每條訂閱（`pending`/`records`/`schedule`）各自的健康狀態，只要還有任一條是壞的就不移除徽章，不再被其他成功的訂閱覆蓋掉。修復後「我的申請」、全校紀錄、課表、寫入功能不受影響，但**「待我同意/待我審核」本身仍然是壞的（只是從假陰性變成顯性的錯誤卡片，不再是全站鎖死）**。

兩種情況合起來看：**索引缺席永遠會讓對應的那部分功能真的壞掉，程式碼修復只解決「壞掉的方式」（從全站鎖死或假陰性，變成局部的、可見的錯誤卡片），不能讓功能本身變好——索引還是得部署。**

即便如此，**「索引必須先於 client 上線」仍然是硬性順序，不能因為程式碼有降級保護就跳過**：

1. 降級保護只覆蓋「目前已知會用到這兩條查詢的路徑」，日後任何新增的查詢若忘記包保護，一樣可能重現全站鎖死；把索引部署當成事後補救的安全網，而不是可以取代先部署索引的替代方案。
2. 即使降級成功，**每一個受影響的使用者仍然看到一個功能是壞的**（依缺的是哪條索引，可能是「我的申請」讀不到，也可能是「待我同意/待我審核」整段讀不到），這對正式上線是不可接受的使用者體驗，不是「反正不會當機就沒關係」。
3. **本專案的部署模型放大了這個風險**：`preview` 站（`https://uplilt31311227.github.io/STsystem-preview/`）用 `git push preview feature/permission-system:main` 部署，GitHub Pages 收到 push 後**自動建置、無 CI 閘門、無人工核准步驟**，通常 1-3 分鐘內就對外生效（見本文件「上線順序」步驟 3 的既有描述）。這代表**一旦把用到新查詢的程式碼 push 到 preview，若索引還沒建好，最快 1-3 分鐘後就會有真實使用者（測試教師帳號、甚至正式教師）撞上**——沒有 staging 環境、沒有 feature flag、沒有逐步放量，push 即上線。

**正確順序（與 Stage 0 的「回填 → rules → client」同一精神，索引比照回填、必須排在 client 部署之前）**：

```
1. 部署 firestore.indexes.json 的兩條複合索引（見下方三選一）
2. 到 Firebase Console 確認兩條索引狀態皆為「已啟用」（Enabled，不是 Building）
3. 才執行 git push preview feature/permission-system:main
```

索引建置時間依集合大小通常數分鐘內完成（`pendingRequests` 目前正式庫規模很小），但**建置中的索引查詢一樣會 `failed-precondition`**，跳過步驟 2 直接部署 client 等於沒做這件事。

**部署前必讀**：本專案沒有 `firebase.json`／Firebase CLI 工作流程（規則走 `scripts/firestore-deploy-rules.js` 這支自製 REST 腳本，不是 `firebase deploy`），目前也沒有對應的索引部署腳本。索引部署三選一（依可靠度排序，**不建議依賴選項 3**）：

1. **建立 `firebase.json`＋改用 Firebase CLI**：新增
   ```json
   { "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" } }
   ```
   再跑 `firebase deploy --only firestore:indexes`（需先 `firebase login` 且專案 ID 為 `stsystem-9d5fe`，與 `firestore-deploy-rules.js` 的 `PROJECT` 常數一致）。這個路徑會讓規則部署也可以改用標準 CLI，但目前規則腳本已穩定運作，是否一併遷移留待另行評估，不在本次範圍。
2. **手動在 Firebase Console 建立**：Firestore Database → 索引 → 複合索引，依 `firestore.indexes.json` 列的欄位與排序方向逐一新增（`pendingRequests`：`status` ASC + `createdAt` DESC；`pendingRequests`：`initiatedBy` ASC + `createdAt` DESC）。部署量小（2 條），這是目前最務實的路徑。
3. **（不建議依賴，僅供本機/測試環境驗證）讓錯誤觸發自動建立**：這兩條查詢若在索引未建立前執行，Firestore 會回傳 `failed-precondition` 並在錯誤訊息附上一個可直接點擊建立該索引的 Console 連結；但在**正式環境**這代表「先讓真實使用者撞到錯誤，才能取得建索引的連結」——即使有本輪的降級保護把衝擊縮小到「我的申請」單一區塊，這仍然是使用者親身踩雷才觸發修復，不應該是正式上線的部署手段。

索引建立後有短暫的「建置中」狀態（依資料量通常數分鐘內完成），建置完成前對應查詢會持續 `failed-precondition`；建議與 Stage 0 相同的節奏，在低峰時段部署並在 Console 確認索引狀態為「已啟用」後再視為上線完成。

## 附註：Stage 2（學期欄位化）新增的複合索引部署

Stage 2（`RESEARCH-multitenancy-semester.md` §5/§6.1/§8 Stage 2 一列）在 `pendingRequests` 疊加 `semesterId` 條件、並新增一條 `substituteRecords` 的即時視窗索引與一條歷史學期索引，`firestore.indexes.json` 異動如下（**本次同樣未執行部署**）：

| 集合 | 索引欄位 | 用途 | 狀態 |
|---|---|---|---|
| `pendingRequests` | `status` ASC + `createdAt` DESC | Stage 1 原索引 | **保留不動**（驗收修復 中 7）——原計畫在 Stage 2 把這條標記移除，但這是給「新 rules 已上線、client 還沒部署」或任何回退到舊 client 的降級路徑用的索引；若移除，一旦 client 版本不同步（例如瀏覽器快取住舊版 `v2-app.js`，或需要緊急回退 client），舊版查詢（不帶 `semesterId`）會直接 `failed-precondition`，比留著這條索引（多付一點點儲存與寫入 CPU，[S01]）風險高得多。改為兩條索引並存 |
| `pendingRequests` | `semesterId` ASC + `status` ASC + `createdAt` DESC | `subscribePendingRequests`／`listOpenPendingRequests` 疊加 `semesterId==目前學期` 後的新形狀 | **新增** |
| `pendingRequests` | `initiatedBy` ASC + `createdAt` DESC | `listPendingRequestsByInitiator`（「我的申請」，跨學期歷史） | 不變——Stage 2 刻意不疊加 `semesterId`，理由見 `schoolDataService.js` 該函式註解（用途就是要看橫跨學期的完整申請歷史，且已靠「單一教師」天然有界） |
| `substituteRecords` | `semesterId` ASC + `createdAt` DESC | `subscribeSubstituteRecords`（即時視窗）／`listSubstituteRecordsPage`（載入更多，共用同一個 cursor 序列） | **新增** |
| `substituteRecords` | `semesterId` ASC + `date` DESC | `listSubstituteRecordsBySemester`（新：紀錄頁「歷史學期」一次性檢視） | **新增** |

`queryRecordsByExactDate`／`queryPendingRequestsByExactDate`／`queryRecordsByDateRange` 三支既有查詢**維持不動**，未疊加 `semesterId` 條件——理由見 `schoolDataService.js` 各自函式的 Stage 2 註解（單一日期查詢與日期範圍查詢在語意上天然正確、完整，疊加 `semesterId` 條件在 `queryRecordsByDateRange` 的情境甚至會產生錯誤結果，例如橫跨學期邊界的那一週會被錯誤濾掉部分合法紀錄，詳見該函式驗收修復 輕 10 的說明）。`schedules/{semesterId}` 是單文件讀寫（`getDoc`/`setDoc`/`onSnapshot`），非集合查詢，不需要索引。

部署方式與 Stage 1 相同的三選一（見上方「附註：Stage 1」一節），**這次不需要移除任何既有索引，只需新建三條**（驗收修復 輕 9，原稿誤植「四條」且誤含一條「移除」動作——見上表，實際淨變動是新增 3 條、既有 3 條全部保留）：`firestore.indexes.json` 目前的檔案內容已是新增三條之後的最終狀態，Console 手動操作或 `firebase deploy --only firestore:indexes` 皆應以這份檔案為準。

**索引與 rules 部署順序**：Stage 2 的 `firestore.rules` 新增了 `semesterId` 唯讀鎖（見規則檔頭第 6 點），這與索引部署是兩件獨立的事，但都必須先於 client（`v2-app.js` 等）上線——client 一旦部署，會立刻對新索引形狀送出查詢，索引未就緒會重現「附註：Stage 1」一節描述的 `failed-precondition` 降級行為（已有 `safeBootstrapStep` 保護，不會全站鎖死，但對應功能會顯性壞掉）。此外**必須先跑 `scripts/backfill-semester-id.js` 回填既有紀錄的 `semesterId`，才能部署 rules**——回填前部署 rules，`substituteRecords`/`pendingRequests` 的新建立規則不受影響（新寫入本來就一律由程式碼蓋上 `semesterId`），但**紀錄頁／月結算若在回填前就把查詢改成疊加 `semesterId==目前學期`，會查不到任何回填前的舊紀錄**（舊紀錄沒有這個欄位，`where('semesterId','==',...)` 不會比對到），這正是本次驗收報告「相容期行為表」要核實的項目，見報告內文。

**新 rules × 舊 client 的過渡窗口（驗收修復 中 6）**：比照上方 Stage 0 的「相容性矩陣」精神補一格——rules 已部署新版（要求 `'semesterId' in request.resource.data`）、client 還沒跟上時，舊 client 送出的 `substituteRecords`/`pendingRequests` create 一律不帶 `semesterId`，會被規則明確拒絕（`permission-denied`，不是模糊的評估錯誤）。**這段窗口內全校使用者都無法新增調代課紀錄或送出申請**（既有紀錄的讀取、編輯不受影響，因為那兩條規則各自的相容期短路豁免只看 `resource.data` 是否已有 `semesterId`，與 client 版本無關）。因為影響是「全校寫入功能中斷」而非侷限在少數情境，**必須把 rules 部署與 client 部署排在同一次維運操作內連續執行**（比照 Stage 0 的時間窗壓縮做法），並提前公告「換版期間可能有幾分鐘無法送出調代課申請，請稍後再試」。

**「開新學期」的公告要求（驗收修復 中 3）**：學期切換是全校性事件——切換後其他仍開著頁面的使用者（尤其是切換當下正在填寫調代課申請的教師）會直到收到 `subscribeConfig()` 的變更通知（顯示畫面頂端的橫幅提示）才知道自己看到的是已經唯讀的舊學期。director 執行「開新學期」前，除了 UI 上的 confirm modal，**建議額外用既有的校內公告管道（例如 Line 群組、email）提前通知「即將切換學期，請先完成手上的調代課申請，切換後請重新整理頁面」**，不要只依賴頁面內的被動提示。

**正式庫 `schools/inhu` 的 `schedules/` 集合現況（驗收修復 中 5 相關）**：撰寫本文件時，正式庫尚未有任何 `schedules/{semesterId}` 文件（Stage 2 之前的課表全部存在單一文件 `data/schedule`）。這代表：
1. 部署 client 後、第一次有人打開「紀錄頁」的學期選擇器之前，下拉選單只會看到「當前學期」一個選項（`v2ListSemesterOptions()` 的 `schedules/` 集合查詢會是空的，僅靠 `∪ currentSemester` 補上目前學期本身）。
2. 課表讀取不受影響（`getSchedule`/`subscribeSchedule` 內建的一次性 fallback 會退回讀舊 `data/schedule`，見該函式註解）。
3. 建議部署後盡快跑一次 `node scripts/migrate-schedule-to-semester.js --dry-run` 確認計畫、再正式執行，讓目前學期立刻有一份 per-semester 文件；歷史學期的 `schedules/{semesterId}` 文件則會在第一次「開新學期」時自動補建（`switchToNewSemester()` 內建的空殼補建邏輯，見 `v2-app.js`），不需要額外手動處理。

## 附註：Stage 3（SCHOOL_ID 動態化）部署節

> 對應設計：[`RESEARCH-multitenancy-semester.md`](./RESEARCH-multitenancy-semester.md) §4（集合設計預告）、§8 路線圖 Stage 3。
> 目的：`SCHOOL_ID` 從 `schemaConstants.js` 的 import-time 常數改為登入後由 `authGuardV2.resolveIdentity()` 動態解析（`getActiveSchoolId()`/`setActiveSchoolId()`），為 Stage 4（開放註冊）鋪路。本階段**不改變任何現有使用者可觀察到的行為**——`inhu` 仍是唯一正式服務的學校，只是「schoolId 從哪裡來」這件事從寫死常數換成了 runtime 解析＋fallback。

### 本次新增了什麼

| 類別 | 內容 |
|---|---|
| `schemaConstants.js` | `SCHOOL_ID` 常數移除，改為 `getActiveSchoolId()`／`setActiveSchoolId()`／`resetActiveSchoolId()`（模組層狀態）＋ `DEFAULT_SCHOOL_ID='inhu'`（相容期 fallback）；`SCHEMA_PATHS` 全部改吃動態值；新增 `SCHEMA_PATHS.userDirectoryDoc(uid)`（頂層路徑，不依賴 schoolId） |
| `schoolDataService.js` | 新增 `getUserDirectoryEntry(uid)`／`upsertUserDirectoryEntry(uid, schoolId)`，其餘函式**零改動**（本來就只透過 `SCHEMA_PATHS.*()` 組路徑，未直接引用 `SCHOOL_ID`） |
| `authGuardV2.js` | `resolveIdentity()` 開頭新增 `resolveSchoolIdForUid()` 呼叫：讀頂層 `userDirectory/{uid}` 取得 schoolId → `setActiveSchoolId()` → 才繼續走既有的 emailIndex/teachers/userMappings 配對流程；成功登入後若 `userDirectory` 尚無條目，補寫一筆（自我收斂，不需要每個人都跑過回填腳本） |
| `v2-app.js` | 匯出 meta 的 `schoolId: SCHOOL_ID` 改 `getActiveSchoolId()`；登出分支新增 `resetActiveSchoolId()`；`resetV2ViewState()` 新增 `semesterState.setCurrentSemesterId(null)`（「school 切換」維度）；新增 `applyV2LocalStorageKey()`（localStorage key 前綴化＋一次性遷移，於身份解析成功後呼叫）；`patchClearLocalData()` 改清 school-scoped key |
| `app.js` | 新增 `getLocalStorageKey()` 方法（V1 預設回傳未加前綴的舊 key，行為不變）；`loadSavedData()`／`saveDataToStorage()`／`clearLocalData()` 改呼叫這個方法而非寫死字面值 |
| `firestore.rules` | 新增頂層 `match /userDirectory/{uid}`：self read/write，`create`/`update` 欄位白名單 `schoolId`/`createdAt`，`schoolId` 需 `configExists()`（防指向不存在的學校）且不可含 `/`（防路徑插入） |
| `scripts/backfill-user-directory.js` | 回填既有 `schools/{school}/userMappings` 成員的 `userDirectory` 條目，`--dry-run` 預設、**本次未執行** |

### 四組合部署矩陣：與 Stage 0 的關鍵差異

Stage 0 的四組合矩陣（見本文件最上方一節）之所以要求「必須先部署 rules、再部署 client」，根因是**舊 client 對新規則的失敗完全沒有 fallback**（新教師讀不到 `teachers`，直接卡死）。Stage 3 的設計刻意反過來：`resolveSchoolIdForUid()` 與 `upsertUserDirectoryEntry()` 的呼叫**兩邊都包 try/catch，任何失敗一律 fallback 或靜默略過，不 rethrow**（見 `authGuardV2.js` 對應函式）。這讓 Stage 3 的四組合矩陣呈現「兩個方向都安全」的結果，與 Stage 0/2 不同：

| 組合 | 現有 `inhu` 成員（已有 `userMappings`） | 行為分析 |
|---|---|---|
| ① 舊 client × 舊 rules（**現況**） | 正常 | `SCHOOL_ID` 仍是 import-time 常數 `'inhu'`，完全不涉及 `userDirectory`，行為與 Stage 3 之前一致 |
| ② **新 client × 舊 rules**（先部署 client、還沒部署 rules 的時間窗） | 正常 | `getUserDirectoryEntry()` 讀頂層 `userDirectory/{uid}`——舊規則對這個路徑沒有 `match` 區塊，Firestore 預設 `DENY`，`getDoc` 拋 `permission-denied`；`resolveSchoolIdForUid()` 的 try/catch 接住（新版已依 `e.code==='permission-denied'` 明確判斷，見該函式），`entry=null` → fallback 到 `DEFAULT_SCHOOL_ID='inhu'`，效果等同組合①。登入成功後嘗試 `upsertUserDirectoryEntry()` 同樣被舊規則拒絕，同樣被 try/catch 接住只留一則 `console.warn`，**不阻擋登入**。⚠ 實測修正：原稿估計「每次登入多兩次註定失敗的 Firestore 請求」，但 `onAuthStateChange` 在單次登入過程中會因 Firebase SDK 內部行為（本機快取還原、token 就緒後的正式回呼等）re-emit 多次，實測環境下 `resolveIdentity()` 於一次登入內平均被觸發 2 次，每次各自產生 2 次 `userDirectory` 請求（讀 `getUserDirectoryEntry` + 寫 `upsertUserDirectoryEntry`）——**一次登入實際觀察到約 4 次註定失敗的請求與對應的 console 警告**，不是原估的 2 次。全部仍是無害的失敗請求（皆被 try/catch 接住、皆不計費以外無其他影響），只是雜訊量比原稿估計多一倍，這裡訂正，不影響「不阻擋登入」的結論 |
| ③ **舊 client × 新 rules**（先部署 rules、還沒部署 client 的時間窗） | 正常 | 舊 client 完全不知道 `userDirectory` 這個集合存在，新規則只是「多了一個沒人用的 match 區塊」，對舊 client 的任何既有請求零影響（新增的 match 是純附加，不修改任何既有 match 區塊）。效果等同組合① |
| ④ 新 client × 新 rules（**目標穩定態，回填已跑**） | 正常，且更快 | `userDirectory/{uid}` 已有條目，`getDoc` 一次到位讀到 `schoolId='inhu'`，不需要 fallback，也不再嘗試（不必要的）`upsertUserDirectoryEntry()`（`userDirectoryExisted===true` 時跳過） |
| ④' 新 client × 新 rules（**回填未跑**） | 正常，行為等同④，只是多一輪收斂 | 第一次登入：`getDoc(userDirectory/{uid})` 因文件不存在回傳 `exists()===false`（**不是** `permission-denied`——新規則允許本人 `get` 自己的路徑，文件是否存在是另一回事），`entry=null` → fallback `'inhu'`；登入成功後 `upsertUserDirectoryEntry()` 這次規則允許寫入（`configExists('inhu')` 成立），成功建立條目。**下一次登入起就是穩定態④**，不需要人工介入 |

**結論（與 Stage 0/2 的部署順序要求相反）**：

1. **兩個部署順序皆安全，沒有「必須先做哪一個」的硬性順序**——這是 Stage 3 刻意的設計目標，不是巧合。所有跨越尚未部署一方的請求（讀/寫 `userDirectory`）都設計成「失敗即 fallback／靜默略過」，不會讓任何請求鏈條中斷。
2. 即便如此，仍建議依照與 Stage 0/2 一致的節奏（rules → client）操作，理由不是正確性風險，而是**噪音管理**：先部署 rules 可以讓「新 client × 舊 rules」這格完全不會出現，減少過渡期 console 出現的預期外 `permission-denied` 警告（雖然這些警告本身無害，但排查其他問題時少一點雜訊更好）。
3. **回填（`scripts/backfill-user-directory.js`）不是部署前置條件**（與 Stage 0 的 `emailIndex` 回填、Stage 2 的 `semesterId` 回填不同，那兩個回填缺席會直接造成功能性中斷或資料查詢遺漏）。回填的價值是**收斂速度**：讓所有現有成員不必各自登入一次才補齊 `userDirectory` 條目，對維運（例如未來要離線批次查詢「這個 uid 屬於哪校」）更方便。建議順序仍是「先跑 `--dry-run` 核對、確認無 CONFLICT 後再部署 rules/client」，純粹是良好衛生習慣，不是阻斷關係。

### 相容紅線驗證重點

- **現有 `inhu` 使用者在「新 client＋新 rules＋回填已跑」下體驗完全不變**：見組合④，`getActiveSchoolId()` 恆為 `'inhu'`，`SCHEMA_PATHS.*()` 組出的路徑與 Stage 3 之前完全相同字串。
- **回填未跑時靠 DEFAULT fallback 也不得中斷**：見組合④'，`resolveSchoolIdForUid()` 的 fallback 保證任何一步失敗都收斂到 `DEFAULT_SCHOOL_ID`，且失敗路徑不 rethrow、不阻擋 `resolveIdentity()` 繼續往下走既有的 `isMember`/`isInitialDirector` 判斷鏈。

### localStorage 遷移驗證

`applyV2LocalStorageKey('inhu')` 在每次身份解析成功後執行：新 key（`substituteSystemData:inhu`）不存在且舊 key（`substituteSystemData`）存在時，複製（非搬移）一份到新 key；之後 `window.app.getLocalStorageKey()` 改回傳新 key。驗證重點：

- 部署後首次登入，瀏覽器 devtools → Application → Local Storage 應同時看到 `substituteSystemData`（舊，內容不變）與 `substituteSystemData:inhu`（新，內容為舊 key 的複本）。
- 不帶 `?v2=1` 開啟同一個瀏覽器設定檔（V1 模式），`loadSavedData()` 讀的是 `this.getLocalStorageKey()` 的 V1 預設值（未加前綴的舊 key），資料應與 Stage 3 之前完全一致——這是任務規格「V1 模式維持舊 key 不動」的驗收點。
- ⚠ opus 驗收 中1 訂正：「清除所有資料」（V2，director）**同時清掉 `substituteSystemData:inhu`（新）與 `substituteSystemData`（舊）兩把 key**，不再是只清新 key。原版只清新 key 的設計會讓舊 key 停留在「一次性遷移時複製過去」的內容（Stage 3 之後 V2 不再持續覆寫舊 key，見 `legacyMigrationService.js` 檔頭訂正說明），若之後觸發 `legacyMigrationService` 的偵測流程，會把這份已被清除的舊資料誤判為「V1 遺留資料」提供遷移選項，一旦真的執行遷移，等於把已刪除的紀錄復活寫回 Firestore。「V1 模式維持舊 key 不動」這條紅線只保護「V1 使用者不受 Stage 3 部署影響」，不保護「V2 的清除動作不能波及舊 key」——後者本來就是 V2 director 主動觸發的破壞性操作，理應把這台裝置上這所學校的本機鏡像（不論存在哪個 key）一起清乾淨。
- 登出後（不整頁重新整理）換帳號登入前，`window.app.getLocalStorageKey` 應已被還原成 `App.prototype` 的預設方法（`delete window.app.getLocalStorageKey` 於登出分支執行，見 opus 驗收 輕5）——可在 devtools console 執行 `Object.prototype.hasOwnProperty.call(window.app, 'getLocalStorageKey')` 確認登出後回傳 `false`。

### 已知殘留風險：`userDirectory` 的 schoolId 存在性探測（opus 驗收 中10 後半）

`userDirectory/{uid}` 的 `create`/`update` 規則要求 `configExists(request.resource.data.schoolId)`——任何已登入使用者可以對自己的 `userDirectory/{我的uid}` 嘗試寫入任意候選字串當 `schoolId`，藉由請求成功/失敗（`permission-denied`）反推「這個 schoolId 是否對應一所真實存在的學校」。這與報告 [`RESEARCH-multitenancy-semester.md`](./RESEARCH-multitenancy-semester.md) §4.5 第 2 點「偵測式的跨校探測（修補後仍殘留）」是同一類別的殘留風險——即使做完所有規則收緊，攻擊者仍可用「請求某校資料 → 看是被拒還是通過」確認某個 schoolId 存在，且每次探測都會觸發規則的 `get()/exists()` 並計費。這不是 Stage 3 新增的破口，只是多了一個探測端點，歸入報告已經誠實列出、目前無解的殘留風險類別，不在本階段（也不在 Stage 4）試圖消除——報告本身也說明這類探測是低價值的資訊洩漏。

## 附註：Stage 4（多租戶開通）四組合部署矩陣

> 對應設計：[`RESEARCH-multitenancy-semester.md`](./RESEARCH-multitenancy-semester.md) §4／§8 路線圖 Stage 4；[`RESEARCH-blaze-followup.md`](./RESEARCH-blaze-followup.md)。完整部署 SOP（App Check、預算警報、緊急煞車）見 [`docs/STAGE4-DEPLOY.md`](./STAGE4-DEPLOY.md)，本節只補「新舊組合交叉」的相容性分析，比照 Stage 3 一節的既有格式。
>
> ⚠ opus 驗收 B1 修復後改版：原表只分「現有 inhu 成員」與「全新陌生人」兩類，遺漏了「新校已核准、校內第二位（含之後）教師從未登入過」這一類——這正是 B1 要修的阻斷級問題（原設計會讓這類使用者永遠卡在查無教師配對）。本節改為三類族群交叉分析，並反映 B1 對 `resolveSchoolIdForUid()` fallback 語意的修改（查無條目不再無條件 fallback `inhu`）。

Stage 4 新增三個頂層集合（`schoolApplications`／`platformAdmins`／`schoolDirectory`）與規則修改：`config/{docId}` 新增 platformAdmin create-only 分支（鎖 `docId=='main'`）、`userDirectory` 新增 `isEmailVerified()` 要求＋platformAdmin 代寫分支、`joinAttempts` 新增 `isEmailVerified()`。三類族群：

- **A. 現有 `inhu` 成員**（已有 `userMappings`，且 `userDirectory` 已回填）
- **B. 新校成員**（`teachers`/`emailIndex` 已由該校 director 建檔，但自己從未登入過、無 `userDirectory` 條目）——B1 修復的目標族群
- **C. 全新陌生人**（不屬於任何學校，走申請流程）

| 組合 | A. 現有 inhu 成員 | B. 新校成員 | C. 全新陌生人 | 行為分析 |
|---|---|---|---|---|
| ① 舊 client × 舊 rules（現況） | 正常 | 不適用（Stage 4 上線前不存在「新校」這個概念） | 走 Stage 3 之前的行為：`resolveIdentity()` 找不到配對即登出，顯示「尚未授權」 | 基準線 |
| ② **新 client × 舊 rules** | **正常，零影響** | 卡在雙選項畫面：「加入既有學校」呼叫 `upsertUserDirectoryEntry()` 寫 `userDirectory`——這個路徑 Stage 3 就已存在於舊規則中（`userDirectory` 的 match 區塊本身不是 Stage 4 新增的），**但舊規則版本沒有 `isEmailVerified()` 要求**，寫入本身可能成功；然而後續要用到的 `schools/{新校}/emailIndex`／`config` 等，若「新校」本身是 Stage 4 才核准的，這所學校的 `config`（含 `initialAdminEmails`）根本還沒被建立（因為核准動作也需要新 rules 才能執行），所以完整走通「加入→登入成功」在此組合下不成立，但**失敗模式是「配對不到教師，回到雙選項畫面」，不是白屏或例外**。「申請開通新學校」表單一樣會因為 `schoolApplications` 舊規則無 match 區塊而 `permission-denied`，被 `refreshApplyState()` 的 try/catch 接住 | 卡在「申請流程」畫面，但不會壞——`getApplication(uid)` 讀 `schoolApplications/{uid}` 得到 `permission-denied`，`refreshApplyState()` 接住並顯示「無法確認申請狀態」+ 重試鈕 |
| ③ **舊 client × 新 rules** | **正常，零影響**（前提：已回填，見下方相容紅線） | 不適用（舊 client 沒有「加入既有學校」UI，即使規則已支援，使用者也無路可用；核准流程本身也需要新 client 的審核頁 UI 才能觸發，舊 client 下平台管理者看不到審核頁） | 仍是舊行為（直接登出），Stage 4 UI 尚未上線 | 舊 client 完全不知道三個新集合存在，新規則對它是「多了幾個沒人用的 match 區塊」。⚠ 相容性細節：`userDirectory` 自寫分支新增了 `isEmailVerified()` 要求——這個分支只在 `!userDirectoryExisted`（尚無既有條目）時才會被舊 client 呼叫到，且呼叫本身包在 try/catch 裡、失敗**不阻擋登入**。實際受影響族群縮小到「尚未回填、且用 Email/密碼登入、且 email 未驗證」的 `inhu` 成員——即使命中，這次登入不會寫入 `userDirectory` 捷徑，**登入本身不受影響**（見下方「B1 後的相容紅線」，回填已完成時此情境不會發生） |
| ④ 新 client × 新 rules（目標穩定態） | 正常 | 完整可用（見 `docs/STAGE4-DEPLOY.md`「全鏈走讀」第 2 類：新校成員） | 完整申請/審核流程可用（見同文件第 1 類） | 見 `docs/STAGE4-DEPLOY.md`「全鏈走讀」一節 |

### B1 後的相容紅線：回填腳本從「建議」變成「硬性前置條件」

與 Stage 3 上線時的評估不同——Stage 3 的 `DEFAULT_SCHOOL_ID` fallback（查無 `userDirectory` 條目一律當成 `inhu`）讓「回填與否」只影響**效率**（多繞一次 fallback），不影響**能不能登入**。B1 把這個 fallback 拿掉後（原因見 `docs/STAGE4-DEPLOY.md`「全鏈走讀」第 2 類），「回填與否」變成直接影響**能不能登入**的硬性依賴：

- 若 `inhu` 現有成員的 `userDirectory` **已回填**（`existed:true`）：`resolveSchoolIdForUid()` 第一分支就命中，完全不會進入「查無條目」的判斷，行為與 Stage 4 之前一致，B1 的修改對這批人是**不可觀察的**。
- 若**尚未回填**：這批人下次登入會被 `resolveSchoolIdForUid()` 判定為「查無條目」，回傳 `null`，被導向雙選項畫面——這是**新的、不該發生在既有成員身上的行為**，因此 `docs/STAGE4-DEPLOY.md` 已將 `scripts/backfill-user-directory.js` 對 `inhu` 全體成員的執行，從部署步驟的「建議」提升為「第 0 步、不可省略」。

**結論**：組合②③在「B. 新校成員」與「C. 全新陌生人」兩類上與 Stage 3 一致（都是「單邊部署時功能不完整但不崩潰」），但「A. 現有 inhu 成員」這一類的安全網從 Stage 3 的「規則層 fallback」改為「部署前的回填腳本執行」——這是本節與 Stage 3 對應章節最大的方向差異，務必在部署前確認回填已完成，不能只看部署順序而略過這個前置動作。

仍建議照 `docs/STAGE4-DEPLOY.md` 的順序（回填 → rules → 建立 platformAdmin → client）操作。
