/**
 * V2 角色與權限服務
 *
 * 提供當前使用者身份（uid / teacherId / role）查詢與權限檢查。
 * 由 authGuardV2 在登入後呼叫 setCurrentIdentity(...) 設入。
 *
 * v2.0.0 升級（2026-05-29）：
 *   - 三層角色：DIRECTOR（主任）/ SECTION_CHIEF（組長）/ TEACHER（教師）
 *   - 新增 isDirector / isSectionChief / isApprover / canManageRoster
 *   - 保留 isAdmin() 作為相容 alias（內部指向 isApprover()，讓既有呼叫點不必同步改）
 *   - 舊 role='admin' 於 setCurrentIdentity 統一 normalize 為 'director'
 */

import { ROLES, APPROVER_ROLES, normalizeRole } from './schemaConstants.js';

let currentIdentity = null;

/**
 * @typedef {Object} Identity
 * @property {string} uid
 * @property {string} email
 * @property {string|null} teacherId
 * @property {string} name
 * @property {'director'|'section_chief'|'teacher'} role
 */

export function setCurrentIdentity(identity) {
    if (!identity) {
        currentIdentity = null;
        return;
    }
    currentIdentity = { ...identity, role: normalizeRole(identity.role) || ROLES.TEACHER };
}

export function clearCurrentIdentity() {
    currentIdentity = null;
}

export function getCurrentIdentity() {
    return currentIdentity ? { ...currentIdentity } : null;
}

/* ===== 角色判斷 ===== */

export function isDirector() {
    return currentIdentity?.role === ROLES.DIRECTOR;
}

export function isSectionChief() {
    return currentIdentity?.role === ROLES.SECTION_CHIEF;
}

/** 具核准權限：director 或 section_chief */
export function isApprover() {
    return APPROVER_ROLES.includes(currentIdentity?.role);
}

/** 一般教師（純 teacher，不含 approver） */
export function isPureTeacher() {
    return currentIdentity?.role === ROLES.TEACHER;
}

/**
 * 相容 alias：v2 alpha 期的 isAdmin 對應到新的 isApprover。
 * 既有呼叫點（v2-app.js、pendingRequestService、authGuardV2）不必同步改。
 * 新程式碼請改用語意更精確的 isApprover() 或 isDirector()。
 */
export function isAdmin() {
    return isApprover();
}

/** 廣義「是否為有效身份」：原 isTeacher 的舊語意（teacher 或 approver） */
export function isTeacher() {
    return !!currentIdentity && (
        currentIdentity.role === ROLES.TEACHER
        || APPROVER_ROLES.includes(currentIdentity.role)
    );
}

export function isSignedIn() {
    return !!currentIdentity;
}

/* ===== 權限閘 ===== */

export function canInitiateFor(targetTeacherId) {
    if (!currentIdentity) return false;
    if (isApprover()) return true;
    return currentIdentity.teacherId && currentIdentity.teacherId === targetTeacherId;
}

export function canApprove(requiredApproverId) {
    if (!currentIdentity) return false;
    return currentIdentity.teacherId === requiredApproverId;
}

export function canCancelRequest(request) {
    if (!currentIdentity || !request) return false;
    if (isApprover()) return true;
    return request.initiatedBy === currentIdentity.teacherId;
}

export function canEditRecord(_record) {
    return isApprover();
}

export function canDeleteRecord(_record) {
    return isApprover();
}

export function canViewAllRecords() {
    return isApprover();
}

export function canViewAllLogs() {
    return isApprover();
}

/**
 * 後台教師白名單管理（新增 / 改 email / 改角色 / 刪除）：只有 DIRECTOR 能做。
 * SECTION_CHIEF 雖能核准申請，但不能改教師名單。
 */
export function canManageRoster() {
    return isDirector();
}

/** 相容 alias：原 canManageTeachers 等同 canManageRoster（限主任） */
export function canManageTeachers() {
    return isDirector();
}

/** 上傳/編輯全校課表：approver 皆可 */
export function canEditSchedule() {
    return isApprover();
}

/**
 * 教師只能看到與自己相關的紀錄。approver（director / section_chief）可看全部。
 */
export function filterRecordsForCurrent(records) {
    if (!Array.isArray(records)) return [];
    if (isApprover()) return records;
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
    if (isApprover()) return logs;
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
