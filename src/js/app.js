/**
 * 國中調代課自動化系統 - 主應用程式入口
 *
 * 功能概述：
 * 1. 課表與教師資料匯入
 * 2. 智慧推薦代課教師
 * 3. 一式四份調代課單 PDF 生成
 * 4. 月結算與時數統計
 */

// 匯入模組
import { DataManager } from './modules/dataManager.js';
import { ScheduleParser } from './modules/scheduleParser.js';
import { RecommendationEngine } from './modules/recommendationEngine.js';
import { PDFGenerator } from './modules/pdfGenerator.js';
import { GoogleSheetsAPI } from './modules/googleSheetsAPI.js';
import { SettlementCalculator } from './modules/settlementCalculator.js';

/**
 * 主應用程式類別
 */
class SubstituteTeacherApp {
    constructor() {
        // 初始化各模組
        this.dataManager = new DataManager();
        this.scheduleParser = new ScheduleParser();
        this.recommendationEngine = new RecommendationEngine();
        this.pdfGenerator = new PDFGenerator();
        this.googleSheetsAPI = new GoogleSheetsAPI();
        this.settlementCalculator = new SettlementCalculator();

        // 目前選中的課程資訊
        this.selectedCourse = null;
        this.selectedSubstitute = null;

        // 初始化應用程式
        this.init();
    }

    /**
     * 初始化應用程式
     */
    init() {
        // 綁定頁籤切換事件
        this.bindTabEvents();

        // 綁定檔案上傳事件
        this.bindUploadEvents();

        // 綁定調代課相關事件
        this.bindSubstituteEvents();

        // 綁定紀錄查詢事件
        this.bindRecordEvents();

        // 綁定結算相關事件
        this.bindSettlementEvents();

        // 綁定 Google Sheets 連線事件
        this.bindGoogleSheetsEvents();

        // 設定預設日期
        this.setDefaultDates();

        // 從 localStorage 載入已儲存的資料
        this.loadSavedData();

        console.log('國中調代課自動化系統已初始化');
    }

    /**
     * 綁定頁籤切換事件
     */
    bindTabEvents() {
        const tabButtons = document.querySelectorAll('.tab-btn');
        const tabContents = document.querySelectorAll('.tab-content');

        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                // 移除所有 active 狀態，添加 hidden
                tabButtons.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => {
                    c.classList.remove('active');
                    c.classList.add('hidden');
                });

                // 設定當前頁籤為 active，移除 hidden
                btn.classList.add('active');
                const tabId = btn.dataset.tab + '-tab';
                const tabContent = document.getElementById(tabId);
                tabContent.classList.add('active');
                tabContent.classList.remove('hidden');

