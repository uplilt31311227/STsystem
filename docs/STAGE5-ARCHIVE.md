---
created: 2026-07-31
updated: 2026-07-31
tags:
  - deployment
  - archival
---

# Stage 5 部署與操作 SOP：封存與生命週期工具

> 對應設計：[`RESEARCH-multitenancy-semester.md`](./RESEARCH-multitenancy-semester.md) §6.2（封存流程＋三個陷阱）、§6.5（operationLogs 衝突解法 b）、§8 路線圖 Stage 5。
> 目的：完成「保留 3 年 → 期滿匯出封存 → 從雲端刪除」的生命週期閉環。
> 前置：Stage 0-2 已完成（`isMember` 規則、有界訂閱、per-semester 課表、`semesterId` 欄位、學期唯讀鎖、學期切換 UI）。**本文件只涵蓋 Stage 5 新增的部分，不重複 Stage 0/1/2 的部署步驟（見 `docs/STAGE0-DEPLOY.md`）。**

## 本次新增了什麼

| 類別 | 內容 |
|---|---|
| `firestore.rules` | `schedules/{semesterId}` 的 `write` 拆成 `create/update`（維持原「僅目前學期」鎖）+ `delete`（新增，director 專用，僅能刪「非目前學期」）；新增 `archives/{semesterId}`（封存紀錄，create-only、不可改/刪，`note` 欄位加 `size()<500`）；`pendingRequests/{reqId}/private/detail` 的 `create`/`update` 補歷史學期唯讀鎖（opus 驗收 中5，比照 `substituteRecords` 側既有的 `parentAllowsNewPrivateDetail`/`parentSubstituteRecordCurrentSemester`） |
| `firestore.indexes.json` | **無變動**。封存用的新查詢皆刻意只用單欄位 `where('semesterId','==',...)`、不帶 `orderBy`，屬 Firestore 自動建立的單欄位索引，不需部署任何東西 |
| 前端 | 設定頁新增「資料封存」卡片（`v2-app.js` `renderArchiveAdminTab()`），director 專用：匯出 JSON → 選檔驗證（雜湊 + 筆數 + ID 集合比對）→ 二次確認刪除；已封存學期自動停用匯出/刪除鈕（opus 驗收 輕7+8） |
| 離線腳本 | `scripts/cleanup-operation-logs.js`（operationLogs 期滿清理，`--dry-run` 為預設行為，需 `--yes` 才實際刪除）|

## 部署順序（不可顛倒、且是強制順序，不是建議）

```
1. node scripts/firestore-deploy-rules.js --dry     # 先確認語法通過
2. node scripts/firestore-deploy-rules.js           # 正式發布
3. node scripts/firestore-deploy-rules.js --list     # 確認 release 已指向新 ruleset
4. git push preview feature/permission-system:main  # 部署前端
```

**規則必須先於前端部署，這是硬性要求，不是「比較保險」的建議**（opus 二輪驗收 中2 訂正）：`archives/{semesterId}` 是**全新集合**，舊規則裡完全沒有對應的 `match` 區塊——Firestore 對未匹配路徑預設 `DENY`，這條規則的缺席同時擋掉 `read` 與 `write`，不是只擋 `write`。

而 `renderArchiveAdminTab()`（輕7+8）在**匯出之前**就會呼叫 `dataSvc.getArchiveRecord()`（讀 `archives/{semesterId}`）判斷「這學期是否已經封存過」：
- 學期下拉選單每次切換都會呼叫一次（`syncArchiveSectionState()`）；讀取失敗時該函式會 fail-open（不假設已封存、不鎖匯出鈕），只顯示一則「無法確認此學期是否已封存過」的提示。
- 但按下「匯出此學期資料」按鈕時，`exportBtn` 的 click handler**會再呼叫一次 `getArchiveRecord()` 並在失敗時直接 `return`**（fail-closed，不放行匯出）——所以若規則還沒部署，`archives/` 集合的讀取請求全部收到 `permission-denied`，**匯出功能本身就會被擋下，不是只有刪除功能受影響**。

因此若前端先上線、規則還沒更新：整個「資料封存」頁在 director 眼中會呈現「按下匯出沒有反應、只跳出一則錯誤」的樣子（fail-closed，不會下載出一份殘缺或空白的 JSON），而不是「匯出正常、只有刪除失敗」——這是本文件先前版本的錯誤描述，已訂正。功能層面仍然安全（fail-closed，不會有資料風險），但使用者體驗上完全不可用，比原先評估的影響範圍更大，故部署順序沒有例外，兩步驟必須連續執行。

## 何時該做一次封存

