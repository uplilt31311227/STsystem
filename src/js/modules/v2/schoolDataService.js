/**
 * V2 全校共用資料服務
 *
 * 負責 schools/{schoolId}/ 集合下所有 CRUD 操作。
 * 與舊 DataManager（users/{uid}/data/substituteSystem）完全隔離。
 *
 * 注意：此服務不主動寫入 operationLog，log 由呼叫端（pendingRequestService 等）控制。
 */

import { getV2Firestore } from './firebaseV2.js';
import { SCHEMA_PATHS }   from './schemaConstants.js';

export function genId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ===== 敏感欄位拆分（假別／事由私有化，Phase 6） =====
 * leaveType / leaveTypeName / reason 屬敏感個資（請假類型可能透露長期病假／喪假等隱私），
 * 一律不落在全校教師皆可讀的父文件（substituteRecords/pendingRequests），改寫入父文件底下
 * 的 private/detail 子文件，並自帶 allowedTeacherIds ACL 清單（比對 firestore.rules 的
 * hasPrivateDetailAccess()，規則不需 get() 父文件即可判斷可讀性）。
 * 排課資訊（誰在哪節代誰的課）維持全校可讀不受影響——代課單本來就是公告性質，
 * 且衝堂檢查與代課推薦需要。
 */
export const SENSITIVE_RECORD_FIELDS = ['leaveType', 'leaveTypeName', 'reason'];

/** 從紀錄本身可辨識的教師 id 欄位彙整出「當事人」清單，做為 substituteRecords private/detail 的 ACL。 */
export function deriveAllowedTeacherIds(record) {
    const ids = [
        record.initiatedBy,
        record.originalTeacherId,
        record.substituteTeacherId,
        record.swapTeacherId,
        record.approvedBy,
    ];
    if (Array.isArray(record.affectedTeacherIds)) ids.push(...record.affectedTeacherIds);
    return [...new Set(ids.filter(Boolean))];
}

/**
 * 把 payload 拆成 { publicPart, privatePart, hasSensitive }。
 * allowedTeacherIds 傳入陣列時才會寫進 privatePart（更新既有私有文件時傳 null/undefined，
 * 避免用 merge 把既有 ACL 覆蓋成空陣列）；hasSensitive 為 false 代表 payload 完全沒有
 * 敏感欄位，呼叫端應略過 private/detail 的寫入（沒有東西需要保護，也不建立空文件）。
 */
export function splitSensitive(payload, allowedTeacherIds) {
    const publicPart  = { ...payload };
    const privatePart = {};
    let hasSensitive = false;
    for (const field of SENSITIVE_RECORD_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(publicPart, field)) {
            privatePart[field] = publicPart[field];
            delete publicPart[field];
            hasSensitive = true;
        }
    }
    if (hasSensitive && Array.isArray(allowedTeacherIds)) {
        privatePart.allowedTeacherIds = [...new Set(allowedTeacherIds.filter(Boolean))];
    }
    return { publicPart, privatePart, hasSensitive };
}

/* ===== Config ===== */

export async function getConfig() {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.config());
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

export async function upsertConfig(patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.config());
    await fs.setDoc(ref, { ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

/* ===== Teachers ===== */

export async function listTeachers() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.teachersCol());
    const snap = await fs.getDocs(col);
    return snap.docs.map(d => ({ teacherId: d.id, ...d.data() }));
}

export async function getTeacher(teacherId) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? { teacherId: snap.id, ...snap.data() } : null;
}

export async function findTeacherByEmail(email) {
    if (!email) return null;
    const normalized = email.toLowerCase().trim();
    const teachers   = await listTeachers();
    return teachers.find(t => (t.email || '').toLowerCase().trim() === normalized) || null;
}

export async function findTeacherByName(name) {
    if (!name) return null;
    const teachers = await listTeachers();
    return teachers.find(t => t.name === name) || null;
}

