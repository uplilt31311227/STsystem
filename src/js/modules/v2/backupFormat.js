/**
 * V2 雲端完整備份檔：格式、驗證、還原計畫（純函式，無 DOM／Firebase 依賴，node 可單元測試）
 *
 * 取代過去「匯出完整備份」匯出 V1 本機資料（dataManager.exportToStorage）的行為——那份檔案在 V2
 * 下不含任何雲端調代課紀錄（審計 ux C1），還原也只寫回本機、重整後被雲端蓋回（ux H8）。
 *
 * 檔案格式（formatVersion 1）：
 * {
 *   format: 'stsystem-cloud-backup',
 *   formatVersion: 1,
 *   meta: {
 *     schoolId, exportedAt(ISO), exportedBy:{uid,email,name,role,teacherId}, currentSemester,
 *     counts:{ teachers, schedules, scheduleImports, substituteRecords, substituteRecordDetails,
 *              pendingRequests, pendingRequestDetails, configDocs },
 *     excluded:[ 不在備份內的資料清單 ],
 *     contentHash: 'sha256:<hex>'    // 對下列六個區段（固定順序）的 JSON 計算，供還原前檢查檔案完整
 *   },
 *   config:           { main: {...}|null, settlement: {...}|null, grade9?: {...} },   // grade9 為 formatVersion 2 新增，沒有該文件時整個鍵省略
 *   teachers:         [ { id, data } ],
 *   schedules:        [ { id: semesterId, data } ],
 *   scheduleImports:  [ { semesterId, id, data }  ]   // 只有中繼資料，不含快照
 *   substituteRecords:[ { id, data, private: {...}|null } ],
 *   pendingRequests:  [ { id, data, private: {...}|null } ]
 * }
 * formatVersion：備份含 config/grade9 時寫 2，否則寫 1（舊版系統仍讀得懂沒有新內容的備份）；
 * 本系統兩種都能讀（舊格式備份沒有 grade9，還原時不動雲端的九年級設定）。
 * data 是 Firestore 文件的原始欄位（不含 id）；private 是 private/detail 子文件。
 */

import { computeFingerprint } from '../scheduleImportHistory.js';
import { dateToSemesterId, semesterOrdinal } from './semesterUtils.js';

const SEMESTER_STD_RE = /^[0-9]{2,3}-[12]$/;

export const BACKUP_FORMAT = 'stsystem-cloud-backup';
/** 本系統能讀的最高格式版本（2：新增 config/grade9）。 */
export const BACKUP_FORMAT_VERSION = 2;

/** 備份檔刻意不含的資料（寫進 meta.excluded，使用者與日後的人都看得到） */
export const BACKUP_EXCLUDED = Object.freeze([
    'operationLogs（稽核日誌，rules 禁止寫入，不能還原）',
    'userMappings／emailIndex／joinAttempts（與登入帳號綁定，不在備份內；還原時預設也不恢復教師的登入綁定，信箱需由教務主任在還原預覽勾選，或之後到教師管理重新填回）',
    'archives（封存紀錄，寫入後不可改）',
    'scheduleImports 的快照內容（只保留中繼資料以控制檔案大小）',
    'V1 個人雲端備份（users/{uid}）',
]);

const SECTION_KEYS = ['config', 'teachers', 'schedules', 'scheduleImports', 'substituteRecords', 'pendingRequests'];

/** 補齊缺漏區段並固定順序，確保雜湊與序列化結果穩定。 */
export function normalizeSections(sections = {}) {
    const cfg = sections.config || {};
    // grade9 只在有內容時才出現：舊格式備份的內容雜湊是對「只有 main、settlement」的 config 算的，
    // 補一個 grade9: null 會讓舊備份的雜湊對不上而被拒絕還原。
    const config = { main: cfg.main ?? null, settlement: cfg.settlement ?? null };
    if (cfg.grade9) config.grade9 = cfg.grade9;
    return {
        config,
        teachers: Array.isArray(sections.teachers) ? sections.teachers : [],
        schedules: Array.isArray(sections.schedules) ? sections.schedules : [],
        scheduleImports: Array.isArray(sections.scheduleImports) ? sections.scheduleImports : [],
        substituteRecords: Array.isArray(sections.substituteRecords) ? sections.substituteRecords : [],
        pendingRequests: Array.isArray(sections.pendingRequests) ? sections.pendingRequests : [],
    };
}

/** 各集合筆數。 */
export function countSections(sections) {
    const s = normalizeSections(sections);
    return {
        teachers: s.teachers.length,
        schedules: s.schedules.length,
        scheduleImports: s.scheduleImports.length,
        substituteRecords: s.substituteRecords.length,
        substituteRecordDetails: s.substituteRecords.filter(r => r && r.private).length,
        pendingRequests: s.pendingRequests.length,
        pendingRequestDetails: s.pendingRequests.filter(r => r && r.private).length,
        configDocs: (s.config.main ? 1 : 0) + (s.config.settlement ? 1 : 0) + (s.config.grade9 ? 1 : 0),
    };
}

