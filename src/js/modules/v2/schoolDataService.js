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

/* ===== Email Index（首登 email → teacherId 配對，Stage 0 §3.4a） =====
 * schools/{schoolId}/emailIndex/{emailKey}：emailKey = 教師登入 email 小寫。
 * 文件只有 { teacherId }，不含姓名等個資。規則只開放 get（查自己那一份），不開放 list，
 * 故一律用「已知 email 查單一文件」的方式讀取，不會有整包查詢的路徑。
 * 由 createTeacher / updateTeacher(email 異動) / deleteTeacher 同步維護——
 * 驗收修復 S7：teachers 文件與 emailIndex 文件的寫入改用 writeBatch 原子提交，
 * 避免「teachers 寫成功、emailIndex 寫失敗」這種半套狀態（索引與名冊不同步，
 * 會讓該教師首登配對失敗，且不易察覺）。
 */

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

    const batch = fs.writeBatch(fs.db);
    batch.set(ref, data);
    if (data.email) {
        batch.set(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(data.email)), { teacherId });
    }
    await batch.commit();

    return { teacherId, ...data };
}

export async function updateTeacher(teacherId, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));

    const clean = { ...patch, updatedAt: new Date().toISOString() };
    const emailChanging = Object.prototype.hasOwnProperty.call(clean, 'email');
    let oldEmail = null;
    if (emailChanging) {
        clean.email = clean.email ? clean.email.toLowerCase().trim() : null;
        // email 有異動：需要先讀舊值才能刪掉舊的 emailIndex 條目（新舊 email 可能不同，
        // 也可能被設為 null 解除綁定）。非 email 異動的呼叫（role/domains/authProvider 等
        // 高頻寫入）不需要這次額外讀取，維持原本零讀取開銷。
        const before = await getTeacher(teacherId);
        oldEmail = before?.email || null;
    }

    const batch = fs.writeBatch(fs.db);
    batch.update(ref, clean);
    if (emailChanging) {
        // §3.4a：emailIndex 由 createTeacher / updateTeacher(email 異動) / deleteTeacher
        // 集中維護，所有呼叫端（assignEmail、importRosterCsv 等）不需各自處理。
        if (oldEmail && oldEmail !== clean.email) {
            batch.delete(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(oldEmail)));
        }
        if (clean.email) {
            batch.set(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(clean.email)), { teacherId });
        }
    }
    await batch.commit();

    return getTeacher(teacherId);
}

export async function deleteTeacher(teacherId) {
    const fs       = await getV2Firestore();
    const ref      = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));
    const existing = await getTeacher(teacherId);

    const batch = fs.writeBatch(fs.db);
    batch.delete(ref);
    if (existing?.email) {
        batch.delete(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(existing.email)));
    }
    await batch.commit();
}

/** 查自己那一份 email → teacherId 索引。回傳 { teacherId } 或 null（查不到）。 */
export async function getEmailIndexEntry(email) {
    if (!email) return null;
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(email));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

/* ===== Join Attempts（login_denied 改道，Stage 0 §3.4b） =====
 * schools/{schoolId}/joinAttempts/{uid}：doc id 綁 uid，一人一份、可覆寫，
 * 天然限制灌爆量。規則只允許欄位 email/attemptedAt/reason，且驗收修復 S3 後
 * email/attemptedAt/reason 三欄一律要求 `is string`（見 firestore.rules）——
 * 呼叫端一律寫入字串（email 缺省時寫空字串而非 null，避免規則的型別檢查擋下寫入）。
 */
export async function upsertJoinAttempt(uid, { email, reason } = {}) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.joinAttemptDoc(uid));
    const data = {
        // 驗收修復 N3：規則要求 email.size() < 200（firestore.rules），這裡先 slice(0,190)
        // 留一點安全邊界（中英文混雜時 .size() 是 UTF-8 byte 數，不是字元數，190 字元的
        // email 字串換算成 byte 數必然遠低於 200——email 本身幾乎不會出現多位元組字元，
        // 這裡的邊界純粹是防止極端輸入把寫入直接擋在規則層，而不是依賴精準的位元組換算）。
        email: (typeof email === 'string' ? email : '').slice(0, 190),
        attemptedAt: new Date().toISOString(),
        reason: typeof reason === 'string' && reason ? reason : 'no_teacher_match',
    };
    await fs.setDoc(ref, data);
    return data;
}

