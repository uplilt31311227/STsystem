/**
 * P7 月結算正確性：固定資料集（虛構）＋ 手算期望值
 *
 * 規則：所有期望數字都是先用手算寫在各案例的註解（算式），再比對程式輸出；不是跑出來再抄。
 * 想確認「修前是紅的」：P7_CALC=./fixtures/settlement-calculator-pre-p7.mjs node test/test-p7-settlement.mjs
 * （改用 P7 開工前的結算程式；新增的功能會失敗，並顯示修前的錯誤數字）。
 *
 * 涵蓋：跨學期月份、離職代課者、同名教師、姓名空白、合班、完全重複列、隔週課、各假別、
 *       逐人門檻、行事曆例外（不放假、部分年級停課）、九年級畢業設定、核准時讀不到私有明細。
 */
import { register } from 'node:module';
register('./helpers/gstatic-stub-loader.mjs', import.meta.url);
globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.document = { getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const F = (globalThis.__fake = { docs: new Map(), writes: [] });

import { Suite, eq, ok, includes } from './scenarios/harness.mjs';

const CALC = process.env.P7_CALC || '../src/js/modules/settlementCalculator.js';
const { SettlementCalculator, parseBaseMapText, formatBaseMapText } = await import(CALC);
const { LEAVE_TYPES } = await import('../src/js/modules/leaveTypes.js');
const { prepareSettlementInputs, settlementMissingMessage } = await import('../src/js/modules/settlementInputs.js');
const { computeWeeksByMonth, isHolidayTitle } = await import('../src/js/modules/schoolCalendar.js');
const { isGrade9GraduationActive, buildGrade9Config } = await import('../src/js/modules/grade9Graduation.js');

const suite = new Suite('P7 月結算正確性（固定資料集，手算期望值）');
const calc = () => new SettlementCalculator();

// ---------- 資料產生 ----------
const WD = ['週一', '週二', '週三', '週四', '週五'];
const PD = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節'];
const SLOTS = [];
for (const p of PD) for (const w of WD) SLOTS.push([w, p]);          // 40 個不重複的 星期＋節次
const rows = (teacher, n, cls = '701', start = 0, extra = {}) =>
    SLOTS.slice(start, start + n).map(([weekday, period]) => ({ weekday, period, className: cls, teacher, subject: '數學', domain: '數學領域', ...extra }));
const rec = (o) => ({ type: '代課', status: 'approved', ...o });
const byName = (res, name) => res.filter(r => r.teacherName.trim() === name);
const one = (res, name) => { const l = byName(res, name); eq(l.length, 1, `${name} 應只有一列`); return l[0]; };

// =====================================================================
// A. 固定資料集：115 學年度 10 月（2026-10，預設 4 週；屬 115-1）
// =====================================================================
// 課表（115-1）：
//   林一：18 個不重複節次 + 1 列完全重複 + 1 列合班（同節次、另一班） → 去重後每週 18 節
//   王二：20 個每週節次 + 2 個隔週節次（frequency 2，各算 0.5） → 20 + 2×0.5 = 21 節
//   李四：10 節（名冊有兩位同名「李四」，課表只記姓名）
// 名冊：林一(tA)、「王二 」(tB，姓名帶尾端空白)、李四(t4a)、李四(t4b)；趙五(t5) 已離職不在名冊
const sched115_1 = [
    ...rows('林一', 18),
    { ...rows('林一', 1)[0] },                                   // 完全重複列
    { ...rows('林一', 1)[0], className: '702' },                  // 合班：同節次、另一班
    ...rows('王二', 20),
    ...rows('王二', 2, '703', 20, { frequency: 2 }),              // 隔週（frequency 2）
    ...rows('李四', 10, '801'),
];
const roster115_1 = [
    { name: '林一', teacherId: 'tA' }, { name: '王二 ', teacherId: 'tB' },
    { name: '李四', teacherId: 't4a' }, { name: '李四', teacherId: 't4b' },
];
const R = (extra) => rec({ date: '2026-10-05', period: '第一節', className: '701', ...extra });
const recordsOct = [
    // r1 林一事假、王二代課：王二 +1；林一 −1（事假扣）
    R({ originalTeacher: '林一', originalTeacherId: 'tA', substituteTeacher: '王二', substituteTeacherId: 'tB', leaveType: 'personal' }),
    // r2a、r2b 林一病假（中文假別）、離職的趙五代課兩節：趙五 +2；林一 −2
    R({ originalTeacher: '林一', originalTeacherId: 'tA', substituteTeacher: '趙五', substituteTeacherId: 't5', leaveType: '病假' }),
    R({ originalTeacher: '林一', originalTeacherId: 'tA', substituteTeacher: '趙五', substituteTeacherId: 't5', leaveType: '病假', date: '2026-10-06' }),
    // r3 王二（紀錄姓名帶全形空白、沒有 id）公假、趙五代課：趙五 +1；王二不扣
    R({ originalTeacher: '王二　', substituteTeacher: '趙五', substituteTeacherId: 't5', leaveType: 'official' }),
    // r4 李四(t4a) 事假、王二代課：王二 +1；李四a −1
    R({ originalTeacher: '李四', originalTeacherId: 't4a', substituteTeacher: '王二', substituteTeacherId: 'tB', leaveType: 'personal' }),
    // r5 李四(t4b) 婚假、林一代課：林一 +1；李四b 不扣（婚假不扣）
    R({ originalTeacher: '李四', originalTeacherId: 't4b', substituteTeacher: '林一', substituteTeacherId: 'tA', leaveType: 'marriage' }),
    // r6 林一家庭照顧假、李四(t4b) 代課：李四b +1；林一 −1（家庭照顧假扣）
    R({ originalTeacher: '林一', originalTeacherId: 'tA', substituteTeacher: '李四', substituteTeacherId: 't4b', leaveType: 'family' }),
    // r7 調課（林一與王二互換）：不增不減
    R({ type: '調課', originalTeacher: '林一', originalTeacherId: 'tA', substituteTeacher: '王二', substituteTeacherId: 'tB', leaveType: '調課' }),
    // r9 王二陪產假、林一代課：林一 +1；王二不扣
    R({ originalTeacher: '王二', originalTeacherId: 'tB', substituteTeacher: '林一', substituteTeacherId: 'tA', leaveType: 'paternity' }),
    // r10 林一公傷假、王二代課：王二 +1；林一不扣
    R({ originalTeacher: '林一', originalTeacherId: 'tA', substituteTeacher: '王二', substituteTeacherId: 'tB', leaveType: 'injury' }),
    // 範圍外與非核准：11 月、駁回，皆不計入
    R({ date: '2026-11-02', originalTeacher: '林一', originalTeacherId: 'tA', substituteTeacher: '王二', substituteTeacherId: 'tB', leaveType: 'personal' }),
    R({ status: 'rejected', originalTeacher: '林一', originalTeacherId: 'tA', substituteTeacher: '王二', substituteTeacherId: 'tB', leaveType: 'personal' }),
];
const optsFull = (more = {}) => ({ ...more });

await suite.case('A1 每週節數去重：完全重複列與合班算 1 節、隔週課算 0.5（單元）', () => {
    const c = calc();
    // 林一：20 列 → 18 個不重複節次 → 18。王二：20 + 2×0.5 → 21。李四：10。找不到的人 0。
    eq(c.getTeacherWeeklyHours(sched115_1, '林一'), 18, '林一（重複列、合班不重複計）');
    eq(c.getTeacherWeeklyHours(sched115_1, '王二'), 21, '王二（隔週 2 節 = 1）');
    eq(c.getTeacherWeeklyHours(sched115_1, ' 李四　'), 10, '李四（姓名前後有空白）');
    eq(c.getTeacherWeeklyHours(sched115_1, '無此人'), 0, '無此人');
    // 同一教師同節次兩列都是隔週（單週、雙週各一班）→ 合計 1，不是 2
    const alt = [...rows('甲', 1, '701', 0, { frequency: 2 }), ...rows('甲', 1, '702', 0, { frequency: 2 })];
    eq(c.getTeacherWeeklyHours(alt, '甲'), 1, '單雙週輪替同一節次 = 每週 1 節');
});

await suite.case('A2 十月固定資料集：林一、王二、趙五（離職）、同名李四各自的數字', () => {
    const res = calc().calculate(115, 10, sched115_1, recordsOct, roster115_1, optsFull());
    // 林一：原定 18×4=72；代課 +2（r5、r9）；被代課扣 4（r1 事假 1、r2 病假 2、r6 家庭照顧假 1；r10 公傷假與 r7 調課不扣）
    //       實際 72+2−4=70；門檻 20×4=80 → 超鐘點 0
    const a = one(res, '林一');
    eq([a.weeklyHours, a.originalHours, a.substituteHours, a.substitutedHours, a.actualHours, a.baseMonthlyHours, a.overtimeHours],
       [18, 72, 2, 4, 70, 80, 0], '林一');
    // 王二：原定 21×4=84；代課 +3（r1、r4、r10；r7 調課不計）；被代課扣 0（r3 公假、r9 陪產假不扣）
    //       實際 84+3=87；門檻 80 → 超鐘點 7
    const b = one(res, '王二');
    eq([b.weeklyHours, b.originalHours, b.substituteHours, b.substitutedHours, b.actualHours, b.overtimeHours],
       [21, 84, 3, 0, 87, 7], '王二（名冊姓名帶空白、紀錄姓名帶全形空白仍算同一人）');
    // 趙五（已離職、不在名冊）：原定 0；代課 +3（r2a、r2b、r3）；實際 3；超鐘點 max(0,3−80)=0；不可消失
    const z = one(res, '趙五');
    eq([z.originalHours, z.substituteHours, z.substitutedHours, z.actualHours, z.overtimeHours, z.notInRoster], [0, 3, 0, 3, 0, true], '趙五');
    // 同名李四兩位以 teacherId 分開：
    //   t4a：課表只記姓名，暫以 10 節計 → 原定 40；被代課扣 1（r4 事假）→ 39
    //   t4b：原定 40；代課 +1（r6）；婚假不扣 → 41
    const li = byName(res, '李四');
    eq(li.length, 2, '同名李四兩列');
    eq(li.map(r => r.actualHours).sort((x, y) => x - y), [39, 41], '李四兩人各自的實際時數');
    eq(li.every(r => r.ambiguousName === true), true, '同名列都標示 ambiguousName');
    eq(res.length, 5, '共 5 列（4 位名冊 + 離職代課者）');
    eq(res.map(r => r.teacherName.trim()).sort(), ['李四', '李四', '林一', '王二', '趙五'].sort(), '人員集合');
    includes((res.warnings || []).join('\n'), '趙五', '警示包含不在名冊的趙五');
    includes((res.warnings || []).join('\n'), '同名', '警示包含同名教師');
});

await suite.case('A3 逐人超鐘點門檻：以 teacherId 或姓名設定，預設 20；非法值退回預設', () => {
    const run = (map) => one(calc().calculate(115, 10, sched115_1, recordsOct, roster115_1, optsFull({ weeklyBaseByTeacher: map })), '王二');
    // 王二實際 87。基本 16 節 → 門檻 16×4=64 → 超鐘點 87−64=23
    eq([run({ tB: 16 }).baseMonthlyHours, run({ tB: 16 }).overtimeHours], [64, 23], '以 teacherId 設定 16 節');
    // 以姓名設定 18 節 → 門檻 72 → 超鐘點 15
    eq([run({ '王二': 18 }).baseMonthlyHours, run({ '王二': 18 }).overtimeHours], [72, 15], '以姓名設定 18 節');
    // teacherId 優先於姓名：tB=10、姓名=18 → 用 10 → 門檻 40 → 87−40=47
    eq(run({ tB: 10, '王二': 18 }).overtimeHours, 47, 'teacherId 優先');
    // 非法值（字串、負數、空）退回預設 20 → 超鐘點 7
    for (const bad of ['abc', -5, '', null]) eq(run({ tB: bad }).overtimeHours, 7, `非法值 ${JSON.stringify(bad)} 退回預設`);
    // 設 0 節（兼課）：門檻 0 → 超鐘點 = 實際 87
    eq(run({ tB: 0 }).overtimeHours, 87, '0 節 = 全部算超鐘點');
    // 沒有設定的人不受影響：林一仍是 70−80 → 0
    const all = calc().calculate(115, 10, sched115_1, recordsOct, roster115_1, optsFull({ weeklyBaseByTeacher: { tB: 16 } }));
    eq(one(all, '林一').baseMonthlyHours, 80, '未設定的人門檻仍 80');
    // 文字格式：每行「姓名,節數」
    const p = parseBaseMapText('王二,16\n李四，12\n\n陳 五 , 14.5');
    eq(p.map, { '王二': 16, '李四': 12, '陳 五': 14.5 }, '解析');
    eq(p.errors.length, 0, '無錯誤');
    eq(parseBaseMapText('王二').errors.length, 1, '缺節數');
    eq(parseBaseMapText('王二,99').errors.length, 1, '超過 40 節');
    eq(formatBaseMapText({ '王二': 16 }), '王二,16', '輸出格式');
});

await suite.case('A4 名冊同名重複與前後空白：同一人不重複計、姓名正規化後比對', () => {
    // 名冊「方小生」「方小生 」（沒有 id）是同一人 → 一列。課表 10 節、紀錄姓名帶空白。
    // 手算：10 週 4 → 原定 40；被代課扣 1 → 39
    const sched = rows('方小生', 10);
    const recs = [rec({ date: '2026-10-05', originalTeacher: ' 方小生 ', substituteTeacher: '方小生　', leaveType: 'personal' })];
    const res = calc().calculate(115, 10, sched, recs, [{ name: '方小生' }, { name: '方小生 ' }], optsFull());
    eq(res.length, 1, '只有一列');
    // 自己代自己（紀錄兩側同一人）：代課 +1、被代課 −1 → 40
    eq([res[0].originalHours, res[0].substituteHours, res[0].substitutedHours, res[0].actualHours], [40, 1, 1, 40], '同一人兩側');
});

await suite.case('A5 同名教師且紀錄沒有 teacherId：另列一行並警示，不默默併入任一位', () => {
    const roster = [{ name: '李四', teacherId: 't4a' }, { name: '李四', teacherId: 't4b' }];
    const recs = [rec({ date: '2026-10-05', originalTeacher: '李四', substituteTeacher: '林一', leaveType: 'personal' })];
    const res = calc().calculate(115, 10, rows('李四', 10), recs, roster, optsFull());
    // 兩位李四都沒被扣（各 40），另有一行「李四」（無法判斷是誰）被代課 1、實際 max(0,0−1)=0
    const amb = res.filter(r => r.notInRoster && r.teacherName === '李四');
    eq(amb.length, 1, '無法判斷的李四另列一行');
    eq(amb[0].substitutedHours, 1, '被代課 1 節記在該行');
    eq(res.filter(r => !r.notInRoster).map(r => r.actualHours), [40, 40], '兩位李四都不被誤扣');
    includes(res.warnings.join('\n'), '沒有 teacherId', '警示說明');
});

await suite.case('B1 審計 repro-03 改寫：結算上學期 1 月，用 115-1 的課表與名冊，離職代課者不消失', async () => {
    // 115-1：王老師 20 節、趙老師（之後離職）16 節。115-2（目前學期）：王老師 16 節、趙老師不在。
    // 2027-01（屬 115-1，預設 2 週）：趙老師代王老師 3 節事假（2027-01-05～07）。
    // 手算（用 115-1）：王 原定 20×2=40，被代 3 → 37，門檻 20×2=40 → 超鐘點 0；趙 原定 16×2=32，代課 +3 → 35，超鐘點 0。
    // 修前（用目前學期 115-2）：王 16×2=32−3=29，趙老師整列消失。
    const s1 = [...rows('王老師', 20), ...rows('趙老師', 16, '802')];
    const s2 = [...rows('王老師', 16)];
    const records = [5, 6, 7].map(d => rec({ date: `2027-01-0${d}`, period: '第一節', originalTeacher: '王老師', substituteTeacher: '趙老師', leaveType: '事假' }));
    const calls = [];
    const dm = {
        async getSubstituteRecordsAsync(...a) { calls.push(['records', ...a]); return records; },
        async getSettlementSemesterData(sid) {
            calls.push(['semester', sid]);
            if (sid === '115-1') return { semesterId: sid, schedule: s1, teachers: [{ name: '王老師' }, { name: '趙老師' }] };
            if (sid === '115-2') return { semesterId: sid, schedule: s2, teachers: [{ name: '王老師' }] };
            return null;
        },
    };
    const c = calc();
    const { records: got, opts, semesterId } = await prepareSettlementInputs({ calculator: c, dataManager: dm, year: 115, month: 1, applyConfig: async () => null });
    eq(semesterId, '115-1', '2027-01 屬 115-1');
    eq(calls[0], ['records', '2027-01-01', '2027-01-31', '', { fresh: true }], '紀錄查詢帶 fresh:true（不吃快取）');
    eq(calls[1], ['semester', '115-1'], '只取 115-1 一份課表');
    const res = c.calculate(115, 1, opts.segments[0].schedule, got, opts.segments[0].teachers, opts);
    const w = one(res, '王老師'), z = one(res, '趙老師');
    eq([w.originalHours, w.substitutedHours, w.actualHours, w.overtimeHours], [40, 3, 37, 0], '王老師用 115-1 課表');
    eq([z.originalHours, z.substituteHours, z.actualHours, z.overtimeHours], [32, 3, 35, 0], '趙老師不消失');
    // 該學期沒有課表：明確丟錯，不退回其他學期
    const dm2 = { ...dm, async getSettlementSemesterData() { return null; } };
    let err = null;
    try { await prepareSettlementInputs({ calculator: calc(), dataManager: dm2, year: 115, month: 1, applyConfig: async () => null }); } catch (e) { err = e; }
    eq([err?.name, err?.semesterId], ['SettlementScheduleMissing', '115-1'], '學期課表不存在要明確警示');
});

await suite.case('B2 月份所屬學期：8～1 月上學期、2～7 月下學期；週數與門檻隨覆寫', async () => {
    const seen = [];
    const dm = { async getSubstituteRecordsAsync() { return []; }, async getSettlementSemesterData(sid) { seen.push(sid); return { semesterId: sid, schedule: rows('甲', 1), teachers: [] }; } };
    for (const [y, m] of [[115, 8], [115, 12], [115, 1], [115, 2], [115, 7]]) {
        await prepareSettlementInputs({ calculator: calc(), dataManager: dm, year: y, month: m, applyConfig: async () => null });
    }
    // 115 學年度：8 月→115-1、12 月→115-1、1 月（2027）→115-1、2 月→115-2、7 月→115-2
    eq(seen, ['115-1', '115-1', '115-1', '115-2', '115-2'], '各月份所屬學期');
});

await suite.case('B3 跨學期分段：各段用各自的課表與名冊，原定時數依週數加總', () => {
    // 分段 1：週數 2，王 20 節；分段 2：週數 2，王 10 節（另一學期課表）。
    // 手算：原定 20×2 + 10×2 = 60；總週數 4 → 門檻 20×4=80；實際 60；超鐘點 0。
    const segs = [
        { semesterId: '115-1', schedule: rows('王', 20), teachers: [{ name: '王' }], weeks: 2 },
        { semesterId: '115-2', schedule: rows('王', 10), teachers: [{ name: '王' }], weeks: 2 },
    ];
    const res = calc().calculate(115, 1, null, [], null, { segments: segs });
    eq([res[0].originalHours, res[0].baseMonthlyHours, res[0].actualHours, res[0].overtimeHours], [60, 80, 60, 0], '兩段加總');
    // 第 2 段只有名冊沒有的人（離職）：趙只在分段 1，王兩段都有。趙：16×2=32
    const segs2 = [
        { schedule: [...rows('王', 20), ...rows('趙', 16, '702')], teachers: [{ name: '王' }, { name: '趙' }], weeks: 2 },
        { schedule: rows('王', 10), teachers: [{ name: '王' }], weeks: 3 },
    ];
    const r2 = calc().calculate(115, 1, null, [], null, { segments: segs2 });
    // 王：20×2+10×3=70（門檻 20×5=100）；趙：16×2=32
    eq([one(r2, '王').originalHours, one(r2, '王').baseMonthlyHours, one(r2, '趙').originalHours], [70, 100, 32], '3 週與離職者');
    // 段缺課表：明確丟錯
    let err = null;
    try { calc().calculate(115, 1, null, [], null, { segments: [{ semesterId: '115-1', schedule: null, teachers: [] }] }); } catch (e) { err = e; }
    eq(err?.name, 'SettlementScheduleMissing', '分段缺課表');
});

await suite.case('C1 假別對照表：每個假別是否扣原任課教師時數（期望值寫死，不讀對照表）', () => {
    // 每一筆都是「甲被乙代課一節」，甲原定 0（不放課表）→ 只看被代課減少欄：deducted 為 1 或 0
    const expected = {
        official: 0, longsick: 0, funeral: 0,                       // 既有，不變
        personal: 1, sick: 1, rest: 1, other: 1,                    // 既有，不變
        marriage: 0, maternity: 0, paternity: 0, injury: 0, miscarriage: 0,   // 新增：法定給薪假／公傷，公費支應
        family: 1, menstrual: 1,                                    // 新增：比照事假、病假，扣
        公假: 0, 長期病假: 0, 喪假: 0, 事假: 1, 病假: 1, 休假: 1, 其他: 1,
        婚假: 0, 產假: 0, 陪產假: 0, 公傷假: 0, 流產假: 0, 家庭照顧假: 1, 生理假: 1,
        swap: 0, 調課: 0,                                           // 調課：互換，不扣
        '': 1, 未知假別: 1,                                          // 缺假別／未知：維持既有行為（扣）
    };
    for (const [leaveType, deducted] of Object.entries(expected)) {
        const res = calc().calculate(115, 10, rows('乙', 1), [rec({ date: '2026-10-05', originalTeacher: '甲', substituteTeacher: '乙', leaveType })], [{ name: '甲' }, { name: '乙' }], optsFull());
        eq(one(res, '甲').substitutedHours, deducted, `假別「${leaveType}」被代課減少`);
    }
    // 對照表本身：每個代碼都有中文名稱、不重複，且與上面寫死的期望一致
    const codes = LEAVE_TYPES.map(t => t.code);
    eq(new Set(codes).size, codes.length, '代碼不重複');
    for (const t of LEAVE_TYPES) {
        eq(expected[t.code], t.deduct ? 1 : 0, `對照表 ${t.code} 的 deduct`);
        eq(expected[t.label], t.deduct ? 1 : 0, `對照表 ${t.label} 的 deduct`);
    }
    eq(codes.length, 14, '共 14 種假別（既有 7 + 新增 7）');
});

await suite.case('C2 getDetailedSettlement 的扣減與公付統計包含新假別，既有欄位不變', () => {
    // 林一被代課：事假 1（扣）、家庭照顧假 1（扣）、婚假 1（不扣）、公假 1（不扣）→ deducted 2、paid 2
    const recs = ['personal', 'family', 'marriage', 'official'].map(lt => rec({ date: '2026-10-05', originalTeacher: '林一', substituteTeacher: '乙', leaveType: lt }));
    const d = calc().getDetailedSettlement(recs, '林一');
    eq([d.deductedHours, d.paidLeaveCount], [2, 2], '扣 2、公付 2');
    eq(Object.keys(d.substitutedByLeaveType).sort(), ['funeral', 'longsick', 'official', 'other', 'personal', 'rest', 'sick', 'swap'].sort(), '既有欄位集合不變');
});

await suite.case('D1 行事曆：「不放假」不算放假、部分年級停課不扣全校週數、全校停課照扣', () => {
    const ad = (summary, a, b) => ({ summary, start: { date: a }, end: { date: b } });
    const base = [ad('正式上課', '2026-09-07', '2026-09-08'), ad('休業式', '2026-09-25', '2026-09-26')];
    // 學期 9/7(一)–9/25(五)：9/7、9/14、9/21 三週。
    const wk = (title) => computeWeeksByMonth([...base, ad(title, '2026-09-14', '2026-09-19')], 115).weeks[9];
    eq(wk('補班日說明：本週不放假'), 3, '不放假 → 3 週（修前誤判為放假 → 2 週）');
    eq(wk('九年級畢旅停課'), 3, '九年級停課 → 全校仍 3 週（修前 2 週）');
    eq(wk('七、八年級校外教學停課'), 3, '七八年級停課 → 3 週');
    eq(wk('全校停課'), 2, '全校停課 → 2 週（維持）');
    eq(wk('颱風假'), 2, '颱風假 → 2 週（維持）');
    eq(wk('國慶日放假'), 2, '放假 → 2 週（維持）');
    eq(wk('九年級畢旅，其餘年級全校停課'), 2, '標題寫明全校 → 視為放假');
    eq(wk('寒假'), 3, '寒假仍不算放假（維持）');
    const r = computeWeeksByMonth([...base, ad('九年級畢旅停課', '2026-09-14', '2026-09-19')], 115);
    eq(r.partialClosures.map(x => x.title), ['九年級畢旅停課'], '部分年級停課列出供人工確認');
    eq([isHolidayTitle('不放假'), isHolidayTitle('照常上課'), isHolidayTitle('補假')], [false, false, true], 'isHolidayTitle');
});

await suite.case('E1 九年級畢業設定：只在設定的學期有效、可設生效日期（邏輯）', () => {
    const cfg = { semesterId: '115-1', enabled: true, effectiveDate: '2026-06-20' };
    // 設定於 115-1；生效日 2026-06-20
    eq(isGrade9GraduationActive(cfg, '115-1', '2026-06-19'), false, '生效日前一天未生效');
    eq(isGrade9GraduationActive(cfg, '115-1', '2026-06-20'), true, '生效日當天生效');
    eq(isGrade9GraduationActive(cfg, '115-1', '2026-09-01'), true, '之後持續生效');
    eq(isGrade9GraduationActive(cfg, '115-2', '2027-03-01'), false, '換到 115-2 自動失效');
    eq(isGrade9GraduationActive({ ...cfg, effectiveDate: '' }, '115-1', '2026-01-01'), true, '沒設日期＝立即生效');
    eq(isGrade9GraduationActive({ ...cfg, enabled: false }, '115-1', '2026-09-01'), false, '關閉');
    eq(isGrade9GraduationActive(null, '115-1', '2026-09-01'), false, '沒有設定');
    eq(isGrade9GraduationActive(cfg, null, '2026-09-01'), false, '學期未知不啟用');
    eq(buildGrade9Config('115-1', true, ' 2026-06-20 '), { semesterId: '115-1', enabled: true, effectiveDate: '2026-06-20' }, '組設定');
    let err = null; try { buildGrade9Config('115-1', true, '6/20'); } catch (e) { err = e; }
    ok(!!err, '日期格式不對要丟錯');
});

// ---------- G. 獨立驗收補修（2026-11-15）：先寫的紅燈測試 ----------
import { createRequire } from 'node:module';
const XLSXLIB = createRequire(import.meta.url)('xlsx');

await suite.case('G1 該學期課表不存在或是空殼：都丟 SettlementScheduleMissing，不產生全 0 的結算', async () => {
    const mk = (data) => ({ async getSubstituteRecordsAsync() { return []; }, async getSettlementSemesterData() { return data; } });
    // 預期：不存在（null）與空殼（schedule 長度 0）走同一條中止路徑，且帶 semesterId（2027-03 屬 114-2）
    for (const [label, data] of [['不存在', null], ['空殼', { semesterId: '114-2', schedule: [], teachers: [{ name: '甲' }] }]]) {
        let err = null;
        try { await prepareSettlementInputs({ calculator: calc(), dataManager: mk(data), year: 114, month: 3, applyConfig: async () => null }); } catch (e) { err = e; }
        eq([label, err?.name, err?.semesterId], [label, 'SettlementScheduleMissing', '114-2'], `${label}要中止`);
    }
    const okr = await prepareSettlementInputs({ calculator: calc(), dataManager: mk({ schedule: rows('甲', 3), teachers: [] }), year: 114, month: 3, applyConfig: async () => null });
    eq(okr.semesterId, '114-2', '有課表正常');
});

await suite.case('G2 名冊沒有 id、同名兩位、某筆紀錄缺 teacherId：不歸給任何一位，另列一行並警示', () => {
    // 課表 李四 20 節 → 每人原定 20×4=80。名冊來自課表：只有一筆「李四」沒有 id。
    // 紀錄（皆 2026-10、事假，乙代課）：a 李四 t4a、b 李四 t4b、c 李四（沒有 id）。
    // 名冊只有一筆李四（沒有 id）、紀錄出現兩個 teacherId：課表節數只計入一列（紀錄中最先出現的 t4a），不重複計入（P7 補修）。
    // 手算：t4a 80−1=79；t4b 原定 0、被代課 1 → max(0,0−1)=0；無法判斷的一行：原定 0、被代課 1、實際 0；乙 +3。
    // 紀錄順序換一種（缺 id 的先出現）結果必須相同。
    const a = rec({ date: '2026-10-05', originalTeacher: '李四', originalTeacherId: 't4a', substituteTeacher: '乙', leaveType: 'personal' });
    const b = rec({ date: '2026-10-06', originalTeacher: '李四', originalTeacherId: 't4b', substituteTeacher: '乙', leaveType: 'personal' });
    const c = rec({ date: '2026-10-07', originalTeacher: '李四', substituteTeacher: '乙', leaveType: 'personal' });
    for (const recs of [[a, b, c], [c, a, b]]) {
        const res = calc().calculate(115, 10, rows('李四', 20, '801'), recs, [{ name: '李四' }]);
        const lis = byName(res, '李四');
        eq(lis.length, 3, '李四三列：t4a、t4b、無法判斷');
        eq(lis.map(r => r.actualHours).sort((x, y) => x - y), [0, 0, 79], '持有課表那列 79、其餘兩列 0');
        eq(lis.reduce((n, r) => n + r.originalHours, 0), 80, '三列原定合計只有 80（不重複）');
        const amb = lis.find(r => r.unresolved);
        eq([amb.originalHours, amb.substitutedHours, amb.notInRoster, amb.unresolved], [0, 1, true, true], '無法判斷的一行');
        eq(one(res, '乙').substituteHours, 3, '乙代課 3 節');
        includes((res.warnings || []).join('\n'), '無法判斷是哪一位', '警示');
    }
});

await suite.case('G3 完全重複的隔週列（同班同節）只算 0.5 節；不同班的單雙週輪替才合計 1', () => {
    const base = { weekday: '週一', period: '第一節', teacher: '甲', frequency: 2 };
    const dup = [{ ...base, className: '701' }, { ...base, className: '701' }];
    // 手算：同一節次兩列都是隔週、同班（完全重複）→ 0.5 節；原定 0.5 × 4 週 = 2
    eq(calc().getTeacherWeeklyHours(dup, '甲'), 0.5, '完全重複隔週列 = 0.5');
    const res = calc().calculate(115, 10, dup, [], [{ name: '甲' }]);
    eq([res[0].weeklyHours, res[0].originalHours], [0.5, 2], '月結算原定 0.5×4=2');
    // 單雙週輪替（701 與 702 各隔週一次）→ 0.5+0.5 = 1；原定 1×4=4
    const alt = [{ ...base, className: '701' }, { ...base, className: '702' }];
    eq(calc().getTeacherWeeklyHours(alt, '甲'), 1, '輪替 = 1');
    eq(calc().calculate(115, 10, alt, [], [{ name: '甲' }])[0].originalHours, 4, '輪替月結算 1×4=4');
});

await suite.case('G4 行事曆：「全年級停課」「七、八、九年級停課」是全校放假，不是部分年級', () => {
    const ad = (summary, a, b) => ({ summary, start: { date: a }, end: { date: b } });
    const base = [ad('正式上課', '2026-09-07', '2026-09-08'), ad('休業式', '2026-09-25', '2026-09-26')];
    const wk = (title) => computeWeeksByMonth([...base, ad(title, '2026-09-14', '2026-09-19')], 115).weeks[9];
    // 學期 9/7–9/25 三週；該週整週停課 → 2 週。部分年級停課維持 3 週。
    eq(wk('全年級停課'), 2, '全年級停課 → 2 週');
    eq(wk('七、八、九年級停課'), 2, '七八九年級停課 → 2 週');
    eq(wk('七八九年級停課'), 2, '七八九年級停課（無頓號）→ 2 週');
    eq(wk('九年級畢旅停課'), 3, '九年級停課維持 3 週');
    eq(wk('七、八年級校外教學停課'), 3, '七八年級維持 3 週');
    eq([isHolidayTitle('全年級停課'), isHolidayTitle('七、八、九年級停課'), isHolidayTitle('九年級停課')], [true, true, false], 'isHolidayTitle');
});

await suite.case('G5 名冊外但紀錄中出現的人一律列入（不需任何開關）', () => {
    // 課表 甲 3 節、名冊只有甲；紀錄：甲事假、趙代課。手算：甲 3×4−1=11；趙（名冊外）原定 0、代課 +1、實際 1。
    const recs = [rec({ date: '2026-10-05', originalTeacher: '甲', substituteTeacher: '趙', leaveType: 'personal' })];
    const res = calc().calculate(115, 10, rows('甲', 3), recs, [{ name: '甲' }]);
    eq(one(res, '甲').actualHours, 11, '甲');
    const z = one(res, '趙');
    eq([z.actualHours, z.notInRoster], [1, true], '趙');
});

await suite.case('G6 Excel 備註欄與警示分頁：分得出名冊外、同名兩位、無法判斷', () => {
    const roster = [{ name: '李四', teacherId: 'tid-aaaa1111' }, { name: '李四', teacherId: 'tid-bbbb2222' }];
    const sched = [...rows('李四', 2, '801')];
    const recs = [
        rec({ date: '2026-10-05', originalTeacher: '李四', substituteTeacher: '趙', leaveType: 'personal' }),   // 缺 id → 無法判斷
        rec({ date: '2026-10-06', originalTeacher: '甲', substituteTeacher: '趙', leaveType: 'personal' }),     // 甲、趙名冊外
    ];
    const c = calc();
    const res = c.calculate(115, 10, sched, recs, roster);
    const wb = c.buildWorkbook(res, 115, 10, recs, XLSXLIB);
    const aoa = XLSXLIB.utils.sheet_to_json(wb.Sheets['結算表'], { header: 1 });
    eq(aoa[2][7], '備註', '表頭第 8 欄為備註');
    const noteOf = (name) => aoa.slice(3).filter(r => r[0] === name).map(r => r[7] || '');
    const notes = noteOf('李四');
    eq(notes.length, 3, '李四三列');
    eq(notes.filter(n => n.startsWith('同名')).length, 2, '兩位同名各有「同名」備註');
    ok(notes.some(n => n.includes('1111') && n.includes('801')), '含 teacherId 尾碼與任教班級');
    ok(notes.some(n => n.includes('2222')), '另一位的尾碼不同');
    eq(notes.filter(n => n.includes('無法判斷是哪一位')).length, 1, '無法判斷那行有備註');
    eq(noteOf('趙')[0].includes('名冊外'), true, '趙：名冊外');
    eq(noteOf('甲')[0].includes('名冊外'), true, '甲：名冊外');
    ok(wb.SheetNames.includes('警示'), '有警示分頁');
    const warnText = XLSXLIB.utils.sheet_to_json(wb.Sheets['警示'], { header: 1 }).flat().join('\n');
    includes(warnText, '同名', '警示分頁含同名說明');
    includes(warnText, '趙', '警示分頁含名冊外說明');
    // 沒有任何特殊列、沒有警示 → 不加備註欄、不加警示分頁（一般情況的表不變）
    const plain = c.calculate(115, 10, rows('甲', 3), [], [{ name: '甲' }]);
    const wb2 = c.buildWorkbook(plain, 115, 10, [], XLSXLIB);
    eq(wb2.SheetNames, ['結算表', '明細'], '一般情況分頁不變');
    eq(XLSXLIB.utils.sheet_to_json(wb2.Sheets['結算表'], { header: 1 })[2].length, 7, '一般情況表頭仍 7 欄');
});

await suite.case('H1 同一位教師兩個 teacherId（名冊只有一筆）：原定時數只計入一列，超鐘點不重複', () => {
    // 課表 王 25 節/週，4 週；名冊只有一筆「王」。基本節數 20 → 門檻 80。
    // 紀錄：a 王(tw) 事假、乙代課；b 王(tw2) 事假、乙代課；c 乙事假、王(tw2) 代課。
    // 手算（課表節數只掛在紀錄中最先出現的 id 那一列）。
    //   順序一（a、b、c；tw 先出現）：tw 持有：原定 25×4=100；被代課 1 → 實際 99；超鐘點 99−80=19。
    //     tw2：原定 0；代課 +1（c）、被代課 −1（b）→ 實際 max(0, 0+1−1)=0；超鐘點 0。超鐘點合計 19。
    //   順序二（c、b、a；tw2 先出現）：tw2 持有：原定 100；代課 +1、被代課 1 → 實際 100；超鐘點 20。
    //     tw：原定 0；被代課 1 → 實際 max(0,−1)=0；超鐘點 0。超鐘點合計 20。
    //   兩種順序全校王的原定合計都是 100（不是 200）；拆列重複計入時超鐘點會多算一份（約 38～40）。
    const mk = (id, d) => rec({ date: d, originalTeacher: '王', originalTeacherId: id, substituteTeacher: '乙', leaveType: 'personal' });
    const c = rec({ date: '2026-10-08', originalTeacher: '乙', substituteTeacher: '王', substituteTeacherId: 'tw2', leaveType: 'personal' });
    const warnPart = '在本月紀錄中有多個教師編號，可能是同一位教師重新建檔。原定時數只計入其中一列，請確認並合併後再發放。';
    for (const [recs, holderActual, overtimeTotal] of [[[mk('tw', '2026-10-05'), mk('tw2', '2026-10-06'), c], 99, 19], [[c, mk('tw2', '2026-10-06'), mk('tw', '2026-10-05')], 100, 20]]) {
        const res = calc().calculate(115, 10, rows('王', 25), recs, [{ name: '王' }]);
        const w = byName(res, '王');
        eq(w.length, 2, '王兩列（兩個 teacherId）');
        eq(w.reduce((n, r) => n + r.originalHours, 0), 100, '全校原定時數合計不因拆列增加');
        eq(w.reduce((n, r) => n + r.overtimeHours, 0), overtimeTotal, '超鐘點合計只算一次');
        const holder = w.filter(r => r.originalHours === 100);
        eq(holder.length, 1, '只有一列帶課表節數');
        eq(holder[0].actualHours, holderActual, '持有課表那列實際時數');
        const other = w.find(r => r.originalHours === 0);
        eq([other.actualHours, other.overtimeHours], [0, 0], '另一列原定 0、實際 0（只列代課與被代課）');
        eq(w.every(r => r.multiId === true), true, '所有列標示 multiId');
        includes((res.warnings || []).join('\n'), '「王」' + warnPart, '警示全文');
        eq((res.warnings || []).filter(x => x.includes('多個教師編號')).length, 1, '同一姓名只警示一次');
        const wb = calc().buildWorkbook(res, 115, 10, recs, XLSXLIB);
        const aoa = XLSXLIB.utils.sheet_to_json(wb.Sheets['結算表'], { header: 1 });
        const notes = aoa.slice(3).filter(r => r[0] === '王').map(r => r[7] || '');
        eq(notes.length === 2 && notes.every(n => n.includes('多個教師編號')), true, 'Excel 兩列備註都標示');
        eq(notes.filter(n => n.includes('只計入此列')).length, 1, 'Excel 標出持有原定時數的那一列');
    }
    // 名冊帶 id（tw）、紀錄另出現 tw2：課表節數掛在名冊那筆（tw），tw2 為 0，並警示
    const rosterId = [{ name: '王', teacherId: 'tw' }];
    const res2 = calc().calculate(115, 10, rows('王', 25), [mk('tw', '2026-10-05'), mk('tw2', '2026-10-06')], rosterId);
    const h = byName(res2, '王');
    eq(h.map(r => r.originalHours).sort((x, y) => x - y), [0, 100], '名冊 id 那列持有原定時數');
    eq(h.find(r => r.originalHours === 100).teacherId, 'tw', '掛在名冊對得上的 id');
    includes((res2.warnings || []).join('\n'), '多個教師編號', '名冊帶 id 也警示');
    // 只有一個 teacherId：不警示、單列（一般情況不變）
    const res3 = calc().calculate(115, 10, rows('王', 25), [mk('tw', '2026-10-05')], [{ name: '王' }]);
    eq(byName(res3, '王').length, 1, '單一 id 單列');
    eq((res3.warnings || []).some(x => x.includes('多個教師編號')), false, '單一 id 不警示');
});

await suite.case('H2 「無法判斷是哪一位」那一列不再同時被警示為「不在名冊內」', () => {
    // 名冊兩位李四；一筆紀錄缺 teacherId 被代課 1 節 → 另列一行（原定 0、被代 1）。李四在名冊內，不得被說不在名冊。
    const roster = [{ name: '李四', teacherId: 't4a' }, { name: '李四', teacherId: 't4b' }];
    const recs = [rec({ date: '2026-10-05', originalTeacher: '李四', substituteTeacher: '林一', leaveType: 'personal' })];
    const res = calc().calculate(115, 10, rows('李四', 10), recs, roster);
    const txt = (res.warnings || []).join('\n');
    includes(txt, '無法判斷是哪一位', '仍有無法判斷的警示');
    ok(!txt.includes('「李四」不在名冊內'), '不應出現「李四」不在名冊內');
    includes(txt, '「林一」不在名冊內', '真正名冊外的林一仍警示');
});

await suite.case('H3 缺課表提示：過去學期＝無法補匯入；未來學期＝尚未開始；目前學期＝請先匯入', () => {
    const e = (sid) => ({ name: 'SettlementScheduleMissing', semesterId: sid });
    includes(settlementMissingMessage(e('113-2'), '115-1'), '歷史學期的課表無法補匯入', '過去學期');
    const fut = settlementMissingMessage(e('115-2'), '115-1');
    includes(fut, '該學期尚未開始，沒有課表可計算', '未來學期');
    ok(!fut.includes('歷史學期'), '未來學期不可說歷史學期');
    includes(settlementMissingMessage(e('116-1'), '115-1'), '尚未開始', '次學年度也是未來');
    includes(settlementMissingMessage(e('115-1'), '115-1'), '請先匯入該學期課表', '目前學期');
    includes(settlementMissingMessage(e('115-1'), null), '請先匯入該學期課表', '沒有學期概念');
});

await suite.case('H4 課表教師數遠少於名冊：加警示、不中止、數字不變；不到一半才警示', () => {
    // 名冊 10 位、課表只有 3 位（3×2=6 < 10）→ 警示。數字：甲 3 節 × 4 週 = 12。
    const roster = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'].map(name => ({ name }));
    const sched = [...rows('甲', 3), ...rows('乙', 3, '702', 10), ...rows('丙', 3, '703', 20)];
    const res = calc().calculate(115, 10, sched, [], roster);
    includes((res.warnings || []).join('\n'), '該學期課表的教師數明顯少於名冊，原定時數可能不完整，請確認課表', '殘缺課表警示');
    eq(one(res, '甲').originalHours, 12, '照算，不改數字');
    eq(res.length, 10, '名冊 10 人都在');
    // 名冊 4 位、課表 3 位（3×2=6 ≥ 4）→ 不警示
    const res2 = calc().calculate(115, 10, sched, [], roster.slice(0, 4));
    eq((res2.warnings || []).some(x => x.includes('明顯少於名冊')), false, '不到一半以外不警示');
    // 剛好一半（名冊 6、課表 3）→ 不警示
    const res3 = calc().calculate(115, 10, sched, [], roster.slice(0, 6));
    eq((res3.warnings || []).some(x => x.includes('明顯少於名冊')), false, '剛好一半不警示');
});

// ---------- F. 核准時讀不到私有明細：中止，不吞掉 ----------
const req = await import('../src/js/modules/v2/pendingRequestService.js');
const roleSvc = await import('../src/js/modules/v2/roleService.js');
const semesterState = await import('../src/js/modules/v2/semesterState.js');
const { SCHEMA_PATHS } = await import('../src/js/modules/v2/schemaConstants.js');
semesterState.setCurrentSemesterId('115-1');
const realLog = console.log, realWarn = console.warn, realErr = console.error;
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.log = realLog; console.warn = realWarn; console.error = realErr; };
const putReq = (id, date = '2026-12-04', swapDate = '2026-12-11') => F.docs.set(SCHEMA_PATHS.pendingDoc(id), {
    type: '調課', requestType: 'swap', status: 'pending_approval', date, weekday: '週五', period: '第三節', className: '801',
    originalTeacher: '王老師', swapDate, swapWeekday: '週五', swapPeriod: '第二節', swapTeacher: '林老師',
    initiatedBy: 't_wang', pendingConsentTeacherIds: [], swapConsents: {}, semesterId: '115-1', createdAt: '2026-11-14T00:00:00.000Z',
});

