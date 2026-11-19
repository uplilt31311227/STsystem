#!/usr/bin/env node
/**
 * firestore.rules v2.15（P7）：config/settlement 的逐人門檻欄位、config/grade9 的權限矩陣（emulator，project demo-stsystem）
 *
 * 用法：先 npm run emu（規則改過需重啟 emulator），再 node test/emulator/rules-p7-config.mjs
 * 種子帳號：t01 主任、t02 組長、t03 一般教師。
 */
import { seedAll } from './seed.mjs';
import { signIn, setDoc, getDoc, deleteDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';

const SCHOOL = 'demo-alpha';
const SET = `schools/${SCHOOL}/config/settlement`;
const G9  = `schools/${SCHOOL}/config/grade9`;
const settlement = (extra = {}) => ({
    calendarId: '', calendarApiKey: '', weeksByYear: {}, updatedAt: '2026-11-15T00:00:00.000Z', updatedBy: 't02@alpha.demo.test', ...extra,
});
const grade9 = (extra = {}) => ({
    semesterId: '115-1', enabled: true, effectiveDate: '2026-06-20', updatedAt: '2026-11-15T00:00:00.000Z', updatedBy: 't02@alpha.demo.test', ...extra,
});

await seedAll({ quiet: true });
await deleteDoc(SET); await deleteDoc(G9);
const dir     = await signIn('t01@alpha.demo.test');
const chief   = await signIn('t02@alpha.demo.test');
const teacher = await signIn('t03@alpha.demo.test');

const suite = new Suite('firestore.rules v2.15：逐人門檻與九年級畢業設定');

await suite.case('settlement：組長寫入 weeklyBaseByTeacher（map）→ ALLOW，讀回相同', async () => {
    allowed(await setDoc(SET, settlement({ weeklyBaseByTeacher: { 方小生: 16, tB: 12 } }), { idToken: chief.idToken }), '組長寫門檻');
    eq((await getDoc(SET)).data.weeklyBaseByTeacher, { 方小生: 16, tB: 12 }, '讀回');
});
await suite.case('settlement：不帶 weeklyBaseByTeacher 的既有格式仍可寫（相容舊前端）', async () => {
    allowed(await setDoc(SET, settlement(), { idToken: chief.idToken }), '舊格式');
});
await suite.case('settlement：weeklyBaseByTeacher 不是 map（字串、陣列）→ DENY', async () => {
    denied(await setDoc(SET, settlement({ weeklyBaseByTeacher: 'x' }), { idToken: chief.idToken }), '字串');
    denied(await setDoc(SET, settlement({ weeklyBaseByTeacher: [16] }), { idToken: chief.idToken }), '陣列');
});
await suite.case('settlement：weeklyBaseByTeacher 超過 400 筆 → DENY；400 筆 → ALLOW', async () => {
    const mk = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, 20]));
    denied(await setDoc(SET, settlement({ weeklyBaseByTeacher: mk(401) }), { idToken: chief.idToken }), '401 筆');
    allowed(await setDoc(SET, settlement({ weeklyBaseByTeacher: mk(400) }), { idToken: chief.idToken }), '400 筆');
});
await suite.case('settlement：一般教師寫入含 weeklyBaseByTeacher → DENY；讀取 → DENY', async () => {
    denied(await setDoc(SET, settlement({ weeklyBaseByTeacher: { x: 1 } }), { idToken: teacher.idToken }), '教師寫');
    denied(await getDoc(SET, { idToken: teacher.idToken }), '教師讀');
});
await suite.case('settlement：夾帶白名單外欄位仍 DENY（白名單只多一個欄位）', async () => {
    denied(await setDoc(SET, settlement({ weeklyBaseByTeacher: {}, evil: 1 }), { idToken: chief.idToken }), '夾帶 evil');
});

await suite.case('grade9：組長與主任寫入（白名單欄位）→ ALLOW', async () => {
    allowed(await setDoc(G9, grade9(), { idToken: chief.idToken }), '組長');
    allowed(await setDoc(G9, grade9({ enabled: false, updatedBy: 't01@alpha.demo.test' }), { idToken: dir.idToken }), '主任');
});
await suite.case('grade9：一般教師寫入／刪除 → DENY；但所有成員可讀（推薦與衝突判斷要用）', async () => {
    allowed(await setDoc(G9, grade9(), { idToken: chief.idToken }), '先建立');
    denied(await setDoc(G9, grade9({ enabled: false }), { idToken: teacher.idToken }), '教師改');
    denied(await deleteDoc(G9, { idToken: teacher.idToken }), '教師刪');
    const r = await getDoc(G9, { idToken: teacher.idToken });
    allowed(r, '教師讀');
    eq(r.data.semesterId, '115-1', '讀到設定');
});
await suite.case('grade9：欄位型別與長度檢查 → DENY', async () => {
    denied(await setDoc(G9, grade9({ enabled: 'yes' }), { idToken: chief.idToken }), 'enabled 非布林');
    denied(await setDoc(G9, grade9({ semesterId: 115 }), { idToken: chief.idToken }), 'semesterId 非字串');
    denied(await setDoc(G9, grade9({ semesterId: 'x'.repeat(21) }), { idToken: chief.idToken }), 'semesterId 過長');
    denied(await setDoc(G9, grade9({ effectiveDate: '2026-06-20T00:00' }), { idToken: chief.idToken }), 'effectiveDate 過長');
    denied(await setDoc(G9, grade9({ updatedBy: 'y'.repeat(101) }), { idToken: chief.idToken }), 'updatedBy 過長');
});
await suite.case('grade9：缺欄位或夾帶白名單外欄位 → DENY', async () => {
    const { effectiveDate, ...missing } = grade9();
    denied(await setDoc(G9, missing, { idToken: chief.idToken }), '缺 effectiveDate');
    denied(await setDoc(G9, grade9({ evil: 1 }), { idToken: chief.idToken }), '夾帶 evil');
});

// ---- v2.19：主任／platformAdmin 的 grade9 寫入同樣受白名單約束 ----
const PAUSER = await signIn('platform.admin@demo.test');
for (const [who, user] of [['主任', dir], ['platformAdmin', PAUSER]]) {
    await suite.case(`v2.19 grade9：${who} 夾帶白名單外欄位／缺欄位 → DENY（修前被通用主任規則放行）`, async () => {
        denied(await setDoc(G9, grade9({ evil: 1 }), { idToken: user.idToken }), `${who} 夾帶 evil`);
        const { effectiveDate, ...missing } = grade9();
        denied(await setDoc(G9, missing, { idToken: user.idToken }), `${who} 缺欄位`);
        denied(await setDoc(G9, grade9({ enabled: 'yes' }), { idToken: user.idToken }), `${who} 型別錯`);
    });
    await suite.case(`v2.19 grade9：${who} 寫入合法白名單欄位 → ALLOW`, async () => {
        allowed(await setDoc(G9, grade9({ enabled: false, updatedBy: 'x@demo.test' }), { idToken: user.idToken }), `${who} 合法 grade9`);
        eq((await getDoc(G9)).data.enabled, false, '讀回');
    });
}

suite.print();
process.exit(suite.failed ? 1 : 0);
