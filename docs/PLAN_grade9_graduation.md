# 計畫：九年級畢業自動停用課程功能

> 建立日期：2026-06-15
> 分支：feature/permission-system
> 狀態：✅ 已實作完成（2026-06-15）；code review 通過、18 項單元測試通過，待瀏覽器人工驗收

## 一、需求

九年級學生畢業後，課表上仍保留「9年X班」的課程，導致這些原本任課的老師在該時段被系統判定為「忙碌」，無法被推薦為代課人選——調代課被「不須上的課程」擋住。

需新增功能：可手動將九年級課程標記為停用，讓調代課恢復正常運作。

## 二、設計決策（使用者確認）

| 決策項 | 選定方案 |
|--------|----------|
| 移除方式 | **保留資料、標記停用**（可還原、不影響月結算與歷史） |
| 觸發方式 | **手動開關**（管理者/主任在設定頁切換「九年級已畢業」） |
| 判斷依據 | **班級名稱前綴**（className 為 9年X班 / 九年X班 / 9XX） |

## 三、運作原理

新增全域開關 `grade9Disabled`（預設關）。開啟後，凡 className 標準化後屬於九年級的課程一律視為停用：

- 不再讓老師被判定為忙碌 → 代課推薦時恢復為空堂、可被推薦
- 資料完整保留 → 月結算與歷史紀錄不受影響，可隨時關閉還原
- 課表上以灰底＋刪除線標示，避免誤解

## 四、改動檔案

### 1. `src/js/modules/dataManager.js`（資料層核心）
- constructor 新增 `this.settings = { grade9Disabled: false }`
- 新增方法：`isGrade9Disabled()`、`setGrade9Disabled(v)`、`isGraduatedClass(className)`、`getActiveScheduleData()`
- `getBusyTeachers()` 過濾掉停用課程
- `exportToStorage / loadFromStorage / exportForSync / loadFromCloud` 四方法加入 `settings` 欄位（localStorage + Firebase 皆持久化）

### 2. `src/js/app.js`（主程式）
- `showRecommendations()`（行 2120）改用 `getActiveScheduleData()` 傳推薦引擎
- 設定頁綁定開關 change 事件：切換 → 存檔 → 雲端同步 → 重新渲染
- 課表渲染（調代課申請 ~1697、課表編輯 ~3980）對停用課程加 `disabled-course` class

### 3. `index.html`
- 設定頁「資料管理」卡片內新增「九年級已畢業」開關 UI

### 4. `src/css/style.css`
- 新增 `.disabled-course` 樣式（灰底、刪除線）

### 5. `src/js/modules/recommendationEngine.js`
- 不改邏輯（呼叫端已傳過濾後資料），僅確認相容

## 五、流程

多 agent 平行實作 → 整合 → 瀏覽器手動驗證 → codereview skill 審查 → git commit → 更新 CHANGELOG / ISSUES_LOG → 推 GitHub

## 六、邊界處理

- 月結算/歷史紀錄：只影響「未來推薦」，已發生 records 照舊計算
- 班級名稱多格式（9年1班、九年1班、901）皆涵蓋
- 開關狀態經 Firebase 同步 → 多裝置一致
