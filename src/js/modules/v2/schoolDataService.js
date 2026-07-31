/**
 * V2 全校共用資料服務
 *
 * 負責 schools/{schoolId}/ 集合下所有 CRUD 操作。
 * 與舊 DataManager（users/{uid}/data/substituteSystem）完全隔離。
 *
 * 注意：此服務不主動寫入 operationLog，log 由呼叫端（pendingRequestService 等）控制。
 */

import { getV2Firestore } from './firebaseV2.js';
import { SCHEMA_PATHS, REQUEST_STATUS } from './schemaConstants.js';
import * as semesterState from './semesterState.js';

// Stage 1（讀取成本止血，RESEARCH-multitenancy-semester.md §5.4）：即時訂閱的預設分頁大小。
// 報告未給明確數字時的預設值（§8 路線圖 Stage 1 一列）。
const DEFAULT_PAGE_SIZE = 50;

// 「仍在途」的請求狀態：待同意 / 待核准（含 legacy 'pending'，由呼叫端 normalizeLegacyRequest
// 映射）。已核准／已拒絕的請求不需即時監聽——核准後真相已轉移到 substituteRecords，
// 拒絕後只是等發起人按「我知道了」關閉，兩者都不影響「有沒有新的待辦要處理」這件事。
const OPEN_REQUEST_STATUSES = [
    REQUEST_STATUS.PENDING,
    REQUEST_STATUS.PENDING_SWAP_CONSENT,
    REQUEST_STATUS.PENDING_APPROVAL,
];

export function genId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ===== 敏感欄位拆分（假別／事由私有化，Phase 6） =====
 * leaveType / leaveTypeName / reason 屬敏感個資（請假類型可能透露長期病假／喪假等隱私），
 * 一律不落在全校教師皆可讀的父文件（substituteRecords/pendingRequests），改寫入父文件底下
 * 的 private/detail 子文件，並自帶 allowedTeacherIds ACL 清單（比對 firestore.rules 的
 * hasPrivateDetailAccess()，規則不需 get() 父文件即可判斷可讀性）。
 * 排課資訊（誰在哪節代誰的課）維持全校可讀不受影響——代課單本來就是公告性質，
 * 且衝堂檢查與代課推薦需要。
 */
export const SENSITIVE_RECORD_FIELDS = ['leaveType', 'leaveTypeName', 'reason'];

/** 從紀錄本身可辨識的教師 id 欄位彙整出「當事人」清單，做為 substituteRecords private/detail 的 ACL。 */
export function deriveAllowedTeacherIds(record) {
    const ids = [
        record.initiatedBy,
        record.originalTeacherId,
        record.substituteTeacherId,
        record.swapTeacherId,
        record.approvedBy,
    ];
    if (Array.isArray(record.affectedTeacherIds)) ids.push(...record.affectedTeacherIds);
    return [...new Set(ids.filter(Boolean))];
}

/**
 * 把 payload 拆成 { publicPart, privatePart, hasSensitive }。
 * allowedTeacherIds 傳入陣列時才會寫進 privatePart（更新既有私有文件時傳 null/undefined，
 * 避免用 merge 把既有 ACL 覆蓋成空陣列）；hasSensitive 為 false 代表 payload 完全沒有
 * 敏感欄位，呼叫端應略過 private/detail 的寫入（沒有東西需要保護，也不建立空文件）。
 */
export function splitSensitive(payload, allowedTeacherIds) {
    const publicPart  = { ...payload };
    const privatePart = {};
    let hasSensitive = false;
    for (const field of SENSITIVE_RECORD_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(publicPart, field)) {
            privatePart[field] = publicPart[field];
            delete publicPart[field];
            hasSensitive = true;
        }
    }
    if (hasSensitive && Array.isArray(allowedTeacherIds)) {
        privatePart.allowedTeacherIds = [...new Set(allowedTeacherIds.filter(Boolean))];
    }
    return { publicPart, privatePart, hasSensitive };
}

/* ===== Config ===== */

export async function getConfig() {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.config());
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

/**
 * Stage 5 驗收修復（輕12）：與 getConfig() 唯一差異是用 getDocFromServer() 強制繞過本機快取，
 * 保證拿到的是「這一刻伺服器上的真實值」。供 executeSemesterArchiveDelete() 在刪除前的最後
 * 一道「目前作用中學期」確認使用——那個檢查的存在意義就是防「本機看到的狀態是舊的」，若這裡
 * 還是用可能命中快取的 getDoc()，等於防線本身可能被同一個問題（陳舊快取）繞過。一般讀取
 * 路徑（bootstrap、學期切換前檢查等）沒有這麼高的即時性要求，維持用 getConfig()，不需要
 * 每處都改，避免不必要地增加對伺服器的直接依賴（getDocFromServer 在離線時會直接失敗，
 * 不像 getDoc() 離線時還能退回快取）。
 */
export async function getConfigFromServer() {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.config());
    const snap = await fs.getDocFromServer(ref);
    return snap.exists() ? snap.data() : null;
}

export async function upsertConfig(patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.config());
    await fs.setDoc(ref, { ...patch, updatedAt: new Date().toISOString() }, { merge: true });
}

/**
 * 驗收修復（中 3）：訂閱 config/main，供 v2-app.js 偵測「別的裝置/分頁的 director 已切換
 * 學期」並提示使用者重新整理。本機所有訂閱（待辦／全校紀錄／課表）都綁死在 bootstrap 當時
 * 讀到的 semesterId，沒有這條訂閱，切換學期後其他仍開著頁面的使用者不會知道自己看到的是
 * 已經變成唯讀的舊學期資料，寫入操作也會開始被規則拒絕卻不知道原因。
 * 單文件 onSnapshot（config/main），成本可忽略，比照 subscribeSchedule 的既有模式。
 */
export async function subscribeConfig(callback, onError) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.config());
    return fs.onSnapshot(ref, (snap) => {
        callback(snap.exists() ? snap.data() : null);
    }, onError);
}

/* ===== Teachers ===== */

export async function listTeachers() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.teachersCol());
    const snap = await fs.getDocs(col);
    return snap.docs.map(d => ({ teacherId: d.id, ...d.data() }));
}

export async function getTeacher(teacherId) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? { teacherId: snap.id, ...snap.data() } : null;
}

export async function findTeacherByEmail(email) {
    if (!email) return null;
    const normalized = email.toLowerCase().trim();
    const teachers   = await listTeachers();
    return teachers.find(t => (t.email || '').toLowerCase().trim() === normalized) || null;
}

export async function findTeacherByName(name) {
    if (!name) return null;
    const teachers = await listTeachers();
    return teachers.find(t => t.name === name) || null;
}

/* ===== Email Index（首登 email → teacherId 配對，Stage 0 §3.4a） =====
 * schools/{schoolId}/emailIndex/{emailKey}：emailKey = 教師登入 email 小寫。
 * 文件只有 { teacherId }，不含姓名等個資。規則只開放 get（查自己那一份），不開放 list，
 * 故一律用「已知 email 查單一文件」的方式讀取，不會有整包查詢的路徑。
 * 由 createTeacher / updateTeacher(email 異動) / deleteTeacher 同步維護——
 * 驗收修復 S7：teachers 文件與 emailIndex 文件的寫入改用 writeBatch 原子提交，
 * 避免「teachers 寫成功、emailIndex 寫失敗」這種半套狀態（索引與名冊不同步，
 * 會讓該教師首登配對失敗，且不易察覺）。
 */

export async function createTeacher({ name, email = null, domains = [], homeroomClass = '', role = 'teacher' }) {
    if (!name) throw new Error('教師姓名不可為空');

    const fs        = await getV2Firestore();
    const teacherId = genId('tch');
    const now       = new Date().toISOString();
    const ref       = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));

    const data = {
        name,
        email: email ? email.toLowerCase().trim() : null,
        domains: Array.isArray(domains) ? domains : [],
        homeroomClass: homeroomClass || '',
        role,
        createdAt: now,
        updatedAt: now,
    };

    const batch = fs.writeBatch(fs.db);
    batch.set(ref, data);
    if (data.email) {
        batch.set(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(data.email)), { teacherId });
    }
    await batch.commit();

    return { teacherId, ...data };
}

export async function updateTeacher(teacherId, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));

    const clean = { ...patch, updatedAt: new Date().toISOString() };
    const emailChanging = Object.prototype.hasOwnProperty.call(clean, 'email');
    let oldEmail = null;
    if (emailChanging) {
        clean.email = clean.email ? clean.email.toLowerCase().trim() : null;
        // email 有異動：需要先讀舊值才能刪掉舊的 emailIndex 條目（新舊 email 可能不同，
        // 也可能被設為 null 解除綁定）。非 email 異動的呼叫（role/domains/authProvider 等
        // 高頻寫入）不需要這次額外讀取，維持原本零讀取開銷。
        const before = await getTeacher(teacherId);
        oldEmail = before?.email || null;
    }

    const batch = fs.writeBatch(fs.db);
    batch.update(ref, clean);
    if (emailChanging) {
        // §3.4a：emailIndex 由 createTeacher / updateTeacher(email 異動) / deleteTeacher
        // 集中維護，所有呼叫端（assignEmail、importRosterCsv 等）不需各自處理。
        if (oldEmail && oldEmail !== clean.email) {
            batch.delete(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(oldEmail)));
        }
        if (clean.email) {
            batch.set(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(clean.email)), { teacherId });
        }
    }
    await batch.commit();

    return getTeacher(teacherId);
}

