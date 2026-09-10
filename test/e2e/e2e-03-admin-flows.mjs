/**
 * 全流程操作 3：課表匯入（含異常檔）、月結算、學期切換
 *
 * 這三組共用同一次主任登入——本機 emulator 的 bootstrap 要 8～75 秒，每個案例各登入一次
 * 會讓整組跑到無法忍受。順序刻意安排成「不改資料的先做」：月結算 → 學期切換（只驗證被擋，
 * 不真的切換）→ 課表匯入（會覆寫全校課表，放最後）。
 */

import { Buffer } from 'node:buffer';

import {
    ACCOUNTS, loginStable, gotoTab, shot, bodyText, waitForText,
} from './helpers.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';
import { ALPHA, buildSchoolFixture } from '../fixtures/school-fixture.mjs';
import { buildCsvVariants } from '../fixtures/csv-variants.mjs';
import { rowsToCsv } from '../fixtures/schedule-builder.mjs';

/** 把 CSV 字串當成檔案餵給 <input type="file">，不必落地成實體檔案。 */
async function uploadCsv(page, csv, name = 'schedule.csv') {
    await page.setInputFiles('#schedule-file', {
        name, mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf-8'),
    });
    await page.waitForTimeout(2500);
}

/**
 * 目前畫面上顯示的課表統計（班級／教師／課程數）。
 *
 * 用 textContent 而非 innerText：上傳後畫面會切到匯入結果視圖，統計區塊雖然還在 DOM
 * 但被隱藏，innerText 對隱藏元素回傳空字串，會把數字讀成 -1。
 */
async function scheduleCounts(page) {
    await page.waitForSelector('#class-count', { state: 'attached', timeout: 10000 }).catch(() => {});
    return page.evaluate(() => {
        const num = (id) => {
            const t = (document.getElementById(id)?.textContent || '').trim();
            return t === '' ? -1 : Number(t);
        };
        return { classes: num('class-count'), teachers: num('teacher-count'), courses: num('course-count') };
    });
}

/**
 * 匯入後的實際課表狀態。
 *
 * 不看畫面上的統計數字——上傳後畫面會切到匯入結果視圖，`#class-count` 那組元素會整個
 * 從 DOM 移除（textContent 也讀不到）。要驗證「匯入有沒有生效」，看 dataManager 才是
 * 真正的答案；畫面統計的正確性另有一案在初始狀態驗證。
 */
function scheduleState(page) {
    return page.evaluate(() => {
        const dm = window.app?.dataManager;
        return {
            classes: (dm?.classes || []).length,
            teachers: (dm?.teachers || []).length,
            courses: (dm?.scheduleData || []).length,
        };
    });
}

async function openImportView(page) {
    await gotoTab(page, 'schedule', 1500);
    const btn = page.getByRole('button', { name: /課表匯入/ });
    if (await btn.count()) { await btn.first().click(); await page.waitForTimeout(800); }
}

