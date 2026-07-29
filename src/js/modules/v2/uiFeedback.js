/**
 * V2 統一輕量錯誤/通知回饋層
 *
 * 取代 V2 程式路徑中原本混用的三種手法：阻斷式 alert()、純 console.error 靜默吞錯、
 * 一次性 bespoke toast。全部改走這裡的 notify() / notifyError() / setSyncStatus()。
 *
 * - notify()：優先委派 V1 既有 window.app.showToast()（見 src/js/app.js，內建 XSS escape
 *   與 #toast-container 疊加顯示）；該方法不存在時 fallback 自建 toast，但 Stage 3 起改
 *   共用同一個 #toast-container 與 .toast/.toast-{type} class（視覺定義於
 *   src/css/components.css），不再自行注入 CSS。
 * - notifyError()：把 Firestore 錯誤碼翻成繁體中文人話，未知碼則顯示情境詞 + 原始訊息。
 * - setSyncStatus()：頁面右上角顯示/隱藏「即時同步中斷」徽章（樣式見 features.css
 *   #v2-sync-status-badge，Stage 3 起改為靜態 CSS，不再注入）。
 *
 * 全部函式皆防禦式：DOM 未就緒或內部例外一律吞掉，絕不拋出中斷呼叫端主流程。
 */

const SYNC_BADGE_ID = 'v2-sync-status-badge';
const VALID_TYPES    = new Set(['info', 'success', 'warning', 'error']);

const ERROR_CODE_MESSAGES = {
    'permission-denied':   '權限不足或身份已變更，請重新登入後再試',
    'unavailable':         '目前無法連線，恢復網路後會自動同步',
    'failed-precondition': '目前無法連線，恢復網路後會自動同步',
    'unauthenticated':     '登入已過期，請重新登入',
    'not-found':           '找不到資料，可能已被刪除或搬移',
    'already-exists':      '資料已存在，請重新整理頁面後再試',
    'resource-exhausted':  '系統目前忙碌中，請稍後再試',
};

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** fallback 路徑：window.app.showToast 不可用時，仍共用 #toast-container 與 .toast class
 * （結構、show/hide 動畫皆比照 app.js 的 showToast，僅程式路徑獨立，視覺完全共用）。 */
function fallbackToast(message, type, durationMs) {
    if (typeof document === 'undefined' || !document.body) return;
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const icons = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <span class="toast-body">${escapeHtml(message).replace(/\n/g, '<br>')}</span>
        <button class="toast-close">&times;</button>
    `;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    const dismiss = () => {
        toast.classList.remove('show');
        toast.classList.add('hide');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    };
    toast.querySelector('.toast-close').addEventListener('click', dismiss);
    if (durationMs > 0) setTimeout(dismiss, durationMs);
}

/** 顯示一則通知。錯誤類至少顯示 8 秒，即使呼叫端傳入較短的 durationMs。 */
export function notify(message, type = 'info', durationMs = 4000) {
    try {
        const t = VALID_TYPES.has(type) ? type : 'info';
        const duration = t === 'error' ? Math.max(durationMs, 8000) : durationMs;
        if (typeof window !== 'undefined' && typeof window.app?.showToast === 'function') {
            window.app.showToast(message, t, duration);
            return;
        }
        fallbackToast(message, t, duration);
    } catch (_) {
        // 防禦：通知失敗不可中斷呼叫端主流程
    }
}

function normalizeCode(code) {
    if (!code) return '';
    const s = String(code);
    return s.includes('/') ? s.split('/').pop() : s;
}

/** 把 Firebase 錯誤碼翻成人話；context 是中文情境詞（如「即時同步」），會前綴在訊息中。 */
export function notifyError(err, context = '') {
    try {
        const prefix = context ? `${context}失敗：` : '';
        const human  = ERROR_CODE_MESSAGES[normalizeCode(err && err.code)];
        const message = human ? `${prefix}${human}` : `${prefix}${(err && (err.message || err.code)) || '發生未知錯誤'}`;
        notify(message, 'error');
    } catch (_) {
        // 防禦
    }
}

/** 顯示/隱藏右上角「即時同步中斷」徽章。reason（如 err.code）只放進 title 提示，不直接顯示原始代碼。 */
export function setSyncStatus(ok, reason) {
    try {
        if (typeof document === 'undefined' || !document.body) return;
        const existing = document.getElementById(SYNC_BADGE_ID);
        if (ok) { existing?.remove(); return; }
        const badge = existing || document.createElement('div');
        if (!existing) {
            badge.id = SYNC_BADGE_ID;
            // Stage 1：徽章移入 header 使用者資訊區（原 fixed 右上角）。掛在 .header-top 會插入
            // justify-content:space-between 的第 3 個 flex item，把 .user-auth-section 從右緣擠向
            // 中央（桌機實測位移 465px）；改掛進 .user-auth-section 內部，找不到掛點時 fallback 回 body。
            const mount = document.querySelector('.user-auth-section') || document.body;
            mount.appendChild(badge);
        }
        badge.textContent = '⚠ 即時同步中斷';
        if (reason) badge.title = `代碼：${reason}`;
        else badge.removeAttribute('title');
    } catch (_) {
        // 防禦
    }
}
