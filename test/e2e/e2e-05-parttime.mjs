/**
 * 全流程操作 5：教師管理表的「兼課教師」勾選（登入狀態下實際點擊）
 *
 * 先前只做過程式碼推論（docs/CHANGELOG.md 2026-09-10、2026-10-07）。這裡真的以 director 登入、
 * 在教師管理頁籤勾選／取消勾選，並驗證：
 *   1. Firestore 該教師文件的 partTime 真的變 true／false（用 admin 直接讀，不信畫面）
 *   2. 重新整理後勾選仍在
 *   3. 代課申請的推薦清單：該教師被排到最後一層，標記含「兼課」
 *   4. 尚未出現在課表的教師，兼課勾選停用
 *   5. section_chief 看不到教師管理頁籤
 *
 * 開頭會重新種一次資料，確保起點乾淨、也不依賴前面 suite 留下的狀態；
 * 結尾（取消勾選那案）已把 partTime 還原為 false。
 */

import {
    ACCOUNTS, loginStable, gotoTab, shot, visibleTabs, realErrors,
    isSignedIn, loadedScheduleCount, ensureModalClosed,
    LOGIN_TIMEOUT_MS, SCHEDULE_TIMEOUT_MS,
} from './helpers.mjs';
import { Suite, eq, ok } from '../scenarios/harness.mjs';
import { seedAll } from '../emulator/seed.mjs';
import { getDoc } from '../emulator/emu-client.mjs';

const DATE_MON = '2026-09-07';          // 週一；林彥廷該日第四節有 8年1班國語文

/** 填完步驟一～三，停在「選擇代課教師」之前（與 e2e-02 同）。 */
async function fillUntilCourse(page, { teacher, date = DATE_MON, weekday = '週一', period = '第四節', leave = '事假' }) {
    await gotoTab(page, 'substitute', 1200);
    await page.selectOption('#sub-teacher', { label: teacher });
    await page.fill('#sub-date', date);
    await page.waitForTimeout(1200);
    await page.click(`.schedule-cell.schedule-course[data-weekday="${weekday}"][data-period="${period}"]`);
    await page.waitForTimeout(800);
    await page.selectOption('#leave-type', { label: leave });
    await page.waitForTimeout(1200);
}

/** 推薦清單（依畫面順序）：[{ name, tag, partTime }]。以 .recommendation-item 的 class 結構讀取（app.js 渲染）。 */
async function recommendedTeachers(page) {
    // 本機 emulator 查詢慢：先等清單渲染出至少一項（逾時就照現況讀，由斷言報錯）
    await page.waitForSelector('#recommendation-list .recommendation-item', { timeout: 60000 }).catch(() => {});
    return page.evaluate(() => [...document.querySelectorAll('#recommendation-list .recommendation-item')].map(el => ({
        name: el.querySelector('.recommendation-name')?.textContent.trim() || '',
        tag: (el.querySelector('.recommendation-reason')?.textContent.trim() || '')
            + ' ' + [...el.querySelectorAll('.recommendation-badge')].map(b => b.textContent.trim()).join(' '),
        partTime: !!el.querySelector('.recommendation-badge.badge-part-time'),
    })));
}

/** 輪詢 Firestore 教師文件直到 partTime 等於期望布林值（寫入非同步，emulator 又慢）。 */
async function waitPartTime(schoolId, teacherId, expected, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        const res = await getDoc(`schools/${schoolId}/teachers/${teacherId}`);
        last = res.data?.partTime;
        if (last === expected) return last;
        await new Promise(r => setTimeout(r, 500));
    }
    return last;
}

/** 重新整理並等回到已登入且課表載入（登入 session 由 Firebase Auth 持久化）。 */
async function reloadAndWait(page) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + LOGIN_TIMEOUT_MS + SCHEDULE_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await page.waitForTimeout(500);
        if (await isSignedIn(page) && await loadedScheduleCount(page) > 0) {
            await ensureModalClosed(page);
            return true;
        }
    }
    return false;
}

