#!/usr/bin/env node
/**
 * V2 Firestore 規則 allow/deny 矩陣測試
 *
 * 目的：firestore.rules（現行 v2.7，三層角色 + Phase 6 敏感欄位私有化 + 多租戶開通）從未有
 * 自動化測試，每次改規則都靠人肉推理。本檔直接打 Firestore REST API（純 node 內建 fetch，
 * 無外部依賴），驗證 60 個正向／攻擊案例是否符合預期的 ALLOW/DENY，其中 P13-P19／X15-X24
 * 專門覆蓋 substituteRecords/{id}/private/detail 與 pendingRequests/{id}/private/detail
 * 這兩處敏感欄位（leaveType/leaveTypeName/reason）子文件的權限邊界；X25-X30 為 Stage 0
 * 補充攻擊案例；X31-X40／X42 為 Stage 4（多租戶開通）補充攻擊案例，全數為 DENY 案例（opus
 * 驗收 R3 後 X40 改為不留永久殘留的兩步 DENY 驗證；X41 因故意保留原 id 空號——opus 驗收 R4
 * 認定原版是「檢驗到錯誤機制卻剛好也回傳 DENY」的假測試，移除並在該處改寫成明確的已知覆蓋
 * 缺口說明，不編號重排以保留變更軌跡）。
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
 * 唯一例外：REAL_RECORD_WITH_PRIVATE_DETAIL（正式紀錄 rec_1783657255158_nv698xk）
 * 僅供「執行完成後完整性檢查」讀取比對用，全程只 GET、絕不 PATCH/DELETE。
 *
 * 案例設計依據：
 *   - src/js/modules/v2/pendingRequestService.js（三種審核狀態機的實際寫入欄位）
 *   - src/js/modules/v2/schemaConstants.js（private/detail 固定 docId 為 'detail'，
 *     substituteDetailDoc()/pendingDetailDoc() 兩個路徑產生器）
 *   - firestore.rules 第 100-360 行（schools/{schoolId} 下所有 match block，含
 *     第 103-115 行 private/detail 共用 helper、第 222-235 行 substituteRecords
 *     私有明細、第 345-352 行 pendingRequests 私有明細）
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
// 既有正式 substituteRecords——唯讀參照用，僅供跑完後的完整性檢查比對
// private/detail.leaveType 是否仍為「長期病假」，絕不寫入/更新/刪除此文件或其子文件。
const REAL_RECORD_WITH_PRIVATE_DETAIL = 'rec_1783657255158_nv698xk';
const REAL_RECORD_EXPECTED_LEAVE_TYPE = '長期病假';

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
// 43 案例定義（正向 P01-P19、攻擊 X01-X24）
// P13-P19／X15-X24（Phase 6）覆蓋 substituteRecords 與 pendingRequests 底下
// private/detail 子文件（leaveType/leaveTypeName/reason 敏感欄位）的權限邊界。
// ---------------------------------------------------------------------------
function buildCases({ A, B, C }) {
    const col = {
        pending:      `schools/${SCHOOL_ID}/pendingRequests`,
        records:      `schools/${SCHOOL_ID}/substituteRecords`,
        teachers:     `schools/${SCHOOL_ID}/teachers`,
        logs:         `schools/${SCHOOL_ID}/operationLogs`,
        mappings:     `schools/${SCHOOL_ID}/userMappings`,
        // Stage 0（2026-07-31，驗收修復 S10）：emailIndex/joinAttempts 負向案例用
        emailIndex:   `schools/${SCHOOL_ID}/emailIndex`,
        joinAttempts: `schools/${SCHOOL_ID}/joinAttempts`,
    };
    // Stage 0：一個確定不存在（也不會被建立）的 schoolId，用來測「跨校」讀取一定被拒——
    // 不依賴正式庫是否真的有第二所學校，isMember(otherSchoolId) 對任何測試帳號恆為 false。
    const OTHER_SCHOOL_ID = 'zz_test_other_school_never_created';
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
        // ---- Phase 6：private/detail 專用（P13-P19／X15-X24）----
        recApprove2:    zz('rec_approve2'),   // P13 setup 父文件（丙代建乙的自我調課紀錄）
        reqPriv19:      zz('req_priv19'),     // P19 setup 父請求
        recAttack16:    zz('rec_attack16'),   // X16 假別=公假
        recAttack17:    zz('rec_attack17'),   // X17 假別=長期病假
        recAttack18:    zz('rec_attack18'),   // X18 假別=喪假
        recAttack19:    zz('rec_attack19'),   // X19 假別=事假（對照 P19）
        recAttack20:    zz('rec_attack20'),   // X20 ACL 不含自己
        recAttack23:    zz('rec_attack23'),   // X23 白名單外欄位
        recAttack24:    zz('rec_attack24'),   // X24 allowedTeacherIds 型別錯誤
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
        // Stage 0（2026-07-31）後改為 isMember(schoolId) 守門（原「任何登入者」）；
        // A/B/C 皆為已綁定 userMappings 的既有成員帳號，isMember 恆成立，預期結果不變。
        rulesRef: 'firestore.rules teachers read（isMember(schoolId)，Stage 0 收緊）',
        steps: [{ kind: 'get', label: '讀 director 教師檔', docPath: `${col.teachers}/${REAL_DIRECTOR_TEACHER_ID}`, expect: 'ALLOW', idToken: A.idToken }],
    });

    cases.push({
        id: 'P11', type: 'positive', actor: 'A(教師甲)', method: 'GET',
        desc: '正向⑪教師甲 讀 config',
        path: `schools/${SCHOOL_ID}/config/main`, expect: 'ALLOW',
        // Stage 0（2026-07-31）後改為 isMemberOrBootstrapDirector(schoolId) 守門
        // （原「任何登入者」）；A 為既有成員帳號，isMember 恆成立，預期結果不變。
        rulesRef: 'firestore.rules config read（isMemberOrBootstrapDirector，Stage 0 收緊）',
        steps: [{ kind: 'get', label: '讀 config/main', docPath: `schools/${SCHOOL_ID}/config/main`, expect: 'ALLOW', idToken: A.idToken }],
    });

    cases.push({
        id: 'P12', type: 'positive', actor: 'A(教師甲)', method: 'GET',
        desc: '正向⑫教師甲 讀自己的 userMapping',
        path: `${col.mappings}/${A.uid}`, expect: 'ALLOW',
        rulesRef: 'rules:328 userMappings read（本人）',
        steps: [{ kind: 'get', label: '讀自己 userMapping', docPath: `${col.mappings}/${A.uid}`, expect: 'ALLOW', idToken: A.idToken }],
    });

    // ===================== 正向 Phase 6 補充：private/detail（P13-P19） =====================

    cases.push({
        id: 'P13', type: 'positive', actor: 'C(組長丙)', method: 'CREATE+CREATE',
        desc: '正向⑬組長丙 建立紀錄的私有明細（任意假別，例如長期病假；父文件為丙代建的乙自我調課紀錄）',
        path: `${col.records}/${docId.recApprove2}/private/detail`, expect: 'ALLOW',
        rulesRef: 'rules:224-232 私有明細 create（isApprover 分支，不受假別限制）',
        steps: [
            {
                kind: 'create', label: '(setup 丙代建乙的自我調課父文件)', collectionPath: col.records, docId: docId.recApprove2, expect: 'ALLOW', idToken: C.idToken,
                data: {
                    type: '調課', isSelfSwap: true,
                    originalTeacherId: B.teacherId, swapTeacherId: B.teacherId, substituteTeacherId: B.teacherId,
                    date: '2026-08-13', period: '第一節', className: '7年2班',
                    status: 'approved', approvedAt: nowIso(), approvedBy: C.teacherId, approvedByName: C.label,
                    createdAt: nowIso(),
                },
            },
            {
                kind: 'create', label: '建立私有明細（長期病假，ACL 僅含乙）', collectionPath: `${col.records}/${docId.recApprove2}/private`, docId: 'detail', expect: 'ALLOW', idToken: C.idToken,
                data: { leaveType: '長期病假', leaveTypeName: '長期病假', reason: 'zz_test 長期病假事由（乙）', allowedTeacherIds: [B.teacherId] },
            },
        ],
    });

    cases.push({
        id: 'P14', type: 'positive', actor: 'C(組長丙)', method: 'GET',
        desc: '正向⑭組長丙 讀取任一私有明細（P13 建立的乙自我調課明細）',
        path: `${col.records}/${docId.recApprove2}/private/detail`, expect: 'ALLOW',
        rulesRef: 'rules:223 私有明細 read（isApprover 分支）',
        steps: [{ kind: 'get', label: '丙讀取乙的私有明細', docPath: `${col.records}/${docId.recApprove2}/private/detail`, expect: 'ALLOW', idToken: C.idToken }],
    });

    cases.push({
        id: 'P15', type: 'positive', actor: 'C(組長丙)', method: 'PATCH',
        desc: '正向⑮組長丙 更新既有私有明細（補充 reason 說明文字）',
        path: `${col.records}/${docId.recApprove2}/private/detail`, expect: 'ALLOW',
        rulesRef: 'rules:233 私有明細 update（僅 approver）',
        steps: [{
            kind: 'patch', label: '丙補充 reason', docPath: `${col.records}/${docId.recApprove2}/private/detail`, expect: 'ALLOW', idToken: C.idToken,
            data: { reason: 'zz_test 長期病假事由（乙，已補充說明）' },
        }],
    });

    cases.push({
        id: 'P16', type: 'positive', actor: 'A(教師甲)', method: 'CREATE',
        desc: '正向⑯教師甲 建立自己自我調課紀錄（recSelfSwap1）的私有明細（leaveType=調課，ACL 只含自己）',
        path: `${col.records}/${docId.recSelfSwap1}/private/detail`, expect: 'ALLOW',
        rulesRef: 'rules:224-231 私有明細 create（教師分支：ACL 含自己 + leaveType in [調課,swap]）',
        steps: [{
            kind: 'create', label: '甲建立自己的私有明細', collectionPath: `${col.records}/${docId.recSelfSwap1}/private`, docId: 'detail', expect: 'ALLOW', idToken: A.idToken,
            data: { leaveType: '調課', leaveTypeName: '調課', reason: '', allowedTeacherIds: [A.teacherId] },
        }],
    });

    cases.push({
        id: 'P17', type: 'positive', actor: 'A(教師甲)', method: 'GET',
        desc: '正向⑰教師甲 讀取 ACL 含自己的私有明細（P16 剛建立的自我調課明細）',
        path: `${col.records}/${docId.recSelfSwap1}/private/detail`, expect: 'ALLOW',
        rulesRef: 'rules:223/107-110 私有明細 read（當事人分支：myTeacherId in allowedTeacherIds）',
        steps: [{ kind: 'get', label: '甲讀取自己的私有明細', docPath: `${col.records}/${docId.recSelfSwap1}/private/detail`, expect: 'ALLOW', idToken: A.idToken }],
    });

    cases.push({
        id: 'P18', type: 'positive', actor: 'A(教師甲)', method: 'GET',
        desc: '正向⑱教師甲 讀取該紀錄的父文件（排課資訊全校仍可讀，確認未過度收緊）',
        path: `${col.records}/${docId.recSelfSwap1}`, expect: 'ALLOW',
        rulesRef: 'rules:185 substituteRecords read（任何登入者）',
        steps: [{ kind: 'get', label: '甲讀取 recSelfSwap1 父文件', docPath: `${col.records}/${docId.recSelfSwap1}`, expect: 'ALLOW', idToken: A.idToken }],
    });

    cases.push({
        id: 'P19', type: 'positive', actor: 'A(教師甲)', method: 'CREATE+CREATE',
        desc: '正向⑲教師甲 建立自己發起的待審請求私有明細（pendingRequests 底下，真實假別事假——此路徑不受調課限制）',
        path: `${col.pending}/${docId.reqPriv19}/private/detail`, expect: 'ALLOW',
        rulesRef: 'rules:348-349 pendingRequests 私有明細 create（無 leaveType 限制，控制點在審核）',
        steps: [
            {
                kind: 'create', label: '(setup 甲建立新的代課請求)', collectionPath: col.pending, docId: docId.reqPriv19, expect: 'ALLOW', idToken: A.idToken,
                data: {
                    requestType: 'substitute', status: 'pending_approval',
                    initiatedBy: A.teacherId, initiatedByName: A.label,
                    pendingConsentTeacherIds: [], swapConsents: {}, createdAt: nowIso(),
                    type: '代課', date: '2026-08-14', period: '第二節', className: '7年3班',
                    originalTeacherId: A.teacherId, substituteTeacherId: B.teacherId,
                },
            },
            {
                kind: 'create', label: '建立私有明細（事假，非調課類但此路徑不受限）', collectionPath: `${col.pending}/${docId.reqPriv19}/private`, docId: 'detail', expect: 'ALLOW', idToken: A.idToken,
                data: { leaveType: '事假', leaveTypeName: '事假', reason: 'zz_test 事假事由', allowedTeacherIds: [A.teacherId] },
            },
        ],
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

    // ===================== 攻擊 Phase 6 補充：private/detail（X15-X24） =====================

    cases.push({
        id: 'X15', type: 'attack', actor: 'A(教師甲)', method: 'GET', severity: 'critical',
        desc: '攻擊⑮教師甲 讀取 ACL 不含自己的私有明細（P13 乙的自我調課明細，核心隱私邊界）',
        path: `${col.records}/${docId.recApprove2}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:223/107-110 hasPrivateDetailAccess（非 approver 且不在 allowedTeacherIds）',
        steps: [{ kind: 'get', label: '甲嘗試讀取乙的私有明細', docPath: `${col.records}/${docId.recApprove2}/private/detail`, expect: 'DENY', idToken: A.idToken }],
    });

    cases.push({
        id: 'X16', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑯教師甲 建立紀錄私有明細但假別為「公假」（規避月結算扣減）',
        path: `${col.records}/${docId.recAttack16}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:230 私有明細 create 教師分支 leaveType in [調課,swap] 限制',
        steps: [{
            kind: 'create', label: 'create 假別=公假', collectionPath: `${col.records}/${docId.recAttack16}/private`, docId: 'detail', expect: 'DENY', idToken: A.idToken,
            data: { leaveType: '公假', leaveTypeName: '公假', reason: 'zz_test 攻擊：假造公假', allowedTeacherIds: [A.teacherId] },
        }],
    });

    cases.push({
        id: 'X17', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑰教師甲 建立紀錄私有明細但假別為「長期病假」',
        path: `${col.records}/${docId.recAttack17}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:230 私有明細 create 教師分支 leaveType in [調課,swap] 限制',
        steps: [{
            kind: 'create', label: 'create 假別=長期病假', collectionPath: `${col.records}/${docId.recAttack17}/private`, docId: 'detail', expect: 'DENY', idToken: A.idToken,
            data: { leaveType: '長期病假', leaveTypeName: '長期病假', reason: 'zz_test 攻擊：假造長期病假', allowedTeacherIds: [A.teacherId] },
        }],
    });

    cases.push({
        id: 'X18', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑱教師甲 建立紀錄私有明細但假別為「喪假」',
        path: `${col.records}/${docId.recAttack18}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:230 私有明細 create 教師分支 leaveType in [調課,swap] 限制',
        steps: [{
            kind: 'create', label: 'create 假別=喪假', collectionPath: `${col.records}/${docId.recAttack18}/private`, docId: 'detail', expect: 'DENY', idToken: A.idToken,
            data: { leaveType: '喪假', leaveTypeName: '喪假', reason: 'zz_test 攻擊：假造喪假', allowedTeacherIds: [A.teacherId] },
        }],
    });

    cases.push({
        id: 'X19', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑲教師甲 建立紀錄私有明細但假別為「事假」（對照 P19：同假別在 pendingRequests 路徑合法，在 substituteRecords 路徑應違規）',
        path: `${col.records}/${docId.recAttack19}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:230 私有明細 create 教師分支 leaveType in [調課,swap] 限制',
        steps: [{
            kind: 'create', label: 'create 假別=事假', collectionPath: `${col.records}/${docId.recAttack19}/private`, docId: 'detail', expect: 'DENY', idToken: A.idToken,
            data: { leaveType: '事假', leaveTypeName: '事假', reason: 'zz_test 攻擊：substituteRecords 路徑假造事假', allowedTeacherIds: [A.teacherId] },
        }],
    });

    cases.push({
        id: 'X20', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊⑳教師甲 建立私有明細但 allowedTeacherIds 不含自己（冒他人之名建立，假別合法僅 ACL 違規）',
        path: `${col.records}/${docId.recAttack20}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:228-229 私有明細 create 教師分支 myTeacherId in allowedTeacherIds 限制',
        steps: [{
            kind: 'create', label: 'create ACL=[乙]（不含自己）', collectionPath: `${col.records}/${docId.recAttack20}/private`, docId: 'detail', expect: 'DENY', idToken: A.idToken,
            data: { leaveType: '調課', leaveTypeName: '調課', reason: 'zz_test 攻擊：冒名建立', allowedTeacherIds: [B.teacherId] },
        }],
    });

    cases.push({
        id: 'X21', type: 'attack', actor: 'A(教師甲)', method: 'PATCH', severity: 'high',
        desc: '攻擊㉑教師甲 update 既有私有明細（即使是自己剛建立的 P16 明細，update 僅限 approver）',
        path: `${col.records}/${docId.recSelfSwap1}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:233 私有明細 update（僅 isApprover，不看 ACL 或建立者）',
        steps: [{
            kind: 'patch', label: '甲嘗試改寫自己建立的私有明細', docPath: `${col.records}/${docId.recSelfSwap1}/private/detail`, expect: 'DENY', idToken: A.idToken,
            data: { leaveType: '長期病假', leaveTypeName: '長期病假' },
        }],
    });

    cases.push({
        id: 'X22', type: 'attack', actor: 'A(教師甲)', method: 'DELETE', severity: 'high',
        desc: '攻擊㉒教師甲 delete 私有明細（delete 僅限 director）',
        path: `${col.records}/${docId.recSelfSwap1}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:234 私有明細 delete（僅 isDirector）',
        steps: [{ kind: 'delete', label: '甲嘗試刪除私有明細', docPath: `${col.records}/${docId.recSelfSwap1}/private/detail`, expect: 'DENY', idToken: A.idToken }],
    });

    cases.push({
        id: 'X23', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'medium',
        desc: '攻擊㉓教師甲 建立私有明細時夾帶白名單外欄位（note），應被 hasOnly 擋下',
        path: `${col.records}/${docId.recAttack23}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:113 isValidPrivateDetailWrite() hasOnly 欄位白名單',
        steps: [{
            kind: 'create', label: 'create 夾帶 note 欄位', collectionPath: `${col.records}/${docId.recAttack23}/private`, docId: 'detail', expect: 'DENY', idToken: A.idToken,
            data: { leaveType: '調課', leaveTypeName: '調課', reason: '', allowedTeacherIds: [A.teacherId], note: 'zz_test 白名單外欄位' },
        }],
    });

    cases.push({
        id: 'X24', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'medium',
        desc: '攻擊㉔教師甲 建立私有明細但 allowedTeacherIds 不是陣列（型別檢查）',
        path: `${col.records}/${docId.recAttack24}/private/detail`, expect: 'DENY',
        rulesRef: 'rules:114 isValidPrivateDetailWrite() data.allowedTeacherIds is list 型別檢查',
        steps: [{
            kind: 'create', label: 'create allowedTeacherIds=字串', collectionPath: `${col.records}/${docId.recAttack24}/private`, docId: 'detail', expect: 'DENY', idToken: A.idToken,
            data: { leaveType: '調課', leaveTypeName: '調課', reason: '', allowedTeacherIds: A.teacherId },
        }],
    });

    // ===================== Stage 0 補充攻擊案例（X25-X28，驗收修復 S10）=====================
    // 只寫碼、未執行（見 STsystem 驗收流程：正式庫寫入須經人工確認，本檔規範上不自動跑）。

    cases.push({
        id: 'X25', type: 'attack', actor: 'A(教師甲)', method: 'GET', severity: 'critical',
        desc: '攻擊㉕教師甲 跨校讀 teachers（schoolId 換成一個確定不存在的學校，isMember 應恆為 false）',
        path: `schools/${OTHER_SCHOOL_ID}/teachers/${A.teacherId}`, expect: 'DENY',
        rulesRef: 'firestore.rules teachers read（isMember(schoolId)，Stage 0 R3）——跨校 mappingExists 恆為 false',
        steps: [{ kind: 'get', label: '甲跨校讀 teachers', docPath: `schools/${OTHER_SCHOOL_ID}/teachers/${A.teacherId}`, expect: 'DENY', idToken: A.idToken }],
    });

    cases.push({
        id: 'X26', type: 'attack', actor: 'A(教師甲)', method: 'GET', severity: 'high',
        // 驗收修復 N2：不要用 B.email 組 emailKey——B(v2t2) 的憑證檔不保證帶 email 欄位，
        // 之前用 `B.email || 'zz_test_...'` 這種寫法在 B.email 缺失時會恆走 fallback 字面值，
        // 導致「用乙的 email」這個描述失真（實際測的一直是同一個固定字面值）。改成一開始
        // 就用固定字面值、描述也如實反映「一個確定不是甲自己的 email」，不宣稱是特定同事的。
        desc: '攻擊㉖教師甲 get 非本人的 emailIndex（emailKey 用固定字面值，確定不是甲自己的 email）',
        path: `${col.emailIndex}/zz_test_not_mine@example.com`, expect: 'DENY',
        rulesRef: 'firestore.rules emailIndex get（emailKey == userEmail().lower()，Stage 0 §3.4a + 驗收修復 S5）',
        steps: [{
            kind: 'get', label: '甲讀非自己的 emailIndex 條目（固定字面值）',
            docPath: `${col.emailIndex}/zz_test_not_mine@example.com`,
            expect: 'DENY', idToken: A.idToken,
        }],
    });

    cases.push({
        id: 'X27', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'medium',
        desc: '攻擊㉗教師甲 建立 joinAttempts 時夾帶白名單外第 4 個欄位（note）',
        path: `${col.joinAttempts}/${A.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules joinAttempts create（hasOnly([email,attemptedAt,reason])，驗收修復 S3）',
        steps: [{
            kind: 'create', label: 'create 夾帶 note 欄位', collectionPath: col.joinAttempts, docId: A.uid, expect: 'DENY', idToken: A.idToken,
            data: { email: 'zz_test_attacker@example.com', attemptedAt: nowIso(), reason: 'zz_test', note: 'zz_test 白名單外欄位' },
        }],
    });

    cases.push({
        id: 'X28', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'medium',
        desc: '攻擊㉘教師甲 建立 joinAttempts 時 reason 超過 100 字元（長度驗證）',
        path: `${col.joinAttempts}/${A.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules joinAttempts create（reason.size() < 100，驗收修復 S3）',
        steps: [{
            kind: 'create', label: 'create reason 超長字串', collectionPath: col.joinAttempts, docId: A.uid, expect: 'DENY', idToken: A.idToken,
            data: { email: 'zz_test_attacker@example.com', attemptedAt: nowIso(), reason: 'x'.repeat(150) },
        }],
    });

    cases.push({
        id: 'X29', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'medium',
        desc: '攻擊㉙教師甲 對自創（不存在）的 schoolId 寫 joinAttempts，應被 configExists 擋下',
        path: `schools/${OTHER_SCHOOL_ID}/joinAttempts/${A.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules joinAttempts create（configExists(schoolId)，驗收修復 S3）',
        steps: [{
            kind: 'create', label: '對不存在的 schoolId 寫 joinAttempts',
            collectionPath: `schools/${OTHER_SCHOOL_ID}/joinAttempts`, docId: A.uid, expect: 'DENY', idToken: A.idToken,
            data: { email: 'zz_test_attacker@example.com', attemptedAt: nowIso(), reason: 'zz_test' },
        }],
    });

    cases.push({
        id: 'X30', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'high',
        // 黑箱測試的既有限制（與 X01/X20 等案例同源）：本檔三個測試帳號角色固定為
        // 教師甲/教師乙/組長丙（無 director），emailIndex 的 create/update 規則是
        // `isDirector(schoolId) && hasOnly(['teacherId'])` 兩個條件的 AND，用非 director
        // 帳號測試時，最終 DENY 由 isDirector() 與 hasOnly() 共同保證，黑箱測試無法單獨
        // 分離出「純粹因為 hasOnly 擋下」的證據——但這就是驗收要的案例本身（emailIndex
        // 寫入夾帶 teacherId 以外欄位應被擋），只是同時也驗證了 isDirector() 那一半。
        desc: '攻擊㉚教師甲（非 director）寫 emailIndex 時夾帶 teacherId 以外的欄位（extra），應被 hasOnly 與 isDirector 共同擋下',
        path: `${col.emailIndex}/zz_test_attacker2@example.com`, expect: 'DENY',
        rulesRef: 'firestore.rules emailIndex create/update（isDirector(schoolId) && hasOnly([\'teacherId\'])，驗收修復 S9）',
        steps: [{
            kind: 'create', label: 'create 夾帶 extra 欄位',
            collectionPath: col.emailIndex, docId: 'zz_test_attacker2@example.com',
            expect: 'DENY', idToken: A.idToken,
            data: { teacherId: A.teacherId, extra: 'zz_test 白名單外欄位' },
        }],
    });

    // ===================== Stage 4 補充攻擊案例（X31-X39） =====================
    // 只寫碼、未執行（本次任務範圍明確要求「不寫 Firestore、不跑本檔」，比照上面
    // Stage 0 補充案例 X25-X30 的既有先例）。
    //
    // 刻意全部是攻擊／DENY 案例，不寫正向／ALLOW 案例，理由：
    //   1. schoolApplications 的 create/update 規則要求 isEmailVerified()（token 的
    //      email_verified 欄位），本檔三個測試帳號（v2t1/v2t2/v2t3）的實際驗證狀態未知
    //      （且如 X26 案例註解所述，憑證檔甚至不保證帶 `.email` 欄位）——若拿一個
    //      email_verified 狀態未知的帳號寫「應該 ALLOW」的正向案例，測試失敗時無法分辨
    //      是「規則真的有 bug」還是「這個測試帳號剛好沒驗證 email」，會產生誤導性的紅燈。
    //      DENY 案例沒有這個問題：不論 email_verified 是真是假，凡是下面任何一個案例，
    //      都還有至少一個「與 email_verified 無關」的理由必然導致 DENY（uid 不符／欄位
    //      白名單外／狀態機非法／根本不是 platformAdmin），結果穩定可預期。
    //   2. schoolDirectory／platformAdmins 的「讀取本人可讀但文件不存在」情境，Firestore
    //      REST getDocument 對「規則放行但文件不存在」的實際回應（是 404 NOT_FOUND 還是
    //      200 附空 fields）未經本次查證，`classify()`（僅認 200→ALLOW／403→DENY，其餘
    //      一律 ERROR）在這個情境下可能誤判為 ERROR 而非 ALLOW——為避免寫出一條「跑起來
    //      多半會顯示 ERROR、卻不代表規則有問題」的誤導案例，本次不寫這類正向讀取案例。
    //   3. 核准流程（approveApplication）需要一個真正的 platformAdmin 測試帳號才能走完整
    //      「申請→核准→開通新學校」鏈路，本檔三個帳號都不是 platformAdmin（見上）也不會
    //      臨時被加入 platformAdmins（那需要另外執行 scripts/bootstrap-platform-admin.js，
    //      超出本次「只寫不執行」的範圍）——這條鏈路的正確性已在
    //      docs/STAGE4-DEPLOY.md／本次交付報告的「全鏈走讀」中以程式碼引用＋規則行號的方式
    //      逐步推演，留待日後有專用 platformAdmin 測試帳號時再補正向端到端案例。
    const zzNewSchoolId = 'zz_test_stage4_school_never_created';

    cases.push({
        id: 'X31', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'high',
        desc: '攻擊㉛教師甲 建立 schoolApplications 時 applicantUid 指向別人（乙），應被 applicantUid==uid 擋下',
        path: `schoolApplications/${A.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules schoolApplications create（request.resource.data.applicantUid == uid，rules:908 起）',
        steps: [{
            kind: 'create', label: 'create applicantUid 指向乙',
            collectionPath: 'schoolApplications', docId: A.uid, expect: 'DENY', idToken: A.idToken,
            data: {
                schoolName: 'zz_test_school_x31', applicantEmail: 'zz_test_x31@example.com',
                applicantUid: B.uid, desiredSchoolId: 'zz_test_id_x31',
                status: 'pending', createdAt: nowIso(), updatedAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'X32', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'medium',
        desc: '攻擊㉜教師甲 建立 schoolApplications 時夾帶白名單外欄位（note）',
        path: `schoolApplications/${A.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules schoolApplications create（keys().hasOnly([...])，rules:908 起）',
        steps: [{
            kind: 'create', label: 'create 夾帶 note 欄位',
            collectionPath: 'schoolApplications', docId: A.uid, expect: 'DENY', idToken: A.idToken,
            data: {
                schoolName: 'zz_test_school_x32', applicantEmail: 'zz_test_x32@example.com',
                applicantUid: A.uid, desiredSchoolId: 'zz_test_id_x32',
                status: 'pending', createdAt: nowIso(), updatedAt: nowIso(),
                note: 'zz_test 白名單外欄位',
            },
        }],
    });

    cases.push({
        id: 'X33', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊㉝教師甲 建立 schoolApplications 時直接把 status 寫成 approved（跳過審核自我核准）',
        path: `schoolApplications/${A.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules schoolApplications create（request.resource.data.status == \'pending\'，rules:908 起）',
        steps: [{
            kind: 'create', label: 'create status=approved',
            collectionPath: 'schoolApplications', docId: A.uid, expect: 'DENY', idToken: A.idToken,
            data: {
                schoolName: 'zz_test_school_x33', applicantEmail: 'zz_test_x33@example.com',
                applicantUid: A.uid, desiredSchoolId: 'zz_test_id_x33',
                status: 'approved', createdAt: nowIso(), updatedAt: nowIso(),
            },
        }],
    });

    cases.push({
        id: 'X34', type: 'attack', actor: 'A(教師甲)', method: 'GET', severity: 'high',
        desc: '攻擊㉞教師甲（非 platformAdmin）讀取乙的 schoolApplications 文件',
        path: `schoolApplications/${B.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules schoolApplications read（request.auth.uid == uid || isPlatformAdmin()，rules:908 起）',
        steps: [{ kind: 'get', label: '甲讀乙的申請文件', docPath: `schoolApplications/${B.uid}`, expect: 'DENY', idToken: A.idToken }],
    });

    cases.push({
        id: 'X35', type: 'attack', actor: 'A(教師甲)', method: 'PATCH', severity: 'critical',
        desc: '攻擊㉟教師甲（非 platformAdmin、非申請人本人）嘗試把乙的 schoolApplications 狀態改成 approved',
        path: `schoolApplications/${B.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules schoolApplications update（isPlatformAdmin() 分支 || 本人 rejected→pending 分支，rules:908 起）',
        steps: [{
            kind: 'patch', label: '甲竄改乙的申請狀態',
            docPath: `schoolApplications/${B.uid}`, expect: 'DENY', idToken: A.idToken,
            data: { status: 'approved', updatedAt: nowIso() },
        }],
    });

    cases.push({
        id: 'X36', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊㊱教師甲 嘗試自行把自己寫入 platformAdmins（自我提權為平台管理者）',
        path: `platformAdmins/${A.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules platformAdmins write（恆為 false，rules:876-881）',
        steps: [{
            kind: 'create', label: '自我寫入 platformAdmins',
            collectionPath: 'platformAdmins', docId: A.uid, expect: 'DENY', idToken: A.idToken,
            data: { addedAt: nowIso(), addedBy: 'zz_test_self', note: 'zz_test 自我提權' },
        }],
    });

    cases.push({
        id: 'X37', type: 'attack', actor: 'A(教師甲)', method: 'GET', severity: 'medium',
        desc: '攻擊㊲教師甲 讀取乙的 platformAdmins 文件（只能讀自己那一份）',
        path: `platformAdmins/${B.uid}`, expect: 'DENY',
        rulesRef: 'firestore.rules platformAdmins read（request.auth.uid == uid，rules:876-881）',
        steps: [{ kind: 'get', label: '甲讀乙的 platformAdmins', docPath: `platformAdmins/${B.uid}`, expect: 'DENY', idToken: A.idToken }],
    });

    cases.push({
        id: 'X38', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'high',
        desc: '攻擊㊳教師甲（非 platformAdmin）嘗試建立 schoolDirectory 條目',
        path: `schoolDirectory/${zzNewSchoolId}`, expect: 'DENY',
        rulesRef: 'firestore.rules schoolDirectory create（isPlatformAdmin()，rules:887 起）',
        steps: [{
            kind: 'create', label: '非 platformAdmin 建立學校名錄',
            collectionPath: 'schoolDirectory', docId: zzNewSchoolId, expect: 'DENY', idToken: A.idToken,
            data: { schoolName: 'zz_test 冒名建校', createdAt: nowIso() },
        }],
    });

    cases.push({
        id: 'X39', type: 'attack', actor: 'A(教師甲)', method: 'CREATE', severity: 'critical',
        desc: '攻擊㊴教師甲（非 platformAdmin、也非該校 director——該校根本不存在）嘗試建立全新學校的 config/main',
        path: `schools/${zzNewSchoolId}/config/main`, expect: 'DENY',
        rulesRef: 'firestore.rules schools/{schoolId}/config/{docId} create（isPlatformAdmin() && isValidNewSchoolConfigWrite，rules:370）',
        steps: [{
            kind: 'create', label: '非 platformAdmin 建立新學校 config',
            collectionPath: `schools/${zzNewSchoolId}/config`, docId: 'main', expect: 'DENY', idToken: A.idToken,
            data: {
                schoolName: 'zz_test 冒名建校', currentSemester: '114-2',
                initialAdminEmails: ['zz_test_attacker@example.com'],
                createdAt: nowIso(), updatedAt: nowIso(),
            },
        }],
    });

    // ===================== opus 驗收 M5 補充案例（X40-X42） =====================
    // 只寫碼、未執行，理由同上（見 X31-X39 區塊開頭說明）。

    cases.push({
        id: 'X40', type: 'attack', actor: 'A(教師甲)', method: 'CREATE then PATCH', severity: 'high',
        // opus 驗收 R3：原版第一步是「甲合法建立自己的 pending 申請」（ALLOW），問題是
        // schoolApplications 的 delete 規則恆為 false、且駁回/核准都需要 platformAdmin 才能
        // 觸發——這筆文件會永久留在 A 帳號名下（status 永遠停在 pending，沒有任何清理路徑），
        // 每次執行本檔測試都會多一筆殘留，長期會污染 A 帳號的申請紀錄與 platformAdmin 審核
        // 清單。改為兩步皆為 DENY 的版本，不寫入任何會持久存在的文件：用一個不屬於甲的合成
        // doc id（不是 A.uid），驗證「陌生人無法在別人的／合成的申請路徑上建立或更新文件」。
        // ⚠ 範圍限縮（如實記錄，不假裝仍覆蓋原本範圍）：這個版本不再驗證原本 M5 想測的
        // 「申請人在 pending 期間對自己的申請 update DENY」——那需要一份真實存在、屬於甲自己
        // 的 pending 文件，建立它就會產生上述殘留問題。這是刻意接受的覆蓋縮小（避免測試副
        // 作用 > 保留原始語意）；規則本身這一段的邏輯（自寫分支要求 `resource.data.status==
        // 'rejected'` 才能 update，pending 狀態下必然不成立）屬於單純的欄位比對，可讀性高、
        // 出錯風險低，人工複查規則文字即可，不強求自動化案例覆蓋。
        desc: '攻擊㊵教師甲嘗試對一個不屬於自己的（合成）schoolApplications doc id 建立並更新為 approved',
        path: `schoolApplications/${zz('x40_stranger_app')}`, expect: 'DENY',
        rulesRef: 'firestore.rules schoolApplications create（request.auth.uid == uid，rules:917 起）＋ update（非本人、非 platformAdmin 恆 DENY，rules:940 起）',
        steps: [
            {
                kind: 'create', label: '甲嘗試在非自己 uid 的路徑建立申請',
                collectionPath: 'schoolApplications', docId: zz('x40_stranger_app'), expect: 'DENY', idToken: A.idToken,
                data: {
                    schoolName: 'zz_test_school_x40', applicantEmail: 'zz_test_x40@example.com',
                    applicantUid: A.uid, desiredSchoolId: 'zz_test_id_x40',
                    status: 'pending', createdAt: nowIso(), updatedAt: nowIso(),
                },
            },
            {
                kind: 'patch', label: '甲嘗試更新同一個（應該不存在的）文件為 approved',
                docPath: `schoolApplications/${zz('x40_stranger_app')}`, expect: 'DENY', idToken: A.idToken,
                data: { status: 'approved', updatedAt: nowIso() },
            },
        ],
    });

    // ⚠ 已知覆蓋缺口（opus 驗收 M5／R4，如實記錄而非湊一個假案例，不寫會因為錯誤理由才
    // DENY 的誤導性案例）：
    //
    // 1. 「platformAdmin 把一筆 status=='approved' 的申請改成 'rejected' 以外的值應 DENY」
    //    （對應 firestore.rules 的 update 規則 platformAdmin 分支：只允許
    //    pending→{approved,rejected} 與 approved→rejected 兩條路徑，approved→其他值皆不合法）
    //    需要一個真正的 platformAdmin 測試帳號才能先合法把某筆申請推進到 approved 狀態，本檔
    //    三個帳號（v2t1/v2t2/v2t3）皆非 platformAdmin，無法在不執行
    //    scripts/bootstrap-platform-admin.js（本次任務範圍明確排除）的情況下建立這個前置
    //    狀態。硬湊一個「非 platformAdmin 對某份文件送出這個更新」的案例，DENY 的真正原因
    //    會是「根本不是 platformAdmin」而非「approved→非rejected 的狀態機不合法」，兩者是
    //    規則裡不同的檢查點，掛羊頭賣狗肉沒有實質驗證價值，故不寫。
    //
    // 2. 「非 platformAdmin 對一筆已存在的 schoolDirectory 文件執行 update 應 DENY」
    //    （對應 `schoolDirectory` 的 `allow update: if false;`）——opus 驗收 R4 訂正：原版
    //    在這裡寫了一個對**不存在**文件送出 PATCH 的案例（用 `zzNewSchoolId`，一個從未建立
    //    過的路徑）。這個案例雖然會回傳 DENY（符合預期），但驗證的其實不是 `update: if
    //    false` 這條規則——Firestore 對「目標文件是否已存在」決定該次寫入請求要被歸類為
    //    `create` 還是 `update`，PATCH 到一個不存在的文件，規則引擎很可能是依 `create` 規則
    //    （`isPlatformAdmin()`）評估，而非 `update` 規則（`if false`），兩者剛好都會拒絕
    //    非 platformAdmin 的甲，讓案例「看起來通過」，但實際上完全沒驗證到 `update: if
    //    false` 這條規則本身——是一個會亮綠燈、卻檢驗到錯誤機制的假測試，故移除。要真正驗證
    //    `update: if false`，需要先有一份**已存在**的 `schoolDirectory` 文件（只有
    //    platformAdmin 能建立），同一個「缺 platformAdmin 測試帳號」的限制，日後與上一項一併
    //    補上。（`allow delete: if false` 不受此問題影響——delete 請求不論目標是否存在，
    //    Firestore 都直接歸類為 `delete` 方法，見下方 X42 保留為有效案例。）

    cases.push({
        id: 'X42', type: 'attack', actor: 'A(教師甲)', method: 'DELETE', severity: 'medium',
        desc: '攻擊㊷教師甲嘗試 delete 一筆 schoolDirectory 文件（規則恆為 false）',
        path: `schoolDirectory/${zzNewSchoolId}`, expect: 'DENY',
        rulesRef: 'firestore.rules schoolDirectory delete（allow delete: if false，rules:887 起）',
        steps: [{
            kind: 'delete', label: '嘗試 delete schoolDirectory',
            docPath: `schoolDirectory/${zzNewSchoolId}`, expect: 'DENY', idToken: A.idToken,
        }],
    });

    return cases;
}

// ---------------------------------------------------------------------------
// UTF-8 中文往返驗證（獨立於 43 案矩陣之外）：
// 用 approver 直接建立 leaveType='調課' 的私有明細，立刻讀回並比對解碼後的字串是否
// 「精確等於」'調課'（附上逐字元 code point，避免看起來像但實為亂碼/相近字的假陽性）。
// 動機：Node 內建 fetch 對字串 body 預設以 UTF-8 編碼送出，但先前用 PowerShell 手測
// 時曾因非 UTF-8 編碼送出中文，導致 leaveType in ['調課','swap'] 誤判 DENY——此檢查
// 確保本檔案後續所有依賴中文字面比對的案例（P16/P19/X16-X20 等）結果站得住腳。
// 用 approver 身分建立是刻意選擇：isApprover 分支不檢查 leaveType 值，ALLOW/DENY
// 本身不能證明編碼正確，必須額外做「讀回後精確比對」才算數。
// ---------------------------------------------------------------------------
async function runUtf8RoundTripCheck(C) {
    const recId = zz('rec_utf8check');
    const parentPath = `schools/${SCHOOL_ID}/substituteRecords/${recId}`;
    const detailPath = `${parentPath}/private/detail`;
    const EXPECTED = '調課';

    const createParent = await createDoc(`schools/${SCHOOL_ID}/substituteRecords`, recId, {
        type: '調課', isSelfSwap: true,
        originalTeacherId: C.teacherId, swapTeacherId: C.teacherId, substituteTeacherId: C.teacherId,
        date: '2026-08-15', period: '第一節', className: 'zz_test_utf8',
        status: 'approved', approvedAt: nowIso(), approvedBy: C.teacherId, approvedByName: C.label,
        createdAt: nowIso(),
    }, C.idToken);
    if (classify(createParent) !== 'ALLOW') {
        return { pass: false, detail: `建立驗證用父文件失敗（HTTP ${createParent.httpStatus}），無法進行 UTF-8 往返驗證。body=${JSON.stringify(createParent.json).slice(0, 300)}` };
    }
    createdDocs.push(`schools/${SCHOOL_ID}/substituteRecords/${recId}`);

    const createDetail = await createDoc(`${parentPath}/private`, 'detail', {
        leaveType: EXPECTED, leaveTypeName: EXPECTED, reason: 'zz_test utf8 round-trip 中文編碼驗證',
        allowedTeacherIds: [C.teacherId],
    }, C.idToken);
    if (classify(createDetail) !== 'ALLOW') {
        return { pass: false, detail: `建立驗證用私有明細失敗（HTTP ${createDetail.httpStatus}），無法進行 UTF-8 往返驗證。body=${JSON.stringify(createDetail.json).slice(0, 300)}` };
    }
    createdDocs.push(`${parentPath}/private/detail`);

    const got = await getDoc(detailPath, C.idToken);
    if (classify(got) !== 'ALLOW') {
        return { pass: false, detail: `讀回驗證用私有明細失敗（HTTP ${got.httpStatus}）。` };
    }
    const obj = docToObj(got.json);
    const roundTripOk = obj.leaveType === EXPECTED;
    const gotCodePoints = typeof obj.leaveType === 'string' ? [...obj.leaveType].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ') : '(非字串)';
    const expectedCodePoints = [...EXPECTED].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ');
    return {
        pass: roundTripOk,
        detail: roundTripOk
            ? `讀回 leaveType = ${JSON.stringify(obj.leaveType)}（${gotCodePoints}），與寫入值 '${EXPECTED}'（${expectedCodePoints}）精確相等。`
            : `⚠⚠ 讀回 leaveType = ${JSON.stringify(obj.leaveType)}（型別 ${typeof obj.leaveType}，${gotCodePoints}），與預期 '${EXPECTED}'（${expectedCodePoints}）不符！UTF-8 編碼可能有誤，後續案例中的中文字面比對結果不可信，須人工複查。`,
    };
}

// ---------------------------------------------------------------------------
// 正式紀錄完整性檢查（驗收條件⑤）：本檔案唯一會「讀取」的正式資料是
// REAL_RECORD_WITH_PRIVATE_DETAIL，全程只 GET，這裡確認跑完整套 43 案後它的
// private/detail.leaveType 仍是「長期病假」——證明本檔案沒有意外寫壞正式資料。
// ---------------------------------------------------------------------------
async function verifyProdRecordUntouched(C) {
    const path = `schools/${SCHOOL_ID}/substituteRecords/${REAL_RECORD_WITH_PRIVATE_DETAIL}/private/detail`;
    const got = await getDoc(path, C.idToken);
    if (classify(got) !== 'ALLOW') {
        return { pass: false, detail: `讀取正式紀錄 private/detail 失敗（HTTP ${got.httpStatus}），無法驗證是否遭更動。` };
    }
    const obj = docToObj(got.json);
    const ok = obj.leaveType === REAL_RECORD_EXPECTED_LEAVE_TYPE;
    return {
        pass: ok,
        detail: ok
            ? `${REAL_RECORD_WITH_PRIVATE_DETAIL} 的 private/detail.leaveType 仍為 '${REAL_RECORD_EXPECTED_LEAVE_TYPE}'，未遭更動。`
            : `⚠⚠ ${REAL_RECORD_WITH_PRIVATE_DETAIL} 的 private/detail.leaveType 現為 ${JSON.stringify(obj.leaveType)}，預期 '${REAL_RECORD_EXPECTED_LEAVE_TYPE}'——正式紀錄可能已被本次測試意外更動，須立即人工複查！`,
    };
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

    console.log('\n--- UTF-8 中文往返驗證（approver 建立 leaveType=調課 後讀回比對，見驗收條件③）---');
    let utf8Pass = false;
    try {
        const r = await runUtf8RoundTripCheck(C);
        utf8Pass = r.pass;
        console.log(`${r.pass ? '✓' : '✗✗'} ${r.detail}`);
    } catch (e) {
        console.error(`✗✗ UTF-8 往返驗證發生例外：${String(e && e.message || e)}`);
    }

    console.log(`\n--- 正式紀錄完整性檢查（${REAL_RECORD_WITH_PRIVATE_DETAIL} 不得被本次測試更動，見驗收條件⑤）---`);
    let prodIntegrityPass = false;
    try {
        const r = await verifyProdRecordUntouched(C);
        prodIntegrityPass = r.pass;
        console.log(`${r.pass ? '✓' : '✗✗'} ${r.detail}`);
    } catch (e) {
        console.error(`✗✗ 正式紀錄完整性檢查發生例外：${String(e && e.message || e)}`);
    }

    process.exit((failCount === 0 && utf8Pass && prodIntegrityPass) ? 0 : 1);
}

main().catch((err) => {
    console.error('\n未預期錯誤：', err);
    process.exit(1);
});
