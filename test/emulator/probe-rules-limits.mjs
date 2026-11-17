#!/usr/bin/env node
/**
 * rules 資源上限量測（P9 批次 A2）：Firestore Security Rules 每次請求的文件存取上限（單筆讀寫 10 次、batch／transaction 20 次；
 * exists／get 都算，同一路徑重複呼叫會快取）與運算式評估上限（1000）。
 *
 * 量法（只用 emulator，不改 repo 的 firestore.rules；以 emulator 的 securityRules REST 暫時載入「變形後的規則文字」）：
 *   文件存取：在 isEmailVerified() 開頭（每個請求最先評估、之後都是快取命中）追加 N 個互不相同的 exists() 探針文件，
 *     對同一個請求找出「仍然 ALLOW 的最大 N」＝剩餘文件存取額度；已用量 = 上限 - 剩餘（上限 10 或 20）。
 *   運算式：在同一處追加 K 個「探針單位」，單位為 `request.auth.uid != 'zz'`。isEmailVerified 在不同請求內被評估的次數不同，
 *     所以直接以「剩餘額度（探針單位數）」做 v2.16 與 v2.17 的差量比較，並另用「文件探針數」不受影響的特性交叉驗證。
 *     運算式已用量的絕對值需乘上 isEmailVerified 的評估次數，這裡只回報差量（v2.17 比 v2.16 多用多少探針單位）。
 * 比較對象：git HEAD 的 firestore.rules（v2.16）與工作目錄的 firestore.rules（v2.17）。
 *
 * 用法：npx firebase emulators:exec --project demo-stsystem --only auth,firestore "node test/emulator/probe-rules-limits.mjs"
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDoc, updateDoc, mergeDoc, mustSetDoc, createTestUser, commitBatch, runTransaction } from './emu-client.mjs';
import { setup, as, iso, logEntry } from './kit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES_NOW = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const RULES_OLD = execSync('git show HEAD:firestore.rules', { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const RULES_URL = 'http://127.0.0.1:8080/emulator/v1/projects/demo-stsystem:securityRules';
const EV = "    function isEmailVerified() {\n      return request.auth != null && request.auth.token.email_verified == true;\n    }";

async function loadRules(text) {
    const res = await fetch(RULES_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: text }] } }) });
    if (!res.ok) throw new Error(`載入規則失敗 ${res.status}：${(await res.text()).slice(0, 300)}`);
}

function withProbe(rules, { docs = 0, expr = 0 }) {
    if (!rules.includes(EV)) throw new Error('找不到 isEmailVerified 定義（規則文字已變動，請更新 probe）');
    // 規則編譯器對單一運算式的大小有上限，所以探針拆成多個小函式（每個 4 個 exists 或 20 個探針單位）再串接
    const helpers = []; const calls = [];
    for (let i = 0; i < docs; i += 4) {
        const part = Array.from({ length: Math.min(4, docs - i) }, (_, k) => `(exists(/databases/$(database)/documents/zzprobe/d${i + k}) || true)`).join(' && ');
        helpers.push(`    function pd${i}() { return ${part}; }`); calls.push(` && pd${i}()`);
    }
    for (let i = 0; i < expr; i += 20) {
        const part = Array.from({ length: Math.min(20, expr - i) }, () => "request.auth.uid != 'zz'").join(' && ');
        helpers.push(`    function pe${i}() { return ${part}; }`); calls.push(` && pe${i}()`);
    }
    return rules.replace(EV, () => `${helpers.join('\n')}
    function isEmailVerified() {
      return request.auth != null && request.auth.token.email_verified == true${calls.join('')};
    }`);
}

const W = await setup();
const { semesterId, dir, chief, t1, t2 } = W;
const PA = W.seed.platformAdmin;
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`;

/** 每次嘗試用全新的學校，避免任何狀態殘留。 */
async function freshSchool() {
    const id = `zz-probe-${uniq()}`;
    const base = `schools/${id}`;
    await mustSetDoc(`${base}/config/main`, { schoolName: 'P', currentSemester: semesterId, initialAdminEmails: [dir.email], createdAt: iso(), updatedAt: iso() });
    const mk = async (role, name) => {
        const email = `pr_${uniq()}@probe.demo.test`;
        const u = await createTestUser(email);
        const teacherId = `tch_${uniq()}`;
        await mustSetDoc(`${base}/teachers/${teacherId}`, { name, email, domains: [], homeroomClass: '', role, createdAt: iso(), updatedAt: iso() });
        await mustSetDoc(`${base}/emailIndex/${email}`, { teacherId });
        await mustSetDoc(`${base}/userMappings/${u.localId}`, { linkedTeacherId: teacherId, email, lastLoginAt: iso() });
        return { ...u, teacherId, name, role, email };
    };
    return { id, base, mk };
}

