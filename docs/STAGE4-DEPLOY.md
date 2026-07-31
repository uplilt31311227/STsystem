---
created: 2026-07-31
updated: 2026-07-31
tags:
  - deployment
  - multitenancy
  - billing
---

# Stage 4 部署與操作 SOP：多租戶開通

> 對應設計：[`RESEARCH-multitenancy-semester.md`](./RESEARCH-multitenancy-semester.md) §4（開放註冊的誠實風險評估）、§8 路線圖 Stage 4；[`RESEARCH-blaze-followup.md`](./RESEARCH-blaze-followup.md)（Blaze 支出上限查證、reCAPTCHA 選型、asia-east1 實際單價）。
> 目的：開放 20+ 校自助申請使用，採「自助申請 + 平台管理者輕量審核」（非全自助建校）。
> 前置：**Stage 0/3 必須已完成並部署**（`isMember` 系列規則、`userDirectory` 反查機制、`SCHOOL_ID` 動態化）——本階段的申請/審核流程建立在「schoolId 已可動態解析」之上，若 Stage 3 尚未上線，`getActiveSchoolId()` 恆為 `'inhu'`，`approveApplication()` 建立新學校後申請人也無法真正切換過去。Stage 1/2/5（讀取止血／學期欄位化／封存工具）與本階段互不依賴，可先後任意順序，但**強烈建議先做完 Stage 1**——§7 已證明「不做讀取止血就擴張校數」的帳單差距達百倍量級。
>
> ⚠ **opus 驗收 B1 修復後的新增硬性前置條件**：`scripts/backfill-user-directory.js` **必須已對 `inhu` 現有全體成員執行過**才能部署本階段——見下方「部署順序」第 0 步與「相容性」一節的完整說明。這不是建議，是部署順序中會直接影響現職教師登入的硬性要求，與 Stage 0 的 `emailIndex` 回填、Stage 2 的 `semesterId` 回填同一等級。
>
> **本文件只涵蓋 Stage 4 新增的部分，不重複 Stage 0/1/2/3/5 的部署步驟**（見 `docs/STAGE0-DEPLOY.md`、`docs/STAGE5-ARCHIVE.md`）。

## 本次新增了什麼

| 類別 | 內容 |
|---|---|
| `firestore.rules` | 新增三個頂層集合：`schoolApplications/{uid}`（申請開通新學校，含 platformAdmin 的 pending→{approved,rejected} 與 approved→rejected 兩條合法狀態轉移）、`platformAdmins/{uid}`（平台管理者名冊，client 完全唯讀）、`schoolDirectory/{schoolId}`（公開學校名錄，read 拆 get/list——僅 platformAdmin 可 list）。既有 `schools/{schoolId}/config/{docId}` 的 write 規則新增一條 `platformAdmin` **create-only** 分支（鎖 `docId=='main'`）。既有 `userDirectory` 的自寫分支新增 `isEmailVerified()` 要求，並新增 `platformAdmin` 代寫分支；`joinAttempts` 的 create/update 也補上 `isEmailVerified()` |
| `firestore.indexes.json` | **無變動**。`listPendingApplications()`／`listApprovedApplications()` 刻意只用單欄位 `where('status','==',...)`、不帶 `orderBy`（改在記憶體排序），不需要新複合索引 |
| 前端 | 新增 `src/js/modules/v2/schoolApplicationService.js`（申請/審核/查重/解套的全部 CRUD）；登入遮罩（`v2-app.js`）新增**雙選項**流程——「加入既有學校」（輸入代碼直接自寫 `userDirectory`，opus 驗收 B1 新增，修復新校第二位起教師永遠無法登入的阻斷級問題）與「申請開通新學校」（既有表單），取代原本「查無教師配對即登出」的行為；設定頁新增「學校申請審核」卡片（平台管理者專用，非校內角色，惰性查詢＋每次開啟設定頁重繪，opus 驗收 M3/M4），含「疑難排解：已核准申請」解套區塊（opus 驗收 H2）；`authService.js` 新增 `sendVerificationEmail()` |
| App Check | `src/js/modules/firebaseConfig.js` 新增 App Check（classic reCAPTCHA v3）載入與初始化程式碼，站台金鑰為空字串佔位常數，**尚未啟用**（見下方「啟用步驟」） |
| 離線腳本 | `scripts/bootstrap-platform-admin.js`（建立/移除/列出平台管理者，`--dry-run` 預設，`--remove` 內建最後一位管理者保護，opus 驗收 L6）；`scripts/emergency-brake.js`（一鍵把線上規則換成全 deny，`--brake --yes`／`--restore --yes` 才會執行，`--status` 會實際取回線上 ruleset 內容比對是否為全 deny，opus 驗收 H1/M2） |

