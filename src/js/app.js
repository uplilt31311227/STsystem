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
import { SettlementCalculator } from './modules/settlementCalculator.js';

// 匯入 Firebase 相關模組
import {
    initializeFirebase,
    isFirebaseInitialized
} from './modules/firebaseConfig.js';
import {
    initAuthService,
    signInWithGoogle,
    signOutUser,
    onAuthStateChange,
    isSignedIn,
    getUserInfo
} from './modules/authService.js';
import {
    onSyncStatusChange,
    formatSyncStatus,
    SyncStatus
} from './modules/cloudSyncService.js';

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
        this.settlementCalculator = new SettlementCalculator();

        // 目前選中的課程資訊
        this.selectedCourse = null;
        this.selectedSubstitute = null;

        // 多節課模式相關
        this.isMultiCourseMode = false;
        this.selectedCourses = [];  // 多選課程陣列

        // 課表編輯器相關
        this.editorCurrentTeacher = null;  // 目前編輯的教師
        this.editorEditingCell = null;     // 目前編輯的時段 { weekday, period }
        this.editorIsEditMode = false;     // 是否為編輯模式（vs 新增）

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

        // 綁定資料管理事件
        this.bindDataManagementEvents();

        // 綁定課表編輯器事件
        this.bindScheduleEditorEvents();

        // 綁定 Firebase 認證相關事件
        this.bindFirebaseAuthEvents();

        // 設定預設日期
        this.setDefaultDates();

        // 從 localStorage 載入已儲存的資料
        this.loadSavedData();

        // 初始化 Firebase（如果已設定）
        this.initFirebase();

        console.log('國中調代課自動化系統已初始化');
    }

    /**
     * 初始化 Firebase
     */
    async initFirebase() {
        try {
            // 初始化 Firebase（使用內建設定）
            await initializeFirebase();

            // 初始化認證服務
            await initAuthService();

            // 監聽認證狀態變更
            onAuthStateChange((user) => {
                this.onAuthStateChanged(user);
            });

            // 監聯同步狀態變更
            onSyncStatusChange((status) => {
                this.updateSyncStatusUI(status);
            });

            console.log('Firebase 初始化完成');
        } catch (error) {
            console.error('Firebase 初始化失敗:', error);
        }
    }

    /**
     * 綁定 Firebase 認證相關事件
     */
    bindFirebaseAuthEvents() {
        // Google 登入按鈕
        const googleSigninBtn = document.getElementById('google-signin-btn');
        googleSigninBtn?.addEventListener('click', () => this.handleGoogleSignIn());

        // 登出按鈕
        const signoutBtn = document.getElementById('signout-btn');
        signoutBtn?.addEventListener('click', () => this.handleSignOut());

        // 同步衝突對話框相關
        const conflictOptions = document.querySelectorAll('.conflict-option');
        conflictOptions.forEach(option => {
            option.addEventListener('click', () => this.selectConflictOption(option.id));
        });

        const confirmSyncChoiceBtn = document.getElementById('confirm-sync-choice-btn');
        confirmSyncChoiceBtn?.addEventListener('click', () => this.confirmSyncChoice());

        const cancelSyncBtn = document.getElementById('cancel-sync-btn');
        cancelSyncBtn?.addEventListener('click', () => this.hideSyncConflictModal());

        const exportBeforeSyncBtn = document.getElementById('export-before-sync-btn');
        exportBeforeSyncBtn?.addEventListener('click', () => this.exportLocalData());

        // 點擊 modal 外部關閉
        const syncConflictModal = document.getElementById('sync-conflict-modal');
        syncConflictModal?.addEventListener('click', (e) => {
            if (e.target === syncConflictModal) this.hideSyncConflictModal();
        });

        // 合併確認對話框事件
        const mergeDataBtn = document.getElementById('merge-data-btn');
        mergeDataBtn?.addEventListener('click', () => this.handleMergeChoice('merge'));

        const useCloudDataBtn = document.getElementById('use-cloud-data-btn');
        useCloudDataBtn?.addEventListener('click', () => this.handleMergeChoice('cloud'));

        // 點擊 modal 外部不關閉（強制選擇）
        const mergeConfirmModal = document.getElementById('merge-confirm-modal');
        mergeConfirmModal?.addEventListener('click', (e) => {
            // 不允許點擊外部關閉，必須選擇一個選項
            e.stopPropagation();
        });
    }

    /**
     * 更新雲端同步狀態區塊
     */
    updateSyncStatusSection(isLoggedIn) {
        const loggedOut = document.getElementById('sync-logged-out');
        const loggedIn = document.getElementById('sync-logged-in');

        if (isLoggedIn) {
            loggedOut?.classList.add('hidden');
            loggedIn?.classList.remove('hidden');
        } else {
            loggedOut?.classList.remove('hidden');
            loggedIn?.classList.add('hidden');
        }
    }

    /**
     * 處理 Google 登入
     */
    async handleGoogleSignIn() {
        try {
            const user = await signInWithGoogle();
            console.log('登入成功:', user);
        } catch (error) {
            console.error('登入失敗:', error);
            alert('登入失敗：' + error.message);
        }
    }

    /**
     * 處理登出
     */
    async handleSignOut() {
        try {
            // 停用即時同步
            this.dataManager.disableRealtimeSync();

            await signOutUser();
            console.log('已登出');
        } catch (error) {
            console.error('登出失敗:', error);
        }
    }

    /**
     * 認證狀態變更處理
     */
    async onAuthStateChanged(user) {
        const loggedOut = document.getElementById('auth-logged-out');
        const loggedIn = document.getElementById('auth-logged-in');

        if (user) {
            // 已登入
            loggedOut?.classList.add('hidden');
            loggedIn?.classList.remove('hidden');

            // 更新使用者資訊
            const userInfo = getUserInfo();
            const avatarImg = document.getElementById('user-avatar');
            const userName = document.getElementById('user-name');

            if (avatarImg && userInfo?.photoURL) {
                avatarImg.src = userInfo.photoURL;
            }
            if (userName && userInfo?.displayName) {
                userName.textContent = userInfo.displayName;
            }

            // 更新設定頁籤的雲端同步狀態
            this.updateSyncStatusSection(true);

            // 檢查同步狀態
            await this.checkAndHandleSync();
        } else {
            // 已登出
            loggedOut?.classList.remove('hidden');
            loggedIn?.classList.add('hidden');

            // 更新設定頁籤的雲端同步狀態
            this.updateSyncStatusSection(false);

            // 停用即時同步
            this.dataManager.disableRealtimeSync();
        }
    }

    /**
     * 更新同步狀態 UI
     */
    updateSyncStatusUI(status) {
        const syncStatusElement = document.getElementById('sync-status');
        if (!syncStatusElement) return;

        const formatted = formatSyncStatus(status);

        syncStatusElement.className = 'sync-status ' + status;
        syncStatusElement.querySelector('.sync-icon').textContent = formatted.icon;
        syncStatusElement.querySelector('.sync-text').textContent = formatted.text;
    }

    /**
     * 檢查並處理同步
     */
    async checkAndHandleSync() {
        if (!isSignedIn()) return;

        try {
            const syncStatus = await this.dataManager.checkInitialSyncStatus();
            const localData = syncStatus.localData;
            const cloudData = syncStatus.cloudData;

            // 取得本地和雲端的學校名稱
            const localSchoolName = localData?.schoolName || '';
            const cloudSchoolName = cloudData?.schoolName || '';

            // 檢查本地是否有課表資料
            const hasLocalSchedule = (localData?.scheduleData?.length || 0) > 0;
            const hasCloudSchedule = (cloudData?.scheduleData?.length || 0) > 0;

            // 如果雲端沒有資料，直接上傳本地資料
            if (!cloudData || !hasCloudSchedule) {
                if (hasLocalSchedule) {
                    await this.dataManager.syncToCloud();
                }
                this.enableRealtimeSyncAndListen();
                return;
            }

            // 如果本地沒有資料，直接下載雲端資料
            if (!hasLocalSchedule) {
                this.dataManager.loadFromCloud(cloudData);
                this.refreshUIAfterSync();
                this.saveDataToStorage();
                this.enableRealtimeSyncAndListen();
                return;
            }

            // 兩邊都有資料，比較學校名稱
            if (localSchoolName && cloudSchoolName && localSchoolName !== cloudSchoolName) {
                // 學校名稱不同：清除本地資料，載入雲端資料
                this.showSchoolMismatchNotification(localSchoolName, cloudSchoolName);
                this.dataManager.clearAll();
                this.dataManager.loadFromCloud(cloudData);
                this.refreshUIAfterSync();
                this.saveDataToStorage();
            } else if (localSchoolName === cloudSchoolName || !localSchoolName || !cloudSchoolName) {
                // 學校名稱相同（或其中一方沒有學校名稱）：詢問是否合併
                this.showMergeConfirmModal(localData, cloudData);
                return; // 等待用戶選擇後再啟用即時同步
            }

            this.enableRealtimeSyncAndListen();

        } catch (error) {
            console.error('同步檢查失敗:', error);
        }
    }

    /**
     * 啟用即時同步並監聽變更
     */
    enableRealtimeSyncAndListen() {
        // 啟用即時同步
        this.dataManager.enableRealtimeSync();

        // 監聽資料變更，自動同步
        this.dataManager.onDataChange(async () => {
            if (isSignedIn()) {
                await this.dataManager.syncToCloud();
            }
        });
    }

    /**
     * 顯示學校不同的通知
     */
    showSchoolMismatchNotification(localSchool, cloudSchool) {
        alert(`偵測到不同學校的資料：\n\n本機：${localSchool}\n雲端：${cloudSchool}\n\n已自動載入雲端資料（${cloudSchool}）。`);
    }

    /**
     * 顯示合併確認對話框（學校相同時）
     */
    showMergeConfirmModal(localData, cloudData) {
        const modal = document.getElementById('merge-confirm-modal');
        if (!modal) {
            // 如果沒有對話框，使用 confirm
            const localRecords = localData?.substituteRecords?.length || 0;
            const cloudRecords = cloudData?.substituteRecords?.length || 0;
            const schoolName = localData?.schoolName || cloudData?.schoolName || '未設定';

            const shouldMerge = confirm(
                `偵測到本機和雲端都有「${schoolName}」的資料：\n\n` +
                `本機：${localRecords} 筆調代課紀錄\n` +
                `雲端：${cloudRecords} 筆調代課紀錄\n\n` +
                `是否要合併資料？\n\n` +
                `【確定】合併兩邊資料\n` +
                `【取消】使用雲端資料（清除本機）`
            );

            if (shouldMerge) {
                // 合併資料
                this.dataManager.mergeWithCloudData(cloudData);
                this.refreshUIAfterSync();
                this.saveDataToStorage();
                this.dataManager.syncToCloud();
            } else {
                // 使用雲端資料
                this.dataManager.clearAll();
                this.dataManager.loadFromCloud(cloudData);
                this.refreshUIAfterSync();
                this.saveDataToStorage();
            }

            this.enableRealtimeSyncAndListen();
            return;
        }

        // 更新對話框內容
        const schoolName = localData?.schoolName || cloudData?.schoolName || '未設定';
        document.getElementById('merge-school-name').textContent = schoolName;
        document.getElementById('merge-local-record-count').textContent =
            localData?.substituteRecords?.length || 0;
        document.getElementById('merge-cloud-record-count').textContent =
            cloudData?.substituteRecords?.length || 0;

        // 儲存資料供後續使用
        this.pendingMergeData = { localData, cloudData };

        modal.classList.remove('hidden');
    }

    /**
     * 處理合併選擇
     */
    handleMergeChoice(choice) {
        const modal = document.getElementById('merge-confirm-modal');
        const { localData, cloudData } = this.pendingMergeData || {};

        if (choice === 'merge') {
            // 合併資料
            this.dataManager.mergeWithCloudData(cloudData);
            this.refreshUIAfterSync();
            this.saveDataToStorage();
            this.dataManager.syncToCloud();
        } else if (choice === 'cloud') {
            // 使用雲端資料
            this.dataManager.clearAll();
            this.dataManager.loadFromCloud(cloudData);
            this.refreshUIAfterSync();
            this.saveDataToStorage();
        }

        modal?.classList.add('hidden');
        this.pendingMergeData = null;
        this.enableRealtimeSyncAndListen();
    }

    /**
     * 顯示同步衝突對話框
     */
    showSyncConflictModal(localData, cloudData) {
        const modal = document.getElementById('sync-conflict-modal');

        // 更新本機資料摘要
        document.getElementById('local-record-count').textContent =
            localData?.substituteRecords?.length || 0;
        document.getElementById('local-last-modified').textContent =
            localData?.lastModified ? new Date(localData.lastModified).toLocaleString('zh-TW') : '-';

        // 更新雲端資料摘要
        document.getElementById('cloud-record-count').textContent =
            cloudData?.substituteRecords?.length || 0;
        document.getElementById('cloud-last-modified').textContent =
            cloudData?.lastModified ? new Date(cloudData.lastModified).toLocaleString('zh-TW') : '-';

        // 儲存資料供後續使用
        this.pendingSyncData = { localData, cloudData };

        // 重置選擇狀態
        document.querySelectorAll('.conflict-option').forEach(opt => {
            opt.classList.remove('selected');
        });
        document.getElementById('confirm-sync-choice-btn').disabled = true;

        modal?.classList.remove('hidden');
    }

    /**
     * 隱藏同步衝突對話框
     */
    hideSyncConflictModal() {
        const modal = document.getElementById('sync-conflict-modal');
        modal?.classList.add('hidden');
        this.pendingSyncData = null;
        this.selectedConflictOption = null;
    }

    /**
     * 選擇衝突解決選項
     */
    selectConflictOption(optionId) {
        // 移除其他選項的選取狀態
        document.querySelectorAll('.conflict-option').forEach(opt => {
            opt.classList.remove('selected');
        });

        // 選取當前選項
        const option = document.getElementById(optionId);
        option?.classList.add('selected');

        this.selectedConflictOption = optionId;

        // 啟用確認按鈕
        document.getElementById('confirm-sync-choice-btn').disabled = false;
    }

    /**
     * 確認同步選擇
     */
    async confirmSyncChoice() {
        if (!this.selectedConflictOption || !this.pendingSyncData) return;

        const { localData, cloudData } = this.pendingSyncData;

        switch (this.selectedConflictOption) {
            case 'conflict-local':
                // 使用本機資料，上傳到雲端
                await this.dataManager.syncToCloud();
                break;

            case 'conflict-cloud':
                // 使用雲端資料
                this.dataManager.loadFromCloud(cloudData);
                this.refreshUIAfterSync();
                this.saveDataToStorage();
                break;

            case 'conflict-merge':
                // 智慧合併
                const mergedData = this.dataManager.mergeWithCloudData(cloudData);
                await this.dataManager.syncToCloud();
                this.refreshUIAfterSync();
                this.saveDataToStorage();
                break;
        }

        // 啟用即時同步
        this.dataManager.enableRealtimeSync();

        // 關閉對話框
        this.hideSyncConflictModal();
    }

    /**
     * 同步後刷新 UI
     */
    refreshUIAfterSync() {
        // 更新教師表格
        this.updateTeacherTable();

        // 更新教師下拉選單
        this.populateTeacherDropdowns();

        // 更新調課紀錄
        this.searchRecords();

        // 更新學校名稱顯示
        const schoolName = this.dataManager.getSchoolName();
        if (schoolName) {
            const schoolNameInput = document.getElementById('school-name');
            if (schoolNameInput) schoolNameInput.value = schoolName;
            this.showSchoolNameConfirmed();
            this.pdfGenerator.setSchoolName(schoolName);
        }

        // 更新頁籤狀態
        this.updateTabLockStatus();
        this.updateTabContentVisibility();

        // 更新課表狀態
        const scheduleData = this.dataManager.getScheduleData();
        if (scheduleData.length > 0) {
            const statusBox = document.getElementById('schedule-status');
            statusBox?.classList.remove('hidden');

            const parseResult = {
                teachers: this.dataManager.getTeachers(),
                classes: this.dataManager.getClasses(),
                scheduleData: scheduleData
            };
            this.updateScheduleStatus(parseResult);
        }
    }

    /**
     * 綁定頁籤切換事件
     */
    bindTabEvents() {
        const tabButtons = document.querySelectorAll('.tab-btn');
        const tabContents = document.querySelectorAll('.tab-content');

        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.dataset.tab;

                // 檢查是否可以切換到該頁籤
                if (!this.canSwitchToTab(targetTab)) {
                    return;
                }

                // 移除所有 active 狀態，添加 hidden
                tabButtons.forEach(b => b.classList.remove('active'));
                tabContents.forEach(c => {
                    c.classList.remove('active');
                    c.classList.add('hidden');
                });

                // 設定當前頁籤為 active，移除 hidden
                btn.classList.add('active');
                const tabId = targetTab + '-tab';
                const tabContent = document.getElementById(tabId);
                tabContent.classList.add('active');
                tabContent.classList.remove('hidden');

                // 切換到調課紀錄頁籤時，自動載入本月資料
                if (targetTab === 'records') {
                    this.loadCurrentMonthRecords();
                }

                // 切換到課表編輯頁籤時，更新教師選單
                if (targetTab === 'schedule-editor') {
                    this.populateEditorTeacherDropdown();
                }
            });
        });
    }

    /**
     * 載入本月調課紀錄
     */
    loadCurrentMonthRecords() {
        // 設定日期為本月第一天到最後一天
        const today = new Date();
        const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

        const formatDate = (date) => date.toISOString().split('T')[0];

        const startDateValue = formatDate(firstDayOfMonth);
        const endDateValue = formatDate(lastDayOfMonth);

        console.log('載入本月紀錄:', { startDate: startDateValue, endDate: endDateValue });

        document.getElementById('record-start-date').value = startDateValue;
        document.getElementById('record-end-date').value = endDateValue;
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

        // 學校名稱確認按鈕
        document.getElementById('save-school-name-btn')?.addEventListener('click', () => {
            this.saveSchoolName();
        });

        // 學校名稱輸入框 Enter 鍵
        document.getElementById('school-name')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.saveSchoolName();
            }
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

                // 從檔名擷取學校名稱並顯示設定區塊
                this.showSchoolNameSetting(file.name);

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
     * 從檔名擷取學校名稱
     * @param {string} fileName - 檔案名稱
     * @returns {string} 學校名稱
     */
    extractSchoolNameFromFileName(fileName) {
        // 移除副檔名
        const nameWithoutExt = fileName.replace(/\.(xls|xlsx|csv)$/i, '');

        // 常見的檔名格式：
        // 1. "114學年度-縣立測試國中-課表-20260311161643"
        // 2. "XX國中_課表" 或 "XX國中-課表"
        // 3. "XX國民中學_課表"
        // 4. "課表_XX國中"

        // 學校關鍵字（優先順序：完整名稱 > 簡稱）
        const schoolKeywords = ['國民中學', '國民小學', '國中', '國小', '中學', '高中', '高職'];

        // 用常見分隔符號分割
        const parts = nameWithoutExt.split(/[-_\s]+/);

        // 遍歷每個部分，找出包含學校關鍵字的部分
        for (const part of parts) {
            for (const keyword of schoolKeywords) {
                if (part.includes(keyword)) {
                    // 找到包含學校關鍵字的部分，直接返回
                    return part.trim();
                }
            }
        }

        // 如果分割後找不到，嘗試用正則表達式從整個檔名中擷取
        // 匹配模式：[縣市立/私立等前綴] + 學校名稱 + 學校類型關鍵字
        const match = nameWithoutExt.match(/((?:縣立|市立|私立|國立)?[^\-_\s]*(?:國民中學|國民小學|國中|國小|中學|高中|高職))/);
        if (match) {
            return match[1].trim();
        }

        // 無法識別，返回空字串
        return '';
    }

    /**
     * 顯示學校名稱設定區塊
     * @param {string} fileName - 檔案名稱
     */
    showSchoolNameSetting(fileName) {
        const section = document.getElementById('school-name-section');
        const input = document.getElementById('school-name');
        const hint = document.getElementById('school-name-hint');
        const warning = document.getElementById('school-name-warning');

        // 顯示設定區塊
        section.classList.remove('hidden');

        // 嘗試從檔名擷取學校名稱
        const extractedName = this.extractSchoolNameFromFileName(fileName);

        // 檢查是否已有儲存的學校名稱
        const savedName = this.dataManager.getSchoolName();

        if (savedName) {
            // 已有儲存的名稱，顯示已確認狀態
            input.value = savedName;
            this.showSchoolNameConfirmed();
        } else if (extractedName) {
            // 有從檔名擷取到，填入並提示確認
            input.value = extractedName;
            hint.textContent = '系統已從檔名自動擷取，請確認或修改';
            warning.classList.remove('hidden');
        } else {
            // 無法擷取，提示手動輸入
            input.value = '';
            hint.textContent = '無法從檔名自動擷取，請手動輸入學校名稱';
            warning.classList.remove('hidden');
        }

        // 更新頁籤狀態
        this.updateTabLockStatus();
    }

    /**
     * 儲存學校名稱
     */
    saveSchoolName() {
        const input = document.getElementById('school-name');
        const name = input.value.trim();

        if (!name) {
            alert('請輸入學校名稱');
            input.focus();
            return;
        }

        // 儲存到 DataManager
        this.dataManager.setSchoolName(name);

        // 更新 PDF 生成器的學校名稱
        this.pdfGenerator.setSchoolName(name);

        // 顯示已確認狀態
        this.showSchoolNameConfirmed();

        // 更新頁籤狀態
        this.updateTabLockStatus();

        // 更新頁籤內容顯示
        this.updateTabContentVisibility();

        // 儲存到 localStorage
        this.saveDataToStorage();

        alert('學校名稱已設定：' + name);
    }

    /**
     * 顯示學校名稱已確認狀態
     */
    showSchoolNameConfirmed() {
        const section = document.getElementById('school-name-section');
        const warning = document.getElementById('school-name-warning');
        const hint = document.getElementById('school-name-hint');

        section.classList.add('school-name-confirmed');
        warning.classList.add('hidden');
        hint.textContent = '✓ 學校名稱已設定';
        hint.style.color = '#16a34a';
    }

    /**
     * 更新頁籤鎖定狀態
     */
    updateTabLockStatus() {
        const schoolName = this.dataManager.getSchoolName();
        const hasSchedule = this.dataManager.getScheduleData().length > 0;
        const isConfigured = schoolName && hasSchedule;

        // 取得所有頁籤按鈕（除了課表匯入和設定）
        const lockedTabs = ['substitute', 'records', 'settlement'];

        lockedTabs.forEach(tabId => {
            const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
            if (btn) {
                if (isConfigured) {
                    btn.classList.remove('disabled');
                    btn.style.opacity = '1';
                    btn.style.cursor = 'pointer';
                } else {
                    btn.classList.add('disabled');
                    btn.style.opacity = '0.5';
                    btn.style.cursor = 'not-allowed';
                }
            }
        });
    }

    /**
     * 檢查是否可以切換到指定頁籤
     * @param {string} tabId - 頁籤 ID
     * @returns {boolean} 是否允許切換
     */
    canSwitchToTab(tabId) {
        // 課表匯入、課表編輯和設定頁籤始終可用
        if (tabId === 'import' || tabId === 'settings' || tabId === 'schedule-editor') {
            return true;
        }

        const schoolName = this.dataManager.getSchoolName();
        const hasSchedule = this.dataManager.getScheduleData().length > 0;

        if (!hasSchedule) {
            alert('請先匯入課表檔案');
            return false;
        }

        if (!schoolName) {
            alert('請先在「課表匯入」頁籤設定學校名稱');
            return false;
        }

        return true;
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

        // 課表編輯頁面的教師選單
        this.populateEditorTeacherDropdown();
    }

    /**
     * 綁定調代課相關事件
     */
    bindSubstituteEvents() {
        // 教師選擇變更
        document.getElementById('sub-teacher').addEventListener('change', (e) => {
            this.onTeacherOrDateChanged();
        });

        // 日期變更
        document.getElementById('sub-date').addEventListener('change', () => {
            this.onTeacherOrDateChanged();
        });

        // 異動類型切換（調課/代課）- 新版使用 radio button
        document.querySelectorAll('input[name="change-type-radio"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.onChangeTypeSelected(e.target.value);
                // 同步更新隱藏的 select（保持相容性）
                document.getElementById('change-type').value = e.target.value;
            });
        });

        // 假別變更（動態顯示公假字號欄位）
        document.getElementById('leave-type').addEventListener('change', (e) => {
            this.onLeaveTypeChanged(e.target.value);
        });

        // 調課時段 B 日期變更
        document.getElementById('swap-date')?.addEventListener('change', (e) => {
            this.onSwapDateChanged(e.target.value);
        });

        // 調課互換課程選擇
        document.getElementById('swap-course')?.addEventListener('change', (e) => {
            this.onSwapCourseSelected(e.target.value);
        });

        // 確認調課按鈕
        document.getElementById('confirm-substitute-btn').addEventListener('click', () => {
            this.confirmSubstitute();
        });

        // 取消按鈕
        document.getElementById('cancel-substitute-btn').addEventListener('click', () => {
            this.cancelSubstitute();
        });

        // 多節課模式切換
        document.getElementById('multi-course-mode')?.addEventListener('change', (e) => {
            this.onMultiCourseModeToggle(e.target.checked);
        });

        // 清除全部已選課程按鈕
        document.getElementById('clear-all-courses-btn')?.addEventListener('click', () => {
            this.clearAllSelectedCourses();
        });
    }

    /**
     * 當教師或日期變更時觸發（新流程）
     */
    onTeacherOrDateChanged() {
        const teacher = document.getElementById('sub-teacher').value;
        const date = document.getElementById('sub-date').value;

        // 重置後續步驟
        this.resetStepsAfterBasic();

        if (!teacher || !date) {
            // 隱藏步驟二及後續
            document.getElementById('step-change-type').classList.add('hidden');
            document.getElementById('step-select-course').classList.add('hidden');
            document.getElementById('selected-course-info').classList.add('hidden');
            return;
        }

        // 顯示步驟二：選擇異動類型
        document.getElementById('step-change-type').classList.remove('hidden');

        // 根據日期更新課表顯示
        this.showScheduleForDate(teacher, date);
    }

    /**
     * 重置基本選擇之後的步驟
     */
    resetStepsAfterBasic() {
        this.selectedCourse = null;
        this.selectedSubstitute = null;
        this.selectedSwapCourse = null;
        this.selectedCourses = [];  // 重置多選課程

        // 重置異動類型為代課
        const substituteRadio = document.querySelector('input[name="change-type-radio"][value="substitute"]');
        if (substituteRadio) {
            substituteRadio.checked = true;
        }
        document.getElementById('change-type').value = 'substitute';

        // 重置假別
        document.getElementById('leave-type').value = '';
        document.getElementById('doc-number').value = '';
        document.getElementById('doc-number-group').style.display = 'none';

        // 顯示代課選項，隱藏調課選項
        document.getElementById('substitute-options-early').classList.remove('hidden');
        document.getElementById('substitute-options').classList.remove('hidden');
        document.getElementById('swap-options').classList.add('hidden');

        // 清除課程選擇狀態
        document.querySelectorAll('.schedule-course.selected').forEach(c => c.classList.remove('selected'));
    }

    /**
     * 根據日期顯示課表，僅高亮該日課程
     */
    showScheduleForDate(teacherName, date) {
        // 取得該教師的週課表
        const weekSchedule = this.dataManager.getTeacherWeekSchedule(teacherName);

        // 取得選定日期的星期
        const selectedWeekday = this.getDateWeekday(date);
        document.getElementById('selected-weekday').textContent = selectedWeekday;

        // 渲染課表並高亮該日
        this.renderTeacherScheduleWithHighlight(weekSchedule, teacherName, selectedWeekday);

        // 顯示步驟三：選擇課程
        document.getElementById('step-select-course').classList.remove('hidden');
    }

    /**
     * 當異動類型變更時觸發（調課/代課）
     */
    onChangeTypeSelected(type) {
        const substituteOptionsEarly = document.getElementById('substitute-options-early');
        const substituteOptions = document.getElementById('substitute-options');
        const swapOptions = document.getElementById('swap-options');
        const dateLabelHint = document.getElementById('date-label-hint');

        if (type === 'swap') {
            // 調課模式：隱藏假別選擇（步驟二）和代課教師推薦（步驟四）
            substituteOptionsEarly.classList.add('hidden');
            substituteOptions.classList.add('hidden');
            swapOptions.classList.remove('hidden');

            // 更新日期標籤提示
            if (dateLabelHint) {
                dateLabelHint.textContent = '（時段 A）';
            }

            // 更新調課課程列表
            if (this.selectedCourse) {
                this.updateSwapSlotAInfo();
                this.updateSwapCourseList();
            }
        } else {
            // 代課模式：顯示假別選擇和代課教師推薦
            substituteOptionsEarly.classList.remove('hidden');
            substituteOptions.classList.remove('hidden');
            swapOptions.classList.add('hidden');

            // 清除日期標籤提示
            if (dateLabelHint) {
                dateLabelHint.textContent = '';
            }
        }
    }

    /**
     * 當假別變更時觸發（動態顯示公付假別字號）
     */
    onLeaveTypeChanged(leaveType) {
        const docNumberGroup = document.getElementById('doc-number-group');
        const docNumberInput = document.getElementById('doc-number');
        const docNumberLabel = docNumberGroup.querySelector('label');

        // 公付假別：公假、長期病假、喪假
        const paidLeaveTypes = ['official', 'longsick', 'funeral'];

        if (paidLeaveTypes.includes(leaveType)) {
            // 公付假別：顯示並設為必填
            docNumberGroup.style.display = 'block';
            docNumberInput.required = true;
            // 更新標籤文字
            const labelText = leaveType === 'official' ? '公假字號' :
                              leaveType === 'longsick' ? '核准文號' : '喪假證明';
            docNumberLabel.innerHTML = `${labelText}：<span style="color: red;">*</span>`;
            docNumberInput.placeholder = leaveType === 'official' ? '如：北教字第1140012345號' :
                                         leaveType === 'longsick' ? '如：核准文號或醫院證明編號' : '如：訃聞或相關證明';
        } else {
            // 其他假別：隱藏並取消必填
            docNumberGroup.style.display = 'none';
            docNumberInput.required = false;
            docNumberInput.value = '';
        }
    }

    /**
     * 更新時段 A 資訊顯示
     */
    updateSwapSlotAInfo() {
        const slotAInfo = document.getElementById('swap-slot-a-info');
        if (!slotAInfo || !this.selectedCourse) return;

        const dateA = document.getElementById('sub-date').value;
        const formattedDateA = dateA ? new Date(dateA).toLocaleDateString('zh-TW', {
            year: 'numeric', month: 'long', day: 'numeric'
        }) : '';

        slotAInfo.innerHTML = `
            <span style="color: #1d4ed8;">📅 ${formattedDateA}</span>
            <span style="margin-left: 10px;">${this.selectedCourse.weekday} ${this.selectedCourse.period}</span>
            <span style="margin-left: 10px;">${this.selectedCourse.className}</span>
            <span style="margin-left: 10px;">${this.selectedCourse.originalTeacher}（${this.selectedCourse.subject}）</span>
        `;
    }

    /**
     * 當時段 B 日期變更時觸發
     */
    onSwapDateChanged(date) {
        const swapCourseSelect = document.getElementById('swap-course');
        const swapDateHint = document.getElementById('swap-date-hint');
        const swapPreview = document.getElementById('swap-preview');

        // 隱藏預覽
        swapPreview.classList.add('hidden');
        this.selectedSwapCourse = null;

        if (!date) {
            swapCourseSelect.innerHTML = '<option value="">請先選擇時段 B 日期</option>';
            swapDateHint.textContent = '';
            return;
        }

        // 取得時段 B 日期對應的星期
        const swapWeekday = this.getDateWeekday(date);
        swapDateHint.innerHTML = `<span style="color: #b45309;">→ ${swapWeekday}</span>`;

        // 更新課程列表（根據時段 B 的星期過濾）
        this.updateSwapCourseListForDate(swapWeekday);
    }

    /**
     * 更新調課可互換課程列表（根據時段 B 日期過濾）
     * @param {string} swapWeekday - 時段 B 的星期
     */
    updateSwapCourseListForDate(swapWeekday) {
        const swapCourseSelect = document.getElementById('swap-course');
        const swapHint = document.getElementById('swap-hint');
        const swapPreview = document.getElementById('swap-preview');
        const scheduleData = this.dataManager.getScheduleData();

        // 隱藏預覽
        swapPreview.classList.add('hidden');

        if (!this.selectedCourse) {
            swapCourseSelect.innerHTML = '<option value="">請先選擇時段 A 的課程</option>';
            return;
        }

        // 原課程資訊
        const targetClass = this.selectedCourse.className;
        const originalWeekday = this.selectedCourse.weekday;
        const originalPeriod = this.selectedCourse.period;
        const originalTeacher = this.selectedCourse.originalTeacher;

        // 篩選同班級、時段 B 星期的課程
        const sameclassCourses = scheduleData.filter(course =>
            course.className === targetClass &&
            course.weekday === swapWeekday &&
            !(course.weekday === originalWeekday && course.period === originalPeriod)
        );

        if (sameclassCourses.length === 0) {
            swapCourseSelect.innerHTML = `<option value="">${swapWeekday} ${targetClass} 沒有課程可調換</option>`;
            swapHint.innerHTML = `調課說明：選擇同班級的另一時段課程進行互換`;
            swapHint.style.color = '#6b7280';
            return;
        }

        // 檢查每堂課是否會造成衝堂
        const eligibleCourses = [];
        const conflictCourses = [];

        sameclassCourses.forEach(course => {
            const conflict = this.checkSwapConflict(originalTeacher, originalWeekday, originalPeriod, course, scheduleData);
            if (conflict) {
                conflictCourses.push({ course, conflict });
            } else {
                eligibleCourses.push(course);
            }
        });

        // 按節次排序
        const sortByPeriod = (a, b) => a.period.localeCompare(b.period);
        eligibleCourses.sort(sortByPeriod);
        conflictCourses.sort((a, b) => sortByPeriod(a.course, b.course));

        // 建立下拉選單
        let options = '<option value="">請選擇要互換的課程</option>';

        // 可調換的課程
        eligibleCourses.forEach(course => {
            const courseId = `${course.weekday}_${course.period}_${course.teacher}`;
            options += `<option value="${courseId}">${course.period} - ${course.teacher}（${course.subject}）</option>`;
        });

        // 衝堂的課程（顯示為禁用）
        conflictCourses.forEach(({ course, conflict }) => {
            const courseId = `${course.weekday}_${course.period}_${course.teacher}`;
            options += `<option value="${courseId}" disabled style="color: #999;">⚠ ${course.period} - ${course.teacher}（${course.subject}）- ${conflict}</option>`;
        });

        swapCourseSelect.innerHTML = options;

        if (eligibleCourses.length > 0) {
            swapHint.innerHTML = `✓ ${swapWeekday} ${targetClass} 有 ${eligibleCourses.length} 堂可互換課程` +
                (conflictCourses.length > 0 ? `<br><span style="color: #dc2626;">⚠ ${conflictCourses.length} 堂因衝堂無法調換</span>` : '');
            swapHint.style.color = '#16a34a';
        } else {
            swapHint.innerHTML = `<span style="color: #dc2626;">⚠ ${swapWeekday} ${targetClass} 的課程皆因衝堂無法調換</span>`;
        }
    }

    /**
     * 更新調課可互換課程列表（舊版，保留相容性）
     * 顯示同班級不同時段的所有課程，並檢查衝堂
     */
    updateSwapCourseList() {
        // 如果有選擇時段 B 日期，使用新的過濾邏輯
        const swapDate = document.getElementById('swap-date')?.value;
        if (swapDate) {
            const swapWeekday = this.getDateWeekday(swapDate);
            this.updateSwapCourseListForDate(swapWeekday);
            return;
        }

        // 否則顯示提示
        const swapCourseSelect = document.getElementById('swap-course');
        swapCourseSelect.innerHTML = '<option value="">請先選擇時段 B 日期</option>';
    }

    /**
     * 檢查調課是否會造成衝堂
     * @param {string} teacherA - 原課程教師
     * @param {string} weekdayA - 原課程星期
     * @param {string} periodA - 原課程節次
     * @param {Object} courseB - 目標課程
     * @param {Array} scheduleData - 課表資料
     * @returns {string|null} 衝堂原因，null 表示無衝堂
     */
    checkSwapConflict(teacherA, weekdayA, periodA, courseB, scheduleData) {
        const teacherB = courseB.teacher;
        const weekdayB = courseB.weekday;
        const periodB = courseB.period;

        // 檢查 A 老師在時段 B 是否有其他課（排除目標課程的班級）
        const teacherAConflict = scheduleData.find(course =>
            course.teacher === teacherA &&
            course.weekday === weekdayB &&
            course.period === periodB &&
            course.className !== courseB.className
        );

        if (teacherAConflict) {
            return `${teacherA}在${weekdayB}${periodB}有${teacherAConflict.className}課`;
        }

        // 檢查 B 老師在時段 A 是否有其他課（排除原課程的班級）
        const teacherBConflict = scheduleData.find(course =>
            course.teacher === teacherB &&
            course.weekday === weekdayA &&
            course.period === periodA &&
            course.className !== this.selectedCourse.className
        );

        if (teacherBConflict) {
            return `${teacherB}在${weekdayA}${periodA}有${teacherBConflict.className}課`;
        }

        return null;
    }

    /**
     * 當選擇調課互換課程時觸發
     */
    onSwapCourseSelected(courseId) {
        const validationError = document.getElementById('swap-validation-error');
        const swapPreview = document.getElementById('swap-preview');
        const swapPreviewContent = document.getElementById('swap-preview-content');

        if (!courseId) {
            this.selectedSwapCourse = null;
            validationError.classList.add('hidden');
            swapPreview.classList.add('hidden');
            return;
        }

        // 解析課程 ID
        const [weekday, period, teacher] = courseId.split('_');
        const scheduleData = this.dataManager.getScheduleData();
        const swapCourse = scheduleData.find(course =>
            course.weekday === weekday &&
            course.period === period &&
            course.teacher === teacher &&
            course.className === this.selectedCourse.className
        );

        if (!swapCourse) {
            validationError.textContent = '⚠ 找不到選擇的課程，請重新選擇';
            validationError.classList.remove('hidden');
            swapPreview.classList.add('hidden');
            this.selectedSwapCourse = null;
            return;
        }

        validationError.classList.add('hidden');
        this.selectedSwapCourse = swapCourse;

        // 取得兩個日期
        const dateA = document.getElementById('sub-date').value;
        const dateB = document.getElementById('swap-date').value;

        const formattedDateA = dateA ? new Date(dateA).toLocaleDateString('zh-TW', {
            year: 'numeric', month: 'long', day: 'numeric'
        }) : '';
        const formattedDateB = dateB ? new Date(dateB).toLocaleDateString('zh-TW', {
            year: 'numeric', month: 'long', day: 'numeric'
        }) : '';

        // 顯示調課預覽（包含日期）
        const originalCourse = this.selectedCourse;
        swapPreviewContent.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr style="background: #e0f2fe;">
                    <th style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">時段</th>
                    <th style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">日期</th>
                    <th style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">調課前</th>
                    <th style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">→</th>
                    <th style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">調課後</th>
                </tr>
                <tr style="background: #dbeafe;">
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center; font-weight: bold;">A</td>
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">${formattedDateA}<br>${originalCourse.weekday} ${originalCourse.period}</td>
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">${originalCourse.originalTeacher}（${originalCourse.subject}）</td>
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">→</td>
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center; color: #0369a1; font-weight: bold;">${swapCourse.teacher}（${swapCourse.subject}）</td>
                </tr>
                <tr style="background: #fef3c7;">
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center; font-weight: bold;">B</td>
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">${formattedDateB}<br>${swapCourse.weekday} ${swapCourse.period}</td>
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">${swapCourse.teacher}（${swapCourse.subject}）</td>
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center;">→</td>
                    <td style="padding: 8px; border: 1px solid #bae6fd; text-align: center; color: #b45309; font-weight: bold;">${originalCourse.originalTeacher}（${originalCourse.subject}）</td>
                </tr>
            </table>
            <p style="margin: 10px 0 0 0; color: #0369a1; font-size: 13px;">
                ✓ ${originalCourse.className} 的 ${originalCourse.originalTeacher} 與 ${swapCourse.teacher} 互換課程時段，雙方總時數不變
            </p>
        `;
        swapPreview.classList.remove('hidden');
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
        this.renderTeacherScheduleWithHighlight(weekSchedule, teacherName, null);
    }

    /**
     * 渲染教師週課表（帶日期高亮）
     * @param {Array} weekSchedule - 週課表資料
     * @param {string} teacherName - 教師姓名
     * @param {string|null} highlightWeekday - 要高亮的星期（如：週一）
     */
    renderTeacherScheduleWithHighlight(weekSchedule, teacherName, highlightWeekday) {
        const grid = document.getElementById('original-schedule-grid');
        const days = ['一', '二', '三', '四', '五'];
        const periods = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節'];

        let html = '';

        // 標題列
        html += '<div class="schedule-cell schedule-header">節次</div>';
        days.forEach(day => {
            const dayName = '週' + day;
            const isActiveDay = highlightWeekday === dayName;
            const headerClass = isActiveDay ? 'schedule-cell schedule-header active-day' : 'schedule-cell schedule-header';
            html += `<div class="${headerClass}">週${day}</div>`;
        });

        // 各節次
        periods.forEach((period, periodIndex) => {
            html += `<div class="schedule-cell schedule-period">${period}</div>`;

            days.forEach((day, dayIndex) => {
                const dayName = '週' + day;
                const isActiveDay = highlightWeekday === dayName;
                const courses = weekSchedule.filter(c =>
                    c.weekday === dayName && c.period === period
                );

                if (courses.length > 0) {
                    const course = courses[0];
                    // 如果有高亮設定，只有該天的課程可選擇
                    const isSelectable = !highlightWeekday || isActiveDay;
                    const cellClasses = [
                        'schedule-cell',
                        'schedule-course',
                        isActiveDay ? 'today-highlight' : '',
                        isSelectable ? 'selectable' : 'disabled'
                    ].filter(Boolean).join(' ');

                    html += `
                        <div class="${cellClasses}"
                             data-weekday="${dayName}"
                             data-period="${period}"
                             data-class="${course.className}"
                             data-subject="${course.subject}"
                             data-domain="${course.domain}"
                             data-selectable="${isSelectable}">
                            <span class="course-class">${course.className}</span>
                            <span class="course-subject">${course.subject}</span>
                        </div>
                    `;
                } else {
                    const freeClasses = isActiveDay
                        ? 'schedule-cell schedule-course free today-highlight'
                        : 'schedule-cell schedule-course free';
                    html += `<div class="${freeClasses}">空堂</div>`;
                }
            });
        });

        grid.innerHTML = html;

        // 綁定課程點擊事件（只綁定可選擇的課程）
        grid.querySelectorAll('.schedule-course.selectable:not(.free)').forEach(cell => {
            cell.addEventListener('click', (e) => this.onCourseSelected(e.target.closest('.schedule-course')));
        });
    }

    /**
     * 當選擇課程時觸發
     */
    onCourseSelected(cell) {
        // 檢查是否可選擇
        if (cell.dataset.selectable === 'false') {
            return;
        }

        const teacherName = document.getElementById('sub-teacher').value;
        const date = document.getElementById('sub-date').value;

        // 取得課程資訊
        const courseInfo = {
            weekday: cell.dataset.weekday,
            period: cell.dataset.period,
            className: cell.dataset.class,
            subject: cell.dataset.subject,
            domain: cell.dataset.domain,
            originalTeacher: teacherName
        };

        // 根據模式處理選擇
        if (this.isMultiCourseMode) {
            // 多選模式
            this.handleMultiCourseSelection(cell, courseInfo, date);
        } else {
            // 單選模式（原有邏輯）
            this.handleSingleCourseSelection(cell, courseInfo, date);
        }
    }

    /**
     * 處理單選模式的課程選擇
     */
    handleSingleCourseSelection(cell, courseInfo, date) {
        // 移除其他選中狀態
        document.querySelectorAll('.schedule-course.selected').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.schedule-course.multi-selected').forEach(c => c.classList.remove('multi-selected'));

        // 選中當前課程
        cell.classList.add('selected');

        this.selectedCourse = courseInfo;

        // 檢查該課堂是否已有調代課紀錄（衝堂檢查）
        this.checkAndShowExistingRecordWarning(date, this.selectedCourse);

        // 更新選中課程資訊顯示（單節課摘要）
        document.getElementById('single-course-summary').classList.remove('hidden');
        document.getElementById('multi-course-summary').classList.add('hidden');
        document.getElementById('sel-class').textContent = this.selectedCourse.className;
        document.getElementById('sel-period').textContent = `${this.selectedCourse.weekday} ${this.selectedCourse.period}`;
        document.getElementById('sel-subject').textContent = this.selectedCourse.subject;
        document.getElementById('sel-original-teacher').textContent = courseInfo.originalTeacher;

        // 顯示步驟四：確認資訊
        document.getElementById('selected-course-info').classList.remove('hidden');

        // 根據異動類型更新顯示
        const changeType = document.getElementById('change-type').value;
        if (changeType === 'swap') {
            // 調課模式：更新時段 A 資訊和可互換課程列表
            this.updateSwapSlotAInfo();
            this.updateSwapCourseList();
        } else {
            // 代課模式：計算並顯示推薦代課教師
            this.showRecommendations();
        }
    }

    /**
     * 處理多選模式的課程選擇
     */
    handleMultiCourseSelection(cell, courseInfo, date) {
        // 檢查課程是否已被選中
        const courseKey = `${courseInfo.weekday}_${courseInfo.period}_${courseInfo.className}`;
        const existingIndex = this.selectedCourses.findIndex(c =>
            `${c.weekday}_${c.period}_${c.className}` === courseKey
        );

        if (existingIndex >= 0) {
            // 已選中，取消選擇
            this.selectedCourses.splice(existingIndex, 1);
            cell.classList.remove('multi-selected');
        } else {
            // 未選中，檢查衝堂後加入
            if (typeof this.dataManager?.checkExistingRecord === 'function') {
                const existingRecord = this.dataManager.checkExistingRecord(
                    date,
                    courseInfo.period,
                    courseInfo.className,
                    courseInfo.originalTeacher
                );
                if (existingRecord) {
                    alert(`此課堂（${courseInfo.period} ${courseInfo.className}）已有調代課紀錄，無法選擇！`);
                    return;
                }
            }
            this.selectedCourses.push(courseInfo);
            cell.classList.add('multi-selected');
        }

        // 更新已選課程列表 UI
        this.updateSelectedCoursesUI();

        // 如果有選中的課程，顯示步驟四
        if (this.selectedCourses.length > 0) {
            this.selectedCourse = this.selectedCourses[0];  // 用於相容性
            document.getElementById('selected-course-info').classList.remove('hidden');

            // 顯示多節課摘要，隱藏單節課摘要
            document.getElementById('single-course-summary').classList.add('hidden');
            document.getElementById('multi-course-summary').classList.remove('hidden');

            // 更新多節課確認資訊
            this.updateMultiCourseSummary();

            // 代課模式：顯示推薦（基於第一節課）
            const changeType = document.getElementById('change-type').value;
            if (changeType !== 'swap') {
                this.showRecommendations();
            }
        } else {
            document.getElementById('selected-course-info').classList.add('hidden');
        }
    }

    /**
     * 更新已選課程列表 UI
     */
    updateSelectedCoursesUI() {
        const container = document.getElementById('selected-courses-list');
        const chipsContainer = document.getElementById('selected-courses-chips');
        const countElement = document.getElementById('selected-course-count');

        if (this.selectedCourses.length === 0) {
            container.classList.add('hidden');
            return;
        }

        container.classList.remove('hidden');
        countElement.textContent = this.selectedCourses.length;

        // 生成課程標籤
        chipsContainer.innerHTML = this.selectedCourses.map((course, index) => `
            <div class="course-chip" data-index="${index}">
                <span class="chip-text">${course.period} ${course.className} ${course.subject}</span>
                <span class="chip-remove" data-index="${index}" title="移除">×</span>
            </div>
        `).join('');

        // 綁定移除按鈕事件
        chipsContainer.querySelectorAll('.chip-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = parseInt(e.target.dataset.index);
                this.removeCourseFromSelection(index);
            });
        });
    }

    /**
     * 從多選中移除課程
     */
    removeCourseFromSelection(index) {
        if (index < 0 || index >= this.selectedCourses.length) return;

        const course = this.selectedCourses[index];
        this.selectedCourses.splice(index, 1);

        // 移除對應格子的選中狀態
        const grid = document.getElementById('original-schedule-grid');
        const cell = grid.querySelector(`.schedule-course[data-weekday="${course.weekday}"][data-period="${course.period}"][data-class="${course.className}"]`);
        if (cell) {
            cell.classList.remove('multi-selected');
        }

        // 更新 UI
        this.updateSelectedCoursesUI();

        if (this.selectedCourses.length > 0) {
            this.selectedCourse = this.selectedCourses[0];
            this.updateMultiCourseSummary();
        } else {
            this.selectedCourse = null;
            document.getElementById('selected-course-info').classList.add('hidden');
        }
    }

    /**
     * 清除所有已選課程
     */
    clearAllSelectedCourses() {
        this.selectedCourses = [];
        this.selectedCourse = null;

        // 移除所有選中狀態
        document.querySelectorAll('.schedule-course.multi-selected').forEach(c => {
            c.classList.remove('multi-selected');
        });

        // 更新 UI
        this.updateSelectedCoursesUI();
        document.getElementById('selected-course-info').classList.add('hidden');
    }

    /**
     * 更新多節課摘要顯示
     */
    updateMultiCourseSummary() {
        const tbody = document.getElementById('multi-course-tbody');
        const countElement = document.getElementById('confirm-course-count');
        const teacherElement = document.getElementById('sel-original-teacher-multi');

        countElement.textContent = this.selectedCourses.length;
        teacherElement.textContent = this.selectedCourses[0]?.originalTeacher || '';

        // 按節次排序
        const sortedCourses = [...this.selectedCourses].sort((a, b) => {
            const periodOrder = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節'];
            return periodOrder.indexOf(a.period) - periodOrder.indexOf(b.period);
        });

        tbody.innerHTML = sortedCourses.map(course => `
            <tr>
                <td>${course.weekday} ${course.period}</td>
                <td>${course.className}</td>
                <td>${course.subject}</td>
            </tr>
        `).join('');
    }

    /**
     * 多節課模式切換
     */
    onMultiCourseModeToggle(enabled) {
        this.isMultiCourseMode = enabled;

        // 更新提示顯示
        const hint = document.getElementById('multi-course-hint');
        if (hint) {
            hint.classList.toggle('hidden', !enabled);
        }

        // 多選模式下隱藏調課選項（多節課只支援代課）
        if (enabled) {
            // 強制切換到代課模式
            const substituteRadio = document.querySelector('input[name="change-type-radio"][value="substitute"]');
            if (substituteRadio) {
                substituteRadio.checked = true;
                this.onChangeTypeSelected('substitute');
                document.getElementById('change-type').value = 'substitute';
            }
            // 禁用調課選項
            const swapRadio = document.querySelector('input[name="change-type-radio"][value="swap"]');
            if (swapRadio) {
                swapRadio.disabled = true;
                swapRadio.closest('.change-type-option').style.opacity = '0.5';
                swapRadio.closest('.change-type-option').title = '多節課模式不支援調課';
            }
        } else {
            // 啟用調課選項
            const swapRadio = document.querySelector('input[name="change-type-radio"][value="swap"]');
            if (swapRadio) {
                swapRadio.disabled = false;
                swapRadio.closest('.change-type-option').style.opacity = '1';
                swapRadio.closest('.change-type-option').title = '';
            }
        }

        // 清除之前的選擇
        this.clearAllSelectedCourses();
        document.querySelectorAll('.schedule-course.selected').forEach(c => c.classList.remove('selected'));
    }

    /**
     * 檢查並顯示已存在調代課紀錄的警告
     * @param {string} date - 選擇的日期
     * @param {Object} course - 選擇的課程
     */
    checkAndShowExistingRecordWarning(date, course) {
        // 移除先前的警告訊息
        const existingWarning = document.getElementById('existing-record-warning');
        if (existingWarning) {
            existingWarning.remove();
        }

        // 調試：檢查 dataManager 狀態
        console.log('dataManager 類型:', typeof this.dataManager);
        console.log('dataManager:', this.dataManager);
        console.log('checkExistingRecord 存在:', typeof this.dataManager?.checkExistingRecord);

        // 如果方法不存在，跳過檢查
        if (typeof this.dataManager?.checkExistingRecord !== 'function') {
            console.warn('checkExistingRecord 方法不存在，跳過衝堂檢查');
            this.hasExistingRecord = false;
            return;
        }

        // 檢查是否已有紀錄
        const existingRecord = this.dataManager.checkExistingRecord(
            date,
            course.period,
            course.className,
            course.originalTeacher
        );

        if (existingRecord) {
            // 建立警告訊息
            const warningDiv = document.createElement('div');
            warningDiv.id = 'existing-record-warning';
            warningDiv.style.cssText = `
                background: #fef2f2;
                border: 1px solid #fecaca;
                border-radius: 8px;
                padding: 12px 16px;
                margin-top: 12px;
                color: #991b1b;
            `;

            const recordType = existingRecord.type || '代課';
            const substituteInfo = existingRecord.type === '調課'
                ? `調課教師：${existingRecord.swapTeacher || existingRecord.substituteTeacher}`
                : `代課教師：${existingRecord.substituteTeacher}`;

            warningDiv.innerHTML = `
                <div style="display: flex; align-items: flex-start; gap: 10px;">
                    <span style="font-size: 18px;">⚠️</span>
                    <div>
                        <div style="font-weight: bold; margin-bottom: 4px;">此課堂已有調代課紀錄</div>
                        <div style="font-size: 13px; color: #7f1d1d;">
                            ${existingRecord.date} ${existingRecord.weekday} ${existingRecord.period}<br>
                            ${existingRecord.className} ${existingRecord.subject}（${recordType}）<br>
                            ${substituteInfo}
                        </div>
                        <div style="font-size: 12px; margin-top: 8px; color: #b91c1c;">
                            如需重新安排，請先至「調代課紀錄」刪除該筆紀錄
                        </div>
                    </div>
                </div>
            `;

            // 插入到選擇課程資訊區塊後面
            const selectedCourseInfo = document.getElementById('selected-course-info');
            if (selectedCourseInfo) {
                selectedCourseInfo.appendChild(warningDiv);
            }

            // 標記有衝堂紀錄
            this.hasExistingRecord = true;
        } else {
            this.hasExistingRecord = false;
        }
    }

    /**
     * 顯示推薦代課教師列表
     */
    showRecommendations() {
        const date = document.getElementById('sub-date').value;
        const scheduleData = this.dataManager.getScheduleData();
        const teachers = this.dataManager.getTeachers();

        console.log('===== 代課教師推薦 =====');
        console.log('選擇的課程:', this.selectedCourse);
        console.log('課表資料筆數:', scheduleData.length);
        console.log('教師資料筆數:', teachers.length);
        console.log('日期:', date);

        // 使用推薦引擎計算推薦列表
        const recommendations = this.recommendationEngine.getRecommendations(
            this.selectedCourse,
            scheduleData,
            teachers,
            date
        );

        console.log('推薦結果筆數:', recommendations.length);

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
     * 滾動到指定元素並高亮提示
     * @param {string|HTMLElement} elementOrId - 元素或元素 ID
     * @param {string} message - 提示訊息
     */
    scrollToAndHighlight(elementOrId, message) {
        const element = typeof elementOrId === 'string'
            ? document.getElementById(elementOrId)
            : elementOrId;

        if (!element) return;

        // 滾動到元素位置
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // 聚焦（如果可聚焦）
        if (element.focus) {
            setTimeout(() => element.focus(), 300);
        }

        // 高亮效果
        element.style.transition = 'box-shadow 0.3s ease';
        element.style.boxShadow = '0 0 0 3px #ef4444, 0 0 10px rgba(239, 68, 68, 0.5)';

        // 3 秒後移除高亮
        setTimeout(() => {
            element.style.boxShadow = '';
        }, 3000);

        // 顯示提示
        alert(message);
    }

    /**
     * 確認調課/代課
     */
    async confirmSubstitute() {
        const changeType = document.getElementById('change-type').value;

        // ===== 步驟一驗證：教師與日期 =====
        const teacher = document.getElementById('sub-teacher').value;
        if (!teacher) {
            this.scrollToAndHighlight('sub-teacher', '請選擇原任課教師');
            return;
        }

        const date = document.getElementById('sub-date').value;
        if (!date) {
            this.scrollToAndHighlight('sub-date', '請選擇調代課日期');
            return;
        }

        // ===== 步驟二驗證：異動類型與假別 =====
        if (changeType === 'substitute') {
            const leaveType = document.getElementById('leave-type').value;
            if (!leaveType) {
                this.scrollToAndHighlight('leave-type', '請選擇假別');
                return;
            }

            // 公付假別必須填寫字號/證明
            const paidLeaveTypes = ['official', 'longsick', 'funeral'];
            if (paidLeaveTypes.includes(leaveType)) {
                const docNumber = document.getElementById('doc-number').value.trim();
                if (!docNumber) {
                    const fieldName = leaveType === 'official' ? '公假字號' :
                                      leaveType === 'longsick' ? '核准文號' : '喪假證明';
                    this.scrollToAndHighlight('doc-number', `${this.getLeaveTypeName(leaveType)}必須填寫${fieldName}`);
                    return;
                }
            }
        }

        // ===== 步驟三驗證：選擇課程 =====
        // 多節課模式
        if (this.isMultiCourseMode && this.selectedCourses.length > 0) {
            await this.confirmMultiCourseSubstitute(date, changeType);
            return;
        }

        // 單節課模式
        if (!this.selectedCourse) {
            this.scrollToAndHighlight('original-schedule-grid', '請從課表中選擇要調代課的課程');
            return;
        }

        // 檢查該課堂是否已有調代課紀錄（衝堂檢查）
        let existingRecord = null;
        if (typeof this.dataManager?.checkExistingRecord === 'function') {
            existingRecord = this.dataManager.checkExistingRecord(
                date,
                this.selectedCourse.period,
                this.selectedCourse.className,
                this.selectedCourse.originalTeacher
            );
        }

        if (existingRecord) {
            const recordType = existingRecord.type || '代課';
            const substituteInfo = existingRecord.type === '調課'
                ? `調課教師：${existingRecord.swapTeacher || existingRecord.substituteTeacher}`
                : `代課教師：${existingRecord.substituteTeacher}`;

            alert(`此課堂已有調代課紀錄，無法重複申請！\n\n` +
                `${existingRecord.date} ${existingRecord.weekday} ${existingRecord.period}\n` +
                `${existingRecord.className} ${existingRecord.subject}（${recordType}）\n` +
                `${substituteInfo}\n\n` +
                `如需重新安排，請先至「調代課紀錄」刪除該筆紀錄。`);
            return;
        }

        // 驗證日期與課程星期是否相符
        const courseWeekday = this.selectedCourse.weekday;
        const dateWeekday = this.getDateWeekday(date);

        if (dateWeekday !== courseWeekday) {
            const formattedDate = new Date(date).toLocaleDateString('zh-TW', {
                year: 'numeric', month: 'long', day: 'numeric'
            });
            const suggestedDate = this.findNextMatchingDate(courseWeekday, date);
            const suggestedFormatted = new Date(suggestedDate).toLocaleDateString('zh-TW', {
                year: 'numeric', month: 'long', day: 'numeric'
            });

            const confirmMsg = `日期與星期不符！\n\n` +
                `選擇的課程是「${courseWeekday}」的課\n` +
                `但選擇的日期 ${formattedDate} 是「${dateWeekday}」\n\n` +
                `建議調整為：${suggestedFormatted}（${courseWeekday}）\n\n` +
                `是否自動調整日期？`;

            if (confirm(confirmMsg)) {
                document.getElementById('sub-date').value = suggestedDate;
                this.showDateAdjustmentHint(courseWeekday, suggestedDate);
                return;
            } else {
                return;
            }
        }

        // ===== 步驟四驗證：代課教師或互換課程 =====
        if (changeType === 'substitute') {
            // 代課模式：驗證代課教師
            if (!this.selectedSubstitute) {
                this.scrollToAndHighlight('recommendation-list', '請選擇代課教師');
                return;
            }

            const leaveType = document.getElementById('leave-type').value;
            const paidLeaveTypes = ['official', 'longsick', 'funeral'];
            const reason = document.getElementById('sub-reason').value.trim();

            // 建立代課紀錄
            const record = {
                id: Date.now().toString(),
                type: '代課',
                date: date,
                weekday: this.selectedCourse.weekday,
                period: this.selectedCourse.period,
                className: this.selectedCourse.className,
                subject: this.selectedCourse.subject,
                domain: this.selectedCourse.domain,
                originalTeacher: this.selectedCourse.originalTeacher,
                substituteTeacher: this.selectedSubstitute.teacher.name,
                leaveType: this.getLeaveTypeName(leaveType),
                leaveTypeName: this.getLeaveTypeName(leaveType),
                docNumber: paidLeaveTypes.includes(leaveType) ? document.getElementById('doc-number').value.trim() : '',
                reason: reason,
                createdAt: new Date().toISOString()
            };

            // 儲存並處理
            await this.saveAndProcessRecord(record);

        } else {
            // 調課模式驗證
            const swapDate = document.getElementById('swap-date').value;
            if (!swapDate) {
                this.scrollToAndHighlight('swap-date', '請選擇時段 B 日期');
                return;
            }

            const swapCourseId = document.getElementById('swap-course').value;
            if (!swapCourseId) {
                this.scrollToAndHighlight('swap-course', '請選擇要互換的課程');
                return;
            }

            // 驗證已選擇互換課程
            if (!this.selectedSwapCourse) {
                this.scrollToAndHighlight('swap-course', '調課驗證失敗：請重新選擇互換課程');
                return;
            }

            if (this.selectedSwapCourse.className !== this.selectedCourse.className) {
                this.scrollToAndHighlight('swap-course', '調課錯誤：課程班級不相同，無法調課！');
                return;
            }

            // 驗證時段 B 日期與星期是否相符
            const swapWeekday = this.selectedSwapCourse.weekday;
            const swapDateWeekday = this.getDateWeekday(swapDate);
            if (swapDateWeekday !== swapWeekday) {
                this.scrollToAndHighlight('swap-date', `時段 B 日期錯誤！\n\n選擇的課程是「${swapWeekday}」的課\n但選擇的日期是「${swapDateWeekday}」`);
                return;
            }

            // 建立調課紀錄（記錄完整的互換資訊，包含兩個日期）
            const record = {
                id: Date.now().toString(),
                type: '調課',
                date: date,           // 時段 A 日期
                swapDate: swapDate,   // 時段 B 日期
                // 原課程資訊（時段 A）
                weekday: this.selectedCourse.weekday,
                period: this.selectedCourse.period,
                className: this.selectedCourse.className,
                subject: this.selectedCourse.subject,
                domain: this.selectedCourse.domain,
                originalTeacher: this.selectedCourse.originalTeacher,
                // 互換課程資訊（時段 B）
                swapWeekday: this.selectedSwapCourse.weekday,
                swapPeriod: this.selectedSwapCourse.period,
                swapTeacher: this.selectedSwapCourse.teacher,
                swapSubject: this.selectedSwapCourse.subject,
                swapDomain: this.selectedSwapCourse.domain,
                // 調課不需要代課教師，兩堂課互換
                substituteTeacher: this.selectedSwapCourse.teacher,
                leaveType: '調課',
                leaveTypeName: '調課',
                docNumber: '',
                reason: `時段A(${date}) ${this.selectedCourse.weekday}${this.selectedCourse.period} ↔ 時段B(${swapDate}) ${this.selectedSwapCourse.weekday}${this.selectedSwapCourse.period} 課程互換`,
                createdAt: new Date().toISOString()
            };

            // 儲存並處理
            await this.saveAndProcessRecord(record);
        }
    }

    /**
     * 確認多節課代課
     */
    async confirmMultiCourseSubstitute(date, changeType) {
        // 驗證代課教師
        if (!this.selectedSubstitute) {
            this.scrollToAndHighlight('recommendation-list', '請選擇代課教師');
            return;
        }

        const leaveType = document.getElementById('leave-type').value;
        const paidLeaveTypes = ['official', 'longsick', 'funeral'];
        const reason = document.getElementById('sub-reason').value.trim();

        // 驗證所有課程的星期是否與日期相符
        const dateWeekday = this.getDateWeekday(date);
        const mismatchCourses = this.selectedCourses.filter(c => c.weekday !== dateWeekday);
        if (mismatchCourses.length > 0) {
            const mismatchList = mismatchCourses.map(c => `${c.period}（${c.weekday}）`).join('、');
            alert(`以下課程的星期與日期不符：\n${mismatchList}\n\n選擇的日期是「${dateWeekday}」，請重新選擇課程或調整日期。`);
            return;
        }

        // 按節次排序
        const sortedCourses = [...this.selectedCourses].sort((a, b) => {
            const periodOrder = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節'];
            return periodOrder.indexOf(a.period) - periodOrder.indexOf(b.period);
        });

        // 建立多節課紀錄（使用相同的基礎 ID）
        const baseId = Date.now().toString();
        const records = sortedCourses.map((course, index) => ({
            id: `${baseId}_${index}`,
            type: '代課',
            date: date,
            weekday: course.weekday,
            period: course.period,
            className: course.className,
            subject: course.subject,
            domain: course.domain,
            originalTeacher: course.originalTeacher,
            substituteTeacher: this.selectedSubstitute.teacher.name,
            leaveType: this.getLeaveTypeName(leaveType),
            leaveTypeName: this.getLeaveTypeName(leaveType),
            docNumber: paidLeaveTypes.includes(leaveType) ? document.getElementById('doc-number').value.trim() : '',
            reason: reason,
            createdAt: new Date().toISOString(),
            // 多節課標記
            isMultiCourse: true,
            multiCourseGroupId: baseId,
            multiCourseIndex: index,
            multiCourseTotal: sortedCourses.length
        }));

        // 儲存所有紀錄
        for (const record of records) {
            this.dataManager.addSubstituteRecord(record);
        }
        this.saveDataToStorage();

        // 生成多節課 PDF（一次性）
        await this.generateMultiCoursePDF(records, sortedCourses);

        // 完全重置流程
        this.resetSubstituteFlow();

        // 顯示結果
        const syncText = isSignedIn() ? '並同步到雲端' : '';
        alert(`已完成 ${records.length} 節課的代課申請${syncText}，PDF 已生成`);
    }

    /**
     * 儲存並處理紀錄
     */
    async saveAndProcessRecord(record) {
        // 儲存紀錄到本地（會自動同步到 Firebase 雲端）
        this.dataManager.addSubstituteRecord(record);
        this.saveDataToStorage();

        // 生成 PDF
        await this.generateSubstitutePDF(record);

        // 完全重置流程
        this.resetSubstituteFlow();

        // 顯示結果
        const typeText = record.type === '調課' ? '調課' : '代課';
        const syncText = isSignedIn() ? '並同步到雲端' : '';
        alert(`${typeText}紀錄已儲存${syncText}，PDF 已生成`);
    }

    /**
     * 取得假別名稱
     */
    getLeaveTypeName(leaveType) {
        const leaveTypeNames = {
            'official': '公假',
            'longsick': '長期病假',
            'funeral': '喪假',
            'personal': '事假',
            'sick': '病假',
            'rest': '休假',
            'other': '其他',
            'swap': '調課'
        };
        return leaveTypeNames[leaveType] || leaveType;
    }

    /**
     * 將中文星期轉換為數字（0=週日, 1=週一, ..., 6=週六）
     * @param {string} weekday - 中文星期（如：週一、週二）
     * @returns {number} 星期數字
     */
    weekdayToNumber(weekday) {
        const weekdayMap = {
            '週日': 0, '週一': 1, '週二': 2, '週三': 3,
            '週四': 4, '週五': 5, '週六': 6,
            '星期日': 0, '星期一': 1, '星期二': 2, '星期三': 3,
            '星期四': 4, '星期五': 5, '星期六': 6
        };
        return weekdayMap[weekday] ?? -1;
    }

    /**
     * 將數字轉換為中文星期
     * @param {number} dayNumber - 星期數字（0-6）
     * @returns {string} 中文星期
     */
    numberToWeekday(dayNumber) {
        const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
        return weekdays[dayNumber] || '';
    }

    /**
     * 取得日期對應的星期
     * @param {string} dateString - 日期字串（YYYY-MM-DD）
     * @returns {string} 中文星期
     */
    getDateWeekday(dateString) {
        const date = new Date(dateString);
        return this.numberToWeekday(date.getDay());
    }

    /**
     * 驗證日期與星期是否相符
     * @param {string} dateString - 日期字串（YYYY-MM-DD）
     * @param {string} weekday - 中文星期
     * @returns {boolean} 是否相符
     */
    validateDateWeekday(dateString, weekday) {
        const dateWeekday = this.getDateWeekday(dateString);
        return dateWeekday === weekday;
    }

    /**
     * 找到最近符合指定星期的日期
     * @param {string} weekday - 中文星期
     * @param {string} baseDate - 基準日期（YYYY-MM-DD），預設為今天
     * @returns {string} 符合的日期（YYYY-MM-DD）
     */
    findNextMatchingDate(weekday, baseDate = null) {
        const targetDay = this.weekdayToNumber(weekday);
        if (targetDay === -1) return baseDate;

        const base = baseDate ? new Date(baseDate) : new Date();
        const currentDay = base.getDay();

        // 計算需要加的天數
        let daysToAdd = targetDay - currentDay;
        if (daysToAdd < 0) {
            daysToAdd += 7; // 如果目標星期已過，找下一週
        }

        const resultDate = new Date(base);
        resultDate.setDate(resultDate.getDate() + daysToAdd);

        // 格式化為 YYYY-MM-DD
        return resultDate.toISOString().split('T')[0];
    }

    /**
     * 選擇課程後清空日期，強制用戶手動選取
     */
    clearDateAndPrompt() {
        if (!this.selectedCourse) return;

        const courseWeekday = this.selectedCourse.weekday;
        const currentDate = document.getElementById('sub-date').value;

        // 如果當前日期已符合課程星期，則不清空
        if (currentDate && this.validateDateWeekday(currentDate, courseWeekday)) {
            // 隱藏任何警告
            const warning = document.getElementById('date-weekday-warning');
            if (warning) warning.style.display = 'none';
            return;
        }

        // 清空日期欄位
        document.getElementById('sub-date').value = '';

        // 顯示必須選擇對應星期的提示
        this.showDateSelectionPrompt(courseWeekday);
    }

    /**
     * 顯示日期已調整的提示
     */
    showDateAdjustmentHint(weekday, newDate) {
        const formattedDate = new Date(newDate).toLocaleDateString('zh-TW', {
            year: 'numeric', month: 'long', day: 'numeric'
        });
        console.log(`日期已調整為 ${formattedDate}（${weekday}）`);
    }

    /**
     * 顯示日期選擇提示
     */
    showDateSelectionPrompt(weekday) {
        // 建立或更新提示元素
        let hint = document.getElementById('date-adjustment-hint');
        if (!hint) {
            hint = document.createElement('p');
            hint.id = 'date-adjustment-hint';
            hint.className = 'hint';
            const dateInput = document.getElementById('sub-date');
            dateInput.parentNode.appendChild(hint);
        }
        hint.style.color = '#2563eb';
        hint.style.fontWeight = 'bold';
        hint.style.backgroundColor = '#eff6ff';
        hint.style.padding = '8px';
        hint.style.borderRadius = '4px';
        hint.style.marginTop = '8px';
        hint.innerHTML = `📅 請選擇「<strong>${weekday}</strong>」的日期`;
        hint.style.display = 'block';
    }

    /**
     * 當日期變更時觸發，即時驗證日期與星期是否相符
     */
    onDateChanged() {
        if (!this.selectedCourse) return;

        const date = document.getElementById('sub-date').value;
        if (!date) return;

        const courseWeekday = this.selectedCourse.weekday;
        const dateWeekday = this.getDateWeekday(date);

        // 取得或建立警告元素
        let warning = document.getElementById('date-weekday-warning');
        if (!warning) {
            warning = document.createElement('p');
            warning.id = 'date-weekday-warning';
            warning.className = 'hint';
            warning.style.color = '#dc2626';
            warning.style.fontWeight = 'bold';
            warning.style.backgroundColor = '#fef2f2';
            warning.style.padding = '8px';
            warning.style.borderRadius = '4px';
            warning.style.marginTop = '8px';
            const dateInput = document.getElementById('sub-date');
            dateInput.parentNode.appendChild(warning);
        }

        // 隱藏選擇提示
        const hint = document.getElementById('date-adjustment-hint');

        if (dateWeekday !== courseWeekday) {
            const formattedDate = new Date(date).toLocaleDateString('zh-TW', {
                year: 'numeric', month: 'long', day: 'numeric'
            });
            warning.innerHTML = `⚠️ 日期不符：${formattedDate} 是「${dateWeekday}」，但課程是「${courseWeekday}」的課`;
            warning.style.display = 'block';
            if (hint) hint.style.display = 'none';
        } else {
            warning.style.display = 'none';
            // 日期正確，隱藏提示並顯示確認訊息
            if (hint) {
                const formattedDate = new Date(date).toLocaleDateString('zh-TW', {
                    year: 'numeric', month: 'long', day: 'numeric'
                });
                hint.innerHTML = `✅ ${formattedDate}（${courseWeekday}）`;
                hint.style.color = '#16a34a';
                hint.style.backgroundColor = '#f0fdf4';
            }
        }
    }

    /**
     * 取消調課（重新選擇）
     */
    cancelSubstitute() {
        this.selectedCourse = null;
        this.selectedSubstitute = null;
        this.selectedSwapCourse = null;

        // 隱藏步驟四
        document.getElementById('selected-course-info').classList.add('hidden');

        // 清除課程選擇狀態
        document.querySelectorAll('.schedule-course.selected').forEach(c => c.classList.remove('selected'));

        // 重置表單欄位
        document.getElementById('sub-reason').value = '';
        document.getElementById('swap-course').innerHTML = '<option value="">請選擇要互換的課程</option>';
        document.getElementById('swap-validation-error').classList.add('hidden');
        document.getElementById('swap-preview').classList.add('hidden');
        document.querySelectorAll('.recommendation-item.selected').forEach(i => i.classList.remove('selected'));

        // 注意：不重置教師、日期、異動類型和假別，讓用戶可以快速重新選擇課程
    }

    /**
     * 完全重置調代課流程
     */
    resetSubstituteFlow() {
        this.selectedCourse = null;
        this.selectedSubstitute = null;
        this.selectedSwapCourse = null;

        // 重置所有步驟
        document.getElementById('sub-teacher').value = '';
        document.getElementById('sub-date').value = new Date().toISOString().split('T')[0];

        // 隱藏步驟二、三、四
        document.getElementById('step-change-type').classList.add('hidden');
        document.getElementById('step-select-course').classList.add('hidden');
        document.getElementById('selected-course-info').classList.add('hidden');

        // 重置異動類型為代課
        const substituteRadio = document.querySelector('input[name="change-type-radio"][value="substitute"]');
        if (substituteRadio) {
            substituteRadio.checked = true;
        }
        document.getElementById('change-type').value = 'substitute';

        // 重置日期標籤提示
        const dateLabelHint = document.getElementById('date-label-hint');
        if (dateLabelHint) {
            dateLabelHint.textContent = '';
        }

        // 重置假別和表單欄位
        document.getElementById('leave-type').value = '';
        document.getElementById('doc-number').value = '';
        document.getElementById('doc-number-group').style.display = 'none';
        document.getElementById('sub-reason').value = '';

        // 重置選項顯示
        document.getElementById('substitute-options-early').classList.remove('hidden');
        document.getElementById('substitute-options').classList.remove('hidden');
        document.getElementById('swap-options').classList.add('hidden');

        // 重置調課相關欄位
        const swapDate = document.getElementById('swap-date');
        if (swapDate) swapDate.value = '';
        const swapDateHint = document.getElementById('swap-date-hint');
        if (swapDateHint) swapDateHint.textContent = '';
        const swapSlotAInfo = document.getElementById('swap-slot-a-info');
        if (swapSlotAInfo) swapSlotAInfo.innerHTML = '';

        document.getElementById('swap-course').innerHTML = '<option value="">請先選擇時段 B 日期</option>';
        document.getElementById('swap-validation-error').classList.add('hidden');
        document.getElementById('swap-preview').classList.add('hidden');

        // 清除課程選擇狀態
        document.querySelectorAll('.schedule-course.selected').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.schedule-course.multi-selected').forEach(c => c.classList.remove('multi-selected'));
        document.querySelectorAll('.recommendation-item.selected').forEach(i => i.classList.remove('selected'));

        // 重置多節課模式
        this.selectedCourses = [];
        this.isMultiCourseMode = false;
        const multiCourseToggle = document.getElementById('multi-course-mode');
        if (multiCourseToggle) {
            multiCourseToggle.checked = false;
        }
        const multiCourseHint = document.getElementById('multi-course-hint');
        if (multiCourseHint) {
            multiCourseHint.classList.add('hidden');
        }
        const selectedCoursesList = document.getElementById('selected-courses-list');
        if (selectedCoursesList) {
            selectedCoursesList.classList.add('hidden');
        }

        // 重置摘要顯示
        const singleSummary = document.getElementById('single-course-summary');
        const multiSummary = document.getElementById('multi-course-summary');
        if (singleSummary) singleSummary.classList.remove('hidden');
        if (multiSummary) multiSummary.classList.add('hidden');

        // 重新啟用調課選項
        const swapRadio = document.querySelector('input[name="change-type-radio"][value="swap"]');
        if (swapRadio) {
            swapRadio.disabled = false;
            swapRadio.closest('.change-type-option').style.opacity = '1';
            swapRadio.closest('.change-type-option').title = '';
        }
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
     * 生成多節課代課單 PDF
     * @param {Array} records - 多節課紀錄陣列
     * @param {Array} courses - 排序後的課程陣列
     */
    async generateMultiCoursePDF(records, courses) {
        const scheduleData = this.dataManager.getScheduleData();
        const teachers = this.dataManager.getTeachers();

        // 使用 PDF 生成器的多節課方法
        await this.pdfGenerator.generateMultiCourseForm(records, courses, scheduleData, teachers);
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

        // 公付假別顯示字號/證明
        const paidLeaveNames = ['公假', '長期病假', '喪假'];
        if (paidLeaveNames.includes(record.leaveType) && record.docNumber) {
            const labelText = record.leaveType === '公假' ? '公假字號' :
                              record.leaveType === '長期病假' ? '核准文號' : '喪假證明';
            detailHtml += `
                <div class="detail-row">
                    <span class="detail-label">${labelText}</span>
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
     * 綁定資料管理事件
     */
    bindDataManagementEvents() {
        // 匯出本機資料按鈕
        document.getElementById('export-local-data-btn')?.addEventListener('click', () => {
            this.exportLocalData();
        });

        // 清除所有資料按鈕
        document.getElementById('clear-local-data-btn')?.addEventListener('click', () => {
            this.clearLocalData();
        });

        // 匯入資料按鈕
        document.getElementById('import-local-data-btn')?.addEventListener('click', () => {
            document.getElementById('import-data-file').click();
        });

        // 匯入檔案選擇
        document.getElementById('import-data-file')?.addEventListener('change', (e) => {
            this.handleImportFile(e.target.files[0]);
        });

        // 確認匯入按鈕
        document.getElementById('confirm-import-btn')?.addEventListener('click', () => {
            this.confirmImport();
        });

        // 取消匯入按鈕
        document.getElementById('cancel-import-btn')?.addEventListener('click', () => {
            this.cancelImport();
        });
    }

    /**
     * 匯出本機資料
     */
    exportLocalData() {
        const data = this.dataManager.exportToStorage();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `調代課系統備份_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert('資料已匯出');
    }

    /**
     * 清除所有本機資料
     */
    clearLocalData() {
        if (confirm('確定要清除所有本機資料嗎？此操作無法復原！\n\n建議先使用「匯出本機資料」進行備份。')) {
            if (confirm('再次確認：清除所有資料？')) {
                localStorage.removeItem('substituteSystemData');
                localStorage.removeItem('gasUrl');
                alert('所有資料已清除，頁面將重新載入');
                location.reload();
            }
        }
    }

    /**
     * 處理匯入檔案
     * @param {File} file - 選擇的檔案
     */
    handleImportFile(file) {
        if (!file) return;

        // 檢查檔案類型
        if (!file.name.endsWith('.json')) {
            alert('請選擇 JSON 格式的備份檔案');
            return;
        }

        // 顯示檔案名稱
        document.getElementById('import-filename').textContent = file.name;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                this.validateAndPreviewImport(data);
            } catch (error) {
                alert('檔案格式錯誤，無法解析 JSON');
                this.cancelImport();
            }
        };
        reader.onerror = () => {
            alert('檔案讀取失敗');
            this.cancelImport();
        };
        reader.readAsText(file);
    }

    /**
     * 驗證並預覽匯入資料
     * @param {Object} data - 匯入的資料
     */
    validateAndPreviewImport(data) {
        // 驗證資料結構
        const requiredFields = ['scheduleData', 'teachers', 'classes', 'substituteRecords'];
        const missingFields = requiredFields.filter(field => !data.hasOwnProperty(field));

        if (missingFields.length > 0) {
            alert(`備份檔案格式不正確，缺少欄位：${missingFields.join(', ')}`);
            this.cancelImport();
            return;
        }

        // 儲存待匯入的資料
        this.pendingImportData = data;

        // 顯示預覽
        const statsHtml = `
            <div class="import-stat-item">
                <span class="label">學校名稱</span>
                <span class="value">${data.schoolName || '（未設定）'}</span>
            </div>
            <div class="import-stat-item">
                <span class="label">課表資料</span>
                <span class="value">${data.scheduleData?.length || 0} 筆</span>
            </div>
            <div class="import-stat-item">
                <span class="label">教師數量</span>
                <span class="value">${data.teachers?.length || 0} 位</span>
            </div>
            <div class="import-stat-item">
                <span class="label">班級數量</span>
                <span class="value">${data.classes?.length || 0} 班</span>
            </div>
            <div class="import-stat-item">
                <span class="label">調代課紀錄</span>
                <span class="value">${data.substituteRecords?.length || 0} 筆</span>
            </div>
        `;

        document.getElementById('import-stats').innerHTML = statsHtml;
        document.getElementById('import-preview').classList.remove('hidden');
    }

    /**
     * 確認匯入資料
     */
    confirmImport() {
        if (!this.pendingImportData) {
            alert('沒有待匯入的資料');
            return;
        }

        if (!confirm('確定要匯入資料嗎？\n\n此操作將覆蓋目前的所有資料（課表、教師、調代課紀錄）。\n\n建議先匯出目前的資料作為備份。')) {
            return;
        }

        try {
            // 載入資料到 DataManager
            this.dataManager.loadFromStorage(this.pendingImportData);

            // 儲存到 localStorage
            this.saveData();

            // 重新整理頁面顯示
            alert('資料匯入成功！頁面將重新載入以套用變更。');
            location.reload();
        } catch (error) {
            console.error('匯入失敗:', error);
            alert('匯入失敗：' + error.message);
        }
    }

    /**
     * 取消匯入
     */
    cancelImport() {
        this.pendingImportData = null;
        document.getElementById('import-data-file').value = '';
        document.getElementById('import-filename').textContent = '';
        document.getElementById('import-preview').classList.add('hidden');
    }

    // ===================================
    // 課表編輯器相關方法
    // ===================================

    /**
     * 綁定課表編輯器事件
     */
    bindScheduleEditorEvents() {
        // 教師選擇變更
        document.getElementById('editor-teacher-select')?.addEventListener('change', (e) => {
            this.onEditorTeacherChanged(e.target.value);
        });

        // 新增教師按鈕
        document.getElementById('editor-add-teacher-btn')?.addEventListener('click', () => {
            document.getElementById('editor-new-teacher-form').classList.remove('hidden');
            document.getElementById('editor-new-teacher-name').value = '';
            document.getElementById('editor-new-teacher-homeroom').value = '';
            document.getElementById('editor-new-teacher-name').focus();
        });

        // 確認新增教師
        document.getElementById('editor-confirm-add-teacher-btn')?.addEventListener('click', () => {
            this.editorAddNewTeacher();
        });

        // 取消新增教師
        document.getElementById('editor-cancel-add-teacher-btn')?.addEventListener('click', () => {
            document.getElementById('editor-new-teacher-form').classList.add('hidden');
        });

        // Enter 鍵確認新增教師
        document.getElementById('editor-new-teacher-name')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.editorAddNewTeacher();
        });

        // 儲存課表按鈕
        document.getElementById('editor-save-schedule-btn')?.addEventListener('click', () => {
            this.editorSaveSchedule();
        });

        // 刪除教師按鈕
        document.getElementById('editor-delete-teacher-btn')?.addEventListener('click', () => {
            this.editorDeleteTeacher();
        });

        // 課程編輯對話框事件
        document.getElementById('close-course-modal-btn')?.addEventListener('click', () => {
            this.closeCourseEditModal();
        });

        document.getElementById('course-modal-save-btn')?.addEventListener('click', () => {
            this.editorSaveCourse();
        });

        document.getElementById('course-modal-delete-btn')?.addEventListener('click', () => {
            this.editorDeleteCourse();
        });

        document.getElementById('course-modal-cancel-btn')?.addEventListener('click', () => {
            this.closeCourseEditModal();
        });

        // 點擊 modal 外部關閉
        document.getElementById('course-edit-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'course-edit-modal') this.closeCourseEditModal();
        });
    }

    /**
     * 填充課表編輯器教師下拉選單
     */
    populateEditorTeacherDropdown() {
        const teachers = this.dataManager.getTeachers();
        const select = document.getElementById('editor-teacher-select');
        if (!select) return;

        const currentValue = select.value;
        const options = teachers.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
        select.innerHTML = '<option value="">請選擇教師</option>' + options;

        // 恢復之前的選擇
        if (currentValue && teachers.some(t => t.name === currentValue)) {
            select.value = currentValue;
        }
    }

    /**
     * 課表編輯器：教師選擇變更
     */
    onEditorTeacherChanged(teacherName) {
        const scheduleSection = document.getElementById('editor-schedule-section');

        if (!teacherName) {
            scheduleSection.classList.add('hidden');
            this.editorCurrentTeacher = null;
            return;
        }

        this.editorCurrentTeacher = teacherName;
        scheduleSection.classList.remove('hidden');

        // 更新教師名稱顯示
        document.getElementById('editor-teacher-name-display').textContent = teacherName;

        // 渲染可編輯的週課表
        this.renderEditableScheduleGrid();
    }

    /**
     * 渲染可編輯的週課表
     */
    renderEditableScheduleGrid() {
        const grid = document.getElementById('editor-schedule-grid');
        if (!grid || !this.editorCurrentTeacher) return;

        const teacherName = this.editorCurrentTeacher;
        const weekSchedule = this.dataManager.getTeacherWeekSchedule(teacherName);
        const days = ['一', '二', '三', '四', '五'];
        const periods = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節'];

        let html = '';

        // 標題列
        html += '<div class="schedule-cell schedule-header">節次</div>';
        days.forEach(day => {
            html += `<div class="schedule-cell schedule-header">週${day}</div>`;
        });

        // 各節次
        periods.forEach(period => {
            html += `<div class="schedule-cell schedule-period">${period}</div>`;

            days.forEach(day => {
                const dayName = '週' + day;
                const courses = weekSchedule.filter(c =>
                    c.weekday === dayName && c.period === period
                );

                if (courses.length > 0) {
                    const course = courses[0];
                    html += `
                        <div class="schedule-cell editor-course"
                             data-weekday="${dayName}"
                             data-period="${period}"
                             data-class="${course.className}"
                             data-subject="${course.subject}"
                             data-domain="${course.domain || ''}"
                             title="點擊編輯：${course.className} ${course.subject}">
                            <span class="course-class">${course.className}</span>
                            <span class="course-subject">${course.subject}</span>
                        </div>
                    `;
                } else {
                    html += `
                        <div class="schedule-cell editor-empty"
                             data-weekday="${dayName}"
                             data-period="${period}"
                             title="點擊新增課程">
                        </div>
                    `;
                }
            });
        });

        grid.innerHTML = html;

        // 更新每週節數
        document.getElementById('editor-weekly-hours').textContent = weekSchedule.length;

        // 綁定格子點擊事件
        grid.querySelectorAll('.editor-empty').forEach(cell => {
            cell.addEventListener('click', () => {
                this.openCourseEditModal(cell.dataset.weekday, cell.dataset.period, false);
            });
        });

        grid.querySelectorAll('.editor-course').forEach(cell => {
            cell.addEventListener('click', () => {
                this.openCourseEditModal(
                    cell.dataset.weekday,
                    cell.dataset.period,
                    true,
                    {
                        className: cell.dataset.class,
                        subject: cell.dataset.subject,
                        domain: cell.dataset.domain
                    }
                );
            });
        });
    }

    /**
     * 開啟課程編輯對話框
     */
    openCourseEditModal(weekday, period, isEdit, courseData = null) {
        this.editorEditingCell = { weekday, period };
        this.editorIsEditMode = isEdit;

        const modal = document.getElementById('course-edit-modal');
        const title = document.getElementById('course-modal-title');
        const slotInfo = document.getElementById('course-modal-slot-info');
        const deleteBtn = document.getElementById('course-modal-delete-btn');

        // 設定標題與時段資訊
        title.textContent = isEdit ? '編輯課程' : '新增課程';
        slotInfo.textContent = `${weekday} ${period}`;

        // 填充班級 datalist
        const datalist = document.getElementById('class-datalist');
        const classes = this.dataManager.getClasses();
        datalist.innerHTML = classes.map(c => `<option value="${c}">`).join('');

        // 填充表單
        if (isEdit && courseData) {
            document.getElementById('course-modal-class').value = courseData.className || '';
            document.getElementById('course-modal-subject').value = courseData.subject || '';
            document.getElementById('course-modal-domain').value = courseData.domain || '';
            deleteBtn.style.display = 'inline-block';
        } else {
            document.getElementById('course-modal-class').value = '';
            document.getElementById('course-modal-subject').value = '';
            document.getElementById('course-modal-domain').value = '';
            deleteBtn.style.display = 'none';
        }

        modal.classList.remove('hidden');
        document.getElementById('course-modal-class').focus();
    }

    /**
     * 關閉課程編輯對話框
     */
    closeCourseEditModal() {
        document.getElementById('course-edit-modal').classList.add('hidden');
        this.editorEditingCell = null;
    }

    /**
     * 課表編輯器：儲存課程（新增或更新）
     */
    editorSaveCourse() {
        if (!this.editorEditingCell) return;

        const className = document.getElementById('course-modal-class').value.trim();
        const subject = document.getElementById('course-modal-subject').value.trim();
        const domain = document.getElementById('course-modal-domain').value;

        if (!className) {
            alert('請輸入班級');
            return;
        }
        if (!subject) {
            alert('請輸入科目');
            return;
        }

        const { weekday, period } = this.editorEditingCell;
        const teacherName = this.editorCurrentTeacher;

        if (this.editorIsEditMode) {
            // 更新現有課程
            this.dataManager.updateScheduleEntry(teacherName, weekday, period, {
                className,
                subject,
                rawSubject: subject,
                courseName: subject,
                domain
            });
        } else {
            // 新增課程
            this.dataManager.addScheduleEntry({
                weekday,
                period,
                className,
                teacher: teacherName,
                domain,
                subject,
                rawSubject: subject,
                courseName: subject
            });
        }

        // 更新班級清單
        this.dataManager.refreshClasses();

        // 更新教師領域
        this.dataManager.refreshTeacherDomains(teacherName);

        // 關閉對話框並重新渲染
        this.closeCourseEditModal();
        this.renderEditableScheduleGrid();

        // 自動儲存
        this.saveDataToStorage();

        // 更新其他頁籤的下拉選單和狀態
        this.updateTeacherTable();
        this.populateTeacherDropdowns();
        this.updateScheduleStatusFromData();
        this.updateTabLockStatus();
        this.updateTabContentVisibility();
    }

    /**
     * 課表編輯器：刪除課程
     */
    editorDeleteCourse() {
        if (!this.editorEditingCell) return;
        const { weekday, period } = this.editorEditingCell;
        const teacherName = this.editorCurrentTeacher;

        if (!confirm(`確定要刪除 ${weekday} ${period} 的課程嗎？`)) {
            return;
        }

        this.dataManager.removeScheduleEntry(teacherName, weekday, period);

        // 更新班級清單
        this.dataManager.refreshClasses();

        // 更新教師領域
        this.dataManager.refreshTeacherDomains(teacherName);

        // 關閉對話框並重新渲染
        this.closeCourseEditModal();
        this.renderEditableScheduleGrid();

        // 自動儲存
        this.saveDataToStorage();

        // 更新其他頁籤
        this.updateTeacherTable();
        this.populateTeacherDropdowns();
        this.updateScheduleStatusFromData();
        this.updateTabLockStatus();
        this.updateTabContentVisibility();
    }

    /**
     * 課表編輯器：新增教師
     */
    editorAddNewTeacher() {
        const nameInput = document.getElementById('editor-new-teacher-name');
        const homeroomInput = document.getElementById('editor-new-teacher-homeroom');
        const name = nameInput.value.trim();
        const homeroom = homeroomInput.value.trim();

        if (!name) {
            alert('請輸入教師姓名');
            nameInput.focus();
            return;
        }

        // 檢查是否已存在
        if (this.dataManager.getTeacherByName(name)) {
            alert('此教師已存在，請直接從選單中選擇');
            return;
        }

        // 新增教師
        this.dataManager.addTeacher({
            name,
            domains: [],
            homeroomClass: homeroom
        });

        // 儲存
        this.saveDataToStorage();

        // 隱藏新增表單
        document.getElementById('editor-new-teacher-form').classList.add('hidden');

        // 更新所有下拉選單
        this.populateEditorTeacherDropdown();
        this.populateTeacherDropdowns();
        this.updateTeacherTable();

        // 自動選擇新教師
        document.getElementById('editor-teacher-select').value = name;
        this.onEditorTeacherChanged(name);

        // 顯示教師編輯區域（如果還沒顯示）
        document.getElementById('teacher-editor').classList.remove('hidden');

        // 如果沒有學校名稱，提示設定
        if (!this.dataManager.getSchoolName()) {
            const schoolNameSection = document.getElementById('school-name-section');
            schoolNameSection?.classList.remove('hidden');
            document.getElementById('school-name-warning')?.classList.remove('hidden');
        }
    }

    /**
     * 課表編輯器：刪除教師
     */
    editorDeleteTeacher() {
        const teacherName = this.editorCurrentTeacher;
        if (!teacherName) return;

        const weeklyHours = this.dataManager.getTeacherWeeklyHours(teacherName);
        const confirmMsg = weeklyHours > 0
            ? `確定要刪除教師「${teacherName}」嗎？\n該教師有 ${weeklyHours} 節課將一併刪除。`
            : `確定要刪除教師「${teacherName}」嗎？`;

        if (!confirm(confirmMsg)) return;

        // 刪除該教師的所有課表資料
        const scheduleData = this.dataManager.getScheduleData();
        const filtered = scheduleData.filter(c => c.teacher !== teacherName);
        this.dataManager.setScheduleData(filtered);

        // 刪除教師
        const teachers = this.dataManager.getTeachers();
        const index = teachers.findIndex(t => t.name === teacherName);
        if (index !== -1) {
            this.dataManager.removeTeacher(index);
        }

        // 更新班級清單
        this.dataManager.refreshClasses();

        // 儲存
        this.saveDataToStorage();

        // 重置編輯器
        this.editorCurrentTeacher = null;
        document.getElementById('editor-schedule-section').classList.add('hidden');
        document.getElementById('editor-teacher-select').value = '';

        // 更新所有相關 UI
        this.populateEditorTeacherDropdown();
        this.populateTeacherDropdowns();
        this.updateTeacherTable();
        this.updateScheduleStatusFromData();
        this.updateTabLockStatus();
        this.updateTabContentVisibility();
    }

    /**
     * 課表編輯器：儲存課表（手動觸發）
     */
    editorSaveSchedule() {
        this.saveDataToStorage();

        const statusDiv = document.getElementById('editor-save-status');
        statusDiv.classList.remove('hidden');
        statusDiv.style.color = '#22c55e';
        statusDiv.textContent = '✓ 課表已儲存（' + new Date().toLocaleTimeString() + '）';

        setTimeout(() => {
            statusDiv.classList.add('hidden');
        }, 3000);
    }

    /**
     * 根據現有資料更新匯入狀態顯示
     */
    updateScheduleStatusFromData() {
        const scheduleData = this.dataManager.getScheduleData();
        const teachers = this.dataManager.getTeachers();
        const classes = this.dataManager.getClasses();

        if (scheduleData.length > 0) {
            const statusBox = document.getElementById('schedule-status');
            statusBox.classList.remove('hidden', 'error');
            document.getElementById('class-count').textContent = classes.length;
            document.getElementById('teacher-count').textContent = teachers.length;
            document.getElementById('course-count').textContent = scheduleData.length;
            document.getElementById('teacher-editor').classList.remove('hidden');
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

        // 設定預設月份為上個月
        const now = new Date();
        let lastMonth = now.getMonth(); // getMonth() 是 0-11，所以當月減1就是上個月的 1-12 表示
        if (lastMonth === 0) {
            lastMonth = 12; // 如果是1月，上個月是12月
        }
        document.getElementById('settle-month').value = lastMonth;
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

                    // 顯示學校名稱設定區塊
                    const schoolNameSection = document.getElementById('school-name-section');
                    const schoolNameInput = document.getElementById('school-name');
                    schoolNameSection.classList.remove('hidden');

                    if (data.schoolName) {
                        // 已有儲存的學校名稱
                        schoolNameInput.value = data.schoolName;
                        this.pdfGenerator.setSchoolName(data.schoolName);
                        this.showSchoolNameConfirmed();
                    } else {
                        // 無學校名稱，顯示警告
                        document.getElementById('school-name-warning').classList.remove('hidden');
                    }

                    // 更新頁籤鎖定狀態
                    this.updateTabLockStatus();

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
     * @param {boolean} syncToCloud - 是否同步到雲端，預設為 true
     */
    saveDataToStorage(syncToCloud = true) {
        // 更新最後修改時間
        this.dataManager.updateLastModified();

        const data = this.dataManager.exportToStorage();
        localStorage.setItem('substituteSystemData', JSON.stringify(data));

        // 如果已登入且需要同步，則同步到雲端
        if (syncToCloud && isSignedIn()) {
            this.dataManager.syncToCloud().catch(error => {
                console.error('雲端同步失敗:', error);
            });
        }
    }

    /**
     * 手動儲存資料（按鈕觸發）
     */
    saveDataManually() {
        this.saveDataToStorage();

        const statusDiv = document.getElementById('save-status');
        statusDiv.classList.remove('hidden', 'error');
        statusDiv.classList.add('success');

        const syncText = isSignedIn() ? '（已同步到雲端）' : '';
        statusDiv.textContent = '✓ 資料已儲存' + syncText + '（' + new Date().toLocaleTimeString() + '）';

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
        const hasSchoolName = !!this.dataManager.getSchoolName();
        const isConfigured = hasData && hasSchoolName;

        // 調代課申請頁籤
        const substituteNoData = document.getElementById('substitute-no-data');
        const substituteContent = document.getElementById('substitute-content');
        if (substituteNoData && substituteContent) {
            if (isConfigured) {
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
            if (isConfigured) {
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
            if (isConfigured) {
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
