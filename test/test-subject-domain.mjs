/**
 * 科目↔領域對應表邏輯單元測試（獨立複製 dataManager 的實作邏輯驗證）
 * 執行：node test/test-subject-domain.mjs
 */

// ---- 與 dataManager.js 相同的核心邏輯 ----
function buildSubjectDomainMap(scheduleData, existingMap, merge = true) {
    const counts = {};
    scheduleData.forEach(c => {
        const subject = (c.subject || '').trim();
        const domain = (c.domain || '').trim();
        if (!subject) return;
        if (!counts[subject]) counts[subject] = {};
        if (domain) counts[subject][domain] = (counts[subject][domain] || 0) + 1;
    });
    const built = {};
    for (const [subject, domainCounts] of Object.entries(counts)) {
        built[subject] = Object.entries(domainCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([d]) => d);
    }
    if (merge && existingMap) {
        for (const [subject, domains] of Object.entries(existingMap)) {
            if (!built[subject]) {
                built[subject] = [...domains];
            } else {
                const merged = [...domains];
                built[subject].forEach(d => { if (!merged.includes(d)) merged.push(d); });
                built[subject] = merged;
            }
        }
    }
    return built;
}

function setSubjectDomains(map, subject, domains) {
    subject = (subject + '').trim();
    if (!subject) return map;
    // 不可用「/」分隔，領域名本身可能含斜線
    const list = Array.isArray(domains) ? domains : (domains + '').split(/[,，、]/);
    map[subject] = list.map(d => (d + '').trim()).filter((d, i, arr) => d && arr.indexOf(d) === i);
    return map;
}

let pass = 0, fail = 0;
function eq(actual, expected, label) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.error(`✗ ${label}：預期 ${e}，實得 ${a}`); }
}

// ---- 基本擷取 ----
const schedule = [
    { subject: '國語文', domain: '語文領域' },
    { subject: '國語文', domain: '語文領域' },
    { subject: '數學', domain: '數學領域' },
    { subject: '生物', domain: '自然科學領域' },
    { subject: '', domain: '語文領域' },          // 無科目 → 略過
    { subject: '統整性主題/專題/議題探究', domain: '彈性學習' },
];
const map1 = buildSubjectDomainMap(schedule, null, false);
eq(map1['國語文'], ['語文領域'], '國語文→語文領域');
eq(map1['數學'], ['數學領域'], '數學→數學領域');
eq(map1['生物'], ['自然科學領域'], '生物→自然科學領域');
eq(map1['統整性主題/專題/議題探究'], ['彈性學習'], '非標準科目仍擷取');
eq(Object.keys(map1).length, 4, '無科目者被略過（共 4 科）');

// ---- 一科目多領域，依出現次數降序 ----
const multi = [
    { subject: '彈性課', domain: '語文領域' },
    { subject: '彈性課', domain: '語文領域' },
    { subject: '彈性課', domain: '語文領域' },
    { subject: '彈性課', domain: '彈性學習' },
];
const map2 = buildSubjectDomainMap(multi, null, false);
eq(map2['彈性課'], ['語文領域', '彈性學習'], '多領域依次數降序（語文 3 > 彈性 1）');

// ---- 合併保留手動編輯 ----
const existing = { '自訂科目': ['自訂領域'], '數學': ['數學領域', '手動補的領域'] };
const map3 = buildSubjectDomainMap(schedule, existing, true);
eq(map3['自訂科目'], ['自訂領域'], '合併：保留只在既有表的手動科目');
eq(map3['數學'], ['數學領域', '手動補的領域'], '合併：保留既有順序，union 新領域');
eq(map3['國語文'], ['語文領域'], '合併：新課表科目照常擷取');

// ---- setSubjectDomains 解析分隔符（、, ，）並去重 ----
let m = {};
setSubjectDomains(m, '社會', '歷史、地理,公民，重複、重複');
eq(m['社會'], ['歷史', '地理', '公民', '重複'], '多分隔符解析並去重');
setSubjectDomains(m, ' 體育 ', ['健康與體育領域']);
eq(m['體育'], ['健康與體育領域'], '科目前後空白 trim');
// 領域名含斜線不可被拆碎
setSubjectDomains(m, '彈性', '統整性主題/專題/議題探究');
eq(m['彈性'], ['統整性主題/專題/議題探究'], '含斜線領域名保持完整');

console.log(`\n結果：通過 ${pass}，失敗 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
