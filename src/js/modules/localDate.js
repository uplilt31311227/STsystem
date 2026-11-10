/**
 * 本地日期工具
 *
 * 為什麼需要：`new Date().toISOString().split('T')[0]` 取的是 UTC 日期，
 * 台灣（UTC+8）在 00:00–07:59 會得到「前一天」；`new Date('YYYY-MM-DD')` 則被當成
 * UTC 午夜解析，與本地的 getDay()/getDate() 混用在非 UTC+8 時區會偏移。
 * 純日期（YYYY-MM-DD）一律用本檔函式，時間戳（createdAt 等）仍用 toISOString()。
 */

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Date → 本地時區的 YYYY-MM-DD。 */
export function formatLocalDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 'YYYY-MM-DD' → 本地午夜的 Date。
 * 格式不符時退回 `new Date(str)`（保留既有容錯行為，例如 '2026/11/11' 或含時間的字串）。
 */
export function parseLocalDate(str) {
    const m = YMD_RE.exec(str || '');
    if (!m) return new Date(str);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 今天的 YYYY-MM-DD（本地時區）。 */
export function todayLocal() {
    return formatLocalDate(new Date());
}

/** YYYY-MM-DD 加減天數（本地日曆運算，跨月、跨年、閏年皆正確）。格式不對原樣回傳。 */
export function addDaysLocal(str, days) {
    if (!YMD_RE.test(str || '')) return str;
    const d = parseLocalDate(str);
    d.setDate(d.getDate() + days);
    return formatLocalDate(d);
}
