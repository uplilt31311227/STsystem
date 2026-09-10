/**
 * 全流程操作 2：代課申請 → 待辦 → 核准／駁回
 *
 * 真的在畫面上走完四個步驟：選教師與日期 → 選異動類型與假別 → 點課表格子選課 →
 * 從推薦清單挑代課教師 → 送出。之後換組長帳號在待辦頁核准或駁回。
 */

import {
    ACCOUNTS, loginStable, gotoTab, shot, bodyText, waitForText, realErrors,
} from './helpers.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';

/** 2026-09-07 是週一；林彥廷該日第四節有 8年1班國語文（見 fixture 的固定課表）。 */
const DATE_MON = '2026-09-07';

/** 填完步驟一～三，停在「選擇代課教師」之前。 */
async function fillUntilCourse(page, { teacher, date = DATE_MON, weekday = '週一', period = '第四節', leave = '公假' }) {
    await gotoTab(page, 'substitute', 1200);
    await page.selectOption('#sub-teacher', { label: teacher });
    await page.fill('#sub-date', date);
    await page.waitForTimeout(1200);
    await page.click(`.schedule-cell.schedule-course[data-weekday="${weekday}"][data-period="${period}"]`);
    await page.waitForTimeout(800);
    await page.selectOption('#leave-type', { label: leave });
    await page.waitForTimeout(1200);
}

/**
 * 找出推薦清單上的代課教師，並就地標記 data-e2e-rec 供點擊。
 *
 * 不能用 getByText(姓名) 點——同一個姓名也出現在「原任課教師」的 <option> 裡，
 * Playwright 會先解析到那個看不見的 option，然後在等它變成可見時逾時。
 */
function recommendedTeachers(page) {
    return page.evaluate(() => {
        const out = [];
        document.querySelectorAll('#substitute-tab *').forEach(el => {
            if (el.children.length > 3) return;
            const t = (el.innerText || '').trim();
            const m = /^([一-龥]{2,4})\n(同領域教師（.*?）|該時段空堂)/.exec(t);
            if (!m) return;
            // 取最深的那一層（父容器也會匹配到同樣的文字）
            if ([...el.children].some(c => /^[一-龥]{2,4}\n(同領域教師（|該時段空堂)/.test((c.innerText || '').trim()))) return;
            el.setAttribute('data-e2e-rec', m[1]);
            out.push({ name: m[1], tag: m[2] });
        });
        const seen = new Set();
        return out.filter(x => (seen.has(x.name) ? false : seen.add(x.name)));
    });
}

/** 點選推薦清單中的某位代課教師。 */
async function pickSubstitute(page, name) {
    await page.click(`[data-e2e-rec="${name}"]`);
    await page.waitForTimeout(600);
}

