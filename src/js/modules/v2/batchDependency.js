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
    const legs = collectBatchLegs(req, requests, records);
    const others = [...legs.values()].filter(l => l.key !== legKey(req));
    if (others.some(l => l.status === 'approved')) {
        return { ok: false, code: 'BATCH_PARTLY_APPROVED',
            message: '同批多重調課已有申請核准成立，不能單獨撤回剩下的申請，請洽教學組處理' };
    }
    return { ok: true, openSiblings: others.filter(l => l.status === 'open').map(l => l.ref) };
}
