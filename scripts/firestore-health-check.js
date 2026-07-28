#!/usr/bin/env node
/**
 * Firestore V2 健康檢查
 *
 * 驗證 schools/{schoolId} 結構與資料是否符合現行 Phase 3 schema
 * （三層角色 director/section_chief/teacher + 三種審核流程狀態機），列出潛在問題。
 *
 * 角色與狀態機合法值一律從 src/js/modules/v2/schemaConstants.js 動態 import，
 * 不在本檔另外寫死一份，未來 schema 異動只需要改那一處（見 loadSchemaConstants）。
 *
 * 用法：node scripts/firestore-health-check.js [--verbose] [--school=<id>]
 *   --school:  指定 schoolId，預設 inhu（正式資料所在）。
 *              --school=default 可查看 2026-04 alpha 期的舊備份。
 *   --verbose: 額外印出每項通過的檢查，以及測試資料被降級的 INFO 明細。
 *
 * 檢查項：
 *   1. config/main 存在且 initialAdminEmails 為非空陣列
 *   2. 每位 teacher：email 唯一（重複時列出兩筆 name/role/authProvider/createdAt 供人工判斷孤兒）、
 *      role ∈ VALID_ROLES（director/section_chief/teacher；舊值 admin 相容但 WARN 建議遷移）
 *   3. 每筆 userMapping 對應的 linkedTeacherId 確實存在
 *   4. pendingRequests：
 *        - initiatedBy 必填
 *        - requiredApproverId 僅在「approver 已進場」的狀態才要求（legacy pending /
 *          pending_approval / approved），pending_swap_consent 階段 approver 尚未進場，不查
 *        - status 對齊 REQUEST_STATUS 全部合法值（含 pending_swap_consent / pending_approval）
 *        - requestType 若存在需為合法值
 *        - swap / multi_swap 在 pending_swap_consent 階段須有非空 pendingConsentTeacherIds
 *   5. substituteRecords 必備欄位 (status, date, period)
 *   6. operationLogs 最近 50 筆 actor 欄位完整
 *   7. 測試資料（doc id 以 zz_test_ 開頭，或任一欄位含「[測試]」標記）獨立統計為 INFO，
 *      不計入正式資料的 FAIL/WARN、也不影響 exit code
 *
 * exit code：0 = 正式資料無 FAIL（可能仍有 WARN）；1 = 正式資料有 FAIL；2 = 腳本執行中斷（例如取不到 token）
 */
const { execSync }     = require('child_process');
const fsSync            = require('node:fs');
const path              = require('node:path');
const { pathToFileURL } = require('node:url');

const PROJECT   = 'stsystem-9d5fe';
const SCHOOL_ID = process.argv.find(a => a.startsWith('--school='))?.split('=')[1] || 'inhu';
const BASE      = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const VERBOSE   = process.argv.includes('--verbose');

const SCHEMA_CONSTANTS_PATH = path.join(__dirname, '..', 'src', 'js', 'modules', 'v2', 'schemaConstants.js');

/**
 * 動態 import 現行 schemaConstants.js，取得 ROLES/REQUEST_STATUS/REQUEST_TYPES 等唯一真相來源。
 * 本腳本是 CommonJS（package.json 未設 "type":"module"，沿用 scripts/ 下其他腳本慣例），
 * 但 import() 對 ESM 檔案一樣可用——實測（Node v22.23.1）僅會印一次
 * 「MODULE_TYPELESS_PACKAGE_JSON」診斷警告（schemaConstants.js 用 export 語法卻沒有
 * package.json type:module 可依循），純屬雜訊，不影響本腳本邏輯或 exit code，故不特別處理。
 * 若未來環境（不同 Node 版本、路徑異動）導致 import 失敗，退回文字解析備援，見下方函式註解。
 */
async function loadSchemaConstants() {
    try {
        const mod = await import(pathToFileURL(SCHEMA_CONSTANTS_PATH).href);
        return {
            VALID_ROLES:       mod.VALID_ROLES,
            LEGACY_ROLE_ALIAS: mod.LEGACY_ROLE_ALIAS,
            APPROVER_ROLES:    mod.APPROVER_ROLES,
            normalizeRole:     mod.normalizeRole,
            REQUEST_STATUS:    mod.REQUEST_STATUS,
            REQUEST_TYPES:     mod.REQUEST_TYPES,
        };
    } catch (e) {
        console.error(`⚠️  動態 import schemaConstants.js 失敗（${e.message}），改用文字解析備援`);
        return loadSchemaConstantsFallback();
    }
}

