#!/usr/bin/env node
/**
 * 抓取教育部全國學校代碼（國小／國中／高中）→ src/data/school-codes.json
 *
 * 資料來源：https://teach.k12ea.gov.tw/qschool （ASP.NET WebForms + Telerik RadGrid）
 *   1. GET 頁面取得所有 hidden input（__VIEWSTATE 等）
 *   2. POST 回同網址，帶 __EVENTTARGET=RadGrid1、__EVENTARGUMENT=FireCommand:...;PageSize;5000
 *      一次拿到全部列。
 *
 * 輸出格式（為縮小檔案採簡寫鍵）：
 *   { source, fetchedAt, count,
 *     fields: { c:'代碼(小寫)', n:'主校名', l:'學制陣列', ct:'縣市', d:'行政區', a:'其他校名(同代碼合併)' },
 *     schools: [ { c, n, l:['國小'], ct, d, a?:['…'] } ] }
 *
 * 同代碼合併策略（高中與其附設國中共用代碼，約 7 筆）：
 *   合併成一筆；l 為所有學制（高中排前），n 取高中（或第一筆）校名為主名，
 *   其餘不同校名放進 a（搜尋時一併比對）。
 *
 * 安全：抓到筆數 < MIN_COUNT 時拒絕覆寫既有檔案。
 * 用法：node scripts/fetch-school-codes.mjs   （npm run update-school-codes）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_URL = 'https://teach.k12ea.gov.tw/qschool';
export const GRID_ID = 'ctl00$ContentPlaceHolder1$RadGrid1';
export const KEEP_LEVELS = ['高中', '國中', '國小'];   // 順序即合併時的主名優先序
export const MIN_COUNT = 3500;
export const KNOWN_LEVELS = ['國小', '國中', '高中', '大專校院', '科技中心'];
export const CODE_RE = /^[0-9a-z]{6,8}$/i;
/** 與舊檔相比筆數最多可掉多少比例，超過視為抓取異常。 */
export const MAX_DROP_RATIO = 0.10;

/**
 * 逐列驗證原始資料（欄位對調、改版時會在這裡被擋）：學制在已知清單；要保留的學制再驗代碼格式、縣市以市／縣結尾、校名非空。
 * @returns {string[]} 錯誤訊息（空陣列＝通過）
 */
export function validateRows(rows) {
    const errors = [];
    rows.forEach((r, i) => {
        const where = `第 ${i + 1} 列（${r.code}｜${r.name}）`;
        if (!KNOWN_LEVELS.includes(r.level)) { errors.push(`${where}：未知學制「${r.level}」`); return; }
        if (!KEEP_LEVELS.includes(r.level)) return;   // 大專校院、科技中心的代碼格式不同，且不會被保留，不驗
        if (!CODE_RE.test(r.code)) errors.push(`${where}：代碼格式不符`);
        else if (!/[市縣]$/.test(r.county)) errors.push(`${where}：縣市「${r.county}」不是以市／縣結尾`);
        else if (!r.name) errors.push(`${where}：校名為空`);
    });
    return errors;
}

/** 與舊檔比較：新筆數掉超過 MAX_DROP_RATIO 回傳錯誤訊息，否則 null。 */
export function checkAgainstPrevious(newCount, oldCount) {
    if (!oldCount || oldCount <= 0) return null;
    if (newCount < oldCount * (1 - MAX_DROP_RATIO)) {
        return `筆數由 ${oldCount} 掉到 ${newCount}（超過 ${MAX_DROP_RATIO * 100}%）`;
    }
    return null;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
export function decodeEntities(s) {
    return String(s).replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x([0-9a-fA-F]+)|#(\d+));/g, (m, hex, dec) => {
        if (hex) return String.fromCodePoint(parseInt(hex, 16));
        if (dec) return String.fromCodePoint(parseInt(dec, 10));
        return ENTITIES[m] ?? m;
    });
}

/** 取出頁面所有 hidden input 的 name→value。 */
export function parseHiddenFields(html) {
    const out = {};
    for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
        const tag = m[0];
        if (!/type="hidden"/i.test(tag)) continue;
        const name = /name="([^"]+)"/i.exec(tag)?.[1];
        if (!name) continue;
        out[name] = decodeEntities(/value="([^"]*)"/i.exec(tag)?.[1] ?? '');
    }
    return out;
}

