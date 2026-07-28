/**
 * V2 舊資料遷移服務（Phase 5）
 *
 * 背景：V1（master 穩定版）的調代課紀錄分別可能存在於兩處，V2 完全不讀不寫（見本目錄
 * README.md）：
 *   - Firestore  users/{uid}/data/substituteSystem（cloudSyncService.js 雲端同步寫入）
 *   - 瀏覽器 localStorage key 'substituteSystemData'（app.js saveDataToStorage 寫入）
 * 同一位主任若曾在此裝置用過雲端同步，兩處都可能有資料，一律取 lastModified 較新者為準。
 *
 * 遷移目標：schools/{schoolId}/substituteRecords（V2 全校共用紀錄集合），每筆加註
 * migratedFrom / isLegacy = true，供「調代課紀錄」頁籤的 legacy 篩選與灰底徽章使用。
 *
 * 冪等性（硬需求）：以 legacyKey = date|period|className|originalTeacher|(substituteTeacher
 * 或 swapTeacher) 為鍵。寫入前用現有 substituteRecords 建 key 集合（同時收「既有紀錄自身欄位
 * 算出的 key」與「先前遷移留下的 migratedFrom.legacyKey」兩者聯集），命中即 skip；同一批次內
 * 若舊資料本身有重複列，第一筆成立後也會即時併入 key 集合，避免同批自我重複。
 *
 * ⚠ 批次寫入策略（重要，勿改回 writeBatch）：
 * firestore.rules 的 substituteRecords create 規則靠 isApprover(schoolId) 判斷身份，逐行追
 * 該函式呼叫鏈（configExists/configDoc/mappingExists/myMapping/myTeacherId/myTeacherExists/
 * myTeacherDoc 皆各自含 get()/exists()）得到：
 *   - 最佳情況（email 在 config.initialAdminEmails 白名單，isInitialDirector 短路成立）：
 *     configExists 1 次 + configDoc 被文字呼叫 2 次（是否同一 path 的 get() 會被 Firestore
 *     快取尚無法 100% 確認，保守不假設快取）＝ 3 次 document access。
 *   - 最差情況（email 不在白名單，需落到 myTeacherExists()/myTeacherDoc() 分支——例如所有
 *     section_chief 帳號、或後補晉升的主任）：isInitialDirector 先花 3 次判定落空，
 *     myTeacherExists/myTeacherId/myTeacherDoc 之間又互相呼叫 mappingExists/myMapping 多次，
 *     若 Firestore 對同一 path 的重複 get()/exists() 有做請求內快取，約落在 6 次上下；
 *     若無快取、每次文字呼叫都各自計數，可達 10 次左右。
 * 無論實際落在哪個數字，結論不變：這個成本不是固定小常數，且 Firestore 對「單一 batch /
 * transaction」的 rules document access 上限（約 20 次）是整個 batch/transaction 內所有
 * 文件寫入共用同一額度、並非逐筆各自獨立計算。docs/PLAN_v2.0.0.md §7 原訂「每 400 筆一批」
 * 用 writeBatch 送出，即使用最樂觀的 3 次/筆估計，400×3 也遠超 20；就算大幅降到 10 筆一批，
 * 樂觀情境 10×3=30 已超額度，悲觀情境 10×6~10×10=60~100 更是遠超。也就是說只要用
 * writeBatch/runTransaction 把多筆 create 綁進同一批，批次大小必須小到個位數（甚至 2）才有
 * 安全餘裕，而且這個「安全個位數」還會隨遷移操作者是否在白名單內而變動，難以給出一個放諸
 * 四海皆準的批次大小。本模組因此乾脆不使用 writeBatch/runTransaction，改為逐筆呼叫既有的
 * dataSvc.createSubstituteRecord()（單一 setDoc，非任何 batch/transaction 成員）：每筆的
 * rules 判斷各自獨立起算配額，不會被同批其他筆數拖累超限，也就不必再猜一個「安全批次大小」。
 * onProgress 回呼的節流（預設每 10 筆一次）純粹是 UI 更新頻率考量，與上述限制無關。
 * 完整推導與模擬數字見 test/test-legacy-migration.mjs 最後一節。
 */

