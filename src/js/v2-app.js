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
import { LOG_ACTIONS, LOG_TARGET_TYPES, ROLES, REQUEST_STATUS, REQUEST_TYPES, SCHOOL_ID } from './modules/v2/schemaConstants.js';
import * as authMod from './modules/authService.js';
import * as cloudSyncSvc from './modules/cloudSyncService.js';
import { notify, notifyError, setSyncStatus, resetSyncStatus } from './modules/v2/uiFeedback.js';
import * as semesterUtils from './modules/v2/semesterUtils.js';
import * as semesterState from './modules/v2/semesterState.js';

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
/**
 * @param {number|null} count - 待辦數量；驗收修復（中 #A）：傳 null 表示「讀取失敗、數量未知」，
 *   顯示「!」而不是悄悄當成 0 筆消失——0 筆代表「已知確實沒有待辦」，未知不能用同一種
 *   視覺（無徽章）表示，否則使用者無從分辨兩者。
 */
function updatePendingNavBadge(count) {
    const btn = document.querySelector('.tab-btn[data-tab="v2-pending"]');
    if (!btn) return;
    let badge = btn.querySelector('.v2-tab-badge');
    if (count === null) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'v2-badge v2-tab-badge';
            btn.appendChild(badge);
        }
        badge.textContent = '!';
        badge.title = '待辦數量讀取失敗，請點開頁籤查看';
        return;
    }
    if (count > 0) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'v2-badge v2-tab-badge';
            btn.appendChild(badge);
        }
        badge.textContent = String(count);
        badge.removeAttribute('title');
    } else if (badge) {
        badge.remove();
    }
}

/**
 * 驗收修復（中 #A）：「待我同意/待我審核」錯誤卡片的重試鈕呼叫這支——重新打一次
 * listOpenPendingRequests()，成功就清掉 _v2PendingSourceError、更新 _v2PendingCache，
 * 失敗則維持錯誤狀態並提示。無論成功失敗都重繪，讓使用者立刻看到結果。
 */
