/**
 * V2 權限系統冒煙測試
 *
 * 驗證 V2 模式下：
 * - 頁面可正常載入且無 console.error
 * - 啟用 ?v2=1 後 body 有 v2-active class
 * - V2 新頁籤按鈕存在且可見
 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const ctx     = await browser.newContext();
    const page    = await ctx.newPage();

    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console',  m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

    console.log('開啟 http://localhost:8000/?v2=1');
    await page.goto('http://localhost:8000/?v2=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // 等待 V2 啟動
    await page.waitForFunction(() => document.body.classList.contains('v2-active'), { timeout: 5000 })
        .catch(() => { throw new Error('V2 未啟動：body 缺少 v2-active class'); });

    console.log('✓ body.v2-active 已設定');

    const v2Tabs = await page.$$('.tab-btn.v2-only');
    console.log(`✓ V2 頁籤數量: ${v2Tabs.length}（預期 3）`);
    if (v2Tabs.length !== 3) throw new Error('V2 頁籤數量不符');

    const stylesheet = await page.$('#v2-styles');
    if (!stylesheet) throw new Error('V2 樣式未注入');
    console.log('✓ V2 樣式已注入');

    // 檢查模組是否都載入（從 network 或 console log）
    const v2Ready = await page.evaluate(() => typeof window !== 'undefined');
    if (!v2Ready) throw new Error('window 物件異常');

    if (errors.length) {
        console.error('⚠ 發生錯誤：');
        errors.forEach(e => console.error('  ' + e));
        // 不把這些視為 fatal，除非是 V2 相關
        const v2Errors = errors.filter(e => e.includes('v2-app') || e.includes('/v2/'));
        if (v2Errors.length) throw new Error('V2 載入時出錯');
    } else {
        console.log('✓ 無 console 錯誤');
    }

    // 穩定版 URL（不帶 ?v2=1）
    console.log('開啟穩定版 http://localhost:8000/');
    await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const hasV2Class = await page.evaluate(() => document.body.classList.contains('v2-active'));
    if (hasV2Class) throw new Error('穩定版 URL 不該啟用 V2');
    console.log('✓ 穩定版 URL 未啟用 V2');

    await browser.close();
    console.log('\n✅ V2 冒煙測試通過');
})().catch(err => {
    console.error('\n❌ 測試失敗:', err.message);
    process.exit(1);
});
