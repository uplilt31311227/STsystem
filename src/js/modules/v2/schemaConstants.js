/**
 * V2 權限系統 - Firestore Schema 常量與路徑生成器
 *
 * 所有 V2 集合路徑皆位於 schools/{schoolId}/ 之下，與舊 users/{uid}/data 完全隔離。
 */

export const SCHOOL_ID = 'default';

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

export const ROLES = Object.freeze({
    ADMIN:   'admin',
    TEACHER: 'teacher',
});

export const REQUEST_STATUS = Object.freeze({
    PENDING:   'pending',
    APPROVED:  'approved',
    REJECTED:  'rejected',
    CANCELLED: 'cancelled',
});

export const LOG_ACTIONS = Object.freeze({
    CREATE_REQUEST:     'create_request',
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
});

export const LOG_TARGET_TYPES = Object.freeze({
    SUBSTITUTE_RECORD: 'substituteRecord',
    PENDING_REQUEST:   'pendingRequest',
    TEACHER:           'teacher',
    SCHEDULE:          'schedule',
    AUTH:              'auth',
});
