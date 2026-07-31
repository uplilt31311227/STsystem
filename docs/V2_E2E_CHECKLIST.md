---
created: 2026-07-29
tags:
  - v2
  - testing
  - e2e
---

# V2 端到端驗證 Checklist

> 對應分支：`feature/permission-system`
> 對應 Preview URL：https://uplilt31311227.github.io/STsystem-preview/
> 規則版本：firestore.rules v2.2（三層角色：director / section_chief / teacher）
> 線上 ruleset id：`618f5d1e-d350-4e8e-950e-b551eab97490`（2026-07-29 重新部署，內容與前一版 `0ad89275-0df4-46c6-99c8-825a6cc94889` 經位元級比對**完全相同**，僅 id 不同；`node scripts/firestore-deploy-rules.js --list` 核對 release 是否指向此 id）
> 取代舊版：本檔取代 2026-04-29 舊版（僅涵蓋 admin/teacher 兩角色、7 情境全未勾選）。全面改寫為 A-G 七組，對齊現行三角色 + 三種審核流（代課單簽／調課雙簽／多重調課全員同意）。

標記 `[自動:檔名]` 的項目可重複執行取得客觀結果，改規則/改流程後應重跑。標記 `[人工]` 的項目需人工操作瀏覽器並記錄結果（Google OAuth 互動、UI 視覺確認、鍵盤導覽等目前無法自動化）。

---

## A. 前置與環境

- [x] `[人工]` firestore.rules 線上 ruleset 已部署且 release 指向最新：目前 ruleset id `618f5d1e-d350-4e8e-950e-b551eab97490`（`node scripts/firestore-deploy-rules.js --list` 核對）
- [x] `[人工]` Firebase Auth Email/Password provider 已啟用（2026-07-29 已查證；三個測試帳號 v2t1/v2t2/v2t3 皆用此方式登入，非 Google OAuth）
- [ ] `[人工]` Firebase Auth Google OAuth provider 狀態複查（正式教師仍以 Google 登入為主，需確認未受上述變更影響）
- [x] `[人工]` 測試帳號清單就緒（密碼統一 `V2test!2026#stsys`，來源見 `test/test-tokens.json` 或 `STSYSTEM_TEST_CREDS` 指向的憑證檔）：

  | 帳號 | email | teacherId | role |
  |---|---|---|---|
  | 教師甲 | uplilt31311227+v2t1@gmail.com | teacher_1785266484232_s9lay2 | teacher |
  | 教師乙 | uplilt31311227+v2t2@gmail.com | teacher_1785266488793_ly5xde | teacher |
  | 組長丙 | uplilt31311227+v2t3@gmail.com | teacher_1785266493704_n9gil4 | section_chief |
  | 正式 director（唯讀參照，測試絕不可動） | uplilt31311227@gmail.com | tch_1780040513944_kl4wgr9 | director |

- [ ] `[人工]` preview 站已收到最新 `feature/permission-system` 推送（比對最新 commit hash 與 GitHub Actions / Pages 部署紀錄時間）
- [ ] `[自動:scripts/firestore-health-check.js]` `schools/inhu` 結構健康檢查全綠（config / teachers / mappings / pendingRequests / substituteRecords / operationLogs 必備欄位皆符合）

---

## B. 三角色登入與 UI 可見性

> 三層角色（director / section_chief / teacher）的視覺與可見性差異需人工核對；規則層的存取權限已由 D 組自動驗證，此組只驗證「畫面有沒有照規則層的權限正確顯示/隱藏」。

### B-1 director
- [ ] `[人工]` 登入後 `body` class 含 `v2-director`（同時帶 `v2-approver`、相容別名 `v2-admin`）
- [ ] `[人工]` 頭部姓名旁徽章文字顯示「教務主任」（`v2-role-tag director`）
- [ ] `[人工]` 頁籤可見：課表匯入、教師管理、操作日誌、調代課申請、待辦、紀錄、月結算 全部可見

