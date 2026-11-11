/**
 * 前端輸出跳脫／文件 ID／原型污染／登出清除／CSP 的單元測試（純 node、離線，不連 Firebase）
 * 執行：node test/test-html-escape.mjs
 *
 *   (a) 共用跳脫函式：& < > " ' ` 、null／undefined／數字
 *   (b) v2 渲染函式（操作日誌列、紀錄列、待辦卡片與按鈕）餵入攻擊字串，斷言沒有未跳脫標籤、屬性集合不變
 *   (c) 文件 ID 覆蓋：服務層映射函式（以假 SDK 離線執行）識別欄位永遠等於 doc id；核准複製不帶 reqId／recordId
 *   (d) 前端案件文字預檢與 firestore.rules hasSafeCaseText 欄位清單一致
 *   (e) 同批 batchId 歸屬過濾、原型污染、登出清除 key、全專案只有一份跳脫實作、CSP／SRI 靜態檢查
 */
import { register } from 'node:module';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// 讓服務層對 gstatic 的動態 import 導向假 SDK，並提供最小的瀏覽器環境
register('./helpers/gstatic-stub-loader.mjs', import.meta.url);
globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};

const { escapeHtml, esc, escapeDeep, toNum, safeUrl, pickAllowed } = await import('../src/js/modules/htmlEscape.js');
const rows = await import('../src/js/modules/v2/htmlRows.js');
const caseRule = await import('../src/js/modules/v2/caseTextRule.js');
const batchGuard = await import('../src/js/modules/v2/batchGuard.js');
const cleanup = await import('../src/js/modules/localDataCleanup.js');

let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}

/* ---------- (a) 共用跳脫函式 ---------- */
check('(a) 跳脫 & < > " \' `',
    escapeHtml('&<>"\'`') === '&amp;&lt;&gt;&quot;&#39;&#96;', escapeHtml('&<>"\'`'));
check('(a) null／undefined → 空字串', escapeHtml(null) === '' && escapeHtml(undefined) === '');
check('(a) 數字／布林不丟例外', escapeHtml(123) === '123' && escapeHtml(0) === '0' && escapeHtml(false) === 'false');
check('(a) esc 與 escapeHtml 為同一實作', esc === escapeHtml);
check('(a) 先跳脫 & 再跳脫其他（不重複跳脫）', escapeHtml('&lt;') === '&amp;lt;');
check('(a) escapeDeep 遞迴跳脫字串、保留數字', JSON.stringify(escapeDeep({ a: '<', b: [1, '"'], c: 2 })) === '{"a":"&lt;","b":[1,"&quot;"],"c":2}');
check('(a) toNum：非有限數字 → 0', toNum('12') === 12 && toNum('<img>') === 0 && toNum(undefined) === 0 && toNum(NaN, 7) === 7);
check('(a) safeUrl 擋 javascript:／data:', safeUrl('javascript:alert(1)') === '#' && safeUrl('data:text/html,x') === '#'
    && safeUrl('https://a.b/c?d="e') === 'https://a.b/c?d=&quot;e' && safeUrl('blob:https://x/1') === 'blob:https://x/1');
check('(a) pickAllowed 白名單', pickAllowed('director', ['director']) === 'director' && pickAllowed('x" onclick="', ['director']) === '');

/* ---------- (b) 渲染函式 ---------- */
const P1 = '"><img src=x onerror=alert(1)>';
const P2 = "'onmouseover='alert(1)";
const P3 = '<script>alert(1)</script>`x`';

