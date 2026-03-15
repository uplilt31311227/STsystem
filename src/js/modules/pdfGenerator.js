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
        this.periods = ['第1節', '第2節', '第3節', '第4節', '第5節', '第6節', '第7節'];

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

        // 根據是否為調課生成不同的基本資訊表格
        let infoTableHTML;
        if (isSwap) {
            // 調課模式：顯示兩個時段的互換資訊
            infoTableHTML = `
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 13px;">
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; width: 18%; font-weight: bold;">異動類型</td>
                    <td style="padding: 8px; border: 1px solid #333; width: 32%;">${changeType}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; width: 18%; font-weight: bold;">班級</td>
                    <td style="padding: 8px; border: 1px solid #333; width: 32%;">${record.className}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: #dbeafe; font-weight: bold;">時段 A</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.weekday} ${record.period}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: #dbeafe; font-weight: bold;">課程</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.originalTeacher}（${record.subject}）</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: #fef3c7; font-weight: bold;">時段 B</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.swapWeekday || ''} ${record.swapPeriod || ''}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: #fef3c7; font-weight: bold;">課程</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.swapTeacher || ''}（${record.swapSubject || ''}）</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; font-weight: bold;">調課說明</td>
                    <td colspan="3" style="padding: 8px; border: 1px solid #333;">A、B 時段課程互換，兩位教師總時數不變</td>
                </tr>
            </table>`;
        } else {
            // 代課模式：原有的表格格式
            infoTableHTML = `
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 13px;">
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; width: 18%; font-weight: bold;">異動類型</td>
                    <td style="padding: 8px; border: 1px solid #333; width: 32%;">${changeType}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; width: 18%; font-weight: bold;">日期</td>
                    <td style="padding: 8px; border: 1px solid #333; width: 32%;">${formattedDate}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; font-weight: bold;">原任課教師</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.originalTeacher}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; font-weight: bold;">代課教師</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.substituteTeacher}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; font-weight: bold;">節次</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.period}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; font-weight: bold;">班級/科目</td>
                    <td style="padding: 8px; border: 1px solid #333;">${record.className} ${record.subject}</td>
                </tr>
                <tr>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; font-weight: bold;">請假假別</td>
                    <td style="padding: 8px; border: 1px solid #333;">${leaveType}</td>
                    <td style="padding: 8px; border: 1px solid #333; background: #f5f5f5; font-weight: bold;">公假字號</td>
                    <td style="padding: 8px; border: 1px solid #333;">${docNumber}</td>
                </tr>
            </table>`;
        }

        return `
        <div style="height: 100%; display: flex; flex-direction: column;">
            <!-- 標題區 -->
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px;">
                <div style="font-size: 16px; font-weight: bold;">${this.schoolName}</div>
                <div style="font-size: 22px; font-weight: bold; letter-spacing: 8px;">${isSwap ? '調課' : '代課'}通知單</div>
                <div style="
                    background: ${sheet.labelBg};
                    color: white;
                    padding: 6px 12px;
                    font-size: 12px;
                    font-weight: bold;
                    border-radius: 4px;
                ">${sheet.label}</div>
            </div>

            <!-- 基本資訊表格 -->
            ${infoTableHTML}

            <!-- 該週課表異動 -->
            <div style="flex: 1;">
                <div style="font-size: 13px; font-weight: bold; margin-bottom: 8px;">
                    ${sheet.teacher} 該週課表異動
                </div>
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
     * 建立週課表 HTML（僅顯示異動課程，其他留空）
     */
    createScheduleTableHTML(schedule, record, teacherName) {
        const isSwap = record.type === '調課';
        let tableRows = '';

        this.periods.forEach(period => {
            let row = `<td style="padding: 6px 4px; border: 1px solid #333; font-weight: bold; text-align: center; width: 50px;">${period}</td>`;

            this.weekdays.forEach(weekday => {
                // 檢查是否為本次異動的節次（時段 A）
                const isSlotA = record.weekday === weekday && record.period === period;
                // 檢查是否為調課的另一時段（時段 B）
                const isSlotB = isSwap && record.swapWeekday === weekday && record.swapPeriod === period;

                if (isSlotA) {
                    // 時段 A：藍色標記
                    const cellContent = isSwap
                        ? `${record.className}<br><span style="color: #2563eb;">→${record.swapTeacher}</span>`
                        : `${record.className}<br>${record.subject}`;
                    row += `<td style="
                        padding: 6px 4px;
                        border: 1px solid #333;
                        text-align: center;
                        background: #dbeafe;
                        font-weight: bold;
                        font-size: 11px;
                    ">${cellContent}</td>`;
                } else if (isSlotB) {
                    // 時段 B：橙色標記
                    row += `<td style="
                        padding: 6px 4px;
                        border: 1px solid #333;
                        text-align: center;
                        background: #fef3c7;
                        font-weight: bold;
                        font-size: 11px;
                    ">${record.className}<br><span style="color: #d97706;">→${record.originalTeacher}</span></td>`;
                } else {
                    // 其他節次留空
                    row += `<td style="padding: 6px 4px; border: 1px solid #333; height: 35px;"></td>`;
                }
            });

            tableRows += `<tr>${row}</tr>`;
        });

        return `
        <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <thead>
                <tr style="background: #4b5563; color: white;">
                    <th style="padding: 6px 4px; border: 1px solid #333; width: 50px;">節次</th>
                    <th style="padding: 6px 4px; border: 1px solid #333;">週一</th>
                    <th style="padding: 6px 4px; border: 1px solid #333;">週二</th>
                    <th style="padding: 6px 4px; border: 1px solid #333;">週三</th>
                    <th style="padding: 6px 4px; border: 1px solid #333;">週四</th>
                    <th style="padding: 6px 4px; border: 1px solid #333;">週五</th>
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
