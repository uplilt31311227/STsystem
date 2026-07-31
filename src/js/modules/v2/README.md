# V2 權限系統模組

> 此目錄為 `feature/permission-system` 分支專屬模組，提供：
> - director（教務主任）／section_chief（教學組長）／teacher（一般教師）三層角色系統
> - 教師 email 登入綁定
> - 調課同意流程（pendingRequests → substituteRecords，代課單簽／調課雙簽／多重調課全員同意）
> - 完整操作日誌

## 架構隔離

- **Firestore 路徑**：全部位於 `schools/{schoolId}/` 之下，正式資料 schoolId 為 `inhu`（`schools/default` 為 2026-04 alpha 期舊備份，保留不刪）。Stage 3 起 `schoolId` 為 runtime 動態解析（登入後由 `authGuardV2.resolveIdentity()` 讀頂層 `userDirectory/{uid}` 決定，見下表 `schemaConstants.js`），不再是寫死的 import-time 常數
- **舊資料**：`users/{uid}/data/substituteSystem` 不讀不寫，完全保留
- **啟用方式**：URL 參數 `?v2=1` 或 hostname 含 `preview`（見 `envDetector.js`）

## 模組職責（現況：9 個模組 + 2 個開發中）

| 檔案 | 說明 |
|---|---|
| `schemaConstants.js` | Firestore 路徑產生器、角色/狀態/日誌動作常量（Stage 3 起 `getActiveSchoolId()`／`setActiveSchoolId()` 動態解析，`DEFAULT_SCHOOL_ID='inhu'` 為相容期 fallback；三層 ROLES、REQUEST_TYPES） |
| `envDetector.js` | 判定是否進入 V2 模式 |
| `firebaseV2.js` | 動態載入擴充 Firestore 操作（addDoc/updateDoc/query…） |
| `schoolDataService.js` | 全校集合 CRUD（teachers / schedule / substitute / pending / logs / userMapping） |
| `roleService.js` | 當前身份與權限閘（isDirector / isSectionChief / isApprover / canManageRoster…） |
| `operationLogger.js` | 統一寫入 `operationLogs` |
| `authGuardV2.js` | Google 登入後 email → teacher 綁定與拒絕 |
| `teacherAccountManager.js` | 管理教師清單、指派 email、切換角色 |
| `pendingRequestService.js` | 調課同意流程狀態機（substitute / swap / multi_swap 三流分支） |
| `semesterUtils.js` | Stage 2 新增——學期推導純函式（date→semesterId、今天→semesterId、比較/下一學期） |
| `semesterState.js` | Stage 2 新增——目前作用中學期 ID 的 session 記憶體快取，供寫入/查詢路徑取用 |
| `uiFeedback.js` | 🚧 開發中——統一輕量錯誤/通知回饋層，取代混用的 alert() / console.error 靜默吞錯 / 一次性 toast；提供 `notify()`（優先委派 V1 `window.app.showToast()`）、`notifyError()`（Firestore 錯誤碼轉繁中人話）、`setSyncStatus()`（同步中斷徽章） |
| `legacyMigrationService.js` | 🚧 開發中——Phase 5「資料遷移 + Legacy」：偵測舊路徑 `users/{uid}/data/substituteSystem` 並提供一鍵遷移按鈕（director only），詳見 `docs/PLAN_v2.0.0.md` Phase 5 |

## 初始管理員設定

首次部署後需建立 `schools/inhu/config/main` 文件（可用 `scripts/firestore-bootstrap-inhu.js` 或 Firebase Console 手動建立），寫入：

```json
{
  "schoolName": "新竹市立內湖國民中學",
  "currentSemester": "114-2",
  "initialAdminEmails": ["uplilt31311227@gmail.com"]
}
```

當該 email 的使用者首次登入時，系統會自動建立其 director 身份。

## 學期化（Stage 2）

`config.currentSemester`（如 `114-2`，民國學年-學期）不再是死欄位，全 app 以它為「目前作用中學期」：

- 課表：`schools/{id}/schedules/{semesterId}`（per-semester 文件，取代舊的單一文件 `schools/{id}/data/schedule`；舊文件保留供讀取 fallback，不再被任何寫入路徑使用）。寫入規則只放行「目前學期」那一份文件。
- `substituteRecords` / `pendingRequests` / `operationLogs`：新寫入一律帶 `semesterId` 欄位。
- 規則層學期唯讀鎖（實際涵蓋範圍，見 `firestore.rules` 頭部第 6 點的完整說明）：
  - `substituteRecords` create：`semesterId` 須等於 `config.currentSemester`；`legacyMigrationService` 的一次性歷史遷移經嚴格條件豁免（限 director、且寫入自帶 `migratedFrom` 與字串 `semesterId`）。
  - `substituteRecords` update：`semesterId` 不可變，**且該紀錄現在所屬的學期須仍是目前作用中學期**——歷史學期的紀錄整份唯讀（含底下的 `private/detail` 子文件的 update；create 另有 `parentAllowsNewPrivateDetail()` 擋事後補建，見 `firestore.rules`），不是只鎖住 `semesterId` 欄位本身。
  - `pendingRequests` create：同樣鎖 `semesterId == config.currentSemester`（超出設計報告 §6.1 明文範圍，實作時一併加上）；update 未加此鎖。
  - 舊資料在 `scripts/backfill-semester-id.js` 回填前的相容豁免：上述 update 規則對「尚無 `semesterId` 欄位」的舊文件放行，行為等同 Stage 2 之前。
  - ⚠ **信任邊界（director 不受此鎖約束）**：`isDeclaredLegacyWrite()` 只要求 `isDirector(schoolId)` 成立即豁免整條學期鎖，`config.currentSemester` 本身也只有 director 能改。一個惡意或被入侵的 director 帳號理論上可以宣告任意寫入為歷史遷移繞過鎖、或直接改 `currentSemester` 再寫入——這與系統既有的其他 director-only 破壞性操作（刪除任何紀錄、刪除教師、清除所有資料）同一信任層級，不是本次新增的破口。
- 學期切換：設定頁「學校設定 → 學期管理」（director 專用），對應 `v2-app.js` 的 `renderSemesterAdminTab()`/`switchToNewSemester()`；切換前會檢查目前學期是否還有在途申請（有就擋下），切換後會透過 `subscribeConfig()` 讓其他仍開著頁面的使用者看到「請重新整理」的橫幅提示。
- 既有資料回填：`scripts/backfill-semester-id.js`（`substituteRecords`/`pendingRequests`/`operationLogs` 依 date/timestamp 反推 `semesterId`）、`scripts/migrate-schedule-to-semester.js`（舊 `data/schedule` → `schedules/{semesterId}`），兩者皆 `--dry-run` 預設，需先於相依的規則/程式碼上線前跑完（詳見 `docs/STAGE0-DEPLOY.md` 附註）。

詳細設計見 `docs/RESEARCH-multitenancy-semester.md` §5/§6.1/§8 Stage 2。

## 測試方式

本地啟動 `python start-server.py`，瀏覽 `http://localhost:8000/?v2=1` 進入 V2 模式。
