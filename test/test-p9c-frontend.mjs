/**
 * P9 第二批 C：前端流程與設定的低風險待辦回歸測試（純 node、離線）
 * 執行：node test/test-p9c-frontend.mjs
 *
 * 涵蓋：SF-V1、SF-L5、SF-L6、SF-I4、LC-M5（含同名多筆需人工確認）、LC-M6（app.js）、LC-L4、LC-L13、
 *       PL-03、PL-10a/b/c/d、PL-18、PL-20、PL-21、PL-23、PL-24。
 * 瀏覽器行為（PL-18 實際畫面）另由 e2e 驗證；這裡用「抽出方法原始碼＋假物件」直接執行真實程式。
 */
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/gstatic-stub-loader.mjs', import.meta.url);
globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const F = (globalThis.__fake = { docs: new Map(), writes: [] });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) pass++; else fail++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}
const eq = (a, b, name) => check(name, JSON.stringify(a) === JSON.stringify(b), `預期 ${JSON.stringify(b)}，實得 ${JSON.stringify(a)}`);

const app = read('src/js/app.js');

/** 從原始碼抽出 class 方法（含大括號配對），回傳 { header, body, src } */
function extractMethod(source, name) {
    const re = new RegExp(`^    (async )?${name}\\(([^)]*)\\) \\{$`, 'm');
    const m = re.exec(source);
    if (!m) throw new Error(`找不到方法 ${name}`);
    let depth = 0, i = m.index + m[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    return { isAsync: !!m[1], args: m[2], body: source.slice(start, i + 1), src: source.slice(m.index, i + 1) };
}
/** 用假環境執行真實方法：extraScope 的鍵成為方法內可見的自由變數 */
function buildMethod(name, scope) {
    const mm = extractMethod(app, name);
    const keys = Object.keys(scope);
    const factory = new Function(...keys, `return (${mm.isAsync ? 'async ' : ''}function(${mm.args}) ${mm.body});`);
    return factory(...keys.map(k => scope[k]));
}

/* ===== SF-V1：V2 不觸發 V1 個人雲端同步 ===== */
{
    const mkDm = (log) => new Proxy({}, { get: (_t, prop) => (...a) => { log.push(String(prop)); return Promise.resolve({}); } });
    for (const [label, v2] of [['V2', true], ['V1', false]]) {
        const log = [];
        const doc = { getElementById: () => ({ classList: { add() { log.push('dom'); }, remove() { log.push('dom'); } }, querySelector: () => null, addEventListener() {}, set src(v) {}, set textContent(v) {} }) };
        const ctx = {
            dataManager: mkDm(log),
            updateSyncStatusSection() { log.push('updateSync'); },
            checkAndHandleSync() { log.push('checkAndHandleSync'); },
        };
        const scope = { isV2Enabled: () => v2, isSignedIn: () => true, getUserInfo: () => ({}), document: doc };
        await buildMethod('onAuthStateChanged', scope).call(ctx, { uid: 'u' });
        await buildMethod('onAuthStateChanged', scope).call(ctx, null);
        const sync = [];
        const ctx2 = { dataManager: mkDm(sync), enableRealtimeSyncAndListen() {}, refreshUIAfterSync() {}, saveDataToStorage() {} };
        await buildMethod('checkAndHandleSync', scope).call(ctx2);
        if (v2) {
            check('SF-V1：V2 時 onAuthStateChanged（登入與登出）不動 dataManager／同步，只更新頁首顯示', log.filter(x => x !== 'dom').length === 0 && log.includes('dom'), log.join(','));
            check('SF-V1：V2 時 checkAndHandleSync 直接返回，不碰 dataManager', sync.length === 0, sync.join(','));
        } else {
            check('SF-V1：V1 時 onAuthStateChanged 照舊（登入會呼叫 checkAndHandleSync、登出會停用即時同步）',
                log.includes('checkAndHandleSync') && log.includes('disableRealtimeSync'), log.join(','));
            check('SF-V1：V1 時 checkAndHandleSync 照舊讀同步狀態', sync.includes('checkInitialSyncStatus'), sync.join(','));
        }
    }
}

/* ===== SF-L5：本機伺服器只綁 127.0.0.1 ===== */
{
    const py = read('start-server.py');
    check('SF-L5：start-server.py 綁 127.0.0.1', /TCPServer\(\("127\.0\.0\.1", PORT\)/.test(py));
    check('SF-L5：不再綁所有介面（空字串／0.0.0.0）', !/TCPServer\(\(""/.test(py) && !/0\.0\.0\.0/.test(py));
}

/* ===== SF-L6：console 不記錄 email 與 user 物件（靜態掃描 src/js） ===== */
{
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(path.join(ROOT, d))) {
        const p = `${d}/${f}`;
        if (fs.statSync(path.join(ROOT, p)).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
    } };
    walk('src/js');
    const hits = [];
    for (const f of files) {
        const text = read(f);
        const re = /console\.(log|info|warn|error|debug)\(/g;
        let m;
        while ((m = re.exec(text))) {
            let depth = 1, i = re.lastIndex;
            for (; i < text.length && depth > 0; i++) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; }
            const args = text.slice(re.lastIndex, i - 1).replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, '""');
            if (/\.email\b|\bemail\b|\b(user|currentUser|userInfo)\b(?!\s*[:?])/.test(args)) {
                hits.push(`${f}:${text.slice(0, m.index).split('\n').length} ${args.trim().slice(0, 60)}`);
            }
        }
    }
    check('SF-L6：src/js 內沒有 console 呼叫帶 email 或整個 user 物件', hits.length === 0, '\n  ' + hits.join('\n  '));
    check('SF-L6：authService 登入記錄不含 email', !/console\.log\([^)]*\.email/.test(read('src/js/modules/authService.js')));
}

/* ===== SF-I4：googleSheetsAPI.js 已刪除且無引用 ===== */
{
    check('SF-I4：googleSheetsAPI.js 已刪除', !fs.existsSync(path.join(ROOT, 'src/js/modules/googleSheetsAPI.js')));
    const refs = [];
    const walk = (d) => { for (const f of fs.readdirSync(path.join(ROOT, d))) {
        const p = `${d}/${f}`;
        if (f === 'node_modules' || f === '.git' || f === '.venv') continue;
        const st = fs.statSync(path.join(ROOT, p));
        if (st.isDirectory()) walk(p); else if (/\.(js|mjs|html|json)$/.test(f) && f !== 'test-p9c-frontend.mjs' && st.size < 3e6 && !p.startsWith('test-results')) {
            if (/googleSheetsAPI/i.test(fs.readFileSync(path.join(ROOT, p), 'utf8'))) refs.push(p);
        }
    } };
    for (const d of ['src', 'index.html'.includes('.') ? 'test' : '', 'scripts']) if (d) walk(d);
    check('SF-I4：src／test／scripts 沒有任何 googleSheetsAPI 引用', refs.length === 0, refs.join(', '));
    check('SF-I4：index.html 沒有引用', !/googleSheetsAPI/.test(read('index.html')));
}

/* ===== LC-M5：teacherMerge（已在 B 批接上，驗證接線＋同名多筆需人工確認） ===== */
{
    const tm = await import('../src/js/modules/teacherMerge.js');
    check('LC-M5：app.js 匯入流程呼叫 mergeTeacherAttributes', /mergeTeacherAttributes\(this\.dataManager\.getTeachers\(\), parseResult\.teachers\)/.test(app));
    const old = [
        { name: '李小華', domains: ['數學領域'], homeroomClass: '7年1班' },
        { name: '李　小華', domains: ['自然領域'], homeroomClass: '7年2班' },   // 正規化後同名、原字串不同
        { name: '王大明', domains: ['國文'], homeroomClass: '8年1班' },
        { name: '王大明', domains: ['國文'], homeroomClass: '8年1班' },         // 原字串完全相同的重複筆：不算歧義
    ];
    const fresh = [{ name: '李 小華', domains: ['科技領域'], homeroomClass: '' }, { name: '王大明', domains: [], homeroomClass: '' }];   // 新名冊的寫法與舊名冊兩種都不完全相同
    const snap = JSON.stringify(fresh);
    const out = tm.mergeTeacherAttributes(old, fresh);
    eq(out[0], { name: '李 小華', domains: ['科技領域'], homeroomClass: '' }, 'LC-M5：同名多筆（原字串不同），新名冊的寫法與其中任何一筆都不完全相同 → 不合併，新名冊原樣保留');
    eq([out[1].homeroomClass, out[1].domains], ['8年1班', ['國文']], 'LC-M5：原字串相同的重複筆仍取第一筆合併');
    eq(tm.findAmbiguousTeacherNames(old, fresh), [{ name: '李 小華', candidates: ['李小華', '李　小華'] }], 'LC-M5：回報需人工確認的姓名與各種寫法');
    eq(tm.findAmbiguousTeacherNames(old, [{ name: '不在舊名冊' }]).length, 0, 'LC-M5：新名冊沒有該人就不回報');
    eq(JSON.stringify(fresh), snap, 'LC-M5：不修改傳入的名冊');
    // 新名冊姓名與既有某一筆原字串完全相同 → 直接用那一筆，不算歧義
    const old2 = [
        { name: '李小華', domains: ['數學領域'], homeroomClass: '7年1班' },
        { name: '李　小華', domains: ['自然領域'], homeroomClass: '7年2班' },
    ];
    const out2 = tm.mergeTeacherAttributes(old2, [{ name: '李小華', domains: [], homeroomClass: '' }]);
    eq([out2[0].homeroomClass, out2[0].domains], ['7年1班', ['數學領域']], 'LC-M5：新舊完全同字串（舊名冊另有全形空白寫法）→ 以完全相同的那筆合併');
    eq(tm.findAmbiguousTeacherNames(old2, [{ name: '李小華' }]).length, 0, 'LC-M5：完全同字串不回報歧義');
    const out3 = tm.mergeTeacherAttributes(old2, [{ name: '李 小華', domains: [], homeroomClass: '' }]);
    eq([out3[0].homeroomClass, out3[0].domains], ['', []], 'LC-M5：新名冊是第三種寫法 → 仍不合併');
    eq(tm.findAmbiguousTeacherNames(old2, [{ name: '李 小華' }]).length, 1, 'LC-M5：第三種寫法回報歧義');
    check('LC-M5：匯入預覽與匯入完成都提示組長（app.js 使用 findAmbiguousTeacherNames）',
        (app.match(/findAmbiguousTeacherNames\(/g) || []).length >= 2);
}

/* ===== LC-M6：app.js 沒有 new Date('YYYY-MM-DD') 或對日期字串直接 new Date ===== */
{
    const bad = app.split('\n').map((l, i) => [l, i + 1]).filter(([l]) => /new Date\(\s*(['"`]\d{4}|`\$\{)/.test(l));
    check('LC-M6：app.js 沒有 new Date(日期字串字面量／樣板)', bad.length === 0, bad.map(b => b[1]).join(','));
}

/* ===== LC-L4：合班時以 className 定位 ===== */
{
    const { DataManager } = await import('../src/js/modules/dataManager.js');
    const mk = () => {
        const dm = new DataManager();
        dm.scheduleData = [
            { teacher: '王老師', weekday: '週一', period: '第二節', className: '801', subject: '國文' },
            { teacher: '王老師', weekday: '週一', period: '第二節', className: '802', subject: '國文' },
        ];
        return dm;
    };
    let dm = mk();
    dm.updateScheduleEntry('王老師', '週一', '第二節', { subject: '作文' }, '802');
    eq(dm.scheduleData.map(c => c.subject), ['國文', '作文'], 'LC-L4：update 帶 className → 改到指定的那一班（不是第一筆）');
    dm = mk();
    dm.updateScheduleEntry('王老師', '週一', '第二節', { className: '803' }, '802');
    eq(dm.scheduleData.map(c => c.className), ['801', '803'], 'LC-L4：把班級改掉時用「原班級」定位');
    dm = mk();
    dm.removeScheduleEntry('王老師', '週一', '第二節', '802');
    eq(dm.scheduleData.map(c => c.className), ['801'], 'LC-L4：remove 帶 className → 刪指定那一班');
    dm = mk();
    dm.removeScheduleEntry('王老師', '週一', '第二節');
    eq(dm.scheduleData.map(c => c.className), ['802'], 'LC-L4：省略 className 維持舊行為（第一筆）');
    dm = mk();
    dm.updateScheduleEntry('王老師', '週一', '第二節', { subject: '空班級' }, '');
    eq(dm.scheduleData.map(c => c.subject), ['空班級', '國文'], 'LC-L4：className 為空字串（課表列沒有班級）視同省略，維持舊行為而不是無動作');
    dm = mk();
    dm.removeScheduleEntry('王老師', '週一', '第二節', '');
    eq(dm.scheduleData.map(c => c.className), ['802'], 'LC-L4：remove 傳空字串同樣視同省略');
    dm = mk();
    dm.scheduleData[0].className = '';
    dm.updateScheduleEntry('王老師', '週一', '第二節', { subject: '無班級列' }, '');
    eq(dm.scheduleData[0].subject, '無班級列', 'LC-L4：該列本身沒有班級，傳空字串仍改得到');
    dm = mk();
    dm.removeScheduleEntry('王老師', '週一', '第二節', '999');
    eq(dm.scheduleData.length, 2, 'LC-L4：找不到該班級就不動任何資料');
    check('LC-L4：app.js 兩個呼叫端都傳原班級', /updateScheduleEntry\(teacherName, weekday, period, \{[\s\S]*?\}, originalClassName\)/.test(app)
        && /removeScheduleEntry\(teacherName, weekday, period, originalClassName\)/.test(app));
    // v2-app 的 wrapScheduleMutator 以 ...args 轉送，className 參數不會被吃掉
    const v2 = read('src/js/v2-app.js');
    check('LC-L4：v2-app 的 patch 以 ...args 完整轉送參數', /dm\[name\] = function\(\.\.\.args\) \{\s*const r = orig\(\.\.\.args\);/.test(v2));
}

/* ===== LC-L13：節次共用常數含第八節 ===== */
{
    const p = await import('../src/js/modules/periods.js');
    const re = await import('../src/js/modules/recommendationEngine.js');
    eq(p.PERIOD_ORDER.length, 8, 'LC-L13：PERIOD_ORDER 共 8 節');
    check('LC-L13：含第八節且在最後', p.PERIOD_ORDER[7] === '第八節');
    eq(['第八節', '第一節', '第七節'].sort((a, b) => p.periodIndex(a) - p.periodIndex(b)), ['第一節', '第七節', '第八節'], 'LC-L13：第八節排在第七節之後');
    check('LC-L13：recommendationEngine 仍匯出同一份常數', re.PERIOD_ORDER === p.PERIOD_ORDER && re.periodIndex === p.periodIndex);
    check('LC-L13：app.js 不再寫死到第七節的 periodOrder', !/periodOrder = \[/.test(app));
}

/* ===== PL-03：getGrade9Config 與 getSettlementConfig 共用 unavailable 重試 ===== */
{
    const svc = await import('../src/js/modules/v2/schoolDataService.js');
    let calls = 0;
    const mkFs = (failures, code = 'unavailable') => ({ getDoc: async () => { calls++; if (calls <= failures) throw Object.assign(new Error('client is offline'), { code }); return { exists: () => true, data: () => ({ ok: 1 }) }; } });
    calls = 0;
    eq(await svc.getDocDataWithRetry(mkFs(2), {}, { retryDelayMs: 1 }), { ok: 1 }, 'PL-03：unavailable 兩次後成功 → 回傳資料');
    eq(calls, 3, 'PL-03：共嘗試 3 次');
    calls = 0;
    let err = null; try { await svc.getDocDataWithRetry(mkFs(5), {}, { retryDelayMs: 1 }); } catch (e) { err = e; }
    check('PL-03：一直 unavailable → 3 次後丟出原錯誤', err?.code === 'unavailable' && calls === 3, `${err?.code} ${calls}`);
    calls = 0; err = null;
    try { await svc.getDocDataWithRetry(mkFs(5, 'permission-denied'), {}, { retryDelayMs: 1 }); } catch (e) { err = e; }
    check('PL-03：非 unavailable（權限）不重試、立即丟出', err?.code === 'permission-denied' && calls === 1, `${err?.code} ${calls}`);
    const src = read('src/js/modules/v2/schoolDataService.js');
    check('PL-03：getGrade9Config、getSettlementConfig 都走共用 helper',
        /getGrade9Config\(\) \{[\s\S]*?getDocDataWithRetry\(/.test(src) && /getSettlementConfig\(\) \{[\s\S]*?getDocDataWithRetry\(/.test(src));
    // 整合：fake SDK 的 getDoc 回不存在 → null
    const { setActiveSchoolId } = await import('../src/js/modules/v2/schemaConstants.js');
    setActiveSchoolId('t');
    F.docs.clear();
    eq(await svc.getGrade9Config(), null, 'PL-03：文件不存在 → null');
    F.docs.set('schools/t/config/grade9', { semesterId: '115-1', enabled: true, effectiveDate: '', updatedAt: 'x', updatedBy: 'y' });
    eq((await svc.getGrade9Config()).enabled, true, 'PL-03：文件存在 → 回傳內容');
}

/* ===== PL-20：逐人門檻存檔前三方合併 ===== */
{
    const { mergeBaseMapEdits } = await import('../src/js/modules/settlementInputs.js');
    const baseline = { 甲: 20, 乙: 18 };
    // 使用者只改了「甲」→16；另一位 approver 同時新增「丙」、把「乙」改成 15
    const cloud = { 甲: 20, 乙: 15, 丙: 12 };
    eq(mergeBaseMapEdits(baseline, { 甲: 16, 乙: 18 }, cloud), { 甲: 16, 乙: 15, 丙: 12 }, 'PL-20：只套用自己改的人，保留他人剛存的新增與修改');
    eq(mergeBaseMapEdits(baseline, { 甲: 20 }, cloud), { 甲: 20, 丙: 12 }, 'PL-20：自己刪除的人（乙）被移除，他人新增的（丙）保留');
    eq(mergeBaseMapEdits(baseline, { 甲: 20, 乙: 18, 丁: 10 }, cloud), { 甲: 20, 乙: 15, 丙: 12, 丁: 10 }, 'PL-20：自己新增的人加入');
    eq(mergeBaseMapEdits({}, {}, { 甲: 1 }), { 甲: 1 }, 'PL-20：什麼都沒改 → 完全保留雲端');
    const b = { 甲: 20 }, e = { 甲: 20 }, c = { 乙: 1 };
    mergeBaseMapEdits(b, e, c);
    eq([b, e, c], [{ 甲: 20 }, { 甲: 20 }, { 乙: 1 }], 'PL-20：不修改傳入物件');
    check('PL-20：app.js 存檔流程使用三方合併', /mergeBaseMapEdits\(this\._settlementConfig\?\.weeklyBaseByTeacher, parsed\.map, cfg\.weeklyBaseByTeacher\)/.test(app)
        && /const cfg = await this\.loadSettlementConfig\(\);/.test(app));
}

/* ===== PL-21：九年級生效日在未來 → 顯示「已設定，X 月 X 日生效」 ===== */
{
    const g = await import('../src/js/modules/grade9Graduation.js');
    eq(g.grade9PendingLabel(true, '2026-12-05', false), '已設定，12 月 5 日生效', 'PL-21：已設定、未生效 → 顯示生效日');
    eq(g.grade9PendingLabel(true, '2026-12-05', true), '', 'PL-21：已生效 → 不顯示');
    eq(g.grade9PendingLabel(true, '', false), '', 'PL-21：沒有生效日 → 不顯示');
    eq(g.grade9PendingLabel(false, '2026-12-05', false), '', 'PL-21：未啟用 → 不顯示');
    // V2 下 syncGrade9Toggle 不得用「目前是否生效」蓋掉開關
    const toggle = { checked: true };
    const label = { textContent: '', classList: { toggle() {} } };
    const doc = { getElementById: (id) => id === 'grade9-disabled-toggle' ? toggle : id === 'grade9-status' ? label : id === 'grade9-effective-date' ? { value: '2099-01-02' } : null };
    const ctx = { dataManager: { isGrade9Disabled: () => false }, grade9ConfigStore: {}, updateGrade9StatusLabel: null };
    ctx.updateGrade9StatusLabel = buildMethod('updateGrade9StatusLabel', { document: doc, grade9PendingLabel: g.grade9PendingLabel });
    buildMethod('syncGrade9Toggle', { document: doc }).call(ctx);
    check('PL-21：V2（有 grade9ConfigStore）開關維持勾選，不被「尚未生效」蓋成未勾', toggle.checked === true);
    eq(label.textContent, '已設定，1 月 2 日生效', 'PL-21：說明文字寫入畫面');
    const ctxV1 = { ...ctx, grade9ConfigStore: null };
    buildMethod('syncGrade9Toggle', { document: doc }).call(ctxV1);
    check('PL-21：V1（無 store）照舊看本機狀態', toggle.checked === false);
}

/* ===== PL-18：只有「九年級是否被排除」實際改變、且已有選課時，才重設 ===== */
{
    const log = [];
    let toastMsg = '';
    const doc = { getElementById: (id) => id === 'selected-course-info' ? { classList: { add() { log.push('hideInfo'); } } } : null };
    const mk = (sel, disabled) => ({
        selectedCourse: sel, selectedCourses: sel ? [sel] : [], editorCurrentTeacher: '',
        dataManager: { isGrade9Disabled: () => disabled.v },
        resetStepsAfterBasic() { log.push('reset'); this.selectedCourse = null; this.selectedCourses = []; },
        showToast(m) { log.push('toast'); toastMsg = m; }, refreshActiveSubstitutePanels() { log.push('panels'); },
    });
    const fn = buildMethod('refreshGrade9DependentUI', { document: doc });
    const sel = { className: '901', period: '第一節' };
    const state = { v: false };
    let ctx = mk(sel, state);
    fn.call(ctx);   // 狀態沒變（預設未排除 → 未排除）：不重設
    check('PL-18：狀態沒變（重畫、改生效日、同步回來）→ 不重設、不提示', !log.includes('reset') && !log.includes('toast') && ctx.selectedCourse === sel);
    state.v = true;
    fn.call(ctx);   // 未排除 → 排除：重設
    check('PL-18：狀態實際翻轉且有已選課程 → 重設（內部選擇與資訊面板都清掉）', log.includes('reset') && log.includes('hideInfo') && ctx.selectedCourse === null && ctx.selectedCourses.length === 0);
    check('PL-18：提示文字說出所有被清掉的東西（課程、假別與字號、代課教師、異動類型）', ['課程', '假別', '字號', '代課教師', '異動類型'].every(w => toastMsg.includes(w)), toastMsg);
    log.length = 0; ctx.selectedCourse = sel; ctx.selectedCourses = [sel];
    fn.call(ctx);   // 排除 → 排除（例如只改生效日、重存同樣的值）：不重設
    check('PL-18：翻轉之後再次重畫（狀態相同）→ 不再重設', !log.includes('reset') && ctx.selectedCourse === sel);
    state.v = false; log.length = 0;
    fn.call(ctx);   // 排除 → 未排除：又翻轉
    check('PL-18：翻回去也算實際翻轉 → 重設', log.includes('reset'));
    log.length = 0; state.v = true;
    ctx = mk(null, state);
    fn.call(ctx);
    check('PL-18：翻轉但沒有已選課程 → 不重設、不提示', !log.includes('reset') && !log.includes('toast'));
}

/* ===== PL-23：需要證明文號的假別改讀 leaveTypes.js ===== */
{
    const lt = await import('../src/js/modules/leaveTypes.js');
    const need = lt.LEAVE_TYPES.filter(t => lt.requiresDocNumber(t.code)).map(t => t.code);
    eq(need, ['official', 'longsick', 'funeral'], 'PL-23：維持既有行為，只有公假、長期病假、喪假要求證明文號');
    check('PL-23：中文名稱也能查（紀錄詳情用）', lt.requiresDocNumber('公假') && lt.requiresDocNumber('喪假') && !lt.requiresDocNumber('婚假') && !lt.requiresDocNumber('事假'));
    check('PL-23：新假別（婚、產、陪產、公傷、流產）目前不要求', ['marriage', 'maternity', 'paternity', 'injury', 'miscarriage'].every(c => !lt.requiresDocNumber(c)));
    check('PL-23：未知假別與空值不要求', !lt.requiresDocNumber('zzz') && !lt.requiresDocNumber(undefined) && !lt.requiresDocNumber(''));
    check('PL-23：app.js 沒有寫死的公付假別清單', !/\['official', 'longsick', 'funeral'\]/.test(app) && !/'公假', '長期病假', '喪假'\]/.test(app));
    check('PL-23：leaveTypes.js 註解記錄使用者已於 2026-11-18 決定新假別不要求文號', /2026-11-18 決定「不要求」/.test(read('src/js/modules/leaveTypes.js')) && !/待使用者決定/.test(read('src/js/modules/leaveTypes.js')));
}

/* ===== PL-10 / PL-24：備份還原 ===== */
{
    const fmt = await import('../src/js/modules/v2/backupFormat.js');
    const svc = await import('../src/js/modules/v2/backupService.js');
    const { setActiveSchoolId } = await import('../src/js/modules/v2/schemaConstants.js');
    const roleSvc = await import('../src/js/modules/v2/roleService.js');
    setActiveSchoolId('t');
    roleSvc.setCurrentIdentity({ uid: 'u', email: 'e@example.edu.tw', teacherId: 'tch_01', name: '主任', role: 'director' });
    const P = 'schools/t';
    const origWarn = console.warn; console.warn = () => {};

    const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-06-01T00:00:00.000Z';
    const baseSections = (extra = {}) => ({
        config: { main: { currentSemester: '115-1', schoolName: 'T' }, settlement: { calendarId: 'c', calendarApiKey: 'k', weeksByYear: { 114: { 9: 4 } }, updatedAt: T0, updatedBy: 'u' }, ...extra.config },
        teachers: [
            { id: 'tch_01', data: { name: '主任', email: 'a@example.edu.tw', role: 'director', domains: [], homeroomClass: '', createdAt: T0, updatedAt: T0, junk: 'x', secretFlag: true } },
            { id: 'tch_02', data: { name: '李老師', email: null, role: 'teacher', domains: ['數學領域'], homeroomClass: '7年1班', partTime: true, createdAt: T0, updatedAt: T0, authProvider: 'google.com', hack: 1 } },
        ],
        schedules: [], scheduleImports: [], substituteRecords: [], pendingRequests: [],
    });
    const seedCloud = (over = {}) => {
        F.docs.clear(); F.writes.length = 0;
        F.docs.set(`${P}/config/main`, { currentSemester: '115-1', schoolName: 'T' });
        if (over.settlement !== null) F.docs.set(`${P}/config/settlement`, over.settlement || { calendarId: 'c2', calendarApiKey: 'k2', weeksByYear: { 114: { 9: 3 } }, updatedAt: T1, updatedBy: 'v' });
        if (over.grade9) F.docs.set(`${P}/config/grade9`, over.grade9);
    };
    const run = async (backup, planOpts = {}) => {
        const cloud = fmt.cloudStateFromSections(await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false }));
        const plan = fmt.planRestore({ backup, cloud, currentSemesterId: '115-1', ...planOpts });
        const report = await svc.executeRestore({ backup, plan, cloud, me: { name: '主任', teacherId: 'tch_01', email: 'e@example.edu.tw' } });
        return { plan, report };
    };
    const mkBackup = async (sections) => {
        const b = await fmt.buildBackupFile({ schoolId: 't', exportedAt: T1, currentSemester: '115-1', sections });
        const v = await fmt.parseAndValidateBackupText(JSON.stringify(b), { schoolId: 't' });
        if (!v.ok) throw new Error('備份驗證失敗：' + v.message);
        return v.backup;
    };

    // --- PL-10a：教師欄位白名單 ---
    eq(fmt.pickTeacherFields({ name: 'a', junk: 1, role: 'teacher', hack: { x: 1 }, authProvider: 'password' }), { name: 'a', role: 'teacher', authProvider: 'password' }, 'PL-10a：pickTeacherFields 只留白名單欄位');
    eq([...fmt.TEACHER_RESTORE_FIELDS], ['name', 'email', 'domains', 'homeroomClass', 'role', 'partTime', 'createdAt', 'updatedAt', 'authProvider'], 'PL-10a：白名單與 rules v2.16／前端實際寫入欄位一致');
    {
        seedCloud(); F.docs.delete(`${P}/teachers/tch_01`);
        const backup = await mkBackup(baseSections());
        const { report } = await run(backup);
        const w = F.writes.filter(x => /\/teachers\/[^/]+$/.test(x.path));
        check('PL-10a：還原教師只寫白名單欄位（備份檔多出的 junk／secretFlag／hack 不寫回）',
            report.ok && w.length === 2 && w.every(x => Object.keys(x.data).every(k => fmt.TEACHER_RESTORE_FIELDS.includes(k))), JSON.stringify(w.map(x => Object.keys(x.data))));
        check('PL-10a：白名單內的欄位（partTime、authProvider、createdAt）照常還原', w.find(x => x.path.endsWith('tch_02')).data.partTime === true && w.find(x => x.path.endsWith('tch_02')).data.authProvider === 'google.com');
    }

    // --- PL-10b：學期變動即中止 ---
    check('PL-10b：預覽與重算學期相同 → 不中止', fmt.semesterChangedSincePreview('115-1', '115-1') === false);
    check('PL-10b：重算後學期不同 → 中止', fmt.semesterChangedSincePreview('115-1', '115-2') === true);
    check('PL-10b：任一方缺值不誤判', fmt.semesterChangedSincePreview('', '115-2') === false && fmt.semesterChangedSincePreview('115-1', null) === false);
    // controller 的學期比對由 test/test-p9c-restore-flow.mjs 以行為測試驗證（含變異測試），這裡只留純函式

    // --- PL-10c：中文錯誤訊息 ---
    const friendly = fmt.friendlyErrorDetail;
    eq(friendly(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })), '安全規則拒絕了這次寫入（權限不足，或資料不符合規則）', 'PL-10c：permission-denied 轉中文');
    eq(friendly(Object.assign(new Error('x'), { code: 'firestore/aborted' })), '寫入與其他人的變更衝突，已中止', 'PL-10c：firestore/ 前綴也能對照');
    eq(friendly(new Error('課表版本已變更，已拒絕寫入')), '課表版本已變更，已拒絕寫入', 'PL-10c：本系統自己的中文訊息原樣保留');
    check('PL-10c：不認得的英文錯誤只顯示代碼，不外洩 SDK 原文', friendly(Object.assign(new Error('Some SDK english text'), { code: 'weird' })) === '發生未預期的錯誤（代碼：weird）');
    check('PL-10c：連英文訊息都沒有代碼 → 通用說明', friendly(new Error('boom')) === '發生未預期的錯誤');
    check('PL-10c：backupErrorMessage 一般失敗不含 SDK 英文', !/Missing or insufficient/.test(fmt.backupErrorMessage(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }), 'restore-read')));
    {
        seedCloud(); F.docs.delete(`${P}/teachers/tch_01`);
        const backup = await mkBackup(baseSections());
        F.failBatchAt = (F.commits || 0) + 1;
        const { report } = await run(backup);
        F.failBatchAt = null;
        const st = report.stages.find(s => s.key === 'teachers');
        check('PL-10c：還原階段失敗的 error 是中文、報告文字不含 simulated', st.status === 'failed' && st.error === '無法連到伺服器' && !/simulated/.test(svc.describeRestoreReport(report)), JSON.stringify(st));
    }

    // --- PL-10d：備份的月結算設定比雲端舊 ---
    {
        const backup = await mkBackup(baseSections());   // settlement.updatedAt = T0；雲端 = T1（較新、內容不同）
        seedCloud();
        let r = await run(backup);
        check('PL-10d：備份較舊 → 預設不覆寫（plan = skip-newer），雲端設定原封不動', r.plan.config.settlement === 'skip-newer' && r.plan.config.settlementBackupOlder === true && F.docs.get(`${P}/config/settlement`).calendarId === 'c2');
        check('PL-10d：預覽的「不會還原」清單有說明', r.plan.notRestored.some(s => /月結算設定/.test(s) && /不覆寫/.test(s)));
        check('PL-10d：預覽表格「將還原」不含月結算', fmt.summarizeRestorePlan(r.plan).find(x => x.label === '學校設定').willRestore === 0);
        seedCloud();
        r = await run(backup, { overwriteNewerSettlement: true });
        check('PL-10d：使用者勾選後才覆寫', r.plan.config.settlement === 'overwrite' && F.docs.get(`${P}/config/settlement`).calendarId === 'c', JSON.stringify(F.docs.get(`${P}/config/settlement`)));
        // 備份較新 → 照舊直接覆寫，不需勾選
        const newer = await mkBackup({ ...baseSections(), config: { main: baseSections().config.main, settlement: { calendarId: 'c3', calendarApiKey: 'k', weeksByYear: {}, updatedAt: '2026-12-01T00:00:00.000Z', updatedBy: 'u' } } });
        seedCloud();
        r = await run(newer);
        check('PL-10d：備份較新 → 照舊覆寫（不要求勾選）', r.plan.config.settlement === 'overwrite' && r.plan.config.settlementBackupOlder === false && F.docs.get(`${P}/config/settlement`).calendarId === 'c3');
        // 內容相同（只差 updatedAt）→ same
        const sameCfg = await mkBackup({ ...baseSections(), config: { main: baseSections().config.main, settlement: { calendarId: 'c2', calendarApiKey: 'k2', weeksByYear: { 114: { 9: 3 } }, updatedAt: T0, updatedBy: 'z' } } });
        seedCloud();
        r = await run(sameCfg);
        check('PL-10d：內容相同 → same（不寫入）', r.plan.config.settlement === 'same');
        // 雲端沒有 updatedAt → 維持舊行為（覆寫）
        seedCloud({ settlement: { calendarId: 'old', calendarApiKey: 'k', weeksByYear: {} } });
        r = await run(backup);
        check('PL-10d：雲端設定沒有 updatedAt（無從比較）→ 維持舊行為覆寫', r.plan.config.settlement === 'overwrite');
        check('PL-10d：controller 預覽有勾選項、重算計畫帶入勾選結果', /extraOptions/.test(read('src/js/modules/v2/backupController.js')) && /overwriteNewerSettlement: settlementOpt\.checked/.test(read('src/js/modules/v2/backupController.js')));
    }

    // --- PL-24：config/grade9 納入備份與還原 ---
    {
        const g9 = { semesterId: '115-1', enabled: true, effectiveDate: '2026-12-05', updatedAt: T0, updatedBy: 'u@example.edu.tw' };
        seedCloud({ grade9: g9 });
        const sec = await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false });
        eq(sec.config.grade9, g9, 'PL-24：匯出收集 config/grade9');
        const backup = await fmt.buildBackupFile({ schoolId: 't', currentSemester: '115-1', sections: sec });
        check('PL-24：含 grade9 的備份 formatVersion = 2，configDocs 計入', backup.formatVersion === 2 && backup.meta.counts.configDocs === 3);
        const v = await fmt.parseAndValidateBackupText(JSON.stringify(backup), { schoolId: 't' });
        check('PL-24：新格式備份驗證通過（雜湊、筆數）', v.ok, v.message);

        // 還原到沒有 grade9 的雲端
        seedCloud();
        let r = await run(v.backup);
        check('PL-24：雲端沒有 grade9 → create，還原後內容一致、欄位齊全', r.plan.config.grade9 === 'create' && r.report.ok
            && F.docs.get(`${P}/config/grade9`).semesterId === '115-1' && F.docs.get(`${P}/config/grade9`).enabled === true && F.docs.get(`${P}/config/grade9`).effectiveDate === '2026-12-05'
            && Object.keys(F.docs.get(`${P}/config/grade9`)).sort().join() === 'effectiveDate,enabled,semesterId,updatedAt,updatedBy', JSON.stringify(F.docs.get(`${P}/config/grade9`)));
        // 雲端較新且不同 → 不覆寫
        seedCloud({ grade9: { semesterId: '115-1', enabled: false, effectiveDate: '', updatedAt: T1, updatedBy: 'v' } });
        r = await run(v.backup);
        check('PL-24：雲端 grade9 較新 → skip-newer、不覆寫、清單有說明', r.plan.config.grade9 === 'skip-newer' && F.docs.get(`${P}/config/grade9`).enabled === false && r.plan.notRestored.some(s => /九年級/.test(s)));
        // 內容相同 → same
        seedCloud({ grade9: { ...g9, updatedAt: T1 } });
        r = await run(v.backup);
        check('PL-24：內容相同 → same', r.plan.config.grade9 === 'same');
        // 雲端較舊 → overwrite
        seedCloud({ grade9: { semesterId: '114-2', enabled: false, effectiveDate: '', updatedAt: '2025-01-01T00:00:00.000Z', updatedBy: 'v' } });
        r = await run(v.backup);
        check('PL-24：雲端較舊 → overwrite', r.plan.config.grade9 === 'overwrite' && F.docs.get(`${P}/config/grade9`).enabled === true);
        check('PL-24：計畫的寫入數與預覽表格計入 grade9', fmt.countPlannedWrites(r.plan) >= 0 && fmt.summarizeRestorePlan(r.plan).find(x => x.label === '學校設定').backup >= 2);

        // --- 舊格式備份（沒有 grade9、formatVersion 1）要能正常還原 ---
        seedCloud({ grade9: g9 });
        const legacySections = baseSections();
        const legacy = await fmt.buildBackupFile({ schoolId: 't', currentSemester: '115-1', sections: legacySections });
        check('PL-24：沒有 grade9 時仍寫 formatVersion 1（舊版系統也讀得懂），config 沒有 grade9 鍵', legacy.formatVersion === 1 && !('grade9' in legacy.config));
        // 以「舊版系統產生的檔案」重現：雜湊是對 { main, settlement } 的 config 算的
        const { createHash } = await import('node:crypto');
        const legacyText = JSON.stringify(legacy);
        const ordered = { config: { main: legacySections.config.main, settlement: legacySections.config.settlement }, teachers: legacySections.teachers, schedules: [], scheduleImports: [], substituteRecords: [], pendingRequests: [] };
        const oldHash = 'sha256:' + createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
        check('PL-24：舊格式備份的內容雜湊與舊演算法一致（沒有被新欄位破壞）', legacy.meta.contentHash === oldHash);
        const lv = await fmt.parseAndValidateBackupText(legacyText, { schoolId: 't' });
        check('PL-24：舊格式備份驗證通過', lv.ok, lv.message);
        const before = JSON.stringify(F.docs.get(`${P}/config/grade9`));
        r = await run(lv.backup);
        check('PL-24：舊格式備份還原 → grade9 計畫 none、雲端的 grade9 不被動到、整體成功', r.plan.config.grade9 === 'none' && r.report.ok && JSON.stringify(F.docs.get(`${P}/config/grade9`)) === before);
        // 版本號 99 仍被拒
        const fut = JSON.parse(legacyText); fut.formatVersion = 99;
        check('PL-24：過新的格式版本仍拒絕', !(await fmt.validateBackupFile(fut, { schoolId: 't' })).ok);
        // 無 grade9 時匯出：collect 不產生 grade9 鍵
        seedCloud();
        const sec2 = await svc.collectCloudBackupSections({ includeDetails: false, includeImports: false });
        check('PL-24：雲端沒有 grade9 時，匯出區段不帶 grade9 鍵', !('grade9' in sec2.config));
    }
    console.warn = origWarn;
}

console.log(`\n結果：通過 ${pass}，失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
