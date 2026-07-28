/**
 * V2 舊資料遷移單元測試（Phase 5）
 * 執行：node test/test-legacy-migration.mjs
 *
 * 直接匯入真正的 legacyMigrationService.js（不複製一份邏輯），透過其匯出的 __testHooks
 * 把 schoolDataService / operationLogger / roleService，以及讀 Firestore 舊路徑
 * （users/{uid}/data/substituteSystem）與讀 localStorage 的兩個讀取器，全部換成記憶體 mock，
 * 藉此在不啟動 Firebase / 瀏覽器環境的情況下驗證：偵測兩種來源、取較新者、遷移冪等性、
 * 姓名對不到 ID 仍匯入、下載備份失敗中止遷移、以及 batch 大小的推導。
 * 全程不對 production Firestore（schools/inhu）做任何讀寫。
 */

import * as legacyMigration from '../src/js/modules/v2/legacyMigrationService.js';
import { LOG_ACTIONS } from '../src/js/modules/v2/schemaConstants.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.error(`✗ ${label}：預期 ${e}，實得 ${a}`); }
}
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.error(`✗ ${label}`); }
}

/* ---------- 記憶體 mock：取代 schoolDataService 的教師 / 紀錄相關函式 ---------- */
function makeMockDataSvc(initialTeachers = [], initialRecords = []) {
    let seq = 1;
    const records = initialRecords.map(r => ({ ...r }));
    const calls = { createSubstituteRecord: 0 };
    return {
        _records: records,
        _calls: calls,
        async listTeachers() { return initialTeachers.map(t => ({ ...t })); },
        async listSubstituteRecords() { return records.map(r => ({ ...r })); },
        async createSubstituteRecord(record) {
            calls.createSubstituteRecord++;
            const now = new Date().toISOString();
            const data = { recordId: `rec_mock_${seq++}`, ...record, createdAt: record.createdAt || now, approvedAt: record.approvedAt || now };
            records.push(data);
            return { ...data };
        },
    };
}

function makeMockLogger() {
    const entries = [];
    return { entries, async log(action, targetType, targetId, details) { entries.push({ action, targetType, targetId, details }); } };
}

function makeMockRoleSvc({ isDirector = true, uid = 'uid_director_1' } = {}) {
    return {
        isDirector: () => isDirector,
        getCurrentIdentity: () => ({ uid, name: '測試主任', role: isDirector ? 'director' : 'teacher' }),
    };
}

/** 換上一組全新的 mock，回傳各 mock 供測試斷言用。firestoreLegacy / localStorageLegacy 傳 null 代表該來源無資料。 */
function useMocks({ teachers = [], records = [], firestoreLegacy = null, localStorageLegacy = null, isDirector = true, uid = 'uid_director_1' } = {}) {
    const dataSvc = makeMockDataSvc(teachers, records);
    const logger  = makeMockLogger();
    const roleSvc = makeMockRoleSvc({ isDirector, uid });
    legacyMigration.__testHooks.dataSvc = dataSvc;
    legacyMigration.__testHooks.logger  = logger;
    legacyMigration.__testHooks.roleSvc = roleSvc;
    legacyMigration.__testHooks.readFirestoreLegacy    = async () => firestoreLegacy;
    legacyMigration.__testHooks.readLocalStorageLegacy = () => localStorageLegacy;
    return { dataSvc, logger, roleSvc };
}

function legacyRecord(overrides = {}) {
    return {
        date: '2026-05-04', period: '第三節', className: '701', subject: '數學',
        originalTeacher: '甲師', substituteTeacher: '乙師', type: '代課', leaveType: '事假',
        ...overrides,
    };
}

/* ================= 1. 偵測：兩來源皆有，取 lastModified 較新者（Firestore 較新） ================= */
{
    useMocks({
        firestoreLegacy:    { substituteRecords: [legacyRecord(), legacyRecord({ date: '2026-05-05' })], lastModified: '2026-06-01T00:00:00.000Z' },
        localStorageLegacy: { substituteRecords: [legacyRecord()], lastModified: '2026-05-01T00:00:00.000Z' },
    });
    const info = await legacyMigration.detectLegacyData();
    eq(info.source, 'firestore', '偵測-雙來源：Firestore 較新時取 firestore');
    eq(info.count, 2, '偵測-雙來源：筆數取自較新來源');
    eq(info.lastModified, '2026-06-01T00:00:00.000Z', '偵測-雙來源：lastModified 取較新者');
}

