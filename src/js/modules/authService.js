/**
 * 認證服務模組
 *
 * 負責：
 * - Google 帳號登入/登出
 * - 認證狀態監聽
 * - 使用者資訊管理
 */

import { initializeFirebase, getAuthInstance, isFirebaseInitialized } from './firebaseConfig.js';

// 當前使用者
let currentUser = null;

// 認證狀態變更回調函數列表
const authStateCallbacks = [];

/**
 * 初始化認證服務
 * @returns {Promise<Object|null>} 當前使用者或 null
 */
async function initAuthService() {
    const firebase = await initializeFirebase();
    if (!firebase) {
        console.log('Firebase 未設定，認證服務無法啟動');
        return null;
    }

    const { onAuthStateChanged } = window.firebaseModules;
    const auth = firebase.auth;

    // 監聽認證狀態變更
    onAuthStateChanged(auth, (user) => {
        currentUser = user;
        console.log('認證狀態變更:', user ? user.email : '未登入');

        // 通知所有監聽者
        authStateCallbacks.forEach(callback => {
            try {
                callback(user);
            } catch (error) {
                console.error('認證狀態回調執行錯誤:', error);
            }
        });
    });

    return currentUser;
}

/**
 * 使用 Google 帳號登入
 * @returns {Promise<Object>} 使用者資訊
 */
async function signInWithGoogle() {
    if (!isFirebaseInitialized()) {
        throw new Error('請先完成 Firebase 設定');
    }

    const { GoogleAuthProvider, signInWithPopup } = window.firebaseModules;
    const auth = getAuthInstance();

    const provider = new GoogleAuthProvider();

    // 設定額外的 OAuth 參數
    provider.setCustomParameters({
        prompt: 'select_account' // 每次都顯示帳號選擇
    });

    try {
        const result = await signInWithPopup(auth, provider);
        currentUser = result.user;

        console.log('Google 登入成功:', currentUser.email);

        return {
            uid: currentUser.uid,
            email: currentUser.email,
            displayName: currentUser.displayName,
            photoURL: currentUser.photoURL
        };
    } catch (error) {
        console.error('Google 登入失敗:', error);

        // 處理常見錯誤
        if (error.code === 'auth/popup-closed-by-user') {
            throw new Error('登入視窗已關閉');
        } else if (error.code === 'auth/popup-blocked') {
            throw new Error('彈出視窗被封鎖，請允許彈出視窗');
        } else if (error.code === 'auth/cancelled-popup-request') {
            throw new Error('登入請求已取消');
        } else if (error.code === 'auth/unauthorized-domain') {
            throw new Error('此網域未經授權，請在 Firebase 控制台新增此網域');
        }

        throw error;
    }
}

/**
 * 登出
 * @returns {Promise<void>}
 */
async function signOutUser() {
    if (!isFirebaseInitialized()) {
        return;
    }

    const { signOut } = window.firebaseModules;
    const auth = getAuthInstance();

    try {
        await signOut(auth);
        currentUser = null;
        console.log('已登出');
    } catch (error) {
        console.error('登出失敗:', error);
        throw error;
    }
}

/**
 * 取得當前使用者
 * @returns {Object|null}
 */
function getCurrentUser() {
    return currentUser;
}

/**
 * 檢查是否已登入
 * @returns {boolean}
 */
function isSignedIn() {
    return currentUser !== null;
}

/**
 * 取得使用者資訊
 * @returns {Object|null}
 */
function getUserInfo() {
    if (!currentUser) return null;

    return {
        uid: currentUser.uid,
        email: currentUser.email,
        displayName: currentUser.displayName,
        photoURL: currentUser.photoURL
    };
}

/**
 * 取得使用者 ID（用於 Firestore 路徑）
 * @returns {string|null}
 */
function getUserId() {
    return currentUser ? currentUser.uid : null;
}

/**
 * 註冊認證狀態變更回調
 * @param {Function} callback - 回調函數，參數為使用者物件或 null
 * @returns {Function} 取消註冊函數
 */
function onAuthStateChange(callback) {
    authStateCallbacks.push(callback);

    // 立即以當前狀態呼叫一次
    if (isFirebaseInitialized()) {
        callback(currentUser);
    }

    // 返回取消註冊函數
    return () => {
        const index = authStateCallbacks.indexOf(callback);
        if (index > -1) {
            authStateCallbacks.splice(index, 1);
        }
    };
}

/**
 * 等待認證狀態確認
 * @param {number} timeout - 超時時間（毫秒），預設 5000
 * @returns {Promise<Object|null>}
 */
function waitForAuthState(timeout = 5000) {
    return new Promise((resolve, reject) => {
        // 如果已有狀態，直接返回
        if (currentUser !== undefined) {
            resolve(currentUser);
            return;
        }

        const timeoutId = setTimeout(() => {
            reject(new Error('等待認證狀態超時'));
        }, timeout);

        const unsubscribe = onAuthStateChange((user) => {
            clearTimeout(timeoutId);
            unsubscribe();
            resolve(user);
        });
    });
}

