/** 學校代碼：parser／合併（scripts/fetch-school-codes.mjs）與搜尋／別名（schoolCodes.js）單元測試。 */
import fs from 'node:fs';
import { parseRows, parseHiddenFields, buildSchools, buildDataset, validateRows, checkAgainstPrevious, MIN_COUNT } from '../scripts/fetch-school-codes.mjs';
import { approveApplication } from '../src/js/modules/v2/schoolApplicationService.js';
import {
    normalizeQuery, searchSchools, schoolIdForCode, codeForSchoolId, findSchoolById,
    loadSchoolCodes, _resetSchoolCodesCache,
} from '../src/js/modules/v2/schoolCodes.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n  got ${JSON.stringify(a)}\n  exp ${JSON.stringify(b)}`);

/* ---- parser ---- */
const tr = (cls, ...c) => `<tr class="${cls}" id="x">${c.map(v => `<td>${v}</td>`).join('')}</tr>`;
const html = `
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="abc&amp;def==" />
<input name="__EVENTVALIDATION" type="hidden" value="ev1" />
<input type="text" name="q" value="no" />
<table>
${tr('rgRow', '183511', '市立內湖國中', '國中', '新竹市', '香山區', '一般')}
${tr('rgAltRow', '011314', '新北市福瑞斯特高中', '高中', '新北市', '土城區', '')}
${tr('rgRow', '011314', '財團法人福瑞斯特高中附設國中', '國中', '新北市', '土城區', '')}
${tr('rgAltRow', '011301a', '某國小A', '國小', '新北市', '板橋區', '偏遠')}
${tr('rgRow', '011302A', '某國小B', '國小', '新北市', '板橋區', '')}
${tr('rgRow', '999999', '某大學', '大專校院', '臺北市', '大安區', '')}
${tr('rgRow', '888888', 'A&amp;B 國小', '國小', '臺北市', '大安區', '')}
</table>`;
eq(parseHiddenFields(html), { __VIEWSTATE: 'abc&def==', __EVENTVALIDATION: 'ev1' }, 'hidden 欄位含實體解碼、屬性順序不拘');
const rows = parseRows(html);
eq(rows.length, 7, '解析 7 列');
eq(rows[0], { code: '183511', name: '市立內湖國中', level: '國中', county: '新竹市', district: '香山區', type: '一般' }, '第一列欄位');
eq(rows[1].type, '', '空 type');
eq(rows[6].name, 'A&B 國小', '校名實體解碼');

/* ---- 合併 ---- */
const schools = buildSchools(rows);
eq(schools.length, 5, '過濾大專後、同代碼合併 → 5 筆（011314 合併）');
const merged = schools.find(s => s.c === '011314');
eq(merged.l, ['高中', '國中'], '合併學制（高中在前）');
eq(merged.n, '新北市福瑞斯特高中', '主名取高中');
eq(merged.a, ['財團法人福瑞斯特高中附設國中'], '另一校名放 a');
ok(schools.some(s => s.c === '011301a') && schools.some(s => s.c === '011302a'), '代碼轉小寫');
ok(!schools.some(s => s.c === '999999'), '大專被過濾');
ok(schools.every(s => /^[a-z0-9_-]{1,50}$/.test(schoolIdForCode(s.c))), 'schoolId 符合規則格式');
const ds = buildDataset(rows, '2026-01-01T00:00:00.000Z');
eq([ds.count, ds.fetchedAt, typeof ds.source], [5, '2026-01-01T00:00:00.000Z', 'string'], 'dataset 中繼欄位');
ok(MIN_COUNT >= 3500, '筆數下限守門值');

/* ---- normalize ---- */
eq(normalizeQuery(' 臺北　市 ＡＢＣ１２３ '), '台北市abc123', '臺→台、全形→半形、去空白（含全形空白）、小寫');

