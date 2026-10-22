/**
 * 課表解析模組
 *
 * 支援解析人力資源網2.0匯出的課表檔案
 * 支援格式：.xls, .xlsx, .csv
 *
 * 預期欄位格式：
 * 週次, 節次, 年級, 班級, 教師姓名, 身分證字號或居留證號, 類別, 領域, 科目, 語言別/校訂課程名稱, 上課頻率, 起始週
 *
 * 課程名稱規則：
 * - 優先使用「語言別/校訂課程名稱」欄位值作為課程顯示名稱
 * - 若「語言別/校訂課程名稱」為空，則使用「科目」欄位值
 */

export class ScheduleParser {
    constructor() {
        // 標準欄位名稱對應
        this.fieldMappings = {
            weekday: ['週次', '星期', '週'],
            period: ['節次', '節'],
            grade: ['年級'],
            className: ['班級'],
            teacher: ['教師姓名', '教師', '任課教師'],
            category: ['類別'],
            domain: ['領域'],
            subject: ['科目'],
            courseName: ['語言別/校訂課程名稱', '課程名稱', '語言別']
        };

        // 星期對應表
        this.weekdayMap = {
            '週一': '週一', '星期一': '週一', '一': '週一', '1': '週一',
            '週二': '週二', '星期二': '週二', '二': '週二', '2': '週二',
            '週三': '週三', '星期三': '週三', '三': '週三', '3': '週三',
            '週四': '週四', '星期四': '週四', '四': '週四', '4': '週四',
            '週五': '週五', '星期五': '週五', '五': '週五', '5': '週五'
        };

        // 節次對應表
        this.periodMap = {
            '第一節': '第一節', '1': '第一節', '第1節': '第一節',
            '第二節': '第二節', '2': '第二節', '第2節': '第二節',
            '第三節': '第三節', '3': '第三節', '第3節': '第三節',
            '第四節': '第四節', '4': '第四節', '第4節': '第四節',
            '第五節': '第五節', '5': '第五節', '第5節': '第五節',
            '第六節': '第六節', '6': '第六節', '第6節': '第六節',
            '第七節': '第七節', '7': '第七節', '第7節': '第七節',
            '第八節': '第八節', '8': '第八節', '第8節': '第八節'
        };

        // 合法的標準化結果（normalize 對查不到的值會原樣回傳，所以要另外比對是否為標準值）
        this.validWeekdays = new Set(Object.values(this.weekdayMap));
        this.validPeriods = new Set(Object.values(this.periodMap));

        // 排除的領域（不納入教師任教領域統計）
        this.excludedDomains = [
            '統整性主題/專題/議題探究',
            '社團活動與技藝課程'
        ];
    }

    /**
     * 解析檔案
     * @param {File} file - 上傳的檔案
     * @returns {Promise<Object>} 解析結果
     */
    async parseFile(file) {
        const extension = file.name.split('.').pop().toLowerCase();

        try {
            let rawData;

            if (extension === 'csv') {
                rawData = await this.parseCSV(file);
            } else if (extension === 'xls' || extension === 'xlsx') {
                rawData = await this.parseExcel(file);
            } else {
                throw new Error('不支援的檔案格式，請使用 .xls, .xlsx 或 .csv 檔案');
            }

            // 處理並標準化資料
            return this.processRawData(rawData);
        } catch (error) {
            console.error('檔案解析錯誤:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * 解析 CSV 檔案
     * @param {File} file - CSV 檔案
     * @returns {Promise<Array>} 原始資料陣列
     */
    parseCSV(file) {
        return new Promise((resolve, reject) => {
            Papa.parse(file, {
                header: true,
                encoding: 'UTF-8',
                // 不讓 Papa 自己略過空白行，否則會丟失「第幾列」資訊；改在下面自行過濾並保留列號
                skipEmptyLines: false,
                complete: (results) => {
                    if (results.errors.length > 0) {
                        console.warn('CSV 解析警告:', results.errors);
                    }
                    resolve(this.attachRowNumbers(results.data));
                },
                error: (error) => {
                    reject(new Error('CSV 解析失敗: ' + error.message));
                }
            });
        });
    }

    /**
     * 為 CSV 資料列掛上原始列號（不可列舉屬性，不影響 Object.keys 欄位偵測），並濾掉全空白列。
     * 列號慣例與 SheetJS 的 __rowNum__ 相同：0 起算的工作表列索引（標題列 = 0、第一筆資料 = 1）。
     * @param {Array} rows - Papa.parse(header:true) 的資料列
     * @returns {Array} 已掛列號、無全空白列的資料列
     */
    attachRowNumbers(rows) {
        const result = [];
        rows.forEach((row, i) => {
            const isBlank = Object.values(row).every(v => v === undefined || v === null || String(v).trim() === '');
            if (isBlank) return;
            Object.defineProperty(row, '__rowNum__', { value: i + 1, enumerable: false });
            result.push(row);
        });
        return result;
    }

    /**
     * 解析 Excel 檔案 (使用 SheetJS/xlsx)
     * @param {File} file - Excel 檔案
     * @returns {Promise<Array>} 原始資料陣列
     */
    parseExcel(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });

                    // 取得第一個工作表
                    const firstSheetName = workbook.SheetNames[0];
                    const worksheet = workbook.Sheets[firstSheetName];

                    // 轉換為 JSON
                    const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

                    resolve(jsonData);
                } catch (error) {
                    reject(new Error('Excel 解析失敗: ' + error.message));
                }
            };

