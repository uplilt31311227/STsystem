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
import { LOG_ACTIONS, LOG_TARGET_TYPES, ROLES } from './modules/v2/schemaConstants.js';
import * as authMod from './modules/authService.js';

/* ===== 樣式注入 ===== */

function injectV2Styles() {
    if (document.getElementById('v2-styles')) return;
    const style = document.createElement('style');
    style.id = 'v2-styles';
    style.textContent = `
    .v2-only { display: none; }
    body.v2-active .v2-only { display: revert; }
    body.v2-active .v2-admin-only { display: none; }
    body.v2-active.v2-admin .v2-admin-only { display: revert; }
    body.v2-active .v2-teacher-only { display: revert; }
    body.v2-active.v2-admin .v2-teacher-only { display: none; }

    .v2-badge { display: inline-block; padding: 2px 6px; border-radius: 10px;
                font-size: 0.72rem; margin-left: 4px; background: #e53e3e; color: #fff; }
    .v2-role-tag { display: inline-block; padding: 2px 8px; border-radius: 10px;
                   font-size: 0.75rem; font-weight: 600; }
    .v2-role-tag.admin { background: #d97706; color: #fff; }
    .v2-role-tag.teacher { background: #2563eb; color: #fff; }

    .v2-login-denied { max-width: 520px; margin: 3rem auto; padding: 2rem;
                      background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; }
    .v2-login-denied h3 { margin-top: 0; color: #856404; }

    .v2-pending-item { border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.8rem;
                       margin-bottom: 0.6rem; background: #fafafa; }
    .v2-pending-item.incoming { border-left: 4px solid #f59e0b; }
    .v2-pending-item.outgoing { border-left: 4px solid #3b82f6; }
    .v2-pending-meta { font-size: 0.85rem; color: #6b7280; margin-top: 4px; }
    .v2-pending-actions { margin-top: 0.6rem; display: flex; gap: 0.4rem; }

    .v2-log-table { width: 100%; font-size: 0.85rem; border-collapse: collapse; }
    .v2-log-table th, .v2-log-table td { padding: 4px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; }
    .v2-log-table tbody tr:hover { background: #f9fafb; }

    .v2-teacher-row td { vertical-align: middle; }
    .v2-teacher-row input[type="email"] { width: 220px; }

    .v2-section-header { display: flex; justify-content: space-between;
                         align-items: center; margin-bottom: 1rem; }
    `;
    document.head.appendChild(style);
}

/* ===== 登入拒絕畫面 ===== */

function showLoginDenied(email) {
    const main = document.querySelector('main.main-content') || document.body;
    let box = document.getElementById('v2-login-denied');
    if (!box) {
        box = document.createElement('div');
        box.id = 'v2-login-denied';
        box.className = 'v2-login-denied';
        main.prepend(box);
    }
    box.innerHTML = `
        <h3>🔒 此帳號尚未被授權使用本系統</h3>
        <p>登入的 Google 帳號 <strong>${email || '(未知)'}</strong> 尚未綁定任何教師身份。</p>
        <p>請聯絡組長在「教師管理」頁籤為您指派 email 後再試。</p>
        <button class="btn btn-secondary" id="v2-denied-logout">重新登入</button>
    `;
    document.getElementById('v2-denied-logout')?.addEventListener('click', async () => {
        await authMod.signOutUser();
        box.remove();
    });
}

/* ===== 渲染（待辦 / 教師管理 / 操作日誌） ===== */

function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
    catch { return iso || ''; }
}

