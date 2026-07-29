/**
 * V2 兩項 blocker 修正驗收腳本（本機 dev server，真實測試帳號 + 真實 Firestore 後端）
 *
 * 針對本次修正的兩處 blocker 做「窄而深」的 e2e 驗證（非完整 4 條生命週期，那是
 * test/v2-approval-flows.mjs 的範疇）：
 *
 *   驗證1（修正一）：v2-app.js patchDataManager() 的課表回寫白名單補上 setSchoolName 後，
 *     單獨呼叫 setSchoolName()（不觸碰 setScheduleData 等其他已在白名單內的方法）是否會
 *     觸發一次「可被獨立歸因」的 Firestore 寫入。做法：
 *       T0：讀基準 updateTime
 *       上傳課表 → 等待第一次同步落地（T1，這次寫入本來就會發生，非本次修正範疇）
 *       等待 in-flight 完全結束（避免與下一步的寫入被合併成同一輪）
 *       僅設定學校名稱（不重新上傳課表）→ 等待第二次同步落地（T2）
 *     若 T2 存在且 updateTime 晚於 T1，代表這次「只呼叫 setSchoolName」的寫入確實發生了，
 *     在修正前這一步會永遠等不到（因為 setSchoolName 不在白名單內，queueScheduleSync 永遠
 *     不會被觸發），可幾乎排除其他解釋。
 *
 *   驗證2（修正二）：教師甲對教師乙送出一筆「非自我調課」的單次調課（非批次），確認
 *     「是否還有其他教師需一併同意」的 modal 這次會出現（修正前 buildSwapRecord 恆寫死
 *     isMultiSwap: true，守門條件 !record.isMultiSwap 恆為 false，modal 永不出現）。
 *     勾選一位額外同意教師（[測試]組長丙）後送出，確認產生的 pendingRequest
 *     requestType === 'multi_swap'。
 *
 * 安全設計（比照 test/v2-approval-flows.mjs）：
 *   - 所有 Firestore 讀取一律走唯讀 REST（gcloud access token），本檔案內沒有任何寫入 REST
 *     呼叫，所有「寫入」動作一律透過真實瀏覽器操作本機 dev server（走應用程式自己的
 *     程式碼路徑與 rules）。
 *   - 課表上傳使用與 test/v2-approval-flows.mjs 完全相同的測試 CSV 內容（同一份 fixture），
 *     對 schools/inhu/data/schedule 是冪等覆寫，不引入新的課表樣態。
 *   - 學校名稱明確設回正式值「新竹市立內湖國民中學」（與 schools/inhu/config/main 一致），
 *     不留測試字串在這個欄位上。
 *   - 調課請求的 reason 欄位透過 monkey-patch window.app.buildSwapRecord（僅存在於這個
 *     瀏覽器分頁的執行期記憶體，不改動任何檔案）加註「[測試]」，方便事後在 Firestore
 *     主控台辨識與清理；日期使用遠未來週一（2027-06-07 起算），與正式資料及先前測試批次
 *     的 2026-08 區段完全不重疊。
 *
 * 用法：
 *   PowerShell:  $env:STSYSTEM_TEST_PW = "..."; node test/v2-verify-fixes.mjs
 *   bash:        STSYSTEM_TEST_PW="..." node test/v2-verify-fixes.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SCREEN_DIR = path.join(__dirname, 'e2e-screenshots');
mkdirSync(SCREEN_DIR, { recursive: true });

const PW = process.env.STSYSTEM_TEST_PW;
if (!PW) {
    console.error(`
[缺少環境變數] STSYSTEM_TEST_PW 未設定，無法登入測試帳號。
  PowerShell: $env:STSYSTEM_TEST_PW = "<測試帳號密碼>"; node test/v2-verify-fixes.mjs
`);
    process.exit(2);
}

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------
const BASE_URL        = 'http://localhost:8000/index.html?v2=1';
const PROJECT         = 'stsystem-9d5fe';
const SCHOOL_ID       = 'inhu';
const GCLOUD_ACCOUNT  = 'uplilt31311227@gmail.com';
const REST_BASE       = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const OFFICIAL_SCHOOL_NAME = '新竹市立內湖國民中學';

const ACCOUNTS = {
    teacherA: { email: 'uplilt31311227+v2t1@gmail.com', name: '[測試]教師甲' },
    teacherB: { email: 'uplilt31311227+v2t2@gmail.com', name: '[測試]教師乙' },
    chief:    { email: 'uplilt31311227+v2t3@gmail.com', name: '[測試]組長丙' },
};

// 與 test/v2-approval-flows.mjs 完全相同的測試課表 fixture（冪等覆寫，不引入新樣態）
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

// 驗證2 用的日期：遠未來週一起算（已程式驗算為真實 Monday），與正式資料/其他測試批次的
// 2026-08 區段完全不重疊；同時仍取 mod 一個當次執行才決定的偏移量，容許本腳本重跑而不撞期。
const RUN_OFFSET_WEEKS = Math.floor(Date.now() / 60000) % 400;
function addDaysISO(base, days) {
    const [y, m, d] = base.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}
const BASE_MONDAY = '2027-06-07'; // 已驗算為 Monday
const DATES = {
    swapA: addDaysISO(BASE_MONDAY, RUN_OFFSET_WEEKS * 7 + 1), // 週二 第一節（甲：[測試]國文A）
    swapB: addDaysISO(BASE_MONDAY, RUN_OFFSET_WEEKS * 7 + 2), // 週三 第一節（乙：[測試]國文B）
};

const results = { generatedAt: new Date().toISOString(), fix1: {}, fix2: {} };

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
    const data = await restGetRaw(`${collectionPath}?pageSize=300`);
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
function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

let shotN = 0;
async function shot(page, name) {
    shotN++;
    const file = path.join(SCREEN_DIR, `vf${String(shotN).padStart(2, '0')}-${name}.png`);
    try {
        await page.screenshot({ path: file, fullPage: true });
        log(`  截圖 -> ${path.basename(file)}`);
    } catch (e) {
        log(`  截圖失敗（忽略，不影響驗收）: ${e.message}`);
    }
    return file;
}

async function prepPage(page) {
    page.on('dialog', async (d) => {
        try {
            if (d.type() === 'prompt') await d.accept('[測試] v2-verify-fixes 自動化驗收');
            else await d.accept();
        } catch (_) { /* ignore */ }
    });
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 45000 });
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

