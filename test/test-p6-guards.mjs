/**
 * P6：送出鈕防連點（busyGuard）與序號鎖協定（recordsGuard）的純邏輯測試
 * 真實交易隔離下的併發案例見 test/emulator/p6-concurrency.mjs。
 * 執行：node test/test-p6-guards.mjs
 */
import { withBusyButton, runExclusive, isBusy } from '../src/js/modules/busyGuard.js';
import { runWithRecordsGuard, assertSeqUnchanged, RecordsStaleError, BACKOFF_BASE_MS, BACKOFF_CAP_MS } from '../src/js/modules/v2/recordsGuard.js';
import { checkBatchApprovable, checkBatchWithdrawable, rollbackBatchRequests } from '../src/js/modules/v2/batchDependency.js';

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// ---- busyGuard：連點 ----
{
    const btn = { disabled: false, textContent: '確認並產生表單', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
    let runs = 0;
    const slow = async () => { runs++; await tick(30); return 'ok'; };
    const p1 = withBusyButton(btn, 'k1', slow);
    check('處理中：按鈕停用並顯示「處理中…」', btn.disabled === true && btn.textContent === '處理中…' && btn.attrs['aria-busy'] === 'true');
    const p2 = withBusyButton(btn, 'k1', slow);   // 連點
    const p3 = withBusyButton(btn, 'k1', slow);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    check('連點三次只執行一次', runs === 1 && r1.skipped === false && r2.skipped === true && r3.skipped === true, `runs=${runs}`);
    check('結束後按鈕還原', btn.disabled === false && btn.textContent === '確認並產生表單' && !('aria-busy' in btn.attrs));
    check('結束後可再次執行', (await withBusyButton(btn, 'k1', slow)).skipped === false && runs === 2);
    let thrown = false;
    try { await withBusyButton(btn, 'k2', async () => { throw new Error('boom'); }); } catch { thrown = true; }
    check('執行失敗時錯誤往上拋，按鈕仍還原、鍵已釋放', thrown && btn.disabled === false && !isBusy('k2'));
    check('runExclusive 不同 key 互不影響', (await Promise.all([runExclusive('a', async () => { await tick(); return 1; }), runExclusive('b', async () => 2)])).every(r => !r.skipped));
}

// ---- recordsGuard：兩筆併發成立，只成立一筆 ----
// 記憶體版「資料庫」：seq 與紀錄；commit 內檢查序號並在同一個同步區段寫入（模擬交易的原子性）
function makeDb() {
    const db = { seq: 0, records: [], reads: 0 };
    db.readSeq = async () => { await tick(1); return db.seq; };
    db.tx = async (seq, rec) => {
        await tick(2);                                  // 交易期間讓出執行權，讓另一筆交錯
        const cur = db.seq;                             // tx.get(lock)
        const next = assertSeqUnchanged({ exists: () => true, data: () => ({ seq: cur }) }, seq);
        db.records.push(rec);                           // tx.set(record)
        db.seq = next;                                  // tx.set(lock)
    };
    return db;
}
const conflictWith = (records, slot) => records.find(r => r.slot === slot);
async function approve(db, rec) {
    return runWithRecordsGuard({
        readSeq: db.readSeq,
        verify: async () => {
            await tick(3);                              // 查詢既有紀錄需要時間
            if (conflictWith(db.records, rec.slot)) { const e = new Error('衝堂'); e.code = 'ASSIGNMENT_CONFLICT'; throw e; }
        },
        commit: (seq) => db.tx(seq, rec),
    });
}
{
    const db = makeDb();
    const results = await Promise.allSettled([approve(db, { id: 'A', slot: 's1' }), approve(db, { id: 'B', slot: 's1' })]);
    check('同節雙核准（不同申請搶同一節）：只成立一筆', db.records.length === 1, JSON.stringify(db.records));
    check('另一筆收到衝堂錯誤（重新驗證後看到前一筆）', results.filter(r => r.status === 'rejected' && r.reason.code === 'ASSIGNMENT_CONFLICT').length === 1);
    check('序號鎖只加 1', db.seq === 1);
}
{
    const db = makeDb();
    const r = await Promise.allSettled([approve(db, { id: 'A', slot: 's1' }), approve(db, { id: 'B', slot: 's2' })]);
    check('不同節的兩筆併發：兩筆都成立（被序號擋下後重新驗證，沒有衝突就成立）', db.records.length === 2 && r.every(x => x.status === 'fulfilled'), JSON.stringify(r.map(x => x.status)));
    check('兩筆成立後序號為 2', db.seq === 2);
}
{
    const db = makeDb();
    const r = await Promise.allSettled([1, 2, 3, 4].map(i => approve(db, { id: 'C' + i, slot: 's1' })).flat());
    check('四連點同一節：只成立一筆', db.records.length === 1, `成立 ${db.records.length}`);
    check('其餘三筆都是衝堂拒絕', r.filter(x => x.status === 'rejected' && x.reason.code === 'ASSIGNMENT_CONFLICT').length === 3);
}
{
    let attempts = 0;
    const err = await runWithRecordsGuard({ readSeq: async () => 0, verify: async () => {}, commit: async () => { attempts++; throw new RecordsStaleError(); }, maxAttempts: 3 }).catch(e => e);
    check('序號一直被搶：重試到上限後丟 RECORDS_BUSY（訊息為中文）', attempts === 3 && err.code === 'RECORDS_BUSY' && /稍後再試/.test(err.message));
    const err2 = await runWithRecordsGuard({ readSeq: async () => 0, verify: async () => {}, commit: async () => { throw new Error('寫入失敗'); } }).catch(e => e);
    check('非序號錯誤原樣往上拋', err2.message === '寫入失敗');
}

{
    // 退避：序號被搶先 N 次後成功；退避被呼叫 N 次、等待基底遞增、不真的等
    const waits = [];
    let n = 0;
    const r = await runWithRecordsGuard({ readSeq: async () => 0, verify: async () => {}, commit: async () => { if (++n <= 3) throw new RecordsStaleError(); return 'ok'; }, backoff: async (a) => { waits.push(a); } });
    check('序號被搶先 3 次後成功：回傳結果、退避呼叫 3 次且嘗試序號遞增', r === 'ok' && n === 4 && waits.join() === '1,2,3', waits.join());
    const real = [];
    const t0 = Date.now();
    let m = 0;
    await runWithRecordsGuard({ readSeq: async () => 0, verify: async () => {}, commit: async () => { if (++m <= 7) throw new RecordsStaleError(); }, backoff: async (a) => { real.push(a); } });
    check('預設嘗試次數足以承受 7 次被搶先', m === 8 && real.length === 7);
    let busyAttempts = 0, busyWaits = 0;
    const busy = await runWithRecordsGuard({ readSeq: async () => 0, verify: async () => {}, commit: async () => { busyAttempts++; throw new RecordsStaleError(); }, maxAttempts: 4, backoff: async () => { busyWaits++; } }).catch(e => e);
    check('用盡後丟 RECORDS_BUSY（訊息不變），最後一次失敗後不再退避', busy.code === 'RECORDS_BUSY' && /同一時間有多筆調代課紀錄在成立，請稍後再試一次/.test(busy.message) && busyAttempts === 4 && busyWaits === 3, );
    // 預設退避的等待上限：基底 40*2^(n-1) 上限 800，加抖動至多一倍，7 次總和 <= 2*(40+80+160+320+640+800+800)=5680ms
    const total = [1,2,3,4,5,6,7].reduce((a, i) => a + 2 * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (i - 1)), 0);
    check('預設退避總等待上限在數秒內', total <= 6000, String(total));
}

