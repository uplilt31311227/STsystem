/**
 * P0 驗收缺陷修復單元測試
 * 執行：node test/test-p0-fixes.mjs
 *   (a) collectLeavePeriods：調課（含自我調課）不算請假；節次依節次順序排列
 *   (b) 遠距調課（date 與 swapDate 相差 >31 天）的「移入」能被衝堂判斷抓到：V1 路徑與 V2 注入資料來源
 *   (c) 多節代課送出：occupancy 查詢次數 = 不重複日期數
 *   (d) 短 TTL 快取：TTL 內只讀一次、invalidate／過期後重讀、失敗不快取
 *   (e) adminCreate 衝堂訊息與核准訊息分開；結算明細過 isEffectiveRecord
 */
import { RecommendationEngine, periodIndex } from '../src/js/modules/recommendationEngine.js';
import { DataManager } from '../src/js/modules/dataManager.js';
import { SettlementCalculator } from '../src/js/modules/settlementCalculator.js';
import {
    verifyNoAssignmentConflict, buildApprovalConflictMessage, buildAdminCreateConflictMessage,
    findAssignmentConflict, createShortTtlCache, dedupeRecords,
} from '../src/js/modules/v2/assignmentConflict.js';

const realLog = console.log;
console.log = () => {};
let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

// ===== (a) collectLeavePeriods =====
const engine = new RecommendationEngine();
const D = '2026-10-20';
const leave = engine.collectLeavePeriods([
    { type: '代課', date: D, period: '第五節', originalTeacher: '甲', substituteTeacher: '乙' },
    { type: '代課', date: D, period: '第二節', originalTeacher: '甲', substituteTeacher: '乙' },
    { type: '代課', date: D, period: '第十節', originalTeacher: '甲', substituteTeacher: '乙' },
    { type: '代課', date: D, period: '第八節', originalTeacher: '甲', substituteTeacher: '乙' },
    { type: '調課', date: D, period: '第一節', originalTeacher: '王小華', swapTeacher: '丙', swapDate: '2026-10-22', swapPeriod: '第二節' },
    { type: '調課', date: D, period: '第三節', originalTeacher: '丁', swapTeacher: '丁', isSelfSwap: true },
    { type: '代課', date: D, period: '第四節', originalTeacher: '戊', status: 'rejected' },
], D);
check('(a) 調課的 originalTeacher 不算請假', !leave.has('王小華'));
check('(a) 自我調課不算請假', !leave.has('丁'));
check('(a) 被拒絕不算', !leave.has('戊'));
check('(a) 節次依節次順序排列（第二、五、八、未知排最後）',
    JSON.stringify(leave.get('甲')) === JSON.stringify(['第二節', '第五節', '第八節', '第十節']), JSON.stringify(leave.get('甲')));
check('(a) periodIndex 順序', periodIndex('第一節') < periodIndex('第八節') && periodIndex('第八節') < periodIndex('不明'));

// ===== (b) 遠距調課移入 =====
// 調課：date=09-01（甲第一節），swapDate=11-16（甲被調去上 11-16 第三節乙的課）→ 甲在 11-16 第三節被佔用
const farSwap = { id: 'far1', type: '調課', date: '2026-09-01', period: '第一節', originalTeacher: '甲', swapTeacher: '乙',
    swapDate: '2026-11-16', swapPeriod: '第三節', className: '801' };
const unrelated = { id: 'x1', type: '代課', date: '2026-11-10', period: '第二節', originalTeacher: '丙', substituteTeacher: '丁', className: '802' };

// V1 路徑：本機模式（DataManager 預設 substituteRecords）
const dm = new DataManager();
dm.substituteRecords = [farSwap, unrelated];
dm.getActiveScheduleData = () => [];
const v1 = await dm.checkSubstituteTeacherConflictAsync('甲', '2026-11-16', '週一', '第三節');
check('(b) V1：遠距調課移入 11-16 被抓到', typeof v1 === 'string' && v1.includes('已調課移入'), String(v1));
check('(b) V1：不同節次不誤擋', await dm.checkSubstituteTeacherConflictAsync('甲', '2026-11-16', '週一', '第四節') === null);
const v1rows = await dm.getAssignmentOccupancyRecordsAsync('2026-11-01', '2026-11-30');
check('(b) V1：範圍內結果含遠距調課且不重複', v1rows.filter(r => r.id === 'far1').length === 1 && v1rows.some(r => r.id === 'x1'));

// V2 注入資料來源：模擬 queryRecordsOccupyingRange（date ∪ swapDate）；窗口 ±31 天只靠 date 會漏
const store = [farSwap, unrelated];
const inRange = (d, a, b) => !!d && d >= a && d <= b;
const queryByDateOnly = async ({ startDate, endDate }) => store.filter(r => inRange(r.date, startDate, endDate));
const queryOccupying = async ({ startDate, endDate }) =>
    dedupeRecords([...store.filter(r => inRange(r.date, startDate, endDate)), ...store.filter(r => inRange(r.swapDate, startDate, endDate))]);
