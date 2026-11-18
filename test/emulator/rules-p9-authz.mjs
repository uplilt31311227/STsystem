#!/usr/bin/env node
/**
 * firestore.rules v2.17（P9 批次 A2，使用者 2026-11-17 三項權限決定）
 *
 *   L9  初始主任白名單在學校有正式主任後自動失效（config/main.directorEstablished 旗標，只進不退）
 *   PA  platformAdmin 為全系統最高、不可移除的管理員（每校視同主任；client 不可寫 platformAdmins）
 *   SoD 職務分離：核准者不可核准自己發起的申請（自我調課且無他人牽涉例外），platformAdmin 同樣適用
 *
 * 案例命名：「<編號> ATTACK／ALLOW 對照 …」。編號供 test/emulator/mutate-p9.mjs 的變異測試對應
 * （暫時拿掉某條新限制後，對應編號的 ATTACK 案例必須轉為 ALLOW 而失敗）。
 *
 * 案例互相獨立：每個案例各自建立新學校（schools/zz-p9-*）與帳號，不共用會被改變的狀態。
 * 前端形狀來源：authGuardV2（bootstrap：createTeacher batch＋自建 mapping＋ensureDirectorEstablished 的 config merge）、
 * pendingRequestService.approveRequest／rejectRequest（tx.update 欄位）、operationLogger.log（actor 形狀）。
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-p9-authz.mjs（會清空並重建 emulator 資料）
 *       或 npx firebase emulators:exec --project demo-stsystem --only auth,firestore "node test/emulator/rules-p9-authz.mjs"
 */
import {
    createDoc, updateDoc, mergeDoc, setDoc, getDoc, deleteDoc, listDocs, mustSetDoc, createTestUser, commitBatch, runTransaction,
} from './emu-client.mjs';
import { Suite, allowed, denied, eq, ok } from '../scenarios/harness.mjs';
import { setup, as, iso, logEntry } from './kit.mjs';

const W = await setup();
const { semesterId, dir, chief, t1, t2, t3 } = W;
const PA = W.seed.platformAdmin;           // 種子平台管理者（platformAdmins/{uid}，非任何學校成員）
const suite = new Suite('firestore.rules v2.17：白名單失效（L9）、platformAdmin 最高管理員（PA）、職務分離（SoD）');

/* ===================== 測試工具：每個案例各自的新學校與帳號 ===================== */

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

/** 建立全新學校 config（admin 繞過規則）。whitelist 為 initialAdminEmails；flag=true 即 directorEstablished。 */
async function newSchool({ flag = false, whitelist = [] } = {}) {
    const id = `zz-p9-${uniq()}`;
    const base = `schools/${id}`;
    const S = {
        id, base, whitelist: [...whitelist],
        cfg: `${base}/config/main`,
        T: (x) => `${base}/teachers/${x}`,
        pend: `${base}/pendingRequests`,
        recs: `${base}/substituteRecords`,
        logs: `${base}/operationLogs`,
        maps: `${base}/userMappings`,
        emailIdx: `${base}/emailIndex`,
    };
    await mustSetDoc(S.cfg, {
        schoolName: '測試校', currentSemester: semesterId, initialAdminEmails: [...whitelist],
        createdAt: iso(), updatedAt: iso(), ...(flag ? { directorEstablished: true } : {}),
    });
    return S;
}

const newEmail = (tag) => `p9_${tag}_${uniq()}@p9.demo.test`;

/** 建立成員（Auth 帳號＋教師檔＋emailIndex＋userMappings）。whitelisted=true 時 email 同時加入 initialAdminEmails。 */
async function addMember(S, { role = 'teacher', name, whitelisted = false, tag = 'm' }) {
    const email = newEmail(tag);
    const user = await createTestUser(email);
    const teacherId = `tch_${uniq()}`;
    await mustSetDoc(S.T(teacherId), { name, email, domains: [], homeroomClass: '', role, createdAt: iso(), updatedAt: iso() });
    await mustSetDoc(`${S.emailIdx}/${email}`, { teacherId });
    await mustSetDoc(`${S.maps}/${user.localId}`, { linkedTeacherId: teacherId, email, googleName: name, lastLoginAt: iso() });
    if (whitelisted) { S.whitelist.push(email); await mergeDoc(S.cfg, { initialAdminEmails: S.whitelist }); }
    return { ...user, teacherId, name, role, email };
}

/** 白名單內、尚未是成員的使用者（只有 Auth 帳號；bootstrap 前的狀態）。 */
async function addBootstrapUser(S) {
    const email = newEmail('boot');
    S.whitelist.push(email);
    await mergeDoc(S.cfg, { initialAdminEmails: S.whitelist });
    return { ...(await createTestUser(email)), email };
}

const recBase = { date: '2026-11-17', weekday: '週二', period: '第三節', className: '7年1班', type: '代課', originalTeacher: '甲', substituteTeacher: '乙', status: 'approved', createdAt: '2026-11-07T00:00:00.000Z' };

