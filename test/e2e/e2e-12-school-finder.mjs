/**
 * 全流程操作 12：登入後尚未綁定學校 →「找學校」搜尋（教育部學校代碼）
 *
 *   1. 搜尋「內湖」，候選清單含 新竹市 市立內湖國中；選它顯示「此校已在使用本系統」（別名 183511→inhu）與「加入」鈕。
 *   2. 不存在的字串顯示「找不到符合的學校」。
 *   3. 鍵盤：輸入代碼 → 方向鍵 → Enter 選到尚未使用的學校 → 申請表單自動帶入校名與代碼（唯讀）→ 送出
 *      → 申請為 pending，desiredSchoolId 為該校代碼（小寫）。Esc 可關閉候選清單。
 * 開頭自行 seed；會留下一筆申請，排在 09（會重新 seed）之前。
 */
import { newPage, login, bodyText, shot, waitForText } from './helpers.mjs';
import { ACCOUNTS } from './helpers.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';
import { seedAll } from '../emulator/seed.mjs';
import { getDoc, mustSetDoc } from '../emulator/emu-client.mjs';

const TAIPEI_NEIHU_ELEM = { code: '403601', name: '市立內湖國小' };   // 臺北市；未在系統內

export async function run(browser) {
    const suite = new Suite('操作 12：找學校（教育部學校代碼）');
    const seed = await seedAll({ quiet: true });
    const uid = seed.outsider.localId;

    const page = await newPage(browser);
    try {
        const r = await login(page, ACCOUNTS.outsider);
        eq(r.state, 'needs-school', '外部帳號應停在找學校畫面');
        await page.waitForSelector('#v2-school-picker-input', { timeout: 20000 });

        await suite.case('搜尋「內湖」可找到新竹市 市立內湖國中；選它顯示「此校已在使用本系統」', async () => {
            await page.fill('#v2-school-picker-input', '內湖');
            await page.waitForSelector('#v2-school-picker-list [role="option"]', { timeout: 15000 });
            const opts = await page.$$eval('#v2-school-picker-list [role="option"]', els => els.map(e => e.innerText));
            const hit = opts.findIndex(t => t.includes('市立內湖國中') && t.includes('新竹市') && t.includes('183511'));
            ok(hit >= 0, `候選清單應含 新竹市 市立內湖國中（實際：${opts.join(' | ')}）`);
            ok(opts.every(t => /代碼 \w+/.test(t)), '每個候選都顯示代碼');
            await page.click(`#v2-school-picker-opt-${hit}`);
            await page.waitForSelector('#v2-gate-join-school', { timeout: 15000 });
            includes(await page.innerText('#v2-school-pick-panel'), '此校已在使用本系統', '別名命中應顯示已在使用');
            ok(await page.$('#v2-apply-school-name') === null, '已在使用的學校不顯示申請表單');
            await shot(page, '12-in-use');
        });

        await suite.case('找不到時顯示「找不到符合的學校」', async () => {
            await page.fill('#v2-school-picker-input', '不存在的學校名稱zzz');
            await page.waitForFunction(() => /找不到符合的學校/.test(document.getElementById('v2-school-picker-status')?.innerText || ''), null, { timeout: 10000 });
            ok(await page.getAttribute('#v2-school-picker-input', 'aria-expanded') === 'false', '無結果時清單收合');
        });

        await suite.case('鍵盤選到尚未使用的學校：Esc 關閉清單；申請帶入校名與代碼並送出為 pending', async () => {
            await page.fill('#v2-school-picker-input', TAIPEI_NEIHU_ELEM.code);
            await page.waitForSelector('#v2-school-picker-list [role="option"]', { timeout: 15000 });
            eq(await page.getAttribute('#v2-school-picker-input', 'aria-expanded'), 'true', '清單展開');
            await page.keyboard.press('Escape');
            eq(await page.getAttribute('#v2-school-picker-input', 'aria-expanded'), 'false', 'Esc 關閉清單');
            await page.keyboard.press('ArrowDown');                 // 重新開啟
            await page.keyboard.press('ArrowDown');                 // 選第一項
            ok(!!(await page.getAttribute('#v2-school-picker-input', 'aria-activedescendant')), '方向鍵設定 aria-activedescendant');
            await page.keyboard.press('Enter');
            await page.waitForSelector('#v2-gate-submit-apply', { timeout: 15000 });
            includes(await page.innerText('#v2-school-pick-panel'), '此校尚未使用本系統', '應顯示尚未使用');
            eq(await page.inputValue('#v2-apply-school-name'), TAIPEI_NEIHU_ELEM.name, '校名自動帶入');
            eq(await page.inputValue('#v2-apply-school-id'), TAIPEI_NEIHU_ELEM.code, '代碼自動帶入');
            ok(await page.getAttribute('#v2-apply-school-name', 'readonly') !== null, '校名唯讀');
            ok(await page.getAttribute('#v2-apply-school-id', 'readonly') !== null, '代碼唯讀');
            await shot(page, '12-apply-form');
            await page.click('#v2-gate-submit-apply');
            ok(await waitForText(page, /申請審核中/, 30000), `送出後應顯示申請審核中（畫面：${(await bodyText(page)).slice(0, 150)}）`);
            const doc = await getDoc(`schoolApplications/${uid}`);
            eq(doc?.data?.status, 'pending', '申請狀態 pending');
            eq(doc?.data?.desiredSchoolId, TAIPEI_NEIHU_ELEM.code, 'desiredSchoolId = 學校代碼');
            eq(doc?.data?.schoolName, TAIPEI_NEIHU_ELEM.name, 'schoolName = 資料檔校名');
        });

        await suite.case('申請被駁回後重新登入：直接看到駁回原因（已 escape），不必先選學校', async () => {
            const cur = (await getDoc(`schoolApplications/${uid}`)).data;
            await mustSetDoc(`schoolApplications/${uid}`, { ...cur, status: 'rejected', rejectReason: '資料不符<b id="xss-probe">請確認</b>' });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector('#v2-gate-rejected-note', { timeout: 60000 });
            const note = await page.innerText('#v2-gate-rejected-note');
            includes(note, '上次申請已被駁回', '應顯示駁回提示');
            includes(note, '資料不符<b id="xss-probe">請確認</b>', '駁回原因以純文字顯示');
            ok(await page.$('#xss-probe') === null, '駁回原因不得被當成 HTML');
        });
    } finally { await page.close(); }
    return suite;
}