/* ---- search ---- */
const L = [
    { c: '183511', n: '市立內湖國中', l: ['國中'], ct: '新竹市', d: '香山區' },
    { c: '011314', n: '新北市福瑞斯特高中', l: ['高中', '國中'], ct: '新北市', d: '土城區', a: ['財團法人福瑞斯特高中附設國中'] },
    { c: '321999', n: '臺北市內湖國小', l: ['國小'], ct: '臺北市', d: '內湖區' },
    { c: '183500', n: '新竹國小', l: ['國小'], ct: '新竹市', d: '東區' },
    { c: '18351a', n: '另一所學校', l: ['國小'], ct: '新竹縣', d: '竹北市' },
];
eq(searchSchools(L, '183511').map(s => s.c), ['183511'], '代碼完全相符');
eq(searchSchools(L, '1835').map(s => s.c), ['183500', '183511', '18351a'], '代碼開頭、依代碼排序');
eq(searchSchools(L, '18351')[0].c, '183511', '代碼前綴 18351（排序）');
eq(searchSchools(L, '18351A').map(s => s.c), ['18351a'], '代碼不分大小寫');
eq(searchSchools(L, '內湖').map(s => s.c), ['183511', '321999'].sort(), '校名包含');
eq(searchSchools(L, '台北市內湖').map(s => s.c), ['321999'], '台 = 臺（縣市+校名組合）');
eq(searchSchools(L, '臺北內湖').map(s => s.c), ['321999'], '臺北內湖（縣市簡寫）');
eq(searchSchools(L, '新竹 內湖').map(s => s.c), ['183511'], '縣市+校名（有空白）');
eq(searchSchools(L, '新竹內湖').map(s => s.c), ['183511'], '縣市+校名（無空白）');
eq(searchSchools(L, '新竹市內湖國中').map(s => s.c), ['183511'], '完整縣市+校名');
eq(searchSchools(L, '１８３５１１').map(s => s.c), ['183511'], '全形數字');
eq(searchSchools(L, '福瑞斯特高中附設').map(s => s.c), ['011314'], '同代碼其他校名可搜到');
eq(searchSchools(L, '不存在的學校'), [], '無結果');
eq(searchSchools(L, '   '), [], '空查詢');
eq(searchSchools(L, '國', 2).length, 2, 'limit 生效');
// 排序：代碼完全相符 > 代碼開頭 > 校名包含
const R = [
    { c: '999001', n: '含183500的校名', l: ['國小'], ct: 'x', d: 'y' },
    { c: '183500x', n: 'p', l: ['國小'], ct: 'x', d: 'y' },
    { c: '183500', n: 'q', l: ['國小'], ct: 'x', d: 'y' },
];
eq(searchSchools(R, '183500').map(s => s.c), ['183500', '183500x', '999001'], '排序：完全 > 開頭 > 名稱包含');

/* ---- 別名 ---- */
eq(schoolIdForCode('183511'), 'inhu', '183511 → inhu');
eq(schoolIdForCode('011301A'), '011301a', '其他代碼小寫');
eq(codeForSchoolId('inhu'), '183511', 'inhu 反查代碼');
eq(findSchoolById(L, 'inhu')?.n, '市立內湖國中', 'findSchoolById 經別名');
eq(findSchoolById(L, 'nonexistent'), null, 'findSchoolById 查無');

/* ---- loadSchoolCodes（注入 fetch、快取、錯誤） ---- */
let calls = 0;
const good = async () => { calls++; return { ok: true, json: async () => ({ schools: L }) }; };
_resetSchoolCodesCache();
const a = await loadSchoolCodes({ fetchImpl: good, url: 'x' });
const b = await loadSchoolCodes({ fetchImpl: good, url: 'x' });
ok(a === b && calls === 1, '快取：只 fetch 一次');
_resetSchoolCodesCache();
let threw = false;
try { await loadSchoolCodes({ fetchImpl: async () => ({ ok: false, status: 404 }), url: 'x' }); } catch (e) { threw = /404/.test(e.message); }
ok(threw, 'HTTP 錯誤會丟出');
const again = await loadSchoolCodes({ fetchImpl: good, url: 'x' });
ok(again.length === L.length, '失敗不快取，可重試');
_resetSchoolCodesCache();
threw = false;
try { await loadSchoolCodes({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }), url: 'x' }); } catch (_) { threw = true; }
ok(threw, '格式不對會丟出');
_resetSchoolCodesCache();

