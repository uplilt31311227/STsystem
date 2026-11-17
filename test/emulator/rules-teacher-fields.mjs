#!/usr/bin/env node
/**
 * firestore.rules v2.16（P9 批次 A）：
 *   SB-L8  主任不可刪除自己的教師檔（刪別人照舊）
 *   PL-T1  組長改教師檔的欄位白名單（domains／homeroomClass／partTime／updatedAt）；組長不可改 name／email／role／多餘欄位，
 *          不論目標是不是主任；主任與「自己改 authProvider」的既有路徑不受影響
 *   LF-L2  substituteRecords／pendingRequests 的 private/detail：approver（紀錄側限目前學期）與申請的發起人／被邀請人可刪，
 *          對應前端「先刪 private/detail 再刪父文件」的撤回／關閉駁回／刪紀錄流程
 *
 * 前端寫入路徑對照（欄位白名單的依據；改這裡前先對照原始碼）：
 *   v2-app.js 教師管理頁領域         → schoolDataService.updateTeacher(id, { domains: [...] })        + updatedAt
 *   v2-app.js 教師管理頁導師班級     → updateTeacher(id, { homeroomClass })                           + updatedAt
 *   v2-app.js 教師管理頁兼課         → updateTeacher(id, { partTime: bool })                          + updatedAt
 *   teacherAccountManager.assignEmail → updateTeacher(id, { email })        （director 專用，組長仍應被拒）
 *   teacherAccountManager.setRole     → updateTeacher(id, { role })         （director 專用，組長仍應被拒）
 *   teacherAccountManager.importRosterCsv 既有教師 → patch 為 email／role／domains／homeroomClass 的子集（director 專用）
 *   authGuardV2 自己的 authProvider   → updateTeacher(self, { authProvider })（本人分支，既有）
 *   authGuardV2 白名單主任補登 role   → updateTeacher(self, { role: 'director' })（isInitialDirector 分支，既有）
 *   備份還原教師 → batch.set 新文件（create，不經 update 規則）
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-teacher-fields.mjs（會清空並重建 emulator 資料）
 */
import {
    createDoc, updateDoc, getDoc, deleteDoc, mustSetDoc, createTestUser, commitBatch,
} from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';
import { setup, P, as, iso, buildPending } from './kit.mjs';

const W = await setup();
const { semesterId, dir, chief, t1, t2, t3 } = W;
const suite = new Suite('firestore.rules v2.16：教師檔欄位白名單（PL-T1）、主任不可刪自己（SB-L8）、private/detail 刪除（LF-L2）');
const SCHOOL = W.fixture.schoolId;
const T = (id) => `${P.teachers}/${id}`;
const PAST = '114-2';

// 每個案例各自建立被改動的目標教師檔，案例之間不共用狀態（避免前案改動影響後案或變異測試）
let tgSeq = 0;
const freshTarget = async (role = 'teacher') => {
    const id = `tch_tg${++tgSeq}`;
    await mustSetDoc(T(id), { name: role === 'director' ? '被保護的主任' : `目標${id}`, email: null, domains: [], homeroomClass: '', role, createdAt: iso(), updatedAt: iso() });
    return id;
};

/* ===================== PL-T1：組長改教師檔欄位 ===================== */

await suite.case('PL-T1 ALLOW 對照：組長改一般教師的領域（前端 domains + updatedAt 形狀）', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    allowed(await updateDoc(T(tg), { domains: ['語文', '社會'], updatedAt: iso() }, as(chief)), '組長改領域');
    allowed(await updateDoc(T(tg), { domains: [], updatedAt: iso() }, as(chief)), '組長清空領域');
});
await suite.case('PL-T1 ALLOW 對照：組長改導師班級（含清空）', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    allowed(await updateDoc(T(tg), { homeroomClass: '7年1班', updatedAt: iso() }, as(chief)), '組長設導師班級');
    allowed(await updateDoc(T(tg), { homeroomClass: '', updatedAt: iso() }, as(chief)), '組長清除導師班級');
});
await suite.case('PL-T1 ALLOW 對照：組長勾選／取消兼課', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    allowed(await updateDoc(T(tg), { partTime: true, updatedAt: iso() }, as(chief)), '組長勾兼課');
    allowed(await updateDoc(T(tg), { partTime: false, updatedAt: iso() }, as(chief)), '組長取消兼課');
});
await suite.case('PL-T1 ALLOW 對照：組長改主任教師檔的領域／導師班級／兼課（教師管理頁允許，不屬於 name／role）', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    allowed(await updateDoc(T(tgDir), { domains: ['教務'], updatedAt: iso() }, as(chief)), '組長改主任領域');
    allowed(await updateDoc(T(tgDir), { homeroomClass: '', updatedAt: iso() }, as(chief)), '組長改主任導師班級');
    allowed(await updateDoc(T(tgDir), { partTime: false, updatedAt: iso() }, as(chief)), '組長改主任兼課');
});
await suite.case('PL-T1 ALLOW 對照：組長改自己的領域；一般教師仍可改自己的 authProvider（本人分支不變）', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    allowed(await updateDoc(T(chief.teacherId), { domains: ['自然'], updatedAt: iso() }, as(chief)), '組長改自己領域');
    allowed(await updateDoc(T(t3.teacherId), { authProvider: 'google.com', updatedAt: iso() }, as(t3)), '教師改自己 authProvider');
});

