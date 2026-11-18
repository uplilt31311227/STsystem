/**
 * 九年級已畢業設定（P7，審計 H5）：改存雲端 config/grade9，依學期重置，可設生效日期。
 *
 * 設定內容 { semesterId, enabled, effectiveDate }：
 *   - semesterId：設定當時的學期。只在該學期有效，換學期後視為未啟用（新學年的九年級是升上來的，不可沿用）。
 *   - enabled：是否啟用「九年級已畢業」。
 *   - effectiveDate：生效日（YYYY-MM-DD，可空白＝立即生效）。今天早於生效日時尚未生效。
 */

/**
 * @param {{semesterId?:string, enabled?:boolean, effectiveDate?:string}|null} cfg
 * @param {string|null} currentSemesterId
 * @param {string} today - YYYY-MM-DD（本地日期）
 * @returns {boolean} 目前是否應停用九年級課程
 */
export function isGrade9GraduationActive(cfg, currentSemesterId, today) {
    if (!cfg || cfg.enabled !== true) return false;
    if (!currentSemesterId || cfg.semesterId !== currentSemesterId) return false;
    const eff = String(cfg.effectiveDate || '');
    if (!eff) return true;
    return String(today || '') >= eff;
}

/** 設定要寫進雲端的內容（semesterId 一律取目前學期，不信任畫面）。 */
export function buildGrade9Config(currentSemesterId, enabled, effectiveDate) {
    const eff = String(effectiveDate || '').trim();
    if (eff && !/^\d{4}-\d{2}-\d{2}$/.test(eff)) {
        throw new Error('生效日期格式應為 YYYY-MM-DD');
    }
    return { semesterId: String(currentSemesterId || ''), enabled: !!enabled, effectiveDate: eff };
}

/**
 * 已設定但生效日在未來時，開關旁顯示的文字（審計 PL-21）。
 * 開關是否勾選看「有沒有設定」，不看「現在是否生效」；尚未生效時另外用這行字說明，
 * 避免組長設定好之後看到開關是未勾，以為沒存成功。
 * @param {boolean} enabled - 設定是否啟用
 * @param {string} effectiveDate - YYYY-MM-DD 或空白
 * @param {boolean} active - 目前是否已生效（isGrade9GraduationActive 的結果）
 * @returns {string} 未生效時的說明；其他情況回傳空字串
 */
export function grade9PendingLabel(enabled, effectiveDate, active) {
    if (!enabled || active) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(effectiveDate || ''));
    if (!m) return '';
    return `已設定，${Number(m[2])} 月 ${Number(m[3])} 日生效`;
}
