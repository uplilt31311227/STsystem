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
import { LOG_ACTIONS, LOG_TARGET_TYPES, ROLES, REQUEST_STATUS } from './modules/v2/schemaConstants.js';
import * as authMod from './modules/authService.js';

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

    /* V2 模式下隱藏原本地「調代課紀錄」表格與查詢，避免與 V2 全校紀錄混淆 */
    body.v2-active #records-tab > #records-no-data,
    body.v2-active #records-tab > #records-content { display: none !important; }

    .v2-log-table { width: 100%; font-size: 0.85rem; border-collapse: collapse; }
    .v2-log-table th, .v2-log-table td { padding: 4px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; }
    .v2-log-table tbody tr:hover { background: #f9fafb; }

    .v2-teacher-row td { vertical-align: middle; }
    .v2-teacher-row input[type="email"] { width: 220px; }
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
       z-index 9990 低於登入 modal(10000)/toast(9999)，故登入 modal 仍可疊上操作。 */
    #v2-auth-gate { display: none; }
    body.v2-locked { overflow: hidden; }
    body.v2-locked #v2-auth-gate {
        position: fixed; inset: 0; z-index: 9990;
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
        z-index: 10000;
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

async function renderPendingTab() {
    const host = document.getElementById('v2-pending-list');
    if (!host) return;
    const _gen = _v2IdentityGen;
    host.innerHTML = '<p>載入中…</p>';

    const me = roleSvc.getCurrentIdentity();
    if (!me) { host.innerHTML = '<p>尚未登入。</p>'; return; }

    const all = await dataSvc.listPendingRequests();
    // 被邀請方的待辦只顯示 pending（不含已拒絕）
    const incoming = all.filter(r =>
        r.requiredApproverId === me.teacherId
        && (r.status || REQUEST_STATUS.PENDING) === REQUEST_STATUS.PENDING
    );
    // 發起人的看板同時顯示 pending + rejected（讓發起人知道被拒絕）
    const outgoing = all.filter(r => r.initiatedBy === me.teacherId);

    const statusBadge = (r) => {
        const s = r.status || REQUEST_STATUS.PENDING;
        if (s === REQUEST_STATUS.REJECTED) return '<span class="v2-status-tag rejected">❌ 被拒絕</span>';
        return '<span class="v2-status-tag pending">⏳ 等待中</span>';
    };

    const outgoingActions = (r) => {
        const s = r.status || REQUEST_STATUS.PENDING;
        if (s === REQUEST_STATUS.REJECTED) {
            return `<button class="btn btn-secondary btn-sm v2-dismiss-btn" data-id="${r.reqId}">我知道了</button>`;
        }
        return `<button class="btn btn-danger btn-sm v2-cancel-btn" data-id="${r.reqId}">撤回</button>`;
    };

    const render = (items, cls, emptyMsg, actionsFn, showStatus) => {
        if (!items.length) return `<p class="muted">${emptyMsg}</p>`;
        return items.map(r => `
            <div class="v2-pending-item ${cls}" data-id="${r.reqId}">
                <div>
                    ${showStatus ? statusBadge(r) + ' ' : ''}
                    <strong>${r.type || '調課'}</strong> ・ ${r.date || ''} 第 ${r.period || '?'} 節 ・ ${r.className || ''} ${r.subject || ''}
                </div>
                <div class="v2-pending-meta">
                    發起：${r.initiatedByName || r.initiatedBy || ''} ・ 對象：${r.requiredApproverName || r.requiredApproverId || ''} ・ ${fmtDate(r.createdAt)}
                    ${r.status === REQUEST_STATUS.REJECTED && r.rejectNote ? `<br>拒絕原因：${r.rejectNote}` : ''}
                </div>
                <div class="v2-pending-actions">${actionsFn(r)}</div>
            </div>`).join('');
    };

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填，保持 reset 清空的狀態
    host.innerHTML = `
        <div class="v2-section-header"><h3>待我同意</h3></div>
        ${render(incoming, 'incoming', '目前沒有等待您同意的請求', r =>
            `<button class="btn btn-primary btn-sm v2-approve-btn" data-id="${r.reqId}">同意並產生 PDF</button>
             <button class="btn btn-secondary btn-sm v2-reject-btn" data-id="${r.reqId}">拒絕</button>`,
            false
        )}
        <div class="v2-section-header" style="margin-top:2rem;"><h3>我已發起</h3></div>
        ${render(outgoing, 'outgoing', '目前沒有您發起中的請求', outgoingActions, true)}
    `;

    host.querySelectorAll('.v2-approve-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const saved = await requestSvc.approveRequest(btn.dataset.id);
                // 同意方當場取得 PDF（正式成立後才產）
                await generatePdfForRecord(saved);
                window.app?.showToast?.(`已同意並產生 PDF`, 'success', 3500);
                await renderPendingTab();
                await renderRecordsTab();
            } catch (e) {
                alert(e.message);
                btn.disabled = false;
            }
        }));
    host.querySelectorAll('.v2-reject-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            const note = prompt('拒絕原因（可留空，對方會看到）：') || '';
            try { await requestSvc.rejectRequest(btn.dataset.id, note); await renderPendingTab(); }
            catch (e) { alert(e.message); }
        }));
    host.querySelectorAll('.v2-cancel-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            if (!confirm('確定撤回此調課請求？')) return;
            try { await requestSvc.cancelRequest(btn.dataset.id); await renderPendingTab(); }
            catch (e) { alert(e.message); }
        }));
    host.querySelectorAll('.v2-dismiss-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            try { await requestSvc.dismissRejectedRequest(btn.dataset.id); await renderPendingTab(); }
            catch (e) { alert(e.message); }
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
    const roleLabel = (role) => {
        const r = (role === 'admin') ? 'director' : role;
        return { director: '主任', section_chief: '組長', teacher: '教師' }[r] || '教師';
    };
    const missingEmailCount = teachers.filter(t => !t.email).length;

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填教師名單
    host.innerHTML = `
        <div class="v2-section-header">
            <h3>
                教師帳號管理
                ${missingEmailCount > 0
                    ? `<span class="v2-badge" title="尚有教師未指派 email，無法登入">⚠ ${missingEmailCount} 位待指派 email</span>`
                    : ''}
            </h3>
            <div>
                <button class="btn btn-secondary btn-sm" id="v2-import-legacy-teachers">從課表匯入教師</button>
                <button class="btn btn-primary btn-sm" id="v2-add-teacher">新增教師</button>
            </div>
        </div>
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
                alert('已儲存');
                await renderTeachersAdminTab();
            } catch (e) { alert('儲存失敗：' + e.message); }
        }));

    host.querySelectorAll('.v2-delete-teacher').forEach(btn =>
        btn.addEventListener('click', async () => {
            const id = btn.closest('tr').dataset.id;
            if (!confirm('確定刪除此教師？此操作會寫入 log。')) return;
            try { await teacherMgr.deleteTeacher(id); await renderTeachersAdminTab(); }
            catch (e) { alert('刪除失敗：' + e.message); }
        }));

    host.querySelectorAll('.v2-send-reset').forEach(btn =>
        btn.addEventListener('click', async () => {
            const tr    = btn.closest('tr');
            const email = tr.querySelector('.v2-email-input').value.trim();
            if (!email) { alert('此教師尚未填 email，請先儲存 email 再試。'); return; }
            if (!confirm(`即將為 ${email} 建立 Auth 帳號（若不存在）並寄出密碼設定信。確認？`)) return;
            btn.disabled = true;
            const origText = btn.textContent;
            btn.textContent = '寄送中…';
            try {
                const r = await authMod.createTeacherAuthAndSendReset(email);
                alert(r.accountCreated
                    ? `✓ 已建立帳號並寄出密碼設定信給 ${email}`
                    : `✓ 該 email 已有帳號，已寄出密碼重置信給 ${email}`);
                btn.textContent = '已寄出';
                await logger.log(LOG_ACTIONS.TEACHER_BIND_EMAIL, LOG_TARGET_TYPES.TEACHER, tr.dataset.id, {
                    action: 'send_password_reset', email, accountCreated: r.accountCreated,
                });
            } catch (e) {
                console.error('寄密碼信失敗:', e);
                alert('寄信失敗：' + (e.message || e.code || '未知錯誤'));
                btn.textContent = origText;
                btn.disabled = false;
            }
        }));

    document.getElementById('v2-add-teacher')?.addEventListener('click', async () => {
        const name  = prompt('教師姓名：'); if (!name) return;
        const email = prompt('Email（可留空）：') || null;
        try { await teacherMgr.createTeacher({ name, email }); await renderTeachersAdminTab(); }
        catch (e) { alert('新增失敗：' + e.message); }
    });

    document.getElementById('v2-import-legacy-teachers')?.addEventListener('click', async () => {
        const legacy = window.app?.dataManager?.teachers || [];
        if (!legacy.length) { alert('找不到課表教師資料，請先於「課表匯入」載入課表'); return; }
        const created = await teacherMgr.importFromLegacyTeachers(legacy);
        alert(`已匯入 ${created.length} 位教師`);
        await renderTeachersAdminTab();
    });
}

async function renderLogsTab() {
    const host = document.getElementById('v2-logs');
    if (!host) return;

    const _gen = _v2IdentityGen;
    host.innerHTML = '<p>載入中…</p>';
    const all = await logger.fetchLogs({ limit: 300 });
    const visible = roleSvc.filterLogsForCurrent(all);

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填操作日誌
    host.innerHTML = `
        <div class="v2-section-header">
            <h3>操作日誌 <small style="color:#6b7280;font-weight:normal;">（${visible.length} 筆）</small></h3>
            <button class="btn btn-secondary btn-sm" id="v2-refresh-logs">重新整理</button>
        </div>
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

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填全校紀錄
    host.innerHTML = `
        <div class="v2-section-header">
            <h3>全校調代課紀錄 <small style="color:#6b7280;font-weight:normal;">（${visible.length} 筆｜${isApprover ? '核准者視圖' : '個人相關'}）</small></h3>
        </div>
        <table class="data-table data-table-compact">
            <thead><tr>
                <th>日期</th><th>節次</th><th>班級</th><th>原教師</th><th>代/調對象</th><th>類型</th><th>發起</th>
                <th>操作</th>
            </tr></thead>
            <tbody>
            ${visible.map(r => `
                <tr data-id="${r.recordId}">
                    <td>${r.date || ''}</td>
                    <td>${r.period || ''}</td>
                    <td>${r.className || ''}</td>
                    <td>${r.originalTeacher || ''}</td>
                    <td>${r.substituteTeacher || r.swapTeacher || ''}</td>
                    <td>${r.type || ''}${APPROVER_ROLES_FOR_BADGE.includes(r.initiatedByRole) ? ' <span class="v2-role-tag director">代發</span>' : ''}</td>
                    <td>${r.initiatedByName || ''}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm v2-download-pdf" data-id="${r.recordId}">下載 PDF</button>
                        ${isApprover ? `<button class="btn btn-danger btn-sm v2-admin-delete" data-id="${r.recordId}">刪除</button>` : ''}
                    </td>
                </tr>`).join('')}
            </tbody>
        </table>
    `;

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
                catch (e) { alert('刪除失敗：' + e.message); }
            }));
    }
}