export async function run(browser) {
    const suite = new Suite('操作 5：兼課教師勾選（登入狀態實測）');
    const schoolId = 'demo-alpha';
    await seedAll({ quiet: true });

    const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
    const ctx = {};   // 跨案例共享：目標教師與其文件 id

    try {
        await suite.case('勾選兼課：Firestore 教師文件 partTime 變 true，且勾選框維持勾選', async () => {
            // 找一位「同科目、該時段空堂」的教師當兼課對象——不勾兼課時他會排在最前面一層，
            // 勾了之後掉到最後一層才有對比意義。名單由課表現算、不寫死姓名。
            const target = await page.evaluate(({ weekday, period, teacher }) => {
                const sd = window.app?.dataManager?.scheduleData || [];
                const course = sd.find(r => r.teacher === teacher && r.weekday === weekday && r.period === period);
                if (!course) return null;
                const busy = new Set(sd.filter(r => r.weekday === weekday && r.period === period).map(r => r.teacher));
                return [...new Set(sd.filter(r => r.subject === course.subject).map(r => r.teacher))]
                    .filter(n => n !== teacher && !busy.has(n)).sort()[0] || null;
            }, { weekday: '週一', period: '第四節', teacher: '林彥廷' });
            ok(target, '課表中應有同科目且該時段空堂的教師');
            ctx.name = target;

            // 基準：勾選前，目標教師應「不是最後一層」且無兼課標記，之後掉到最後才有對比意義
            await fillUntilCourse(page, { teacher: '林彥廷' });
            const base = await recommendedTeachers(page);
            const bi = base.findIndex(r => r.name === ctx.name);
            ok(bi >= 0, `${ctx.name} 勾選前應在推薦清單內`);
            ok(!base[bi].partTime, `勾選前不應有兼課標記（實際：${base[bi].tag}）`);
            ok(bi < base.length - 1, `勾選前不應已在最後一位（第 ${bi + 1}/${base.length}；順序：${base.map(r => r.name).join('、')}）`);
            ok(base.every(r => !r.partTime), '勾選前清單內無任何兼課標記');

            await gotoTab(page, 'teachers', 2500);
            const row = page.locator(`tr[data-name="${ctx.name}"]`);
            await row.waitFor({ state: 'visible', timeout: 90000 });
            ctx.id = await row.getAttribute('data-id');
            const box = row.locator('.v2-parttime-input');
            eq(await box.isDisabled(), false, `${ctx.name} 已在課表上，兼課勾選應可用`);
            eq(await box.isChecked(), false, '起點應為未勾選');
            const before = (await getDoc(`schools/${schoolId}/teachers/${ctx.id}`)).data?.partTime;
            ok(!before, `起點 Firestore partTime 應為 false／未設（實際 ${before}）`);

            await box.click();
            eq(await waitPartTime(schoolId, ctx.id, true), true, 'Firestore partTime 應為 true');
            eq(await box.isChecked(), true, '勾選框應維持勾選');
            await shot(page, '05-parttime-checked');
        });

        await suite.case('重新整理頁面後，兼課勾選仍在', async () => {
            ok(await reloadAndWait(page), '重新整理後應回到已登入且課表載入');
            await gotoTab(page, 'teachers', 2500);
            const row = page.locator(`tr[data-name="${ctx.name}"]`);
            await row.waitFor({ state: 'visible', timeout: 90000 });
            eq(await row.locator('.v2-parttime-input').isChecked(), true, '重新整理後勾選應仍在');
            await shot(page, '05-parttime-after-reload');
        });

        await suite.case('代課推薦清單：兼課教師排在最後一層，標記含「兼課」', async () => {
            await fillUntilCourse(page, { teacher: '林彥廷' });
            const recs = await recommendedTeachers(page);
            ok(recs.length >= 3, `推薦清單應有多位教師（實際 ${recs.length}）`);
            const idx = recs.findIndex(r => r.name === ctx.name);
            ok(idx >= 0, `${ctx.name} 仍應在推薦清單內（兼課只是排最後，不是排除）`);
            ok(recs[idx].partTime, `標記應含「兼課」（實際：${recs[idx].tag}）`);
            eq(idx, recs.length - 1, `${ctx.name} 應排在最後一位（實際第 ${idx + 1}/${recs.length}；順序：${recs.map(r => r.name).join('、')}）`);
            eq(recs.filter(r => r.partTime).map(r => r.name), [ctx.name], '只有被勾選的教師帶兼課標記');
            await shot(page, '05-parttime-recommend');
        });

        await suite.case('取消勾選：Firestore partTime 回 false，推薦清單不再帶兼課標記', async () => {
            await gotoTab(page, 'teachers', 2500);
            const row = page.locator(`tr[data-name="${ctx.name}"]`);
            await row.waitFor({ state: 'visible', timeout: 90000 });
            const box = row.locator('.v2-parttime-input');
            ok(await box.isChecked(), '取消前應為勾選');
            await box.click();
            eq(await waitPartTime(schoolId, ctx.id, false), false, 'Firestore partTime 應為 false');
            eq(await box.isChecked(), false, '勾選框應為未勾選');

            await fillUntilCourse(page, { teacher: '林彥廷' });
            const recs = await recommendedTeachers(page);
            const me = recs.find(r => r.name === ctx.name);
            ok(me, `${ctx.name} 應在推薦清單`);
            ok(!me.partTime, `取消後不應再有兼課標記（實際：${me.tag}）`);
            ok(recs.findIndex(r => r.name === ctx.name) < recs.length - 1, '取消後不應仍排在最後');
            eq(realErrors(page), [], '過程不應有 console 錯誤');
        });

        await suite.case('尚未出現在課表的教師（名冊有、課表無），兼課勾選為停用', async () => {
            await gotoTab(page, 'teachers', 2500);
            // 教師表由 Firestore 載入，emulator 慢：先等整張表（含已知在課表上的目標）出現
            await page.waitForSelector(`tr[data-name="${ctx.name}"]`, { timeout: 90000 });
            const idle = await page.evaluate(() => {
                const sd = window.app?.dataManager?.scheduleData || [];
                const inSchedule = new Set(sd.map(r => r.teacher));
                return [...document.querySelectorAll('tr[data-name]')].map(tr => tr.dataset.name)
                    .filter(n => !inSchedule.has(n));
            });
            ok(idle.length > 0, '名冊中應有不在課表上的教師（fixture：沈家瑋、許雅文）');
            for (const name of idle) {
                const box = page.locator(`tr[data-name="${name}"] .v2-parttime-input`);
                eq(await box.isDisabled(), true, `${name} 不在課表上，兼課勾選應停用`);
            }
            eq(await page.locator(`tr[data-name="${ctx.name}"] .v2-parttime-input`).isDisabled(), false, '對照：在課表上者可用');
        });
    } finally {
        await page.close();
    }

    await suite.case('section_chief（組長）看不到教師管理頁籤', async () => {
        const { page: cPage } = await loginStable(browser, ACCOUNTS.sectionChief);
        try {
            const tabs = await visibleTabs(cPage);
            ok(tabs.includes('settlement'), `組長應已進入系統（頁籤：${tabs.join(', ')}）`);
            ok(!tabs.includes('teachers'), `組長不應看到 teachers 頁籤（實際：${tabs.join(', ')}）`);
        } finally { await cPage.close(); }
    });

    return suite;
}
