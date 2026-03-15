/**
 * 資料管理模組
 *
 * 負責管理系統內的所有資料，包括：
 * - 課表資料
 * - 教師資料
 * - 班級資料
 * - 調代課紀錄
 */

export class DataManager {
    constructor() {
        // 學校名稱
        this.schoolName = '';

        // 課表資料：每筆為一堂課
        this.scheduleData = [];

        // 教師資料：包含姓名、領域、導師班級
        this.teachers = [];

        // 班級清單
        this.classes = [];

        // 調代課紀錄
        this.substituteRecords = [];
    }

    /**
     * 設定學校名稱
     * @param {string} name - 學校名稱
     */
    setSchoolName(name) {
        this.schoolName = name;
    }

    /**
     * 取得學校名稱
     * @returns {string} 學校名稱
     */
    getSchoolName() {
        return this.schoolName;
    }

    /**
     * 設定課表資料
     * @param {Array} data - 課表資料陣列
     */
    setScheduleData(data) {
        this.scheduleData = data;
    }

    /**
     * 取得課表資料
     * @returns {Array} 課表資料陣列
     */
    getScheduleData() {
        return this.scheduleData;
    }

    /**
     * 設定教師資料
     * @param {Array} teachers - 教師資料陣列
     */
    setTeachers(teachers) {
        this.teachers = teachers;
    }

    /**
     * 取得教師資料
     * @returns {Array} 教師資料陣列
     */
    getTeachers() {
        return this.teachers;
    }

    /**
     * 更新單一教師資料
     * @param {number} index - 教師索引
     * @param {string} field - 欄位名稱
     * @param {any} value - 新值
     */
    updateTeacher(index, field, value) {
        if (this.teachers[index]) {
            this.teachers[index][field] = value;
        }
    }

    /**
     * 新增教師
     * @param {Object} teacher - 教師資料
     */
    addTeacher(teacher) {
        this.teachers.push(teacher);
    }

    /**
     * 移除教師
     * @param {number} index - 教師索引
     */
    removeTeacher(index) {
        this.teachers.splice(index, 1);
    }

    /**
     * 根據姓名取得教師資料
     * @param {string} name - 教師姓名
     * @returns {Object|null} 教師資料
     */
    getTeacherByName(name) {
        return this.teachers.find(t => t.name === name) || null;
    }

    /**
     * 設定班級清單
     * @param {Array} classes - 班級清單
     */
    setClasses(classes) {
        this.classes = classes;
    }

    /**
     * 取得班級清單
     * @returns {Array} 班級清單
     */
    getClasses() {
        return this.classes;
    }

    /**
     * 取得指定教師的週課表
     * @param {string} teacherName - 教師姓名
     * @returns {Array} 該教師的所有課程
     */
    getTeacherWeekSchedule(teacherName) {
        return this.scheduleData.filter(course => course.teacher === teacherName);
    }

    /**
     * 取得指定班級的週課表
     * @param {string} className - 班級名稱
     * @returns {Array} 該班級的所有課程
     */
    getClassWeekSchedule(className) {
        return this.scheduleData.filter(course => course.className === className);
    }

    /**
     * 取得指定時段有課的教師清單
     * @param {string} weekday - 星期（如：週一）
     * @param {string} period - 節次（如：第一節）
     * @returns {Array} 有課的教師姓名清單
     */
    getBusyTeachers(weekday, period) {
        return this.scheduleData
            .filter(course => course.weekday === weekday && course.period === period)
            .map(course => course.teacher);
    }

    /**
     * 取得指定時段空堂的教師清單
     * @param {string} weekday - 星期
     * @param {string} period - 節次
     * @returns {Array} 空堂教師資料清單
     */
    getFreeTeachers(weekday, period) {
        const busyTeachers = this.getBusyTeachers(weekday, period);
        return this.teachers.filter(teacher => !busyTeachers.includes(teacher.name));
    }

    /**
     * 新增調代課紀錄
     * @param {Object} record - 調代課紀錄
     */
    addSubstituteRecord(record) {
        this.substituteRecords.push(record);
    }

    /**
     * 移除調代課紀錄
     * @param {string} id - 紀錄 ID
     */
    removeSubstituteRecord(id) {
        const index = this.substituteRecords.findIndex(r => r.id === id);
        if (index !== -1) {
            this.substituteRecords.splice(index, 1);
        }
    }

    /**
     * 取得調代課紀錄
     * @param {string} startDate - 起始日期（可選）
     * @param {string} endDate - 結束日期（可選）
     * @param {string} teacherFilter - 教師篩選（可選）
     * @returns {Array} 符合條件的紀錄
     */
    getSubstituteRecords(startDate = '', endDate = '', teacherFilter = '') {
        let records = [...this.substituteRecords];

        if (startDate) {
            records = records.filter(r => r.date >= startDate);
        }

        if (endDate) {
            records = records.filter(r => r.date <= endDate);
        }

        if (teacherFilter) {
            records = records.filter(r =>
                r.originalTeacher === teacherFilter ||
                r.substituteTeacher === teacherFilter
            );
        }

        // 按日期排序
        records.sort((a, b) => new Date(b.date) - new Date(a.date));

        return records;
    }

    /**
     * 取得指定月份的調代課紀錄
     * @param {number} year - 年份
     * @param {number} month - 月份（1-12）
     * @returns {Array} 該月份的紀錄
     */
    getMonthlyRecords(year, month) {
        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = `${year}-${String(month).padStart(2, '0')}-31`;
        return this.getSubstituteRecords(startDate, endDate);
    }

    /**
     * 計算教師每週基本授課時數
     * @param {string} teacherName - 教師姓名
     * @returns {number} 每週授課節數
     */
    getTeacherWeeklyHours(teacherName) {
        return this.scheduleData.filter(course => course.teacher === teacherName).length;
    }

    /**
     * 從 localStorage 載入資料
     * @param {Object} data - 儲存的資料物件
     */
    loadFromStorage(data) {
        if (data.schoolName) this.schoolName = data.schoolName;
        if (data.scheduleData) this.scheduleData = data.scheduleData;
        if (data.teachers) this.teachers = data.teachers;
        if (data.classes) this.classes = data.classes;
        if (data.substituteRecords) this.substituteRecords = data.substituteRecords;
    }

    /**
     * 匯出資料供 localStorage 儲存
     * @returns {Object} 可儲存的資料物件
     */
    exportToStorage() {
        return {
            schoolName: this.schoolName,
            scheduleData: this.scheduleData,
            teachers: this.teachers,
            classes: this.classes,
            substituteRecords: this.substituteRecords
        };
    }

    /**
     * 清除所有資料
     */
    clearAll() {
        this.schoolName = '';
        this.scheduleData = [];
        this.teachers = [];
        this.classes = [];
        this.substituteRecords = [];
    }
}
