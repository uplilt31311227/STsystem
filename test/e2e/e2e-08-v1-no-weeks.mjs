/**
 * 全流程操作 8：V1 模式（不帶 ?v2=1、非 preview 網域）完全不碰「月結算上課週數」
 *
 * 週數設定與日曆帶入只做在 V2。V1 要驗：卡片看不到、localStorage 沒有週數設定的 key、
 * 呼叫 applySettlementWeeksOverride 不會改動計算器（各月週數維持原本預設值）。
 */
import { newPage, realErrors } from './helpers.mjs';
import { Suite, eq, ok } from '../scenarios/harness.mjs';

const V1_URL = 'http://localhost:8000/';

export async function run(browser) {
    const suite = new Suite('操作 8：V1 不顯示週數設定');
    const page = await newPage(browser);
    try {
        await page.goto(V1_URL, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.app?.settlementCalculator, null, { timeout: 30000 });
        await page.waitForTimeout(1500);

        await suite.case('V1：設定頁沒有週數卡片、不綁定、localStorage 無週數設定 key', async () => {
            await page.click('.tab-btn[data-tab="settings"]');
            await page.waitForTimeout(500);
            const r = await page.evaluate(() => {
                const card = document.getElementById('settlement-weeks-card');
                const keys = Object.keys(localStorage).filter(k => /settlementConfig/i.test(k));
                return {
                    v2: document.body.classList.contains('v2-active'),
                    visible: !!(card && card.offsetParent !== null),
                    display: card ? getComputedStyle(card).display : 'none-found',
                    yearOptions: document.getElementById('sw-year')?.options.length || 0,
                    keys,
                    store: !!window.app.settlementConfigStore,
                    hasLocalFactory: typeof window.app.createLocalSettlementConfigStore,
                };
            });
            eq(r.v2, false, '應為 V1');
            eq(r.visible, false, '週數卡片不可見');
            eq(r.display, 'none', 'display none');
            eq(r.yearOptions, 0, '未綁定（學年度選單未填）');
            eq(r.keys, [], 'localStorage 無週數設定 key');
            eq(r.store, false, '沒有 settlementConfigStore');
            eq(r.hasLocalFactory, 'undefined', 'V1 localStorage store 已移除');
        });

        await suite.case('V1：月結算不套用週數覆寫，各月週數維持預設（1 月 2、2 月 3、7／8 月 0、其餘 4）', async () => {
            const r = await page.evaluate(async () => {
                await window.app.applySettlementWeeksOverride(115);
                const c = window.app.settlementCalculator;
                return {
                    override: JSON.stringify(c.weeksOverride),
                    weeks: [8, 9, 10, 11, 12, 1, 2, 3].map(m => c.getWeeksInMonth(m >= 8 ? 2026 : 2027, m)),
                    keys: Object.keys(localStorage).filter(k => /settlementConfig/i.test(k)),
                };
            });
            eq(r.override, '{}', '覆寫表為空');
            eq(r.weeks, [0, 4, 4, 4, 4, 2, 3, 4], '預設週數');
            eq(r.keys, [], '仍無 localStorage key');
            eq(realErrors(page).filter(e => /未捕捉例外|TypeError|ReferenceError/.test(e)), [], 'V1 無未捕捉例外（資源載入類 console 噪音不計）');
        });
    } finally {
        await page.close();
    }
    return suite;
}
