/**
 * approveRequest 的學期防線（離線、假 SDK）：
 *   - 推算學期已封存（archives/{id} 存在）→ 在寫入任何資料之前中止（SEMESTER_ARCHIVED），沒有任何寫入
 *   - 未封存 → 照常核准，紀錄 semesterId＝依日期推算的學期
 *   - 日期超出目前學期±1 → 在寫入前丟 SemesterUnresolvable
 *   - 預登下學期且課表讀不到：專屬訊息「下學期課表要在開新學期後才能匯入…」
 * 執行：node test/test-approve-archived.mjs
 */
import { register } from 'node:module';

register('./helpers/gstatic-stub-loader.mjs', import.meta.url);
globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const reqSvc = await import('../src/js/modules/v2/pendingRequestService.js');
const roleSvc = await import('../src/js/modules/v2/roleService.js');
const semesterState = await import('../src/js/modules/v2/semesterState.js');
const conflict = await import('../src/js/modules/v2/assignmentConflict.js');

let pass = 0, fail = 0;
const check = (l, c, d = '') => { if (c) pass++; else { fail++; console.error(`✗ ${l} ${d}`); } };
const logConsole = console.log; const logWarn = console.warn; console.log = () => {}; console.warn = () => {};

const F = (globalThis.__fake ||= { docs: new Map(), writes: [] });
const base = 'schools/inhu';
semesterState.setCurrentSemesterId('115-1');
roleSvc.setCurrentIdentity({ teacherId: 'tch_dir', name: '主任', role: 'director' });
const seedReq = (id, date) => F.docs.set(`${base}/pendingRequests/${id}`, {
    requestType: 'substitute', status: 'pending_approval', semesterId: '115-1', createdAt: '2026-11-01T00:00:00.000Z',
    initiatedBy: 'tch_a', initiatedByName: '甲', type: '代課', date, period: '第一節', className: '801',
    originalTeacher: '甲', substituteTeacher: '乙', pendingConsentTeacherIds: [], swapConsents: {},
});
const approve = async (id) => { F.writes.length = 0; try { await reqSvc.approveRequest(id); return { err: null }; } catch (e) { return { err: e }; } };

// 1. 上一學期（114-2）已封存
seedReq('r_arch', '2026-07-31');
F.docs.set(`${base}/archives/114-2`, { semesterId: '114-2', archivedAt: '2026-08-05T00:00:00.000Z' });
let r = await approve('r_arch');
check('已封存學期：丟 SEMESTER_ARCHIVED', r.err && r.err.code === 'SEMESTER_ARCHIVED', String(r.err));
check('已封存學期：中文訊息並提示駁回', r.err && /已封存/.test(r.err.message) && /駁回/.test(r.err.message));
check('已封存學期：沒有任何寫入（含 private/detail、交易）', F.writes.length === 0, JSON.stringify(F.writes.map(w => w.path)));

// 2. 未封存：照常核准，semesterId 依日期
F.docs.delete(`${base}/archives/114-2`);
r = await approve('r_arch');
const tx = F.writes.find(w => w.op === 'tx.set' && w.path.includes('/substituteRecords/'));
check('未封存的上一學期：核准成功', !r.err && !!tx, String(r.err && r.err.stack));
check('紀錄 semesterId 依日期推算為 114-2', tx && tx.data.semesterId === '114-2', tx && tx.data.semesterId);

// 3. 超出窗口
seedReq('r_far', '2025-03-01');
r = await approve('r_far');
check('日期超出目前學期±1：丟 SemesterUnresolvable', r.err && r.err.name === 'SemesterUnresolvable', String(r.err));
check('日期超出窗口：沒有任何寫入', F.writes.length === 0);

console.log = logConsole; console.warn = logWarn;

// 4. 預登下學期課表不可用的專屬訊息
const hit = { teacher: '乙', date: '2027-02-01', period: '第一節', role: 'substitute', scheduleUnavailable: true };
check('下學期課表不可用：專屬訊息', conflict.buildApprovalConflictMessage({ ...hit, nextSemesterSchedule: true }) === conflict.SCHEDULE_NEXT_SEMESTER_MESSAGE
    && /開新學期後才能匯入/.test(conflict.SCHEDULE_NEXT_SEMESTER_MESSAGE) && /請勿駁回/.test(conflict.SCHEDULE_NEXT_SEMESTER_MESSAGE));
check('一般課表不可用：仍是原訊息', conflict.buildApprovalConflictMessage(hit) === conflict.SCHEDULE_UNAVAILABLE_MESSAGE);
check('組長代發同樣使用專屬訊息', conflict.buildAdminCreateConflictMessage({ ...hit, nextSemesterSchedule: true }) === conflict.SCHEDULE_NEXT_SEMESTER_MESSAGE);

console.log(`\n[approve-archived] ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
