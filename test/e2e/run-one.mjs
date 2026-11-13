/**
 * 單跑一支 e2e：node test/e2e/run-one.mjs 07
 * 05～09 開頭自行 seed；00～04 沒有，這裡會先 seed 一次（04 假設資料是種子原樣，不依賴 03 的結果）。
 * 埠被佔用時：E2E_PORT=8765 node test/e2e/run-one.mjs 07
 */
import { assertEnvironment, launchBrowser } from './helpers.mjs';

const n = process.argv[2];
const MAP = {
    '00': './e2e-00-login-stability.mjs',
    '01': './e2e-01-auth.mjs',
    '02': './e2e-02-substitute-flow.mjs',
    '03': './e2e-03-admin-flows.mjs',
    '04': './e2e-04-pdf-and-clear.mjs',
    '05': './e2e-05-parttime.mjs',
    '06': './e2e-06-settlement-numbers.mjs',
    '07': './e2e-07-settlement-weeks.mjs',
    '08': './e2e-08-v1-no-weeks.mjs',
    '09': './e2e-09-backup-restore.mjs',
};
if (!MAP[n]) { console.error(`用法：node test/e2e/run-one.mjs ${Object.keys(MAP).join('|')}`); process.exit(2); }

await assertEnvironment();
if (Number(n) <= 4) {
    const { seedAll } = await import('../emulator/seed.mjs');
    await seedAll({ quiet: true });
}
const { run } = await import(MAP[n]);
const browser = await launchBrowser();
let suite;
try { suite = await run(browser); } finally { await browser.close(); }
suite.print();
console.log(`  ── ${suite.passed}/${suite.cases.length} 通過`);
process.exit(suite.failed ? 1 : 0);
