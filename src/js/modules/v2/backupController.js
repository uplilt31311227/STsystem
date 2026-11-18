/**
 * V2 雲端備份／還原的畫面與流程（設定頁「資料管理」）
 *
 * 取代 V1「匯出完整備份／匯入還原」在 V2 下的失真行為（審計 ux C1、H8）：
 *   - 匯出：approver 可用，匯出整個學校的雲端資料（見 backupFormat.js 檔頭），分頁讀取、有進度、防連點。
 *   - 還原：僅 director；選檔 → 驗證 → 預覽（筆數、與雲端差異、不會還原的清單）→ 輸入確認字樣 →
 *     自動先下載當前狀態備份 → 分批寫入，失敗時回報已完成與未完成的部分。
 *   - 清除所有資料前的強制備份：exportBackupBeforeClear()。
 * 所有進入 HTML 的文字一律經 escapeHtml／richDialog 的 rd* helper；沒有 inline 事件處理器（CSP）。
 */

import * as roleSvc from './roleService.js';
import * as logger from './operationLogger.js';
import * as semesterState from './semesterState.js';
import { getActiveSchoolId, LOG_ACTIONS, LOG_TARGET_TYPES } from './schemaConstants.js';
import { notify } from './uiFeedback.js';
import { todayLocal } from '../localDate.js';
import { formatImportDate } from '../scheduleImportHistory.js';
import { openRichDialog, rdText, rdHeading, rdList, rdNotice, rdTable } from '../richDialog.js';
import {
    buildBackupFile, serializeBackup, backupFileName, parseAndValidateBackupText,
    cloudStateFromSections, planRestore, summarizeRestorePlan, countPlannedWrites,
    restrictPlanToPreview, resolveCurrentSemester, backupErrorMessage, semesterChangedSincePreview,
} from './backupFormat.js';
import { collectCloudBackupSections, executeRestore, describeRestoreReport, readArchivedSemesterIds } from './backupService.js';

/** 備份檔大小上限（超過多半是選錯檔） */
const MAX_BACKUP_FILE_BYTES = 200 * 1024 * 1024;

/** 預覽中顯示教師角色用 */
const ROLE_LABELS = { director: '教務主任', section_chief: '教學組長', teacher: '教師' };

let _busy = false;

function downloadText(text, fileName) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 給瀏覽器一點時間開始下載再釋放（立即 revoke 在部分瀏覽器會讓下載失敗）
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function countsText(c) {
    return `教師 ${c.teachers} 位、課表 ${c.schedules} 份、調代課紀錄 ${c.substituteRecords} 筆（含私有明細 ${c.substituteRecordDetails} 筆）、` +
        `待審申請 ${c.pendingRequests} 筆、匯入紀錄 ${c.scheduleImports} 筆`;
}

/**
 * 讀取雲端資料並組成備份檔（不下載）。
 * @returns {Promise<{backup:Object, text:string, fileName:string}>}
 */
export async function buildCloudBackup({ onProgress = null } = {}) {
    if (!roleSvc.isSignedIn() || !roleSvc.isApprover()) {
        throw new Error('只有教務主任與教學組長可以匯出全校備份');
    }
    const me = roleSvc.getCurrentIdentity();
    const sections = await collectCloudBackupSections({ onProgress });
    onProgress?.('整理備份檔…');
    const backup = await buildBackupFile({
        schoolId: getActiveSchoolId(),
        exportedBy: { uid: me?.uid || null, email: me?.email || null, name: me?.name || null, role: me?.role || null, teacherId: me?.teacherId || null },
        currentSemester: semesterState.getCurrentSemesterId() || null,
        sections,
    });
    const text = serializeBackup(backup);
    return { backup, text, fileName: backupFileName(backup.meta.schoolId, todayLocal()) };
}

/**
 * 匯出並觸發下載。同一時間只允許一個備份／還原作業進行（防連點）。
 * @returns {Promise<{fileName:string, counts:Object, bytes:number}>}
 */
export async function exportCloudBackup({ onProgress = null, reason = 'manual' } = {}) {
    if (_busy) throw new Error('已有備份或還原作業進行中，請等它完成');
    _busy = true;
    try {
        const { backup, text, fileName } = await buildCloudBackup({ onProgress });
        onProgress?.('觸發下載…');
        downloadText(text, fileName);
        logger.log(LOG_ACTIONS.EXPORT_BACKUP, LOG_TARGET_TYPES.SYSTEM, null, { reason, fileName, ...backup.meta.counts }).catch?.(() => {});
        return { fileName, counts: backup.meta.counts, bytes: text.length };
    } finally {
        _busy = false;
    }
}

/**
 * 「清除所有資料」前的強制備份：先下載完整備份，失敗就回傳 false（呼叫端必須中止清除）。
 * 成功後再讓使用者確認檔案已存下，才回傳 true。
 */
