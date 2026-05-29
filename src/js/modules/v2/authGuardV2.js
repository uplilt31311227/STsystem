/**
 * V2 登入綁定閘
 *
 * 於 Google OAuth 登入完成後呼叫 resolveIdentity(user)：
 *   1. 若 email 在 config.initialAdminEmails 清單中（白名單，主任初始名單）
 *      → 嘗試在 teachers 集合找同 email 的教師，
 *        找到則升級為 director；
 *        找不到則建立一筆「教務主任」教師紀錄並綁定為 director。
 *   2. 若 email 匹配 teachers 集合中某教師
 *      → 設為該教師（role 依 teachers 紀錄；舊 'admin' 由 normalizeRole 轉為 'director'）。
 *   3. 否則
 *      → 寫 login_denied log，拒絕登入（回傳 null，呼叫端自行 signOut）。
 *
 * 成功綁定時會將身份寫入 roleService（setCurrentIdentity，內部自動 normalizeRole）。
 *
 * v2.0.0 升級：白名單建立角色從 ADMIN 改為 DIRECTOR；舊資料 role='admin' 視同 director。
 * Firestore config.initialAdminEmails 欄位名稱維持（避免破壞既有 schools/default config 文件）。
 */

import * as dataSvc from './schoolDataService.js';
import * as logger  from './operationLogger.js';
import * as roleSvc from './roleService.js';
import { LOG_ACTIONS, LOG_TARGET_TYPES, ROLES, normalizeRole } from './schemaConstants.js';

async function getInitialDirectorEmails() {
    const cfg = await dataSvc.getConfig();
    // 欄位名稱維持 initialAdminEmails 以兼容既有 Firestore config 文件
    const raw = cfg?.initialAdminEmails || cfg?.initialDirectorEmails || [];
    return raw.map(e => (e || '').toLowerCase().trim()).filter(Boolean);
}

async function ensureDirectorTeacher(email, googleUser) {
    const normalized = email.toLowerCase().trim();
    let t = await dataSvc.findTeacherByEmail(normalized);
    if (t) {
        if (normalizeRole(t.role) !== ROLES.DIRECTOR) {
            t = await dataSvc.updateTeacher(t.teacherId, { role: ROLES.DIRECTOR });
        }
        return t;
    }
    const created = await dataSvc.createTeacher({
        name:   googleUser.displayName || normalized.split('@')[0] || '教務主任',
        email:  normalized,
        role:   ROLES.DIRECTOR,
    });
    return created;
}

/**
 * @returns {Promise<Identity|null>} 綁定成功的身份；null 表示未綁定，呼叫端應登出
 */
export async function resolveIdentity(googleUser) {
    if (!googleUser || !googleUser.email) return null;
    const email = googleUser.email.toLowerCase().trim();
    // Phase 1.6.c：providerId 來自 Firebase user.providerData[0].providerId
    //   'google.com' → Google 登入；'password' → Email/密碼登入
    const providerId = googleUser.providerId || null;

    const initialDirectors = await getInitialDirectorEmails();
    const isInitialDirector = initialDirectors.includes(email);

    let teacher = null;
    if (isInitialDirector) {
        teacher = await ensureDirectorTeacher(email, googleUser);
    } else {
        teacher = await dataSvc.findTeacherByEmail(email);
    }

    if (!teacher) {
        await logger.log(LOG_ACTIONS.LOGIN_DENIED, LOG_TARGET_TYPES.AUTH, googleUser.uid, {
            email,
            displayName: googleUser.displayName || null,
            providerId,
        });
        return null;
    }

    // 先 upsert mapping，這樣 rules helper myTeacherId() 立刻生效，
    // 後續 update teacher.authProvider 才會通過「自己可改自己 authProvider」的 rule。
    await dataSvc.upsertUserMapping(googleUser.uid, {
        email,
        googleName: googleUser.displayName || null,
        googlePhotoUrl: googleUser.photoURL || null,
        linkedTeacherId: teacher.teacherId,
        lastProviderId: providerId,
    });

    // 記錄登入 provider 到 teachers doc（給教師管理 UI 判斷「寄密碼信」按鈕是否顯示）
    if (providerId && teacher.authProvider !== providerId) {
        try {
            teacher = await dataSvc.updateTeacher(teacher.teacherId, { authProvider: providerId });
        } catch (e) {
            console.warn('[v2] 寫入 teachers.authProvider 失敗（不阻擋登入）：', e?.message || e);
        }
    }

    const identity = {
        uid:       googleUser.uid,
        email,
        teacherId: teacher.teacherId,
        name:      teacher.name,
        role:      normalizeRole(teacher.role) || ROLES.TEACHER,
        authProvider: providerId,
    };
    roleSvc.setCurrentIdentity(identity);
    return identity;
}

export function clear() {
    roleSvc.clearCurrentIdentity();
}