/** 以 admin 寫入一筆在途申請（待核准）。extra 可覆蓋 initiatedBy／isSelfSwap／教師 id 等。 */
async function seedPending(S, id, extra = {}) {
    await mustSetDoc(`${S.pend}/${id}`, {
        ...recBase, requestType: 'substitute', status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: {},
        initiatedBy: t1.teacherId, initiatedByName: t1.name, requiredApproverId: t2.teacherId, semesterId, createdAt: iso(), ...extra,
    });
    return `${S.pend}/${id}`;
}

/** 前端 approveRequest 的 tx.update 欄位（pendingRequestService.approveRequest）。 */
const approvePatch = (byId, byName = '核准者') => ({ status: 'approved', approvedAt: iso(), approvedBy: byId, approvedByName: byName, statusUpdatedAt: iso() });
/** 前端 rejectRequest 的 tx.update 欄位。 */
const rejectPatch = (byId) => ({ status: 'rejected', rejectedAt: iso(), rejectedBy: byId, rejectedByName: '駁回者', rejectNote: '', statusUpdatedAt: iso() });

/** authGuardV2 bootstrap 的寫入序列：createTeacher batch（教師檔＋emailIndex）→ 自建 mapping。回傳各步回應。 */
async function bootstrapWrites(S, user, teacherId = `tch_${uniq()}`) {
    const batch = await commitBatch([
        { set: S.T(teacherId), data: { name: '新主任', email: user.email, domains: [], homeroomClass: '', role: 'director', createdAt: iso(), updatedAt: iso() } },
        { set: `${S.emailIdx}/${user.email}`, data: { teacherId } },
    ], as(user));
    const mapping = batch.ok
        ? await createDoc(S.maps, user.localId, { email: user.email, googleName: null, googlePhotoUrl: null, lastProviderId: 'google.com', linkedTeacherId: teacherId, lastLoginAt: iso() }, as(user))
        : { ok: false, status: 0, error: '前一步被拒' };
    return { batch, mapping, teacherId };
}

/** operationLogger.log 的 actor 形狀（platformAdmin：teacherId 用 uid、name 為「平台管理員」）。 */
const paLog = (pa, over = {}) => ({
    timestamp: iso(),
    actor: { uid: pa.localId, email: pa.email, name: '平台管理員', role: 'director', teacherId: pa.localId },
    action: 'approve', targetType: 'pendingRequest', targetId: 'x', details: {}, semesterId, ...over,
});

/* ===================== L9：初始主任白名單失效 ===================== */

await suite.case('L9-A ALLOW 對照：旗標未設（既有學校部署後、尚未補旗標）白名單主任 bootstrap 全程可通過（建教師檔＋emailIndex、自建 mapping、讀 config、補設旗標）', async () => {
    const S = await newSchool();
    const u = await addBootstrapUser(S);
    allowed(await getDoc(S.cfg, as(u)), '白名單主任（尚非成員）讀 config');
    const r = await bootstrapWrites(S, u);
    allowed(r.batch, 'bootstrap：createTeacher batch');
    allowed(r.mapping, 'bootstrap：自建 userMappings');
    allowed(await mergeDoc(S.cfg, { directorEstablished: true, updatedAt: iso() }, as(u)), 'ensureDirectorEstablished：補設旗標（前端 upsertConfig merge 形狀）');
    eq((await getDoc(S.cfg)).data.directorEstablished, true, '旗標已寫入');
    // 旗標設定後，這位主任靠「教師檔 director＋mapping」仍是主任，不依賴白名單
    allowed(await mergeDoc(S.cfg, { schoolName: '改名', updatedAt: iso() }, as(u)), '旗標確立後，正式主任仍可寫 config');
});

await suite.case('L9-ATK ATTACK：旗標為 true，白名單使用者（非成員）讀 config／bootstrap 建主任教師檔／改 config／寫序號鎖 → 全部 DENY', async () => {
    const S = await newSchool({ flag: true });
    const u = await addBootstrapUser(S);
    denied(await getDoc(S.cfg, as(u)), '讀 config（白名單後備已失效）');
    const r = await bootstrapWrites(S, u);
    denied(r.batch, 'bootstrap：createTeacher batch');
    eq((await getDoc(S.T(r.teacherId))).ok, false, '教師檔未建立');
    denied(await mergeDoc(S.cfg, { schoolName: '被改名', updatedAt: iso() }, as(u)), '改 config');
    denied(await createDoc(`${S.base}/config`, 'recordsLock', { seq: 1, updatedAt: iso() }, as(u)), '寫序號鎖（approver 權限）');
    denied(await createDoc(S.pend, 'x1', { ...recBase, requestType: 'substitute', status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: {}, initiatedBy: t1.teacherId, initiatedByName: 'x', semesterId, createdAt: iso() }, as(u)), '代發申請（approver 權限）');
});

