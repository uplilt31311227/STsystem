#!/usr/bin/env node
/**
 * firestore.rules v2.12：欄位白名單完整性實證——以「前端實際寫入形狀」走完所有審核流程
 *
 * 目的：欄位白名單（hasOnly）寧可完整不可漏。這支測試把前端（app.js／v2-app.js／
 * pendingRequestService／schoolDataService）送出的 payload 形狀原樣組出（見 kit.mjs 的逐函式對照），
 * 在 emulator 上對真實規則跑完：代課單簽、調課雙簽、多重調課、撤回、駁回、組長代發、教師自我調課、
 * 多節代課、批次調課。全部必須 ALLOW；任何一步被拒就代表白名單漏了正常欄位。
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-workflows.mjs（會清空並重建 emulator 資料）
 */
import { createDoc, updateDoc, deleteDoc, getDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq, ok } from '../scenarios/harness.mjs';
import {
    setup, P, as, iso, logEntry, appSubstituteRecord, appSwapRecord, resolveApproverInfo, writeV2Payload,
    buildPendingRequestDocs, submitPending, submitRecord, nameToIdMap, buildAffectedList, splitSensitive,
} from './kit.mjs';

const W = await setup();
const { semesterId, fixture, dir, chief, t1, t2, t3, t4 } = W;
const nameToId = nameToIdMap(fixture);
const suite = new Suite('firestore.rules v2.12：前端形狀審核流程全數 ALLOW（白名單完整性）');

/** pendingRequestService.approveRequest 的寫入序列（組長）。 */
async function approve(approver, reqId) {
    const snap = (await getDoc(`${P.pending}/${reqId}`)).data;
    const detail = (await getDoc(`${P.pending}/${reqId}/private/detail`));
    const recordId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    if (detail.ok) {
        const { allowedTeacherIds, ...sensitive } = detail.data;
        allowed(await createDoc(`${P.records}/${recordId}/private`, 'detail', { ...sensitive, allowedTeacherIds }, as(approver)), `核准：複製 private/detail（${reqId}）`);
    }
    const now = iso();
    const record = { ...snap };
    delete record.pendingConsentTeacherIds; delete record.swapConsents;
    record.status = 'approved'; record.approvedAt = now; record.approvedBy = approver.teacherId; record.approvedByName = approver.name;
    record.fromRequestId = reqId; record.createdAt = record.createdAt || now;
    record.affectedTeacherIds = buildAffectedList({ reqId, ...snap });
    record.semesterId = semesterId;
    allowed(await createDoc(P.records, recordId, record, as(approver)), `核准：建立紀錄（${reqId}）`);
    allowed(await updateDoc(`${P.pending}/${reqId}`, {
        status: 'approved', approvedAt: now, approvedBy: approver.teacherId, approvedByName: approver.name, statusUpdatedAt: now,
    }, as(approver)), `核准：申請轉 approved（${reqId}）`);
    return recordId;
}

/** consentRequest 的 tx.update patch。 */
async function consent(user, reqId) {
    const cur = (await getDoc(`${P.pending}/${reqId}`)).data;
    const now = iso();
    const nextPending = cur.pendingConsentTeacherIds.filter(x => x !== user.teacherId);
    const patch = {
        pendingConsentTeacherIds: nextPending,
        swapConsents: { ...(cur.swapConsents || {}), [user.teacherId]: { consentedAt: now } },
        status: nextPending.length === 0 ? 'pending_approval' : 'pending_swap_consent',
        statusUpdatedAt: now,
    };
    return updateDoc(`${P.pending}/${reqId}`, patch, as(user));
}

/** rejectRequest 的 tx.update patch。 */
function reject(user, reqId, note = '時間無法配合') {
    const now = iso();
    return updateDoc(`${P.pending}/${reqId}`, {
        status: 'rejected', rejectedAt: now, rejectedBy: user.teacherId, rejectedByName: user.name, rejectNote: note, statusUpdatedAt: now,
    }, as(user));
}