export async function deleteTeacher(teacherId) {
    const fs       = await getV2Firestore();
    const ref      = fs.doc(fs.db, SCHEMA_PATHS.teacherDoc(teacherId));
    const existing = await getTeacher(teacherId);

    const batch = fs.writeBatch(fs.db);
    batch.delete(ref);
    if (existing?.email) {
        batch.delete(fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(existing.email)));
    }
    await batch.commit();
}

/** 查自己那一份 email → teacherId 索引。回傳 { teacherId } 或 null（查不到）。 */
export async function getEmailIndexEntry(email) {
    if (!email) return null;
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.emailIndexDoc(email));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

/* ===== Join Attempts（login_denied 改道，Stage 0 §3.4b） =====
 * schools/{schoolId}/joinAttempts/{uid}：doc id 綁 uid，一人一份、可覆寫，
 * 天然限制灌爆量。規則只允許欄位 email/attemptedAt/reason，且驗收修復 S3 後
 * email/attemptedAt/reason 三欄一律要求 `is string`（見 firestore.rules）——
 * 呼叫端一律寫入字串（email 缺省時寫空字串而非 null，避免規則的型別檢查擋下寫入）。
 */
export async function upsertJoinAttempt(uid, { email, reason } = {}) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.joinAttemptDoc(uid));
    const data = {
        // 驗收修復 N3：規則要求 email.size() < 200（firestore.rules），這裡先 slice(0,190)
        // 留一點安全邊界（中英文混雜時 .size() 是 UTF-8 byte 數，不是字元數，190 字元的
        // email 字串換算成 byte 數必然遠低於 200——email 本身幾乎不會出現多位元組字元，
        // 這裡的邊界純粹是防止極端輸入把寫入直接擋在規則層，而不是依賴精準的位元組換算）。
        email: (typeof email === 'string' ? email : '').slice(0, 190),
        attemptedAt: new Date().toISOString(),
        reason: typeof reason === 'string' && reason ? reason : 'no_teacher_match',
    };
    await fs.setDoc(ref, data);
    return data;
}

/**
 * Stage 5（封存匯出，§6.2）：刪除 per-semester 課表文件。只能由呼叫端（v2-app.js 封存流程）
 * 在確認 semesterId 不是目前作用中學期後呼叫——規則層（firestore.rules）本身也擋了
 * `isCurrentSemester(schoolId, semesterId)` 的刪除，這裡不重複驗證，維持單一職責。
 */
export async function deleteScheduleForSemester(semesterId) {
    if (!semesterId) return;
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.scheduleDocForSemester(semesterId));
    await fs.deleteDoc(ref);
}

/**
 * 一次性讀取全部「登入遭拒」紀錄（供 approver 在操作日誌頁瀏覽，Stage 0 驗收修復 S8）。
 * 刻意用 getDocs 而非 onSnapshot——這是低頻查閱的稽核輔助資訊，不需要即時監聽，
 * 避免額外常駐一條訂閱（呼應 §5.4「operationLogs 只在打開頁籤時才讀」的同一精神）。
 */
export async function listJoinAttempts() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.joinAttemptsCol());
    const snap = await fs.getDocs(col);
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

/* ===== Schedule（Stage 2：per-semester 文件，§5.3/§5.6） =====
 * 舊 data/schedule 是單一文件、整份覆寫，換學期即蓋掉舊課表。改為 schedules/{semesterId}，
 * 每學期各自一份文件，歷史學期課表不再被下一次上傳覆蓋。
 *
 * 相容遷移（§5.6「讀取 fallback 或一次性遷移腳本」，本專案兩者都做，互為安全網）：
 *   - scripts/migrate-schedule-to-semester.js：一次性把舊 data/schedule 複製到
 *     schedules/{currentSemester}（--dry-run 預設，只印計畫不寫入）。
 *   - 本檔 getSchedule()/subscribeSchedule() 額外內建讀取 fallback：per-semester 文件
 *     不存在時（例如遷移腳本還沒跑），退回讀舊 data/schedule 一次，避免舊課表在使用者眼中
 *     「突然消失」。fallback 只讀不寫——不會自動把資料搬進新路徑，仍需要遷移腳本或下一次
 *     approver 上傳課表（saveSchedule 一律寫新路徑）才能讓新文件真正建立。
 *
 * ⚠ 驗收修復（中 7）：課表這三支函式（get/save/subscribe）在 semesterId 缺席（未初始化，
 * 例如 semesterState 讀 config 失敗）時**直接拋出明確錯誤**，不會優雅退化——這與
 * subscribeSubstituteRecords 等「查詢」函式不同（那些函式的 semesterId 是可選篩選條件，
 * 缺席時退化成 Stage 1 的無篩選查詢，仍能動作）；課表 per-semester 化後，semesterId 是
 * 「寫到哪一份文件」的必要定址資訊，缺席時沒有安全的預設值可用，寧可讓呼叫端立刻知道
 * 「課表功能現在不可用」，也不要用猜的（例如猜錯學期把課表寫到不該寫的文件）。呼叫端
 * （v2-app.js bootstrap／syncScheduleToV2／clearAllSchoolData／switchToNewSemester）皆已
 * 包在 try/catch 或 safeBootstrapStep 內，錯誤會經 notifyError() 顯示給使用者，不是靜默失敗。
 */

/** 課表 semesterId 缺席時的錯誤，訊息明確說明現況與後續動作，供呼叫端 notifyError() 顯示。 */
function requireScheduleSemesterId(fnName, semesterId) {
    if (semesterId) return;
    throw new Error(
        `${fnName}: 目前學期尚未確定（semesterId 未初始化），課表功能暫時無法使用。` +
        `請重新整理頁面；若持續發生，請確認 schools/{schoolId}/config/main.currentSemester 是否已設定。`
    );
}

export async function getSchedule(semesterId) {
    requireScheduleSemesterId('getSchedule', semesterId);
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.scheduleDocForSemester(semesterId));
    const snap = await fs.getDoc(ref);
    if (snap.exists()) return snap.data();

    // Fallback：per-semester 文件尚未建立，退回讀舊版單一文件（見上方檔頭註解）。
    const legacyRef  = fs.doc(fs.db, SCHEMA_PATHS.scheduleDoc());
    const legacySnap = await fs.getDoc(legacyRef);
    return legacySnap.exists() ? legacySnap.data() : null;
}

/**
 * Stage 5 驗收修復（中4）：封存專用，讀 per-semester 課表文件、**不含** getSchedule() 的
 * legacy fallback。封存需要如實反映「這個學期本身是否真的有一份屬於自己的
 * schedules/{semesterId} 文件」——若沿用含 fallback 的 getSchedule()，某個歷史學期若剛好
 * 命中 fallback（退回讀舊版單一文件 data/schedule，該文件實際上可能是完全不同學期、甚至是
 * Stage 2 上線前「當時的目前學期」留下的內容），會把不屬於這個學期的資料誤植入封存 JSON，
 * 且 meta.counts.hasSchedule 的判斷也會失真（誤判為 true）。
 * 不吞任何錯誤（不像 getSchedule() 的呼叫端過去常見 `.catch(() => null)` 的用法）——
 * 讀取失敗（權限被拒、網路中斷等）代表「不確定這學期到底有沒有課表」，封存匯出鏈的原則是
 * 「任何不確定＝中止」，交由呼叫端的 try/catch 讓整個匯出/核對步驟失敗，不能被本函式吞掉
 * 後續誤判成「這學期沒有課表」。
 */
export async function getScheduleForSemesterStrict(semesterId) {
    requireScheduleSemesterId('getScheduleForSemesterStrict', semesterId);
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.scheduleDocForSemester(semesterId));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

export async function saveSchedule(semesterId, scheduleData) {
    requireScheduleSemesterId('saveSchedule', semesterId);
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.scheduleDocForSemester(semesterId));
    await fs.setDoc(ref, { ...scheduleData, updatedAt: new Date().toISOString() });
}

/**
 * 一次性讀取全部「已知學期」的課表文件 id（供學期選擇器 UI 列出可切換/可瀏覽的學期）。
 * 「已知學期」定義為 schedules/ 底下有文件的學期——「開新學期」SOP（§6.1）在切換時會建立
 * 一份（可能是空殼）schedules/{newId} 文件，故這個集合天然是一份學期註冊表，不需要另外維護
 * 一份 semesters/{id} 標記集合。
 */
export async function listKnownSemesterIds() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.schedulesCol());
    const snap = await fs.getDocs(col);
    return snap.docs.map(d => d.id);
}

