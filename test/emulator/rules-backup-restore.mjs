/**
 * 備份／還原／學期切換／課表並行保護：emulator 端到端驗證（REST，套用 firestore.rules）
 *
 * 用法（需先 `npm run emu`，由人工啟動 emulator；本檔不會自行啟動、只連 127.0.0.1 / demo-stsystem）：
 *   node test/emulator/rules-backup-restore.mjs
 *
 * 規則版本旗標（環境變數 RULES_V213）：
 *   未設或 'AB'  預期已套用 v2.13-A（getAfter：開新學期原子建立課表）＋ v2.13-B（課表 version 遞增）
 *   'A'          只套用 A
 *   'none'       目前的 v2.12 規則（B 與「原子開新學期」相關案例改驗證「舊規則下的行為」）
 *   v2.13-A／B 已寫進 repo 的 firestore.rules（未部署）；預設 'AB' 即驗證目前 repo 內的規則，
 *   其餘旗標只用來對照舊規則（例如用 git 取出的 v2.12 規則）下的行為。
 *
 * 前端以 SDK 寫入、這裡以 REST 重現「相同的寫入形狀」（比照 rules-workflows 的慣例）：
 *   - 課表寫入＝交易內讀現值 → scheduleWriteGuard 守門（直接引用前端真正的純函式）→ 同一次提交寫
 *     匯入前備份（scheduleImportHistory.buildPreImportBackup）與主文件（version+1）
 *   - 還原＝backupService.restore* 同形的 writeBatch（教師檔；勾選才連同 email 與 emailIndex、private/detail＋紀錄）
 *   備份檔的組裝／驗證／還原計畫直接用前端真正的 backupFormat.js。
 * SDK 實際走過的 UI 路徑由 e2e（test/e2e/e2e-09-backup-restore.mjs）涵蓋。
 *
 * 涵蓋驗收條件 (a)～(g)：
 *   (e) 匯出含兩學期紀錄與 private/detail、筆數正確（分頁讀取）
 *   (g) 一般教師讀不到他人 private/detail 與 settlement（匯出必然中止）；組長不能寫教師／設定（無法還原）
 *   (f) 清空後以備份還原（勾選恢復登入綁定）：教師、課表、紀錄、設定與原本一致；歷史學期紀錄與待審申請如預期不還原
 *   (a) 對既有學期「開新學期」→ 課表不變、currentSemester 切換
 *   (b) 開全新學期 → 建立空課表（A：與 config 同一次提交）
 *   (c) 兩個 approver 以過期版本先後寫課表 → 第二個被拒（client 守門），規則層（B）也擋舊版整份覆寫
 *   (d) 匯入覆寫課表 → 舊課表可從匯入紀錄還原成原內容
 *   (h) 被刪除的教師經還原補回後不得自動復權：預設（未勾選）補回的教師檔 email 為 null，
 *       本人自建 mapping 被拒、殘留的舊 mapping 也拿不到角色；主任填回信箱後才可綁定；勾選還原則可直接綁定
 */
import {
    assertEmulator, getDoc, setDoc, deleteDoc, mustSetDoc, createDoc, updateDoc,
    runQuery, commitBatch, runTransaction, listDocs, fromFirestoreFields, EMULATOR_INFO,
} from './emu-client.mjs';
import { setup, as, SCHOOL, iso } from './kit.mjs';
import { Suite, allowed, denied, eq, ok } from '../scenarios/harness.mjs';
import { assertScheduleWrite, expectedFromDoc, ScheduleConflictError, ScheduleEmptyOverwriteError } from '../../src/js/modules/v2/scheduleWriteGuard.js';
import { buildPreImportBackup, getRestorableSnapshot } from '../../src/js/modules/scheduleImportHistory.js';
import * as fmt from '../../src/js/modules/v2/backupFormat.js';
import { dateToSemesterId } from '../../src/js/modules/v2/semesterUtils.js';

await assertEmulator();

const V213 = (process.env.RULES_V213 || 'AB').toUpperCase();
const HAS_A = V213 === 'A' || V213 === 'AB';
const HAS_B = V213 === 'AB';
console.log(`規則版本旗標 RULES_V213=${V213}（A：${HAS_A ? '已套用' : '未套用'}／B：${HAS_B ? '已套用' : '未套用'}）`);

const W = await setup();
const { fixture, dir, chief, t1, t2, semesterId } = W;
const prevSemester = fixture.preset.previousSemester;
const ROOT = `schools/${SCHOOL}`;
const DOCS_NAME_ROOT = `projects/${EMULATOR_INFO.PROJECT_ID}/databases/(default)/documents`;
const SCHED = (sid) => `${ROOT}/schedules/${sid}`;
const CFG = `${ROOT}/config/main`;

const suite = new Suite('備份／還原／學期切換／課表並行保護（emulator）');

/* ===================== 工具 ===================== */

