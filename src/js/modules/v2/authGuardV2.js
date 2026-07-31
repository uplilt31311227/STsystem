/**
 * V2 登入綁定閘
 *
 * 於 Google OAuth 登入完成後呼叫 resolveIdentity(user)：
 *   1. 讀 schools/{id}/emailIndex/{我的email} 拿 teacherId（Stage 0 §3.4a）。
 *   2. 若 email 在 config.initialAdminEmails 清單中（白名單，主任初始名單）
 *      → 找到 teacherId 則升級該教師檔為 director；
 *        找不到則建立一筆「教務主任」教師紀錄並綁定為 director（全新學校 bootstrap）。
 *   3. 若 email 對到 emailIndex 中的 teacherId（一般教師）
 *      → 設為該教師（role 依 teachers 紀錄；舊 'admin' 由 normalizeRole 轉為 'director'）。
 *   4. 否則
 *      → 寫 joinAttempt 紀錄，拒絕登入（回傳 null，呼叫端自行 signOut）。
 *
 * 成功綁定時會將身份寫入 roleService（setCurrentIdentity，內部自動 normalizeRole）。
 *
 * Stage 0（2026-07-31，見 docs/RESEARCH-multitenancy-semester.md §3.3/§3.4）：
 * firestore.rules 的 teachers 讀取從「任何登入者」收緊為「isMember(schoolId)」（成員限定），
 * 首登（尚無 userMappings）因此讀不到 teachers 集合，原本「讀 teachers 集合以 email 配對」
 * 的流程必須改走 emailIndex（規則只開放 get 自己那一份，不需成員資格）。
 *
 * ⚠ 寫入順序不可顛倒：mapping 尚未建立時 isMember(schoolId) 恆為 false，此刻直接
 * getDoc(teachers/{id}) 一樣會被拒——必須「先用 emailIndex 查到的 teacherId 建立
 * userMappings（其 create 規則靠內部 get() 驗證 email 相符，不受 teachers 的 read
 * 規則限制），mapping 建立後才讀教師檔本體」。config 讀取同理收緊為
 * isMemberOrBootstrapDirector，見 getInitialDirectorEmails() 的容錯處理。
 *
 * 驗收修復（2026-07-31）：
 *   - S5：getEmailIndexEntry() 查詢包 try/catch，失敗一律視同查無配對，走正常拒絕
 *     流程，不讓例外變成未捕捉的系統錯誤。
 *   - S6：emailIndex 查無條目時，後備讀自己的 userMappings/{uid}（自己讀自己不需要
 *     成員資格），取既有 linkedTeacherId 接著跑完整流程——索引缺條目不會把「本來就是
 *     成員」的既有教師擋在登入門外。
 *   - S6-R：上述後備路徑取到 teacherId 時代表 mapping 已經存在（isMember 已成立），
 *     跳過 upsertUserMapping 直接讀教師檔——不重複寫入，代價是這次登入不刷新
 *     lastLoginAt 等欄位，見 resolveIdentity() 內 `mappingAlreadyExists` 分支的說明。
 *
 * v2.0.0 升級：白名單建立角色從 ADMIN 改為 DIRECTOR；舊資料 role='admin' 視同 director。
 * Firestore config.initialAdminEmails 欄位名稱維持（避免破壞既有 schools/default config 文件）。
 */

import * as dataSvc from './schoolDataService.js';
import * as logger  from './operationLogger.js';
import * as roleSvc from './roleService.js';
import { ROLES, normalizeRole } from './schemaConstants.js';

async function getInitialDirectorEmails() {
    let cfg;
    try {
        cfg = await dataSvc.getConfig();
    } catch (e) {
        // Stage 0 R2 收緊後（isMemberOrBootstrapDirector），尚非成員且不在白名單的
        // 使用者讀不到 config——這正好等同「不是白名單主任」（若在白名單，isInitialDirector
        // 內部 get() 就會讓這次 read 通過），直接視為空清單即可，不阻斷後續 emailIndex 配對。
        cfg = null;
    }
    // 欄位名稱維持 initialAdminEmails 以兼容既有 Firestore config 文件
    const raw = cfg?.initialAdminEmails || cfg?.initialDirectorEmails || [];
    return raw.map(e => (e || '').toLowerCase().trim()).filter(Boolean);
}

