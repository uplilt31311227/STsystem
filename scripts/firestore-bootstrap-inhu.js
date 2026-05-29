#!/usr/bin/env node
/**
 * Firestore v2.0.0 schools/inhu 環境 bootstrap
 *
 * 用法：
 *   node scripts/firestore-bootstrap-inhu.js                       # 確保 config + 主任白名單存在
 *   node scripts/firestore-bootstrap-inhu.js --add-teacher          # 新增 / 更新一名教師
 *      --name "姓名" --email a@b.com --role section_chief
 *      [--domains 國文,英文] [--homeroom 801]
 *
 * 設計原則 (idempotent)：
 *   - config/main 已存在則保留 initialAdminEmails 與 schoolName，僅補入缺漏欄位
 *   - 教師若 email 已存在則只更新 role / domains / homeroomClass（不重複建立）
 *   - teacherId 不存在則自動產生 teacher_<timestamp>
 *
 * 認證：透過 gcloud auth print-access-token --account=uplilt31311227@gmail.com
 *      （需先 gcloud auth login 完成）
 */
const { execSync } = require('child_process');

const PROJECT   = 'stsystem-9d5fe';
const SCHOOL_ID = 'inhu';
const BASE      = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const DEFAULT_DIRECTOR_EMAIL = 'uplilt31311227@gmail.com';
const DEFAULT_SCHOOL_NAME    = '新竹市立內湖國民中學';
const DEFAULT_SEMESTER       = '114-2';

function getToken() {
    return execSync(`gcloud auth print-access-token --account=${DEFAULT_DIRECTOR_EMAIL}`)
        .toString().trim();
}

function buildHeaders(token) {
    return {
        Authorization:       `Bearer ${token}`,
        'Content-Type':      'application/json',
        'X-Goog-User-Project': PROJECT,
    };
}

async function get(docPath) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${docPath}`, { headers: buildHeaders(token) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} GET ${docPath}\n${(await res.text()).slice(0, 200)}`);
    return res.json();
}