            reader.onerror = () => {
                reject(new Error('檔案讀取失敗'));
            };

            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * 處理原始資料，轉換為標準格式
     * @param {Array} rawData - 原始資料
     * @returns {Object} 處理後的結果
     */
    processRawData(rawData) {
        if (!rawData || rawData.length === 0) {
            return {
                success: false,
                error: '檔案中沒有資料'
            };
        }

        // 偵測欄位對應
        const headers = Object.keys(rawData[0]);
        const fieldMap = this.detectFieldMapping(headers);

        console.log('偵測到的欄位對應:', fieldMap);

        // 驗證必要欄位
        const requiredFields = ['weekday', 'period', 'className', 'teacher'];
        const missingFields = requiredFields.filter(f => !fieldMap[f]);
        if (missingFields.length > 0) {
            return {
                success: false,
                error: '缺少必要欄位: ' + missingFields.join(', ')
            };
        }

        // 處理課表資料
        const scheduleData = [];
        const teacherMap = new Map(); // 用於收集教師資訊
        const classSet = new Set();
        // 被略過的列：[{ row: Excel 列號, reason: 原因, summary: 原始內容摘要 }]
        const warnings = [];

        rawData.forEach((row, index) => {
            // 整列皆空白（常見於表尾殘留格式）不是資料問題，直接忽略，不列入警告
            if (Object.values(row).every(v => v === undefined || v === null || String(v).trim() === '')) return;

            // 使用者在 Excel 看到的列號：標題列為第 1 列，資料從第 2 列起。
            // SheetJS／CSV 路徑的 row.__rowNum__ 是 0 起算的工作表列索引（標題 0），+1 即 Excel 列號，
            // 且會把中間的空白列算進去；沒有 __rowNum__ 時（呼叫端直接傳陣列）退回 index + 2。
            const excelRow = (typeof row.__rowNum__ === 'number') ? row.__rowNum__ + 1 : index + 2;

            // 取得標準化的值
            const weekday = this.normalizeWeekday(row[fieldMap.weekday]);
            const period = this.normalizePeriod(row[fieldMap.period]);
            // Excel 數字儲存格（如班級 701）讀進來是 number，先轉字串再 trim
            const cell = (key) => (row[key] === undefined || row[key] === null) ? '' : String(row[key]).trim();
            const className = cell(fieldMap.className);
            const teacher = cell(fieldMap.teacher);
            const domain = cell(fieldMap.domain);
            const rawSubject = cell(fieldMap.subject);
            const courseName = cell(fieldMap.courseName);
            const category = cell(fieldMap.category);

            // 課程顯示名稱：優先使用「語言別/校訂課程名稱」，若為空則使用「科目」
            const subject = courseName || rawSubject;

            // 跳過無效資料，並記錄原因讓使用者看得到（一列可能同時有多個原因）
            const reasons = [];
            if (!weekday) reasons.push('缺星期');
            else if (!this.validWeekdays.has(weekday)) reasons.push(`無效星期「${weekday}」`);
            if (!period) reasons.push('缺節次');
            else if (!this.validPeriods.has(period)) reasons.push(`無效節次「${period}」`);
            if (!className) reasons.push('缺班級');
            if (!teacher) reasons.push('缺教師');

            if (reasons.length > 0) {
                const summary = this.summarizeRow(row);
                warnings.push({ row: excelRow, reason: reasons.join('、'), summary });
                console.warn(`第 ${excelRow} 列已略過：${reasons.join('、')}（${summary}）`);
                return;
            }

            // 新增課表資料
            scheduleData.push({
                weekday,
                period,
                className,
                teacher,
                domain,
                subject,         // 顯示用名稱（優先使用校訂課程名稱）
                rawSubject,      // 原始科目欄位值
                courseName,      // 語言別/校訂課程名稱欄位值
                category
            });

            // 收集班級
            classSet.add(className);

            // 收集教師資訊
            if (!teacherMap.has(teacher)) {
                teacherMap.set(teacher, {
                    name: teacher,
                    domains: new Set(),
                    homeroomClass: ''
                });
            }
            // 將領域加入教師資料（排除特定領域）
            if (domain && !this.excludedDomains.includes(domain)) {
                teacherMap.get(teacher).domains.add(domain);
            }
        });

        // 轉換教師資料格式
        const teachers = Array.from(teacherMap.values()).map(t => ({
            name: t.name,
            domains: Array.from(t.domains),
            homeroomClass: t.homeroomClass
        }));

        // 排序班級
        const classes = Array.from(classSet).sort((a, b) => {
            // 提取年級和班級數字進行排序
            const matchA = a.match(/(\d+)年(\d+)班/);
            const matchB = b.match(/(\d+)年(\d+)班/);
            if (matchA && matchB) {
                if (matchA[1] !== matchB[1]) {
                    return parseInt(matchA[1]) - parseInt(matchB[1]);
                }
                return parseInt(matchA[2]) - parseInt(matchB[2]);
            }
            return a.localeCompare(b);
        });

        return {
            success: true,
            scheduleData,
            teachers,
            classes,
            warnings,                       // 被略過的列明細
            skippedCount: warnings.length   // 略過列數
        };
    }

