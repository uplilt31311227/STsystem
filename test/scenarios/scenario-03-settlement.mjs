/**
 * 情境 3：月結算與調代課單版面
 *
 * 結算部分用兩種方式驗證：
 *   1. 受控小案例——手算得出的期望值直接硬編，錯了就是錯了。
 *   2. 完整 fixture——驗證不變量（每位教師節數與課表一致、調課不影響任何人的時數等）。
 * PDF 部分測的是版面資料的組裝（週次推算、分組、HTML 內容），最後的 canvas 渲染依賴
 * 瀏覽器，Node 端無法執行，也不是邏輯所在。
 */

import { SettlementCalculator } from '../../src/js/modules/settlementCalculator.js';
import { PDFGenerator } from '../../src/js/modules/pdfGenerator.js';
import { ALPHA, buildSchoolFixture, weeklyHoursByTeacher } from '../fixtures/school-fixture.mjs';
import { Suite, eq, ok, includes } from './harness.mjs';

/** 受控案例：T1 有 10 節課，其餘教師不重要。 */
function miniSchedule() {
    const rows = [];
    for (let i = 0; i < 10; i++) {
        rows.push({
            weekday: ['週一', '週二', '週三', '週四', '週五'][i % 5],
            period: `第${['一', '二'][Math.floor(i / 5)]}節`,
            className: '7年1班', teacher: 'T1', subject: '數學', domain: '數學領域',
        });
    }
    for (let i = 0; i < 6; i++) {
        rows.push({
            weekday: '週一', period: `第${['三', '四', '五', '六', '七'][i % 5]}節`,
            className: `8年${i + 1}班`, teacher: 'T2', subject: '國語文', domain: '語文領域',
        });
    }
    return rows;
}

