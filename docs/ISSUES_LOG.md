---
created: 2026-04-10
updated: 2026-04-20
tags:
  - issues
  - troubleshooting
---

# 問題追蹤：國中調代課自動化系統

## 狀態說明

| 狀態 | 說明 |
|------|------|
| 🔴 待處理 | 已發現但尚未開始處理 |
| 🟡 處理中 | 正在調查或修復 |
| 🟢 已解決 | 已找到解決方案並修復 |

---

## V2 權限系統（feature/permission-system）已知限制與待辦

### Firestore 規則由「測試版（任何登入者皆可讀寫）」收緊為 v2.1

- **日期**: 2026-04-29
- **狀態**: 🟢 規則撰寫完成；部署需手動執行 `node scripts/firestore-deploy-rules.js`
- **描述**: V2 alpha 初版的安全規則僅檢查 `request.auth != null`，任何登入者都能改 schools/default 任意資料。雖然 schools 路徑不影響穩定版 master，但偽造請求即可越權。
- **解決方案**: 重寫 `firestore.rules` 加入 `isAdmin(schoolId)` / `myTeacherId` helper：
  - admin 由 `config.initialAdminEmails` 白名單或 `teachers/{tid}.role=='admin'` 判定
  - 教師寫 pending 強制 `initiatedBy == 自己`，更新限 `requiredApproverId`
  - 同意人寫 substituteRecord 強制 `approvedBy/requiredApproverId == 自己`，admin 編輯／刪除
  - userMappings 自己讀寫自己；operationLogs 任何登入者可寫不可改/刪
- **驗證**: 走完 `docs/V2_E2E_CHECKLIST.md` 情境 6（規則層權限攻擊測試）
- **相關檔案**: `firestore.rules`、`scripts/firestore-deploy-rules.js`、`scripts/firestore-health-check.js`、`docs/V2_E2E_CHECKLIST.md`、`docs/V2_PERMISSION_SYSTEM.md`

### V2 原「調代課紀錄」頁籤不顯示

- **日期**: 2026-04-20
- **狀態**: 🟢 已解決
- **描述**: V2 模式下 `dataManager.addSubstituteRecord` 被 patch 為不寫 local；原頁籤的本地紀錄表格會空。
- **解決方案**: V2 啟用時由 CSS 隱藏 `#records-tab > #records-no-data` 與 `#records-content`，V2 全校紀錄區塊改為頁籤主內容，避免空表格混淆。feature branch 獨立部署，不合併回 master，因此無需保留原表格。
- **相關檔案**: `src/js/v2-app.js` injectV2Styles / renderRecordsTab

### V2 衝堂檢查暫失效

- **日期**: 2026-04-20
- **狀態**: 🟢 已解決
- **描述**: 原 `checkExistingRecord` 查 local 陣列；V2 下 local 為空，無法檢測 V2 中已存在的調代課。
- **解決方案**: v2-app.js 建立同步 cache (`_v2RecordsCache` / `_v2PendingCache`)，由 onSnapshot 即時更新；`patchDataManager` 替換 `checkExistingRecord`，在 V2 模式下查詢 cache 而非 local 陣列；pending 也視為衝突（排除 rejected）。
- **相關檔案**: `src/js/v2-app.js` v2CheckExistingRecord / patchDataManager

---

## 已解決的問題

### Firestore 初始管理員設定與安全規則

- **日期**: 2026-04-20
- **狀態**: 🟢 已解決

**問題描述**：V2 權限系統需要兩項初始設定才能運作：
1. Firestore `schools/default/config/main` 文件（含 initialAdminEmails）
2. Firestore 安全規則允許 `schools/{schoolId}/` 讀寫（原規則僅涵蓋 `users/{uid}/`）

**解決方案**：使用 gcloud access token + Firestore / FirebaseRules REST API：

```bash
# 1. 建立 config 文件
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  ".../documents/schools/default/config/main" \
  --data-binary "@_firestore_init.json"

# 2. 建立並發布 ruleset
curl -X POST ".../rulesets" -d '{"source":{"files":[...]}}'
curl -X PATCH ".../releases/cloud.firestore" \
  -d '{"release":{"name":"...","rulesetName":"..."},"updateMask":"rulesetName"}'
```

**相關檔案**：`firestore.rules`（已提交）、`docs/V2_PERMISSION_SYSTEM.md`

### PDF 生成與 V2 pending 狀態

- **日期**: 2026-04-20
- **狀態**: 🟢 已解決（策略變更：pending 完全不產 PDF）

**原問題**：V2 教師發起後立即產生 PDF，但紀錄尚未成立（等對方同意），容易誤導使用者。

**最終決策**：
不再走「pending 加浮水印」方案。改為**同意前完全不產 PDF**：
- 教師發起 → pending，僅送出即時通知，不產 PDF
- 對方同意 → 正式成立 + 同意方當場下載 PDF
- 對方拒絕 → 不產 PDF，發起人可在「我已發起」看到「❌ 被拒絕」提示
- 組長代發起 / 自我調課 → 跳過同意流程，即時產 PDF（維持原行為）
- 紀錄列表新增「下載 PDF」按鈕，發起人可事後補下載

**相關檔案**：
- `src/js/modules/v2/pendingRequestService.js`（rejectRequest 改 soft-reject、新增 dismissRejectedRequest）
- `src/js/modules/v2/schoolDataService.js`（新增 updatePendingRequest）
- `src/js/v2-app.js`（v2NeedsApproval / patchPdfGenerators / approve 產 PDF / rejected 顯示 / 下載 PDF）

### 調代課紀錄查詢日期比較問題

- **日期**: 2026-03-27
- **狀態**: 🟢 已解決

**問題描述**：
調代課紀錄查詢時日期比較邏輯有誤，導致無法正確篩選特定日期的紀錄。

**解決方案**：
修復日期比較邏輯。

**相關 Commit**：
`4272740` - fix: 修復調代課紀錄查詢日期比較問題

---

### nul 檔案殘留

- **日期**: 2026-04-10
- **狀態**: 🟢 已解決

**問題描述**：
專案根目錄存在一個 0 byte 的 `nul` 檔案，為 Windows 系統誤建。

**解決方案**：
刪除 `nul` 檔案並加入 `.gitignore`。
