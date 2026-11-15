/**
 * P6 驗收修補：協同教學（同班同節兩位教師）與教師自我調課後的時段 B。
 * 執行：node test/test-p6-coteach-selfswap.mjs
 */
import {
    matchesRecordSlot, findClassSlotConflict, applySwapsToSchedule, describeExistingRecord, describeClassSlotConflict,
} from '../src/js/modules/slotOccupancy.js';
import { findAssignmentConflict, verifyNoAssignmentConflict, buildApprovalConflictMessage, buildAdminCreateConflictMessage } from '../src/js/modules/v2/assignmentConflict.js';
import { RecommendationEngine } from '../src/js/modules/recommendationEngine.js';

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}
const at = (e, wd, p, c) => e.filter(x => x.weekday === wd && x.period === p && x.className === c).map(x => x.teacher).sort().join('+');

// 課表：903 班週二第四節由甲、乙協同；901 班週一第一節甲、週三第三節甲、週五第三節丙
const sched = [
    { weekday: '週二', period: '第四節', className: '903', teacher: '甲', subject: '特教', domain: '' },
    { weekday: '週二', period: '第四節', className: '903', teacher: '乙', subject: '特教', domain: '' },
    { weekday: '週四', period: '第一節', className: '903', teacher: '丙', subject: '數學', domain: '數學' },
    { weekday: '週一', period: '第一節', className: '901', teacher: '甲', subject: '國文', domain: '語文' },
    { weekday: '週三', period: '第三節', className: '901', teacher: '甲', subject: '國文', domain: '語文' },
    { weekday: '週五', period: '第三節', className: '901', teacher: '丙', subject: '英語', domain: '語文' },
];
// 乙(協同) 11/17 第四節 與 丙 11/19 週四第一節 互調
const RC = { id: 'rc', recordId: 'rc', type: '調課', status: 'approved', createdAt: '2026-11-10T00:00:00Z',
    date: '2026-11-17', weekday: '週二', period: '第四節', className: '903', subject: '特教',
    originalTeacher: '乙', swapDate: '2026-11-19', swapWeekday: '週四', swapPeriod: '第一節', swapTeacher: '丙', swapSubject: '數學' };

// ---- 項目 1：協同教學 ----
let eff = applySwapsToSchedule(sched, [RC], '2026-11-17');
check('協同：乙調走後 903 週二第四節為 甲+丙（乙不留在課表）', at(eff, '週二', '第四節', '903') === '丙+甲', at(eff, '週二', '第四節', '903'));
eff = applySwapsToSchedule(sched, [RC], '2026-11-19');
check('協同：時段 B 那天 903 週四第一節由乙上', at(eff, '週四', '第一節', '903') === '乙', at(eff, '週四', '第一節', '903'));
// 隔週課以同班同節兩位教師呈現
const biweekly = [
    { weekday: '週三', period: '第二節', className: '905', teacher: '甲', subject: '音樂', domain: '' },
    { weekday: '週三', period: '第二節', className: '905', teacher: '乙', subject: '音樂', domain: '' },
];
const RB = { id: 'rb', recordId: 'rb', type: '調課', status: 'approved', date: '2026-11-18', weekday: '週三', period: '第二節', className: '905',
    originalTeacher: '甲', swapDate: '2026-11-20', swapWeekday: '週五', swapPeriod: '第一節', swapTeacher: '丁' };
eff = applySwapsToSchedule(biweekly, [RB], '2026-11-18');
check('隔週雙列：甲調走後 只剩乙與丁', at(eff, '週三', '第二節', '905') === '丁+乙', at(eff, '週三', '第二節', '905'));
// 單一教師時仍用純班級時段（課表老師名與紀錄不一致時仍替換該格）
eff = applySwapsToSchedule(sched, [{ ...RC, className: '901', weekday: '週一', period: '第一節', originalTeacher: '戊', date: '2026-11-16',
    swapDate: '2026-11-20', swapWeekday: '週五', swapPeriod: '第三節', swapTeacher: '丙' }], '2026-11-16');
check('單一教師的格子：課表姓名與紀錄不符時照舊替換為 swapTeacher', at(eff, '週一', '第一節', '901') === '丙', at(eff, '週一', '第一節', '901'));

