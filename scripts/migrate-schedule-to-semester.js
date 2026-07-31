#!/usr/bin/env node
/**
 * Stage 2（見 docs/RESEARCH-multitenancy-semester.md §5.6、§8 Stage 2）
 * 課表遷移腳本：舊 data/schedule（單一文件）→ schedules/{semesterId}（per-semester）
 *
 * 背景：schoolDataService.js 的 saveSchedule()/subscribeSchedule() 已改為讀寫
 * schools/{schoolId}/schedules/{semesterId}，不再寫入舊路徑 data/schedule；但讀取端內建
 * 一次性 fallback（per-semester 文件不存在時退回讀舊文件一次），所以即使不跑本腳本，課表
 * 也不會「消失」——只是會停在 fallback 讀取狀態，直到下一次 approver 上傳課表才會真正寫入
 * 新路徑。本腳本讓遷移可以「主動」完成，不必等下一次課表異動。
 *
 * 用法：
 *   node scripts/migrate-schedule-to-semester.js --dry-run [--school=<id>] [--semester=<id>]
 *   node scripts/migrate-schedule-to-semester.js [--school=<id>] [--semester=<id>]
 *
 *   --school:    指定 schoolId，預設 inhu（正式資料所在）。
 *   --semester:  目標 semesterId（例如 114-2），預設讀 config/main.currentSemester；
 *                若 config 也沒有值，腳本會直接報錯並提示先設定 currentSemester。
 *   --dry-run:   只顯示將複製的內容摘要，不寫入任何資料。
 *                （本腳本目前只在此模式下被實際執行過，正式寫入前務必先跑一次 --dry-run 核對。）
 *
 * 邏輯（比照 firestore-backfill-emailindex.js 的 idempotent 設計）：
 *   1. 讀 schools/{schoolId}/config/main.currentSemester（--semester 未帶時的預設目標）。
 *   2. 讀舊文件 schools/{schoolId}/data/schedule。不存在 → 無需遷移，正常結束。
 *   3. 讀新文件 schools/{schoolId}/schedules/{目標學期}。已存在 → SKIP（不覆蓋既有 per-semester
 *      資料——可能是 approver 已經手動上傳過新學期課表，不該被舊資料蓋掉）。
 *   4. 否則將舊文件全部欄位原樣複製到新文件（PUT，等同 setDoc 整份覆寫，與
 *      schoolDataService.saveSchedule() 的既有語意一致）。
 *   5. 舊文件本身不刪除（fallback 讀取路徑仍可能用到；且刪除是不可逆操作，不在回填腳本的
 *      職責範圍——若要清理舊文件，應是另一個獨立、明確的手動步驟）。
 *
 * 認證：透過 gcloud auth print-access-token --account=uplilt31311227@gmail.com
 *      （需先 gcloud auth login 完成）
 *
 * exit code：0 = 成功（含「無需遷移」與「已存在故略過」）；2 = 執行中斷（取不到 token、
 *            找不到目標學期、API 失敗等）
 */
const { execSync } = require('child_process');

const PROJECT   = 'stsystem-9d5fe';
const SCHOOL_ID = process.argv.find(a => a.startsWith('--school='))?.split('=')[1] || 'inhu';
const TARGET_SEMESTER_ARG = process.argv.find(a => a.startsWith('--semester='))?.split('=')[1] || null;
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

async function apiGet(docPath) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${docPath}`, { headers: buildHeaders(token) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} GET ${docPath}\n${(await res.text()).slice(0, 300)}`);
    return res.json();
}

