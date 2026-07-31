#!/usr/bin/env node
/**
 * Stage 3（見 docs/RESEARCH-multitenancy-semester.md §4 集合設計預告、§8 Stage 3）
 * userDirectory 回填腳本
 *
 * 背景：SCHOOL_ID 從 import-time 常數改為 runtime 動態解析（登入後由
 * authGuardV2.resolveIdentity() 呼叫 schemaConstants.setActiveSchoolId()）。解析來源是頂層
 * 集合 userDirectory/{uid}（欄位：schoolId、createdAt）——純前端在「不知道使用者屬於哪所
 * 學校」時無法反查（Firestore 不支援跨集合搜尋 uid），必須有這份索引才能在登入當下就知道
 * 要對哪個 schoolId 組路徑。
 *
 * 現有使用者（已經有 schools/{schoolId}/userMappings/{uid} 的既有成員）尚未有對應的
 * userDirectory 條目——resolveSchoolIdForUid() 內建的 fallback 會讓他們暫時退回
 * DEFAULT_SCHOOL_ID（'inhu'），對目前唯一正式服務的學校而言行為不受影響（見
 * schemaConstants.js 的 fallback 說明），但這不是長久的解法：Stage 4（開放註冊）之後
 * fallback 語意會改變，且每次登入都要繞一次 fallback 也不是效率最好的路徑。回填後，
 * resolveIdentity() 會在同一次成功登入內自動補寫這份索引（見 upsertUserDirectoryEntry
 * 呼叫點），但那是「登入了才補」，本腳本讓既有成員不必等到下次登入才收斂。
 *
 * 用法：
 *   node scripts/backfill-user-directory.js --dry-run [--school=<id>]
 *   node scripts/backfill-user-directory.js [--school=<id>]
 *
 *   --school:   指定要回填的 schoolId，預設 inhu（正式資料所在）。來源集合是
 *               schools/{school}/userMappings（doc id 即 uid），目標是頂層 userDirectory/{uid}。
 *   --dry-run:  只列出將建立的 userDirectory 條目與衝突，不寫入任何資料。
 *               （比照 firestore-backfill-emailindex.js 慣例，本腳本要求先跑過 --dry-run 核對。）
 *
 * 邏輯：
 *   1. 列出 schools/{school}/userMappings 全部條目（doc id = uid）。
 *   2. 對每個 uid：
 *      - userDirectory/{uid} 不存在 → 待建立（CREATE，schoolId = school）。
 *      - 已存在且 schoolId 與本次回填的 school 相同 → 略過（SKIP，已同步）。
 *      - 已存在但 schoolId 與本次回填的 school 不同 → 記為 CONFLICT，不覆寫
 *        （這代表同一個 uid 被登記在兩個不同的 schoolId 底下——目前只有 inhu 一校，
 *        理論上不會發生；一旦出現，屬於需要人工判斷「這個帳號真正屬於哪一校」的異常狀況，
 *        本腳本刻意不自動覆寫，避免把一個已經在其他學校正確運作的使用者改壞）。
 *   3. --dry-run 只印統計與明細；未帶 --dry-run 才會實際 PATCH 寫入。
 *
 * 認證：透過 gcloud auth print-access-token --account=uplilt31311227@gmail.com
 *      （需先 gcloud auth login 完成）
 *
 * ⚠ 本次任務範圍明確要求「--dry-run，不執行」——本腳本已寫好，但截至本次交付
 *   尚未在正式庫上實際執行過（含 --dry-run），使用前請先確認 gcloud 帳號已登入且
 *   有此專案的讀寫權限。
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

/* ===== Firestore REST 輔助（比照 firestore-backfill-emailindex.js） ===== */

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

async function main() {
    console.log(`📡 userDirectory 回填 → 來源 schools/${SCHOOL_ID}/userMappings（專案 ${PROJECT}）${DRY_RUN ? '  [--dry-run，不寫入]' : ''}\n`);

    const mappingDocs = await listCollection(`schools/${SCHOOL_ID}/userMappings`);
    const uids = mappingDocs.map(docId);
    console.log(`▶ 讀到 ${uids.length} 筆 userMappings（既有成員）\n`);

    const toCreate = [];
    const skipped = [];
    const conflicts = [];
    const nowIso = new Date().toISOString();

    for (const uid of uids) {
        const existing = await apiGet(`userDirectory/${uid}`);
        if (!existing) {
            toCreate.push({ uid });
        } else {
            const existingSchoolId = docFieldsToObj(existing).schoolId;
            if (existingSchoolId === SCHOOL_ID) {
                skipped.push({ uid });
            } else {
                conflicts.push({ uid, existingSchoolId });
            }
        }
    }

    console.log('===== 回填計畫 =====');
    console.log(`  待建立（CREATE）：${toCreate.length} 筆`);
    for (const item of toCreate) console.log(`    + userDirectory/${item.uid} → schoolId = ${SCHOOL_ID}`);
    console.log(`  已同步（SKIP）：${skipped.length} 筆`);
    console.log(`  ⚠ 衝突（uid 已登記在其他 schoolId，需人工判斷，未寫入）：${conflicts.length} 筆`);
    for (const c of conflicts) console.log(`    ! userDirectory/${c.uid} 現有 schoolId = ${c.existingSchoolId}，與本次回填的 ${SCHOOL_ID} 不同`);
    console.log('');

    if (DRY_RUN) {
        console.log('（--dry-run：僅顯示計畫，不會寫入。確認無誤後移除 --dry-run 才會實際回填）');
        process.exit(conflicts.length > 0 ? 1 : 0);
    }

    console.log('⚠️  開始寫入 userDirectory...');
    let done = 0;
    for (const item of toCreate) {
        await apiPatch(`userDirectory/${item.uid}`, {
            schoolId:  v.str(SCHOOL_ID),
            createdAt: v.str(nowIso),
        });
        done++;
        console.log(`  ✓ userDirectory/${item.uid} → schoolId = ${SCHOOL_ID}`);
    }
    console.log(`\n✅ 回填完成，共寫入 ${done} 筆（略過 ${skipped.length} 筆已同步、${conflicts.length} 筆衝突待人工處理）`);

    if (conflicts.length > 0) {
        console.log('\n⚠️  仍有 uid 衝突未回填，這些帳號目前登記在其他 schoolId，請人工確認正確歸屬後再處理：');
        for (const c of conflicts) console.log(`    ${c.uid}: 現有 ${c.existingSchoolId}，本次來源 ${SCHOOL_ID}`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch(e => {
    console.error('\n❌ 失敗：', e.message);
    process.exit(2);
});
