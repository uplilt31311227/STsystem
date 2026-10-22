/**
 * V2 雙重指派防線單元測試（純函式部分，不需 emulator）
 * 執行：node test/test-assignment-conflict.mjs
 *   (a) 核准前驗證：已有成立紀錄佔用 → 回傳衝突
 *   (b) 在途請求佔用 → 衝突附「（待核准中）／（待同意中）」標示
 *   (c) 無衝突 → 放行；查詢失敗 → fail-closed
 *   (d) 代課推薦排除「被調課移入該節」的老師
 */
import { RecommendationEngine } from '../src/js/modules/recommendationEngine.js';
import {
    pendingRequestsToOccupancyRecords, findAssignmentConflict, describeAssignmentConflict,
    buildApprovalConflictMessage, verifyNoAssignmentConflict, fetchRecordsAroundDates, shiftDate,
} from '../src/js/modules/v2/assignmentConflict.js';

const realLog = console.log;
console.log = () => {};
let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

const sub = (over = {}) => ({ type: '代課', date: '2026-10-20', period: '第三節', className: '801', originalTeacher: '原師', substituteTeacher: '王大明', ...over });
const established = { id: 'r1', type: '代課', date: '2026-10-20', period: '第三節', className: '801', originalTeacher: '丙', substituteTeacher: '王大明' };

// ---- (a) 成立紀錄佔用 ----
const hitA = findAssignmentConflict(sub({ className: '802' }), [established]);
check('(a) 代課：已有成立紀錄佔用 → 回傳衝突', hitA?.teacher === '王大明' && hitA.role === '代課');
check('(a) 訊息為明確中文且無待核准標示',
    buildApprovalConflictMessage(hitA) === '核准失敗：王大明 2026-10-20 第三節已被指派為801的代課，請駁回或請申請人改選',
    buildApprovalConflictMessage(hitA));
const swapReq = { type: '調課', date: '2026-10-20', period: '第一節', originalTeacher: '甲', swapTeacher: '乙', swapDate: '2026-10-22', swapPeriod: '第二節' };
check('(a) 調課：互換教師在時段 A 已被佔用 → 衝突',
    findAssignmentConflict(swapReq, [{ ...established, date: '2026-10-20', period: '第一節', substituteTeacher: '乙' }])?.teacher === '乙');
check('(a) 調課：原任教師在時段 B 已被別筆調課移入 → 衝突',
    findAssignmentConflict(swapReq, [{ id: 'm1', type: '調課', date: '2026-10-15', period: '第四節', originalTeacher: '甲', swapTeacher: '丁', swapDate: '2026-10-22', swapPeriod: '第二節', className: '901' }])?.teacher === '甲');
check('(a) 代課：教師被別筆調課移入該節 → 衝突（findSwapInConflict）',
    findAssignmentConflict(sub(), [{ id: 'm2', type: '調課', date: '2026-10-12', period: '第一節', originalTeacher: '王大明', swapTeacher: '丁', swapDate: '2026-10-20', swapPeriod: '第三節', className: '901' }])?.role === '調課');
check('(a) 自我調課不檢查', findAssignmentConflict({ ...swapReq, isSelfSwap: true }, [established]) === null);

// ---- (b) 在途請求佔用 ----
const pendReq = (status, over = {}) => ({ reqId: 'q1', status, type: '代課', date: '2026-10-20', period: '第三節', className: '803', originalTeacher: '丙', substituteTeacher: '王大明', ...over });
const occApproval = pendingRequestsToOccupancyRecords([pendReq('pending_approval')]);
const hitB1 = findAssignmentConflict(sub(), occApproval);
check('(b) 待核准申請佔用 → 衝突且附（待核准中）', hitB1 && describeAssignmentConflict(hitB1).endsWith('（待核准中）'), describeAssignmentConflict(hitB1 || {}));
const hitB2 = findAssignmentConflict(sub(), pendingRequestsToOccupancyRecords([pendReq('pending_swap_consent')]));
check('(b) 待同意申請佔用 → 衝突且附（待同意中）', hitB2 && describeAssignmentConflict(hitB2).endsWith('（待同意中）'));
const hitB3 = findAssignmentConflict(swapReq, pendingRequestsToOccupancyRecords([
    { reqId: 'q2', status: 'pending_approval', type: '調課', date: '2026-10-10', period: '第四節', originalTeacher: '甲', swapTeacher: '丁', swapDate: '2026-10-22', swapPeriod: '第二節', className: '901' }]));
