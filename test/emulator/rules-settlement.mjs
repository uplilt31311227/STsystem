#!/usr/bin/env node
/**
 * firestore.rules：config/settlement 權限矩陣（emulator，project demo-stsystem）
 *
 * 用法：先 npm run emu（emulator 啟動時才會載入 firestore.rules，規則改過需重啟），
 *       再 node test/emulator/rules-settlement.mjs
 * 開頭會重新 seed（沿用 e2e 的種子帳號：t01 主任、t02 組長、t03 一般教師）。
 */
import { seedAll } from './seed.mjs';
import { signIn, setDoc, mergeDoc, getDoc, deleteDoc, mustSetDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';

const SCHOOL = 'demo-alpha';
const CFG  = `schools/${SCHOOL}/config/settlement`;
const MAIN = `schools/${SCHOOL}/config/main`;
const valid = (extra = {}) => ({
    calendarId: 'fake@group.calendar.google.com', calendarApiKey: 'FAKE',
    weeksByYear: { 115: { 8: 1, 9: 4 } }, updatedAt: '2026-10-07T00:00:00.000Z', updatedBy: 't02@alpha.demo.test',
    ...extra,
});

await seedAll({ quiet: true });
await deleteDoc(CFG);
const dir     = await signIn('t01@alpha.demo.test');
const chief   = await signIn('t02@alpha.demo.test');
const teacher = await signIn('t03@alpha.demo.test');

const suite = new Suite('firestore.rules：config/settlement 權限矩陣');

await suite.case('組長 create config/settlement（白名單欄位）→ ALLOW', async () => {
    allowed(await setDoc(CFG, valid(), { idToken: chief.idToken }), '組長建立');
});
await suite.case('組長 update config/settlement（白名單欄位）→ ALLOW', async () => {
    allowed(await setDoc(CFG, valid({ weeksByYear: { 115: { 8: 2 } } }), { idToken: chief.idToken }), '組長更新');
    eq((await getDoc(CFG)).data.weeksByYear['115']['8'], 2, '值已寫入');
});
await suite.case('組長寫入含白名單外欄位 → DENY（create 與 update）', async () => {
    denied(await setDoc(CFG, valid({ evil: 'x' }), { idToken: chief.idToken }), '組長 update 夾帶 evil 欄位');
    await deleteDoc(CFG);
    denied(await setDoc(CFG, valid({ evil: 'x' }), { idToken: chief.idToken }), '組長 create 夾帶 evil 欄位');
});
await suite.case('組長 weeksByYear 非 map → DENY', async () => {
    denied(await setDoc(CFG, valid({ weeksByYear: 'abc' }), { idToken: chief.idToken }), 'weeksByYear 為字串');
    denied(await setDoc(CFG, valid({ weeksByYear: [1, 2] }), { idToken: chief.idToken }), 'weeksByYear 為陣列');
});
await suite.case('組長 delete config/settlement → DENY', async () => {
    await mustSetDoc(CFG, valid());
    denied(await deleteDoc(CFG, { idToken: chief.idToken }), '組長刪除');
    eq((await getDoc(CFG)).ok, true, '文件仍在');
});
await suite.case('組長寫 config/main → DENY', async () => {
    denied(await mergeDoc(MAIN, { schoolName: 'hacked' }, { idToken: chief.idToken }), '組長改 config/main');
});
await suite.case('一般教師寫 config/settlement → DENY；讀 → ALLOW', async () => {
    denied(await setDoc(CFG, valid(), { idToken: teacher.idToken }), '教師寫入');
    denied(await deleteDoc(CFG, { idToken: teacher.idToken }), '教師刪除');
    allowed(await getDoc(CFG, { idToken: teacher.idToken }), '教師讀取');
});
await suite.case('director 寫 config/settlement → ALLOW', async () => {
    allowed(await setDoc(CFG, valid({ weeksByYear: { 115: { 8: 3 } } }), { idToken: dir.idToken }), 'director 寫入');
    eq((await getDoc(CFG)).data.weeksByYear['115']['8'], 3, '值已寫入');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
