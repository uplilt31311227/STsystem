/**
 * P8 色彩對比測試（純 node、離線）
 * 執行：node test/test-p8-contrast.mjs
 *
 * 讀 src/css/*.css 的實際規則與 tokens.css 的變數，逐組算 WCAG 2.1 對比值：
 *   - 一般文字 ≥ 4.5:1；非文字介面元件（焦點環、輸入框框線）≥ 3:1。
 *   - 每組同時列出「修前」色碼（審計當時的值）與修後算出的比值，方便對照。
 * 這支測試也鎖住「CSS 規則真的用了這個顏色」：色碼不是寫死在測試裡，而是從 CSS 規則解析出來。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = (f) => fs.readFileSync(path.join(ROOT, 'src/css', f), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const FILES = { tokens: css('tokens.css'), base: css('base.css'), components: css('components.css'), features: css('features.css') };
const ALL = Object.values(FILES).join('\n');

/* ---- 變數解析 ---- */
const vars = {};
for (const m of FILES.tokens.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
function resolve(v, depth = 0) {
    v = String(v).trim();
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (m) { if (depth > 8 || !(m[1] in vars)) throw new Error('無法解析 ' + v); return resolve(vars[m[1]], depth + 1); }
    return v;
}
function toRgb(v) {
    v = resolve(v).toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(v);
    if (m) return [...m[1]].map(c => parseInt(c + c, 16));
    m = /^#([0-9a-f]{6})$/.exec(v);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    if (v === 'white') return [255, 255, 255];
    if (v === 'red') return [255, 0, 0];
    throw new Error('不支援的色值 ' + v);
}
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function ratio(a, b) {
    const x = lum(toRgb(a)), y = lum(toRgb(b));
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/* ---- 從 CSS 取出某選擇器某屬性的宣告值（選擇器需完全相符；同選擇器多條取最後一條） ---- */
function decl(selector, prop) {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[},\\n])\\s*(?:[^{}]*,\\s*)?${esc}\\s*(?:,[^{}]*)?\\{([^}]*)\\}`, 'g');
    let val = null;
    for (const m of ALL.matchAll(re)) {
        const d = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+?)\\s*(?:!important)?\\s*(?:;|$)`).exec(m[1]);
        if (d) val = d[1];
    }
    if (val == null) throw new Error(`找不到 ${selector} 的 ${prop}`);
    return val;
}

let failed = 0, passed = 0;
const rows = [];
/** 一組檢查：fg／bg 為 CSS 值（可含 var()）；before 為修前色碼與比值（審計報告）。 */
function check(name, fg, bg, min, before) {
    let r;
    try { r = ratio(fg, bg); } catch (e) { r = NaN; console.log('  ' + e.message); }
    const ok = r >= min;
    if (ok) passed++; else failed++;
    rows.push({ name, before, after: r, min, ok, fg: resolve(fg), bg: resolve(bg) });
    process.stdout.write(`${ok ? '✓' : '✗'} ${name}：${resolve(fg)} on ${resolve(bg)} = ${r.toFixed(2)}（需 ≥ ${min}）\n`);
}

/* 第 1 組：次要文字（--color-text-muted）放在頁面底／淺灰底（修前 #64748b on #f1f5f9 = 4.34） */
check('1a 次要文字 / 頁面底', 'var(--color-text-muted)', 'var(--color-bg)', 4.5, '4.34');
check('1b 次要文字 / 午休列灰底', 'var(--color-text-muted)', 'var(--c-n-200)', 4.5, '3.86');
check('1c 次要文字 / 白卡', 'var(--color-text-muted)', 'var(--color-surface)', 4.5, '4.76');
check('1d 課表當日科目（次要文字）/ 當日黃底', decl('.course-subject', 'color'), decl('.schedule-course.today-highlight', 'background-color'), 4.5, '4.27');

/* 第 2 組：鎖定頁籤（修前 opacity .5 → 1.96） */
check('2 鎖定頁籤文字 / 底色', decl('.tab-btn.is-locked', 'color'), decl('.tab-btn.is-locked', 'background-color'), 4.5, '1.96');
{
    let hasOpacity = true;
    try { decl('.tab-btn.is-locked', 'opacity'); } catch { hasOpacity = false; }
    if (!hasOpacity) passed++; else { failed++; console.log('✗ 2b 鎖定頁籤不得再用 opacity'); }
    process.stdout.write(`${hasOpacity ? '✗' : '✓'} 2b 鎖定頁籤不再用 opacity 降低對比\n`);
}

