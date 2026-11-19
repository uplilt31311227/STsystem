/**
 * 全流程操作 10：鍵盤走查（P8）
 *
 * 只用鍵盤（Tab／Shift+Tab、Enter、空白鍵、方向鍵、Esc）完成：
 *   1. 一次代課申請（選異動類型 radio、選課程格、選推薦教師、送出）
 *   2. 一次調課申請（以方向鍵切換 radio、選課程格、送出，並處理「其他教師需同意」對話框）
 * 並驗證對話框行為：
 *   - role="dialog"、aria-modal、aria-labelledby 指到可見標題
 *   - 開啟時焦點移進對話框、Tab 不會跑到背景、Esc 關閉、關閉後焦點回到原本的按鈕
 *   - 含輸入的對話框點背景不關閉（內容不遺失）；不含輸入的對話框點背景可關閉
 *   - 以 Tab 能走到 radio、多節開關、課程格、推薦項目、上傳區，且有可讀名稱與狀態（aria-pressed）
 *
 * 「只用鍵盤」的界線：頁面導覽（頁籤切換）、輸入文字與選擇下拉選項都以鍵盤事件完成；
 * 日期欄位與 <select> 以 Playwright 的 fill／selectOption 寫入值（等同使用者在欄位內輸入），不點擊滑鼠。
 * 唯一的滑鼠動作是「點背景」案例，那是被測行為本身。
 * 開頭會重新種一次資料（與 05～09 同）。
 */

import {
    ACCOUNTS, APP_URL, loginStable, shot, waitForText, waitForIdentityName, realErrors, newPage, login, loadedScheduleCount,
} from './helpers.mjs';
import { Suite, eq, ok } from '../scenarios/harness.mjs';
import { seedAll } from '../emulator/seed.mjs';
import { listDocs } from '../emulator/emu-client.mjs';

const SCHOOL = 'demo-alpha';

/** 直接從 emulator 讀（admin，不經畫面）：待審申請與已成立紀錄的 id 清單。取消／Esc 後兩者必須完全不變。 */
async function writeFootprint() {
    const [pending, records] = await Promise.all([
        listDocs(`schools/${SCHOOL}/pendingRequests`),
        listDocs(`schools/${SCHOOL}/substituteRecords`),
    ]);
    const ids = (r) => (r.docs || []).map(d => d.id).sort();
    return { pending: ids(pending), records: ids(records) };
}
function eqFootprint(before, after, what) {
    eq(after.pending.length, before.pending.length, `${what}：pendingRequests 筆數不得變`);
    eq(after.records.length, before.records.length, `${what}：substituteRecords 筆數不得變`);
    eq(after.pending.join(','), before.pending.join(','), `${what}：pendingRequests 內容不得變`);
    eq(after.records.join(','), before.records.join(','), `${what}：substituteRecords 內容不得變`);
}

const DATE_SUB = '2026-09-07';   // 週一：代課申請
const DATE_SWAP_A = '2026-09-14'; // 週一：調課時段 A
const DATE_SWAP_B = '2026-09-16'; // 週三：調課時段 B

/** 反覆按 Tab（最多 max 次），直到焦點落在符合 selector 的元素上。回傳按了幾次，找不到回 -1。 */
async function tabTo(page, selector, max = 160) {
    for (let i = 1; i <= max; i++) {
        await page.keyboard.press('Tab');
        const hit = await page.evaluate((sel) => !!document.activeElement && document.activeElement.matches(sel), selector);
        if (hit) return i;
    }
    return -1;
}

/** 以鍵盤切換頁籤：焦點移到頁籤按鈕後按 Enter。 */
async function keyboardGotoTab(page, tabId) {
    await page.focus(`[data-tab="${tabId}"]`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);
}

const activeInfo = (page) => page.evaluate(() => {
    const a = document.activeElement;
    return a ? { tag: a.tagName, id: a.id || '', cls: a.className || '', insideModal: !!a.closest('.modal:not(.hidden)') } : null;
});