## 部署順序（不可顛倒）

```
0. node scripts/backfill-user-directory.js --dry-run    # 確認計畫，然後拿掉 --dry-run 對 inhu
                                                          # 現有全體成員實際執行（opus 驗收 B1 新增
                                                          # 的硬性前置條件，見下方相容性說明）
1. node scripts/firestore-deploy-rules.js --dry          # 先確認語法通過
2. node scripts/firestore-deploy-rules.js                # 正式發布規則
3. node scripts/firestore-deploy-rules.js --list         # 確認 release 已指向新 ruleset
4. node scripts/bootstrap-platform-admin.js --uid=<你的 uid> --dry-run=false
                                                          # 建立第一位平台管理者（你自己），
                                                          # 否則規則部署後沒有任何人能核准申請
5. git push preview feature/permission-system:main       # 部署前端
```

**規則必須先於前端部署**，理由與 Stage 3/5 相同：`schoolApplications`／`platformAdmins`／`schoolDirectory` 是全新集合，舊規則裡完全沒有對應的 `match` 區塊，Firestore 對未匹配路徑預設 `DENY`（同時擋 read 與 write）。若前端先上線：登入遮罩的「申請開通新學校」表單會在使用者按下送出時得到 `permission-denied`，比原本「直接登出」的舊行為更令人困惑（畫面看起來像可以填表，送出卻失敗），故務必先部署規則。

**步驟 0（回填 userDirectory）是 opus 驗收 B1 修復後新增的硬性前置條件，不可省略**：B1 把「查無 `userDirectory` 條目」的行為從「靜默 fallback 到 `inhu`」改成「回傳 null，導向加入/申請雙選項畫面」（見下方相容性一節）。這個改變對**已經回填過**的 `inhu` 成員零影響，但對**尚未回填**的既有成員，會讓他們下次登入被誤導向「你尚未綁定任何學校」的畫面——這不是新聘教師的正常情境，是把既有成員錯誤地擋在門外。必須確認回填腳本已針對 `inhu` 全體成員執行過，才能部署本階段的 client 程式碼。

**步驟 4（建立平台管理者）不可省略或延後**：`platformAdmins` 集合的 write 規則寫死 `false`，沒有任何 client 路徑可以建立第一筆記錄，必須用 `scripts/bootstrap-platform-admin.js` 離線寫入。若跳過這步就上線，會出現「有人申請了，但沒有任何人能核准」的死局——申請人只能一直卡在「審核中」。

### 已知限制：既有 `inhu` 學校不在 `schoolDirectory` 中

`schoolDirectory` 只在 Stage 4 核准流程中才會被寫入（`approveApplication()` 第一批寫入時建立）。既有的 `inhu` 學校在 Stage 4 之前就存在，預設**不會**出現在 `schoolDirectory` 裡，因此申請頁的即時查重（`isSchoolIdTaken()`）不會提示 `inhu` 已被使用。

這不是資料安全漏洞——真正的防線是規則層的 create-only 語意（見 `firestore.rules` 第 9 點與 `schoolApplicationService.approveApplication()` 檔頭註解）：即使有人申請 `desiredSchoolId='inhu'` 且被誤核准，`approveApplication()` 對 `schools/inhu/config/main` 的寫入會被 Firestore 判定為 `update`（因為文件已存在）而非 `create`，`platformAdmin` 的 create-only 權限直接拒絕整批寫入，`approveApplication()` 會把這個失敗轉譯成明確的錯誤訊息給審核者。影響僅止於「申請當下少一道即時提示」，不影響資料安全。

**opus 驗收 B1 的補充**：「加入既有學校」流程（見上方「本次新增了什麼」）**不**依賴 `schoolDirectory` 存在與否——直接嘗試自寫 `userDirectory` 並讓規則的 `configExists()` 決定成敗（見 `v2-app.js` 的 `attemptJoinSchool` 相關程式碼註解），所以即使 `inhu` 沒有 `schoolDirectory` 條目，`inhu` 的新教師依然能用「加入既有學校」輸入 `inhu` 成功綁定。上面這個已知限制**只影響**「申請開通新學校」表單裡的即時查重提示，不影響加入流程的實際可用性。

