---
created: 2026-04-10
updated: 2026-11-10
tags:
  - deployment
---

# 部署文件：國中調代課自動化系統

## 部署環境總覽

| 環境 | URL | branch / repo | 說明 | 狀態 |
|------|-----|---------------|------|------|
| Production | GitHub Pages（本 repo master） | master | 組長穩定版1.0（v1.13.2） | 🟢 運行中 |
| Preview (V2) | https://uplilt31311227.github.io/STsystem-preview/ | STsystem-preview main（源自 feature/permission-system） | V2 權限系統（Phase 1-3：三層角色 + 全校課表共享 + 三種審核流程） | 🟢 已部署 |
| Development | http://localhost:8000 | — | 本地開發伺服器 | — |

> V2 預覽站點詳見 [`V2_PERMISSION_SYSTEM.md`](./V2_PERMISSION_SYSTEM.md)。
> 更新 Preview：`git push preview feature/permission-system:main`
>
> **回朔（rollback）**：每次更新 preview 前先把舊 main 存成備份分支。
> 2026-06-25 部署 Phase 1 前的備份點 = `90db3b4`（分支 `backup-pre-phase1-20260625`）。
> 2026-07-10 部署 Phase 3 前的備份點 = `614e4ff`（分支 `backup-pre-phase3-20260710`）；
> 2026-09-10 更新前的備份點 = `963eb69`（分支 `backup-pre-preview-update-20260910`，已推至 preview remote）。
> **2026-10-03 更新前的備份點 = `6cb4a96`（分支 `backup-pre-preview-update-20261003`，已推至 preview remote）。**
> **2026-11-05 更新前的備份點 = `1c96150`（分支 `backup-pre-preview-update-20261105`，已推至 preview remote）；rules 回朔點 = ruleset `4d39928b-c4ba-4184-a1fd-86bd23bdab5f`（v2.8，原文存 `backups/rules/firestore.rules.live-4d39928b`）；正式庫備份 `backups/firestore/20261105-203341`。**
> 同日 firestore.rules 已發布 release → ruleset `0ad89275-0df4-46c6-99c8-825a6cc94889`
> **現行線上 release：`6c56e3da-bb2d-4dd7-810e-edf7371bcb1f`（2026-11-07 發布，rules v2.11）**。前一版 `d14e145f`（2026-11-05，v2.10）；再前 `4d39928b`（2026-10-07，v2.8）。更早：`08bbfa7d-ad35-4285-b82e-8acff8463449`（2026-07-31 Stage 0-5 上線時發布；2026-09-10 以 `firestore-deploy-rules.js --list` 查證仍為目前 release，且 `firestore.rules` 最後一次變動亦在 2026-07-31，故本地與線上一致。前一版 `bd1a6f7a-d662-48cf-8d6d-d2f87c055aab`，2026-07-29 發布）
> （前一版 ruleset = `05f9b203-10fb-4df0-bef3-ecfec905fe16`，rules 回朔可用 Firebase Console 或 PATCH release 指回）。
> 一鍵回朔：`git push preview 90db3b4:main -f`（或 `git push preview backup-pre-phase1-20260625:main -f`）。
> ⚠️ Google 登入需 `uplilt31311227.github.io` 在 Firebase Console → Authentication → Settings → Authorized domains 內（preview 站既有，通常已授權）。

## 部署方式

### GitHub Pages

本專案為純前端應用，直接部署至 GitHub Pages：

1. 推送至 `master` 分支
2. GitHub Pages 自動部署 `index.html`

### 本地開發

```bash
# 方法一：Python HTTP Server
python -m http.server 8000

# 方法二：使用 start-server.py
python start-server.py
```

瀏覽器開啟 `http://localhost:8000`

## Firebase 設定

### 必要服務
- Firebase Authentication（Google 登入）
- Firestore Database（V2 資料同步；master 仍用 Realtime DB / users path）
- 專案：`stsystem-9d5fe`

### Firebase Config
Firebase config 為前端公開設定（非機密），已包含在 `index.html` 中。

