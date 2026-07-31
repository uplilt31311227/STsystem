/**
 * Stage 4：多租戶開通——學校申請服務
 * （RESEARCH-multitenancy-semester.md §4／RESEARCH-blaze-followup.md）
 *
 * 負責三個頂層（不在 schools/{schoolId} 之下）集合的 CRUD：
 *   - schoolApplications/{uid}：申請開通新學校（doc id 綁申請人 uid）
 *   - platformAdmins/{uid}：平台管理者名冊（client 唯讀，寫入見 scripts/bootstrap-platform-admin.js）
 *   - schoolDirectory/{schoolId}：公開學校名錄（申請頁檢查 schoolId 是否已被使用）
 *
 * 對應規則見 firestore.rules 檔頭第 9 點與各 match 區塊內的完整說明。
 *
 * 與 schoolDataService.js 的分工：schoolDataService 專職 schools/{schoolId}/ 底下的資料
 * （見該檔檔頭），本檔專職「還不知道／不需要知道自己屬於哪所學校」的跨校資料，獨立成檔
 * 避免混淆兩種完全不同的信任模型（校內成員 vs 平台管理者）。
 */

import { getV2Firestore } from './firebaseV2.js';
import { SCHEMA_PATHS } from './schemaConstants.js';
import * as semesterUtils from './semesterUtils.js';

export const APPLICATION_STATUS = Object.freeze({
    PENDING:  'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
});

/**
 * opus 驗收 H2：核准流程偵測到「schoolDirectory 已有同 schoolId 且同名紀錄」時，不再靜默
 * 判定為「這是同一筆申請的重試」直接跳過第一批寫入——改為丟出這個可辨識的錯誤，呼叫端
 * （v2-app.js renderPlatformAdminReviewTab）接住後必須先讓審核者看到明確訊息並二次確認
 * （「該 schoolId 已存在同名學校，僅執行綁定」），確認後才帶著 `confirmedSkipFirstBatch:true`
 * 重新呼叫 approveApplication()。避免審核者在完全不知情的狀況下，把一筆申請自動「綁」到
 * 另一筆不相關申請已建立的學校（即使 schoolName 恰巧相同，也可能是不同申請人、不同真實
 * 學校）。
 */
export class SameNameConflictError extends Error {
    constructor(message, info) {
        super(message);
        this.name = 'SameNameConflictError';
        this.code = 'SAME_NAME_CONFLICT';
        this.info = info;
    }
}

const SCHOOL_ID_RE = /^[a-z0-9_-]{1,50}$/;

/** schoolId 格式驗證（比照 firestore.rules 的 `matches('^[a-z0-9_-]{1,50}$')` 白名單）。 */
export function isValidSchoolIdFormat(schoolId) {
    return typeof schoolId === 'string' && SCHOOL_ID_RE.test(schoolId);
}

/* ===== platformAdmins（client 唯讀） ===== */

/**
 * 是否為平台管理者。讀自己那一份 platformAdmins/{uid}（規則只放行本人讀自己），
 * 查不到（含 permission-denied，理論上不會發生——規則本身放行自己）一律視為 false，
 * 不讓例外中斷任何呼叫端流程（比照 authGuardV2 對 emailIndex/userDirectory 讀取失敗
 * 一律降級處理的既有慣例）。
 */
export async function isPlatformAdmin(uid) {
    if (!uid) return false;
    try {
        const fs   = await getV2Firestore();
        const ref  = fs.doc(fs.db, SCHEMA_PATHS.platformAdminDoc(uid));
        const snap = await fs.getDoc(ref);
        return snap.exists();
    } catch (e) {
        console.warn('[schoolApplicationService] 讀取 platformAdmins 失敗，視同非平台管理者：', e?.message || e);
        return false;
    }
}

/* ===== schoolDirectory（公開名錄，申請頁查重用） ===== */

/**
 * 這個 schoolId 是否已被使用（schoolDirectory 中已有記錄）。
 * ⚠ 已知限制（見 docs/STAGE4-DEPLOY.md「已知限制」一節）：schoolDirectory 只在 Stage 4
 * 核准流程中才會被寫入，既有的 'inhu' 學校（Stage 4 之前就存在）預設不會出現在這裡——
 * 除非部署時額外手動補一筆（建議做法見部署文件）。即使沒有補，實際的資料安全仍由
 * firestore.rules 的 config/main create-only 語意保護（approveApplication() 對已存在的
 * config 寫入必定被拒，見該函式檔頭），這裡只是「申請當下的即時提示」，不是唯一防線。
 */
