#!/usr/bin/env node
/**
 * Firestore 安全規則部署腳本
 *
 * 用法：
 *   node scripts/firestore-deploy-rules.js          # 部署 firestore.rules
 *   node scripts/firestore-deploy-rules.js --dry    # 只建立 ruleset，不發布
 *   node scripts/firestore-deploy-rules.js --list   # 列出最近 5 個 ruleset 與目前 release
 *
 * 流程：
 *   1. 讀本地 firestore.rules
 *   2. POST /rulesets 建立新 ruleset
 *   3. PATCH /releases/cloud.firestore 把 release 指向新 ruleset
 *
 * 認證：透過 gcloud auth print-access-token --account=uplilt31311227@gmail.com
 *
 * 出處對齊：docs/V2_PERMISSION_SYSTEM.md「1b. Firestore 安全規則」段落。
 */
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const PROJECT  = 'stsystem-9d5fe';
const RULES_FILE = path.resolve(__dirname, '..', 'firestore.rules');
const RULES_API  = `https://firebaserules.googleapis.com/v1/projects/${PROJECT}`;

function getToken() {
    return execSync('gcloud auth print-access-token --account=uplilt31311227@gmail.com')
        .toString().trim();
}

async function api(method, urlSuffix, body) {
    const token = getToken();
    const init  = {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
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
    return api('PATCH', '/releases/cloud.firestore?updateMask=rulesetName', {
        name:         `projects/${PROJECT}/releases/cloud.firestore`,
        rulesetName,
    });
}

async function main() {
    const flag = process.argv[2] || '';

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
