/**
 * 月結算「手算黃金資料」——單元層（test/test-settlement.mjs）與畫面層（e2e-06）共用。
 *
 * ⚠ 期望值全部由人依規則手算後寫死，不得改成呼叫 SettlementCalculator 產生。
 *
 * ── 結算規則（讀 src/js/modules/settlementCalculator.js 整理）──
 *  1. 一筆紀錄 = 一節課（多節代課 = 多筆紀錄）。
 *  2. 紀錄歸月依 record.date 的 `YYYY-MM` 前綴；學年度 115、月份 10 → 2026-10（8~12 月屬學年度本年，1~7 月屬次年）。
 *     不看 semesterId、不看 swapDate。
 *  3. 原定時數 = 該教師在課表的列數（每列 = 每週一節）× 當月週數；一般月 4 週，1 月 2 週、2 月 3 週、7/8 月 0 週。
 *  4. 代課增加 = 當月 substituteTeacher 是本人、且 type 不是 swap/調課 的筆數（不論假別）。
 *  5. 被代課減少 = 當月 originalTeacher 是本人、type 不是調課、且 leaveType 不在
 *     {official,longsick,funeral,swap,公假,長期病假,喪假,調課} 的筆數（事假/病假/休假/其他/缺假別 才扣）。
 *  6. 實際 = 原定 + 增加 − 減少；超鐘點 = max(0, 實際 − 每週基本 20 節 × 週數)。
 *  7. 計算器不看 status／deleted：駁回的請求存在 pendingRequests 集合、刪除的紀錄文件已不存在，
 *     兩者都是在資料層就被排除，不會進入計算器。
 *  8. 兼課（partTime）教師與一般教師同一套算法，沒有差別。
 */

/** 課表：每位教師的「每週節數」。weekdays × periods 排出不重複的格子。 */
export const GOLDEN_WEEKLY = {
    '林彥廷': 6,    // A
    '王大明': 5,    // B
    '張淑芬': 3,    // C
    '黃志偉': 21,   // D：21 × 4 = 84 > 80，有超鐘點
    '吳佩珊': 20,   // E：20 × 4 = 80，剛好在門檻
};

const WEEKDAYS = ['週一', '週二', '週三', '週四', '週五'];
const PERIODS  = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節'];

/** 依 GOLDEN_WEEKLY 產生課表列（解析後格式）。 */
export function buildGoldenSchedule() {
    const rows = [];
    let classNo = 0;
    for (const [teacher, n] of Object.entries(GOLDEN_WEEKLY)) {
        classNo++;
        for (let i = 0; i < n; i++) {
            rows.push({
                weekday: WEEKDAYS[i % 5],
                period: PERIODS[Math.floor(i / 5)],
                className: `${7 + (classNo % 3)}年${classNo}班`,
                teacher,
                domain: '數學領域', subject: '數學', rawSubject: '數學', courseName: '', category: '',
            });
        }
    }
    return rows;
}

/**
 * 紀錄。每筆的 `note` 說明它在結算 115 學年度 10 月時的角色（A=林彥廷 B=王大明 C=張淑芬 D=黃志偉 E=吳佩珊）。
 * `inScope`：是否會進入「2026-10」的計算（false = 該被排除）。
 */
