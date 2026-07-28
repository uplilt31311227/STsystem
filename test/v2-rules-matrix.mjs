#!/usr/bin/env node
/**
 * V2 Firestore 規則 allow/deny 矩陣測試
 *
 * 目的：firestore.rules（v2.2，三層角色）從未有自動化測試，每次改規則都靠人肉推理。
 * 本檔直接打 Firestore REST API（純 node 內建 fetch，無外部依賴），驗證 26 個
 * 正向／攻擊案例是否符合預期的 ALLOW/DENY。
 *
 * 用法：node test/v2-rules-matrix.mjs
 *
 * 憑證來源：環境變數 STSYSTEM_TEST_CREDS 指向的 JSON 檔，未設定時 fallback 到
 * scratchpad 路徑（見 FALLBACK_CREDS_PATH）。檔案需含 v2t1/v2t2/v2t3 三把 key，
 * 各自至少要有 email + refreshToken（或 password）。密碼與 idToken 一律不寫死在
 * 本檔——idToken 一律在執行當下用 refreshToken 向 Google Secure Token API 換發
 * （不需要密碼；若憑證檔剛好帶 password 欄位則優先用 signInWithPassword）。
 * 找不到憑證檔或換發 idToken 失敗時，印出說明並 exit(2)（讓 CI 視為「環境缺件而跳過」，
 * 不要誤判成規則有 bug）。
 *
 * 安全紅線：所有測試寫入一律用 zz_test_ 前綴 doc id，只碰三個測試帳號自己的資料；
 * 絕不寫入或刪除 tch_* 開頭的正式教師檔、既有 substituteRecords/operationLogs、
 * schools/inhu/config/main。攻擊案例的目標若是「既有文件」，一律只指向測試帳號
 * 自己的文件（自己的 teachers doc、自己的 userMapping），不對正式教師檔做寫入嘗試。
 *
 * 案例設計依據：
 *   - src/js/modules/v2/pendingRequestService.js（三種審核狀態機的實際寫入欄位）
 *   - firestore.rules 第 100-351 行（schools/{schoolId} 下所有 match block）
 * 逐案 rulesRef 標注對應 firestore.rules 行號區間，供未來改規則時回溯。
 *
 * 執行完成後，把「成功建立」的文件路徑寫到 test/.last-test-docs.json（已加入
 * .gitignore）供事後清理——注意 teachers/substituteRecords 的 delete 規則只允許
 * isDirector，本測試的三個帳號（teacher/teacher/section_chief）都無法自行刪除
 * 万一攻擊案例意外 ALLOW 而寫入的 teachers 或 substituteRecords 文件，需要正式
 * director 帳號手動清理（腳本會在該情況印出明確警告）。
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 常數（apiKey 為前端公開設定，已存在於 src/js/modules/firebaseConfig.js，非機密）
// ---------------------------------------------------------------------------
const PROJECT_ID  = 'stsystem-9d5fe';
const API_KEY     = 'AIzaSyCJ1WL_aScocarEvQdEgCYtsdqM8AUdGlw';
const SCHOOL_ID   = 'inhu';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
// 既有正式 director——唯讀參照用，攻擊案例②③會「引用」此 ID 但絕不寫入此文件本身。
const REAL_DIRECTOR_TEACHER_ID = 'tch_1780040513944_kl4wgr9';

const FALLBACK_CREDS_PATH = 'C:\\Users\\uplil\\AppData\\Local\\Temp\\claude\\C--Users-uplil-sideprojet-STsystem\\af9a3c19-dd93-45b3-92cd-e97c9633ce40\\scratchpad\\test-tokens.json';
const LAST_DOCS_PATH = path.join(__dirname, '.last-test-docs.json');

const RUN = Date.now().toString(36); // 每次執行不同，避免 doc id 撞名
const nowIso = () => new Date().toISOString();
const zz = (name) => `zz_test_${name}_${RUN}`;

// ---------------------------------------------------------------------------
// 憑證載入 + idToken 換發
// ---------------------------------------------------------------------------
function resolveCredsPath() {
    return process.env.STSYSTEM_TEST_CREDS || FALLBACK_CREDS_PATH;
}

function loadCreds() {
    const p = resolveCredsPath();
    if (!fs.existsSync(p)) {
        console.error(`[環境缺件] 找不到測試憑證檔：${p}`);
        console.error('請設定環境變數 STSYSTEM_TEST_CREDS 指向憑證 JSON，或確認 fallback 路徑存在。');
        console.error('憑證檔需含 v2t1 / v2t2 / v2t3 三把 key，每把至少要有 email + refreshToken（或 password）。');
        process.exit(2);
    }
    try {
        let raw = fs.readFileSync(p, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 去除可能的 UTF-8 BOM
        return JSON.parse(raw);
    } catch (e) {
        console.error(`[環境缺件] 憑證檔解析失敗：${p}`);
        console.error(String(e && e.message || e));
        process.exit(2);
    }
}

async function signInWithPassword(email, password) {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`signInWithPassword 失敗（${email}）：${JSON.stringify(json)}`);
    return json.idToken;
}

async function refreshIdToken(refreshToken) {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`refresh_token 換發失敗：${JSON.stringify(json)}`);
    return json.id_token;
}

async function getFreshIdToken(entry) {
    if (entry.password && entry.email) return signInWithPassword(entry.email, entry.password);
    if (entry.refreshToken) return refreshIdToken(entry.refreshToken);
    throw new Error(`憑證缺少 password 或 refreshToken：${entry.email || '未知帳號'}`);
}

// ---------------------------------------------------------------------------
// Firestore REST 輔助（typed-value 編碼／解碼、CRUD、list）
// ---------------------------------------------------------------------------
function encodeValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
    if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
    throw new Error(`encodeValue: 不支援的型別 ${typeof v}`);
}
function encodeFields(obj) {
    const fields = {};
    for (const [k, val] of Object.entries(obj)) fields[k] = encodeValue(val);
    return fields;
}
function toFirestoreDoc(obj) { return { fields: encodeFields(obj) }; }

function decodeValue(field) {
    if (!field) return null;
    if ('stringValue'  in field) return field.stringValue;
    if ('integerValue' in field) return +field.integerValue;
    if ('doubleValue'  in field) return field.doubleValue;
    if ('booleanValue' in field) return field.booleanValue;
    if ('arrayValue'   in field) return (field.arrayValue.values || []).map(decodeValue);
    if ('mapValue'     in field) {
        const o = {};
        for (const [k, v] of Object.entries(field.mapValue.fields || {})) o[k] = decodeValue(v);
        return o;
    }
    if ('timestampValue' in field) return field.timestampValue;
    if ('nullValue' in field) return null;
    return null;
}
function docToObj(doc) {
    const obj = { _id: doc.name.split('/').pop() };
    for (const [k, v] of Object.entries(doc.fields || {})) obj[k] = decodeValue(v);
    return obj;
}

async function fsFetch(method, url, idToken, bodyObj) {
    const opts = { method, headers: { Authorization: `Bearer ${idToken}` } };
    if (bodyObj !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(bodyObj);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = { raw: text }; } }
    return { httpStatus: res.status, json };
}

function classify(result) {
    if (result.httpStatus === 200) return 'ALLOW';
    if (result.httpStatus === 403) return 'DENY';
    return 'ERROR';
}

async function createDoc(collectionPath, docId, dataObj, idToken) {
    const url = `${FIRESTORE_BASE}/${collectionPath}?documentId=${encodeURIComponent(docId)}`;
    return fsFetch('POST', url, idToken, toFirestoreDoc(dataObj));
}
async function patchDoc(docPath, dataObj, idToken) {
    const url = new URL(`${FIRESTORE_BASE}/${docPath}`);
    for (const f of Object.keys(dataObj)) url.searchParams.append('updateMask.fieldPaths', f);
    return fsFetch('PATCH', url.toString(), idToken, toFirestoreDoc(dataObj));
}
async function getDoc(docPath, idToken) {
    return fsFetch('GET', `${FIRESTORE_BASE}/${docPath}`, idToken);
}
async function deleteDoc(docPath, idToken) {
    return fsFetch('DELETE', `${FIRESTORE_BASE}/${docPath}`, idToken);
}
async function listCollection(collectionPath, idToken) {
    let all = [];
    let pageToken;
    do {
        const url = new URL(`${FIRESTORE_BASE}/${collectionPath}`);
        url.searchParams.set('pageSize', '300');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${idToken}` } });
        const json = await res.json();
        if (!res.ok) throw new Error(`list ${collectionPath} 失敗：${JSON.stringify(json)}`);
        all = all.concat((json.documents || []).map(docToObj));
        pageToken = json.nextPageToken;
    } while (pageToken);
    return all;
}

// ---------------------------------------------------------------------------
// 案例執行器：每案宣告 { id, desc, actor, method, path, body, expect, rulesRef }，
// 多步驟案例（需要先建 setup 文件才能測攻擊/核准動作）額外帶 steps 陣列，
// 依序執行、非最終步驟若不符自身預期即中止並回報 BLOCKED（不假裝測過）。
// ---------------------------------------------------------------------------

const createdDocs = [];

async function execStep(step) {
    let result;
    if (step.kind === 'create') {
        result = await createDoc(step.collectionPath, step.docId, step.data, step.idToken);
        if (classify(result) === 'ALLOW') createdDocs.push(`${step.collectionPath}/${step.docId}`);
    } else if (step.kind === 'patch') {
        result = await patchDoc(step.docPath, step.data, step.idToken);
    } else if (step.kind === 'get') {
        result = await getDoc(step.docPath, step.idToken);
    } else if (step.kind === 'delete') {
        result = await deleteDoc(step.docPath, step.idToken);
    } else {
        throw new Error(`execStep: 未知 step.kind=${step.kind}`);
    }
    return { verdict: classify(result), httpStatus: result.httpStatus, body: result.json };
}

/** 一般案例：依序執行 steps，非末步不符預期即中止（BLOCKED）。 */
async function runSequential(c) {
    let last = null;
    for (let i = 0; i < c.steps.length; i++) {
        const s = c.steps[i];
        const r = await execStep(s);
        last = r;
        const isFinal = i === c.steps.length - 1;
        if (!isFinal && r.verdict !== s.expect) {
            return {
                verdict: 'BLOCKED',
                httpStatus: r.httpStatus,
                detail: `卡在步驟「${s.label}」：預期 ${s.expect}，實得 ${r.verdict}（HTTP ${r.httpStatus}）。` +
                    `此案後續步驟依賴此步驟成功，無法繼續測試。body=${JSON.stringify(r.body).slice(0, 300)}`,
            };
        }
    }
    return { verdict: last.verdict, httpStatus: last.httpStatus, detail: null };
}