/* ================= 2. 偵測：兩來源皆有，localStorage 較新 ================= */
{
    useMocks({
        firestoreLegacy:    { substituteRecords: [legacyRecord()], lastModified: '2026-04-01T00:00:00.000Z' },
        localStorageLegacy: { substituteRecords: [legacyRecord(), legacyRecord(), legacyRecord()], lastModified: '2026-06-15T00:00:00.000Z' },
    });
    const info = await legacyMigration.detectLegacyData();
    eq(info.source, 'localStorage', '偵測-雙來源：localStorage 較新時取 localStorage');
    eq(info.count, 3, '偵測-雙來源：筆數取自較新來源（localStorage）');
}

/* ================= 3. 偵測：僅單一來源存在 ================= */
{
    useMocks({ firestoreLegacy: { substituteRecords: [legacyRecord()], lastModified: '2026-06-01T00:00:00.000Z' }, localStorageLegacy: null });
    const info = await legacyMigration.detectLegacyData();
    eq(info.source, 'firestore', '偵測-單來源：僅 Firestore 有資料');
    eq(info.count, 1, '偵測-單來源：筆數正確');
}
{
    useMocks({ firestoreLegacy: null, localStorageLegacy: { substituteRecords: [legacyRecord(), legacyRecord()], lastModified: '2026-06-01T00:00:00.000Z' } });
    const info = await legacyMigration.detectLegacyData();
    eq(info.source, 'localStorage', '偵測-單來源：僅 localStorage 有資料');
    eq(info.count, 2, '偵測-單來源：筆數正確');
}

/* ================= 4. 偵測：兩來源皆無 ================= */
{
    useMocks({ firestoreLegacy: null, localStorageLegacy: null });
    const info = await legacyMigration.detectLegacyData();
    eq(info.source, null, '偵測-皆無：source 為 null');
    eq(info.count, 0, '偵測-皆無：count 為 0');
    eq(info.lastModified, null, '偵測-皆無：lastModified 為 null');
}

/* ================= 5. 遷移：正常匯入（教師皆可對應） ================= */
{
    const { dataSvc, logger } = useMocks({
        teachers: [{ teacherId: 'tch_1', name: '甲師' }, { teacherId: 'tch_2', name: '乙師' }],
        firestoreLegacy: {
            substituteRecords: [
                legacyRecord({ date: '2026-05-04' }),
                legacyRecord({ date: '2026-05-05', period: '第五節' }),
            ],
            lastModified: '2026-06-01T00:00:00.000Z',
        },
    });
    const r = await legacyMigration.migrateLegacyRecords({});
    eq(r.total, 2, '正常匯入：total 正確');
    eq(r.created, 2, '正常匯入：新增 2 筆');
    eq(r.skipped, 0, '正常匯入：略過 0 筆');
    eq(r.unmatchedNames, [], '正常匯入：無姓名對不到帳號');
    eq(r.errors, [], '正常匯入：無錯誤');
    eq(dataSvc._calls.createSubstituteRecord, 2, '正常匯入：實際呼叫 createSubstituteRecord 2 次');
    const created = dataSvc._records;
    ok(created.every(x => x.isLegacy === true), '正常匯入：每筆皆標記 isLegacy=true');
    ok(created.every(x => x.migratedFrom && x.migratedFrom.source === 'firestore' && x.migratedFrom.legacyKey), '正常匯入：每筆皆帶 migratedFrom.source/legacyKey');
    ok(created.every(x => x.originalTeacherId === 'tch_1' && x.substituteTeacherId === 'tch_2'), '正常匯入：教師姓名正確反查 teacherId');
    ok(created.every(x => x.status === 'approved'), '正常匯入：預設 status 為 approved');
    eq(logger.entries.length, 1, '正常匯入：寫入 1 筆操作日誌');
    eq(logger.entries[0].action, LOG_ACTIONS.DATA_MIGRATE, '正常匯入：日誌 action 為 DATA_MIGRATE');
    eq(logger.entries[0].details.created, 2, '正常匯入：日誌 details.created 正確');
}

