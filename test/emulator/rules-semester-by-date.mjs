#!/usr/bin/env node
/**
 * firestore.rules v2.18（LC-L7／LF-M8）：紀錄與申請的學期歸屬依日期推算，寫入窗口＝目前學期＋相鄰學期
 *
 *   A. create（substituteRecords／pendingRequests／教師自我調課）：
 *      目前學期（原行為）→ ALLOW；相鄰學期且 semesterId 與 date 推算一致 → ALLOW；
 *      與 date 對不上、相隔 2 個學期以上、date 格式／月日不合法、前一學期已封存 → DENY
 *   B. update／delete（approver）：目前學期或更晚的學期 → ALLOW；已過去學期 → DENY（director 刪除不受限，不變）
 *   C. private/detail（紀錄與申請）：父文件屬目前或更晚學期 → ALLOW；過去學期 → DENY
 *   D. 換學期後（config.currentSemester 改為 115-2）：補登上學期 115-1、預登下一學年 116-1 → ALLOW
 *
 * 現行資料：目前學期 115-1。台灣學制：2027-02-01 起為 115-2、2026-07-31 仍為 114-2。
 * 用法：先 npm run emu，再 node test/emulator/rules-semester-by-date.mjs（會清空並重建 emulator 資料）
 */
import { createDoc, updateDoc, deleteDoc, mustSetDoc, mergeDoc } from './emu-client.mjs';
import { Suite, allowed, denied } from '../scenarios/harness.mjs';
import {
    setup, P, as, iso, appSubstituteRecord, appSwapRecord, resolveApproverInfo, writeV2Payload,
    buildPendingRequestDocs, nameToIdMap,
} from './kit.mjs';

const W = await setup();
const { semesterId: CUR, fixture, dir, chief, t1, t2 } = W;
const nameToId = nameToIdMap(fixture);
const suite = new Suite(`firestore.rules v2.18：學期歸屬依日期（目前學期 ${CUR}）`);
const rid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const ARCH = (sid) => `schools/demo-alpha/archives/${sid}`;

if (CUR !== '115-1') { console.error(`本測試假設目前學期為 115-1，實得 ${CUR}`); process.exit(1); }

const base = { type: '代課', weekday: '週二', period: '第三節', className: '801', subject: '數學',
    originalTeacher: '甲', substituteTeacher: '乙', status: 'approved', createdAt: iso(), approvedAt: iso() };
/** 組長（approver）建立紀錄。 */
const chiefRec = (over, id = rid('rec')) => createDoc(P.records, id, { ...base, ...over }, as(chief));

function selfSwapDoc(me, over) {
    const rec = appSwapRecord({ teacherA: me.name, teacherB: me.name, self: true });
    const payload = writeV2Payload(rec, resolveApproverInfo(rec, nameToId), me);
    const now = iso();
    const pub = { ...payload, status: 'approved', initiatedByRole: 'teacher', semesterId: CUR, createdAt: now, approvedAt: now, ...over };
    for (const f of ['leaveType', 'leaveTypeName', 'reason']) delete pub[f];
    return pub;
}
function pendingDocFor(me, over) {
    const rec = appSubstituteRecord({ original: me.name, substitute: t2.name });
    const built = buildPendingRequestDocs(writeV2Payload(rec, resolveApproverInfo(rec, nameToId), me), CUR, me);
    return { ...built.publicDoc, ...over };
}

/* ===================== A. create：substituteRecords（組長） ===================== */