/* ===== 頁籤切換偵測 ===== */

function bindV2TabSwitches() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tab = btn.dataset.tab;
            if (tab === 'v2-pending')  await renderPendingTab();
            if (tab === 'v2-teachers') await renderTeachersAdminTab();
            if (tab === 'v2-logs')     await renderLogsTab();
            if (tab === 'records')     await renderRecordsTab();
        }, { passive: true });
    });
}

// 每次身份「實際切換」+1；非同步渲染據此判斷手上的結果是否已過期（見 isStaleRender）。
let _v2IdentityGen = 0;

/** 非同步 render 取回資料後、寫入 DOM 前呼叫：若期間身份已切換則放棄本次繪製，避免舊身份資料回填。 */
function isStaleRender(gen) { return gen !== _v2IdentityGen; }

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
 *   3. 彈回中性預設頁籤「課表匯入」（等同重新整理後的初始頁），避免新身份落在
 *      對其 display:none 的 .active 面板而看見空白、或殘留看見上一身份內容
 * 必須在套用新 body 角色 class 與重新渲染「之前」呼叫。
 */
function resetV2ViewState() {
    V2_IDENTITY_CONTENT_HOSTS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    _v2RecordsCache = [];
    _v2PendingCache = [];
    forceActivateTab('import');
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
            alert(`您僅能發起自己的課務調代課。\n您的身份為「${me.name}」，但「原任課教師」選的是「${selectedName}」。`);
            logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.SUBSTITUTE_RECORD, null, {
                reason: 'non_admin_initiate_other',
                attemptedTeacher: selectedName,
                myTeacher: me.name,
            });
        }
    }, true);
}

