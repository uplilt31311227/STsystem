/**
 * 同批（batchId）調課紀錄／申請的歸屬檢查（純函式，node 可測）。
 *
 * 問題：batchId 是資料欄位，教師可寫入「自我調課」紀錄（rules 允許）並把 batchId 指定成他人
 * 多重調課批次的 id，於是依 batchId 聚合出的「整批調課單 PDF／在途清單」會混入別人的紀錄。
 *
 * 紀錄上可用的發起人欄位（前端寫入形狀）：
 *   - 教師發起（申請→核准）：initiatedBy ＝ 發起教師 teacherId（writeV2Record 強制為本人），整批一致
 *   - 教師自行調課（isSelfSwap，同一批次內可出現）：直接成立，initiatedBy ＝ 本人（rules 要求必帶），
 *     與同批其他筆的 initiatedBy 相同
 *   - 組長代發（adminCreate，含批次內的自行調課）：固定帶 adminOperatorId ＝ 操作的組長 teacherId，
 *     整批一致，但各筆 initiatedBy 會不同（是各筆的原任課教師）
 * 因此「批次發起者鍵」= adminOperatorId || initiatedBy；自我調課紀錄 rules 禁止帶 adminOperatorId，
 * 所以攻擊者的紀錄鍵一定是攻擊者自己的 teacherId，不會等於受害批次的鍵。
 *
 * 規則（結果與基準筆無關：同一批內任一筆為基準都得到相同的完整批次）：
 *   1. 兩邊的批次發起者鍵都有值 → 必須相同
 *   2. 兩邊都沒有鍵 → 只有雙方皆為舊系統遷移資料（isLegacy／migratedFrom）才視為同批
 *   3. 只有一邊有鍵 → 排除（缺發起者鍵且非舊系統遷移資料，不可信任）
 */

/** 批次發起者鍵；無法判定回傳 null。 */
export function batchInitiatorKey(r) {
    const k = r && (r.adminOperatorId || r.initiatedBy);
    return typeof k === 'string' && k ? k : null;
}

/** 是否為舊系統（V1）遷移資料：遷移時一律帶 isLegacy:true 與 migratedFrom。 */
export function isLegacyRecord(r) {
    return !!r && (r.isLegacy === true || (r.migratedFrom != null && typeof r.migratedFrom === 'object'));
}

/**
 * 從 list（以 batchId 查出的紀錄或在途申請）中，留下與 anchor 屬於同一批的項目。
 * anchor 本身（以 recordId／reqId 判斷）一律保留。
 */
export function filterSameBatch(anchor, list) {
    if (!Array.isArray(list)) return [];
    const ka = batchInitiatorKey(anchor);
    const anchorId = anchor && (anchor.recordId || anchor.reqId);
    return list.filter(r => {
        const rid = r && (r.recordId || r.reqId);
        if (anchorId && rid === anchorId) return true;
        const kr = batchInitiatorKey(r);
        if (ka && kr) return ka === kr;
        if (!ka && !kr) return isLegacyRecord(r) && isLegacyRecord(anchor);
        return false;
    });
}