/* ================= 6. 冪等性：同一份舊資料連跑兩次，第二次必須 0 created ================= */
{
    const { dataSvc } = useMocks({
        teachers: [{ teacherId: 'tch_1', name: '甲師' }, { teacherId: 'tch_2', name: '乙師' }],
        firestoreLegacy: {
            substituteRecords: [
                legacyRecord({ date: '2026-05-04' }),
                legacyRecord({ date: '2026-05-05', period: '第五節' }),
                legacyRecord({ date: '2026-05-06', period: '第六節' }),
            ],
            lastModified: '2026-06-01T00:00:00.000Z',
        },
    });
    const run1 = await legacyMigration.migrateLegacyRecords({});
    eq(run1.created, 3, '冪等-第一次：新增 3 筆');
    eq(run1.skipped, 0, '冪等-第一次：略過 0 筆');
    const countAfterRun1 = dataSvc._records.length;

    // 第二次呼叫前，dataSvc.listSubstituteRecords() 現在會回傳第一次遷移建立的 3 筆紀錄，
    // 但 __testHooks.dataSvc 本身沒被重新指派（同一個 mock 實例持續累積），符合真實情境
    // （Firestore 集合是持續累積的）。firestoreLegacy 讀取器也維持同一份資料未變動。
    const run2 = await legacyMigration.migrateLegacyRecords({});
    eq(run2.created, 0, '冪等-第二次：新增 0 筆（硬性要求）');
    eq(run2.skipped, 3, '冪等-第二次：3 筆皆因 legacyKey 已存在而略過');
    eq(dataSvc._records.length, countAfterRun1, '冪等：兩次遷移後總筆數不變（未產生重複資料）');
}

/* ================= 7. 姓名對不到帳號：仍要匯入，並收集 unmatchedNames ================= */
{
    const { dataSvc } = useMocks({
        teachers: [{ teacherId: 'tch_1', name: '甲師' }], // 乙師不存在於教師名單
        firestoreLegacy: { substituteRecords: [legacyRecord()], lastModified: '2026-06-01T00:00:00.000Z' },
    });
    const r = await legacyMigration.migrateLegacyRecords({});
    eq(r.created, 1, '姓名對不到帳號：仍然新增 1 筆（不因對不到 ID 而丟棄）');
    eq(r.unmatchedNames, ['乙師'], '姓名對不到帳號：unmatchedNames 收集到「乙師」');
    const rec = dataSvc._records[0];
    eq(rec.originalTeacherId, 'tch_1', '姓名對不到帳號：originalTeacherId 仍正確解析');
    eq(rec.substituteTeacherId, null, '姓名對不到帳號：substituteTeacherId 為 null（非拋錯或跳過）');
}

/* ================= 7b. 舊資料來源本身重複列：同批次內第二筆視為已存在，避免自我重複 ================= */
{
    const { dataSvc } = useMocks({
        teachers: [{ teacherId: 'tch_1', name: '甲師' }, { teacherId: 'tch_2', name: '乙師' }],
        firestoreLegacy: { substituteRecords: [legacyRecord(), legacyRecord()], lastModified: '2026-06-01T00:00:00.000Z' },
    });
    const r = await legacyMigration.migrateLegacyRecords({});
    eq(r.total, 2, '批次內重複列：total 仍為 2');
    eq(r.created, 1, '批次內重複列：只有第一筆真正新增');
    eq(r.skipped, 1, '批次內重複列：第二筆因 key 相同視為已存在而略過');
    eq(dataSvc._records.length, 1, '批次內重複列：實際只寫入 1 筆');
}

/* ================= 8. 未登入 director → 拒絕執行 ================= */
{
    useMocks({
        isDirector: false,
        firestoreLegacy: { substituteRecords: [legacyRecord()], lastModified: '2026-06-01T00:00:00.000Z' },
    });
    let threw = false, message = '';
    try { await legacyMigration.migrateLegacyRecords({}); }
    catch (e) { threw = true; message = e.message; }
    ok(threw, '非 director 呼叫 migrateLegacyRecords：應拋出例外');
    ok(message.includes('主任'), '非 director 呼叫：錯誤訊息提及僅主任可執行');
}

/* ================= 9. 無舊資料：回傳全零結果，不拋錯 ================= */
{
    useMocks({ firestoreLegacy: null, localStorageLegacy: null });
    const r = await legacyMigration.migrateLegacyRecords({});
    eq(r.total, 0, '無舊資料：total 為 0');
    eq(r.created, 0, '無舊資料：created 為 0');
    eq(r.skipped, 0, '無舊資料：skipped 為 0');
    eq(r.unmatchedNames, [], '無舊資料：unmatchedNames 為空陣列');
    eq(r.errors, [], '無舊資料：errors 為空陣列');
}

/* ================= 10. onProgress 節流：每 10 筆回報一次，且最後一筆一定回報 ================= */
{
    const teachers = [{ teacherId: 'tch_1', name: '甲師' }, { teacherId: 'tch_2', name: '乙師' }];
    const records = Array.from({ length: 25 }, (_, i) => legacyRecord({ date: `2026-05-${String(i + 1).padStart(2, '0')}` }));
    useMocks({ teachers, firestoreLegacy: { substituteRecords: records, lastModified: '2026-06-01T00:00:00.000Z' } });

    const progressCalls = [];
    const r = await legacyMigration.migrateLegacyRecords({ onProgress: (p) => progressCalls.push({ ...p }) });
    eq(r.created, 25, 'onProgress：25 筆全數新增');
    eq(progressCalls.length, 3, 'onProgress：25 筆應回報 3 次（第 10、20、25 筆）');
    eq(progressCalls.map(p => p.done), [10, 20, 25], 'onProgress：done 依序為 10/20/25');
    ok(progressCalls.every(p => p.total === 25), 'onProgress：total 每次皆為 25');
}