/**
 * Stage 5 驗收修復（輕7+8）：一次性讀取全部「已封存」學期 id（archives/ 底下有文件的學期）。
 * 封存刪除流程會把 schedules/{semesterId} 一併刪除（見 deleteScheduleForSemester()），
 * 若學期選擇器只看 listKnownSemesterIds()（schedules/ 集合），已封存學期會在刪除完成的
 * 瞬間從所有下拉選單裡「消失」——不只是封存頁自己選不到，連 director 想確認「這學期封存
 * 紀錄長怎樣」都無路可去（getArchiveRecord() 有 API，但 UI 沒有管道帶使用者選到這個
 * semesterId）。v2-app.js 的 v2ListSemesterOptions() 改為把這支函式的結果也併入選項清單，
 * 讓已封存學期繼續出現在選單中，UI 端據此顯示「此學期已於 {日期} 封存」狀態並停用匯出/
 * 刪除鈕（見 v2-app.js renderArchiveAdminTab()）——雲端資料已被刪除，選單存在的意義只是
 * 讓「已封存」這個狀態本身可見、可查閱封存紀錄本身（筆數、雜湊、執行者、時間），不是讓
 * 使用者以為還能重新匯出當時的資料（那份資料只存在於使用者當初下載的 JSON 檔案裡）。
 */
export async function listArchivedSemesterIds() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.archivesCol());
    const snap = await fs.getDocs(col);
    return snap.docs.map(d => d.id);
}

/* ===== Substitute Records（已成立） ===== */

export async function listSubstituteRecords() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const q    = fs.query(col, fs.orderBy('createdAt', 'desc'));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ recordId: d.id, ...d.data() }));
}

/**
 * 清除流程專用：不帶 orderBy 讀取「全部」已成立紀錄。
 * orderBy('createdAt') 會把缺該欄位的舊文件排除在查詢結果外（Firestore 對排序欄位的既有
 * 行為），一般列表使用場景可接受，但「清除所有資料」必須刪光每一筆、不能漏掉排序鍵缺欄位
 * 的舊資料，故另開此函式；不動既有 listSubstituteRecords()，其他呼叫端仍需要依 createdAt
 * 排序的列表。
 */
export async function listAllSubstituteRecordsForClear() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const snap = await fs.getDocs(col);
    return snap.docs.map(d => ({ recordId: d.id, ...d.data() }));
}

/**
 * Stage 1（讀取成本止血，§5.4）：一次性分頁讀取已成立紀錄，供「調代課紀錄」頁籤
 * 「最近 N 筆＋載入更多」列表使用。
 *
 * 驗收修復（輕 #10）：cursor 改用 Firestore 原生 QueryDocumentSnapshot（而非值游標），
 * 避免兩筆紀錄 createdAt 完全相同（同毫秒建立）時，純值游標 `startAfter(value)` 沒有
 * 文件 ID 當 tiebreaker、可能漏掉或重複跳過同值的其中一筆。不用 offset——Firestore 對
 * offset 跳過的文件一樣計費讀取，官方建議改用 cursor 分頁（報告 §5.4 引用 [S23]）。
 *
 * @param {{pageSize?: number, afterCursor?: import('firebase/firestore').QueryDocumentSnapshot|null}} opts
 * @returns {Promise<{records: Array, nextCursor: object|null, hasMore: boolean}>}
 *   nextCursor 是原生 QueryDocumentSnapshot（或 null），呼叫端應原樣保存、原樣傳回，不要
 *   從中萃取欄位值自行組游標。
 */
// Stage 2（§5.4「紀錄頁預設視圖」查詢下推）：預設一律只查「當前學期」——與
// subscribeSubstituteRecords 的即時視窗是同一份資料的分頁延伸（見 v2-app.js
// loadMoreRecordsTabPage 接續同一個 cursor），兩者的學期範圍必須一致，否則「載入更多」
// 會在使用者不知情的狀況下把上一學期的紀錄混進同一份列表，違背「歷史學期唯讀、需另外
// 明確切換檢視」的設計（§6.1）。semesterId 未帶時退回 semesterState 快取的目前學期。
export async function listSubstituteRecordsPage({ pageSize = DEFAULT_PAGE_SIZE, afterCursor = null, semesterId = semesterState.getCurrentSemesterId() } = {}) {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const constraints = [fs.orderBy('createdAt', 'desc')];
    if (semesterId) constraints.unshift(fs.where('semesterId', '==', semesterId));
    if (afterCursor) constraints.push(fs.startAfter(afterCursor));
    constraints.push(fs.limit(pageSize));
    const q      = fs.query(col, ...constraints);
    const snap   = await fs.getDocs(q);
    const records = snap.docs.map(d => ({ recordId: d.id, ...d.data() }));
    return {
        records,
        nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : afterCursor,
        hasMore:    records.length === pageSize,
    };
}

/**
 * Stage 2（§5.4「歷史學期」列，§6.1 SOP）：一次性讀取「指定學期」的全部已成立紀錄，供
 * 紀錄頁「歷史學期」檢視使用——與 listSubstituteRecordsPage()（當前學期、分頁）不同，
 * 歷史學期已鎖定不再有新資料（規則層唯讀鎖，見 §6.1），故一次性 getDocs 即可，不需分頁，
 * 呼叫端（v2-app.js）自行做記憶體快取（key 帶 semesterId），同一 session 內不重打。
 * orderBy('date') 而非 createdAt——歷史瀏覽以「上課日期」排序對使用者更直覺，且此函式
 * 不需要與即時訂閱視窗共用 cursor（不像 listSubstituteRecordsPage 需要對齊 createdAt 排序）。
 */
export async function listSubstituteRecordsBySemester(semesterId) {
    if (!semesterId) return [];
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const q    = fs.query(col, fs.where('semesterId', '==', semesterId), fs.orderBy('date', 'desc'));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ recordId: d.id, ...d.data() }));
}

/**
 * Stage 5（封存匯出，§6.2）：一次性讀取「指定學期」的全部已成立紀錄，供匯出／刪除前
 * 重新計數使用。刻意不帶 orderBy——封存匯出與筆數核對都只在乎「有哪些文件」，不在乎順序，
 * 省下一條複合索引相依（listSubstituteRecordsBySemester 的 orderBy('date') 需要
 * semesterId+date 複合索引；這裡只用 where 單欄位相等，屬 Firestore 自動建立的單欄位索引，
 * 不需要額外部署任何索引）。與 listSubstituteRecordsBySemester 分開維護：後者是「歷史學期
 * 檢視」UI 用途，語意上需要穩定排序；這支是封存用途的計數/匯出，語意上不需要。
 */
export async function listSubstituteRecordsBySemesterForArchive(semesterId) {
    if (!semesterId) return [];
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const q    = fs.query(col, fs.where('semesterId', '==', semesterId));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ recordId: d.id, ...d.data() }));
}

/**
 * Stage 5（封存匯出，§6.2）：一次性讀取「指定學期」的全部待審請求（不分狀態——封存需要
 * 完整保存，不只是仍在途的那幾筆）。理由與 listSubstituteRecordsBySemesterForArchive 相同：
 * 不帶 orderBy，只用單欄位 where，不需要額外複合索引。
 */
export async function listPendingRequestsBySemesterForArchive(semesterId) {
    if (!semesterId) return [];
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const q    = fs.query(col, fs.where('semesterId', '==', semesterId));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ reqId: d.id, ...d.data() }));
}

/**
 * Stage 5（封存匯出，§6.2）：一次性讀取「指定學期」的全部操作日誌。同上不帶 orderBy、
 * 不需要額外複合索引。注意：只有 Stage 2 之後（或已跑過 `scripts/backfill-semester-id.js`
 * 回填）的日誌才帶 semesterId 欄位，回填前的舊日誌不會被這支查詢比對到——封存 UI 需要
 * 對此如實提示，見 v2-app.js renderArchiveAdminTab() 的說明文字。
 */
export async function listLogsBySemesterForArchive(semesterId) {
    if (!semesterId) return [];
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.logsCol());
    const q    = fs.query(col, fs.where('semesterId', '==', semesterId));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ logId: d.id, ...d.data() }));
}

/**
 * Stage 1 修復（阻斷 #1）：衝堂檢查（v2CheckExistingRecord）按日期一次性查詢已成立紀錄，
 * 取代原本只看即時訂閱視窗（最近 N 筆）的作法——提前 2 週以上建立的紀錄不在視窗內，
 * 漏檢會造成同節課重複建檔、月結算重複計費，是正確性 bug 不是效能問題。
 * 單欄位相等查詢（date），屬 Firestore 自動建立的單欄位索引，不需複合索引。
 * period/className/originalTeacher 由呼叫端在記憶體中比對（單日筆數天生有界，可忽略成本）。
 *
 * Stage 2 查詢下推檢討（§5.4）：刻意不疊加 `where('semesterId','==',cur)`——單一 `date`
 * 值透過 semesterUtils.dateToSemesterId() 可確定性地映射到唯一一個學期，同一日期不可能
 * 同時屬於兩個學期，加上 semesterId 條件不會改變結果集，只會多疊一個複合索引（date+semesterId）
 * 換取零實質效益。維持單欄位查詢，不需額外索引。
 */
