#!/usr/bin/env node
/**
 * 孤兒 userMappings 清理（身分與授權修補 v2.12，審計 H2「mapping 永不撤銷」的資料面收尾）
 *
 * 背景：firestore.rules v2.12 起，成員資格要求「mapping 指向的教師檔存在，且該教師檔的 email 與登入者
 * email 相符」，孤兒 mapping 因此已經不再賦予任何存取權限；schoolDataService.deleteTeacher／
 * updateTeacher(email 異動) 也會在同一個 batch 內一併刪除對應 mapping。但上線「之前」已經殘留的孤兒
 * mapping（教師被刪除、email 被改掉而留下的）仍躺在資料庫裡——本腳本把它們列出來並可清掉。
 *
 * 孤兒的判定（只依 Firestore 內容，不查 Auth）：
 *   A. mapping.linkedTeacherId 指向的教師檔不存在；
 *   B. 教師檔存在，但 mapping.email 與教師檔 email（皆轉小寫比較）不相符
 *      （mapping.email 是登入時由前端寫入的登入者 email，見 authGuardV2.buildMappingPatch）。
 *   不判定為孤兒（只列在「無法判定」提醒，永遠不刪）：mapping 缺 linkedTeacherId、缺 email 欄位、
 *   或教師檔缺 email——資訊不足就不刪（fail-closed）。
 *
 * 用法：
 *   node scripts/cleanup-orphan-mappings.js [--school=<id>] [--project=<id>] [--yes]
 *
 *   --school:   指定 schoolId，預設 inhu（正式資料所在）。
 *   --project:  目標 Firebase 專案，預設正式專案 stsystem-9d5fe（與 firestore-backup.js 相同）。
 *   --yes:      實際執行刪除。不帶此旗標（預設）只列印孤兒清單與將刪除的筆數，不刪除任何資料。
 *               （比照 firestore-backup.js restore／cleanup-operation-logs.js 的 --yes 閘門慣例。）
 *
 * 行為：
 *   1. 印出目標專案（正式／非正式）、學校與模式。
 *   2. 列出 schools/{school}/teachers 與 userMappings 全部文件，依上面規則分類。
 *   3. 印出孤兒清單（uid、linkedTeacherId、mapping.email、判定原因）。
 *   4. 帶 --yes 且有孤兒時：先把這些 mapping 的完整原始文件備份到
 *      backups/firestore/orphan-mappings/<yyyymmdd-HHMMss>.json（格式同 firestore-backup.js：REST
 *      document 物件，可原樣 PATCH 回去還原），再逐筆 REST DELETE。
 *
 * 認證：與 firestore-backup.js 相同，用 `gcloud auth print-access-token` 取得操作者本人的 OAuth2
 * token，走 Firestore 標準 REST API，不受 Security Rules 限制（需要該帳號在專案上具備 Firestore 的
 * IAM 權限）。
 *
 * ⚠ 本檔只寫不執行（撰寫階段僅 node --check 語法檢查）。正式使用前先跑一次不帶 --yes 的模式，
 * 人工核對清單（特別是「email 不符」類——例如教師剛好改了 email 但尚未重新登入，這類 mapping 刪除後，
 * 該教師下次登入會走 emailIndex 自動重建 mapping，不會被鎖在門外）。
 *
 * exit code：0 = 成功（含預設只列印）；2 = 執行中斷（取不到 token、引數錯誤、API 失敗等）。
 */
const { execSync } = require('child_process');
const fs            = require('node:fs');
const path          = require('node:path');

/** 正式專案；測試站用 --project= 覆寫，避免把動作做錯邊。 */
const DEFAULT_PROJECT = 'stsystem-9d5fe';
const PROJECT   = process.argv.find(a => a.startsWith('--project='))?.split('=')[1] || DEFAULT_PROJECT;
const SCHOOL_ID = process.argv.find(a => a.startsWith('--school='))?.split('=')[1] || 'inhu';
const EXECUTE   = process.argv.includes('--yes');

// 與 firestore-backup.js 同款的專案 ID 驗證：Firebase 專案 ID 只會是小寫英數與連字號。
if (!/^[a-z][a-z0-9-]{3,29}$/.test(PROJECT)) {
    console.error(`❌ 專案 ID 格式不合法：${PROJECT}`);
    process.exit(2);
}
// schoolId 會被組進 REST 路徑，限制字元集避免路徑注入（與 firestore.rules 的 schoolId 白名單一致）。
if (!/^[a-z0-9_-]{1,50}$/.test(SCHOOL_ID)) {
    console.error(`❌ schoolId 格式不合法：${SCHOOL_ID}`);
    process.exit(2);
}

// 目標專案一律先印出來，免得動作做錯邊才發現。
console.log(PROJECT === DEFAULT_PROJECT
    ? `🎯 目標專案：${PROJECT}（正式）`
    : `🎯 目標專案：${PROJECT}（非正式專案）`);

const BASE        = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const BACKUP_ROOT = path.join(__dirname, '..', 'backups', PROJECT === DEFAULT_PROJECT ? 'firestore' : `firestore-${PROJECT}`, 'orphan-mappings');

