/**
 * 全流程操作 9：雲端完整備份與還原（設定頁「資料管理」）
 *
 * 開頭自行 seed（不依賴前面 suite 的狀態；04 會把紀錄清空），所以排在 04 之後。
 * 會刪除幾筆紀錄再用備份還原，是破壞性操作，放在清單最後。
 *
 *   1. 角色可見性：一般教師看不到備份卡；組長有匯出、沒有還原；主任兩者皆有
 *   2. 主任匯出：下載檔是雲端備份格式、筆數與雲端一致、含 private/detail 與兩個學期
 *   3. 還原的拒絕路徑：V1 本機舊格式檔（引導到 V1 資料遷移，不顯示成功）、別校的備份檔
 *   4. 還原：刪掉兩筆紀錄 → 選備份檔 → 預覽（含「不會還原」清單）→ 輸入確認字樣 → 還原前自動備份下載 → 兩筆紀錄回來
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

import { ACCOUNTS, loginStable, gotoTab, shot, bodyText, waitForText } from './helpers.mjs';
import { seedAll } from '../emulator/seed.mjs';
import { listDocs, deleteDoc, getDoc } from '../emulator/emu-client.mjs';
import { Suite, eq, ok, includes } from '../scenarios/harness.mjs';

const SCHOOL = 'demo-alpha';
// 本機 emulator 讀取 schedules 集合的第一次查詢實測可達 60～70 秒（其他集合約 25ms；見 README），
// 匯出／還原要多次分頁讀取，等待上限放寬到 7 分鐘。
const LONG = 420000;

async function cloudCounts() {
    const [records, pending] = await Promise.all([
        listDocs(`schools/${SCHOOL}/substituteRecords`),
        listDocs(`schools/${SCHOOL}/pendingRequests`),
    ]);
    return { records: (records.docs || []).length, pending: (pending.docs || []).length };
}

const visible = (page, sel) => page.evaluate((s) => {
    const e = document.querySelector(s);
    return !!(e && e.offsetParent !== null);
}, sel);

async function openSettings(page) {
    await gotoTab(page, 'settings', 2500);
    await page.waitForSelector('#v2-backup-admin .data-management-section', { timeout: 15000 }).catch(() => {});
}

async function clickConfirmDialogIfAny(page, which = 'cancel') {
    const id = which === 'confirm' ? '#confirm-modal-confirm-btn' : '#confirm-modal-cancel-btn';
    await page.waitForSelector(`${id}:visible`, { timeout: 10000 });
    await page.click(id);
    await page.waitForTimeout(500);
}

export async function run(browser) {
    const suite = new Suite('操作 9：雲端完整備份與還原');
    await seedAll({ quiet: true });

    /* ===================== 角色可見性 ===================== */

    await suite.case('一般教師看不到備份與還原；組長只有匯出；主任兩者皆有', async () => {
        const { page: tp } = await loginStable(browser, ACCOUNTS.teacherA);
        try {
            await gotoTab(tp, 'settings', 2000);
            eq(await visible(tp, '#v2-backup-export-btn'), false, '教師不應看到匯出');
            eq(await visible(tp, '#v2-backup-restore-btn'), false, '教師不應看到還原');
        } finally { await tp.close(); }

        const { page: cp } = await loginStable(browser, ACCOUNTS.sectionChief);
        try {
            await openSettings(cp);
            eq(await visible(cp, '#v2-backup-export-btn'), true, '組長應看到匯出');
            eq(await visible(cp, '#v2-backup-restore-btn'), false, '組長不應看到還原按鈕');
            includes(await bodyText(cp), '還原備份僅限教務主任', '組長應看到還原僅限主任的說明');
        } finally { await cp.close(); }
    });

    /* ===================== 主任：匯出、還原 ===================== */

    const { page } = await loginStable(browser, ACCOUNTS.director, { needSchedule: true });
    try {
        let exported = null;

        await suite.case('主任匯出：雲端備份格式、筆數與雲端一致、含 private/detail 與兩個學期', async () => {
            await openSettings(page);
            ok(await visible(page, '#v2-backup-restore-btn'), '主任應看到還原按鈕');
            const before = await cloudCounts();
            const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: LONG }),
                page.click('#v2-backup-export-btn'),
            ]);
            const name = download.suggestedFilename();
            includes(name, `STsystem_雲端備份_${SCHOOL}_`, '檔名');
            exported = readFileSync(await download.path(), 'utf8');
            const b = JSON.parse(exported);
            eq(b.format, 'stsystem-cloud-backup', 'format');
            eq(b.formatVersion, 1, 'formatVersion');
            eq(b.meta.schoolId, SCHOOL, 'schoolId');
            ok(b.meta.exportedBy && b.meta.exportedBy.email === ACCOUNTS.director, '匯出者');
            eq(b.meta.counts.substituteRecords, before.records, '紀錄筆數');
            eq(b.meta.counts.pendingRequests, before.pending, '待審筆數');
            ok(b.meta.counts.substituteRecordDetails > 0, '含 private/detail');
            ok(new Set(b.substituteRecords.map(r => r.data.semesterId)).size >= 2, '含至少兩個學期的紀錄');
            ok(b.schedules.length >= 2, '含各學期課表');
            await waitForText(page, /已匯出：/, LONG);
            await shot(page, '09-backup-exported');
        });

        await suite.case('還原：V1 本機舊格式檔被辨識並引導到 V1 資料遷移，不顯示成功', async () => {
            await openSettings(page);
            const v1 = JSON.stringify({ schoolName: 'X', scheduleData: [], teachers: [], classes: [], substituteRecords: [], settings: {} });
            await page.setInputFiles('#v2-backup-file', { name: 'v1-backup.json', mimeType: 'application/json', buffer: Buffer.from(v1) });
            await page.waitForSelector('#confirm-modal-message:visible', { timeout: 15000 });
            const msg = await page.innerText('#confirm-modal-message');
            includes(msg, '舊版（V1 本機模式）', '應說明這是舊版格式');
            includes(msg, 'V1 資料遷移', '應引導到 V1 資料遷移');
            ok(!/成功/.test(msg), '不可顯示成功');
            await clickConfirmDialogIfAny(page, 'cancel');
        });

        await suite.case('還原：別校的備份檔被拒絕', async () => {
            const other = JSON.parse(exported);
            other.meta.schoolId = 'demo-beta';
            await page.setInputFiles('#v2-backup-file', { name: 'other-school.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(other)) });
            await page.waitForSelector('#confirm-modal-message:visible', { timeout: 15000 });
            const msg = await page.innerText('#confirm-modal-message');
            includes(msg, 'demo-beta', '應點名來源學校');
            includes(msg, '已拒絕還原', '應拒絕');
            await clickConfirmDialogIfAny(page, 'cancel');
        });

        await suite.case('還原：刪掉兩筆紀錄後，以備份還原（預覽 → 確認字樣 → 還原前自動備份 → 紀錄回來）', async () => {
            const list = await listDocs(`schools/${SCHOOL}/substituteRecords`);
            // 用文件名稱取 id（資料內可能有同名的 id 欄位，listDocs 攤平後會被蓋掉）
            const cur = (list.raw?.documents || [])
                .map(d => ({ id: d.name.split('/').pop(), semesterId: d.fields?.semesterId?.stringValue }))
                .filter(d => d.semesterId === '115-1').slice(0, 2);
            ok(cur.length === 2, '前置：目前學期至少兩筆紀錄');
            const before = await cloudCounts();
            for (const r of cur) {
                await deleteDoc(`schools/${SCHOOL}/substituteRecords/${r.id}/private/detail`);
                await deleteDoc(`schools/${SCHOOL}/substituteRecords/${r.id}`);
            }
            eq((await cloudCounts()).records, before.records - 2, '前置：已刪兩筆');

            await openSettings(page);
            await page.setInputFiles('#v2-backup-file', { name: 'full-backup.json', mimeType: 'application/json', buffer: Buffer.from(exported) });
            await page.waitForSelector('.rich-dialog-content', { timeout: LONG });
            const preview = await page.innerText('.rich-dialog-content');
            includes(preview, `還原到學校：${SCHOOL}`, '預覽應顯示目標學校');
            includes(preview, '與目前學校相同', '預覽應顯示來源學校與目前相同');
            includes(preview, '調代課紀錄', '預覽應列出各集合筆數');
            includes(preview, '不會還原的項目', '預覽應列出不會還原的項目');
            // 預覽只列「這份備份實際遇到」的限制：種子資料的歷史學期課表與雲端相同、紀錄都屬目前學期，所以不會出現歷史學期項目；
            // 一定會出現的是「基本設定不覆寫」與「日誌／登入綁定不在備份範圍」，待審申請在表格中標示不還原。
            includes(preview, '雲端已有設定，不覆寫', '不會還原清單應說明基本設定不覆寫');
            includes(preview, '操作日誌', '不會還原清單應說明操作日誌不在備份範圍');
            includes(preview, '不還原（暫態資料）', '表格應標示待審申請不還原');
            await shot(page, '09-restore-preview');

            // 沒輸入確認字樣前，「開始還原」不可按
            eq(await page.isDisabled('.rich-dialog-content [data-rd="confirm"]'), true, '未輸入確認字樣時確認鈕應停用');
            await page.fill('.rich-dialog-content [data-rd="phrase"]', `還原 ${SCHOOL}`);
            eq(await page.isDisabled('.rich-dialog-content [data-rd="confirm"]'), false, '輸入確認字樣後確認鈕才可按');

            const [preDownload] = await Promise.all([
                page.waitForEvent('download', { timeout: LONG }),
                page.click('.rich-dialog-content [data-rd="confirm"]'),
            ]);
            includes(preDownload.suggestedFilename(), '_還原前', '還原前應先下載目前狀態的備份');

            const done = await waitForText(page, /還原完成|還原未全部完成/, LONG);
            ok(done, '應顯示還原結果');
            const report = await page.innerText('.rich-dialog-content');
            includes(report, '調代課紀錄：已還原 2 項', '報告應列出還原了 2 筆紀錄');
            await shot(page, '09-restore-done');
            await page.click('.rich-dialog-content [data-rd="cancel"]');   // 稍後再說（不 reload）

            eq((await cloudCounts()).records, before.records, '還原後紀錄筆數回到原本');
            for (const r of cur) {
                ok((await getDoc(`schools/${SCHOOL}/substituteRecords/${r.id}`)).ok, `紀錄 ${r.id} 已還原`);
            }
        });
    } finally {
        await page.close();
    }

    return suite;
}
