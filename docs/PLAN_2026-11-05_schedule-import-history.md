# 課表匯入日期與版本紀錄（2026-11-05）

使用者需求：「匯入課表資料新增匯入日期還有匯入課表版本紀錄」。
使用者決定（2026-11-05）：**可還原舊版**（每版存完整快照）；**V1 也加**。

## 現況（盤點結論）

- 匯入入口 `app.js handleScheduleFile()`（:803）→ `scheduleParser.parseFile` → `dm.setScheduleData/setTeachers/setClasses` → `saveDataToStorage()`。檔名只拿來抽校名，未保存。
- V1：存 `localStorage['substituteSystemData']`（`dm.exportToStorage()`），無任何時間戳。
- V2：`v2-app.js patchDataManager()` 包裝 mutator → `syncScheduleToV2()` → `schoolDataService.saveSchedule()` 以 `setDoc` **整份覆寫** `schools/{id}/schedules/{semesterId}`。匯入與單格編輯走同一路徑，`meta.lastAction` 永遠 `'uploaded'`，操作日誌每次同步都記 `schedule_import`。
- rules `match /schedules/{semesterId}`（firestore.rules:552）無子集合 match。

## 設計

1. **共用模組** `src/js/modules/scheduleImportHistory.js`：建立匯入紀錄 `{ id, versionNo, importedAt(ISO), source:'file'|'restore', restoredFromVersion?, fileName, counts:{entries,classes,teachers,skipped}, fingerprint, importedBy:{name,teacherId}|null }`、V1 localStorage 讀寫（保留最近 10 版，含快照 `{scheduleData,teachers,classes}`）、日期格式化。
2. **匯入訊號**：`handleScheduleFile` 成功後呼叫 `dm.recordScheduleImport(meta)`（dataManager 新方法，保存 `lastImport`，納入 `exportToStorage`／載入）。V2 由 `patchDataManager` 包裝此方法 → 寫子集合。
3. **V2 儲存**：
   - 主文件新增 `lastImport`（中繼資料，不含快照）；`syncScheduleToV2` 每次帶上，避免整份覆寫時遺失。
   - 子集合 `schools/{id}/schedules/{semesterId}/imports/{autoId}`：中繼資料＋快照。只新增不修改。
   - 只有真的匯入／還原才記 `schedule_import` 日誌（附檔名與各計數）；單格編輯改記其他 action 或維持但 details 標 `kind:'edit'`。
4. **rules**：`match /imports/{importId}`：read `isMember`；create `isApprover && isCurrentSemester`；update 禁止；delete 僅 `isDirector && !isCurrentSemester`（封存清理用）。**需部署正式庫，部署前須取得使用者同意。**
5. **封存**：學期封存匯出時把 imports 一併寫入封存 JSON；刪除課表文件時一併刪子集合。
6. **UI**：課表匯入區 `.status-header` 顯示「最後匯入：YYYY/MM/DD HH:mm · 匯入者 · 檔名」；新增「匯入紀錄」按鈕 → modal 列出各版（版本號、日期、匯入者、檔名、節／班／師、略過列、來源），每版「還原成這一版」（沿用既有 confirm modal；V2 限 approver 以上且當前學期）。還原本身記成新一版 `source:'restore'`。
7. **測試**：模組單元測試（V1 上限 10 版、還原）、emulator rules 測試（imports 子集合權限矩陣）、e2e-03 匯入後斷言 `lastImport` 與 imports 子集合、還原流程。

## 進度

- [x] 實作（sonnet，cherry-pick 至 feature 分支 021e512…4cd5f99）
- [x] 測試（npm test / check / emulator rules 9/9 / scenarios 96/96 / e2e 55/56，唯一失敗為環境）
- [x] 獨立驗收（opus：9 條通過，8 缺陷修 5，餘記 ISSUES_LOG 2026-11-05）
- [x] 文件（CHANGELOG、ISSUES_LOG）＋ commit
- [ ] 部署（rules v2.10 + preview）——待使用者同意