import * as dataSvc        from './schoolDataService.js';
import * as logger         from './operationLogger.js';
import * as roleSvc        from './roleService.js';
import { getV2Firestore }  from './firebaseV2.js';
import { LOG_ACTIONS, LOG_TARGET_TYPES } from './schemaConstants.js';

const LEGACY_LOCALSTORAGE_KEY = 'substituteSystemData';

function legacyDocPath(uid) {
    return `users/${uid}/data/substituteSystem`;
}

/**
 * 測試替身掛鉤（僅供 Node 單元測試使用，見 test/test-legacy-migration.mjs），寫法與
 * teacherAccountManager.js 的 __testHooks 相同：覆寫此物件屬性即可在不啟動 Firebase /
 * 瀏覽器環境的情況下，對本模組的偵測/遷移純邏輯（衝突判斷、冪等性）做端對端驗證。
 * 瀏覽器正式執行路徑一律使用下方兩個真正實作（讀 Firestore / 讀 localStorage）。
 */
export const __testHooks = {
    dataSvc,
    logger,
    roleSvc,
    async readFirestoreLegacy(uid) {
        if (!uid) return null;
        const fs   = await getV2Firestore();
        const ref  = fs.doc(fs.db, legacyDocPath(uid));
        const snap = await fs.getDoc(ref);
        return snap.exists() ? snap.data() : null;
    },
    readLocalStorageLegacy() {
        if (typeof localStorage === 'undefined' || !localStorage) return null;
        const raw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (_) { return null; }
    },
};

/**
 * 兩個舊資料來源都可能存在，取 lastModified 較新者；皆無資料回傳 null。
 * 回傳 { source, uid, raw, lastModified }，raw 為該來源的完整原始物件（供備份下載使用）。
 */
async function resolveLegacySource() {
    const identity = __testHooks.roleSvc.getCurrentIdentity();
    const uid = identity?.uid || null;

    const [fsData, lsData] = await Promise.all([
        __testHooks.readFirestoreLegacy(uid),
        Promise.resolve(__testHooks.readLocalStorageLegacy()),
    ]);

    const candidates = [];
    if (fsData) candidates.push({ source: 'firestore', uid, raw: fsData, lastModified: fsData.lastModified || null });
    if (lsData) candidates.push({ source: 'localStorage', uid, raw: lsData, lastModified: lsData.lastModified || null });

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 兩者皆有資料：取 lastModified 較新者；缺 lastModified 視為最舊（排序墊底，非拋錯）。
    candidates.sort((a, b) => new Date(b.lastModified || 0).getTime() - new Date(a.lastModified || 0).getTime());
    return candidates[0];
}

/** 偵測舊資料：{ source: 'firestore'|'localStorage'|null, count, lastModified } */
export async function detectLegacyData() {
    const winner = await resolveLegacySource();
    if (!winner) return { source: null, count: 0, lastModified: null };
    const count = Array.isArray(winner.raw.substituteRecords) ? winner.raw.substituteRecords.length : 0;
    return { source: winner.source, count, lastModified: winner.lastModified };
}

/**
 * 供 UI 在遷移前下載完整備份 JSON（含原始資料全文，不只是 substituteRecords 陣列）。
 * 回傳 null 代表偵測不到任何舊資料（呼叫端應中止遷移流程）。
 */
export async function getLegacyBackupPayload() {
    const winner = await resolveLegacySource();
    if (!winner) return null;
    return { source: winner.source, uid: winner.uid, lastModified: winner.lastModified, raw: winner.raw };
}

/** 冪等鍵：date|period|className|originalTeacher|(substituteTeacher 或 swapTeacher) */
function legacyKeyOf(r) {
    return [
        r.date || '',
        r.period || '',
        r.className || '',
        r.originalTeacher || '',
        r.substituteTeacher || r.swapTeacher || '',
    ].join('|');
}

