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
import * as semesterState  from './semesterState.js';
import { getV2Firestore }  from './firebaseV2.js';
import { verifyNoAssignmentConflict, buildApprovalConflictMessage, buildAdminCreateConflictMessage } from './assignmentConflict.js';
import { runWithRecordsGuard, assertSeqUnchanged } from './recordsGuard.js';
import { checkBatchApprovable, checkBatchWithdrawable } from './batchDependency.js';
import { filterSameBatch } from './batchGuard.js';
import { checkApprovalSeparation } from './approvalPolicy.js';
import {
    LOG_ACTIONS,
    LOG_TARGET_TYPES,
    REQUEST_STATUS,
    REQUEST_TYPES,
    SCHEMA_PATHS,
} from './schemaConstants.js';

/**
 * P9（LF-L2）：撤回／關閉駁回／刪紀錄時，private/detail（假別、事由）與父文件在「同一個原子寫入」內一起刪，
 * 避免父文件消失後留下無人可管的孤兒明細，也避免「明細先被刪、組長隨後核准」讀到 null 造成假別遺失。
 * 舊 rules（尚未開放刪明細）會回 permission-denied：退回只刪父文件，並記錄 detail_delete_failed——
 * 只有「父文件刪除成功、明細沒刪成」才記這筆，原本的撤回或刪除不會因此被擋下。
 * @param {'pendingRequest'|'substituteRecord'} kind
 */
async function logDetailDeleteFailed(kind, id, reason, e) {
    console.warn('[V2] 刪除私有明細失敗（父文件已刪除，可能留下孤兒明細）：', kind, id, e);
    try {
        await logger.log(LOG_ACTIONS.DETAIL_DELETE_FAILED, kind, id, {
            reason, error: String((e && (e.code || e.message)) || e).slice(0, 200),
        });
    } catch (_) { /* 日誌也寫不進去就只留 console */ }
}

function isPermissionDenied(e) {
    return !!e && (e.code === 'permission-denied' || e.code === 'PERMISSION_DENIED');
}

async function deleteParentWithDetail(kind, parentRef, detailRef, id, reason) {
    const fs = await getV2Firestore();
    let denied = null;
    try {
        const batch = fs.writeBatch(fs.db);
        batch.delete(detailRef);
        batch.delete(parentRef);
        await batch.commit();
        return;
    } catch (e) {
        if (!isPermissionDenied(e)) throw e;
        denied = e;
    }
    await fs.deleteDoc(parentRef);
    await logDetailDeleteFailed(kind, id, reason, denied);
}

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

/**
 * 核准／直接成立前重新驗證發現雙重指派時丟出的錯誤。UI 依 err.code === 'ASSIGNMENT_CONFLICT' 辨識。
 */
export class AssignmentConflictError extends Error {
    constructor(message, hit = null) {
        super(message);
        this.name = 'AssignmentConflictError';
        this.code = 'ASSIGNMENT_CONFLICT';
        this.hit = hit;
    }
}

/**
 * 核准前（交易之外）以「當下」的已成立紀錄重新檢查衝堂；有衝突就寫操作日誌並丟
 * AssignmentConflictError，查詢失敗丟 APPROVAL_VERIFY_FAILED（fail-closed，不核准）。
 *
 * 為什麼放在交易「之前」且非交易性：日期範圍查詢無法放進 Firestore 交易，交易內的 rules 文件存取
 * 也有共用配額（見 approveRequest 內註解）。「驗證通過 → 交易提交」之間的競態窗口由序號鎖補上
 * （P6，recordsGuard.js）：呼叫端在驗證前先讀 config/recordsLock 的 seq，交易內再確認 seq 沒變才寫入，
 * 期間若有別筆紀錄成立就會重新驗證，因此連點或兩位組長同時核准只會成立一筆。
 */