export async function queryRecordsByExactDate(date) {
    if (!date) return [];
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const q    = fs.query(col, fs.where('date', '==', date));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ recordId: d.id, ...d.data() }));
}

/**
 * Stage 1 修復（阻斷 #1）：同上，pendingRequests 版本。刻意只用 `where('date','==',date)`
 * 單欄位查詢（不疊加 status 條件），狀態篩選留給呼叫端在記憶體中做——若在查詢裡疊加
 * `where('status','in',[...])` 會變成兩個不同欄位的條件組合，需要額外複合索引；單日的
 * pendingRequests 筆數天生有界，記憶體篩選成本可忽略，用這個寫法換取「零新增複合索引」。
 * Stage 2：同 queryRecordsByExactDate，不疊加 semesterId 條件，理由相同（見該處註解）。
 */
export async function queryPendingRequestsByExactDate(date) {
    if (!date) return [];
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const q    = fs.query(col, fs.where('date', '==', date));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ reqId: d.id, ...d.data() }));
}

/** 今天的 YYYY-MM-DD（本機時區）。 */
function todayDateString() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 當前學年度起日（西元，YYYY-08-01）。台灣學年度 8 月開學，1-7 月屬前一學年度。 */
function currentAcademicYearStartDate() {
    const d = new Date();
    const y = d.getFullYear();
    const startYear = (d.getMonth() + 1) >= 8 ? y : y - 1; // getMonth() 0-based
    return `${startYear}-08-01`;
}

/** dateStr（YYYY-MM-DD）的年份加上 years（可負）。格式不對就原樣回傳（不噴錯，交給呼叫端
 * 的字串比較自然得出「查不到」，不會是更難查的例外）。 */
function addYearsToDateString(dateStr, years) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return dateStr;
    const [, y, mo, da] = m;
    return `${Number(y) + years}-${mo}-${da}`;
}

/**
 * 驗收修復（中 #B）：把「日期範圍缺一端時該怎麼補」抽成獨立、同步的純函式——原本的實作
 * （見下方 queryRecordsByDateRange 的舊版註解）方向錯了：
 *   - 只給 startDate 時，原本把缺席的 endDate 夾成「今天」——但調代課紀錄本來就可能是
 *     預先排定的未來日期，只查「起日～今天」會把未來日期的紀錄全部漏掉。
 *   - 只給 endDate 時，原本把缺席的 startDate 夾成「當前學年度起日」——若使用者查詢的
 *     endDate 早於當前學年度起日（例如查前一學年度的某個月），會產生
 *     effectiveStart > effectiveEnd 這種恆 0 筆的查詢，而且完全沒有任何提示，使用者只會
 *     看到「查無紀錄」，以為是真的沒有資料。
 * 修正為「以有給的那一端為基準，往缺席的方向推一年」：
 *   - 只有 startDate → endDate = startDate + 1 年（往未來延伸，涵蓋預先排定的紀錄）。
 *   - 只有 endDate → startDate = endDate − 1 年（往過去延伸）。
 *   - 兩端都有 → 原樣使用，不做任何調整（呼叫端自己決定的範圍，交由 valid 判斷是否顛倒）。
 *   - 兩端都沒有 → 退回「當前學年度起日～今天」這組保守預設（目前的呼叫端在兩端皆缺席時
 *     都會在更早的邏輯分支就走同步視窗版，理論上不會落到這裡；這裡的 fallback 純屬防禦）。
 *
 * 回傳的 `valid` 讓呼叫端能在真正發送查詢之前（甚至不必打 Firestore）判斷範圍是否有效
 * （effectiveStart <= effectiveEnd），無效時應提示使用者「範圍無效」，不要讓查詢默默回
 * 0 筆、被誤讀成「真的沒有資料」。
 * @returns {{ effectiveStart: string, effectiveEnd: string, valid: boolean }}
 */
export function resolveDateRangeBounds({ startDate = null, endDate = null } = {}) {
    let effectiveStart = startDate;
    let effectiveEnd   = endDate;
    if (startDate && !endDate) {
        effectiveEnd = addYearsToDateString(startDate, 1);
    } else if (endDate && !startDate) {
        effectiveStart = addYearsToDateString(endDate, -1);
    } else if (!startDate && !endDate) {
        effectiveStart = currentAcademicYearStartDate();
        effectiveEnd   = todayDateString();
    }
    return { effectiveStart, effectiveEnd, valid: effectiveStart <= effectiveEnd };
}

/**
 * Stage 1（§5.6）：依日期範圍一次性查詢已成立紀錄，供月結算／週彙整 PDF／紀錄頁日期篩選
 * 在目標範圍落在即時訂閱視窗（最近 N 筆）之外時使用。range 條件與 orderBy 同一欄位
 * （date），屬 Firestore 自動建立的單欄位索引即可涵蓋，不需額外複合索引。
 *
 * 驗收修復（中 #5，方向於 #B 訂正）：startDate／endDate 任一端缺席時，用
 * resolveDateRangeBounds() 補上缺席的一端，不再讓查詢對整個集合做無界 range scan；
 * `valid === false`（算出來的範圍起 > 迄，通常是呼叫端兩端都給了但順序顛倒）時短路
 * 回傳空陣列、不發送查詢（呼叫端若要對使用者顯示「範圍無效」提示，應直接呼叫
 * resolveDateRangeBounds() 自行同步判斷，不需要先跑一次注定 0 筆的非同步查詢才知道）。
 *
 * Stage 2 查詢下推檢討（§5.4/§5.6）：刻意不疊加 `where('semesterId','==',cur)`。
 * 驗收修復（輕 10）：原註解主張「月結算查一個月、週彙整查一週，兩者都不可能跨學期邊界」，
 * 這個理由在週彙整上是錯的——學期邊界落在 1/31→2/1 與 7/31→8/1，「一個月」的查詢範圍
 * （`getMonthDateRange()` 產出 `YYYY-MM-01` ~ `YYYY-MM-31`，恆落在單一西曆月份內）確實不會
 * 跨過這兩個邊界；但「一週」是以 7 天為單位的滾動區間，不受曆月邊界約束，例如
 * 2026-01-26（一）～2026-02-01（日）這一週就會同時涵蓋 1/31 與 2/1，橫跨兩個學期。
 * 即使如此，**結論依然不變、且理由更充分**：`queryRecordsByDateRange` 用 `date` 欄位做
 * range query，比對的是「上課日期」本身，與該筆紀錄的 `semesterId` 衍生欄位無關——
 * 一週橫跨學期邊界時，這一週內兩個學期各自的紀錄本來就都應該出現在週彙整結果裡（範例：
 * 1/31 是上學期最後一個上課日、2/1 是下學期第一個上課日，同一週的週彙整理應同時列出兩天
 * 的調代課）。若疊加 `semesterId==目前學期` 條件，會把橫跨邊界那一週裡「屬於舊學期那幾天」
 * 的合法紀錄整批濾掉——這是會產生錯誤結果的 bug，不只是「不必要的最佳化」。日期範圍
 * range query 本身在語意上就是正確、完整的，不需要也不應該疊加 semesterId 條件。
 */
export async function queryRecordsByDateRange({ startDate = null, endDate = null } = {}) {
    const { effectiveStart, effectiveEnd, valid } = resolveDateRangeBounds({ startDate, endDate });
    if (!valid) return [];
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const q    = fs.query(
        col,
        fs.where('date', '>=', effectiveStart),
        fs.where('date', '<=', effectiveEnd),
        fs.orderBy('date', 'desc'),
    );
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ recordId: d.id, ...d.data() }));
}

export async function getSubstituteRecord(recordId) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? { recordId: snap.id, ...snap.data() } : null;
}

// Stage 2（§6.1）：substituteRecords 的建立規則會鎖 `semesterId == config.currentSemester`，
// 故「寫入當下的目前學期」是新紀錄唯一合法的 semesterId 值——不是紀錄本身 date 欄位推算出的
// 學期（date 可能是預先排定的未來日期，甚至落在下一學期；此時仍應歸屬「這筆業務發生／核准
// 的當下」所屬學期，不是「課會在哪天上」所屬學期）。呼叫端已明確帶 semesterId 時尊重原值——
// 目前唯一的例外呼叫端是 legacyMigrationService（歷史資料，semesterId 依 date 反推，且
// isLegacy=true 於規則層豁免此鎖，見 firestore.rules 與 legacyMigrationService.js）。
export async function createSubstituteRecord(record) {
    const fs       = await getV2Firestore();
    const recordId = genId('rec');
    const now      = new Date().toISOString();
    const semesterId = record.semesterId || semesterState.getCurrentSemesterId();
    // 驗收修復（中 7）：semesterState 尚未初始化（例如 bootstrap 的「學期設定」步驟失敗）時，
    // 不要送出一筆帶 semesterId:null 的寫入去讓 Firestore 規則模糊地拒絕——那樣使用者只會
    // 看到不明所以的 permission-denied。改為 client 端先明確擋下並給出可理解的錯誤訊息。
    if (!semesterId) {
        throw new Error('createSubstituteRecord: 目前學期尚未確定，無法建立紀錄。請重新整理頁面後再試一次。');
    }
    const base     = { ...record, semesterId, createdAt: record.createdAt || now, approvedAt: record.approvedAt || now };

    const allowedTeacherIds = deriveAllowedTeacherIds(base);
    const { publicPart, privatePart, hasSensitive } = splitSensitive(base, allowedTeacherIds);

    // 先寫 private 再寫父文件：private 寫入失敗就中止，不會留下「父文件存在但假別／事由
    // 遺失」的狀態（假別遺失會讓月結算把不扣減的假別誤算為扣減）。沒有敏感欄位時（例如
    // 內容本來就不含 leaveType/reason）略過 private 寫入，不建立空文件。
    if (hasSensitive) {
        const detailRef = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId));
        await fs.setDoc(detailRef, privatePart);
    }
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    await fs.setDoc(ref, publicPart);

    return { recordId, ...base };
}

