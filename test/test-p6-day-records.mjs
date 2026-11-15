/**
 * P6 驗收修補（項目 4）：showScheduleForDate 的「當日有效課表」只讀 date==D 與 swapDate==D 兩個等值查詢，
 * 同（學期、日期）結果快取，紀錄異動時失效。修前是每次換教師或日期都讀「前後 31 天」兩個範圍查詢且不快取。
 * 執行：node test/test-p6-day-records.mjs
 */
import { register } from 'node:module';
register('./helpers/gstatic-stub-loader.mjs', import.meta.url);

globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.document = { getElementById: () => null };
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const F = (globalThis.__fake = { docs: new Map(), writes: [], queries: [], applyWhere: true });

const { DataManager } = await import('../src/js/modules/dataManager.js');
const dataSvc = await import('../src/js/modules/v2/schoolDataService.js');
const semesterState = await import('../src/js/modules/v2/semesterState.js');
const { SCHEMA_PATHS } = await import('../src/js/modules/v2/schemaConstants.js');

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}
const realLog = console.log;
console.log = () => {};
semesterState.setCurrentSemesterId('115-1');

// ---- 資料層：只有 date==D、swapDate==D 兩個等值查詢 ----
const col = SCHEMA_PATHS.substituteCol();
const rec = (id, over) => F.docs.set(`${col}/${id}`, { status: 'approved', type: '調課', className: '801', originalTeacher: '甲', swapTeacher: '乙', ...over });
rec('a', { date: '2026-11-16', swapDate: '2026-11-18' });
rec('b', { date: '2026-11-10', swapDate: '2026-11-16' });
rec('c', { date: '2026-11-20', swapDate: '2026-11-21' });
let rows = [];
try { rows = await dataSvc.queryRecordsOnDate('2026-11-16'); } catch (e) { rows = e; }
const qs = F.queries.filter(q => q.path === col);
const fmt = (q) => q.where.map(w => `${w.field}${w.op}${w.value}`).join('&');
check('資料層：恰好 2 個查詢', Array.isArray(rows) && qs.length === 2, `queries=${qs.length} ${rows instanceof Error ? rows.message : ''}`);
check('資料層：條件為 date==D 與 swapDate==D（等值，無範圍）',
    qs.length === 2 && qs.some(q => fmt(q) === 'date==2026-11-16') && qs.some(q => fmt(q) === 'swapDate==2026-11-16'), qs.map(fmt).join(' | '));
check('資料層：回傳 date 或 swapDate 命中的紀錄並去重', Array.isArray(rows) && rows.map(r => r.recordId).sort().join() === 'a,b', Array.isArray(rows) ? rows.map(r => r.recordId).join() : '');

// ---- DataManager：getEffectiveScheduleForDate 的讀取次數與快取 ----
const sched = [
    { weekday: '週一', period: '第一節', className: '801', teacher: '甲', subject: '國文', domain: '語文' },
    { weekday: '週三', period: '第二節', className: '801', teacher: '乙', subject: '數學', domain: '數學' },
];
const swapRec = { id: 'r1', recordId: 'r1', type: '調課', status: 'approved', createdAt: '2026-11-10T00:00:00Z', className: '801',
    date: '2026-11-16', weekday: '週一', period: '第一節', originalTeacher: '甲', subject: '國文', domain: '語文',
    swapDate: '2026-11-18', swapWeekday: '週三', swapPeriod: '第二節', swapTeacher: '乙', swapSubject: '數學', swapDomain: '數學' };

const dm = new DataManager();
dm.setScheduleData(sched);
let rangeCalls = 0, aroundCalls = 0, fetchCalls = [];
const origRange = dm.getAssignmentOccupancyRecordsAsync.bind(dm);
dm.getAssignmentOccupancyRecordsAsync = async (...a) => { rangeCalls++; return origRange(...a); };
const origAround = dm.getOccupancyRecordsAround.bind(dm);
dm.getOccupancyRecordsAround = async (...a) => { aroundCalls++; return origAround(...a); };
if (typeof dm.setDayRecordsFetcher === 'function') {
    dm.setDayRecordsFetcher(async (date) => { fetchCalls.push(date); return [swapRec].filter(r => r.date === date || r.swapDate === date); }, () => semesterState.getCurrentSemesterId());
}
const teacherAt = (eff, wd, p) => eff.filter(c => c.weekday === wd && c.period === p && c.className === '801').map(c => c.teacher).join('+');