/**
 * 一次性讀取全部「登入遭拒」紀錄（供 approver 在操作日誌頁瀏覽，Stage 0 驗收修復 S8）。
 * 刻意用 getDocs 而非 onSnapshot——這是低頻查閱的稽核輔助資訊，不需要即時監聽，
 * 避免額外常駐一條訂閱（呼應 §5.4「operationLogs 只在打開頁籤時才讀」的同一精神）。
 */
export async function listJoinAttempts() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.joinAttemptsCol());
    const snap = await fs.getDocs(col);
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
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

/**
 * 清除流程專用：不帶 orderBy 讀取「全部」已成立紀錄。
 * orderBy('createdAt') 會把缺該欄位的舊文件排除在查詢結果外（Firestore 對排序欄位的既有
 * 行為），一般列表使用場景可接受，但「清除所有資料」必須刪光每一筆、不能漏掉排序鍵缺欄位
 * 的舊資料，故另開此函式；不動既有 listSubstituteRecords()，其他呼叫端仍需要依 createdAt
 * 排序的列表。
 */
export async function listAllSubstituteRecordsForClear() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const snap = await fs.getDocs(col);
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
 * 刪除紀錄的私有明細子文件（假別／事由）。批次清除（如「清除所有資料」）需在刪除父文件
 * 前先呼叫，避免留下無父文件可依附的孤兒 private/detail。文件不存在時 deleteDoc 為 no-op，
 * 呼叫端不必先判斷該筆紀錄是否真的有敏感欄位。
 */
export async function deleteSubstituteRecordDetail(recordId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId));
    await fs.deleteDoc(ref);
}

/**
 * 把待刪除的 doc 參照分塊、依序用 writeBatch 提交。
 * Firestore 單一 batch 上限 500 筆寫入，這裡用 400 留安全邊界；分塊之間循序 await（不並行
 * 送出下一塊），避免「清除所有資料」對上百筆文件同時發動大量併發寫入請求。
 * 對不存在的文件呼叫 batch.delete() 是 no-op（與既有的單筆 deleteDoc 行為一致），呼叫端不必
 * 先判斷文件是否存在。
 */
async function batchDeleteRefs(fs, refs) {
    const CHUNK_SIZE = 400;
    for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
        const batch = fs.writeBatch(fs.db);
        refs.slice(i, i + CHUNK_SIZE).forEach(ref => batch.delete(ref));
        await batch.commit();
    }
}

/**
 * 批次刪除多筆已成立紀錄（含各自的 private/detail 子文件），供「清除所有資料」使用。
 * 取代原本「每筆各自 Promise.all 兩次 deleteDoc」的寫法（驗收缺陷 #7：無批次上限、
 * 百筆併發）；改用 writeBatch 分塊循序提交，見 batchDeleteRefs()。
 */
export async function deleteSubstituteRecordsBatch(recordIds) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) return;
    const fs   = await getV2Firestore();
    const refs = [];
    for (const id of recordIds) {
        refs.push(fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(id)));
        refs.push(fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(id)));
    }
    await batchDeleteRefs(fs, refs);
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

/** 清除流程專用：不帶 orderBy 讀取「全部」待審請求。理由同 listAllSubstituteRecordsForClear()。 */
export async function listAllPendingRequestsForClear() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const snap = await fs.getDocs(col);
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

/** 刪除請求的私有明細子文件。行為與 deleteSubstituteRecordDetail 相同，見該處註解。 */
export async function deletePendingRequestDetail(reqId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(reqId));
    await fs.deleteDoc(ref);
}

/**
 * 批次刪除多筆待審請求（含各自的 private/detail 子文件），供「清除所有資料」使用。
 * 行為與 deleteSubstituteRecordsBatch 相同，見該處註解。
 */
export async function deletePendingRequestsBatch(reqIds) {
    if (!Array.isArray(reqIds) || reqIds.length === 0) return;
    const fs   = await getV2Firestore();
    const refs = [];
    for (const id of reqIds) {
        refs.push(fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(id)));
        refs.push(fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(id)));
    }
    await batchDeleteRefs(fs, refs);
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