### B-2 section_chief
- [ ] `[人工]` 登入後 `body` class 含 `v2-section-chief`（同時帶 `v2-approver`、相容別名 `v2-admin`），**不含** `v2-director`
- [ ] `[人工]` 頭部徽章文字顯示「教學組長」
- [ ] `[人工]` 頁籤可見：課表匯入、操作日誌、調代課申請、待辦、紀錄、月結算 可見；**教師管理（`.v2-director-only`）不可見**

### B-3 teacher
- [ ] `[人工]` 登入後 `body` class 僅含 `v2-teacher`，**不含** `v2-approver`／`v2-admin`／`v2-director`／`v2-section-chief`
- [ ] `[人工]` 頭部徽章文字顯示「教師」
- [ ] `[人工]` 頁籤可見：調代課申請、待辦（僅「待我同意」）、紀錄（僅自己相關）；**課表匯入、教師管理、操作日誌、月結算不可見**（`.v2-admin-only` 系列被隱藏）

### B-4 可見性矩陣速查

| 頁籤／區塊 | director | section_chief | teacher |
|---|:---:|:---:|:---:|
| 課表匯入 | 可見 | 可見 | 不可見 |
| 教師管理（`.v2-director-only`） | 可見 | 不可見 | 不可見 |
| 操作日誌（`.v2-admin-only`） | 可見 | 可見 | 不可見 |
| 調代課申請 | 可見 | 可見 | 可見 |
| 待辦（同意/核准佇列） | 核准佇列 | 核准佇列 | 僅「待我同意」 |
| 紀錄 | 全校 | 全校 | 僅自己相關（`filterRecordsForCurrent`） |
| 月結算 | 可見 | 可見 | 不可見 |

---

## C. 三種審核流（人工操作瀏覽器 + Firestore 現況核對）

> 每種流程含：happy path、中途拒絕、兩位 approver 並發核准（驗證 `runTransaction` 防止重複建立 record）。
> 底層規則允許/拒絕已由 `test/v2-rules-matrix.mjs` 自動覆蓋（見 D 組），此處驗證的是**應用層 UI 流程**與**交易併發行為**，兩者互補、缺一不可。

### C-1 代課（單簽）
- [ ] `[人工]` happy path：教師甲發起代課 → `pending_approval` → 組長丙核准 → `substituteRecords` 新增一筆、PDF 產生、教師甲「我已發起」顯示已核准
- [ ] `[人工]` 中途拒絕：組長丙駁回 → `pendingRequests.status=rejected` 且 `rejectNote` 有值 → 教師甲看到拒絕理由 →「我知道了」後文件真正刪除（`dismissRejectedRequest`）
- [ ] `[人工]` 兩位 approver 並發核准：組長丙與 director 幾乎同時點「核准」同一筆 → 僅一方成功建立 record，後到者收到 `RequestAlreadyProcessedError`（UI 顯示「已被處理，請重新整理列表」）；`substituteRecords` 不得出現兩筆對應此請求的紀錄

### C-2 調課（雙簽）
- [ ] `[人工]` happy path：教師甲發起調課（對象教師乙）→ 教師乙同意 → 轉 `pending_approval` → 組長丙核准 → `substituteRecords` 新增一筆（`type=調課`）
- [ ] `[人工]` 中途拒絕：教師乙在同意階段直接拒絕 → `status=rejected`，不進入待核准
- [ ] `[人工]` 兩位 approver 並發核准：同 C-1 併發情境，套用在雙簽案上

### C-3 多重調課（全員同意）
- [ ] `[人工]` happy path：教師甲發起多重調課（同意名單含乙、丙）→ 乙同意（僅移出乙，狀態仍 `pending_swap_consent`）→ 丙同意（全員到齊，轉 `pending_approval`）→ director 核准 → `substituteRecords` 新增一筆，`affectedTeacherIds` 含所有關係人
- [ ] `[人工]` 中途拒絕：全員同意到一半時其中一人選擇拒絕 → 整批 `status=rejected`（soft-reject），發起人可見全部同意進度與拒絕者
- [ ] `[人工]` 兩位 approver 並發核准：同 C-1 併發情境，套用在多重調課全員同意後的核准階段