async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    let subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        // node 後備（瀏覽器一律有 Web Crypto）
        const nodeCrypto = await import('node:crypto');
        return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
    }
    const buf = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 對六個區段（固定順序）計算內容雜湊。 */
export async function computeContentHash(sections) {
    const s = normalizeSections(sections);
    const ordered = {};
    for (const k of SECTION_KEYS) ordered[k] = s[k];
    return `sha256:${await sha256Hex(JSON.stringify(ordered))}`;
}

/**
 * 組出備份檔物件。
 * @param {Object} p
 * @param {string} p.schoolId
 * @param {string} [p.exportedAt] ISO，預設現在
 * @param {Object|null} [p.exportedBy]
 * @param {string|null} [p.currentSemester]
 * @param {Object} p.sections 見檔頭
 */
export async function buildBackupFile({ schoolId, exportedAt, exportedBy = null, currentSemester = null, sections } = {}) {
    if (!schoolId) throw new Error('buildBackupFile: 缺少 schoolId');
    const s = normalizeSections(sections);
    return {
        format: BACKUP_FORMAT,
        formatVersion: s.config.grade9 ? 2 : 1,
        meta: {
            schoolId,
            exportedAt: exportedAt || new Date().toISOString(),
            exportedBy: exportedBy || null,
            currentSemester: currentSemester || null,
            counts: countSections(s),
            excluded: [...BACKUP_EXCLUDED],
            contentHash: await computeContentHash(s),
        },
        ...s,
    };
}

/** 序列化（縮排 1 格，兼顧可讀與檔案大小）。 */
export function serializeBackup(backup) {
    return JSON.stringify(backup, null, 1);
}

/** 備份檔下載檔名，例如 STsystem_雲端備份_inhu_2026-11-11.json */
export function backupFileName(schoolId, dateStr) {
    const safe = String(schoolId || 'school').replace(/[^A-Za-z0-9_-]/g, '_');
    return `STsystem_雲端備份_${safe}_${dateStr}.json`;
}

/* ===== 驗證 ===== */

/** 判斷一個已解析的 JSON 屬於哪一種檔案。 */
export function detectBackupKind(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'unknown';
    if (obj.format === BACKUP_FORMAT) return 'cloud';
    // V1 本機匯出（dataManager.exportToStorage）：沒有 format 欄位，帶 scheduleData 與 substituteRecords 陣列
    if (Array.isArray(obj.scheduleData) && Array.isArray(obj.substituteRecords) && !obj.meta) return 'v1-local';
    // 學期封存檔（v2-app collectSemesterArchiveData）：meta.semesterId + schedule + substituteRecords
    if (obj.meta && typeof obj.meta === 'object' && obj.meta.semesterId && Array.isArray(obj.substituteRecords)) return 'semester-archive';
    return 'unknown';
}

const KIND_MESSAGES = {
    'v1-local':
        '這是舊版（V1 本機模式）匯出的備份檔，格式與雲端備份不同，無法在目前的雲端模式還原，也不會寫入任何資料。\n' +
        '若要把舊版資料帶進雲端：請在存有舊版資料的那台電腦／瀏覽器上，到「教師管理」頁籤使用「V1 資料遷移」（教務主任限定，會自動偵測並匯入，不需要選這個檔案）。',
    'semester-archive':
        '這是「學期封存」匯出的檔案，用於留存歷史資料，不是完整備份，不能用來還原。',
    unknown:
        '無法辨識這個檔案。請選擇由「匯出完整備份」產生的雲端備份檔（檔名為 STsystem_雲端備份_…json）。',
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function checkEntries(list, label, errors, { needPrivate = false, needSemester = false } = {}) {
    if (!Array.isArray(list)) { errors.push(`${label} 不是陣列`); return; }
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!isObj(e)) { errors.push(`${label}[${i}] 格式錯誤`); return; }
        if (typeof e.id !== 'string' || !e.id || e.id.includes('/')) { errors.push(`${label}[${i}] 的 id 不合法`); return; }
        if (needSemester && (typeof e.semesterId !== 'string' || !e.semesterId)) { errors.push(`${label}[${i}] 缺少 semesterId`); return; }
        const key = needSemester ? `${e.semesterId}/${e.id}` : e.id;
        if (seen.has(key)) { errors.push(`${label} 內有重複的 id：${key}`); return; }
        seen.add(key);
        if (!isObj(e.data)) { errors.push(`${label}[${i}] 缺少 data`); return; }
        if (needPrivate && e.private != null && !isObj(e.private)) { errors.push(`${label}[${i}] 的 private 格式錯誤`); return; }
    }
}