/** 解析 RadGrid 列 → [{code,name,level,county,district,type}] */
export function parseRows(html) {
    const rows = [];
    for (const tr of html.matchAll(/<tr class="rg(?:Alt)?Row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)) {
        const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
            .map(c => decodeEntities(c[1].replace(/<[^>]+>/g, '')).trim());
        if (cells.length < 5) continue;
        rows.push({ code: cells[0], name: cells[1], level: cells[2], county: cells[3], district: cells[4], type: cells[5] || '' });
    }
    return rows;
}

/** 過濾學制並以小寫代碼合併重複代碼，回傳緊湊 schools 陣列（依代碼排序）。 */
export function buildSchools(rows) {
    const byCode = new Map();
    for (const r of rows) {
        if (!KEEP_LEVELS.includes(r.level) || !r.code || !r.name) continue;
        const c = r.code.toLowerCase();
        let e = byCode.get(c);
        if (!e) { e = { c, items: [] }; byCode.set(c, e); }
        e.items.push(r);
    }
    const out = [];
    for (const { c, items } of byCode.values()) {
        items.sort((x, y) => KEEP_LEVELS.indexOf(x.level) - KEEP_LEVELS.indexOf(y.level));
        const main = items[0];
        const rec = { c, n: main.name, l: [...new Set(items.map(i => i.level))], ct: main.county, d: main.district };
        const alts = [...new Set(items.map(i => i.name).filter(n => n !== main.name))];
        if (alts.length) rec.a = alts;
        out.push(rec);
    }
    out.sort((a, b) => (a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
    return out;
}

export function buildDataset(rows, fetchedAt = new Date().toISOString()) {
    const schools = buildSchools(rows);
    return {
        source: SOURCE_URL,
        fetchedAt,
        count: schools.length,
        fields: { c: '代碼(小寫)', n: '主校名', l: '學制陣列', ct: '縣市', d: '行政區', a: '同代碼其他校名' },
        schools,
    };
}

async function fetchAll(fetchImpl = fetch) {
    const ua = { 'User-Agent': 'Mozilla/5.0 (STsystem school-code updater)' };
    const r1 = await fetchImpl(SOURCE_URL, { headers: ua });
    if (!r1.ok) throw new Error(`GET 失敗 ${r1.status}`);
    // 伺服器以 cookie（__AntiXsrfToken 等）驗證表單，必須帶回
    const cookie = (r1.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    if (cookie) ua.Cookie = cookie;
    const fields = parseHiddenFields(await r1.text());
    fields.__EVENTTARGET = GRID_ID;
    fields.__EVENTARGUMENT = `FireCommand:${GRID_ID}$ctl00;PageSize;5000`;
    const r2 = await fetchImpl(SOURCE_URL, {
        method: 'POST',
        headers: { ...ua, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
    });
    if (!r2.ok) throw new Error(`POST 失敗 ${r2.status}`);
    return parseRows(await r2.text());
}

async function main() {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const outFile = path.join(root, 'src', 'data', 'school-codes.json');
    const rows = await fetchAll();
    const rowErrors = validateRows(rows);
    if (rowErrors.length) {
        console.error(`資料驗證失敗（${rowErrors.length} 筆不符），拒絕覆寫。前 10 筆：`);
        console.error(rowErrors.slice(0, 10).join('\n'));
        process.exit(1);
    }
    const data = buildDataset(rows);
    console.log(`列數 ${rows.length}，合併後 ${data.count} 校`);
    let oldCount = 0;
    try { oldCount = JSON.parse(fs.readFileSync(outFile, 'utf8')).count || 0; } catch (_) { /* 沒有舊檔 */ }
    const dropMsg = checkAgainstPrevious(data.count, oldCount);
    if (dropMsg) { console.error(`${dropMsg}，拒絕覆寫 ${outFile}`); process.exit(1); }
    if (data.count < MIN_COUNT) {
        console.error(`筆數異常偏低（${data.count} < ${MIN_COUNT}），拒絕覆寫 ${outFile}`);
        process.exit(1);
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    // 每校一行：diff 友善且比縮排小
    const body = data.schools.map(s => '    ' + JSON.stringify(s)).join(',\n');
    const head = JSON.stringify({ source: data.source, fetchedAt: data.fetchedAt, count: data.count, fields: data.fields });
    fs.writeFileSync(outFile, head.slice(0, -1) + ',\n  "schools": [\n' + body + '\n  ]\n}\n', 'utf8');
    console.log(`已寫入 ${outFile}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(e => { console.error(e); process.exit(1); });
}
