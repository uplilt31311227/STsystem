/**
 * 雲端同步服務模組
 *
 * 負責：
 * - Firestore 資料讀寫
 * - 即時同步監聽
 * - 衝突解決邏輯
 * - 同步狀態管理
 */

import { getDbInstance, isFirebaseInitialized } from './firebaseConfig.js';
import { getUserId, isSignedIn } from './authService.js';

// 同步狀態
const SyncStatus = {
    SYNCED: 'synced',      // 已同步
    SYNCING: 'syncing',    // 同步中
    PENDING: 'pending',    // 待同步
    ERROR: 'error',        // 同步失敗
    OFFLINE: 'offline'     // 離線
};

// 當前同步狀態
let currentSyncStatus = SyncStatus.SYNCED;

// 同步狀態變更回調函數列表
const syncStatusCallbacks = [];

// 即時監聽取消函數
let unsubscribeSnapshot = null;

// 資料變更回調
let onDataChangeCallback = null;

// 上次同步時間
let lastSyncTime = null;

/**
 * 取得使用者的 Firestore 文件路徑
 * @returns {string|null}
 */
function getUserDocPath() {
    const userId = getUserId();
    if (!userId) return null;
    return `users/${userId}/data/substituteSystem`;
}

/**
 * 更新同步狀態
 * @param {string} status - 同步狀態
 */
function updateSyncStatus(status) {
    currentSyncStatus = status;
    syncStatusCallbacks.forEach(callback => {
        try {
            callback(status);
        } catch (error) {
            console.error('同步狀態回調執行錯誤:', error);
        }
    });
}

/**
 * 註冊同步狀態變更回調
 * @param {Function} callback - 回調函數
 * @returns {Function} 取消註冊函數
 */
function onSyncStatusChange(callback) {
    syncStatusCallbacks.push(callback);
    // 立即以當前狀態呼叫
    callback(currentSyncStatus);

    return () => {
        const index = syncStatusCallbacks.indexOf(callback);
        if (index > -1) {
            syncStatusCallbacks.splice(index, 1);
        }
    };
}

/**
 * 取得當前同步狀態
 * @returns {string}
 */
function getSyncStatus() {
    return currentSyncStatus;
}

/**
 * 上傳資料到雲端
 * @param {Object} data - 要同步的資料
 * @returns {Promise<boolean>}
 */
async function uploadToCloud(data) {
    if (!isFirebaseInitialized() || !isSignedIn()) {
        console.log('未登入或 Firebase 未初始化，無法同步');
        return false;
    }

    const docPath = getUserDocPath();
    if (!docPath) return false;

    updateSyncStatus(SyncStatus.SYNCING);

    try {
        const { doc, setDoc } = window.firebaseModules;
        const db = getDbInstance();

        const syncData = {
            ...data,
            lastModified: new Date().toISOString(),
            version: (data.version || 0) + 1
        };

        await setDoc(doc(db, docPath), syncData);

        lastSyncTime = new Date();
        updateSyncStatus(SyncStatus.SYNCED);
        console.log('資料已同步到雲端');
        return true;
    } catch (error) {
        console.error('上傳到雲端失敗:', error);
        updateSyncStatus(SyncStatus.ERROR);
        return false;
    }
}

/**
 * 從雲端下載資料
 * @returns {Promise<Object|null>}
 */
async function downloadFromCloud() {
    if (!isFirebaseInitialized() || !isSignedIn()) {
        console.log('未登入或 Firebase 未初始化，無法下載');
        return null;
    }

    const docPath = getUserDocPath();
    if (!docPath) return null;

    updateSyncStatus(SyncStatus.SYNCING);

    try {
        const { doc, getDoc } = window.firebaseModules;
        const db = getDbInstance();

        const docSnap = await getDoc(doc(db, docPath));

        if (docSnap.exists()) {
            const data = docSnap.data();
            lastSyncTime = new Date();
            updateSyncStatus(SyncStatus.SYNCED);
            console.log('已從雲端下載資料');
            return data;
        } else {
            console.log('雲端沒有資料');
            updateSyncStatus(SyncStatus.SYNCED);
            return null;
        }
    } catch (error) {
        console.error('從雲端下載失敗:', error);
        updateSyncStatus(SyncStatus.ERROR);
        return null;
    }
}