// ---- batchDependency：審計 repro-02 的核准依賴 ----
const batchReq = { reqId: 'r1', batchId: 'B', batchSize: 2, initiatedBy: 't1', status: 'pending_approval' };
check('批次依賴：同批另一筆被駁回 → 不可單獨核准', checkBatchApprovable(batchReq, [batchReq, { reqId: 'r2', batchId: 'B', initiatedBy: 't1', status: 'rejected' }], []).code === 'BATCH_REJECTED');
check('批次依賴：同批另一筆已撤回（刪除）→ 筆數不足', checkBatchApprovable(batchReq, [batchReq], []).code === 'BATCH_INCOMPLETE');
check('批次依賴：同批另一筆仍在途 → 可核准', checkBatchApprovable(batchReq, [batchReq, { reqId: 'r2', batchId: 'B', initiatedBy: 't1', status: 'pending_swap_consent' }], []).ok === true);
check('批次依賴：同批另一筆已核准（只剩紀錄，申請已清掉）→ 可核准', checkBatchApprovable(batchReq, [batchReq], [{ recordId: 'x', fromRequestId: 'r2', batchId: 'B', initiatedBy: 't1' }]).ok === true);
check('批次依賴：別人用同 batchId 塞的申請不算同批', checkBatchApprovable(batchReq, [batchReq, { reqId: 'r9', batchId: 'B', initiatedBy: 'evil', status: 'rejected' }], [{ recordId: 'x', fromRequestId: 'r2', batchId: 'B', initiatedBy: 't1' }]).ok === true);
check('非批次申請不檢查', checkBatchApprovable({ reqId: 'z' }, [], []).ok === true);
check('撤回依賴：同批已有核准成立 → 不可撤回', checkBatchWithdrawable(batchReq, [batchReq, { reqId: 'r2', batchId: 'B', initiatedBy: 't1', status: 'approved' }], []).code === 'BATCH_PARTLY_APPROVED');
check('撤回依賴：同批其餘皆在途 → 列出要連帶撤回的申請', checkBatchWithdrawable(batchReq, [batchReq, { reqId: 'r2', batchId: 'B', initiatedBy: 't1', status: 'pending_approval' }], []).openSiblings.length === 1);