export async function isSchoolIdTaken(schoolId) {
    if (!isValidSchoolIdFormat(schoolId)) return true; // 格式都不合法，直接視為不可用
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.schoolDirectoryDoc(schoolId));
    const snap = await fs.getDoc(ref);
    return snap.exists();
}

/* ===== schoolApplications ===== */

/** 讀自己（或任一 uid，platformAdmin 呼叫時）的申請文件。查無回傳 null。 */
export async function getApplication(uid) {
    if (!uid) return null;
    const fs   = await getV2Firestore();
    const ref  = fs.doc(fs.db, SCHEMA_PATHS.schoolApplicationDoc(uid));
    const snap = await fs.getDoc(ref);
    return snap.exists() ? { uid: snap.id, ...snap.data() } : null;
}

/**
 * 送出（或於被駁回後重新送出）開通新學校的申請。
 * Firestore 對 doc id 已存在的文件呼叫 setDoc（無 merge）在規則層會被判定為 update 而非
 * create——因此「首次申請」與「駁回後重新申請」在 client 端可以共用同一支函式，實際
 * 命中規則的哪一條分支（create 或 update 的 (b) 分支）由 Firestore 自行判斷，呼叫端不需
 * 也不能自行決定，見 firestore.rules 的 schoolApplications match 區塊。
 *
 * pending 期間重複呼叫本函式會被規則拒絕（update 分支要求 `resource.data.status ==
 * 'rejected'`），呼叫端應先用 getApplication() 確認狀態，避免使用者對著已送出的申請
 * 重複點擊送出鈕（UI 層面亦應停用按鈕，見 v2-app.js renderApplyForm()）。
 */
export async function submitApplication({ uid, email, schoolName, desiredSchoolId }) {
    if (!uid) throw new Error('submitApplication: 缺少 uid');
    const normalizedEmail = (email || '').toLowerCase().trim();
    const trimmedName     = (schoolName || '').trim();
    const trimmedId       = (desiredSchoolId || '').trim();
    if (!normalizedEmail) throw new Error('缺少申請人 email');
    if (!trimmedName) throw new Error('請填寫學校名稱');
    if (!isValidSchoolIdFormat(trimmedId)) {
        throw new Error('學校代碼格式不正確，只能使用小寫英數字、底線、連字號，長度 1-50');
    }

    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.schoolApplicationDoc(uid));

    // 若是「駁回後重新申請」，保留原始 createdAt（firestore.rules 的 update (b) 分支已鎖
    // `createdAt` 不可變，opus 驗收 L4）——這裡的讀取不是「錦上添花」，是規則能否放行的前提。
    // opus 驗收 R6：訂正原本「讀取失敗一律視為全新申請、用現在時間，不阻斷送出流程」的做法——
    // 若這其實是「駁回後重新申請」但讀取失敗，用「現在時間」當 createdAt 會與雲端既有值不同，
    // 規則的 `createdAt` 不可變檢查會直接拒絕這次寫入，使用者只會看到一個語意不明的
    // permission-denied，看不出真正原因（讀取失敗）。改為讀取失敗直接中止並拋出明確錯誤，
    // 讓呼叫端（v2-app.js）用既有的 notifyError() 顯示「請稍後重試」，比讓它偷偷送出一個
    // 注定會被規則拒絕的寫入更誠實。查無舊資料（`existing === null`，非例外）才是真正的
    //「全新申請」，用現在時間。
    let createdAt = new Date().toISOString();
    try {
        const existing = await getApplication(uid);
        if (existing?.createdAt) createdAt = existing.createdAt;
    } catch (e) {
        throw new Error(`送出申請中止：無法確認是否為重新送出（讀取既有申請狀態失敗：${e?.message || e}），請稍後再試。`);
    }

    const data = {
        schoolName:      trimmedName,
        applicantEmail:  normalizedEmail,
        applicantUid:    uid,
        desiredSchoolId: trimmedId,
        status:          APPLICATION_STATUS.PENDING,
        createdAt,
        updatedAt: new Date().toISOString(),
    };
    await fs.setDoc(ref, data);
    return { uid, ...data };
}

