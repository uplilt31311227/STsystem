/**
 * P6：班級時段佔用、當日有效課表、課表異動影響、同名教師解析（純函式，node 直接跑）
 * 執行：node test/test-p6-slot-occupancy.mjs
 */
import {
    matchesRecordSlot, findClassSlotConflict, describeClassSlotConflict, applySwapsToSchedule,
    isEstablishedRecord, isSameBatch,
} from '../src/js/modules/slotOccupancy.js';
import { findAssignmentConflict, describeAssignmentConflict, pendingRequestsToOccupancyRecords } from '../src/js/modules/v2/assignmentConflict.js';
import { findScheduleImpact } from '../src/js/modules/scheduleImpact.js';
import { resolveTeacherIdByName, resolveTeacherIds, normalizeTeacherName, describeTeacherCandidate } from '../src/js/modules/v2/teacherIdentity.js';

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

const sched = [
    { weekday: '週五', period: '第三節', className: '801', teacher: '王老師', subject: '數學', domain: '數學' },
    { weekday: '週五', period: '第二節', className: '801', teacher: '林老師', subject: '國文', domain: '語文' },
    { weekday: '週四', period: '第二節', className: '802', teacher: '林老師', subject: '國文', domain: '語文' },
    { weekday: '週一', period: '第一節', className: '801', teacher: '張老師', subject: '英文', domain: '英語' },
];
// 王 11/20(五) 第三節 801 ↔ 林 11/27(五) 第二節 801 ：A 由林上，B 由王上
const swap = { id: 'sw1', recordId: 'r1', type: '調課', status: 'approved', className: '801',
    date: '2026-11-20', weekday: '週五', period: '第三節', originalTeacher: '王老師', subject: '數學', domain: '數學',
    swapDate: '2026-11-27', swapWeekday: '週五', swapPeriod: '第二節', swapTeacher: '林老師', swapSubject: '國文', swapDomain: '語文',
    createdAt: '2026-11-10T00:00:00.000Z' };

// ---- matchesRecordSlot ----
check('matchesRecordSlot：時段 A 全等 → A', matchesRecordSlot(swap, '2026-11-20', '第三節', '801', '王老師') === 'A');
check('matchesRecordSlot：時段 B 且 swapTeacher 為申請人 → B', matchesRecordSlot(swap, '2026-11-27', '第二節', '801', '林老師') === 'B');
check('matchesRecordSlot：時段 B 但申請人是被調進來的王老師 → 不命中', matchesRecordSlot(swap, '2026-11-27', '第二節', '801', '王老師') === null);
check('matchesRecordSlot：代課紀錄不會因 swapDate 命中', matchesRecordSlot({ type: '代課', date: '2026-11-27', period: '第二節', className: '801', originalTeacher: '王老師', swapDate: '2026-11-27', swapPeriod: '第二節', swapTeacher: '林老師' }, '2026-11-27', '第二節', '801', '林老師') === null);

// ---- findClassSlotConflict ----
const q = (over) => findClassSlotConflict({ className: '801', date: '2026-11-27', period: '第二節', teacher: '林老師', records: [swap], ...over });
check('班級時段：林老師（被調走）在時段 B 再申請 → 衝突', q({})?.slot === 'B');
check('班級時段：王老師（被調進來）在時段 B 申請 → 放行', q({ teacher: '王老師' }) === null);
check('班級時段：時段 A 的新任課者林老師可申請，原任課王老師不可',
    findClassSlotConflict({ className: '801', date: '2026-11-20', period: '第三節', teacher: '林老師', records: [swap] }) === null
    && findClassSlotConflict({ className: '801', date: '2026-11-20', period: '第三節', teacher: '王老師', records: [swap] })?.slot === 'A');
check('班級時段：不同班級不誤擋', q({ className: '802' }) === null);
check('班級時段：同批紀錄不算（批次連調）', q({ records: [{ ...swap, batchId: 'b1', initiatedBy: 't1' }], anchor: { batchId: 'b1', initiatedBy: 't1' } }) === null);
check('班級時段：同 batchId 但發起者不同仍算', q({ records: [{ ...swap, batchId: 'b1', initiatedBy: 't1' }], anchor: { batchId: 'b1', initiatedBy: 't2' } }) !== null);
check('班級時段：excludeRecordId 排除自己', q({ excludeRecordId: 'sw1' }) === null);
const dupSub = { id: 's1', type: '代課', status: 'approved', date: '2026-11-27', period: '第二節', className: '801', originalTeacher: '王老師', substituteTeacher: '陳老師' };
check('班級時段：同班同節同一位原任課教師已有代課 → 衝突', findClassSlotConflict({ className: '801', date: '2026-11-27', period: '第二節', teacher: '王老師', records: [dupSub] })?.role === '代課');
check('班級時段：訊息含班級、日期、節次', /801 2026-11-27 第二節/.test(describeClassSlotConflict(q({}))));
check('班級時段：在途佔用紀錄的訊息標示（待核准中）',
    describeClassSlotConflict(findClassSlotConflict({ className: '801', date: '2026-11-27', period: '第二節', teacher: '林老師',
        records: pendingRequestsToOccupancyRecords([{ ...swap, reqId: 'q1', status: 'pending_approval' }]) })).includes('（待核准中）'));
