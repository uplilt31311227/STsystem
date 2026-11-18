/**
 * P9 第二批 B：純邏輯模組修正的回歸測試（先寫失敗測試、再修）
 * 執行：node test/test-p9b-logic.mjs
 *
 * 涵蓋：LC-M2／L10 姓名正規化、LC-M5 重匯教師合併、LC-M6 pdfGenerator／app.js 日期、LC-L1 normalizeDate、
 *       LC-L2 班級中文數字、LC-L3 isSameDomain、LC-L5 detectFieldMapping、LC-L12 調課請假、
 *       SF-M6 pdfGenerator 分組以 Map、SF-L2 刪除死碼、LC-M3（使用者決定 f）全天請假排最後層。
 *
 * 日期類案例要在兩個時區各跑一次：父行程以子行程設定 P9B_TZ（子行程在載入任何模組前設 process.env.TZ），
 * 因為 Windows 下的 bash 環境變數前綴不一定傳得進 node，由子行程自設最可靠。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ZONES = ['Asia/Taipei', 'America/Los_Angeles'];

if (!process.env.P9B_TZ) {
    let bad = 0;
    for (const tz of ZONES) {
        const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
            env: { ...process.env, P9B_TZ: tz }, encoding: 'utf8'
        });
        process.stdout.write(`\n##### TZ=${tz} #####\n${r.stdout}${r.stderr ? r.stderr.replace(/\(node:\d+\)[^\n]*\n?|Reparsing[^\n]*\n?|To eliminate[^\n]*\n?|\(Use `node[^\n]*\n?/g, '') : ''}`);
        if (r.status !== 0) bad++;
    }
    if (bad) { process.stdout.write(`\n${bad} 個時區有失敗\n`); process.exit(1); }
    process.stdout.write('\n兩個時區全部通過\n');
    process.exit(0);
}

process.env.TZ = process.env.P9B_TZ;
const require = createRequire(import.meta.url);
globalThis.Papa = require('papaparse');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log0 = console.log;
console.log = () => {};   // 引擎與解析器有大量 debug log

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; return; }
    fail++;
    process.stdout.write(`✗ ${name}${detail ? '  ' + detail : ''}\n`);
}
const eq = (a, e, name) => check(name, JSON.stringify(a) === JSON.stringify(e), `預期 ${JSON.stringify(e)}，實得 ${JSON.stringify(a)}`);
async function load(rel) {
    try { return await import(new URL('../' + rel, import.meta.url)); }
    catch (e) { fail++; process.stdout.write(`✗ 無法載入 ${rel}：${String(e.message).split('\n')[0]}\n`); return {}; }
}

const offset = new Date(2026, 0, 1).getTimezoneOffset();
check('TZ 設定生效', offset === (process.env.TZ === 'Asia/Taipei' ? -480 : 480), `offset=${offset}`);

const { RecommendationEngine, findTeacherConflict, findSwapInConflict, findSwapDateConflict } =
    await load('src/js/modules/recommendationEngine.js');
const { PDFGenerator } = await load('src/js/modules/pdfGenerator.js');
const { DataManager } = await load('src/js/modules/dataManager.js');
const { ScheduleParser } = await load('src/js/modules/scheduleParser.js');
const nameMod = await load('src/js/modules/teacherName.js');
const mergeMod = await load('src/js/modules/teacherMerge.js');
const teacherMgr = await load('src/js/modules/v2/teacherAccountManager.js');

// ===== LC-M2：共用 normalizeTeacherName =====
const N = nameMod.normalizeTeacherName;
check('teacherName.js 匯出 normalizeTeacherName', typeof N === 'function');
if (typeof N === 'function') {
    eq(N('李　小華'), '李小華', '中間全形空白去除');
    eq(N('李 小華'), '李小華', '中間半形空白（CJK 之間）去除');
    eq(N('  李小華　'), '李小華', '前後半形、全形空白');
    eq(N('李​小華﻿'), '李小華', '零寬字元去除');
    eq(N('ＡＢＣ王'), 'ABC王', '全形英數轉半形（NFKC）');
    eq(N('John  Smith'), 'John Smith', '西文名字內部空白保留為單一空格');
    eq(N(null), '', 'null → 空字串');
    eq(N(undefined), '', 'undefined → 空字串');
    eq(N(123), '123', '數字轉字串');
}

// ===== LC-M2：推薦端、衝堂判斷改用共用正規化 =====
{
    const eng = new RecommendationEngine();
    eq(eng.normalizeName('李　小華'), '李小華', '推薦引擎 normalizeName 處理全形空白');
    check('findTeacherConflict：全形空白姓名仍命中有課',
        !!findTeacherConflict({ teacherName: '李　小華', weekday: '週一', period: '第一節',
            scheduleData: [{ teacher: '李小華', weekday: '週一', period: '第一節' }] }));
    check('findTeacherConflict：紀錄中姓名有全形空白仍命中',
        !!findTeacherConflict({ teacherName: '李小華', date: '2026-11-11', period: '第一節',
            records: [{ id: 'a', date: '2026-11-11', period: '第一節', substituteTeacher: '李　小華' }] }));
    check('findSwapInConflict：全形空白姓名仍命中',
        !!findSwapInConflict({ teacherName: '李　小華', date: '2026-11-12', period: '第二節',
            records: [{ id: 'b', type: '調課', swapDate: '2026-11-12', swapPeriod: '第二節',
                originalTeacher: '李小華', swapTeacher: '王' }] }));
    const cands = eng.getCandidateTeachers([{ name: '李小華' }], [{ teacher: '李　小華' }]);
    eq(cands.length, 1, '候選名單：同一人不同空白寫法只算一位');
}

// ===== LC-M2：課表解析不改寫存檔的姓名（只在比對時正規化）=====
{
    const parser = new ScheduleParser();
    const mk = (t, p) => ({ 週次: '1', 節次: String(p), 年級: '7', 班級: '701', 教師姓名: t, 領域: '', 科目: '國文' });
    const res = parser.processRawData([mk('王　明', 1), mk(' 王　明 ', 2)]);
    eq([...new Set(res.scheduleData.map(c => c.teacher))], ['王　明'], '解析：存檔姓名維持原字串（只 trim，保留全形空白）');
    eq(res.teachers.map(t => t.name), ['王　明'], '解析：名冊姓名同樣維持原字串');
}

// ===== LC-L10：新增教師防重雙邊正規化 =====
{
    const mkSvc = (initial) => {
        const store = new Map(initial.map(t => [t.teacherId, { ...t }]));
        return {
            store, created: 0,
            async listTeachers() { return [...store.values()].map(t => ({ ...t })); },
            async createTeacher(p) { this.created++; const id = 't' + this.created; store.set(id, { teacherId: id, ...p }); return { teacherId: id, ...p }; },
        };
    };
    const logger = { async log() {} };
    const tryCreate = async (initial, name) => {
        const svc = mkSvc(initial);
        teacherMgr.__testHooks.dataSvc = svc; teacherMgr.__testHooks.logger = logger;
        try { await teacherMgr.createTeacher({ name }); return { threw: false, svc }; }
        catch (e) { return { threw: true, svc, msg: e.message }; }
    };
    if (teacherMgr.createTeacher) {
        let r = await tryCreate([{ teacherId: 'x', name: '王大明 ' }], '王大明');
        check('防重：既有名字帶尾空白，新建同名仍被擋', r.threw && r.svc.created === 0, r.msg);
        r = await tryCreate([{ teacherId: 'x', name: '李　小華' }], '李小華');
        check('防重：既有名字含全形空白，新建同名仍被擋', r.threw && r.svc.created === 0, r.msg);
        r = await tryCreate([{ teacherId: 'x', name: '李小華' }], '李　小華');
        check('防重：新名字含全形空白，仍視為已存在', r.threw && r.svc.created === 0, r.msg);
        r = await tryCreate([{ teacherId: 'x', name: '王大明' }], '王小明');
        check('防重：不同人不誤擋', !r.threw && r.svc.created === 1, r.msg);
    }
}

// ===== LC-M5：重匯課表時合併回導師班級與領域 =====
{
    const merge = mergeMod.mergeTeacherAttributes;
    check('teacherMerge.js 匯出 mergeTeacherAttributes', typeof merge === 'function');
    if (typeof merge === 'function') {
        const old = [
            { name: '王導師', domains: ['國文'], homeroomClass: '7年1班', partTime: true },
            { name: '李　小華', domains: ['數學領域'], homeroomClass: '' },
            { name: '已離職', domains: [], homeroomClass: '8年1班' },
        ];
        const fresh = [
            { name: '王導師', domains: ['語文領域'], homeroomClass: '' },
            { name: '李小華', domains: ['數學領域', '科技領域'], homeroomClass: '9年2班' },
            { name: '新老師', domains: ['社會領域'], homeroomClass: '' },
        ];
        const snapshot = JSON.stringify(fresh);
        const out = merge(old, fresh);
        const by = n => out.find(t => t.name === n);
        eq(by('王導師').homeroomClass, '7年1班', '新名冊導師班空白 → 保留既有導師班');
        eq(by('王導師').domains, ['語文領域', '國文'], '領域：新課表領域在前，補回既有手動領域（聯集）');
        eq(by('王導師').partTime, true, 'partTime 既有為真 → 帶回');
        eq(by('李小華').homeroomClass, '9年2班', '新名冊導師班有值 → 以新資料為準');
        eq(by('李小華').domains, ['數學領域', '科技領域'], '領域聯集去重');
        eq(by('新老師').homeroomClass, '', '全新教師維持空白');
        eq(by('新老師').partTime, undefined, '全新教師不憑空多出 partTime');
        eq(out.length, 3, '不在新課表的既有教師不被加回名冊');
        eq(JSON.stringify(fresh), snapshot, '不修改傳入的新名冊');
        // 姓名以正規化比對（既有「李　小華」對上新「李小華」）
        eq(by('李小華').domains.includes('數學領域'), true, '姓名正規化後比對');
        const o2 = merge([{ name: '李　小華', domains: ['自訂'], homeroomClass: '7年3班' }], [{ name: '李小華', domains: [], homeroomClass: '' }]);
        eq([o2[0].homeroomClass, o2[0].domains], ['7年3班', ['自訂']], '既有姓名含全形空白仍能帶回屬性');
        eq(merge(null, fresh).length, 3, '既有名冊為空不出錯');
    }
}

// ===== LC-M6：日期（pdfGenerator）=====
{
    const g = new PDFGenerator();
    const rec = { type: '代課', date: '2026-11-11', weekday: '週三', period: '第一節', className: '7年1班',
        subject: '數學', originalTeacher: '王', substituteTeacher: '李' };
    const sw = { ...rec, type: '調課', swapDate: '2026-11-12', swapWeekday: '週四', swapPeriod: '第二節',
        swapTeacher: '李', swapSubject: '英語' };
    const sheet = { teacher: '王', label: '教學組聯' };
    const h1 = g.createSheetHTML(rec, sheet, []);
    check('PDF 單聯：日期 2026/11/11 (週三)', h1.includes('2026/11/11 (週三)'), '');
    check('PDF 單聯課表格：11/11', h1.includes('>11/11<br>'));
    const h2 = g.createSheetHTML(sw, sheet, []);
    check('PDF 調課：時段 A 日期 2026/11/11', h2.includes('2026/11/11'));
    check('PDF 調課：時段 B 日期 2026/11/12', h2.includes('2026/11/12'));
    check('PDF 調課課表格：時段 A 11/11、時段 B 11/12', h2.includes('>11/11<br>') && h2.includes('>11/12<br>'));
    const h3 = g.createMultiCourseSheetHTML([rec], [rec], sheet, []);
    check('PDF 多節單聯：日期 2026/11/11 (週三)', h3.includes('2026/11/11 (週三)'));
    check('PDF 多節課表格預設 renderer：11/11', g.createMultiCourseScheduleTableHTML([], [rec], '王').includes('11/11<br>'));
    check('PDF 週彙整教師聯：11/11', g.createTeacherWeeklySheetHTML([rec], '王', 'original', 'x', []).includes('>11/11 7年1班 數學<br>'));
    check('PDF 週彙整班級聯：11/11', g.createClassWeeklySheetHTML([rec], '7年1班', 'x', []).includes('>11/11 數學<br>'));
}

// ===== LC-M6：app.js、v2-app.js、dataManager 不再以 new Date(YYYY-MM-DD 字串) 取本地值 =====
{
    const files = ['src/js/app.js', 'src/js/v2-app.js', 'src/js/modules/pdfGenerator.js', 'src/js/modules/dataManager.js'];
    const bad = [];
    for (const f of files) {
        readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
            // 樣式：new Date(<單一識別字或屬性鏈>)，且引數名含 date（排除 lastModified、createdAt 等時間戳）
            for (const m of line.matchAll(/new Date\(\s*([\w.]+)\s*\)/g)) {
                if (/date/i.test(m[1])) bad.push(f + ':' + (i + 1) + ' ' + m[0]);
            }
        });
    }
    check('src 內無 new Date(<日期變數>) 殘留', bad.length === 0, bad.join(' | '));
}

// ===== LC-L1：normalizeDate 不存在的日期不可進位 =====
{
    const norm = (s) => DataManager.prototype.normalizeDate.call({}, s);
    check('normalizeDate("2026-02-31") 不回傳 3/3', norm('2026-02-31') !== '2026-03-03', norm('2026-02-31'));
    eq(norm('2026-02-31'), '2026-02-31', '不存在的日期原樣回傳（視為無效、不換成別天）');
    eq(norm('2026-04-31'), '2026-04-31', '4/31 原樣回傳');
    eq(norm('2026/02/31'), '2026/02/31', '斜線格式不存在日期原樣回傳');
    eq(norm('2026-02-28'), '2026-02-28', '合法日期不變');
    eq(norm('2024-02-29'), '2024-02-29', '閏日合法');
    eq(norm('2025-02-29'), '2025-02-29', '非閏年 2/29 原樣回傳');
    eq(norm('2026/11/01'), '2026-11-01', '斜線合法日期轉為連字號');
    eq(norm('2026-13-01'), '2026-13-01', '月份 13 原樣回傳');
}

// ===== LC-L2：班級中文數字 =====
{
    const e = new RecommendationEngine();
    const cases = [['七年十二班', '7年12班'], ['七年十班', '7年10班'], ['七年十一班', '7年11班'], ['九年二十班', '9年20班'],
        ['八年二十一班', '8年21班'], ['七年一班', '7年1班'], ['七年九班', '7年9班'], ['七年01班', '7年1班'],
        ['701', '7年1班'], ['7年1班', '7年1班'], [' 七 年 三 班 ', '7年3班'], ['', ''], [null, '']];
    for (const [i, o] of cases) eq(e.normalizeClassName(i), o, `班級 ${JSON.stringify(i)} → ${o}`);
    check('七年十二班 與 7年12班 視為同班導師',
        e.isHomeroomTeacher({ homeroomClass: '七年十二班' }, '7年12班'));
}

// ===== LC-L3：isSameDomain 兩端皆空 =====
{
    const e = new RecommendationEngine();
    eq(e.isSameDomain({ domains: [''] }, ''), false, '領域含空字串、目標空 → false');
    eq(e.isSameDomain({ domains: ['', '數學領域'] }, undefined), false, '目標無領域 → false');
    eq(e.isSameDomain({ domains: ['  '] }, '  '), false, '全空白 → false');
    eq(e.isSameDomain({ domains: ['數學領域'] }, '數學'), true, '正常同領域仍為 true');
    const r = e.getRecommendations({ weekday: '週一', period: '第一節', className: '7年1班', subject: '', domain: '', originalTeacher: '原' },
        [], [{ name: '甲', domains: [''] }], '2026-11-09', []);
    check('課程無領域、教師領域含空字串 → 不加同領域分', !r[0].tags.includes('same_domain'), JSON.stringify(r[0].tags));
}

// ===== LC-L5：detectFieldMapping =====
{
    const p = new ScheduleParser();
    const m1 = p.detectFieldMapping(['起始週', '週次', '節次', '班級', '教師姓名']);
    eq(m1.weekday, '週次', '完全相等優先於 includes（起始週排在週次前面）');
    const m2 = p.detectFieldMapping(['週次', '節次', '年級', '班級', '教師姓名', '', '類別']);
    check('空標題不被對應到任何欄位', !Object.values(m2).includes(''), JSON.stringify(m2));
    eq([m2.weekday, m2.period, m2.className, m2.teacher], ['週次', '節次', '班級', '教師姓名'], '常規標題仍正確');
    const m3 = p.detectFieldMapping(['', '', '週次', '節次', '班級', '教師姓名', '領域', '科目']);
    eq([m3.domain, m3.subject, m3.category, m3.grade, m3.courseName], ['領域', '科目', undefined, undefined, undefined], '空標題不誤對應 category/grade/courseName');
    const m4 = p.detectFieldMapping(['教師', '教師姓名', '週次', '節次', '班級']);
    eq(m4.teacher, '教師姓名', '教師／教師姓名並存時，依 possibleNames 順序取完全相等');
    const m5 = p.detectFieldMapping(['星期別', '節次別', '班級名稱', '任課教師姓名']);
    eq([m5.weekday, m5.period, m5.className, m5.teacher], ['星期別', '節次別', '班級名稱', '任課教師姓名'], '無完全相等時仍可 includes 對應');
}

// ===== LC-L12：調課時，請假節次涵蓋要上的那一節才擋 =====
{
    const base = { teacherA: '陳老師', dateA: '2026-11-16', periodA: '第一節', teacherB: '李老師', dateB: '2026-11-13', periodB: '第三節' };
    const leave = { id: 'L', type: '代課', date: '2026-11-13', period: '第三節', className: '8年1班', originalTeacher: '陳老師', substituteTeacher: 'Z', status: 'approved' };
    const hit = findSwapDateConflict({ ...base, records: [leave] });
    check('A 師 swapDate 的請假節次涵蓋 periodB → 衝突', !!hit && hit.teacher === '陳老師' && hit.role === '請假', JSON.stringify(hit));
    check('A 師同日只請別節（第一節）、被調去第三節 → 放行', findSwapDateConflict({ ...base, records: [{ ...leave, period: '第一節' }] }) === null);
    check('上午公假、把課調到下午：同日第二節調第六節，請假在第一節 → 放行',
        findSwapDateConflict({ teacherA: '陳老師', dateA: '2026-11-13', periodA: '第二節', teacherB: '李老師', dateB: '2026-11-13', periodB: '第六節', records: [{ ...leave, period: '第一節' }] }) === null);
    check('A 師請多節、其中含 periodB → 衝突', !!findSwapDateConflict({ ...base, records: [{ ...leave, id: 'L1', period: '第一節' }, { ...leave, id: 'L2', period: '第三節' }] }));
    const hitB = findSwapDateConflict({ ...base, records: [{ ...leave, date: '2026-11-16', period: '第一節', originalTeacher: '李老師' }] });
    check('B 師 dateA 的請假節次涵蓋 periodA → 衝突（對稱）', !!hitB && hitB.teacher === '李老師' && hitB.role === '請假', JSON.stringify(hitB));
    check('B 師 dateA 請假但不含 periodA → 放行', findSwapDateConflict({ ...base, records: [{ ...leave, date: '2026-11-16', period: '第五節', originalTeacher: '李老師' }] }) === null);
    check('他日請假不誤擋', findSwapDateConflict({ ...base, records: [{ ...leave, date: '2026-11-14' }] }) === null);
    check('已駁回的請假不誤擋', findSwapDateConflict({ ...base, records: [{ ...leave, status: 'rejected' }] }) === null);
    check('調課紀錄不算請假', findSwapDateConflict({ ...base, records: [{ ...leave, type: '調課', swapDate: '2026-11-20', swapPeriod: '第二節', swapTeacher: 'Q' }] }) === null);
    check('自我調課不算請假', findSwapDateConflict({ ...base, records: [{ ...leave, isSelfSwap: true }] }) === null);
    check('excludeRecordId 排除自身', findSwapDateConflict({ ...base, records: [leave], excludeRecordId: 'L' }) === null);
    check('姓名全形空白仍命中', !!findSwapDateConflict({ ...base, teacherA: '陳　老師', records: [leave] }));
}

// ===== SF-M6：pdfGenerator 分組以 Map（__proto__ 班級名）=====
{
    const g = new PDFGenerator();
    const recs = [
        { id: 1, date: '2026-11-11', period: '第一節', className: '__proto__', originalTeacher: '__proto__', substituteTeacher: 'constructor' },
        { id: 2, date: '2026-11-11', period: '第二節', className: '__proto__', originalTeacher: 'toString', substituteTeacher: '__proto__' },
    ];
    const protoKeysBefore = JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort());
    let groups = null, threw = null;
    try { groups = g.groupRecordsByRecipient(recs); } catch (e) { threw = e; }
    check('groupRecordsByRecipient 餵 __proto__ 不拋錯', !threw, String(threw));
    if (groups) {
        const cls = groups.byClass;
        const get = (m, k) => (m instanceof Map ? m.get(k) : Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);
        eq((get(cls, '__proto__') || []).map(r => r.id), [1, 2], '__proto__ 班級收到兩筆');
        eq((get(groups.byOriginalTeacher, '__proto__') || []).map(r => r.id), [1], '__proto__ 原任課教師收到一筆');
        eq((get(groups.bySubstituteTeacher, 'constructor') || []).map(r => r.id), [1], 'constructor 代課教師正確');
        check('分組不污染 Object.prototype（屬性集合不變、普通物件原型未被換掉、{} 讀不到分組內容）',
            JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort()) === protoKeysBefore
            && Object.getPrototypeOf({}) === Object.prototype && ({}).id === undefined && !Array.isArray(({}).__proto__));
    }
    const moves = [{ teacher: '__proto__', className: '7年1班', subject: '數', from: {}, to: {} }];
    let byT = null; threw = null;
    try { byT = g.groupNetMovesByTeacher(moves); } catch (e) { threw = e; }
    check('groupNetMovesByTeacher 餵 __proto__ 不拋錯', !threw && byT, String(threw));
    check('groupNetMovesByTeacher 回傳 Map', byT instanceof Map, Object.prototype.toString.call(byT));
    const src = readFileSync(path.join(ROOT, 'src/js/modules/pdfGenerator.js'), 'utf8');
    check("groupRecordsByRecipient 內以 Map 累積", /new Map()/.test(src.slice(src.indexOf("groupRecordsByRecipient(records)"), src.indexOf("createWeeklySummaryTableHTML"))));
}

// ===== SF-L2：generateSettlementReport 已刪除 =====
{
    check('PDFGenerator 無 generateSettlementReport', typeof PDFGenerator.prototype.generateSettlementReport === 'undefined');
    const hits = [];
    (function walk(d) {
        for (const n of readdirSync(d)) {
            const p = path.join(d, n);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.(js|mjs|html)$/.test(n) && readFileSync(p, 'utf8').includes('generateSettlementReport')) hits.push(path.relative(ROOT, p));
        }
    })(path.join(ROOT, 'src'));
    check('src 內無 generateSettlementReport 字樣', hits.length === 0, hits.join(' '));
}

// ===== LC-M3（使用者決定 f）：全天請假者排最後一層，不排除 =====
{
    const e = new RecommendationEngine();
    const c = (teacher, weekday, period, className, subject) => ({ teacher, weekday, period, className, subject, rawSubject: subject, domain: '' });
    const date = '2026-11-11';   // 週三
    const schedule = [
        c('原師', '週三', '第三節', '7年1班', '國文'),
        c('國甲', '週三', '第一節', '8年1班', '國文'),   // 同科目 + 全天請假（第一、第五節都請假）
        c('國乙', '週三', '第一節', '8年2班', '國文'),   // 同科目 + 只請半天（第一節請、第五節沒請）
        c('國乙', '週三', '第五節', '8年2班', '國文'),
        c('國甲', '週三', '第五節', '8年1班', '國文'),
        c('空堂', '週四', '第一節', '9年1班', '地理'),
        c('兼課', '週四', '第二節', '9年2班', '音樂'),
    ];
    const teachers = [
        { name: '原師', domains: [], homeroomClass: '' }, { name: '國甲', domains: [], homeroomClass: '' },
        { name: '國乙', domains: [], homeroomClass: '' }, { name: '空堂', domains: [], homeroomClass: '' },
        { name: '兼課', domains: [], homeroomClass: '', partTime: true },
    ];
    const lv = (who, period, extra = {}) => ({ id: who + period, type: '代課', date, period, className: '8年1班',
        originalTeacher: who, substituteTeacher: '代', status: 'approved', ...extra });
    const target = { weekday: '週三', period: '第三節', className: '7年1班', subject: '國文', domain: '', originalTeacher: '原師' };
    const records = [lv('國甲', '第一節'), lv('國甲', '第五節'), lv('國乙', '第一節')];
    const recs = e.getRecommendations(target, schedule, teachers, date, [], records);
    const names = recs.map(r => r.teacher.name);
    eq(names, ['國乙', '空堂', '兼課', '國甲'], '全天請假者（國甲）排在所有人之後，連兼課都在其前');
    const jia = recs.find(r => r.teacher.name === '國甲');
    check('全天請假者仍在名單內（不排除）並標記', !!jia && jia.onLeaveFullDay === true && jia.tags.includes('onLeaveFullDay'), JSON.stringify(jia && jia.tags));
    check('半天請假者不標全天', !recs.find(r => r.teacher.name === '國乙').onLeaveFullDay);
    check('全天請假者理由文字含警示', /全天請假/.test(jia.reasonText), jia.reasonText);
    // 只傳當日紀錄（monthRecords 為 null）也要判定
    const recs2 = e.getRecommendations(target, schedule, teachers, date, records, null);
    eq(recs2.map(r => r.teacher.name).at(-1), '國甲', 'monthRecords 缺席時改用傳入紀錄判定');
    // 當天沒有課的教師，有請假紀錄也不算全天（沒有可比較的節次）
    const rec3 = e.getRecommendations(target, schedule, teachers, date, [lv('空堂', '第一節')], null);
    check('當天無課者不判全天請假', !rec3.find(r => r.teacher.name === '空堂').onLeaveFullDay);
    // 當天只有 1 節課、請那 1 節：單節請假，不算全天
    const sched1 = [...schedule.filter(x => x.teacher !== '國甲'), c('國甲', '週三', '第一節', '8年1班', '國文')];
    const rec5 = e.getRecommendations(target, sched1, teachers, date, [lv('國甲', '第一節')], null);
    check('當天只有 1 節課且只請該節 → 不判全天', !rec5.find(r => r.teacher.name === '國甲').onLeaveFullDay);
    // 已駁回的請假不算
    const rec4 = e.getRecommendations(target, schedule, teachers, date, [lv('國甲', '第一節'), lv('國甲', '第五節', { status: 'rejected' })], null);
    check('駁回的請假不算全天', !rec4.find(r => r.teacher.name === '國甲').onLeaveFullDay);
}

// ===== 跨模組一致性：存檔姓名維持原字串，各處「比對結果拿來找存檔資料」都對得上 =====
// 教師檔名為「王　明」（中間全形空白）。比對點與兩側用的正規化：
//   V1 推薦／衝堂／候選去重：兩側都 normalizeTeacherName（teacherName.js）
//   createTeacher 防重：兩側都 normalizeTeacherName；存檔姓名只 trim
//   teacherMerge：兩側都 normalizeTeacherName（只用來找屬性）；新名冊姓名維持課表原字串
//   teacherIdentity 解析、結算：兩側都用各自的 normName（全形空白轉半形＋trim）
//   importFromLegacyTeachers、rules isSelfSwapNamesOk、V2 刪除教師前的有課檢查、dataManager 時數：儲存姓名「精確相等」，
//     因此課表解析與建檔都不可改寫姓名
{
    const RAW = '王　明';
    const TI = await load('src/js/modules/v2/teacherIdentity.js');
    const { SettlementCalculator } = await load('src/js/modules/settlementCalculator.js');
    const mk = (t, p) => ({ 週次: '1', 節次: String(p), 年級: '7', 班級: '701', 教師姓名: t, 領域: '', 科目: '國文' });
    const parsed = new ScheduleParser().processRawData([mk(RAW, 1), mk(RAW, 2), mk(RAW, 3)]);
    const parsedName = parsed.teachers[0].name;
    const roster = [{ teacherId: 'T1', name: RAW, domains: ['國文'], homeroomClass: '7年1班' }];

    // 重新匯入：解析出的姓名與既有教師檔姓名精確相等 → importFromLegacyTeachers 的精確比對不會再新建一筆
    check('重匯：解析姓名與教師檔姓名精確相等（不會被當成新教師而重複建檔）', parsedName === roster[0].name, JSON.stringify(parsedName));
    eq(TI.resolveTeacherIdByName(roster, parsedName), { status: 'ok', teacherId: 'T1' }, '重匯後 teacherIdentity 仍解析得到 teacherId');
    const m = mergeMod.mergeTeacherAttributes(roster, parsed.teachers);
    eq([m[0].name, m[0].homeroomClass, m[0].domains], [RAW, '7年1班', ['國文']], '重匯合併：姓名維持原字串、導師班與領域帶回');

    // 自我調課：紀錄姓名取自教師檔 .name，rules isSelfSwapNamesOk 以 d.get(...) == myTeacherDoc.name 精確比對
    const selfSwapRecord = { originalTeacher: roster[0].name, swapTeacher: roster[0].name, substituteTeacher: roster[0].name };
    check('自我調課：紀錄姓名與教師檔 .name 完全相同（rules 精確比對可通過）',
        Object.values(selfSwapRecord).every(v => v === roster[0].name));
    // V1 推薦：只在課表出現的教師，推薦結果姓名維持課表原字串（之後會被存成紀錄姓名）
    const eng = new RecommendationEngine();
    const recs = eng.getRecommendations({ weekday: '週二', period: '第一節', className: '8年1班', subject: '數學', domain: '', originalTeacher: '原' },
        [{ teacher: RAW, weekday: '週一', period: '第一節', className: '7年1班', subject: '國文' }], [], '2026-11-17', []);
    eq(recs.map(r => r.teacher.name), [RAW], '推薦：課表原字串姓名不被改寫');
    // 建檔：存檔姓名只 trim
    const store = [];
    teacherMgr.__testHooks.dataSvc = {
        async listTeachers() { return store.map(t => ({ ...t })); },
        async createTeacher(p) { const t = { teacherId: 'N' + store.length, ...p }; store.push(t); return t; },
    };
    teacherMgr.__testHooks.logger = { async log() {} };
    await teacherMgr.createTeacher({ name: ' ' + RAW + ' ' });
    eq(store.map(t => t.name), [RAW], '建檔：存檔姓名只 trim，保留全形空白');
    let dup = false;
    try { await teacherMgr.createTeacher({ name: '王明' }); } catch (e) { dup = true; }
    check('建檔：「王明」與既有「王　明」視為同一人而擋下', dup);

    // 月結算：名冊「王　明」、課表原字串 → 每週 3 節對得上
    const sched = parsed.scheduleData.map(c => ({ ...c, subject: '國文', domain: '' }));
    const res = new SettlementCalculator().calculate(115, 10, sched, [], roster, {});
    const row = res.find(r => String(r.teacherName).replace(/　/g, ' ').trim() === RAW.replace(/　/g, ' ').trim());
    check('月結算：教師姓名對得上，每週 3 節', !!row && row.weeklyHours === 3, JSON.stringify(row));
    // 刪除教師前的有課檢查（v2-app deleteLegacyTeacher、getTeacherWeeklyHours 以精確姓名）
    const dm = new DataManager();
    dm.scheduleData = sched;
    eq(dm.getTeacherWeeklyHours(roster[0].name), 3, '刪除教師前的有課檢查：以教師檔姓名查得到 3 節課');
}

log0(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