/**
 * 平台管理者專用：列出所有待審申請（status == 'pending'）。
 * ⚠ 刻意不在查詢中加 orderBy(createdAt)——where(status==) + orderBy(不同欄位) 需要一個
 * 額外的複合索引（見 firestore.indexes.json 現有索引皆為校內查詢），為了這個低頻的
 * 管理頁面多維護一個索引不划算；改為查回後在記憶體中排序（待審量級是「人工審核的學校
 * 申請」，不會是需要伺服器端分頁的規模）。
 */
export async function listPendingApplications() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.schoolApplicationsCol());
    const q    = fs.query(col, fs.where('status', '==', APPLICATION_STATUS.PENDING));
    const snap = await fs.getDocs(q);
    const list = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    return list;
}

/**
 * 平台管理者專用：駁回申請。單一 update，欄位對齊規則的 platformAdmin 分支白名單。
 *
 * opus 驗收 H3：駁回前先檢查「這筆申請是否已經對應到一所真實建立的學校」——若是，駁回會
 * 產生矛盾狀態：申請被標記為「已駁回」，但它宣稱的學校卻已經真實存在於 Firestore 中，沒有
 * 任何一筆 `schoolApplications` 紀錄指向它，形同孤兒資料且稽核軌跡斷裂。判斷依據（符合任一
 * 即阻擋）：
 *   (a) `application.status === 'approved'`——這筆申請自己的紀錄就說已核准，一定不能直接
 *       駁回（要用 `revertApprovedApplication()` 這條專門的解套路徑，見該函式）。
 *   (b) `schoolDirectory/{desiredSchoolId}` 已存在**且** schoolName 與本申請相同——與
 *       `approveApplication()` 判斷「是否為同一筆申請的第一批已完成」用的是同一個啟發式
 *       （見該函式檔頭），代表這很可能是「核准流程的第一批曾經成功執行、但第二批沒做完，
 *       申請狀態還停在 pending」的半套狀態，此時駁回同樣會留下孤兒學校。
 *   若 schoolDirectory 已有條目但 schoolName **不同**（真的是別的申請/別的學校恰巧用了同一個
 *   代碼），**不**阻擋——此時這筆申請本身從未被建立過任何東西，駁回不會產生孤兒資料。
 *
 * opus 驗收 R1（修復 H2×H3 互卡）：H2「同名死局」的實際情境是 `schoolDirectory` 的
 * schoolName **與本申請相同**（這正是 `SameNameConflictError` 觸發的條件）——若審核者在二次
 * 確認畫面選擇「不綁定」，代表審核者判斷「這其實不是同一所學校，只是名字剛好一樣」，此時
 * 呼叫端應該能改為駁回。但上面 (b) 的檢查條件正是「schoolName 相同就阻擋」，兩者在 schoolName
 * 相同的情況下必然衝突：H2 想放行的駁回，恰好正是 H3 (b) 想擋下的駁回——原版文件曾誤寫「此時
 * rejectApplication() 會允許」，是自相矛盾的錯誤描述（已訂正，見 approveApplication() 檔頭）。
 * 修復：新增 `confirmedNotSameSchool` 參數，讓呼叫端（v2-app.js 的「駁回（已確認非同一所
 * 學校）」按鈕，只在 H2 二次確認畫面被審核者主動觸發）明確覆寫 (b) 這項檢查——`status===
 * 'approved'` 的 (a) 檢查**不受此參數影響、恆不可覆寫**（那是這筆申請自己的紀錄說已核准，
 * 不是啟發式判斷，覆寫沒有意義且危險）。
 *
 * @param {{uid: string, desiredSchoolId: string, schoolName?: string, status?: string}} application
 *   完整申請物件（需要 desiredSchoolId/status 才能做上述判斷，故簽章從單純 uid 改為整個
 *   application，對齊 approveApplication() 的呼叫慣例）。
 * @param {object} [opts]
 * @param {boolean} [opts.confirmedNotSameSchool=false] - 審核者已在 UI 明確表示「這不是同一所
 *   學校」，覆寫 (b) 的同名啟發式檢查（僅限 (b)，不影響 (a) 的 status==='approved' 硬性阻擋）。
 */
