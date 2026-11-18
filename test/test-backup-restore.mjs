/**
 * 雲端完整備份的格式／驗證／還原計畫（純函式）＋匯出與還原的服務層（假 Firebase SDK，純 node、離線）
 * 執行：node test/test-backup-restore.mjs
 *
 * A. 純函式：序列化往返、格式版本、學校不符拒絕、V1 舊格式／學期封存檔辨識、筆數統計、內容雜湊、
 *    檔案被截斷或改動、還原計畫（哪些會還原、哪些不會、為什麼）
 * B. 服務層：分頁讀取不被 limit 截斷（650 筆跨 3 頁）、含兩個學期紀錄與 private/detail、
 *    教師 gating（非 approver 不能匯出）、以備份還原到被清空的學校後與原本一致、
 *    歷史學期紀錄／待審申請不還原且有明確統計、批次失敗時回報已完成與未完成、重複還原只補缺（冪等）
 */
import { register } from 'node:module';
register('./helpers/gstatic-stub-loader.mjs', import.meta.url);
globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const fmt = await import('../src/js/modules/v2/backupFormat.js');
const svc = await import('../src/js/modules/v2/backupService.js');
const ctl = await import('../src/js/modules/v2/backupController.js');
const roleSvc = await import('../src/js/modules/v2/roleService.js');
const semesterState = await import('../src/js/modules/v2/semesterState.js');
const { setActiveSchoolId } = await import('../src/js/modules/v2/schemaConstants.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ====================== A. 純函式 ====================== */

const sections = {
    config: { main: { currentSemester: '115-1', schoolName: 'X', initialAdminEmails: ['a@b.c'] }, settlement: { calendarId: 'c', calendarApiKey: 'k', weeksByYear: { 114: {} }, updatedAt: 't', updatedBy: 'u' } },
    teachers: [
        { id: 'tch_1', data: { name: '王', email: 'wang@example.edu.tw', role: 'director' } },
        { id: 'tch_2', data: { name: '李', email: null, role: 'teacher' } },
    ],
    schedules: [
        { id: '114-2', data: { scheduleData: [{ teacher: '王' }], teachers: [{ name: '王' }], classes: ['7年1班'], version: 2, updatedAt: 'U1' } },
        { id: '115-1', data: { scheduleData: [{ teacher: '王' }, { teacher: '李' }], teachers: [{ name: '王' }, { name: '李' }], classes: ['7年1班'], version: 3, updatedAt: 'U2' } },
    ],
    scheduleImports: [{ semesterId: '115-1', id: 'imp_1', data: { versionNo: 1, fileName: 'a.xlsx', source: 'file' } }],
    substituteRecords: [
        { id: 'rec_a', data: { semesterId: '115-1', date: '2026-09-07', type: '代課', originalTeacher: '王', substituteTeacher: '李' }, private: { leaveType: '病假', reason: 'r', allowedTeacherIds: ['tch_1'] } },
        { id: 'rec_b', data: { semesterId: '114-2', date: '2026-03-01', type: '代課', originalTeacher: '李', substituteTeacher: '王' }, private: { leaveType: '公假', allowedTeacherIds: ['tch_2'] } },
        { id: 'rec_c', data: { semesterId: '115-1', date: '2026-09-08', type: '調課', originalTeacher: '王', swapTeacher: '李' }, private: null },
    ],
    pendingRequests: [{ id: 'req_a', data: { semesterId: '115-1', status: 'pending_approval' }, private: { leaveType: '事假', allowedTeacherIds: ['tch_1'] } }],
};
const me = { uid: 'u1', email: 'wang@example.edu.tw', name: '王', role: 'director', teacherId: 'tch_1' };

const backup = await fmt.buildBackupFile({ schoolId: 'inhu', exportedAt: '2026-11-11T00:00:00.000Z', exportedBy: me, currentSemester: '115-1', sections });
check('A 格式欄位：format／formatVersion／meta.schoolId／exportedAt／exportedBy',
    backup.format === 'stsystem-cloud-backup' && backup.formatVersion === 1 && backup.meta.schoolId === 'inhu'
    && backup.meta.exportedAt === '2026-11-11T00:00:00.000Z' && backup.meta.exportedBy.email === 'wang@example.edu.tw' && backup.meta.currentSemester === '115-1');
check('A 筆數統計寫入 meta.counts（寫死期望值）', same(backup.meta.counts, {
    teachers: 2, schedules: 2, scheduleImports: 1, substituteRecords: 3, substituteRecordDetails: 2,
    pendingRequests: 1, pendingRequestDetails: 1, configDocs: 2,
}), JSON.stringify(backup.meta.counts));
check('A meta.excluded 列出不備份的項目（含 operationLogs）', backup.meta.excluded.some(x => x.includes('operationLogs')));
check('A 內容雜湊格式 sha256:<64 hex>', /^sha256:[0-9a-f]{64}$/.test(backup.meta.contentHash));
check('A 檔名含 schoolId 與日期', fmt.backupFileName('inhu', '2026-11-11') === 'STsystem_雲端備份_inhu_2026-11-11.json'
    && fmt.backupFileName('a/b', '2026-11-11') === 'STsystem_雲端備份_a_b_2026-11-11.json');

const text = fmt.serializeBackup(backup);
const ok1 = await fmt.parseAndValidateBackupText(text, { schoolId: 'inhu' });
check('A 序列化往返後驗證通過、內容一致', ok1.ok && same(ok1.backup.substituteRecords, backup.substituteRecords) && same(ok1.backup.teachers, backup.teachers));

const other = await fmt.parseAndValidateBackupText(text, { schoolId: 'another' });
check('A 學校不符 → 拒絕，訊息點名兩校', !other.ok && other.message.includes('inhu') && other.message.includes('another') && other.errors[0] === '學校不符');

const v1 = await fmt.parseAndValidateBackupText(JSON.stringify({ schoolName: 'X', scheduleData: [], teachers: [], classes: [], substituteRecords: [], settings: {} }), { schoolId: 'inhu' });
check('A V1 本機舊格式 → 辨識為 v1-local，訊息引導到「V1 資料遷移」', !v1.ok && v1.kind === 'v1-local' && v1.message.includes('V1 資料遷移') && v1.message.includes('不會寫入任何資料'));
const arch = await fmt.parseAndValidateBackupText(JSON.stringify({ meta: { schoolId: 'inhu', semesterId: '115-1', counts: {} }, schedule: null, substituteRecords: [] }), { schoolId: 'inhu' });
check('A 學期封存檔 → 辨識為 semester-archive 並拒絕', !arch.ok && arch.kind === 'semester-archive' && arch.message.includes('封存'));
const junk = await fmt.parseAndValidateBackupText('{"hello":1}', { schoolId: 'inhu' });
check('A 無法辨識的 JSON → unknown 並說明', !junk.ok && junk.kind === 'unknown');
const bad = await fmt.parseAndValidateBackupText('{not json', { schoolId: 'inhu' });
check('A 非 JSON → 明確訊息', !bad.ok && bad.message.includes('JSON'));
check('A detectBackupKind(null／陣列) → unknown', fmt.detectBackupKind(null) === 'unknown' && fmt.detectBackupKind([]) === 'unknown');

const future = JSON.parse(text); future.formatVersion = 99;
check('A 格式版本比系統新 → 拒絕並請更新', (await fmt.validateBackupFile(future, { schoolId: 'inhu' })).message.includes('更新'));
const noVer = JSON.parse(text); delete noVer.formatVersion;
check('A 缺格式版本 → 拒絕', !(await fmt.validateBackupFile(noVer, { schoolId: 'inhu' })).ok);
const noSchool = JSON.parse(text); delete noSchool.meta.schoolId;
check('A 缺來源學校 → 拒絕', !(await fmt.validateBackupFile(noSchool, { schoolId: 'inhu' })).ok);
const truncated = JSON.parse(text); truncated.substituteRecords.pop();
const tr = await fmt.validateBackupFile(truncated, { schoolId: 'inhu' });
check('A 檔案被截斷（筆數與檔頭不符）→ 拒絕', !tr.ok && tr.message.includes('筆數'), tr.message);
const tampered = JSON.parse(text); tampered.substituteRecords[0].data.substituteTeacher = '被改';
const tp = await fmt.validateBackupFile(tampered, { schoolId: 'inhu' });
check('A 內容被改動（雜湊不符）→ 拒絕', !tp.ok && tp.message.includes('檢查碼'), tp.message);
const dup = JSON.parse(text); dup.teachers.push(dup.teachers[0]); dup.meta.counts.teachers = 3; delete dup.meta.contentHash;
check('A 重複 id → 拒絕', !(await fmt.validateBackupFile(dup, { schoolId: 'inhu' })).ok);
const badId = JSON.parse(text); badId.teachers[0].id = 'a/b'; delete badId.meta.contentHash;
check('A id 含 / → 拒絕', !(await fmt.validateBackupFile(badId, { schoolId: 'inhu' })).ok);

/* 還原計畫 */
const emptyCloud = { teachers: [], configMainExists: true, settlement: null, schedules: {}, recordIds: [], pendingIds: [] };
const plan0 = fmt.planRestore({ backup: ok1.backup, cloud: emptyCloud, currentSemesterId: '115-1' });
check('A 計畫（空雲端）：教師 2 位待補回', plan0.teachers.create.length === 2);
check('A 計畫：目前學期紀錄 2 筆可還原、歷史學期 1 筆不可', plan0.records.create.length === 2 && plan0.records.historical === 1);
check('A 計畫：歷史學期課表 blocked-historical、目前學期課表 create',
    plan0.schedules.find(s => s.semesterId === '114-2').action === 'blocked-historical' && plan0.schedules.find(s => s.semesterId === '115-1').action === 'create');
check('A 計畫：待審申請不還原（1 筆）', plan0.pending.notRestored === 1);
check('A 計畫：config/main 雲端已有 → 不覆寫；settlement 雲端沒有 → 覆寫', plan0.config.main === 'skip-exists' && plan0.config.settlement === 'overwrite');
check('A 「不會還原」清單涵蓋歷史課表、歷史紀錄、待審、匯入紀錄、日誌',
    plan0.notRestored.some(x => x.includes('歷史學期課表') && x.includes('114-2'))
    && plan0.notRestored.some(x => x.includes('歷史學期的調代課紀錄 1 筆'))
    && plan0.notRestored.some(x => x.includes('待審申請 1 筆'))
    && plan0.notRestored.some(x => x.includes('匯入紀錄'))
    && plan0.notRestored.some(x => x.includes('操作日誌')));
check('A countPlannedWrites = 教師2 + 設定1 + 課表1 + 紀錄2 = 6', fmt.countPlannedWrites(plan0) === 6, String(fmt.countPlannedWrites(plan0)));
const sum = fmt.summarizeRestorePlan(plan0);
check('A 預覽表格各列（備份筆數／將還原筆數）', sum[0].backup === 2 && sum[0].willRestore === 2 && sum[3].backup === 3 && sum[3].willRestore === 2 && sum[4].willRestore === 0);

const fullCloud = fmt.cloudStateFromSections(sections);
const plan1 = fmt.planRestore({ backup: ok1.backup, cloud: fullCloud, currentSemesterId: '115-1' });
check('A 計畫（雲端已有相同內容）：沒有需要寫入的項目', fmt.countPlannedWrites(plan1) === 0 && plan1.schedules.every(s => s.action === 'same' || s.action === 'blocked-historical') && plan1.records.exists === 3, JSON.stringify(plan1.schedules.map(s => s.action)));
const emailClash = fmt.planRestore({ backup: ok1.backup, cloud: { ...emptyCloud, teachers: [{ id: 'tch_X', email: 'wang@example.edu.tw' }] }, currentSemesterId: '115-1' });
check('A email 已被雲端另一位教師使用 → 略過並列入不還原', emailClash.teachers.emailTaken.length === 1 && emailClash.teachers.create.length === 1);
const emptyBk = JSON.parse(JSON.stringify(ok1.backup)); emptyBk.schedules[1].data = { scheduleData: [], teachers: [], classes: [] };
const planEmpty = fmt.planRestore({ backup: emptyBk, cloud: fullCloud, currentSemesterId: '115-1' });
check('A 備份的課表是空的、雲端有內容 → 不覆寫（blocked-empty）', planEmpty.schedules.find(s => s.semesterId === '115-1').action === 'blocked-empty');
check('A classifyRecordForRestore：V1 遷移紀錄（isLegacy+migratedFrom）可還原；無學期不可',
    fmt.classifyRecordForRestore({ semesterId: '100-1', isLegacy: true, migratedFrom: 'x' }, '115-1') === 'ok'
    && fmt.classifyRecordForRestore({ date: 'x' }, '115-1') === 'no-semester');
check('A stripReservedFields 移除 recordId／reqId', same(fmt.stripReservedFields({ a: 1, recordId: 'x', reqId: 'y' }), { a: 1 }));

/* ====================== B. 服務層 ====================== */

const F = (globalThis.__fake ||= { docs: new Map(), writes: [] });
setActiveSchoolId('t');
semesterState.setCurrentSemesterId('115-1');
const P = 'schools/t';
const wipe = () => { F.docs.clear(); F.writes.length = 0; F.commits = 0; F.failBatchAt = null; };

function seedCloud({ nCur = 650, nOld = 40 } = {}) {
    wipe();
    F.docs.set(`${P}/config/main`, { currentSemester: '115-1', schoolName: 'T' });
    F.docs.set(`${P}/config/settlement`, { calendarId: 'c', calendarApiKey: 'k', weeksByYear: { 114: { 9: 4 } }, updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'u' });
    for (let i = 1; i <= 5; i++) F.docs.set(`${P}/teachers/tch_${String(i).padStart(2, '0')}`, { name: `T${i}`, email: `t${i}@example.edu.tw`, role: i === 1 ? 'director' : 'teacher', domains: [], homeroomClass: '' });
    F.docs.set(`${P}/schedules/114-2`, { scheduleData: [{ teacher: 'T1', className: '7年1班' }], teachers: [{ name: 'T1' }], classes: ['7年1班'], version: 2, updatedAt: 'U1' });
    F.docs.set(`${P}/schedules/115-1`, { scheduleData: [{ teacher: 'T1' }, { teacher: 'T2' }], teachers: [{ name: 'T1' }, { name: 'T2' }], classes: ['7年1班'], version: 3, updatedAt: 'U2' });
    F.docs.set(`${P}/schedules/115-1/imports/imp_1`, { versionNo: 1, fileName: 'a.xlsx', source: 'file', snapshot: { scheduleData: [{ teacher: 'big' }] } });
    for (let i = 0; i < nCur; i++) {
        const id = `rec_cur_${String(i).padStart(4, '0')}`;
        F.docs.set(`${P}/substituteRecords/${id}`, { semesterId: '115-1', date: '2026-09-07', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', period: '第一節', className: '7年1班' });
        if (i % 2 === 0) F.docs.set(`${P}/substituteRecords/${id}/private/detail`, { leaveType: '病假', leaveTypeName: '病假', reason: `r${i}`, allowedTeacherIds: ['tch_01'] });
    }
    for (let i = 0; i < nOld; i++) {
        const id = `rec_old_${String(i).padStart(4, '0')}`;
        F.docs.set(`${P}/substituteRecords/${id}`, { semesterId: '114-2', date: '2026-03-02', type: '代課', originalTeacher: 'T2', substituteTeacher: 'T1' });
        F.docs.set(`${P}/substituteRecords/${id}/private/detail`, { leaveType: '公假', allowedTeacherIds: ['tch_02'] });
    }
    F.docs.set(`${P}/pendingRequests/req_1`, { semesterId: '115-1', status: 'pending_approval', type: '代課' });
    F.docs.set(`${P}/pendingRequests/req_1/private/detail`, { leaveType: '事假', allowedTeacherIds: ['tch_01'] });
    F.docs.set(`${P}/operationLogs/log_1`, { action: 'x' });
}

const asRole = (role) => roleSvc.setCurrentIdentity({ uid: 'u', email: 'e@example.edu.tw', teacherId: 'tch_01', name: 'T1', role });

/* gating */
{
    seedCloud({ nCur: 3, nOld: 1 });
    asRole('teacher');
    let err = null; try { await ctl.buildCloudBackup(); } catch (e) { err = e; }
    check('B 一般教師無法匯出全校備份', err && err.message.includes('只有教務主任與教學組長'), String(err));
    asRole('section_chief');
    const chief = await ctl.buildCloudBackup();
    check('B 教學組長可匯出', chief.backup.meta.counts.substituteRecords === 4);
}

/* 匯出：分頁不被截斷、兩學期、private/detail、筆數 */
asRole('director');
seedCloud();
F.reads = 0;
const built = await ctl.buildCloudBackup();
const c = built.backup.meta.counts;
check('B 匯出筆數：紀錄 690（650 目前學期 + 40 歷史學期），不被分頁上限截斷', c.substituteRecords === 690, JSON.stringify(c));
check('B 匯出 private/detail 筆數 = 325（目前學期偶數筆）+ 40 = 365', c.substituteRecordDetails === 365, String(c.substituteRecordDetails));
check('B 匯出：兩個學期課表、5 位教師、1 筆待審（含明細）、2 個設定文件、1 筆匯入紀錄',
    c.schedules === 2 && c.teachers === 5 && c.pendingRequests === 1 && c.pendingRequestDetails === 1 && c.configDocs === 2 && c.scheduleImports === 1, JSON.stringify(c));
check('B 兩個學期的紀錄都在檔內', built.backup.substituteRecords.some(r => r.data.semesterId === '114-2') && built.backup.substituteRecords.some(r => r.data.semesterId === '115-1'));
check('B private/detail 內容正確掛到對應紀錄', built.backup.substituteRecords.find(r => r.id === 'rec_cur_0004').private.reason === 'r4'
    && built.backup.substituteRecords.find(r => r.id === 'rec_cur_0001').private === null
    && built.backup.substituteRecords.find(r => r.id === 'rec_old_0000').private.leaveType === '公假');
check('B 匯入紀錄只留中繼資料、不含快照', built.backup.scheduleImports[0].data.snapshot === undefined && built.backup.scheduleImports[0].data.fileName === 'a.xlsx');
check('B operationLogs 不在備份內', !('operationLogs' in built.backup));
check('B 分頁讀取：紀錄集合讀了 3 頁以上（300/頁）', F.reads >= 8, `reads=${F.reads}`);
check('B 檔頭記載的雜湊與內容一致、備份檔可重新驗證通過',
    (await fmt.parseAndValidateBackupText(built.text, { schoolId: 't' })).ok);
check('B 檔名格式', /^STsystem_雲端備份_t_\d{4}-\d{2}-\d{2}\.json$/.test(built.fileName), built.fileName);

/* 還原到被清空的學校 */
const original = JSON.parse(JSON.stringify([...F.docs.entries()].filter(([k]) => !k.includes('/operationLogs/'))));
const val = await fmt.parseAndValidateBackupText(built.text, { schoolId: 't' });
// 模擬「清除所有資料」後：紀錄、待審、目前學期課表被清、教師名冊被誤刪
{
    for (const k of [...F.docs.keys()]) if (/\/(substituteRecords|pendingRequests)\//.test(k) || /\/teachers\//.test(k) || /\/emailIndex\//.test(k)) F.docs.delete(k);
    F.docs.set(`${P}/schedules/115-1`, { scheduleData: [], teachers: [], classes: [], version: 9, updatedAt: 'U9' });
    F.docs.delete(`${P}/config/settlement`);
    F.writes.length = 0;
}
{
    const cloudNow = fmt.cloudStateFromSections(await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
    const plan = fmt.planRestore({ backup: val.backup, cloud: cloudNow, currentSemesterId: '115-1' });
    check('B 清空後的計畫：教師 5、目前學期紀錄 650 可還原；歷史 40 與待審 1 不還原',
        plan.teachers.create.length === 5 && plan.records.create.length === 650 && plan.records.historical === 40 && plan.pending.notRestored === 1,
        JSON.stringify({ t: plan.teachers.create.length, r: plan.records.create.length, h: plan.records.historical, p: plan.pending.notRestored }));
    const report = await svc.executeRestore({ backup: val.backup, plan, cloud: cloudNow, me: { name: 'T1', teacherId: 'tch_01', email: 'e@example.edu.tw' } });
    check('B 還原全部階段成功', report.ok && report.stages.every(s => s.status === 'done' || s.status === 'skipped'), JSON.stringify(report.stages));
    const cur = (k) => F.docs.get(`${P}/${k}`);
    // 本階段新增（H1）：未勾選時補回的教師檔 email 一律為 null，其餘欄位與原本一致
    check('B 還原後教師名冊 5 位，除 email 外與原本一致；未勾選時 email 一律為 null（H1）', [1, 2, 3, 4, 5].every(i => {
        const got = cur(`teachers/tch_0${i}`), orig = original.find(([k]) => k === `${P}/teachers/tch_0${i}`)[1];
        return got && got.email === null && same({ ...got, email: 0 }, { ...orig, email: 0 });
    }));
    check('B 未勾選：整批寫入沒有任何 emailIndex 文件、教師檔寫入的 email 都是 null（H1）',
        !F.writes.some(w => /\/emailIndex\//.test(w.path)) && F.writes.filter(w => /\/teachers\/[^/]+$/.test(w.path)).length === 5
        && F.writes.filter(w => /\/teachers\/[^/]+$/.test(w.path)).every(w => w.data.email === null));
    check('B 未勾選：結果訊息列出原信箱供手動填回（H1）', svc.describeRestoreReport(report).includes('t3@example.edu.tw') && svc.describeRestoreReport(report).includes('教師管理'));
    // P5 驗收修復（原期望「還原時 emailIndex 同步建立」會讓已刪除教師的登入綁定被補回、繞過 P3 身分撤銷，故改為預設不補回）
    check('B 還原教師時預設不補回 emailIndex（登入綁定需在預覽明確勾選）', cur('teachers/tch_03') && cur('emailIndex/t3@example.edu.tw') === undefined);
    check('B 預設計畫的教師名單帶姓名與角色，供預覽逐一列出', plan.teachers.createList.length === 5 && plan.teachers.createList.every(t => t.id && 'name' in t && 'role' in t) && plan.teachers.restoreEmailIndex === false, JSON.stringify(plan.teachers.createList[0]));
    check('B 預設計畫的「不會還原」清單說明登入綁定不恢復', plan.notRestored.some(x => x.includes('emailIndex') && x.includes('不恢復登入綁定')));
    check('B 結果訊息說明教師檔補回但未恢復登入綁定', svc.describeRestoreReport(report).includes('沒有恢復登入綁定'));
    const origSched = original.find(([k]) => k === `${P}/schedules/115-1`)[1];
    check('B 目前學期課表還原成原內容（節數、教師、班級）',
        same(cur('schedules/115-1').scheduleData, origSched.scheduleData) && same(cur('schedules/115-1').teachers, origSched.teachers));
    check('B 課表還原前，被覆寫的（空）課表不留空備份；version 前進', cur('schedules/115-1').version === 10);
    check('B 月結算設定還原', cur('config/settlement').calendarId === 'c' && cur('config/settlement').weeksByYear['114']['9'] === 4);
    const recKeys = [...F.docs.keys()].filter(k => /\/substituteRecords\/[^/]+$/.test(k));
    check('B 還原後紀錄 650 筆（歷史學期 40 筆不還原）', recKeys.length === 650, String(recKeys.length));
    const sameRec = (id) => same(cur(`substituteRecords/${id}`), original.find(([k]) => k === `${P}/substituteRecords/${id}`)[1]);
    check('B 紀錄內容與原本一致、private/detail 一併還原',
        sameRec('rec_cur_0000') && sameRec('rec_cur_0649')
        && same(cur('substituteRecords/rec_cur_0004/private/detail'), original.find(([k]) => k === `${P}/substituteRecords/rec_cur_0004/private/detail`)[1])
        && cur('substituteRecords/rec_cur_0001/private/detail') === undefined);
    check('B 歷史學期紀錄與待審申請沒有被寫入', !cur('substituteRecords/rec_old_0000') && !cur('pendingRequests/req_1'));
    check('B 寫入沒有帶保留欄位 recordId／reqId', !F.writes.filter(w => /substituteRecords\/[^/]+$/.test(w.path)).some(w => 'recordId' in w.data || 'reqId' in w.data));

    // 冪等：再還原一次，只剩不可還原的部分，不會重複寫入
    const w1 = F.writes.length;
    const cloud2 = fmt.cloudStateFromSections(await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
    const plan2 = fmt.planRestore({ backup: val.backup, cloud: cloud2, currentSemesterId: '115-1' });
    check('B 重複還原：沒有需要寫入的項目（冪等）', fmt.countPlannedWrites(plan2) === 0, String(fmt.countPlannedWrites(plan2)));
    const rep2 = await svc.executeRestore({ backup: val.backup, plan: plan2, cloud: cloud2, me: null });
    check('B 重複還原：零寫入且回報成功', rep2.ok && F.writes.length === w1);
}

/* 批次失敗：回報已完成與未完成 */
{
    for (const k of [...F.docs.keys()]) if (/\/substituteRecords\//.test(k)) F.docs.delete(k);
    F.writes.length = 0; F.commits = 0;
    const cloudNow = fmt.cloudStateFromSections(await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
    const plan = fmt.planRestore({ backup: val.backup, cloud: cloudNow, currentSemesterId: '115-1' });
    F.failBatchAt = 3;   // 第 3 次 batch.commit 失敗（每批 8 筆）
    const report = await svc.executeRestore({ backup: val.backup, plan, cloud: cloudNow, me: null });
    const st = report.stages.find(s => s.key === 'records');
    const BATCH = svc.RESTORE_RECORD_BATCH;
    check(`B 批次失敗：records 階段 failed、已完成 ${2 * BATCH} 筆（前兩批，每批 ${BATCH}）、錯誤訊息轉成中文（PL-10c，不顯示 SDK 英文）`,
        !report.ok && st.status === 'failed' && st.done === 2 * BATCH && st.planned === 650 && st.error === '無法連到伺服器' && !/simulated/.test(st.error), JSON.stringify(st));
    const text2 = svc.describeRestoreReport(report);
    check(`B 失敗報告白話：列出已完成 ${2 * BATCH}／650 並提示可重跑`, text2.includes(`已完成 ${2 * BATCH}／650`) && text2.includes('可以再執行一次'));
    const written = [...F.docs.keys()].filter(k => /\/substituteRecords\/[^/]+$/.test(k)).length;
    check(`B 失敗時實際只寫入前兩批 ${2 * BATCH} 筆（批次原子性）`, written === 2 * BATCH, String(written));
    F.failBatchAt = null;
    const cloud3 = fmt.cloudStateFromSections(await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
    const plan3 = fmt.planRestore({ backup: val.backup, cloud: cloud3, currentSemesterId: '115-1' });
    const rep3 = await svc.executeRestore({ backup: val.backup, plan: plan3, cloud: cloud3, me: null });
    const done3 = [...F.docs.keys()].filter(k => /\/substituteRecords\/[^/]+$/.test(k)).length;
    check('B 重跑只補缺少的部分，最終 650 筆齊全', rep3.ok && done3 === 650 && plan3.records.create.length === 650 - 2 * BATCH, `${done3} / ${plan3.records.create.length}`);
}

/* 課表版本前置條件：預覽後有人改了課表 → 還原該課表被拒、不覆寫 */
{
    const cloudNow = fmt.cloudStateFromSections(await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
    const bk = JSON.parse(JSON.stringify(val.backup));
    bk.schedules.find(s => s.id === '115-1').data.scheduleData.push({ teacher: 'T9' });   // 讓它與雲端不同才會被規劃寫入
    const plan = fmt.planRestore({ backup: bk, cloud: cloudNow, currentSemesterId: '115-1' });
    check('B 備份課表與雲端不同 → 計畫為 overwrite', plan.schedules.find(s => s.semesterId === '115-1').action === 'overwrite');
    F.docs.set(`${P}/schedules/115-1`, { ...F.docs.get(`${P}/schedules/115-1`), version: 99, updatedAt: 'someone-else', schoolName: '別人剛改的' });
    const before = JSON.stringify(F.docs.get(`${P}/schedules/115-1`));
    const report = await svc.executeRestore({ backup: bk, plan, cloud: cloudNow, me: null });
    const st = report.stages.find(s => s.key === 'schedules');
    check('B 還原課表時雲端版本已變 → 被拒（failed）、課表原封不動', st.status === 'failed' && JSON.stringify(F.docs.get(`${P}/schedules/115-1`)) === before, JSON.stringify(st));
}

/* 讀取失敗 → 不產生殘缺備份 */
{
    seedCloud({ nCur: 5, nOld: 1 });
    // 讓某筆 private/detail 讀取丟錯：包裝 stub 的 getDoc 不方便，改為用毀損的 collection 讀取模擬——以 mapWithConcurrency 單元驗證「任一失敗即整體 reject」
    let err = null;
    try { await svc.mapWithConcurrency([1, 2, 3, 4], 2, async (x) => { if (x === 3) throw new Error('read failed'); return x; }); } catch (e) { err = e; }
    check('B 並行讀取任一筆失敗 → 整體中止（不輸出殘缺備份）', err && err.message === 'read failed');
    const out = await svc.mapWithConcurrency([5, 6, 7], 2, async (x) => x * 2);
    check('B mapWithConcurrency 保持順序', same(out, [10, 12, 14]));
}

{
    // 批次大小不可與 emulator 校準測試脫鉤：rules-backup-restore.mjs 內的常數必須與服務層相同
    const { readFileSync } = await import('node:fs');
    const m = /RESTORE_RECORD_BATCH = (\d+), RESTORE_TEACHER_BATCH = (\d+)/.exec(readFileSync(new URL('./emulator/rules-backup-restore.mjs', import.meta.url), 'utf8'));
    check('B 批次大小與 emulator 測試一致（紀錄 6／教師 100，實測校準值）', !!m && Number(m[1]) === svc.RESTORE_RECORD_BATCH && Number(m[2]) === svc.RESTORE_TEACHER_BATCH && svc.RESTORE_RECORD_BATCH === 6 && svc.RESTORE_TEACHER_BATCH === 100);
}

/* 明確勾選才補回 emailIndex */
{
    for (const k of [...F.docs.keys()]) if (/\/teachers\//.test(k) || /\/emailIndex\//.test(k)) F.docs.delete(k);
    const cloudNow = fmt.cloudStateFromSections(await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
    const planOn = fmt.planRestore({ backup: val.backup, cloud: cloudNow, currentSemesterId: '115-1', restoreEmailIndex: true });
    const rep = await svc.executeRestore({ backup: val.backup, plan: planOn, cloud: cloudNow, me: null });
    check('B 勾選後：教師檔（含 email）與 emailIndex 同一批補回', rep.ok && F.docs.get(`${P}/emailIndex/t3@example.edu.tw`)?.teacherId === 'tch_03' && F.docs.get(`${P}/teachers/tch_03`)?.email === 't3@example.edu.tw');
    check('B 勾選後的結果訊息說明已恢復登入綁定', svc.describeRestoreReport(rep).includes('已一併恢復'));
    check('B 勾選後「不會還原」清單不再列登入綁定警語', !planOn.notRestored.some(x => x.includes('不恢復登入綁定')));
}

/* ====================== C. 清除前的強制備份 ====================== */
{
    // 最小瀏覽器環境：只提供下載用到的 document.createElement／body.appendChild／removeChild
    const clicks = [];
    globalThis.document = {
        createElement: () => ({ click() { clicks.push(this.download); } }),
        body: { appendChild() {}, removeChild() {} },
    };
    const dialogs = [];
    const mkApp = (answer) => ({
        showToast: () => () => {},
        confirmDialog: async (o) => { dialogs.push(o); return answer; },
    });

    seedCloud({ nCur: 5, nOld: 2 });
    asRole('teacher');
    dialogs.length = 0; clicks.length = 0;
    const r1 = await ctl.exportBackupBeforeClear(mkApp(true));
    check('C 備份讀取失敗（非 approver，等同讀取被拒）→ 回傳 false（呼叫端必須中止清除）、沒有觸發下載',
        r1 === false && clicks.length === 0);
    check('C 失敗時告知「已中止清除、沒有備份就不清除」', dialogs.length === 1 && dialogs[0].title.includes('已中止清除') && dialogs[0].message.includes('不會在沒有備份的情況下清除'));

    asRole('director');
    dialogs.length = 0; clicks.length = 0;
    const r2 = await ctl.exportBackupBeforeClear(mkApp(true));
    check('C 備份成功且使用者確認已存檔 → true；下載了 1 個備份檔', r2 === true && clicks.length === 1 && /^STsystem_雲端備份_t_/.test(clicks[0]));
    check('C 確認框列出備份內容筆數', dialogs.length === 1 && dialogs[0].message.includes('調代課紀錄 7 筆'), dialogs[0] && dialogs[0].message);
    dialogs.length = 0; clicks.length = 0;
    const r3 = await ctl.exportBackupBeforeClear(mkApp(false));
    check('C 備份已下載但使用者不確認 → false（不清除）', r3 === false && clicks.length === 1);
    // 防連點：同時兩次匯出，第二次被擋
    const p1 = ctl.exportCloudBackup();
    let e2 = null;
    try { await ctl.exportCloudBackup(); } catch (e) { e2 = e; }
    await p1;
    check('C 防連點：匯出進行中再觸發 → 被擋下並說明', e2 && e2.message.includes('進行中'));
}

/* ====================== D. 只讀伺服器：快取殘缺、伺服器讀不到時必須中止 ====================== */
{
    const dataSvc = await import('../src/js/modules/v2/schoolDataService.js');
    seedCloud({ nCur: 20, nOld: 3 });
    asRole('director');
    const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    const clicks = [];
    globalThis.document = {
        createElement: () => ({ click() { clicks.push(this.download); } }),
        body: { appendChild() {}, removeChild() {} },
    };

    F.serverDown = true;   // client 判定離線：*FromServer 丟 unavailable；getDocs／getDoc 則靜默回傳殘缺快取
    // 對照組：一般 getDocs 在此情境下「成功」但只回殘缺資料，正是這次要防的靜默失敗
    const fsx = await (await import('../src/js/modules/v2/firebaseV2.js')).getV2Firestore();
    const cacheSnap = await fsx.getDocs(fsx.collection(fsx.db, `${P}/substituteRecords`));
    check('D 對照：離線時一般 getDocs 靜默回傳殘缺快取（1 筆，不報錯）', cacheSnap.docs.length === 1, String(cacheSnap.docs.length));

    F.writes.length = 0;
    const e1 = await rejects(() => svc.collectCloudBackupSections());
    check('D collectCloudBackupSections：伺服器讀不到 → 丟錯（不回傳殘缺區段）', e1 && e1.code === 'unavailable', String(e1));
    const e1b = await rejects(() => svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
    check('D 還原時的 cloudState 讀取（includeDetails=false）同樣丟錯，還原不會繼續', e1b && e1b.code === 'unavailable', String(e1b));
    const e2 = await rejects(() => ctl.buildCloudBackup());
    check('D buildCloudBackup：丟錯、不產出檔案內容', e2 && e2.code === 'unavailable');
    clicks.length = 0;
    const e3 = await rejects(() => ctl.exportCloudBackup());
    check('D exportCloudBackup：丟錯、沒有觸發下載', e3 && clicks.length === 0, String(e3));
    const dlg = [];
    const r = await ctl.exportBackupBeforeClear({ showToast: () => () => {}, confirmDialog: async (o) => { dlg.push(o); return true; } });
    check('D 清除前強制備份：回傳 false（呼叫端中止清除）、沒有下載、告知已中止', r === false && clicks.length === 0 && dlg.length === 1 && dlg[0].title.includes('已中止清除'));
    // M1：伺服器讀不到時顯示中文說明，不顯示 SDK 英文原文，也不說「恢復網路後會自動同步」
    check('D 失敗訊息為中文：無法連到伺服器、清除已中止、資料沒有被刪除；不含 SDK 英文與「自動同步」',
        dlg[0].message.includes('無法連到伺服器') && dlg[0].message.includes('清除已中止') && dlg[0].message.includes('資料沒有被刪除')
        && !/offline|Failed to get|unavailable/i.test(dlg[0].message) && !dlg[0].message.includes('自動同步'), dlg[0].message);

    const e4 = await rejects(() => dataSvc.listAllSubstituteRecordsForClear());
    const e5 = await rejects(() => dataSvc.listAllPendingRequestsForClear());
    check('D 清除流程列舉紀錄／待審：伺服器讀不到 → 丟錯（不會拿殘缺快取就清除）', e4 && e4.code === 'unavailable' && e5 && e5.code === 'unavailable');
    const e6 = await rejects(() => dataSvc.getSchedule('115-1', { fromServer: true }));
    check('D 清除流程讀目前課表（fromServer）：伺服器讀不到 → 丟錯', e6 && e6.code === 'unavailable');
    check('D 以上過程沒有任何寫入', F.writes.length === 0, String(F.writes.length));

    // L4：集合讀取與文件讀取各自出錯，都要讓匯出中止（兩者可分開控制）
    F.serverDown = false;
    F.serverDownCollections = true;
    const eCol = await rejects(() => ctl.buildCloudBackup());
    check('D 只有集合讀取出錯 → 匯出中止', eCol && eCol.code === 'unavailable', String(eCol));
    F.serverDownCollections = false;
    F.serverDownDocs = true;
    const eDoc = await rejects(() => ctl.buildCloudBackup());
    check('D 只有文件讀取出錯 → 匯出中止', eDoc && eDoc.code === 'unavailable', String(eDoc));
    F.serverDownDocs = false;
    const okAgain = await ctl.buildCloudBackup();
    check('D 伺服器恢復後匯出正常（23 筆紀錄）', okAgain.backup.meta.counts.substituteRecords === 23, JSON.stringify(okAgain.backup.meta.counts));
    const listed = await dataSvc.listAllSubstituteRecordsForClear();
    check('D 伺服器恢復後清除列舉讀到全部 23 筆', listed.length === 23, String(listed.length));
}

/* ====================== E. 錯誤說明（M1）、預覽後名冊變動（L1）、目前學期來源（L3） ====================== */
{
    const mk = (code, message) => Object.assign(new Error(message), { code });
    const sdkErrs = [
        mk('unavailable', 'Failed to get document because the client is offline.'),
        mk('', 'Failed to get documents from server'),
        mk('unavailable', 'x'),
        mk('firestore/unavailable', 'x'),
    ];
    check('E isServerUnreachableError 認得 unavailable、Failed to get document(s) from server、client is offline', sdkErrs.every(fmt.isServerUnreachableError)
        && !fmt.isServerUnreachableError(mk('permission-denied', 'denied')) && !fmt.isServerUnreachableError(null));
    for (const kind of ['export', 'before-clear', 'restore-read', 'restore-backup']) {
        const m = fmt.backupErrorMessage(sdkErrs[0], kind);
        check(`E ${kind}：中文說明、不含 SDK 英文、不說自動同步、無 emoji／連續驚嘆號`,
            m.includes('無法連到伺服器') && m.includes('請稍候約一分鐘再試一次') && !/[A-Za-z]{4,}/.test(m) && !m.includes('自動同步') && !/!!|！！|\p{Extended_Pictographic}/u.test(m), m);
    }
    check('E 匯出：說「備份沒有產生」', fmt.backupErrorMessage(sdkErrs[0], 'export').includes('備份沒有產生'));
    check('E 清除前備份：說「清除已中止、資料沒有被刪除」', /清除已中止/.test(fmt.backupErrorMessage(sdkErrs[0], 'before-clear')) && /資料沒有被刪除/.test(fmt.backupErrorMessage(sdkErrs[0], 'before-clear')));
    check('E 還原：說「還原已中止、沒有寫入任何資料」', /還原已中止/.test(fmt.backupErrorMessage(sdkErrs[0], 'restore-backup')) && /沒有寫入任何資料/.test(fmt.backupErrorMessage(sdkErrs[0], 'restore-backup')));
    check('E 其他錯誤保留原因文字', fmt.backupErrorMessage(mk('permission-denied', '權限不足'), 'export').includes('權限不足'));

    // L1
    const bk = { ...sections, teachers: [...sections.teachers, { id: 'tch_3', data: { name: '張', email: 'z@example.edu.tw', role: 'teacher' } }] };
    const cloudA = { teachers: [], configMainExists: true, settlement: null, schedules: {}, recordIds: [], pendingIds: [] };
    const cloudB = { ...cloudA, teachers: [{ id: 'tch_2', email: null }] };   // 預覽後 tch_2 被別人補回
    const pv = fmt.planRestore({ backup: bk, cloud: cloudA, currentSemesterId: '115-1' });
    const fresh = fmt.planRestore({ backup: bk, cloud: cloudB, currentSemesterId: '115-1', restoreEmailIndex: true });
    const r0 = fmt.restrictPlanToPreview(fresh, pv);
    check('E L1 重算後的教師是預覽的子集 → 不變、沒有被丟棄', r0.dropped.length === 0 && r0.plan === fresh);
    const pvSmall = fmt.planRestore({ backup: bk, cloud: { ...cloudA, teachers: [{ id: 'tch_1', email: null }] }, currentSemesterId: '115-1' });   // 預覽時只列 tch_2、tch_3
    const freshBig = fmt.planRestore({ backup: bk, cloud: cloudA, currentSemesterId: '115-1', restoreEmailIndex: true });   // 重算後多出 tch_1
    const r1 = fmt.restrictPlanToPreview(freshBig, pvSmall);
    check('E L1 重算後多出預覽沒列的教師 → 不補回、回報被丟棄的 id', same(r1.dropped, ['tch_1']) && same(r1.plan.teachers.create, ['tch_2', 'tch_3']) && r1.plan.teachers.createList.every(t => t.id !== 'tch_1'), JSON.stringify(r1.plan.teachers.create));
    check('E L1 限縮後 countPlannedWrites 同步減少', fmt.countPlannedWrites(r1.plan) === fmt.countPlannedWrites(freshBig) - 1);

    // L3
    const withCfg = { ...sections, config: { main: { currentSemester: '116-1' }, settlement: null } };
    check('E L3 cloudStateFromSections 帶出已讀到的 config/main.currentSemester', fmt.cloudStateFromSections(withCfg).currentSemester === '116-1'
        && fmt.cloudStateFromSections({ ...sections, config: { main: null, settlement: null } }).currentSemester === null);
    check('E L3 resolveCurrentSemester：以雲端為準（不取記憶體 115-1）；雲端沒有 config/main 才退到備份檔；都沒有 → null',
        fmt.resolveCurrentSemester(fmt.cloudStateFromSections(withCfg), backup) === '116-1'
        && fmt.resolveCurrentSemester({ currentSemester: null }, backup) === '115-1'
        && fmt.resolveCurrentSemester({ currentSemester: null }, { config: { main: null } }) === null);
}

/* ====================== F. 補回後（email 為 null）由組長／主任在教師管理填回信箱 ====================== */
{
    const dataSvc = await import('../src/js/modules/v2/schoolDataService.js');
    seedCloud({ nCur: 2, nOld: 0 });
    asRole('director');
    for (const k of [...F.docs.keys()]) if (/\/(teachers|emailIndex)\//.test(k)) F.docs.delete(k);
    const cloudNow = fmt.cloudStateFromSections(await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
    const bk = JSON.parse(JSON.stringify(val.backup));
    const planOff = fmt.planRestore({ backup: bk, cloud: cloudNow, currentSemesterId: '115-1' });
    await svc.executeRestore({ backup: bk, plan: planOff, cloud: cloudNow, me: null });
    check('F 未勾選補回後：教師檔 email 為 null、沒有 emailIndex', F.docs.get(`${P}/teachers/tch_03`).email === null && ![...F.docs.keys()].some(k => k.includes('/emailIndex/')));
    F.writes.length = 0;
    await dataSvc.updateTeacher('tch_03', { email: 'T3@example.edu.tw' });
    check('F updateTeacher 把信箱從 null 填回：同一批寫入教師 email（小寫）與 emailIndex', F.docs.get(`${P}/teachers/tch_03`).email === 't3@example.edu.tw' && F.docs.get(`${P}/emailIndex/t3@example.edu.tw`)?.teacherId === 'tch_03', JSON.stringify(F.writes.map(w => w.path)));
}

/* ====================== G. 還原時教師信箱正規化（trim＋小寫；非字串視為無信箱） ====================== */
{
    const mkCloud = (teachers) => ({ teachers, configMainExists: true, settlement: null, schedules: {}, recordIds: [], pendingIds: [] });
    const mkBackup = (teachers) => ({ teachers: teachers.map(([id, email]) => ({ id, data: { name: id, role: 'teacher', email } })) });
    const wipe = () => { for (const k of [...F.docs.keys()]) if (/\/(teachers|emailIndex)\//.test(k)) F.docs.delete(k); F.writes.length = 0; };
    const emailKeys = () => [...F.docs.keys()].filter(k => k.includes('/emailIndex/'));

    // (a) 勾選：空白與大小寫被正規化，教師檔 email 與 emailIndex 鍵一致
    wipe();
    let bk = mkBackup([['tch_g1', '  Chief@example.edu.tw ']]), cl = mkCloud([]);
    let plan = fmt.planRestore({ backup: bk, cloud: cl, currentSemesterId: '115-1', restoreEmailIndex: true });
    check('G(a) 預覽的原信箱已正規化', plan.teachers.createList[0].email === 'chief@example.edu.tw', JSON.stringify(plan.teachers.createList));
    await svc.executeRestore({ backup: bk, plan, cloud: cl, me: null });
    check('G(a) 勾選：教師檔 email 為 chief@example.edu.tw 且 emailIndex 鍵相同',
        F.docs.get(`${P}/teachers/tch_g1`)?.email === 'chief@example.edu.tw' && F.docs.get(`${P}/emailIndex/chief@example.edu.tw`)?.teacherId === 'tch_g1' && emailKeys().length === 1, JSON.stringify([F.docs.get(`${P}/teachers/tch_g1`), emailKeys()]));

    // (b) 備份信箱與現職教師相同（只差空白）：視為已被使用，不動現職教師
    wipe();
    F.docs.set(`${P}/teachers/tch_live`, { name: 'L', email: 'live@example.edu.tw', role: 'teacher' });
    F.docs.set(`${P}/emailIndex/live@example.edu.tw`, { teacherId: 'tch_live' });
    bk = mkBackup([['tch_g2', ' live@example.edu.tw']]); cl = mkCloud([{ id: 'tch_live', email: 'Live@example.edu.tw ' }]);
    plan = fmt.planRestore({ backup: bk, cloud: cl, currentSemesterId: '115-1', restoreEmailIndex: true });
    check('G(b) 判定信箱已被現職教師使用', plan.teachers.emailTaken.includes('tch_g2') && plan.teachers.create.length === 0, JSON.stringify(plan.teachers));
    await svc.executeRestore({ backup: bk, plan, cloud: cl, me: null });
    check('G(b) 現職教師的 emailIndex 未被改指向、教師檔未被寫入',
        F.docs.get(`${P}/emailIndex/live@example.edu.tw`)?.teacherId === 'tch_live' && !F.writes.some(w => w.path.endsWith('/teachers/tch_live') || w.path.endsWith('/teachers/tch_g2')), JSON.stringify(F.writes.map(w => w.path)));

    // (c) 物件、數字、空白字串：不拋例外、視為無信箱、不產生 emailIndex
    wipe();
    bk = mkBackup([['tch_o', { toString: null }], ['tch_n', 12345], ['tch_s', '   ']]); cl = mkCloud([]);
    let err = null, rep = null;
    try {
        plan = fmt.planRestore({ backup: bk, cloud: cl, currentSemesterId: '115-1', restoreEmailIndex: true });
        rep = await svc.executeRestore({ backup: bk, plan, cloud: cl, me: null });
    } catch (e) { err = e; }
    check('G(c) 非字串／空白信箱不拋例外且三位教師都補回', !err && plan.teachers.create.length === 3 && rep && rep.ok, String(err));
    check('G(c) 視為無信箱：教師檔 email 為 null、沒有任何 emailIndex',
        ['tch_o', 'tch_n', 'tch_s'].every(id => F.docs.get(`${P}/teachers/${id}`)?.email === null) && emailKeys().length === 0, JSON.stringify(emailKeys()));
    check('G(c) 預覽不顯示假信箱', plan.teachers.createList.every(t => t.email === ''), JSON.stringify(plan.teachers.createList));

    // (d) 未勾選仍為 null
    wipe();
    bk = mkBackup([['tch_g4', '  Chief@example.edu.tw ']]); cl = mkCloud([]);
    plan = fmt.planRestore({ backup: bk, cloud: cl, currentSemesterId: '115-1' });
    await svc.executeRestore({ backup: bk, plan, cloud: cl, me: null });
    check('G(d) 未勾選：教師檔 email 為 null、無 emailIndex，原信箱（正規化後）只留在 emailCleared',
        F.docs.get(`${P}/teachers/tch_g4`)?.email === null && emailKeys().length === 0 && plan.teachers.emailCleared[0]?.email === 'chief@example.edu.tw');
}

process.stdout.write(`\n${failed ? '失敗' : '全部通過'}：通過 ${passed}、失敗 ${failed}\n`);
process.exit(failed ? 1 : 0);