### 帳單與自動斷線（2026-11-10 起）
- 2026-11-12 16:49（台灣）帳單綁定曾手動解除，22:05 重新綁定（原因見 ISSUES_LOG 2026-11-12）。斷線函式以 `DISARMED_UNTIL=2026-12-01T08:00:00Z` 暫停，**11 月剩餘期間無自動斷線**；函式執行環境改為 Node 22（Node 20 已停用）。
- stsystem-9d5fe 綁定帳單帳戶「STsystem」`<billing-account-id>`（Blaze）。
- 預算警報 TWD 250／300／500（只寄信）＋ **TWD 500 自動斷線**（2026-11-12 由 1000 調降）：Cloud Function `billing-kill-switch`（gen2，asia-east1，程式在 `cloud-functions/billing-kill-switch/`），當月實際花費達 500 即解除帳單綁定，全專案退回免費方案。觸發後的恢復步驟與重新部署指令見 [`BILLING-KILL-SWITCH.md`](./BILLING-KILL-SWITCH.md)。
- 本專案第一個也是唯一的伺服器端元件；不接觸 Firestore 資料。

### Firestore 安全規則
規則檔 `firestore.rules` 為 source of truth。部署：
```bash
node scripts/firestore-deploy-rules.js                              # 預設只印目標專案、git 分支與 commit、將做的事，不呼叫任何 API
node scripts/firestore-deploy-rules.js --list                       # 觀察目前 release 與最近 ruleset（唯讀）
node scripts/firestore-deploy-rules.js --dry                        # 只建立 ruleset 不發布
node scripts/firestore-deploy-rules.js --apply --confirm=stsystem-9d5fe   # 實際發布（confirm 必須等於目標專案 ID）
```
實際發布前腳本會檢查 git 工作樹（已追蹤檔案）必須乾淨，並印出目前 commit；不乾淨就拒絕。測試站用 `--project=<測試專案ID>`，`--confirm` 要填同一個 ID。
認證：透過 `gcloud auth print-access-token --account=<操作者信箱>`。操作者帳號**不寫死在 repo**，所有會呼叫 gcloud 的腳本（含 `firestore-deploy-rules.js`、`emergency-brake.js`）改由下列兩種方式之一提供，兩者都沒有就報錯並印出用法（`--account=` 優先）：
```bash
export STSYSTEM_GCLOUD_ACCOUNT=<操作者信箱>     # PowerShell：$env:STSYSTEM_GCLOUD_ACCOUNT = '<操作者信箱>'
node scripts/firestore-deploy-rules.js --list
node scripts/firestore-deploy-rules.js --list --account=<操作者信箱>
```
emulator 模式（設了 `FIRESTORE_EMULATOR_HOST`）不需要帳號。`firestore-bootstrap-inhu.js` 的主任白名單信箱用 `--director=<主任信箱>` 指定，沒給時沿用操作者帳號並印出提示；`bootstrap-platform-admin.js` 的 `addedBy` 取自操作者帳號。帳號格式只放行 `^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$`（它會進 gcloud 指令列，刻意不放行 `%` 以免 cmd 展開 `%VAR%`；Windows 的 gcloud 是 .cmd，故保留 shell 並以白名單把關，未改 `execFileSync`）。`test/v2-approval-flows.mjs`、`test/v2-verify-fixes.mjs`（對正式專案的舊式驗證腳本）同樣讀 `STSYSTEM_GCLOUD_ACCOUNT`，測試帳號以 plus-address（`<帳號>+v2t1@<網域>`）推導。