const subCo = { type: '代課', date: '2026-11-17', weekday: '週二', period: '第四節', className: '903', originalTeacher: '甲', substituteTeacher: '丁' };
let h = findAssignmentConflict(subCo, [RC], null, sched);
check('協同：乙已調課，甲同節請假代課 核准不擋（有課表）', h === null, h && h.slot);
h = findAssignmentConflict({ ...subCo, originalTeacher: '乙' }, [RC], null, sched);
check('協同：被調走的乙本人同節請假 仍擋', h && h.kind === 'classSlot', String(h));
h = findAssignmentConflict(subCo, [RC]);
check('未提供課表時維持純班級時段判斷（保守擋下）', h && h.kind === 'classSlot');
const single = [{ weekday: '週二', period: '第四節', className: '903', teacher: '乙', subject: '特教', domain: '' }];
h = findAssignmentConflict(subCo, [RC], null, single);
check('同班同節只有一位教師時，第三人仍被擋', h && h.kind === 'classSlot');
const SC = { id: 'sc', recordId: 'sc', type: '代課', status: 'approved', date: '2026-11-17', period: '第四節', className: '903', originalTeacher: '乙', substituteTeacher: '丁' };
check('協同：乙已有代課，甲同節再請假 不擋', findAssignmentConflict({ ...subCo, substituteTeacher: '戊' }, [SC], null, sched) === null);
check('協同：乙已有代課，乙再請假 仍擋', findAssignmentConflict({ ...subCo, originalTeacher: '乙', substituteTeacher: '戊' }, [SC], null, sched)?.role === '代課');
// 時段 B：協同教學中的 B
const RC2 = { ...RC, id: 'rc2', recordId: 'rc2', date: '2026-11-19', weekday: '週四', period: '第一節', className: '903', originalTeacher: '丙', subject: '數學',
    swapDate: '2026-11-17', swapWeekday: '週二', swapPeriod: '第四節', swapTeacher: '乙' };
h = findAssignmentConflict(subCo, [RC2], null, sched);
check('協同：乙在時段 B 被調走，甲同節請假 不擋', h === null);

// 推薦：協同教學中乙被調走，甲仍在課表所以不是空堂；乙當空堂
const teachers = ['甲', '乙', '丙', '丁'].map(n => ({ name: n, domains: [], homeroomClass: '' }));
const realLog = console.log; console.log = () => {};
const recs = new RecommendationEngine().getRecommendations(
    { weekday: '週二', period: '第四節', className: '903', subject: '特教', domain: '', originalTeacher: '丁' }, sched, teachers, '2026-11-17', [RC]).map(r => r.teacher.name);
console.log = realLog;
check('推薦：協同的甲（仍在課表）不當空堂；被調走的乙當空堂', !recs.includes('甲') && recs.includes('乙'), recs.join(','));

// 核准入口：只在需要時才讀課表（lazy）
{
    let loads = 0;
    const query = async () => [RC];
    const hit = await verifyNoAssignmentConflict(subCo, query, async () => { loads++; return sched; });
    check('verifyNoAssignmentConflict：第三人命中時讀課表並判定為協同，放行', hit === null && loads === 1, `hit=${hit && hit.kind} loads=${loads}`);
    loads = 0;
    const hit2 = await verifyNoAssignmentConflict({ ...subCo, originalTeacher: '乙' }, query, async () => { loads++; return sched; });
    check('verifyNoAssignmentConflict：被調走者本人命中，不必讀課表', hit2?.kind === 'classSlot' && loads === 0, `loads=${loads}`);
    const hit3 = await verifyNoAssignmentConflict(subCo, query, async () => { throw new Error('boom'); });
    check('verifyNoAssignmentConflict：課表讀取失敗 fail-closed 維持擋下', hit3?.kind === 'classSlot');
    check('課表讀取失敗：命中標記 scheduleUnavailable，訊息明確區分、不顯示為一般衝堂', hit3?.scheduleUnavailable === true && /無法確認當日課表/.test(buildApprovalConflictMessage(hit3)) && !/已被指派|已有/.test(buildApprovalConflictMessage(hit3)) && /無法確認當日課表/.test(buildAdminCreateConflictMessage(hit3, subCo)));
    const hit4 = await verifyNoAssignmentConflict(subCo, query, async () => []);
    check('課表為空：同樣擋下並標記 scheduleUnavailable', hit4?.kind === 'classSlot' && hit4.scheduleUnavailable === true);
    check('被調走者本人的一般衝堂不帶 scheduleUnavailable，訊息維持衝堂說明', !hit2.scheduleUnavailable && /核准失敗/.test(buildApprovalConflictMessage(hit2)) && !/無法確認當日課表/.test(buildApprovalConflictMessage(hit2)));
}

// ---- 項目 2：自我調課 ----
// 甲把 901 週一第一節(11/16) 與自己 11/18 週三第三節對調
const SS = { id: 'ss', recordId: 'ss', type: '調課', isSelfSwap: true, status: 'approved', createdAt: '2026-11-10T00:00:00Z',
    date: '2026-11-16', weekday: '週一', period: '第一節', className: '901', originalTeacher: '甲',
    swapDate: '2026-11-18', swapWeekday: '週三', swapPeriod: '第三節', swapTeacher: '甲' };