export async function createTeacher({ name, email = null, domains = [], homeroomClass = '', role = 'teacher' }) {
    if (!name) throw new Error('教師姓名不可為空');

    const fs        = await getV2Firestore();
    const teacherId = genId('tch');
    const now       = new Date().toISOString();
    const ref       = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));

    const data = {
        name,
        email: email ? email.toLowerCase().trim() : null,
        domains: Array.isArray(domains) ? domains : [],
        homeroomClass: homeroomClass || '',
        role,
        createdAt: now,
        updatedAt: now,
    };
    await fs.setDoc(ref, data);
    return { teacherId, ...data };
}

export async function updateTeacher(teacherId, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));

    const clean = { ...patch, updatedAt: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(clean, 'email') && clean.email) {
        clean.email = clean.email.toLowerCase().trim();
    }
    await fs.updateDoc(ref, clean);
    return getTeacher(teacherId);
}

export async function deleteTeacher(teacherId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));
    await fs.deleteDoc(ref);
}

/* ===== Schedule ===== */

export async function getSchedule() {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.scheduleDoc());
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

export async function saveSchedule(scheduleData) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.scheduleDoc());
    await fs.setDoc(ref, { ...scheduleData, updatedAt: new Date().toISOString() });
}

/* ===== Substitute Records（已成立） ===== */

export async function listSubstituteRecords() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const q    = fs.query(col, fs.orderBy('createdAt', 'desc'));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ recordId: d.id, ...d.data() }));
}

export async function getSubstituteRecord(recordId) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? { recordId: snap.id, ...snap.data() } : null;
}

export async function createSubstituteRecord(record) {
    const fs       = await getV2Firestore();
    const recordId = genId('rec');
    const now      = new Date().toISOString();
    const base     = { ...record, createdAt: record.createdAt || now, approvedAt: record.approvedAt || now };

    const allowedTeacherIds = deriveAllowedTeacherIds(base);
    const { publicPart, privatePart, hasSensitive } = splitSensitive(base, allowedTeacherIds);

    // 先寫 private 再寫父文件：private 寫入失敗就中止，不會留下「父文件存在但假別／事由
    // 遺失」的狀態（假別遺失會讓月結算把不扣減的假別誤算為扣減）。沒有敏感欄位時（例如
    // 內容本來就不含 leaveType/reason）略過 private 寫入，不建立空文件。
    if (hasSensitive) {
        const detailRef = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId));
        await fs.setDoc(detailRef, privatePart);
    }
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    await fs.setDoc(ref, publicPart);

    return { recordId, ...base };
}

export async function updateSubstituteRecord(recordId, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    const now = new Date().toISOString();

    // allowedTeacherIds 傳 null：只有 patch 片段、資訊不足以重算完整當事人清單，
    // 也不該重算——ACL 應維持建立時的當事人清單，merge:true 只更新敏感文字欄位本身。
    const { publicPart, privatePart, hasSensitive } = splitSensitive(patch, null);

    if (hasSensitive) {
        const detailRef = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId));
        await fs.setDoc(detailRef, privatePart, { merge: true });
    }
    await fs.updateDoc(ref, { ...publicPart, updatedAt: now });

    const updated = await getSubstituteRecord(recordId);
    return hasSensitive ? { ...updated, ...privatePart } : updated;
}

export async function deleteSubstituteRecord(recordId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    await fs.deleteDoc(ref);
}

/**
 * 讀取紀錄的私有明細（leaveType/leaveTypeName/reason）。權限不足（非當事人、非 approver）
 * 或文件不存在時一律回傳 null，不拋錯——教師讀不到別人的明細屬預期行為，呼叫端應以
 * `detail?.leaveType ?? record.leaveType` 相容舊資料（既有紀錄的三個欄位仍留在父文件上）。
 */
export async function getRecordDetail(recordId) {
    try {
        const fs   = await getV2Firestore();
        const ref  = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId));
        const snap = await fs.getDoc(ref);
        return snap.exists() ? snap.data() : null;
    } catch (_) {
        return null;
    }
}

/**
 * 批次讀取多筆紀錄的私有明細，回傳 Map<recordId, detail>。
 * 個別讀取失敗（permission-denied 等）已由 getRecordDetail 內部吞掉，不會中斷其餘筆數。
 */