/** 對話框的無障礙屬性：role、aria-modal、標題文字。 */
const dialogInfo = (page, selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const lb = el.getAttribute('aria-labelledby');
    const title = lb ? (document.getElementById(lb)?.textContent || '').trim() : '';
    return { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal'), title };
}, selector);

/** 連按 n 次 Tab／Shift+Tab，焦點是否一直留在對話框內。 */
async function focusStaysInside(page, selector, n = 14) {
    for (let i = 0; i < n; i++) {
        await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab');
        const inside = await page.evaluate((sel) => !!document.activeElement?.closest(sel), selector);
        if (!inside) return false;
    }
    return true;
}


/**
 * 待辦頁明細讀取的可控化：攔截 schoolDataService.js 的回應，在 getRequestDetailsBulkWithStatus 開頭插入
 * 「等 window.__detailGate」與「window.__detailFail 時回傳 error」兩段（只改測試頁收到的程式，不動專案檔案）。
 */
async function openApproverPendingWithGate(browser, mode) {
    const page = await newPage(browser);
    await page.route('**/modules/v2/schoolDataService.js*', async (route) => {
        const resp = await route.fetch();
        let body = await resp.text();
        const sig = 'export async function getRequestDetailsBulkWithStatus(reqIds) {';
        if (!body.includes(sig)) throw new Error('找不到 getRequestDetailsBulkWithStatus，無法安裝測試攔截');
        body = body.replace(sig, sig + `
    window.__detailCalls = (window.__detailCalls || 0) + 1;
    if (window.__detailGate) await window.__detailGate;
    if (window.__detailFail) return new Map((reqIds || []).map(id => [id, { status: 'error', data: null }]));`);
        await route.fulfill({ response: resp, body });
    });
    await page.addInitScript((m) => {
        if (m === 'gate') window.__detailGate = new Promise(r => { window.__releaseDetail = r; });
        if (m === 'fail') window.__detailFail = true;
    }, mode);
    const r = await login(page, ACCOUNTS.sectionChief);
    ok(r.state === 'signed-in', `組長應登入成功（${r.state}）`);
    for (let i = 0; i < 60 && !(await loadedScheduleCount(page) > 0); i++) await page.waitForTimeout(1000);
    return page;
}