                // 切換到調課紀錄頁籤時，自動載入本月資料
                if (btn.dataset.tab === 'records') {
                    this.loadCurrentMonthRecords();
                }
            });
        });
    }

    /**
     * 載入本月調課紀錄
     */
    loadCurrentMonthRecords() {
        // 設定日期為本月第一天到今天
        const today = new Date();
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

        const formatDate = (date) => date.toISOString().split('T')[0];

        document.getElementById('record-start-date').value = formatDate(firstDayOfMonth);
        document.getElementById('record-end-date').value = formatDate(lastDayOfMonth);
        document.getElementById('record-teacher').value = '';

        // 自動執行查詢
        this.searchRecords();
    }

    /**
     * 綁定檔案上傳事件
     */
    bindUploadEvents() {
        const uploadArea = document.getElementById('schedule-upload');
        const fileInput = document.getElementById('schedule-file');

        // 點擊上傳區域觸發檔案選擇
        uploadArea.addEventListener('click', () => fileInput.click());

        // 拖放事件
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });

        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('dragover');
        });

        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                this.handleScheduleFile(files[0]);
            }
        });

        // 檔案選擇事件
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.handleScheduleFile(e.target.files[0]);
            }
        });

        // 新增教師按鈕
        document.getElementById('add-teacher-btn')?.addEventListener('click', () => {
            this.addNewTeacherRow();
        });

        // 儲存資料按鈕
        document.getElementById('save-data-btn')?.addEventListener('click', () => {
            this.saveDataManually();
        });
    }

    /**
     * 處理課表檔案上傳
     */
    async handleScheduleFile(file) {
        try {
            console.log('正在處理檔案:', file.name);

            // 使用 ScheduleParser 解析檔案
            const parseResult = await this.scheduleParser.parseFile(file);

            if (parseResult.success) {
                // 儲存解析後的資料到 DataManager
                this.dataManager.setScheduleData(parseResult.scheduleData);
                this.dataManager.setTeachers(parseResult.teachers);
                this.dataManager.setClasses(parseResult.classes);

                // 更新 UI 顯示
                this.updateScheduleStatus(parseResult);
                this.updateTeacherTable();
                this.populateTeacherDropdowns();

                // 更新各頁籤顯示狀態
                this.updateTabContentVisibility();

                // 儲存到 localStorage
                this.saveDataToStorage();

                console.log('課表解析成功');
            } else {
                this.showError('課表解析失敗: ' + parseResult.error);
            }
        } catch (error) {
            console.error('檔案處理錯誤:', error);
            this.showError('檔案處理錯誤: ' + error.message);
        }
    }

    /**
     * 更新課表匯入狀態顯示
     */
    updateScheduleStatus(parseResult) {
        const statusBox = document.getElementById('schedule-status');
        statusBox.classList.remove('hidden', 'error');

        document.getElementById('class-count').textContent = parseResult.classes.length;
        document.getElementById('teacher-count').textContent = parseResult.teachers.length;
        document.getElementById('course-count').textContent = parseResult.scheduleData.length;

        // 顯示教師編輯區域
        document.getElementById('teacher-editor').classList.remove('hidden');
    }

    /**
     * 更新教師表格
     */
    updateTeacherTable() {
        const tbody = document.getElementById('teacher-tbody');
        const teachers = this.dataManager.getTeachers();

        tbody.innerHTML = '';

        teachers.forEach((teacher, index) => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>
                    <input type="text" value="${teacher.name}"
                           data-index="${index}" data-field="name"
                           class="teacher-input">
                </td>
                <td>
                    <input type="text" value="${teacher.domains.join(', ')}"
                           data-index="${index}" data-field="domains"
                           class="teacher-input" readonly
                           title="領域由課表自動偵測">
                </td>
                <td>
                    <select data-index="${index}" data-field="homeroomClass" class="teacher-input">
                        <option value="">非導師</option>
                        ${this.dataManager.getClasses().map(c =>
                `<option value="${c}" ${teacher.homeroomClass === c ? 'selected' : ''}>${c}</option>`
            ).join('')}
                    </select>
                </td>
                <td>
                    <button class="btn btn-sm btn-danger delete-teacher-btn" data-index="${index}">刪除</button>
                </td>
            `;
            tbody.appendChild(row);
        });

        // 綁定教師資料變更事件
        tbody.querySelectorAll('.teacher-input').forEach(input => {
            input.addEventListener('change', (e) => this.handleTeacherDataChange(e));
        });

        // 綁定刪除按鈕事件
        tbody.querySelectorAll('.delete-teacher-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                this.dataManager.removeTeacher(index);
                this.updateTeacherTable();
                this.saveDataToStorage();
            });
        });
    }

    /**
     * 處理教師資料變更
     */
    handleTeacherDataChange(e) {
        const index = parseInt(e.target.dataset.index);
        const field = e.target.dataset.field;
        const value = e.target.value;

        this.dataManager.updateTeacher(index, field, value);
        this.saveDataToStorage();
    }

    /**
     * 新增教師列
     */
    addNewTeacherRow() {
        this.dataManager.addTeacher({
            name: '新教師',
            domains: [],
            homeroomClass: ''
        });
        this.updateTeacherTable();
        this.saveDataToStorage();
    }

    /**
     * 填充教師下拉選單
     */
    populateTeacherDropdowns() {
        const teachers = this.dataManager.getTeachers();
        const options = teachers.map(t => `<option value="${t.name}">${t.name}</option>`).join('');

        // 調代課頁面的教師選單
        const subTeacherSelect = document.getElementById('sub-teacher');
        subTeacherSelect.innerHTML = '<option value="">請選擇教師</option>' + options;

        // 紀錄查詢頁面的教師篩選選單
        const recordTeacherSelect = document.getElementById('record-teacher');
        recordTeacherSelect.innerHTML = '<option value="">全部教師</option>' + options;
    }

    /**
     * 綁定調代課相關事件
     */
    bindSubstituteEvents() {
        // 教師選擇變更
        document.getElementById('sub-teacher').addEventListener('change', (e) => {
            this.onTeacherSelected(e.target.value);
        });

        // 日期變更
        document.getElementById('sub-date').addEventListener('change', () => {
            const teacher = document.getElementById('sub-teacher').value;
            if (teacher) {
                this.onTeacherSelected(teacher);
            }
        });

        // 異動類型切換（調課/代課）
        document.getElementById('change-type').addEventListener('change', (e) => {
            this.onChangeTypeSelected(e.target.value);
        });

        // 假別變更（動態顯示公假字號欄位）
        document.getElementById('leave-type').addEventListener('change', (e) => {
            this.onLeaveTypeChanged(e.target.value);
        });

        // 調課互換教師選擇
        document.getElementById('swap-teacher')?.addEventListener('change', (e) => {
            this.onSwapTeacherSelected(e.target.value);
        });

        // 確認調課按鈕
        document.getElementById('confirm-substitute-btn').addEventListener('click', () => {
            this.confirmSubstitute();
        });

        // 取消按鈕
        document.getElementById('cancel-substitute-btn').addEventListener('click', () => {
            this.cancelSubstitute();
        });
    }

    /**
     * 當異動類型變更時觸發（調課/代課）
     */
    onChangeTypeSelected(type) {
        const substituteOptions = document.getElementById('substitute-options');
        const swapOptions = document.getElementById('swap-options');
        const recommendationList = document.getElementById('recommendation-list');

        if (type === 'swap') {
            // 調課模式
            substituteOptions.classList.add('hidden');
            swapOptions.classList.remove('hidden');
            recommendationList.parentElement.querySelector('h3').textContent = '調課對象';

            // 更新調課教師列表
            if (this.selectedCourse) {
                this.updateSwapTeacherList();
            }
        } else {
            // 代課模式
            substituteOptions.classList.remove('hidden');
            swapOptions.classList.add('hidden');
            recommendationList.parentElement.querySelector('h3').textContent = '代課教師推薦（智慧排序）';
        }
    }

    /**
     * 當假別變更時觸發（動態顯示公假字號）
     */
    onLeaveTypeChanged(leaveType) {
        const docNumberGroup = document.getElementById('doc-number-group');
        const docNumberInput = document.getElementById('doc-number');

        if (leaveType === 'official') {
            // 公假：顯示並設為必填
            docNumberGroup.style.display = 'block';
            docNumberInput.required = true;
        } else {
            // 其他假別：隱藏並取消必填
            docNumberGroup.style.display = 'none';
            docNumberInput.required = false;
            docNumberInput.value = '';
        }
    }

    /**
     * 更新調課可互換教師列表
     * 嚴格驗證：只顯示該時段有「相同班級」課程的教師
     */
    updateSwapTeacherList() {
        const swapTeacherSelect = document.getElementById('swap-teacher');
        const swapHint = document.getElementById('swap-hint');
        const scheduleData = this.dataManager.getScheduleData();

        if (!this.selectedCourse) {
            swapTeacherSelect.innerHTML = '<option value="">請先選擇欲調課的課程</option>';
            return;
        }

        // 找出該時段有相同班級課程的其他教師
        const targetClass = this.selectedCourse.className;
        const targetWeekday = this.selectedCourse.weekday;
        const targetPeriod = this.selectedCourse.period;
        const originalTeacher = this.selectedCourse.originalTeacher;

        // 篩選該時段有課且班級相同的教師
        const eligibleTeachers = scheduleData.filter(course =>
            course.weekday === targetWeekday &&
            course.period === targetPeriod &&
            course.className === targetClass &&
            course.teacher !== originalTeacher
        );

        if (eligibleTeachers.length === 0) {
            swapTeacherSelect.innerHTML = '<option value="">該時段無可互換的教師（需相同班級）</option>';
            swapHint.innerHTML = `<span style="color: #dc2626;">⚠ ${targetWeekday} ${targetPeriod}，${targetClass} 沒有其他教師可互換</span>`;
            return;
        }

        // 建立下拉選單
        let options = '<option value="">請選擇互換教師</option>';
        eligibleTeachers.forEach(course => {
            options += `<option value="${course.teacher}" data-subject="${course.subject}">${course.teacher}（${course.subject}）</option>`;
        });

        swapTeacherSelect.innerHTML = options;
        swapHint.innerHTML = `✓ 找到 ${eligibleTeachers.length} 位可互換教師（${targetClass} ${targetWeekday} ${targetPeriod}）`;
        swapHint.style.color = '#16a34a';
    }

    /**
     * 當選擇調課互換教師時觸發
     */
    onSwapTeacherSelected(teacherName) {
        const validationError = document.getElementById('swap-validation-error');

        if (!teacherName) {
            this.selectedSubstitute = null;
            validationError.classList.add('hidden');
            return;
        }

        // 驗證班級是否相同（雙重保險）
        const scheduleData = this.dataManager.getScheduleData();
        const swapCourse = scheduleData.find(course =>
            course.weekday === this.selectedCourse.weekday &&
            course.period === this.selectedCourse.period &&
            course.teacher === teacherName
        );

        if (!swapCourse || swapCourse.className !== this.selectedCourse.className) {
            validationError.textContent = '⚠ 調課錯誤：兩位教師的班級不相同，無法調課！';
            validationError.classList.remove('hidden');
            this.selectedSubstitute = null;
            return;
        }

        validationError.classList.add('hidden');

        // 設定選中的互換教師
        const teachers = this.dataManager.getTeachers();
        const teacher = teachers.find(t => t.name === teacherName);
        this.selectedSubstitute = {
            teacher: teacher || { name: teacherName },
            swapCourse: swapCourse
        };
    }

    /**
     * 當選擇教師時觸發
     */
    onTeacherSelected(teacherName) {
        if (!teacherName) {
            document.getElementById('original-schedule').classList.add('hidden');
            return;
        }

        const date = document.getElementById('sub-date').value;
        if (!date) {
            alert('請先選擇調課日期');
            return;
        }

        // 取得該教師的週課表
        const weekSchedule = this.dataManager.getTeacherWeekSchedule(teacherName);

        // 顯示週課表
        this.renderTeacherSchedule(weekSchedule, teacherName);
        document.getElementById('original-schedule').classList.remove('hidden');
    }

    /**
     * 渲染教師週課表
     */
    renderTeacherSchedule(weekSchedule, teacherName) {
        const grid = document.getElementById('original-schedule-grid');
        const days = ['一', '二', '三', '四', '五'];
        const periods = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節'];

        let html = '';

        // 標題列
        html += '<div class="schedule-cell schedule-header">節次</div>';
        days.forEach(day => {
            html += `<div class="schedule-cell schedule-header">週${day}</div>`;
        });

        // 各節次
        periods.forEach((period, periodIndex) => {
            html += `<div class="schedule-cell schedule-period">${period}</div>`;

            days.forEach((day, dayIndex) => {
                const dayName = '週' + day;
                const courses = weekSchedule.filter(c =>
                    c.weekday === dayName && c.period === period
                );

                if (courses.length > 0) {
                    const course = courses[0];
                    html += `
                        <div class="schedule-cell schedule-course"
                             data-weekday="${dayName}"
                             data-period="${period}"
                             data-class="${course.className}"
                             data-subject="${course.subject}"
                             data-domain="${course.domain}">
                            <span class="course-class">${course.className}</span>
                            <span class="course-subject">${course.subject}</span>
                        </div>
                    `;
                } else {
                    html += `<div class="schedule-cell schedule-course free">空堂</div>`;
                }
            });
        });

        grid.innerHTML = html;

        // 綁定課程點擊事件
        grid.querySelectorAll('.schedule-course:not(.free)').forEach(cell => {
            cell.addEventListener('click', (e) => this.onCourseSelected(e.target.closest('.schedule-course')));
        });
    }

    /**
     * 當選擇課程時觸發
     */
    onCourseSelected(cell) {
        // 移除其他選中狀態
        document.querySelectorAll('.schedule-course.selected').forEach(c => c.classList.remove('selected'));

        // 選中當前課程
        cell.classList.add('selected');

        // 取得課程資訊
        const teacherName = document.getElementById('sub-teacher').value;
        this.selectedCourse = {
            weekday: cell.dataset.weekday,
            period: cell.dataset.period,
            className: cell.dataset.class,
            subject: cell.dataset.subject,
            domain: cell.dataset.domain,
            originalTeacher: teacherName
        };

        // 更新選中課程資訊顯示
        document.getElementById('sel-class').textContent = this.selectedCourse.className;
        document.getElementById('sel-period').textContent = `${this.selectedCourse.weekday} ${this.selectedCourse.period}`;
        document.getElementById('sel-subject').textContent = this.selectedCourse.subject;
        document.getElementById('sel-original-teacher').textContent = teacherName;

        // 顯示選中課程資訊區塊
        document.getElementById('selected-course-info').classList.remove('hidden');

        // 計算並顯示推薦代課教師
        this.showRecommendations();

        // 如果是調課模式，更新可互換教師列表
        const changeType = document.getElementById('change-type').value;
        if (changeType === 'swap') {
            this.updateSwapTeacherList();
        }
    }

    /**
     * 顯示推薦代課教師列表
     */
    showRecommendations() {
        const date = document.getElementById('sub-date').value;

        // 使用推薦引擎計算推薦列表
        const recommendations = this.recommendationEngine.getRecommendations(
            this.selectedCourse,
            this.dataManager.getScheduleData(),
            this.dataManager.getTeachers(),
            date
        );

        // 渲染推薦列表
        const list = document.getElementById('recommendation-list');
        list.innerHTML = '';

        if (recommendations.length === 0) {
            list.innerHTML = '<p class="hint">該時段無可用的代課教師</p>';
            return;
        }

        recommendations.forEach((rec, index) => {
            const item = document.createElement('div');
            item.className = 'recommendation-item';
            item.dataset.index = index;

            let badgeClass = 'badge-free';
            let badgeText = '空堂';

            if (rec.reason === 'same_domain') {
                badgeClass = 'badge-same-domain';
                badgeText = '同領域';
            } else if (rec.reason === 'homeroom') {
                badgeClass = 'badge-homeroom';
                badgeText = '班導師';
            }

            item.innerHTML = `
                <div class="recommendation-info">
                    <span class="recommendation-name">${rec.teacher.name}</span>
                    <span class="recommendation-reason">${rec.reasonText}</span>
                </div>
                <span class="recommendation-badge ${badgeClass}">${badgeText}</span>
            `;

            item.addEventListener('click', () => this.onSubstituteSelected(index, recommendations));
            list.appendChild(item);
        });
    }

    /**
     * 當選擇代課教師時觸發
     */
    onSubstituteSelected(index, recommendations) {
        // 移除其他選中狀態
        document.querySelectorAll('.recommendation-item.selected').forEach(i => i.classList.remove('selected'));

        // 選中當前代課教師
        document.querySelectorAll('.recommendation-item')[index].classList.add('selected');

        this.selectedSubstitute = recommendations[index];
    }

    /**
     * 確認調課/代課
     */
    async confirmSubstitute() {
        if (!this.selectedCourse) {
            alert('請選擇要調課的課程');
            return;
        }

        const changeType = document.getElementById('change-type').value;
        const date = document.getElementById('sub-date').value;

        // 根據異動類型進行驗證
        if (changeType === 'substitute') {
            // 代課模式驗證
            if (!this.selectedSubstitute) {
                alert('請選擇代課教師');
                return;
            }

            const leaveType = document.getElementById('leave-type').value;
            if (!leaveType) {
                alert('請選擇假別');
                return;
            }

            // 公假必須填寫字號
            if (leaveType === 'official') {
                const docNumber = document.getElementById('doc-number').value.trim();
                if (!docNumber) {
                    alert('公假必須填寫公假字號');
                    document.getElementById('doc-number').focus();
                    return;
                }
            }

            const reason = document.getElementById('sub-reason').value.trim();
            if (!reason) {
                alert('請輸入事由說明');
                return;
            }

            // 建立代課紀錄
            const record = {
                id: Date.now().toString(),
                type: 'substitute',
                date: date,
                weekday: this.selectedCourse.weekday,
                period: this.selectedCourse.period,
                className: this.selectedCourse.className,
                subject: this.selectedCourse.subject,
                domain: this.selectedCourse.domain,
                originalTeacher: this.selectedCourse.originalTeacher,
                substituteTeacher: this.selectedSubstitute.teacher.name,
                leaveType: leaveType,
                leaveTypeName: this.getLeaveTypeName(leaveType),
                docNumber: leaveType === 'official' ? document.getElementById('doc-number').value.trim() : '',
                reason: reason,
                createdAt: new Date().toISOString()
            };

            // 儲存並處理
            await this.saveAndProcessRecord(record);

        } else {
            // 調課模式驗證
            const swapTeacher = document.getElementById('swap-teacher').value;
            if (!swapTeacher) {
                alert('請選擇互換教師');
                return;
            }

            // 雙重驗證班級相同
            if (!this.selectedSubstitute || !this.selectedSubstitute.swapCourse) {
                alert('調課驗證失敗：請重新選擇互換教師');
                return;
            }

            if (this.selectedSubstitute.swapCourse.className !== this.selectedCourse.className) {
                alert('調課錯誤：兩位教師的班級不相同，無法調課！');
                return;
            }

            // 建立調課紀錄
            const record = {
                id: Date.now().toString(),
                type: 'swap',
                date: date,
                weekday: this.selectedCourse.weekday,
                period: this.selectedCourse.period,
                className: this.selectedCourse.className,
                subject: this.selectedCourse.subject,
                domain: this.selectedCourse.domain,
                originalTeacher: this.selectedCourse.originalTeacher,
                substituteTeacher: this.selectedSubstitute.teacher.name,
                swapSubject: this.selectedSubstitute.swapCourse.subject,
                leaveType: 'swap',
                leaveTypeName: '調課',
                docNumber: '',
                reason: '調課互換',
                createdAt: new Date().toISOString()
            };

            // 儲存並處理
            await this.saveAndProcessRecord(record);
        }
    }

    /**
     * 儲存並處理紀錄
     */
    async saveAndProcessRecord(record) {
        // 儲存紀錄
        this.dataManager.addSubstituteRecord(record);
        this.saveDataToStorage();

        // 嘗試同步到 Google Sheets
        await this.syncRecordToGoogleSheets(record);

        // 生成 PDF
        await this.generateSubstitutePDF(record);

        // 重置選擇狀態
        this.cancelSubstitute();

        const typeText = record.type === 'swap' ? '調課' : '代課';
        alert(`${typeText}紀錄已儲存，PDF 已生成`);
    }

    /**
     * 取得假別名稱
     */
    getLeaveTypeName(leaveType) {
        const leaveTypeNames = {
            'official': '公假',
            'personal': '事假',
            'sick': '病假',
            'rest': '休假',
            'other': '其他',
            'swap': '調課'
        };
        return leaveTypeNames[leaveType] || leaveType;
    }

    /**
     * 取消調課
     */
    cancelSubstitute() {
        this.selectedCourse = null;
        this.selectedSubstitute = null;
        document.getElementById('selected-course-info').classList.add('hidden');
        document.getElementById('sub-reason').value = '';
        document.querySelectorAll('.schedule-course.selected').forEach(c => c.classList.remove('selected'));

        // 重置新增的表單欄位
        document.getElementById('change-type').value = 'substitute';
        document.getElementById('leave-type').value = '';
        document.getElementById('doc-number').value = '';
        document.getElementById('doc-number-group').style.display = 'none';
        document.getElementById('substitute-options').classList.remove('hidden');
        document.getElementById('swap-options').classList.add('hidden');
        document.getElementById('swap-teacher').innerHTML = '<option value="">請先選擇欲調課的課程</option>';
        document.getElementById('swap-validation-error').classList.add('hidden');
        document.querySelectorAll('.recommendation-item.selected').forEach(i => i.classList.remove('selected'));
    }

    /**
     * 生成調代課單 PDF
     */
    async generateSubstitutePDF(record) {
        const scheduleData = this.dataManager.getScheduleData();
        const teachers = this.dataManager.getTeachers();

        await this.pdfGenerator.generateSubstituteForm(record, scheduleData, teachers);
    }

    /**
     * 同步紀錄到 Google Sheets
     */
    async syncRecordToGoogleSheets(record) {
        const url = document.getElementById('gas-url').value;
        if (!url) return;

        try {
            await this.googleSheetsAPI.appendRecord(url, record);
            console.log('紀錄已同步到 Google Sheets');
        } catch (error) {
            console.error('同步到 Google Sheets 失敗:', error);
        }
    }

    /**
     * 綁定紀錄查詢事件
     */
    bindRecordEvents() {
        document.getElementById('search-records-btn').addEventListener('click', () => {
            this.searchRecords();
        });
    }

    /**
     * 查詢調課紀錄
     */
    searchRecords() {
        const startDate = document.getElementById('record-start-date').value;
        const endDate = document.getElementById('record-end-date').value;
        const teacherFilter = document.getElementById('record-teacher').value;

        const records = this.dataManager.getSubstituteRecords(startDate, endDate, teacherFilter);

        this.renderRecordsTable(records);
    }

    /**
     * 渲染紀錄表格
     */
    renderRecordsTable(records) {
        const tbody = document.getElementById('records-tbody');

        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty-message">查無調代課紀錄</td></tr>';
            return;
        }

        tbody.innerHTML = records.map(record => {
            const leaveTypeName = record.leaveTypeName || this.getLeaveTypeName(record.leaveType) || '-';
            return `
                <tr>
                    <td>${record.date}</td>
                    <td>${record.className}</td>
                    <td>${record.weekday} ${record.period}</td>
                    <td>${record.subject}</td>
                    <td>${record.originalTeacher}</td>
                    <td>${record.substituteTeacher}</td>
                    <td>${leaveTypeName}</td>
                    <td>
                        <button class="btn btn-sm btn-more detail-btn" data-id="${record.id}">更多</button>
                        <button class="btn btn-sm btn-primary reprint-btn" data-id="${record.id}">重印</button>
                        <button class="btn btn-sm btn-danger delete-record-btn" data-id="${record.id}">刪除</button>
                    </td>
                </tr>
            `;
        }).join('');

        // 綁定更多/詳細按鈕
        tbody.querySelectorAll('.detail-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.dataset.id;
                const record = records.find(r => r.id === id);
                if (record) {
                    this.showRecordDetail(record);
                }
            });
        });

        // 綁定重印按鈕
        tbody.querySelectorAll('.reprint-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.target.dataset.id;
                const record = records.find(r => r.id === id);
                if (record) {
                    this.generateSubstitutePDF(record);
                }
            });
        });

        // 綁定刪除按鈕
        tbody.querySelectorAll('.delete-record-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (confirm('確定要刪除此筆調代課紀錄嗎？')) {
                    const id = e.target.dataset.id;
                    this.dataManager.removeSubstituteRecord(id);
                    this.saveDataToStorage();
                    this.searchRecords();
                }
            });
        });
    }

    /**
     * 顯示紀錄詳細資料彈窗
     */
    showRecordDetail(record) {
        const modal = document.getElementById('record-detail-modal');
        const content = document.getElementById('record-detail-content');

        const typeText = record.type === 'swap' ? '調課' : '代課';
        const leaveTypeName = record.leaveTypeName || this.getLeaveTypeName(record.leaveType) || '-';

        let detailHtml = `
            <div class="detail-row">
                <span class="detail-label">異動類型</span>
                <span class="detail-value">${typeText}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">日期</span>
                <span class="detail-value">${record.date} ${record.weekday}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">節次</span>
                <span class="detail-value">${record.period}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">班級</span>
                <span class="detail-value">${record.className}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">科目</span>
                <span class="detail-value">${record.subject}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">原任課教師</span>
                <span class="detail-value">${record.originalTeacher}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">代課教師</span>
                <span class="detail-value">${record.substituteTeacher}</span>
            </div>
            <div class="detail-row">
                <span class="detail-label">假別</span>
                <span class="detail-value">${leaveTypeName}</span>
            </div>
        `;

        // 公假顯示字號
        if (record.leaveType === 'official' && record.docNumber) {
            detailHtml += `
                <div class="detail-row">
                    <span class="detail-label">公假字號</span>
                    <span class="detail-value">${record.docNumber}</span>
                </div>
            `;
        }

        // 事由
        if (record.reason) {
            detailHtml += `
                <div class="detail-row">
                    <span class="detail-label">事由</span>
                    <span class="detail-value">${record.reason}</span>
                </div>
            `;
        }

        // 建立時間
        if (record.createdAt) {
            const createdDate = new Date(record.createdAt).toLocaleString('zh-TW');
            detailHtml += `
                <div class="detail-row">
                    <span class="detail-label">建立時間</span>
                    <span class="detail-value">${createdDate}</span>
                </div>
            `;
        }

        content.innerHTML = detailHtml;
        modal.classList.remove('hidden');

        // 綁定關閉按鈕
        document.getElementById('close-modal-btn').onclick = () => {
            modal.classList.add('hidden');
        };

        // 點擊背景關閉
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
            }
        };
    }

    /**
     * 綁定結算相關事件
     */
    bindSettlementEvents() {
        document.getElementById('generate-settlement-btn').addEventListener('click', () => {
            this.generateSettlement();
        });

        document.getElementById('export-settlement-btn').addEventListener('click', () => {
            this.exportSettlementExcel();
        });

        // 僅顯示有變動教師勾選框
        document.getElementById('show-changed-only').addEventListener('change', (e) => {
            this.filterSettlementTable(e.target.checked);
        });
    }

    /**
     * 產生月結算報表
     */
    generateSettlement() {
        const year = document.getElementById('settle-year').value;
        const month = document.getElementById('settle-month').value;

        const settlementData = this.settlementCalculator.calculate(
            year,
            month,
            this.dataManager.getScheduleData(),
            this.dataManager.getSubstituteRecords(),
            this.dataManager.getTeachers()
        );

        // 儲存結算資料供篩選使用
        this.currentSettlementData = settlementData;

        // 重置勾選框
        document.getElementById('show-changed-only').checked = false;

        this.renderSettlementTable(settlementData);
        document.getElementById('settlement-result').classList.remove('hidden');
    }

    /**
     * 渲染結算表格
     */
    renderSettlementTable(settlementData, showChangedOnly = false) {
        const tbody = document.getElementById('settlement-tbody');
        const changedCountSpan = document.getElementById('changed-count');

        // 計算有變動的教師數量
        const changedTeachers = settlementData.filter(row =>
            row.substituteHours > 0 || row.substitutedHours > 0
        );

        // 更新變動數量顯示
        changedCountSpan.textContent = `共 ${changedTeachers.length} 位教師有變動`;

        // 根據篩選條件決定顯示資料
        const displayData = showChangedOnly ? changedTeachers : settlementData;

        if (displayData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-message">本月無教師時數變動</td></tr>';
            return;
        }

        tbody.innerHTML = displayData.map(row => {
            const hasChange = row.substituteHours > 0 || row.substitutedHours > 0;
            const rowClass = hasChange ? 'settlement-row-changed' : '';

            // 代課增加顯示
            const substituteDisplay = row.substituteHours > 0
                ? `<span class="settlement-increase">+${row.substituteHours}</span>`
                : `<span class="settlement-no-change">-</span>`;

            // 被代課減少顯示
            const substitutedDisplay = row.substitutedHours > 0
                ? `<span class="settlement-decrease">-${row.substitutedHours}</span>`
                : `<span class="settlement-no-change">-</span>`;

            return `
                <tr class="${rowClass}" data-has-change="${hasChange}">
                    <td>${row.teacherName}</td>
                    <td>${row.originalHours}</td>
                    <td>${substituteDisplay}</td>
                    <td>${substitutedDisplay}</td>
                    <td><strong>${row.actualHours}</strong></td>
                    <td>${row.overtimeHours > 0 ? row.overtimeHours : '-'}</td>
                </tr>
            `;
        }).join('');
    }

    /**
     * 篩選結算表格（僅顯示有變動的教師）
     */
    filterSettlementTable(showChangedOnly) {
        if (this.currentSettlementData) {
            this.renderSettlementTable(this.currentSettlementData, showChangedOnly);
        }
    }

    /**
     * 匯出結算表 Excel
     */
    exportSettlementExcel() {
        const year = document.getElementById('settle-year').value;
        const month = document.getElementById('settle-month').value;

        const settlementData = this.settlementCalculator.calculate(
            year,
            month,
            this.dataManager.getScheduleData(),
            this.dataManager.getSubstituteRecords(),
            this.dataManager.getTeachers()
        );

        this.settlementCalculator.exportToExcel(settlementData, year, month);
    }

    /**
     * 綁定 Google Sheets 連線事件
     */
    bindGoogleSheetsEvents() {
        document.getElementById('test-connection-btn').addEventListener('click', async () => {
            const url = document.getElementById('gas-url').value;
            if (!url) {
                alert('請輸入 Apps Script Web App URL');
                return;
            }

            const statusDiv = document.getElementById('connection-status');
            statusDiv.classList.remove('hidden');
            statusDiv.innerHTML = '<span class="loading"></span> 測試連線中...';

            try {
                const result = await this.googleSheetsAPI.testConnection(url);
                if (result.success) {
                    statusDiv.innerHTML = '<span style="color: var(--success-color);">✓ 連線成功</span>';
                    // 儲存 URL
                    localStorage.setItem('gasUrl', url);
                } else {
                    statusDiv.innerHTML = `<span style="color: var(--danger-color);">✗ 連線失敗: ${result.error}</span>`;
                }
            } catch (error) {
                statusDiv.innerHTML = `<span style="color: var(--danger-color);">✗ 連線失敗: ${error.message}</span>`;
            }
        });

        // 載入儲存的 URL
        const savedUrl = localStorage.getItem('gasUrl');
        if (savedUrl) {
            document.getElementById('gas-url').value = savedUrl;
        }
    }

    /**
     * 設定預設日期
     */
    setDefaultDates() {
        const today = new Date().toISOString().split('T')[0];

        document.getElementById('sub-date').value = today;
        document.getElementById('record-start-date').value = today.substring(0, 8) + '01';
        document.getElementById('record-end-date').value = today;

        // 設定預設月份
        const currentMonth = new Date().getMonth() + 1;
        document.getElementById('settle-month').value = currentMonth;
    }

    /**
     * 從 localStorage 載入已儲存的資料
     */
    loadSavedData() {
        const savedData = localStorage.getItem('substituteSystemData');
        if (savedData) {
            try {
                const data = JSON.parse(savedData);
                this.dataManager.loadFromStorage(data);

                // 更新 UI
                if (data.scheduleData && data.scheduleData.length > 0) {
                    this.updateScheduleStatus({
                        classes: data.classes || [],
                        teachers: data.teachers || [],
                        scheduleData: data.scheduleData
                    });
                    this.updateTeacherTable();
                    this.populateTeacherDropdowns();

                    // 更新各頁籤顯示狀態
                    this.updateTabContentVisibility();
                }

                console.log('已載入儲存的資料');
            } catch (error) {
                console.error('載入儲存資料失敗:', error);
            }
        }
    }

    /**
     * 儲存資料到 localStorage
     */
    saveDataToStorage() {
        const data = this.dataManager.exportToStorage();
        localStorage.setItem('substituteSystemData', JSON.stringify(data));
    }

    /**
     * 手動儲存資料（按鈕觸發）
     */
    saveDataManually() {
        this.saveDataToStorage();

        const statusDiv = document.getElementById('save-status');
        statusDiv.classList.remove('hidden', 'error');
        statusDiv.classList.add('success');
        statusDiv.textContent = '✓ 資料已儲存至瀏覽器（' + new Date().toLocaleTimeString() + '）';

        // 3 秒後隱藏提示
        setTimeout(() => {
            statusDiv.classList.add('hidden');
        }, 3000);
    }

    /**
     * 更新各頁籤內容顯示狀態
     */
    updateTabContentVisibility() {
        const hasData = this.dataManager.getScheduleData().length > 0;

        // 調代課申請頁籤
        const substituteNoData = document.getElementById('substitute-no-data');
        const substituteContent = document.getElementById('substitute-content');
        if (substituteNoData && substituteContent) {
            if (hasData) {
                substituteNoData.classList.add('hidden');
                substituteContent.classList.remove('hidden');
            } else {
                substituteNoData.classList.remove('hidden');
                substituteContent.classList.add('hidden');
            }
        }

        // 調課紀錄頁籤
        const recordsNoData = document.getElementById('records-no-data');
        const recordsContent = document.getElementById('records-content');
        if (recordsNoData && recordsContent) {
            if (hasData) {
                recordsNoData.classList.add('hidden');
                recordsContent.classList.remove('hidden');
            } else {
                recordsNoData.classList.remove('hidden');
                recordsContent.classList.add('hidden');
            }
        }

        // 月結算頁籤
        const settlementNoData = document.getElementById('settlement-no-data');
        const settlementContent = document.getElementById('settlement-content');
        if (settlementNoData && settlementContent) {
            if (hasData) {
                settlementNoData.classList.add('hidden');
                settlementContent.classList.remove('hidden');
            } else {
                settlementNoData.classList.remove('hidden');
                settlementContent.classList.add('hidden');
            }
        }
    }

    /**
     * 顯示錯誤訊息
     */
    showError(message) {
        const statusBox = document.getElementById('schedule-status');
        statusBox.classList.remove('hidden');
        statusBox.classList.add('error');
        statusBox.innerHTML = `
            <div class="status-header">
                <span class="status-icon">✗</span>
                <span class="status-text">錯誤</span>
            </div>
            <div class="status-details">
                <p>${message}</p>
            </div>
        `;
    }
}

// 啟動應用程式
document.addEventListener('DOMContentLoaded', () => {
    window.app = new SubstituteTeacherApp();
});
