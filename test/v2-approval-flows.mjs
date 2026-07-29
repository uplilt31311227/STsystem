/**
 * V2 審核工作流 e2e 驗收腳本（preview 站，真實測試帳號）
 *
 * 涵蓋：
 *   步驟1：組長丙上傳課表（解鎖系統）+ teachers 集合前後差異比對
 *   步驟2：代課單簽 / 調課雙簽 / 多重調課全員同意 / 中途拒絕，四條完整生命週期
 *   步驟3：教師身份權限邊界複驗（月結算／調代課紀錄／課表匯入按鈕）
 *
 * 用法：
 *   PowerShell:  $env:STSYSTEM_TEST_PW = "..."; node test/v2-approval-flows.mjs
 *   bash:        STSYSTEM_TEST_PW="..." node test/v2-approval-flows.mjs
 *
 * 密碼刻意不寫死在檔案內，一律從環境變數 STSYSTEM_TEST_PW 讀取；缺少時說明後 exit 2。
 *
 * 安全設計：
 *   - 所有 Firestore 讀取一律走唯讀 REST（gcloud access token），本檔案內沒有任何寫入 REST 呼叫，
 *     所有「寫入」動作一律透過真實瀏覽器操作 preview 站 UI（走應用程式自己的程式碼路徑與 rules）。
 *   - 所有測試請求的 subject／reason／rejectNote 皆帶有「[測試]」字樣，便於事後在 Firestore 主控台辨識。
 *   - 執行結果（各流程建立的文件路徑與最終狀態）寫入 test/.last-test-docs.json 供事後清理比對。
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_DIR  = path.join(__dirname, 'e2e-screenshots');
const DOCS_FILE   = path.join(__dirname, '.last-test-docs.json');
const SCRATCH_DIR = 'C:\\Users\\uplil\\AppData\\Local\\Temp\\claude\\C--Users-uplil-sideprojet-STsystem\\af9a3c19-dd93-45b3-92cd-e97c9633ce40\\scratchpad';

mkdirSync(SCREEN_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 密碼：只能來自環境變數，缺少時說明後 exit 2（不可寫死於檔案內）
// ---------------------------------------------------------------------------
const PW = process.env.STSYSTEM_TEST_PW;
if (!PW) {
    console.error(`
[缺少環境變數] STSYSTEM_TEST_PW 未設定，無法登入測試帳號。

本腳本刻意不把密碼寫在檔案內。請先設定環境變數再執行：

  PowerShell:
    $env:STSYSTEM_TEST_PW = "<測試帳號密碼>"
    node test/v2-approval-flows.mjs

  bash:
    STSYSTEM_TEST_PW="<測試帳號密碼>" node test/v2-approval-flows.mjs

密碼請向專案負責人索取。
`);
    process.exit(2);
}

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------
const PREVIEW_URL     = 'https://uplilt31311227.github.io/STsystem-preview/';
const PROJECT         = 'stsystem-9d5fe';
const SCHOOL_ID       = 'inhu';
const GCLOUD_ACCOUNT  = 'uplilt31311227@gmail.com';
const REST_BASE       = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const ACCOUNTS = {
    teacherA: { email: 'uplilt31311227+v2t1@gmail.com', name: '[測試]教師甲' },
    teacherB: { email: 'uplilt31311227+v2t2@gmail.com', name: '[測試]教師乙' },
    chief:    { email: 'uplilt31311227+v2t3@gmail.com', name: '[測試]組長丙' },
};

// 測試課表：7年1班＝甲/乙四個工作流各自的時段組合；7年2班＝真實既有教師姓名的填充資料
// （優先使用 production 既有真實教師姓名，避免自動匯入比對不到既有教師而產生垃圾資料）
const CSV_HEADER = '週次,節次,年級,班級,教師姓名,身分證字號或居留證號,類別,領域,科目,語言別/校訂課程名稱,上課頻率,起始週';
const CSV_ROWS = [
    ['週一', '第一節', '7年級', '7年1班', '[測試]教師甲', '', '領域學習', '數學領域',       '[測試]數學',   '', '1', '1'],
    ['週一', '第二節', '7年級', '7年1班', '[測試]教師甲', '', '領域學習', '社會領域',       '[測試]社會A',  '', '1', '1'],
    ['週二', '第一節', '7年級', '7年1班', '[測試]教師甲', '', '領域學習', '語文領域',       '[測試]國文A',  '', '1', '1'],
    ['週二', '第二節', '7年級', '7年1班', '[測試]教師乙', '', '領域學習', '社會領域',       '[測試]社會B',  '', '1', '1'],
    ['週三', '第一節', '7年級', '7年1班', '[測試]教師乙', '', '領域學習', '語文領域',       '[測試]國文B',  '', '1', '1'],
    ['週四', '第一節', '7年級', '7年1班', '[測試]教師甲', '', '領域學習', '語文領域',       '[測試]英文A',  '', '1', '1'],
    ['週五', '第一節', '7年級', '7年1班', '[測試]教師乙', '', '領域學習', '語文領域',       '[測試]英文B',  '', '1', '1'],
    ['週一', '第三節', '7年級', '7年2班', '蕭淳憶',       '', '領域學習', '語文領域',       '國語文',       '', '1', '1'],
    ['週一', '第四節', '7年級', '7年2班', '廖君晏',       '', '領域學習', '社會領域',       '歷史',         '', '1', '1'],
    ['週二', '第三節', '7年級', '7年2班', '李麗芳',       '', '領域學習', '數學領域',       '數學',         '', '1', '1'],
    ['週三', '第三節', '7年級', '7年2班', '鄭婉攸',       '', '領域學習', '健康與體育領域', '體育',         '', '1', '1'],
    ['週四', '第三節', '7年級', '7年2班', '高家涵',       '', '領域學習', '語文領域',       '國語文',       '', '1', '1'],
];
const CSV_CONTENT = CSV_HEADER + '\n' + CSV_ROWS.map(r => r.join(',')).join('\n') + '\n';

// 四個流程使用的日期：基準週一 2026-08-03，經程式驗算對應星期無誤。
// 重複執行本腳本時，app.js 的衝堂檢查（checkExistingRecord）會擋下「同一天同一節已有紀錄」的重複申請
// （這本身是一項已驗證正確的行為，見報告），因此每次執行都位移到一個尚未使用過的全新週，確保可重複執行。
// 位移量取自「距 2026-01-01 的分鐘數 mod 500」，同一次執行內固定不變，不同次執行幾乎必然落在不同週。
const WEEK_OFFSET = Math.floor((Date.now() - Date.parse('2026-01-01T00:00:00Z')) / 60000) % 500;
function addDaysISO(base, days) {
    // 純本地日期元件運算，刻意不用 toISOString()（會受執行環境時區影響往前/後跳一天）。
    const [y, m, d] = base.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}
const BASE_MONDAY = '2026-08-03';
const DATES = {
    flow1Sub: addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 0), // 週一 第一節（代課單簽）
    flow2A:   addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 1), // 週二 第一節（調課雙簽 slotA）
    flow2B:   addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 2), // 週三 第一節（調課雙簽 slotB）
    flow3A:   addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 3), // 週四 第一節（多重調課 UI 嘗試 slotA）
    flow3B:   addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 4), // 週五 第一節（多重調課 UI 嘗試 slotB）
    flow4A:   addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 0), // 週一 第二節（中途拒絕 slotA，同 flow1Sub 日期不同節次）
    flow4B:   addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 1), // 週二 第二節（中途拒絕 slotB，同 flow2A 日期不同節次）
    // flow3b 直接呼叫驗證用：下一週週一/週二（day+7/+8），與上面區塊錯開，避免與人工排的課表格產生混淆
    flow3bA:  addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 7),
    flow3bB:  addDaysISO(BASE_MONDAY, WEEK_OFFSET * 7 + 8),
};

const testDocs = {
    generatedAt: new Date().toISOString(),
    schoolId: SCHOOL_ID,
    flows: {},
};

// ---------------------------------------------------------------------------
// Firestore REST（唯讀，gcloud IAM token）— 本檔案內完全不包含任何寫入 REST 呼叫
// ---------------------------------------------------------------------------
function getAccessToken() {
    return execSync(`gcloud auth print-access-token --account=${GCLOUD_ACCOUNT}`).toString().trim();
}

function unwrapField(field) {
    if (!field) return null;
    if ('stringValue' in field) return field.stringValue;
    if ('integerValue' in field) return +field.integerValue;
    if ('doubleValue' in field) return field.doubleValue;
    if ('booleanValue' in field) return field.booleanValue;
    if ('arrayValue' in field) return (field.arrayValue.values || []).map(unwrapField);
    if ('mapValue' in field) {
        const o = {};
        for (const [k, v] of Object.entries(field.mapValue.fields || {})) o[k] = unwrapField(v);
        return o;
    }
    if ('timestampValue' in field) return field.timestampValue;
    if ('nullValue' in field) return null;
    return null;
}

function docToObj(doc) {
    const obj = { _id: doc.name.split('/').pop(), _updated: doc.updateTime };
    for (const [k, v] of Object.entries(doc.fields || {})) obj[k] = unwrapField(v);
    return obj;
}

async function restGetRaw(pathSuffix) {
    const token = getAccessToken();
    const res = await fetch(`${REST_BASE}/${pathSuffix}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`REST ${res.status} ${pathSuffix}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
}

async function fsList(collectionPath) {
    const data = await restGetRaw(collectionPath);
    return (data?.documents || []).map(docToObj);
}

async function fsGet(docPath) {
    const data = await restGetRaw(docPath);
    return data ? docToObj(data) : null;
}

async function pollUntil(fn, { timeout = 20000, interval = 1000, desc = '' } = {}) {
    const start = Date.now();
    let lastErr = null;
    while (Date.now() - start < timeout) {
        try {
            const result = await fn();
            if (result) return result;
        } catch (e) { lastErr = e; }
        await new Promise(r => setTimeout(r, interval));
    }
    throw new Error(`逾時（${timeout}ms）等待條件成立：${desc}${lastErr ? ' | 最後錯誤: ' + lastErr.message : ''}`);
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function log(msg) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

let shotN = 0;
async function shot(page, name) {
    shotN++;
    const file = path.join(SCREEN_DIR, `${String(shotN).padStart(2, '0')}-${name}.png`);
    try {
        await page.screenshot({ path: file, fullPage: true });
        log(`  截圖 -> ${path.basename(file)}`);
    } catch (e) {
        log(`  截圖失敗（忽略，不影響驗收）: ${e.message}`);
    }
    return file;
}

async function prepPage(page) {
    // 任何原生 dialog（reject 的 prompt() 等）一律接受並填入可辨識文字，避免腳本卡住
    page.on('dialog', async (d) => {
        try {
            if (d.type() === 'prompt') await d.accept('[測試] v2-approval-flows 自動化驗收');
            else await d.accept();
        } catch (_) { /* ignore */ }
    });
    await page.goto(PREVIEW_URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForFunction(
        () => window.app && window.firebaseModules && typeof window.firebaseModules.getAuth === 'function',
        { timeout: 20000 }
    );
}