**建議**（非必要，但能改善審核體驗）：部署後手動補一筆 `schoolDirectory/inhu`，讓查重提示涵蓋既有學校：

```
node scripts/firestore-bootstrap-inhu.js
# 目前該腳本不會寫 schoolDirectory，如需補上，可用 gcloud 直接 PATCH：
gcloud auth print-access-token --account=uplilt31311227@gmail.com
curl -X PATCH \
  "https://firestore.googleapis.com/v1/projects/stsystem-9d5fe/databases/(default)/documents/schoolDirectory/inhu" \
  -H "Authorization: Bearer <上面印出的 token>" \
  -H "Content-Type: application/json" \
  -d '{"fields":{"schoolName":{"stringValue":"新竹市立內湖國民中學"},"createdAt":{"timestampValue":"2026-07-31T00:00:00Z"}}}'
```

（本次任務範圍「只寫不執行」，上述指令未實際執行，部署時請自行核對後執行。）

## App Check（classic reCAPTCHA v3）啟用步驟

> **2026-08-01 已完成步驟 1-4（token 產生階段），步驟 5-6（enforcement）刻意未做。**
> - reCAPTCHA v3 站台已建立（標籤 STsystem、綁 STsystem GCP 專案、網域 `uplilt31311227.github.io` + `localhost`）。
> - `RECAPTCHA_V3_SITE_KEY` 已填入並部署（commit `bc11fda`）。
> - Firebase Console → App Check → Web app 狀態為「**已註冊**」、認證服務 reCAPTCHA。
> - 正式站實測：`app-check` SDK 與 `recaptcha` 皆已載入、`window.grecaptcha` 為 object，
>   並觀察到 `.../exchangeRecaptchaV3Token` 請求成功回應 → **token 交換鏈路確實運作中**。
> - enforcement **尚未開啟**（依步驟 5-6，先觀察 1-2 週 Metrics 通過率再決定）。
> - 同期完成：專案已升級 **Blaze**（帳單帳戶 STsystem／TWD）；平台管理者名冊
>   `platformAdmins` 已建立，設定頁「學校申請審核」卡片實測顯示正常。
> - ⚠ **待辦**：Blaze 升級時自動建立的預算為 NT$500／門檻 50%·90%·100%，第一道警報
>   要花到正常月費（約 NT$25）的 10 倍才觸發，保護力不足。建議調整為金額 NT$250
>   （≈US$8）＋門檻 5%·50%·100%·150%(預測)，對應報告建議的 US$0.4／$4／$8 三道防線。

依 `RESEARCH-blaze-followup.md` §3 的查證結果：選用 **classic reCAPTCHA v3**（非 Enterprise）——v3 免費額度每月 100 萬次呼叫，遠高於 Enterprise 的每月 1 萬次免費額度與本案估算的用量（20 校情境約每月 1.6 萬次），且超額時是 fail-open（給 0.9 分，不粗暴擋下請求）而非直接失敗。

