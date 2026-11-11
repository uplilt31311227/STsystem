/**
 * 全流程操作 8：V1 網址已停用——不帶 ?v2=1 且非預覽站時一律轉址到 V2
 *
 * 原本這支驗「V1 模式不顯示月結算週數設定」，但 2026-11-10 起 V1 網址由 src/js/v2-redirect.js
 * （原 index.html 的 inline script，P4 為了 CSP 搬成外部檔）同步轉址到 ?v2=1，V1 模式在任何
 * 網址都開不起來，舊測試的前提（能開 V1）已不成立。這裡改為斷言轉址行為本身：
 *   1. 不帶參數 → 轉到 ?v2=1，V1 專屬狀態（沒有 V2 gate 以外的 V1 UI）不會出現
 *   2. 保留其他查詢參數與 hash
 *   3. 已帶 ?v2=1 → 不會再轉址（無迴圈）
 * 不登入、不碰 emulator 資料，只看網址與頁面是否載入了 V2 登入遮罩。
 */
import { newPage } from './helpers.mjs';
import { Suite, eq, ok } from '../scenarios/harness.mjs';

const BASE = 'http://localhost:8000/';

export async function run(browser) {
    const suite = new Suite('操作 8：V1 網址轉址到 V2');
    const page = await newPage(browser);
    try {
        await suite.case('不帶 ?v2=1 → 轉址到 V2（網址帶 v2=1，V2 登入遮罩出現）', async () => {
            await page.goto(BASE, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => new URLSearchParams(location.search).get('v2') === '1', null, { timeout: 30000 });
            await page.waitForSelector('#v2-auth-gate, .app-container', { timeout: 30000 });
            const u = new URL(page.url());
            eq(u.searchParams.get('v2'), '1', '轉址後帶 v2=1');
            eq(u.pathname, '/', '路徑不變');
            const hasGate = await page.evaluate(async () => {
                for (let i = 0; i < 60 && !document.getElementById('v2-auth-gate'); i++) await new Promise(r => setTimeout(r, 500));
                return !!document.getElementById('v2-auth-gate') || document.body.classList.contains('v2-active');
            });
            ok(hasGate, '轉址後載入的是 V2（有登入遮罩或 v2-active）');
        });

        await suite.case('轉址保留其他查詢參數與 hash', async () => {
            await page.goto(`${BASE}?emu=1&x=1#settings`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => new URLSearchParams(location.search).get('v2') === '1', null, { timeout: 30000 });
            const u = new URL(page.url());
            eq(u.searchParams.get('emu'), '1', '保留 emu');
            eq(u.searchParams.get('x'), '1', '保留 x');
            eq(u.hash, '#settings', '保留 hash');
        });

        await suite.case('已帶 ?v2=1 不會再轉址（無迴圈）；V1 的週數設定 key 不會被寫入', async () => {
            await page.goto(`${BASE}?v2=1&emu=1`, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);
            const r = await page.evaluate(() => ({
                search: location.search,
                keys: Object.keys(localStorage).filter(k => /settlementConfig/i.test(k)),
            }));
            eq(r.search, '?v2=1&emu=1', '網址維持原樣');
            eq(r.keys, [], 'localStorage 沒有週數設定 key（週數設定存 Firestore config/settlement）');
        });
    } finally {
        await page.close();
    }
    return suite;
}