---

## D. 規則攻擊矩陣 `[自動:test/v2-rules-matrix.mjs]`

> 執行：`node test/v2-rules-matrix.mjs`（需環境變數 `STSYSTEM_TEST_CREDS` 指向測試帳號憑證 JSON，未設定則 fallback 到專案外部的 scratchpad 路徑；找不到憑證檔時腳本印出說明並以 exit code 2 結束，CI 應視為跳過而非測試失敗）。
> 本組只列案例編號與最近一次執行結果；案例細節（payload 形狀、對應規則行號 `rulesRef`）已寫在腳本內每個案例的宣告中，不在此重複描述以免與程式碼分岔。

- [ ] `[自動:test/v2-rules-matrix.mjs]` P01-P12 正向案例（教師/組長合法操作應 ALLOW：代課/調課/多重調課建立、同意、核准、駁回、自我調課直寫、operationLog 建立、teachers/config/自己 userMapping 讀取）全數通過
- [ ] `[自動:test/v2-rules-matrix.mjs]` X01-X14 攻擊案例（越權提權、偽造已核准、跳過同意、自我同意、竄改白名單外欄位、終態鎖繞過、代課費灌水、稽核軌跡竄改/刪除、讀他人 mapping 應 DENY）全數通過
- [ ] `[自動:test/v2-rules-matrix.mjs]` 驗後檢查：`substituteRecords` / `operationLogs` 現況筆數與基準值一致（基準值：`substituteRecords` = 既有筆數 + 本次執行新增的 `zz_test_` 筆數；`operationLogs` 只增不減，且新增筆數可用 `test/.last-test-docs.json` 逐筆核對）

**規則變更後的義務**：往後任何一次 `firestore.rules` 修改，合併前必須重跑本腳本且全數通過，並在文末「最近一次執行紀錄」表格新增一列；若新增規則分支，需同步在 `v2-rules-matrix.mjs` 補上對應案例（正向與攻擊各至少一案）。

---

## E. V1 隔離復檢

> 確保 V2 開發過程未污染穩定版（master 分支既有邏輯，`users/{uid}/...` 個人空間）。

- [ ] `[自動:test/v2-isolation-test.js]` 不帶 `?v2=1` 時：`body` 無 `v2-active` class、`dataManager` 未被 V2 patch、PDF 產生器未被 V2 patch、V2 樣式未注入、原生 `checkExistingRecord` 仍是未被取代的版本
- [ ] `[人工]` 不帶 `?v2=1` 時完全走舊路徑：手動操作一次完整代課登記流程，行為與 V2 上線前一致
- [ ] `[人工]` localStorage 未被污染：開發者工具檢查 localStorage 鍵值，確認 V2 未寫入舊版鍵名之外的內容、也未覆蓋舊版資料結構
- [ ] `[人工]` `users/{uid}/...`（穩定版 master 個人空間）未被 V2 寫入：用既有帳號登入穩定版寫一筆測試資料，確認 Firestore 路徑仍是 `users/{uid}/data/...`，V2 的 `schools/inhu/...` 路徑無對應寫入
- [ ] `[自動:test/v2-smoke-test.js]` `?v2=1` 啟用時 V2 頁籤數量（預期 3）、樣式注入、console 無 V2 相關錯誤

---

## F. 身份切換與登出鎖定

