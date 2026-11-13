/**
 * v2-app.js applyRemoteSchedule：scheduleData 不是陣列時，也必須先更新「課表版本基準」（P5 驗收 Low）
 * 執行：node test/test-apply-remote-schedule.mjs
 *
 * v2-app.js 無法在 node 直接 import（依賴整個瀏覽器環境），這裡從原始碼取出 applyRemoteSchedule 函式本體，
 * 以注入的假 window／setScheduleBase 實際執行，驗證真實程式碼的行為（不是只比對文字）。
 */
import { readFileSync } from 'node:fs';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}

const src = readFileSync(new URL('../src/js/v2-app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('function applyRemoteSchedule(');
const end = src.indexOf('\n}\n', start);
check('找得到 applyRemoteSchedule 原始碼', start > 0 && end > start);
const fnSrc = src.slice(start, end + 3);

function build() {
    const calls = [];
    const dm = { scheduleData: ['舊'], teachers: [], classes: [], settings: {} };
    const win = { app: { dataManager: dm, saveDataToStorage() {}, refreshUIAfterSync() {} } };
    const factory = new Function('window', 'setScheduleBase', `let _v2LastAppliedScheduleSig = null; ${fnSrc}; return applyRemoteSchedule;`);
    const fn = factory(win, (doc, legacy) => calls.push({ doc, legacy }));
    return { fn, calls, dm };
}

{
    const { fn, calls, dm } = build();
    const doc = { version: 7, updatedAt: 'U7', scheduleData: null, teachers: [] };
    fn(doc, {});
    check('scheduleData 不是陣列：版本基準仍被設定（setScheduleBase 被呼叫一次且帶入該文件）', calls.length === 1 && calls[0].doc === doc && calls[0].legacy === false, JSON.stringify(calls));
    check('scheduleData 不是陣列：本機課表不被覆寫', dm.scheduleData.length === 1 && dm.scheduleData[0] === '舊');
}
{
    const { fn, calls } = build();
    fn({ version: 2, updatedAt: 'U2' }, { fromLegacy: true });
    check('缺 scheduleData 欄位且來自舊版文件：基準以 fromLegacy=true 設定', calls.length === 1 && calls[0].legacy === true);
}
{
    const { fn, calls, dm } = build();
    fn({ version: 3, updatedAt: 'U3', scheduleData: [{ a: 1 }, { a: 2 }] }, {});
    check('正常陣列：設定基準並套用到本機', calls.length === 1 && dm.scheduleData.length === 2);
    fn({ version: 3, updatedAt: 'U3', scheduleData: [{ a: 1 }, { a: 2 }] }, {});
    check('相同簽章的重複快照：基準仍更新（2 次）但不重複套用', calls.length === 2);
}
{
    const { fn, calls } = build();
    fn(null, {});
    check('doc 為 null：不呼叫（由呼叫端另用 setScheduleBase(null) 處理）', calls.length === 0);
}

process.stdout.write(`\n${failed ? '失敗' : '全部通過'}：通過 ${passed}、失敗 ${failed}\n`);
process.exit(failed ? 1 : 0);
