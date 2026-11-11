/**
 * 登出 / 切換帳號時清除本機殘留的個人與全校資料（共用電腦情境）。
 *
 * 會清的（皆可由雲端重建）：
 *   - localStorage：V2 的課表鏡像 `substituteSystemData:{schoolId}`（所有學校）、上次登入 uid 記錄
 *   - sessionStorage：整個清空（本專案未使用，防禦性）
 *   - Firestore 離線持久化（IndexedDB `firestore/…`）：terminate() + clearIndexedDbPersistence()，
 *     失敗時退回直接 deleteDatabase
 * 永不清除的：
 *   - `substituteSystemData`（不帶學校後綴的舊 key）：帳號制度之前的 V1 本機紀錄，是
 *     legacyMigrationService 遷移 V1 資料的唯一來源（V1 網址已轉址、只有主任能遷移），清掉就永久遺失；
 *     它是凍結快照，暴露面與本次修補前相同。
 *   - `substituteSystemScheduleImports`（V1 匯入版本紀錄與課表快照）：只存在本機、沒有雲端副本，同理保留。
 *   - `gasUrl`：已棄用功能的設定值，不含個資，沒有清除必要（「清除所有資料」功能仍會移除它）。
 *   本專案 localStorage 沒有純 UI 偏好 key，無其他需要保留的項目。
 *   Firebase Auth 自己的 IndexedDB（firebaseLocalStorageDb）由 signOut() 負責清除 token。
 *
 * 清除 Firestore 快取後必須整頁重新載入：實例已 terminate，不能再使用。
 *
 * 行為矩陣（見 authService.js）：
 *   觸發                              | 離線待寫入 | 鏡像(localStorage) | Firestore 離線快取 | 重新載入
 *   使用者主動登出                    | 無         | 清                 | 清                 | 是
 *   使用者主動登出                    | 有         | 先 confirmDialog；繼續→清、取消→不登出（什麼都不動）
 *   session 失效／他分頁登出（被動）  | 不論       | 清                 | 保留（下次同帳號登入可續送） | 是
 *   登入者 uid 與上次不同（切換帳號） | 不論       | 清                 | 強制清             | 是
 */

/** 以前綴比對的 localStorage key（涵蓋所有 schoolId）。 */
export const LOCAL_KEY_PREFIXES = ['substituteSystemData:'];
/** 精確比對的 key：目前沒有（舊 key 與 V1 匯入紀錄不可清，見檔頭）。 */
export const LOCAL_EXACT_KEYS = [];
/** 永不清除的 key（clearLocalUserData 對這些 key 一律跳過）。 */
export const NEVER_CLEAR_KEYS = ['substituteSystemData', 'substituteSystemScheduleImports', 'gasUrl'];

/** 記錄「這個瀏覽器上次登入的 uid」，用來偵測切換帳號。僅存 uid（不透明 ID）。 */
export const LAST_UID_KEY = 'stsystem:lastAuthUid';

/** 等待離線待寫入送出的逾時（毫秒）。 */
export const PENDING_WRITES_TIMEOUT_MS = 5000;

/**
 * 清除 localStorage / sessionStorage 內的可重建資料 key。純函式，storage 可注入以便 node 測試。
 * @param {object} [opts]
 * @param {boolean} [opts.keepLastUid=false] 被動登出時保留上次登入 uid，讓之後的切換帳號偵測仍有效
 * @returns {string[]} 被移除的 key
 */
export function clearLocalUserData(local = globalThis.localStorage, session = globalThis.sessionStorage, { keepLastUid = false } = {}) {
    const removed = [];
    try {
        if (local) {
            const keys = [];
            for (let i = 0; i < local.length; i++) keys.push(local.key(i));
            for (const k of keys) {
                if (NEVER_CLEAR_KEYS.includes(k)) continue;
                const isLastUid = k === LAST_UID_KEY;
                if ((isLastUid && !keepLastUid) || LOCAL_EXACT_KEYS.includes(k) || LOCAL_KEY_PREFIXES.some(p => k.startsWith(p))) {
                    local.removeItem(k);
                    removed.push(k);
                }
            }
        }
    } catch (e) {
        console.warn('[cleanup] 清除 localStorage 失敗:', e);
    }
    try {
        if (session) session.clear();
    } catch (e) {
        console.warn('[cleanup] 清除 sessionStorage 失敗:', e);
    }
    return removed;
}

/** 直接刪除所有 Firestore 的 IndexedDB 資料庫（clearIndexedDbPersistence 失敗時的後備）。 */
async function deleteFirestoreIndexedDbs() {
    if (typeof indexedDB === 'undefined') return;
    let names = [];
    if (typeof indexedDB.databases === 'function') {
        try { names = (await indexedDB.databases()).map(d => d.name).filter(Boolean); } catch { /* 忽略 */ }
    }
    names = names.filter(n => n.startsWith('firestore/'));
    await Promise.all(names.map(name => new Promise(resolve => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
    })));
}

/**
 * 是否仍有尚未送到伺服器的離線寫入。waitForPendingWrites 在逾時內沒完成 → true。
 * 取不到 API、或 promise 被拒絕（寫入被伺服器拒絕＝已被丟棄）→ false。
 */
export async function hasPendingWrites(db, fm = globalThis.window?.firebaseModules, timeoutMs = PENDING_WRITES_TIMEOUT_MS) {
    if (!db || !fm?.waitForPendingWrites) return false;
    let timer;
    const TIMEOUT = Symbol('timeout');
    try {
        const r = await Promise.race([
            fm.waitForPendingWrites(db).then(() => 'done'),
            new Promise(res => { timer = setTimeout(() => res(TIMEOUT), timeoutMs); }),
        ]);
        return r === TIMEOUT;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 清除 Firestore 離線持久化。需傳入目前的 db 實例與 firebaseModules（含 terminate、clearIndexedDbPersistence）。
 * 呼叫後 db 不可再使用，呼叫端須 reload。
 */
export async function clearFirestoreCache(db, fm = globalThis.window?.firebaseModules) {
    try {
        if (db && fm?.terminate) await fm.terminate(db);
        if (db && fm?.clearIndexedDbPersistence) await fm.clearIndexedDbPersistence(db);
    } catch (e) {
        console.warn('[cleanup] clearIndexedDbPersistence 失敗，改直接刪除 IndexedDB:', e?.code || e);
        await deleteFirestoreIndexedDbs();
    }
}

let wiping = false;

/**
 * 清除本機資料並整頁重新載入。重複呼叫只會執行一次。
 * @param {object} opts
 * @param {object} [opts.db] Firestore 實例
 * @param {string} [opts.keepUid] 清除後要記錄為「目前登入者」的 uid（切換帳號偵測用）
 * @param {boolean} [opts.keepFirestoreCache=false] true＝被動登出：只清鏡像，保留 Firestore 離線快取（含待送寫入）
 * @param {boolean} [opts.reload=true]
 */
export async function wipeLocalUserData({ db = null, keepUid = null, keepFirestoreCache = false, reload = true } = {}) {
    if (wiping) return;
    wiping = true;
    clearLocalUserData(globalThis.localStorage, globalThis.sessionStorage, { keepLastUid: keepFirestoreCache });
    if (!keepFirestoreCache) await clearFirestoreCache(db);
    try {
        if (keepUid) localStorage.setItem(LAST_UID_KEY, keepUid);
    } catch { /* 忽略 */ }
    if (reload && typeof location !== 'undefined') location.reload();
    else wiping = false;   // 不重新載入時（單元測試）允許再次呼叫
}
