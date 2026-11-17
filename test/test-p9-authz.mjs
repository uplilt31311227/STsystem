/**
 * P9 批次 A2：前端邏輯（假 Firebase SDK，離線）
 *   - 職務分離 approvalPolicy／approveRequest 守門／核准按鈕 HTML（SB-I7）
 *   - 白名單失效旗標：authGuardV2 在 directorEstablished 為 true 時不再走白名單分支；正式主任登入時補設旗標（SB-L9）
 *   - platformAdmin 進入學校的身分（resolvePlatformAdminIdentity）、roleService.isPlatformAdmin
 * rules 端的對應限制見 test/emulator/rules-p9-authz.mjs。
 * 執行：node test/test-p9-authz.mjs
 */
import { register } from 'node:module';
register('./helpers/gstatic-stub-loader.mjs', import.meta.url);

globalThis.window = globalThis;
globalThis.location = { hostname: 'example.test', search: '' };
globalThis.addEventListener = () => {};
globalThis.document = { getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const F = (globalThis.__fake = { docs: new Map(), writes: [] });

const policy = await import('../src/js/modules/v2/approvalPolicy.js');
const req = await import('../src/js/modules/v2/pendingRequestService.js');
const roleSvc = await import('../src/js/modules/v2/roleService.js');
const semesterState = await import('../src/js/modules/v2/semesterState.js');
const authGuard = await import('../src/js/modules/v2/authGuardV2.js');
const htmlRows = await import('../src/js/modules/v2/htmlRows.js');
const { SCHEMA_PATHS, getActiveSchoolId, setActiveSchoolId, resetActiveSchoolId } = await import('../src/js/modules/v2/schemaConstants.js');

let failed = 0;
function check(name, cond, detail = '') {
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
    if (!cond) failed++;
}
const realLog = console.log, realWarn = console.warn, realErr = console.error;
const quiet = () => { console.log = () => {}; console.warn = () => {}; console.error = () => {}; };
quiet();

semesterState.setCurrentSemesterId('115-1');
const reset = () => { F.docs.clear(); F.writes.length = 0; roleSvc.clearCurrentIdentity(); resetActiveSchoolId(); };
const P = (id) => SCHEMA_PATHS.pendingDoc(id);

/* ===================== approvalPolicy（純函式） ===================== */
const me = { uid: 'u_chief', teacherId: 't_chief' };
const selfSwap = (id) => ({ initiatedBy: id, isSelfSwap: true, originalTeacherId: id, swapTeacherId: id, substituteTeacherId: id, pendingConsentTeacherIds: [], requiredApproverId: null });

check('policy：核准別人發起的申請 → ok', policy.checkApprovalSeparation({ initiatedBy: 't_wang', requestType: 'substitute' }, me).ok === true);
check('policy：自己（teacherId）發起、有他人牽涉 → 不可核准，附原因', (() => {
    const r = policy.checkApprovalSeparation({ initiatedBy: 't_chief', originalTeacherId: 't_chief', substituteTeacherId: 't_x', requestType: 'substitute' }, me);
    return r.ok === false && /自己發起/.test(r.reason);
})());
check('policy：自己（uid，platformAdmin 的 teacherId＝uid）發起 → 不可核准', policy.checkApprovalSeparation({ initiatedBy: 'u_chief', substituteTeacherId: 't_x' }, { uid: 'u_chief', teacherId: 'u_chief' }).ok === false);
check('policy：自己 uid 與 teacherId 不同時，兩者任一是 initiatedBy 都擋（platformAdmin 兼成員）', policy.checkApprovalSeparation({ initiatedBy: 't_chief', substituteTeacherId: 't_x' }, me).ok === false
    && policy.checkApprovalSeparation({ initiatedBy: 'u_chief', substituteTeacherId: 't_x' }, me).ok === false);
check('policy：自我調課且無他人牽涉 → 可核准自己的（例外）', policy.checkApprovalSeparation(selfSwap('t_chief'), me).ok === true);
check('policy：自我調課但 swapTeacherId 是別人 → 不可', policy.checkApprovalSeparation({ ...selfSwap('t_chief'), swapTeacherId: 't_x' }, me).ok === false);
check('policy：自我調課但有待同意人 → 不可', policy.checkApprovalSeparation({ ...selfSwap('t_chief'), pendingConsentTeacherIds: ['t_x'] }, me).ok === false);
check('policy：isSelfSwap 缺失（三個 id 都是自己）→ 不可', policy.checkApprovalSeparation({ ...selfSwap('t_chief'), isSelfSwap: false }, me).ok === false);
check('policy：原任課教師不是自己 → 不可', policy.checkApprovalSeparation({ ...selfSwap('t_chief'), originalTeacherId: 't_other' }, me).ok === false);
check('policy：swapTeacherId／substituteTeacherId 為 null（未解析）視同無他人', policy.checkApprovalSeparation({ ...selfSwap('t_chief'), swapTeacherId: null, substituteTeacherId: undefined }, me).ok === true);
check('policy：缺 initiatedBy 或缺身分 → 不擋（rules 為最終防線）', policy.checkApprovalSeparation({}, me).ok === true && policy.checkApprovalSeparation({ initiatedBy: 'x' }, null).ok === true);

check('policy：舊申請缺 initiatedBy，platformAdmin → 不可核准並說明原因（與 rules 對非成員 platformAdmin 的判定一致）', (() => {
    const r = policy.checkApprovalSeparation({ requestType: 'substitute' }, { uid: 'u_pa', teacherId: 'u_pa', isPlatformAdmin: true });
    return r.ok === false && /沒有記錄發起人/.test(r.reason);
})());
check('policy：舊申請缺 initiatedBy，一般組長 → 仍可核准', policy.checkApprovalSeparation({ initiatedBy: '' }, me).ok === true);

/* ===================== 核准按鈕 HTML ===================== */
const okHtml = htmlRows.approvalActions({ reqId: 'r1' });
const blockedHtml = htmlRows.approvalActions({ reqId: 'r1' }, '這是您自己發起的申請<script>');
check('按鈕：未限制時核准鈕可按、無說明文字', /v2-final-approve-btn/.test(okHtml) && !/disabled/.test(okHtml) && !/blocked-note/.test(okHtml));
check('按鈕：被限制時核准鈕 disabled 並顯示原因（已跳脫）、駁回鈕仍在', /v2-final-approve-btn[^>]*disabled/.test(blockedHtml) && /v2-approve-blocked-note/.test(blockedHtml)
    && /&lt;script&gt;/.test(blockedHtml) && !/<script>/.test(blockedHtml) && /v2-reject-btn/.test(blockedHtml));

/* ===================== approveRequest 守門 ===================== */
const asChief = () => roleSvc.setCurrentIdentity({ uid: 'u_chief', email: 'c@x', teacherId: 't_chief', name: '組長', role: 'section_chief' });
const asPlatform = () => roleSvc.setCurrentIdentity({ uid: 'u_pa', email: 'pa@x', teacherId: 'u_pa', name: '平台管理員', role: 'director', isPlatformAdmin: true });
const putReq = (id, over = {}) => F.docs.set(P(id), {
    type: '代課', requestType: 'substitute', status: 'pending_approval', date: '2026-12-04', weekday: '週五', period: '第三節', className: '801',
    originalTeacher: '王老師', substituteTeacher: '林老師', originalTeacherId: 't_wang', substituteTeacherId: 't_lin',
    initiatedBy: 't_wang', pendingConsentTeacherIds: [], swapConsents: {}, semesterId: '115-1', createdAt: '2026-11-14T00:00:00.000Z', ...over,
});
const wroteRecord = () => F.writes.some(w => w.path.includes('/substituteRecords/'));

reset(); asChief();
putReq('own1', { initiatedBy: 't_chief', originalTeacherId: 't_chief', originalTeacher: '組長' });
let err = null;
try { await req.approveRequest('own1'); } catch (e) { err = e; }
check('approveRequest：組長核准自己發起的申請 → APPROVE_OWN_REQUEST，沒有成立紀錄、申請仍待核准', err?.code === 'APPROVE_OWN_REQUEST' && !wroteRecord() && F.docs.get(P('own1')).status === 'pending_approval', String(err));

reset(); asPlatform();
putReq('own2', { initiatedBy: 'u_pa', originalTeacherId: 'u_pa' });
err = null;
try { await req.approveRequest('own2'); } catch (e) { err = e; }
check('approveRequest：platformAdmin 核准自己（uid）發起的申請 → 同樣被擋（職務分離適用）', err?.code === 'APPROVE_OWN_REQUEST' && !wroteRecord(), String(err));

reset(); asChief();
putReq('other1');
let saved = null; err = null;
try { saved = await req.approveRequest('other1'); } catch (e) { err = e; }
check('approveRequest：組長核准教師發起的申請 → 成立紀錄', !err && saved?.status === 'approved' && saved.approvedBy === 't_chief' && wroteRecord(), String(err));

reset(); asChief();
putReq('proxy1', { initiatedBy: 't_wang', initiatedByName: '王老師', initiatedByRole: 'admin' });
err = null;
try { saved = await req.approveRequest('proxy1'); } catch (e) { err = e; }
check('approveRequest：組長代教師發起（initiatedBy 是被代發的教師）後由組長核准 → 可成立', !err && saved?.approvedBy === 't_chief', String(err));

reset(); asChief();
putReq('self1', { type: '調課', requestType: 'swap', ...selfSwap('t_chief'), originalTeacher: '組長', swapTeacher: '組長', substituteTeacher: '組長', swapDate: '2026-12-11', swapWeekday: '週五', swapPeriod: '第二節' });
err = null;
try { saved = await req.approveRequest('self1'); } catch (e) { err = e; }
check('approveRequest：自我調課且無他人牽涉，組長可核准自己的（例外）', !err && saved?.approvedBy === 't_chief', String(err));

reset(); asPlatform();
putReq('pa_other');
err = null;
try { saved = await req.approveRequest('pa_other'); } catch (e) { err = e; }
check('approveRequest：platformAdmin（teacherId＝uid）核准他人申請 → approvedBy 為 uid', !err && saved?.approvedBy === 'u_pa', String(err));

/* ===================== authGuardV2：白名單旗標 ===================== */
const SID = 's9';
const userDir = (uid) => F.docs.set(SCHEMA_PATHS.userDirectoryDoc(uid), { schoolId: SID, createdAt: '2026-01-01T00:00:00.000Z' });
const cfgPath = () => `schools/${SID}/config/main`;
const putCfg = (over = {}) => F.docs.set(cfgPath(), { schoolName: 'S', currentSemester: '115-1', initialAdminEmails: ['boss@x.test'], ...over });
const putTeacher = (id, email, role) => {
    F.docs.set(`schools/${SID}/teachers/${id}`, { name: id, email, role, domains: [], homeroomClass: '' });
    F.docs.set(`schools/${SID}/emailIndex/${email}`, { teacherId: id });
};
const gUser = (uid, email) => ({ uid, email, displayName: email.split('@')[0], photoURL: null, providerId: null });
const flagOf = () => F.docs.get(cfgPath())?.directorEstablished;
const teacherWrites = () => F.writes.filter(w => w.path.includes(`/${SID}/teachers/`));
const resolve = (uid, email) => authGuard.resolveIdentity(gUser(uid, email));

// (a) 旗標未設、白名單新使用者：bootstrap 成為主任，並補設旗標
reset(); putCfg(); userDir('u_boss');
let id = await resolve('u_boss', 'boss@x.test');
check('authGuard：旗標未設，白名單使用者 bootstrap 成為主任（既有行為不變）', id?.role === 'director' && teacherWrites().some(w => w.op === 'batch.set'));
check('authGuard：bootstrap 完成後補設 directorEstablished=true', flagOf() === true);
check('authGuard：bootstrap 後建立了 mapping', F.docs.has(`schools/${SID}/userMappings/u_boss`));

// (b) 旗標已設、白名單新使用者（尚無教師檔）：白名單失效，不建主任教師檔
reset(); putCfg({ directorEstablished: true }); userDir('u_boss');
id = await resolve('u_boss', 'boss@x.test');
check('authGuard：旗標為 true，白名單使用者不再 bootstrap（回傳 null、不建教師檔、不寫 mapping）', id === null && teacherWrites().length === 0 && !F.docs.has(`schools/${SID}/userMappings/u_boss`));

// (c) 旗標已設、白名單內但教師檔是一般教師：不再升級為主任
reset(); putCfg({ directorEstablished: true }); userDir('u_boss'); putTeacher('t_boss', 'boss@x.test', 'teacher');
id = await resolve('u_boss', 'boss@x.test');
check('authGuard：旗標為 true，白名單內的一般教師維持 teacher（不補登 role）', id?.role === 'teacher' && F.docs.get(`schools/${SID}/teachers/t_boss`).role === 'teacher');

// (d) 旗標未設、白名單內的一般教師檔：舊行為升級為主任並補旗標
reset(); putCfg(); userDir('u_boss'); putTeacher('t_boss', 'boss@x.test', 'teacher');
id = await resolve('u_boss', 'boss@x.test');
check('authGuard：旗標未設，白名單內一般教師升級為主任（舊行為）並補設旗標', id?.role === 'director' && flagOf() === true);

// (e) 既有正式庫：正式主任（教師檔 director、非白名單）登入，自癒補旗標
reset(); putCfg({ initialAdminEmails: ['someone-else@x.test'] }); userDir('u_dir'); putTeacher('t_dir', 'dir@x.test', 'director');
id = await resolve('u_dir', 'dir@x.test');
check('authGuard：既有學校正式主任登入時補設旗標（部署後自癒）', id?.role === 'director' && flagOf() === true);

reset(); putCfg({ initialAdminEmails: ['someone-else@x.test'] }); userDir('u_old'); putTeacher('t_old', 'old@x.test', 'admin');
id = await resolve('u_old', 'old@x.test');
check('authGuard：舊 role=admin 視同正式主任，同樣補旗標', id?.role === 'director' && flagOf() === true);

// (f) 一般教師、組長登入不補旗標
reset(); putCfg(); userDir('u_t'); putTeacher('t_t', 't@x.test', 'teacher');
id = await resolve('u_t', 't@x.test');
check('authGuard：一般教師登入不補旗標', id?.role === 'teacher' && flagOf() === undefined);
reset(); putCfg(); userDir('u_c'); putTeacher('t_c', 'c@x.test', 'section_chief');
id = await resolve('u_c', 'c@x.test');
check('authGuard：組長登入不補旗標', id?.role === 'section_chief' && flagOf() === undefined);

// (g) 旗標已確立時不重複寫入
reset(); putCfg({ directorEstablished: true, initialAdminEmails: [] }); userDir('u_dir'); putTeacher('t_dir', 'dir@x.test', 'director');
id = await resolve('u_dir', 'dir@x.test');
check('authGuard：旗標已是 true 時正式主任登入不再寫 config', id?.role === 'director' && !F.writes.some(w => w.path === cfgPath()));

/* ===================== platformAdmin 進入學校 ===================== */
reset(); putCfg({ schoolName: '平台測試校', directorEstablished: true });
id = await authGuard.resolvePlatformAdminIdentity({ uid: 'u_pa', email: 'PA@x.test', providerId: 'google.com' }, SID);
check('platformAdmin：進入學校後身分為主任（role=director）、isPlatformAdmin、teacherId＝uid、名稱為「平台管理員」', id.role === 'director' && id.isPlatformAdmin === true && id.teacherId === 'u_pa' && id.name === '平台管理員' && id.email === 'pa@x.test');
check('platformAdmin：作用中學校切換到所選學校；roleService 以主任判定（isDirector／isApprover／canManageRoster／isPlatformAdmin）',
    getActiveSchoolId() === SID && roleSvc.isDirector() && roleSvc.isApprover() && roleSvc.canManageRoster() && roleSvc.isPlatformAdmin());
check('platformAdmin：不寫 userMappings／userDirectory（不是成員、不改變自己平常的歸屬）', !F.writes.some(w => /userMappings|userDirectory/.test(w.path)));
check('roleService：一般主任 isPlatformAdmin 為 false', (() => { roleSvc.setCurrentIdentity({ uid: 'u', teacherId: 't', name: 'x', role: 'director' }); return roleSvc.isPlatformAdmin() === false; })());

reset();
let thrown = null;
try { await authGuard.resolvePlatformAdminIdentity({ uid: 'u_pa', email: 'pa@x.test' }, 'no-such-school'); } catch (e) { thrown = e; }
check('platformAdmin：學校不存在 → 丟錯、沒有設定身分、作用中學校還原', !!thrown && /找不到學校/.test(thrown.message) && roleSvc.getCurrentIdentity() === null && getActiveSchoolId() === 'inhu', String(thrown));
thrown = null;
try { await authGuard.resolvePlatformAdminIdentity({ uid: 'u_pa', email: 'pa@x.test' }, '../evil'); } catch (e) { thrown = e; }
check('platformAdmin：學校代碼格式不合法 → 丟錯', !!thrown && /格式/.test(thrown.message));

/* ===================== 核准開通新學校：不得覆寫既有學校（platformAdmin 視同每校主任後，rules 不再擋，改由前端檢查） ===================== */
const appSvc = await import('../src/js/modules/v2/schoolApplicationService.js');
const application = { uid: 'u_app', applicantEmail: 'app@x.test', schoolName: '新申請校', desiredSchoolId: 'new-school' };

reset();
F.docs.set('schools/inhu/config/main', { schoolName: '既有學校', currentSemester: '115-1', initialAdminEmails: ['d@x.test'], directorEstablished: true });
thrown = null;
try { await appSvc.approveApplication({ ...application, desiredSchoolId: 'inhu' }, { reviewer: { uid: 'u_pa' } }); } catch (e) { thrown = e; }
check('approveApplication：學校代碼已有 config/main（既有學校，如 inhu，不在 schoolDirectory）→ 中止，沒有任何寫入、既有 config 原封不動',
    !!thrown && thrown.code === 'SCHOOL_CONFIG_EXISTS' && /已有學校設定/.test(thrown.message) && F.writes.length === 0 && F.docs.get('schools/inhu/config/main').schoolName === '既有學校', String(thrown));

reset();
let out = null; thrown = null;
try { out = await appSvc.approveApplication(application, { reviewer: { uid: 'u_pa' } }); } catch (e) { thrown = e; }
check('approveApplication：全新學校代碼 → 建立 config/main（白名單＝申請人）與 schoolDirectory，並綁定申請人', !thrown && out?.schoolId === 'new-school'
    && F.docs.get('schools/new-school/config/main')?.initialAdminEmails?.[0] === 'app@x.test'
    && F.docs.get('schools/new-school/config/main')?.directorEstablished === undefined
    && F.docs.has('schoolDirectory/new-school') && F.docs.get('userDirectory/u_app')?.schoolId === 'new-school', String(thrown));

check('approveApplication：建校的 config／schoolDirectory 在同一個 transaction 內寫入（預讀與寫入原子化，不是 batch）',
    F.writes.filter(w => w.path === 'schools/new-school/config/main' || w.path === 'schoolDirectory/new-school').every(w => w.op === 'tx.set')
    && F.writes.filter(w => w.op === 'tx.set').length === 2);

console.log = realLog; console.warn = realWarn; console.error = realErr;
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
