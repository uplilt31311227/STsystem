#!/usr/bin/env node
/**
 * firestore.rules v2.12b：驗收補強（P3 獨立驗收發現的缺陷）
 *   H-1  近 1MB 的全校可讀文件：自我調課 approvedAt、pendingConsentTeacherIds 元素、private 的
 *        allowedTeacherIds 元素、教師自改 authProvider
 *   H-2  日誌 details 無大小上限（日誌不可刪）→ 改為單一限長 JSON 字串
 *   M-1  approver 在狀態不變時改寫 approvedBy／rejectedBy／rejectNote
 *   M-2  日誌 actor.role 偽造　M-3 approver 更新紀錄無白名單　M-4 同意人把名單灌成重複 id
 *   L-1 id／batchId 格式　L-3 null 防護　L-4 時間下界　L-5 swapConsents 型別　L-7 attemptedAt／createdAt 限長
 *
 * 案例編號（R6-*、C3-*、P4-*、L5-*、S8-*）對應驗收者攻擊腳本 scratchpad\p3-verify\attacks.mjs。
 * 每組 DENY 案例都配有「前端正常形狀 → ALLOW」對照。
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-hardening.mjs（會清空並重建 emulator 資料）
 */
import { createDoc, updateDoc, getDoc, setDoc, mustSetDoc, mergeDoc, createTestUser } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';
import { setup, P, as, iso, DAY, logEntry, buildPending, buildSelfSwap, seedPending } from './kit.mjs';
import { packDetails } from '../../src/js/modules/v2/logDetails.js';

