/**
 * V2 教師名單 CSV 批次匯入單元測試（Phase 4b）
 * 執行：node test/test-roster-import.mjs
 *
 * 直接匯入真正的 teacherAccountManager.js（不複製一份邏輯），透過其匯出的
 * __testHooks 把 schoolDataService / operationLogger 換成記憶體 mock，藉此在
 * 不啟動 Firebase / 瀏覽器環境的情況下驗證 importRosterCsv 的純邏輯（含冪等性）。
 * 全程不對 production Firestore 做任何讀寫。
 */

import * as teacherMgr from '../src/js/modules/v2/teacherAccountManager.js';
import { ROLES, LOG_ACTIONS } from '../src/js/modules/v2/schemaConstants.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (actual === expected) { pass++; }
    else { fail++; console.error(`✗ ${label}：預期 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`); }
}
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.error(`✗ ${label}`); }
}

/* ---------- 記憶體 mock：取代 schoolDataService 的教師相關函式 ---------- */
function makeMockDataSvc(initialTeachers = []) {
    let seq = 1;
    const store = new Map(initialTeachers.map(t => [t.teacherId, { ...t }]));
    const calls = { createTeacher: 0, updateTeacher: 0 };
    return {
        _store: store,
        _calls: calls,
        async listTeachers() {
            return Array.from(store.values()).map(t => ({ ...t }));
        },
        async createTeacher({ name, email = null, domains = [], homeroomClass = '', role = 'teacher' }) {
            calls.createTeacher++;
            const teacherId = `tch_mock_${seq++}`;
            const rec = {
                teacherId, name,
                email: email ? email.toLowerCase().trim() : null,
                domains: Array.isArray(domains) ? domains : [],
                homeroomClass: homeroomClass || '',
                role,
            };
            store.set(teacherId, rec);
            return { ...rec };
        },
        async updateTeacher(teacherId, patch) {
            calls.updateTeacher++;
            const cur = store.get(teacherId);
            if (!cur) throw new Error('mock: 找不到教師 ' + teacherId);
            const next = { ...cur, ...patch };
            if (Object.prototype.hasOwnProperty.call(patch, 'email') && patch.email) {
                next.email = patch.email.toLowerCase().trim();
            }
            store.set(teacherId, next);
            return { ...next };
        },
    };
}

function makeMockLogger() {
    const entries = [];
    return { entries, async log(action, targetType, targetId, details) { entries.push({ action, targetType, targetId, details }); } };
}

/** 換上一組全新的 mock dataSvc / logger，回傳兩者供測試斷言用。 */
function useMocks(initialTeachers = []) {
    const svc = makeMockDataSvc(initialTeachers);
    const log = makeMockLogger();
    teacherMgr.__testHooks.dataSvc = svc;
    teacherMgr.__testHooks.logger = log;
    return { svc, log };
}

/* ================= 1. 正常匯入 ================= */
{
    const { svc, log } = useMocks();
    const rows = [
        { 姓名: '[測試]甲', Email: 'a@x.com', 角色: '主任', 領域: '國文、英文', 導師班: '701' },
        { 姓名: '[測試]乙', Email: '', 角色: '', 領域: '', 導師班: '' },
    ];
    const r = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    eq(r.created.length, 2, '正常匯入：新增 2 筆');
    eq(r.updated.length, 0, '正常匯入：更新 0 筆');
    eq(r.errors.length, 0, '正常匯入：無錯誤');
    eq(svc._calls.createTeacher, 2, '正常匯入：實際呼叫 createTeacher 2 次');
    const all = await svc.listTeachers();
    const 甲 = all.find(t => t.name === '[測試]甲');
    const 乙 = all.find(t => t.name === '[測試]乙');
    eq(甲.role, ROLES.DIRECTOR, '正常匯入：中文角色「主任」→ director');
    eq(甲.domains.join(','), '國文,英文', '正常匯入：領域頓號分隔');
    eq(乙.role, ROLES.TEACHER, '正常匯入：角色留空預設 teacher');
    eq(乙.email, null, '正常匯入：Email 留空為 null');
    eq(log.entries.length, 1, '正常匯入：寫入 1 筆操作日誌');
    eq(log.entries[0].action, LOG_ACTIONS.ROSTER_IMPORT, '正常匯入：日誌 action 為 ROSTER_IMPORT');
    eq(log.entries[0].details.createdCount, 2, '正常匯入：日誌 details.createdCount 正確');
}

