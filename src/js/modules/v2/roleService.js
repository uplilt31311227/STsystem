/**
 * V2 角色與權限服務
 *
 * 提供當前使用者身份（uid / teacherId / role）查詢與權限檢查。
 * 由 authGuardV2 在登入後呼叫 setCurrentIdentity(...) 設入。
 */

import { ROLES } from './schemaConstants.js';

let currentIdentity = null;

/**
 * @typedef {Object} Identity
 * @property {string} uid
 * @property {string} email
 * @property {string|null} teacherId
 * @property {string} name
 * @property {'admin'|'teacher'} role
 */

export function setCurrentIdentity(identity) {
    currentIdentity = identity ? { ...identity } : null;
}

export function clearCurrentIdentity() {
    currentIdentity = null;
}

export function getCurrentIdentity() {
    return currentIdentity ? { ...currentIdentity } : null;
}

export function isAdmin() {
    return currentIdentity?.role === ROLES.ADMIN;
}

export function isTeacher() {
    return !!currentIdentity && (currentIdentity.role === ROLES.TEACHER || currentIdentity.role === ROLES.ADMIN);
}

export function isSignedIn() {
    return !!currentIdentity;
}

/* ===== 權限閘 ===== */

export function canInitiateFor(targetTeacherId) {
    if (!currentIdentity) return false;
    if (isAdmin()) return true;
    return currentIdentity.teacherId && currentIdentity.teacherId === targetTeacherId;
}

export function canApprove(requiredApproverId) {
    if (!currentIdentity) return false;
    return currentIdentity.teacherId === requiredApproverId;
}

export function canCancelRequest(request) {
    if (!currentIdentity || !request) return false;
    if (isAdmin()) return true;
    return request.initiatedBy === currentIdentity.teacherId;
}

export function canEditRecord(_record) {
    return isAdmin();
}

export function canDeleteRecord(_record) {
    return isAdmin();
}

export function canViewAllRecords() {
    return isAdmin();
}

export function canViewAllLogs() {
    return isAdmin();
}

export function canManageTeachers() {
    return isAdmin();
}

/**
 * 教師只能看到與自己相關的紀錄。
 */
export function filterRecordsForCurrent(records) {
    if (!Array.isArray(records)) return [];
    if (isAdmin()) return records;
    const tid = currentIdentity?.teacherId;
    if (!tid) return [];
    return records.filter(r =>
        r.initiatedBy === tid
        || r.originalTeacherId === tid
        || r.substituteTeacherId === tid
        || r.swapTeacherId === tid
        || (Array.isArray(r.affectedTeacherIds) && r.affectedTeacherIds.includes(tid))
    );
}

export function filterLogsForCurrent(logs) {
    if (!Array.isArray(logs)) return [];
    if (isAdmin()) return logs;
    const tid = currentIdentity?.teacherId;
    if (!tid) return [];
    return logs.filter(l => {
        const d = l.details || {};
        return l.actor?.teacherId === tid
            || d.initiatedBy === tid
            || d.requiredApproverId === tid
            || d.onBehalfOf === tid
            || (Array.isArray(d.affectedTeacherIds) && d.affectedTeacherIds.includes(tid));
    });
}
