/**
 * Firebase Emulator REST 客戶端
 *
 * ⚠ 安全設計（2026-07-30 事故的直接對策，見 docs/ISSUES_LOG.md「驗證過程意外對正式
 * Firestore 寫入 16 筆測試文件」）：本模組**沒有任何**可以指向正式 Firestore 的路徑——
 * host 寫死為 127.0.0.1、專案寫死為 demo- 前綴，且每次連線前先呼叫 assertEmulator()
 * 對 Firestore 與 Auth 兩個 host 各做一次探測，確認回應形狀符合 emulator 的特徵。
 * 驗證失敗一律中止，不 fallback、不重試、不讀任何憑證檔。
 *
 * 探測方式的實際強度（如實描述，不誇大）：Firestore 探根路徑回應 "Ok"、Auth 探
 * /emulator/v1/projects 這個 emulator 專屬端點。真正的防線是「host 與專案 ID 寫死」——
 * 探測只是確保「本機這個埠上跑的確實是 emulator 而不是別的服務」，避免把測試資料寫進
 * 某個剛好佔用 8080 埠的無關程式。
 *
 * 兩種寫入身分：
 *   admin*  不帶 Authorization → emulator 視為 owner，繞過 Security Rules，供建立種子資料。
 *   client* 帶使用者 idToken   → 完整套用 firestore.rules，供權限測試。
 */

const PROJECT_ID     = 'demo-stsystem';
const FIRESTORE_HOST = '127.0.0.1:8080';
const AUTH_HOST      = '127.0.0.1:9099';
const FAKE_API_KEY   = 'fake-api-key';

const DOCS_ROOT = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const EMU_ROOT  = `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)`;
const AUTH_ROOT = `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1`;

export const EMULATOR_INFO = Object.freeze({ PROJECT_ID, FIRESTORE_HOST, AUTH_HOST });

let verified = false;

/**
 * 確認對端真的是 emulator。正式 Firestore 沒有 /emulator/v1/... 這組端點，
 * 因此這個檢查無法在正式環境「碰巧通過」。
 */
