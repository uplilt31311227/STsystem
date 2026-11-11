/**
 * V2 表格列／卡片的純 HTML 組字函式（從 v2-app.js 抽出，供 node 下單元測試）。
 *
 * 資料全部來自 Firestore（一般教師可寫入任意欄位值），因此：
 *   - 文字內容與屬性值（data-id、title…）一律 escapeHtml()
 *   - class 內的值（角色）走白名單 pickAllowed()
 *   - 數字先轉型（toNum）
 * 不依賴 DOM、不依賴 Firebase，node 下可直接 import。
 */
import { escapeHtml, pickAllowed } from '../htmlEscape.js';
import { REQUEST_STATUS, REQUEST_TYPES } from './schemaConstants.js';

/** 角色 class 白名單（對應 features.css 的 .v2-role-tag.*）。 */
export const ROLE_CLASS_WHITELIST = ['admin', 'director', 'section_chief', 'teacher'];

/** 格式化時間（Date 解析失敗時 toLocaleString 回傳 "Invalid Date"，不會拋錯、輸出不含 HTML 特殊字元）。 */
export function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
    catch { return iso || ''; }
}

/** 日誌 details 可能是字串（新格式，JSON 字串）或舊的 map/null：一律轉成純字串後再截長。 */
export function detailsToText(details, max = 160) {
    let s;
    if (typeof details === 'string') s = details;
    else {
        try { s = JSON.stringify(details); } catch { s = ''; }
    }
    return String(s ?? '').slice(0, max);
}

/** 操作日誌表格的一列（renderLogsTab）。 */
export function renderLogRow(l) {
    const role = l.actor?.role;
    const targetId = l.targetId ? ' / ' + String(l.targetId).slice(-6) : '';
    return `
                <tr>
                    <td data-label="時間">${escapeHtml(fmtDate(l.timestamp))}</td>
                    <td data-label="操作者">${escapeHtml(l.actor?.name || l.actor?.email || '—')}</td>
                    <td data-label="角色"><span class="v2-role-tag ${pickAllowed(role, ROLE_CLASS_WHITELIST)}">${escapeHtml(role || '—')}</span></td>
                    <td data-label="動作">${escapeHtml(l.action)}</td>
                    <td data-label="對象">${escapeHtml(l.targetType || '')}${escapeHtml(targetId)}</td>
                    <td data-label="詳情"><code style="font-size:0.75rem;">${escapeHtml(detailsToText(l.details))}</code></td>
                </tr>`;
}

const APPROVER_ROLES_FOR_BADGE = ['admin', 'director', 'section_chief'];

/** 全校調代課紀錄表格的一列（renderRecordsTab）。 */
export function renderRecordRow(r, isApprover) {
    const id = escapeHtml(r.recordId);
    return `
                <tr data-id="${id}">
                    <td data-label="日期" class="cell-primary">${escapeHtml(r.date || '')}</td>
                    <td data-label="節次">${escapeHtml(r.period || '')}</td>
                    <td data-label="班級">${escapeHtml(r.className || '')}</td>
                    <td data-label="原教師">${escapeHtml(r.originalTeacher || '')}</td>
                    <td data-label="代/調對象">${escapeHtml(r.substituteTeacher || r.swapTeacher || '')}</td>
                    <td data-label="類型">${escapeHtml(r.type || '')}${APPROVER_ROLES_FOR_BADGE.includes(r.initiatedByRole) ? ' <span class="v2-role-tag director">代發</span>' : ''}${r.isLegacy ? ' <span class="v2-legacy-badge" title="遷移自 V1 舊系統">舊系統</span>' : ''}</td>
                    <td data-label="發起">${escapeHtml(r.initiatedByName || '')}</td>
                    <td class="cell-actions">
                        <button class="btn btn-secondary btn-sm v2-download-pdf" data-id="${id}">下載 PDF</button>
                        ${isApprover ? `<button class="btn btn-danger btn-sm v2-admin-delete" data-id="${id}">刪除</button>` : ''}
                    </td>
                </tr>`;
}

/** 待辦卡片的階段標籤（常數 HTML，不含資料）。 */
export function stageLabel(r) {
    switch (r.status) {
        case REQUEST_STATUS.PENDING_SWAP_CONSENT: return '<span class="v2-status-tag pending">⏳ 待同意</span>';
        case REQUEST_STATUS.PENDING_APPROVAL:      return '<span class="v2-status-tag pending">📋 待核准</span>';
        case REQUEST_STATUS.APPROVED:              return '<span class="v2-status-tag approved">✅ 已核准</span>';
        case REQUEST_STATUS.REJECTED:              return '<span class="v2-status-tag rejected">❌ 被拒絕</span>';
        default: return '';
    }
}

/** 待辦卡片的類型文字（純文字，輸出處負責跳脫）。 */
export function typeLabel(r) {
    return ({
        [REQUEST_TYPES.SUBSTITUTE]: '代課',
        [REQUEST_TYPES.SWAP]:       '調課',
        [REQUEST_TYPES.MULTI_SWAP]: '多重調課',
    }[r.requestType] || r.type || '調課');
}

/**
 * 待辦卡片。cls 為呼叫端傳入的常數（incoming／outgoing），仍以白名單檢查；
 * actionsHtml / extraMeta 是呼叫端以本檔 consent/approval/mine 動作函式或常數產生的受信任 HTML
 * （其中 data-id 已跳脫；extraMeta 內的資料值已跳脫）。
 */
export function renderPendingCard(r, cls, actionsHtml, extraMeta = '') {
    return `
        <div class="list-item list-item-${pickAllowed(cls, ['incoming', 'outgoing'])}" data-id="${escapeHtml(r.reqId)}">
            <div>
                ${stageLabel(r)}
                <strong>${escapeHtml(typeLabel(r))}</strong> ・ ${escapeHtml(r.date || '')} ${escapeHtml(r.period || '?')} ・ ${escapeHtml(r.className || '')} ${escapeHtml(r.subject || '')}
            </div>
            <div class="v2-pending-meta">
                發起：${escapeHtml(r.initiatedByName || r.initiatedBy || '')}${extraMeta} ・ ${escapeHtml(fmtDate(r.createdAt))}
                ${r.status === REQUEST_STATUS.REJECTED && r.rejectNote ? `<br>拒絕原因：${escapeHtml(r.rejectNote)}` : ''}
            </div>
            <div class="v2-pending-actions">${actionsHtml}</div>
        </div>`;
}

/** 同意按鈕：純「同意」／「拒絕」。 */
export function consentActions(r) {
    const id = escapeHtml(r.reqId);
    return `<button class="btn btn-primary btn-sm v2-consent-btn" data-id="${id}">同意</button>
         <button class="btn btn-secondary btn-sm v2-reject-btn" data-id="${id}">拒絕</button>`;
}

export function approvalActions(r) {
    const id = escapeHtml(r.reqId);
    return `<button class="btn btn-primary btn-sm v2-final-approve-btn" data-id="${id}">核准並產生 PDF</button>
         <button class="btn btn-secondary btn-sm v2-reject-btn" data-id="${id}">駁回</button>`;
}

export function mineActions(r) {
    const id = escapeHtml(r.reqId);
    if (r.status === REQUEST_STATUS.REJECTED) {
        return `<button class="btn btn-secondary btn-sm v2-dismiss-btn" data-id="${id}">我知道了</button>`;
    }
    if (r.status === REQUEST_STATUS.APPROVED) return '';
    return `<button class="btn btn-danger btn-sm v2-cancel-btn" data-id="${id}">撤回</button>`;
}
