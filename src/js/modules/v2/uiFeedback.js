/**
 * V2 統一輕量錯誤/通知回饋層
 *
 * 取代 V2 程式路徑中原本混用的三種手法：阻斷式 alert()、純 console.error 靜默吞錯、
 * 一次性 bespoke toast。全部改走這裡的 notify() / notifyError() / setSyncStatus()。
 *
 * - notify()：優先委派 V1 既有 window.app.showToast()（見 src/js/app.js，內建 XSS escape
 *   與 #toast-container 疊加顯示）；該方法不存在時 fallback 自建可重複堆疊的 toast。
 * - notifyError()：把 Firestore 錯誤碼翻成繁體中文人話，未知碼則顯示情境詞 + 原始訊息。
 * - setSyncStatus()：頁面右上角顯示/隱藏「即時同步中斷」徽章。
 *
 * 全部函式皆防禦式：DOM 未就緒或內部例外一律吞掉，絕不拋出中斷呼叫端主流程。
 */

const FALLBACK_STACK_ID = 'v2-uifeedback-toast-stack';
const SYNC_BADGE_ID      = 'v2-sync-status-badge';
const VALID_TYPES        = new Set(['info', 'success', 'warning', 'error']);

const ERROR_CODE_MESSAGES = {
    'permission-denied':   '權限不足或身份已變更，請重新登入後再試',
    'unavailable':         '目前無法連線，恢復網路後會自動同步',
    'failed-precondition': '目前無法連線，恢復網路後會自動同步',
    'unauthenticated':     '登入已過期，請重新登入',
    'not-found':           '找不到資料，可能已被刪除或搬移',
    'already-exists':      '資料已存在，請重新整理頁面後再試',
    'resource-exhausted':  '系統目前忙碌中，請稍後再試',
};

let stylesInjected = false;

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function injectStyles() {
    if (stylesInjected || typeof document === 'undefined' || document.getElementById('v2-uifeedback-styles')) { stylesInjected = true; return; }
    const style = document.createElement('style');
    style.id = 'v2-uifeedback-styles';
    style.textContent = `
    #${FALLBACK_STACK_ID} { position: fixed; bottom: 24px; right: 24px; z-index: var(--z-toast);
        display: flex; flex-direction: column-reverse; gap: 8px; max-width: 320px; }
    .v2-uifeedback-toast { background: #1f2937; color: #fff; border-radius: 8px; padding: 10px 14px;
        font-size: 0.88rem; line-height: 1.5; box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        display: flex; align-items: flex-start; gap: 8px; }
    .v2-uifeedback-toast.success { background: #065f46; }
    .v2-uifeedback-toast.warning { background: #92400e; }
    .v2-uifeedback-toast.error   { background: #991b1b; }
    .v2-uifeedback-toast .v2-uifeedback-close { background: none; border: none; color: inherit;
        cursor: pointer; font-size: 1rem; line-height: 1; opacity: 0.75; padding: 0 0 0 6px; }
    .v2-uifeedback-toast .v2-uifeedback-close:hover { opacity: 1; }
    /* Stage 1 硬傷急救：徽章移入 header 內排版顯示（原 fixed 右上角與 toast/header 三重疊） */
    #${SYNC_BADGE_ID} { position: static; display: inline-block; margin-left: 8px; vertical-align: middle;
        background: #92400e; color: #fff; font-size: 0.8rem; font-weight: 600;
        padding: 4px 10px; border-radius: 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.2); }
    `;
    document.head.appendChild(style);
    stylesInjected = true;
}

function fallbackToast(message, type, durationMs) {
    if (typeof document === 'undefined' || !document.body) return;
    injectStyles();
    let stack = document.getElementById(FALLBACK_STACK_ID);
    if (!stack) {
        stack = document.createElement('div');
        stack.id = FALLBACK_STACK_ID;
        document.body.appendChild(stack);
    }
    const icons = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `v2-uifeedback-toast ${type}`;
    toast.innerHTML = `
        <span>${icons[type] || icons.info}</span>
        <span style="flex:1;">${escapeHtml(message).replace(/\n/g, '<br>')}</span>
        <button class="v2-uifeedback-close" aria-label="關閉">&times;</button>
    `;
    stack.appendChild(toast);
    const remove = () => toast.remove();
    toast.querySelector('.v2-uifeedback-close')?.addEventListener('click', remove);
    if (durationMs > 0) setTimeout(remove, durationMs);
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
        injectStyles();
        const badge = existing || document.createElement('div');
        if (!existing) {
            badge.id = SYNC_BADGE_ID;
            // Stage 1：徽章移入 header 內（原 fixed 右上角），找不到掛點時 fallback 回 body
            const mount = document.querySelector('.header-top') || document.body;
            mount.appendChild(badge);
        }
        badge.textContent = '⚠ 即時同步中斷';
        if (reason) badge.title = `代碼：${reason}`;
        else badge.removeAttribute('title');
    } catch (_) {
        // 防禦
    }
}
