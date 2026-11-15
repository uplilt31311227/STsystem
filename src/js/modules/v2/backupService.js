/**
 * V2 雲端完整備份：讀取（匯出）與寫入（還原）的服務層
 *
 * 純邏輯（格式、驗證、還原計畫）在 backupFormat.js；這裡只負責跟 Firestore 說話：
 *   - collectCloudBackupSections()：分頁讀取目前學校的課表、調代課紀錄（含 private/detail）、待審申請、
 *     教師名冊、設定、匯入紀錄中繼資料。一律以文件 ID 排序＋游標分頁，不依賴任何 limit 上限，
 *     任何一頁或任何一筆明細讀取失敗都直接丟出（不確定＝中止，不輸出殘缺備份）。
 *     所有讀取都走 getDocsFromServer／getDocFromServer，絕不讀本機快取；讀不到伺服器就丟錯。
 *   - executeRestore()：依 planRestore 的計畫分段寫入，每段失敗就停止，回報已完成與未完成的部分。
 *
 * 權限（由 firestore.rules 決定，呼叫端另外在 UI 層檢查角色）：
 *   匯出需 approver（讀 private/detail、config/settlement）；還原需 director（建立教師、設定）。
 */

import { getV2Firestore } from './firebaseV2.js';
import { SCHEMA_PATHS } from './schemaConstants.js';
import * as dataSvc from './schoolDataService.js';
import { buildPreImportBackup } from '../scheduleImportHistory.js';
import { stripReservedFields, normalizeTeacherEmail } from './backupFormat.js';

/** 各集合每頁筆數。課表文件可能接近 1MB，頁數開小一點以控制記憶體。 */
export const PAGE_SIZES = Object.freeze({ default: 300, schedules: 5, imports: 20 });
/** 讀取 private/detail 的並行上限（不用無上限的 Promise.all，避免上千個請求同時送出）。 */
export const DETAIL_READ_CONCURRENCY = 25;
/**
 * 還原寫入的批次大小——以 emulator 實測校準（test/emulator/calibrate-restore-batch.mjs，rules v2.13）：
 *   紀錄＋private/detail：每筆 2 個寫入，且 private 的 create 規則要對父文件做 exists()，批次內文件存取呼叫
 *     有上限，實測 12 筆成功、16 筆失敗（403 evaluation error），與 allowedTeacherIds 長度無關（30 位當事人亦同）。
 *     取最大成功值的一半＝6，保留規則日後增加運算式的餘裕。
 *   教師＋emailIndex：每位 2 個寫入，實測 240 位（480 個寫入）仍成功；取 100（200 個寫入）。
 *   無 private 的紀錄實測 250 筆成功，但同一批混用時以含 private 的上限為準，故統一用 6。
 */
export const RESTORE_RECORD_BATCH = 6;
export const RESTORE_TEACHER_BATCH = 100;

/* ===== 讀取 ===== */

/**
 * 依文件 ID 排序＋游標分頁，讀出整個集合。不依賴 limit 作為「總量上限」。
 * @returns {Promise<Array<{id:string, data:Object}>>}
 */
export async function readAllDocsPaged(colPath, { pageSize = PAGE_SIZES.default, onPage = null } = {}) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, colPath);
    const out = [];
    let cursor = null;
    for (;;) {
        const constraints = [fs.orderBy('__name__')];
        if (cursor) constraints.push(fs.startAfter(cursor));
        constraints.push(fs.limit(pageSize));
        // 只讀伺服器：離線／stream 出錯時 getDocs 會靜默回傳快取（殘缺資料），這裡必須明確失敗
        const snap = await fs.getDocsFromServer(fs.query(col, ...constraints));
        for (const d of snap.docs) out.push({ id: d.id, data: d.data() });
        if (onPage) onPage(out.length);
        if (snap.docs.length < pageSize) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return out;
}

