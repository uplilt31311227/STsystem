#!/usr/bin/env node
/**
 * Firestore V2 健康檢查
 *
 * 驗證 schools/default 結構與資料是否符合預期，列出潛在問題。
 *
 * 用法：node scripts/firestore-health-check.js [--verbose]
 *
 * 檢查項：
 *   1. config/main 存在且 initialAdminEmails 為非空陣列
 *   2. 每位 teacher 的 email 唯一、role ∈ {admin, teacher}
 *   3. 每筆 userMapping 對應的 linkedTeacherId 確實存在
 *   4. pendingRequests 必備欄位 (initiatedBy, requiredApproverId, status)
 *   5. substituteRecords 必備欄位 (status, date, period)
 *   6. operationLogs 最近 50 筆 actor 欄位完整
 */
const { execSync } = require('child_process');

const PROJECT  = 'stsystem-9d5fe';
const BASE     = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const VERBOSE  = process.argv.includes('--verbose');

const issues = [];
function fail(msg)  { issues.push({ level: 'FAIL', msg }); }
function warn(msg)  { issues.push({ level: 'WARN', msg }); }
function ok(msg)    { if (VERBOSE) console.log(`  ✓ ${msg}`); }

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
    const cfg = await api('schools/default/config/main');
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
    const teachers = await listAll('schools/default/teachers');
    if (teachers.length === 0) warn('teachers 集合為空（尚未匯入課表）');
    const emailMap = new Map();
    for (const t of teachers) {
        if (t.email) {
            const key = t.email.toLowerCase();
            if (emailMap.has(key)) {
                fail(`email 重複：${t.email} 對應 ${emailMap.get(key)} 與 ${t._id}`);
            }
            emailMap.set(key, t._id);
        }
        if (t.role && !['admin', 'teacher'].includes(t.role)) {
            fail(`teacher ${t._id} role 非法：${t.role}`);
        }
        if (!t.name) fail(`teacher ${t._id} 缺 name`);
    }
    const admins = teachers.filter(t => t.role === 'admin');
    ok(`共 ${teachers.length} 位教師，admin ${admins.length} 位，已綁 email ${emailMap.size} 位`);
    return teachers;
}

async function checkUserMappings(teachers) {
    console.log('▶ UserMappings');
    const mappings = await listAll('schools/default/userMappings');
    const teacherIds = new Set(teachers.map(t => t._id));
    for (const m of mappings) {
        if (!m.linkedTeacherId) {
            fail(`mapping ${m._id} 缺 linkedTeacherId`);
            continue;
        }
        if (!teacherIds.has(m.linkedTeacherId)) {
            fail(`mapping ${m._id} 指向不存在的 teacher: ${m.linkedTeacherId}`);
        }
    }
    ok(`共 ${mappings.length} 筆 userMappings`);
}

async function checkPending() {
    console.log('▶ PendingRequests');
    const pending = await listAll('schools/default/pendingRequests');
    for (const p of pending) {
        if (!p.initiatedBy) fail(`pending ${p._id} 缺 initiatedBy`);
        if (!p.requiredApproverId) fail(`pending ${p._id} 缺 requiredApproverId`);
        if (!['pending', 'rejected'].includes(p.status)) {
            warn(`pending ${p._id} status=${p.status}（規則僅期望 pending/rejected）`);
        }
    }
    ok(`共 ${pending.length} 筆 pendingRequests`);
}

async function checkRecords() {
    console.log('▶ SubstituteRecords');
    const records = await listAll('schools/default/substituteRecords');
    for (const r of records) {
        if (!r.date)   fail(`record ${r._id} 缺 date`);
        if (!r.period) fail(`record ${r._id} 缺 period`);
        if (r.status && r.status !== 'approved') {
            warn(`record ${r._id} status=${r.status}（預期 approved）`);
        }
    }
    ok(`共 ${records.length} 筆 substituteRecords`);
}

async function checkLogs() {
    console.log('▶ OperationLogs（最近 50 筆）');
    const logs = await listAll('schools/default/operationLogs');
    logs.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    const recent = logs.slice(0, 50);
    let missingActor = 0;
    for (const l of recent) {
        if (!l.action) fail(`log ${l._id} 缺 action`);
        if (!l.actor || !l.actor.uid) missingActor++;
    }
    if (missingActor > 0) warn(`最近 50 筆有 ${missingActor} 筆 actor.uid 為 null（多為 login_denied 系統事件，可接受）`);
    ok(`共 ${logs.length} 筆 logs，最近時間：${recent[0]?.timestamp || '—'}`);
}

(async () => {
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
        process.exit(0);
    }
    fails.forEach(i => console.log(`❌ FAIL  ${i.msg}`));
    warns.forEach(i => console.log(`⚠️  WARN  ${i.msg}`));
    process.exit(fails.length > 0 ? 1 : 0);
})();
