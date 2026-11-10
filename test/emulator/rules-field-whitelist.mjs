#!/usr/bin/env node
/**
 * firestore.rules v2.12：欄位白名單、稽核日誌、private/detail 歸屬與大小限制
 *   項目 4（M2）  private/detail 只能由申請人本人或 approver 建立，docId 鎖 'detail'
 *   項目 5（M3）  稽核日誌 actor 必須是登入者本人、timestamp 不得為未來、欄位白名單與長度上限
 *   項目 6（M6）  pendingRequests／自我調課紀錄的欄位白名單、保留欄位、長度、未來時間、affectedTeacherIds
 *   項目 8（M5）  成員層級寫入的大小上限
 *   附帶 L6      approver 更新紀錄時稽核欄位不可改
 *
 * 每組都有「攻擊 → DENY」與「前端正常形狀 → ALLOW」成對案例；正常形狀由 kit.mjs 逐函式對照前端組出。
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-field-whitelist.mjs（會清空並重建 emulator 資料）
 */
import { createDoc, updateDoc, getDoc, mustSetDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';
import {
    setup, P, as, iso, DAY, logEntry, appSubstituteRecord, appSwapRecord, resolveApproverInfo, writeV2Payload,
    buildPendingRequestDocs, submitPending, submitRecord, nameToIdMap,
} from './kit.mjs';

const W = await setup();
const { semesterId, fixture, dir, chief, t1, t2, t3, t4 } = W;
const nameToId = nameToIdMap(fixture);
const suite = new Suite('firestore.rules v2.12：欄位白名單／稽核日誌／private 歸屬／大小限制');
const rid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

/* ---------- 共用：產生一份前端形狀的申請父文件（可改寫欄位後直接 create） ---------- */
function pendingDoc(me = t1, { type = 'sub' } = {}) {
    const rec = type === 'sub'
        ? appSubstituteRecord({ original: me.name, substitute: t2.name })
        : appSwapRecord({ teacherA: me.name, teacherB: t2.name });
    const built = buildPendingRequestDocs(writeV2Payload(rec, resolveApproverInfo(rec, nameToId), me), semesterId, me);
    return { reqId: built.reqId, doc: built.publicDoc, priv: built.privateDoc };
}
function selfSwapDoc(me = t1) {
    const rec = appSwapRecord({ teacherA: me.name, teacherB: me.name, self: true });
    const payload = writeV2Payload(rec, resolveApproverInfo(rec, nameToId), me);
    const now = iso();
    const base = { ...payload, status: 'approved', initiatedByRole: 'teacher', semesterId, createdAt: now, approvedAt: now };
    const { publicPart, privatePart } = (() => {
        const pub = { ...base }; const priv = {};
        for (const f of ['leaveType', 'leaveTypeName', 'reason']) { priv[f] = pub[f]; delete pub[f]; }
        priv.allowedTeacherIds = [me.teacherId];
        return { publicPart: pub, privatePart: priv };
    })();
    return { doc: publicPart, priv: privatePart };
}
const tryPending = (user, mutate, { me = t1, type = 'sub' } = {}) => {
    const p = pendingDoc(me, { type });
    const d = mutate({ ...p.doc }) ;
    return createDoc(P.pending, rid('req'), d, as(user));
};
const trySelfSwap = (user, mutate, me = t1) => {
    const p = selfSwapDoc(me);
    return createDoc(P.records, rid('rec'), mutate({ ...p.doc }), as(user));
};

/* ===================== 項目 6：pendingRequests create ===================== */

await suite.case('6-a 申請：前端正常形狀（代課／調課）→ ALLOW（對照組）', async () => {
    allowed(await tryPending(t1, d => d), '代課');
    allowed(await tryPending(t1, d => d, { type: 'swap' }), '調課');
});
await suite.case('6-b 申請：多餘欄位 → DENY', async () => {
    denied(await tryPending(t1, d => ({ ...d, evil: 'x' })), '多餘欄位 evil');
    denied(await tryPending(t1, d => ({ ...d, isLegacy: true })), '多餘欄位 isLegacy');
    denied(await tryPending(t1, d => ({ ...d, fromRequestId: 'x' })), '多餘欄位 fromRequestId');
});
await suite.case('6-c 申請：保留欄位 reqId／recordId（覆蓋 doc id 的 XSS／ID 混淆 source）→ DENY；id 帶 HTML 字元 → DENY', async () => {
    denied(await tryPending(t1, d => ({ ...d, reqId: 'req_victim_real' })), 'reqId');
    denied(await tryPending(t1, d => ({ ...d, reqId: 'x"><img src=x onerror=alert(1)><b x="' })), 'reqId 屬性注入');
    denied(await tryPending(t1, d => ({ ...d, recordId: 'rec_victim' })), 'recordId');
    denied(await tryPending(t1, d => ({ ...d, id: 'x"><img src=x onerror=alert(1)>' })), 'id 帶 HTML');
});
await suite.case('6-d 申請：超長字串／HTML 字元 → DENY', async () => {
    denied(await tryPending(t1, d => ({ ...d, className: 'x'.repeat(2000) })), 'className 2000 字元');
    denied(await tryPending(t1, d => ({ ...d, subject: '<img src=x onerror=alert(1)>' })), 'subject 含 <');
    denied(await tryPending(t1, d => ({ ...d, className: '7年1班" onfocus="alert(1)' })), 'className 含 "');
    denied(await tryPending(t1, d => ({ ...d, className: { a: 1 } })), 'className 為 map（型別錯誤）');
});
await suite.case('6-e 申請：未來時間戳 → DENY；容忍範圍內的時鐘誤差 → ALLOW', async () => {
    denied(await tryPending(t1, d => ({ ...d, createdAt: '9999-12-31T23:59:59.999Z' })), 'createdAt 9999 年');
    denied(await tryPending(t1, d => ({ ...d, createdAt: iso(3 * DAY) })), 'createdAt +3 天');
    denied(await tryPending(t1, d => ({ ...d, createdAt: 'not-a-date' })), 'createdAt 非 ISO 格式');
    denied(await tryPending(t1, d => ({ ...d, createdAt: { seconds: 1 } })), 'createdAt 為 map');
    allowed(await tryPending(t1, d => ({ ...d, createdAt: iso(3600 * 1000) })), 'createdAt +1 小時（時鐘誤差）');
    allowed(await tryPending(t1, d => ({ ...d, createdAt: iso(-30 * DAY) })), 'createdAt 過去時間');
});
await suite.case('6-f 申請：affectedTeacherIds 含無關教師 → DENY；子集 → ALLOW；過長 → DENY', async () => {
    denied(await tryPending(t1, d => ({ ...d, affectedTeacherIds: [t1.teacherId, t4.teacherId] })), '含無關教師 t4');
    denied(await tryPending(t1, d => ({ ...d, affectedTeacherIds: ['tch_demo-alpha_01'] })), '含主任（無關）');
    allowed(await tryPending(t1, d => ({ ...d, affectedTeacherIds: [t1.teacherId, t2.teacherId] })), '發起人＋代課教師（涉及者子集）');
    const many = Array.from({ length: 21 }, (_, i) => `tch_x_${i}`);
    denied(await tryPending(t1, d => ({ ...d, affectedTeacherIds: many, pendingConsentTeacherIds: many }), { type: 'swap' }), '名單超過 20 人');
});
await suite.case('6-g 申請：requestType 與 type 不一致、狀態機欄位違規、帶核准欄位 → DENY', async () => {
    denied(await tryPending(t1, d => ({ ...d, type: '調課' })), 'substitute 卻 type=調課');
    denied(await tryPending(t1, d => ({ ...d, type: '代課' }), { type: 'swap' }), 'swap 卻 type=代課');
    denied(await tryPending(t1, d => ({ ...d, approvedBy: chief.teacherId, status: 'approved' })), '自帶 approvedBy');
    denied(await tryPending(t1, d => ({ ...d, swapConsents: { [t2.teacherId]: { consentedAt: iso() } } }), { type: 'swap' }), '預填 swapConsents');
    denied(await tryPending(t1, d => ({ ...d, initiatedBy: t2.teacherId })), '冒名發起');
});
await suite.case('6-h approver（組長）代發申請：前端形狀 → ALLOW；帶保留欄位 reqId → DENY', async () => {
    const p = pendingDoc(chief, { type: 'swap' });
    allowed(await createDoc(P.pending, rid('req'), { ...p.doc, initiatedBy: t1.teacherId, initiatedByName: t1.name }, as(chief)), '組長代發');
    denied(await createDoc(P.pending, rid('req'), { ...p.doc, reqId: 'x' }, as(chief)), '組長帶 reqId');
});

/* ===================== 項目 6：自我調課紀錄 ===================== */

await suite.case('6-i 自我調課：前端正常形狀 → ALLOW（對照組）', async () => {
    allowed(await trySelfSwap(t1, d => d), '自我調課');
});
await suite.case('6-j 自我調課：夾帶稽核性／保留／多餘欄位 → DENY', async () => {
    denied(await trySelfSwap(t1, d => ({ ...d, approvedBy: dir.teacherId })), 'approvedBy');
    denied(await trySelfSwap(t1, d => ({ ...d, approvedByName: '教務主任' })), 'approvedByName');
    denied(await trySelfSwap(t1, d => ({ ...d, isLegacy: true, migratedFrom: { source: 'x' } })), 'isLegacy／migratedFrom');
    denied(await trySelfSwap(t1, d => ({ ...d, fromRequestId: 'req_x' })), 'fromRequestId');
    denied(await trySelfSwap(t1, d => ({ ...d, recordId: 'rec_victim' })), 'recordId');
    denied(await trySelfSwap(t1, d => ({ ...d, reqId: 'req_victim' })), 'reqId');
    denied(await trySelfSwap(t1, d => ({ ...d, evil: 'x' })), '多餘欄位');
    denied(await trySelfSwap(t1, d => ({ ...d, status: 'rejected' })), 'status 非 approved');
});
await suite.case('6-k 自我調課：HTML 字元／超長字串／未來時間／姓名冒用／affectedTeacherIds → DENY', async () => {
    denied(await trySelfSwap(t1, d => ({ ...d, className: '<img src=x onerror=alert(1)>' })), 'className 含 HTML');
    denied(await trySelfSwap(t1, d => ({ ...d, className: 'x'.repeat(2000) })), 'className 超長');
    denied(await trySelfSwap(t1, d => ({ ...d, createdAt: '9999-12-31T00:00:00.000Z' })), 'createdAt 9999');
    denied(await trySelfSwap(t1, d => ({ ...d, originalTeacher: t4.name })), 'originalTeacher 冒用他人姓名');
    denied(await trySelfSwap(t1, d => ({ ...d, affectedTeacherIds: [t4.teacherId] })), 'affectedTeacherIds 含無關教師');
    denied(await trySelfSwap(t1, d => ({ ...d, affectedTeacherIds: [t1.teacherId, ...fixture.teachers.slice(0, 18).map(t => t.teacherId)] })), 'affectedTeacherIds 塞全校');
    allowed(await trySelfSwap(t1, d => ({ ...d, affectedTeacherIds: [t1.teacherId] })), 'affectedTeacherIds 僅本人');
});
await suite.case('6-l approver 建立紀錄（adminCreate 形狀）→ ALLOW；帶 recordId／reqId 保留欄位 → DENY', async () => {
    const rec = appSubstituteRecord({ original: t1.name, substitute: t2.name });
    const payload = writeV2Payload(rec, resolveApproverInfo(rec, nameToId), chief, { admin: true });
    const now = iso();
    const record = { ...payload, status: 'approved', initiatedByRole: 'admin', adminOperatorId: chief.teacherId, adminOperatorName: chief.name, createdAt: now, approvedAt: now };
    const r = await submitRecord(chief, record, semesterId);
    allowed(r.priv, 'private'); allowed(r.parent, '紀錄');
    const pub = { ...r.publicPart };
    denied(await createDoc(P.records, rid('rec'), { ...pub, recordId: 'rec_victim' }, as(chief)), '組長帶 recordId');
    denied(await createDoc(P.records, rid('rec'), { ...pub, reqId: 'req_victim' }, as(chief)), '組長帶 reqId');
});

/* ===================== 項目 5（M3）：稽核日誌 ===================== */

const L = (user, over = {}) => ({ ...logEntry(user, semesterId, 'create_request', 'pendingRequest', 'req_1_abc', { k: 'v' }), ...over });
const logA = (user, over, actorOver) => {
    const e = L(user, over);
    if (actorOver) e.actor = { ...e.actor, ...actorOver };
    return createDoc(P.logs, rid('log'), e, as(user));
};

await suite.case('5-a 日誌：前端 operationLogger.log 的標準形狀 → ALLOW（教師／組長／主任）', async () => {
    for (const u of [t1, chief, dir]) allowed(await logA(u), `${u.role} 寫日誌`);
});
await suite.case('5-b 日誌：偽造 actor（uid／teacherId／姓名／email／角色）→ DENY', async () => {
    denied(await logA(t1, {}, { uid: dir.localId }), 'actor.uid 冒用主任');
    denied(await logA(t1, {}, { teacherId: dir.teacherId }), 'actor.teacherId 冒用主任');
    denied(await logA(t1, {}, { name: '教務主任' }), 'actor.name 冒用');
    denied(await logA(t1, {}, { email: dir.email }), 'actor.email 冒用');
    denied(await logA(t1, {}, { role: 'admin' }), 'actor.role 非法值');
    denied(await logA(t1, {}, { extra: 'x' }), 'actor 多餘欄位');
    denied(await logA(t1, { actor: 'not-a-map' }), 'actor 非 map');
});
await suite.case('5-c 日誌：時間戳為未來（9999 年置頂）／非 ISO 格式 → DENY；過去時間與小幅時鐘誤差 → ALLOW', async () => {
    denied(await logA(t1, { timestamp: '9999-12-31T23:59:59.999Z' }), 'timestamp 9999 年');
    denied(await logA(t1, { timestamp: iso(3 * DAY) }), 'timestamp +3 天');
    denied(await logA(t1, { timestamp: 'zzzz' }), 'timestamp 非 ISO');
    denied(await logA(t1, { timestamp: 12345 }), 'timestamp 非字串');
    allowed(await logA(t1, { timestamp: iso(3600 * 1000) }), 'timestamp +1 小時（時鐘誤差）');
    allowed(await logA(t1, { timestamp: iso(-10 * DAY) }), 'timestamp 過去');
});
await suite.case('5-d 日誌：欄位白名單／長度上限（details 鍵數、action／targetId 字元集）→ DENY；上限內 → ALLOW', async () => {
    const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, 1]));
    denied(await logA(t1, { details: keys(31) }), 'details 31 個鍵');
    allowed(await logA(t1, { details: keys(30) }), 'details 30 個鍵');
    denied(await logA(t1, { evil: 'x' }), '多餘欄位');
    denied(await logA(t1, { action: 'DELETE<script>' }), 'action 含非法字元');
    denied(await logA(t1, { action: 'a'.repeat(65) }), 'action 超過 64');
    denied(await logA(t1, { targetId: 'x"><img src=x onerror=1>' }), 'targetId 帶 HTML');
    denied(await logA(t1, { targetType: 'x'.repeat(51) }), 'targetType 超過 50');
    denied(await logA(t1, { details: 'string' }), 'details 非 map');
    allowed(await logA(t1, { targetId: null, details: null }), 'targetId／details 為 null（前端合法）');
});
await suite.case('5-e 日誌：非成員（外部人士）寫入 → DENY', async () => {
    const e = L(t1);
    denied(await createDoc(P.logs, rid('log'), { ...e, actor: { ...e.actor, uid: W.outsider.localId } }, as(W.outsider)), '外部人士');
});

