/**
 * 調課日期層級衝堂（findSwapDateConflict）與「當日也請假」推薦標註單元測試
 * 執行：node test/test-swap-conflict.mjs
 */
import { RecommendationEngine, findSwapDateConflict, findTeacherConflict } from '../src/js/modules/recommendationEngine.js';

console.log = () => {};
let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

// ===== 調課：A 師(週一第一節) ↔ B 師(週二第二節)；日期 A=2026-09-21、B=2026-09-22 =====
const swap = { teacherA: '甲', dateA: '2026-09-21', periodA: '第一節', teacherB: '乙', dateB: '2026-09-22', periodB: '第二節' };
const occupied = { id: 'r1', type: '代課', date: '2026-09-21', period: '第一節', originalTeacher: '丙', substituteTeacher: '乙', className: '8年1班' };

check('(a) B 師該日該節已被派代課 → 擋下', findSwapDateConflict({ ...swap, records: [occupied] })?.teacher === '乙'
    && findSwapDateConflict({ ...swap, records: [occupied] }).role === '代課');
check('(a) A 師在 B 日期該節已被派代課 → 擋下', findSwapDateConflict({ ...swap, records: [{ ...occupied, date: '2026-09-22', period: '第二節', substituteTeacher: '甲' }] })?.teacher === '甲');
check('(a) B 師該日該節已是別筆調課的互換教師 → 擋下（role 調課）',
    findSwapDateConflict({ ...swap, records: [{ id: 'r2', type: '調課', date: '2026-09-21', period: '第一節', originalTeacher: '丙', swapTeacher: '乙', substituteTeacher: '乙', className: '8年2班' }] })?.role === '調課');
const moveIn = { id: 'r3', type: '調課', date: '2026-09-18', period: '第四節', originalTeacher: '甲', swapTeacher: '丁', substituteTeacher: '丁',
    swapDate: '2026-09-22', swapPeriod: '第二節', className: '9年1班' };
check('(a) A 師在 B 日期該節已被別筆調課移入 → 擋下', findSwapDateConflict({ ...swap, records: [moveIn] })?.teacher === '甲');
check('(a) 他日／他節不誤擋', findSwapDateConflict({ ...swap, records: [{ ...occupied, date: '2026-09-28' }, { ...occupied, period: '第三節' }] }) === null);
check('(b) 只有被排除的自身紀錄 → 不擋', findSwapDateConflict({ ...swap, records: [occupied], excludeRecordId: 'r1' }) === null);
check('(b) 沒有任何紀錄 → 不擋', findSwapDateConflict({ ...swap, records: [] }) === null);
check('自行調課（同一教師）不檢查', findSwapDateConflict({ ...swap, teacherB: '甲', records: [{ ...occupied, substituteTeacher: '甲' }] }) === null);
check('姓名前後空白不影響比對', findSwapDateConflict({ ...swap, teacherB: ' 乙 ', records: [occupied] }) !== null);

// ===== (d) findTeacherConflict 不因調課移入而改變（代課行為不變） =====
check('(d) findTeacherConflict 不看調課移入（代課既有行為不變）',
    findTeacherConflict({ teacherName: '甲', date: '2026-09-22', period: '第二節', records: [moveIn] }) === null);

// ===== 推薦：當日也請假 =====
const c = (teacher, weekday, period, className, subject) => ({ teacher, weekday, period, className, subject, rawSubject: subject, domain: '' });
const schedule = [
    c('原師', '星期一', '第一節', '7年1班', '數學'),
    c('數甲', '星期一', '第二節', '7年3班', '數學'),   // 同科目、當日第三節請假
    c('數乙', '星期二', '第二節', '7年4班', '數學'),   // 同科目、無請假
    c('空甲', '星期二', '第三節', '9年1班', '地理'),   // 空堂層、無請假
    c('空乙', '星期二', '第四節', '9年2班', '歷史')    // 空堂層、當日請假
];
const teachers = ['原師', '數甲', '數乙', '空甲', '空乙'].map(name => ({ name, domains: [], homeroomClass: '' }));
const target = { weekday: '星期一', period: '第一節', className: '7年1班', subject: '數學', rawSubject: '數學', domain: '', originalTeacher: '原師' };
const date = '2026-09-21';
const leave = (id, who, period, type = '代課') => ({ id, type, date, period, originalTeacher: who, substituteTeacher: '外人' + id, className: 'x', status: undefined });
const dayRecs = [leave('a', '數甲', '第三節'), leave('b', '空乙', '第二節', '調課'), { ...leave('c', '空甲', '第五節'), status: 'rejected' }];
const engine = new RecommendationEngine();
// 同分比較：數甲/數乙都「同科目」、空甲/空乙都「空堂」；數乙本月代課較多，用來證明 onLeave 比本月節數優先
const monthRecs = [...dayRecs, ...[1, 2, 3].map(i => ({ id: 'm' + i, type: '代課', date: '2026-09-0' + i, period: '第一節', originalTeacher: '誰', substituteTeacher: '數乙' }))];
const recs = engine.getRecommendations(target, schedule, teachers, date, dayRecs, monthRecs);
const names = recs.map(r => r.teacher.name);
const get = n => recs.find(r => r.teacher.name === n);
check('(c) 理由含「當日另有請假紀錄（第三節）」', get('數甲').reasonText.includes('⚠ 當日另有請假紀錄（第三節）'), get('數甲').reasonText);
check('(c) tags 含 onLeaveToday', get('數甲').tags.includes('onLeaveToday') && !get('數乙').tags.includes('onLeaveToday'));
check('(c) 同層內排在無標記者之後（即使本月節數較少）', names.indexOf('數乙') < names.indexOf('數甲') && names.indexOf('空甲') < names.indexOf('空乙'), names.join(','));
check('(c) 不跨層：請假的同科目教師仍排在未請假的空堂教師之前', names.indexOf('數甲') < names.indexOf('空甲'), names.join(','));
check('(c) 不改分數', get('數甲').score === get('數乙').score && get('空甲').score === get('空乙').score);
check('(c) 調課的 originalTeacher 也標記；被拒絕的紀錄不標記', get('空乙').onLeaveToday === true && !get('空甲').onLeaveToday);
check('(c) 不硬性排除', names.includes('數甲') && names.includes('空乙'));
const recsNoMonth = engine.getRecommendations(target, schedule, teachers, date, dayRecs, null);
check('(c) 未提供月紀錄時退用當日紀錄仍會標註', recsNoMonth.find(r => r.teacher.name === '數甲').tags.includes('onLeaveToday'));

if (failed) { process.stdout.write(`\n${failed} 項失敗\n`); process.exit(1); }
process.stdout.write('\n全部通過\n');