await suite.case('L9-ATK ATTACK：旗標為 true，白名單成員（教師檔 role=teacher、有 mapping）補登自己 role 為 director → DENY；改 config／寫日誌聲稱 director → DENY', async () => {
    const S = await newSchool({ flag: true });
    const m = await addMember(S, { role: 'teacher', name: '被降級的舊白名單', whitelisted: true, tag: 'demoted' });
    denied(await updateDoc(S.T(m.teacherId), { role: 'director', updatedAt: iso() }, as(m)), '補登自己 role（isInitialDirector 分支已失效）');
    eq((await getDoc(S.T(m.teacherId))).data.role, 'teacher', 'role 未被改');
    denied(await mergeDoc(S.cfg, { schoolName: '改名', updatedAt: iso() }, as(m)), '改 config');
    denied(await createDoc(S.logs, `l${uniq()}`, logEntry({ ...m, role: 'director' }, semesterId, 'login', 'teacher', m.teacherId), as(m)), '日誌 actor.role 聲稱 director（actorRoleOk 的白名單後備已失效）');
});

await suite.case('L9-ALLOW 對照：旗標未設，同一位白名單成員（role=teacher）補登自己 role、改 config、寫 actor.role=director 的日誌 → ALLOW（舊行為不變，證明上一案的 DENY 來自旗標）', async () => {
    const S = await newSchool();
    const m = await addMember(S, { role: 'teacher', name: '舊白名單', whitelisted: true, tag: 'legacy' });
    allowed(await updateDoc(S.T(m.teacherId), { role: 'director', updatedAt: iso() }, as(m)), '補登自己 role');
    const m2 = await addMember(S, { role: 'teacher', name: '舊白名單2', whitelisted: true, tag: 'legacy2' });
    allowed(await mergeDoc(S.cfg, { schoolName: '改名', updatedAt: iso() }, as(m2)), '改 config');
    allowed(await createDoc(S.logs, `l${uniq()}`, logEntry({ ...m2, role: 'director' }, semesterId, 'login', 'teacher', m2.teacherId), as(m2)), '日誌 actor.role=director');
});

await suite.case('L9-ALLOW 對照：旗標為 true，正式主任（教師檔 director＋mapping）原有操作全部照常（讀寫 config、改別人 role、建教師檔、代發申請）', async () => {
    const S = await newSchool({ flag: true });
    const d = await addMember(S, { role: 'director', name: '正式主任', tag: 'dir' });
    const victim = await addMember(S, { role: 'teacher', name: '甲教師', tag: 'v' });
    allowed(await getDoc(S.cfg, as(d)), '讀 config');
    allowed(await mergeDoc(S.cfg, { schoolName: '正式改名', updatedAt: iso() }, as(d)), '改 config（旗標維持 true）');
    allowed(await updateDoc(S.T(victim.teacherId), { role: 'section_chief', updatedAt: iso() }, as(d)), '改別人 role（setRole）');
    allowed(await commitBatch([
        { set: S.T('tch_new1'), data: { name: '新教師', email: 'new1@p9.demo.test', domains: [], homeroomClass: '', role: 'teacher', createdAt: iso(), updatedAt: iso() } },
        { set: `${S.emailIdx}/new1@p9.demo.test`, data: { teacherId: 'tch_new1' } },
    ], as(d)), '建教師檔＋emailIndex（createTeacher batch）');
    allowed(await createDoc(`${S.base}/config`, 'recordsLock', { seq: 1, updatedAt: iso() }, as(d)), '寫序號鎖');
});

await suite.case('L9-FLAG ATTACK：旗標為 true 時任何 client 都不能改回 false／改成非布林／拿掉／刪除 config/main（正式主任、白名單、platformAdmin 皆然）', async () => {
    const S = await newSchool({ flag: true });
    const d = await addMember(S, { role: 'director', name: '正式主任', tag: 'dirf' });
    denied(await mergeDoc(S.cfg, { directorEstablished: false, updatedAt: iso() }, as(d)), '主任改回 false');
    denied(await mergeDoc(S.cfg, { directorEstablished: 'yes', updatedAt: iso() }, as(d)), '主任改成字串');
    denied(await mergeDoc(S.cfg, { directorEstablished: null, updatedAt: iso() }, as(d)), '主任改成 null');
    // 整份覆寫、缺旗標欄位（等同拿掉旗標）
    denied(await setDoc(S.cfg, { schoolName: '覆寫', currentSemester: semesterId, initialAdminEmails: [d.email], createdAt: iso(), updatedAt: iso() }, as(d)), '整份覆寫拿掉旗標');
    denied(await mergeDoc(S.cfg, { directorEstablished: false, updatedAt: iso() }, as(PA)), 'platformAdmin 改回 false');
    eq((await getDoc(S.cfg)).data.directorEstablished, true, '旗標仍為 true');
});

await suite.case('L9-DEL ATTACK：旗標為 true 時，主任與 platformAdmin 都不能刪除 config/main（刪掉重建就能重開白名單）', async () => {
    const S = await newSchool({ flag: true });
    const d = await addMember(S, { role: 'director', name: '正式主任', tag: 'dird' });
    denied(await deleteDoc(S.cfg, as(d)), '主任刪除 config/main');
    denied(await deleteDoc(S.cfg, as(PA)), 'platformAdmin 刪除 config/main');
    eq((await getDoc(S.cfg)).ok, true, 'config/main 仍在');
});

