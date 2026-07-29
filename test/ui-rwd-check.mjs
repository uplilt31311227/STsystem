/**
 * UI 手機響應式檢查（Stage 1 硬傷急救驗收用）
 *
 * 用途：在 375×667（手機）viewport 下，走訪 V1 穩定版（無 ?v2=1）主要分頁，
 * 斷言 document.documentElement.scrollWidth <= window.innerWidth（無橫向溢出）。
 * 涵蓋：課表匯入（含教師表格）、調代課申請（含課表格）、調代課紀錄、月結算、設定。
 *
 * 前置：先啟動本機伺服器（預設 http://localhost:8000）：
 *   python start-server.py
 *
 * 用法：node test/ui-rwd-check.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = 'http://localhost:8000/';
const CSV_PATH  = path.join(__dirname, 'test-data.csv');
const VIEWPORT  = { width: 375, height: 667 };

const results = [];

async function measure(page) {
    return page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
    }));
}

function record(label, { scrollWidth, innerWidth }) {
    const pass = scrollWidth <= innerWidth;
    results.push({ label, scrollWidth, innerWidth, pass });
    console.log(`  ${pass ? '✓' : '✗'} ${label}：scrollWidth=${scrollWidth} / innerWidth=${innerWidth}`);
    return pass;
}

async function switchTab(page, tabId) {
    await page.click(`.tab-btn[data-tab="${tabId}"]`);
    await page.waitForTimeout(400);
}

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    const pageIssues = [];
    page.on('pageerror', e => pageIssues.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') pageIssues.push(`console: ${m.text()}`); });

    console.log(`開啟 ${BASE_URL}（375×667，V1 穩定版）`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    console.log('\n[課表匯入] 初始狀態（未載入資料）');
    record('課表匯入（初始）', await measure(page));

    // 上傳測試課表，解鎖各分頁內容
    console.log('\n上傳 test-data.csv...');
    await page.setInputFiles('#schedule-file', CSV_PATH);
    await page.waitForSelector('#teacher-editor:not(.hidden)', { timeout: 5000 }).catch(() => {
        console.log('  ⚠ 教師編輯表格未在時限內出現，繼續嘗試');
    });
    await page.waitForTimeout(500);

    // 設定學校名稱以解鎖 substitute/records/settlement（updateTabContentVisibility 需要 hasSchedule && schoolName）
    await page.fill('#school-name', '測試國中');
    await page.click('#save-school-name-btn');
    await page.waitForTimeout(500);

    console.log('\n[課表匯入] 已載入資料（含教師屬性表格）');
    record('課表匯入（含教師表格）', await measure(page));

    console.log('\n[調代課申請] 含原任課教師週課表');
    await switchTab(page, 'substitute');
    await page.selectOption('#sub-teacher', { label: '王大明' }).catch(() => {
        console.log('  ⚠ 找不到教師選項「王大明」，略過課表格渲染步驟');
    });
    await page.fill('#sub-date', '2026-03-16').catch(() => {});
    await page.waitForTimeout(600);
    record('調代課申請（含課表格）', await measure(page));

    console.log('\n[調代課紀錄]');
    await switchTab(page, 'records');
    record('調代課紀錄', await measure(page));

    console.log('\n[月結算] 嘗試產生結算表');
    await switchTab(page, 'settlement');
    await page.click('#generate-settlement-btn').catch(() => {});
    await page.waitForTimeout(600);
    record('月結算', await measure(page));

    console.log('\n[設定]');
    await switchTab(page, 'settings');
    record('設定', await measure(page));

    await browser.close();

    console.log('\n=== 結果彙總（375×667） ===');
    let anyFail = false;
    for (const r of results) {
        console.log(`${r.pass ? '通過' : '失敗'} - ${r.label}（scrollWidth ${r.scrollWidth} / innerWidth ${r.innerWidth}）`);
        if (!r.pass) anyFail = true;
    }

    if (pageIssues.length) {
        console.log('\n⚠ 過程中 console/page 錯誤（不列入 pass/fail 判定，僅供參考）：');
        pageIssues.forEach(e => console.log('  ' + e));
    }

    if (anyFail) {
        console.error('\n❌ 有分頁發生橫向溢出');
        process.exit(1);
    }
    console.log('\n✅ 全部分頁在 375×667 下皆無橫向溢出');
})().catch(err => {
    console.error('\n❌ 測試腳本執行錯誤:', err.message);
    process.exit(1);
});