async function assertNoAssignmentConflict(req, { logTargetType, logTargetId, logContext, forAdminCreate = false }) {
    // 含 swapDate 索引的查詢：遠距調課（date 與 swapDate 相差 >31 天）的「移入」也要抓到；每次都讀當下資料，不吃快取
    // 週課表只在「可能是協同教學」時才讀（命中且申請方既非換走也非換進的教師），一般核准不增加讀取
    const loadSchedule = async () => (await dataSvc.getSchedule(req.semesterId || semesterState.getCurrentSemesterId()))?.scheduleData || [];
    const hit = await verifyNoAssignmentConflict(req, (range) => dataSvc.queryRecordsOccupyingRange(range), loadSchedule);
    if (!hit) return;
    const message = forAdminCreate ? buildAdminCreateConflictMessage(hit, req) : buildApprovalConflictMessage(hit);
    try {
        await logger.log(LOG_ACTIONS.APPROVE_BLOCKED_CONFLICT, logTargetType, logTargetId, {
            reason:             hit.scheduleUnavailable ? 'schedule_unavailable' : 'assignment_conflict',
            context:            logContext,
            conflictTeacher:    hit.teacher,
            conflictDate:       hit.date,
            conflictPeriod:     hit.period,
            conflictRole:       hit.role,
            conflictRecordId:   hit.detail?.recordId || hit.detail?.id || null,
            affectedTeacherIds: buildAffectedList(req),
        });
    } catch (e) {
        // 日誌失敗不可蓋掉真正的衝突訊息
        console.warn('[V2] 寫入衝堂攔截日誌失敗：', e);
    }
    throw new AssignmentConflictError(message, hit);
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
 * 批次依賴（P6，審計 L5）：核准多重調課批次中的一筆之前，同批其他筆必須仍在途或已核准，且筆數完整。
 * 讀取失敗一律中止（fail-closed）。非批次申請直接放行。
 */
async function assertBatchApprovable(req, reqId) {
    if (!req || !req.batchId) return;
    let requests, records;
    try {
        [requests, records] = await Promise.all([
            dataSvc.listPendingRequestsByBatch(req.batchId),
            dataSvc.listSubstituteRecordsByBatch(req.batchId),
        ]);
    } catch (cause) {
        const err = new Error('核准前無法確認同批調課的狀態（讀取失敗），已中止，請稍後再試');
        err.code = 'APPROVAL_VERIFY_FAILED';
        err.cause = cause;
        throw err;
    }
    const res = checkBatchApprovable({ ...req, reqId: req.reqId || reqId }, requests, records);
    if (res.ok) return;
    try {
        await logger.log(LOG_ACTIONS.APPROVE_BLOCKED_CONFLICT, LOG_TARGET_TYPES.PENDING_REQUEST, reqId, {
            reason: 'batch_dependency', context: 'approve_request', batchCode: res.code,
            affectedTeacherIds: buildAffectedList(req),
        });
    } catch (e) { console.warn('[V2] 寫入批次依賴攔截日誌失敗：', e); }
    const err = new AssignmentConflictError(res.message, null);
    err.code = 'ASSIGNMENT_CONFLICT';
    throw err;
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

    // 私有子文件（假別／事由）自帶 ACL：發起人＋對調對象＋全部同意人，去重去 null。
    // pendingConsentTeacherIds 此時已是完整初始名單（swap 為對方一人、multi_swap 為全員），
    // 涵蓋日後逐一同意時會被移出陣列的所有人，建立當下一次算好即可，不需隨同意進度更新。
    const allowedTeacherIds = buildAffectedList(req);
    const { publicPart, privatePart, hasSensitive } = dataSvc.splitSensitive(req, allowedTeacherIds);

    const fs    = await getV2Firestore();
    const reqId = dataSvc.genId('req');

    // 先寫 private 再寫父文件：private 寫入失敗就中止，不留下「父文件存在但假別／事由
    // 遺失」的狀態（假別遺失會讓月結算把不扣減的假別誤算為扣減）。沒有敏感欄位（例如
    // 此類申請本就不帶 leaveType/reason）時略過，不建立空文件。
    if (hasSensitive) {
        await fs.setDoc(fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(reqId)), privatePart);
    }
    // hasDetail：父文件標記「這筆申請有私有明細」，核准時若標記為真卻讀到 null，代表明細遺失，須中止（見 approveRequest）。
    const saved = await dataSvc.createPendingRequest(hasSensitive ? { ...publicPart, hasDetail: true } : publicPart, reqId);

    await logger.log(
        LOG_ACTIONS.CREATE_REQUEST,
        LOG_TARGET_TYPES.PENDING_REQUEST,
        saved.reqId,
        {
            initiatedBy:              saved.initiatedBy,
            requiredApproverId:       saved.requiredApproverId,
            requestType:              saved.requestType,
            pendingConsentTeacherIds: saved.pendingConsentTeacherIds,
            affectedTeacherIds:       allowedTeacherIds,
            summary: {
                type: saved.type, date: saved.date, period: saved.period, className: saved.className,
            },
        }
    );
    return { ...saved, ...privatePart };
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
        const normalized = normalizeLegacyRequest({ ...snap.data(), reqId });

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

    // 雙重指派防線（P0-1）＋序號鎖（P6）：申請擱置期間，代課／調課教師或班級時段可能已被另一筆紀錄佔走。
    // 核准前以「當下」的已成立紀錄重驗；重驗是範圍查詢、放不進交易，所以交易內另讀 config/recordsLock 的 seq，
    // 與重驗前讀到的 seq 不同代表重驗之後又有別筆紀錄成立，會丟 RECORDS_STALE 回到重驗（見 recordsGuard.js）。
    // 先非交易性讀一次請求內容（只為取得 type／日期／教師，供衝堂重驗）。預讀不到或狀態已不是在途時
    // 直接中止：不可在沒有重驗的情況下進交易成立紀錄（交易內的狀態檢查只擋狀態，不做衝堂重驗）。
    const preReq = await dataSvc.getPendingRequest(reqId);
    if (!preReq) {
        const nf = new Error('找不到此請求，可能已被撤回或處理，請重新整理列表');
        nf.code = 'REQUEST_NOT_FOUND';
        throw nf;
    }
    const normalizedPre = normalizeLegacyRequest(preReq);
    if (normalizedPre.status !== REQUEST_STATUS.PENDING_APPROVAL) {
        throw new RequestAlreadyProcessedError('此請求已被處理（可能已被其他核准人核准或駁回）');
    }
    // 職務分離（SB-I7）：不可核准自己發起的申請（自我調課且無他人牽涉例外）；與 firestore.rules v2.17 對齊，
    // 這裡先擋下，給明確訊息，不等 rules 回 permission-denied。
    const separation = checkApprovalSeparation(normalizedPre, me);
    if (!separation.ok) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.PENDING_REQUEST, reqId, {
            reason: 'approve_own_request',
        });
        const e = new Error(separation.reason);
        e.code = 'APPROVE_OWN_REQUEST';
        throw e;
    }

    // Firestore 對單一 transaction 的 rules document access 有共用配額限制（約 20 次，
    // 完整推導見 legacyMigrationService.js 檔頭註解）。交易內部 tx.get(reqRef)／tx.set(recordRef,...)
    // 已各自觸發 isApprover(schoolId) 判斷鏈，若再把「新紀錄 private/detail」的 create 規則
    // 判斷也塞進同一個交易，會逼近甚至超過共用配額。因此改為：交易「之前」非交易性地把
    // recordId 定下來、讀出 request 的 private/detail 內容並先寫好新紀錄的 private/detail；
    // 交易本身只讀寫三個父文件（request、新 record、序號鎖）。
    const recordId  = dataSvc.genId('rec');
    let reqSnapshot = null;
    let detailWritten = false;
    const lockRef = fs.doc(fs.db, SCHEMA_PATHS.recordsLock());

    try {
        await runWithRecordsGuard({
            readSeq: () => dataSvc.getRecordsLockSeq(),
            verify: async () => {
                await assertNoAssignmentConflict(normalizedPre, {
                    logTargetType: LOG_TARGET_TYPES.PENDING_REQUEST,
                    logTargetId:   reqId,
                    logContext:    'approve_request',
                });
                await assertBatchApprovable(normalizedPre, reqId);
            },
            commit: async (seq) => {
                if (!detailWritten) {
                    // P7：讀不到私有明細時中止核准（不可當成「沒有明細」，否則假別遺失、公假被誤扣時數）
                    let reqDetail;
                    try {
                        reqDetail = await dataSvc.getRequestDetailStrict(reqId);
                    } catch (readErr) {
                        const e = new Error('讀不到這筆申請的假別明細，為避免假別遺失造成月結算誤扣時數，已中止核准。請檢查網路後重試');
                        e.code = 'DETAIL_READ_FAILED';
                        e.cause = readErr;
                        throw e;
                    }
                    if (!reqDetail && preReq.hasDetail === true) {
                        // 縱深防護：申請建立時標記過有明細，現在卻讀不到（被撤回流程誤刪、孤立、人為刪除）。
                        // 不可成立一筆沒有假別的紀錄（公假、喪假會被月結算誤扣時數）。舊申請沒有標記，無從判斷，維持原行為。
                        const e = new Error('這筆申請的假別明細已遺失，為避免月結算誤扣時數，已中止核准。請通知申請人重新送出申請');
                        e.code = 'DETAIL_MISSING';
                        throw e;
                    }
                    if (reqDetail) {
                        // 複製請求的私有明細到新紀錄底下（同一批當事人，approver 本來就不受 ACL 限制，
                        // 不需要因為核准動作而擴增名單）。
                        const { allowedTeacherIds, ...sensitiveFields } = reqDetail;
                        await fs.setDoc(fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId)), {
                            ...sensitiveFields,
                            allowedTeacherIds: Array.isArray(allowedTeacherIds) ? allowedTeacherIds : [],
                        });
                    }
                    detailWritten = true;
                }
                await fs.runTransaction(fs.db, async (tx) => {
                    const snap = await tx.get(reqRef);
                    if (!snap.exists()) throw new Error('找不到此請求');
                    const data = normalizeLegacyRequest({ ...snap.data(), reqId });

                    if (data.status !== REQUEST_STATUS.PENDING_APPROVAL) {
                        throw new RequestAlreadyProcessedError('此請求已被處理（可能已被其他核准人核准或駁回）');
                    }
                    const nextSeq = assertSeqUnchanged(await tx.get(lockRef), seq);

                    const now       = new Date().toISOString();
                    const recordRef = fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId));

                    const record = { ...data };
                    // 識別欄位一律以文件 ID 為準：申請內容是使用者可寫入的資料，可能夾帶 reqId／recordId
                    // 偽造欄位。reqId 為申請的文件 ID（紀錄改以 fromRequestId 記錄來源），recordId 是即將
                    // 建立的新紀錄 ID（只存在於文件路徑，不落在資料欄位）。
                    // 注意：不剔除 id——id 是 V1 紀錄 ID（`${baseId}_${index}`），多重調課同批排序
                    // （v2-app.js order()、app.js reprintSwapBatchRecord）與衝堂比對刻意依賴它。
                    delete record.reqId;
                    delete record.recordId;
                    delete record.pendingConsentTeacherIds;
                    delete record.swapConsents;
                    delete record.__legacyPending;
                    delete record.hasDetail;
                    // 敏感欄位一律不落父文件（已於上方複製到新紀錄的 private/detail）；新流程的
                    // request 父文件本就不含這三欄位，這裡刪除純屬防禦性寫法。
                    for (const field of dataSvc.SENSITIVE_RECORD_FIELDS) delete record[field];
                    record.status          = REQUEST_STATUS.APPROVED;
                    record.approvedAt      = now;
                    record.approvedBy      = me.teacherId;
                    record.approvedByName  = me.name;
                    record.fromRequestId   = reqId;
                    record.createdAt       = record.createdAt || now;
                    record.affectedTeacherIds = buildAffectedList(data);
                    // Stage 2（§6.1）：this bypasses dataSvc.createSubstituteRecord()（直接 tx.set），
                    // 故不會經過該函式的「semesterId 未帶時自動蓋目前學期」邏輯——必須在這裡手動蓋。
                    // 刻意用「核准當下」的目前學期，不沿用申請（data）建立當時的 semesterId：若申請
                    // 在途期間跨過學期切換，申請當時的學期可能已不是 currentSemester，沿用舊值會被
                    // substituteRecords 的建立規則（semesterId == config.currentSemester）擋下。
                    // 已知限制：這代表「核准時間」而非「申請時間」決定紀錄歸屬的學期，多數情況下兩者
                    // 相同（申請與核准通常在同一學期內完成），只有「申請在途、期間學期切換」這種邊界
                    // 情境才會有差異。
                    record.semesterId = semesterState.getCurrentSemesterId();

                    tx.set(recordRef, record);
                    tx.set(lockRef, { seq: nextSeq, updatedAt: now });
                    tx.update(reqRef, {
                        status:          REQUEST_STATUS.APPROVED,
                        approvedAt:      now,
                        approvedBy:      me.teacherId,
                        approvedByName:  me.name,
                        statusUpdatedAt: now,
                    });

                    reqSnapshot = record;
                });
            },
        });
    } catch (err) {
        // 沒有成立紀錄時，先寫好的私有明細是孤兒；盡力清掉（失敗不影響原本的錯誤）
        if (detailWritten && !reqSnapshot) {
            try { await dataSvc.deleteSubstituteRecordDetail(recordId); } catch (_) { /* 孤兒明細無害，忽略 */ }
        }
        throw err;
    }

    await logger.log(
        LOG_ACTIONS.APPROVE,
        LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
        recordId,
        {
            fromRequestId:      reqId,
            initiatedBy:        reqSnapshot.initiatedBy,
            requestType:        reqSnapshot.requestType,
            affectedTeacherIds: buildAffectedList(reqSnapshot),
        }
    );

    return { ...reqSnapshot, recordId };
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
export async function rejectRequest(reqId, note = '', { cascade = true } = {}) {
    const me = roleSvc.getCurrentIdentity();
    if (!me) throw new Error('尚未登入');

    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));

    const normalized = await fs.runTransaction(fs.db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('找不到此請求');
        const data = normalizeLegacyRequest({ ...snap.data(), reqId });

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

    // 多重調課批次以批次為單位駁回（P6，審計 L5）：組長／主任駁回其中一筆時，同批其餘在途申請一併駁回，
    // 不留下半套調課。同意人只能駁回自己那一筆（rules），其餘由核准端的批次依賴檢查擋下單獨核准。
    const cascaded = [];
    if (cascade && normalized.batchId && roleSvc.isApprover()) {
        try {
            const open = filterSameBatch({ ...normalized, reqId }, await dataSvc.listOpenPendingRequestsByBatch(normalized.batchId));
            for (const sib of open) {
                if (!sib.reqId || sib.reqId === reqId) continue;
                try {
                    await rejectRequest(sib.reqId, note ? `${note}（同批調課一併駁回）` : '同批調課一併駁回', { cascade: false });
                    cascaded.push(sib.reqId);
                } catch (e) { console.warn('[V2] 同批申請駁回失敗：', sib.reqId, e); }
            }
        } catch (e) { console.warn('[V2] 讀取同批申請失敗，未連帶駁回：', e); }
    }
    return { cascaded };
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
    const fs = await getV2Firestore();
    await deleteParentWithDetail(LOG_TARGET_TYPES.PENDING_REQUEST,
        fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId)), fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(reqId)), reqId, 'dismiss_rejected');
}