function printCaseResult(c, result) {
    const pass = result.verdict === c.expect;
    const mark = pass ? '✓' : '✗';
    let line = `${mark} ${c.id}  ${c.desc} → 實得 ${result.verdict}` +
        (result.httpStatus != null ? ` (HTTP ${result.httpStatus})` : '') +
        `  [${c.rulesRef}]`;
    if (!pass) {
        line += `\n    ⚠ 預期 ${c.expect}，實得 ${result.verdict}`;
        if (result.detail) line += `\n    ${result.detail}`;
        if (c.type === 'attack' && result.verdict === 'ALLOW') {
            line += `\n    ⚠⚠ 嚴重度：${c.severity || 'high'}（攻擊案例意外被 ALLOW，可能是真實規則缺陷）`;
        }
    }
    console.log(line);
    return pass;
}

// ---------------------------------------------------------------------------
// 26 案例定義（正向 P01-P12、攻擊 X01-X14）
// ---------------------------------------------------------------------------
function buildCases({ A, B, C }) {
    const col = {
        pending:  `schools/${SCHOOL_ID}/pendingRequests`,
        records:  `schools/${SCHOOL_ID}/substituteRecords`,
        teachers: `schools/${SCHOOL_ID}/teachers`,
        logs:     `schools/${SCHOOL_ID}/operationLogs`,
        mappings: `schools/${SCHOOL_ID}/userMappings`,
    };
    const docId = {
        reqSub1:        zz('req_sub1'),
        reqSwap1:       zz('req_swap1'),
        reqMultiSwap1:  zz('req_multiswap1'),
        reqForReject1:  zz('req_forreject1'),
        recApprove1:    zz('rec_approve1'),
        recSelfSwap1:   zz('rec_selfswap1'),
        log1:           zz('log1'),
        tchAttack1:     zz('tch_attack1'),
        reqAttack4:     zz('req_attack4'),
        reqAttack5:     zz('req_attack5'),
        reqAttack6:     zz('req_attack6'),
        reqAttack7:     zz('req_attack7'),
        reqAttack8:     zz('req_attack8'),
        reqAttack9:     zz('req_attack9'),
        reqAttack10:    zz('req_attack10'),
        reqAttack11:    zz('req_attack11'),
        recAttack12:    zz('rec_attack12'),
    };
    const cases = [];

    // ===================== 正向 12 案（皆應 ALLOW） =====================

    cases.push({
        id: 'P01', type: 'positive', actor: 'A(教師甲)', method: 'CREATE',
        desc: '正向①教師甲 create 代課請求（status=pending_approval）',
        path: `${col.pending}/${docId.reqSub1}`, expect: 'ALLOW',
        rulesRef: 'rules:213-225 自建請求（substitute 分支）',
        steps: [{
            kind: 'create', label: 'create 代課請求', collectionPath: col.pending, docId: docId.reqSub1, expect: 'ALLOW', idToken: A.idToken,
            data: {
                requestType: 'substitute', status: 'pending_approval',
                initiatedBy: A.teacherId, initiatedByName: A.label,
                pendingConsentTeacherIds: [], swapConsents: {}, createdAt: nowIso(),
                type: '代課', date: '2026-08-03', period: '第一節', className: '7年1班',
                originalTeacherId: A.teacherId, substituteTeacherId: B.teacherId,
            },
        }],
    });

    cases.push({
        id: 'P02', type: 'positive', actor: 'A(教師甲)', method: 'CREATE',
        desc: '正向②教師甲 create 調課請求（pending_swap_consent，同意名單含乙不含自己）',
        path: `${col.pending}/${docId.reqSwap1}`, expect: 'ALLOW',
        rulesRef: 'rules:226-233 自建請求（swap 分支）',
        steps: [{
            kind: 'create', label: 'create 調課請求', collectionPath: col.pending, docId: docId.reqSwap1, expect: 'ALLOW', idToken: A.idToken,
            data: {
                requestType: 'swap', status: 'pending_swap_consent',
                initiatedBy: A.teacherId, initiatedByName: A.label,
                pendingConsentTeacherIds: [B.teacherId], swapConsents: {}, createdAt: nowIso(),
                requiredApproverId: B.teacherId,
                type: '調課', date: '2026-08-04', period: '第二節', className: '7年2班',
                originalTeacherId: A.teacherId, swapTeacherId: B.teacherId,
            },
        }],
    });

    cases.push({
        id: 'P03', type: 'positive', actor: 'A(教師甲)', method: 'CREATE',
        desc: '正向③教師甲 create 多重調課（同意名單含乙丙）',
        path: `${col.pending}/${docId.reqMultiSwap1}`, expect: 'ALLOW',
        rulesRef: 'rules:226-233 自建請求（multi_swap 分支）',
        steps: [{
            kind: 'create', label: 'create 多重調課請求', collectionPath: col.pending, docId: docId.reqMultiSwap1, expect: 'ALLOW', idToken: A.idToken,
            data: {
                requestType: 'multi_swap', status: 'pending_swap_consent',
                initiatedBy: A.teacherId, initiatedByName: A.label,
                pendingConsentTeacherIds: [B.teacherId, C.teacherId], swapConsents: {}, createdAt: nowIso(),
                type: '調課', date: '2026-08-05', period: '第三節', className: '7年3班',
                originalTeacherId: A.teacherId,
            },
        }],
    });

    cases.push({
        id: 'P04', type: 'positive', actor: 'B(教師乙)', method: 'PATCH',
        desc: '正向④教師乙 同意調課（移出待同意名單／寫 swapConsents，單一同意人故直接轉 pending_approval）',
        path: `${col.pending}/${docId.reqSwap1}`, expect: 'ALLOW',
        rulesRef: 'rules:263-290 同意人分支（陣列成員資格 + 允許欄位）',
        steps: [{
            kind: 'patch', label: 'B 同意 reqSwap1', docPath: `${col.pending}/${docId.reqSwap1}`, expect: 'ALLOW', idToken: B.idToken,
            data: {
                pendingConsentTeacherIds: [],
                swapConsents: { [B.teacherId]: { consentedAt: nowIso() } },
                status: 'pending_approval', statusUpdatedAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'P05', type: 'positive', actor: 'B(教師乙)+C(組長丙)', method: 'PATCH x2',
        desc: '正向⑤多重調課全員同意後 status 轉 pending_approval（乙先同意仍待丙、丙同意後才轉）',
        path: `${col.pending}/${docId.reqMultiSwap1}`, expect: 'ALLOW',
        rulesRef: 'rules:263-290 同意人分支（全員同意才轉 pending_approval）',
        steps: [
            {
                kind: 'patch', label: 'B 部分同意 reqMultiSwap1（丙尚未同意）', docPath: `${col.pending}/${docId.reqMultiSwap1}`, expect: 'ALLOW', idToken: B.idToken,
                data: {
                    pendingConsentTeacherIds: [C.teacherId],
                    swapConsents: { [B.teacherId]: { consentedAt: nowIso() } },
                    statusUpdatedAt: nowIso(),
                },
            },
            {
                kind: 'patch', label: 'C 補上同意，全員到齊轉 pending_approval', docPath: `${col.pending}/${docId.reqMultiSwap1}`, expect: 'ALLOW', idToken: C.idToken,
                data: {
                    pendingConsentTeacherIds: [],
                    swapConsents: { [B.teacherId]: { consentedAt: nowIso() }, [C.teacherId]: { consentedAt: nowIso() } },
                    status: 'pending_approval', statusUpdatedAt: nowIso(),
                },
            },
        ],
    });

    cases.push({
        id: 'P06', type: 'positive', actor: 'C(組長丙)', method: 'CREATE+PATCH',
        desc: '正向⑥組長丙 核准代課請求 → 建 substituteRecords',
        path: `${col.pending}/${docId.reqSub1}`, expect: 'ALLOW',
        rulesRef: 'rules:178 approver create record + rules:245-262 approver 核准',
        steps: [
            {
                kind: 'create', label: '(approver 建立對應 record)', collectionPath: col.records, docId: docId.recApprove1, expect: 'ALLOW', idToken: C.idToken,
                data: {
                    type: '代課', date: '2026-08-03', period: '第一節', className: '7年1班',
                    originalTeacherId: A.teacherId, substituteTeacherId: B.teacherId,
                    status: 'approved', approvedAt: nowIso(), approvedBy: C.teacherId, approvedByName: C.label,
                    initiatedBy: A.teacherId, initiatedByName: A.label, fromRequestId: docId.reqSub1,
                    affectedTeacherIds: [A.teacherId, B.teacherId], createdAt: nowIso(),
                },
            },
            {
                kind: 'patch', label: '核准 reqSub1（status→approved）', docPath: `${col.pending}/${docId.reqSub1}`, expect: 'ALLOW', idToken: C.idToken,
                data: { status: 'approved', approvedAt: nowIso(), approvedBy: C.teacherId, approvedByName: C.label, statusUpdatedAt: nowIso() },
            },
        ],
    });

    cases.push({
        id: 'P07', type: 'positive', actor: 'C(組長丙)', method: 'CREATE+PATCH',
        desc: '正向⑦組長丙 駁回另一筆代課請求',
        path: `${col.pending}/${docId.reqForReject1}`, expect: 'ALLOW',
        rulesRef: 'rules:245-262 approver 駁回',
        steps: [
            {
                kind: 'create', label: '(建立待駁回請求)', collectionPath: col.pending, docId: docId.reqForReject1, expect: 'ALLOW', idToken: A.idToken,
                data: {
                    requestType: 'substitute', status: 'pending_approval',
                    initiatedBy: A.teacherId, initiatedByName: A.label,
                    pendingConsentTeacherIds: [], swapConsents: {}, createdAt: nowIso(),
                    type: '代課', date: '2026-08-06', period: '第四節', className: '7年4班',
                    originalTeacherId: A.teacherId, substituteTeacherId: B.teacherId,
                },
            },
            {
                kind: 'patch', label: '丙駁回 reqForReject1', docPath: `${col.pending}/${docId.reqForReject1}`, expect: 'ALLOW', idToken: C.idToken,
                data: { status: 'rejected', rejectedAt: nowIso(), rejectedBy: C.teacherId, rejectedByName: C.label, rejectNote: '測試駁回', statusUpdatedAt: nowIso() },
            },
        ],
    });

    cases.push({
        id: 'P08', type: 'positive', actor: 'A(教師甲)', method: 'CREATE',
        desc: '正向⑧教師甲 自我調課直寫 substituteRecords（isSelfSwap，三個 teacherId 皆自己）',
        path: `${col.records}/${docId.recSelfSwap1}`, expect: 'ALLOW',
        rulesRef: 'rules:178-187 自我調課快速路徑',
        steps: [{
            kind: 'create', label: 'create 自我調課紀錄', collectionPath: col.records, docId: docId.recSelfSwap1, expect: 'ALLOW', idToken: A.idToken,
            data: {
                type: '調課', isSelfSwap: true,
                originalTeacherId: A.teacherId, swapTeacherId: A.teacherId, substituteTeacherId: A.teacherId,
                date: '2026-08-07', period: '第五節', className: '7年1班',
                status: 'approved', approvedAt: nowIso(), approvedBy: A.teacherId, approvedByName: A.label,
                createdAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'P09', type: 'positive', actor: 'A(教師甲)', method: 'CREATE',
        desc: '正向⑨任何登入者 create operationLog',
        path: `${col.logs}/${docId.log1}`, expect: 'ALLOW',
        rulesRef: 'rules:312-318 operationLogs create（欄位白名單+型別檢查）',
        steps: [{
            kind: 'create', label: 'create operationLog', collectionPath: col.logs, docId: docId.log1, expect: 'ALLOW', idToken: A.idToken,
            data: {
                action: 'zz_test_action', actor: { uid: A.uid, teacherId: A.teacherId, name: A.label, role: A.role },
                timestamp: nowIso(), targetType: 'pendingRequest', targetId: docId.reqSub1,
                details: { note: 'rules matrix test log', runId: RUN },
            },
        }],
    });

    cases.push({
        id: 'P10', type: 'positive', actor: 'A(教師甲)', method: 'GET',
        desc: '正向⑩教師甲 讀 teachers（讀取全校教師，此處讀既有正式 director 教師檔——僅讀取不寫入）',
        path: `${col.teachers}/${REAL_DIRECTOR_TEACHER_ID}`, expect: 'ALLOW',
        rulesRef: 'rules:116 teachers read（任何登入者）',
        steps: [{ kind: 'get', label: '讀 director 教師檔', docPath: `${col.teachers}/${REAL_DIRECTOR_TEACHER_ID}`, expect: 'ALLOW', idToken: A.idToken }],
    });

    cases.push({
        id: 'P11', type: 'positive', actor: 'A(教師甲)', method: 'GET',
        desc: '正向⑪教師甲 讀 config',
        path: `schools/${SCHOOL_ID}/config/main`, expect: 'ALLOW',
        rulesRef: 'rules:108 config read（任何登入者）',
        steps: [{ kind: 'get', label: '讀 config/main', docPath: `schools/${SCHOOL_ID}/config/main`, expect: 'ALLOW', idToken: A.idToken }],
    });

    cases.push({
        id: 'P12', type: 'positive', actor: 'A(教師甲)', method: 'GET',
        desc: '正向⑫教師甲 讀自己的 userMapping',
        path: `${col.mappings}/${A.uid}`, expect: 'ALLOW',
        rulesRef: 'rules:328 userMappings read（本人）',
        steps: [{ kind: 'get', label: '讀自己 userMapping', docPath: `${col.mappings}/${A.uid}`, expect: 'ALLOW', idToken: A.idToken }],
    });

    // ===================== 攻擊 14 案（皆應 DENY） =====================

    cases.push({
        id: 'X01', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊①教師甲 create teachers 文件（冒建教師檔）',
        path: `${col.teachers}/${docId.tchAttack1}`, expect: 'DENY',
        rulesRef: 'rules:120-128 teachers create（僅 director / 初始主任 bootstrap）',
        steps: [{
            kind: 'create', label: 'create 冒建教師檔', collectionPath: col.teachers, docId: docId.tchAttack1, expect: 'DENY', idToken: A.idToken,
            data: { name: 'zz_test 冒建教師', email: 'zz_test_attacker@example.com', role: 'teacher', createdAt: nowIso() },
        }],
    });

    cases.push({
        id: 'X02', type: 'attack', actor: 'A(教師甲)', method: 'PATCH', severity: 'critical',
        desc: '攻擊②教師甲 改自己 teachers.role → director（自我提權，目標為自己的教師檔）',
        path: `${col.teachers}/${A.teacherId}`, expect: 'DENY',
        rulesRef: 'rules:134-151 teachers update（自寫僅限 authProvider/updatedAt）',
        steps: [{ kind: 'patch', label: '把自己 role 改成 director', docPath: `${col.teachers}/${A.teacherId}`, expect: 'DENY', idToken: A.idToken, data: { role: 'director' } }],
        onUnexpectedAllow: async () => {
            console.error('    ⚠⚠ CRITICAL：教師甲成功自我提權為 director！立即回復 role=teacher...');
            await patchDoc(`${col.teachers}/${A.teacherId}`, { role: 'teacher' }, A.idToken);
        },
    });

    cases.push({
        id: 'X03', type: 'attack', actor: 'A(教師甲)', method: 'PATCH', severity: 'critical',
        desc: '攻擊③教師甲 把自己 mapping.linkedTeacherId 指向 director 的 teacherId（間接提權，目標為自己的 mapping）',
        path: `${col.mappings}/${A.uid}`, expect: 'DENY',
        rulesRef: 'rules:333-340 userMappings 自寫需 linkedTeacherId 對應教師 email == 自己登入 email',
        steps: [{ kind: 'patch', label: '把自己 mapping 指向 director', docPath: `${col.mappings}/${A.uid}`, expect: 'DENY', idToken: A.idToken, data: { linkedTeacherId: REAL_DIRECTOR_TEACHER_ID } }],
        onUnexpectedAllow: async () => {
            console.error('    ⚠⚠ CRITICAL：教師甲成功把自己 mapping 指向 director！立即回復 linkedTeacherId...');
            await patchDoc(`${col.mappings}/${A.uid}`, { linkedTeacherId: A.teacherId }, A.idToken);
        },
    });

    cases.push({
        id: 'X04', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊④create 請求時自帶 approvedBy 欄位（跳過審核直接偽造已核准）',
        path: `${col.pending}/${docId.reqAttack4}`, expect: 'DENY',
        rulesRef: 'rules:216 自建分支 approvedBy/approvedAt/approvedByName 黑名單',
        steps: [{
            kind: 'create', label: 'create 帶 approvedBy', collectionPath: col.pending, docId: docId.reqAttack4, expect: 'DENY', idToken: A.idToken,
            data: {
                requestType: 'substitute', status: 'pending_approval',
                initiatedBy: A.teacherId, initiatedByName: A.label, approvedBy: A.teacherId,
                pendingConsentTeacherIds: [], swapConsents: {}, createdAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'X05', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑤swap create 時自帶 status:pending_approval 跳過同意',
        path: `${col.pending}/${docId.reqAttack5}`, expect: 'DENY',
        rulesRef: 'rules:223-228 substitute/swap 狀態機交叉錯配',
        steps: [{
            kind: 'create', label: 'create swap 但 status=pending_approval', collectionPath: col.pending, docId: docId.reqAttack5, expect: 'DENY', idToken: A.idToken,
            data: {
                requestType: 'swap', status: 'pending_approval',
                initiatedBy: A.teacherId, initiatedByName: A.label,
                pendingConsentTeacherIds: [B.teacherId], swapConsents: {}, createdAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'X06', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑥swap create 時把自己列為唯一同意人（自我同意跳過對方）',
        path: `${col.pending}/${docId.reqAttack6}`, expect: 'DENY',
        rulesRef: 'rules:232 pendingConsentTeacherIds 不可含 initiatedBy',
        steps: [{
            kind: 'create', label: 'create swap 自列唯一同意人', collectionPath: col.pending, docId: docId.reqAttack6, expect: 'DENY', idToken: A.idToken,
            data: {
                requestType: 'swap', status: 'pending_swap_consent',
                initiatedBy: A.teacherId, initiatedByName: A.label,
                pendingConsentTeacherIds: [A.teacherId], swapConsents: {}, createdAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'X07', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑦create 時預填非空 swapConsents（偽造他人已同意）',
        path: `${col.pending}/${docId.reqAttack7}`, expect: 'DENY',
        rulesRef: 'rules:218-219 swapConsents 建立時必須為空 map',
        steps: [{
            kind: 'create', label: 'create 帶預填 swapConsents', collectionPath: col.pending, docId: docId.reqAttack7, expect: 'DENY', idToken: A.idToken,
            data: {
                requestType: 'swap', status: 'pending_swap_consent',
                initiatedBy: A.teacherId, initiatedByName: A.label,
                pendingConsentTeacherIds: [B.teacherId],
                swapConsents: { [B.teacherId]: { consentedAt: nowIso() } },
                createdAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'X08', type: 'attack', actor: 'B(教師乙)', method: 'CREATE(setup)+PATCH', severity: 'critical',
        desc: '攻擊⑧同意人直接把 status 寫成 approved（跳過核准）',
        path: `${col.pending}/${docId.reqAttack8}`, expect: 'DENY',
        rulesRef: 'rules:283-284 同意人可設定的目標狀態集合不含 approved',
        steps: [
            {
                kind: 'create', label: '(setup 建立合法 swap 請求)', collectionPath: col.pending, docId: docId.reqAttack8, expect: 'ALLOW', idToken: A.idToken,
                data: {
                    requestType: 'swap', status: 'pending_swap_consent',
                    initiatedBy: A.teacherId, initiatedByName: A.label,
                    pendingConsentTeacherIds: [B.teacherId], swapConsents: {}, createdAt: nowIso(),
                    date: '2026-08-08', period: '第六節', className: '7年2班',
                },
            },
            { kind: 'patch', label: 'B 直接寫 status=approved', docPath: `${col.pending}/${docId.reqAttack8}`, expect: 'DENY', idToken: B.idToken, data: { status: 'approved' } },
        ],
    });

    cases.push({
        id: 'X09', type: 'attack', actor: 'B(教師乙)', method: 'CREATE(setup)+PATCH', severity: 'high',
        desc: '攻擊⑨同意人竄改 date/period（affectedKeys 白名單外欄位）',
        path: `${col.pending}/${docId.reqAttack9}`, expect: 'DENY',
        rulesRef: 'rules:279-282 同意人 affectedKeys 白名單',
        steps: [
            {
                kind: 'create', label: '(setup 建立合法 swap 請求)', collectionPath: col.pending, docId: docId.reqAttack9, expect: 'ALLOW', idToken: A.idToken,
                data: {
                    requestType: 'swap', status: 'pending_swap_consent',
                    initiatedBy: A.teacherId, initiatedByName: A.label,
                    pendingConsentTeacherIds: [B.teacherId], swapConsents: {}, createdAt: nowIso(),
                    date: '2026-08-09', period: '第七節', className: '7年3班',
                },
            },
            { kind: 'patch', label: 'B 竄改 date', docPath: `${col.pending}/${docId.reqAttack9}`, expect: 'DENY', idToken: B.idToken, data: { date: '2099-12-31' } },
        ],
    });

    cases.push({
        id: 'X10', type: 'attack', actor: 'B(教師乙)', method: 'CREATE(setup)+PATCH(setup)+PATCH', severity: 'critical',
        desc: '攻擊⑩已 approved 的請求被同意人改回 rejected（終態鎖，經 legacy requiredApproverId 分支可達）',
        path: `${col.pending}/${docId.reqAttack10}`, expect: 'DENY',
        rulesRef: 'rules:270-273 legacy 分支 + rules:285-289 同意人終態鎖',
        steps: [
            {
                kind: 'create', label: '(setup 建立 legacy 相容請求，不含 pendingConsentTeacherIds)', collectionPath: col.pending, docId: docId.reqAttack10, expect: 'ALLOW', idToken: A.idToken,
                data: {
                    requestType: 'substitute', status: 'pending_approval',
                    initiatedBy: A.teacherId, initiatedByName: A.label,
                    requiredApproverId: B.teacherId, swapConsents: {}, createdAt: nowIso(),
                    type: '代課', date: '2026-08-10', period: '第一節', className: '7年4班',
                    originalTeacherId: A.teacherId, substituteTeacherId: B.teacherId,
                },
            },
            {
                kind: 'patch', label: '(setup 丙核准，狀態轉 approved)', docPath: `${col.pending}/${docId.reqAttack10}`, expect: 'ALLOW', idToken: C.idToken,
                data: { status: 'approved', approvedAt: nowIso(), approvedBy: C.teacherId, approvedByName: C.label, statusUpdatedAt: nowIso() },
            },
            {
                kind: 'patch', label: 'B（legacy 同意人）把已核准請求改回 rejected', docPath: `${col.pending}/${docId.reqAttack10}`, expect: 'DENY', idToken: B.idToken,
                data: { status: 'rejected', rejectedAt: nowIso(), rejectedBy: B.teacherId, rejectedByName: B.label, rejectNote: 'attack', statusUpdatedAt: nowIso() },
            },
        ],
    });

    cases.push({
        id: 'X11', type: 'attack', actor: 'C(組長丙)', method: 'CREATE(setup)+PATCH(setup)+PATCH', severity: 'high',
        desc: '攻擊⑪已 rejected 的請求被 approver 改成 approved（終態鎖，approver 側對稱條款）',
        path: `${col.pending}/${docId.reqAttack11}`, expect: 'DENY',
        rulesRef: 'rules:252-261 approver 終態鎖',
        steps: [
            {
                kind: 'create', label: '(setup 建立待核准請求)', collectionPath: col.pending, docId: docId.reqAttack11, expect: 'ALLOW', idToken: A.idToken,
                data: {
                    requestType: 'substitute', status: 'pending_approval',
                    initiatedBy: A.teacherId, initiatedByName: A.label,
                    pendingConsentTeacherIds: [], swapConsents: {}, createdAt: nowIso(),
                    type: '代課', date: '2026-08-11', period: '第二節', className: '7年5班',
                    originalTeacherId: A.teacherId, substituteTeacherId: B.teacherId,
                },
            },
            {
                kind: 'patch', label: '(setup 丙駁回)', docPath: `${col.pending}/${docId.reqAttack11}`, expect: 'ALLOW', idToken: C.idToken,
                data: { status: 'rejected', rejectedAt: nowIso(), rejectedBy: C.teacherId, rejectedByName: C.label, rejectNote: 'setup', statusUpdatedAt: nowIso() },
            },
            {
                kind: 'patch', label: '丙把已駁回請求改回 approved', docPath: `${col.pending}/${docId.reqAttack11}`, expect: 'DENY', idToken: C.idToken,
                data: { status: 'approved', approvedAt: nowIso(), approvedBy: C.teacherId, approvedByName: C.label, statusUpdatedAt: nowIso() },
            },
        ],
    });

    cases.push({
        id: 'X12', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑫教師甲 直寫 type=代課 + substituteTeacherId=自己 的 substituteRecords（灌代課費）',
        path: `${col.records}/${docId.recAttack12}`, expect: 'DENY',
        rulesRef: 'rules:182-183 自我調課路徑限定 type in [調課,swap]，杜絕 type=代課 自寫',
        steps: [{
            kind: 'create', label: 'create 偽代課紀錄自灌代課費', collectionPath: col.records, docId: docId.recAttack12, expect: 'DENY', idToken: A.idToken,
            data: {
                type: '代課', originalTeacherId: B.teacherId, substituteTeacherId: A.teacherId,
                date: '2026-08-12', period: '第三節', className: '7年6班',
                status: 'approved', approvedAt: nowIso(), approvedBy: A.teacherId, approvedByName: A.label,
                createdAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'X13', type: 'attack', actor: 'A(教師甲)', method: 'PATCH+DELETE', severity: 'critical',
        desc: '攻擊⑬教師甲 update 或 delete 既有 operationLog（即使是自己剛建立的稽核紀錄）',
        path: `${col.logs}/${docId.log1}`, expect: 'DENY',
        rulesRef: 'rules:319 operationLogs update/delete 一律 if false',
        customRun: async () => {
            // 存在性確認用 C（approver）的 token 讀——operationLogs 讀取規則本就是 approver-only
            // （rules:311），A 讀不到是正常現象，不能拿來當「log1 不存在」的判斷依據。
            const guard = await execStep({ kind: 'get', docPath: `${col.logs}/${docId.log1}`, idToken: C.idToken });
            if (guard.verdict !== 'ALLOW') {
                return { verdict: 'BLOCKED', httpStatus: guard.httpStatus, detail: `前置 P09 建立的 log1 讀不到（${guard.verdict}），X13 無法測試。` };
            }
            const upd = await execStep({ kind: 'patch', docPath: `${col.logs}/${docId.log1}`, idToken: A.idToken, data: { action: 'zz_test_tampered' } });
            const del = await execStep({ kind: 'delete', docPath: `${col.logs}/${docId.log1}`, idToken: A.idToken });
            const bothDenied = upd.verdict === 'DENY' && del.verdict === 'DENY';
            return {
                verdict: bothDenied ? 'DENY' : 'ALLOW',
                httpStatus: null,
                detail: `update→${upd.verdict}(HTTP ${upd.httpStatus})；delete→${del.verdict}(HTTP ${del.httpStatus})`,
            };
        },
    });

    cases.push({
        id: 'X14', type: 'attack', actor: 'A(教師甲)', method: 'GET', severity: 'medium',
        desc: '攻擊⑭教師甲 讀教師乙的 userMapping',
        path: `${col.mappings}/${B.uid}`, expect: 'DENY',
        rulesRef: 'rules:328 userMappings read（僅本人或 approver）',
        steps: [{ kind: 'get', label: '讀 B 的 userMapping', docPath: `${col.mappings}/${B.uid}`, expect: 'DENY', idToken: A.idToken }],
    });

    return cases;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
    const creds = loadCreds();
    for (const key of ['v2t1', 'v2t2', 'v2t3']) {
        if (!creds[key]) {
            console.error(`[環境缺件] 憑證檔缺少 ${key}`);
            process.exit(2);
        }
    }

    console.log('正在為三個測試帳號換發新的 idToken（refreshToken 交換，不需密碼）...');
    let tokenA, tokenB, tokenC;
    try {
        [tokenA, tokenB, tokenC] = await Promise.all([
            getFreshIdToken(creds.v2t1),
            getFreshIdToken(creds.v2t2),
            getFreshIdToken(creds.v2t3),
        ]);
    } catch (e) {
        console.error('[環境缺件] 取得 idToken 失敗，無法執行規則矩陣測試：');
        console.error(String(e && e.message || e));
        process.exit(2);
    }

    const A = { ...creds.v2t1, idToken: tokenA }; // 教師甲
    const B = { ...creds.v2t2, idToken: tokenB }; // 教師乙
    const C = { ...creds.v2t3, idToken: tokenC }; // 組長丙
    console.log(`✓ 三帳號 idToken 已就緒：A=${A.label} B=${B.label} C=${C.label}\n`);

    const cases = buildCases({ A, B, C });

    let passCount = 0, failCount = 0;
    const mismatches = [];
    for (const c of cases) {
        let result;
        try {
            result = c.customRun ? await c.customRun() : await runSequential(c);
        } catch (e) {
            result = { verdict: 'ERROR', httpStatus: null, detail: `例外：${String(e && e.message || e)}` };
        }
        const pass = printCaseResult(c, result);
        if (pass) passCount++; else { failCount++; mismatches.push({ c, result }); }

        if (!pass && result.verdict === 'ALLOW' && c.onUnexpectedAllow) {
            try {
                await c.onUnexpectedAllow();
                console.log('    → 已嘗試自動回復（自我修復），仍請人工複查。');
            } catch (e2) {
                console.error(`    ✗ 自動回復失敗，需人工立即處理：${String(e2 && e2.message || e2)}`);
            }
        }
    }

    console.log(`\n結果：通過 ${passCount}，失敗 ${failCount}（共 ${cases.length} 案）`);

    if (mismatches.length) {
        console.log('\n--- 不符預期案例摘要 ---');
        for (const { c, result } of mismatches) {
            console.log(`${c.id} [嚴重度:${c.severity || (c.type === 'attack' ? 'high' : 'n/a')}] 預期 ${c.expect} 實得 ${result.verdict} — ${c.rulesRef}`);
        }
    }

    try {
        fs.writeFileSync(LAST_DOCS_PATH, JSON.stringify({ runId: RUN, createdAt: nowIso(), docs: createdDocs }, null, 2));
        console.log(`\n已寫入建立文件清單：${LAST_DOCS_PATH}（${createdDocs.length} 筆，供事後清理）`);
    } catch (e) {
        console.error(`寫入 ${LAST_DOCS_PATH} 失敗：${String(e && e.message || e)}`);
    }

    console.log('\n--- 驗後檢查：substituteRecords / operationLogs 現況筆數（用組長丙 token 讀取）---');
    try {
        const records = await listCollection(`schools/${SCHOOL_ID}/substituteRecords`, C.idToken);
        const logs    = await listCollection(`schools/${SCHOOL_ID}/operationLogs`, C.idToken);
        console.log(`substituteRecords 現有 ${records.length} 筆`);
        console.log(`operationLogs 現有 ${logs.length} 筆`);
    } catch (e) {
        console.error(`驗後讀取失敗：${String(e && e.message || e)}`);
    }

    process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('\n未預期錯誤：', err);
    process.exit(1);
});
