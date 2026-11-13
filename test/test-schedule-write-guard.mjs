/**
 * 課表寫入守門＋服務層（純 node、離線，用假 Firebase SDK）
 * 執行：node test/test-schedule-write-guard.mjs
 *
 * 涵蓋（審計 logic-flow H-1／M-4、ux H7）：
 *   (a) 守門純函式：空覆寫非空被擋、allowEmpty 放行、版本不符（過期）被擋、版本相符通過、expected:null 的建立語意
 *   (b) schoolDataService.saveSchedule：兩個 approver 以同一舊版本先後寫入 → 第二個被拒、資料仍是第一個的
 *   (c) saveSchedule 的匯入前備份：覆寫非空課表時，同一次寫入留下被覆寫舊課表的快照，且可還原成原內容
 *   (d) activateSemester：目標學期已存在 → 課表內容不變、config 切換；全新學期 → 建立空殼；fromId 不符則中止
 *   (e) 「以空資料覆寫非空課表」在服務層被擋下，且沒有任何寫入發生
 */
import { register } from 'node:module';
register('./helpers/gstatic-stub-loader.mjs', import.meta.url);
globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const guard = await import('../src/js/modules/v2/scheduleWriteGuard.js');
const dataSvc = await import('../src/js/modules/v2/schoolDataService.js');
const { buildPreImportBackup, getRestorableSnapshot, makeSnapshot } = await import('../src/js/modules/scheduleImportHistory.js');
const { setActiveSchoolId } = await import('../src/js/modules/v2/schemaConstants.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const entry = (t, c, p) => ({ teacher: t, className: c, weekday: '星期一', period: p });
const doc = (n, extra = {}) => ({
    scheduleData: Array.from({ length: n }, (_, i) => entry(`T${i}`, '701', `第${i + 1}節`)),
    teachers: Array.from({ length: Math.min(n, 3) }, (_, i) => ({ name: `T${i}` })),
    classes: ['701'], subjectDomainMap: {}, schoolName: 'X', ...extra,
});
const EMPTY = { scheduleData: [], teachers: [], classes: [], subjectDomainMap: {}, schoolName: '' };

/* ---------- (a) 純函式 ---------- */
check('(a) isScheduleDocEmpty：null／三者皆空 → 空；有任一內容 → 非空',
    guard.isScheduleDocEmpty(null) && guard.isScheduleDocEmpty(EMPTY)
    && !guard.isScheduleDocEmpty({ ...EMPTY, teachers: [{ name: 'a' }] }) && !guard.isScheduleDocEmpty(doc(1)));
check('(a) 空資料覆寫非空課表 → empty-overwrite',
    guard.checkScheduleWrite({ existing: doc(5), incoming: EMPTY }).reason === 'empty-overwrite');
check('(a) allowEmpty:true 放行空覆寫', guard.checkScheduleWrite({ existing: doc(5), incoming: EMPTY, allowEmpty: true }).ok === true);
check('(a) 空資料寫入「本來就空」的文件 → 通過（建立新學期空殼）', guard.checkScheduleWrite({ existing: EMPTY, incoming: EMPTY }).ok === true);
check('(a) 非空資料覆寫非空 → 通過（正常匯入／編輯）', guard.checkScheduleWrite({ existing: doc(5), incoming: doc(6) }).ok === true);
const v3 = { ...doc(2), version: 3, updatedAt: 'T3' };
check('(a) expected 與雲端相符 → 通過',
    guard.checkScheduleWrite({ existing: v3, incoming: doc(3), expected: { version: 3, updatedAt: 'T3' } }).ok === true);
check('(a) version 落後 → conflict',
    guard.checkScheduleWrite({ existing: v3, incoming: doc(3), expected: { version: 2, updatedAt: 'T2' } }).reason === 'conflict');
check('(a) version 相同但 updatedAt 不同（被不認識 version 的舊 client 覆寫）→ conflict',
    guard.checkScheduleWrite({ existing: { ...doc(2), updatedAt: 'T9' }, incoming: doc(3), expected: { version: 0, updatedAt: 'T1' } }).reason === 'conflict');
check('(a) expected:null 而文件已存在 → conflict（不覆寫既有學期）',
    guard.checkScheduleWrite({ existing: doc(2), incoming: EMPTY, expected: null }).reason === 'conflict');
check('(a) expected:null 而文件不存在 → 通過', guard.checkScheduleWrite({ existing: null, incoming: EMPTY, expected: null }).ok === true);
check('(a) expected 有值但文件已消失 → conflict', guard.checkScheduleWrite({ existing: null, incoming: doc(1), expected: { version: 1, updatedAt: 'x' } }).reason === 'conflict');
check('(a) expected undefined → 不檢查版本', guard.checkScheduleWrite({ existing: v3, incoming: doc(3) }).ok === true);
check('(a) nextScheduleVersion：無 version 視為 0 → 1；3 → 4', guard.nextScheduleVersion(doc(1)) === 1 && guard.nextScheduleVersion(v3) === 4 && guard.nextScheduleVersion(null) === 1);
check('(a) expectedFromDoc：null→null；有文件→{version,updatedAt}',
    guard.expectedFromDoc(null) === null && JSON.stringify(guard.expectedFromDoc(v3)) === JSON.stringify({ version: 3, updatedAt: 'T3' }));
{
    let e = null;
    try { guard.assertScheduleWrite({ existing: doc(5), incoming: EMPTY }); } catch (x) { e = x; }
    check('(a) assertScheduleWrite 丟 ScheduleEmptyOverwriteError', e instanceof guard.ScheduleEmptyOverwriteError && e.code === 'schedule-empty-overwrite');
    e = null;
    try { guard.assertScheduleWrite({ existing: v3, incoming: doc(3), expected: { version: 1, updatedAt: 'a' } }); } catch (x) { e = x; }
    check('(a) assertScheduleWrite 丟 ScheduleConflictError', e instanceof guard.ScheduleConflictError && e.code === 'schedule-conflict');
}

/* ---------- 服務層 ---------- */
const F = (globalThis.__fake ||= { docs: new Map(), writes: [] });
setActiveSchoolId('t');
const SCH = (sid) => `schools/t/schedules/${sid}`;
const IMPS = (sid) => `schools/t/schedules/${sid}/imports`;
const CFG = 'schools/t/config/main';
const reset = () => { F.docs.clear(); F.writes.length = 0; };
const importsOf = (sid) => [...F.docs.entries()].filter(([k]) => k.startsWith(IMPS(sid) + '/')).map(([, v]) => v);

/* (b) 兩個 approver 以過期版本先後寫 */
{
    reset();
    const first = await dataSvc.saveSchedule('115-1', doc(4));                 // 建立 → v1
    check('(b) 第一次建立：version=1', first.version === 1 && F.docs.get(SCH('115-1')).version === 1);
    const baseA = guard.expectedFromDoc(F.docs.get(SCH('115-1')));
    const baseB = guard.expectedFromDoc(F.docs.get(SCH('115-1')));            // 兩位 approver 讀到同一版
    const wA = await dataSvc.saveSchedule('115-1', doc(5, { schoolName: 'A改的' }), { expected: baseA });
    check('(b) approver A 以現版本寫入成功 → version=2', wA.version === 2 && F.docs.get(SCH('115-1')).schoolName === 'A改的');
    const err = await rejects(() => dataSvc.saveSchedule('115-1', doc(6, { schoolName: 'B改的' }), { expected: baseB }));
    check('(b) approver B 以過期版本寫入 → ScheduleConflictError', err instanceof guard.ScheduleConflictError, String(err));
    check('(b) 雲端資料仍是 A 的（沒有被 B 蓋掉）', F.docs.get(SCH('115-1')).schoolName === 'A改的' && F.docs.get(SCH('115-1')).version === 2);
    const wB = await dataSvc.saveSchedule('115-1', doc(6, { schoolName: 'B重載後改的' }), { expected: { version: wA.version, updatedAt: wA.updatedAt } });
    check('(b) B 重新載入後以新版本寫入 → 成功 version=3', wB.version === 3);
}

/* (c) 匯入前備份可還原 */
{
    reset();
    await dataSvc.saveSchedule('115-1', doc(4, { lastImport: { fileName: 'old.xlsx', versionNo: 1 } }));
    const original = JSON.parse(JSON.stringify(F.docs.get(SCH('115-1'))));
    const cur = guard.expectedFromDoc(F.docs.get(SCH('115-1')));
    const incoming = doc(9, { schoolName: '新匯入' });
    const w = await dataSvc.saveSchedule('115-1', incoming, {
        expected: cur,
        backup: (existing) => buildPreImportBackup(existing, { importedAt: '2026-11-11T08:00:00.000Z' }),
    });
    check('(c) 寫入回傳 backupId', typeof w.backupId === 'string' && w.backupId.length > 0);
    check('(c) 主文件已是新課表', F.docs.get(SCH('115-1')).scheduleData.length === 9);
    const imps = importsOf('115-1');
    check('(c) imports 子集合多了 1 筆 pre_import 備份', imps.length === 1 && imps[0].source === 'pre_import' && imps[0].versionNo === null);
    const snap = getRestorableSnapshot(imps[0]);
    check('(c) 備份快照可還原：內容等於被覆寫前的舊課表',
        JSON.stringify(snap.scheduleData) === JSON.stringify(original.scheduleData)
        && JSON.stringify(snap.teachers) === JSON.stringify(original.teachers)
        && JSON.stringify(snap.classes) === JSON.stringify(original.classes));
    check('(c) 備份的 importedAt 比觸發它的匯入早（清單排序時新匯入排第一）', imps[0].importedAt < '2026-11-11T08:00:00.000Z');
    // 以快照還原（走同一條 saveSchedule）
    const restored = makeSnapshot(snap);
    await dataSvc.saveSchedule('115-1', { ...doc(0), ...restored }, { expected: guard.expectedFromDoc(F.docs.get(SCH('115-1'))) });
    check('(c) 以備份快照還原後課表節數回到 4', F.docs.get(SCH('115-1')).scheduleData.length === 4);
    // 原本就空的課表被覆寫：不留空備份
    reset();
    await dataSvc.saveSchedule('115-2', EMPTY);
    await dataSvc.saveSchedule('115-2', doc(3), { backup: (ex) => buildPreImportBackup(ex) });
    check('(c) 被覆寫的是空課表 → 不產生備份紀錄', importsOf('115-2').length === 0);
}

/* (e) 空資料覆寫非空：服務層擋下且零寫入 */
{
    reset();
    await dataSvc.saveSchedule('115-1', doc(4));
    const before = F.writes.length;
    const err = await rejects(() => dataSvc.saveSchedule('115-1', EMPTY));
    check('(e) 空覆寫 → ScheduleEmptyOverwriteError', err instanceof guard.ScheduleEmptyOverwriteError, String(err));
    check('(e) 被擋下時沒有任何寫入、課表原封不動', F.writes.length === before && F.docs.get(SCH('115-1')).scheduleData.length === 4);
    const ok = await rejects(() => dataSvc.saveSchedule('115-1', EMPTY, { allowEmpty: true }));
    check('(e) allowEmpty:true（清除所有資料）才可清空', ok === null && F.docs.get(SCH('115-1')).scheduleData.length === 0);
}

/* (d) activateSemester */
{
    reset();
    F.docs.set(CFG, { currentSemester: '115-2', schoolName: 'X' });
    F.docs.set(SCH('115-1'), { ...doc(7, { schoolName: '上學期' }), version: 4, updatedAt: 'U1' });
    F.docs.set(SCH('115-2'), { ...doc(2), version: 1, updatedAt: 'U2' });
    const shell = { ...EMPTY, meta: { lastAction: 'semester_opened' } };
    const before = JSON.parse(JSON.stringify(F.docs.get(SCH('115-1'))));
    const r = await dataSvc.activateSemester({ fromId: '115-2', toId: '115-1', shell });
    check('(d-a) 目標學期已存在：回報未建立課表', r.createdSchedule === false);
    check('(d-a) 目標學期課表內容完全不變', JSON.stringify(F.docs.get(SCH('115-1'))) === JSON.stringify(before));
    check('(d-a) config.currentSemester 切換為 115-1（其餘欄位保留）', F.docs.get(CFG).currentSemester === '115-1' && F.docs.get(CFG).schoolName === 'X');
    check('(d-a) 沒有對 115-1 課表文件寫入', !F.writes.some(w => w.path === SCH('115-1')));

    // 切到全新學期
    const r2 = await dataSvc.activateSemester({ fromId: '115-1', toId: '116-1', shell });
    check('(d-b) 全新學期：建立空課表', r2.createdSchedule === true && guard.isScheduleDocEmpty(F.docs.get(SCH('116-1'))) && F.docs.get(SCH('116-1')).version === 1);
    check('(d-b) config 同步切換為 116-1', F.docs.get(CFG).currentSemester === '116-1');

    // fromId 不符（別人已經切走）→ 中止、零寫入
    const w0 = F.writes.length;
    const err = await rejects(() => dataSvc.activateSemester({ fromId: '115-1', toId: '117-1', shell }));
    check('(d-c) fromId 與雲端目前學期不符 → 中止', err instanceof Error && /已被改為/.test(err.message), String(err));
    check('(d-c) 中止時沒有任何寫入', F.writes.length === w0 && !F.docs.has(SCH('117-1')));
}

process.stdout.write(`\n${failed ? '失敗' : '全部通過'}：通過 ${passed}、失敗 ${failed}\n`);
process.exit(failed ? 1 : 0);