依使用者設定的保留政策：**資料保留 3 年，之後匯出成檔案封存並從雲端移除**。

- 每學年結束後盤點：`(目前學年度 − 學期所屬學年度) >= 3` 的學期即為到期學期。
- 學期切換 SOP（`docs/STAGE0-DEPLOY.md`「Stage 2」一節、`RESEARCH-multitenancy-semester.md` §6.1）已確保切換後舊學期立即唯讀，故到期學期的資料在封存當下必然是穩定不變的（唯一例外是 director 透過 legacy 遷移路徑補寫歷史資料，屬人為操作、機率極低，見 §6.2 陷阱三與規則檔頭「信任根設計」說明）。
- **一次只封存一個學期**，且建議排在離峰時段。以下用報告 §7.1 的大校假設（`N`=3,000 筆調代課紀錄/學期、`M`≈0.3N=900 筆待審請求、`L`≈3N=9,000 筆操作日誌）實際核算一次完整「匯出→驗證→刪除」的讀取量（opus 驗收 中3 修正，訂正原版的粗估）：

  | 階段 | 讀取內容 | 筆數（大校估算） |
  |---|---|---|
  | 匯出（`collectSemesterArchiveData`，一次性，全量） | 課表 1 + 紀錄 N + 紀錄私有明細 ≤N + 請求 M + 請求私有明細 ≤M + 操作日誌 L | 1+3000+3000+900+900+9000 ≈ **16,801** |
  | 驗證（`fetchSemesterArchiveSnapshot`，僅筆數/ID 核對，不含 private/detail、不含 operationLogs，見中3） | 紀錄 N + 請求 M + 課表 1 | 3000+900+1 ≈ **3,901** |
  | 刪除前核對（同上函式再呼叫一次，結果直接重用去執行刪除，不再額外查詢一次刪除清單，見阻斷2） | 同驗證 | ≈ **3,901** |
  | **合計（一次完整流程）** | | **≈ 24,603**（Spark 每日 50,000 讀的約 49%） |

  這是本次 opus 驗收要求修正的部分——原始設計「驗證」「刪除前核對」兩步都各自重新查一次 operationLogs（大校 9,000 筆），且「刪除前核對」之後還會**再額外查一次**完整文件當作刪除清單（等於同一份資料在刪除前後被查了 3 次），合計約 46,503 讀（≈ 93% 每日配額，逼近單次操作就把全平台配額用掉的危險邊緣）。現版本移除了 operationLogs 的重複核對（理由：歷史學期的 operationLogs 在寫入規則下結構上不會再變動，見 `fetchSemesterArchiveSnapshot()` 註解）、並讓「刪除前核對」直接重用同一次查詢的結果去執行刪除（消除核對與實際刪除之間的競態窗口，見阻斷2），總讀取量降到約 24,603（**約 53% 的降幅**，相當於原本的 0.53 倍；沒有精確到「5 倍」這個數字，但已把單次封存操作的配額佔用從「逼近單日上限」降到「約半日配額」的量級，方向與效果一致）。
  - 匯出步驟本身的讀取量（16,801）無法再壓縮——它是唯一需要「完整內容」（含私有明細）的步驟，這是 §6.2 陷阱三本來就承認的固定成本，只能靠「一次只封存一個學期」「排在離峰」來管理，不能靠改查詢方式消除。

## 操作步驟（director，在「學校設定 → 資料封存」）

1. **選擇要封存的學期**（下拉選單，不含尚未有任何 `schedules/` 文件的學期）。
2. 按「匯出此學期資料」：
   - 畫面即時顯示進度（讀取課表 → 讀取紀錄 → 讀取紀錄私有明細 → 讀取待審請求 → 讀取待審請求私有明細 → 讀取操作日誌 → 計算雜湊 → 觸發下載）。
   - 完成後瀏覽器下載一個 `STsystem_封存_<學期>_<日期>.json` 檔案，**請立刻把這個檔案存到安全、有備份機制的位置**（校內共用雲端硬碟、備份磁碟等）——這是唯一離開瀏覽器記憶體的資料副本。
3. **選擇剛下載的那個檔案進行驗證**：
   - 系統計算檔案的 SHA-256，與匯出當下記在瀏覽器記憶體中的雜湊比對；同時重新向雲端查一次目前筆數，與匯出當下的筆數比對。
   - 任一項不符（檔案不對、內容被改過、雲端資料在匯出後又變動）都會顯示明確錯誤原因，且**不會**解鎖刪除——必須重新匯出。
