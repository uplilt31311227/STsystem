/**
 * 對話框共用的無障礙行為（P8）
 *
 * 全站所有 .modal（靜態、動態、richDialog、confirmDialog）都走這一支，不要各寫一份：
 *   - role="dialog"、aria-modal="true"、aria-labelledby（指向標題；沒有標題時用 aria-label）
 *   - 開啟時焦點移入對話框；關閉後焦點還原到開啟前的元素（還在畫面上才還原）
 *   - Esc 關閉（多層對話框時只關最上面一層）
 *   - Tab／Shift+Tab 在對話框內循環，不會跑到背景
 *   - 點背景：只有「不含輸入欄位」的對話框才會關閉；含 input／textarea／select 的不關閉，避免已輸入的內容遺失
 *
 * 純 DOM 行為，不改任何業務邏輯。onRequestClose 由呼叫端提供（通常是原本的取消流程）。
 */

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

let _idSeq = 0;
/** 目前開啟中的對話框堆疊（最後一個為最上層）。 */
const _stack = [];

/**
 * 最近一次使用者操作的元素（焦點移動或點擊）。
 * 按鈕被防連點暫時 disabled 時，瀏覽器會讓它失去焦點（activeElement 變 body），
 * 之後才開對話框就找不到「開啟前的焦點」；所以另外記下最近操作的元素當後備。
 */
let _lastActor = null;
if (typeof document !== 'undefined') {
    const remember = (e) => {
        const t = e.target;
        if (t && t.nodeType === 1 && t !== document.body) {
            _lastActor = t.closest ? (t.closest('button, a[href], input, select, textarea, [role="button"], [tabindex]') || t) : t;
        }
    };
    document.addEventListener('focusin', remember, true);
    document.addEventListener('click', remember, true);
}

/** 還原焦點；目標暫時 disabled（防連點處理中）時，等它恢復後再試，最多約 2 秒。 */
function restoreFocus(el, tries = 0) {
    if (!el || !el.isConnected || typeof el.focus !== 'function') return;
    // 重試期間若已有其他對話框開啟（堆疊非空），且目標不在最上層對話框內：放棄，不搶走新對話框的焦點。
    // 目標就在最上層對話框內（巢狀對話框關閉後回到父對話框的按鈕）則仍要還原。
    if (tries > 0 && _stack.length && !_stack[_stack.length - 1].modal.contains(el)) return;
    try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (document.activeElement !== el && tries < 20) setTimeout(() => restoreFocus(el, tries + 1), 100);
}

function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden], .hidden')) return false;
    return true;
}

/** 對話框內可聚焦的元素（略過隱藏者）。 */
export function getFocusable(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter(el => isVisible(el) && el.getAttribute('aria-hidden') !== 'true');
}

/** 對話框是否含輸入欄位（含輸入者點背景不關閉）。 */
export function hasInputs(root) {
    return !!root.querySelector('input:not([type="hidden"]):not([type="button"]), textarea, select');
}