const W = await setup();
const { semesterId, fixture, dir, chief, t1, t2, outsider } = W;
const t5 = W.seed.alpha.teachers[4], t6 = W.seed.alpha.teachers[5];
const suite = new Suite('firestore.rules v2.12b：驗收補強（H-1／H-2／M-1～M-4／L-1／L-3／L-4／L-5／L-7）');
const rid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const pend = (mut, user = t1, type = 'sub') => { const b = buildPending(W, user, { type }); return createDoc(P.pending, b.reqId, mut({ ...b.publicDoc }), as(user)); };
const self = (mut, user = t1) => { const b = buildSelfSwap(W, user); return createDoc(P.records, b.recordId, mut({ ...b.publicDoc }), as(user)); };
const log = (user, over = {}, actorOver = null) => {
    const e = { ...logEntry(user, semesterId), ...over };
    if (actorOver) e.actor = { ...e.actor, ...actorOver };
    return createDoc(P.logs, rid('log'), e, as(user));
};
const ids = (n, prefix = 'tch_demo-alpha_') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, '0')}`);

/* ===================== H-1a 自我調課 approvedAt ===================== */
await suite.case('H-1a 自我調課 approvedAt：500KB 字串／HTML／map（R6-1~3）→ DENY；前端正常 ISO → ALLOW', async () => {
    denied(await self(d => ({ ...d, approvedAt: 'x'.repeat(500000) })), 'R6-1 500KB 字串');
    denied(await self(d => ({ ...d, approvedAt: '<img src=x onerror=alert(1)>' })), 'R6-2 HTML');
    denied(await self(d => ({ ...d, approvedAt: '9999-12-31T00:00:00.000Z' })), 'R6-2 9999 年');
    denied(await self(d => ({ ...d, approvedAt: { evil: 'x'.repeat(1000) } })), 'R6-3 map');
    allowed(await self(d => d), '對照：前端形狀（approvedAt 為 ISO）');
});

/* ===================== H-1b pendingConsentTeacherIds 元素 ===================== */
await suite.case('H-1b 申請 pendingConsentTeacherIds：元素 40KB 字串／元素為 map（R6-4/5）→ DENY；20 位正常同意人 → ALLOW', async () => {
    denied(await pend(d => ({ ...d, pendingConsentTeacherIds: Array.from({ length: 20 }, (_, i) => 'y'.repeat(40000) + i) }), t1, 'swap'), 'R6-4 20×40KB');
    denied(await pend(d => ({ ...d, pendingConsentTeacherIds: [{ x: 1 }] }), t1, 'swap'), 'R6-5 元素為 map');
    denied(await pend(d => ({ ...d, pendingConsentTeacherIds: [t2.teacherId, 'a"b<c'] }), t1, 'swap'), '元素含 < > "');
    const twenty = ids(20, 'tch_c_');
    allowed(await pend(d => ({ ...d, requestType: 'multi_swap', pendingConsentTeacherIds: twenty, affectedTeacherIds: [t1.teacherId, ...twenty.slice(0, 5)] }), t1, 'swap'), '20 位同意人（含 affectedTeacherIds）');
});

/* ===================== H-1c private allowedTeacherIds 元素 ===================== */
await suite.case('H-1c private ACL：元素 30KB 字串（P4-1）／元素為 map → DENY；25 人正常 ACL（教師、組長）→ ALLOW', async () => {
    const big = 'x'.repeat(30000);
    const priv = (acl) => ({ leaveType: '事假', allowedTeacherIds: acl });
    denied(await createDoc(`${P.pending}/${rid('req')}/private`, 'detail', priv([t1.teacherId, ...Array.from({ length: 29 }, (_, i) => big + i)]), as(t1)), 'P4-1 教師 29×30KB');
    denied(await createDoc(`${P.pending}/${rid('req')}/private`, 'detail', priv([t1.teacherId, { a: 1 }]), as(t1)), '元素為 map');
    denied(await createDoc(`${P.records}/${rid('rec')}/private`, 'detail', priv([t1.teacherId, ...Array.from({ length: 29 }, (_, i) => big + i)]), as(chief)), '組長 29×30KB（substituteRecords/private）');
    allowed(await createDoc(`${P.pending}/${rid('req')}/private`, 'detail', priv([t1.teacherId, ...ids(24)]), as(t1)), '教師 25 人 ACL');
    allowed(await createDoc(`${P.records}/${rid('rec')}/private`, 'detail', priv([t1.teacherId, ...ids(28)]), as(chief)), '組長 29 人 ACL（substituteRecords/private）');
});

/* ===================== H-1d authProvider ===================== */
await suite.case('H-1d 教師自改 authProvider：100KB／HTML（S8-3/4）→ DENY；google.com／password＋ISO updatedAt（前端 authGuardV2 形狀）→ ALLOW', async () => {
    const p = `${P.teachers}/${t1.teacherId}`;
    denied(await updateDoc(p, { authProvider: 'a'.repeat(100000), updatedAt: iso() }, as(t1)), 'S8-3 100KB');
    denied(await updateDoc(p, { authProvider: '<img src=x onerror=alert(1)>', updatedAt: iso() }, as(t1)), 'S8-4 HTML');
    denied(await updateDoc(p, { authProvider: 'evil.com', updatedAt: iso() }, as(t1)), '非 google.com／password');
    denied(await updateDoc(p, { authProvider: 'google.com', updatedAt: 'x'.repeat(100000) }, as(t1)), 'updatedAt 100KB');
    allowed(await updateDoc(p, { authProvider: 'google.com', updatedAt: iso() }, as(t1)), 'google.com');
    allowed(await updateDoc(p, { authProvider: 'password', updatedAt: iso() }, as(t1)), 'password');
});

/* ===================== H-2 日誌 details ===================== */
await suite.case('H-2 日誌 details：900KB 字串／30 鍵×500 元素陣列（L5-1/2）／舊 map 形狀 → DENY；前端 packDetails 輸出（含超大內容截斷）→ ALLOW', async () => {
    denied(await log(t1, { details: { blob: 'x'.repeat(900000) } }), 'L5-1 map 內 900KB 字串');
    denied(await log(t1, { details: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, Array.from({ length: 500 }, (_, j) => j)])) }), 'L5-2 30 鍵×500 元素');
    denied(await log(t1, { details: 'x'.repeat(900000) }), '字串 900KB');
    denied(await log(t1, { details: 'x'.repeat(10001) }), '字串 10001（上限 10000）');
    denied(await log(t1, { details: { a: 1 } }), '非空 map（舊形狀，新寫入不再接受）');
    denied(await log(t1, { details: 12345 }), '數字');
    allowed(await log(t1, { details: 'x'.repeat(10000) }), '字串恰 10000');
    allowed(await log(t1, { details: null }), 'null');
    allowed(await log(t1, { details: {} }), '空 map（無內容）');
    const nested = { before: { className: '7年1班', note: '中文'.repeat(50) }, after: { className: '7年2班' }, affectedTeacherIds: ids(20) };
    allowed(await createDoc(P.logs, rid('log'), logEntry(t1, semesterId, 'edit', 'substituteRecord', 'rec_1_abc', nested), as(t1)), '巢狀 before／after（打包成字串）');
    const hugeEntry = logEntry(t1, semesterId, 'edit', 'substituteRecord', 'rec_1_abc', { blob: '中'.repeat(200000), k2: 'y' });
    eq(typeof hugeEntry.details, 'string', 'packDetails 對超大 details 輸出字串');
    allowed(await createDoc(P.logs, rid('log'), hugeEntry, as(t1)), '超大 details 經 packDetails 截斷後仍寫得進去（日誌不會遺失）');
    const parsed = JSON.parse(hugeEntry.details);
    eq([parsed._truncated, parsed.keys], [true, ['blob', 'k2']], '截斷摘要保留原始鍵名');
    eq(packDetails({ a: 1 }), '{"a":1}', 'packDetails 一般內容為 JSON 字串');
});

/* ===================== M-1 approver 狀態不變時的欄位 ===================== */
await suite.case('M-1 approver：狀態不變時改寫核准者／駁回者／rejectNote（C3-5~8）、approvedAt 9999 年 → DENY；正常核准與駁回 → ALLOW', async () => {
    const mk = async (id, over) => seedPending(id, { requestType: 'swap', initiatedBy: t1.teacherId, semesterId, ...over });
    await mk('zz_c5', { status: 'pending_swap_consent', pendingConsentTeacherIds: [t2.teacherId] });
    denied(await updateDoc(`${P.pending}/zz_c5`, { approvedBy: dir.teacherId, approvedByName: dir.name, approvedAt: iso() }, as(chief)), 'C3-5 待同意階段不改 status 只寫 approvedBy');
    await mk('zz_c6', { status: 'approved', approvedBy: dir.teacherId, approvedByName: dir.name, approvedAt: iso() });
    denied(await updateDoc(`${P.pending}/zz_c6`, { approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: iso() }, as(chief)), 'C3-6 覆寫已核准軌跡');
    await mk('zz_c7', { status: 'pending_approval' });
    denied(await updateDoc(`${P.pending}/zz_c7`, { status: 'approved', approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: '9999-12-31T00:00:00.000Z', statusUpdatedAt: iso() }, as(chief)), 'C3-7 approvedAt 9999 年');
    await mk('zz_c8', { status: 'rejected', rejectedBy: t2.teacherId });
    denied(await updateDoc(`${P.pending}/zz_c8`, { rejectedBy: chief.teacherId, rejectNote: '<img src=x onerror=alert(1)>' }, as(chief)), 'C3-8 已駁回改署名與 rejectNote');
    denied(await updateDoc(`${P.pending}/zz_c7`, { status: 'approved', approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: iso(), statusUpdatedAt: iso(), rejectNote: 'x' }, as(chief)), '核准時夾帶 rejectNote');
    denied(await updateDoc(`${P.pending}/zz_c7`, { status: 'approved', approvedBy: chief.teacherId, approvedByName: 'x'.repeat(101), approvedAt: iso(), statusUpdatedAt: iso() }, as(chief)), 'approvedByName 101 字元');
    allowed(await updateDoc(`${P.pending}/zz_c7`, { status: 'approved', approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: iso(), statusUpdatedAt: iso() }, as(chief)), '對照：正常核准');
    await mk('zz_c9', { status: 'pending_approval' });
    allowed(await updateDoc(`${P.pending}/zz_c9`, { status: 'rejected', rejectedAt: iso(), rejectedBy: chief.teacherId, rejectedByName: chief.name, rejectNote: '時間無法配合', statusUpdatedAt: iso() }, as(chief)), '對照：正常駁回');
});

/* ===================== M-2 actor.role ===================== */
await suite.case('M-2 日誌 actor.role：教師偽造 director／組長偽造 director（L5-6）→ DENY；與教師檔一致、舊 admin 視同 director、白名單主任 → ALLOW', async () => {
    denied(await log(t1, {}, { role: 'director' }), 'L5-6 教師偽造 director');
    denied(await log(t1, {}, { role: 'section_chief' }), '教師偽造 section_chief');
    denied(await log(chief, {}, { role: 'director' }), '組長偽造 director');
    allowed(await log(t1), '教師 role=teacher');
    allowed(await log(chief), '組長 role=section_chief');
    allowed(await log(dir), '主任 role=director');
    // 舊資料相容：教師檔 role='admin'（舊 alpha 期）→ 前端 normalizeRole 成 director
    await mergeDoc(`${P.teachers}/${t2.teacherId}`, { role: 'admin' });
    allowed(await log(t2, {}, { role: 'director' }), "教師檔 role='admin' 以 director 寫日誌");
    denied(await log(t2, {}, { role: 'teacher' }), "教師檔 role='admin' 卻寫 teacher（不一致）");
    // 白名單主任尚未升級教師檔 role 的空檔（role 仍為 teacher、但在 initialAdminEmails 內）
    await mergeDoc(`${P.teachers}/${dir.teacherId}`, { role: 'teacher' });
    allowed(await log(dir, {}, { role: 'director' }), '白名單主任（教師檔 role=teacher）寫 director');
    await mergeDoc(`${P.teachers}/${dir.teacherId}`, { role: 'director' });
    allowed(await log(t1, {}, { role: undefined }), 'actor 省略 role（相容）');
});

/* ===================== M-3 approver 更新 substituteRecords ===================== */
await suite.case('M-3 approver 更新紀錄：className 為 HTML、900KB 的任意欄位、非白名單欄位（R6-24/25）→ DENY；正常編輯案件欄位／updatedAt → ALLOW', async () => {
    const b = buildSelfSwap(W, t1);
    allowed(await createDoc(P.records, b.recordId, b.publicDoc, as(t1)), '前置：自我調課紀錄');
    const path = `${P.records}/${b.recordId}`;
    denied(await updateDoc(path, { className: '<img src=x onerror=alert(1)>' }, as(chief)), 'R6-24 className HTML');
    denied(await updateDoc(path, { junk: 'z'.repeat(900000) }, as(chief)), 'R6-25 900KB 任意欄位');
    denied(await updateDoc(path, { className: 'x'.repeat(2000) }, as(chief)), 'className 超長');
    denied(await updateDoc(path, { className: { a: 1 } }, as(chief)), 'className 為 map');
    denied(await updateDoc(path, { status: 'rejected' }, as(chief)), '非白名單欄位 status');
    denied(await updateDoc(path, { updatedAt: '9999-12-31T00:00:00.000Z', className: '7年2班' }, as(chief)), 'updatedAt 未來');
    allowed(await updateDoc(path, { className: '7年2班', subject: '數學', updatedAt: iso() }, as(chief)), '對照：updateSubstituteRecord 的實際寫入形狀');
});

/* ===================== M-4 同意名單重複 id ===================== */
await suite.case('M-4 同意人把剩餘名單灌成重複 id（C3-1）→ DENY；正常同意（名單恰少一人）→ ALLOW', async () => {
    await seedPending('zz_m4', { requestType: 'multi_swap', status: 'pending_swap_consent', pendingConsentTeacherIds: [t2.teacherId, t5.teacherId], initiatedBy: t1.teacherId, semesterId });
    const dup = Array.from({ length: 500 }, () => t5.teacherId);
    denied(await updateDoc(`${P.pending}/zz_m4`, { pendingConsentTeacherIds: dup, swapConsents: { [t2.teacherId]: { consentedAt: iso() } }, status: 'pending_swap_consent', statusUpdatedAt: iso() }, as(t2)), 'C3-1 500 個重複 id');
    denied(await updateDoc(`${P.pending}/zz_m4`, { pendingConsentTeacherIds: [t5.teacherId, t5.teacherId], swapConsents: { [t2.teacherId]: { consentedAt: iso() } }, status: 'pending_swap_consent', statusUpdatedAt: iso() }, as(t2)), '重複兩個');
    allowed(await updateDoc(`${P.pending}/zz_m4`, { pendingConsentTeacherIds: [t5.teacherId], swapConsents: { [t2.teacherId]: { consentedAt: iso() } }, status: 'pending_swap_consent', statusUpdatedAt: iso() }, as(t2)), '對照：正常同意');
});

/* ===================== L-1 id 格式 ===================== */
await suite.case('L-1 id／batchId 格式：屬性注入字元（R6-10）、map／list／數字型別（R6-7/8/9）、非數字 batchId → DENY；前端形狀（純數字、_序號）→ ALLOW', async () => {
    denied(await pend(d => ({ ...d, id: "x' onmouseover=alert(1) `&#60;" })), 'R6-10 單引號／反引號／&');
    denied(await pend(d => ({ ...d, id: { a: 1 } })), 'R6-7 id 為 map');
    denied(await pend(d => ({ ...d, id: ['a', 'b'] })), 'R6-8 id 為 list');
    denied(await pend(d => ({ ...d, id: 12345 })), 'R6-9 id 為數字');
    denied(await pend(d => ({ ...d, id: 'a b' })), 'id 含空白');
    denied(await pend(d => ({ ...d, id: 'x'.repeat(41) })), 'id 超過 40');
    denied(await pend(d => ({ ...d, batchId: 'abc', batchSize: 2 })), 'batchId 非純數字');
    denied(await self(d => ({ ...d, batchId: 123456789, batchSize: 3 })), 'batchId 為數字型別');
    denied(await pend(d => ({ ...d, multiCourseGroupId: "1'2", isMultiCourse: true })), 'multiCourseGroupId 含單引號');
    allowed(await pend(d => ({ ...d, id: '1731300000000_3', batchId: '1731300000000', batchSize: 4 }), t1, 'swap'), '前端：id 為 時間_序號、batchId 為純數字字串');
    allowed(await self(d => ({ ...d, id: '1731300000001_0', batchId: '1731300000001', batchSize: 2 })), '前端：自我調課批次');
});