/** 依文件 ID 排序＋游標分頁讀整個集合（與 backupService.readAllDocsPaged 同策略），回傳 [{id, data}]。 */
async function readAllPaged(collectionId, user, { pageSize = 7, parent = ROOT } = {}) {
    const out = [];
    let cursor = null;
    let pages = 0;
    for (;;) {
        const q = {
            from: [{ collectionId }],
            orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
            limit: pageSize,
        };
        if (cursor) q.startAt = { values: [{ referenceValue: cursor }], before: false };
        const res = await runQuery(parent, q, as(user));
        if (!res.ok) throw new Error(`讀取 ${parent}/${collectionId} 失敗：${res.status} ${res.error}`);
        const rows = (res.raw || []).filter(r => r.document);
        pages++;
        for (const r of rows) out.push({ id: r.document.name.split('/').pop(), data: fromFirestoreFields(r.document.fields || {}) });
        if (rows.length < pageSize) break;
        cursor = rows[rows.length - 1].document.name;
    }
    out.pages = pages;
    return out;
}

async function readPrivate(path, user) {
    const r = await getDoc(path, as(user));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`讀取 ${path} 失敗：${r.status} ${r.error}`);
    return r.data;
}

/** 以 REST 重現 backupService.collectCloudBackupSections。 */
async function collectSections(user, { details = true, imports = true } = {}) {
    const cfgMain = (await getDoc(CFG, as(user)));
    const cfgSet = (await getDoc(`${ROOT}/config/settlement`, as(user)));
    const cfgG9 = (await getDoc(`${ROOT}/config/grade9`, as(user)));   // PL-24：有文件才帶（沒有就省略鍵）
    const teachers = await readAllPaged('teachers', user);
    const schedules = await readAllPaged('schedules', user, { pageSize: 1 });
    const scheduleImports = [];
    if (imports) {
        for (const s of schedules) {
            for (const i of await readAllPaged('imports', user, { parent: SCHED(s.id), pageSize: 20 })) {
                const { snapshot, ...meta } = i.data;
                scheduleImports.push({ semesterId: s.id, id: i.id, data: meta });
            }
        }
    }
    let records = await readAllPaged('substituteRecords', user);
    let pending = await readAllPaged('pendingRequests', user);
    if (details) {
        records = await Promise.all(records.map(async r => ({ ...r, private: await readPrivate(`${ROOT}/substituteRecords/${r.id}/private/detail`, user) })));
        pending = await Promise.all(pending.map(async r => ({ ...r, private: await readPrivate(`${ROOT}/pendingRequests/${r.id}/private/detail`, user) })));
    } else {
        records = records.map(r => ({ ...r, private: null }));
        pending = pending.map(r => ({ ...r, private: null }));
    }
    return {
        config: { main: cfgMain.ok ? cfgMain.data : null, settlement: cfgSet.ok ? cfgSet.data : null, ...(cfgG9.ok && cfgG9.data ? { grade9: cfgG9.data } : {}) },
        teachers, schedules, scheduleImports, substituteRecords: records, pendingRequests: pending,
    };
}

/**
 * REST 版 schoolDataService.saveSchedule：交易內讀現值 → 守門 → 同一次提交寫匯入前備份＋主文件（version+1）。
 * 守門失敗回傳 { guardError }；否則回傳 REST 提交結果（可用 allowed／denied 斷言）。
 */
async function saveScheduleTx(user, sid, incoming, { expected, allowEmpty = false, backup = true } = {}) {
    let guardError = null;
    let backupId = null;
    let res;
    try {
        res = await runTransaction([SCHED(sid)], ([existing]) => {
            try { assertScheduleWrite({ existing, incoming, expected, allowEmpty }); } catch (e) { guardError = e; throw e; }
            const writes = [];
            if (backup) {
                const b = buildPreImportBackup(existing, { importedAt: iso() });
                if (b.snapshot.scheduleData.length || b.snapshot.teachers.length || b.snapshot.classes.length) {
                    backupId = b.record.id;
                    writes.push({ create: `${SCHED(sid)}/imports/${b.record.id}`, data: { ...b.record, snapshot: b.snapshot } });
                }
            }
            const prevVersion = Number(existing.version) > 0 ? Math.floor(Number(existing.version)) : 0;
            writes.push({ update: SCHED(sid), data: { ...incoming, updatedAt: iso(), version: prevVersion + 1 } });
            return writes;
        }, as(user));
    } catch (e) {
        if (guardError) return { guardError };
        throw e;
    }
    return { ...res, backupId };
}