await suite.case('L9-FLAG ALLOW 對照：旗標為 true 時，主任寫入保留旗標的 config 更新（改名、切換學期、重設 true）→ ALLOW；旗標未設時可設 true（也可設 false，維持舊行為）', async () => {
    const S = await newSchool({ flag: true });
    const d = await addMember(S, { role: 'director', name: '正式主任', tag: 'dirg' });
    allowed(await mergeDoc(S.cfg, { schoolName: '改名', updatedAt: iso() }, as(d)), '改名（merge，旗標不動）');
    allowed(await mergeDoc(S.cfg, { currentSemester: '115-2', updatedAt: iso() }, as(d)), '切換學期');
    allowed(await mergeDoc(S.cfg, { directorEstablished: true, updatedAt: iso() }, as(d)), '重設為 true（冪等）');
    const S2 = await newSchool();
    const d2 = await addMember(S2, { role: 'director', name: '主任二', tag: 'dirh' });
    allowed(await mergeDoc(S2.cfg, { directorEstablished: false, updatedAt: iso() }, as(d2)), '未確立時寫 false（無害）');
    allowed(await mergeDoc(S2.cfg, { directorEstablished: true, updatedAt: iso() }, as(d2)), '未確立時設 true');
    const S3 = await newSchool();
    const d3 = await addMember(S3, { role: 'director', name: '主任三', tag: 'diri' });
    allowed(await deleteDoc(S3.cfg, as(d3)), '未確立的 config/main 仍可刪（v2.16 行為，旗標只保護已確立者）');
});

await suite.case('L9-LOCKOUT ALLOW 對照：旗標為 true、學校沒有任何主任成員時，platformAdmin 仍可讀寫管理（白名單失效不會讓學校無人可管）', async () => {
    const S = await newSchool({ flag: true });
    const orphan = await addMember(S, { role: 'teacher', name: '一般教師', tag: 'only' });
    allowed(await getDoc(S.cfg, as(PA)), 'platformAdmin 讀 config');
    allowed(await updateDoc(S.T(orphan.teacherId), { role: 'director', updatedAt: iso() }, as(PA)), 'platformAdmin 指定新主任');
    allowed(await mergeDoc(S.cfg, { schoolName: '由平台管理員改名', updatedAt: iso() }, as(PA)), 'platformAdmin 改 config');
    // 新主任（教師檔已是 director、有 mapping）立即可用
    allowed(await mergeDoc(S.cfg, { schoolName: '新主任改名', updatedAt: iso() }, as(orphan)), '新主任可寫 config（以教師檔 role 為準）');
});

/* ===================== PA：platformAdmin 為全系統最高管理員 ===================== */

await suite.case('PA-READ ALLOW 對照：platformAdmin（非成員）可讀任何學校的 config／教師／紀錄／申請／日誌／mapping／private（含 demo-alpha 與 demo-beta）；ATTACK：非成員的一般帳號、他校主任讀同樣路徑 → DENY', async () => {
    const S = await newSchool({ flag: true });
    const t = await addMember(S, { role: 'teacher', name: '甲', tag: 'r' });
    await mustSetDoc(`${S.recs}/rec1`, { ...recBase, semesterId });
    await mustSetDoc(`${S.recs}/rec1/private/detail`, { leaveType: '事假', leaveTypeName: '事假', reason: 'x', allowedTeacherIds: [t.teacherId] });
    await mustSetDoc(`${S.pend}/p1`, { ...recBase, requestType: 'substitute', status: 'pending_approval', initiatedBy: t.teacherId, semesterId });
    await mustSetDoc(`${S.logs}/l1`, { timestamp: iso(), actor: {}, action: 'x', targetType: 'x', targetId: null, details: {}, semesterId });
    await mustSetDoc(`${S.base}/config/settlement`, { calendarId: '', calendarApiKey: 'k', weeksByYear: {}, updatedAt: iso(), updatedBy: 'x' });
    await mustSetDoc(`${S.base}/archives/114-2`, { semesterId: '114-2', archivedAt: iso() });
    const paths = [S.cfg, `${S.base}/config/settlement`, S.T(t.teacherId), `${S.recs}/rec1`, `${S.recs}/rec1/private/detail`, `${S.pend}/p1`,
        `${S.logs}/l1`, `${S.maps}/${t.localId}`, `${S.base}/archives/114-2`];
    for (const p of paths) allowed(await getDoc(p, as(PA)), `platformAdmin 讀 ${p.replace(S.base, '…')}`);
    allowed(await listDocs(S.emailIdx, as(PA)), 'platformAdmin 列出 emailIndex（approver 的 list 權限）');
    denied(await listDocs(S.emailIdx, as(W.outsider)), '非成員列出 emailIndex');
    for (const school of [W.fixture.schoolId, W.beta.fixture.schoolId]) {
        allowed(await getDoc(`schools/${school}/config/main`, as(PA)), `platformAdmin 讀 ${school} config`);
    }
    const betaDirector = W.beta.director;
    for (const p of [S.cfg, S.T(t.teacherId), `${S.recs}/rec1`, `${S.recs}/rec1/private/detail`, `${S.base}/config/settlement`]) {
        denied(await getDoc(p, as(W.outsider)), `非成員一般帳號讀 ${p.replace(S.base, '…')}`);
        denied(await getDoc(p, as(betaDirector)), `他校主任讀 ${p.replace(S.base, '…')}`);
    }
});