/**
 * 驗證一份已解析的備份物件。
 * @param {any} obj JSON.parse 的結果
 * @param {{schoolId:string}} ctx 目前學校
 * @returns {Promise<{ok:boolean, kind:string, message:string, errors:string[], backup:Object|null}>}
 *   ok=false 時 message 是可直接顯示給使用者的說明（不含 HTML）。
 */
export async function validateBackupFile(obj, { schoolId } = {}) {
    const kind = detectBackupKind(obj);
    if (kind !== 'cloud') {
        return { ok: false, kind, message: KIND_MESSAGES[kind] || KIND_MESSAGES.unknown, errors: [], backup: null };
    }
    const errors = [];
    const fv = obj.formatVersion;
    if (!Number.isInteger(fv) || fv < 1) {
        return { ok: false, kind, message: '備份檔缺少有效的格式版本，無法還原。', errors: ['formatVersion 不合法'], backup: null };
    }
    if (fv > BACKUP_FORMAT_VERSION) {
        return {
            ok: false, kind,
            message: `這份備份檔的格式版本（${fv}）比目前系統能讀的版本（${BACKUP_FORMAT_VERSION}）新，請先更新系統（重新整理頁面）再試。`,
            errors: ['formatVersion 過新'], backup: null,
        };
    }
    const meta = obj.meta;
    if (!isObj(meta) || typeof meta.schoolId !== 'string' || !meta.schoolId) {
        return { ok: false, kind, message: '備份檔缺少來源學校資訊，無法確認是否屬於目前學校，已拒絕還原。', errors: ['meta.schoolId 缺漏'], backup: null };
    }
    if (schoolId && meta.schoolId !== schoolId) {
        return {
            ok: false, kind,
            message: `這份備份來自學校「${meta.schoolId}」，與目前登入的學校「${schoolId}」不同，已拒絕還原（避免把別校資料寫進這所學校）。`,
            errors: ['學校不符'], backup: null,
        };
    }

    if (!isObj(obj.config)) errors.push('config 區段缺漏');
    checkEntries(obj.teachers, 'teachers', errors);
    checkEntries(obj.schedules, 'schedules', errors);
    checkEntries(obj.scheduleImports, 'scheduleImports', errors, { needSemester: true });
    checkEntries(obj.substituteRecords, 'substituteRecords', errors, { needPrivate: true });
    checkEntries(obj.pendingRequests, 'pendingRequests', errors, { needPrivate: true });
    if (errors.length) {
        return { ok: false, kind, message: `備份檔內容不完整或格式錯誤：${errors[0]}。請重新匯出一份備份。`, errors, backup: null };
    }

    const sections = normalizeSections(obj);
    const counted = countSections(sections);
    const declared = meta.counts || {};
    const mismatched = Object.keys(counted).filter(k => declared[k] !== undefined && declared[k] !== counted[k]);
    if (mismatched.length) {
        return {
            ok: false, kind,
            message: `備份檔的筆數與檔頭記載不符（${mismatched.join('、')}），檔案可能被截斷或修改，已拒絕還原。`,
            errors: mismatched.map(k => `counts.${k}`), backup: null,
        };
    }
    if (meta.contentHash) {
        const actual = await computeContentHash(sections);
        if (actual !== meta.contentHash) {
            return {
                ok: false, kind,
                message: '備份檔的內容與匯出時的檢查碼不符，檔案可能被修改或損毀，已拒絕還原。',
                errors: ['contentHash 不符'], backup: null,
            };
        }
    }
    return { ok: true, kind, message: '', errors: [], backup: { ...obj, ...sections } };
}

/** 解析文字並驗證；JSON 語法錯誤也回傳統一形狀。 */
export async function parseAndValidateBackupText(text, ctx) {
    let obj;
    try {
        obj = JSON.parse(text);
    } catch (_) {
        return { ok: false, kind: 'unknown', message: '檔案不是有效的 JSON，無法解析。', errors: ['JSON 語法錯誤'], backup: null };
    }
    return validateBackupFile(obj, ctx);
}

/* ===== 還原計畫 ===== */

/** 這些欄位由文件路徑決定，rules 也禁止出現在 substituteRecords／pendingRequests 的 create 資料裡。 */
export const RESERVED_ID_FIELDS = Object.freeze(['recordId', 'reqId']);

/** 還原寫入前先剔除保留欄位。 */
export function stripReservedFields(data) {
    const out = { ...data };
    for (const k of RESERVED_ID_FIELDS) delete out[k];
    return out;
}

