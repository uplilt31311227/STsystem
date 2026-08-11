/**
 * 全流程操作 1：登入、角色可見範圍、登入例外
 */

import {
    ACCOUNTS, login, visibleTabs, whoAmI, shot, realErrors, newPage, bodyText,
} from './helpers.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';

export async function run(browser) {
    const suite = new Suite('操作 1：登入與角色可見範圍');
    const seen = {};

    async function loginAs(role, email) {
        const page = await newPage(browser);
        const result = await login(page, email);
        return { page, result };
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

    await suite.case('教學組長登入後看得到審核與課表，但看不到教師管理', async () => {
        const { page, result } = await loginAs('chief', ACCOUNTS.sectionChief);
        try {
            eq(result.state, 'signed-in', '組長應成功進入系統');
            const tabs = await visibleTabs(page);
            seen.sectionChief = tabs;
            for (const t of ['substitute', 'v2-pending', 'records', 'schedule', 'settlement', 'v2-logs']) {
                ok(tabs.includes(t), `組長應看得到頁籤 ${t}（實際：${tabs.join(', ')}）`);
            }
            ok(!tabs.includes('teachers'), `組長不應看到「教師管理」（實際：${tabs.join(', ')}）`);
            await shot(page, '01-chief-home');
            eq(realErrors(page), [], '登入過程不應有 console 錯誤');
        } finally { await page.close(); }
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

    await suite.case('他校主任登入後看到的是自己學校的資料，不是甲校', async () => {
        const page = await newPage(browser);
        try {
            const result = await login(page, ACCOUNTS.betaDirector);
            eq(result.state, 'signed-in', '乙校主任應能登入自己的學校');
            const text = await bodyText(page);
            includes(text, '乙校', '應顯示乙校的校名');
            await shot(page, '01-beta-director');
        } finally { await page.close(); }
    });

    suite.meta = seen;
    return suite;
}
