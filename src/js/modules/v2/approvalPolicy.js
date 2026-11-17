/**
 * 核准職務分離（P9 批次 A2，SB-I7）：核准者不可核准自己發起的申請。
 *
 * 與 firestore.rules v2.17 的 isOwnRequestBlocked／isSelfOnlyRequest 逐條對齊（改這裡請同步改 rules）：
 *   - 申請的 initiatedBy 等於核准者「自己」（登入 uid，或教師檔的 teacherId）→ 不可核准。
 *   - 唯一例外：自我調課且不牽涉其他教師（isSelfSwap、換走與換進的教師都是本人、沒有其他同意人）。
 *   - 組長／主任代教師發起：initiatedBy 是被代發的教師，不是核准者，不受影響。
 *   - 駁回不受限。
 * 純函式、無瀏覽器依賴，由 test/test-p9-authz.mjs 測試。
 */

/** 這筆申請是否為「自我調課、不牽涉其他教師」（initiatorId 為發起人／核准者本人的 id）。 */
export function isSelfOnlyRequest(req, initiatorId) {
    if (!req || !initiatorId) return false;
    const inSelf = (v) => v === undefined || v === null || v === initiatorId;
    const consents = Array.isArray(req.pendingConsentTeacherIds) ? req.pendingConsentTeacherIds : [];
    return req.isSelfSwap === true
        && req.originalTeacherId === initiatorId
        && inSelf(req.swapTeacherId)
        && inSelf(req.substituteTeacherId)
        && consents.length === 0
        && inSelf(req.requiredApproverId);
}

/**
 * 此身分能否核准這筆申請。
 * @param {object} req 申請（含 initiatedBy）
 * @param {{uid?: string, teacherId?: string|null}} identity 目前登入者（roleService.getCurrentIdentity()）
 * @returns {{ok: boolean, reason: string}}
 */
export function checkApprovalSeparation(req, identity) {
    const ini = req?.initiatedBy;
    // 舊申請缺 initiatedBy：rules 對「沒有成員身分的 platformAdmin」（myTeacherId 為空字串，等於缺值）判成自己發起而擋下，
    // 前端對 platformAdmin 一律比照停用（成員身分的核准者不受影響）。
    if (!ini && identity?.isPlatformAdmin) {
        return { ok: false, reason: '這筆申請沒有記錄發起人，平台管理員無法核准（為落實職務分離），請由該校組長或主任核准。' };
    }
    const mine = new Set([identity?.uid, identity?.teacherId].filter(Boolean));
    if (!ini || !mine.has(ini)) return { ok: true, reason: '' };
    if (isSelfOnlyRequest(req, ini)) return { ok: true, reason: '' };
    return {
        ok: false,
        reason: '這是您自己發起的申請，為落實職務分離，不能由您本人核准，請另一位組長或主任核准。',
    };
}