/**
 * 一筆調代課紀錄在目前 rules（v2.18）下能不能被還原（director 身分）。
 *   - semesterId 等於目前學期，且 date 依台灣學制推算也是該學期：可（v2.18 起 rules 要求「目前學期」的紀錄
 *     date 與 semesterId 一致；目前學期不是標準格式時維持只比對 semesterId）
 *   - 標明 isLegacy 且帶 migratedFrom（V1 遷移紀錄）：可（rules 對 director 豁免學期鎖）
 *   - 其餘（非目前學期的紀錄，含相鄰學期；或目前學期但日期對不上；缺 semesterId）：不可。
 *     相鄰學期雖然 rules 允許新增，但還原是整批提交，一筆被拒（例如該學期已封存）會讓整批失敗，保守起見不還原。
 * @returns {'ok'|'historical'|'no-semester'}
 */
export function classifyRecordForRestore(data, currentSemesterId) {
    const sid = data && data.semesterId;
    if (typeof sid !== 'string' || !sid) return 'no-semester';
    if (sid === currentSemesterId) {
        if (!SEMESTER_STD_RE.test(currentSemesterId)) return 'ok';
        return dateToSemesterId(data.date) === sid ? 'ok' : 'historical';
    }
    if (data.isLegacy === true && data.migratedFrom) return 'ok';
    return 'historical';
}

/**
 * 由「雲端現況的區段」（collectCloudBackupSections 的結果）整理出 planRestore 需要的雲端摘要。
 * 預覽與正式還原都走這個函式，確保兩者看到的是同一種口徑。
 */
export function cloudStateFromSections(sections) {
    const s = normalizeSections(sections);
    const schedules = {};
    for (const sc of s.schedules) {
        const d = sc.data || {};
        const entries = Array.isArray(d.scheduleData) ? d.scheduleData.length : 0;
        const v = Number(d.version);
        schedules[sc.id] = {
            exists: true,
            entries,
            empty: entries === 0 && !(d.teachers && d.teachers.length) && !(d.classes && d.classes.length),
            fingerprint: computeFingerprint(d.scheduleData),
            version: Number.isFinite(v) && v > 0 ? Math.floor(v) : 0,
            updatedAt: d.updatedAt || null,
        };
    }
    return {
        // 以「已從伺服器讀到的」config/main 為準；呼叫端不要改用記憶體裡的學期狀態
        currentSemester: s.config.main && typeof s.config.main.currentSemester === 'string' && s.config.main.currentSemester ? s.config.main.currentSemester : null,
        teachers: s.teachers.map(t => ({ id: t.id, email: t.data && t.data.email ? t.data.email : null })),
        configMainExists: !!s.config.main,
        settlement: s.config.settlement || null,
        grade9: s.config.grade9 || null,
        schedules,
        recordIds: s.substituteRecords.map(r => r.id),
        pendingIds: s.pendingRequests.map(r => r.id),
    };
}

/**
 * 還原計畫用的「目前學期」：取已從伺服器讀到的 config/main.currentSemester；雲端沒有 config/main 時
 * （還原會先把它建立回來）退而取備份檔內 config/main 的值。都沒有則回傳 null（呼叫端應中止）。
 */
export function resolveCurrentSemester(cloud, backup) {
    if (cloud && cloud.currentSemester) return cloud.currentSemester;
    const m = backup && backup.config && backup.config.main;
    return m && typeof m.currentSemester === 'string' && m.currentSemester ? m.currentSemester : null;
}

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 產生還原計畫（只比對、不寫入）。
 * @param {Object} p
 * @param {Object} p.backup 已通過 validateBackupFile 的備份
 * @param {Object} p.cloud  雲端現況摘要：
 *   {
 *     teachers: [{id, email}],
 *     configMainExists: boolean,
 *     settlement: object|null,
 *     schedules: { [semesterId]: { exists, empty, fingerprint, version, updatedAt, entries } },
 *     recordIds: string[], pendingIds: string[]
 *   }
 * @param {string} p.currentSemesterId
 * @param {boolean} [p.restoreEmailIndex=false] 是否連同補回教師的 emailIndex（登入綁定）。
 *   預設 false：教師檔補回、但不恢復登入綁定——已被刪除（身分撤銷）的教師不應因還原而自動重新取得登入資格，
 *   需使用者在預覽中逐一看過名單、明確勾選才補（P3 身分撤銷不被備份還原繞過）。
 */
/**
 * 教師信箱正規化：與 createTeacher／updateTeacher／emailIndexDoc 的規則一致（trim 後轉小寫）。
 * 非字串（物件、數字…）一律視為無信箱，避免 String() 拋例外或產生 emailIndex/[object object]。
 * @returns {string|null} 正規化後的信箱；無信箱回傳 null
 */
export function normalizeTeacherEmail(email) {
    if (typeof email !== 'string') return null;
    return email.trim().toLowerCase() || null;
}

