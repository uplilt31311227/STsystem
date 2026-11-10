/**
 * 規則測試共用工具（v2.12 身分與授權修補的測試套件使用）
 *
 * 1. setup()：重建 emulator 世界並整理出 alpha 校的常用身分與路徑。
 * 2. 「前端形狀」payload 建構器：逐步複製前端實際寫入的欄位，白名單才不會「測試過、正式站壞掉」。
 *    來源（修改這裡前請先對照原始碼）：
 *      app.js  confirmSubstitute／confirmMultiCourseSubstitute／buildSwapRecord／submitSwapBatch
 *      v2-app.js  writeV2Record／resolveApproverInfo
 *      pendingRequestService.js  createRequest／consentRequest／approveRequest／rejectRequest
 *      schoolDataService.js  splitSensitive／createSubstituteRecord／createPendingRequest／deriveAllowedTeacherIds
 *      operationLogger.js  log／safeActor
 */

import { seedAll } from './seed.mjs';
import { getDoc, createDoc, updateDoc, mustSetDoc } from './emu-client.mjs';
// 直接引用前端真正的實作（純函式，無瀏覽器依賴）：details 打包成 rules 接受的單一限長 JSON 字串
import { packDetails } from '../../src/js/modules/v2/logDetails.js';

export const SCHOOL = 'demo-alpha';

export const P = {
    config:   `schools/${SCHOOL}/config/main`,
    teachers: `schools/${SCHOOL}/teachers`,
    mappings: `schools/${SCHOOL}/userMappings`,
    emailIdx: `schools/${SCHOOL}/emailIndex`,
    records:  `schools/${SCHOOL}/substituteRecords`,
    pending:  `schools/${SCHOOL}/pendingRequests`,
    logs:     `schools/${SCHOOL}/operationLogs`,
    attempts: `schools/${SCHOOL}/joinAttempts`,
};

/** 現在（或位移後）的 ISO 字串——與前端 new Date().toISOString() 同格式。 */
export const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
export const DAY = 24 * 3600 * 1000;

export async function setup() {
    const seed = await seedAll({ quiet: true });
    const { fixture, accounts } = seed.alpha;
    const semesterId = fixture.config.currentSemester;
    const byEmail = (email) => [...accounts.values()].find(a => a.email === email);
    const dir   = seed.alpha.director;       // t01，同時在 initialAdminEmails 白名單
    const chief = seed.alpha.sectionChief;   // t02
    const [t1, t2, t3, t4] = seed.alpha.teachers;
    return { seed, fixture, accounts, semesterId, byEmail, dir, chief, t1, t2, t3, t4,
             beta: seed.beta, outsider: seed.outsider };
}

export const as = (user) => ({ idToken: user.idToken });

/* ===================== 日誌（operationLogger.log 的形狀） ===================== */
// v2.12b：details 由 operationLogger 經 packDetails 打包（無內容 → {}；其餘 → JSON 字串）。

export function logEntry(user, semesterId, action = 'create_request', targetType = 'pendingRequest', targetId = 'x', details = {}) {
    return {
        timestamp: iso(),
        actor: { uid: user.localId, email: user.email, name: user.name, role: user.role === 'admin' ? 'director' : user.role, teacherId: user.teacherId },
        action, targetType, targetId, details: packDetails(details), semesterId,
    };
}

/* ===================== 紀錄／申請（前端形狀） ===================== */

/** app.js confirmSubstitute 的 record（代課）。 */
export function appSubstituteRecord({ original, substitute, date = '2026-11-17', weekday = '週二', period = '第三節', className = '7年1班', subject = '國語文', domain = '語文', leaveType = '事假', reason = '家中有事' }) {
    return {
        id: String(Date.now()),
        type: '代課', date, weekday, period, className, subject, domain,
        originalTeacher: original, substituteTeacher: substitute,
        leaveType, leaveTypeName: leaveType, docNumber: '', reason,
        createdAt: iso(),
    };
}

/** app.js buildSwapRecord 的 record（調課；self=true 為教師自我調課）。 */
export function appSwapRecord({ teacherA, teacherB, self = false, idSuffix = '', batch = null, className = '7年1班' }) {
    const rec = {
        id: String(Date.now()) + idSuffix,
        type: '調課',
        date: '2026-11-17', swapDate: '2026-11-19',
        weekday: '週二', period: '第三節', className, subject: '國語文', domain: '語文',
        originalTeacher: teacherA,
        swapWeekday: '週四', swapPeriod: '第二節', swapTeacher: teacherB, swapSubject: '英語', swapDomain: '英語',
        substituteTeacher: teacherB,
        leaveType: '調課', leaveTypeName: '調課', docNumber: '',
        isSelfSwap: self, isMultiSwap: true,
        reason: self ? `${teacherA} 自行調課` : `時段A ↔ 時段B 課程互換`,
        createdAt: iso(),
    };
    if (batch) { rec.batchId = batch.id; rec.batchSize = batch.size; }
    return rec;
}

