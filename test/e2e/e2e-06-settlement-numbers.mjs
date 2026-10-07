/**
 * 全流程操作 6：月結算畫面的「數字正確性」
 *
 * e2e-03 只驗證月結算頁「能開、有列、沒有 NaN」，沒驗數字。這裡把 emulator 裡的課表與紀錄換成
 * test/fixtures/settlement-golden.mjs 的手算黃金資料（單節／多節代課、調課、同一教師多筆、
 * 月初月末與跨月跨學年、駁回的請求、已刪除的紀錄），再以 director 登入、在月結算頁籤按
 * 「產生報表」，逐格比對畫面表格與手算值。期望值全部寫死在黃金資料檔，不呼叫被測程式產生。
 *
 * V1 與 V2 共用同一個月結算頁籤與 SettlementCalculator（V2 只是把資料來源換成 Firestore 查詢），
 * 所以這一案同時涵蓋了 V1 的計算與畫面。
 *
 * 開頭會重新種一次資料再覆寫課表／紀錄，因此必須排在會依賴原 fixture 的 suite 之後。
 */

import { ACCOUNTS, loginStable, gotoTab, shot, realErrors } from './helpers.mjs';
import { Suite, eq, ok } from '../scenarios/harness.mjs';
import { seedAll } from '../emulator/seed.mjs';
import { getDoc, mustSetDoc, deleteDoc, listDocs } from '../emulator/emu-client.mjs';
import {
    GOLDEN_RECORDS, GOLDEN_REJECTED, GOLDEN_DELETED, GOLDEN_EXPECTED_2026_10, GOLDEN_NAME,
    buildGoldenSchedule,
} from '../fixtures/settlement-golden.mjs';

const SCHOOL = 'demo-alpha';
const SEMESTER = '115-1';

/** 把黃金課表與紀錄寫進 emulator（admin 身分，繞過規則）。 */
async function installGoldenWorld() {
    const teachers = (await listDocs(`schools/${SCHOOL}/teachers`)).docs;
    const idOf = (name) => teachers.find(t => t.name === name)?.id;
    const chief = teachers.find(t => t.role === 'section_chief');
    ok(chief, 'fixture 應有組長');

    // 1) 課表：整份換成黃金課表（保留 doc 的其他欄位）
    const sched = await getDoc(`schools/${SCHOOL}/schedules/${SEMESTER}`);
    ok(sched.ok, '目前學期課表 doc 應存在');
    await mustSetDoc(`schools/${SCHOOL}/schedules/${SEMESTER}`, {
        ...sched.data,
        scheduleData: buildGoldenSchedule(),
        teachers: Object.values(GOLDEN_NAME).map(name => ({ name, domains: ['數學領域'], homeroomClass: '' })),
    });

    // 1.5) 清掉 seed 的已成立紀錄與待審請求（fixture 的 2026-09 紀錄會污染 9 月的手算值）
    for (const col of ['substituteRecords', 'pendingRequests']) {
        for (const d of (await listDocs(`schools/${SCHOOL}/${col}`)).docs) {
            await deleteDoc(`schools/${SCHOOL}/${col}/${d.id}/private/detail`);
            await deleteDoc(`schools/${SCHOOL}/${col}/${d.id}`);
        }
    }

    // 2) 已成立紀錄（含範圍外的）
    const mkRecord = (r) => {
        const o = GOLDEN_NAME[r.orig], s = GOLDEN_NAME[r.sub];
        const recordId = `rec_gold_${r.id}`;
        return {
            recordId,
            pub: {
                id: recordId, type: r.type, date: r.date, weekday: '週一', period: '第一節',
                className: '7年1班', subject: '數學', domain: '數學領域',
                originalTeacher: o, originalTeacherId: idOf(o),
                substituteTeacher: s, substituteTeacherId: idOf(s),
                docNumber: ['公假', '長期病假', '喪假'].includes(r.leave) ? '府教字第1號' : '',
                semesterId: SEMESTER, isSelfSwap: false,
                approvedBy: chief.id, approvedByName: chief.name,
                approvedAt: `${r.date}T10:00:00.000Z`, createdAt: `${r.date}T08:00:00.000Z`,
            },
            priv: {
                leaveType: r.leave, leaveTypeName: r.leave, reason: `黃金資料 ${r.id}`,
                allowedTeacherIds: [idOf(o), idOf(s), chief.id].filter(Boolean),
            },
        };
    };
    for (const r of [...GOLDEN_RECORDS, GOLDEN_DELETED]) {
        const m = mkRecord(r);
        await mustSetDoc(`schools/${SCHOOL}/substituteRecords/${m.recordId}`, m.pub);
        await mustSetDoc(`schools/${SCHOOL}/substituteRecords/${m.recordId}/private/detail`, m.priv);
    }
    // 3) 「已刪除」：寫入後真的把文件刪掉（含私有明細），結算不該再看到它
    const del = `rec_gold_${GOLDEN_DELETED.id}`;
    await deleteDoc(`schools/${SCHOOL}/substituteRecords/${del}/private/detail`);
    await deleteDoc(`schools/${SCHOOL}/substituteRecords/${del}`);

    // 4) 「駁回」：只存在於 pendingRequests，狀態 rejected，不會進入已成立紀錄
    const rj = GOLDEN_REJECTED, ro = GOLDEN_NAME[rj.orig], rs = GOLDEN_NAME[rj.sub];
    const reqId = `req_gold_${rj.id}`;
    await mustSetDoc(`schools/${SCHOOL}/pendingRequests/${reqId}`, {
        reqId, type: '代課', requestType: 'substitute', status: 'rejected', date: rj.date,
        weekday: '週三', period: '第一節', className: '7年1班', subject: '數學', domain: '數學領域',
        originalTeacher: ro, originalTeacherId: idOf(ro), substituteTeacher: rs, substituteTeacherId: idOf(rs),
        semesterId: SEMESTER, requiredApproverId: chief.id, initiatedBy: idOf(ro), initiatedByName: ro,
        createdAt: `${rj.date}T07:30:00.000Z`, rejectedBy: chief.id, rejectedByName: chief.name,
    });
    await mustSetDoc(`schools/${SCHOOL}/pendingRequests/${reqId}/private/detail`, {
        leaveType: rj.leave, leaveTypeName: rj.leave, reason: '黃金資料：被駁回',
        allowedTeacherIds: [idOf(ro), idOf(rs), chief.id].filter(Boolean),
    });
    return { reqId, delId: del };
}

