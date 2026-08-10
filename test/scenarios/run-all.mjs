/**
 * 情境測試總入口
 *
 * 用法：
 *   1. 先啟動 emulator（另一個終端機，會持續執行）：
 *        npm run emu
 *   2. 跑全部情境：
 *        npm run test:scenarios
 *
 * 需要 emulator 的情境（2、4）在執行前各自重新種一次資料，確保彼此不互相污染——
 * 這些情境會實際寫入/刪除文件，共用同一份資料會讓後跑的案例受前面影響。
 */

import { assertEmulator } from '../emulator/emu-client.mjs';
import { seedAll } from '../emulator/seed.mjs';

import { run as runSchedule }   from './scenario-01-schedule-import.mjs';
import { run as runApproval }   from './scenario-02-approval-flow.mjs';
import { run as runSettlement } from './scenario-03-settlement.mjs';
import { run as runIsolation }  from './scenario-04-isolation.mjs';

/** ScheduleParser 每解析一份檔案就 console.log 欄位對應，會把測試輸出淹掉。 */
function withQuietConsole(fn) {
    const orig = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    return Promise.resolve()
        .then(fn)
        .finally(() => { console.log = orig.log; console.warn = orig.warn; });
}

async function main() {
    const suites = [];

    console.log('\n══════ STsystem 情境測試 ══════');

    // --- 不需要 emulator 的純邏輯情境 ---
    suites.push(await withQuietConsole(() => runSchedule()));
    suites.push(await withQuietConsole(() => runSettlement()));

    // --- 需要 emulator 的情境 ---
    try {
        await assertEmulator();
    } catch (err) {
        console.error(`\n❌ ${err.message}`);
        console.error('   （情境 1、3 已完成；情境 2、4 需要 emulator）');
        suites.forEach(s => s.print());
        process.exit(1);
    }

    console.log('\n▶ 種入假資料（情境 2）…');
    suites.push(await runApproval(await seedAll({ quiet: true })));

    console.log('▶ 重新種入假資料（情境 4）…');
    suites.push(await runIsolation(await seedAll({ quiet: true })));

    // --- 報告 ---
    suites.forEach(s => s.print());

    const total  = suites.reduce((n, s) => n + s.cases.length, 0);
    const passed = suites.reduce((n, s) => n + s.passed, 0);
    const failed = total - passed;

    console.log('\n══════ 總計 ══════');
    for (const s of suites) {
        const mark = s.failed ? '❌' : '✅';
        console.log(`  ${mark} ${s.title}：${s.passed}/${s.cases.length}`);
    }
    console.log(`  ── 合計 ${passed}/${total} 通過${failed ? `，${failed} 項失敗` : ''}`);

    const gaps = suites.flatMap(s => s.gaps);
    if (gaps.length) {
        console.log(`\n══════ 測試中確認的系統既有行為（${gaps.length} 項，非測試失敗）══════`);
        for (const g of gaps) {
            console.log(`  • ${g.name}`);
            console.log(`    ${g.knownGap}`);
        }
    }

    process.exit(failed ? 1 : 0);
}

main().catch(err => {
    console.error('\n💥 測試執行器本身異常：', err);
    process.exit(2);
});