await suite.case('A-1 目前學期、日期在目前學期 → ALLOW（原行為不變）', async () => {
    allowed(await chiefRec({ date: '2026-11-17', semesterId: '115-1' }), '115-1 / 2026-11-17');
});
await suite.case('A-2 [邊界] 目前學期最後一天 2027-01-31 → ALLOW；下學期第一天 2027-02-01 帶 115-2 → ALLOW', async () => {
    allowed(await chiefRec({ date: '2027-01-31', semesterId: '115-1' }), '學期最後一天');
    allowed(await chiefRec({ date: '2027-02-01', semesterId: '115-2' }), '下學期第一天預登');
});
await suite.case('A-3 ATTACK 下一學期 115-2 但 date 是目前學期內 → DENY（semesterId 與 date 對不上）', async () => {
    denied(await chiefRec({ date: '2026-11-17', semesterId: '115-2' }), 'date 對不上');
    denied(await chiefRec({ date: '2027-01-31', semesterId: '115-2' }), '下學期前一天標成下學期');
});
await suite.case('A-4 ATTACK 日期是下學期卻標錯誤學期（114-2）→ DENY', async () => {
    denied(await chiefRec({ date: '2027-02-01', semesterId: '114-2' }), '日期 115-2 標 114-2');
});
await suite.case('A-5 補登上一學期（114-2，2026-07-31，未封存）→ ALLOW；該學期已封存後 → DENY', async () => {
    allowed(await chiefRec({ date: '2026-07-31', semesterId: '114-2' }), '補登上學期最後一天');
    await mustSetDoc(ARCH('114-2'), { semesterId: '114-2', archivedAt: iso(), archivedBy: { teacherId: dir.teacherId }, counts: {}, jsonHash: 'x', note: '' });
    denied(await chiefRec({ date: '2026-07-31', semesterId: '114-2' }), '已封存學期不可再補寫');
    denied(await chiefRec({ date: '2026-02-01', semesterId: '114-2' }), '已封存學期（另一天）仍拒');
});
await suite.case('A-6 ATTACK 相隔兩個學期以上（116-1／114-1）即使日期一致 → DENY', async () => {
    denied(await chiefRec({ date: '2027-08-01', semesterId: '116-1' }), '往後兩學期');
    denied(await chiefRec({ date: '2026-01-31', semesterId: '114-1' }), '往前兩學期');
    denied(await chiefRec({ date: '2028-03-01', semesterId: '116-2' }), '往後更遠');
});
await suite.case('A-7 ATTACK 日期格式或月日不合法、缺 date、semesterId 格式不合法 → DENY', async () => {
    denied(await chiefRec({ date: '2027-13-01', semesterId: '115-2' }), '13 月');
    denied(await chiefRec({ date: '2027-02-99', semesterId: '115-2' }), '99 日');
    denied(await chiefRec({ date: '2027/02/01', semesterId: '115-2' }), '斜線格式');
    denied(await chiefRec({ date: '2027-2-1', semesterId: '115-2' }), '未補零');
    denied(await createDoc(P.records, rid('rec'), { ...base, semesterId: '115-2' }, as(chief)), '缺 date');
    denied(await chiefRec({ date: '2027-02-01', semesterId: '115-3' }), '學期 3');
    denied(await chiefRec({ date: '2027-02-01', semesterId: 'x115-2' }), '亂格式');
});
await suite.case('A-8 一般教師（非 approver、非自我調課）建立相鄰學期紀錄 → DENY', async () => {
    denied(await createDoc(P.records, rid('rec'), { ...base, date: '2027-02-01', semesterId: '115-2' }, as(t1)), '教師直寫');
});

await suite.case('A-11 ATTACK「等於目前學期」但日期不屬於目前學期（已結算月份、很久以前、缺 date、下學期日期）→ DENY；日期屬目前學期 → ALLOW', async () => {
    denied(await chiefRec({ date: '2025-03-01', semesterId: '115-1' }), '很久以前的日期標目前學期');
    denied(await chiefRec({ date: '2026-07-31', semesterId: '115-1' }), '上學期日期標目前學期');
    denied(await chiefRec({ date: '2027-02-01', semesterId: '115-1' }), '下學期日期標目前學期');
    denied(await createDoc(P.records, rid('rec'), { ...base, semesterId: '115-1' }, as(chief)), '缺 date 標目前學期');
    denied(await chiefRec({ date: '2026-13-01', semesterId: '115-1' }), '非法日期標目前學期');
    allowed(await chiefRec({ date: '2026-08-01', semesterId: '115-1' }), '學期第一天');
    denied(await createDoc(P.records, rid('rec'), selfSwapDoc(t1, { date: '2025-03-01', swapDate: '2025-03-02', semesterId: '115-1' }), as(t1)), '自我調課：很久以前日期標目前學期');
    allowed(await createDoc(P.records, rid('rec'), selfSwapDoc(t1, { date: '2026-11-17', swapDate: '2026-11-19', semesterId: '115-1' }), as(t1)), '自我調課：目前學期內');
});

/* ===================== A'. create：教師自我調課／pendingRequests ===================== */

await suite.case('A-9 教師自我調課：預登下學期（115-2 / 2027-02-01）→ ALLOW；date 與學期對不上 → DENY；跨兩學期 → DENY', async () => {
    allowed(await createDoc(P.records, rid('rec'), selfSwapDoc(t1, { date: '2027-02-01', swapDate: '2027-02-02', semesterId: '115-2' }), as(t1)), '自我調課預登');
    denied(await createDoc(P.records, rid('rec'), selfSwapDoc(t1, { date: '2026-11-17', swapDate: '2026-11-19', semesterId: '115-2' }), as(t1)), '對不上');
    denied(await createDoc(P.records, rid('rec'), selfSwapDoc(t1, { date: '2027-08-01', swapDate: '2027-08-02', semesterId: '116-1' }), as(t1)), '兩學期後');
});
await suite.case('A-10 pendingRequests：預登下學期（115-2）→ ALLOW；目前學期最後一天 → ALLOW；對不上／太遠／非法日期 → DENY', async () => {
    allowed(await createDoc(P.pending, rid('req'), pendingDocFor(t1, { date: '2027-02-01', semesterId: '115-2' }), as(t1)), '申請預登下學期');
    allowed(await createDoc(P.pending, rid('req'), pendingDocFor(t1, { date: '2027-01-31', semesterId: '115-1' }), as(t1)), '申請 目前學期最後一天');
    denied(await createDoc(P.pending, rid('req'), pendingDocFor(t1, { date: '2027-01-31', semesterId: '115-2' }), as(t1)), '申請 對不上');
    denied(await createDoc(P.pending, rid('req'), pendingDocFor(t1, { date: '2027-08-01', semesterId: '116-1' }), as(t1)), '申請 兩學期後');
    denied(await createDoc(P.pending, rid('req'), pendingDocFor(t1, { date: '2027-02-99', semesterId: '115-2' }), as(t1)), '申請 非法日期');
});