function onDocKeydown(e) {
    const top = _stack[_stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        top.requestClose?.();
        return;
    }
    if (e.key === 'Tab') {
        const items = getFocusable(top.modal);
        if (!items.length) { e.preventDefault(); top.modal.focus(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        const inside = top.modal.contains(active);
        if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
    }
}

/**
 * 啟用對話框的無障礙行為。
 * @param {HTMLElement} modal  .modal 外層元素
 * @param {Object} [o]
 * @param {string} [o.labelledBy]  標題元素 id；省略時取對話框內第一個 h2／h3／h4，沒有就用 label
 * @param {string} [o.label]       沒有可見標題時的 aria-label
 * @param {Function} [o.onRequestClose]  Esc／點背景（若允許）時呼叫；省略則 Esc 與點背景皆不動作
 * @param {boolean} [o.closeOnBackdrop]  明確指定點背景是否關閉；預設「不含輸入欄位才關閉」
 * @param {HTMLElement|string} [o.initialFocus]  開啟時焦點目標（元素或選擇器）；預設第一個可聚焦元素
 * @param {HTMLElement} [o.returnFocusTo]  關閉後焦點還原目標；預設開啟前的 activeElement
 * @returns {{release:Function}}
 */
export function activateModal(modal, o = {}) {
    if (!modal) return { release() {} };
    if (modal._a11y) return modal._a11y;

    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    let titleId = o.labelledBy;
    if (!titleId) {
        const h = modal.querySelector('h2, h3, h4');
        if (h) {
            if (!h.id) h.id = `modal-title-${++_idSeq}`;
            titleId = h.id;
        }
    }
    if (titleId) { modal.setAttribute('aria-labelledby', titleId); modal.removeAttribute('aria-label'); }
    else if (o.label) modal.setAttribute('aria-label', o.label);
    if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');

    const active = document.activeElement && document.activeElement !== document.body && !modal.contains(document.activeElement)
        ? document.activeElement : null;
    const opener = o.returnFocusTo || active || (_lastActor && !modal.contains(_lastActor) ? _lastActor : null);
    const closeOnBackdrop = o.closeOnBackdrop ?? !hasInputs(modal);
    const entry = { modal, requestClose: o.onRequestClose };
    _stack.push(entry);
    if (_stack.length === 1) document.addEventListener('keydown', onDocKeydown, true);

    const onBackdrop = (e) => {
        if (e.target !== modal) return;
        if (closeOnBackdrop && o.onRequestClose) o.onRequestClose();
    };
    modal.addEventListener('click', onBackdrop);

    // 焦點移入：preventScroll，內容很長時不要把對話框捲到底
    const focusTarget = typeof o.initialFocus === 'string' ? modal.querySelector(o.initialFocus) : o.initialFocus;
    const first = focusTarget || getFocusable(modal)[0] || modal;
    try { first.focus({ preventScroll: true }); } catch { /* ignore */ }

    const handle = {
        release() {
            if (!modal._a11y) return;
            modal._a11y = null;
            modal.removeEventListener('click', onBackdrop);
            const i = _stack.indexOf(entry);
            if (i >= 0) _stack.splice(i, 1);
            if (_stack.length === 0) document.removeEventListener('keydown', onDocKeydown, true);
            restoreFocus(opener);
        },
    };
    modal._a11y = handle;
    return handle;
}

/**
 * 靜態對話框（index.html 內以 .hidden 切換者）：觀察 class 變化，開啟時啟用、關閉時釋放。
 * Esc 的動作＝點對話框內的關閉鈕（.modal-close）或取消鈕，沿用原本的關閉流程，不另寫一套。
 * @param {HTMLElement} [root=document]
 * @param {Object<string,string>} [cancelSelectors] 以對話框 id 指定「Esc 時要點的按鈕」選擇器
 */
export function watchStaticModals(root = document, cancelSelectors = {}) {
    const modals = Array.from(root.querySelectorAll('.modal'));
    modals.forEach((modal) => {
        if (modal._a11yWatched) return;
        modal._a11yWatched = true;
        const findCloser = () => {
            const sel = cancelSelectors[modal.id];
            return (sel && modal.querySelector(sel)) || modal.querySelector('.modal-close');
        };
        const sync = () => {
            const open = !modal.classList.contains('hidden');
            if (open && !modal._a11y) {
                // 對話框顯示後才取得焦點（需等 hidden 移除、版面生效）
                activateModal(modal, {
                    onRequestClose: () => { findCloser()?.click(); },
                    closeOnBackdrop: false, // 靜態對話框原本就各自綁定背景點擊；這裡不重複觸發
                });
            } else if (!open && modal._a11y) {
                modal._a11y.release();
            }
        };
        new MutationObserver(sync).observe(modal, { attributes: true, attributeFilter: ['class'] });
        sync();
    });
}
