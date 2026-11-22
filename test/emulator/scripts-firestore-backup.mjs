#!/usr/bin/env node
/**
 * scripts/firestore-backup.js 的 V1 個人雲端文件（users/{uid}/data/substituteSystem）備份／還原：emulator 實跑。
 * 驗證：
 *   - backup 以 collection group query 只收路徑為 users/{uid}/data/substituteSystem 的文件（排除 users/*\/data/其他、
 *     schools/*\/data/substituteSystem 等同名集合的文件），輸出 v1UserData.json，並印出各份 substituteRecords 筆數；
 *   - --include-v1=false 不產生 v1UserData.json；
 *   - restore 預設（含 --yes）不寫 V1；--dry-run + --restore-v1 不寫；--yes --restore-v1 才寫回，內容與備份時完全相同。
 * 全程只對 emulator（FIRESTORE_EMULATOR_HOST）執行，腳本內建 script-safety 會擋正式專案。
 *
 * 用法：npx firebase emulators:exec --project demo-stsystem --only auth,firestore "node test/emulator/scripts-firestore-backup.mjs"
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDoc, mustSetDoc, assertEmulator } from './emu-client.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
await assertEmulator();
const suite = new Suite('firestore-backup.js：V1 個人雲端文件備份／還原（emulator 實跑）');
const ENV = { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' };
const run = (args) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'firestore-backup.js'), ...args], { cwd: ROOT, env: ENV, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};
const uniq = `${Date.now().toString(36)}`;
const SCHOOL = `zz-bk-${uniq}`;
const UID_A = `bkA${uniq}`, UID_B = `bkB${uniq}`, UID_C = `bkC${uniq}`;
const rec = (n) => ({ date: '2026-09-01', period: `第${n}節`, className: '701', originalTeacher: '甲', substituteTeacher: '乙', type: '代課' });
const V1_A = { substituteRecords: [rec(1), rec(2), rec(3)], lastModified: '2026-11-01T00:00:00.000Z', version: 5 };
const V1_B = { substituteRecords: [rec(4), rec(5)], lastModified: '2026-11-02T00:00:00.000Z', version: 9 };
const backupsRoot = path.join(ROOT, 'backups', 'firestore-demo-stsystem');
const created = [];

await mustSetDoc(`users/${UID_A}/data/substituteSystem`, V1_A);
await mustSetDoc(`users/${UID_B}/data/substituteSystem`, V1_B);
await mustSetDoc(`users/${UID_C}/data/unrelated`, { note: '不是 substituteSystem，不應被收' });
await mustSetDoc(`schools/${SCHOOL}/data/substituteSystem`, { substituteRecords: [rec(9)] });   // 同名但在 schools 底下，不應被收
await mustSetDoc(`schools/${SCHOOL}/config/main`, { schoolName: '備份測試校', currentSemester: '115-1' });

function newestBackupDir(before) {
    const all = fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot) : [];
    const fresh = all.filter(n => !before.includes(n)).sort();
    ok(fresh.length >= 1, '產生了新的備份資料夾');
    const d = path.join(backupsRoot, fresh[fresh.length - 1]);
    created.push(d);
    return d;
}
const listBefore = () => (fs.existsSync(backupsRoot) ? fs.readdirSync(backupsRoot) : []);
let dirA = null;

await suite.case('backup（預設）：v1UserData.json 只含 2 份正確路徑的文件，並印出筆數', async () => {
    const before = listBefore();
    const r = run(['backup', `--school=${SCHOOL}`]);
    eq(r.code, 0, `backup 結束碼\n${r.out}`);
    dirA = newestBackupDir(before);
    const f = JSON.parse(fs.readFileSync(path.join(dirA, 'v1UserData.json'), 'utf8'));
    eq(f.count, 2, 'count 為 2');
    const names = f.documents.map(d => d.document.name.split('/documents/')[1]).sort();
    eq(names, [`users/${UID_A}/data/substituteSystem`, `users/${UID_B}/data/substituteSystem`].sort(), '只收 users/{uid}/data/substituteSystem');
    includes(r.out, 'substituteRecords 3 筆', '輸出含 A 的筆數 3');
    includes(r.out, 'substituteRecords 2 筆', '輸出含 B 的筆數 2');
    ok(!r.out.includes(UID_A), '輸出不含完整 uid');
    ok(f.documents.every(d => d.document.fields && d.document.name), '保留原始 REST document 物件（name/fields）');
});

await suite.case('backup --include-v1=false：不產生 v1UserData.json', async () => {
    await new Promise(r => setTimeout(r, 1200));   // 備份資料夾以秒為單位命名，避免與上一份同名
    const before = listBefore();
    const r = run(['backup', `--school=${SCHOOL}`, '--include-v1=false']);
    eq(r.code, 0, r.out);
    const d = newestBackupDir(before);
    ok(!fs.existsSync(path.join(d, 'v1UserData.json')), '沒有 v1UserData.json');
    includes(r.out, '已略過', '輸出說明已略過');
});

await suite.case('restore：預設不寫 V1（計畫只提示）；--dry-run --restore-v1 不寫；--yes --restore-v1 才寫回且內容相同', async () => {
    const mod = { substituteRecords: [rec(7)], lastModified: '2026-11-23T00:00:00.000Z', version: 99 };
    await mustSetDoc(`users/${UID_A}/data/substituteSystem`, mod);
    await mustSetDoc(`users/${UID_B}/data/substituteSystem`, mod);
    const aPath = `users/${UID_A}/data/substituteSystem`;

    const plan = run(['restore', `--dir=${dirA}`, `--school=${SCHOOL}`]);
    eq(plan.code, 0, plan.out);
    includes(plan.out, 'v1UserData 2 份', '未帶旗標的計畫提示有 v1UserData');
    ok(!/- v1UserData：/.test(plan.out), '計畫清單不含 v1UserData');

    const noflag = run(['restore', `--dir=${dirA}`, `--school=${SCHOOL}`, '--yes']);
    eq(noflag.code, 0, noflag.out);
    eq((await getDoc(aPath)).data, mod, '--yes 但無 --restore-v1：V1 文件維持現狀');

    const dry = run(['restore', `--dir=${dirA}`, `--school=${SCHOOL}`, '--yes', '--dry-run', '--restore-v1']);
    eq(dry.code, 0, dry.out);
    includes(dry.out, '- v1UserData：2 筆', 'dry-run 計畫列出 v1UserData 2 筆');
    eq((await getDoc(aPath)).data, mod, '--dry-run：不寫入');

    const real = run(['restore', `--dir=${dirA}`, `--school=${SCHOOL}`, '--yes', '--restore-v1']);
    eq(real.code, 0, real.out);
    eq((await getDoc(aPath)).data, V1_A, 'A 還原後內容與備份時相同');
    eq((await getDoc(`users/${UID_B}/data/substituteSystem`)).data, V1_B, 'B 還原後內容與備份時相同');
    eq((await getDoc(`users/${UID_C}/data/unrelated`)).data.note, '不是 substituteSystem，不應被收', '無關 data 文件未被動到');
});

for (const d of created) fs.rmSync(d, { recursive: true, force: true });
try { if (fs.existsSync(backupsRoot) && fs.readdirSync(backupsRoot).length === 0) fs.rmdirSync(backupsRoot); } catch { /* 忽略 */ }
suite.print();
process.exit(suite.failed ? 1 : 0);