export async function exportBackupBeforeClear(app) {
    let result;
    const dismiss = app?.showToast?.('正在備份全校雲端資料，請稍候（資料量大時可能需要一分鐘）…', 'warning', 120000);
    try {
        result = await exportCloudBackup({ reason: 'before_clear' });
    } catch (err) {
        dismiss?.();
        console.error('[V2] 清除前備份失敗，已中止清除:', err);
        notify(backupErrorMessage(err, 'before-clear'), 'error');
        await app?.confirmDialog?.({
            title: '備份失敗，已中止清除',
            message: `${backupErrorMessage(err, 'before-clear')}\n\n為了避免資料無法挽回，系統不會在沒有備份的情況下清除。`,
            confirmText: '我知道了',
            cancelText: '關閉',
        });
        return false;
    }
    dismiss?.();
    return !!(await app?.confirmDialog?.({
        title: '備份已下載，請確認',
        message: `已下載備份檔：${result.fileName}\n內容：${countsText(result.counts)}\n\n` +
            '請確認這個檔案已經存到電腦（瀏覽器的下載清單可以看到），並妥善保管。\n確認後才會繼續清除。',
        confirmText: '已確認備份，繼續清除',
        cancelText: '先不清除',
        danger: true,
    }));
}

/* ===== 設定頁卡片 ===== */

function setStatus(el, text, kind = '') {
    if (!el) return;
    el.textContent = text;
    el.className = `hint backup-status${kind ? ` backup-status-${kind}` : ''}`;
    el.style.display = text ? '' : 'none';
}

/** 渲染「雲端備份與還原」區塊到 #v2-backup-admin（依角色顯示不同內容）。 */
export function renderBackupAdmin(app) {
    const host = document.getElementById('v2-backup-admin');
    if (!host) return;
    if (!roleSvc.isSignedIn() || !roleSvc.isApprover()) { host.innerHTML = ''; return; }
    const isDirector = roleSvc.isDirector();

    host.innerHTML = `
        <div class="data-management-section">
            <strong>匯出完整備份（雲端）</strong>
            <p class="hint">匯出目前學校雲端的全部資料：各學期課表、各學期的調代課紀錄（含假別與事由）、待審申請、教師名冊、學校設定、課表匯入紀錄清單。資料量大時會分批讀取，請耐心等候。</p>
            <button class="btn btn-secondary btn-sm" id="v2-backup-export-btn">匯出完整備份</button>
        </div>
        <div class="data-management-section">
            <strong>匯入還原（雲端）</strong>
            ${isDirector ? `
            <p class="hint">從「匯出完整備份」產生的檔案還原。會先顯示預覽與不會還原的項目，輸入確認字樣後才執行，並在還原前自動下載一份目前狀態的備份。</p>
            <input type="file" id="v2-backup-file" accept=".json,application/json" class="hidden">
            <button class="btn btn-primary btn-sm" id="v2-backup-restore-btn">選擇備份檔案</button>
            ` : `<p class="hint">還原備份僅限教務主任操作。</p>`}
        </div>
        <p class="hint backup-status" id="v2-backup-status" style="display:none;" role="status" aria-live="polite"></p>
    `;

    const statusEl = document.getElementById('v2-backup-status');
    const exportBtn = document.getElementById('v2-backup-export-btn');
    const restoreBtn = document.getElementById('v2-backup-restore-btn');
    const fileInput = document.getElementById('v2-backup-file');
    const lock = (on, busyLabel) => {
        if (exportBtn) { exportBtn.disabled = on; exportBtn.textContent = on && busyLabel === 'export' ? '匯出中…' : '匯出完整備份'; }
        if (restoreBtn) { restoreBtn.disabled = on; restoreBtn.textContent = on && busyLabel === 'restore' ? '處理中…' : '選擇備份檔案'; }
    };

    exportBtn?.addEventListener('click', async () => {
        if (_busy) return;
        lock(true, 'export');
        try {
            const r = await exportCloudBackup({ onProgress: (m) => setStatus(statusEl, m) });
            setStatus(statusEl, `已匯出：${r.fileName}（${countsText(r.counts)}）。請確認檔案已存到電腦。`, 'ok');
            notify('完整備份已匯出，請確認檔案已存到電腦', 'success', 6000);
        } catch (err) {
            console.error('[V2] 匯出完整備份失敗:', err);
            const msg = backupErrorMessage(err, 'export');
            setStatus(statusEl, msg, 'error');
            notify(msg, 'error');
        } finally {
            lock(false);
        }
    });

    restoreBtn?.addEventListener('click', () => { if (!_busy) fileInput?.click(); });
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        lock(true, 'restore');
        try {
            await runRestoreFlow(app, file, (m) => setStatus(statusEl, m));
        } catch (err) {
            console.error('[V2] 還原流程失敗:', err);
            const msg = backupErrorMessage(err, 'restore-read');
            setStatus(statusEl, msg, 'error');
            notify(msg, 'error');
        } finally {
            lock(false);
        }
    });
}

