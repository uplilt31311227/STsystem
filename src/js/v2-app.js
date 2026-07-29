/**
 * V2 權限系統入口
 *
 * 僅在 ?v2=1 參數或 preview hostname 下啟動。
 * 與原 app.js 並存：app.js 先完成基本 UI 與課表載入，
 * 再由 v2-app.js 在 DOMContentLoaded 之後接管：
 * - 攔截「確認並產生表單」按鈕，改走 V2 同意流程
 * - 顯示 V2 專屬頁籤（待辦 / 教師管理 / 操作日誌）
 * - 依角色隱藏/顯示功能
 */

import { isV2Enabled }          from './modules/v2/envDetector.js';
import * as authGuard           from './modules/v2/authGuardV2.js';
import * as roleSvc             from './modules/v2/roleService.js';
import * as dataSvc             from './modules/v2/schoolDataService.js';
import * as teacherMgr          from './modules/v2/teacherAccountManager.js';
import * as requestSvc          from './modules/v2/pendingRequestService.js';
import * as logger              from './modules/v2/operationLogger.js';
import * as legacyMigration     from './modules/v2/legacyMigrationService.js';
import { LOG_ACTIONS, LOG_TARGET_TYPES, ROLES, REQUEST_STATUS, REQUEST_TYPES } from './modules/v2/schemaConstants.js';
import * as authMod from './modules/authService.js';
import { notify, notifyError, setSyncStatus } from './modules/v2/uiFeedback.js';

/* ===== 樣式注入 ===== */

function injectV2Styles() {
    if (document.getElementById('v2-styles')) return;
    const style = document.createElement('style');
    style.id = 'v2-styles';
    style.textContent = `
    .v2-only { display: none; }
    body.v2-active .v2-only { display: revert; }

    /* v2.0.0 三層角色顯隱：
       .v2-admin-only       — 兼容舊類別，效果等同 .v2-approver-only（director + section_chief 可見）
       .v2-approver-only    — 限 director 或 section_chief 可見（核准 / 紀錄 / 月結算 / 操作日誌）
       .v2-director-only    — 限 director 可見（教師管理 / 學校設定）
       .v2-teacher-only     — 僅一般教師可見（個人版首頁、待我同意）
    */
    body.v2-active .v2-admin-only,
    body.v2-active .v2-approver-only,
    body.v2-active .v2-director-only { display: none; }
    body.v2-active.v2-approver .v2-admin-only,
    body.v2-active.v2-approver .v2-approver-only { display: revert; }
    body.v2-active.v2-director .v2-director-only { display: revert; }
    body.v2-active .v2-teacher-only { display: revert; }
    body.v2-active.v2-approver .v2-teacher-only { display: none; }

    /* Stage 2 驗收缺陷修正：原本這裡有一條 body.v2-active.v2-director #teacher-editor-card
       {display:none}，讓 director 看不到 V1 教師屬性表——但 V2 帳號表的「領域」欄是唯讀 td、
       沒有導師班欄，而 domains 是推薦引擎比對代課人選的依據，director 因此完全無法編輯任教
       領域/導師班級。裁定移除該規則：教師管理分頁內 director 同時看到教師屬性卡（可編輯
       領域/導師班）與 V2 帳號卡（管理 email/角色），職責不同、可共存。 */

    .v2-badge { display: inline-block; padding: 2px 6px; border-radius: 10px;
                font-size: 0.72rem; margin-left: 4px; background: #e53e3e; color: #fff; }
    .v2-role-tag { display: inline-block; padding: 2px 8px; border-radius: 10px;
                   font-size: 0.75rem; font-weight: 600; }
    .v2-role-tag.admin,
    .v2-role-tag.director      { background: #b91c1c; color: #fff; }
    .v2-role-tag.section_chief { background: #d97706; color: #fff; }
    .v2-role-tag.teacher       { background: #2563eb; color: #fff; }

    .v2-login-denied { max-width: 520px; margin: 3rem auto; padding: 2rem;
                      background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; }
    .v2-login-denied h3 { margin-top: 0; color: #856404; }

    .v2-pending-item { border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.8rem;
                       margin-bottom: 0.6rem; background: #fafafa; }
    .v2-pending-item.incoming { border-left: 4px solid #f59e0b; }
    .v2-pending-item.outgoing { border-left: 4px solid #3b82f6; }
    .v2-pending-meta { font-size: 0.85rem; color: #6b7280; margin-top: 4px; }
    .v2-pending-actions { margin-top: 0.6rem; display: flex; gap: 0.4rem; }
    .v2-status-tag { display: inline-block; padding: 2px 8px; border-radius: 10px;
                     font-size: 0.72rem; font-weight: 600; margin-right: 4px; }
    .v2-status-tag.pending  { background: #fef3c7; color: #92400e; }
    .v2-status-tag.rejected { background: #fee2e2; color: #991b1b; }
    .v2-status-tag.approved { background: #d1fae5; color: #065f46; }

    /* Phase 3：待辦清單頁籤上的紅點數量徽章（待我同意 + 待我審核 加總） */
    .v2-tab-badge { position: relative; top: -1px; }

    /* V2 模式下隱藏原本地「調代課紀錄」表格與查詢，避免與 V2 全校紀錄混淆。
       R1 修復（Stage 2）：改用純 id 選擇器，不依賴 #records-tab 的子代組合子——
       records-tab 內部 DOM 結構調整時，這條隱私邊界規則不會意外失效。 */
    body.v2-active #records-no-data,
    body.v2-active #records-content { display: none !important; }

    .v2-log-table { width: 100%; font-size: 0.85rem; border-collapse: collapse; }
    .v2-log-table th, .v2-log-table td { padding: 4px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; }

    .v2-logs-failed-banner { background: #fee2e2; border: 1px solid #ef4444; color: #991b1b;
        border-radius: 6px; padding: 8px 12px; margin-bottom: 0.8rem; font-size: 0.85rem; }
    .v2-log-table tbody tr:hover { background: #f9fafb; }

    .v2-teacher-row td { vertical-align: middle; }
    .v2-teacher-row input[type="email"] { width: 100%; max-width: 220px; }
    .v2-row-needs-email { background: #fffbeb; }
    .v2-row-needs-email td:first-child::before {
        content: '⚠ '; color: #d97706; font-weight: bold;
    }
    .v2-auth-provider-chip {
        display: inline-block; padding: 2px 8px; border-radius: 10px;
        font-size: 0.75rem; font-weight: 500; vertical-align: middle;
        margin-left: 4px;
    }
    .v2-auth-provider-chip.google { background: #dbeafe; color: #1e40af; }

    .v2-section-header { display: flex; justify-content: space-between;
                         align-items: center; margin-bottom: 1rem; }
    .v2-section-header h3 { display: flex; align-items: center; gap: 8px; margin: 0; }

    /* Phase 1.6.b 雙軌登入 */
    .v2-email-login-trigger {
        display: block; margin-top: 6px; padding: 4px 8px;
        background: transparent; border: none; color: #2563eb;
        font-size: 0.82rem; cursor: pointer; text-decoration: underline;
    }
    .v2-email-login-trigger:hover { color: #1d4ed8; }

    /* 登入遮罩：V2 模式未授權時鎖定整個 app，阻擋所有互動（含月結算下載）。
       z-index 改用 token：--z-authgate(1100) < --z-authmodal(1200) < --z-toast(1300)，
       故登入 modal 仍可疊在遮罩之上，且 toast 一律蓋在登入 modal 之上
       （Stage 1 修復 toast 被登入 modal 蓋住的問題）。 */
    #v2-auth-gate { display: none; }
    body.v2-locked { overflow: hidden; }
    body.v2-locked #v2-auth-gate {
        position: fixed; inset: 0; z-index: var(--z-authgate);
        display: flex; align-items: center; justify-content: center;
        background: linear-gradient(135deg, #1e3a8a 0%, #1e40af 100%);
    }
    .v2-auth-gate-card {
        background: #fff; border-radius: 12px; padding: 2.5rem 2rem;
        width: 92%; max-width: 420px; text-align: center;
        box-shadow: 0 20px 50px rgba(0,0,0,0.35);
    }
    .v2-auth-gate-card h2 { margin: 0 0 0.6rem; color: #1f2937; font-size: 1.25rem; }
    .v2-auth-gate-card p { margin: 0 0 1.5rem; color: #6b7280; font-size: 0.9rem; line-height: 1.6; }
    .v2-auth-gate-card p.v2-gate-denied { color: #b91c1c; font-weight: 600; }
    .v2-auth-gate-actions { display: flex; flex-direction: column; gap: 0.8rem; align-items: center; }
    #v2-gate-google {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        padding: 10px 22px; border: 1px solid #d1d5db; border-radius: 8px;
        background: #fff; color: #1f2937; font-size: 0.95rem; font-weight: 600; cursor: pointer;
    }
    #v2-gate-google:hover { background: #f9fafb; }
    #v2-gate-email {
        color: #2563eb; font-size: 0.85rem; cursor: pointer;
        background: none; border: none; text-decoration: underline; padding: 4px;
    }

    .v2-modal-backdrop {
        position: fixed; inset: 0; background: rgba(0,0,0,0.45);
        display: flex; align-items: center; justify-content: center;
        z-index: var(--z-authmodal);
    }
    .v2-modal {
        background: #fff; border-radius: 10px; padding: 1.5rem;
        width: 92%; max-width: 380px; box-shadow: 0 10px 25px rgba(0,0,0,0.2);
    }
    .v2-modal h3 { margin: 0 0 1rem 0; color: #1f2937; }
    .v2-modal label { display: block; font-size: 0.85rem; color: #4b5563; margin-top: 0.6rem; }
    .v2-modal input[type=email], .v2-modal input[type=password] {
        width: 100%; padding: 8px 10px; border: 1px solid #d1d5db;
        border-radius: 6px; font-size: 0.95rem; box-sizing: border-box;
    }
    .v2-modal-actions { display: flex; gap: 8px; margin-top: 1rem; }
    .v2-modal-actions .btn { flex: 1; }
    .v2-modal-links { margin-top: 0.8rem; display: flex; justify-content: space-between;
                      font-size: 0.82rem; }
    .v2-modal-links a { color: #2563eb; text-decoration: none; cursor: pointer; }
    .v2-modal-links a:hover { text-decoration: underline; }
    .v2-modal-msg { margin-top: 0.6rem; padding: 6px 10px; border-radius: 6px;
                    font-size: 0.85rem; }
    .v2-modal-msg.error   { background: #fee2e2; color: #991b1b; }
    .v2-modal-msg.success { background: #d1fae5; color: #065f46; }

    /* Phase 4b：教師名單 CSV 批次匯入預覽對話框 */
    .v2-roster-summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 0.8rem 0; }
    .v2-roster-stat { padding: 4px 10px; border-radius: 6px; font-size: 0.85rem; font-weight: 600;
                      background: #f3f4f6; color: #374151; }
    .v2-roster-stat.created { background: #d1fae5; color: #065f46; }
    .v2-roster-stat.updated { background: #dbeafe; color: #1e40af; }
    .v2-roster-stat.skipped { background: #f3f4f6; color: #4b5563; }
    .v2-roster-stat.errors  { background: #fee2e2; color: #991b1b; }
    .v2-roster-error-list { max-height: 220px; overflow: auto; border: 1px solid #e5e7eb; border-radius: 6px;
        padding: 6px 10px; margin-bottom: 0.6rem; background: #fafafa; }
    .v2-roster-error-row { font-size: 0.82rem; color: #991b1b; padding: 3px 0; border-bottom: 1px dashed #fecaca; }
    .v2-roster-error-row:last-child { border-bottom: none; }

    /* Phase 5：V1 舊資料遷移卡片與 legacy 徽章 */
    .v2-legacy-card { border: 1px solid #fbbf24; background: #fffbeb; border-radius: 8px;
        padding: 0.9rem 1rem; margin-bottom: 1rem; }
    .v2-legacy-card h4 { margin: 0 0 0.4rem; color: #92400e; font-size: 0.95rem; }
    .v2-legacy-card p { margin: 0 0 0.6rem; font-size: 0.85rem; color: #78350f; }
    .v2-legacy-badge { display: inline-block; padding: 1px 6px; border-radius: 8px;
        font-size: 0.7rem; margin-left: 4px; background: #e5e7eb; color: #4b5563; }
    .v2-records-filter { font-size: 0.85rem; padding: 3px 6px; border-radius: 6px;
        border: 1px solid #d1d5db; margin-left: 8px; }
    `;
    document.head.appendChild(style);
}

