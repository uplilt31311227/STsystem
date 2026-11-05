/**
 * firestore.rules v2.10：schedules/{semesterId}/imports/{importId} 權限矩陣（emulator）
 *
 * 用法（需先 `npm run emu`，由人工啟動 emulator；本檔不會自行啟動）：
 *   npm run test:rules-schedule-imports
 *
 * 矩陣（A 校，目前學期 115-1，歷史學期 114-2）：
 *   read    ：成員可、外校成員不可
 *   create  ：組長／主任於目前學期可；一般教師不可；歷史學期不可；外校不可
 *   update  ：一律不可（含主任）
 *   delete  ：主任於非目前學期可；主任於目前學期不可；組長不可
 */
import { assertEmulator, createDoc, getDoc, updateDoc, deleteDoc, mustSetDoc } from './emu-client.mjs';
import { seedAll } from './seed.mjs';
import { Suite, allowed, denied } from '../scenarios/harness.mjs';

await assertEmulator();
const ctx = await seedAll({ quiet: true });

const A = ctx.alpha, B = ctx.beta;
const aId = A.fixture.schoolId;
const cur = A.fixture.config.currentSemester;
const prev = A.fixture.preset.previousSemester;
const [teacher] = A.teachers;
const [outsiderTeacher] = B.teachers;

const col = (sem) => `schools/${aId}/schedules/${sem}/imports`;
const sample = (id, n = 1) => ({
    id, versionNo: n, importedAt: '2026-11-05T00:00:00.000Z', source: 'file',
    fileName: 'zz.xlsx', counts: { entries: 1, classes: 1, teachers: 1, skipped: 0 },
    fingerprint: 'deadbeef', importedBy: { name: 'x', teacherId: 't' },
    snapshot: { scheduleData: [], teachers: [], classes: [] },
});

const suite = new Suite('規則 v2.10：schedules/imports 權限矩陣');

await suite.case('組長於目前學期可建立匯入紀錄', async () => {
    allowed(await createDoc(col(cur), 'imp_chief', sample('imp_chief', 1), { idToken: A.sectionChief.idToken }), '組長 create');
});
await suite.case('主任於目前學期可建立匯入紀錄', async () => {
    allowed(await createDoc(col(cur), 'imp_dir', sample('imp_dir', 2), { idToken: A.director.idToken }), '主任 create');
});
await suite.case('一般教師不可建立', async () => {
    denied(await createDoc(col(cur), 'imp_teacher', sample('imp_teacher'), { idToken: teacher.idToken }), '教師 create');
});
await suite.case('外校成員不可建立', async () => {
    denied(await createDoc(col(cur), 'imp_outsider', sample('imp_outsider'), { idToken: outsiderTeacher.idToken }), '外校 create');
});
await suite.case('歷史學期不可建立（連主任也不行）', async () => {
    denied(await createDoc(col(prev), 'imp_old', sample('imp_old'), { idToken: A.director.idToken }), '歷史學期 create');
});

await suite.case('成員可讀；外校成員不可讀', async () => {
    allowed(await getDoc(`${col(cur)}/imp_chief`, { idToken: teacher.idToken }), '本校教師 read');
    denied(await getDoc(`${col(cur)}/imp_chief`, { idToken: outsiderTeacher.idToken }), '外校 read');
});

await suite.case('update 一律禁止（含主任）', async () => {
    denied(await updateDoc(`${col(cur)}/imp_chief`, { fileName: 'tampered.xlsx' }, { idToken: A.director.idToken }), '主任 update');
    denied(await updateDoc(`${col(cur)}/imp_chief`, { fileName: 'tampered.xlsx' }, { idToken: A.sectionChief.idToken }), '組長 update');
});

await suite.case('目前學期的紀錄不可刪（含主任）', async () => {
    denied(await deleteDoc(`${col(cur)}/imp_chief`, { idToken: A.director.idToken }), '主任 delete 目前學期');
});

await suite.case('主任可刪非目前學期的紀錄；組長不可', async () => {
    await mustSetDoc(`${col(prev)}/imp_seed_old`, sample('imp_seed_old', 1));   // admin 繞過規則種入
    denied(await deleteDoc(`${col(prev)}/imp_seed_old`, { idToken: A.sectionChief.idToken }), '組長 delete 歷史');
    allowed(await deleteDoc(`${col(prev)}/imp_seed_old`, { idToken: A.director.idToken }), '主任 delete 歷史');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
