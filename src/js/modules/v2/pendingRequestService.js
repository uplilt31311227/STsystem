/**
 * V2 三種審核流程狀態機（Phase 3）
 *
 * 狀態流轉：
 *   代課（substitute）  create → pending_approval → approver 核准 → substituteRecord 成立
 *   調課（swap）        create → pending_swap_consent（對方同意）→ pending_approval → approver 核准 → 成立
 *   多重調課（multi_swap）create → pending_swap_consent（全員同意，逐一移出 pendingConsentTeacherIds）
 *                                → 全員同意後 pending_approval → approver 核准 → 成立
 *   任一階段皆可 reject → 整批 status=rejected（soft-reject，保留文件供發起人 dismiss）
 *   cancel  → 發起人撤回，刪除 pending
 *   adminCreate → 直接成立 substituteRecord（approver 代發起，不經 pending）
 *
 * 舊資料相容（alpha 期 status='pending'）：讀取時一律經 normalizeLegacyRequest() 映射為
 *   「調課雙簽、對方尚未同意」（pendingConsentTeacherIds=[requiredApproverId]），不需遷移腳本。
 *
 * 核准動作（approveRequest）改為 approver（director/section_chief）專用，且必須用 runTransaction，
 * 避免兩位 approver 並發核准造成重複建立 record；後到者收到 RequestAlreadyProcessedError。
 *
 * 所有操作皆寫入 operationLog。
 */

import * as dataSvc        from './schoolDataService.js';
import * as logger         from './operationLogger.js';
import * as roleSvc        from './roleService.js';
import { getV2Firestore }  from './firebaseV2.js';
import {
    LOG_ACTIONS,
    LOG_TARGET_TYPES,
    REQUEST_STATUS,
    REQUEST_TYPES,
    SCHEMA_PATHS,
} from './schemaConstants.js';

/**
 * 交易併發衝突（核准/同意時請求已不在預期狀態）時丟出的特定錯誤。
 * UI 依 err.code === 'ALREADY_PROCESSED' 顯示「已被處理」並刷新列表，而非泛用 alert。
 */
export class RequestAlreadyProcessedError extends Error {
    constructor(message = '此請求已被處理，請重新整理列表') {
        super(message);
        this.name = 'RequestAlreadyProcessedError';
        this.code = 'ALREADY_PROCESSED';
    }
}

function buildAffectedList(req) {
    const list = [
        req.initiatedBy,
        req.requiredApproverId,
        req.originalTeacherId,
        req.substituteTeacherId,
        req.swapTeacherId,
    ];
    if (Array.isArray(req.pendingConsentTeacherIds)) list.push(...req.pendingConsentTeacherIds);
    if (Array.isArray(req.consentTeacherIds))        list.push(...req.consentTeacherIds);
    if (req.swapConsents && typeof req.swapConsents === 'object') list.push(...Object.keys(req.swapConsents));
    return [...new Set(list.filter(Boolean))];
}

/**
 * 舊資料相容：alpha 期 status=pending 的文件（單簽、被邀請人同意即成立）在讀取/渲染時
 * 映射為「調課雙簽、對方尚未同意」（pendingConsentTeacherIds=[requiredApproverId]）。
 * 純讀取期映射，不寫回資料庫，因此不需要遷移腳本。
 */
export function normalizeLegacyRequest(req) {
    if (!req) return req;
    if (req.status !== REQUEST_STATUS.PENDING) return req;
    return {
        ...req,
        requestType: req.requestType || REQUEST_TYPES.SWAP,
        status: REQUEST_STATUS.PENDING_SWAP_CONSENT,
        pendingConsentTeacherIds: (Array.isArray(req.pendingConsentTeacherIds) && req.pendingConsentTeacherIds.length)
            ? req.pendingConsentTeacherIds
            : [req.requiredApproverId].filter(Boolean),
        swapConsents: req.swapConsents || {},
        __legacyPending: true,
    };
}

/**
 * 教師發起代課／調課／多重調課：寫入 pendingRequests，依 requestType 分流初始狀態。
 * 若發起人是 approver 且要代他人發起，仍走此函式（canInitiateFor 對 approver 一律放行）；
 * 純代發起且不經任何審核請改用 adminCreate()。
 *
 * requestType 未帶時預設為 substitute，相容既有呼叫（Phase 3 之前的呼叫點未帶此欄位）。
 */
