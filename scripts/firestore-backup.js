#!/usr/bin/env node
/**
 * Firestore V2 完整備份 / 還原
 *
 * 用法：
 *   node scripts/firestore-backup.js backup [--school=<id>]
 *   node scripts/firestore-backup.js restore --dir=<備份資料夾> [--yes] [--dry-run]
 *
 *   --school:   指定 schoolId，預設 inhu（正式資料所在）。
 *   --dir:      restore 專用，指定要還原的備份資料夾（backup 產生的那個時間戳目錄）。
 *   --yes:      restore 專用，實際執行寫入。不帶此旗標只印還原計畫，不寫入任何資料。
 *   --dry-run:  restore 專用，即使帶了 --yes 也強制只印計畫、不寫入（測試用）。
 *
 * 備份內容（schools/{schoolId} 底下）：
 *   - schedules                             per-semester 課表（Stage 2 起的現行路徑）
 *   - data/schedule                         單一 doc，Stage 2 之前的舊課表路徑（保留備查）
 *   - substituteRecords（含子文件 private/detail） 調代課紀錄
 *   - pendingRequests（含子文件 private/detail）    待審請求
 *   - teachers / userMappings / config / operationLogs / archives / emailIndex / joinAttempts  完整快照
 *
 * 備份格式：直接存 Firestore REST 的原始 document 物件（{name, fields, createTime, updateTime}），
 * 不 unwrap 成一般 JS 值。這樣 restore 時可以把同一份 fields 原樣 PATCH 回去，無損還原
 * （對照 firestore-health-check.js / firestore-snapshot.js 是 unwrap 後才印出，僅供人眼閱讀，
 * 不適合拿來做還原用途，所以本檔另外存一份原始格式）。
 *
 * 輸出位置：backups/firestore/<yyyymmdd-HHMMss>/，一個集合一個 JSON 檔，schedule doc 單獨一檔。
 *
 * exit code：0 = 成功（含 restore 的 dry-run / 未帶 --yes 情況）；2 = 執行中斷（取不到 token、
 * 引數錯誤、API 失敗等）。
 */
const { execSync } = require('child_process');
const fs            = require('node:fs');
const path          = require('node:path');

const PROJECT     = 'stsystem-9d5fe';
const SCHOOL_ID   = process.argv.find(a => a.startsWith('--school='))?.split('=')[1] || 'inhu';
const BASE        = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const BACKUP_ROOT = path.join(__dirname, '..', 'backups', 'firestore');

const SUBCOMMAND = process.argv[2];

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
    return execSync('gcloud auth print-access-token --account=uplilt31311227@gmail.com')
        .toString().trim();
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

    console.log(`\n✅ 備份完成：${dir}`);
    return dir;
}

/** 把單一 REST document 物件轉成還原計畫項目 {relPath, fields}；doc 為 null（不存在）時回傳 null。 */
function planItemFromDoc(doc) {
    if (!doc) return null;
    return { relPath: relPathFromName(doc.name), fields: doc.fields || {} };
}

/** 讀取備份資料夾，攤平成一份「每筆文件要 PATCH 回哪個路徑、帶什麼 fields」的還原計畫。 */
function buildRestorePlan(dir) {
    const plan = [];

    const scheduleFile = path.join(dir, 'schedule.json');
    if (fs.existsSync(scheduleFile)) {
        const data = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
        const item = planItemFromDoc(data.document);
        if (item) plan.push({ ...item, label: 'data/schedule' });
    }

    for (const name of [...PRIVATE_DETAIL_COLLECTIONS, ...PLAIN_COLLECTIONS]) {
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
    const yes     = process.argv.includes('--yes');
    const dryRun  = process.argv.includes('--dry-run');

    if (!dirArg) {
        console.error('❌ 缺少 --dir=<備份資料夾>，用法：node scripts/firestore-backup.js restore --dir=<路徑> [--yes]');
        process.exit(2);
    }
    const dir = path.resolve(dirArg);
    if (!fs.existsSync(dir)) {
        console.error(`❌ 備份資料夾不存在：${dir}`);
        process.exit(2);
    }

    console.log(`🏫 還原對象：schools/${SCHOOL_ID}（專案 ${PROJECT}）`);
    console.log(`📁 還原來源：${dir}\n`);

    const plan = buildRestorePlan(dir);

    // 依 label 分組列出筆數，方便人工核對
    const byLabel = new Map();
    for (const item of plan) byLabel.set(item.label, (byLabel.get(item.label) || 0) + 1);
    console.log('還原計畫：');
    for (const [label, count] of byLabel) console.log(`  - ${label}：${count} 筆`);
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
        console.error('用法：node scripts/firestore-backup.js backup [--school=<id>]');
        console.error('      node scripts/firestore-backup.js restore --dir=<備份資料夾> [--yes] [--dry-run]');
        process.exit(2);
    }
})();
