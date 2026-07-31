/**
 * 學期推導工具（Stage 2，RESEARCH-multitenancy-semester.md §5.3/§5.6/§8）
 *
 * semesterId 格式沿用 bootstrap 既有寫入值 `'114-2'`（民國學年-學期），與
 * settlementCalculator.js 既有的民國→西元換算邏輯同語系（見該檔 `_resolveMonth`）。
 *
 * 台灣學年度切分（與 settlementCalculator._resolveMonth 反向推導、互為驗證）：
 *   - 8 月～翌年 1 月 = 上學期（第 1 學期）
 *   - 2 月～7 月     = 下學期（第 2 學期）
 *   - 學年度起始月為 8 月：西元 y 年 8 月～翌年 1 月屬「民國 (y-1911) 學年度上學期」，
 *     同一學年度的 2～7 月則落在西元 (y+1) 年，屬「民國 (y-1911) 學年度下學期」。
 *
 * 反推公式：
 *   ROC 學年度 = 月份 >= 8 ? (西元年 - 1911) : (西元年 - 1912)
 *   學期       = (月份 >= 8 || 月份 === 1) ? 1 : 2
 *
 * 邊界自我檢查（與 settlementCalculator._resolveMonth 的正向換算比對，見
 * test/test-semester-utils.mjs）：
 *   2025-08-01 → '114-1'　2026-01-31 → '114-1'　2026-02-01 → '114-2'　2026-07-31 → '114-2'
 *   2026-08-01 → '115-1'（跨學年度）
 * 這組邊界與本專案 bootstrap 寫入的 `config.currentSemester = '114-2'`（見
 * src/js/modules/v2/README.md，撰寫於 2026 年 7 月）完全吻合，可互相印證公式方向沒有錯。
 */

const SEMESTER_ID_RE = /^(\d{2,4})-([12])$/;

/** 西元年、月（1-12）換算成 ROC 學年度（數字）。 */
function academicYearROC(year, month) {
    return month >= 8 ? (year - 1911) : (year - 1912);
}

/** 月份（1-12）換算成學期（1 或 2）。8 月～翌年 1 月為第 1 學期，2～7 月為第 2 學期。 */
function semesterOfMonth(month) {
    return (month >= 8 || month === 1) ? 1 : 2;
}

/**
 * 西元日期字串（YYYY-MM-DD）換算成 semesterId（'114-2' 格式）。
 * 格式不對時回傳 null（不噴錯，呼叫端可自行決定 fallback，與既有
 * schoolDataService.addYearsToDateString 的「格式不對就不強行處理」慣例一致）。
 *
 * 驗收修復（輕 12）：原版只驗證字串「長得像」YYYY-MM-DD（正則比對），沒有驗證日期本身
 * 是否真的存在——例如 '2026-02-31'（2 月沒有 31 日）、'2026-04-31'（4 月只有 30 天）會通過
 * 正則但不是合法日期。改用 `new Date(year, month-1, day)` 往返驗證：JS Date 建構子對超出
 * 範圍的日/月會自動進位（例如 2 月 31 日會被當成 3 月 3 日），往返比對建構出來的年/月/日
 * 是否與輸入完全一致，不一致就代表輸入本身不是合法日期，回傳 null。
 * @param {string} dateStr
 * @returns {string|null}
 */
export function dateToSemesterId(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return null;
    const year  = Number(m[1]);
    const month = Number(m[2]);
    const day   = Number(m[3]);
    if (month < 1 || month > 12) return null;
    const roundTrip = new Date(year, month - 1, day);
    if (roundTrip.getFullYear() !== year || roundTrip.getMonth() !== month - 1 || roundTrip.getDate() !== day) {
        return null;
    }
    const rocYear   = academicYearROC(year, month);
    const semester  = semesterOfMonth(month);
    return `${rocYear}-${semester}`;
}

/**
 * 今天（本機時區）所屬的 semesterId。供 bootstrap 在 `config.currentSemester`
 * 缺席時的 fallback（見 v2-app.js bootstrap、報告 §8 Stage 2 一列：報告未明確指定
 * fallback 規則時的取捨，理由見該處呼叫端註解）。
 * @returns {string}
 */
export function todaySemesterId() {
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return dateToSemesterId(dateStr);
}

/**
 * 解析 semesterId 字串，回傳 { rocYear, semester }（皆為 number）或 null（格式不合法）。
 * @param {string} sid
 */
export function parseSemesterId(sid) {
    const m = SEMESTER_ID_RE.exec(sid || '');
    if (!m) return null;
    return { rocYear: Number(m[1]), semester: Number(m[2]) };
}

/** semesterId 格式是否合法（'114-2' 這種形狀）。 */
export function isValidSemesterId(sid) {
    return parseSemesterId(sid) !== null;
}

/**
 * 比較兩個 semesterId 的先後順序（數值比較，不是字串字典序——字串排序在
 * ROC 學年度跨百年時會失效，報告 §5.3 已註明「實務上無關」但這裡既然要寫比較函式，
 * 順手做對不吃虧，成本可忽略）。
 * @returns {number} 負值＝a 早於 b；0＝相同；正值＝a 晚於 b；格式不合法者視為最小值排最前面
 */
export function compareSemesterId(a, b) {
    const pa = parseSemesterId(a);
    const pb = parseSemesterId(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    if (pa.rocYear !== pb.rocYear) return pa.rocYear - pb.rocYear;
    return pa.semester - pb.semester;
}

/**
 * 下一個學期的 semesterId（供「開新學期」UI 帶預設值）。
 * 第 1 學期 → 同年度第 2 學期；第 2 學期 → 次一學年度第 1 學期。
 * @param {string} sid
 * @returns {string|null} 格式不合法時回傳 null
 */
export function nextSemesterId(sid) {
    const p = parseSemesterId(sid);
    if (!p) return null;
    return p.semester === 1 ? `${p.rocYear}-2` : `${p.rocYear + 1}-1`;
}