/**
 * 備援：直接讀檔文字，用正則解析 ROLES / REQUEST_STATUS / REQUEST_TYPES / LEGACY_ROLE_ALIAS
 * 這幾個 Object.freeze({...}) 常量區塊裡的 KEY: 'value' 字面值。僅適用於 schemaConstants.js
 * 目前「每個常數都是字串字面值」的寫法；該檔若改成動態運算值會解析不到，屆時應優先修正
 * import 路徑本身，而不是繼續維護這份備援 parser。
 */
function loadSchemaConstantsFallback() {
    const text = fsSync.readFileSync(SCHEMA_CONSTANTS_PATH, 'utf8');
    function extractBlock(constName) {
        const re  = new RegExp(`${constName}\\s*=\\s*Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\)`);
        const m   = text.match(re);
        const out = {};
        if (!m) return out;
        const kvRe = /(\w+)\s*:\s*'([^']+)'/g;
        let kv;
        while ((kv = kvRe.exec(m[1]))) out[kv[1]] = kv[2];
        return out;
    }
    const ROLES             = extractBlock('ROLES');
    const REQUEST_STATUS    = extractBlock('REQUEST_STATUS');
    const REQUEST_TYPES     = extractBlock('REQUEST_TYPES');
    const LEGACY_ROLE_ALIAS = extractBlock('LEGACY_ROLE_ALIAS');
    return {
        VALID_ROLES:    Object.values(ROLES),
        LEGACY_ROLE_ALIAS,
        APPROVER_ROLES: [ROLES.DIRECTOR, ROLES.SECTION_CHIEF].filter(Boolean),
        normalizeRole:  (role) => (role ? (LEGACY_ROLE_ALIAS[role] || role) : null),
        REQUEST_STATUS,
        REQUEST_TYPES,
    };
}

// 由 loadSchemaConstants() 於下方 main IIFE 起始處填入；check* 函式皆在其之後才會被呼叫，故用閉包安全取用。
let VALID_ROLES, LEGACY_ROLE_ALIAS, APPROVER_ROLES, normalizeRole;
let REQUEST_STATUS, REQUEST_TYPES, VALID_REQUEST_STATUSES, VALID_REQUEST_TYPES, REQUIRE_APPROVER_ID_STATUSES;

const issues        = [];   // 正式資料的 FAIL/WARN
const testDataNotes = [];   // 測試資料底下原本會是 FAIL/WARN 的項目，降級為 INFO，統一於結尾列出
let   testDataCount = 0;    // 被辨識為測試資料的文件總數（跨所有集合）

function fail(msg) { issues.push({ level: 'FAIL', msg }); }
function warn(msg) { issues.push({ level: 'WARN', msg }); }
function ok(msg)   { if (VERBOSE) console.log(`  ✓ ${msg}`); }
function info(msg) { testDataNotes.push(msg); }

/**
 * 測試資料辨識：doc id 以 zz_test_ 開頭，或任一欄位（含陣列/巢狀物件）內容含「[測試]」標記。
 * 命中者的問題一律降級為 INFO、獨立計入 testDataCount，不進 issues（不影響 FAIL/WARN 統計與 exit code），
 * 避免對抗測試／E2E 殘留資料（如 zz_test_req_attack8_xxx）淹沒正式資料的真實問題。
 */
function containsTestMarker(value) {
    if (typeof value === 'string') return value.includes('[測試]');
    if (Array.isArray(value)) return value.some(containsTestMarker);
    if (value && typeof value === 'object') return Object.values(value).some(containsTestMarker);
    return false;
}
function isTestData(doc) {
    if (typeof doc._id === 'string' && doc._id.startsWith('zz_test_')) return true;
    return Object.entries(doc).some(([k, val]) => k !== '_id' && containsTestMarker(val));
}
function reporterFor(doc) {
    const isTest = isTestData(doc);
    if (isTest) testDataCount++;
    return { isTest, fail: isTest ? info : fail, warn: isTest ? info : warn };
}

function getToken() {
    return execSync('gcloud auth print-access-token --account=uplilt31311227@gmail.com')
        .toString().trim();
}

async function api(p) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        const txt = await res.text();
        if (res.status === 404) return null;
        throw new Error(`${res.status} ${p}\n${txt.slice(0, 200)}`);
    }
    return res.json();
}

function unwrap(field) {
    if (!field) return null;
    if ('stringValue'  in field) return field.stringValue;
    if ('integerValue' in field) return +field.integerValue;
    if ('doubleValue'  in field) return field.doubleValue;
    if ('booleanValue' in field) return field.booleanValue;
    if ('arrayValue'   in field) return (field.arrayValue.values || []).map(unwrap);
    if ('mapValue'     in field) {
        const o = {};
        for (const [k, v] of Object.entries(field.mapValue.fields || {})) o[k] = unwrap(v);
        return o;
    }
    if ('timestampValue' in field) return field.timestampValue;
    if ('nullValue' in field) return null;
    return null;
}

