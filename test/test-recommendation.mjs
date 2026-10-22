/**
 * 代課推薦引擎單元測試：五層順序（同科目 → 班導師 → 同任課班級 → 空堂 → 兼課）與候選名單完整性
 * 執行：node test/test-recommendation.mjs
 */
import { RecommendationEngine, findTeacherConflict } from '../src/js/modules/recommendationEngine.js';

console.log = () => {}; // 引擎本身有大量 debug log，測試時靜音
let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

const c = (teacher, weekday, period, className, subject, domain = '') =>
    ({ teacher, weekday, period, className, subject, rawSubject: subject, domain });

// 目標：週一第一節 7年1班 數學（原任課：原師）
const schedule = [
    c('原師', '星期一', '第一節', '7年1班', '數學', '數學領域'),
    c('忙碌', '星期一', '第一節', '7年2班', '國文', '語文領域'),      // 該節有課 → 排除
    c('數甲', '星期一', '第二節', '7年3班', '數學', '數學領域'),      // 同科目
    c('導師', '星期一', '第二節', '8年1班', '英語', '語文領域'),      // 班導師（教師屬性）
    c('同班', '星期二', '第一節', '7年1班', '歷史', '社會領域'),      // 同任課班級
    c('空堂', '星期二', '第二節', '9年1班', '地理', '社會領域'),      // 一般空堂
    c('兼數', '星期三', '第一節', '8年2班', '數學', '數學領域'),      // 兼課 + 同科目 → 仍排最後層
    c('兼課', '星期三', '第二節', '8年3班', '音樂', '藝術領域'),      // 兼課
    c('數導', '星期四', '第一節', '7年1班', '數學', '數學領域'),      // 同科目 + 導師 + 同班
    c('名單外', '星期五', '第一節', '9年2班', '理化', '自然科學領域') // 不在教師名單、只在課表
];
const teachers = [
    { name: '原師', domains: ['數學領域'], homeroomClass: '' },
    { name: '忙碌', domains: ['語文領域'], homeroomClass: '' },
    { name: '數甲', domains: ['數學領域'], homeroomClass: '' },
    { name: '導師', domains: ['語文領域'], homeroomClass: '7年1班' },
    { name: '同班', domains: ['社會領域'], homeroomClass: '' },
    { name: '空堂', domains: ['社會領域'], homeroomClass: '' },
    { name: '兼數', domains: ['數學領域'], homeroomClass: '', partTime: true },
    { name: '兼課', domains: ['藝術領域'], homeroomClass: '', partTime: true },
    { name: '數導', domains: ['數學領域'], homeroomClass: '7年1班' },
    { name: '無課表', domains: [], homeroomClass: '' }                 // 名單上但課表無課 → 也算空堂
];
const target = { weekday: '星期一', period: '第一節', className: '7年1班', subject: '數學', domain: '數學領域', originalTeacher: '原師' };

const engine = new RecommendationEngine();
const recs = engine.getRecommendations(target, schedule, teachers, '2026-09-21', []);
const names = recs.map(r => r.teacher.name);
const tagsOf = n => recs.find(r => r.teacher.name === n)?.tags || [];

check('排除原任課教師與該節有課者', !names.includes('原師') && !names.includes('忙碌'), names.join(','));
check('只在課表、不在名單的教師也列出', names.includes('名單外'), names.join(','));
check('名單上但課表無課的教師也列出', names.includes('無課表'), names.join(','));
check('候選總數 = 全部教師 - 原師 - 忙碌', recs.length === 9, `實得 ${recs.length}`);

// 空堂層內三人條件相同，依姓名（zh-Hant）排序
const freeTier = ['名單外', '無課表', '空堂'].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
const expected = ['數導', '數甲', '導師', '同班', ...freeTier, '兼數', '兼課'];
check('排序符合 同科目→班導師→同任課班級→空堂→兼課', JSON.stringify(names) === JSON.stringify(expected),
    `\n    實得 ${names.join(' > ')}\n    預期 ${expected.join(' > ')}`);

check('數導 標記同科目+班導師+同任課班級',
    ['same_subject', 'homeroom', 'same_class'].every(t => tagsOf('數導').includes(t)), tagsOf('數導').join(','));
check('導師 也教 7年1班？否 → 只有班導師', tagsOf('導師').join() === 'homeroom', tagsOf('導師').join(','));
check('同班 標記同任課班級', tagsOf('同班').includes('same_class'));
check('兼數 同時標記同科目與兼課', tagsOf('兼數').includes('same_subject') && tagsOf('兼數').includes('part_time'));
check('兼數 主要理由為同科目', recs.find(r => r.teacher.name === '兼數').reason === 'same_subject');
check('空堂 主要理由為 free', recs.find(r => r.teacher.name === '空堂').reason === 'free');

// 已被指派代課者排除
const recs2 = engine.getRecommendations(target, schedule, teachers, '2026-09-21',
    [{ date: '2026-09-21', period: '第一節', substituteTeacher: '數甲' }]);
check('當日該節已被指派代課的教師排除', !recs2.some(r => r.teacher.name === '數甲'));

// 任教領域欄手動填科目名也算同科目（例如只填「數學」而課表沒教數學）
const recs3 = engine.getRecommendations(target, schedule,
    teachers.map(t => t.name === '空堂' ? { ...t, domains: ['數學'] } : t), '2026-09-21', []);
check('任教領域欄填科目名 → 視為同科目', recs3.find(r => r.teacher.name === '空堂').tags.includes('same_subject'));

