// node cloud-functions/billing-kill-switch/test-decide.mjs
import { decide } from './decide.js';

let pass = 0, fail = 0;
function eq(got, want, label) {
    if (got === want) pass++; else { fail++; console.error(`✗ ${label}：預期 ${want}，實得 ${got}`); }
}
const cfg = { budgetId: 'B1', billingAccountId: 'ACC' };
const attrs = { budgetId: 'B1', billingAccountId: 'ACC' };
const p = (cost, budget = 1000) => ({ costAmount: cost, budgetAmount: budget, currencyCode: 'TWD' });

eq(decide(p(999.99), attrs, cfg).action, 'ignore', '未達門檻不動作');
eq(decide(p(1000), attrs, cfg).action, 'unlink', '剛好等於門檻 → 斷線');
eq(decide(p(2500), attrs, cfg).action, 'unlink', '超過門檻 → 斷線');
eq(decide(p(5000), { ...attrs, budgetId: 'OTHER' }, cfg).action, 'ignore', '其他預算的訊息不動作');
eq(decide(p(5000), { ...attrs, billingAccountId: 'X' }, cfg).action, 'ignore', '其他帳單帳戶不動作');
eq(decide(p(5000), {}, cfg).action, 'ignore', '缺屬性不動作');
eq(decide({ costAmount: 'abc', budgetAmount: 1000 }, attrs, cfg).action, 'ignore', '金額非數字不動作');
eq(decide({ costAmount: 5000, budgetAmount: 0 }, attrs, cfg).action, 'ignore', '預算為 0 不動作');
eq(decide(null, attrs, cfg).action, 'ignore', '空訊息不動作');
// 只看實際花費：預測值再高也不動作
eq(decide({ ...p(100), forecastThresholdExceeded: 5.0 }, attrs, cfg).action, 'ignore', '只有預測超標不動作');

console.log(`kill-switch decide：通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
