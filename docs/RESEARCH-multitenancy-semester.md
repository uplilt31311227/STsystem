# 架構設計研究報告：多校多租戶 × 學期資料生命週期

> 專案：STsystem（國中調代課自動化系統）
> 撰寫日期：2026-07-31
> 適用架構：純前端 SPA（GitHub Pages）＋ Firebase Auth ＋ Firestore，無自建後端、無 Cloud Functions，目前 Spark 免費方案
> 研究題目：(A) 學期資料生命週期（切換／3 年保留／跨學期統計／期滿匯出封存後刪除）、(B) 多校多租戶（20+ 校、開放註冊、絕對隔離）

---

## 閱讀本報告的三種標記

| 標記 | 意義 |
|---|---|
| **[C01]–[C21]** | 已通過 3-0 對抗式查證的外部事實。來源與原文引述見 §10 附錄 A。**可直接當作決策依據。** |
| **[S01]–[S12]** | 研究階段擷取的單一官方來源主張，**未經三方對抗查證**。可信度高（多為 Firebase 官方文件原文），但引用時保留一分保留。見 §10 附錄 B。 |
| **（推估）** | 本報告作者依 codebase 現況與合理假設推導的數字或判斷，**非查證事實**。所有推估的計算過程都寫在旁邊，可自行複核。 |
| **（待查證）** | 需要但目前無法取得的數字。**不得當作決策依據。** 集中列於 §9。 |

codebase 主張一律附 `檔案:行號`。

---

## 1. 決策摘要

### 題目 A：學期資料生命週期 → 推薦「semesterId 欄位化 + bounded query + 前端匯出後批次刪除」

1. **資料模型**：課表從單一文件 `schools/{id}/data/schedule`（`schoolDataService.js:155-159`，整份覆寫）改為 per-semester 文件 `schools/{id}/schedules/{semesterId}`；`substituteRecords` / `pendingRequests` / `operationLogs` 各加一個 `semesterId` 欄位，**不採學期子集合**（理由見 §5.2：子集合會逼出 collectionGroup 查詢，而 collectionGroup 在多租戶下是隔離破口）。
2. **訂閱改造**（最高優先，見 §7 的成本結論）：現行 `subscribeSubstituteRecords` / `subscribePendingRequests` 是**無 where、無 limit 的整集合監聽**（`schoolDataService.js:432-448`），讀取量 = 全校累積紀錄數 × 每日登入人次。改為「當前學期 + limit 分頁的 onSnapshot」；歷史學期改用一次性 `getDocs` + 依 `schoolId+semesterId` 前綴的本地快取。
3. **封存**：期滿由 director 在前端做「全校 JSON 匯出 → 筆數/雜湊驗證 → 使用者確認 → 批次刪除」。**不採 Firestore TTL 作為主要機制**（TTL 需 Blaze [C09]、非即時且刪除前資料仍可被查到 [C17]、且無法保證「先匯出才刪」的順序）；**不採 managed export**（需 Blaze + Cloud Storage bucket [C20][C18]，且每匯出一份文件計一次讀但不顯示在 console 用量區、容易產生非預期帳單 [C21]）。

### 題目 B：多校多租戶 → 推薦「單一資料庫 collection-per-tenant（深化現行 `schools/{id}`）＋ 成員資格規則隔離 ＋ 申請制開通」

1. **架構選型**：維持現行 `schools/{schoolId}/...` 單庫多租戶。**named database per-tenant 直接出局**：每個專案只有一個資料庫享免費額度、其餘全額計費且要建額外資料庫必須先升級計費方案 [C05][C08]，而建立資料庫需要 `roles/datastore.owner` 這類 GCP 管理面 IAM 權限、純前端使用者不可能自助開通 [C02] —— 「開放自行註冊」與「named database per-tenant」在定義上互斥。
2. **隔離手段**：純前端無法使用 custom claims（只能由具特權的伺服器環境經 Admin SDK 設定 [C13]），因此租戶成員資格只能走 Security Rules 的 `get()/exists()` 查成員文件 [C10]。**現行規則有實質破口**：`teachers` / `data`（課表）/ `substituteRecords` / `pendingRequests` 的讀取只驗 `isSignedIn()`（`firestore.rules:135, 178, 185, 240`），任何登入者只要知道別校 `schoolId` 就能直讀。§4 給出逐條修補清單。
3. **開通方式**：**推薦「自助申請 + 平台管理者輕量審核開通」，不推薦全自助建校**。理由不是隔離做不到（隔離做得到），而是 **Spark/Blaze 的配額與帳單是全專案共享的**，任何一個惡意租戶都能耗盡全平台額度，而 Firestore 沒有內建的 server-side rate limiting [S10][S12]，App Check 官方也明言只能擋掉部分而非全部濫用向量 [C16]。

### 預算結論

| 情境 | 現行全量訂閱模式 | bounded query 改造後 |
|---|---|---|
| 現況（1 校 30 師） | 已用掉 Spark 每日讀取的 ~66%，累積約 900 筆紀錄即超額（§7.3，推估） | 約 3% |
| 20 校 / 平均 40 師 | 約 **US$52/月**（推估） | **超出 Spark，但 Blaze 約 US$2/月**（推估） |
| 50 校 / 平均 50 師 | 約 **US$1,230/月**（推估，不可接受） | **Blaze 約 US$10/月**（推估） |

**結論：維持 Spark 只在「單校～十餘校 + 完成 bounded query 改造」的範圍內成立。20 校以上必然要進 Blaze，但只要做完訂閱改造，月費是「個位數到十幾美元」的量級，完全落在「小額 Blaze」的容忍範圍內。反過來說，若不做訂閱改造就擴到 20 校，帳單會是兩位數到四位數美元 —— 讀取模式改造才是預算的決定因素，方案選擇不是。**

---

## 2. 多租戶架構選型

### 2.1 三案比較

| 面向 | **A. 單庫 collection-per-tenant**（現行 `schools/{id}` 深化） | **B. named database per-tenant** | **C. Firebase 專案 per-tenant** |
|---|---|---|---|
| 隔離強度 | 邏輯隔離。完全依賴 Security Rules 正確性；一條規則寫錯即全域外洩 | 資料庫層隔離。各資料庫效能獨立、hotspot 不互相影響、可用 IAM conditions 做庫層存取政策 [S03][S04] | 最強。專案層完全隔離，連 IAM、配額、帳單都分開 |
| Spark 相容性 | ✅ 完全相容（現況已是） | ❌ 每專案只有一個資料庫享免費額度，其餘全額計費；且要建立額外資料庫必須先升級計費方案 [C05][C08] | ❌ 每專案各自有免費額度，理論上「免費」，但 20+ 專案的管理面不可行（見下列） |
| 自助開通可行性 | ✅ 建立 `schools/{newId}` 只是寫文件，client SDK 即可（規則需嚴格設計，見 §4.4） | ❌ 建庫需 `roles/datastore.owner` 等 IAM 權限，僅能經 console／gcloud／Firebase CLI／Terraform，無 client SDK 路徑 [C02] | ❌ 建專案需 GCP 組織層權限，比 B 更不可能 |
| 管理成本 | 一份 `firestore.rules`、一次部署 | 每個資料庫的規則各自獨立、必須用 Firebase CLI 逐一部署 [S05]；20 校 = 20 份部署 | 20+ 個 Firebase 專案的設定、規則、Auth 設定、網域授權各自維護；使用者跨校還要換 Auth 使用者池 |
| 規模上限 | 文件數無實務上限；瓶頸在**全專案共享的每日讀寫配額**（§7） | 每專案 100 個資料庫（可申請提高）[S02]，即 100 校 | 無技術上限，但每增一校就是一次人工開專案 |
| 前端改動 | `SCHOOL_ID` 常數（`schemaConstants.js:14`）改為 runtime 解析即可 | 需在建立 Firestore client 時指定 database ID，且要依租戶動態切換 client [S06] | 需依租戶動態換 `firebaseConfig`，Auth session 無法跨專案共用 |

### 2.2 推薦：方案 A，且 B 在本案是**定義上矛盾**的

named database per-tenant 之所以出局，不是「比較貴」，而是三條已查證事實疊起來後與需求直接衝突：

1. **「每專案僅一個資料庫享免費額度」**：官方定價頁明言 `Cloud Firestore allows exactly one free database per project`，且「你建立的第一個資料庫（不論 ID 是否為 `(default)`）取得免費額度，其餘資料庫依用量全額計費」[C05]。Google Cloud 側的配額頁同樣寫 `The free tier applies to only one Firestore database per project` [C08]。
   > ⚠️ 修正一個常見誤解：研究過程中有一條主張宣稱「免費額度**僅**適用於資源名稱為 `(default)` 的資料庫」，此主張在對抗查證中**被 3-0 推翻** —— 現行官方文件是「第一個建立的資料庫（不論 ID）」，而非「必須叫 `(default)`」。對本案結論無影響（無論如何都只有一個免費庫），但寫進技術決策文件時不要沿用舊說法。
2. **「建庫是管理面操作」**：建立／設定／刪除／複製資料庫需要 `Cloud Datastore Owner (roles/datastore.owner)`，且只能經 gcloud CLI、Firebase CLI、console 或 Terraform 執行，**不存在 client SDK 路徑** [C02]。要在純前端自動化，唯一辦法是把 service account 憑證放進前端 —— 等同把整個專案的管理權公開。
3. 因此：**「開放自行註冊」×「維持免費/小額」×「named database per-tenant」三者無法同時成立。** 選了 B，就等於選了「人工開通 + 每校付費」，那 B 相對 A 唯一剩下的好處（庫層隔離與 per-database 帳單細分 [S03]）並不值得付出 20 份規則部署 [S05] 與動態 client 切換 [S06] 的代價。

至於「Firestore Multiple Databases 已於 2024-02-06 GA、且官方明列使用情境包含 isolate customer data」[C03][C04] —— 這是真的，B 在技術上完全可行，只是**不適用於「開放註冊 + 免費」的本案**。若未來本專案改為「由縣市教育處統一採購、逐校開通、有預算」的模式，B 會重新變成強力候選（庫層隔離對教育資料的稽核說服力遠高於 rules 隔離）。

