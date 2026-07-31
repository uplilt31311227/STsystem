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
