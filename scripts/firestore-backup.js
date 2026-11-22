#!/usr/bin/env node
/**
 * Firestore V2 完整備份 / 還原
 *
 * 用法：
 *   node scripts/firestore-backup.js backup [--school=<id>] [--project=<id>] [--include-v1=false]
 *   node scripts/firestore-backup.js restore --dir=<備份資料夾> [--yes] [--dry-run] [--restore-v1]
 *
 *   --school:   指定 schoolId，預設 inhu（正式資料所在）。
 *   --project:  目標 Firebase 專案，預設正式專案 stsystem-9d5fe；測試站專案傳 --project=<測試專案 id>。
 *   --dir:      restore 專用，指定要還原的備份資料夾（backup 產生的那個時間戳目錄）。
 *   --yes:      restore 專用，實際執行寫入。不帶此旗標只印還原計畫，不寫入任何資料。
 *   --dry-run:  restore 專用，即使帶了 --yes 也強制只印計畫、不寫入（測試用）。
 *   --include-v1=false: backup 專用，不備份 V1 個人雲端文件（預設備份，見下）。
 *   --restore-v1:       restore 專用，把 v1UserData.json 的文件一併寫回 users/{uid}/data/substituteSystem。
 *                       預設不寫（只在計畫中提示筆數），避免覆寫使用者目前的 V1 資料。
 *
 * 備份內容（schools/{schoolId} 底下）：
 *   - schedules                             per-semester 課表（Stage 2 起的現行路徑）
 *   - schedules/{semesterId}/imports        課表匯入版本紀錄（含快照），存 scheduleImports.json
 *   - data/schedule                         單一 doc，Stage 2 之前的舊課表路徑（保留備查）
 *   - substituteRecords（含子文件 private/detail） 調代課紀錄
 *   - pendingRequests（含子文件 private/detail）    待審請求
 *   - teachers / userMappings / config / operationLogs / archives / emailIndex / joinAttempts  完整快照
 *
 * 另備份（不屬於任何學校、與 --school 無關）：
 *   - V1 個人雲端文件 users/{uid}/data/substituteSystem，存 v1UserData.json。2026-11-23 發現真實調代課
 *     紀錄曾只存在這份文件，而備份原本只涵蓋 schools/{schoolId}。以 collection group query
 *     （collectionId = data、allDescendants）取得所有 data 文件後，只收路徑完全符合
 *     users/{uid}/data/substituteSystem 者（schools/ 底下同名 data 子集合的文件不收）。
 *     備份時會印出每份文件的 substituteRecords 筆數（uid 只印前 6 碼）。
 *
 * 備份格式：直接存 Firestore REST 的原始 document 物件（{name, fields, createTime, updateTime}），
 * 不 unwrap 成一般 JS 值。這樣 restore 時可以把同一份 fields 原樣 PATCH 回去，無損還原
 * （對照 firestore-health-check.js / firestore-snapshot.js 是 unwrap 後才印出，僅供人眼閱讀，
 * 不適合拿來做還原用途，所以本檔另外存一份原始格式）。
 *
 * 輸出位置：backups/firestore/<yyyymmdd-HHMMss>/，一個集合一個 JSON 檔，schedule doc 單獨一檔。
 *   非正式專案改存 backups/firestore-<專案 id>/<yyyymmdd-HHMMss>/，避免正式與測試備份混在一起被誤還原。
 *
 * exit code：0 = 成功（含 restore 的 dry-run / 未帶 --yes 情況）；2 = 執行中斷（取不到 token、
 * 引數錯誤、API 失敗等）。
 */
const { execSync } = require('child_process');
const fs            = require('node:fs');
const path          = require('node:path');

/** 正式專案；測試站用 --project= 覆寫，避免把動作做錯邊。 */
const DEFAULT_PROJECT = 'stsystem-9d5fe';
const safety = require('./lib/script-safety');
const TARGET = safety.resolveTarget(process.env, process.argv.find(a => a.startsWith('--project='))?.split('=')[1]);
const PROJECT = TARGET.project;

// PROJECT 會被組進備份輸出路徑（見 BACKUP_ROOT），所以先擋掉不合法的專案 ID——
// Firebase 專案 ID 只會是小寫英數與連字號，不先擋就可能用 ../ 把備份寫到目錄外。
if (!/^[a-z][a-z0-9-]{3,29}$/.test(PROJECT)) {
    console.error(`❌ 專案 ID 格式不合法：${PROJECT}`);
    process.exit(2);
}