export async function getRecordDetailsBulk(recordIds) {
    const ids = Array.isArray(recordIds) ? [...new Set(recordIds.filter(Boolean))] : [];
    const result = new Map();
    await Promise.all(ids.map(async (id) => {
        const detail = await getRecordDetail(id);
        if (detail) result.set(id, detail);
    }));
    return result;
}

/* ===== Pending Requests（待同意） ===== */

export async function listPendingRequests() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const q    = fs.query(col, fs.orderBy('createdAt', 'desc'));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ reqId: d.id, ...d.data() }));
}

export async function getPendingRequest(reqId) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? { reqId: snap.id, ...snap.data() } : null;
}

// reqId 可選：pendingRequestService.createRequest 需要在寫入父文件「之前」先把 id 定下來，
// 才能先寫同一 id 底下的 private/detail（見該檔案 createRequest 的先寫 private 再寫父文件）。
// 未帶 reqId 時維持原行為，內部自行產生。
export async function createPendingRequest(req, reqId = genId('req')) {
    const fs   = await getV2Firestore();
    const ref   = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    const data  = { ...req, createdAt: req.createdAt || new Date().toISOString() };
    await fs.setDoc(ref, data);
    return { reqId, ...data };
}

export async function updatePendingRequest(reqId, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    await fs.updateDoc(ref, { ...patch, updatedAt: new Date().toISOString() });
    return getPendingRequest(reqId);
}

export async function deletePendingRequest(reqId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    await fs.deleteDoc(ref);
}

/** 讀取請求的私有明細（leaveType/leaveTypeName/reason）。行為同 getRecordDetail：權限不足
 * 或不存在時回傳 null，不拋錯。 */
export async function getRequestDetail(reqId) {
    try {
        const fs   = await getV2Firestore();
        const ref  = fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(reqId));
        const snap = await fs.getDoc(ref);
        return snap.exists() ? snap.data() : null;
    } catch (_) {
        return null;
    }
}

/* ===== User Mapping（uid → teacherId） ===== */

export async function getUserMapping(uid) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.userMapDoc(uid));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

export async function upsertUserMapping(uid, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.userMapDoc(uid));
    await fs.setDoc(ref, { ...patch, lastLoginAt: new Date().toISOString() }, { merge: true });
}

/* ===== Operation Logs（僅寫入與查詢；由 operationLogger 包裝使用） ===== */

export async function appendLog(entry) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.logsCol());
    const ref = await fs.addDoc(col, entry);
    return { logId: ref.id, ...entry };
}

export async function listLogs({ limit: lim = 200, since = null } = {}) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.logsCol());
    const constraints = [fs.orderBy('timestamp', 'desc'), fs.limit(lim)];
    if (since) constraints.unshift(fs.where('timestamp', '>=', since));
    const q    = fs.query(col, ...constraints);
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ logId: d.id, ...d.data() }));
}

/* ===== 即時訂閱（onSnapshot） ===== */

export async function subscribePendingRequests(callback, onError) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const q   = fs.query(col, fs.orderBy('createdAt', 'desc'));
    return fs.onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ reqId: d.id, ...d.data() })));
    }, onError);
}

export async function subscribeSubstituteRecords(callback, onError) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const q   = fs.query(col, fs.orderBy('createdAt', 'desc'));
    return fs.onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ recordId: d.id, ...d.data() })));
    }, onError);
}

// P2 全校課表共享：訂閱單一 schedule doc（schools/{schoolId}/data/schedule）。
// 首次註冊即回傳目前值；之後任何 approver 上傳/編輯課表都會即時推播給全校教師。
export async function subscribeSchedule(callback, onError) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.scheduleDoc());
    return fs.onSnapshot(ref, (snap) => {
        callback(snap.exists() ? snap.data() : null);
    }, onError);
}

export async function subscribeOperationLogs(callback, { limit: lim = 200 } = {}, onError) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.logsCol());
    const q   = fs.query(col, fs.orderBy('timestamp', 'desc'), fs.limit(lim));
    return fs.onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ logId: d.id, ...d.data() })));
    }, onError);
}