/** REST 版 schoolDataService.activateSemester：config 與（新學期才有的）空課表在同一次 commit。 */
async function activateSemesterREST(user, toId) {
    const cfg = (await getDoc(CFG)).data;                    // admin 讀（只為了組出完整 config 文件）
    const target = await getDoc(SCHED(toId));
    const shell = { scheduleData: [], teachers: [], classes: [], subjectDomainMap: {}, schoolName: '', meta: { lastAction: 'semester_opened' } };
    const writes = [{ set: CFG, data: { ...cfg, currentSemester: toId, updatedAt: iso() } }];
    if (!target.ok) writes.push({ set: SCHED(toId), data: { ...shell, updatedAt: iso(), version: 1 } });
    return { res: await commitBatch(writes, as(user)), createdSchedule: !target.ok };
}

// 與 backupService.js 的 RESTORE_RECORD_BATCH／RESTORE_TEACHER_BATCH 相同（以 calibrate-restore-batch.mjs 實測校準；此處不 import 因為服務層需要瀏覽器環境）
const RESTORE_RECORD_BATCH = 6, RESTORE_TEACHER_BATCH = 100;
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * REST 版 backupService.restoreTeachers：未勾選（plan.teachers.restoreEmailIndex=false）時教師檔 email 一律 null、
 * 不寫 emailIndex；勾選才連同 email 與 emailIndex 同一批。legacyKeepEmail 只供「對照組」重現舊行為（教師檔帶回原信箱）。
 */
async function restoreTeachersREST(user, backup, plan, { legacyKeepEmail = false } = {}) {
    const withLogin = !!plan.teachers.restoreEmailIndex;
    for (const c of chunk(backup.teachers.filter(t => plan.teachers.create.includes(t.id)), RESTORE_TEACHER_BATCH)) {
        const writes = [];
        for (const t of c) {
            // PL-10a：與 backupService.restoreTeachers 相同，只寫教師欄位白名單（驗證白名單的欄位 rules 都收）
            const fields = fmt.pickTeacherFields(t.data);
            writes.push({ set: `${ROOT}/teachers/${t.id}`, data: withLogin || legacyKeepEmail ? fields : { ...fields, email: null } });
            if (withLogin && t.data.email) writes.push({ set: `${ROOT}/emailIndex/${String(t.data.email).toLowerCase()}`, data: { teacherId: t.id } });
        }
        allowed(await commitBatch(writes, as(user)), '還原教師批次');
    }
}

// 讓匯出一定含 config/settlement（種子沒有）
await mustSetDoc(`${ROOT}/config/settlement`, {
    calendarId: 'cal-1', calendarApiKey: 'key-1', weeksByYear: { 114: { 9: 4 } },
    updatedAt: iso(-1000), updatedBy: dir.email,
});

// PL-24：九年級畢業設定（config/grade9）一併納入備份
await mustSetDoc(`${ROOT}/config/grade9`, {
    semesterId, enabled: true, effectiveDate: '2099-01-02', updatedAt: iso(-900), updatedBy: dir.email,
});

const nRecCur = fixture.substituteRecords.length;
const nRecPrev = fixture.previousSemesterRecords.length;
const nRecDetails = [...fixture.substituteRecords, ...fixture.previousSemesterRecords].filter(r => r.private).length;
const nPending = fixture.pendingRequests.length;
const nPendingDetails = fixture.pendingRequests.filter(r => r.private).length;

let original = null;   // (e) 匯出的區段，(f) 還原後比對用
let backupObj = null;

/* ===================== (e) 匯出 ===================== */

await suite.case('(e) 主任匯出：兩個學期的紀錄、private/detail、教師、課表、設定筆數正確（分頁讀取）', async () => {
    original = await collectSections(dir);
    const counts = fmt.countSections(original);
    eq(counts.substituteRecords, nRecCur + nRecPrev, '調代課紀錄筆數（兩學期）');
    eq(counts.substituteRecordDetails, nRecDetails, 'private/detail 筆數');
    eq(counts.pendingRequests, nPending, '待審申請筆數');
    eq(counts.pendingRequestDetails, nPendingDetails, '待審 private/detail 筆數');
    eq(counts.teachers, fixture.teachers.length, '教師筆數');
    eq(counts.schedules, 2, '課表份數（目前＋歷史學期）');
    eq(counts.configDocs, 3, 'config／settlement／grade9');
    ok(original.config.grade9 && original.config.grade9.enabled === true, '匯出含 config/grade9（PL-24）');
    ok(original.substituteRecords.some(r => r.data.semesterId === prevSemester), '含歷史學期紀錄');
    ok(original.substituteRecords.some(r => r.data.semesterId === semesterId), '含目前學期紀錄');
    ok(original.substituteRecords.some(r => r.private && r.private.leaveType), '含 private/detail 內容（假別）');
    ok(original.teachers.pages >= 2, `教師分頁讀取確實分了多頁（pages=${original.teachers.pages}）`);
});

