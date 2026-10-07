/**
 * 月結算數字正確性（單元層）
 *
 * 用一組「手算期望值」固定資料驗證 SettlementCalculator 的輸出。
 * 期望值與手算依據寫在 test/fixtures/settlement-golden.mjs（與畫面層 e2e-06 共用同一組），
 * 這裡的邊界案例（寒暑假週數、缺假別、status 不被過濾）則在各案例內註解手算過程。
 * 期望值一律寫死，不呼叫被測函式產生。
 */

import { SettlementCalculator } from '../src/js/modules/settlementCalculator.js';
import { Suite, eq } from './scenarios/harness.mjs';
import {
    GOLDEN_EXPECTED_2026_10, buildGoldenSchedule, goldenRecordsForCalculator,
    GOLDEN_RECORDS, GOLDEN_NAME,
} from './fixtures/settlement-golden.mjs';

const suite = new Suite('月結算數字正確性（單元）');
const calc = () => new SettlementCalculator();
const roster = Object.values(GOLDEN_NAME).map(name => ({ name }));
const run = (year, month, schedule, records, names = roster) =>
    calc().calculate(year, month, schedule, records, names);
const row = (res, name) => res.find(r => r.teacherName === name);

await suite.case('黃金資料：115 學年度 10 月，五位教師的每個欄位等於手算值', () => {
    const res = run(115, 10, buildGoldenSchedule(), goldenRecordsForCalculator());
    eq(res.length, 5, '五位教師都應有列');
    for (const [name, exp] of Object.entries(GOLDEN_EXPECTED_2026_10)) {
        const got = row(res, name);
        eq({ ...got, teacherName: undefined, baseMonthlyHours: undefined },
           { ...exp, teacherName: undefined, baseMonthlyHours: undefined }, `${name} 的結算列`);
        eq(got.baseMonthlyHours, 80, `${name} 的基本月時數（20×4）`);
    }
});

await suite.case('黃金資料：結果依實際時數由大到小排序（手算：84、81、23、20、16）', () => {
    const res = run(115, 10, buildGoldenSchedule(), goldenRecordsForCalculator());
    eq(res.map(r => r.actualHours), [84, 81, 23, 20, 16], '實際時數排序');
    eq(res.map(r => r.teacherName), ['黃志偉', '吳佩珊', '王大明', '林彥廷', '張淑芬'], '教師排序');
});

await suite.case('黃金資料：範圍外紀錄（9/30、11/2、前一學年度 10 月）單獨結算時皆為 0 影響', () => {
    const out = goldenRecordsForCalculator().filter((_, i) => !GOLDEN_RECORDS[i].inScope);
    eq(out.length, 3, '範圍外紀錄共 3 筆');
    const res = run(115, 10, buildGoldenSchedule(), out);
    // 手算：沒有任何紀錄進入 10 月 → 每人 actual = original；A=24 B=20 C=12 D=84 E=80
    eq(res.map(r => [r.teacherName, r.substituteHours, r.substitutedHours, r.actualHours]).sort(),
       [['吳佩珊', 0, 0, 80], ['張淑芬', 0, 0, 12], ['林彥廷', 0, 0, 24], ['王大明', 0, 0, 20], ['黃志偉', 0, 0, 84]].sort(),
       '範圍外紀錄不得影響任何人');
});

await suite.case('相鄰月份各自結算：9 月只有 x01（9/30）、11 月只有 x02（11/2）', () => {
    const sched = buildGoldenSchedule();
    const recs = goldenRecordsForCalculator();
    // 9 月：僅 x01（9/30，A 事假被 B 代）。A = 6×4 − 1 = 23；B = 5×4 + 1 = 21
    const sep = run(115, 9, sched, recs);
    eq([row(sep, '林彥廷').actualHours, row(sep, '王大明').actualHours], [23, 21], '9 月 A、B');
    // 11 月：僅 x02（11/2，同上）。同樣 A=23、B=21
    const nov = run(115, 11, sched, recs);
    eq([row(nov, '林彥廷').actualHours, row(nov, '王大明').actualHours], [23, 21], '11 月 A、B');
    // 前一學年度 10 月（2025-10-06）：114 學年度 10 月 → A=23、B=21
    const prev = run(114, 10, sched, recs);
    eq([row(prev, '林彥廷').actualHours, row(prev, '王大明').actualHours], [23, 21], '114 學年度 10 月 A、B');
});

await suite.case('學年度換算：1～7 月屬次年（115 學年度 1 月 = 2027-01）', () => {
    // 手算：2027-01 週數 2。A 6 列 → 原定 12；紀錄 2027-01-11 A 事假被 B 代 → A 11、B 5×2+1=11
    const recs = [{ date: '2027-01-11', type: '代課', originalTeacher: '林彥廷', substituteTeacher: '王大明', leaveType: '事假' }];
    const res = run(115, 1, buildGoldenSchedule(), recs);
    eq([row(res, '林彥廷').originalHours, row(res, '林彥廷').actualHours], [12, 11], 'A（1 月 2 週）');
    eq([row(res, '王大明').originalHours, row(res, '王大明').actualHours], [10, 11], 'B（1 月 2 週）');
    // 同一筆紀錄在 115 學年度 8 月（2026-08）不應出現
    const aug = run(115, 8, buildGoldenSchedule(), recs);
    eq([row(aug, '林彥廷').substitutedHours, row(aug, '王大明').substituteHours], [0, 0], '2027-01 的紀錄不屬於 2026-08');
});