方案 C（專案 per-tenant）唯一的吸引力是「每校各自享有一份免費額度」，這確實能規避 §7 的配額共享問題。但它把「開通一所學校」變成「開一個 Firebase 專案 + 設定 Auth + 授權網域 + 部署規則」的人工流程，且使用者跨校（例如借調教師）無法共用同一組登入。**若未來規模成長到讀取配額成本變成主要痛點（§7 顯示要到 50 校以上才有這種壓力，而彼時月費也才十幾美元），再回頭評估 C，屆時真正的取捨會是「人工開通成本 vs. 每月十幾美元」，答案很可能仍是留在 A。**

---

## 3. 校際隔離的 Security Rules 設計

### 3.1 現況的破口

現行 `firestore.rules` 已經把路徑參數化為 `match /schools/{schoolId}`（`firestore.rules:119`），`isDirector(schoolId)` / `isApprover(schoolId)` 也都以 schoolId 為參數（`firestore.rules:76-95`）—— **寫入面的多租戶基礎是穩固的**，因為所有寫入規則最終都會經過 `myTeacherId(schoolId)`／`isDirector(schoolId)`，而這兩者都以「該校底下的 userMappings/{uid} 是否存在」為起點（`firestore.rules:53-56`）。

問題全在**讀取面**：

| 位置 | 現行規則 | 後果 |
|---|---|---|
| `firestore.rules:121` | `schools/{schoolId}` 根文件 `allow read: if isSignedIn()` | 任何登入者可探測任一學校是否存在 |
| `firestore.rules:127` | `config/{docId}` `allow read: if isSignedIn()` | **任何登入者可讀任一學校的 `initialAdminEmails`** —— 主任 email 清單外洩，且是提權攻擊的偵察起點 |
| `firestore.rules:135` | `teachers/{teacherId}` `allow read: if isSignedIn()` | 任何登入者可撈出他校全體教師姓名、email、角色 |
| `firestore.rules:178` | `data/{docId}`（全校課表）`allow read: if isSignedIn()` | 任何登入者可下載他校完整課表 |
| `firestore.rules:185` | `substituteRecords/{recordId}` `allow read: if isSignedIn()` | 任何登入者可讀他校全部調代課紀錄（父文件層。敏感的假別/事由已在 Phase 6 私有化到 `private/detail`，該子文件有 `allowedTeacherIds` 保護，`firestore.rules:223`） |
| `firestore.rules:240` | `pendingRequests/{reqId}` `allow read: if isSignedIn()` | 同上 |
| `firestore.rules:363` | `operationLogs` `allow create: if isSignedIn()`（僅欄位驗證） | 任何登入者可對任一學校的稽核軌跡灌入偽造日誌，且規則禁止 update/delete（`firestore.rules:370`）＝**永久污染** |

**這不是「多租戶未來才要修」的問題。現在就已經是洞** —— 只是目前只有 `inhu` 一校、且註冊未開放，實際可被利用的範圍受限於「已被建立教師檔的人」。一旦開放註冊，任何人註冊任一學校即可讀取所有學校的全部資料。

### 3.2 補上成員資格檢查

純前端無法用 custom claims 帶租戶身分（custom claims 只能由具特權的伺服器環境經 Admin SDK 設定，用戶端無法自行設定 [C13]；即使走 Identity Toolkit 的 `accounts:update` REST endpoint，也需要專案層 Editor 以上的 OAuth 憑證 [S07][S08]，放進前端等同外洩專案管理權）。因此只剩官方支援的「成員文件 + rules `get()/exists()`」模式 [C10]。

本專案的幸運之處是**成員文件已經存在且已有防提權約束**：`schools/{id}/userMappings/{uid}` 的自建規則要求 `linkedTeacherId` 指向的教師檔 email 必須等於本人登入 email（`firestore.rules:384-391`）。因此 `exists(userMappings/{uid})` 就是可信的成員憑證，不需新增任何資料結構。

新增 helper：

```javascript
// 放在 firestore.rules 的 helpers 區（建議接在 mappingExists 之後，約第 56 行後）
// 「該 uid 在該校有一份合法的 userMappings 文件」＝ 該校成員。
// userMappings 的自建規則（rules:384-391）已保證 linkedTeacherId 只能指向
// email == 本人登入 email 的教師檔，故此檢查不可偽造。
function isMember(schoolId) {
  return mappingExists(schoolId);
}

// 首登尚未綁定者的例外：白名單初始主任。isInitialDirector 內部用 get() 讀 config，
// 規則內的 get() 不受 read 規則限制，因此收緊 config 的 read 不會讓白名單失效。
function isMemberOrBootstrapDirector(schoolId) {
  return isMember(schoolId) || isInitialDirector(schoolId);
}
```

### 3.3 逐條修改清單

| # | 行號 | 現行 | 改為 | 說明 |
|---|---|---|---|---|
| R1 | `rules:121` | `allow read: if isSignedIn();` | `allow read: if isMember(schoolId);` | 學校選單另走 §3.5 的公開目錄集合 |
| R2 | `rules:127` | `allow read: if isSignedIn();` | `allow read: if isMemberOrBootstrapDirector(schoolId);` | 白名單主任首登仍讀得到（`isInitialDirector` 用規則內 `get()`，繞過 read 規則） |
| R3 | `rules:135` | `allow read: if isSignedIn();` | `allow read: if isMember(schoolId);` | ⚠️ 會打斷首登教師的 email 配對，配套見 §3.4 |
| R4 | `rules:178` | `allow read: if isSignedIn();` | `allow read: if isMember(schoolId);` | 課表 |
| R5 | `rules:185` | `allow read: if isSignedIn();` | `allow read: if isMember(schoolId);` | 校內全員可讀父文件維持不變（敏感欄位已私有化） |
| R6 | `rules:240` | `allow read: if isSignedIn();` | `allow read: if isMember(schoolId);` | |
| R7 | `rules:363` | `allow create: if isSignedIn() && <欄位驗證>` | `allow create: if isMember(schoolId) && <欄位驗證>` | ⚠️ 會打斷 `login_denied` 日誌（綁定前寫入），配套見 §3.4 |
| R8 | `rules:379` | `allow read: if isSignedIn() && (request.auth.uid == uid \|\| isApprover(schoolId));` | 不變 | 已正確：只能讀自己或 approver 讀全部 |
| R9 | `rules:400-402` | `match /users/{uid}/{document=**}` | 不變 | V1 遺留路徑以 uid 隔離，對租戶無感知但不構成跨校風險 |

### 3.4 兩個必須同步處理的配套

**(a) 首登教師的 email 配對（R3 的代價）**

現行 `authGuardV2.js:52-107` 的 `resolveIdentity` 流程：白名單 → 自動建 director；否則**讀 teachers 集合以 email 配對** → 配不到則 `login_denied`。R3 一收緊，尚無 mapping 的新教師讀不到 teachers，配對就斷了。

解法：新增一個**只能讀自己那一份**的 email 索引集合。

```javascript
// schools/{schoolId}/emailIndex/{emailKey}   emailKey = 登入 email（小寫）
// 文件內容只有 { teacherId: "..." }，不含姓名或其他個資
match /emailIndex/{emailKey} {
  // 只允許 get（單文件讀），不允許 list（集合查詢）——避免被整包撈走
  allow get:    if isSignedIn() && emailKey == userEmail();
  allow list:   if isApprover(schoolId);
  allow write:  if isDirector(schoolId);
}
```

前端改動：`resolveIdentity` 的配對步驟從「讀 teachers 集合找 email」改為「`getDoc(emailIndex/{我的email})` 拿 teacherId」，拿到後照原流程建 `userMappings`（該規則會再驗一次 email 相符，`firestore.rules:389-390`，雙重保險）。教師管理頁在建立／刪除／改 email 教師時，同步維護 `emailIndex`（一次寫入，成本可忽略）。

> ⚠️ 注意 Firestore 規則中 `get` 與 `list` 是可分開授權的；只給 `get` 才能達成「只能查自己」。若寫成 `allow read`（＝ get + list），攻擊者可用一次集合查詢撈走全部 email → teacherId 對照表。

**(b) `login_denied` 日誌（R7 的代價）**

`login_denied` 依定義發生在「使用者不是任何學校的成員」時，永遠不可能通過 `isMember`。解法：把這一類「綁定前」事件從校內 `operationLogs` 搬到平台層集合：

```javascript
// 頂層：authDenials/{uid}——只能寫自己的、只能新增不能改
match /authDenials/{uid} {
  allow read:   if false;              // 只給離線腳本／平台管理者用 gcloud 查
  allow create: if isSignedIn() && request.auth.uid == uid;
  allow update, delete: if false;
}
```

代價：主任在 V2 日誌頁看不到「有人嘗試登入被拒」。若此功能對主任有價值，替代設計是保留在校內但改為 `schools/{id}/joinAttempts/{uid}`（doc id 綁 uid，一人一份、可覆寫，天然限制了灌爆量）：

```javascript
match /joinAttempts/{uid} {
  allow read:   if isApprover(schoolId);
  allow create, update: if isSignedIn() && request.auth.uid == uid
                        && request.resource.data.keys().hasOnly(['email','attemptedAt','reason']);
  allow delete: if isDirector(schoolId);
}
```
這個設計把「任意灌入 N 筆」降級成「每個帳號最多佔一份文件」，是可接受的。

### 3.5 學校目錄（開放註冊必要）

使用者要能在登入頁選學校，就必須能列出學校 —— 但不該因此讓 `schools/{id}` 的所有內容可讀。獨立一個只含公開欄位的頂層集合：

```javascript
// 頂層：schoolDirectory/{schoolId}  { name, city, status: 'active'|'pending'|'suspended' }
match /schoolDirectory/{schoolId} {
  allow read:  if isSignedIn();          // 只有校名，無成員資料
  allow write: if isPlatformAdmin();     // 見 §4.3
}
```

### 3.6 `get()`/`exists()` 的次數上限與計費影響

**上限**：每次規則評估的文件存取呼叫（`get()`/`exists()`/`getAfter()`）硬上限為**單文件請求與查詢請求 10 次、多文件讀取／交易／批次寫入 20 次（且批次內每個操作仍各自受 10 次限制）**，超過即回傳 permission denied [C07][C11]。

**現行權限鏈的實際消耗**（依 `firestore.rules:37-89` 的呼叫圖，推估）：

| 路徑 | 呼叫序列 | 存取呼叫數 | 相異文件數 |
|---|---|---|---|
| `isInitialDirector` | `configExists` + `configDoc` | 2 | 1（`config/main`） |
| `myTeacherId` | `mappingExists` + `myMapping` | 2 | 1（`userMappings/{uid}`） |
| `myTeacherExists` + `myTeacherDoc` | 上列 2 + `exists(teachers)` + `get(teachers)` | 4 | 2 |
| `isDirector` / `isApprover` 完整評估（最壞） | 上列全部 | **6** | **3** |
| `userMappings` 自建（`rules:384-391`） | `isDirector` 6 + `exists(teachers)` + `get(teachers)` | **8** | 4 |