export async function run() {
    const suite = new Suite('情境 3：月結算與調代課單版面');
    const calc  = new SettlementCalculator();
    const pdf   = new PDFGenerator();

    /* ============ 學年度與月份換算 ============ */

    await suite.case('民國學年度換算西元年月（115 學年度橫跨 2026/8～2027/7）', () => {
        eq(calc.getMonthDateRange(115, 9),  { startDate: '2026-09-01', endDate: '2026-09-31' }, '115 學年度 9 月');
        eq(calc.getMonthDateRange(115, 12), { startDate: '2026-12-01', endDate: '2026-12-31' }, '115 學年度 12 月');
        eq(calc.getMonthDateRange(115, 1),  { startDate: '2027-01-01', endDate: '2027-01-31' }, '115 學年度 1 月應落在西元 2027');
        eq(calc.getMonthDateRange(115, 7),  { startDate: '2027-07-01', endDate: '2027-07-31' }, '115 學年度 7 月應落在西元 2027');
    });

    await suite.case('各月上課週數（寒暑假為特例）', () => {
        eq(calc.getWeeksInMonth(115, 9), 4, '9 月');
        eq(calc.getWeeksInMonth(115, 1), 2, '1 月（寒假）');
        eq(calc.getWeeksInMonth(115, 2), 3, '2 月（寒假）');
        eq(calc.getWeeksInMonth(115, 7), 0, '7 月（暑假）');
        eq(calc.getWeeksInMonth(115, 8), 0, '8 月（暑假）');
    });

    await suite.case('暑假月份的原定時數為 0，不會產生負數或 NaN', () => {
        const result = calc.calculate(115, 8, miniSchedule(), [], [{ name: 'T1' }]);
        const t1 = result.find(r => r.teacherName === 'T1');
        eq(t1.originalHours, 0, '8 月原定時數');
        eq(t1.actualHours, 0, '8 月實際時數');
        eq(t1.overtimeHours, 0, '8 月超鐘點');
    });

    /* ============ 受控案例：假別對時數的影響 ============ */

    await suite.case('受控案例：代課加時數、一般假別扣時數、公付假別與調課不扣', () => {
        const records = [
            // T1 被代課
            { date: '2026-09-07', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: '公假' },
            { date: '2026-09-08', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: 'personal' },
            { date: '2026-09-09', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: '病假' },
            // T1 為他人代課
            { date: '2026-09-10', type: '代課', originalTeacher: 'T2', substituteTeacher: 'T1', leaveType: 'sick' },
            { date: '2026-09-11', type: '代課', originalTeacher: 'T2', substituteTeacher: 'T1', leaveType: 'official' },
            // 調課：兩邊都不影響時數
            { date: '2026-09-14', type: '調課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: '調課' },
        ];
        calc.setBaseWeeklyHours(8);   // 讓超鐘點算得出來（預設 20 節 × 4 週 = 80 太高）
        const result = calc.calculate(115, 9, miniSchedule(), records, [{ name: 'T1' }, { name: 'T2' }]);
        calc.setBaseWeeklyHours(20);

        const t1 = result.find(r => r.teacherName === 'T1');
        eq(t1.weeklyHours,      10, 'T1 每週節數');
        eq(t1.originalHours,    40, 'T1 原定時數（10 節 × 4 週）');
        eq(t1.substituteHours,   2, 'T1 代課增加（兩筆代課，調課不計）');
        eq(t1.substitutedHours,  2, 'T1 被代課扣減（事假 + 病假；公假與調課不扣）');
        eq(t1.actualHours,      40, 'T1 實際時數 = 40 + 2 - 2');
        eq(t1.overtimeHours,     8, 'T1 超鐘點 = 40 - 8×4');
    });

    await suite.case('八種假別逐一驗證扣減與否', () => {
        const cases = [
            ['official', false], ['公假', false], ['longsick', false], ['長期病假', false],
            ['funeral', false], ['喪假', false], ['swap', false], ['調課', false],
            ['personal', true], ['事假', true], ['sick', true], ['病假', true],
            ['rest', true], ['休假', true], ['other', true], ['其他', true],
        ];
        for (const [leaveType, shouldDeduct] of cases) {
            const records = [{ date: '2026-09-07', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType }];
            const result  = calc.calculate(115, 9, miniSchedule(), records, [{ name: 'T1' }]);
            const t1 = result.find(r => r.teacherName === 'T1');
            eq(t1.substitutedHours, shouldDeduct ? 1 : 0, `假別「${leaveType}」是否扣減時數`);
        }
    });

    await suite.case('type=調課 時即使假別是一般假別也不扣時數', () => {
        const records = [{ date: '2026-09-07', type: '調課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: 'personal' }];
        const t1 = calc.calculate(115, 9, miniSchedule(), records, [{ name: 'T1' }])[0];
        eq(t1.substitutedHours, 0, 'type 為調課時應優先於假別判斷');
    });

    await suite.case('假別明細遺失時，公付假別會被誤算為扣減（私有明細必須合併回來）', () => {
        const withDetail    = [{ date: '2026-09-07', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: '公假' }];
        const withoutDetail = [{ date: '2026-09-07', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2' }];

        const a = calc.calculate(115, 9, miniSchedule(), withDetail,    [{ name: 'T1' }])[0];
        const b = calc.calculate(115, 9, miniSchedule(), withoutDetail, [{ name: 'T1' }])[0];
        eq(a.substitutedHours, 0, '帶假別時公假不扣');
        eq(b.substitutedHours, 1, '缺假別時會被當成一般假別扣 1 節');
    }, { knownGap: 'leaveType 存放在 private/detail，讀取端若未合併回父文件，月結算會把公假／長期病假／喪假誤算為扣減時數' });

    await suite.case('分類明細（getDetailedSettlement）的假別統計正確', () => {
        const records = [
            { date: '2026-09-07', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: 'official' },
            { date: '2026-09-08', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: '公假' },
            { date: '2026-09-09', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: 'longsick' },
            { date: '2026-09-10', type: '代課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: 'personal' },
            { date: '2026-09-11', type: '調課', originalTeacher: 'T1', substituteTeacher: 'T2', leaveType: '調課' },
        ];
        const d = calc.getDetailedSettlement(records, 'T1');
        eq(d.substitutedByLeaveType.official, 2, '公假次數（英文碼 + 中文各一）');
        eq(d.substitutedByLeaveType.longsick, 1, '長期病假次數');
        eq(d.substitutedByLeaveType.personal, 1, '事假次數');
        eq(d.deductedHours, 1, '實際扣減時數');
        eq(d.paidLeaveCount, 3, '公付假別總次數');
        eq(d.swapCount, 1, '調課次數');
    });

    /* ============ 完整 fixture 的不變量 ============ */

    const fixture = buildSchoolFixture(ALPHA);
    const parsed  = fixture.schedules[ALPHA.currentSemester].parsed;
    // 實務上 leaveType 在 private/detail，結算前必須合併回來
    const merged  = fixture.substituteRecords.map(r => ({ ...r.public, ...(r.private || {}) }));
    const roster  = fixture.teachers.map(t => ({ name: t.name }));

    await suite.case('完整課表：每位教師的每週節數與課表統計一致', () => {
        const result   = calc.calculate(115, 9, parsed, merged, roster);
        const expected = weeklyHoursByTeacher(parsed);
        for (const r of result) {
            eq(r.weeklyHours, expected.get(r.teacherName) || 0, `${r.teacherName} 的每週節數`);
        }
    });

    await suite.case('名冊中不任課的教師結算為 0，不會崩潰或產生 NaN', () => {
        const result = calc.calculate(115, 9, parsed, merged, roster);
        const idle   = result.filter(r => r.weeklyHours === 0);
        ok(idle.length >= 2, '應有不任課的行政人員');
        for (const r of idle) {
            ok(Number.isFinite(r.actualHours), `${r.teacherName} 的實際時數應為有限數字`);
            eq(r.originalHours, 0, `${r.teacherName} 的原定時數`);
        }
    });

    await suite.case('完整 fixture：代課與被代課的筆數與紀錄一致', () => {
        const result = calc.calculate(115, 9, parsed, merged, roster);
        const monthly = merged.filter(r => r.date.startsWith('2026-09'));
        const nonSwap = monthly.filter(r => r.type !== '調課');

        const totalSub = result.reduce((s, r) => s + r.substituteHours, 0);
        eq(totalSub, nonSwap.length, '代課增加總節數應等於當月非調課紀錄數');

        const deductible = nonSwap.filter(r => !['official', 'longsick', 'funeral', 'swap', '公假', '長期病假', '喪假', '調課'].includes(r.leaveType));
        const totalDeduct = result.reduce((s, r) => s + r.substitutedHours, 0);
        eq(totalDeduct, deductible.length, '扣減總節數應等於當月可扣減假別的紀錄數');
    });

    await suite.case('調課紀錄不改變任何教師的實際授課時數', () => {
        const swapOnly = merged.filter(r => r.type === '調課');
        ok(swapOnly.length > 0, 'fixture 中應有調課紀錄');
        const withSwap    = calc.calculate(115, 9, parsed, merged, roster);
        const withoutSwap = calc.calculate(115, 9, parsed, merged.filter(r => r.type !== '調課'), roster);
        for (const a of withSwap) {
            const b = withoutSwap.find(x => x.teacherName === a.teacherName);
            eq(a.actualHours, b.actualHours, `${a.teacherName} 的實際時數不應受調課紀錄影響`);
        }
    });

    await suite.case('歷史學期的紀錄不會被算進本學期月結算', () => {
        const all = [...merged, ...fixture.previousSemesterRecords.map(r => ({ ...r.public, ...(r.private || {}) }))];
        const a = calc.calculate(115, 9, parsed, merged, roster);
        const b = calc.calculate(115, 9, parsed, all, roster);
        for (const x of a) {
            const y = b.find(z => z.teacherName === x.teacherName);
            eq(x.actualHours, y.actualHours, `${x.teacherName}：114-2 學期（2026-04）的紀錄不應影響 2026-09 的結算`);
        }
    });

    /* ============ 調代課單版面 ============ */

    await suite.case('週次推算：任一天都能推回該週週一，週日歸前一週', () => {
        eq(pdf.getWeekStart('2026-09-09'), '2026-09-07', '週三推回週一');
        eq(pdf.getWeekStart('2026-09-07'), '2026-09-07', '週一本身');
        eq(pdf.getWeekStart('2026-09-11'), '2026-09-07', '週五推回週一');
        eq(pdf.getWeekStart('2026-09-13'), '2026-09-07', '週日應歸前一週（而非往後跳）');
        eq(pdf.getWeekStart('2026-09-14'), '2026-09-14', '下週一');
    });

    await suite.case('教學週範圍為週一到週五共五天', () => {
        const r = pdf.getWeekRange('2026-09-07');
        eq(r.start, '2026-09-07', '起始日');
        eq(r.end, '2026-09-11', '結束日');
        eq(r.dates.length, 5, '天數');
        eq(r.dates, ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'], '五天日期');
    });

    await suite.case('節次別名正規化（第3節 → 第三節）', () => {
        eq(pdf.normalizePeriod('第3節'), '第三節', '阿拉伯數字節次');
        eq(pdf.normalizePeriod('第三節'), '第三節', '中文節次');
    });

    await suite.case('週彙整依收件對象分組（班級／原教師／代課教師）', () => {
        const records = merged.slice(0, 5);
        const g = pdf.groupRecordsByRecipient(records);
        ok(g.byClass && g.byOriginalTeacher && g.bySubstituteTeacher, '應產生三種分組');
        const totalByClass = Object.values(g.byClass).reduce((s, a) => s + a.length, 0);
        eq(totalByClass, records.length, '依班級分組後的總筆數應與輸入一致');
        for (const r of records) {
            ok(g.byOriginalTeacher[r.originalTeacher]?.some(x => x.id === r.id),
                `${r.originalTeacher} 的分組應包含紀錄 ${r.id}`);
        }
    });

    await suite.case('教師週彙整表含教師姓名與該週日期', () => {
        const records   = merged.filter(r => r.date.startsWith('2026-09')).slice(0, 3);
        const teacher   = records[0].originalTeacher;
        const weekRange = pdf.getWeekRange(pdf.getWeekStart(records[0].date));
        const html = pdf.createTeacherWeeklySheetHTML(records, teacher, '原任課教師', weekRange, parsed);
        includes(html, teacher, '週彙整表應含教師姓名');
        includes(html, records[0].className, '週彙整表應含班級');
    });

    await suite.case('結算報表 HTML 含每位教師與其時數欄位', () => {
        const settlement = calc.calculate(115, 9, parsed, merged, roster).slice(0, 5);
        const html = pdf.createSettlementHTML(settlement, 115, 9);
        includes(html, '115', '報表應含學年度');
        for (const s of settlement) {
            includes(html, s.teacherName, `報表應含教師 ${s.teacherName}`);
        }
    });

    return suite;
}