### 管理腳本（scripts/）的安全約定
- 會寫入或刪除的腳本一律**預設 dry-run**，要實際執行必須明確加 `--apply`（舊旗標 `--yes` 仍相容；`--apply` 與 `--dry-run`／`--dry-run=true` 同時出現時以 dry-run 為準；`--dry-run=false` 只代表「未指定 dry-run」，不等於 `--apply`，唯一例外是 `bootstrap-platform-admin`）。涵蓋：`backfill-semester-id`、`backfill-user-directory`、`firestore-backfill-emailindex`、`migrate-schedule-to-semester`、`firestore-bootstrap-inhu`、`cleanup-operation-logs`、`cleanup-orphan-mappings`、`create-indexes`、`firestore-backup.js restore`、`bootstrap-platform-admin`（建議寫法為 `--apply`；`--dry-run=false` 為相容寫法，等同 `--apply`；但只要同時出現 `--dry-run` 或 `--dry-run=true` 就一律不寫入）。
- 每支腳本啟動時先印「目標專案：<ID>（正式／非正式／emulator）」；唯讀腳本（`firestore-health-check`、`firestore-snapshot`、`firestore-backup.js` 備份）同樣印出。
- 緊急止血 `emergency-brake.js`：`--status` 唯讀；拉煞車 `--brake --apply`、解除 `--restore --apply`（`--yes` 仍相容）；裸執行只印用法。啟動即印目標專案。
- 對 emulator 驗證：設 `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` 後，上述腳本改打 emulator（專案固定 `demo-stsystem`、不呼叫 gcloud）；該變數只接受 127.0.0.1／localhost。
- 旗標解析與 dry-run 判斷集中在 `scripts/lib/script-safety.js`，單元測試為 `test/test-script-safety.mjs`（已掛進 `npm test`）。`firestore-deploy-rules.js` 與 `emergency-brake.js` 不支援 emulator，偵測到 `FIRESTORE_EMULATOR_HOST` 會直接拒絕。

詳細權限分層見 [`V2_PERMISSION_SYSTEM.md`](./V2_PERMISSION_SYSTEM.md)。

## 依賴

### 前端 CDN
- PapaParse 5.4.1 - CSV 解析
- SheetJS (xlsx) 0.20.3 - Excel 讀取（`cdn.sheetjs.com` 官方修補版；cdnjs 的 0.18.5 有 CVE-2023-30533／CVE-2024-22363 且已停止更新）
- jsPDF 3.0.3 - PDF 生成
- jsPDF-AutoTable 3.8.1 - PDF 表格
- html2canvas 1.4.1 - HTML 轉圖（PDF 中文支援）
- Firebase SDK 10.7.1 - 以動態 `import()` 自 `www.gstatic.com` 載入（無法加 SRI）

### 內容安全政策（CSP）與 SRI 維護規則（2026-11 P4 起）

`index.html` 以 `<meta http-equiv="Content-Security-Policy">` 限制可載入的來源，所有 CDN `<script>` 都鎖定確切版本並帶 `integrity="sha384-…"` 與 `crossorigin="anonymous"`。

- **新增或更換任何外部來源（CDN、字型、API、iframe）前，必須先更新 meta CSP 對應的指令**（`script-src`／`connect-src`／`frame-src`／`img-src`…），否則瀏覽器會直接擋下。不要用 `'unsafe-inline'`／`'unsafe-eval'` 放寬 `script-src`；函式庫若需要 eval，先回報再決定。
- 更換 CDN 函式庫版本時，要**實際下載該檔重新計算 sha384**（`openssl dgst -sha384 -binary 檔 | openssl base64 -A`），不可憑記憶填寫；版本號必須固定到 patch。
- 不可有 inline `<script>` 與 `onclick="…"` 之類的 inline 事件處理器；程式放到 `src/js/` 的模組或外部檔（`v2-redirect.js` 即為一例）。`style-src` 保留 `'unsafe-inline'`（專案有大量 inline style 屬性）。
- CSP 的 `connect-src` 內含 `http://127.0.0.1:9099`、`http://127.0.0.1:8080`：**這是本機 Firebase Emulator 專用**（`firebaseConfig.js` 只在 `localhost` + `?emu=1` 時連線），正式站不會用到，保留是為了讓同一份 `index.html` 能在本機跑 e2e；它們不會讓正式站多出攻擊面（只能連使用者本機）。
- meta CSP 不支援 `frame-ancestors`、`report-uri`；GitHub Pages 也無法設定回應標頭。
- 上線後第一次登入請檢查瀏覽器 console 有無 CSP 違規（Google 登入彈窗、App Check 的 reCAPTCHA、Firestore 長連線需連線才能驗證）。

### 本站不可被嵌入 iframe（2026-11 起的行為）