export async function run(browser) {
    const suite = new Suite('操作 2：代課申請與審核全流程');

    /* ===== 推薦清單的正確性 ===== */

    await suite.case('代課教師推薦清單排除該時段有課的教師，並標示同領域', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
        try {
            await fillUntilCourse(page, { teacher: '林彥廷' });
            const recs = await recommendedTeachers(page);
            ok(recs.length > 0, '應列出可代課的教師');

            // 該時段（週一第四節）實際有課的教師，一個都不該出現在推薦清單
            const busy = await page.evaluate(() => {
                const sd = window.app?.dataManager?.scheduleData || [];
                return [...new Set(sd.filter(r => r.weekday === '週一' && r.period === '第四節').map(r => r.teacher))];
            });
            const wrong = recs.filter(r => busy.includes(r.name));
            eq(wrong.map(w => w.name), [], '推薦清單不應包含該時段有課的教師');

            // 同領域（國語文＝語文領域）的教師應被標示出來
            const sameDomain = recs.filter(r => r.tag.startsWith('同領域'));
            ok(sameDomain.length > 0, `應有同領域教師標示（實際標籤：${recs.slice(0, 5).map(r => r.tag).join('、')}）`);
            await shot(page, '02-recommend-list');
        } finally { await page.close(); }
    });

    /* ===== 必填欄位的例外 ===== */

    await suite.case('公假未填公文字號時擋下送出', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
        try {
            await fillUntilCourse(page, { teacher: '林彥廷', leave: '公假' });
            const recs = await recommendedTeachers(page);
            ok(recs.length > 0, '應有可選的代課教師');
            await pickSubstitute(page, recs[0].name);

            // 公文字號留空直接送出
            await page.click('#confirm-substitute-btn');
            const blocked = await waitForText(page, /公假字號|公文|字號/, 6000);
            ok(blocked, '公假未填字號應出現提示');
            await shot(page, '02-missing-doc-number');
        } finally { await page.close(); }
    });

    await suite.case('未選課程時不會出現送出按鈕', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
        try {
            await gotoTab(page, 'substitute', 1200);
            await page.selectOption('#sub-teacher', { label: '林彥廷' });
            await page.fill('#sub-date', DATE_MON);
            await page.waitForTimeout(1200);
            const btn = await page.$('#confirm-substitute-btn');
            const visible = btn ? await btn.isVisible() : false;
            eq(visible, false, '尚未選課程時不應能送出');
        } finally { await page.close(); }
    });

    /* ===== 一般教師的可操作範圍 ===== */

    await suite.case('一般教師的「原任課教師」欄位未鎖定，可選到其他教師（由規則層擋下）', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.teacherA, { needSchedule: true });
        try {
            await gotoTab(page, 'substitute', 1500);
            const info = await page.evaluate(() => {
                const sel = document.getElementById('sub-teacher');
                return {
                    disabled: sel?.disabled ?? null,
                    options: [...(sel?.options || [])].map(o => o.text).filter(t => t && !/請選擇/.test(t)),
                };
            });
            // 如實記錄目前行為：UI 沒有限制，可選全校教師。
            // 真正的防線在 firestore.rules（「教師代他人發起申請被拒」已於情境 2 驗證為 403），
            // 所以這不是可被利用的越權，但使用者可以一路填到送出才被拒絕。
            ok(info.options.length > 0, '應列得出教師選項');
            eq(info.disabled, false, '目前實作沒有停用這個欄位');
            await shot(page, '02-teacher-selector');
        } finally { await page.close(); }
    }, {
        knownGap: '一般教師登入時，「原任課教師」下拉仍可選到全校任何一位教師（實測 20 位），'
                + 'UI 層沒有鎖定為本人。越權寫入由 firestore.rules 擋下（情境 2 已驗證回 403），'
                + '因此不構成資料風險，但教師可能一路填完才在送出時被拒，體驗上不理想。',
    });

    /* ===== 完整流程：申請 → 待辦 → 核准 ===== */

    await suite.case('教師送出代課申請後，組長在待辦看得到並可核准', async () => {
        const { page: tPage } = await loginStable(browser, ACCOUNTS.teacherA, { needSchedule: true });
        let cPage = null;
        try {
            // 目前登入者的姓名取自畫面右上角的身份區（sub-teacher 的預設值可能是「請選擇教師」）
            await gotoTab(tPage, 'substitute', 1200);
            const me = await tPage.evaluate(() =>
                (document.getElementById('user-name')?.innerText || '').replace(/\s+/g, ' ').trim().split(' ')[0]);
            ok(me && !/請選擇/.test(me), `應能取得目前登入教師姓名（實際：${me}）`);

            const slot = await tPage.evaluate((name) => {
                const sd = window.app?.dataManager?.scheduleData || [];
                const mine = sd.filter(r => r.teacher === name && r.weekday === '週一');
                return mine.length ? { weekday: mine[0].weekday, period: mine[0].period, className: mine[0].className } : null;
            }, me);
            ok(slot, `${me} 在週一應有課可申請`);

            await tPage.selectOption('#sub-teacher', { label: me }).catch(() => {});
            await tPage.fill('#sub-date', DATE_MON);
            await tPage.waitForTimeout(1200);
            await tPage.click(`.schedule-cell.schedule-course[data-weekday="${slot.weekday}"][data-period="${slot.period}"]`);
            await tPage.waitForTimeout(800);
            await tPage.selectOption('#leave-type', { label: '事假' });   // 事假不需公文字號
            await tPage.fill('#sub-reason', 'E2E 測試：家中有事');
            await tPage.waitForTimeout(1200);

            const recs = await recommendedTeachers(tPage);
            ok(recs.length > 0, '應有可選的代課教師');
            const sub = recs[0].name;
            await pickSubstitute(tPage, sub);
            await tPage.click('#confirm-substitute-btn');

            const submitted = await waitForText(tPage, /已送出|待審核|申請成功|已建立|等待/, 12000);
            ok(submitted, `送出後應有回饋訊息（畫面：${(await bodyText(tPage)).slice(0, 150)}）`);
            await shot(tPage, '02-submitted');

            // 換組長看待辦
            const chief = await loginStable(browser, ACCOUNTS.sectionChief, { needSchedule: true });
            cPage = chief.page;
            await gotoTab(cPage, 'v2-pending', 2500);
            const pendingText = await bodyText(cPage);
            includes(pendingText, slot.className, '待辦應出現剛送出的申請（班級）');
            includes(pendingText, me, '待辦應顯示原任課教師');
            await shot(cPage, '02-chief-pending');

            // 核准
            const approveBtn = cPage.getByRole('button', { name: /核准/ }).first();
            ok(await approveBtn.count() > 0, '組長應看得到核准按鈕');
            await approveBtn.click();
            await cPage.waitForTimeout(3500);
            await shot(cPage, '02-approved');

            // 核准後應進入調代課紀錄
            await gotoTab(cPage, 'records', 2500);
            const recordsText = await bodyText(cPage);
            includes(recordsText, me, '核准後的紀錄應出現在調代課紀錄頁');
            eq(realErrors(cPage), [], '核准過程不應有 console 錯誤');
        } finally {
            await tPage.close();
            if (cPage) await cPage.close();
        }
    });

    return suite;
}