await suite.case('PA-WRITE ALLOW 對照：platformAdmin（非成員）在任一學校行使主任寫入——教師檔 create／改 role／刪、emailIndex、mapping、config、序號鎖、代發紀錄、封存、核准與駁回他人申請、寫日誌', async () => {
    const S = await newSchool({ flag: true });
    const t = await addMember(S, { role: 'teacher', name: '甲', tag: 'w' });
    const pa = as(PA);
    allowed(await commitBatch([
        { set: S.T('tch_pa1'), data: { name: '平台代建', email: 'pa1@p9.demo.test', domains: [], homeroomClass: '', role: 'director', createdAt: iso(), updatedAt: iso() } },
        { set: `${S.emailIdx}/pa1@p9.demo.test`, data: { teacherId: 'tch_pa1' } },
    ], pa), '建教師檔＋emailIndex（role=director）');
    allowed(await updateDoc(S.T(t.teacherId), { role: 'section_chief', updatedAt: iso() }, pa), '改 role');
    allowed(await updateDoc(S.T(t.teacherId), { name: '改名', updatedAt: iso() }, pa), '改姓名（主任權限）');
    allowed(await createDoc(S.maps, 'uid_other', { linkedTeacherId: t.teacherId, email: t.email, lastLoginAt: iso() }, pa), '代建 userMappings');
    allowed(await mergeDoc(S.cfg, { schoolName: '平台改名', updatedAt: iso() }, pa), '改 config（保留旗標）');
    allowed(await createDoc(`${S.base}/config`, 'recordsLock', { seq: 1, updatedAt: iso() }, pa), '寫序號鎖');
    allowed(await createDoc(S.recs, 'rec_pa', { ...recBase, semesterId, initiatedBy: t.teacherId, initiatedByName: t.name, adminOperatorId: PA.localId, initiatedByRole: 'admin' }, pa), '代發紀錄（adminCreate 形狀）');
    allowed(await createDoc(`${S.base}/archives`, '114-2', { semesterId: '114-2', archivedAt: iso(), archivedBy: { uid: PA.localId }, counts: {}, jsonHash: 'h' }, pa), '建立封存');
    const p1 = await seedPending(S, 'pend_ok', { initiatedBy: t.teacherId });
    allowed(await updateDoc(p1, approvePatch(PA.localId, '平台管理員'), pa), '核准他人申請（approvedBy=uid）');
    const p2 = await seedPending(S, 'pend_rej', { initiatedBy: t.teacherId });
    allowed(await updateDoc(p2, rejectPatch(PA.localId), pa), '駁回他人申請（rejectedBy=uid）');
    allowed(await createDoc(S.logs, `l${uniq()}`, paLog(PA), pa), '寫日誌（actor.teacherId=uid）');
    allowed(await deleteDoc(S.T('tch_pa1'), pa), '刪教師檔');
});

await suite.case('PA-WRITE ALLOW 對照：platformAdmin 核准申請的完整交易（建立紀錄＋申請轉 approved）在非成員、無主任的學校可成立（文件存取量在上限內）', async () => {
    const S = await newSchool({ flag: true });
    const t = await addMember(S, { role: 'teacher', name: '甲', tag: 'tx' });
    const p = await seedPending(S, 'pend_tx', { initiatedBy: t.teacherId });
    const now = iso();
    allowed(await runTransaction([p], ([snap]) => {
        const rec = { ...snap };
        delete rec.pendingConsentTeacherIds; delete rec.swapConsents;
        Object.assign(rec, { status: 'approved', approvedAt: now, approvedBy: PA.localId, approvedByName: '平台管理員', fromRequestId: 'pend_tx', createdAt: now, affectedTeacherIds: [t.teacherId], semesterId });
        return [{ create: `${S.recs}/rec_tx`, data: rec }, { update: p, data: approvePatch(PA.localId, '平台管理員') }];
    }, as(PA)), 'platformAdmin 核准交易');
});

await suite.case('PA-ID ATTACK：platformAdmin 核准／駁回時掛別人的名字（approvedBy／rejectedBy 為其他教師）、日誌 actor 冒用他人 → 全部 DENY', async () => {
    const S = await newSchool({ flag: true });
    const t = await addMember(S, { role: 'teacher', name: '甲', tag: 'id' });
    const c = await addMember(S, { role: 'section_chief', name: '組長', tag: 'idc' });
    const p1 = await seedPending(S, 'pend_a', { initiatedBy: t.teacherId });
    denied(await updateDoc(p1, approvePatch(c.teacherId, c.name), as(PA)), 'approvedBy 掛組長');
    denied(await updateDoc(p1, approvePatch('tch_nobody'), as(PA)), 'approvedBy 掛不存在的人');
    denied(await updateDoc(p1, rejectPatch(c.teacherId), as(PA)), 'rejectedBy 掛組長');
    denied(await createDoc(S.logs, `l${uniq()}`, paLog(PA, { actor: { uid: PA.localId, email: PA.email, name: '平台管理員', role: 'director', teacherId: c.teacherId } }), as(PA)), '日誌 actor.teacherId 冒用組長');
    denied(await createDoc(S.logs, `l${uniq()}`, paLog(PA, { actor: { uid: c.localId, email: PA.email, name: '平台管理員', role: 'director', teacherId: PA.localId } }), as(PA)), '日誌 actor.uid 冒用組長');
    denied(await createDoc(S.logs, `l${uniq()}`, paLog(PA, { actor: { uid: PA.localId, email: PA.email, name: '平台管理員', role: 'teacher', teacherId: PA.localId } }), as(PA)), '日誌 actor.role 非 director');
    denied(await createDoc(S.logs, `l${uniq()}`, paLog(PA, { actor: { uid: PA.localId, email: PA.email, name: '長'.repeat(101), role: 'director', teacherId: PA.localId } }), as(PA)), '日誌 actor.name 超過 100 字');
    eq((await getDoc(p1)).data.status, 'pending_approval', '申請狀態未被改');
});