/* ===== 登入遮罩（V2 未授權時鎖定整個 app）===== */

// 遮罩狀態：拒絕帳號 email（非 null 顯示「尚未授權」）、驗證錯誤旗標（顯示錯誤+重試）。
// 授權登入成功後由 unlockV2App 一併清除。
let _v2GateDeniedEmail = null;
let _v2GateError = false;

/** 最小 HTML 逸出，避免 email 等外部值注入遮罩 innerHTML。 */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 注入登入遮罩元素（只需一次）。實際顯隱由 body.v2-locked + .app-container[inert] 控制。 */
function injectV2AuthGate() {
    if (document.getElementById('v2-auth-gate')) return;
    const gate = document.createElement('div');
    gate.id = 'v2-auth-gate';
    document.body.appendChild(gate);
    renderAuthGate();
}

/** 依目前狀態渲染遮罩內容（預設登入 / 拒絕 / 錯誤），並綁定登入入口。相同狀態不重繪。 */
function renderAuthGate() {
    const gate = document.getElementById('v2-auth-gate');
    if (!gate) return;
    const key = _v2GateError ? 'error'
              : _v2GateDeniedEmail ? 'denied:' + _v2GateDeniedEmail
              : 'default';
    if (gate.dataset.renderKey === key) return;   // 相同狀態免重繪 / 重綁監聽
    gate.dataset.renderKey = key;

    const msg = _v2GateError
        ? `<p class="v2-gate-denied">⚠ 登入驗證時發生錯誤，請點下方按鈕重試，或重新整理頁面。</p>`
        : _v2GateDeniedEmail
            ? `<p class="v2-gate-denied">🔒 帳號 ${escapeHtml(_v2GateDeniedEmail)} 尚未被授權。<br>請改用已授權的帳號登入，或聯絡管理員在「教師管理」為您指派 email。</p>`
            : `<p>本系統為全校共用，請先登入以使用。</p>`;
    gate.innerHTML = `
        <div class="v2-auth-gate-card">
            <h2>國中調代課自動化系統</h2>
            ${msg}
            <div class="v2-auth-gate-actions">
                <button id="v2-gate-google">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    使用 Google 登入
                </button>
                <button id="v2-gate-email">使用 Email / 密碼登入</button>
            </div>
        </div>
    `;
    // 直接呼叫既有處理器（不依賴遮罩下 DOM id；底層 .app-container 已 inert，程式化呼叫不受影響）
    gate.querySelector('#v2-gate-google')?.addEventListener('click', () => {
        window.app?.handleGoogleSignIn?.();
    });
    gate.querySelector('#v2-gate-email')?.addEventListener('click', () => openAuthModal('signin'));
}

/**
 * 設定鎖定狀態的單一入口：切 body.v2-locked（顯示遮罩）並對 .app-container 上 inert。
 * inert 會一併阻擋鍵盤導覽 / 焦點 / 滑鼠，杜絕「Tab 跳過遮罩操作底層月結算」。
 */
function setAppLocked(locked) {
    const appContainer = document.querySelector('.app-container');
    if (appContainer) appContainer.inert = locked;
    document.body.classList.toggle('v2-locked', locked);
}

/** 鎖定整個 app（未授權 / 登出 / 驗證錯誤）：渲染遮罩並封鎖底層互動。 */
function lockV2App() {
    renderAuthGate();
    setAppLocked(true);
}

/** 解鎖 app（授權身份確認且初次渲染完成後）：清除拒絕/錯誤狀態並解除封鎖。 */
function unlockV2App() {
    _v2GateDeniedEmail = null;
    _v2GateError = false;
    setAppLocked(false);
}

/* ===== 渲染（待辦 / 教師管理 / 操作日誌） ===== */

function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
    catch { return iso || ''; }
}

/** 待辦清單頁籤上的紅點數量徽章：待我同意 + 待我審核 加總。 */
function updatePendingNavBadge(count) {
    const btn = document.querySelector('.tab-btn[data-tab="v2-pending"]');
    if (!btn) return;
    let badge = btn.querySelector('.v2-tab-badge');
    if (count > 0) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'v2-badge v2-tab-badge';
            btn.appendChild(badge);
        }
        badge.textContent = String(count);
    } else if (badge) {
        badge.remove();
    }
}

/**
 * Phase 3：待辦清單改為三段：
 *   1. 待我同意（consent-inbox）— swap / multi_swap 分開呈現，供 pendingConsentTeacherIds 內的教師同意/拒絕
 *   2. 待我審核（approval-queue）— approver only，核准後才建立 record + 產生 PDF
 *   3. 我的申請（my-requests）— 發起人自己看全狀態，含 rejected 的 dismiss 流程
 * 三段共用同一個 #v2-pending-list 容器（沿用既有單頁籤機制，角色可見性以 JS 過濾實現）。
 */
async function renderPendingTab() {
    const host = document.getElementById('v2-pending-list');
    if (!host) return;
    const _gen = _v2IdentityGen;
    host.innerHTML = '<p>載入中…</p>';

    const me = roleSvc.getCurrentIdentity();
    if (!me) { host.innerHTML = '<p>尚未登入。</p>'; return; }

    const rawAll = await dataSvc.listPendingRequests();
    // 舊 alpha 期 status=pending 文件一律映射為「調課雙簽、對方尚未同意」（不寫回資料庫）
    const all = rawAll.map(r => requestSvc.normalizeLegacyRequest(r));

    // 1. 待我同意：我在 pendingConsentTeacherIds（或舊 requiredApproverId）名單中，且仍在同意階段
    const consentMine = all.filter(r =>
        r.status === REQUEST_STATUS.PENDING_SWAP_CONSENT && roleSvc.canConsentRequest(r)
    );
    const consentSwap      = consentMine.filter(r => r.requestType !== REQUEST_TYPES.MULTI_SWAP);
    const consentMultiSwap = consentMine.filter(r => r.requestType === REQUEST_TYPES.MULTI_SWAP);

    // 2. 待我審核：僅 approver（director / section_chief）可見
    const isApprover    = roleSvc.isApprover();
    const approvalQueue = isApprover ? all.filter(r => r.status === REQUEST_STATUS.PENDING_APPROVAL) : [];

    // 3. 我的申請：發起人為自己（含全部狀態）
    const mine = all.filter(r => r.initiatedBy === me.teacherId);

    updatePendingNavBadge(consentMine.length + approvalQueue.length);

    const stageLabel = (r) => {
        switch (r.status) {
            case REQUEST_STATUS.PENDING_SWAP_CONSENT: return '<span class="v2-status-tag pending">⏳ 待同意</span>';
            case REQUEST_STATUS.PENDING_APPROVAL:      return '<span class="v2-status-tag pending">📋 待核准</span>';
            case REQUEST_STATUS.APPROVED:              return '<span class="v2-status-tag approved">✅ 已核准</span>';
            case REQUEST_STATUS.REJECTED:              return '<span class="v2-status-tag rejected">❌ 被拒絕</span>';
            default: return '';
        }
    };

    const typeLabel = (r) => ({
        [REQUEST_TYPES.SUBSTITUTE]: '代課',
        [REQUEST_TYPES.SWAP]:       '調課',
        [REQUEST_TYPES.MULTI_SWAP]: '多重調課',
    }[r.requestType] || r.type || '調課');

    const consentRemainMeta = (r) => {
        const remain = Array.isArray(r.pendingConsentTeacherIds) ? r.pendingConsentTeacherIds.length : 0;
        return r.requestType === REQUEST_TYPES.MULTI_SWAP ? ` ・ 尚待 ${remain} 人同意` : '';
    };

    const itemCard = (r, cls, actionsHtml, extraMeta = '') => `
        <div class="v2-pending-item ${cls}" data-id="${r.reqId}">
            <div>
                ${stageLabel(r)}
                <strong>${typeLabel(r)}</strong> ・ ${r.date || ''} 第 ${r.period || '?'} 節 ・ ${r.className || ''} ${r.subject || ''}
            </div>
            <div class="v2-pending-meta">
                發起：${r.initiatedByName || r.initiatedBy || ''}${extraMeta} ・ ${fmtDate(r.createdAt)}
                ${r.status === REQUEST_STATUS.REJECTED && r.rejectNote ? `<br>拒絕原因：${r.rejectNote}` : ''}
            </div>
            <div class="v2-pending-actions">${actionsHtml}</div>
        </div>`;

    const renderList = (items, cls, emptyMsg, actionsFn, extraMetaFn) =>
        items.length
            ? items.map(r => itemCard(r, cls, actionsFn(r), extraMetaFn ? extraMetaFn(r) : '')).join('')
            : `<p class="muted">${emptyMsg}</p>`;

    // 同意按鈕：文案改為純「同意」（Phase 3 前是「同意並產生 PDF」，PDF 現在改到 approver 核准後才產）
    const consentActions = (r) =>
        `<button class="btn btn-primary btn-sm v2-consent-btn" data-id="${r.reqId}">同意</button>
         <button class="btn btn-secondary btn-sm v2-reject-btn" data-id="${r.reqId}">拒絕</button>`;

    const approvalActions = (r) =>
        `<button class="btn btn-primary btn-sm v2-final-approve-btn" data-id="${r.reqId}">核准並產生 PDF</button>
         <button class="btn btn-secondary btn-sm v2-reject-btn" data-id="${r.reqId}">駁回</button>`;

    const mineActions = (r) => {
        if (r.status === REQUEST_STATUS.REJECTED) {
            return `<button class="btn btn-secondary btn-sm v2-dismiss-btn" data-id="${r.reqId}">我知道了</button>`;
        }
        if (r.status === REQUEST_STATUS.APPROVED) return '';
        return `<button class="btn btn-danger btn-sm v2-cancel-btn" data-id="${r.reqId}">撤回</button>`;
    };

    // 「我的申請」補對象資訊：multi_swap 顯示尚待同意人數，其餘顯示對象教師姓名
    const mineMeta = (r) => {
        if (r.requestType === REQUEST_TYPES.MULTI_SWAP) return consentRemainMeta(r);
        return r.requiredApproverName ? ` ・ 對象：${r.requiredApproverName}` : '';
    };

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填，保持 reset 清空的狀態
    host.innerHTML = `
        <div class="v2-section-header"><h3>待我同意・調課</h3></div>
        ${renderList(consentSwap, 'incoming', '目前沒有等待您同意的調課請求', consentActions)}

        <div class="v2-section-header" style="margin-top:2rem;"><h3>待我同意・多重調課</h3></div>
        ${renderList(consentMultiSwap, 'incoming', '目前沒有等待您同意的多重調課請求', consentActions, consentRemainMeta)}

        ${isApprover ? `
        <div class="v2-section-header" style="margin-top:2rem;">
            <h3>待我審核 ${approvalQueue.length ? `<span class="v2-badge">${approvalQueue.length}</span>` : ''}</h3>
        </div>
        ${renderList(approvalQueue, 'incoming', '目前沒有待核准的申請', approvalActions)}
        ` : ''}

        <div class="v2-section-header" style="margin-top:2rem;"><h3>我的申請</h3></div>
        ${renderList(mine, 'outgoing', '目前沒有您發起中的請求', mineActions, mineMeta)}
    `;

    host.querySelectorAll('.v2-consent-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await requestSvc.consentRequest(btn.dataset.id);
                window.app?.showToast?.('已同意，等待其他同意人與組長/主任核准', 'success', 3500);
                await renderPendingTab();
            } catch (e) {
                if (e.code === 'ALREADY_PROCESSED') {
                    window.app?.showToast?.(e.message || '此請求已被處理', 'warning', 4000);
                    await renderPendingTab();
                } else {
                    notifyError(e, '同意請求');
                    btn.disabled = false;
                }
            }
        }));

    host.querySelectorAll('.v2-final-approve-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const saved = await requestSvc.approveRequest(btn.dataset.id);
                // 核准成功後才產生 PDF（Phase 3：PDF 產生時機從「同意時」移到「核准後」）；
                // PDF 與兩個列表重繪互不相依，並行執行縮短等待。
                await Promise.all([
                    generatePdfForRecord(saved),
                    renderPendingTab(),
                    renderRecordsTab(),
                ]);
                window.app?.showToast?.('已核准並產生 PDF', 'success', 3500);
            } catch (e) {
                if (e.code === 'ALREADY_PROCESSED') {
                    // 兩位 approver 並發核准：後到者顯示「已被處理」並刷新列表
                    window.app?.showToast?.(e.message || '此請求已被處理', 'warning', 4500);
                    await renderPendingTab();
                } else {
                    notifyError(e, '核准請求');
                    btn.disabled = false;
                }
            }
        }));

    host.querySelectorAll('.v2-reject-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            const note = prompt('拒絕原因（可留空，對方會看到）：') || '';
            btn.disabled = true;
            try {
                await requestSvc.rejectRequest(btn.dataset.id, note);
                await renderPendingTab();
            } catch (e) {
                if (e.code === 'ALREADY_PROCESSED') {
                    window.app?.showToast?.(e.message || '此請求已被處理', 'warning', 4000);
                    await renderPendingTab();
                } else {
                    notifyError(e, '拒絕請求');
                    btn.disabled = false;
                }
            }
        }));
    host.querySelectorAll('.v2-cancel-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            if (!confirm('確定撤回此調課請求？')) return;
            try { await requestSvc.cancelRequest(btn.dataset.id); await renderPendingTab(); }
            catch (e) { notifyError(e, '撤回請求'); }
        }));
    host.querySelectorAll('.v2-dismiss-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            try { await requestSvc.dismissRejectedRequest(btn.dataset.id); await renderPendingTab(); }
            catch (e) { notifyError(e, '清除已拒絕請求'); }
        }));
}