const idsFor = (rec, extra = []) => resolveApproverInfo(rec, nameToId, extra);

await suite.case('F1 代課單簽：教師送申請 → 日誌 → 組長核准 → 紀錄成立 → 日誌', async () => {
    const rec = appSubstituteRecord({ original: t1.name, substitute: t2.name });
    const payload = writeV2Payload(rec, idsFor(rec), t1);
    const built = buildPendingRequestDocs(payload, semesterId, t1);
    const r = await submitPending(t1, built);
    allowed(r.priv, '寫 private/detail'); allowed(r.parent, '寫申請父文件');
    allowed(await createDoc(P.logs, 'zz_log_f1a', logEntry(t1, semesterId, 'create_request', 'pendingRequest', built.reqId, { affectedTeacherIds: [t1.teacherId] }), as(t1)), '日誌（發起）');
    const recordId = await approve(chief, built.reqId);
    allowed(await createDoc(P.logs, 'zz_log_f1b', logEntry(chief, semesterId, 'approve', 'substituteRecord', recordId, { fromRequestId: built.reqId }), as(chief)), '日誌（核准）');
    eq((await getDoc(`${P.pending}/${built.reqId}`)).data.status, 'approved', '申請已核准');
    ok((await getDoc(`${P.records}/${recordId}`)).ok, '紀錄成立');
});

await suite.case('F2 調課雙簽：發起 → 對方同意 → 組長核准', async () => {
    const rec = appSwapRecord({ teacherA: t1.name, teacherB: t2.name });
    const built = buildPendingRequestDocs(writeV2Payload(rec, idsFor(rec), t1), semesterId, t1);
    eq(built.publicDoc.requestType, 'swap', 'requestType');
    const r = await submitPending(t1, built);
    allowed(r.priv, 'private'); allowed(r.parent, '父文件');
    allowed(await consent(t2, built.reqId), '對方同意');
    eq((await getDoc(`${P.pending}/${built.reqId}`)).data.status, 'pending_approval', '轉待核准');
    await approve(chief, built.reqId);
});

await suite.case('F3 多重調課：全員同意（逐一移出名單）→ 核准', async () => {
    const rec = appSwapRecord({ teacherA: t1.name, teacherB: t2.name });
    const ids = idsFor(rec, [t3.name, t4.name]);
    eq(ids.requestType, 'multi_swap', '升級為多重調課');
    const built = buildPendingRequestDocs(writeV2Payload(rec, ids, t1), semesterId, t1);
    const r = await submitPending(t1, built);
    allowed(r.priv, 'private'); allowed(r.parent, '父文件');
    allowed(await consent(t3, built.reqId), '第一位同意');
    eq((await getDoc(`${P.pending}/${built.reqId}`)).data.status, 'pending_swap_consent', '名單未清空，狀態不變');
    allowed(await consent(t2, built.reqId), '第二位同意');
    allowed(await consent(t4, built.reqId), '最後一位同意');
    eq((await getDoc(`${P.pending}/${built.reqId}`)).data.status, 'pending_approval', '全員同意後轉待核准');
    await approve(chief, built.reqId);
});