/** 有並行上限的 map；任一項丟出錯誤就整體 reject（其餘進行中的請求自然結束，不再啟動新的）。 */
export async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    let failed = null;
    const worker = async () => {
        while (failed === null) {
            const i = next++;
            if (i >= items.length) return;
            try { results[i] = await fn(items[i], i); }
            catch (e) { failed = e || new Error('unknown'); return; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    if (failed !== null) throw failed;
    return results;
}

async function readDocOrNull(path) {
    const fs = await getV2Firestore();
    // 只讀伺服器，理由同 readAllDocsPaged
    const snap = await fs.getDocFromServer(fs.doc(fs.db, path));
    return snap.exists() ? snap.data() : null;
}

async function attachPrivate(entries, detailPathFn, onProgress, label) {
    let done = 0;
    const out = await mapWithConcurrency(entries, DETAIL_READ_CONCURRENCY, async (e) => {
        // 不吞錯：getDoc 對「文件不存在」不是錯誤（回 null），其餘錯誤（網路、權限）一律中止整份備份
        const priv = await readDocOrNull(detailPathFn(e.id));
        done++;
        if (onProgress && (done % 50 === 0 || done === entries.length)) onProgress(`${label}私有明細 ${done}/${entries.length}…`);
        return { id: e.id, data: e.data, private: priv };
    });
    return out;
}

/**
 * 讀出目前學校的備份區段（見 backupFormat.js 檔頭）。
 * @param {{ onProgress?:(msg:string)=>void, includeDetails?:boolean, includeImports?:boolean }} [opts]
 *   includeDetails=false 時不讀 private/detail（還原預覽只需要筆數與 id，省下大量讀取）。
 */
export async function collectCloudBackupSections({ onProgress = null, includeDetails = true, includeImports = true } = {}) {
    const say = (m) => { if (onProgress) onProgress(m); };

    say('讀取學校設定…');
    const [cfgMain, cfgSettlement] = await Promise.all([
        readDocOrNull(SCHEMA_PATHS.config()),
        readDocOrNull(SCHEMA_PATHS.settlementConfig()),
    ]);

    say('讀取教師名冊…');
    const teachers = await readAllDocsPaged(SCHEMA_PATHS.teachersCol(), { onPage: n => say(`讀取教師名冊 ${n} 位…`) });

    say('讀取各學期課表…');
    const schedules = await readAllDocsPaged(SCHEMA_PATHS.schedulesCol(), { pageSize: PAGE_SIZES.schedules, onPage: n => say(`讀取各學期課表 ${n} 份…`) });

    const scheduleImports = [];
    if (includeImports) {
        for (const sc of schedules) {
            say(`讀取「${sc.id}」匯入紀錄…`);
            const imps = await readAllDocsPaged(SCHEMA_PATHS.scheduleImportsCol(sc.id), { pageSize: PAGE_SIZES.imports });
            for (const imp of imps) {
                // 只留中繼資料：快照（整份課表）會讓備份檔暴增，且匯入紀錄寫入後不可修改、本來就不還原
                const { snapshot, ...meta } = imp.data || {};
                scheduleImports.push({ semesterId: sc.id, id: imp.id, data: meta });
            }
        }
    }

    say('讀取調代課紀錄…');
    let records = await readAllDocsPaged(SCHEMA_PATHS.substituteCol(), { onPage: n => say(`讀取調代課紀錄 ${n} 筆…`) });
    say('讀取待審申請…');
    let pending = await readAllDocsPaged(SCHEMA_PATHS.pendingCol(), { onPage: n => say(`讀取待審申請 ${n} 筆…`) });

    if (includeDetails) {
        records = await attachPrivate(records, SCHEMA_PATHS.substituteDetailDoc, say, '調代課紀錄');
        pending = await attachPrivate(pending, SCHEMA_PATHS.pendingDetailDoc, say, '待審申請');
    } else {
        records = records.map(r => ({ id: r.id, data: r.data, private: null }));
        pending = pending.map(r => ({ id: r.id, data: r.data, private: null }));
    }

    return {
        config: { main: cfgMain, settlement: cfgSettlement },
        teachers, schedules, scheduleImports,
        substituteRecords: records,
        pendingRequests: pending,
    };
}

/* ===== 還原寫入 ===== */

/**
 * 依計畫寫入。回傳逐階段報告；某階段失敗就停止，後續階段標為 pending。
 * 還原是「補缺 + 取代目前學期課表」：重複執行只會補上仍缺少的部分，安全可重入。
 *
 * @param {Object} p
 * @param {Object} p.backup  已驗證的備份（normalizeSections 形狀）
 * @param {Object} p.plan    planRestore() 的結果（以「寫入前剛讀的雲端現況」計算）
 * @param {Object} p.cloud   cloudStateFromSections() 的結果（取課表版本做前置條件）
 * @param {{name?:string, teacherId?:string|null, email?:string, uid?:string}|null} p.me
 * @param {(msg:string)=>void} [p.onProgress]
 * @returns {Promise<{ok:boolean, stages:Array}>}
 */
export async function executeRestore({ backup, plan, cloud, me, onProgress = null }) {
    const fs  = await getV2Firestore();
    const say = (m) => { if (onProgress) onProgress(m); };
    const stages = [
        { key: 'teachers',  label: '教師名冊', planned: plan.teachers.create.length, done: 0, status: 'pending', error: null },
        { key: 'config',    label: '學校設定', planned: (plan.config.main === 'create' ? 1 : 0) + (plan.config.settlement === 'overwrite' ? 1 : 0), done: 0, status: 'pending', error: null },
        { key: 'schedules', label: '學期課表', planned: plan.schedules.filter(s => s.action === 'overwrite' || s.action === 'create').length, done: 0, status: 'pending', error: null },
        { key: 'records',   label: '調代課紀錄', planned: plan.records.create.length, done: 0, status: 'pending', error: null },
    ];
    let stopped = false;

    for (const st of stages) {
        if (stopped) break;
        if (st.planned === 0) { st.status = 'skipped'; continue; }
        try {
            if (st.key === 'teachers') await restoreTeachers(fs, backup, plan, st, say);
            else if (st.key === 'config') await restoreConfig(fs, backup, plan, st, me, say);
            else if (st.key === 'schedules') await restoreSchedules(backup, plan, cloud, st, me, say);
            else await restoreRecords(fs, backup, plan, st, say);
            st.status = 'done';
        } catch (e) {
            st.status = 'failed';
            st.error = (e && e.message) || String(e);
            stopped = true;
        }
    }
    return { ok: stages.every(s => s.status === 'done' || s.status === 'skipped'), stages };
}

async function restoreTeachers(fs, backup, plan, st, say) {
    const want = new Set(plan.teachers.create);
    const items = backup.teachers.filter(t => want.has(t.id));
    const withLogin = !!plan.teachers.restoreEmailIndex;
    for (let i = 0; i < items.length; i += RESTORE_TEACHER_BATCH) {
        const chunk = items.slice(i, i + RESTORE_TEACHER_BATCH);
        const batch = fs.writeBatch(fs.db);
        for (const t of chunk) {
            const email = normalizeTeacherEmail(t.data && t.data.email);
            // 登入綁定預設不補回（身分撤銷不可被還原繞過）。rules 的成員判定只看「mapping 指向的教師檔 email
            // 是否等於登入 email」，所以未勾選時連教師檔的 email 也寫成 null（與 createTeacher 的「無信箱」寫法一致）；
            // 原信箱只出現在預覽與結果訊息，由教務主任之後到教師管理填回（updateTeacher 會同時建立 emailIndex）。
            // 使用者在預覽明確勾選才連同 email 與 emailIndex 在同一批提交。
            batch.set(fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(t.id)), { ...t.data, email: withLogin ? email : null });
            if (email && withLogin) batch.set(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(email)), { teacherId: t.id });
        }
        await batch.commit();
        st.done += chunk.length;
        say(`還原教師名冊 ${st.done}/${st.planned}…`);
    }
    st.emailIndexRestored = withLogin;
    st.clearedEmails = withLogin ? [] : (plan.teachers.emailCleared || []);
}

