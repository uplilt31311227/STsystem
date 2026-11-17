#!/usr/bin/env node
/**
 * 補設 config/main.directorEstablished（firestore.rules v2.17，P9 批次 A2，SB-L9）
 *
 * 背景：v2.17 起，config/main.directorEstablished === true 代表「這所學校已有正式主任」，initialAdminEmails
 * 白名單的主任權限（bootstrap 建教師檔、補登自己 role、isDirector／isApprover 的白名單後備）從此永久失效。
 * 旗標由前端在正式主任（教師檔 role 為 director、已有 mapping）下一次登入時自動補設；既有正式庫的學校已經有
 * 主任但還沒有這個旗標，部署 v2.17 後請先跑本腳本一次補上，白名單才會立刻失效（不必等主任下次登入）。
 *
 * 「已有正式主任」的判定（與 rules 的 isMember／isDirector 同標準，只看 Firestore 內容）：
 *   至少一份教師檔 role 為 director（或舊 admin）、有 email，且存在一份 userMappings 的 linkedTeacherId 指向它、
 *   mapping.email 與教師檔 email 相符（＝這位主任至少登入過一次，沒有失效的孤兒 mapping）。
 *   找不到這樣的主任時預設拒絕（否則白名單一關，學校只剩 platformAdmin 能管理）；確定要設再加 --force。
 *
 * 用法：
 *   node scripts/set-director-established.js --account=<gcloud 帳號> [--school=<id>] [--project=<id>]            # 預設 dry-run
 *   node scripts/set-director-established.js --account=<gcloud 帳號> --apply                                      # 實際寫入
 *   node scripts/set-director-established.js --account=<gcloud 帳號> --apply --force                              # 沒有已登入過的主任也強制設定
 *   （操作者帳號也可用環境變數 STSYSTEM_GCLOUD_ACCOUNT；emulator 以 FIRESTORE_EMULATOR_HOST=127.0.0.1:<埠> 指向本機，不需 gcloud）
 *
 * 旗標只進不退：rules 禁止 client 改回 false 或刪除；要重設只能用 Admin 憑證（本腳本不提供，需要時手動處理）。
 * 認證：gcloud auth print-access-token（Admin REST，不受 Security Rules 限制），與其他 scripts/ 相同。
 *
 * exit code：0 = 成功（含 dry-run、已設定過）；2 = 引數錯誤、API 失敗、或判定為「沒有正式主任」而拒絕。
 */
const safety = require('./lib/script-safety');

const argv = process.argv.slice(2);
const bad = safety.findUnknownFlags(argv, ['--apply', '--dry-run', '--dry-run=true', '--force'], ['--school=', '--project=', '--account=']);
if (bad.length) { console.error(`❌ 未知參數：${bad.join(' ')}`); process.exit(2); }

let TARGET, OPERATOR;
try {
    TARGET = safety.resolveTarget(process.env, safety.getArgValue(argv, 'project'));
    OPERATOR = safety.resolveOperatorAccount(argv, process.env, TARGET);
} catch (e) { console.error('❌ ' + e.message); process.exit(2); }
const PROJECT = TARGET.project;
const SCHOOL_ID = safety.getArgValue(argv, 'school') || 'inhu';
const MODE = safety.parseWriteMode(argv);
const FORCE = argv.includes('--force');

if (!/^[a-z][a-z0-9-]{3,29}$/.test(PROJECT)) { console.error(`❌ 專案 ID 格式不合法：${PROJECT}`); process.exit(2); }
if (!/^[a-z0-9_-]{1,50}$/.test(SCHOOL_ID)) { console.error(`❌ schoolId 格式不合法：${SCHOOL_ID}`); process.exit(2); }

safety.targetBanner(TARGET, { action: `補設 schools/${SCHOOL_ID}/config/main.directorEstablished`, apply: MODE.apply }).forEach(l => console.log(l));

const BASE = `${safety.databaseBase(TARGET)}/documents`;
const headers = () => ({ Authorization: `Bearer ${safety.getAccessToken(TARGET, OPERATOR)}`, 'Content-Type': 'application/json' });