/**
 * Phase 1.6.c：依 teachers.authProvider 決定顯示「寄密碼信」按鈕或「Google 登入」標籤。
 *   - 'google.com'：教師已用 Google 登入過，無 Firebase 密碼可重置 → 隱藏寄信按鈕、顯示標籤
 *   - 'password'：教師用 Email/Password 註冊或主任曾代發信 → 顯示寄信按鈕
 *   - null（從未登入過）：主任可能要發首次邀請信 → 顯示寄信按鈕
 *   - 無 email：兩者都不顯示
 */
function renderTeacherAuthAction(t) {
    if (!t.email) return '';
    if (t.authProvider === 'google.com') {
        return `<span class="v2-auth-provider-chip google" title="此教師以 Google 帳號登入，密碼由 Google 管理，本系統無法為其重置">🔒 Google 登入</span>`;
    }
    const label = t.authProvider === 'password'
        ? '📧 重設密碼'
        : '📧 寄首次密碼信';
    const tooltip = t.authProvider === 'password'
        ? '為此教師寄出密碼重置信'
        : '為此教師建立 Auth 帳號並寄出密碼設定信（首次邀請）';
    return `<button class="btn btn-secondary btn-sm v2-send-reset" title="${tooltip}">${label}</button>`;
}

async function renderTeachersAdminTab() {
    const host = document.getElementById('v2-teachers-admin');
    if (!host) return;
    if (!roleSvc.canManageRoster()) { host.innerHTML = '<p>僅教務主任可存取此頁籤。教學組長與一般教師無此權限。</p>'; return; }

    const _gen = _v2IdentityGen;
    host.innerHTML = '<p>載入中…</p>';
    const teachers = await teacherMgr.listAllTeachers();
    // 偵測舊資料失敗不可拖垮整頁：這支會對 users/{uid} 發 getDoc，離線 / token 過期 /
    // unavailable 都會 reject，若讓它往外拋，renderTeachersAdminTab 整支中止，
    // 畫面會永久停在上面那句「載入中…」（且是 unhandled rejection）。降級為「沒有舊資料」。
    const legacyInfo = await legacyMigration.detectLegacyData().catch(err => {
        console.warn('[v2] 偵測 V1 舊資料失敗（不影響教師管理頁）：', err?.message || err);
        return { source: null, count: 0, lastModified: null, sources: [] };
    });
    const roleLabel = (role) => {
        const r = (role === 'admin') ? 'director' : role;
        return { director: '主任', section_chief: '組長', teacher: '教師' }[r] || '教師';
    };
    const missingEmailCount = teachers.filter(t => !t.email).length;

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填教師名單
    host.innerHTML = `
        ${legacyInfo.source ? renderLegacyMigrationCard(legacyInfo) : ''}
        <div class="v2-section-header">
            <h3>
                教師帳號管理
                ${missingEmailCount > 0
                    ? `<span class="v2-badge" title="尚有教師未指派 email，無法登入">⚠ ${missingEmailCount} 位待指派 email</span>`
                    : ''}
            </h3>
            <div>
                <button class="btn btn-secondary btn-sm" id="v2-import-legacy-teachers">從課表匯入教師</button>
                <button class="btn btn-secondary btn-sm" id="v2-import-roster-csv">📥 批次匯入 CSV</button>
                <input type="file" id="v2-roster-csv-input" accept=".csv" style="display:none;">
                <button class="btn btn-primary btn-sm" id="v2-add-teacher">新增教師</button>
            </div>
        </div>
        <div class="table-wrap">
        <table class="data-table data-table-compact">
            <thead><tr><th>姓名</th><th>Email（登入帳號）</th><th>角色</th><th>領域</th><th>操作</th></tr></thead>
            <tbody>
            ${teachers.map(t => {
                const normRole = (t.role === 'admin') ? 'director' : (t.role || 'teacher');
                const rowClass = t.email ? 'v2-teacher-row' : 'v2-teacher-row v2-row-needs-email';
                return `
                <tr class="${rowClass}" data-id="${t.teacherId}">
                    <td>${t.name}</td>
                    <td><input type="email" class="v2-email-input" value="${t.email || ''}" placeholder="未指派"></td>
                    <td>
                        <select class="v2-role-select">
                            <option value="teacher"       ${normRole === 'teacher' ? 'selected' : ''}>教師</option>
                            <option value="section_chief" ${normRole === 'section_chief' ? 'selected' : ''}>組長</option>
                            <option value="director"      ${normRole === 'director' ? 'selected' : ''}>主任</option>
                        </select>
                        <span class="v2-role-tag ${normRole}" style="margin-left:6px;">${roleLabel(t.role)}</span>
                    </td>
                    <td>${(t.domains || []).join('、')}</td>
                    <td>
                        <button class="btn btn-primary btn-sm v2-save-teacher">儲存</button>
                        ${renderTeacherAuthAction(t)}
                        <button class="btn btn-danger btn-sm v2-delete-teacher">刪除</button>
                    </td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>
        </div>
    `;

    host.querySelectorAll('.v2-save-teacher').forEach(btn =>
        btn.addEventListener('click', async () => {
            const tr  = btn.closest('tr');
            const id  = tr.dataset.id;
            const em  = tr.querySelector('.v2-email-input').value.trim();
            const rl  = tr.querySelector('.v2-role-select').value;
            try {
                await teacherMgr.assignEmail(id, em || null);
                await teacherMgr.setRole(id, rl);
                notify('已儲存', 'success');
                await renderTeachersAdminTab();
            } catch (e) { notifyError(e, '儲存教師資料'); }
        }));

    host.querySelectorAll('.v2-delete-teacher').forEach(btn =>
        btn.addEventListener('click', async () => {
            const id = btn.closest('tr').dataset.id;
            if (!confirm('確定刪除此教師？此操作會寫入 log。')) return;
            try { await teacherMgr.deleteTeacher(id); await renderTeachersAdminTab(); }
            catch (e) { notifyError(e, '刪除教師'); }
        }));

    host.querySelectorAll('.v2-send-reset').forEach(btn =>
        btn.addEventListener('click', async () => {
            const tr    = btn.closest('tr');
            const email = tr.querySelector('.v2-email-input').value.trim();
            if (!email) { notify('此教師尚未填 email，請先儲存 email 再試。', 'warning'); return; }
            if (!confirm(`即將為 ${email} 建立 Auth 帳號（若不存在）並寄出密碼設定信。確認？`)) return;
            btn.disabled = true;
            const origText = btn.textContent;
            btn.textContent = '寄送中…';
            try {
                const r = await authMod.createTeacherAuthAndSendReset(email);
                notify(r.accountCreated
                    ? `✓ 已建立帳號並寄出密碼設定信給 ${email}`
                    : `✓ 該 email 已有帳號，已寄出密碼重置信給 ${email}`, 'success');
                btn.textContent = '已寄出';
                await logger.log(LOG_ACTIONS.TEACHER_BIND_EMAIL, LOG_TARGET_TYPES.TEACHER, tr.dataset.id, {
                    action: 'send_password_reset', email, accountCreated: r.accountCreated,
                });
            } catch (e) {
                console.error('寄密碼信失敗:', e);
                notifyError(e, '寄送密碼信');
                btn.textContent = origText;
                btn.disabled = false;
            }
        }));

    document.getElementById('v2-add-teacher')?.addEventListener('click', async () => {
        const name  = prompt('教師姓名：'); if (!name) return;
        const email = prompt('Email（可留空）：') || null;
        try { await teacherMgr.createTeacher({ name, email }); await renderTeachersAdminTab(); }
        catch (e) { notifyError(e, '新增教師'); }
    });

    document.getElementById('v2-import-legacy-teachers')?.addEventListener('click', async () => {
        const legacy = window.app?.dataManager?.teachers || [];
        if (!legacy.length) { notify('找不到課表教師資料，請先於「課表管理」載入課表', 'warning'); return; }
        const created = await teacherMgr.importFromLegacyTeachers(legacy);
        notify(`已匯入 ${created.length} 位教師`, 'success');
        await renderTeachersAdminTab();
    });

    document.getElementById('v2-import-roster-csv')?.addEventListener('click', () => {
        document.getElementById('v2-roster-csv-input')?.click();
    });

    document.getElementById('v2-roster-csv-input')?.addEventListener('change', async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = ''; // 清空，允許使用者重新選同一檔案時仍觸發 change
        if (!file) return;
        try {
            const rows = await parseRosterCsvFile(file);
            const preview = await teacherMgr.importRosterCsv(rows, { dryRun: true });
            const confirmed = await promptRosterImportPreview(preview);
            if (!confirmed) return;
            const applied = await teacherMgr.importRosterCsv(rows, { dryRun: false });
            notify(
                `匯入完成：新增 ${applied.created.length} 筆／更新 ${applied.updated.length} 筆／略過 ${applied.skipped.length} 筆／錯誤 ${applied.errors.length} 筆`,
                applied.errors.length ? 'warning' : 'success'
            );
            await renderTeachersAdminTab();
        } catch (e) {
            notifyError(e, 'CSV 批次匯入');
        }
    });

    bindLegacyMigrationCard();
}

/**
 * Phase 5：教師管理頁的「V1 資料遷移」卡片內容，偵測到舊資料時才由 renderTeachersAdminTab 插入。
 * info 為 legacyMigration.detectLegacyData() 的回傳值，其中 sources 為所有「確實含紀錄」
 * 的來源明細——兩個來源都有資料時會一併遷移取聯集（重疊部分由冪等鍵去重），
 * 不做「挑一個較新的」自動決勝，故此處逐一列出讓主任看得到每個來源各有幾筆。
 */
const LEGACY_SOURCE_LABELS = {
    firestore:    'Firestore 雲端備份（users/{uid}）',
    localStorage: '瀏覽器本機 localStorage',
};

function renderLegacyMigrationCard(info) {
    const sources = Array.isArray(info.sources) && info.sources.length
        ? info.sources
        : [{ source: info.source, count: info.count, lastModified: info.lastModified }];

    const rows = sources.map(s => {
        const label = LEGACY_SOURCE_LABELS[s.source] || s.source || '未知來源';
        const when  = s.lastModified ? fmtDate(s.lastModified) : '未知';
        return `<li>${escapeHtml(label)}：<strong>${s.count}</strong> 筆｜最後修改：${escapeHtml(when)}</li>`;
    }).join('');

    const unionNote = sources.length > 1
        ? '<br>兩個來源都會一併遷移（取聯集），重複的紀錄只會匯入一次。'
        : '';

    return `
        <div class="v2-legacy-card" id="v2-legacy-card">
            <h4>⚠ 偵測到 V1 舊系統資料尚未遷移</h4>
            <ul class="v2-legacy-sources">${rows}</ul>
            <p>
                按下按鈕會先強制下載完整備份 JSON（含上列所有來源的原始資料）才開始遷移；
                遷移採冪等設計，重複執行不會產生重複紀錄，姓名對不到帳號的舊紀錄仍會匯入並提示。${unionNote}
            </p>
            <button class="btn btn-primary btn-sm" id="v2-legacy-migrate-btn">下載備份並開始遷移</button>
        </div>`;
}

/** 綁定「V1 資料遷移」卡片按鈕事件；卡片未渲染（無舊資料）時安全跳過。 */
function bindLegacyMigrationCard() {
    const btn = document.getElementById('v2-legacy-migrate-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const originalText = btn.textContent;
        btn.disabled = true;
        try {
            const backup = await legacyMigration.getLegacyBackupPayload();
            if (!backup) {
                notify('偵測到的舊資料已消失，請重新整理頁面後再試', 'warning');
                return;
            }
            try {
                downloadLegacyBackupJson(backup);
            } catch (e) {
                console.error('[V2] 遷移備份下載失敗:', e);
                notifyError(e, '下載遷移備份');
                return; // 備份下載失敗必須中止遷移，不可在沒有備份的情況下寫入
            }

            btn.textContent = '遷移中…';
            const stats = await legacyMigration.migrateLegacyRecords({
                onProgress: ({ done, total }) => { btn.textContent = `遷移中…${done}/${total}`; },
            });

            const parts = [`共 ${stats.total} 筆`, `新增 ${stats.created} 筆`, `略過 ${stats.skipped} 筆`];
            if (stats.unmatchedNames.length) parts.push(`${stats.unmatchedNames.length} 位姓名對不到帳號（${stats.unmatchedNames.join('、')}）`);
            if (stats.errors.length) parts.push(`${stats.errors.length} 筆發生錯誤`);
            notify(`遷移完成：${parts.join('／')}`, stats.errors.length ? 'warning' : 'success', 8000);

            await renderTeachersAdminTab();
            await renderRecordsTab();
        } catch (e) {
            console.error('[V2] 資料遷移失敗:', e);
            notifyError(e, '資料遷移');
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });
}

/** 遷移前強制下載完整備份 JSON；任何步驟拋錯都會讓呼叫端（bindLegacyMigrationCard）中止遷移。 */
function downloadLegacyBackupJson(backup) {
    const uidPart  = backup.uid || 'unknown';
    const datePart = new Date().toISOString().split('T')[0];
    // backup 是 { exportedAt, uid, sources: [{ source, count, lastModified, raw }] }——
    // 整包寫出（含所有來源的原始資料），不可只取其中一份，否則遷移後想還原時
    // 才會發現另一來源的資料沒被保存。
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `STsystem-legacy-backup-${uidPart}-${datePart}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/** 用 PapaParse 解析教師名單 CSV 檔案為 header:true 物件陣列（欄位定義見 docs/V2_ROSTER_CSV.md）。 */
function parseRosterCsvFile(file) {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            encoding: 'UTF-8',
            skipEmptyLines: true,
            transformHeader: h => {
                let s = h.trim();
                if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // 去除 UTF-8 BOM 可能殘留在第一個表頭欄位的情形
                return s;
            },
            complete: (results) => resolve(results.data),
            error: (err) => reject(new Error('CSV 解析失敗：' + err.message)),
        });
    });
}

