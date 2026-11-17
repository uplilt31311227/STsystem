/**
 * P9（LF-L2）：撤回／關閉駁回／刪紀錄時連明細一起原子刪除、舊 rules 退回路徑、核准遇明細遺失中止（假 Firebase SDK）
 * 執行：node test/test-p9-detail-delete.mjs
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

quiet();

const D = (id) => SCHEMA_PATHS.pendingDetailDoc(id);
const RD = (id) => SCHEMA_PATHS.substituteDetailDoc(id);
const logged = () => F.writes.filter(w => JSON.stringify(w.data || '').includes('detail_delete_failed'));
const deletedPaths = () => F.writes.filter(w => /delete$/.test(w.op)).map(w => w.path);
const putDetail = (id) => F.docs.set(D(id), { leaveType: 'official', leaveTypeName: '公假', reason: '研習', allowedTeacherIds: ['t_wang'] });

// 1 撤回：交易內同時刪父文件與明細（原子）
reset(); asTeacher(); putReq('c1'); putDetail('c1');
await req.cancelRequest('c1');
check('撤回：同一個交易內刪父文件與 private/detail', F.writes.filter(w => w.op === 'tx.delete').map(w => w.path).sort().join() === [P('c1'), D('c1')].sort().join(), JSON.stringify(deletedPaths()));
check('撤回成功（明細也刪成）：不記 detail_delete_failed', logged().length === 0);

// 2 舊 rules（明細刪除被拒）：退回只刪父文件並記錄
reset(); asTeacher(); putReq('c2'); putDetail('c2'); F.denyPrivateDelete = true;
await req.cancelRequest('c2');
check('舊 rules：撤回仍成功（父文件已刪）', !exists(P('c2')) && deletedPaths().includes(P('c2')));
check('舊 rules：明細沒刪、記一筆 detail_delete_failed', exists(D('c2')) && logged().length === 1);
F.denyPrivateDelete = false;

// 3 已核准不可撤回：不刪任何東西、不記失敗
reset(); asTeacher(); putReq('c3', { status: 'approved' }); putDetail('c3');
let err = null; try { await req.cancelRequest('c3'); } catch (e) { err = e; }
check('已核准申請不可撤回：明細與父文件都保留、不記失敗', err?.code === 'ALREADY_PROCESSED' && exists(P('c3')) && exists(D('c3')) && logged().length === 0 && deletedPaths().length === 0);

// 4 非權限錯誤（斷線）：不退回、不吞掉，父文件不刪
reset(); asTeacher(); putReq('c4'); putDetail('c4');
F.beforeTxCommit = () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }); };
err = null; try { await req.cancelRequest('c4'); } catch (e) { err = e; }
F.beforeTxCommit = null;
check('斷線（unavailable）：撤回失敗並丟出，父文件與明細都還在、不記失敗', err?.code === 'unavailable' && exists(P('c4')) && exists(D('c4')) && logged().length === 0);

// 5 同批撤回：每一筆各自原子刪除
reset(); asTeacher();
putReq('b1', { batchId: 'B1', batchSize: 2 }); putReq('b2', { batchId: 'B1', batchSize: 2 }); putDetail('b1'); putDetail('b2');
await req.cancelRequest('b1');
check('同批撤回：兩筆的父文件與明細都在交易內刪除', [P('b1'), D('b1'), P('b2'), D('b2')].every(p => F.writes.some(w => w.op === 'tx.delete' && w.path === p)));

// 6 關閉駁回通知：batch 同刪；舊 rules 退回
reset(); asTeacher(); putReq('r1', { status: 'rejected' }); putDetail('r1');
await req.dismissRejectedRequest('r1');
check('關閉駁回通知：batch 同時刪父文件與明細', F.writes.filter(w => w.op === 'batch.delete').map(w => w.path).sort().join() === [P('r1'), D('r1')].sort().join() && logged().length === 0);
reset(); asTeacher(); putReq('r2', { status: 'rejected' }); putDetail('r2'); F.denyPrivateDelete = true;
await req.dismissRejectedRequest('r2');
check('關閉駁回通知（舊 rules）：退回只刪父文件並記錄', deletedPaths().includes(P('r2')) && !deletedPaths().includes(D('r2')) && logged().length === 1);
F.denyPrivateDelete = false;

// 7 組長刪紀錄
const putRec = (id) => F.docs.set(SCHEMA_PATHS.substituteDoc(id), { type: '代課', status: 'approved', date: '2026-12-04', period: '第三節', className: '801', originalTeacher: '王老師', substituteTeacher: '林老師', semesterId: '115-1' });
reset(); asChief(); putRec('rec1'); F.docs.set(RD('rec1'), { leaveType: 'official', allowedTeacherIds: [] });
await req.adminDeleteRecord('rec1');
check('刪紀錄：batch 同時刪父文件與明細', F.writes.filter(w => w.op === 'batch.delete').map(w => w.path).sort().join() === [SCHEMA_PATHS.substituteDoc('rec1'), RD('rec1')].sort().join() && logged().length === 0);
reset(); asChief(); putRec('rec2'); F.docs.set(RD('rec2'), { leaveType: 'official', allowedTeacherIds: [] }); F.denyPrivateDelete = true;
await req.adminDeleteRecord('rec2');
check('刪紀錄（舊 rules）：退回只刪父文件並記錄一筆 detail_delete_failed', deletedPaths().includes(SCHEMA_PATHS.substituteDoc('rec2')) && !deletedPaths().includes(RD('rec2')) && logged().length === 1);
F.denyPrivateDelete = false;

// 8 核准：標記有明細卻讀到 null → 中止；沒有標記（舊申請）→ 照舊可核准；有標記且明細在 → 核准且標記不進紀錄
reset(); asChief(); putReq('a1', { hasDetail: true });
err = null; let got = null; try { got = await req.approveRequest('a1'); } catch (e) { err = e; }
check('核准：hasDetail=true 但明細不存在 → 中止（DETAIL_MISSING），不成立紀錄、申請仍待核准', err?.code === 'DETAIL_MISSING' && !got && !wrote(w => w.path.includes('/substituteRecords/')) && F.docs.get(P('a1')).status === 'pending_approval', String(err?.code));
check('核准中止訊息為中文且說明原因', /假別明細已遺失/.test(err?.message || ''));
reset(); asChief(); putReq('a2');
got = null; err = null; try { got = await req.approveRequest('a2'); } catch (e) { err = e; }
check('核准：舊申請（無 hasDetail 標記）沒有明細 → 維持原行為可核准', !!got?.recordId, String(err));
reset(); asChief(); putReq('a3', { hasDetail: true }); putDetail('a3');
got = null; err = null; try { got = await req.approveRequest('a3'); } catch (e) { err = e; }
check('核准：hasDetail=true 且明細在 → 核准，假別帶到新紀錄', !!got?.recordId && F.docs.get(RD(got.recordId))?.leaveType === 'official', String(err));
check('hasDetail 標記不會複製到成立的紀錄父文件', got && F.docs.get(SCHEMA_PATHS.substituteDoc(got.recordId)) && !('hasDetail' in F.docs.get(SCHEMA_PATHS.substituteDoc(got.recordId))));

// 9 createRequest：有敏感欄位時父文件帶 hasDetail:true
reset(); asTeacher();
const created = await req.createRequest({ type: '代課', requestType: 'substitute', date: '2026-12-04', weekday: '週五', period: '第三節', className: '801', subject: '國語文', domain: '語文', originalTeacher: '王老師', substituteTeacher: '林老師', originalTeacherId: 't_wang', substituteTeacherId: 't_lin', requiredApproverId: 't_lin', leaveType: '公假', leaveTypeName: '公假', reason: '研習', initiatedBy: 't_wang', initiatedByName: '王老師' });
check('createRequest：有假別事由 → 父文件帶 hasDetail:true、明細已寫', F.docs.get(P(created.reqId))?.hasDetail === true && exists(D(created.reqId)) && !('leaveType' in F.docs.get(P(created.reqId))));

loud();
console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
