/**
 * 情境 2：調課／代課全流程與權限邊界
 *
 * 全部打真實的 firestore.rules（在 emulator 上），不是模擬。每個 allow 案例都必須真的成功、
 * 每個 deny 案例都必須以 403 被規則擋下——被其他原因（400/404）擋下不算通過，因為那代表
 * 擋住它的不是權限規則。
 */

import { createDoc, updateDoc, getDoc, deleteDoc } from '../emulator/emu-client.mjs';
import { Suite, allowed, denied, eq, ok } from './harness.mjs';

export async function run(ctx) {
    const suite = new Suite('情境 2：調課／代課全流程與權限邊界');

    const { fixture, accounts } = ctx.alpha;
    const schoolId   = fixture.schoolId;
    const semesterId = fixture.config.currentSemester;
    const prevSem    = fixture.preset.previousSemester;

    const dir   = ctx.alpha.director;
    const chief = ctx.alpha.sectionChief;
    const [t1, t2, t3] = ctx.alpha.teachers;

    const P = {
        records:  `schools/${schoolId}/substituteRecords`,
        pending:  `schools/${schoolId}/pendingRequests`,
        teachers: `schools/${schoolId}/teachers`,
        logs:     `schools/${schoolId}/operationLogs`,
    };

    /* ============ 讀取邊界 ============ */

    await suite.case('校內教師可讀全校調代課紀錄', async () => {
        const rec = fixture.substituteRecords[0];
        allowed(await getDoc(`${P.records}/${rec.recordId}`, { idToken: t1.idToken }), '校內教師讀紀錄');
    });

    await suite.case('外部人士（無任何學校成員資格）讀紀錄被拒', async () => {
        const rec = fixture.substituteRecords[0];
        denied(await getDoc(`${P.records}/${rec.recordId}`, { idToken: ctx.outsider.idToken }), '外部人士讀紀錄');
    });

    await suite.case('他校主任讀本校教師名冊被拒', async () => {
        const t = fixture.teachers[0];
        denied(await getDoc(`${P.teachers}/${t.teacherId}`, { idToken: ctx.beta.director.idToken }), '乙校主任讀甲校教師檔');
    });

    /* ============ 私有明細（假別／事由）ACL ============ */

    const recWithDetail = fixture.substituteRecords.find(
        r => r.private && accounts.has(r.public.originalTeacherId)
    );
    const detailPath = `${P.records}/${recWithDetail.recordId}/private/detail`;

    await suite.case('當事人可讀自己的假別／事由', async () => {
        const owner = accounts.get(recWithDetail.public.originalTeacherId);
        const res   = await getDoc(detailPath, { idToken: owner.idToken });
        allowed(res, '當事人讀私有明細');
        eq(res.data.leaveType, recWithDetail.private.leaveType, '讀到的假別應與種子一致');
    });

    await suite.case('組長可讀任何人的假別／事由', async () => {
        allowed(await getDoc(detailPath, { idToken: chief.idToken }), '組長讀私有明細');
    });

    await suite.case('無關教師讀他人假別／事由被拒', async () => {
        const outsiderTeacher = ctx.alpha.teachers.find(
            a => !recWithDetail.private.allowedTeacherIds.includes(a.teacherId)
        );
        ok(outsiderTeacher, '應找得到一位不在 ACL 內的教師');
        denied(await getDoc(detailPath, { idToken: outsiderTeacher.idToken }), '無關教師讀私有明細');
    });

    /* ============ 建立申請 ============ */

    const baseReq = (over = {}) => ({
        type: '代課',
        date: '2026-09-25',
        weekday: '週五',
        period: '第一節',
        className: '7年1班',
        subject: '數學',
        requestType: 'substitute',
        status: 'pending_approval',
        pendingConsentTeacherIds: [],
        swapConsents: {},
        initiatedBy: t1.teacherId,
        initiatedByName: t1.name,
        originalTeacherId: t1.teacherId,
        originalTeacher: t1.name,
        requiredApproverId: chief.teacherId,
        semesterId,
        createdAt: '2026-09-20T00:00:00.000Z',
        ...over,
    });

    await suite.case('教師可為自己發起代課申請', async () => {
        allowed(
            await createDoc(P.pending, 'zz_case_sub_ok', baseReq(), { idToken: t1.idToken }),
            '教師自行發起代課'
        );
    });

    await suite.case('申請自帶 approvedBy 被拒（偽造已核准）', async () => {
        denied(
            await createDoc(P.pending, 'zz_case_selfapprove', baseReq({
                approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: '2026-09-20T01:00:00.000Z',
            }), { idToken: t1.idToken }),
            '自帶核准欄位的申請'
        );
    });

    await suite.case('調課申請的同意名單為空被拒（跳過對方同意）', async () => {
        denied(
            await createDoc(P.pending, 'zz_case_swap_empty', baseReq({
                requestType: 'swap', status: 'pending_swap_consent', pendingConsentTeacherIds: [],
            }), { idToken: t1.idToken }),
            '空同意名單的調課申請'
        );
    });

    await suite.case('調課申請把自己列為唯一同意人被拒（自我同意）', async () => {
        denied(
            await createDoc(P.pending, 'zz_case_swap_self', baseReq({
                requestType: 'swap', status: 'pending_swap_consent',
                pendingConsentTeacherIds: [t1.teacherId],
            }), { idToken: t1.idToken }),
            '自列為同意人的調課申請'
        );
    });

    await suite.case('教師代他人發起申請被拒', async () => {
        denied(
            await createDoc(P.pending, 'zz_case_impersonate', baseReq({
                initiatedBy: t2.teacherId, initiatedByName: t2.name,
            }), { idToken: t1.idToken }),
            '冒名他人發起'
        );
    });

    await suite.case('對歷史學期發起申請被拒（學期唯讀鎖）', async () => {
        denied(
            await createDoc(P.pending, 'zz_case_old_semester', baseReq({ semesterId: prevSem }), { idToken: t1.idToken }),
            '歷史學期的新申請'
        );
    });

    /* ============ 同意與核准 ============ */

    await suite.case('被邀請的教師可同意調課（移出同意名單並轉待核准）', async () => {
        allowed(await createDoc(P.pending, 'zz_case_consent', baseReq({
            type: '調課', requestType: 'swap', status: 'pending_swap_consent',
            pendingConsentTeacherIds: [t2.teacherId],
            swapTeacherId: t2.teacherId, swapTeacher: t2.name,
        }), { idToken: t1.idToken }), '前置：建立待同意的調課申請');

        allowed(await updateDoc(`${P.pending}/zz_case_consent`, {
            status: 'pending_approval',
            pendingConsentTeacherIds: [],
            swapConsents: { [t2.teacherId]: '2026-09-20T02:00:00.000Z' },
            statusUpdatedAt: '2026-09-20T02:00:00.000Z',
        }, { idToken: t2.idToken }), '被邀請人同意');
    });

    await suite.case('不在同意名單內的教師嘗試同意被拒', async () => {
        // 前置寫入必須斷言成功：對「不存在的文件」送 update 同樣會回 403，
        // 前置若靜默失敗，下面的 denied() 會因為錯誤的理由通過（假綠燈）。
        allowed(await createDoc(P.pending, 'zz_case_consent2', baseReq({
            type: '調課', requestType: 'swap', status: 'pending_swap_consent',
            pendingConsentTeacherIds: [t2.teacherId],
        }), { idToken: t1.idToken }), '前置：建立待同意的調課申請');

        denied(await updateDoc(`${P.pending}/zz_case_consent2`, {
            status: 'pending_approval',
            pendingConsentTeacherIds: [],
        }, { idToken: t3.idToken }), '第三者代為同意');
    });

    await suite.case('組長可核准待核准的申請', async () => {
        allowed(await updateDoc(`${P.pending}/zz_case_sub_ok`, {
            status: 'approved',
            approvedBy: chief.teacherId,
            approvedByName: chief.name,
            approvedAt: '2026-09-21T00:00:00.000Z',
            statusUpdatedAt: '2026-09-21T00:00:00.000Z',
        }, { idToken: chief.idToken }), '組長核准');
    });

    await suite.case('一般教師核准他人申請被拒', async () => {
        // 同上，且這份文件還被下一個案例（組長竄改內容）沿用，前置失敗會讓兩個案例都空洞地通過
        allowed(await createDoc(P.pending, 'zz_case_approve_by_teacher', baseReq(), { idToken: t1.idToken }),
            '前置：建立待核准的代課申請');
        denied(await updateDoc(`${P.pending}/zz_case_approve_by_teacher`, {
            status: 'approved',
            approvedBy: t3.teacherId,
            approvedByName: t3.name,
            approvedAt: '2026-09-21T00:00:00.000Z',
        }, { idToken: t3.idToken }), '一般教師核准');
    });

    await suite.case('組長竄改申請內容（日期）被拒', async () => {
        // 自己建立自己的前置文件，不依賴上一個案例的殘留——上一個案例若失敗，
        // 這裡對不存在的文件送 update 也會拿到 403，變成空洞地通過。
        allowed(await createDoc(P.pending, 'zz_case_tamper', baseReq(), { idToken: t1.idToken }),
            '前置：建立待核准的代課申請');
        denied(await updateDoc(`${P.pending}/zz_case_tamper`, {
            date: '2026-09-30',
        }, { idToken: chief.idToken }), '核准者改動申請內容');
    });

    await suite.case('已核准的申請不可再被改成駁回（終態鎖）', async () => {
        denied(await updateDoc(`${P.pending}/zz_case_sub_ok`, {
            status: 'rejected',
            rejectedBy: dir.teacherId,
            statusUpdatedAt: '2026-09-22T00:00:00.000Z',
        }, { idToken: dir.idToken }), '改寫已核准的終態');
    });

    /* ============ 已成立紀錄 ============ */

    const baseRecord = (over = {}) => ({
        id: 'zz_case_record',
        type: '代課',
        date: '2026-09-25',
        weekday: '週五',
        period: '第二節',
        className: '7年2班',
        subject: '國語文',
        originalTeacher: t1.name,
        originalTeacherId: t1.teacherId,
        substituteTeacher: t2.name,
        substituteTeacherId: t2.teacherId,
        semesterId,
        createdAt: '2026-09-25T00:00:00.000Z',
        isSelfSwap: false,
        ...over,
    });

    await suite.case('組長可建立已成立的代課紀錄', async () => {
        allowed(await createDoc(P.records, 'zz_rec_by_chief', baseRecord({
            approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: '2026-09-25T01:00:00.000Z',
        }), { idToken: chief.idToken }), '組長建立紀錄');
    });

    await suite.case('一般教師自建代課紀錄被拒（灌代課鐘點）', async () => {
        denied(await createDoc(P.records, 'zz_rec_fake_sub', baseRecord({
            originalTeacher: t2.name, originalTeacherId: t2.teacherId,
            substituteTeacher: t3.name, substituteTeacherId: t3.teacherId,
        }), { idToken: t3.idToken }), '教師自建代課紀錄');
    });

    await suite.case('教師可建立自我調課紀錄', async () => {
        allowed(await createDoc(P.records, 'zz_rec_self_swap', baseRecord({
            type: '調課',
            isSelfSwap: true,
            originalTeacherId: t1.teacherId,
            swapTeacherId: t1.teacherId,
            substituteTeacherId: t1.teacherId,
            originalTeacher: t1.name,
            substituteTeacher: t1.name,
        }), { idToken: t1.idToken }), '教師自我調課');
    });

    await suite.case('假冒的自我調課（代課教師指向他人）被拒', async () => {
        denied(await createDoc(P.records, 'zz_rec_fake_self_swap', baseRecord({
            type: '調課',
            isSelfSwap: true,
            originalTeacherId: t1.teacherId,
            swapTeacherId: t1.teacherId,
            substituteTeacherId: t2.teacherId,   // ← 三個 id 沒有全部指向自己
        }), { idToken: t1.idToken }), '假自我調課');
    });

    await suite.case('對歷史學期建立紀錄被拒（學期唯讀鎖）', async () => {
        denied(await createDoc(P.records, 'zz_rec_old_semester', baseRecord({
            semesterId: prevSem,
        }), { idToken: chief.idToken }), '歷史學期新增紀錄');
    });

    await suite.case('歷史學期的既有紀錄不可再編輯（整份唯讀）', async () => {
        const oldRec = fixture.previousSemesterRecords[0];
        denied(await updateDoc(`${P.records}/${oldRec.recordId}`, {
            className: '9年9班',
        }, { idToken: chief.idToken }), '編輯歷史學期紀錄');
    });

    await suite.case('一般教師刪除紀錄被拒，主任可刪', async () => {
        denied(await deleteDoc(`${P.records}/zz_rec_by_chief`, { idToken: t1.idToken }), '教師刪紀錄');
        allowed(await deleteDoc(`${P.records}/zz_rec_by_chief`, { idToken: dir.idToken }), '主任刪紀錄');
    });

    /* ============ 稽核軌跡 ============ */

    const logId = fixture.operationLogs[0].logId;

    await suite.case('組長可讀操作日誌，一般教師不可讀', async () => {
        allowed(await getDoc(`${P.logs}/${logId}`, { idToken: chief.idToken }), '組長讀日誌');
        denied(await getDoc(`${P.logs}/${logId}`, { idToken: t1.idToken }), '一般教師讀日誌');
    });

    await suite.case('校內成員可寫入日誌，但欄位需符合白名單', async () => {
        allowed(await createDoc(P.logs, 'zz_log_ok', {
            action: 'create_request',
            actor: { teacherId: t1.teacherId, name: t1.name },
            timestamp: '2026-09-25T02:00:00.000Z',
            targetType: 'pendingRequest',
            targetId: 'zz_case_sub_ok',
            details: {},
            semesterId,
        }, { idToken: t1.idToken }), '合法日誌寫入');

        denied(await createDoc(P.logs, 'zz_log_bad', {
            action: 'create_request',
            actor: { teacherId: t1.teacherId, name: t1.name },
            timestamp: '2026-09-25T02:00:00.000Z',
            targetType: 'pendingRequest',
            targetId: 'x',
            details: {},
            semesterId,
            injectedField: '不在白名單內',
        }, { idToken: t1.idToken }), '夾帶白名單外欄位的日誌');
    });

    await suite.case('日誌不可修改、不可刪除（連主任也不行）', async () => {
        denied(await updateDoc(`${P.logs}/${logId}`, { action: 'tampered' }, { idToken: dir.idToken }), '主任改日誌');
        denied(await deleteDoc(`${P.logs}/${logId}`, { idToken: dir.idToken }), '主任刪日誌');
    });

    return suite;
}
