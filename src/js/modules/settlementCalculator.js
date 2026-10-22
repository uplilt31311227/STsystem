/**
 * 月結算計算模組
 *
 * 負責計算教師每月的實際授課時數
 *
 * 計算邏輯（含假別區分）：
 * 1. 原定授課時數 = 該教師在課表中的每週授課節數 × 當月上課週數
 * 2. 代課增加時數 = 該月該教師為他人代課的總節數（不論假別皆 +1）
 * 3. 被代課減少時數 = 該月他人為該教師代課的總節數
 *    【公付假別 - 不扣時數（學校支付公費）】
 *    - 公假 (official)
 *    - 長期病假 (longsick)：3日以上
 *    - 喪假 (funeral)
 *    【一般假別 - 扣時數 (-1)】
 *    - 事假/病假/休假/其他
 *    【調課 - 不扣時數（互換）】
 *    - 調課 (swap)
 * 4. 實際授課時數 = 原定時數 + 代課增加 - 被代課減少
 * 5. 超鐘點時數 = 實際授課時數 - 基本授課時數（需另設定）
 */

export class SettlementCalculator {
    constructor() {
        // 每週基本授課時數（可依學校規定調整）
        this.baseWeeklyHours = 20;

        // 每月預設上課週數
        this.defaultWeeksPerMonth = 4;

        // 每月上課週數覆寫：{ "115": { "8": 1, "9": 4 } }（學年度 → 月份 → 週數）。
        // 有值的月份用覆寫，沒有的月份沿用 getWeeksInMonth() 內的寫死預設（向後相容）。
        this.weeksOverride = {};

        // 不扣時數的假別（公付假別由學校支付，調課為互換）
        // 支援中文和英文代碼
        this.noDeductLeaveTypes = [
            'official', 'longsick', 'funeral', 'swap',  // 英文代碼
            '公假', '長期病假', '喪假', '調課'           // 中文名稱
        ];
    }

    /**
     * 計算月結算資料
     * @param {number} year - 學年度
     * @param {number} month - 月份
     * @param {Array} scheduleData - 課表資料
     * @param {Array} substituteRecords - 調代課紀錄
     * @param {Array} teachers - 教師資料
     * @returns {Array} 結算資料陣列
     */
    calculate(year, month, scheduleData, substituteRecords, teachers) {
        // 計算該月的上課週數（可以根據行事曆調整）
        const weeksInMonth = this.getWeeksInMonth(year, month);

        // 篩選該月份的調代課紀錄
        const monthlyRecords = this.filterMonthlyRecords(substituteRecords, year, month);

        // 計算每位教師的結算資料
        const settlementData = teachers.map(teacher => {
            // 1. 計算原定授課時數（每週節數 × 週數）
            const weeklyHours = this.getTeacherWeeklyHours(scheduleData, teacher.name);
            const originalHours = weeklyHours * weeksInMonth;

            // 2. 計算代課增加時數（該教師為他人代課）
            const substituteHours = this.countSubstituteHours(monthlyRecords, teacher.name);

            // 3. 計算被代課減少時數（他人為該教師代課）
            const substitutedHours = this.countSubstitutedHours(monthlyRecords, teacher.name);

            // 4. 計算實際授課時數
            const actualHours = originalHours + substituteHours - substitutedHours;

            // 5. 計算超鐘點時數
            const baseMonthlyHours = this.baseWeeklyHours * weeksInMonth;
            const overtimeHours = Math.max(0, actualHours - baseMonthlyHours);

            return {
                teacherName: teacher.name,
                weeklyHours,
                originalHours,
                substituteHours,
                substitutedHours,
                actualHours,
                overtimeHours,
                baseMonthlyHours
            };
        });

        // 按照實際授課時數排序（降序）
        settlementData.sort((a, b) => b.actualHours - a.actualHours);

        return settlementData;
    }

