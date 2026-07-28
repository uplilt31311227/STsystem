/**
 * V2 教師帳號管理
 *
 * 功能：
 * - 將舊 DataManager 的教師名單匯入 V2 teachers 集合
 * - 為教師指派/解除 email
 * - 切換教師角色（director / section_chief / teacher）
 * - 新增 / 刪除教師
 *
 * 所有異動皆寫入 operationLog。
 *
 * v2.0.0 升級：setRole 接受三層角色（director / section_chief / teacher）。
 * 舊 'admin' 仍允許輸入（normalizeRole 自動轉為 'director'）以便平滑遷移。
 */

import * as dataSvc    from './schoolDataService.js';
import * as logger     from './operationLogger.js';
import { LOG_ACTIONS, LOG_TARGET_TYPES, ROLES, VALID_ROLES, normalizeRole } from './schemaConstants.js';

/**
 * 測試替身掛鉤（僅供 Node 單元測試使用，見 test/test-roster-import.mjs）。
 * 瀏覽器正式執行路徑一律使用上方 import 的真正 dataSvc / logger；
 * 單元測試會覆寫這兩個屬性為記憶體 mock，藉此在不啟動 Firebase / 瀏覽器環境的情況下，
 * 對 importRosterCsv 的純邏輯（衝突判斷、冪等性）做端對端驗證，且不需另外複製一份實作。
 * 這是一個普通物件，覆寫其屬性不影響本模組其他 function 仍使用原本 import 的行為。
 */
export const __testHooks = { dataSvc, logger };

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

/** CSV 表頭欄位名稱（PapaParse header:true 解析後物件的 key，須與 docs/V2_ROSTER_CSV.md 一致） */
const CSV_FIELDS = Object.freeze({
    NAME:     '姓名',
    EMAIL:    'Email',
    ROLE:     '角色',
    DOMAINS:  '領域',
    HOMEROOM: '導師班',
});

/** 角色欄位中英文別名對照（中文含全稱與簡稱，英文為 schemaConstants 既有角色代碼） */
const ROSTER_ROLE_ALIAS = Object.freeze({
    '主任': ROLES.DIRECTOR, '教務主任': ROLES.DIRECTOR, 'director': ROLES.DIRECTOR,
    '組長': ROLES.SECTION_CHIEF, '教學組長': ROLES.SECTION_CHIEF, 'section_chief': ROLES.SECTION_CHIEF,
    '教師': ROLES.TEACHER, '老師': ROLES.TEACHER, 'teacher': ROLES.TEACHER,
});

/**
 * 解析角色欄位字串。
 * 回傳 { ok, role }：
 *   - 空白 → { ok:true, role:undefined }　未指定，由呼叫端決定預設值（新增）或保留舊值（更新）
 *   - 合法值 → { ok:true, role:正規化後的角色代碼 }
 *   - 其他 → { ok:false, role:null }　不合法，呼叫端記為錯誤並跳過該列
 */
function resolveRosterRole(raw) {
    const s = (raw == null ? '' : String(raw)).trim();
    if (!s) return { ok: true, role: undefined };
    const mapped = ROSTER_ROLE_ALIAS[s] || ROSTER_ROLE_ALIAS[s.toLowerCase()];
    return mapped ? { ok: true, role: mapped } : { ok: false, role: null };
}

/** 領域欄位以 、 ; , ， 分隔成陣列；空白回傳 undefined（代表「未指定」，供更新時判斷是否保留舊值）。 */
function parseRosterDomains(raw) {
    const s = (raw == null ? '' : String(raw)).trim();
    if (!s) return undefined;
    return s.split(/[、;,，]/).map(x => x.trim()).filter(Boolean);
}

