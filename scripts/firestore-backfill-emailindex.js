#!/usr/bin/env node
/**
 * Stage 0（見 docs/RESEARCH-multitenancy-semester.md §3.4a、§8 Stage 0）
 * emailIndex 回填腳本
 *
 * 背景：firestore.rules 的 teachers 讀取規則即將從「任何登入者」收緊為
 * 「isMember(schoolId)」（成員限定），首登（尚無 userMappings）教師改靠
 * schools/{schoolId}/emailIndex/{email} 配對 teacherId（見 authGuardV2.js resolveIdentity）。
 * 新規則部署後，existing teachers 若沒有對應的 emailIndex 條目，會直接卡在首登——
 * 必須先跑本腳本回填，才能部署 firestore.rules（見 docs/STAGE0-DEPLOY.md 的上線順序）。
 *
 * 用法：
 *   node scripts/firestore-backfill-emailindex.js --dry-run [--school=<id>]
 *   node scripts/firestore-backfill-emailindex.js [--school=<id>]
 *
 *   --school:   指定 schoolId，預設 inhu（正式資料所在）。
 *   --dry-run:  只列出將建立/更新的 emailIndex 條目與衝突，不寫入任何資料。
 *               （本腳本目前只在此模式下被實際執行過，正式寫入前務必先跑一次 --dry-run 核對。）
 *
 * 邏輯（比照 scripts/firestore-bootstrap-inhu.js 的 idempotent 設計）：
 *   1. 列出 schools/{schoolId}/teachers 全部教師。
 *   2. 依 email（正規化為小寫、trim）分組：
 *      - 同一 email 被兩筆以上教師檔佔用 → 記為 CONFLICT，不寫入該 email 的索引，
 *        需人工判斷孤兒檔（比對 docs/ISSUES_LOG.md 教師防重修復紀錄）後再重跑。
 *      - 未填 email 的教師 → 略過（沒有登入配對需求）。
 *   3. 對每個唯一 email：
 *      - emailIndex/{email} 不存在 → 待建立（CREATE）。
 *      - 已存在但 teacherId 不同 → 待更新（UPDATE，以 teachers 集合現況為準）。
 *      - 已存在且 teacherId 相同 → 略過（SKIP，已同步）。
 *   4. --dry-run 只印統計與明細；未帶 --dry-run 才會實際 PATCH 寫入。
 *
 * 認證：透過 gcloud auth print-access-token --account=uplilt31311227@gmail.com
 *      （需先 gcloud auth login 完成）
 *
 * 驗收修復 S4（encodeURIComponent vs client 端字面串接的文件 ID 一致性）：
 *   本腳本用 REST API 寫入，URL 路徑對 email 做 encodeURIComponent（例如
 *   foo@bar.com → foo%40bar.com）；client 端（schoolDataService.js 透過
 *   schemaConstants.emailIndexDoc）用 Firebase JS SDK 的 doc(db, path)，
 *   直接把 email 原文字串當成路徑片段，完全不做 URL 編碼。
 *   結論：兩者寫入的是同一個文件 ID。理由：encodeURIComponent 只是 HTTP 請求列
 *   （Request-URI）的傳輸層編碼，Google 的 REST 端點（與所有標準 HTTP 路由一致）
 *   在解析路徑時會先對每個路徑片段做 percent-decoding，還原成原文字串才當作
 *   Firestore 文件 ID 使用——這與 Firestore REST API 回應中的 `name` 欄位一律是
 *   未編碼原文（例如 ".../emailIndex/foo@bar.com"，不是 "...%40...") 一致，也與
 *   Firebase JS SDK 內部把路徑片段當純字串處理（不做 URL 編碼）的行為對齊。
 *   本專案內沒有既有的「文件 ID 含保留字元」案例可直接拿來實測比對（teacherId 等
 *   既有 ID 都是不含特殊字元的 tch_/req_ 前綴字串），且依規則不可對正式庫做任何
 *   寫入測試，故此結論基於 HTTP/REST 標準路徑解碼行為推導，未能實機驗證雙寫一致。
 *   保險起見兩件事仍照驗收要求做：(a) 下方 CREATE/UPDATE 明細與正式寫入 log 都印出
 *   「doc id（原文）」欄供人工核對；(b) docs/STAGE0-DEPLOY.md 新增一步「回填後到
 *   Firebase Console 目視確認文件 ID 顯示為 xxx@yyy、不含 %40」，作為此結論的
 *   實機驗證關卡，不是單純相信本段推導。
 *
 * exit code：0 = 成功且無 CONFLICT；1 = 執行完成但有 CONFLICT 待人工處理；
 *            2 = 執行中斷（取不到 token、API 失敗等）
 */