const req = { type: '代課', date: '2026-11-16', period: '第三節', originalTeacher: '丙', substituteTeacher: '甲', className: '803' };
check('(b) V2 對照：只查 date 窗口會漏判（證明缺陷存在）', await verifyNoAssignmentConflict(req, queryByDateOnly) === null);
const hitV2 = await verifyNoAssignmentConflict(req, queryOccupying);
check('(b) V2：含 swapDate 查詢後抓到遠距調課移入', hitV2?.teacher === '甲' && hitV2.role === '調課', JSON.stringify(hitV2));
const swapReq = { type: '調課', date: '2026-11-16', period: '第三節', originalTeacher: '戊', swapTeacher: '甲', swapDate: '2026-11-17', swapPeriod: '第一節' };
check('(b) V2：調課申請（互換教師在時段 A 被遠距調課移入）也抓到', (await verifyNoAssignmentConflict(swapReq, queryOccupying))?.teacher === '甲');

// ===== (c) 多節代課：occupancy 查詢次數 = 不重複日期數 =====
let calls = 0;
const dm2 = new DataManager();
dm2.getActiveScheduleData = () => [];
dm2.getAssignmentOccupancyRecordsAsync = async () => { calls++; return []; };
const items = [
    { substituteTeacher: '甲', date: '2026-10-20', weekday: '週二', period: '第一節', id: 'a' },
    { substituteTeacher: '甲', date: '2026-10-20', weekday: '週二', period: '第二節', id: 'b' },
    { substituteTeacher: '甲', date: '2026-10-20', weekday: '週二', period: '第三節', id: 'c' },
    { substituteTeacher: '甲', date: '2026-10-21', weekday: '週三', period: '第一節', id: 'd' },
    { substituteTeacher: '甲', date: '2026-10-21', weekday: '週三', period: '第二節', id: 'e' },
];
check('(c) 無衝突回傳 null', await dm2.checkSubstituteTeacherConflictsBatchAsync(items) === null);
check('(c) 5 節、2 個不重複日期 → 查詢 2 次', calls === 2, `calls=${calls}`);
calls = 0;
dm2.getAssignmentOccupancyRecordsAsync = async () => { calls++; return [{ id: 'z', type: '代課', date: '2026-10-21', period: '第二節', originalTeacher: '丙', substituteTeacher: '甲', className: '801' }]; };
const conflictMsg = await dm2.checkSubstituteTeacherConflictsBatchAsync(items);
check('(c) 批次內第二天第二節衝突被抓到', typeof conflictMsg === 'string' && conflictMsg.includes('第二節'), String(conflictMsg));
check('(c) 有衝突時查詢次數仍 = 不重複日期數', calls === 2, `calls=${calls}`);
let threw = false;
dm2.getAssignmentOccupancyRecordsAsync = async () => { throw new Error('boom'); };
try { await dm2.checkSubstituteTeacherConflictsBatchAsync(items); } catch { threw = true; }
check('(c) 讀取失敗向上丟出（呼叫端 fail-closed）', threw);

// ===== (d) 短 TTL 快取 =====
let loads = 0, clock = 0;
const cache = createShortTtlCache(async () => { loads++; return [loads]; }, 5000, () => clock);
await Promise.all([cache.get(), cache.get(), cache.get()]);
check('(d) 同時觸發只讀一次（in-flight 去重）', loads === 1);
clock = 4000; await cache.get();
check('(d) TTL 內不重讀', loads === 1);
clock = 5000; await cache.get();
check('(d) 過期後重讀', loads === 2);
cache.invalidate(); await cache.get();
check('(d) invalidate 後重讀', loads === 3);
let fail = true, n = 0;
const c2 = createShortTtlCache(async () => { n++; if (fail) throw new Error('x'); return 1; }, 5000, () => clock);
await c2.get().catch(() => {}); await Promise.resolve();
fail = false; await c2.get();
check('(d) 失敗不快取', n === 2);

// ===== (e) 訊息與結算 =====
const hit = findAssignmentConflict(req, [{ id: 'r', type: '代課', date: '2026-11-16', period: '第三節', originalTeacher: '丙', substituteTeacher: '甲', className: '801' }]);
const approveMsg = buildApprovalConflictMessage(hit), adminMsg = buildAdminCreateConflictMessage(hit, req);
check('(e) 核准訊息維持「核准失敗：…請駁回」', approveMsg.startsWith('核准失敗：') && approveMsg.includes('請駁回'));
check('(e) adminCreate 訊息為「無法成立：…請改選代課教師」', adminMsg.startsWith('無法成立：') && adminMsg.endsWith('請改選代課教師') && !adminMsg.includes('駁回'), adminMsg);
check('(e) adminCreate 調課訊息改提示互換課程或日期', buildAdminCreateConflictMessage(hit, { type: '調課' }).endsWith('請重新選擇互換課程或日期'));
const calc = new SettlementCalculator();
const recs = [
    { type: '代課', date: '2026-10-05', period: '第一節', originalTeacher: '甲', substituteTeacher: '乙', leaveType: 'personal', status: 'approved' },
    { type: '代課', date: '2026-10-06', period: '第一節', originalTeacher: '甲', substituteTeacher: '乙', leaveType: 'personal', status: 'pending_approval' },
    { type: '代課', date: '2026-10-07', period: '第一節', originalTeacher: '甲', substituteTeacher: '乙', leaveType: 'personal', deleted: true },
];
check('(e) getDetailedSettlement 排除非核准／已刪除', calc.getDetailedSettlement(recs, '甲').deductedHours === 1 && calc.getDetailedSettlement(recs, '乙').substituteCount === 1);
check('(e) getSubstituteDetails 排除非核准／已刪除', calc.getSubstituteDetails(recs, '甲').substitutedRecords.length === 1);

console.log = realLog;
if (failed) { console.error(`\n${failed} 項失敗`); process.exit(1); }
console.log('\n全部通過');
