#!/usr/bin/env node
/**
 * Firestore V2 狀態快照
 *
 * 用法：node scripts/firestore-snapshot.js [which]
 *   which: all | teachers | pending | records | logs | mappings | config
 *
 * 透過 gcloud auth print-access-token --account=uplilt31311227@gmail.com
 * 取得 access token 後直接呼叫 Firestore REST API。
 */
const { execSync } = require('child_process');

const PROJECT = 'stsystem-9d5fe';
const BASE    = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function getToken() {
    return execSync('gcloud auth print-access-token --account=uplilt31311227@gmail.com')
        .toString().trim();
}

async function api(pathSuffix) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${pathSuffix}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`${res.status} ${pathSuffix}\n${txt.slice(0, 200)}`);
    }
    return res.json();
}

// 解 Firestore REST value 格式
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
    if ('nullValue'      in field) return null;
    return null;
}

function docToObj(doc) {
    const obj = { _id: doc.name.split('/').pop(), _updated: doc.updateTime };
    for (const [k, v] of Object.entries(doc.fields || {})) obj[k] = unwrap(v);
    return obj;
}

async function list(collectionPath) {
    const data = await api(collectionPath);
    return (data.documents || []).map(docToObj);
}

async function get(docPath) {
    try {
        const data = await api(docPath);
        return docToObj(data);
    } catch (e) {
        if (/^404/.test(e.message)) return null;
        throw e;
    }
}

function fmt(obj) {
    return JSON.stringify(obj, null, 2);
}

async function main() {
    const which = process.argv[2] || 'all';
    const sep   = '='.repeat(60);

    if (which === 'config' || which === 'all') {
        const cfg = await get('schools/default/config/main');
        console.log(`${sep}\nConfig (schools/default/config/main)\n${sep}`);
        console.log(fmt(cfg));
    }

    if (which === 'teachers' || which === 'all') {
        const teachers = await list('schools/default/teachers');
        console.log(`\n${sep}\nTeachers（${teachers.length} 位）\n${sep}`);
        teachers.forEach(t =>
            console.log(`  [${t._id.slice(-12)}] ${t.name}  | email=${t.email || '—'} | role=${t.role || '—'} | 領域=${(t.domains || []).join(',') || '—'}`)
        );
    }

    if (which === 'mappings' || which === 'all') {
        const maps = await list('schools/default/userMappings');
        console.log(`\n${sep}\nUserMappings（${maps.length} 筆）\n${sep}`);
        maps.forEach(m =>
            console.log(`  uid=${m._id.slice(0,10)}... | email=${m.email || '—'} | teacherId=${(m.linkedTeacherId || '').slice(-12)} | lastLogin=${m.lastLoginAt || '—'}`)
        );
    }

    if (which === 'pending' || which === 'all') {
        const pending = await list('schools/default/pendingRequests');
        console.log(`\n${sep}\nPendingRequests（${pending.length} 筆）\n${sep}`);
        pending.forEach(p =>
            console.log(`  [${p._id.slice(-10)}] status=${p.status || 'pending'} | ${p.date} ${p.period} ${p.className} | 發起=${p.initiatedByName} → 同意者=${p.requiredApproverName || '—'}`)
        );
    }

    if (which === 'records' || which === 'all') {
        const records = await list('schools/default/substituteRecords');
        console.log(`\n${sep}\nSubstituteRecords（${records.length} 筆）\n${sep}`);
        records.slice(0, 10).forEach(r =>
            console.log(`  [${r._id.slice(-10)}] ${r.date} ${r.period} ${r.className} | ${r.type} | ${r.originalTeacher} → ${r.substituteTeacher || r.swapTeacher || '—'} | 發起=${r.initiatedByName}`)
        );
        if (records.length > 10) console.log(`  ...（還有 ${records.length - 10} 筆）`);
    }

    if (which === 'logs' || which === 'all') {
        const logs = await list('schools/default/operationLogs');
        logs.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
        console.log(`\n${sep}\nOperationLogs（${logs.length} 筆，最新 8）\n${sep}`);
        logs.slice(0, 8).forEach(l =>
            console.log(`  ${(l.timestamp || '').slice(0, 19)} | ${l.actor?.name || '—'} (${l.actor?.role || '—'}) | ${l.action} | target=${l.targetType}`)
        );
    }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
