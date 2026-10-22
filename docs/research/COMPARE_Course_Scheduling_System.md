# 深度比對：STsystem vs begin0808/Course_Scheduling_System

- 比對日期：2026-10-22
- 對象：STsystem `feature/permission-system`（4432c82） vs [begin0808/Course_Scheduling_System](https://github.com/begin0808/Course_Scheduling_System) v1.3.5（944fa03，2026-10-21）
- 方法：4 個面向分別讀碼比對，只讀兩邊程式碼，沒有實際執行。主對話抽查了 §6 標「已驗證」的項目。
- 縮寫：**A** = STsystem；**B** = Course_Scheduling_System（行號相對於 `backend/app/`）

---

## 0. 一頁結論

| | A（STsystem） | B（Course_Scheduling_System） |
|---|---|---|
| 核心定位 | 調代課與簽核流程，課表來自人力資源網 2.0 | 排課（CP-SAT）加調代課的完整系統 |
| 架構 | 純前端 + Firestore，授權寫在 `firestore.rules` | FastAPI + PostgreSQL + Redis/RQ，授權在 API 層 |
| 部署 | GitHub Pages，零維運，多租戶 | Docker 自架，一校一套 |
| 判斷空堂的依據 | **只看週課表**（星期＋節次） | **看特定日期**：週課表 + 當日假單時間窗 + 當日已接手 + 單雙週 |
| 請假模型 | 沒有假單，一筆紀錄 = 一節處置 | 假單 → 受影響節次快照 → 處置，三層，有狀態機 |
| 流程哲學 | 簽核：代課單簽、調課雙簽、多重調課全員同意 | 組長指派即生效，再用站內與 Email 通知請老師確認 |
| 月結 | 實際授課時數與超鐘點，依假別決定是否扣被代者 | 代課費請領節數，分鐘點／日薪／不計費 |
| 測試 | 單元測試、emulator rules 測試、本機 e2e 00–08 | 692 項 pytest、54 項 Playwright，CI 跑完整 Docker 環境 |

**一句話**：A 的優勢在流程治理（簽核、稽核、多租戶、資料層授權），B 的優勢在**依日期判斷可用性**，以及調代課處置的多樣性。B 大多數演算法是純運算，**可以改寫成前端 JS，不需要加後端**。

---

## 1. 代課推薦與可用性

### 1.1 比較
| 面向 | A | B |
|---|---|---|
| 判斷空堂 | 週課表上星期與節次字串相同就算有課（`recommendationEngine.js:143-147`） | 牆鐘時間區間重疊＋單雙週＋當日假單＋當日已接手（`services/availability.py:42-48,173-233,259-287`） |
| 排除當天自己也請假的人 | **沒有**。`getAssignedTeachers` 只看 substitute/swapTeacher（`recommendationEngine.js:161-172`） | 有。直接讀假單日期窗，所以「整天請假但這節剛好空堂」的老師也會被擋（`availability.py:173-196`） |
| 排除同節已被派代課 | 有（同日同節）；V2 連待同意、待核准中的請求也算（`v2-app.js:3736-3750`） | 有，含調課補課方，並排除已銷假的節次 |
| 排序因子 | 同科目 1000 > 導師 300 > 同班 100 > 同領域 5；兼課 −10000（`:21-28`） | 依序比：同科目 → 當天已在校 → **本月代課較少** → 姓名（`substitution_recommender.py:33-40`） |
| 公平性 | `adjustForFrequency`（`:395`）**沒有任何地方呼叫，是死碼** | 本月計費代課節數，越少越前面（`:66-88`） |
| 無人可代時 | 只顯示「該時段無可用的代課教師」（`app.js:2347`） | 提示「全校 N 位都無法代課，建議併班或自習」，並列出併班候選（`:141-202`） |
| 名稱容錯 | 強：701 ↔ 7年1班、國語 ↔ 國文、名單外教師補入（`:99-112,292-385`） | 用 id 比對，不需要容錯 |
| 測試 | `test-recommendation.mjs` 約 12 個斷言 | `test_substitutions.py` 800 行 |

### 1.2 結論
A 的排序因子比 B 更貼近現場（導師、同班、兼課、領域別名）。B 的優勢在**硬性過濾的精確度**，以及**公平性**。

---

## 2. 調課、請假與處置流程

### 2.1 資料模型
- **B**：`LeaveRequest`（含半天時間窗，可銷假）→ `AffectedPeriod`（依已發布課表自動展開，連堂逐節，狀態 pending/resolved/completed/cancelled）→ `Substitution`（type 有 substitute/swap/merge/self_study/cancel 五種；一節最多一筆處置，改派時更新同一筆）。
- **A**：沒有假單層。使用者在課表上逐節點選，一筆 record 就是一節；調課一筆帶兩個時段（`app.js:3084-3112`）。狀態機只存在 V2 的 pendingRequest。教師以姓名字串比對。

### 2.2 調課
| | A | B |
|---|---|---|
| 語意 | 同班兩位老師雙向互換，一筆紀錄兩端同時生效 | 乙代甲上課，甲日後還乙一節（單向補償） |
| 找對調節次 | 使用者先選時段 B 的日期，系統再列出同班當天的課（`app.js:1555-1577`） | **自動搜尋** 2 至 4 週內的可行節次，同班優先、日期近的優先，連堂中任一節可單獨換（`swap_options.py`） |
| 衝堂驗證 | `checkSwapConflict` **只看週課表**（`app.js:1676-1714`），不看日期、當天請假、已被指派的節次、學期範圍 | 全部依日期驗證：雙方當天有空、補課日在學期內且未過去、單雙週有課、該格未被別人換走（`substitutions.py:221-292`） |
| 多重調課 | **有**：整批視為同時移動，模擬累積後的衝突（`app.js:3220-3345`），V2 需全員同意 | 沒有 |

### 2.3 B 獨有的處置方式
- 併班、自習、不處理（`models/substitution.py`）。
- 整批指派，例如整張假單或一整天派給同一位老師；派不成的部分會列出原因（`substitutions.py:134-180`）。
- 銷假連動：未上的節次轉為取消，通知相關老師，補課格自動釋放（`services/leaves.py` cancel）。
- 今日看板：全校當日處置，加上補課日反向列（`substitution_log.py`、`DailyBoard.vue`）。
- 即時概況：現在這一節各班是誰在上（`live_overview.py`）。

### 2.4 A 較優之處
- 簽核與並發安全：核准用 `runTransaction`，駁回採 soft-reject，rules 層有狀態機鎖（`pendingRequestService.js`、`schemaConstants.js:152-170`）。B 沒有「老師之間互相同意」的機制。
- 假別與事由放在 `private/detail` 並設 ACL（`schoolDataService.js:39-71`）。
- 多重調課累積衝突模擬。

---

## 3. 月結算、通知單與匯出

### 3.1 兩邊回答的是不同問題
- **A**：老師這個月**實際上了幾小時、超鐘點多少**。算法是每週節數 × 週數 + 代課 − 被代課，再和 20 × 週數比較（`settlementCalculator.js:51-93`）。
- **B**：老師這個月**代了幾節、其中幾節要付代課費**（`substitution_stats.py`）。B 的超鐘點只出現在排課階段的配課檢核（`assignments.py:147-207`）。

### 3.2 會讓數字算出來不一樣的口徑差異
1. **A 的基本鐘點全校固定 20**（`settlementCalculator.js:25,74`）。導師或有行政減課的老師基本鐘點較低，所以會**少算超鐘點**。B 每位老師各自設定 `base_periods − admin_reduction`。
2. **A 用每月週數推估**原定時數（可逐月覆寫，也能從行事曆帶入）。B 逐節依實際日期計數，所以颱風假、補假會自然被排除。
3. **A 的計算器不檢查 status**，等於完全依賴資料層只交出已成立的紀錄（`test-settlement.mjs:100-106` 已標為 knownGap）。B 在查詢時就排除 cancelled。
4. **寒暑假時數變負數**：7、8 月週數是 0，但若有暑輔代課紀錄，實際時數會出現負數（`test-settlement.mjs:125-128` knownGap）。
5. 單雙週的課：A 會算成每週一節，B 算半節。

### 3.3 A 獨有
- 月實際時數與超鐘點計算。
- 公假、長病、喪假不扣被代者（`:36-40,224-242`）。
- 週數可設定並從行事曆帶入。
- 可直接匯入人力資源網 2.0 的課表。
- 手算黃金資料測試。

### 3.4 B 獨有
- 代課計費三態（鐘點／日薪／不計），每筆可設 `counts_toward_hours` 與 `funding_source`。
- 月結 Excel 分「彙總」和「明細」兩頁（`substitution_stats.py:209-241`）。
- **巡堂表**（`patrol_sheets.py`），可另存成能編輯的 Excel。
- 週課表式的教師／班級通知單，只標出異動格，跨週一週一頁。
- 通知單用 `window.print()` 輸出向量文字。A 是 html2canvas 轉成圖片的 PDF，文字無法選取、檔案也較大。
- PNG 匯出、全校總表、zip 批次匯出。
- 匯入時逐列回報錯誤。A 匯入時只把跳過的列寫進 `console.warn`（`scheduleParser.js:197-200`），使用者看不到。

---

## 4. 權限、通知、學期與工程

### 4.1 B 有、A 沒有
- **通知中心**：站內通知、確認收到、組長看板、再次提醒、Email（`api/notifications.py`、`services/email.py`）。
- **開新學期可選擇複製**節次表、科目、教師、班級，年級自動升級（`semester_copy.py`）。A 開新學期只建一個空殼（`v2-app.js:1990-2065`）。
- 帳號停用而非刪除（`api/users.py:199-215`）。
- 最後一位管理員保護、不可降級或停用自己（`api/users.py:107-160`）。
- 登入鎖定、密碼長度政策、改密碼後舊 session 全部失效。
- 備份 UI、每日自動備份、還原前先自動備份、還原後強制所有人重新登入。
- 一鍵示範資料、新版本提醒。
- 完整 CI：型別檢查、DB 遷移驗證、全棧 Playwright、文件與程式同步檢查、映像檔發布。

### 4.2 A 有、B 沒有
- 多租戶：schoolId 隔離、申請制開通、platformAdmin。
- **授權強制在資料層**，有欄位白名單和狀態機；歷史學期唯讀鎖（`firestore.rules:21-49`）。
- 學期封存：匯出 → 核對雜湊 → 刪除 → 留下不可竄改的封存紀錄。
- **稽核日誌不可改、不可刪**，記錄 before/after。B 的 `api/users.py` 對帳號異動完全沒寫稽核。
- 用真 emulator 驗證多校資料隔離。
- 支出煞車 `scripts/emergency-brake.js`、App Check。

---

## 5. 建議移植路線圖

依「效益 ÷ 成本」排序。全部可以在**純前端 + Firestore** 完成，Email 例外。

### P0：讀碼發現的現存缺口（建議優先處理）
| # | 項目 | 改哪裡 | 難度 |
|---|---|---|---|
| 1 | **核准時重新檢查衝堂**。`approveRequest` 只確認 status，申請擱置期間若該節已被別人佔走，核准後會變成雙重指派 | `pendingRequestService.js:242`，在交易前先查衝堂（避開 rules 配額問題） | 中 |
| 2 | **調課衝堂檢查要看日期**。目前只看週課表，送出前也沒有像代課那樣的 fail-safe | `app.js:1676-1714`、`app.js:2723` | 中 |
| 3 | **推薦時排除或標註當天自己也請假的老師**（同一天已被登記為某節原任課教師的人）。先做標註，不硬性排除，因為可能是半天假 | `recommendationEngine.js:161-172` | 低 |
| 4 | **月結計算器加 status 防線，寒暑假時數歸零** | `settlementCalculator.js:71,149-152,207-242`，並移除兩個 knownGap | 低 |

### P1：低成本、高感受
| # | 項目 | 改哪裡 | 難度 |
|---|---|---|---|
| 5 | 推薦加「本月已代 N 節」公平排序，放在同一層內當 tie-break，並移除死碼 `adjustForFrequency` | `recommendationEngine.js`、`app.js:2316-2337` | 低 |
| 6 | 無人可代時給出「建議併班或自習」提示，並列出併班候選（同年級優先） | `app.js:2347`，新增 `getMergeOptions` | 低 |
| 7 | 推薦和送出前攔截改用同一個衝堂函式，回傳結構化原因 | 從 `dataManager.js:606` 抽出 | 低 |
| 8 | 課表匯入時把被跳過的列顯示給使用者看 | `scheduleParser.js:197-200` | 低 |
| 9 | 月結 Excel 加逐節明細工作表 | `settlementCalculator.js:302-359`，重用 `getSubstituteDetails` | 低 |
| 10 | 角色異動護欄：主任不可修改自己的角色 | `firestore.rules:496-498`、`teacherAccountManager.js:252-270` | 低 |

### P2：中型功能
| # | 項目 | 難度 |
|---|---|---|
| 11 | 今日調代課看板，含補課日反向列，可列印 A4 | 低～中 |
| 12 | 開新學期可選擇複製上學期資料（與 `PLAN_grade9_graduation.md` 協調） | 中 |
| 13 | 每位老師個別基本鐘點與減課，取代全校固定 20（**會改變超鐘點數字**） | 中 |
| 14 | 調課候選自動搜尋，範圍 2 至 4 週 | 中 |
| 15 | 站內通知與確認收到，用 onSnapshot 即時推送（比 B 的輪詢更好） | 中 |
| 16 | 帳號停用（`isActive`），rules 的 `isMember` 一起檢查 | 中 |
| 17 | 巡堂表列印 | 中 |
| 18 | 通知單改成 `window.print()` 向量文字 | 中 |
| 19 | 併班、自習作為正式處置類型（要同步改 rules、月結、PDF） | 中 |
| 20 | CI 加跑 emulator rules 測試 | 中 |

### 不建議移植
- 自動排課與排課硬約束：人力資源網已經負責排課。
- 假單三層模型：效益高，但等於重寫資料模型。建議先做 P0-3 的近似版。
- 單雙週：要先確認人力資源網匯出的資料有沒有這個欄位，以及貴校是否真的有隔週上的課。
- 日薪代課：國小較常見，國中用得少。
- Redis 強制登出、pg_dump 備份 UI、版本提醒：架構不同，或用不到。
- Email 通知：需要 Cloud Functions（得升級 Blaze 方案），或把 Apps Script 改成 Web App。和純前端的定位衝突，等站內通知做完再評估。

---

## 6. 驗證狀態
- 主對話已讀碼確認：
  - `adjustForFrequency` 沒有呼叫端。
  - `saveAndProcessRecord` 只對 `type==='代課'` 做衝堂攔截。
  - `approveRequest` 交易內只檢查 status。
  - `getAssignedTeachers` 不排除當天也請假的原任課教師。
  - 月結 status 與寒暑假兩個 knownGap 存在。
- 以下是推測，尚未實測：
  - P0-1 的雙重指派是否真的會發生。
  - B 的匯出中文品質。
  - 人力資源網的匯出有沒有單雙週欄位。
