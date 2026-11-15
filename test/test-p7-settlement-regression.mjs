/**
 * P7 回歸：「單一學期內、名冊完整、無同名、無合班隔週」的一般情況，修前與修後的結算輸出必須逐欄相同。
 *
 * 修前程式 = test/fixtures/settlement-calculator-pre-p7.mjs（P7 開工前 HEAD 的 settlementCalculator.js 原樣複本，
 * 以 git archive 取出，自成一體、不匯入任何東西）。
 * 資料：確定性偽隨機（固定種子）產生 14 位虛構教師、各自不重複的每週課表（5～24 節）、
 * 一個學期 6 個月共 90 筆紀錄（只用修前就支援的假別，含調課、缺假別、非核准狀態、刪除旗標），
 * 逐月（8～12、1 月）、含週數覆寫與否，比對兩邊整份輸出（JSON 全等，含排序）。
 * 這裡的「期望值」就是修前程式的輸出；它證明的是「沒變」，數字本身的正確性由 test-p7-settlement.mjs 的手算資料集負責。
 */
import { SettlementCalculator as Now } from '../src/js/modules/settlementCalculator.js';
import { SettlementCalculator as Legacy } from './fixtures/settlement-calculator-pre-p7.mjs';
import { Suite, eq } from './scenarios/harness.mjs';

const suite = new Suite('P7 回歸：一般情況修前修後結算相同');

let seed = 20261115;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n; };

const WEEKDAYS = ['週一', '週二', '週三', '週四', '週五'];
const PERIODS = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節'];
const NAMES = ['陳一', '林二', '黃三', '張四', '李五', '王六', '吳七', '劉八', '蔡九', '楊十', '許甲', '鄭乙', '謝丙', '郭丁'];

const schedule = [];
NAMES.forEach((name, i) => {
    const n = 5 + ((i * 7) % 20);               // 5～24 節，各人不同
    const slots = [];
    for (const w of WEEKDAYS) for (const p of PERIODS) slots.push([w, p]);
    for (let k = 0; k < n; k++) {
        const [weekday, period] = slots[(i * 3 + k * 1) % slots.length];
        // 保證同一教師的 星期＋節次 不重複：用位移 + 去重
        if (schedule.some(c => c.teacher === name && c.weekday === weekday && c.period === period)) continue;
        schedule.push({ weekday, period, className: `${7 + (i % 3)}年${1 + (k % 9)}班`, teacher: name, subject: '數學', domain: '數學領域' });
    }
    // 補足到 n 節（位移撞到重複時用線性探測）
    let have = schedule.filter(c => c.teacher === name).length;
    for (let s = 0; have < n && s < slots.length; s++) {
        const [weekday, period] = slots[s];
        if (schedule.some(c => c.teacher === name && c.weekday === weekday && c.period === period)) continue;
        schedule.push({ weekday, period, className: `${7 + (i % 3)}年${1 + (have % 9)}班`, teacher: name, subject: '數學', domain: '數學領域' });
        have++;
    }
});

const LEAVES = ['official', 'longsick', 'funeral', 'personal', 'sick', 'rest', 'other', '公假', '事假', '病假', '', undefined];
const MONTHS = [[2026, 8], [2026, 9], [2026, 10], [2026, 11], [2026, 12], [2027, 1]];
const records = [];
for (let i = 0; i < 90; i++) {
    const [y, m] = MONTHS[rnd(MONTHS.length)];
    const d = 1 + rnd(28);
    const o = NAMES[rnd(NAMES.length)];
    let s = NAMES[rnd(NAMES.length)];
    if (s === o) s = NAMES[(NAMES.indexOf(o) + 1) % NAMES.length];
    const rec = {
        date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        period: PERIODS[rnd(PERIODS.length)], className: '7年1班',
        type: rnd(8) === 0 ? '調課' : (rnd(11) === 0 ? 'swap' : '代課'),
        originalTeacher: o, substituteTeacher: s, leaveType: LEAVES[rnd(LEAVES.length)],
    };
    const k = rnd(14);
    if (k === 0) rec.status = 'rejected';
    else if (k === 1) rec.status = 'pending_approval';
    else if (k === 2) rec.status = 'approved';
    else if (k === 3) rec.deleted = true;
    records.push(rec);
}
const roster = NAMES.map(name => ({ name }));

await suite.case('資料量檢查：14 位教師、每位課表節數不重複、90 筆紀錄', () => {
    eq(NAMES.length, 14, '教師數');
    for (const name of NAMES) {
        const rows = schedule.filter(c => c.teacher === name);
        eq(new Set(rows.map(c => c.weekday + c.period)).size, rows.length, `${name} 課表不重複`);
    }
    eq(records.length, 90, '紀錄數');
});

for (const [y, m] of MONTHS) {
    for (const withOverride of [false, true]) {
        await suite.case(`115 學年度 ${m} 月${withOverride ? '（含週數覆寫）' : ''}：修前修後整份輸出相同`, () => {
            const a = new Legacy(), b = new Now();
            if (withOverride) { a.setWeeksOverride(115, { [m]: 3 }); b.setWeeksOverride(115, { [m]: 3 }); }
            const before = a.calculate(115, m, schedule, records, roster);
            const after = b.calculate(115, m, schedule, records, roster);
            eq(after.length, 14, '列數');
            eq(JSON.stringify(after), JSON.stringify(before), '整份結算 JSON 相同');
            // 明細、彙總分頁資料口徑同樣不變
            eq(JSON.stringify(b.getMonthlyDetailRows(records, 115, m)), JSON.stringify(a.getMonthlyDetailRows(records, 115, m)), '逐節明細相同');
            eq(JSON.stringify(b.getDetailedSettlement(records, '陳一')), JSON.stringify(a.getDetailedSettlement(records, '陳一')), '個人分類統計相同');
        });
    }
}

await suite.case('至少有一個月份實際有代課與扣時數（避免全為 0 的空比對）', () => {
    const rows = new Now().calculate(115, 10, schedule, records, roster);
    eq(rows.some(r => r.substituteHours > 0) && rows.some(r => r.substitutedHours > 0) && rows.some(r => r.overtimeHours > 0), true, '有代課、有被代課、有超鐘點');
});

await suite.case('旗標預設值：不帶 opts 時結果仍與修前一致，且結算列不多出任何新欄位', () => {
    const rows = new Now().calculate(115, 10, schedule, records, roster);
    eq(Object.keys(rows[0]).sort(), ['actualHours', 'baseMonthlyHours', 'originalHours', 'overtimeHours', 'substituteHours', 'substitutedHours', 'teacherName', 'weeklyHours'], '欄位集合');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