/**
 * 發起人撤回：刪除 pending。
 * P6（審計 Medium「撤回不檢查狀態」）：交易內確認申請仍在途才刪；已核准成立的申請不可撤回
 * （舊流程只憑畫面上的按鈕，核准與撤回同時發生時會刪掉剛被核准的申請，留下沒有來源的紀錄）。
 * 多重調課批次以批次為單位撤回：同批已有核准成立者不可單獨撤回；其餘在途的同批申請一併撤回。
 */
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

    // 批次：先看同批狀態，再一併撤回其餘在途的申請
    let siblings = [];
    if (normalized.batchId) {
        const [requests, records] = await Promise.all([
            dataSvc.listPendingRequestsByBatch(normalized.batchId),
            dataSvc.listSubstituteRecordsByBatch(normalized.batchId),
        ]);
        const res = checkBatchWithdrawable({ ...normalized, reqId }, requests, records);
        if (!res.ok) throw new Error(res.message);
        siblings = res.openSiblings.filter(r => r.reqId && r.reqId !== reqId);
    }

    await deleteRequestIfOpen(reqId, 'cancel');
    const cascaded = [];
    for (const sib of siblings) {
        try { await deleteRequestIfOpen(sib.reqId, 'cancel_batch'); cascaded.push(sib.reqId); }
        catch (e) { console.warn('[V2] 同批申請撤回失敗：', sib.reqId, e); }
    }
    await logger.log(
        LOG_ACTIONS.CANCEL,
        LOG_TARGET_TYPES.PENDING_REQUEST,
        reqId,
        {
            initiatedBy:        normalized.initiatedBy,
            requestType:        normalized.requestType,
            affectedTeacherIds: buildAffectedList(normalized),
            note,
            ...(cascaded.length ? { batchCascade: cascaded } : {}),
        }
    );
    return { cascaded };
}

