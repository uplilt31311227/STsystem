#!/usr/bin/env node
/**
 * firestore.rules v2.12：V1 個人雲端備份路徑收斂（項目 7／M4）＋遺留路徑（L5）
 *
 * 原規則 users/{uid}/{document=**} 讓任何自行註冊的帳號可在自己的子樹無限寫入任意大小的文件。
 * 修補後只開放 V1 實際使用的單一文件 users/{uid}/data/substituteSystem
 * （cloudSyncService.getUserDocPath；legacyMigrationService 讀同一路徑），並加欄位白名單、
 * 大小約束與 email_verified；其他 users/** 路徑一律拒絕。
 *
 * 備份形狀：dataManager.exportForSync()（schoolName／scheduleData／teachers／classes／
 * substituteRecords／settings／lastModified／version）。
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-v1-backup.mjs（會清空並重建 emulator 資料）
 */
import { createDoc, updateDoc, getDoc, setDoc, deleteDoc, createTestUser, mergeDoc } from './emu-client.mjs';
import { Suite, allowed, denied, eq } from '../scenarios/harness.mjs';
import { setup, P, as, iso } from './kit.mjs';

const W = await setup();
const { chief, dir, t1 } = W;
const suite = new Suite('firestore.rules v2.12：V1 個人雲端備份路徑收斂（M4）與遺留路徑（L5）');

const U = (user) => `users/${user.localId}/data/substituteSystem`;
/** dataManager.exportForSync() + cloudSyncService.uploadToCloud 補上的 lastModified／version。 */
const backup = (over = {}) => ({
    schoolName: '示範國中',
    scheduleData: [{ teacher: '王老師', weekday: '週一', period: '第一節', className: '7年1班', subject: '國文' }],
    teachers: [{ name: '王老師', domains: ['語文'], homeCLASS: '' }],
    classes: ['7年1班'],
    substituteRecords: [{ id: '1', type: '代課', date: '2026-11-17' }],
    settings: { weeks: 18 },
    lastModified: iso(), version: 3,
    ...over,
});

await suite.case('7-a 已驗證本人：V1 備份文件 create／update／read／delete（V1 與 V2「清除資料」實際使用的操作）→ ALLOW', async () => {
    const me = await createTestUser('v1user@alpha.demo.test');
    allowed(await setDoc(U(me), backup(), as(me)), 'create（uploadToCloud setDoc）');
    allowed(await setDoc(U(me), backup({ version: 4 }), as(me)), 'update（覆寫）');
    const r = await getDoc(U(me), as(me));
    allowed(r, 'read（downloadFromCloud／即時同步／legacyMigrationService）');
    eq(r.data.version, 4, '讀回最新版本');
    allowed(await deleteDoc(U(me), as(me)), 'delete（V2 清除資料時刪除本人備份）');
});
await suite.case('7-b 攻擊：他人的 uid 路徑讀寫刪 → DENY', async () => {
    const a = await createTestUser('v1a@alpha.demo.test');
    const b = await createTestUser('v1b@alpha.demo.test');
    allowed(await setDoc(U(a), backup(), as(a)), '前置：a 的備份');
    denied(await getDoc(U(a), as(b)), 'b 讀 a');
    denied(await setDoc(U(a), backup(), as(b)), 'b 覆寫 a');
    denied(await deleteDoc(U(a), as(b)), 'b 刪 a');
    denied(await setDoc(U(a), backup(), as(dir)), '主任也不可寫他人個人備份');
});
await suite.case('7-c 攻擊：任意路徑／深層子集合／其他文件 id（無限寫入的原攻擊面）→ DENY', async () => {
    const me = await createTestUser('v1c@alpha.demo.test');
    const base = `users/${me.localId}`;
    denied(await createDoc(`${base}/data`, 'other', backup(), as(me)), 'data/other');
    denied(await createDoc(`${base}/a`, 'x', backup(), as(me)), 'a/x');
    denied(await createDoc(`${base}/data/substituteSystem/sub`, 'deep', backup(), as(me)), '深層子集合');
    for (let i = 0; i < 3; i++) denied(await createDoc(`${base}/junk`, `d${i}`, { blob: 'x'.repeat(1000) }, as(me)), `批量垃圾文件 ${i}`);
    denied(await getDoc(`${base}/data/other`, as(me)), '讀其他文件（路徑已不在規則內）');
});
await suite.case('7-d 攻擊：未驗證 email 的註冊帳號寫入 → DENY（讀取仍允許，不影響既有資料取回）；欄位白名單與大小約束', async () => {
    const un = await createTestUser('v1unv@alpha.demo.test', { emailVerified: false });
    denied(await setDoc(U(un), backup(), as(un)), '未驗證寫入');
    const me = await createTestUser('v1d@alpha.demo.test');
    denied(await setDoc(U(me), backup({ evil: 'x' }), as(me)), '多餘欄位');
    denied(await setDoc(U(me), backup({ scheduleData: Array.from({ length: 20001 }, (_, i) => i) }), as(me)), 'scheduleData 超過 20000');
    denied(await setDoc(U(me), backup({ schoolName: 'x'.repeat(201) }), as(me)), 'schoolName 超長');
    denied(await setDoc(U(me), backup({ teachers: 'not-a-list' }), as(me)), 'teachers 型別錯誤');
    denied(await setDoc(U(me), backup({ version: 'x' }), as(me)), 'version 非數字');
    allowed(await setDoc(U(me), backup({ scheduleData: Array.from({ length: 20000 }, (_, i) => ({ i })) }), as(me)), 'scheduleData 恰 20000（上限內）');
});
await suite.case('L5 舊課表路徑 data/{docId}：approver 寫入 → DENY（已無 client 寫入路徑）；成員讀取 → 維持', async () => {
    const p = `schools/${W.fixture.schoolId}/data/schedule`;
    denied(await setDoc(p, { scheduleData: [], updatedAt: iso() }, as(chief)), '組長寫舊路徑');
    denied(await setDoc(p, { scheduleData: [], updatedAt: iso() }, as(dir)), '主任寫舊路徑');
    allowed(await setDoc(p, { scheduleData: [], updatedAt: iso() }), 'owner（遷移腳本走 REST owner 憑證）仍可寫');
    allowed(await getDoc(p, as(t1)), '成員讀取（schoolDataService.subscribeSchedule 的 fallback）');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