/** 整份覆寫（PUT 語意，不帶 updateMask）——等同 client 端 setDoc(ref, data)（非 merge）。 */
async function apiPut(docPath, fields) {
    const token = getToken();
    const res   = await fetch(`${BASE}/${docPath}`, {
        method:  'PATCH',
        headers: buildHeaders(token),
        body:    JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`${res.status} PUT ${docPath}\n${(await res.text()).slice(0, 300)}`);
    return res.json();
}

function unwrap(field) {
    if (!field) return null;
    if ('stringValue'  in field) return field.stringValue;
    if ('booleanValue' in field) return field.booleanValue;
    if ('integerValue'  in field) return Number(field.integerValue);
    if ('doubleValue'  in field) return field.doubleValue;
    if ('nullValue'    in field) return null;
    if ('mapValue'     in field) return docFieldsToObj(field.mapValue);
    if ('arrayValue'   in field) return (field.arrayValue.values || []).map(unwrap);
    if ('timestampValue' in field) return field.timestampValue;
    return null;
}

function docFieldsToObj(doc) {
    if (!doc?.fields) return {};
    return Object.fromEntries(Object.entries(doc.fields).map(([k, val]) => [k, unwrap(val)]));
}

async function main() {
    console.log(`📡 課表遷移 → schools/${SCHOOL_ID}（專案 ${PROJECT}）${DRY_RUN ? '  [--dry-run，不寫入]' : ''}\n`);

    let targetSemester = TARGET_SEMESTER_ARG;
    if (!targetSemester) {
        const config = await apiGet(`schools/${SCHOOL_ID}/config/main`);
        targetSemester = config ? docFieldsToObj(config).currentSemester : null;
        if (!targetSemester) {
            console.error('❌ 未帶 --semester，且 config/main.currentSemester 也沒有值，無法判斷遷移目標學期。');
            process.exit(2);
        }
        console.log(`（未帶 --semester，使用 config.currentSemester = ${targetSemester}）`);
    }

    const legacyDoc = await apiGet(`schools/${SCHOOL_ID}/data/schedule`);
    if (!legacyDoc) {
        console.log('✅ 舊文件 data/schedule 不存在，無需遷移。');
        process.exit(0);
    }
    const legacyData = docFieldsToObj(legacyDoc);
    const entryCount = Array.isArray(legacyData.scheduleData) ? legacyData.scheduleData.length : 0;
    console.log(`▶ 讀到舊課表文件：schoolName=${legacyData.schoolName || '(空)'}，scheduleData 筆數=${entryCount}`);

    const newPath = `schools/${SCHOOL_ID}/schedules/${targetSemester}`;
    const existing = await apiGet(newPath);
    if (existing) {
        console.log(`✅ 目標文件 ${newPath} 已存在（略過，不覆蓋既有 per-semester 資料）。`);
        console.log('   若確認要用舊文件內容覆蓋，請先手動刪除該文件再重跑本腳本，或改用 Firebase Console 手動處理。');
        process.exit(0);
    }

    console.log(`\n計畫：把 data/schedule 整份複製到 ${newPath}（新建，不覆蓋既有文件）`);
    console.log(`  scheduleData：${entryCount} 筆`);
    console.log(`  teachers：${Array.isArray(legacyData.teachers) ? legacyData.teachers.length : 0} 筆`);
    console.log(`  classes：${Array.isArray(legacyData.classes) ? legacyData.classes.length : 0} 筆`);
    console.log(`  schoolName：${legacyData.schoolName || '(空)'}`);
    console.log('');

    if (DRY_RUN) {
        console.log('（--dry-run：僅顯示計畫，不會寫入。確認無誤後移除 --dry-run 才會實際遷移）');
        process.exit(0);
    }

    // Firestore REST API 沒有「原樣複製 fields 物件」的捷徑，這裡直接沿用 GET 回應的
    // fields 結構（已是 Firestore Value 格式）整包搬到新路徑，不需要重新 unwrap/wrap。
    await apiPut(newPath, legacyDoc.fields);
    console.log(`✅ 遷移完成：${newPath} 已建立。`);
    console.log('   （舊文件 data/schedule 未刪除，保留供讀取 fallback 與其他歷史對照用途。）');
    process.exit(0);
}

main().catch(e => {
    console.error('\n❌ 失敗：', e.message);
    process.exit(2);
});