// ---- P10：批次含自我調課紀錄時，撤回檢查排除自我調課 ----
check('撤回依賴（P10）：同批只有自我調課成立的紀錄 → 可撤回，其餘在途申請列入連帶',
    (() => { const r = checkBatchWithdrawable(batchReq, [batchReq, { reqId: 'r2', batchId: 'B', initiatedBy: 't1', status: 'pending_approval' }],
        [{ recordId: 'self1', batchId: 'B', initiatedBy: 't1', isSelfSwap: true, status: 'approved' }]); return r.ok === true && r.openSiblings.length === 1; })());
check('撤回依賴（P10）：自我調課以外另有核准成立的一般紀錄 → 仍不可撤回',
    checkBatchWithdrawable(batchReq, [batchReq], [{ recordId: 'self1', batchId: 'B', initiatedBy: 't1', isSelfSwap: true }, { recordId: 'x', fromRequestId: 'r2', batchId: 'B', initiatedBy: 't1' }]).code === 'BATCH_PARTLY_APPROVED');

// ---- P10：批次回滾的撤回筆數 ----
{
    // 模擬 cancelRequest：第一筆撤回連帶撤掉同批其餘，之後再撤回丟「找不到」
    const open = new Set(['a', 'b', 'c']);
    const fakeCancel = async (id) => {
        if (!open.has(id)) throw new Error('找不到此請求（可能已被撤回）');
        const cascaded = [...open].filter(x => x !== id);
        open.clear();
        return { cascaded };
    };
    const created = [{ reqId: 'a' }, { recordId: 'self' }, { reqId: 'b' }, { reqId: 'c' }];
    const r = await rollbackBatchRequests(created, fakeCancel);
    check('批次回滾：連帶撤回後的「找不到」計入已撤回（3 筆申請 → undone=3，failed=0）', r.undone === 3 && r.failed === 0, JSON.stringify(r));
    const r2 = await rollbackBatchRequests([{ reqId: 'a' }, { reqId: 'b' }], async (id) => { if (id === 'a') throw new Error('此申請已核准成立，無法撤回'); return { cascaded: [] }; });
    check('批次回滾：真正失敗（已核准）計入 failed，不算撤回', r2.undone === 1 && r2.failed === 1, JSON.stringify(r2));
    const r3 = await rollbackBatchRequests([{ recordId: 'self' }], async () => { throw new Error('不該被呼叫'); });
    check('批次回滾：只有自我調課（無 reqId）→ 不呼叫撤回', r3.undone === 0 && r3.failed === 0);
}

console.log(failed === 0 ? '\n全部通過' : `\n${failed} 項失敗`);
process.exit(failed === 0 ? 0 : 1);
