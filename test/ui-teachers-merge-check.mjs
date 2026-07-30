/**
 * 教師管理頁「表格合併 + 即時自動儲存」驗收檢查
 *
 * 背景：教師管理頁原本同時有兩張欄位重疊的表——
 *   (a) V1 教師屬性表 `#teacher-editor-card`（姓名／領域／導師班級，app.js updateTeacherTable）
 *   (b) V2 教師帳號管理表 `#v2-teachers-admin`（姓名／Email／角色／領域，v2-app.js）
 * 本次改為：V2 模式下 (a) 以 `.v1-only` 隱藏，(b) 擴充為含課表屬性的單一合併表，
 * 且所有欄位改為 change 即存（不再有每列一顆「儲存」按鈕）。
 *
 * 這支腳本能自動驗的範圍與界線：
 *   ✓ 純 V1 模式：教師屬性表仍顯示、編輯仍即時寫入 dataManager + localStorage（無回歸）
 *   ✓ V2 模式：`.v1-only` 隱藏規則生效 → 頁上不再有兩張重複的教師表
 *   ✓ V2 模式：patchDataManager 對 updateTeacher/addTeacher/removeTeacher 的新包裝
 *     未破壞原本的同步寫值行為（未登入時 queueScheduleSync 應直接 return，不拋錯）
 *   ✓ 手機 375 寬度下教師管理頁無橫向溢出（合併表在 V1 側對應的是既有表格）
 *   ✗ 合併表本身的渲染與逐欄即時儲存：需要真實 Google/Email 登入取得 approver 身份才會
 *     渲染（renderTeachersAdminTab 走 Firestore），無法在此自動化 —— 須人工登入 preview 站驗證
 *
 * 前置：先啟動本機伺服器（預設 http://localhost:8000）：
 *   uv run python -m http.server 8000
 *
 * 用法：node test/ui-teachers-merge-check.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = 'http://localhost:8000/';
const CSV_PATH  = path.join(__dirname, 'test-data.csv');

const results = [];
function check(label, pass, detail = '') {
    results.push({ label, pass, detail });
    console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? `　（${detail}）` : ''}`);
    return pass;
}

/** 載入測試課表並設定學校名稱，讓教師表有內容、頁籤解鎖 */
async function seedSchedule(page) {
    await page.setInputFiles('#schedule-file', CSV_PATH);
    await page.waitForSelector('#schedule-status:not(.hidden)', { timeout: 8000 });
    await page.fill('#school-name', '測試國中');
    await page.click('#save-school-name-btn');
    await page.waitForTimeout(400);
}

