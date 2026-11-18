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
 * 純函式：不修改傳入的陣列或物件。
 *
 * @param {Array} oldTeachers - 匯入前的名冊
 * @param {Array} newTeachers - 解析結果的名冊
 * @returns {Array} 新的名冊陣列
 */
import { normalizeTeacherName } from './teacherName.js';

export function mergeTeacherAttributes(oldTeachers, newTeachers) {
    const oldByName = new Map();
    for (const t of oldTeachers || []) {
        const key = normalizeTeacherName(t && t.name);
        if (key && !oldByName.has(key)) oldByName.set(key, t);
    }
    return (newTeachers || []).map(t => {
        const merged = { ...t, domains: [...(t.domains || [])] };
        const old = oldByName.get(normalizeTeacherName(t.name));
        if (!old) return merged;
        if (!merged.homeroomClass && old.homeroomClass) merged.homeroomClass = old.homeroomClass;
        for (const d of old.domains || []) {
            if (d && !merged.domains.includes(d)) merged.domains.push(d);
        }
        if (old.partTime) merged.partTime = true;
        return merged;
    });
}
