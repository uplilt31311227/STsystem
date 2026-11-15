/**
 * P6 審計重現情境改寫的測試：調課的「時段 B」不算已佔用（L1）、沒有「當日有效課表」（L3）。
 * 只使用修復前就存在的公開介面（DataManager、RecommendationEngine、assignmentConflict），
 * 因此可對修復前的程式碼執行並看到失敗：環境變數 P6_SRC_ROOT 指向要測的 src 目錄（預設為本專案 src）。
 *
 * 執行：node test/test-p6-audit-repro.mjs
 *      P6_SRC_ROOT=<修復前 src 的複本> node test/test-p6-audit-repro.mjs   （應出現失敗）
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SRC = process.env.P6_SRC_ROOT
    ? path.resolve(process.env.P6_SRC_ROOT)
    : path.resolve(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);
const { DataManager } = await imp('js/modules/dataManager.js');
const { RecommendationEngine } = await imp('js/modules/recommendationEngine.js');
const { findAssignmentConflict, describeAssignmentConflict } = await imp('js/modules/v2/assignmentConflict.js');

const realLog = console.log;
console.log = () => {};
let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

// ---------- R01：V1 路徑（DataManager）----------
const schedule = [
    { weekday: '週四', period: '第一節', className: '7年1班', teacher: '王老師', subject: '國文', domain: '語文領域' },
    { weekday: '週五', period: '第三節', className: '7年1班', teacher: '李老師', subject: '數學', domain: '數學領域' },
    { weekday: '週一', period: '第一節', className: '7年2班', teacher: '陳老師', subject: '數學', domain: '數學領域' },
];
const teachers = ['王老師', '李老師', '陳老師'].map(n => ({ name: n, domains: [], homeroomClass: '' }));
const dm = new DataManager();
dm.setScheduleData(schedule);
dm.setTeachers(teachers);
// 已成立調課：王 11/12(四)第一節 ↔ 李 11/13(五)第三節，7年1班
dm.addSubstituteRecord({
    id: 'swap1', type: '調課', date: '2026-11-12', period: '第一節', weekday: '週四', className: '7年1班',
    originalTeacher: '王老師', swapDate: '2026-11-13', swapPeriod: '第三節', swapWeekday: '週五',
    swapTeacher: '李老師', substituteTeacher: '李老師', leaveType: '調課',
});

const hitB = await dm.checkExistingRecord('2026-11-13', '第三節', '7年1班', '李老師');
check('R01 李老師被調走的時段 B（11/13 第三節 7年1班）已有紀錄 → checkExistingRecord 命中調課', hitB?.id === 'swap1', `回傳 ${hitB?.id ?? null}`);
const hitA = await dm.checkExistingRecord('2026-11-12', '第一節', '7年1班', '王老師');
check('R01 時段 A 的既有比對維持命中', hitA?.id === 'swap1');
const hitOther = await dm.checkExistingRecord('2026-11-13', '第三節', '7年1班', '王老師');
check('R01 王老師被調進來的那一節（11/13 第三節）沒有他自己的紀錄 → 可為他申請請假', hitOther === null, `回傳 ${hitOther?.id ?? null}`);

// 王老師 11/13 請假：該節現在是王老師的課。李老師（已被調走）當天該節空堂，應出現在推薦名單
const engine = new RecommendationEngine();
const recs = engine.getRecommendations(
    { weekday: '週五', period: '第三節', className: '7年1班', subject: '國文', domain: '語文領域', originalTeacher: '王老師' },
    schedule, teachers, '2026-11-13', dm.substituteRecords);
const names = recs.map(r => r.teacher.name);
check('R01 被調走的李老師當日該節空堂 → 列入王老師請假的推薦', names.includes('李老師'), `推薦名單 ${names.join('、')}`);
check('R01 原任課（被調進來）的王老師不推薦自己', !names.includes('王老師'));

const conflict = dm.checkSubstituteTeacherConflict('李老師', '2026-11-13', '週五', '第三節');
check('R01 李老師被調走後可代這一節 → 衝堂檢查不再誤報「原本有課」', conflict === null, String(conflict));
const conflictWang = dm.checkSubstituteTeacherConflict('王老師', '2026-11-13', '週五', '第三節');
check('R01 王老師被調進來的那一節，不能再被指派去代別班（有課）', conflictWang !== null);

// ---------- repro-01：V2 核准重驗 ----------
const swapRecord = {
    recordId: 'rec_swap', id: 'swap1', type: '調課', status: 'approved',
    date: '2026-11-20', weekday: '週五', period: '第三節', className: '801', subject: '數學',
    originalTeacher: '王老師',
    swapDate: '2026-11-27', swapWeekday: '週五', swapPeriod: '第二節', swapTeacher: '林老師', swapSubject: '國文',
    substituteTeacher: '林老師',
};
const subReq = {
    type: '代課', date: '2026-11-27', weekday: '週五', period: '第二節', className: '801', subject: '國文',
    originalTeacher: '林老師', substituteTeacher: '陳老師',
};
const approveHit = findAssignmentConflict(subReq, [swapRecord]);
check('repro-01 已調課換走的時段 B，再為林老師申請代課 → 核准重驗回報衝突', approveHit != null, '回傳 null（放行）');
check('repro-01 衝突訊息指出班級與節次', !!approveHit && describeAssignmentConflict(approveHit).includes('801') && describeAssignmentConflict(approveHit).includes('第二節'),
    approveHit ? describeAssignmentConflict(approveHit) : '');
// 王老師（被調進來）請假代課：是合法情境，不得被擋
const legit = findAssignmentConflict({ ...subReq, originalTeacher: '王老師', substituteTeacher: '陳老師' }, [swapRecord]);
check('repro-01 王老師被調進來的那一節請假代課 → 放行', legit === null, legit ? describeAssignmentConflict(legit) : '');
// 兩張待核准的代課申請搶同一班同一節（不同代課者）：先成立一筆後，第二張核准應被擋
const subRecord1 = { recordId: 'rec_sub1', id: 'sub1', type: '代課', status: 'approved', date: '2026-11-27', weekday: '週五', period: '第二節',
    className: '801', originalTeacher: '王老師', substituteTeacher: '陳老師' };
const dupHit = findAssignmentConflict({ ...subReq, originalTeacher: '王老師', substituteTeacher: '張老師' }, [subRecord1]);
check('同節雙送：同一班同一節同一位原任課教師已有代課紀錄，換另一位代課者核准 → 衝突', dupHit != null, '回傳 null（放行）');

console.log = realLog;
console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
