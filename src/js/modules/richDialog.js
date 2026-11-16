/**
 * 預覽／確認對話框（課表匯入預覽、備份還原預覽共用）
 *
 * 沿用既有 .modal／.modal-content／.modal-header／.modal-body／.modal-actions（components.css），
 * 不使用原生 alert／confirm／prompt，也不用 inline 事件處理器（CSP）。
 *
 * 所有進入 HTML 的文字一律經 escapeHtml()：
 *   - 標題、按鈕、勾選說明、確認字樣由本模組跳脫；
 *   - 內文由呼叫端以本檔的 rdText／rdList／rdTable／rdNotice 組出（它們內部跳脫），
 *     這幾個 helper 回傳的是「已安全的 HTML 片段」，不要把未跳脫字串直接拼進去。
 */

import { escapeHtml } from './htmlEscape.js';
import { activateModal } from './modalA11y.js';

/** 一段文字（保留換行）。 */
export function rdText(text, cls = '') {
    return `<p class="rich-dialog-pre ${escapeHtml(cls)}">${escapeHtml(text)}</p>`;
}

/** 小標題 */
export function rdHeading(text) {
    return `<h4>${escapeHtml(text)}</h4>`;
}

/** 項目清單。items 為純文字陣列。 */
export function rdList(items) {
    const list = (items || []).map(t => `<li>${escapeHtml(t)}</li>`).join('');
    return list ? `<ul>${list}</ul>` : '';
}

/** 提示框：kind 'warn' | 'danger'。 */
export function rdNotice(kind, text) {
    const cls = kind === 'danger' ? 'rich-dialog-danger' : 'rich-dialog-warn';
    return `<div class="${cls}" role="alert">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
}

/** 表格。headers 為文字陣列；rows 為「儲存格文字」陣列的陣列（皆跳脫）。 */
export function rdTable(headers, rows) {
    const th = (headers || []).map(h => `<th>${escapeHtml(h)}</th>`).join('');
    const tr = (rows || []).map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table class="data-table data-table-compact"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

let _seq = 0;

/**
 * 開啟對話框，回傳 Promise<boolean>（確認 true；取消、點背景、Esc 為 false）。
 * @param {Object} o
 * @param {string} o.title
 * @param {string} [o.target]        醒目的目標列（如「匯入到學期：115-1」）
 * @param {string} [o.bodyHtml]      由 rd* helper 組出的 HTML
 * @param {string} [o.checkboxLabel] 有值時顯示勾選框，勾選後才能確認
 * @param {string} [o.phrase]        有值時要求輸入與此完全相同的字樣才能確認
 * @param {string} [o.phraseHint]    字樣輸入框上方說明
 * @param {string} [o.confirmText]
 * @param {string} [o.cancelText]
 * @param {boolean} [o.danger]
 * @param {boolean} [o.confirmDisabled] 為 true 時確認鈕恆為停用（只能看、不能確認）
 * @param {string} [o.optionLabel]   有值時顯示「選填勾選」（不影響確認鈕），預設不勾
 * @param {{checked:boolean}} [o.optionRef] 選填勾選的狀態會寫進這個物件（呼叫端在 Promise 結束後讀取）
 */
export function openRichDialog({
    title = '確認', target = '', bodyHtml = '', checkboxLabel = '', phrase = '', phraseHint = '',
    confirmText = '確認', cancelText = '取消', danger = false, confirmDisabled = false,
    optionLabel = '', optionRef = null,
} = {}) {
    const id = `rich-dialog-${++_seq}`;
    const root = document.getElementById('modal-root') || document.body;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = id;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', `${id}-title`);
    modal.innerHTML = `
        <div class="modal-content rich-dialog-content">
            <div class="modal-header">
                <h3 id="${id}-title">${escapeHtml(title)}</h3>
                <button type="button" class="modal-close" data-rd="close" aria-label="關閉">&times;</button>
            </div>
            <div class="modal-body rich-dialog-body">
                ${target ? `<div class="rich-dialog-target">${escapeHtml(target)}</div>` : ''}
                ${bodyHtml}
                ${checkboxLabel ? `<label class="rich-dialog-check"><input type="checkbox" data-rd="ack"><span>${escapeHtml(checkboxLabel)}</span></label>` : ''}
                ${optionLabel ? `<label class="rich-dialog-check"><input type="checkbox" data-rd="option"><span>${escapeHtml(optionLabel)}</span></label>` : ''}
                ${phrase ? `<label class="rich-dialog-check rich-dialog-check-block">${escapeHtml(phraseHint || '請輸入確認字樣：')}<strong> ${escapeHtml(phrase)}</strong><input type="text" class="rich-dialog-phrase" data-rd="phrase" autocomplete="off"></label>` : ''}
                <div class="modal-actions">
                    <button type="button" class="btn btn-secondary" data-rd="cancel">${escapeHtml(cancelText)}</button>
                    <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-rd="confirm" disabled>${escapeHtml(confirmText)}</button>
                </div>
            </div>
        </div>`;
    root.appendChild(modal);

    const q = (k) => modal.querySelector(`[data-rd="${k}"]`);
    const confirmBtn = q('confirm');
    const ack = q('ack');
    const phraseInput = q('phrase');

    const refresh = () => {
        const ackOk = !ack || ack.checked;
        const phraseOk = !phraseInput || phraseInput.value.trim() === phrase;
        confirmBtn.disabled = confirmDisabled || !(ackOk && phraseOk);
    };
    const optionBox = q('option');
    if (optionRef) optionRef.checked = false;
    optionBox?.addEventListener('change', () => { if (optionRef) optionRef.checked = optionBox.checked; });
    ack?.addEventListener('change', refresh);
    phraseInput?.addEventListener('input', refresh);
    refresh();

    return new Promise((resolve) => {
        // role／aria-modal／標題關聯、Esc、焦點移入與還原、Tab 循環、含輸入者點背景不關閉：全由 modalA11y 處理
        // （焦點進入：字樣輸入框 > 勾選框 > 取消鈕；preventScroll 避免內容很長時被捲到底）
        let a11y = null;
        const finish = (result) => {
            a11y?.release();
            modal.remove();
            resolve(result);
        };
        confirmBtn.addEventListener('click', () => { if (!confirmBtn.disabled) finish(true); });
        q('cancel').addEventListener('click', () => finish(false));
        q('close').addEventListener('click', () => finish(false));
        a11y = activateModal(modal, {
            labelledBy: `${id}-title`,
            onRequestClose: () => finish(false),
            initialFocus: phraseInput || ack || q('cancel'),
        });
    });
}
