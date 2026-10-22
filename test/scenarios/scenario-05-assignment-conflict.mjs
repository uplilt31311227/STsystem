/**
 * 情境 5：雙重指派防線（核准前重驗、在途申請納入衝堂）
 *
 * 資料全部寫進 emulator、經真實 firestore.rules；衝堂判斷則呼叫「正式程式碼」的
 * assignmentConflict.js（與 pendingRequestService.approveRequest／v2-app 衝堂攔截共用）。
 *
 * ⚠ 範圍說明：pendingRequestService.js 依賴瀏覽器端 Firebase SDK（CDN 動態載入），無法在 Node 載入，
 * 所以這裡不是呼叫 approveRequest() 本身，而是用 REST 讀取 emulator 資料來充當「注入的日期範圍查詢」，
 * 驅動 approveRequest 內實際呼叫的同一個 verifyNoAssignmentConflict()。核准交易是否真的被略過
 * 無法在 Node 驗證；這裡驗證的是「驗證函式對真實資料的判定」與「判定為衝突時沒有任何寫入」。
 */

import { createDoc, getDoc, listDocs } from '../emulator/emu-client.mjs';
import { Suite, allowed, eq, ok, includes } from './harness.mjs';
import {
    verifyNoAssignmentConflict, buildApprovalConflictMessage, pendingRequestsToOccupancyRecords,
    findAssignmentConflict, describeAssignmentConflict,
} from '../../src/js/modules/v2/assignmentConflict.js';

