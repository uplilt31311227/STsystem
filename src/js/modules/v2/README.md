# V2 權限系統模組

> 此目錄為 `feature/permission-system` 分支專屬模組，提供：
> - director（教務主任）／section_chief（教學組長）／teacher（一般教師）三層角色系統
> - 教師 email 登入綁定
> - 調課同意流程（pendingRequests → substituteRecords，代課單簽／調課雙簽／多重調課全員同意）
> - 完整操作日誌

## 架構隔離

- **Firestore 路徑**：全部位於 `schools/{schoolId}/` 之下，正式資料 schoolId 為 `inhu`（`schools/default` 為 2026-04 alpha 期舊備份，保留不刪）
- **舊資料**：`users/{uid}/data/substituteSystem` 不讀不寫，完全保留
- **啟用方式**：URL 參數 `?v2=1` 或 hostname 含 `preview`（見 `envDetector.js`）

## 模組職責（現況：9 個模組 + 2 個開發中）

| 檔案 | 說明 |
|---|---|
| `schemaConstants.js` | Firestore 路徑產生器、角色/狀態/日誌動作常量（`SCHOOL_ID='inhu'`、三層 ROLES、REQUEST_TYPES） |
| `envDetector.js` | 判定是否進入 V2 模式 |
| `firebaseV2.js` | 動態載入擴充 Firestore 操作（addDoc/updateDoc/query…） |
| `schoolDataService.js` | 全校集合 CRUD（teachers / schedule / substitute / pending / logs / userMapping） |
| `roleService.js` | 當前身份與權限閘（isDirector / isSectionChief / isApprover / canManageRoster…） |
| `operationLogger.js` | 統一寫入 `operationLogs` |
| `authGuardV2.js` | Google 登入後 email → teacher 綁定與拒絕 |
| `teacherAccountManager.js` | 管理教師清單、指派 email、切換角色 |
| `pendingRequestService.js` | 調課同意流程狀態機（substitute / swap / multi_swap 三流分支） |
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

## 測試方式

本地啟動 `python start-server.py`，瀏覽 `http://localhost:8000/?v2=1` 進入 V2 模式。