async function renderPendingTab() {
    const host = document.getElementById('v2-pending-list');
    if (!host) return;
    host.innerHTML = '<p>載入中…</p>';

    const me = roleSvc.getCurrentIdentity();
    if (!me) { host.innerHTML = '<p>尚未登入。</p>'; return; }

    const all = await dataSvc.listPendingRequests();
    const incoming = all.filter(r => r.requiredApproverId === me.teacherId);
    const outgoing = all.filter(r => r.initiatedBy === me.teacherId);

    const render = (items, cls, emptyMsg, actionsFn) => {
        if (!items.length) return `<p class="muted">${emptyMsg}</p>`;
        return items.map(r => `
            <div class="v2-pending-item ${cls}" data-id="${r.reqId}">
                <div><strong>${r.type || '調課'}</strong> ・ ${r.date || ''} 第 ${r.period || '?'} 節 ・ ${r.className || ''} ${r.subject || ''}</div>
                <div class="v2-pending-meta">
                    發起：${r.initiatedByName || r.initiatedBy || ''} ・ 對象：${r.requiredApproverName || r.requiredApproverId || ''} ・ ${fmtDate(r.createdAt)}
                </div>
                <div class="v2-pending-actions">${actionsFn(r)}</div>
            </div>`).join('');
    };

    host.innerHTML = `
        <div class="v2-section-header"><h3>待我同意</h3></div>
        ${render(incoming, 'incoming', '目前沒有等待您同意的請求', r =>
            `<button class="btn btn-primary btn-sm v2-approve-btn" data-id="${r.reqId}">同意</button>
             <button class="btn btn-secondary btn-sm v2-reject-btn" data-id="${r.reqId}">拒絕</button>`
        )}
        <div class="v2-section-header" style="margin-top:2rem;"><h3>我已發起</h3></div>
        ${render(outgoing, 'outgoing', '目前沒有您發起中的請求', r =>
            `<button class="btn btn-danger btn-sm v2-cancel-btn" data-id="${r.reqId}">撤回</button>`
        )}
    `;

    host.querySelectorAll('.v2-approve-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            try { await requestSvc.approveRequest(btn.dataset.id); await renderPendingTab(); await renderRecordsTab(); }
            catch (e) { alert(e.message); }
        }));
    host.querySelectorAll('.v2-reject-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            const note = prompt('拒絕原因（可留空）：') || '';
            try { await requestSvc.rejectRequest(btn.dataset.id, note); await renderPendingTab(); }
            catch (e) { alert(e.message); }
        }));
    host.querySelectorAll('.v2-cancel-btn').forEach(btn =>
        btn.addEventListener('click', async () => {
            if (!confirm('確定撤回此調課請求？')) return;
            try { await requestSvc.cancelRequest(btn.dataset.id); await renderPendingTab(); }
            catch (e) { alert(e.message); }
        }));
}