/**
 * Phase 4b：CSV 批次匯入教師名單前的預覽對話框。
 * 顯示 dryRun 結果（新增/更新/略過/錯誤筆數 + 每筆錯誤的列號與原因），
 * 使用者按「確認匯入」才會真正呼叫 importRosterCsv({ dryRun:false }) 寫入；
 * 按「取消」或點背景關閉則放棄本次匯入，不寫入任何資料。
 * 回傳 Promise<boolean>：true = 使用者確認匯入，false = 取消。
 */
function promptRosterImportPreview(preview) {
    return new Promise((resolve) => {
        const { created, updated, skipped, errors } = preview;
        const hasImportable = (created.length + updated.length) > 0;

        const backdrop = document.createElement('div');
        backdrop.className = 'v2-modal-backdrop';
        backdrop.innerHTML = `
            <div class="v2-modal" style="max-width:520px;">
                <h3>CSV 匯入預覽</h3>
                <div class="v2-roster-summary">
                    <span class="v2-roster-stat created">新增 ${created.length} 筆</span>
                    <span class="v2-roster-stat updated">更新 ${updated.length} 筆</span>
                    <span class="v2-roster-stat skipped">略過 ${skipped.length} 筆</span>
                    <span class="v2-roster-stat errors">錯誤 ${errors.length} 筆</span>
                </div>
                ${errors.length ? `
                <div class="v2-roster-error-list">
                    ${errors.map(e => `<div class="v2-roster-error-row">第 ${e.row} 列．${escapeHtml(e.name || '（無姓名）')}．${escapeHtml(e.reason)}</div>`).join('')}
                </div>` : ''}
                ${!hasImportable ? '<p class="v2-modal-msg error" style="display:block;">沒有可匯入的資料，請修正 CSV 後重新上傳。</p>' : ''}
                <div class="v2-modal-actions">
                    <button class="btn btn-secondary" id="v2-roster-preview-cancel">取消</button>
                    <button class="btn btn-primary" id="v2-roster-preview-confirm" ${hasImportable ? '' : 'disabled'}>確認匯入</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);

        const cleanup = (result) => { backdrop.remove(); resolve(result); };
        backdrop.querySelector('#v2-roster-preview-cancel').addEventListener('click', () => cleanup(false));
        backdrop.querySelector('#v2-roster-preview-confirm').addEventListener('click', () => cleanup(true));
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
    });
}

async function renderLogsTab() {
    const host = document.getElementById('v2-logs');
    if (!host) return;

    const _gen = _v2IdentityGen;
    host.innerHTML = '<p>載入中…</p>';
    const all = await logger.fetchLogs({ limit: 300 });
    const visible = roleSvc.filterLogsForCurrent(all);
    const failedCount = logger.getFailedLogCount();

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填操作日誌
    host.innerHTML = `
        ${failedCount > 0 ? `<div class="v2-logs-failed-banner">⚠ 本次工作階段有 ${failedCount} 筆稽核日誌寫入失敗</div>` : ''}
        <div class="v2-section-header">
            <h3>操作日誌 <small style="color:#6b7280;font-weight:normal;">（${visible.length} 筆）</small></h3>
            <button class="btn btn-secondary btn-sm" id="v2-refresh-logs">重新整理</button>
        </div>
        <div class="table-wrap">
        <table class="v2-log-table">
            <thead><tr><th>時間</th><th>操作者</th><th>角色</th><th>動作</th><th>對象</th><th>詳情</th></tr></thead>
            <tbody>
            ${visible.map(l => `
                <tr>
                    <td>${fmtDate(l.timestamp)}</td>
                    <td>${l.actor?.name || l.actor?.email || '—'}</td>
                    <td><span class="v2-role-tag ${l.actor?.role || ''}">${l.actor?.role || '—'}</span></td>
                    <td>${l.action}</td>
                    <td>${l.targetType || ''}${l.targetId ? ' / ' + l.targetId.slice(-6) : ''}</td>
                    <td><code style="font-size:0.75rem;">${JSON.stringify(l.details).slice(0, 160)}</code></td>
                </tr>`).join('')}
            </tbody>
        </table>
        </div>
    `;
    document.getElementById('v2-refresh-logs')?.addEventListener('click', renderLogsTab);
}

async function renderRecordsTab() {
    // V2 模式下，原本地紀錄表格已由 CSS 隱藏，這裡是 records-tab 的主要內容。
    let host = document.getElementById('v2-records-section');
    if (!host) {
        const original = document.getElementById('records-tab');
        if (!original) return;
        host = document.createElement('div');
        host.id = 'v2-records-section';
        host.className = 'card compact-card';
        original.appendChild(host);
    }
    const _gen = _v2IdentityGen;
    const all       = await dataSvc.listSubstituteRecords();
    const visible   = roleSvc.filterRecordsForCurrent(all);
    const isApprover = roleSvc.isApprover();
    const APPROVER_ROLES_FOR_BADGE = ['admin', 'director', 'section_chief'];

    // Phase 5：legacy 篩選（全部／僅新／僅舊）純前端過濾，不影響 visible 本身（PDF/刪除仍可對到完整紀錄）。
    const displayed = _v2RecordsLegacyFilter === 'legacy' ? visible.filter(r => r.isLegacy)
        : _v2RecordsLegacyFilter === 'new' ? visible.filter(r => !r.isLegacy)
        : visible;

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填全校紀錄
    host.innerHTML = `
        <div class="v2-section-header">
            <h3>全校調代課紀錄 <small style="color:#6b7280;font-weight:normal;">（${displayed.length} 筆｜${isApprover ? '核准者視圖' : '個人相關'}）</small></h3>
            <div>
                <label style="font-size:0.85rem;color:#6b7280;">顯示
                    <select id="v2-records-legacy-filter" class="v2-records-filter">
                        <option value="all"    ${_v2RecordsLegacyFilter === 'all' ? 'selected' : ''}>全部</option>
                        <option value="new"    ${_v2RecordsLegacyFilter === 'new' ? 'selected' : ''}>僅新</option>
                        <option value="legacy" ${_v2RecordsLegacyFilter === 'legacy' ? 'selected' : ''}>僅舊</option>
                    </select>
                </label>
            </div>
        </div>
        <div class="table-wrap">
        <table class="data-table data-table-compact">
            <thead><tr>
                <th>日期</th><th>節次</th><th>班級</th><th>原教師</th><th>代/調對象</th><th>類型</th><th>發起</th>
                <th>操作</th>
            </tr></thead>
            <tbody>
            ${displayed.map(r => `
                <tr data-id="${r.recordId}">
                    <td>${r.date || ''}</td>
                    <td>${r.period || ''}</td>
                    <td>${r.className || ''}</td>
                    <td>${r.originalTeacher || ''}</td>
                    <td>${r.substituteTeacher || r.swapTeacher || ''}</td>
                    <td>${r.type || ''}${APPROVER_ROLES_FOR_BADGE.includes(r.initiatedByRole) ? ' <span class="v2-role-tag director">代發</span>' : ''}${r.isLegacy ? ' <span class="v2-legacy-badge" title="遷移自 V1 舊系統">舊系統</span>' : ''}</td>
                    <td>${r.initiatedByName || ''}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm v2-download-pdf" data-id="${r.recordId}">下載 PDF</button>
                        ${isApprover ? `<button class="btn btn-danger btn-sm v2-admin-delete" data-id="${r.recordId}">刪除</button>` : ''}
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>
        </div>
    `;

    document.getElementById('v2-records-legacy-filter')?.addEventListener('change', (e) => {
        _v2RecordsLegacyFilter = e.target.value;
        renderRecordsTab();
    });

    host.querySelectorAll('.v2-download-pdf').forEach(btn =>
        btn.addEventListener('click', async () => {
            const rec = visible.find(x => x.recordId === btn.dataset.id);
            if (!rec) return;
            btn.disabled = true;
            await generatePdfForRecord(rec);
            btn.disabled = false;
        }));

    if (isApprover) {
        host.querySelectorAll('.v2-admin-delete').forEach(btn =>
            btn.addEventListener('click', async () => {
                if (!confirm('確定刪除此紀錄？此操作會寫入 log。')) return;
                try { await requestSvc.adminDeleteRecord(btn.dataset.id); await renderRecordsTab(); }
                catch (e) { notifyError(e, '刪除紀錄'); }
            }));
    }
}

/* ===== 頁籤切換偵測 ===== */

function bindV2TabSwitches() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tab = btn.dataset.tab;
            if (tab === 'v2-pending') await renderPendingTab();
            if (tab === 'teachers')   await renderTeachersAdminTab();
            if (tab === 'v2-logs')    await renderLogsTab();
            if (tab === 'records')    await renderRecordsTab();
        }, { passive: true });
    });
}

// 每次身份「實際切換」+1；非同步渲染據此判斷手上的結果是否已過期（見 isStaleRender）。
let _v2IdentityGen = 0;

/** 非同步 render 取回資料後、寫入 DOM 前呼叫：若期間身份已切換則放棄本次繪製，避免舊身份資料回填。 */
function isStaleRender(gen) { return gen !== _v2IdentityGen; }

// Phase 5：全校紀錄頁籤的 legacy 篩選狀態（'all' | 'new' | 'legacy'），純前端顯示用，
// 跨 renderRecordsTab 重繪需持續保留使用者的選擇，故拉到 module 層級。
let _v2RecordsLegacyFilter = 'all';

/**
 * 直接以 class 操作切到指定頁籤（不經 canSwitchToTab 守門，供身份切換重置用）。
 * 沿用 app.js bindTabEvents 的 active/hidden 規則，保持 UI 一致。
 */