export async function assertEmulator() {
    if (verified) return;
    if (!PROJECT_ID.startsWith('demo-')) {
        throw new Error(`專案 ID 必須是 demo- 前綴（目前：${PROJECT_ID}），拒絕執行`);
    }
    if (!FIRESTORE_HOST.startsWith('127.0.0.1:') || !AUTH_HOST.startsWith('127.0.0.1:')) {
        throw new Error('Emulator host 必須是 127.0.0.1，拒絕連線到非本機位址');
    }
    // Firestore Emulator 的根路徑回應純文字 "Ok"；正式 Firestore 不在 127.0.0.1 上，
    // 也不會這樣回應。（/emulator/v1/... 那組端點只支援 DELETE，不能拿來探測。）
    let res, body;
    try {
        res  = await fetch(`http://${FIRESTORE_HOST}/`, { method: 'GET' });
        body = (await res.text()).trim();
    } catch (err) {
        throw new Error(
            `連不上 Firestore Emulator（${FIRESTORE_HOST}）：${err.message}\n` +
            `請先啟動：npx firebase emulators:start --project ${PROJECT_ID} --only auth,firestore`
        );
    }
    if (!res.ok || !/^ok$/i.test(body)) {
        throw new Error(
            `${FIRESTORE_HOST} 上跑的不是 Firestore Emulator ` +
            `（回應 ${res.status}：${body.slice(0, 80)}），拒絕執行`
        );
    }

    // Auth host 也要探——createTestUser()/clearAuth() 寫的是這一個，只驗 Firestore
    // 等於有一半的寫入目標從未被確認過。/emulator/v1/projects 是 Auth Emulator 專屬端點。
    let authRes;
    try {
        authRes = await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/config`, {
            headers: { Authorization: 'Bearer owner' },
        });
    } catch (err) {
        throw new Error(
            `連不上 Auth Emulator（${AUTH_HOST}）：${err.message}\n` +
            `請確認啟動時有帶 --only auth,firestore`
        );
    }
    if (!authRes.ok) {
        throw new Error(`${AUTH_HOST} 上跑的不是 Firebase Auth Emulator（回應 ${authRes.status}），拒絕執行`);
    }

    verified = true;
}

/* ===================== Firestore 值轉換 ===================== */

export function toFirestoreValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') {
        return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (typeof v === 'string') return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
    if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
    throw new Error(`無法轉換的型別：${typeof v}`);
}

export function toFirestoreFields(obj) {
    const fields = {};
    for (const [k, v] of Object.entries(obj)) fields[k] = toFirestoreValue(v);
    return fields;
}

export function fromFirestoreValue(v) {
    if (!v || typeof v !== 'object') return v;
    if ('nullValue'    in v) return null;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue'  in v) return v.doubleValue;
    if ('stringValue'  in v) return v.stringValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
    if ('mapValue'     in v) return fromFirestoreFields(v.mapValue.fields || {});
    return v;
}

export function fromFirestoreFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) out[k] = fromFirestoreValue(v);
    return out;
}

/* ===================== 低階請求 ===================== */

/**
 * 三種身分，對應三種 Authorization：
 *   idToken 指定       → Bearer <idToken>，完整套用 Security Rules（權限測試用）
 *   anonymous: true    → 完全不帶 header，等同未登入的匿名請求（request.auth == null）
 *   兩者都沒有（預設）  → Bearer owner，emulator 視為管理者、繞過規則（建立種子資料用）
 *
 * ⚠ 「不帶 header 就是 owner」是錯的——不帶 header 會被當成未登入使用者並套用規則，
 * 種子資料會被規則擋下。必須明確送出 `Bearer owner`。
 */
function authHeaders({ idToken, anonymous }) {
    const h = { 'Content-Type': 'application/json' };
    if (idToken) h.Authorization = `Bearer ${idToken}`;
    else if (!anonymous) h.Authorization = 'Bearer owner';
    return h;
}

/**
 * 統一回傳 { ok, status, data, error }，永遠不 throw——權限測試需要把 403 當成
 * 正常結果來斷言，用例外表達會讓每個案例都要包 try/catch。
 */
async function request(method, url, { body, idToken, anonymous } = {}) {
    await assertEmulator();
    const res = await fetch(url, {
        method,
        headers: authHeaders({ idToken, anonymous }),
        body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
    return {
        ok: res.ok,
        status: res.status,
        data: json && json.fields ? fromFirestoreFields(json.fields) : json,
        error: res.ok ? null : (json?.error?.message || `HTTP ${res.status}`),
        raw: json,
    };
}

/* ===================== 文件操作 ===================== */

/**
 * setDoc 語意：不存在則建立、**存在則整份覆寫**（等同 Firebase SDK 的 setDoc(ref, data)
 * 不帶 merge）。
 *
 * ⚠ 這不是 merge。Firestore REST 的 PATCH 不帶 updateMask 時會覆蓋整份文件，未提供的
 * 欄位會被刪除——曾經用它「只改 updatedAt」，結果把整份課表的 scheduleData 清空。
 * 要做部分更新請用 mergeDoc()／updateDoc()。
 */
export function setDoc(path, data, opts = {}) {
    return request('PATCH', `${DOCS_ROOT}/${path}`, { ...opts, body: { fields: toFirestoreFields(data) } });
}

/**
 * 合併寫入：只更新列出的欄位，其餘保留（等同 setDoc(..., { merge: true })）。
 * 文件不存在時會以這些欄位建立。
 */
export function mergeDoc(path, data, opts = {}) {
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    return request('PATCH', `${DOCS_ROOT}/${path}?${mask}`, { ...opts, body: { fields: toFirestoreFields(data) } });
}

/** 種子專用：寫入失敗立刻中止。靜默失敗會讓後續所有測試在一個空資料庫上跑，結論全部無效。 */
export async function mustSetDoc(path, data, opts = {}) {
    const res = await setDoc(path, data, opts);
    if (!res.ok) throw new Error(`寫入失敗 ${path}：HTTP ${res.status} ${res.error}`);
    return res;
}

/**
 * 明確的 create 語意：文件已存在會回 409。規則會以 create 條件判定，
 * 這是測 `allow create` 規則時唯一正確的方法（PATCH 對既有文件會被判為 update）。
 */
export function createDoc(collectionPath, docId, data, opts = {}) {
    const url = `${DOCS_ROOT}/${collectionPath}?documentId=${encodeURIComponent(docId)}`;
    return request('POST', url, { ...opts, body: { fields: toFirestoreFields(data) } });
}

/**
 * 明確的 update 語意：只更新列出的欄位，文件不存在時會失敗。
 * updateMask 是必要的——不帶時 PATCH 對不存在的文件會變成 create。
 */
export function updateDoc(path, data, opts = {}) {
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
    const url  = `${DOCS_ROOT}/${path}?${mask}&currentDocument.exists=true`;
    return request('PATCH', url, { ...opts, body: { fields: toFirestoreFields(data) } });
}

export function getDoc(path, opts = {}) {
    return request('GET', `${DOCS_ROOT}/${path}`, opts);
}

export function deleteDoc(path, opts = {}) {
    return request('DELETE', `${DOCS_ROOT}/${path}`, opts);
}

/** 列出集合內文件（受規則的 list 權限約束）。 */
export async function listDocs(collectionPath, { pageSize = 300, ...opts } = {}) {
    const res = await request('GET', `${DOCS_ROOT}/${collectionPath}?pageSize=${pageSize}`, opts);
    if (!res.ok) return res;
    const docs = (res.raw?.documents || []).map(d => ({
        id: d.name.split('/').pop(),
        ...fromFirestoreFields(d.fields || {}),
    }));
    return { ...res, docs };
}

/** 清空整個 emulator 資料庫（只有 emulator 有這個端點）。 */
export async function clearFirestore() {
    await assertEmulator();
    const res = await fetch(`${EMU_ROOT}/documents`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`清空 emulator 失敗：HTTP ${res.status}`);
}

/* ===================== Auth ===================== */

/** 清空 Auth emulator 內所有測試帳號。 */
export async function clearAuth() {
    await assertEmulator();
    const res = await fetch(
        `http://${AUTH_HOST}/emulator/v1/projects/${PROJECT_ID}/accounts`,
        { method: 'DELETE', headers: { Authorization: 'Bearer owner' } }
    );
    if (!res.ok) throw new Error(`清空 Auth emulator 失敗：HTTP ${res.status}`);
}

