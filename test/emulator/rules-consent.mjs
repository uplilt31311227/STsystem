#!/usr/bin/env node
/**
 * firestore.rules v2.12：同意流程防偽造（項目 3／M1）與申請刪除時機（L3）
 *
 * 多重調課的同意人原本可以：清空整份待同意名單、替他人偽造 swapConsents、直接把狀態推到待核准。
 * 修補後同意相關欄位的 update 只允許變動「自己」那一筆；approver 也不能碰同意名單與同意紀錄。
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-consent.mjs（會清空並重建 emulator 資料）
 */
import { createDoc, updateDoc, getDoc, deleteDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';
import { setup, P, as, iso, DAY, seedPending } from './kit.mjs';

const W = await setup();
const { semesterId, dir, chief, t1, t2, t3, t4 } = W;
const suite = new Suite('firestore.rules v2.12：同意人只能變動自己那一筆（M1）／申請刪除時機（L3）');
let seq = 0;
const path = (id) => `${P.pending}/${id}`;

/** 一筆由 t1 發起、待 t2／t3／t4 全員同意的多重調課（owner 直接寫入，當成既有申請）。 */
async function multi(consenters = [t2, t3, t4]) {
    const id = `zz_multi_${++seq}`;
    await seedPending(id, {
        requestType: 'multi_swap', status: 'pending_swap_consent',
        pendingConsentTeacherIds: consenters.map(t => t.teacherId),
        initiatedBy: t1.teacherId, initiatedByName: t1.name, originalTeacherId: t1.teacherId, semesterId,
    });
    return id;
}
const consentPatch = (user, remaining, existing = {}, status = 'pending_swap_consent') => ({
    pendingConsentTeacherIds: remaining,
    swapConsents: { ...existing, [user.teacherId]: { consentedAt: iso() } },
    status, statusUpdatedAt: iso(),
});

await suite.case('3-a 同意人清空他人名單並替他人偽造同意、直接推到待核准 → DENY（攻擊原文）', async () => {
    const id = await multi();
    denied(await updateDoc(path(id), {
        pendingConsentTeacherIds: [],
        swapConsents: { [t2.teacherId]: { consentedAt: iso() }, [t3.teacherId]: { consentedAt: iso() }, [t4.teacherId]: { consentedAt: iso() } },
        status: 'pending_approval', statusUpdatedAt: iso(),
    }, as(t2)), '清空名單＋偽造全員同意');
    eq((await getDoc(path(id))).data.status, 'pending_swap_consent', '申請狀態未被改動');
});
await suite.case('3-b 同意人替「其他人」移出名單／偽造他人那一筆 → DENY', async () => {
    const id = await multi();
    denied(await updateDoc(path(id), consentPatch(t2, [t4.teacherId]), as(t2)), '把自己與 t3 一起移出名單');
    denied(await updateDoc(path(id), {
        pendingConsentTeacherIds: [t3.teacherId, t4.teacherId],
        swapConsents: { [t2.teacherId]: { consentedAt: iso() }, [t3.teacherId]: { consentedAt: iso() } },
        status: 'pending_swap_consent', statusUpdatedAt: iso(),
    }, as(t2)), '只移出自己，但替 t3 偽造同意');
    denied(await updateDoc(path(id), {
        pendingConsentTeacherIds: [t2.teacherId, t3.teacherId, t4.teacherId],
        swapConsents: { [t3.teacherId]: { consentedAt: iso() } },
        status: 'pending_swap_consent', statusUpdatedAt: iso(),
    }, as(t2)), '只偽造他人同意、不移出自己');
    denied(await updateDoc(path(id), consentPatch(t2, [t3.teacherId, t4.teacherId], {}, 'pending_approval'), as(t2)), '名單未清空卻把狀態推到 pending_approval');
    denied(await updateDoc(path(id), consentPatch(t2, [t3.teacherId, t4.teacherId, t1.teacherId]), as(t2)), '往名單塞入新的人');
});
await suite.case('3-c 同意人把狀態改成 approved、改動申請內容欄位、時間戳為未來 → DENY', async () => {
    const id = await multi();
    denied(await updateDoc(path(id), { ...consentPatch(t2, [t3.teacherId, t4.teacherId]), status: 'approved' }, as(t2)), 'status=approved');
    denied(await updateDoc(path(id), { ...consentPatch(t2, [t3.teacherId, t4.teacherId]), className: '9年9班' }, as(t2)), '夾帶申請內容欄位');
    denied(await updateDoc(path(id), { ...consentPatch(t2, [t3.teacherId, t4.teacherId]), statusUpdatedAt: '9999-12-31T00:00:00.000Z' }, as(t2)), '未來時間戳');
});
await suite.case('3-d 同意人拒絕時不得順手動同意名單；非名單成員（含發起人本人）不可同意 → DENY', async () => {
    const id = await multi();
    const rej = (u, extra = {}) => ({ status: 'rejected', rejectedAt: iso(), rejectedBy: u.teacherId, rejectedByName: u.name, rejectNote: '不方便', statusUpdatedAt: iso(), ...extra });
    denied(await updateDoc(path(id), rej(t2, { pendingConsentTeacherIds: [] }), as(t2)), '拒絕＋清空名單');
    denied(await updateDoc(path(id), rej(t2, { rejectedBy: t3.teacherId }), as(t2)), '拒絕但署名他人');
    denied(await updateDoc(path(id), consentPatch(t1, [t2.teacherId, t3.teacherId, t4.teacherId]), as(t1)), '發起人自我同意');
    denied(await updateDoc(path(id), consentPatch(W.seed.alpha.teachers[6], [t2.teacherId, t3.teacherId, t4.teacherId]), as(W.seed.alpha.teachers[6])), '無關教師同意');
});
await suite.case('3-e 正常流程：同意人逐一同意（只動自己）→ 全員同意後轉待核准；同意人拒絕 → 已駁回（ALLOW）', async () => {
    const id = await multi();
    allowed(await updateDoc(path(id), consentPatch(t3, [t2.teacherId, t4.teacherId]), as(t3)), 't3 同意');
    let d = (await getDoc(path(id))).data;
    allowed(await updateDoc(path(id), consentPatch(t2, [t4.teacherId], d.swapConsents), as(t2)), 't2 同意');
    d = (await getDoc(path(id))).data;
    eq(d.status, 'pending_swap_consent', '尚有 t4 未同意，狀態不變');
    allowed(await updateDoc(path(id), consentPatch(t4, [], d.swapConsents, 'pending_approval'), as(t4)), '最後一位同意 → 轉待核准');
    eq((await getDoc(path(id))).data.status, 'pending_approval', '轉待核准');
    // 結案後同意人不能再動
    denied(await updateDoc(path(id), { status: 'rejected', rejectedAt: iso(), rejectedBy: t2.teacherId, statusUpdatedAt: iso() }, as(t2)), '待核准後同意人不得再駁回（終態鎖）');

    const id2 = await multi();
    allowed(await updateDoc(path(id2), { status: 'rejected', rejectedAt: iso(), rejectedBy: t3.teacherId, rejectedByName: t3.name, rejectNote: '不方便', statusUpdatedAt: iso() }, as(t3)), 't3 拒絕');
    eq((await getDoc(path(id2))).data.status, 'rejected', '已駁回');
});
await suite.case('3-f approver 不得繞過同意階段：組長直接清空名單／推到 pending_approval／在同意階段核准 → DENY；正常核准與駁回 → ALLOW', async () => {
    const id = await multi();
    denied(await updateDoc(path(id), { pendingConsentTeacherIds: [], status: 'pending_approval', statusUpdatedAt: iso() }, as(chief)), '組長清空名單');
    denied(await updateDoc(path(id), { swapConsents: { [t2.teacherId]: { consentedAt: iso() } } }, as(chief)), '組長偽造同意紀錄');
    denied(await updateDoc(path(id), { status: 'approved', approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: iso(), statusUpdatedAt: iso() }, as(chief)), '同意階段直接核准');
    allowed(await updateDoc(path(id), { status: 'rejected', rejectedAt: iso(), rejectedBy: chief.teacherId, rejectedByName: chief.name, rejectNote: '駁回', statusUpdatedAt: iso() }, as(chief)), '組長在同意階段駁回');

    const id2 = `zz_ready_${++seq}`;
    await seedPending(id2, { requestType: 'swap', status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: { [t2.teacherId]: { consentedAt: iso() } }, initiatedBy: t1.teacherId, semesterId });
    denied(await updateDoc(path(id2), { status: 'approved', approvedBy: dir.teacherId, approvedByName: dir.name, approvedAt: iso(), statusUpdatedAt: iso() }, as(chief)), '核准者署名他人');
    allowed(await updateDoc(path(id2), { status: 'approved', approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: iso(), statusUpdatedAt: iso() }, as(chief)), '組長正常核准');
    denied(await updateDoc(path(id2), { status: 'rejected', rejectedAt: iso(), rejectedBy: dir.teacherId, statusUpdatedAt: iso() }, as(dir)), '已核准不可再改駁回（終態鎖）');
});
await suite.case('L3 刪除時機：發起人可撤回在途申請與關閉駁回通知，但不可刪除已核准的申請（審核軌跡）；approver 可刪', async () => {
    const mk = async (status) => { const id = `zz_del_${++seq}`; await seedPending(id, { requestType: 'substitute', status, pendingConsentTeacherIds: [], initiatedBy: t1.teacherId, semesterId }); return id; };
    allowed(await deleteDoc(path(await mk('pending_approval')), as(t1)), '發起人撤回待核准');
    allowed(await deleteDoc(path(await mk('rejected')), as(t1)), '發起人關閉已駁回');
    const approvedId = await mk('approved');
    denied(await deleteDoc(path(approvedId), as(t1)), '發起人刪除已核准申請');
    denied(await deleteDoc(path(approvedId), as(t2)), '他人刪除已核准申請');
    allowed(await deleteDoc(path(approvedId), as(chief)), '組長可刪（approver 既有權限）');
    const other = await mk('pending_approval');
    denied(await deleteDoc(path(other), as(t2)), '無關教師刪除他人申請');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