await suite.case('PA-UID ATTACK：非 platformAdmin 不能用 uid 當身分——組長以自己的 uid 填 approvedBy／rejectedBy／日誌 actor.teacherId、組長掛 platformAdmin 的 uid、教師以自己的 uid 核准 → 全部 DENY；ALLOW 對照：組長以自己的 teacherId', async () => {
    const S = await newSchool({ flag: true });
    const t = await addMember(S, { role: 'teacher', name: '甲', tag: 'u1' });
    const c = await addMember(S, { role: 'section_chief', name: '組長', tag: 'u2' });
    ok(c.localId !== c.teacherId, '前置：組長的 uid 與 teacherId 不同');
    const pa = await seedPending(S, 'uid_a', { initiatedBy: t.teacherId });
    denied(await updateDoc(pa, approvePatch(c.localId, c.name), as(c)), '組長以自己的 uid 填 approvedBy');
    denied(await updateDoc(pa, rejectPatch(c.localId), as(c)), '組長以自己的 uid 填 rejectedBy');
    denied(await updateDoc(pa, approvePatch(PA.localId, c.name), as(c)), '組長用 platformAdmin 的 uid 填 approvedBy');
    denied(await updateDoc(pa, rejectPatch(PA.localId), as(c)), '組長用 platformAdmin 的 uid 填 rejectedBy');
    denied(await createDoc(S.logs, `l${uniq()}`, { timestamp: iso(), actor: { uid: c.localId, email: c.email, name: c.name, role: 'section_chief', teacherId: c.localId }, action: 'approve', targetType: 'pendingRequest', targetId: 'x', details: {}, semesterId }, as(c)), '組長日誌 actor.teacherId 填自己的 uid');
    denied(await updateDoc(pa, approvePatch(t.localId, t.name), as(t)), '教師以自己的 uid 核准');
    eq((await getDoc(pa)).data.status, 'pending_approval', '申請狀態未被改');
    allowed(await updateDoc(pa, approvePatch(c.teacherId, c.name), as(c)), 'ALLOW 對照：組長以自己的 teacherId 核准');
    const pr = await seedPending(S, 'uid_b', { initiatedBy: t.teacherId });
    allowed(await updateDoc(pr, rejectPatch(c.teacherId), as(c)), 'ALLOW 對照：組長以自己的 teacherId 駁回');
});

await suite.case('PA-ROSTER ATTACK：platformAdmins 對所有 client 完全唯讀——platformAdmin 本人、主任、組長、教師、外人 create／update／delete 都 → DENY（新增、修改、撤銷皆不可）', async () => {
    const newAdmin = await createTestUser(newEmail('na'));
    const doc = { email: 'x@x.test', createdAt: iso(), note: 'attack' };
    denied(await createDoc('platformAdmins', newAdmin.localId, doc, as(PA)), 'platformAdmin 新增另一位 platformAdmin');
    denied(await createDoc('platformAdmins', newAdmin.localId, doc, as(newAdmin)), '本人自我提權');
    denied(await createDoc('platformAdmins', newAdmin.localId, doc, as(dir)), '主任新增');
    denied(await createDoc('platformAdmins', newAdmin.localId, doc, as(chief)), '組長新增');
    denied(await mergeDoc(`platformAdmins/${PA.localId}`, { note: '被改' }, as(PA)), 'platformAdmin 改自己的名冊文件');
    denied(await mergeDoc(`platformAdmins/${PA.localId}`, { note: '被改' }, as(dir)), '主任改 platformAdmin 文件');
    denied(await deleteDoc(`platformAdmins/${PA.localId}`, as(PA)), 'platformAdmin 刪除自己');
    denied(await deleteDoc(`platformAdmins/${PA.localId}`, as(dir)), '主任撤銷 platformAdmin');
    denied(await deleteDoc(`platformAdmins/${PA.localId}`, as(chief)), '組長撤銷 platformAdmin');
    denied(await deleteDoc(`platformAdmins/${PA.localId}`, as(t3)), '教師撤銷 platformAdmin');
    allowed(await getDoc(`platformAdmins/${PA.localId}`, as(PA)), '本人讀自己的名冊文件（前端判斷身分用）');
    denied(await getDoc(`platformAdmins/${PA.localId}`, as(dir)), '他人讀 platformAdmin 名冊文件');
});