/** v2-app.js resolveApproverInfo：姓名 → teacherId，並決定 requestType／requiredApprover。 */
export function resolveApproverInfo(record, nameToId, additionalNames = []) {
    const findId = (n) => nameToId.get(n) || null;
    const originalTeacherId = findId(record.originalTeacher);
    const substituteTeacherId = findId(record.substituteTeacher);
    const swapTeacherId = findId(record.swapTeacher);
    const additionalConsentTeacherIds = additionalNames.map(findId).filter(Boolean);
    let requiredApproverId = null, requiredApproverName = null, requestType = 'substitute';
    if (record.isSelfSwap) {
        // 自我調課：不需他人同意
    } else if (record.type === '代課') {
        requiredApproverId = substituteTeacherId; requiredApproverName = record.substituteTeacher || null; requestType = 'substitute';
    } else if (record.type === '調課') {
        requiredApproverId = swapTeacherId || substituteTeacherId;
        requiredApproverName = record.swapTeacher || record.substituteTeacher || null;
        requestType = additionalConsentTeacherIds.length ? 'multi_swap' : 'swap';
    }
    return { originalTeacherId, substituteTeacherId, swapTeacherId, additionalConsentTeacherIds, requiredApproverId, requiredApproverName, requestType };
}

/** v2-app.js writeV2Record 組出的 payload（送給 createRequest／createSubstituteRecord／adminCreate 之前）。 */
export function writeV2Payload(record, ids, me, { admin = false, adminOnBehalfOf = null } = {}) {
    const payload = {
        ...record, ...ids,
        requestType: ids.requestType,
        ...(ids.requestType === 'multi_swap'
            ? { consentTeacherIds: [ids.swapTeacherId, ...ids.additionalConsentTeacherIds].filter(Boolean) } : {}),
        initiatedByName: record.originalTeacher || me.name,
    };
    payload.initiatedBy = admin ? (adminOnBehalfOf || ids.originalTeacherId || me.teacherId) : me.teacherId;
    return payload;
}

/** schoolDataService.splitSensitive。 */
export function splitSensitive(payload, allowedTeacherIds) {
    const publicPart = { ...payload }, privatePart = {};
    let hasSensitive = false;
    for (const f of ['leaveType', 'leaveTypeName', 'reason']) {
        if (Object.prototype.hasOwnProperty.call(publicPart, f)) { privatePart[f] = publicPart[f]; delete publicPart[f]; hasSensitive = true; }
    }
    if (hasSensitive && Array.isArray(allowedTeacherIds)) privatePart.allowedTeacherIds = [...new Set(allowedTeacherIds.filter(Boolean))];
    return { publicPart, privatePart, hasSensitive };
}

/** pendingRequestService.buildAffectedList。 */
export function buildAffectedList(req) {
    const list = [req.initiatedBy, req.requiredApproverId, req.originalTeacherId, req.substituteTeacherId, req.swapTeacherId];
    if (Array.isArray(req.pendingConsentTeacherIds)) list.push(...req.pendingConsentTeacherIds);
    if (Array.isArray(req.consentTeacherIds)) list.push(...req.consentTeacherIds);
    if (req.swapConsents && typeof req.swapConsents === 'object') list.push(...Object.keys(req.swapConsents));
    return [...new Set(list.filter(Boolean))];
}

/**
 * pendingRequestService.createRequest + schoolDataService.createPendingRequest 的寫入內容。
 * 回傳 { reqId, publicDoc, privateDoc|null }；呼叫端依前端順序「先 private、後父文件」寫入。
 */
