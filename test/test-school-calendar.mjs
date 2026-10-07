/**
 * 學校行事曆 → 每月上課週數（單元）
 *
 * 黃金值來自真實公開行事曆（test/fixtures/school-calendar-115-1.json，由 ICS 轉成
 * events.list 回應格式）；期望值為獨立手算，寫死不由被測函式產生。
 * 其餘邊界案例用小型手造事件，註解內附手算。全程不連網（fetch 一律注入假的）。
 */

import fs from 'node:fs';
import {
    computeWeeksByMonth, eventDays, findSemesterRanges, fetchCalendarEvents,
    buildEventsUrl, calendarErrorMessage, CalendarError,
} from '../src/js/modules/schoolCalendar.js';
import { Suite, eq } from './scenarios/harness.mjs';

const suite = new Suite('學校行事曆週數（單元）');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/school-calendar-115-1.json', import.meta.url), 'utf8'));

const allDay = (summary, start, endExcl) => ({ summary, start: { date: start }, end: { date: endExcl || start } });
const semester = (a, b) => [allDay('正式上課', a), allDay('休業式', b)];

await suite.case('黃金值：115-1 真實行事曆 → 8:1 9:4 10:4 11:5 12:4 1:3，合計 21 週、96 個上課日', () => {
    const r = computeWeeksByMonth(fixture.items, 115);
    eq(fixture.items.length, 294, 'fixture 事件數');
    eq(r.semesters, [{ start: '2026-08-31', end: '2027-01-20' }], '學期範圍（8/31 正式上課；另有同日開學典禮事件）');
    eq(r.holidays, ['2026-09-25', '2026-09-28', '2026-10-09', '2026-10-26', '2026-11-02', '2026-12-25', '2027-01-01'], '放假日');
    eq(r.weeks, { 1: 3, 8: 1, 9: 4, 10: 4, 11: 5, 12: 4 }, '各月週數');
    eq(Object.values(r.weeks).reduce((a, b) => a + b, 0), 21, '合計週數');
    eq(r.schoolDayCount, 96, '上課日數');
    eq(r.missingMonths, [2, 3, 4, 5, 6, 7], '無資料月份（2–7 月不覆寫）');
});

await suite.case('標記判讀：開學準備週／開學工作會議不算學期開始；開學日、結業式可用', () => {
    const ev = [
        allDay('開學準備週', '2026-08-24', '2026-08-29'),
        allDay('開學工作會議(09:30)', '2026-08-27'),
        allDay('開學日', '2026-08-31'),
        allDay('結業式', '2026-09-11'),
    ];
    eq(findSemesterRanges(ev).semesters, [{ start: '2026-08-31', end: '2026-09-11' }], '只有開學日命中');
});

await suite.case('邊界：週末補課日算上課日，且週數歸入該週第一個上課日（手算 9 月）', () => {
    // 學期 9/7(一)–9/25(五) → 週 9/7、9/14、9/21 共 3 週。補課 9/20(日) 屬週 9/14–9/20，該週已計，故仍 3 週。
    const base = semester('2026-09-07', '2026-09-25');
    eq(computeWeeksByMonth([...base, allDay('補行上班補課', '2026-09-20')], 115).weeks, { 9: 3 }, '補課日同週不重複計');
    // 放假 9/14–9/18（整週）→ 剩 2 週；補課 9/19(六) 屬 9/14 那週，該週原本無上課日 → 多 1 週 = 3
    const hol = allDay('停課', '2026-09-14', '2026-09-19');
    eq(computeWeeksByMonth([...base, hol], 115).weeks, { 9: 2 }, '無補課基準 2 週');
    const r = computeWeeksByMonth([...base, hol, allDay('補課', '2026-09-19')], 115);
    eq(r.weeks, { 9: 3 }, '週末補課使無上課日的週變成 1 週');
    eq(r.makeups, ['2026-09-19'], '補課日清單');
});