await suite.case('PA-UNBLOCKABLE ALLOW 對照：學校層級擋不住 platformAdmin——主任刪光教師檔與 mapping、改掉角色、白名單清空後，platformAdmin 仍可讀寫', async () => {
    const S = await newSchool({ flag: true });
    const d = await addMember(S, { role: 'director', name: '主任', tag: 'blk' });
    const a = await addMember(S, { role: 'teacher', name: '甲', tag: 'blk2' });
    await mustSetDoc(`${S.recs}/rec_blk`, { ...recBase, semesterId });
    allowed(await deleteDoc(`${S.maps}/${a.localId}`, as(d)), '主任刪 mapping');
    allowed(await deleteDoc(S.T(a.teacherId), as(d)), '主任刪教師檔');
    allowed(await mergeDoc(S.cfg, { initialAdminEmails: [], updatedAt: iso() }, as(d)), '主任清空白名單');
    denied(await deleteDoc(`platformAdmins/${PA.localId}`, as(d)), '主任想撤銷 platformAdmin 被擋');
    allowed(await getDoc(`${S.recs}/rec_blk`, as(PA)), 'platformAdmin 仍可讀紀錄');
    allowed(await mergeDoc(S.cfg, { schoolName: '仍可改', updatedAt: iso() }, as(PA)), 'platformAdmin 仍可改 config');
    allowed(await deleteDoc(`${S.recs}/rec_blk`, as(PA)), 'platformAdmin 仍可刪紀錄（主任權限）');
});

await suite.case('PA-MEMBER ALLOW 對照：platformAdmin 同時是該校一般成員時，以 uid 或以自己的 teacherId 核准他人申請皆可；一般教師以自己 id 核准 → 仍 DENY（不是 approver）', async () => {
    const S = await newSchool({ flag: true });
    const t = await addMember(S, { role: 'teacher', name: '甲', tag: 'pm' });
    // 把種子 platformAdmin 加為該校成員（教師檔 role=teacher）
    const tid = `tch_${uniq()}`;
    await mustSetDoc(S.T(tid), { name: '平台兼教師', email: PA.email, domains: [], homeroomClass: '', role: 'teacher', createdAt: iso(), updatedAt: iso() });
    await mustSetDoc(`${S.maps}/${PA.localId}`, { linkedTeacherId: tid, email: PA.email, lastLoginAt: iso() });
    const p1 = await seedPending(S, 'pm1', { initiatedBy: t.teacherId });
    allowed(await updateDoc(p1, approvePatch(PA.localId), as(PA)), '以 uid 核准');
    const p2 = await seedPending(S, 'pm2', { initiatedBy: t.teacherId });
    allowed(await updateDoc(p2, approvePatch(tid), as(PA)), '以自己的 teacherId 核准');
    const p3 = await seedPending(S, 'pm3', { initiatedBy: PA.localId });
    denied(await updateDoc(p3, approvePatch(PA.localId), as(PA)), '核准 initiatedBy=自己 uid 的申請（SoD）');
    const p4 = await seedPending(S, 'pm4', { initiatedBy: tid });
    denied(await updateDoc(p4, approvePatch(PA.localId), as(PA)), '核准 initiatedBy=自己 teacherId 的申請（換 uid 身分也擋）');
    denied(await updateDoc(await seedPending(S, 'pm5', { initiatedBy: t.teacherId }), approvePatch(t.teacherId), as(t)), '一般教師核准（非 approver）');
});

/* ===================== SoD：核准者不可核准自己發起的申請 ===================== */

await suite.case('SOD-ATK ATTACK：組長、主任、platformAdmin 核准 initiatedBy 是自己的申請（代課，有他人牽涉）→ DENY；狀態不變', async () => {
    const S = await newSchool({ flag: true });
    const d = await addMember(S, { role: 'director', name: '主任', tag: 'sd' });
    const c = await addMember(S, { role: 'section_chief', name: '組長', tag: 'sc' });
    const pc = await seedPending(S, 'own_c', { initiatedBy: c.teacherId, initiatedByName: c.name, originalTeacherId: c.teacherId, substituteTeacherId: t1.teacherId, requiredApproverId: t1.teacherId });
    denied(await updateDoc(pc, approvePatch(c.teacherId, c.name), as(c)), '組長核准自己的申請');
    const pd = await seedPending(S, 'own_d', { initiatedBy: d.teacherId, initiatedByName: d.name, originalTeacherId: d.teacherId, substituteTeacherId: t1.teacherId });
    denied(await updateDoc(pd, approvePatch(d.teacherId, d.name), as(d)), '主任核准自己的申請');
    const pp = await seedPending(S, 'own_p', { initiatedBy: PA.localId, initiatedByName: '平台管理員', originalTeacherId: PA.localId, substituteTeacherId: t1.teacherId });
    denied(await updateDoc(pp, approvePatch(PA.localId, '平台管理員'), as(PA)), 'platformAdmin 核准自己的申請');
    eq((await getDoc(pc)).data.status, 'pending_approval', '申請仍待核准');
});