function forceActivateTab(dataTab) {
    const targetBtn = document.querySelector(`.tab-btn[data-tab="${dataTab}"]`);
    const targetPane = document.getElementById(dataTab + '-tab');
    if (!targetBtn || !targetPane) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.remove('active');
        c.classList.add('hidden');
    });
    targetBtn.classList.add('active');
    targetPane.classList.add('active');
    targetPane.classList.remove('hidden');
}

// 所有「由登入身份動態渲染、含個資」的容器 id。切換身份時必須全部清空。
// 集中一處列舉：日後新增受限頁籤只需在此補一個 id，避免遺漏造成殘留外洩。
const V2_IDENTITY_CONTENT_HOSTS = ['v2-teachers-admin', 'v2-logs', 'v2-pending-list', 'v2-records-section'];

/**
 * 身份切換 / 登出時重置 V2 視圖狀態（資安）。僅在身份「實際改變」時呼叫
 * （見 onAuthStateChange 的 identityChanged 守門），故不會誤刪同帳號 re-emit 的未存輸入。
 *   1. 清空所有含個資的渲染容器（教師名單 / 操作日誌 / 待辦 / 全校紀錄），杜絕前一身份殘留
 *   2. 清空衝堂檢查快取，避免殘留他人紀錄
 *   3. 彈回中性預設頁籤「調代課申請」（Stage 2 起 IA 重組：原「課表匯入」併入
 *      v2-approver-only 的「課表管理」分頁，非 approver 身份會被 CSS 隱藏，不能再當
 *      通用預設頁；「調代課申請」對所有角色恆可見，等同重新整理後的初始頁），避免新
 *      身份落在對其 display:none 的 .active 面板而看見空白、或殘留看見上一身份內容
 * 必須在套用新 body 角色 class 與重新渲染「之前」呼叫。
 */
function resetV2ViewState() {
    V2_IDENTITY_CONTENT_HOSTS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    _v2RecordsCache = [];
    _v2PendingCache = [];
    _v2RecordDetailCache.clear();
    _v2RecordsCacheGen++;   // 讓前一身份任何仍在飛行中的 hydrateRecordsWithDetail 事後失效，不得回填
    forceActivateTab('substitute');
}

/* ===== 調課送出攔截（P5/P7 重點）===== */

/**
 * V2 啟用時，在「確認並產生表單」click 的 capture 階段擋下：
 *   - 非 admin 若「原任課教師」不是自己 → 阻止並 alert
 *   - admin 放行（可代任一教師發起）
 */
function interceptSubmitButton() {
    const btn = document.getElementById('confirm-substitute-btn');
    if (!btn) return;

    btn.addEventListener('click', (ev) => {
        if (!roleSvc.isSignedIn()) return;
        if (roleSvc.isAdmin()) return;

        const me = roleSvc.getCurrentIdentity();
        const selectedName = document.getElementById('sub-teacher')?.value || '';
        if (selectedName && selectedName !== me.name) {
            ev.stopPropagation();
            ev.stopImmediatePropagation();
            ev.preventDefault();
            notify(`您僅能發起自己的課務調代課。\n您的身份為「${me.name}」，但「原任課教師」選的是「${selectedName}」。`, 'warning');
            logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.SUBSTITUTE_RECORD, null, {
                reason: 'non_admin_initiate_other',
                attemptedTeacher: selectedName,
                myTeacher: me.name,
            });
        }
    }, true);
}

/* ===== dataManager patch：V2 模式下改走 V2 寫入 ===== */

async function resolveApproverInfo(record, teachers = null) {
    // 呼叫端（writeV2Record）已抓過教師清單時直接沿用，避免同一次送出重複 listTeachers
    if (!teachers) teachers = await dataSvc.listTeachers();
    const findId   = (n) => teachers.find(t => t.name === n)?.teacherId || null;

    const originalTeacherId   = findId(record.originalTeacher);
    const substituteTeacherId = findId(record.substituteTeacher);
    const swapTeacherId       = findId(record.swapTeacher);
    // Phase 3：使用者若在多重調課提示框額外勾選教師（見 promptAdditionalConsentTeachers），
    // record.additionalConsentTeachers 是姓名陣列，這裡一併解析成 teacherId。
    const additionalConsentTeacherIds = Array.isArray(record.additionalConsentTeachers)
        ? record.additionalConsentTeachers.map(findId).filter(Boolean)
        : [];

    let requiredApproverId   = null;
    let requiredApproverName = null;
    let requestType          = REQUEST_TYPES.SUBSTITUTE;

    if (record.isSelfSwap) {
        // 自我調課不需他人同意，也不需組長/主任核准（見 substituteRecords rules 的 isSelfSwap 快速路徑）
        requiredApproverId   = null;
        requiredApproverName = null;
    } else if (record.type === '代課') {
        // Phase 3：代課為單簽，不需代課教師本人同意，直接進入組長/主任核准佇列
        requiredApproverId   = substituteTeacherId;
        requiredApproverName = record.substituteTeacher || null;
        requestType          = REQUEST_TYPES.SUBSTITUTE;
    } else if (record.type === '調課') {
        requiredApproverId   = swapTeacherId || substituteTeacherId;
        requiredApproverName = record.swapTeacher || record.substituteTeacher || null;
        // 有額外同意教師時升級為多重調課（全員同意）；否則維持雙簽調課
        requestType          = additionalConsentTeacherIds.length ? REQUEST_TYPES.MULTI_SWAP : REQUEST_TYPES.SWAP;
    }

    return {
        originalTeacherId,
        substituteTeacherId,
        swapTeacherId,
        additionalConsentTeacherIds,
        requiredApproverId,
        requiredApproverName,
        requestType,
    };
}

/**
 * Phase 3：調課（非自我調課、非 approver 代發起）時詢問「是否還有其他教師需一併同意」，
 * 讓一般調課雙簽升級為多重調課全員同意。純 v2-app.js 內動態注入的 modal，
 * 不改動 app.js / index.html 既有調課表單與批次調課流程。
 * 回傳勾選的教師姓名陣列（可能是空陣列 = 維持雙簽調課）。
 */
function promptAdditionalConsentTeachers(record, allTeachers) {
    return new Promise((resolve) => {
        const excludeNames = new Set([record.originalTeacher, record.swapTeacher].filter(Boolean));
        const candidates = allTeachers.filter(t => t.name && !excludeNames.has(t.name));
        if (!candidates.length) { resolve([]); return; }

        const backdrop = document.createElement('div');
        backdrop.className = 'v2-modal-backdrop';
        backdrop.innerHTML = `
            <div class="v2-modal" style="max-width:420px;">
                <h3>多重調課：還有其他教師需一併同意嗎？</h3>
                <p style="font-size:0.8rem;color:#6b7280;margin-top:-0.4rem;">
                    若本次調課牽動其他教師課務（例如三方輪調），請勾選需一併同意的教師；
                    僅雙方調課請直接點「僅雙方調課」送出。
                </p>
                <div class="v2-consent-teacher-list" style="max-height:220px;overflow:auto;margin:0.6rem 0;border:1px solid #e5e7eb;border-radius:6px;padding:6px 10px;">
                    ${candidates.map(t => `
                        <label style="display:block;padding:4px 0;font-size:0.9rem;">
                            <input type="checkbox" class="v2-extra-consent-cb" value="${escapeHtml(t.name)}"> ${escapeHtml(t.name)}
                        </label>`).join('')}
                </div>
                <div class="v2-modal-actions">
                    <button class="btn btn-secondary" id="v2-extra-consent-skip">僅雙方調課</button>
                    <button class="btn btn-primary" id="v2-extra-consent-confirm">送出</button>
                </div>
            </div>`;
        document.body.appendChild(backdrop);

        const cleanup = (result) => { backdrop.remove(); resolve(result); };
        backdrop.querySelector('#v2-extra-consent-skip').addEventListener('click', () => cleanup([]));
        backdrop.querySelector('#v2-extra-consent-confirm').addEventListener('click', () => {
            const names = Array.from(backdrop.querySelectorAll('.v2-extra-consent-cb:checked')).map(cb => cb.value);
            cleanup(names);
        });
    });
}

/**
 * 同步判斷該筆 record 在 V2 下是否需要他人同意（= 不應即時產 PDF）。
 * 必須在 addSubstituteRecord 呼叫當下同步完成，以便標記 record。
 */
function v2NeedsApproval(record) {
    if (!roleSvc.isSignedIn()) return false;
    if (roleSvc.isAdmin()) return false;              // admin 代發起直接成立
    if (record.isSelfSwap) return false;              // A→A 自我調課直接成立
    const me = roleSvc.getCurrentIdentity();
    const myName = me?.name;
    if (!myName) return false;

    if (record.type === '代課') {
        const target = record.substituteTeacher;
        return !!target && target !== myName;
    }
    if (record.type === '調課') {
        const target = record.swapTeacher || record.substituteTeacher;
        return !!target && target !== myName;
    }
    return false;
}

async function writeV2Record(record) {
    const me = roleSvc.getCurrentIdentity();
    if (!me) throw new Error('尚未登入');

    // 教師清單整個送出流程只抓一次，供 promptAdditionalConsentTeachers 與 resolveApproverInfo 共用
    const teachers = await dataSvc.listTeachers();

    // Phase 3：一般教師發起的「單筆」調課（非自我調課）先詢問是否還有其他教師需一併同意，
    // 藉此升級為多重調課。admin 代發起、自我調課、既有「多重調課批次」（見 app.js
    // submitSwapBatch，一次送出多筆各自獨立的雙方調課）皆不問——批次調課本身已是使用者
    // 逐筆挑定的雙方組合，維持既有 UX，不重疊詢問全員同意名單。
    // 注意：判斷「是否為批次調課」刻意用 record.batchId，不用 record.isMultiSwap——app.js
    // 的 buildSwapRecord() 對單次與批次調課都無條件寫死 isMultiSwap: true（V1 從未讀取這個
    // 欄位，是誤導性的死欄位；this.isMultiSwapMode 才是 V1 真正在用的獨立 UI 狀態），沿用它
    // 當守門條件會恆為 false，這個 modal 永遠不會出現。batchId 只有 submitSwapBatch 批次送出
    // 時才會賦值（在呼叫 addSubstituteRecord 之前設定，見 app.js:3224），單次調課沒有此欄位，
    // 可精確區分兩者。請勿改回 isMultiSwap。
    if (record.type === '調課' && !record.isSelfSwap && !record.batchId && !roleSvc.isAdmin()
        && !Array.isArray(record.additionalConsentTeachers)) {
        record.additionalConsentTeachers = await promptAdditionalConsentTeachers(record, teachers);
    }

    const ids = await resolveApproverInfo(record, teachers);
    const payload = {
        ...record,
        ...ids,
        requestType: ids.requestType,
        // 多重調課才帶 consentTeacherIds；createRequest 未收到此欄位時會退回 swapTeacherId 單簽。
        ...(ids.requestType === REQUEST_TYPES.MULTI_SWAP
            ? { consentTeacherIds: [ids.swapTeacherId, ...ids.additionalConsentTeacherIds].filter(Boolean) }
            : {}),
        initiatedByName: record.originalTeacher || me.name,
    };
    // 同步已標記於 record.__v2NeedsApproval，避免傳到 Firestore；additionalConsentTeachers 是姓名陣列，
    // 已在 resolveApproverInfo 解析成 additionalConsentTeacherIds，不需再寫入文件。
    delete payload.__v2NeedsApproval;
    delete payload.additionalConsentTeachers;

    if (roleSvc.isAdmin()) {
        payload.initiatedBy = ids.originalTeacherId || me.teacherId;
        return requestSvc.adminCreate(payload);
    }

    payload.initiatedBy = me.teacherId;

    if (!ids.requiredApproverId) {
        // Phase 3：rules 只放行 isSelfSwap 的直接成立快速路徑。若非自我調課卻解析不到
        // 核准對象（對方教師姓名在 V2 teachers 集合查無帳號），直接丟明確錯誤——
        // 否則會被 rules 靜默 DENY，使用者只看到不知所云的 permission denied。
        // （錯誤訊息由 addSubstituteRecord 的 catch 以 alert 顯示，沿用既有錯誤呈現方式。）
        if (!record.isSelfSwap) {
            throw new Error(`無法辨識「${record.substituteTeacher || record.swapTeacher || '對方教師'}」的教師帳號，請聯絡管理員在「教師管理」確認名單後再送出。`);
        }
        // 自我調課 → 直接成立（rules 僅放行 isSelfSwap 這條快速路徑）
        const now = new Date().toISOString();
        const created = await dataSvc.createSubstituteRecord({
            ...payload,
            status:         'approved',
            initiatedByRole:'teacher',
            approvedAt:     now,
            createdAt:      now,
        });
        await logger.log(LOG_ACTIONS.APPROVE, LOG_TARGET_TYPES.SUBSTITUTE_RECORD, created.recordId, {
            selfApproved: true,
            initiatedBy:  payload.initiatedBy,
        });
        return created;
    }

    const saved = await requestSvc.createRequest(payload);
    // 顯示正確的送出訊息（pending，尚未產 PDF；PDF 改到組長/主任核准後才產生）
    const extraCount = ids.additionalConsentTeacherIds.length;
    const msg = ids.requestType === REQUEST_TYPES.SUBSTITUTE
        ? `已送出，等待組長/主任核准。核准後才會正式成立並產生 PDF。`
        : `已送出給 ${ids.requiredApproverName}${extraCount ? ` 等 ${1 + extraCount} 位教師` : ''}同意。全員同意並經組長/主任核准後才會正式成立並產生 PDF。`;
    notify(msg, 'info', 5000);
    return saved;
}