let eff = await dm.getEffectiveScheduleForDate('2026-11-16');
check('有效課表：套用當日調課（11/16 週一第一節改由乙上）', teacherAt(eff, '週一', '第一節') === '乙', teacherAt(eff, '週一', '第一節'));
check('不做前後 31 天的範圍查詢', rangeCalls === 0 && aroundCalls === 0, `range=${rangeCalls} around=${aroundCalls}`);
check('以單日查詢取得紀錄（1 次，帶日期）', fetchCalls.length === 1 && fetchCalls[0] === '2026-11-16', JSON.stringify(fetchCalls));
await dm.getEffectiveScheduleForDate('2026-11-16');
await dm.getEffectiveScheduleForDate('2026-11-16', { activeOnly: true });
check('同（學期、日期）再次查詢：用快取，不再讀取', fetchCalls.length === 1, `fetch=${fetchCalls.length}`);
await dm.getEffectiveScheduleForDate('2026-11-17');
check('不同日期：另外讀一次', fetchCalls.length === 2 && fetchCalls[1] === '2026-11-17');
semesterState.setCurrentSemesterId('115-2');
await dm.getEffectiveScheduleForDate('2026-11-16');
check('不同學期：另外讀一次', fetchCalls.length === 3, `fetch=${fetchCalls.length}`);
semesterState.setCurrentSemesterId('115-1');
await dm.getEffectiveScheduleForDate('2026-11-16');
check('切回原學期：仍有快取', fetchCalls.length === 3, `fetch=${fetchCalls.length}`);

dm.invalidateDayRecordsCache?.();
await dm.getEffectiveScheduleForDate('2026-11-16');
check('invalidateDayRecordsCache 後重新讀取', fetchCalls.length === 4, `fetch=${fetchCalls.length}`);

// 紀錄新增、刪除、修改（本機寫入路徑）都讓快取失效
const before = () => fetchCalls.length;
let n = before();
dm.addSubstituteRecord({ id: 'x1', type: '代課', date: '2026-11-30', period: '第一節', className: '801', originalTeacher: '甲', substituteTeacher: '乙', weekday: '週一' });
await dm.getEffectiveScheduleForDate('2026-11-16');
check('新增紀錄後快取失效', fetchCalls.length === n + 1, `delta=${fetchCalls.length - n}`);
n = before();
dm.removeSubstituteRecord?.('x1');
await dm.getEffectiveScheduleForDate('2026-11-16');
check('刪除紀錄後快取失效', fetchCalls.length === n + 1, `delta=${fetchCalls.length - n}`);

// 讀取失敗不快取，且錯誤會拋出
{
    const dm2 = new DataManager();
    dm2.setScheduleData(sched);
    let calls = 0;
    dm2.setDayRecordsFetcher?.(async () => { calls++; if (calls === 1) throw new Error('offline'); return []; }, () => 'x');
    let err = null;
    try { await dm2.getEffectiveScheduleForDate('2026-11-16'); } catch (e) { err = e; }
    check('讀取失敗：錯誤丟出', err?.message === 'offline', String(err));
    await dm2.getEffectiveScheduleForDate('2026-11-16');
    check('讀取失敗不快取：下一次重新讀', calls === 2, `calls=${calls}`);
    // 讀取進行中紀錄異動：舊結果不得寫入快取
    const dm3 = new DataManager();
    dm3.setScheduleData(sched);
    let release; let c3 = 0;
    dm3.setDayRecordsFetcher?.(() => { c3++; return new Promise(r => { release = () => r([]); }); }, () => 'x');
    const p = dm3.getEffectiveScheduleForDate('2026-11-16');
    await new Promise(r => setTimeout(r, 0));
    dm3.invalidateDayRecordsCache?.();
    release(); await p;
    const p2 = dm3.getEffectiveScheduleForDate('2026-11-16');
    await new Promise(r => setTimeout(r, 0));
    release(); await p2;
    check('讀取進行中遇到失效：舊結果不進快取', c3 === 2, `calls=${c3}`);
}
// V1／離線（沒有 fetcher）：不查任何東西，直接用本機紀錄
{
    const dm4 = new DataManager();
    dm4.setScheduleData(sched);
    dm4.addSubstituteRecord({ ...swapRec });
    const e = await dm4.getEffectiveScheduleForDate('2026-11-18');
    check('V1／離線：本機紀錄套用（11/18 週三第二節改由甲上）', teacherAt(e, '週三', '第二節') === '甲', teacherAt(e, '週三', '第二節'));
}

console.log = realLog;
console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
