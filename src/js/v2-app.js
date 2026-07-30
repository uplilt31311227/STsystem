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
import * as cloudSyncSvc from './modules/cloudSyncService.js';
import { notify, notifyError, setSyncStatus } from './modules/v2/uiFeedback.js';

/* ===== 樣式注入 ===== */

function injectV2Styles() {
    if (document.getElementById('v2-styles')) return;
    const style = document.createElement('style');
    style.id = 'v2-styles';
    style.textContent = `
    .v2-only { display: none; }
    body.v2-active .v2-only { display: revert; }

    /* .v1-only：純 V1 單機才顯示（教師管理頁的 V1 教師屬性表）。V2 模式下由
       #v2-teachers-admin 的合併表取代，隱藏以免同頁出現兩張欄位重疊的教師表。
       base.css 有靜態版本兜底，兩份內容須保持一致。 */
    body.v2-active .v1-only { display: none; }

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

    /* V2 模式下隱藏原本地「調代課紀錄」表格與查詢，避免與 V2 全校紀錄混淆。
       R1 修復（Stage 2）：改用純 id 選擇器，不依賴 #records-tab 的子代組合子——
       records-tab 內部 DOM 結構調整時，這條隱私邊界規則不會意外失效。
       Stage 3（CSS 重寫）：其餘視覺規則（badge/role-tag/pending-item/log-table/
       auth-gate/modal 等 ~150 行）已全數搬到 src/css/components.css 與 features.css
       並 token 化，此處只留角色顯隱與這條隱私邊界規則（雙保險之注入版，base.css 有
       靜態版本兜底，兩者內容須保持一致）。 */
    body.v2-active #records-no-data,
    body.v2-active #records-content { display: none !important; }
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
                <button id="v2-gate-google" class="btn btn-google">
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    使用 Google 登入
                </button>
                <button id="v2-gate-email" class="btn btn-ghost btn-sm">使用 Email / 密碼登入</button>
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
        <div class="list-item list-item-${cls}" data-id="${r.reqId}">
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
            const note = await promptRejectReason();
            if (note === null) return;   // 取消：中止拒絕動作（留空但按「確定」仍會繼續執行）
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
            const ok = await window.app?.confirmDialog?.({
                title: '撤回請求', message: '確定撤回此調課請求？', confirmText: '撤回', danger: true,
            });
            if (!ok) return;
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

/* ===== 教師管理合併表的即時自動儲存輔助 ===== */

/** 取得 V1 dataManager 中該姓名教師的索引；找不到回傳 -1。 */
function legacyTeacherIndex(name) {
    const list = window.app?.dataManager?.getTeachers?.() || [];
    return list.findIndex(t => t.name === name);
}

/**
 * 把教師的「課表屬性」（任教領域／導師班級）寫入 V1 dataManager。
 *
 * 這兩個欄位的權威來源是 V1 dataManager——recommendationEngine 讀 `teacher.domains` 與
 * `teacher.homeroomClass` 來做代課推薦（同領域／該班導師加權），而 V2 teachers 集合內的
 * 同名欄位從未被任何邏輯讀取，只是 CSV 匯入時寫入、供顯示的副本。因此合併表兩邊都寫：
 * V1 供功能實際使用，V2 副本保持一致，避免主任日後在兩處看到互相矛盾的值。
 *
 * dataManager.updateTeacher 已由 patchDataManager() 包裝，寫入後會自動回寫全校課表 doc
 * （靜默模式，不跳課表同步 toast——欄位本身已有 ✓ 回饋）。
 *
 * @returns {boolean} 是否有找到對應的 V1 教師並完成寫入
 */
function saveLegacyTeacherAttr(name, field, value) {
    const dm = window.app?.dataManager;
    if (!dm) return false;
    const idx = legacyTeacherIndex(name);
    if (idx === -1) return false;
    dm.updateTeacher(idx, field, value);
    try { window.app?.saveDataToStorage?.(); }
    catch (e) { console.warn('[V2] 教師屬性本機儲存失敗:', e); }
    return true;
}

/**
 * saveLegacyTeacherAttr 找不到 V1 對應教師時的提示。
 *
 * 發生時機：教師只存在於 V2 名單、還沒進入課表（典型情況是主任剛用 CSV 匯入全校名單、
 * 但當學期課表還沒上傳）。此時領域／導師班級只寫進了 V2 副本，而代課推薦讀的是 V1 側，
 * 設定要等課表匯入後才真正生效——不講清楚會讓主任誤以為推薦已經會參考這個領域。
 */
function warnIfNotInSchedule(savedToLegacy, name) {
    if (savedToLegacy) return;
    notify(`「${name}」尚未出現在課表中，此設定要等課表匯入後才會套用到代課推薦`, 'warning', 5000);
}

/**
 * 刪除教師時清理 V1 側資料：移除教師屬性、清掉他在課表中的所有課程、重算班級清單。
 * 等同 app.js editorDeleteTeacher() 的資料處理部分（該函式綁定課表編輯器的當前教師，
 * 無法直接重用），差別是確認對話框與 V2 帳號刪除由呼叫端負責。
 * setScheduleData 已由 patchDataManager() 包裝，會回寫全校課表 doc。
 *
 * ⚠ 呼叫端必須先確認「V2 集合中已無其他同名教師檔」才可呼叫本函式，見 delete handler。
 * V1 側是以姓名為鍵（dataManager.teachers 沒有 teacherId 概念），無法區分同名的兩筆帳號檔；
 * 若同名帳號還有其他筆存在就清 V1，會把仍在使用中的那筆帳號的課表課程一起刪掉。
 */
function deleteLegacyTeacher(name) {
    const dm = window.app?.dataManager;
    if (!dm || !name) return;
    const idx = legacyTeacherIndex(name);
    // 先刪課程再刪教師：setScheduleData 觸發的全校回寫會連帶帶上最新的 teachers 快照
    const sched = dm.getScheduleData?.() || [];
    if (Array.isArray(sched) && sched.some(c => c.teacher === name)) {
        dm.setScheduleData(sched.filter(c => c.teacher !== name));
    }
    if (idx !== -1) dm.removeTeacher(idx);
    dm.refreshClasses?.();
    try { window.app?.saveDataToStorage?.(); }
    catch (e) { console.warn('[V2] 刪除教師後本機儲存失敗:', e); }
    // 教師清單變動 → 更新各頁下拉與課表狀態（V1 教師屬性表在 V2 下已隱藏，但下拉仍在用）
    try {
        window.app?.populateTeacherDropdowns?.();
        window.app?.populateEditorTeacherDropdown?.();
        window.app?.updateScheduleStatusFromData?.();
    } catch (e) { console.warn('[V2] 刪除教師後 UI 刷新失敗:', e); }
}

/**
 * 欄位級即時自動儲存包裝：change 事件觸發，成功閃示 ✓、失敗還原原值並提示。
 *
 * 刻意「不重繪整張表」——原本的「儲存」按鈕成功後會 await renderTeachersAdminTab()
 * 重繪，但改成每格 change 即存後，重繪會在使用者連續編輯途中把焦點與捲動位置清掉。
 * 因此改為局部更新受影響的顯示元素（角色標籤、待指派 email 徽章、列的醒目狀態）。
 */
function bindAutoSaveField(el, buildTask, onSuccess) {
    // 失敗時要還原成「上一次成功儲存的值」而非 render 當時的初始值：使用者連續改兩次、
    // 第一次成功第二次失敗時，還原到初始值會把已經存進去的第一次變更也一起抹掉，
    // 畫面與後端就此不一致。故每次成功後更新 lastSaved。
    let lastSaved = el.value;
    el.addEventListener('change', async () => {
        el.classList.remove('v2-field-error');
        el.classList.add('v2-field-saving');
        try {
            await buildTask();
            const prevSaved = lastSaved;
            lastSaved = el.value;
            el.classList.remove('v2-field-saving');
            el.classList.add('v2-field-saved');
            setTimeout(() => el.classList.remove('v2-field-saved'), 1400);
            onSuccess?.(prevSaved);
        } catch (e) {
            el.classList.remove('v2-field-saving');
            el.classList.add('v2-field-error');
            el.value = lastSaved;
            notifyError(e, '儲存教師資料');
        }
    });
}

/** 依表格現況重算表頭的「待指派 email」徽章（不重繪整表）。 */
function refreshMissingEmailBadge(host) {
    const badge = host.querySelector('#v2-missing-email-badge');
    if (!badge) return;
    const n = host.querySelectorAll('tr.v2-row-needs-email').length;
    badge.textContent = n > 0 ? `⚠ ${n} 位待指派 email` : '';
    badge.style.display = n > 0 ? '' : 'none';
}

async function renderTeachersAdminTab() {
    const host = document.getElementById('v2-teachers-admin');
    if (!host) return;
    // 教師管理合併表：本頁權限由原本的 director-only 放寬到 approver——組長仍需能編輯
    // 教師的課表屬性（領域／導師班級，原本在 V1 教師屬性表，該表已於 V2 模式隱藏），
    // Email／角色兩欄與新增／刪除／匯入等名單操作則在欄位層級鎖給 director。
    if (!roleSvc.canEditSchedule()) {
        host.innerHTML = '<p>僅教務主任與教學組長可存取此頁籤。</p>';
        return;
    }
    const canRoster = roleSvc.canManageRoster();

    const _gen = _v2IdentityGen;
    host.innerHTML = '<p>載入中…</p>';
    const teachers = await teacherMgr.listAllTeachers();
    // 偵測舊資料失敗不可拖垮整頁：這支會對 users/{uid} 發 getDoc，離線 / token 過期 /
    // unavailable 都會 reject，若讓它往外拋，renderTeachersAdminTab 整支中止，
    // 畫面會永久停在上面那句「載入中…」（且是 unhandled rejection）。降級為「沒有舊資料」。
    // 只有 director 看得到遷移卡（遷移是主任的作業），組長不必發這個查詢。
    const legacyInfo = canRoster
        ? await legacyMigration.detectLegacyData().catch(err => {
            console.warn('[v2] 偵測 V1 舊資料失敗（不影響教師管理頁）：', err?.message || err);
            return { source: null, count: 0, lastModified: null, sources: [] };
        })
        : { source: null, count: 0, lastModified: null, sources: [] };
    const roleLabel = (role) => {
        const r = (role === 'admin') ? 'director' : role;
        return { director: '主任', section_chief: '組長', teacher: '教師' }[r] || '教師';
    };
    const missingEmailCount = teachers.filter(t => !t.email).length;

    // 課表屬性欄位所需的班級清單（導師班級下拉）與「只存在於課表、尚未進名單」的教師偵測。
    // 後者用意：合併表的列來源是 V2 teachers 集合，若某位教師只在 V1 課表裡（自動同步失敗、
    // 或 approver 手動加過），合併後這張表就看不到他——必須顯式提示，不能靜默遺漏。
    const dm             = window.app?.dataManager;
    const classList      = dm?.getClasses?.() || [];
    const v2Names        = new Set(teachers.map(t => t.name));
    const scheduleOnly   = (dm?.getTeachers?.() || [])
        .map(t => t?.name)
        .filter(n => n && !v2Names.has(n));

    // 同名重複的帳號檔偵測。手動新增已於 teacherMgr.createTeacher 防重，但
    // authGuardV2.ensureDirectorTeacher() 仍可能產生一筆：它只依 email 查既有教師檔，
    // 而課表匯入的教師檔 email 是 null，初始主任首次登入時查不到自己那筆就會另建一筆
    // （production 的「藍奕麟」即如此，兩筆的 authProvider 一為 google.com、一為空）。
    // 改用姓名補綁 email 會被 firestore.rules 的 isInitialDirector 分支擋下
    // （該分支要求 resource.data.email == userEmail()，而目標那筆是 null），修它得動 rules。
    // 在此之前至少讓重複無法被忽略：明確列出，主任可用刪除鈕清掉多餘那筆。
    const nameCount = new Map();
    teachers.forEach(t => nameCount.set(t.name, (nameCount.get(t.name) || 0) + 1));
    const duplicatedNames = [...nameCount.entries()].filter(([, n]) => n > 1).map(([n]) => n);

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填教師名單
    host.innerHTML = `
        ${canRoster && legacyInfo.source ? renderLegacyMigrationCard(legacyInfo) : ''}
        <div class="v2-section-header">
            <h3>
                教師管理
                <span class="v2-badge" id="v2-missing-email-badge"
                      title="尚有教師未指派 email，無法登入"
                      style="${missingEmailCount > 0 ? '' : 'display:none;'}"
                >${missingEmailCount > 0 ? `⚠ ${missingEmailCount} 位待指派 email` : ''}</span>
            </h3>
            ${canRoster ? `
            <div>
                <button class="btn btn-secondary btn-sm" id="v2-import-legacy-teachers">從課表匯入教師</button>
                <button class="btn btn-secondary btn-sm" id="v2-import-roster-csv">📥 批次匯入 CSV</button>
                <input type="file" id="v2-roster-csv-input" accept=".csv" style="display:none;">
                <button class="btn btn-primary btn-sm" id="v2-add-teacher">新增教師</button>
            </div>` : ''}
        </div>
        <p class="hint">變更即時自動儲存。姓名以課表為準，如需更名請重新匯入課表${canRoster ? '' : '。Email 與角色僅教務主任可修改'}。</p>
        ${scheduleOnly.length ? `
        <p class="hint v2-hint-warning">
            ⚠ 有 ${scheduleOnly.length} 位教師出現在課表中但尚未加入名單（${escapeHtml(scheduleOnly.slice(0, 5).join('、'))}${scheduleOnly.length > 5 ? ' 等' : ''}），
            ${canRoster ? '請按上方「從課表匯入教師」補入，否則他們無法登入。' : '請通知教務主任由「從課表匯入教師」補入。'}
        </p>` : ''}
        ${duplicatedNames.length ? `
        <p class="hint v2-hint-warning">
            ⚠ 有 ${duplicatedNames.length} 位教師存在重複的帳號檔（${escapeHtml(duplicatedNames.join('、'))}）。
            重複檔會讓登入時綁到哪一筆變得不確定，${canRoster
                ? '請保留有登入紀錄的那筆（操作欄顯示「🔒 Google 登入」或「📧 重設密碼」者），刪除另一筆。'
                : '請通知教務主任清理。'}
        </p>` : ''}
        <div class="table-wrap">
        <table class="data-table data-table-compact data-table-cards">
            <thead><tr>
                <th>姓名</th><th>Email（登入帳號）</th><th>角色</th>
                <th>任教領域</th><th>導師班級</th>${canRoster ? '<th>操作</th>' : ''}
            </tr></thead>
            <tbody>
            ${teachers.map(t => {
                const normRole = (t.role === 'admin') ? 'director' : (t.role || 'teacher');
                const rowClass = t.email ? 'v2-teacher-row' : 'v2-teacher-row v2-row-needs-email';
                // 教師的導師班級可能不在目前課表的班級清單內（換學期、課表尚未重新匯入），
                // 若不補進選項，select 會落回第一項「非導師」而讓使用者以為資料被清掉。
                const homeroom = t.homeroomClass || '';
                const options  = homeroom && !classList.includes(homeroom)
                    ? [homeroom, ...classList]
                    : classList;
                const lockAttr = canRoster ? '' : 'disabled title="僅教務主任可修改"';
                return `
                <tr class="${rowClass}" data-id="${t.teacherId}" data-name="${escapeHtml(t.name)}">
                    <td data-label="姓名" class="cell-primary">${escapeHtml(t.name)}</td>
                    <td data-label="Email（登入帳號）">
                        <input type="email" class="v2-email-input" value="${escapeHtml(t.email || '')}"
                               placeholder="未指派" ${lockAttr}>
                    </td>
                    <td data-label="角色">
                        <select class="v2-role-select" ${lockAttr}>
                            <option value="teacher"       ${normRole === 'teacher' ? 'selected' : ''}>教師</option>
                            <option value="section_chief" ${normRole === 'section_chief' ? 'selected' : ''}>組長</option>
                            <option value="director"      ${normRole === 'director' ? 'selected' : ''}>主任</option>
                        </select>
                        <span class="v2-role-tag ${normRole}" style="margin-left:6px;">${roleLabel(t.role)}</span>
                    </td>
                    <td data-label="任教領域">
                        <input type="text" class="v2-domains-input" value="${escapeHtml((t.domains || []).join(', '))}"
                               placeholder="例如：國文, 英語" title="多個領域請用逗號分隔，例如：國文, 英語">
                    </td>
                    <td data-label="導師班級">
                        <select class="v2-homeroom-select">
                            <option value="">非導師</option>
                            ${options.map(c =>
                                `<option value="${escapeHtml(c)}" ${homeroom === c ? 'selected' : ''}>${escapeHtml(c)}</option>`
                            ).join('')}
                        </select>
                    </td>
                    ${canRoster ? `
                    <td class="cell-actions">
                        ${renderTeacherAuthAction(t)}
                        <button class="btn btn-danger btn-sm v2-delete-teacher">刪除</button>
                    </td>` : ''}
                </tr>`;
            }).join('')}
            </tbody>
        </table>
        </div>
    `;

    /* ---- Email：change 即存。成功後同步更新列的「待指派」醒目狀態與表頭徽章 ---- */
    host.querySelectorAll('.v2-email-input').forEach(input => {
        const tr = input.closest('tr');
        bindAutoSaveField(
            input,
            () => teacherMgr.assignEmail(tr.dataset.id, input.value.trim() || null),
            (prev) => {
                const val = input.value.trim();
                tr.classList.toggle('v2-row-needs-email', !val);
                refreshMissingEmailBadge(host);
                // 有／無 email 決定操作欄是否出現密碼信按鈕，狀態翻轉才需要重繪整表
                if (!!val !== !!prev.trim()) {
                    renderTeachersAdminTab().catch(e =>
                        console.warn('[V2] 教師管理表重繪失敗:', e));
                }
            });
    });

    /* ---- 角色：change 即存，成功後就地更新角色標籤 ---- */
    host.querySelectorAll('.v2-role-select').forEach(sel => {
        const tr = sel.closest('tr');
        bindAutoSaveField(
            sel,
            () => teacherMgr.setRole(tr.dataset.id, sel.value),
            () => {
                const tag = tr.querySelector('.v2-role-tag');
                if (tag) {
                    tag.className = `v2-role-tag ${sel.value}`;
                    tag.textContent = roleLabel(sel.value);
                }
            });
    });

    /* ---- 任教領域：change 即存。權威為 V1 dataManager，V2 集合寫一份副本 ---- */
    host.querySelectorAll('.v2-domains-input').forEach(input => {
        const tr = input.closest('tr');
        bindAutoSaveField(input, async () => {
            const list = input.value.split(/[、;,，]/).map(s => s.trim()).filter(Boolean);
            const inLegacy = saveLegacyTeacherAttr(tr.dataset.name, 'domains', list);
            await dataSvc.updateTeacher(tr.dataset.id, { domains: list });
            warnIfNotInSchedule(inLegacy, tr.dataset.name);
        });
    });

    /* ---- 導師班級：change 即存，同上兩處寫入 ---- */
    host.querySelectorAll('.v2-homeroom-select').forEach(sel => {
        const tr = sel.closest('tr');
        bindAutoSaveField(sel, async () => {
            const inLegacy = saveLegacyTeacherAttr(tr.dataset.name, 'homeroomClass', sel.value);
            await dataSvc.updateTeacher(tr.dataset.id, { homeroomClass: sel.value });
            warnIfNotInSchedule(inLegacy, tr.dataset.name);
        });
    });

    host.querySelectorAll('.v2-delete-teacher').forEach(btn =>
        btn.addEventListener('click', async () => {
            const tr   = btn.closest('tr');
            const id   = tr.dataset.id;
            const name = tr.dataset.name;
            // 合併表是教師刪除的唯一入口，因此採「完整刪除」語意：帳號 + 課表屬性 + 該教師的
            // 課程。原先 V2 表只刪 Firestore 帳號、V1 表只刪教師屬性，兩者都會留下孤兒資料
            // （課表裡仍有指向已刪教師的課程），見 docs/ISSUES_LOG.md 2026-07-29 條目。
            //
            // 例外：同名帳號檔還有其他筆時只刪這一筆帳號、不動 V1。V1 側以姓名為鍵、
            // 分不出是哪一筆帳號的資料，此時清 V1 會把仍在使用中的那筆的課程一起刪掉
            // （production 的「藍奕麟」就有兩筆 bootstrap 競態產生的同名檔）。
            const sameName  = [...host.querySelectorAll('tbody tr')]
                .filter(r => r.dataset.name === name && r.dataset.id !== id).length;
            const cascade   = sameName === 0;
            const hours     = cascade
                ? (window.app?.dataManager?.getTeacherWeeklyHours?.(name) || 0)
                : 0;
            const ok = await window.app?.confirmDialog?.({
                title: '刪除教師',
                message: !cascade
                    ? `「${name}」還有 ${sameName} 筆同名帳號檔，將只刪除這一筆帳號，課表屬性與課程保留給另一筆。此操作會寫入 log。`
                    : hours > 0
                        ? `確定刪除教師「${name}」？將一併移除其帳號、教師屬性與課表中的 ${hours} 節課。此操作會寫入 log。`
                        : `確定刪除教師「${name}」？將一併移除其帳號與教師屬性。此操作會寫入 log。`,
                confirmText: '刪除', danger: true,
            });
            if (!ok) return;
            try {
                await teacherMgr.deleteTeacher(id);
                if (cascade) {
                    deleteLegacyTeacher(name);
                } else {
                    notify(`已刪除「${name}」的重複帳號檔，課表資料保留給另一筆`, 'success');
                }
                await renderTeachersAdminTab();
            }
            catch (e) { notifyError(e, '刪除教師'); }
        }));

    host.querySelectorAll('.v2-send-reset').forEach(btn =>
        btn.addEventListener('click', async () => {
            const tr    = btn.closest('tr');
            const email = tr.querySelector('.v2-email-input').value.trim();
            if (!email) { notify('此教師尚未填 email，請先儲存 email 再試。', 'warning'); return; }
            const ok = await window.app?.confirmDialog?.({
                title: '寄送密碼設定信',
                message: `即將為 ${email} 建立 Auth 帳號（若不存在）並寄出密碼設定信。確認？`,
                confirmText: '確認寄送',
            });
            if (!ok) return;
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
        const dm2   = window.app?.dataManager;
        const sched = dm2?.getScheduleData?.() || [];

        // 前置閘門：沒有課表不得新增教師。
        // 課表是教師資料的根：V1 側（dataManager.teachers）是代課推薦與各頁下拉的來源，
        // 而它只會隨課表一起回寫全校（addTeacher 的 requireSchedule 守門）。課表未匯入時
        // 硬建教師檔，結果是「V2 有帳號、課表沒有這個人」的半套資料——而這種對不起來的
        // 狀態正是重複建檔的溫床（看不到人就再按一次新增）。依 docs/V2_GO_LIVE.md 的
        // 上線順序，課表本來就該先於名單。
        if (!Array.isArray(sched) || sched.length === 0) {
            notify('請先到「課表管理」匯入課表，再新增教師——課表是教師名單與代課推薦的資料來源', 'warning', 6000);
            return;
        }

        const info = await promptNewTeacherModal();
        if (!info) return;

        // 課表裡已有同名教師 → 該走「從課表匯入教師」補建帳號檔，不是手動新增
        // （手動新增會讓 V1 那筆既有的領域／導師班級資料與新帳號檔各自為政）。
        if (legacyTeacherIndex(info.name) !== -1) {
            notify(`「${info.name}」已存在於課表中，請按「從課表匯入教師」補建帳號檔`, 'warning', 6000);
            return;
        }

        let created = null;
        let legacyAdded = false;
        try {
            // createTeacher 內含姓名／email 防重，重複時直接拋錯不會建立
            created = await teacherMgr.createTeacher(info);

            // 同步建立 V1 側教師屬性，兩邊都成功才算成功：合併表的領域／導師班級欄位以
            // name 比對 V1 dataManager（saveLegacyTeacherAttr），缺這一步新增的教師改領域
            // 會找不到寫入目標，也不會進入代課推薦的候選名單。
            dm2.addTeacher({ name: info.name, domains: [], homeroomClass: '' });
            legacyAdded = legacyTeacherIndex(info.name) !== -1;
            if (!legacyAdded) throw new Error('課表側教師資料建立失敗');

            window.app?.saveDataToStorage?.();
            window.app?.populateTeacherDropdowns?.();
            window.app?.populateEditorTeacherDropdown?.();

            notify(`已新增教師「${info.name}」，請接著指派 Email 與任教領域`, 'success');
            await renderTeachersAdminTab();
        } catch (e) {
            // 回滾要對稱，兩邊都清：任一側殘留都會讓下次使用者看不到完整的人又再按一次
            // 新增，正是重複建檔的來源。
            if (legacyAdded) {
                const idx = legacyTeacherIndex(info.name);
                if (idx !== -1) dm2.removeTeacher(idx);
                try { window.app?.saveDataToStorage?.(); } catch { /* 已在錯誤路徑，不再擴散 */ }
            }
            if (created?.teacherId) {
                try {
                    await teacherMgr.deleteTeacher(created.teacherId);
                    console.warn('[V2] 新增教師失敗，已回滾帳號檔:', created.teacherId);
                } catch (rollbackErr) {
                    console.error('[V2] 帳號檔回滾失敗，名單可能留下孤兒:', rollbackErr);
                }
            }
            notifyError(e, '新增教師');
            await renderTeachersAdminTab();
        }
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
        <div class="card-warning" id="v2-legacy-card">
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
        backdrop.className = 'modal';
        backdrop.innerHTML = `
            <div class="modal-content" style="max-width:520px;">
                <div class="modal-body">
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
                ${!hasImportable ? '<p class="form-msg error" style="display:block;">沒有可匯入的資料，請修正 CSV 後重新上傳。</p>' : ''}
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="v2-roster-preview-cancel">取消</button>
                    <button class="btn btn-primary" id="v2-roster-preview-confirm" ${hasImportable ? '' : 'disabled'}>確認匯入</button>
                </div>
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
        <table class="data-table data-table-compact v2-log-table data-table-cards">
            <thead><tr><th>時間</th><th>操作者</th><th>角色</th><th>動作</th><th>對象</th><th>詳情</th></tr></thead>
            <tbody>
            ${visible.map(l => `
                <tr>
                    <td data-label="時間">${fmtDate(l.timestamp)}</td>
                    <td data-label="操作者">${l.actor?.name || l.actor?.email || '—'}</td>
                    <td data-label="角色"><span class="v2-role-tag ${l.actor?.role || ''}">${l.actor?.role || '—'}</span></td>
                    <td data-label="動作">${l.action}</td>
                    <td data-label="對象">${l.targetType || ''}${l.targetId ? ' / ' + l.targetId.slice(-6) : ''}</td>
                    <td data-label="詳情"><code style="font-size:0.75rem;">${JSON.stringify(l.details).slice(0, 160)}</code></td>
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
        host.className = 'card';
        original.appendChild(host);
    }
    const _gen = _v2IdentityGen;
    const all       = await dataSvc.listSubstituteRecords();
    const visible   = roleSvc.filterRecordsForCurrent(all);
    const isApprover = roleSvc.isApprover();
    const APPROVER_ROLES_FOR_BADGE = ['admin', 'director', 'section_chief'];

    // Phase 5：legacy 篩選（全部／僅新／僅舊）純前端過濾，不影響 visible 本身（PDF/刪除仍可對到完整紀錄）。
    const legacyFiltered = _v2RecordsLegacyFilter === 'legacy' ? visible.filter(r => r.isLegacy)
        : _v2RecordsLegacyFilter === 'new' ? visible.filter(r => !r.isLegacy)
        : visible;

    // Stage 5（F1 方式補篩選）：教師 select 選項取自 visible 本身出現過的姓名（不另外打 listTeachers，
    // 維持本函式原本只讀一次 listSubstituteRecords 的資料存取範圍）。
    const teacherNames = Array.from(new Set(
        visible.flatMap(r => [r.originalTeacher, r.substituteTeacher, r.swapTeacher]).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, 'zh-TW'));

    // 起訖日／教師純前端過濾，只作用在「已過濾過權限的 visible 集合」之上。
    const displayed = legacyFiltered
        .filter(r => !_v2RecordsFilterStart || (r.date || '') >= _v2RecordsFilterStart)
        .filter(r => !_v2RecordsFilterEnd || (r.date || '') <= _v2RecordsFilterEnd)
        .filter(r => !_v2RecordsFilterTeacher ||
            [r.originalTeacher, r.substituteTeacher, r.swapTeacher].includes(_v2RecordsFilterTeacher));

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
        <div class="toolbar-row">
            <div class="toolbar-controls">
                <div class="form-group form-group-inline">
                    <label for="v2-record-start-date">起始</label>
                    <input type="date" id="v2-record-start-date" value="${_v2RecordsFilterStart}">
                </div>
                <div class="form-group form-group-inline">
                    <label for="v2-record-end-date">結束</label>
                    <input type="date" id="v2-record-end-date" value="${_v2RecordsFilterEnd}">
                </div>
                <div class="form-group form-group-inline">
                    <label for="v2-record-teacher">教師</label>
                    <select id="v2-record-teacher">
                        <option value="">全部</option>
                        ${teacherNames.map(n => `<option value="${escapeHtml(n)}" ${n === _v2RecordsFilterTeacher ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
                    </select>
                </div>
                <button class="btn btn-secondary btn-sm v2-approver-only" id="v2-print-weekly-summary-btn" title="以週為單位彙整本週所有調代課，產生 1 份 PDF 精簡列印">📄 列印本週彙整</button>
            </div>
        </div>
        <div class="table-wrap">
        <table class="data-table data-table-compact data-table-cards">
            <thead><tr>
                <th>日期</th><th>節次</th><th>班級</th><th>原教師</th><th>代/調對象</th><th>類型</th><th>發起</th>
                <th>操作</th>
            </tr></thead>
            <tbody>
            ${displayed.map(r => `
                <tr data-id="${r.recordId}">
                    <td data-label="日期" class="cell-primary">${r.date || ''}</td>
                    <td data-label="節次">${r.period || ''}</td>
                    <td data-label="班級">${r.className || ''}</td>
                    <td data-label="原教師">${r.originalTeacher || ''}</td>
                    <td data-label="代/調對象">${r.substituteTeacher || r.swapTeacher || ''}</td>
                    <td data-label="類型">${r.type || ''}${APPROVER_ROLES_FOR_BADGE.includes(r.initiatedByRole) ? ' <span class="v2-role-tag director">代發</span>' : ''}${r.isLegacy ? ' <span class="v2-legacy-badge" title="遷移自 V1 舊系統">舊系統</span>' : ''}</td>
                    <td data-label="發起">${r.initiatedByName || ''}</td>
                    <td class="cell-actions">
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

    document.getElementById('v2-record-start-date')?.addEventListener('change', (e) => {
        _v2RecordsFilterStart = e.target.value;
        renderRecordsTab();
    });
    document.getElementById('v2-record-end-date')?.addEventListener('change', (e) => {
        _v2RecordsFilterEnd = e.target.value;
        renderRecordsTab();
    });
    document.getElementById('v2-record-teacher')?.addEventListener('change', (e) => {
        _v2RecordsFilterTeacher = e.target.value;
        renderRecordsTab();
    });
    // 週彙整 modal 定義於 app.js（#weekly-summary-modal 已在 #modal-root，V2 下可正常顯示）
    document.getElementById('v2-print-weekly-summary-btn')?.addEventListener('click', () => {
        window.app?.openWeeklySummaryModal?.();
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
                const ok = await window.app?.confirmDialog?.({
                    title: '刪除紀錄', message: '確定刪除此紀錄？此操作會寫入 log。', confirmText: '刪除', danger: true,
                });
                if (!ok) return;
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

// Stage 5（F1 方式補篩選）：起訖日／教師純前端顯示過濾，跨 renderRecordsTab 重繪保留選擇。
// 只過濾「該函式內已過濾過權限的 visible 集合」，不動 dataSvc.listSubstituteRecords() 的資料層。
let _v2RecordsFilterStart   = '';
let _v2RecordsFilterEnd     = '';
let _v2RecordsFilterTeacher = '';

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
 * V2 啟用時，在「確認並產生表單」與「加入批次」（F3/R2：拆同鈕兩語意後新增的獨立送出鈕，
 * 兩者皆會走到 confirmSubstitute()）click 的 capture 階段擋下：
 *   - 非 admin 若「原任課教師」不是自己 → 阻止並提示
 *   - admin 放行（可代任一教師發起）
 * R2 致命｜權限繞過：新增任何送出鈕都必須同步加進這份清單，否則繞過權限閘門。
 */
function interceptSubmitButton() {
    ['confirm-substitute-btn', 'add-to-batch-btn'].forEach((btnId) => {
        const btn = document.getElementById(btnId);
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
    });
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
        // 專屬 id（Stage 3 驗收修正）：供 e2e 腳本精準指認，避免通用 .modal 選擇器
        // 誤中 #modal-root 內 5 個常駐（但預設 hidden）的靜態 modal。
        backdrop.id = 'v2-extra-consent-modal';
        backdrop.className = 'modal';
        backdrop.innerHTML = `
            <div class="modal-content" style="max-width:420px;">
                <div class="modal-body">
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
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="v2-extra-consent-skip">僅雙方調課</button>
                    <button class="btn btn-primary" id="v2-extra-consent-confirm">送出</button>
                </div>
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
 * Stage 5（殺 prompt()）：拒絕請求時的原因輸入，改為 textarea modal（原為 window.prompt()）。
 * 原因可留空（對方會看到），故區分「取消」與「確定但留空」兩種結果：
 *   - 取消／點背景：resolve(null) → 呼叫端應中止拒絕動作（跟舊版 prompt() 不同——
 *     舊版不論取消或確定留空都會以空字串繼續執行拒絕，這裡改為取消真的會取消）。
 *   - 確定（含留空）：resolve(該字串，可能是空字串)。
 * @returns {Promise<string|null>}
 */
function promptRejectReason() {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal';
        backdrop.innerHTML = `
            <div class="modal-content" style="max-width:420px;">
                <div class="modal-body">
                <h3>拒絕原因</h3>
                <div class="form-group">
                    <label for="v2-reject-reason-input">原因（可留空，對方會看到）</label>
                    <textarea id="v2-reject-reason-input" rows="3"></textarea>
                </div>
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="v2-reject-reason-cancel">取消</button>
                    <button class="btn btn-primary" id="v2-reject-reason-confirm">確定</button>
                </div>
                </div>
            </div>`;
        document.body.appendChild(backdrop);

        const textarea = backdrop.querySelector('#v2-reject-reason-input');
        textarea.focus();

        const cleanup = (result) => { backdrop.remove(); resolve(result); };
        backdrop.querySelector('#v2-reject-reason-cancel').addEventListener('click', () => cleanup(null));
        backdrop.querySelector('#v2-reject-reason-confirm').addEventListener('click', () => cleanup(textarea.value || ''));
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(null); });
    });
}

/**
 * Stage 5（殺 prompt()）：新增教師的姓名／Email 輸入，改為雙欄位 modal（原為兩次 window.prompt()）。
 * 姓名必填（沿用原本語意：留空視同取消，不建立教師）；Email 選填，留空回傳 null。
 * @returns {Promise<{name: string, email: string|null}|null>} 取消或姓名留空時回傳 null
 */
function promptNewTeacherModal() {
    return new Promise((resolve) => {
        const backdrop = document.createElement('div');
        backdrop.className = 'modal';
        backdrop.innerHTML = `
            <div class="modal-content" style="max-width:420px;">
                <div class="modal-body">
                <h3>新增教師</h3>
                <div class="form-group">
                    <label for="v2-new-teacher-name">教師姓名 <span style="color:red;">*</span></label>
                    <input type="text" id="v2-new-teacher-name">
                </div>
                <div class="form-group">
                    <label for="v2-new-teacher-email">Email（可留空）</label>
                    <input type="email" id="v2-new-teacher-email">
                </div>
                <p class="form-msg" id="v2-new-teacher-msg" style="display:none;"></p>
                <div class="modal-actions">
                    <button class="btn btn-secondary" id="v2-new-teacher-cancel">取消</button>
                    <button class="btn btn-primary" id="v2-new-teacher-confirm">確定</button>
                </div>
                </div>
            </div>`;
        document.body.appendChild(backdrop);

        const nameInput  = backdrop.querySelector('#v2-new-teacher-name');
        const emailInput = backdrop.querySelector('#v2-new-teacher-email');
        const msgEl      = backdrop.querySelector('#v2-new-teacher-msg');
        nameInput.focus();

        const cleanup = (result) => { backdrop.remove(); resolve(result); };
        backdrop.querySelector('#v2-new-teacher-cancel').addEventListener('click', () => cleanup(null));
        backdrop.querySelector('#v2-new-teacher-confirm').addEventListener('click', () => {
            const name = nameInput.value.trim();
            if (!name) {
                msgEl.textContent = '請輸入教師姓名';
                msgEl.style.display = 'block';
                nameInput.focus();
                return;
            }
            cleanup({ name, email: emailInput.value.trim() || null });
        });
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(null); });
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
 *
 * @param {{silent?: boolean}} [opts] silent=true 時不跳「全校課表已更新」toast。教師管理頁的
 *   領域／導師班級欄位是「每格 change 即存」，每次都跳這顆 toast 會在連續編輯時洗版；
 *   該處欄位本身已有 ✓ 的即時回饋，故靜默。錯誤仍照常提示，不因 silent 而吞掉。
 */
async function syncScheduleToV2(opts = {}) {
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
                // meta 形狀統一為 { lastAction, byName, byTeacherId, at }，與 clearAllSchoolData()
                // 的寫入對齊（驗收缺陷 #8）：兩者都用 setDoc 整份覆寫同一份 schedule doc，過去
                // 一邊寫 uploadedBy*、一邊寫 clearedBy*，欄位名稱不同會互相抹除、也無法從單一
                // 欄位判斷「這份課表最後一次是被上傳還是被清除」。
                meta: {
                    lastAction:  'uploaded',
                    byName:      me?.name || '',
                    byTeacherId: me?.teacherId || null,
                    at:          new Date().toISOString(),
                },
            });
            await logger.log(LOG_ACTIONS.SCHEDULE_IMPORT, LOG_TARGET_TYPES.SCHEDULE, null, {
                entries: scheduleData.length,
            });
        } while (_v2ScheduleSyncPending);
        if (!opts.silent) {
            window.app?.showToast?.('✅ 全校課表已更新，所有教師即時同步', 'success', 3500);
        }
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
    const queueScheduleSync = (opts = {}) => {
        if (!roleSvc.isApprover()) return;   // 教師無寫入權（rules 亦擋），不回寫
        queueMicrotask(() => { syncScheduleToV2(opts); });
    };
    const wrapScheduleMutator = (name, { requireSchedule = false, silent = false } = {}) => {
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
            queueScheduleSync({ silent });
            return r;
        };
    };
    ['setScheduleData', 'addScheduleEntry', 'updateScheduleEntry', 'removeScheduleEntry']
        .forEach(n => wrapScheduleMutator(n));
    // setSchoolName 與上述四者同形（單一參數、同步賦值、無回傳值），可共用包裝，
    // 但必須加 requireSchedule 守門，理由見上方註解。
    wrapScheduleMutator('setSchoolName', { requireSchedule: true });
    // 教師屬性的異動（教師管理頁改領域／導師班級、新增或刪除教師）同樣要回寫全校 schedule
    // doc——這三個方法過去沒被包裝，導致 approver 在教師屬性表改的領域只存在自己的
    // localStorage，全校教師拿到的 teachers 快照永遠是課表匯入當時的版本，代課推薦因此用
    // 錯領域（既有缺陷，非本次合併引入）。requireSchedule 守門理由同 setSchoolName：
    // 課表尚未匯入時（app.js addNewTeacherRow 允許此情境）不可用空課表覆蓋全校資料。
    // silent：這些是逐格即時儲存的觸發點，不跳課表同步 toast，見 syncScheduleToV2 註解。
    ['updateTeacher', 'addTeacher', 'removeTeacher']
        .forEach(n => wrapScheduleMutator(n, { requireSchedule: true, silent: true }));
}