// 標示「正在處理的批次中含 pending」，讓 showToast 吞掉誤導訊息。
let _swallowPdfSummaryToast = false;

// 同步 cache：由 onSnapshot 更新，供 checkExistingRecord 同步查詢。
let _v2RecordsCache = [];
let _v2PendingCache = [];

// Phase 6：private/detail（leaveType/leaveTypeName/reason）快取，recordId → detail
// （讀不到或不存在記為 {}，避免對同一批無權讀的紀錄重複發請求）。身份切換時必須清空
// （見 resetV2ViewState 與登出分支），否則前一身份讀到的敏感欄位會外洩給下一個登入者。
let _v2RecordDetailCache = new Map();

// subscribeSubstituteRecords 的 onSnapshot 回呼補讀 detail 後才寫入 _v2RecordsCache（見下方），
// 這段 await 期間若又收到更新的快照，較慢的舊一輪補讀不應該在較新一輪之後才完成並覆蓋回去
// （原本的同步賦值不存在這個競態窗口，是這裡新增 await 才引入的，故在此自行補上世代守門）。
let _v2RecordsCacheGen = 0;

/**
 * 依身份篩出「需要且讀得到」private/detail 的紀錄：approver 全部；一般教師僅與自己
 * 相關者（判斷邏輯與 roleSvc.filterRecordsForCurrent 一致）。若對全校紀錄一律發請求，
 * 一般教師會對絕大多數紀錄觸發 permission-denied（吵雜且浪費 Firestore 配額）。
 */
function pickRecordsNeedingDetail(records) {
    return roleSvc.isApprover() ? records : roleSvc.filterRecordsForCurrent(records);
}

/**
 * 把 private/detail（leaveType/leaveTypeName/reason）併回紀錄陣列，private 優先、
 * 父文件 fallback（相容尚未遷移的舊資料——既有紀錄的三個欄位仍留在父文件上）。
 * 月結算（settlementCalculator）與 PDF 皆仰賴這裡補齊的 leaveType 判斷是否扣減鐘點費。
 *
 * 效能取捨：
 *   - 只對 pickRecordsNeedingDetail() 篩出的紀錄發請求，不對全校紀錄一律發請求。
 *   - 已抓過的 recordId 存在 _v2RecordDetailCache，onSnapshot 重繪時只補抓新增的 id，
 *     不會每次都重新打全部紀錄的 detail（紀錄多時尤其重要）。
 */
async function hydrateRecordsWithDetail(records) {
    if (!Array.isArray(records) || records.length === 0) return records || [];
    const candidates = pickRecordsNeedingDetail(records);
    const idsToFetch = [...new Set(
        candidates.map(r => r.recordId).filter(id => id && !_v2RecordDetailCache.has(id))
    )];
    if (idsToFetch.length) {
        const fetched = await dataSvc.getRecordDetailsBulk(idsToFetch);
        idsToFetch.forEach(id => _v2RecordDetailCache.set(id, fetched.get(id) || {}));
    }
    return records.map(r => {
        const detail = r.recordId ? _v2RecordDetailCache.get(r.recordId) : null;
        if (!detail) return r;
        return {
            ...r,
            leaveType:     detail.leaveType     ?? r.leaveType,
            leaveTypeName: detail.leaveTypeName ?? r.leaveTypeName,
            reason:        detail.reason        ?? r.reason,
        };
    });
}

function conflictMatches(item, date, period, className, originalTeacher) {
    return item
        && item.date === date
        && item.period === period
        && item.className === className
        && item.originalTeacher === originalTeacher;
}

/**
 * V2 下的衝堂檢查：合併 substituteRecords（已成立）與 pendingRequests（尚待同意/尚待核准）。
 * pending 也視為衝突：若已送出請求未處理，就不該再送第二筆同樣時段。
 * Phase 3：狀態值從單一 'pending' 拆成 pending_swap_consent / pending_approval 兩種在途狀態，
 * 兩者都仍算「尚未定案、應擋下重複申請」；只有 approved（已轉入 substituteRecords，
 * 由 _v2RecordsCache 涵蓋）與 rejected（已無效）才不算衝突。
 * 回傳與 dataManager.checkExistingRecord 相容的紀錄物件，或 null。
 */
function v2CheckExistingRecord(date, period, className, originalTeacher) {
    const args = [date, period, className, originalTeacher];
    const r = _v2RecordsCache.find(x => conflictMatches(x, ...args));
    if (r) return r;
    // _v2PendingCache 寫入點已統一過 normalizeLegacyRequest，這裡直接看 status 即可
    const p = _v2PendingCache.find(x => {
        if (!conflictMatches(x, ...args)) return false;
        const status = x.status || REQUEST_STATUS.PENDING_SWAP_CONSENT;
        return status === REQUEST_STATUS.PENDING_SWAP_CONSENT || status === REQUEST_STATUS.PENDING_APPROVAL;
    });
    if (p) return { ...p, type: p.type || '代課', __v2Pending: true };
    return null;
}

/* ===== P2 全校課表共享 ===== */

// 課表同步節流：in-flight 時再來的請求記 pending，寫完再補跑一次（避免丟失最後一次變更）。
let _v2ScheduleSyncInFlight = false;
let _v2ScheduleSyncPending = false;
// 已套用的遠端課表簽章（updatedAt|長度），用來略過重複快照（含 approver 自己的 echo）。
let _v2LastAppliedScheduleSig = null;

/**
 * 把全校課表快照（schools/{schoolId}/data/schedule）套用到本機 dataManager 並刷新 UI。
 * 所有角色登入 / 收到即時推播時呼叫；教師端因此看到與 approver 同一份課表。
 * 直接寫欄位（不走 setter / loadFromCloud），避免觸發 notifyDataChange → 個人雲端回寫。
 */
function applyRemoteSchedule(doc) {
    const dm = window.app?.dataManager;
    if (!dm || !doc || !Array.isArray(doc.scheduleData)) return;
    // 相同快照（含自己剛寫入的 echo）不重複套用 / 重繪
    const sig = (doc.updatedAt || '') + '|' + doc.scheduleData.length;
    if (sig === _v2LastAppliedScheduleSig) return;
    _v2LastAppliedScheduleSig = sig;

    dm.scheduleData = doc.scheduleData;
    if (Array.isArray(doc.teachers)) dm.teachers = doc.teachers;
    if (Array.isArray(doc.classes))  dm.classes  = doc.classes;
    if (typeof doc.schoolName === 'string') dm.schoolName = doc.schoolName;
    if (doc.subjectDomainMap && dm.settings) dm.settings.subjectDomainMap = doc.subjectDomainMap;

    // 落地 localStorage（V2 停用個人雲端，此為本機主要儲存；否則離線 / 重整前會看不到課表）
    try { window.app?.saveDataToStorage?.(); } catch (e) { console.warn('[V2] 課表本機儲存失敗:', e); }
    // 沿用雲端同步後的既有刷新流程（課表狀態 / 教師表 / 下拉 / 頁籤鎖等）
    try { window.app?.refreshUIAfterSync?.(); } catch (e) { console.warn('[V2] 課表 UI 刷新失敗:', e); }
}

/**
 * approver 匯入 / 編輯課表後，把本機完整快照寫回全校 schedule doc。
 * 由 patched setScheduleData / addScheduleEntry / updateScheduleEntry / removeScheduleEntry
 * 以 microtask 延後呼叫，確保同批 setTeachers/setClasses 已完成。
 * 允許空課表寫入（approver 清空時需傳播）；in-flight 時記 pending，寫完補跑，不丟最後變更。
 */
async function syncScheduleToV2() {
    if (!roleSvc.isApprover()) return;
    const dm = window.app?.dataManager;
    if (!dm) return;
    if (_v2ScheduleSyncInFlight) { _v2ScheduleSyncPending = true; return; }

    _v2ScheduleSyncInFlight = true;
    try {
        do {
            _v2ScheduleSyncPending = false;
            const scheduleData = dm.getScheduleData?.() || dm.scheduleData || [];
            if (!Array.isArray(scheduleData)) break;
            const me = roleSvc.getCurrentIdentity();
            await dataSvc.saveSchedule({
                scheduleData,
                teachers:         dm.getTeachers?.() || dm.teachers || [],
                classes:          dm.classes || [],
                schoolName:       dm.schoolName || '',
                subjectDomainMap: dm.settings?.subjectDomainMap || {},
                meta: {
                    uploadedByName:      me?.name || '',
                    uploadedByTeacherId: me?.teacherId || null,
                },
            });
            await logger.log(LOG_ACTIONS.SCHEDULE_IMPORT, LOG_TARGET_TYPES.SCHEDULE, null, {
                entries: scheduleData.length,
            });
        } while (_v2ScheduleSyncPending);
        window.app?.showToast?.('✅ 全校課表已更新，所有教師即時同步', 'success', 3500);
    } catch (err) {
        console.error('[V2] 全校課表同步失敗:', err);
        notifyError(err, '全校課表同步');
    } finally {
        _v2ScheduleSyncInFlight = false;
    }
}

