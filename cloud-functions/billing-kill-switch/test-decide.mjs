// node cloud-functions/billing-kill-switch/test-decide.mjs
import { decide, isArmed, pacificYearMonth } from './decide.js';

let pass = 0, fail = 0;
function eq(got, want, label) {
    if (got === want) pass++; else { fail++; console.error(`✗ ${label}：預期 ${want}，實得 ${got}`); }
}
const now = new Date('2026-11-15T04:00:00Z');
const cfg = { budgetId: 'B1', billingAccountId: 'ACC', now };
const attrs = { budgetId: 'B1', billingAccountId: 'ACC' };
const NOV = '2026-11-01T07:00:00Z';   // 太平洋時間 11/1 00:00
const p = (cost, budget = 1000, start = NOV) => ({ costAmount: cost, budgetAmount: budget, currencyCode: 'TWD', costIntervalStart: start });

// 基本門檻
eq(decide(p(999.99), attrs, cfg).action, 'ignore', '未達門檻不動作');
eq(decide(p(1000), attrs, cfg).action, 'unlink', '剛好等於門檻 → 斷線');
eq(decide(p(2500), attrs, cfg).action, 'unlink', '超過門檻 → 斷線');
// 篩選
eq(decide(p(5000), { ...attrs, budgetId: 'OTHER' }, cfg).action, 'ignore', '其他預算的訊息不動作');
eq(decide(p(5000), { ...attrs, billingAccountId: 'X' }, cfg).action, 'ignore', '其他帳單帳戶不動作');
eq(decide(p(5000), {}, cfg).action, 'ignore', '缺屬性不動作');
// fail-closed：設定缺漏
eq(decide(p(5000), attrs, { now }).action, 'ignore', '沒設 BUDGET_ID/BILLING_ACCOUNT_ID 不動作');
eq(decide(p(250, 250), { budgetId: 'B250', billingAccountId: 'ACC' }, { billingAccountId: 'ACC', now }).action, 'ignore', '缺 BUDGET_ID 時 250 預算訊息不可觸發');
eq(decide(p(5000), attrs, { budgetId: 'B1', now }).action, 'ignore', '缺 BILLING_ACCOUNT_ID 不動作');
// 金額異常
eq(decide({ ...p(0), costAmount: 'abc' }, attrs, cfg).action, 'ignore', '金額非數字不動作');
eq(decide(p(5000, 0), attrs, cfg).action, 'ignore', '預算為 0 不動作');
eq(decide(null, attrs, cfg).action, 'ignore', '空訊息不動作');
eq(decide({ ...p(100), forecastThresholdExceeded: 5.0 }, attrs, cfg).action, 'ignore', '只有預測超標不動作');
// 月份
eq(decide(p(5000, 1000, '2026-10-01T07:00:00Z'), attrs, cfg).action, 'ignore', '上月延遲訊息不動作');
eq(decide({ costAmount: 5000, budgetAmount: 1000 }, attrs, cfg).action, 'ignore', '缺 costIntervalStart 不動作');
eq(decide(p(5000, 1000, NOV), attrs, { ...cfg, now: new Date('2026-12-01T05:00:00Z') }).action, 'unlink', 'UTC 已 12/1 但太平洋仍 11/30 → 視為本月');
eq(decide(p(5000, 1000, NOV), attrs, { ...cfg, now: new Date('2026-12-01T09:00:00Z') }).action, 'ignore', '太平洋時間已 12/1 → 11 月訊息不動作');
eq(pacificYearMonth(new Date('2026-11-01T07:00:00Z')), '2026-11', '太平洋月份換算');
// 人工暫停
eq(decide(p(5000), attrs, { ...cfg, disarmedUntil: '2026-12-01T08:00:00Z' }).action, 'ignore', '暫停期間不動作');
eq(decide(p(5000), attrs, { ...cfg, disarmedUntil: '2026-11-10T00:00:00Z' }).action, 'unlink', '暫停已過期 → 照常斷線');
eq(decide(p(5000), attrs, { ...cfg, disarmedUntil: 'garbage' }).action, 'ignore', '暫停時間格式錯誤 → 不動作');
// DRY_RUN
eq(isArmed('false'), true, "DRY_RUN='false' 才會斷線");
eq(isArmed(' FALSE '), true, 'DRY_RUN 大小寫與空白容錯');
eq(isArmed('true'), false, "DRY_RUN='true' 試跑");
eq(isArmed('TRUE'), false, "DRY_RUN='TRUE' 試跑");
eq(isArmed('1'), false, "DRY_RUN='1' 試跑");
eq(isArmed(undefined), false, '未設定 DRY_RUN 試跑');

console.log(`kill-switch decide：通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
