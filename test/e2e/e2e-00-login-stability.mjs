/**
 * 全流程操作 0：登入穩定度量測
 *
 * 這一組刻意**不重試**——其他情境為了問到自己想問的問題會用 loginStable() 重試，
 * 穩定度必須有一個地方誠實量出來，否則重試等於把問題藏起來。
 *
 * 已知現象：在本機 emulator 環境下，Firestore 的一次性查詢偶發永不回應，
 * 導致 bootstrap 停在某一步、unlockV2App() 不執行，畫面卡在登入遮罩。
 * 根因尚未定位；無法判定正式環境是否同樣受影響（不會拿正式站驗證）。
 */

import { ACCOUNTS, login, newPage, loadedScheduleCount } from './helpers.mjs';
import { Suite, ok } from '../scenarios/harness.mjs';

const ROUNDS = 6;

export async function run(browser) {
    const suite = new Suite('操作 0：登入穩定度（不重試，如實量測）');

    await suite.case(`連續 ${ROUNDS} 次登入的成功率`, async () => {
        const results = [];
        for (let i = 0; i < ROUNDS; i++) {
            const page = await newPage(browser);
            try {
                const r = await login(page, ACCOUNTS.director);
                const n = r.state === 'signed-in' ? await loadedScheduleCount(page) : 0;
                results.push({ state: r.state, schedule: n });
            } finally {
                await page.close();
            }
        }
        const entered  = results.filter(r => r.state === 'signed-in').length;
        const withData = results.filter(r => r.state === 'signed-in' && r.schedule > 0).length;
        const stuck    = results.filter(r => r.state === 'stuck' || r.state === 'timeout').length;

        suite.stability = { rounds: ROUNDS, entered, withData, stuck, results };
        console.log(`      ↳ 進入系統 ${entered}/${ROUNDS}、其中課表也載入 ${withData}/${ROUNDS}、卡在遮罩 ${stuck}/${ROUNDS}`);

        // 這個案例本身只要求「至少能登入一次」——低於這個標準，後面所有操作測試都無從做起。
        // 真正的數字由上面那行輸出與最終報告呈現，不用一個武斷的門檻把它變成紅燈。
        ok(entered > 0, `連續 ${ROUNDS} 次都無法進入系統，操作測試無法進行`);
    }, {
        knownGap: '本機 emulator 環境下登入不穩定：Firestore 一次性查詢偶發無回應，'
                + 'bootstrap 停住而畫面卡在登入遮罩。根因未定位，正式環境是否受影響未知。'
                + '其餘操作情境以重試繞過，不影響那些情境的結論。',
    });

    return suite;
}
