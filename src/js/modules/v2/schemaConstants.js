/**
 * V2 權限系統 - Firestore Schema 常量與路徑生成器
 *
 * 所有 V2 集合路徑皆位於 schools/{schoolId}/ 之下，與舊 users/{uid}/data 完全隔離。
 *
 * v2.0.0 升級（2026-05-29）：
 *   - SCHOOL_ID 從 'default' 改為 'inhu'（內湖國中專用）。
 *     舊資料 schools/default 仍保留為 alpha 期備份，新資料寫入 schools/inhu。
 *   - ROLES 從 2 層（admin/teacher）擴成 3 層（director/section_chief/teacher）。
 *     舊 role='admin' 由 normalizeRole() 自動 alias 為 'director'，過渡期不必批量改資料。
 *   - 新增 REQUEST_TYPES：代課單簽 / 調課雙簽 / 多重全員同意，三流由 pendingRequestService 分支處理。
 */

export const SCHOOL_ID = 'inhu';

export const SCHEMA_PATHS = {
    config:            ()    => `schools/${SCHOOL_ID}/config/main`,
    teachersCol:       ()    => `schools/${SCHOOL_ID}/teachers`,
    teacherDoc:        (id)  => `schools/${SCHOOL_ID}/teachers/${id}`,
    scheduleDoc:       ()    => `schools/${SCHOOL_ID}/data/schedule`,
    substituteCol:     ()    => `schools/${SCHOOL_ID}/substituteRecords`,
    substituteDoc:     (id)  => `schools/${SCHOOL_ID}/substituteRecords/${id}`,
    // Phase 6（2026-07-29）：leaveType/leaveTypeName/reason 私有化，搬到父文件底下的
    // private/detail 子文件，只有 approver 或 allowedTeacherIds 內的當事人可讀。
    substituteDetailDoc: (id) => `schools/${SCHOOL_ID}/substituteRecords/${id}/private/detail`,
    pendingCol:        ()    => `schools/${SCHOOL_ID}/pendingRequests`,
    pendingDoc:        (id)  => `schools/${SCHOOL_ID}/pendingRequests/${id}`,
    pendingDetailDoc:  (id)  => `schools/${SCHOOL_ID}/pendingRequests/${id}/private/detail`,
    logsCol:           ()    => `schools/${SCHOOL_ID}/operationLogs`,
    logDoc:            (id)  => `schools/${SCHOOL_ID}/operationLogs/${id}`,
    userMapCol:        ()    => `schools/${SCHOOL_ID}/userMappings`,
    userMapDoc:        (uid) => `schools/${SCHOOL_ID}/userMappings/${uid}`,
    // Stage 0（2026-07-31，§3.4）：email → teacherId 索引，供首登配對用；
    // 規則只開放 get 自己一份（emailKey == 登入 email），不開放 list，故 emailKey 一律小寫。
    // 驗收修復 S11：Firestore 文件 ID 不可含 '/'（會被誤解成路徑分隔）、不可恰好等於
    // '.' 或 '..'（Firestore 保留值，寫入會直接被拒）。組路徑前先驗證，格式不合法時
    // 直接 throw——emailIndexDoc 只在已知呼叫端（schoolDataService 的 createTeacher /
    // updateTeacher / deleteTeacher / getEmailIndexEntry）內部使用，且呼叫端在傳入前
    // 已用 `if (email)` 這類 truthy 檢查排除了空字串，此處只需再擋「格式明顯不像
    // 合法文件 ID」的異常值；讓錯誤在這裡就炸出來，比讓 fs.doc() 對一個壞路徑產生更難
    // 追查的底層錯誤更容易定位，呼叫端本來就是 async function、丟出的例外會直接
    // 沿用既有的「寫入失敗就整批中止」行為（例如 createTeacher 的 batch.commit()）。
    emailIndexDoc:     (email) => {
        const normalized = (email || '').toLowerCase().trim();
        if (!normalized || normalized.includes('/') || normalized === '.' || normalized === '..') {
            throw new Error(`emailIndexDoc: 不合法的 email，無法組出 Firestore 文件路徑：${JSON.stringify(email)}`);
        }
        return `schools/${SCHOOL_ID}/emailIndex/${normalized}`;
    },
    // Stage 0（2026-07-31，§3.4b）：login_denied 改道，doc id 綁 uid，一人一份可覆寫。
    joinAttemptDoc:    (uid) => `schools/${SCHOOL_ID}/joinAttempts/${uid}`,
    joinAttemptsCol:   ()    => `schools/${SCHOOL_ID}/joinAttempts`,
};