async function patchDoc(docPath, fields, updateMask) {
    const token = getToken();
    const url   = new URL(`${BASE}/${docPath}`);
    if (updateMask) {
        for (const f of updateMask) url.searchParams.append('updateMask.fieldPaths', f);
    }
    const res = await fetch(url, {
        method:  'PATCH',
        headers: buildHeaders(token),
        body:    JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`${res.status} PATCH ${docPath}\n${(await res.text()).slice(0, 300)}`);
    return res.json();
}

async function runQuery(parent, query) {
    const token = getToken();
    const res   = await fetch(`${BASE}${parent ? '/' + parent : ''}:runQuery`, {
        method:  'POST',
        headers: buildHeaders(token),
        body:    JSON.stringify(query),
    });
    if (!res.ok) throw new Error(`${res.status} runQuery\n${(await res.text()).slice(0, 200)}`);
    return res.json();
}

/* ===== Firestore value 包裝 ===== */

const v = {
    str:   s => ({ stringValue: s ?? '' }),
    bool:  b => ({ booleanValue: !!b }),
    arr:   a => ({ arrayValue: { values: (a || []).map(v.str) } }),
    nul:   () => ({ nullValue: null }),
    time:  t => ({ timestampValue: t || new Date().toISOString() }),
};

function unwrap(field) {
    if (!field) return null;
    if ('stringValue'    in field) return field.stringValue;
    if ('booleanValue'   in field) return field.booleanValue;
    if ('arrayValue'     in field) return (field.arrayValue.values || []).map(unwrap);
    if ('timestampValue' in field) return field.timestampValue;
    if ('nullValue'      in field) return null;
    return null;
}

function docFieldsToObj(doc) {
    if (!doc?.fields) return {};
    return Object.fromEntries(Object.entries(doc.fields).map(([k, val]) => [k, unwrap(val)]));
}

/* ===== Bootstrap 動作 ===== */

async function ensureConfig() {
    const existing = await get(`schools/${SCHOOL_ID}/config/main`);
    if (existing) {
        const data  = docFieldsToObj(existing);
        const emails = data.initialAdminEmails || [];
        const needAdd = !emails.includes(DEFAULT_DIRECTOR_EMAIL);
        if (!needAdd) {
            console.log(`✓ schools/${SCHOOL_ID}/config/main 已存在且主任白名單就緒`);
            return data;
        }
        const merged = Array.from(new Set([...emails, DEFAULT_DIRECTOR_EMAIL]));
        await patchDoc(`schools/${SCHOOL_ID}/config/main`, {
            initialAdminEmails: v.arr(merged),
            updatedAt:          v.time(),
        }, ['initialAdminEmails', 'updatedAt']);
        console.log(`✓ 已補入主任 ${DEFAULT_DIRECTOR_EMAIL} 到 initialAdminEmails`);
        return { ...data, initialAdminEmails: merged };
    }

    console.log(`🛠  建立 schools/${SCHOOL_ID}/config/main`);
    const fields = {
        schoolName:         v.str(DEFAULT_SCHOOL_NAME),
        currentSemester:    v.str(DEFAULT_SEMESTER),
        initialAdminEmails: v.arr([DEFAULT_DIRECTOR_EMAIL]),
        createdAt:          v.time(),
        updatedAt:          v.time(),
    };
    await patchDoc(`schools/${SCHOOL_ID}/config/main`, fields);
    console.log(`   ✓ 學校：${DEFAULT_SCHOOL_NAME}（白名單：${DEFAULT_DIRECTOR_EMAIL}）`);
    return null;
}

async function findTeacherByEmail(email) {
    const normalized = (email || '').toLowerCase().trim();
    if (!normalized) return null;
    const result = await runQuery(`schools/${SCHOOL_ID}`, {
        structuredQuery: {
            from: [{ collectionId: 'teachers' }],
            where: {
                fieldFilter: {
                    field: { fieldPath: 'email' },
                    op:    'EQUAL',
                    value: { stringValue: normalized },
                },
            },
            limit: 1,
        },
    });
    const doc = (result || []).find(r => r.document)?.document;
    if (!doc) return null;
    return { teacherId: doc.name.split('/').pop(), ...docFieldsToObj(doc) };
}

async function upsertTeacher({ name, email, role, domains, homeroom }) {
    const normalizedEmail = (email || '').toLowerCase().trim() || null;
    const normalizedRole  = role || 'teacher';

    // 1) 嘗試找既有
    const existing = normalizedEmail ? await findTeacherByEmail(normalizedEmail) : null;

    const fields = {
        name:          v.str(name || normalizedEmail?.split('@')[0] || '未命名'),
        email:         normalizedEmail ? v.str(normalizedEmail) : v.nul(),
        role:          v.str(normalizedRole),
        domains:       v.arr(domains || []),
        homeroomClass: v.str(homeroom || ''),
        updatedAt:     v.time(),
    };

    if (existing) {
        // 更新 role / domains / homeroomClass / name（email 不動，保留為比對鍵）
        const updateMask = ['name', 'role', 'domains', 'homeroomClass', 'updatedAt'];
        await patchDoc(`schools/${SCHOOL_ID}/teachers/${existing.teacherId}`, fields, updateMask);
        console.log(`✓ 教師 ${existing.teacherId.slice(-12)} 已更新（${existing.name} → ${name || existing.name}，role=${normalizedRole}）`);
        return { ...existing, ...fields, _action: 'updated' };
    }

    // 2) 新建
    const teacherId = 'teacher_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    fields.teacherId = v.str(teacherId);
    fields.createdAt = v.time();
    await patchDoc(`schools/${SCHOOL_ID}/teachers/${teacherId}`, fields);
    console.log(`✓ 教師 ${teacherId.slice(-12)} 已建立（${name}，email=${normalizedEmail}，role=${normalizedRole}）`);
    return { teacherId, _action: 'created' };
}

/* ===== CLI ===== */

function parseArgs() {
    const args = process.argv.slice(2);
    const flags = { addTeacher: false, name: null, email: null, role: 'teacher', domains: [], homeroom: '' };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--add-teacher') flags.addTeacher = true;
        else if (a === '--name')    flags.name = args[++i];
        else if (a === '--email')   flags.email = args[++i];
        else if (a === '--role')    flags.role = args[++i];
        else if (a === '--domains') flags.domains = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--homeroom') flags.homeroom = args[++i];
    }
    return flags;
}

async function main() {
    const flags = parseArgs();

    console.log(`📡 Firestore bootstrap → schools/${SCHOOL_ID}（專案 ${PROJECT}）\n`);

    await ensureConfig();

    if (flags.addTeacher) {
        if (!flags.email) throw new Error('--add-teacher 需要 --email');
        const validRoles = ['director', 'section_chief', 'teacher', 'admin'];
        if (!validRoles.includes(flags.role)) {
            throw new Error(`--role 必須是 ${validRoles.join(' / ')}`);
        }
        await upsertTeacher({
            name:     flags.name,
            email:    flags.email,
            role:     flags.role,
            domains:  flags.domains,
            homeroom: flags.homeroom,
        });
    }

    console.log('\n✅ 完成。');
}

main().catch(e => { console.error('\n❌ 失敗：', e.message); process.exit(1); });