(async () => {
    const browser = await chromium.launch();

    /* ===== 情境一：純 V1 單機模式（無 ?v2=1） ===== */
    console.log('\n=== 情境一：純 V1 單機模式（教師屬性表應維持原行為） ===');
    {
        const ctx  = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
        page.on('console', m => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

        await page.goto(BASE_URL, { waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await seedSchedule(page);

        await page.click('.tab-btn[data-tab="teachers"]');
        await page.waitForTimeout(400);

        const v1Visible = await page.evaluate(() => {
            const el = document.getElementById('teacher-editor-card');
            return !!el && getComputedStyle(el).display !== 'none';
        });
        check('V1 教師屬性表可見', v1Visible);

        const rowCount = await page.evaluate(() =>
            document.querySelectorAll('#teacher-tbody tr').length);
        check('教師屬性表有渲染教師列', rowCount > 0, `${rowCount} 列`);

        // 領域欄位編輯 → 即時寫入 dataManager 與 localStorage（原有的「變更即時自動儲存」）
        const autoSaved = await page.evaluate(async () => {
            const input = document.querySelector('#teacher-tbody input[data-field="domains"]');
            if (!input) return { ok: false, reason: '找不到領域輸入欄' };
            const idx = Number(input.dataset.index);
            input.value = '國文, 英語';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 300));
            const inMemory = window.app.dataManager.getTeachers()[idx]?.domains || [];
            const raw = localStorage.getItem('substituteSystemData');
            const persisted = raw ? (JSON.parse(raw).teachers?.[idx]?.domains || []) : [];
            return {
                ok: inMemory.join(',') === '國文,英語' && persisted.join(',') === '國文,英語',
                inMemory, persisted,
            };
        });
        check('領域欄位 change 即時寫入 dataManager 與 localStorage', autoSaved.ok,
            `記憶體=[${autoSaved.inMemory}] localStorage=[${autoSaved.persisted}]`);

        // 手機寬度下不得橫向溢出
        await page.setViewportSize({ width: 375, height: 667 });
        await page.waitForTimeout(400);
        const m = await page.evaluate(() => ({
            sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check('375 寬度下教師管理頁無橫向溢出', m.sw <= m.iw, `scrollWidth=${m.sw} / innerWidth=${m.iw}`);

        check('無 page/console 錯誤', errs.length === 0, errs.join(' | ') || '無');
        await ctx.close();
    }

    /* ===== 情境二：V2 模式（?v2=1，未登入） ===== */
    console.log('\n=== 情境二：V2 模式（重複的 V1 教師屬性表應被隱藏） ===');
    {
        const ctx  = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
        page.on('console', m => { if (m.type() === 'error') errs.push(`console: ${m.text()}`); });

        await page.goto(BASE_URL + '?v2=1', { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);   // 等 v2-app.js bootstrap 注入樣式 + 加 body.v2-active

        const v2Active = await page.evaluate(() => document.body.classList.contains('v2-active'));
        check('body 已標記 v2-active（V2 模式生效）', v2Active);

        // 注入課表資料：讓後續 patch 驗證跑在「本機有課表」的真實狀態下（requireSchedule 守門
        // 會通過，一路走到 roleSvc.isApprover() 才因未登入 return，涵蓋的路徑比空課表版本更長）。
        // 這裡不走 UI 上傳——V2 未登入時整個 app 被 v2-locked 遮罩 + inert 鎖住（防未登入操作），
        // #schedule-file 點不到，故直接呼叫 dataManager（setScheduleData 本身也在受測的 patch 內）。
        await page.evaluate(() => {
            const dm = window.app.dataManager;
            dm.setTeachers([{ name: '王大明', domains: ['國文'], homeroomClass: '701' }]);
            dm.setScheduleData([
                { teacher: '王大明', className: '701', subject: '國文', weekday: '週一', period: '第一節' },
            ]);
        });
        await page.waitForTimeout(300);

        const hidden = await page.evaluate(() => {
            const el = document.getElementById('teacher-editor-card');
            return {
                exists: !!el,
                display: el ? getComputedStyle(el).display : null,
                hasClass: el ? el.classList.contains('v1-only') : false,
            };
        });
        check('V1 教師屬性表帶 .v1-only 且被隱藏', hidden.hasClass && hidden.display === 'none',
            `class=${hidden.hasClass} display=${hidden.display}`);

        // 教師管理頁上「可見的教師表格」數量必須 <= 1（未登入時 V2 表也不可見 → 0）
        const visibleTables = await page.evaluate(() => {
            const tab = document.getElementById('teachers-tab');
            if (!tab) return -1;
            return [...tab.querySelectorAll('table')]
                .filter(t => t.offsetParent !== null).length;
        });
        check('教師管理頁不再同時出現兩張教師表', visibleTables <= 1, `可見表格數=${visibleTables}`);

        // patchDataManager 新包裝的 updateTeacher/addTeacher/removeTeacher 不得破壞同步寫值。
        // 未登入 → roleSvc.isApprover() 為 false → queueScheduleSync 直接 return（不觸發 Firestore）
        const patchOk = await page.evaluate(async () => {
            const dm = window.app?.dataManager;
            if (!dm) return { ok: false, reason: '無 dataManager' };
            const before = dm.getTeachers().length;
            dm.addTeacher({ name: '__patch測試教師', domains: [], homeroomClass: '' });
            const idx = dm.getTeachers().findIndex(t => t.name === '__patch測試教師');
            dm.updateTeacher(idx, 'domains', ['數學']);
            const afterUpdate = dm.getTeachers()[idx]?.domains?.join(',');
            dm.removeTeacher(idx);
            const after = dm.getTeachers().length;
            await new Promise(r => setTimeout(r, 300));   // 讓 queueMicrotask 有機會執行
            return { ok: afterUpdate === '數學' && after === before, afterUpdate, before, after };
        });
        check('patch 後 addTeacher/updateTeacher/removeTeacher 行為不變', patchOk.ok,
            `updateTeacher 寫入=[${patchOk.afterUpdate}] 教師數 ${patchOk.before}→${patchOk.after}`);

        check('無 page/console 錯誤', errs.length === 0, errs.join(' | ') || '無');
        await ctx.close();
    }

    await browser.close();

    console.log('\n=== 結果彙總 ===');
    const failed = results.filter(r => !r.pass);
    results.forEach(r => console.log(`${r.pass ? '通過' : '失敗'} - ${r.label}`));
    console.log(`\n通過 ${results.length - failed.length}／失敗 ${failed.length}`);

    console.log('\n⚠ 無法自動驗證（需人工登入 preview 站以 approver 身份確認）：');
    console.log('  1. 合併表渲染出 6 欄：姓名／Email／角色／任教領域／導師班級／操作');
    console.log('  2. 逐欄 change 即存：改 Email／角色／領域／導師班級後不需按任何按鈕，欄位閃示 ✓');
    console.log('  3. 領域／導師班級改動後回寫全校課表 doc（其他裝置的教師端會收到新的 teachers 快照）');
    console.log('  4. 組長身份：可編輯領域／導師班級，Email／角色為唯讀（disabled）、無新增/刪除鈕');

    if (failed.length) process.exit(1);
})().catch(err => {
    console.error('\n❌ 測試腳本執行錯誤:', err.message);
    process.exit(1);
});