await suite.case('PL-T1 ATTACK：組長改主任的 name → DENY（SF-H2 的 source）；改一般教師的 name 也 DENY', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    denied(await updateDoc(T(tgDir), { name: '<img src=x onerror=alert(1)>', updatedAt: iso() }, as(chief)), '組長改主任 name（惡意字串）');
    denied(await updateDoc(T(tgDir), { name: '另一個名字' }, as(chief)), '組長改主任 name（良性字串，與現值不同）');
    denied(await updateDoc(T(tg), { name: '改名', updatedAt: iso() }, as(chief)), '組長改一般教師 name');
    eq((await getDoc(T(tgDir))).data.name, '被保護的主任', '主任姓名未被改動');
});
await suite.case('PL-T1 ATTACK：組長改 role／email → DENY（既有限制不退步）', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    denied(await updateDoc(T(tg), { role: 'director', updatedAt: iso() }, as(chief)), '組長把教師升主任');
    denied(await updateDoc(T(tgDir), { role: 'teacher', updatedAt: iso() }, as(chief)), '組長把主任降教師');
    denied(await updateDoc(T(tg), { email: 'evil@x.test', updatedAt: iso() }, as(chief)), '組長改 email');
});
await suite.case('PL-T1 ATTACK：組長夾帶多餘欄位或改稽核欄位 → DENY（teacherId／createdAt／authProvider／任意欄位）', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    denied(await updateDoc(T(tg), { teacherId: 'tch_other', updatedAt: iso() }, as(chief)), '寫 teacherId');
    denied(await updateDoc(T(tg), { createdAt: iso(), updatedAt: iso() }, as(chief)), '改 createdAt');
    denied(await updateDoc(T(tg), { authProvider: 'google.com', updatedAt: iso() }, as(chief)), '組長代改他人 authProvider');
    denied(await updateDoc(T(tg), { evil: 'x', updatedAt: iso() }, as(chief)), '任意多餘欄位');
    denied(await updateDoc(T(tg), { domains: ['語文'], evil: 'x', updatedAt: iso() }, as(chief)), '合法欄位夾帶多餘欄位');
});
await suite.case('PL-T1 ATTACK：組長寫入型別錯誤／超長／含 HTML 字元 → DENY', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    denied(await updateDoc(T(tg), { domains: ['<script>'], updatedAt: iso() }, as(chief)), 'domains 含 <');
    denied(await updateDoc(T(tg), { domains: Array.from({ length: 25 }, (_, i) => `領域${i}`), updatedAt: iso() }, as(chief)), 'domains 超過 20 項');
    denied(await updateDoc(T(tg), { domains: ['x'.repeat(401)], updatedAt: iso() }, as(chief)), 'domains 合計超過 400 字');
    denied(await updateDoc(T(tg), { domains: Array.from({ length: 10 }, () => 'y'.repeat(45)), updatedAt: iso() }, as(chief)), 'domains 10 項各 45 字（合計 450）');
    denied(await updateDoc(T(tg), { domains: 'not-a-list', updatedAt: iso() }, as(chief)), 'domains 非 list');
    denied(await updateDoc(T(tg), { homeroomClass: 'x'.repeat(31), updatedAt: iso() }, as(chief)), 'homeroomClass 超過 30 字');
    denied(await updateDoc(T(tg), { homeroomClass: '7年<1>班', updatedAt: iso() }, as(chief)), 'homeroomClass 含 <>');
    denied(await updateDoc(T(tg), { homeroomClass: 7, updatedAt: iso() }, as(chief)), 'homeroomClass 非字串');
    denied(await updateDoc(T(tg), { partTime: 'yes', updatedAt: iso() }, as(chief)), 'partTime 非布林');
    denied(await updateDoc(T(tg), { partTime: true, updatedAt: '9999-01-01T00:00:00.000Z' }, as(chief)), 'updatedAt 未來時間');
    denied(await updateDoc(T(tg), { partTime: true, updatedAt: 'yesterday' }, as(chief)), 'updatedAt 非 ISO');
});
await suite.case('PL-T1 ATTACK：一般教師改別人（含主任）的教師檔／改自己的 domains → DENY（不因本次修改放寬）', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    denied(await updateDoc(T(tgDir), { domains: ['x'], updatedAt: iso() }, as(t3)), '教師改主任領域');
    denied(await updateDoc(T(tg), { name: 'x', updatedAt: iso() }, as(t3)), '教師改他人 name');
    denied(await updateDoc(T(t3.teacherId), { domains: ['x'], updatedAt: iso() }, as(t3)), '教師改自己 domains（僅 authProvider 開放）');
});

