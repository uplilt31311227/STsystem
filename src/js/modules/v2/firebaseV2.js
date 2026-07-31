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
        // Stage 5 驗收修復（輕12）：強制直讀伺服器、略過本機快取。executeSemesterArchiveDelete()
        // 在刪除前重新確認「目前作用中學期」時，若用一般 getDoc()（SDK 可能優先回傳本機快取，
        // 視 persistence 設定與網路狀態而定），有機會讀到一份過期的 config，讓「目前學期」判斷
        // 失真——這是刪除前的最後一道防線，必須保證看到的是伺服器當下的真實值。
        getDocFromServer: mod.getDocFromServer,
        // Stage 1（讀取成本止血）：紀錄頁「載入更多」分頁用值游標（createdAt 值），
        // 不用 offset——offset 跳過的文件一樣計費讀取，見 RESEARCH-multitenancy-semester.md §5.4。
        startAfter:       mod.startAfter,
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
