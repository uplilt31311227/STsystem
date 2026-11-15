/**
 * P6：申請流程服務層（pendingRequestService）的離線測試（假 Firebase SDK）
 * 涵蓋：撤回前檢查狀態、批次依賴（核准／駁回連帶／撤回連帶）、組長批次全有或全無、序號鎖寫入。
 * 併發（同時核准、連點）需要真的交易隔離，見 test/emulator/p6-concurrency.mjs。
 * 執行：node test/test-p6-services.mjs
 */
import { register } from 'node:module';
register('./helpers/gstatic-stub-loader.mjs', import.meta.url);

globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.document = { getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const F = (globalThis.__fake = { docs: new Map(), writes: [] });

const req = await import('../src/js/modules/v2/pendingRequestService.js');
const roleSvc = await import('../src/js/modules/v2/roleService.js');
const semesterState = await import('../src/js/modules/v2/semesterState.js');
const { SCHEMA_PATHS } = await import('../src/js/modules/v2/schemaConstants.js');

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}
const realLog = console.log, realWarn = console.warn, realErr = console.error;
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };

semesterState.setCurrentSemesterId('115-1');
const asTeacher = (id = 't_wang', name = '王老師') => roleSvc.setCurrentIdentity({ uid: 'u_' + id, email: id + '@x', teacherId: id, name, role: 'teacher' });
const asChief = () => roleSvc.setCurrentIdentity({ uid: 'u_chief', email: 'chief@x', teacherId: 't_chief', name: '組長', role: 'section_chief' });
const reset = () => { F.docs.clear(); F.writes.length = 0; };
const putReq = (id, over = {}) => F.docs.set(SCHEMA_PATHS.pendingDoc(id), {
    type: '調課', requestType: 'swap', status: 'pending_approval', date: '2026-12-04', weekday: '週五', period: '第三節', className: '801',
    originalTeacher: '王老師', swapDate: '2026-12-11', swapWeekday: '週五', swapPeriod: '第二節', swapTeacher: '林老師',
    initiatedBy: 't_wang', pendingConsentTeacherIds: [], swapConsents: {}, semesterId: '115-1', createdAt: '2026-11-14T00:00:00.000Z', ...over,
});
const exists = (path) => F.docs.has(path);
const P = (id) => SCHEMA_PATHS.pendingDoc(id);
const wrote = (pred) => F.writes.some(pred);

quiet();

// ---- (4) 撤回前檢查狀態 ----
reset(); asTeacher();
putReq('rq_open');
await req.cancelRequest('rq_open');
check('撤回：在途申請 → 刪除成功', !exists(P('rq_open')));

reset(); asTeacher();
putReq('rq_done', { status: 'approved' });
let err = null;
try { await req.cancelRequest('rq_done'); } catch (e) { err = e; }
check('撤回：已核准的申請 → 丟 ALREADY_PROCESSED，文件原封不動', err?.code === 'ALREADY_PROCESSED' && exists(P('rq_done')), String(err));
check('撤回：已核准的訊息說明無法撤回', /已核准成立/.test(err?.message || ''));

reset(); asTeacher();
putReq('rq_rej', { status: 'rejected' });
err = null;
try { await req.cancelRequest('rq_rej'); } catch (e) { err = e; }
check('撤回：已被駁回的申請不能用撤回（應用「我知道了」）', err?.code === 'ALREADY_PROCESSED' && exists(P('rq_rej')));

// ---- 批次：撤回以批次為單位 ----
reset(); asTeacher();
putReq('b1', { batchId: 'B1', batchSize: 3 }); putReq('b2', { batchId: 'B1', batchSize: 3 }); putReq('b3', { batchId: 'B1', batchSize: 3 });
await req.cancelRequest('b1');
check('批次撤回：同批其餘在途申請一併撤回', !exists(P('b1')) && !exists(P('b2')) && !exists(P('b3')));

reset(); asTeacher();
putReq('c1', { batchId: 'B2', batchSize: 2 }); putReq('c2', { batchId: 'B2', batchSize: 2, status: 'approved' });
err = null;
try { await req.cancelRequest('c1'); } catch (e) { err = e; }
check('批次撤回：同批已有核准成立者 → 不可單獨撤回剩下的', !!err && /已有申請核准成立/.test(err.message) && exists(P('c1')), String(err));

// ---- 批次：駁回連帶、核准依賴 ----
reset(); asChief();
putReq('d1', { batchId: 'B3', batchSize: 2 }); putReq('d2', { batchId: 'B3', batchSize: 2 });
await req.rejectRequest('d1', '不同意');
check('批次駁回：組長駁回一筆 → 同批在途申請一併駁回', F.docs.get(P('d1')).status === 'rejected' && F.docs.get(P('d2')).status === 'rejected');

reset(); asChief();
putReq('e1', { batchId: 'B4', batchSize: 2 }); putReq('e2', { batchId: 'B4', batchSize: 2, status: 'rejected' });
err = null;
try { await req.approveRequest('e1'); } catch (e) { err = e; }
check('批次核准：同批另一筆已被駁回 → 核准失敗（repro-02：駁回後單獨核准剩下那筆）', err?.code === 'ASSIGNMENT_CONFLICT' && /已被駁回/.test(err.message), String(err?.message));
check('批次核准失敗時沒有建立任何紀錄', !wrote(w => w.path.includes('/substituteRecords/')));
check('批次核准失敗時申請仍待核准', F.docs.get(P('e1')).status === 'pending_approval');