**結論一（上限）**：最壞路徑 8 次，仍在單文件請求的 10 次上限內，**但只剩 2 次餘裕**。加上 `isMember(schoolId)` 是**零額外呼叫**（它就是 `mappingExists`，已在鏈上），這點很關鍵 —— §3.3 的七條修改對呼叫次數的影響是 0 到 +1（僅 R4/R5/R6 這些原本純 `isSignedIn()` 的路徑會新增 1 次 `exists`）。

**結論二（不要再加深規則）**：§5 若採「學期唯讀鎖」（寫入時檢查 `semesterId == config.currentSemester`），會在寫入路徑上新增一次 `configDoc()` 呼叫。由於 `userMappings` 的建立路徑已經用到 8 次，**學期鎖絕對不能加在 `userMappings` 或任何已達 8 次的路徑上**，只能加在 `substituteRecords` 的 create/update（該路徑 approver 檢查後約 6 次，+2 = 8，仍安全）。建議在規則檔頂端加一行註解記錄這個預算表。

**結論三（計費）**：`get()/exists()` 每次呼叫都執行一次資料庫讀取並計費，**即使請求最終被規則拒絕也照樣收費** [C12]。但同一份文件在同一請求中被重複引用只計一次讀 [C12 的查證附註：`You are only charged one read per dependent document even if your rules refer to that document more than once`]，且部分被快取的呼叫不計入 10 次上限 [S09]。

因此成本應以**相異文件數**而非呼叫數計：一般讀取請求 ≈ 3 個相異文件（config／userMappings／teachers）= 3 次額外計費讀。這個數字直接進 §7 的成本模型。

> 這也帶出一個成本上的正面結論：§5 提議的「學期唯讀鎖」讀的是 `config/main`，而 `config/main` 在同一請求中已被 `isInitialDirector` 讀過 → **學期鎖的計費成本為 0**。

---

## 4. 開放註冊的誠實風險評估

### 4.1 純前端能做到什麼

| 防線 | 可行性 | 說明 |
|---|---|---|
| 強制 email 驗證 | ✅ 可行 | 規則可檢查 `request.auth.token.email_verified == true`。Spark 方案下地址驗證信額度為每日 1,000 封 [S11]，對 20-50 校的註冊量綽綽有餘。 |
| ⚠️ email link（magic link）登入 | ❌ 不可行 | Spark 方案的 email link 登入信**每日只有 5 封** [S11]。註冊流程不能依賴 magic link。 |
| App Check | ✅ 可行且應該做 | App Check 官方支援清單明確包含 Cloud Firestore（純前端 SPA 直連 Firestore 適用）[C15]；Web 端 provider 為 reCAPTCHA Enterprise / reCAPTCHA v3，其中 reCAPTCHA Enterprise 每月 10,000 次評估免費 [C14]。 |
| Rules 層寫入節流 | ⚠️ 部分可行 | 可用「文件內存 `lastUpdate` 伺服器時間戳 + `request.time >= resource.data.lastUpdate + duration.value(1,'s')`」限制寫入頻率 [S13]，並以 `request.resource.data.lastUpdate == request.time` 防止用戶端偽造時間戳 [S14]。**但規則本身無法修改資料**，節流狀態必須由用戶端自己寫入正確值，規則只負責拒絕 [S15]。 |
| 一人一校限制 | ✅ 可行 | 見 §4.2 的 `schoolOwners/{uid}` 設計。 |
| 平台層帳號建立速率 | ✅ 內建 | Firebase Auth 內建每個 IP 位址每小時最多建立 100 個新帳號 [S16]。這是唯一不用自己寫的平台級防線。 |

### 4.2 全自助建校的規則設計（若採此變體）

```javascript
// ---- 頂層 helper ----
function verifiedUser() {
  return isSignedIn() && request.auth.token.email_verified == true;
}

// ---- 一人一校的硬約束：schoolOwners/{uid} 只能 create，不能 update/delete ----
match /schoolOwners/{uid} {
  allow read:   if isSignedIn() && request.auth.uid == uid;
  allow create: if verifiedUser() && request.auth.uid == uid
                && request.resource.data.keys().hasOnly(['schoolId','createdAt']);
  allow update, delete: if false;      // 建過就不能再建第二所
}

// ---- 建校 ----
match /schools/{schoolId} {
  allow create: if verifiedUser()
                // schoolId 必須等於自己的 uid，杜絕搶註冊「taipei-xxjh」這類可辨識 ID 冒名他校
                && schoolId == request.auth.uid
                && !exists(/databases/$(database)/documents/schoolOwners/$(request.auth.uid))
                && request.resource.data.keys().hasOnly(['name','createdBy','createdAt'])
                && request.resource.data.createdBy == request.auth.uid;
  // ...其餘規則同 §3.3
}
```

**必須用 batched write 一次完成**：`schools/{id}` + `config/main`（含 `initialAdminEmails: [自己]`）+ `teachers/{me}`（role: director）+ `userMappings/{uid}` + `emailIndex/{我的email}` + `schoolOwners/{uid}` = 6 個操作。批次上限是 20 次文件存取呼叫、且每個操作各自不得超過 10 次 [C07][C11] —— 上述每個操作的規則各需 0-1 次 `exists`，總計約 3-4 次，安全。

**schoolId 用 uid 的取捨**：優點是杜絕搶註冊與冒名（沒人能註冊 `taipei-datong-jh` 然後假裝是大同國中）；缺點是路徑不可讀、且日後若要把學校轉移給別人會很尷尬。折衷：`schoolId` 用隨機 UUID，真正的校名存在 `schoolDirectory/{schoolId}.name`，由平台管理者審核後才把 `status` 改為 `active`（也就是自然滑向 §4.4 的變體 B）。

### 4.3 平台管理者（跨校身分）的表示法

純前端無 custom claims [C13]，平台管理者也只能用文件表示：

```javascript
function isPlatformAdmin() {
  return isSignedIn()
    && exists(/databases/$(database)/documents/platformAdmins/$(request.auth.uid));
}

match /platformAdmins/{uid} {
  allow read:   if isSignedIn() && request.auth.uid == uid;
  allow write:  if false;    // 只能由開發者用 gcloud / console 手動寫入
}
```

`platformAdmins` 集合完全禁止 client 寫入，只由開發者以個人 gcloud 帳號手動建立（與現行 `scripts/firestore-bootstrap-inhu.js` 的操作模式一致）。這是整套設計中唯一的信任錨點，且它的攻擊面極小（規則層寫死 `false`，沒有任何 client 路徑可寫）。

### 4.4 兩個變體的取捨

| | **變體 A：全自助** | **變體 B：自助申請 + 平台管理者審核開通**（推薦） |
|---|---|---|
| 流程 | 註冊 → 驗證 email → 立刻建校 → 開始用 | 註冊 → 驗證 email → 送出申請（寫 `schoolApplications/{uid}`）→ 平台管理者在管理頁按「開通」（其瀏覽器以 client SDK 建立 `schools/{id}` + `config` + director 教師檔）→ 通知申請人 |
| 需要後端嗎 | 否 | **否**。開通動作由平台管理者的瀏覽器執行，仍是純前端；`isPlatformAdmin()` 規則授權 |
| 垃圾學校 | 每個 verified email 一所，唯一節流是 Auth 的 100 帳號/小時/IP [S16] | 0（未審核的申請不佔用任何正式路徑） |
| 配額耗盡風險 | 高（見 §4.5） | 中（仍存在，但攻擊者必須先通過人工審核） |
| 使用者體驗 | 即時 | 有等待。但本案的真實使用者是「教務主任/教學組長」，一所學校一輩子開通一次，等一天完全可接受 |
| 開發成本 | 低 | +1 個管理頁 + 1 個申請表單 |

**推薦變體 B。** 決定性理由不是隔離（隔離兩者相同），而是 §4.5 的配額共享問題：**Spark/Blaze 的每日配額與帳單是全專案共享的，一個惡意租戶就能耗盡全平台額度。** 全自助等於把「可以合法呼叫 Firestore 的人」開放給全世界；審核制把它限縮在「經過一次人工確認的學校」。人工審核在此不是官僚，而是**唯一能限制攻擊者數量的節流閥**。

### 4.5 誠實列出：無法防禦的攻擊面

以下每一項都是**純前端 + Firestore 架構下無解**的，不要假裝有解法：

1. **合法成員的讀取配額耗盡（最嚴重）**
   任何一個已被開通的教師，可以打開 devtools 寫十行 JavaScript，用自己的合法憑證對自己學校的資料做無限次查詢。Spark 每日 50,000 次讀取 [C01][C06] 可在數分鐘內耗盡，**額度用盡後全平台所有學校一起被拒絕服務**。
   - Rules 無法防：規則能檢查「你是誰、你要動什麼資料」，但**不能計數你今天已經讀了幾次**，因為規則本身無法修改資料 [S15]，讀取計數器沒有可信的寫入點。
   - App Check 無法防：官方明言 App Check 只能擋掉部分而非全部濫用向量、不保證消除所有濫用 [C16]；且它擋的是「非本站來源」，合法使用者的合法瀏覽器完全通過。
   - Firestore 沒有內建的 server-side rate limiting，官方於 2020 年明確回覆「目前沒有實作此功能的計畫」，僅列為內部 feature request [S10][S12]。
   - 同一討論串中，回報者也直接點出 rules 層節流「只適用於很窄的寫入情境，對讀取洪水無效，而且規則本身的查表動作反而可以被用來灌爆讀取」[S17] —— 這與 [C12]（被拒的請求也照樣計費）相互印證：**攻擊者甚至不需要合法請求，發送會被拒絕的請求一樣能燒掉你的讀取額度。**

2. **偵察式的跨校探測（修補後仍殘留）**
   即使做完 §3.3 的全部修改，攻擊者仍可用「請求某校資料 → 看是被拒還是回空」來確認某個 schoolId 存在。這是低價值的資訊洩漏，但同時也是攻擊面：**每一次探測都會觸發規則的 `get()/exists()` 並計費 [C12]。**

