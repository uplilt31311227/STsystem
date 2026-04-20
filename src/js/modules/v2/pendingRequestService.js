/**
 * V2 同意流程狀態機
 *
 * 狀態流轉：
 *   create  →  pending
 *   approve →  成立為 substituteRecord，刪除 pending
 *   reject  →  刪除 pending，寫 log
 *   cancel  →  教師撤回，刪除 pending，寫 log
 *   adminCreate → 直接成立 substituteRecord（不經 pending）
 *
 * 所有操作皆寫入 operationLog。
 */

import * as dataSvc    from './schoolDataService.js';
import * as logger     from './operationLogger.js';
import * as roleSvc    from './roleService.js';
import {
    LOG_ACTIONS,
    LOG_TARGET_TYPES,
    REQUEST_STATUS,
} from './schemaConstants.js';

function buildAffectedList(req) {
    return [
        req.initiatedBy,
        req.requiredApproverId,
        req.originalTeacherId,
        req.substituteTeacherId,
        req.swapTeacherId,
    ].filter(Boolean);
}

/**
 * 教師發起調課：寫入 pendingRequests。
 * 若發起人是 admin 且 skipApproval=true，則直接呼叫 adminCreate()。
 */
export async function createRequest(payload) {
    const id = roleSvc.getCurrentIdentity();
    if (!id) throw new Error('尚未登入');

    if (!payload.requiredApproverId) {
        throw new Error('缺少被調課教師 ID');
    }
    if (!roleSvc.canInitiateFor(payload.initiatedBy || id.teacherId)) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.PENDING_REQUEST, null, {
            reason: 'create_request_not_self',
            attempted: payload.initiatedBy,
        });
        throw new Error('無權代替此教師發起');
    }

    const req = {
        ...payload,
        status:       REQUEST_STATUS.PENDING,
        initiatedBy:  payload.initiatedBy || id.teacherId,
        initiatedByName: payload.initiatedByName || id.name,
        createdAt:    new Date().toISOString(),
    };

    const saved = await dataSvc.createPendingRequest(req);

    await logger.log(
        LOG_ACTIONS.CREATE_REQUEST,
        LOG_TARGET_TYPES.PENDING_REQUEST,
        saved.reqId,
        {
            initiatedBy:         saved.initiatedBy,
            requiredApproverId:  saved.requiredApproverId,
            affectedTeacherIds:  buildAffectedList(saved),
            summary: {
                type: saved.type,
                date: saved.date,
                period: saved.period,
                className: saved.className,
            },
        }
    );
    return saved;
}

/** 被邀請教師同意：把 pending 轉成正式 record。 */
export async function approveRequest(reqId) {
    const req = await dataSvc.getPendingRequest(reqId);
    if (!req) throw new Error('找不到此請求');
    if (!roleSvc.canApprove(req.requiredApproverId)) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.PENDING_REQUEST, reqId, {
            reason: 'approve_not_required_approver',
        });
        throw new Error('您不是被調課教師，無法同意此請求');
    }

    const now = new Date().toISOString();
    const record = {
        ...req,
        status:     REQUEST_STATUS.APPROVED,
        approvedAt: now,
        approvedBy: roleSvc.getCurrentIdentity()?.teacherId,
    };
    delete record.reqId;

    const saved = await dataSvc.createSubstituteRecord(record);
    await dataSvc.deletePendingRequest(reqId);

    await logger.log(
        LOG_ACTIONS.APPROVE,
        LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
        saved.recordId,
        {
            fromRequestId: reqId,
            initiatedBy: req.initiatedBy,
            requiredApproverId: req.requiredApproverId,
            affectedTeacherIds: buildAffectedList(req),
        }
    );
    return saved;
}

/**
 * 被邀請教師拒絕：soft-reject（標記 status=rejected，保留文件讓發起人看到）。
 * 發起人確認後由 dismissRejectedRequest() 真正刪除。
 */
export async function rejectRequest(reqId, note = '') {
    const req = await dataSvc.getPendingRequest(reqId);
    if (!req) throw new Error('找不到此請求');
    if (!roleSvc.canApprove(req.requiredApproverId)) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.PENDING_REQUEST, reqId, {
            reason: 'reject_not_required_approver',
        });
        throw new Error('您不是被調課教師，無法拒絕此請求');
    }
    const me  = roleSvc.getCurrentIdentity();
    const now = new Date().toISOString();
    await dataSvc.updatePendingRequest(reqId, {
        status:       REQUEST_STATUS.REJECTED,
        rejectedAt:   now,
        rejectedBy:   me?.teacherId,
        rejectedByName: me?.name,
        rejectNote:   note || '',
    });
    await logger.log(
        LOG_ACTIONS.REJECT,
        LOG_TARGET_TYPES.PENDING_REQUEST,
        reqId,
        {
            initiatedBy: req.initiatedBy,
            requiredApproverId: req.requiredApproverId,
            affectedTeacherIds: buildAffectedList(req),
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
    if (!roleSvc.canCancelRequest(req)) {
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
            initiatedBy: req.initiatedBy,
            requiredApproverId: req.requiredApproverId,
            affectedTeacherIds: buildAffectedList(req),
            note,
        }
    );
}

/** 組長代發起：直接成立 substituteRecord，不經 pending。 */
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
