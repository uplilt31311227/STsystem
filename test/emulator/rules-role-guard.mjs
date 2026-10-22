#!/usr/bin/env node
/**
 * firestore.rules v2.9：角色異動護欄（主任不可改自己教師檔的 role）
 *
 * 用法：先 npm run emu（規則改過需重啟 emulator），再 node test/emulator/rules-role-guard.mjs
 *
 * 種子的 t01 主任同時在 config.initialAdminEmails（緊急後備白名單），白名單分支刻意不受護欄限制，
 * 所以主要案例改用「非白名單」主任：把白名單改成不含任何人的值，並把 t02 升為 director。
 */
import { seedAll } from './seed.mjs';
import { signIn, mergeDoc, getDoc, mustSetDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';

const SCHOOL = 'demo-alpha';
const T = (id) => `schools/${SCHOOL}/teachers/${id}`;

const seed = await seedAll({ quiet: true });
const acc = seed.alpha.accounts;
const idOf = (email) => [...acc.values()].find(a => a.email === email).teacherId;
const t01 = idOf('t01@alpha.demo.test');   // 種子主任（在白名單內）
const t02 = idOf('t02@alpha.demo.test');   // 種子組長，下面升為非白名單主任
const t03 = idOf('t03@alpha.demo.test');   // 一般教師

const wl = await signIn('t01@alpha.demo.test');   // 白名單主任
const dir = await signIn('t02@alpha.demo.test');  // 非白名單主任（將升級）
const mine = { idToken: dir.idToken };

// 準備：白名單改為無人可匹配，t02 升為 director
await mustSetDoc(`schools/${SCHOOL}/config/main`, { ...(await getDoc(`schools/${SCHOOL}/config/main`)).data, initialAdminEmails: ['nobody@elsewhere.test'] });
await mergeDoc(T(t02), { role: 'director' });

const suite = new Suite('firestore.rules v2.9：主任不可改自己的 role');

await suite.case('(a) 非白名單 director 改自己的 role（降為 teacher / section_chief）→ DENY', async () => {
    denied(await mergeDoc(T(t02), { role: 'teacher' }, mine), '降為 teacher');
    denied(await mergeDoc(T(t02), { role: 'section_chief' }, mine), '降為 section_chief');
    eq((await getDoc(T(t02))).data.role, 'director', 'role 仍為 director');
});
await suite.case('(b) director 改別人的 role → ALLOW', async () => {
    allowed(await mergeDoc(T(t03), { role: 'section_chief' }, mine), '教師升組長');
    eq((await getDoc(T(t03))).data.role, 'section_chief', 'role 已寫入');
    allowed(await mergeDoc(T(t03), { role: 'teacher' }, mine), '還原');
});
await suite.case('(c) director 改自己的其他欄位（role 不變）→ ALLOW', async () => {
    allowed(await mergeDoc(T(t02), { homeroomClass: '801' }, mine), '改導師班');
    allowed(await mergeDoc(T(t02), { role: 'director', domains: ['國文'] }, mine), '帶同值 role + 改領域');
    eq((await getDoc(T(t02))).data.homeroomClass, '801', '值已寫入');
});
await suite.case('(d) 白名單 director（緊急後備）改自己 role → 仍 ALLOW（刻意不動）', async () => {
    // 白名單復原後 t01 以 initialAdminEmails 分支通過
    await mustSetDoc(`schools/${SCHOOL}/config/main`, { ...(await getDoc(`schools/${SCHOOL}/config/main`)).data, initialAdminEmails: ['t01@alpha.demo.test'] });
    allowed(await mergeDoc(T(t01), { role: 'section_chief' }, { idToken: wl.idToken }), '白名單主任改自己');
    allowed(await mergeDoc(T(t01), { role: 'director' }, { idToken: wl.idToken }), '還原');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
