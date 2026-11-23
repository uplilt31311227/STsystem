/**
 * 全流程操作 2：代課申請 → 待辦 → 核准／駁回
 *
 * 真的在畫面上走完四個步驟：選教師與日期 → 選異動類型與假別 → 點課表格子選課 →
 * 從推薦清單挑代課教師 → 送出。之後換組長帳號在待辦頁核准或駁回。
 */

import {
    ACCOUNTS, loginStable, gotoTab, shot, bodyText, waitForText, realErrors, waitForIdentityName,
} from './helpers.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';

/** 2026-09-07 是週一；巫阿福該日第四節有 8年1班國語文（見 fixture 的固定課表）。 */
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
        // 推薦理由的五種開頭，對齊 recommendationEngine.calculateScore() 組出的 texts。
        // 引擎改標籤文字時這裡必須同步，否則帶新標籤的教師會整個讀不到（2026-09-18 踩過）。
        const HEAD = '同科目（|同領域（|該班導師（|同任課班級（|兼課教師|該時段空堂';
        const full = new RegExp(`^([一-龥]{2,4})\\n(${HEAD})([^\\n]*)`);
        const head = new RegExp(`^[一-龥]{2,4}\\n(${HEAD})`);
        const out = [];
        document.querySelectorAll('#substitute-tab *').forEach(el => {
            if (el.children.length > 3) return;
            const t = (el.innerText || '').trim();
            const m = full.exec(t);
            if (!m) return;
            // 取最深的那一層（父容器也會匹配到同樣的文字）
            if ([...el.children].some(c => head.test((c.innerText || '').trim()))) return;
            el.setAttribute('data-e2e-rec', m[1]);
            out.push({ name: m[1], tag: m[2] + m[3] });
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

    await suite.case('代課教師推薦清單排除該時段有課的教師，並標示同科目', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
        try {
            await fillUntilCourse(page, { teacher: '巫阿福' });
            const recs = await recommendedTeachers(page);
            ok(recs.length > 0, '應列出可代課的教師');

            // 該時段（週一第四節）實際有課的教師，一個都不該出現在推薦清單
            const busy = await page.evaluate(() => {
                const sd = window.app?.dataManager?.scheduleData || [];
                return [...new Set(sd.filter(r => r.weekday === '週一' && r.period === '第四節').map(r => r.teacher))];
            });
            const wrong = recs.filter(r => busy.includes(r.name));
            eq(wrong.map(w => w.name), [], '推薦清單不應包含該時段有課的教師');

            // 同科目（也教國語文）且該時段空堂的教師，應該全部被標示為「同科目」。
            // 期望名單由課表現算、不寫死姓名，fixture 換 seed 重新排課後這條斷言仍然成立。
            const expectSameSubject = await page.evaluate(({ weekday, period, teacher }) => {
                const sd = window.app?.dataManager?.scheduleData || [];
                const target = sd.find(r => r.teacher === teacher && r.weekday === weekday && r.period === period);
                if (!target) return [];
                const busyNow = new Set(sd.filter(r => r.weekday === weekday && r.period === period).map(r => r.teacher));
                return [...new Set(sd.filter(r => r.subject === target.subject).map(r => r.teacher))]
                    .filter(n => n !== teacher && !busyNow.has(n));
            }, { weekday: '週一', period: '第四節', teacher: '巫阿福' });

            ok(expectSameSubject.length > 0, '課表中應存在同科目且該時段空堂的教師，否則此案失去意義');
            const tagged = recs.filter(r => r.tag.startsWith('同科目')).map(r => r.name).sort();
            eq(tagged, [...expectSameSubject].sort(),
                `同科目標示與課表不符（實際標籤：${recs.slice(0, 5).map(r => `${r.name}＝${r.tag}`).join('、')}）`);
            await shot(page, '02-recommend-list');
        } finally { await page.close(); }
    });

    /* ===== 必填欄位的例外 ===== */

    await suite.case('公假未填公文字號時擋下送出', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
        try {
            await fillUntilCourse(page, { teacher: '巫阿福', leave: '公假' });
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
            await page.selectOption('#sub-teacher', { label: '巫阿福' });
            await page.fill('#sub-date', DATE_MON);
            await page.waitForTimeout(1200);
            const btn = await page.$('#confirm-substitute-btn');
            const visible = btn ? await btn.isVisible() : false;
            eq(visible, false, '尚未選課程時不應能送出');
        } finally { await page.close(); }
    });

    /* ===== 一般教師的可操作範圍 ===== */

    await suite.case('一般教師的「原任課教師」欄位鎖定為本人', async () => {
        const { page } = await loginStable(browser, ACCOUNTS.teacherA, { needSchedule: true });
        try {
            await gotoTab(page, 'substitute', 1500);
            const me = await waitForIdentityName(page);
            const info = await page.evaluate(() => {
                const sel = document.getElementById('sub-teacher');
                return {
                    disabled: sel?.disabled ?? null,
                    value: sel?.value ?? null,
                    options: [...(sel?.options || [])].map(o => o.text),
                };
            });
            eq(info.disabled, true, '欄位應停用');
            eq(info.value, me, '應鎖定為登入者本人');
            eq(info.options, [me], '選單只應剩本人一項');
            await shot(page, '02-teacher-selector');
        } finally { await page.close(); }
    });

    /* ===== 完整流程：申請 → 待辦 → 核准 ===== */

    await suite.case('教師送出代課申請 → 代課教師同意 → 組長在待辦看得到並可核准（v2.20 代課雙簽）', async () => {
        // 代課教師用 teacherB（有登入帳號才能按同意）；先取得其姓名
        const { page: bPage0 } = await loginStable(browser, ACCOUNTS.teacherB, { needSchedule: true });
        let subName;
        try { subName = await waitForIdentityName(bPage0); } finally { await bPage0.close(); }
        ok(subName && !/請選擇/.test(subName), `應能取得 teacherB 姓名（實際：${subName}）`);

        const { page: tPage } = await loginStable(browser, ACCOUNTS.teacherA, { needSchedule: true });
        let cPage = null;
        let bPage = null;
        try {
            // 目前登入者的姓名取自畫面右上角的身份區（sub-teacher 的預設值可能是「請選擇教師」）。
            // 用輪詢等待而非固定等待——emulator 變慢時身份區可能還沒渲染完（見 helpers 的說明）。
            await gotoTab(tPage, 'substitute', 1200);
            const me = await waitForIdentityName(tPage);
            ok(me && !/請選擇/.test(me), `應能取得目前登入教師姓名（實際：${me}）`);

            // 挑 teacherA 有課、且 teacherB 該節空堂的一節（週一～週五皆可），teacherB 才會出現在推薦清單
            const WEEKDAYS = ['週一', '週二', '週三', '週四', '週五'];
            const slot = await tPage.evaluate(({ name, sub, days }) => {
                const sd = window.app?.dataManager?.scheduleData || [];
                const subBusy = new Set(sd.filter(r => r.teacher === sub).map(r => `${r.weekday}|${r.period}`));
                const mine = sd.filter(r => r.teacher === name && days.includes(r.weekday) && !subBusy.has(`${r.weekday}|${r.period}`))
                    .sort((a, b) => days.indexOf(a.weekday) - days.indexOf(b.weekday));
                return mine.length ? { weekday: mine[0].weekday, period: mine[0].period, className: mine[0].className } : null;
            }, { name: me, sub: subName, days: WEEKDAYS });
            ok(slot, `${me} 應有一節課是 ${subName} 空堂的`);
            // DATE_MON（2026-09-07）是週一，依星期幾往後推同一週的日期
            const d = new Date(`${DATE_MON}T00:00:00Z`);
            d.setUTCDate(d.getUTCDate() + WEEKDAYS.indexOf(slot.weekday));
            const slotDate = d.toISOString().slice(0, 10);

            await tPage.selectOption('#sub-teacher', { label: me }).catch(() => {});
            await tPage.fill('#sub-date', slotDate);
            await tPage.waitForTimeout(1200);
            await tPage.click(`.schedule-cell.schedule-course[data-weekday="${slot.weekday}"][data-period="${slot.period}"]`);
            await tPage.waitForTimeout(800);
            await tPage.selectOption('#leave-type', { label: '事假' });   // 事假不需公文字號
            await tPage.fill('#sub-reason', 'E2E 測試：家中有事');
            await tPage.waitForTimeout(1200);

            const recs = await recommendedTeachers(tPage);
            ok(recs.some(r => r.name === subName), `推薦清單應包含 ${subName}（實際：${recs.slice(0, 8).map(r => r.name).join('、')}）`);
            await pickSubstitute(tPage, subName);
            await tPage.click('#confirm-substitute-btn');

            const submitted = await waitForText(tPage, /已送出給代課教師/, 12000);
            ok(submitted, `送出後應提示需代課教師同意（畫面：${(await bodyText(tPage)).slice(0, 150)}）`);
            await shot(tPage, '02-submitted');

            // 代課教師同意前，組長的「待我審核」不應出現這筆
            const chief0 = await loginStable(browser, ACCOUNTS.sectionChief, { needSchedule: true });
            try {
                await gotoTab(chief0.page, 'v2-pending', 2500);
                const before = await chief0.page.evaluate(() => {
                    const hs = [...document.querySelectorAll('.v2-section-header')];
                    const h = hs.find(x => /待我審核/.test(x.textContent));
                    let t = '', n = h?.nextElementSibling;
                    while (n && !n.classList.contains('v2-section-header')) { t += n.textContent; n = n.nextElementSibling; }
                    return t;
                });
                ok(!before.includes(slot.className) || !before.includes(me), '代課教師同意前，組長待審核區不應出現此申請');
            } finally { await chief0.page.close(); }

            // 代課教師登入，在「待我同意」按同意
            const b = await loginStable(browser, ACCOUNTS.teacherB, { needSchedule: true });
            bPage = b.page;
            await gotoTab(bPage, 'v2-pending', 2500);
            const consentText = await bodyText(bPage);
            includes(consentText, '代誰的課', '代課教師的同意卡片應顯示「代誰的課」');
            includes(consentText, me, '同意卡片應顯示原任課教師');
            const consentBtn = bPage.locator('.v2-consent-btn').first();
            ok(await consentBtn.count() > 0, '代課教師應看得到同意按鈕');
            await consentBtn.click();
            await bPage.waitForTimeout(800);
            // 同意可能跳確認框
            const confirmBtn = bPage.getByRole('button', { name: /^(確定|確認|同意)$/ }).last();
            if (await confirmBtn.count() > 0 && await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
            await bPage.waitForTimeout(2500);
            await shot(bPage, '02-sub-consented');
            eq(realErrors(bPage), [], '同意過程不應有 console 錯誤');

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
            if (bPage) await bPage.close();
            if (cPage) await cPage.close();
        }
    });

    return suite;
}