async function renderTeachersAdminTab() {
    const host = document.getElementById('v2-teachers-admin');
    if (!host) return;
    if (!roleSvc.isAdmin()) { host.innerHTML = '<p>僅組長可存取。</p>'; return; }

    host.innerHTML = '<p>載入中…</p>';
    const teachers = await teacherMgr.listAllTeachers();

    host.innerHTML = `
        <div class="v2-section-header">
            <h3>教師帳號管理</h3>
            <div>
                <button class="btn btn-secondary btn-sm" id="v2-import-legacy-teachers">從課表匯入教師</button>
                <button class="btn btn-primary btn-sm" id="v2-add-teacher">新增教師</button>
            </div>
        </div>
        <table class="data-table data-table-compact">
            <thead><tr><th>姓名</th><th>Email（登入帳號）</th><th>角色</th><th>領域</th><th>操作</th></tr></thead>
            <tbody>
            ${teachers.map(t => `
                <tr class="v2-teacher-row" data-id="${t.teacherId}">
                    <td>${t.name}</td>
                    <td><input type="email" class="v2-email-input" value="${t.email || ''}" placeholder="未指派"></td>
                    <td>
                        <select class="v2-role-select">
                            <option value="teacher" ${t.role !== 'admin' ? 'selected' : ''}>教師</option>
                            <option value="admin"   ${t.role === 'admin' ? 'selected' : ''}>組長</option>
                        </select>
                    </td>
                    <td>${(t.domains || []).join('、')}</td>
                    <td>
                        <button class="btn btn-primary btn-sm v2-save-teacher">儲存</button>
                        <button class="btn btn-danger btn-sm v2-delete-teacher">刪除</button>
                    </td>
                </tr>`).join('')}
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

    host.innerHTML = '<p>載入中…</p>';
    const all = await logger.fetchLogs({ limit: 300 });
    const visible = roleSvc.filterLogsForCurrent(all);

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
    // V2 模式下，在原「調代課紀錄」頁籤下方注入 V2 全校紀錄區塊
    let host = document.getElementById('v2-records-section');
    if (!host) {
        const original = document.getElementById('records-tab');
        if (!original) return;
        host = document.createElement('div');
        host.id = 'v2-records-section';
        host.style.marginTop = '2rem';
        original.appendChild(host);
    }
    const all     = await dataSvc.listSubstituteRecords();
    const visible = roleSvc.filterRecordsForCurrent(all);
    const isAdmin = roleSvc.isAdmin();

    host.innerHTML = `
        <div class="v2-section-header">
            <h3>全校調代課紀錄 <small style="color:#6b7280;font-weight:normal;">（${visible.length} 筆｜${isAdmin ? '組長視圖' : '個人相關'}）</small></h3>
        </div>
        <table class="data-table data-table-compact">
            <thead><tr>
                <th>日期</th><th>節次</th><th>班級</th><th>原教師</th><th>代/調對象</th><th>類型</th><th>發起</th>
                ${isAdmin ? '<th>操作</th>' : ''}
            </tr></thead>
            <tbody>
            ${visible.map(r => `
                <tr data-id="${r.recordId}">
                    <td>${r.date || ''}</td>
                    <td>${r.period || ''}</td>
                    <td>${r.className || ''}</td>
                    <td>${r.originalTeacher || ''}</td>
                    <td>${r.substituteTeacher || r.swapTeacher || ''}</td>
                    <td>${r.type || ''}${r.initiatedByRole === 'admin' ? ' <span class="v2-role-tag admin">代發</span>' : ''}</td>
                    <td>${r.initiatedByName || ''}</td>
                    ${isAdmin ? `<td>
                        <button class="btn btn-danger btn-sm v2-admin-delete" data-id="${r.recordId}">刪除</button>
                    </td>` : ''}
                </tr>`).join('')}
            </tbody>
        </table>
    `;

    if (isAdmin) {
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

async function writeV2Record(record) {
    const me = roleSvc.getCurrentIdentity();
    if (!me) throw new Error('尚未登入');

    const ids = await resolveApproverInfo(record);
    const payload = {
        ...record,
        ...ids,
        initiatedByName: record.originalTeacher || me.name,
    };

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
    setTimeout(() => {
        alert(`已送出給 ${ids.requiredApproverName} 同意。\n對方同意後紀錄才會正式成立。`);
    }, 100);
    return saved;
}

function patchDataManager() {
    const dm = window.app?.dataManager;
    if (!dm || dm.__v2_patched) return;
    dm.__v2_patched = true;

    const origAdd = dm.addSubstituteRecord.bind(dm);
    dm.addSubstituteRecord = function(record) {
        if (roleSvc.isSignedIn()) {
            // V2 模式：改走 V2 寫入，不入 local
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

    await authMod.initAuthService();

    let unsubs = [];
    const clearSubs = () => { unsubs.forEach(u => { try { u(); } catch (_) {} }); unsubs = []; };

    authMod.onAuthStateChange(async (user) => {
        clearSubs();
        if (!user) {
            roleSvc.clearCurrentIdentity();
            document.body.classList.remove('v2-admin');
            return;
        }
        try {
            const identity = await authGuard.resolveIdentity({
                uid: user.uid, email: user.email,
                displayName: user.displayName, photoURL: user.photoURL,
            });
            if (!identity) {
                await authMod.signOutUser();
                showLoginDenied(user.email);
                return;
            }
            if (identity.role === ROLES.ADMIN) document.body.classList.add('v2-admin');
            else                                document.body.classList.remove('v2-admin');

            const nameSpan = document.getElementById('user-name');
            if (nameSpan) nameSpan.innerHTML = `${identity.name} <span class="v2-role-tag ${identity.role}">${identity.role === 'admin' ? '組長' : '教師'}</span>`;

            // 初次渲染
            await renderPendingTab();
            await renderRecordsTab();
            if (roleSvc.isAdmin()) {
                await renderTeachersAdminTab();
                await renderLogsTab();
            }

            // 即時同步：待辦 / 紀錄 / 日誌（admin）
            unsubs.push(await dataSvc.subscribePendingRequests(() => renderPendingTab()));
            unsubs.push(await dataSvc.subscribeSubstituteRecords(() => renderRecordsTab()));
            if (roleSvc.isAdmin()) {
                unsubs.push(await dataSvc.subscribeOperationLogs(() => renderLogsTab()));
            }
        } catch (e) {
            console.error('[v2] resolveIdentity 失敗:', e);
            alert('V2 身份綁定失敗：' + e.message);
        }
    });

    bindV2TabSwitches();
    interceptSubmitButton();
    patchDataManager();

    console.log('[V2] 權限系統已啟動');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
