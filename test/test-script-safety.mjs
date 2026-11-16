// scripts/lib/script-safety.js 單元測試：旗標解析、dry-run 判斷、目標解析、部署閘
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const S = require('../scripts/lib/script-safety.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('✓ ' + name); };

t('parseWriteMode：無旗標 = dry-run', () => {
    assert.deepEqual(S.parseWriteMode([]), { apply: false, dryRun: true, explicitDryRun: false });
    assert.equal(S.parseWriteMode(['--school=inhu']).apply, false);
});
t('parseWriteMode：--apply 才寫入', () => {
    assert.equal(S.parseWriteMode(['--apply']).apply, true);
    assert.equal(S.parseWriteMode(['--apply']).dryRun, false);
});
t('parseWriteMode：--apply 與 --dry-run 並存以 dry-run 為準', () => {
    const m = S.parseWriteMode(['--apply', '--dry-run']);
    assert.equal(m.apply, false); assert.equal(m.dryRun, true); assert.equal(m.explicitDryRun, true);
});
t('parseWriteMode：舊旗標 --yes 僅在指定 alias 時等價', () => {
    assert.equal(S.parseWriteMode(['--yes']).apply, false);
    assert.equal(S.parseWriteMode(['--yes'], { applyAliases: ['--yes'] }).apply, true);
    assert.equal(S.parseWriteMode(['--yes', '--dry-run'], { applyAliases: ['--yes'] }).apply, false);
});
t('parseWriteMode：--apply=false／--appl 之類不算 apply', () => {
    assert.equal(S.parseWriteMode(['--apply=false']).apply, false);
    assert.equal(S.parseWriteMode(['--appl']).apply, false);
});
t('findUnknownFlags', () => {
    assert.deepEqual(S.findUnknownFlags(['--apply', '--x', '--school=a'], ['--apply'], ['--school=']), ['--x']);
});
t('getArgValue', () => {
    assert.equal(S.getArgValue(['--confirm=abc'], 'confirm'), 'abc');
    assert.equal(S.getArgValue([], 'confirm'), undefined);
});
t('resolveTarget：預設正式專案', () => {
    const r = S.resolveTarget({});
    assert.equal(r.project, 'stsystem-9d5fe'); assert.equal(r.isProd, true); assert.equal(r.emulator, false);
    assert.ok(r.firestoreOrigin.startsWith('https://'));
});
t('resolveTarget：--project 覆寫為非正式', () => {
    const r = S.resolveTarget({}, 'my-preview');
    assert.equal(r.project, 'my-preview'); assert.equal(r.isProd, false);
});
t('resolveTarget：emulator 環境 → demo 專案、本機 origin', () => {
    const r = S.resolveTarget({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, 'stsystem-9d5fe');
    assert.equal(r.emulator, true); assert.equal(r.project, 'demo-stsystem');
    assert.equal(r.firestoreOrigin, 'http://127.0.0.1:8080'); assert.equal(r.isProd, false);
});
t('resolveTarget：emulator 主機非本機 → 丟錯', () => {
    assert.throws(() => S.resolveTarget({ FIRESTORE_EMULATOR_HOST: 'example.com:8080' }));
    assert.throws(() => S.resolveTarget({ FIRESTORE_EMULATOR_HOST: '10.0.0.5:8080' }));
});
t('getAccessToken：emulator 不呼叫 gcloud', () => {
    assert.equal(S.getAccessToken({ emulator: true }, 'x@y'), 'owner');
});
t('databaseBase', () => {
    assert.equal(S.databaseBase(S.resolveTarget({})), 'https://firestore.googleapis.com/v1/projects/stsystem-9d5fe/databases/(default)');
});
t('targetBanner 含專案 ID 與模式', () => {
    const dry = S.targetBanner(S.resolveTarget({}), { action: 'x', apply: false }).join('\n');
    assert.match(dry, /stsystem-9d5fe/); assert.match(dry, /dry-run/);
    const app = S.targetBanner(S.resolveTarget({}), { action: 'x', apply: true }).join('\n');
    assert.match(app, /--apply/);
});
const P = 'stsystem-9d5fe';
t('parseDeployArgs：無旗標 = plan', () => assert.equal(S.parseDeployArgs([], P).mode, 'plan'));
t('parseDeployArgs：--apply 缺 --confirm → error', () => assert.equal(S.parseDeployArgs(['--apply'], P).mode, 'error'));
t('parseDeployArgs：--confirm 不符 → error', () => assert.equal(S.parseDeployArgs(['--apply', '--confirm=other'], P).mode, 'error'));
t('parseDeployArgs：--apply --confirm=專案 → deploy', () => assert.equal(S.parseDeployArgs(['--apply', `--confirm=${P}`], P).mode, 'deploy'));
t('parseDeployArgs：只有 --confirm 不部署', () => assert.equal(S.parseDeployArgs([`--confirm=${P}`], P).mode, 'error'));
t('parseDeployArgs：--dry / --list / --help / 未知', () => {
    assert.equal(S.parseDeployArgs(['--dry'], P).mode, 'validate');
    assert.equal(S.parseDeployArgs(['--list'], P).mode, 'list');
    assert.equal(S.parseDeployArgs(['-h'], P).mode, 'help');
    assert.equal(S.parseDeployArgs(['--bogus'], P).mode, 'error');
    assert.equal(S.parseDeployArgs(['--dry', '--apply', `--confirm=${P}`], P).mode, 'error');
});
t('parseDeployArgs：--project= 不算未知', () => assert.equal(S.parseDeployArgs(['--project=x'], 'x').mode, 'plan'));
t('evaluateGitState', () => {
    assert.equal(S.evaluateGitState({ porcelain: '', head: 'abc msg', branch: 'm' }).clean, true);
    const d = S.evaluateGitState({ porcelain: ' M a.js\n?? b\n', head: 'abc', branch: 'm' });
    assert.equal(d.clean, false); assert.equal(d.dirtyFiles.length, 2);
});
// ---- M1 與建議 1–3：旗標解析（純函式）----
const A = require('../scripts/lib/cli-args.js');
t('parseWriteMode：--dry-run=true 視為 dry-run，--dry-run=false 不等於 apply', () => {
    assert.equal(S.parseWriteMode(['--apply', '--dry-run=true']).apply, false);
    assert.equal(S.parseWriteMode(['--apply', '--dry-run=true']).explicitDryRun, true);
    assert.equal(S.parseWriteMode(['--dry-run=false']).apply, false);
    assert.equal(S.parseWriteMode(['--dry-run=false']).explicitDryRun, false);
    assert.equal(S.parseWriteMode(['--apply', '--dry-run=false']).apply, true);
});
t('parseWriteMode：dryRunFalseIsApply 只在明確要求時把 --dry-run=false 當 apply', () => {
    const o = { dryRunFalseIsApply: true };
    assert.equal(S.parseWriteMode(['--dry-run=false'], o).apply, true);
    assert.equal(S.parseWriteMode(['--dry-run=false', '--dry-run'], o).apply, false);
    assert.equal(S.parseWriteMode(['--dry-run=false', '--dry-run=true'], o).apply, false);
});
t('bootstrap-platform-admin：--dry-run 與 --apply 不論順序都不寫（M1）', () => {
    assert.equal(A.parseAdminArgs(['--uid=u', '--dry-run', '--apply']).dryRun, true);
    assert.equal(A.parseAdminArgs(['--uid=u', '--apply', '--dry-run']).dryRun, true);
    assert.equal(A.parseAdminArgs(['--uid=u', '--apply', '--dry-run=true']).dryRun, true);
    assert.equal(A.parseAdminArgs(['--uid=u', '--dry-run=true', '--apply']).dryRun, true);
});
t('bootstrap-platform-admin：--dry-run=false 相容為 apply，但與 dry-run 旗標並存仍不寫', () => {
    assert.equal(A.parseAdminArgs(['--uid=u', '--dry-run=false']).dryRun, false);
    assert.equal(A.parseAdminArgs(['--uid=u', '--dry-run=false', '--dry-run']).dryRun, true);
    assert.equal(A.parseAdminArgs(['--uid=u', '--dry-run', '--dry-run=false']).dryRun, true);
    assert.equal(A.parseAdminArgs(['--uid=u', '--dry-run=false', '--dry-run=true']).dryRun, true);
});
t('bootstrap-platform-admin：預設 dry-run、--apply 才寫、未知參數丟錯', () => {
    assert.equal(A.parseAdminArgs(['--uid=u']).dryRun, true);
    assert.equal(A.parseAdminArgs(['--uid=u', '--apply']).dryRun, false);
    assert.throws(() => A.parseAdminArgs(['--uid=u', '--bogus']), /未知參數/);
});
t('firestore-bootstrap-inhu：值參數不得吃掉 -- 開頭的 token', () => {
    assert.throws(() => A.parseInhuArgs(['--add-teacher', '--name', '--apply']), /--name/);
    assert.throws(() => A.parseInhuArgs(['--add-teacher', '--email']), /--email/);
    assert.throws(() => A.parseInhuArgs(['--role', '--dry-run']), /--role/);
    assert.throws(() => A.parseInhuArgs(['--bogus']), /未知參數/);
    const f = A.parseInhuArgs(['--add-teacher', '--name', '甲', '--email', 'a@b.c', '--domains', '國文,英文', '--apply', '--project=demo-x']);
    assert.equal(f.name, '甲'); assert.deepEqual(f.domains, ['國文', '英文']);
});
t('resolveTarget：FIRESTORE_EMULATOR_HOST 為空字串或空白 → 丟錯，不落回正式（建議 1）', () => {
    assert.throws(() => S.resolveTarget({ FIRESTORE_EMULATOR_HOST: '' }), /為空/);
    assert.throws(() => S.resolveTarget({ FIRESTORE_EMULATOR_HOST: '   ' }), /為空/);
    assert.doesNotThrow(() => S.resolveTarget({}));
});
t('rejectIfEmulator：有定義（含空字串）就丟錯', () => {
    assert.throws(() => S.rejectIfEmulator({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }, 'x.js'), /不支援 emulator/);
    assert.throws(() => S.rejectIfEmulator({ FIRESTORE_EMULATOR_HOST: '' }, 'x.js'));
    assert.doesNotThrow(() => S.rejectIfEmulator({}, 'x.js'));
});

// ---- 子行程：在 emulator 環境變數下執行，皆在任何網路請求前返回 ----
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (script, args, env) => {
    const e = { ...process.env };
    delete e.FIRESTORE_EMULATOR_HOST;
    delete e.FIREBASE_AUTH_EMULATOR_HOST;
    Object.assign(e, env);
    return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { env: e, encoding: 'utf8', timeout: 20000 });
};
const DEAD = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:19' };   // 無人監聽；若真的發出請求會失敗而非寫入
t('子行程 bootstrap-platform-admin：空的 FIRESTORE_EMULATOR_HOST 丟錯', () => {
    const r = run('bootstrap-platform-admin.js', ['--list'], { FIRESTORE_EMULATOR_HOST: '' });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /為空/);
});
t('子行程 bootstrap-platform-admin：未知參數 exit 2', () => {
    const r = run('bootstrap-platform-admin.js', ['--uid=u', '--bogus'], DEAD);
    assert.equal(r.status, 2); assert.match(r.stderr, /未知參數/);
});
t('子行程 bootstrap-platform-admin：emulator 下 --email 未設 FIREBASE_AUTH_EMULATOR_HOST → 報錯、不打 identitytoolkit', () => {
    const r = run('bootstrap-platform-admin.js', ['--email=x@example.com'], DEAD);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FIREBASE_AUTH_EMULATOR_HOST/);
});
t('子行程 firestore-bootstrap-inhu：--name 後接旗標 → exit 2', () => {
    const r = run('firestore-bootstrap-inhu.js', ['--add-teacher', '--name', '--apply'], DEAD);
    assert.equal(r.status, 2); assert.match(r.stderr, /--name/);
});
t('子行程 firestore-deploy-rules / emergency-brake：emulator 變數下立即拒絕', () => {
    for (const [sc, a] of [['firestore-deploy-rules.js', ['--list']], ['emergency-brake.js', ['--status']]]) {
        const r = run(sc, a, DEAD);
        assert.equal(r.status, 2, sc); assert.match(r.stderr, /不支援 emulator/, sc);
    }
});

console.log(`\n通過 ${n} 項`);
