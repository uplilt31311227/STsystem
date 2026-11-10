/**
 * 本地日期工具測試（修正「用 UTC 取日期」在台灣清晨差一天）
 * 執行：node test/test-local-date.mjs
 *
 * TZ 必須在 import 任何東西之前設定，所以用動態 import。
 * 涵蓋：00:30 / 07:59 轉出本地日期、舊寫法確實會錯、parse 後 getDay、
 *       跨月/跨年/閏年加減、DataManager.normalizeDate、app.js 的 findNextMatchingDate/getDateWeekday。
 */
process.env.TZ = 'Asia/Taipei';

import { readFileSync } from 'node:fs';
const { formatLocalDate, parseLocalDate, todayLocal, addDaysLocal } = await import('../src/js/modules/localDate.js');
const { DataManager } = await import('../src/js/modules/dataManager.js');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (actual === expected) { pass++; }
    else { fail++; console.error(`✗ ${label}：預期 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`); }
}
function ok(cond, label) { if (cond) pass++; else { fail++; console.error(`✗ ${label}`); } }

ok(new Date(2026, 0, 1).getTimezoneOffset() === -480, 'TZ 已設為 UTC+8');

// ===== 清晨時段：新寫法正確、舊寫法確實會錯 =====
for (const [h, mi] of [[0, 0], [0, 30], [7, 59]]) {
    const d = new Date(2026, 10, 11, h, mi);   // 本地 2026-11-11
    const lbl = `${h}:${String(mi).padStart(2, '0')}`;
    eq(formatLocalDate(d), '2026-11-11', `formatLocalDate 本地 ${lbl}`);
    eq(d.toISOString().split('T')[0], '2026-11-10', `舊寫法在 ${lbl} 確實會得到前一天（證明測試有效）`);
}
eq(formatLocalDate(new Date(2026, 10, 11, 8, 0)), '2026-11-11', '08:00 新寫法');
eq(new Date(2026, 10, 11, 8, 0).toISOString().split('T')[0], '2026-11-11', '08:00 舊寫法剛好正確（白天行為不變）');
eq(formatLocalDate(new Date(2026, 10, 11, 23, 59)), '2026-11-11', '23:59 新寫法');
eq(todayLocal(), formatLocalDate(new Date()), 'todayLocal = formatLocalDate(now)');

// ===== parse：本地午夜、getDay 正確 =====
const p = parseLocalDate('2026-11-11');
eq(p.getHours(), 0, 'parse 為本地午夜');
eq(p.getDay(), 3, '2026-11-11 是週三');
eq(parseLocalDate('2026-11-08').getDay(), 0, '2026-11-08 週日');
eq(parseLocalDate('2024-02-29').getDay(), 4, '2024-02-29 週四');
eq(formatLocalDate(parseLocalDate('2026-01-01')), '2026-01-01', 'parse/format 往返');
ok(Number.isNaN(parseLocalDate('abc').getTime()), '非法字串 → Invalid Date');
eq(formatLocalDate(parseLocalDate('2026/11/11')), '2026-11-11', '斜線格式退回原生解析（本地午夜）');

// ===== 日期加減 =====
eq(addDaysLocal('2026-01-31', 1), '2026-02-01', '跨月 +1');
eq(addDaysLocal('2026-03-01', -1), '2026-02-28', '跨月 -1（平年）');
eq(addDaysLocal('2026-12-31', 1), '2027-01-01', '跨年 +1');
eq(addDaysLocal('2027-01-01', -1), '2026-12-31', '跨年 -1');
eq(addDaysLocal('2024-02-28', 1), '2024-02-29', '閏年 2/28 +1');
eq(addDaysLocal('2024-02-29', 1), '2024-03-01', '閏年 2/29 +1');
eq(addDaysLocal('2024-03-01', -1), '2024-02-29', '閏年 3/1 -1');
eq(addDaysLocal('2026-11-11', 31), '2026-12-12', '+31 天');
eq(addDaysLocal('2026-11-11', -31), '2026-10-11', '-31 天');
eq(addDaysLocal('bad', 1), 'bad', '格式不對原樣回傳');

// ===== DataManager.normalizeDate（原 dataManager.js:615）=====
const norm = (s) => DataManager.prototype.normalizeDate.call({}, s);
eq(norm('2026-11-11'), '2026-11-11', 'normalizeDate YYYY-MM-DD 不變');
eq(norm('2026/11/11'), '2026-11-11', 'normalizeDate 斜線格式（舊寫法會得到前一天）');
eq(norm(''), '', 'normalizeDate 空字串');
eq(norm('不是日期'), '不是日期', 'normalizeDate 非法值原樣回傳');

// ===== app.js 的 findNextMatchingDate / getDateWeekday（app.js 依賴 DOM 無法直接 import，
//       這裡從原始碼抽出方法本體，用真實程式碼測試）=====
const src = readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
function extractMethod(name) {
    // 類別方法為 4 格縮排：從「換行+4空白+方法名(」起，到下一個「換行+4空白+右大括號」止
    const start = src.indexOf(String.fromCharCode(10) + "    " + name + "(");
    if (start < 0) throw new Error("抽不到 app.js 方法 " + name);
    const close = src.indexOf(String.fromCharCode(10) + "    }", start + 1);
    return src.slice(start + 1, close + 6).split(String.fromCharCode(13)).join("");
}
const WD = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const host = {
    numberToWeekday: (n) => WD[n],
    weekdayToNumber: (w) => WD.indexOf(w),
};
const mk = (name) => new Function('formatLocalDate', 'parseLocalDate', `return ({ ${extractMethod(name)} }).${name};`)(formatLocalDate, parseLocalDate);
host.getDateWeekday = mk('getDateWeekday');
host.findNextMatchingDate = mk('findNextMatchingDate');
eq(host.getDateWeekday('2026-11-11'), '週三', 'getDateWeekday 2026-11-11');
eq(host.getDateWeekday('2026-11-08'), '週日', 'getDateWeekday 週日');
eq(host.findNextMatchingDate('週五', '2026-11-11'), '2026-11-13', 'findNext 同週往後');
eq(host.findNextMatchingDate('週一', '2026-11-11'), '2026-11-16', 'findNext 目標已過 → 下週');
eq(host.findNextMatchingDate('週三', '2026-11-11'), '2026-11-11', 'findNext 同日');
eq(host.findNextMatchingDate('週二', '2026-12-30'), '2027-01-05', 'findNext 跨年');
eq(host.findNextMatchingDate('週五', '2024-02-27'), '2024-03-01', 'findNext 閏年跨月');

console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