4. 驗證通過後，在輸入框輸入該學期代碼（例如 `112-1`）以解鎖「刪除此學期雲端資料」按鈕。
5. 按下刪除按鈕，會出現最終確認 modal（列出將刪除的筆數、明確聲明操作日誌不會被刪除），確認後執行刪除。
6. 刪除完成後，系統自動寫入一筆 `archives/{semesterId}` 封存紀錄（筆數、SHA-256 雜湊、執行者、時間）與一筆 `operationLogs` 稽核日誌（`action: 'semester_archive'`），並重新整理封存頁畫面。

### 之後：清理 operationLogs（獨立於上述流程，另行排程）

上述 UI 流程**不會**刪除 `operationLogs`——client 端規則禁止刪除稽核軌跡（`allow update, delete: if false`），這是刻意設計（§6.5 解法 b：稽核軌跡的刪除權綁在需要 gcloud 憑證的離線流程，不放在應用層，見 `firestore.rules` 檔頭第 7 點）。匯出的 JSON 已包含該學期完整的操作日誌，供法規/稽核需要時查閱。

當日誌累積量成為儲存負擔（§7.2：大校 3 年約 21 MB 日誌，非急迫）、或政策要求連日誌也一併清空時，由系統管理者在個人電腦上執行：

```bash
# 1. 先跑 dry-run，核對將刪除的筆數與日期範圍（此模式一定會先匯出備份，但不會刪除任何資料）
node scripts/cleanup-operation-logs.js --before=2023-08-01

# 2. 確認「符合刪除條件」筆數與範圍正確、且「格式異常已略過」為 0（或已人工檢視過）後
node scripts/cleanup-operation-logs.js --before=2023-08-01 --yes
```

腳本會在執行前把即將刪除的文件完整匯出到 `backups/firestore/operationLogs-cleanup/<時間戳>/operationLogs.json`（無論是否帶 `--yes` 都會匯出，這是刪除前的安全網），詳見該檔檔頭註解（含「為什麼 gcloud REST 呼叫不受 client Security Rules 限制」的核實說明）。

**本次實作只撰寫此腳本，未執行、未刪除任何 operationLogs。**

## 驗證清單（規則部署完成後）

| # | 情境 | 操作 | 預期結果 |
|---|---|---|---|
| 5a | **規則部署完成後匯出正常** | director 對任一學期按「匯出此學期資料」 | 正常下載 JSON（`archives/` 的 `read` 規則已就緒，`getArchiveRecord()` 前置檢查通過） |
| 5b | **無法刪除目前學期** | 在選單中選到「（目前學期）」那一項 | 「刪除」區塊不出現（前端擋）；即使繞過前端直接呼叫 `deleteScheduleForSemester(目前學期)`，規則的 `!isCurrentSemester(...)` 也會回 `permission-denied` |
| 5c | **雜湊不符時無法解鎖刪除** | 匯出後，驗證步驟改選一個隨便修改過內容的 JSON 檔（或選錯檔案） | 顯示「雜湊不符」錯誤，刪除區塊維持鎖住 |
| 5d | **筆數/ID 漂移時無法解鎖刪除** | 匯出某歷史學期後，在驗證前用另一個帳號刪除該學期的一筆待審請求（若該學期還有殘留），再回來驗證；或反之在驗證通過、按下刪除前才變動 | 顯示「雲端資料在匯出後（或驗證後）已變動」錯誤（opus 驗收 阻斷2：不只比對筆數，也比對 ID 集合是否完全相同） |
| 5e | **封存紀錄不可改/刪** | director 在瀏覽器 console 對已封存學期的 `archives/{semesterId}` 嘗試 `updateDoc`/`deleteDoc` | 皆回 `permission-denied`（規則 `allow update, delete: if false`） |
| 5f | **operationLogs 清理腳本 dry-run** | `node scripts/cleanup-operation-logs.js --before=<日期>`（不帶 `--yes`） | 印出「符合刪除條件」「保留」「格式異常已略過」三組筆數，於 `backups/firestore/operationLogs-cleanup/` 寫入備份 JSON，**不刪除任何文件** |
| 5g | **匯出讀取失敗時不留半套匯出結果**（opus 驗收 阻斷1） | 匯出過程中人為中斷網路（例如瀏覽器 devtools 切離線模式）幾秒後恢復 | 匯出直接失敗並顯示錯誤（不下載檔案、不解鎖「驗證」區塊）；不會出現「下載了一份看似正常但實際殘缺」的 JSON |
| 5h | **已封存學期停用匯出/刪除**（opus 驗收 輕7+8） | 完成一次封存刪除後，回到學期選單選回剛封存的那個學期 | 該學期仍出現在選單中（`archives/` 集合併入選項），畫面顯示「此學期已於 … 封存並從雲端刪除」，匯出鈕停用、刪除區塊不出現 |
| 5i | **開新學期順序正確**（opus 驗收 輕13） | 規則部署完成後，director 執行一次「開新學期」 | 切換成功（`config.currentSemester` 先更新、`schedules/{toId}` 後建立，不會因為 `schedules/{toId}` 寫入時 `currentSemester` 還是舊值而被規則拒絕）；若刻意在 `saveSchedule(toId)` 那一步模擬失敗（例如斷網），應看到明確訊息「已切換到「toId」，但建立空白課表文件失敗」，而不是誤以為整個切換都沒發生，且畫面應出現「學期已切換，請重新整理」橫幅（opus 驗收 輕6：即使課表建立失敗，也要強制提示重新整理，避免本機 semesterState 已切換但即時訂閱仍綁定舊學期的半套狀態） |
| 5j | **規則未部署時，匯出（不只是刪除）會被擋下**（opus 二輪驗收 中2 訂正） | **只**推前端（跳過或回退規則部署），對任一學期按「匯出此學期資料」 | 匯出被中止並顯示「無法確認此學期是否已封存過，為安全起見中止匯出，請稍後再試」（`archives/` 集合在舊規則下無 `match`，`getArchiveRecord()` 的 `read` 收到 `permission-denied`）——**不會**下載出任何檔案，證實「規則必須先於前端部署」對匯出功能同樣是硬性要求，不是只影響刪除 |