export async function run(browser) {
    const suite = new Suite('操作 10：鍵盤走查與對話框無障礙');
    await seedAll({ quiet: true });

    /* ===== 核心控制項可用鍵盤到達、有名稱與狀態 ===== */

    await suite.case('radio、開關、課程格、推薦項目、上傳區都可用 Tab 到達，且有可讀名稱與狀態', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.teacherA, { needSchedule: true });
        try {
            await keyboardGotoTab(page, 'substitute');
            const me = await waitForIdentityName(page);
            await page.fill('#sub-date', DATE_SUB);
            await page.waitForTimeout(1200);

            // 從日期欄往後 Tab：先到異動類型 radio（目前選取的那個是群組的停靠點）
            await page.focus('#sub-date');
            const nRadio = await tabTo(page, 'input[name="change-type-radio"]:checked');
            ok(nRadio > 0, '用 Tab 應能到達異動類型 radio');
            const radioName = await page.evaluate(() => {
                const a = document.activeElement;
                return (a.closest('label')?.innerText || '').replace(/\s+/g, ' ').trim();
            });
            ok(/代課/.test(radioName), `radio 應有可讀名稱「代課」（實際：${radioName}）`);
            eq(await page.evaluate(() => document.querySelector('.change-type-icon').getAttribute('aria-hidden')), 'true', '圖示應對報讀隱藏');
            // 焦點環可見：卡片外框
            const ring = await page.evaluate(() => getComputedStyle(document.activeElement.nextElementSibling).outlineStyle);
            eq(ring, 'solid', '焦點在 radio 時，卡片要畫出焦點環');

            // 步驟三的多節開關
            const nToggle = await tabTo(page, '#multi-course-mode', 80);
            // 步驟三尚未顯示時開關不可見；選課程後才會出現，所以這裡只在可見時檢查
            if (nToggle > 0) {
                const sw = await page.evaluate(() => ({ type: document.activeElement.type, label: document.activeElement.closest('label')?.innerText.trim() }));
                eq(sw.type, 'checkbox', '多節開關是原生 checkbox（空白鍵可切換、狀態由瀏覽器報讀）');
                ok(/多節/.test(sw.label), '多節開關有可讀名稱');
            }

            // 課程格：button，有名稱、aria-pressed
            const cell = await page.evaluate((name) => {
                const el = document.querySelector('.schedule-course.selectable[data-weekday="週一"]');
                return el ? { tag: el.tagName, type: el.getAttribute('type'), pressed: el.getAttribute('aria-pressed'), label: el.getAttribute('aria-label') } : null;
            }, me);
            ok(cell, '週一應有可選課程格');
            eq(cell.tag, 'BUTTON', '課程格是原生 button');
            eq(cell.pressed, 'false', '未選取時 aria-pressed=false');
            ok(/週一/.test(cell.label || '') && /第.節/.test(cell.label || ''), `課程格有可讀名稱（實際：${cell.label}）`);
            await page.focus('#sub-date');
            const nCell = await tabTo(page, '.schedule-course.selectable', 120);
            ok(nCell > 0, '用 Tab 應能到達課程格');

            // 上傳區（課表管理頁籤，組長／主任才看得到）；這裡以結構檢查，實際到達在下一個案例用主任帳號
        } finally { await page.close(); }
    });

    await suite.case('主任：上傳區可用 Tab 到達，Enter 觸發檔案選擇', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
        try {
            await keyboardGotoTab(page, 'schedule');
            const info = await page.evaluate(() => {
                const el = document.getElementById('schedule-upload');
                return { role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), label: el.getAttribute('aria-label') };
            });
            eq(info.role, 'button', '上傳區 role=button');
            eq(info.tabindex, '0', '上傳區可聚焦');
            ok(/課表/.test(info.label || ''), '上傳區有可讀名稱');
            await page.focus('[data-tab="schedule"]');
            const n = await tabTo(page, '#schedule-upload', 160);
            ok(n > 0, '用 Tab 應能到達上傳區');
            // Enter 應觸發檔案選擇器（filechooser 事件）
            const [chooser] = await Promise.all([
                page.waitForEvent('filechooser', { timeout: 5000 }),
                page.keyboard.press('Enter'),
            ]);
            ok(!!chooser, '在上傳區按 Enter 應開啟檔案選擇器');
        } finally { await page.close(); }
    });

    /* ===== 只用鍵盤完成代課申請 ===== */

    await suite.case('只用鍵盤完成一次代課申請', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.teacherA, { needSchedule: true });
        const errs = realErrors(page);
        try {
            await keyboardGotoTab(page, 'substitute');
            const me = await waitForIdentityName(page);
            await page.fill('#sub-date', DATE_SUB);
            await page.waitForTimeout(1200);

            // 異動類型：Tab 到 radio；「代課」已是選取狀態，按空白鍵確認（原生行為）
            await page.focus('#sub-date');
            ok(await tabTo(page, 'input[name="change-type-radio"]:checked') > 0, 'Tab 應到達 radio');
            await page.keyboard.press('Space');
            eq(await page.evaluate(() => document.querySelector('input[name="change-type-radio"]:checked').value), 'substitute', '異動類型為代課');

            // 課程格：Tab 到第一個可選課程，Enter 選取，aria-pressed 變 true
            const cellTab = await tabTo(page, '.schedule-course.selectable', 120);
            ok(cellTab > 0, 'Tab 應到達課程格');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(900);
            eq(await page.evaluate(() => document.activeElement.getAttribute('aria-pressed')), 'true', '選取後 aria-pressed=true');

            // 假別（原生 select，以鍵盤選值）、事由
            await page.focus('#leave-type');
            await page.selectOption('#leave-type', { label: '事假' });
            await page.focus('#sub-reason');
            await page.keyboard.type('鍵盤走查');
            await page.waitForTimeout(1200);

            // 推薦項目：Tab 到第一個推薦教師，空白鍵選取
            await page.focus('#sub-reason');
            const recTab = await tabTo(page, '.recommendation-item', 80);
            ok(recTab > 0, 'Tab 應到達推薦項目');
            const recLabel = await page.evaluate(() => document.activeElement.innerText.replace(/\s+/g, ' ').trim());
            ok(recLabel.length > 1, `推薦項目有可讀名稱（${recLabel}）`);
            eq(await page.evaluate(() => document.activeElement.getAttribute('aria-pressed')), 'false', '選取前 aria-pressed=false');
            await page.keyboard.press('Space');
            await page.waitForTimeout(500);
            eq(await page.evaluate(() => document.activeElement.getAttribute('aria-pressed')), 'true', '選取後 aria-pressed=true');

            // 送出：Tab 到送出鈕（一般教師端文字為「送出申請」，UX-M6），Enter
            const sendTab = await tabTo(page, '#confirm-substitute-btn', 60);
            ok(sendTab > 0, 'Tab 應到達送出鈕');
            eq((await page.innerText('#confirm-substitute-btn')).trim(), '送出申請', '教師端送出鈕文字');
            await page.keyboard.press('Enter');
            ok(await waitForText(page, /已送出|待審核|申請成功|已建立|等待/, 15000), `送出後應有回饋（畫面：${(await page.innerText('body')).slice(0, 120)}）`);
            // UX-M6：除了 5 秒就消失的 toast，頁面上要留一則持續性提示，並附「前往待辦」
            await page.waitForSelector('#v2-submit-banner', { timeout: 10000 });
            ok(/前往待辦/.test(await page.innerText('#v2-submit-banner')), '持續性提示含「前往待辦」');
            // UX-M2：header 顯示「學校｜學期」
            { const hc = (await page.innerText('#header-context')).trim(); ok(/^\S.*｜\d{3}-\d$/.test(hc), `header 顯示非空的學校｜學期（實際：${hc}）`); }
            await shot(page, '10-keyboard-substitute');
            { const bad = errs.filter(e => !/favicon|ERR_|Failed to load resource/i.test(String(e))); eq(bad.length, 0, `不應有頁面錯誤：${bad.join(' | ').slice(0, 300)}`); }
        } finally { await page.close(); }
    });

    /* ===== 只用鍵盤完成調課申請，並驗證「其他教師需同意」對話框 ===== */

    await suite.case('只用鍵盤完成一次調課申請；對話框 Esc、焦點、點背景', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.teacherA, { needSchedule: true });
        try {
            await keyboardGotoTab(page, 'substitute');
            await waitForIdentityName(page);
            await page.fill('#sub-date', DATE_SWAP_A);
            await page.waitForTimeout(1200);

            // 方向鍵切換 radio：Tab 到已選的「代課」，按右方向鍵移到「調課」
            await page.focus('#sub-date');
            ok(await tabTo(page, 'input[name="change-type-radio"]:checked') > 0, 'Tab 應到達 radio');
            await page.keyboard.press('ArrowRight');
            eq(await page.evaluate(() => document.querySelector('input[name="change-type-radio"]:checked').value), 'swap', '方向鍵應切到「調課」');
            await page.waitForTimeout(600);

            // 課程格
            ok(await tabTo(page, '.schedule-course.selectable', 120) > 0, 'Tab 應到達課程格');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(1200);

            // 時段 B：日期與互換課程（select 以鍵盤選第一個可選項）
            await page.focus('#swap-date');
            await page.fill('#swap-date', DATE_SWAP_B);
            await page.waitForTimeout(1500);
            await page.focus('#swap-course');
            const opt = await page.evaluate(() => {
                const o = [...document.querySelectorAll('#swap-course option')].find(x => x.value && !x.disabled);
                return o ? o.value : null;
            });
            ok(opt, '時段 B 應有可選的互換課程');
            await page.selectOption('#swap-course', { value: opt });
            await page.waitForTimeout(1200);

            // 送出 → 出現「其他教師需同意」對話框
            ok(await tabTo(page, '#confirm-substitute-btn', 80) > 0, 'Tab 應到達送出鈕');
            const fpBeforeCancel = await writeFootprint();
            await page.keyboard.press('Enter');
            await page.waitForSelector('#v2-extra-consent-modal', { timeout: 15000 });
            await page.waitForTimeout(300);

            // 對話框屬性
            const di = await dialogInfo(page, '#v2-extra-consent-modal');
            eq(di.role, 'dialog', 'role=dialog');
            eq(di.modal, 'true', 'aria-modal=true');
            ok(/其他教師/.test(di.title), `aria-labelledby 指到標題（實際：${di.title}）`);
            // 焦點移入（搜尋框）
            const a0 = await activeInfo(page);
            ok(a0.insideModal, `開啟時焦點應在對話框內（實際：${JSON.stringify(a0)}）`);
            eq(a0.id, 'v2-extra-consent-search', '焦點先落在搜尋框');
            // 有取消鈕
            ok(await page.$('#v2-extra-consent-cancel'), '應有「取消」鈕');
            // Tab 不跑到背景
            ok(await focusStaysInside(page, '#v2-extra-consent-modal'), 'Tab／Shift+Tab 的焦點不得離開對話框');

            // 搜尋可過濾名單
            await page.focus('#v2-extra-consent-search');
            const totalBefore = await page.$$eval('.v2-extra-consent-item', els => els.filter(e => e.style.display !== 'none').length);
            await page.keyboard.type('zzzz不存在');
            const shown = await page.$$eval('.v2-extra-consent-item', els => els.filter(e => e.style.display !== 'none').length);
            eq(shown, 0, '搜尋不到時名單應全部隱藏');
            ok(totalBefore > 0, '搜尋前名單不為空');
            await page.fill('#v2-extra-consent-search', '');
            await page.keyboard.press('Backspace');   // 觸發 input 事件還原名單
            ok((await page.$$eval('.v2-extra-consent-item', els => els.filter(e => e.style.display !== 'none').length)) === totalBefore, '清空搜尋後名單還原');

            // 含輸入的對話框：點背景不關閉（滑鼠點在對話框外的角落）
            await page.mouse.click(4, 4);
            await page.waitForTimeout(300);
            ok(await page.$('#v2-extra-consent-modal'), '含輸入的對話框，點背景不得關閉');

            // Esc 關閉＝取消送出，焦點回到送出鈕
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
            ok(!(await page.$('#v2-extra-consent-modal')), 'Esc 應關閉對話框');
            const a1 = await activeInfo(page);
            eq(a1.id, 'confirm-substitute-btn', `關閉後焦點應回到送出鈕（實際：${JSON.stringify(a1)}）`);
            ok(await waitForText(page, /已取消送出|尚未送出/, 6000), '取消後應提示未送出');
            await page.waitForTimeout(1500);   // 給任何誤送出的寫入時間落地，再比對
            eqFootprint(fpBeforeCancel, await writeFootprint(), 'Esc 取消送出後');

            // 再送一次，這次用鍵盤選「僅雙方調課」
            await page.keyboard.press('Enter');
            await page.waitForSelector('#v2-extra-consent-modal', { timeout: 15000 });
            await page.focus('#v2-extra-consent-skip');
            await shot(page, '10-keyboard-swap-dialog');
            await page.keyboard.press('Enter');
            ok(await waitForText(page, /已送出|待同意|申請成功|已建立|等待/, 15000), `調課送出後應有回饋（畫面：${(await page.innerText('body')).slice(0, 120)}）`);
        } finally { await page.close(); }
    });

    /* ===== 其他對話框：確認框、拒絕原因 ===== */

    await suite.case('確認對話框：Esc 關閉、焦點還原、Tab 不跑到背景；撤回的鈕不會因防連點而失焦', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.teacherA, { needSchedule: true });
        try {
            await keyboardGotoTab(page, 'v2-pending');
            await page.waitForSelector('.v2-cancel-btn', { timeout: 20000 });
            const fpConfirm = await writeFootprint();
            await page.focus('.v2-cancel-btn');
            await page.keyboard.press('Enter');
            await page.waitForSelector('#confirm-modal:not(.hidden)', { timeout: 10000 });
            await page.waitForTimeout(300);
            const di = await dialogInfo(page, '#confirm-modal');
            eq(di.role, 'dialog', '確認框 role=dialog');
            eq(di.modal, 'true', '確認框 aria-modal');
            eq(di.title, '撤回請求', '確認框 aria-labelledby 指到標題');
            const a = await activeInfo(page);
            ok(a.insideModal, `確認框開啟時焦點應在框內（實際：${JSON.stringify(a)}）`);
            ok(await focusStaysInside(page, '#confirm-modal'), '確認框 Tab 不得跑到背景');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(600);
            ok(await page.$eval('#confirm-modal', el => el.classList.contains('hidden')), 'Esc 應關閉確認框');
            // 焦點回到「撤回」鈕（防連點結束後該鈕恢復可用，焦點才還得回去）
            await page.waitForFunction(() => document.activeElement?.classList?.contains('v2-cancel-btn'), null, { timeout: 5000 });
            await page.waitForTimeout(1500);
            eqFootprint(fpConfirm, await writeFootprint(), 'Esc 取消撤回後');
        } finally { await page.close(); }
    });

    await suite.case('拒絕原因對話框（含輸入）：點背景不關閉、Esc 關閉、焦點還原', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.sectionChief, { needSchedule: true });
        try {
            await keyboardGotoTab(page, 'v2-pending');
            await page.waitForSelector('.v2-reject-btn', { timeout: 20000 });
            const fpReject = await writeFootprint();
            await page.focus('.v2-reject-btn');
            await page.keyboard.press('Enter');
            await page.waitForSelector('#v2-reject-reason-input', { timeout: 10000 });
            const di = await page.evaluate(() => {
                const m = document.querySelector('.modal:has(#v2-reject-reason-input)');
                const lb = m.getAttribute('aria-labelledby');
                return { role: m.getAttribute('role'), modal: m.getAttribute('aria-modal'), title: document.getElementById(lb)?.textContent.trim(), focusId: document.activeElement.id };
            });
            eq(di.role, 'dialog', 'role=dialog');
            eq(di.modal, 'true', 'aria-modal');
            eq(di.title, '拒絕原因', '標題關聯');
            eq(di.focusId, 'v2-reject-reason-input', '焦點先落在輸入框');
            await page.keyboard.type('輸入到一半的原因');
            await page.mouse.click(4, 4);
            await page.waitForTimeout(300);
            ok(await page.$('#v2-reject-reason-input'), '含輸入的對話框點背景不得關閉');
            eq(await page.inputValue('#v2-reject-reason-input'), '輸入到一半的原因', '已輸入的內容不得遺失');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(400);
            ok(!(await page.$('#v2-reject-reason-input')), 'Esc 應關閉');
            await page.waitForFunction(() => document.activeElement?.classList?.contains('v2-reject-btn'), null, { timeout: 5000 });
            await page.waitForTimeout(1500);
            eqFootprint(fpReject, await writeFootprint(), 'Esc 取消拒絕後');
        } finally { await page.close(); }
    });


    /* ===== 頁首登入狀態（批次 C 的 SF-V1 曾讓 V2 頁首停在未登入） ===== */

    await suite.case('V2 登入後頁首：已登入區塊顯示、未登入區塊隱藏、有登出鈕與姓名角色', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.teacherA);
        try {
            await waitForIdentityName(page);
            ok(await page.isVisible('#auth-logged-in'), '#auth-logged-in 應可見');
            ok(!(await page.isVisible('#auth-logged-out')), '#auth-logged-out 應隱藏');
            ok(await page.isVisible('#signout-btn'), '登出鈕應可見');
            ok(await page.isVisible('#user-name .v2-role-tag'), '姓名旁應有角色標籤');
            ok(await page.isVisible('#user-avatar-fallback') || await page.isVisible('#user-avatar'), '應有頭像或首字圓章');
        } finally { await page.close(); }
    });

    await suite.case('Firebase SDK 載入失敗：12 秒內遮罩改顯示登入按鈕或錯誤，不停在「載入中」', async () => {
        const page = await newPage(browser);
        try {
            await page.route('https://www.gstatic.com/firebasejs/**', (route) => route.abort());
            await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => {
                const g = document.getElementById('v2-auth-gate');
                return g && (g.querySelector('#v2-gate-google, #v2-gate-email') || /失敗|錯誤/.test(g.innerText));
            }, null, { timeout: 12000 });
            ok(!/載入中/.test(await page.innerText('#v2-auth-gate')), '遮罩不應仍顯示「載入中」');
        } finally { await page.close(); }
    });

    /* ===== 課表編輯器：格子可用鍵盤操作（P8-1） ===== */

    await suite.case('課表編輯器：格子有 role／名稱，可用 Enter／空白鍵開啟編輯、Esc 關閉並回到原格、鍵盤完成新增與刪除', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
        const errs = realErrors(page);
        try {
            await keyboardGotoTab(page, 'schedule');
            await page.focus('.subview-switch-btn[data-subview="editor"]');
            await page.keyboard.press('Enter');
            await page.waitForSelector('#editor-teacher-select', { state: 'visible', timeout: 10000 });
            await page.selectOption('#editor-teacher-select', { label: '巫阿福' });
            await page.waitForSelector('#editor-schedule-grid .editor-empty', { timeout: 10000 });

            // 取一個空格：有 role=button、tabindex=0、可讀名稱
            const info = await page.evaluate(() => {
                const el = document.querySelector('#editor-schedule-grid .editor-empty');
                return { role: el.getAttribute('role'), tabindex: el.getAttribute('tabindex'), label: el.getAttribute('aria-label'), wd: el.dataset.weekday, pd: el.dataset.period };
            });
            eq(info.role, 'button', '空格 role=button');
            eq(info.tabindex, '0', '空格可聚焦');
            ok(/新增課程/.test(info.label || '') && (info.label || '').includes(info.wd) && (info.label || '').includes(info.pd), `空格有可讀名稱（${info.label}）`);
            const courseLabel = await page.evaluate(() => document.querySelector('#editor-schedule-grid .editor-course')?.getAttribute('aria-label') || '');
            ok(/^編輯 /.test(courseLabel), `課程格有可讀名稱（${courseLabel}）`);
            const cell = `#editor-schedule-grid [data-weekday="${info.wd}"][data-period="${info.pd}"]`;

            // Tab 能走到格子；Enter 開啟、Esc 關閉、焦點回到原格
            await page.focus('#editor-teacher-select');
            const n = await tabTo(page, '#editor-schedule-grid [role="button"]', 20);
            ok(n > 0, 'Tab 應能從教師選單走到課表格子');
            await page.focus(cell);
            await page.keyboard.press('Enter');
            await page.waitForSelector('#course-edit-modal:not(.hidden)', { timeout: 5000 });
            ok((await activeInfo(page)).insideModal, 'Enter 後焦點應移進編輯對話框');
            await page.keyboard.press('Escape');
            await page.waitForSelector('#course-edit-modal.hidden', { state: 'attached', timeout: 5000 });
            await page.waitForTimeout(500);
            ok(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), cell), 'Esc 關閉後焦點應回到原格');

            // 空白鍵開啟（不應捲動頁面）、輸入、鍵盤按「儲存」，格子變成課程並保有焦點
            await page.focus(cell);
            await page.keyboard.press('Space');
            await page.waitForSelector('#course-edit-modal:not(.hidden)', { timeout: 5000 });
            await page.fill('#course-modal-class', '7年1班');
            await page.fill('#course-modal-subject', '國文');
            await page.focus('#course-modal-save-btn');
            await page.keyboard.press('Enter');
            await page.waitForSelector(`${cell}.editor-course`, { timeout: 8000 });
            await page.waitForTimeout(500);
            ok(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), cell), '儲存後焦點應停在剛編輯的格子（重畫不讓焦點掉回頁首）');

            // 清掉剛新增的課（同樣只用鍵盤），避免影響之後的案例
            await page.keyboard.press('Enter');
            await page.waitForSelector('#course-edit-modal:not(.hidden)', { timeout: 5000 });
            await page.focus('#course-modal-delete-btn');
            await page.keyboard.press('Enter');
            await page.waitForSelector('#confirm-modal:not(.hidden)', { timeout: 5000 });
            await page.focus('#confirm-modal-confirm-btn');
            await page.keyboard.press('Enter');
            await page.waitForSelector(`${cell}.editor-empty`, { timeout: 8000 });
            { const bad = errs.filter(e => !/favicon|ERR_|Failed to load resource/i.test(String(e))); eq(bad.length, 0, `不應有頁面錯誤：${bad.join(' | ').slice(0, 300)}`); }
        } finally { await page.close(); }
    });

    /* ===== 待辦頁：明細讀取不擋畫面 ===== */

    await suite.case('待辦頁：明細尚未回來時卡片已畫出並顯示「讀取中…」，放行後補上，不殘留「讀取中」', async () => {
        const page = await openApproverPendingWithGate(browser, 'gate');
        try {
            await keyboardGotoTab(page, 'v2-pending');
            await page.waitForSelector('.v2-final-approve-btn', { timeout: 20000 });   // 核准鈕＝卡片已畫出
            await page.waitForSelector('[data-approval-detail]', { timeout: 5000 });
            ok(await page.evaluate(() => window.__detailCalls >= 1), '應已發出明細讀取（且卡在閘門）');
            const during = await page.$$eval('[data-approval-detail]', els => els.map(e => e.innerText));
            ok(during.length > 0 && during.every(t => t.includes('讀取中')), `閘門未放行時每張審核卡片的明細應是「讀取中…」（實際：${JSON.stringify(during)}）`);
            ok(during.every(t => !t.includes('未填') && !t.includes('失敗')), '讀取中不得顯示「未填」或失敗');
            ok(!(await page.innerText('#v2-pending-list')).includes('載入中…'), '整頁不得停在「載入中…」');
            await shot(page, '10-pending-detail-loading');
            await page.evaluate(() => window.__releaseDetail());
            await page.waitForFunction(() => [...document.querySelectorAll('[data-approval-detail]')].every(e => !e.innerText.includes('讀取中')), null, { timeout: 15000 });
            const after = await page.$$eval('[data-approval-detail]', els => els.map(e => e.innerText));
            ok(after.every(t => !t.includes('明細讀取失敗')), `放行後不得顯示讀取失敗（實際：${JSON.stringify(after)}）`);
            ok(after.every(t => /假別/.test(t) && /事由/.test(t)), '放行後仍有假別與事由欄');
        } finally { await page.close(); }
    });

    await suite.case('待辦頁：明細讀取失敗時卡片顯示「明細讀取失敗」，不停在「讀取中」也不顯示「未填」', async () => {
        const page = await openApproverPendingWithGate(browser, 'fail');
        try {
            await keyboardGotoTab(page, 'v2-pending');
            await page.waitForSelector('.v2-final-approve-btn', { timeout: 20000 });
            await page.waitForFunction(() => {
                const els = [...document.querySelectorAll('[data-approval-detail]')];
                return els.length > 0 && els.every(e => e.innerText.includes('明細讀取失敗'));
            }, null, { timeout: 15000 });
            const t = (await page.$$eval('[data-approval-detail]', els => els.map(e => e.innerText))).join('|');
            ok(!t.includes('讀取中') && !t.includes('未填'), `失敗時不得殘留「讀取中」或誤顯示「未填」（實際：${t}）`);
        } finally { await page.close(); }
    });

    return suite;
}
