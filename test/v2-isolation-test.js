/**
 * V2 隔離驗證：不帶 ?v2=1 時穩定版必須維持原行為。
 */
const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const page    = await (await browser.newContext()).newPage();

    await page.goto('http://localhost:8000/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    const probe = await page.evaluate(() => ({
        hasV2Class:      document.body.classList.contains('v2-active'),
        dmPatched:       !!window.app?.dataManager?.__v2_patched,
        pdfPatched:      !!window.app?.__v2_pdf_patched,
        v2Style:         !!document.getElementById('v2-styles'),
        // 原 checkExistingRecord 應可用且仍是原本綁定到 dataManager 的版本
        checkExistingOk: typeof window.app?.dataManager?.checkExistingRecord === 'function',
    }));
    console.log('Probe：', JSON.stringify(probe, null, 2));

    if (probe.hasV2Class) throw new Error('穩定版不應有 v2-active class');
    if (probe.dmPatched)  throw new Error('穩定版 dataManager 不應被 patch');
    if (probe.pdfPatched) throw new Error('穩定版 app 不應被 pdf patch');
    if (probe.v2Style)    throw new Error('穩定版不應注入 V2 樣式');
    if (!probe.checkExistingOk) throw new Error('穩定版 checkExistingRecord 不可用');

    console.log('\n✅ 穩定版未被 V2 污染');
    await browser.close();
})().catch(err => {
    console.error('\n❌ 隔離測試失敗:', err.message);
    process.exit(1);
});
