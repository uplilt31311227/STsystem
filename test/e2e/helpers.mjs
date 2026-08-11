/**
 * 全流程操作測試的共用工具
 *
 * 真的開瀏覽器、真的點畫面上的按鈕、真的送出表單，資料一路寫到本機 Emulator。
 * 前端連 emulator 靠網址參數 `?v2=1&emu=1`（見 firebaseConfig.js 的 shouldUseEmulator）。
 */

import { chromium } from 'playwright';

export const APP_URL   = 'http://localhost:8000/?v2=1&emu=1';
export const PASSWORD  = 'test-password-1234';
export const SHOT_DIR  = 'test/e2e-screenshots';

/** seed 產生的帳號：t01=主任、t02=教學組長、其餘為一般教師（t11/t14/t20 刻意無帳號）。 */
export const ACCOUNTS = {
    director:     't01@alpha.demo.test',
    sectionChief: 't02@alpha.demo.test',
    teacherA:     't03@alpha.demo.test',
    teacherB:     't04@alpha.demo.test',
    teacherC:     't05@alpha.demo.test',
    betaDirector: 't01@beta.demo.test',
    outsider:     'outsider@nowhere.test',
};

/** 沒有 email 的教師（名冊中存在，但無法登入） */
export const NO_ACCOUNT_TEACHERS = ['謝孟儒', '徐子涵', '周宜蓁'];

export async function launchBrowser() {
    return chromium.launch();
}

/**
 * Firebase SDK 的本機快取（跨 page 共用）。
 *
 * ⚠ 這是整組 e2e 穩定度的關鍵。index.html 不打包 Firebase，SDK 是在 firebaseConfig.js 裡
 * 用動態 import 從 https://www.gstatic.com/firebasejs/... 抓的。每開一個全新的 page 就是一次
 * 全新的瀏覽器環境（無快取），等於每次登入都要重新下載整套 SDK；一旦某次下載慢或被限流，
 * initializeFirebase() 就無法完成，畫面會回報「請先完成 Firebase 設定」，或是 SDK 只載入一半
 * 而讓後續 Firestore 查詢永遠不回應（先前一直誤以為是 app 的競態）。
 *
 * 每個 URL 只真正下載一次，之後由記憶體回應。這只影響測試環境的載入來源，
 * 內容與 gstatic 上的完全相同。
 */
const sdkCache = new Map();

async function installSdkCache(page) {
    await page.route('https://www.gstatic.com/firebasejs/**', async (route) => {
        const url = route.request().url();
        try {
            if (!sdkCache.has(url)) {
                const res = await fetch(url);
                if (!res.ok) return route.continue();
                sdkCache.set(url, {
                    body: Buffer.from(await res.arrayBuffer()),
                    contentType: res.headers.get('content-type') || 'application/javascript',
                });
            }
            const hit = sdkCache.get(url);
            await route.fulfill({ status: 200, body: hit.body, contentType: hit.contentType });
        } catch {
            await route.continue();
        }
    });
}

/**
 * 開一個新分頁，並收集 console 錯誤與未捕捉例外——「操作有沒有成功」和
 * 「過程中有沒有炸出錯誤」是兩件事，後者不看就會漏掉一整類問題。
 */