// 目標專案一律先印出來，免得動作做錯邊才發現。
safety.targetBanner(TARGET).forEach(l => console.log(l));
const SCHOOL_ID   = process.argv.find(a => a.startsWith('--school='))?.split('=')[1] || 'inhu';
const BASE        = `${safety.databaseBase(TARGET)}/documents`;
const BACKUP_ROOT = path.join(__dirname, '..', 'backups', PROJECT === DEFAULT_PROJECT ? 'firestore' : `firestore-${PROJECT}`);

const INCLUDE_V1  = (process.argv.find(a => a.startsWith('--include-v1='))?.split('=')[1] ?? 'true') !== 'false';
const RESTORE_V1  = process.argv.includes('--restore-v1');
const V1_PATH_RE  = /^users\/[^/]+\/data\/substituteSystem$/;

const SUBCOMMAND = process.argv.slice(2).filter(a => !a.startsWith('--project=') && !a.startsWith('--account='))[0];

// 會一併備份、但清除功能不會動到的集合（低成本，一併存成完整快照）
//
// schedules 是 Stage 2（2026-07-31）之後真正在用的課表路徑（schools/{id}/schedules/{semesterId}）。
// 下面單獨備份的 data/schedule 是 Stage 2 之前的舊路徑，schemaConstants.js:58 已註明
// 「不再被任何寫入路徑使用」，只留作 per-semester 文件尚未建立時的一次性讀取 fallback。
// 先前漏掉 schedules，等於備份保護不到現行課表——課表被匯入覆寫後無法還原。
// archives / emailIndex / joinAttempts 同為 Stage 0-5 新增、原本未納入備份的集合。
const PLAIN_COLLECTIONS = ['teachers', 'userMappings', 'config', 'operationLogs',
                           'schedules', 'archives', 'emailIndex', 'joinAttempts'];
// 清除功能會動到的集合，且每筆 doc 下還有 private/detail 子文件要一併備份
const PRIVATE_DETAIL_COLLECTIONS = ['substituteRecords', 'pendingRequests'];

function getToken() {
    return safety.getAccessToken(TARGET, safety.resolveOperatorAccount(process.argv.slice(2), process.env, TARGET));
}

/**
 * 呼叫 Firestore REST API。GET 用於讀取（doc 或 collection list），404 一律回傳 null
 * （代表文件/子文件不存在，是正常情況，例如某筆紀錄沒有 private/detail）。
 */
async function api(p) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${p}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        if (res.status === 404) return null;
        const txt = await res.text();
        throw new Error(`${res.status} ${p}\n${txt.slice(0, 300)}`);
    }
    return res.json();
}

/** POST :runQuery（collection group 用，回傳 [{document, ...}] 串流陣列）。 */
async function runQuery(structuredQuery) {
    const token = getToken();
    const res   = await fetch(`${BASE}:runQuery`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`runQuery 失敗 ${res.status}\n${txt.slice(0, 300)}`);
    }
    return res.json();
}

/** 列出所有 V1 個人雲端文件 users/{uid}/data/substituteSystem（原始 REST document 物件）。 */
async function listV1UserData() {
    const rows = await runQuery({ from: [{ collectionId: 'data', allDescendants: true }] });
    // runQuery 可能在 HTTP 200 的串流陣列中夾帶 {error}；有就中止，避免備份不完整卻回報成功
    const errRow = rows.find(r => r && r.error);
    if (errRow) throw new Error(`V1 資料查詢失敗：${errRow.error.message || JSON.stringify(errRow.error)}`);
    return rows.filter(r => r.document && V1_PATH_RE.test(relPathFromName(r.document.name))).map(r => r.document);
}

function v1RecordCount(doc) {
    return doc?.fields?.substituteRecords?.arrayValue?.values?.length || 0;
}

async function getDoc(docPath) {
    return api(docPath);
}

/**
 * 列出集合下所有文件（原始 REST document 物件），處理 nextPageToken 分頁
 * （operationLogs 這類集合筆數可能超過單頁上限）。
 */
async function listCollection(collectionPath) {
    let all = [];
    let pageToken;
    do {
        const qs = new URLSearchParams({ pageSize: '300' });
        if (pageToken) qs.set('pageToken', pageToken);
        const data = await api(`${collectionPath}?${qs.toString()}`);
        if (data?.documents) all = all.concat(data.documents);
        pageToken = data?.nextPageToken;
    } while (pageToken);
    return all;
}

function docId(doc) {
    return doc.name.split('/').pop();
}

