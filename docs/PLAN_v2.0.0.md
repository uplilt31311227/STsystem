---
created: 2026-05-29
updated: 2026-05-29
tags:
  - plan
  - v2.0.0
  - permissions
status: 規劃中（等待 V2 路徑裁決）
---

# v2.0.0 多角色協作 + 審核工作流升級計畫

> 目標版本：v2.0.0｜主分支：`feature/permission-system`｜建立日期：2026-05-29
> 本文件由 master 與 feature 分支共用，中斷後回來可直接接續。

---

## 0. 進度索引（每次工作前先看這裡）

| 階段 | 狀態 | 完成日 | 備註 |
|---|---|---|---|
| Phase 0：master 備份 + tag | ✅ 完成 | 2026-05-29 | tag `v1.11.0-stable`、commit `2f274b5` |
| V2 評估報告 | ✅ 完成 | 2026-05-29 | 見下方 §1 |
| V2 路徑裁決 | ⏳ 待裁決 | — | 接續 / 重寫 / 混合 |
| Phase 1：基礎建設（三層角色 + roster） | ⏸️ 等裁決 | — | |
| Phase 2：全校課表共享 | ⏸️ | — | |
| Phase 3：申請與審核工作流 | ⏸️ | — | |
| Phase 4：對調同意 + 多重調課 | ⏸️ | — | |
| Phase 5：資料遷移 + Legacy | ⏸️ | — | |
| Phase 6：通知精緻化 + 審計 | ⏸️ | — | |
| 合回 master + v2.0.0 tag | ⏸️ | — | |

---

## 1. V2 評估摘要（2026-05-29 Explore agent 報告結論）

`feature/permission-system` 分支從 2026-04-20 起已有 14 commit、3400+ 行程式碼，已實作：

**已具備（不必重做）**
- V2 啟用切換（`?v2=1` / preview 子站）
- Google 登入 + email 配對 + 拒絕未授權（`authGuardV2.js`）
- 2 層角色判讀（`roleService.js`：admin / teacher）
- 全校資料 CRUD + 即時訂閱（`schoolDataService.js`，280 行）
- 單簽審核流程狀態機（`pendingRequestService.js`，227 行）
- 教師白名單管理 + 舊資料匯入（`teacherAccountManager.js`）
- 統一 audit log（`operationLogger.js`）
- `firestore.rules` v2.1（204 行，已部署 preview）
- 部署/健康檢查/快照腳本（`scripts/firestore-*.js`）
- 完整 E2E checklist 文件（`docs/V2_E2E_CHECKLIST.md`）

**需補齊（接續路徑）**
| 項目 | 工時 |
|---|---|
| 三層角色（admin → director + section_chief + teacher） | 1.5 人天 |
| schoolId 從 `default` 改 `inhu` | 0.5 人天 |
| 代課單簽 / 調課雙簽 / 多重全員 三流分支 | 2 人天 |
| Director 教師白名單批次匯入 UI | 1 人天 |
| E2E 驗收三層角色 + 部署 | 0.5 人天 |
| 合回 master + envDetector 關閉 + v2.0.0 tag | 0.5 人天 |
| **接續總計** | **6 人天** |

**重寫路徑（依本文 Phase 1-6 從零）**：12-14 人天

**Explore agent 建議**：採「接續」路徑。V2 模組解耦度高，核心改動限於常量擴充與 service 內判斷邏輯擴充，外科手術風險低；現有 firestore.rules 已實戰測試，僅需新增 OR 條件。

**前三個必做步驟（若採接續）**
1. 擴充 `src/js/modules/v2/schemaConstants.js`：`SCHOOL_ID = 'inhu'`、`ROLES` 加 `DIRECTOR` 與 `SECTION_CHIEF`、新增 `REQUEST_TYPES`
2. 擴充 `roleService.js`：`isDirector()`、`isSectionChief()`、`isApprover()`、`canManageRoster()`
3. 擴充 `pendingRequestService.js`：接收 `requestType`、依類型分流（substitute 單簽、swap 雙簽、multi_swap 全員）+ `pendingConsentTeacherIds` 陣列

---

## 2. Context（為何要做）

STsystem 目前是 v1.11.0 的「單使用者本機/雲端工具」：每位 Google 登入者各自一份 `users/{uid}/data/substituteSystem`，所有調代課紀錄送出即生效、無審核、無角色。要落地到全校共用——讓教務主任、組長、一般教師三方都進系統操作——目前的資料隔離模型與無審核流程已成為瓶頸。