/* ===== dataManager patch：V2 模式下改走 V2 寫入 ===== */

async function resolveApproverInfo(record) {
    const teachers = await dataSvc.listTeachers();
    const findId   = (n) => teachers.find(t => t.name === n)?.teacherId || null;

    const originalTeacherId   = findId(record.originalTeacher);
    const substituteTeacherId = findId(record.substituteTeacher);
    const swapTeacherId       = findId(record.swapTeacher);

    let requiredApproverId   = null;
    let requiredApproverName = null;

    if (record.isSelfSwap) {
        // 自我調課不需他人同意
        requiredApproverId   = null;
        requiredApproverName = null;
    } else if (record.type === '代課') {
        requiredApproverId   = substituteTeacherId;
        requiredApproverName = record.substituteTeacher || null;
    } else if (record.type === '調課') {
        requiredApproverId   = swapTeacherId || substituteTeacherId;
        requiredApproverName = record.swapTeacher || record.substituteTeacher || null;
    }

    return {
        originalTeacherId,
        substituteTeacherId,
        swapTeacherId,
        requiredApproverId,
        requiredApproverName,
    };
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

    const ids = await resolveApproverInfo(record);
    const payload = {
        ...record,
        ...ids,
        initiatedByName: record.originalTeacher || me.name,
    };
    // 同步已標記於 record.__v2NeedsApproval，避免傳到 Firestore
    delete payload.__v2NeedsApproval;

    if (roleSvc.isAdmin()) {
        payload.initiatedBy = ids.originalTeacherId || me.teacherId;
        return requestSvc.adminCreate(payload);
    }

    payload.initiatedBy = me.teacherId;

    if (!ids.requiredApproverId) {
        // 自我調課或無其他教師涉入 → 直接成立
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
    // 顯示正確的送出訊息（pending，尚未產 PDF）
    const msg = `已送出給 ${ids.requiredApproverName} 同意。對方同意後紀錄才會正式成立並產生 PDF。`;
    if (window.app?.showToast) window.app.showToast(msg, 'info', 5000);
    else setTimeout(() => alert(msg), 100);
    return saved;
}

// 標示「正在處理的批次中含 pending」，讓 showToast 吞掉誤導訊息。
let _swallowPdfSummaryToast = false;

// 同步 cache：由 onSnapshot 更新，供 checkExistingRecord 同步查詢。
let _v2RecordsCache = [];
let _v2PendingCache = [];

function conflictMatches(item, date, period, className, originalTeacher) {
    return item
        && item.date === date
        && item.period === period
        && item.className === className
        && item.originalTeacher === originalTeacher;
}

/**
 * V2 下的衝堂檢查：合併 substituteRecords（已成立）與 pendingRequests（尚待同意）。
 * pending 也視為衝突：若已送出請求未處理，就不該再送第二筆同樣時段。
 * 回傳與 dataManager.checkExistingRecord 相容的紀錄物件，或 null。
 */
function v2CheckExistingRecord(date, period, className, originalTeacher) {
    const args = [date, period, className, originalTeacher];
    const r = _v2RecordsCache.find(x => conflictMatches(x, ...args));
    if (r) return r;
    const p = _v2PendingCache.find(x =>
        conflictMatches(x, ...args)
        && (x.status || 'pending') === 'pending'   // 排除 rejected（已無效）
    );
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
        window.app?.showToast?.('全校課表同步失敗：' + (err?.message || err), 'error', 5000);
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
                    alert('V2 寫入失敗：' + err.message);
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
     * 需涵蓋「整批替換」(setScheduleData，匯入 / 教師刪除) 與「單格增修刪」
     * (addScheduleEntry / updateScheduleEntry / removeScheduleEntry，課表編輯頁)。
     * 套用遠端課表用 applyRemoteSchedule 直接設欄位、不經這些方法，故不會自我觸發迴圈。
     * microtask 延後：讓同批 setTeachers/setClasses 先跑完，快照才完整。
     */
    const queueScheduleSync = () => {
        if (!roleSvc.isApprover()) return;   // 教師無寫入權（rules 亦擋），不回寫
        queueMicrotask(() => { syncScheduleToV2(); });
    };
    const wrapScheduleMutator = (name) => {
        if (typeof dm[name] !== 'function') return;
        const orig = dm[name].bind(dm);
        dm[name] = function(...args) {
            const r = orig(...args);
            queueScheduleSync();
            return r;
        };
    };
    ['setScheduleData', 'addScheduleEntry', 'updateScheduleEntry', 'removeScheduleEntry']
        .forEach(wrapScheduleMutator);
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
        position: fixed; bottom: 24px; right: 24px; z-index: 9999;
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
        const tabBtn = document.querySelector('.tab-btn[data-tab="v2-teachers"]');
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
    const scheduleData = app.dataManager?.getScheduleData?.() || [];
    const teachers     = app.dataManager?.getTeachers?.() || [];
    try {
        await app.pdfGenerator.generateSubstituteForm(record, scheduleData, teachers);
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
                try { await authMod.signOutUser(); } catch (err) { console.error('[v2] 拒絕後登出失敗:', err); }
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

            // 即時同步：更新同步 cache + 重新渲染（cache 供 checkExistingRecord 使用）
            unsubs.push(await dataSvc.subscribePendingRequests((items) => {
                _v2PendingCache = Array.isArray(items) ? items : [];
                renderPendingTab();
            }));
            unsubs.push(await dataSvc.subscribeSubstituteRecords((items) => {
                _v2RecordsCache = Array.isArray(items) ? items : [];
                renderRecordsTab();
            }));
            // P2：訂閱全校課表——首次即回傳目前值（教師端載入 approver 上傳的課表），
            // 之後任何 approver 上傳/編輯都即時套用到本機並重繪。
            unsubs.push(await dataSvc.subscribeSchedule((sched) => {
                if (sched) applyRemoteSchedule(sched);
            }));
            if (roleSvc.isApprover()) {
                unsubs.push(await dataSvc.subscribeOperationLogs(() => renderLogsTab()));
            }

            // 首次塞 cache（onSnapshot 首次觸發前）— 讓即刻的衝堂檢查可用
            _v2RecordsCache = await dataSvc.listSubstituteRecords();
            _v2PendingCache = await dataSvc.listPendingRequests();
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