await suite.case('(e) 組成備份檔：驗證通過、檔頭筆數與內容一致、學校不符被拒', async () => {
    backupObj = await fmt.buildBackupFile({ schoolId: SCHOOL, exportedBy: { email: dir.email, role: 'director' }, currentSemester: semesterId, sections: original });
    const text = fmt.serializeBackup(backupObj);
    const v = await fmt.parseAndValidateBackupText(text, { schoolId: SCHOOL });
    ok(v.ok, `驗證：${v.message}`);
    const wrong = await fmt.parseAndValidateBackupText(text, { schoolId: 'demo-beta' });
    ok(!wrong.ok && wrong.errors[0] === '學校不符', '學校不符被拒');
});

await suite.case('(e) 組長（approver）也能完整匯出（含他人的 private/detail）', async () => {
    const s = await collectSections(chief, { imports: false });
    eq(fmt.countSections(s).substituteRecordDetails, nRecDetails, '組長讀到的 private/detail 筆數');
});

/* ===================== (g) 權限 ===================== */

await suite.case('(g) 一般教師讀不到他人 private/detail 與 config/settlement；匯出必然中止', async () => {
    const other = fixture.substituteRecords.find(r => r.private && Array.isArray(r.private.allowedTeacherIds) && !r.private.allowedTeacherIds.includes(t1.teacherId));
    ok(!!other, '找得到一筆與 t1 無關、有 private 的紀錄');
    denied(await getDoc(`${ROOT}/substituteRecords/${other.recordId}/private/detail`, as(t1)), '教師讀他人 private/detail');
    denied(await getDoc(`${ROOT}/config/settlement`, as(t1)), '教師讀 settlement');
    denied(await listDocs(`${ROOT}/operationLogs`, as(t1)), '教師列操作日誌');
    let threw = false;
    try { await collectSections(t1, { imports: false }); } catch (_) { threw = true; }
    ok(threw, '以教師身分跑匯出讀取流程會失敗（不會產出殘缺備份）');
});

await suite.case('(g) 組長不能還原：不能建立教師／emailIndex、不能寫 config/main', async () => {
    denied(await commitBatch([
        { set: `${ROOT}/teachers/tch_zz_restore`, data: { name: '還原測試', email: 'zz.restore@alpha.demo.test', role: 'teacher', domains: [], homeroomClass: '', createdAt: iso(), updatedAt: iso() } },
        { set: `${ROOT}/emailIndex/zz.restore@alpha.demo.test`, data: { teacherId: 'tch_zz_restore' } },
    ], as(chief)), '組長建立教師＋emailIndex');
    denied(await setDoc(CFG, { currentSemester: semesterId, schoolName: 'x' }, as(chief)), '組長寫 config/main');
});

await suite.case('(g) 不會還原的資料確實寫不進去：歷史學期紀錄、過期的待審申請（連主任也不行）', async () => {
    // P9-A2-2（rules v2.18，使用者決定學期依日期推算）：相鄰的上一學期、日期一致且未封存時允許補登，
    // 所以攻擊案例改用「日期往前推一年」的更早學期（與目前學期相隔 2 學期以上），仍須被拒。
    // 歷史學期紀錄不經還原寫回，改由前端 planRestore 負責（見 (f) 的 plan.records.historical）。
    const old = fixture.previousSemesterRecords[0];
    const olderDate = `${Number(old.public.date.slice(0, 4)) - 1}${old.public.date.slice(4)}`;
    const olderSid = dateToSemesterId(olderDate);
    ok(olderSid && olderSid !== prevSemester && olderSid !== semesterId, `更早學期（${olderSid}）與目前、上一學期不同`);
    denied(await createDoc(`${ROOT}/substituteRecords`, 'rec_zz_hist', { ...old.public, date: olderDate, semesterId: olderSid }, as(dir)), '主任建立兩學期以前的紀錄');
    const req = fixture.pendingRequests[0].public;
    denied(await createDoc(`${ROOT}/pendingRequests`, 'req_zz_old', { ...req, createdAt: '2026-03-02T00:00:00.000Z' }, as(dir)), '主任建立舊時間的待審申請');
});

/* ===================== (f) 清空後還原 ===================== */