/**
 * 教師檔還原時允許寫入的欄位（審計 PL-10a）。這份白名單是「前端實際會寫的教師欄位」的聯集
 * （createTeacher／updateTeacher／authGuardV2）：
 *   name、email、domains、homeroomClass、role、partTime、createdAt、updatedAt、authProvider；
 * 同時也涵蓋 firestore.rules v2.16 的組長改教師檔欄位白名單（domains／homeroomClass／partTime／updatedAt）。
 * 注意 rules 對教師檔 create 本身沒有欄位白名單（v2.16 只限制組長的 patch），所以這裡不是複製 rules，
 * 而是還原端自己的保守過濾。備份檔若被手改或來自較新版本而帶了其他欄位，一律剔除，不原樣寫回雲端。
 */
export const TEACHER_RESTORE_FIELDS = Object.freeze(['name', 'email', 'domains', 'homeroomClass', 'role', 'partTime', 'createdAt', 'updatedAt', 'authProvider']);

/** 只保留白名單內的教師欄位。 */
export function pickTeacherFields(data) {
    const out = {};
    if (!data || typeof data !== 'object') return out;
    // 依 data 自己的欄位順序走一遍、只留白名單內的（保持欄位順序與原文件一致）
    for (const k of Object.keys(data)) {
        if (TEACHER_RESTORE_FIELDS.includes(k) && data[k] !== undefined) out[k] = data[k];
    }
    return out;
}

/** 設定文件的 updatedAt 轉毫秒；缺漏或無法解析回 null。 */
function tsOf(doc) {
    const t = doc && typeof doc.updatedAt === 'string' ? Date.parse(doc.updatedAt) : NaN;
    return Number.isFinite(t) ? t : null;
}

/**
 * 備份裡的設定比雲端舊嗎（以 updatedAt 判斷）？雲端沒有 updatedAt 視為不比較（回 false，沿用原行為）；
 * 雲端有、備份沒有或無法解析，保守視為備份較舊。
 */
export function isBackupConfigOlder(backupDoc, cloudDoc) {
    const c = tsOf(cloudDoc);
    if (c === null) return false;
    const b = tsOf(backupDoc);
    return b === null || b < c;
}

/**
 * 預覽之後目前學期變了嗎（審計 PL-10b）：正式執行前重算計畫時比對。不同就必須中止並請使用者重新預覽，
 * 否則預覽看到的「將還原」清單是依舊學期算的。
 */
export function semesterChangedSincePreview(previewSemesterId, freshSemesterId) {
    return !!previewSemesterId && !!freshSemesterId && previewSemesterId !== freshSemesterId;
}

