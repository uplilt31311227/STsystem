/**
 * 單跑一支 e2e：node test/e2e/run-one.mjs 07
 * （只支援開頭自行 seed 的 suite，目前為 05／06／07／08；其他 suite 依賴前面 suite 的狀態）
 */
import { assertEnvironment, launchBrowser } from './helpers.mjs';

const n = process.argv[2];
const MAP = {
    '05': './e2e-05-parttime.mjs',
    '06': './e2e-06-settlement-numbers.mjs',
    '07': './e2e-07-settlement-weeks.mjs',
    '08': './e2e-08-v1-no-weeks.mjs',
};
if (!MAP[n]) { console.error(`用法：node test/e2e/run-one.mjs ${Object.keys(MAP).join('|')}`); process.exit(2); }

await assertEnvironment();
const { run } = await import(MAP[n]);
const browser = await launchBrowser();
let suite;
try { suite = await run(browser); } finally { await browser.close(); }
suite.print();
console.log(`  ── ${suite.passed}/${suite.cases.length} 通過`);
process.exit(suite.failed ? 1 : 0);
