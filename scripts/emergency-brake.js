#!/usr/bin/env node
/**
 * 緊急煞車腳本（Stage 4，RESEARCH-multitenancy-semester.md §4.5／RESEARCH-blaze-followup.md §2(d)）
 *
 * 背景：查證結果顯示 Blaze 沒有硬性支出上限機制——GCP Budget 只能發警報，不能自動斷流；
 * 唯一的真自動化做法（Budget → Pub/Sub → Cloud Function 呼叫 Cloud Billing API 停用計費）
 * 需要一支 Cloud Function，違背本專案「無自建後端」的架構前提，且一旦誤觸發是整專案斷線
 * （含所有學校）。查證報告的結論是：在無後端條件下，本腳本（一鍵把 firestore.rules 換成
 * 全 deny 版本並部署）是唯一能「立即停止服務」的手段，收到高門檻預算警報後由人工執行，
 * 反應時間可壓到幾分鐘內——不是自動化，是「人工按下的煞車」。
 *
 * 用法：
 *   node scripts/emergency-brake.js --status         # 顯示目前線上規則是否為全 deny（會實際
 *                                                     #   取回 ruleset 內容比對，見下）、本機是否
 *                                                     #   有待還原的備份（不異動任何東西）
 *   node scripts/emergency-brake.js --brake --yes    # 拉下煞車：備份目前 firestore.rules 到
 *                                                     #   firestore.rules.emergency-backup，
 *                                                     #   建立「全 deny」ruleset 並立即發布上線
 *   node scripts/emergency-brake.js --restore --yes  # 解除煞車：從備份還原 firestore.rules 內容
 *                                                     #   並重新部署（不會自動刪除備份檔，供人工核對）
 *
 * opus 驗收 H1：拉煞車／還原這兩個有副作用的動作，都必須**同時**帶對應動作旗標與 `--yes`
 * 才會執行；裸執行（不帶任何參數）只印用法說明，**不會**觸發任何動作——這是本次驗收明確要求
 * 的收斂：原版把「不帶參數」設計成預設就是拉煞車，對一個「一鍵讓全平台斷線」的腳本而言，
 * 誤觸發的代價太高，不該讓「忘記加參數」變成最危險的那個結果。
 *
 * 安全閘（比照 firestore-deploy-rules.js 2026-07-29 事故後加的「未知旗標一律中止」慣例）：
 *   未知旗標直接中止，不會退化成任何預設動作。
 *
 * 認證：透過 gcloud auth print-access-token --account=uplilt31311227@gmail.com
 *      （需先 gcloud auth login 完成，與 firestore-deploy-rules.js 相同）
 *
 * ⚠ 本次任務範圍只寫這支腳本，不執行。實際使用前務必先跑 `--status` 確認現況。
 */
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const PROJECT      = 'stsystem-9d5fe';
const RULES_FILE   = path.resolve(__dirname, '..', 'firestore.rules');
const BACKUP_FILE  = path.resolve(__dirname, '..', 'firestore.rules.emergency-backup');
const RULES_API    = `https://firebaserules.googleapis.com/v1/projects/${PROJECT}`;
const RULES_API_ROOT = 'https://firebaserules.googleapis.com/v1';

// 全 deny 規則：唯一保留 rules_version 宣告（Firestore 要求），其餘一律拒絕。
// 刻意不特殊處理 platformAdmins 等任何集合——煞車的定義就是「所有人都進不去，包含平台
// 管理者」，避免留一個「還能動」的路徑被誤用或被攻擊者利用。
const DENY_ALL_RULES = `rules_version = '2';

// ⚠ 緊急煞車模式（scripts/emergency-brake.js 部署，見該檔檔頭說明）
// 全部拒絕讀寫，不分集合、不分角色。用 --restore 還原正常規則。
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

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

/**
 * opus 驗收 M2：呼叫 Rules API 的 `projects.rulesets.get`，用完整資源路徑（release 回傳的
 * `rulesetName` 本身就是 `projects/{project}/rulesets/{id}` 這種完整路徑，不能再套用上面
 * `api()` 那個已經固定了 `/projects/{project}` 前綴的 base URL，否則路徑會重複），取回
 * ruleset 的原始規則內容（`source.files[].content`）。
 *
 * 訂正：原版檔頭曾誤寫「本 API 不提供規則原始內容下載端點」——這是錯的，`rulesets.get` 本來
 * 就會回傳完整的 `source.files[].content`，`--status` 因此可以直接比對線上規則是否為全 deny
 * 版本，不需要依賴外部工具或人工到 Console 檢視。
 */
async function getRulesetContent(rulesetName) {
    const token = getToken();
    const res = await fetch(`${RULES_API_ROOT}/${rulesetName}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': PROJECT },
    });
    const txt = await res.text();
    if (!res.ok) {
        throw new Error(`${res.status} GET ${rulesetName}\n${txt}`);
    }
    const ruleset = txt ? JSON.parse(txt) : {};
    const file = (ruleset.source?.files || [])[0];
    return file?.content ?? '';
}

async function createRuleset(rulesSource) {
    return api('POST', '/rulesets', {
        source: { files: [{ name: 'firestore.rules', content: rulesSource }] },
    });
}

async function publishRelease(rulesetName) {
    return api('PATCH', '/releases/cloud.firestore', {
        release: {
            name:        `projects/${PROJECT}/releases/cloud.firestore`,
            rulesetName,
        },
    });
}

async function getCurrentReleaseInfo() {
    const release = await api('GET', '/releases/cloud.firestore');
    return release.rulesetName;
}

