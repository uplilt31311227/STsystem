---
created: 2026-04-29
tags:
  - v2
  - testing
  - e2e
---

# V2 端到端驗證 Checklist

> 對應分支：`feature/permission-system`
> 對應 Preview URL：https://uplilt31311227.github.io/STsystem-preview/
> 規則版本：firestore.rules v2.1（依角色 + email 白名單）

收緊規則部署後，**必須**走完本清單再判定 V2 alpha 可用。涉及 Google OAuth 的步驟無法純自動化，採人工驗證 + 截圖記錄。

---

## 前置條件

- [ ] `firestore.rules` v2.1 已部署（`node scripts/firestore-deploy-rules.js --list` 看 release 指向最新 ruleset）
- [ ] `schools/default/config/main.initialAdminEmails` 含 `uplilt31311227@gmail.com`
- [ ] preview repo 已收到最新 `feature/permission-system` 推送
- [ ] 至少一個非 admin 的 Google 測試帳號（用於教師驗證）— 若無，僅做 admin 路徑

每個情境完成後在方框打勾，並在 `test/e2e-screenshots/` 留下截圖。

---

## 情境 1：Admin 首次登入（bootstrap）

> 目的：驗證 initialAdminEmails 白名單觸發 authGuardV2 自建 admin teacher。

1. [ ] 開無痕 Chrome → 進 https://uplilt31311227.github.io/STsystem-preview/
2. [ ] 觀察 `body.v2-active` 在無 `?v2=1` 下自動啟用（pathname 含 `-preview/`）
3. [ ] 點右上「Google 登入」→ 用 `uplilt31311227@gmail.com` 登入
4. [ ] **預期**：UI 顯示 admin 身份；`body.v2-admin` 出現；可看到「教師管理」「操作日誌」等 admin 頁籤
5. [ ] Firestore：`schools/default/teachers/` 多一筆 `role=admin, email=uplilt31311227@gmail.com`（若先前已存在則僅 role 升為 admin）
6. [ ] Firestore：`schools/default/userMappings/{uid}` 寫入此 uid，linkedTeacherId 指向上面教師
7. [ ] Firestore：`schools/default/operationLogs/` 多一筆 action 與 bootstrap 相關（首次無 login_denied）

驗證指令：
```bash
node scripts/firestore-snapshot.js teachers
node scripts/firestore-snapshot.js mappings
```

---

## 情境 2：未綁定 email 登入被拒

> 目的：規則不允許 initialAdminEmail 以外、且 teachers 集合中無對應 email 者寫教師資料。

1. [ ] 用第二個 Google 帳號（**未在 initialAdminEmails 也未指派給任何教師**）登入
2. [ ] **預期**：UI 顯示「尚未授權」訊息並自動登出（authGuardV2 寫 `login_denied` log 後 return null）
3. [ ] 即使人為攔截網路想直接 POST `/teachers/{xxx}` create —— 應被規則 DENY（建立路徑需 isAdmin 或 isInitialAdmin+自身 email）
4. [ ] Firestore：`schools/default/operationLogs/` 多一筆 `action=login_denied`，actor.email 為該帳號

---

## 情境 3：Admin 從課表匯入教師 + 指派 email

1. [ ] Admin 登入後進「課表匯入」頁籤上傳 `114學年度...xls`
2. [ ] 進「教師管理」頁籤 → 按「從課表匯入教師」
3. [ ] **預期**：批次新增 26 位教師到 `schools/default/teachers/`，初始無 email、role=teacher
4. [ ] 為其中一位教師（例如測試帳號 B 對應）按「指派 email」→ 輸入 B 的 Google email
5. [ ] **預期**：`teachers/{tch_xxx}.email` 寫入 lowercased email；`operationLogs` 多一筆 `teacher_bind_email`

---

## 情境 4：教師登入並發起調課（pending 流程）

> 目的：教師發起 pending → 對方同意 → 紀錄成立。

### 4-1 教師發起

1. [ ] 用測試帳號 B（已綁 email）登入 preview URL
2. [ ] **預期**：`body.v2-teacher`，看到「待辦」「我已發起」等頁籤；admin 專屬頁籤被隱藏
3. [ ] 進「調代課申請」→ 選自己的課 → 選代課教師 C → 送出
4. [ ] **預期**：
   - `pendingRequests/` 多一筆 `status=pending, initiatedBy=tchB, requiredApproverId=tchC`
   - **不**應立刻產生 PDF（patchPdfGenerators 攔截）
   - Toast 顯示「已送出給 C 老師同意」
   - `operationLogs` 多一筆 `create_request`