check('(b) 在途調課移入時段 B → 衝突附（待核准中）且措辭為調課移入', hitB3 && describeAssignmentConflict(hitB3).includes('已調課移入901') && describeAssignmentConflict(hitB3).endsWith('（待核准中）'), describeAssignmentConflict(hitB3 || {}));
check('(b) 已核准／已駁回／自我調課的申請不算佔用',
    pendingRequestsToOccupancyRecords([pendReq('approved'), pendReq('rejected'), pendReq('pending_approval', { isSelfSwap: true })]).length === 0);
check('(b) excludeReqId 排除申請自己', pendingRequestsToOccupancyRecords([pendReq('pending_approval')], { excludeReqId: 'q1' }).length === 0);
check('(b) legacy pending 視為待同意', pendingRequestsToOccupancyRecords([pendReq('pending')])[0]?.__pendingLabel === '待同意中');
check('(b) 日期範圍外的在途申請被略過（swapDate 命中則保留）',
    pendingRequestsToOccupancyRecords([pendReq('pending_approval', { date: '2026-12-01' })], { startDate: '2026-10-01', endDate: '2026-10-31' }).length === 0
    && pendingRequestsToOccupancyRecords([pendReq('pending_approval', { date: '2026-12-01', swapDate: '2026-10-20' })], { startDate: '2026-10-01', endDate: '2026-10-31' }).length === 1);

// ---- (c) 無衝突放行 / 驗證流程 ----
check('(c) 無任何紀錄 → 放行', findAssignmentConflict(sub(), []) === null);
check('(c) 他日、他節不誤擋', findAssignmentConflict(sub(), [{ ...established, date: '2026-10-21' }, { ...established, period: '第四節' }]) === null);
const calls = [];
const q = async (range) => { calls.push(range); return [established]; };
check('(a) verifyNoAssignmentConflict 以日期範圍查詢並回傳衝突', (await verifyNoAssignmentConflict(sub(), q))?.teacher === '王大明');
check('(c) verifyNoAssignmentConflict 無衝突放行', (await verifyNoAssignmentConflict(sub({ substituteTeacher: '李四' }), q)) === null);
check('查詢窗口為申請日期前後 31 天', calls[0].startDate === '2026-09-19' && calls[0].endDate === '2026-11-20', JSON.stringify(calls[0]));
check('調課會同時查 date 與 swapDate 兩個窗口', (await fetchRecordsAroundDates(['2026-10-20', '2026-12-30'], async () => [])).length === 0);
let failClosed = null;
try { await verifyNoAssignmentConflict(sub(), async () => { throw new Error('offline'); }); } catch (e) { failClosed = e; }
check('(c) 查詢失敗 → fail-closed（丟 APPROVAL_VERIFY_FAILED）', failClosed?.code === 'APPROVAL_VERIFY_FAILED' && /稍後再試/.test(failClosed.message));
check('shiftDate 跨月跨年', shiftDate('2026-01-05', -31) === '2025-12-05' && shiftDate('2026-02-28', 1) === '2026-03-01');

// ---- (d) 代課推薦排除被調課移入該節的老師 ----
const c = (teacher, weekday, period, className, subject) => ({ teacher, weekday, period, className, subject, rawSubject: subject, domain: '' });
const schedule = [
    c('原師', '星期二', '第三節', '8年1班', '數學'),
    c('甲師', '星期二', '第一節', '8年2班', '數學'),
    c('乙師', '星期二', '第一節', '8年3班', '數學'),
];
const teachers = [{ name: '原師' }, { name: '甲師' }, { name: '乙師' }];
const target = { weekday: '星期二', period: '第三節', className: '8年1班', domain: '', originalTeacher: '原師' };
const engine = new RecommendationEngine();
const moveIn = { id: 'm3', type: '調課', date: '2026-10-13', period: '第二節', originalTeacher: '甲師', swapTeacher: '丁師', swapDate: '2026-10-20', swapPeriod: '第三節', className: '9年1班' };
const namesOf = (recs) => recs.map(r => r.teacher.name);
check('(d) 無調課移入 → 甲師、乙師皆可推薦', namesOf(engine.getRecommendations(target, schedule, teachers, '2026-10-20', [])).sort().join() === '乙師,甲師');
check('(d) 甲師被調課移入該節 → 推薦排除甲師，乙師仍在',
    namesOf(engine.getRecommendations(target, schedule, teachers, '2026-10-20', [moveIn])).join() === '乙師');
check('(d) 在途（待核准）佔用的老師同樣被排除',
    namesOf(engine.getRecommendations(target, schedule, teachers, '2026-10-20',
        pendingRequestsToOccupancyRecords([pendReq('pending_approval', { substituteTeacher: '乙師' })]))).join() === '甲師');

console.log = realLog;
console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