await suite.case('A-12 ATTACK 組長／主任建立 pendingRequests（approver 分支已移除，含偽造 initiatedBy）→ DENY；發起人本人 → ALLOW', async () => {
    const forged = pendingDocFor(t1, { date: '2026-11-17', semesterId: '115-1' });   // initiatedBy 是 t1，由組長送出
    denied(await createDoc(P.pending, rid('req'), forged, as(chief)), '組長代 t1 建申請（目前學期）');
    denied(await createDoc(P.pending, rid('req'), pendingDocFor(t1, { date: '2027-02-01', semesterId: '115-2' }), as(chief)), '組長代 t1 建申請（相鄰學期）');
    denied(await createDoc(P.pending, rid('req'), forged, as(dir)), '主任代 t1 建申請');
    allowed(await createDoc(P.pending, rid('req'), forged, as(t1)), 't1 本人建申請');
});

/* ===================== B. update／delete ===================== */

const ownerRec = (id, over) => mustSetDoc(`${P.records}/${id}`, { ...base, ...over });
await suite.case('B-1 組長更新／刪除「下一學期」預登紀錄 → ALLOW（尚未結算，需能更正）', async () => {
    await ownerRec('b_fut_upd', { date: '2027-02-01', semesterId: '115-2' });
    await ownerRec('b_fut_del', { date: '2027-02-01', semesterId: '115-2' });
    allowed(await updateDoc(`${P.records}/b_fut_upd`, { docNumber: 'A1', updatedAt: iso() }, as(chief)), '更新預登紀錄');
    allowed(await deleteDoc(`${P.records}/b_fut_del`, as(chief)), '刪除預登紀錄');
});
await suite.case('B-2 ATTACK 組長更新／刪除「已過去學期」紀錄 → DENY；主任刪除 → ALLOW（封存清理，不變）', async () => {
    await ownerRec('b_past_upd', { date: '2026-07-31', semesterId: '114-2' });
    await ownerRec('b_past_del', { date: '2026-07-31', semesterId: '114-2' });
    denied(await updateDoc(`${P.records}/b_past_upd`, { docNumber: 'A1', updatedAt: iso() }, as(chief)), '改過去學期');
    denied(await deleteDoc(`${P.records}/b_past_del`, as(chief)), '刪過去學期');
    allowed(await deleteDoc(`${P.records}/b_past_del`, as(dir)), '主任刪過去學期');
});
await suite.case('B-3 組長更新目前學期紀錄 → ALLOW（原行為）；semesterId 不可變 → DENY', async () => {
    await ownerRec('b_cur_upd', { date: '2026-11-17', semesterId: '115-1' });
    allowed(await updateDoc(`${P.records}/b_cur_upd`, { docNumber: 'B2', updatedAt: iso() }, as(chief)), '改目前學期');
    denied(await updateDoc(`${P.records}/b_cur_upd`, { semesterId: '115-2' }, as(chief)), '搬學期');
});

await suite.case('B-4 update 改 date：新日期仍屬同一學期 → ALLOW；改到別的學期／非法格式／刪掉 date → DENY', async () => {
    await ownerRec('b_date', { date: '2026-11-17', semesterId: '115-1' });
    allowed(await updateDoc(`${P.records}/b_date`, { date: '2026-12-01', updatedAt: iso() }, as(chief)), '同學期改日期');
    denied(await updateDoc(`${P.records}/b_date`, { date: '2027-02-01', updatedAt: iso() }, as(chief)), '搬到下學期');
    denied(await updateDoc(`${P.records}/b_date`, { date: '2025-03-01', updatedAt: iso() }, as(chief)), '搬到很久以前');
    denied(await updateDoc(`${P.records}/b_date`, { date: '2026-12-99', updatedAt: iso() }, as(chief)), '非法日期');
});
await suite.case('B-5 ATTACK 目前學期 +2 的紀錄（資料異常）：組長更新／刪除 → DENY（上限只到目前學期+1）', async () => {
    await ownerRec('b_far_upd', { date: '2027-08-01', semesterId: '116-1' });
    await ownerRec('b_far_del', { date: '2027-08-01', semesterId: '116-1' });
    denied(await updateDoc(`${P.records}/b_far_upd`, { docNumber: 'X', updatedAt: iso() }, as(chief)), '改 +2 學期');
    denied(await deleteDoc(`${P.records}/b_far_del`, as(chief)), '刪 +2 學期');
    allowed(await deleteDoc(`${P.records}/b_far_del`, as(dir)), '主任仍可刪');
});