// 核准重驗入口
check('findAssignmentConflict：調課申請的時段 B 已被別筆調課換過任課者 → 衝突',
    findAssignmentConflict({ type: '調課', className: '801', date: '2026-12-04', period: '第一節', originalTeacher: '張老師',
        swapDate: '2026-11-27', swapPeriod: '第二節', swapTeacher: '林老師', swapWeekday: '週五', weekday: '週五' }, [swap])?.kind === 'classSlot');
check('findAssignmentConflict：訊息可由 describeAssignmentConflict 轉成句子', (() => {
    const h = findAssignmentConflict({ type: '代課', className: '801', date: '2026-11-27', period: '第二節', originalTeacher: '林老師', substituteTeacher: '陳老師' }, [swap]);
    return h && describeAssignmentConflict(h).includes('已有調課紀錄');
})());

// ---- applySwapsToSchedule ----
const eB = applySwapsToSchedule(sched, [swap], '2026-11-27');
check('有效課表：時段 B 那天 801 第二節改由王老師上', eB.find(c => c.className === '801' && c.period === '第二節')?.teacher === '王老師'
    && eB.find(c => c.className === '801' && c.period === '第二節')?.__swapped === true);
const eA = applySwapsToSchedule(sched, [swap], '2026-11-20');
check('有效課表：時段 A 那天 801 第三節改由林老師上，科目國文', eA.find(c => c.className === '801' && c.period === '第三節')?.teacher === '林老師'
    && eA.find(c => c.className === '801' && c.period === '第三節')?.subject === '國文');
check('有效課表：無關日期不變', applySwapsToSchedule(sched, [swap], '2026-11-13').every((c, i) => c.teacher === sched[i].teacher));
check('有效課表：不改動傳入的陣列', sched[0].teacher === '王老師' && sched[1].teacher === '林老師');
check('有效課表：在途與已駁回的調課不套用', applySwapsToSchedule(sched, [{ ...swap, status: 'pending_approval' }, { ...swap, __pending: true }], '2026-11-27').every((c, i) => c.teacher === sched[i].teacher));
check('有效課表：自我調課不改任課者', applySwapsToSchedule(sched, [{ ...swap, isSelfSwap: true, swapTeacher: '王老師' }], '2026-11-27').every((c, i) => c.teacher === sched[i].teacher));
const chain = [swap, { ...swap, id: 'sw2', recordId: 'r2', date: '2026-11-27', period: '第二節', originalTeacher: '王老師', swapDate: '2026-12-04', swapPeriod: '第二節', swapTeacher: '張老師',
    swapWeekday: '週五', weekday: '週五', createdAt: '2026-11-11T00:00:00.000Z' }];
check('有效課表：連調依建立時間順序，最後一筆為準',
    applySwapsToSchedule(sched, chain, '2026-11-27').find(c => c.className === '801' && c.period === '第二節')?.teacher === '張老師');
check('isEstablishedRecord', isEstablishedRecord({}) && isEstablishedRecord({ status: 'approved' }) && !isEstablishedRecord({ status: 'rejected' }) && !isEstablishedRecord({ __pending: true }));
check('isSameBatch', isSameBatch({ batchId: 'b', initiatedBy: 'x' }, { batchId: 'b', initiatedBy: 'x' }) && !isSameBatch({ batchId: 'b' }, {}));