export async function updateSubstituteRecord(recordId, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    const now = new Date().toISOString();

    // Stage 2（§6.1）：semesterId 建立後不可變（規則層鎖 update 的 semesterId 需與現值相同）。
    // 防禦性清掉 patch 內可能誤帶的 semesterId，避免呼叫端不慎傳入時被規則擋下整筆更新——
    // 目前沒有任何呼叫端會這麼做，這裡純屬防禦。
    const cleanPatch = { ...patch };
    delete cleanPatch.semesterId;

    // allowedTeacherIds 傳 null：只有 patch 片段、資訊不足以重算完整當事人清單，
    // 也不該重算——ACL 應維持建立時的當事人清單，merge:true 只更新敏感文字欄位本身。
    const { publicPart, privatePart, hasSensitive } = splitSensitive(cleanPatch, null);

    if (hasSensitive) {
        const detailRef = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId));
        await fs.setDoc(detailRef, privatePart, { merge: true });
    }
    await fs.updateDoc(ref, { ...publicPart, updatedAt: now });

    const updated = await getSubstituteRecord(recordId);
    return hasSensitive ? { ...updated, ...privatePart } : updated;
}

export async function deleteSubstituteRecord(recordId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));
    await fs.deleteDoc(ref);
}

/**
 * 刪除紀錄的私有明細子文件（假別／事由）。批次清除（如「清除所有資料」）需在刪除父文件
 * 前先呼叫，避免留下無父文件可依附的孤兒 private/detail。文件不存在時 deleteDoc 為 no-op，
 * 呼叫端不必先判斷該筆紀錄是否真的有敏感欄位。
 */
export async function deleteSubstituteRecordDetail(recordId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId));
    await fs.deleteDoc(ref);
}

/**
 * 把待刪除的 doc 參照依「筆」分塊（每個元素是同一筆紀錄要一起刪除的 ref 陣列，例如
 * `[detailRef, parentRef]` 或只有 `[parentRef]`），依序用 writeBatch 提交。
 *
 * Stage 5 驗收修復（輕9）：改以「筆」為分塊單位，不是攤平成一條 ref 陣列後按固定數量切。
 * 舊版（`batchDeleteRefs(fs, refs)`）能安全運作的前提是「每筆恆貢獻 2 個 ref、且固定以
 * [detail, parent] 的順序相鄰 push」——此時只要 CHUNK_SIZE 取偶數，切塊必然落在每一對的
 * 邊界上，不會把同一筆的 detail 與 parent 切進不同批次。Stage 5 新增 `*KnownDetail` 系列
 * 函式後（見下方），沒有 private/detail 的紀錄只貢獻 1 個 ref，每筆的 ref 數變成 1 或 2
 * 不固定，「CHUNK_SIZE 為偶數」這個前提直接失效——攤平陣列裡兩個相鄰 ref 有可能剛好分屬
 * 不同筆，此時固定數量切塊完全有可能把「某筆的 detail」切進上一批、「同一筆的 parent」
 * 切進下一批。改成本函式這種「以筆為單位分塊」後，同一筆的所有 ref 保證落在同一個
 * writeBatch（同一個 batch 內的操作是原子提交，不會有「detail 刪了、parent 沒刪」的半套
 * 狀態），與筆內貢獻幾個 ref 無關。
 *
 * Stage 5 驗收修復（輕4，opus 二輪驗收）：分塊依「累計操作數」而非「累計筆數」——原版用
 * 固定 `CHUNK_SIZE_ITEMS=200`（筆）粗略假設「每筆最多 2 個 ref，200×2=400 ≤ 500」，這個
 * 假設只在目前所有呼叫端都是「每筆最多 1 或 2 個 ref」時成立；一旦未來某個呼叫端傳入
 * 「每筆 ref 數超過 2」的分組（例如某筆牽涉更多子文件），200 筆可能就超過 Firestore
 * 單一 batch 500 筆寫入的硬上限，直接被拒絕。改為逐筆累加「這個 batch 已經有幾個 op」，
 * 累加後會超過 `MAX_OPS_PER_BATCH`（500，Firestore 官方硬上限）才切下一個 batch——
 * 同一筆的所有 ref 仍保證落在同一個 batch（分塊判斷永遠發生在「加入這一筆之前」，不會攔腰
 * 切開單一筆的 ref 陣列），不受「每筆固定幾個 ref」這個假設影響。
 * 已知限制（不在本次處理範圍）：若單一筆本身的 ref 數就超過 500（目前所有呼叫端最多 2 個，
 * 不會發生），該筆會單獨佔滿一整個 batch 並在 `commit()` 時被 Firestore 拒絕——這種情況
 * 代表資料模型本身已經超出「一筆紀錄」該有的複雜度，不是分塊策略能解決的問題。
 *
 * 分塊之間循序 await（不並行送出下一塊），理由同舊版：避免對上百筆文件同時發動大量併發
 * 寫入請求。對不存在的文件呼叫 batch.delete() 是 no-op，呼叫端不必先判斷文件是否存在。
 * @param {import('./firebaseV2.js').FirestoreHelpers} fs
 * @param {Array<Array<object>>} refGroups
 */
async function batchDeleteRefGroups(fs, refGroups) {
    const MAX_OPS_PER_BATCH = 500; // Firestore 單一 batch 寫入操作數硬上限
    let batch = fs.writeBatch(fs.db);
    let opsInBatch = 0;
    for (const group of refGroups) {
        if (opsInBatch > 0 && opsInBatch + group.length > MAX_OPS_PER_BATCH) {
            await batch.commit();
            batch = fs.writeBatch(fs.db);
            opsInBatch = 0;
        }
        group.forEach(ref => batch.delete(ref));
        opsInBatch += group.length;
    }
    if (opsInBatch > 0) await batch.commit();
}

/**
 * 批次刪除多筆已成立紀錄（含各自的 private/detail 子文件），供「清除所有資料」使用。
 * 取代原本「每筆各自 Promise.all 兩次 deleteDoc」的寫法（驗收缺陷 #7：無批次上限、
 * 百筆併發）；改用 writeBatch 分塊循序提交，見 batchDeleteRefGroups()。
 * 這裡不知道哪些紀錄真的有 private/detail（呼叫端如「清除所有資料」通常沒有這個資訊、
 * 也不值得為了省幾次 no-op 刪除多做一輪查詢），固定每筆都刪 [detailRef, parentRef]；
 * 若某筆其實沒有 private/detail，對應的 batch.delete() 是 no-op（見上方註解）。封存流程
 * 若已經知道哪些紀錄有 detail，改用下方 deleteSubstituteRecordsBatchKnownDetail()。
 */
export async function deleteSubstituteRecordsBatch(recordIds) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) return;
    const fs   = await getV2Firestore();
    const groups = recordIds.map(id => [
        fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(id)),
        fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(id)),
    ]);
    await batchDeleteRefGroups(fs, groups);
}

/**
 * Stage 5 驗收修復（輕10）：deleteSubstituteRecordsBatch() 的「已知哪些筆有 detail」版本——
 * 只有 `idsWithDetail` 內的 id 才會把 detail ref 加入刪除清單，其餘紀錄只刪父文件，避免對
 * 「本來就沒有 private/detail 的紀錄」發送必然 no-op 的刪除請求（no-op 刪除雖然不會報錯，
 * 但仍是一次真實的寫入操作、佔用批次額度與計費，見 RESEARCH-multitenancy-semester.md §6.2
 * 陷阱二引用的 [S24]：no-op 刪除仍計費）。封存流程（executeSemesterArchiveDelete）在匯出
 * 當下已經知道哪些紀錄真的有 private/detail（getRecordDetailsBulk() 回傳的 Map 的 key 集合），
 * 把這份資訊原樣帶到刪除步驟即可，不需要重新查一次。
 * @param {string[]} recordIds 全部要刪除的紀錄 id
 * @param {Set<string>|string[]} idsWithDetail 其中「已知有 private/detail」的 id 子集合
 */
export async function deleteSubstituteRecordsBatchKnownDetail(recordIds, idsWithDetail) {
    if (!Array.isArray(recordIds) || recordIds.length === 0) return;
    const withDetail = idsWithDetail instanceof Set ? idsWithDetail : new Set(idsWithDetail || []);
    const fs   = await getV2Firestore();
    const groups = recordIds.map(id => {
        const parentRef = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(id));
        return withDetail.has(id) ? [fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(id)), parentRef] : [parentRef];
    });
    await batchDeleteRefGroups(fs, groups);
}