export function buildPendingRequestDocs(payload, semesterId, me) {
    const requestType = payload.requestType || 'substitute';
    let status, pendingConsentTeacherIds = [];
    if (requestType === 'substitute') status = 'pending_approval';
    else if (requestType === 'swap') { status = 'pending_swap_consent'; pendingConsentTeacherIds = [payload.swapTeacherId || payload.requiredApproverId]; }
    else {
        const rawIds = (Array.isArray(payload.consentTeacherIds) && payload.consentTeacherIds.length)
            ? payload.consentTeacherIds : [payload.swapTeacherId || payload.requiredApproverId, ...(payload.additionalConsentTeacherIds || [])];
        pendingConsentTeacherIds = [...new Set(rawIds.filter(Boolean))]; status = 'pending_swap_consent';
    }
    const req = {
        ...payload, requestType, status, pendingConsentTeacherIds, swapConsents: {},
        initiatedBy: payload.initiatedBy || me.teacherId,
        initiatedByName: payload.initiatedByName || me.name,
        createdAt: iso(),
    };
    delete req.consentTeacherIds; delete req.additionalConsentTeacherIds;
    const allowed = buildAffectedList(req);
    const { publicPart, privatePart, hasSensitive } = splitSensitive(req, allowed);
    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const publicDoc = { ...publicPart, semesterId, createdAt: publicPart.createdAt || iso() };
    return { reqId, publicDoc, privateDoc: hasSensitive ? privatePart : null };
}

/** 依前端順序寫入一筆申請（先 private、後父文件）；回傳兩個 REST 回應。 */
export async function submitPending(user, built) {
    let priv = { ok: true };
    if (built.privateDoc) priv = await createDoc(`${P.pending}/${built.reqId}/private`, 'detail', built.privateDoc, as(user));
    const parent = await createDoc(P.pending, built.reqId, built.publicDoc, as(user));
    return { priv, parent };
}

/** schoolDataService.createSubstituteRecord（教師自我調課與 approver 代發共用）；回傳 { recordId, priv, parent }。 */
export async function submitRecord(user, payload, semesterId, { status = 'approved', initiatedByRole } = {}) {
    const now = iso();
    const base = { ...payload, status, ...(initiatedByRole ? { initiatedByRole } : {}), semesterId, createdAt: payload.createdAt || now, approvedAt: payload.approvedAt || now };
    const allowed = [...new Set([base.initiatedBy, base.originalTeacherId, base.substituteTeacherId, base.swapTeacherId, base.approvedBy].filter(Boolean))];
    const { publicPart, privatePart, hasSensitive } = splitSensitive(base, allowed);
    const recordId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    let priv = { ok: true };
    if (hasSensitive) priv = await createDoc(`${P.records}/${recordId}/private`, 'detail', privatePart, as(user));
    const parent = await createDoc(P.records, recordId, publicPart, as(user));
    return { recordId, priv, parent, publicPart, privatePart };
}

/** 教師名冊：name → teacherId。 */
export function nameToIdMap(fixture) {
    return new Map(fixture.teachers.map(t => [t.name, t.teacherId]));
}

/** 以 owner 權限直接寫入一筆待同意的調課申請（測試前置；不走規則）。 */
export async function seedPending(id, overrides = {}) {
    const doc = {
        type: '調課', date: '2026-11-17', weekday: '週二', period: '第三節', className: '7年1班', subject: '國語文',
        requestType: 'swap', status: 'pending_swap_consent', pendingConsentTeacherIds: [], swapConsents: {},
        initiatedBy: 'x', initiatedByName: 'x', semesterId: '115-1', createdAt: iso(), ...overrides,
    };
    await mustSetDoc(`${P.pending}/${id}`, doc);
    return doc;
}

export { getDoc, createDoc, updateDoc };

/* ===================== 常用組合（供各測試檔共用） ===================== */

/** 前端形狀的「申請父文件」＋ private（代課 'sub' 或調課 'swap'），尚未寫入。 */
export function buildPending(W, me, { type = 'sub', partner = null } = {}) {
    const nameToId = nameToIdMap(W.fixture);
    const other = partner || W.t2;
    const rec = type === 'sub'
        ? appSubstituteRecord({ original: me.name, substitute: other.name })
        : appSwapRecord({ teacherA: me.name, teacherB: other.name });
    const built = buildPendingRequestDocs(writeV2Payload(rec, resolveApproverInfo(rec, nameToId), me), W.semesterId, me);
    return built;   // { reqId, publicDoc, privateDoc }
}

/** 前端形狀的「自我調課紀錄」父文件與 private，尚未寫入。 */
export function buildSelfSwap(W, me) {
    const nameToId = nameToIdMap(W.fixture);
    const rec = appSwapRecord({ teacherA: me.name, teacherB: me.name, self: true });
    const payload = writeV2Payload(rec, resolveApproverInfo(rec, nameToId), me);
    const now = iso();
    const base = { ...payload, status: 'approved', initiatedByRole: 'teacher', semesterId: W.semesterId, createdAt: now, approvedAt: now };
    const { publicPart, privatePart } = splitSensitive(base, [me.teacherId]);
    return { recordId: `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`, publicDoc: publicPart, privateDoc: privatePart };
}
