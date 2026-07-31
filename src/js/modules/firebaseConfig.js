/**
 * Firebase 設定模組
 *
 * 負責：
 * - 動態載入 Firebase SDK
 * - Firebase 初始化
 * - 內建設定（所有使用者共用同一個 Firebase 專案，資料依 UID 隔離）
 */

// Firebase 內建設定
// 注意: 此 API key 是 client-side 公開 key (Google 設計)，須在 Cloud Console > APIs & Services > Credentials
// 設定 HTTP referrer 限制為 uplilt31311227.github.io/* 以防止濫用。
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCJ1WL_aScocarEvQdEgCYtsdqM8AUdGlw",
    authDomain: "stsystem-9d5fe.firebaseapp.com",
    projectId: "stsystem-9d5fe",
    storageBucket: "stsystem-9d5fe.firebasestorage.app",
    messagingSenderId: "192019928674",
    appId: "1:192019928674:web:1e59b250a3fc58f982233b",
    measurementId: "G-56YRE2K4HR"
};

/**
 * Stage 4（2026-07-31，RESEARCH-multitenancy-semester.md §4／RESEARCH-blaze-followup.md §3）：
 * App Check 佔位站台金鑰。開放註冊上線後，任何登入者都能觸發 schoolApplications 的寫入
 * （見 firestore.rules 檔頭第 9 點），App Check 是唯一能擋掉「非本站來源自動化流量」的
 * 前端防線（無法擋掉合法瀏覽器的合法濫用，見報告 §4.5 的誠實揭露，這裡不重複宣稱過度）。
 *
 * 依 RESEARCH-blaze-followup.md §3 的查證結果，選用 **classic reCAPTCHA v3**（非
 * Enterprise）：v3 免費額度每月 100 萬次呼叫，遠高於 Enterprise 的每月 1 萬次免費額度與本案
 * 估算的用量（20 校情境約 1.6 萬次/月），且超額時是 fail-open（給 0.9 分，不粗暴擋下請求）
 * 而非直接失敗。
 *
 * 空字串＝跳過初始化（見下方 initializeFirebase() 的判斷），不影響任何現有功能——這是刻意
 * 的預設值，金鑰需使用者在 Firebase Console 建立 reCAPTCHA v3 站台後手動填入這裡。
 * 啟用步驟（含建立站台、填入金鑰、Console 端開啟 enforcement 的時機）見
 * docs/STAGE4-DEPLOY.md「App Check」一節——enforcement 是否開啟是 Console 端的獨立開關，
 * 這裡的初始化只是「載入 App Check SDK 並開始產生 token」，不等於「Firestore 已要求驗證
 * token」，兩者刻意分開，避免站台金鑰填錯／SDK 初始化有誤直接鎖死所有既有使用者的存取。
 */
const RECAPTCHA_V3_SITE_KEY = '';

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
            { initializeApp, deleteApp },
            { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
              signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
              sendEmailVerification },
            { getFirestore, collection, doc, setDoc, getDoc, getDocs, deleteDoc, onSnapshot, enableIndexedDbPersistence }
        ] = await Promise.all([
            import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'),
            import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js'),
            import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js')
        ]);

        // 將函數存到全域以供其他模組使用
        window.firebaseModules = {
            initializeApp,
            deleteApp,
            getAuth,
            GoogleAuthProvider,
            signInWithPopup,
            signOut,
            onAuthStateChanged,
            signInWithEmailAndPassword,
            createUserWithEmailAndPassword,
            sendPasswordResetEmail,
            // Stage 4：Email/密碼登入者的「請先驗證 email」流程用（authService.sendVerificationEmail）。
            sendEmailVerification,
            getFirestore,
            collection,
            doc,
            setDoc,
            getDoc,
            getDocs,
            deleteDoc,
            onSnapshot,
            enableIndexedDbPersistence
        };
        // 也暴露 FIREBASE_CONFIG 給 authService 建立 secondary app（用於主任建教師帳號）
        window.firebaseModules.__config = FIREBASE_CONFIG;

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

        // Stage 4：App Check（classic reCAPTCHA v3）。必須排在其他 SDK 初始化之前——
        // Auth/Firestore 一旦開始送出請求，越早掛上 App Check 的 token provider 越好
        // （雖然本次不開 enforcement，SDK 仍會盡早開始產生/快取 token，為未來開啟
        // enforcement 時降低第一批請求被拒的機率）。RECAPTCHA_V3_SITE_KEY 為空時完全跳過，
        // 不影響任何現有登入/資料流程——見該常數定義處的完整說明。
        if (RECAPTCHA_V3_SITE_KEY) {
            try {
                const { initializeAppCheck, ReCaptchaV3Provider } =
                    await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js');
                initializeAppCheck(firebaseApp, {
                    provider: new ReCaptchaV3Provider(RECAPTCHA_V3_SITE_KEY),
                    isTokenAutoRefreshEnabled: true,
                });
                console.log('App Check 已啟用（reCAPTCHA v3）');
            } catch (err) {
                // 不阻擋登入：App Check 初始化失敗只代表這一層保護未生效，不是本系統的
                // 核心功能——寧可讓使用者能繼續使用系統，也不要因為 App Check 掛掉而全站鎖死。
                console.error('App Check 初始化失敗（不阻擋登入，但代表本次 session 未受 App Check 保護）：', err);
            }
        } else {
            console.info('[App Check] RECAPTCHA_V3_SITE_KEY 尚未設定，跳過初始化。啟用步驟見 docs/STAGE4-DEPLOY.md。');
        }

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
