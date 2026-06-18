/**
 * 九年級開關「即時重繪」決策邏輯單元測試
 * （獨立複製 app.js 的判斷邏輯，不依賴 DOM）
 * 執行：node test/test-grade9-refresh.mjs
 */

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (actual === expected) { pass++; }
    else { fail++; console.error(`✗ ${label}：預期 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`); }
}

// ---- 1. 雲端翻轉偵測：current !== baseline 才重繪 ----
// 對應 enableRealtimeSyncAndListen 的監聽器判斷
function shouldRefreshOnCloud(baseline, current) {
    return current !== baseline;
}
eq(shouldRefreshOnCloud(false, true), true, '關→開：應重繪');
eq(shouldRefreshOnCloud(true, false), true, '開→關：應重繪');
eq(shouldRefreshOnCloud(false, false), false, '無變化(關)：不重繪');
eq(shouldRefreshOnCloud(true, true), false, '無變化(開)：不重繪');

// ---- 2. 面板重繪決策：對應 refreshActiveSubstitutePanels ----
// 回傳要呼叫的渲染動作：'none' / 'swap' / 'recommend'
function decidePanelRender({ panelVisible, selectedCourse, changeType }) {
    if (!panelVisible || !selectedCourse) return 'none';
    return changeType === 'swap' ? 'swap' : 'recommend';
}
eq(decidePanelRender({ panelVisible: false, selectedCourse: {}, changeType: 'substitute' }), 'none', '面板隱藏：不重繪');
eq(decidePanelRender({ panelVisible: true, selectedCourse: null, changeType: 'substitute' }), 'none', '未選課：不重繪');
eq(decidePanelRender({ panelVisible: true, selectedCourse: {}, changeType: 'substitute' }), 'recommend', '代課模式：重繪推薦');
eq(decidePanelRender({ panelVisible: true, selectedCourse: {}, changeType: 'swap' }), 'swap', '調課模式：重繪互換清單');
// 多重調課在 UI 上以 swap + 批次模式呈現，changeType 仍為 swap
eq(decidePanelRender({ panelVisible: true, selectedCourse: {}, changeType: 'swap' }), 'swap', '多重調課(swap)：重繪互換清單');

// ---- 3. 基準同步流程：翻轉後 baseline 應更新，避免重複重繪 ----
let baseline = false;
let renderCount = 0;
function onCloudUpdate(current) {
    if (shouldRefreshOnCloud(baseline, current)) {
        baseline = current;
        renderCount++;
    }
}
onCloudUpdate(true);   // 關→開：重繪一次
onCloudUpdate(true);   // 維持開：不應再重繪
onCloudUpdate(true);
eq(renderCount, 1, '連續相同狀態僅重繪一次');
onCloudUpdate(false);  // 開→關：再重繪
eq(renderCount, 2, '再次翻轉後重繪');

console.log(`\n結果：通過 ${pass}，失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