/* ===================== C. private/detail 父文件學期鎖 ===================== */

const detail = { leaveType: '事假', reason: 'x', allowedTeacherIds: [t1.teacherId] };
await suite.case('C-1 紀錄 private/detail：父文件為下學期 → create／update／delete ALLOW；父文件為過去學期 → DENY', async () => {
    await ownerRec('c_fut', { date: '2027-02-01', semesterId: '115-2' });
    await ownerRec('c_past', { date: '2026-07-31', semesterId: '114-2' });
    allowed(await createDoc(`${P.records}/c_fut/private`, 'detail', detail, as(chief)), '下學期 create');
    allowed(await updateDoc(`${P.records}/c_fut/private/detail`, { ...detail, reason: 'y' }, as(chief)), '下學期 update');
    denied(await createDoc(`${P.records}/c_past/private`, 'detail', detail, as(chief)), '過去 create');
    await mustSetDoc(`${P.records}/c_past/private/detail`, detail);
    denied(await updateDoc(`${P.records}/c_past/private/detail`, { ...detail, reason: 'z' }, as(chief)), '過去 update');
    denied(await deleteDoc(`${P.records}/c_past/private/detail`, as(chief)), '過去 delete');
    allowed(await deleteDoc(`${P.records}/c_fut/private/detail`, as(chief)), '下學期 delete');
});
await suite.case('C-2 申請 private/detail：父文件為下學期 → create ALLOW；父文件為過去學期 → DENY', async () => {
    const mk = (id, over) => mustSetDoc(`${P.pending}/${id}`, { ...pendingDocFor(t1, over), createdAt: iso() });
    await mk('c_req_fut', { date: '2027-02-01', semesterId: '115-2' });
    await mk('c_req_past', { date: '2026-07-31', semesterId: '114-2' });
    allowed(await createDoc(`${P.pending}/c_req_fut/private`, 'detail', detail, as(chief)), '下學期申請明細');
    denied(await createDoc(`${P.pending}/c_req_past/private`, 'detail', detail, as(chief)), '過去學期申請明細');
});

/* ===================== D. 換學期後 ===================== */

await suite.case('D-1 目前學期改為 115-2 後：補登上學期 115-1 → ALLOW；預登 116-1 → ALLOW；回溯兩學期／往後兩學期／對不上 → DENY；組長刪上學期 DENY、刪預登 ALLOW', async () => {
    await mergeDoc(P.config, { currentSemester: '115-2' });
    allowed(await chiefRec({ date: '2027-01-31', semesterId: '115-1' }), '補登上學期');
    allowed(await chiefRec({ date: '2027-08-01', semesterId: '116-1' }), '預登下學年');
    allowed(await chiefRec({ date: '2027-03-01', semesterId: '115-2' }), '目前學期');
    denied(await chiefRec({ date: '2026-07-31', semesterId: '114-2' }), '回溯兩學期');
    denied(await chiefRec({ date: '2028-02-01', semesterId: '116-2' }), '往後兩學期');
    denied(await chiefRec({ date: '2027-03-01', semesterId: '115-1' }), '日期對不上');
    await ownerRec('d_past', { date: '2027-01-31', semesterId: '115-1' });
    await ownerRec('d_fut', { date: '2027-08-01', semesterId: '116-1' });
    denied(await deleteDoc(`${P.records}/d_past`, as(chief)), '組長刪上學期');
    allowed(await deleteDoc(`${P.records}/d_fut`, as(chief)), '組長刪預登');
});
await suite.case('D-2 目前學期值不是標準格式（fail-closed）：相鄰與未來一律不成立，僅「等於目前學期」原行為', async () => {
    await mergeDoc(P.config, { currentSemester: 'demo' });
    denied(await chiefRec({ date: '2027-02-01', semesterId: '115-2' }), '非標準 current 不開相鄰');
    allowed(await chiefRec({ date: '2027-02-01', semesterId: 'demo' }), '等於目前學期仍可');
    await ownerRec('d_nonstd', { date: '2027-08-01', semesterId: '116-1' });
    denied(await deleteDoc(`${P.records}/d_nonstd`, as(chief)), '非標準 current 不開未來刪除');
    await mergeDoc(P.config, { currentSemester: CUR });
});

suite.print();
process.exit(suite.failed ? 1 : 0);