reset(); asChief();
putReq('f1', { batchId: 'B5', batchSize: 2 });
err = null;
try { await req.approveRequest('f1'); } catch (e) { err = e; }
check('批次核准：同批另一筆已被撤回（筆數不足）→ 核准失敗', err?.code === 'ASSIGNMENT_CONFLICT' && /只剩 1 筆/.test(err.message), String(err?.message));

reset(); asChief();
putReq('g1', { batchId: 'B6', batchSize: 2 }); putReq('g2', { batchId: 'B6', batchSize: 2 });
let saved = null;
try { saved = await req.approveRequest('g1'); } catch (e) { err = e; }
check('批次核准：同批都在途 → 可以核准這一筆', !!saved?.recordId && F.docs.get(P('g1')).status === 'approved', String(err));
const lock = F.docs.get(SCHEMA_PATHS.recordsLock());
check('核准同一個交易內把序號鎖 seq 加 1', lock?.seq === 1, JSON.stringify(lock));

// ---- (5) 組長批次全有或全無 ----
const leg = (i, over = {}) => ({
    type: '調課', className: '801', batchId: 'AB1', batchSize: 3, date: `2026-12-0${i}`, weekday: '週五', period: '第三節', originalTeacher: '王老師',
    swapDate: `2026-12-1${i}`, swapWeekday: '週五', swapPeriod: '第二節', swapTeacher: '林老師', substituteTeacher: '林老師',
    leaveType: '調課', leaveTypeName: '調課', reason: 'x', initiatedBy: 't_wang', initiatedByName: '王老師', id: `x_${i}`, ...over,
});
reset(); asChief();
const out = await req.adminCreateBatch([leg(1), leg(2), leg(3)]);
const recWrites = F.writes.filter(w => /\/substituteRecords\/rec_[^/]+$/.test(w.path));
check('組長批次：3 筆全部在同一個交易內成立', out.length === 3 && recWrites.length === 3 && recWrites.every(w => w.op === 'tx.set'));
check('組長批次：序號鎖只加 1', F.docs.get(SCHEMA_PATHS.recordsLock())?.seq === 1);

reset(); asChief();
// 既有紀錄佔用第 3 筆的時段 B（王老師要調去上 12/13 第二節，但他當天該節已被指派代別班的課）
F.docs.set(SCHEMA_PATHS.substituteDoc('rec_exist'), { id: 'e', type: '代課', status: 'approved', date: '2026-12-13', weekday: '週五', period: '第二節', className: '802', originalTeacher: '甲', substituteTeacher: '王老師' });
err = null;
try { await req.adminCreateBatch([leg(1), leg(2), leg(3, { swapDate: '2026-12-13' })]); } catch (e) { err = e; }
check('組長批次：第 3 筆衝堂 → 整批丟 ASSIGNMENT_CONFLICT', err?.code === 'ASSIGNMENT_CONFLICT', String(err?.message));
check('組長批次：衝堂時前 2 筆也沒有成立（全有或全無）', !wrote(w => /\/substituteRecords\/rec_/.test(w.path)) && !wrote(w => w.path === SCHEMA_PATHS.recordsLock()));

reset(); asChief();
F.docs.set(SCHEMA_PATHS.substituteDoc('rec_exist2'), { id: 'e2', type: '調課', status: 'approved', className: '801', date: '2026-12-04', weekday: '週五', period: '第三節',
    originalTeacher: '王老師', swapDate: '2026-12-18', swapWeekday: '週五', swapPeriod: '第二節', swapTeacher: '林老師' });
err = null;
try { await req.adminCreate(leg(1, { batchId: undefined, date: '2026-12-18', period: '第二節', originalTeacher: '林老師', swapTeacher: '張老師', substituteTeacher: '張老師', swapDate: '2026-12-25', swapPeriod: '第一節' })); } catch (e) { err = e; }
check('組長代發：班級時段已被別筆調課換過任課者（林老師被調走的時段 B）→ 擋下', err?.code === 'ASSIGNMENT_CONFLICT' && /已有調課紀錄/.test(err.message), String(err?.message));

reset(); asChief();
let idx = 0;
F.beforeTxCommit = null;
const single = await req.adminCreate(leg(1, { batchId: undefined }));
check('組長代發：無衝突 → 成立一筆並寫入序號鎖', !!single.recordId && F.docs.get(SCHEMA_PATHS.recordsLock())?.seq === 1);

// ---- 核准前預讀不到／狀態不符：不得跳過衝堂重驗直接進交易 ----
for (const [label, pre, code] of [['預讀不到申請', null, 'REQUEST_NOT_FOUND'], ['預讀時狀態已不是在途', { status: 'approved' }, 'ALREADY_PROCESSED']]) {
    reset(); asChief();
    // 已成立紀錄佔走代課教師，若跳過重驗就會雙重成立
    putReq('h1', { type: '代課', requestType: 'substitute', substituteTeacher: '林老師', date: '2026-12-04', period: '第三節', className: '801', swapDate: undefined });
    F.docs.set(SCHEMA_PATHS.substituteDoc('rec_busy'), { id: 'b', type: '代課', status: 'approved', date: '2026-12-04', weekday: '週五', period: '第三節', className: '802', originalTeacher: '甲', substituteTeacher: '林老師' });
    F.getDocOnce = { [P('h1')]: pre === null ? null : { ...F.docs.get(P('h1')), ...pre } };
    err = null; let got = null;
    try { got = await req.approveRequest('h1'); } catch (e) { err = e; }
    check(`核准：${label} → 中止並回報已被處理，不成立紀錄`, err?.code === code && !got && !wrote(w => w.path.includes('/substituteRecords/rec_')) && F.docs.get(P('h1')).status === 'pending_approval', String(err?.code) + ' ' + String(err?.message));
    F.getDocOnce = null;
}

loud();
console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
