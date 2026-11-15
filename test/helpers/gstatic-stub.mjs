// 假的 Firebase SDK（只供離線單元測試）。資料放在 globalThis.__fake：
//   __fake.docs: Map<path, data>、__fake.writes: 寫入紀錄
const F = () => (globalThis.__fake ||= { docs: new Map(), writes: [] });
const idOf = (p) => p.split('/').pop();
const mkSnap = (path) => {
    const data = F().docs.get(path);
    return { id: idOf(path), exists: () => data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)) };
};

export const initializeApp = () => ({});
export const deleteApp = async () => {};
export const getAuth = () => ({});
export class GoogleAuthProvider {}
export const signInWithPopup = async () => ({});
export const signOut = async () => {};
export const onAuthStateChanged = () => () => {};
export const signInWithEmailAndPassword = async () => ({});
export const createUserWithEmailAndPassword = async () => ({});
export const sendPasswordResetEmail = async () => {};
export const sendEmailVerification = async () => {};
export const connectAuthEmulator = () => {};
export const connectFirestoreEmulator = () => {};
export const getFirestore = () => ({ __db: true });
export const initializeFirestore = getFirestore;
export const enableIndexedDbPersistence = async () => {};
export const terminate = async () => {};
export const clearIndexedDbPersistence = async () => {};
// 離線待寫入：測試可設 globalThis.__fake.pendingWritesImpl = () => Promise（預設立即完成＝沒有待寫入）
export const waitForPendingWrites = async () => { const f = F().pendingWritesImpl; return f ? f() : undefined; };
export const initializeAppCheck = () => ({});
export class ReCaptchaV3Provider {}

