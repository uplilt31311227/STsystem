/**
 * 紀錄成立的「序號鎖」協定（純函式，不碰 Firebase，可在 node 單元測試）
 *
 * 問題（P6，審計 U2）：核准與組長代發的衝堂重驗是日期範圍查詢，Firestore 交易放不進查詢，
 * 所以「驗證通過 → 交易提交」之間有競態窗口：兩筆互相衝突的申請同時核准、或連點兩次送出，
 * 都會各自驗證通過、各自成立，變成兩筆已成立紀錄（代課費重複計算）。
 *
 * 作法（樂觀序號）：config/recordsLock 文件存一個遞增序號 seq。所有「成立紀錄」的寫入
 * （核准、組長代發、組長批次）都必須在同一個交易內把 seq 加 1：
 *   1. 非交易讀取目前 seq（seq0）
 *   2. 以當下資料做衝堂重驗（查詢）
 *   3. 交易內讀取 seq；不等於 seq0 代表驗證之後又有別筆紀錄成立 → 丟 RECORDS_STALE，回到步驟 1 重驗
 *   4. 相等才寫入紀錄並把 seq 設為 seq0 + 1
 * 兩筆併發的寫入一定有一筆先把 seq 加 1，另一筆在步驟 3 失敗並重新驗證，這時會看到前一筆紀錄而回報衝堂。
 * firestore.rules 另限制 seq 只能「剛好加 1」，所以序號無法被回退。
 *
 * 涵蓋範圍與例外（據實記載）：
 *   - 涵蓋：核准、組長代發、組長批次這三條成立路徑，由本協定在同一個交易內遞增 seq。
 *   - 不遞增 seq：教師自我調課（直接成立，教師也無權寫 recordsLock）、備份還原、舊資料遷移、adminEditRecord（UI 未使用）。
 *     這些路徑不受序號鎖保護，也沒有伺服器端衝堂重驗。
 *   - rules 不強制「新增紀錄必須同交易遞增 seq」，序號鎖是前端協定，目的在避免正常操作下的併發雙重成立，
 *     不是授權機制。自我調課的伺服器端重驗與 rules 強制序號留待後續階段。
 */

export const MAX_GUARD_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 40;
export const BACKOFF_CAP_MS = 800;

/**
 * 預設退避：指數成長的基底（40、80、160…，上限 800ms）加上 0~基底 的隨機抖動。
 * 8 次嘗試最多 7 次等待，總等待上限約 3 秒。
 * @param {number} attempt - 剛失敗的嘗試序號（從 1 起算）
 * @returns {Promise<void>}
 */
export function defaultBackoff(attempt) {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    const ms = base + Math.random() * base;
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class RecordsStaleError extends Error {
    constructor(message = '驗證後又有其他紀錄成立，需要重新驗證') {
        super(message);
        this.name = 'RecordsStaleError';
        this.code = 'RECORDS_STALE';
    }
}

/**
 * 交易內的序號檢查（呼叫端在 tx.get(lockRef) 之後呼叫）。
 * @param {{exists:()=>boolean, data:()=>Object}} snap - 鎖文件快照
 * @param {number} expectedSeq - 驗證前讀到的 seq
 * @returns {number} 下一個要寫入的 seq（expectedSeq + 1）
 */
export function assertSeqUnchanged(snap, expectedSeq) {
    const cur = snap && snap.exists() ? Number(snap.data()?.seq) || 0 : 0;
    if (cur !== expectedSeq) throw new RecordsStaleError();
    return expectedSeq + 1;
}

/**
 * 以序號鎖執行「驗證 → 交易寫入」。
 * @param {Object} p
 * @param {()=>Promise<number>} p.readSeq - 讀取目前 seq（非交易）
 * @param {()=>Promise<void>} p.verify - 衝堂重驗；有衝突直接丟出（原樣往上拋）
 * @param {(seq:number)=>Promise<any>} p.commit - 交易寫入；序號被別人改過要丟 RecordsStaleError
 * @param {number} [p.maxAttempts]
 * @param {(attempt:number)=>Promise<void>} [p.backoff] - 重試前的等待（可注入，測試不必真的等）
 */
export async function runWithRecordsGuard({ readSeq, verify, commit, maxAttempts = MAX_GUARD_ATTEMPTS, backoff = defaultBackoff }) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const seq = await readSeq();
        await verify();
        try {
            return await commit(seq);
        } catch (err) {
            if (err && err.code === 'RECORDS_STALE' && attempt < maxAttempts) { await backoff(attempt); continue; }
            if (err && err.code === 'RECORDS_STALE') {
                const e = new Error('同一時間有多筆調代課紀錄在成立，請稍後再試一次');
                e.code = 'RECORDS_BUSY';
                throw e;
            }
            throw err;
        }
    }
    throw new Error('同一時間有多筆調代課紀錄在成立，請稍後再試一次');
}