const { execSync } = require('child_process');

const PROJECT   = 'stsystem-9d5fe';
const SCHOOL_ID = process.argv.find(a => a.startsWith('--school='))?.split('=')[1] || 'inhu';
const DRY_RUN   = process.argv.includes('--dry-run');
const BASE      = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function getToken() {
    return execSync('gcloud auth print-access-token --account=uplilt31311227@gmail.com')
        .toString().trim();
}

function buildHeaders(token) {
    return {
        Authorization:         `Bearer ${token}`,
        'Content-Type':        'application/json',
        'X-Goog-User-Project': PROJECT,
    };
}

/* ===== Firestore REST 輔助 ===== */

async function apiGet(docPath) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${docPath}`, { headers: buildHeaders(token) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} GET ${docPath}\n${(await res.text()).slice(0, 300)}`);
    return res.json();
}

async function apiPatch(docPath, fields) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${docPath}`, {
        method:  'PATCH',
        headers: buildHeaders(token),
        body:    JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`${res.status} PATCH ${docPath}\n${(await res.text()).slice(0, 300)}`);
    return res.json();
}

async function listCollection(collectionPath) {
    let all = [];
    let pageToken;
    do {
        const token = getToken();
        const qs    = new URLSearchParams({ pageSize: '300' });
        if (pageToken) qs.set('pageToken', pageToken);
        const res  = await fetch(`${BASE}/${collectionPath}?${qs.toString()}`, { headers: buildHeaders(token) });
        if (!res.ok) throw new Error(`${res.status} LIST ${collectionPath}\n${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        if (data.documents) all = all.concat(data.documents);
        pageToken = data.nextPageToken;
    } while (pageToken);
    return all;
}

function docId(doc) {
    return doc.name.split('/').pop();
}

function unwrap(field) {
    if (!field) return null;
    if ('stringValue'  in field) return field.stringValue;
    if ('booleanValue' in field) return field.booleanValue;
    if ('arrayValue'   in field) return (field.arrayValue.values || []).map(unwrap);
    if ('timestampValue' in field) return field.timestampValue;
    if ('nullValue'    in field) return null;
    return null;
}

function docFieldsToObj(doc) {
    if (!doc?.fields) return {};
    return Object.fromEntries(Object.entries(doc.fields).map(([k, val]) => [k, unwrap(val)]));
}

const v = { str: s => ({ stringValue: s ?? '' }) };

/* ===== 主邏輯 ===== */

/** 依 email（正規化）分組教師；回傳 { byEmail: Map<email, teacher[]>, skipped: number }。 */
function groupByEmail(teachers) {
    const byEmail = new Map();
    let skipped = 0;
    for (const t of teachers) {
        const email = (t.email || '').toLowerCase().trim();
        if (!email) { skipped++; continue; }
        if (!byEmail.has(email)) byEmail.set(email, []);
        byEmail.get(email).push(t);
    }
    return { byEmail, skipped };
}

