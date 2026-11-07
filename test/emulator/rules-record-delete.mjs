#!/usr/bin/env node
/**
 * firestore.rules v2.11：substituteRecords 刪除權限（組長可刪目前學期紀錄）
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-record-delete.mjs（會清空並重建 emulator 資料）
 */
import { seedAll } from './seed.mjs';
import { signIn, getDoc, deleteDoc, mustSetDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';

const SCHOOL = 'demo-alpha';
const R = (id) => `schools/${SCHOOL}/substituteRecords/${id}`;

await seedAll({ quiet: true });
const current = (await getDoc(`schools/${SCHOOL}/config/main`)).data.currentSemester;
const past = '114-2';

// 以 owner 權限種三筆待刪紀錄：目前學期、歷史學期、無 semesterId 的舊紀錄
const base = { date: '2026-11-17', weekday: '週二', period: '第一節', className: '7年1班', type: '代課',
    originalTeacher: '甲', substituteTeacher: '乙', status: 'approved', createdAt: '2026-11-07T00:00:00.000Z' };
const mk = async (id, extra) => mustSetDoc(R(id), { ...base, ...extra });

const chief   = await signIn('t02@alpha.demo.test');   // 組長（section_chief）
const dir     = await signIn('t01@alpha.demo.test');   // 主任
const teacher = await signIn('t03@alpha.demo.test');   // 一般教師
const as = (s) => ({ idToken: s.idToken });

const suite = new Suite(`firestore.rules v2.11：紀錄刪除權限（目前學期 ${current}）`);

await suite.case('組長刪除目前學期紀錄 → ALLOW', async () => {
    await mk('del_cur_chief', { semesterId: current });
    allowed(await deleteDoc(R('del_cur_chief'), as(chief)), '組長刪除');
    eq((await getDoc(R('del_cur_chief'))).ok, false, '文件已不存在');
});
await suite.case('組長刪除歷史學期紀錄 → DENY', async () => {
    await mk('del_past_chief', { semesterId: past });
    denied(await deleteDoc(R('del_past_chief'), as(chief)), '組長刪歷史學期');
    eq((await getDoc(R('del_past_chief'))).ok, true, '文件仍在');
});
await suite.case('組長刪除無 semesterId 的舊紀錄 → ALLOW（比照 update）', async () => {
    await mk('del_legacy_chief', {});
    allowed(await deleteDoc(R('del_legacy_chief'), as(chief)), '組長刪舊紀錄');
});
await suite.case('主任刪除歷史學期紀錄 → ALLOW（封存清理需要）', async () => {
    allowed(await deleteDoc(R('del_past_chief'), as(dir)), '主任刪歷史學期');
});
await suite.case('一般教師刪除目前學期紀錄 → DENY', async () => {
    await mk('del_cur_teacher', { semesterId: current });
    denied(await deleteDoc(R('del_cur_teacher'), as(teacher)), '教師刪除');
    eq((await getDoc(R('del_cur_teacher'))).ok, true, '文件仍在');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
