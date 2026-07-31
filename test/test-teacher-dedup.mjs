/**
 * V2 新增教師防重單元測試
 * 執行：node test/test-teacher-dedup.mjs
 *
 * 背景：teacherAccountManager.createTeacher() 原本是「裸建立」——沒有任何唯一性檢查，
 * 同一個姓名連按兩次新增就會產生兩筆教師檔。而 V1 側（dataManager.teachers）以姓名為鍵、
 * 分不出是哪一筆，導致領域／導師班級的編輯與刪除都對不上目標（production 的「藍奕麟」
 * 就有兩筆同名檔，一筆零引用的孤兒）。本檔驗證補上的防重邏輯。
 *
 * 與 test-roster-import.mjs 相同做法：匯入真正的模組，透過 __testHooks 換上記憶體
 * mock，全程不對 production Firestore 做任何讀寫。
 */

import * as teacherMgr from '../src/js/modules/v2/teacherAccountManager.js';
import { LOG_ACTIONS } from '../src/js/modules/v2/schemaConstants.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (actual === expected) { pass++; }
    else { fail++; console.error(`✗ ${label}：預期 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`); }
}
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.error(`✗ ${label}`); }
}
/** 斷言 fn() 會拋錯，且錯誤訊息包含 needle */
async function throwsWith(fn, needle, label) {
    try {
        await fn();
        fail++; console.error(`✗ ${label}：預期拋錯但成功回傳`);
        return null;
    } catch (e) {
        if (String(e.message).includes(needle)) { pass++; return e; }
        fail++; console.error(`✗ ${label}：錯誤訊息應含「${needle}」，實得「${e.message}」`);
        return e;
    }
}

function makeMockDataSvc(initialTeachers = []) {
    let seq = 1;
    const store = new Map(initialTeachers.map(t => [t.teacherId, { ...t }]));
    const calls = { createTeacher: 0, deleteTeacher: 0 };
    return {
        _store: store,
        _calls: calls,
        async listTeachers() {
            return Array.from(store.values()).map(t => ({ ...t }));
        },
        async getTeacher(id) {
            const t = store.get(id);
            return t ? { ...t } : null;
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
        async deleteTeacher(id) {
            calls.deleteTeacher++;
            store.delete(id);
        },
    };
}

function makeMockLogger() {
    const entries = [];
    return { entries, async log(action, targetType, targetId, details) { entries.push({ action, targetType, targetId, details }); } };
}

function useMocks(initialTeachers = []) {
    const svc = makeMockDataSvc(initialTeachers);
    const log = makeMockLogger();
    teacherMgr.__testHooks.dataSvc = svc;
    teacherMgr.__testHooks.logger  = log;
    return { svc, log };
}

/* ============================================================ */
console.log('=== createTeacher 防重 ===');

// 1. 全新姓名 → 正常建立
{
    const { svc, log } = useMocks();
    const t = await teacherMgr.createTeacher({ name: '王大明', email: 'wang@example.com' });
    ok(!!t.teacherId, '全新姓名可建立，回傳含 teacherId');
    eq(t.name, '王大明', '姓名正確');
    eq(t.email, 'wang@example.com', 'email 已正規化為小寫');
    eq(svc._calls.createTeacher, 1, '底層 createTeacher 呼叫 1 次');
    eq(log.entries.length, 1, '寫入 1 筆操作日誌');
    eq(log.entries[0].action, LOG_ACTIONS.TEACHER_CREATE, '日誌動作為 TEACHER_CREATE');
}

// 2. 同名 → 拒絕，且不得寫入任何資料
{
    const { svc, log } = useMocks([
        { teacherId: 'tch_a', name: '王大明', email: 'wang@example.com', role: 'teacher' },
    ]);
    await throwsWith(() => teacherMgr.createTeacher({ name: '王大明' }), '已存在於名單中', '同名應被拒絕');
    eq(svc._calls.createTeacher, 0, '同名被拒時不呼叫底層 createTeacher');
    eq(svc._store.size, 1, '同名被拒時名單筆數不變');
    eq(log.entries.length, 0, '同名被拒時不寫操作日誌');
}

// 3. 同名但前後有空白 → 仍視為同名（trim 後比對）
{
    const { svc } = useMocks([
        { teacherId: 'tch_a', name: '王大明', email: null, role: 'teacher' },
    ]);
    await throwsWith(() => teacherMgr.createTeacher({ name: '  王大明  ' }), '已存在於名單中',
        '姓名前後空白 trim 後仍判為同名');
    eq(svc._store.size, 1, '名單筆數不變');
}

// 4. 姓名空白 → 拒絕
{
    const { svc } = useMocks();
    await throwsWith(() => teacherMgr.createTeacher({ name: '   ' }), '姓名不可為空', '純空白姓名應被拒絕');
    await throwsWith(() => teacherMgr.createTeacher({}), '姓名不可為空', '缺少姓名欄位應被拒絕');
    eq(svc._calls.createTeacher, 0, '姓名不合法時不建立');
}

// 5. email 已被他人使用 → 拒絕（大小寫不敏感）
{
    const { svc } = useMocks([
        { teacherId: 'tch_a', name: '王大明', email: 'wang@example.com', role: 'teacher' },
    ]);
    const err = await throwsWith(
        () => teacherMgr.createTeacher({ name: '李小華', email: 'WANG@example.com' }),
        '已被教師', 'email 重複（不同大小寫）應被拒絕');
    ok(String(err?.message).includes('王大明'), '錯誤訊息指出佔用者姓名，主任才知道要找誰');
    eq(svc._calls.createTeacher, 0, 'email 重複時不建立');
}

// 6. 不同姓名 + 未填 email → 可建立多筆（26 位待指派 email 的實際情境）
{
    const { svc } = useMocks([
        { teacherId: 'tch_a', name: '王大明', email: null, role: 'teacher' },
    ]);
    const t1 = await teacherMgr.createTeacher({ name: '李小華' });
    const t2 = await teacherMgr.createTeacher({ name: '陳美玲', email: '' });
    eq(t1.email, null, '未填 email 存為 null');
    eq(t2.email, null, 'email 空字串存為 null');
    eq(svc._store.size, 3, '多位未指派 email 的教師可並存（不因 email 皆為 null 而誤判重複）');
}

// 7. 回滾情境：建立後刪除，名單應回到原狀（新增教師失敗時 UI 走這條路）
{
    const { svc } = useMocks();
    const t = await teacherMgr.createTeacher({ name: '待回滾教師' });
    eq(svc._store.size, 1, '建立後名單有 1 筆');
    await teacherMgr.deleteTeacher(t.teacherId);
    eq(svc._store.size, 0, '刪除後名單回到 0 筆（回滾不留孤兒）');
    // 回滾後同一個姓名必須能再次建立，否則使用者會被永久卡住
    const again = await teacherMgr.createTeacher({ name: '待回滾教師' });
    ok(!!again.teacherId, '回滾後同名可重新建立');
}

/* ============================================================ */
console.log(`\n結果：通過 ${pass}，失敗 ${fail}`);
if (fail > 0) process.exit(1);