/**
 * 「清除所有資料」的雲端清除本體。清除範圍＝全校營運資料（課表、已成立調代課紀錄、待審
 * 請求，含各自的 private/detail 子文件）＋目前登入使用者自己的 V1 個人雲端備份。
 * 刻意保留：teachers/{id} 帳號檔、userMappings、config、operationLogs——這些是帳號與權限
 * 設定，清掉會讓全校被鎖在系統外面；操作日誌則留作稽核軌跡。
 * 課表歸零走 dataSvc.saveSchedule()（既有合法寫入路徑，setDoc 整份覆寫），不呼叫
 * dataManager.setScheduleData：後者會被 patchDataManager 的 wrapScheduleMutator 攔截，
 * 以 queueMicrotask 非同步觸發 syncScheduleToV2()，時序上可能把「本機尚未清空」的舊快照
 * 又寫回全校 schedule doc，與這裡的清除互相競態。
 * 任何一步失敗都直接讓例外往外拋，中止後續步驟——呼叫端 patchClearLocalData 會在失敗時
 * 強制 reload 讓本機與雲端當下實際狀態重新對齊（見該處註解），這裡不需要、也不應該自行
 * catch 吞掉錯誤。
 */
async function clearAllSchoolData() {
    // 1) 全校課表歸零。schoolName 沿用雲端現值（歸零不等於學校改名／需要重新設定）。
    //    getSchedule() 讀取失敗（網路瞬斷、權限問題等）刻意不 catch：此時尚未寫入任何東西，
    //    直接中止最安全；若吞成 null 會把讀取失敗誤判為「雲端本來就沒有課表」，用空字串
    //    覆蓋掉雲端現有 schoolName，讓一般教師端卡在「請先設定學校名稱」（驗收缺陷 #3）。
    const cloudSchedule = await dataSvc.getSchedule();
    const me = roleSvc.getCurrentIdentity();
    await dataSvc.saveSchedule({
        scheduleData:     [],
        teachers:         [],
        classes:          [],
        subjectDomainMap: {},
        schoolName:       cloudSchedule?.schoolName || '',
        // meta 形狀統一為 { lastAction, byName, byTeacherId, at }，見 syncScheduleToV2() 同處註解
        // （驗收缺陷 #8）。
        meta: {
            lastAction:  'cleared',
            byName:      me?.name || '',
            byTeacherId: me?.teacherId || null,
            at:          new Date().toISOString(),
        },
    });

    // 2) 刪除全部已成立調代課紀錄：先用不帶 orderBy 的清除專用列表函式讀出全部（驗收缺陷
    //    #4：orderBy('createdAt') 會排除缺該欄位的舊文件，清除必須刪光每一筆），再用
    //    writeBatch 分塊循序刪除各自的 private/detail 子文件與母文件（驗收缺陷 #7：
    //    取代原本無上限的 Promise.all 併發寫入）。
    const records = await dataSvc.listAllSubstituteRecordsForClear();
    await dataSvc.deleteSubstituteRecordsBatch(records.map(r => r.recordId));

    // 3) 刪除全部待審請求，同上。
    const pendings = await dataSvc.listAllPendingRequestsForClear();
    await dataSvc.deletePendingRequestsBatch(pendings.map(p => p.reqId));

    // 4) 刪除自己（目前登入 uid）的 V1 個人雲端備份（users/{uid}/data/substituteSystem）。
    //    使用者原始抱怨「無法正確清除帳號內資料」指的正是這份文件——它獨立於 V2 全校資料，
    //    換一台裝置或換網址回到舊版頁面就會整包復活（驗收缺陷 #5）。firestore.rules 對
    //    users/{uid} 的規則放行本人 delete，故直接刪除而非退而求其次改覆寫成空物件。
    //    只刪「自己」的：rules 本來就無法刪到其他使用者的 uid（uid 不符會被拒），不需要在
    //    這裡額外過濾；一併在第一層 confirm modal 文案註明「其他使用者的個人備份不受影響」。
    await cloudSyncSvc.deletePersonalCloudBackup();
}