/**
 * 刪除目前登入使用者的 V1 個人雲端備份文件（users/{uid}/data/substituteSystem）。
 * V2「清除所有資料」原本只清 schools/{schoolId} 底下的全校資料，這份 V1 個人雲端備份完全
 * 不受影響——只要換一台裝置 / 換網址重新登入舊版頁面，dataManager 啟動時的
 * checkAndHandleSync（V2 模式下已停用，見 v2-app.js patchDataManager）以外的舊版流程仍會把
 * 這份文件整包讀回來，讓使用者覺得「清除所有資料」沒有清乾淨。
 * firestore.rules 對 users/{uid} 的規則是 `allow read, write: if ... uid == 自己`，
 * write 涵蓋 delete，因此直接刪除文件，不需要退而求其次改成覆寫空物件。
 * 只刪自己（目前登入 uid）的備份：rules 本來就無法刪到其他使用者的（uid 不符會被拒），
 * 呼叫端不需額外過濾。
 * @returns {Promise<boolean>} 未登入 / Firebase 未就緒時回傳 false 且不視為錯誤。
 */
async function deletePersonalCloudBackup() {
    if (!isFirebaseInitialized() || !isSignedIn()) {
        console.log('未登入或 Firebase 未初始化，無法刪除個人雲端備份');
        return false;
    }

    const docPath = getUserDocPath();
    if (!docPath) return false;

    const { doc, deleteDoc } = window.firebaseModules;
    const db = getDbInstance();
    await deleteDoc(doc(db, docPath));
    return true;
}

/**
 * 啟用即時同步
 * @param {Function} onDataChange - 資料變更回調
 * @returns {Function} 取消監聽函數
 */
function enableRealtimeSync(onDataChange) {
    if (!isFirebaseInitialized() || !isSignedIn()) {
        console.log('未登入或 Firebase 未初始化，無法啟用即時同步');
        return () => {};
    }

    const docPath = getUserDocPath();
    if (!docPath) return () => {};

    // 如果已有監聽，先取消
    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
    }

    onDataChangeCallback = onDataChange;

    try {
        const { doc, onSnapshot } = window.firebaseModules;
        const db = getDbInstance();

        unsubscribeSnapshot = onSnapshot(
            doc(db, docPath),
            (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    // 檢查是否是來自其他裝置的變更
                    const metadata = docSnap.metadata;
                    if (!metadata.hasPendingWrites) {
                        // 這是來自伺服器的變更
                        console.log('收到雲端資料變更');
                        lastSyncTime = new Date();
                        updateSyncStatus(SyncStatus.SYNCED);
                        if (onDataChangeCallback) {
                            onDataChangeCallback(data);
                        }
                    }
                }
            },
            (error) => {
                console.error('即時同步錯誤:', error);
                updateSyncStatus(SyncStatus.ERROR);
            }
        );

        console.log('即時同步已啟用');
        return () => {
            if (unsubscribeSnapshot) {
                unsubscribeSnapshot();
                unsubscribeSnapshot = null;
            }
        };
    } catch (error) {
        console.error('啟用即時同步失敗:', error);
        return () => {};
    }
}

/**
 * 停用即時同步
 */
function disableRealtimeSync() {
    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
        console.log('即時同步已停用');
    }
}

/**
 * 比較本機和雲端資料，決定同步策略
 * @param {Object} localData - 本機資料
 * @param {Object} cloudData - 雲端資料
 * @returns {Object} { action: 'upload'|'download'|'conflict'|'none', localData, cloudData }
 */
function compareData(localData, cloudData) {
    // 如果雲端沒有資料，上傳本機資料
    if (!cloudData) {
        return { action: 'upload', localData, cloudData: null };
    }

    // 如果本機沒有資料，下載雲端資料
    if (!localData || !localData.lastModified) {
        return { action: 'download', localData: null, cloudData };
    }

    // 比較最後修改時間
    const localTime = new Date(localData.lastModified).getTime();
    const cloudTime = new Date(cloudData.lastModified).getTime();

    // 如果相同，不需要同步
    if (localTime === cloudTime) {
        return { action: 'none', localData, cloudData };
    }

    // 如果有時間差，檢查內容是否相同
    const localRecordsCount = localData.substituteRecords?.length || 0;
    const cloudRecordsCount = cloudData.substituteRecords?.length || 0;

    // 如果兩邊都有資料且記錄數不同，可能有衝突
    if (localRecordsCount > 0 && cloudRecordsCount > 0 && localRecordsCount !== cloudRecordsCount) {
        return { action: 'conflict', localData, cloudData };
    }

    // 採用較新的資料
    if (localTime > cloudTime) {
        return { action: 'upload', localData, cloudData };
    } else {
        return { action: 'download', localData, cloudData };
    }
}

