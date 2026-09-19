/**
 * 多節代課 PDF：班級聯依班級拆開（每班一張、只含該班節次）
 * 執行：node test/test-pdf-class-sheets.mjs
 */
import { PDFGenerator } from '../src/js/modules/pdfGenerator.js';

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

const gen = new PDFGenerator();
const rec = (period, className) => ({ period, className, subject: '數學', originalTeacher: '王老師', substituteTeacher: '李老師' });
const records = [rec('第一節', '7年1班'), rec('第三節', '7年2班'), rec('第五節', '8年1班')];
const courses = records.map(r => ({ ...r }));

const sheets = gen.getMultiCourseClassSheets(records, courses, '王老師');
check('三個班 → 三張班級聯', sheets.length === 3, `實得 ${sheets.length}`);
check('班級順序依節次', sheets.map(s => s.className).join() === '7年1班,7年2班,8年1班');
check('每張只含自己班的紀錄與課程',
    sheets.every(s => s.records.length === 1 && s.records[0].className === s.className
        && s.courses.length === 1 && s.courses[0].className === s.className));
check('標籤仍為「班級聯」（沿用班級聯的欄位網底規則）', sheets.every(s => s.label === '班級聯'));

const same = [rec('第一節', '7年1班'), rec('第二節', '7年1班')];
const sameSheets = gen.getMultiCourseClassSheets(same, same, '王老師');
check('同一班多節 → 一張班級聯含全部節次', sameSheets.length === 1 && sameSheets[0].records.length === 2);

check('聯數中文', [4, 6, 10, 13, 20, 21].map(n => gen.toChineseCount(n)).join() === '四,六,十,十三,二十,21');

const html = gen.createMultiCourseSheetHTML(sheets[1].records, sheets[1].courses,
    { ...sheets[1], totalSheets: 6 }, []);
check('7年2班 班級聯只出現自己班', html.includes('7年2班') && !html.includes('7年1班') && !html.includes('8年1班'));
check('班級聯標題含班名、頁尾為一式六聯', html.includes('7年2班 班級聯') && html.includes('一式六聯'));

if (failed) { process.stdout.write(`\n${failed} 項失敗\n`); process.exit(1); }
process.stdout.write('\n全部通過\n');
