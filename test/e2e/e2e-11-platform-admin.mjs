/**
 * 全流程操作 11：全系統最高管理員（platformAdmin）與核准職務分離（P9 批次 A2）
 *
 * 以種子資料的 platformAdmin 帳號登入：
 *   1. 登入後先看到「選擇要進入的學校」（沒有存過選擇）。
 *   2. 輸入學校代碼進入甲校：以主任身分操作（看得到全部管理頁籤），頂端橫幅與名稱標示「平台管理員」，資料是甲校的。
 *   3. 待辦：自己發起的申請核准鈕停用並說明原因；別人（教師）發起的申請可核准，核准後申請的 approvedBy 是 platformAdmin 的 uid。
 *   4. 按「切換學校」回到選校畫面，改進乙校，看到的是乙校的資料（6 班）。
 * 開頭自行 seed；會改動資料，排在後面。
 */

import {
    APP_URL, PASSWORD, newPage, isSignedIn, ensureModalClosed, visibleTabs, gotoTab, shot, realErrors, bodyText, waitForText,
    loadedScheduleCount, LOGIN_TIMEOUT_MS, SCHEDULE_TIMEOUT_MS,
} from './helpers.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';
import { seedAll } from '../emulator/seed.mjs';
import { getDoc, listDocs, mustSetDoc } from '../emulator/emu-client.mjs';

const PA_EMAIL = 'platform.admin@demo.test';   // seed.mjs 的 PLATFORM_ADMIN_EMAIL
const iso = () => new Date().toISOString();

async function loginToPicker(page) {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#v2-gate-email', { timeout: 20000 });
    await page.click('#v2-gate-email');
    await page.waitForSelector('#v2-modal-email', { timeout: 10000 });
    await page.fill('#v2-modal-email', PA_EMAIL);
    await page.fill('#v2-modal-pwd', PASSWORD);
    await page.click('#v2-modal-submit');
    await page.waitForSelector('#v2-platform-school-id', { timeout: LOGIN_TIMEOUT_MS });
}

async function waitSignedIn(page) {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await isSignedIn(page)) { await ensureModalClosed(page); return true; }
        await page.waitForTimeout(500);
    }
    return false;
}

async function waitSchedule(page) {
    const deadline = Date.now() + SCHEDULE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (await loadedScheduleCount(page) > 0) return true;
        await page.waitForTimeout(1000);
    }
    return false;
}