/* ================= 11. onProgress 拋錯不可中斷遷移 ================= */
{
    const teachers = [{ teacherId: 'tch_1', name: '甲師' }, { teacherId: 'tch_2', name: '乙師' }];
    useMocks({ teachers, firestoreLegacy: { substituteRecords: [legacyRecord()], lastModified: '2026-06-01T00:00:00.000Z' } });
    const r = await legacyMigration.migrateLegacyRecords({ onProgress: () => { throw new Error('UI 回呼故意壞掉'); } });
    eq(r.created, 1, 'onProgress 拋錯：遷移仍完成，不受回呼例外影響');
}

/* ================= 12. 模擬 v2-app.js 的「先下載備份、失敗即中止」流程 ================= */
/* legacyMigrationService.js 刻意不碰 DOM（無 Blob/URL.createObjectURL），實際下載由呼叫端
 * （v2-app.js 的 downloadLegacyBackupJson）注入的 downloadFn 執行；這裡直接呼叫真正的
 * getLegacyBackupPayload() / migrateLegacyRecords()，依 v2-app.js 綁定按鈕時完全相同的順序
 * 呼叫，驗證「downloadFn 拋錯 → 絕不呼叫 migrateLegacyRecords（createSubstituteRecord 呼叫數
 * 仍為 0）」；「downloadFn 成功 → 才會繼續遷移」。 */
async function simulateMigrateButtonFlow(downloadFn) {
    const backup = await legacyMigration.getLegacyBackupPayload();
    if (!backup) return { aborted: true, reason: 'no-data' };
    try {
        await downloadFn(backup);
    } catch (_) {
        return { aborted: true, reason: 'download-failed' };
    }
    const stats = await legacyMigration.migrateLegacyRecords({});
    return { aborted: false, stats };
}
{
    const { dataSvc } = useMocks({
        teachers: [{ teacherId: 'tch_1', name: '甲師' }, { teacherId: 'tch_2', name: '乙師' }],
        firestoreLegacy: { substituteRecords: [legacyRecord()], lastModified: '2026-06-01T00:00:00.000Z' },
    });
    const failingDownload = async () => { throw new Error('瀏覽器封鎖下載'); };
    const result = await simulateMigrateButtonFlow(failingDownload);
    ok(result.aborted === true && result.reason === 'download-failed', '下載備份失敗：流程回報 aborted/download-failed');
    eq(dataSvc._calls.createSubstituteRecord, 0, '下載備份失敗：完全未呼叫 createSubstituteRecord（遷移未執行）');
}
{
    const { dataSvc } = useMocks({
        teachers: [{ teacherId: 'tch_1', name: '甲師' }, { teacherId: 'tch_2', name: '乙師' }],
        firestoreLegacy: { substituteRecords: [legacyRecord()], lastModified: '2026-06-01T00:00:00.000Z' },
    });
    const okDownload = async () => { /* 模擬成功觸發瀏覽器下載 */ };
    const result = await simulateMigrateButtonFlow(okDownload);
    ok(result.aborted === false, '下載備份成功：流程未中止');
    eq(result.stats.created, 1, '下載備份成功：繼續完成遷移，新增 1 筆');
    eq(dataSvc._calls.createSubstituteRecord, 1, '下載備份成功：createSubstituteRecord 確實被呼叫');
}

console.log(`\n結果：通過 ${pass}，失敗 ${fail}`);