/**
 * 執行遷移：把偵測到（較新來源）的舊 substituteRecords 逐筆寫入 V2 substituteRecords 集合。
 * @param {{ onProgress?: (p: {done:number, total:number}) => void }} [options]
 * @returns {Promise<{ total:number, created:number, skipped:number, unmatchedNames:string[], errors:Array<{legacyKey:string,message:string}> }>}
 */
export async function migrateLegacyRecords({ onProgress } = {}) {
    const svc  = __testHooks.dataSvc;
    const log  = __testHooks.logger;
    const role = __testHooks.roleSvc;

    if (!role.isDirector()) {
        throw new Error('僅教務主任可執行資料遷移');
    }

    const result = { total: 0, created: 0, skipped: 0, unmatchedNames: [], errors: [] };
    const winner = await resolveLegacySource();
    if (!winner) return result;

    const legacyRecords = Array.isArray(winner.raw.substituteRecords) ? winner.raw.substituteRecords : [];
    result.total = legacyRecords.length;
    if (legacyRecords.length === 0) return result;

    // 現況快照：existingKeys 同時收「既有紀錄自身欄位算出的 key」與「先前遷移留下的
    // migratedFrom.legacyKey」，兩者聯集才能同時涵蓋「已由別的管道存在同一格」與「已遷移過」。
    const [existingRecords, teachers] = await Promise.all([svc.listSubstituteRecords(), svc.listTeachers()]);
    const existingKeys = new Set();
    for (const r of existingRecords) {
        existingKeys.add(legacyKeyOf(r));
        if (r.migratedFrom?.legacyKey) existingKeys.add(r.migratedFrom.legacyKey);
    }
    const teacherByName = new Map(teachers.map(t => [t.name, t.teacherId]));
    const unmatched = new Set();
    const migratedAt = new Date().toISOString();

    let done = 0;
    for (const legacy of legacyRecords) {
        const key = legacyKeyOf(legacy);
        if (existingKeys.has(key)) {
            result.skipped++;
        } else {
            try {
                const subName = legacy.substituteTeacher || legacy.swapTeacher || '';
                const originalTeacherId   = teacherByName.get(legacy.originalTeacher) || null;
                const substituteTeacherId = teacherByName.get(subName) || null;
                // 姓名對不到帳號仍要匯入——舊紀錄的價值在歷史查詢，不能因為對不到 ID 就丟掉。
                if (legacy.originalTeacher && !originalTeacherId) unmatched.add(legacy.originalTeacher);
                if (subName && !substituteTeacherId) unmatched.add(subName);

                await svc.createSubstituteRecord({
                    ...legacy,
                    originalTeacherId,
                    substituteTeacherId,
                    status: legacy.status || 'approved',
                    isLegacy: true,
                    migratedFrom: { source: winner.source, uid: winner.uid, legacyKey: key, migratedAt },
                });
                existingKeys.add(key); // 同批次內若舊資料本身重複，第二筆起視為已存在，避免自我重複匯入
                result.created++;
            } catch (err) {
                result.errors.push({ legacyKey: key, message: (err && err.message) || String(err) });
            }
        }
        done++;
        if (typeof onProgress === 'function' && (done % 10 === 0 || done === legacyRecords.length)) {
            try { onProgress({ done, total: legacyRecords.length }); } catch (_) { /* 進度回呼失敗不可中斷遷移 */ }
        }
    }

    result.unmatchedNames = Array.from(unmatched);

    if (result.created > 0 || result.errors.length > 0) {
        await log.log(LOG_ACTIONS.DATA_MIGRATE, LOG_TARGET_TYPES.SUBSTITUTE_RECORD, null, {
            source: winner.source,
            total: result.total,
            created: result.created,
            skipped: result.skipped,
            unmatchedNames: result.unmatchedNames,
            errorCount: result.errors.length,
        });
    }

    return result;
}
