/**
 * V2 Preview 部署驗證：從實際 GitHub Pages URL 載入並確認 V2 自動啟用。
 * 不帶 ?v2=1，僅靠 pathname 的 -preview/ 觸發 envDetector。
 */
const { chromium } = require('playwright');

const URL = 'https://uplilt31311227.github.io/STsystem-preview/';

(async () => {
    const browser = await chromium.launch();
    const page    = await (await browser.newContext()).newPage();

    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console',  m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

    console.log('開啟', URL);
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForFunction(() => document.body.classList.contains('v2-active'), { timeout: 8000 })
        .catch(() => { throw new Error('V2 未自動啟用（pathname 偵測失效？）'); });

    const probe = await page.evaluate(() => ({
        hasV2Class: document.body.classList.contains('v2-active'),
        v2Tabs:     document.querySelectorAll('.tab-btn.v2-only').length,
        v2Style:    !!document.getElementById('v2-styles'),
        dmPatched:  !!window.app?.dataManager?.__v2_patched,
        pdfPatched: !!window.app?.__v2_pdf_patched,
    }));
    console.log('Probe:', JSON.stringify(probe, null, 2));

    if (!probe.hasV2Class) throw new Error('v2-active class 缺失');
    if (probe.v2Tabs !== 3) throw new Error(`V2 頁籤數量 ${probe.v2Tabs} != 3`);
    if (!probe.v2Style)    throw new Error('V2 樣式未注入');
    if (!probe.dmPatched)  throw new Error('dataManager 未 patch');
    if (!probe.pdfPatched) throw new Error('PDF 未 patch');

    const v2Errors = errors.filter(e => /v2|V2/.test(e));
    if (v2Errors.length) {
        console.error('V2 錯誤：', v2Errors);
        throw new Error('V2 運行時錯誤');
    }

    console.log('\n✅ GitHub Pages preview 部署驗證通過');
    await browser.close();
})().catch(err => {
    console.error('\n❌ 測試失敗:', err.message);
    process.exit(1);
});