本次升級解決三個核心問題：
1. **資料共享**：把每人各自的資料合併成「全校共用一份課表 + 一份紀錄」
2. **角色權限**：教務主任、教學組長、一般教師各有不同可見範圍與操作權
3. **發起 → 同意 → 核准工作流**：代課單簽、調課雙簽、多重調課全員同意

期望成果：v1.11.0 所有功能（智慧推薦、衝突檢查、一式四聯 PDF、週彙整 PDF、月結算）邏輯完全保留，資料來源從「個人雲端」改為「全校共用 + 經過審核」。

**使用者已確認的決策**：
- 審核流程：彈性混合（代課單簽、調課雙簽、多重全員）
- 教師權限：中度（可看全校課表唯讀，只能動自己相關紀錄）
- 學校範圍：單校（內湖國中），Firestore 路徑預留 `schools/{schoolId}/`
- 身份綁定：Google 登入 + 主任預匯入清單自動 email 配對

**三種角色定義**
- **director**（教務主任）：最高權限，所有功能 + 後台教師管理 + 學校設定 + 課表上傳
- **section_chief**（教學組長）：核准/駁回申請、上傳課表、查看所有紀錄、月結算
- **teacher**（一般教師）：看全校課表（唯讀）、申請自己的代調課、回應對調邀請、查自己相關紀錄

> director 與 section_chief 在「核准/駁回」層級權限相同，差別僅在後台管理（教師名單、學校設定）只有 director 能改。

---

## 3. Phase 0 — 備份目前專案狀態 ✅

**已完成於 2026-05-29**：
- commit `2f274b5`：補追蹤工具腳本（start-server、pyproject、uv.lock、HANDOVER、compare_*、etl_*、verify_etl、test/run_tests.py 等 17 檔，+1481 行）
- 擴 `.gitignore` 排除暫時性產物（analysis.txt、*_log.txt、test-results/、*.xls、schedule_*_export.csv）
- 新增 `docs/backup/README.md`（v1.11.0 baseline JSON 存放區，個資不進 git）
- tag `v1.11.0-stable`（可隨時 `git checkout v1.11.0-stable` 回滾）

待處理（每次主要 Phase 完成後執行一次）：
- 主任 / 組長手動匯出 v1.11.0 baseline JSON → 放 `docs/backup/v1.11.0-baseline-YYYY-MM-DD.json`

---

## 4. 整體架構決策

### Firestore 資料模型

採「接續」路徑：沿用 V2 現有的 `schools/{schoolId}/` 結構，補三層角色與審核流分支。

```
schools/inhu                              ← schoolId 從 default 改為 inhu
  ├─ config/main                          ← 學校設定（含 initialAdminEmails → 改為 initialDirectorEmails）
  ├─ teachers/{teacherId}                 ← 教師白名單（沿用 V2，加 role: director/section_chief/teacher）
  ├─ userMappings/{uid}                   ← uid ↔ teacherId 綁定（沿用 V2）
  ├─ schedule/current                     ← 全校課表（沿用 V2，單一 doc）
  ├─ substituteRequests/{requestId}       ← 申請草稿（擴充：requestType + pendingConsentTeacherIds）
  ├─ substituteRecords/{recordId}         ← 正式紀錄（沿用 V2）
  └─ operationLogs/{logId}                ← audit log（沿用 V2）
```

**沿用 V2** 的關鍵設計：
- schedule 用單一 doc 內嵌 entries 陣列（全校讀一次）
- pendingConsentTeacherIds 平行字串陣列配 `array-contains` 查詢
- operationLogs 統一寫入點
- Firebase Emulator 配 firestore.rules 測試

### Firestore 安全規則骨架（v2.2，從 V2 v2.1 擴充）