async function getDoc(rel) {
    const res = await fetch(`${BASE}/${rel}`, { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} GET ${rel}\n${(await res.text()).slice(0, 300)}`);
    return res.json();
}

async function listCollection(rel) {
    let all = [];
    let pageToken;
    do {
        const qs = new URLSearchParams({ pageSize: '300' });
        if (pageToken) qs.set('pageToken', pageToken);
        const res = await fetch(`${BASE}/${rel}?${qs}`, { headers: headers() });
        if (res.status === 404) return all;
        if (!res.ok) throw new Error(`${res.status} GET ${rel}\n${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        if (data.documents) all = all.concat(data.documents);
        pageToken = data.nextPageToken;
    } while (pageToken);
    return all;
}

const docId = (d) => d.name.split('/').pop();
const str = (d, k) => (d.fields && d.fields[k] && typeof d.fields[k].stringValue === 'string') ? d.fields[k].stringValue : null;
const norm = (s) => (s || '').toLowerCase().trim();

/** 純函式（可單元測試）：從教師檔與 mapping 找出「正式主任」（教師檔 director/admin + 有效 mapping）。 */
function findFormalDirectors(teacherDocs, mappingDocs) {
    const byTeacher = new Map(teacherDocs.map(t => [docId(t), t]));
    const out = [];
    for (const m of mappingDocs) {
        const tid = str(m, 'linkedTeacherId');
        const t = tid && byTeacher.get(tid);
        if (!t) continue;
        const role = str(t, 'role');
        if (role !== 'director' && role !== 'admin') continue;
        const tEmail = norm(str(t, 'email'));
        if (!tEmail || norm(str(m, 'email')) !== tEmail) continue;
        out.push({ teacherId: tid, name: str(t, 'name') || '', email: tEmail, uid: docId(m) });
    }
    return out;
}

async function main() {
    console.log(`🏫 對象：schools/${SCHOOL_ID}（專案 ${PROJECT}）\n`);
    const cfg = await getDoc(`schools/${SCHOOL_ID}/config/main`);
    if (!cfg) { console.error(`❌ 找不到 schools/${SCHOOL_ID}/config/main，請確認 --school= 與專案`); process.exit(2); }
    if (cfg.fields?.directorEstablished?.booleanValue === true) {
        console.log('✓ directorEstablished 已經是 true，無需動作。');
        return;
    }

    const teachers = await listCollection(`schools/${SCHOOL_ID}/teachers`);
    const mappings = await listCollection(`schools/${SCHOOL_ID}/userMappings`);
    const directors = findFormalDirectors(teachers, mappings);
    console.log(`▶ 教師檔 ${teachers.length} 筆、userMappings ${mappings.length} 筆`);
    console.log(`▶ 正式主任（教師檔為 director/admin 且有效 mapping）：${directors.length} 位`);
    directors.forEach(d => console.log(`   - ${d.name || '(無姓名)'}  teacherId=${d.teacherId}  uid=${d.uid}`));

    if (directors.length === 0 && !FORCE) {
        console.error('\n❌ 拒絕設定：這所學校目前沒有「已登入過的正式主任」。旗標一旦設為 true，白名單主任立刻失效，' +
            '學校將只剩 platformAdmin 能管理。請先讓正式主任登入一次，或確定要設定時加 --force。');
        process.exit(2);
    }
    if (directors.length === 0) console.log('\n⚠️  --force：沒有正式主任仍要設定旗標（白名單將失效，只剩 platformAdmin 後備）。');

    console.log(`\n📋 計畫：schools/${SCHOOL_ID}/config/main 設定 directorEstablished = true（其餘欄位不動，只更新 updatedAt）`);
    if (MODE.dryRun) {
        console.log('🚧 dry-run（預設）：不會寫入。確認無誤後加上 --apply 才會實際執行。');
        return;
    }
    const qs = 'updateMask.fieldPaths=directorEstablished&updateMask.fieldPaths=updatedAt';
    const res = await fetch(`${BASE}/schools/${SCHOOL_ID}/config/main?${qs}`, {
        method: 'PATCH', headers: headers(),
        body: JSON.stringify({ fields: { directorEstablished: { booleanValue: true }, updatedAt: { stringValue: new Date().toISOString() } } }),
    });
    if (!res.ok) throw new Error(`${res.status} PATCH config/main\n${(await res.text()).slice(0, 300)}`);
    console.log('✅ 已設定 directorEstablished = true，白名單主任已失效。');
}

if (require.main === module) {
    main().catch(e => { console.error('❌ 中斷：', e.message); process.exit(2); });
}
module.exports = { findFormalDirectors };
