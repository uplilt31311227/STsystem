/**
 * V2 教師帳號管理
 *
 * 功能：
 * - 將舊 DataManager 的教師名單匯入 V2 teachers 集合
 * - 為教師指派/解除 email
 * - 切換教師角色（admin / teacher）
 * - 新增 / 刪除教師
 *
 * 所有異動皆寫入 operationLog。
 */

import * as dataSvc    from './schoolDataService.js';
import * as logger     from './operationLogger.js';
import { LOG_ACTIONS, LOG_TARGET_TYPES, ROLES } from './schemaConstants.js';

export async function listAllTeachers() {
    return dataSvc.listTeachers();
}

export async function getByEmail(email) {
    return dataSvc.findTeacherByEmail(email);
}

export async function importFromLegacyTeachers(legacyTeachers = []) {
    const existing = await dataSvc.listTeachers();
    const existingNames = new Set(existing.map(t => t.name));
    const created = [];
    for (const t of legacyTeachers) {
        if (!t || !t.name) continue;
        if (existingNames.has(t.name)) continue;
        const rec = await dataSvc.createTeacher({
            name: t.name,
            email: null,
            domains: t.domains || [],
            homeroomClass: t.homeroomClass || '',
            role: ROLES.TEACHER,
        });
        created.push(rec);
    }
    if (created.length) {
        await logger.log(
            LOG_ACTIONS.SCHEDULE_IMPORT,
            LOG_TARGET_TYPES.TEACHER,
            null,
            { importedCount: created.length, names: created.map(c => c.name) }
        );
    }
    return created;
}

export async function assignEmail(teacherId, email) {
    const before = await dataSvc.getTeacher(teacherId);
    if (!before) throw new Error('找不到教師');

    const normalized = email ? email.toLowerCase().trim() : null;
    if (normalized) {
        const conflict = await dataSvc.findTeacherByEmail(normalized);
        if (conflict && conflict.teacherId !== teacherId) {
            throw new Error(`此 email 已被教師「${conflict.name}」使用`);
        }
    }

    const after = await dataSvc.updateTeacher(teacherId, { email: normalized });
    await logger.log(
        LOG_ACTIONS.TEACHER_BIND_EMAIL,
        LOG_TARGET_TYPES.TEACHER,
        teacherId,
        { before: { email: before.email }, after: { email: after.email }, name: before.name }
    );
    return after;
}

export async function setRole(teacherId, role) {
    if (role !== ROLES.ADMIN && role !== ROLES.TEACHER) {
        throw new Error(`無效角色：${role}`);
    }
    const before = await dataSvc.getTeacher(teacherId);
    if (!before) throw new Error('找不到教師');

    const after = await dataSvc.updateTeacher(teacherId, { role });
    await logger.log(
        LOG_ACTIONS.ROLE_CHANGE,
        LOG_TARGET_TYPES.TEACHER,
        teacherId,
        { before: { role: before.role }, after: { role: after.role }, name: before.name }
    );
    return after;
}

export async function createTeacher(payload) {
    const t = await dataSvc.createTeacher(payload);
    await logger.log(
        LOG_ACTIONS.TEACHER_CREATE,
        LOG_TARGET_TYPES.TEACHER,
        t.teacherId,
        { name: t.name, email: t.email, role: t.role }
    );
    return t;
}

export async function deleteTeacher(teacherId) {
    const before = await dataSvc.getTeacher(teacherId);
    if (!before) return;
    await dataSvc.deleteTeacher(teacherId);
    await logger.log(
        LOG_ACTIONS.TEACHER_DELETE,
        LOG_TARGET_TYPES.TEACHER,
        teacherId,
        { name: before.name, email: before.email }
    );
}
