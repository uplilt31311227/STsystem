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
