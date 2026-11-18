/**
 * P9 批次 C：備份還原「流程」的行為測試（直接執行 backupController.runRestoreFlow，假 Firebase SDK、對話框替身，純 node 離線）
 * 執行：node test/test-p9c-restore-flow.mjs
 *
 * 涵蓋：
 *   PL-10b  預覽之後目前學期變了 → 中止、沒有任何寫入（刪掉這個判斷，這裡的案例會失敗）
 *   PL-10d  唯一差異是「比雲端舊的月結算設定」：確認鈕預設停用、勾選後才可按；勾選才寫入、不勾選不寫入
 */
import { register } from 'node:module';
register('./helpers/restore-flow-loader.mjs', import.meta.url);

globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '', reload() {} };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = {
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({ click() {}, set href(v) {}, set download(v) {} }),
    body: { appendChild() {}, removeChild() {} },
};
const F = (globalThis.__fake = { docs: new Map(), writes: [] });
globalThis.__rd = { calls: [], handler: async () => true };

const ctl = await import('../src/js/modules/v2/backupController.js');
const fmt = await import('../src/js/modules/v2/backupFormat.js');
const svc = await import('../src/js/modules/v2/backupService.js');
const roleSvc = await import('../src/js/modules/v2/roleService.js');
const semesterState = await import('../src/js/modules/v2/semesterState.js');
const { setActiveSchoolId } = await import('../src/js/modules/v2/schemaConstants.js');
const { isConfirmEnabled } = await import('../src/js/modules/richDialog.js');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) pass++; else fail++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}
const origLog = console.log, origWarn = console.warn, origErr = console.error;
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.log = origLog; console.warn = origWarn; console.error = origErr; };

setActiveSchoolId('t');
semesterState.setCurrentSemesterId('115-1');
roleSvc.setCurrentIdentity({ uid: 'u', email: 'e@example.edu.tw', teacherId: 'tch_1', name: '主任', role: 'director' });
const P = 'schools/t';
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-06-01T00:00:00.000Z';

const seedCloud = () => {
    F.docs.clear(); F.writes.length = 0; globalThis.__rd.calls.length = 0;
    F.docs.set(`${P}/config/main`, { currentSemester: '115-1', schoolName: 'T' });
    F.docs.set(`${P}/config/settlement`, { calendarId: 'cloud', calendarApiKey: 'k', weeksByYear: {}, updatedAt: T1, updatedBy: 'u' });
    F.docs.set(`${P}/teachers/tch_1`, { name: '主任', email: 'a@example.edu.tw', role: 'director', domains: [], homeroomClass: '', createdAt: T0, updatedAt: T0 });
    F.docs.set(`${P}/teachers/tch_2`, { name: '李老師', email: null, role: 'teacher', domains: [], homeroomClass: '', createdAt: T0, updatedAt: T0 });
};
/** 以目前雲端內容組一份備份檔（模擬「先匯出，之後雲端又有變動」） */
const backupFromCloud = async (mutate) => {
    const sections = await svc.collectCloudBackupSections({ includeDetails: true });
    if (mutate) mutate(sections);
    const b = await fmt.buildBackupFile({ schoolId: 't', exportedAt: T1, currentSemester: '115-1', sections });
    return fmt.serializeBackup(b);
};
const fileOf = (text) => ({ name: 'b.json', size: text.length, text: async () => text });
const mkApp = () => { const dialogs = []; return { dialogs, confirmDialog: async (o) => { dialogs.push(o); return true; } }; };
const wroteTo = (re) => F.writes.some(w => re.test(w.path));

