#!/usr/bin/env node
/**
 * Stage 2（見 docs/RESEARCH-multitenancy-semester.md §5.6、§8 Stage 2）
 * semesterId 回填腳本
 *
 * 背景：Stage 2 把 substituteRecords / pendingRequests / operationLogs 三個集合都加上
 * semesterId 欄位，新寫入由程式碼自動蓋上（見 schoolDataService.js createSubstituteRecord /
 * createPendingRequest、operationLogger.js log()）。既有（Stage 2 上線前）的文件沒有這個
 * 欄位，本腳本依文件本身的 date（substituteRecords/pendingRequests）或 timestamp
 * （operationLogs）反推 semesterId 並補寫。
 *
 * ⚠ 部署順序（比照 Stage 0 emailIndex 回填的既有慣例）：本腳本必須在
 * schoolDataService.js 的查詢下推（subscribeSubstituteRecords/listSubstituteRecordsPage/
 * subscribePendingRequests/listOpenPendingRequests 疊加 where('semesterId','==',...)）
 * 部署上線之前跑完——這些查詢只會比對到「有 semesterId 欄位且值相符」的文件，回填前的舊
 * 文件會被這些查詢排除（不是刪除，文件本身完好，只是「當前學期」的預設視圖看不到）。
 * queryRecordsByDateRange／queryRecordsByExactDate／queryPendingRequestsByExactDate 三支
 * 查詢不受影響（未疊加 semesterId 條件），月結算與衝堂檢查在回填前後行為一致。
 *
 * 用法：
 *   node scripts/backfill-semester-id.js --dry-run [--school=<id>]
 *   node scripts/backfill-semester-id.js [--school=<id>]
 *
 *   --school:   指定 schoolId，預設 inhu（正式資料所在）。
 *   --dry-run:  只列出將補寫的欄位與統計，不寫入任何資料。
 *               （本腳本目前只在此模式下被實際執行過，正式寫入前務必先跑一次 --dry-run 核對。）
 *
 * 邏輯：
 *   1. 列出 substituteRecords / pendingRequests / operationLogs 三個集合全部文件。
 *   2. 已有 semesterId 欄位者 → SKIP（不覆蓋，避免誤蓋掉之後版本可能已手動修正過的值）。
 *   3. 缺欄位者：
 *      - substituteRecords / pendingRequests：依 `date`（YYYY-MM-DD）反推，
 *        格式不合法或欄位缺席 → 記為 UNRESOLVED，不寫入，待人工判斷。
 *      - operationLogs：依 `timestamp`（ISO 字串）反推，同上處理不合法值。
 *   4. --dry-run 只印統計與明細；未帶 --dry-run 才會實際 PATCH 寫入。
 *
 * 認證：透過 gcloud auth print-access-token --account=uplilt31311227@gmail.com
 *      （需先 gcloud auth login 完成）
 *
 * exit code：0 = 成功且無 UNRESOLVED；1 = 執行完成但有 UNRESOLVED 待人工處理；
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

async function apiPatch(docPath, fields, updateMaskFields) {
    const token = getToken();
    const mask  = updateMaskFields.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
    const res   = await fetch(`${BASE}/${docPath}?${mask}`, {
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

const v = { str: s => ({ stringValue: s }) };

/* ===== 學期反推（純函式版，與 src/js/modules/v2/semesterUtils.js 同一套公式，
 * 腳本以 CommonJS 執行、不透過 ESM import 共用同一份原始碼，維持公式一致由
 * test/test-semester-utils.mjs 對正式模組把關） ===== */

function academicYearROC(year, month) {
    return month >= 8 ? (year - 1911) : (year - 1912);
}
function semesterOfMonth(month) {
    return (month >= 8 || month === 1) ? 1 : 2;
}
// 驗收修復（輕 12，與 semesterUtils.js 同步）：往返驗證日期本身是否存在
// （例如 '2026-02-31' 正則能過但不是合法日期），不合法時回傳 null（記為 UNRESOLVED）。
function dateToSemesterId(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return null;
    const year  = Number(m[1]);
    const month = Number(m[2]);
    const day   = Number(m[3]);
    if (month < 1 || month > 12) return null;
    const roundTrip = new Date(year, month - 1, day);
    if (roundTrip.getFullYear() !== year || roundTrip.getMonth() !== month - 1 || roundTrip.getDate() !== day) {
        return null;
    }
    return `${academicYearROC(year, month)}-${semesterOfMonth(month)}`;
}
/** timestamp 是 ISO 字串（YYYY-MM-DDTHH:mm:ss...），取前 10 碼當日期字串即可。 */
function timestampToSemesterId(ts) {
    if (typeof ts !== 'string' || ts.length < 10) return null;
    return dateToSemesterId(ts.slice(0, 10));
}