```
function userMapping(s)   = get(schools/{s}/userMappings/{auth.uid})
function myTeacherId(s)   = userMapping(s).data.linkedTeacherId
function teacherDoc(s, t) = get(schools/{s}/teachers/{t})
function role(s)          = teacherDoc(s, myTeacherId(s)).data.role
function isDirector(s)    = role(s) == 'director'
function isApprover(s)    = role(s) in ['director','section_chief']

teachers:
  - read: 有 mapping
  - create/update/delete: isDirector  ← V2 從 isAdmin 改為 isDirector
  - 例外: 首次 director 登入可 bootstrap 自己（email 在 initialDirectorEmails）

schedule: read=有 mapping, write=isApprover  ← V2 從 isAdmin 改為 isApprover

substituteRequests:
  - read: applicant or in pendingConsentTeacherIds or isApprover
  - create: applicantUid==auth.uid 且 status in [pending_swap_consent, pending_approval]
  - update (對調同意): auth.uid 對應 teacherId in pendingConsentTeacherIds，僅能改 swapConsents/status
  - update (核准/駁回): isApprover 且 approverUid==auth.uid
  - update (撤回): applicantUid==auth.uid 且 status → cancelled
  - delete: isDirector

substituteRecords: read=有 mapping, create/update=isApprover, delete=isDirector
operationLogs: read=isApprover, create only（沿用 V2）
userMappings: read/write 自己 or isDirector（沿用 V2）
```

---

## 5. 開發階段（接續路徑版本，6 人天）

### Phase 1 — 三層角色基礎建設（1.5 天）
- 改 `src/js/modules/v2/schemaConstants.js`：SCHOOL_ID = 'inhu'、ROLES 三層、REQUEST_TYPES 三類
- 改 `src/js/modules/v2/roleService.js`：補 isDirector、isSectionChief、isApprover、canManageRoster
- 改 `src/js/modules/v2/authGuardV2.js`：initialAdminEmails → initialDirectorEmails
- 改 `firestore.rules` v2.2：isAdmin → isDirector / isApprover
- 改 `src/js/v2-app.js`：UI 顯示三層角色徽章
- **驗收**：三個假帳號（director / section_chief / teacher）登入後在 v2-app 看到正確身份；teacher 看不到「教師管理」「操作日誌」頁籤

