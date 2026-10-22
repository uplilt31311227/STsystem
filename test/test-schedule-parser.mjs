/**
 * 課表解析：被略過的列要收集成 warnings（列號以 Excel 為準、原因、內容摘要）
 *
 * 固定資料 test/fixtures/schedule-with-bad-rows.csv（Excel 列號）：
 *   1 標題列
 *   2 正常
 *   3 缺教師
 *   4 無效節次（第十五節）
 *   5 無效星期（週六）
 *   6 全空白列（不算警告、不計入略過）
 *   7 缺班級
 *   8 正常
 * 期望值寫死，不由被測函式產生。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ScheduleParser } from '../src/js/modules/scheduleParser.js';
import { Suite, eq, ok, includes } from './scenarios/harness.mjs';

const require = createRequire(import.meta.url);
globalThis.Papa = require('papaparse');   // 瀏覽器端由 CDN 提供

const suite = new Suite('課表解析 warnings');
const csv = readFileSync(new URL('./fixtures/schedule-with-bad-rows.csv', import.meta.url), 'utf8');

const parse = async () => {
    const parser = new ScheduleParser();
    // parseCSV 在瀏覽器收 File，Papa 在 node 也接受字串
    const raw = await parser.parseCSV(csv);
    return parser.processRawData(raw);
};

await suite.case('缺欄位、無效節次、無效星期都被收集，列號為 Excel 列號', async () => {
    const res = await parse();
    ok(res.success, '解析成功');
    eq(res.scheduleData.length, 2, '只匯入 2 筆正常列');
    eq(res.skippedCount, 4, '略過 4 列（全空白列不算）');
    eq(res.warnings.map(w => w.row), [3, 4, 5, 7], '列號（標題列為第 1 列）');
    eq(res.warnings.map(w => w.reason), ['缺教師', '無效節次「第十五節」', '無效星期「週六」', '缺班級'], '原因');
    includes(res.warnings[0].summary, '英文', '摘要含原始內容');
});

await suite.case('一列多個問題時原因併列；Y=0 時 warnings 為空陣列', () => {
    const parser = new ScheduleParser();
    const bad = parser.processRawData([{ 週次: '', 節次: '9', 年級: '7', 班級: '', 教師姓名: '', 領域: '', 科目: '' }]);
    eq(bad.warnings[0].row, 2, '無列號資訊時以 index+2 換算');
    eq(bad.warnings[0].reason, '缺星期、無效節次「9」、缺班級、缺教師', '多原因併列');
    const good = parser.processRawData([{ 週次: '1', 節次: '1', 年級: '7', 班級: '701', 教師姓名: '甲', 領域: '', 科目: '' }]);
    eq(good.warnings, [], '無略過時為空陣列');
    eq(good.skippedCount, 0, 'skippedCount = 0');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