    /**
     * 設定某學年度的每月上課週數覆寫（整份取代該學年度的舊覆寫）。
     * 只接受 0–6 的整數，其餘（空、NaN、超出範圍）視為未設定，該月沿用預設。
     * @param {number|string} year - 學年度（民國）
     * @param {Object} map - { 月份: 週數 }
     */
    setWeeksOverride(year, map) {
        const clean = {};
        for (const [m, v] of Object.entries(map || {})) {
            const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : v;
            if (Number.isInteger(n) && n >= 0 && n <= 6) clean[String(Number(m))] = n;
        }
        if (Object.keys(clean).length) this.weeksOverride[String(year)] = clean;
        else delete this.weeksOverride[String(year)];
    }

    /**
     * 取得該月的上課週數
     * @param {number} year - 年份
     * @param {number} month - 月份
     * @returns {number} 上課週數
     */
    getWeeksInMonth(year, month) {
        const override = this.weeksOverride[String(year)];
        const key = String(Number(month));
        if (override && Object.prototype.hasOwnProperty.call(override, key)) {
            return override[key];
        }

        // 這裡使用簡化的計算方式
        // 實際應用中可以根據學校行事曆調整

        // 特殊月份處理
        const specialMonths = {
            1: 2,   // 1 月（寒假）
            2: 3,   // 2 月（寒假）
            7: 0,   // 7 月（暑假）
            8: 0,   // 8 月（暑假）
        };

        if (specialMonths.hasOwnProperty(month)) {
            return specialMonths[month];
        }

        return this.defaultWeeksPerMonth;
    }

    /**
     * 篩選該月份的調代課紀錄
     * @param {Array} records - 全部紀錄
     * @param {number} year - 年份
     * @param {number} month - 月份
     * @returns {Array} 該月份的紀錄
     */
    filterMonthlyRecords(records, year, month) {
        const { prefix } = this._resolveMonth(year, month);
        return records.filter(record => record.date && record.date.startsWith(prefix));
    }

    /**
     * 依民國學年度＋月份換算西元年月（抽出自 filterMonthlyRecords，供 getMonthDateRange 共用）。
     * @returns {{ actualYear: number, monthStr: string, prefix: string }}
     */
    _resolveMonth(year, month) {
        // 將學年度轉換為西元年
        // 台灣學年度：114 學年度 = 2025/8 ~ 2026/7
        const westernYear = parseInt(year) + 1911;

        // 根據學年度和月份計算實際年份
        // 1-7 月屬於學年度 +1 的年份
        // 8-12 月屬於學年度的年份
        const actualYear = month >= 8 ? westernYear : westernYear + 1;
        const monthStr = String(month).padStart(2, '0');

        return { actualYear, monthStr, prefix: `${actualYear}-${monthStr}` };
    }

    /**
     * Stage 1（讀取成本止血，RESEARCH-multitenancy-semester.md §5.6）：把「學年度＋月份」換算
     * 成 Firestore range query 可用的日期字串範圍，供呼叫端在資料來源改為即時訂閱＋按需查詢
     * （不再是全量本地陣列）時，把日期範圍下推到查詢層，而不是抓全部歷史紀錄回來再用
     * filterMonthlyRecords() 篩。
     *
     * endDate 固定用 `-31`：字典序範圍查詢只需要「夠大」的上界，不需要真的存在的日期
     * （例如 2 月查到 `-31` 不影響結果，Firestore 是純字串比較，不會驗證日期合法性）；
     * calculate() 內部仍會呼叫 filterMonthlyRecords() 對查回來的資料做一次精確的 startsWith
     * 比對，所以就算 range query 抓寬一點也不影響最終計算結果的正確性。
     * @returns {{ startDate: string, endDate: string }}
     */
    getMonthDateRange(year, month) {
        const { prefix } = this._resolveMonth(year, month);
        return { startDate: `${prefix}-01`, endDate: `${prefix}-31` };
    }

