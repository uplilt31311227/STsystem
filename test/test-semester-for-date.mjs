/**
 * 依日期推算學期（LC-L7／LF-M8）單元測試
 * 執行：node test/test-semester-for-date.mjs
 *
 * 涵蓋：學期最後一天／下學期第一天、寒暑假空檔（有起訖日時阻擋）、未設定學期起訖日（退回
 * 台灣學制預設）、範圍重疊、不存在的日期、prevSemesterId、resolveWritableSemester 的相鄰學期窗口。
 */
import {
    semesterIdForDate, resolveWritableSemester, pendingBlockingSemesterSwitch, prevSemesterId, nextSemesterId, semesterOrdinal,
} from '../src/js/modules/v2/semesterUtils.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
    else { fail++; console.error(`✗ ${label}：預期 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`); }
}
const id = (r) => (r.ok ? r.semesterId : `BLOCK:${r.reason}`);

// 有起訖日的學期設定：含寒假（2/1 前後）與暑假空檔
const SEMS = [
    { id: '114-2', startDate: '2026-02-16', endDate: '2026-06-30' },
    { id: '115-1', startDate: '2026-09-01', endDate: '2027-01-20' },
    { id: '115-2', startDate: '2027-02-08', endDate: '2027-06-30' },
];

/* ===== 有起訖日：邊界 ===== */
eq(id(semesterIdForDate('2026-06-30', SEMS)), '114-2', '學期最後一天（6/30）屬該學期');
eq(id(semesterIdForDate('2026-02-16', SEMS)), '114-2', '學期第一天（2/16）屬該學期');
eq(id(semesterIdForDate('2026-09-01', SEMS)), '115-1', '下學期第一天（9/1）屬新學期');
eq(id(semesterIdForDate('2027-01-20', SEMS)), '115-1', '上學期最後一天（1/20）');
eq(id(semesterIdForDate('2027-02-08', SEMS)), '115-2', '下學期第一天（2/8）');
eq(semesterIdForDate('2026-09-01', SEMS).source, 'range', 'source=range');

/* ===== 有起訖日：空檔一律擋 ===== */
eq(id(semesterIdForDate('2026-07-15', SEMS)), 'BLOCK:gap', '暑假（7/15）空檔 → 擋');
eq(id(semesterIdForDate('2026-08-31', SEMS)), 'BLOCK:gap', '開學前一天（8/31）→ 擋');
eq(id(semesterIdForDate('2026-07-01', SEMS)), 'BLOCK:gap', '學期結束後第一天（7/1）→ 擋');
eq(id(semesterIdForDate('2027-01-21', SEMS)), 'BLOCK:gap', '寒假（1/21）→ 擋');
eq(id(semesterIdForDate('2027-02-07', SEMS)), 'BLOCK:gap', '寒假最後一天（2/7）→ 擋');
eq(id(semesterIdForDate('2030-01-01', SEMS)), 'BLOCK:gap', '沒有任何學期涵蓋 → 擋');
eq(typeof semesterIdForDate('2026-07-15', SEMS).message, 'string', '擋下時附使用者可讀訊息');

/* ===== 範圍重疊 → 擋 ===== */
eq(id(semesterIdForDate('2026-09-10', [
    { id: '115-1', startDate: '2026-09-01', endDate: '2027-01-20' },
    { id: '115-2', startDate: '2026-09-05', endDate: '2027-06-30' },
])), 'BLOCK:overlap', '兩學期範圍重疊 → 擋');

/* ===== 未設定學期起訖日 → 退回台灣學制預設 ===== */
for (const semesters of [null, undefined, [], [{ id: '115-1' }, { id: '115-2' }], [{ id: '115-1', startDate: '2026-08-01' }]]) {
    const tag = JSON.stringify(semesters ?? null);
    eq(id(semesterIdForDate('2026-01-31', semesters)), '114-1', `無起訖日 ${tag}：1/31 → 114-1`);
    eq(id(semesterIdForDate('2026-02-01', semesters)), '114-2', `無起訖日 ${tag}：2/1 → 114-2`);
    eq(id(semesterIdForDate('2026-07-31', semesters)), '114-2', `無起訖日 ${tag}：7/31 → 114-2`);
    eq(id(semesterIdForDate('2026-08-01', semesters)), '115-1', `無起訖日 ${tag}：8/1 → 115-1`);
}
eq(semesterIdForDate('2026-08-01', null).source, 'default', 'source=default');