/** 從 doc.name（完整 resource name）取出接在 BASE 後面可用的相對路徑，restore 時直接拿來 PATCH。 */
function relPathFromName(name) {
    const marker = '/documents/';
    const idx    = name.indexOf(marker);
    return name.slice(idx + marker.length);
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function writeJson(dir, filename, data) {
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
}

function timestampDirName() {
    const now = new Date();
    const p2  = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
}

async function backupPlainCollection(name) {
    const collPath = `schools/${SCHOOL_ID}/${name}`;
    const docs     = await listCollection(collPath);
    return docs.map(d => ({ document: d }));
}

async function backupCollectionWithPrivateDetail(name) {
    const collPath = `schools/${SCHOOL_ID}/${name}`;
    const docs     = await listCollection(collPath);
    const out      = [];
    for (const d of docs) {
        const priv = await getDoc(`${collPath}/${docId(d)}/private/detail`);
        out.push({ document: d, privateDetail: priv });
    }
    return out;
}

async function doBackup() {
    const dir = path.join(BACKUP_ROOT, timestampDirName());
    ensureDir(dir);

    console.log(`🏫 備份對象：schools/${SCHOOL_ID}（專案 ${PROJECT}）`);
    console.log(`📁 備份輸出：${dir}\n`);

    // schedule doc（單一文件）
    const scheduleDocPath = `schools/${SCHOOL_ID}/data/schedule`;
    const scheduleDoc     = await getDoc(scheduleDocPath);
    writeJson(dir, 'schedule.json', { documentPath: scheduleDocPath, document: scheduleDoc });
    console.log(`▶ data/schedule（doc）：${scheduleDoc ? '已備份' : '不存在（null）'}`);

    // 會被「清除所有資料」動到、且有 private/detail 子文件的集合
    for (const name of PRIVATE_DETAIL_COLLECTIONS) {
        const items    = await backupCollectionWithPrivateDetail(name);
        const privCnt  = items.filter(i => i.privateDetail).length;
        writeJson(dir, `${name}.json`, { collectionPath: `schools/${SCHOOL_ID}/${name}`, count: items.length, documents: items });
        console.log(`▶ ${name}：${items.length} 筆（private/detail ${privCnt} 筆）`);
    }

    // 不會被清除功能動到，但一併備份成完整快照（成本低）
    for (const name of PLAIN_COLLECTIONS) {
        const items = await backupPlainCollection(name);
        writeJson(dir, `${name}.json`, { collectionPath: `schools/${SCHOOL_ID}/${name}`, count: items.length, documents: items });
        console.log(`▶ ${name}：${items.length} 筆`);
    }

    // 課表匯入版本紀錄：imports 是 schedules 底下的子集合，列舉 schedules 不會帶到，須逐學期讀取。
    const scheduleDocs = await listCollection(`schools/${SCHOOL_ID}/schedules`);
    const importItems  = [];
    for (const sd of scheduleDocs) {
        const docs = await listCollection(`schools/${SCHOOL_ID}/schedules/${docId(sd)}/imports`);
        for (const d of docs) importItems.push({ document: d });
    }
    writeJson(dir, 'scheduleImports.json', { collectionPath: `schools/${SCHOOL_ID}/schedules/*/imports`, count: importItems.length, documents: importItems });
    console.log(`▶ schedules/*/imports：${importItems.length} 筆`);

    if (INCLUDE_V1) {
        const v1Docs = await listV1UserData();
        writeJson(dir, 'v1UserData.json', {
            collectionPath: 'users/*/data/substituteSystem', count: v1Docs.length,
            documents: v1Docs.map(d => ({ document: d })),
        });
        console.log(`▶ users/*/data/substituteSystem（V1 個人雲端）：${v1Docs.length} 份`);
        for (const d of v1Docs) {
            const uid = relPathFromName(d.name).split('/')[1];
            console.log(`    uid ${uid.slice(0, 6)}…：substituteRecords ${v1RecordCount(d)} 筆`);
        }
    } else {
        console.log('▶ V1 個人雲端：已略過（--include-v1=false）');
    }

    console.log(`\n✅ 備份完成：${dir}`);
    return dir;
}

/** 把單一 REST document 物件轉成還原計畫項目 {relPath, fields}；doc 為 null（不存在）時回傳 null。 */
function planItemFromDoc(doc) {
    if (!doc) return null;
    return { relPath: relPathFromName(doc.name), fields: doc.fields || {} };
}

/** 讀取備份資料夾，攤平成一份「每筆文件要 PATCH 回哪個路徑、帶什麼 fields」的還原計畫。 */
function buildRestorePlan(dir, { includeV1 = false } = {}) {
    const plan = [];

    const scheduleFile = path.join(dir, 'schedule.json');
    if (fs.existsSync(scheduleFile)) {
        const data = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
        const item = planItemFromDoc(data.document);
        if (item) plan.push({ ...item, label: 'data/schedule' });
    }

    for (const name of [...PRIVATE_DETAIL_COLLECTIONS, ...PLAIN_COLLECTIONS, 'scheduleImports', ...(includeV1 ? ['v1UserData'] : [])]) {
        const file = path.join(dir, `${name}.json`);
        if (!fs.existsSync(file)) continue;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const entry of data.documents || []) {
            const docItem = planItemFromDoc(entry.document);
            if (docItem) plan.push({ ...docItem, label: name });
            const privItem = planItemFromDoc(entry.privateDetail);
            if (privItem) plan.push({ ...privItem, label: `${name}/private` });
        }
    }

    return plan;
}

