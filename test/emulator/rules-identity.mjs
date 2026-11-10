#!/usr/bin/env node
/**
 * firestore.rules v2.12：身分與授權修補
 *   項目 1（H1）  以 token.email 作為身分依據的地方一律要求 email_verified：
 *                 userMappings 自建、白名單主任（isInitialDirector）、emailIndex 讀取、成員資格
 *   項目 2（H2）  mapping 不再永不撤銷：成員資格與角色要求「教師檔存在且 email 與登入者相符」；
 *                 刪除教師／改 email 後原帳號立即失效；approver 可查、director 可刪對應 mapping
 *   附：跨校隔離補測（審計「漏測路徑」12–15）：他校對 pendingRequests／schedules／operationLogs／
 *       userMappings／archives／joinAttempts 的 get 與 list、joinAttempts 偽造 email、archives 生命週期
 *
 * Auth emulator 的 token 是否帶 email_verified 由 emu-client 的 createTestUser／setEmailVerified 控制
 * （測試 helper 專用，firestore.rules 內沒有任何後門）。
 *
 * 用法：先 npm run emu，再 node test/emulator/rules-identity.mjs（會清空並重建 emulator 資料）
 */
import {
    createDoc, updateDoc, getDoc, setDoc, deleteDoc, listDocs, mustSetDoc, mergeDoc,
    createTestUser, setEmailVerified, runQuery, commitBatch,
} from './emu-client.mjs';
import { Suite, allowed, denied, eq, ok } from '../scenarios/harness.mjs';
import { setup, P, as, iso, logEntry, buildPending, buildSelfSwap } from './kit.mjs';

const W = await setup();
const { semesterId, dir, chief, t1, t2, t3, t4, beta, outsider } = W;
const suite = new Suite('firestore.rules v2.12：未驗證 email 與 mapping 撤銷（H1／H2）＋跨校隔離補測');
const rid = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

/** 建立一位「有教師檔與 emailIndex、尚未有任何 Auth 帳號」的教師（被搶註的受害者）。 */
async function seedVictim(slug, role = 'teacher') {
    const email = `${slug}@alpha.demo.test`;
    const teacherId = `tch_${slug}`;
    await mustSetDoc(`${P.teachers}/${teacherId}`, { name: `受害者${slug}`, email, domains: [], homeroomClass: '', role, createdAt: iso(), updatedAt: iso() });
    await mustSetDoc(`${P.emailIdx}/${email}`, { teacherId });
    return { email, teacherId };
}
const mappingBody = (teacherId, email) => ({ linkedTeacherId: teacherId, email, googleName: null, googlePhotoUrl: null, lastProviderId: 'password', lastLoginAt: iso() });

/* ===================== 項目 1：未驗證 email 不得綁定教師身分 ===================== */

