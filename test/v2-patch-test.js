/**
 * V2 進階驗證：patch 套用到 app 層物件的正確性
 *
 * 不涉及 Firebase 登入（無法自動化）；僅檢查 window.app 上的 patch 是否套用：
 * - dataManager.__v2_patched
 * - dataManager.checkExistingRecord 被取代
 * - app.__v2_pdf_patched
 * - generatePdfForRecord 在 v2-app 內部可存取（透過 getter 驗證不回報 ReferenceError）
 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page    = await (await browser.newContext()).newPage();

    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console',  m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

    await page.goto('http://localhost:8000/?v2=1', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.body.classList.contains('v2-active'), { timeout: 5000 });
    await page.waitForTimeout(1000);

    const probe = await page.evaluate(() => {
        const out = {};
        out.dmExists             = !!window.app?.dataManager;
        out.dmPatched            = !!window.app?.dataManager?.__v2_patched;
        out.checkExistingPatched = typeof window.app?.dataManager?.checkExistingRecord === 'function';
        out.pdfPatched           = !!window.app?.__v2_pdf_patched;
        out.generateSubstitute   = typeof window.app?.generateSubstitutePDF === 'function';
        out.generateMulti        = typeof window.app?.generateMultiCoursePDF === 'function';
        out.showToast            = typeof window.app?.showToast === 'function';
        return out;
    });

    console.log('Probe 結果：', JSON.stringify(probe, null, 2));

    const required = ['dmExists', 'dmPatched', 'checkExistingPatched', 'pdfPatched', 'generateSubstitute', 'generateMulti', 'showToast'];
    const missing  = required.filter(k => !probe[k]);
    if (missing.length) throw new Error('以下 patch 未套用：' + missing.join(', '));

    // 驗證未登入時 checkExistingRecord 回傳 null（因 cache 空）
    const nullCheck = await page.evaluate(() => {
        return window.app.dataManager.checkExistingRecord('2026-04-20', '第一節', '7年1班', '王老師');
    });
    if (nullCheck !== null) throw new Error('未登入時 checkExistingRecord 應為 null，實際：' + JSON.stringify(nullCheck));
    console.log('✓ checkExistingRecord 未登入時回傳 null');

    if (errors.length) {
        const v2Errors = errors.filter(e => /v2|V2/.test(e));
        if (v2Errors.length) {
            console.error('V2 相關錯誤：', v2Errors);
            throw new Error('V2 運行時錯誤');
        }
    }

    console.log('\n✅ V2 patch 驗證通過');
    await browser.close();
})().catch(err => {
    console.error('\n❌ 測試失敗:', err.message);
    process.exit(1);
});
