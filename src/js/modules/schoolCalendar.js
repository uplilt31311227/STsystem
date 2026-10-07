/**
 * 學校行事曆 → 每月上課週數
 *
 * 純函式（日期換算、學期／放假／補課判讀、週數統計）與 fetch（Google Calendar API v3）分離，
 * 前者可直接以 fixture 單元測試，後者由呼叫端注入 fetchImpl 以便 mock。
 *
 * 規則：
 * - 日期一律換成台北（+08:00）當地日期；全天事件用 start.date / end.date（end 不含）。
 * - 學期開始標記 /正式上課|開學典禮|開學日/，結束標記 /休業式|結業式/。
 *   每個開始標記配其後最近的結束標記；多個開始標記指向同一個結束標記時取最早的
 *   （例：8/31 正式上課，與學期中另一場「開學典禮」宣導活動屬同一學期）。
 * - 放假 /放假|補假|停課|颱風假/（且不含 寒假|暑假）整段不上課；補課 /補行上班|補課/ 算上課日。
 * - 上課日 = 學期內週一至週五，扣放假，加補課。
 * - 一週（週一至週日）只要有 ≥1 個上課日算 1 週，歸入該週第一個上課日所在月份。
 */

export const SEMESTER_START_RE = /正式上課|開學典禮|開學日/;
export const SEMESTER_END_RE   = /休業式|結業式/;
export const HOLIDAY_RE        = /放假|補假|停課|颱風假/;
export const NOT_HOLIDAY_RE    = /寒假|暑假/;
export const MAKEUP_RE         = /補行上班|補課/;

const TAIPEI_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 86400 * 1000;

/* ===== 日期工具（以 UTC 午夜表示純日期，避免本機時區影響） ===== */