3. **垃圾學校建立（變體 A 專屬）**
   唯一節流是 Auth 內建的每 IP 每小時 100 個新帳號 [S16]。攻擊者用 100 個 IP 即可每小時建 10,000 所學校。變體 B 可完全消除此風險。

4. **無法歸因**
   Firestore 的用量報表不會告訴你「是哪個 uid 燒掉了 40,000 次讀取」；2020 年的官方 issue 討論中也明確提到「甚至無法看出是誰在做惡意查詢」[S18]。發生攻擊時，你只會看到配額耗盡，然後手動一校一校排查。

5. **Blaze 沒有硬性支出上限**（待查證 §9-Q3）
   進入 Blaze 後，配額耗盡不再是「服務中斷」而是「帳單成長」。Google Cloud 提供預算警報，但預算警報是否能**自動停止服務**、以及在無 Cloud Functions 的情況下是否有替代的硬上限機制 —— 本次未查證。**這是進 Blaze 前必須先確認的一項。**

**風險緩解的現實建議**（做不到消除，只能降低期望損失）：
- 採變體 B（人工審核）把可攻擊者數量壓到最低。
- 啟用 App Check [C15]，reCAPTCHA Enterprise 每月 10,000 次免費 [C14]。20 校 × 40 師 × 每月 20 次 session ≈ 16,000 次（推估）已超過免費額度 → 進 Blaze 後這是額外成本項，需一併估算（待查證 §9-Q4：超過 10,000 次後的單價）。
- 對寫入路徑套用 rules 層節流 [S13][S14]（能防灌爆寫入與垃圾資料，防不了讀取）。
- 進 Blaze 後設定預算警報，並準備「一鍵把 `platformAdmins` 以外的規則全部改成 `allow read: if false` 」的緊急煞車腳本（人工，但至少存在）。

---

## 5. 學期資料模型重設計

### 5.1 現況與問題

| 現況 | 位置 | 學期化後的問題 |
|---|---|---|
| 課表是**單一文件** `schools/{id}/data/schedule`，用 `setDoc` 整份覆寫（非 merge） | `schoolDataService.js:155-159` | 換學期＝直接覆蓋，舊學期課表永久消失，歷史紀錄無從對照當時的課表 |
| 課表**無學年/學期/日期欄位** | 同上 | 無法判斷一筆歷史紀錄屬於哪一份課表 |
| `config.currentSemester` 欄位存在（bootstrap 寫入 `'114-2'`）但 **src/ 零讀取** | 死欄位 | 已有欄位可用，只是沒接上 |
| `substituteRecords` / `pendingRequests` 只有單日 `date`（`YYYY-MM-DD` 字串） | — | 只能靠日期字串反推學期，跨年度時脆弱 |
| 月結算＝**全量下載後前端 `date.startsWith('YYYY-MM')` 過濾** | `settlementCalculator.js:123-137` | 讀取量 = 全校累積紀錄數，隨保留年限線性成長 |
| V2 紀錄頁篩選＝起訖日期＋教師姓名，**純前端過濾** | — | 同上 |
| **四個訂閱在頁面載入時齊發**，其中兩個是整集合無 where/無 limit 的監聽 | `v2-app.js:2482-2505`；`schoolDataService.js:432-448` | **這是 20+ 校與 3 年保留同時撞上的共同瓶頸**（見 §7） |

### 5.2 兩案比較

| 面向 | **方案 A：欄位 + bounded query**（`substituteRecords/{id}` 加 `semesterId`） | **方案 B：學期子集合**（`semesters/{sid}/substituteRecords/{id}`） |
|---|---|---|
| 改動幅度 | 小。路徑不變，`SCHEMA_PATHS`（`schemaConstants.js:16-33`）僅需新增 schedule 路徑 | 大。所有路徑、所有規則 match 區塊、所有服務函式都要改 |
| 規則改動 | 幾乎無（只需在寫入端加學期鎖） | 需新增一層 `match /semesters/{semesterId}` 巢狀 |
| 當學期查詢 | `where('semesterId','==',cur)` + `orderBy('date','desc')` + `limit(n)`，需一個複合索引 | 路徑天然分割，不需 where |
| 跨學期統計 | ✅ 自然：`where('semesterId','in',[...])`（`in` 上限 30 值，遠超 3 年 6 學期的需求） | ❌ 需逐學期多次查詢，或用 collectionGroup |
| **collectionGroup 的多租戶陷阱** | 不涉及 | ⚠️ **這是 B 的致命傷**：`collectionGroup('substituteRecords')` 會跨越**所有學校**；規則要寫成 `match /{path=**}/substituteRecords/{id}`，此 match 同時涵蓋所有學校的同名子集合，極易誤放行。這正是 §3 好不容易補起來的隔離邊界 |
| 封存刪除 | query 出該學期 → 批次刪 | 路徑下整批刪（client SDK 無遞迴刪除，仍需逐文件刪，優勢有限） |
| 索引成本 | 需 1-2 個複合索引；每個複合索引都額外消耗儲存與寫入 CPU [S01] | 較少 |
| 學期唯讀鎖 | 寫入規則檢查 `request.resource.data.semesterId == configDoc(schoolId).currentSemester`，計費為 0（§3.6） | 規則檢查路徑上的 `semesterId` 參數，同樣廉價 |

**推薦方案 A。** 決定性理由是 collectionGroup 陷阱 —— 在一個「絕對安全隔離」是硬需求的多租戶系統裡，引入一個天然跨租戶的查詢原語是不划算的。加上方案 A 的遷移可以「加欄位 + 回填」漸進完成，而方案 B 是一次性大搬家。

### 5.3 具體結構

```
schools/{schoolId}/
  config/main                       ← currentSemester 活化為切換指標
  schedules/{semesterId}            ← 新：per-semester 課表文件（取代 data/schedule）
  data/schedule                     ← 舊：保留為「當前學期鏡像」過渡，Stage 2 完成後移除
  teachers/{teacherId}              ← 不分學期（教師名冊跨學期延續）
  emailIndex/{email}                ← 新（§3.4）
  substituteRecords/{recordId}      ← 加欄位 semesterId
    private/detail
  pendingRequests/{reqId}           ← 加欄位 semesterId
    private/detail
  operationLogs/{logId}             ← 加欄位 semesterId（供封存時分批）
  userMappings/{uid}
  stats/{semesterId}                ← 新：學期彙總文件（見 5.5）
```

`schemaConstants.js` 對應新增（示意，實際實作時 `SCHOOL_ID` 也要改為 runtime 參數，見 §8 Stage 3）：

```javascript
scheduleDocForSemester: (sid) => `schools/${SCHOOL_ID}/schedules/${sid}`,
emailIndexDoc:          (em)  => `schools/${SCHOOL_ID}/emailIndex/${em.toLowerCase()}`,
statsDoc:               (sid) => `schools/${SCHOOL_ID}/stats/${sid}`,
```

**`semesterId` 格式**：沿用 bootstrap 已寫入的 `'114-2'`（民國學年-學期）。優點是與 `settlementCalculator.js:123-137` 已有的民國→西元換算邏輯同語系；缺點是字串排序在跨百年時會失效（實務上無關）。

**課表文件大小**：正式課表約 500 entry / 75-125 KB（推估），單一文件上限 1 MiB [S02]，即使膨脹 8 倍仍安全。每學期一份文件、3 年 6 份，總計約 0.6 MB。

### 5.4 訂閱改造

| 資料 | 現行 | 改為 |
|---|---|---|
| `substituteRecords` | `onSnapshot(collection, orderBy createdAt desc)` 整集合（`schoolDataService.js:441-448`） | `onSnapshot(where semesterId == cur, orderBy date desc, limit 50)`。更早的資料以 cursor 分頁 `getDocs` 補載 |
| `pendingRequests` | 同上整集合（`schoolDataService.js:432-439`） | `onSnapshot(where semesterId == cur, where status in ['pending','pending_swap_consent','pending_approval'])`。已結案的請求不需即時監聽 |
| `schedule` | 單文件 onSnapshot（`schoolDataService.js:452-458`） | 改監聽 `schedules/{currentSemester}`，維持單文件（1 讀，成本可忽略） |
| `operationLogs` | limit 200 onSnapshot（`schoolDataService.js:460-467`），**頁面載入即發** | 改為**只有 approver 打開日誌頁時才訂閱**（lazy）。這一項單獨就省下每次 session 200 讀 |
| 歷史學期 | 不存在（全在同一集合裡被整包載入） | 一次性 `getDocs(where semesterId == 舊學期)` + 記憶體快取，key 帶 `schoolId + semesterId` |

**onSnapshot 的計費模型**（影響增量成本估算）：首次快照按查詢讀取計費，之後結果集中每有一份文件被新增或更新即計一次讀 [S19][S20]；文件因內容變更而離開結果集也計一次讀，但因刪除而離開結果集不計讀 [S21]；離線超過 30 分鐘後重連則視同全新查詢重新計費 [S20]。另外：**回傳零筆結果的查詢仍計費一次讀取** [S22] —— 所以「把查詢縮到空結果」不等於零成本。

**分頁必須用 cursor 不能用 offset**：使用 offset 時被跳過的結果仍計入讀取計費，官方建議改用 cursor 分頁 [S23]。歷史紀錄調閱頁若用 offset 翻到第 10 頁，會為前 9 頁的資料重複付費。

### 5.5 跨學期統計的查詢設計

需求：教師年度代課時數、鐘點費彙整（跨 1-2 個學期，最多跨 3 年 6 學期）。

**雙軌設計**：

1. **彙總文件（主要路徑，1 讀）**
   `schools/{id}/stats/{semesterId}` 存一份 map：`{ byTeacher: { [teacherId]: { substituteCount, swapCount, hours } }, updatedAt }`。每次紀錄成立／刪除時，由執行該操作的 approver 用 `FieldValue.increment()` 原子更新（純前端可用，不需交易）。
   - 年度報表 = 讀 2 份 stats 文件（上下學期）= **2 次讀取**，取代現行的全量下載。
   - 文件大小：100 教師 × 3 個數字 ≈ 6 KB（推估），遠低於 1 MiB 上限 [S02]。
   - 風險：`increment` 是原子的，但「刪除紀錄時要記得減回去」是應用層責任，可能漂移。因此需要軌道 2。

2. **明細重算（校正路徑，N 讀）**
   主任可在設定頁按「重算學期統計」，前端 `getDocs(where semesterId == sid)` 全量拉一次重建 stats 文件。單次成本 = 該學期紀錄數（500-3000 讀），一學期跑個一兩次完全可接受。

