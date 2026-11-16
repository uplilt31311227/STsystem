#!/usr/bin/env node
/**
 * 平台管理者建立腳本（Stage 4，RESEARCH-multitenancy-semester.md §4.3）
 *
 * platformAdmins/{uid} 是整套 Stage 4 設計唯一沒有 client 寫入路徑的集合（firestore.rules
 * 對它的 write 規則寫死 `false`），只能由開發者用個人 gcloud 帳號離線寫入——這支腳本就是
 * 那個「離線寫入」的工具，與現行 scripts/firestore-bootstrap-inhu.js 的操作模式一致
 * （REST API + gcloud access token，不透過 client SDK / Security Rules）。
 *
 * 用法：
 *   node scripts/bootstrap-platform-admin.js --uid=abc123              # 預設 --dry-run，只印計畫
 *   node scripts/bootstrap-platform-admin.js --uid=abc123 --apply   # 實際寫入
 *   node scripts/bootstrap-platform-admin.js --email=a@b.com           # 用 email 查 uid 後印計畫
 *   node scripts/bootstrap-platform-admin.js --email=a@b.com --apply
 *   node scripts/bootstrap-platform-admin.js --list                    # 列出目前所有 platformAdmins
 *   node scripts/bootstrap-platform-admin.js --remove --uid=abc123 --apply  # 移除
 *
 * opus 驗收 L6：本腳本以「新增」為主要用途，`--remove` 只是最小必要的移除功能，並內建
 * 「最後一位平台管理者」保護——移除後若名冊會變空，預設拒絕執行，需明確加 `--force-remove-last`
 * 才會放行，避免不慎把系統鎖進「沒有任何人能審核學校申請」的狀態。
 *
 * ⚠ --email= 查 uid 的機制與可靠性：
 *   Firestore 沒有「email → uid」的索引（uid 是 Firebase Auth 概念，不是 Firestore 資料），
 *   本腳本改呼叫 Identity Toolkit Admin REST API（accounts:lookup）用同一顆 gcloud OAuth
 *   token 查詢。這個 API 需要呼叫者在專案上有足夠的 IAM 權限（例如 Firebase Authentication
 *   Admin 或專案 Owner/Editor）——本專案目前唯一的操作者帳號
 *   （operator@example.edu.tw）具備專案 Owner，理論上足夠，但這條路徑*未在本次任務中
 *   實際執行驗證過*（任務範圍明確要求「只寫不執行」）。若 --email= 查詢失敗或回傳的權限
 *   不足，**改用 --uid=** 是最可靠的路徑（uid 可在 Firebase Console → Authentication →
 *   Users 頁面直接複製，或請目標使用者在瀏覽器 devtools 印出 `firebase.auth().currentUser.uid`）。
 *
 * 認證：透過 gcloud auth print-access-token --account=operator@example.edu.tw
 *      （需先 gcloud auth login 完成，與 firestore-bootstrap-inhu.js 相同）
 */
const { execSync } = require('child_process');

const safety = require('./lib/script-safety');
const TARGET = safety.resolveTarget(process.env);
const PROJECT = TARGET.project;
const OPERATOR_EMAIL  = 'operator@example.edu.tw';
const FIRESTORE_BASE = `${safety.databaseBase(TARGET)}/documents`;
// emulator 模式：改打 Auth emulator（FIREBASE_AUTH_EMULATOR_HOST），不得對外打 identitytoolkit。
function identityToolkitBase() {
    if (!TARGET.emulator) return `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}`;
    const h = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    if (!h || !safety.isLocalEmulatorHost(h)) {
        throw new Error('emulator 模式下以 --email= 查 uid 需設定 FIREBASE_AUTH_EMULATOR_HOST（127.0.0.1:<埠>），目前：' + (h || '（未設定）'));
    }
    return `http://${h}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}`;
}

function getToken() {
    return safety.getAccessToken(TARGET, OPERATOR_EMAIL);
}

function buildHeaders(token) {
    return {
        Authorization:         `Bearer ${token}`,
        'Content-Type':        'application/json',
        'X-Goog-User-Project': PROJECT,
    };
}