function ymdToUtc(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
}
function utcToYmd(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** ISO dateTime（任何偏移）換成台北當地的 { ymd, msOfDay } */
export function taipeiLocal(dateTime) {
    const t = Date.parse(dateTime);
    if (Number.isNaN(t)) return null;
    const shifted = t + TAIPEI_OFFSET_MS;
    const msOfDay = ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
    return { ymd: utcToYmd(shifted - msOfDay), msOfDay };
}

/**
 * 事件覆蓋的每個台北當地日期（含頭含尾，已處理全天事件 end 不含）。
 * @returns {string[]} YYYY-MM-DD 陣列；日期資料缺失回 []
 */
export function eventDays(ev) {
    if (!ev || !ev.start) return [];
    let first, lastInclusive;
    if (ev.start.date) {
        first = ev.start.date;
        const endExcl = ev.end?.date;
        lastInclusive = endExcl ? utcToYmd(ymdToUtc(endExcl) - DAY_MS) : first;
        if (ymdToUtc(lastInclusive) < ymdToUtc(first)) lastInclusive = first;
    } else if (ev.start.dateTime) {
        const s = taipeiLocal(ev.start.dateTime);
        if (!s) return [];
        first = s.ymd;
        lastInclusive = first;
        if (ev.end?.dateTime) {
            const e = taipeiLocal(ev.end.dateTime);
            // 結束時刻剛好是台北 00:00 視為不含當天
            if (e) lastInclusive = e.msOfDay === 0 ? utcToYmd(ymdToUtc(e.ymd) - DAY_MS) : e.ymd;
            if (ymdToUtc(lastInclusive) < ymdToUtc(first)) lastInclusive = first;
        }
    } else {
        return [];
    }
    const out = [];
    for (let t = ymdToUtc(first); t <= ymdToUtc(lastInclusive); t += DAY_MS) out.push(utcToYmd(t));
    return out;
}

/* ===== 判讀 ===== */

/**
 * 找出學期範圍。
 * @returns {{ semesters: Array<{start:string,end:string}>, unpairedStarts: string[] }}
 */
function startTier(title) {
    if (/正式上課/.test(title)) return 0;
    if (/開學日/.test(title)) return 1;
    return 2;   // 開學典禮
}

export function findSemesterRanges(events) {
    const starts = [];
    const ends = [];
    for (const ev of events) {
        const title = ev.summary || '';
        const days = eventDays(ev);
        if (!days.length) continue;
        if (SEMESTER_START_RE.test(title)) starts.push({ day: days[0], tier: startTier(title) });
        if (SEMESTER_END_RE.test(title))   ends.push(days[days.length - 1]);
    }
    starts.sort((a, b) => a.day.localeCompare(b.day));
    ends.sort();
    // 同一個結束標記對到多個開始標記時：優先序「正式上課」＞「開學日」＞「開學典禮」，
    // 同優先序取最早。避免開學前一個工作日辦開學典禮時，學期被提早一天而多算一週。
    const byEnd = new Map();
    const unpairedStarts = [];
    for (const s of starts) {
        const e = ends.find(x => x >= s.day);
        if (!e) { unpairedStarts.push(s.day); continue; }
        const cur = byEnd.get(e);
        if (!cur || s.tier < cur.tier || (s.tier === cur.tier && s.day < cur.day)) byEnd.set(e, s);
    }
    const semesters = [...byEnd.entries()].map(([end, s]) => ({ start: s.day, end })).sort((a, b) => a.start.localeCompare(b.start));
    return { semesters, unpairedStarts };
}

function collectDays(events, includeRe, excludeRe) {
    const set = new Set();
    for (const ev of events) {
        const title = ev.summary || '';
        if (!includeRe.test(title)) continue;
        if (excludeRe && excludeRe.test(title)) continue;
        for (const d of eventDays(ev)) set.add(d);
    }
    return set;
}

/**
 * 由事件算出每月上課週數。
 * @param {Array} events - Calendar API events.list 的 items
 * @param {number} rocYear - 學年度（民國），範圍為 (rocYear+1911)-08-01 起一年
 * @returns {{ weeks: Object<number,number>, missingMonths: number[], semesters: Array,
 *             schoolDayCount: number, holidays: string[], makeups: string[], unpairedStarts: string[] }}
 *   weeks 只含有學期覆蓋的月份（可為 0 週）；missingMonths 為其餘月份（以 8 至 7 月排序）。
 */
export function computeWeeksByMonth(events, rocYear) {
    const winStart = Date.UTC(rocYear + 1911, 7, 1);
    const winEnd   = Date.UTC(rocYear + 1912, 7, 1);
    const inWindow = (ymd) => { const t = ymdToUtc(ymd); return t >= winStart && t < winEnd; };

    const { semesters, unpairedStarts } = findSemesterRanges(events);
    const holidays = collectDays(events, HOLIDAY_RE, NOT_HOLIDAY_RE);
    const rawMakeups = collectDays(events, MAKEUP_RE);

    const covered = new Set();
    const schoolDays = new Set();
    for (const sem of semesters) {
        for (let t = ymdToUtc(sem.start); t <= ymdToUtc(sem.end); t += DAY_MS) {
            const ymd = utcToYmd(t);
            if (!inWindow(ymd)) continue;
            covered.add(new Date(t).getUTCMonth() + 1);
            const dow = new Date(t).getUTCDay();
            if (dow >= 1 && dow <= 5 && !holidays.has(ymd)) schoolDays.add(ymd);
        }
    }
    // 補課只在學期範圍內才算上課日（暑假等學期外的「補課」事件不計）；
    // 與放假同一天（含標題同時含放假與補課，該日已列入 holidays）以放假優先。
    const inSemester = (ymd) => semesters.some(sem => ymd >= sem.start && ymd <= sem.end);
    const makeups = new Set([...rawMakeups].filter(ymd => !holidays.has(ymd) && inSemester(ymd)));
    for (const ymd of makeups) {
        if (!inWindow(ymd)) continue;
        schoolDays.add(ymd);
        covered.add(Number(ymd.slice(5, 7)));
    }

    const weeks = {};
    for (const m of covered) weeks[m] = 0;
    const seenWeeks = new Set();
    for (const ymd of [...schoolDays].sort()) {
        const t = ymdToUtc(ymd);
        const dow = (new Date(t).getUTCDay() + 6) % 7;      // 週一 = 0
        const monday = t - dow * DAY_MS;
        if (seenWeeks.has(monday)) continue;
        seenWeeks.add(monday);
        weeks[Number(ymd.slice(5, 7))] += 1;
    }

    const order = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
    return {
        weeks,
        missingMonths: order.filter(m => !(m in weeks)),
        semesters,
        schoolDayCount: schoolDays.size,
        holidays: [...holidays].filter(inWindow).sort(),
        makeups: [...makeups].filter(inWindow).sort(),
        unpairedStarts,
    };
}

/* ===== Calendar API ===== */

export class CalendarError extends Error {
    constructor(code, message) { super(message); this.name = 'CalendarError'; this.code = code; }
}

export function buildEventsUrl({ calendarId, apiKey, rocYear, pageToken }) {
    const timeMin = `${rocYear + 1911}-08-01T00:00:00+08:00`;
    const timeMax = `${rocYear + 1912}-08-01T00:00:00+08:00`;
    const q = [
        `key=${encodeURIComponent(apiKey)}`,
        `timeMin=${encodeURIComponent(timeMin)}`,
        `timeMax=${encodeURIComponent(timeMax)}`,
        'singleEvents=true',
        'orderBy=startTime',
        'maxResults=2500',
    ];
    if (pageToken) q.push(`pageToken=${encodeURIComponent(pageToken)}`);
    return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q.join('&')}`;
}

/**
 * 抓整個學年度的事件（含分頁）。fetchImpl 預設用全域 fetch，測試時注入假的。
 * @throws {CalendarError} code: forbidden | notfound | http | network
 */
export async function fetchCalendarEvents({ calendarId, apiKey, rocYear, fetchImpl }) {
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    const items = [];
    let pageToken;
    do {
        let res;
        try {
            res = await doFetch(buildEventsUrl({ calendarId, apiKey, rocYear, pageToken }));
        } catch (err) {
            throw new CalendarError('network', '網路錯誤');
        }
        if (!res.ok) {
            if (res.status === 403) throw new CalendarError('forbidden', 'HTTP 403');
            if (res.status === 404) throw new CalendarError('notfound', 'HTTP 404');
            throw new CalendarError('http', `HTTP ${res.status}`);
        }
        const body = await res.json();
        if (Array.isArray(body.items)) items.push(...body.items);
        pageToken = body.nextPageToken;
    } while (pageToken);
    return items;
}

/** 錯誤轉成給使用者看的一句中文 */
export function calendarErrorMessage(err) {
    switch (err?.code) {
        case 'forbidden': return '日曆存取被拒（403）：API key 的限制可能尚未生效，或網域不在允許清單內，請稍後再試或檢查 key 設定';
        case 'notfound':  return '找不到日曆（404）：請確認日曆 ID 正確，且日曆已設為公開';
        case 'network':   return '網路錯誤，無法連線到 Google 日曆，請檢查網路後再試';
        default:          return `讀取日曆失敗（${err?.message || '未知錯誤'}）`;
    }
}

/** 一次完成：抓取後統計。 */
export async function importWeeksFromCalendar(opts) {
    const events = await fetchCalendarEvents(opts);
    return { ...computeWeeksByMonth(events, opts.rocYear), eventCount: events.length };
}
