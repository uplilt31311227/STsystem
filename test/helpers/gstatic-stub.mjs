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
export const initializeAppCheck = () => ({});
export class ReCaptchaV3Provider {}

export const collection = (db, path) => ({ kind: 'col', path });
export const doc = (db, path) => ({ kind: 'doc', path, id: idOf(path) });
export const query = (col) => col;
export const where = () => ({});
export const orderBy = () => ({});
export const limit = () => ({});
export const startAfter = () => ({});
export const serverTimestamp = () => '<<ts>>';
export const Timestamp = { now: () => ({}) };
export const getDoc = async (ref) => mkSnap(ref.path);
export const getDocFromServer = getDoc;
export const getDocs = async (q) => {
    const prefix = q.path + '/';
    const docs = [];
    for (const path of F().docs.keys()) {
        if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) docs.push(mkSnap(path));
    }
    return { docs, empty: docs.length === 0, size: docs.length };
};
export const setDoc = async (ref, data) => { F().writes.push({ op: 'set', path: ref.path, data }); F().docs.set(ref.path, data); };
export const addDoc = async (col, data) => { const path = `${col.path}/auto_${F().writes.length}`; F().writes.push({ op: 'add', path, data }); F().docs.set(path, data); return { id: idOf(path), path }; };
export const updateDoc = async (ref, patch) => { F().writes.push({ op: 'update', path: ref.path, data: patch }); };
export const deleteDoc = async (ref) => { F().writes.push({ op: 'delete', path: ref.path }); };
export const onSnapshot = (ref, cb) => { cb(ref.kind === 'doc' ? mkSnap(ref.path) : { docs: [] }); return () => {}; };
export const writeBatch = () => ({ set() {}, update() {}, delete() {}, commit: async () => {} });
export const runTransaction = async (db, fn) => fn({
    get: async (ref) => mkSnap(ref.path),
    set: (ref, data) => { F().writes.push({ op: 'tx.set', path: ref.path, data }); },
    update: (ref, patch) => { F().writes.push({ op: 'tx.update', path: ref.path, data: patch }); },
});