/* ===================== 項目 4（M2）：private/detail 歸屬 ===================== */

await suite.case('4-a substituteRecords/private：替他人「已存在、沒有 private」的紀錄補建假別 → DENY；本人自己的自我調課紀錄補建 → ALLOW', async () => {
    // 前置（owner 寫入）：t1 的自我調課紀錄，沒有 private/detail（例如舊資料／建立時沒有敏感欄位）
    const mk = async (id, ownerId, ownerName) => mustSetDoc(`${P.records}/${id}`, {
        type: '調課', date: '2026-11-17', weekday: '週二', period: '第一節', className: '7年1班', isSelfSwap: true,
        originalTeacher: ownerName, originalTeacherId: ownerId, swapTeacherId: ownerId, substituteTeacherId: ownerId,
        semesterId, createdAt: iso(), status: 'approved',
    });
    await mk('zz_rec_t1_nopriv', t1.teacherId, t1.name);
    await mk('zz_rec_t1_nopriv2', t1.teacherId, t1.name);
    const attack = { leaveType: '調課', allowedTeacherIds: [t4.teacherId] };
    denied(await createDoc(`${P.records}/zz_rec_t1_nopriv/private`, 'detail', attack, as(t4)), 't4 替 t1 的紀錄補建（ACL 只含自己）');
    denied(await createDoc(`${P.records}/zz_rec_t1_nopriv/private`, 'detail', { ...attack, allowedTeacherIds: [t4.teacherId, t1.teacherId] }, as(t4)), 't4 替 t1 的紀錄補建（ACL 含雙方）');
    eq((await getDoc(`${P.records}/zz_rec_t1_nopriv/private/detail`)).ok, false, '攻擊未寫入');
    allowed(await createDoc(`${P.records}/zz_rec_t1_nopriv2/private`, 'detail', { leaveType: '調課', allowedTeacherIds: [t1.teacherId] }, as(t1)), 't1 為自己的紀錄補建');
    allowed(await createDoc(`${P.records}/zz_rec_t1_nopriv/private`, 'detail', { leaveType: '事假', reason: '補登', allowedTeacherIds: [t1.teacherId] }, as(chief)), '組長（approver）可補建任何假別');
});
await suite.case('4-b substituteRecords/private：父文件尚不存在時（前端先寫 private 再寫父文件的正常順序）本人建立 → ALLOW；ACL 含他人／非調課假別 → DENY', async () => {
    allowed(await createDoc(`${P.records}/${rid('rec')}/private`, 'detail', { leaveType: '調課', leaveTypeName: '調課', reason: 'x', allowedTeacherIds: [t1.teacherId] }, as(t1)), '正常順序');
    denied(await createDoc(`${P.records}/${rid('rec')}/private`, 'detail', { leaveType: '調課', allowedTeacherIds: [t1.teacherId, t2.teacherId] }, as(t1)), 'ACL 夾帶他人');
    denied(await createDoc(`${P.records}/${rid('rec')}/private`, 'detail', { leaveType: '事假', allowedTeacherIds: [t1.teacherId] }, as(t1)), '教師注入非調課假別');
});
await suite.case('4-c pendingRequests/private：替他人在途申請補建 → DENY；發起人本人／approver → ALLOW', async () => {
    const mk = async (id) => mustSetDoc(`${P.pending}/${id}`, {
        type: '代課', date: '2026-11-17', weekday: '週二', period: '第一節', className: '7年1班', requestType: 'substitute',
        status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: {}, initiatedBy: t1.teacherId, initiatedByName: t1.name,
        originalTeacherId: t1.teacherId, semesterId, createdAt: iso(),
    });
    await mk('zz_req_a'); await mk('zz_req_b'); await mk('zz_req_c');
    denied(await createDoc(`${P.pending}/zz_req_a/private`, 'detail', { leaveType: '事假', allowedTeacherIds: [t4.teacherId] }, as(t4)), 't4 替 t1 的申請補建');
    denied(await createDoc(`${P.pending}/zz_req_a/private`, 'detail', { leaveType: '事假', allowedTeacherIds: [t4.teacherId, t1.teacherId] }, as(t4)), 't4 替 t1 的申請補建（ACL 含雙方）');
    allowed(await createDoc(`${P.pending}/zz_req_b/private`, 'detail', { leaveType: '事假', reason: 'x', allowedTeacherIds: [t1.teacherId] }, as(t1)), '發起人本人補建');
    allowed(await createDoc(`${P.pending}/zz_req_c/private`, 'detail', { leaveType: '病假', allowedTeacherIds: [t1.teacherId] }, as(chief)), 'approver 補建');
});
await suite.case('4-d private 的 docId 必須是 detail（L4）：非 detail → DENY（教師與 approver 皆然）', async () => {
    denied(await createDoc(`${P.records}/${rid('rec')}/private`, 'evil', { leaveType: '調課', allowedTeacherIds: [t1.teacherId] }, as(t1)), '教師 substituteRecords/private/evil');
    denied(await createDoc(`${P.records}/${rid('rec')}/private`, 'evil', { leaveType: '事假', allowedTeacherIds: [t1.teacherId] }, as(chief)), '組長 substituteRecords/private/evil');
    denied(await createDoc(`${P.pending}/${rid('req')}/private`, 'evil', { leaveType: '事假', allowedTeacherIds: [t1.teacherId] }, as(t1)), '教師 pendingRequests/private/evil');
});
await suite.case('4-e 殘留風險（如實記錄）：父文件尚不存在時無法驗證歸屬，他人可預先為「未來的 id」建 private', async () => {
    // 前端先寫 private 再寫父文件，此刻父文件不存在，規則無從得知這個 id 屬於誰。recordId／reqId 由 genId 產生
    // （毫秒時間 + 7 位隨機字元），攻擊者無從預測；預先佔位也只會讓受害者自己的 private 寫入（create）變 update 而被拒。
    allowed(await createDoc(`${P.records}/${rid('rec')}/private`, 'detail', { leaveType: '調課', allowedTeacherIds: [t4.teacherId] }, as(t4)), '預先佔位（無害：id 不可預測）');
}, { knownGap: '父文件不存在時 private 的 create 無法驗證歸屬（前端先寫 private 再寫父文件的順序使然）；id 不可預測，實際可利用性低' });