/* 第 3 組：白字在琥珀底的標籤（組長角色標籤、批次「B」標籤；修前 #fff on #d97706 = 3.19） */
check('3a 角色標籤「組長」', decl('.v2-role-tag.section_chief', 'color'), decl('.v2-role-tag.section_chief', 'background'), 4.5, '3.19');
check('3b 批次時段「B」標籤', 'var(--color-text-invert)', decl('.batch-slot-label-b', 'background'), 4.5, '3.19');

/* 第 4 組：推薦標籤「導師」「請假」（修前 #d97706 on #fef3c7 = 2.86） */
check('4a 推薦標籤「導師」', decl('.badge-homeroom', 'color'), decl('.badge-homeroom', 'background-color'), 4.5, '2.86');
check('4b 推薦標籤「請假」', decl('.badge-on-leave', 'color'), decl('.badge-on-leave', 'background-color'), 4.5, '2.86');

/* 第 5 組：綠字（推薦標籤「空堂」3.00、課表空堂 3.15／當日 2.96、月結算「+N」3.30／2.96） */
check('5a 推薦標籤「空堂」', decl('.badge-free', 'color'), decl('.badge-free', 'background-color'), 4.5, '3.00');
check('5b 課表「空堂」', decl('.schedule-course.free', 'color'), decl('.schedule-course.free', 'background-color'), 4.5, '3.15');
check('5c 課表當日「空堂」', decl('.schedule-course.today-highlight.free', 'color'), decl('.schedule-course.today-highlight', 'background-color'), 4.5, '2.96');
check('5d 月結算「+N」/ 白底', decl('.settlement-increase', 'color'), 'var(--color-surface)', 4.5, '3.30');
check('5e 月結算「+N」/ 變動列黃底', decl('.settlement-increase', 'color'), decl('.settlement-row-changed', 'background-color'), 4.5, '2.96');

/* 第 6 組：推薦項目選取後的理由文字（修前 rgba(255,255,255,.8) on #2563eb = 3.89） */
check('6 推薦項目選取後理由文字', decl('.recommendation-item.selected .recommendation-reason', 'color'), decl('.recommendation-item.selected', 'background-color'), 4.5, '3.89');

/* 第 7 組：月結算「-N」在變動列黃底（修前 #dc2626 on #fef3c7 = 4.34） */
check('7 月結算「-N」/ 變動列黃底', decl('.settlement-row-changed .settlement-decrease', 'color'), decl('.settlement-row-changed', 'background-color'), 4.5, '4.34');

/* 第 8 組：其餘小項 */
check('8a 批次空清單訊息 / 白底', decl('.batch-empty-message', 'color'), decl('.batch-empty-message', 'background'), 4.5, '2.56');
check('8b 必填星號 / 白底', decl('.required-mark', 'color'), 'var(--color-surface)', 4.5, '4.00');
check('8c 頁尾版權文字 / 白底（不再用 opacity）', 'var(--color-text-muted)', 'var(--color-surface)', 4.5, '3.24');
{
    let hasOpacity = true;
    try { decl('.footer .credit', 'opacity'); } catch { hasOpacity = false; }
    if (!hasOpacity) passed++; else failed++;
    process.stdout.write(`${hasOpacity ? '✗' : '✓'} 8c2 頁尾版權文字不再用 opacity\n`);
}

/* 非文字介面元件需 3:1 */
check('9a 焦點環 / 白底', decl(':focus-visible', 'outline').match(/(var\(--[\w-]+\)|#[0-9a-f]{3,6})\s*$/i)[1], 'var(--color-surface)', 3, '1.43');
check('9b 焦點環 / 頁面底', decl(':focus-visible', 'outline').match(/(var\(--[\w-]+\)|#[0-9a-f]{3,6})\s*$/i)[1], 'var(--color-bg)', 3, '1.43');
check('9c 輸入框框線 / 白底', decl('.form-group select', 'border-color'), 'var(--color-surface)', 3, '1.23');
check('9d 輸入框框線 / 淺灰底（卡片內）', decl('.form-group select', 'border-color'), 'var(--color-surface-2)', 3, '1.23');

/* 輸入框與按鈕的焦點樣式必須有 outline（不再 outline:none） */
for (const sel of ['.btn:focus-visible', '.form-group textarea:focus', '.data-table select:focus']) {
    const o = decl(sel, 'outline');
    const okOutline = /solid/.test(o) && !/none/.test(o);
    if (okOutline) passed++; else failed++;
    process.stdout.write(`${okOutline ? '✓' : '✗'} 焦點樣式 ${sel} 有可見外框：${o}\n`);
}

console.log('\n| 檢查 | 修前 | 修後 | 門檻 |\n|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.before} | ${r.after.toFixed(2)} | ${r.min} |`);
console.log(`\n結果：${passed} 通過，${failed} 失敗`);
process.exit(failed ? 1 : 0);
