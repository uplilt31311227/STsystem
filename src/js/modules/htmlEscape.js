/**
 * 共用 HTML 跳脫工具（全專案唯一實作）
 *
 * 動態組 HTML（innerHTML / insertAdjacentHTML / outerHTML）時，所有來自 Firestore、
 * 課表檔、使用者輸入的值都必須先經 escapeHtml()，無論放在文字內容或屬性值。
 * 純函式、不依賴 DOM，node 下可直接 import 測試。
 */

/** 反引號也跳脫：舊版瀏覽器 / 某些解析情境下可當屬性值引號。 */
const ESC_MAP = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;'
};

/**
 * 跳脫 & < > " ' `。null / undefined 回傳空字串；數字等其他型別先轉字串。
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, c => ESC_MAP[c]);
}

/** 與 escapeHtml 相同（app.js 歷史上使用的短名稱）。 */
export const esc = escapeHtml;

/**
 * 深層複製並跳脫所有字串（陣列與一般物件遞迴；其他型別原樣）。不修改呼叫端資料。
 * 供 pdfGenerator 把整份參數一次跳脫後再插值。
 */
export function escapeDeep(v) {
    if (typeof v === 'string') return escapeHtml(v);
    if (Array.isArray(v)) return v.map(escapeDeep);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
        const o = {};
        for (const k of Object.keys(v)) o[k] = escapeDeep(v[k]);
        return o;
    }
    return v;
}

/**
 * 轉成有限數字供插值；非有限數字回傳 fallback（預設 0）。
 * 數字插值前先轉型，避免字串偽裝成數字。
 */
export function toNum(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * 驗證動態 href / src：只放行 http(s)、blob:、mailto: 與同源相對路徑；
 * 其餘（javascript:、data: 等）回傳 '#'。回傳值已跳脫，可直接放進屬性。
 */
export function safeUrl(url) {
    const s = String(url ?? '').trim();
    if (/^(https?:|blob:|mailto:)/i.test(s) || /^(?![a-z][a-z0-9+.-]*:)/i.test(s)) {
        return escapeHtml(s);
    }
    return '#';
}

/**
 * 角色 / 樣式 class 等「只能是白名單值」的插值：不在白名單回傳空字串。
 */
export function pickAllowed(value, allowed) {
    const s = String(value ?? '');
    return allowed.includes(s) ? s : '';
}

/** escapeHtml 的反向（只還原本模組產生的六種實體；& 最後還原以免二次解碼）。 */
export function unescapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&#96;/g, '`').replace(/&amp;/g, '&');
}

/**
 * 檔名用：還原 escapeHtml 的實體後，移除檔名不允許的字元（\ / : * ? " < > | 與控制字元）。
 * pdfGenerator 入口會把整份參數 escapeDeep（為了 HTML 版面），檔名要用原值。
 */
export function safeFileName(value) {
    return unescapeHtml(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim();
}