/* ================= 2. 姓名重複 → update ================= */
{
    const { svc } = useMocks([
        { teacherId: 'tch_1', name: '[測試]丙', email: null, domains: [], homeroomClass: '', role: 'teacher' },
    ]);
    const rows = [
        { 姓名: '[測試]丙', Email: 'bing@x.com', 角色: '組長', 領域: '數學', 導師班: '801' },
    ];
    const r = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    eq(r.created.length, 0, '姓名重複：新增 0 筆');
    eq(r.updated.length, 1, '姓名重複：更新 1 筆');
    eq(svc._calls.createTeacher, 0, '姓名重複：未呼叫 createTeacher');
    eq(svc._calls.updateTeacher, 1, '姓名重複：呼叫 updateTeacher 1 次');
    const after = (await svc.listTeachers())[0];
    eq(after.email, 'bing@x.com', '姓名重複：email 已更新');
    eq(after.role, ROLES.SECTION_CHIEF, '姓名重複：角色已更新為 section_chief');
    eq(after.homeroomClass, '801', '姓名重複：導師班已更新');
}

/* ================= 2b. 更新時留空欄位不清空既有資料（避免誤將主任打回教師） ================= */
{
    const { svc } = useMocks([
        { teacherId: 'tch_1', name: '[測試]丁', email: 'ding@x.com', domains: ['地科'], homeroomClass: '901', role: ROLES.DIRECTOR },
    ]);
    const rows = [
        { 姓名: '[測試]丁', Email: '', 角色: '', 領域: '', 導師班: '' },
    ];
    const r = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    const after = (await svc.listTeachers())[0];
    eq(after.role, ROLES.DIRECTOR, '留空更新：角色不被打回 teacher，保留 director');
    eq(after.email, 'ding@x.com', '留空更新：email 保留原值');
    eq(after.homeroomClass, '901', '留空更新：導師班保留原值');
    eq(r.updated.length + r.skipped.length, 1, '留空更新：該列計入 updated 或 skipped 其一（此實作應為 skipped）');
}

/* ================= 3. email 被他人佔用 → error ================= */
{
    useMocks([
        { teacherId: 'tch_1', name: '[測試]戊', email: 'wu@x.com', domains: [], homeroomClass: '', role: 'teacher' },
    ]);
    const rows = [
        { 姓名: '[測試]己', Email: 'wu@x.com', 角色: '', 領域: '', 導師班: '' },
    ];
    const r = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    eq(r.created.length, 0, 'email 被佔用：新增 0 筆');
    eq(r.errors.length, 1, 'email 被佔用：1 筆錯誤');
    ok(r.errors[0].reason.includes('戊'), 'email 被佔用：錯誤原因提及既有教師姓名');
}

/* ================= 4. CSV 內重複 email → 首筆勝 ================= */
{
    useMocks();
    const rows = [
        { 姓名: '[測試]庚', Email: 'dup@x.com', 角色: '', 領域: '', 導師班: '' },
        { 姓名: '[測試]辛', Email: 'dup@x.com', 角色: '', 領域: '', 導師班: '' },
    ];
    const r = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    eq(r.created.length, 1, '重複 email：只有第一筆成功新增');
    eq(r.errors.length, 1, '重複 email：第二筆記為錯誤');
    eq(r.created[0].name, '[測試]庚', '重複 email：首筆（庚）勝出');
    ok(r.errors[0].reason.includes('第 2 列'), '重複 email：錯誤訊息指出重複的列號');
}

/* ================= 5. 非法角色 → error ================= */
{
    useMocks();
    const rows = [
        { 姓名: '[測試]壬', Email: '', 角色: '幹事', 領域: '', 導師班: '' },
    ];
    const r = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    eq(r.created.length, 0, '非法角色：新增 0 筆');
    eq(r.errors.length, 1, '非法角色：1 筆錯誤');
    ok(r.errors[0].reason.includes('角色'), '非法角色：錯誤原因提及角色');
}

/* ================= 6. 姓名空白 → error ================= */
{
    useMocks();
    const rows = [
        { 姓名: '', Email: 'noname@x.com', 角色: '', 領域: '', 導師班: '' },
        { 姓名: '   ', Email: '', 角色: '', 領域: '', 導師班: '' },
    ];
    const r = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    eq(r.created.length, 0, '姓名空白：新增 0 筆');
    eq(r.errors.length, 2, '姓名空白：2 筆皆記為錯誤（含純空白姓名）');
}