await suite.case('邊界：整週放假不計週；放假只剩單日仍算 1 週（手算）', () => {
    // 學期 9/7–9/25 共 3 週。放假 9/14–9/18（多日全天事件，end 不含 9/19）→ 剩 9/7 週與 9/21 週 = 2 週
    const base = semester('2026-09-07', '2026-09-25');
    eq(computeWeeksByMonth([...base, allDay('停課', '2026-09-14', '2026-09-19')], 115).weeks, { 9: 2 }, '整週停課');
    // 放假 9/21–9/24（四天），只剩 9/25(五) 上課 → 該週仍算 1 週 → 3 週
    eq(computeWeeksByMonth([...base, allDay('颱風假', '2026-09-21', '2026-09-25')], 115).weeks, { 9: 3 }, '剩一天仍算一週');
});

await suite.case('邊界：寒假／暑假字樣的事件不算放假（不扣上課日）', () => {
    const ev = [...semester('2026-09-07', '2026-09-11'), allDay('寒假放假日期公告', '2026-09-08'), allDay('暑假放假', '2026-09-09')];
    eq(computeWeeksByMonth(ev, 115).holidays, [], '無放假日');
    eq(computeWeeksByMonth(ev, 115).schoolDayCount, 5, '5 個上課日');
});

await suite.case('邊界：跨月週歸入該週第一個上課日所在月份（手算）', () => {
    // 學期 9/28(一)–10/9(五)：週 9/28（含 9/28–10/2）→ 9 月；週 10/5 → 10 月
    eq(computeWeeksByMonth(semester('2026-09-28', '2026-10-09'), 115).weeks, { 9: 1, 10: 1 }, '9/28 週歸 9 月');
    // 9/28、9/29 放假 → 該週第一個上課日是 9/30（仍 9 月）；若 9/28–10/1 全放假，第一個上課日是 10/2 → 歸 10 月
    const ev = [...semester('2026-09-28', '2026-10-09'), allDay('放假', '2026-09-28', '2026-10-02')];
    eq(computeWeeksByMonth(ev, 115).weeks, { 9: 0, 10: 2 }, '第一個上課日 10/2 → 10 月，9 月有學期覆蓋但 0 週');
});

await suite.case('邊界：UTC 時刻事件換算台北日期（跨日）', () => {
    // 2026-09-06T17:00:00Z = 台北 9/7 01:00（週一）；2026-09-11T15:30:00Z = 台北 9/11 23:30（仍 9/11，週五），
    // 結束 16:00Z = 台北 9/12 00:00 整，視為不含 9/12
    const ev = [
        { summary: '正式上課', start: { dateTime: '2026-09-06T17:00:00Z' }, end: { dateTime: '2026-09-06T18:00:00Z' } },
        { summary: '休業式', start: { dateTime: '2026-09-11T15:30:00Z' }, end: { dateTime: '2026-09-11T16:00:00Z' } },
    ];
    eq(eventDays(ev[0]), ['2026-09-07'], 'UTC 9/6 17:00 → 台北 9/7');
    eq(eventDays(ev[1]), ['2026-09-11'], 'UTC 9/11 15:30 → 台北 9/11（尚未過午夜）');
    eq(findSemesterRanges(ev).semesters, [{ start: '2026-09-07', end: '2026-09-11' }], '學期範圍');
    // 跨過台北午夜的有時刻事件（23:30 → 隔日 00:30）覆蓋兩天
    eq(eventDays({ start: { dateTime: '2026-09-11T15:30:00Z' }, end: { dateTime: '2026-09-11T16:30:00Z' } }),
       ['2026-09-11', '2026-09-12'], '跨午夜覆蓋兩天');
    // 有偏移量的時刻、結束剛好台北 00:00 視為不含當天
    eq(eventDays({ start: { dateTime: '2026-09-08T09:00:00+08:00' }, end: { dateTime: '2026-09-10T00:00:00+08:00' } }),
       ['2026-09-08', '2026-09-09'], '結束 00:00 不含當天');
    eq(eventDays({ start: { date: '2026-09-08' }, end: { date: '2026-09-11' } }), ['2026-09-08', '2026-09-09', '2026-09-10'], '全天 end 不含');
});

