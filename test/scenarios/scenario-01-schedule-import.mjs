/**
 * 情境 1：課表匯入與解析
 *
 * 直接對 src/js/modules/scheduleParser.js 的真實邏輯測試。CSV 文字 → 原始列的這一段用
 * PapaParse 以與 ScheduleParser.parseCSV() 完全相同的設定（header/skipEmptyLines）跑，
 * 再交給 processRawData()——瀏覽器端 parseCSV 內部就是這兩步，只是中間隔了 File/FileReader，
 * 那層在 Node 無法忠實重現，也不是解析邏輯的一部分。
 */

import Papa from 'papaparse';

import { ScheduleParser } from '../../src/js/modules/scheduleParser.js';
import { ALPHA, buildSchoolFixture } from '../fixtures/school-fixture.mjs';
import { buildCsvVariants } from '../fixtures/csv-variants.mjs';
import { Suite, eq, ok, includes } from './harness.mjs';

/** 與 ScheduleParser.parseCSV() 相同設定 */
function parseCsvText(csv) {
    const result = Papa.parse(csv, { header: true, skipEmptyLines: true });
    return result.data;
}

export async function run() {
    const suite   = new Suite('情境 1：課表匯入與解析');
    const parser  = new ScheduleParser();
    const fixture = buildSchoolFixture(ALPHA);
    const rows    = fixture.schedules[ALPHA.currentSemester].rows;
    const variants = buildCsvVariants(rows);

    for (const v of variants) {
        await suite.case(`${v.name}：${v.title}`, () => {
            const raw    = parseCsvText(v.csv);
            const result = parser.processRawData(raw);

            eq(result.success, v.expect.success, `${v.name} 的 success 旗標`);

            if (!v.expect.success) {
                includes(result.error, v.expect.errorContains, `${v.name} 的錯誤訊息`);
                return;
            }

            eq(result.scheduleData.length, v.expect.rowCount, `${v.name} 解析出的課堂數`);

            if (v.expect.normalized) {
                v.expect.normalized.forEach((n, i) => {
                    eq(result.scheduleData[i].weekday, n.weekday, `${v.name} 第 ${i + 1} 列的週次正規化`);
                    eq(result.scheduleData[i].period,  n.period,  `${v.name} 第 ${i + 1} 列的節次正規化`);
                });
            }
            if (v.expect.subjects) {
                eq(result.scheduleData.map(r => r.subject), v.expect.subjects, `${v.name} 的課程顯示名稱`);
            }
            if (v.expect.teacherCount !== undefined) {
                eq(result.teachers.length, v.expect.teacherCount, `${v.name} 的教師數`);
            }
            if (v.expect.teacherDomains) {
                for (const [name, domains] of Object.entries(v.expect.teacherDomains)) {
                    const t = result.teachers.find(x => x.name === name);
                    ok(t, `${v.name} 應找得到教師 ${name}`);
                    eq(t.domains, domains, `${v.name} 中 ${name} 的任教領域`);
                }
            }
            if (v.expect.classes) {
                eq(result.classes, v.expect.classes, `${v.name} 的班級排序`);
            }
            if (v.expect.trimmed) {
                eq(result.scheduleData[0].className, v.expect.trimmed.className, `${v.name} 的班級去空白`);
                eq(result.scheduleData[0].teacher,   v.expect.trimmed.teacher,   `${v.name} 的教師去空白`);
            }
        }, { knownGap: v.expect.knownGap });
    }

    // --- 完整課表的整體性質 ---
    await suite.case('完整課表：教師與班級清單正確', () => {
        const result = parser.processRawData(parseCsvText(buildCsvVariants(rows)[0].csv));
        eq(result.classes, [...ALPHA.classes], '班級清單應與學校設定一致');
        eq(result.teachers.length, 20, '任課教師數（名冊 22 位中有 2 位不任課）');
    });

    await suite.case('完整課表：無教師衝堂', () => {
        const result = parser.processRawData(parseCsvText(buildCsvVariants(rows)[0].csv));
        const seen = new Map();
        const conflicts = [];
        for (const r of result.scheduleData) {
            const key = `${r.weekday}|${r.period}|${r.teacher}`;
            if (seen.has(key)) conflicts.push(`${r.teacher} ${r.weekday}${r.period}：${seen.get(key)} 與 ${r.className}`);
            seen.set(key, r.className);
        }
        eq(conflicts, [], '不應有任何教師在同一時段被排到兩個班');
    });

    await suite.case('完整課表：彈性學習課程顯示校訂名稱、且不計入任教領域', () => {
        const result = parser.processRawData(parseCsvText(buildCsvVariants(rows)[0].csv));
        const flexible = result.scheduleData.filter(r => r.domain === '統整性主題/專題/議題探究');
        ok(flexible.length > 0, '課表中應有彈性學習課程');
        eq([...new Set(flexible.map(r => r.subject))], ['閱讀素養'], '應顯示校訂課程名稱而非科目欄');

        const flexTeachers = new Set(flexible.map(r => r.teacher));
        for (const name of flexTeachers) {
            const t = result.teachers.find(x => x.name === name);
            ok(!t.domains.includes('統整性主題/專題/議題探究'), `${name} 的任教領域不應包含被排除的領域`);
        }
    });

    return suite;
}
