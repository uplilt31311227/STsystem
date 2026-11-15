#!/usr/bin/env node
/**
 * P6 併發案例（Firebase Emulator，經真實 firestore.rules 與真實交易隔離）
 *
 * 驗證「只成立一筆」：同節雙核准、同一張申請雙核准、組長代發連點、組長批次全有或全無。
 *
 * ⚠ 範圍說明：pendingRequestService.js 依賴瀏覽器端 Firebase SDK（CDN 動態載入），無法在 Node 載入。
 * 這裡以 Firestore REST 的 beginTransaction／batchGet／commit 重現 approveRequest／adminCreate 的寫入形狀，
 * 但「衝堂重驗」與「序號鎖協定」用的是正式程式碼本身：
 *   verifyNoAssignmentConflict（assignmentConflict.js）、runWithRecordsGuard／assertSeqUnchanged（recordsGuard.js）。
 * 因此驗證的是：協定本身、規則（recordsLock、紀錄建立）、emulator 的交易隔離三者合起來是否只成立一筆；
 * SDK 版的呼叫路徑由離線測試（test-p6-services.mjs）與 e2e 的核准流程涵蓋。
 *
 * 用法：先 npm run emu，再 node test/emulator/p6-concurrency.mjs（會清空並重建 emulator 資料）
 */
import { seedAll } from './seed.mjs';
import { signIn, getDoc, mustSetDoc, listDocs, toFirestoreFields, fromFirestoreFields, EMULATOR_INFO } from './emu-client.mjs';
import { Suite, ok, eq } from '../scenarios/harness.mjs';
import { verifyNoAssignmentConflict } from '../../src/js/modules/v2/assignmentConflict.js';
import { runWithRecordsGuard, assertSeqUnchanged, RecordsStaleError } from '../../src/js/modules/v2/recordsGuard.js';

const SCHOOL = 'demo-alpha';
const ROOT = `projects/${EMULATOR_INFO.PROJECT_ID}/databases/(default)/documents`;
const BASE = `http://${EMULATOR_INFO.FIRESTORE_HOST}/v1/${ROOT}`;
const P = {
    records: `schools/${SCHOOL}/substituteRecords`,
    pending: `schools/${SCHOOL}/pendingRequests`,
    lock:    `schools/${SCHOOL}/config/recordsLock`,
};
const iso = () => new Date().toISOString();

const seed = await seedAll({ quiet: true });
const current = (await getDoc(`schools/${SCHOOL}/config/main`)).data.currentSemester;
const chief = await signIn('t02@alpha.demo.test');
const dir   = await signIn('t01@alpha.demo.test');
const chiefT = seed.alpha.sectionChief, dirT = seed.alpha.director;
const [t1, t2, t3] = seed.alpha.teachers;