/* ===== 不存在／格式錯誤的日期 ===== */
for (const bad of ['', null, undefined, '2026-02-30', '2026/09/01', '2026-13-01', 'abc', 20260901]) {
    eq(id(semesterIdForDate(bad, SEMS)), 'BLOCK:invalid-date', `非法日期 ${JSON.stringify(bad)} → 擋`);
    eq(id(semesterIdForDate(bad, null)), 'BLOCK:invalid-date', `非法日期（無設定）${JSON.stringify(bad)} → 擋`);
}

/* ===== prevSemesterId / semesterOrdinal ===== */
eq(prevSemesterId('115-1'), '114-2', '115-1 的上一學期 114-2');
eq(prevSemesterId('115-2'), '115-1', '115-2 的上一學期 115-1');
eq(prevSemesterId('x'), null, 'prev 不合法 → null');
eq(nextSemesterId(prevSemesterId('115-1')), '115-1', 'prev/next 互逆');
eq(semesterOrdinal('115-1') - semesterOrdinal('114-2'), 1, '序數連續');

/* ===== resolveWritableSemester：目前學期 ±1 窗口 ===== */
const CUR = '115-1';
eq(id(resolveWritableSemester('2026-11-17', CUR)), '115-1', '目前學期內的日期');
eq(id(resolveWritableSemester('2027-02-01', CUR)), '115-2', '預先登記下學期第一天（2/1，預設制度）');
eq(id(resolveWritableSemester('2027-01-31', CUR)), '115-1', '目前學期最後一天（1/31）');
eq(id(resolveWritableSemester('2026-07-31', CUR)), '114-2', '補登上學期最後一天（7/31）');
eq(id(resolveWritableSemester('2026-01-31', CUR)), 'BLOCK:out-of-window', '兩學期前 → 擋');
eq(id(resolveWritableSemester('2027-08-01', CUR)), 'BLOCK:out-of-window', '兩學期後 → 擋');
eq(id(resolveWritableSemester('2026-11-17', null)), 'BLOCK:no-current', '目前學期未確定 → 擋');
eq(id(resolveWritableSemester('2026-11-17', '')), 'BLOCK:no-current', '目前學期空字串 → 擋');
eq(id(resolveWritableSemester('2027-02-01', 's1')), 's1', '目前學期非標準格式 → 退回舊行為（歸目前學期，對應 rules fail-closed）');
eq(id(resolveWritableSemester('2027-02-31', 's1')), 'BLOCK:invalid-date', '非標準目前學期仍擋非法日期');
eq(id(resolveWritableSemester('2027-01-21', CUR, [
    { id: '115-1', startDate: '2026-09-01', endDate: '2027-01-20' },
    { id: '115-2', startDate: '2027-02-08', endDate: '2027-06-30' }])), 'BLOCK:gap', '有起訖日：寒假 → 擋');
eq(id(resolveWritableSemester('2027-02-08', CUR, [
    { id: '115-1', startDate: '2026-09-01', endDate: '2027-01-20' },
    { id: '115-2', startDate: '2027-02-08', endDate: '2027-06-30' }])), '115-2', '有起訖日：下學期第一天 → 115-2');

/* ===== pendingBlockingSemesterSwitch：開新學期前的孤兒檢查 ===== */
const reqs = [{ reqId: 'a', semesterId: '114-2' }, { reqId: 'b', semesterId: '115-1' }, { reqId: 'c', semesterId: '115-2' }, { reqId: 'd', semesterId: '114-1' }, { reqId: 'e' }];
const ids2 = (x) => x.map(r => r.reqId);
eq(ids2(pendingBlockingSemesterSwitch(reqs, '115-1', '115-2')), ['a', 'b', 'd', 'e'], '115-1→115-2：擋 114-2、115-1、114-1、缺學期；放行 115-2');
eq(ids2(pendingBlockingSemesterSwitch([{ reqId: 'x', semesterId: '115-1' }, { reqId: 'y', semesterId: '116-1' }], '115-2', '116-1')), ['x'], '115-2→116-1：補登的 115-1 孤兒被擋；116-1 放行');
eq(ids2(pendingBlockingSemesterSwitch([{ reqId: 'p', semesterId: '115-2' }, { reqId: 'q', semesterId: '116-1' }, { reqId: 'r', semesterId: '115-1' }], '115-1', '116-2')), ['p', 'r'], '跳號 115-1→116-2：115-2、115-1 擋，116-1 放行');
eq(ids2(pendingBlockingSemesterSwitch([], '115-1', '115-2')), [], '沒有在途申請 → 不擋');
eq(ids2(pendingBlockingSemesterSwitch(null, '115-1', '115-2')), [], 'null → 不擋');
eq(ids2(pendingBlockingSemesterSwitch([{ reqId: 'z', semesterId: '115-2' }], '115-1', '115-2')), [], '只有新學期的預登申請 → 可切換');

console.log(`\n[semester-for-date] ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
