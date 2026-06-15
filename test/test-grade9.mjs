/**
 * 九年級停用邏輯單元測試（獨立複製 dataManager 的實作邏輯驗證）
 * 執行：node test/test-grade9.mjs
 */

// ---- 與 dataManager.js 完全相同的判斷邏輯 ----
function isGraduatedClass(className) {
    if (!className) return false;
    let n = String(className).replace(/\s+/g, '');
    const cn = {
        '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
        '六': '6', '七': '7', '八': '8', '九': '9', '十': '10'
    };
    for (const [c, num] of Object.entries(cn)) {
        n = n.replace(new RegExp(c, 'g'), num);
    }
    const numMatch = n.match(/^(\d)(\d{2})$/);
    if (numMatch) return numMatch[1] === '9';
    const gradeMatch = n.match(/^(\d+)年/);
    return gradeMatch ? gradeMatch[1] === '9' : false;
}

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    if (actual === expected) { pass++; }
    else { fail++; console.error(`✗ ${label}：預期 ${expected}，實得 ${actual}`); }
}

// ---- isGraduatedClass 各格式 ----
eq(isGraduatedClass('9年1班'), true, '9年1班');
eq(isGraduatedClass('9年10班'), true, '9年10班');
eq(isGraduatedClass('九年1班'), true, '九年1班');
eq(isGraduatedClass('九年三班'), true, '九年三班(全中文)');
eq(isGraduatedClass('901'), true, '901');
eq(isGraduatedClass('9 年 5 班'), true, '含空白 9 年 5 班');
eq(isGraduatedClass('7年1班'), false, '7年1班');
eq(isGraduatedClass('8年3班'), false, '8年3班');
eq(isGraduatedClass('709'), false, '709(7年9班)');
eq(isGraduatedClass('801'), false, '801');
eq(isGraduatedClass(''), false, '空字串');
eq(isGraduatedClass(null), false, 'null');
eq(isGraduatedClass(undefined), false, 'undefined');

// ---- getActiveScheduleData 過濾行為 ----
const schedule = [
    { teacher: '王老師', weekday: '週一', period: '第一節', className: '9年1班' },
    { teacher: '李老師', weekday: '週一', period: '第一節', className: '7年2班' },
    { teacher: '陳老師', weekday: '週一', period: '第二節', className: '901' },
    { teacher: '林老師', weekday: '週二', period: '第三節', className: '8年1班' },
];

function getActiveScheduleData(data, disabled) {
    if (!disabled) return data;
    return data.filter(c => !isGraduatedClass(c.className));
}
function getBusyTeachers(data, disabled, weekday, period) {
    return getActiveScheduleData(data, disabled)
        .filter(c => c.weekday === weekday && c.period === period)
        .map(c => c.teacher);
}

// 開關關閉：全部保留
eq(getActiveScheduleData(schedule, false).length, 4, '關閉時保留全部');
// 開關開啟：移除 9年1班 與 901
eq(getActiveScheduleData(schedule, true).length, 2, '開啟時移除九年級');

// 忙碌教師：週一第一節，關閉時 王、李 都忙；開啟時只剩 李（王教九年級恢復空堂）
eq(getBusyTeachers(schedule, false, '週一', '第一節').join(','), '王老師,李老師', '關閉:週一第一節忙碌');
eq(getBusyTeachers(schedule, true, '週一', '第一節').join(','), '李老師', '開啟:王老師恢復空堂');
// 週一第二節：陳老師教 901，開啟時恢復空堂
eq(getBusyTeachers(schedule, true, '週一', '第二節').join(','), '', '開啟:陳老師(901)恢復空堂');

console.log(`\n結果：通過 ${pass}，失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
