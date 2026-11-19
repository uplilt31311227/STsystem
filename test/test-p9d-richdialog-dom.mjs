/**
 * P9-D：richDialog 勾選框接線的實際 DOM 測試（瀏覽器內執行，不連任何 Firebase）
 * 執行：node test/test-p9d-richdialog-dom.mjs
 *
 * 補 C 批驗收留下的缺口：extraOptions 的勾選框 change → refresh() 這條接線，
 * 純函式 isConfirmEnabled 測不到。拿掉 refresh() 之後 repo 其他測試仍全過，所以這裡用真的瀏覽器：
 *   - confirmDisabled:true 的對話框，確認鈕一開始是停用的
 *   - 勾選 enablesConfirm 的選項 → 確認鈕解除停用；取消勾選 → 又停用
 *   - 沒有 enablesConfirm 的選項，勾選後確認鈕仍停用
 *   - ack 勾選框、phrase 字樣輸入框也各自驅動確認鈕
 *
 * 只用本機臨時 http 伺服器（port 0，由系統配一個空閒埠）提供 src/ 靜態檔，不碰 8000／8765。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css' };

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/blank.html') { res.setHeader('content-type', MIME['.html']); res.end('<!doctype html><meta charset="utf-8"><body><div id="modal-root"></div></body>'); return; }
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
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/blank.html`);

    /** 在頁面內開啟 richDialog，回傳控制代碼用的函式都掛在 window.__t */
    await page.evaluate(async () => {
        const { openRichDialog } = await import('/src/js/modules/richDialog.js');
        window.__t = {
            open(opts) {
                const refs = (opts.extraOptions || []).map(() => ({ checked: false }));
                const extra = (opts.extraOptions || []).map((o, i) => ({ ...o, ref: refs[i] }));
                window.__t.result = undefined;
                openRichDialog({ ...opts, extraOptions: extra }).then(v => { window.__t.result = v; });
            },
        };
    });
    const confirmDisabled = () => page.evaluate(() => document.querySelector('[data-rd="confirm"]').disabled);
    const setBox = async (sel, checked) => { await page.locator(sel).setChecked(checked); };

    // 1) confirmDisabled＋enablesConfirm：勾選解除、取消勾選又停用
    await page.evaluate(() => window.__t.open({
        title: '還原預覽', confirmText: '還原', confirmDisabled: true,
        extraOptions: [{ label: '改用較舊的設定', enablesConfirm: true }],
    }));
    check('confirmDisabled：確認鈕一開始是停用的', await confirmDisabled() === true);
    await setBox('[data-rd="option-extra-0"]', true);
    check('勾選 enablesConfirm 選項後，確認鈕解除停用', await confirmDisabled() === false);
    await setBox('[data-rd="option-extra-0"]', false);
    check('取消勾選後，確認鈕又停用', await confirmDisabled() === true);
    await setBox('[data-rd="option-extra-0"]', true);
    await page.click('[data-rd="confirm"]');
    check('解除後按確認會回傳 true，且對話框移除', await page.evaluate(() => window.__t.result) === true && await page.locator('.rich-dialog-content').count() === 0);

    // 2) 沒有 enablesConfirm 的選項：勾了確認鈕仍停用
    await page.evaluate(() => window.__t.open({
        title: '預覽', confirmDisabled: true,
        extraOptions: [{ label: '只是選填，不解鎖' }],
    }));
    await setBox('[data-rd="option-extra-0"]', true);
    check('沒有 enablesConfirm 的選項，勾選後確認鈕仍停用', await confirmDisabled() === true);
    await page.click('[data-rd="cancel"]');

    // 3) 一般對話框（非 confirmDisabled）：確認鈕可按；ack 與 phrase 各自驅動
    await page.evaluate(() => window.__t.open({ title: '確認', checkboxLabel: '我了解', phrase: '刪除', extraOptions: [{ label: '選填', enablesConfirm: true }] }));
    check('有 ack 與 phrase 時，確認鈕一開始停用', await confirmDisabled() === true);
    await setBox('[data-rd="ack"]', true);
    check('只勾 ack 還不夠（phrase 未輸入）', await confirmDisabled() === true);
    await page.fill('[data-rd="phrase"]', '刪除');
    check('ack 勾選且 phrase 相符，確認鈕解除', await confirmDisabled() === false);
    await page.fill('[data-rd="phrase"]', '刪');
    check('phrase 不符時又停用', await confirmDisabled() === true);
    await page.keyboard.press('Escape');

    check('整個過程沒有頁面錯誤', errs.length === 0, errs.join('\n'));
} finally {
    await browser.close();
    server.close();
}

process.stdout.write(`\n結果：通過 ${passed}，失敗 ${failed}\n`);
process.exit(failed ? 1 : 0);
