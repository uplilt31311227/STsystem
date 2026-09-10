/**
 * 課表 CSV 的正常版與各種異常變體
 *
 * 每個變體都自帶「預期行為」描述，測試據此斷言。這些變體不是憑空想的——
 * 全部對應 ScheduleParser 裡實際存在的分支：欄位別名對應、週次/節次正規化表、
 * 必要欄位檢查、不完整列跳過、courseName 優先於 subject、excludedDomains 排除。
 */

import { CSV_HEADERS, rowsToCsv } from './schedule-builder.mjs';

/** 產生一列的工具，未指定的欄位留空。 */
export function row(overrides = {}) {
    const base = {
        週次: '週一', 節次: '第一節', 年級: '7年級', 班級: '7年1班',
        教師姓名: '王大明', 身分證字號或居留證號: '', 類別: '領域學習',
        領域: '數學領域', 科目: '數學', '語言別/校訂課程名稱': '',
        上課頻率: '1', 起始週: '1',
    };
    return { ...base, ...overrides };
}

/**
 * 建立全部變體。
 * @param {Array<object>} normalRows 正常課表的原始列（由 schedule-builder 產生）
 */
export function buildCsvVariants(normalRows) {
    const variants = [];
    const add = (v) => variants.push(v);

    add({
        name: 'normal',
        title: '正常完整課表',
        csv: rowsToCsv(normalRows),
        expect: {
            success: true,
            rowCount: normalRows.length,
            note: '全數解析成功，教師與班級清單完整',
        },
    });

    add({
        name: 'with-bom',
        title: 'UTF-8 BOM 開頭',
        csv: rowsToCsv(normalRows.slice(0, 20), { withBom: true }),
        expect: {
            success: true,
            rowCount: 20,
            note: 'BOM 不應污染第一個欄位名，否則「週次」欄會偵測不到',
        },
    });

    add({
        name: 'crlf',
        title: 'CRLF 換行（Windows 匯出）',
        csv: rowsToCsv(normalRows.slice(0, 20)).replace(/\n/g, '\r\n'),
        expect: { success: true, rowCount: 20, note: 'CRLF 應被正常處理，不留下 \\r 殘留' },
    });

    add({
        name: 'header-alias',
        title: '欄位名用別名（星期／節／任課教師／課程名稱）',
        csv: rowsToCsv(
            normalRows.slice(0, 15).map(r => ({
                星期: r.週次, 節: r.節次, 年級: r.年級, 班級: r.班級,
                任課教師: r.教師姓名, 類別: r.類別, 領域: r.領域,
                科目: r.科目, 課程名稱: r['語言別/校訂課程名稱'],
            })),
            { headers: ['星期', '節', '年級', '班級', '任課教師', '類別', '領域', '科目', '課程名稱'] }
        ),
        expect: { success: true, rowCount: 15, note: 'detectFieldMapping 的別名清單應涵蓋這些寫法' },
    });

    add({
        name: 'value-alias',
        title: '週次／節次用別名值（星期一／一／1／第1節）',
        csv: rowsToCsv([
            row({ 週次: '星期一', 節次: '1',     班級: '7年1班', 教師姓名: '王大明' }),
            row({ 週次: '二',     節次: '第2節', 班級: '7年1班', 教師姓名: '李小華' }),
            row({ 週次: '3',      節次: '第三節', 班級: '7年2班', 教師姓名: '張美玲' }),
        ]),
        expect: {
            success: true,
            rowCount: 3,
            normalized: [
                { weekday: '週一', period: '第一節' },
                { weekday: '週二', period: '第二節' },
                { weekday: '週三', period: '第三節' },
            ],
            note: 'weekdayMap／periodMap 應把這些寫法全部正規化',
        },
    });

    add({
        name: 'missing-required-column',
        title: '缺少必要欄位（沒有教師欄）',
        csv: rowsToCsv(
            normalRows.slice(0, 5).map(r => ({ 週次: r.週次, 節次: r.節次, 班級: r.班級, 科目: r.科目 })),
            { headers: ['週次', '節次', '班級', '科目'] }
        ),
        expect: {
            success: false,
            errorContains: '缺少必要欄位',
            note: 'requiredFields 檢查應擋下並明確指出缺哪一欄',
        },
    });

    add({
        name: 'incomplete-rows',
        title: '部分列缺值（教師空白／班級空白）',
        csv: rowsToCsv([
            row({ 教師姓名: '王大明' }),
            row({ 節次: '第二節', 教師姓名: '' }),          // 缺教師 → 應跳過
            row({ 節次: '第三節', 班級: '' }),               // 缺班級 → 應跳過
            row({ 節次: '第四節', 週次: '' }),               // 缺週次 → 應跳過
            row({ 節次: '第五節', 教師姓名: '李小華' }),
        ]),
        expect: {
            success: true,
            rowCount: 2,
            note: '不完整的列應被靜默跳過，不應讓整份檔案失敗',
        },
    });

    add({
        name: 'header-only',
        title: '只有標題列，沒有任何資料',
        csv: CSV_HEADERS.join(',') + '\n',
        expect: {
            success: false,
            errorContains: '沒有資料',
            note: '空檔案應回報明確錯誤而非產生空課表',
        },
    });

    add({
        name: 'unknown-weekday',
        title: '未知週次（週六／週日）與第八節',
        csv: rowsToCsv([
            row({ 週次: '週六', 節次: '第一節' }),
            row({ 週次: '週日', 節次: '第八節' }),
            row({ 週次: '週一', 節次: '第八節' }),
        ]),
        expect: {
            success: true,
            rowCount: 3,
            note: 'normalizeWeekday 對未知值原樣保留（不丟資料），第八節在 periodMap 內應正常',
            knownGap: '週六／週日會原樣進入課表，系統沒有任何一處擋下非上課日——真實匯出檔若含週末課程不會被察覺',
        },
    });

    add({
        name: 'teacher-conflict',
        title: '同一教師同一時段被排在兩個班（衝堂）',
        csv: rowsToCsv([
            row({ 週次: '週一', 節次: '第一節', 班級: '7年1班', 教師姓名: '王大明' }),
            row({ 週次: '週一', 節次: '第一節', 班級: '7年2班', 教師姓名: '王大明' }),
        ]),
        expect: {
            success: true,
            rowCount: 2,
            note: 'parser 不做衝堂檢查（設計如此），兩列都會進入課表',
            knownGap: '匯入階段沒有衝堂偵測，錯誤課表會被靜默接受',
        },
    });

    add({
        name: 'duplicate-teacher-names',
        title: '兩位不同教師同名',
        csv: rowsToCsv([
            row({ 週次: '週一', 節次: '第一節', 班級: '7年1班', 教師姓名: '林怡君', 領域: '語文領域', 科目: '國語文' }),
            row({ 週次: '週二', 節次: '第一節', 班級: '8年1班', 教師姓名: '林怡君', 領域: '藝術領域', 科目: '視覺藝術' }),
        ]),
        expect: {
            success: true,
            rowCount: 2,
            teacherCount: 1,
            note: 'parser 以「姓名」為唯一鍵，同名的兩位教師會被合併成一位、領域被合併',
            knownGap: '同名教師在課表階段無法區分，領域統計與後續代課推薦都會錯',
        },
    });

    add({
        name: 'course-name-priority',
        title: '校訂課程名稱優先於科目欄',
        csv: rowsToCsv([
            row({ 科目: '彈性學習課程', '語言別/校訂課程名稱': '閱讀素養' }),
            row({ 節次: '第二節', 科目: '本土語文', '語言別/校訂課程名稱': '閩南語' }),
            row({ 節次: '第三節', 科目: '數學', '語言別/校訂課程名稱': '' }),
        ]),
        expect: {
            success: true,
            rowCount: 3,
            subjects: ['閱讀素養', '閩南語', '數學'],
            note: 'subject 應取 courseName，courseName 為空才退回科目欄',
        },
    });

    add({
        name: 'excluded-domain',
        title: '排除領域不計入教師任教領域',
        csv: rowsToCsv([
            row({ 教師姓名: '陳老師', 領域: '數學領域', 科目: '數學' }),
            row({ 節次: '第二節', 教師姓名: '陳老師', 領域: '統整性主題/專題/議題探究', 科目: '專題探究' }),
            row({ 節次: '第三節', 教師姓名: '陳老師', 領域: '社團活動與技藝課程', 科目: '社團' }),
        ]),
        expect: {
            success: true,
            rowCount: 3,
            teacherDomains: { 陳老師: ['數學領域'] },
            note: 'excludedDomains 的兩個領域不應出現在教師的 domains',
        },
    });

    add({
        name: 'whitespace-padding',
        title: '值前後有多餘空白',
        csv: rowsToCsv([
            row({ 週次: ' 週一 ', 節次: ' 第一節 ', 班級: ' 7年1班 ', 教師姓名: ' 王大明 ' }),
        ]),
        expect: {
            success: true,
            rowCount: 1,
            normalized: [{ weekday: '週一', period: '第一節' }],
            trimmed: { className: '7年1班', teacher: '王大明' },
            note: 'normalizeWeekday/Period 有 trim；className/teacher 也有 trim',
        },
    });

    add({
        name: 'class-sorting',
        title: '班級排序（跨年級數字排序而非字串排序）',
        csv: rowsToCsv([
            row({ 班級: '9年10班', 教師姓名: 'A老師' }),
            row({ 節次: '第二節', 班級: '7年2班', 教師姓名: 'B老師' }),
            row({ 節次: '第三節', 班級: '9年2班', 教師姓名: 'C老師' }),
            row({ 節次: '第四節', 班級: '10年1班', 教師姓名: 'D老師' }),
        ]),
        expect: {
            success: true,
            rowCount: 4,
            classes: ['7年2班', '9年2班', '9年10班', '10年1班'],
            note: '應依年級與班號的數值排序，9年10班要排在 9年2班之後',
        },
    });

    return variants;
}