/* ================= 7. dryRun 不寫入 ================= */
{
    const { svc, log } = useMocks();
    const rows = [
        { 姓名: '[測試]癸', Email: 'gui@x.com', 角色: '教師', 領域: '', 導師班: '' },
    ];
    const r = await teacherMgr.importRosterCsv(rows, { dryRun: true });
    eq(r.created.length, 1, 'dryRun：預覽仍顯示新增 1 筆');
    eq(svc._calls.createTeacher, 0, 'dryRun：未實際呼叫 createTeacher');
    eq(svc._calls.updateTeacher, 0, 'dryRun：未實際呼叫 updateTeacher');
    eq((await svc.listTeachers()).length, 0, 'dryRun：store 內仍無任何教師');
    eq(log.entries.length, 0, 'dryRun：未寫入操作日誌');
}

/* ================= 8. 冪等性：同一份資料連跑兩次結果必須相同 ================= */
{
    const { svc, log } = useMocks();
    const rows = [
        { 姓名: '[測試]子', Email: 'zi@x.com', 角色: '主任', 領域: '國文', 導師班: '701' },
        { 姓名: '[測試]丑', Email: '', 角色: '', 領域: '', 導師班: '' },
        { 姓名: '[測試]寅', Email: 'zi@x.com', 角色: '', 領域: '', 導師班: '' }, // 與「子」email 重複 → 每次都應該錯誤
        { 姓名: '', Email: '', 角色: '', 領域: '', 導師班: '' },                  // 姓名空白 → 每次都應該錯誤
    ];

    const run1 = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    eq(run1.created.length, 2, '冪等-第一次：新增 2 筆（子、丑）');
    eq(run1.updated.length, 0, '冪等-第一次：更新 0 筆');
    eq(run1.errors.length, 2, '冪等-第一次：2 筆錯誤（寅重複 email、空白姓名）');
    const countAfterRun1 = (await svc.listTeachers()).length;

    const run2 = await teacherMgr.importRosterCsv(rows, { dryRun: false });
    eq(run2.created.length, 0, '冪等-第二次：新增 0 筆（不重複建立）');
    eq(run2.updated.length, 0, '冪等-第二次：更新 0 筆（資料未變動）');
    eq(run2.skipped.length, 2, '冪等-第二次：子、丑皆因資料與現況相同而略過');
    eq(run2.errors.length, 2, '冪等-第二次：錯誤筆數與第一次相同');
    const countAfterRun2 = (await svc.listTeachers()).length;
    eq(countAfterRun2, countAfterRun1, '冪等：兩次匯入後教師總數不變（未產生重複資料）');
    eq(log.entries.length, 1, '冪等：第二次無實際異動（created+updated=0），不再寫入操作日誌');
}

console.log(`\n結果：通過 ${pass}，失敗 ${fail}`);

/* ================= 附加：用 test/roster-sample.csv 實際跑一次 dryRun 預覽（驗收條件 3） ================= */
console.log('\n---- test/roster-sample.csv dryRun 預覽（模擬全新空白名單）----');
{
    useMocks(); // 全新空白教師名單，模擬全校第一次 onboarding
    const csvText = readFileSync(join(__dirname, 'roster-sample.csv'), 'utf8');
    const rows = parseCsvToObjects(csvText);
    const preview = await teacherMgr.importRosterCsv(rows, { dryRun: true });
    console.log(`新增 ${preview.created.length} 筆／更新 ${preview.updated.length} 筆／略過 ${preview.skipped.length} 筆／錯誤 ${preview.errors.length} 筆`);
    preview.errors.forEach(e => console.log(`  第 ${e.row} 列．${e.name}．${e.reason}`));
}

process.exit(fail === 0 ? 0 : 1);

/* ---------- 極簡但正確處理雙引號欄位（含內嵌逗號、跳脫雙引號）的 CSV 解析器 ----------
 * 僅供本測試腳本讀取 test/roster-sample.csv 示範用；正式程式（v2-app.js）一律使用瀏覽器端 PapaParse。 */
function parseCsvToObjects(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { rows.push(row); row = []; };
    const src = text.replace(/\r\n/g, '\n');
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inQuotes) {
            if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; } }
            else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') pushField();
        else if (c === '\n') { pushField(); pushRow(); }
        else field += c;
    }
    if (field.length || row.length) { pushField(); pushRow(); }
    const clean = rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
    const header = clean[0].map(h => h.trim());
    return clean.slice(1).map(r => {
        const obj = {};
        header.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
        return obj;
    });
}