await suite.case('2 月 3 週：D 21 列 → 63；基本 20×3=60；超鐘點 3', () => {
    const d = row(run(115, 2, buildGoldenSchedule(), []), '黃志偉');
    eq([d.originalHours, d.baseMonthlyHours, d.overtimeHours], [63, 60, 3], '2 月');
});

await suite.case('缺假別的代課視為一般假別扣 1（公付判斷靠 leaveType）', () => {
    // 手算：A 被代一節、無 leaveType → A 減 1 = 23；B +1 = 21
    const recs = [{ date: '2026-10-05', type: '代課', originalTeacher: '林彥廷', substituteTeacher: '王大明' }];
    const res = run(115, 10, buildGoldenSchedule(), recs);
    eq([row(res, '林彥廷').substitutedHours, row(res, '王大明').substituteHours], [1, 1], '缺假別');
});

await suite.case('契約：計算器不看 status／deleted——駁回或刪除的紀錄必須在資料層就被排除', () => {
    // 手算：若把一筆 status:'rejected' 的紀錄直接餵進來，計算器照算（A 減 1、B 加 1）。
    // 駁回請求存在 pendingRequests、刪除的紀錄文件不存在，資料層根本不會把它們交給計算器（見 e2e-06）。
    const recs = [{ date: '2026-10-05', type: '代課', status: 'rejected', originalTeacher: '林彥廷', substituteTeacher: '王大明', leaveType: '事假' }];
    const res = run(115, 10, buildGoldenSchedule(), recs);
    eq([row(res, '林彥廷').substitutedHours, row(res, '王大明').substituteHours], [1, 1], '計算器本身不排除 status');
}, { knownGap: '計算器沒有 status／deleted 防線；正確性完全依賴資料層只回傳「已成立」紀錄' });

await suite.case('兼課教師與一般教師同一套算法（partTime 不影響結算）', () => {
    const names = roster.map(t => ({ ...t, partTime: t.name === '王大明' }));
    const res = run(115, 10, buildGoldenSchedule(), goldenRecordsForCalculator(), names);
    eq(row(res, '王大明').actualHours, 23, '兼課的 B 仍是 20+3−0=23');
    eq(row(res, '王大明').overtimeHours, 0, '兼課的 B 超鐘點仍為 0');
});

await suite.case('不在名冊的教師不會出現在結算表（即使課表或紀錄有他）', () => {
    const res = run(115, 10, buildGoldenSchedule(), goldenRecordsForCalculator(), [{ name: '林彥廷' }]);
    eq(res.map(r => r.teacherName), ['林彥廷'], '只列名冊中的教師');
    eq(res[0].actualHours, 20, 'A 仍為 24−4=20');
});

await suite.case('寒暑假月份有紀錄時：週數 0 的月份會算出負的實際時數與非 0 超鐘點（疑點）', () => {
    // 手算：2027-07 週數 0 → 原定 0、基本 0。A 被代一節事假：實際 0+0−1 = −1；B 代課 +1：實際 1、超鐘點 max(0,1−0)=1。
    // 合理預期應為 0（暑假本來沒課）或不產生此類紀錄；現行行為如下。
    const recs = [{ date: '2027-07-05', type: '代課', originalTeacher: '林彥廷', substituteTeacher: '王大明', leaveType: '事假' }];
    const res = run(115, 7, buildGoldenSchedule(), recs);
    eq([row(res, '林彥廷').actualHours, row(res, '王大明').actualHours, row(res, '王大明').overtimeHours], [-1, 1, 1],
       '現行行為：A=-1、B=1、B 超鐘點=1');
}, { knownGap: '7/8 月週數寫死為 0，若該月仍有調代課紀錄（如暑期輔導），實際時數會出現負數、被代課者超鐘點會 >0' });

await suite.case('getDetailedSettlement：A 在 10 月的分類（手算）', () => {
    const recs = goldenRecordsForCalculator().filter((_, i) => GOLDEN_RECORDS[i].inScope);
    const d = calc().getDetailedSettlement(recs, '林彥廷');
    // A 被代：g01 事假、g02 病假、g03 病假、g04 公假、g05 調課、g08 事假
    eq(d.substitutedByLeaveType.personal, 2, '事假 g01、g08');
    eq(d.substitutedByLeaveType.sick, 2, '病假 g02、g03');
    eq(d.substitutedByLeaveType.official, 1, '公假 g04');
    eq(d.substitutedByLeaveType.swap, 1, '調課 g05');
    eq(d.deductedHours, 4, '扣減 = 2+2');
    eq(d.paidLeaveCount, 1, '公付 = 1');
    eq(d.substituteCount, 0, 'A 沒有代過別人的課（g05 調課不計）');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