/** 把單一 fields 物件整份覆寫回原文件路徑（不帶 updateMask = 全量取代，等同原文件無損還原）。 */
async function patchDoc(relPath, fields) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${relPath}`, {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fields }),
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`PATCH 失敗 ${relPath}: ${res.status}\n${txt.slice(0, 300)}`);
    }
}

async function doRestore() {
    const dirArg  = process.argv.find(a => a.startsWith('--dir='))?.split('=')[1];
    const wm      = safety.parseWriteMode(process.argv.slice(2), { applyAliases: ['--yes'] });   // --apply 或舊旗標 --yes
    const yes     = wm.apply;
    const dryRun  = wm.explicitDryRun;
    safety.targetBanner(TARGET, { action: 'restore 還原備份', apply: wm.apply }).forEach(l => console.log(l));

    if (!dirArg) {
        console.error('❌ 缺少 --dir=<備份資料夾>，用法：node scripts/firestore-backup.js restore --dir=<路徑> [--yes] [--restore-v1]');
        process.exit(2);
    }
    const dir = path.resolve(dirArg);
    if (!fs.existsSync(dir)) {
        console.error(`❌ 備份資料夾不存在：${dir}`);
        process.exit(2);
    }

    console.log(`🏫 還原對象：schools/${SCHOOL_ID}（專案 ${PROJECT}）`);
    console.log(`📁 還原來源：${dir}\n`);

    const plan = buildRestorePlan(dir, { includeV1: RESTORE_V1 });
    const v1File = path.join(dir, 'v1UserData.json');
    const v1Count = fs.existsSync(v1File) ? (JSON.parse(fs.readFileSync(v1File, 'utf8')).documents || []).length : 0;

    // 依 label 分組列出筆數，方便人工核對
    const byLabel = new Map();
    for (const item of plan) byLabel.set(item.label, (byLabel.get(item.label) || 0) + 1);
    console.log('還原計畫：');
    for (const [label, count] of byLabel) console.log(`  - ${label}：${count} 筆`);
    if (v1Count > 0 && !RESTORE_V1) console.log(`  （備份內有 v1UserData ${v1Count} 份，未帶 --restore-v1，不會寫回）`);
    console.log(`合計：${plan.length} 筆文件將被整份覆寫（PATCH，無 updateMask）\n`);

    const shouldExecute = yes && !dryRun;
    if (!shouldExecute) {
        console.log(dryRun
            ? '（--dry-run：僅顯示計畫，不會寫入）'
            : '（未帶 --yes：僅顯示計畫，不會寫入。確認無誤後加上 --yes 才會實際還原）');
        process.exit(0);
    }

    console.log(`⚠️  即將寫入 ${plan.length} 筆文件，開始還原...`);
    let done = 0;
    for (const item of plan) {
        await patchDoc(item.relPath, item.fields);
        done++;
        if (done % 20 === 0) console.log(`  ...已還原 ${done}/${plan.length}`);
    }
    console.log(`✅ 還原完成，共 ${done} 筆`);
}

(async () => {
    if (SUBCOMMAND === 'backup') {
        try {
            await doBackup();
            process.exit(0);
        } catch (e) {
            console.error('❌ 備份中斷：', e.message);
            process.exit(2);
        }
    } else if (SUBCOMMAND === 'restore') {
        try {
            await doRestore();
        } catch (e) {
            console.error('❌ 還原中斷：', e.message);
            process.exit(2);
        }
    } else {
        console.error('用法：node scripts/firestore-backup.js backup [--school=<id>] [--project=<id>] [--include-v1=false]');
        console.error('      node scripts/firestore-backup.js restore --dir=<備份資料夾> [--yes] [--dry-run] [--restore-v1]');
        process.exit(2);
    }
})();
