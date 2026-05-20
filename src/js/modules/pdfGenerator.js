/**
 * PDF 生成模組
 *
 * 負責生成一式四聯的調代課通知單 PDF
 * 四聯分別為：
 * 1. 原任課教師聯
 * 2. 代（調）課教師聯
 * 3. 班級聯
 * 4. 教學組聯
 *
 * 版面配置：每頁左右各一聯，共兩頁
 * 使用 html2canvas + jsPDF 實現中文支援
 */

export class PDFGenerator {
    constructor() {
        // PDF 設定
        this.config = {
            pageWidth: 210,  // A4 寬度 (mm)
            pageHeight: 297, // A4 高度 (mm)
            margin: 10
        };

        // 星期對照
        this.weekdays = ['週一', '週二', '週三', '週四', '週五'];
        this.periods = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節'];

        // 節次格式轉換對照表（支援多種格式）
        this.periodAliases = {
            '第1節': '第一節', '第2節': '第二節', '第3節': '第三節', '第4節': '第四節',
            '第5節': '第五節', '第6節': '第六節', '第7節': '第七節',
            '第一節': '第一節', '第二節': '第二節', '第三節': '第三節', '第四節': '第四節',
            '第五節': '第五節', '第六節': '第六節', '第七節': '第七節'
        };

        // 學校名稱（可設定）
        this.schoolName = '○○國民中學';
    }

    /**
     * 設定學校名稱
     * @param {string} name - 學校名稱
     */
    setSchoolName(name) {
        this.schoolName = name;
    }

    /**
     * 生成調代課單 PDF
     * @param {Object} record - 調課紀錄
     * @param {Array} scheduleData - 課表資料
     * @param {Array} teachers - 教師資料
     */
    async generateSubstituteForm(record, scheduleData, teachers) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('l', 'mm', 'a4'); // 橫向 A4

        // 四聯配置
        const sheets = [
            { label: '原任課教師聯', labelBg: '#6b7280', teacher: record.originalTeacher },
            { label: '代（調）課教師聯', labelBg: '#6b7280', teacher: record.substituteTeacher },
            { label: '班級聯', labelBg: '#6b7280', teacher: record.originalTeacher },
            { label: '教學組聯', labelBg: '#6b7280', teacher: record.originalTeacher }
        ];

        // 建立隱藏的 HTML 容器
        const container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: -9999px; top: 0;';
        document.body.appendChild(container);

