/**
 * 課表匯入預覽的純邏輯（差異計算、略過列彙整、目標學期檢查），無 DOM／Firebase 依賴。
 *
 * 對應審計 ux H7（課表匯入無預覽即覆寫）與 logic-flow M-9（先開學期再匯入沒有防呆）。
 * 顯示端（app.js confirmScheduleImport）只負責把這裡算出的模型跳脫後畫出來。
 */

import { computeFingerprint } from './scheduleImportHistory.js';

/** 預覽中每種名單最多列出幾個名字，其餘以「另 N 個」帶過 */
export const PREVIEW_LIST_LIMIT = 20;

const nameOf = (x) => String(x && typeof x === 'object' ? (x.name ?? '') : (x ?? '')).trim();

function uniqueNames(list) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
        const n = nameOf(item);
        if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
}

function diffNames(oldList, newList) {
    const o = uniqueNames(oldList);
    const n = uniqueNames(newList);
    const oSet = new Set(o);
    const nSet = new Set(n);
    return {
        old: o.length,
        new: n.length,
        added: n.filter(x => !oSet.has(x)),
        removed: o.filter(x => !nSet.has(x)),
    };
}

/**
 * 比較「現有課表」與「這次要匯入的課表」。
 * @param {{scheduleData?:Array, teachers?:Array, classes?:Array}|null} oldSnap
 * @param {{scheduleData?:Array, teachers?:Array, classes?:Array}|null} newSnap
 */
export function diffScheduleSnapshots(oldSnap, newSnap) {
    const oldEntries = Array.isArray(oldSnap?.scheduleData) ? oldSnap.scheduleData.length : 0;
    const newEntries = Array.isArray(newSnap?.scheduleData) ? newSnap.scheduleData.length : 0;
    const teachers = diffNames(oldSnap?.teachers, newSnap?.teachers);
    const classes = diffNames(oldSnap?.classes, newSnap?.classes);
    const oldEmpty = oldEntries === 0 && teachers.old === 0 && classes.old === 0;
    const newEmpty = newEntries === 0 && teachers.new === 0 && classes.new === 0;
    const identical = !oldEmpty && !newEmpty
        && computeFingerprint(oldSnap?.scheduleData) === computeFingerprint(newSnap?.scheduleData)
        && teachers.added.length === 0 && teachers.removed.length === 0
        && classes.added.length === 0 && classes.removed.length === 0;
    return {
        entries: { old: oldEntries, new: newEntries, delta: newEntries - oldEntries },
        teachers,
        classes,
        oldEmpty,
        newEmpty,
        identical,
    };
}

/**
 * 彙整解析警告（被略過的列）：依原因分組，各組保留前幾個列號。
 * @param {Array<{row:number, reason:string, summary?:string}>} warnings
 * @param {number} [skippedCount] 解析器回報的略過數（warnings 為空時的後備）
 */
export function summarizeParseWarnings(warnings, skippedCount = 0) {
    const list = Array.isArray(warnings) ? warnings : [];
    const groups = new Map();
    for (const w of list) {
        // 原因可能帶具體值（如「無效節次「第十五節」」），分組時保留完整原因，使用者才看得出差別
        const key = String(w?.reason ?? '未知原因');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(w?.row);
    }
    const out = [...groups.entries()]
        .map(([reason, rows]) => ({ reason, count: rows.length, rows: rows.filter(r => r != null).slice(0, 10) }))
        .sort((a, b) => b.count - a.count);
    return { total: list.length || Number(skippedCount) || 0, groups: out };
}

/**
 * 目標學期是否與「依今天日期推算的學期」一致（M-9 防呆：先開學期再匯入）。
 * 任一方未知（null）時不判定為不一致（無從比較），由呼叫端另行處理。
 */
export function evaluateTargetSemester({ targetSemesterId, todaySemesterId } = {}) {
    if (!targetSemesterId) return { known: false, mismatch: false, message: '' };
    if (!todaySemesterId) return { known: true, mismatch: false, message: '' };
    if (targetSemesterId === todaySemesterId) return { known: true, mismatch: false, message: '' };
    return {
        known: true,
        mismatch: true,
        message:
            `依今天的日期，現在屬於「${todaySemesterId}」，但這份課表會匯入到「${targetSemesterId}」。` +
            `若這是新學期的課表，請先到「設定 › 學期管理」開新學期再匯入；` +
            `若確定要匯入到「${targetSemesterId}」，請勾選下方確認。`,
    };
}

/**
 * 組出預覽對話框所需的完整模型。
 * @param {Object} p
 * @param {{scheduleData:Array, teachers:Array, classes:Array}|null} p.current 現有課表
 * @param {{scheduleData:Array, teachers:Array, classes:Array}} p.incoming 解析出的新課表
 * @param {Array} [p.warnings]
 * @param {number} [p.skippedCount]
 * @param {string} [p.fileName]
 * @param {{semesterId?:string|null, todaySemesterId?:string|null}|null} [p.target] V1 為 null
 */
export function buildImportPreviewModel({ current, incoming, warnings = [], skippedCount = 0, fileName = '', target = null } = {}) {
    const diff = diffScheduleSnapshots(current, incoming);
    const semester = evaluateTargetSemester({
        targetSemesterId: target?.semesterId || null,
        todaySemesterId: target?.todaySemesterId || null,
    });
    return {
        fileName: String(fileName || ''),
        targetSemesterId: target?.semesterId || null,
        diff,
        warnings: summarizeParseWarnings(warnings, skippedCount),
        semester,
        // 解析成功但沒有任何課程（含「只有教師名單、沒有課程」）：匯入只會清空或掏空課表，不提供確認
        blocked: diff.entries.new === 0
            ? (diff.newEmpty
                ? '解析結果沒有任何課程資料，不能匯入。請確認選到的是「人力資源網 2.0」匯出的課表檔。'
                : '解析結果只有教師或班級名單、沒有任何課程，不能匯入（匯入後課表會變成空的）。請確認選到的是「人力資源網 2.0」匯出的課表檔，且檔案內有課程資料。')
            : '',
        // 現有課表有內容：確認後它會被取代（V2 會先自動備份）
        willReplace: !diff.oldEmpty,
        // 需要額外勾選確認才能繼續
        needsSemesterAck: semester.mismatch,
    };
}

/** 名單截斷顯示用：回傳 { shown: string[], more: number } */
export function truncateList(names, limit = PREVIEW_LIST_LIMIT) {
    const list = Array.isArray(names) ? names : [];
    return { shown: list.slice(0, limit), more: Math.max(0, list.length - limit) };
}