/**
 * 智慧合併資料（衝突解決）
 * @param {Object} localData - 本機資料
 * @param {Object} cloudData - 雲端資料
 * @returns {Object} 合併後的資料
 */
function mergeData(localData, cloudData) {
    // 建立記錄 ID 集合
    const localRecords = localData?.substituteRecords || [];
    const cloudRecords = cloudData?.substituteRecords || [];

    // 用 Map 進行去重合併
    const recordMap = new Map();

    // 先加入雲端記錄
    cloudRecords.forEach(record => {
        recordMap.set(record.id, record);
    });

    // 再加入本機記錄（覆蓋相同 ID）
    localRecords.forEach(record => {
        const existing = recordMap.get(record.id);
        if (!existing) {
            recordMap.set(record.id, record);
        } else {
            // 保留較新的記錄
            const existingTime = new Date(existing.createdAt || 0).getTime();
            const recordTime = new Date(record.createdAt || 0).getTime();
            if (recordTime > existingTime) {
                recordMap.set(record.id, record);
            }
        }
    });

    // 合併基本資料（使用較新的版本）
    const localTime = new Date(localData?.lastModified || 0).getTime();
    const cloudTime = new Date(cloudData?.lastModified || 0).getTime();
    const baseData = localTime > cloudTime ? localData : cloudData;

    return {
        ...baseData,
        substituteRecords: Array.from(recordMap.values()),
        lastModified: new Date().toISOString(),
        version: Math.max(localData?.version || 0, cloudData?.version || 0) + 1
    };
}

/**
 * 執行初始同步檢查
 * @param {Object} localData - 本機資料
 * @returns {Promise<{ action: string, data: Object|null }>}
 */
async function checkInitialSync(localData) {
    if (!isFirebaseInitialized() || !isSignedIn()) {
        return { action: 'none', data: null };
    }

    const cloudData = await downloadFromCloud();
    const comparison = compareData(localData, cloudData);

    return {
        action: comparison.action,
        localData: comparison.localData,
        cloudData: comparison.cloudData
    };
}

/**
 * 取得上次同步時間
 * @returns {Date|null}
 */
function getLastSyncTime() {
    return lastSyncTime;
}

/**
 * 格式化同步狀態顯示
 * @param {string} status - 同步狀態
 * @returns {Object} { icon, text, color }
 */
function formatSyncStatus(status) {
    const statusMap = {
        [SyncStatus.SYNCED]: { icon: '☁️', text: '已同步', color: '#22c55e' },
        [SyncStatus.SYNCING]: { icon: '🔄', text: '同步中', color: '#3b82f6' },
        [SyncStatus.PENDING]: { icon: '⚠️', text: '待同步', color: '#f59e0b' },
        [SyncStatus.ERROR]: { icon: '❌', text: '同步失敗', color: '#ef4444' },
        [SyncStatus.OFFLINE]: { icon: '📴', text: '離線', color: '#64748b' }
    };
    return statusMap[status] || statusMap[SyncStatus.SYNCED];
}

// 監聽網路狀態
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        console.log('網路已連線');
        if (currentSyncStatus === SyncStatus.OFFLINE) {
            updateSyncStatus(SyncStatus.PENDING);
        }
    });

    window.addEventListener('offline', () => {
        console.log('網路已斷線');
        updateSyncStatus(SyncStatus.OFFLINE);
    });
}

export {
    SyncStatus,
    uploadToCloud,
    downloadFromCloud,
    deletePersonalCloudBackup,
    enableRealtimeSync,
    disableRealtimeSync,
    compareData,
    mergeData,
    checkInitialSync,
    onSyncStatusChange,
    getSyncStatus,
    getLastSyncTime,
    formatSyncStatus
};
