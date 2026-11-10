/**
 * V1 個人雲端即時同步：收到雲端快照（含自己寫入的回音）時不可再回寫。
 * 回歸 2026-11-09 正式站事故：寫入 → 回音快照 → loadFromCloud → onDataChange → syncToCloud → 寫入……
 * 單一分頁每秒 1–2 次整份 setDoc，兩天 76 GiB 對外流量。
 *
 * 以 module.register 的 resolve hook 把 firebaseConfig.js / authService.js 換成 stub，
 * 用假的 onSnapshot/setDoc 模擬 Firestore：每次 setDoc 成功後把資料以
 * hasPendingWrites=false 的快照推回（與真實 Firestore 伺服器確認後的行為一致）。
 * 監聽回呼採用與 app.js enableRealtimeSyncAndListen() 相同的判斷。
 *
 * 執行：node test/test-v1-realtime-loop.mjs
 */
import { register } from 'node:module';

const stubs = {
    'firebaseConfig.js': `
        export function getDbInstance() { return {}; }
        export function isFirebaseInitialized() { return true; }
        export function initializeFirebase() {}
        export function getAuthInstance() { return {}; }`,
    'authService.js': `
        export function isSignedIn() { return true; }
        export function getUserId() { return 'uid-test'; }`,
};
const hook = `
const stubs = ${JSON.stringify(stubs)};
export async function resolve(spec, ctx, next) {
    for (const [name, src] of Object.entries(stubs)) {
        if (spec.endsWith('/' + name) && ctx.parentURL && ctx.parentURL.includes('/src/js/modules/')) {
            return { url: 'data:text/javascript,' + encodeURIComponent(src), shortCircuit: true };
        }
    }
    return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hook));

// ---- 假 Firestore ----
let writeCount = 0;
let listener = null;
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
window.firebaseModules = {
    doc: (_db, path) => ({ path }),
    setDoc: async (_ref, data) => {
        writeCount++;
        // 伺服器確認後推回快照（回音）
        setTimeout(() => listener?.({ exists: () => true, data: () => data, metadata: { hasPendingWrites: false } }), 0);
    },
    onSnapshot: (_ref, onNext) => { listener = onNext; return () => { listener = null; }; },
};

const { DataManager } = await import('../src/js/modules/dataManager.js');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) pass++; else { fail++; console.error('✗ ' + label); } }
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

const dm = new DataManager();
dm.enableRealtimeSync();
// 與 app.js enableRealtimeSyncAndListen() 的回呼同邏輯
dm.onDataChange(async (_data, meta = {}) => {
    if (meta.fromRealtime) return;
    await dm.syncToCloud();
});

// 1. 本機一次變更 → 恰好寫入一次，回音不會再觸發寫入
await dm.syncToCloud();
await tick(200);
ok(writeCount === 1, `本機一次變更只寫入 1 次（實得 ${writeCount}）`);

// 2. 他機推來的變更 → 套用但不回寫
const before = writeCount;
listener({ exists: () => true, data: () => ({ schoolName: '他機', version: 999, lastModified: new Date().toISOString() }), metadata: { hasPendingWrites: false } });
await tick(200);
ok(dm.schoolName === '他機', '他機變更已套用到本機');
ok(writeCount === before, `他機變更不回寫（多寫了 ${writeCount - before} 次）`);

// 3. 非即時來源的 loadFromCloud（合併等）仍會通知且可回寫
let sawNonRealtime = false;
dm.onDataChange((_d, meta = {}) => { if (!meta.fromRealtime) sawNonRealtime = true; });
dm.loadFromCloud({ schoolName: '合併' });
ok(sawNonRealtime, '非即時來源仍以 fromRealtime=false 通知');

dm.disableRealtimeSync();
await tick(100);
console.log(`\n結果：通過 ${pass}，失敗 ${fail}（總寫入 ${writeCount}）`);
process.exit(fail === 0 ? 0 : 1);
