/**
 * 管理腳本共用的安全判斷（純函式為主，方便單元測試：test/test-script-safety.mjs）
 *
 * 約定：
 *   - 會寫入的腳本預設 dry-run；實際寫入必須明確帶 --apply（舊腳本的 --yes 仍視為等價旗標）。
 *   - 同時帶 --dry-run 與 --apply 時以 dry-run 為準（保守）。
 *   - 執行前一律印出目標專案 ID（banner）。
 *   - 設定 FIRESTORE_EMULATOR_HOST（只接受 127.0.0.1／localhost）時，腳本改打 emulator、
 *     專案固定 demo-*、不呼叫 gcloud——用來對 emulator 驗證 dry-run，不碰正式專案。
 */
const { execSync } = require('child_process');

const PROD_PROJECT = 'stsystem-9d5fe';
const EMULATOR_PROJECT = 'demo-stsystem';

/** 取 --name=value 的 value；沒有則 undefined。 */
function getArgValue(argv, name) {
    const prefix = `--${name}=`;
    const hit = argv.find(a => a.startsWith(prefix));
    return hit === undefined ? undefined : hit.slice(prefix.length);
}

/**
 * 解析「寫入模式」。
 * @param {string[]} argv 不含 node 與腳本路徑的參數
 * @param {{applyAliases?: string[], dryRunFalseIsApply?: boolean}} [opts] applyAliases：等價於 --apply 的舊旗標（例如 ['--yes']）；dryRunFalseIsApply：把 --dry-run=false 當 apply（僅 bootstrap-platform-admin 相容用）
 * @returns {{apply: boolean, dryRun: boolean, explicitDryRun: boolean}}
 */
function parseWriteMode(argv, opts = {}) {
    const applyFlags = ['--apply', ...(opts.applyAliases || [])];
    // --dry-run=false 預設視為「未指定 dry-run」，不等於 apply；只有呼叫端明確要求相容時才當 apply。
    if (opts.dryRunFalseIsApply) applyFlags.push('--dry-run=false');
    const wantsApply = argv.some(a => applyFlags.includes(a));
    const explicitDryRun = argv.includes('--dry-run') || argv.includes('--dry-run=true');
    const apply = wantsApply && !explicitDryRun;
    return { apply, dryRun: !apply, explicitDryRun };
}

/** 找出不在白名單內的參數（--key=value 形式比對 --key=）。 */
function findUnknownFlags(argv, knownFlags, knownPrefixes = []) {
    return argv.filter(a => {
        if (knownFlags.includes(a)) return false;
        return !knownPrefixes.some(p => a.startsWith(p));
    });
}

function isLocalEmulatorHost(h) {
    return typeof h === 'string' && /^(127\.0\.0\.1|localhost):\d{2,5}$/.test(h);
}

/**
 * 決定目標。emulator 優先：只要設了 FIRESTORE_EMULATOR_HOST 就必須是本機位址，否則丟錯。
 * @returns {{emulator: boolean, project: string, firestoreOrigin: string, isProd: boolean}}
 */
function resolveTarget(env, requestedProject) {
    const host = env.FIRESTORE_EMULATOR_HOST;
    if (host !== undefined) {
        if (String(host).trim() === '') {
            throw new Error('FIRESTORE_EMULATOR_HOST 已定義但為空，拒絕落回正式專案；請設為 127.0.0.1:<埠> 或取消設定');
        }
        if (!isLocalEmulatorHost(host)) {
            throw new Error(`FIRESTORE_EMULATOR_HOST 必須是 127.0.0.1 或 localhost（含埠號），目前：${host}`);
        }
        const project = requestedProject && requestedProject.startsWith('demo-') ? requestedProject : EMULATOR_PROJECT;
        return { emulator: true, project, firestoreOrigin: `http://${host}`, isProd: false };
    }
    const project = requestedProject || PROD_PROJECT;
    return { emulator: false, project, firestoreOrigin: 'https://firestore.googleapis.com', isProd: project === PROD_PROJECT };
}

/** Firestore REST 的 database 根（不含 /documents）。 */
function databaseBase(target) {
    return `${target.firestoreOrigin}/v1/projects/${target.project}/databases/(default)`;
}

