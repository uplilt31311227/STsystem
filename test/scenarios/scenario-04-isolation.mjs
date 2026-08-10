/**
 * 情境 4：多學期與多校隔離
 *
 * 這一組是整套多租戶設計的核心保證：一所學校的人不能碰到另一所學校的任何東西，
 * 歷史學期一旦切換就整份唯讀。全部打真實 firestore.rules。
 */

import {
    createDoc, updateDoc, getDoc, deleteDoc, listDocs, createTestUser, signIn,
} from '../emulator/emu-client.mjs';
import { Suite, allowed, denied, ok } from './harness.mjs';

/** 取得（必要時建立）一個 email 未驗證的帳號；已存在時改用登入取得 token。 */
async function getOrCreateUnverifiedUser(email) {
    try {
        return await createTestUser(email, { emailVerified: false });
    } catch (err) {
        if (!/EMAIL_EXISTS/i.test(err.message)) throw err;
        return await signIn(email);
    }
}

export async function run(ctx) {
    const suite = new Suite('情境 4：多學期與多校隔離');

    const A = ctx.alpha, B = ctx.beta;
    const aId = A.fixture.schoolId, bId = B.fixture.schoolId;
    const curSem  = A.fixture.config.currentSemester;
    const prevSem = A.fixture.preset.previousSemester;
    const [aT1] = A.teachers;

    /* ============ 跨校隔離 ============ */

    await suite.case('甲校教師讀乙校學校設定被拒', async () => {
        denied(await getDoc(`schools/${bId}/config/main`, { idToken: aT1.idToken }), '跨校讀 config');
    });

    await suite.case('甲校教師讀乙校調代課紀錄被拒', async () => {
        const rec = B.fixture.substituteRecords[0];
        denied(await getDoc(`schools/${bId}/substituteRecords/${rec.recordId}`, { idToken: aT1.idToken }), '跨校讀紀錄');
    });

    await suite.case('甲校教師寫入乙校紀錄被拒', async () => {
        denied(await createDoc(`schools/${bId}/substituteRecords`, 'zz_cross_school', {
            id: 'zz_cross_school', type: '代課', date: '2026-09-25',
            originalTeacherId: aT1.teacherId, substituteTeacherId: aT1.teacherId,
            semesterId: curSem, createdAt: '2026-09-25T00:00:00.000Z',
        }, { idToken: aT1.idToken }), '跨校寫紀錄');
    });

    await suite.case('甲校主任修改乙校教師檔被拒', async () => {
        const bTeacher = B.fixture.teachers[3];
        denied(await updateDoc(`schools/${bId}/teachers/${bTeacher.teacherId}`, {
            role: 'director',
        }, { idToken: A.director.idToken }), '跨校提權');
    });

    await suite.case('乙校教師讀自己學校的資料正常（隔離不是全面封鎖）', async () => {
        const rec = B.fixture.substituteRecords[0];
        allowed(await getDoc(`schools/${bId}/substituteRecords/${rec.recordId}`, { idToken: B.teachers[0].idToken }), '本校讀本校');
        allowed(await getDoc(`schools/${bId}/config/main`, { idToken: B.teachers[0].idToken }), '本校讀 config');
    });

    /* ============ 身分索引 ============ */

    await suite.case('教師只能查自己的 email 索引', async () => {
        const me    = A.fixture.teachers.find(t => t.teacherId === aT1.teacherId);
        const other = A.fixture.teachers.find(t => t.email && t.teacherId !== aT1.teacherId);
        allowed(await getDoc(`schools/${aId}/emailIndex/${me.email}`, { idToken: aT1.idToken }), '查自己的索引');
        denied(await getDoc(`schools/${aId}/emailIndex/${other.email}`, { idToken: aT1.idToken }), '查他人的索引');
    });

    await suite.case('一般教師不可整包列出 email 索引，組長可以', async () => {
        denied(await listDocs(`schools/${aId}/emailIndex`, { idToken: aT1.idToken }), '教師列出索引');
        allowed(await listDocs(`schools/${aId}/emailIndex`, { idToken: A.sectionChief.idToken }), '組長列出索引');
    });

    await suite.case('只能讀自己的學校歸屬（userDirectory）', async () => {
        allowed(await getDoc(`userDirectory/${aT1.localId}`, { idToken: aT1.idToken }), '讀自己的歸屬');
        denied(await getDoc(`userDirectory/${A.director.localId}`, { idToken: aT1.idToken }), '讀他人的歸屬');
    });

    await suite.case('學校歸屬不可指向不存在的學校', async () => {
        denied(await updateDoc(`userDirectory/${aT1.localId}`, {
            schoolId: 'no-such-school',
        }, { idToken: aT1.idToken }), '指向不存在的學校');
    });

    await suite.case('學校歸屬不可夾帶白名單外的欄位', async () => {
        denied(await updateDoc(`userDirectory/${aT1.localId}`, {
            schoolId: aId, role: 'director',
        }, { idToken: aT1.idToken }), '夾帶 role 欄位');
    });

    await suite.case('未驗證 email 的帳號不可建立學校歸屬', async () => {
        // 帳號可能已存在（單獨重跑本情境、或 clearAuth 未生效）——那時 signUp 會回
        // EMAIL_EXISTS 並丟出例外，案例會被記成 error、真正的權限檢查反而看不到。
        const unverified = await getOrCreateUnverifiedUser('unverified@nowhere.test');
        denied(await createDoc('userDirectory', unverified.localId, {
            schoolId: aId, createdAt: '2026-09-01T00:00:00.000Z',
        }, { idToken: unverified.idToken }), '未驗證 email 建立歸屬');
    });

    await suite.case('外部人士可宣告自己屬於某校，但不會因此取得任何成員權限', async () => {
        allowed(await createDoc('userDirectory', ctx.outsider.localId, {
            schoolId: aId, createdAt: '2026-09-01T00:00:00.000Z',
        }, { idToken: ctx.outsider.idToken }), '外部人士自寫學校歸屬');

        // 關鍵：成員資格看的是 userMappings，不是 userDirectory
        const rec = A.fixture.substituteRecords[0];
        denied(await getDoc(`schools/${aId}/substituteRecords/${rec.recordId}`, { idToken: ctx.outsider.idToken }), '宣告後仍讀不到校內資料');
        denied(await getDoc(`schools/${aId}/config/main`, { idToken: ctx.outsider.idToken }), '宣告後仍讀不到 config');
    }, {
        knownGap: 'userDirectory 的自寫分支只驗證「學校存在」，任何已驗證 email 的帳號都能把自己標記成任一學校的歸屬。'
                + '成員資格由 userMappings 把關，故不構成越權讀取，但外部帳號可藉此在他校留下一筆歸屬文件。',
    });

    /* ============ 學期唯讀鎖 ============ */

    await suite.case('組長可寫入目前學期的課表', async () => {
        allowed(await updateDoc(`schools/${aId}/schedules/${curSem}`, {
            updatedAt: '2026-09-30T00:00:00.000Z',
        }, { idToken: A.sectionChief.idToken }), '寫目前學期課表');
    });

    await suite.case('組長不可寫入歷史學期的課表', async () => {
        denied(await updateDoc(`schools/${aId}/schedules/${prevSem}`, {
            updatedAt: '2026-09-30T00:00:00.000Z',
        }, { idToken: A.sectionChief.idToken }), '寫歷史學期課表');
    });

    await suite.case('一般教師不可寫入任何學期的課表', async () => {
        denied(await updateDoc(`schools/${aId}/schedules/${curSem}`, {
            updatedAt: '2026-09-30T01:00:00.000Z',
        }, { idToken: aT1.idToken }), '教師寫課表');
    });

    await suite.case('校內成員可讀歷史學期課表（歷史資料唯讀查詢）', async () => {
        const res = await getDoc(`schools/${aId}/schedules/${prevSem}`, { idToken: aT1.idToken });
        allowed(res, '讀歷史學期課表');
        ok(Array.isArray(res.data.scheduleData) && res.data.scheduleData.length > 0, '歷史課表應有內容');
    });

    await suite.case('只有主任能改目前學期設定', async () => {
        // 還原一定要放在 finally：任一斷言失敗就跳過還原的話，這所學校會停在錯誤的
        // 目前學期，後面每個依賴 curSem/prevSem 的案例都會在一個顛倒的世界裡評斷，
        // 連帶報出一串假失敗。
        try {
            denied(await updateDoc(`schools/${aId}/config/main`, {
                currentSemester: '115-2',
            }, { idToken: aT1.idToken }), '教師改學期');
            denied(await updateDoc(`schools/${aId}/config/main`, {
                currentSemester: '115-2',
            }, { idToken: A.sectionChief.idToken }), '組長改學期');
            allowed(await updateDoc(`schools/${aId}/config/main`, {
                currentSemester: '115-2', updatedAt: '2026-09-30T00:00:00.000Z',
            }, { idToken: A.director.idToken }), '主任改學期');
        } finally {
            const restored = await updateDoc(`schools/${aId}/config/main`, {
                currentSemester: curSem, updatedAt: '2026-09-30T00:01:00.000Z',
            }, { idToken: A.director.idToken });
            if (!restored.ok) {
                throw new Error(`還原 currentSemester 失敗（HTTP ${restored.status}），` +
                    `後續案例的結果都不可信，請重新種資料再跑一次`);
            }
        }
    });

    await suite.case('主任可刪歷史學期課表，但不可刪目前學期課表', async () => {
        denied(await deleteDoc(`schools/${aId}/schedules/${curSem}`, { idToken: A.director.idToken }), '刪目前學期課表');
        denied(await deleteDoc(`schools/${aId}/schedules/${prevSem}`, { idToken: A.sectionChief.idToken }), '組長刪歷史課表');
        allowed(await deleteDoc(`schools/${aId}/schedules/${prevSem}`, { idToken: A.director.idToken }), '主任刪歷史課表');
    });

    /* ============ 平台層 ============ */

    await suite.case('平台管理者名冊只有本人可讀，且任何人都不可寫', async () => {
        allowed(await getDoc(`platformAdmins/${ctx.platformAdmin.localId}`, { idToken: ctx.platformAdmin.idToken }), '本人讀');
        denied(await getDoc(`platformAdmins/${ctx.platformAdmin.localId}`, { idToken: A.director.idToken }), '他人讀');
        denied(await createDoc('platformAdmins', aT1.localId, {
            email: 'x@y.z', createdAt: '2026-09-01T00:00:00.000Z',
        }, { idToken: aT1.idToken }), '教師自封平台管理者');
        denied(await createDoc('platformAdmins', 'zz_new_admin', {
            email: 'x@y.z', createdAt: '2026-09-01T00:00:00.000Z',
        }, { idToken: ctx.platformAdmin.idToken }), '平台管理者新增其他管理者');
    });

    await suite.case('已驗證 email 的使用者可申請開通新學校', async () => {
        allowed(await createDoc('schoolApplications', ctx.outsider.localId, {
            schoolName: '測試申請國中',
            applicantEmail: ctx.outsider.email,
            applicantUid: ctx.outsider.localId,
            desiredSchoolId: 'demo-gamma',
            status: 'pending',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
        }, { idToken: ctx.outsider.idToken }), '本人提出申請');
    });

    await suite.case('不可代他人提出開校申請', async () => {
        denied(await createDoc('schoolApplications', aT1.localId, {
            schoolName: '冒名申請國中',
            applicantEmail: ctx.outsider.email,
            applicantUid: aT1.localId,
            desiredSchoolId: 'demo-delta',
            status: 'pending',
            createdAt: '2026-09-01T00:00:00.000Z',
            updatedAt: '2026-09-01T00:00:00.000Z',
        }, { idToken: ctx.outsider.idToken }), '冒名申請');
    });

    await suite.case('申請人不可自行把申請改成已核准', async () => {
        denied(await updateDoc(`schoolApplications/${ctx.outsider.localId}`, {
            status: 'approved', updatedAt: '2026-09-02T00:00:00.000Z',
        }, { idToken: ctx.outsider.idToken }), '自行核准');
    });

    await suite.case('平台管理者可核准申請', async () => {
        allowed(await updateDoc(`schoolApplications/${ctx.outsider.localId}`, {
            status: 'approved',
            updatedAt: '2026-09-02T00:00:00.000Z',
            reviewedAt: '2026-09-02T00:00:00.000Z',
        }, { idToken: ctx.platformAdmin.idToken }), '平台管理者核准');
    });

    await suite.case('學校名錄可依代碼查詢，但一般使用者不可列出全部、也不可新增', async () => {
        allowed(await getDoc(`schoolDirectory/${aId}`, { idToken: ctx.outsider.idToken }), '查單一學校代碼');
        denied(await listDocs('schoolDirectory', { idToken: ctx.outsider.idToken }), '列出全平台學校');
        denied(await createDoc('schoolDirectory', 'demo-fake', {
            schoolName: '偽造國中', createdAt: '2026-09-01T00:00:00.000Z',
        }, { idToken: A.director.idToken }), '一般主任新增學校名錄');
        allowed(await createDoc('schoolDirectory', 'demo-gamma', {
            schoolName: '測試申請國中', createdAt: '2026-09-02T00:00:00.000Z',
        }, { idToken: ctx.platformAdmin.idToken }), '平台管理者新增學校名錄');
    });

    await suite.case('平台管理者不可讀取任何學校的業務資料', async () => {
        denied(await getDoc(`schools/${aId}/config/main`, { idToken: ctx.platformAdmin.idToken }), '平台管理者讀 config');
        const rec = A.fixture.substituteRecords[0];
        denied(await getDoc(`schools/${aId}/substituteRecords/${rec.recordId}`, { idToken: ctx.platformAdmin.idToken }), '平台管理者讀紀錄');
    });

    return suite;
}
