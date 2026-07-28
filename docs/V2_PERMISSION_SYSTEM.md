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

在不動 master（組長穩定版1.0）的前提下，於 feature branch 新增「director/section_chief/teacher 三層角色／教師 email 登入／調課同意流程／完整操作 log」功能。

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
│   Firestore:    schools/inhu/…          │
│   （schools/default 為 2026-04 alpha 期舊備份，保留不刪）│
│   入口:         src/js/v2-app.js        │
│   模組:         src/js/modules/v2/*     │
└────────────────────────────────────────┘
```

兩個環境的 Firestore 路徑物理隔離：不會互相讀寫。

## 角色

| 角色 | 來源 | 權限 |
|---|---|---|
| director（教務主任） | `schools/inhu/config/main.initialAdminEmails` 白名單，或 `teachers/{id}.role === 'director'` | 最高權限：所有功能 + 教師管理 + 學校設定 + 課表上傳 + 核准/駁回 + 看全 log |
| section_chief（教學組長） | `teachers/{id}.role === 'section_chief'` | 核准/駁回申請、上傳課表、查看所有紀錄、月結算（教師管理／學校設定僅 director 可用） |
| teacher（一般教師） | `teachers/{id}.email` 對應 Google email | 看全校課表（唯讀）、只能以自己發起調課、需對方同意、可撤回待辦、只看與自己相關的紀錄與 log |
| 未綁定 | 登入 email 不在上述三者中 | 拒絕登入並顯示提示 |

> 舊 `role === 'admin'` 資料由 `normalizeRole()` 自動 alias 為 `director`，過渡期不必批量改資料（見 `schemaConstants.js`）。

## 初始設定（部署前必做）

### 1. Firestore 初始資料（✅ 已建立，正式資料位於 schools/inhu）
在專案 `stsystem-9d5fe` Firestore 已建立：

- `schools/inhu` — 正式資料根（`schools/default` 為 2026-04 alpha 期舊備份，保留不刪）
- `schools/inhu/config/main` — 設定文件（2026-07-29 查證現況）：
  ```json
  {
    "schoolName": "新竹市立內湖國民中學",
    "currentSemester": "114-2",
    "initialAdminEmails": ["uplilt31311227@gmail.com"]
  }
  ```

要追加管理員或更新學校名稱，可用 `scripts/firestore-bootstrap-inhu.js`、gcloud REST API 或 Firebase Console 修改。

### 1b. Firestore 安全規則（v2.2，已部署）
規則檔：[`firestore.rules`](../firestore.rules)（保留原 master 的 users/{uid} 規則，收緊 schools/{schoolId} 為角色判讀）

**已部署**：線上 release ruleset `0ad89275-0df4-46c6-99c8-825a6cc94889`（建立於 2026-07-09T16:46Z），對應本地 `firestore.rules` 檔頭標示的 v2.2 三層角色版本（前一版 ruleset `05f9b203-10fb-4df0-bef3-ecfec905fe16`）。

關鍵設計（v2.1 admin/teacher 兩角色 → v2.2 三層角色，已完成）：
- `isDirector(schoolId)` / `isApprover(schoolId)` helper：依 `userMappings/{uid}.linkedTeacherId` 解析出 `teachers/{tid}.role`；`role == 'director'` 為 isDirector，`role in ['director','section_chief']` 為 isApprover
- `pendingRequests` 依 `requestType`（substitute / swap / multi_swap）走不同狀態機；create 強制初始狀態與同意名單，update 加 `affectedKeys` 白名單與雙終態鎖（2026-07-09 Phase 3 收緊）
- `substituteRecords` 建立僅 `isApprover`（已移除教師自寫 `approvedBy==自己` 偽造已核准的路徑）；編輯／刪除依操作分屬 isApprover / isDirector
- `teachers` 編輯／刪除僅 isDirector；create/update 一併驗證 `isValidRoleValue()` 杜絕列舉外 role；初始主任第一次登入可 bootstrap 自己的 director 教師檔
- `userMappings/{uid}` 自己讀寫自己（自寫 `linkedTeacherId` 限定指向本人登入 email 對應的教師檔，防提權為主任）；director 全可
- `operationLogs` 任何登入者可寫（稽核），不可改／刪

部署 / 回滾：
```bash
node scripts/firestore-deploy-rules.js          # 建立 ruleset 並發布 release
node scripts/firestore-deploy-rules.js --list   # 確認 release 指向新 ruleset
node scripts/firestore-deploy-rules.js --dry    # 只建立 ruleset 不發布（rollback 預備）
```

回滾：用 `--list` 找回舊 rulesetName（前一版 `05f9b203-10fb-4df0-bef3-ecfec905fe16`），再 `gcloud firestore ... releases:update --ruleset=...`（或執行同腳本但替換 publish 目標）。

驗證：跑 [V2_E2E_CHECKLIST.md](V2_E2E_CHECKLIST.md) 的「情境 6：規則層權限攻擊測試」。

### 2. 初次登入
- 在瀏覽器開啟 `http://localhost:8000/?v2=1`（或預覽站點 URL）
- 以 `initialAdminEmails` 中的 Google 帳號登入 → 自動獲得 director 身份
- 進入「教師管理」頁籤 → 按「從課表匯入教師」（需先於「課表匯入」頁籤載入課表）
- 為每位教師指派 email 與角色（director / section_chief / teacher，須與該教師的 Google 帳號 email 完全一致）

### 3. 教師登入
- 已指派 email 的教師使用對應 Google 帳號登入 → 依 `teachers/{id}.role` 獲得 director / section_chief / teacher 身份
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
schools/inhu/                         // 正式資料（schools/default 為 2026-04 alpha 期舊備份）
├── config/main                       // 學校名稱、初始主任白名單
├── teachers/{teacherId}              // 教師（含 email、role、domains、homeroomClass）
├── data/schedule                     // 全校課表
├── substituteRecords/{recordId}      // 已成立的調代課
├── pendingRequests/{reqId}           // 待對方同意 / 待審核
├── operationLogs/{logId}             // 完整稽核紀錄
└── userMappings/{uid}                // Google uid → teacherId 映射
```

## 操作日誌動作類型

| action | 何時觸發 | 寫入者 |
|---|---|---|
| create_request | 教師送出調課 | 發起人 |
| approve | 對方同意 / 主任或組長核准 | 同意人 / approver |
| reject | 對方拒絕 / 主任或組長駁回 | 拒絕人 / approver |
| cancel | 發起人撤回 | 發起人 |
| admin_create | 主任或組長代發起 | approver（director/section_chief） |
| edit / delete | 主任或組長編輯／刪除紀錄 | approver（delete 僅 director） |
| teacher_bind_email | 指派教師 email | director |
| role_change | 切換教師角色 | director |
| teacher_create / teacher_delete | 新增／刪除教師 | director |
| login_denied | 未綁定 email 登入 | （系統） |
| permission_denied | 權限不足嘗試操作 | （系統） |
| schedule_import | 從課表匯入教師 | approver（director/section_chief） |

## 目前實作進度

見 `docs/CHANGELOG.md` 的 `[Unreleased - v2]` 區段。

## 驗證與部署輔助腳本

| 腳本 | 用途 |
|---|---|
| `scripts/firestore-snapshot.js [which] [--school=<id>]` | 列出 V2 集合資料（teachers / pending / records / logs / mappings / config），預設查 inhu |
| `scripts/firestore-health-check.js [--verbose] [--school=<id>]` | 結構與必備欄位健康檢查，預設查 inhu |
| `scripts/firestore-deploy-rules.js [--dry/--list]` | 部署 / 觀察 firestore.rules |
| `test/v2-smoke-test.js` | 本機 V2 啟動煙霧測試 |
| `test/v2-isolation-test.js` | 穩定版 master 未被 V2 污染檢查 |
| `test/v2-patch-test.js` | dataManager / pdf patch 套用驗證 |
| `test/v2-preview-test.js` | preview Pages URL 自動啟用 V2 驗證 |
| `test/v2-interactive-test.js` | 需手動 Google 登入的互動式 e2e（截圖至 e2e-screenshots/） |
| `docs/V2_E2E_CHECKLIST.md` | 規則 + 流程的完整人工驗證清單 |
