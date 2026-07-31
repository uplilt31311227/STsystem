/**
 * 學期推導工具單元測試（Stage 2）
 * 執行：node test/test-semester-utils.mjs
 *
 * 涵蓋範圍：
 *   - 台灣學年度邊界：8/1（新學年度上學期起點）、1/31（上學期末）、2/1（下學期起點）、
 *     7/31（下學期末，跨年度前一天）
 *   - 民國年換算（與 settlementCalculator._resolveMonth 的正向換算方向互為驗證，見
 *     semesterUtils.js 檔頭註解）
 *   - 格式不合法輸入的容錯
 *   - parseSemesterId / compareSemesterId / nextSemesterId
 */
import {
    dateToSemesterId,
    parseSemesterId,
    isValidSemesterId,
    compareSemesterId,
    nextSemesterId,
} from '../src/js/modules/v2/semesterUtils.js';

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (actual === expected) { pass++; }
    else { fail++; console.error(`✗ ${label}：預期 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`); }
}
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.error(`✗ ${label}`); }
}

/* ===== dateToSemesterId：台灣學年度四個邊界 ===== */

eq(dateToSemesterId('2025-08-01'), '114-1', '8/1（新學年度上學期起點）→ 114-1');
eq(dateToSemesterId('2026-01-31'), '114-1', '1/31（上學期末）→ 114-1');
eq(dateToSemesterId('2026-02-01'), '114-2', '2/1（下學期起點）→ 114-2');
eq(dateToSemesterId('2026-07-31'), '114-2', '7/31（下學期末）→ 114-2，與 README bootstrap 值一致');
eq(dateToSemesterId('2026-08-01'), '115-1', '8/1（跨學年度）→ 115-1');

/* ===== 學期內部各月份 sanity check ===== */

eq(dateToSemesterId('2025-09-15'), '114-1', '9 月屬上學期');
eq(dateToSemesterId('2025-12-25'), '114-1', '12 月屬上學期');
eq(dateToSemesterId('2026-01-01'), '114-1', '1 月屬上學期（元旦）');
eq(dateToSemesterId('2026-03-01'), '114-2', '3 月屬下學期');
eq(dateToSemesterId('2026-06-30'), '114-2', '6 月屬下學期');

/* ===== 民國年換算交叉驗證（settlementCalculator._resolveMonth 反向） =====
 * settlementCalculator._resolveMonth(114, 8) → westernYear=2025, actualYear=2025（month>=8）
 * 即「114 學年度 8 月」對應西元 2025 年 8 月，反推 dateToSemesterId('2025-08-01') 應為 '114-1'。
 * settlementCalculator._resolveMonth(114, 2) → westernYear=2025, actualYear=2026（month<8）
 * 即「114 學年度 2 月」對應西元 2026 年 2 月，反推 dateToSemesterId('2026-02-01') 應為 '114-2'。
 */
eq(dateToSemesterId('2025-08-01'), '114-1', '交叉驗證：114 學年度 8 月 = 西元 2025-08');
eq(dateToSemesterId('2026-02-01'), '114-2', '交叉驗證：114 學年度 2 月 = 西元 2026-02');

/* ===== 格式容錯 ===== */

eq(dateToSemesterId(''), null, '空字串回傳 null');
eq(dateToSemesterId(null), null, 'null 回傳 null');
eq(dateToSemesterId('2026/07/31'), null, '非 YYYY-MM-DD 格式回傳 null');
eq(dateToSemesterId('not-a-date'), null, '完全非日期字串回傳 null');

/* ===== 驗收修復（輕 12）：日期往返驗證——正則能過但日期本身不存在 ===== */

eq(dateToSemesterId('2026-02-31'), null, '2 月沒有 31 日，格式合法但日期不存在，應回傳 null');
eq(dateToSemesterId('2026-04-31'), null, '4 月只有 30 天，應回傳 null');
eq(dateToSemesterId('2026-02-29'), null, '2026 非閏年，2/29 不存在，應回傳 null');
eq(dateToSemesterId('2024-02-29'), '112-2', '2024 是閏年，2/29 存在，應正常換算（2024-1912=112）');
eq(dateToSemesterId('2026-13-01'), null, '月份超出範圍（13 月）應回傳 null');
eq(dateToSemesterId('2026-00-01'), null, '月份超出範圍（0 月）應回傳 null');

/* ===== parseSemesterId / isValidSemesterId ===== */

{
    const p = parseSemesterId('114-2');
    ok(p && p.rocYear === 114 && p.semester === 2, 'parseSemesterId 正確拆解 114-2');
}
eq(parseSemesterId('bad'), null, 'parseSemesterId 對不合法字串回傳 null');
eq(parseSemesterId('114-3'), null, 'parseSemesterId 拒絕學期不是 1/2 的值');
ok(isValidSemesterId('114-1'), 'isValidSemesterId 接受合法格式');
ok(!isValidSemesterId('114'), 'isValidSemesterId 拒絕缺學期的格式');

/* ===== compareSemesterId ===== */

ok(compareSemesterId('114-1', '114-2') < 0, '114-1 早於 114-2');
ok(compareSemesterId('114-2', '115-1') < 0, '114-2 早於 115-1（跨學年度）');
eq(compareSemesterId('114-2', '114-2'), 0, '相同學期比較結果為 0');
ok(compareSemesterId('115-1', '114-2') > 0, '115-1 晚於 114-2');

/* ===== nextSemesterId ===== */

eq(nextSemesterId('114-1'), '114-2', '114-1 的下一學期是 114-2');
eq(nextSemesterId('114-2'), '115-1', '114-2 的下一學期跨學年度為 115-1');
eq(nextSemesterId('bad'), null, '不合法輸入回傳 null');

console.log(`\n[semester-utils] ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