/* ----- 主任不縮減：director 分支沿用既有行為 ----- */
await suite.case('PL-T1 ALLOW 對照（主任不縮減）：主任可改任何教師的 name／email／domains／role（改別人）；改自己 name 亦可', async () => {
    const tg = await freshTarget(); const tgDir = await freshTarget('director');
    allowed(await updateDoc(T(tg), { name: '改名後', updatedAt: iso() }, as(dir)), '主任改別人 name');
    allowed(await updateDoc(T(tg), { email: 'fresh@alpha.demo.test', updatedAt: iso() }, as(dir)), '主任寫 email（assignEmail 形狀）');
    allowed(await updateDoc(T(tg), { domains: ['數學', '自然'], homeroomClass: '8年1班', partTime: false, updatedAt: iso() }, as(dir)), '主任匯入名冊形狀（多欄位）');
    allowed(await updateDoc(T(tg), { role: 'section_chief', updatedAt: iso() }, as(dir)), '主任改別人 role（setRole 形狀）');
    allowed(await updateDoc(T(tg), { role: 'teacher', updatedAt: iso() }, as(dir)), '主任改回 role');
    allowed(await updateDoc(T(dir.teacherId), { name: dir.name, domains: ['教務'], updatedAt: iso() }, as(dir)), '主任改自己的 name／domains');
});

/* ----- 備份還原：新文件走 create，不受 update 白名單影響 ----- */
await suite.case('PL-T1 ALLOW 對照：備份還原教師檔（主任 batch.set 新文件，帶 createdAt／authProvider／partTime 等全部欄位）', async () => {
    const docs = ['tch_restore_a', 'tch_restore_b'];
    const res = await commitBatch(docs.map(id => ({
        set: T(id),
        data: { name: `還原${id}`, email: null, domains: ['語文'], homeroomClass: '', role: 'teacher', partTime: true, authProvider: 'password', createdAt: iso(), updatedAt: iso() },
    })), as(dir));
    allowed(res, '主任還原教師名冊 batch');
});

/* ===================== SB-L8：主任不可刪自己的教師檔 ===================== */

const seedTeacher = async (id, role = 'teacher', email = null) =>
    mustSetDoc(T(id), { name: `測試${id}`, email, domains: [], homeroomClass: '', role, createdAt: iso(), updatedAt: iso() });

