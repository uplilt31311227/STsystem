/**
 * Firebase 設定模組
 *
 * 負責：
 * - 動態載入 Firebase SDK
 * - Firebase 初始化
 * - 內建設定（所有使用者共用同一個 Firebase 專案，資料依 UID 隔離）
 */

// Firebase 內建設定
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCJ1WL_aScocarEvQdEgCYtsdqM8AUdGlw",
    authDomain: "stsystem-9d5fe.firebaseapp.com",
    projectId: "stsystem-9d5fe",
    storageBucket: "stsystem-9d5fe.firebasestorage.app",
    messagingSenderId: "192019928674",
    appId: "1:192019928674:web:1e59b250a3fc58f982233b",
    measurementId: "G-56YRE2K4HR"
};

// Firebase 實例
let firebaseApp = null;
let auth = null;
let db = null;

// 載入狀態
let isLoading = false;
let isLoaded = false;

/**
 * 動態載入 Firebase SDK
 * @returns {Promise<void>}
 */
async function loadFirebaseSDK() {
    if (isLoaded) return;
    if (isLoading) {
        // 等待載入完成
        return new Promise((resolve) => {
            const checkLoaded = setInterval(() => {
                if (isLoaded) {
                    clearInterval(checkLoaded);
                    resolve();
                }
            }, 100);
        });
    }

    isLoading = true;

    try {
        // 使用動態 import 載入 Firebase 模組
        const [
            { initializeApp },
            { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged },
            { getFirestore, collection, doc, setDoc, getDoc, getDocs, onSnapshot, enableIndexedDbPersistence }
        ] = await Promise.all([
            import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'),
            import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js'),
            import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js')
        ]);

        // 將函數存到全域以供其他模組使用
        window.firebaseModules = {
            initializeApp,
            getAuth,
            GoogleAuthProvider,
            signInWithPopup,
            signOut,
            onAuthStateChanged,
            getFirestore,
            collection,
            doc,
            setDoc,
            getDoc,
            getDocs,
            onSnapshot,
            enableIndexedDbPersistence
        };

        isLoaded = true;
        console.log('Firebase SDK 載入完成');
    } catch (error) {
        console.error('Firebase SDK 載入失敗:', error);
        isLoading = false;
        throw error;
    }
}

/**
 * 初始化 Firebase
 * @returns {Promise<{app: Object, auth: Object, db: Object}|null>}
 */
async function initializeFirebase() {
    // 如果已初始化，直接返回
    if (firebaseApp && auth && db) {
        return { app: firebaseApp, auth, db };
    }

    try {
        // 確保 SDK 已載入
        await loadFirebaseSDK();

        const { initializeApp, getAuth, getFirestore, enableIndexedDbPersistence } = window.firebaseModules;

        // 初始化 Firebase App
        firebaseApp = initializeApp(FIREBASE_CONFIG);

        // 初始化 Auth
        auth = getAuth(firebaseApp);

        // 初始化 Firestore
        db = getFirestore(firebaseApp);

        // 啟用離線持久化
        try {
            await enableIndexedDbPersistence(db);
            console.log('Firestore 離線持久化已啟用');
        } catch (err) {
            if (err.code === 'failed-precondition') {
                console.warn('多個分頁開啟中，離線持久化僅在一個分頁中啟用');
            } else if (err.code === 'unimplemented') {
                console.warn('瀏覽器不支援離線持久化');
            }
        }

        console.log('Firebase 初始化成功');
        return { app: firebaseApp, auth, db };
    } catch (error) {
        console.error('Firebase 初始化失敗:', error);
        throw error;
    }
}

/**
 * 取得 Firebase Auth 實例
 * @returns {Object|null}
 */
function getAuthInstance() {
    return auth;
}

/**
 * 取得 Firestore 實例
 * @returns {Object|null}
 */
function getDbInstance() {
    return db;
}

/**
 * 檢查 Firebase 是否已初始化
 * @returns {boolean}
 */
function isFirebaseInitialized() {
    return firebaseApp !== null && auth !== null && db !== null;
}

/**
 * 重置 Firebase（用於切換帳號）
 */
function resetFirebase() {
    firebaseApp = null;
    auth = null;
    db = null;
}

export {
    loadFirebaseSDK,
    initializeFirebase,
    getAuthInstance,
    getDbInstance,
    isFirebaseInitialized,
    resetFirebase
};
