#!/usr/bin/env node
/**
 * operationLogs 離線清理（Stage 5，RESEARCH-multitenancy-semester.md §6.5 解法 (b)）
 *
 * 背景：firestore.rules 對 operationLogs 的 update/delete 恆為 `false`（稽核軌跡不可改／刪，
 * 見 firestore.rules `match /operationLogs/{logId}`）。這是刻意的資安設計——任何透過 client
 * SDK（Firebase Auth 登入的一般使用者，包含 director）發出的刪除請求都會被 Security Rules
 * 擋下。§6.5 選定的解法是：把「刪除權」綁在需要 gcloud 憑證的離線流程上，而不是放寬規則
 * ——放寬規則等於讓「最需要被稽核的角色（director）」同時擁有「刪除稽核軌跡」的能力，
 * 破壞稽核軌跡的核心性質（見報告 §6.5 表格「解法 (a)」欄的否決理由）。
 *
 * ⚠️ 核心前提（本次實作要求「核實此前提，在腳本註解說明」）：
 *   Firestore Security Rules **只適用於透過 Firebase Auth 認證、經由 client SDK／Firebase
 *   REST 的「行動應用程式端點」發出的請求**。本腳本呼叫的是 Firestore 的**標準 Google Cloud
 *   REST API**（`https://firestore.googleapis.com/v1/...`），並用 `gcloud auth print-access-token`
 *   取得**操作者本人 Google 帳號的 OAuth2 access token**（非 Firebase Auth ID token）。這個帳號
 *   在 GCP 專案 `stsystem-9d5fe` 上具備足以讀寫 Firestore 的 IAM 角色（Owner/Editor 或
 *   `roles/datastore.user` 等）——這類「具 IAM 權限的使用者或服務帳號」屬於 Firestore 官方
 *   文件所稱的「伺服器用戶端」存取路徑，**不受 Security Rules 限制**（Security Rules 是
 *   Mobile/Web client SDK 專屬的存取控制層，不是資料庫層級的 ACL）。
 *   本次未另外查證官方文件原文（不在本輪查證範圍內），但這個前提已經是本專案既有腳本
 *   實際運作的證據，不是推測：
 *     - `scripts/firestore-backup.js` 的 `restore` 子指令用同一套 `gcloud auth
 *       print-access-token` + REST PATCH，直接整份覆寫 `substituteRecords`/`pendingRequests`
 *       等文件——這些寫入若真的受 Security Rules 管，會被 update 規則的欄位白名單
 *       （`affectedKeys().hasOnly([...])`）擋下，但該腳本的還原流程本來就設計成「整份覆蓋
 *       任意欄位」，且從未因為規則擋下而失敗過。
 *     - `scripts/backfill-semester-id.js` 用同一套認證對 `substituteRecords` 等文件的既有
 *       欄位做 PATCH，這些文件的 `semesterId` 一旦寫入即受 `firestore.rules` 的學期唯讀鎖
 *       保護（`update` 規則要求 `semesterId` 不可變），但回填腳本本來就是要「補寫本來沒有
 *       這個欄位的舊文件」，同樣未被規則擋下。
 *   兩者都已在正式環境的部署流程中被當作可信賴的既定行為使用（見 `docs/STAGE0-DEPLOY.md`），
 *   本腳本沿用同一套認證與呼叫方式，據此推定同一前提對 DELETE 方法同樣成立。
 *   **若日後這個前提被證明有誤**（例如專案改用更嚴格的 IAM 綁定），本腳本會在執行 DELETE 時
 *   收到 403 permission-denied，屬顯性失敗、不會是靜默的部分成功。
 *
 * 用法：
 *   node scripts/cleanup-operation-logs.js --before=<YYYY-MM-DD> [--school=<id>] [--yes] [--dry-run]
 *
 *   --before:   必填。刪除 timestamp 早於這個日期（不含當天，UTC）的 operationLogs。
 *               timestamp 是 ISO 8601 UTC 字串（`new Date().toISOString()` 產生），用字典序
 *               字串比較即可正確反映時間先後，不需要另外 parse 成 Date 物件。
 *   --school:   指定 schoolId，預設 inhu（正式資料所在）。
 *   --yes:      實際執行刪除。不帶此旗標（預設值）只匯出＋印出將刪除的筆數與範圍，不刪除
 *               任何資料——比照 `scripts/firestore-backup.js restore` 的 `--yes` 閘門慣例，
 *               「--dry-run 預設」就是「預設不帶 --yes」這個狀態，不需要額外的旗標語意。
 *   --dry-run:  即使帶了 --yes 也強制只顯示計畫、不刪除（與 firestore-backup.js restore 的
 *               同名旗標行為一致，供測試/二次確認用）。
 *
 * 行為（無論是否帶 --yes，都一定會執行）：
 *   1. 列出 schools/{schoolId}/operationLogs 全部文件。
 *   2. 篩出 timestamp < --before 的文件（timestamp 缺席或型別不合法者，保守起見**不刪除**，
 *      計入「格式異常，已略過」，需人工檢視——fail-closed：無法確定是否早於期限就不刪）。
 *   3. 把符合條件的文件（含完整原始欄位）匯出到
 *      backups/firestore/operationLogs-cleanup/<yyyymmdd-HHMMss>/operationLogs.json
 *      （格式與 firestore-backup.js 相同：原始 REST document 物件陣列，理論上可比照該腳本
 *      的 restore 邏輯整份寫回，但本腳本不提供還原功能——如需還原請比照 firestore-backup.js
 *      的 patchDoc() 手動處理，或直接呼叫 Firebase Console）。
 *      匯出永遠執行（即使是 dry-run）——這是「刪除前一定要有一份備份」的安全網，不隨
 *      --yes/--dry-run 而跳過。
 *   4. `--yes` 且非 `--dry-run` 時：對匯出的每一筆文件送出 REST DELETE，依序執行（不併發，
 *      理由與既有腳本一致：避免對上百筆文件同時發動大量併發寫入請求），每 50 筆印一次進度。
 *      其餘情況：僅印出「將刪除 N 筆」的計畫，不呼叫 DELETE。
 *
 * exit code：0 = 成功（含 dry-run）；1 = 有格式異常文件被略過（僅在 --yes 執行模式提醒需人工
 *            處理，dry-run 模式下也會回報但不視為錯誤，只用於 CI 判斷可另行忽略）；
 *            2 = 執行中斷（取不到 token、缺必要參數、API 失敗等）。
 *
 * ⚠️ 本腳本本次僅撰寫，未執行（RESEARCH-multitenancy-semester.md Stage 5 實作範圍明訂
 * 「只寫不執行」）。正式使用前，比照本專案既有腳本慣例，務必先跑一次不帶 --yes 的模式
 * 核對「將刪除」的筆數與日期範圍是否符合預期。
 */