export const GOLDEN_RECORDS = [
    // ---- 單節代課 ----
    { id: 'g01', date: '2026-10-05', type: '代課', orig: 'A', sub: 'B', leave: '事假', inScope: true,
      note: '單節代課：B 代 A，事假 → B 增加 +1、A 減少 +1' },
    // ---- 多節代課（同日同教師三節，兩節病假一節公假）----
    { id: 'g02', date: '2026-10-06', type: '代課', orig: 'A', sub: 'C', leave: '病假', inScope: true,
      note: '多節 1/3：C 代 A，病假 → C +1、A 減 1' },
    { id: 'g03', date: '2026-10-06', type: '代課', orig: 'A', sub: 'C', leave: '病假', inScope: true,
      note: '多節 2/3：C 代 A，病假 → C +1、A 減 1' },
    { id: 'g04', date: '2026-10-06', type: '代課', orig: 'A', sub: 'C', leave: '公假', inScope: true,
      note: '多節 3/3：C 代 A，公假 → C +1、A 不扣（公付）' },
    // ---- 調課：不增不減 ----
    { id: 'g05', date: '2026-10-07', type: '調課', orig: 'A', sub: 'B', leave: '調課', inScope: true,
      note: '調課：A、B 互換，兩人皆不變' },
    // ---- 同一教師多筆（B 一共代 3 節：g01、g06、g07）----
    { id: 'g06', date: '2026-10-08', type: '代課', orig: 'C', sub: 'B', leave: '事假', inScope: true,
      note: 'B 第 2 節代課；C 事假被代 → C 減 1' },
    { id: 'g07', date: '2026-10-12', type: '代課', orig: 'D', sub: 'B', leave: '喪假', inScope: true,
      note: 'B 第 3 節代課；D 喪假不扣' },
    // ---- 月邊界：10/1 與 10/31 都算 10 月 ----
    { id: 'g08', date: '2026-10-31', type: '代課', orig: 'A', sub: 'C', leave: '事假', inScope: true,
      note: '10/31（月末）：C +1、A 減 1' },
    { id: 'g09', date: '2026-10-01', type: '代課', orig: 'B', sub: 'C', leave: '長期病假', inScope: true,
      note: '10/1（月初）：C +1、B 長期病假不扣' },
    // ---- 超鐘點邊界：E 剛好 80 節，被代一節公假的 D 不扣 ----
    { id: 'g10', date: '2026-10-13', type: '代課', orig: 'D', sub: 'E', leave: '公假', inScope: true,
      note: 'E +1 → 81 節，超鐘點 1；D 公假不扣' },
    // ---- 跨月／跨年：全部該被排除 ----
    { id: 'x01', date: '2026-09-30', type: '代課', orig: 'A', sub: 'B', leave: '事假', inScope: false,
      note: '9/30（前一月）：不算 10 月' },
    { id: 'x02', date: '2026-11-02', type: '代課', orig: 'A', sub: 'B', leave: '事假', inScope: false,
      note: '11/2（後一月）：不算 10 月' },
    { id: 'x03', date: '2025-10-06', type: '代課', orig: 'A', sub: 'B', leave: '事假', inScope: false,
      note: '2025-10（前一學年度的 10 月）：不算 115 學年度' },
];

/** 駁回的請求（只存在 pendingRequests，不是已成立紀錄）與被刪除的紀錄（文件已不存在）。 */
export const GOLDEN_REJECTED = { id: 'p01', date: '2026-10-14', orig: 'A', sub: 'B', leave: '事假' };
export const GOLDEN_DELETED  = { id: 'd01', date: '2026-10-15', type: '代課', orig: 'A', sub: 'B', leave: '事假' };

/**
 * 手算期望值：115 學年度 10 月（週數 4，基本 20 × 4 = 80）。
 *
 * A 林彥廷：原定 6×4=24；增加 0；被代：g01 事假、g02 病假、g03 病假、g08 事假 = 4（g04 公假、g05 調課不扣）；
 *           實際 24+0−4=20；超鐘點 max(0,20−80)=0
 * B 王大明：原定 5×4=20；增加 g01、g06、g07 = 3（g05 調課不計）；被代：g09 長期病假不扣 = 0；
 *           實際 20+3−0=23；超鐘點 0
 * C 張淑芬：原定 3×4=12；增加 g02、g03、g04、g08、g09 = 5；被代：g06 事假 = 1；
 *           實際 12+5−1=16；超鐘點 0
 * D 黃志偉：原定 21×4=84；增加 0；被代：g07 喪假、g10 公假皆不扣 = 0；
 *           實際 84；超鐘點 84−80=4
 * E 吳佩珊：原定 20×4=80；增加 g10 = 1；被代 0；實際 81；超鐘點 81−80=1
 */
export const GOLDEN_EXPECTED_2026_10 = {
    '林彥廷': { weeklyHours: 6,  originalHours: 24, substituteHours: 0, substitutedHours: 4, actualHours: 20, overtimeHours: 0 },
    '王大明': { weeklyHours: 5,  originalHours: 20, substituteHours: 3, substitutedHours: 0, actualHours: 23, overtimeHours: 0 },
    '張淑芬': { weeklyHours: 3,  originalHours: 12, substituteHours: 5, substitutedHours: 1, actualHours: 16, overtimeHours: 0 },
    '黃志偉': { weeklyHours: 21, originalHours: 84, substituteHours: 0, substitutedHours: 0, actualHours: 84, overtimeHours: 4 },
    '吳佩珊': { weeklyHours: 20, originalHours: 80, substituteHours: 1, substitutedHours: 0, actualHours: 81, overtimeHours: 1 },
};

const NAME = { A: '林彥廷', B: '王大明', C: '張淑芬', D: '黃志偉', E: '吳佩珊' };
export const GOLDEN_NAME = NAME;

/** 轉成計算器吃的紀錄格式（leaveType 已合併回父文件的樣子）。 */
export function goldenRecordsForCalculator() {
    return GOLDEN_RECORDS.map(r => ({
        date: r.date, type: r.type,
        originalTeacher: NAME[r.orig], substituteTeacher: NAME[r.sub], leaveType: r.leave,
    }));
}