async function loginAs(page, email) {
    await page.evaluate(async ({ email, pw }) => {
        const auth = window.firebaseModules.getAuth();
        await window.firebaseModules.signInWithEmailAndPassword(auth, email, pw);
    }, { email, pw: PW });
    await page.waitForFunction(
        () => !document.body.classList.contains('v2-locked') &&
              (document.body.classList.contains('v2-teacher') ||
               document.body.classList.contains('v2-section-chief') ||
               document.body.classList.contains('v2-director')),
        { timeout: 20000 }
    );
}

async function clickTab(page, tabId) {
    await page.click(`.tab-btn[data-tab="${tabId}"]`);
    await page.waitForTimeout(300);
}

async function toastText(page) {
    try {
        return await page.locator('#toast-container .toast-body').last().textContent({ timeout: 3000 });
    } catch { return '(無 toast 或已消失)'; }
}

/** 選課程用的原任課教師/日期兩步驟（每個流程共用）。 */
async function pickTeacherAndDate(page, teacherName, dateStr) {
    await clickTab(page, 'substitute');
    await page.selectOption('#sub-teacher', { value: teacherName });
    await page.fill('#sub-date', dateStr);
    await page.waitForTimeout(300);
}

async function clickCourseCell(page, weekday, period) {
    const sel = `.schedule-course.selectable[data-weekday="${weekday}"][data-period="${period}"]`;
    await page.waitForSelector(sel, { timeout: 10000 });
    await page.click(sel);
}