**建議索引**（`firestore.indexes.json`）：
```
substituteRecords: (semesterId ASC, date DESC)      ← 當學期列表 + 月結算範圍查詢
substituteRecords: (semesterId ASC, substituteTeacherId ASC, date DESC)  ← 個人時數查詢（可選）
pendingRequests:   (semesterId ASC, status ASC, createdAt DESC)
```
每個複合索引都額外消耗儲存與寫入 CPU，應只建畫面實際需要的 [S01] —— 上表第二條若統計全走 stats 彙總文件就不需要建。

### 5.6 與現有月結算／紀錄篩選的相容遷移

- **月結算**（`settlementCalculator.js:123-137`）：目前是「全量下載 → `date.startsWith('YYYY-MM')` 過濾」。改為 `where('semesterId','==',cur)` + `where('date','>=','2026-09-01')` + `where('date','<=','2026-09-31')`（字串範圍查詢，`date` 是 `YYYY-MM-DD` 字串，字典序即時間序）。民國→西元換算邏輯保留在呼叫端不動，只換資料來源。
- **V2 紀錄頁篩選**：起訖日期改為下推到 Firestore 查詢（同上複合索引）；教師姓名維持前端過濾（Firestore 不支援同一查詢中兩個欄位的範圍條件）。
- **相容期雙讀**：Stage 2 期間，`semesterId` 尚未回填的舊文件用 `where('semesterId','==',null)` 撈不到。回填腳本必須在切換查詢之前跑完（見 §8 Stage 2 的風險欄）。

---

## 6. 3 年保留與封存流程

### 6.1 學期切換 SOP（director 操作流）

```
[1] director 進入「學校設定 → 學期管理」
[2] 按「開新學期」，輸入 semesterId（如 115-1）
      → 前端 batch：建立 schedules/115-1（空殼）+ 更新 config.currentSemester = '115-1'
      → 寫 operationLog（action: 'semester_switch'）
[3] director/section_chief 上傳新學期課表 → 寫入 schedules/115-1
[4] 舊學期自動唯讀（規則層強制，見下）
[5] 前端所有訂閱重新以新 currentSemester 建立（等同現行 resetV2ViewState 的清快取流程，
    但需新增「semester 切換」維度，與 §8 Stage 3 的「school 切換」維度一起補）
```

**規則層的唯讀鎖**（加在 `firestore.rules:197` 的 `substituteRecords` create 與 `:209` 的 update）：

```javascript
function isCurrentSemester(schoolId, sid) {
  return configDoc(schoolId).currentSemester == sid;
}

// create 條件末端 AND 上：
&& isCurrentSemester(schoolId, request.resource.data.semesterId)
// update 條件末端 AND 上（同時鎖住 semesterId 本身不可被改）：
&& request.resource.data.semesterId == resource.data.semesterId
&& isCurrentSemester(schoolId, resource.data.semesterId)
```

成本：`configDoc()` 讀的 `config/main` 在同一請求中已被 `isInitialDirector` 讀過，**每個相依文件每請求只計一次讀 [C12]，故此鎖的計費成本為 0**；存取呼叫數 +1，仍在 10 次上限內（§3.6）。

**例外處理**：偶爾需要補登上學期的紀錄。建議做法是保留一個 `config.editableSemesters: ['115-1','114-2']` 陣列由 director 控制，規則改檢查 `request.resource.data.semesterId in configDoc(schoolId).editableSemesters` —— 比硬鎖 currentSemester 有彈性，成本相同。

### 6.2 期滿封存流（3 年到期）

```
[1] director 進入「學校設定 → 資料封存」，選擇要封存的學期（如 112-1）
[2] 前端全量讀取該學期：
      getDocs(substituteRecords where semesterId == '112-1')
      + 逐筆 getDoc(private/detail)         ← ⚠️ 見下方陷阱
      + getDocs(pendingRequests where semesterId == '112-1')
      + getDocs(operationLogs where semesterId == '112-1')
      + getDoc(schedules/112-1)
      + getDoc(stats/112-1)
[3] 組成單一 JSON（結構參考 app.js:4088-4104 的「匯出本機資料」，但範圍是全校）
[4] 驗證：顯示各集合筆數、產生 SHA-256 雜湊、要求使用者手動輸入筆數確認
[5] 觸發瀏覽器下載（Blob + a.download）
[6] 使用者確認「已妥善保存」後，才啟用刪除按鈕
[7] 批次刪除：writeBatch 每批 500 筆，先刪 private/detail 子文件、再刪父文件
[8] 寫入一筆不可刪的封存紀錄到 config 或 archives/{semesterId}（含筆數、雜湊、執行者、時間）
```

**陷阱一（必須寫進實作規格）**：**Firestore 刪除父文件不會刪除其子集合。** `substituteRecords/{id}/private/detail`（`firestore.rules:222-235`）若不明確刪除，會變成從 UI 完全看不見、卻永久佔用儲存的孤兒文件。步驟 [7] 的順序不可顛倒。

**陷阱二**：無效果（no-op）的刪除仍計費 —— 刪除不存在的文件一樣產生刪除費用 [S24]。重試邏輯要小心不要重複刪同一批。

**陷阱三**：3 年封存的匯出讀取量是一次性大量讀取。以大校（3000 筆/學期）為例，一次封存 = 3000（父）+ 3000（private）+ 3000（logs，推估）≈ 9,000 讀，**接近 Spark 每日 50,000 的 18%**。建議封存作業排在離峰、且一次只封存一個學期。

### 6.3 為什麼不用 TTL

| TTL 的性質 | 對本案的影響 |
|---|---|
| TTL 刪除不含免費用量，必須啟用計費（Blaze）才能使用 [C09] | Spark 階段直接不可用 |
| TTL 刪除計入一般文件刪除費用 [C19] | 成本與手動批次刪除相同，沒有省錢 |
| 資料通常在到期後 24 小時內才被刪除，且**在實際刪除前仍會出現在查詢與讀取結果中** [C17] | 無法保證「3 年整」的精準下架時點 |
| 每個 collection group 只能指定一個欄位作為 TTL 欄位 [S25] | 可接受（每個集合各一個 `expireAt` 即可） |
| TTL 刪除會觸發所有作用中的 snapshot listeners [S26] | 中性：前端會即時看到刪除，不算壞事 |
| **TTL 是「到期就刪」，不管有沒有先匯出** | ❌ **這是決定性的否決理由**：需求是「由管理者匯出成檔案封存後從雲端刪除」，順序是硬要求。TTL 無法表達「等匯出完成才刪」 |

**推薦定位**：TTL 不作為主要機制。若日後進了 Blaze，可考慮把 TTL 當作**安全網** —— 設定 `expireAt = 學期結束 + 4 年`（比保留政策多 1 年），確保即使管理者忘記封存，資料也不會無限累積。這個用法不與「匯出後刪除」衝突，因為正常流程會在 TTL 觸發前就刪掉了。

### 6.4 為什麼不用 managed export

| managed export 的性質 | 對本案的影響 |
|---|---|
| 要求 Firebase 專案必須在 Blaze 方案，Spark 無法使用 [C20] | Spark 階段不可用 |
| 輸出目的地是 Cloud Storage bucket（需另建、建議與資料庫位置相近），**不是直接下載成本機檔案** [C18] | 與需求「匯出成檔案封存」不符 —— 使用者要的是手上一份檔案，不是又一個雲端位置 |
| 每匯出一份文件計一次讀取，且**這些讀取不會顯示在 console 的用量區**，排程性匯出可能造成非預期帳單 [C21] | 對「盯著免費額度過日子」的專案是危險的隱形成本 |
| 匯出不是一致性的時間點快照，可能包含操作進行期間的變更；且匯出檔不含索引定義 [S27] | 作為法定保存的封存格式，一致性瑕疵需要在流程上補（封存前先鎖學期為唯讀，剛好 §6.1 已經有了） |

**推薦**：前端 JSON 匯出為主。現有 `scripts/firestore-backup.js`（Node CLI，綁開發者個人 gcloud 帳號，存 REST 原始 fields，支援 `--school=` 與 `restore --yes`）**保留為離線二次備援**，在封存前由開發者跑一次，作為「使用者下載失敗」的保險。

### 6.5 operationLogs 禁刪規則與封存需求的衝突

現行 `firestore.rules:370`：`allow update, delete: if false;`（稽核軌跡不可改／刪）。這與「期滿刪除」直接衝突，且 operationLogs 只增不減、無節流，是儲存量的主要來源之一（§7）。

三個解法：

| 解法 | 做法 | 評價 |
|---|---|---|
| (a) 放寬規則 | 改為 `allow delete: if isDirector(schoolId) && resource.data.semesterId != configDoc(schoolId).currentSemester` | ❌ 破壞稽核軌跡的核心性質。有刪除權的 director 正是最需要被稽核的角色 |
| (b) 分學期子集合 + 離線刪除 | 日誌改為 `operationLogs/{semesterId}/entries/{id}`（或維持平集合 + `semesterId` 欄位），規則維持 `delete: if false`；封存時由**平台管理者用 gcloud/REST 以 owner 憑證離線刪除**（Security Rules 不適用於 Admin/REST 管理面憑證） | ✅ **推薦**。應用層永遠刪不了日誌（稽核性質保留），刪除權綁在需要 gcloud 憑證的離線流程上，與 `platformAdmins` 的信任錨點一致 |
| (c) 日誌不封存 | 3 年後只刪 records，日誌永久保留 | ⚠️ 儲存會無限成長（§7 顯示大校日誌 3 年約 21 MB，50 校即 1 GB），且與「期滿刪除」的政策承諾不符 |

**推薦 (b)**，並在封存 UI 明確告知 director：「操作日誌需由系統管理者另行清除，您的匯出檔已包含完整日誌」。

---

## 7. 成本試算

### 7.1 假設表

