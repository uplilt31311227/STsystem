/**
 * 代課推薦引擎單元測試：五層順序（同科目 → 班導師 → 同任課班級 → 空堂 → 兼課）與候選名單完整性
 * 執行：node test/test-recommendation.mjs
 */
import { RecommendationEngine } from '../src/js/modules/recommendationEngine.js';

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

if (failed) { process.stdout.write(`\n${failed} 項失敗\n`); process.exit(1); }
process.stdout.write('\n全部通過\n');