await suite.case('(f) 模擬清除所有資料＋誤刪教師後，以備份還原（勾選恢復登入綁定）：教師、課表、紀錄、設定與原本一致', async () => {
    // --- 清空（admin 身分，避免主任刪掉自己的教師檔而失去權限）---
    for (const r of original.substituteRecords) {
        await deleteDoc(`${ROOT}/substituteRecords/${r.id}/private/detail`);
        await deleteDoc(`${ROOT}/substituteRecords/${r.id}`);
    }
    for (const r of original.pendingRequests) {
        await deleteDoc(`${ROOT}/pendingRequests/${r.id}/private/detail`);
        await deleteDoc(`${ROOT}/pendingRequests/${r.id}`);
    }
    const keep = new Set([dir.teacherId, chief.teacherId]);
    const removedTeachers = original.teachers.filter(t => !keep.has(t.id));
    for (const t of removedTeachers) {
        await deleteDoc(`${ROOT}/teachers/${t.id}`);
        if (t.data.email) await deleteDoc(`${ROOT}/emailIndex/${t.data.email}`);
    }
    await mustSetDoc(SCHED(semesterId), { scheduleData: [], teachers: [], classes: [], subjectDomainMap: {}, schoolName: '', updatedAt: iso(), version: 9 });
    await deleteDoc(`${ROOT}/config/settlement`);
    await deleteDoc(`${ROOT}/config/grade9`);

    // --- 還原（director；寫入形狀同 backupService.restore*）---
    const v = await fmt.parseAndValidateBackupText(fmt.serializeBackup(backupObj), { schoolId: SCHOOL });
    ok(v.ok, '備份檔驗證');
    const backup = v.backup;
    const cloudSections = await collectSections(dir, { details: false, imports: false });
    const cloud = fmt.cloudStateFromSections(cloudSections);
    // 這個案例驗證「完整還原」與原本一致，所以走勾選路徑（教師檔帶 email 與 emailIndex）；未勾選的路徑見 (h)
    const plan = fmt.planRestore({ backup, cloud, currentSemesterId: semesterId, restoreEmailIndex: true });
    eq(plan.teachers.create.length, removedTeachers.length, '計畫：要補回的教師數');
    eq(plan.records.create.length, nRecCur, '計畫：目前學期紀錄全部可還原');
    eq(plan.records.historical, nRecPrev, '計畫：歷史學期紀錄不還原（筆數）');
    eq(plan.pending.notRestored, nPending, '計畫：待審申請不還原（筆數）');

    await restoreTeachersREST(dir, backup, plan);
    const s = backup.config.settlement;
    allowed(await setDoc(`${ROOT}/config/settlement`, {
        calendarId: s.calendarId, calendarApiKey: s.calendarApiKey, weeksByYear: s.weeksByYear, updatedAt: iso(), updatedBy: dir.email,
    }, as(dir)), '還原 settlement');
    // PL-24：還原 config/grade9（形狀同 backupService.restoreConfig → saveGrade9Config；rules v2.15 欄位白名單與型別檢查）
    eq(plan.config.grade9, 'create', '計畫：雲端沒有 grade9 → create');
    const g = backup.config.grade9;
    allowed(await setDoc(`${ROOT}/config/grade9`, {
        semesterId: g.semesterId, enabled: g.enabled === true, effectiveDate: g.effectiveDate || '', updatedAt: iso(), updatedBy: dir.email,
    }, as(dir)), '還原 config/grade9（主任）');
    const bkSched = backup.schedules.find(x => x.id === semesterId).data;
    const { updatedAt: _u, version: _v, ...schedRest } = bkSched;
    const cur = (await getDoc(SCHED(semesterId))).data;
    const r = await saveScheduleTx(dir, semesterId, schedRest, { expected: expectedFromDoc(cur) });
    ok(!r.guardError, `課表還原守門：${r.guardError && r.guardError.message}`);
    allowed(r, '還原目前學期課表（交易）');
    for (const c of chunk(backup.substituteRecords.filter(x => plan.records.create.includes(x.id)), RESTORE_RECORD_BATCH)) {
        const writes = [];
        for (const x of c) {
            if (x.private) writes.push({ set: `${ROOT}/substituteRecords/${x.id}/private/detail`, data: x.private });
            writes.push({ set: `${ROOT}/substituteRecords/${x.id}`, data: fmt.stripReservedFields(x.data) });
        }
        allowed(await commitBatch(writes, as(dir)), `還原紀錄批次（${c.length} 筆）`);
    }

    // --- 比對 ---
    const after = await collectSections(dir, { imports: false });
    const byId = (list) => Object.fromEntries(list.map(x => [x.id, x]));
    const T0 = byId(original.teachers), T1 = byId(after.teachers);
    eq(Object.keys(T1).length, Object.keys(T0).length, '教師數量');
    ok(Object.keys(T0).every(id => sameJson(T0[id].data, T1[id].data)), '每位教師資料與原本一致');
    const R0 = byId(original.substituteRecords.filter(x => x.data.semesterId === semesterId)), R1 = byId(after.substituteRecords);
    eq(Object.keys(R1).length, Object.keys(R0).length, '紀錄筆數（僅目前學期）');
    ok(Object.keys(R0).every(id => sameJson(R0[id].data, R1[id]?.data) && sameJson(R0[id].private, R1[id]?.private)), '每筆紀錄與 private/detail 與原本一致');
    ok(after.substituteRecords.every(x => x.data.semesterId === semesterId), '歷史學期紀錄沒有被寫入');
    eq(after.pendingRequests.length, 0, '待審申請沒有被還原');
    const S0 = original.schedules.find(x => x.id === semesterId).data, S1 = after.schedules.find(x => x.id === semesterId).data;
    ok(sameJson(S0.scheduleData, S1.scheduleData) && sameJson(S0.teachers, S1.teachers) && sameJson(S0.classes, S1.classes), '目前學期課表內容與原本一致');
    ok(after.config.settlement && after.config.settlement.calendarId === 'cal-1', 'settlement 已還原');
    ok(after.config.grade9 && after.config.grade9.semesterId === semesterId && after.config.grade9.enabled === true && after.config.grade9.effectiveDate === '2099-01-02', 'config/grade9 已還原（PL-24）');
    ok((await getDoc(`${ROOT}/emailIndex/${removedTeachers.find(t => t.data.email).data.email}`)).ok, '勾選還原：emailIndex 已重建');
});

