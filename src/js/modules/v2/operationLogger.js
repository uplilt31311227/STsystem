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
        return null;
    }
}

export async function fetchLogs(options = {}) {
    return listLogs(options);
}