為了防範點擊劫持（審計 L4），`src/js/v2-redirect.js` 在頁面被嵌入 `<iframe>` 時會嘗試把最上層導回本頁，導不了就把整份文件隱藏（`display: none`）。因此**本站無法被其他網站（含自己的其他頁面）以 iframe 內嵌**；若日後有內嵌需求（例如儀表板），必須先修改該檔的框架偵測邏輯。

### rules v2.17（P9 批次 A2）：白名單主任失效、platformAdmin 最高管理員、核准職務分離

三項使用者決定（2026-11-17）：

1. **初始主任白名單在學校有正式主任後失效**（SB-L9）。`config/main.directorEstablished === true` 時 `isInitialDirector` 恆為 false，白名單的所有特例（bootstrap 建教師檔、補登自己 role、config 讀取後備、日誌 actor.role 後備）一併失效。旗標只進不退（client 不可改回 false、不可拿掉欄位、不可刪除已確立的 `config/main`）。旗標缺席視為尚未確立，行為與 v2.16 相同。前端 `authGuardV2` 在「教師檔為 director（或舊 admin）且已有 mapping」的使用者登入時自動補設旗標，涵蓋白名單 bootstrap、補登 role、他人經 setRole 或名冊匯入成為主任後的首次登入，以及既有正式庫主任的下一次登入；旗標為 true 時前端也不再走白名單分支。
2. **platformAdmin 為全系統最高、不可移除的管理員**。`isDirector`／`isApprover` 多一個 `isPlatformAdmin()` 分支，讀取走 `canReadSchool`（成員或 platformAdmin），在每所學校等同主任，不需是成員，不受該校名冊、角色、白名單、旗標、刪除操作影響。`platformAdmins/{uid}` 維持 client 完全不可寫（`allow write: if false`，create／update／delete 全擋）：主任、組長、platformAdmin 本人都不能新增、修改、撤銷任何 platformAdmin，所以「platformAdmin 建立 platformAdmin」的路徑本來就不存在，也沒有保留；新增只能由開發者以 `scripts/bootstrap-platform-admin.js`（Admin 憑證）執行。這取代檔頭第 9 點「platformAdmin 不能讀任何學校的 config」的舊設計。platformAdmin 沒有教師檔，前端以 uid 當 teacherId：`approvedBy`／`rejectedBy`／日誌 `actor.teacherId` 接受 uid。**核准開通新學校**（`approveApplication`）原本靠「config/main 對 platformAdmin 只有 create 權限」擋住覆寫既有學校，v2.17 起 platformAdmin 視同每校主任，rules 不再擋，前端改為建校前明確檢查 `config/main` 是否已存在（含不在 `schoolDirectory` 的既有學校如 `inhu`），已存在就中止。
3. **職務分離**（SB-I7）。核准者不可核准 `initiatedBy` 是自己的申請（登入 uid 或 mapping 的 teacherId），唯一例外是自我調課且不牽涉他人（`isSelfSwap`、換走與換進教師都是本人、沒有同意人）。組長代教師發起的申請 `initiatedBy` 是被代發的教師，不受影響。駁回不受限。platformAdmin 同樣適用。前端在自己發起的申請上停用「核准並產生 PDF」並顯示原因，`approveRequest` 也先擋下。**範圍說明與如實揭露（使用者已接受）**：職務分離只管走 `pendingRequests` 的核准轉換，定位是「防止誠實操作下的誤用」，不是安全邊界。組長／主任可直接「代發」（`adminCreate`）成立紀錄、不經核准；approver 以 approver 分支建立申請時可把 `initiatedBy` 填成別人或任意字串再自己核准；自我調課例外只比對 id（type 為「代課」、姓名寫別人也能被判成自我調課）。這些都不比「代發」多拿到任何能力，故不在 rules 堵。另：舊申請缺 `initiatedBy` 時，沒有成員身分的 platformAdmin 會被判成自己發起而無法核准（前端同樣停用並說明）。

**部署順序**：與 v2.13–v2.16 同一套程序，**前端與 rules 同時上線**（先推前端到 GitHub Pages、等建置完成後立刻發布 rules，兩個動作間隔以分鐘計）。相容性：