        try {
            // 第一頁：原任課教師聯 + 代課教師聯
            const page1HTML = this.createPageHTML(record, sheets[0], sheets[1], scheduleData);
            container.innerHTML = page1HTML;
            container.style.width = '1123px'; // A4 橫向 297mm ≈ 1123px at 96dpi

            await new Promise(resolve => setTimeout(resolve, 150));

            const canvas1 = await html2canvas(container, {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff'
            });

            const imgData1 = canvas1.toDataURL('image/jpeg', 0.95);
            doc.addImage(imgData1, 'JPEG', 0, 0, 297, 210);

            // 第二頁：班級聯 + 教學組聯
            doc.addPage();
            const page2HTML = this.createPageHTML(record, sheets[2], sheets[3], scheduleData);
            container.innerHTML = page2HTML;

            await new Promise(resolve => setTimeout(resolve, 150));

            const canvas2 = await html2canvas(container, {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff'
            });

            const imgData2 = canvas2.toDataURL('image/jpeg', 0.95);
            doc.addImage(imgData2, 'JPEG', 0, 0, 297, 210);

            // 下載 PDF
            const fileName = `調代課通知_${record.date.replace(/-/g, '')}_${record.originalTeacher}.pdf`;
            doc.save(fileName);

        } finally {
            document.body.removeChild(container);
        }
    }

    /**
     * 生成多節課代課單 PDF
     * @param {Array} records - 多節課紀錄陣列
     * @param {Array} courses - 排序後的課程陣列
     * @param {Array} scheduleData - 課表資料
     * @param {Array} teachers - 教師資料
     */
    async generateMultiCourseForm(records, courses, scheduleData, teachers) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('l', 'mm', 'a4'); // 橫向 A4

        // 取得第一筆紀錄的基本資訊（共用）
        const baseRecord = records[0];

        // 四聯配置
        const sheets = [
            { label: '原任課教師聯', labelBg: '#6b7280', teacher: baseRecord.originalTeacher },
            { label: '代（調）課教師聯', labelBg: '#6b7280', teacher: baseRecord.substituteTeacher },
            { label: '班級聯', labelBg: '#6b7280', teacher: baseRecord.originalTeacher },
            { label: '教學組聯', labelBg: '#6b7280', teacher: baseRecord.originalTeacher }
        ];

        // 建立隱藏的 HTML 容器
        const container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: -9999px; top: 0;';
        document.body.appendChild(container);

        try {
            // 第一頁：原任課教師聯 + 代課教師聯
            const page1HTML = this.createMultiCoursePageHTML(records, courses, sheets[0], sheets[1], scheduleData);
            container.innerHTML = page1HTML;
            container.style.width = '1123px';

            await new Promise(resolve => setTimeout(resolve, 150));

            const canvas1 = await html2canvas(container, {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff'
            });

            const imgData1 = canvas1.toDataURL('image/jpeg', 0.95);
            doc.addImage(imgData1, 'JPEG', 0, 0, 297, 210);

            // 第二頁：班級聯 + 教學組聯
            doc.addPage();
            const page2HTML = this.createMultiCoursePageHTML(records, courses, sheets[2], sheets[3], scheduleData);
            container.innerHTML = page2HTML;

            await new Promise(resolve => setTimeout(resolve, 150));

            const canvas2 = await html2canvas(container, {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff'
            });

            const imgData2 = canvas2.toDataURL('image/jpeg', 0.95);
            doc.addImage(imgData2, 'JPEG', 0, 0, 297, 210);

            // 下載 PDF
            const periodsText = courses.length > 3
                ? `${courses.length}節`
                : courses.map(c => c.period.replace('第', '').replace('節', '')).join('-') + '節';
            const fileName = `調代課通知_${baseRecord.date.replace(/-/g, '')}_${baseRecord.originalTeacher}_${periodsText}.pdf`;
            doc.save(fileName);

        } finally {
            document.body.removeChild(container);
        }
    }

    /**
     * 建立多節課單頁 HTML（左右兩聯）
     */
    createMultiCoursePageHTML(records, courses, leftSheet, rightSheet, scheduleData) {
        const leftHTML = this.createMultiCourseSheetHTML(records, courses, leftSheet, scheduleData);
        const rightHTML = this.createMultiCourseSheetHTML(records, courses, rightSheet, scheduleData);

        return `
        <div style="
            display: flex;
            width: 1123px;
            height: 794px;
            font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif;
            background: white;
        ">
            <div style="flex: 1; padding: 20px; border-right: 1px dashed #ccc;">
                ${leftHTML}
            </div>
            <div style="flex: 1; padding: 20px;">
                ${rightHTML}
            </div>
        </div>
        `;
    }

    /**
     * 建立多節課單聯 HTML
     */
    createMultiCourseSheetHTML(records, courses, sheet, scheduleData) {
        const baseRecord = records[0];
        const teacherSchedule = this.getTeacherWeekSchedule(scheduleData, sheet.teacher);
        const scheduleTableHTML = this.createMultiCourseScheduleTableHTML(teacherSchedule, records, sheet.teacher);

        // 格式化日期
        const dateObj = new Date(baseRecord.date);
        const formattedDate = `${dateObj.getFullYear()}/${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')} (${baseRecord.weekday})`;

        // 列印日期
        const printDate = new Date().toLocaleDateString('zh-TW', {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric'
        });

        // 假別
        const leaveType = baseRecord.leaveTypeName || baseRecord.leaveType || '-';

        // 公假字號
        const docNumber = baseRecord.docNumber || '-';

        // 判斷聯別類型
        const isOriginalTeacherSheet = sheet.label === '原任課教師聯';
        const isSubstituteTeacherSheet = sheet.label === '代（調）課教師聯';
        const isClassSheet = sheet.label === '班級聯';

        // 灰階網底顏色定義
        const highlightBg = '#d0d0d0';
        const normalBg = '#f5f5f5';

        // 原任課教師欄位網底
        const originalTeacherBg = isOriginalTeacherSheet ? highlightBg : normalBg;
        // 代課教師欄位網底
        const substituteTeacherBg = isSubstituteTeacherSheet ? highlightBg : normalBg;
        // 班級科目欄位網底
        const classSubjectBg = isClassSheet ? highlightBg : normalBg;

        // 決定是否顯示請假假別和公假字號
        const showLeaveType = !isClassSheet;
        const showDocNumber = !isSubstituteTeacherSheet && !isClassSheet;

        // 生成多節課程列表
        const coursesListHTML = courses.map(c =>
            `<span style="display: inline-block; margin: 2px 4px; padding: 2px 6px; background: ${isClassSheet ? highlightBg : '#e8e8e8'}; border-radius: 3px; font-size: 11px;">${c.className} ${c.subject} (${c.period})</span>`
        ).join('');

        // 根據顯示需求組合第四行
        let fourthRowHTML = '';
        if (showLeaveType && showDocNumber) {
            fourthRowHTML = `
            <tr>
                <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">請假假別</td>
                <td style="padding: 8px; border: 1px solid #333;">${leaveType}</td>
                <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">公假字號</td>
                <td style="padding: 8px; border: 1px solid #333;">${docNumber}</td>
            </tr>`;
        } else if (showLeaveType && !showDocNumber) {
            fourthRowHTML = `
            <tr>
                <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">請假假別</td>
                <td colspan="3" style="padding: 8px; border: 1px solid #333;">${leaveType}</td>
            </tr>`;
        }

        const infoTableHTML = `
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 13px;">
            <tr>
                <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; width: 18%; font-weight: bold;">異動類型</td>
                <td style="padding: 8px; border: 1px solid #333; width: 32%;">代課（${courses.length}節）</td>
                <td style="padding: 8px; border: 1px solid #333; background: ${originalTeacherBg}; width: 18%; font-weight: bold;">原任課教師</td>
                <td style="padding: 8px; border: 1px solid #333; ${isOriginalTeacherSheet ? 'background: ' + highlightBg + ';' : ''} width: 32%;">${baseRecord.originalTeacher}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">日期</td>
                <td style="padding: 8px; border: 1px solid #333;">${formattedDate}</td>
                <td style="padding: 8px; border: 1px solid #333; background: ${substituteTeacherBg}; font-weight: bold;">代課教師</td>
                <td style="padding: 8px; border: 1px solid #333; ${isSubstituteTeacherSheet ? 'background: ' + highlightBg + ';' : ''}">${baseRecord.substituteTeacher}</td>
            </tr>
            <tr>
                <td style="padding: 8px; border: 1px solid #333; background: ${classSubjectBg}; font-weight: bold;">班級/科目</td>
                <td colspan="3" style="padding: 8px; border: 1px solid #333; ${isClassSheet ? 'background: ' + highlightBg + ';' : ''}">${coursesListHTML}</td>
            </tr>
            ${fourthRowHTML}
        </table>`;

        return `
        <div style="height: 100%; display: flex; flex-direction: column;">
            <!-- 標題區 -->
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px;">
                <div style="font-size: 16px; font-weight: bold;">${this.schoolName}</div>
                <div style="font-size: 22px; font-weight: bold; letter-spacing: 8px;">代課通知單</div>
                <div style="
                    background: #555;
                    color: white;
                    padding: 6px 12px;
                    font-size: 12px;
                    font-weight: bold;
                    border-radius: 4px;
                ">${sheet.label}</div>
            </div>

            <!-- 基本資訊表格 -->
            ${infoTableHTML}

            <!-- 課表異動 -->
            <div style="flex: 1;">
                ${scheduleTableHTML}
            </div>

            <!-- 底部簽章區 -->
            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 15px; font-size: 11px;">
                <div>
                    列印日期：${printDate} (此單一式四聯，請依聯單執存)
                </div>
                <div style="display: flex; gap: 30px;">
                    <div>申請人：__________</div>
                    <div>教務處：__________</div>
                </div>
            </div>
        </div>
        `;
    }

    /**
     * 建立多節課週課表 HTML（顯示多個異動課程）
     * @param {Array} schedule - 教師週課表（目前未使用，保留參數位置）
     * @param {Array} records - 該週要標示的異動紀錄
     * @param {string} teacherName - 教師姓名
     * @param {Object} [options] - 可選設定
     * @param {Function} [options.colorFn] - (record) => 背景色字串；預設代課深灰、調課淺灰
     * @param {Function} [options.cellRenderer] - (record) => innerHTML 字串；預設「日期/班級科目/原X代Y」
     */
    createMultiCourseScheduleTableHTML(schedule, records, teacherName, options = {}) {
        let tableRows = '';

        // 灰階顏色定義
        const defaultColorFn = (r) => (r.type === '調課' ? '#e0e0e0' : '#c0c0c0');
        const colorFn = options.colorFn || defaultColorFn;
        const cellRenderer = options.cellRenderer || ((r) => {
            const dateObj = new Date(r.date);
            const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
            const classInfo = `${r.className} ${r.subject || ''}`;
            const teacherInfo = r.type === '調課'
                ? (r.isSelfSwap
                    ? `${r.originalTeacher}<br>(自調)`
                    : `原 ${r.originalTeacher}<br>調 ${r.swapTeacher || r.substituteTeacher || ''}`)
                : `原 ${r.originalTeacher}<br>代 ${r.substituteTeacher || ''}`;
            return `${dateStr}<br>${classInfo}<br>${teacherInfo}`;
        });

        this.periods.forEach((period, index) => {
            let row = `<td style="padding: 10px 6px; border: 1px solid #333; font-weight: bold; text-align: center; width: 60px; background: #f5f5f5; font-size: 13px;">${period}</td>`;

            this.weekdays.forEach(weekday => {
                // 檢查是否為本次異動的節次
                const normalizedPeriod = this.normalizePeriod(period);
                const matchedRecord = records.find(r =>
                    r.weekday === weekday && this.normalizePeriod(r.period) === normalizedPeriod
                );

                if (matchedRecord) {
                    const bg = colorFn(matchedRecord);
                    row += `<td style="
                        padding: 8px 4px;
                        border: 1px solid #333;
                        text-align: center;
                        background: ${bg};
                        font-weight: bold;
                        font-size: 12px;
                        line-height: 1.4;
                    ">${cellRenderer(matchedRecord)}</td>`;
                } else {
                    // 其他節次留空
                    row += `<td style="padding: 10px 6px; border: 1px solid #333; height: 45px;"></td>`;
                }
            });

            tableRows += `<tr>${row}</tr>`;

            // 在第四節後插入午休分隔行
            if (index === 3) {
                tableRows += `
                <tr>
                    <td colspan="6" style="
                        padding: 6px;
                        border: 1px solid #333;
                        text-align: center;
                        background: #888;
                        color: white;
                        font-size: 12px;
                        font-weight: bold;
                        letter-spacing: 3px;
                    ">午 休</td>
                </tr>`;
            }
        });

        return `
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <thead>
                <tr style="background: #333; color: white;">
                    <th style="padding: 10px 6px; border: 1px solid #333; width: 60px; font-size: 14px;">節次</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週一</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週二</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週三</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週四</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週五</th>
                </tr>
            </thead>
            <tbody>
                ${tableRows}
            </tbody>
        </table>
        `;
    }

    /**
     * 建立單頁 HTML（左右兩聯）
     */
    createPageHTML(record, leftSheet, rightSheet, scheduleData) {
        const leftHTML = this.createSheetHTML(record, leftSheet, scheduleData);
        const rightHTML = this.createSheetHTML(record, rightSheet, scheduleData);

        return `
        <div style="
            display: flex;
            width: 1123px;
            height: 794px;
            font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif;
            background: white;
        ">
            <div style="flex: 1; padding: 20px; border-right: 1px dashed #ccc;">
                ${leftHTML}
            </div>
            <div style="flex: 1; padding: 20px;">
                ${rightHTML}
            </div>
        </div>
        `;
    }

    /**
     * 建立單聯 HTML
     * 根據聯別決定網底標識和顯示欄位：
     * - 原任課教師聯：網底原任課教師欄位
     * - 調代課教師聯：網底代課教師欄位，不顯示公假字號或理由
     * - 班級聯：網底班級科目欄位，不顯示請假假別及公假字號或理由
     * - 教學組聯：無網底，顯示完整資訊
     */
    createSheetHTML(record, sheet, scheduleData) {
        const teacherSchedule = this.getTeacherWeekSchedule(scheduleData, sheet.teacher);
        const scheduleTableHTML = this.createScheduleTableHTML(teacherSchedule, record, sheet.teacher);

        // 格式化日期
        const dateObj = new Date(record.date);
        const formattedDate = `${dateObj.getFullYear()}/${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')} (${record.weekday})`;

        // 列印日期
        const printDate = new Date().toLocaleDateString('zh-TW', {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric'
        });

        // 異動類型
        const changeType = record.type || '代課';
        const isSwap = changeType === '調課';

        // 假別
        const leaveType = record.leaveTypeName || record.leaveType || '-';

        // 公假字號
        const docNumber = record.docNumber || '-';

        // 判斷聯別類型
        const isOriginalTeacherSheet = sheet.label === '原任課教師聯';
        const isSubstituteTeacherSheet = sheet.label === '代（調）課教師聯';
        const isClassSheet = sheet.label === '班級聯';
        const isAdminSheet = sheet.label === '教學組聯';

        // 灰階網底顏色定義
        const highlightBg = '#d0d0d0';  // 深灰色網底用於標識重點欄位
        const normalBg = '#f5f5f5';     // 淺灰色背景

        // 根據是否為調課生成不同的基本資訊表格
        let infoTableHTML;
        if (isSwap) {
            // 格式化時段 A 和 B 的日期
            const dateAObj = new Date(record.date);
            const formattedDateA = `${dateAObj.getFullYear()}/${String(dateAObj.getMonth() + 1).padStart(2, '0')}/${String(dateAObj.getDate()).padStart(2, '0')}`;

            // 時段 B 日期（新增欄位）
            const dateBObj = record.swapDate ? new Date(record.swapDate) : dateAObj;
            const formattedDateB = `${dateBObj.getFullYear()}/${String(dateBObj.getMonth() + 1).padStart(2, '0')}/${String(dateBObj.getDate()).padStart(2, '0')}`;

            // 調課模式：根據聯別決定網底（灰階版本）
            // 時段 A 網底
            const slotALabelBg = isOriginalTeacherSheet ? highlightBg : '#e8e8e8';
            // 時段 B 網底
            const slotBLabelBg = isSubstituteTeacherSheet ? highlightBg : '#e8e8e8';
            // 班級欄位網底
            const classBg = isClassSheet ? highlightBg : normalBg;

            infoTableHTML = `
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 13px;">
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; width: 18%; font-weight: bold;">異動類型</td>
                    <td style="padding: 8px; border: 1px solid #333; width: 32%;">${changeType}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: ${classBg}; width: 18%; font-weight: bold;">班級</td>
                    <td style="padding: 8px; border: 1px solid #333; ${isClassSheet ? 'background: ' + highlightBg + ';' : ''} width: 32%;">${record.className}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${slotALabelBg}; font-weight: bold;">時段 A</td>
                    <td style="padding: 8px; border: 1px solid #333; ${isOriginalTeacherSheet ? 'background: ' + highlightBg + ';' : ''}"><strong>${formattedDateA}</strong><br>${record.weekday} ${record.period}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: ${slotALabelBg}; font-weight: bold;">課程</td>
                    <td style="padding: 8px; border: 1px solid #333; ${isOriginalTeacherSheet ? 'background: ' + highlightBg + ';' : ''}">${record.originalTeacher}（${record.subject}）</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${slotBLabelBg}; font-weight: bold;">時段 B</td>
                    <td style="padding: 8px; border: 1px solid #333; ${isSubstituteTeacherSheet ? 'background: ' + highlightBg + ';' : ''}"><strong>${formattedDateB}</strong><br>${record.swapWeekday || ''} ${record.swapPeriod || ''}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: ${slotBLabelBg}; font-weight: bold;">課程</td>
                    <td style="padding: 8px; border: 1px solid #333; ${isSubstituteTeacherSheet ? 'background: ' + highlightBg + ';' : ''}">${record.swapTeacher || ''}（${record.swapSubject || ''}）</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">調課說明</td>
                    <td colspan="3" style="padding: 8px; border: 1px solid #333;">${record.isSelfSwap
                        ? `${record.originalTeacher} 自行調動課程，A、B 時段科目互換`
                        : 'A、B 時段課程互換，兩位教師總時數不變'}</td>
                </tr>
            </table>`;
        } else {
            // 代課模式：根據聯別決定顯示欄位和網底
            // 原任課教師欄位網底
            const originalTeacherBg = isOriginalTeacherSheet ? highlightBg : normalBg;
            // 代課教師欄位網底
            const substituteTeacherBg = isSubstituteTeacherSheet ? highlightBg : normalBg;
            // 班級科目欄位網底
            const classSubjectBg = isClassSheet ? highlightBg : normalBg;

            // 決定是否顯示請假假別和公假字號
            // 調代課教師聯：不顯示公假字號或理由
            // 班級聯：不顯示請假假別及公假字號或理由
            const showLeaveType = !isClassSheet;
            const showDocNumber = !isSubstituteTeacherSheet && !isClassSheet;

            // 根據顯示需求組合第四行
            let fourthRowHTML = '';
            if (showLeaveType && showDocNumber) {
                // 完整顯示（教學組聯、原任課教師聯）
                fourthRowHTML = `
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">請假假別</td>
                    <td style="padding: 8px; border: 1px solid #333;">${leaveType}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">公假字號</td>
                    <td style="padding: 8px; border: 1px solid #333;">${docNumber}</td>
                </tr>`;
            } else if (showLeaveType && !showDocNumber) {
                // 只顯示請假假別（調代課教師聯）
                fourthRowHTML = `
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">請假假別</td>
                    <td colspan="3" style="padding: 8px; border: 1px solid #333;">${leaveType}</td>
                </tr>`;
            }
            // 班級聯：不顯示第四行

            infoTableHTML = `
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 13px;">
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; width: 18%; font-weight: bold;">異動類型</td>
                    <td style="padding: 8px; border: 1px solid #333; width: 32%;">${changeType}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: ${originalTeacherBg}; width: 18%; font-weight: bold;">原任課教師</td>
                    <td style="padding: 8px; border: 1px solid #333; ${isOriginalTeacherSheet ? 'background: ' + highlightBg + ';' : ''} width: 32%;">${record.originalTeacher}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">日期</td>
                    <td style="padding: 8px; border: 1px solid #333;">${formattedDate}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: ${substituteTeacherBg}; font-weight: bold;">代課教師</td>
                    <td style="padding: 8px; border: 1px solid #333; ${isSubstituteTeacherSheet ? 'background: ' + highlightBg + ';' : ''}">${record.substituteTeacher}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: ${normalBg}; font-weight: bold;">節次</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.period}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: ${classSubjectBg}; font-weight: bold;">班級/科目</td>
                    <td style="padding: 8px; border: 1px solid #333; ${isClassSheet ? 'background: ' + highlightBg + ';' : ''}">${record.className} ${record.subject}</td>
                </tr>
                ${fourthRowHTML}
            </table>`;
        }

        return `
        <div style="height: 100%; display: flex; flex-direction: column;">
            <!-- 標題區 -->
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px;">
                <div style="font-size: 16px; font-weight: bold;">${this.schoolName}</div>
                <div style="font-size: 22px; font-weight: bold; letter-spacing: 8px;">${isSwap ? '調課' : '代課'}通知單</div>
                <div style="
                    background: #555;
                    color: white;
                    padding: 6px 12px;
                    font-size: 12px;
                    font-weight: bold;
                    border-radius: 4px;
                ">${sheet.label}</div>
            </div>

            <!-- 基本資訊表格 -->
            ${infoTableHTML}

            <!-- 課表異動 -->
            <div style="flex: 1;">
                ${scheduleTableHTML}
            </div>

            <!-- 底部簽章區 -->
            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 15px; font-size: 11px;">
                <div>
                    列印日期：${printDate} (此單一式四聯，請依聯單執存)
                </div>
                <div style="display: flex; gap: 30px;">
                    <div>申請人：__________</div>
                    <div>教務處：__________</div>
                </div>
            </div>
        </div>
        `;
    }

    /**
     * 標準化節次格式
     * @param {string} period - 節次字串
     * @returns {string} 標準化後的節次
     */
    normalizePeriod(period) {
        return this.periodAliases[period] || period;
    }

    /**
     * 建立週課表 HTML（僅顯示異動課程，其他留空）
     * 包含午休分隔行（在第四及第五節之間）
     * 使用灰階樣式以便黑白列印
     */
    createScheduleTableHTML(schedule, record, teacherName) {
        const isSwap = record.type === '調課';
        let tableRows = '';

        // 標準化 record 中的節次格式
        const recordPeriod = this.normalizePeriod(record.period);
        const swapPeriod = record.swapPeriod ? this.normalizePeriod(record.swapPeriod) : null;

        // 灰階顏色定義
        const slotABg = '#c0c0c0';  // 時段 A 網底（深灰）
        const slotBBg = '#e0e0e0';  // 時段 B 網底（淺灰）

        this.periods.forEach((period, index) => {
            let row = `<td style="padding: 10px 6px; border: 1px solid #333; font-weight: bold; text-align: center; width: 60px; background: #f5f5f5; font-size: 13px;">${period}</td>`;

            this.weekdays.forEach(weekday => {
                // 檢查是否為本次異動的節次（時段 A）
                const isSlotA = record.weekday === weekday && recordPeriod === period;
                // 檢查是否為調課的另一時段（時段 B）
                const isSlotB = isSwap && record.swapWeekday === weekday && swapPeriod === period;

                if (isSlotA) {
                    // 時段 A：深灰色網底標記
                    // 顯示格式：日期 + 班級/科目 + 原 OOO / 代 OOO
                    const dateA = new Date(record.date);
                    const dateAStr = `${dateA.getMonth() + 1}/${dateA.getDate()}`;
                    const classInfo = `${record.className} ${record.subject}`;
                    const teacherInfo = isSwap
                        ? (record.isSelfSwap
                            ? `${record.originalTeacher}<br>→ ${record.swapSubject || ''}`
                            : `原 ${record.originalTeacher}<br>調 ${record.swapTeacher}`)
                        : `原 ${record.originalTeacher}<br>代 ${record.substituteTeacher}`;
                    row += `<td style="
                        padding: 8px 4px;
                        border: 1px solid #333;
                        text-align: center;
                        background: ${slotABg};
                        font-weight: bold;
                        font-size: 12px;
                        line-height: 1.4;
                    ">${dateAStr}<br>${classInfo}<br>${teacherInfo}</td>`;
                } else if (isSlotB) {
                    // 時段 B：淺灰色網底標記（調課時的另一時段）
                    // 顯示格式：日期 + 班級/科目 + 原 OOO / 調 OOO
                    const dateBObj = record.swapDate ? new Date(record.swapDate) : new Date(record.date);
                    const dateBStr = `${dateBObj.getMonth() + 1}/${dateBObj.getDate()}`;
                    const classInfoB = `${record.className} ${record.swapSubject || record.subject}`;
                    row += `<td style="
                        padding: 8px 4px;
                        border: 1px solid #333;
                        text-align: center;
                        background: ${slotBBg};
                        font-weight: bold;
                        font-size: 12px;
                        line-height: 1.4;
                    ">${dateBStr}<br>${classInfoB}<br>${record.isSelfSwap
                        ? `${record.originalTeacher}<br>→ ${record.subject || ''}`
                        : `原 ${record.swapTeacher}<br>調 ${record.originalTeacher}`}</td>`;
                } else {
                    // 其他節次留空
                    row += `<td style="padding: 10px 6px; border: 1px solid #333; height: 45px;"></td>`;
                }
            });

            tableRows += `<tr>${row}</tr>`;

            // 在第四節後插入午休分隔行（index 為 3 時是第四節）
            if (index === 3) {
                tableRows += `
                <tr>
                    <td colspan="6" style="
                        padding: 6px;
                        border: 1px solid #333;
                        text-align: center;
                        background: #888;
                        color: white;
                        font-size: 12px;
                        font-weight: bold;
                        letter-spacing: 3px;
                    ">午 休</td>
                </tr>`;
            }
        });

        return `
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <thead>
                <tr style="background: #333; color: white;">
                    <th style="padding: 10px 6px; border: 1px solid #333; width: 60px; font-size: 14px;">節次</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週一</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週二</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週三</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週四</th>
                    <th style="padding: 10px 6px; border: 1px solid #333; font-size: 14px;">週五</th>
                </tr>
            </thead>
            <tbody>
                ${tableRows}
            </tbody>
        </table>
        `;
    }

    /**
     * 取得教師週課表
     */
    getTeacherWeekSchedule(scheduleData, teacherName) {
        return scheduleData.filter(course => course.teacher === teacherName);
    }

    // ============================================================
    // 週彙整通知單（v1.11.0）
    // ============================================================

    /**
     * 取得指定日期所在週的週一日期字串 (YYYY-MM-DD)
     */
    getWeekStart(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        const day = d.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
        const diff = day === 0 ? -6 : 1 - day;
        d.setDate(d.getDate() + diff);
        return this.formatDate(d);
    }

    /**
     * 取得教學週範圍（週一到週五）
     */
    getWeekRange(weekStart) {
        const start = new Date(weekStart + 'T00:00:00');
        const dates = [];
        for (let i = 0; i < 5; i++) {
            const d = new Date(start);
            d.setDate(d.getDate() + i);
            dates.push(this.formatDate(d));
        }
        return { start: weekStart, end: dates[4], dates };
    }

    /**
     * 取得班級週課表
     */
    getClassWeekSchedule(scheduleData, className) {
        return scheduleData.filter(course => course.className === className);
    }

    /** YYYY-MM-DD */
    formatDate(d) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    /** M/D */
    formatMonthDay(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        return `${d.getMonth() + 1}/${d.getDate()}`;
    }

    /** YYYY/MM/DD(週X) */
    formatWeekLabel(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
        return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}(${wd})`;
    }

    /**
     * 將紀錄依收件方分群（為週彙整 PDF 準備）
     * @returns {{adminAll: Array, byClass: Object, byOriginalTeacher: Object, bySubstituteTeacher: Object}}
     */
    groupRecordsByRecipient(records) {
        const cmp = (a, b) => {
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            const pa = this.periods.indexOf(this.normalizePeriod(a.period));
            const pb = this.periods.indexOf(this.normalizePeriod(b.period));
            return pa - pb;
        };

        const adminAll = [...records].sort(cmp);
        const byClass = {};
        const byOriginalTeacher = {};
        const bySubstituteTeacher = {};

        records.forEach(r => {
            if (r.className) {
                (byClass[r.className] = byClass[r.className] || []).push(r);
            }
            if (r.originalTeacher) {
                (byOriginalTeacher[r.originalTeacher] = byOriginalTeacher[r.originalTeacher] || []).push(r);
            }
            const subT = r.swapTeacher || r.substituteTeacher;
            if (subT && subT !== r.originalTeacher) {
                (bySubstituteTeacher[subT] = bySubstituteTeacher[subT] || []).push(r);
            }
        });

        Object.values(byClass).forEach(arr => arr.sort(cmp));
        Object.values(byOriginalTeacher).forEach(arr => arr.sort(cmp));
        Object.values(bySubstituteTeacher).forEach(arr => arr.sort(cmp));

        return { adminAll, byClass, byOriginalTeacher, bySubstituteTeacher };
    }

    /**
     * 渲染通用週彙整列表表格
     * @param {Array} records
     * @param {Array<{label, getValue, width?, align?}>} columns
     * @param {Object} [options]
     * @param {string} [options.rowGroupKey] - 同 key 值的相鄰列用淡灰背景區隔（用於多節 group）
     * @param {number} [options.fontSize=11]
     * @param {string} [options.headerBg='#333']
     */
    createWeeklySummaryTableHTML(records, columns, options = {}) {
        const { rowGroupKey = null, fontSize = 11, headerBg = '#333' } = options;

        const head = columns.map(c =>
            `<th style="padding: 6px 4px; border: 1px solid #333; font-size: ${fontSize}px; ${c.width ? 'width: ' + c.width + ';' : ''}">${c.label}</th>`
        ).join('');

        if (records.length === 0) {
            return `<table style="width:100%; border-collapse:collapse;">
                <thead><tr style="background:${headerBg}; color:white;">${head}</tr></thead>
                <tbody><tr><td colspan="${columns.length}" style="padding:18px; border:1px solid #333; text-align:center; color:#666;">本週無相關紀錄</td></tr></tbody>
            </table>`;
        }

        let prevGroup = null;
        let stripeOn = false;
        const rows = records.map((r, i) => {
            if (rowGroupKey && r[rowGroupKey]) {
                if (r[rowGroupKey] !== prevGroup) {
                    stripeOn = !stripeOn;
                    prevGroup = r[rowGroupKey];
                }
            } else {
                prevGroup = null;
            }
            const bg = (rowGroupKey && r[rowGroupKey] && stripeOn) ? '#f0f0f0' : '#ffffff';
            const cells = columns.map(c =>
                `<td style="padding: 5px 4px; border: 1px solid #333; font-size: ${fontSize}px; text-align: ${c.align || 'left'};">${c.getValue(r, i)}</td>`
            ).join('');
            return `<tr style="background: ${bg};">${cells}</tr>`;
        }).join('');

        return `
        <table style="width: 100%; border-collapse: collapse;">
            <thead><tr style="background: ${headerBg}; color: white;">${head}</tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    }

    /**
     * 教學組頁 HTML（A4 直向、長列表，超過 CHUNK 列分頁）
     */
    createAdminWeeklyPageHTML(records, weekRange, pageIdx = 0, totalChunks = 1) {
        const printDate = new Date().toLocaleDateString('zh-TW');
        const weekStartLabel = this.formatWeekLabel(weekRange.start);
        const weekEndLabel = this.formatWeekLabel(weekRange.end);
        const pageInfo = totalChunks > 1 ? ` (頁 ${pageIdx + 1}/${totalChunks})` : '';

        const offset = pageIdx * 25;
        const columns = [
            { label: '序', width: '5%', align: 'center', getValue: (r, i) => offset + i + 1 },
            { label: '日期', width: '10%', align: 'center', getValue: (r) => this.formatMonthDay(r.date) },
            { label: '週', width: '5%', align: 'center', getValue: (r) => (r.weekday || '').replace('週', '') },
            { label: '節', width: '8%', align: 'center', getValue: (r) => r.period || '' },
            { label: '班級', width: '9%', align: 'center', getValue: (r) => r.className || '' },
            { label: '科目', width: '10%', align: 'center', getValue: (r) => r.subject || '' },
            { label: '原任課', width: '10%', align: 'center', getValue: (r) => r.originalTeacher || '' },
            { label: '代/調入', width: '12%', align: 'center', getValue: (r) => {
                if (r.type === '調課') return r.isSelfSwap ? '(自調)' : (r.swapTeacher || r.substituteTeacher || '');
                return r.substituteTeacher || '';
            }},
            { label: '類型', width: '8%', align: 'center', getValue: (r) => r.type || '代課' },
            { label: '假別/字號', width: '23%', align: 'left', getValue: (r) => {
                const lt = r.leaveTypeName || r.leaveType || '-';
                const dn = r.docNumber ? ` / ${r.docNumber}` : '';
                return lt + dn;
            }},
        ];

        const tableHTML = this.createWeeklySummaryTableHTML(records, columns, {
            rowGroupKey: 'multiCourseGroupId',
            fontSize: 11,
        });

        // 合計（只在最後一頁顯示）
        const isLastPage = pageIdx === totalChunks - 1;
        let footerHTML = '';
        if (isLastPage) {
            // 取得完整 records 用於合計（這裡只能算當前 chunk，因此合計需上層傳；簡化為當頁 + 提示）
            footerHTML = `
            <div style="margin-top: 12px; padding: 8px 12px; background: #f5f5f5; border: 1px solid #333; font-size: 12px;">
                <strong>本頁 ${records.length} 筆</strong>（含代課 ${records.filter(r => r.type !== '調課').length} 筆 / 調課 ${records.filter(r => r.type === '調課').length} 筆）
            </div>
            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 14px; font-size: 11px;">
                <div>列印日期：${printDate}</div>
                <div style="display: flex; gap: 24px;">
                    <div>教學組長：__________</div>
                    <div>教務主任：__________</div>
                    <div>校長：__________</div>
                </div>
            </div>`;
        }

        return `
        <div style="
            width: 794px;
            min-height: 1123px;
            padding: 30px 25px;
            font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif;
            background: white;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        ">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                <div style="font-size: 14px; font-weight: bold;">${this.schoolName}</div>
                <div style="font-size: 20px; font-weight: bold; letter-spacing: 4px;">週彙整調代課通知單</div>
                <div style="background: #555; color: white; padding: 6px 12px; font-size: 12px; font-weight: bold; border-radius: 4px;">教學組聯</div>
            </div>

            <div style="margin-bottom: 10px; font-size: 13px;">
                <strong>週次：</strong>${weekStartLabel} ~ ${weekEndLabel}${pageInfo}
            </div>

            <div style="flex: 1;">
                ${tableHTML}
            </div>

            ${footerHTML}
        </div>
        `;
    }

    /**
     * 老師週彙整頁 HTML（A4 橫向；左週課表、右精簡列表）
     * @param {string} role - 'original' | 'substitute'
     */
    createTeacherWeeklyPageHTML(records, teacherName, role, weekRange, scheduleData) {
        const isOriginal = role === 'original';
        const sheetLabel = isOriginal ? `${teacherName} 原任課聯` : `${teacherName} 代課聯`;
        const teacherSchedule = this.getTeacherWeekSchedule(scheduleData, teacherName);

        const scheduleTableHTML = this.createMultiCourseScheduleTableHTML(teacherSchedule, records, teacherName, {
            cellRenderer: isOriginal
                ? (r) => {
                    const dateObj = new Date(r.date);
                    const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
                    const classInfo = `${r.className} ${r.subject || ''}`;
                    const sub = r.type === '調課'
                        ? (r.isSelfSwap ? '(自調)' : (r.swapTeacher || ''))
                        : (r.substituteTeacher || '');
                    return `${dateStr}<br>${classInfo}<br>${r.type === '調課' ? '調' : '代'} ${sub}`;
                }
                : (r) => {
                    const dateObj = new Date(r.date);
                    const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
                    const classInfo = `${r.className} ${r.subject || ''}`;
                    return `${dateStr}<br>${classInfo}<br>原 ${r.originalTeacher}`;
                }
        });

        const columns = [
            { label: '日期', align: 'center', width: '12%', getValue: (r) => this.formatMonthDay(r.date) },
            { label: '週', align: 'center', width: '7%', getValue: (r) => (r.weekday || '').replace('週', '') },
            { label: '節', align: 'center', width: '13%', getValue: (r) => r.period || '' },
            { label: '班/科', align: 'left', width: '28%', getValue: (r) => `${r.className} ${r.subject || ''}` },
            { label: isOriginal ? '代/調入' : '原任課', align: 'center', width: '20%', getValue: (r) => {
                if (isOriginal) {
                    if (r.type === '調課') return r.isSelfSwap ? '(自調)' : (r.swapTeacher || r.substituteTeacher || '');
                    return r.substituteTeacher || '';
                }
                return r.originalTeacher || '';
            }},
            { label: '類型', align: 'center', width: '20%', getValue: (r) => {
                const t = r.type || '代課';
                if (t === '調課' && r.swapDate && this.getWeekStart(r.swapDate) !== weekRange.start) {
                    const sd = new Date(r.swapDate + 'T00:00:00');
                    return `${t}<br><span style="font-size:9px;">↔ ${sd.getMonth() + 1}/${sd.getDate()} ${r.swapPeriod || ''}</span>`;
                }
                return t;
            }},
        ];

        const listHTML = this.createWeeklySummaryTableHTML(records, columns, {
            rowGroupKey: 'multiCourseGroupId',
            fontSize: 11,
        });

        const printDate = new Date().toLocaleDateString('zh-TW');
        const weekLabel = `${this.formatMonthDay(weekRange.start)} ~ ${this.formatMonthDay(weekRange.end)}`;

        return `
        <div style="
            width: 1123px;
            height: 794px;
            padding: 20px;
            font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif;
            background: white;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        ">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                <div style="font-size: 14px; font-weight: bold;">${this.schoolName}</div>
                <div style="font-size: 20px; font-weight: bold; letter-spacing: 4px;">週彙整通知單</div>
                <div style="background: #555; color: white; padding: 6px 12px; font-size: 12px; font-weight: bold; border-radius: 4px;">${sheetLabel}</div>
            </div>

            <div style="margin-bottom: 8px; font-size: 13px;">
                <strong>週次：</strong>${weekLabel}　　共 ${records.length} 筆異動
            </div>

            <div style="display: flex; gap: 14px; flex: 1; min-height: 0;">
                <div style="flex: 1.4; overflow: hidden;">
                    ${scheduleTableHTML}
                </div>
                <div style="flex: 1; overflow: hidden;">
                    ${listHTML}
                </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 12px; font-size: 11px;">
                <div>列印日期：${printDate}</div>
                <div style="display: flex; gap: 24px;">
                    <div>${isOriginal ? '原任課' : '代課'}教師：${teacherName}</div>
                    <div>申請人：__________</div>
                    <div>教務處：__________</div>
                </div>
            </div>
        </div>
        `;
    }

    /**
     * 班級週彙整頁 HTML（A4 橫向；左週課表、右精簡列表）
     */
    createClassWeeklyPageHTML(records, className, weekRange, scheduleData) {
        const classSchedule = this.getClassWeekSchedule(scheduleData, className);

        const scheduleTableHTML = this.createMultiCourseScheduleTableHTML(classSchedule, records, className, {
            cellRenderer: (r) => {
                const dateObj = new Date(r.date);
                const dateStr = `${dateObj.getMonth() + 1}/${dateObj.getDate()}`;
                const subject = r.subject || '';
                const change = r.type === '調課'
                    ? (r.isSelfSwap ? `${r.originalTeacher}<br>(自調)` : `原 ${r.originalTeacher}<br>調 ${r.swapTeacher || ''}`)
                    : `原 ${r.originalTeacher}<br>代 ${r.substituteTeacher || ''}`;
                return `${dateStr}<br>${subject}<br>${change}`;
            }
        });

        const columns = [
            { label: '日期', align: 'center', width: '12%', getValue: (r) => this.formatMonthDay(r.date) },
            { label: '週', align: 'center', width: '7%', getValue: (r) => (r.weekday || '').replace('週', '') },
            { label: '節', align: 'center', width: '13%', getValue: (r) => r.period || '' },
            { label: '科目', align: 'left', width: '18%', getValue: (r) => r.subject || '' },
            { label: '原任課', align: 'center', width: '15%', getValue: (r) => r.originalTeacher || '' },
            { label: '代/調入', align: 'center', width: '20%', getValue: (r) => {
                if (r.type === '調課') return r.isSelfSwap ? '(自調)' : (r.swapTeacher || r.substituteTeacher || '');
                return r.substituteTeacher || '';
            }},
            { label: '類型', align: 'center', width: '15%', getValue: (r) => r.type || '代課' },
        ];

        const listHTML = this.createWeeklySummaryTableHTML(records, columns, {
            rowGroupKey: 'multiCourseGroupId',
            fontSize: 11,
        });

        const printDate = new Date().toLocaleDateString('zh-TW');
        const weekLabel = `${this.formatMonthDay(weekRange.start)} ~ ${this.formatMonthDay(weekRange.end)}`;

        return `
        <div style="
            width: 1123px;
            height: 794px;
            padding: 20px;
            font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif;
            background: white;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
        ">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                <div style="font-size: 14px; font-weight: bold;">${this.schoolName}</div>
                <div style="font-size: 20px; font-weight: bold; letter-spacing: 4px;">週彙整通知單</div>
                <div style="background: #555; color: white; padding: 6px 12px; font-size: 12px; font-weight: bold; border-radius: 4px;">${className} 班級聯</div>
            </div>

            <div style="margin-bottom: 8px; font-size: 13px;">
                <strong>週次：</strong>${weekLabel}　　共 ${records.length} 筆異動
            </div>

            <div style="display: flex; gap: 14px; flex: 1; min-height: 0;">
                <div style="flex: 1.4; overflow: hidden;">
                    ${scheduleTableHTML}
                </div>
                <div style="flex: 1; overflow: hidden;">
                    ${listHTML}
                </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 12px; font-size: 11px;">
                <div>列印日期：${printDate}</div>
                <div style="display: flex; gap: 24px;">
                    <div>班級：${className}</div>
                    <div>導師：__________</div>
                    <div>教務處：__________</div>
                </div>
            </div>
        </div>
        `;
    }

    /**
     * 週彙整 PDF 主入口
     *
     * 輸出 1 份綜合 PDF，頁序：
     *   1) 教學組全校彙整（A4 直向，25 筆/頁）
     *   2) 各班級頁（A4 橫向）
     *   3) 各原任課老師頁（A4 橫向）
     *   4) 各代課老師頁（A4 橫向）
     *
     * @param {string} weekStart - 週一日期 YYYY-MM-DD
     * @param {Array} recordsInWeek - 已篩選為當週的紀錄
     * @param {Array} scheduleData - 全部課表
     * @param {Array} teachers - 全部教師
     */
    async generateWeeklySummaryForm(weekStart, recordsInWeek, scheduleData, teachers) {
        const { jsPDF } = window.jspdf;
        const weekRange = this.getWeekRange(weekStart);
        const groups = this.groupRecordsByRecipient(recordsInWeek);

        // 初始化 PDF（首頁 portrait = 教學組）
        const doc = new jsPDF('p', 'mm', 'a4');

        const container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: -9999px; top: 0;';
        document.body.appendChild(container);

        const renderPage = async (html, width, orientation) => {
            container.style.width = `${width}px`;
            container.innerHTML = html;
            await new Promise(r => setTimeout(r, 150));
            const canvas = await html2canvas(container, {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff'
            });
            const imgData = canvas.toDataURL('image/jpeg', 0.95);
            if (orientation === 'portrait') {
                doc.addImage(imgData, 'JPEG', 0, 0, 210, 297);
            } else {
                doc.addImage(imgData, 'JPEG', 0, 0, 297, 210);
            }
        };

        try {
            // 1) 教學組頁（25 筆/頁切 chunk）
            const CHUNK_SIZE = 25;
            const adminChunks = [];
            for (let i = 0; i < groups.adminAll.length; i += CHUNK_SIZE) {
                adminChunks.push(groups.adminAll.slice(i, i + CHUNK_SIZE));
            }
            if (adminChunks.length === 0) adminChunks.push([]);

            for (let i = 0; i < adminChunks.length; i++) {
                if (i > 0) doc.addPage('a4', 'portrait');
                const html = this.createAdminWeeklyPageHTML(adminChunks[i], weekRange, i, adminChunks.length);
                await renderPage(html, 794, 'portrait');
            }

            // 2) 各班頁
            const classNames = Object.keys(groups.byClass).sort((a, b) => a.localeCompare(b, 'zh-TW'));
            for (const cls of classNames) {
                doc.addPage('a4', 'landscape');
                const html = this.createClassWeeklyPageHTML(groups.byClass[cls], cls, weekRange, scheduleData);
                await renderPage(html, 1123, 'landscape');
            }

            // 3) 各原任課老師頁
            const origTeachers = Object.keys(groups.byOriginalTeacher).sort((a, b) => a.localeCompare(b, 'zh-TW'));
            for (const t of origTeachers) {
                doc.addPage('a4', 'landscape');
                const html = this.createTeacherWeeklyPageHTML(groups.byOriginalTeacher[t], t, 'original', weekRange, scheduleData);
                await renderPage(html, 1123, 'landscape');
            }

            // 4) 各代課老師頁
            const subTeachers = Object.keys(groups.bySubstituteTeacher).sort((a, b) => a.localeCompare(b, 'zh-TW'));
            for (const t of subTeachers) {
                doc.addPage('a4', 'landscape');
                const html = this.createTeacherWeeklyPageHTML(groups.bySubstituteTeacher[t], t, 'substitute', weekRange, scheduleData);
                await renderPage(html, 1123, 'landscape');
            }

            const fileName = `調代課週彙整_${weekRange.start.replace(/-/g, '')}-${weekRange.end.replace(/-/g, '')}.pdf`;
            doc.save(fileName);
        } finally {
            document.body.removeChild(container);
        }
    }

    /**
     * 生成月結算報表 PDF
     */
    async generateSettlementReport(settlementData, year, month) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('l', 'mm', 'a4'); // 橫向

        // 建立 HTML
        const html = this.createSettlementHTML(settlementData, year, month);

        // 建立隱藏容器
        const container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: -9999px; top: 0; width: 1100px;';
        container.innerHTML = html;
        document.body.appendChild(container);

        try {
            await new Promise(resolve => setTimeout(resolve, 100));

            const canvas = await html2canvas(container, {
                scale: 2,
                useCORS: true,
                logging: false
            });

            const imgData = canvas.toDataURL('image/jpeg', 0.95);
            const imgWidth = 297; // A4 橫向寬度
            const imgHeight = (canvas.height * imgWidth) / canvas.width;

            doc.addImage(imgData, 'JPEG', 0, 0, imgWidth, Math.min(imgHeight, 210));

            const fileName = `授課時數結算表_${year}學年度_${month}月.pdf`;
            doc.save(fileName);

        } finally {
            document.body.removeChild(container);
        }
    }

    /**
     * 建立結算表 HTML
     */
    createSettlementHTML(settlementData, year, month) {
        let tableRows = settlementData.map(row => `
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;">${row.teacherName}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${row.weeklyHours}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${row.originalHours}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center; color: #16a34a;">${row.substituteHours > 0 ? '+' + row.substituteHours : '-'}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center; color: #dc2626;">${row.substitutedHours > 0 ? '-' + row.substitutedHours : '-'}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center; font-weight: bold;">${row.actualHours}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${row.overtimeHours}</td>
            </tr>
        `).join('');

        // 合計
        const totals = settlementData.reduce((acc, row) => ({
            weekly: acc.weekly + row.weeklyHours,
            original: acc.original + row.originalHours,
            substitute: acc.substitute + row.substituteHours,
            substituted: acc.substituted + row.substitutedHours,
            actual: acc.actual + row.actualHours,
            overtime: acc.overtime + row.overtimeHours
        }), { weekly: 0, original: 0, substitute: 0, substituted: 0, actual: 0, overtime: 0 });

        tableRows += `
            <tr style="background: #f5f5f5; font-weight: bold;">
                <td style="padding: 8px; border: 1px solid #ddd;">合計</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${totals.weekly}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${totals.original}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center; color: #16a34a;">+${totals.substitute}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center; color: #dc2626;">-${totals.substituted}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${totals.actual}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${totals.overtime}</td>
            </tr>
        `;

        return `
        <div style="
            font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif;
            padding: 30px;
            background: white;
        ">
            <h1 style="text-align: center; font-size: 22px; margin-bottom: 20px; color: #2563eb;">
                ${year} 學年度 ${month} 月 教師授課時數結算表
            </h1>

            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr style="background: #2563eb; color: white;">
                        <th style="padding: 10px; border: 1px solid #1d4ed8;">教師姓名</th>
                        <th style="padding: 10px; border: 1px solid #1d4ed8;">每週節數</th>
                        <th style="padding: 10px; border: 1px solid #1d4ed8;">原定授課時數</th>
                        <th style="padding: 10px; border: 1px solid #1d4ed8;">代課增加</th>
                        <th style="padding: 10px; border: 1px solid #1d4ed8;">被代課減少</th>
                        <th style="padding: 10px; border: 1px solid #1d4ed8;">實際授課時數</th>
                        <th style="padding: 10px; border: 1px solid #1d4ed8;">超鐘點時數</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>

            <p style="margin-top: 20px; font-size: 11px; color: #666;">
                列印時間：${new Date().toLocaleString('zh-TW')} |
                計算基準：每週基本授課 20 節，每月以 4 週計算
            </p>
        </div>
        `;
    }
}
