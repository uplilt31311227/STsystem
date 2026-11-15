/**
 * 月結算輸入準備（純邏輯，node 可測）：依「月份所屬學期」取課表與名冊，並讀當月紀錄與設定。
 *
 * 規則：
 *   - 月份所屬學期以該月 1 日推導（8～1 月為上學期、2～7 月為下學期，見 semesterUtils.dateToSemesterId）。
 *   - 課表與名冊一律取該學期的；取不到（該學期沒有課表，或課表是空的）丟 SettlementScheduleMissing，不退回目前學期的資料。
 *   - 紀錄查詢帶 fresh:true：金額計算不吃日期範圍查詢快取。
 * 讀取量：目前學期 0 次額外讀取；其他學期 1 次課表文件（dataManager 內快取）；紀錄 1 次範圍查詢；設定 1 次文件讀取（與修前相同）。
 */
import { dateToSemesterId, compareSemesterId } from './v2/semesterUtils.js';

/**
 * 缺課表時給使用者的提示文字（純函式，可測）。
 * 缺的學期比目前學期早＝歷史學期（無法補匯入）；比目前學期晚＝尚未開始；其餘（目前學期，或不知目前學期）＝請先匯入。
 */
export function settlementMissingMessage(err, currentSemesterId) {
    const sid = (err && err.semesterId) || '該月所屬';
    const cmp = (currentSemesterId && err && err.semesterId) ? compareSemesterId(err.semesterId, currentSemesterId) : 0;
    if (cmp > 0) return `找不到 ${sid} 學期的課表：該學期尚未開始，沒有課表可計算，未產生結算。`;
    if (cmp < 0) return `找不到 ${sid} 學期的課表，無法計算該月的原定時數，未產生結算。歷史學期的課表無法補匯入，如需結算此月份請洽系統管理者。`;
    return `找不到 ${sid} 學期的課表，無法計算該月的原定時數，未產生結算（不會改用其他學期的課表代算）。請先匯入該學期課表`;
}

/**
 * @param {Object} p
 * @param {import('./settlementCalculator.js').SettlementCalculator} p.calculator
 * @param {Object} p.dataManager - 需有 getSubstituteRecordsAsync、getSettlementSemesterData
 * @param {number|string} p.year - 學年度（民國）
 * @param {number|string} p.month
 * @param {() => Promise<Object|null>} p.applyConfig - 套用週數覆寫並回傳設定（V1 回 null）
 * @returns {Promise<{records:Array, opts:Object, semesterId:string}>}
 */
export async function prepareSettlementInputs({ calculator, dataManager, year, month, applyConfig }) {
    const { startDate, endDate } = calculator.getMonthDateRange(year, month);
    const semesterId = dateToSemesterId(startDate);
    const records = await dataManager.getSubstituteRecordsAsync(startDate, endDate, '', { fresh: true });
    const cfg = applyConfig ? await applyConfig() : null;
    const data = await dataManager.getSettlementSemesterData(semesterId);
    // 課表不存在，或是空殼（長度 0，例如「開新學期」產生、尚未匯入課表的學期）：都視為沒有課表，不產生全 0 的結算
    if (!data || !Array.isArray(data.schedule) || data.schedule.length === 0) {
        throw Object.assign(new Error(`找不到 ${semesterId} 學期的課表`), { name: 'SettlementScheduleMissing', semesterId });
    }
    const opts = {
        segments: [{ semesterId, schedule: data.schedule, teachers: data.teachers || [], weeks: calculator.getWeeksInMonth(year, month) }],
        weeklyBaseByTeacher: (cfg && cfg.weeklyBaseByTeacher) || {},
    };
    return { records, opts, semesterId };
}