export async function newPage(browser) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.errors = [];
    page.on('console', m => {
        if (m.type() === 'error') page.errors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', e => page.errors.push('未捕捉例外：' + e.message.slice(0, 200)));
    await installSdkCache(page);
    return page;
}

/** 忽略已知無害的 console 噪音（例如瀏覽器對 favicon 的 404）。 */
export function realErrors(page) {
    return page.errors.filter(e => !/favicon|net::ERR_FAILED.*favicon/i.test(e));
}

/**
 * 完整走一次登入 UI。
 * @returns {'signed-in'|'needs-school'|'error'} 登入後落在哪個狀態
 */
export async function login(page, email, password = PASSWORD) {
    // ⚠ 不可用 waitUntil:'networkidle'——Firestore 的即時訂閱是長連線，網路永遠不會 idle，
    // goto 會固定等到 30 秒逾時。改等 DOM 就緒，再明確等待要操作的元素出現。
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#v2-gate-email', { timeout: 20000 });
    await page.click('#v2-gate-email');
    await page.waitForSelector('#v2-modal-email', { timeout: 10000 });
    await page.fill('#v2-modal-email', email);
    await page.fill('#v2-modal-pwd', password);
    await page.click('#v2-modal-submit');

    // 四種可能結局：進入系統、被導向「加入/申請學校」、modal 顯示錯誤、卡在遮罩
    const deadline = Date.now() + 22000;
    let authedAt = null;
    while (Date.now() < deadline) {
        await page.waitForTimeout(400);

        const msg = await page.$('#v2-modal-msg');
        if (msg && await msg.isVisible()) {
            const text = (await msg.innerText()).trim();
            if (text) return { state: 'error', message: text };
        }
        const bodyText = await page.innerText('body').catch(() => '');
        if (/尚未綁定任何學校|加入既有學校|申請開通新學校/.test(bodyText)) {
            return { state: 'needs-school', message: bodyText.slice(0, 200) };
        }
        if (await isSignedIn(page)) return { state: 'signed-in', message: '' };

        // Firebase 已經認證成功、但畫面還停在原始登入遮罩（data-render-key 仍是 default）
        // ＝ bootstrap 卡住了。不必等滿 22 秒，早點回報讓上層重試。
        const st = await page.evaluate(() => ({
            authed: !!(window.firebaseModules?.getAuth?.()?.currentUser),
            gateKey: document.getElementById('v2-auth-gate')?.getAttribute('data-render-key') ?? null,
        })).catch(() => ({ authed: false, gateKey: null }));
        if (st.authed && !authedAt) authedAt = Date.now();
        if (authedAt && Date.now() - authedAt > 9000 && st.gateKey === 'default') {
            return { state: 'stuck', message: 'Firebase 認證成功，但畫面停在登入遮罩（bootstrap 未完成）' };
        }
    }
    return { state: 'timeout', message: '登入後 22 秒內沒有進入任何已知狀態' };
}

/**
 * 判定「真的進入系統了」。
 *
 * ⚠ 不能只看頁籤是否可見——登入遮罩 #v2-auth-gate 是覆蓋在上層的元素（z-index 1100），
 * 底下的頁籤在 Playwright 眼中仍然是 visible。只看頁籤會把「卡在遮罩」誤判成登入成功，
 * 後續每個操作都會因為點不到而失敗，卻看不出真正原因。
 */
export async function isSignedIn(page) {
    return page.evaluate(() => {
        const gate = document.getElementById('v2-auth-gate');
        const gateShown = gate ? getComputedStyle(gate).display !== 'none' : false;
        const tab = document.querySelector('[data-tab="substitute"]');
        const tabShown = tab ? tab.offsetParent !== null : false;
        // 登入視窗的 backdrop 關閉前仍會攔截所有點擊（關閉有淡出動畫），
        // 這時候就回報「已登入」的話，後續第一個操作會莫名其妙點不到。
        const modal = document.getElementById('v2-auth-modal-backdrop');
        const modalShown = modal ? getComputedStyle(modal).display !== 'none' : false;
        return !gateShown && tabShown && !modalShown;
    });
}

/**
 * 確保登入視窗的 backdrop 真的關掉。
 *
 * 實測登入成功後，#v2-auth-modal-backdrop 有時仍留在畫面上攔截所有點擊（30 秒都不消失），
 * 使用者看得到主畫面卻什麼都點不動。先按取消鈕；仍在就直接隱藏，避免整組測試被它擋死。
 * @returns {Promise<boolean>} true 表示需要測試主動介入才關掉（值得記錄的現象）
 */
export async function ensureModalClosed(page) {
    const shown = () => page.evaluate(() => {
        const m = document.getElementById('v2-auth-modal-backdrop');
        return !!(m && getComputedStyle(m).display !== 'none');
    });
    if (!await shown()) return false;

    await page.evaluate(() => document.getElementById('v2-modal-cancel')?.click());
    await page.waitForTimeout(500);
    if (!await shown()) return true;

    await page.evaluate(() => {
        const m = document.getElementById('v2-auth-modal-backdrop');
        if (m) m.style.display = 'none';
    });
    return true;
}

/** 課表是否已載入（部分操作需要課表才有意義）。 */
export function loadedScheduleCount(page) {
    return page.evaluate(() => window.app?.dataManager?.scheduleData?.length ?? 0);
}

/**
 * 預期會成功的登入：失敗就整頁重來。
 *
 * 為什麼需要重試：在本機 emulator 環境下，Firestore 的一次性查詢（getDocs）會偶發永不回應
 * ——不逾時、不拋錯，於是 bootstrap 停在某一步、unlockV2App() never 執行，畫面卡在登入遮罩。
 * 根因尚未定位（已排除資料、projectId、重複 bootstrap、連線耗盡等），實測成功率約兩成。
 * 這個重試是為了讓「操作測試」能問到它真正想問的問題，不是把問題掩蓋掉——登入穩定度本身
 * 由 e2e-00-login-stability 專門量測並回報。
 */
export async function loginStable(browser, email, { attempts = 15, needSchedule = false } = {}) {
    let last = null;
    let page = null;
    for (let i = 1; i <= attempts; i++) {
        // 每次重試都用全新的 page：上一輪若已通過 Firebase 認證，session 會留在該 page 的
        // 儲存空間裡，重新 goto 會直接是已登入狀態，連登入按鈕都找不到。
        if (page) await page.close();
        page = await newPage(browser);

        last = await login(page, email);
        if (last.state === 'signed-in') {
            const forced = await ensureModalClosed(page);
            if (!needSchedule) return { page, result: { ...last, attempts: i, modalForcedClosed: forced } };
            // 課表由即時訂閱送達，可能比登入完成明顯晚（同一個不穩定問題）
            for (let w = 0; w < 30; w++) {
                if (await loadedScheduleCount(page) > 0) {
                    return { page, result: { ...last, attempts: i, modalForcedClosed: forced } };
                }
                await page.waitForTimeout(500);
            }
        } else if (last.state === 'error') {
            return { page, result: { ...last, attempts: i } };   // 帳密本身的問題，重試沒有意義
        }
    }
    if (page) await page.close();
    throw new Error(
        `登入 ${email} 重試 ${attempts} 次仍未就緒（最後狀態：${last?.state}）。` +
        `請確認 emulator 與種子資料正常；這通常是本機 Firestore 查詢無回應的已知不穩定問題。`
    );
}

/** 目前可見的頁籤 data-tab 清單。 */
export async function visibleTabs(page) {
    const out = [];
    for (const t of await page.$$('[data-tab]')) {
        if (await t.isVisible()) {
            const id = await t.getAttribute('data-tab');
            if (id && !out.includes(id)) out.push(id);
        }
    }
    return out;
}

/** 切到某個頁籤並等待內容渲染。 */
export async function gotoTab(page, tabId, settle = 1200) {
    const tab = await page.$(`[data-tab="${tabId}"]`);
    if (!tab) throw new Error(`找不到頁籤 ${tabId}`);
    if (!await tab.isVisible()) throw new Error(`頁籤 ${tabId} 不可見（可能是角色權限）`);
    await tab.click();
    await page.waitForTimeout(settle);
}

/** 目前登入者顯示的姓名與角色。 */
export async function whoAmI(page) {
    const el = await page.$('.user-info, #v2-identity, #user-name');
    return el ? (await el.innerText()).replace(/\s+/g, ' ').trim() : '';
}

export async function shot(page, name) {
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

/** 目前畫面的純文字，供內容斷言。 */
export function bodyText(page) {
    return page.innerText('body');
}

/** 等待畫面上出現某段文字（例如 toast 或錯誤訊息）。 */
export async function waitForText(page, pattern, timeout = 10000) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const t = await page.innerText('body').catch(() => '');
        if (re.test(t)) return true;
        await page.waitForTimeout(250);
    }
    return false;
}

/** 確認本機服務與 emulator 都在跑，否則給出可操作的指示。 */
export async function assertEnvironment() {
    const problems = [];
    try {
        const r = await fetch('http://localhost:8000/index.html', { method: 'HEAD' });
        if (!r.ok) problems.push(`本機網頁伺服器回應 ${r.status}`);
    } catch {
        problems.push('本機網頁伺服器沒有在 http://localhost:8000 執行（請先跑 python start-server.py）');
    }
    try {
        const r = await fetch('http://127.0.0.1:8080/');
        if (!r.ok) problems.push(`Firestore Emulator 回應 ${r.status}`);
    } catch {
        problems.push('Firestore Emulator 沒有在 127.0.0.1:8080 執行（請先跑 npm run emu）');
    }
    if (problems.length) throw new Error('環境未就緒：\n  - ' + problems.join('\n  - '));
}