### Phase 2 — schoolId 遷移 + 全校課表共享驗證（0.5 天）
- 全文搜替 `default` → `inhu`（schemaConstants.js + rules + scripts/*）
- Firestore Console 手動建 `schools/inhu/config/main`
- 既有 `schools/default` 資料保留為備份（不刪）
- **驗收**：所有 V2 路徑改用 inhu；V2 操作日誌寫入 inhu

### Phase 3 — 三種審核流程分支（2 天）
- 改 `src/js/modules/v2/pendingRequestService.js`：
  - createRequest 接收 `requestType`（substitute / swap / multi_swap）
  - substitute → 直接 pending_approval（組長核准）
  - swap → pending_swap_consent → B 同意 → pending_approval → 組長核准
  - multi_swap → pendingConsentTeacherIds 陣列，全員同意才轉 pending_approval
  - 核准動作走 `runTransaction`（同時寫 record + 更新 request + 寫 log）
- 改 `firestore.rules` 新增 `array-contains` 條件給 pendingConsentTeacherIds
- 改 `src/js/v2-app.js`：「待我同意」頁籤分 swap / multi_swap、「待我審核」頁籤給 approver
- **驗收**：
  - 代課單簽：教師申請 → 組長核准 → 自動建 record
  - 調課雙簽：A 提 B 對調 → B 同意 → 組長核准
  - 多重調課：三人都同意 → 組長核准
  - 中途拒絕：整批 rejected
  - 兩位 approver 並發核准：transaction 失敗端顯示「已被處理」

### Phase 4 — Director 教師白名單批次匯入 UI（1 天）
- 改 `src/js/modules/v2/teacherAccountManager.js`：補 importRosterCsv（姓名、email、角色）
- 改 `src/js/v2-app.js`：教師管理頁籤新增 CSV 上傳欄位（director only）
- 寫範例 CSV 與說明到 `docs/`
- **驗收**：director 上傳 30 筆教師 CSV → 全校 30 人可立即用 Google 登入

### Phase 5 — 資料遷移 + Legacy 顯示（依新計畫文件 §5，0.5 天）
- 偵測舊路徑 `users/{uid}/data/substituteSystem` 並提供一鍵遷移按鈕（director only）
- 紀錄頁籤加 legacy 篩選 + 灰底徽章
- **驗收**：v1.11.0 主任帳號升級後一鍵匯入 → 舊紀錄全現

### Phase 6 — E2E 驗收 + 合回 master + v2.0.0（0.5 天）
- 更新 V2_E2E_CHECKLIST 三層角色 case
- 在 preview 子站讓主任 / 組長試用 2 週
- 通過後：刪 envDetector 雙軌邏輯（master 直接用 V2 路徑）
- 合回 master，bump v2.0.0，tag `v2.0.0-multirole`
- master 與 feature/permission-system 合併

---

## 6. UI 變更總覽

| Tab ID | 名稱 | 可見角色 | 備註 |
|---|---|---|---|
| `dashboard` | 首頁 | 全 | 角色化卡片 |
| `schedule-view` | 課表查詢 | 全 | 編輯按鈕僅 approver |
| `substitute` | 調代課申請 | 全 | 教師申請；approver 也可代他人 |
| `my-requests` | 我的申請 | teacher 主要 | pending / approved / rejected |
| `consent-inbox` | 待我同意 | teacher | 紅點 |
| `approval-queue` | 待我審核 | approver | 紅點 + 數量 |
| `records` | 調代課紀錄 | 全 | 教師僅自己相關列 |
| `settlement` | 月結算 | approver | |
| `roster-admin` | 教師管理 | director | |
| `school-settings` | 學校設定 | director | |
| `operation-logs` | 操作日誌 | approver | 沿用 V2 |
| `settings` | 個人設定 | 全 | |

---

## 7. 風險與緩解

| 風險 | 緩解 |
|---|---|
| 既有紀錄遷移失敗 | 遷移前自動下載 JSON 備份；batch write 每 400 筆一批；保留 `migratedFrom` 可隨時重做 |
| Firestore rules 漏洞 | Firebase Emulator + 規則測試；每個 collection 寫 happy + sad path |
| 兩位 approver 並發核准 | 一律 `runTransaction`；失敗端顯示「已被處理」 |
| 教師沒有 email | roster 可填 placeholder + 標「未啟用」；仍可被代發起 |
| 通知成本 | 純 Firestore onSnapshot 即可；不引入 FCM / Cloud Functions |
| 全校課表讀取效能 | schedule 單 doc 內嵌 entries，全校只讀 1 次 |
| Roster 與 user 不同步 | teachers 為單一真相，每次登入以 teachers 覆寫 |
| 多重調課中某教師永不回應 | `expiresAt` 30 天 + 申請者可撤回 + approver 可強制核准（記 log） |
| V2 → v2.0.0 合併破壞學期中使用 | preview 子站試用 2 週後才合回 master；master 維持 v1.11.0 直到 v2.0.0 通過 |

---

## 8. 驗證方式（每 Phase 完成後）

1. **本地驗證**：
   - `python start-server.py` → `http://localhost:8000/?v2=1`
   - Firebase Emulator 跑 rules 測試
   - 三個假 Google 帳號（director / section_chief / teacher）走完該 Phase 驗收項目

2. **既有功能回歸**：
   - 智慧推薦清單與升級前一致
   - v1.10.0 衝突案例仍被擋
   - 一式四聯 PDF + 週彙整 PDF 格式與 v1.11.0 一致
   - 月結算數字與舊系統相同

3. **Phase 3、5 額外驗證**：
   - Phase 3：DevTools Network 試圖直接 POST `substituteRecords` 應被 rules 擋
   - Phase 5：遷移後比對舊系統匯出 JSON 與新系統紀錄頁籤筆數相同

4. **發佈前（Phase 6）**：
   - preview 子站讓主任 / 組長試用 2 週
   - 通過後合回 master、bump v2.0.0、tag `v2.0.0-multirole`

---

## 9. 中斷後如何接續

下次開啟此專案做 v2.0.0 相關工作時：

1. **先讀本文 §0 進度索引**，確認當前 Phase
2. **檢查 git 分支**：`git branch --show-current` 應為 `feature/permission-system`（若採接續路徑）
3. **檢查 V2 路徑裁決**（§0 行 4）：若仍是「⏳ 待裁決」就先處理裁決，再進 Phase 1
4. **執行該 Phase 對應動作**（§5）
5. **完成後更新 §0 進度索引** + commit + 視需要打 tag

主要參考檔案：
- 原規劃檔（核准版本）：`C:\Users\uplil\.claude\plans\shiny-exploring-codd.md`
- V2 設計文件：`docs/V2_PERMISSION_SYSTEM.md`（feature 分支）
- E2E checklist：`docs/V2_E2E_CHECKLIST.md`（feature 分支）
- V2 模組 README：`src/js/modules/v2/README.md`（feature 分支）