/* ===== PL-10b：預覽後學期變動 → 中止 ===== */
{
    quiet();
    seedCloud();
    const text = await backupFromCloud();
    F.docs.delete(`${P}/teachers/tch_2`);          // 雲端缺一位教師 → 計畫有可還原的內容（預覽的確認鈕可按）
    F.writes.length = 0;
    // 使用者在預覽對話框停留期間，別台裝置把目前學期切到 115-2
    globalThis.__rd.handler = async () => { F.docs.set(`${P}/config/main`, { currentSemester: '115-2', schoolName: 'T' }); return true; };
    const app = mkApp();
    await ctl.runRestoreFlow(app, fileOf(text), () => {});
    loud();
    check('PL-10b：學期在預覽後改變 → 彈出「還原已中止」並說明新舊學期', app.dialogs.some(d => d.title === '還原已中止' && /115-1/.test(d.message) && /115-2/.test(d.message)), JSON.stringify(app.dialogs.map(d => d.title)));
    check('PL-10b：中止時沒有任何資料寫入（教師、設定、課表、紀錄）', !wroteTo(/\/teachers\//) && !wroteTo(/\/config\//) && !wroteTo(/\/schedules\//) && !wroteTo(/\/substituteRecords\//), JSON.stringify(F.writes.map(w => w.path)));
    check('PL-10b：不會跳出「還原完成」對話框', globalThis.__rd.calls.length === 1, String(globalThis.__rd.calls.length));

    // 對照組：學期沒變 → 正常還原（排除「測試永遠中止」的假陽性）
    quiet();
    seedCloud();
    const text2 = await backupFromCloud();
    F.docs.delete(`${P}/teachers/tch_2`); F.writes.length = 0;
    globalThis.__rd.handler = async () => true;
    const app2 = mkApp();
    await ctl.runRestoreFlow(app2, fileOf(text2), () => {});
    loud();
    check('PL-10b 對照：學期沒變 → 教師被補回、不中止', wroteTo(/\/teachers\/tch_2$/) && !app2.dialogs.some(d => d.title === '還原已中止'), JSON.stringify(app2.dialogs.map(d => d.title)));
}

/* ===== PL-10d：唯一差異是較舊的月結算設定 ===== */
{
    const olderBackup = async () => {
        seedCloud();   // 雲端 settlement = cloud（T1，較新）
        return backupFromCloud((sec) => { sec.config.settlement = { calendarId: 'backup', calendarApiKey: 'k', weeksByYear: {}, updatedAt: T0, updatedBy: 'u' }; });
    };

    // 未勾選：確認鈕停用 → 使用者無法開始還原 → 不寫入
    quiet();
    let text = await olderBackup();
    F.writes.length = 0;
    let args = null;
    globalThis.__rd.handler = async (a) => {
        if (!a.extraOptions) return false;
        args = a;
        return isConfirmEnabled({ confirmDisabled: a.confirmDisabled, extraOptions: a.extraOptions });   // 不勾選就嘗試確認
    };
    let app = mkApp();
    await ctl.runRestoreFlow(app, fileOf(text), () => {});
    loud();
    check('PL-10d：唯一差異是較舊設定時預覽有勾選項，且勾選項會解除確認鈕', !!args && args.extraOptions.length === 1 && args.extraOptions[0].enablesConfirm === true);
    check('PL-10d：預覽文字不再說「沒有任何需要還原的項目」，而是說明唯一差異是月結算設定', !/沒有任何需要還原的項目/.test(args.bodyHtml) && /月結算設定/.test(args.bodyHtml));
    check('PL-10d：預設（未勾選）確認鈕是停用的', isConfirmEnabled({ confirmDisabled: args.confirmDisabled, extraOptions: [{ ...args.extraOptions[0], ref: { checked: false } }] }) === false);
    check('PL-10d：未勾選 → 月結算設定不寫入、雲端維持原值', !wroteTo(/\/config\/settlement$/) && F.docs.get(`${P}/config/settlement`).calendarId === 'cloud', JSON.stringify(F.writes.map(w => w.path)));

    // 勾選：確認鈕可按 → 覆寫
    quiet();
    text = await olderBackup(); F.writes.length = 0;
    globalThis.__rd.handler = async (a) => {
        if (!a.extraOptions) return false;                    // 第二個對話框＝還原結果
        const before = isConfirmEnabled({ confirmDisabled: a.confirmDisabled, extraOptions: a.extraOptions });
        a.extraOptions[0].ref.checked = true;                 // 使用者勾選
        const after = isConfirmEnabled({ confirmDisabled: a.confirmDisabled, extraOptions: a.extraOptions });
        globalThis.__rdTrace = { before, after };
        return after;
    };
    app = mkApp();
    await ctl.runRestoreFlow(app, fileOf(text), () => {});
    loud();
    check('PL-10d：勾選前確認鈕停用、勾選後可按', globalThis.__rdTrace.before === false && globalThis.__rdTrace.after === true, JSON.stringify(globalThis.__rdTrace));
    check('PL-10d：勾選後 → 月結算設定被備份檔的設定覆寫', F.docs.get(`${P}/config/settlement`).calendarId === 'backup', JSON.stringify(F.docs.get(`${P}/config/settlement`)));
}

/* ===== isConfirmEnabled 純函式 ===== */
{
    const on = { enablesConfirm: true, ref: { checked: true } }, off = { enablesConfirm: true, ref: { checked: false } };
    check('isConfirmEnabled：confirmDisabled 且沒有解除項 → 停用', isConfirmEnabled({ confirmDisabled: true }) === false);
    check('isConfirmEnabled：confirmDisabled 且解除項未勾 → 停用', isConfirmEnabled({ confirmDisabled: true, extraOptions: [off] }) === false);
    check('isConfirmEnabled：confirmDisabled 且解除項已勾 → 可按', isConfirmEnabled({ confirmDisabled: true, extraOptions: [on] }) === true);
    check('isConfirmEnabled：解除項已勾但確認字樣沒輸入 → 仍停用（其他條件照舊）', isConfirmEnabled({ confirmDisabled: true, extraOptions: [on], phraseOk: false }) === false);
    check('isConfirmEnabled：一般選項（沒有 enablesConfirm）勾選不解除', isConfirmEnabled({ confirmDisabled: true, extraOptions: [{ ref: { checked: true } }] }) === false);
    check('isConfirmEnabled：沒有 confirmDisabled 時行為不變', isConfirmEnabled({}) === true && isConfirmEnabled({ ackOk: false }) === false);
}

console.log(`\n結果：通過 ${pass}，失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