/* ================================================================================
 * 13. batch 大小推導（模擬 + 推算，不對 production Firestore 做任何寫入）
 *
 * 依 firestore.rules 實際內容（substituteRecords create 規則呼叫 isApprover(schoolId)）
 * 逐一追蹤呼叫鏈，手算每個分支會觸發幾次 get()/exists() rules document access：
 * ================================================================================ */
{
    // 最佳情況：登入 email 就在 schools/inhu/config/main.initialAdminEmails 白名單內，
    // isInitialDirector() 短路成立即回傳 true，完全不進入 myTeacherExists/myTeacherDoc 分支。
    // configExists() 1 次 get/exists 呼叫（exists）；configDoc() 在 isInitialDirector 內被
    // 文字呼叫兩次（.initialAdminEmails is list 一次、.hasAny(...) 一次）——是否會被 Firestore
    // 依相同 path 快取尚無法從程式碼本身確認，故保守不假設快取，逐次計數。
    const BEST_CASE_ACCESS_PER_CREATE = 1 /* configExists */ + 2 /* configDoc ×2 */;

    // 最差情況：email 不在白名單（例如 section_chief、或後補晉升未寫入 config 的主任），
    // isInitialDirector 先落空（仍花掉 3 次），接著 myTeacherExists()（內部呼叫
    // mappingExists 與巢狀 myTeacherId→mappingExists+myMapping，再加自身的 exists）與
    // myTeacherDoc()（內部再次呼叫 myTeacherId→mappingExists+myMapping，再加自身的 get）
    // 皆需求值，若無任何快取，粗估總數落在 10 次左右。
    const WORST_CASE_ACCESS_PER_CREATE_NO_CACHE = 10;

    // Firestore 對單一 batch / transaction 的 rules document access 上限（依 Firestore 文件，
    // 「Each transaction or batch of writes can perform a maximum of 20 document access calls
    // via get()/exists() in Security Rules, shared across all writes in that transaction/batch」
    // ——重點是「共用同一額度」，不是每筆各自 20 次）。
    const SHARED_BUDGET_PER_BATCH = 20;

    const planDocBatchSize = 400; // docs/PLAN_v2.0.0.md §7 原訂數字
    const candidateSmallBatch = 10; // 若堅持要用 writeBatch，PLAN 外最直覺會想到的保守數字

    console.log('\n---- batch 大小推導（見 legacyMigrationService.js 檔頭註解的完整版本）----');
    console.log(`樂觀估計：每筆 create 觸發 ${BEST_CASE_ACCESS_PER_CREATE} 次 rules document access（白名單主任捷徑）`);
    console.log(`悲觀估計：每筆 create 觸發約 ${WORST_CASE_ACCESS_PER_CREATE_NO_CACHE} 次（需查 teachers/userMappings 才能判定 approver 身份）`);
    console.log(`單一 batch/transaction 共用配額：約 ${SHARED_BUDGET_PER_BATCH} 次`);
    console.log(`→ PLAN 原訂批次 ${planDocBatchSize} 筆：樂觀 ${planDocBatchSize * BEST_CASE_ACCESS_PER_CREATE} 次／悲觀 ${planDocBatchSize * WORST_CASE_ACCESS_PER_CREATE_NO_CACHE} 次，皆遠超配額 → 不可行`);
    console.log(`→ 保守小批次 ${candidateSmallBatch} 筆：樂觀 ${candidateSmallBatch * BEST_CASE_ACCESS_PER_CREATE} 次（已達/超過配額，無安全餘裕）／悲觀 ${candidateSmallBatch * WORST_CASE_ACCESS_PER_CREATE_NO_CACHE} 次（遠超配額）→ 仍不可行`);

    ok(planDocBatchSize * BEST_CASE_ACCESS_PER_CREATE > SHARED_BUDGET_PER_BATCH, '批次推導：PLAN 原訂 400 筆/batch 即使用最樂觀估計仍超過共用配額');
    ok(candidateSmallBatch * BEST_CASE_ACCESS_PER_CREATE >= SHARED_BUDGET_PER_BATCH, '批次推導：保守的 10 筆/batch 用最樂觀估計也已無安全餘裕（20/20）');
    ok(candidateSmallBatch * WORST_CASE_ACCESS_PER_CREATE_NO_CACHE > SHARED_BUDGET_PER_BATCH, '批次推導：10 筆/batch 用悲觀估計遠超配額');

    // 結論：任何會被同一 writeBatch/runTransaction 共用配額的分組寫入，安全批次大小都小到
    // 個位數、且隨遷移操作者是否在白名單內而變動，不值得維護一個「魔術數字」。
    // 本模組選擇的策略——逐筆呼叫 dataSvc.createSubstituteRecord()（單一 setDoc，不進
    // batch/transaction）——讓每筆的 rules 判斷各自獨立起算配額，等同「安全批次大小 = 1」，
    // 徹底迴避這個問題。上面第 5～11 節的測試已證明這個策略在冪等性、姓名對應、進度回報、
    // 下載中止等情境下都正確運作。
    console.log('結論：本模組不使用 writeBatch/runTransaction，逐筆呼叫 createSubstituteRecord()（單一 setDoc），迴避共用配額問題，等同「安全批次大小 = 1」。\n');
}

console.log(`\n最終結果：通過 ${pass}，失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