export function planRestore({ backup, cloud, currentSemesterId, restoreEmailIndex = false, overwriteNewerSettlement = false }) {
    const b = normalizeSections(backup);
    const plan = {
        currentSemesterId,
        teachers: { backup: b.teachers.length, cloud: cloud.teachers.length, create: [], createList: [], restoreEmailIndex: !!restoreEmailIndex, existingId: 0, emailTaken: [], emailCleared: [] },
        config: { main: 'none', settlement: 'none', settlementBackupOlder: false, grade9: 'none' },
        schedules: [],
        records: { backup: b.substituteRecords.length, cloud: cloud.recordIds.length, create: [], exists: 0, historical: 0, noSemester: 0, mismatch: 0, mismatchSkipped: 0, relabel: {} },
        pending: { backup: b.pendingRequests.length, cloud: cloud.pendingIds.length, exists: 0, notRestored: 0 },
        scheduleImports: { backup: b.scheduleImports.length },
        notRestored: [],
    };

    // 教師：以 id 為準補缺；email 已被另一位雲端教師使用者則略過（避免 emailIndex 指向錯人）
    const cloudIds = new Set(cloud.teachers.map(t => t.id));
    const cloudEmails = new Set(cloud.teachers.map(t => normalizeTeacherEmail(t.email)).filter(Boolean));
    for (const t of b.teachers) {
        if (cloudIds.has(t.id)) { plan.teachers.existingId++; continue; }
        const email = normalizeTeacherEmail(t.data.email) || '';
        if (email && cloudEmails.has(email)) { plan.teachers.emailTaken.push(t.id); continue; }
        plan.teachers.create.push(t.id);
        plan.teachers.createList.push({ id: t.id, name: String(t.data.name || t.id), role: String(t.data.role || ''), email: email || '' });
    }

    // 沒有勾選恢復登入綁定時，補回的教師檔 email 一律寫成 null（原信箱只留在預覽與結果訊息）：
    // rules 的成員判定只看「mapping 指向的教師檔 email 是否等於登入 email」，若把原信箱寫回，
    // 被刪除（身分撤銷）的人就能自行建立 mapping 或靠殘留 mapping 自動復權。
    if (!plan.teachers.restoreEmailIndex) {
        plan.teachers.emailCleared = plan.teachers.createList.filter(t => t.email).map(t => ({ id: t.id, name: t.name, email: t.email }));
    }

    // 設定
    if (b.config.main) plan.config.main = cloud.configMainExists ? 'skip-exists' : 'create';
    if (b.config.settlement) {
        if (sameJson(stripVolatile(b.config.settlement), stripVolatile(cloud.settlement))) plan.config.settlement = 'same';
        else if (cloud.settlement && isBackupConfigOlder(b.config.settlement, cloud.settlement)) {
            // PL-10d：備份比雲端舊，預設不覆寫；使用者在預覽勾選後才覆寫
            plan.config.settlementBackupOlder = true;
            plan.config.settlement = overwriteNewerSettlement ? 'overwrite' : 'skip-newer';
        } else plan.config.settlement = 'overwrite';
    }
    // PL-24：九年級畢業設定。雲端較新時不覆寫（不提供勾選：這項設定每學期都會重設，舊值沒有保留價值）
    if (b.config.grade9) {
        if (sameJson(stripVolatile(b.config.grade9), stripVolatile(cloud.grade9))) plan.config.grade9 = 'same';
        else if (!cloud.grade9) plan.config.grade9 = 'create';
        else plan.config.grade9 = isBackupConfigOlder(b.config.grade9, cloud.grade9) ? 'skip-newer' : 'overwrite';
    }

    // 課表
    for (const s of b.schedules) {
        const entries = Array.isArray(s.data.scheduleData) ? s.data.scheduleData.length : 0;
        const bkEmpty = entries === 0 && !(s.data.teachers && s.data.teachers.length) && !(s.data.classes && s.data.classes.length);
        const c = cloud.schedules[s.id] || { exists: false, empty: true, fingerprint: null };
        const item = { semesterId: s.id, entries, cloudEntries: c.entries ?? 0, action: '' };
        if (c.exists && c.fingerprint === computeFingerprint(s.data.scheduleData)) item.action = 'same';
        else if (s.id !== currentSemesterId) item.action = 'blocked-historical';
        else if (bkEmpty && !c.empty) item.action = 'blocked-empty';
        else item.action = c.exists ? 'overwrite' : 'create';
        plan.schedules.push(item);
    }

    // 調代課紀錄
    const cloudRec = new Set(cloud.recordIds);
    for (const r of b.substituteRecords) {
        if (cloudRec.has(r.id)) { plan.records.exists++; continue; }
        const cls = classifyRecordForRestore(r.data, currentSemesterId);
        if (cls === 'ok') plan.records.create.push(r.id);
        else if (cls === 'historical') {
            // 標目前學期、但日期屬別學期（v2.18 之前以舊語意寫入）：依日期重新標學期再還原。
            // 條件：推算結果在目前學期±1 內；上一學期須「確定未封存」（cloud.archivedSemesterIds 提供時才判斷，
            // 沒提供就保守略過）；下一學期不可能已封存。其餘略過並計入 mismatchSkipped。
            const sid0 = r.data && r.data.semesterId;
            if (sid0 && sid0 === currentSemesterId && SEMESTER_STD_RE.test(currentSemesterId)) {
                plan.records.mismatch++;
                const to = dateToSemesterId(r.data.date);
                const diff = to ? semesterOrdinal(to) - semesterOrdinal(currentSemesterId) : NaN;
                const archivedKnown = Array.isArray(cloud.archivedSemesterIds);
                if (diff === 1 || (diff === -1 && archivedKnown && !cloud.archivedSemesterIds.includes(to))) {
                    plan.records.create.push(r.id);
                    plan.records.relabel[r.id] = to;
                } else {
                    plan.records.mismatchSkipped++;
                }
            } else {
                plan.records.historical++;
            }
        }
        else plan.records.noSemester++;
    }

    // 待審申請：暫態資料，rules 要求建立時為初始狀態且 createdAt 近期，無法原樣還原
    const cloudPend = new Set(cloud.pendingIds);
    for (const p of b.pendingRequests) {
        if (cloudPend.has(p.id)) plan.pending.exists++; else plan.pending.notRestored++;
    }

    plan.notRestored = describeNotRestored(plan);
    return plan;
}

function stripVolatile(settlement) {
    if (!settlement || typeof settlement !== 'object') return null;
    const { updatedAt, updatedBy, ...rest } = settlement;
    return rest;
}