/* ===================== L-3 null 防護 ===================== */
await suite.case('L-3 案件文字欄位為 null（R6-16）→ ALLOW（不再 evaluation error）；map／list 型別 → 仍 DENY', async () => {
    allowed(await pend(d => ({ ...d, domain: null, swapDomain: null })), 'R6-16 domain 為 null');
    allowed(await self(d => ({ ...d, domain: null, docNumber: null })), '自我調課 domain／docNumber 為 null');
    denied(await pend(d => ({ ...d, domain: { a: 1 } })), 'domain 為 map');
    denied(await pend(d => ({ ...d, subject: ['a'] })), 'subject 為 list');
});

/* ===================== L-4 時間下界 ===================== */
await suite.case('L-4 時間欄位下界（2026-03-01）：2000／1970／2026-02 → DENY；近期與下界之後 → ALLOW', async () => {
    denied(await pend(d => ({ ...d, createdAt: '2000-01-01T00:00:00.000Z' })), '申請 createdAt 2000 年');
    denied(await self(d => ({ ...d, createdAt: '2026-02-28T00:00:00.000Z' })), '自我調課 createdAt 2026-02-28');
    denied(await log(t1, { timestamp: '2000-01-01T00:00:00.000Z' }), 'L5-3 日誌回溯 2000 年');
    denied(await log(t1, { timestamp: '1970-01-01T00:00:00.000Z' }), '日誌 1970');
    allowed(await pend(d => ({ ...d, createdAt: '2026-03-02T00:00:00.000Z' })), '申請 createdAt 2026-03-02');
    allowed(await log(t1, { timestamp: iso(-20 * DAY) }), '日誌 20 天前');
});