- [ ] `[人工]` 切帳號後舊身份內容不殘留：以教師甲登入看過「我的待辦」後登出，改用教師乙登入，確認畫面未殘留教師甲的資料（列表、表單暫存值、選取狀態皆重置）
- [ ] `[人工]` 登出後全 app 鎖定：登出後嘗試以瀏覽器返回鍵回到已登入畫面，應被導回登入頁而非顯示快取畫面
- [ ] `[人工]` 登出後鍵盤 Tab 導覽無法觸及原畫面元件：登出後連續按 Tab，焦點應只在登入頁的可互動元件間循環，不可跳進背景殘留的表單/按鈕
- [ ] `[人工]` 未授權帳號（不在任何教師 email 對應、也不在 `initialAdminEmails`）登入被拒：UI 顯示「尚未授權」並自動登出
- [ ] `[人工]` 上一項同時寫入 `login_denied` operationLog：`actor.email` 為該未授權帳號、其餘 actor 欄位可為 null（綁定前寫入，符合 rules 對 `operationLogs.create` 的一般白名單，不需 `actor.uid == auth.uid`）

---

## G. 新功能（實作中，先訂驗收項目）

> 教師名單 CSV 批次匯入、V1 資料遷移冪等性由另外的 agent 實作中。此組先訂驗收標準；待實作完成、對應自動化腳本產出後，把 `[人工]` 換成 `[自動:檔名]`。

### G-1 教師名單 CSV 批次匯入
- [ ] `[人工]` 匯入格式正確的 CSV → 對應筆數教師被新增到 `schools/inhu/teachers/`，欄位（name/email/domains/homeroomClass/role）正確映射
- [ ] `[人工]` CSV 含重複 email → 匯入行為明確（覆蓋既有教師或跳過並提示，不可靜默產生兩筆同 email 教師）
- [ ] `[人工]` CSV 含不合法 role 值（非 director/section_chief/teacher/admin）→ 匯入被拒或自動 fallback 為 teacher，並提示使用者
- [ ] `[人工]` 匯入動作寫入對應 operationLog（`action: roster_import`）
- [ ] `[人工]` 匯入權限：僅 director 可執行（呼應 `roleService.canManageRoster()`），section_chief/teacher 操作應被拒（UI 與規則層皆需擋下）

### G-2 V1 資料遷移冪等性
- [ ] `[人工]` 對同一批 V1 資料執行遷移腳本兩次，第二次不應產生重複的 V2 文件（同一筆 V1 紀錄不會在 `schools/inhu/substituteRecords` 出現兩次）
- [ ] `[人工]` 遷移中斷後重跑：模擬遷移到一半中斷，重跑後資料最終一致，不遺漏也不重複
- [ ] `[人工]` 遷移不影響 V1 原始資料：遷移前後比對 `users/{uid}/data/...`，內容應完全不變（遷移只讀不寫 V1 路徑）
- [ ] `[人工]` 遷移產生的 V2 文件通過 `scripts/firestore-health-check.js` 健康檢查

---

## 完成判準

當 A-G 七組全部項目勾選通過，且：

- [ ] D 組 `node test/v2-rules-matrix.mjs` 最近一次執行為 **26 通過 / 0 失敗**
- [ ] `node scripts/firestore-health-check.js` 無 FAIL 級問題
- [ ] E 組 V1 隔離全數通過（穩定版使用者完全無感知 V2 存在）
- [ ] G 組自動化腳本已產出並取代對應 `[人工]` 標記

→ V2 三層角色權限系統視為達到全校教師實戰上線標準。

---

## 最近一次執行紀錄

| 日期 | 執行者 | D 組結果 | 備註 |
|---|---|---|---|
| 2026-07-29 | Claude（建置 `test/v2-rules-matrix.mjs`） | 26 通過 / 0 失敗（共 26 案） | 首次建立規則矩陣測試並完整跑過兩輪（除錯用）；`substituteRecords`/`operationLogs` 驗後計數已與基準值核對，詳見任務交付報告 |

> 每次重跑 D 組後在此表新增一列，不要覆蓋歷史紀錄，方便追溯規則修改前後的通過率變化。
