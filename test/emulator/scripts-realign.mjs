#!/usr/bin/env node
/**
 * scripts/realign-semester-id.js 對 emulator 實跑（不連正式專案）：
 *   dry-run（列出不一致、不寫入）→ --apply（以 :commit＋updateTime 前置條件校正）→ 再 dry-run（不一致歸 0）
 *   updateTime 過期時 :commit 被拒、文件不被覆寫；推算學期已封存者不自動改；拼錯旗標 exit 2。
 *
 * 用法：npx firebase emulators:exec --project demo-stsystem --only auth,firestore "node test/emulator/scripts-realign.mjs"
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDoc, mustSetDoc, mergeDoc } from './emu-client.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';
import { seedAll } from './seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { buildCommitBody } = require('../../scripts/lib/semester-realign.js');
await seedAll({ quiet: true });
const ENV = { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
const run = (args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'realign-semester-id.js'), ...args], { cwd: ROOT, env: ENV, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const SCHOOL = `zz-realign-${Date.now().toString(36)}`;
const B = `schools/${SCHOOL}`;
const base = { type: '代課', weekday: '週二', period: '第三節', className: '801', status: 'approved', createdAt: new Date().toISOString() };
const suite = new Suite('realign-semester-id 腳本（emulator 實跑）');

await mustSetDoc(`${B}/config/main`, { schoolName: 'R', currentSemester: '115-1', initialAdminEmails: [] });
await mustSetDoc(`${B}/archives/114-2`, { semesterId: '114-2', archivedAt: new Date().toISOString() });
await mustSetDoc(`${B}/substituteRecords/ok1`, { ...base, date: '2026-11-17', semesterId: '115-1' });
await mustSetDoc(`${B}/substituteRecords/early`, { ...base, date: '2027-02-01', semesterId: '115-1' });   // 預登下學期，舊語意記成目前學期
await mustSetDoc(`${B}/substituteRecords/late`, { ...base, date: '2027-01-31', semesterId: '115-2' });
await mustSetDoc(`${B}/substituteRecords/arch`, { ...base, date: '2026-07-31', semesterId: '115-1' });    // 推算 114-2，已封存
await mustSetDoc(`${B}/pendingRequests/p_early`, { ...base, status: 'pending_approval', date: '2027-02-03', semesterId: '115-1' });

await suite.case('拼錯旗標 --aply → exit 2、沒有寫入', async () => {
    const r = run([`--school=${SCHOOL}`, '--aply']);
    eq(r.code, 2, r.out);
    eq((await getDoc(`${B}/substituteRecords/early`)).data.semesterId, '115-1', '未寫入');
});
await suite.case('dry-run：列出不一致、不寫入（exit 1）', async () => {
    const r = run([`--school=${SCHOOL}`]);
    eq(r.code, 1, r.out);
    includes(r.out, 'early', '列出 early');
    includes(r.out, 'late', '列出 late');
    includes(r.out, 'p_early', '列出申請');
    includes(r.out, '已封存', '已封存者另列');
    eq((await getDoc(`${B}/substituteRecords/early`)).data.semesterId, '115-1', 'dry-run 未寫入');
});
await suite.case('--apply：校正可校正者；已封存者不動（exit 1 因有略過）', async () => {
    const r = run([`--school=${SCHOOL}`, '--apply']);
    eq(r.code, 1, r.out);
    eq((await getDoc(`${B}/substituteRecords/early`)).data.semesterId, '115-2', 'early → 115-2');
    eq((await getDoc(`${B}/substituteRecords/late`)).data.semesterId, '115-1', 'late → 115-1');
    eq((await getDoc(`${B}/pendingRequests/p_early`)).data.semesterId, '115-2', '申請 → 115-2');
    eq((await getDoc(`${B}/substituteRecords/arch`)).data.semesterId, '115-1', '已封存者不自動改');
    eq((await getDoc(`${B}/substituteRecords/ok1`)).data.semesterId, '115-1', '一致者不動');
});
await suite.case('再 dry-run：可校正的不一致歸 0（只剩已封存略過 1 筆）', async () => {
    const r = run([`--school=${SCHOOL}`]);
    includes(r.out, '不一致、可校正：0', '可校正 0');
    includes(r.out, '（不自動改）：1', '已封存略過 1');
});
await suite.case('updateTime 過期：:commit 被拒、不覆寫（模擬規劃後文件被別人改動）', async () => {
    const before = await getDoc(`${B}/substituteRecords/ok1`);
    const staleTime = before.raw?.updateTime || (await (await fetch(`http://127.0.0.1:8080/v1/projects/demo-stsystem/databases/(default)/documents/${B}/substituteRecords/ok1`)).json()).updateTime;
    await mergeDoc(`${B}/substituteRecords/ok1`, { docNumber: 'changed-by-someone' });   // 之後有人改了
    const res = await fetch(`http://127.0.0.1:8080/v1/projects/demo-stsystem/databases/(default)/documents:commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
        body: JSON.stringify(buildCommitBody('demo-stsystem', `${B}/substituteRecords/ok1`, '999-9', staleTime)),
    });
    ok(!res.ok, `過期 updateTime 應被拒（HTTP ${res.status}）`);
    const after = await getDoc(`${B}/substituteRecords/ok1`);
    eq(after.data.semesterId, '115-1', 'semesterId 未被覆寫');
    eq(after.data.docNumber, 'changed-by-someone', '別人的改動保留');
});
await suite.case('buildCommitBody 沒有 updateTime → 丟錯（不退回無條件寫入）', async () => {
    let threw = false;
    try { buildCommitBody('p', 'a/b', '115-1', undefined); } catch { threw = true; }
    ok(threw, '應丟錯');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