export async function createRequest(payload) {
    const id = roleSvc.getCurrentIdentity();
    if (!id) throw new Error('尚未登入');

    const requestType = payload.requestType || REQUEST_TYPES.SUBSTITUTE;
    if (!Object.values(REQUEST_TYPES).includes(requestType)) {
        throw new Error(`不支援的申請類型：${requestType}`);
    }

    if (!roleSvc.canInitiateFor(payload.initiatedBy || id.teacherId)) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.PENDING_REQUEST, null, {
            reason: 'create_request_not_self',
            attempted: payload.initiatedBy,
        });
        throw new Error('無權代替此教師發起');
    }

    let status;
    let pendingConsentTeacherIds = [];

    if (requestType === REQUEST_TYPES.SUBSTITUTE) {
        // 代課：單簽，不需其他教師同意，直接進入組長/主任核准佇列。
        status = REQUEST_STATUS.PENDING_APPROVAL;
    } else if (requestType === REQUEST_TYPES.SWAP) {
        // 調課：雙簽，對方教師同意後才進入核准佇列。
        const partner = payload.swapTeacherId || payload.requiredApproverId;
        if (!partner) throw new Error('調課申請缺少對方教師 ID');
        status = REQUEST_STATUS.PENDING_SWAP_CONSENT;
        pendingConsentTeacherIds = [partner];
    } else {
        // 多重調課：全員同意，consentTeacherIds 未帶時退回 swapTeacherId。
        const rawIds = (Array.isArray(payload.consentTeacherIds) && payload.consentTeacherIds.length)
            ? payload.consentTeacherIds
            : [payload.swapTeacherId || payload.requiredApproverId, ...(payload.additionalConsentTeacherIds || [])];
        pendingConsentTeacherIds = [...new Set(rawIds.filter(Boolean))];
        if (!pendingConsentTeacherIds.length) throw new Error('多重調課需至少一位需同意的教師');
        status = REQUEST_STATUS.PENDING_SWAP_CONSENT;
    }

    const req = {
        ...payload,
        requestType,
        status,
        pendingConsentTeacherIds,
        swapConsents: {},
        initiatedBy:     payload.initiatedBy || id.teacherId,
        initiatedByName: payload.initiatedByName || id.name,
        createdAt:       new Date().toISOString(),
    };
    // 這兩個欄位僅供本函式組裝 pendingConsentTeacherIds 使用，不寫入文件。
    delete req.consentTeacherIds;
    delete req.additionalConsentTeacherIds;

    const saved = await dataSvc.createPendingRequest(req);

    await logger.log(
        LOG_ACTIONS.CREATE_REQUEST,
        LOG_TARGET_TYPES.PENDING_REQUEST,
        saved.reqId,
        {
            initiatedBy:              saved.initiatedBy,
            requiredApproverId:       saved.requiredApproverId,
            requestType:              saved.requestType,
            pendingConsentTeacherIds: saved.pendingConsentTeacherIds,
            affectedTeacherIds:       buildAffectedList(saved),
            summary: {
                type: saved.type, date: saved.date, period: saved.period, className: saved.className,
            },
        }
    );
    return saved;
}

/**
 * 同意人（swap 對象／multi_swap 全員之一）同意：把自己從 pendingConsentTeacherIds 移除、
 * 寫入 swapConsents[teacherId]；陣列清空時 status → pending_approval。
 * 用 runTransaction 讀-改-寫，避免多重調課下兩人同時同意互相覆蓋彼此的陣列快照。
 */
export async function consentRequest(reqId) {
    const me = roleSvc.getCurrentIdentity();
    if (!me?.teacherId) throw new Error('尚未登入或無教師身份');

    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));

    const result = await fs.runTransaction(fs.db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('找不到此請求');
        const normalized = normalizeLegacyRequest({ reqId, ...snap.data() });

        if (normalized.status !== REQUEST_STATUS.PENDING_SWAP_CONSENT) {
            throw new RequestAlreadyProcessedError('此請求已不在待同意階段，可能已被他人處理或已被駁回');
        }
        const pending = Array.isArray(normalized.pendingConsentTeacherIds) ? normalized.pendingConsentTeacherIds : [];
        if (!pending.includes(me.teacherId)) {
            throw new Error('您不在此請求的待同意名單中');
        }

        const now         = new Date().toISOString();
        const nextPending  = pending.filter(tid => tid !== me.teacherId);
        const nextConsents = { ...(normalized.swapConsents || {}), [me.teacherId]: { consentedAt: now } };
        const nextStatus   = nextPending.length === 0 ? REQUEST_STATUS.PENDING_APPROVAL : REQUEST_STATUS.PENDING_SWAP_CONSENT;

        const patch = {
            pendingConsentTeacherIds: nextPending,
            swapConsents:             nextConsents,
            status:                   nextStatus,
            statusUpdatedAt:          now,
        };
        tx.update(ref, patch);
        return { ...normalized, ...patch };
    });

    await logger.log(
        LOG_ACTIONS.SWAP_CONSENT,
        LOG_TARGET_TYPES.PENDING_REQUEST,
        reqId,
        {
            consentedBy:                me.teacherId,
            requestType:                result.requestType,
            remainingConsentTeacherIds: result.pendingConsentTeacherIds,
            nextStatus:                 result.status,
            affectedTeacherIds:         buildAffectedList(result),
        }
    );
    return result;
}

