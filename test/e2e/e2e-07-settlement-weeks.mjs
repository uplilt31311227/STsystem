/**
 * 全流程操作 7：月結算「每月上課週數」設定（設定頁）＋日曆帶入
 *
 * director 在設定頁填日曆 ID／假 key → 按「從日曆帶入」（page.route 攔截 googleapis，回傳
 * test/fixtures/school-calendar-115-1.json，絕不連真實 API）→ 格子出現 1/4/4/5/4/3 →
 * 手改一格 → 儲存 → 以 admin 直讀 Firestore config/settlement 驗證 → 重新整理後值仍在 →
 * 月結算畫面的原定時數依新週數計算。再驗：組長（approver）可編輯並儲存、一般教師欄位停用。
 *
 * 組長寫入依賴 firestore.rules 對 config/settlement 開放 approver；規則未更新時該案會失敗。
 * 開頭重新 seed 並清掉 config/settlement，不依賴前面 suite 的狀態。
 */

import fs from 'node:fs';
import {
    ACCOUNTS, loginStable, gotoTab, shot, realErrors, isSignedIn, loadedScheduleCount,
    ensureModalClosed, LOGIN_TIMEOUT_MS, SCHEDULE_TIMEOUT_MS,
} from './helpers.mjs';
import { Suite, eq, ok } from '../scenarios/harness.mjs';
import { seedAll } from '../emulator/seed.mjs';
import { getDoc, deleteDoc } from '../emulator/emu-client.mjs';

const SCHOOL = 'demo-alpha';
const CFG_PATH = `schools/${SCHOOL}/config/settlement`;
const FIXTURE = fs.readFileSync(new URL('../fixtures/school-calendar-115-1.json', import.meta.url), 'utf8');
const FAKE_KEY = 'FAKE-KEY-FOR-E2E';
const CAL_ID = 'fake-school@group.calendar.google.com';

/** 攔截 Calendar API：回 fixture；記錄請求網址供斷言（確認只帶假 key）。 */
async function mockCalendar(page) {
    page.calendarRequests = [];
    await page.route('https://www.googleapis.com/calendar/**', async (route) => {
        page.calendarRequests.push(route.request().url());
        await route.fulfill({ status: 200, contentType: 'application/json', body: FIXTURE });
    });
}

const readGrid = (page) => page.evaluate(() => {
    const o = {};
    document.querySelectorAll('.sw-week-input').forEach(i => { o[i.dataset.month] = i.value; });
    return o;
});

async function waitCfg(predicate, timeout = 30000) {
    const end = Date.now() + timeout;
    let last = null;
    while (Date.now() < end) {
        const r = await getDoc(CFG_PATH);
        last = r;
        if (r.ok && predicate(r.data)) return r.data;
        await new Promise(r2 => setTimeout(r2, 500));
    }
    return last?.data ?? null;
}

async function reloadAndWait(page) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + LOGIN_TIMEOUT_MS + SCHEDULE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await page.waitForTimeout(500);
        if (await isSignedIn(page) && await loadedScheduleCount(page) > 0) {
            await ensureModalClosed(page);
            return true;
        }
    }
    return false;
}

async function generateAndRead(page, year, month) {
    await gotoTab(page, 'settlement', 1500);
    await page.selectOption('#settle-year', String(year));
    await page.selectOption('#settle-month', String(month));
    await page.evaluate(() => { document.getElementById('settlement-tbody').innerHTML = ''; });
    await page.click('#generate-settlement-btn');
    await page.waitForFunction(() => {
        const btn = document.getElementById('generate-settlement-btn');
        return btn && !btn.disabled && document.querySelector('#settlement-tbody tr[data-has-change]');
    }, null, { timeout: 90000 });
    return page.evaluate(() => {
        const num = (t) => (t.trim() === '-' ? 0 : Number(t.trim().replace('+', '')));
        const out = {};
        document.querySelectorAll('#settlement-tbody tr[data-has-change]').forEach(tr => {
            const c = [...tr.querySelectorAll('td')].map(td => td.innerText);
            out[c[0].trim()] = { original: num(c[1]), actual: num(c[4]), overtime: num(c[5]) };
        });
        const weekly = {};
        (window.app?.dataManager?.scheduleData || []).forEach(r => { weekly[r.teacher] = (weekly[r.teacher] || 0) + 1; });
        return { rows: out, weekly };
    });
}