/**
 * 使用 Email + 密碼登入（Phase 1.6.b 新增）
 * 配合 Google 登入並存：兩者都最終取得 user.email 後由 authGuardV2 配對 teachers 白名單。
 */
async function signInWithEmail(email, password) {
    if (!isFirebaseInitialized()) {
        throw new Error('請先完成 Firebase 設定');
    }
    const { signInWithEmailAndPassword } = window.firebaseModules;
    const auth = getAuthInstance();
    try {
        const result = await signInWithEmailAndPassword(auth, email.toLowerCase().trim(), password);
        currentUser = result.user;
        return { uid: currentUser.uid, email: currentUser.email, displayName: currentUser.displayName };
    } catch (error) {
        if (error.code === 'auth/user-not-found' || error.code === 'auth/wrong-password' || error.code === 'auth/invalid-credential') {
            throw new Error('Email 或密碼錯誤');
        } else if (error.code === 'auth/too-many-requests') {
            throw new Error('登入嘗試次數過多，請稍後再試');
        } else if (error.code === 'auth/user-disabled') {
            throw new Error('此帳號已被停用，請聯絡教務主任');
        }
        throw error;
    }
}

/**
 * 寄出密碼重置信（Phase 1.6.b 新增）
 * 教師端的「忘記密碼？」與主任端的「📧 寄密碼重置信」共用此 API。
 */
async function sendPasswordReset(email) {
    if (!isFirebaseInitialized()) {
        throw new Error('請先完成 Firebase 設定');
    }
    const { sendPasswordResetEmail } = window.firebaseModules;
    const auth = getAuthInstance();
    await sendPasswordResetEmail(auth, email.toLowerCase().trim());
}

/**
 * 自助註冊新教師（Phase 1.6.b 新增）
 * 教師按「我是新教師 → 註冊」進這個流程。createUserWithEmailAndPassword 會順帶登入，
 * 登入後由 onAuthStateChanged → v2-app → authGuardV2 確認 email 在 teachers 白名單。
 * 不在白名單會被 authGuardV2 擋下並登出。
 */
async function registerWithEmail(email, password) {
    if (!isFirebaseInitialized()) {
        throw new Error('請先完成 Firebase 設定');
    }
    const { createUserWithEmailAndPassword } = window.firebaseModules;
    const auth = getAuthInstance();
    try {
        const result = await createUserWithEmailAndPassword(auth, email.toLowerCase().trim(), password);
        currentUser = result.user;
        return { uid: currentUser.uid, email: currentUser.email };
    } catch (error) {
        if (error.code === 'auth/email-already-in-use') {
            throw new Error('此 Email 已註冊過，請直接登入或使用「忘記密碼」');
        } else if (error.code === 'auth/weak-password') {
            throw new Error('密碼強度不足（至少 6 字元）');
        } else if (error.code === 'auth/invalid-email') {
            throw new Error('Email 格式錯誤');
        }
        throw error;
    }
}

/**
 * 主任端：為教師建立 Firebase Auth 帳號 + 立刻寄密碼設定信（Phase 1.6.b 新增）
 *
 * 用 secondary Firebase App instance 避免影響主任的當前 session。
 * 若該 email 已是 Auth user（email-already-in-use），則略過建帳號、直接寄重置信。
 * 寄信本身用主 auth 即可。
 */
async function createTeacherAuthAndSendReset(email) {
    if (!isFirebaseInitialized()) {
        throw new Error('請先完成 Firebase 設定');
    }
    const normalized = email.toLowerCase().trim();
    const { initializeApp, deleteApp, getAuth, createUserWithEmailAndPassword, sendPasswordResetEmail, __config }
        = window.firebaseModules;

    const secondaryName = 'secondary-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const secondaryApp  = initializeApp(__config, secondaryName);
    const secondaryAuth = getAuth(secondaryApp);

    let accountCreated = false;
    try {
        // 用安全隨機初始密碼建帳號；教師永遠不會用到，因為他會被強制走重置流程
        const randomPwd = 'tmp_' + crypto.getRandomValues(new Uint32Array(2)).join('_') + '_!Aa1';
        try {
            await createUserWithEmailAndPassword(secondaryAuth, normalized, randomPwd);
            accountCreated = true;
        } catch (e) {
            if (e.code !== 'auth/email-already-in-use') throw e;
            // already exists → fallthrough 寄重置信
        }
        // 用主 auth 寄重置信（不會切換主任的 session）
        const mainAuth = getAuthInstance();
        await sendPasswordResetEmail(mainAuth, normalized);
    } finally {
        // 不論建帳號成功與否都釋放 secondary app（已 signed in 的 session 也會跟著清掉）
        try { await deleteApp(secondaryApp); } catch (_) {}
    }
    return { accountCreated, emailSent: true };
}

export {
    initAuthService,
    signInWithGoogle,
    signInWithEmail,
    registerWithEmail,
    sendPasswordReset,
    createTeacherAuthAndSendReset,
    signOutUser,
    getCurrentUser,
    isSignedIn,
    getUserInfo,
    getUserId,
    onAuthStateChange,
    waitForAuthState
};