/**
 * 三層角色定義
 *   DIRECTOR      教務主任：最高權限 + 後台教師管理 + 學校設定
 *   SECTION_CHIEF 教學組長：核准 / 駁回申請 + 上傳課表 + 月結算 + 查看所有紀錄
 *   TEACHER       一般教師：看全校課表（唯讀）+ 申請自己代調課 + 回應對調邀請 + 查自己相關紀錄
 *
 * DIRECTOR 與 SECTION_CHIEF 在「核准/駁回」層級權限相同，差別僅在後台管理（教師名單、學校設定）只有 DIRECTOR 能改。
 */
export const ROLES = Object.freeze({
    DIRECTOR:      'director',
    SECTION_CHIEF: 'section_chief',
    TEACHER:       'teacher',
});

/**
 * 舊 v2 alpha 的 admin 角色 → 新 director（過渡期相容）。
 * roleService.setCurrentIdentity 與 authGuardV2 讀完 teacher 後會自動呼叫 normalizeRole 統一語意。
 */
export const LEGACY_ROLE_ALIAS = Object.freeze({
    admin: 'director',
});

export function normalizeRole(role) {
    if (!role) return null;
    return LEGACY_ROLE_ALIAS[role] || role;
}

/** 具核准權限的角色（director + section_chief） */
export const APPROVER_ROLES = Object.freeze([ROLES.DIRECTOR, ROLES.SECTION_CHIEF]);

/** 所有合法角色，給 teacherAccountManager.setRole / firestore.rules 角色驗證使用 */
export const VALID_ROLES = Object.freeze([ROLES.DIRECTOR, ROLES.SECTION_CHIEF, ROLES.TEACHER]);

/**
 * 三種異動類型，決定 pendingRequest 走哪一種審核流程：
 *   SUBSTITUTE 代課 — 單簽（教師A 申請 → 組長/主任核准）
 *   SWAP       調課 — 雙簽（教師A 申請 → 教師B 同意 → 組長/主任核准）
 *   MULTI_SWAP 多重調課 — 全員同意（所有相關教師均同意 → 組長/主任核准）
 */
export const REQUEST_TYPES = Object.freeze({
    SUBSTITUTE: 'substitute',
    SWAP:       'swap',
    MULTI_SWAP: 'multi_swap',
});

export const REQUEST_STATUS = Object.freeze({
    PENDING:               'pending',                // legacy alpha 狀態，相容舊資料
    PENDING_SWAP_CONSENT:  'pending_swap_consent',   // 等對方/全員同意中
    PENDING_APPROVAL:      'pending_approval',       // 對方已同意，等組長/主任核准
    APPROVED:              'approved',
    REJECTED:              'rejected',
});

export const LOG_ACTIONS = Object.freeze({
    CREATE_REQUEST:     'create_request',
    SWAP_CONSENT:       'swap_consent',
    APPROVE:            'approve',
    REJECT:             'reject',
    CANCEL:             'cancel',
    ADMIN_CREATE:       'admin_create',
    EDIT:               'edit',
    DELETE:             'delete',
    TEACHER_BIND_EMAIL: 'teacher_bind_email',
    ROLE_CHANGE:        'role_change',
    // 驗收修復 N4：LOGIN_DENIED 已移除——Stage 0 把「登入被拒」改道寫入
    // schools/{id}/joinAttempts（見 operationLogger.logJoinAttempt），不再走
    // LOG_ACTIONS 這條 operationLogs 專用的動作列舉；grep 全專案確認移除前
    // 已無任何引用（authGuardV2.js 的舊呼叫點已在同一批修復中改用 logJoinAttempt）。
    PERMISSION_DENIED:  'permission_denied',
    TEACHER_CREATE:     'teacher_create',
    TEACHER_DELETE:     'teacher_delete',
    SCHEDULE_IMPORT:    'schedule_import',
    ROSTER_IMPORT:      'roster_import',
    DATA_MIGRATE:       'data_migrate',
    CLEAR_ALL_DATA:     'clear_all_data',
});

export const LOG_TARGET_TYPES = Object.freeze({
    SUBSTITUTE_RECORD: 'substituteRecord',
    PENDING_REQUEST:   'pendingRequest',
    TEACHER:           'teacher',
    SCHEDULE:          'schedule',
    AUTH:              'auth',
    SYSTEM:            'system',
});