export async function rejectApplication(application, { reviewer, reason, confirmedNotSameSchool = false } = {}) {
    if (!application?.uid) throw new Error('rejectApplication: application 缺少 uid');
    const { uid, desiredSchoolId, schoolName, status } = application;

    if (status === APPLICATION_STATUS.APPROVED) {
        throw new Error(
            `駁回中止：這筆申請目前狀態是「已核准」，直接駁回會留下「學校已建立但申請顯示駁回」的` +
            `矛盾狀態。請改用「解套：改為駁回」（revertApprovedApplication()，僅在確認需要撤銷已核准` +
            `申請時使用，不會刪除已建立的學校資料）。`
        );
    }

    if (desiredSchoolId && !confirmedNotSameSchool) {
        const fs0 = await getV2Firestore();
        let directoryEntry = null;
        try {
            const dirSnap = await fs0.getDoc(fs0.doc(fs0.db, SCHEMA_PATHS.schoolDirectoryDoc(desiredSchoolId)));
            directoryEntry = dirSnap.exists() ? dirSnap.data() : null;
        } catch (e) {
            throw new Error(`駁回中止：無法確認學校代碼「${desiredSchoolId}」是否已被建立（${e?.message || e}），請稍後再試。`);
        }
        if (directoryEntry && directoryEntry.schoolName === schoolName) {
            throw new Error(
                `駁回中止：學校代碼「${desiredSchoolId}」已有同名學校「${directoryEntry.schoolName}」存在，` +
                `很可能是這筆申請先前核准時第一批已成功執行（只是狀態沒更新完）。請改用「核准」重試` +
                `（會重新出現同名確認，選擇僅執行綁定即可補做剩餘步驟）；若確定這不是同一筆申請造成的` +
                `（例如你剛才在核准的二次確認畫面已判斷這是另一所學校），可帶 confirmedNotSameSchool` +
                `重新呼叫；若不確定，請依 docs/STAGE4-DEPLOY.md「已知限制」的人工清理程序處理。`
            );
        }
    }

    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.schoolApplicationDoc(uid));
    await fs.updateDoc(ref, {
        status:       APPLICATION_STATUS.REJECTED,
        updatedAt:    new Date().toISOString(),
        reviewedAt:   new Date().toISOString(),
        reviewedBy:   reviewer || null,
        rejectReason: (reason || '').trim() || null,
    });
}

/**
 * 平台管理者專用：列出所有「已核准」的申請（status == 'approved'）。
 * opus 驗收 H2：供「疑難排解／解套」區塊使用——正常流程下核准的申請不需要再被列出來做任何
 * 事，這個列表只在需要用 revertApprovedApplication() 解套時才會被審核者查看，預期是低頻、
 * 短暫存在的清單（多數學校核准後就不會再出現在這裡，只有卡住的才會持續出現）。同樣不加
 * orderBy，理由同 listPendingApplications()。
 */
export async function listApprovedApplications() {
    const fs   = await getV2Firestore();
    const col  = fs.collection(fs.db, SCHEMA_PATHS.schoolApplicationsCol());
    const q    = fs.query(col, fs.where('status', '==', APPLICATION_STATUS.APPROVED));
    const snap = await fs.getDocs(q);
    const list = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    return list;
}

/**
 * 平台管理者專用：把一筆「已核准」的申請改回「已駁回」（opus 驗收 H2 解套路徑）。
 *
 * ⚠ 這是逃生艙，不是復原：**不會**刪除或還原已經建立的學校資料（`schools/{id}/config/main`／
 * `schoolDirectory/{id}`）——client 規則對這兩個路徑只有 create-only 權限，沒有任何 delete
 * 路徑（見 firestore.rules 檔頭第 9 點），需要真的清除的話只能由開發者離線用 gcloud/REST
 * 處理，見 docs/STAGE4-DEPLOY.md「已知限制」的人工清理程序。本函式唯一做的事，是讓
 * `schoolApplications` 這筆紀錄的狀態回到「駁回」，讓申請人得以透過既有的「駁回後重新申請」
 * 路徑（見 submitApplication()／firestore.rules 的 update (b) 分支）換一個代碼重新提交。
 *
 * 使用時機：核准流程卡在「同名死局」（見 approveApplication() 的 SameNameConflictError）且
 * 審核者確認不該綁定既有紀錄；或核准後才發現申請資訊有誤，需要讓申請人重新走一次流程。
 */