| 代號 | 假設 | 值 | 來源／依據 |
|---|---|---|---|
| A1 | Spark 免費額度 | 儲存 1 GiB／每日 50,000 讀／20,000 寫／20,000 刪／每月 10 GiB 傳出 | **已查證** [C01][C06]。每日配額於太平洋時間午夜重置 |
| A2 | 免費額度適用範圍 | 每專案僅一個資料庫 | **已查證** [C05][C08] |
| A3 | Blaze 單價（nam5 北美多區域） | 讀 $0.06/100K、寫 $0.18/100K、刪 $0.02/100K、儲存 $0.18/GiB/月、傳出 $0.12/GB | **已查證**（官方計價範例頁，見 §10 附錄 C）。⚠️ **本專案若部署在 asia-east1，單價不同（待查證 §9-Q1）**；本表數字僅供量級判斷 |
| A4 | 每校教師數 | 小校 30／大校 100／平均 40（20 校情境）、50（50 校情境） | 推估。現有 `inhu` 正式教師 30 位 |
| A5 | 每校每學期紀錄數 | 小校 500／大校 3,000 | 依需求給定 |
| A6 | 保留期 | 3 年 = 6 學期 | 依需求給定 |
| A7 | 每筆 substituteRecord 大小 | 父文件 0.7 KB（19-20 欄位）+ private/detail 0.25 KB（4 欄位）≈ 0.95 KB | 推估 |
| A8 | 每筆 operationLog 大小 / 產生率 | 0.4 KB；每筆紀錄約產生 3 筆日誌（建立/同意/核准） | 推估 |
| A9 | 課表文件 | 100 KB × 6 學期 | 推估（500 entry / 75-125 KB） |
| A10 | 每位教師每日 session 數 | 1.5（工作日） | 推估 |
| A11 | 規則權限鏈的計費讀取 | 每個請求 3 個相異文件（config／userMappings／teachers） | 推估，依 §3.6 的呼叫圖分析；計費以相異文件計 [C12] |
| A12 | 每校每日資料變更量 | 30 筆（含 record + private + log 的寫入） | 推估 |

### 7.2 儲存試算

每校每學期：
- 紀錄：`500 × 0.95 KB = 475 KB`（小校）／`3,000 × 0.95 KB = 2.85 MB`（大校）
- 日誌：`500 × 3 × 0.4 KB = 600 KB`（小校）／`3,000 × 3 × 0.4 KB = 3.6 MB`（大校）
- 課表：100 KB

每校 3 年（6 學期）總計：

| | 小校（30 師/500 筆） | 大校（100 師/3000 筆） |
|---|---|---|
| 紀錄 | 2.85 MB | 17.1 MB |
| 日誌 | 3.6 MB | 21.6 MB |
| 課表 | 0.6 MB | 0.6 MB |
| 教師/mapping/stats | 0.05 MB | 0.15 MB |
| **合計** | **≈ 7.1 MB** | **≈ 39.5 MB** |

| 情境 | 總儲存 | vs. Spark 1 GiB |
|---|---|---|
| 20 校（半小半大，平均 23 MB） | ≈ 460 MB | ✅ 46%，安全 |
| 50 校（平均 23 MB） | ≈ 1.15 GB | ❌ 超出約 15%，Blaze 費用 `0.15 GB × $0.18 = $0.03/月` |
| 全大校情境的臨界點 | — | `1,073 MB ÷ 39.5 MB ≈ 27 校` |
| 混合情境的臨界點 | — | `1,073 MB ÷ 23 MB ≈ 46 校` |

**結論：儲存不是瓶頸。** 即使 50 校也只超出 0.15 GB，月費 3 美分。日誌佔了總儲存的約 half —— 若 §6.5 採解法 (c)（日誌不封存），50 校 3 年後日誌單項就約 540 MB，仍在可控範圍，但長期會成為主要成本項。

### 7.3 讀取試算（決定性）

**每 session 讀取量（現行全量訂閱模式）**：

```
substituteRecords 整集合監聽 = 該校累積紀錄總數 N
pendingRequests   整集合監聽 = 未結案 + 已結案全部 ≈ 0.3 N（推估）
schedule          單文件      = 1
operationLogs     limit 200   = 200
規則權限鏈        4 個訂閱 + 若干 getDoc ≈ 6 個請求 × 3 相異文件 = 18
──────────────────────────────────────────────
每 session ≈ 1.3 N + 219
```

**每 session 讀取量（bounded query 改造後）**：

```
substituteRecords  where semesterId==cur, limit 50   = 50
  + 增量推播（該 session 期間他人的新增/更新）      ≈ 20（推估，A12 的 30 筆分攤）
pendingRequests    where semesterId==cur, status in  = 20（推估）
schedule           單文件                            = 1
operationLogs      lazy（只有 approver 開日誌頁）    ≈ 0（平均攤提後 <1）
規則權限鏈         4 個請求 × 3 相異文件             = 12
──────────────────────────────────────────────
每 session ≈ 103
```

**現況（inhu 單校 30 師）的實際處境**：

```
N（當前累積紀錄）≈ 500
每 session = 1.3 × 500 + 219 = 869 讀
每日 sessions = 30 × 1.5 = 45
每日讀取 = 45 × 869 ≈ 39,000  →  Spark 50,000 的 78%
```

> ⚠️ **這是本報告最急迫的發現：現況單校就已用掉每日讀取額度的約八成（推估）。**
> 臨界紀錄數：`50,000 ÷ 45 = 1,111 讀/session 預算`，扣掉固定的 219，`(1,111 − 219) ÷ 1.3 ≈ 686 筆`。
> **也就是說：`inhu` 累積到約 700 筆紀錄時，單校、單學期、還沒開始多租戶，就會撞到 Spark 每日讀取上限。**
> 由於現行設計沒有任何清理機制（換學期只覆蓋課表，紀錄不刪），這一天是必然會到的。
> §8 Stage 1（讀取止血）因此不是「為多租戶做準備」，而是**現行單校系統的存續問題**。

**多校情境**：

| 情境 | sessions/日 | 現行模式 讀/日 | bounded 模式 讀/日 |
|---|---|---|---|
| 20 校 × 40 師 | 1,200 | 1,200 × (1.3×4,800+219) ≈ **7.7 M** | 1,200 × 103 ≈ **124 K** |
| 50 校 × 50 師 | 3,750 | 3,750 × (1.3×9,000+219) ≈ **44.7 M** | 3,750 × 103 ≈ **386 K** |

（現行模式的 N 用「每校 3 年累積紀錄數」：20 校情境取平均 800 筆/學期 × 6 = 4,800；50 校情境取 1,500 × 6 = 9,000。）

**寫入試算**：每日全平台變更 = 校數 × A12(30) × 約 3 個文件 = 20 校 1,800 寫／50 校 4,500 寫，**都遠低於每日 20,000 的免費額度** [C01]。寫入不是瓶頸。

### 7.4 費用結論與臨界點

Blaze 費用 = `(每日讀取 − 50,000) × 30 天 ÷ 100,000 × $0.06` + 儲存超額 [A3]。
（Blaze 方案仍包含 Spark 的免費用量，且該免費用量以每日為單位計算 [S28]。）

| 情境 | 現行全量訂閱模式 | bounded query 改造後 |
|---|---|---|
| **現況 1 校 30 師** | 39 K 讀/日 → **免費（餘裕 22%）** | 4.6 K 讀/日 → **免費（餘裕 91%）** |
| **20 校 × 40 師** | 7.7 M 讀/日 → 超額 7.65 M × 30 ÷ 100K × $0.06 ≈ **$138/月** | 124 K 讀/日 → 超額 74 K × 30 ÷ 100K × $0.06 ≈ **$1.3/月** |
| **50 校 × 50 師** | 44.7 M 讀/日 → ≈ **$804/月** | 386 K 讀/日 → 超額 336 K × 30 ÷ 100K × $0.06 ≈ **$6.0/月** ＋儲存 $0.03 ≈ **$6/月** |

**臨界點總表**：

| 臨界 | 現行模式 | bounded 模式 |
|---|---|---|
| 單校撞 Spark 讀取上限 | 約 **700 筆累積紀錄**（≈ 1.5 學期） | 約 **10,000 筆**（實質不會撞到；先撞的是 session 數） |
| 撞 Spark 讀取上限的校數（每校 40 師 × 1.5 session） | **不到 1 校** | `50,000 ÷ 103 ≈ 485 sessions ÷ 60 sessions/校 ≈ **8 校**` |
| 撞 Spark 儲存上限（1 GiB）的校數 | 約 46 校（混合）／27 校（全大校） | 同左（儲存與查詢模式無關） |

**最終預算判斷**：

1. **維持 Spark 的天花板是「約 8 校」（bounded 改造後），不是 20 校。** 20 校必然進 Blaze。
2. **但進 Blaze 的代價極小**：bounded 改造後，20 校約 $1.3/月、50 校約 $6/月 —— 遠低於「小額 Blaze」的容忍底線。
3. **真正的財務風險是不做改造就擴張**：同樣 20 校，改造前後差距是 **$138 vs $1.3，超過 100 倍**。50 校則是 $804 vs $6。
4. 因此 §8 的路線圖把「讀取止血」排在多租戶功能之前 —— 它同時是現況的存續問題（見 §7.3 的警告）與擴張的前提條件。
5. ⚠️ 上述所有金額基於 nam5 單價 [A3]。若部署在 asia-east1，實際單價未查證（§9-Q1）；亞太區域通常較貴，量級判斷（個位數 vs. 三位數美元）不受影響，但精確金額需重算。

---

## 8. 遷移路線圖

