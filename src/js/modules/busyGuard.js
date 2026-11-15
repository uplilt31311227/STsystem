/**
 * 送出鈕防連點（純函式＋可注入按鈕物件，node 可測）
 *
 * 問題（P6，審計 U2）：送出鈕沒有防連點也沒有處理中狀態，連點會送出兩次，
 * 組長代發連點甚至成立兩筆紀錄（代課費重複計算）。
 * 兩層保護：
 *   1. 按下去就把鈕 disabled 並顯示「處理中…」，執行完（成功或失敗）才還原；
 *   2. 以 key 做行程內互斥——同一個動作還在執行時，再來的呼叫直接略過（不排隊、不重送）。
 * 伺服器端的重驗與序號鎖（recordsGuard.js）是最後一道防線，本檔只負責不讓使用者連點出第二個請求。
 */

const inFlight = new Set();

/** 這個 key 的動作是否正在執行。 */
export function isBusy(key) { return inFlight.has(key); }

/**
 * 互斥執行：同一個 key 還在執行時回傳 { skipped:true }，不呼叫 fn。
 * @returns {Promise<{skipped:true}|{skipped:false, value:any}>}
 */
export async function runExclusive(key, fn) {
    if (inFlight.has(key)) return { skipped: true };
    inFlight.add(key);
    try {
        return { skipped: false, value: await fn() };
    } finally {
        inFlight.delete(key);
    }
}

/**
 * 按鈕處理中：互斥執行 fn，期間按鈕 disabled 並顯示處理中文字，結束後還原（不論成功失敗）。
 * @param {{disabled:boolean, textContent:string, dataset?:Object, setAttribute?:Function, removeAttribute?:Function}|null} btn
 * @param {string} key - 互斥鍵（同一個動作用同一個 key）
 * @param {()=>Promise<any>} fn
 * @param {{busyText?:string}} [opts]
 */
export async function withBusyButton(btn, key, fn, { busyText = '處理中…' } = {}) {
    if (inFlight.has(key)) return { skipped: true };
    const prevText = btn ? btn.textContent : '';
    const prevDisabled = btn ? btn.disabled : false;
    if (btn) {
        btn.disabled = true;
        btn.textContent = busyText;
        btn.setAttribute?.('aria-busy', 'true');
    }
    try {
        return await runExclusive(key, fn);
    } finally {
        if (btn) {
            btn.textContent = prevText;
            btn.disabled = prevDisabled;
            btn.removeAttribute?.('aria-busy');
        }
    }
}