## 已知限制與取捨

- **operationLogs 缺 `semesterId` 的舊文件**（Stage 2 之前、且未跑過 `scripts/backfill-semester-id.js` 回填的日誌）不會被封存匯出／清理腳本的 `where('semesterId','==',...)` 查詢比對到——這些日誌既不會被封存進 JSON，也不會被 `cleanup-operation-logs.js` 依學期方式處理（該腳本改依 `timestamp` 篩選，不受此限）。若需要盤點缺欄位的舊日誌，另行查詢 `operationLogs` 全集合比對即可，不在本次範圍。
- **一個惡意或被入侵的 director 帳號**可以在封存刪除前用 legacy 遷移路徑（`isDeclaredLegacyWrite`）對已封存學期補寫一筆「看似合法」的歷史紀錄，且封存流程本身找不到方法阻止「director 自己一手匯出、一手刪除」——這與系統既有的其他 director-only 破壞性操作（刪除任何紀錄、清除所有資料）同一信任層級，不是本次新增的破口。
- **雜湊驗證證明的是「這份檔案的位元組內容」，不證明「使用者已經把它安全保存」**——使用者可以在瀏覽器下載完成的瞬間就選擇同一個檔案回傳驗證，此時檔案可能還只存在瀏覽器的 Downloads 資料夾、尚未被搬到有備份機制的位置。這是純前端架構下的已知侷限（見 `RESEARCH-multitenancy-semester.md` 對「純前端無法防禦的攻擊面」章節的同一精神），操作步驟第 2 點已用文字提醒使用者，但無法用技術手段強制執行。
- **匯出鏈的「零容忍」錯誤處理只適用於封存情境**：`schoolDataService.js` 新增了 `getRecordDetailsBulkStrict()`/`getRequestDetailsBulkStrict()` 專供封存匯出使用——這兩支函式對任何讀取錯誤（含理論上不該發生的 `permission-denied`）一律 rethrow、不容忍地略過任何一筆，理由是封存的呼叫者恆是 director（`isApprover` 對其無條件放行 `private/detail` 讀取，正常情況下不可能合法遇到 `permission-denied`）。**這兩支函式不能被拿去給一般教師的 UI 使用**（例如紀錄列表補顯示假別的 `hydrateRecordsWithDetail()`）——一般教師讀不到跟自己無關的紀錄明細是預期行為，若誤用零容忍版本，會讓一般教師端因為讀到別人紀錄的 `permission-denied` 而整個列表渲染失敗。既有的一般版 `getRecordDetailsBulk()`/`getRequestDetailsBulk()` 維持原本「容忍 permission-denied/not-found」的行為，未受影響。
- **`fetchSemesterArchiveSnapshot()` 不核對 operationLogs 的理由依賴一個結構性假設**：歷史學期的 operationLogs 筆數不會再變動，前提是「沒有任何應用層路徑會對非目前學期的 operationLogs 集合新增文件」——這個前提目前成立（`operationLogger.js` 的 `log()` 一律蓋上 `semesterState` 當下值），但若未來新增了任何「補寫歷史日誌」的功能（類比 `legacyMigrationService` 對 `substituteRecords` 的做法），這個假設就會失效，需要重新評估是否要把 operationLogs 加回核對範圍。