// 「清除所有資料」重入保護：進行中若再次觸發（連點按鈕、或按鈕在確認對話框開著時仍可被
// console 呼叫），直接忽略。理由見 patchClearLocalData 內用法——這是唯一一份雲端全校資料，
// 兩個併發執行緒同時刪除／批次寫入沒有任何好處，只會放大競態風險（驗收缺陷 #7）。
let _v2ClearAllDataInFlight = false;

/**
 * 接手 app.js 的 clearLocalData()：V2 全校共享模式下，原本只清 2 個 localStorage key
 * 就 reload 完全無效——Firebase 登入 session 還在，reload 後 subscribeSchedule 等訂閱
 * 會立刻把 Firestore 全校資料灌回本機。改為：先清全校雲端資料（見 clearAllSchoolData），
 * 確認清除完成才清本機 + reload；reload 後訂閱抓到的是已清空的 schedule doc，資料不會回流。
 * 對齊本檔既有覆寫慣例（例如 bootstrap 內對 window.app.canSwitchToTab 的接手）。
 */
function patchClearLocalData() {
    if (!window.app || typeof window.app.clearLocalData !== 'function') return;
    if (window.app.__v2_clearLocalDataPatched) return;
    window.app.__v2_clearLocalDataPatched = true;

    window.app.clearLocalData = async function () {
        // 權限防禦：UI 上此按鈕僅 director 看得到（.v2-director-only），但仍在執行前重新
        // 檢查，避免透過 console 直接呼叫繞過 UI 限制。用 isDirector() 而非 isApprover()：
        // firestore.rules 對 substituteRecords（含 private/detail）的 delete 僅放行 director，
        // 若這裡放行 section_chief，會在雲端清除跑到一半時才被規則擋下，留下「課表已清空、
        // 紀錄卻只清了一部分」的更糟糕的殘破狀態——寧可在送出前就整批擋下。
        if (!roleSvc.isSignedIn() || !roleSvc.isDirector()) {
            this.showToast?.('僅教務主任可執行「清除所有資料」', 'error');
            return;
        }

        // 重入保護（驗收缺陷 #7）：進行中再點一次直接忽略，不重複觸發整套雲端清除流程。
        if (_v2ClearAllDataInFlight) return;

        const firstOk = await this.confirmDialog({
            title: '清除所有資料',
            message:
                '將清除全校雲端資料：課表、調代課紀錄、待審請求。\n\n' +
                '教師帳號與權限設定會保留，不受影響。\n\n' +
                '你個人的 V1 雲端備份也會一併刪除；其他使用者的個人備份不受影響。\n\n' +
                '此操作影響全校所有使用者，且無法復原！\n\n' +
                '建議先使用「匯出完整備份」進行備份。',
            confirmText: '繼續',
            danger: true,
        });
        if (!firstOk) return;

        const secondOk = await this.confirmDialog({
            title: '再次確認',
            message: '再次確認：清除全校課表、調代課紀錄與待審請求？此操作無法復原。',
            confirmText: '清除所有資料',
            danger: true,
        });
        if (!secondOk) return;

        // 兩個 confirm 都是 await，期間使用者仍可能連點按鈕或另開 console 呼叫，
        // 故重入旗標的設置點放在「確定要執行」之後、真正動手之前，且要在 try 前設。
        // 解除時機見下方 catch／成功路徑各自的說明（刻意不用 finally）。
        if (_v2ClearAllDataInFlight) return;
        _v2ClearAllDataInFlight = true;

        // 捕捉 dismiss handle：清除完成（無論成功或失敗）要立刻讓這顆「清除中」toast 讓位給
        // 結果 toast，不能放著讓它疊滿 60 秒（驗收缺陷 #6，showToast 是 append 疊加、非取代）。
        const dismissClearingToast = this.showToast?.('清除中，請稍候…', 'warning', 60000);
        try {
            await clearAllSchoolData();
        } catch (err) {
            console.error('[V2] 清除所有資料失敗:', err);
            dismissClearingToast?.();
            // 失敗（含部分成功）路徑選擇「強制 reload」而非手動清 dataManager 欄位（驗收缺陷
            // #1，二擇一：這裡選 reload）。理由：
            //   - 雲端可能已清到一半（例如課表已歸零，但紀錄／待審請求還沒刪完），此時本機
            //     dataManager 仍持有舊快照；若不處理，approver 之後任何課表／教師屬性異動都會
            //     經 queueScheduleSync → syncScheduleToV2 把本機這份舊快照整份 setDoc 回雲端，
            //     等於把已清除的課表悄悄還原。
            //   - reload 後 subscribeSchedule / subscribeSubstituteRecords / subscribePendingRequests
            //     等訂閱會重新讀「雲端當下實際狀態」灌回本機，本機與雲端自然一致，不需要在這裡
            //     逐一列舉、手動清空 dataManager 的每個欄位（漏清、清得不夠乾淨的風險更低）。
            //   - 全站已於 UI 重規劃 Stage 5 統一操作邏輯為 confirm modal、不使用原生對話框
            //     （原生 dialog 會卡死瀏覽器自動化），故用 this.confirmDialog() 取代 alert()：
            //     它是 await 的 Promise，一樣會擋住後續程式碼直到使用者關閉，確保錯誤內容與
            //     後續動作建議在畫面重新整理前一定看得到；不論按確認或取消/點背景關閉，
            //     結果都不影響——都要 reload 讓本機與雲端當下實際狀態重新對齊，故不判斷回傳值。
            await this.confirmDialog({
                title: '清除未完全成功',
                message:
                    `頁面即將重新整理以同步目前雲端實際狀態：\n${err?.message || err}\n\n` +
                    '請確認畫面狀態後，可再次執行「清除所有資料」以完成剩餘部分。',
                confirmText: '重新載入',
                danger: true,
            });
            // 失敗路徑才解除重入旗標（第二輪驗收缺陷）：這裡沒有立即 reload 之外的下一步，
            // 解除旗標讓使用者可以馬上重跑一次清除收尾剩餘部分，是正確且必要的。
            _v2ClearAllDataInFlight = false;
            location.reload();
            return;
        }
        // 成功路徑刻意不解除旗標（不用 finally，兩條路徑各自處理）：反正 800ms 後就會
        // location.reload()，頁面整個重新載入、模組層級變數自然歸零，不解除旗標也不會有
        // 「永久卡死」的風險；維持 true 反而堵住了這 800ms 窗口內的重複點擊/console 呼叫，
        // 避免使用者在畫面顯示「已清除、即將重新載入」的同時又觸發第二輪清除流程。

        // 稽核日誌寫入獨立於清除結果之外（驗收缺陷 #2）：logger.log() 內部本身已 try/catch
        // 自行吞錯、絕不 throw（見 operationLogger.js），這裡移出上面的 try 純粹是移除「日誌
        // 與清除結果綁在同一個 try」這個容易誤導未來維護者的結構，並非因為它真的會拋錯；
        // 仍加 .catch(() => {}) 做防禦性保底，日誌失敗在任何情況下都不得影響清除結果判定。
        logger.log(LOG_ACTIONS.CLEAR_ALL_DATA, LOG_TARGET_TYPES.SYSTEM, null, {}).catch(() => {});

        localStorage.removeItem('substituteSystemData');
        localStorage.removeItem('gasUrl');
        dismissClearingToast?.();
        this.showToast?.('所有資料已清除，頁面將重新載入', 'success');
        // 延遲 reload：讓成功訊息至少有機會被看到，而不是 toast 淡入動畫還沒播完頁面就重整
        // （驗收缺陷 #6）。
        setTimeout(() => location.reload(), 800);
    };
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

/**
 * Stage 3 驗收修正：原自建 fixed toast（硬編 #fffbeb/#d97706/#92400e/#78350f + inline
 * position:fixed/z-index）收斂為共用 #toast-container + .toast 結構 class，色彩改
 * token（跟 components.css 的 .toast.toast-warning 走同一套視覺與淡入/淡出動畫），
 * 僅保留這顆 toast 特有的「前往教師管理」動作鈕（共用 showToast()/notify() 都不支援
 * 附加動作鈕，故仍走自建 DOM，但完全併入共用容器與樣式）。
 */
function showGoToTeacherAdminToast(count) {
    const existing = document.getElementById('v2-import-followup-toast');
    if (existing) existing.remove();

    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.id = 'v2-import-followup-toast';
    toast.className = 'toast toast-warning';
    toast.innerHTML = `
        <span class="toast-icon">📧</span>
        <div class="toast-body">
            <div><strong>${count}</strong> 位新教師待指派 email</div>
            <div class="v2-pending-meta">未指派 email 的教師無法登入系統</div>
            <div class="action-buttons">
                <button id="v2-goto-teacher-admin" class="btn btn-primary btn-sm">前往教師管理</button>
                <button id="v2-dismiss-followup-toast" class="btn btn-secondary btn-sm">稍後</button>
            </div>
        </div>
        <button class="toast-close">&times;</button>
    `;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));

    const dismiss = () => {
        toast.classList.remove('show');
        toast.classList.add('hide');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    };

    document.getElementById('v2-goto-teacher-admin').addEventListener('click', () => {
        const tabBtn = document.querySelector('.tab-btn[data-tab="teachers"]');
        if (tabBtn) tabBtn.click();
        dismiss();
    });
    document.getElementById('v2-dismiss-followup-toast').addEventListener('click', dismiss);
    toast.querySelector('.toast-close').addEventListener('click', dismiss);

    setTimeout(dismiss, 30000);
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
    link.className = 'btn btn-ghost btn-sm';
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
    backdrop.className = 'modal';

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
        <div class="modal-content">
            <div class="modal-body">
            <h3>${titles[mode]}</h3>
            ${mode !== 'forgot' ? `
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="v2-modal-email" placeholder="your@email.com" autocomplete="email">
                </div>
                <div class="form-group">
                    <label>密碼${mode === 'register' ? '（至少 6 字元）' : ''}</label>
                    <input type="password" id="v2-modal-pwd" placeholder="••••••••" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}">
                </div>
            ` : `
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="v2-modal-email" placeholder="your@email.com" autocomplete="email">
                </div>
            `}
            <div class="form-msg" id="v2-modal-msg" style="display:none;"></div>
            <p style="font-size:0.78rem; color:#6b7280; margin-top:0.6rem;">${helpText[mode]}</p>
            <div class="modal-actions">
                <button class="btn btn-secondary" id="v2-modal-cancel">取消</button>
                <button class="btn btn-primary" id="v2-modal-submit">
                    ${mode === 'signin' ? '登入' : mode === 'forgot' ? '寄重置信' : '註冊'}
                </button>
            </div>
            <div class="modal-links">
                ${mode !== 'signin' ? `<a data-mode="signin">← 回登入</a>` : `<span></span>`}
                ${mode !== 'forgot'   ? `<a data-mode="forgot">忘記密碼？</a>` : ''}
                ${mode !== 'register' ? `<a data-mode="register">我是新教師（註冊）</a>` : ''}
            </div>
            </div>
        </div>
    `;
    document.body.appendChild(backdrop);

    const msgEl = backdrop.querySelector('#v2-modal-msg');
    const showMsg = (text, kind = 'error') => {
        msgEl.textContent = text;
        msgEl.className = 'form-msg ' + kind;
        msgEl.style.display = 'block';
    };

    backdrop.querySelector('#v2-modal-cancel').addEventListener('click', closeAuthModal);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeAuthModal(); });
    backdrop.querySelectorAll('.modal-links a').forEach(a =>
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
    patchClearLocalData();

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
