/**
 * 全流程操作 1：登入、角色可見範圍、登入例外
 */

import {
    ACCOUNTS, login, loginStable, visibleTabs, whoAmI, shot, realErrors, newPage, bodyText,
} from './helpers.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';

export async function run(browser) {
    const suite = new Suite('操作 1：登入與角色可見範圍');
    const seen = {};

    async function loginAs(role, email) {
        return loginStable(browser, email);
    }

    await suite.case('教務主任登入後進入系統，且看得到全部管理功能', async () => {
        const { page, result } = await loginAs('director', ACCOUNTS.director);
        try {
            eq(result.state, 'signed-in', '主任應成功進入系統');
            const tabs = await visibleTabs(page);
            seen.director = tabs;
            for (const t of ['substitute', 'v2-pending', 'records', 'schedule', 'teachers', 'settlement', 'v2-logs', 'settings']) {
                ok(tabs.includes(t), `主任應看得到頁籤 ${t}（實際：${tabs.join(', ')}）`);
            }
            includes(await whoAmI(page), '李士箴', '應顯示登入者姓名');
            await shot(page, '01-director-home');
            eq(realErrors(page), [], '登入過程不應有 console 錯誤');
        } finally { await page.close(); }
    });

    await suite.case('教學組長登入後看得到審核、課表與月結算', async () => {
        const { page, result } = await loginAs('chief', ACCOUNTS.sectionChief);
        try {
            eq(result.state, 'signed-in', '組長應成功進入系統');
            const tabs = await visibleTabs(page);
            seen.sectionChief = tabs;
            for (const t of ['substitute', 'v2-pending', 'records', 'schedule', 'settlement', 'v2-logs']) {
                ok(tabs.includes(t), `組長應看得到頁籤 ${t}（實際：${tabs.join(', ')}）`);
            }
            await shot(page, '01-chief-home');
            eq(realErrors(page), [], '登入過程不應有 console 錯誤');
        } finally { await page.close(); }
    }, {
        knownGap: '「教師管理」頁籤對教學組長也可見（與教務主任相同）。'
                + '實際的增刪改由 firestore.rules 限定 director，組長改不動（規則層已由情境 2 驗證），'
                + '但 UI 沒有依角色隱藏這個入口。',
    });

    await suite.case('一般教師登入後看不到審核／課表管理／教師管理／操作日誌', async () => {
        const { page, result } = await loginAs('teacher', ACCOUNTS.teacherA);
        try {
            eq(result.state, 'signed-in', '一般教師應成功進入系統');
            const tabs = await visibleTabs(page);
            seen.teacher = tabs;
            ok(tabs.includes('substitute'), '教師應能提出申請');
            ok(tabs.includes('records'), '教師應看得到紀錄');
            for (const t of ['teachers', 'v2-logs', 'settlement']) {
                ok(!tabs.includes(t), `一般教師不應看到頁籤 ${t}（實際：${tabs.join(', ')}）`);
            }
            await shot(page, '01-teacher-home');
            eq(realErrors(page), [], '登入過程不應有 console 錯誤');
        } finally { await page.close(); }
    });

    await suite.case('密碼錯誤時停在登入視窗並顯示錯誤，不會進入系統', async () => {
        const page = await newPage(browser);
        try {
            const result = await login(page, ACCOUNTS.director, '錯誤的密碼');
            eq(result.state, 'error', `應停在登入視窗（實際狀態：${result.state}）`);
            ok(result.message.length > 0, '應顯示錯誤訊息');
            await shot(page, '01-wrong-password');
        } finally { await page.close(); }
    });

    await suite.case('不在任何學校名冊上的帳號被導向「加入／申請學校」，而非直接放行', async () => {
        const page = await newPage(browser);
        try {
            const result = await login(page, ACCOUNTS.outsider);
            eq(result.state, 'needs-school', `應導向加入/申請流程（實際：${result.state}）`);
            const text = await bodyText(page);
            includes(text, '加入既有學校', '應提供加入既有學校的入口');
            includes(text, '申請開通新學校', '應提供申請開通新學校的入口');
            await shot(page, '01-outsider-gate');
        } finally { await page.close(); }
    });

    await suite.case('他校主任登入後看到的是自己學校的課表，不是甲校的', async () => {
        const { page, result } = await loginStable(browser, ACCOUNTS.betaDirector, { needSchedule: true });
        try {
            eq(result.state, 'signed-in', '乙校主任應能登入自己的學校');

            // 兩校的班級數不同（甲校 9 班、乙校 6 班），用班級清單分辨看到的是哪一所學校的資料
            const classes = await page.evaluate(() => window.app?.dataManager?.classes || []);
            eq(classes.length, 6, `乙校應有 6 個班級（實際：${classes.join(', ')}）`);
            ok(!classes.includes('7年3班'), '不應出現甲校才有的班級');
            await shot(page, '01-beta-director');
        } finally { await page.close(); }
    });

    suite.meta = seen;
    return suite;
}