/** 組出「不會還原」的清單（每項一句話，含原因），供預覽顯示。 */
export function describeNotRestored(plan) {
    const out = [];
    const hist = plan.schedules.filter(s => s.action === 'blocked-historical');
    if (hist.length) {
        out.push(`歷史學期課表（${hist.map(s => s.semesterId).join('、')}）：安全規則只允許寫入目前學期的課表。`);
    }
    const blockedEmpty = plan.schedules.filter(s => s.action === 'blocked-empty');
    if (blockedEmpty.length) {
        out.push(`${blockedEmpty.map(s => s.semesterId).join('、')} 的備份課表是空白、雲端課表有內容：為避免清空現有課表，不覆寫。`);
    }
    if (plan.records.historical) {
        out.push(`歷史學期的調代課紀錄 ${plan.records.historical} 筆：還原只放行日期屬於目前學期的紀錄，非目前學期的（含相鄰學期）與日期對不上學期的不還原。`);
    }
    if (plan.records.mismatch) {
        const n = Object.keys(plan.records.relabel).length;
        out.push(`日期與學期不一致的調代課紀錄 ${plan.records.mismatch} 筆（標為目前學期、日期卻屬別的學期）：${n} 筆會依日期改標學期後還原，${plan.records.mismatchSkipped} 筆略過（超出目前學期前後一學期、或上一學期是否已封存無法確認）。建議先執行 scripts/realign-semester-id.js 校正雲端資料。`);
    }
    if (plan.records.noSemester) {
        out.push(`缺少學期欄位的調代課紀錄 ${plan.records.noSemester} 筆：安全規則要求紀錄必須帶學期。`);
    }
    if (plan.pending.notRestored) {
        out.push(`待審申請 ${plan.pending.notRestored} 筆：屬暫態資料，規則要求建立時必須是初始狀態且時間為近期，無法原樣還原（仍保存在備份檔內供查閱）。`);
    }
    if (plan.teachers.emailTaken.length) {
        out.push(`教師 ${plan.teachers.emailTaken.length} 位：其 email 已被雲端另一位教師使用，略過以免登入綁定錯亂。`);
    }
    if (plan.teachers.create.length && !plan.teachers.restoreEmailIndex) {
        out.push(`教師的登入信箱與登入綁定（emailIndex）：補回的 ${plan.teachers.create.length} 位教師只恢復教師檔，信箱欄位會留空、不恢復登入綁定，他們暫時無法登入；如需恢復請在預覽勾選，或之後由教務主任到教師管理逐一填回信箱。`);
    }
    if (plan.config.settlement === 'skip-newer') {
        out.push('月結算設定：雲端的設定比備份檔新，預設不覆寫（避免把較新的上課週數、逐人門檻改回舊值）；要用備份檔的設定請在預覽勾選覆寫。');
    }
    if (plan.config.grade9 === 'skip-newer') {
        out.push('九年級畢業設定（config/grade9）：雲端的設定比備份檔新，不覆寫。');
    }
    if (plan.config.main === 'skip-exists') {
        out.push('學校基本設定（config/main）：雲端已有設定，不覆寫（避免誤切目前學期或改動主任白名單）。');
    }
    if (plan.scheduleImports.backup) {
        out.push(`課表匯入紀錄 ${plan.scheduleImports.backup} 筆：匯入紀錄寫入後不可修改，且備份只含中繼資料，不還原。`);
    }
    out.push('操作日誌、使用者帳號綁定（userMappings）、封存紀錄：不在備份範圍內。');
    return out;
}

/**
 * 正式執行前重算的計畫，補回的教師只限預覽列過的教師 id。
 * 重算後多出預覽沒列的教師（預覽之後名冊又有變動）一律不補回，回報在 dropped。
 * @returns {{plan:Object, dropped:string[]}}
 */
export function restrictPlanToPreview(freshPlan, previewPlan) {
    const listed = new Set(previewPlan.teachers.create);
    const dropped = freshPlan.teachers.create.filter(id => !listed.has(id));
    if (!dropped.length) return { plan: freshPlan, dropped };
    const plan = { ...freshPlan, teachers: { ...freshPlan.teachers } };
    plan.teachers.create = freshPlan.teachers.create.filter(id => listed.has(id));
    plan.teachers.createList = freshPlan.teachers.createList.filter(t => listed.has(t.id));
    plan.teachers.emailCleared = freshPlan.teachers.emailCleared.filter(t => listed.has(t.id));
    plan.notRestored = describeNotRestored(plan);
    return { plan, dropped };
}