/**
 * 建立測試帳號並回傳可用的 idToken。
 * emailVerified 預設為 true——Stage 4 的 userDirectory 自寫規則要求 email_verified，
 * 而 Google 登入的真實帳號本來就是已驗證狀態；需要測「未驗證」情境時明確傳 false。
 */
export async function createTestUser(email, { password = 'test-password-1234', emailVerified = true } = {}) {
    await assertEmulator();

    const signUp = await fetch(`${AUTH_ROOT}/accounts:signUp?key=${FAKE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const created = await signUp.json();
    if (!signUp.ok) throw new Error(`建立測試帳號失敗（${email}）：${created?.error?.message || signUp.status}`);

    if (emailVerified) {
        const upd = await fetch(`${AUTH_ROOT}/accounts:update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
            body: JSON.stringify({ localId: created.localId, emailVerified: true }),
        });
        if (!upd.ok) throw new Error(`設定 emailVerified 失敗（${email}）：HTTP ${upd.status}`);
        // idToken 內含 email_verified claim，改過之後必須重新換發才會生效
        return { ...(await signIn(email, password)), localId: created.localId, email };
    }

    return { idToken: created.idToken, refreshToken: created.refreshToken, localId: created.localId, email };
}

export async function signIn(email, password = 'test-password-1234') {
    await assertEmulator();
    const res = await fetch(`${AUTH_ROOT}/accounts:signInWithPassword?key=${FAKE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`登入失敗（${email}）：${json?.error?.message || res.status}`);
    return { idToken: json.idToken, refreshToken: json.refreshToken, localId: json.localId, email };
}