await suite.case('SB-L8 ATTACK：主任刪自己的教師檔 → DENY（單刪與前端 deleteTeacher 的 batch 形狀都擋；文件仍在）', async () => {
    denied(await deleteDoc(T(dir.teacherId), as(dir)), '主任單刪自己');
    denied(await commitBatch([{ delete: T(dir.teacherId) }, { delete: `${P.emailIdx}/${dir.email}` }], as(dir)), '主任 batch 刪自己＋emailIndex');
    eq((await getDoc(T(dir.teacherId))).ok, true, '主任教師檔仍在');
    eq((await getDoc(`${P.emailIdx}/${dir.email}`)).ok, true, 'emailIndex 仍在');
});
await suite.case('SB-L8 ALLOW 對照：主任刪別人（單刪；以及前端 deleteTeacher 的 batch：教師檔＋emailIndex）', async () => {
    await seedTeacher('tch_del_a');
    allowed(await deleteDoc(T('tch_del_a'), as(dir)), '主任刪別人');
    await seedTeacher('tch_del_b', 'teacher', 'del_b@alpha.demo.test');
    await mustSetDoc(`${P.emailIdx}/del_b@alpha.demo.test`, { teacherId: 'tch_del_b' });
    allowed(await commitBatch([{ delete: T('tch_del_b') }, { delete: `${P.emailIdx}/del_b@alpha.demo.test` }], as(dir)), '主任 batch 刪別人＋emailIndex');
    eq((await getDoc(T('tch_del_b'))).ok, false, '已刪除');
});
await suite.case('SB-L8 ALLOW 對照：第二位主任可刪另一位主任檔，但刪不了自己', async () => {
    const email2 = 'dir2@alpha.demo.test';
    const dir2 = await createTestUser(email2);
    await mustSetDoc(T('tch_dir2'), { name: '第二主任', email: email2, domains: [], homeroomClass: '', role: 'director', createdAt: iso(), updatedAt: iso() });
    await mustSetDoc(`${P.emailIdx}/${email2}`, { teacherId: 'tch_dir2' });
    await mustSetDoc(`${P.mappings}/${dir2.localId}`, { linkedTeacherId: 'tch_dir2', email: email2, googleName: null, googlePhotoUrl: null, lastProviderId: 'password', lastLoginAt: iso() });
    await seedTeacher('tch_dir_victim', 'director');
    denied(await deleteDoc(T('tch_dir2'), as(dir2)), '第二主任刪自己');
    allowed(await deleteDoc(T('tch_dir_victim'), as(dir2)), '第二主任刪另一位主任檔');
});
await suite.case('SB-L8 ALLOW 對照：白名單主任（尚無 mapping、教師檔）刪別人 → ALLOW（myTeacherId 為空字串，不被自刪限制誤擋）', async () => {
    const boss = 'boss2@alpha.demo.test';
    const cfg = (await getDoc(P.config)).data;
    await mustSetDoc(P.config, { ...cfg, initialAdminEmails: [...cfg.initialAdminEmails, boss] });
    const u = await createTestUser(boss);
    await seedTeacher('tch_del_boss_victim');
    allowed(await deleteDoc(T('tch_del_boss_victim'), as(u)), '白名單主任（無 mapping）刪別人');
});
await suite.case('SB-L8 ATTACK：組長與一般教師刪教師檔 → DENY（既有限制不退步）', async () => {
    await seedTeacher('tch_del_c');
    denied(await deleteDoc(T('tch_del_c'), as(chief)), '組長刪教師');
    denied(await deleteDoc(T(t3.teacherId), as(t3)), '教師刪自己');
    eq((await getDoc(T('tch_del_c'))).ok, true, '仍在');
});

/* ===================== LF-L2：private/detail 刪除 ===================== */

const recBase = { date: '2026-11-17', weekday: '週二', period: '第三節', className: '7年1班', type: '代課', originalTeacher: '甲', substituteTeacher: '乙', status: 'approved', createdAt: '2026-11-07T00:00:00.000Z' };
const REC = (id) => `${P.records}/${id}`;
const PEND = (id) => `${P.pending}/${id}`;
const seedRecord = async (id, extra = {}) => {
    await mustSetDoc(REC(id), { ...recBase, ...extra });
    await mustSetDoc(`${REC(id)}/private/detail`, { leaveType: '事假', leaveTypeName: '事假', reason: '家中有事', allowedTeacherIds: [t1.teacherId] });
};
const seedPend = async (id, extra = {}) => {
    await seedPendingDoc(id, extra);
    await mustSetDoc(`${PEND(id)}/private/detail`, { leaveType: '事假', leaveTypeName: '事假', reason: '家中有事', allowedTeacherIds: [t1.teacherId, t2.teacherId] });
};
const seedPendingDoc = async (id, extra = {}) => mustSetDoc(PEND(id), {
    ...recBase, requestType: 'substitute', status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: {},
    initiatedBy: t1.teacherId, initiatedByName: t1.name, requiredApproverId: t2.teacherId, semesterId, createdAt: iso(), ...extra,
});
const detailExists = async (parent) => (await getDoc(`${parent}/private/detail`)).ok;