function patchDataManager() {
    const dm = window.app?.dataManager;
    if (!dm || dm.__v2_patched) return;
    dm.__v2_patched = true;

    // P2：V2 模式改以全校 schools/{schoolId}/data 為課表真相來源，徹底切斷 V1 個人雲端（users/{uid}）。
    // 這裡（bootstrap 的 await 之後、window.app 已存在）才安全覆寫；放在 await 之前會因 window.app
    // 尚未由 app.js 的 DOMContentLoaded 建立而被跳過。
    if (typeof window.app.checkAndHandleSync === 'function') {
        window.app.checkAndHandleSync = async () => {};   // 停用登入時個人雲端讀取 / 合併視窗
    }
    dm.syncToCloud = async () => {};                       // 停用所有個人雲端寫入（含 saveDataToStorage 內）
    try { dm.disableRealtimeSync?.(); } catch (_) {}

    const origAdd = dm.addSubstituteRecord.bind(dm);
    dm.addSubstituteRecord = function(record) {
        if (roleSvc.isSignedIn()) {
            // 同步標記：pending 路徑不應產 PDF（由 patched generatePDF 檢查）
            record.__v2NeedsApproval = v2NeedsApproval(record);
            if (record.__v2NeedsApproval) _swallowPdfSummaryToast = true;
            writeV2Record(record)
                .then(async () => {
                    await renderPendingTab();
                    await renderRecordsTab();
                })
                .catch(err => {
                    console.error('[V2] 寫入失敗:', err);
                    notifyError(err, '寫入調代課紀錄');
                });
            return; // 不 push local
        }
        return origAdd(record);
    };

    // 衝堂檢查：V2 下改查 Firestore cache（含 substituteRecords 與 pendingRequests）。
    const origCheck = typeof dm.checkExistingRecord === 'function'
        ? dm.checkExistingRecord.bind(dm) : null;
    dm.checkExistingRecord = function(date, period, className, originalTeacher) {
        if (roleSvc.isSignedIn()) {
            return v2CheckExistingRecord(date, period, className, originalTeacher);
        }
        return origCheck ? origCheck(date, period, className, originalTeacher) : null;
    };

    /**
     * 月結算 / 智慧推薦等 V1 呼叫點的資料來源修補：V2 下 addSubstituteRecord 已改寫 Firestore、
     * 不再 push 進 dm.substituteRecords（見上方 patch），若不連帶修補這裡，getSubstituteRecords()
     * 會永遠讀到空陣列（或殘留的舊 localStorage 資料），月結算等下游功能形同壞掉。
     * 真相來源改為 _v2RecordsCache（由 subscribeSubstituteRecords 即時同步，見本檔案下方）。
     *
     * 刻意回傳「未過濾」的全校紀錄，不套 roleSvc.filterRecordsForCurrent()。取捨理由：
     *   1. app.js:2164 showRecommendations()（代課推薦，全角色可見）也吃這個方法；若在此過濾成
     *      只剩與自己相關的紀錄，一般教師會看不到其他教師既有的代課安排，導致推薦引擎無法排除
     *      已被排課的候選人——這是正確性 bug，優先於在這一層做身份過濾。
     *   2. firestore.rules 對 substituteRecords 的 read 規則本來就是 isSignedIn() 即放行全部，
     *      任何登入教師用 DevTools 都能直接讀到完整集合，這裡過濾不提供任何實質保護，純粹是
     *      前端體驗層——不是安全邊界，未來請勿誤當成安全漏洞「修」回去。
     *   3. 真正需要「僅顯示與自己相關」的顯示層——調代課紀錄頁籤（renderRecordsTab，見本檔案
     *      下方）——並未透過這個方法取資料，而是自行呼叫 dataSvc.listSubstituteRecords() 後
     *      再套 roleSvc.filterRecordsForCurrent()，不受這裡影響，過濾行為仍然存在。
     *   4. 月結算頁籤已於 commit 5ec4561 加上 .v2-approver-only，一般教師連分頁都進不去，不會
     *      經由 generateSettlement() / exportSettlementExcel() 間接看到全校結算。
     * 回傳的是**複本**而非 _v2RecordsCache 本身：該陣列同時是衝堂檢查（v2CheckExistingRecord）
     * 的資料源，若把內部參考交出去，下游任何 .sort() / .splice() 都會就地汙染即時同步快取，
     * 變成極難追查的偶發衝堂誤判。原實作（dataManager.js:486）也是回傳 [...] 複本。
     *
     * (startDate, endDate, teacherFilter) 三個篩選參數比照原實作套用，排序也比照原實作
     * 「日期新到舊」——dataManager.getMonthlyRecords() 內部就是帶日期參數呼叫本方法，
     * 若在此靜默忽略參數，那條路徑會拿到全部紀錄而完全沒有錯誤訊號。
     */
    const origGet = dm.getSubstituteRecords.bind(dm);
    dm.getSubstituteRecords = function(startDate = '', endDate = '', teacherFilter = '') {
        if (!roleSvc.isSignedIn()) {
            return origGet(startDate, endDate, teacherFilter);
        }
        const norm = (d) => (typeof dm.normalizeDate === 'function' ? dm.normalizeDate(d) : d);
        let records = [..._v2RecordsCache];
        if (startDate) {
            const s = norm(startDate);
            records = records.filter(r => norm(r.date) >= s);
        }
        if (endDate) {
            const e = norm(endDate);
            records = records.filter(r => norm(r.date) <= e);
        }
        if (teacherFilter) {
            records = records.filter(r =>
                r.originalTeacher === teacherFilter || r.substituteTeacher === teacherFilter);
        }
        records.sort((a, b) => new Date(b.date) - new Date(a.date));
        return records;
    };

    /**
     * Phase 1.6.a：課表匯入完成 → 自動 sync 教師清單到 V2 teachers 集合。
     * 攔截 dataManager.setTeachers：若主任登入且有新教師（teachers 集合中尚未存在 name 的），
     * 自動 importFromLegacyTeachers 並顯示「前往教師管理補 email」toast。
     */
    const origSetTeachers = dm.setTeachers.bind(dm);
    dm.setTeachers = function(teachers) {
        origSetTeachers(teachers);
        if (!roleSvc.canManageRoster()) return;
        if (!Array.isArray(teachers) || teachers.length === 0) return;
        autoSyncTeachersToV2(teachers).catch(err => {
            console.warn('[V2] 自動同步教師清單失敗：', err);
        });
    };

    /**
     * P2：approver 對課表的任何變更都回寫全校 schedule doc。
     * 需涵蓋「整批替換」(setScheduleData，匯入 / 教師刪除)、「單格增修刪」
     * (addScheduleEntry / updateScheduleEntry / removeScheduleEntry，課表編輯頁)，
     * 以及「設定學校名稱」(setSchoolName，課表匯入頁確認學校名稱按鈕)——
     * syncScheduleToV2() 的 payload 早已包含 schoolName 欄位，缺的只是觸發點：
     * 若不掛勾這裡，全校 schedule doc 的 schoolName 會永遠是空字串，而 app.js
     * canSwitchToTab() 同時要求 hasSchedule 與 schoolName 才放行大部分頁籤，
     * 一般教師端會被永久卡在「請先設定學校名稱」（教師本身無權限設定）。
     * 套用遠端課表用 applyRemoteSchedule 直接設欄位、不經這些方法，故不會自我觸發迴圈。
     * microtask 延後：讓同批 setTeachers/setClasses 先跑完，快照才完整。
     */
    const queueScheduleSync = () => {
        if (!roleSvc.isApprover()) return;   // 教師無寫入權（rules 亦擋），不回寫
        queueMicrotask(() => { syncScheduleToV2(); });
    };
    const wrapScheduleMutator = (name, { requireSchedule = false } = {}) => {
        if (typeof dm[name] !== 'function') return;
        const orig = dm[name].bind(dm);
        dm[name] = function(...args) {
            const r = orig(...args);
            // requireSchedule：本機課表為空時不觸發回寫。syncScheduleToV2 寫的是「本機完整
            // 快照」且刻意允許空課表寫入（approver 清空課表時需要傳播），對前四個方法而言
            // 那是正確的——它們本身就是課表異動。但 setSchoolName 不是：若 approver 在遠端
            // 課表快照尚未抵達（subscribeSchedule 是非同步）或本機被清空時按下「確認學校
            // 名稱」，就會用一份空課表覆蓋全校資料。
            if (requireSchedule) {
                const sched = dm.getScheduleData?.() || dm.scheduleData || [];
                if (!Array.isArray(sched) || sched.length === 0) {
                    console.warn(`[V2] ${name} 未觸發全校課表回寫：本機課表為空，避免以空課表覆蓋全校資料`);
                    return r;
                }
            }
            queueScheduleSync();
            return r;
        };
    };
    ['setScheduleData', 'addScheduleEntry', 'updateScheduleEntry', 'removeScheduleEntry']
        .forEach(n => wrapScheduleMutator(n));
    // setSchoolName 與上述四者同形（單一參數、同步賦值、無回傳值），可共用包裝，
    // 但必須加 requireSchedule 守門，理由見上方註解。
    wrapScheduleMutator('setSchoolName', { requireSchedule: true });
}

let _autoSyncInFlight = false;
async function autoSyncTeachersToV2(legacyTeachers) {
    if (_autoSyncInFlight) return;
    _autoSyncInFlight = true;
    try {
        const created = await teacherMgr.importFromLegacyTeachers(legacyTeachers);
        if (!created.length) return;

        const app = window.app;
        const message = `📋 已自動加入 ${created.length} 位教師到名單`;
        if (app && typeof app.showToast === 'function') {
            app.showToast(message, 'success', 6000);
        }
        showGoToTeacherAdminToast(created.length);
        await renderTeachersAdminTab();
    } finally {
        _autoSyncInFlight = false;
    }
}

function showGoToTeacherAdminToast(count) {
    const existing = document.getElementById('v2-import-followup-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'v2-import-followup-toast';
    toast.style.cssText = `
        position: fixed; bottom: 24px; right: 24px; z-index: var(--z-toast);
        background: #fffbeb; border: 1px solid #d97706; border-radius: 8px;
        padding: 12px 16px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        max-width: 320px; font-size: 0.9rem;
    `;
    toast.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px;">
            <span style="font-size:1.4rem;">📧</span>
            <div style="flex:1;">
                <div style="font-weight:600; color:#92400e;">${count} 位新教師待指派 email</div>
                <div style="color:#78350f; font-size:0.82rem; margin-top:2px;">未指派 email 的教師無法登入系統</div>
            </div>
        </div>
        <div style="display:flex; gap:8px; margin-top:10px;">
            <button id="v2-goto-teacher-admin" class="btn btn-primary btn-sm" style="flex:1;">前往教師管理</button>
            <button id="v2-dismiss-followup-toast" class="btn btn-secondary btn-sm">稍後</button>
        </div>
    `;
    document.body.appendChild(toast);

    document.getElementById('v2-goto-teacher-admin').addEventListener('click', () => {
        const tabBtn = document.querySelector('.tab-btn[data-tab="teachers"]');
        if (tabBtn) tabBtn.click();
        toast.remove();
    });
    document.getElementById('v2-dismiss-followup-toast').addEventListener('click', () => toast.remove());

    setTimeout(() => toast.remove(), 30000);
}

/**
 * 攔截 app 層 PDF 生成：V2 pending 請求不產 PDF，等對方同意後再由 approve 流程產生。
 * admin 代發起 / 自我調課仍正常產生。
 */
function patchPdfGenerators() {
    const app = window.app;
    if (!app || app.__v2_pdf_patched) return;
    app.__v2_pdf_patched = true;

    if (typeof app.generateSubstitutePDF === 'function') {
        const origSingle = app.generateSubstitutePDF.bind(app);
        app.generateSubstitutePDF = async function(record) {
            if (record?.__v2NeedsApproval) {
                console.log('[V2] 此請求待同意，暫不產生 PDF');
                return;
            }
            return origSingle(record);
        };
    }

    if (typeof app.generateMultiCoursePDF === 'function') {
        const origMulti = app.generateMultiCoursePDF.bind(app);
        app.generateMultiCoursePDF = async function(records, courses) {
            if (Array.isArray(records) && records.some(r => r?.__v2NeedsApproval)) {
                console.log('[V2] 多節課請求待同意，暫不產生 PDF');
                return;
            }
            return origMulti(records, courses);
        };
    }

    // 攔截 app.js 寫死的「PDF 已生成」彙總 toast：僅當本批次確實含 pending 時才吞。
    if (typeof app.showToast === 'function') {
        const origToast = app.showToast.bind(app);
        app.showToast = function(message, type, duration) {
            if (_swallowPdfSummaryToast
                && typeof message === 'string'
                && /PDF 已生成|PDF 已逐一生成/.test(message)) {
                _swallowPdfSummaryToast = false;
                return;
            }
            return origToast(message, type, duration);
        };
    }
}

/**
 * 同意方產生 PDF（供 approve 按鈕呼叫）。
 */
async function generatePdfForRecord(record) {
    const app = window.app;
    if (!app?.pdfGenerator) {
        console.warn('[V2] pdfGenerator 不可用，略過 PDF 產生');
        return;
    }
    // Phase 6：leaveType/leaveTypeName/reason 已搬到 private/detail 子文件，這裡拿到的
    // record（approveRequest 回傳值或 listSubstituteRecords 讀回的父文件）都已不含這三欄。
    // 產生 PDF 前補讀一次，private 優先、record 本身 fallback（相容尚未遷移的舊紀錄——
    // 產線現存那筆 2026-07-24 舊紀錄的 leaveType 仍在父文件上，getRecordDetail 讀不到
    // private 文件時會回 null，此時就地使用 record.leaveType）。
    const detail = record?.recordId ? await dataSvc.getRecordDetail(record.recordId) : null;
    const enriched = detail ? {
        ...record,
        leaveType:     detail.leaveType     ?? record.leaveType,
        leaveTypeName: detail.leaveTypeName ?? record.leaveTypeName,
        reason:        detail.reason        ?? record.reason,
    } : record;
    const scheduleData = app.dataManager?.getScheduleData?.() || [];
    const teachers     = app.dataManager?.getTeachers?.() || [];
    try {
        await app.pdfGenerator.generateSubstituteForm(enriched, scheduleData, teachers);
    } catch (e) {
        console.error('[V2] PDF 產生失敗：', e);
        app.showToast?.('PDF 產生失敗：' + e.message, 'error', 4000);
    }
}

/* ===== Phase 1.6.b 雙軌登入：Email 入口 + Modal ===== */

function injectEmailLoginTrigger() {
    const loggedOutBox = document.getElementById('auth-logged-out');
    if (!loggedOutBox || document.getElementById('v2-email-login-trigger')) return;
    const link = document.createElement('button');
    link.id = 'v2-email-login-trigger';
    link.className = 'v2-email-login-trigger';
    link.textContent = '使用 Email / 密碼登入';
    link.addEventListener('click', () => openAuthModal('signin'));
    loggedOutBox.appendChild(link);
}

function closeAuthModal() {
    document.getElementById('v2-auth-modal-backdrop')?.remove();
}

function openAuthModal(mode = 'signin') {
    closeAuthModal();
    const backdrop = document.createElement('div');
    backdrop.id = 'v2-auth-modal-backdrop';
    backdrop.className = 'v2-modal-backdrop';

    const titles = {
        signin:   'Email 登入',
        forgot:   '重設密碼',
        register: '新教師註冊',
    };
    const helpText = {
        signin:   '若您剛被加入名單但還沒收到密碼設定信，請先聯絡教務主任「📧 寄密碼設定信」。',
        forgot:   '系統會寄出一封密碼重設信到您的 email。請使用主任已為您加入名單的 email。',
        register: '註冊前請先確認教務主任已把您的 email 加進名單，否則註冊後會被系統擋下並登出。',
    };

    backdrop.innerHTML = `
        <div class="v2-modal">
            <h3>${titles[mode]}</h3>
            ${mode !== 'forgot' ? `
                <label>Email</label>
                <input type="email" id="v2-modal-email" placeholder="your@email.com" autocomplete="email">
                <label>密碼${mode === 'register' ? '（至少 6 字元）' : ''}</label>
                <input type="password" id="v2-modal-pwd" placeholder="••••••••" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}">
            ` : `
                <label>Email</label>
                <input type="email" id="v2-modal-email" placeholder="your@email.com" autocomplete="email">
            `}
            <div class="v2-modal-msg" id="v2-modal-msg" style="display:none;"></div>
            <p style="font-size:0.78rem; color:#6b7280; margin-top:0.6rem;">${helpText[mode]}</p>
            <div class="v2-modal-actions">
                <button class="btn btn-secondary" id="v2-modal-cancel">取消</button>
                <button class="btn btn-primary" id="v2-modal-submit">
                    ${mode === 'signin' ? '登入' : mode === 'forgot' ? '寄重置信' : '註冊'}
                </button>
            </div>
            <div class="v2-modal-links">
                ${mode !== 'signin' ? `<a data-mode="signin">← 回登入</a>` : `<span></span>`}
                ${mode !== 'forgot'   ? `<a data-mode="forgot">忘記密碼？</a>` : ''}
                ${mode !== 'register' ? `<a data-mode="register">我是新教師（註冊）</a>` : ''}
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    const msgEl = backdrop.querySelector('#v2-modal-msg');
    const showMsg = (text, kind = 'error') => {
        msgEl.textContent = text;
        msgEl.className = 'v2-modal-msg ' + kind;
        msgEl.style.display = 'block';
    };

    backdrop.querySelector('#v2-modal-cancel').addEventListener('click', closeAuthModal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAuthModal(); });
    backdrop.querySelectorAll('.v2-modal-links a').forEach(a =>
        a.addEventListener('click', () => openAuthModal(a.dataset.mode)));

    backdrop.querySelector('#v2-modal-submit').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const email = backdrop.querySelector('#v2-modal-email').value.trim();
        const pwd   = backdrop.querySelector('#v2-modal-pwd')?.value || '';
        if (!email) { showMsg('請輸入 Email'); return; }
        if (mode !== 'forgot' && !pwd) { showMsg('請輸入密碼'); return; }
        btn.disabled = true;
        try {
            if (mode === 'signin') {
                await authMod.signInWithEmail(email, pwd);
                closeAuthModal();
                // onAuthStateChange 會接手 → authGuardV2 配對名單
            } else if (mode === 'forgot') {
                await authMod.sendPasswordReset(email);
                showMsg('已寄出密碼重設信，請至信箱收信。若未收到，請確認 email 正確且已被加入名單。', 'success');
                btn.textContent = '已寄出';
            } else if (mode === 'register') {
                await authMod.registerWithEmail(email, pwd);
                closeAuthModal();
                // onAuthStateChange 會接手；若 email 不在名單會被 authGuardV2 擋下並登出
            }
        } catch (e) {
            showMsg(e.message || '操作失敗');
            btn.disabled = false;
        }
    });
}