/** 這是不是「連不到伺服器」類的讀取失敗（SDK 的英文訊息不該直接給使用者看）。 */
export function isServerUnreachableError(err) {
    if (!err) return false;
    const code = String(err.code || '').replace(/^firestore\//, '');
    if (code === 'unavailable' || code === 'deadline-exceeded') return true;
    const msg = String(err.message || err);
    return /Failed to get documents? from server/i.test(msg) || /client is offline/i.test(msg);
}

const GENERIC_WHY = {
    export: '匯出失敗',
    'before-clear': '清除前備份失敗',
    'restore-read': '讀取雲端現況失敗',
    'restore-backup': '還原前備份失敗',
};

/**
 * 備份相關流程的失敗說明（繁體中文，不含 SDK 英文原文）。
 * @param {unknown} err
 * @param {'export'|'before-clear'|'restore-read'|'restore-backup'} kind
 */
export function backupErrorMessage(err, kind) {
    if (isServerUnreachableError(err)) {
        const retry = '請稍候約一分鐘再試一次。';
        switch (kind) {
            case 'before-clear': return `無法連到伺服器，備份沒有產生，所以清除已中止，資料沒有被刪除。${retry}`;
            case 'restore-backup': return `無法連到伺服器，還原前的自動備份沒有產生，所以還原已中止，沒有寫入任何資料。${retry}`;
            case 'restore-read': return `無法連到伺服器，讀不到雲端現況，還原沒有開始，沒有寫入任何資料。${retry}`;
            default: return `無法連到伺服器，備份沒有產生。${retry}`;
        }
    }
    return `${GENERIC_WHY[kind] || '備份失敗'}：${friendlyErrorDetail(err)}`;
}

const CJK_RE = /[㐀-鿿]/;
const CODE_TEXT = {
    'permission-denied': '安全規則拒絕了這次寫入（權限不足，或資料不符合規則）',
    unavailable: '無法連到伺服器',
    'deadline-exceeded': '伺服器回應逾時',
    aborted: '寫入與其他人的變更衝突，已中止',
    'failed-precondition': '資料狀態已改變，不符合寫入的前置條件',
    'already-exists': '資料已存在',
    'not-found': '找不到要寫入的資料',
    'resource-exhausted': '超過使用額度或單次寫入上限',
    unauthenticated: '登入已失效，請重新登入',
    'invalid-argument': '資料格式不被接受',
    cancelled: '操作被取消',
    internal: '伺服器內部錯誤',
};

/**
 * 把例外轉成給使用者看的中文（審計 PL-10c）：SDK 的英文訊息不直接顯示。
 * 訊息本身含中文（本系統自己丟的錯誤）原樣保留；否則依 Firestore 錯誤代碼對照，對不上就只顯示代碼。
 */
export function friendlyErrorDetail(err) {
    const msg = String((err && err.message) || '');
    if (msg && CJK_RE.test(msg)) return msg;
    const code = String((err && err.code) || '').replace(/^firestore\//, '');
    if (CODE_TEXT[code]) return CODE_TEXT[code];
    return code ? `發生未預期的錯誤（代碼：${code}）` : '發生未預期的錯誤';
}

/** 這份計畫實際會寫入多少東西（0 代表沒有需要還原的）。 */
export function countPlannedWrites(plan) {
    return plan.teachers.create.length
        + (plan.config.main === 'create' ? 1 : 0)
        + (plan.config.settlement === 'overwrite' ? 1 : 0)
        + (plan.config.grade9 === 'create' || plan.config.grade9 === 'overwrite' ? 1 : 0)
        + plan.schedules.filter(s => s.action === 'overwrite' || s.action === 'create').length
        + plan.records.create.length;
}

/** 預覽表格資料：每列一個集合。 */
export function summarizeRestorePlan(plan) {
    const scheduleWritable = plan.schedules.filter(s => s.action === 'overwrite' || s.action === 'create').length;
    return [
        { label: '教師名冊', backup: plan.teachers.backup, cloud: plan.teachers.cloud, willRestore: plan.teachers.create.length, note: '只補回雲端沒有的教師' },
        { label: '學校設定', backup: (plan.config.main !== 'none' ? 1 : 0) + (plan.config.settlement !== 'none' ? 1 : 0) + (plan.config.grade9 !== 'none' ? 1 : 0), cloud: null,
          willRestore: (plan.config.main === 'create' ? 1 : 0) + (plan.config.settlement === 'overwrite' ? 1 : 0) + (plan.config.grade9 === 'create' || plan.config.grade9 === 'overwrite' ? 1 : 0),
          note: '月結算設定與九年級設定以備份為準（雲端較新的預設不覆寫）；基本設定雲端已有則不動' },
        { label: '學期課表', backup: plan.schedules.length, cloud: null, willRestore: scheduleWritable, note: '只有目前學期可寫入，會取代現有課表（先自動留備份）' },
        { label: '調代課紀錄', backup: plan.records.backup, cloud: plan.records.cloud, willRestore: plan.records.create.length, note: '只補回雲端沒有、且規則允許的紀錄' },
        { label: '待審申請', backup: plan.pending.backup, cloud: plan.pending.cloud, willRestore: 0, note: '不還原（暫態資料）' },
    ];
}
