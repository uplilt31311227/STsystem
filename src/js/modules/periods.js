/**
 * 節次共用常數（審計 LC-L13／UX-M9）
 *
 * 解析器支援到第八節，所有排序、下拉選單、多節代課的節次順序一律從這裡取，
 * 不要各處再寫死 ['第一節', ... '第七節']。
 */
export const PERIOD_ORDER = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節'];

/** 節次排序索引；不在清單內的節次排最後。 */
export function periodIndex(period) {
    const i = PERIOD_ORDER.indexOf(period);
    return i < 0 ? PERIOD_ORDER.length : i;
}