await suite.case('SOD-ATK ATTACK：自我調課例外要求「換走與換進都是本人、沒有其他人」——牽涉他人、有同意人、isSelfSwap 缺失、發起者不是原任課者，皆 → DENY', async () => {
    const S = await newSchool({ flag: true });
    const c = await addMember(S, { role: 'section_chief', name: '組長', tag: 'so' });
    const me = c.teacherId;
    const selfSwap = { type: '調課', requestType: 'swap', isSelfSwap: true, initiatedBy: me, initiatedByName: c.name, originalTeacherId: me, swapTeacherId: me, substituteTeacherId: me, requiredApproverId: null };
    const cases = [
        ['swapTeacherId 是別人', { swapTeacherId: t1.teacherId }],
        ['substituteTeacherId 是別人', { substituteTeacherId: t1.teacherId }],
        ['還有待同意人', { pendingConsentTeacherIds: [t2.teacherId] }],
        ['requiredApproverId 是別人', { requiredApproverId: t2.teacherId }],
        ['isSelfSwap 為 false（三個 id 都是自己）', { isSelfSwap: false }],
        ['originalTeacherId 是別人（代別人調自己的課）', { originalTeacherId: t1.teacherId }],
    ];
    let i = 0;
    for (const [label, over] of cases) {
        const p = await seedPending(S, `ss${++i}`, { ...selfSwap, ...over });
        denied(await updateDoc(p, approvePatch(me, c.name), as(c)), `自我調課例外不成立：${label}`);
    }
});

await suite.case('SOD-ALLOW 對照：自我調課且無他人牽涉的申請，組長／主任／platformAdmin 可核准自己的（例外）', async () => {
    const S = await newSchool({ flag: true });
    const c = await addMember(S, { role: 'section_chief', name: '組長', tag: 'sa' });
    const d = await addMember(S, { role: 'director', name: '主任', tag: 'sb' });
    const selfSwap = (id, name) => ({ type: '調課', requestType: 'swap', isSelfSwap: true, initiatedBy: id, initiatedByName: name, originalTeacherId: id, swapTeacherId: id, substituteTeacherId: id, requiredApproverId: null });
    allowed(await updateDoc(await seedPending(S, 'sa1', selfSwap(c.teacherId, c.name)), approvePatch(c.teacherId, c.name), as(c)), '組長核准自己的自我調課');
    allowed(await updateDoc(await seedPending(S, 'sa2', selfSwap(d.teacherId, d.name)), approvePatch(d.teacherId, d.name), as(d)), '主任核准自己的自我調課');
    allowed(await updateDoc(await seedPending(S, 'sa3', selfSwap(PA.localId, '平台管理員')), approvePatch(PA.localId, '平台管理員'), as(PA)), 'platformAdmin 核准自己的自我調課');
});

await suite.case('SOD-ALLOW 對照：核准別人發起的申請不受影響——教師申請、組長「代教師發起」（initiatedBy＝被代發的教師）後再核准（含同一位組長）、駁回自己的申請', async () => {
    const S = await newSchool({ flag: true });
    const c = await addMember(S, { role: 'section_chief', name: '組長', tag: 'sd1' });
    const d = await addMember(S, { role: 'director', name: '主任', tag: 'sd2' });
    const teacher = await addMember(S, { role: 'teacher', name: '乙教師', tag: 'sd3' });
    allowed(await updateDoc(await seedPending(S, 'ok1', { initiatedBy: teacher.teacherId }), approvePatch(c.teacherId, c.name), as(c)), '組長核准教師的申請');
    allowed(await updateDoc(await seedPending(S, 'ok2', { initiatedBy: teacher.teacherId }), approvePatch(d.teacherId, d.name), as(d)), '主任核准教師的申請');
    // rules v2.18 起 approver 不能再以 pending 申請代發（前端代發走 adminCreate 直接成立）；
    // 因此改以種子建立「initiatedBy＝被代發教師」的申請，驗證同一位組長仍可核准（requesterId 不是自己）。
    allowed(await updateDoc(await seedPending(S, 'proxy1', { initiatedBy: teacher.teacherId, initiatedByName: teacher.name, originalTeacherId: teacher.teacherId }), approvePatch(c.teacherId, c.name), as(c)), '組長核准 initiatedBy 為他人的申請');
    const built = { ...recBase, requestType: 'substitute', status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: {}, initiatedBy: teacher.teacherId, initiatedByName: teacher.name, originalTeacherId: teacher.teacherId, substituteTeacherId: t1.teacherId, requiredApproverId: t1.teacherId, semesterId, createdAt: iso() };
    denied(await createDoc(S.pend, 'proxy2', built, as(c)), '組長以 approver 身分建立 pending 申請（v2.18 已移除）');
    // 駁回自己發起的申請不受職務分離限制
    allowed(await updateDoc(await seedPending(S, 'rej1', { initiatedBy: c.teacherId, initiatedByName: c.name, originalTeacherId: c.teacherId }), rejectPatch(c.teacherId), as(c)), '組長駁回（等同撤回）自己的申請');
});

/* ===================== 結果 ===================== */

suite.print();
process.exit(suite.failed ? 1 : 0);