export async function run(browser) {
    const suite = new Suite('操作 7：月結算上課週數設定與日曆帶入');
    await seedAll({ quiet: true });
    await deleteDoc(CFG_PATH);

    const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
    try {
        await mockCalendar(page);

        await suite.case('director：設定頁有「月結算上課週數」卡片，欄位可編輯', async () => {
            await gotoTab(page, 'settings', 2500);
            eq(await page.isVisible('#settlement-weeks-card'), true, '卡片可見');
            eq(await page.evaluate(() => [...document.querySelectorAll('.sw-week-input, #sw-calendar-id, #sw-api-key, #sw-import-btn, #sw-save-btn')].every(e => !e.disabled)), true, '全部可編輯');
            eq(await page.getAttribute('#sw-api-key', 'type'), 'password', 'key 欄為 password');
            eq(await page.inputValue('#sw-year'), '115', '預設當前學年度');
        });

        await suite.case('從日曆帶入：格子出現 8:1 9:4 10:4 11:5 12:4 1:3，2–7 月維持空白，訊息列出兩類月份', async () => {
            await page.fill('#sw-calendar-id', CAL_ID);
            await page.fill('#sw-api-key', FAKE_KEY);
            await page.click('#sw-import-btn');
            await page.waitForFunction(() => document.querySelector('.sw-week-input[data-month="8"]').value === '1', null, { timeout: 15000 });
            eq(await readGrid(page), { 8: '1', 9: '4', 10: '4', 11: '5', 12: '4', 1: '3', 2: '', 3: '', 4: '', 5: '', 6: '', 7: '' }, '12 格');
            const msg = await page.innerText('#sw-message');
            ok(/已帶入/.test(msg) && /找不到資料/.test(msg) && /2 月/.test(msg), `訊息內容：${msg}`);
            eq(page.calendarRequests.length, 1, '只發出 1 次（被攔截的）日曆請求');
            const u = page.calendarRequests[0];
            ok(u.includes(encodeURIComponent(CAL_ID)) && u.includes(`key=${FAKE_KEY}`) && u.includes('timeMin=2026-08-01'), `請求網址：${u}`);
            await shot(page, '07-weeks-imported');
        });

        await suite.case('手改 10 月為 5 → 儲存 → Firestore config/settlement 內容正確', async () => {
            await page.fill('.sw-week-input[data-month="10"]', '5');
            await page.click('#sw-save-btn');
            const data = await waitCfg(d => d.weeksByYear?.['115']?.['10'] === 5);
            eq(data?.weeksByYear?.['115'], { 8: 1, 9: 4, 10: 5, 11: 5, 12: 4, 1: 3 }, 'weeksByYear.115（2–7 月未存）');
            eq([data?.calendarId, data?.calendarApiKey], [CAL_ID, FAKE_KEY], '日曆 ID／key');
            ok(data?.updatedAt && data?.updatedBy, `updatedAt/updatedBy：${data?.updatedAt} ${data?.updatedBy}`);
            eq((await getDoc(`schools/${SCHOOL}/config/main`)).data?.weeksByYear, undefined, 'config/main 未被汙染');
        });

        await suite.case('不合法值（7）被擋下，不寫入', async () => {
            await page.fill('.sw-week-input[data-month="2"]', '7');
            await page.click('#sw-save-btn');
            await page.waitForTimeout(1500);
            const data = (await getDoc(CFG_PATH)).data;
            eq(data.weeksByYear['115']['2'], undefined, '2 月未寫入');
            await page.fill('.sw-week-input[data-month="2"]', '');
        });

        await suite.case('重新整理後：格子與日曆 ID 仍在', async () => {
            ok(await reloadAndWait(page), '重新整理後應回到已登入');
            await mockCalendar(page);
            await gotoTab(page, 'settings', 2500);
            await page.waitForFunction(() => document.querySelector('.sw-week-input[data-month="10"]').value === '5', null, { timeout: 30000 });
            eq(await readGrid(page), { 8: '1', 9: '4', 10: '5', 11: '5', 12: '4', 1: '3', 2: '', 3: '', 4: '', 5: '', 6: '', 7: '' }, '12 格');
            eq(await page.inputValue('#sw-calendar-id'), CAL_ID, '日曆 ID');
        });

        await suite.case('月結算：10 月原定時數 = 每週節數 × 5（已存值）、9 月 × 4、8 月 × 1', async () => {
            for (const [month, weeks] of [[10, 5], [9, 4], [8, 1]]) {
                const { rows, weekly } = await generateAndRead(page, 115, month);
                const names = Object.keys(rows);
                ok(names.length > 0, `${month} 月應有列`);
                for (const n of names) eq(rows[n].original, (weekly[n] || 0) * weeks, `${month} 月 ${n} 原定時數`);
            }
            eq(realErrors(page), [], '不應有 console 錯誤');
        });
    } finally {
        await page.close();
    }

    // ---- 組長：approver 可編輯並儲存 ----
    const chief = await loginStable(browser, ACCOUNTS.sectionChief, { needSchedule: true });
    try {
        await suite.case('組長：欄位可編輯，改 8 月為 2 並儲存成功，其餘內容保留', async () => {
            await gotoTab(chief.page, 'settings', 2500);
            await chief.page.waitForFunction(() => document.querySelector('.sw-week-input[data-month="10"]').value === '5', null, { timeout: 30000 });
            eq(await chief.page.evaluate(() => [...document.querySelectorAll('.sw-week-input, #sw-save-btn')].every(e => !e.disabled)), true, '組長可編輯');
            await chief.page.fill('.sw-week-input[data-month="8"]', '2');
            await chief.page.click('#sw-save-btn');
            const data = await waitCfg(d => d.weeksByYear?.['115']?.['8'] === 2, 20000);
            eq(data?.weeksByYear?.['115'], { 8: 2, 9: 4, 10: 5, 11: 5, 12: 4, 1: 3 }, '組長儲存後的 weeksByYear（需 firestore.rules 對 approver 開放）');
        });
    } finally {
        await chief.page.close();
    }

    // ---- 一般教師：欄位停用 ----
    const teacher = await loginStable(browser, ACCOUNTS.teacherA);
    try {
        await suite.case('一般教師：欄位與按鈕全部停用，並顯示唯讀說明', async () => {
            // 卡片屬 approver 區塊，教師看不到；仍直接驗 DOM 狀態，確保即使被繞過 CSS 也無法操作
            await teacher.page.evaluate(() => document.querySelector('.tab-btn[data-tab="settings"]')?.click());
            await teacher.page.waitForTimeout(2500);
            const st = await teacher.page.evaluate(() => ({
                disabled: [...document.querySelectorAll('.sw-week-input, #sw-calendar-id, #sw-api-key, #sw-import-btn, #sw-save-btn')].map(e => e.disabled),
                note: document.getElementById('sw-readonly-note')?.textContent || '',
                visible: !!document.getElementById('settlement-weeks-card')?.offsetParent,
            }));
            eq(st.disabled.length, 16, '12 格 + 日曆 ID + key + 2 按鈕');
            eq(st.disabled.every(Boolean), true, '全部停用');
            ok(/僅教務主任與教學組長/.test(st.note), `唯讀說明：${st.note}`);
        });
    } finally {
        await teacher.page.close();
    }
    return suite;
}
