/**
 * V2 操作日誌
 *
 * 所有寫入操作皆透過此模組記錄至 schools/{schoolId}/operationLogs。
 * 結構：
 *   {
 *     timestamp: ISO string,
 *     actor: { uid, email, name, role, teacherId },
 *     action: (LOG_ACTIONS 之一),
 *     targetType, targetId,
 *     details: { before?, after?, ... }
 *   }
 */

import { appendLog, listLogs, upsertJoinAttempt } from './schoolDataService.js';
import { getCurrentIdentity }  from './roleService.js';
import * as semesterState      from './semesterState.js';

// 本次工作階段（頁面存活期間）寫入失敗的日誌項目，供 v2-app.js 的操作日誌頁籤橫幅提示使用。
// 僅存於記憶體，重新整理頁面即清空；不影響 log() 本身「失敗不阻斷主流程」的行為。
const failedLogs = [];

export function getFailedLogCount() {
    return failedLogs.length;
}

/**
 * Stage 3 opus 驗收 輕7：清空本次工作階段累積的寫入失敗紀錄。
 * 供 v2-app.js 的 resetV2ViewState() 在身份「實際改變」時呼叫——failedLogs 記的是「寫入
 * 哪個學校失敗」（entry 本身經由 appendLog()/upsertJoinAttempt() 寫向 getActiveSchoolId()
 * 當下指向的學校），若身份切換後不清空，操作日誌頁籤的「寫入失敗」橫幅會沿用上一位使用者
 * （可能是不同學校）留下的失敗計數，對新登入者是誤導性的殘留狀態。
 */
export function clearFailedLogs() {
    failedLogs.length = 0;
}

function safeActor() {
    const id = getCurrentIdentity();
    if (!id) {
        return { uid: null, email: null, name: null, role: null, teacherId: null };
    }
    return {
        uid: id.uid || null,
        email: id.email || null,
        name: id.name || null,
        role: id.role || null,
        teacherId: id.teacherId || null,
    };
}

// Stage 2（§5.3：operationLogs 加 semesterId「供封存時分批」）：一律取寫入當下的目前學期，
// 不需要相容豁免——日誌記的是「動作發生的當下」，即使 details 內容涉及歷史學期的資料
// （例如未來封存功能翻查舊紀錄），這筆日誌本身仍是此刻、此學期發生的稽核事件。
export async function log(action, targetType, targetId, details = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        actor:     safeActor(),
        action,
        targetType,
        targetId:  targetId || null,
        details:   details || {},
        semesterId: semesterState.getCurrentSemesterId(),
    };
    try {
        return await appendLog(entry);
    } catch (err) {
        console.error('[operationLogger] 寫入失敗:', err, entry);
        failedLogs.push({ entry, error: (err && err.message) || String(err), at: new Date().toISOString() });
        return null;
    }
}

export async function fetchLogs(options = {}) {
    return listLogs(options);
}

/**
 * 記錄一次「登入被拒」的嘗試（Stage 0 R7 收緊後的配套，見 §3.4b）。
 * login_denied 依定義發生在使用者尚非任何學校成員時，此時 isMember() 恆為 false，
 * 已無法再寫入 operationLogs（R7 已改為 isMember(schoolId) 守門）。改寫入
 * schools/{schoolId}/joinAttempts/{uid}——doc id 綁 uid，一人一份可覆寫，天然限制灌爆量，
 * 規則見 firestore.rules 的 joinAttempts match 區塊（欄位白名單 email/attemptedAt/reason）。
 * 失敗處理與 log() 對稱：不阻斷主流程，計入 failedLogs 供操作日誌頁籤橫幅提示使用。
 */
export async function logJoinAttempt(uid, details = {}) {
    try {
        return await upsertJoinAttempt(uid, {
            email:  details.email || null,
            reason: details.reason || 'no_teacher_match',
        });
    } catch (err) {
        console.error('[operationLogger] joinAttempts 寫入失敗:', err, { uid, details });
        failedLogs.push({ entry: { uid, ...details }, error: (err && err.message) || String(err), at: new Date().toISOString() });
        return null;
    }
}