async function clickCourseCell(page, weekday, period) {
    const sel = `.schedule-course.selectable[data-weekday="${weekday}"][data-period="${period}"]`;
    await page.waitForSelector(sel, { timeout: 10000 });
    await page.click(sel);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async () => {
    log('===== V2 blocker 修正驗收開始（本機 dev server） =====');
    log(`目標 URL: ${BASE_URL}`);
    log(`驗證2 使用日期：swapA=${DATES.swapA}（週二）swapB=${DATES.swapB}（週三）`);

    const browser = await chromium.launch();

    // ========================================================================
    // 驗證1：setSchoolName 白名單修正
    // ========================================================================
    log('\n--- 驗證1：組長丙登入，確認 setSchoolName 能獨立觸發全校課表回寫 ---');
    const ctxChief = await browser.newContext();
    const chief = await ctxChief.newPage();
    await prepPage(chief);
    await loginAs(chief, ACCOUNTS.chief.email);
    await shot(chief, 'chief-login');
    log('  組長丙登入成功');

    const t0 = await fsGet(`schools/${SCHOOL_ID}/data/schedule`);
    log(`  T0（動作前）updateTime = ${t0?._updated || '(文件不存在)'}`);

    await clickTab(chief, 'import');
    await chief.setInputFiles('#schedule-file', {
        name: 'v2verify-schedule.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(CSV_CONTENT, 'utf-8'),
    });
    await chief.waitForSelector('#schedule-status:not(.hidden)', { timeout: 10000 });
    await shot(chief, 'chief-schedule-uploaded');
    log('  課表上傳完成（與既有 fixture 相同內容，冪等覆寫）');

    const t1doc = await pollUntil(async () => {
        const d = await fsGet(`schools/${SCHOOL_ID}/data/schedule`);
        return (d && d._updated !== t0?._updated) ? d : null;
    }, { timeout: 20000, desc: 'T1：課表上傳（setScheduleData，既有白名單項目）觸發的第一次同步落地' });
    log(`  T1（課表上傳觸發，非本次修正範疇）updateTime = ${t1doc._updated}`);

    // 等待 in-flight 同步完全結束，確保下一步是「獨立的一輪」寫入，而非被合併進同一輪
    await chief.waitForTimeout(3000);

    // 關鍵動作：只設定學校名稱，不重新上傳課表、不呼叫任何其他已在白名單內的方法
    await chief.fill('#school-name', OFFICIAL_SCHOOL_NAME);
    await chief.click('#save-school-name-btn');
    await shot(chief, 'chief-schoolname-saved');
    log(`  已點擊確認學校名稱＝「${OFFICIAL_SCHOOL_NAME}」（正式值，非測試字串）`);

    let t2doc = null;
    let fix1Landed = false;
    try {
        t2doc = await pollUntil(async () => {
            const d = await fsGet(`schools/${SCHOOL_ID}/data/schedule`);
            return (d && d._updated !== t1doc._updated) ? d : null;
        }, { timeout: 15000, desc: 'T2：僅呼叫 setSchoolName 觸發的第二次同步落地（修正一驗證核心）' });
        fix1Landed = true;
        log(`  [修正一驗證] T2（setSchoolName 單獨觸發）updateTime = ${t2doc._updated}`);
        log(`  [修正一驗證] Firestore 讀回 schoolName = ${JSON.stringify(t2doc.schoolName)}`);
        log(`  [修正一驗證] scheduleData 筆數 = ${(t2doc.scheduleData || []).length}（應為 12，證明課表未被清空/覆蓋成別的東西）`);
    } catch (e) {
        log(`  [修正一驗證] 逾時未觀察到第二次寫入：${e.message}`);
    }

    const finalScheduleDoc = t2doc || await fsGet(`schools/${SCHOOL_ID}/data/schedule`);
    results.fix1 = {
        updateTimeBefore: t0?._updated || null,
        updateTimeAfterScheduleUpload: t1doc._updated,
        updateTimeAfterSchoolNameOnly: t2doc?._updated || null,
        isolatedWriteObserved: fix1Landed,
        finalSchoolName: finalScheduleDoc?.schoolName || '',
        finalScheduleDataCount: (finalScheduleDoc?.scheduleData || []).length,
    };

    // ========================================================================
    // 驗證2：多重調課全員同意 modal 守門條件修正（record.batchId 取代 record.isMultiSwap）
    // ========================================================================
    log('\n--- 驗證2：教師甲對教師乙送出單次調課，確認額外同意人 modal 是否出現 ---');
    const ctxA = await browser.newContext();
    const teacherA = await ctxA.newPage();
    await prepPage(teacherA);
    await loginAs(teacherA, ACCOUNTS.teacherA.email);
    await shot(teacherA, 'teacherA-login');
    log('  教師甲登入成功');

    // 確認教師甲已解鎖（間接複驗修正一：全校 schoolName 已正確回寫，教師端不再卡住）
    await clickTab(teacherA, 'substitute');
    const subUnlocked = await teacherA.locator('#substitute-content').isVisible().catch(() => false);
    log(`  教師甲「調代課申請」頁籤是否已解鎖：${subUnlocked ? '是' : '否'}`);
    if (!subUnlocked) {
        const toast = await toastText(teacherA);
        throw new Error(`教師甲仍卡在調代課申請頁籤（toast: "${toast}"），修正一可能未生效，中止驗證2。`);
    }

    // monkey-patch window.app.buildSwapRecord：僅在本分頁執行期記憶體注入，
    // 不改動任何檔案，純粹讓產生的 reason 帶上「[測試]」字樣以利事後辨識/清理。
    await teacherA.evaluate(() => {
        if (window.app && typeof window.app.buildSwapRecord === 'function' && !window.app.__origBuildSwapRecord) {
            window.app.__origBuildSwapRecord = window.app.buildSwapRecord.bind(window.app);
            window.app.buildSwapRecord = function (...args) {
                const rec = window.app.__origBuildSwapRecord(...args);
                rec.reason = '[測試] v2-verify-fixes 修正二驗證 | ' + rec.reason;
                return rec;
            };
        }
    });

    await teacherA.selectOption('#sub-teacher', { value: ACCOUNTS.teacherA.name });
    await teacherA.fill('#sub-date', DATES.swapA);
    await teacherA.waitForTimeout(300);
    // 實際 radio input 是 display:none 的自訂樣式，真人是點擊旁邊可見的卡片觸發 label 轉發
    await teacherA.click('input[name="change-type-radio"][value="swap"] + .change-type-card');
    await clickCourseCell(teacherA, '週二', '第一節');
    await teacherA.fill('#swap-date', DATES.swapB);
    await teacherA.waitForTimeout(400);
    await teacherA.selectOption('#swap-course', { value: `週三_第一節_${ACCOUNTS.teacherB.name}` });
    await shot(teacherA, 'teacherA-before-confirm');

    await teacherA.click('#confirm-substitute-btn');
    let modalAppeared = false;
    let candidateCount = 0;
    try {
        await teacherA.waitForSelector('.modal', { timeout: 5000 });
        modalAppeared = true;
        candidateCount = await teacherA.locator('.v2-extra-consent-cb').count();
    } catch (_) { /* 未出現 */ }
    await shot(teacherA, 'teacherA-consent-modal-check');
    log(`  [修正二驗證] 送出調課後，額外同意人 modal 是否出現：${modalAppeared ? '是' : '否'}（候選教師數＝${candidateCount}）`);

    let createdRequestType = null;
    let createdReqId = null;
    if (modalAppeared) {
        await teacherA.click(`.v2-extra-consent-cb[value="${ACCOUNTS.chief.name}"]`);
        await teacherA.click('#v2-extra-consent-confirm');
    }
    await teacherA.waitForTimeout(1500);
    await shot(teacherA, 'teacherA-after-submit');
    log(`  教師甲送出後 toast: "${await toastText(teacherA)}"`);

    try {
        const req = await pollUntil(async () => {
            const list = await fsList(`schools/${SCHOOL_ID}/pendingRequests`);
            return list.find(r => r.date === DATES.swapA && r.period === '第一節' && r.className === '7年1班');
        }, { timeout: 20000, desc: '驗證2 pendingRequest 建立' });
        createdRequestType = req.requestType;
        createdReqId = req._id;
        log(`  [修正二驗證] Firestore pendingRequests/${req._id} requestType = ${req.requestType} pendingConsentTeacherIds長度=${(req.pendingConsentTeacherIds || []).length}`);
    } catch (e) {
        log(`  [修正二驗證] 逾時未找到對應的 pendingRequest：${e.message}`);
    }

    results.fix2 = {
        modalAppeared,
        candidateCount,
        createdReqId,
        createdRequestType,
        expectedRequestType: 'multi_swap',
        pass: modalAppeared && createdRequestType === 'multi_swap',
    };

    await browser.close();

    log('\n===== 驗收結果摘要 =====');
    log(JSON.stringify(results, null, 2));
})().catch(async (err) => {
    console.error('\n[FATAL] 腳本執行失敗:', err);
    console.log(JSON.stringify({ ...results, fatalError: err.message }, null, 2));
    process.exit(1);
});