/** 簡單 HTML tokenizer：回傳 { tags:[{name,closing,attrs:[{name,value}]}], text:[...] }，引號內的 > 不會截斷標籤。 */
function tokenize(html) {
    const tags = [];
    const text = [];
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        if (lt < 0) { text.push(html.slice(i)); break; }
        if (lt > i) text.push(html.slice(i, lt));
        const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(lt));
        if (!m) { text.push('<'); i = lt + 1; continue; }   // 非標籤的 <：視為文字（未跳脫的 < 會被另一斷言抓到）
        let j = lt + m[0].length;
        const attrs = [];
        for (;;) {
            while (/\s/.test(html[j] || '')) j++;
            if (j >= html.length) break;
            if (html[j] === '>' ) { j++; break; }
            if (html[j] === '/' && html[j + 1] === '>') { j += 2; break; }
            const nm = /^[^\s=>/]+/.exec(html.slice(j));
            if (!nm) { j++; continue; }
            j += nm[0].length;
            while (/\s/.test(html[j] || '')) j++;
            let value = null;
            if (html[j] === '=') {
                j++;
                while (/\s/.test(html[j] || '')) j++;
                if (html[j] === '"' || html[j] === "'") {
                    const q = html[j];
                    const end = html.indexOf(q, j + 1);
                    value = html.slice(j + 1, end < 0 ? html.length : end);
                    j = end < 0 ? html.length : end + 1;
                } else {
                    const um = /^[^\s>]+/.exec(html.slice(j));
                    value = um ? um[0] : '';
                    j += value.length;
                }
            }
            attrs.push({ name: nm[0], value });
        }
        tags.push({ name: m[2].toLowerCase(), closing: !!m[1], attrs });
        i = j;
    }
    return { tags, text };
}
const sig = (html) => tokenize(html).tags.map(t => `${t.closing ? '/' : ''}${t.name}[${t.attrs.map(a => a.name).sort().join(',')}]`).join(' ');
const unesc = (s) => s.replace(/&#96;/g, '`').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

function checkRender(name, render, benign, fields, { roundTripField = fields[0] } = {}) {
    const base = render(benign);
    const baseSig = sig(base);
    for (const payload of [P1, P2, P3]) {
        // 逐欄位單獨注入，再一次全注入
        const variants = fields.map(f => ({ ...benign, [f]: payload }));
        variants.push({ ...benign, ...Object.fromEntries(fields.map(f => [f, payload])) });
        for (const v of variants) {
            const html = render(v);
            const tk = tokenize(html);
            const bad = tk.tags.filter(t => t.name === 'img' || t.name === 'script');
            check(`(b) ${name}：無 <img>／<script> 標籤`, bad.length === 0, html.slice(0, 200));
            check(`(b) ${name}：標籤與屬性集合與正常資料相同`, sig(html) === baseSig, `${sig(html)}\n  vs ${baseSig}`);
            const onAttr = tk.tags.flatMap(t => t.attrs).filter(a => /^on/i.test(a.name));
            check(`(b) ${name}：沒有事件處理屬性`, onAttr.length === 0, JSON.stringify(onAttr));
            check(`(b) ${name}：文字節點與屬性值不含原始 < > "`, !tk.text.some(s => /[<>"]/.test(s)) && !/<img|<script/i.test(html.replace(/<(\/?)(tr|td|span|code|div|strong|br|button)\b[^>]*>/g, '')), html.slice(0, 200));
        }
    }
    // 反跳脫後文字內容含原值（顯示內容正確，不是整個被吃掉）
    const withPayload = render({ ...benign, [roundTripField]: P1 });
    check(`(b) ${name}：文字內容可還原原值`, unesc(withPayload).includes(P1), withPayload.slice(0, 200));
}

// 操作日誌列：details 同時涵蓋字串（新格式）與舊 map
const logBenign = {
    timestamp: '2026-11-10T10:00:00.000Z', action: 'approve', targetType: 'substitute_record', targetId: 'rec_1234567',
    actor: { name: '王老師', email: 'a@b.c', role: 'director' }, details: '{"k":"v"}',
};
const renderLog = (l) => rows.renderLogRow({ ...l, actor: l.actor });
const logFields = ['timestamp', 'action', 'targetType', 'targetId', 'details'];
checkRender('操作日誌列(details=字串)', renderLog, logBenign, logFields, { roundTripField: 'action' });
checkRender('操作日誌列(details=舊 map)', renderLog, { ...logBenign, details: { k: 'v' } }, ['action', 'targetType', 'targetId'], { roundTripField: 'action' });
for (const payload of [P1, P2, P3]) {
    const l = { ...logBenign, details: { a: payload, nested: { b: payload } }, actor: { name: payload, email: payload, role: payload }, action: payload, targetType: payload, targetId: payload };
    const html = renderLog(l);
    const spanTag = tokenize(html).tags.find(t => t.name === 'span');
    check('(b) 操作日誌列：角色 class 不在白名單時被清空，不能跳出屬性', spanTag.attrs.length === 1 && spanTag.attrs[0].name === 'class' && spanTag.attrs[0].value === 'v2-role-tag ',
        JSON.stringify(spanTag));
    check('(b) 操作日誌列：舊 map details 內的攻擊字串已跳脫', sig(html) === sig(renderLog({ ...logBenign, actor: { name: 'x', role: 'x' } })), sig(html));
}
check('(b) 操作日誌列：targetId 為數字不丟例外（致盲攻擊）', (() => { try { rows.renderLogRow({ ...logBenign, targetId: 123456789 }); return true; } catch { return false; } })());
check('(b) 操作日誌列：details 為 undefined／null／循環結構不丟例外', (() => {
    try {
        const cyc = {}; cyc.self = cyc;
        rows.renderLogRow({ ...logBenign, details: undefined });
        rows.renderLogRow({ ...logBenign, details: null });
        rows.renderLogRow({ ...logBenign, details: cyc });
        return true;
    } catch { return false; }
})());
check('(b) 操作日誌列：正常資料顯示內容一致', (() => {
    const h = renderLog(logBenign);
    return h.includes('王老師') && h.includes('<span class="v2-role-tag director">director</span>') && h.includes('substitute_record / 234567') && h.includes('{&quot;k&quot;:&quot;v&quot;}');
})(), renderLog(logBenign));

// 紀錄列
const recBenign = {
    recordId: 'rec_1_abc', date: '2026-11-10', period: '第一節', className: '801', originalTeacher: '王', substituteTeacher: '李',
    swapTeacher: '', type: '代課', initiatedByName: '王', initiatedByRole: 'teacher', isLegacy: false,
};
const recFields = ['recordId', 'date', 'period', 'className', 'originalTeacher', 'substituteTeacher', 'type', 'initiatedByName'];
checkRender('紀錄列(approver)', r => rows.renderRecordRow(r, true), recBenign, recFields);
checkRender('紀錄列(非 approver)', r => rows.renderRecordRow(r, false), recBenign, recFields);
{
    const html = rows.renderRecordRow({ ...recBenign, recordId: P1 }, true);
    const ids = tokenize(html).tags.flatMap(t => t.attrs).filter(a => a.name === 'data-id').map(a => a.value);
    check('(b) 紀錄列：data-id 三處皆為跳脫後的完整原值（無法跳出屬性）', ids.length === 3 && ids.every(v => unesc(v) === P1), JSON.stringify(ids));
}

// 待辦卡片
const reqBenign = {
    reqId: 'req_1_abc', requestType: 'swap', status: 'pending_approval', date: '2026-11-10', period: '第二節', className: '802', subject: '國文',
    initiatedByName: '王', initiatedBy: 'tch_1', createdAt: '2026-11-01T00:00:00.000Z', rejectNote: '', type: '調課',
};
const reqFields = ['reqId', 'date', 'period', 'className', 'subject', 'initiatedByName', 'initiatedBy', 'createdAt', 'type'];
checkRender('待辦卡片(核准)', r => rows.renderPendingCard(r, 'incoming', rows.approvalActions(r)), reqBenign, reqFields);
checkRender('待辦卡片(同意)', r => rows.renderPendingCard(r, 'incoming', rows.consentActions(r)), { ...reqBenign, status: 'pending_swap_consent' }, reqFields);
checkRender('待辦卡片(我的申請)', r => rows.renderPendingCard(r, 'outgoing', rows.mineActions(r)), reqBenign, reqFields);
checkRender('待辦卡片(被拒絕＋原因)', r => rows.renderPendingCard(r, 'outgoing', rows.mineActions(r)), { ...reqBenign, status: 'rejected', rejectNote: '原因' }, ['rejectNote', 'reqId', 'className']);
{
    const attackId = 'x"><img src=x onerror=alert(1)><b x="';
    const html = rows.renderPendingCard({ ...reqBenign, reqId: attackId }, 'incoming', rows.approvalActions({ ...reqBenign, reqId: attackId }));
    const ids = tokenize(html).tags.flatMap(t => t.attrs).filter(a => a.name === 'data-id').map(a => a.value);
    check('(b) 待辦卡片：reqId 屬性跳出 payload（C3）→ data-id 共 3 處皆為完整原值', ids.length === 3 && ids.every(v => unesc(v) === attackId) && !/<img/i.test(html), JSON.stringify(ids));
}
check('(b) 待辦卡片：cls 不在白名單時被清空（屬性集合不變、無 onclick）', !tokenize(rows.renderPendingCard(reqBenign, 'x" onclick="', '')).tags.some(t => t.attrs.some(a => a.name === 'onclick')) && sig(rows.renderPendingCard(reqBenign, 'x" onclick="', '')) === sig(rows.renderPendingCard(reqBenign, 'incoming', '')));

/* ---------- (b2) v2-app.js 實際使用這些函式、且不再自行拼接未跳脫的日誌／紀錄列 ---------- */
{
    const v2 = read('src/js/v2-app.js');
    check('(b2) v2-app.js 以 renderLogRow 輸出日誌列', /visible\.map\(l => renderLogRow\(l\)\)/.test(v2));
    check('(b2) v2-app.js 以 renderRecordRow 輸出紀錄列', /displayed\.map\(r => renderRecordRow\(r, isApprover\)\)/.test(v2));
    check('(b2) v2-app.js 以 renderPendingCard 輸出待辦卡片', /renderPendingCard\(r, cls,/.test(v2));
    check('(b2) v2-app.js 不再有 `${l.actor`／`${l.action}`／`${r.className ||` 之類未跳脫插值',
        !/\$\{l\.(actor|action|targetType|targetId|details)/.test(v2) && !/<td[^>\n]*>\$\{r\./.test(v2) && !/data-id="\$\{r\.reqId\}"/.test(v2));
    check('(b2) 頁首姓名不再用 innerHTML（改 DOM API）', !/nameSpan\.innerHTML/.test(v2) && /createTextNode\(String\(identity\.name/.test(v2));
    const app = read('src/js/app.js');
    check('(b2) app.js 課表編輯格線的 className／subject／domain／title 皆 esc()',
        /data-class="\$\{esc\(course\.className\)\}"/.test(app) && /data-subject="\$\{esc\(course\.subject\)\}"/.test(app)
        && /data-domain="\$\{esc\(course\.domain \|\| ''\)\}"/.test(app) && /title="\$\{esc\(courseTitle\)\}"/.test(app)
        && /<span class="course-class">\$\{esc\(course\.className\)\}/.test(app));
    check('(b2) app.js 備份預覽校名 esc()', /\$\{esc\(data\.schoolName \|\| '（未設定）'\)\}/.test(app));
}

/* ---------- (c) 文件 ID 覆蓋 ---------- */
const dataSvc = await import('../src/js/modules/v2/schoolDataService.js');
const reqSvc = await import('../src/js/modules/v2/pendingRequestService.js');
const roleSvc = await import('../src/js/modules/v2/roleService.js');
const appSvc = await import('../src/js/modules/v2/schoolApplicationService.js');
const semesterState = await import('../src/js/modules/v2/semesterState.js');
const logConsole = console.log; console.log = () => {};
{
    const F = (globalThis.__fake ||= { docs: new Map(), writes: [] });
    const evil = { id: 'EVIL_id', reqId: 'EVIL_reqId', recordId: 'EVIL_recordId', teacherId: 'EVIL_teacherId', logId: 'EVIL_logId', uid: 'EVIL_uid', name: 'x' };
    const base = 'schools/inhu';
    F.docs.set(`${base}/teachers/tch_real`, { ...evil });
    F.docs.set(`${base}/substituteRecords/rec_real`, { ...evil, semesterId: 's1', createdAt: '2026-01-01' });
    F.docs.set(`${base}/pendingRequests/req_real`, { ...evil, status: 'pending_approval', semesterId: 's1', createdAt: '2026-01-01' });
    F.docs.set(`${base}/operationLogs/log_real`, { ...evil, timestamp: '2026-01-01' });
    F.docs.set(`${base}/joinAttempts/uid_real`, { ...evil });
    const t1 = await dataSvc.listTeachers();
    check('(c) listTeachers：teacherId = doc id（資料內同名欄位被覆蓋）', t1.length === 1 && t1[0].teacherId === 'tch_real', JSON.stringify(t1));
    check('(c) getTeacher：teacherId = doc id', (await dataSvc.getTeacher('tch_real')).teacherId === 'tch_real');
    const r1 = await dataSvc.listSubstituteRecords();
    check('(c) listSubstituteRecords：recordId = doc id，資料內的 id 欄位（V1 批次排序鍵）原樣保留', r1[0].recordId === 'rec_real' && r1[0].id === 'EVIL_id', JSON.stringify(r1[0]));
    check('(c) getSubstituteRecord：recordId = doc id', (await dataSvc.getSubstituteRecord('rec_real')).recordId === 'rec_real');
    const p1 = await dataSvc.listPendingRequests();
    check('(c) listPendingRequests：reqId = doc id', p1[0].reqId === 'req_real', JSON.stringify(p1[0]));
    check('(c) getPendingRequest：reqId = doc id', (await dataSvc.getPendingRequest('req_real')).reqId === 'req_real');
    const l1 = await dataSvc.listLogs({});
    check('(c) listLogs：logId = doc id', l1[0].logId === 'log_real', JSON.stringify(l1[0]));
    const j1 = typeof dataSvc.listJoinAttempts === 'function' ? await dataSvc.listJoinAttempts() : null;
    if (j1) check('(c) listJoinAttempts 不受影響', Array.isArray(j1));

    // 建立函式的回傳值：新產生的 ID 勝出
    semesterState.setCurrentSemesterId('s1');
    const created = await dataSvc.createSubstituteRecord({ ...evil, type: '代課', date: '2026-11-10' });
    check('(c) createSubstituteRecord 回傳的 recordId 是新 ID，不是資料內的偽造值', created.recordId.startsWith('rec_') && created.recordId !== 'EVIL_recordId', created.recordId);
    const createdReq = await dataSvc.createPendingRequest({ ...evil, status: 'pending_approval' });
    check('(c) createPendingRequest 回傳的 reqId 是新 ID', createdReq.reqId.startsWith('req_') && createdReq.reqId !== 'EVIL_reqId', createdReq.reqId);

    // 核准：複製申請內容進紀錄時，剔除 reqId／recordId；保留 id
    roleSvc.setCurrentIdentity({ teacherId: 'tch_dir', name: '主任', role: 'director' });
    F.writes.length = 0;
    F.docs.set(`${base}/pendingRequests/req_ap`, {
        ...evil, requestType: 'substitute', status: 'pending_approval', semesterId: 's1', createdAt: '2026-01-01',
        initiatedBy: 'tch_a', type: '代課', date: '2026-11-10', period: '第一節', className: '801',
        originalTeacher: '甲', substituteTeacher: '乙', pendingConsentTeacherIds: [], swapConsents: {},
    });
    let approveErr = null;
    try { await reqSvc.approveRequest('req_ap'); } catch (e) { approveErr = e; }
    const txSet = F.writes.find(w => w.op === 'tx.set' && w.path.includes('/substituteRecords/'));
    check('(c) approveRequest 可離線執行（假 SDK）', !approveErr && !!txSet, String(approveErr && approveErr.stack || approveErr));
    if (txSet) {
        check('(c) 核准寫入的紀錄不含 reqId／recordId（不信任申請內夾帶的識別欄位）', !('reqId' in txSet.data) && !('recordId' in txSet.data), JSON.stringify(Object.keys(txSet.data)));
        check('(c) 核准寫入的紀錄 fromRequestId 為真實申請 doc id', txSet.data.fromRequestId === 'req_ap', txSet.data.fromRequestId);
        check('(c) 核准寫入的紀錄保留 V1 批次排序鍵 id', txSet.data.id === 'EVIL_id');
        check('(c) 紀錄路徑是新產生的 rec_ ID', /\/substituteRecords\/rec_/.test(txSet.path));
    }
}
console.log = logConsole;
check('(c) schoolApplicationService 映射 uid = doc id（原始碼）', !/\{ uid: (d|snap)\.id, \.\.\./.test(read('src/js/modules/v2/schoolApplicationService.js')));
{
    // 原始碼層：v2 模組內不得再有「ID 在前、資料展開在後」的組合
    const dir = path.join(ROOT, 'src/js/modules/v2');
    const offenders = [];
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of src.matchAll(/\{\s*(\w+):\s*(?:d|snap|doc)\.id\s*,\s*\.\.\./g)) offenders.push(`${f}: ${m[0]}`);
        for (const m of src.matchAll(/\{\s*(?:reqId|recordId|teacherId|logId|uid)\s*,\s*\.\.\./g)) offenders.push(`${f}: ${m[0]}`);
    }
    check('(c) src/js/modules/v2 內沒有 { xxxId: d.id, ...d.data() } 或 { reqId, ...data } 型組合', offenders.length === 0, offenders.join('; '));
}

/* ---------- (d) 案件文字預檢 vs firestore.rules ---------- */
{
    const rules = read('firestore.rules');
    const start = rules.indexOf('function hasSafeCaseText(d)');
    const body = rules.slice(start, rules.indexOf('}', rules.indexOf('return all.size()', start)));
    const ruleFields = [...body.matchAll(/d\.get\('(\w+)',\s*([^)]*?)\)/g)].map(m => [m[1], m[2].trim()]);
    const mine = caseRule.CASE_TEXT_FIELDS.map(([f, d]) => [f, typeof d === 'string' ? `''` : String(d)]);
    check('(d) CASE_TEXT_FIELDS 欄位、順序、預設值與 firestore.rules hasSafeCaseText 完全一致',
        JSON.stringify(ruleFields) === JSON.stringify(mine), `\nrules=${JSON.stringify(ruleFields)}\nmine =${JSON.stringify(mine)}`);
    check('(d) rules 上限為 1000', /all\.size\(\) <= (\d+)/.exec(body)?.[1] === String(caseRule.CASE_TEXT_MAX_LENGTH));
    // 分隔符：rules 以 '|' 串接，N 個欄位 → N-1 個
    const sepCount = (body.match(/\+ '\|' \+/g) || []).length;
    check('(d) 分隔符數 = 欄位數 - 1', sepCount === ruleFields.length - 1, `${sepCount} vs ${ruleFields.length}`);

    // 長度邊界：總長（含分隔符與缺欄預設值）剛好 1000 → 放行；1001 → 擋下
    const bareLen = caseRule.caseTextString({}).length;          // 全缺欄位時的基礎長度（含預設值與分隔符）
    const ok = { className: 'x'.repeat(1000 - bareLen) };
    check('(d) 前端：總長剛好 1000 放行', caseRule.caseTextString(ok).length === 1000 && (() => { try { caseRule.assertRuleSafeCaseText(ok); return true; } catch { return false; } })());
    const over = { className: 'x'.repeat(1001 - bareLen) };
    check('(d) 前端：總長 1001 擋下（繁中訊息）', (() => { try { caseRule.assertRuleSafeCaseText(over); return false; } catch (e) { return /過長/.test(e.message); } })());
    // 舊版只加總 13 欄、上限 900：用「重複姓名＋id＋分隔符」把總長推到 898～1001，舊版會放行但 rules 會拒絕
    const heavy = {
        originalTeacher: 'a'.repeat(100), initiatedByName: 'a'.repeat(100), requiredApproverName: 'a'.repeat(100),
        id: 'b'.repeat(40), batchId: '1'.repeat(20), multiCourseGroupId: '1'.repeat(20),
        originalTeacherId: 'tch_'.padEnd(60, 'c'), substituteTeacherId: 'tch_'.padEnd(60, 'c'), swapTeacherId: 'tch_'.padEnd(60, 'c'), requiredApproverId: 'tch_'.padEnd(60, 'c'),
        className: 'x'.repeat(1001 - bareLen - 100 - 100 - 100 - 40 - 20 - 20 - 56 * 4 - 56 * 4 + 56 * 4 * 0 + 0),
    };
    // 精確湊到 1001：調整 className 長度
    const cur = caseRule.caseTextString({ ...heavy, className: '' }).length;
    heavy.className = 'x'.repeat(1001 - cur);
    const thirteen = ['className', 'subject', 'domain', 'originalTeacher', 'substituteTeacher', 'swapTeacher', 'swapSubject', 'swapDomain', 'docNumber', 'period', 'swapPeriod', 'weekday', 'swapWeekday']
        .reduce((n, k) => n + (typeof heavy[k] === 'string' ? heavy[k].length : 0), 0);
    check('(d) 舊版 13 欄加總 <= 900（舊版會放行）但完整串接 = 1001（rules 會拒絕）→ 新版擋下',
        thirteen <= 900 && caseRule.caseTextString(heavy).length === 1001 && (() => { try { caseRule.assertRuleSafeCaseText(heavy); return false; } catch { return true; } })(),
        `thirteen=${thirteen} full=${caseRule.caseTextString(heavy).length}`);
    check('(d) 任何欄位含 < > " 都擋下並指出欄位', (() => { try { caseRule.assertRuleSafeCaseText({ initiatedByName: 'a"b' }); return false; } catch (e) { return /發起人姓名/.test(e.message); } })());
    check('(d) 非字串／數字／布林的欄位值（map／list）擋下（rules 會求值錯誤）', (() => { try { caseRule.assertRuleSafeCaseText({ className: { a: 1 } }); return false; } catch { return true; } })());
    check('(d) null 欄位以 "null" 計入（與 rules string(null) 一致）', caseRule.caseTextString({ className: null }).length === bareLen + 4);
}

/* ---------- (e) 同批歸屬過濾 ---------- */
{
    // 教師發起：同批每筆 initiatedBy 相同；自行調課（isSelfSwap）是批次內的合法成員，initiatedBy 同為發起教師
    const mk = (id, over = {}) => ({ recordId: id, batchId: '100', type: '調課', initiatedBy: 'tch_T', originalTeacherId: 'a' + id, swapTeacherId: 'b' + id, substituteTeacherId: 'b' + id, ...over });
    const selfOf = (id, who, over = {}) => mk(id, { isSelfSwap: true, originalTeacherId: who, swapTeacherId: who, substituteTeacherId: who, ...over });
    const attacker = (over = {}) => selfOf('evil', 'tch_X', { initiatedBy: 'tch_X', ...over });
    const ids = (a) => a.map(r => r.recordId || r.reqId).sort().join();
    const everyAnchor = (batch, extra, expected, label) => {
        const bad = [];
        for (const anchor of batch) {
            const got = ids(batchGuard.filterSameBatch(anchor, [...batch, ...extra]));
            if (got !== expected) bad.push(`anchor=${anchor.recordId}: ${got}`);
        }
        check(label, bad.length === 0, bad.join(' | '));
    };

    const teacherBatch = [selfOf('s1', 'tch_T'), mk('r2'), mk('r3')];
    everyAnchor(teacherBatch, [attacker()], 's1,r2,r3'.split(',').sort().join(), '(e) 教師批次 [自調, 一般, 一般]：以每一筆為基準都回傳完整批次，攻擊者被排除');
    const adminBatch = [
        selfOf('a1', 'tch_p1', { adminOperatorId: 'tch_ADM', initiatedBy: 'tch_p1' }),
        mk('a2', { adminOperatorId: 'tch_ADM', initiatedBy: 'tch_p2' }),
    ];
    everyAnchor(adminBatch, [attacker()], 'a1,a2', '(e) 組長代發批次 [自調, 一般]（initiatedBy 各異、adminOperatorId 相同）：以每一筆為基準都完整，攻擊者被排除');
    everyAnchor([mk('r1'), mk('r2'), mk('r3')], [attacker(), mk('o1', { initiatedBy: 'tch_OTHER' })], 'r1,r2,r3', '(e) 純一般批次：發起人不同的同 batchId 紀錄與攻擊者皆被排除');
    // 攻擊者變體：省略 initiatedBy、偽造 adminOperatorId 以外的欄位、冒用 isLegacy 以外…
    for (const [label, evil] of [
        ['省略 initiatedBy（rules 已擋，前端仍要排除）', attacker({ initiatedBy: undefined })],
        ['initiatedBy 為空字串', attacker({ initiatedBy: '' })],
        ['自我調課形狀、initiatedBy 為自己', attacker()],
    ]) {
        everyAnchor(teacherBatch, [evil], 's1,r2,r3'.split(',').sort().join(), `(e) 攻擊者變體「${label}」被排除（以每一筆為基準）`);
        everyAnchor(adminBatch, [evil], 'a1,a2', `(e) 攻擊者變體「${label}」被排除（組長代發批次）`);
    }
    check('(e) 以攻擊者紀錄為基準時，不會把受害者批次印出來', ids(batchGuard.filterSameBatch(attacker(), [...teacherBatch, attacker()])) === 'evil');
    check('(e) 以攻擊者（省略 initiatedBy）為基準時，同樣只剩自己', ids(batchGuard.filterSameBatch(attacker({ initiatedBy: undefined }), [...teacherBatch, attacker({ initiatedBy: undefined })])) === 'evil');
    // 舊系統遷移資料
    const legacy = [{ recordId: 'l1', batchId: '9', type: '調課', isLegacy: true, migratedFrom: { source: 'localStorage' } }, { recordId: 'l2', batchId: '9', type: '調課', isLegacy: true }];
    everyAnchor(legacy, [], 'l1,l2', '(e) 舊系統遷移資料（無發起人欄位、帶 isLegacy／migratedFrom）：整批保留');
    check('(e) 缺發起者鍵且非舊系統遷移資料 → 排除（即使基準也缺鍵）', ids(batchGuard.filterSameBatch({ recordId: 'k1', batchId: '9' }, [{ recordId: 'k1' }, { recordId: 'k2', batchId: '9' }])) === 'k1');
    check('(e) 遷移資料不會與有發起者的紀錄混批', ids(batchGuard.filterSameBatch(legacy[0], [...legacy, mk('r1')])) === 'l1,l2');
    check('(e) 在途申請（reqId）同樣過濾', ids(batchGuard.filterSameBatch(mk('r1'), [{ reqId: 'q1', initiatedBy: 'tch_T' }, { reqId: 'q2', initiatedBy: 'tch_X' }])) === 'q1');
    const appSrc = read('src/js/app.js');
    check('(e) app.js reprintSwapBatchRecord 與 v2-app.js 都套用 filterSameBatch', /filterSameBatch\(record, this\.dataManager\.substituteRecords/.test(appSrc) && (read('src/js/v2-app.js').match(/filterSameBatch\(/g) || []).length >= 4);
    // rules 必帶 initiatedBy（對應 test/emulator/rules-hardening.mjs 的 P4b-1）；前端自我調課路徑確實寫入 initiatedBy
    check('(e) firestore.rules 自我調課要求 initiatedBy 必帶且等於本人', /'initiatedBy' in d && d\.initiatedBy == me/.test(read('firestore.rules')));
    check('(e) v2-app.js 自我調課路徑寫入 payload.initiatedBy = me.teacherId', /payload\.initiatedBy = me\.teacherId;/.test(read('src/js/v2-app.js')));
}

/* ---------- (f) 原型污染 ---------- */
{
    const { DataManager } = await import('../src/js/modules/dataManager.js');
    const dm = new DataManager();
    dm.setScheduleData([
        { subject: '__proto__', domain: 'polluted', className: '801', teacher: 't', weekday: '週一', period: '第一節' },
        { subject: 'constructor', domain: 'danger', className: '801', teacher: 't', weekday: '週一', period: '第二節' },
        { subject: '國文', domain: '語文', className: '801', teacher: 't', weekday: '週一', period: '第三節' },
    ]);
    const map = dm.buildSubjectDomainMap(false);
    check('(f) 科目為 __proto__ 不污染 Object.prototype', ({}).polluted === undefined && Object.prototype.polluted === undefined);
    check('(f) 科目為 constructor 仍可正常建立對應', Array.isArray(map.constructor) && map.constructor[0] === 'danger' && map['國文'][0] === '語文');
    check('(f) getDomainsForSubject 不會取到原型鏈上的函式', Array.isArray(dm.getDomainsForSubject('toString')) && dm.getDomainsForSubject('toString').length === 0 && dm.getDomainsForSubject('hasOwnProperty').length === 0);
    dm.setSubjectDomains('__proto__', ['x']);
    check('(f) setSubjectDomains 拒絕 __proto__', ({}).x === undefined && Object.getPrototypeOf(dm.settings.subjectDomainMap) === Object.prototype);
    const dm2 = new DataManager();
    dm2.settings.subjectDomainMap = JSON.parse('{"__proto__":["pwn"],"國文":["語文"]}');
    dm2.setScheduleData([]);
    dm2.buildSubjectDomainMap(true);
    check('(f) 既有對應表含 __proto__ 鍵（JSON 來源）合併時不污染', ({}).length === undefined && Object.getPrototypeOf(dm2.settings.subjectDomainMap) === Object.prototype);
}

/* ---------- (g) 登出清除 ---------- */
{
    const mkStore = (init) => {
        const m = new Map(Object.entries(init));
        return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), _m: m };
    };
    const LEGACY = JSON.stringify({ substituteRecords: [{ id: '1', date: '2026-01-01', originalTeacher: '王', substituteTeacher: '李' }], lastModified: '2026-01-02' });
    const HIST = '[{"versionNo":1}]';
    const fresh = () => mkStore({
        substituteSystemData: LEGACY, 'substituteSystemData:inhu': '{"m":1}', 'substituteSystemData:other': '{"m":2}',
        substituteSystemScheduleImports: HIST, gasUrl: 'https://x', [cleanup.LAST_UID_KEY]: 'uid1', someUiPref: 'keep',
    });
    const local = fresh();
    const session = mkStore({ a: '1' });
    const removed = cleanup.clearLocalUserData(local, session);
    check('(g) 只清 V2 鏡像（各學校 key）與上次 uid', removed.sort().join() === ['stsystem:lastAuthUid', 'substituteSystemData:inhu', 'substituteSystemData:other'].sort().join(), JSON.stringify(removed));
    check('(g) 舊 key substituteSystemData 內容不變（V1 本機紀錄，遷移的唯一來源）', local.getItem('substituteSystemData') === LEGACY);
    check('(g) V1 匯入紀錄 substituteSystemScheduleImports 與 gasUrl 不清（唯一來源／無個資）', local.getItem('substituteSystemScheduleImports') === HIST && local.getItem('gasUrl') === 'https://x');
    check('(g) 不屬於本系統的 key（UI 偏好）保留', local.getItem('someUiPref') === 'keep');
    check('(g) sessionStorage 清空', session.length === 0);
    check('(g) 被動登出（keepLastUid）保留上次 uid，切換帳號偵測才有依據', (() => { const l = fresh(); cleanup.clearLocalUserData(l, mkStore({}), { keepLastUid: true }); return l.getItem(cleanup.LAST_UID_KEY) === 'uid1'; })());
    check('(g) NEVER_CLEAR_KEYS 含舊 key／匯入紀錄／gasUrl，且 LOCAL_EXACT_KEYS 與之不相交',
        ['substituteSystemData', 'substituteSystemScheduleImports', 'gasUrl'].every(k => cleanup.NEVER_CLEAR_KEYS.includes(k) && !cleanup.LOCAL_EXACT_KEYS.includes(k)));

    // ---- 行為矩陣：登出／被動登出／切換帳號，後面 legacy 遷移的來源偵測仍找得到舊 key ----
    const legacySvc = await import('../src/js/modules/v2/legacyMigrationService.js');
    const calls = [];
    globalThis.firebaseModules = { terminate: async () => calls.push('terminate'), clearIndexedDbPersistence: async () => calls.push('clear') };
    const realLog = console.log; console.log = () => {};
    const savedHooks = { ...legacySvc.__testHooks };
    legacySvc.__testHooks.roleSvc = { getCurrentIdentity: () => ({ uid: 'u1', teacherId: 't', role: 'director' }), isDirector: () => true };
    legacySvc.__testHooks.readFirestoreLegacy = async () => null;
    for (const [label, opts, expectFs] of [
        ['使用者主動登出', { db: {} }, true],
        ['切換帳號（強制清 Firestore 快取）', { db: {}, keepUid: 'uid2' }, true],
        ['被動登出（session 失效／他分頁登出）', { db: {}, keepFirestoreCache: true }, false],
    ]) {
        const store = fresh();
        globalThis.localStorage = store; globalThis.sessionStorage = mkStore({});
        calls.length = 0;
        await cleanup.wipeLocalUserData({ ...opts, reload: false });
        check(`(g) ${label}：舊 key 內容不變`, store.getItem('substituteSystemData') === LEGACY);
        check(`(g) ${label}：legacy 遷移來源偵測仍找得到舊 key（1 筆）`, (await legacySvc.detectLegacyData())?.count === 1);
        check(`(g) ${label}：V2 鏡像已清`, store.getItem('substituteSystemData:inhu') === null);
        check(`(g) ${label}：Firestore 快取${expectFs ? '清除（terminate→clear）' : '保留（不呼叫 terminate）'}`, expectFs ? calls.join() === 'terminate,clear' : calls.length === 0, calls.join());
        check(`(g) ${label}：上次 uid ${opts.keepUid ? '改記新 uid' : opts.keepFirestoreCache ? '保留' : '移除'}`,
            opts.keepUid ? store.getItem(cleanup.LAST_UID_KEY) === 'uid2' : opts.keepFirestoreCache ? store.getItem(cleanup.LAST_UID_KEY) === 'uid1' : store.getItem(cleanup.LAST_UID_KEY) === null);
    }
    Object.assign(legacySvc.__testHooks, savedHooks);
    console.log = realLog;
    delete globalThis.firebaseModules; delete globalThis.localStorage; delete globalThis.sessionStorage;

    // ---- 離線待寫入 ----
    const never = new Promise(() => {});
    check('(g) hasPendingWrites：waitForPendingWrites 逾時 → true（有未同步變更）', await cleanup.hasPendingWrites({}, { waitForPendingWrites: () => never }, 30) === true);
    check('(g) hasPendingWrites：已全部送出 → false', await cleanup.hasPendingWrites({}, { waitForPendingWrites: async () => {} }, 30) === false);
    check('(g) hasPendingWrites：被伺服器拒絕（promise reject＝寫入已被丟棄）→ false', await cleanup.hasPendingWrites({}, { waitForPendingWrites: async () => { throw new Error('denied'); } }, 30) === false);
    check('(g) hasPendingWrites：沒有 db／沒有 API → false', await cleanup.hasPendingWrites(null, {}, 30) === false && await cleanup.hasPendingWrites({}, {}, 30) === false);

    const authSrc = read('src/js/modules/authService.js');
    check('(g) signOutUser：signOut 之前先 hasPendingWrites，有未同步變更 → confirmDialog，取消 → return false（不登出）',
        /await hasPendingWrites\(getDbInstance\(\)\)[\s\S]*confirmFn\.call\(window\.app[\s\S]*if \(!proceed\) return false;[\s\S]*await signOut\(auth\)/.test(authSrc));
    check('(g) signOutUser：signOut 後 wipeLocalUserData（含 Firestore 快取）', /await signOut\(auth\);[\s\S]*await wipeLocalUserData\(\{ db: getDbInstance\(\) \}\)/.test(authSrc));
    check('(g) 被動登出：只清鏡像、keepFirestoreCache: true，且主動登出（userInitiatedSignOut）不重複走這條', /!user && hadSignedInUser && !userInitiatedSignOut[\s\S]*keepFirestoreCache: true/.test(authSrc));
    check('(g) 切換帳號：lastUid !== user.uid → 強制清（含 Firestore 快取）', /lastUid !== user\.uid[\s\S]*wipeLocalUserData\(\{ db: getDbInstance\(\), keepUid: user\.uid \}\)/.test(authSrc));
    const fb = read('src/js/modules/firebaseConfig.js');
    check('(g) firebaseConfig 匯出 terminate、clearIndexedDbPersistence、waitForPendingWrites', /terminate, clearIndexedDbPersistence, waitForPendingWrites/.test(fb) && /clearIndexedDbPersistence,\s*\n\s*waitForPendingWrites\s*\n\s*};/.test(fb));
    // clearFirestoreCache 呼叫順序：terminate → clearIndexedDbPersistence
    const calls1 = [];
    await cleanup.clearFirestoreCache({ db: 1 }, { terminate: async () => calls1.push('terminate'), clearIndexedDbPersistence: async () => calls1.push('clear') });
    check('(g) clearFirestoreCache：先 terminate 再 clearIndexedDbPersistence', calls1.join() === 'terminate,clear');
    const calls2 = [];
    const realWarn = console.warn; console.warn = () => {};
    await cleanup.clearFirestoreCache({ db: 1 }, { terminate: async () => {}, clearIndexedDbPersistence: async () => { calls2.push('x'); throw new Error('boom'); } });
    console.warn = realWarn;
    check('(g) clearIndexedDbPersistence 失敗不丟例外（改走後備）', calls2.length === 1);
}

/* ---------- (i) PDF 檔名使用未跳脫原值 ---------- */
{
    const { safeFileName, unescapeHtml } = await import('../src/js/modules/htmlEscape.js');
    check('(i) unescapeHtml 是 escapeHtml 的反向', unescapeHtml(escapeHtml('<a href="x">&\'`</a>')) === '<a href="x">&\'`</a>');
    check('(i) 不會二次解碼（&amp;lt; 還原成 &lt;）', unescapeHtml('&amp;lt;') === '&lt;');
    check('(i) 檔名：escapeDeep 後的 O\'Brien & Wang 還原成原值', safeFileName(escapeHtml("O'Brien & Wang")) === "O'Brien & Wang");
    check('(i) 檔名：移除路徑與保留字元（\\ / : * ? " < > |）', safeFileName(escapeHtml('a/b\\c:d*e?f"g<h>i|j')) === 'abcdefghij');
    check('(i) 檔名：一般中文姓名原樣', safeFileName(escapeHtml('陳小美')) === '陳小美');
    const pdf = read('src/js/modules/pdfGenerator.js');
    check('(i) pdfGenerator 的檔名組字全部走 safeFileName（教師姓名、班級）',
        /_\$\{safeFileName\(record\.originalTeacher\)\}\.pdf/.test(pdf) && /_\$\{safeFileName\(baseRecord\.originalTeacher\)\}_/.test(pdf) && /_\$\{safeFileName\(group\.className\)\}_連調/.test(pdf));
}

/* ---------- (h) 全專案單一跳脫實作、CSP／SRI 靜態檢查 ---------- */
{
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
    walk(path.join(ROOT, 'src/js'));
    const defs = [];
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        if (/function\s+(escapeHtml|esc|escapeDeep)\s*\(/.test(src) || /const\s+(escapeHtml|esc)\s*=\s*(\(|function|[a-z]+\s*=>)/.test(src)) defs.push(path.relative(ROOT, f));
    }
    check('(h) 全專案只有 modules/htmlEscape.js 定義跳脫函式', defs.length === 1 && defs[0].replace(/\\/g, '/') === 'src/js/modules/htmlEscape.js', defs.join(', '));

    const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');   // 去掉註解再檢查標籤
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || '';
    const dir = (n) => (csp.split(';').map(s => s.trim()).find(s => s.startsWith(n + ' ')) || '');
    check('(h) CSP 存在，script-src 不含 unsafe-inline／unsafe-eval', !!csp && !/unsafe-inline|unsafe-eval/.test(dir('script-src')), dir('script-src'));
    check('(h) CSP 含 object-src none、base-uri self、form-action self，且沒有 frame-ancestors',
        /object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp) && /form-action 'self'/.test(csp) && !/frame-ancestors/.test(csp));
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(m => m[1]);
    check('(h) index.html 沒有 inline <script>（全部帶 src）', scripts.every(a => /\bsrc="/.test(a)));
    check('(h) index.html 沒有 inline 事件處理屬性', !/\son[a-z]+\s*=\s*["']/i.test(html));
    const cdn = [...html.matchAll(/<script\b([^>]*\bsrc="(https:\/\/[^"]+)"[^>]*)>/g)];
    check('(h) 所有 CDN <script> 都有 integrity 與 crossorigin="anonymous"，且版本固定', cdn.length === 5 && cdn.every(m => /integrity="sha384-[A-Za-z0-9+/=]+"/.test(m[1]) && /crossorigin="anonymous"/.test(m[1]) && /\d+\.\d+\.\d+/.test(m[2])), String(cdn.length));
    check('(h) SheetJS 使用官方 cdn.sheetjs.com 0.20.3', /cdn\.sheetjs\.com\/xlsx-0\.20\.3\//.test(html) && !/xlsx\/0\.18/.test(html) && /https:\/\/cdn\.sheetjs\.com/.test(dir('script-src')));
    const pkg = JSON.parse(read('package.json').replace(/^﻿/, ''));
    check('(h) package.json 的 xlsx 指向官方 0.20.3 tarball', /cdn\.sheetjs\.com\/xlsx-0\.20\.3\/xlsx-0\.20\.3\.tgz/.test(pkg.devDependencies.xlsx), pkg.devDependencies.xlsx);
    const parser = read('src/js/modules/scheduleParser.js');
    check('(h) 課表匯入有 5MB 檔案大小上限', /MAX_SCHEDULE_FILE_BYTES = 5 \* 1024 \* 1024/.test(parser) && /file\.size > MAX_SCHEDULE_FILE_BYTES/.test(parser));
}

console.log = logConsole;
process.stdout.write(`\n${failed === 0 ? '全部通過' : '有失敗'}：通過 ${passed}、失敗 ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
