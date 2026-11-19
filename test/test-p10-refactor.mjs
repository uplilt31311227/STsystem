/**
 * P10 code-review 重構的行為鎖定測試：新實作的輸出必須與「修前的內嵌實作」逐項相同。
 *   5. app.js getLeaveTypeName → leaveTypes.leaveTypeDisplayName
 *   6. settlementCalculator.getMonthlyDetailRows 節次排序改用 periods.periodIndex
 *   7. getTeacherWeeklyHours 與 calculate 每段每週節數共用 helper（結算黃金值由 test-settlement／test-p7-settlement／e2e-06 把關）
 * 執行：node test/test-p10-refactor.mjs
 */
import { SettlementCalculator } from '../src/js/modules/settlementCalculator.js';
import { LEAVE_TYPES, leaveTypeDisplayName, noDeductCodesAndLabels } from '../src/js/modules/leaveTypes.js';
import { readFileSync } from 'node:fs';

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

// ---- 5. getLeaveTypeName：修前寫死的對照表（原樣保留於此作為黃金值）----
const OLD_NAMES = {
    official: '公假', longsick: '長期病假', funeral: '喪假', marriage: '婚假', maternity: '產假', paternity: '陪產假',
    injury: '公傷假', miscarriage: '流產假', family: '家庭照顧假', menstrual: '生理假', personal: '事假', sick: '病假',
    rest: '休假', other: '其他', swap: '調課',
};
const oldName = (t) => OLD_NAMES[t] || t;
{
    const probes = [...Object.keys(OLD_NAMES), ...Object.values(OLD_NAMES), '', undefined, null, 'unknown', '未知假別', 'OFFICIAL', ' official'];
    const bad = probes.filter(p => leaveTypeDisplayName(p) !== oldName(p));
    check('getLeaveTypeName：所有代碼、中文名稱、空值、未知值的輸出與修前一致', bad.length === 0, JSON.stringify(bad));
    check('getLeaveTypeName：LEAVE_TYPES 每個代碼都在舊對照表且標籤相同（無新增或差異）',
        LEAVE_TYPES.every(t => OLD_NAMES[t.code] === t.label) && LEAVE_TYPES.length === Object.keys(OLD_NAMES).length - 1);
    const noDeduct = noDeductCodesAndLabels();
    check('結算 noDeductCodesAndLabels 集合不變（公假、長期病假、喪假、婚產陪公傷流產、swap、調課）',
        JSON.stringify([...noDeduct].sort()) === JSON.stringify(['official', '公假', 'longsick', '長期病假', 'funeral', '喪假', 'marriage', '婚假', 'maternity', '產假',
            'paternity', '陪產假', 'injury', '公傷假', 'miscarriage', '流產假', 'swap', '調課'].sort()), JSON.stringify(noDeduct));
    const src = readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
    check('app.js 已不再內嵌假別對照表', !/'miscarriage': '流產假'/.test(src) && /leaveTypeDisplayName\(leaveType\)/.test(src));
}

// ---- 6. getMonthlyDetailRows 排序 ----
{
    const calc = new SettlementCalculator();
    const periods = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節', '第九節', '早自習', '', undefined, '午休'];
    const records = [];
    let seed = 7;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 120; i++) {
        records.push({ id: i, date: `2026-10-${String(1 + rnd(4)).padStart(2, '0')}`, period: periods[rnd(periods.length)],
            type: '代課', originalTeacher: 'A', substituteTeacher: 'B', leaveType: 'sick', className: '801', status: 'approved' });
    }
    const oldIdx = (p) => { const i = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節'].indexOf(p); return i < 0 ? 99 : i; };
    const expected = calc.filterMonthlyRecords(records, 115, 10)
        .map(r => ({ id: r.id, date: r.date, period: r.period || '' }))
        .sort((a, b) => a.date.localeCompare(b.date) || oldIdx(a.period) - oldIdx(b.period));
    const got = calc.getMonthlyDetailRows(records, 115, 10).map(r => ({ date: r.date, period: r.period }));
    check('getMonthlyDetailRows：節次排序（含未知節次、空值）與修前一致', got.length === 120 && got.every((g, i) => g.date === expected[i].date && g.period === expected[i].period));
}

// ---- 7. getTeacherWeeklyHours 與 calculate 的每週節數 ----
{
    const calc = new SettlementCalculator();
    const sched = [
        { teacher: '甲', weekday: '週一', period: '第一節', className: '801' },
        { teacher: '甲', weekday: '週一', period: '第一節', className: '802' },          // 合班：同槽只算 1
        { teacher: '甲', weekday: '週二', period: '第二節', className: '801', frequency: 2 },
        { teacher: '甲', weekday: '週二', period: '第二節', className: '802', frequency: 2 },   // 不同班輪替 0.5+0.5
        { teacher: '甲', weekday: '週三', period: '第三節', className: '801', frequency: 2 },
        { teacher: '甲', weekday: '週三', period: '第三節', className: '801', frequency: 2 },   // 完全重複 → 0.5
        { teacher: '甲', weekday: '週四', period: '第四節', className: '801', frequency: 2 },
        { teacher: '甲', weekday: '週四', period: '第四節', className: '802' },          // 每週列蓋過隔週 → 1
        { teacher: '乙', weekday: '週一', period: '第一節', className: '801' },
        { teacher: '　甲 ', weekday: '週五', period: '第五節', className: '801', biweekly: true },  // 全形空白姓名 + biweekly
    ];
    check('getTeacherWeeklyHours：1 + 1 + 0.5 + 1 + 0.5 = 4', calc.getTeacherWeeklyHours(sched, '甲') === 4, String(calc.getTeacherWeeklyHours(sched, '甲')));
    check('getTeacherWeeklyHours：其他教師與查無此人', calc.getTeacherWeeklyHours(sched, '乙') === 1 && calc.getTeacherWeeklyHours(sched, '丙') === 0);
}

// ---- 8. 批次 D 建議（原始碼層級的鎖定；實際畫面由 e2e-10 驗）----
{
    const v2 = readFileSync(new URL('../src/js/v2-app.js', import.meta.url), 'utf8');
    check('8a 首字圓章：V2 取得 identity 後以 identity.name 首字更新', /nameInitial = Array\.from\(String\(identity\.name/.test(v2) && /avatarFb\.textContent = nameInitial/.test(v2));
    check('8b onAuthStateChange 收到回報就重畫遮罩（逾時退回登入鈕後不殘留）', v2.split("_v2GateAuthState = user ? 'in' : 'out';")[1].slice(0, 400).includes('renderAuthGate();'));
    check('8c SDK 載入失敗：遮罩本身顯示失敗文案', /_v2GateSdkFailed = true;/.test(v2) && /id="v2-gate-sdk-failed">登入服務載入失敗，請檢查網路後重新整理頁面/.test(v2));
    check('8c SDK 載入失敗：遮罩有「重新整理」按鈕並以 addEventListener 綁定（不用 inline handler）', /id="v2-gate-reload">重新整理<\/button>/.test(v2) && /#v2-gate-reload'\)\?\.addEventListener\('click', \(\) => window\.location\.reload\(\)\)/.test(v2));
}

console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