h = findAssignmentConflict({ type: '代課', date: '2026-11-18', weekday: '週三', period: '第三節', className: '901', originalTeacher: '甲', substituteTeacher: '丁' }, [SS]);
check('自我調課後甲為時段 B 請假（核准重驗）不擋', h === null, h && JSON.stringify([h.slot, h.role]));
check('自我調課後甲為時段 B 請假（送出前比對）不算已有異動', matchesRecordSlot(SS, '2026-11-18', '第三節', '901', '甲') === null);
check('自我調課：時段 A 比對維持命中', matchesRecordSlot(SS, '2026-11-16', '第一節', '901', '甲') === 'A');
// L1 不重新開洞：另一位教師對時段 B 的調課／代課仍被擋
h = findAssignmentConflict({ type: '代課', date: '2026-11-18', weekday: '週三', period: '第三節', className: '901', originalTeacher: '丙', substituteTeacher: '丁' }, [SS]);
check('自我調課 B 已由甲上，丙冒稱該節任課者請假 → 仍擋', h?.kind === 'classSlot' && h.slot === 'B', String(h));
h = findAssignmentConflict({ type: '調課', date: '2026-11-18', weekday: '週三', period: '第三節', className: '901', originalTeacher: '丙',
    swapDate: '2026-11-25', swapWeekday: '週三', swapPeriod: '第一節', swapTeacher: '丁' }, [SS]);
check('自我調課 B，丙以該節為時段 A 再調課 → 仍擋', h?.kind === 'classSlot', String(h));
// 自我調課 B 之後甲已有代課，換人再送仍擋（重複佔用）
const subB = { id: 'sb', recordId: 'sb', type: '代課', status: 'approved', date: '2026-11-18', weekday: '週三', period: '第三節', className: '901', originalTeacher: '甲', substituteTeacher: '丁' };
h = findAssignmentConflict({ type: '代課', date: '2026-11-18', weekday: '週三', period: '第三節', className: '901', originalTeacher: '甲', substituteTeacher: '戊' }, [SS, subB]);
check('自我調課 B 已有代課，換人再送 → 仍擋（重複佔用）', h?.role === '代課');
// 時段 A 不變：甲在被搬走的時段 A 仍不可請假
h = findAssignmentConflict({ type: '代課', date: '2026-11-16', weekday: '週一', period: '第一節', className: '901', originalTeacher: '甲', substituteTeacher: '丁' }, [SS]);
check('自我調課 A：甲在被搬走的時段 A 請假 → 擋（維持原行為）', h?.slot === 'A');
// 一般調課 B 仍擋（防止自我調課修改影響一般調課）
const sw = { id: 'sw', recordId: 'sw', type: '調課', status: 'approved', className: '801', date: '2026-11-20', weekday: '週五', period: '第三節', originalTeacher: '王', swapDate: '2026-11-27', swapWeekday: '週五', swapPeriod: '第二節', swapTeacher: '林' };
check('一般調課 B：被調走的林請假 → 仍擋', findClassSlotConflict({ className: '801', date: '2026-11-27', period: '第二節', teacher: '林', records: [sw] })?.slot === 'B');
check('一般調課 B：matchesRecordSlot 林 → B', matchesRecordSlot(sw, '2026-11-27', '第二節', '801', '林') === 'B');

// ---- 項目 6：訊息 ----
{
    const info = describeExistingRecord(sw, '2026-11-27', '第二節', '801', '林');
    check('送出警告：命中時段 B 顯示 B 的日期與節次（不是時段 A）', info.when.includes('2026-11-27') && info.when.includes('第二節') && !info.when.includes('2026-11-20'), info.when);
    const infoA = describeExistingRecord(sw, '2026-11-20', '第三節', '801', '王');
    check('送出警告：命中時段 A 顯示 A 的日期與節次', infoA.when.includes('2026-11-20') && infoA.when.includes('第三節'), infoA.when);
    check('送出警告：已成立紀錄提示去刪除', info.advice.includes('刪除') && !info.pending);
    const pend = describeExistingRecord({ ...sw, __pending: true, __pendingLabel: '待核准中' }, '2026-11-27', '第二節', '801', '林');
    check('送出警告：在途申請說明是已有待審的申請，不叫人刪紀錄', pend.pending && pend.advice.includes('已有待審的申請') && !pend.advice.includes('刪除'), pend.advice);
    const subHit = findClassSlotConflict({ className: '903', date: '2026-11-17', period: '第四節', teacher: '乙', records: [SC] });
    check('核准訊息：同節已有代課，提示先刪除原紀錄再重新送出', describeClassSlotConflict(subHit).includes('若要更換代課教師，請先到調代課紀錄刪除原紀錄再重新送出'), describeClassSlotConflict(subHit));
}

console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
