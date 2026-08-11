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
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('#v2-gate-email', { timeout: 15000 });
    await page.click('#v2-gate-email');
    await page.waitForSelector('#v2-modal-email', { timeout: 10000 });
    await page.fill('#v2-modal-email', email);
    await page.fill('#v2-modal-pwd', password);
    await page.click('#v2-modal-submit');

    // 三種可能結局：進入系統、被導向「加入/申請學校」、modal 顯示錯誤訊息
    const deadline = Date.now() + 20000;
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
    }
    return { state: 'timeout', message: '登入後 20 秒內沒有進入任何已知狀態' };
}

/** 以「主要頁籤是否可見」判定已進入系統。 */
export async function isSignedIn(page) {
    const tab = await page.$('[data-tab="substitute"]');
    return !!(tab && await tab.isVisible());
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
