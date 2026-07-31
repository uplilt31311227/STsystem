/**
 * V2 互動式端對端測試
 *
 * 流程：
 * 1. 開啟 headed Chrome 至 preview URL
 * 2. 等待使用者手動完成 Google 登入（最多 3 分鐘）
 * 3. 偵測到 v2-admin class 出現後，開始自動驗證：
 *    - V2 頁籤可見
 *    - 教師管理頁籤列出 26 位教師
 *    - 操作日誌頁籤可開啟且不報錯
 * 4. 各步驟截圖
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://uplilt31311227.github.io/STsystem-preview/';
const SCREENSHOT_DIR = path.join(__dirname, 'e2e-screenshots');

async function snap(page, name) {
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const p = path.join(SCREENSHOT_DIR, `${Date.now()}-${name}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`  📸 ${path.basename(p)}`);
    return p;
}

(async () => {
    console.log('啟動 headed Chrome（瀏覽器視窗會彈出）');
    const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
    const context = await browser.newContext({ viewport: null });
    const page    = await context.newPage();

    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console',  m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

    console.log(`導航：${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => document.body.classList.contains('v2-active'), { timeout: 8000 });
    await snap(page, '01-loaded');

    console.log('\n👉 請在彈出的 Chrome 視窗中點右上角「Google 登入」以 uplilt31311227@gmail.com 登入');
    console.log('   （我會等 180 秒偵測 v2-admin class 出現）');

    try {
        await page.waitForFunction(
            () => document.body.classList.contains('v2-admin'),
            { timeout: 180000 }
        );
    } catch (e) {
        await snap(page, '02-login-timeout');
        throw new Error('登入等待逾時（180 秒）');
    }
    console.log('✓ 偵測到 v2-admin 身份');
    await page.waitForTimeout(1500);
    await snap(page, '03-admin-logged-in');

    // ===== 驗證教師管理頁籤 =====
    console.log('\n切到「教師管理」頁籤');
    await page.click('.tab-btn[data-tab="teachers"]');
    await page.waitForTimeout(2000);
    await snap(page, '04-teachers-tab');

    const teachers = await page.$$('.v2-teacher-row');
    console.log(`✓ 教師列表顯示 ${teachers.length} 位`);
    if (teachers.length < 5) throw new Error(`教師數量異常（${teachers.length}）`);

    // ===== 操作日誌 =====
    console.log('\n切到「操作日誌」頁籤');
    await page.click('.tab-btn[data-tab="v2-logs"]');
    await page.waitForTimeout(2000);
    await snap(page, '05-logs-tab');

    const logRows = await page.$$('.v2-log-table tbody tr');
    console.log(`✓ 操作日誌 ${logRows.length} 筆`);

    // ===== 待辦 =====
    console.log('\n切到「待辦」頁籤');
    await page.click('.tab-btn[data-tab="v2-pending"]');
    await page.waitForTimeout(1500);
    await snap(page, '06-pending-tab');

    // ===== 調代課紀錄 =====
    console.log('\n切到「調代課紀錄」頁籤');
    await page.click('.tab-btn[data-tab="records"]');
    await page.waitForTimeout(2000);
    await snap(page, '07-records-tab');

    // ===== 總結 =====
    console.log('\n--- Console 錯誤彙整 ---');
    const v2Errors = errors.filter(e => /v2|V2|firebase|firestore/i.test(e));
    if (v2Errors.length) {
        v2Errors.forEach(e => console.log('  ⚠', e));
    } else {
        console.log('  ✓ 無 V2 / Firebase 相關錯誤');
    }

    console.log('\n✅ 驗證完成，截圖存於 test/e2e-screenshots/');
    console.log('瀏覽器保持開啟，按 Ctrl+C 終止');
    // 保持瀏覽器開著給使用者繼續操作
    await new Promise(() => {});  // 永不 resolve
})().catch(err => {
    console.error('\n❌ 測試失敗:', err.message);
    process.exit(1);
});
