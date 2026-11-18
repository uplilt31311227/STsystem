/**
 * 重新匯入課表時，把既有名冊的人工設定合併回新名冊（審計 LC-M5）
 *
 * 課表檔只含「誰在什麼時候教什麼」，不含導師班級與手動設定的任教領域；解析器產出的教師
 * homeroomClass 恆為空字串。若直接以新名冊取代，組長設好的導師班與領域會被洗掉，
 * 推薦的第 2 層（該班導師）就無聲失效。
 *
 * 合併規則（依正規化姓名對應）：
 *   - homeroomClass：新名冊有值就用新的（匯入資料較新）；新名冊為空則保留既有
 *   - domains：聯集。新名冊的領域在前（反映最新課表），既有領域中新名冊沒有的補在後面
 *     （這些多半是手動設定）。代價是課表已不再出現的舊領域不會自動消失，需要手動移除
 *   - partTime：既有為真就帶回（沿用原行為）
 *   - 其他欄位：既有教師的未知欄位不帶回；新名冊的欄位原樣保留
 * 不在新課表上的既有教師不加回名冊：加回會讓已不任教者以「全天空堂」身分出現在代課推薦。
 *
 * 例外（需人工確認）：既有名冊裡有「正規化後同名、但原字串不同」的多筆（例如「李小華」與「李　小華」並存），
 * 而新名冊的姓名又和其中任何一筆的原字串都不完全相同，就無法判斷該用哪一筆的導師班與領域。
 * 這種姓名不合併（新名冊的資料原樣保留），由 findAmbiguousTeacherNames() 回報，呼叫端提示組長手動確認。
 * 新名冊的姓名與既有某一筆「原字串完全相同」時不算歧義：直接用那一筆（原字串相同的重複筆沿用第一筆）。
 *
 * 純函式：不修改傳入的陣列或物件。
 *
 * @param {Array} oldTeachers - 匯入前的名冊
 * @param {Array} newTeachers - 解析結果的名冊
 * @returns {Array} 新的名冊陣列
 */
import { normalizeTeacherName } from './teacherName.js';


/** 既有名冊依正規化姓名分組：key → { first, names:Set(原字串) } */
function groupOldByName(oldTeachers) {
    const groups = new Map();
    for (const t of oldTeachers || []) {
        const key = normalizeTeacherName(t && t.name);
        if (!key) continue;
        const g = groups.get(key);
        if (!g) groups.set(key, { first: t, names: new Set([String(t.name)]) });
        else g.names.add(String(t.name));
    }
    return groups;
}

/**
 * 找出「新名冊上的教師，在既有名冊裡對到多筆原字串不同的舊資料」的姓名（需人工確認，不會自動合併）。
 * @returns {Array<{name:string, candidates:string[]}>} name 是新名冊上的姓名，candidates 是既有名冊的各種寫法
 */
export function findAmbiguousTeacherNames(oldTeachers, newTeachers) {
    const groups = groupOldByName(oldTeachers);
    const out = [];
    const seen = new Set();
    for (const t of newTeachers || []) {
        const key = normalizeTeacherName(t && t.name);
        const g = key && groups.get(key);
        if (g && g.names.size > 1 && !g.names.has(String(t.name)) && !seen.has(key)) {
            seen.add(key);
            out.push({ name: String(t.name), candidates: [...g.names] });
        }
    }
    return out;
}

export function mergeTeacherAttributes(oldTeachers, newTeachers) {
    const oldByName = new Map();
    for (const [key, g] of groupOldByName(oldTeachers)) {
        if (g.names.size === 1) oldByName.set(key, g.first);   // 只有一種寫法：照舊以正規化姓名對應
    }
    // 原字串完全相同優先（第一筆）；多種寫法並存而新名冊沒有任何一筆完全相同的，才不合併
    const oldExact = new Map();
    for (const t of oldTeachers || []) {
        const n = t && t.name != null ? String(t.name) : '';
        if (n && !oldExact.has(n)) oldExact.set(n, t);
    }
    return (newTeachers || []).map(t => {
        const merged = { ...t, domains: [...(t.domains || [])] };
        const key = normalizeTeacherName(t.name);
        const old = oldByName.get(key) || (t.name != null ? oldExact.get(String(t.name)) : undefined);
        if (!old) return merged;
        if (!merged.homeroomClass && old.homeroomClass) merged.homeroomClass = old.homeroomClass;
        for (const d of old.domains || []) {
            if (d && !merged.domains.includes(d)) merged.domains.push(d);
        }
        if (old.partTime) merged.partTime = true;
        return merged;
    });
}
