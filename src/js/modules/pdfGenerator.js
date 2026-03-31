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
                <div style="font-size: 12px; font-weight: bold; margin-top: 6px; text-align: right;">
                    代課日期：${formattedDate}
                </div>
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
     */
    createMultiCourseScheduleTableHTML(schedule, records, teacherName) {
        let tableRows = '';

        // 灰階顏色定義
        const slotABg = '#c0c0c0';  // 時段 A 網底（深灰）

        this.periods.forEach((period, index) => {
            let row = `<td style="padding: 10px 6px; border: 1px solid #333; font-weight: bold; text-align: center; width: 60px; background: #f5f5f5; font-size: 13px;">${period}</td>`;

            this.weekdays.forEach(weekday => {
                // 檢查是否為本次異動的節次
                const normalizedPeriod = this.normalizePeriod(period);
                const matchedRecord = records.find(r =>
                    r.weekday === weekday && this.normalizePeriod(r.period) === normalizedPeriod
                );

                if (matchedRecord) {
                    // 異動的課程：深灰色網底標記
                    const classInfo = `${matchedRecord.className} ${matchedRecord.subject}`;
                    const teacherInfo = `原 ${matchedRecord.originalTeacher}<br>代 ${matchedRecord.substituteTeacher}`;
                    row += `<td style="
                        padding: 8px 4px;
                        border: 1px solid #333;
                        text-align: center;
                        background: ${slotABg};
                        font-weight: bold;
                        font-size: 12px;
                        line-height: 1.4;
                    ">${classInfo}<br>${teacherInfo}</td>`;
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
                    <td colspan="3" style="padding: 8px; border: 1px solid #333;">A、B 時段課程互換，兩位教師總時數不變</td>
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

        // 課表日期標籤
        let dateLabel;
        if (isSwap) {
            const dateBObj = record.swapDate ? new Date(record.swapDate) : dateObj;
            const swapDateStr = `${dateBObj.getFullYear()}/${String(dateBObj.getMonth() + 1).padStart(2, '0')}/${String(dateBObj.getDate()).padStart(2, '0')} (${record.swapWeekday || ''})`;
            dateLabel = `調課日期：${formattedDate}、${swapDateStr}`;
        } else {
            dateLabel = `代課日期：${formattedDate}`;
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
                <div style="font-size: 12px; font-weight: bold; margin-top: 6px; text-align: right;">
                    ${dateLabel}
                </div>
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
                    // 顯示格式：班級/科目 + 原 OOO / 代 OOO（三行）
                    const classInfo = `${record.className} ${record.subject}`;
                    const teacherInfo = isSwap
                        ? `原 ${record.originalTeacher}<br>調 ${record.swapTeacher}`
                        : `原 ${record.originalTeacher}<br>代 ${record.substituteTeacher}`;
                    row += `<td style="
                        padding: 8px 4px;
                        border: 1px solid #333;
                        text-align: center;
                        background: ${slotABg};
                        font-weight: bold;
                        font-size: 12px;
                        line-height: 1.4;
                    ">${classInfo}<br>${teacherInfo}</td>`;
                } else if (isSlotB) {
                    // 時段 B：淺灰色網底標記（調課時的另一時段）
                    // 顯示格式：班級/科目 + 原 OOO / 調 OOO（三行）
                    const classInfoB = `${record.className} ${record.swapSubject || record.subject}`;
                    row += `<td style="
                        padding: 8px 4px;
                        border: 1px solid #333;
                        text-align: center;
                        background: ${slotBBg};
                        font-weight: bold;
                        font-size: 12px;
                        line-height: 1.4;
                    ">${classInfoB}<br>原 ${record.swapTeacher}<br>調 ${record.originalTeacher}</td>`;
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
