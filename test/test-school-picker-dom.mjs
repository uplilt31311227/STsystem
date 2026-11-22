/**
 * 找學校搜尋框（schoolPicker.js）的 DOM 層測試（真瀏覽器，不連任何 Firebase）
 * 執行：node test/test-school-picker-dom.mjs
 *
 * 校名等欄位來自外部網站，必須經 escapeHtml：
 *   - 候選清單的校名／縣市／行政區／代碼含 <img onerror> 時，不能長出 <img>，也不能執行 onerror
 *   - 載入失敗顯示「重試」鈕，按下後重新載入並顯示候選
 *   - 鍵盤：方向鍵設定 aria-activedescendant、Enter 選取、Esc 關閉
 * 只用 port 0 的臨時 http 伺服器提供 src/，不碰 8000／8765。
 * mutation 驗證（手動）：把 schoolPicker.js 清單裡的 escapeHtml(s.n) 改成 s.n，本檔必須失敗。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/blank.html') { res.setHeader('content-type', MIME['.html']); res.end('<!doctype html><meta charset="utf-8"><body><div id="root"></div></body>'); return; }
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(path.join(ROOT, 'src')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; res.end('nf'); return; }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch();
try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/blank.html`);
    await page.evaluate(async () => {
        window.__xss = 0;
        const { renderSchoolPickerHtml, bindSchoolPicker } = await import('/src/js/modules/v2/schoolPicker.js');
        const evil = '<img src=x onerror="window.__xss++">';
        const list = [
            { c: '900001', n: `惡意${evil}國中`, l: ['國中'], ct: `新竹市${evil}`, d: `香山區${evil}` },
            { c: '900002', n: '正常國小', l: ['國小'], ct: '新竹市', d: '東區' },
        ];
        document.getElementById('root').innerHTML = renderSchoolPickerHtml('sp');
        window.__picked = null;
        window.__fail = true;
        bindSchoolPicker(document, {
            idPrefix: 'sp', debounceMs: 0, onSelect: (s) => { window.__picked = s.c; },
            loadList: async () => { if (window.__fail) throw new Error('boom'); return list; },
        });
        // 第二個實例：debounce 200ms，用來測「打字後 debounce 期間 Tab 離開」的競態
        const root2 = document.createElement('div');
        root2.innerHTML = renderSchoolPickerHtml('sq') + '<button id="after">下一個</button>';
        document.body.appendChild(root2);
        bindSchoolPicker(document, { idPrefix: 'sq', debounceMs: 200, onSelect: () => {}, loadList: async () => list });
    });

    // 載入失敗 → 重試鈕
    await page.fill('#sp-input', '國');
    await page.waitForFunction(() => !document.getElementById('sp-retry').hidden, null, { timeout: 5000 });
    check('載入失敗顯示重試鈕與說明', /載入失敗/.test(await page.innerText('#sp-status')));
    await page.evaluate(() => { window.__fail = false; });
    await page.click('#sp-retry');
    await page.waitForSelector('#sp-list [role="option"]', { timeout: 5000 });
    check('按重試後載入成功並顯示候選', (await page.$$('#sp-list [role="option"]')).length === 2);
    check('重試鈕再度隱藏', await page.evaluate(() => document.getElementById('sp-retry').hidden));

    // XSS
    await page.waitForTimeout(300);
    check('候選清單不含 <img> 元素', (await page.$$('#sp-list img')).length === 0);
    check('onerror 未執行', (await page.evaluate(() => window.__xss)) === 0);
    const text = await page.innerText('#sp-list');
    check('惡意字串以純文字顯示', text.includes('<img src=x onerror'), text.slice(0, 80));

    // 鍵盤
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const act = await page.getAttribute('#sp-input', 'aria-activedescendant');
    check('方向鍵設定 aria-activedescendant', act === 'sp-opt-1', String(act));
    await page.keyboard.press('Enter');
    check('Enter 選取目前項目', (await page.evaluate(() => window.__picked)) === '900002');
    check('選取後清單收合', (await page.getAttribute('#sp-input', 'aria-expanded')) === 'false');
    await page.fill('#sp-input', '正常');
    await page.waitForSelector('#sp-list [role="option"]');
    await page.keyboard.press('Escape');
    check('Esc 關閉清單', (await page.getAttribute('#sp-input', 'aria-expanded')) === 'false');

    // 失焦關閉
    await page.fill('#sq-input', '正常');
    await page.waitForSelector('#sq-list [role="option"]', { timeout: 5000 });
    await page.focus('#after');
    await page.waitForTimeout(300);
    check('Tab 移出後清單關閉', (await page.getAttribute('#sq-input', 'aria-expanded')) === 'false'
        && await page.evaluate(() => document.getElementById('sq-list').hidden));
    // 競態：打字後 debounce 尚未觸發就移出，清單不可再打開
    await page.focus('#sq-input');
    await page.fill('#sq-input', '國');
    await page.focus('#after');
    await page.waitForTimeout(500);
    check('debounce 期間移出，清單不會重新展開', (await page.getAttribute('#sq-input', 'aria-expanded')) === 'false'
        && await page.evaluate(() => document.getElementById('sq-list').hidden));
} finally {
    await browser.close();
    server.close();
}
console.log(`\n結果：通過 ${passed}，失敗 ${failed}`);
process.exit(failed ? 1 : 0);