    /**
     * 計算教師每週授課節數
     * @param {Array} scheduleData - 課表資料
     * @param {string} teacherName - 教師姓名
     * @returns {number} 每週授課節數
     */
    getTeacherWeeklyHours(scheduleData, teacherName) {
        return scheduleData.filter(course => course.teacher === teacherName).length;
    }

    /**
     * 計算代課增加時數
     * 所有代課（不論假別）皆增加時數 +1
     * 調課互換不增加時數（因為是交換，不是額外代課）
     * @param {Array} records - 該月調課紀錄
     * @param {string} teacherName - 教師姓名
     * @returns {number} 代課節數
     */
    countSubstituteHours(records, teacherName) {
        return records.filter(record =>
            record.substituteTeacher === teacherName &&
            record.type !== 'swap' && record.type !== '調課'  // 調課互換不計入代課增加
        ).length;
    }

    /**
     * 計算被代課減少時數
     * 根據假別區分：
     * - 公假 (official)：不扣時數（學校支付公費）
     * - 調課 (swap)：不扣時數（互換）
     * - 事假/病假/休假/其他：扣時數 (-1)
     * @param {Array} records - 該月調課紀錄
     * @param {string} teacherName - 教師姓名
     * @returns {number} 被代課節數
     */
    countSubstitutedHours(records, teacherName) {
        return records.filter(record =>
            record.originalTeacher === teacherName && this.isDeductedFromOriginal(record)
        ).length;
    }

    /**
     * 這筆紀錄是否要扣原任課教師的時數（countSubstitutedHours 與明細表共用的唯一判斷，確保同一口徑）
     * - 調課（type 為 swap／調課）：不扣
     * - 假別在 noDeductLeaveTypes（公假／長期病假／喪假…）：不扣
     * - 其他（事假／病假／休假／其他／缺假別）：扣
     * @param {Object} record - 單筆調代課紀錄
     * @returns {boolean}
     */
    isDeductedFromOriginal(record) {
        // 調課不扣時數（檢查 type 欄位，支援中英文）
        if (record.type === 'swap' || record.type === '調課') {
            return false;
        }

        // 公假和調課不扣時數（檢查 leaveType 欄位）
        const leaveType = record.leaveType || '';
        if (this.noDeductLeaveTypes.includes(leaveType)) {
            return false;
        }

        // 其他假別扣時數
        return true;
    }

    /**
     * 取得詳細的結算明細（含假別分類）
     * @param {Array} records - 該月調課紀錄
     * @param {string} teacherName - 教師姓名
     * @returns {Object} 分類統計
     */
    getDetailedSettlement(records, teacherName) {
        const asSubstitute = records.filter(r => r.substituteTeacher === teacherName);
        const asOriginal = records.filter(r => r.originalTeacher === teacherName);

        // 代課統計（排除調課，支援中英文）
        const substituteCount = asSubstitute.filter(r =>
            r.type !== 'swap' && r.type !== '調課'
        ).length;
        const swapAsSubCount = asSubstitute.filter(r =>
            r.type === 'swap' || r.type === '調課'
        ).length;

        // 被代課統計（按假別分類，支援中英文代碼）
        const substitutedByLeaveType = {
            official: asOriginal.filter(r => r.leaveType === 'official' || r.leaveType === '公假').length,
            longsick: asOriginal.filter(r => r.leaveType === 'longsick' || r.leaveType === '長期病假').length,
            funeral: asOriginal.filter(r => r.leaveType === 'funeral' || r.leaveType === '喪假').length,
            personal: asOriginal.filter(r => r.leaveType === 'personal' || r.leaveType === '事假').length,
            sick: asOriginal.filter(r => r.leaveType === 'sick' || r.leaveType === '病假').length,
            rest: asOriginal.filter(r => r.leaveType === 'rest' || r.leaveType === '休假').length,
            other: asOriginal.filter(r => r.leaveType === 'other' || r.leaveType === '其他').length,
            swap: asOriginal.filter(r => r.type === 'swap' || r.type === '調課').length
        };

        // 實際扣減時數（排除公付假別和調課）
        const deductedHours = substitutedByLeaveType.personal +
                              substitutedByLeaveType.sick +
                              substitutedByLeaveType.rest +
                              substitutedByLeaveType.other;

        // 公付假別總次數（不扣時數）
        const paidLeaveCount = substitutedByLeaveType.official +
                               substitutedByLeaveType.longsick +
                               substitutedByLeaveType.funeral;

        return {
            teacherName,
            substituteCount,        // 代課增加（不含調課）
            swapCount: swapAsSubCount + substitutedByLeaveType.swap,  // 調課次數
            substitutedByLeaveType, // 被代課（按假別）
            deductedHours,          // 實際扣減時數
            paidLeaveCount,         // 公付假別總次數（不扣）
            officialLeaveCount: substitutedByLeaveType.official  // 公假次數（保留相容性）
        };
    }