/* ===== 還原流程 ===== */

export async function runRestoreFlow(app, file, say) {
    if (!roleSvc.isSignedIn() || !roleSvc.isDirector()) {
        notify('僅教務主任可執行還原', 'error');
        return;
    }
    if (_busy) return;
    _busy = true;
    try {
        if (file.size > MAX_BACKUP_FILE_BYTES) {
            notify('檔案太大（上限 200 MB），請確認是否選錯檔案', 'error');
            return;
        }
        say(`讀取檔案「${file.name}」…`);
        const text = await file.text();
        say('驗證備份檔…');
        const schoolId = getActiveSchoolId();
        const v = await parseAndValidateBackupText(text, { schoolId });
        if (!v.ok) {
            say('');
            await app?.confirmDialog?.({ title: '無法還原這個檔案', message: v.message, confirmText: '我知道了', cancelText: '關閉' });
            return;
        }
        const backup = v.backup;

        say('讀取雲端現況，計算差異…');
        const cloudSections = await collectCloudBackupSections({ includeDetails: false, includeImports: false, onProgress: say });
        const cloud = cloudStateFromSections(cloudSections);
        cloud.archivedSemesterIds = await readArchivedSemesterIds();
        // 目前學期取「剛從伺服器讀到的 config/main」，不取記憶體裡的學期狀態
        const currentSemesterId = resolveCurrentSemester(cloud, backup);
        if (!currentSemesterId) {
            say('');
            await app?.confirmDialog?.({ title: '無法還原', message: '讀不到雲端的目前學期設定，無法計算還原計畫。沒有寫入任何資料。', confirmText: '我知道了', cancelText: '關閉' });
            return;
        }
        const plan = planRestore({ backup, cloud, currentSemesterId });   // 預覽用：emailIndex 預設不補回
        const writes = countPlannedWrites(plan);
        say('');

        // ----- 預覽 -----
        const meta = backup.meta;
        const rows = summarizeRestorePlan(plan).map(r => [
            r.label, String(r.backup), r.cloud == null ? '—' : String(r.cloud), String(r.willRestore), r.note,
        ]);
        const body = [
            rdTable(['', '內容'], [
                ['備份時間', formatImportDate(meta.exportedAt) || meta.exportedAt],
                ['匯出者', meta.exportedBy?.name || meta.exportedBy?.email || '—'],
                ['來源學校', `${meta.schoolId}（與目前學校相同）`],
                ['備份當時的目前學期', meta.currentSemester || '—'],
                ['目前雲端的目前學期', currentSemesterId],
            ]),
            rdHeading('各集合與雲端現況'),
            rdTable(['集合', '備份檔', '雲端現有', '將還原', '說明'], rows),
            writes === 0 && plan.config.settlementBackupOlder
                ? rdNotice('warn', '這份備份裡沒有雲端缺少的項目；唯一的差異是月結算設定（備份檔的比雲端現有的舊）。預設不會覆寫，要用備份檔的月結算設定請勾選下方的選項，勾選後才能按「開始還原」。')
                : writes === 0
                ? rdNotice('warn', '這份備份裡沒有任何需要還原的項目（雲端已經有相同內容，或剩下的都是規則不允許還原的資料）。')
                : rdNotice('danger', '還原只會「補回雲端缺少的資料」並取代目前學期的課表，不會刪除雲端現有的任何紀錄。目前學期的課表被取代前，系統會自動存一份「匯入前自動備份」到課表匯入紀錄。'),
            ...(plan.teachers.createList.length ? [
                rdHeading(`將補回的教師（${plan.teachers.createList.length} 位）`),
                rdNotice('warn', '這些教師目前不在雲端名冊（可能已被刪除）。補回教師檔後，其角色會恢復成下表所列；若其中有已離職或已被撤銷身分的人，請不要執行還原。預設補回的教師檔信箱欄位會留空，下表的信箱只是備份檔記載的原信箱、不會寫回；需要讓他們登入時，請之後到教師管理逐一填回。'),
                rdTable(['姓名', '角色', '原信箱（預設不寫回）'], plan.teachers.createList.map(t => [t.name, ROLE_LABELS[t.role] || t.role || '—', t.email || '—'])),
            ] : []),
            rdHeading('不會還原的項目'),
            rdList(plan.notRestored),
        ].join('');

        const emailOpt = { checked: false };
        const settlementOpt = { checked: false };
        // PL-10d：備份裡的月結算設定比雲端舊時，預設不覆寫，使用者勾選後才覆寫。
        // 若這是唯一的差異（writes === 0），勾選本身就是要執行的動作，所以勾選才解除確認鈕（enablesConfirm）
        const extraOptions = plan.config.settlementBackupOlder ? [{
            label: '備份檔裡的月結算設定比雲端現有的舊。勾選後才會用備份檔的月結算設定（上課週數、逐人門檻）覆寫雲端較新的設定；不勾選則保留雲端現有設定。',
            ref: settlementOpt,
            enablesConfirm: true,
        }] : [];
        const confirmed = await openRichDialog({
            title: '確認還原備份',
            target: `還原到學校：${schoolId}`,
            bodyHtml: body,
            phrase: `還原 ${schoolId}`,
            phraseHint: '這個動作會寫入全校雲端資料。請輸入確認字樣：',
            confirmText: '開始還原',
            danger: true,
            confirmDisabled: writes === 0,
            ...(plan.teachers.createList.some(t => t.email) ? {
                optionLabel: '同時把上列教師的原信箱與登入綁定（emailIndex）一併恢復。不勾選時，教師檔會補回但信箱欄位留空，他們暫時無法登入。',
                optionRef: emailOpt,
            } : {}),
            extraOptions,
        });
        if (!confirmed) { notify('已取消還原，雲端資料沒有變動', 'info'); return; }

        // ----- 還原前自動備份（失敗即中止）-----
        say('還原前先備份目前雲端狀態…');
        let pre;
        try {
            const built = await buildCloudBackup({ onProgress: say });
            downloadText(built.text, built.fileName.replace('.json', '_還原前.json'));
            pre = built;
        } catch (err) {
            console.error('[V2] 還原前備份失敗，已中止還原:', err);
            say('');
            await app?.confirmDialog?.({
                title: '還原已中止',
                message: backupErrorMessage(err, 'restore-backup'),
                confirmText: '我知道了', cancelText: '關閉',
            });
            return;
        }

        // ----- 重新讀取現況再算一次計畫（預覽到現在可能又有人改過）-----
        const freshCloud = cloudStateFromSections(pre.backup);
        freshCloud.archivedSemesterIds = await readArchivedSemesterIds();
        const freshSemesterId = resolveCurrentSemester(freshCloud, backup) || currentSemesterId;
        // PL-10b：預覽之後目前學期變了（別台裝置切換學期），預覽的清單已不適用，中止並請重新預覽
        if (semesterChangedSincePreview(currentSemesterId, freshSemesterId)) {
            say('');
            await app?.confirmDialog?.({
                title: '還原已中止',
                message: `預覽之後雲端的目前學期已從 ${currentSemesterId} 變成 ${freshSemesterId}，預覽的內容已不適用。沒有寫入任何資料，請重新選擇備份檔、重新預覽後再還原。
（還原前的備份已下載：${pre.fileName.replace('.json', '_還原前.json')}）`,
                confirmText: '我知道了', cancelText: '關閉',
            });
            return;
        }
        const recomputed = planRestore({ backup, cloud: freshCloud, currentSemesterId: freshSemesterId, restoreEmailIndex: emailOpt.checked, overwriteNewerSettlement: settlementOpt.checked });
        // 補回的教師只限預覽列過的；重算後多出來的不補回，請使用者重新執行以檢視
        const { plan: freshPlan, dropped: droppedTeachers } = restrictPlanToPreview(recomputed, plan);

        say('開始還原…');
        const report = await executeRestore({
            backup, plan: freshPlan, cloud: freshCloud, me: roleSvc.getCurrentIdentity(), onProgress: say,
        });
        say('');
        logger.log(LOG_ACTIONS.RESTORE_BACKUP, LOG_TARGET_TYPES.SYSTEM, null, {
            backupExportedAt: meta.exportedAt, ok: report.ok,
            stages: report.stages.map(s => ({ k: s.key, st: s.status, done: s.done, planned: s.planned })),
        }).catch?.(() => {});

        await openRichDialog({
            title: report.ok ? '還原完成' : '還原未全部完成',
            bodyHtml: rdText(describeRestoreReport(report))
                + (droppedTeachers.length ? rdText(`還原期間名冊有變動：有 ${droppedTeachers.length} 位教師沒有出現在預覽中，這次沒有補回，請重新執行一次以檢視。`) : '')
                + rdText(`還原前的備份已下載：${pre.fileName.replace('.json', '_還原前.json')}`)
                + rdText('按「重新整理」會重新載入頁面，讓畫面顯示最新的雲端資料。'),
            confirmText: '重新整理',
            cancelText: '稍後再說',
            danger: !report.ok,
        }).then((reload) => { if (reload) window.location.reload(); });
    } finally {
        _busy = false;
    }
}