/**
 * 讀取紀錄的私有明細（leaveType/leaveTypeName/reason）。權限不足（非當事人、非 approver）
 * 或文件不存在時一律回傳 null，不拋錯——教師讀不到別人的明細屬預期行為，呼叫端應以
 * `detail?.leaveType ?? record.leaveType` 相容舊資料（既有紀錄的三個欄位仍留在父文件上）。
 */
export async function getRecordDetail(recordId) {
    try {
        const fs   = await getV2Firestore();
        const ref  = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId));
        const snap = await fs.getDoc(ref);
        return snap.exists() ? snap.data() : null;
    } catch (_) {
        return null;
    }
}

/**
 * 判斷一次 Firestore 讀取失敗是否屬於「讀不到很正常」的情況——權限不足（不是當事人/approver）
 * 或文件真的不存在。這兩種是預期行為，不代表資料有問題。其餘錯誤（網路中斷、逾時、未知
 * 服務錯誤等）代表「不確定這份 detail 到底存不存在／內容是什麼」，不應該被當成「沒有」處理。
 */
function isBenignReadError(err) {
    const code = err && err.code;
    return code === 'permission-denied' || code === 'not-found';
}

/**
 * Stage 5 驗收修復（輕3，opus 二輪驗收）：封存匯出鏈「零容忍」批次讀取的共用實作，供
 * getRecordDetailsBulkStrict()/getRequestDetailsBulkStrict() 呼叫。
 *
 * 用 `Promise.allSettled` 而非 `Promise.all`——`Promise.all` 在多筆同時 reject 時，只有
 * 第一個 reject 會被外層 `await` 接住並拋出；其餘「之後才 reject」的 promise 沒有任何
 * `.catch()` 處理它們各自的結果，會被 JS runtime 記成 unhandled rejection（瀏覽器 console
 * 印出一堆噪音，某些環境下甚至視為未捕捉例外，干擾排查真正的錯誤原因）。改用
 * `allSettled` 讓所有 promise 都跑到底、每個都有明確的 fulfilled/rejected 結果，彙整後只把
 * 「第一個」失敗原因丟出去給呼叫端——呼叫端（collectSemesterArchiveData）只在乎「有沒有
 * 失敗、要不要中止匯出」，不需要每個失敗原因都個別呈現。
 * @param {object} fs getV2Firestore() 回傳值
 * @param {string[]} ids
 * @param {(id: string) => object} refFn 依 id 組出文件參照
 * @returns {Promise<Map<string, object>>}
 */
async function settleStrictDocReads(fs, ids, refFn) {
    const settled = await Promise.allSettled(ids.map(async (id) => {
        const snap = await fs.getDoc(refFn(id));
        return snap.exists() ? { id, data: snap.data() } : null;
    }));
    const firstFailure = settled.find(s => s.status === 'rejected');
    if (firstFailure) throw firstFailure.reason;
    const result = new Map();
    for (const s of settled) {
        if (s.value) result.set(s.value.id, s.value.data);
    }
    return result;
}

/**
 * 批次讀取多筆紀錄的私有明細，回傳 Map<recordId, detail>。
 *
 * Stage 5 驗收修復（阻斷1，opus 驗收，fail-open）：原版透過 getRecordDetail() 取值，該函式
 * 用 `catch (_) { return null; }` 吞掉**所有**錯誤，包含網路中斷、逾時等「讀不到不代表沒有」
 * 的情況——對一般 UI 顯示（例如紀錄列表順手補顯示假別）這是合理的容錯（讀不到就先不顯示，
 * 使用者可以重整重試），但對封存匯出鏈是嚴重問題：若某筆讀取因網路瞬斷而失敗，卻被吞成與
 * 「這筆本來就沒有 private/detail」完全無法區分的結果，匯出會誤判成完整，讓一份殘缺的匯出
 * 通過雜湊驗證，之後還被拿去當作「已完整封存」的依據去執行刪除——資料就這樣不可逆地遺失
 * 了一部分。
 * 改為本函式自行呼叫 getDoc()（不透過會吞錯的 getRecordDetail()），只有 `isBenignReadError()`
 * 判定為「讀不到很正常」的錯誤才略過該筆；其餘錯誤直接 rethrow，中止整個批次讀取，讓呼叫端
 * （collectSemesterArchiveData）的 try/catch 接住並讓整個匯出步驟失敗——與封存匯出鏈
 * 「任何不確定＝中止」的原則一致。singular 版本 getRecordDetail() 本身維持不變（它有其他
 * 一般 UI 呼叫端，例如 v2-app.js 顯示單筆紀錄明細，那些情境下「讀不到就先不顯示」仍是合理、
 * 不該改的既有行為）。
 * ⚠ 完整性保證的實際機制：本函式（及下方 Strict 版本）**不**依賴任何「這筆紀錄本來就該有
 * detail」的獨立旗標比對——`hasSensitive` 只是 `splitSensitive()` 在寫入當下的暫時判斷，
 * 從未落盤成一個可回頭查詢的欄位，讀取路徑上不存在這種基準可比對。真正保證完整性的是讀取
 * 本身的語意：`getDoc()` 對「文件不存在」不是錯誤（`snap.exists()===false` 正常回傳），
 * 只有這種情況才代表「這筆真的沒有 detail」；其餘任何錯誤都視為不確定並中止整個匯出。
 */
export async function getRecordDetailsBulk(recordIds) {
    const ids = Array.isArray(recordIds) ? [...new Set(recordIds.filter(Boolean))] : [];
    const fs = await getV2Firestore();
    const result = new Map();
    await Promise.all(ids.map(async (id) => {
        const ref = fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(id));
        try {
            const snap = await fs.getDoc(ref);
            if (snap.exists()) result.set(id, snap.data());
        } catch (err) {
            if (isBenignReadError(err)) return;
            throw err;
        }
    }));
    return result;
}

/**
 * Stage 5 驗收修復（阻斷1，opus 驗收）：getRecordDetailsBulk() 的「零容忍」版本，只給封存
 * 匯出鏈（collectSemesterArchiveData）使用。
 *
 * 一般版 getRecordDetailsBulk() 把 permission-denied 歸類為「讀不到很正常」而略過——這對
 * 一般 UI 情境（例如一般教師被 hydrateRecordsWithDetail() 拿去補顯示紀錄列表）是合理容錯：
 * 一位教師本來就讀不到跟自己無關的紀錄明細，這是預期行為。但封存匯出鏈的呼叫者恆是
 * director（`isDirector()` 蘊含 `isApprover()`），而 `hasPrivateDetailAccess()` 對 approver
 * 是無條件放行（規則第一個 OR 分支，不看 allowedTeacherIds）——對 director 而言，讀自己
 * 學校任何一筆 substituteRecords/{id}/private/detail **結構上不可能合法地得到
 * permission-denied**。若在封存匯出過程中真的發生，代表出現了應用層假設與實際狀態不一致的
 * 異常情況，必須讓整個匯出中止，不能被靜默略過、當成「這筆本來就沒有 private/detail」處理
 * ——否則會讓一份實際殘缺的匯出通過後續的雜湊驗證，之後還被拿去當作「已完整封存」的依據
 * 執行刪除，資料就這樣不可逆地遺失一部分。
 *
 * 因此本函式**不吞任何錯誤**：`getDoc()` 對「文件不存在」本來就不是錯誤（`snap.exists()`
 * 正常回傳 `false`，不會走進 catch），只有這種情況才代表「這筆真的沒有 private/detail」；
 * 其餘任何錯誤（含理論上不該發生的 permission-denied、網路中斷等）一律讓 Promise.all
 * reject，由呼叫端（collectSemesterArchiveData 的 try/catch）接住並中止整個匯出步驟。
 */
export async function getRecordDetailsBulkStrict(recordIds) {
    const ids = Array.isArray(recordIds) ? [...new Set(recordIds.filter(Boolean))] : [];
    const fs  = await getV2Firestore();
    return settleStrictDocReads(fs, ids, (id) => fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(id)));
}

/* ===== Pending Requests（待同意） ===== */

// Stage 1（讀取成本止血）起，v2-app.js 主流程已改用 listOpenPendingRequests()／
// listPendingRequestsByInitiator()（見下方），不再呼叫這支整集合無界讀取。保留匯出
// 供未來需要「一次拿到全部待審請求」的場景使用（例如 legacyMigrationService.js 的對應
// substituteRecords 版本 listSubstituteRecords() 就是這種低頻一次性用途），目前無呼叫端。
export async function listPendingRequests() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const q    = fs.query(col, fs.orderBy('createdAt', 'desc'));
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ reqId: d.id, ...d.data() }));
}

/** 清除流程專用：不帶 orderBy 讀取「全部」待審請求。理由同 listAllSubstituteRecordsForClear()。 */
export async function listAllPendingRequestsForClear() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const snap = await fs.getDocs(col);
    return snap.docs.map(d => ({ reqId: d.id, ...d.data() }));
}