/**
 * 依集合的回填策略掃描一個集合，回傳 { toWrite: [{docId, semesterId}], skipped, unresolved }。
 * @param {string} collectionPath
 * @param {(obj: object) => string|null} deriveFn 依文件欄位算出 semesterId 或 null（無法反推）
 */
async function planCollection(collectionPath, deriveFn) {
    const docs = await listCollection(collectionPath);
    const toWrite = [];
    let skipped = 0;
    const unresolved = [];
    for (const d of docs) {
        const obj = docFieldsToObj(d);
        if (obj.semesterId) { skipped++; continue; }
        const sid = deriveFn(obj);
        if (sid) {
            toWrite.push({ docId: docId(d), semesterId: sid });
        } else {
            unresolved.push({ docId: docId(d), reason: '缺少可反推的日期/時間戳欄位或格式不合法' });
        }
    }
    return { total: docs.length, toWrite, skipped, unresolved };
}

async function main() {
    console.log(`📡 semesterId 回填 → schools/${SCHOOL_ID}（專案 ${PROJECT}）${DRY_RUN ? '  [--dry-run，不寫入]' : ''}\n`);

    const targets = [
        { name: 'substituteRecords', path: `schools/${SCHOOL_ID}/substituteRecords`, derive: (o) => dateToSemesterId(o.date) },
        { name: 'pendingRequests',   path: `schools/${SCHOOL_ID}/pendingRequests`,   derive: (o) => dateToSemesterId(o.date) },
        { name: 'operationLogs',     path: `schools/${SCHOOL_ID}/operationLogs`,     derive: (o) => timestampToSemesterId(o.timestamp) },
    ];

    let totalUnresolved = 0;
    const plans = [];

    for (const t of targets) {
        const plan = await planCollection(t.path, t.derive);
        plans.push({ ...t, plan });
        totalUnresolved += plan.unresolved.length;

        console.log(`===== ${t.name}（schools/${SCHOOL_ID}/${t.name}） =====`);
        console.log(`  總筆數：${plan.total}`);
        console.log(`  已有 semesterId（略過）：${plan.skipped}`);
        console.log(`  待補寫：${plan.toWrite.length}`);
        if (plan.toWrite.length) {
            const bySid = new Map();
            for (const item of plan.toWrite) bySid.set(item.semesterId, (bySid.get(item.semesterId) || 0) + 1);
            for (const [sid, count] of [...bySid.entries()].sort()) console.log(`    → ${sid}：${count} 筆`);
        }
        console.log(`  ⚠ 無法反推（待人工處理）：${plan.unresolved.length}`);
        for (const u of plan.unresolved) console.log(`    ! ${u.docId}：${u.reason}`);
        console.log('');
    }

    if (DRY_RUN) {
        console.log('（--dry-run：僅顯示計畫，不會寫入。確認無誤後移除 --dry-run 才會實際回填）');
        process.exit(totalUnresolved > 0 ? 1 : 0);
    }

    console.log('⚠️  開始寫入 semesterId...');
    let doneTotal = 0;
    for (const { name, path, plan } of plans) {
        let done = 0;
        for (const item of plan.toWrite) {
            await apiPatch(`${path}/${item.docId}`, { semesterId: v.str(item.semesterId) }, ['semesterId']);
            done++;
        }
        console.log(`  ✓ ${name}：補寫 ${done} 筆`);
        doneTotal += done;
    }
    console.log(`\n✅ 回填完成，共補寫 ${doneTotal} 筆（無法反推、待人工處理：${totalUnresolved} 筆）`);

    if (totalUnresolved > 0) {
        console.log('\n⚠️  仍有文件無法反推 semesterId，需人工判斷後手動補值（Firebase Console 或另跑一次 PATCH）：');
        for (const { name, plan } of plans) {
            for (const u of plan.unresolved) console.log(`    ${name}/${u.docId}：${u.reason}`);
        }
        process.exit(1);
    }
    process.exit(0);
}

main().catch(e => {
    console.error('\n❌ 失敗：', e.message);
    process.exit(2);
});