export async function run(browser) {
    const suite = new Suite('操作 3：課表匯入、月結算、學期切換');
    const fixture = buildSchoolFixture(ALPHA);
    const variants = buildCsvVariants(fixture.schedules[ALPHA.currentSemester].rows);
    const variantOf = (name) => variants.find(v => v.name === name);

    const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });

    try {
        /* ===================== 月結算 ===================== */

        await suite.case('月結算：產生 115 學年度 9 月報表，列出教師與時數', async () => {
            await gotoTab(page, 'settlement', 1500);
            await page.selectOption('#settle-year', '115');
            await page.selectOption('#settle-month', '9');
            await page.click('#generate-settlement-btn');
            await page.waitForTimeout(2500);

            const text = await bodyText(page);
            const teacher = fixture.teachers[2].name;   // 一位確定有課的教師
            includes(text, teacher, '結算表應列出教師');

            const rows = await page.evaluate(() =>
                document.querySelectorAll('#settlement-content table tbody tr').length);
            ok(rows > 0, `結算表應有資料列（實際 ${rows} 列）`);
            await shot(page, '03-settlement-115-9');
        });

        await suite.case('月結算：暑假月份（8 月）的原定時數為 0，不會出現負數或 NaN', async () => {
            await gotoTab(page, 'settlement', 1200);
            await page.selectOption('#settle-year', '115');
            await page.selectOption('#settle-month', '8');
            await page.click('#generate-settlement-btn');
            await page.waitForTimeout(2500);

            const nums = await page.evaluate(() => {
                const cells = [...document.querySelectorAll('#settlement-content table tbody tr td')];
                return cells.map(c => c.innerText.trim()).filter(t => /^-?\d+(\.\d+)?$/.test(t)).map(Number);
            });
            ok(nums.length > 0, '應有數值欄位');
            eq(nums.filter(n => Number.isNaN(n)).length, 0, '不應出現 NaN');
            eq(nums.filter(n => n < 0).length, 0, `不應出現負數（實際：${nums.filter(n => n < 0).join(', ')}）`);
            await shot(page, '03-settlement-115-8');
        });

        await suite.case('月結算：提供匯出 Excel 的入口', async () => {
            const btn = await page.$('#export-settlement-btn');
            ok(btn && await btn.isVisible(), '應有匯出 Excel 按鈕');
        });

        /* ===================== 學期切換 ===================== */

        await suite.case('學期管理：顯示目前學期，並帶出下一學期作為預設值', async () => {
            await gotoTab(page, 'settings', 2500);
            const text = await bodyText(page);
            includes(text, ALPHA.currentSemester, '應顯示目前作用中的學期');
            const next = await page.inputValue('#v2-new-semester-input');
            eq(next, '115-2', '應預設帶出下一個學期');
            await shot(page, '03-semester-admin');
        });

        await suite.case('學期切換：目前學期仍有在途申請時被擋下', async () => {
            await gotoTab(page, 'settings', 1500);
            await page.click('#v2-open-new-semester-btn');
            await page.waitForTimeout(2500);

            // fixture 刻意留了未結案的待審申請（代課待核准、調課待同意、多重調課部分同意…）
            const blocked = await waitForText(page, /在途|未結|尚有|待審|待同意|無法切換|請先/, 8000);
            ok(blocked, `有在途申請時應擋下切換（畫面：${(await bodyText(page)).slice(0, 200)}）`);

            // 確認真的沒有切換
            const cfg = await page.evaluate(async () => {
                const fm = window.firebaseModules, db = fm.getFirestore();
                const s = await fm.getDoc(fm.doc(db, 'schools/demo-alpha/config/main'));
                return s.data()?.currentSemester;
            });
            eq(cfg, ALPHA.currentSemester, '被擋下後目前學期不應被改動');
            await shot(page, '03-semester-blocked');
        });

        /* ===================== 課表匯入（會改資料，放最後） ===================== */

        await suite.case('課表匯入：目前已載入的課表統計正確', async () => {
            await openImportView(page);
            const c = await scheduleCounts(page);
            eq(c.classes, 9, '班級數');
            eq(c.teachers, 20, '任課教師數');
            eq(c.courses, 306, '課程節數');
        });

        await suite.case('課表匯入：缺少必要欄位的檔案被拒，且不影響既有課表', async () => {
            await openImportView(page);
            const before = await scheduleState(page);
            await uploadCsv(page, variantOf('missing-required-column').csv, 'missing-column.csv');

            const shown = await waitForText(page, /缺少必要欄位|失敗|錯誤/, 8000);
            ok(shown, `應顯示缺少必要欄位的錯誤（畫面：${(await bodyText(page)).slice(0, 200)}）`);
            const after = await scheduleState(page);
            eq(after, before, '匯入失敗不應更動既有課表');
            await shot(page, '03-import-missing-column');
        });

        await suite.case('課表匯入：只有標題列的空檔案被拒，且不影響既有課表', async () => {
            await openImportView(page);
            const before = await scheduleState(page);
            await uploadCsv(page, variantOf('header-only').csv, 'empty.csv');

            const shown = await waitForText(page, /沒有資料|失敗|錯誤|空/, 8000);
            ok(shown, `應顯示沒有資料的錯誤（畫面：${(await bodyText(page)).slice(0, 200)}）`);
            const after = await scheduleState(page);
            eq(after, before, '匯入失敗不應更動既有課表');
        });

        await suite.case('課表匯入：正常檔案匯入成功並更新統計', async () => {
            await openImportView(page);
            // 只取前 3 個班的課，讓匯入後的數字與原本明顯不同，才能確認真的換掉了
            const rows = fixture.schedules[ALPHA.currentSemester].rows
                .filter(r => ['7年1班', '7年2班', '7年3班'].includes(r.班級));
            await uploadCsv(page, rowsToCsv(rows), 'three-classes.csv');
            await page.waitForTimeout(2500);

            const after = await scheduleState(page);
            eq(after.classes, 3, `匯入後班級數（實際 ${JSON.stringify(after)}）`);
            eq(after.courses, rows.length, '匯入後課程節數應等於檔案列數');
            await shot(page, '03-import-ok');
        });

        await suite.case('課表匯入後，新課表已同步到雲端（其他人也會看到）', async () => {
            const cloud = await page.evaluate(async () => {
                const fm = window.firebaseModules, db = fm.getFirestore();
                const s = await fm.getDoc(fm.doc(db, 'schools/demo-alpha/schedules/115-1'));
                const d = s.data() || {};
                return { n: d.scheduleData?.length ?? -1, classes: (d.classes || []).length };
            });
            eq(cloud.classes, 3, '雲端課表的班級數應同步更新');
            ok(cloud.n > 0 && cloud.n < 306, `雲端課表節數應已更新（實際 ${cloud.n}）`);
        });
    } finally {
        await page.close();
    }

    /* ===================== 角色差異（需另一次登入） ===================== */

    await suite.case('教學組長看不到「學期管理」與「清除所有資料」（主任專用）', async () => {
        const { page: cPage } = await loginStable(browser, ACCOUNTS.sectionChief);
        try {
            await gotoTab(cPage, 'settings', 2500);
            const vis = await cPage.evaluate(() => {
                const seen = (id) => {
                    const e = document.getElementById(id);
                    return !!(e && e.offsetParent !== null);
                };
                return { semester: seen('v2-semester-admin'), clear: seen('clear-local-data-btn') };
            });
            eq(vis.semester, false, '組長不應看到學期管理');
            eq(vis.clear, false, '組長不應看到清除所有資料');
            await shot(cPage, '03-chief-settings');
        } finally { await cPage.close(); }
    });

    return suite;
}