await suite.case('邊界：上下兩學期；學期外的週末與課程不計；學年度視窗外的事件忽略', () => {
    const ev = [...semester('2026-08-31', '2026-09-04'), ...semester('2027-02-08', '2027-02-26'),
                allDay('正式上課', '2025-09-01'), allDay('休業式', '2025-09-05')];   // 上一學年度的事件
    const r = computeWeeksByMonth(ev, 115);
    // 8/31–9/4 同一週歸 8 月（第一個上課日），9 月有學期覆蓋但 0 週
    eq(r.weeks, { 8: 1, 9: 0, 2: 3 }, '8 月 1 週、9 月 0 週、2 月 3 週');
    eq(r.semesters.length, 3, '三段學期範圍被偵測（含上學年度）');
    eq(r.schoolDayCount, 5 + 15 - 0, '視窗內上課日：8/31–9/4 共 5、2/8–2/26 共 15');
});

await suite.case('邊界：找不到學期標記 → 所有月份都沒有資料，不丟例外', () => {
    const r = computeWeeksByMonth([allDay('校慶運動會', '2026-11-07'), allDay('段考', '2026-10-20')], 115);
    eq(r.weeks, {}, '沒有任何覆寫');
    eq(r.missingMonths, [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7], '12 個月都缺');
    // 有開始、沒結束 → 不成學期，列入 unpairedStarts
    const r2 = computeWeeksByMonth([allDay('正式上課', '2026-08-31')], 115);
    eq(r2.weeks, {}, '只有開始標記不成學期');
    eq(r2.unpairedStarts, ['2026-08-31'], '記錄未配對的開始標記');
});

await suite.case('L2：補課在學期外不計（暑假補課不產生月份）；與放假同日或標題同時含放假與補課，以放假優先', () => {
    // 學期 9/7–9/11（1 週）。暑假 7/15 的補課不在學期內 → 不產生 7 月、不計上課日
    const base = semester('2026-09-07', '2026-09-11');
    const r = computeWeeksByMonth([...base, allDay('補課', '2027-07-15'), allDay('補課', '2026-09-19')], 115);
    eq(r.weeks, { 9: 1 }, '學期外補課（7/15、學期結束後 9/19）不計');
    eq(r.makeups, [], '學期外補課不列入');
    eq(r.schoolDayCount, 5, '仍只有 5 個上課日');
    // 標題同時含「颱風假」與「補課」：視為放假，9/8（二）不上課，不得被反過來算成上課日（週數不變仍 1 週，但上課日 4）
    const r2 = computeWeeksByMonth([...base, allDay('颱風假(不補課)', '2026-09-08')], 115);
    eq(r2.schoolDayCount, 4, '標題含放假與補課 → 放假優先，上課日 4');
    eq(r2.makeups, [], '不列為補課');
    // 同一天同時有放假事件與補課事件（週六 9/12 學期內，補課；再加一筆放假）→ 放假優先
    const sem2 = semester('2026-09-07', '2026-09-18');
    const r3 = computeWeeksByMonth([...sem2, allDay('補課', '2026-09-12'), allDay('放假', '2026-09-12')], 115);
    eq(r3.schoolDayCount, 10, '9/12 放假優先，不加上課日');
    eq(r3.makeups, [], '放假優先時不列補課');
});

