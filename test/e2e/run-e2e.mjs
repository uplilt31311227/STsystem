/**
 * 全流程操作測試入口
 *
 * 需要三件事同時就緒：Firebase Emulator（npm run emu）、本機網頁伺服器（port 8000）、
 * 種好的假資料（npm run seed）。已知限制與現況見同目錄的 README.md。
 */

import { assertEnvironment, launchBrowser } from './helpers.mjs';
import { seedAll } from '../emulator/seed.mjs';

import { run as runStability }  from './e2e-00-login-stability.mjs';
import { run as runAuth }       from './e2e-01-auth.mjs';
import { run as runSubstitute } from './e2e-02-substitute-flow.mjs';
import { run as runAdmin }      from './e2e-03-admin-flows.mjs';
import { run as runPdfClear }   from './e2e-04-pdf-and-clear.mjs';

const SUITES = [
    { name: '登入穩定度', run: runStability },
    { name: '登入與角色可見範圍', run: runAuth },
    { name: '代課申請與審核', run: runSubstitute },
    // 以下兩組會改動資料，排在最後；順序不可調換：
    //   03 會覆寫全校課表，04 最後一案會把紀錄與待審請求整個清空。
    { name: '課表匯入／月結算／學期切換', run: runAdmin },
    { name: 'PDF 輸出／清除所有資料', run: runPdfClear },
];

async function main() {
    console.log('\n══════ STsystem 全流程操作測試 ══════');
    await assertEnvironment();

    console.log('▶ 種入假資料…');
    await seedAll({ quiet: true });

    const browser = await launchBrowser();
    const suites = [];
    try {
        for (const s of SUITES) {
            console.log(`▶ ${s.name}…`);
            suites.push(await s.run(browser));
        }
    } finally {
        await browser.close();
    }

    suites.forEach(s => s.print());

    const total  = suites.reduce((n, s) => n + s.cases.length, 0);
    const passed = suites.reduce((n, s) => n + s.passed, 0);

    console.log('\n══════ 總計 ══════');
    for (const s of suites) {
        console.log(`  ${s.failed ? '❌' : '✅'} ${s.title}：${s.passed}/${s.cases.length}`);
    }
    console.log(`  ── 合計 ${passed}/${total} 通過`);

    const gaps = suites.flatMap(s => s.gaps);
    if (gaps.length) {
        console.log(`\n══════ 測試中確認的行為與限制（${gaps.length} 項）══════`);
        for (const g of gaps) {
            console.log(`  • ${g.name}\n    ${g.knownGap}`);
        }
    }

    console.log('\nℹ 本機 emulator 的 Firestore 查詢很慢（bootstrap 8～75 秒），整組耗時偏長是正常的；'
              + '成因與實測數字見 test/e2e/README.md。');
    process.exit(passed === total ? 0 : 1);
}

main().catch(err => {
    console.error('\n💥 執行器異常：', err.message);
    process.exit(2);
});