/**
 * Stage 1（§5.4）：一次性讀取「仍在途」的待審請求（待同意／待核准），行為與
 * subscribePendingRequests 的 where 條件一致，供 bootstrap 初次塞 cache 用
 * （不用 onSnapshot 首次快照前的空窗期）。
 * Stage 2：加 semesterId==目前學期條件，理由與 subscribePendingRequests 相同（見該處註解）。
 */
export async function listOpenPendingRequests(semesterId = semesterState.getCurrentSemesterId()) {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const constraints = [
        fs.where('status', 'in', OPEN_REQUEST_STATUSES),
        fs.orderBy('createdAt', 'desc'),
    ];
    if (semesterId) constraints.unshift(fs.where('semesterId', '==', semesterId));
    const q    = fs.query(col, ...constraints);
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ reqId: d.id, ...d.data() }));
}

/**
 * Stage 1（§5.4）：單一教師發起過的全部請求（含已核准／已拒絕的歷史），供「待辦」頁籤
 * 「我的申請」區塊使用。這段歷史對全校規模是無界的，但限定到「單一教師」天然有界
 * （一人不會累積出全校等級的請求量），故用一次性按需查詢取代原本對整個 pendingRequests
 * 集合的無界讀取。
 * Stage 2：刻意不加 semesterId 條件——這裡的用途本來就是「看自己橫跨學期的完整申請
 * 歷史」（docstring 明寫「含已核准／已拒絕的歷史」），加上學期限制會違背這支函式存在的
 * 目的，且已經靠「單一教師」天然有界，不需要再疊加條件換取讀取量下降。
 */
export async function listPendingRequestsByInitiator(teacherId) {
    if (!teacherId) return [];
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const q    = fs.query(
        col,
        fs.where('initiatedBy', '==', teacherId),
        fs.orderBy('createdAt', 'desc'),
    );
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ reqId: d.id, ...d.data() }));
}

export async function getPendingRequest(reqId) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? { reqId: snap.id, ...snap.data() } : null;
}

// reqId 可選：pendingRequestService.createRequest 需要在寫入父文件「之前」先把 id 定下來，
// 才能先寫同一 id 底下的 private/detail（見該檔案 createRequest 的先寫 private 再寫父文件）。
// 未帶 reqId 時維持原行為，內部自行產生。
// Stage 2（§6.1）：semesterId 一律取「寫入當下的目前學期」，理由與 createSubstituteRecord
// 相同（見該處註解）——pendingRequests 沒有 legacy 遷移這種例外呼叫端，恆是「目前學期」。
export async function createPendingRequest(req, reqId = genId('req')) {
    const fs   = await getV2Firestore();
    const ref   = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    const semesterId = req.semesterId || semesterState.getCurrentSemesterId();
    // 驗收修復（中 7）：理由同 createSubstituteRecord 的同款守門。
    if (!semesterId) {
        throw new Error('createPendingRequest: 目前學期尚未確定，無法建立申請。請重新整理頁面後再試一次。');
    }
    const data  = { ...req, semesterId, createdAt: req.createdAt || new Date().toISOString() };
    await fs.setDoc(ref, data);
    return { reqId, ...data };
}

export async function updatePendingRequest(reqId, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    await fs.updateDoc(ref, { ...patch, updatedAt: new Date().toISOString() });
    return getPendingRequest(reqId);
}

export async function deletePendingRequest(reqId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    await fs.deleteDoc(ref);
}

/** 刪除請求的私有明細子文件。行為與 deleteSubstituteRecordDetail 相同，見該處註解。 */
export async function deletePendingRequestDetail(reqId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(reqId));
    await fs.deleteDoc(ref);
}

/**
 * 批次刪除多筆待審請求（含各自的 private/detail 子文件），供「清除所有資料」使用。
 * 行為與 deleteSubstituteRecordsBatch 相同，見該處註解（含輕9 的分塊方式修正）。
 */
export async function deletePendingRequestsBatch(reqIds) {
    if (!Array.isArray(reqIds) || reqIds.length === 0) return;
    const fs   = await getV2Firestore();
    const groups = reqIds.map(id => [
        fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(id)),
        fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(id)),
    ]);
    await batchDeleteRefGroups(fs, groups);
}

/**
 * Stage 5 驗收修復（輕10）：deletePendingRequestsBatch() 的「已知哪些筆有 detail」版本。
 * 行為與 deleteSubstituteRecordsBatchKnownDetail() 相同，見該處註解。
 * @param {string[]} reqIds
 * @param {Set<string>|string[]} idsWithDetail
 */
export async function deletePendingRequestsBatchKnownDetail(reqIds, idsWithDetail) {
    if (!Array.isArray(reqIds) || reqIds.length === 0) return;
    const withDetail = idsWithDetail instanceof Set ? idsWithDetail : new Set(idsWithDetail || []);
    const fs   = await getV2Firestore();
    const groups = reqIds.map(id => {
        const parentRef = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(id));
        return withDetail.has(id) ? [fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(id)), parentRef] : [parentRef];
    });
    await batchDeleteRefGroups(fs, groups);
}

/** 讀取請求的私有明細（leaveType/leaveTypeName/reason）。行為同 getRecordDetail：權限不足
 * 或不存在時回傳 null，不拋錯。 */
export async function getRequestDetail(reqId) {
    try {
        const fs   = await getV2Firestore();
        const ref  = fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(reqId));
        const snap = await fs.getDoc(ref);
        return snap.exists() ? snap.data() : null;
    } catch (_) {
        return null;
    }
}

/**
 * Stage 5（封存匯出，§6.2）：批次讀取多筆待審請求的私有明細，回傳 Map<reqId, detail>。
 * Stage 5 驗收修復（阻斷1）：與 getRecordDetailsBulk() 同款 fail-open 修復——不透過會吞掉
 * 所有錯誤的 getRequestDetail()，自行判斷只有 permission-denied/not-found 略過，其餘錯誤
 * rethrow，理由與細節見 getRecordDetailsBulk() 的完整說明。
 */
export async function getRequestDetailsBulk(reqIds) {
    const ids = Array.isArray(reqIds) ? [...new Set(reqIds.filter(Boolean))] : [];
    const fs = await getV2Firestore();
    const result = new Map();
    await Promise.all(ids.map(async (id) => {
        const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(id));
        try {
            const snap = await fs.getDoc(ref);
            if (snap.exists()) result.set(id, snap.data());
        } catch (err) {
            if (isBenignReadError(err)) return;
            throw err;
        }
    }));
    return result;
}

/**
 * Stage 5 驗收修復（阻斷1）：getRequestDetailsBulk() 的「零容忍」版本，只給封存匯出鏈使用。
 * 行為與 getRecordDetailsBulkStrict() 相同，見該處完整說明。
 */
export async function getRequestDetailsBulkStrict(reqIds) {
    const ids = Array.isArray(reqIds) ? [...new Set(reqIds.filter(Boolean))] : [];
    const fs  = await getV2Firestore();
    return settleStrictDocReads(fs, ids, (id) => fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(id)));
}

/* ===== Archives（封存紀錄，Stage 5，§6.2/§6.5） ===== */

/**
 * 寫入一筆封存紀錄（報告 §6.2 步驟 [8]）：內容是「執行刪除當下，已通過雜湊比對與筆數/ID
 * 核對的匯出資料」的摘要（各集合筆數、匯出 JSON 的 SHA-256 雜湊、執行者、時間）——**不是**
 * 「這批資料事後被獨立稽核過」的證明，只是「刪除操作依循了本流程規定的驗證步驟」的紀錄。
 * doc id 綁 semesterId。
 *
 * Stage 5 驗收修復（中6，opus 驗收）：**一學期只能寫入一次**——`firestore.rules` 的
 * `archives/{semesterId}` 對 `update`/`delete` 恆為 `false`。這裡用 `setDoc()`（非 merge），
 * 但 Firestore Security Rules 判斷一次寫入是 `create` 還是 `update` 是看「目標文件此刻是否
 * 已存在」（`resource == null` 則為 create），**與呼叫端用 `setDoc` 還是 `updateDoc` 無關**
 * ——若 `archives/{semesterId}` 已存在（例如本函式因故被重複呼叫），這次呼叫在規則引擎裡
 * 會被判定為 `update`，直接被 `allow update: if false` 擋下、丟出 `permission-denied`。
 * 原版註解誤寫成「整份覆寫也仍是同一批資料的重新確認，不會有問題」，這是不準確的——
 * 實際行為是**重試會直接失敗**，呼叫端（executeSemesterArchiveDelete）必須讓這個失敗
 * 可見（不可吞掉），因為此時代表刪除很可能已經執行過一次；UI 已改為在渲染封存頁時先呼叫
 * `getArchiveRecord()` 檢查該學期是否已封存過，已封存則直接停用匯出/刪除鈕（見輕7+8），
 * 從源頭盡量避免真的走到這個重試路徑。
 * @param {string} semesterId
 * @param {{archivedAt: string, archivedBy: object, counts: object, jsonHash: string, note?: string}} record
 */
