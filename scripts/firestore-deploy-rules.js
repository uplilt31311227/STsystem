#!/usr/bin/env node
/**
 * Firestore 安全規則部署腳本
 *
 * 用法：
 *   node scripts/firestore-deploy-rules.js                                  # 預設：只印目標專案、git 狀態與將做的事（不呼叫任何 API）
 *   node scripts/firestore-deploy-rules.js --dry                            # 只建立 ruleset，不發布
 *   node scripts/firestore-deploy-rules.js --list                           # 列出最近 5 個 ruleset 與目前 release
 *   node scripts/firestore-deploy-rules.js --apply --confirm=<專案ID>       # 實際部署（需 git 工作樹乾淨，且 confirm 與目標專案一致）
 *
 *   --project=<id>  目標 Firebase 專案，預設正式專案 stsystem-9d5fe。
 *                   測試站專案（STsystem-preview）傳 --project=<測試專案 id>。
 *                   同一份 firestore.rules 兩邊共用，規則不分站。
 *
 * 流程：
 *   1. 讀本地 firestore.rules
 *   2. POST /rulesets 建立新 ruleset
 *   3. PATCH /releases/cloud.firestore 把 release 指向新 ruleset
 *
 * 認證：透過 gcloud auth print-access-token --account=operator@example.edu.tw
 *
 * 出處對齊：docs/V2_PERMISSION_SYSTEM.md「1b. Firestore 安全規則」段落。
 */
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const safety       = require('./lib/script-safety');

// 本腳本打 firebaserules.googleapis.com，不支援 emulator；偵測到 emulator 變數一律拒絕（在任何網路請求前）。
try { safety.rejectIfEmulator(process.env, 'firestore-deploy-rules.js'); } catch (e) { console.error('❌ ' + e.message); process.exit(2); }

/** 正式專案；測試站用 --project= 覆寫，避免把規則部署錯邊。 */
const DEFAULT_PROJECT = 'stsystem-9d5fe';
const PROJECT = process.argv.find(a => a.startsWith('--project='))?.split('=')[1] || DEFAULT_PROJECT;

// 規則部署是會立刻生效的動作，目標專案一律先印出來，免得部署錯邊才發現。
console.log(PROJECT === DEFAULT_PROJECT
    ? `🎯 目標專案：${PROJECT}（正式）`
    : `🎯 目標專案：${PROJECT}（非正式專案）`);
const RULES_FILE = path.resolve(__dirname, '..', 'firestore.rules');
const RULES_API  = `https://firebaserules.googleapis.com/v1/projects/${PROJECT}`;

function getToken() {
    return execSync('gcloud auth print-access-token --account=operator@example.edu.tw')
        .toString().trim();
}

async function api(method, urlSuffix, body) {
    const token = getToken();
    const init  = {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Goog-User-Project': PROJECT,
        },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(`${RULES_API}${urlSuffix}`, init);
    const txt = await res.text();
    if (!res.ok) {
        throw new Error(`${res.status} ${method} ${urlSuffix}\n${txt}`);
    }
    return txt ? JSON.parse(txt) : {};
}

async function listRulesets() {
    const data = await api('GET', '/rulesets?pageSize=5');
    const release = await api('GET', '/releases/cloud.firestore');
    return {
        rulesets: data.rulesets || [],
        currentRulesetName: release.rulesetName,
    };
}

async function createRuleset(rulesSource) {
    return api('POST', '/rulesets', {
        source: {
            files: [
                { name: 'firestore.rules', content: rulesSource },
            ],
        },
    });
}

async function publishRelease(rulesetName) {
    // body 須包 release 物件（對齊 firebase-tools rulesDeploy.ts 的呼叫格式）
    return api('PATCH', '/releases/cloud.firestore', {
        release: {
            name:         `projects/${PROJECT}/releases/cloud.firestore`,
            rulesetName,
        },
    });
}