const { execSync } = require('child_process');
const fs   = require('node:fs');
const path = require('node:path');

const PROJECT     = 'stsystem-9d5fe';
const SCHOOL_ID   = process.argv.find(a => a.startsWith('--school='))?.split('=')[1] || 'inhu';
const BEFORE       = process.argv.find(a => a.startsWith('--before='))?.split('=')[1];
const EXECUTE      = process.argv.includes('--yes');
const DRY_RUN      = process.argv.includes('--dry-run');
const BASE          = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const BACKUP_ROOT  = path.join(__dirname, '..', 'backups', 'firestore', 'operationLogs-cleanup');

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

/** 列出集合下所有文件（原始 REST document 物件），處理 nextPageToken 分頁。 */
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

/** 從 doc.name（完整 resource name）取出接在 BASE 後面可用的相對路徑。 */
function relPathFromName(name) {
    const marker = '/documents/';
    const idx    = name.indexOf(marker);
    return name.slice(idx + marker.length);
}

async function deleteDoc(relPath) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${relPath}`, { method: 'DELETE', headers: buildHeaders(token) });
    if (!res.ok) throw new Error(`${res.status} DELETE ${relPath}\n${(await res.text()).slice(0, 300)}`);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function timestampDirName() {
    const now = new Date();
    const p2  = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
}

function unwrapTimestampField(doc) {
    const field = doc?.fields?.timestamp;
    return field && 'stringValue' in field ? field.stringValue : null;
}

function isValidBeforeArg(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
}

async function main() {
    if (!isValidBeforeArg(BEFORE)) {
        console.error('❌ 缺少或格式不正確的 --before=<YYYY-MM-DD>，用法：');
        console.error('   node scripts/cleanup-operation-logs.js --before=2023-08-01 [--school=<id>] [--yes] [--dry-run]');
        process.exit(2);
    }
    const cutoff = `${BEFORE}T00:00:00.000Z`; // ISO 字串字典序比較即代表時間先後

    console.log(`📡 operationLogs 清理 → schools/${SCHOOL_ID}（專案 ${PROJECT}）`);
    console.log(`   刪除範圍：timestamp < ${cutoff}`);
    console.log(`   模式：${EXECUTE && !DRY_RUN ? '⚠️  實際刪除（--yes）' : '僅顯示計畫，不刪除（預設 dry-run）'}\n`);

    const collPath = `schools/${SCHOOL_ID}/operationLogs`;
    const docs = await listCollection(collPath);
    console.log(`共讀取 ${docs.length} 筆 operationLogs\n`);

    const toDelete = [];
    const malformed = [];
    for (const d of docs) {
        const ts = unwrapTimestampField(d);
        if (!ts) {
            malformed.push(d); // fail-closed：不確定時間就不刪
            continue;
        }
        if (ts < cutoff) toDelete.push(d);
    }

    console.log(`符合刪除條件（timestamp < ${BEFORE}）：${toDelete.length} 筆`);
    console.log(`保留（timestamp >= ${BEFORE}）：${docs.length - toDelete.length - malformed.length} 筆`);
    console.log(`⚠ timestamp 缺席或格式異常，已略過不刪（需人工檢視）：${malformed.length} 筆`);
    if (malformed.length) {
        for (const d of malformed.slice(0, 20)) console.log(`    ! ${docId(d)}`);
        if (malformed.length > 20) console.log(`    ...其餘 ${malformed.length - 20} 筆略`);
    }
    console.log('');

    // 匯出永遠執行（安全網），不受 --yes/--dry-run 影響。
    const dir = path.join(BACKUP_ROOT, timestampDirName());
    ensureDir(dir);
    fs.writeFileSync(
        path.join(dir, 'operationLogs.json'),
        JSON.stringify({ collectionPath: collPath, before: BEFORE, count: toDelete.length, documents: toDelete.map(d => ({ document: d })) }, null, 2),
        'utf8'
    );
    console.log(`📁 已匯出將刪除的 ${toDelete.length} 筆文件備份：${dir}\n`);

    const shouldExecute = EXECUTE && !DRY_RUN;
    if (!shouldExecute) {
        console.log(DRY_RUN
            ? '（--dry-run：僅顯示計畫並匯出備份，不會刪除任何資料）'
            : '（未帶 --yes：僅顯示計畫並匯出備份，不會刪除任何資料。確認匯出檔內容無誤後加上 --yes 才會實際刪除）');
        process.exit(malformed.length > 0 ? 1 : 0);
    }

    if (toDelete.length === 0) {
        console.log('沒有符合條件的文件需要刪除。');
        process.exit(0);
    }

    console.log(`⚠️  開始刪除 ${toDelete.length} 筆文件（不可復原，已於上方匯出備份）...`);
    let done = 0;
    for (const d of toDelete) {
        await deleteDoc(relPathFromName(d.name));
        done++;
        if (done % 50 === 0) console.log(`  ...已刪除 ${done}/${toDelete.length}`);
    }
    console.log(`\n✅ 刪除完成，共刪除 ${done} 筆（略過異常 ${malformed.length} 筆，備份見上方路徑）`);
    process.exit(malformed.length > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('\n❌ 失敗：', e.message);
    process.exit(2);
});
