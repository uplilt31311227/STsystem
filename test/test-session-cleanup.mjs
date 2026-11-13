/**
 * 登出／本機鏡像相關的四個小項（純 node、離線，用假 Firebase SDK）
 * 執行：node test/test-session-cleanup.mjs
 *
 *   (1) 被動登出（session 失效、他分頁登出）：沒有待寫入 → 連 Firestore 離線快取一起清；有待寫入 → 保留快取
 *   (2) V2 登入後不再從不帶後綴的舊 key 複製／回填；舊 key 仍留給 legacy 遷移偵測，且清除流程不會動它
 *   (3) 登出按鈕：等待待寫入期間停用並顯示「同步中…」、重入被擋、取消後還原
 *   (4) scripts/check-syntax.js 對 ES module 語法錯誤的反例自測（見該檔，這裡只確認它有被掛進測試）
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register('./helpers/gstatic-stub-loader.mjs', import.meta.url);

let reloads = 0;
const mkStore = (init = {}) => {
    const m = new Map(Object.entries(init));
    return {
        get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
        getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(),
        _keys: () => [...m.keys()],
    };
};
globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '', reload: () => { reloads++; } };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { getElementById: () => null };

const cleanup = await import('../src/js/modules/localDataCleanup.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}
const MIRROR = 'substituteSystemData:inhu';

/* ---------- (1) 被動登出 ---------- */
{
    const mkFm = (calls, pending) => ({
        waitForPendingWrites: () => (pending ? new Promise(() => {}) : Promise.resolve()),
        terminate: async () => calls.push('terminate'),
        clearIndexedDbPersistence: async () => calls.push('clearIndexedDb'),
    });
    const fresh = () => {
        globalThis.localStorage = mkStore({ [MIRROR]: '{}', substituteSystemData: 'v1-legacy', substituteSystemScheduleImports: '[]', [cleanup.LAST_UID_KEY]: 'uid1' });
        globalThis.sessionStorage = mkStore({ a: '1' });
        return globalThis.localStorage;
    };

    let calls = []; let ls = fresh();
    const r1 = await cleanup.wipeAfterPassiveSignOut({ db: { id: 1 }, fm: mkFm(calls, false), timeoutMs: 30, reload: false });
    check('(1) 被動登出且沒有待寫入 → pending=false、Firestore 離線快取被清（terminate＋clearIndexedDbPersistence）', r1.pending === false && calls.join() === 'terminate,clearIndexedDb', JSON.stringify({ r1, calls }));
    check('(1) 同時清除 school-scoped 鏡像與上次登入 uid；舊 key 與 V1 匯入紀錄保留',
        ls.getItem(MIRROR) === null && ls.getItem(cleanup.LAST_UID_KEY) === null && ls.getItem('substituteSystemData') === 'v1-legacy' && ls.getItem('substituteSystemScheduleImports') === '[]');

    calls = []; ls = fresh();
    const r2 = await cleanup.wipeAfterPassiveSignOut({ db: { id: 1 }, fm: mkFm(calls, true), timeoutMs: 30, reload: false });
    check('(1) 被動登出但有待寫入 → pending=true、保留 Firestore 離線快取（沒有 terminate／clear）', r2.pending === true && calls.length === 0, JSON.stringify({ r2, calls }));
    check('(1) 有待寫入時只清鏡像，保留上次登入 uid（切換帳號偵測仍有依據）', ls.getItem(MIRROR) === null && ls.getItem(cleanup.LAST_UID_KEY) === 'uid1');

    // （「預設會整頁重新載入」由 (3) 的成功登出案例涵蓋：wipeLocalUserData 重新載入後模組內 wiping 旗標不再重置，故放最後）
    // 被伺服器拒絕的待寫入（promise reject＝已被丟棄）視為沒有待寫入
    calls = []; fresh();
    const r3 = await cleanup.wipeAfterPassiveSignOut({ db: {}, fm: { ...mkFm(calls, false), waitForPendingWrites: async () => { throw new Error('denied'); } }, timeoutMs: 30, reload: false });
    check('(1) 待寫入被伺服器拒絕（已丟棄）→ 視為沒有，照常清快取', r3.pending === false && calls.includes('terminate'));
}