export const collection = (db, path) => ({ kind: 'col', path });
export const doc = (db, path) => ({ kind: 'doc', path, id: idOf(path) });
// 查詢：保留 constraints，getDocs 目前支援 orderBy('__name__')、limit、startAfter（游標分頁測試用）；
// where 維持被忽略（既有測試的前提）。
export const query = (col, ...constraints) => ({ ...col, constraints });
// where：保留條件供測試斷言（__fake.queries 記錄每次 getDocs 的集合與條件）；預設不套用篩選（既有測試的前提），
// 設 __fake.applyWhere = true 才依 ==、>=、<= 篩選。
export const where = (field, op, value) => ({ type: 'where', field, op, value });
export const orderBy = (field) => ({ type: 'orderBy', field });
export const limit = (n) => ({ type: 'limit', n });
export const startAfter = (snap) => ({ type: 'startAfter', snap });
export const serverTimestamp = () => '<<ts>>';
export const Timestamp = { now: () => ({}) };
// 測試用：__fake.getDocOnce = { [path]: data|null } 讓該路徑的「下一次」getDoc 回傳指定內容（null＝不存在），用完即清，交易內 tx.get 不受影響
export const getDoc = async (ref) => {
    const once = F().getDocOnce;
    if (once && Object.prototype.hasOwnProperty.call(once, ref.path)) {
        const v = once[ref.path]; delete once[ref.path];
        return { id: idOf(ref.path), exists: () => v !== null, data: () => (v === null ? undefined : structuredClone(v)) };
    }
    return getDocBase(ref);
};
const getDocBase = async (ref) => (F().serverDown ? { id: idOf(ref.path), exists: () => false, data: () => undefined } : mkSnap(ref.path));
// 模擬「client 判定離線／stream 出錯」：F().serverDown = true 時，伺服器讀取（*FromServer）丟 unavailable，
// 一般 getDoc／getDocs 則靜默回傳「殘缺的快取」（每個集合只剩第一筆、文件讀取回傳不存在），與真實 SDK 行為一致。
const serverDownError = () => { const e = new Error('Failed to get document because the client is offline.'); e.code = 'unavailable'; return e; };
// serverDownDocs／serverDownCollections 可讓「文件讀取」或「集合讀取」單獨出錯（serverDown 則兩者都出錯）。
export const getDocFromServer = async (ref) => { if (F().serverDown || F().serverDownDocs) throw serverDownError(); return mkSnap(ref.path); };
export const getDocsFromServer = async (q) => { if (F().serverDown || F().serverDownCollections) throw serverDownError(); return getDocsImpl(q, false); };
export const getDocs = async (q) => getDocsImpl(q, !!F().serverDown);
async function getDocsImpl(q, partialCache) {
    const prefix = q.path + '/';
    let docs = [];
    for (const path of F().docs.keys()) {
        if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) docs.push(mkSnap(path));
    }
    const cs = q.constraints || [];
    (F().queries ||= []).push({ path: q.path, where: cs.filter(c => c.type === 'where').map(c => ({ field: c.field, op: c.op, value: c.value })) });
    if (F().applyWhere) {
        for (const c of cs.filter(c => c.type === 'where')) {
            docs = docs.filter(d => {
                const v = d.data()?.[c.field];
                if (v === undefined) return false;
                return c.op === '==' ? v === c.value : c.op === '>=' ? v >= c.value : c.op === '<=' ? v <= c.value : true;
            });
        }
    }
    if (cs.some(c => c.type === 'orderBy' && c.field === '__name__')) docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const after = cs.find(c => c.type === 'startAfter');
    if (after) { const i = docs.findIndex(d => d.id === after.snap.id); docs = i >= 0 ? docs.slice(i + 1) : docs; }
    const lim = cs.find(c => c.type === 'limit');
    if (lim) docs = docs.slice(0, lim.n);
    if (partialCache) docs = docs.slice(0, 1);
    F().reads = (F().reads || 0) + 1;
    return { docs, empty: docs.length === 0, size: docs.length };
}
const applySet = (ref, data, opts) => {
    const cur = F().docs.get(ref.path);
    F().docs.set(ref.path, opts && opts.merge && cur ? { ...cur, ...data } : data);
};
export const setDoc = async (ref, data, opts) => { F().writes.push({ op: 'set', path: ref.path, data }); applySet(ref, data, opts); };
export const addDoc = async (col, data) => { const path = `${col.path}/auto_${F().writes.length}`; F().writes.push({ op: 'add', path, data }); F().docs.set(path, data); return { id: idOf(path), path }; };
export const updateDoc = async (ref, patch) => { F().writes.push({ op: 'update', path: ref.path, data: patch }); };
export const deleteDoc = async (ref) => { F().writes.push({ op: 'delete', path: ref.path }); };
export const onSnapshot = (ref, cb) => { cb(ref.kind === 'doc' ? mkSnap(ref.path) : { docs: [] }); return () => {}; };
// 批次：commit 時才套用（全部成功或全部不套用）。可用 globalThis.__fake.failBatchAt = n 讓第 n 次 commit 失敗（測試部分失敗）。
export const writeBatch = () => {
    const ops = [];
    return {
        set(ref, data, opts) { ops.push({ op: 'set', ref, data, opts }); },
        update(ref, patch) { ops.push({ op: 'update', ref, patch }); },
        delete(ref) { ops.push({ op: 'delete', ref }); },
        commit: async () => {
            const f = F();
            f.commits = (f.commits || 0) + 1;
            if (f.failBatchAt === f.commits) { const e = new Error('simulated batch failure'); e.code = 'unavailable'; throw e; }
            for (const o of ops) {
                if (o.op === 'set') { f.writes.push({ op: 'batch.set', path: o.ref.path, data: o.data }); applySet(o.ref, o.data, o.opts); }
                else if (o.op === 'update') { f.writes.push({ op: 'batch.update', path: o.ref.path, data: o.patch }); f.docs.set(o.ref.path, { ...(f.docs.get(o.ref.path) || {}), ...o.patch }); }
                else { f.writes.push({ op: 'batch.delete', path: o.ref.path }); f.docs.delete(o.ref.path); }
            }
        },
    };
};
// 交易：讀取當下文件；寫入在函式成功結束後才一起套用（模擬 Firestore 交易的原子性）。
// 可用 globalThis.__fake.beforeTxCommit = () => {...} 在提交前模擬「別人搶先寫入」。
export const runTransaction = async (db, fn) => {
    const pending = [];
    const result = await fn({
        get: async (ref) => mkSnap(ref.path),
        set: (ref, data, opts) => { pending.push({ op: 'tx.set', ref, data, opts }); },
        update: (ref, patch) => { pending.push({ op: 'tx.update', ref, patch }); },
        delete: (ref) => { pending.push({ op: 'tx.delete', ref }); },
    });
    if (F().beforeTxCommit) { const h = F().beforeTxCommit; F().beforeTxCommit = null; h(); }
    for (const o of pending) {
        if (o.op === 'tx.set') { F().writes.push({ op: 'tx.set', path: o.ref.path, data: o.data }); applySet(o.ref, o.data, o.opts); }
        else if (o.op === 'tx.delete') { F().writes.push({ op: 'tx.delete', path: o.ref.path }); F().docs.delete(o.ref.path); }
        else { F().writes.push({ op: 'tx.update', path: o.ref.path, data: o.patch }); F().docs.set(o.ref.path, { ...(F().docs.get(o.ref.path) || {}), ...o.patch }); }
    }
    return result;
};
