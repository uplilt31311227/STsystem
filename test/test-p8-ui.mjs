/**
 * P8 使用者體驗：靜態結構檢查（純 node、離線）
 * 執行：node test/test-p8-ui.mjs
 *
 * 瀏覽器行為（Esc、焦點移入／還原、Tab 循環、點背景、鍵盤完成申請）由 test/e2e/e2e-10-keyboard.mjs 驗證；
 * 這裡鎖住不需瀏覽器就能檢查的結構，避免日後有人改回去：
 *   - CDN 腳本都有 defer、integrity、crossorigin，且排在 module 腳本之前；CSP 仍允許這些來源
 *   - 所有動態對話框都經過共用的 activateModal；含輸入的對話框沒有自己的「點背景關閉」
 *   - radio／開關沒有 display:none；可選課程格與推薦項目是 <button>
 *   - 6 顆原本沒有防連點的按鈕都已包 withBusyButton
 *   - 學校代碼說明存在、且畫面與公告都沒有寫出真實代碼
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let failed = 0, passed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}

const html = read('index.html');
const v2 = read('src/js/v2-app.js');
const app = read('src/js/app.js');
const rich = read('src/js/modules/richDialog.js');
const a11y = read('src/js/modules/modalA11y.js');
const featuresCss = read('src/css/features.css');

/* ---- (8) CDN defer ---- */
{
    const cdn = [...html.matchAll(/<script\b[^>]*src="https:\/\/[^"]+"[^>]*>/g)].map(m => m[0]);
    check('(8) 有 5 支 CDN 腳本', cdn.length === 5, String(cdn.length));
    check('(8) 每支 CDN 腳本都有 defer', cdn.every(t => /\sdefer(\s|>)/.test(t)), cdn.filter(t => !/\sdefer(\s|>)/.test(t)).join('\n'));
    check('(8) 每支 CDN 腳本仍有 integrity 與 crossorigin（SRI 不受影響）', cdn.every(t => /integrity="sha384-/.test(t) && /crossorigin="anonymous"/.test(t)));
    const lastCdn = html.lastIndexOf(cdn[cdn.length - 1]);
    const firstModule = html.indexOf('<script type="module"');
    check('(8) CDN 腳本排在 module 腳本之前（執行順序）', lastCdn > 0 && firstModule > lastCdn);
    const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] || '';
    check('(8) CSP script-src 仍允許 cdnjs 與 sheetjs', /script-src[^;]*cdnjs\.cloudflare\.com/.test(csp) && /script-src[^;]*cdn\.sheetjs\.com/.test(csp));
    // 沒有行內腳本會在解析當下使用 CDN 全域變數
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(t => t.trim());
    check('(8) 沒有行內腳本使用 Papa／XLSX／jspdf／html2canvas', inline.every(t => !/\b(Papa|XLSX|jspdf|html2canvas)\b/.test(t)));
    // 模組載入時（頂層）不呼叫這些全域；使用處都在函式內，由使用者操作觸發
    const topLevel = [app, read('src/js/modules/scheduleParser.js'), read('src/js/modules/pdfGenerator.js')]
        .some(src => /^(?:const|let|var)\s+\w+\s*=\s*(?:new\s+)?(?:Papa|XLSX|jspdf|html2canvas)\b/m.test(src));
    check('(8) 模組頂層沒有在載入當下呼叫 CDN 全域', !topLevel);
}

/* ---- (5) 對話框統一 ---- */
{
    const created = (v2.match(/\.className = 'modal';/g) || []).length;
    const activated = (v2.match(/activateModal\(/g) || []).length;
    check('(5) v2-app.js 每個動態對話框都呼叫 activateModal', created > 0 && activated >= created, `建立 ${created}，啟用 ${activated}`);
    check('(5) richDialog 使用 activateModal，不再自己處理 Esc／背景', /activateModal\(/.test(rich) && !/addEventListener\('keydown'/.test(rich) && !/e\.target === modal/.test(rich));
    check('(5) activateModal：role=dialog、aria-modal、aria-labelledby、Esc、Tab 循環、焦點還原', ['role', 'aria-modal', 'aria-labelledby', "'Escape'", "'Tab'", 'restoreFocus(opener)'].every(k => a11y.includes(k)));
    check('(5) 含輸入的對話框預設點背景不關閉（hasInputs）', /closeOnBackdrop \?\? !hasInputs\(modal\)/.test(a11y));
    // 含輸入欄位的動態對話框不得再自己綁「點背景就關閉」
    check('(5) 拒絕原因／新增教師／Email 登入對話框不再有點背景關閉', !/backdrop\.addEventListener\('click', \(e\) => \{ if \(e\.target === backdrop\) (cleanup\(null\)|closeAuthModal\(\)); \}\);/.test(v2));
    check('(5) 課程編輯對話框（含輸入）不再有點背景關閉', !/e\.target\.id === 'course-edit-modal'/.test(app));
    check('(5) app.js 啟用靜態對話框的共用行為', /watchStaticModals\(document/.test(app));
    check('(5) 靜態 modal-close 鈕都有 aria-label', [...html.matchAll(/<button[^>]*class="modal-close"[^>]*>/g)].every(m => /aria-label=/.test(m[0])));
    check('(2) 其他教師需同意：有取消鈕、搜尋框、新標題', /id="v2-extra-consent-cancel"/.test(v2) && /id="v2-extra-consent-search"/.test(v2) && /<h3>還有其他教師需要一併同意嗎？<\/h3>/.test(v2) && !/<h3>多重調課：/.test(v2));
    check('(2) 取消＝放棄送出（呼叫端收到 null 即中止）', /extraNames === null/.test(v2));
}

/* ---- (6) 鍵盤與報讀 ---- */
{
    check('(6) radio 與開關不再 display:none', !/change-type-option input\[type="radio"\]\s*\{\s*display:\s*none/.test(featuresCss) && !/multi-course-toggle input\s*\{\s*display:\s*none/.test(featuresCss));
    check('(6) radio 與開關有焦點樣式', /input\[type="radio"\]:focus-visible \+ \.change-type-card/.test(featuresCss) && /multi-course-toggle input:focus-visible \+ \.toggle-slider/.test(featuresCss));
    check('(6) 可選課程格是 <button type=button> 且帶 aria-pressed 與可讀名稱', /const cellTag = isSelectable \? 'button' : 'div'/.test(app) && /aria-pressed="false" aria-label=/.test(app));
    check('(6) 推薦項目是 <button type=button> 且帶 aria-pressed', /document\.createElement\('button'\);\s*item\.type = 'button';\s*item\.setAttribute\('aria-pressed', 'false'\)/.test(app));
    check('(6) aria-pressed 跟著 selected／multi-selected 同步', /_bindPressedState/.test(app) && /classList\.contains\('multi-selected'\)/.test(app));
    check('(6) 上傳區可聚焦（role=button、tabindex=0）並支援 Enter／空白鍵', /id="schedule-upload" role="button" tabindex="0"/.test(html) && /e\.key === 'Enter' \|\| e\.key === ' '/.test(app));
    check('(6) 課程標籤的移除鈕是 <button> 且有名稱', /<button type="button" class="chip-remove"[^>]*aria-label=/.test(app));
    check('(6) 異動類型圖示對報讀隱藏（名稱只剩「代課」「調課」）', (html.match(/class="change-type-icon" aria-hidden="true"/g) || []).length === 3);
    check('(6) toast 容器為 live region', /id="toast-container" role="status" aria-live="polite"/.test(html));
}

/* ---- (9) 6 顆未防連點的按鈕 ---- */
{
    const guarded = (re) => re.test(v2);
    check('(9) .v2-dismiss-btn 已防連點', guarded(/\.v2-dismiss-btn'\)\.forEach\(btn =>\s*btn\.addEventListener\('click', \(\) => withBusyButton\(/));
    check('(9) .v2-delete-teacher 已防連點', guarded(/\.v2-delete-teacher'\)\.forEach\(btn =>\s*btn\.addEventListener\('click', \(\) => withBusyButton\(/));
    check('(9) .v2-admin-delete 已防連點', guarded(/\.v2-admin-delete'\)\.forEach\(btn =>\s*btn\.addEventListener\('click', \(\) => withBusyButton\(/));
    check('(9) #v2-import-legacy-teachers 已防連點', guarded(/v2-import-legacy-teachers'\)\?\.addEventListener\('click', \(ev\) => \{[\s\S]{0,200}withBusyButton\(/));
    check('(9) #v2-roster-csv-input 匯入已互斥（鎖住觸發鈕）', guarded(/v2-roster-csv-input'\)\?\.addEventListener\('change', \(ev\) => \{[\s\S]{0,700}withBusyButton\(document\.getElementById\('v2-import-roster-csv'\)/));
    check('(9) .v2-download-pdf 已防連點', guarded(/\.v2-download-pdf'\)\.forEach\(btn =>\s*btn\.addEventListener\('click', \(\) => withBusyButton\(/));
}

/* ---- (3) 學校代碼說明 ---- */
{
    check('(3) 登入遮罩說明學校代碼是什麼與向誰取得', /學校代碼是本系統用來分辨各校的簡短英文代號，不是您的密碼/.test(v2) && /向學校的教學組長或教務主任詢問/.test(v2));
    check('(3) 學校代碼輸入框有 label 與說明關聯', /for="v2-join-school-id"/.test(v2) && /aria-describedby="v2-join-school-hint"/.test(v2));
    const ann = read('docs/ANNOUNCEMENT-115-1.md');
    check('(3) 公告說明學校代碼（不寫出真實代碼）', /學校代碼/.test(ann) && /向教學組長或教務主任詢問/.test(ann));
    // 真實代碼不得出現在畫面文字或公告（程式內部常數不在此檢查範圍，只檢查使用者看得到的兩處）
    const REAL = 'inh' + 'u';
    const gateText = v2.slice(v2.indexOf('const joinSection'), v2.indexOf("if (app?.status === 'pending')"));
    check('(3) 登入遮罩文字沒有真實學校代碼', !gateText.includes(REAL));
    check('(3) 公告沒有真實學校代碼作為輸入範例', !/學校代碼[^\n]{0,40}inhu|請輸入 `?inhu/.test(ann));
    check('(4) 登入遮罩可捲動', /#v2-auth-gate[\s\S]{0,400}overflow-y:\s*auto/.test(read('src/css/features.css').split('body.v2-locked #v2-auth-gate {')[1] ? 'x #v2-auth-gate {' + read('src/css/features.css').split('body.v2-locked #v2-auth-gate {')[1].slice(0, 500) : ''));
}

console.log(`\n結果：${passed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