await suite.case('F4 撤回（發起人刪除在途申請）與同意階段駁回、發起人關閉駁回通知', async () => {
    const rec = appSwapRecord({ teacherA: t1.name, teacherB: t2.name });
    const b1 = buildPendingRequestDocs(writeV2Payload(rec, idsFor(rec), t1), semesterId, t1);
    allowed((await submitPending(t1, b1)).parent, '建立（撤回用）');
    allowed(await deleteDoc(`${P.pending}/${b1.reqId}`, as(t1)), '發起人撤回');

    const b2 = buildPendingRequestDocs(writeV2Payload(rec, idsFor(rec), t1), semesterId, t1);
    allowed((await submitPending(t1, b2)).parent, '建立（駁回用）');
    allowed(await reject(t2, b2.reqId), '被邀請人在同意階段拒絕');
    eq((await getDoc(`${P.pending}/${b2.reqId}`)).data.status, 'rejected', '已駁回');
    allowed(await deleteDoc(`${P.pending}/${b2.reqId}`, as(t1)), '發起人關閉駁回通知（rejected 可刪）');

    const rec3 = appSubstituteRecord({ original: t1.name, substitute: t3.name });
    const b3 = buildPendingRequestDocs(writeV2Payload(rec3, idsFor(rec3), t1), semesterId, t1);
    allowed((await submitPending(t1, b3)).parent, '建立（核准階段駁回用）');
    allowed(await reject(dir, b3.reqId, '本日已無空堂'), '主任在核准階段駁回');
});

await suite.case('F5 組長（approver）本身是待同意人時以同意人身分同意', async () => {
    const rec = appSwapRecord({ teacherA: t1.name, teacherB: chief.name });
    const built = buildPendingRequestDocs(writeV2Payload(rec, idsFor(rec), t1), semesterId, t1);
    const r = await submitPending(t1, built);
    allowed(r.parent, '建立');
    allowed(await consent(chief, built.reqId), '組長以同意人身分同意');
    await approve(dir, built.reqId);
});

await suite.case('F6 組長代發（adminCreate）：直接成立紀錄，含 private/detail', async () => {
    const rec = appSubstituteRecord({ original: t1.name, substitute: t2.name });
    const ids = idsFor(rec);
    const payload = writeV2Payload(rec, ids, chief, { admin: true });
    const now = iso();
    const record = { ...payload, status: 'approved', initiatedBy: payload.initiatedBy, initiatedByName: payload.initiatedByName,
        initiatedByRole: 'admin', adminOperatorId: chief.teacherId, adminOperatorName: chief.name, createdAt: now, approvedAt: now };
    const r = await submitRecord(chief, record, semesterId);
    allowed(r.priv, 'private/detail'); allowed(r.parent, '紀錄');
});

await suite.case('F7 組長代發起申請（createRequest 走 pending，initiatedBy 為他人）', async () => {
    const rec = appSwapRecord({ teacherA: t1.name, teacherB: t2.name });
    const built = buildPendingRequestDocs(writeV2Payload(rec, idsFor(rec), chief, { admin: true, adminOnBehalfOf: t1.teacherId }), semesterId, chief);
    const r = await submitPending(chief, built);
    allowed(r.priv, 'private'); allowed(r.parent, '父文件');
});

await suite.case('F8 教師自我調課：直接成立（private 先於父文件，三個 id 皆為本人）', async () => {
    const rec = appSwapRecord({ teacherA: t1.name, teacherB: t1.name, self: true });
    const ids = idsFor(rec);
    eq(ids.requiredApproverId, null, '自我調課無核准對象');
    const payload = writeV2Payload(rec, ids, t1);
    const r = await submitRecord(t1, payload, semesterId, { status: 'approved', initiatedByRole: 'teacher' });
    allowed(r.priv, 'private/detail'); allowed(r.parent, '自我調課紀錄');
    allowed(await createDoc(P.logs, 'zz_log_f8', logEntry(t1, semesterId, 'approve', 'substituteRecord', r.recordId, { selfApproved: true, initiatedBy: t1.teacherId }), as(t1)), '日誌');
});

await suite.case('F9 多節代課：同一天三節各自一筆申請（含 multiCourse* 欄位）', async () => {
    const baseId = String(Date.now());
    for (let i = 0; i < 3; i++) {
        const rec = { ...appSubstituteRecord({ original: t1.name, substitute: t2.name, period: ['第一節', '第二節', '第三節'][i] }),
            id: `${baseId}_${i}`, isMultiCourse: true, multiCourseGroupId: baseId, multiCourseIndex: i, multiCourseTotal: 3 };
        const built = buildPendingRequestDocs(writeV2Payload(rec, idsFor(rec), t1), semesterId, t1);
        const r = await submitPending(t1, built);
        allowed(r.priv, `第 ${i + 1} 節 private`); allowed(r.parent, `第 ${i + 1} 節父文件`);
    }
});

