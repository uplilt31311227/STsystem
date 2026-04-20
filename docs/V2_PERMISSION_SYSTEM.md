---
created: 2026-04-20
tags:
  - v2
  - permissions
  - feature-branch
---

# V2 權限系統（feature/permission-system 分支專用）

> 此文件僅存在於 `feature/permission-system` 分支。穩定版 master 無此文件、也不含 V2 程式碼。

## 一句話

在不動 master（組長穩定版1.0）的前提下，於 feature branch 新增「組長管理員／教師 email 登入／調課同意流程／完整操作 log」功能。

## 架構總覽

```
┌────────────────────────────────────────┐
│ 穩定版 master（未動）                   │
│   GitHub Pages: 原 URL                  │
│   Firestore:    users/{uid}/data/…      │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│ V2 feature/permission-system           │
│   啟動條件: ?v2=1 或 hostname 含 preview │
│   Firestore:    schools/default/…       │
│   入口:         src/js/v2-app.js        │
│   模組:         src/js/modules/v2/*     │
└────────────────────────────────────────┘
```

兩個環境的 Firestore 路徑物理隔離：不會互相讀寫。

## 角色

| 角色 | 來源 | 權限 |
|---|---|---|
| admin（組長） | `schools/default/config/main.initialAdminEmails` 白名單，或 `teachers/{id}.role === 'admin'` | 全部：編輯／刪除所有人紀錄、代任一教師發起（跳過同意）、教師管理、看全 log |
| teacher（教師） | `teachers/{id}.email` 對應 Google email | 自己：只能以自己發起調課、需對方同意、可撤回待辦、只看與自己相關的紀錄與 log |
| 未綁定 | 登入 email 不在上述兩者中 | 拒絕登入並顯示提示 |

## 初始設定（部署前必做）

### 1. Firestore 初始資料（✅ 已建立）
在專案 `stsystem-9d5fe` Firestore 已建立：

- `schools/default` — V2 資料根（佔位文件）
- `schools/default/config/main` — 設定文件：
  ```json
  {
    "schoolName": "XX 國中",
    "initialAdminEmails": ["operator@example.edu.tw"],
    "updatedAt": "2026-04-20"
  }
  ```

要追加管理員或更新學校名稱，可用 gcloud REST API 或 Firebase Console 修改。

### 1b. Firestore 安全規則（✅ 已部署）
規則檔：`firestore.rules`（保留原 master 的 users/{uid} 規則，新增 schools/{schoolId}）

```
service cloud.firestore {
  match /databases/{database}/documents {
    match /schools/{schoolId}/{document=**} {
      allow read, write: if request.auth != null;
    }
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

⚠️ 測試階段規則寬鬆。正式上線前應改為依 email 白名單與 role 判讀權限。

### 2. 初次登入
- 在瀏覽器開啟 `http://localhost:8000/?v2=1`（或預覽站點 URL）
- 以 `initialAdminEmails` 中的 Google 帳號登入 → 自動獲得 admin 身份
- 進入「教師管理」頁籤 → 按「從課表匯入教師」（需先於「課表匯入」頁籤載入課表）
- 為每位教師指派 email（須與該教師的 Google 帳號 email 完全一致）

### 3. 教師登入
- 已指派 email 的教師使用對應 Google 帳號登入 → 獲得 teacher 身份
- 未指派 email 的 Google 帳號登入 → 看到「尚未授權」提示並登出

## 部署策略（避免汙染 master）

### 選項 A：本地測試（最簡單）
```bash
python start-server.py
# 瀏覽器開 http://localhost:8000/?v2=1
```

### 選項 B：獨立 GitHub repo 當預覽站（**已部署**）
- **Preview Repo**: https://github.com/uplilt31311227/STsystem-preview （public）
- **Preview URL**: https://uplilt31311227.github.io/STsystem-preview/
- **部署分支**: `main`（由本 repo `feature/permission-system` 推送而來）
- **啟用機制**: `envDetector` 偵測 pathname 含 `-preview/` → 自動啟用 V2（無需 `?v2=1`）

更新流程（後續 feature branch 有新 commit 時）：
```bash
git push preview feature/permission-system:main
```

⚠️ 不可合併回本 repo master。穩定版 `組長穩定版1.0` 維持原狀。

### 選項 C：用 ?v2=1 URL 參數在既有 Pages 測試
⚠️ 不建議。雖然 V2 模組對穩定版無副作用，但會讓 master Pages 同時載入 V2 程式碼。

## Firestore Schema（詳見 `src/js/modules/v2/schemaConstants.js`）

```
schools/default/
├── config/main                       // 學校名稱、初始管理員清單
├── teachers/{teacherId}              // 教師（含 email、role、domains、homeroomClass）
├── data/schedule                     // 全校課表
├── substituteRecords/{recordId}      // 已成立的調代課
├── pendingRequests/{reqId}           // 待對方同意
├── operationLogs/{logId}             // 完整稽核紀錄
└── userMappings/{uid}                // Google uid → teacherId 映射
```

## 操作日誌動作類型

| action | 何時觸發 | 寫入者 |
|---|---|---|
| create_request | 教師送出調課 | 發起人 |
| approve | 對方同意 | 同意人 |
| reject | 對方拒絕 | 拒絕人 |
| cancel | 發起人撤回 | 發起人 |
| admin_create | 組長代發起 | 組長 |
| edit / delete | 組長編輯／刪除紀錄 | 組長 |
| teacher_bind_email | 組長為教師指派 email | 組長 |
| role_change | 組長切換教師角色 | 組長 |
| teacher_create / teacher_delete | 組長新增／刪除教師 | 組長 |
| login_denied | 未綁定 email 登入 | （系統） |
| permission_denied | 權限不足嘗試操作 | （系統） |
| schedule_import | 從課表匯入教師 | 組長 |

## 目前實作進度

見 `docs/CHANGELOG.md` 的 `[Unreleased - v2]` 區段。