async function firestoreGet(docPath) {
    const token = getToken();
    const res   = await fetch(`${FIRESTORE_BASE}/${docPath}`, { headers: buildHeaders(token) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} GET ${docPath}\n${(await res.text()).slice(0, 300)}`);
    return res.json();
}

async function firestorePatch(docPath, fields) {
    const token = getToken();
    const res   = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
        method:  'PATCH',
        headers: buildHeaders(token),
        body:    JSON.stringify({ fields }),
    });
    if (!res.ok) throw new Error(`${res.status} PATCH ${docPath}\n${(await res.text()).slice(0, 300)}`);
    return res.json();
}

async function firestoreDelete(docPath) {
    const token = getToken();
    const res   = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
        method:  'DELETE',
        headers: buildHeaders(token),
    });
    if (!res.ok && res.status !== 404) throw new Error(`${res.status} DELETE ${docPath}\n${(await res.text()).slice(0, 300)}`);
}

async function firestoreListCollection(collectionPath) {
    const token = getToken();
    const res   = await fetch(`${FIRESTORE_BASE}/${collectionPath}`, { headers: buildHeaders(token) });
    if (!res.ok) throw new Error(`${res.status} GET ${collectionPath}\n${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    return data.documents || [];
}

/**
 * 用 email 查 Firebase Auth uid（見檔頭「可靠性」說明，未實際驗證過，失敗時給出明確的
 * --uid= 替代路徑指引，不靜默失敗）。
 */
async function lookupUidByEmail(email) {
    const token = getToken();
    const res = await fetch(`${identityToolkitBase()}/accounts:lookup`, {
        method:  'POST',
        headers: buildHeaders(token),
        body:    JSON.stringify({ email: [email] }),
    });
    const txt = await res.text();
    if (!res.ok) {
        throw new Error(
            `Identity Toolkit accounts:lookup 失敗（${res.status}）：${txt.slice(0, 300)}\n` +
            `建議改用 --uid=（在 Firebase Console → Authentication → Users 頁面複製該使用者的 User UID）。`
        );
    }
    const data = JSON.parse(txt);
    const user = (data.users || [])[0];
    if (!user) throw new Error(`查無此 email 的 Firebase Auth 使用者：${email}（請確認對方至少登入過一次系統）`);
    return user.localId;
}

const v = {
    str:  s => ({ stringValue: s ?? '' }),
    time: t => ({ timestampValue: t || new Date().toISOString() }),
};

function unwrap(field) {
    if (!field) return null;
    if ('stringValue'    in field) return field.stringValue;
    if ('timestampValue' in field) return field.timestampValue;
    return null;
}

function docFieldsToObj(doc) {
    if (!doc?.fields) return {};
    return Object.fromEntries(Object.entries(doc.fields).map(([k, val]) => [k, unwrap(val)]));
}

function parseArgs() {
    try {
        return require('./lib/cli-args').parseAdminArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`❌ ${e.message}`);
        printUsage();
        process.exit(2);
    }
}

function printUsage() {
    console.log('用法：');
    console.log('  node scripts/bootstrap-platform-admin.js --uid=<uid> [--note="說明"] [--apply]');
    console.log('  node scripts/bootstrap-platform-admin.js --email=<email> [--apply]');
    console.log('  node scripts/bootstrap-platform-admin.js --list');
    console.log('  node scripts/bootstrap-platform-admin.js --remove --uid=<uid> [--apply]');
    console.log('  node scripts/bootstrap-platform-admin.js --remove --uid=<uid> --force-remove-last --apply');
    console.log('      （--remove 目標是「目前唯一」的平台管理者時，預設會被拒絕；確定要移除到空名冊才加這個旗標）');
    console.log('（不帶 --apply 一律只印計畫、不寫入，這是預設安全閘；--dry-run／--dry-run=true 與 --apply 並存時以 dry-run 為準；--dry-run=false 為相容寫法，等同 --apply）');
    console.log('（opus 驗收 L6：本腳本以新增為主要用途，--remove 只做最小必要的移除功能，並內建「最後一位管理者」保護）');
}

async function main() {
    const flags = parseArgs();
    safety.targetBanner(TARGET, { action: flags.list ? '列出平台管理者（唯讀）' : flags.remove ? '移除平台管理者' : '新增平台管理者', apply: flags.list ? undefined : !flags.dryRun }).forEach(l => console.log(l));

    if (flags.list) {
        console.log(`📡 列出 platformAdmins（專案 ${PROJECT}）\n`);
        const docs = await firestoreListCollection('platformAdmins');
        if (docs.length === 0) {
            console.log('（目前沒有任何平台管理者）');
        } else {
            docs.forEach(doc => {
                const uid = doc.name.split('/').pop();
                const data = docFieldsToObj(doc);
                console.log(`  - ${uid}  note=${data.note || '(無)'}  addedAt=${data.addedAt || '(未知)'}  addedBy=${data.addedBy || '(未知)'}`);
            });
        }
        return;
    }

    if (!flags.uid && !flags.email) {
        console.error('❌ 需要 --uid= 或 --email=（或用 --list 查看現有名冊）');
        printUsage();
        process.exit(2);
    }

    let uid = flags.uid;
    if (!uid) {
        console.log(`🔍 以 email 查 uid：${flags.email}`);
        uid = await lookupUidByEmail(flags.email);
        console.log(`   ✓ uid = ${uid}`);
    }

    const docPath = `platformAdmins/${uid}`;

    if (flags.remove) {
        // opus 驗收 L6：最後一位平台管理者保護——若移除後名冊會變成空的，整個系統會進入
        // 「沒有任何人能核准/駁回學校申請、也沒有任何人能再用本腳本補建（因為 platformAdmins
        // 的 write 規則對 client 恆為 false，只有這支離線腳本能寫，而這支腳本本身不受任何
        // 名冊狀態限制——理論上還是能重新建立，但等於自己先把自己鎖死一次再手動修，風險與
        // 麻煩都不必要），直接擋下，除非明確加 --force-remove-last。
        const remaining = await firestoreListCollection('platformAdmins');
        const willBeEmpty = remaining.length <= 1
            && remaining.every(doc => doc.name.split('/').pop() === uid);
        if (willBeEmpty && !flags.forceRemoveLast) {
            console.error(
                `❌ 拒絕移除：${uid} 是目前唯一的平台管理者，移除後將沒有任何人能審核學校申請、\n` +
                `   也沒有其他 platformAdmin 帳號可以立即補建（仍可用本腳本以其他管理者身份重建，\n` +
                `   但那需要「先有另一個能執行本腳本的人」，等於自我鎖死）。\n` +
                `   若確定要移除（例如帳號已由其他管理者妥善接手，且會立即用 --uid= 補建新的），\n` +
                `   請加上 --force-remove-last --apply 明確表達意圖。`
            );
            process.exit(2);
        }
        console.log(`📋 計畫：刪除 ${docPath}`);
        if (flags.dryRun) {
            console.log('🚧 dry-run（預設）：不會實際刪除。加上 --apply 才會真的執行。');
            return;
        }
        await firestoreDelete(docPath);
        console.log(`✅ 已移除平台管理者：${uid}`);
        return;
    }

    const existing = await firestoreGet(docPath);
    if (existing) {
        console.log(`✓ ${docPath} 已存在，無需重複建立（${JSON.stringify(docFieldsToObj(existing))}）`);
        return;
    }

    const fields = {
        addedAt: v.time(),
        addedBy: v.str(OPERATOR_EMAIL),
        note:    v.str(flags.note || ''),
    };
    console.log(`📋 計畫：建立 ${docPath}`);
    console.log(`   欄位：${JSON.stringify({ addedAt: '(now)', addedBy: OPERATOR_EMAIL, note: flags.note || '(空)' })}`);
    if (flags.dryRun) {
        console.log('🚧 dry-run（預設）：不會實際寫入。確認無誤後加上 --apply 才會真的執行。');
        return;
    }
    await firestorePatch(docPath, fields);
    console.log(`✅ 已將 ${uid} 加入平台管理者名冊。`);
}

main().catch(e => { console.error('\n❌ 失敗：', e.message); process.exit(1); });
