/**
 * V2 雙重指派檢查（純函式＋可注入資料來源，不碰 Firebase SDK，可在 Node 單元測試）
 *
 * 兩個用途：
 *   1. 核准／組長直接成立前的重新驗證（pendingRequestService.approveRequest / adminCreate）：
 *      申請擱置期間，教師可能已被另一筆紀錄佔走同日同節，核准前以「當下」紀錄再檢查一次。
 *   2. 在途申請（待同意／待核准）視為「佔用」：轉成與已成立紀錄同形狀的佔用紀錄，
 *      丟給 findTeacherConflict／findSwapInConflict／findSwapDateConflict 一起判斷，
 *      並用 __pendingLabel 在訊息中標示「（待核准中）」「（待同意中）」。
 *
 * 在途申請「只」用在推薦過濾與送出前攔截；月結算（settlementCalculator）的呼叫路徑
 * （getSubstituteRecordsAsync）完全不經過本檔。
 */

import {
    findTeacherConflict,
    findSwapInConflict,
    findSwapDateConflict,
    pendingTag,
} from '../recommendationEngine.js';
import { REQUEST_STATUS } from './schemaConstants.js';
import { findClassSlotConflict, describeClassSlotConflict } from '../slotOccupancy.js';

/** 在途狀態 → 訊息標示。legacy 'pending'（alpha 期單簽）讀取時等同「待同意」。 */
const PENDING_LABELS = Object.freeze({
    [REQUEST_STATUS.PENDING_SWAP_CONSENT]: '待同意中',
    [REQUEST_STATUS.PENDING_APPROVAL]:     '待核准中',
    [REQUEST_STATUS.PENDING]:              '待同意中',
});

/** 佔用紀錄的 id 前綴；用於 excludeRecordId 排除「申請自己」。 */
export const PENDING_ID_PREFIX = 'pending:';

/**
 * 把在途申請轉成佔用紀錄。非在途狀態（approved/rejected）與自我調課略過：
 * approved 的真相已在 substituteRecords，rejected 已無效，自我調課不佔用他人時段。
 * 若指定 start/end，只保留 date 或 swapDate 落在範圍內的申請（調課會佔用 swapDate）。
 *
 * @param {Array} requests - pendingRequests 文件（含 reqId）
 * @param {{excludeReqId?:string, startDate?:string, endDate?:string}} [opts]
 * @returns {Array} 佔用紀錄：{ ...request, id:'pending:<reqId>', __pending:true, __pendingLabel }
 */
export function pendingRequestsToOccupancyRecords(requests, { excludeReqId = null, startDate = '', endDate = '' } = {}) {
    const inRange = (d) => !!d && (!startDate || d >= startDate) && (!endDate || d <= endDate);
    return (requests || [])
        .filter(r => r && PENDING_LABELS[r.status] && r.reqId !== excludeReqId && !r.isSelfSwap)
        .filter(r => (!startDate && !endDate) || inRange(r.date) || inRange(r.swapDate))
        .map(r => ({
            ...r,
            id: `${PENDING_ID_PREFIX}${r.reqId}`,
            __pending: true,
            __pendingLabel: PENDING_LABELS[r.status],
        }));
}

/** 以紀錄 id → 去重合併（V2 紀錄可能只有 recordId 沒有 id）。 */
export function dedupeRecords(rows) {
    const map = new Map();
    for (const r of rows || []) {
        if (!r) continue;
        const key = r.recordId || r.id || r.reqId || JSON.stringify([r.date, r.period, r.originalTeacher, r.substituteTeacher, r.swapTeacher]);
        map.set(key, r);
    }
    return [...map.values()];
}

