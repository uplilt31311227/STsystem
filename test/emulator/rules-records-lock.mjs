#!/usr/bin/env node
/**
 * firestore.rules v2.14：成立紀錄序號鎖（config/recordsLock，P6）
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-records-lock.mjs（會清空並重建 emulator 資料）
 * 驗證：approver 可建立（seq=1）與逐次加 1；不可跳號、回退、重複；欄位白名單；一般教師與外人不可寫；
 *       與紀錄建立放在同一次提交（交易）時，規則文件存取數仍在上限內（核准形狀：改申請＋建紀錄＋寫鎖；批次：6 筆紀錄＋寫鎖）。
 */
import { seedAll } from './seed.mjs';
import { signIn, getDoc, updateDoc, setDoc, commitBatch, mustSetDoc, createDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';

const SCHOOL = 'demo-alpha';
const LOCK = `schools/${SCHOOL}/config/recordsLock`;
const REC = (id) => `schools/${SCHOOL}/substituteRecords/${id}`;
const iso = () => new Date().toISOString();

const seed = await seedAll({ quiet: true });
const current = (await getDoc(`schools/${SCHOOL}/config/main`)).data.currentSemester;
const chief   = await signIn('t02@alpha.demo.test');
const dir     = await signIn('t01@alpha.demo.test');
const teacher = await signIn('t03@alpha.demo.test');
const as = (s) => ({ idToken: s.idToken });

const suite = new Suite(`firestore.rules v2.14：成立紀錄序號鎖（目前學期 ${current}）`);
const rec = (over = {}) => ({
    id: 'zz_lock', type: '代課', date: '2026-12-01', weekday: '週二', period: '第三節', className: '801', subject: '數學',
    originalTeacher: '甲', substituteTeacher: '乙', status: 'approved', semesterId: current,
    createdAt: iso(), approvedAt: iso(), ...over,
});

await suite.case('組長建立 recordsLock（seq=1）→ ALLOW', async () => {
    allowed(await setDoc(LOCK, { seq: 1, updatedAt: iso() }, as(chief)), '建立 seq=1');
    eq((await getDoc(LOCK)).data.seq, 1, 'seq');
});
await suite.case('組長把 seq 加 1 → ALLOW', async () => {
    allowed(await setDoc(LOCK, { seq: 2, updatedAt: iso() }, as(chief)), 'seq 1→2');
});
await suite.case('跳號（2→4）→ DENY', async () => {
    denied(await setDoc(LOCK, { seq: 4, updatedAt: iso() }, as(chief)), '跳號');
});
await suite.case('回退（2→1）→ DENY', async () => {
    denied(await setDoc(LOCK, { seq: 1, updatedAt: iso() }, as(chief)), '回退');
});
await suite.case('原值重寫（2→2）→ DENY', async () => {
    denied(await setDoc(LOCK, { seq: 2, updatedAt: iso() }, as(chief)), '不變');
});
await suite.case('多餘欄位、seq 非整數、缺 updatedAt → DENY', async () => {
    denied(await setDoc(LOCK, { seq: 3, updatedAt: iso(), extra: 'x' }, as(chief)), '多餘欄位');
    denied(await setDoc(LOCK, { seq: 3.5, updatedAt: iso() }, as(chief)), '非整數');
    denied(await setDoc(LOCK, { seq: '3', updatedAt: iso() }, as(chief)), '字串');
    denied(await setDoc(LOCK, { seq: 3 }, as(chief)), '缺 updatedAt');
});
await suite.case('一般教師寫入 recordsLock → DENY；刪除 → DENY', async () => {
    denied(await setDoc(LOCK, { seq: 3, updatedAt: iso() }, as(teacher)), '教師寫');
    const del = await fetch(`http://127.0.0.1:8080/v1/projects/demo-stsystem/databases/(default)/documents/${LOCK}`, { method: 'DELETE', headers: { Authorization: `Bearer ${teacher.idToken}` } });
    eq(del.ok, false, '教師刪除');
});
await suite.case('讀取：一般成員可讀（不含敏感資料）', async () => {
    allowed(await getDoc(LOCK, as(teacher)), '教師讀鎖');
});
await suite.case('先建立鎖再用主任遞增 → ALLOW（主任同樣受 +1 約束於組長路徑；主任走 director 既有規則）', async () => {
    allowed(await setDoc(LOCK, { seq: 3, updatedAt: iso() }, as(dir)), '主任 3');
});

// ---- 與紀錄建立放在同一次提交（交易形狀）：規則文件存取數不得超限 ----
const root = `projects/demo-stsystem/databases/(default)/documents`;
await suite.case('核准形狀：同一次提交 改申請＋建立紀錄＋寫序號鎖 → ALLOW（文件存取在上限內）', async () => {
    const reqPath = `schools/${SCHOOL}/pendingRequests/zz_lock_req`;
    const reqDoc = { type: '代課', requestType: 'substitute', status: 'pending_approval', date: '2026-12-01', weekday: '週二', period: '第三節',
        className: '801', subject: '數學', originalTeacher: '甲', substituteTeacher: '乙', initiatedBy: 'x', pendingConsentTeacherIds: [], swapConsents: {},
        semesterId: current, createdAt: iso() };
    await mustSetDoc(reqPath, reqDoc);
    const cur = (await getDoc(LOCK)).data.seq;
    const now = iso();
    const me = seed.alpha.sectionChief;
    const res = await commitBatch([
        { set: reqPath, data: { ...reqDoc, status: 'approved', approvedAt: now, approvedBy: me.teacherId, approvedByName: me.name, statusUpdatedAt: now } },
        { set: `schools/${SCHOOL}/substituteRecords/zz_lock_a`, data: rec({ fromRequestId: 'zz_lock_req', approvedBy: chief.localId }) },
        { set: LOCK, data: { seq: cur + 1, updatedAt: now } },
    ], as(chief));
    allowed(res, '建立紀錄＋寫鎖');
});
await suite.case('批次形狀：同一次提交 6 筆紀錄＋寫序號鎖 → ALLOW', async () => {
    const cur = (await getDoc(LOCK)).data.seq;
    const writes = [1, 2, 3, 4, 5, 6].map(i => ({ set: REC(`zz_lock_b${i}`), data: rec({ id: `zz_lock_b${i}`, type: '調課', swapDate: '2026-12-08', swapPeriod: '第二節', swapTeacher: '乙', batchId: 'zzbatch', batchSize: 6 }) }));
    writes.push({ set: LOCK, data: { seq: cur + 1, updatedAt: iso() } });
    allowed(await commitBatch(writes, as(chief)), '6 筆＋鎖');
    eq((await getDoc(LOCK)).data.seq, cur + 1, '序號只加 1');
});
await suite.case('同一次提交裡序號鎖寫壞（跳號）→ 整批 DENY，紀錄也沒有寫入', async () => {
    const cur = (await getDoc(LOCK)).data.seq;
    const res = await commitBatch([
        { set: REC('zz_lock_should_not_exist'), data: rec({ id: 'zz_lock_should_not_exist' }) },
        { set: LOCK, data: { seq: cur + 5, updatedAt: iso() } },
    ], as(chief));
    denied(res, '跳號');
    eq((await getDoc(REC('zz_lock_should_not_exist'))).ok, false, '紀錄未寫入');
});

// ---- v2.19：config 通用主任規則不再涵蓋 recordsLock（主任／platformAdmin 與組長一致：只能 +1） ----
const PA = seed.platformAdmin;
for (const [who, user] of [['主任', dir], ['platformAdmin', PA]]) {
    await suite.case(`v2.19 ${who}：把 recordsLock 回退成 {seq:0} → DENY（修前被通用主任規則放行）`, async () => {
        const cur = (await getDoc(LOCK)).data.seq;
        denied(await setDoc(LOCK, { seq: 0, updatedAt: iso() }, as(user)), `${who} 回退 seq=0`);
        denied(await setDoc(LOCK, { seq: cur - 1, updatedAt: iso() }, as(user)), `${who} 回退 -1`);
        denied(await setDoc(LOCK, { seq: cur + 7, updatedAt: iso() }, as(user)), `${who} 跳號`);
        eq((await getDoc(LOCK)).data.seq, cur, 'seq 未被改動');
    });
    await suite.case(`v2.19 ${who}：recordsLock seq +1 → ALLOW（專屬規則仍允許）`, async () => {
        const cur = (await getDoc(LOCK)).data.seq;
        allowed(await setDoc(LOCK, { seq: cur + 1, updatedAt: iso() }, as(user)), `${who} +1`);
        eq((await getDoc(LOCK)).data.seq, cur + 1, 'seq +1');
    });
    await suite.case(`v2.19 ${who}：刪除 recordsLock 再以 seq=1 重建（迂迴回退）→ 刪除即 DENY`, async () => {
        const cur = (await getDoc(LOCK)).data.seq;
        const del = await fetch(`http://127.0.0.1:8080/v1/projects/demo-stsystem/databases/(default)/documents/${LOCK}`, { method: 'DELETE', headers: { Authorization: `Bearer ${user.idToken}` } });
        eq(del.ok, false, `${who} 刪除 recordsLock`);
        eq((await getDoc(LOCK)).data.seq, cur, 'seq 未被改動');
    });
}

suite.print();
process.exit(suite.failed ? 1 : 0);