/* ===================== (h) 被刪除的教師經還原補回後不得自動復權 ===================== */

{
    const chiefTid = chief.teacherId;
    const T_PATH = `${ROOT}/teachers/${chiefTid}`;
    const MAP = `${ROOT}/userMappings/${chief.localId}`;
    const IDX = `${ROOT}/emailIndex/${chief.email}`;
    const chiefData = original.teachers.find(t => t.id === chiefTid).data;
    const mappingBody = { linkedTeacherId: chiefTid, email: chief.email };
    const readSettlement = async () => getDoc(`${ROOT}/config/settlement`, as(chief));
    const readPrivate0 = async () => {
        const rec = fixture.substituteRecords.find(r => r.private);
        return getDoc(`${ROOT}/substituteRecords/${rec.recordId}/private/detail`, as(chief));
    };
    /** 刪除（admin）：教師檔＋emailIndex；withMapping=false 時留下 mapping（模擬舊版刪除沒清掉的孤兒 mapping）。 */
    const removeChief = async ({ withMapping }) => {
        if (withMapping) await deleteDoc(MAP); else await mustSetDoc(MAP, mappingBody);
        await deleteDoc(IDX);
        await deleteDoc(T_PATH);
    };
    /** 以備份還原 chief（director 身分）；回傳計畫供斷言。 */
    const restoreChief = async ({ withLogin, legacyKeepEmail = false }) => {
        const v = await fmt.parseAndValidateBackupText(fmt.serializeBackup(backupObj), { schoolId: SCHOOL });
        ok(v.ok, '備份檔驗證');
        const cloud = fmt.cloudStateFromSections(await collectSections(dir, { details: false, imports: false }));
        const plan = fmt.planRestore({ backup: v.backup, cloud, currentSemesterId: semesterId, restoreEmailIndex: withLogin });
        eq(JSON.stringify(plan.teachers.create), JSON.stringify([chiefTid]), '計畫：只缺被刪除的組長');
        await restoreTeachersREST(dir, v.backup, plan, { legacyKeepEmail });
        return plan;
    };
    /** REST 版 updateTeacher（email 由 null 變為有值）：同一批寫教師檔 email 與 emailIndex。 */
    const fillEmailBack = async () => allowed(await commitBatch([
        { set: T_PATH, data: { ...(await getDoc(T_PATH)).data, email: chief.email, updatedAt: iso() } },
        { set: IDX, data: { teacherId: chiefTid } },
    ], as(dir)), '主任在教師管理把信箱填回（updateTeacher：email 與 emailIndex 同批）');
    const finish = async () => {   // 讓後續案例拿到完整狀態
        await mustSetDoc(T_PATH, chiefData); await mustSetDoc(IDX, { teacherId: chiefTid }); await mustSetDoc(MAP, mappingBody);
    };

    await suite.case('(h) 對照組：舊行為（補回教師檔並帶回原信箱）下，被刪除的組長能自建 mapping 重新取得 approver 資源', async () => {
        await removeChief({ withMapping: true });
        denied(await readSettlement(), '刪除後讀 settlement');
        await restoreChief({ withLogin: false, legacyKeepEmail: true });
        allowed(await setDoc(MAP, mappingBody, as(chief)), '（舊行為）自建 mapping');
        allowed(await readSettlement(), '（舊行為）已復權：讀 settlement');
        await removeChief({ withMapping: true });
    });

    await suite.case('(h) 未勾選還原：補回的教師檔 email 為 null、沒有 emailIndex；被刪除的組長自建 mapping 被拒、讀不到 approver 資源', async () => {
        await removeChief({ withMapping: true });
        await restoreChief({ withLogin: false });
        const t = await getDoc(T_PATH);
        ok(t.ok && t.data.email === null, `教師檔 email 為 null（實得 ${JSON.stringify(t.data && t.data.email)}）`);
        eq(t.data.role, chiefData.role, '角色仍照備份補回');
        ok(!(await getDoc(IDX)).ok, '沒有 emailIndex');
        denied(await setDoc(MAP, mappingBody, as(chief)), '自建 mapping（帶 email）');
        denied(await setDoc(MAP, { linkedTeacherId: chiefTid }, as(chief)), '自建 mapping（不帶 email）');
        denied(await readSettlement(), '讀 settlement（approver 專屬）');
        denied(await readPrivate0(), '讀他人 private/detail');
        ok(!(await getDoc(IDX, as(chief))).ok, '沒有 emailIndex 可讀（走登入流程也綁不到）');
    });

    await suite.case('(h) 填回信箱後可正常綁定：主任在教師管理把信箱填回，組長自建 mapping 成功並恢復 approver 資源', async () => {
        // 承上一案例：教師檔 email 為 null、沒有 mapping
        await fillEmailBack();
        allowed(await getDoc(IDX, as(chief)), '填回後自己的 emailIndex 可讀');
        allowed(await setDoc(MAP, mappingBody, as(chief)), '自建 mapping');
        allowed(await readSettlement(), '讀 settlement');
    });

    await suite.case('(h) 殘留舊 mapping 的情況：未勾選還原後，本人什麼都不做也拿不到角色；填回信箱後才恢復', async () => {
        await removeChief({ withMapping: false });
        ok((await getDoc(MAP)).ok, '前提：mapping 仍殘留');
        denied(await readSettlement(), '教師檔不在：讀 settlement');
        await restoreChief({ withLogin: false });
        denied(await readSettlement(), '補回後（email 為 null）：讀 settlement 仍被拒');
        denied(await readPrivate0(), '補回後：讀他人 private/detail 仍被拒');
        await fillEmailBack();
        allowed(await readSettlement(), '主任填回信箱後：殘留 mapping 重新有效');
    });

    await suite.case('(h) 勾選還原：教師檔帶 email 與 emailIndex，組長可正常綁定（正向）', async () => {
        await removeChief({ withMapping: true });
        const plan = await restoreChief({ withLogin: true });
        eq(plan.teachers.restoreEmailIndex, true, '計畫帶勾選旗標');
        const t = await getDoc(T_PATH);
        ok(t.ok && t.data.email === chief.email, '教師檔 email 已補回');
        eq((await getDoc(IDX)).data.teacherId, chiefTid, 'emailIndex 已補回');
        allowed(await getDoc(IDX, as(chief)), '組長讀自己的 emailIndex');
        allowed(await setDoc(MAP, mappingBody, as(chief)), '自建 mapping');
        allowed(await readSettlement(), '讀 settlement');
        await finish();
    });
}


