/**
 * V2 Firebase SDK 擴充
 *
 * 重用現有的 firebaseApp / db 實例（由 firebaseConfig.js 建立），
 * 但動態載入 V2 所需的額外 Firestore 操作（addDoc / updateDoc / deleteDoc / query / where / orderBy / serverTimestamp / writeBatch 等）。
 *
 * 使用方式：
 *   import { getV2Firestore } from './firebaseV2.js';
 *   const fs = await getV2Firestore();
 *   fs.setDoc(fs.doc(fs.db, path), data);
 */

import { initializeFirebase, getDbInstance } from '../firebaseConfig.js';

let fsHelpers = null;
let loading   = null;

async function loadExtraFirestore() {
    const mod = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    return {
        addDoc:           mod.addDoc,
        updateDoc:        mod.updateDoc,
        deleteDoc:        mod.deleteDoc,
        query:            mod.query,
        where:            mod.where,
        orderBy:          mod.orderBy,
        limit:            mod.limit,
        serverTimestamp:  mod.serverTimestamp,
        writeBatch:       mod.writeBatch,
        runTransaction:   mod.runTransaction,
        Timestamp:        mod.Timestamp,
    };
}

export async function getV2Firestore() {
    if (fsHelpers) return fsHelpers;
    if (loading) return loading;

    loading = (async () => {
        await initializeFirebase();
        const db       = getDbInstance();
        const baseMods = window.firebaseModules || {};
        const extras   = await loadExtraFirestore();

        fsHelpers = {
            db,
            collection: baseMods.collection,
            doc:        baseMods.doc,
            setDoc:     baseMods.setDoc,
            getDoc:     baseMods.getDoc,
            getDocs:    baseMods.getDocs,
            onSnapshot: baseMods.onSnapshot,
            ...extras,
        };
        return fsHelpers;
    })();

    return loading;
}