### 4-2 教師 C 同意（需切換帳號）

1. [ ] 登出 B → 用 C 的 Google 帳號登入（C 的 email 已在 step 3 指派）
2. [ ] 進「待辦」→「待我同意」應看到該請求
3. [ ] 按「同意並產生 PDF」
4. [ ] **預期**：
   - `pendingRequests/{reqId}` 被刪除
   - `substituteRecords/` 多一筆 `status=approved, approvedBy=tchC`
   - 瀏覽器下載 PDF
   - `operationLogs` 多一筆 `approve`

### 4-3 教師 C 拒絕（reset 後重跑）

1. [ ] 由 B 再發起一次（同上）
2. [ ] C 登入 → 在「待我同意」按「拒絕」→ 填理由
3. [ ] **預期**：`pendingRequests/{reqId}.status=rejected, rejectedBy=tchC, rejectNote=...`（不是刪除）
4. [ ] B 切回登入 → 「我已發起」顯示「❌ 被拒絕」與 C 的理由
5. [ ] B 按「我知道了」→ pending 文件真正刪除

### 4-4 教師 B 撤回

1. [ ] B 再發起一次
2. [ ] 在「我已發起」按「撤回」→ pending 文件刪除，operationLogs 多 `cancel`

---

## 情境 5：Admin 代發起（跳過同意）

1. [ ] Admin 登入 → 「調代課申請」→ 「代發起」模式
2. [ ] 選擇代發起對象 = 教師 B，填發起內容
3. [ ] **預期**：
   - **不**寫 pendingRequests
   - 直接 `substituteRecords/` 多一筆 `status=approved, initiatedByRole=admin, adminOperatorId=adminTchId`
   - 立即產生 PDF
   - `operationLogs` 多一筆 `admin_create`

---

## 情境 6：規則層權限攻擊測試（手動 console）

> 目的：直接從教師帳號的瀏覽器 console 嘗試越權，預期被 Firestore 規則 DENY。

### 6-1 教師嘗試刪別人的 record

1. [ ] B 登入後在 DevTools console 執行：
```js
const fs = await window.app.__v2_dataSvc; // 若無 export，需用 schoolDataService import
// 嘗試刪掉一筆不屬於自己的紀錄
await fs.deleteSubstituteRecord('rec_xxx_other');
```
2. [ ] **預期**：`PERMISSION_DENIED: Missing or insufficient permissions`

### 6-2 教師嘗試把自己升為 admin

1. [ ] 從 console 執行：
```js
await fs.updateTeacher('tch_self', { role: 'admin' });
```
2. [ ] **預期**：`PERMISSION_DENIED`（B 不是 admin、也不是 initialAdmin）

### 6-3 教師嘗試以他人身份發起 pending

1. [ ] 從 console 執行：
```js
await fs.createPendingRequest({ initiatedBy: 'tch_other', requiredApproverId: 'tch_C', ... });
```
2. [ ] **預期**：`PERMISSION_DENIED`（規則檢查 `initiatedBy == myTeacherId`）

### 6-4 教師嘗試讀別人 mapping

1. [ ] 從 console 執行：
```js
await fs.getUserMapping('uid_other_user');
```
2. [ ] **預期**：`PERMISSION_DENIED`（規則允許 `request.auth.uid == uid` 或 admin）

---

## 情境 7：master 隔離復檢

> 確保收緊規則沒有影響穩定版。

1. [ ] 開原 master URL（GitHub Pages 主 repo） → 不應有 `v2-active`
2. [ ] 用同樣 admin 帳號登入 → 寫入測試紀錄 → 讀出
3. [ ] **預期**：master 的 `users/{uid}/data/...` 讀寫一切如常
4. [ ] 跑 `node test/v2-isolation-test.js`（需先 `python start-server.py`）

---

## 完成判準

當以上 7 大情境全部勾選通過，且：
- [ ] `node scripts/firestore-health-check.js` 全綠
- [ ] `node test/v2-preview-test.js` 通過
- [ ] `node scripts/firestore-snapshot.js all` 顯示資料一致

→ V2 alpha 視為「規則層 + 流程」均達上線標準，可進下一階段（多校支援 / master 切換策略）。