// 姓名前後空白不應造成重複或漏排除
const recs4 = engine.getRecommendations(target,
    [...schedule, c('忙碌 ', '星期一', '第一節', '7年4班', '國文')],
    [...teachers, { name: ' 數甲', domains: [], homeroomClass: '' }], '2026-09-21', []);
check('姓名空白不造成重複候選', recs4.filter(r => r.teacher.name.trim() === '數甲').length === 1);

// ===== (5) 公平性：本月已代節數 tie-break =====
const subRec = (teacher, date, extra = {}) =>
    ({ id: `${teacher}-${date}-${Math.random()}`, type: '代課', date, period: '第三節', substituteTeacher: teacher, ...extra });
const monthRecs = [
    subRec('空堂', '2026-09-02'), subRec('空堂', '2026-09-03'),
    subRec('空堂', '2026-09-04', { status: 'approved' }),
    subRec('空堂', '2026-09-05', { status: 'pending_approval' }),   // 未成立不算
    subRec('空堂', '2026-08-31'),                                    // 別的月份不算
    subRec('空堂', '2026-09-06', { type: '調課' }),                  // 非代課不算
    subRec('無課表', '2026-09-02')
];
const recsF = engine.getRecommendations(target, schedule, teachers, '2026-09-21', [], monthRecs);
const pos = n => recsF.findIndex(r => r.teacher.name === n);
check('(a) 空堂本月已代 3 節（只算已成立的代課、同月）', recsF[pos('空堂')].monthlyCount === 3, String(recsF[pos('空堂')].monthlyCount));
check('(a) 同層候選：本月代課較少者（無課表 1 節）排在較多者（空堂 3 節）前面', pos('無課表') < pos('空堂'));
check('(a) 未提供本月紀錄時退回姓名排序（無公平性）', (() => {
    const r = engine.getRecommendations(target, schedule, teachers, '2026-09-21', []);
    return r.findIndex(x => x.teacher.name === '空堂') < r.findIndex(x => x.teacher.name === '無課表');
})());
check('reasonText 顯示「本月已代 N 節」與「本月未代課」',
    recsF[pos('空堂')].reasonText.includes('本月已代 3 節') && recsF[pos('數甲')].reasonText.includes('本月未代課'));
// (b) 低層級候選本月代 0 節，也不得超越高層級（代很多節）的候選
const heavy = Array.from({ length: 20 }, (_, i) => subRec('數導', `2026-09-${String(i + 1).padStart(2, '0')}`));
const recsB = engine.getRecommendations(target, schedule, teachers, '2026-09-21', [], heavy);
const posB = n => recsB.findIndex(r => r.teacher.name === n);
check('(b) 公平性不壓過層級：數導(同科目+導師+同班)代 20 節仍排在數甲(同科目)與空堂(0 節)前',
    posB('數導') < posB('數甲') && posB('數甲') < posB('空堂'));
check('(b) 兼課層仍在最後（本月 0 節的兼課不超越代很多的一般空堂）',
    posB('兼課') > posB('數導') && posB('兼課') > posB('空堂'));
check('分數不受公平性影響', recsB[posB('數導')].score === recs.find(r => r.teacher.name === '數導').score);

// ===== (6) getMergeOptions =====
const mergeSchedule = [
    c('原師', '星期一', '第一節', '7年1班', '數學'),
    c('甲', '星期一', '第一節', '8年1班', '英語'),
    c('乙', '星期一', '第一節', '7年2班', '國文'),
    c('丙', '星期一', '第一節', '7年3班', '數學'),
    c('丁', '星期一', '第二節', '7年4班', '數學')      // 不同節 → 排除
];
const mergeOpts = engine.getMergeOptions({ ...target }, mergeSchedule);
check('(c) 併班候選排除原任課教師與不同節者', mergeOpts.map(o => o.teacher).join(',') === '丙,乙,甲', mergeOpts.map(o => o.teacher).join(','));
check('(c) 同年級優先於他年級，同年級中同科目優先', mergeOpts[0].teacher === '丙' && mergeOpts[0].sameSubject && mergeOpts[2].teacher === '甲' && !mergeOpts[2].sameGrade);

// ===== (7) 共用衝堂函式 =====
const cf = (name, extra = {}) => findTeacherConflict({
    teacherName: name, date: '2026-09-21', weekday: '星期一', period: '第一節',
    scheduleData: schedule, records: [], ...extra });
check('(d) 該節有課 → kind teaching', cf('忙碌')?.kind === 'teaching' && cf('忙碌').detail.className === '7年2班');
const covRecs = [{ id: 'r1', date: '2026-09-21', period: '第一節', substituteTeacher: '空堂', className: '7年9班' },
                 { id: 'r2', date: '2026-09-21', period: '第一節', swapTeacher: '無課表', className: '7年8班' }];
check('(d) 同日同節已代課 → kind covering（role 代課）', cf('空堂', { records: covRecs })?.kind === 'covering' && cf('空堂', { records: covRecs }).role === '代課');
check('(d) 同日同節調課 → kind covering（role 調課）', cf('無課表', { records: covRecs })?.role === '調課');
check('(d) 排除自身 id 後無衝突；不同日／無衝突回傳 null',
    cf('空堂', { records: covRecs, excludeRecordId: 'r1' }) === null && cf('空堂', { records: covRecs, date: '2026-09-22' }) === null);
check('(d) 推薦過濾與共用函式一致：已代課者被排除', !engine.getRecommendations(target, schedule, teachers, '2026-09-21', covRecs).some(r => r.teacher.name === '空堂'));


if (failed) { process.stdout.write(`\n${failed} 項失敗\n`); process.exit(1); }
process.stdout.write('\n全部通過\n');