/* ===================== (a)(b) 開新學期 ===================== */

await suite.case('(a) 對已存在且有課表的學期「開新學期」：課表內容不變、currentSemester 切換（組長不可）', async () => {
    const before = (await getDoc(SCHED(prevSemester))).data;
    denied((await activateSemesterREST(chief, prevSemester)).res, '組長不能切換學期');
    const { res, createdSchedule } = await activateSemesterREST(dir, prevSemester);
    allowed(res, '主任切換到既有學期');
    ok(!createdSchedule, '目標學期已存在：不建立、不寫入課表');
    eq((await getDoc(CFG)).data.currentSemester, prevSemester, 'currentSemester 已切換');
    ok(sameJson((await getDoc(SCHED(prevSemester))).data, before), '該學期課表原封不動');
    allowed((await activateSemesterREST(dir, semesterId)).res, '切回原學期');
    eq((await getDoc(CFG)).data.currentSemester, semesterId, '已切回');
});

await suite.case(`(b) 開全新學期：建立空課表（${HAS_A ? 'A：與 config 同一次提交，原子' : '未套用 A：原子提交被拒，改驗證相容順序（先 config 再建立）'}）`, async () => {
    const NEW = '116-1';
    const { res } = await activateSemesterREST(dir, NEW);
    if (HAS_A) {
        allowed(res, '原子切換並建立空課表');
    } else {
        denied(res, '舊規則下原子提交被拒（預期）');
        // 相容順序：先改 config，再建立空課表（config 已指向新學期，create 規則通過）
        allowed(await setDoc(CFG, { ...(await getDoc(CFG)).data, currentSemester: NEW, updatedAt: iso() }, as(dir)), '先改 config');
        allowed(await setDoc(SCHED(NEW), { scheduleData: [], teachers: [], classes: [], subjectDomainMap: {}, schoolName: '', updatedAt: iso(), version: 1 }, as(dir)), '再建立空課表');
    }
    const created = await getDoc(SCHED(NEW));
    ok(created.ok && created.data.scheduleData.length === 0 && created.data.version === 1, '新學期有一份空課表');
    eq((await getDoc(CFG)).data.currentSemester, NEW, 'currentSemester = 新學期');
    // 一般 approver 不能藉 getAfter 繞過學期鎖：組長對「非目前學期」建立課表仍被拒
    denied(await setDoc(SCHED('117-1'), { scheduleData: [], teachers: [], classes: [], updatedAt: iso(), version: 1 }, as(chief)), '組長對非目前學期建立課表');
    allowed((await activateSemesterREST(dir, semesterId)).res, '切回 115-1 供後續測試');
});

/* ===================== (c) 並行編輯 ===================== */

