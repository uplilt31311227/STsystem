/**
 * 給使用者看的錯誤文字（審計 UX-M24）
 *
 * 規則：
 *   1. Firebase 錯誤碼（含 auth/ 前綴）一律翻成繁體中文；
 *   2. 訊息本身若已是中文（本專案自己丟的錯誤）直接使用；
 *   3. 訊息是英文或工程詞（console、Firebase、undefined…）時，改用呼叫端給的白話備用文字，
 *      原始錯誤只留在 console.error，不顯示給使用者。
 *
 * 本檔不依賴 DOM，可在 node 直接測試。
 */

export const ERROR_CODE_MESSAGES = {
    // Firestore
    'permission-denied':   '權限不足或身份已變更，請重新登入後再試',
    'unavailable':         '目前無法連線，恢復網路後會自動同步',
    // failed-precondition 在本專案幾乎都是「查詢需要的索引還沒建好」，與網路無關，不可說成「恢復網路會好」
    'failed-precondition': '查詢所需的資料庫索引尚未建立，請聯絡管理者',
    'unauthenticated':     '登入已過期，請重新登入',
    'not-found':           '找不到資料，可能已被刪除或搬移',
    'already-exists':      '資料已存在，請重新整理頁面後再試',
    'resource-exhausted':  '系統目前忙碌中，請稍後再試',
    // Firebase Auth（錯誤碼去掉 auth/ 前綴後比對）
    'invalid-credential':          'Email 或密碼錯誤',
    'wrong-password':              'Email 或密碼錯誤',
    'user-not-found':              'Email 或密碼錯誤',
    'invalid-email':               'Email 格式不正確',
    'user-disabled':               '此帳號已被停用，請聯絡教務主任',
    'too-many-requests':           '嘗試次數過多，請稍後再試',
    'network-request-failed':      '網路連線失敗，請檢查網路後再試',
    'popup-closed-by-user':        '登入視窗已關閉，請再按一次登入',
    'popup-blocked':               '瀏覽器擋住了登入視窗，請允許彈出視窗後再試',
    'cancelled-popup-request':     '登入請求已取消，請再按一次登入',
    'unauthorized-domain':         '此網址尚未授權登入，請聯絡系統管理者',
    'email-already-in-use':        '這個 Email 已經註冊過，請改用登入',
    'weak-password':               '密碼太簡單，請至少使用 6 個字元',
    'requires-recent-login':       '為了安全，請重新登入後再操作',
    'operation-not-allowed':       '這種登入方式尚未開放，請聯絡系統管理者',
    'internal-error':              '系統暫時發生問題，請稍後再試',
    'app-check-token-invalid':     '安全驗證失敗，請重新整理頁面後再試',
};

const CJK = /[㐀-鿿]/;

export function normalizeErrorCode(code) {
    if (!code) return '';
    const s = String(code);
    return s.includes('/') ? s.split('/').pop() : s;
}

/** 這段文字是否適合直接給使用者看：含中文，且沒有工程詞。 */
export function isUserReadable(text) {
    if (!text) return false;
    const s = String(text);
    if (!CJK.test(s)) return false;
    return !/(console|undefined|\[object|Firebase:|TypeError|ReferenceError|Cannot read)/i.test(s);
}

/**
 * 轉成可顯示的白話訊息。
 * @param {any} err
 * @param {string} [fallback] 找不到對照、訊息又不是中文時顯示的文字
 */
export function friendlyErrorMessage(err, fallback = '發生未預期的錯誤，請重新整理後再試；若持續發生請聯絡系統管理者') {
    const human = ERROR_CODE_MESSAGES[normalizeErrorCode(err && err.code)];
    if (human) return human;
    const msg = err && err.message;
    if (isUserReadable(msg)) return String(msg);
    return fallback;
}

/** Email 欄位存檔前檢查（UX-M13）：可留空（代表取消指派），有填就必須像 Email；合格回 null。 */
export function emailFormatError(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Email 格式不正確，請檢查後再輸入（例如 name@example.com）。這次沒有儲存。';
}