/* ---------- (2) V2 不再從舊 key 回填 ---------- */
{
    check('(2) v2MirrorKey 為 school-scoped', cleanup.v2MirrorKey('inhu') === MIRROR && cleanup.v2MirrorKey('x') === 'substituteSystemData:x');

    const src = readFileSync(new URL('../src/js/v2-app.js', import.meta.url), 'utf8');
    const m = /function applyV2LocalStorageKey\(schoolId\) \{[\s\S]*?\r?\n\}\r?\n/.exec(src);
    check('(2) 找得到 applyV2LocalStorageKey 原始碼', !!m);
    const body = m ? m[0] : '';
    check('(2) applyV2LocalStorageKey 不再讀寫 localStorage（沒有 getItem／setItem／舊 key 字面值）', !/getItem|setItem|removeItem|'substituteSystemData'/.test(body), body);

    // 行為：以假 window.app／localStorage 實際執行該函式，舊 key 有資料時新 key 仍保持空
    globalThis.localStorage = mkStore({ substituteSystemData: JSON.stringify({ scheduleData: [1], substituteRecords: [{ id: 'old' }] }) });
    const fakeWin = { app: {} };
    const fn = new Function('window', 'v2MirrorKey', `${body}\nreturn applyV2LocalStorageKey;`)(fakeWin, cleanup.v2MirrorKey);
    fn('inhu');
    check('(2) 預設學校登入後：getLocalStorageKey 指向新 key，新 key 沒有被塞入舊資料', fakeWin.app.getLocalStorageKey() === MIRROR && globalThis.localStorage.getItem(MIRROR) === null);
    check('(2) loadSavedData 會讀到的內容為空（不會從舊 key 回填）', globalThis.localStorage.getItem(fakeWin.app.getLocalStorageKey()) === null);
    check('(2) 舊 key 原封不動（留給 legacy 遷移）', globalThis.localStorage.getItem('substituteSystemData') !== null);

    const appSrc = readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
    check('(2) app.js 啟動時 V2 不讀舊 key（登入前不知道 schoolId）', /if \(!isV2Enabled\(\)\) this\.loadSavedData\(\);/.test(appSrc));

    const legacy = readFileSync(new URL('../src/js/modules/v2/legacyMigrationService.js', import.meta.url), 'utf8');
    check('(2) legacy 遷移偵測仍讀不帶後綴的舊 key', /LEGACY_LOCALSTORAGE_KEY = 'substituteSystemData'/.test(legacy) && /localStorage\.getItem\(LEGACY_LOCALSTORAGE_KEY\)/.test(legacy));
    check('(2) 清除流程永不清舊 key（遷移的唯一來源）', cleanup.NEVER_CLEAR_KEYS.includes('substituteSystemData'));
    globalThis.localStorage = mkStore({ substituteSystemData: 'x', [MIRROR]: 'y' });
    cleanup.clearLocalUserData(globalThis.localStorage, mkStore());
    check('(2) clearLocalUserData 實測：鏡像被清、舊 key 保留', globalThis.localStorage.getItem(MIRROR) === null && globalThis.localStorage.getItem('substituteSystemData') === 'x');
}

/* ---------- (3) 登出鈕：同步中…／重入 ---------- */
{
    const fbc = await import('../src/js/modules/firebaseConfig.js');
    await fbc.initializeFirebase();
    const auth = await import('../src/js/modules/authService.js');
    const F = (globalThis.__fake ||= { docs: new Map(), writes: [] });
    globalThis.localStorage = mkStore({ [MIRROR]: '{}' });
    globalThis.sessionStorage = mkStore();
    const btn = { textContent: '登出', disabled: false };
    const dialogs = [];

    // 3a：待寫入一直不完成（離線）→ 等待 5 秒逾時後跳確認框；取消 → 不登出、按鈕還原
    F.pendingWritesImpl = () => new Promise(() => {});
    globalThis.app = { confirmDialog: async (o) => { dialogs.push(o); return false; } };
    const t0 = Date.now();
    const p1 = auth.signOutWithButton(btn);
    await new Promise(r => setTimeout(r, 100));
    check('(3) 等待待寫入期間：按鈕停用並顯示「同步中…」', btn.disabled === true && btn.textContent === '同步中…', JSON.stringify(btn));
    check('(3) 等待期間 isSignOutInFlight() 為真', auth.isSignOutInFlight() === true);
    const dup = await auth.signOutUser();
    check('(3) 等待期間再次登出（重入）→ 被忽略（回傳 false），不跳第二個確認框', dup === false && dialogs.length === 0);
    const r1 = await p1;
    check(`(3) 逾時後跳「尚有未同步的變更」確認框（等待約 ${Math.round((Date.now() - t0) / 1000)} 秒）`, dialogs.length === 1 && dialogs[0].title.includes('未同步'));
    check('(3) 取消登出 → 回傳 false、旗標解除、按鈕還原、本機鏡像沒被清', r1 === false && auth.isSignOutInFlight() === false && btn.disabled === false && btn.textContent === '登出' && localStorage.getItem(MIRROR) === '{}');

    // 3b：沒有待寫入 → 直接登出（不顯示確認框），清鏡像並重新載入；之後可再次登出（旗標在失敗路徑才解除，成功時頁面已重載）
    F.pendingWritesImpl = async () => {};
    dialogs.length = 0; reloads = 0;
    const r2 = await auth.signOutWithButton({ textContent: '登出', disabled: false });
    check('(3) 沒有待寫入 → 直接登出成功、不跳確認框、清鏡像並重新載入', r2 === true && dialogs.length === 0 && reloads === 1 && localStorage.getItem(MIRROR) === null);
}

/* ---------- (4) check-syntax 自測有掛上 ---------- */
{
    const cs = readFileSync(new URL('../scripts/check-syntax.js', import.meta.url), 'utf8');
    check('(4) scripts/check-syntax.js 含反例自測（--self-test）', /--self-test/.test(cs));
}

process.stdout.write(`\n${failed ? '失敗' : '全部通過'}：通過 ${passed}、失敗 ${failed}\n`);
process.exit(failed ? 1 : 0);
