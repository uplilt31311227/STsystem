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
    pendingCol:        ()    => `schools/${SCHOOL_ID}/pendingRequests`,
    pendingDoc:        (id)  => `schools/${SCHOOL_ID}/pendingRequests/${id}`,
    logsCol:           ()    => `schools/${SCHOOL_ID}/operationLogs`,
    logDoc:            (id)  => `schools/${SCHOOL_ID}/operationLogs/${id}`,
    userMapCol:        ()    => `schools/${SCHOOL_ID}/userMappings`,
    userMapDoc:        (uid) => `schools/${SCHOOL_ID}/userMappings/${uid}`,
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
    CANCELLED:             'cancelled',
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
    LOGIN_DENIED:       'login_denied',
    PERMISSION_DENIED:  'permission_denied',
    TEACHER_CREATE:     'teacher_create',
    TEACHER_DELETE:     'teacher_delete',
    SCHEDULE_IMPORT:    'schedule_import',
    ROSTER_IMPORT:      'roster_import',
});

export const LOG_TARGET_TYPES = Object.freeze({
    SUBSTITUTE_RECORD: 'substituteRecord',
    PENDING_REQUEST:   'pendingRequest',
    TEACHER:           'teacher',
    SCHEDULE:          'schedule',
    AUTH:              'auth',
});