await suite.case('L3：開學典禮在正式上課前一天 → 學期從正式上課開始；無正式上課時開學日優先於開學典禮', () => {
    // 開學典禮 8/28(五)、正式上課 8/31(一)、休業式 9/11：學期應為 8/31–9/11，而非 8/28 起
    const ev = [allDay('開學典禮', '2026-08-28'), allDay('正式上課', '2026-08-31'), allDay('休業式', '2026-09-11')];
    eq(findSemesterRanges(ev).semesters, [{ start: '2026-08-31', end: '2026-09-11' }], '正式上課優先');
    // 手算週數：8/31 週、9/7 週 = 2 週，8 月（第一個上課日 8/31）1 週、9 月 1 週
    eq(computeWeeksByMonth(ev, 115).weeks, { 8: 1, 9: 1 }, '週數不因開學典禮多算');
    // 無正式上課：開學日 > 開學典禮
    const ev2 = [allDay('開學典禮', '2026-08-28'), allDay('開學日', '2026-08-31'), allDay('休業式', '2026-09-11')];
    eq(findSemesterRanges(ev2).semesters, [{ start: '2026-08-31', end: '2026-09-11' }], '開學日優先於開學典禮');
    // 只有開學典禮：仍可當開始標記
    eq(findSemesterRanges([allDay('開學典禮', '2026-08-28'), allDay('休業式', '2026-09-11')]).semesters,
       [{ start: '2026-08-28', end: '2026-09-11' }], '僅開學典禮時採用');
});

/* ---------- fetch（注入假 fetch） ---------- */

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

await suite.case('fetch：URL 帶 timeMin/timeMax（+08:00）與 singleEvents 等參數，日曆 ID 需 encode', () => {
    const url = buildEventsUrl({ calendarId: 'abc@group.calendar.google.com', apiKey: 'FAKE', rocYear: 115 });
    eq(url.startsWith('https://www.googleapis.com/calendar/v3/calendars/abc%40group.calendar.google.com/events?'), true, '路徑');
    eq(url.includes('key=FAKE'), true, 'key');
    eq(url.includes('timeMin=2026-08-01T00%3A00%3A00%2B08%3A00'), true, 'timeMin');
    eq(url.includes('timeMax=2027-08-01T00%3A00%3A00%2B08%3A00'), true, 'timeMax');
    eq(['singleEvents=true', 'orderBy=startTime', 'maxResults=2500'].every(s => url.includes(s)), true, '固定參數');
});

await suite.case('fetch：分頁合併（nextPageToken 帶入下一次請求）', async () => {
    const urls = [];
    const pages = [
        { items: [allDay('A', '2026-09-01')], nextPageToken: 'T2' },
        { items: [allDay('B', '2026-09-02')], nextPageToken: 'T3' },
        { items: [allDay('C', '2026-09-03')] },
    ];
    const fetchImpl = async (u) => { urls.push(u); return jsonRes(pages[urls.length - 1]); };
    const items = await fetchCalendarEvents({ calendarId: 'x', apiKey: 'FAKE', rocYear: 115, fetchImpl });
    eq(items.map(i => i.summary), ['A', 'B', 'C'], '三頁合併');
    eq(urls.length, 3, '請求 3 次');
    eq([urls[0].includes('pageToken'), urls[1].includes('pageToken=T2'), urls[2].includes('pageToken=T3')], [false, true, true], 'pageToken 傳遞');
});

await suite.case('fetch：403／404／網路錯誤各對應一句中文提示', async () => {
    const run = async (fetchImpl) => {
        try { await fetchCalendarEvents({ calendarId: 'x', apiKey: 'FAKE', rocYear: 115, fetchImpl }); }
        catch (e) { return e; }
        return null;
    };
    const e403 = await run(async () => jsonRes({}, 403));
    const e404 = await run(async () => jsonRes({}, 404));
    const eNet = await run(async () => { throw new TypeError('Failed to fetch'); });
    const e500 = await run(async () => jsonRes({}, 500));
    eq([e403 instanceof CalendarError, e403.code, e404.code, eNet.code, e500.code], [true, 'forbidden', 'notfound', 'network', 'http'], '錯誤碼');
    eq(calendarErrorMessage(e403).includes('403'), true, '403 提示');
    eq(calendarErrorMessage(e404).includes('404'), true, '404 提示');
    eq(calendarErrorMessage(eNet).includes('網路'), true, '網路提示');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