/* ===================== L-5 swapConsents 型別 ===================== */
await suite.case('L-5 申請 swapConsents 型別：空字串／list（R6-6）→ DENY；空 map（前端 createRequest 形狀）→ ALLOW', async () => {
    denied(await pend(d => ({ ...d, swapConsents: '' }), t1, 'swap'), 'R6-6 空字串');
    denied(await pend(d => ({ ...d, swapConsents: [] }), t1, 'swap'), 'list');
    allowed(await pend(d => ({ ...d, swapConsents: {} }), t1, 'swap'), '空 map');
});

/* ===================== L-7 attemptedAt／createdAt 長度 ===================== */
await suite.case('L-7 joinAttempts.attemptedAt／userDirectory.createdAt 100KB（S8-5/6）→ DENY；ISO 字串（前端形狀）→ ALLOW', async () => {
    const o = await createTestUser('l7user@nowhere.test');
    denied(await setDoc(`${P.attempts}/${o.localId}`, { email: o.email, attemptedAt: 'a'.repeat(100000), reason: 'x' }, as(o)), 'S8-5 attemptedAt 100KB');
    allowed(await setDoc(`${P.attempts}/${o.localId}`, { email: o.email, attemptedAt: iso(), reason: 'no_teacher_match' }, as(o)), 'attemptedAt ISO');
    denied(await setDoc(`userDirectory/${o.localId}`, { schoolId: fixture.schoolId, createdAt: 'c'.repeat(100000) }, as(o)), 'S8-6 createdAt 100KB');
    allowed(await setDoc(`userDirectory/${o.localId}`, { schoolId: fixture.schoolId, createdAt: iso() }, as(o)), 'createdAt ISO');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