/** 取得 access token：emulator 用 'owner'（繞過規則），正式環境才呼叫 gcloud。 */
function getAccessToken(target, account) {
    if (target.emulator) return 'owner';
    return execSync(`gcloud auth print-access-token --account=${account}`).toString().trim();
}

/** 執行前的目標橫幅（純函式，回傳字串陣列）。 */
function targetBanner(target, { action, apply, extra } = {}) {
    const where = target.emulator ? '（emulator，本機）' : target.isProd ? '（正式）' : '（非正式專案）';
    const lines = [`🎯 目標專案：${target.project}${where}`];
    if (action) lines.push(`🧭 動作：${action}`);
    if (extra) lines.push(`   ${extra}`);
    if (apply !== undefined) {
        lines.push(apply
            ? '⚠️  模式：--apply，將實際寫入'
            : '🛈  模式：預設 dry-run，不寫入（加 --apply 才會實際執行）');
    }
    return lines;
}

/**
 * 規則部署的旗標判定。
 *   無旗標         → plan：只印目標與將做的事，不呼叫任何 API
 *   --list         → list（唯讀）
 *   --dry          → validate：建立 ruleset 但不發布
 *   --apply --confirm=<專案ID> → deploy（confirm 必須與目標專案一致）
 * @returns {{mode: 'help'|'list'|'plan'|'validate'|'deploy'|'error', errors: string[]}}
 */
function parseDeployArgs(argv, project) {
    const rest = argv.filter(a => !a.startsWith('--project='));
    const known = ['--dry', '--list', '--help', '-h', '--apply'];
    const errors = [];
    for (const a of rest) {
        if (!known.includes(a) && !a.startsWith('--confirm=')) errors.push(`未知參數：${a}`);
    }
    if (errors.length) return { mode: 'error', errors };
    if (rest.includes('--help') || rest.includes('-h')) return { mode: 'help', errors };
    if (rest.includes('--list')) return { mode: 'list', errors };
    const confirm = getArgValue(rest, 'confirm');
    const apply = rest.includes('--apply');
    if (rest.includes('--dry')) {
        if (apply) return { mode: 'error', errors: ['--dry 與 --apply 不可同時使用'] };
        return { mode: 'validate', errors };
    }
    if (apply) {
        if (confirm === undefined) {
            return { mode: 'error', errors: [`部署需同時帶 --confirm=${project}（輸入目標專案 ID 以確認）`] };
        }
        if (confirm !== project) {
            return { mode: 'error', errors: [`--confirm=${confirm} 與目標專案 ${project} 不符，拒絕部署`] };
        }
        return { mode: 'deploy', errors };
    }
    if (confirm !== undefined) {
        return { mode: 'error', errors: ['--confirm 必須搭配 --apply 使用'] };
    }
    return { mode: 'plan', errors };
}

/**
 * 判斷 git 工作樹是否可部署（只看已追蹤檔案的變更；untracked 不影響已提交的 firestore.rules）。
 * @param {string} porcelain `git status --porcelain --untracked-files=no` 的輸出
 */
function evaluateGitState({ porcelain, head, branch }) {
    const dirtyFiles = String(porcelain || '').split('\n').map(s => s.trimEnd()).filter(Boolean);
    return { clean: dirtyFiles.length === 0, dirtyFiles, head: head || '(unknown)', branch: branch || '(detached)' };
}

function readGitState(cwd) {
    const run = (cmd) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();
    return evaluateGitState({
        porcelain: execSync('git status --porcelain --untracked-files=no', { cwd, encoding: 'utf8' }),
        head: run('git log -1 --format=%h%x20%s'),
        branch: run('git branch --show-current'),
    });
}

/** 擋下 emulator 模式下不支援 emulator 的腳本。 */
function rejectIfEmulator(env, scriptName) {
    if (env.FIRESTORE_EMULATOR_HOST !== undefined) {
        throw new Error(`${scriptName} 不支援 emulator（偵測到 FIRESTORE_EMULATOR_HOST），拒絕執行。請取消該環境變數後，依文件對正式／測試專案操作。`);
    }
}

module.exports = {
    rejectIfEmulator,
    PROD_PROJECT, EMULATOR_PROJECT,
    getArgValue, parseWriteMode, findUnknownFlags, isLocalEmulatorHost,
    resolveTarget, databaseBase, getAccessToken, targetBanner,
    parseDeployArgs, evaluateGitState, readGitState,
};