export async function run(browser) {
    const suite = new Suite('操作 11：platformAdmin 進入學校、職務分離');
    const seed = await seedAll({ quiet: true });
    const paUid = seed.platformAdmin.localId;
    const A = seed.alpha;
    const alphaId = A.fixture.schoolId;
    const betaId = seed.beta.fixture.schoolId;
    const semesterId = A.fixture.config.currentSemester;
    const teacher = A.teachers[0];                                   // 一般教師（有帳號）
    const noSchedule = A.fixture.teachers.find(t => t.name === '竇大俠');   // 不在課表上的教師，當代課教師不會衝堂

    const pend = (id, extra) => mustSetDoc(`schools/${alphaId}/pendingRequests/${id}`, {
        type: '代課', date: '2026-09-07', weekday: '週一', period: '第四節', className: '7年1班', subject: '國語文', domain: '語文',
        originalTeacher: teacher.name, substituteTeacher: noSchedule.name,
        originalTeacherId: teacher.teacherId, substituteTeacherId: noSchedule.teacherId, requiredApproverId: noSchedule.teacherId,
        requestType: 'substitute', status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: {},
        initiatedBy: teacher.teacherId, initiatedByName: teacher.name, semesterId, createdAt: iso(), ...extra,
    });
    await pend('e2e11_others', {});
    await pend('e2e11_own', { initiatedBy: paUid, initiatedByName: '平台管理員', originalTeacher: '平台管理員', originalTeacherId: paUid, period: '第五節' });

    const page = await newPage(browser);
    try {
        await suite.case('platformAdmin 登入後先看到「選擇要進入的學校」，而不是直接進入某所學校', async () => {
            await loginToPicker(page);
            const text = await bodyText(page);
            includes(text, '平台管理員', '選校畫面標示平台管理員');
            includes(text, '選擇要進入的學校', '選校畫面標題');
            ok(!(await isSignedIn(page)), '尚未進入任何學校（遮罩仍在）');
            await shot(page, '11-picker');
        });

        await suite.case('輸入學校代碼進入甲校：以主任身分操作、標示「平台管理員」、看到甲校資料', async () => {
            await page.fill('#v2-platform-school-id', alphaId);
            await page.click('#v2-platform-enter');
            ok(await waitSignedIn(page), 'platformAdmin 應進入甲校');
            ok(await waitSchedule(page), '甲校課表應載入');
            const tabs = await visibleTabs(page);
            for (const t of ['substitute', 'v2-pending', 'records', 'schedule', 'teachers', 'settlement', 'v2-logs', 'settings']) {
                ok(tabs.includes(t), `平台管理員應看得到頁籤 ${t}（實際：${tabs.join(', ')}）`);
            }
            includes(await page.innerText('#user-name'), '平台管理員', '右上角名稱標示平台管理員');
            const banner = await page.innerText('#v2-platform-banner');
            includes(banner, '平台管理員模式', '頂端橫幅');
            includes(banner, alphaId, '橫幅標示目前學校');
            const classes = await page.evaluate(() => window.app?.dataManager?.classes || []);
            eq(classes.length, 9, `甲校應有 9 個班級（實際：${classes.length}）`);
            await shot(page, '11-in-alpha');
        });

        await suite.case('待辦：自己發起的申請核准鈕停用並說明原因；別人發起的申請可核准，核准後 approvedBy 為 platformAdmin 的 uid', async () => {
            await gotoTab(page, 'v2-pending', 2500);
            const own = page.locator('.v2-final-approve-btn[data-id="e2e11_own"]');
            const others = page.locator('.v2-final-approve-btn[data-id="e2e11_others"]');
            await own.waitFor({ timeout: 30000 });
            ok(await own.isDisabled(), '自己發起的申請：核准鈕應停用');
            includes(await bodyText(page), '不能由您本人核准', '應說明原因（職務分離）');
            ok(await others.isEnabled(), '別人發起的申請：核准鈕可按');
            await shot(page, '11-pending-own-vs-others');

            await others.click();
            const deadline = Date.now() + 90000;
            let doc = null;
            while (Date.now() < deadline) {
                doc = (await getDoc(`schools/${alphaId}/pendingRequests/e2e11_others`)).data;
                if (doc?.status === 'approved') break;
                await page.waitForTimeout(1500);
            }
            eq(doc?.status, 'approved', '申請應已核准');
            eq(doc?.approvedBy, paUid, 'approvedBy 應為 platformAdmin 的 uid');
            eq((await getDoc(`schools/${alphaId}/pendingRequests/e2e11_own`)).data.status, 'pending_approval', '自己發起的申請仍待核准');
            const logs = (await listDocs(`schools/${alphaId}/operationLogs`)).docs || [];
            ok(logs.some(l => l.action === 'approve' && l.actor?.teacherId === paUid && l.actor?.name === '平台管理員'),
                '操作日誌應記下 platformAdmin 的核准（actor.teacherId＝uid、名稱為平台管理員）');
            eq(realErrors(page), [], '核准過程不應有 console 錯誤');
        });

        await suite.case('按「切換學校」回到選校畫面，改進乙校：看到的是乙校的資料', async () => {
            await page.click('#v2-platform-switch-school');
            await page.waitForSelector('#v2-platform-school-id', { timeout: LOGIN_TIMEOUT_MS });
            await page.fill('#v2-platform-school-id', betaId);
            await page.click('#v2-platform-enter');
            ok(await waitSignedIn(page), 'platformAdmin 應進入乙校');
            ok(await waitSchedule(page), '乙校課表應載入');
            const classes = await page.evaluate(() => window.app?.dataManager?.classes || []);
            eq(classes.length, 6, `乙校應有 6 個班級（實際：${classes.length}）`);
            includes(await page.innerText('#v2-platform-banner'), betaId, '橫幅改為乙校');
            await shot(page, '11-in-beta');
        });

        await suite.case('輸入不存在的學校代碼 → 留在選校畫面並顯示原因，不會進入系統', async () => {
            await page.click('#v2-platform-switch-school');
            await page.waitForSelector('#v2-platform-school-id', { timeout: LOGIN_TIMEOUT_MS });
            await page.fill('#v2-platform-school-id', 'no-such-school-e2e');
            await page.click('#v2-platform-enter');
            ok(await waitForText(page, /找不到學校|無法進入學校/, 60000), '應顯示進不去的原因');
            ok(!(await isSignedIn(page)), '不應進入系統');
            await shot(page, '11-no-such-school');
        });
    } finally {
        await page.close();
    }
    return suite;
}