async function restoreConfig(fs, backup, plan, st, me, say) {
    if (plan.config.main === 'create') {
        say('還原學校基本設定…');
        await fs.setDoc(fs.doc(fs.db, SCHEMA_PATHS.config()), backup.config.main);
        st.done++;
    }
    if (plan.config.settlement === 'overwrite') {
        say('還原月結算設定…');
        const s = backup.config.settlement || {};
        await dataSvc.saveSettlementConfig(
            { calendarId: s.calendarId || '', calendarApiKey: s.calendarApiKey || '', weeksByYear: s.weeksByYear || {}, weeklyBaseByTeacher: s.weeklyBaseByTeacher || null },
            me?.email || me?.uid || null,
        );
        st.done++;
    }
}

async function restoreSchedules(backup, plan, cloud, st, me, say) {
    for (const item of plan.schedules) {
        if (item.action !== 'overwrite' && item.action !== 'create') continue;
        const sc = backup.schedules.find(x => x.id === item.semesterId);
        say(`還原「${item.semesterId}」課表…`);
        const { updatedAt, version, ...rest } = sc.data;
        const payload = {
            ...rest,
            meta: { lastAction: 'restored_from_backup', byName: me?.name || '', byTeacherId: me?.teacherId || null, at: new Date().toISOString() },
        };
        const cur = cloud.schedules[item.semesterId];
        await dataSvc.saveSchedule(item.semesterId, payload, {
            // 版本前置條件：以「寫入前剛讀的雲端現況」為準；預覽之後若又有人改了課表就拒寫而不蓋掉
            expected: cur && cur.exists ? { version: cur.version, updatedAt: cur.updatedAt } : null,
            backup: (existing) => buildPreImportBackup(existing, { importedBy: me?.name ? { name: me.name, teacherId: me.teacherId || null } : null }),
        });
        st.done++;
    }
}

