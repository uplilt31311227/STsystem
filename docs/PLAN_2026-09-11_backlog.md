# 未完成任務收尾計畫（2026-09-11）

使用者於 2026-09-11 指示「完成未完成任務」，並選定全部四組範圍。本檔為執行計畫與進度，中斷後可依此接續。

## 範圍與順序

| # | 項目 | 狀態 |
|---|---|---|
| A | 正式庫完整備份（安全網，動任何正式資料前必做） | ✅ `backups/firestore/20260911-003015/` |
| B | 取得正式站 V1 的 115 課表（localStorage）並重建為人力資源網 2.0 格式 CSV | ✅ 349 節／12 班／27 教師，指紋與 localStorage 逐格相同 |
| C | 在本機 emulator 以該 CSV 實跑「開 115-1 學期 → 匯入 → 驗證」 | ✅ 2026-09-10 已實跑 5/5（含舊學期未被覆寫） |
| D | 正式站實作：開 115-1 學期 → 匯入課表 → 驗證雲端 `schools/inhu/schedules/115-1` | ⏸ 等使用者在瀏覽器完成 Google 登入 |
| E | 小修集合：e2e-02 flaky、原任課教師下拉鎖定本人、教師管理頁籤依角色隱藏 | 🔄 三項已改完，`npm run test:e2e` 驗證中 |
| F | UI 重規劃 Stage 6（清理：Tier C 死碼、Tier A alias、inline style 收 utility class） | 🔄 盤點中 |
| G | App Check enforcement 決策文件 ＋ 全校硬重整公告文稿 | ✅ `docs/APPCHECK-ENFORCEMENT.md`、`docs/ANNOUNCEMENT-115-1.md` |

## 決策紀錄

- 2026-09-11 使用者決定：開學匯入的課表來源＝**正式站 V1 目前的 115 課表**（存在使用者瀏覽器 localStorage），不另外提供匯出檔。
- 2026-09-10 使用者決定：先開 115-1 學期，再匯入課表（不要匯到 114-2）。

## 紅線

- 正式庫在 A 完成前一律唯讀。
- 匯入前先在 emulator 驗證同一份 CSV 可解析、可匯入、舊學期不被覆寫。
- 測試一律連 emulator（`demo-stsystem`），不得指向正式專案。

## 補充事實（執行過程查證）

- 課表指紋比對：`ScheduleParser` 解析重建 CSV 後的 SHA-256 為
  `3e7bbccd475db831fa3b4ec28cfaf35199d675c616407cea7ece0028991dff4d`，與正式站瀏覽器
  localStorage `substituteSystemData` 算出的同一規則指紋完全相同（2026-09-11）。
- App Check 用戶端確實在正式站運作：載入 `firebase-app-check.js`、reCAPTCHA 資源 3 個、
  `window.grecaptcha` 存在（2026-09-11 於正式站實測）。enforcement 仍未開。
- `switchToNewSemester(114-2 → 115-1)` 對正式庫是安全的：`schedules/114-2` 文件存在
  （雖然內容是空的），`getSchedule()` 回傳非 null，因此不會走到「建立空殼覆寫」那條路徑；
  正式庫 `pendingRequests` 為 0，不會被在途申請閘門擋下。
