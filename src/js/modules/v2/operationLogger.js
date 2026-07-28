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

import { appendLog, listLogs } from './schoolDataService.js';
import { getCurrentIdentity }  from './roleService.js';

// 本次工作階段（頁面存活期間）寫入失敗的日誌項目，供 v2-app.js 的操作日誌頁籤橫幅提示使用。
// 僅存於記憶體，重新整理頁面即清空；不影響 log() 本身「失敗不阻斷主流程」的行為。
const failedLogs = [];

export function getFailedLogCount() {
    return failedLogs.length;
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

export async function log(action, targetType, targetId, details = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        actor:     safeActor(),
        action,
        targetType,
        targetId:  targetId || null,
        details:   details || {},
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
