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
 *
 * Stage 3（2026-07-31，RESEARCH-multitenancy-semester.md §8 Stage 3；§4.2-4.4 集合設計預告）：
 * SCHOOL_ID 動態化。原本的 `export const SCHOOL_ID = 'inhu'` 是 import-time 單點常數，
 * 全 app 只能服務寫死的 'inhu'。改為 getActiveSchoolId()：模組層狀態，登入後由
 * authGuardV2.resolveIdentity() 呼叫 setActiveSchoolId() 設定；尚未設定（例如尚未登入、
 * 或 Node 腳本/測試環境完全不會呼叫這個函式）時 fallback 回 DEFAULT_SCHOOL_ID。
 * SCHEMA_PATHS 全部改吃這個動態值，App 端所有呼叫端（schoolDataService.js 等）完全不需要
 * 額外改動——它們本來就只透過 SCHEMA_PATHS.*() 組路徑，從未直接引用 SCHOOL_ID 常數本身
 * （唯一例外是 v2-app.js 的一處匯出 meta 欄位，已改呼叫 getActiveSchoolId()）。
 * scripts/ 與 test/ 下的 Node 腳本各自有獨立的 `const SCHOOL_ID = ... '--school=' ... || 'inhu'`
 * 或直接寫死 'inhu'，皆不 import 這個模組的 SCHOOL_ID／getActiveSchoolId，是刻意設計的單校
 * 維運工具（各自已有 --school= 參數），本次不動。
 */

// 相容期 fallback：找不到 schoolId 時（例如 userDirectory 尚未回填、或腳本/測試環境從未
// 呼叫 setActiveSchoolId）一律視為 'inhu'——這是目前唯一正式服務的學校，維持現行使用者
// 體驗完全不變。Stage 4（開放註冊）上線後，這個 fallback 的適用範圍應該限縮，見
// authGuardV2.js 的 resolveSchoolIdForUid() 內的 TODO 註記。
export const DEFAULT_SCHOOL_ID = 'inhu';

let _activeSchoolId = null;

/** 目前作用中的 schoolId；尚未由 setActiveSchoolId() 設定時回傳 DEFAULT_SCHOOL_ID。 */
export function getActiveSchoolId() {
    return _activeSchoolId || DEFAULT_SCHOOL_ID;
}

/** 登入解析完成後呼叫，之後所有 SCHEMA_PATHS.*() 組路徑皆改用這個值。 */
export function setActiveSchoolId(schoolId) {
    _activeSchoolId = schoolId || null;
}

/** 登出 / school 切換時呼叫，清空後下一次 getActiveSchoolId() 會回退到 DEFAULT_SCHOOL_ID。 */
export function resetActiveSchoolId() {
    _activeSchoolId = null;
}