await suite.case('F10 批次調課（submitSwapBatch）：三筆各自一筆申請，帶 batchId／batchSize，並可全數核准', async () => {
    const batch = { id: String(Date.now()), size: 3 };
    const reqIds = [];
    for (let i = 0; i < 3; i++) {
        const rec = appSwapRecord({ teacherA: t1.name, teacherB: t2.name, idSuffix: `_${i}`, batch, className: `7年${i + 1}班` });
        const built = buildPendingRequestDocs(writeV2Payload(rec, idsFor(rec), t1), semesterId, t1);
        const r = await submitPending(t1, built);
        allowed(r.priv, `第 ${i + 1} 筆 private`); allowed(r.parent, `第 ${i + 1} 筆父文件`);
        allowed(await consent(t2, built.reqId), `第 ${i + 1} 筆對方同意`);
        reqIds.push(built.reqId);
    }
    for (const id of reqIds) await approve(chief, id);
});

await suite.case('F11 批次自我調課（submitSwapBatch，自調）：多筆自我調課紀錄帶 batchId／batchSize', async () => {
    const batch = { id: String(Date.now()), size: 2 };
    for (let i = 0; i < 2; i++) {
        const rec = appSwapRecord({ teacherA: t1.name, teacherB: t1.name, self: true, idSuffix: `_${i}`, batch });
        const r = await submitRecord(t1, writeV2Payload(rec, idsFor(rec), t1), semesterId, { initiatedByRole: 'teacher' });
        allowed(r.priv, 'private'); allowed(r.parent, '自我調課紀錄');
    }
});

await suite.case('F12 常見日誌動作（各種 action／targetType／null targetId）寫入皆 ALLOW', async () => {
    const cases = [
        ['create_request', 'pendingRequest', 'req_1_abc'], ['swap_consent', 'pendingRequest', 'req_1_abc'],
        ['approve', 'substituteRecord', 'rec_1_abc'], ['reject', 'pendingRequest', 'req_1_abc'], ['cancel', 'pendingRequest', 'req_1_abc'],
        ['permission_denied', 'substituteRecord', null], ['semester_switch', 'system', null], ['schedule_import', 'schedule', null],
        ['approve_blocked_conflict', 'pendingRequest', 'req_1_abc'], ['clear_all_data', 'system', null],
    ];
    let i = 0;
    for (const [action, tt, tid] of cases) {
        allowed(await createDoc(P.logs, `zz_log_f12_${i++}`, logEntry(chief, semesterId, action, tt, tid, { a: 1, b: { nested: 'ok' } }), as(chief)), `${action}/${tt}`);
    }
});

await suite.case('F13 歷史資料遷移（legacyMigrationService）：director 以 isLegacy＋migratedFrom＋舊學期 semesterId 建立 → ALLOW；組長同樣寫入 → DENY', async () => {
    const legacy = {
        ...appSubstituteRecord({ original: t1.name, substitute: t2.name, date: '2025-10-05' }),
        originalTeacherId: t1.teacherId, substituteTeacherId: t2.teacherId, status: 'approved', isLegacy: true,
        semesterId: '114-1', migratedFrom: { source: 'firestore', uid: dir.localId, legacyKey: 'k1', migratedAt: iso() },
    };
    const r = await submitRecord(dir, legacy, '114-1');
    allowed(r.priv, 'private/detail'); allowed(r.parent, '主任遷移歷史紀錄');
    const r2 = await submitRecord(chief, { ...legacy, id: 'other' }, '114-1');
    denied(r2.parent, '組長不可用 isLegacy 繞過學期鎖');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