function getToken() {
    return execSync('gcloud auth print-access-token --account=uplilt31311227@gmail.com')
        .toString().trim();
}

async function listCollection(collectionPath) {
    let all = [];
    let pageToken;
    do {
        const qs = new URLSearchParams({ pageSize: '300' });
        if (pageToken) qs.set('pageToken', pageToken);
        const res = await fetch(`${BASE}/${collectionPath}?${qs.toString()}`, { headers: { Authorization: `Bearer ${getToken()}` } });
        if (!res.ok) {
            if (res.status === 404) return all;
            throw new Error(`${res.status} ${collectionPath}\n${(await res.text()).slice(0, 300)}`);
        }
        const data = await res.json();
        if (data.documents) all = all.concat(data.documents);
        pageToken = data.nextPageToken;
    } while (pageToken);
    return all;
}

async function deleteDocByName(name) {
    const marker = '/documents/';
    const rel = name.slice(name.indexOf(marker) + marker.length);
    const res = await fetch(`${BASE}/${rel}`, { method: 'DELETE', headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error(`${res.status} DELETE ${rel}\n${(await res.text()).slice(0, 300)}`);
}

const docId = (doc) => doc.name.split('/').pop();
const strField = (doc, key) => {
    const v = doc.fields && doc.fields[key];
    return v && typeof v.stringValue === 'string' ? v.stringValue : null;
};
const norm = (s) => (s || '').toLowerCase().trim();

function timestampDirName() {
    const now = new Date();
    const p2  = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
}

async function main() {
    console.log(`🏫 對象：schools/${SCHOOL_ID}（專案 ${PROJECT}）`);
    console.log(`   模式：${EXECUTE ? '⚠️  實際刪除（--yes）' : '僅列印清單，不刪除（預設 dry-run）'}\n`);

    const teacherDocs = await listCollection(`schools/${SCHOOL_ID}/teachers`);
    const mappingDocs = await listCollection(`schools/${SCHOOL_ID}/userMappings`);
    const teachers = new Map(teacherDocs.map(d => [docId(d), d]));
    console.log(`▶ 教師檔 ${teachers.size} 筆、userMappings ${mappingDocs.length} 筆\n`);

    const orphans = [];
    const undecidable = [];
    for (const m of mappingDocs) {
        const uid = docId(m);
        const tid = strField(m, 'linkedTeacherId');
        const mEmail = strField(m, 'email');
        if (!tid) { undecidable.push({ uid, reason: '缺 linkedTeacherId' }); continue; }
        const t = teachers.get(tid);
        if (!t) { orphans.push({ doc: m, uid, tid, mEmail, reason: '教師檔不存在' }); continue; }
        const tEmail = strField(t, 'email');
        if (!mEmail) { undecidable.push({ uid, reason: `mapping 缺 email 欄位（指向 ${tid}）` }); continue; }
        if (!tEmail) { undecidable.push({ uid, reason: `教師檔 ${tid} 缺 email（無法比對）` }); continue; }
        if (norm(mEmail) !== norm(tEmail)) {
            orphans.push({ doc: m, uid, tid, mEmail, reason: `email 不符（mapping: ${mEmail}／教師檔: ${tEmail}）` });
        }
    }

    console.log(`孤兒 mapping：${orphans.length} 筆`);
    for (const o of orphans) {
        console.log(`  - uid=${o.uid}  linkedTeacherId=${o.tid}  mapping.email=${o.mEmail || '(無)'}\n      原因：${o.reason}`);
    }
    if (undecidable.length) {
        console.log(`\n無法判定（資訊不足，不刪除，請人工檢視）：${undecidable.length} 筆`);
        for (const u of undecidable) console.log(`  - uid=${u.uid}  ${u.reason}`);
    }

    if (orphans.length === 0) {
        console.log('\n✅ 沒有需要清理的孤兒 mapping');
        return;
    }

    if (!EXECUTE) {
        console.log(`\n（未帶 --yes：僅列印清單，不會刪除任何資料。確認清單無誤後加上 --yes 才會實際刪除這 ${orphans.length} 筆）`);
        return;
    }

    // 刪除前先備份完整原始文件（可原樣 PATCH 回去還原）
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    const backupFile = path.join(BACKUP_ROOT, `${timestampDirName()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({
        project: PROJECT, schoolId: SCHOOL_ID, count: orphans.length,
        documents: orphans.map(o => ({ reason: o.reason, document: o.doc })),
    }, null, 2), 'utf8');
    console.log(`\n📁 已備份將刪除的 ${orphans.length} 筆到：${backupFile}`);

    console.log(`⚠️  即將刪除 ${orphans.length} 筆孤兒 userMappings（專案 ${PROJECT}），開始...`);
    let done = 0;
    for (const o of orphans) {
        await deleteDocByName(o.doc.name);
        done++;
    }
    console.log(`✅ 已刪除 ${done} 筆`);
}

main().catch(e => {
    console.error('❌ 中斷：', e.message);
    process.exit(2);
});