    /**
     * 產生原始列內容摘要（供略過列明細顯示）：各欄位值以「|」串接，過長截斷
     * @param {Object} row - 原始資料列
     * @returns {string} 摘要
     */
    summarizeRow(row) {
        const text = Object.values(row)
            .map(v => (v === undefined || v === null) ? '' : String(v).trim())
            .join('|');
        return text.length > 80 ? text.slice(0, 80) + '…' : text;
    }

    /**
     * 偵測欄位對應
     * @param {Array} headers - 檔案標題列
     * @returns {Object} 欄位對應表
     */
    detectFieldMapping(headers) {
        const fieldMap = {};

        for (const [standardField, possibleNames] of Object.entries(this.fieldMappings)) {
            for (const header of headers) {
                const headerLower = header.toLowerCase().trim();
                for (const name of possibleNames) {
                    if (header === name || headerLower === name.toLowerCase() ||
                        header.includes(name) || name.includes(header)) {
                        fieldMap[standardField] = header;
                        break;
                    }
                }
                if (fieldMap[standardField]) break;
            }
        }

        return fieldMap;
    }

    /**
     * 標準化星期格式
     * @param {string} weekday - 原始星期值
     * @returns {string} 標準化後的星期
     */
    normalizeWeekday(weekday) {
        if (!weekday) return null;
        const normalized = weekday.toString().trim();
        return this.weekdayMap[normalized] || normalized;
    }

    /**
     * 標準化節次格式
     * @param {string} period - 原始節次值
     * @returns {string} 標準化後的節次
     */
    normalizePeriod(period) {
        if (!period) return null;
        const normalized = period.toString().trim();
        return this.periodMap[normalized] || normalized;
    }

    /**
     * 產生 CSV 範本
     * @returns {string} CSV 範本內容
     */
    generateCSVTemplate() {
        const headers = ['週次', '節次', '年級', '班級', '教師姓名', '類別', '領域', '科目', '語言別/校訂課程名稱'];
        const sampleData = [
            ['週一', '第一節', '7年級', '7年1班', '王大明', '領域學習', '數學領域', '數學', '數學'],
            ['週一', '第二節', '7年級', '7年1班', '李小華', '領域學習', '語文領域', '國語文', '國語文'],
            ['週二', '第一節', '7年級', '7年1班', '王大明', '領域學習', '數學領域', '數學', '數學']
        ];

        let csv = headers.join(',') + '\n';
        sampleData.forEach(row => {
            csv += row.join(',') + '\n';
        });

        return csv;
    }
}