1. **建立 reCAPTCHA v3 站台**：前往 [Google reCAPTCHA 管理主控台](https://www.google.com/recaptcha/admin)，新增站台，類型選 **v3**（不是 v2、不是 Enterprise），網域填 `uplilt31311227.github.io`（正式網域）與 `localhost`（本機開發測試用）。取得**網站金鑰（site key）**。
2. **填入金鑰**：編輯 `src/js/modules/firebaseConfig.js`，把 `RECAPTCHA_V3_SITE_KEY = ''` 改成剛取得的金鑰字串，例如 `RECAPTCHA_V3_SITE_KEY = '6Lxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'`。
3. **在 Firebase Console 註冊 App Check provider**：Firebase Console → 專案 `stsystem-9d5fe` → App Check → 為 Web app 選擇 **reCAPTCHA v3**，貼上同一把站台金鑰。
4. **部署前端**：確認瀏覽器 console 出現 `App Check 已啟用（reCAPTCHA v3）`（不是 `跳過初始化` 的訊息）。
   - ⚠ opus 驗收 L5：`firebaseConfig.js`／`authService.js` 這類被 `app.js`／`v2-app.js` 動態 `import` 的子模組**沒有版本查詢參數**（只有 `index.html` 裡 `<script src="...v2-app.js?v=x.y.z">` 這一層有）——`docs/STAGE0-DEPLOY.md`「3. 部署前端 client」一節已有既存結論：GitHub Pages 靜態資源快取 `max-age=600`，且該文件同時說明了「不要在 import 路徑加 `?v=` 試圖繞開」的理由（會讓同一支子模組被建立成兩個互不同步的模組實例，比快取問題本身更嚴重），本次沿用同一結論、不新增 import 版本參數機制。部署後**務必請使用者硬重新整理**（Windows/Linux `Ctrl+Shift+R`，macOS `Cmd+Shift+R`）或清瀏覽器快取，才能保證載入到含 App Check 初始化程式碼的新版 `firebaseConfig.js`；否則會出現「`index.html` 版本號已更新，但瀏覽器主控台仍看不到 App Check 訊息」的困惑現象，且此快取窗（約 10 分鐘）過後會自然自癒。
5. **觀察期，暫不開 enforcement**：App Check SDK 初始化後會開始產生/快取 token，但**不會**強制要求 Firestore 驗證 token（enforcement 是 Firebase Console 端獨立的開關，本次程式碼刻意不觸碰）。建議先讓系統帶著 App Check token 跑至少 1-2 週，在 Firebase Console → App Check → Metrics 觀察「驗證通過率」是否接近 100%——若有大量請求沒有帶 token（例如舊版快取的前端、或某些 Node 腳本經 REST API 直連而非透過 App Check），代表現在就開 enforcement 會誤傷這些合法流量。
6. **開啟 enforcement 的時機**：確認 Metrics 顯示絕大多數請求都帶著有效 token 後，才在 Firebase Console → App Check → Firestore → 手動切換為「已強制」。**這是 Console 端的獨立操作，本次程式碼變更完全不涉及**——切換前務必再次確認所有還在使用的用戶端（含任何離線腳本若有透過瀏覽器路徑存取的情境）都已經過 App Check 保護，否則會直接鎖住合法使用者。

## 支出風控：多門檻預算警報 + 緊急煞車腳本

依 `RESEARCH-blaze-followup.md` §2 的查證結論：**Blaze 沒有硬性支出上限機制**——GCP Budget 只能發警報，不能自動斷流；唯一的真自動化做法（Budget → Pub/Sub → Cloud Function）需要一支 Cloud Function，違背本專案「無自建後端」的架構前提，且一旦誤觸發是整專案斷線。因此本階段的支出風控是「降低失控機率 + 縮短反應時間」，不是「防止失控」——這點必須誠實認知，不能假裝有解。

### 1. 設定多門檻 Budget 警報（Console 操作，非程式碼變更）

前往 [Google Cloud Console → Billing → Budgets & alerts](https://console.cloud.google.com/billing/budgets)，為專案 `stsystem-9d5fe` 新增一個 Budget：

1. **金額基準**：以「bounded query 改造後、20 校情境約 US$0.8/月」（`RESEARCH-blaze-followup.md` §4.3 的 asia-east1 實際估算）為正常月費基準線。
2. **多門檻設定**（建議至少四道，皆勾選發送 email 給開發者本人與所有平台管理者）：
   - **50%**：US$0.4（早期異常訊號，多半是誤報，僅供留意）
   - **正常月費的 5 倍**：US$4（明顯超出預期，建議立即查看 Firebase Console 的 Firestore Usage 頁）
   - **正常月費的 10 倍**：US$8（高度懷疑濫用或攻擊，建議查看是哪一校的讀取量異常飆升）
   - **150%**：作為「真的失控」的最後防線，收到此門檻警報時應立刻考慮執行緊急煞車腳本
   （以上金額僅為 20 校情境的量級示意；隨校數成長，正常月費基準線會提高，門檻金額需同步調整——建議每季依實際帳單重新校準一次。）
3. Budget 只會**發信**，**不會**自動停用任何服務或功能（`RESEARCH-blaze-followup.md` §2(a) 已查證並引用官方原文），這是刻意的設計取捨，不是遺漏——見下方「為何不做自動斷流」。

### 2. 緊急煞車腳本（`scripts/emergency-brake.js`）

收到高門檻（建議 10 倍或 150% 門檻）警報後，由人工判斷是否需要立即停止服務：

```bash
# 平時：確認現況（會實際取回線上 ruleset 內容並比對是否為全 deny 版本，opus 驗收 M2）
node scripts/emergency-brake.js --status

# 判斷確實需要緊急停止時（opus 驗收 H1：必須同時帶 --brake 與 --yes，裸執行只印用法說明）：
node scripts/emergency-brake.js --brake --yes
# → 備份目前 firestore.rules 到 firestore.rules.emergency-backup，
#   並把線上規則換成「全部拒絕讀寫」（含平台管理者，不留任何後門）

# 問題排除、確認可以恢復服務後（同樣需要 --yes）：
node scripts/emergency-brake.js --restore --yes
# → 從備份還原並重新部署
```

反應時間可壓到幾分鐘內（只需要跑一個 node 指令），但**這不是自動化**——依然需要人工判斷「現在真的要拉煞車」，且拉下去是全平台（所有學校）一起斷線，不是只斷有問題的那一校（純前端 + Security Rules 架構下沒有更細緻的「只斷一校」手段，因為攻擊者若真的取得某校合法憑證，能耗盡的是全專案共享的配額，見 §4.5 風險 1）。

### 3. 為何不做自動斷流（Cloud Function 方案）

官方標準做法是 Budget → Pub/Sub → Cloud Function（收到超支通知就呼叫 Cloud Billing API 停用計費）。本專案**不採用**，理由：

1. 違背「無自建後端」的架構前提——這是本專案從第一天就明確的設計邊界，寫進 `CLAUDE.md` 的技術棧描述。
2. 一旦誤觸發（例如單日尖峰但實際上是正常流量），是**整個專案的所有 Google Cloud 服務一起終止**，比帳單超支本身更糟——含所有已開通學校、含 Auth 登入本身。
3. 若未來評估後決定要採用，官方建議把觸發門檻設在遠高於正常預算的倍數（例如 10 倍以上），只在「真的失控」才自動斷線，且務必先在測試專案演練過斷線與復原流程，不建議直接在正式專案 `stsystem-9d5fe` 上第一次嘗試。

### 4. 每週人工巡檢（建議，非工具化）

Budget 警報是「等到超支才知道」，建議額外養成每週檢視 [Firebase Console → Firestore → Usage](https://console.firebase.google.com/) 的習慣，及早發現異常增長趨勢——這比等 Budget 警報觸發更早一步。

## 全鏈走讀：三種使用者族群

見本次任務交付報告（回覆訊息）「全鏈走讀」一節的逐步程式碼引用與規則行號對照，此處僅列摘要。opus 驗收後補上第三類「新校成員」——這是 B1 修復要解決的核心情境，原設計只想過「陌生人申請建校」與「既有 inhu 成員」兩類，漏了「新校已核准、但校內第二位（含之後）教師從未登入過」這一類。

### 1. 陌生人申請 → 審核 → 核准 → 首登成為 director

1. 陌生人登入 → `authGuardV2.resolveSchoolIdForUid()` 查無 `userDirectory` 條目（不是 `permission-denied`）→ 回傳 `schoolId: null` → `resolveIdentity()` 直接回傳 `null`，**不寫 joinAttempt**（沒有學校可歸屬）→ `v2-app.js` 的 `enterApplyFlow()` 接手，**不再自動登出**，保留 session。
2. 使用者在遮罩內完成 email 驗證（Google 登入天然已驗證）與送出申請（`schoolApplicationService.submitApplication()`，doc id 綁自己的 uid）。
3. 平台管理者在自己的（既有）學校登入後，設定頁「學校申請審核」卡片列出待審申請（`listPendingApplications()`），按「核准」→ `approveApplication()`：第一批 `writeBatch` 建立 `schools/{id}/config/main` + `schoolDirectory/{id}`；第二批 `writeBatch` 更新申請狀態為 `approved` + 把申請人的 `userDirectory/{uid}` 指向新學校。若偵測到 `schoolDirectory` 已有同代碼同名紀錄，會先丟出 `SameNameConflictError` 要求審核者在 UI 二次確認「僅執行綁定」才會繼續（opus 驗收 H2）。
4. 申請人下次登入（或在遮罩內按「重新嘗試登入」）：`resolveSchoolIdForUid()` 讀到新的 `userDirectory` 條目 → `setActiveSchoolId(新學校)` → `attemptResolveTeacherForActiveSchool()` 走 `isInitialDirector` 分支（申請人 email 就在核准時寫入的 `initialAdminEmails` 裡）→ 自動建立 director 教師檔並綁定 `userMappings` → 登入成功，成為該校教務主任。

這條鏈路完全復用 Stage 0 既有的白名單 bootstrap 機制（`isInitialDirector`/`attemptResolveTeacherForActiveSchool`），Stage 4 只負責「讓 `config.initialAdminEmails` 從無到有地被建立」，沒有新增任何教師檔建立/角色指派的邏輯——降低了新增程式碼觸碰既有信任鏈的風險面。

### 2. 新校成員（opus 驗收 B1 修復的核心情境）：director 建檔 → 教師輸入代碼 → 登入

這是原設計遺漏、opus 驗收發現的阻斷級問題：學校核准開通後，director 在「教師管理」頁為第二位（含之後）教師建檔並綁定 email（`createTeacher()`/`updateTeacher()` 內部同步維護 `emailIndex`，既有機制，Stage 4 未改動），但這位教師自己**從未登入過**，沒有 `userDirectory` 條目。原設計的 fallback（查無條目一律當成 `inhu`）會讓這位教師的登入永遠去 `inhu` 的 `emailIndex` 找自己（查無所獲，因為他根本不是 `inhu` 的教師），永遠卡住。

修復後的鏈路：

1. 教師登入 → `resolveSchoolIdForUid()` 查無條目 → 回傳 `null`（不再 fallback `inhu`）→ `resolveIdentity()` 回傳 `null` → 導向「加入既有學校／申請開通新學校」雙選項畫面。
2. 教師在「加入既有學校」欄位輸入 director 告知的學校代碼（例如 `newschool`），點「加入」→ `v2-app.js` 直接呼叫 `dataSvc.upsertUserDirectoryEntry(uid, 'newschool')`——命中 `firestore.rules` 的 `userDirectory` 自寫分支（`isSignedIn() && auth.uid==uid && isEmailVerified() && configExists('newschool')`），寫入成功。
3. 頁面重新整理，重新走一次 `resolveIdentity()`：`resolveSchoolIdForUid()` 這次讀到剛寫入的條目（`existed: true`）→ `setActiveSchoolId('newschool')` → `attemptResolveTeacherForActiveSchool()` 讀 `schools/newschool/emailIndex/{該教師email}`，找到 director 稍早建立的 `teacherId` → 建立 `userMappings` → 讀教師檔 → 登入成功，身份是 director 賦予的角色（`teacher`/`section_chief`，不是 director）。

若代碼輸入錯誤或教師實際上還沒被建檔，步驟 3 會再次配對失敗，`resolveIdentity()` 回傳 `null`（此時 `schoolId` 已知，會寫一筆 `joinAttempts` 到該校供 approver 查看，`firestore.rules` 的 `isEmailVerified()` 要求同步套用），使用者回到雙選項畫面可重新嘗試。

### 3. 既有 `inhu` 成員：不受影響（前提：回填已執行）

見下方「相容性」一節。

## 已知限制（如實列出，不迴避）

1. **App Check 無法擋合法使用者的合法濫用**——官方明言只能擋掉部分而非全部濫用向量（`RESEARCH-multitenancy-semester.md` [C16]）。任何已被核准的教師仍可打開 devtools 對自己學校做無限次查詢，耗盡全平台配額。這是純前端 + Firestore 架構下無解的問題，見報告 §4.5。
2. **平台管理者代寫 `userDirectory` 的權限面較寬**——`isPlatformAdmin()` 可以把任意 uid 的 `userDirectory` 指向任意存在的學校，不限於正在核准的那位申請人（見 `firestore.rules` 的 `userDirectory` match 區塊完整說明）。這是刻意接受的權限面，與 director 可代寫校內任何 `userMappings` 屬同一信任模型。
3. **`approveApplication()` 的 schoolId 衝突偵測是啟發式的**——用「`schoolDirectory` 既有紀錄的 `schoolName` 是否與本申請相同」判斷「這是重試」還是「真衝突」，極端巧合下可能誤判（見該函式檔頭「已知限制」）。opus 驗收 H2 已把「偵測到同名就自動跳過」改為「必須經審核者二次確認才跳過」，降低誤判的實際傷害（審核者至少會看到明確提示），但無法消除誤判本身的可能性。
4. **regression test（`test/v2-rules-matrix.mjs`）只涵蓋 DENY／攻擊案例**——三個測試帳號皆非 `platformAdmin`、且 email_verified 狀態未知（X40 除外，其 setup 步驟依賴 email_verified，見該案例註解），無法可靠地寫出更多正向 ALLOW 案例。特別是「platformAdmin 把已核准申請改成 rejected 以外的值應 DENY」這個 H2 新增分支的專屬案例，需要真正的 platformAdmin 測試帳號才能建立前置狀態，本次明確記錄為未覆蓋（見該檔案 X40 案例後的「已知覆蓋缺口」註解），不是遺漏而是誠實記錄。
5. **`approveApplication()`／`rejectApplication()` 的孤兒學校防呆同樣是啟發式的**（opus 驗收 H3）——`rejectApplication()` 判斷「這筆申請是否已對應到真實建立的學校」依據 `application.status==='approved'` 或「`schoolDirectory` 同代碼同名」，無法涵蓋所有邊界情況（例如學校已建立但名稱事後被人工修改）。人工清理程序見下方。
6. **孤兒學校的人工清理程序**（H3/H2 相關，opus 驗收要求補充）：若確實出現「`schoolDirectory`/`config` 已建立、但沒有對應的 `schoolApplications` 紀錄指向它」的孤兒狀態，目前**沒有任何 client 路徑可以清理**（`schoolDirectory`/`config` 皆無 delete 規則）。需要開發者以個人 gcloud 帳號執行 REST `DELETE`：
   ```bash
   gcloud auth print-access-token --account=uplilt31311227@gmail.com
   curl -X DELETE "https://firestore.googleapis.com/v1/projects/stsystem-9d5fe/databases/(default)/documents/schoolDirectory/<孤兒代碼>" \
     -H "Authorization: Bearer <token>"
   curl -X DELETE "https://firestore.googleapis.com/v1/projects/stsystem-9d5fe/databases/(default)/documents/schools/<孤兒代碼>/config/main" \
     -H "Authorization: Bearer <token>"
   ```
   清理前務必先確認這所學校底下沒有任何真實使用中的資料（`teachers`/`userMappings`/`substituteRecords` 等）——若已有教師登入並開始使用，代表這不是孤兒，不應清理，應改用「核准」讓對應的申請補上關聯。上述指令**未實際執行**（本次任務範圍「只寫不執行」），僅供部署時參考。

## 相容性：現有 `inhu` 使用者不受影響（前提：回填已執行）

- **登入流程**：`inhu` 現有使用者的 `userDirectory` 文件**必須**已由 `scripts/backfill-user-directory.js`（Stage 3）離線建立，才不受本次收緊的 `isEmailVerified()` client 規則限制（該腳本用 gcloud REST/owner 憑證寫入，繞過 Security Rules）——這些使用者下次登入時 `userDirectoryExisted===true`，`authGuardV2.resolveIdentity()` 的 `if (!userDirectoryExisted)` 守門會讓他們完全不會走到新收緊的自寫分支，行為與 Stage 4 之前完全一致。**opus 驗收 B1 修復後，這個前提從「建議」變成「硬性要求」**：B1 移除了「查無條目一律 fallback `inhu`」的安全網，若回填沒做完，尚未回填的既有成員下次登入會被誤導向雙選項畫面（見上方部署順序第 0 步）。
- **拒絕路徑變化**：唯一可觀察的行為差異是——若真的有 `inhu` 使用者的教師配對失敗（例如 email 被主任從教師名單移除），Stage 4 之前會直接登出並顯示「尚未授權」，Stage 4 之後會改為顯示「加入既有學校／申請開通新學校」雙選項畫面。這是刻意的行為變更（因為系統現在無法區分「這是一個真正的陌生人」與「這是一個配對失效的舊使用者」），如果造成困惑，教師應聯絡主任確認 email 白名單，而不是真的送出一筆學校申請或亂輸入代碼（兩者都不會造成任何資料損害，平台管理者/該校 approver 審核時看到「申請人/加入嘗試 email 是既有學校的教師」可直接駁回並提示對方聯絡主任）。
- **inhu 未來新聘、從未登入過的教師**：這是 opus 驗收 B1 帶來的行為變更，前面「全鏈走讀」第 2 類已詳述——新教師第一次登入需要知道並輸入學校代碼 `inhu`（由 director/組長告知），不再是登入即自動成功。這不是 bug，是開放多租戶後「schoolId 從哪裡來」不能再依賴單校時代隱含假設的必然結果。
- **App Check**：站台金鑰為空時完全不初始化，對任何現有請求路徑零影響。