async function main() {
    console.log(`📡 emailIndex 回填 → schools/${SCHOOL_ID}（專案 ${PROJECT}）${DRY_RUN ? '  [--dry-run，不寫入]' : ''}\n`);

    const teacherDocs = await listCollection(`schools/${SCHOOL_ID}/teachers`);
    const teachers     = teacherDocs.map(d => ({ teacherId: docId(d), ...docFieldsToObj(d) }));
    console.log(`▶ 讀到 ${teachers.length} 筆教師檔\n`);

    const { byEmail, skipped } = groupByEmail(teachers);

    const toCreate = [];
    const toUpdate = [];
    const skippedInSync = [];
    const conflicts = [];

    for (const [email, list] of byEmail) {
        if (list.length > 1) {
            conflicts.push({ email, teacherIds: list.map(t => t.teacherId) });
            continue;
        }
        const teacherId = list[0].teacherId;
        const existing = await apiGet(`schools/${SCHOOL_ID}/emailIndex/${encodeURIComponent(email)}`);
        if (!existing) {
            toCreate.push({ email, teacherId });
        } else {
            const existingTeacherId = docFieldsToObj(existing).teacherId;
            if (existingTeacherId === teacherId) {
                skippedInSync.push({ email, teacherId });
            } else {
                toUpdate.push({ email, teacherId, from: existingTeacherId });
            }
        }
    }

    console.log('===== 回填計畫 =====');
    console.log(`  待建立（CREATE）：${toCreate.length} 筆`);
    for (const item of toCreate) console.log(`    + doc id（原文）= ${item.email}  → teacherId = ${item.teacherId}`);
    console.log(`  待更新（UPDATE，emailIndex 現有值與 teachers 現況不符）：${toUpdate.length} 筆`);
    for (const item of toUpdate) console.log(`    ~ doc id（原文）= ${item.email}  ${item.from} → ${item.teacherId}`);
    console.log(`  已同步（SKIP）：${skippedInSync.length} 筆`);
    console.log(`  未填 email 略過：${skipped} 筆`);
    console.log(`  ⚠ Email 衝突（同一 email 被 ${'>'}1 筆教師檔使用，需人工處理，未寫入）：${conflicts.length} 筆`);
    for (const c of conflicts) console.log(`    ! ${c.email}  被 ${c.teacherIds.join(', ')} 共用`);
    console.log('');
    console.log('※ 上面「doc id（原文）」欄是實際會寫入 Firestore 的文件 ID（不含 URL 編碼字元，');
    console.log('   例如含 @ 的 email 原樣是一個字元，不是 %40）。REST 請求 URL 內部會做');
    console.log('   encodeURIComponent 編碼（例如 foo@bar.com → foo%40bar.com），但這只是 HTTP');
    console.log('   傳輸層的路徑編碼，Firestore 伺服器收到後會還原成原文字串才建立文件——');
    console.log('   與 client SDK 的 doc(db, `.../emailIndex/${email}`)（直接用原文字串定址，');
    console.log('   完全不做 URL 編碼）寫入的是同一個文件 ID，兩側不會產生「%40 vs @」的不一致。');
    console.log('   正式回填後請務必到 Firebase Console → Firestore → emailIndex 目視確認');
    console.log('   文件 ID 顯示為 xxx@yyy 的原文字串，不是 xxx%40yyy（見 docs/STAGE0-DEPLOY.md）。');
    console.log('');

    if (DRY_RUN) {
        console.log('（--dry-run：僅顯示計畫，不會寫入。確認無誤後移除 --dry-run 才會實際回填）');
        process.exit(conflicts.length > 0 ? 1 : 0);
    }

    console.log('⚠️  開始寫入 emailIndex...');
    let done = 0;
    for (const item of [...toCreate, ...toUpdate]) {
        await apiPatch(`schools/${SCHOOL_ID}/emailIndex/${encodeURIComponent(item.email)}`, {
            teacherId: v.str(item.teacherId),
        });
        done++;
        console.log(`  ✓ doc id（原文）= ${item.email} → teacherId = ${item.teacherId}`);
    }
    console.log(`\n✅ 回填完成，共寫入 ${done} 筆（略過 ${skippedInSync.length} 筆已同步、${conflicts.length} 筆衝突待人工處理）`);

    if (conflicts.length > 0) {
        console.log('\n⚠️  仍有 email 衝突未回填，這些教師在新規則下無法完成首登配對，部署規則前請先處理：');
        for (const c of conflicts) console.log(`    ${c.email}: ${c.teacherIds.join(', ')}`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch(e => {
    console.error('\n❌ 失敗：', e.message);
    process.exit(2);
});