await suite.case('LF-L2 ALLOW 對照（紀錄）：組長刪目前學期紀錄＝先刪 private/detail、再刪父文件（adminDeleteRecord 流程）', async () => {
    await seedRecord('lf_rec_cur', { semesterId });
    allowed(await deleteDoc(`${REC('lf_rec_cur')}/private/detail`, as(chief)), '組長刪 private/detail');
    allowed(await deleteDoc(REC('lf_rec_cur'), as(chief)), '組長刪父文件');
    eq(await detailExists(REC('lf_rec_cur')), false, 'private/detail 已清除（無孤兒）');
    await seedRecord('lf_rec_legacy', {});
    allowed(await deleteDoc(`${REC('lf_rec_legacy')}/private/detail`, as(chief)), '組長刪無 semesterId 舊紀錄的 private/detail');
});
await suite.case('LF-L2 ALLOW 對照（紀錄）：沒有 private/detail 的紀錄，刪不存在的 private/detail 為 no-op，不影響後續刪父文件', async () => {
    await mustSetDoc(REC('lf_rec_nodetail'), { ...recBase, semesterId });
    allowed(await deleteDoc(`${REC('lf_rec_nodetail')}/private/detail`, as(chief)), '刪不存在的 private/detail');
    allowed(await deleteDoc(REC('lf_rec_nodetail'), as(chief)), '刪父文件');
});
await suite.case('LF-L2 ALLOW 對照（紀錄）：主任刪歷史學期紀錄的 private/detail（維持原行為）；組長清理父文件已不存在的孤兒 detail', async () => {
    await seedRecord('lf_rec_past_dir', { semesterId: PAST });
    allowed(await deleteDoc(`${REC('lf_rec_past_dir')}/private/detail`, as(dir)), '主任刪歷史 private/detail');
    await mustSetDoc(`${REC('lf_rec_orphan')}/private/detail`, { leaveType: '事假', leaveTypeName: '事假', reason: 'x', allowedTeacherIds: [t1.teacherId] });
    eq((await getDoc(REC('lf_rec_orphan'))).ok, false, '前置：父文件不存在');
    allowed(await deleteDoc(`${REC('lf_rec_orphan')}/private/detail`, as(chief)), '組長清孤兒 detail');
});
await suite.case('LF-L2 ATTACK（紀錄）：組長刪歷史學期紀錄的 private/detail → DENY（假別影響結算）；一般教師刪 → DENY；docId 非 detail → DENY', async () => {
    await seedRecord('lf_rec_past', { semesterId: PAST });
    denied(await deleteDoc(`${REC('lf_rec_past')}/private/detail`, as(chief)), '組長刪歷史 private/detail');
    await seedRecord('lf_rec_cur2', { semesterId });
    denied(await deleteDoc(`${REC('lf_rec_cur2')}/private/detail`, as(t3)), '一般教師刪');
    denied(await deleteDoc(`${REC('lf_rec_cur2')}/private/detail`, as(t1)), '當事人教師刪自己的 detail 也不行（紀錄側僅 approver）');
    await mustSetDoc(`${REC('lf_rec_cur2')}/private/other`, { leaveType: '事假', allowedTeacherIds: [] });
    denied(await deleteDoc(`${REC('lf_rec_cur2')}/private/other`, as(chief)), '組長刪非 detail 子文件');
    eq(await detailExists(REC('lf_rec_past')), true, '歷史 detail 仍在');
    eq(await detailExists(REC('lf_rec_cur2')), true, '當前 detail 仍在');
});