/* ---------- REST 交易 ---------- */
async function api(user, url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.idToken}` }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
}
/** 等同 SDK runTransaction：fn(tx) 內 tx.get 讀、tx.set／tx.update 排入寫入，結束時單一 commit。 */
async function restTx(user, fn) {
    const begin = await api(user, `${BASE}:beginTransaction`, {});
    if (!begin.ok) throw Object.assign(new Error('beginTransaction 失敗：' + JSON.stringify(begin.json)), { code: 'TX_BEGIN' });
    const txId = begin.json.transaction;
    const writes = [];
    const tx = {
        get: async (path) => {
            const g = await api(user, `${BASE}:batchGet`, { documents: [`${ROOT}/${path}`], transaction: txId });
            if (!g.ok) throw Object.assign(new Error('tx.get 失敗：' + JSON.stringify(g.json)), { code: 'TX_ABORTED' });
            const found = (g.json || []).find(x => x.found)?.found;
            return { exists: () => !!found, data: () => (found ? fromFirestoreFields(found.fields || {}) : undefined) };
        },
        set: (path, data) => writes.push({ update: { name: `${ROOT}/${path}`, fields: toFirestoreFields(data) } }),
        update: (path, patch) => writes.push({ update: { name: `${ROOT}/${path}`, fields: toFirestoreFields(patch) }, updateMask: { fieldPaths: Object.keys(patch) }, currentDocument: { exists: true } }),
    };
    let result;
    try { result = await fn(tx); }
    catch (e) {
        await api(user, `${BASE}:rollback`, { transaction: txId });
        // 讀取時被交易鎖擋下（ABORTED）：SDK 會自動重試 callback，這裡視同序號已被別人改過
        if (e.code === 'TX_ABORTED') throw new RecordsStaleError('交易衝突');
        throw e;
    }
    const commit = await api(user, `${BASE}:commit`, { writes, transaction: txId });
    if (!commit.ok) {
        // 交易衝突（ABORTED／鎖逾時）：SDK 會自動重試整個 callback；這裡視同序號已被別人改過，回到外層重新驗證
        if (commit.status === 409 || /ABORTED|contention|lock/i.test(JSON.stringify(commit.json))) throw new RecordsStaleError('交易衝突');
        throw Object.assign(new Error('commit 失敗：' + JSON.stringify(commit.json).slice(0, 300)), { code: 'TX_COMMIT', status: commit.status });
    }
    return result;
}
const lockSeq = async () => { const g = await getDoc(P.lock, { idToken: chief.idToken }); return g.ok ? (Number(g.data.seq) || 0) : 0; };
const queryRange = async ({ startDate, endDate }) => {
    const res = await listDocs(P.records, { idToken: chief.idToken });
    if (!res.ok) throw new Error('列出紀錄失敗 ' + res.status);
    const inR = (d) => d && d >= startDate && d <= endDate;
    return res.docs.filter(d => inR(d.date) || inR(d.swapDate)).map(d => ({ ...d, recordId: d.id }));
};
const countRecords = async (pred = () => true) => (await listDocs(P.records, { idToken: chief.idToken })).docs.filter(pred).length;
let recSeq = 0;
const newRecId = () => `zz_p6_rec_${Date.now()}_${recSeq++}`;

class AlreadyProcessed extends Error { constructor(m) { super(m); this.code = 'ALREADY_PROCESSED'; } }
class Conflict extends Error { constructor(m) { super(m); this.code = 'ASSIGNMENT_CONFLICT'; } }

/** approveRequest 的 REST 版（交易內容形狀與正式程式碼相同：讀申請、讀鎖、建紀錄、寫鎖、改申請）。 */
async function approve(reqId, user, me) {
    const recordId = newRecId();
    const pre = (await getDoc(`${P.pending}/${reqId}`, { idToken: user.idToken })).data;
    return runWithRecordsGuard({
        readSeq: lockSeq,
        verify: async () => {
            const hit = await verifyNoAssignmentConflict({ ...pre, reqId }, queryRange);
            if (hit) throw new Conflict(`衝堂：${hit.teacher} ${hit.date} ${hit.period}`);
        },
        commit: (seq) => restTx(user, async (tx) => {
            const snap = await tx.get(`${P.pending}/${reqId}`);
            if (snap.data().status !== 'pending_approval') throw new AlreadyProcessed('已被處理');
            const next = assertSeqUnchanged(await tx.get(P.lock), seq);
            const now = iso();
            const { reqId: _r, pendingConsentTeacherIds: _p, swapConsents: _s, ...rest } = snap.data();
            tx.set(`${P.records}/${recordId}`, { ...rest, status: 'approved', approvedAt: now, approvedBy: me.teacherId, approvedByName: me.name, fromRequestId: reqId, semesterId: current });
            tx.set(P.lock, { seq: next, updatedAt: now });
            tx.update(`${P.pending}/${reqId}`, { status: 'approved', approvedAt: now, approvedBy: me.teacherId, approvedByName: me.name, statusUpdatedAt: now });
        }),
    });
}
/** adminCreate／adminCreateBatch 的 REST 版：全部驗證通過後在同一個交易寫入全部紀錄。 */
async function adminCreateMany(payloads, user, me) {
    const ids = payloads.map(() => newRecId());
    return runWithRecordsGuard({
        readSeq: lockSeq,
        verify: async () => {
            for (const p of payloads) {
                const hit = await verifyNoAssignmentConflict({ ...p, adminOperatorId: me.teacherId }, queryRange);
                if (hit) throw new Conflict(`衝堂：${hit.teacher} ${hit.date} ${hit.period}`);
            }
        },
        commit: (seq) => restTx(user, async (tx) => {
            const next = assertSeqUnchanged(await tx.get(P.lock), seq);
            const now = iso();
            payloads.forEach((p, i) => tx.set(`${P.records}/${ids[i]}`, { ...p, status: 'approved', initiatedByRole: 'admin', adminOperatorId: me.teacherId, createdAt: now, approvedAt: now, semesterId: current }));
            tx.set(P.lock, { seq: next, updatedAt: now });
        }),
    });
}

const slotReq = (over = {}) => ({
    type: '代課', requestType: 'substitute', status: 'pending_approval', date: '2026-12-01', weekday: '週二', period: '第三節', className: '801', subject: '數學',
    originalTeacher: t1.name, originalTeacherId: t1.teacherId, substituteTeacher: t2.name, substituteTeacherId: t2.teacherId,
    initiatedBy: t1.teacherId, initiatedByName: t1.name, pendingConsentTeacherIds: [], swapConsents: {}, semesterId: current, createdAt: '2026-11-14T00:00:00.000Z', ...over,
});
const outcome = (settled) => ({
    ok: settled.filter(s => s.status === 'fulfilled').length,
    conflict: settled.filter(s => s.status === 'rejected' && s.reason.code === 'ASSIGNMENT_CONFLICT').length,
    already: settled.filter(s => s.status === 'rejected' && s.reason.code === 'ALREADY_PROCESSED').length,
    other: settled.filter(s => s.status === 'rejected' && !['ASSIGNMENT_CONFLICT', 'ALREADY_PROCESSED'].includes(s.reason.code)).map(s => String(s.reason?.message || s.reason)),
});

const suite = new Suite('P6 併發案例（emulator）：只成立一筆');

await suite.case('同節雙送：兩張申請搶同一班同一節（不同代課者），兩位核准者同時核准 → 只成立一筆', async () => {
    await mustSetDoc(`${P.pending}/zz_dup_a`, slotReq({ substituteTeacher: t2.name, substituteTeacherId: t2.teacherId }));
    await mustSetDoc(`${P.pending}/zz_dup_b`, slotReq({ substituteTeacher: t3.name, substituteTeacherId: t3.teacherId }));
    const before = await countRecords(r => r.date === '2026-12-01' && r.className === '801');
    const settled = await Promise.allSettled([approve('zz_dup_a', chief, chiefT), approve('zz_dup_b', dir, dirT)]);
    const o = outcome(settled);
    eq(o.other, [], '不應有非預期錯誤');
    eq(await countRecords(r => r.date === '2026-12-01' && r.className === '801'), before + 1, '同一班同一節成立的紀錄筆數');
    eq([o.ok, o.conflict], [1, 1], '一筆成立、一筆被判衝堂');
});

await suite.case('雙核准：同一張申請被兩位核准者同時核准 → 只成立一筆', async () => {
    await mustSetDoc(`${P.pending}/zz_twice`, slotReq({ date: '2026-12-02', weekday: '週三', className: '802' }));
    const settled = await Promise.allSettled([approve('zz_twice', chief, chiefT), approve('zz_twice', dir, dirT)]);
    const o = outcome(settled);
    eq(o.other, [], '不應有非預期錯誤');
    eq(await countRecords(r => r.date === '2026-12-02' && r.className === '802'), 1, '紀錄筆數');
    eq(o.ok, 1, '只有一次成功');
    ok(o.already + o.conflict === 1, `另一次是「已被處理」或衝堂（${JSON.stringify(o)}）`);
});

await suite.case('連點：組長代發同一筆代課連點 4 次（併發）→ 只成立一筆', async () => {
    const payload = { type: '代課', date: '2026-12-03', weekday: '週四', period: '第一節', className: '803', subject: '國語文',
        originalTeacher: t1.name, originalTeacherId: t1.teacherId, substituteTeacher: t2.name, substituteTeacherId: t2.teacherId,
        initiatedBy: t1.teacherId, initiatedByName: t1.name, id: 'zz_click' };
    const settled = await Promise.allSettled([1, 2, 3, 4].map(() => adminCreateMany([payload], chief, chiefT)));
    const o = outcome(settled);
    eq(o.other, [], '不應有非預期錯誤');
    eq(await countRecords(r => r.date === '2026-12-03' && r.className === '803'), 1, '紀錄筆數');
    eq([o.ok, o.conflict], [1, 3], '一次成功、三次被判衝堂');
});

await suite.case('核准與組長代發同時搶同一節 → 只成立一筆', async () => {
    await mustSetDoc(`${P.pending}/zz_vs_admin`, slotReq({ date: '2026-12-04', weekday: '週五', className: '804' }));
    const payload = { type: '代課', date: '2026-12-04', weekday: '週五', period: '第三節', className: '804', subject: '數學',
        originalTeacher: t1.name, originalTeacherId: t1.teacherId, substituteTeacher: t3.name, substituteTeacherId: t3.teacherId,
        initiatedBy: t1.teacherId, initiatedByName: t1.name, id: 'zz_vs' };
    const settled = await Promise.allSettled([approve('zz_vs_admin', chief, chiefT), adminCreateMany([payload], dir, dirT)]);
    const o = outcome(settled);
    eq(o.other, [], '不應有非預期錯誤');
    eq(await countRecords(r => r.date === '2026-12-04' && r.className === '804'), 1, '紀錄筆數');
});

await suite.case('已調課換走的時段 B：另一位組長再為被調走的老師代發代課 → 擋下（班級時段）', async () => {
    const swap = { type: '調課', date: '2026-12-08', weekday: '週二', period: '第三節', className: '805', subject: '數學', originalTeacher: t1.name, originalTeacherId: t1.teacherId,
        swapDate: '2026-12-15', swapWeekday: '週二', swapPeriod: '第二節', swapTeacher: t2.name, swapTeacherId: t2.teacherId, substituteTeacher: t2.name,
        leaveType: '調課', initiatedBy: t1.teacherId, initiatedByName: t1.name, id: 'zz_swap' };
    await adminCreateMany([swap], chief, chiefT);
    const sub = { type: '代課', date: '2026-12-15', weekday: '週二', period: '第二節', className: '805', subject: '國語文',
        originalTeacher: t2.name, originalTeacherId: t2.teacherId, substituteTeacher: t3.name, substituteTeacherId: t3.teacherId,
        initiatedBy: t2.teacherId, initiatedByName: t2.name, id: 'zz_sub_b' };
    const settled = await Promise.allSettled([adminCreateMany([sub], dir, dirT)]);
    eq(outcome(settled).conflict, 1, '被判衝堂');
    eq(await countRecords(r => r.date === '2026-12-15' && r.className === '805' && r.type === '代課'), 0, '沒有代課紀錄成立');
    // 被調進來的原任課教師（t1）請假代課 → 可以成立
    const legit = { ...sub, originalTeacher: t1.name, originalTeacherId: t1.teacherId, initiatedBy: t1.teacherId, initiatedByName: t1.name, id: 'zz_sub_legit' };
    await adminCreateMany([legit], dir, dirT);
    eq(await countRecords(r => r.date === '2026-12-15' && r.className === '805' && r.type === '代課'), 1, '被調進來的老師請假代課成立');
});

await suite.case('組長批次全有或全無：第 3 筆與既有紀錄衝堂 → 3 筆都不成立；修正後 3 筆一起成立（同一交易、鎖只加 1）', async () => {
    const leg = (i, over = {}) => ({ type: '調課', className: '806', batchId: 'zz_ab', batchSize: 3, date: `2026-12-1${i}`, weekday: '週四', period: '第三節', subject: '數學',
        originalTeacher: t1.name, originalTeacherId: t1.teacherId, swapDate: `2026-12-2${i}`, swapWeekday: '週四', swapPeriod: '第二節', swapTeacher: t2.name, swapTeacherId: t2.teacherId,
        substituteTeacher: t2.name, leaveType: '調課', initiatedBy: t1.teacherId, initiatedByName: t1.name, id: `zz_ab_${i}`, ...over });
    // 既有紀錄：t1 在 12-23 第二節（第 3 筆的時段 B）已被指派代別班
    await mustSetDoc(`${P.records}/zz_blocker`, { id: 'zz_blocker', type: '代課', status: 'approved', date: '2026-12-23', weekday: '週四', period: '第二節', className: '899',
        originalTeacher: '甲', substituteTeacher: t1.name, semesterId: current, createdAt: iso() });
    const seq0 = await lockSeq();
    const bad = await Promise.allSettled([adminCreateMany([leg(1), leg(2), leg(3)], chief, chiefT)]);
    eq(outcome(bad).conflict, 1, '整批被判衝堂');
    eq(await countRecords(r => r.batchId === 'zz_ab'), 0, '前兩筆也沒有成立');
    eq(await lockSeq(), seq0, '序號鎖沒有動');
    const good = await Promise.allSettled([adminCreateMany([leg(1), leg(2), leg(3, { swapDate: '2026-12-24' })], chief, chiefT)]);
    eq(outcome(good).ok, 1, '修正後整批成立');
    eq(await countRecords(r => r.batchId === 'zz_ab'), 3, '3 筆一起成立');
    eq(await lockSeq(), seq0 + 1, '序號鎖只加 1');
});

await suite.case('對照組（修前流程）：驗證在交易外、交易不讀序號鎖 → 同節雙核准會成立兩筆（證明競態真實存在，也是修前會紅的證據）', async () => {
    const approveOld = async (reqId, user, me) => {
        const recordId = newRecId();
        const pre = (await getDoc(`${P.pending}/${reqId}`, { idToken: user.idToken })).data;
        const hit = await verifyNoAssignmentConflict({ ...pre, reqId }, queryRange);
        if (hit) throw new Conflict('衝堂');
        await new Promise(r => setTimeout(r, 300));   // 讓兩邊都先通過驗證再提交（真實情境：驗證與提交之間的毫秒到秒級窗口）
        return restTx(user, async (tx) => {
            const snap = await tx.get(`${P.pending}/${reqId}`);
            if (snap.data().status !== 'pending_approval') throw new AlreadyProcessed('已被處理');
            const now = iso();
            tx.set(`${P.records}/${recordId}`, { ...snap.data(), status: 'approved', approvedAt: now, approvedBy: me.teacherId, fromRequestId: reqId, semesterId: current });
            tx.update(`${P.pending}/${reqId}`, { status: 'approved', approvedAt: now, approvedBy: me.teacherId, approvedByName: me.name, statusUpdatedAt: now });
        });
    };
    await mustSetDoc(`${P.pending}/zz_old_a`, slotReq({ date: '2026-12-09', weekday: '週三', className: '807', substituteTeacher: t2.name, substituteTeacherId: t2.teacherId }));
    await mustSetDoc(`${P.pending}/zz_old_b`, slotReq({ date: '2026-12-09', weekday: '週三', className: '807', substituteTeacher: t3.name, substituteTeacherId: t3.teacherId }));
    await Promise.allSettled([approveOld('zz_old_a', chief, chiefT), approveOld('zz_old_b', dir, dirT)]);
    eq(await countRecords(r => r.date === '2026-12-09' && r.className === '807'), 2, '修前流程：同一班同一節成立兩筆（兩位老師排進同一節）');
});

await suite.case('序號鎖不被跳號：直接以 REST 把 seq 改成比現值 +2 → 被規則拒絕（協定不可繞過）', async () => {
    const cur = await lockSeq();
    const res = await api(chief, `${BASE}:commit`, { writes: [{ update: { name: `${ROOT}/${P.lock}`, fields: toFirestoreFields({ seq: cur + 2, updatedAt: iso() }) } }] });
    eq(res.ok, false, '跳號被拒');
    eq(await lockSeq(), cur, '序號未變');
});

suite.print();
process.exit(suite.failed ? 1 : 0);
