/**
 * P6 驗收修補（項目 5）：showScheduleForDate 的世代（過期結果丟棄）與等待期間的課表格。
 * 從 app.js 原始碼取出 onTeacherOrDateChanged／showScheduleForDate 的函式本體，在假 DOM 上執行（測真正的程式碼）。
 * 執行：node test/test-p6-schedule-race.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
function extractMethod(name) {
    const re = new RegExp(`\\n    (async )?${name}\\(([^)]*)\\) \\{`);
    const m = re.exec(src);
    if (!m) throw new Error(`app.js 找不到方法 ${name}`);
    let i = m.index + m[0].length, depth = 1;
    while (depth > 0 && i < src.length) {
        const ch = src[i++];
        if (ch === '{') depth++; else if (ch === '}') depth--;
    }
    const body = src.slice(m.index + m[0].length, i - 1);
    const Ctor = m[1] ? (async function () {}).constructor : Function;
    return new Ctor(...m[2].split(',').map(s => s.trim()).filter(Boolean), body);
}

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

// ---- 假 DOM ----
function makeDom() {
    const els = {};
    const mk = (id) => (els[id] ||= {
        id, value: '', textContent: '', innerHTML: '', style: {},
        classList: {
            _s: new Set(['hidden']),
            add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
        },
    });
    globalThis.document = { getElementById: mk, querySelectorAll: () => [], querySelector: () => null };
    return { el: mk };
}

function makeApp(dom) {
    const releases = [];
    const app = {
        _calls: [],
        selectedCourse: null,
        getDateWeekday: () => '週三',
        dataManager: {
            getTeacherWeekSchedule: () => [{ weekday: '週三', period: '第一節', className: '801', teacher: '甲' }],
            getEffectiveScheduleForDate: () => new Promise((res) => { releases.push(() => res([{ weekday: '週三', period: '第一節', className: '801', teacher: '甲' }])); }),
        },
        resetStepsAfterBasic() {},
        showToast() {},
        renderTeacherScheduleWithHighlight(week, teacher) {
            app._calls.push(['render', teacher]);
            dom.el('original-schedule-grid').innerHTML = '<div class="schedule-course">舊格子</div>';
        },
    };
    app.showScheduleForDate = extractMethod('showScheduleForDate');
    app.onTeacherOrDateChanged = extractMethod('onTeacherOrDateChanged');
    return { app, release: (i = releases.length - 1) => releases[i] && releases[i]() };
}

const realErr = console.error; console.error = () => {};

// 1. 清空教師後，先前送出的查詢回來不可再渲染或打開步驟三
{
    const dom = makeDom();
    const { app, release } = makeApp(dom);
    dom.el('sub-teacher').value = '甲'; dom.el('sub-date').value = '2026-11-18';
    const pending = app.showScheduleForDate('甲', '2026-11-18');
    dom.el('sub-teacher').value = '';
    app.onTeacherOrDateChanged();
    release(); await pending;
    check('清空教師後舊查詢回來：不渲染課表', app._calls.length === 0, JSON.stringify(app._calls));
    check('清空教師後舊查詢回來：步驟三維持隱藏', dom.el('step-select-course').classList.contains('hidden'));
}
// 2. 清空日期同理
{
    const dom = makeDom();
    const { app, release } = makeApp(dom);
    dom.el('sub-teacher').value = '甲'; dom.el('sub-date').value = '2026-11-18';
    const pending = app.showScheduleForDate('甲', '2026-11-18');
    dom.el('sub-date').value = '';
    app.onTeacherOrDateChanged();
    release(); await pending;
    check('清空日期後舊查詢回來：不渲染課表', app._calls.length === 0, JSON.stringify(app._calls));
}
// 3. 等待查詢期間，舊課表格不可點：已清空，步驟三隱藏
{
    const dom = makeDom();
    const { app, release } = makeApp(dom);
    dom.el('original-schedule-grid').innerHTML = '<div class="schedule-course">舊格子</div>';
    dom.el('step-select-course').classList.remove('hidden');
    const pending = app.showScheduleForDate('乙', '2026-11-19');
    check('等待查詢期間：舊課表格已清空', dom.el('original-schedule-grid').innerHTML === '', dom.el('original-schedule-grid').innerHTML);
    check('等待查詢期間：步驟三暫時隱藏', dom.el('step-select-course').classList.contains('hidden'));
    release(); await pending;
    check('查詢完成後：渲染新課表並顯示步驟三', app._calls.length === 1 && !dom.el('step-select-course').classList.contains('hidden'));
}
// 4. 連續改選：只有最後一次生效
{
    const dom = makeDom();
    const { app, release } = makeApp(dom);
    const p1 = app.showScheduleForDate('甲', '2026-11-18');
    const p2 = app.showScheduleForDate('乙', '2026-11-19');
    release(0); await p1;
    check('連續改選：較舊的查詢結果被丟棄', app._calls.length === 0, JSON.stringify(app._calls));
    release(1); await p2;
    check('連續改選：最後一次查詢才渲染', app._calls.length === 1 && app._calls[0][1] === '乙', JSON.stringify(app._calls));
}

console.error = realErr;
console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