- 新 rules × 舊前端：旗標缺席時白名單行為不變；舊前端不會補旗標，也不認得 platformAdmin 選校；舊前端在自己發起的申請上仍顯示核准鈕，按下會被 rules 擋下（permission-denied）。唯一要避免的組合：旗標已設為 true（補旗標腳本已執行）之後，「白名單內但教師檔已降為一般教師」的人用舊前端登入，舊前端會嘗試補登 role 而被拒，登入流程丟錯——因此補旗標腳本請在新前端上線之後再執行。
- 新前端 × 舊 rules（空窗期）：寫 `directorEstablished` 在舊 rules 下允許但沒有作用；platformAdmin 進入學校會因舊 rules 拒讀而回到選校畫面並顯示原因（不影響一般使用者）；職務分離只有前端把關。

**部署後要做的事（新增步驟，依序）**：

1. 前端與 rules 同時上線（見上）。
2. **補旗標（既有正式庫必做）**：既有學校已經有主任但沒有旗標，白名單仍然有效。主任下次登入會自動補，但請不要等，用腳本一次補上（預設 dry-run，會列出判定為正式主任的人；沒有「已登入過的正式主任」時預設拒絕，避免學校只剩 platformAdmin 能管理）：
   ```bash
   node scripts/set-director-established.js --account=<操作者信箱> --school=inhu            # dry-run
   node scripts/set-director-established.js --account=<操作者信箱> --school=inhu --apply    # 實際寫入
   ```
   **建議上線當天就執行**，讓 inhu 重新取得 rules 層的保護（旗標未設前白名單仍有效）。旗標設好之後，「在白名單內但沒有教師檔」的人無法登入（不再能 bootstrap 自建），必須由主任在教師名冊替他建檔。
   之後在 Console 確認 `schools/inhu/config/main` 有 `directorEstablished: true`；用白名單內但已不是主任的帳號登入應讀不到 config。旗標要重設只能用 Admin 憑證手動處理（腳本不提供）。
3. **建立 platformAdmin**（⚠ platformAdmin 能代寫任一校的 `userMappings`，等於能接管任何身分，該帳號必須啟用 Google 兩步驟驗證；帳號信箱**絕對不寫進 repo**，只在執行時以參數給）：先請該帳號登入系統一次（讓 Auth 有這個使用者；或直接用 `--uid=`），再執行：
   ```bash
   node scripts/bootstrap-platform-admin.js --account=<操作者信箱> --email=<要成為 platformAdmin 的信箱> --note="說明"          # dry-run
   node scripts/bootstrap-platform-admin.js --account=<操作者信箱> --email=<要成為 platformAdmin 的信箱> --note="說明" --apply   # 實際寫入
   node scripts/bootstrap-platform-admin.js --account=<操作者信箱> --list                                                      # 確認名冊
   ```
   腳本已用 emulator 實測可完成建立（見 `test/emulator/scripts-p9-admin.mjs`）；`--remove` 仍受「最後一位管理者」保護。
4. **驗證**：platformAdmin 登入後出現「選擇要進入的學校」畫面，選校後頂端有「平台管理員模式」橫幅、右上角姓名欄顯示「平台管理員」（角色標籤顯示「教務主任」，表示以主任身分操作），能讀寫該校教師名單、核准他人申請；對自己發起的申請核准鈕為停用並有說明。
5. 前端可選擇「以一般教師身分登入我所屬的學校」（平台管理員兼任某校教師時使用）。

**文件存取與運算式上限實測**見 `test/emulator/probe-rules-limits.mjs` 與 CHANGELOG 2026-11-17 條目。

### rules v2.16（P9 批次 A）：教師檔欄位白名單、主任不可刪自己、private/detail 可刪

三項改動都在 `firestore.rules`：（1）教師檔 delete：主任不可刪自己的教師檔；（2）教師檔 update：教學組長只能改 `domains`、`homeroomClass`、`partTime`、`updatedAt`（教師管理頁會寫的欄位），改不了任何人的姓名、email、角色與其他欄位，主任權限不變；（3）`substituteRecords`、`pendingRequests` 底下 `private/detail` 的 delete：approver 可刪（紀錄側限目前學期），申請側另開放發起人本人（限未結案或已駁回；被邀請人不開放）。