async function restoreRecords(fs, backup, plan, st, say) {
    const want = new Set(plan.records.create);
    const items = backup.substituteRecords.filter(r => want.has(r.id));
    for (let i = 0; i < items.length; i += RESTORE_RECORD_BATCH) {
        const chunk = items.slice(i, i + RESTORE_RECORD_BATCH);
        const batch = fs.writeBatch(fs.db);
        for (const r of chunk) {
            // 先 private 後父文件的順序與 createSubstituteRecord 一致（批次內 rules 以提交前狀態評估，
            // parentAllowsNewPrivateDetail 看到父文件不存在即放行）
            if (r.private) batch.set(fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(r.id)), r.private);
            batch.set(fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(r.id)), stripReservedFields(r.data));
        }
        await batch.commit();
        st.done += chunk.length;
        say(`還原調代課紀錄 ${st.done}/${st.planned}…`);
    }
}

/** 還原報告的白話摘要（純文字，多行）。 */
export function describeRestoreReport(report) {
    const lines = [];
    for (const st of report.stages) {
        if (st.status === 'done') {
            lines.push(`✓ ${st.label}：已還原 ${st.done} 項`);
            if (st.key === 'teachers' && st.done > 0) {
                if (st.emailIndexRestored) lines.push('　已一併恢復這些教師的信箱與登入綁定（emailIndex）。');
                else {
                    lines.push('　教師檔已補回，但信箱欄位留空、沒有恢復登入綁定（emailIndex）：這些教師暫時無法登入。需要讓他們登入時，請教務主任到教師管理，把信箱填回該教師。');
                    for (const c of (st.clearedEmails || [])) lines.push(`　　${c.name}：原信箱 ${c.email}`);
                }
            }
        }
        else if (st.status === 'skipped') lines.push(`－ ${st.label}：沒有需要還原的項目`);
        else if (st.status === 'failed') lines.push(`✗ ${st.label}：失敗（已完成 ${st.done}／${st.planned}）— ${st.error}`);
        else lines.push(`… ${st.label}：未執行（${st.planned} 項待還原）`);
    }
    if (!report.ok) lines.push('', '還原沒有全部完成。已寫入的部分不會自動復原；排除問題後可以再執行一次同一份備份，系統只會補上仍缺少的部分。');
    return lines.join('\n');
}