/** 交易內確認仍在途才刪除申請；已核准或已被處理丟 RequestAlreadyProcessedError。 */
async function deleteRequestIfOpen(reqId, reason = 'cancel') {
    const fs  = await getV2Firestore();
    const ref = fs.doc(fs.db, SCHEMA_PATHS.pendingDoc(reqId));
    const detailRef = fs.doc(fs.db, SCHEMA_PATHS.pendingDetailDoc(reqId));
    // 同一個交易內連明細一起刪（原子）；舊 rules 回 permission-denied 時退回只刪父文件並記錄。
    try {
        await deleteRequestTx(fs, ref, detailRef, reqId);
    } catch (e) {
        if (!isPermissionDenied(e)) throw e;
        await deleteRequestTx(fs, ref, null, reqId);
        await logDetailDeleteFailed(LOG_TARGET_TYPES.PENDING_REQUEST, reqId, reason, e);
    }
}

async function deleteRequestTx(fs, ref, detailRef, reqId) {
    await fs.runTransaction(fs.db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('找不到此請求（可能已被撤回）');
        const data = normalizeLegacyRequest({ ...snap.data(), reqId });
        if (data.status === REQUEST_STATUS.APPROVED) {
            throw new RequestAlreadyProcessedError('此申請已核准成立，無法撤回；如需更正請洽教學組');
        }
        if (data.status !== REQUEST_STATUS.PENDING_SWAP_CONSENT && data.status !== REQUEST_STATUS.PENDING_APPROVAL) {
            throw new RequestAlreadyProcessedError('此申請已被處理，無法撤回，請重新整理列表');
        }
        tx.delete(ref);
        if (detailRef) tx.delete(detailRef);
    });
}