/** 產生報表並讀回表格：{ 姓名: { original, sub, subbed, actual, overtime, changed } }。 */
async function generateAndRead(page, year, month) {
    await gotoTab(page, 'settlement', 1500);
    await page.selectOption('#settle-year', String(year));
    await page.selectOption('#settle-month', String(month));
    // 先清空舊表格：查詢失敗時 app 不會重繪表格（app.js generateSettlement 的 catch 不清表），
    // 不清的話上一次的表格會讓等待立刻滿足、讀到舊資料。
    await page.evaluate(() => { document.getElementById('settlement-tbody').innerHTML = ''; });
    await page.click('#generate-settlement-btn');
    // 等新表格出現，且產生按鈕已解除 disabled（代表這次查詢已結束）
    await page.waitForFunction(() => {
        const btn = document.getElementById('generate-settlement-btn');
        return btn && !btn.disabled && document.querySelector('#settlement-tbody tr[data-has-change]');
    }, null, { timeout: 90000 });
    return page.evaluate(() => {
        const num = (t) => (t.trim() === '-' ? 0 : Number(t.trim().replace('+', '')));
        const out = {};
        document.querySelectorAll('#settlement-tbody tr[data-has-change]').forEach(tr => {
            const c = [...tr.querySelectorAll('td')].map(td => td.innerText);
            out[c[0].trim()] = {
                original: num(c[1]), sub: num(c[2]), subbed: Math.abs(num(c[3])),
                actual: num(c[4]), overtime: num(c[5]),
                raw: c.map(x => x.trim()),
            };
        });
        return { rows: out, changed: document.getElementById('changed-count')?.innerText.trim() };
    });
}