/* ---- 實際資料檔 ---- */
const data = JSON.parse(fs.readFileSync(new URL('../src/data/school-codes.json', import.meta.url), 'utf8'));
ok(data.count === data.schools.length && data.count >= MIN_COUNT, `資料檔筆數 ${data.count}`);
ok(data.schools.every(s => /^[a-z0-9_-]{1,50}$/.test(s.c)), '資料檔代碼皆合規');
ok(new Set(data.schools.map(s => s.c)).size === data.schools.length, '資料檔代碼無重複');
const inhu = data.schools.find(s => s.c === '183511');
ok(inhu && inhu.ct === '新竹市' && schoolIdForCode(inhu.c) === 'inhu', '資料檔含 183511（新竹市）→ inhu');
ok(searchSchools(data.schools, '新竹 內湖').some(s => s.c === '183511'), '實際資料：新竹 內湖 找得到');
ok(searchSchools(data.schools, '內湖', 100).some(s => s.c === '183511'), '實際資料：內湖 找得到');

/* ---- S2：全稱簡稱同義 ---- */
eq(normalizeQuery('新竹市立內湖國民中學'), '新竹市立內湖國中', '國民中學→國中');
eq(normalizeQuery('某某國民小學'), '某某國小', '國民小學→國小');
eq(normalizeQuery('臺北市立建國高級中學'), '台北市立建國高中', '高級中學→高中（含臺→台）');
eq(searchSchools(data.schools, '新竹市立內湖國民中學')[0]?.c, '183511', '實際資料：全稱「新竹市立內湖國民中學」找得到 183511');
eq(searchSchools(L, '市立內湖國民中學').map(s => s.c), ['183511'], '全稱查詢對簡稱校名');

/* ---- S5：結果與快取無關（重複查詢一致） ---- */
eq(searchSchools(L, '內湖').map(s => s.c), searchSchools(L, '內湖').map(s => s.c), '重複查詢結果一致');

/* ---- S4：抓取結果驗證 ---- */
const goodRow = { code: '183511', name: '市立內湖國中', level: '國中', county: '新竹市', district: '香山區', type: '' };
eq(validateRows([goodRow]), [], '正常列通過');
eq(validateRows([{ code: '0001', name: '某大學', level: '大專校院', county: '臺北市', district: '', type: '' }]), [], '大專的短代碼不驗（不保留）');
ok(validateRows([{ ...goodRow, code: '新竹市', county: '183511' }]).length === 1, '欄位對調（代碼與縣市互換）被擋');
ok(validateRows([{ ...goodRow, level: '香山區', district: '國中' }]).length === 1, '欄位對調（學制與行政區互換）被擋');
ok(validateRows([{ ...goodRow, county: '香山區' }]).length === 1, '縣市不以市／縣結尾被擋');
ok(validateRows([{ ...goodRow, name: '' }]).length === 1, '校名為空被擋');
ok(validateRows([goodRow, { ...goodRow, code: 'zz' }]).length === 1, '只回報有問題的列');
eq(checkAgainstPrevious(3800, 4008), null, '掉 5% 可接受');
ok(/掉到 3500/.test(checkAgainstPrevious(3500, 4008) || ''), '掉超過 10% 拒寫');
eq(checkAgainstPrevious(100, 0), null, '無舊檔不比較');

/* ---- M1：別名代碼不可核准建校 ---- */
let aliasErr = null;
try {
    await approveApplication({ uid: 'u1', applicantEmail: 'a@b.c', schoolName: '市立內湖國中', desiredSchoolId: '183511' }, { reviewer: { uid: 'r' } });
} catch (e) { aliasErr = e; }
ok(aliasErr && /對應既有學校「inhu」/.test(aliasErr.message), `approveApplication 拒絕別名代碼 183511（${aliasErr?.message}）`);

console.log(`school-codes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