await suite.case('1-a 搶註：未驗證帳號用受害者 email → emailIndex 讀取 DENY、自建 mapping DENY、讀教師名冊 DENY', async () => {
    const v = await seedVictim('victim1', 'section_chief');
    const squatter = await createTestUser(v.email, { emailVerified: false });
    denied(await getDoc(`${P.emailIdx}/${v.email}`, as(squatter)), '未驗證讀 emailIndex');
    denied(await createDoc(P.mappings, squatter.localId, mappingBody(v.teacherId, v.email), as(squatter)), '未驗證自建 mapping');
    eq((await getDoc(`${P.mappings}/${squatter.localId}`)).ok, false, 'mapping 未建立');
    denied(await listDocs(P.teachers, as(squatter)), '未驗證讀教師名冊');
});
await suite.case('1-b 同一帳號完成 email 驗證後 → emailIndex 讀取 ALLOW、自建 mapping ALLOW、成員讀取與 approver 角色成立（正常流程）', async () => {
    const v = await seedVictim('victim2', 'section_chief');
    const u0 = await createTestUser(v.email, { emailVerified: false });
    denied(await createDoc(P.mappings, u0.localId, mappingBody(v.teacherId, v.email), as(u0)), '驗證前自建被拒');
    const u = await setEmailVerified(v.email, true);   // 模擬使用者點了驗證連結後 getIdToken(true)
    allowed(await getDoc(`${P.emailIdx}/${v.email}`, as(u)), '驗證後讀 emailIndex');
    allowed(await createDoc(P.mappings, u.localId, mappingBody(v.teacherId, v.email), as(u)), '驗證後自建 mapping');
    allowed(await listDocs(P.teachers, as(u)), '成員讀教師名冊');
    allowed(await listDocs(P.logs, as(u)), '組長角色讀操作日誌（approver）');
});
await suite.case('1-c 白名單主任：未驗證的白名單 email 不被視為主任（讀 config／bootstrap 建教師檔／寫 config 全 DENY）；驗證後 ALLOW', async () => {
    const boss = 'boss@alpha.demo.test';
    const cfg = (await getDoc(P.config)).data;
    await mustSetDoc(P.config, { ...cfg, initialAdminEmails: [...cfg.initialAdminEmails, boss] });
    const u0 = await createTestUser(boss, { emailVerified: false });
    const bootstrapTeacher = { name: '老闆', email: boss, domains: [], homeroomClass: '', role: 'director', createdAt: iso(), updatedAt: iso() };
    denied(await getDoc(P.config, as(u0)), '未驗證白名單主任讀 config');
    denied(await createDoc(P.teachers, 'tch_boss', bootstrapTeacher, as(u0)), '未驗證白名單主任 bootstrap 建教師檔');
    denied(await mergeDoc(P.config, { schoolName: '被改名' }, as(u0)), '未驗證白名單主任寫 config');
    denied(await listDocs(P.logs, as(u0)), '未驗證白名單主任讀操作日誌');
    const u = await setEmailVerified(boss, true);
    allowed(await getDoc(P.config, as(u)), '驗證後讀 config');
    allowed(await createDoc(P.teachers, 'tch_boss', bootstrapTeacher, as(u)), '驗證後 bootstrap 建教師檔');
    allowed(await listDocs(P.logs, as(u)), '驗證後讀操作日誌');
});
await suite.case('1-d 既有成員的帳號若 email_verified 為 false → 一律失去成員資格（含 approver 角色）；恢復驗證後恢復', async () => {
    const u0 = await setEmailVerified(chief.email, false);
    denied(await listDocs(P.teachers, as(u0)), '未驗證的既有組長讀名冊');
    denied(await listDocs(P.logs, as(u0)), '未驗證的既有組長讀日誌');
    const u1 = await setEmailVerified(chief.email, true);
    allowed(await listDocs(P.logs, as(u1)), '恢復驗證後讀日誌');
    chief.idToken = u1.idToken;
});
await suite.case('1-e 大小寫：教師檔 email 小寫、Auth 帳號 email 混合大小寫 → 已驗證仍可自建 mapping（沿用 .lower() 既有慣例）', async () => {
    const slug = 'casey';
    const v = await seedVictim(slug);
    const u = await createTestUser('Casey@Alpha.Demo.Test');
    allowed(await createDoc(P.mappings, u.localId, mappingBody(v.teacherId, v.email), as(u)), '混合大小寫 email 自建 mapping');
    allowed(await listDocs(P.teachers, as(u)), '混合大小寫 email 的成員讀取');
});
await suite.case('1-f 自建 mapping 指向「別人的教師檔」（email 不符）或夾帶任意欄位 → DENY（既有防線不退步）', async () => {
    const v = await seedVictim('victim3');
    const u = await createTestUser('mallory@alpha.demo.test');
    denied(await createDoc(P.mappings, u.localId, mappingBody(v.teacherId, 'mallory@alpha.demo.test'), as(u)), 'email 不符');
    denied(await createDoc(P.mappings, u.localId, mappingBody(dir.teacherId, 'mallory@alpha.demo.test'), as(u)), '指向主任教師檔');
    await seedVictim('mallory');
    denied(await createDoc(P.mappings, u.localId, { ...mappingBody('tch_mallory', 'mallory@alpha.demo.test'), role: 'director' }, as(u)), '夾帶任意欄位');
    denied(await createDoc(P.mappings, u.localId, { ...mappingBody('tch_mallory', 'x@elsewhere.test') }, as(u)), 'mapping.email 非本人');
});

await suite.case('1-g 既有成員每次登入的 mapping 合併更新（upsertUserMapping 的 merge 寫入）→ ALLOW；塞入非白名單欄位 → DENY', async () => {
    allowed(await updateDoc(`${P.mappings}/${t2.localId}`, { lastLoginAt: iso(), lastProviderId: 'google.com', googleName: '王大明', googlePhotoUrl: null }, as(t2)), '登入更新 mapping');
    denied(await updateDoc(`${P.mappings}/${t2.localId}`, { isAdmin: true }, as(t2)), '夾帶非白名單欄位');
    denied(await updateDoc(`${P.mappings}/${t2.localId}`, { linkedTeacherId: dir.teacherId }, as(t2)), '把 mapping 改指向主任教師檔');
});