await suite.case('LF-L2 ALLOW 對照（申請）：發起人撤回＝先刪 private/detail、再刪父文件（待核准與待同意兩種）', async () => {
    await seedPend('lf_pend_a');
    allowed(await deleteDoc(`${PEND('lf_pend_a')}/private/detail`, as(t1)), '發起人刪 private/detail');
    allowed(await deleteDoc(PEND('lf_pend_a'), as(t1)), '發起人刪父文件');
    eq(await detailExists(PEND('lf_pend_a')), false, '無孤兒');
    await seedPend('lf_pend_swap', { requestType: 'swap', status: 'pending_swap_consent', pendingConsentTeacherIds: [t2.teacherId] });
    allowed(await deleteDoc(`${PEND('lf_pend_swap')}/private/detail`, as(t1)), '發起人撤回待同意調課的 private/detail');
});
await suite.case('LF-L2 ALLOW 對照（申請）：發起人關閉已駁回通知（rejected）、組長刪任何申請的 private/detail', async () => {
    await seedPend('lf_pend_rej', { status: 'rejected', rejectedBy: chief.teacherId, rejectReason: 'x' });
    allowed(await deleteDoc(`${PEND('lf_pend_rej')}/private/detail`, as(t1)), '發起人關閉駁回通知前刪 private/detail');
    await seedPend('lf_pend_chief', {});
    allowed(await deleteDoc(`${PEND('lf_pend_chief')}/private/detail`, as(chief)), '組長刪');
});
await suite.case('LF-L2 ATTACK（申請）：被邀請人（requiredApproverId，代課教師）刪待核准申請的假別明細 → DENY（前端 canCancelRequest 不給被邀請人；刪了會讓核准時假別遺失）', async () => {
    await seedPend('lf_pend_invitee', {});
    denied(await deleteDoc(`${PEND('lf_pend_invitee')}/private/detail`, as(t2)), '被邀請人刪明細');
    await seedPend('lf_pend_invitee2', { requestType: 'swap', status: 'pending_swap_consent', pendingConsentTeacherIds: [t2.teacherId], requiredApproverId: t2.teacherId });
    denied(await deleteDoc(`${PEND('lf_pend_invitee2')}/private/detail`, as(t2)), '待同意的被邀請人刪明細');
    eq(await detailExists(PEND('lf_pend_invitee')), true, '明細仍在');
});
await suite.case('LF-L2 ATTACK（申請）：教師刪「孤兒」申請明細（父文件不存在）→ DENY；組長可清', async () => {
    await mustSetDoc(`${PEND('lf_pend_orphan')}/private/detail`, { leaveType: '事假', leaveTypeName: '事假', reason: 'x', allowedTeacherIds: [t1.teacherId, t3.teacherId] });
    eq((await getDoc(PEND('lf_pend_orphan'))).ok, false, '前置：父文件不存在');
    denied(await deleteDoc(`${PEND('lf_pend_orphan')}/private/detail`, as(t1)), '一般教師（含當事人）刪孤兒明細');
    denied(await deleteDoc(`${PEND('lf_pend_orphan')}/private/detail`, as(t3)), '另一位當事人刪孤兒明細');
    allowed(await deleteDoc(`${PEND('lf_pend_orphan')}/private/detail`, as(chief)), '組長清孤兒明細');
});
await suite.case('hasDetail 欄位：前端建立申請（帶 hasDetail:true）ALLOW；hasDetail 非 bool → DENY', async () => {
    const built = buildPending(W, t1);
    allowed(await createDoc(`${PEND(built.reqId)}/private`, 'detail', built.privateDoc, as(t1)), '先寫 private');
    allowed(await createDoc(P.pending, built.reqId, { ...built.publicDoc, hasDetail: true }, as(t1)), '父文件帶 hasDetail:true');
    const b2 = buildPending(W, t1);
    allowed(await createDoc(`${PEND(b2.reqId)}/private`, 'detail', b2.privateDoc, as(t1)), '先寫 private');
    denied(await createDoc(P.pending, b2.reqId, { ...b2.publicDoc, hasDetail: 'yes' }, as(t1)), 'hasDetail 非 bool');
});
await suite.case('LF-L2 ATTACK（申請）：無關教師刪別人申請的 private/detail → DENY；發起人刪已核准申請的 private/detail → DENY', async () => {
    await seedPend('lf_pend_x', {});
    denied(await deleteDoc(`${PEND('lf_pend_x')}/private/detail`, as(t3)), '無關教師刪');
    await seedPend('lf_pend_done', { status: 'approved', approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: iso() });
    denied(await deleteDoc(`${PEND('lf_pend_done')}/private/detail`, as(t1)), '發起人刪已核准申請的 detail（審核軌跡）');
    denied(await deleteDoc(`${PEND('lf_pend_x')}/private/other`, as(t1)), '發起人刪非 detail 子文件');
    eq(await detailExists(PEND('lf_pend_x')), true, 'detail 仍在');
    eq(await detailExists(PEND('lf_pend_done')), true, '已核准申請 detail 仍在');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
