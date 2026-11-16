/**
 * V2 表格列／卡片的純 HTML 組字函式（從 v2-app.js 抽出，供 node 下單元測試）。
 *
 * 資料全部來自 Firestore（一般教師可寫入任意欄位值），因此：
 *   - 文字內容與屬性值（data-id、title…）一律 escapeHtml()
 *   - class 內的值（角色）走白名單 pickAllowed()
 *   - 數字先轉型（toNum）
 * 不依賴 DOM、不依賴 Firebase，node 下可直接 import。
 */
import { escapeHtml, pickAllowed, toNum } from '../htmlEscape.js';
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
export function renderRecordRow(r, isApprover, impactNote = '') {
    const id = escapeHtml(r.recordId);
    return `
                <tr data-id="${id}">
                    <td data-label="日期" class="cell-primary">${escapeHtml(r.date || '')}</td>
                    <td data-label="節次">${escapeHtml(r.period || '')}</td>
                    <td data-label="班級">${escapeHtml(r.className || '')}</td>
                    <td data-label="原教師">${escapeHtml(r.originalTeacher || '')}</td>
                    <td data-label="代/調對象">${escapeHtml(r.substituteTeacher || r.swapTeacher || '')}</td>
                    <td data-label="類型">${escapeHtml(r.type || '')}${APPROVER_ROLES_FOR_BADGE.includes(r.initiatedByRole) ? ' <span class="v2-role-tag director">代發</span>' : ''}${r.isLegacy ? ' <span class="v2-legacy-badge" title="遷移自 V1 舊系統">舊系統</span>' : ''}${impactNote ? ` <span class="v2-impact-badge" title="${escapeHtml(impactNote)}">課表已變更</span>` : ''}</td>
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
/** 課表／教師異動後受影響的提示（純文字，呼叫端已算好）；回傳可直接接在 extraMeta 後的 HTML。 */
export function impactMetaHtml(note) {
    return note ? `<br><span class="v2-impact-note">⚠ 課表已變更：${escapeHtml(note)}</span>` : '';
}

export function renderPendingCard(r, cls, actionsHtml, extraMeta = '', detailHtml = '') {
    return `
        <div class="list-item list-item-${pickAllowed(cls, ['incoming', 'outgoing'])}" data-id="${escapeHtml(r.reqId)}">
            <div>
                ${stageLabel(r)}
                <strong>${escapeHtml(typeLabel(r))}</strong> ・ ${escapeHtml(r.date || '')} ${escapeHtml(r.period || '?')} ・ ${escapeHtml(r.className || '')} ${escapeHtml(r.subject || '')}
            </div>
            ${detailHtml}
            <div class="v2-pending-meta">
                發起：${escapeHtml(r.initiatedByName || r.initiatedBy || '')}${extraMeta} ・ ${escapeHtml(fmtDate(r.createdAt))}
                ${r.status === REQUEST_STATUS.REJECTED && r.rejectNote ? `<br>拒絕原因：${escapeHtml(r.rejectNote)}` : ''}
            </div>
            <div class="v2-pending-actions">${actionsHtml}</div>
        </div>`;
}

/* ===== P8：待辦卡片的決策資訊（時段 B、代課教師、假別、事由、同批調課） =====
   原本卡片只有「日期・節次・班級・科目」，同意的人看不到自己要換到哪一節，核准的人看不到代課教師、假別與事由。
   以下輸出的每個資料值都經 escapeHtml()（欄位來自 Firestore，一般教師可寫入任意值）；標籤文字是常數。 */

/** 是否為調課類（有時段 B）。 */
function isSwapLike(r) {
    return r.requestType === REQUEST_TYPES.SWAP || r.requestType === REQUEST_TYPES.MULTI_SWAP;
}

/** 時段 B 的純文字描述（無資料回傳空字串）：「2026-11-12 週四第三節 數學」。 */
export function describeSlotB(r) {
    const parts = [r.swapDate, `${r.swapWeekday || ''}${r.swapPeriod || ''}`.trim(), r.swapSubject]
        .map(v => String(v ?? '').trim()).filter(Boolean);
    return parts.join(' ');
}

/** 時段 A 的純文字描述：「2026-11-10 週二第二節 802 國文」。 */
export function describeSlotA(r) {
    const parts = [r.date, `${r.weekday || ''}${r.period || ''}`.trim(), r.className, r.subject]
        .map(v => String(v ?? '').trim()).filter(Boolean);
    return parts.join(' ');
}

function detailLine(label, valueHtml) {
    return `<div class="v2-pending-detail-line"><span class="v2-pending-detail-label">${label}</span>${valueHtml}</div>`;
}

/** 「待我同意」卡片：顯示對方的時段 B（調課類才有）。 */
export function renderConsentDetail(r) {
    if (!isSwapLike(r)) return '';
    const slotB = describeSlotB(r);
    if (!slotB && !r.swapTeacher) return '';
    const who = r.swapTeacher ? `（${escapeHtml(r.swapTeacher)} 的課）` : '';
    return `<div class="v2-pending-detail">${detailLine('時段 B', `${escapeHtml(slotB || '（未註明）')}${who}`)}</div>`;
}

/**
 * 「待我審核」卡片：代課教師或時段 B、假別、字號、事由，以及同批調課。
 * 假別與事由的來源：私有明細優先，沒有就退回父文件上的 leaveTypeName／reason（舊資料放在父文件）。
 * 兩處都沒有值時，依「明細讀取狀態」區分，不可把「讀不到」顯示成「未填」：
 *   ok／missing（含未提供）→ 未填；loading → 讀取中…；error → 明細讀取失敗；denied → 無權檢視
 * @param {Object} r 申請（公開欄位）
 * @param {{leaveType?:string, leaveTypeName?:string, reason?:string}|null} detail 私有明細；null＝沒有或讀不到
 * @param {{detailState?:'ok'|'missing'|'loading'|'error'|'denied', detailError?:boolean, related?:Array}} [opts]
 *        detailState：明細讀取狀態；detailError：舊參數，等同 detailState:'error'；related：同批其他申請
 */
export function renderApprovalDetail(r, detail, { detailState = '', detailError = false, related = [] } = {}) {
    const state = detailError ? 'error' : (detailState || 'ok');
    const lines = [];
    if (isSwapLike(r)) {
        lines.push(detailLine('時段 B', `${escapeHtml(describeSlotB(r) || '（未註明）')}${r.swapTeacher ? `（${escapeHtml(r.swapTeacher)} 的課）` : ''}`));
    } else if (r.substituteTeacher) {
        lines.push(detailLine('代課教師', escapeHtml(r.substituteTeacher)));
    }
    const leaveName = (detail && (detail.leaveTypeName || detail.leaveType)) || r.leaveTypeName || '';
    const reasonText = (detail && detail.reason) || r.reason || '';
    const missingText = state === 'loading' ? '讀取中…'
        : state === 'error' ? '明細讀取失敗，請重新整理後再審核'
        : state === 'denied' ? '無權檢視'
        : '未填';
    const missingHtml = `<span class="v2-pending-detail-${state === 'ok' || state === 'missing' ? 'empty' : state}">${escapeHtml(missingText)}</span>`;
    lines.push(detailLine('假別', leaveName ? escapeHtml(leaveName) : missingHtml));
    if (r.docNumber) lines.push(detailLine('字號', escapeHtml(r.docNumber)));
    lines.push(detailLine('事由', reasonText ? escapeHtml(reasonText) : missingHtml));
    const others = Array.isArray(related) ? related.filter(x => x && x.reqId !== r.reqId) : [];
    if (others.length) {
        const shown = others.slice(0, 5).map(x =>
            `<li>${escapeHtml(describeSlotA(x))} ↔ ${escapeHtml(describeSlotB(x) || '（未註明）')}${x.swapTeacher ? `（${escapeHtml(x.swapTeacher)}）` : ''}</li>`).join('');
        const more = others.length > 5 ? `<li>另有 ${toNum(others.length - 5)} 筆</li>` : '';
        lines.push(detailLine(`同批調課（另 ${toNum(others.length)} 筆）`, `<ul class="v2-pending-related">${shown}${more}</ul>`));
    }
    return `<div class="v2-pending-detail" data-approval-detail="${escapeHtml(r.reqId)}">${lines.join('')}</div>`;
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