/**
 * approver（組長/主任）核准：交易內確認狀態仍為 pending_approval，
 * 建立 substituteRecord + 更新 request status→approved，交易失敗（狀態已變）丟
 * RequestAlreadyProcessedError，供兩位 approver 並發核准時後到者顯示「已被處理」。
 *
 * 設計取捨：multi_swap 建立「一筆」substituteRecord（非每位教師各一筆），並在 record 上
 * 附加 affectedTeacherIds（涵蓋 buildAffectedList 全部關係人），沿用 roleService
 * filterRecordsForCurrent() 既有的 affectedTeacherIds 過濾邏輯，讓全體同意人皆可在
 * 「調代課紀錄」看到同一筆紀錄與下載同一份 PDF；比多筆 record 更貼近「一次調課異動」
 * 的實際語意，也不需要額外處理多筆 record 的交易一致性。
 */
export async function approveRequest(reqId) {
    if (!roleSvc.isApprover()) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.PENDING_REQUEST, reqId, {
            reason: 'approve_not_approver',
        });
        throw new Error('僅教學組長/教務主任可核准申請');
    }

    const me  = roleSvc.getCurrentIdentity();
    const fs  = await getV2Firestore();
    const reqRef = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));

    let createdRecordId = null;
    let reqSnapshot      = null;

    await fs.runTransaction(fs.db, async (tx) => {
        const snap = await tx.get(reqRef);
        if (!snap.exists()) throw new Error('找不到此請求');
        const data = normalizeLegacyRequest({ reqId, ...snap.data() });

        if (data.status !== REQUEST_STATUS.PENDING_APPROVAL) {
            throw new RequestAlreadyProcessedError('此請求已被處理（可能已被其他核准人核准或駁回）');
        }

        const now       = new Date().toISOString();
        const recordId  = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        const recordRef = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));

        const record = { ...data };
        delete record.reqId;
        delete record.pendingConsentTeacherIds;
        delete record.swapConsents;
        delete record.__legacyPending;
        record.status          = REQUEST_STATUS.APPROVED;
        record.approvedAt      = now;
        record.approvedBy      = me.teacherId;
        record.approvedByName  = me.name;
        record.fromRequestId   = reqId;
        record.createdAt       = record.createdAt || now;
        record.affectedTeacherIds = buildAffectedList(data);

        tx.set(recordRef, record);
        tx.update(reqRef, {
            status:          REQUEST_STATUS.APPROVED,
            approvedAt:      now,
            approvedBy:      me.teacherId,
            approvedByName:  me.name,
            statusUpdatedAt: now,
        });

        createdRecordId = recordId;
        reqSnapshot      = record;
    });

    await logger.log(
        LOG_ACTIONS.APPROVE,
        LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
        createdRecordId,
        {
            fromRequestId:      reqId,
            initiatedBy:        reqSnapshot.initiatedBy,
            requestType:        reqSnapshot.requestType,
            affectedTeacherIds: buildAffectedList(reqSnapshot),
        }
    );

    return { recordId: createdRecordId, ...reqSnapshot };
}

/**
 * 拒絕：同意階段（pendingConsentTeacherIds 內任一人）或核准階段（approver）皆可拒絕。
 * soft-reject（標記 status=rejected，保留文件讓發起人看到），發起人確認後由
 * dismissRejectedRequest() 真正刪除。
 *
 * 比照 consentRequest/approveRequest 用 runTransaction + tx.update 直寫（不經
 * dataSvc.updatePendingRequest wrapper——wrapper 會注入 updatedAt，不在 rules
 * affectedKeys 白名單內，部署後所有駁回都會 permission-denied）；交易內確認
 * status 仍是 pending_swap_consent / pending_approval，否則丟
 * RequestAlreadyProcessedError（防止把已 approved 的請求覆寫成 rejected）。
 */
