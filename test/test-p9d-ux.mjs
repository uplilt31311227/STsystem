/**
 * P9-D 使用者體驗：靜態結構與純函式檢查（純 node、離線）
 * 執行：node test/test-p9d-ux.mjs
 *
 * 瀏覽器行為（鍵盤操作課表格子、手機版面、角色文案）由 e2e-10-keyboard 與 ui-rwd-check 驗證。
 * 這裡鎖住不需要瀏覽器就能檢查的部分，避免日後被改回去。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { friendlyErrorMessage, isUserReadable, emailFormatError, ERROR_CODE_MESSAGES } from '../src/js/modules/errorText.js';
import { composeSubmitSummary } from '../src/js/modules/v2/submitSummary.js';
import { periodIndex, PERIOD_ORDER } from '../src/js/modules/periods.js';
import { renderLogRow, summarizeLogDetails, rejectedLabel, stageLabel, consentActions, approvalActions } from '../src/js/modules/v2/htmlRows.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let failed = 0, passed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}

const html = read('index.html');
const app = read('src/js/app.js');
const v2 = read('src/js/v2-app.js');
const auth = read('src/js/modules/authService.js');
const base = read('src/css/base.css');
const comp = read('src/css/components.css');
const feat = read('src/css/features.css');

/* ---- UX-M24：錯誤訊息 ---- */
{
    check('M24 登入錯誤碼對照：invalid-credential／too-many-requests／network-request-failed 都是中文',
        ['auth/invalid-credential', 'auth/too-many-requests', 'auth/network-request-failed', 'auth/popup-blocked'].every(c => /[一-鿿]/.test(friendlyErrorMessage({ code: c }))));
    check('M24 英文訊息不外洩：用備用文字', friendlyErrorMessage(new Error('Firebase: Error (auth/xyz).'), '請稍後再試') === '請稍後再試');
    check('M24 TypeError 類工程訊息不外洩', friendlyErrorMessage(new TypeError('Cannot read properties of undefined'), '備用') === '備用');
    check('M24 本專案自己丟的中文訊息保留', friendlyErrorMessage(new Error('已取消送出：尚未送出調課申請'), 'x') === '已取消送出：尚未送出調課申請');
    check('M24 含 console 字樣的訊息視為工程詞', !isUserReadable('發生錯誤，請查看 console'));
    check('M24 沒有 err 也不丟例外', typeof friendlyErrorMessage(undefined) === 'string' && friendlyErrorMessage(null).length > 5);
    check('M24 對照表每一項都是中文', Object.values(ERROR_CODE_MESSAGES).every(m => /[一-鿿]/.test(m)));
    check('M24 畫面文案不再叫使用者「請查看 console」', !/請查看 console/.test(app) && !/請查看 console/.test(v2));
    check('M24 authService 未知的 auth 錯誤包成中文（不直接 throw 原始 Firebase 錯誤）', (auth.match(/throw friendlyAuthError\(/g) || []).length >= 3 && !/\n\s+throw error;\n/.test(auth.slice(auth.indexOf('async function signInWithGoogle'), auth.indexOf('async function signOutUser'))));
    check('M24 app.js 登入失敗 toast 不直接顯示 error.message', /登入失敗：' \+ friendlyErrorMessage\(error/.test(app));
}

/* ---- UX-M13：Email 格式 ---- */
{
    check('M13 Email 可留空（取消指派）', emailFormatError('') === null && emailFormatError('   ') === null);
    check('M13 合格 Email 通過', emailFormatError('a.b@example.com') === null);
    check('M13 不合格 Email 擋下並說明', ['abc', 'a@b', '@x.com', 'a b@c.com'].every(v => /格式不正確/.test(emailFormatError(v) || '')));
    check('M13 Email 欄位存檔前驗證、角色變更前確認', /validate: emailFormatError/.test(v2) && /confirmChange: \(next\) =>/.test(v2) && /ROLE_CHANGE_EXPLAIN/.test(v2));
    check('M13 新增教師對話框也驗證 Email', /const emailErr = emailFormatError\(emailInput\.value\)/.test(v2));
}

/* ---- UX-M7：合併通知 ---- */
{
    const one = [{ msg: '已送出，等待組長／主任核准。', isSubstitute: true }];
    check('M7 一筆沿用原訊息', composeSubmitSummary(one) === one[0].msg);
    const many = composeSubmitSummary([...one, ...one, ...one]);
    check('M7 多節代課合併成一則，含筆數', /3 節代課申請/.test(many) && !/\n/.test(many));
    check('M7 混合類型用通用說法', /2 筆申請/.test(composeSubmitSummary([one[0], { msg: 'x', isSubstitute: false }])));
    check('M7 空陣列不產生訊息', composeSubmitSummary([]) === '');
    check('M7 app.js 多節送出前後呼叫 begin／endSubmitGroup', /beginSubmitGroup\?\.\(\)/.test(app) && /endSubmitGroup\?\.\(\)/.test(app) && /dm\.beginSubmitGroup = beginSubmitGroup/.test(v2));
    check('M7 writeV2Record 改走 reportSubmitted（不再逐筆 notify）', /reportSubmitted\(msg, isSub\)/.test(v2));
}

/* ---- UX-M6：送出按鈕與持續提示 ---- */
{
    check('M6 教師端按鈕改名「送出申請」，主任維持「確認並產生表單」', /teacher \? '送出申請' : '確認並產生表單'/.test(v2));
    check('M6 送出後有持續性提示與「前往待辦」', /id = 'v2-submit-banner'|banner\.id = 'v2-submit-banner'/.test(v2) && />前往待辦</.test(v2));
    check('M6 持續提示是 role=status（螢幕閱讀器會讀）', /banner\.setAttribute\('role', 'status'\)/.test(v2));
    check('M6 提示用 addEventListener 綁定，沒有 inline 事件處理器', !/onclick=/.test(v2.slice(v2.indexOf('function announceSubmitted'), v2.indexOf('function announceSubmitted') + 1800)));
}

/* ---- UX-M9：節次排序 ---- */
{
    const sorted = ['第七節', '第二節', '第十節', '第一節', '第八節'].sort((a, b) => periodIndex(a) - periodIndex(b));
    check('M9 以節次常數排序（第十節等未知節次排最後，不用字串比較）', sorted.join(',') === '第一節,第二節,第七節,第八節,第十節', sorted.join(','));
    check('M9 PERIOD_ORDER 是第一到第八節', PERIOD_ORDER.length === 8);
    check('M9 互換下拉用 periodIndex 排序', /const sortByPeriod = \(a, b\) => periodIndex\(a\.period\) - periodIndex\(b\.period\)/.test(app) && !/a\.period\.localeCompare/.test(app));
}

/* ---- UX-M8／M10：表單保留與確認 ---- */
{
    check('M8 改日期時保留假別、字號與異動類型（keepRequestFields）', /onTeacherOrDateChanged\(\{ keepRequestFields: true \}\)/.test(app) && /else if \(!keepRequestFields\)/.test(app));
    check('M8 改教師仍完整重置（不帶 keepRequestFields）', /sub-teacher'\)\.addEventListener\('change', \(e\) => \{\s*this\.onTeacherOrDateChanged\(\);/.test(app));
    check('M10 離開多重調課且批次非空時先確認，取消會還原選項', /this\.swapBatch\.length > 0/.test(app) && /清空並切換/.test(app) && /back\.checked = true/.test(app));
}

/* ---- UX-L9／M23：用語與回饋 ---- */
{
    const base0 = { reqId: 'r1', status: 'rejected', pendingConsentTeacherIds: ['t2'] };
    check('L9 對方教師不同意 → 「對方未同意」', rejectedLabel({ ...base0, rejectedBy: 't2' }) === '對方未同意' && /對方未同意/.test(stageLabel({ ...base0, rejectedBy: 't2' })));
    check('L9 組長或主任拒絕 → 「已被駁回」', rejectedLabel({ ...base0, rejectedBy: 'chief' }) === '已被駁回');
    check('L9 沒有 rejectedBy 時不誤判成對方未同意', rejectedLabel({ ...base0 }) === '已被駁回');
    check('L9 同意人按鈕是「同意／不同意」，核准人是「核准／駁回」', /不同意<\/button>/.test(consentActions({ reqId: 'x' })) && /駁回<\/button>/.test(approvalActions({ reqId: 'x' })));
    check('M23 撤回、拒絕、清除、刪除成功後都有 toast', ['已撤回', '已清除這項被拒絕的申請', '已刪除這筆紀錄', '發起人會在「待辦」看到'].every(k => v2.includes(k)));
    check('M23 刪除紀錄的確認說明月結算與 PDF 的後果', /月結算的節數與金額會少算這一筆/.test(v2) && /PDF 不會自動更新/.test(v2));
    check('LF-M10 追加同意教師文案：只需知悉同意、不產生異動紀錄、三方輪調請用多重調課', /只需要知悉並同意/.test(v2) && /不會替他們產生任何異動紀錄/.test(v2) && /三方輪調請改用「多重調課」/.test(v2) && !/若本次調課牽動其他教師課務/.test(v2));
}

/* ---- UX-M15：日誌中文對照 ---- */
{
    const row = renderLogRow({ timestamp: '2026-11-10T10:00:00Z', action: 'role_change', targetType: 'teacher', targetId: 'abcdef123456', actor: { name: '甲', role: 'section_chief' }, details: JSON.stringify({ reason: 'x', fromRole: 'teacher' }) });
    check('M15 動作、對象、角色顯示中文，原始代碼留在 title', />變更角色</.test(row) && />教師 \/ 123456</.test(row) && />組長</.test(row) && /title="role_change"/.test(row));
    check('M15 詳情是中文摘要，不直接顯示 JSON', /原因：x/.test(row) && !/&quot;/.test(row.replace(/title="[^"]*"/g, '')));
    check('M15 摘要略過巢狀物件、陣列顯示項數、布林轉中文', summarizeLogDetails({ affectedTeacherIds: ['a', 'b'], selfApproved: true, deep: { a: 1 } }) === '受影響教師：2 項；自行成立：是');
    check('M15 未知動作原文顯示（不丟例外）', />some_new_action</.test(renderLogRow({ action: 'some_new_action', actor: {}, details: null })));
}

/* ---- UX-L7／M3／M14／M1／M2／M4／L2／L3／L4 ---- */
{
    check('L7 頁尾不再寫死過時的版本號', !/v1\.9\.0/.test(html) && /<footer class="footer">\s*<p>國中調代課自動化系統 \|/.test(html));
    check('L7 V1 雲端同步說明卡在 V2 隱藏（v1-only）', /<div class="card v1-only">\s*<h3>雲端同步<\/h3>/.test(html));
    check('M3 #sync-status 帶 v1-only，且 JS 更新時保留該 class', /class="sync-status v1-only" id="sync-status"/.test(html) && /'sync-status v1-only ' \+ status/.test(app));
    check('M14 「儲存課表」鈕只在 V1 顯示，V2 顯示即時同步說明', /btn-sm v1-only" id="editor-save-schedule-btn"/.test(html) && /class="v2-only">每次修改都會立即同步給全校/.test(html));
    const missing = html.match(/<span class="v1-only v2-approver-only">請先至「課表管理」頁籤上傳課表檔案<\/span><span class="v2-only v2-teacher-only">本學期課表尚未匯入，請聯絡教學組長或教務主任。<\/span>/g) || [];
    check('M1 三處「尚未匯入課表」依角色換文案（教師看不到「課表管理」）', missing.length === 3 && !/<p>請先至「課表管理」頁籤上傳課表檔案<\/p>/.test(html), String(missing.length));
    check('M2 header 有「學校｜學期」位置，V2 登入後填入', /id="header-context"/.test(html) && /cfg\?\.schoolName/.test(v2) && /sn \? `\$\{sn\}｜\$\{resolved\}` : resolved/.test(v2));
    check('M2 手機只收起姓名文字，角色標籤仍顯示', /\.user-name-text \{ display: none; \}/.test(base) && /nameText\.className = 'user-name-text'/.test(v2));
    check('M4 第一次 auth 回報前遮罩顯示「載入中」，不畫登入按鈕', /_v2GateAuthState = 'pending'/.test(v2) && /載入中，請稍候/.test(v2) && /_v2GateAuthState = user \? 'in' : 'out'/.test(v2));
    check('M4 計時器在 initAuthService 之前註冊，init 丟錯也會切到登入畫面', v2.indexOf('GATE_PENDING_FALLBACK_MS);') < v2.indexOf('await authMod.initAuthService()') && /登入服務初始化失敗/.test(v2));
    check('V1 頁首：V2 也更新 #auth-logged-in／out（只略過 V1 同步）', /const v2 = isV2Enabled\(\)/.test(app) && !/if \(isV2Enabled\(\)\) return;[\s]+const loggedOut/.test(app));
    check('M4 有逾時退路（10 秒仍無回報就顯示登入按鈕）', /GATE_PENDING_FALLBACK_MS = 10000/.test(v2));
    check('L2 頭像 alt 為空（裝飾性），破圖改用 JS 綁 error 事件換首字圓章，無 inline onerror', /id="user-avatar" src="" alt=""/.test(html) && /addEventListener\('error', showAvatarFallback\)/.test(app) && !/onerror=/.test(html + app + v2) && /\.user-avatar-fallback/.test(base));
    check('L3 申請遮罩輸入框套用 .form-group，不再用行內寬度樣式', /<div class="form-group">\s*<label for="v2-apply-school-name">/.test(v2) && !/id="v2-apply-school-name"[^>]*style=/.test(v2) && /\.v2-auth-gate-card \.form-group input/.test(feat));
    check('L4 Email 登入的 label 與 input 以 for／id 關聯', (v2.match(/<label for="v2-modal-email">Email<\/label>\s*<input type="email" id="v2-modal-email"/g) || []).length === 2 && /<label for="v2-modal-pwd">/.test(v2));
}

/* ---- UX-L1／L5／L6／L12／P8-1／P8-3 ---- */
{
    const closeRule = (comp.match(/\.modal-close \{[^}]*\}/) || [''])[0];
    check('L1 .modal-close 觸控目標至少 44×44', /min-width: 44px/.test(closeRule) && /min-height: 44px/.test(closeRule));
    check('L1 .toast-close 觸控目標至少 44×44', /\.toast-close \{[^}]*min-width: 44px[^}]*min-height: 44px/.test(comp));
    check('L5 有 prefers-reduced-motion 全域規則', /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation-duration: 0\.01ms !important/.test(comp));
    check('L6 有 @media print，隱藏頁首、頁籤、按鈕、通知', /@media print[\s\S]*\.header[\s\S]*\.nav-tabs[\s\S]*display: none !important/.test(comp));
    check('L12 手機單日檢視放大字級（<640px，只動 .schedule-grid-single）', /@media \(max-width: 639px\)\s*\{\s*\.schedule-grid-single \.schedule-cell \{ font-size: var\(--fs-md\)/.test(feat));
    check('P8-1 課表編輯器格子有 role=button、tabindex、aria-label，Enter／空白鍵等同點擊', (app.match(/role="button" tabindex="0"/g) || []).length === 2 && /e\.key !== 'Enter' && e\.key !== ' '/.test(app) && /aria-label="\$\{esc\(`新增課程/.test(app) && /aria-label="\$\{esc\(`編輯/.test(app));
    check('P8-1 格子有可見的鍵盤焦點樣式', /\.schedule-cell\.editor-empty:focus-visible/.test(feat));
    check('P8-3 星期切換器不再宣告 tablist，改為有名稱的按鈕群組並標 aria-pressed', !/role="tablist"/.test(html) && /id="editor-day-switcher" role="group" aria-label=/.test(html) && /aria-pressed="\$\{isActive\}"/.test(app));
}

/* ---- 其餘：cache 版本參數一致 ---- */
{
    const vers = [...html.matchAll(/src\/css\/[a-z]+\.css\?v=([0-9.]+)/g)].map(m => m[1]);
    check('4 支 CSS 的 cache 版本參數一致', vers.length === 4 && new Set(vers).size === 1, vers.join(','));
}

process.stdout.write(failed ? `\n有失敗：通過 ${passed}、失敗 ${failed}\n` : `\n全部通過：通過 ${passed}、失敗 ${failed}\n`);
process.exit(failed ? 1 : 0);
