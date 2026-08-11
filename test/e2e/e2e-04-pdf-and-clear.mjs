/**
 * 全流程操作 4：調代課單 PDF 輸出、以及「清除所有資料」的兩道確認閘門
 *
 * 兩組共用一次主任登入。順序：PDF（不動資料）→ 清除閘門（取消路徑，不動資料）
 * → 真的執行清除（破壞性，放最後；跑完這個 suite，資料庫就不是種子的原樣了）。
 */

import { readFileSync } from 'node:fs';

import { ACCOUNTS, loginStable, gotoTab, shot, bodyText, waitForText } from './helpers.mjs';
import { listDocs } from '../emulator/emu-client.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';

const SCHOOL = 'demo-alpha';

/** 直接從 Firestore 數，不看畫面——驗證「有沒有被清掉」必須看資料本身。 */
async function cloudCounts() {
    const [records, pending, schedules] = await Promise.all([
        listDocs(`schools/${SCHOOL}/substituteRecords`),
        listDocs(`schools/${SCHOOL}/pendingRequests`),
        listDocs(`schools/${SCHOOL}/schedules`),
    ]);
    return {
        records: (records.docs || []).length,
        pending: (pending.docs || []).length,
        schedules: (schedules.docs || []).length,
    };
}

/** 按下確認對話框的某個按鈕。 */
async function clickDialog(page, which) {
    const id = which === 'confirm' ? '#confirm-modal-confirm-btn' : '#confirm-modal-cancel-btn';
    await page.waitForSelector(`${id}:visible`, { timeout: 10000 });
    await page.click(id);
    await page.waitForTimeout(800);
}

function dialogText(page) {
    return page.evaluate(() => {
        const m = document.getElementById('confirm-modal');
        if (!m || getComputedStyle(m).display === 'none') return null;
        return (m.innerText || '').replace(/\s+/g, ' ').trim();
    });
}

export async function run(browser) {
    const suite = new Suite('操作 4：PDF 輸出與清除所有資料的閘門');
    const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });

    try {
        /* ===================== PDF 輸出 ===================== */

        await suite.case('調代課單 PDF：可從紀錄下載，且是內容非空的 PDF 檔', async () => {
            await gotoTab(page, 'records', 3000);
            const btn = page.locator('.v2-download-pdf').first();
            ok(await btn.count() > 0, '紀錄頁應有「下載 PDF」按鈕');

            // PDF 走 html2canvas → jsPDF，headless 下算圖要一段時間
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 90000 }),
                btn.click(),
            ]);

            const name = download.suggestedFilename();
            includes(name, '.pdf', `下載檔名應是 PDF（實際：${name}）`);

            const path = await download.path();
            ok(path, '應能取得下載檔案路徑');
            const buf = readFileSync(path);
            eq(buf.subarray(0, 4).toString('latin1'), '%PDF', 'PDF 檔頭應為 %PDF');
            ok(buf.length > 10000, `PDF 應有實際內容，不是空白頁（實際 ${Math.round(buf.length / 1024)} KB）`);

            suite.pdfInfo = { name, kb: Math.round(buf.length / 1024) };
            console.log(`      ↳ 產出 ${name}，${Math.round(buf.length / 1024)} KB`);
            await shot(page, '04-records-pdf');
        });

        await suite.case('週彙整通知單：主任看得到列印入口', async () => {
            await gotoTab(page, 'records', 1500);
            const btn = await page.$('#v2-print-weekly-summary-btn');
            ok(btn && await btn.isVisible(), '主任應看得到「列印本週彙整」');
        });

        /* ===================== 清除所有資料：閘門 ===================== */

        await suite.case('清除所有資料：第一道確認按取消，資料完全不動', async () => {
            const before = await cloudCounts();
            ok(before.records > 0, `前置：雲端應有紀錄（實際 ${JSON.stringify(before)}）`);

            await gotoTab(page, 'settings', 2000);
            await page.click('#clear-local-data-btn');

            const t = await dialogText(page);
            ok(t, '應跳出第一道確認對話框');
            includes(t, '無法復原', '第一道應警告無法復原');
            await clickDialog(page, 'cancel');

            const after = await cloudCounts();
            eq(after, before, '取消後雲端資料不應有任何變動');
            await shot(page, '04-clear-cancel-1');
        });

        await suite.case('清除所有資料：通過第一道、第二道按取消，資料仍不動', async () => {
            const before = await cloudCounts();

            await gotoTab(page, 'settings', 1500);
            await page.click('#clear-local-data-btn');
            await clickDialog(page, 'confirm');          // 第一道：繼續

            const t = await dialogText(page);
            ok(t, '應跳出第二道確認對話框');
            includes(t, '再次確認', '第二道應是再次確認');
            await clickDialog(page, 'cancel');           // 第二道：取消

            const after = await cloudCounts();
            eq(after, before, '第二道取消後雲端資料不應有任何變動');
            await shot(page, '04-clear-cancel-2');
        });

        /* ============ 真的執行清除（破壞性，放最後） ============ */

        await suite.case('清除所有資料：兩道都確認後，全校紀錄與待審請求確實被清空', async () => {
            const before = await cloudCounts();
            ok(before.records > 0 && before.pending > 0,
                `前置：雲端應有紀錄與待審請求（實際 ${JSON.stringify(before)}）`);

            await gotoTab(page, 'settings', 1500);
            await page.click('#clear-local-data-btn');
            await clickDialog(page, 'confirm');   // 第一道
            await clickDialog(page, 'confirm');   // 第二道

            // 清除會逐批刪除並在完成後 reload 頁面，需要一段時間
            await waitForText(page, /清除|完成|已清除/, 15000).catch(() => {});
            await page.waitForTimeout(12000);

            const after = await cloudCounts();
            eq(after.records, 0, `調代課紀錄應被清空（實際 ${after.records}）`);
            eq(after.pending, 0, `待審請求應被清空（實際 ${after.pending}）`);
            console.log(`      ↳ 清除前 ${JSON.stringify(before)} → 清除後 ${JSON.stringify(after)}`);
            await shot(page, '04-cleared');
        }, {
            knownGap: '這個案例是破壞性的：跑完之後資料庫已不是種子的原樣，'
                    + '要再跑其他情境必須先重新 npm run seed。整組 runner 已把它排在最後。',
        });
    } finally {
        await page.close();
    }

    return suite;
}