/* ===================== 項目 2：mapping 撤銷（教師被刪除／email 被改） ===================== */

await suite.case('2-a 教師檔被刪除 → 原帳號的成員讀取、自建紀錄／申請、寫日誌全部 DENY（刪除前皆 ALLOW）', async () => {
    const swap = buildSelfSwap(W, t3);
    const pend = buildPending(W, t3);
    // 刪除前：成員正常
    allowed(await listDocs(P.teachers, as(t3)), '刪除前讀名冊');
    allowed(await createDoc(P.logs, rid('log'), logEntry(t3, semesterId), as(t3)), '刪除前寫日誌');
    // owner 刪除教師檔（不動 mapping，模擬舊版 deleteTeacher 只刪教師檔與 emailIndex 的殘留狀態）
    allowed(await deleteDoc(`${P.teachers}/${t3.teacherId}`), 'owner 刪除教師檔');
    eq((await getDoc(`${P.mappings}/${t3.localId}`)).ok, true, '孤兒 mapping 仍在');
    denied(await listDocs(P.teachers, as(t3)), '刪除後讀名冊');
    denied(await getDoc(`${P.records}/${W.fixture.substituteRecords[0].recordId}`, as(t3)), '刪除後讀紀錄');
    denied(await listDocs(P.pending, as(t3)), '刪除後讀申請');
    denied(await createDoc(`${P.records}/${swap.recordId}/private`, 'detail', swap.privateDoc, as(t3)), '刪除後自建 private');
    denied(await createDoc(P.records, swap.recordId, swap.publicDoc, as(t3)), '刪除後自建自我調課紀錄');
    denied(await createDoc(P.pending, pend.reqId, pend.publicDoc, as(t3)), '刪除後自建申請');
    denied(await createDoc(P.logs, rid('log'), logEntry(t3, semesterId), as(t3)), '刪除後寫日誌');
});
await suite.case('2-b 教師 email 被改掉 → 舊帳號立即失效（含 approver 角色）；新 email 帳號 emailIndex → 自建 mapping → ALLOW', async () => {
    // t4 先升為組長，才能證明「角色」也被撤銷
    await mergeDoc(`${P.teachers}/${t4.teacherId}`, { role: 'section_chief' });
    allowed(await listDocs(P.logs, as(t4)), '改 email 前：組長可讀日誌');
    const newEmail = 'renamed4@alpha.demo.test';
    await mergeDoc(`${P.teachers}/${t4.teacherId}`, { email: newEmail });
    await mustSetDoc(`${P.emailIdx}/${newEmail}`, { teacherId: t4.teacherId });
    await deleteDoc(`${P.emailIdx}/${t4.email}`);
    // 舊帳號（mapping 仍在，指向同一 teacherId）
    denied(await listDocs(P.teachers, as(t4)), '舊帳號讀名冊');
    denied(await listDocs(P.logs, as(t4)), '舊帳號讀日誌（原 approver 角色不再生效）');
    denied(await createDoc(P.logs, rid('log'), logEntry(t4, semesterId), as(t4)), '舊帳號寫日誌');
    denied(await updateDoc(`${P.pending}/${W.fixture.pendingRequests[0].reqId}`, { status: 'rejected' }, as(t4)), '舊帳號駁回申請');
    // 舊帳號想重新綁定回該教師檔 → email 不符
    denied(await setDoc(`${P.mappings}/${t4.localId}`, mappingBody(t4.teacherId, t4.email), as(t4)), '舊帳號重建 mapping');
    // 新 email 帳號：正常登入流程（emailIndex → mapping → 成員）
    const u = await createTestUser(newEmail);
    allowed(await getDoc(`${P.emailIdx}/${newEmail}`, as(u)), '新帳號讀 emailIndex');
    allowed(await createDoc(P.mappings, u.localId, mappingBody(t4.teacherId, newEmail), as(u)), '新帳號自建 mapping');
    allowed(await listDocs(P.teachers, as(u)), '新帳號讀名冊');
    allowed(await listDocs(P.logs, as(u)), '新帳號保有組長角色（讀日誌）');
});
await suite.case('2-c 服務層配套：director 可查（linkedTeacherId == X）並以單一原子批次刪除教師檔＋emailIndex＋mapping；組長不可刪 mapping', async () => {
    const victim = await seedVictim('victim4');
    const u = await createTestUser(victim.email);
    allowed(await createDoc(P.mappings, u.localId, mappingBody(victim.teacherId, victim.email), as(u)), '前置：建立 mapping');
    const q = { from: [{ collectionId: 'userMappings' }], where: { fieldFilter: { field: { fieldPath: 'linkedTeacherId' }, op: 'EQUAL', value: { stringValue: victim.teacherId } } } };
    const dirQ = await runQuery(`schools/${W.fixture.schoolId}`, q, as(dir));
    allowed(dirQ, 'director 以 linkedTeacherId 查 mapping（updateTeacher／deleteTeacher 使用的查詢）');
    eq(dirQ.docs.map(d => d.id), [u.localId], '查得到該教師的 mapping');
    allowed(await runQuery(`schools/${W.fixture.schoolId}`, q, as(chief)), '組長（approver）亦可查');
    denied(await runQuery(`schools/${W.fixture.schoolId}`, q, as(t2)), '一般教師不可 list mappings');
    denied(await deleteDoc(`${P.mappings}/${u.localId}`, as(chief)), '組長不可刪 mapping（director 專屬，與 deleteTeacher／改 email 同層級）');
    // deleteTeacher 的批次：delete 教師檔 + delete emailIndex + delete mapping
    allowed(await commitBatch([
        { delete: `${P.teachers}/${victim.teacherId}` },
        { delete: `${P.emailIdx}/${victim.email}` },
        { delete: `${P.mappings}/${u.localId}` },
    ], as(dir)), 'director 原子批次刪除');
    eq((await getDoc(`${P.mappings}/${u.localId}`)).ok, false, 'mapping 已刪除');
    eq((await getDoc(`${P.teachers}/${victim.teacherId}`)).ok, false, '教師檔已刪除');
    denied(await listDocs(P.teachers, as(u)), '被刪除教師的帳號失去成員資格');
});
await suite.case('2-d 服務層配套：updateTeacher 改 email 的批次（update 教師檔、刪舊 emailIndex、寫新 emailIndex、刪舊 mapping）→ director ALLOW', async () => {
    const victim = await seedVictim('victim5');
    const u = await createTestUser(victim.email);
    allowed(await createDoc(P.mappings, u.localId, mappingBody(victim.teacherId, victim.email), as(u)), '前置：建立 mapping');
    const newEmail = 'victim5-new@alpha.demo.test';
    const cur = (await getDoc(`${P.teachers}/${victim.teacherId}`)).data;
    allowed(await commitBatch([
        { set: `${P.teachers}/${victim.teacherId}`, data: { ...cur, email: newEmail, updatedAt: iso() } },
        { delete: `${P.emailIdx}/${victim.email}` },
        { set: `${P.emailIdx}/${newEmail}`, data: { teacherId: victim.teacherId } },
        { delete: `${P.mappings}/${u.localId}` },
    ], as(dir)), 'director 改 email 批次');
    denied(await listDocs(P.teachers, as(u)), '舊帳號失效');
    eq((await getDoc(`${P.emailIdx}/${victim.email}`, as(u))).ok, false, '舊 emailIndex 已刪（自己的 email 可 get，但文件已不存在）');
});