export const SCHEMA_PATHS = {
    config:            ()    => `schools/${getActiveSchoolId()}/config/main`,
    teachersCol:       ()    => `schools/${getActiveSchoolId()}/teachers`,
    teacherDoc:        (id)  => `schools/${getActiveSchoolId()}/teachers/${id}`,
    // 舊：單一文件、整份覆寫，換學期即蓋掉舊課表（RESEARCH-multitenancy-semester.md §5.1）。
    // Stage 2 起改由 schedules/{semesterId} 取代為主要讀寫路徑；此路徑保留給
    // getSchedule()/subscribeSchedule() 的一次性讀取 fallback（per-semester 文件尚未建立時，
    // 例如剛從 Stage 1 升級、還沒建立任何 schedules/{semesterId} 文件的學校），以及
    // scripts/migrate-schedule-to-semester.js 的遷移來源，不再被任何寫入路徑使用。
    scheduleDoc:       ()    => `schools/${getActiveSchoolId()}/data/schedule`,
    // Stage 2（§5.3）：per-semester 課表文件，取代上面的單一文件。
    schedulesCol:      ()    => `schools/${getActiveSchoolId()}/schedules`,
    scheduleDocForSemester: (sid) => `schools/${getActiveSchoolId()}/schedules/${sid}`,
    substituteCol:     ()    => `schools/${getActiveSchoolId()}/substituteRecords`,
    substituteDoc:     (id)  => `schools/${getActiveSchoolId()}/substituteRecords/${id}`,
    // Phase 6（2026-07-29）：leaveType/leaveTypeName/reason 私有化，搬到父文件底下的
    // private/detail 子文件，只有 approver 或 allowedTeacherIds 內的當事人可讀。
    substituteDetailDoc: (id) => `schools/${getActiveSchoolId()}/substituteRecords/${id}/private/detail`,
    pendingCol:        ()    => `schools/${getActiveSchoolId()}/pendingRequests`,
    pendingDoc:        (id)  => `schools/${getActiveSchoolId()}/pendingRequests/${id}`,
    pendingDetailDoc:  (id)  => `schools/${getActiveSchoolId()}/pendingRequests/${id}/private/detail`,
    logsCol:           ()    => `schools/${getActiveSchoolId()}/operationLogs`,
    logDoc:            (id)  => `schools/${getActiveSchoolId()}/operationLogs/${id}`,
    userMapCol:        ()    => `schools/${getActiveSchoolId()}/userMappings`,
    userMapDoc:        (uid) => `schools/${getActiveSchoolId()}/userMappings/${uid}`,
    // Stage 3（2026-07-31，§4 集合設計預告）：頂層（不在 schools/{schoolId} 之下）的
    // uid → schoolId 反查索引。resolveIdentity() 必須先讀這份文件才知道要對哪個 schoolId
    // 呼叫 setActiveSchoolId()，故不能放在 schools/{schoolId} 底下（那時候還不知道
    // schoolId 是什麼，Firestore 也不支援跨集合搜尋 uid，見報告 §4 開頭的動機說明）。
    userDirectoryDoc:  (uid) => `userDirectory/${uid}`,
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
        return `schools/${getActiveSchoolId()}/emailIndex/${normalized}`;
    },
    // Stage 0（2026-07-31，§3.4b）：login_denied 改道，doc id 綁 uid，一人一份可覆寫。
    joinAttemptDoc:    (uid) => `schools/${getActiveSchoolId()}/joinAttempts/${uid}`,
    joinAttemptsCol:   ()    => `schools/${getActiveSchoolId()}/joinAttempts`,
    // Stage 5（2026-07-31，§6.2/§6.5）：封存紀錄，doc id 綁 semesterId（一學期最多封存一次，
    // 規則層 create-only + update/delete 皆 false，寫入後永久不可變，見 firestore.rules）。
    archivesCol:       ()    => `schools/${getActiveSchoolId()}/archives`,
    archiveDoc:        (sid) => `schools/${getActiveSchoolId()}/archives/${sid}`,
    // Stage 4（2026-07-31，RESEARCH-multitenancy-semester.md §4／RESEARCH-blaze-followup.md；
    // 多租戶開通）：新校核准時，platformAdmin 需要對「非自己目前所屬學校」的 schoolId 寫入
    // config/main——不能用 SCHEMA_PATHS.config()（吃 getActiveSchoolId()，那是 platformAdmin
    // 自己所屬的學校，不是正在核准的新學校），故獨立提供一個吃任意 schoolId 參數的版本，
    // 僅供 schoolApplicationService.approveApplication() 使用。
    configDocForSchool: (sid) => `schools/${sid}/config/main`,
    // 以下三個為頂層集合（不在 schools/{schoolId} 之下，與 userDirectoryDoc 同一類），
    // 見 firestore.rules 檔頭第 9 點。
    platformAdminDoc:      (uid) => `platformAdmins/${uid}`,
    schoolDirectoryDoc:    (sid) => `schoolDirectory/${sid}`,
    schoolApplicationDoc:  (uid) => `schoolApplications/${uid}`,
    schoolApplicationsCol: ()    => `schoolApplications`,
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
    // Stage 2（§6.1 SOP）：director 在「學校設定 → 學期管理」開新學期時寫入。
    SEMESTER_SWITCH:    'semester_switch',
    // Stage 5（§6.2 SOP）：director 完成「匯出 → 驗證 → 刪除」封存流程後寫入。
    SEMESTER_ARCHIVE:   'semester_archive',
});

export const LOG_TARGET_TYPES = Object.freeze({
    SUBSTITUTE_RECORD: 'substituteRecord',
    PENDING_REQUEST:   'pendingRequest',
    TEACHER:           'teacher',
    SCHEDULE:          'schedule',
    AUTH:              'auth',
    SYSTEM:            'system',
});
