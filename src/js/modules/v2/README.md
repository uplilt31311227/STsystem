# V2 權限系統模組

> 此目錄為 `feature/permission-system` 分支專屬模組，提供：
> - 組長（管理員）／教師角色系統
> - 教師 email 登入綁定
> - 調課同意流程（pendingRequests → substituteRecords）
> - 完整操作日誌

## 架構隔離

- **Firestore 路徑**：全部位於 `schools/{schoolId}/` 之下
- **舊資料**：`users/{uid}/data/substituteSystem` 不讀不寫，完全保留
- **啟用方式**：URL 參數 `?v2=1` 或 hostname 含 `preview`（見 `envDetector.js`）

## 模組職責

| 檔案 | 說明 |
|---|---|
| `schemaConstants.js` | Firestore 路徑產生器、角色/狀態/日誌動作常量 |
| `envDetector.js` | 判定是否進入 V2 模式 |
| `firebaseV2.js` | 動態載入擴充 Firestore 操作（addDoc/updateDoc/query…） |
| `schoolDataService.js` | 全校集合 CRUD（teachers / schedule / substitute / pending / logs / userMapping） |
| `roleService.js` | 當前身份與權限閘（canInitiateFor / canConsentRequest / isApprover…） |
| `operationLogger.js` | 統一寫入 `operationLogs` |
| `authGuardV2.js` | Google 登入後 email → teacher 綁定與拒絕 |
| `teacherAccountManager.js` | 管理教師清單、指派 email、切換角色 |
| `pendingRequestService.js` | 調課同意流程狀態機 |

## 初始管理員設定

首次部署後需在 Firebase Console 手動建立 `schools/default/config/main` 文件，寫入：

```json
{
  "schoolName": "XX 國中",
  "initialAdminEmails": ["uplilt31311227@gmail.com"]
}
```

當該 email 的使用者首次登入時，系統會自動建立其 admin 身份。

## 測試方式

本地啟動 `python start-server.py`，瀏覽 `http://localhost:8000/?v2=1` 進入 V2 模式。
