/**
 * 多重調課批次的依賴檢查（純函式，node 可測）
 *
 * 問題（P6，審計 L5）：多重調課批次在 V2 拆成每筆獨立申請、獨立同意與核准。批次內各筆互相依賴
 * （例如甲的第二節移到另一天，同時另一筆把乙調進甲原本的位置），其中一筆被駁回或撤回後，
 * 單獨核准剩下的那筆會讓教師同一節排兩班，或讓某班那一節沒人上。
 *
 * 規則：核准批次中的一筆之前，同批的每一筆都必須「仍在途或已核准」，且筆數與送出時的 batchSize 相符。
 * 同批有任何一筆被駁回、或已被撤回／刪除，就不能再單獨核准，須整批駁回後由申請人重新送出。
 * 撤回同樣以批次為單位：同批已有核准成立者，不可單獨撤回剩下的申請（會留下半套調課）。
 */
import { filterSameBatch } from './batchGuard.js';

const OPEN = ['pending', 'pending_swap_consent', 'pending_approval'];

const legKey = (r) => r.reqId || r.fromRequestId || r.recordId || r.id;

/**
 * 整理同批的「腿」：把申請（任何狀態）與已成立紀錄依來源申請去重。
 * @returns {Map<string, {key:string, status:'open'|'approved'|'rejected', ref:Object}>}
 */
export function collectBatchLegs(anchor, requests = [], records = []) {
    const legs = new Map();
    for (const r of filterSameBatch(anchor, requests || [])) {
        const status = r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected'
            : OPEN.includes(r.status) ? 'open' : 'rejected';
        legs.set(legKey(r), { key: legKey(r), status, ref: r });
    }
    for (const r of filterSameBatch(anchor, records || [])) {
        const key = legKey(r);
        if (!legs.has(key)) legs.set(key, { key, status: 'approved', ref: r });
    }
    return legs;
}

/**
 * 核准前檢查批次依賴。
 * @param {Object} req - 要核准的申請（需含 batchId、batchSize、reqId）
 * @param {Array} requests - 同 batchId 的全部申請（任何狀態，含 req 自己）
 * @param {Array} records - 同 batchId 的已成立紀錄
 * @returns {{ok:true}|{ok:false, code:'BATCH_REJECTED'|'BATCH_INCOMPLETE', message:string}}
 */
export function checkBatchApprovable(req, requests, records) {
    if (!req || !req.batchId) return { ok: true };
    const legs = collectBatchLegs(req, requests, records);
    legs.set(legKey(req), legs.get(legKey(req)) || { key: legKey(req), status: 'open', ref: req });
    const others = [...legs.values()].filter(l => l.key !== legKey(req));
    if (others.some(l => l.status === 'rejected')) {
        return { ok: false, code: 'BATCH_REJECTED',
            message: '核准失敗：同批多重調課中有申請已被駁回，單獨核准會讓課務不完整，請連同整批駁回，由申請人重新送出' };
    }
    const size = Number(req.batchSize) || 0;
    if (size > 0 && legs.size < size) {
        return { ok: false, code: 'BATCH_INCOMPLETE',
            message: `核准失敗：同批多重調課應有 ${size} 筆，目前只剩 ${legs.size} 筆（其餘已被撤回或刪除），請連同整批駁回，由申請人重新送出` };
    }
    return { ok: true };
}

/**
 * 撤回前檢查批次：同批已有核准成立者，剩下的申請不可單獨撤回。
 * @returns {{ok:true, openSiblings:Array}|{ok:false, code:'BATCH_PARTLY_APPROVED', message:string}}
 */
export function checkBatchWithdrawable(req, requests, records) {
    if (!req || !req.batchId) return { ok: true, openSiblings: [] };
    // 自我調課是教師自行調課直接成立的紀錄（沒有對應申請、教師端也無法刪除），不算「核准成立的腿」：
    // 否則批次內有自我調課時，其餘在途申請永遠撤不掉。（核准判斷 checkBatchApprovable 不受影響，自我調課照常算一條腿。）
    const keptRecords = (records || []).filter(r => !(r && r.isSelfSwap === true));
    const legs = collectBatchLegs(req, requests, keptRecords);
    const others = [...legs.values()].filter(l => l.key !== legKey(req));
    if (others.some(l => l.status === 'approved')) {
        return { ok: false, code: 'BATCH_PARTLY_APPROVED',
            message: '同批多重調課已有申請核准成立，不能單獨撤回剩下的申請，請洽教學組處理' };
    }
    return { ok: true, openSiblings: others.filter(l => l.status === 'open').map(l => l.ref) };
}

/**
 * 批次送出失敗後的回滾：逐筆撤回已建立的在途申請，回傳實際撤回的筆數。
 * cancelRequest 以批次為單位連帶撤回同批其餘在途申請（回傳 cascaded），之後對已被連帶撤回的申請再撤回
 * 會丟「找不到此請求」；這種情況視為已撤回，並以 Set 去重避免重複計數。
 * @param {Array<{reqId?:string}>} created - 已建立的結果（自我調課直接成立者沒有 reqId，略過）
 * @param {(reqId:string, note:string)=>Promise<{cascaded?:string[]}|void>} cancelFn
 * @returns {Promise<{undone:number, failed:number}>}
 */
export async function rollbackBatchRequests(created, cancelFn) {
    const gone = new Set();
    let failed = 0;
    for (const saved of [...(created || [])].reverse()) {
        const id = saved && saved.reqId;
        if (!id || gone.has(id)) continue;
        try {
            const res = await cancelFn(id, '批次送出失敗，自動撤回');
            gone.add(id);
            for (const c of (res && res.cascaded) || []) gone.add(c);
        } catch (e) {
            if (/找不到此請求/.test((e && e.message) || '')) gone.add(id);   // 已被連帶撤回
            else failed++;
        }
    }
    // 只計入本次建立的申請（cascaded 理論上可能含其他 id，不應灌大數字）
    const createdIds = new Set((created || []).map(s => s && s.reqId).filter(Boolean));
    const undone = [...gone].filter(id => createdIds.has(id)).length;
    return { undone, failed };
}
