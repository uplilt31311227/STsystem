/**
 * 課表匯入紀錄（匯入日期 + 版本紀錄 + 還原）的共用純邏輯模組
 *
 * V1（localStorage）與 V2（Firestore imports 子集合）共用同一份紀錄形狀：
 *   {
 *     id, versionNo, importedAt(ISO), source: 'file' | 'restore',
 *     restoredFromVersion?, fileName,
 *     counts: { entries, classes, teachers, skipped },
 *     fingerprint, importedBy: { name, teacherId } | null
 *   }
 * 「中繼資料」不含快照；V1 的歷史清單與 V2 子集合的文件另外帶 snapshot
 * （{ scheduleData, teachers, classes }）供還原用。
 *
 * 本檔不依賴 DOM / Firebase，可在 node 直接單元測試。
 */

/** V1 localStorage 保留的最近版本數（含快照） */
export const V1_MAX_VERSIONS = 10;

/** V1 歷史清單的 localStorage key（與主資料 key 分開，避免快照拖慢每次主資料存檔） */
export const V1_HISTORY_KEY = 'substituteSystemScheduleImports';

/** V2 清單預設只撈最近幾版 */
export const V2_LIST_LIMIT = 20;

/**
 * 以內容算一個簡短指紋（FNV-1a 32-bit），供「這版跟上一版內容是否相同」的快速比對。
 * 不是安全雜湊，只用於顯示／去重提示。
 */
export function computeFingerprint(scheduleData) {
    const arr = Array.isArray(scheduleData) ? scheduleData : [];
    let h = 0x811c9dc5;
    const s = JSON.stringify(arr);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

function genId() {
    return `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 建立一筆匯入紀錄（不含快照）。
 * @param {Object} p
 * @param {Array}  p.scheduleData
 * @param {Array}  p.teachers
 * @param {Array}  p.classes
 * @param {string} [p.fileName]
 * @param {number} [p.skippedCount]
 * @param {number} [p.versionNo]   版本號（呼叫端以「上一版 + 1」算出）
 * @param {'file'|'restore'} [p.source]
 * @param {number} [p.restoredFromVersion]
 * @param {{name:string, teacherId:string|null}|null} [p.importedBy]
 * @param {Date} [p.now]
 */
export function createImportRecord({
    scheduleData = [], teachers = [], classes = [], fileName = '',
    skippedCount = 0, versionNo = 1, source = 'file', restoredFromVersion = null,
    importedBy = null, now = new Date(),
} = {}) {
    const rec = {
        id: genId(),
        versionNo,
        importedAt: now.toISOString(),
        source: source === 'restore' ? 'restore' : 'file',
        fileName: String(fileName || ''),
        counts: {
            entries:  Array.isArray(scheduleData) ? scheduleData.length : 0,
            classes:  Array.isArray(classes) ? classes.length : 0,
            teachers: Array.isArray(teachers) ? teachers.length : 0,
            skipped:  Number(skippedCount) || 0,
        },
        fingerprint: computeFingerprint(scheduleData),
        importedBy: importedBy && importedBy.name
            ? { name: String(importedBy.name), teacherId: importedBy.teacherId || null }
            : null,
    };
    if (rec.source === 'restore' && restoredFromVersion != null) {
        rec.restoredFromVersion = Number(restoredFromVersion);
    }
    return rec;
}

/** 由目前最後一版算出下一個版本號 */
export function nextVersionNo(lastImport) {
    const n = Number(lastImport?.versionNo);
    return Number.isFinite(n) && n > 0 ? n + 1 : 1;
}

/** 取快照（深拷貝，避免之後編輯課表連動改到歷史快照） */
export function makeSnapshot({ scheduleData = [], teachers = [], classes = [] } = {}) {
    return JSON.parse(JSON.stringify({ scheduleData, teachers, classes }));
}

/* ===== V1：localStorage 歷史清單 ===== */

/** 讀取 V1 歷史清單（新到舊）；壞資料一律回傳空陣列，不報錯 */
export function loadV1History(storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(V1_HISTORY_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

/**
 * 把一版（中繼資料 + 快照）加進 V1 歷史清單，只留最近 V1_MAX_VERSIONS 版。
 * 容量不足（QuotaExceeded）時逐步丟掉最舊版重試，最後至少保留這一版的中繼資料。
 * @returns {Array} 寫入後的清單（新到舊）
 */
export function appendV1History(record, snapshot, storage = globalThis.localStorage) {
    let list = [{ ...record, snapshot }, ...loadV1History(storage)].slice(0, V1_MAX_VERSIONS);
    for (;;) {
        try {
            storage.setItem(V1_HISTORY_KEY, JSON.stringify(list));
            return list;
        } catch (e) {
            if (list.length <= 1) {
                // 單版也放不下：退而求其次，只存中繼資料（該版無法還原）
                try {
                    list = [{ ...record, snapshot: null }];
                    storage.setItem(V1_HISTORY_KEY, JSON.stringify(list));
                } catch (_) { /* 放棄持久化，不影響匯入本身 */ }
                return list;
            }
            list = list.slice(0, list.length - 1);
        }
    }
}

/** 取出可還原的快照；沒有快照回傳 null */
export function getRestorableSnapshot(entry) {
    const s = entry?.snapshot;
    if (!s || !Array.isArray(s.scheduleData)) return null;
    return {
        scheduleData: s.scheduleData,
        teachers: Array.isArray(s.teachers) ? s.teachers : [],
        classes:  Array.isArray(s.classes) ? s.classes : [],
    };
}

/* ===== 顯示格式化 ===== */

function pad2(n) { return String(n).padStart(2, '0'); }

/** ISO → 'YYYY/MM/DD HH:mm'（本機時區）；無效值回傳空字串 */
export function formatImportDate(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 「最後匯入」單行純文字：YYYY/MM/DD HH:mm · 匯入者 · 檔名。
 * 無匯入者（V1）則省略；無紀錄回傳「尚無匯入紀錄」。回傳純文字，輸出到 HTML 前由呼叫端跳脫。
 */
export function formatLastImport(lastImport) {
    const date = formatImportDate(lastImport?.importedAt);
    if (!lastImport || !date) return '尚無匯入紀錄';
    const parts = [date];
    if (lastImport.importedBy?.name) parts.push(lastImport.importedBy.name);
    if (lastImport.fileName) parts.push(lastImport.fileName);
    return `最後匯入：${parts.join(' · ')}`;
}

/** 來源標籤 */
export function formatSource(entry) {
    if (entry?.source === 'restore') {
        return entry.restoredFromVersion != null
            ? `還原自 v${entry.restoredFromVersion}` : '還原';
    }
    return '檔案匯入';
}