| Stage | 內容 | 改什麼 | 風險 | 可獨立上線 |
|---|---|---|---|---|
| **0. 成員資格隔離規則**（最高優先，**不等多租戶，現在就該修**） | §3.3 的 R1–R7 七條規則修改 + §3.4 的 `emailIndex` 集合與 `joinAttempts` 改道 | `firestore.rules`（7 處）、`authGuardV2.js:52-107`（配對邏輯改讀 emailIndex）、教師管理頁（同步維護 emailIndex）、`operationLogger`（login_denied 改道） | **中高**。若 emailIndex 未先回填就部署規則，全體新教師無法首登。**必須先跑回填腳本、再部署規則** | ✅ 是 |
| **1. 讀取成本止血** | §5.4 訂閱改造：records/pending 加 where+limit、logs 改 lazy、歷史用 getDocs+快取、分頁改 cursor | `schoolDataService.js:432-467`、`v2-app.js:2482-2505`、紀錄頁分頁 UI | **中**。行為可見（列表變成「最近 50 筆 + 載入更多」），需使用者適應。**依 §7.3，這是現況的存續問題，不是優化** | ✅ 是 |
| **2. 學期欄位化** | `config.currentSemester` 活化；新增 `schedules/{semesterId}`；三個集合加 `semesterId` 欄位並回填；月結算與篩選下推查詢；stats 彙總文件；規則加學期唯讀鎖 | `schemaConstants.js:16-33`、`schoolDataService.js:155-159`、`settlementCalculator.js:123-137`、`firestore.rules:197/209`、新增回填腳本 | **中**。回填必須先於查詢切換；相容期需容忍 `semesterId == null` 的舊文件（建議回填腳本一次跑完，不做長期雙讀） | ✅ 是（Stage 1 完成後） |
| **3. SCHOOL_ID 動態化** | `SCHOOL_ID` 從 import-time 常數（`schemaConstants.js:14`）改為 runtime 解析（登入後由 userMappings 決定）；`SCHEMA_PATHS` 全部改吃 schoolId 參數；localStorage key `'substituteSystemData'`（`legacyMigrationService.js:50`）加 schoolId 前綴；記憶體快取清除（`v2-app.js` 的 `resetV2ViewState`）新增「school 切換」維度 | `schemaConstants.js`、所有 `SCHEMA_PATHS` 呼叫端、`legacyMigrationService.js`、`v2-app.js` | **中**。App 端無散落的 `'inhu'` 字面值（全走 SCHEMA_PATHS），改動集中；但 localStorage 前綴變更需要一次性遷移，否則使用者本地資料看似消失。**必須在 Stage 0 之後做，否則等於在有洞的規則上開放多租戶** | ⚠️ 需與 Stage 4 一起上線才有意義 |
| **4. 多租戶開通** | `schoolDirectory` / `schoolApplications` / `platformAdmins` 集合與規則（§4.2-4.4）；平台管理者審核頁；建校 batch；App Check 接入；`email_verified` 強制 | `firestore.rules`、新增管理頁、新增申請頁、`index.html`（App Check SDK） | **高**。**決策點：此階段起必然進 Blaze**（§7.4）。上線前必須先確認 §9-Q3（Blaze 支出上限機制） | ✅ 是（Stage 0+3 完成後） |
| **5. 封存與生命週期工具** | 全校 JSON 匯出頁（§6.2）、批次刪除（含 private 子文件）、封存紀錄；operationLogs 的離線清理腳本（§6.5 解法 b） | 新增設定頁分頁、擴充 `scripts/firestore-backup.js` | **中**。刪除是不可逆操作，UI 必須有筆數確認 + 雜湊驗證 + 二次確認。**private 子文件的刪除順序是實作規格的硬要求** | ✅ 是（Stage 2 完成後） |

**建議順序**：0 → 1 →（此時單校系統已健康且安全）→ 2 → 5 →（此時學期生命週期完整）→ 3 → 4。

把多租戶（3、4）排到最後，是因為 0/1/2/5 對「現在只有一所學校」的使用者也全部有價值，且每一階段都能獨立驗收；而 3/4 在沒有第二所學校之前是純負債。

---

## 9. 開放問題與後續研究

本次 deep-research workflow 因 session limit 中斷，以下項目**未完成查證**，不得作為決策依據：

| 編號 | 待查證項目 | 為何重要 | 建議查證來源 |
|---|---|---|---|
| **Q1** | Firestore 在 **asia-east1（台灣）** 的讀/寫/刪/儲存單價 | §7.4 的所有金額基於 nam5 單價。若本專案資料庫位於亞太區，實際費用需重算 | `cloud.google.com/firestore/pricing` 的區域價目表（本次 WebFetch 三次皆回傳截斷內容，價目表未能擷取；研究階段的來源代理也記錄了同一問題） |
| **Q2** | Firestore 資料庫的**實際部署區域** | 同上，且影響是否需考慮跨區傳輸 | 查 Firebase console 或 `firebase.json` |
| **Q3** | **Blaze 是否有硬性支出上限機制**（預算警報能否自動停用服務；無 Cloud Functions 時的替代方案） | §4.5 風險 5：進 Blaze 後配額耗盡從「服務中斷」變成「帳單成長」。這是進 Blaze 的前置條件 | `cloud.google.com/billing/docs/how-to/budgets`；需確認「無 Cloud Functions 時是否存在自動斷流手段」 |
| **Q4** | reCAPTCHA Enterprise **超過每月 10,000 次免費評估後的單價** | §4.5 估算 20 校即會超過免費額度，需納入成本 | `cloud.google.com/recaptcha/docs/billing-information`（[C14] 的查證附註提到 2024 後定價變更，但未列入正式主張） |
| **Q5** | **Identity Platform 多租戶（tenant）** 的費用與是否適用本案 | 研究階段有兩條相關主張 [S29][S30]（需在 GCP console 啟用 tenants；tenantId 在頁面重載後不保留），但**皆未經對抗查證**，且費用未知。若 Identity Platform 的 tenant 機制能在純前端提供更強的隔離，值得重新評估 §2 的選型 | `cloud.google.com/identity-platform/docs/multi-tenancy` + 定價頁 |
| **Q6** | onSnapshot 增量推播的**實際讀取量測量** | §7.3 的「每 session 增量 ≈ 20 讀」是推估（A12 分攤），未實測。這是 bounded 模式成本模型中最不確定的一項 | 在 Firebase console 的用量頁做 A/B 觀測，或用 Firestore 的 usage 分解 |
| **Q7** | 一條在對抗查證中**被 3-0 推翻**的主張已修正並記錄於 §2.2，但其連帶影響（是否還有其他文件沿用「免費額度僅適用 `(default)`」的舊說法）未全面盤查 | 避免舊說法被複製到其他技術文件 | 專案內文件全文檢索 |

另外，本次 workflow 共產出 97 條研究階段主張，其中僅 22 條進入對抗查證階段（21 條確認、1 條推翻）。**其餘 75 條僅有單一來源、未經三方查證**，本報告引用時已一律標為 `[S##]`。若後續要把本報告升級為正式技術決策文件，建議至少補查證下列高影響的 S 類主張：`[S10][S12]`（Firestore 無內建 rate limiting，來源為 2020 年的 GitHub issue，**距今 6 年，可能已過時**）、`[S11]`（Spark 的 email 額度，直接影響開放註冊可行性）、`[S16]`（每 IP 每小時 100 帳號，是唯一的平台級節流）。

> ⚠️ 特別註記：`[S10][S12][S17][S18]` 均來自 2020 年 4 月的同一份 GitHub issue 討論串。**「Firestore 至今仍無內建 server-side rate limiting」這個結論本身是 6 年前的狀態，本次未查證 2020-2026 之間是否有變化。** §4.5 的風險評估建立在此假設上，若此假設已失效，開放註冊的風險評估需要重寫。這是本報告最重要的單一不確定性。

---

## 10. 附錄

### 附錄 A：已通過 3-0 對抗式查證的主張（21 條）

| 編號 | 主張 | 來源 |
|---|---|---|
| C01 | Firestore 免費額度（每日重置）：儲存 1 GiB、每日 50,000 讀、20,000 寫、20,000 刪、每月 10 GiB 傳出 | https://cloud.google.com/firestore/pricing ・ 原文：`Stored data: "1 GiB"; Document reads: "50,000 per day"; Document writes: "20,000 per day"; Document deletes: "20,000 per day"; Outbound data transfer: "10 GiB per month"` |
| C02 | 建立／設定／刪除／複製資料庫需 `Cloud Datastore Owner (roles/datastore.owner)` 等 IAM 權限，屬 GCP 管理面操作，無 client SDK 路徑 | https://firebase.google.com/docs/firestore/manage-databases ・ `Required IAM role: Cloud Datastore Owner (roles/datastore.owner) with specific permissions for creating, reading, configuring, deleting, and cloning databases` |
| C03 | Firestore Multiple Databases 於 2024-02-06 GA，Google Cloud console、Terraform 與所有 Firestore SDK 完整支援 | https://cloud.google.com/blog/products/databases/firestore-multiple-databases-is-now-generally-available |
| C04 | 官方認可多資料庫的使用情境包含隔離客戶資料 | https://firebase.google.com/docs/firestore/manage-databases ・ `You can use multiple databases to set up production and testing environments, to isolate customer data, and for data regionalization.` |
| C05 | 每專案只有一個資料庫享免費額度（第一個建立的，不限 ID 是否為 `(default)`）；其餘全額計價；要建額外資料庫必須升級計費方案 | https://cloud.google.com/firestore/pricing ・ `Cloud Firestore allows exactly one free database per project. ... The first database you create (regardless of its ID) qualifies for the free quota. ... All subsequent database will be charged on usage incurred on those databases.` |
| C06 | Firestore Standard edition 免費額度：1 GiB／50,000 讀／20,000 寫／20,000 刪／每月 10 GiB 傳出 | https://docs.cloud.google.com/firestore/quotas |
| C07 | Rules 中 `get()/exists()/getAfter()` 每請求上限：單文件請求與查詢請求 10 次；多文件讀取／交易／批次寫入 20 次（每個操作仍受 10 次限制） | https://docs.cloud.google.com/firestore/quotas |
| C08 | 免費額度只適用每專案一個資料庫 | https://docs.cloud.google.com/firestore/quotas ・ `The free tier applies to only one Firestore database per project.` |
| C09 | TTL 刪除不含免費用量，必須啟用計費 | https://cloud.google.com/firestore/pricing ・ `The following operations and features don't include free usage... TTL deletes.` |
| C10 | Rules 可用 `get()`/`exists()` 讀取其他文件評估請求（純前端實作成員資格檢查的官方支援模式） | https://firebase.google.com/docs/firestore/security/rules-conditions ・ `Using the get() and exists() functions, your security rules can evaluate incoming requests against other documents in the database.` |
| C11 | 每次規則評估的文件存取呼叫硬上限 10／20，超過即 permission denied | https://firebase.google.com/docs/firestore/security/rules-conditions |
| C12 | `get()/exists()` 每次呼叫都執行讀取並計費，**即使請求被拒也照樣收費**；同一相依文件每請求只計一次讀 | https://firebase.google.com/docs/firestore/security/rules-conditions ・ `Using these functions executes a read operation in your database, which means you will be billed for reading documents even if your rules reject the request.` ＋ https://firebase.google.com/docs/firestore/pricing ・ `You are only charged one read per dependent document even if your rules refer to that document more than once.` |
| C13 | Custom claims 只能由具特權的伺服器環境經 Admin SDK 設定，用戶端無法自行設定 | https://firebase.google.com/docs/auth/admin/custom-claims |
| C14 | Web App Check provider 為 reCAPTCHA Enterprise 與 reCAPTCHA v3；reCAPTCHA Enterprise 每月 10,000 次評估免費 | https://firebase.google.com/docs/app-check ・ `reCAPTCHA Enterprise is no-cost for 10,000 assessments each month, and has a cost beyond that.` |
| C15 | App Check 支援服務包含 Cloud Firestore、Realtime Database、Cloud Storage、Firebase Auth（Preview）、callable Cloud Functions | https://firebase.google.com/docs/app-check |
| C16 | App Check 官方明言只能阻擋部分而非全部濫用向量，不保證消除所有濫用 | https://firebase.google.com/docs/app-check ・ `App Check prevents some, but not all, abuse vectors directed towards your backends ... using App Check does not guarantee the elimination of all abuse.` |
| C17 | TTL 到期後非即時刪除：通常在到期後 24 小時內刪除，且**刪除前仍會出現在查詢與讀取結果中** | https://firebase.google.com/docs/firestore/ttl |
| C18 | Managed export 的輸出目的地是 Cloud Storage bucket（需另建），非直接下載成本機檔案 | https://firebase.google.com/docs/firestore/manage-data/export-import |
| C19 | TTL 刪除計入一般文件刪除費用 | https://firebase.google.com/docs/firestore/ttl ・ `TTL delete operations count towards your document delete costs.` |
| C20 | Managed export/import 要求專案必須在 Blaze 方案，Spark 無法使用 | https://firebase.google.com/docs/firestore/manage-data/export-import ・ `Firebase projects must be on the Blaze plan to use the managed export and import service.` |
| C21 | Managed export 每匯出一份文件計一次讀取，且這些讀取不會顯示在 console 用量區，排程匯出可能造成非預期帳單 | https://firebase.google.com/docs/firestore/manage-data/export-import |