function printUsage() {
    console.log('用法：');
    console.log('  node scripts/firestore-deploy-rules.js                              # 只印目標專案／git 狀態／將做的事，不呼叫 API');
    console.log('  node scripts/firestore-deploy-rules.js --dry                        # 只建立 ruleset，不發布');
    console.log('  node scripts/firestore-deploy-rules.js --list                       # 列出最近 5 個 ruleset 與目前 release');
    console.log('  node scripts/firestore-deploy-rules.js --apply --confirm=<專案ID>   # 實際部署（git 工作樹須乾淨）');
    console.log('  node scripts/firestore-deploy-rules.js --help                       # 顯示本說明');
}

function printGitState(git) {
    console.log(`🌿 git：分支 ${git.branch}，目前 commit ${git.head}`);
    console.log(git.clean ? '   工作樹乾淨（已追蹤檔案無未提交變更）' : `   ⚠ 工作樹有未提交的已追蹤檔案變更：\n     ${git.dirtyFiles.join('\n     ')}`);
}

async function main() {
    // 安全閘：未知旗標一律中止，不可退化成「不帶參數 = 正式部署」（2026-07-29 事故）。
    // 現在不帶參數只會印計畫；實際部署必須 --apply --confirm=<專案ID>。
    const parsed = safety.parseDeployArgs(process.argv.slice(2), PROJECT);
    if (parsed.mode === 'error') {
        parsed.errors.forEach(e => console.error(`❌ ${e}`));
        printUsage();
        process.exit(2);
    }
    const flag = { help: '--help', list: '--list', validate: '--dry', plan: '', deploy: '--apply' }[parsed.mode];

    if (flag === '--help') {
        printUsage();
        return;
    }

    if (flag === '--list') {
        const { rulesets, currentRulesetName } = await listRulesets();
        console.log(`目前 release → ${currentRulesetName}`);
        console.log('最近 ruleset：');
        rulesets.forEach(r => {
            const mark = r.name === currentRulesetName ? '★' : ' ';
            console.log(`  ${mark} ${r.name}  createTime=${r.createTime}`);
        });
        return;
    }

    let git;
    try { git = safety.readGitState(path.resolve(__dirname, '..')); }
    catch (e) { git = null; console.error(`⚠ 無法讀取 git 狀態：${e.message}`); }
    if (git) printGitState(git);

    if (parsed.mode === 'plan') {
        console.log(`\n🛈  預設不執行。將會：讀取 firestore.rules → 在 ${PROJECT} 建立 ruleset → 發布 release。`);
        console.log(`   要實際部署請加：--apply --confirm=${PROJECT}`);
        return;
    }
    if (parsed.mode === 'deploy') {
        if (!git) { console.error('❌ 無法確認 git 狀態，拒絕部署。'); process.exit(2); }
        if (!git.clean) { console.error('❌ git 工作樹不乾淨，拒絕部署（請先 commit 或還原已追蹤檔案的變更）。'); process.exit(2); }
        console.log(`⚠️  即將部署 commit ${git.head} 的 firestore.rules 到 ${PROJECT}`);
    }

    if (!fs.existsSync(RULES_FILE)) {
        throw new Error(`找不到規則檔：${RULES_FILE}`);
    }
    const source = fs.readFileSync(RULES_FILE, 'utf8');
    console.log(`📄 讀取 ${RULES_FILE}（${source.length} 字元）`);

    console.log('🛠  建立 ruleset...');
    const ruleset = await createRuleset(source);
    console.log(`   ✓ ${ruleset.name}`);

    if (flag === '--dry') {
        console.log('🚧 --dry 模式：未發布 release。');
        console.log('   可用 --list 觀察 ruleset 是否存在；下次部署需手動 PATCH release。');
        return;
    }

    console.log('🚀 發布 release（cloud.firestore → 新 ruleset）...');
    await publishRelease(ruleset.name);
    console.log('✅ 部署完成。');
    console.log('   驗證：node scripts/firestore-deploy-rules.js --list');
}

main().catch(e => {
    console.error('❌ 失敗：', e.message);
    process.exit(1);
});