export async function revertApprovedApplication(application, { reviewer, reason } = {}) {
    if (!application?.uid) throw new Error('revertApprovedApplication: application 缺少 uid');
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.schoolApplicationDoc(application.uid));
    await fs.updateDoc(ref, {
        status:       APPLICATION_STATUS.REJECTED,
        updatedAt:    new Date().toISOString(),
        reviewedAt:   new Date().toISOString(),
        reviewedBy:   reviewer || null,
        rejectReason: (reason || '').trim() || null,
    });
}

/**
 * 平台管理者專用：核准申請，開通新學校。
 *
 * ⚠ 刻意分兩個 writeBatch 循序執行、不是單一原子批次，理由：
 *   1. 第二批（userDirectory 指向新校）依賴的 configExists(schoolId) 規則檢查，讀的是
 *      「這次提交之前」資料庫的已提交狀態——Firestore 對同一個 writeBatch 內的多個操作，
 *      規則的 exists()/get() 並不保證能看到同一批次內「更早的操作」剛寫入的效果（這點
 *      官方文件沒有給出可依賴的正式保證，本專案選擇不依賴這個未文件化的行為）。若把
 *      config 建立與 userDirectory 寫入放進同一批，userDirectory 那筆的 configExists()
 *      檢查極可能仍讀到「批次提交前」的舊狀態（school 尚不存在），導致整批被規則拒絕。
 *      拆成兩批、第一批先 commit，第二批送出時 config 已經是「已提交」的狀態，
 *      configExists() 才能可靠地讀到 true。
 *   2. 這個設計本身就是本次實作依賴的 schoolId 衝突防線（見 firestore.rules 檔頭第 9
 *      點）：第一批的 config/main create 若 schoolId 已被占用，Firestore 會把這筆寫入
 *      判定為 update（因為文件已存在）而非 create，platformAdmin 的 create-only 權限規則
 *      直接拒絕整個 batch（batch 內任一操作被拒，整批失敗，不會產生半套資料）。
 *
 * 失敗與重試（fail-closed 原則，比照 Stage 5 封存流程「任何讀取/比對失敗一律中止」）：
 *   - 第一批失敗：完全沒有副作用（schoolApplications 狀態仍是 pending），可直接重新呼叫
 *     本函式重試。
 *   - 第一批成功、第二批失敗（例如網路瞬斷）：學校已建立（config + schoolDirectory），
 *     但申請狀態仍是 'pending'、申請人 userDirectory 也還沒指過去——這是刻意接受的中間
 *     狀態，不是「整個操作都沒發生」。重新呼叫本函式時，第一批會因為 schoolId 已存在而
 *     再次被規則拒絕（見上），呼叫端（v2-app.js renderPlatformAdminReviewTab）需要能分辨
 *     「衝突（別的申請/別的學校真的占用了這個 id）」與「這正是我方才第一批已完成、只是
 *     第二批沒做完」——本函式用「schoolDirectory 既有紀錄的 schoolName 是否等於本申請的
 *     schoolName」這個啟發式判斷：相同就**可能**是「同一筆申請的第一批已完成」；不同就視為
 *     真衝突並丟出明確錯誤，要求人工介入（駁回本申請、請申請人更換代碼，或確認是否為兩筆
 *     不同申請誤用同一個代碼）。
 *     ⚠ 已知限制：這個啟發式無法區分「兩個不相關的申請碰巧選了同一個 schoolId 且碰巧填了
 *     同一個 schoolName」這種極端巧合（機率極低——schoolId 與 schoolName 皆由申請人自訂
 *     輸入，兩份不相關的申請剛好兩者都相同的機率微乎其微），本次實作接受這個殘留風險，
 *     不做更複雜的關聯設計（例如在 schoolDirectory 上額外記錄 provisionedForUid 欄位）
 *     ——因為 schoolDirectory 的欄位形狀是報告 §4.2「schoolDirectory 只含
 *     schoolName/createdAt」明確定義的，額外欄位會被規則的 hasOnly() 白名單直接拒絕寫入。
 *
 * opus 驗收 H2（同名啟發式死局的修復）：正因為上述啟發式不是決定性證據，**不再靜默**依此
 * 判斷就跳過第一批——改為丟出 `SameNameConflictError`，呼叫端必須先讓審核者看到明確訊息
 * 「該 schoolId 已存在同名學校，僅執行綁定」並二次確認，確認後才帶著
 * `confirmedSkipFirstBatch: true` 重新呼叫本函式跳過第一批。
 *
 * opus 驗收 R1（訂正本段原本自相矛盾的描述）：審核者若不確認（判斷這其實是另一筆不相關的
 * 申請，不該綁定），**不能**直接呼叫 `rejectApplication()`——此情境下 `schoolDirectory` 的
 * schoolName 與本申請**相同**（這正是觸發 `SameNameConflictError` 的條件），而
 * `rejectApplication()` 的孤兒學校防呆（見該函式檔頭 (b)）恰好就是「schoolName 相同就阻擋」，
 * 兩者在這裡直接衝突。原版文件曾誤寫「rejectApplication() 會允許此情境」，是錯的（會被同一條
 * 檢查擋下，形成 H2 與 H3 互卡、審核者兩條路都走不通的死局）。修復：`rejectApplication()`
 * 新增 `confirmedNotSameSchool` 參數，呼叫端（v2-app.js）在審核者透過 UI 明確選擇「駁回（已
 * 確認非同一所學校）」時帶 `confirmedNotSameSchool: true` 呼叫，明確覆寫這條啟發式檢查——
 * 覆寫的是審核者的主動判斷，不是自動放行。
 *
 * @param {object} application - 申請物件
 * @param {object} [opts]
 * @param {object} [opts.reviewer]
 * @param {boolean} [opts.confirmedSkipFirstBatch=false] - 審核者已在 UI 二次確認「同名視為
 *   同一筆申請，僅執行綁定」，跳過第一批直接進入第二批。未確認且偵測到同名衝突時，本函式會
 *   丟出 SameNameConflictError 而不會自動跳過。
 */