/* ===================== 跨校隔離補測（審計漏測路徑 12–15） ===================== */

await suite.case('X-1 他校主任對本校 pendingRequests／schedules／operationLogs／userMappings／archives／joinAttempts 的 get 與 list → 全部 DENY', async () => {
    const bd = beta.director;
    const paths = [
        `${P.pending}/${W.fixture.pendingRequests[0].reqId}`, `schools/${W.fixture.schoolId}/schedules/${semesterId}`,
        `${P.logs}/${W.fixture.operationLogs[0].logId}`, `${P.mappings}/${dir.localId}`, `${P.attempts}/${dir.localId}`,
        `schools/${W.fixture.schoolId}/archives/114-2`, `${P.emailIdx}/${dir.email}`,
    ];
    for (const p of paths) denied(await getDoc(p, as(bd)), `他校主任 get ${p.split('/').slice(2).join('/')}`);
    for (const c of [P.pending, P.logs, P.mappings, P.attempts, P.emailIdx, P.teachers, P.records, `schools/${W.fixture.schoolId}/schedules`]) {
        denied(await listDocs(c, as(bd)), `他校主任 list ${c.split('/').slice(2).join('/')}`);
    }
});
await suite.case('X-2 他校主任代寫本校 userMappings／teachers／config → DENY；外部人士 list 本校紀錄 → DENY', async () => {
    const bd = beta.director;
    denied(await createDoc(P.mappings, 'zz_uid', { linkedTeacherId: t1.teacherId }, as(bd)), '他校主任代寫 mapping');
    denied(await createDoc(P.teachers, 'tch_zz', { name: 'x', email: 'x@x.test', role: 'director' }, as(bd)), '他校主任建教師檔');
    denied(await mergeDoc(P.config, { schoolName: 'x' }, as(bd)), '他校主任改 config');
    denied(await listDocs(P.records, as(outsider)), '外部人士 list 紀錄');
});
await suite.case('X-3 list 查詢的角色限制：一般教師 list operationLogs／userMappings／emailIndex → DENY；組長 → ALLOW；成員 list 紀錄與名冊 → ALLOW', async () => {
    const teacher = W.seed.alpha.teachers[5];
    denied(await listDocs(P.logs, as(teacher)), '教師 list 日誌');
    denied(await listDocs(P.mappings, as(teacher)), '教師 list mappings');
    denied(await listDocs(P.emailIdx, as(teacher)), '教師 list emailIndex');
    allowed(await listDocs(P.logs, as(chief)), '組長 list 日誌');
    allowed(await listDocs(P.mappings, as(chief)), '組長 list mappings');
    allowed(await listDocs(P.emailIdx, as(chief)), '組長 list emailIndex');
    allowed(await listDocs(P.records, as(teacher)), '成員 list 紀錄');
    allowed(await listDocs(P.teachers, as(teacher)), '成員 list 名冊');
});
await suite.case('X-4 joinAttempts：email 欄位偽造他人 → DENY；本人 email → ALLOW；讀取僅 approver', async () => {
    const out2 = await createTestUser('visitor@nowhere.test');
    denied(await setDoc(`${P.attempts}/${out2.localId}`, { email: dir.email, attemptedAt: iso(), reason: 'no_teacher_match' }, as(out2)), '偽造主任 email');
    allowed(await setDoc(`${P.attempts}/${out2.localId}`, { email: 'visitor@nowhere.test', attemptedAt: iso(), reason: 'no_teacher_match' }, as(out2)), '本人 email（前端 logJoinAttempt 形狀）');
    denied(await getDoc(`${P.attempts}/${out2.localId}`, as(t2)), '一般教師讀 joinAttempts');
    allowed(await getDoc(`${P.attempts}/${out2.localId}`, as(chief)), '組長讀 joinAttempts');
});
await suite.case('X-5 archives 生命週期：director 可 create；組長不可 create；任何人不可 update／delete', async () => {
    const body = { semesterId: '114-2', archivedAt: iso(), archivedBy: { uid: dir.localId }, counts: { records: 1 }, jsonHash: 'abc' };
    const path = `schools/${W.fixture.schoolId}/archives/114-2`;
    denied(await createDoc(`schools/${W.fixture.schoolId}/archives`, '114-2', body, as(chief)), '組長 create');
    allowed(await createDoc(`schools/${W.fixture.schoolId}/archives`, '114-2', body, as(dir)), '主任 create');
    denied(await updateDoc(path, { jsonHash: 'tampered' }, as(dir)), '主任 update');
    denied(await deleteDoc(path, as(dir)), '主任 delete');
});
await suite.case('X-6 已知缺口（非本階段）：組長可改任意教師檔欄位（含主任的 name）——前端 H2（innerHTML 輸出姓名）的 source', async () => {
    // 規則目前只鎖 role／email 不可由組長改；name 等欄位不受限。前端輸出跳脫由另一階段處理。
    allowed(await mergeDoc(`${P.teachers}/${dir.teacherId}`, { name: '李士箴' }, as(chief)), '組長改主任 name（同值，不污染資料）');
}, { knownGap: '組長可寫教師檔任意欄位（teachers update 的 approver 分支只鎖 role／email）；建議後續加 hasOnly 與字元限制' });

suite.print();
process.exit(suite.failed ? 1 : 0);
