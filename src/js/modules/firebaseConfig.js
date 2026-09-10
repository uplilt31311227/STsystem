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
const RECAPTCHA_V3_SITE_KEY = '6LfE9m4tAAAAAOhI27cN7sx38AbEm7MEF5BaYK9t';

// Firebase 實例
let firebaseApp = null;
let auth = null;
let db = null;
/** 初始化進行中的 promise，供併發呼叫共用（見 initializeFirebase 的併發保護說明）。 */
let initPromise = null;

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
              sendEmailVerification, connectAuthEmulator },
            { getFirestore, initializeFirestore, collection, doc, setDoc, getDoc, getDocs, deleteDoc, onSnapshot,
              enableIndexedDbPersistence, connectFirestoreEmulator }
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
            connectAuthEmulator,
            connectFirestoreEmulator,
            getFirestore,
            initializeFirestore,
            collection,
            doc,
            setDoc,
            getDoc,
            getDocs,
            deleteDoc,
            onSnapshot,
            enableIndexedDbPersistence
        };
        // 也暴露 config 給 authService 建立 secondary app（用於主任建教師帳號）。
        // Emulator 模式下必須連同 projectId 一起換掉，否則 secondary app 會用正式
        // projectId 去建帳號（見 EMULATOR_PROJECT_ID 的說明）。
        window.firebaseModules.__config = getActiveFirebaseConfig();

        isLoaded = true;
        console.log('Firebase SDK 載入完成');
    } catch (error) {
        console.error('Firebase SDK 載入失敗:', error);
        isLoading = false;
        throw error;
    }
}

/**
 * 是否連本機 Firebase Emulator（供 test/e2e 全流程操作測試使用）。
 *
 * ⚠ 兩個條件必須同時成立才會啟用，缺一不可：
 *   1. hostname 是 localhost / 127.0.0.1——正式站（uplilt31311227.github.io）永遠不成立；
 *   2. 網址明確帶 `?emu=1`——本機開發時的一般瀏覽（不帶參數）也不會誤連 emulator。
 * 這個雙重條件是刻意的：任何一邊單獨成立都不夠。正式環境不存在能命中的路徑，
 * 且啟用時會在 console 印出明顯警告，不可能在不知情的狀況下連到 emulator。
 *
 * 對應的 emulator 埠與 test/emulator/emu-client.mjs、firebase.json 一致。
 */
/**
 * Emulator 模式專用的專案 ID，必須與 test/emulator/emu-client.mjs 的 PROJECT_ID 一致。
 *
 * ⚠ 這個覆寫是必要的，不是可有可無的整潔：Firestore Emulator 依 projectId 分隔資料庫
 * 命名空間，若沿用正式的 projectId，前端讀到的會是一個「與種子資料完全不同」的空命名空間
 * ——現象是所有查詢都回「文件不存在」（不是權限錯誤），登入後會被誤判成「尚未綁定任何學校」。
 * firebase.json 的 singleProjectMode 只讓 Auth Emulator 放行跨專案請求（所以帳號登得進去、
 * uid 也對得上），並不會合併 Firestore 的命名空間。
 */
const EMULATOR_PROJECT_ID = 'demo-stsystem';

/** 實際要送進 initializeApp() 的設定：emulator 模式下換掉 projectId，其餘不變。 */
function getActiveFirebaseConfig() {
    return shouldUseEmulator()
        ? { ...FIREBASE_CONFIG, projectId: EMULATOR_PROJECT_ID }
        : FIREBASE_CONFIG;
}

function shouldUseEmulator() {
    try {
        const host    = window.location.hostname;
        const isLocal = host === 'localhost' || host === '127.0.0.1';
        const flagged = new URLSearchParams(window.location.search).get('emu') === '1';
        return isLocal && flagged;
    } catch {
        return false;
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
    // 併發保護：app.js 與 v2-app.js 幾乎同時呼叫本函式，兩者都會在 db 尚未賦值前
    // 通過上面的檢查，導致整段初始化跑兩次（實測 console 會出現兩次初始化訊息）。
    // 第二次對同一個 Firestore 單例重複呼叫 connectFirestoreEmulator() 是有風險的
    // （SDK 要求必須在該實例被使用前設定），也會重複掛上 App Check。
    // 用 in-flight promise 讓並發呼叫共用同一次初始化。
    if (initPromise) return initPromise;

    initPromise = doInitializeFirebase();
    try {
        return await initPromise;
    } catch (err) {
        initPromise = null;   // 失敗不快取，讓呼叫端能重試
        throw err;
    }
}

async function doInitializeFirebase() {
    try {
        // 確保 SDK 已載入
        await loadFirebaseSDK();

        const { initializeApp, getAuth, getFirestore, enableIndexedDbPersistence } = window.firebaseModules;

        // 初始化 Firebase App
        firebaseApp = initializeApp(getActiveFirebaseConfig());

        // Stage 4：App Check（classic reCAPTCHA v3）。必須排在其他 SDK 初始化之前——
        // Auth/Firestore 一旦開始送出請求，越早掛上 App Check 的 token provider 越好
        // （雖然本次不開 enforcement，SDK 仍會盡早開始產生/快取 token，為未來開啟
        // enforcement 時降低第一批請求被拒的機率）。RECAPTCHA_V3_SITE_KEY 為空時完全跳過，
        // 不影響任何現有登入/資料流程——見該常數定義處的完整說明。
        const useEmulator = shouldUseEmulator();

        // Emulator 模式跳過 App Check：reCAPTCHA v3 對 localhost 無意義，且 emulator
        // 本來就不驗證 App Check token，掛上去只會產生一堆失敗請求的雜訊。
        if (RECAPTCHA_V3_SITE_KEY && !useEmulator) {
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
        } else if (useEmulator) {
            console.info('[App Check] Emulator 模式，跳過初始化（emulator 不驗證 App Check token）。');
        } else {
            console.info('[App Check] RECAPTCHA_V3_SITE_KEY 尚未設定，跳過初始化。啟用步驟見 docs/STAGE4-DEPLOY.md。');
        }

        // 初始化 Auth
        auth = getAuth(firebaseApp);

        // 初始化 Firestore
        db = getFirestore(firebaseApp);

        if (useEmulator) {
            const { connectAuthEmulator, connectFirestoreEmulator } = window.firebaseModules;
            connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
            connectFirestoreEmulator(db, '127.0.0.1', 8080);
            console.warn(
                '%c[EMULATOR] 本頁連線到本機 Firebase Emulator，不是正式資料庫。',
                'background:#b91c1c;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold'
            );
            // Emulator 模式不啟用離線持久化——IndexedDB 快取會跨測試殘留，讓「重新種資料後
            // 頁面仍顯示舊資料」這種假象很難追查。回傳前直接結束。
            return { app: firebaseApp, auth, db };
        }

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
