/**
 * 多重調課通知單：連鎖對調合併為淨結果、調課前後對照、中繼位置註記
 * 執行：node test/test-swap-batch-form.mjs
 */
import { PDFGenerator } from '../src/js/modules/pdfGenerator.js';

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}

const gen = new PDFGenerator();

// 真實案例（115-1 內湖國中）：10/27 週二第5、6節 701、801 都要上數學，藍奕麟不排第一節
const course = (weekday, period, className, subject, teacher) => ({ weekday, period, className, subject, teacher });
const schedule = [
    course('週二', '第一節', '7年1班', '英語文', '陳品瑄'),
    course('週二', '第二節', '7年1班', '體育', '黃奕'),
    course('週二', '第三節', '7年1班', '數學', '王智萱'),
    course('週二', '第四節', '7年1班', '生物', '林信安'),
    course('週二', '第五節', '7年1班', '公民與社會', '邱旭琳'),
    course('週二', '第六節', '7年1班', '國語文', '藍奕麟'),
    course('週三', '第一節', '7年1班', '數學', '王智萱'),
    course('週二', '第二節', '8年1班', '數學', '盧玉燕'),
    course('週二', '第三節', '8年1班', '數學', '盧玉燕'),
    course('週二', '第五節', '8年1班', '英語文', '高家涵'),
    course('週二', '第六節', '8年1班', '家政', '吳沛臻'),
];
const swap = (date, weekday, period, className, subject, originalTeacher, swapDate, swapWeekday, swapPeriod, swapSubject, swapTeacher) =>
    ({ type: '調課', date, weekday, period, className, subject, originalTeacher, swapDate, swapWeekday, swapPeriod, swapSubject, swapTeacher });
const records = [
    swap('2026-10-27', '週二', '第五節', '7年1班', '公民與社會', '邱旭琳', '2026-10-28', '週三', '第一節', '數學', '王智萱'),
    swap('2026-10-27', '週二', '第六節', '7年1班', '國語文', '藍奕麟', '2026-10-27', '週二', '第四節', '生物', '林信安'),
    swap('2026-10-27', '週二', '第六節', '8年1班', '家政', '吳沛臻', '2026-10-27', '週二', '第二節', '數學', '盧玉燕'),
    swap('2026-10-27', '週二', '第三節', '8年1班', '數學', '盧玉燕', '2026-10-27', '週二', '第五節', '英語文', '高家涵'),
    // 連鎖第二步：林信安此時在第六節是第 2 筆調入的中繼位置
    swap('2026-10-27', '週二', '第三節', '7年1班', '數學', '王智萱', '2026-10-27', '週二', '第六節', '生物', '林信安'),
];

const net = gen.computeSwapNetMoves(records);
const fmt = m => `${m.teacher} ${m.className} ${m.from.date.slice(5)}${m.from.period}→${m.to.date.slice(5)}${m.to.period}`;
const lin = net.filter(m => m.teacher === '林信安');
check('林信安連鎖 4→6→3 合併為一筆 4→3', lin.length === 1 && lin[0].from.period === '第四節' && lin[0].to.period === '第三節',
    lin.map(fmt).join(' / '));
check('每堂移動的課各一筆（共 9 筆）', net.length === 9, net.map(fmt).join(' / '));
check('沒有任何一筆經過第六節中繼', !net.some(m => m.teacher === '林信安' && m.to.period === '第六節'));
const wang = net.filter(m => m.teacher === '王智萱').map(m => m.to.period).sort();
check('王智萱兩堂改到週二第五、六節', wang.join() === '第五節,第六節', wang.join());

const grid = gen.buildSwapBatchGrid(records, net, schedule);
const tue = grid.find(d => d.date === '2026-10-27');
const after = (cls, p) => tue.classes.find(c => c.className === cls).rows.find(r => r.period === p).after.map(a => a.subject + a.teacher).join();
check('701 週二第5、6節為數學王智萱', after('7年1班', '第五節') === '數學王智萱' && after('7年1班', '第六節') === '數學王智萱');
check('801 週二第5、6節為數學盧玉燕', after('8年1班', '第五節') === '數學盧玉燕' && after('8年1班', '第六節') === '數學盧玉燕');
check('701 週二第3節生物、第4節國語', after('7年1班', '第三節') === '生物林信安' && after('7年1班', '第四節') === '國語文藍奕麟');
check('調課後每格剛好一位教師（無 problem）', !grid.some(d => d.classes.some(c => c.rows.some(r => r.problem))));
check('週三第1節 701 改為公民', grid.find(d => d.date === '2026-10-28').classes.find(c => c.className === '7年1班').rows[0].after[0].teacher === '邱旭琳');

const notes = gen.getSwapTransitNotes(records, schedule);
check('只有第 5 筆有中繼註記', notes.map(n => !!n).join() === 'false,false,false,false,true', JSON.stringify(notes));
check('註記點名林信安第六節', notes[4].includes('林信安') && notes[4].includes('第六節'));

// 漏掉一筆（只做第 2 筆不做第 5 筆）→ 701 第六節變生物，第三節仍數學；不應誤報
const partial = gen.buildSwapBatchGrid(records.slice(0, 4), gen.computeSwapNetMoves(records.slice(0, 4)), schedule);
check('不完整批次仍正確反映（701 第六節為生物）',
    partial[0].classes.find(c => c.className === '7年1班').rows[5].after[0].subject === '生物');

// 自行調課（同一教師兩側）不應互相吃掉
const self = [swap('2026-10-27', '週二', '第三節', '7年1班', '數學', '王智萱', '2026-10-28', '週三', '第一節', '數學', '王智萱')];
const selfNet = gen.computeSwapNetMoves(self);
check('自行調課產生兩筆、方向相反', selfNet.length === 2
    && selfNet.some(m => m.from.date === '2026-10-27' && m.to.date === '2026-10-28')
    && selfNet.some(m => m.from.date === '2026-10-28' && m.to.date === '2026-10-27'), selfNet.map(fmt).join(' / '));

// 互換後又換回來 → 沒有淨異動
const back = [records[1], swap('2026-10-27', '週二', '第六節', '7年1班', '生物', '林信安', '2026-10-27', '週二', '第四節', '國語文', '藍奕麟')];
check('換過去再換回來 → 無淨異動', gen.computeSwapNetMoves(back).length === 0);

// HTML：教師聯只含該教師、不出現中繼節次
const linHTML = gen.createSwapTeacherSheetHTML('林信安', lin);
check('林信安教師聯只寫第四節→第三節', linHTML.includes('第四節') && linHTML.includes('第三節') && !linHTML.includes('第六節'));
const adminHTML = gen.createSwapBatchAdminPageHTML(records, net, grid, notes);
check('教學組聯含總表、異動一覽與明細註記', adminHTML.includes('調課總表') && adminHTML.includes('教師異動一覽') && adminHTML.includes('暫時位置'));
const classHTML = gen.createSwapClassSheetHTML('8年1班', grid);
check('801 班級聯不含 701', classHTML.includes('8年1班') && !classHTML.includes('7年1班'));

if (failed) { process.stdout.write(`\n${failed} 項失敗\n`); process.exit(1); }
process.stdout.write('\n全部通過\n');