export async function writeArchiveRecord(semesterId, record) {
    if (!semesterId) throw new Error('writeArchiveRecord: 缺少 semesterId');
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.archiveDoc(semesterId));
    await fs.setDoc(ref, { semesterId, ...record });
}

/** 讀取某學期的封存紀錄（若存在）。供封存頁顯示「此學期是否已封存過」使用。 */
export async function getArchiveRecord(semesterId) {
    if (!semesterId) return null;
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.archiveDoc(semesterId));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

/* ===== User Mapping（uid → teacherId） ===== */

export async function getUserMapping(uid) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.userMapDoc(uid));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

export async function upsertUserMapping(uid, patch) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.userMapDoc(uid));
    await fs.setDoc(ref, { ...patch, lastLoginAt: new Date().toISOString() }, { merge: true });
}

/* ===== 頂層 userDirectory（uid → schoolId 反查，Stage 3 §4） ===== */

/**
 * 讀取這個 uid 屬於哪所學校（頂層集合，不在 schools/{schoolId} 之下——讀這份文件本身
 * 不需要知道 schoolId，這正是它存在的意義：resolveIdentity() 靠它才知道接下來要對哪個
 * schoolId 呼叫 setActiveSchoolId()）。查無條目回傳 null，呼叫端自行決定 fallback。
 */
export async function getUserDirectoryEntry(uid) {
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.userDirectoryDoc(uid));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? snap.data() : null;
}

/**
 * 寫入/更新自己的 userDirectory 條目。firestore.rules 僅放行本人寫自己的 uid，
 * 且 schoolId 必須指向一所存在的學校（configExists(schoolId)），欄位白名單
 * hasOnly(['schoolId','createdAt'])。呼叫端（authGuardV2.resolveIdentity）只在
 * 「查無既有條目、剛用 fallback 解析出 schoolId」時呼叫一次，讓下次登入不必再靠
 * fallback（見該函式呼叫點註解）。用 merge:true 但只帶這兩個欄位，createdAt 只在
 * 文件真的不存在時才有意義；已存在的條目理論上不會再被呼叫到這裡（見呼叫端判斷）。
 */
export async function upsertUserDirectoryEntry(uid, schoolId) {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.userDirectoryDoc(uid));
    await fs.setDoc(ref, { schoolId, createdAt: new Date().toISOString() }, { merge: true });
}

/* ===== Operation Logs（僅寫入與查詢；由 operationLogger 包裝使用） ===== */

export async function appendLog(entry) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.logsCol());
    const ref = await fs.addDoc(col, entry);
    return { logId: ref.id, ...entry };
}

// Stage 1（§5.4）：日誌預設筆數從 200 降到 50——操作日誌本就是低頻查閱的稽核輔助資訊，
// 且已改為「進入日誌頁才一次性讀取」（見 v2-app.js renderLogsTab），不再於 bootstrap 常駐訂閱。
export async function listLogs({ limit: lim = DEFAULT_PAGE_SIZE, since = null } = {}) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.logsCol());
    const constraints = [fs.orderBy('timestamp', 'desc'), fs.limit(lim)];
    if (since) constraints.unshift(fs.where('timestamp', '>=', since));
    const q    = fs.query(col, ...constraints);
    const snap = await fs.getDocs(q);
    return snap.docs.map(d => ({ logId: d.id, ...d.data() }));
}

/* ===== 即時訂閱（onSnapshot） ===== */

// Stage 1（§5.4）：只監聽「仍在途」的請求（見 OPEN_REQUEST_STATUSES），不再整集合無界監聽。
// 已核准／已拒絕的請求不影響「有沒有新待辦」，且此訂閱只餵 _v2PendingCache（供衝堂檢查用，
// v2CheckExistingRecord 本來就只認 pending_swap_consent/pending_approval 兩種狀態）——
// 對這個用途而言，過濾掉的文件本來就從未被邏輯用到，屬零行為風險的收斂。
// 「我的申請」需要的已核准／已拒絕歷史改由 listPendingRequestsByInitiator() 按需查詢（見上）。
// Stage 2（§5.4）：加 semesterId==目前學期條件——「待我同意/待我審核」只該顯示當前學期
// 的在途申請；歷史學期在規則層已鎖唯讀，理論上不會再有該學期的 pending 文件殘留，但加上
// 這個條件同時也收斂了訂閱涵蓋範圍，與 substituteRecords 的即時視窗保持同一個「目前學期」
// 語意。semesterId 未帶時退回 semesterState 快取的目前學期（呼叫端一般不需要自行傳入）。
export async function subscribePendingRequests(callback, onError, { semesterId = semesterState.getCurrentSemesterId() } = {}) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.pendingCol());
    const constraints = [
        fs.where('status', 'in', OPEN_REQUEST_STATUSES),
        fs.orderBy('createdAt', 'desc'),
    ];
    if (semesterId) constraints.unshift(fs.where('semesterId', '==', semesterId));
    const q = fs.query(col, ...constraints);
    return fs.onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ reqId: d.id, ...d.data() })));
    }, onError);
}

// Stage 1（§5.4）：整集合無界監聽改為 orderBy createdAt desc + limit（預設 50，報告未給
// 明確數字時的預設值）。更早的歷史紀錄改由 listSubstituteRecordsPage()（頁籤「載入更多」）
// 或 queryRecordsByDateRange()（月結算／日期篩選）按需查詢，見 v2-app.js。
// 驗收修復（輕 #10）：callback 第二參數帶上這批快照的最後一筆 QueryDocumentSnapshot
// （lastDoc），供呼叫端把「載入更多」分頁的起點接在即時視窗尾端時當作原生 cursor 用
// （見 v2-app.js loadMoreRecordsTabPage），不用值游標。
// Stage 2（§5.4）：加 semesterId==目前學期條件——即時訂閱視窗只該涵蓋當前學期，歷史學期
// 改走 listSubstituteRecordsBySemester()（一次性查詢，見上）。與 listSubstituteRecordsPage
// 共用同一個學期範圍，兩者合起來才是「目前學期的完整紀錄列表（即時視窗＋載入更多）」。
export async function subscribeSubstituteRecords(callback, onError, { limit: lim = DEFAULT_PAGE_SIZE, semesterId = semesterState.getCurrentSemesterId() } = {}) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.substituteCol());
    const constraints = [fs.orderBy('createdAt', 'desc'), fs.limit(lim)];
    if (semesterId) constraints.unshift(fs.where('semesterId', '==', semesterId));
    const q = fs.query(col, ...constraints);
    return fs.onSnapshot(q, (snap) => {
        const lastDoc = snap.docs.length ? snap.docs[snap.docs.length - 1] : null;
        callback(snap.docs.map(d => ({ recordId: d.id, ...d.data() })), { lastDoc });
    }, onError);
}

// P2 全校課表共享：訂閱 per-semester schedule doc（schools/{schoolId}/schedules/{semesterId}，
// Stage 2 起取代原本的單一文件 data/schedule，見檔頭「Schedule」區塊註解）。
// 首次註冊即回傳目前值；之後任何 approver 上傳/編輯課表都會即時推播給全校教師。
// 相容 fallback：per-semester 文件尚未建立（snap 不存在）時，一次性讀舊版 data/schedule
// 補上（fallbackDone 旗標避免每次快照重複做這次額外讀取；per-semester 文件一旦被建立
// ——不論是遷移腳本或 approver 首次上傳——後續快照會自然改走正常路徑，不再需要 fallback）。
export async function subscribeSchedule(semesterId, callback, onError) {
    requireScheduleSemesterId('subscribeSchedule', semesterId);
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.scheduleDocForSemester(semesterId));
    let fallbackDone = false;
    return fs.onSnapshot(ref, async (snap) => {
        if (snap.exists()) { callback(snap.data()); return; }
        if (!fallbackDone) {
            fallbackDone = true;
            try {
                const legacyRef  = fs.doc(fs.db, SCHEMA_PATHS.scheduleDoc());
                const legacySnap = await fs.getDoc(legacyRef);
                if (legacySnap.exists()) { callback(legacySnap.data()); return; }
            } catch (e) {
                console.warn('[V2] 舊版課表 fallback 讀取失敗：', e);
            }
        }
        callback(null);
    }, onError);
}

// Stage 1（§5.4）：此函式起 bootstrap 已不再呼叫（v2-app.js 改為進入「操作日誌」頁籤才用
// 既有的 listLogs() 一次性讀取，見 renderLogsTab）——常駐 onSnapshot 對低頻查閱的稽核資訊
// 不划算。保留此函式（未來若真的需要日誌頁即時推播可重新啟用），預設 limit 同步降到 50。
export async function subscribeOperationLogs(callback, { limit: lim = DEFAULT_PAGE_SIZE } = {}, onError) {
    const fs  = await getV2Firestore();
    const col = fs.collection(fs.db, SCHEMA_PATHS.logsCol());
    const q   = fs.query(col, fs.orderBy('timestamp', 'desc'), fs.limit(lim));
    return fs.onSnapshot(q, (snap) => {
        callback(snap.docs.map(d => ({ logId: d.id, ...d.data() })));
    }, onError);
}