/**
 * 組長/主任代發起：直接成立 substituteRecord，不經 pending。
 * P6：衝堂重驗與寫入以序號鎖串起來（見 recordsGuard.js），連點或與核准同時發生時只會成立一筆。
 */
export async function adminCreate(payload) {
    const saved = await commitAdminRecords([payload], { batch: false });
    return saved[0];
}

/**
 * 組長/主任代發的多重調課批次：全有或全無。
 * 全部各筆先逐一重驗（含對既有紀錄的班級時段與教師衝堂），通過後在「同一個交易」寫入全部紀錄；
 * 任何一筆衝堂或寫入失敗，整批都不成立（舊流程逐筆寫入，中途失敗會留下前幾筆）。
 * @param {Array<Object>} payloads - 各筆的 payload（每筆帶同一個 batchId）
 * @returns {Promise<Array<Object>>} 成立的紀錄
 */
export async function adminCreateBatch(payloads) {
    if (!Array.isArray(payloads) || payloads.length === 0) throw new Error('沒有要成立的調課');
    return commitAdminRecords(payloads, { batch: true });
}

async function commitAdminRecords(payloads, { batch }) {
    if (!roleSvc.isAdmin()) {
        await logger.log(LOG_ACTIONS.PERMISSION_DENIED, LOG_TARGET_TYPES.SUBSTITUTE_RECORD, null, {
            reason: 'admin_create_not_admin',
        });
        throw new Error('僅組長可代發起');
    }
    const me  = roleSvc.getCurrentIdentity();
    const fs  = await getV2Firestore();
    const now = new Date().toISOString();
    const lockRef = fs.doc(fs.db, SCHEMA_PATHS.recordsLock());

    // 組出各筆要寫入的內容（recordId 與私有明細在此定下，重試時沿用同一份）
    const writes = payloads.map(payload => {
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
        return { payload, ...dataSvc.buildSubstituteRecordWrite(record) };
    });

    let committed = false;
    let detailsWritten = false;
    try {
        await runWithRecordsGuard({
            readSeq: () => dataSvc.getRecordsLockSeq(),
            verify: async () => {
                // 雙重指派防線（P0-1）：直接成立也要以當下紀錄重驗，衝突則不寫入。
                // 批次內各筆互相的衝突不在此檢查（批次內連調會重複使用班級時段，由送出前的整批模擬負責）。
                for (const w of writes) {
                    await assertNoAssignmentConflict({ ...w.payload, adminOperatorId: me.teacherId }, {
                        logTargetType: LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
                        logTargetId:   null,
                        logContext:    batch ? 'admin_create_batch' : 'admin_create',
                        forAdminCreate: true,
                    });
                }
            },
            commit: async (seq) => {
                if (!detailsWritten) {
                    for (const w of writes) {
                        if (w.hasSensitive) {
                            await fs.setDoc(fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(w.recordId)), w.privatePart);
                        }
                    }
                    detailsWritten = true;
                }
                await fs.runTransaction(fs.db, async (tx) => {
                    const nextSeq = assertSeqUnchanged(await tx.get(lockRef), seq);
                    for (const w of writes) {
                        tx.set(fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(w.recordId)), w.publicPart);
                    }
                    tx.set(lockRef, { seq: nextSeq, updatedAt: new Date().toISOString() });
                });
                committed = true;
            },
        });
    } catch (err) {
        if (detailsWritten && !committed) {
            for (const w of writes) {
                if (w.hasSensitive) {
                    try { await dataSvc.deleteSubstituteRecordDetail(w.recordId); } catch (_) { /* 孤兒明細無害 */ }
                }
            }
        }
        throw err;
    }

    const saved = writes.map(w => ({ ...w.base, recordId: w.recordId }));
    for (const w of writes) {
        await logger.log(
            LOG_ACTIONS.ADMIN_CREATE,
            LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
            w.recordId,
            {
                onBehalfOf: w.payload.initiatedBy,
                affectedTeacherIds: buildAffectedList(w.payload),
                summary: {
                    type: w.base.type, date: w.base.date, period: w.base.period, className: w.base.className,
                },
            }
        );
    }
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
    const fs = await getV2Firestore();
    await deleteParentWithDetail(LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
        fs.doc(fs.db, SCHEMA_PATHS.substituteDoc(recordId)), fs.doc(fs.db, SCHEMA_PATHS.substituteDetailDoc(recordId)), recordId, 'admin_delete');
    await logger.log(
        LOG_ACTIONS.DELETE,
        LOG_TARGET_TYPES.SUBSTITUTE_RECORD,
        recordId,
        { before, affectedTeacherIds: buildAffectedList(before) }
    );
}