function docToObj(doc) {
    const obj = { _id: doc.name.split('/').pop() };
    for (const [k, v] of Object.entries(doc.fields || {})) obj[k] = unwrap(v);
    return obj;
}

async function listAll(col) {
    const data = await api(col);
    return (data?.documents || []).map(docToObj);
}

async function checkConfig() {
    console.log('▶ Config');
    const cfg = await api(`schools/${SCHOOL_ID}/config/main`);
    if (!cfg) return fail('config/main 不存在');
    const obj = docToObj(cfg);
    if (!Array.isArray(obj.initialAdminEmails) || obj.initialAdminEmails.length === 0) {
        return fail('config.initialAdminEmails 為空或不是陣列');
    }
    const lower = obj.initialAdminEmails.map(e => (e || '').toLowerCase());
    const dup   = lower.filter((e, i) => lower.indexOf(e) !== i);
    if (dup.length) warn(`initialAdminEmails 有重複：${[...new Set(dup)].join(', ')}`);
    ok(`config.initialAdminEmails = ${obj.initialAdminEmails.length} 筆`);
    ok(`schoolName = ${obj.schoolName || '(未設定)'}`);
}

async function checkTeachers() {
    console.log('▶ Teachers');
    const teachers = await listAll(`schools/${SCHOOL_ID}/teachers`);
    if (teachers.length === 0) warn('teachers 集合為空（尚未匯入課表）');
    const emailMap = new Map();
    for (const t of teachers) {
        const { fail: f, warn: w } = reporterFor(t);

        if (t.email) {
            const key = t.email.toLowerCase();
            if (emailMap.has(key)) {
                const other = emailMap.get(key);
                f(
                    `email 重複：${t.email}\n` +
                    `        → ${other._id}｜name=${other.name || '—'}｜role=${other.role || '—'}｜authProvider=${other.authProvider || '—'}｜createdAt=${other.createdAt || '—'}\n` +
                    `        → ${t._id}｜name=${t.name || '—'}｜role=${t.role || '—'}｜authProvider=${t.authProvider || '—'}｜createdAt=${t.createdAt || '—'}`
                );
            }
            emailMap.set(key, t);
        }

        if (t.role) {
            const normalized = normalizeRole(t.role);
            if (!VALID_ROLES.includes(normalized)) {
                f(`teacher ${t._id} role 非法：${t.role}`);
            } else if (LEGACY_ROLE_ALIAS[t.role]) {
                w(`teacher ${t._id} role 為舊值「${t.role}」，建議遷移為「${normalized}」`);
            }
        }
        if (!t.name) f(`teacher ${t._id} 缺 name`);
    }
    const approverCount = teachers.filter(t => APPROVER_ROLES.includes(normalizeRole(t.role))).length;
    ok(`共 ${teachers.length} 位教師，director/section_chief ${approverCount} 位，已綁 email ${emailMap.size} 位`);
    return teachers;
}

async function checkUserMappings(teachers) {
    console.log('▶ UserMappings');
    const mappings   = await listAll(`schools/${SCHOOL_ID}/userMappings`);
    const teacherIds = new Set(teachers.map(t => t._id));
    for (const m of mappings) {
        const { fail: f } = reporterFor(m);
        if (!m.linkedTeacherId) {
            f(`mapping ${m._id} 缺 linkedTeacherId`);
            continue;
        }
        if (!teacherIds.has(m.linkedTeacherId)) {
            f(`mapping ${m._id} 指向不存在的 teacher: ${m.linkedTeacherId}`);
        }
    }
    ok(`共 ${mappings.length} 筆 userMappings`);
}

async function checkPending() {
    console.log('▶ PendingRequests');
    const pending = await listAll(`schools/${SCHOOL_ID}/pendingRequests`);
    for (const p of pending) {
        const { fail: f, warn: w } = reporterFor(p);

        if (!p.initiatedBy) f(`pending ${p._id} 缺 initiatedBy`);

        if (REQUIRE_APPROVER_ID_STATUSES.has(p.status) && !p.requiredApproverId) {
            f(`pending ${p._id} 缺 requiredApproverId（status=${p.status}，此階段應已指定）`);
        }

        if (!VALID_REQUEST_STATUSES.includes(p.status)) {
            w(`pending ${p._id} status 非法：${p.status}（合法值：${VALID_REQUEST_STATUSES.join(' / ')}）`);
        }

        if (p.requestType && !VALID_REQUEST_TYPES.includes(p.requestType)) {
            f(`pending ${p._id} requestType 非法：${p.requestType}`);
        }

        const isSwapLike = p.requestType === REQUEST_TYPES.SWAP || p.requestType === REQUEST_TYPES.MULTI_SWAP;
        if (isSwapLike && p.status === REQUEST_STATUS.PENDING_SWAP_CONSENT
            && (!Array.isArray(p.pendingConsentTeacherIds) || p.pendingConsentTeacherIds.length === 0)) {
            f(`pending ${p._id}（${p.requestType}）status=pending_swap_consent 但 pendingConsentTeacherIds 缺漏或為空`);
        }
    }
    ok(`共 ${pending.length} 筆 pendingRequests`);
}