    /**
     * 匯出結算表為 Excel
     * @param {Array} settlementData - 結算資料
     * @param {number} year - 學年度
     * @param {number} month - 月份
     */
    exportToExcel(settlementData, year, month, records = []) {
        const wb = this.buildWorkbook(settlementData, year, month, records);

        // 下載檔案
        const fileName = `授課時數結算表_${year}學年度_${month}月.xlsx`;
        XLSX.writeFile(wb, fileName);
    }

    /**
     * 建立結算表工作簿（兩個分頁：「結算表」彙總、「明細」逐節）。
     * 與下載動作分開，方便單元測試；XLSX 預設取全域（瀏覽器 CDN），測試時可注入 node 版。
     * @param {Array} settlementData - calculate() 的結果
     * @param {number} year - 學年度
     * @param {number} month - 月份
     * @param {Array} records - 與 calculate() 相同來源的調代課紀錄（內部會再經 filterMonthlyRecords 篩月）
     * @param {Object} [xlsxLib] - SheetJS 實體
     * @returns {Object} workbook
     */
    buildWorkbook(settlementData, year, month, records = [], xlsxLib = globalThis.XLSX) {
        const XLSX = xlsxLib;
        // 建立工作表資料
        const wsData = [
            [`${year} 學年度 ${month} 月 教師授課時數結算表`],
            [],
            ['教師姓名', '每週節數', '原定授課時數', '代課增加', '被代課減少', '實際授課時數', '超鐘點時數']
        ];

        settlementData.forEach(row => {
            wsData.push([
                row.teacherName,
                row.weeklyHours,
                row.originalHours,
                row.substituteHours,
                row.substitutedHours,
                row.actualHours,
                row.overtimeHours
            ]);
        });

        // 加入合計列
        const totalRow = [
            '合計',
            settlementData.reduce((sum, r) => sum + r.weeklyHours, 0),
            settlementData.reduce((sum, r) => sum + r.originalHours, 0),
            settlementData.reduce((sum, r) => sum + r.substituteHours, 0),
            settlementData.reduce((sum, r) => sum + r.substitutedHours, 0),
            settlementData.reduce((sum, r) => sum + r.actualHours, 0),
            settlementData.reduce((sum, r) => sum + r.overtimeHours, 0)
        ];
        wsData.push(totalRow);

        // 建立工作簿
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // 設定欄寬
        ws['!cols'] = [
            { wch: 12 },  // 教師姓名
            { wch: 10 },  // 每週節數
            { wch: 14 },  // 原定授課時數
            { wch: 10 },  // 代課增加
            { wch: 12 },  // 被代課減少
            { wch: 14 },  // 實際授課時數
            { wch: 12 }   // 超鐘點時數
        ];

        // 合併標題儲存格
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }
        ];

        XLSX.utils.book_append_sheet(wb, ws, '結算表');

        // 第二分頁：逐節明細（與彙總同一口徑：同樣經過 filterMonthlyRecords 與 isDeductedFromOriginal）
        const detailRows = this.getMonthlyDetailRows(records, year, month);
        const detailData = [
            [`${year} 學年度 ${month} 月 調代課逐節明細`],
            [],
            ['日期', '星期', '節次', '班級', '科目', '類型', '原任課教師', '代課／調課教師', '假別', '是否扣原任課教師時數'],
            ...detailRows.map(r => [
                r.date, r.weekday, r.period, r.className, r.subject,
                r.type, r.originalTeacher, r.substituteTeacher, r.leaveType, r.deducted ? '是' : '否'
            ])
        ];
        const wsDetail = XLSX.utils.aoa_to_sheet(detailData);
        wsDetail['!cols'] = [
            { wch: 12 }, { wch: 6 }, { wch: 8 }, { wch: 10 }, { wch: 12 },
            { wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 20 }
        ];
        wsDetail['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }];
        XLSX.utils.book_append_sheet(wb, wsDetail, '明細');

        return wb;
    }

    /**
     * 當月逐節明細列（月結算 Excel「明細」分頁的資料來源）。
     * 篩月沿用 filterMonthlyRecords，與 calculate() 納入的紀錄完全相同；
     * 「是否扣時數」呼叫 isDeductedFromOriginal，與 countSubstitutedHours 同一判斷。
     * @param {Array} records - 調代課紀錄（可含全部月份）
     * @param {number} year - 學年度
     * @param {number} month - 月份
     * @returns {Array<Object>} 依日期、節次排序的明細列
     */
    getMonthlyDetailRows(records, year, month) {
        const leaveLabels = {
            official: '公假', longsick: '長期病假', funeral: '喪假', personal: '事假',
            sick: '病假', rest: '休假', other: '其他', swap: '調課'
        };
        const periodOrder = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節'];
        const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
        const periodIdx = p => { const i = periodOrder.indexOf(p); return i < 0 ? 99 : i; };

        return this.filterMonthlyRecords(records || [], year, month)
            .map(r => {
                const isSwap = r.type === 'swap' || r.type === '調課';
                const [y, m, d] = String(r.date).split('-').map(Number);
                const dow = new Date(y, m - 1, d).getDay();
                return {
                    date: r.date,
                    weekday: Number.isNaN(dow) ? '' : '週' + weekdayLabels[dow],
                    period: r.period || '',
                    className: r.className || '',
                    subject: r.subject || '',
                    type: isSwap ? '調課' : '代課',
                    originalTeacher: r.originalTeacher || '',
                    substituteTeacher: r.substituteTeacher || '',
                    leaveType: isSwap ? '調課' : (leaveLabels[r.leaveType] || r.leaveType || ''),
                    deducted: this.isDeductedFromOriginal(r)
                };
            })
            .sort((a, b) => a.date.localeCompare(b.date) || periodIdx(a.period) - periodIdx(b.period));
    }

    /**
     * 設定每週基本授課時數
     * @param {number} hours - 時數
     */
    setBaseWeeklyHours(hours) {
        this.baseWeeklyHours = hours;
    }

    /**
     * 設定每月上課週數
     * @param {number} weeks - 週數
     */
    setDefaultWeeksPerMonth(weeks) {
        this.defaultWeeksPerMonth = weeks;
    }

    /**
     * 取得詳細的調課明細
     * @param {Array} records - 調課紀錄
     * @param {string} teacherName - 教師姓名
     * @returns {Object} 調課明細
     */
    getSubstituteDetails(records, teacherName) {
        const asSubstitute = records.filter(r => r.substituteTeacher === teacherName);
        const asOriginal = records.filter(r => r.originalTeacher === teacherName);

        return {
            teacherName,
            substituteRecords: asSubstitute.map(r => ({
                date: r.date,
                period: r.period,
                className: r.className,
                subject: r.subject,
                for: r.originalTeacher
            })),
            substitutedRecords: asOriginal.map(r => ({
                date: r.date,
                period: r.period,
                className: r.className,
                subject: r.subject,
                by: r.substituteTeacher,
                reason: r.reason
            }))
        };
    }
}