/* ===== 主啟動流程 ===== */

async function bootstrap() {
    if (!isV2Enabled()) return;

    injectV2Styles();
    document.body.classList.add('v2-active');

    // 讓 V2 專屬頁籤不受原「需先匯入課表」閘門擋下
    if (window.app && typeof window.app.canSwitchToTab === 'function') {
        const orig = window.app.canSwitchToTab.bind(window.app);
        window.app.canSwitchToTab = (tabId) => tabId.startsWith('v2-') ? true : orig(tabId);
    }

    injectEmailLoginTrigger();
    injectV2AuthGate();
    // 預設鎖定：授權身份解析成功前，整個 app（含底層月結算）都被遮罩 + inert 擋住。
    lockV2App();
    await authMod.initAuthService();

    // window.app 於此（initAuthService 之後）已由 app.js 的 DOMContentLoaded 建立。
    // 必須在註冊 onAuthStateChange 前套用 dataManager patch（含停用 V1 個人雲端 + 課表攔截），
    // 確保任何 auth 回呼觸發的資料流都已走 V2 規則。
    patchDataManager();

    let unsubs = [];
    const clearSubs = () => { unsubs.forEach(u => { try { u(); } catch (_) {} }); unsubs = []; };
    let lastAuthUid;   // 追蹤上一個登入 uid，區分「真的換人／登出」與 Firebase 對同帳號 re-emit

    authMod.onAuthStateChange(async (user) => {
        clearSubs();
        const newUid = user ? user.uid : null;
        const identityChanged = newUid !== lastAuthUid;
        lastAuthUid = newUid;
        // 資安：只有身份「實際改變」（換人 / 登出 / 首次登入）才重置視圖與遞增世代，
        // 杜絕「登出主任→登入組長」未重整時仍看見主任階段渲染的教師名單／待辦／全校紀錄；
        // 同帳號 re-emit 時跳過，避免誤刪未存表單輸入或無謂彈回頁籤。
        if (identityChanged) {
            _v2IdentityGen++;
            resetV2ViewState();
        }
        if (!user) {
            roleSvc.clearCurrentIdentity();
            document.body.classList.remove('v2-admin', 'v2-director', 'v2-section-chief', 'v2-teacher', 'v2-approver');
            _v2RecordsCache = [];
            _v2PendingCache = [];
            _v2RecordDetailCache.clear();
            _v2RecordsCacheGen++;   // 同上：作廢登出前任何仍在飛行中的補讀
            // 登出即鎖定整個 app：遮罩 + .app-container inert 阻擋所有互動（含鍵盤跳至月結算下載）。
            // 不再 clearAll()——那只清記憶體不清 localStorage，反而會讓再登入資料看似遺失並有覆蓋風險。
            lockV2App();
            return;
        }
        try {
            // Phase 1.6.c：抓登入 provider（google.com / password），由 authGuardV2 寫入 teachers.authProvider
            const providerId = user.providerData?.[0]?.providerId || null;
            const identity = await authGuard.resolveIdentity({
                uid: user.uid, email: user.email,
                displayName: user.displayName, photoURL: user.photoURL,
                providerId,
            });
            if (!identity) {
                // 未授權：立即在遮罩顯示拒絕訊息（不依賴 signOut 的 re-emit；signOut 失敗也看得到原因），再嘗試登出
                _v2GateDeniedEmail = user.email || '(未知)';
                lockV2App();
                try { await authMod.signOutUser(); } catch (err) {
                    console.error('[v2] 拒絕後登出失敗:', err);
                    notifyError(err, '登出');
                }
                return;
            }
            // v2.0.0 三層角色 body class：
            //   v2-director / v2-section-chief / v2-teacher 三選一
            //   v2-approver = director ∪ section_chief（CSS .v2-approver-only 用）
            //   v2-admin    = 舊 alpha 類別，繼續寫入以兼容既有 CSS / DOM 查詢
            document.body.classList.remove('v2-director', 'v2-section-chief', 'v2-teacher', 'v2-approver', 'v2-admin');
            if (identity.role === ROLES.DIRECTOR) {
                document.body.classList.add('v2-director', 'v2-approver', 'v2-admin');
            } else if (identity.role === ROLES.SECTION_CHIEF) {
                document.body.classList.add('v2-section-chief', 'v2-approver', 'v2-admin');
            } else {
                document.body.classList.add('v2-teacher');
            }

            const roleLabelMap = { director: '教務主任', section_chief: '教學組長', teacher: '教師' };
            const nameSpan = document.getElementById('user-name');
            if (nameSpan) {
                nameSpan.innerHTML = `${identity.name} <span class="v2-role-tag ${identity.role}">${roleLabelMap[identity.role] || '教師'}</span>`;
            }

            // 初次渲染
            await renderPendingTab();
            await renderRecordsTab();
            if (roleSvc.canManageRoster()) {
                await renderTeachersAdminTab();
            }
            if (roleSvc.isApprover()) {
                await renderLogsTab();
            }
            // 初次渲染皆完成才解鎖，避免半渲染的可操作畫面外露；render 若丟錯則走 catch 維持鎖定。
            unlockV2App();

            // 即時同步：更新同步 cache + 重新渲染（cache 供 checkExistingRecord 使用）。
            // pending cache 一律先過 normalizeLegacyRequest（舊 status='pending' 文件
            // 映射為 pending_swap_consent），下游（衝堂檢查等）不必再逐項 normalize。
            // 每個訂閱皆傳入 onError：斷線/權限被撤時翻成人話提示 + 亮右上角同步中斷徽章；
            // onNext 成功回資料時解除徽章（代表連線已恢復）。
            const onSyncError = (err) => { notifyError(err, '即時同步'); setSyncStatus(false, err?.code); };
            unsubs.push(await dataSvc.subscribePendingRequests((items) => {
                _v2PendingCache = (Array.isArray(items) ? items : []).map(requestSvc.normalizeLegacyRequest);
                renderPendingTab();
                setSyncStatus(true);
            }, onSyncError));
            unsubs.push(await dataSvc.subscribeSubstituteRecords(async (items) => {
                // Phase 6：父文件已不含 leaveType/reason，即時同步進來的紀錄要先補 detail
                // 才能餵給月結算（見 hydrateRecordsWithDetail 檔頭註解）。gen 守門避免較舊的
                // 一輪補讀在較新一輪之後才完成、把新資料覆蓋回舊的。
                const gen = ++_v2RecordsCacheGen;
                const hydrated = await hydrateRecordsWithDetail(Array.isArray(items) ? items : []);
                if (gen !== _v2RecordsCacheGen) return;
                _v2RecordsCache = hydrated;
                renderRecordsTab();
                setSyncStatus(true);
            }, onSyncError));
            // P2：訂閱全校課表——首次即回傳目前值（教師端載入 approver 上傳的課表），
            // 之後任何 approver 上傳/編輯都即時套用到本機並重繪。
            unsubs.push(await dataSvc.subscribeSchedule((sched) => {
                if (sched) applyRemoteSchedule(sched);
                setSyncStatus(true);
            }, onSyncError));
            if (roleSvc.isApprover()) {
                unsubs.push(await dataSvc.subscribeOperationLogs(() => {
                    renderLogsTab();
                    setSyncStatus(true);
                }, {}, onSyncError));
            }

            // 首次塞 cache（onSnapshot 首次觸發前）— 讓即刻的衝堂檢查可用；同樣需要補 detail，
            // 否則身份確認後、onSnapshot 首次回呼前這段期間讀到的月結算會漏掉 leaveType。
            // 沿用同一支 gen 計數器：若 onSnapshot 已搶先在這段 await 期間完成過一輪，這裡就不再
            // 用（可能較舊的）結果覆蓋回去。
            {
                const initGen = ++_v2RecordsCacheGen;
                const initialRecords = await hydrateRecordsWithDetail(await dataSvc.listSubstituteRecords());
                if (initGen === _v2RecordsCacheGen) _v2RecordsCache = initialRecords;
            }
            _v2PendingCache = (await dataSvc.listPendingRequests()).map(requestSvc.normalizeLegacyRequest);
        } catch (e) {
            console.error('[v2] resolveIdentity 失敗:', e);
            // 維持鎖定並在遮罩顯示錯誤+重試入口，避免授權者被永久卡在誤導的「請登入」畫面。
            _v2GateError = true;
            lockV2App();
        }
    });

    bindV2TabSwitches();
    interceptSubmitButton();
    patchPdfGenerators();

    console.log('[V2] 權限系統已啟動');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
