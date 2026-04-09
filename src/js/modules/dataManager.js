/**
 * 資料管理模組
 *
 * 負責管理系統內的所有資料，包括：
 * - 課表資料
 * - 教師資料
 * - 班級資料
 * - 調代課紀錄
 * - 雲端同步
 */

import {
    uploadToCloud,
    downloadFromCloud,
    enableRealtimeSync,
    disableRealtimeSync,
    checkInitialSync,
    mergeData
} from './cloudSyncService.js';
import { isSignedIn } from './authService.js';

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

        // 最後修改時間
        this.lastModified = null;

        // 資料版本（用於同步衝突檢測）
        this.version = 0;

        // 即時同步取消函數
        this.unsubscribeRealtimeSync = null;

        // 資料變更回調
        this.onDataChangeCallbacks = [];
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
     * 新增單一課表項目
     * @param {Object} entry - 課表項目 { weekday, period, className, teacher, domain, subject, rawSubject, courseName, category }
     */
    addScheduleEntry(entry) {
        // 確保必要欄位存在
        const newEntry = {
            weekday: entry.weekday || '',
            period: entry.period || '',
            className: entry.className || '',
            teacher: entry.teacher || '',
            domain: entry.domain || '',
            subject: entry.subject || '',
            rawSubject: entry.rawSubject || entry.subject || '',
            courseName: entry.courseName || entry.subject || '',
            category: entry.category || '領域學習'
        };
        this.scheduleData.push(newEntry);
    }

    /**
     * 更新單一課表項目
     * @param {string} teacher - 教師姓名
     * @param {string} weekday - 星期
     * @param {string} period - 節次
     * @param {Object} updates - 要更新的欄位
     */
    updateScheduleEntry(teacher, weekday, period, updates) {
        const index = this.scheduleData.findIndex(c =>
            c.teacher === teacher && c.weekday === weekday && c.period === period
        );
        if (index !== -1) {
            Object.assign(this.scheduleData[index], updates);
        }
    }

    /**
     * 移除單一課表項目
     * @param {string} teacher - 教師姓名
     * @param {string} weekday - 星期
     * @param {string} period - 節次
     */
    removeScheduleEntry(teacher, weekday, period) {
        const index = this.scheduleData.findIndex(c =>
            c.teacher === teacher && c.weekday === weekday && c.period === period
        );
        if (index !== -1) {
            this.scheduleData.splice(index, 1);
        }
    }

    /**
     * 更新班級清單（從現有課表資料重新計算）
     */
    refreshClasses() {
        const classSet = new Set();
        this.scheduleData.forEach(entry => {
            if (entry.className) classSet.add(entry.className);
        });
        this.classes = [...classSet].sort();
    }

    /**
     * 更新教師領域資訊（從現有課表資料重新計算）
     * @param {string} teacherName - 教師姓名
     */
    refreshTeacherDomains(teacherName) {
        const teacher = this.getTeacherByName(teacherName);
        if (!teacher) return;

        const domains = new Set();
        this.scheduleData
            .filter(c => c.teacher === teacherName)
            .forEach(c => {
                if (c.domain) domains.add(c.domain);
            });
        teacher.domains = [...domains];
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

        console.log('查詢調代課紀錄:', {
            總紀錄數: this.substituteRecords.length,
            startDate,
            endDate,
            teacherFilter
        });

        if (startDate) {
            // 確保日期格式一致（YYYY-MM-DD）
            const normalizedStart = this.normalizeDate(startDate);
            records = records.filter(r => {
                const recordDate = this.normalizeDate(r.date);
                return recordDate >= normalizedStart;
            });
        }

        if (endDate) {
            // 確保日期格式一致（YYYY-MM-DD）
            const normalizedEnd = this.normalizeDate(endDate);
            records = records.filter(r => {
                const recordDate = this.normalizeDate(r.date);
                return recordDate <= normalizedEnd;
            });
        }

        if (teacherFilter) {
            records = records.filter(r =>
                r.originalTeacher === teacherFilter ||
                r.substituteTeacher === teacherFilter
            );
        }

        console.log('篩選後紀錄數:', records.length);

        // 按日期排序
        records.sort((a, b) => new Date(b.date) - new Date(a.date));

        return records;
    }

    /**
     * 標準化日期格式為 YYYY-MM-DD
     * @param {string} dateStr - 日期字串
     * @returns {string} 標準化後的日期
     */
    normalizeDate(dateStr) {
        if (!dateStr) return '';
        // 處理可能的各種日期格式
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return dateStr;
        return date.toISOString().split('T')[0];
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
     * 檢查該課堂是否已有調代課紀錄（衝堂檢查）
     * @param {string} date - 日期
     * @param {string} period - 節次
     * @param {string} className - 班級
     * @param {string} originalTeacher - 原任課教師
     * @returns {Object|null} 若有衝堂則回傳該紀錄，否則回傳 null
     */
    checkExistingRecord(date, period, className, originalTeacher) {
        return this.substituteRecords.find(record =>
            record.date === date &&
            record.period === period &&
            record.className === className &&
            record.originalTeacher === originalTeacher
        ) || null;
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
        this.lastModified = null;
        this.version = 0;
    }

    /**
     * 更新最後修改時間
     */
    updateLastModified() {
        this.lastModified = new Date().toISOString();
    }

    /**
     * 匯出資料供雲端同步
     * @returns {Object} 可同步的資料物件
     */
    exportForSync() {
        return {
            schoolName: this.schoolName,
            scheduleData: this.scheduleData,
            teachers: this.teachers,
            classes: this.classes,
            substituteRecords: this.substituteRecords,
            lastModified: this.lastModified || new Date().toISOString(),
            version: this.version
        };
    }

    /**
     * 從雲端資料載入
     * @param {Object} data - 雲端資料物件
     */
    loadFromCloud(data) {
        if (!data) return;

        if (data.schoolName !== undefined) this.schoolName = data.schoolName;
        if (data.scheduleData) this.scheduleData = data.scheduleData;
        if (data.teachers) this.teachers = data.teachers;
        if (data.classes) this.classes = data.classes;
        if (data.substituteRecords) this.substituteRecords = data.substituteRecords;
        if (data.lastModified) this.lastModified = data.lastModified;
        if (data.version !== undefined) this.version = data.version;

        // 通知所有監聽者
        this.notifyDataChange();
    }

    /**
     * 同步到雲端
     * @returns {Promise<boolean>}
     */
    async syncToCloud() {
        if (!isSignedIn()) {
            console.log('未登入，無法同步到雲端');
            return false;
        }

        this.updateLastModified();
        this.version++;

        const data = this.exportForSync();
        const success = await uploadToCloud(data);

        return success;
    }

    /**
     * 從雲端載入資料
     * @returns {Promise<Object|null>}
     */
    async loadFromCloudStorage() {
        if (!isSignedIn()) {
            console.log('未登入，無法從雲端載入');
            return null;
        }

        const data = await downloadFromCloud();
        return data;
    }

    /**
     * 啟用即時同步
     * @returns {Function} 取消監聽函數
     */
    enableRealtimeSync() {
        if (!isSignedIn()) {
            console.log('未登入，無法啟用即時同步');
            return () => {};
        }

        // 停用之前的同步
        this.disableRealtimeSync();

        // 啟用新的即時同步
        this.unsubscribeRealtimeSync = enableRealtimeSync((data) => {
            console.log('收到雲端資料更新');
            this.loadFromCloud(data);
        });

        return this.unsubscribeRealtimeSync;
    }

    /**
     * 停用即時同步
     */
    disableRealtimeSync() {
        if (this.unsubscribeRealtimeSync) {
            this.unsubscribeRealtimeSync();
            this.unsubscribeRealtimeSync = null;
        }
        disableRealtimeSync();
    }

    /**
     * 檢查初始同步狀態
     * @returns {Promise<Object>} { action, localData, cloudData }
     */
    async checkInitialSyncStatus() {
        const localData = this.exportForSync();
        return await checkInitialSync(localData);
    }

    /**
     * 執行資料合併
     * @param {Object} cloudData - 雲端資料
     * @returns {Object} 合併後的資料
     */
    mergeWithCloudData(cloudData) {
        const localData = this.exportForSync();
        const mergedData = mergeData(localData, cloudData);

        // 載入合併後的資料
        this.loadFromCloud(mergedData);

        return mergedData;
    }

    /**
     * 註冊資料變更回調
     * @param {Function} callback - 回調函數
     * @returns {Function} 取消註冊函數
     */
    onDataChange(callback) {
        this.onDataChangeCallbacks.push(callback);
        return () => {
            const index = this.onDataChangeCallbacks.indexOf(callback);
            if (index > -1) {
                this.onDataChangeCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * 通知資料變更
     */
    notifyDataChange() {
        this.onDataChangeCallbacks.forEach(callback => {
            try {
                callback(this.exportForSync());
            } catch (error) {
                console.error('資料變更回調執行錯誤:', error);
            }
        });
    }

    /**
     * 取得資料摘要（用於同步衝突顯示）
     * @returns {Object}
     */
    getDataSummary() {
        return {
            recordCount: this.substituteRecords.length,
            teacherCount: this.teachers.length,
            classCount: this.classes.length,
            lastModified: this.lastModified
        };
    }
}