export async function run(browser) {
    const suite = new Suite('操作 6：月結算畫面數字（手算黃金資料）');
    await seedAll({ quiet: true });
    const { reqId, delId } = await installGoldenWorld();

    const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
    try {
        await suite.case('前提：駁回的請求只在 pendingRequests、已刪除的紀錄文件確實不存在', async () => {
            eq((await getDoc(`schools/${SCHOOL}/pendingRequests/${reqId}`)).data?.status, 'rejected', '駁回請求的狀態');
            eq((await getDoc(`schools/${SCHOOL}/substituteRecords/${delId}`)).status, 404, '已刪除紀錄應為 404');
            const recs = (await listDocs(`schools/${SCHOOL}/substituteRecords`)).docs
                .filter(d => d.id.startsWith('rec_gold_'));
            eq(recs.length, GOLDEN_RECORDS.length, '已成立的黃金紀錄筆數（含 3 筆範圍外，不含刪除那筆）');
        });

        await suite.case('課表已換成黃金課表（五位教師、每週節數 6/5/3/21/20）', async () => {
            const weekly = await page.evaluate(() => {
                const sd = window.app?.dataManager?.scheduleData || [];
                const m = {};
                sd.forEach(r => { m[r.teacher] = (m[r.teacher] || 0) + 1; });
                return m;
            });
            eq(weekly, { '林彥廷': 6, '王大明': 5, '張淑芬': 3, '黃志偉': 21, '吳佩珊': 20 }, '課表節數');
        });

        await suite.case('115 學年度 10 月：畫面五位教師各欄位等於手算值', async () => {
            const { rows, changed } = await generateAndRead(page, 115, 10);
            eq(Object.keys(rows).sort(), Object.keys(GOLDEN_EXPECTED_2026_10).sort(), '畫面列出的教師');
            for (const [name, e] of Object.entries(GOLDEN_EXPECTED_2026_10)) {
                const g = rows[name];
                eq({ original: g.original, sub: g.sub, subbed: g.subbed, actual: g.actual, overtime: g.overtime },
                   { original: e.originalHours, sub: e.substituteHours, subbed: e.substitutedHours,
                     actual: e.actualHours, overtime: e.overtimeHours },
                   `${name} 的畫面列（${g.raw.join(' | ')}）`);
            }
            // 手算：有變動者 = A（被代 4）、B（代 3）、C（代 5 被代 1）、E（代 1）；D 只被代公付假別 → 無變動
            eq(changed, '共 4 位教師有變動', '「有變動」計數');
            await shot(page, '06-settlement-golden-115-10');
            eq(realErrors(page), [], '過程不應有 console 錯誤');
        });

        await suite.case('畫面列順序：依實際時數由大到小（黃志偉 84、吳佩珊 81、王大明 23、林彥廷 20、張淑芬 16）', async () => {
            const names = await page.evaluate(() =>
                [...document.querySelectorAll('#settlement-tbody tr[data-has-change]')].map(tr => tr.querySelector('td').innerText.trim()));
            eq(names, ['黃志偉', '吳佩珊', '王大明', '林彥廷', '張淑芬'], '列順序');
        });

        await suite.case('相鄰月份：9 月與 11 月各只吃到一筆跨月紀錄（期望值互不相同），不受 10 月紀錄影響', async () => {
            // 三次查詢的期望值刻意互不相同，讀到前一次的舊表格必定失敗。
            // 手算：9 月只有 x01（9/30，A 事假被 B 代）→ A 24−1=23、B 20+1=21；C、D、E 不變 12/84/80
            const sep = (await generateAndRead(page, 115, 9)).rows;
            eq([sep['林彥廷'].actual, sep['王大明'].actual, sep['張淑芬'].actual, sep['黃志偉'].actual, sep['吳佩珊'].actual],
               [23, 21, 12, 84, 80], '9 月');
            // 11 月：只有 x02（11/2，B 事假被 C 代）→ B 20−1=19、C 12+1=13；A 不變 24
            const nov = (await generateAndRead(page, 115, 11)).rows;
            eq([nov['林彥廷'].actual, nov['王大明'].actual, nov['張淑芬'].actual], [24, 19, 13], '11 月');
            // 114 學年度 10 月（2025-10）：只有 x03（2025-10-06，C 事假被 A 代）→ A 24+1=25、C 12−1=11；B 不變 20
            const prev = (await generateAndRead(page, 114, 10)).rows;
            eq([prev['林彥廷'].actual, prev['王大明'].actual, prev['張淑芬'].actual], [25, 20, 11], '114 學年度 10 月');
            eq(realErrors(page), [], '相鄰月份查詢過程不應有 console 錯誤');
        });

        await suite.case('再回到 115 學年度 10 月：結果與第一次相同（查詢快取不污染）', async () => {
            const { rows } = await generateAndRead(page, 115, 10);
            for (const [name, e] of Object.entries(GOLDEN_EXPECTED_2026_10)) {
                eq(rows[name].actual, e.actualHours, `${name} 實際時數`);
            }
        });
    } finally {
        await page.close();
    }
    return suite;
}