**部署順序：v2.16 增量本身沒有順序要求；整體仍照下方 v2.13＋v2.14 的同時上線步驟（先推前端、緊接著發布 rules）。** 新前端在撤回、關閉駁回通知、刪除紀錄時，以交易或 batch 同時刪 `private/detail` 與父文件；舊 rules 下這一步會被拒，前端退回只刪父文件並留下操作日誌（action `detail_delete_failed`，僅在父文件已刪、明細沒刪成時記錄），不阻擋撤回與刪除。新前端送出有私有明細的申請時，父文件帶可選欄位 `hasDetail`（核准時若標記為真卻讀不到明細就中止），舊 rules 不認得此欄位，空窗期內送出申請會被拒，所以請依同時上線步驟處理。舊前端搭新 rules 沒有相容問題。日後教師檔新增「組長可編輯」的欄位，必須同步加進 rules 的 `isValidChiefTeacherPatch` 白名單，否則該欄位儲存會被拒。上線後確認：組長在教師管理頁改領域、導師班級、兼課可儲存；撤回一筆申請後該申請的 `private/detail` 一併消失。

### rules v2.15（P7）：逐人超鐘點門檻與九年級畢業設定

`config/settlement` 增加可選欄位 `weeklyBaseByTeacher`、新增 `config/grade9`。沒有新增順序約束：與 v2.13＋v2.14 同一批、與前端同時上線即可。舊 rules 下新前端儲存「九年級已畢業」會被拒；儲存逐人門檻（有填任何一筆時）也會被拒，但沒有填逐人門檻時只儲存週數，不帶該欄位，週數設定在舊 rules 下仍可儲存；新 rules 下舊前端不受影響。上線後第一次使用前，到設定頁確認「每人每週基本授課節數」與「九年級已畢業」可以儲存。月結算回頭結算其他學期的月份時，需要該學期的課表文件存在（`schedules/{學期}`），否則會提示找不到課表並中止；該學期課表文件存在但是空的（例如「開新學期」產生、尚未匯入課表的學期）也視為沒有課表，同樣中止。歷史學期為唯讀，無法補匯入課表。

### 部署順序：前端與 rules 同時上線（rules v2.13＋v2.14，P6 起）

舊 rules 的 `config/{docId}` 只允許主任（director）寫入；P6 的新前端在核准與組長代發時會寫 `config/recordsLock`，所以新前端遇到舊 rules 時，教學組長的核准與代發全部被拒。另一方面，rules v2.13 要求前端先上線（舊頁面寫課表會被新規則拒絕）。結論是兩者不能有先後，必須同時上線：

1. 部署前備份正式庫與現行 rules 原文（`backups/firestore/`、`backups/rules/`）。
2. 選上課日以外的時段。先把新前端 push 到 GitHub Pages 並等建置完成，**不要在中間停留**，緊接著發布 `firestore.rules`（`node scripts/firestore-deploy-rules.js --apply --confirm=<專案ID>`），兩個動作間隔以分鐘計。
3. 兩者之間的空窗期內，組長的核准與代發會暫時失敗（可重試）；教師送出帶假別事由的代課與調課申請也會被拒（v2.16 起，舊 rules 不認得 `hasDetail`），請教師稍後重送；舊頁面寫課表會被拒，請教務人員重新整理頁面。
4. 部署後確認：組長核准一筆測試申請成功、`config/recordsLock` 的 `seq` 有遞增、教師自我調課仍可成立。
5. 序號鎖的涵蓋範圍與例外見 `firestore.rules` 檔頭第 15 點。

### 開發工具
- Node.js (可選，用於本地開發)
- Python (可選，用於 HTTP server)

## 部署歷史

