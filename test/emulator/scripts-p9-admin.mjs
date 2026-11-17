#!/usr/bin/env node
/**
 * P9 批次 A2 的兩支 Admin 腳本，對 emulator 實跑（不連正式專案）：
 *   scripts/bootstrap-platform-admin.js --email=（建立 platformAdmin：預設 dry-run、--apply 才寫、可重複執行）
 *   scripts/set-director-established.js（補設 config/main.directorEstablished：預設 dry-run、--apply 才寫、
 *   沒有已登入過的正式主任時預設拒絕）
 * 並以 rules 驗證效果：建立後 platformAdmin 能讀寫該校；補旗標後白名單主任立即失效。
 *
 * 用法：npx firebase emulators:exec --project demo-stsystem --only auth,firestore "node test/emulator/scripts-p9-admin.mjs"
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDoc, mergeDoc, mustSetDoc, createTestUser } from './emu-client.mjs';
import { Suite, allowed, denied, eq, ok, includes } from '../scenarios/harness.mjs';
import { setup, as, iso } from './kit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const W = await setup();
const suite = new Suite('P9 A2 Admin 腳本（emulator 實跑）：bootstrap-platform-admin、set-director-established');
const ENV = { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
const run = (script, args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: ROOT, env: ENV, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

async function school({ whitelist = [], flag = false, director = true, directorLoggedIn = true } = {}) {
    const id = `zz-p9s-${uniq()}`;
    const base = `schools/${id}`;
    await mustSetDoc(`${base}/config/main`, { schoolName: '腳本測試校', currentSemester: W.semesterId, initialAdminEmails: whitelist, createdAt: iso(), updatedAt: iso(), ...(flag ? { directorEstablished: true } : {}) });
    let dir = null;
    if (director) {
        const email = `dir_${uniq()}@p9s.demo.test`;
        dir = { ...(await createTestUser(email)), email, teacherId: `tch_${uniq()}` };
        await mustSetDoc(`${base}/teachers/${dir.teacherId}`, { name: '正式主任', email, domains: [], homeroomClass: '', role: 'director', createdAt: iso(), updatedAt: iso() });
        if (directorLoggedIn) await mustSetDoc(`${base}/userMappings/${dir.localId}`, { linkedTeacherId: dir.teacherId, email, lastLoginAt: iso() });
    }
    return { id, base, cfg: `${base}/config/main`, dir };
}

await suite.case('bootstrap-platform-admin：以 --email= 建立——預設 dry-run 不寫入；--apply 寫入；重複執行不重複建立；建立後該帳號在任何學校行使主任權限', async () => {
    const email = `pa_${uniq()}@p9s.demo.test`;
    const user = await createTestUser(email);
    const S = await school({ flag: true });
    denied(await getDoc(S.cfg, as(user)), '建立前：一般帳號讀不到該校 config');

    const dry = run('bootstrap-platform-admin.js', [`--email=${email}`]);
    eq(dry.code, 0, `dry-run 結束碼\n${dry.out}`);
    includes(dry.out, 'dry-run', 'dry-run 說明');
    eq((await getDoc(`platformAdmins/${user.localId}`)).ok, false, 'dry-run 沒有寫入');

    const apply = run('bootstrap-platform-admin.js', [`--email=${email}`, '--apply']);
    eq(apply.code, 0, `--apply 結束碼\n${apply.out}`);
    const doc = await getDoc(`platformAdmins/${user.localId}`);
    ok(doc.ok, 'platformAdmins/{uid} 已建立');
    ok(!JSON.stringify(doc.data).includes(email), '文件內容不含信箱（信箱不落在資料庫以外的任何地方，也不在 repo）');

    const again = run('bootstrap-platform-admin.js', [`--email=${email}`, '--apply']);
    eq(again.code, 0, '重複執行結束碼');
    includes(again.out, '已存在', '重複執行提示已存在');

    allowed(await getDoc(S.cfg, as(user)), '建立後：讀該校 config');
    allowed(await mergeDoc(S.cfg, { schoolName: '平台改名', updatedAt: iso() }, as(user)), '建立後：改該校 config（主任權限）');
    denied(await mergeDoc(S.cfg, { directorEstablished: false, updatedAt: iso() }, as(user)), '建立後：仍不可把旗標改回 false');
});

await suite.case('bootstrap-platform-admin：以 --uid= 建立；找不到 email → 失敗不寫入；未知參數 exit 2', async () => {
    const user = await createTestUser(`pa2_${uniq()}@p9s.demo.test`);
    const r = run('bootstrap-platform-admin.js', [`--uid=${user.localId}`, '--apply']);
    eq(r.code, 0, r.out);
    ok((await getDoc(`platformAdmins/${user.localId}`)).ok, '以 uid 建立成功');
    const bad = run('bootstrap-platform-admin.js', [`--email=nobody_${uniq()}@p9s.demo.test`, '--apply']);
    ok(bad.code !== 0, `查無 email 應失敗\n${bad.out}`);
    eq(run('bootstrap-platform-admin.js', ['--bogus']).code, 2, '未知參數');
});

await suite.case('set-director-established：預設 dry-run 不寫；--apply 設為 true；效果：白名單主任立即失效、正式主任照常；重複執行無動作', async () => {
    const wl = `wl_${uniq()}@p9s.demo.test`;
    const wlUser = await createTestUser(wl);
    const S = await school({ whitelist: [wl] });
    allowed(await getDoc(S.cfg, as(wlUser)), '補旗標前：白名單使用者可讀 config');

    const dry = run('set-director-established.js', [`--school=${S.id}`]);
    eq(dry.code, 0, dry.out);
    includes(dry.out, '正式主任', '列出正式主任');
    eq((await getDoc(S.cfg)).data.directorEstablished, undefined, 'dry-run 沒有寫入');
    allowed(await getDoc(S.cfg, as(wlUser)), 'dry-run 後白名單仍有效');

    const apply = run('set-director-established.js', [`--school=${S.id}`, '--apply']);
    eq(apply.code, 0, apply.out);
    eq((await getDoc(S.cfg)).data.directorEstablished, true, '--apply 後旗標為 true');
    eq((await getDoc(S.cfg)).data.schoolName, '腳本測試校', '其他欄位不動');
    denied(await getDoc(S.cfg, as(wlUser)), '補旗標後：白名單使用者讀 config 被拒（白名單已失效）');
    allowed(await getDoc(S.cfg, as(S.dir)), '補旗標後：正式主任照常讀');
    allowed(await mergeDoc(S.cfg, { schoolName: '主任改名', updatedAt: iso() }, as(S.dir)), '補旗標後：正式主任照常寫');

    const again = run('set-director-established.js', [`--school=${S.id}`, '--apply']);
    eq(again.code, 0, again.out);
    includes(again.out, '已經是 true', '重複執行無動作');
});

await suite.case('set-director-established：沒有已登入過的正式主任（無主任、或主任尚無 mapping）預設拒絕（exit 2、不寫入）；--force --apply 才設定；找不到學校 exit 2', async () => {
    const S1 = await school({ director: false });
    const r1 = run('set-director-established.js', [`--school=${S1.id}`, '--apply']);
    eq(r1.code, 2, r1.out);
    eq((await getDoc(S1.cfg)).data.directorEstablished, undefined, '無主任：未寫入');
    const S2 = await school({ directorLoggedIn: false });
    const r2 = run('set-director-established.js', [`--school=${S2.id}`, '--apply']);
    eq(r2.code, 2, r2.out);
    eq((await getDoc(S2.cfg)).data.directorEstablished, undefined, '主任未登入過：未寫入');
    const forced = run('set-director-established.js', [`--school=${S2.id}`, '--apply', '--force']);
    eq(forced.code, 0, forced.out);
    eq((await getDoc(S2.cfg)).data.directorEstablished, true, '--force --apply 後設定');
    eq(run('set-director-established.js', ['--school=zz-no-such-school-p9']).code, 2, '找不到學校');
    eq(run('set-director-established.js', ['--bogus']).code, 2, '未知參數');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