/* ===================== 項目 8（M5）：大小上限 ===================== */

await suite.case('8-a private/detail：reason／leaveType／ACL 長度上限 → 超過 DENY，上限內 ALLOW', async () => {
    const mk = (over) => createDoc(`${P.pending}/${rid('req')}/private`, 'detail', { leaveType: '事假', reason: 'x', allowedTeacherIds: [t1.teacherId], ...over }, as(t1));
    allowed(await mk({ reason: 'x'.repeat(2000) }), 'reason 2000');
    denied(await mk({ reason: 'x'.repeat(2001) }), 'reason 2001');
    denied(await mk({ leaveType: 'x'.repeat(51) }), 'leaveType 51');
    denied(await mk({ allowedTeacherIds: Array.from({ length: 31 }, (_, i) => `t${i}`) }), 'ACL 31 人');
});
await suite.case('8-b 紀錄／申請父文件案件文字總長度上限（合計 ≤ 1000）→ 超過 DENY', async () => {
    denied(await tryPending(t1, d => ({ ...d, subject: 'x'.repeat(600), domain: 'y'.repeat(600) })), '兩欄合計超過 1000');
    denied(await trySelfSwap(t1, d => ({ ...d, docNumber: 'x'.repeat(1001) })), 'docNumber 1001');
});

/* ===================== L6：approver 更新紀錄的稽核欄位 ===================== */

await suite.case('L6 組長更新紀錄：改 createdAt／approvedBy／approvedByName／fromRequestId → DENY；改一般欄位 → ALLOW', async () => {
    const rec = fixture.substituteRecords.find(r => r.public.semesterId === semesterId);
    const path = `${P.records}/${rec.recordId}`;
    denied(await updateDoc(path, { createdAt: '2020-01-01T00:00:00.000Z' }, as(chief)), 'createdAt');
    denied(await updateDoc(path, { approvedBy: dir.teacherId }, as(chief)), 'approvedBy');
    denied(await updateDoc(path, { approvedByName: '教務主任' }, as(chief)), 'approvedByName');
    denied(await updateDoc(path, { fromRequestId: 'req_x' }, as(chief)), 'fromRequestId');
    allowed(await updateDoc(path, { className: '7年2班' }, as(chief)), '一般欄位 className');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