export async function rejectRequest(reqId, note = '') {
    const me = roleSvc.getCurrentIdentity();
    if (!me) throw new Error('尚未登入');

    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));

    const normalized = await fs.runTransaction(fs.db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('找不到此請求');
        const data = normalizeLegacyRequest({ reqId, ...snap.data() });

        if (data.status !== REQUEST_STATUS.PENDING_SWAP_CONSENT
            && data.status !== REQUEST_STATUS.PENDING_APPROVAL) {
            throw new RequestAlreadyProcessedError('此請求已被處理（可能已被核准或已被駁回）');
        }

        const isPendingConsenter = Array.isArray(data.pendingConsentTeacherIds)
            && data.pendingConsentTeacherIds.includes(me.teacherId);
        if (!roleSvc.isApprover() && !isPendingConsenter) {
            throw new Error('您無權拒絕此請求');
        }

        const now = new Date().toISOString();
        tx.update(ref, {
            status:          REQUEST_STATUS.REJECTED,
            rejectedAt:      now,
            rejectedBy:      me.teacherId,
            rejectedByName:  me.name,
            rejectNote:      note || '',
            statusUpdatedAt: now,
        });
        return data;
    }).catch(async (err) => {
        if (err.message === '您無權拒絕此請求') {
            await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.PENDING_REQUEST, reqId, {
                reason: 'reject_not_authorized',
            });
        }
        throw err;
    });

    await logger.log(
        LOG_ACTIONS.REJECT,
        LOG_TARGET_TYPES.PENDING_REQUEST,
        reqId,
        {
            initiatedBy:        normalized.initiatedBy,
            requestType:        normalized.requestType,
            rejectedBy:         me.teacherId,
            affectedTeacherIds: buildAffectedList(normalized),
            note,
        }
    );
}

/**
 * 發起人（或 admin）確認已知悉被拒絕，真正刪除 pending 文件。
 */
export async function dismissRejectedRequest(reqId) {
    const req = await dataSvc.getPendingRequest(reqId);
    if (!req) return;
    if (req.status !== REQUEST_STATUS.REJECTED) {
        throw new Error('此請求尚未被拒絕，無法關閉');
    }
    if (!roleSvc.canCancelRequest(req)) {
        throw new Error('您不是發起人，無法關閉');
    }
    await dataSvc.deletePendingRequest(reqId);
}

/** 發起人撤回：刪除 pending。 */
export async function cancelRequest(reqId, note = '') {
    const req = await dataSvc.getPendingRequest(reqId);
    if (!req) throw new Error('找不到此請求');
    const normalized = normalizeLegacyRequest(req);
    if (!roleSvc.canCancelRequest(normalized)) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.PENDING_REQUEST, reqId, {
            reason: 'cancel_not_initiator_nor_admin',
        });
        throw new Error('您不是發起人，無法撤回');
    }
    await dataSvc.deletePendingRequest(reqId);
    await logger.log(
        LOG_ACTIONS.CANCEL,
        LOG_TARGET_TYPES.PENDING_REQUEST,
        reqId,
        {
            initiatedBy:        normalized.initiatedBy,
            requestType:        normalized.requestType,
            affectedTeacherIds: buildAffectedList(normalized),
            note,
        }
    );
}

/** 組長/主任代發起：直接成立 substituteRecord，不經 pending。 */
export async function adminCreate(payload) {
    if (!roleSvc.isAdmin()) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.SUBSTITUTE_RECORD, null, {
            reason: 'admin_create_not_admin',
        });
        throw new Error('僅組長可代發起');
    }

    const me  = roleSvc.getCurrentIdentity();
    const now = new Date().toISOString();
    const record = {
        ...payload,
        status:           REQUEST_STATUS.APPROVED,
        initiatedBy:      payload.initiatedBy,
        initiatedByName:  payload.initiatedByName,
        initiatedByRole:  'admin',
        adminOperatorId:  me.teacherId,
        adminOperatorName: me.name,
        createdAt:        now,
        approvedAt:       now,
    };
    const saved = await dataSvc.createSubstituteRecord(record);

    await logger.log(
        LOG_ACTIONS.ADMIN_CREATE,
        LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
        saved.recordId,
        {
            onBehalfOf: payload.initiatedBy,
            affectedTeacherIds: buildAffectedList(payload),
            summary: {
                type: saved.type, date: saved.date, period: saved.period, className: saved.className,
            },
        }
    );
    return saved;
}

/** admin 編輯已成立的 record。 */
export async function adminEditRecord(recordId, patch) {
    if (!roleSvc.isAdmin()) {
        throw new Error('僅組長可編輯紀錄');
    }
    const before = await dataSvc.getSubstituteRecord(recordId);
    if (!before) throw new Error('找不到紀錄');
    const after = await dataSvc.updateSubstituteRecord(recordId, patch);
    await logger.log(
        LOG_ACTIONS.EDIT,
        LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
        recordId,
        { before, after, affectedTeacherIds: buildAffectedList(before) }
    );
    return after;
}

/** admin 刪除已成立的 record。 */
export async function adminDeleteRecord(recordId) {
    if (!roleSvc.isAdmin()) {
        throw new Error('僅組長可刪除紀錄');
    }
    const before = await dataSvc.getSubstituteRecord(recordId);
    if (!before) return;
    await dataSvc.deleteSubstituteRecord(recordId);
    await logger.log(
        LOG_ACTIONS.DELETE,
        LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
        recordId,
        { before, affectedTeacherIds: buildAffectedList(before) }
    );
}