await suite.case('F1 核准時讀私有明細失敗：中止核准、不建立紀錄、申請維持待核准（公假不會被當成沒有假別）', async () => {
    quiet();
    try {
        F.docs.clear(); F.writes.length = 0;
        roleSvc.setCurrentIdentity({ uid: 'u_c', email: 'c@x', teacherId: 't_chief', name: '組長', role: 'section_chief' });
        putReq('rq1');
        F.docs.set(SCHEMA_PATHS.pendingDetailDoc('rq1'), { leaveType: 'official', leaveTypeName: '公假', reason: '研習', allowedTeacherIds: ['t_wang'] });
        const netErr = Object.assign(new Error('network down'), { code: 'unavailable' });
        F.getDocErrors = { [SCHEMA_PATHS.pendingDetailDoc('rq1')]: netErr };
        let err = null;
        try { await req.approveRequest('rq1'); } catch (e) { err = e; }
        eq(err?.code, 'DETAIL_READ_FAILED', '丟出明確錯誤代碼');
        includes(err?.message || '', '中止核准', '訊息說明已中止');
        eq(F.docs.get(SCHEMA_PATHS.pendingDoc('rq1')).status, 'pending_approval', '申請仍待核准');
        eq(F.writes.some(w => w.path.includes('/substituteRecords/')), false, '沒有建立任何紀錄或明細');
        // 讀取恢復後可以核准，且假別明細被帶到新紀錄
        F.getDocErrors = null;
        const saved = await req.approveRequest('rq1');
        eq(F.docs.get(SCHEMA_PATHS.substituteDetailDoc(saved.recordId))?.leaveType, 'official', '新紀錄帶有 leaveType=official');
        // 申請本來就沒有明細（文件不存在）→ 仍可核准，不誤判成讀取失敗
        putReq('rq2', '2026-12-18', '2026-12-25');
        const saved2 = await req.approveRequest('rq2');
        ok(!!saved2.recordId, '沒有明細的申請可核准');
    } finally { F.getDocErrors = null; loud(); }
});

suite.print();
process.exit(suite.failed ? 1 : 0);
