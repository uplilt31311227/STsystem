/**
 * V2 登入綁定閘
 *
 * 於 Google OAuth 登入完成後呼叫 resolveIdentity(user)：
 *   1. 若 email 在 config.initialAdminEmails 清單中
 *      → 嘗試在 teachers 集合找同 email 的教師，
 *        找到則綁定為 admin；
 *        找不到則建立一筆「組長管理員」教師紀錄並綁定為 admin。
 *   2. 若 email 匹配 teachers 集合中某教師
 *      → 設為該教師（role 依 teachers 紀錄）。
 *   3. 否則
 *      → 寫 login_denied log，拒絕登入（回傳 null，呼叫端自行 signOut）。
 *
 * 成功綁定時會將身份寫入 roleService（setCurrentIdentity）。
 */

import * as dataSvc from './schoolDataService.js';
import * as logger  from './operationLogger.js';
import * as roleSvc from './roleService.js';
import { LOG_ACTIONS, LOG_TARGET_TYPES, ROLES } from './schemaConstants.js';

async function getInitialAdminEmails() {
    const cfg = await dataSvc.getConfig();
    const raw = cfg?.initialAdminEmails || [];
    return raw.map(e => (e || '').toLowerCase().trim()).filter(Boolean);
}

async function ensureAdminTeacher(email, googleUser) {
    const normalized = email.toLowerCase().trim();
    let t = await dataSvc.findTeacherByEmail(normalized);
    if (t) {
        if (t.role !== ROLES.ADMIN) {
            t = await dataSvc.updateTeacher(t.teacherId, { role: ROLES.ADMIN });
        }
        return t;
    }
    const created = await dataSvc.createTeacher({
        name:   googleUser.displayName || normalized.split('@')[0] || '管理員',
        email:  normalized,
        role:   ROLES.ADMIN,
    });
    return created;
}

/**
 * @returns {Promise<Identity|null>} 綁定成功的身份；null 表示未綁定，呼叫端應登出
 */
export async function resolveIdentity(googleUser) {
    if (!googleUser || !googleUser.email) return null;
    const email = googleUser.email.toLowerCase().trim();

    const initialAdmins = await getInitialAdminEmails();
    const isInitialAdmin = initialAdmins.includes(email);

    let teacher = null;
    if (isInitialAdmin) {
        teacher = await ensureAdminTeacher(email, googleUser);
    } else {
        teacher = await dataSvc.findTeacherByEmail(email);
    }

    if (!teacher) {
        await logger.log(LOG_ACTIONS.LOGIN_DENIED, LOG_TARGET_TYPES.AUTH, googleUser.uid, {
            email,
            displayName: googleUser.displayName || null,
        });
        return null;
    }

    await dataSvc.upsertUserMapping(googleUser.uid, {
        email,
        googleName: googleUser.displayName || null,
        googlePhotoUrl: googleUser.photoURL || null,
        linkedTeacherId: teacher.teacherId,
    });

    const identity = {
        uid:       googleUser.uid,
        email,
        teacherId: teacher.teacherId,
        name:      teacher.name,
        role:      teacher.role || ROLES.TEACHER,
    };
    roleSvc.setCurrentIdentity(identity);
    return identity;
}

export function clear() {
    roleSvc.clearCurrentIdentity();
}