export async function run(ctx) {
    const suite = new Suite('情境 5：雙重指派防線（核准前重驗、在途申請納入衝堂）');

    const { fixture } = ctx.alpha;
    const schoolId   = fixture.schoolId;
    const semesterId = fixture.config.currentSemester;
    const chief = ctx.alpha.sectionChief;
    const [t1, t2, t3] = ctx.alpha.teachers;

    const P = {
        records: `schools/${schoolId}/substituteRecords`,
        pending: `schools/${schoolId}/pendingRequests`,
    };

    const baseReq = (over = {}) => ({
        type: '代課', date: '2026-10-20', weekday: '週二', period: '第三節', className: '801', subject: '數學',
        requestType: 'substitute', status: 'pending_approval',
        pendingConsentTeacherIds: [], swapConsents: {},
        initiatedBy: t1.teacherId, initiatedByName: t1.name,
        originalTeacherId: t1.teacherId, originalTeacher: t1.name,
        substituteTeacherId: t2.teacherId, substituteTeacher: t2.name,
        requiredApproverId: chief.teacherId, semesterId, createdAt: '2026-10-19T00:00:00.000Z',
        ...over,
    });
    const baseRecord = (over = {}) => ({
        id: 'zz05_rec', type: '代課', date: '2026-10-20', weekday: '週二', period: '第三節', className: '802', subject: '國語文',
        originalTeacher: t3.name, originalTeacherId: t3.teacherId,
        substituteTeacher: t2.name, substituteTeacherId: t2.teacherId,
        semesterId, createdAt: '2026-10-20T00:00:00.000Z', isSelfSwap: false,
        approvedBy: chief.teacherId, approvedByName: chief.name, approvedAt: '2026-10-20T01:00:00.000Z',
        ...over,
    });

    /** 注入給 verifyNoAssignmentConflict 的日期範圍查詢：REST 列出集合後依 date 範圍篩選（等同 where date >= <=）。 */
    const queryRange = async ({ startDate, endDate }) => {
        const res = await listDocs(P.records, { idToken: chief.idToken });
        if (!res.ok) throw new Error(`列出紀錄失敗 ${res.status}`);
        return res.docs.filter(d => d.date >= startDate && d.date <= endDate).map(d => ({ ...d, recordId: d.id }));
    };
    const countRecords = async () => (await listDocs(P.records, { idToken: chief.idToken })).docs.length;

    /* ---- 案例 1：申請 A 待核准 → 另一筆紀錄先成立佔用 → 核准 A 被拒、紀錄未寫入 ---- */

    await suite.case('申請 A 待核准期間，另一筆紀錄先成立佔用同一教師同一節 → 核准前重驗回報衝突，且無紀錄寫入', async () => {
        allowed(await createDoc(P.pending, 'zz05_reqA', baseReq(), { idToken: t1.idToken }), '前置：建立待核准的代課申請 A');

        // 申請 A 剛建立時沒有衝突
        const reqBefore = (await getDoc(`${P.pending}/zz05_reqA`, { idToken: chief.idToken })).data;
        eq(await verifyNoAssignmentConflict(reqBefore, queryRange), null, '佔用前核准重驗應放行');

        // 另一筆紀錄先成立，佔走 t2 的同日同節
        allowed(await createDoc(P.records, 'zz05_rec', baseRecord(), { idToken: chief.idToken }), '前置：另一筆紀錄先成立');
        const before = await countRecords();

        const req = (await getDoc(`${P.pending}/zz05_reqA`, { idToken: chief.idToken })).data;
        const hit = await verifyNoAssignmentConflict(req, queryRange);
        ok(hit, '應偵測到衝突');
        eq(hit.teacher, t2.name, '衝突教師');
        const msg = buildApprovalConflictMessage(hit);
        includes(msg, `核准失敗：${t2.name} 2026-10-20 第三節已被指派為802的代課`, '訊息內容');
        includes(msg, '請駁回或請申請人改選', '訊息結尾');

        // 衝突時 approveRequest 在寫入前就丟錯：申請維持待核准、紀錄數不變、沒有 fromRequestId 的紀錄
        eq((await getDoc(`${P.pending}/zz05_reqA`, { idToken: chief.idToken })).data.status, 'pending_approval', '申請 A 狀態不變');
        eq(await countRecords(), before, '紀錄總數不變');
        const all = (await listDocs(P.records, { idToken: chief.idToken })).docs;
        eq(all.filter(d => d.fromRequestId === 'zz05_reqA').length, 0, '不存在由申請 A 產生的紀錄');
    });

    await suite.case('佔用被排除後（他日／他節）核准重驗放行', async () => {
        const req = (await getDoc(`${P.pending}/zz05_reqA`, { idToken: chief.idToken })).data;
        eq(await verifyNoAssignmentConflict({ ...req, period: '第四節' }, queryRange), null, '換一節不衝突');
        eq(await verifyNoAssignmentConflict({ ...req, date: '2026-10-21' }, queryRange), null, '換一天不衝突');
    });

    await suite.case('驗證查詢失敗 → fail-closed（不核准）', async () => {
        const req = (await getDoc(`${P.pending}/zz05_reqA`, { idToken: chief.idToken })).data;
        let err = null;
        try { await verifyNoAssignmentConflict(req, async () => { throw new Error('network down'); }); } catch (e) { err = e; }
        eq(err?.code, 'APPROVAL_VERIFY_FAILED', '錯誤碼');
        includes(err.message, '稍後再試', '提示稍後再試');
    });

    /* ---- 案例 2：兩張待核准申請指派同一老師同一節 → 第二張送出時被攔 ---- */

    /** 送出前攔截所用的佔用集合 = 已成立紀錄 + 在途申請（對應 v2-app 的 getAssignmentOccupancyRecordsAsync） */
    const occupancy = async () => {
        const recs = await queryRange({ startDate: '2026-09-01', endDate: '2026-12-31' });
        const open = (await listDocs(P.pending, { idToken: chief.idToken })).docs.map(d => ({ ...d, reqId: d.id }));
        return [...recs, ...pendingRequestsToOccupancyRecords(open)];
    };

    await suite.case('兩張待核准申請指派同一老師同一節 → 第二張送出時被攔，訊息標示（待核准中）', async () => {
        const first = baseReq({ date: '2026-10-27', substituteTeacherId: t3.teacherId, substituteTeacher: t3.name, className: '803' });
        eq(findAssignmentConflict(first, await occupancy()), null, '第一張送出時無衝突');
        allowed(await createDoc(P.pending, 'zz05_reqB1', first, { idToken: t1.idToken }), '第一張送出成功');

        const second = baseReq({ date: '2026-10-27', substituteTeacherId: t3.teacherId, substituteTeacher: t3.name, className: '804',
            originalTeacher: t2.name, originalTeacherId: t2.teacherId });
        const hit = findAssignmentConflict(second, await occupancy());
        ok(hit, '第二張應被攔下');
        eq(hit.teacher, t3.name, '被攔的教師');
        ok(describeAssignmentConflict(hit).endsWith('（待核准中）'), `訊息應標示（待核准中）：${describeAssignmentConflict(hit)}`);
    });

    await suite.case('待同意中的調課申請也佔用：移入時段被第二張代課申請攔下並標示（待同意中）', async () => {
        const swap = baseReq({
            type: '調課', requestType: 'swap', status: 'pending_swap_consent', date: '2026-11-03', period: '第一節',
            pendingConsentTeacherIds: [t3.teacherId], swapTeacherId: t3.teacherId, swapTeacher: t3.name,
            swapDate: '2026-11-05', swapPeriod: '第二節',
        });
        allowed(await createDoc(P.pending, 'zz05_reqSwap', swap, { idToken: t1.idToken }), '前置：待同意的調課申請');

        // t1（原任教師）將在 2026-11-05 第二節被移入去上 t3 的課 → 該節不可再被指派代課
        const sub = baseReq({ date: '2026-11-05', period: '第二節', substituteTeacherId: t1.teacherId, substituteTeacher: t1.name,
            originalTeacher: t2.name, originalTeacherId: t2.teacherId });
        const hit = findAssignmentConflict(sub, await occupancy());
        ok(hit, '應被攔下');
        ok(describeAssignmentConflict(hit).endsWith('（待同意中）'), describeAssignmentConflict(hit));
    });

    await suite.case('他節不誤擋（在途申請只佔用該日該節）', async () => {
        const sub = baseReq({ date: '2026-10-27', period: '第五節', substituteTeacherId: t3.teacherId, substituteTeacher: t3.name });
        eq(findAssignmentConflict(sub, await occupancy()), null, '不同節次應放行');
    });

    return suite;
}