async function checkRecords() {
    console.log('▶ SubstituteRecords');
    const records = await listAll(`schools/${SCHOOL_ID}/substituteRecords`);
    for (const r of records) {
        const { fail: f, warn: w } = reporterFor(r);
        if (!r.date)   f(`record ${r._id} 缺 date`);
        if (!r.period) f(`record ${r._id} 缺 period`);
        if (r.status && r.status !== REQUEST_STATUS.APPROVED) {
            w(`record ${r._id} status=${r.status}（預期 ${REQUEST_STATUS.APPROVED}）`);
        }
    }
    ok(`共 ${records.length} 筆 substituteRecords`);
}

async function checkLogs() {
    console.log('▶ OperationLogs（最近 50 筆）');
    const logs = await listAll(`schools/${SCHOOL_ID}/operationLogs`);
    logs.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const recent = logs.slice(0, 50);
    let missingActor = 0;
    for (const l of recent) {
        const { fail: f } = reporterFor(l);
        if (!l.action) f(`log ${l._id} 缺 action`);
        if (!l.actor || !l.actor.uid) missingActor++;
    }
    if (missingActor > 0) warn(`最近 50 筆有 ${missingActor} 筆 actor.uid 為 null（多為 login_denied 系統事件，可接受）`);
    ok(`共 ${logs.length} 筆 logs，最近時間：${recent[0]?.timestamp || '—'}`);
}

(async () => {
    console.log(`🏫 檢查對象：schools/${SCHOOL_ID}（專案 ${PROJECT}）\n`);

    ({ VALID_ROLES, LEGACY_ROLE_ALIAS, APPROVER_ROLES, normalizeRole, REQUEST_STATUS, REQUEST_TYPES }
        = await loadSchemaConstants());
    VALID_REQUEST_STATUSES = Object.values(REQUEST_STATUS);
    VALID_REQUEST_TYPES    = Object.values(REQUEST_TYPES);
    // requiredApproverId 只在「approver 已進場」的狀態才檢查（見 pendingRequestService.js 狀態機註解）：
    //   - legacy 'pending'：normalizeLegacyRequest 靠此欄位反推 pendingConsentTeacherIds，缺了同意流程失效。
    //   - pending_approval / approved：已離開等同意階段；createRequest 建立時即會寫入
    //     （僅 isSelfSwap 給 null，但 isSelfSwap 直接寫 substituteRecords、不會出現在 pendingRequests）。
    //   - pending_swap_consent：approver 尚未進場，gating 依 pendingConsentTeacherIds 陣列，不查。
    //   - rejected：可能在同意階段或核准階段被拒，無法判斷是否已進 approver 階段，不查以避免誤判。
    REQUIRE_APPROVER_ID_STATUSES = new Set([
        REQUEST_STATUS.PENDING,
        REQUEST_STATUS.PENDING_APPROVAL,
        REQUEST_STATUS.APPROVED,
    ]);

    try {
        await checkConfig();
        const teachers = await checkTeachers();
        await checkUserMappings(teachers);
        await checkPending();
        await checkRecords();
        await checkLogs();
    } catch (e) {
        console.error('❌ 檢查中斷：', e.message);
        process.exit(2);
    }

    console.log('\n--- 結果 ---');
    const fails = issues.filter(i => i.level === 'FAIL');
    const warns = issues.filter(i => i.level === 'WARN');

    if (fails.length === 0 && warns.length === 0) {
        console.log('✅ 全部通過');
    } else {
        fails.forEach(i => console.log(`❌ FAIL  ${i.msg}`));
        warns.forEach(i => console.log(`⚠️  WARN  ${i.msg}`));
    }
    if (testDataNotes.length) {
        if (VERBOSE) {
            console.log('\n--- 測試資料明細（已忽略，不計入正式問題）---');
            testDataNotes.forEach(msg => console.log(`ℹ️  INFO  ${msg}`));
        } else {
            console.log(`\n（測試資料另有 ${testDataNotes.length} 項被降級為 INFO，加 --verbose 看明細）`);
        }
    }
    console.log(`\n正式資料問題 ${fails.length + warns.length} 項／測試資料 ${testDataCount} 筆（已忽略）`);
    process.exit(fails.length > 0 ? 1 : 0);
})();
