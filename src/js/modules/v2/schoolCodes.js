/**
 * 全國學校代碼（教育部）查詢：純邏輯 + 靜態 JSON 載入。
 *
 * 資料檔 src/data/school-codes.json 由 scripts/fetch-school-codes.mjs 產生，每筆：
 *   { c: 代碼(小寫), n: 主校名, l: 學制陣列, ct: 縣市, d: 行政區, a?: 同代碼其他校名 }
 * schoolId 直接採用代碼（小寫）；既有正式校 inhu 以別名表對應到 183511。
 */

/** MOE 代碼 → 既有 schoolId（正式站 inhu 早於本機制建立）。 */
export const SCHOOL_ID_ALIASES = Object.freeze({ '183511': 'inhu' });

const DATA_URL = new URL('../../../data/school-codes.json', import.meta.url).href;

/**
 * 搜尋用正規化：NFKC（全形轉半形）、臺→台、去空白、小寫，
 * 並把校名全稱縮成通用簡稱（國民中學→國中、國民小學→國小、高級中學→高中），
 * 使「新竹市立內湖國民中學」與資料檔的「市立內湖國中」能互相比對。
 */
export function normalizeQuery(s) {
    return String(s ?? '').normalize('NFKC').replace(/臺/g, '台').replace(/\s+/g, '').toLowerCase()
        .replace(/國民中學/g, '國中').replace(/國民小學/g, '國小').replace(/高級中學/g, '高中');
}

/** 代碼 → schoolId（先查別名表，否則小寫代碼）。 */
export function schoolIdForCode(code) {
    const c = String(code ?? '').trim().toLowerCase();
    return SCHOOL_ID_ALIASES[c] || c;
}

/** schoolId → MOE 代碼（反查別名；一般情況 schoolId 即代碼）。 */
export function codeForSchoolId(schoolId) {
    const id = String(schoolId ?? '').toLowerCase();
    for (const [code, sid] of Object.entries(SCHOOL_ID_ALIASES)) if (sid === id) return code;
    return id;
}

/** 以 schoolId（或代碼）在清單中找學校；找不到回 null。 */
export function findSchoolById(list, schoolId) {
    const code = codeForSchoolId(schoolId);
    return (list || []).find(s => s.c === code) || null;
}

// 每校的正規化比對字串只算一次（避免每次按鍵對 4000 校重做 NFKC／正規式）
const _hayCache = new WeakMap();
function haystacks(s) {
    let h = _hayCache.get(s);
    if (!h) {
        h = {
            names: [s.n, ...(s.a || [])].map(normalizeQuery),
            county: normalizeQuery(s.ct),
            district: normalizeQuery(s.d),
            code: normalizeQuery(s.c),
        };
        _hayCache.set(s, h);
    }
    return h;
}

/**
 * 搜尋學校。排序：代碼完全相符 > 代碼開頭 > 校名開頭 > 校名包含 > 縣市+校名（含行政區）組合。
 * 同級以代碼排序，結果最多 limit 筆。
 */
export function searchSchools(list, query, limit = 20) {
    const q = normalizeQuery(query);
    if (!q || !Array.isArray(list)) return [];
    const scored = [];
    for (const s of list) {
        const h = haystacks(s);
        let rank = 0;
        if (h.code === q) rank = 1;
        else if (h.code.startsWith(q)) rank = 2;
        else if (h.names.some(n => n.startsWith(q))) rank = 3;
        else if (h.names.some(n => n.includes(q))) rank = 4;
        else {
            const combos = h.names.flatMap(n => [h.county + n, h.county + h.district + n, h.district + n]);
            if (combos.some(c => c.includes(q))) rank = 5;
            else rank = countyPrefixMatch(h, q);   // 縣市簡寫：「新竹內湖」對「新竹市」
        }
        if (rank) scored.push({ s, rank });
    }
    scored.sort((a, b) => a.rank - b.rank || (a.s.c < b.s.c ? -1 : a.s.c > b.s.c ? 1 : 0));
    return scored.slice(0, limit).map(x => x.s);
}

/** 縣市簡寫組合：q 以縣市名的某個非空前綴（至少 2 字）開頭，其餘比對校名。例：「新竹內湖」→ 新竹(市) + 內湖。 */
function countyPrefixMatch(h, q) {
    const cty = h.county;
    for (let len = Math.min(cty.length, q.length - 1); len >= 2; len--) {
        if (!q.startsWith(cty.slice(0, len))) continue;
        const rest = q.slice(len);
        if (!rest) continue;
        if (h.names.some(n => n.includes(rest) || (h.district + n).includes(rest))) return 5;
    }
    return 0;
}

/** 顯示用學制字串，例如「高中／國中」。 */
export function levelsLabel(s) {
    return (s?.l || []).join('／');
}

/* ===== 載入（可注入 fetch，比照 schoolCalendar.js） ===== */

let _cache = null;
let _inflight = null;

/** 測試用：清掉快取。 */
export function _resetSchoolCodesCache() { _cache = null; _inflight = null; }

/**
 * 讀取同源 JSON（含快取）。失敗會丟錯，且不快取失敗結果（下次可重試）。
 * @returns {Promise<Array>} schools 陣列
 */
export async function loadSchoolCodes({ fetchImpl = (typeof fetch === 'function' ? fetch : null), url = DATA_URL } = {}) {
    if (_cache) return _cache;
    if (_inflight) return _inflight;
    if (!fetchImpl) throw new Error('無法載入學校代碼：此環境沒有 fetch');
    _inflight = (async () => {
        try {
            const res = await fetchImpl(url);
            if (!res.ok) throw new Error(`學校代碼載入失敗（HTTP ${res.status}）`);
            const data = await res.json();
            if (!data || !Array.isArray(data.schools)) throw new Error('學校代碼檔格式不正確');
            _cache = data.schools;
            return _cache;
        } finally {
            _inflight = null;
        }
    })();
    return _inflight;
}