async function deployRules(source, label) {
    console.log(`🛠  建立 ruleset（${label}）...`);
    const ruleset = await createRuleset(source);
    console.log(`   ✓ ${ruleset.name}`);
    console.log('🚀 發布 release（cloud.firestore → 新 ruleset）...');
    await publishRelease(ruleset.name);
    console.log('✅ 部署完成。');
}

async function cmdStatus() {
    const rulesetName = await getCurrentReleaseInfo();
    console.log(`目前線上 release → ${rulesetName}`);

    // opus 驗收 M2：實際取回線上 ruleset 內容並與 DENY_ALL_RULES 比對（trim 後逐字比較，
    // 兩者皆為本腳本/固定字面值產生，不需要更寬鬆的語意比對）。
    try {
        const liveContent = await getRulesetContent(rulesetName);
        if (liveContent.trim() === DENY_ALL_RULES.trim()) {
            console.log('🚨 目前線上規則「就是」緊急煞車的全 deny 版本——服務目前處於停止狀態。');
        } else {
            console.log('✅ 目前線上規則不是全 deny 版本（服務應為正常狀態，仍建議另行確認業務功能是否正常）。');
        }
    } catch (e) {
        console.warn(`⚠ 無法取回目前 ruleset 內容以比對是否為全 deny 版本：${e.message}`);
    }

    console.log(fs.existsSync(BACKUP_FILE)
        ? `本機存在備份檔：${BACKUP_FILE}（可能代表煞車已拉下、尚未還原，或還原後忘了清備份——請以上面的內容比對結果為準）`
        : `本機無備份檔（一般狀態：從未拉過煞車，或已還原並清過備份）`);
}

async function cmdBrake() {
    if (!fs.existsSync(RULES_FILE)) {
        throw new Error(`找不到規則檔：${RULES_FILE}`);
    }
    if (fs.existsSync(BACKUP_FILE)) {
        throw new Error(
            `已存在備份檔 ${BACKUP_FILE}——代表可能已經拉過一次煞車、或上次還原後忘了清備份。\n` +
            `為避免覆蓋掉「真正的正常規則」備份，本腳本拒絕在備份檔存在時再次拉煞車。\n` +
            `請先確認線上現況（node scripts/emergency-brake.js --status），\n` +
            `若確定要還原，用 --restore --yes；若確定要用目前 firestore.rules 內容覆蓋備份重新拉一次煞車，\n` +
            `請先手動刪除 ${BACKUP_FILE} 後再重跑本指令。`
        );
    }
    const currentRules = fs.readFileSync(RULES_FILE, 'utf8');
    fs.writeFileSync(BACKUP_FILE, currentRules, 'utf8');
    console.log(`💾 已備份目前 firestore.rules → ${BACKUP_FILE}（${currentRules.length} 字元）`);

    await deployRules(DENY_ALL_RULES, '全 deny');
    console.log('\n⚠️  緊急煞車已生效：所有讀寫（含平台管理者）皆被拒絕。');
    console.log('    問題排除後，執行 `node scripts/emergency-brake.js --restore --yes` 還原。');
}

async function cmdRestore() {
    if (!fs.existsSync(BACKUP_FILE)) {
        throw new Error(`找不到備份檔 ${BACKUP_FILE}——沒有東西可還原。若規則已被手動改過，請改用 node scripts/firestore-deploy-rules.js 直接部署 firestore.rules。`);
    }
    const backupSource = fs.readFileSync(BACKUP_FILE, 'utf8');
    await deployRules(backupSource, '還原自備份');
    console.log(`\n✅ 已還原並部署備份內容。備份檔 ${BACKUP_FILE} 保留供人工核對，確認無誤後可自行刪除。`);
    console.log('   建議：還原後跑一次 node scripts/firestore-deploy-rules.js --list 確認 ruleset 已切換，或 --status 重新比對內容。');
}

const KNOWN_FLAGS = ['--status', '--brake', '--restore', '--yes', '--help', '-h'];

function printUsage() {
    console.log('用法：');
    console.log('  node scripts/emergency-brake.js --status           # 顯示現況（含線上規則內容比對），不異動任何東西');
    console.log('  node scripts/emergency-brake.js --brake --yes      # 拉下煞車（部署全 deny 規則，先備份現有規則）');
    console.log('  node scripts/emergency-brake.js --restore --yes    # 從備份還原並重新部署');
    console.log('');
    console.log('opus 驗收 H1：--brake／--restore 都必須同時帶 --yes 才會真的執行；裸執行（不帶任何參數）只印這段說明，不會拉煞車。');
}

async function main() {
    const args = process.argv.slice(2);
    for (const a of args) {
        if (!KNOWN_FLAGS.includes(a)) {
            console.error(`❌ 未知參數：${a}`);
            printUsage();
            process.exit(2);
        }
    }
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        printUsage();
        return;
    }
    if (args.includes('--status')) { await cmdStatus(); return; }

    const hasYes = args.includes('--yes');
    if (args.includes('--brake')) {
        if (!hasYes) {
            console.error('❌ --brake 必須同時帶 --yes 才會執行（安全閘，見檔頭 H1 說明）。');
            printUsage();
            process.exit(2);
        }
        await cmdBrake();
        return;
    }
    if (args.includes('--restore')) {
        if (!hasYes) {
            console.error('❌ --restore 必須同時帶 --yes 才會執行（安全閘，見檔頭 H1 說明）。');
            printUsage();
            process.exit(2);
        }
        await cmdRestore();
        return;
    }

    // 只帶 --yes、沒帶 --brake/--restore/--status：不知道要對哪個動作生效，一律印用法。
    printUsage();
}

main().catch(e => { console.error('\n❌ 失敗：', e.message); process.exit(1); });