| 日期 | 版本 | 變更內容 |
|------|------|----------|
| 2026-03-27 | v1.6.0 | 多節課調代課功能 |
| 2026-04-09 | v1.7.0 | 教師課表手動編輯功能 |
| 2026-04-10 | v1.8.0 | 多重調課批次、任教領域編輯、衝突檢查 |
| 2026-04-13 | v1.9.0 | 全站緊湊布局改造、Toast 通知、備份還原 |
| 2026-04-20 | v2.0.0-alpha | V2 權限系統初版，部署至獨立 preview repo |
| 2026-04-29 | v2.0.0-alpha2 | Firestore 規則 v2.1（角色判讀）+ 部署/健康檢查腳本 + E2E checklist |
| 2026-06-25 | v2.0.0 Phase 1 | Preview 部署三層角色 + rules v2.2 資安修補（commit `e00e89f`）；回朔點 `90db3b4`（分支 `backup-pre-phase1-20260625`） |
| 2026-07-10 | v2.0.0 Phase 3 | Preview 部署三種審核流程分支（代課單簽／調課雙簽／多重調課全員同意）+ firestore.rules 資安收緊；回朔點 `614e4ff`（分支 `backup-pre-phase3-20260710`）；同日 rules 發布 release → ruleset `0ad89275-0df4-46c6-99c8-825a6cc94889`（前一版 `05f9b203-10fb-4df0-bef3-ecfec905fe16`） |
| 2026-07-29 | v2.0.0（開發中，基準線查核） | 商用上線前基準線：查證 Firebase Email/Password provider 已啟用（`signIn.email.enabled=true`）；production `schools/inhu` 資料現況盤點（teachers 29 筆、pendingRequests 0、substituteRecords 1 等）；feature 分支再次合併 master（commit `12f8bb4`），不再落後；preview 回朔點沿用 `614e4ff` |
| 2026-07-30 | v2.0.0（開發中） | Preview 部署教師管理表合併（V1 教師屬性表與 V2 帳號管理表併為單一表、全欄位即時自動儲存、欄位級權限分層）+ 新增教師防重與同名帳號檔刪除保護；回朔點 `f6a37a7`（分支 `backup-pre-teachers-merge-20260730`）、`717bb2c`（分支 `backup-pre-preview-update-20260730`）；firestore.rules 未變更，線上 ruleset 沿用 `bd1a6f7a-d662-48cf-8d6d-d2f87c055aab` |
| 2026-09-10 | v2.0.0（開發中） | Preview 站同步至 `52e004c`（先前停在 2026-07-30 的 `963eb69`，落後 30 個 commit）。本次內容：Stage 0-5 多租戶與學期生命週期、登入初始化競態與重複監聽器兩項修復、Emulator 情境測試 90 案與瀏覽器 e2e 28 案、LICENSE 與範例課表。回朔點 `963eb69`（分支 `backup-pre-preview-update-20260910`）；firestore.rules 自 2026-07-31 未再變動，線上 ruleset 沿用 `08bbfa7d-ad35-4285-b82e-8acff8463449`，本次無 rules 部署動作。Pages 建置狀態 `built`（commit `52e004c`），已 curl 驗證新增檔上線 |
| 2026-10-03 | v2.0.0（開發中） | Preview 站同步至 `6ef7115`（先前停在 2026-09-10 的 `6cb4a96`，落後 11 個 commit）。本次內容：代課推薦改五層順序（同科目→班導師→同任課班級→空堂→兼課）＋兼課教師欄位、多節代課班級聯改為每班一張、一般教師「原任課教師」鎖定本人、教師管理頁籤改 director 限定、CSS 相容別名移除、e2e-02 推薦標籤斷言修正。回朔點 `6cb4a96`（分支 `backup-pre-preview-update-20261003`，已推至 preview remote）；`firestore.rules` 自 2026-07-31 未再變動，線上 ruleset 沿用 `08bbfa7d-ad35-4285-b82e-8acff8463449`，本次無 rules 部署動作。**Production（master）刻意未動**，仍為 `6cb4a96`。Pages 建置狀態 `built`（commit `6ef7115`），已 curl 驗證線上 `recommendationEngine.js` 含「同任課班級」、`v2-app.js` 含 `applyOwnTeacherLock`、`tokens.css` 已無舊別名 |
| 2026-11-12 | preview | **Preview 站快轉至 `1e38682`（= master）**，補上 V1 寫入迴圈修正與 V1 轉址（先前停在 `7a215d4`，為 11/11 迴圈再發的來源，見 ISSUES_LOG 2026-11-12）。回朔點 `7a215d4`（分支 `backup-pre-preview-update-20261112`，已推至 preview remote）。Pages `built`，curl 確認線上 `app.js`／`dataManager.js` 含 `fromRealtime`。同日帳單綁定手動解除後於 22:05 重新綁定、斷線預算調為 TWD 500、斷線函式改 Node 22 重新部署（revision `billing-kill-switch-00005-quk`）並暫停至 12/1。 |
| 2026-11-07 | rules v2.11 | **Firestore rules v2.11 部署至正式專案**（使用者本人執行 `node scripts/firestore-deploy-rules.js`）：release → ruleset `6c56e3da-bb2d-4dd7-810e-edf7371bcb1f`（前一版 `d14e145f`，v2.10）。內容：組長可刪除目前學期的 substituteRecords（歷史學期仍限主任）。完整下載線上原文與本地 firestore.rules 比對一致；兩版原文存 `backups/rules/`。前端不需更新。 |
| 2026-11-07 | v1.14.3 / v2.0.0 | **Production（master）快轉至 `886c3fe`**（前一版 `93849b4`）：V2 多重調課核准／重印改整批淨結果、駁回撤回收尾。push 觸發的 Pages 部署因 GitHub 端「Deployment failed, try again later」失敗，rerun 再因同 run 重複 github-pages artifact 失敗；改以 workflow_dispatch 重新部署成功（run 42340766034），curl 確認新模組上線、無頭瀏覽器載入 V1／V2 無新錯誤。⚠ 日後部署失敗請直接 workflow_dispatch，不要 rerun --failed。 |
| 2026-11-06 | v1.14.3 / v2.0.0 | **Production（master）快轉至 `d73c923`**（前一版 `5cebe2b`，回朔分支 `backup-pre-prod-merge-20261105`）：feature 分支全部上線——課表匯入日期與版本紀錄、10/22 P0／P1、空課表狀態修正、多重調課通知單（master 原有）與合併驗收修正（待同意不產 PDF、批次 await、PDF XSS 入口跳脫）。rules 沿用 v2.10（`d14e145f`，11/05 已部署）。CI Test 與 Pages deploy 皆 success；curl 確認新模組與修正已上線；無頭瀏覽器載入 V1／V2 無新錯誤。Preview 同步至同版。 |
| 2026-11-05 | v2.0.0（開發中） | **rules v2.10 部署至正式專案**（含 v2.9 主任不可改自己 role、v2.10 `schedules/{semesterId}/imports` 子集合），release → ruleset `d14e145f-2111-4112-9762-b244ab22dcd4`（前一版 `4d39928b`，v2.8；與線上原文比對，非註解差異僅這兩處，對現行正式站 client 相容）。Preview 站同步至 `49eb867`（先前停在 2026-10-03 的 `1c96150`）：課表匯入日期與版本紀錄（可還原）、10/22 P0／P1 修正。部署前備份：正式庫 `backups/firestore/20261105-203341`、rules 原文 `backups/rules/`、preview 分支 `backup-pre-preview-update-20261105`、tag `pre-import-history-deploy-20261105`。Pages 建置 `built`（`49eb867`），無頭瀏覽器載入 V1／V2 無新錯誤。**Production（master）未動**。⚠ preview 與正式站共用 Firestore `stsystem-9d5fe`，在 preview 操作即寫入正式資料。同日再同步至 `acc3e15`（修正雲端空課表時畫面殘留本機舊課表數字），Pages `built` 並 curl 確認上線 |
| 2026-09-10 | v1.13.8 / v2.0.0（開發中） | **Production（master）** 合併 `feature/permission-system`（merge `59647c7`）：登入初始化競態與 `initAuthService()` 重複掛監聽器兩項修復上線；其餘為 test/ 與 docs/，`index.html`、`firestore.rules` 未變動，線上 ruleset 沿用 `08bbfa7d`。另修 CI（`464e69c`）：test workflow 補 `npm install`，修復 `npm test` 找不到 papaparse。驗證：CI Test success、Pages deploy job success、線上 authService.js 已含 `ensureFirebaseReady`、瀏覽器實測正式站 console 無錯 |