// ---- scheduleImpact ----
const teachers = ['王老師', '林老師', '張老師', '陳老師'];
const imp0 = findScheduleImpact({ scheduleData: sched, teachers, requests: [{ reqId: 'q1', type: '代課', date: '2026-12-01', weekday: '週五', period: '第三節', className: '801', originalTeacher: '王老師', substituteTeacher: '陳老師' }], today: '2026-11-14' });
check('影響檢查：申請與課表一致 → 無影響', imp0.requests.length === 0, JSON.stringify(imp0));
const schedNew = sched.map(c => c.className === '801' && c.period === '第三節' ? { ...c, teacher: '張老師' } : c);
const imp1 = findScheduleImpact({ scheduleData: schedNew, teachers, requests: [{ reqId: 'q1', type: '代課', date: '2026-12-01', weekday: '週五', period: '第三節', className: '801', originalTeacher: '王老師', substituteTeacher: '陳老師' }], today: '2026-11-14' });
check('影響檢查：重新匯入後該節改由張老師上 → 在途申請被標示', imp1.requests.length === 1 && /張老師/.test(imp1.requests[0].reasons.join()), JSON.stringify(imp1));
const imp2 = findScheduleImpact({ scheduleData: sched.filter(c => c.teacher !== '林老師'), teachers: ['王老師', '張老師', '陳老師'],
    requests: [], records: [{ recordId: 'r9', type: '代課', status: 'approved', date: '2026-12-01', weekday: '週五', period: '第三節', className: '801', originalTeacher: '林老師', substituteTeacher: '陳老師' }], today: '2026-11-14' });
check('影響檢查：教師刪除後，未來紀錄標示教師不在名單與課表', imp2.records.length === 1 && /林老師.*已不在/.test(imp2.records[0].reasons.join()), JSON.stringify(imp2));
check('影響檢查：過去的紀錄不標示', findScheduleImpact({ scheduleData: [], teachers: [], records: [{ recordId: 'r', type: '代課', date: '2026-10-01', originalTeacher: '誰', period: '第一節', className: '801' }], today: '2026-11-14' }).records.length === 0);
check('影響檢查：已成立的調課本身不被自己誤判', findScheduleImpact({ scheduleData: sched, teachers, records: [swap], today: '2026-11-14' }).records.length === 0);

// ---- 同名教師 ----
const dup = [{ teacherId: 't_a', name: '李大明', email: 'a@x', homeroomClass: '801' }, { teacherId: 't_b', name: '李大明', email: 'b@x' }, { teacherId: 't_c', name: '王小美' }];
check('同名：唯一 → ok', resolveTeacherIdByName(dup, '王小美').teacherId === 't_c');
check('同名：兩位同名 → ambiguous（不取第一筆）', resolveTeacherIdByName(dup, '李大明').status === 'ambiguous');
check('同名：登入者本人在候選之中 → 採用本人', resolveTeacherIdByName(dup, '李大明', { preferTeacherId: 't_b' }).teacherId === 't_b');
check('同名：明確選擇不在候選 → 仍為 ambiguous', resolveTeacherIdByName(dup, '李大明', { chosenTeacherId: 'zzz' }).status === 'ambiguous');
check('同名：查無此人 → none', resolveTeacherIdByName(dup, '沒有').status === 'none');
check('同名：姓名正規化（前後空白、全形空白）', resolveTeacherIdByName(dup, '　王小美 ').teacherId === 't_c' && normalizeTeacherName('　甲 ') === '甲');
let thrown = null;
try { await resolveTeacherIds(dup, [{ key: 'a', name: '李大明' }]); } catch (e) { thrown = e; }
check('同名：沒有 chooser 時丟出 AMBIGUOUS_TEACHER，不默默取第一筆', thrown?.code === 'AMBIGUOUS_TEACHER', String(thrown));
const picked = await resolveTeacherIds(dup, [{ key: 'a', name: '李大明' }, { key: 'b', name: '李大明' }, { key: 'c', name: '王小美' }], async (n, cands) => cands[1].teacherId);
check('同名：chooser 選第二位 → 同一次送出內同名者共用同一選擇', picked.a === 't_b' && picked.b === 't_b' && picked.c === 't_c', JSON.stringify(picked));
let cancelled = null;
try { await resolveTeacherIds(dup, [{ key: 'a', name: '李大明' }], async () => null); } catch (e) { cancelled = e; }
check('同名：使用者取消選擇 → AMBIGUOUS_TEACHER_CANCELLED', cancelled?.code === 'AMBIGUOUS_TEACHER_CANCELLED');
check('同名：候選說明含信箱與代碼', /a@x/.test(describeTeacherCandidate(dup[0])) && /代碼 t_a/.test(describeTeacherCandidate(dup[0])));
const self = await resolveTeacherIds(dup, [{ key: 'o', name: '李大明', preferTeacherId: 't_a' }], null);
check('同名：發起人就是其中一位時不需選擇', self.o === 't_a');

console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