async function retryPendingSource() {
    try {
        _v2PendingCache = (await dataSvc.listOpenPendingRequests()).map(requestSvc.normalizeLegacyRequest);
        _v2PendingSourceError = null;
    } catch (err) {
        _v2PendingSourceError = err;
        notifyError(err, '重新讀取待辦清單');
    }
    await renderPendingTab();
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

    // Stage 1（讀取成本止血，§5.4）：「待我同意」「待我審核」改直接讀 _v2PendingCache——
    // 即時訂閱已只監聽仍在途的請求（見 schoolDataService.subscribePendingRequests），內容與
    // 這裡原本自行 fetch 的全量結果對這兩個區塊而言完全等價（已核准／已拒絕的請求本來就
    // 不會出現在這兩個區塊），改用快取等於省下一次全校規模的重複讀取。
    // 「我的申請」需要包含已核准／已拒絕的個人歷史，這段快取沒有，改一次性按需查詢——
    // 範圍限定到「單一教師」，天然有界，不是全校規模的無界讀取。
    const openAll = _v2PendingCache;
    // 驗收修復（阻斷 #3）：這支查詢需要一個複合索引（initiatedBy+createdAt，見
    // firestore.indexes.json）；索引缺失或任何其他讀取失敗都只能讓「我的申請」這個區塊
    // 降級顯示錯誤卡片，不能讓例外冒泡出這個函式——renderPendingTab 會被 bootstrap 的
    // 初次渲染、身份切換、以及多個訂閱 callback 在沒有外層 try/catch 保護的情況下呼叫
    // （例如 subscribePendingRequests 的 callback 是 fire-and-forget 呼叫 renderPendingTab()，
    // 不 await 也沒包 try），一旦這裡拋錯，輕則整個待辦頁籤卡在「載入中…」，重則被 bootstrap
    // 外層的致命 catch 接住、把整個 app 判定成登入失敗並永久鎖死（實測即是如此）。
    let mine = [];
    let mineLoadError = null;
    try {
        const mineRaw = await dataSvc.listPendingRequestsByInitiator(me.teacherId);
        mine = mineRaw.map(r => requestSvc.normalizeLegacyRequest(r));
    } catch (err) {
        console.error('[v2] 讀取「我的申請」歷史失敗（已降級，不影響其他區塊）:', err);
        mineLoadError = err;
    }

    // 驗收修復（中 #A）：pendingRequests 的即時訂閱與 prefill 若同時失敗，_v2PendingCache
    // 會停在 `[]`——這個 openAll 是空陣列不代表「真的沒有待辦」，是「不知道」。pendingSourceError
    // 非 null 時，下面「待我同意/待我審核」改顯示錯誤卡片，不能顯示 renderList 的空狀態文字
    // （那句文字明確斷言「目前沒有」，在資料來源已知失敗時是假訊息）。
    const pendingSourceError = _v2PendingSourceError;

    // 1. 待我同意：我在 pendingConsentTeacherIds（或舊 requiredApproverId）名單中，且仍在同意階段
    const consentMine = openAll.filter(r =>
        r.status === REQUEST_STATUS.PENDING_SWAP_CONSENT && roleSvc.canConsentRequest(r)
    );
    const consentSwap      = consentMine.filter(r => r.requestType !== REQUEST_TYPES.MULTI_SWAP);
    const consentMultiSwap = consentMine.filter(r => r.requestType === REQUEST_TYPES.MULTI_SWAP);

    // 2. 待我審核：僅 approver（director / section_chief）可見
    const isApprover    = roleSvc.isApprover();
    const approvalQueue = isApprover ? openAll.filter(r => r.status === REQUEST_STATUS.PENDING_APPROVAL) : [];

    updatePendingNavBadge(pendingSourceError ? null : (consentMine.length + approvalQueue.length));

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

    // 驗收修復（中 #A）：pendingSourceError 非 null 時，「待我同意/待我審核」三個區塊統一
    // 顯示這張卡片，取代 renderList 的空狀態文字——避免使用者把「讀取失敗」誤讀成「沒有待辦」。
    const pendingErrorCard = (label) => `
        <div class="v2-logs-failed-banner">⚠ ${label}目前讀取失敗，無法確認是否有待辦事項，不代表「沒有」。
            <button class="btn btn-secondary btn-sm v2-refresh-pending-source-btn" style="margin-left:0.5rem;">重新整理</button></div>`;

    if (isStaleRender(_gen)) return;   // 期間身份已切換 → 放棄回填，保持 reset 清空的狀態
    host.innerHTML = `
        <div class="v2-section-header"><h3>待我同意・調課</h3></div>
        ${pendingSourceError ? pendingErrorCard('待我同意') : renderList(consentSwap, 'incoming', '目前沒有等待您同意的調課請求', consentActions)}

        <div class="v2-section-header" style="margin-top:2rem;"><h3>待我同意・多重調課</h3></div>
        ${pendingSourceError ? pendingErrorCard('待我同意') : renderList(consentMultiSwap, 'incoming', '目前沒有等待您同意的多重調課請求', consentActions, consentRemainMeta)}

        ${isApprover ? `
        <div class="v2-section-header" style="margin-top:2rem;">
            <h3>待我審核 ${!pendingSourceError && approvalQueue.length ? `<span class="v2-badge">${approvalQueue.length}</span>` : ''}</h3>
        </div>
        ${pendingSourceError ? pendingErrorCard('待我審核') : renderList(approvalQueue, 'incoming', '目前沒有待核准的申請', approvalActions)}
        ` : ''}

        <div class="v2-section-header" style="margin-top:2rem;"><h3>我的申請</h3></div>
        ${mineLoadError
            ? `<div class="v2-logs-failed-banner">⚠ 讀取「我的申請」歷史失敗，不影響上方待辦事項。
                <button class="btn btn-secondary btn-sm" id="v2-refresh-pending-mine" style="margin-left:0.5rem;">重新整理</button></div>`
            : renderList(mine, 'outgoing', '目前沒有您發起中的請求', mineActions, mineMeta)}
    `;

    document.getElementById('v2-refresh-pending-mine')?.addEventListener('click', renderPendingTab);
    // 驗收修復（中 #A）：這顆鈕不能只是重繪（_v2PendingCache/_v2PendingSourceError 不會自己
    // 變好）——實際重打 listOpenPendingRequests() 嘗試恢復，見 retryPendingSource()。
    host.querySelectorAll('.v2-refresh-pending-source-btn').forEach(btn =>
        btn.addEventListener('click', retryPendingSource));

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
    // Stage 1（讀取成本止血，§5.4）：300 → 50。這是低頻查閱的稽核輔助資訊，不需要一次撈這麼
    // 多；此頁籤本來就是一次性 getDocs（非 onSnapshot），每次打開／按「重新整理」都會重讀，
    // 不會因為調降筆數而看不到「最新」的日誌。
    const all = await logger.fetchLogs({ limit: V2_RECORDS_PAGE_SIZE });
    const visible = roleSvc.filterLogsForCurrent(all);
    const failedCount = logger.getFailedLogCount();

    // Stage 0 驗收修復 S8：joinAttempts（登入遭拒紀錄）目前無任何讀取端，approver
    // 完全看不到有誰嘗試登入被拒——加一個最小區塊列出來。一次性 getDocs（不用
    // onSnapshot），這是低頻查閱的稽核輔助資訊，不需要即時監聽；讀取失敗（例如規則
    // 版本尚未部署、emailIndex 集合為空等）不阻擋操作日誌本身的顯示。
    // 驗收修復 N1：整段用 isApprover() 包住——非 approver（理論上進不了這個 CSS
    // .v2-approver-only 頁籤，但這裡不依賴 CSS 當唯一防線）完全不 fetch、不渲染這個
    // 區塊，避免看到一個永遠空的「0 筆」區塊誤導成「從來沒人被拒絕過」。
    const canSeeJoinAttempts = roleSvc.isApprover();
    let joinAttempts = [];
    if (canSeeJoinAttempts) {
        try {
            joinAttempts = await dataSvc.listJoinAttempts();
            joinAttempts.sort((a, b) => (b.attemptedAt || '').localeCompare(a.attemptedAt || ''));
        } catch (e) {
            console.warn('[v2] 讀取 joinAttempts 失敗（不影響操作日誌本身顯示）：', e?.message || e);
        }
    }

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
        ${canSeeJoinAttempts ? `
        <div class="v2-section-header" style="margin-top:1.5rem;">
            <h3>登入遭拒 <small style="color:#6b7280;font-weight:normal;">（${joinAttempts.length} 筆，Stage 0 §3.4b）</small></h3>
        </div>
        <div class="table-wrap">
        <table class="data-table data-table-compact v2-log-table data-table-cards">
            <thead><tr><th>時間</th><th>Email</th><th>原因</th></tr></thead>
            <tbody>
            ${joinAttempts.length === 0
                ? '<tr><td colspan="3" style="color:#9ca3af;">目前沒有被拒絕的登入嘗試</td></tr>'
                : joinAttempts.map(j => `
                <tr>
                    <td data-label="時間">${fmtDate(j.attemptedAt)}</td>
                    <td data-label="Email">${escapeHtml(j.email || '—')}</td>
                    <td data-label="原因">${escapeHtml(j.reason || '—')}</td>
                </tr>`).join('')}
            </tbody>
        </table>
        </div>` : ''}
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

    // Stage 1（讀取成本止血，§5.4/§5.6）：不再對整個 substituteRecords 集合做無界一次性讀取。
    //   - 無日期篩選：資料來源是即時訂閱視窗（_v2RecordsCache，最近 V2_RECORDS_PAGE_SIZE 筆）
    //     ＋使用者按過的「載入更多」分頁（_v2RecordsTabExtra），依 recordId 去重後依 createdAt
    //     新到舊排序。
    //   - 有日期篩選：篩選範圍可能落在即時視窗之外（視窗按 createdAt 排序，不是按 date），
    //     改一次性下推查詢 Firestore（v2GetRecordsInRange，見該函式註解）。
    const hasDateFilter = Boolean(_v2RecordsFilterStart || _v2RecordsFilterEnd);
    // Stage 2（§5.4「歷史學期」列）：學期選擇器選了「非當前學期」時，優先權高於日期篩選——
    // 歷史學期是規則層已鎖唯讀的封閉範圍，改走一次性 listSubstituteRecordsBySemester()查詢，
    // 與「當前學期＝即時訂閱」在資料來源上互斥（不會混合兩種來源）。空字串或選回目前學期
    // 都視同「檢視當前學期」，沿用既有 Stage 1 行為（即時視窗＋載入更多／日期篩選）。
    const viewingHistorySemester = Boolean(_v2RecordsSemesterFilter) && _v2RecordsSemesterFilter !== semesterState.getCurrentSemesterId();
    let all;
    let recordsTabHasMore = false;
    // 驗收修復（中 #B）：兩個日期輸入框都有值時，使用者可能直接把起訖填反（起始晚於結束）。
    // 這種情況同步就能判斷（不需要打 Firestore 才發現查回 0 筆），先在這裡短路並顯示提示，
    // 不要讓使用者誤以為「查無紀錄」代表真的沒有資料。
    const dateRangeInvalid = !viewingHistorySemester && hasDateFilter
        && !dataSvc.resolveDateRangeBounds({ startDate: _v2RecordsFilterStart || null, endDate: _v2RecordsFilterEnd || null }).valid;
    if (viewingHistorySemester) {
        all = await v2GetRecordsBySemester(_v2RecordsSemesterFilter);
    } else if (dateRangeInvalid) {
        all = [];
    } else if (hasDateFilter) {
        all = await v2GetRecordsInRange(_v2RecordsFilterStart, _v2RecordsFilterEnd);
    } else {
        // 驗收修復（中 #7）：合併順序改為「舊分頁在前、即時視窗在後」——Map.set 同 key 後寫
        // 蓋前寫，若同一筆 recordId 剛好同時出現在兩邊（即時視窗更新到某筆、而該筆先前也
        // 被「載入更多」抓過），要讓即時視窗（較新鮮）蓋掉載入更多當時的舊快照，不能反過來。
        const merged = new Map();
        [..._v2RecordsTabExtra, ..._v2RecordsCache].forEach(r => { if (r.recordId) merged.set(r.recordId, r); });
        all = [...merged.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        // 驗收修復（中 #6）：改用 _v2RecordsTabHasMore !== null 判斷「是否已經真的查過一次」，
        // 不能用 _v2RecordsTabExtra.length > 0——當總筆數剛好是 V2_RECORDS_PAGE_SIZE 的倍數時，
        // 某次「載入更多」查回 0 筆新資料，_v2RecordsTabExtra 長度不會變化（concat 空陣列），
        // 若沿用 length>0 當守門條件就會被誤判成「還沒查過」，又退回用
        // `_v2RecordsCache.length >= V2_RECORDS_PAGE_SIZE` 這個樂觀猜測（剛好又是 true），
        // 導致按鈕永遠不消失、每次點擊都查到 0 筆。null 表示「使用者從未點過載入更多」，
        // 一旦點過就一律信任上一次查詢實際回傳的 hasMore（可能是 true 也可能是 false）。
        recordsTabHasMore = _v2RecordsTabHasMore !== null
            ? _v2RecordsTabHasMore
            : _v2RecordsCache.length >= V2_RECORDS_PAGE_SIZE;
    }

    const semesterOptions = await v2ListSemesterOptions();
    if (isStaleRender(_gen)) return;   // 身份切換世代守門：兩段 await 之間都可能過期

    const visible   = roleSvc.filterRecordsForCurrent(all);
    const isApprover = roleSvc.isApprover();
    const APPROVER_ROLES_FOR_BADGE = ['admin', 'director', 'section_chief'];

    // Phase 5：legacy 篩選（全部／僅新／僅舊）純前端過濾，不影響 visible 本身（PDF/刪除仍可對到完整紀錄）。
    const legacyFiltered = _v2RecordsLegacyFilter === 'legacy' ? visible.filter(r => r.isLegacy)
        : _v2RecordsLegacyFilter === 'new' ? visible.filter(r => !r.isLegacy)
        : visible;

    // Stage 5（F1 方式補篩選）：教師 select 選項取自 visible 本身出現過的姓名。
    // Stage 1 取捨：visible 現在只涵蓋「目前已載入」的範圍（即時視窗＋載入更多的分頁，或
    // 日期篩選查詢結果），不再是全校歷史——教師下拉選單只會列出目前已載入範圍內出現過的
    // 姓名，可能比改造前少（尚未載入的較舊紀錄若有其他教師姓名不會出現）。維持這個取捨而不
    // 改成另外呼叫 listTeachers()：避免每次重繪都額外多打一次 Firestore 換取一個純顯示層的
    // 下拉選單完整度，且教師名字本來就能用「輸入日期篩選」間接查到。
    const teacherNames = Array.from(new Set(
        visible.flatMap(r => [r.originalTeacher, r.substituteTeacher, r.swapTeacher]).filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, 'zh-TW'));

    // 起訖日已在資料來源層處理（v2GetRecordsInRange），這裡只再做教師姓名的純前端過濾。
    const displayed = legacyFiltered
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
                    <label for="v2-record-semester">學期</label>
                    <select id="v2-record-semester">
                        <option value="">當前學期</option>
                        ${semesterOptions.filter(s => s !== semesterState.getCurrentSemesterId()).map(s =>
                            `<option value="${escapeHtml(s)}" ${s === _v2RecordsSemesterFilter ? 'selected' : ''}>${escapeHtml(s)}（歷史）</option>`
                        ).join('')}
                    </select>
                </div>
                <div class="form-group form-group-inline">
                    <label for="v2-record-start-date">起始</label>
                    <input type="date" id="v2-record-start-date" value="${_v2RecordsFilterStart}" ${viewingHistorySemester ? 'disabled' : ''}>
                </div>
                <div class="form-group form-group-inline">
                    <label for="v2-record-end-date">結束</label>
                    <input type="date" id="v2-record-end-date" value="${_v2RecordsFilterEnd}" ${viewingHistorySemester ? 'disabled' : ''}>
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
        ${viewingHistorySemester ? `
        <p class="muted" style="margin:0.5rem 0;">
            正在檢視歷史學期「${escapeHtml(_v2RecordsSemesterFilter)}」（唯讀，已鎖定不可再新增/編輯）。已停用起訖日期篩選——歷史學期為一次性查詢整學期資料，非分頁列表。
        </p>` : ''}
        ${!viewingHistorySemester && dateRangeInvalid ? `
        <p class="muted" style="margin:0.5rem 0;color:#b45309;">
            起訖日期範圍無效（起始日期晚於結束日期），請重新選擇。
        </p>` : ''}
        ${!viewingHistorySemester && !isApprover && !hasDateFilter && !dateRangeInvalid && displayed.length === 0 ? `
        <p class="muted" style="margin:0.5rem 0;">
            這裡預設只顯示全校最近 ${V2_RECORDS_PAGE_SIZE} 筆紀錄中「與您相關」的部分，若您的紀錄較舊、不在這批最新資料內就不會顯示。
            請用上方「起始／結束」日期篩選查詢您的紀錄。
        </p>` : ''}
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
        ${!viewingHistorySemester && !hasDateFilter && recordsTabHasMore ? `
        <div style="text-align:center;margin-top:1rem;">
            <button class="btn btn-secondary btn-sm" id="v2-records-load-more-btn">載入更多（目前已載入 ${all.length} 筆）</button>
        </div>` : ''}
        ${!viewingHistorySemester && hasDateFilter && !dateRangeInvalid ? `
        <p class="muted" style="margin-top:0.75rem;font-size:0.8rem;">已依日期範圍查詢，非分頁列表；如需查看更多歷史請調整起訖日期。</p>` : ''}
    `;

    document.getElementById('v2-records-load-more-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = '載入中…';
        try {
            await loadMoreRecordsTabPage();
            await renderRecordsTab();
        } catch (err) {
            notifyError(err, '載入更多紀錄');
            btn.disabled = false;
            btn.textContent = '載入更多';
        }
    });

    document.getElementById('v2-records-legacy-filter')?.addEventListener('change', (e) => {
        _v2RecordsLegacyFilter = e.target.value;
        renderRecordsTab();
    });

    document.getElementById('v2-record-semester')?.addEventListener('change', (e) => {
        _v2RecordsSemesterFilter = e.target.value;
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
                try {
                    await requestSvc.adminDeleteRecord(btn.dataset.id);
                    // 驗收修復（中 #4）：刪除的紀錄若不在即時訂閱視窗內（例如較舊、透過日期
                    // 篩選查到的一筆），subscribeSubstituteRecords 的 onSnapshot 不會被觸發，
                    // _v2DateRangeQueryCache 裡快取的日期範圍查詢結果會繼續回傳「已刪除但快取
                    // 仍在」的舊資料，直接清空最保險。
                    _v2DateRangeQueryCache.clear();
                    await renderRecordsTab();
                }
                catch (e) { notifyError(e, '刪除紀錄'); }
            }));
    }
}

/* ===== Stage 2：學期管理（§6.1 SOP 前半） ===== */

/**
 * 設定頁「學期管理」卡片，director 專用（容器 `.v2-director-only` 已在 CSS 隱藏非 director
 * 身份，這裡再用 roleSvc.isDirector() 守一次，理由與既有各處「UI 隱藏 + 執行前再驗一次」
 * 慣例一致，見 patchClearLocalData 內的同款註解）。顯示目前作用中學期、提供「開新學期」。
 * 封存/刪除功能是 Stage 5，不在此實作範圍。
 */
async function renderSemesterAdminTab() {
    const host = document.getElementById('v2-semester-admin');
    if (!host) return;
    if (!roleSvc.isDirector()) { host.innerHTML = ''; return; }

    const _gen = _v2IdentityGen;
    const cur = semesterState.getCurrentSemesterId();
    const suggestion = semesterUtils.nextSemesterId(cur) || '';

    if (isStaleRender(_gen)) return;
    host.innerHTML = `
        <div class="data-management-section">
            <strong>目前作用中的學期</strong>
            <p class="hint">全校所有新的調代課紀錄、待審申請、課表上傳都歸屬這個學期；其餘學期為唯讀（可在「調代課紀錄」頁籤切換查閱）。</p>
            <p style="font-size:1.1rem;font-weight:600;margin:0.3rem 0 0.8rem;">${escapeHtml(cur || '（尚未設定，暫以今天日期推算）')}</p>
        </div>
        <div class="data-management-section danger-zone">
            <strong>開新學期</strong>
            <p class="hint">切換後，「${escapeHtml(cur || '目前學期')}」立即變為唯讀（不可再新增/編輯調代課紀錄與課表，歷史資料仍可查詢），新學期需重新上傳課表才能開始使用。此操作會寫入操作日誌並重新整理頁面。</p>
            <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.4rem;flex-wrap:wrap;">
                <input type="text" id="v2-new-semester-input" placeholder="例如 115-1" value="${escapeHtml(suggestion)}" style="max-width:140px;">
                <button class="btn btn-danger btn-sm" id="v2-open-new-semester-btn">開新學期</button>
            </div>
        </div>
    `;

    document.getElementById('v2-open-new-semester-btn')?.addEventListener('click', async () => {
        const input = document.getElementById('v2-new-semester-input');
        const newId = (input?.value || '').trim();
        if (!semesterUtils.isValidSemesterId(newId)) {
            notify('學期格式不正確，請輸入類似「115-1」的格式（民國學年-學期，學期只能是 1 或 2）', 'warning');
            return;
        }
        if (newId === cur) {
            notify('這就是目前的學期，不需要切換', 'warning');
            return;
        }

        // 驗收修復（中 4）：切換前先擋下「在途申請黑洞」——若目前學期還有待同意/待核准的
        // pendingRequests，切換後這些請求的 semesterId 會停在舊學期，approveRequest() 核准
        // 時會把新產生的 substituteRecord 蓋成「核准當下」的目前學期（見 pendingRequestService
        // 的說明），與該請求原本的 semesterId 不一致，容易造成混淆；更根本的是，一旦舊學期
        // 變唯讀，這些請求若因故需要改走 pendingRequests 的 create（理論上不會，只是
        // update/delete），也會被規則卡住。與其讓使用者切換後才發現一批申請卡在無法妥善
        // 收斂的狀態，不如切換前就要求先清空。listOpenPendingRequests() 預設已經是「目前
        // 學期」範圍（見 schoolDataService.js），直接沿用不需額外指定。
        let openCount = 0;
        try {
            openCount = (await dataSvc.listOpenPendingRequests()).length;
        } catch (err) {
            console.warn('[V2] 開新學期：檢查在途申請失敗，為安全起見暫停切換：', err);
            notify('無法確認目前是否有在途申請，請稍後再試（為安全起見已暫停本次切換）', 'error');
            return;
        }
        if (openCount > 0) {
            notify(`目前還有 ${openCount} 筆在途申請（待同意/待核准）尚未處理，請先在「待辦」頁籤處理完再開新學期`, 'warning', 6000);
            return;
        }

        const ok = await window.app?.confirmDialog?.({
            title: '開新學期',
            message:
                `確定要把作用中學期從「${cur}」切換到「${newId}」嗎？\n\n` +
                `切換後：\n` +
                `・「${cur}」立即變為唯讀，不可再新增或編輯調代課紀錄與課表（歷史資料仍可查詢）\n` +
                `・「${newId}」需要重新上傳課表才能開始使用\n` +
                `・此操作會寫入操作日誌，且系統會重新整理頁面以套用新學期設定\n\n` +
                `此操作無法一鍵復原（需再開一次學期才能切回原值），請確認。`,
            confirmText: '確認開新學期',
            danger: true,
        });
        if (!ok) return;

        const btn = document.getElementById('v2-open-new-semester-btn');
        if (btn) { btn.disabled = true; btn.textContent = '切換中…'; }
        try {
            await switchToNewSemester(cur, newId);
        } catch (err) {
            console.error('[V2] 開新學期失敗:', err);
            notifyError(err, '開新學期');
            if (btn) { btn.disabled = false; btn.textContent = '開新學期'; }
        }
    });
}

/**
 * 驗收修復（中 3）：顯示「學期已切換，請重新整理」的橫幅——不會自動消失，只能靠使用者按
 * 按鈕或自行重新整理來關閉，避免使用者沒注意到而繼續在已經唯讀的舊學期資料上操作。
 * idempotent（重複呼叫只留一份），比照既有各處「先查 id 是否已存在」的注入慣例
 * （例如 injectV2Styles）。
 */
function showSemesterChangedBanner(newSemesterId) {
    if (document.getElementById('v2-semester-changed-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'v2-semester-changed-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b45309;color:#fff;' +
        'padding:0.6rem 1rem;text-align:center;font-size:0.9rem;box-shadow:0 2px 6px rgba(0,0,0,0.2);';
    banner.innerHTML =
        `學期已切換為「${escapeHtml(newSemesterId)}」，請重新整理頁面以套用新學期設定。` +
        `<button id="v2-semester-changed-reload-btn" style="margin-left:0.8rem;padding:0.2rem 0.8rem;` +
        `border:none;border-radius:4px;cursor:pointer;background:#fff;color:#b45309;font-weight:600;">立即重新整理</button>`;
    document.body.prepend(banner);
    document.getElementById('v2-semester-changed-reload-btn')?.addEventListener('click', () => window.location.reload());
}

/**
 * Stage 2（§6.1 SOP）：把作用中學期從 fromId 切到 toId。
 *   1. 驗收修復（中 5，R1 訂正安全性）：確保 schedules/{fromId} 存在——若 fromId 從未透過
 *      本函式或課表上傳建立過 per-semester 文件（例如 Stage 2 上線後第一次切換），補一份
 *      空殼，確保 fromId 之後仍會出現在 v2ListSemesterOptions() 的學期選擇器清單。用
 *      getSchedule(fromId) 確認「真的沒有任何資料」才建立空殼；讀取失敗時整個切換直接
 *      中止（fail-closed），不會冒險覆寫可能存在的真實課表資料（見函式內註解，R1 修復）。
 *      必須在改 config.currentSemester「之前」做——schedules/{semesterId} 的寫入規則鎖
 *      「只能寫目前學期那一份」，一旦 currentSemester 已經是 toId，就再也無法補寫
 *      schedules/{fromId} 了（見 firestore.rules 的 schedules/{semesterId} match 區塊）。
 *   2. 更新 config.currentSemester（規則層的學期唯讀鎖即刻對舊學期生效）。
 *   3. 建立 schedules/{toId}（空殼，讓新學期一開始就有一份「存在但空白」的課表文件，
 *      不必等 approver 第一次上傳才出現在學期清單）。
 *   4. 寫操作日誌（action: 'semester_switch'，比照報告 §6.1 SOP 步驟 [2]）。
 *   5. reload 頁面——這是本專案既有的「換乾淨狀態」慣例（clearAllSchoolData／
 *      patchClearLocalData 用同一招），不另外設計一套「原地重新訂閱所有 onSnapshot」機制：
 *      bootstrap 內建立的即時訂閱（待辦／全校紀錄／課表／學期變更監聽／視需要的操作日誌）
 *      全部綁定在一次性讀到的 semesterState 值上，reload 後重新走一次 bootstrap 自然會用
 *      新學期重建，風險遠低於手動追蹤並取消/重建每一條訂閱。
 *
 * ⚠ 驗收修復（輕13，opus 驗收，Stage 2 遺留問題）：步驟 2、3 的順序對調——原版是
 * 「先寫兩份 schedules 佔位文件，最後才更新 config.currentSemester」。firestore.rules 的
 * schedules/{semesterId} 寫入規則要求 isCurrentSemester(schoolId, semesterId)：寫
 * schedules/{toId} 時，若 config.currentSemester 還沒被改成 toId，這筆寫入必定被規則拒絕
 * （permission-denied）——原順序在規則部署後，「開新學期」會在正常路徑上必然失敗於「建立
 * schedules/{toId}」這一步，等於這個功能規則部署後就是壞的。
 * 正確順序：
 *   (a) schedules/{fromId} 佔位（若缺）——此時 config 仍是 fromId，符合規則要求，必須排在
 *       config 更新「之前」（步驟 1，未變動）。
 *   (b) upsertConfig({ currentSemester: toId })——規則層學期唯讀鎖立即對 fromId 生效
 *       （步驟 2，提前）。
 *   (c) schedules/{toId} 佔位——此時 config 已是 toId，符合規則要求（步驟 3，延後）。
 * 步驟 (c) 若失敗（例如網路瞬斷），config.currentSemester 已經指向 toId——這是刻意接受的
 * 狀態：「目前學期」的定義本來就是 config.currentSemester 這個單一事實來源，課表文件缺席
 * 不影響這個定義成立，只影響「toId 這學期目前沒有課表可用」，director 可以稍後在「課表
 * 管理」重新上傳補上，不需要（也做不到）復原整個切換動作——沒有任何機制可以安全地把
 * config 改回 fromId，因為那段時間內可能已經有人往 toId 寫入了新的調代課紀錄/申請
 * （建立規則只鎖 isCurrentSemester，一旦 config 指向 toId，新紀錄立刻就能合法地寫進去）。
 * 下方 catch 區塊會產出一則明確指出「已切換，但課表建立失敗」的錯誤訊息，不讓使用者誤以為
 * 整個操作完全沒有發生（見 docs/STAGE5-ARCHIVE.md 驗證清單的對應說明）。
 *
 * 呼叫端（renderSemesterAdminTab 的按鈕 handler）已先做過「無在途申請」檢查（驗收修復 中 4，
 * 見該處），這裡不重複檢查——避免同一份業務規則分散在兩處、日後改動漏改一邊。
 */
async function switchToNewSemester(fromId, toId) {
    const me = roleSvc.getCurrentIdentity();
    const buildMeta = (action) => ({
        lastAction:  action,
        byName:      me?.name || '',
        byTeacherId: me?.teacherId || null,
        at:          new Date().toISOString(),
    });

    // 驗收修復（R1，opus 重驗｜阻斷級資料遺失）：原版用 listKnownSemesterIds().catch(() => [])
    // 取得已知學期清單，讀取失敗時 catch 吞掉錯誤、回傳空陣列——這會讓
    // `!knownBeforeSwitch.includes(fromId)` 誤判成立，即使 schedules/{fromId} 其實已經有
    // 真實課表資料，下面的 saveSchedule() 仍會把它整份覆寫成空殼。覆寫發生在
    // config.currentSemester 改成 toId「之前」，但覆寫本身已經是破壞性動作——一旦執行，
    // fromId 的真實課表內容就永久遺失（覆寫後 fromId 不再是目前學期，寫入規則禁止再回寫，
    // 沒有任何復原路徑）。
    // 改為：
    //   1. 直接用 getSchedule(fromId) 確認 fromId 目前是否已有任何課表資料（該函式本身已含
    //      per-semester 文件 + 舊版 data/schedule 的 fallback 讀取，見其定義），不透過「列出
    //      整個 schedules/ 集合再判斷某個 id 在不在裡面」這種間接方式。
    //   2. 讀取失敗時直接 rethrow、整個切換中止（fail-closed，與中 4「無法確認在途申請就
    //      中止切換」同一原則）——寧可讓 director 重試一次「開新學期」，也不要在不確定
    //      fromId 現況的狀態下，冒著覆寫/遺失資料的風險繼續動作。
    //   3. 只有在確認 getSchedule(fromId) 回傳 null（per-semester 文件與 legacy fallback
    //      皆真的沒有任何資料）時，才建立空殼——這種情況下沒有任何資料可能被覆寫遺失，
    //      寫入的唯一作用是讓 fromId 出現在 v2ListSemesterOptions() 的學期選擇器清單。
    //      已知限制：若 fromId 只能透過 legacy fallback 讀到內容（per-semester 文件本身
    //      不存在，例如尚未跑過 scripts/migrate-schedule-to-semester.js），getSchedule()
    //      會回傳該 fallback 內容（非 null），本函式因此不會建立 schedules/{fromId}——
    //      這種邊界情況下 fromId 仍不會出現在學期選擇器清單，需另外手動跑遷移腳本補上；
    //      這是刻意的取捨（安全優先於清單完整度），不是遺漏。
    let existingFromSchedule;
    try {
        existingFromSchedule = await dataSvc.getSchedule(fromId);
    } catch (e) {
        throw new Error(
            `開新學期已中止：無法確認「${fromId}」目前的課表狀態，為避免覆寫/遺失資料，` +
            `這次不會繼續切換。請確認網路連線後重試。（原始錯誤：${(e && e.message) || e}）`
        );
    }
    if (!existingFromSchedule) {
        await dataSvc.saveSchedule(fromId, {
            scheduleData: [], teachers: [], classes: [], subjectDomainMap: {}, schoolName: '',
            meta: buildMeta('semester_closed_placeholder'),
        });
    }

    // 驗收修復（輕13）：config 更新提前到 schedules/{toId} 建立之前——見函式頭註解的完整
    // 理由。本機快取（semesterState）同步更新：config 已在雲端生效，即使下一步失敗，
    // 也不該讓本機繼續認為目前學期還是 fromId。
    await dataSvc.upsertConfig({ currentSemester: toId });
    semesterState.setCurrentSemesterId(toId);

    try {
        await dataSvc.saveSchedule(toId, {
            scheduleData: [], teachers: [], classes: [], subjectDomainMap: {}, schoolName: '',
            meta: buildMeta('semester_opened'),
        });
    } catch (e) {
        // 學期切換本身（config.currentSemester）已經生效，只是新學期的空白課表建立失敗——
        // 如實描述目前狀態，不要讓錯誤訊息聽起來像「整個操作都沒發生」（見函式頭註解）。
        //
        // Stage 5 驗收修復（輕6，opus 二輪驗收）：這條分支不會走到函式尾端的
        // `setTimeout(() => window.location.reload(), 1200)`（那段只在成功路徑執行），但
        // `semesterState.setCurrentSemesterId(toId)` 已經在上面（config 更新後）執行過——
        // 本機記憶體已經認定「目前學期」是 toId，但 bootstrap 當時建立的即時訂閱
        // （subscribeSubstituteRecords／subscribePendingRequests／subscribeSchedule）仍是
        // 綁定 fromId 查詢條件的舊訂閱，不會自動跟著換——這正是「semesterState 已切、訂閱
        // 還綁舊學期」的半套狀態，寫入會因為規則已認 toId 而通過、但畫面讀到的仍是 fromId
        // 的即時資料，兩者不一致。呼叫 showSemesterChangedBanner()（既有機制，設計目的
        // 就是「本機學期狀態已改變，需要使用者重新整理才能讓訂閱跟上」，見該函式定義處，
        // 平常用於偵測「別的分頁切換了學期」）在這裡同樣適用，強制要求使用者重新整理，
        // 不留給使用者在半套狀態下繼續操作的機會。
        showSemesterChangedBanner(toId);
        await logger.log(LOG_ACTIONS.SEMESTER_SWITCH, LOG_TARGET_TYPES.SYSTEM, null, {
            from: fromId, to: toId, scheduleCreateFailed: true, error: (e && e.message) || String(e),
        });
        throw new Error(
            `已切換到「${toId}」（學期本身已生效），但建立空白課表文件失敗：${(e && e.message) || e}。` +
            `請依畫面上方橫幅重新整理頁面（本機顯示的即時資料在重新整理前仍綁定舊學期，` +
            `不會自動更新），並盡快在「課表管理」重新上傳「${toId}」的課表。`
        );
    }

    await logger.log(LOG_ACTIONS.SEMESTER_SWITCH, LOG_TARGET_TYPES.SYSTEM, null, { from: fromId, to: toId });
    notify(`已切換到「${toId}」，即將重新整理頁面…`, 'success', 2500);
    setTimeout(() => window.location.reload(), 1200);
}

/* ===== Stage 5：資料封存（RESEARCH-multitenancy-semester.md §6.2 SOP、§6.5 operationLogs 解法 b） =====
 *
 * 三段流程：匯出 → 驗證 → 刪除，每段都是前一段成功的必要條件（gate），任一步驟失敗或資料
 * 在期間發生變動，一律退回較早的狀態、要求重新做——這是本次實作 prompt 明訂的 fail-closed
 * 原則：「任何讀取/比對失敗一律中止，不得在不確定狀態下刪除」。
 *
 * 範圍界定（§6.2 陷阱一/§6.5）：
 *   - 匯出讀取：課表 doc + substituteRecords/pendingRequests（皆含 private/detail）+ operationLogs。
 *   - 刪除範圍：substituteRecords/pendingRequests（各自的 private/detail 先刪、父文件後刪，
 *     由既有 dataSvc.deleteSubstituteRecordsBatch()/deletePendingRequestsBatch() 負責）+
 *     schedules/{semesterId} 課表 doc。**operationLogs 不在刪除範圍內**——client 規則對
 *     operationLogs 的 update/delete 恆為 false（稽核軌跡不可改/刪），期滿清理改由平台管理者
 *     離線執行 scripts/cleanup-operation-logs.js（見該檔），UI 文案需明確告知這一點。
 *   - 只能刪「非目前作用中學期」——多處重複檢查（選單提示 + 執行前重新讀 config 核實），
 *     理由見 executeSemesterArchiveDelete() 內註解。
 */

// 封存流程的 session 記憶體狀態（module 層級，比照既有各處「換身份/換學期即清空」慣例）。
// 兩段狀態機：'exported'（已匯出並下載，等待使用者選檔驗證）→ 'verified'（雜湊、筆數與
// 實際 ID 集合皆核對通過，可以刪除）。semesterId 與目前下拉選單選擇不符時一律視為不成立
// ——換學期、重新整理頁面、身份切換都會讓這份狀態失去意義，不應該被沿用。
// Stage 5 驗收修復（阻斷2）：新增 recordIds/reqIds（匯出當下的完整 id 清單，供刪除前做
// ID 集合逐一比對，不只是比對筆數）與 recordIdsWithDetail/reqIdsWithDetail（其中「已知有
// private/detail 子文件」的 id 子集合，供刪除時只對真的有 detail 的紀錄送出 detail 刪除
// 請求，見輕10 / dataSvc.deleteSubstituteRecordsBatchKnownDetail()）。
let _archiveState = null;
// { semesterId, phase: 'exported'|'verified', hash, counts, exportedAt,
//   recordIds: string[], reqIds: string[],
//   recordIdsWithDetail: string[], reqIdsWithDetail: string[] }

/** SHA-256 雜湊（十六進位字串）。瀏覽器原生 Web Crypto，不引入額外套件（§6.2 陷阱二）。 */
async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 一次性讀出「指定學期」封存所需的完整資料（§6.2 步驟 [2]）：課表 doc、substituteRecords
 * 與 pendingRequests（皆含 private/detail）、operationLogs。回傳
 * { payload, counts, recordIds, reqIds, recordIdsWithDetail, reqIdsWithDetail }。
 * 純讀取、不寫入不刪除——只給匯出流程使用；「驗證/刪除前重新核對」改用下方更輕量的
 * fetchSemesterArchiveSnapshot()（不含 private/detail、不含 operationLogs，見該函式與
 * 中3 的完整說明），避免同一次封存操作把 §6.2 陷阱三提到的一次性大量讀取重複發生兩三次。
 *
 * Stage 5 驗收修復（阻斷1，opus 驗收，fail-open）：本函式任何一步讀取失敗都必須讓整個
 * 匯出中止，不能吞錯後繼續組出一份實際殘缺的匯出：
 *   - 課表改用 getScheduleForSemesterStrict()（不含 legacy fallback、不吞任何錯誤，見中4／
 *     schoolDataService.js 該函式定義），取代原本 `getSchedule(semesterId).catch(() => null)`
 *     ——原寫法會把「讀取失敗（例如網路瞬斷）」與「這學期真的沒有課表」混為一談，讓一次
 *     不確定的讀取結果被靜默當成確定的「無課表」寫進匯出 JSON。
 *   - 私有明細改用 getRecordDetailsBulkStrict()/getRequestDetailsBulkStrict()（零容忍版本，
 *     不吞 permission-denied——對執行封存的 director 而言，讀自己學校的 private/detail
 *     理論上不可能合法地遇到 permission-denied，見兩函式的完整說明），取代一般版
 *     getRecordDetailsBulk()/getRequestDetailsBulk()（那兩支是給一般教師 UI 讀取「不屬於
 *     自己」的紀錄時容錯用，容錯對象不是這裡的呼叫情境）。
 */
async function collectSemesterArchiveData(semesterId, onProgress) {
    onProgress?.('讀取課表…');
    const schedule = await dataSvc.getScheduleForSemesterStrict(semesterId);

    onProgress?.('讀取調代課紀錄…');
    const records = await dataSvc.listSubstituteRecordsBySemesterForArchive(semesterId);
    onProgress?.(`讀取調代課紀錄私有明細（共 ${records.length} 筆）…`);
    const recordDetails = await dataSvc.getRecordDetailsBulkStrict(records.map(r => r.recordId));

    onProgress?.('讀取待審請求…');
    const pendings = await dataSvc.listPendingRequestsBySemesterForArchive(semesterId);
    onProgress?.(`讀取待審請求私有明細（共 ${pendings.length} 筆）…`);
    const pendingDetails = await dataSvc.getRequestDetailsBulkStrict(pendings.map(p => p.reqId));

    onProgress?.('讀取操作日誌…');
    const logs = await dataSvc.listLogsBySemesterForArchive(semesterId);

    // Stage 5 驗收修復（中3）：counts 不含 operationLogs——operationLogs 只在「匯出」這次性
    // 讀取中被納入（見下方 payload.meta.counts），驗證/刪除前的重新核對不比對它，理由見
    // fetchSemesterArchiveSnapshot() 的完整說明（歷史學期的 operationLogs 結構上不會再變動）。
    const counts = {
        substituteRecords: records.length,
        pendingRequests:   pendings.length,
        hasSchedule:       !!schedule,
    };

    const payload = {
        meta: {
            schoolId: SCHOOL_ID,
            semesterId,
            counts: {
                ...counts,
                operationLogs: logs.length,
                substituteRecordDetails: recordDetails.size,
                pendingRequestDetails:   pendingDetails.size,
            },
            reportRef: 'docs/RESEARCH-multitenancy-semester.md §6.2',
        },
        schedule: schedule || null,
        substituteRecords: records.map(r => ({ ...r, private: recordDetails.get(r.recordId) || null })),
        pendingRequests:   pendings.map(p => ({ ...p, private: pendingDetails.get(p.reqId) || null })),
        operationLogs:     logs,
    };

    return {
        payload,
        // counts 額外帶 operationLogs 供 UI 顯示用（例如匯出完成提示、刪除前確認 modal），
        // 但這個欄位不會被 diffArchiveCounts() 用來 gate 刪除——理由同上。
        counts: { ...counts, operationLogs: logs.length },
        recordIds: records.map(r => r.recordId),
        reqIds: pendings.map(p => p.reqId),
        recordIdsWithDetail: [...recordDetails.keys()],
        reqIdsWithDetail: [...pendingDetails.keys()],
    };
}

/**
 * Stage 5 驗收修復（阻斷2 + 中3，opus 驗收）：一次性讀取「指定學期」的 substituteRecords／
 * pendingRequests 完整文件陣列＋課表，回傳 `{ records, pendings, schedule, counts }`。
 * 用於「驗證」與「刪除前最後一次核對」共用同一支函式——**刪除步驟直接重用這次呼叫回傳的
 * records/pendings 陣列去執行刪除，不再另外重新查詢一次**。
 *
 * 原版設計是「recount（只查筆數）→ 比對通過 → 另外再 query 一次拿完整文件做刪除清單」，
 * 這兩次查詢之間存在一個時間窗：recount 當下核對過的資料，到緊接著的 requery 當下可能又
 * 已經不同（例如同一秒內另一個 approver 刪除了一筆請求），届時刪除清單其實是「requery
 * 當下的新狀態」，並沒有真的被上一步驟核對過，等於白核對。改為本函式一次到位：查到的
 * 文件陣列「就是」稍後會被拿去刪除的那份資料，核對與刪除之間不再插入任何一次新的查詢。
 *
 * 刻意不含 operationLogs（中3，讀取量修正）：operationLogs 的 `create` 規則寫入的
 * `semesterId` 恆取 `semesterState` 當下值（見 operationLogger.js `log()`），一筆日誌一旦
 * 寫入，沒有任何應用層路徑會再改動它的 `semesterId` 或內容（規則層 `update`/`delete` 恆
 * `false`）——對「已經不是目前學期」的歷史學期而言，其 operationLogs 筆數在結構上**不可能
 * 再變動**（沒有任何寫入路徑能對歷史學期的 operationLogs 集合新增/修改文件）。既然筆數不會
 * 漂移，重新查一次並比對就是一次沒有實質效益、卻要付出全額讀取成本的檢查（大校可能是該
 * 學期紀錄數的 3 倍量級，見 §6.2 陷阱三）。operationLogs 的完整性只在「匯出」那一次性讀取
 * 中被保證（見 collectSemesterArchiveData），且 operationLogs 本來就不在刪除範圍內，
 * 不需要為了刪除去核對它。
 *
 * 也不含 private/detail 的批次讀取——「驗證」與「刪除前核對」都只需要確認 substituteRecords／
 * pendingRequests 這兩個集合的「有哪些文件」沒有變動，不需要重新組出完整內容（含私有明細）。
 */
async function fetchSemesterArchiveSnapshot(semesterId) {
    const [records, pendings, schedule] = await Promise.all([
        dataSvc.listSubstituteRecordsBySemesterForArchive(semesterId),
        dataSvc.listPendingRequestsBySemesterForArchive(semesterId),
        dataSvc.getScheduleForSemesterStrict(semesterId),
    ]);
    return {
        records, pendings, schedule,
        counts: {
            substituteRecords: records.length,
            pendingRequests:   pendings.length,
            hasSchedule:       !!schedule,
        },
    };
}

/** 比對兩份 counts 物件，回傳不一致的欄位名稱陣列（僅比對 fetchSemesterArchiveSnapshot() 的 3 個欄位，不含 operationLogs，理由見該函式）。 */
function diffArchiveCounts(a, b) {
    return ['substituteRecords', 'pendingRequests', 'hasSchedule']
        .filter(k => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

/**
 * Stage 5 驗收修復（阻斷2）：比對兩份 id 陣列所代表的「集合」是否完全相同（不只是長度相同）。
 * 筆數相同不代表內容相同——例如同一時間窗內「刪掉一筆舊的、新增一筆新的」，筆數不變但集合
 * 已經不同，只比對 `counts.substituteRecords` 這種長度式檢查會漏掉這種情況。
 */
function idSetsEqual(freshIds, exportIds) {
    if (!Array.isArray(freshIds) || !Array.isArray(exportIds)) return false;
    if (freshIds.length !== exportIds.length) return false;
    const exportSet = new Set(exportIds);
    return freshIds.every(id => exportSet.has(id));
}

/**
 * 執行「匯出」：讀取資料、組 JSON、計算雜湊、觸發下載，成功後把狀態記到 _archiveState
 * （phase='exported'，解鎖下方「驗證」UI）。讀取任一步失敗會直接拋出、不下載、不改動狀態
 * ——不留下「看起來匯出成功但其實資料不全」的半套狀態。
 */
async function runSemesterArchiveExport(semesterId, onProgress) {
    const { payload, counts, recordIds, reqIds, recordIdsWithDetail, reqIdsWithDetail } =
        await collectSemesterArchiveData(semesterId, onProgress);
    const me = roleSvc.getCurrentIdentity();
    payload.meta.exportedAt = new Date().toISOString();
    payload.meta.exportedBy = { uid: me?.uid || null, email: me?.email || null, name: me?.name || null, teacherId: me?.teacherId || null };

    onProgress?.('計算 SHA-256 雜湊…');
    const jsonText = JSON.stringify(payload, null, 2);
    const hash = await sha256Hex(jsonText);

    onProgress?.('觸發下載…');
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `STsystem_封存_${semesterId}_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    _archiveState = {
        semesterId, phase: 'exported', hash, counts, exportedAt: payload.meta.exportedAt,
        recordIds, reqIds, recordIdsWithDetail, reqIdsWithDetail,
    };
    return { hash, counts };
}

/**
 * 驗證使用者選取的檔案「就是」剛才匯出的那一份，且雲端當下的資料與匯出當下一致
 * （§6.2「雜湊驗證」+「筆數確認」，自動比對已下載檔）。任何一步不符都回傳失敗原因、
 * 不把 phase 推進到 'verified'（fail-closed：維持鎖住刪除區塊）。
 *
 * Stage 5 驗收修復（阻斷2）：不只比對筆數，額外比對 ID 集合是否完全相同（見 idSetsEqual()）
 * ——筆數相同不代表內容相同（同一時間窗內刪一筆、加一筆，筆數不變但集合已不同）。
 * @returns {Promise<{ok: true}|{ok: false, reason: string}>}
 */
async function verifyArchiveExportFile(semesterId, file) {
    // _archiveState.phase 存在時恆為 'exported' 或 'verified'（不會是其他值）——這裡只需確認
    // 有一份「屬於這個學期」的匯出狀態可供核對，重新驗證已通過驗證的狀態也應該被允許
    // （例如使用者不放心，想再核對一次）。
    if (!_archiveState || _archiveState.semesterId !== semesterId) {
        return { ok: false, reason: '尚未匯出此學期的資料，或選擇的學期已變更，請先重新匯出。' };
    }
    let text;
    try {
        text = await file.text();
    } catch (e) {
        return { ok: false, reason: `讀取檔案失敗：${e?.message || e}` };
    }

    const fileHash = await sha256Hex(text);
    if (fileHash !== _archiveState.hash) {
        return { ok: false, reason: '雜湊不符——這個檔案不是剛才匯出的那一份，或內容已被修改。請重新匯出並選擇正確的檔案。' };
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { ok: false, reason: `檔案不是合法的 JSON：${e?.message || e}` };
    }
    if (parsed?.meta?.semesterId !== semesterId) {
        return { ok: false, reason: `檔案內容的學期（${parsed?.meta?.semesterId}）與目前選擇的學期（${semesterId}）不符。` };
    }

    let snapshot;
    try {
        snapshot = await fetchSemesterArchiveSnapshot(semesterId);
    } catch (e) {
        return { ok: false, reason: `重新核對雲端資料失敗：${e?.message || e}` };
    }
    const countMismatches = diffArchiveCounts(snapshot.counts, _archiveState.counts);
    if (countMismatches.length) {
        return {
            ok: false,
            reason: `雲端資料在匯出後已變動（${countMismatches.join('、')}），為避免刪除到未被完整匯出的資料，請重新匯出後再試一次。`,
        };
    }
    const freshRecordIds = snapshot.records.map(r => r.recordId);
    const freshReqIds    = snapshot.pendings.map(p => p.reqId);
    if (!idSetsEqual(freshRecordIds, _archiveState.recordIds) || !idSetsEqual(freshReqIds, _archiveState.reqIds)) {
        return {
            ok: false,
            reason: '雲端資料的內容在匯出後已變動（筆數相同但實際項目不同），為避免刪除到未被完整匯出的資料，請重新匯出後再試一次。',
        };
    }

    _archiveState = { ..._archiveState, phase: 'verified', verifiedAt: new Date().toISOString() };
    return { ok: true };
}

/**
 * 實際執行刪除。呼叫前 UI 已保證 _archiveState.phase==='verified' 且使用者已在確認欄輸入
 * 正確的 semesterId（二次確認 modal 前的第一層），這裡仍從頭重新檢查一次每一個 gate
 * ——prompt 明訂「每一步都要 fail-closed」，不信任呼叫端已經檢查過。
 *
 * 刪除順序（§6.2 陷阱一）：substituteRecords／pendingRequests 各自「先刪 private/detail
 * 子文件、後刪父文件」（僅對確知有 detail 的紀錄送出 detail 刪除請求，見輕10），由
 * dataSvc.deleteSubstituteRecordsBatchKnownDetail()/deletePendingRequestsBatchKnownDetail()
 * 負責（writeBatch 依筆分塊，見 schoolDataService.js batchDeleteRefGroups()）；課表 doc
 * 最後刪除。刪除完成後、寫封存紀錄前，會再複查一次「這個學期是否真的清空了」（輕5，見下方
 * postDeleteSnapshot 區塊）——三項皆為空才寫 archives/{semesterId} 與操作日誌；任一項有
 * 殘留則整個中止、不寫紀錄。中途失敗（含這道複查沒通過）時 archives/{semesterId} 不會被
 * 寫入，使用者看到的錯誤訊息會指出目前狀態；正常的刪除失敗（例如網路中斷）可在重新匯出
 * 驗證後再次嘗試（此時已刪除的部分重新查詢會是 0 筆，不會重複刪除，也不會因為「已刪的
 * 東西找不到」而報錯——batch.delete() 對不存在的文件是 no-op，見 schoolDataService.js
 * 既有註解）；但輕5 的複查沒通過屬於需要人工介入的異常狀況，訊息已明確要求不要自動重試。
 */
async function executeSemesterArchiveDelete(semesterId) {
    // 最後一道防線：目前作用中學期一律不可被此流程刪除。
    // Stage 5 驗收修復（輕12）：改用 getConfigFromServer()（強制直讀伺服器、略過本機快取）
    // 取代 getConfig()——這是刪除前的最後一道防線，若還是可能命中本機快取的一般 getDoc()，
    // 防線本身就可能被同一個「看到過期狀態」的問題繞過，等於沒有真的加強保護。
    let freshConfig;
    try {
        freshConfig = await dataSvc.getConfigFromServer();
    } catch (e) {
        throw new Error(`無法確認目前作用中學期，為安全起見中止刪除（原始錯誤：${e?.message || e}）`);
    }
    const freshCurrent = freshConfig?.currentSemester;
    if (!freshCurrent) {
        throw new Error('無法確認目前作用中學期（config.currentSemester 未設定），為安全起見中止刪除。');
    }
    if (semesterId === freshCurrent) {
        throw new Error(`「${semesterId}」是目前作用中學期，不可封存刪除；如需刪除，請先在「學期管理」開新學期。`);
    }

    if (!_archiveState || _archiveState.semesterId !== semesterId || _archiveState.phase !== 'verified') {
        throw new Error('尚未完成「匯出」與「驗證」步驟，無法刪除。');
    }

    // Stage 5 驗收修復（阻斷2）：這是刪除前「唯一一次」重新核對，其回傳的 records/pendings
    // 陣列直接拿去執行刪除，不再另外查詢一次——消除「核對」與「實際被刪除的資料」之間的
    // 競態窗口（見 fetchSemesterArchiveSnapshot() 的完整說明）。除了筆數，也比對 ID 集合
    // 是否與匯出當下完全相同（不只是數量相同）。
    const snapshot = await fetchSemesterArchiveSnapshot(semesterId);
    const countMismatches = diffArchiveCounts(snapshot.counts, _archiveState.counts);
    const freshRecordIds  = snapshot.records.map(r => r.recordId);
    const freshReqIds     = snapshot.pendings.map(p => p.reqId);
    const idsMismatch = !idSetsEqual(freshRecordIds, _archiveState.recordIds)
                      || !idSetsEqual(freshReqIds, _archiveState.reqIds);
    if (countMismatches.length || idsMismatch) {
        _archiveState = { ..._archiveState, phase: 'exported' }; // 退回未驗證狀態，鎖住刪除、要求重新驗證
        throw new Error(
            `雲端資料在驗證後又發生變動${countMismatches.length ? `（${countMismatches.join('、')}）` : '（項目內容不同，筆數相同但實際 id 不同）'}，` +
            `為安全起見已中止，請重新驗證。`
        );
    }

    // 輕10：只對「匯出當下已知有 private/detail」的 id 送出 detail 刪除請求，避免對沒有
    // detail 的紀錄發送必然 no-op 的刪除。此刻 freshRecordIds/freshReqIds 已透過上面的
    // idSetsEqual() 檢查確認與 _archiveState.recordIds/reqIds 完全相同的集合，用
    // _archiveState 裡「匯出當下」記錄的 hasDetail 子集合來篩選是安全的。
    await dataSvc.deleteSubstituteRecordsBatchKnownDetail(freshRecordIds, _archiveState.recordIdsWithDetail);
    await dataSvc.deletePendingRequestsBatchKnownDetail(freshReqIds, _archiveState.reqIdsWithDetail);
    await dataSvc.deleteScheduleForSemester(semesterId);

    // Stage 5 驗收修復（輕5，opus 二輪驗收）：寫封存紀錄前，最後確認一次「這個學期真的清空
    // 了」。archives/{semesterId} 是 create-only、寫入後永久不可改/刪的紀錄（見
    // writeArchiveRecord() 中6 的說明）——若因為某種未預期原因（例如某個 batch 的 commit
    // 沒有拋出可觀察錯誤但實際部分失敗、或極端情況下的併發寫入）刪除後仍有殘留，絕不能讓
    // 這份「已完整封存」的紀錄被寫死；一旦寫入，之後任何人（含系統本身）都不會再意識到
    // 需要處理殘留資料——`writeArchiveRecord` 的 create-only 特性代表連事後補救都做不到。
    // 用同一支 fetchSemesterArchiveSnapshot() 複查，三項皆須為「空」才寫紀錄：
    // substituteRecords===0、pendingRequests===0、hasSchedule===false。任一項不符，
    // 中止並丟出明確錯誤，要求人工檢視（不自動重試——見下方錯誤訊息）。
    const postDeleteSnapshot = await fetchSemesterArchiveSnapshot(semesterId);
    if (postDeleteSnapshot.counts.substituteRecords !== 0
        || postDeleteSnapshot.counts.pendingRequests !== 0
        || postDeleteSnapshot.counts.hasSchedule !== false) {
        throw new Error(
            `刪除後複查發現「${semesterId}」仍有殘留資料` +
            `（調代課紀錄 ${postDeleteSnapshot.counts.substituteRecords} 筆、` +
            `待審請求 ${postDeleteSnapshot.counts.pendingRequests} 筆、` +
            `課表：${postDeleteSnapshot.counts.hasSchedule ? '仍存在' : '已刪除'}）。` +
            `為避免寫入誤導性的「已完整封存」紀錄，本次不會寫入 archives/${semesterId}，也不會計為封存成功。` +
            `請人工檢視雲端資料現況並手動清理殘留部分，確認乾淨後再重新執行「匯出→驗證→刪除」。`
        );
    }

    const me = roleSvc.getCurrentIdentity();
    await dataSvc.writeArchiveRecord(semesterId, {
        archivedAt: new Date().toISOString(),
        archivedBy: { uid: me?.uid || null, email: me?.email || null, name: me?.name || null, teacherId: me?.teacherId || null },
        counts: _archiveState.counts, // 含 operationLogs（資訊性欄位，取自匯出當下，非本次核對依據）
        jsonHash: _archiveState.hash,
        note: '操作日誌（operationLogs）不含在此次雲端刪除範圍內，需由系統管理者另行以離線腳本清除' +
              '（scripts/cleanup-operation-logs.js）；匯出檔已包含此學期完整操作日誌。',
    });
    await logger.log(LOG_ACTIONS.SEMESTER_ARCHIVE, LOG_TARGET_TYPES.SYSTEM, null, { semesterId, counts: _archiveState.counts });

    _archiveState = null;
    _v2KnownSemesterIds = null; // 學期選擇器快取失效（已刪除的學期課表 doc 不復存在，下次重繪重新查）
}

/**
 * 設定頁「資料封存」卡片，director 專用（同 renderSemesterAdminTab 的守門慣例）。
 * 渲染「匯出」區塊（任何學期皆可匯出，含目前學期，供一般備份用）與「刪除」區塊
 * （僅匯出成功後解鎖，且僅允許非目前學期）。
 *
 * Stage 5 驗收修復（輕7+8）：新增「此學期是否已封存過」的檢查（`dataSvc.getArchiveRecord()`）
 * ——已封存學期會停用匯出/刪除鈕、改顯示封存摘要。這同時解決了兩個問題：
 *   1. 學期選擇器現在會透過 `v2ListSemesterOptions()`（見該處修復）把 `archives/` 集合的
 *      學期 id 也併入選單，代表已封存學期不再從所有下拉選單「消失」，但雲端資料已被刪除，
 *      若沒有這個檢查，使用者選到已封存學期按「匯出」只會得到一份全空的 JSON（誤導），
 *      按「刪除」則會被 `writeArchiveRecord()` 的 create-only 規則擋下（見中6 的完整說明），
 *      使用者只會看到一個不明所以的 `permission-denied`。
 *   2. 提前在 UI 層擋下這條「注定失敗」的路徑，比讓使用者送出請求後才收到規則層拒絕更清楚。
 */
async function renderArchiveAdminTab() {
    const host = document.getElementById('v2-archive-admin');
    if (!host) return;
    if (!roleSvc.isDirector()) { host.innerHTML = ''; return; }

    const _gen = _v2IdentityGen;
    const options = await v2ListSemesterOptions();
    if (isStaleRender(_gen)) return;

    const cur = semesterState.getCurrentSemesterId();
    host.innerHTML = `
        <div class="data-management-section">
            <strong>匯出學期資料</strong>
            <p class="hint">選擇學期，匯出該學期完整資料（課表、調代課紀錄、待審請求、操作日誌，皆含私有明細）為單一 JSON 檔案下載。可作一般備份，或作為「封存刪除」的必要前置步驟；匯出本身不會刪除任何雲端資料。</p>
            <p class="hint" id="v2-archive-status" style="display:none;"></p>
            <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
                <select id="v2-archive-semester-select">
                    ${options.map(sid => `<option value="${escapeHtml(sid)}">${escapeHtml(sid)}${sid === cur ? '（目前學期）' : ''}</option>`).join('')}
                </select>
                <button class="btn btn-secondary btn-sm" id="v2-archive-export-btn">匯出此學期資料</button>
            </div>
            <p class="hint" id="v2-archive-progress" style="display:none;"></p>
        </div>
        <div class="data-management-section danger-zone" id="v2-archive-delete-section" style="display:none;">
            <strong>刪除此學期雲端資料（封存執行）</strong>
            <p class="hint" id="v2-archive-delete-hint"></p>
            <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
                <input type="file" id="v2-archive-verify-file" accept="application/json" style="display:none;">
                <button class="btn btn-secondary btn-sm" id="v2-archive-verify-btn">選擇剛下載的匯出檔進行驗證</button>
                <span class="hint" id="v2-archive-verify-status"></span>
            </div>
            <div id="v2-archive-delete-controls" style="display:none;margin-top:0.6rem;">
                <p class="hint" id="v2-archive-confirm-hint"></p>
                <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">
                    <input type="text" id="v2-archive-confirm-input" placeholder="輸入學期代碼確認">
                    <button class="btn btn-danger btn-sm" id="v2-archive-delete-btn" disabled>刪除此學期雲端資料</button>
                </div>
            </div>
        </div>
    `;

    const selectEl        = document.getElementById('v2-archive-semester-select');
    const exportBtn        = document.getElementById('v2-archive-export-btn');
    const progressEl       = document.getElementById('v2-archive-progress');
    const statusEl         = document.getElementById('v2-archive-status');
    const deleteSection    = document.getElementById('v2-archive-delete-section');
    const deleteHint       = document.getElementById('v2-archive-delete-hint');
    const verifyBtn        = document.getElementById('v2-archive-verify-btn');
    const verifyFileInput  = document.getElementById('v2-archive-verify-file');
    const verifyStatus     = document.getElementById('v2-archive-verify-status');
    const deleteControls   = document.getElementById('v2-archive-delete-controls');
    const confirmHint       = document.getElementById('v2-archive-confirm-hint');
    const confirmInput      = document.getElementById('v2-archive-confirm-input');
    const deleteBtn         = document.getElementById('v2-archive-delete-btn');

    /** 換學期或任何一步失敗，回到「尚未驗證」的畫面（不清 _archiveState 本身，由呼叫端決定）。 */
    function resetDownstreamUi() {
        verifyStatus.textContent = '';
        deleteControls.style.display = 'none';
        confirmInput.value = '';
        deleteBtn.disabled = true;
    }

    // 防止使用者連續切換學期選單時，較慢的舊一輪 getArchiveRecord() 查詢在較新一輪之後才
    // 回來、用過期結果覆蓋畫面（比照全檔既有 _v2IdentityGen/isStaleRender 的世代守門慣例，
    // 這裡用局部變數即可，不需要掛到 module 層級——每次 renderArchiveAdminTab() 重繪都是
    // 全新的閉包）。
    let _selectionGen = 0;

    /**
     * 依目前選擇的學期，決定「匯出」「刪除」兩個區塊的可用狀態：
     *   - 目前作用中學期：只能匯出，不顯示刪除區塊（既有規則，未變動）。
     *   - 已封存過的學期（輕7+8 新增）：匯出與刪除都停用，顯示封存摘要。
     *   - 其餘（非目前學期、未封存過）：匯出可用；刪除區塊依 _archiveState 是否已有
     *     這個學期的匯出結果決定是否顯示（既有邏輯，未變動）。
     */
    async function syncArchiveSectionState() {
        const sid = selectEl.value;
        const myGen = ++_selectionGen;
        resetDownstreamUi();
        statusEl.style.display = 'none';
        exportBtn.disabled = false;

        if (sid === cur) {
            deleteSection.style.display = 'none';
            return;
        }

        let archived = null;
        let archiveCheckFailed = false;
        try {
            archived = await dataSvc.getArchiveRecord(sid);
        } catch (e) {
            console.warn('[V2] 查詢封存紀錄失敗：', e);
            archiveCheckFailed = true;
        }
        if (myGen !== _selectionGen) return; // 選擇已經換過，這輪結果過期，不套用到畫面

        if (archiveCheckFailed) {
            // 查詢失敗時不假設「沒有封存過」，但也不假設「已經封存過」——維持匯出鈕可用、
            // 隱藏刪除區塊（刪除本來就需要先過匯出/驗證兩關，這裡不主動解鎖任何東西），
            // 只顯示提示讓使用者知道這個狀態未經確認，需要的話可以重新整理再試。
            deleteSection.style.display = 'none';
            statusEl.style.display = '';
            statusEl.textContent = '無法確認此學期是否已封存過，請重新整理頁面後再試。';
            return;
        }

        if (archived) {
            exportBtn.disabled = true;
            deleteSection.style.display = 'none';
            statusEl.style.display = '';
            statusEl.textContent =
                `此學期已於 ${archived.archivedAt || '（時間未知）'} 封存並從雲端刪除` +
                `（調代課紀錄 ${archived.counts?.substituteRecords ?? '?'} 筆、` +
                `待審請求 ${archived.counts?.pendingRequests ?? '?'} 筆）。` +
                `雲端資料已不存在，無法再次匯出或刪除；封存當時的完整資料僅存在於當初下載的 JSON 檔案中。`;
            return;
        }

        const hasExport = _archiveState && _archiveState.semesterId === sid;
        deleteSection.style.display = hasExport ? '' : 'none';
        if (hasExport) {
            deleteHint.textContent =
                `已於 ${_archiveState.exportedAt} 匯出「${sid}」（調代課紀錄 ${_archiveState.counts.substituteRecords} 筆、` +
                `待審請求 ${_archiveState.counts.pendingRequests} 筆、操作日誌 ${_archiveState.counts.operationLogs} 筆、` +
                `課表：${_archiveState.counts.hasSchedule ? '有' : '無'}）。請選擇剛下載的檔案進行驗證後才能刪除。` +
                `操作日誌不會被刪除，需由系統管理者另行離線清除，匯出檔已包含完整日誌。`;
        }
    }

    selectEl.addEventListener('change', syncArchiveSectionState);

    exportBtn.addEventListener('click', async () => {
        const sid = selectEl.value;
        if (!sid || exportBtn.disabled) return;
        // 防禦：即使 UI 已鎖住，執行前再核一次「是否已封存過」（比照全檔既有「UI 隱藏 +
        // 執行前再驗一次」慣例），避免透過 console 直接呼叫繞過 disabled 屬性觸發匯出。
        try {
            const archived = await dataSvc.getArchiveRecord(sid);
            if (archived) {
                notify('此學期已封存過，雲端資料已不存在，無法再次匯出。', 'warning');
                await syncArchiveSectionState();
                return;
            }
        } catch (e) {
            notify('無法確認此學期是否已封存過，為安全起見中止匯出，請稍後再試。', 'error');
            return;
        }

        exportBtn.disabled = true;
        progressEl.style.display = '';
        progressEl.textContent = '準備匯出…';
        try {
            await runSemesterArchiveExport(sid, (msg) => { progressEl.textContent = msg; });
            progressEl.textContent = `匯出完成，已觸發下載（${_archiveState.counts.substituteRecords + _archiveState.counts.pendingRequests + _archiveState.counts.operationLogs} 筆資料）。`;
            notify(`已匯出「${sid}」的完整資料`, 'success');
            // 交給 syncArchiveSectionState() 決定 exportBtn 最終應該是什麼狀態（正常情況下
            // 維持可用，允許使用者需要時重新匯出）——不在這裡用 finally 無條件解鎖，避免
            // 蓋掉上面呼叫可能設定的「已封存、應停用」狀態（理論上不會在這個時間點發生，
            // 但沿用同一套決策入口比自己在兩個地方各判斷一次可靠）。
            await syncArchiveSectionState();
        } catch (e) {
            console.error('[V2] 學期資料匯出失敗:', e);
            notifyError(e, '匯出學期資料');
            progressEl.textContent = `匯出失敗：${e?.message || e}`;
            exportBtn.disabled = false;
        }
    });

    verifyBtn.addEventListener('click', () => verifyFileInput.click());

    verifyFileInput.addEventListener('change', async () => {
        const file = verifyFileInput.files?.[0];
        verifyFileInput.value = ''; // 允許重選同一個檔案也能再次觸發 change
        if (!file) return;
        const sid = selectEl.value;
        verifyBtn.disabled = true;
        verifyStatus.textContent = '驗證中…';
        try {
            const result = await verifyArchiveExportFile(sid, file);
            if (!result.ok) {
                verifyStatus.textContent = `驗證失敗：${result.reason}`;
                notify(result.reason, 'error', 8000);
                deleteControls.style.display = 'none';
                return;
            }
            verifyStatus.textContent = '驗證通過。';
            confirmHint.textContent = `請在下方輸入學期代碼「${sid}」以解鎖刪除按鈕：`;
            deleteControls.style.display = '';
            notify('驗證通過，可以繼續刪除', 'success');
        } catch (e) {
            console.error('[V2] 匯出檔驗證失敗:', e);
            verifyStatus.textContent = `驗證失敗：${e?.message || e}`;
            notifyError(e, '驗證匯出檔');
        } finally {
            verifyBtn.disabled = false;
        }
    });

    confirmInput.addEventListener('input', () => {
        const sid = selectEl.value;
        const verified = _archiveState && _archiveState.semesterId === sid && _archiveState.phase === 'verified';
        deleteBtn.disabled = !(verified && confirmInput.value.trim() === sid);
    });

    deleteBtn.addEventListener('click', async () => {
        const sid = selectEl.value;
        if (confirmInput.value.trim() !== sid) {
            notify('輸入的學期代碼與目前選擇的學期不符', 'warning');
            return;
        }
        const ok = await window.app?.confirmDialog?.({
            title: '刪除學期雲端資料',
            message:
                `確定要永久刪除「${sid}」的雲端資料嗎？\n\n` +
                `將刪除：課表、調代課紀錄（含私有明細）${_archiveState.counts.substituteRecords} 筆、` +
                `待審請求（含私有明細）${_archiveState.counts.pendingRequests} 筆。\n` +
                `不會刪除：操作日誌（需由系統管理者另行離線清除）、教師名冊、其他學期的任何資料。\n\n` +
                `此操作無法復原！請確認你已妥善保存剛才下載的匯出檔案。`,
            confirmText: '確認刪除',
            danger: true,
        });
        if (!ok) return;

        deleteBtn.disabled = true;
        const dismiss = window.app?.showToast?.('刪除中，請稍候…', 'warning', 60000);
        try {
            await executeSemesterArchiveDelete(sid);
            dismiss?.();
            notify(`「${sid}」已封存並從雲端刪除`, 'success', 6000);
            await renderArchiveAdminTab();
        } catch (e) {
            dismiss?.();
            console.error('[V2] 封存刪除失敗:', e);
            notifyError(e, '封存刪除');
            // executeSemesterArchiveDelete() 偵測到刪除前筆數漂移時，會把 _archiveState.phase
            // 退回 'exported'（鎖住刪除、要求重新驗證）；其餘失敗原因（例如目前學期改變、
            // config 讀取失敗）不會動到 _archiveState。兩種情況都改用 syncArchiveSectionState()
            // 依 _archiveState 目前真實狀態重繪，而不是手動猜測該清空哪些欄位——避免遺漏
            // 「畫面看起來像可以繼續、但其實已經被鎖住」這種畫面與狀態不一致的殘留。
            await syncArchiveSectionState();
        }
    });

    await syncArchiveSectionState();
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
            if (tab === 'settings') {
                await renderSemesterAdminTab();
                await renderArchiveAdminTab();
            }
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
// Stage 1 起：教師純前端過濾（同 Phase 5）；起訖日改為下推到 Firestore 查詢
// （v2GetRecordsInRange，見 renderRecordsTab），不再是純前端過濾——資料來源已改用有界的
// 即時訂閱視窗，前端手上不再有「全部歷史」可以純過濾。
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
const V2_IDENTITY_CONTENT_HOSTS = ['v2-teachers-admin', 'v2-logs', 'v2-pending-list', 'v2-records-section', 'v2-semester-admin', 'v2-archive-admin'];

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
    // Stage 1：分頁狀態與日期範圍查詢快取同屬「含個資的畫面狀態」，身份切換必須一併清空，
    // 否則前一身份載入的較舊紀錄／範圍查詢結果會殘留給下一個登入者看到。
    _v2RecordsTabExtra    = [];
    _v2RecordsTabCursor   = null;
    _v2RecordsTabHasMore  = null;
    _v2RecordsLiveLastDoc = null;
    _v2DateRangeQueryCache.clear();
    _v2PendingSourceError = null; // 驗收修復（中 #A）：不帶前一身份的錯誤狀態到下一個登入者
    // Stage 2：歷史學期檢視狀態同屬「含個資的畫面狀態」，身份切換必須一併清空（同上理由）。
    _v2RecordsSemesterFilter = '';
    _v2SemesterHistoryCache.clear();
    _v2KnownSemesterIds = null;
    // Stage 5：封存流程的匯出/驗證狀態同屬「含個資的畫面狀態」（雜湊/筆數綁定特定一次匯出），
    // 身份切換一律清空——不同 director 不該沿用前一位的匯出狀態解鎖刪除按鈕。
    _archiveState = null;
    resetSyncStatus();
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
// Stage 1（讀取成本止血）起，_v2RecordsCache 不再是「全校全部歷史紀錄」，而是即時訂閱視窗
// （最近 V2_RECORDS_PAGE_SIZE 筆，見 schoolDataService.subscribeSubstituteRecords）。
let _v2RecordsCache = [];
let _v2PendingCache = [];
// 驗收修復（中 #A）：subscribePendingRequests 的即時訂閱與 bootstrap 的 prefill
// （listOpenPendingRequests）是「待我同意/待我審核」唯二的資料來源；若兩者同時失敗，
// _v2PendingCache 會停在初始值 `[]`，renderPendingTab 若只看陣列長度會誤判成「真的沒有
// 待辦」而顯示「目前沒有…」——這是假陰性，不是「目前沒有」。這個旗標記錄「目前是否已知
// 讀取失敗」：非 null（存的是 Error）時，renderPendingTab 改顯示錯誤卡片，不顯示空狀態文字。
// 任一資料源成功回來即清為 null。身份切換/登出時一併歸零（見 resetV2ViewState／登出分支）。
let _v2PendingSourceError = null;

// Stage 1（RESEARCH-multitenancy-semester.md §5.4）：即時訂閱與分頁讀取的頁面大小，
// 報告未給明確數字時的預設值。與 schoolDataService.js 的 DEFAULT_PAGE_SIZE 保持一致
// （兩處各自定義是刻意的：schoolDataService 不該依賴呼叫端的模組層常數，這裡的值只要
// 「與訂閱視窗一致」即可，用來判斷「目前視窗是否已滿」）。
const V2_RECORDS_PAGE_SIZE = 50;

// Stage 1：紀錄頁「載入更多」分頁狀態——使用者按過的較舊分頁（記憶體，不落地，身份切換
// 或登出時清空，見 resetV2ViewState／登出分支）。
let _v2RecordsTabExtra    = [];   // 額外載入的較舊紀錄（已補過 detail）
// 驗收修復（輕 #10）：cursor 改存原生 QueryDocumentSnapshot（不是值），避免 createdAt
// 完全相同（同毫秒建立）時純值游標漏掉/重複同值的其中一筆。
let _v2RecordsTabCursor   = null; // 下一頁的 cursor（QueryDocumentSnapshot 或 null）
let _v2RecordsTabHasMore  = null; // null＝尚未按過「載入更多」，依 _v2RecordsCache 是否滿頁推算
// 即時訂閱最新一次快照的最後一筆 QueryDocumentSnapshot，供「載入更多」第一次點擊時當作
// 銜接視窗尾端的原生 cursor（見 loadMoreRecordsTabPage）。由 subscribeSubstituteRecords
// 的 callback 第二參數持續更新，身份切換/登出時一併歸零。
let _v2RecordsLiveLastDoc = null;

// Stage 1（§5.6）：月結算／週彙整 PDF／紀錄頁日期篩選這類「明確帶日期範圍」的查詢結果
// 記憶體快取，key 為 `${startDate}|${endDate}`。範圍查詢一律「按需一次性 getDocs」，不猜測
// 即時訂閱視窗是否已涵蓋整段範圍（視窗按 createdAt 排序，無法用「視窗內最舊日期」可靠推算
// 涵蓋範圍，寧可多查一次 Firestore 也不要讓月結算這種金額計算漏資料）。
const _v2DateRangeQueryCache = new Map();

// Stage 2（§5.4「歷史學期」列，§6.1）：紀錄頁的學期選擇器狀態。''＝當前學期（即時訂閱＋
// 分頁，既有 Stage 1 行為不變）；非空字串＝使用者選了某個歷史學期，改走一次性查詢
// （見 v2GetRecordsBySemester）。跨 renderRecordsTab 重繪需持續保留使用者的選擇，故拉到
// module 層級，比照既有的 _v2RecordsLegacyFilter/_v2RecordsFilterStart 等篩選狀態。
let _v2RecordsSemesterFilter = '';
// 歷史學期查詢結果的記憶體快取，key 為 semesterId——歷史學期在規則層已鎖唯讀，同一 session
// 內查過一次的結果不會再變動，不需要每次切換回同一個歷史學期都重打 Firestore。
const _v2SemesterHistoryCache = new Map();
// 學期選擇器下拉選單的選項清單快取（dataSvc.listKnownSemesterIds() 的結果），null 表示
// 尚未查過。這份清單變動頻率極低（只有「開新學期」會新增一筆），不需要每次重繪都重查。
let _v2KnownSemesterIds = null;

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

/**
 * Stage 1（讀取成本止血，§5.6）：依日期範圍向 Firestore 做一次性查詢，供月結算／週彙整
 * PDF／紀錄頁日期篩選使用。查詢結果以 `${startDate}|${endDate}` 快取在記憶體，同一 session
 * 內對同一範圍重複呼叫（例如使用者切換「僅顯示有變動」勾選框，或重新點一次同一個月份）不會
 * 重打 Firestore。快取在身份切換／登出時清空（見 resetV2ViewState）。
 * @returns {Promise<Array>} 已補齊 private/detail 的紀錄陣列
 */
async function v2GetRecordsInRange(startDate, endDate) {
    const key = `${startDate || ''}|${endDate || ''}`;
    if (_v2DateRangeQueryCache.has(key)) return _v2DateRangeQueryCache.get(key);
    const raw = await dataSvc.queryRecordsByDateRange({ startDate: startDate || null, endDate: endDate || null });
    const hydrated = await hydrateRecordsWithDetail(raw);
    _v2DateRangeQueryCache.set(key, hydrated);
    return hydrated;
}

/**
 * Stage 2（§5.4「歷史學期」列）：紀錄頁選了某個歷史學期時，一次性查詢該學期全部已成立
 * 紀錄並快取（_v2SemesterHistoryCache，見宣告處註解）。與 v2GetRecordsInRange 同構，差別
 * 只在資料來源改用 listSubstituteRecordsBySemester（依 semesterId 查，非日期範圍）。
 */
async function v2GetRecordsBySemester(semesterId) {
    if (!semesterId) return [];
    if (_v2SemesterHistoryCache.has(semesterId)) return _v2SemesterHistoryCache.get(semesterId);
    const raw = await dataSvc.listSubstituteRecordsBySemester(semesterId);
    const hydrated = await hydrateRecordsWithDetail(raw);
    _v2SemesterHistoryCache.set(semesterId, hydrated);
    return hydrated;
}

/**
 * Stage 2：學期選擇器下拉選單的選項清單，含快取（見 _v2KnownSemesterIds 宣告處註解）。
 * 一定包含「目前學期」（即使 schedules/{目前學期} 因某些原因尚未建立文件——例如「開新學期」
 * 那次 batch 寫入失敗一半，仍要讓使用者選得到自己現在所在的學期），其餘依
 * semesterUtils.compareSemesterId 由新到舊排序。
 *
 * Stage 5 驗收修復（輕7+8）：併入 `dataSvc.listArchivedSemesterIds()`（archives/ 集合的
 * 學期 id）。封存刪除會把 schedules/{semesterId} 一併刪除，若只看 listKnownSemesterIds()
 * （schedules/ 集合），已封存學期會在刪除完成的瞬間從所有下拉選單裡「消失」——不只是封存頁
 * 自己選不到，連 director 想確認「這學期封存紀錄長怎樣」都無路可去。併入後，已封存學期
 * 仍會出現在選單中，由 renderArchiveAdminTab() 依 `getArchiveRecord()` 判斷並顯示封存摘要、
 * 停用匯出/刪除鈕（見該函式）。
 */
async function v2ListSemesterOptions() {
    if (_v2KnownSemesterIds) return _v2KnownSemesterIds;
    let known = [];
    try {
        known = await dataSvc.listKnownSemesterIds();
    } catch (e) {
        console.warn('[V2] 讀取已知學期清單失敗：', e);
    }
    let archived = [];
    try {
        archived = await dataSvc.listArchivedSemesterIds();
    } catch (e) {
        console.warn('[V2] 讀取已封存學期清單失敗：', e);
    }
    const cur = semesterState.getCurrentSemesterId();
    const all = new Set([...known, ...archived]);
    if (cur) all.add(cur);
    _v2KnownSemesterIds = [...all].sort((a, b) => semesterUtils.compareSemesterId(b, a));
    return _v2KnownSemesterIds;
}

/**
 * Stage 1：紀錄頁「載入更多」——從目前已載入資料的尾端（即時視窗或上一次載入更多的
 * 最後一筆）接續讀下一頁。呼叫端（renderRecordsTab）負責在「無日期篩選」狀態下才顯示
 * 對應按鈕；有日期篩選時走 v2GetRecordsInRange()，不需要分頁。
 */
async function loadMoreRecordsTabPage() {
    // 驗收修復（輕 #10）：優先用上一次「載入更多」留下的原生 cursor；第一次點擊時退而
    // 用即時訂閱最新快照的 lastDoc（_v2RecordsLiveLastDoc，同樣是原生 QueryDocumentSnapshot，
    // 不是從 _v2RecordsCache 陣列裡萃取欄位值組出來的值游標）。
    const cursor = _v2RecordsTabCursor ?? _v2RecordsLiveLastDoc ?? null;
    const { records: nextPage, nextCursor, hasMore } =
        await dataSvc.listSubstituteRecordsPage({ pageSize: V2_RECORDS_PAGE_SIZE, afterCursor: cursor });
    const hydrated = await hydrateRecordsWithDetail(nextPage);
    _v2RecordsTabExtra   = _v2RecordsTabExtra.concat(hydrated);
    _v2RecordsTabCursor  = nextCursor;
    _v2RecordsTabHasMore = hasMore;
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
 * 兩者都仍算「尚未定案、應擋下重複申請」；只有 approved（已轉入 substituteRecords）與
 * rejected（已無效）才不算衝突。
 * 回傳與 dataManager.checkExistingRecord 相容的紀錄物件，或 null。
 *
 * 驗收修復（阻斷 #1）：改為 async 按需查詢，不再只看 _v2RecordsCache（即時訂閱視窗，
 * 最近 V2_RECORDS_PAGE_SIZE 筆）。原本的實作只要一筆衝突紀錄是「2 週前建立」（因而落在
 * 視窗外），就會完全漏檢——使用者可以對同一節課重複建檔，月結算也會重複計費，是正確性
 * bug，不是效能取捨。改用 queryRecordsByExactDate(date) 對「目標日期」單欄位相等查詢
 * （自動索引，不需複合索引），period/className/originalTeacher 交給呼叫端在記憶體比對
 * （單日筆數天生有界，成本可忽略）。pendingRequests 同法：雖然 _v2PendingCache 本身已是
 * 「只含仍在途請求、無筆數上限」的訂閱（理論上不受視窗截斷影響），但改成顯式按日期查詢
 * 一方面與 substituteRecords 檢查邏輯一致，一方面不依賴「_v2PendingCache 未來也不會被加上
 * limit」這個隱性假設——這個假設一旦被日後的改動打破，衝堂檢查會用同樣的方式悄悄壞掉。
 */
async function v2CheckExistingRecord(date, period, className, originalTeacher) {
    if (!date) return null;
    const args = [date, period, className, originalTeacher];
    const [dayRecords, dayPending] = await Promise.all([
        dataSvc.queryRecordsByExactDate(date),
        dataSvc.queryPendingRequestsByExactDate(date),
    ]);
    const r = dayRecords.find(x => conflictMatches(x, ...args));
    if (r) return r;
    const p = dayPending
        .map(requestSvc.normalizeLegacyRequest)
        .find(x => {
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
 * 把全校課表快照（Stage 2 起為 schools/{schoolId}/schedules/{semesterId}，見
 * dataSvc.subscribeSchedule）套用到本機 dataManager 並刷新 UI。
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
            await dataSvc.saveSchedule(semesterState.getCurrentSemesterId(), {
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
                    // 驗收修復（中 #4）：同上（adminDeleteRecord），寫入的紀錄不論是直接成立
                    // 或先進 pendingRequests，都可能讓已快取的日期範圍查詢結果過期。
                    _v2DateRangeQueryCache.clear();
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

    // 衝堂檢查：V2 下改按需查 Firestore（見 v2CheckExistingRecord 註解，阻斷 #1）。
    // 驗收修復（阻斷 #1）：v2CheckExistingRecord 已改 async，這裡的 patch 隨之 async 化；
    // origCheck（V1 離線模式）維持同步不動——`await 同步值` 在 JS 中會直接被包成已解決的
    // Promise，呼叫端一律 `await dm.checkExistingRecord(...)` 對兩種模式都正確。
    const origCheck = typeof dm.checkExistingRecord === 'function'
        ? dm.checkExistingRecord.bind(dm) : null;
    dm.checkExistingRecord = async function(date, period, className, originalTeacher) {
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
     *      下方）——並未透過這個方法取資料，而是自行組合 _v2RecordsCache／載入更多分頁／日期
     *      範圍查詢後再套 roleSvc.filterRecordsForCurrent()（Stage 1 起，見該函式），不受這裡
     *      影響，過濾行為仍然存在。
     *   4. 月結算頁籤已於 commit 5ec4561 加上 .v2-approver-only，一般教師連分頁都進不去，不會
     *      經由 generateSettlement() / exportSettlementExcel() 間接看到全校結算。
     * 回傳的是**複本**而非 _v2RecordsCache 本身：該陣列同時是衝堂檢查（v2CheckExistingRecord）
     * 的資料源，若把內部參考交出去，下游任何 .sort() / .splice() 都會就地汙染即時同步快取，
     * 變成極難追查的偶發衝堂誤判。原實作（dataManager.js:486）也是回傳 [...] 複本。
     *
     * (startDate, endDate, teacherFilter) 三個篩選參數比照原實作套用，排序也比照原實作
     * 「日期新到舊」——dataManager.getMonthlyRecords() 內部就是帶日期參數呼叫本方法，
     * 若在此靜默忽略參數，那條路徑會拿到全部紀錄而完全沒有錯誤訊號。
     *
     * ⚠️ Stage 1（讀取成本止血）起，_v2RecordsCache 只是即時訂閱視窗（最近
     * V2_RECORDS_PAGE_SIZE 筆，見 schoolDataService.subscribeSubstituteRecords），不再是全校
     * 全部歷史紀錄。這支方法維持同步（V1 呼叫慣例、大量既有呼叫端不宜整批改 async），故
     * startDate/endDate 若落在視窗之外只會靜默回傳「視窗內符合條件」的子集，不是完整結果。
     * 目前實際呼叫端只有 showRecommendations()（app.js，不帶日期，只需要「近期」資料，視窗
     * 內即可正確運作）。月結算／週彙整 PDF 這類「明確帶日期範圍、且範圍可能是任意過去月份」
     * 的呼叫端，一律改用下方新增的 dm.getSubstituteRecordsAsync()，不要用這支傳日期範圍。
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
     * Stage 1（讀取成本止血，§5.6）：getSubstituteRecords() 的非同步版本，供月結算／
     * 週彙整 PDF 這類「明確帶日期範圍、範圍可能落在即時訂閱視窗之外」的呼叫端使用。
     * 無日期範圍時直接複用同步版本（等同讀 _v2RecordsCache 視窗，不必多打 Firestore）；
     * 有日期範圍時一律透過 v2GetRecordsInRange() 按需查詢（內建記憶體快取，同一範圍
     * 不會重複打 Firestore），teacherFilter／排序邏輯與同步版本一致。
     */
    // 驗收修復（輕 #11）：startDate/endDate 這裡不經 dm.normalizeDate() 正規化——
    // v2GetRecordsInRange() 直接把這兩個值原樣送進 Firestore 的 where('date', '>='/'<=' , ...)
    // range query 做字典序比對，比對對象是 Firestore 裡的 `date` 欄位本身（一律已是
    // YYYY-MM-DD）。呼叫端必須確保傳入值也是 YYYY-MM-DD（settlementCalculator.getMonthDateRange()
    // 與 pdfGenerator.getWeekRange() 皆已是此格式），傳入其他格式（例如 MM/DD/YYYY）會讓字典序
    // 比對得出錯誤結果且不會拋錯，需呼叫端自行保證，這裡不做防禦性轉換。
    dm.getSubstituteRecordsAsync = async function(startDate = '', endDate = '', teacherFilter = '') {
        if (!roleSvc.isSignedIn()) {
            return origGet(startDate, endDate, teacherFilter);
        }
        if (!startDate && !endDate) {
            return dm.getSubstituteRecords(startDate, endDate, teacherFilter);
        }
        let records = await v2GetRecordsInRange(startDate, endDate);
        if (teacherFilter) {
            records = records.filter(r =>
                r.originalTeacher === teacherFilter || r.substituteTeacher === teacherFilter);
        }
        records = [...records].sort((a, b) => new Date(b.date) - new Date(a.date));
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
 *
 * Stage 2 取捨：課表歸零只處理「目前學期」那一份 schedules/{currentSemester} 文件——
 * 舊版本這裡只曾經處理過單一一份 schedule doc（P2 全校課表共享的既有語意本來就只有一份），
 * 多學期化後延續同一個範圍，不擴大成「刪除全部歷史學期課表」這個新行為（清除工具的破壞
 * 範圍不該在沒有被明確要求的情況下無預警擴大）。substituteRecords／pendingRequests 仍維持
 * 既有語意：清空全部學期（不限「目前學期」），與 rules 的刪除權限（director 不受學期唯讀
 * 鎖限制，見 firestore.rules substituteRecords/pendingRequests 的 delete 規則）一致。
 */
async function clearAllSchoolData() {
    const currentSemesterId = semesterState.getCurrentSemesterId();
    // 1) 目前學期課表歸零。schoolName 沿用雲端現值（歸零不等於學校改名／需要重新設定）。
    //    getSchedule() 讀取失敗（網路瞬斷、權限問題等）刻意不 catch：此時尚未寫入任何東西，
    //    直接中止最安全；若吞成 null 會把讀取失敗誤判為「雲端本來就沒有課表」，用空字串
    //    覆蓋掉雲端現有 schoolName，讓一般教師端卡在「請先設定學校名稱」（驗收缺陷 #3）。
    const cloudSchedule = await dataSvc.getSchedule(currentSemesterId);
    const me = roleSvc.getCurrentIdentity();
    await dataSvc.saveSchedule(currentSemesterId, {
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

        // 驗收修復（輕 8）：如實描述清除範圍——Stage 2 課表 per-semester 化後，這裡只清「目前
        // 學期」那一份 schedules/{cur} 文件（見 clearAllSchoolData() 的取捨說明），不是「全部
        // 課表」；調代課紀錄與待審請求則不分學期、全部清除（沿用既有語意）；舊版單一課表文件
        // data/schedule 完全不受這個按鈕影響（它已不再被任何寫入路徑使用，只留作讀取
        // fallback）。文案含糊會讓 director 誤以為歷史學期課表也會被清掉，或誤以為舊版課表
        // 副本會被連帶清除，兩者都不是事實。
        const curSid = semesterState.getCurrentSemesterId() || '（尚未確定）';
        const firstOk = await this.confirmDialog({
            title: '清除所有資料',
            message:
                `將清除全校雲端資料：\n` +
                `・課表：僅「目前學期（${curSid}）」的課表會被歸零，其他學期的課表不受影響\n` +
                `・調代課紀錄與待審請求：所有學期的資料都會被清除（不分學期）\n\n` +
                `舊版課表副本（data/schedule，Stage 2 之前的單一文件）不受此操作影響。\n\n` +
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
            message: `再次確認：清除「${curSid}」的課表、以及所有學期的調代課紀錄與待審請求？此操作無法復原。`,
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

/**
 * 驗收修復（阻斷 #3）：bootstrap 的 onAuthStateChange 回呼裡，`resolveIdentity()` 之後的
 * 每一步（初次渲染各頁籤、建立即時訂閱、prefill cache）都被同一個外層 try/catch 包住——
 * 外層 catch 的原始設計意圖是「身份解析本身失敗」時鎖住整個 app（_v2GateError +
 * lockV2App()），但同一個 catch 也會接住「身份已經解析成功、只是某個非必要的渲染或查詢
 * 失敗」（例如 listPendingRequestsByInitiator 需要的複合索引還沒部署），結果是把「一個
 * 頁籤的一個區塊讀取失敗」升級成「全站鎖死」。實測已證實會發生。
 *
 * 這個 wrapper 讓身份解析「之後」的每一步各自獨立失敗、降級，不冒泡到外層致命 catch：
 * 失敗只記錄 console + notifyError 提示，回傳 null，讓 bootstrap 繼續往下跑其他步驟。
 * 身份解析本身（authGuard.resolveIdentity 那一段）刻意不套這支 wrapper，維持原本「解析
 * 失敗就鎖住」的行為——那是這個外層 catch 唯一還該負責的事。
 */
async function safeBootstrapStep(label, fn) {
    try {
        return await fn();
    } catch (err) {
        console.error(`[v2] bootstrap 步驟「${label}」失敗（已降級，不影響其他功能）:`, err);
        notifyError(err, label);
        return null;
    }
}

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
            // Stage 1：同上，分頁狀態與日期範圍查詢快取一併清空（見 resetV2ViewState 註解）。
            _v2RecordsTabExtra    = [];
            _v2RecordsTabCursor   = null;
            _v2RecordsTabHasMore  = null;
            _v2RecordsLiveLastDoc = null;
            _v2DateRangeQueryCache.clear();
            _v2PendingSourceError = null; // 驗收修復（中 #A）：同上
            resetSyncStatus();
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

            // Stage 2（RESEARCH-multitenancy-semester.md §5/§8 Stage 2）：學期成為一級概念，
            // 每次身份解析成功後讀一次 config.currentSemester 並寫入 semesterState 快取，供本
            // session 內所有寫入/查詢路徑取用（見 semesterState.js 檔頭註解）。必須排在下面
            // 「初次渲染」與「即時同步」之前——兩者都依賴這個值（前者的 renderRecordsTab 用它
            // 判斷「目前學期」、後者的 subscribeSubstituteRecords 等函式預設參數讀它）。
            // fallback 取捨：報告 §8 Stage 2 一列沒有明確指定 config.currentSemester 缺席時的
            // 行為，本次實作選擇「依今天日期推算台灣學期」（semesterUtils.todaySemesterId()）
            // ——這是唯一不需要人工介入就能讓系統維持可用的辦法（不推算的話，所有新寫入與
            // 學期範圍查詢都會因為沒有學期可用而失敗）。代價：推算值可能與 director 心裡認定
            // 的「目前學期」不同步（例如剛過寒假但還沒手動開新學期）；發生這種情況時 director
            // 應盡快到「學校設定 → 學期管理」確認/更正目前學期。
            // 驗收修復（中 7，訂正過度樂觀的降級宣稱）：若這一步整段失敗（極端邊界情況——
            // 下方 try/catch 只包了 getConfig()，semesterUtils.todaySemesterId() 是純日期運算
            // 幾乎不可能拋錯，故 semesterState 實務上幾乎必定會被設成某個值；但仍需誠實列出
            // 「萬一」semesterState 停在初始值 null 時，各條路徑的實際行為，不能籠統宣稱
            // 「優雅退化」——降級程度依功能而異，不是全面優雅：
            //   - 讀取/查詢類（subscribeSubstituteRecords／subscribePendingRequests／
            //     listOpenPendingRequests／listSubstituteRecordsPage）：內部用
            //     `if (semesterId) constraints.unshift(...)`，semesterId 為 null 時該條件
            //     直接不加，等同退化成 Stage 1 的無學期篩選查詢——這幾支*確實*優雅可用。
            //   - 課表（getSchedule／saveSchedule／subscribeSchedule）：**不可用**，semesterId
            //     缺席時直接拋出明確錯誤（requireScheduleSemesterId()，見 schoolDataService.js）
            //     ——per-semester 化後 semesterId 是必要定址資訊，沒有安全的預設值可猜。
            //   - 新增紀錄/申請（createSubstituteRecord／createPendingRequest）：**不可用**，
            //     client 端會先擋下並拋出明確錯誤，不會送出一筆 semesterId:null 的寫入讓
            //     Firestore 規則含糊地拒絕。
            //   以上三類失敗都會被呼叫端的 try/catch 或 safeBootstrapStep 接住並經
            //   notifyError() 顯示給使用者，不是靜默失敗，但「課表」與「新增紀錄/申請」在
            //   這個邊界情況下就是真的不可用，不是「暫時失去學期範圍收斂」這種輕描淡寫。
            await safeBootstrapStep('學期設定', async () => {
                let cfg = null;
                try {
                    cfg = await dataSvc.getConfig();
                } catch (e) {
                    console.warn('[V2] 讀取 config 失敗，改用今天日期推算學期：', e);
                }
                const resolved = cfg?.currentSemester || semesterUtils.todaySemesterId();
                semesterState.setCurrentSemesterId(resolved);
                if (!cfg?.currentSemester) {
                    console.warn(`[V2] config.currentSemester 未設定，暫以今天日期推算為 ${resolved}`);
                }
            });

            // 初次渲染
            // 驗收修復（阻斷 #3）：以下每一步都不是「身份解析」本身的一部分——身份已經在上面
            // resolveIdentity() 成功解析了。任何一步失敗都只應該讓該功能自己降級，不能讓整個
            // app 被下面的外層 catch 判定成登入失敗而永久鎖死（見 safeBootstrapStep 檔頭註解）。
            await safeBootstrapStep('待辦清單', renderPendingTab);
            await safeBootstrapStep('全校紀錄', renderRecordsTab);
            if (roleSvc.canManageRoster()) {
                await safeBootstrapStep('教師管理', renderTeachersAdminTab);
            }
            if (roleSvc.isDirector()) {
                await safeBootstrapStep('學期管理', renderSemesterAdminTab);
                await safeBootstrapStep('資料封存', renderArchiveAdminTab);
            }
            // Stage 1（讀取成本止血，§5.4）：操作日誌不再於 bootstrap 就讀（原本這裡對每個
            // approver 登入都無條件打一次 fetchLogs，即使這次登入完全不會打開日誌頁）。
            // 改為真的進入「操作日誌」頁籤才讀，見 bindV2TabSwitches 的
            // `if (tab === 'v2-logs') await renderLogsTab();`；該函式本身已有「載入中…」
            // 過場畫面，使用者體感只多一次頁籤切換的短暫等待，換來未開日誌頁的 approver
            // 完全不產生這筆讀取。
            // 初次渲染皆完成才解鎖——上面每一步都已各自降級不拋錯，這裡一定會執行到。
            unlockV2App();

            // 即時同步：更新同步 cache + 重新渲染（cache 供 checkExistingRecord 使用）。
            // pending cache 一律先過 normalizeLegacyRequest（舊 status='pending' 文件
            // 映射為 pending_swap_consent），下游（衝堂檢查等）不必再逐項 normalize。
            // 每個訂閱皆傳入各自來源的 onError：斷線/權限被撤時翻成人話提示 + 亮右上角同步
            // 中斷徽章；onNext 成功回資料時解除該來源的異常狀態（見 uiFeedback.setSyncStatus
            // 的「中 #A」修復：徽章現在是「任一來源壞掉」就顯示，不是單一布林值，某條訂閱
            // 恢復不會把其他仍然壞掉的來源一併洗成「已同步」）。
            const makeSyncErrorHandler = (source) => (err) => {
                notifyError(err, '即時同步');
                setSyncStatus(source, false, err?.code);
                if (source === 'pending') {
                    // 驗收修復（中 #A）：pendingRequests 訂閱本身失敗時，「待我同意/待我審核」
                    // 不能繼續顯示 _v2PendingCache 目前殘留的（可能是過期或空的）內容當作正常
                    // 空狀態——標記來源異常並立刻重繪，讓 renderPendingTab 改顯示錯誤卡片。
                    _v2PendingSourceError = err;
                    renderPendingTab();
                }
            };
            const pendingUnsub = await safeBootstrapStep('待辦即時同步', () => dataSvc.subscribePendingRequests((items) => {
                _v2PendingCache = (Array.isArray(items) ? items : []).map(requestSvc.normalizeLegacyRequest);
                _v2PendingSourceError = null; // 驗收修復（中 #A）：訂閱恢復正常，清除來源異常旗標
                renderPendingTab();
                setSyncStatus('pending', true);
            }, makeSyncErrorHandler('pending')));
            if (pendingUnsub) unsubs.push(pendingUnsub);

            const recordsUnsub = await safeBootstrapStep('全校紀錄即時同步', () => dataSvc.subscribeSubstituteRecords(async (items, meta) => {
                // Phase 6：父文件已不含 leaveType/reason，即時同步進來的紀錄要先補 detail
                // 才能餵給月結算（見 hydrateRecordsWithDetail 檔頭註解）。gen 守門避免較舊的
                // 一輪補讀在較新一輪之後才完成、把新資料覆蓋回舊的。
                const gen = ++_v2RecordsCacheGen;
                const hydrated = await hydrateRecordsWithDetail(Array.isArray(items) ? items : []);
                if (gen !== _v2RecordsCacheGen) return;
                _v2RecordsCache = hydrated;
                _v2RecordsLiveLastDoc = meta?.lastDoc ?? null; // 輕 #10：更新「載入更多」的原生 cursor 起點
                // 驗收修復（中 #4）：即時視窗有變動（新增/更新/刪除都會觸發這個 callback），
                // 已快取的日期範圍查詢結果可能已經過期，直接清空最保險（成本極低，Map.clear()）。
                _v2DateRangeQueryCache.clear();
                renderRecordsTab();
                setSyncStatus('records', true);
            }, makeSyncErrorHandler('records'), { limit: V2_RECORDS_PAGE_SIZE }));
            if (recordsUnsub) unsubs.push(recordsUnsub);

            // P2：訂閱全校課表——首次即回傳目前值（教師端載入 approver 上傳的課表），
            // 之後任何 approver 上傳/編輯都即時套用到本機並重繪。
            // Stage 2：訂閱路徑改為 schools/{schoolId}/schedules/{目前學期}（見 subscribeSchedule
            // 簽章變動），故需帶入 semesterState 目前快取的學期 id。
            const scheduleUnsub = await safeBootstrapStep('課表即時同步', () => dataSvc.subscribeSchedule(semesterState.getCurrentSemesterId(), (sched) => {
                if (sched) applyRemoteSchedule(sched);
                setSyncStatus('schedule', true);
            }, makeSyncErrorHandler('schedule')));
            if (scheduleUnsub) unsubs.push(scheduleUnsub);

            // 驗收修復（中 3）：訂閱 config/main，偵測「別的裝置/分頁已切換學期」——本機所有
            // 訂閱都綁死在 bootstrap 當時讀到的 semesterId（switchToNewSemester() 選擇 reload
            // 而非原地重新訂閱，見該函式註解），沒有這條訂閱，其他仍開著頁面的使用者不會知道
            // 自己在看已經變成唯讀的舊學期資料，寫入操作也會開始被規則拒絕卻不知道原因。
            // 單文件訂閱，成本可忽略。第一次快照理應等於 bootstrap 剛讀到的值（不會誤跳出
            // 橫幅）；只有「稍後」收到不同值時才顯示。
            const configUnsub = await safeBootstrapStep('學期變更監聽', () => dataSvc.subscribeConfig((cfg) => {
                const newSid = cfg?.currentSemester;
                const localSid = semesterState.getCurrentSemesterId();
                if (newSid && localSid && newSid !== localSid) {
                    showSemesterChangedBanner(newSid);
                }
            }, (err) => console.warn('[V2] config 訂閱失敗（跨分頁學期切換提示可能失效，不影響其他功能）：', err)));
            if (configUnsub) unsubs.push(configUnsub);

            // Stage 1（讀取成本止血，§5.4）：操作日誌不再於 bootstrap 常駐訂閱（原本 limit 200
            // 的 onSnapshot，approver 一登入就長期占用一條監聽，即使從未打開日誌頁）。改為進入
            // 「操作日誌」頁籤才讀（renderLogsTab 本來就是一次性 getDocs，見該函式），離開頁籤
            // 不需額外取消訂閱——因為根本沒有建立訂閱。

            // 首次塞 cache（onSnapshot 首次觸發前）— 讓即刻的衝堂檢查可用；同樣需要補 detail，
            // 否則身份確認後、onSnapshot 首次回呼前這段期間讀到的月結算會漏掉 leaveType。
            // 沿用同一支 gen 計數器：若 onSnapshot 已搶先在這段 await 期間完成過一輪，這裡就不再
            // 用（可能較舊的）結果覆蓋回去。
            // Stage 1：改用有界的分頁/篩選讀取（listSubstituteRecordsPage／listOpenPendingRequests），
            // 不再用 listSubstituteRecords()／listPendingRequests() 整集合無界讀取——這兩支一次性
            // 讀取原本只是「onSnapshot 首次快照前的臨時填充」，用途上本來就只需要與訂閱視窗一致
            // 的資料量，改用有界版本沒有任何行為損失。
            // 這段 prefill 本身就是一次真實讀取（有界），「初次渲染」（上方 renderRecordsTab()/
            // renderPendingTab()）發生在這段之前、快取都還是空的，所以會先畫出空列表；這裡 prefill
            // 完成後主動再 render 一次，讓使用者不必等 onSnapshot 首次快照才看到資料——不多打一次
            // Firestore，只是用同一筆已經讀到的資料多渲染一次。
            // 驗收修復（阻斷 #3）：兩段 prefill 各自 wrap，其中 listOpenPendingRequests 需要一個
            // 複合索引（status+createdAt，見 firestore.indexes.json）——索引缺失時的
            // failed-precondition 不能讓整個 bootstrap 中止，只讓這段 prefill 略過即可，
            // renderPendingTab 本身仍會照常運作（它讀 _v2PendingCache，缺 prefill 只是稍晚
            // 才有資料，等 subscribePendingRequests 的首次快照到來即補上）。
            // 驗收修復（輕 #F）：這支 prefill 本身也回傳 nextCursor（跟 subscribeSubstituteRecords
            // 的 meta.lastDoc 是同一種原生 cursor），順手存進 _v2RecordsLiveLastDoc——若即時訂閱
            // 遲遲沒有首次快照、甚至訂閱本身失敗（見 makeSyncErrorHandler('records')），
            // _v2RecordsLiveLastDoc 原本會一直是 null，使用者點「載入更多」時
            // loadMoreRecordsTabPage() 的 cursor 退回 null，等於用 afterCursor:null 重查
            // 第一頁，把 prefill 剛載入的這 50 筆整批重抓一次（多花一次有界讀取，且「載入更多」
            // 疊出來的列表會出現同一批紀錄的重複，靠 recordId 去重才沒有顯示出來，但白白多打
            // 一次 Firestore）。有 prefill 的 cursor 可用時先頂著用，訂閱首快照回來後
            // （見上方 subscribeSubstituteRecords 的 callback）自然會覆蓋成更新的值。
            await safeBootstrapStep('紀錄清單預讀', async () => {
                const initGen = ++_v2RecordsCacheGen;
                const { records: initialPage, nextCursor } = await dataSvc.listSubstituteRecordsPage({ pageSize: V2_RECORDS_PAGE_SIZE });
                const initialRecords = await hydrateRecordsWithDetail(initialPage);
                if (initGen === _v2RecordsCacheGen) {
                    _v2RecordsCache = initialRecords;
                    if (!_v2RecordsLiveLastDoc) _v2RecordsLiveLastDoc = nextCursor;
                    renderRecordsTab();
                }
            });
            // 驗收修復（中 #A）：這段 prefill 與上面的 subscribePendingRequests 是「待我同意/
            // 待我審核」唯二的資料來源，兩者都失敗時必須讓 renderPendingTab 知道（見
            // _v2PendingSourceError 宣告處註解），不能只是 safeBootstrapStep 記錄一下就算了——
            // 內層 try/catch 負責標記旗標＋重繪，再 rethrow 讓 safeBootstrapStep 照常做
            // console.error + notifyError（單一集中處，不重複記錄）。
            await safeBootstrapStep('待辦清單預讀', async () => {
                try {
                    _v2PendingCache = (await dataSvc.listOpenPendingRequests()).map(requestSvc.normalizeLegacyRequest);
                    _v2PendingSourceError = null;
                } catch (err) {
                    _v2PendingSourceError = err;
                    throw err;
                } finally {
                    renderPendingTab();
                }
            });
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