await suite.case('(c) 兩個 approver 以過期版本先後寫課表：第二個被拒（client 守門），資料是第一個的', async () => {
    const cur = (await getDoc(SCHED(semesterId))).data;
    const baseA = expectedFromDoc(cur), baseB = expectedFromDoc(cur);
    const rA = await saveScheduleTx(chief, semesterId, { ...cur, schoolName: 'A組長改的' }, { expected: baseA, backup: false });
    allowed(rA, '組長以現版本寫入');
    const rB = await saveScheduleTx(dir, semesterId, { ...cur, schoolName: 'B主任改的' }, { expected: baseB, backup: false });
    ok(rB.guardError instanceof ScheduleConflictError, `第二位以過期版本寫入應被守門拒絕（實得 ${rB.guardError && rB.guardError.name}）`);
    eq((await getDoc(SCHED(semesterId))).data.schoolName, 'A組長改的', '雲端資料仍是第一位的');
    const fresh = (await getDoc(SCHED(semesterId))).data;
    allowed(await saveScheduleTx(dir, semesterId, { ...fresh, schoolName: 'B重新載入後改的' }, { expected: expectedFromDoc(fresh), backup: false }), '重新載入後以新版本寫入');
});

await suite.case(`(c) 規則層：不帶 version／以過期 version 整份覆寫的寫入${HAS_B ? '被拒（v2.13-B）' : '仍會成功（未套用 B，僅靠前端守門）'}`, async () => {
    const cur = (await getDoc(SCHED(semesterId))).data;
    const stale = await updateDoc(SCHED(semesterId), { schoolName: '舊版頁面蓋掉', updatedAt: iso() }, as(chief));   // 不帶 version
    const staleVer = await updateDoc(SCHED(semesterId), { schoolName: '過期版本蓋掉', updatedAt: iso(), version: Number(cur.version) }, as(chief));   // 沒遞增
    if (HAS_B) { denied(stale, '不帶 version'); denied(staleVer, 'version 沒遞增'); }
    else { allowed(stale, '未套用 B：不帶 version 仍可寫（已知，靠前端守門）'); }
    const okWrite = await updateDoc(SCHED(semesterId), { schoolName: '正確遞增', updatedAt: iso(), version: Number((await getDoc(SCHED(semesterId))).data.version) + 1 }, as(chief));
    allowed(okWrite, 'version 遞增 1 的寫入');
});

await suite.case('(c) 空資料覆寫非空課表被守門擋下；allowEmpty（清除所有資料）才放行', async () => {
    const cur = (await getDoc(SCHED(semesterId))).data;
    const empty = { scheduleData: [], teachers: [], classes: [], subjectDomainMap: {}, schoolName: '' };
    const r = await saveScheduleTx(dir, semesterId, empty, { expected: expectedFromDoc(cur), backup: false });
    ok(r.guardError instanceof ScheduleEmptyOverwriteError, '空覆寫被擋');
    ok((await getDoc(SCHED(semesterId))).data.scheduleData.length > 0, '課表未被清空');
});

/* ===================== (d) 匯入 → 還原舊課表 ===================== */

await suite.case('(d) 匯入新課表覆寫後，被覆寫的舊課表可從匯入紀錄還原成原內容', async () => {
    const before = (await getDoc(SCHED(semesterId))).data;
    const incoming = { ...before, scheduleData: before.scheduleData.slice(0, 12), classes: before.classes.slice(0, 2), schoolName: '新匯入的課表' };
    const r = await saveScheduleTx(chief, semesterId, incoming, { expected: expectedFromDoc(before) });
    allowed(r, '匯入（覆寫＋同一次提交留下匯入前備份）');
    ok(typeof r.backupId === 'string', '產生了匯入前備份');
    eq((await getDoc(SCHED(semesterId))).data.scheduleData.length, 12, '主文件已是新課表');

    const imps = await listDocs(`${SCHED(semesterId)}/imports`, as(chief));
    allowed(imps, '列出匯入紀錄');
    const pre = imps.docs.find(d => d.id === r.backupId);
    ok(!!pre && pre.source === 'pre_import', '匯入紀錄中有 pre_import 備份');
    const snap = getRestorableSnapshot(pre);
    ok(!!snap, '備份帶有可還原的快照');
    ok(sameJson(snap.scheduleData, before.scheduleData) && sameJson(snap.teachers, before.teachers) && sameJson(snap.classes, before.classes), '快照內容等於被覆寫前的舊課表');

    const cur = (await getDoc(SCHED(semesterId))).data;
    allowed(await saveScheduleTx(chief, semesterId, { ...cur, ...snap }, { expected: expectedFromDoc(cur) }), '以備份還原');
    const restored = (await getDoc(SCHED(semesterId))).data;
    ok(sameJson(restored.scheduleData, before.scheduleData) && sameJson(restored.classes, before.classes), '還原後課表與匯入前完全一致');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