function buildMappingPatch(email, googleUser, providerId) {
    return {
        email,
        googleName: googleUser.displayName || null,
        googlePhotoUrl: googleUser.photoURL || null,
        lastProviderId: providerId,
    };
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

    const initialDirectors  = await getInitialDirectorEmails();
    const isInitialDirector = initialDirectors.includes(email);
    const mappingPatch       = buildMappingPatch(email, googleUser, providerId);

    // Stage 0：先查 emailIndex（get 自己那一份，不需成員資格），拿到既有 teacherId 才知道
    // 「已有教師檔、只是還沒 mapping」與「全新教師/全新學校」的區別。
    // 驗收修復 S5：查詢失敗（規則拒絕、暫時性網路錯誤等）一律視同查無配對，讓流程繼續走
    // 下面既有成員的後備路徑或正常的拒絕流程，不讓例外把登入炸成未捕捉的系統錯誤。
    let indexEntry = null;
    try {
        indexEntry = await dataSvc.getEmailIndexEntry(email);
    } catch (e) {
        console.warn('[v2] 讀取 emailIndex 失敗，視同查無配對：', e?.message || e);
    }
    let teacherId = indexEntry?.teacherId || null;

    // 驗收修復 S6：索引查無條目時的後備——若使用者其實已經是成員（userMappings 已存在，
    // 例如 Stage 0 上線前就登入過、或回填腳本漏掉的舊資料），直接用既有 mapping 的
    // linkedTeacherId，不因索引缺漏把既有成員擋在登入門外。自己讀自己的 userMappings
    // 不需要成員資格（rules 的 userMappings read 對本人一律開放，見 firestore.rules）。
    // 驗收修復 S6-R：這條後備路徑取到 teacherId 時，userMappings 文件本身「已經存在」
    // （不然 getUserMapping 不會回傳非 null 的 linkedTeacherId），isMember(schoolId) 此刻
    // 已成立——不需要、也不應該再呼叫一次 upsertUserMapping 才能讀教師檔，用
    // `mappingAlreadyExists` 記住這個狀態，下面直接跳過 upsert、只讀教師檔本體。
    let mappingAlreadyExists = false;
    if (!teacherId) {
        try {
            const existingMapping = await dataSvc.getUserMapping(googleUser.uid);
            if (existingMapping?.linkedTeacherId) {
                teacherId = existingMapping.linkedTeacherId;
                mappingAlreadyExists = true;
            }
        } catch (e) {
            console.warn('[v2] 讀取既有 userMapping 後備失敗：', e?.message || e);
        }
    }

    let teacher = null;

    if (teacherId) {
        try {
            if (mappingAlreadyExists) {
                // S6-R：mapping 已存在、isMember 已成立，直接讀教師檔即可。代價是這次
                // 登入不會刷新 mapping 上的 lastLoginAt/googleName/googlePhotoUrl/
                // lastProviderId——這條路徑只在 emailIndex 缺條目時觸發（正常穩定態下
                // 不會發生，因為 createTeacher/updateTeacher 已同步維護 emailIndex），
                // 若要修回「每次登入都更新」，重新跑一次回填腳本補上索引即可，之後
                // 該教師的登入會改走上面的 emailIndex 正常路徑。
                teacher = await dataSvc.getTeacher(teacherId);
            } else {
                // 先建立/更新 mapping：規則內部 get() 驗證 email 相符，不受 teachers 的 read
                // 規則限制。mapping 寫入成功後 isMember(schoolId) 才成立，才能真正讀到教師檔。
                await dataSvc.upsertUserMapping(googleUser.uid, { ...mappingPatch, linkedTeacherId: teacherId });
                teacher = await dataSvc.getTeacher(teacherId);
            }
        } catch (e) {
            // emailIndex 條目與 teachers 集合不同步（理論上不會發生，防禦式處理）：
            // mapping 規則的 exists(teachers/{id}) 驗證會直接擋下寫入，視同找不到教師。
            console.warn('[v2] emailIndex 指向的教師檔不存在或 mapping 建立失敗：', e?.message || e);
            teacher = null;
        }
        if (teacher && isInitialDirector && normalizeRole(teacher.role) !== ROLES.DIRECTOR) {
            teacher = await dataSvc.updateTeacher(teacherId, { role: ROLES.DIRECTOR });
        }
    } else if (isInitialDirector) {
        // 全新學校、白名單主任第一次登入：尚無教師檔也尚無 emailIndex 條目，自建 director
        // 教師檔（createTeacher 內部會同步寫入 emailIndex，見 schoolDataService.js）。
        // isDirector(schoolId) 在此靠 isInitialDirector 白名單分支成立，不需要先有 mapping。
        teacher = await dataSvc.createTeacher({
            name:  googleUser.displayName || email.split('@')[0] || '教務主任',
            email,
            role:  ROLES.DIRECTOR,
        });
        await dataSvc.upsertUserMapping(googleUser.uid, { ...mappingPatch, linkedTeacherId: teacher.teacherId });
    }

    if (!teacher) {
        await logger.logJoinAttempt(googleUser.uid, { email, reason: 'no_teacher_match' });
        return null;
    }

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
