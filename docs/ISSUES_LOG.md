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

### V2 原「調代課紀錄」頁籤不顯示（已由 V2 頁籤區塊取代）

- **日期**: 2026-04-20
- **狀態**: 🟡 設計取捨
- **描述**: V2 模式下 `dataManager.addSubstituteRecord` 被 patch 為不寫 local；原頁籤的本地紀錄表格會空。
- **現況**: 已在同頁籤下方注入 V2 專屬的「全校調代課紀錄」區塊顯示 V2 資料。
- **後續**: P11 若決定合併回 master，需將原表格完全移除或由 V2 資料填入。

### V2 衝堂檢查暫失效

- **日期**: 2026-04-20
- **狀態**: 🔴 待處理
- **描述**: 原 `checkExistingRecord` 查 local 陣列；V2 下 local 為空，無法檢測 V2 中已存在的調代課。
- **解決方案 (規劃)**: patchDataManager 中先 await 查 V2 `substituteRecords` 再決定是否放行。
- **相關檔案**: `src/js/v2-app.js` patchDataManager、`src/js/app.js:2234`

---

## 已解決的問題

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
