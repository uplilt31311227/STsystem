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

function genId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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
    const ref      = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    const now      = new Date().toISOString();
    const data     = { ...record, createdAt: record.createdAt || now, approvedAt: record.approvedAt || now };
    await fs.setDoc(ref, data);
    return { recordId, ...data };
}

export async function updateSubstituteRecord(recordId, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    await fs.updateDoc(ref, { ...patch, updatedAt: new Date().toISOString() });
    return getSubstituteRecord(recordId);
}

export async function deleteSubstituteRecord(recordId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    await fs.deleteDoc(ref);
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

export async function createPendingRequest(req) {
    const fs   = await getV2Firestore();
    const reqId = genId('req');
    const ref   = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    const data  = { ...req, createdAt: req.createdAt || new Date().toISOString() };
    await fs.setDoc(ref, data);
    return { reqId, ...data };
}

export async function deletePendingRequest(reqId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    await fs.deleteDoc(ref);
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

export async function subscribePendingRequests(callback) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const q   = fs.query(col, fs.orderBy('createdAt', 'desc'));
    return fs.onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ reqId: d.id, ...d.data() })));
    });
}

export async function subscribeSubstituteRecords(callback) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const q   = fs.query(col, fs.orderBy('createdAt', 'desc'));
    return fs.onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ recordId: d.id, ...d.data() })));
    });
}

export async function subscribeOperationLogs(callback, { limit: lim = 200 } = {}) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.logsCol());
    const q   = fs.query(col, fs.orderBy('timestamp', 'desc'), fs.limit(lim));
    return fs.onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ logId: d.id, ...d.data() })));
    });
}
