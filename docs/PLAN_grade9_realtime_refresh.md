# 計畫：雲端同步翻轉九年級開關時即時重繪面板

> 建立日期：2026-06-18
> 分支：master
> 狀態：✅ 已完成（2026-06-18，v1.13.2）；code review 通過、29 項測試通過，待瀏覽器人工驗收
> 來源：HANDOVER_2026-06-15.md 未完成項「雲端同步翻轉 grade9Disabled 時不會即時重繪已開啟的推薦/調課面板」

## 一、問題

realtime 雲端同步路徑為：
`onSnapshot（他機變更）` → `dataManager.loadFromCloud(data)` → `notifyDataChange()` → app `onDataChange` 監聽器（**只做 `syncToCloud()`，不刷新任何 UI**）。

因此當別台裝置翻轉「九年級已畢業」開關（grade9Disabled）時，本機雖已更新記憶體資料，但已開啟的「代課推薦 / 調課互換」面板與課表灰底不會即時重繪，需手動重新觸發。

## 二、附帶發現的 bug（v1.12.0）

`handleGrade9Toggle()` 呼叫 `this.renderEditorSchedule()`，但實際方法名為 `renderEditableScheduleGrid()`。
→ 編輯課表（已選教師）時切換開關會丟 `TypeError`，導致後續原課表重繪與 toast 被中斷。一併修正。

## 三、設計

1. 抽出共用方法 `refreshGrade9DependentUI()`，重繪所有受開關影響的可見區塊：
   - 課表編輯週課表灰底（`renderEditableScheduleGrid`，修正錯誤方法名）
   - 調代課申請原課表灰底（`renderTeacherSchedule`）
   - 已開啟的推薦/調課面板（新方法 `refreshActiveSubstitutePanels`）
2. `refreshActiveSubstitutePanels()`：步驟四面板可見且已選課時，依 change-type 重繪
   （swap → `updateSwapSlotAInfo` + `updateSwapCourseList`；否則 → `showRecommendations`）。
3. `handleGrade9Toggle()` 改用 `refreshGrade9DependentUI()`（本機切換也修好跨頁籤的面板重繪）。
4. `enableRealtimeSyncAndListen()`：
   - 記錄基準 `_syncedGrade9Disabled`
   - 監聽器加防重複註冊旗標 `_dataChangeListenerBound`（順帶修掉既有監聽器洩漏）
   - 每次雲端變更比對開關狀態，翻轉時 `syncGrade9Toggle()` + `refreshGrade9DependentUI()`

> realtime callback 已由 `hasPendingWrites` 過濾本地寫入，僅他機變更才觸發，正是目標情境。

5. （code review 補強）`refreshUIAfterSync()`（雲端下載/合併/衝突解決路徑）末端一併呼叫
   `refreshGrade9DependentUI()`，使「全量載入雲端資料」時也能重繪面板與灰底，不只更新勾選框。

## 四、改動檔案

- `src/js/app.js`：`enableRealtimeSyncAndListen`、`handleGrade9Toggle`、新增 `refreshGrade9DependentUI` / `refreshActiveSubstitutePanels`
- `test/test-grade9-refresh.mjs`：新增單元測試（diff 判斷、面板選擇邏輯）

## 五、驗收

- 兩裝置 A/B 登入同帳號 → B 開啟代課推薦面板（已選課）→ A 翻轉「九年級已畢業」→ B 面板即時重繪、開關勾選同步
- 調課互換面板同上
- 編輯課表時切換開關不再丟錯、灰底即時更新