/** 比對兩個領域陣列內容是否相同（忽略順序），用於判斷更新是否為真的異動。 */
function sameDomainSet(a, b) {
    const x = Array.isArray(a) ? [...a].sort() : [];
    const y = Array.isArray(b) ? [...b].sort() : [];
    return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * 教師名單 CSV 批次匯入（Phase 4b：全校 30+ 人 onboarding）。
 *
 * @param {Array<Object>} rows PapaParse header:true 解析後的物件陣列，欄位見 CSV_FIELDS。
 * @param {{ dryRun?: boolean }} [options] dryRun=true 時只計算結果、不寫入 Firestore、不寫操作日誌，
 *   供 UI 兩段式匯入的「預覽」步驟使用；回傳結構與正式寫入完全相同。
 * @returns {Promise<{created:Array, updated:Array, skipped:Array, errors:Array<{row:number,name:string,reason:string}>}>}
 *
 * 衝突處理規則（冪等性為硬需求：同一份 CSV 重複執行兩次，Firestore 最終狀態必須相同）：
 *   - 姓名已存在於 teachers → 更新該筆。CSV 留空的欄位（email/角色/領域/導師班）一律保留舊值、
 *     不清空既有資料（例如已由後台指派為主任的人，CSV 若漏填角色不會被打回教師預設值）。
 *     若逐欄比對後與現況完全相同（沒有任何欄位真的變動）→ 計入 skipped 而非 updated，
 *     這也是重跑同一份 CSV 時通常會收斂成「全部 skipped、0 created、0 updated」的原因。
 *   - Email 已被「其他」teacherId 佔用 → 該列記錯誤跳過（不可搶走他人 email）。
 *   - 同一份 CSV 內重複 Email → 第一筆勝出，其餘記錯誤跳過。
 *   - 姓名空白 → 記錯誤跳過。
 *   - 角色值不在中英文對照表內 → 記錯誤跳過。
 */
export async function importRosterCsv(rows = [], options = {}) {
    const dryRun = !!options.dryRun;
    const svc    = __testHooks.dataSvc;
    const log    = __testHooks.logger;
    const result = { created: [], updated: [], skipped: [], errors: [] };

    // 一次性取得現況快照：避免逐列重查 Firestore（N+1 查詢），並讓整批匯入的衝突判斷基準一致。
    const existingTeachers = await svc.listTeachers();
    const byName  = new Map(existingTeachers.map(t => [t.name, t]));
    const byEmail = new Map();
    for (const t of existingTeachers) {
        if (t.email) byEmail.set(t.email.toLowerCase().trim(), t);
    }
    const emailFirstSeenAt = new Map(); // normalizedEmail → 本批次內第一次出現的列號

    for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2; // 表頭算第 1 列，資料從第 2 列開始，對應使用者在 Excel/CSV 看到的行號
        const row = rows[i] || {};
        const name = String(row[CSV_FIELDS.NAME] ?? '').trim();

        if (!name) {
            result.errors.push({ row: rowNum, name: '', reason: '姓名為必填欄位' });
            continue;
        }

        const roleResult = resolveRosterRole(row[CSV_FIELDS.ROLE]);
        if (!roleResult.ok) {
            result.errors.push({
                row: rowNum, name,
                reason: `角色「${row[CSV_FIELDS.ROLE]}」不是合法值（可用：主任/組長/教師 或 director/section_chief/teacher）`,
            });
            continue;
        }

        const rawEmail        = String(row[CSV_FIELDS.EMAIL] ?? '').trim();
        const normalizedEmail = rawEmail ? rawEmail.toLowerCase() : null;
        const domains         = parseRosterDomains(row[CSV_FIELDS.DOMAINS]);
        const homeroomClass   = String(row[CSV_FIELDS.HOMEROOM] ?? '').trim();
        const existingByName  = byName.get(name);

        if (normalizedEmail) {
            if (emailFirstSeenAt.has(normalizedEmail)) {
                result.errors.push({
                    row: rowNum, name,
                    reason: `Email「${rawEmail}」與本檔案第 ${emailFirstSeenAt.get(normalizedEmail)} 列重複，僅採用第一筆`,
                });
                continue;
            }
            const owner = byEmail.get(normalizedEmail);
            if (owner && (!existingByName || owner.teacherId !== existingByName.teacherId)) {
                result.errors.push({ row: rowNum, name, reason: `Email「${rawEmail}」已被教師「${owner.name}」使用` });
                continue;
            }
        }

        if (existingByName) {
            const patch = {};
            if (normalizedEmail && normalizedEmail !== (existingByName.email || null)) patch.email = normalizedEmail;
            if (roleResult.role && roleResult.role !== normalizeRole(existingByName.role)) patch.role = roleResult.role;
            if (domains !== undefined && !sameDomainSet(domains, existingByName.domains)) patch.domains = domains;
            if (homeroomClass && homeroomClass !== (existingByName.homeroomClass || '')) patch.homeroomClass = homeroomClass;

            if (Object.keys(patch).length === 0) {
                result.skipped.push({ teacherId: existingByName.teacherId, row: rowNum, name, reason: '資料與現況相同，未異動' });
            } else {
                const after = dryRun ? { ...existingByName, ...patch } : await svc.updateTeacher(existingByName.teacherId, patch);
                result.updated.push(after);
                byName.set(name, after);
                if (patch.email) byEmail.set(patch.email, after);
            }
        } else {
            const payload = {
                name,
                email: normalizedEmail,
                domains: domains || [],
                homeroomClass,
                role: roleResult.role || ROLES.TEACHER,
            };
            const created = dryRun ? { teacherId: null, ...payload } : await svc.createTeacher(payload);
            result.created.push(created);
            byName.set(name, created);
            if (normalizedEmail) byEmail.set(normalizedEmail, created);
        }

        if (normalizedEmail) emailFirstSeenAt.set(normalizedEmail, rowNum);
    }

    if (!dryRun && (result.created.length || result.updated.length)) {
        await log.log(
            LOG_ACTIONS.ROSTER_IMPORT,
            LOG_TARGET_TYPES.TEACHER,
            null,
            {
                createdCount: result.created.length,
                updatedCount: result.updated.length,
                skippedCount: result.skipped.length,
                errorCount: result.errors.length,
            }
        );
    }

    return result;
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
    const normalized = normalizeRole(role);
    if (!VALID_ROLES.includes(normalized)) {
        throw new Error(`無效角色：${role}`);
    }
    const before = await dataSvc.getTeacher(teacherId);
    if (!before) throw new Error('找不到教師');

    const after = await dataSvc.updateTeacher(teacherId, { role: normalized });
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