/** YYYY-MM-DD 加減天數（純字串運算，不受時區影響）。 */
export function shiftDate(dateStr, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return dateStr;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 查詢指定日期「前後各 days 天」的已成立紀錄並去重。
 * 調課紀錄以 date（時段 A）為索引、但佔用 swapDate（時段 B），所以要把前後一段一併查回
 * （與 app.js fetchRecordsAroundDates 相同的 31 天窗口）。
 * ⚠ 窗口只涵蓋「date 落在範圍內」的紀錄；遠距調課（date 與 swapDate 相差 >31 天）的「移入」
 * 不會被抓到，所以注入的 queryRange 必須同時含 swapDate 落在範圍內的紀錄
 * （V2 見 schoolDataService.queryRecordsOccupyingRange）。
 * 查詢失敗直接丟出，由呼叫端決定 fail-closed。
 * @param {string[]} dates
 * @param {(range:{startDate:string,endDate:string})=>Promise<Array>} queryRange - 注入的日期範圍查詢
 */
export async function fetchRecordsAroundDates(dates, queryRange, days = 31) {
    const rows = [];
    for (const date of new Set((dates || []).filter(Boolean))) {
        const part = await queryRange({ startDate: shiftDate(date, -days), endDate: shiftDate(date, days) });
        rows.push(...part);
    }
    return dedupeRecords(rows);
}

/**
 * 核對一張申請／紀錄所指派的教師，在 records 中是否已被佔用同日同節。
 *   - 代課：substituteTeacher 當日當節是否已代課／調課（findTeacherConflict）或被調課移入（findSwapInConflict）
 *   - 調課（非自我調課）：findSwapDateConflict（兩個方向）
 * 不看週課表（申請送出時已檢查過；核准時只需補「紀錄層級」的缺口）。
 * 例外：scheduleData 有提供時，班級時段判斷會排除協同教學（同班同節兩位以上教師）的其他教師。
 *
 * @returns {{teacher:string,date:string,period:string,role:string,detail:Object}|null}
 */
export function findAssignmentConflict(req, records, excludeRecordId = null, scheduleData = null) {
    if (!req || req.isSelfSwap) return null;
    if (req.type === '調課') {
        if (!req.originalTeacher || !req.swapTeacher) return null;
        const teacherHit = findSwapDateConflict({
            teacherA: req.originalTeacher, dateA: req.date, periodA: req.period,
            teacherB: req.swapTeacher, dateB: req.swapDate, periodB: req.swapPeriod,
            records, excludeRecordId,
        });
        if (teacherHit) return teacherHit;
        // 班級時段（P6）：時段 A、時段 B 這兩個班級時段是否已被其他紀錄改過任課者
        return findClassSlotConflict({ className: req.className, date: req.date, period: req.period,
                teacher: req.originalTeacher, records, excludeRecordId, anchor: req, scheduleData })
            || findClassSlotConflict({ className: req.className, date: req.swapDate, period: req.swapPeriod,
                teacher: req.swapTeacher, records, excludeRecordId, anchor: req, scheduleData });
    }
    if (req.type === '代課' && req.substituteTeacher) {
        const args = { teacherName: req.substituteTeacher, date: req.date, period: req.period, records, excludeRecordId };
        const hit = findTeacherConflict(args) || findSwapInConflict(args);
        if (hit) return { teacher: String(req.substituteTeacher).trim(), date: req.date, period: req.period, role: hit.role, detail: hit.detail };
        // 班級時段（P6）：同一班同一節已有代課，或這一節已被調課換了任課者
        return findClassSlotConflict({ className: req.className, date: req.date, period: req.period,
            teacher: req.originalTeacher, records, excludeRecordId, anchor: req, scheduleData });
    }
    return null;
}

/** 把衝突命中描述成一句話（不含前綴），例：王大明 2026-10-20 第三節已被指派為801的代課（待核准中） */
export function describeAssignmentConflict(hit) {
    if (hit.kind === 'classSlot') return describeClassSlotConflict(hit);
    const d = hit.detail || {};
    const where = hit.role === '調課' && d.swapDate === hit.date && d.swapPeriod === hit.period && d.originalTeacher === hit.teacher
        ? `已調課移入${d.className || ''}`
        : `已被指派為${d.className || ''}的${hit.role}`;
    return `${hit.teacher} ${hit.date} ${hit.period}${where}${pendingTag(d)}`;
}

/** 需要課表才能判斷是否為協同教學，但課表讀不到或為空：仍然擋下，但訊息明確區分，避免被當成真的衝堂而誤駁回 */
export const SCHEDULE_UNAVAILABLE_MESSAGE = '無法確認當日課表（需判斷是否為協同教學），請稍後再試一次；這不是衝堂，請勿駁回';

/** 核准失敗訊息（拋給使用者看）。呼叫端 UI 對此訊息不得再加「核准失敗：」類前綴。 */
export function buildApprovalConflictMessage(hit) {
    if (hit && hit.scheduleUnavailable) return SCHEDULE_UNAVAILABLE_MESSAGE;
    return `核准失敗：${describeAssignmentConflict(hit)}，請駁回或請申請人改選`;
}

/**
 * 組長直接成立（adminCreate）被擋的訊息：此情境沒有「申請」可駁回，應請組長改選。
 * @param {Object} hit - findAssignmentConflict 的命中
 * @param {Object} [req] - 原 payload；調課類型提示改選互換課程或日期
 */
export function buildAdminCreateConflictMessage(hit, req = null) {
    if (hit && hit.scheduleUnavailable) return SCHEDULE_UNAVAILABLE_MESSAGE;
    const advice = req?.type === '調課' ? '請重新選擇互換課程或日期' : '請改選代課教師';
    return `無法成立：${describeAssignmentConflict(hit)}，${advice}`;
}

/**
 * 核准／直接成立前的重新驗證：以「當下」紀錄查衝堂。
 * 只比對已成立紀錄（不含其他在途申請——否則兩張互相衝突的申請會彼此卡死、誰都不能核准；
 * 在途申請之間的衝突由送出時的攔截負責）。
 * 查詢失敗丟出 code='APPROVAL_VERIFY_FAILED' 的錯誤（fail-closed：不核准）。
 *
 * @param {Object} req - 申請（或直接成立的 payload）
 * @param {(range:{startDate:string,endDate:string})=>Promise<Array>} queryRange
 * @param {()=>Promise<Array>} [loadSchedule] - 讀週課表；只有班級時段命中且申請方既非換走也非換進的教師（可能是協同教學）時才呼叫，
 *        讀取失敗維持原命中（fail-closed）
 * @returns {Promise<{teacher,date,period,role,detail}|null>} 有衝突回傳命中，無衝突回傳 null
 */
export async function verifyNoAssignmentConflict(req, queryRange, loadSchedule = null) {
    if (!req || req.isSelfSwap) return null;
    let records;
    try {
        records = await fetchRecordsAroundDates([req.date, req.swapDate], queryRange);
    } catch (cause) {
        const err = new Error('核准前無法確認教師當日是否已被指派（讀取既有調代課紀錄失敗），已中止，請稍後再試');
        err.code = 'APPROVAL_VERIFY_FAILED';
        err.cause = cause;
        throw err;
    }
    const hit = findAssignmentConflict(req, records);
    if (hit && hit.kind === 'classSlot' && hit.needsSchedule && typeof loadSchedule === 'function') {
        try {
            const scheduleData = await loadSchedule();
            if (Array.isArray(scheduleData) && scheduleData.length > 0) return findAssignmentConflict(req, records, null, scheduleData);
        } catch (e) {
            console.warn('[V2] 核准重驗讀取課表失敗，維持擋下：', e);
        }
        // 課表讀不到或為空：無法判斷是否為協同教學，仍擋下，但標記為「課表不可用」而非一般衝堂
        return { ...hit, scheduleUnavailable: true };
    }
    return hit;
}

/**
 * 極短 TTL 的「進行中請求去重＋結果快取」：同一輪操作（例如多日期、多節代課的連續衝堂判斷）
 * 內只實際讀取一次，避免重複查詢。失敗的結果不快取。
 * ⚠ 只可用於推薦過濾／送出前攔截；核准重驗（approveRequest／adminCreate）必須讀當下資料，不得使用。
 * @param {()=>Promise<any>} loader - 實際讀取函式
 * @param {number} [ttlMs=5000]
 * @param {()=>number} [now] - 可注入時鐘（測試用）
 * @returns {{get:()=>Promise<any>, invalidate:()=>void}}
 */
export function createShortTtlCache(loader, ttlMs = 5000, now = Date.now) {
    let promise = null;
    let at = 0;
    return {
        get() {
            if (promise && now() - at < ttlMs) return promise;
            const p = loader();
            promise = p;
            at = now();
            Promise.resolve(p).catch(() => { if (promise === p) promise = null; });
            return p;
        },
        invalidate() { promise = null; },
    };
}