**被 3-0 推翻的主張（1 條）**：「免費額度僅適用於資源名稱為 `(default)` 的資料庫」—— 現行官方文件為「第一個建立的資料庫（不論 ID）」，見 C05／C08。

### 附錄 B：單一來源、未經對抗查證的主張

| 編號 | 主張 | 來源 |
|---|---|---|
| S01 | 每個複合索引都額外消耗儲存空間與寫入 CPU，應只建畫面實際需要的 | Firebase 多租戶建模實務文章（blog 級來源） |
| S02 | 單一文件大小上限 1 MiB、每文件索引項目上限 40,000；每專案資料庫數上限 100（可申請提高）；每資料庫 TTL 設定上限 1,000 | https://docs.cloud.google.com/firestore/quotas |
| S03 | 各 Firestore 資料庫效能獨立隔離，單庫 hotspot 不影響同專案其他資料庫；提供 per-database 帳單細分 | https://cloud.google.com/blog/products/databases/firestore-multiple-databases-is-now-generally-available |
| S04 | 可透過 IAM conditions 對個別資料庫套用不同存取政策（作用於 GCP 主體層，非 client 端 Rules 層） | 同上 |
| S05 | 每個資料庫的 Security Rules 各自獨立，必須用 Firebase CLI 分別部署 | https://firebase.google.com/docs/firestore/manage-databases |
| S06 | SDK 預設連 `(default)` 資料庫；連 named database 須在建立 client 時指定 database ID | 同上 |
| S07 | 可用 Identity Toolkit 的 `accounts:update` REST endpoint 帶 `customAttributes` 設定 custom claims | Firebase 官方論壇（forum 級來源，2023-03-23） |
| S08 | 但該 endpoint 需以「在該專案上至少具 Editor 角色」的身分做 OAuth 認證，純前端無法安全執行 | 同上 |
| S09 | 部分文件存取呼叫可能被快取，被快取的呼叫不計入 10 次上限 | https://firebase.google.com/docs/firestore/security/rules-conditions |
| S10 | 截至 2020-04，Firebase 無內建的 server-side rate limiting，官方工程師確認「目前沒有實作此功能的計畫」，僅列為內部 feature request（b/135617967） | GitHub issue（forum 級，2020-04）**⚠️ 6 年前狀態，見 §9** |
| S11 | Spark 方案 email 額度：地址驗證信每日 1,000 封、密碼重設每日 150 封、**email link 登入每日僅 5 封**；Blaze 分別為 100,000／10,000／25,000 | https://firebase.google.com/docs/auth/limits |
| S12 | Firebase support 官方回覆（2020-04）：rate limiting 為內部討論中、無承諾 | 同 S10 |
| S13 | Rules 層寫入節流模式：`request.time >= resource.data.lastUpdate + duration.value(1, "s")` | smarx.com 工程文章（blog 級，2021-01-10） |
| S14 | 防偽造時間戳：用戶端寫 `FieldValue.serverTimestamp()`，rules 驗 `request.resource.data.lastUpdate == request.time` | 同上 |
| S15 | Security Rules 本身無法修改資料，節流狀態必須由用戶端寫入，rules 只負責拒絕 | 同上 |
| S16 | Firebase Auth 內建每個 IP 每小時最多建立 100 個新帳號；註冊帳號總數無上限 | https://firebase.google.com/docs/auth/limits |
| S17 | rules 層節流「只適用於很窄的寫入情境，對讀取洪水無效，且規則本身的查表動作反而可被用來灌爆讀取」 | 同 S10（issue 回報者論點） |
| S18 | 無法辨識是哪個使用者在做惡意查詢 | 同 S10 |
| S19 | onSnapshot 計費：結果集中每有一份文件新增或更新即計一次讀 | https://firebase.google.com/docs/firestore/pricing |
| S20 | 首次快照按查詢讀取計費；離線超過 30 分鐘後重連視同全新查詢重新計費 | 同上 |
| S21 | 文件因內容變更而離開結果集計一次讀；因刪除而離開結果集不計讀 | 同上 |
| S22 | 回傳零筆結果的查詢仍計費一次讀取 | 同上 |
| S23 | 使用 offset 時被跳過的結果仍計入讀取計費，官方建議改用 cursor 分頁 | 同上 |
| S24 | no-op 的寫入與刪除仍計費；刪除不存在的文件一樣產生刪除費用 | 同上 |
| S25 | 每個 collection group 只能指定一個欄位作為 TTL 欄位 | https://firebase.google.com/docs/firestore/ttl |
| S26 | TTL 刪除會觸發所有作用中的 snapshot listeners | 同上 |
| S27 | Managed export 非一致性時間點快照，可能包含操作進行期間的變更；匯出檔不含索引定義 | https://firebase.google.com/docs/firestore/manage-data/export-import |
| S28 | Blaze 方案包含 Spark 的免費用量，且以每日為單位計算 | https://firebase.google.com/pricing |
| S29 | Firebase Auth 本身不含租戶功能，需在 GCP console 升級至 Identity Platform 並啟用 `Allow tenants` | Identity Platform 文件（blog 級摘錄） |
| S30 | Identity Platform 多租戶登入須將 tenant ID 傳入 auth 物件，且 `tenantId` 在頁面重新載入後不保留 | 同上 |
| S31 | Firebase Auth 標準登入方式免費至 50K MAU；SAML/OIDC 僅免費至 50 MAU | https://firebase.google.com/pricing |

### 附錄 C：Blaze 單價來源

本報告 §7 使用的 Blaze 單價來自 Firebase 官方計價範例頁 https://firebase.google.com/docs/firestore/billing-example ，該頁明示假設區域為 **北美多區域 nam5**：

- 讀取 `$0.06/100K`
- 寫入 `$0.18/100K`
- 刪除 `$0.02/100K`
- 儲存 `$0.18/GB`（每月）
- 網路傳出 `$0.12/GB`（免費層以外）

⚠️ 此來源為**本報告撰寫時直接擷取**，未經三方對抗查證流程，且**區域可能與本專案實際部署區域不符**（見 §9-Q1、Q2）。刪除單價 `$0.02/100K` 與 [C09][C19] 的查證附註中提及的數字一致，可作為交叉印證。

### 附錄 D：codebase 引用索引

| 主張 | 位置 |
|---|---|
| `SCHOOL_ID` 為 import-time 單點常數 | `src/js/modules/v2/schemaConstants.js:14` |
| 所有 V2 路徑集中於 `SCHEMA_PATHS` | `src/js/modules/v2/schemaConstants.js:16-33` |
| 規則已用 `match /schools/{schoolId}` 參數化 | `firestore.rules:119` |
| `isDirector` / `isApprover` 以 schoolId 為參數 | `firestore.rules:76-95` |
| 權限鏈 helper（`configExists`/`configDoc`/`mappingExists`/`myMapping`/`myTeacherExists`/`myTeacherDoc`） | `firestore.rules:37-73` |
| **讀取只驗 `isSignedIn()` 的四處破口** | `firestore.rules:135`（teachers）、`:178`（課表）、`:185`（substituteRecords）、`:240`（pendingRequests） |
| 學校根文件與 config 讀取亦只驗 `isSignedIn()` | `firestore.rules:121`、`:127` |
| `private/detail` 刻意設計為不需 get() 父文件 | `firestore.rules:103-115`、`:222-235` |
| operationLogs：任何登入者可 create、禁止 update/delete | `firestore.rules:363`、`:370` |
| userMappings 防提權（linkedTeacherId 必須指向 email 等於本人的教師檔） | `firestore.rules:384-391` |
| V1 遺留路徑以 uid 隔離、對租戶無感知 | `firestore.rules:400-402` |
| 首登流程 `resolveIdentity` | `src/js/modules/v2/authGuardV2.js:52-107` |
| 課表單一文件整份覆寫（`setDoc` 非 merge） | `src/js/modules/v2/schoolDataService.js:155-159` |
| 整集合無 where/limit 的訂閱 | `src/js/modules/v2/schoolDataService.js:432-448` |
| `subscribeSchedule` 單文件、`subscribeOperationLogs` limit 200 | `src/js/modules/v2/schoolDataService.js:452-467` |
| 頁面載入四訂閱齊發 | `src/js/v2-app.js:2482-2505` |
| 月結算全量下載後前端 `startsWith` 過濾（含民國→西元換算） | `src/js/modules/settlementCalculator.js:123-137` |
| localStorage 單一 key 無校別前綴 | `src/js/modules/v2/legacyMigrationService.js:50` |
| V1「匯出本機資料」JSON 下載（個人快照） | `src/js/app.js:4088-4104` |
| 離線備份 CLI（綁開發者個人 gcloud 帳號） | `scripts/firestore-backup.js` |
| 學校開通目前唯一手段（寫死 inhu） | `scripts/firestore-bootstrap-inhu.js` |

---

*本報告為研究與設計文件，不含任何程式碼變更。實作前請先處理 §9 的 Q1、Q3 兩項待查證事實。*