const recBase = { date: '2026-11-17', weekday: '週二', period: '第三節', className: '7年1班', type: '代課', originalTeacher: '甲', substituteTeacher: '乙', status: 'approved', createdAt: '2026-11-07T00:00:00.000Z' };
const seedPend = async (S, id, by) => {
    await mustSetDoc(`${S.base}/pendingRequests/${id}`, { ...recBase, requestType: 'substitute', status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: {}, initiatedBy: by, initiatedByName: 'x', requiredApproverId: 'tch_x', semesterId, createdAt: iso() });
    return `${S.base}/pendingRequests/${id}`;
};

/** 各最壞路徑：回傳 { limit, run }，run() 內自行建立新學校與資料，回傳最後一個被評估請求的回應。 */
const PATHS = [
    { name: '核准申請交易（組長，成員）：建立紀錄＋申請轉 approved＋序號鎖', limit: 20, both: true, run: async () => {
        const S = await freshSchool(); const c = await S.mk('section_chief', '組長'); const t = await S.mk('teacher', '甲');
        await mustSetDoc(`${S.base}/config/recordsLock`, { seq: 1, updatedAt: iso() });
        const p = await seedPend(S, 'p1', t.teacherId);
        const now = iso();
        return runTransaction([p, `${S.base}/config/recordsLock`], ([snap]) => {
            const rec = { ...snap }; delete rec.pendingConsentTeacherIds; delete rec.swapConsents;
            Object.assign(rec, { status: 'approved', approvedAt: now, approvedBy: c.teacherId, approvedByName: c.name, fromRequestId: 'p1', affectedTeacherIds: [t.teacherId], semesterId });
            return [{ create: `${S.base}/substituteRecords/r1`, data: rec },
                { update: `${S.base}/config/recordsLock`, data: { seq: 2, updatedAt: now } },
                { update: p, data: { status: 'approved', approvedAt: now, approvedBy: c.teacherId, approvedByName: c.name, statusUpdatedAt: now } }];
        }, as(c));
    } },
    { name: '核准申請交易（platformAdmin，非成員，v2.17 新路徑）', limit: 20, both: false, run: async () => {
        const S = await freshSchool(); const t = await S.mk('teacher', '甲');
        await mustSetDoc(`${S.base}/config/recordsLock`, { seq: 1, updatedAt: iso() });
        const p = await seedPend(S, 'p1', t.teacherId);
        const now = iso();
        return runTransaction([p, `${S.base}/config/recordsLock`], ([snap]) => {
            const rec = { ...snap }; delete rec.pendingConsentTeacherIds; delete rec.swapConsents;
            Object.assign(rec, { status: 'approved', approvedAt: now, approvedBy: PA.localId, approvedByName: '平台管理員', fromRequestId: 'p1', affectedTeacherIds: [t.teacherId], semesterId });
            return [{ create: `${S.base}/substituteRecords/r1`, data: rec },
                { update: `${S.base}/config/recordsLock`, data: { seq: 2, updatedAt: now } },
                { update: p, data: { status: 'approved', approvedAt: now, approvedBy: PA.localId, approvedByName: '平台管理員', statusUpdatedAt: now } }];
        }, as(PA));
    } },
    { name: '教師建立待審申請父文件（一般教師，isApprover 為 false 的完整評估）', limit: 10, both: true, run: async () => {
        const S = await freshSchool(); const t = await S.mk('teacher', '甲'); await S.mk('teacher', '乙');
        const doc = { ...recBase, requestType: 'substitute', status: 'pending_approval', pendingConsentTeacherIds: [], swapConsents: {}, initiatedBy: t.teacherId, initiatedByName: t.name,
            originalTeacherId: t.teacherId, substituteTeacherId: 'tch_other', requiredApproverId: 'tch_other', semesterId, createdAt: iso() };
        return createDoc(`${S.base}/pendingRequests`, `req_${uniq()}`, doc, as(t));
    } },
    { name: '教師自我調課 private/detail 建立（父文件存在性檢查）', limit: 10, both: true, run: async () => {
        const S = await freshSchool(); const t = await S.mk('teacher', '甲');
        return createDoc(`${S.base}/substituteRecords/rec_${uniq()}/private`, 'detail', { leaveType: '調課', leaveTypeName: '調課', reason: 'x', allowedTeacherIds: [t.teacherId] }, as(t));
    } },
    { name: '首次登入自建 userMappings（isDirector 先評估再 isValidSelfMapping）', limit: 10, both: true, run: async () => {
        const S = await freshSchool();
        const email = `pr_${uniq()}@probe.demo.test`; const u = await createTestUser(email); const teacherId = `tch_${uniq()}`;
        await mustSetDoc(`${S.base}/teachers/${teacherId}`, { name: '新', email, domains: [], homeroomClass: '', role: 'teacher', createdAt: iso(), updatedAt: iso() });
        return createDoc(`${S.base}/userMappings`, u.localId, { email, googleName: null, googlePhotoUrl: null, lastProviderId: 'google.com', linkedTeacherId: teacherId, lastLoginAt: iso() }, as(u));
    } },
    { name: '日誌寫入（一般教師：myTeacherId＋姓名＋actorRoleOk）', limit: 10, both: true, run: async () => {
        const S = await freshSchool(); const t = await S.mk('teacher', '甲');
        return createDoc(`${S.base}/operationLogs`, `l${uniq()}`, logEntry({ ...t, localId: t.localId }, semesterId, 'create_request', 'pendingRequest', 'x'), as(t));
    } },
    { name: '日誌寫入（platformAdmin，非成員）', limit: 10, both: false, run: async () => {
        const S = await freshSchool();
        return createDoc(`${S.base}/operationLogs`, `l${uniq()}`, { timestamp: iso(), actor: { uid: PA.localId, email: PA.email, name: '平台管理員', role: 'director', teacherId: PA.localId }, action: 'approve', targetType: 'pendingRequest', targetId: 'x', details: {}, semesterId }, as(PA));
    } },
    { name: '主任建立教師檔＋emailIndex（createTeacher batch）', limit: 20, both: true, run: async () => {
        const S = await freshSchool(); const d = await S.mk('director', '主任');
        const id = `tch_${uniq()}`;
        return commitBatch([{ set: `${S.base}/teachers/${id}`, data: { name: '新', email: `n_${id}@p.test`, domains: [], homeroomClass: '', role: 'teacher', createdAt: iso(), updatedAt: iso() } }, { set: `${S.base}/emailIndex/n_${id}@p.test`, data: { teacherId: id } }], as(d));
    } },
    { name: '主任改 config/main（含 v2.17 旗標閘）', limit: 10, both: true, run: async () => {
        const S = await freshSchool(); const d = await S.mk('director', '主任');
        return mergeDoc(`${S.base}/config/main`, { schoolName: '改', updatedAt: iso() }, as(d));
    } },
    { name: '同意人同意申請（isValidConsenterUpdate）', limit: 10, both: true, run: async () => {
        const S = await freshSchool(); const t = await S.mk('teacher', '乙');
        await mustSetDoc(`${S.base}/pendingRequests/pc1`, { ...recBase, requestType: 'swap', status: 'pending_swap_consent', pendingConsentTeacherIds: [t.teacherId], swapConsents: {}, initiatedBy: 'tch_x', initiatedByName: 'x', semesterId, createdAt: iso() });
        const now = iso();
        return updateDoc(`${S.base}/pendingRequests/pc1`, { pendingConsentTeacherIds: [], swapConsents: { [t.teacherId]: { consentedAt: now } }, status: 'pending_approval', statusUpdatedAt: now }, as(t));
    } },
];