async function submitAndMaybeSkipConsentModal(page, extraConsentName = null) {
    await page.click('#confirm-substitute-btn');
    let modalAppeared = false;
    try {
        await page.waitForSelector('#v2-extra-consent-modal', { timeout: 4000 });
        modalAppeared = true;
    } catch (_) { /* 未出現 —— 見 P0 finding：buildSwapRecord 的 isMultiSwap 恆為 true */ }
    if (modalAppeared) {
        if (extraConsentName) {
            await page.click(`.v2-extra-consent-cb[value="${extraConsentName}"]`);
            await page.click('#v2-extra-consent-confirm');
        } else {
            await page.click('#v2-extra-consent-skip');
        }
    }
    return modalAppeared;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async () => {
    log('===== V2 審核工作流 e2e 驗收開始 =====');

    // ---- 前置：teachers 集合上傳前快照 ----
    log('讀取 production teachers 集合（上傳前快照）...');
    const teachersBefore = await fsList(`schools/${SCHOOL_ID}/teachers`);
    log(`  teachers 上傳前共 ${teachersBefore.length} 筆`);

    const scheduleDocBefore = await fsGet(`schools/${SCHOOL_ID}/data/schedule`);
    log(`  schools/${SCHOOL_ID}/data/schedule 上傳前：${scheduleDocBefore ? '已存在' : '不存在（預期空殼狀態）'}`);

    const browser = await chromium.launch();

    // ===================== 步驟 1：組長丙上傳課表 =====================
    log('\n--- 步驟1：組長丙登入並上傳課表 ---');
    const ctxChief = await browser.newContext();
    const chief = await ctxChief.newPage();
    await prepPage(chief);
    await loginAs(chief, ACCOUNTS.chief.email);
    await shot(chief, 'chief-login');
    log('  組長丙登入成功');

    await clickTab(chief, 'import');
    await chief.setInputFiles('#schedule-file', {
        name: 'v2test-schedule.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(CSV_CONTENT, 'utf-8'),
    });
    await chief.waitForSelector('#schedule-status:not(.hidden)', { timeout: 10000 });
    await shot(chief, 'chief-schedule-parsed');
    const teacherCountText = await chief.locator('#teacher-count').textContent();
    const classCountText   = await chief.locator('#class-count').textContent();
    log(`  課表解析完成：班級=${classCountText} 教師=${teacherCountText}`);

    // 設定學校名稱（沿用 production config 既有校名）
    await chief.fill('#school-name', '新竹市立內湖國民中學');
    await chief.click('#save-school-name-btn');
    await shot(chief, 'chief-schoolname-saved-first-sync');

    // 等待第一次同步落地，檢查是否命中「schoolName 未隨上傳同步」的已知風險
    const firstSync = await pollUntil(
        () => fsGet(`schools/${SCHOOL_ID}/data/schedule`),
        { timeout: 20000, desc: 'schools/inhu/data/schedule 第一次同步落地' }
    );
    const firstSyncHadSchoolName = !!firstSync.schoolName;
    log(`  第一次同步完成：scheduleData=${(firstSync.scheduleData || []).length} 筆，schoolName=${JSON.stringify(firstSync.schoolName || '')}`);
    if (!firstSyncHadSchoolName) {
        log('  [BUG 確認] 第一次同步的 schoolName 為空——setSchoolName() 不在 v2-app.js 的課表回寫白名單內（見報告）。套用 workaround：重新觸發一次課表匯入以強制重新同步。');
        await chief.setInputFiles('#schedule-file', {
            name: 'v2test-schedule.csv',
            mimeType: 'text/csv',
            buffer: Buffer.from(CSV_CONTENT, 'utf-8'),
        });
        await chief.waitForSelector('#schedule-status:not(.hidden)', { timeout: 10000 });
        await shot(chief, 'chief-schedule-resynced-workaround');
    }
    const finalSync = await pollUntil(async () => {
        const doc = await fsGet(`schools/${SCHOOL_ID}/data/schedule`);
        return (doc && doc.schoolName) ? doc : null;
    }, { timeout: 20000, desc: 'schoolName 最終寫入 schools/inhu/data/schedule' }).catch(() => null);
    log(`  最終 schedule 文件 schoolName=${JSON.stringify(finalSync?.schoolName || '(仍為空，workaround 未生效)')}`);

    const teachersAfter = await fsList(`schools/${SCHOOL_ID}/teachers`);
    const beforeIds = new Set(teachersBefore.map(t => t._id));
    const newTeachers = teachersAfter.filter(t => !beforeIds.has(t._id));
    log(`  teachers 上傳後共 ${teachersAfter.length} 筆（上傳前 ${teachersBefore.length} 筆），新增 ${newTeachers.length} 筆`);
    if (newTeachers.length) {
        newTeachers.forEach(t => log(`    [新增] ${t._id} ${t.name} role=${t.role}`));
    }

    // ===================== 開 甲 / 乙 兩個 context（各自獨立 storage，避免互相覆蓋登入態）=====================
    log('\n--- 開啟教師甲／教師乙獨立瀏覽器 context 並登入 ---');
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const teacherA = await ctxA.newPage();
    const teacherB = await ctxB.newPage();
    await prepPage(teacherA);
    await prepPage(teacherB);
    await loginAs(teacherA, ACCOUNTS.teacherA.email);
    await shot(teacherA, 'teacherA-login');
    await loginAs(teacherB, ACCOUNTS.teacherB.email);
    await shot(teacherB, 'teacherB-login');
    log('  教師甲／教師乙登入成功');

    // 確認 canSwitchToTab 已解鎖（教師應能進入「調代課申請」，而非被卡在「請先設定學校名稱」）
    await clickTab(teacherA, 'substitute');
    const subUnlocked = await teacherA.locator('#substitute-content').isVisible().catch(() => false);
    await shot(teacherA, 'teacherA-substitute-tab-unlock-check');
    log(`  教師甲「調代課申請」頁籤是否解鎖：${subUnlocked ? '是' : '否（卡住，見報告）'}`);
    if (!subUnlocked) {
        const toast = await toastText(teacherA);
        log(`  [BLOCKER] 教師甲卡在調代課申請頁籤，toast 訊息："${toast}"。後續流程可能無法進行。`);
    }

    // ===================== 步驟 2-1：代課單簽 =====================
    log('\n--- 流程1：代課單簽（教師甲發起 -> 組長丙核准） ---');
    await pickTeacherAndDate(teacherA, ACCOUNTS.teacherA.name, DATES.flow1Sub);
    await clickCourseCell(teacherA, '週一', '第一節');
    await teacherA.selectOption('#leave-type', 'personal');
    await teacherA.fill('#sub-reason', '[測試] 代課單簽流程驗收');
    await shot(teacherA, 'flow1-teacherA-course-selected');
    await teacherA.waitForSelector('.recommendation-item', { timeout: 10000 });
    await teacherA.locator('.recommendation-item', { hasText: ACCOUNTS.teacherB.name }).click();
    await shot(teacherA, 'flow1-teacherA-substitute-selected');
    await teacherA.click('#confirm-substitute-btn');
    await teacherA.waitForTimeout(1500);
    await shot(teacherA, 'flow1-teacherA-after-submit');
    log(`  教師甲送出後 toast: "${await toastText(teacherA)}"`);

    const flow1Req = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/pendingRequests`);
        return list.find(r => r.requestType === 'substitute' && r.date === DATES.flow1Sub && r.period === '第一節' && r.className === '7年1班');
    }, { desc: 'flow1 代課 pendingRequest 建立' });
    log(`  [Firestore] pendingRequests/${flow1Req._id} status=${flow1Req.status} requiredApproverId結尾=${(flow1Req.requiredApproverId||'').slice(-6)}`);

    await clickTab(chief, 'v2-pending');
    await chief.waitForSelector(`.v2-final-approve-btn[data-id="${flow1Req._id}"]`, { timeout: 15000 });
    await shot(chief, 'flow1-chief-approval-queue');
    await chief.click(`.v2-final-approve-btn[data-id="${flow1Req._id}"]`);
    await chief.waitForTimeout(1500);
    await shot(chief, 'flow1-chief-after-approve');
    log(`  組長丙核准後 toast: "${await toastText(chief)}"`);

    const flow1Record = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/substituteRecords`);
        return list.find(r => r.fromRequestId === flow1Req._id);
    }, { desc: 'flow1 substituteRecord 建立' });
    const flow1ReqAfter = await fsGet(`schools/${SCHOOL_ID}/pendingRequests/${flow1Req._id}`);
    log(`  [Firestore] substituteRecords/${flow1Record._id} status=${flow1Record.status} | pendingRequests/${flow1Req._id} status=${flow1ReqAfter?.status}`);
    testDocs.flows.flow1_substitute = { reqId: flow1Req._id, recordId: flow1Record._id, finalReqStatus: flow1ReqAfter?.status, finalRecordStatus: flow1Record.status };

    // ===================== 步驟 2-2：調課雙簽 =====================
    log('\n--- 流程2：調課雙簽（教師甲對教師乙 -> 乙同意 -> 組長丙核准） ---');
    await pickTeacherAndDate(teacherA, ACCOUNTS.teacherA.name, DATES.flow2A);
    // 實際 radio input 是 display:none 的自訂樣式（見 src/css/features.css .change-type-option input，
    // Stage 3 CSS 拆檔後 style.css 已刪除，此規則現位於 features.css），
    // 真人是點擊旁邊可見的卡片觸發 label 轉發；直接點卡片而非隱藏的 input。
    await teacherA.click('input[name="change-type-radio"][value="swap"] + .change-type-card');
    await clickCourseCell(teacherA, '週二', '第一節');
    await teacherA.fill('#swap-date', DATES.flow2B);
    await teacherA.waitForTimeout(400);
    await teacherA.selectOption('#swap-course', { value: `週三_第一節_${ACCOUNTS.teacherB.name}` });
    await shot(teacherA, 'flow2-teacherA-before-confirm');
    const flow2ModalAppeared = await submitAndMaybeSkipConsentModal(teacherA, null);
    log(`  送出調課後，額外同意人 modal 是否出現：${flow2ModalAppeared ? '是' : '否'}`);
    await teacherA.waitForTimeout(1200);
    await shot(teacherA, 'flow2-teacherA-after-confirm');
    log(`  教師甲送出後 toast: "${await toastText(teacherA)}"`);

    const flow2Req = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/pendingRequests`);
        return list.find(r => r.requestType === 'swap' && r.date === DATES.flow2A && r.period === '第一節' && r.className === '7年1班');
    }, { desc: 'flow2 調課 pendingRequest 建立' });
    log(`  [Firestore] pendingRequests/${flow2Req._id} status=${flow2Req.status} pendingConsentTeacherIds長度=${(flow2Req.pendingConsentTeacherIds||[]).length}`);

    await clickTab(teacherB, 'v2-pending');
    await teacherB.waitForSelector(`.v2-consent-btn[data-id="${flow2Req._id}"]`, { timeout: 15000 });
    await shot(teacherB, 'flow2-teacherB-pending-consent');
    await teacherB.click(`.v2-consent-btn[data-id="${flow2Req._id}"]`);
    await teacherB.waitForTimeout(1200);
    await shot(teacherB, 'flow2-teacherB-after-consent');
    log(`  教師乙同意後 toast: "${await toastText(teacherB)}"`);

    const flow2ReqAfterConsent = await pollUntil(async () => {
        const d = await fsGet(`schools/${SCHOOL_ID}/pendingRequests/${flow2Req._id}`);
        return d && d.status === 'pending_approval' ? d : null;
    }, { desc: 'flow2 status -> pending_approval' });
    log(`  [Firestore] pendingRequests/${flow2Req._id} status=${flow2ReqAfterConsent.status}（乙已同意）`);

    await clickTab(chief, 'v2-pending');
    await chief.waitForSelector(`.v2-final-approve-btn[data-id="${flow2Req._id}"]`, { timeout: 15000 });
    await shot(chief, 'flow2-chief-approval-queue');
    await chief.click(`.v2-final-approve-btn[data-id="${flow2Req._id}"]`);
    await chief.waitForTimeout(1500);
    await shot(chief, 'flow2-chief-after-approve');

    const flow2Record = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/substituteRecords`);
        return list.find(r => r.fromRequestId === flow2Req._id);
    }, { desc: 'flow2 substituteRecord 建立' });
    const flow2ReqAfter = await fsGet(`schools/${SCHOOL_ID}/pendingRequests/${flow2Req._id}`);
    log(`  [Firestore] substituteRecords/${flow2Record._id} status=${flow2Record.status} | pendingRequests/${flow2Req._id} status=${flow2ReqAfter?.status}`);
    testDocs.flows.flow2_swap = { reqId: flow2Req._id, recordId: flow2Record._id, finalReqStatus: flow2ReqAfter?.status, finalRecordStatus: flow2Record.status, modalAppeared: flow2ModalAppeared };

    // ===================== 步驟 2-3a：多重調課 —— 先走真實 UI，確認是否可觸發 =====================
    log('\n--- 流程3a：多重調課全員同意（真實 UI 嘗試，驗證是否可觸發） ---');
    await pickTeacherAndDate(teacherA, ACCOUNTS.teacherA.name, DATES.flow3A);
    // 實際 radio input 是 display:none 的自訂樣式（見 src/css/features.css .change-type-option input，
    // Stage 3 CSS 拆檔後 style.css 已刪除，此規則現位於 features.css），
    // 真人是點擊旁邊可見的卡片觸發 label 轉發；直接點卡片而非隱藏的 input。
    await teacherA.click('input[name="change-type-radio"][value="swap"] + .change-type-card');
    await clickCourseCell(teacherA, '週四', '第一節');
    await teacherA.fill('#swap-date', DATES.flow3B);
    await teacherA.waitForTimeout(400);
    await teacherA.selectOption('#swap-course', { value: `週五_第一節_${ACCOUNTS.teacherB.name}` });
    await shot(teacherA, 'flow3a-teacherA-before-confirm');
    const flow3aModalAppeared = await submitAndMaybeSkipConsentModal(teacherA, ACCOUNTS.chief.name);
    await shot(teacherA, 'flow3a-after-submit-modal-check');
    log(`  [關鍵觀察] 一般「調課」送出後，詢問「是否還有其他教師需一併同意」的 modal 是否出現：${flow3aModalAppeared ? '是（可正常升級為多重調課）' : '否（P0 bug：buildSwapRecord 恆設 isMultiSwap=true，見報告）'}`);

    const flow3aReq = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/pendingRequests`);
        return list.find(r => (r.requestType === 'swap' || r.requestType === 'multi_swap') && r.date === DATES.flow3A && r.period === '第一節' && r.className === '7年1班');
    }, { desc: 'flow3a pendingRequest 建立' });
    log(`  [Firestore] pendingRequests/${flow3aReq._id} requestType=${flow3aReq.requestType}（預期 swap，因上述 bug 無法升級為 multi_swap）`);

    // 依實際 requestType 走完流程（乙同意 -> [若為 multi_swap 則丙也需同意] -> 丙核准），完整跑完不留爛尾
    await clickTab(teacherB, 'v2-pending');
    await teacherB.waitForSelector(`.v2-consent-btn[data-id="${flow3aReq._id}"]`, { timeout: 15000 });
    await teacherB.click(`.v2-consent-btn[data-id="${flow3aReq._id}"]`);
    await teacherB.waitForTimeout(1000);
    if (flow3aReq.requestType === 'multi_swap') {
        await clickTab(chief, 'v2-pending');
        await chief.waitForSelector(`.v2-consent-btn[data-id="${flow3aReq._id}"]`, { timeout: 15000 });
        await chief.click(`.v2-consent-btn[data-id="${flow3aReq._id}"]`);
        await chief.waitForTimeout(1000);
    }
    await clickTab(chief, 'v2-pending');
    await chief.waitForSelector(`.v2-final-approve-btn[data-id="${flow3aReq._id}"]`, { timeout: 15000 });
    await shot(chief, 'flow3a-chief-approval-queue');
    await chief.click(`.v2-final-approve-btn[data-id="${flow3aReq._id}"]`);
    await chief.waitForTimeout(1500);
    await shot(chief, 'flow3a-chief-after-approve');

    const flow3aRecord = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/substituteRecords`);
        return list.find(r => r.fromRequestId === flow3aReq._id);
    }, { desc: 'flow3a substituteRecord 建立' });
    log(`  [Firestore] substituteRecords/${flow3aRecord._id} status=${flow3aRecord.status}`);
    testDocs.flows.flow3a_multiSwap_uiAttempt = {
        reqId: flow3aReq._id, recordId: flow3aRecord._id, requestTypeActuallyUsed: flow3aReq.requestType,
        modalAppeared: flow3aModalAppeared, note: 'UI 是否能觸發全員同意 modal 的實測證據，見報告 P0 finding',
    };

    // ===================== 步驟 2-3b：多重調課 —— 直接呼叫應用程式函式驗證後端機制 =====================
    log('\n--- 流程3b：多重調課全員同意（繞過壞掉的 UI 觸發點，直接呼叫 dataManager.addSubstituteRecord 驗證後端狀態機） ---');
    await teacherA.evaluate(({ names, dates }) => {
        const record = {
            id: Date.now().toString(),
            type: '調課',
            date: dates.a, weekday: '週一', period: '第七節',
            className: '7年1班', subject: '[測試]多重調課直接驗證A', domain: '語文領域',
            originalTeacher: names.a,
            swapDate: dates.b, swapWeekday: '週二', swapPeriod: '第七節',
            swapTeacher: names.b, swapSubject: '[測試]多重調課直接驗證B', swapDomain: '語文領域',
            substituteTeacher: names.b,
            leaveType: '調課', leaveTypeName: '調課', docNumber: '',
            isSelfSwap: false, isMultiSwap: false,
            reason: '[測試] 多重調課全員同意-直接驗證(繞過UI bug)',
            createdAt: new Date().toISOString(),
            additionalConsentTeachers: [names.c],
        };
        window.app.dataManager.addSubstituteRecord(record);
    }, { names: { a: ACCOUNTS.teacherA.name, b: ACCOUNTS.teacherB.name, c: ACCOUNTS.chief.name }, dates: { a: DATES.flow3bA, b: DATES.flow3bB } });

    const flow3bReq = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/pendingRequests`);
        return list.find(r => r.requestType === 'multi_swap' && r.date === DATES.flow3bA);
    }, { desc: 'flow3b multi_swap pendingRequest 建立（直接呼叫）' });
    log(`  [Firestore] pendingRequests/${flow3bReq._id} requestType=${flow3bReq.requestType} pendingConsentTeacherIds長度=${(flow3bReq.pendingConsentTeacherIds||[]).length}（應為2：乙+丙）`);

    await clickTab(teacherB, 'v2-pending');
    await teacherB.waitForSelector(`.v2-consent-btn[data-id="${flow3bReq._id}"]`, { timeout: 15000 });
    await shot(teacherB, 'flow3b-teacherB-multiswap-consent');
    await teacherB.click(`.v2-consent-btn[data-id="${flow3bReq._id}"]`);
    await teacherB.waitForTimeout(1000);

    const afterBConsent = await fsGet(`schools/${SCHOOL_ID}/pendingRequests/${flow3bReq._id}`);
    log(`  乙同意後：status=${afterBConsent.status}，剩餘待同意=${(afterBConsent.pendingConsentTeacherIds||[]).length}`);

    await clickTab(chief, 'v2-pending');
    await chief.waitForSelector(`.v2-consent-btn[data-id="${flow3bReq._id}"]`, { timeout: 15000 });
    await shot(chief, 'flow3b-chief-multiswap-consent');
    await chief.click(`.v2-consent-btn[data-id="${flow3bReq._id}"]`);
    await chief.waitForTimeout(1000);

    const flow3bReqApproval = await pollUntil(async () => {
        const d = await fsGet(`schools/${SCHOOL_ID}/pendingRequests/${flow3bReq._id}`);
        return d && d.status === 'pending_approval' ? d : null;
    }, { desc: 'flow3b 全員同意後 -> pending_approval' });
    log(`  全員（乙+丙）同意後：status=${flow3bReqApproval.status}`);

    await clickTab(chief, 'v2-pending');
    await chief.waitForSelector(`.v2-final-approve-btn[data-id="${flow3bReq._id}"]`, { timeout: 15000 });
    await shot(chief, 'flow3b-chief-final-approve-queue');
    await chief.click(`.v2-final-approve-btn[data-id="${flow3bReq._id}"]`);
    await chief.waitForTimeout(1500);
    await shot(chief, 'flow3b-chief-after-approve');

    const flow3bRecord = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/substituteRecords`);
        return list.find(r => r.fromRequestId === flow3bReq._id);
    }, { desc: 'flow3b substituteRecord 建立' });
    log(`  [Firestore] substituteRecords/${flow3bRecord._id} status=${flow3bRecord.status} affectedTeacherIds長度=${(flow3bRecord.affectedTeacherIds||[]).length}（應含甲乙丙三人）`);
    testDocs.flows.flow3b_multiSwap_directInvocation = {
        reqId: flow3bReq._id, recordId: flow3bRecord._id, finalRecordStatus: flow3bRecord.status,
        affectedTeacherIdsCount: (flow3bRecord.affectedTeacherIds || []).length,
        note: '繞過壞掉的 UI 觸發點，直接呼叫 window.app.dataManager.addSubstituteRecord() 驗證多重調課後端狀態機/rules 本身可運作',
    };

    // ===================== 步驟 2-4：中途拒絕 =====================
    log('\n--- 流程4：中途拒絕（教師甲發起調課 -> 教師乙拒絕） ---');
    await pickTeacherAndDate(teacherA, ACCOUNTS.teacherA.name, DATES.flow4A);
    // 實際 radio input 是 display:none 的自訂樣式（見 src/css/features.css .change-type-option input，
    // Stage 3 CSS 拆檔後 style.css 已刪除，此規則現位於 features.css），
    // 真人是點擊旁邊可見的卡片觸發 label 轉發；直接點卡片而非隱藏的 input。
    await teacherA.click('input[name="change-type-radio"][value="swap"] + .change-type-card');
    await clickCourseCell(teacherA, '週一', '第二節');
    await teacherA.fill('#swap-date', DATES.flow4B);
    await teacherA.waitForTimeout(400);
    await teacherA.selectOption('#swap-course', { value: `週二_第二節_${ACCOUNTS.teacherB.name}` });
    await shot(teacherA, 'flow4-teacherA-before-confirm');
    await submitAndMaybeSkipConsentModal(teacherA, null);
    await teacherA.waitForTimeout(1200);

    const flow4Req = await pollUntil(async () => {
        const list = await fsList(`schools/${SCHOOL_ID}/pendingRequests`);
        return list.find(r => r.date === DATES.flow4A && r.period === '第二節' && r.className === '7年1班');
    }, { desc: 'flow4 pendingRequest 建立' });
    log(`  [Firestore] pendingRequests/${flow4Req._id} status=${flow4Req.status}`);

    await clickTab(teacherB, 'v2-pending');
    await teacherB.waitForSelector(`.v2-reject-btn[data-id="${flow4Req._id}"]`, { timeout: 15000 });
    await shot(teacherB, 'flow4-teacherB-before-reject');
    await teacherB.click(`.v2-reject-btn[data-id="${flow4Req._id}"]`); // prompt() 由 prepPage 註冊的 dialog handler 自動接受並填「[測試]」文字
    await teacherB.waitForTimeout(1200);
    await shot(teacherB, 'flow4-teacherB-after-reject');

    const flow4ReqRejected = await pollUntil(async () => {
        const d = await fsGet(`schools/${SCHOOL_ID}/pendingRequests/${flow4Req._id}`);
        return d && d.status === 'rejected' ? d : null;
    }, { desc: 'flow4 status -> rejected' });
    log(`  [Firestore] pendingRequests/${flow4Req._id} status=${flow4ReqRejected.status} rejectedBy結尾=${(flow4ReqRejected.rejectedBy||'').slice(-6)} rejectNote="${flow4ReqRejected.rejectNote}"`);

    const recordsAfterReject = await fsList(`schools/${SCHOOL_ID}/substituteRecords`);
    const noRecordFromReject = !recordsAfterReject.some(r => r.fromRequestId === flow4Req._id);
    log(`  確認拒絕後【未】產生 substituteRecords：${noRecordFromReject ? '正確（無紀錄產生）' : '異常！有紀錄產生'}`);

    await clickTab(teacherA, 'v2-pending');
    await teacherA.waitForSelector(`.v2-dismiss-btn[data-id="${flow4Req._id}"]`, { timeout: 15000 });
    await shot(teacherA, 'flow4-teacherA-sees-rejection');
    await teacherA.click(`.v2-dismiss-btn[data-id="${flow4Req._id}"]`);
    await teacherA.waitForTimeout(1000);
    await shot(teacherA, 'flow4-teacherA-dismissed');
    const flow4ReqDeleted = await fsGet(`schools/${SCHOOL_ID}/pendingRequests/${flow4Req._id}`);
    log(`  教師甲按「我知道了」後，pendingRequests/${flow4Req._id} 是否已刪除：${flow4ReqDeleted === null ? '是' : '否（仍存在）'}`);
    testDocs.flows.flow4_reject = {
        reqId: flow4Req._id, finalReqStatus: 'rejected_then_dismissed', rejectNote: flow4ReqRejected.rejectNote,
        noRecordCreated: noRecordFromReject, docDeletedAfterDismiss: flow4ReqDeleted === null,
    };

    // ===================== 步驟 3：教師身份權限邊界複驗 =====================
    log('\n--- 步驟3：教師身份權限邊界複驗 ---');

    // 3a. 月結算
    await clickTab(teacherA, 'settlement');
    await teacherA.waitForTimeout(300);
    await teacherA.click('#generate-settlement-btn');
    await teacherA.waitForTimeout(500);
    await shot(teacherA, 'perm-teacherA-settlement-report');
    const settlementRows = await teacherA.locator('#settlement-tbody tr').allTextContents();
    const settlementTeacherNames = settlementRows.map(r => r.split('\n')[0]?.trim()).filter(Boolean);
    log(`  教師甲月結算表可見列數：${settlementRows.length}（若 >1 且含他人姓名，代表可看到全校教師資料）`);
    log(`  月結算表前幾筆姓名：${settlementTeacherNames.slice(0, 6).join('、')}`);
    const settlementShowsOthers = settlementTeacherNames.some(n => n && n !== ACCOUNTS.teacherA.name && n !== '本月無教師時數變動');

    let settlementExportFired = false;
    teacherA.once('download', () => { settlementExportFired = true; });
    await teacherA.click('#export-settlement-btn').catch(() => {});
    await teacherA.waitForTimeout(1000);
    log(`  教師甲點擊「匯出 Excel」是否觸發下載：${settlementExportFired ? '是（可匯出全校資料）' : '否／未偵測到下載事件'}`);

    // 3b. 調代課紀錄（教師 vs 組長 對照）
    await clickTab(teacherA, 'records');
    await teacherA.waitForTimeout(500);
    await shot(teacherA, 'perm-teacherA-records');
    const teacherARecordRows = await teacherA.locator('#v2-records-section tbody tr').count().catch(() => 0);

    await clickTab(chief, 'records');
    await chief.waitForTimeout(500);
    await shot(chief, 'perm-chief-records-full');
    const chiefRecordRows = await chief.locator('#v2-records-section tbody tr').count().catch(() => 0);
    log(`  「調代課紀錄」列數 —— 教師甲看到 ${teacherARecordRows} 筆 / 組長丙看到 ${chiefRecordRows} 筆`);
    log(`  教師是否被正確限制在與自己相關的紀錄：${teacherARecordRows <= chiefRecordRows ? '是（teacherA <= chief）' : '否（異常，teacherA 看到比 chief 還多）'}`);

    // 3c. 課表匯入頁教師可見按鈕
    await clickTab(teacherA, 'import');
    const addTeacherVisible = await teacherA.locator('#add-teacher-btn').isVisible();
    const saveDataVisible   = await teacherA.locator('#save-data-btn').isVisible();
    const importBtnVisible  = await teacherA.locator('#tab-import-btn').isVisible();
    log(`  教師甲於「課表匯入」頁可見：+新增教師=${addTeacherVisible} 儲存資料=${saveDataVisible} 匯入還原=${importBtnVisible}`);
    await shot(teacherA, 'perm-teacherA-import-buttons-visible');

    const teachersBeforeBtnClicks = await fsList(`schools/${SCHOOL_ID}/teachers`);
    const scheduleBeforeBtnClicks = await fsGet(`schools/${SCHOOL_ID}/data/schedule`);

    await teacherA.click('#add-teacher-btn');
    await teacherA.waitForTimeout(300);
    await shot(teacherA, 'perm-teacherA-after-add-teacher-click');
    await teacherA.click('#save-data-btn');
    await teacherA.waitForTimeout(300);
    await shot(teacherA, 'perm-teacherA-after-save-data-click');

    teacherA.once('filechooser', () => {}); // 吞掉檔案選擇器事件，不提供檔案
    await teacherA.click('#tab-import-btn').catch(() => {});
    await teacherA.waitForTimeout(300);

    const teachersAfterBtnClicks = await fsList(`schools/${SCHOOL_ID}/teachers`);
    const scheduleAfterBtnClicks = await fsGet(`schools/${SCHOOL_ID}/data/schedule`);
    const teachersUnchanged = teachersBeforeBtnClicks.length === teachersAfterBtnClicks.length;
    const scheduleUnchanged = (scheduleBeforeBtnClicks?._updated || '') === (scheduleAfterBtnClicks?._updated || '');
    log(`  教師甲點擊「+新增教師／儲存資料／匯入還原」後，production teachers 筆數是否不變：${teachersUnchanged ? '是' : '否！'}（${teachersBeforeBtnClicks.length} -> ${teachersAfterBtnClicks.length}）`);
    log(`  production schedule 文件 updateTime 是否不變：${scheduleUnchanged ? '是' : '否！'}`);

    // ---------------------------------------------------------------------
    // 收尾：寫入 .last-test-docs.json、最終快照
    // ---------------------------------------------------------------------
    testDocs.teachersBeforeCount = teachersBefore.length;
    testDocs.teachersAfterCount = teachersAfter.length;
    testDocs.newTeachersFromScheduleUpload = newTeachers.map(t => ({ id: t._id, name: t.name }));
    testDocs.schoolNameSyncBugConfirmed = !firstSyncHadSchoolName;
    testDocs.multiSwapUiBugConfirmed = !flow3aModalAppeared;
    testDocs.permissionFindings = {
        settlementShowsAllTeachersToPlainTeacher: settlementShowsOthers,
        settlementExportAvailableToPlainTeacher: settlementExportFired,
        recordsProperlyScopedForTeacher: teacherARecordRows <= chiefRecordRows,
        importButtonsVisibleToTeacher: { addTeacherVisible, saveDataVisible, importBtnVisible },
        importButtonClicksCausedNoProductionWrite: teachersUnchanged && scheduleUnchanged,
    };
    writeFileSync(DOCS_FILE, JSON.stringify(testDocs, null, 2), 'utf-8');
    log(`\n已寫入 ${DOCS_FILE}`);

    await browser.close();
    log('\n===== 全部流程執行完畢 =====');
})().catch(async (err) => {
    console.error('\n[FATAL] 腳本執行失敗:', err);
    writeFileSync(DOCS_FILE, JSON.stringify({ ...testDocs, fatalError: err.message }, null, 2), 'utf-8');
    process.exit(1);
});
