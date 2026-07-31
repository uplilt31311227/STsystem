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