export async function approveApplication(application, { reviewer, confirmedSkipFirstBatch = false } = {}) {
    if (!application?.uid) throw new Error('approveApplication: application 缺少 uid');
    const { uid, applicantEmail, schoolName, desiredSchoolId } = application;
    if (!applicantEmail || !schoolName || !desiredSchoolId) {
        throw new Error('approveApplication: 申請資料不完整（缺少 applicantEmail/schoolName/desiredSchoolId）');
    }
    if (!isValidSchoolIdFormat(desiredSchoolId)) {
        throw new Error(`approveApplication: 學校代碼「${desiredSchoolId}」格式不合法，請先駁回並請申請人更換代碼`);
    }

    const fs = await getV2Firestore();

    // ---- 第一批：建立 config/main + schoolDirectory ----
    // 判斷是否需要執行第一批，依據是 schoolDirectory（公開可讀，platformAdmin 讀得到）
    // 而不是 config/main 本身——platformAdmin 對 config 的 read 規則沒有開任何分支（見
    // firestore.rules config/{docId}），嘗試讀 config 只會得到 permission-denied，無法
    // 用來判斷是否存在。
    let firstBatchNeeded = true;
    let existingDirectoryEntry = null;
    try {
        const dirRef  = fs.doc(fs.db, SCHEMA_PATHS.schoolDirectoryDoc(desiredSchoolId));
        const dirSnap = await fs.getDoc(dirRef);
        existingDirectoryEntry = dirSnap.exists() ? dirSnap.data() : null;
    } catch (e) {
        throw new Error(`核准中止：無法確認學校代碼「${desiredSchoolId}」是否已被使用（${e?.message || e}），請稍後再試。`);
    }

    if (existingDirectoryEntry) {
        // 啟發式判斷「這是同一筆申請的重試」：schoolDirectory 只存 schoolName，比對申請的
        // schoolName 是否相同——不是決定性證據（見函式檔頭「已知限制」），但已是目前欄位
        // 形狀下能做的最佳判斷；不相同就直接視為真衝突（無論是否已確認皆不可跳過）。
        if (existingDirectoryEntry.schoolName !== schoolName) {
            throw new Error(
                `核准中止：學校代碼「${desiredSchoolId}」已被使用（現有名稱「${existingDirectoryEntry.schoolName}」，` +
                `與本申請的「${schoolName}」不同），可能是重複的代碼。請駁回本申請並請申請人更換代碼，` +
                `或確認這不是另一筆申請已經核准過的同一所學校。`
            );
        }
        // opus 驗收 H2：schoolName 相同，但不再自動視為「同一筆申請的重試」——除非審核者已
        // 在 UI 二次確認（confirmedSkipFirstBatch），否則丟出 SameNameConflictError 要求
        // 呼叫端先取得明確確認，見函式檔頭說明。
        if (!confirmedSkipFirstBatch) {
            throw new SameNameConflictError(
                `學校代碼「${desiredSchoolId}」已存在同名學校「${existingDirectoryEntry.schoolName}」。` +
                `若確認這是同一筆申請先前已完成的建校（只是狀態沒更新完），可選擇僅執行綁定` +
                `（不會重新建立學校，只補做「更新申請狀態＋指向新校」這一步）；若不確定，建議改為駁回` +
                `本申請並請申請人核對是否重複申請。`,
                { desiredSchoolId, existingSchoolName: existingDirectoryEntry.schoolName, applicationSchoolName: schoolName }
            );
        }
        firstBatchNeeded = false;
    }

    if (firstBatchNeeded) {
        const batch1 = fs.writeBatch(fs.db);
        const now = new Date().toISOString();
        batch1.set(fs.doc(fs.db, SCHEMA_PATHS.configDocForSchool(desiredSchoolId)), {
            schoolName,
            currentSemester:    semesterUtils.todaySemesterId(),
            initialAdminEmails: [applicantEmail],
            createdAt: now,
            updatedAt: now,
        });
        batch1.set(fs.doc(fs.db, SCHEMA_PATHS.schoolDirectoryDoc(desiredSchoolId)), {
            schoolName,
            createdAt: now,
        });
        try {
            await batch1.commit();
        } catch (e) {
            throw new Error(
                `核准中止（第一批寫入失敗，尚未產生任何副作用，可重新嘗試核准）：${e?.message || e}`
            );
        }
    }

    // ---- 第二批：更新申請狀態 + 指向新校的 userDirectory ----
    const batch2 = fs.writeBatch(fs.db);
    const now2 = new Date().toISOString();
    batch2.update(fs.doc(fs.db, SCHEMA_PATHS.schoolApplicationDoc(uid)), {
        status:     APPLICATION_STATUS.APPROVED,
        updatedAt:  now2,
        reviewedAt: now2,
        reviewedBy: reviewer || null,
    });
    batch2.set(fs.doc(fs.db, SCHEMA_PATHS.userDirectoryDoc(uid)), {
        schoolId:  desiredSchoolId,
        createdAt: now2,
    }, { merge: true });
    try {
        await batch2.commit();
    } catch (e) {
        // opus 驗收 R5：訂正原本「重試時會自動偵測學校已建立，直接補做這一步」的說法——
        // H2 修復後，重新呼叫 approveApplication() 會先重新偵測到 schoolDirectory 已有同名
        // 紀錄（正是本函式剛才建立的那筆），丟出 SameNameConflictError 要求審核者再次二次
        // 確認「僅執行綁定」，而不是自動跳過。如實描述這個行為，避免審核者誤以為重試會完全
        // 靜默完成。
        throw new Error(
            `學校「${schoolName}」（代碼 ${desiredSchoolId}）已建立，但更新申請狀態／申請人歸屬失敗：` +
            `${e?.message || e}。請重新點擊「核准」重試——重試時會出現「已存在同名學校」的確認提示` +
            `（因為學校剛才已建立成功），選擇「僅執行綁定」即可補做這一步，不會重複建立學校。`
        );
    }

    return { schoolId: desiredSchoolId };
}