/** 二分搜尋：回傳仍 ALLOW 的最大探針數（0 起算；0 都失敗回 -1；到 cap 仍 ALLOW 回 cap）。 */
async function maxOk(rules, runner, kind, cap) {
    const ok = async (n) => { await loadRules(withProbe(rules, { [kind]: n })); return (await runner()).ok; };
    if (!(await ok(0))) return -1;
    let lo = 0, hi = cap;
    if (await ok(hi)) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await ok(mid)) lo = mid; else hi = mid; }
    return lo;
}

const rows = [];
try {
    for (const p of PATHS) {
        const out = { name: p.name, limit: p.limit };
        for (const [label, rules] of [['v216', RULES_OLD], ['v217', RULES_NOW]]) {
            if (label === 'v216' && !p.both) continue;
            const docs = await maxOk(rules, p.run, 'docs', 24);
            const expr = await maxOk(rules, p.run, 'expr', 100);
            out[label] = { docsHeadroom: docs, exprHeadroom: expr };
        }
        rows.push(out);
        const f = (x) => x ? `剩餘文件額度 ${x.docsHeadroom}（已用 ${x.docsHeadroom < 0 ? '？' : p.limit - x.docsHeadroom}／${p.limit}）、運算式探針剩餘 ${x.exprHeadroom}` : '（不適用）';
        console.log(`\n${p.name}\n   v2.16：${f(out.v216)}\n   v2.17：${f(out.v217)}`);
    }
} finally {
    await loadRules(RULES_NOW);   // 還原成工作目錄版本（emulator 本身也會在結束時關閉）
}
console.log('\n（探針單位＝`request.auth.uid != \'zz\'` 追加在 isEmailVerified()，其評估次數因請求而異；差量越小越好，v2.17 與 v2.16 的差代表新規則多用的額度）');
process.exit(0);
