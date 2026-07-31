/**
 * V2 登入綁定閘
 *
 * 於 Google OAuth 登入完成後呼叫 resolveIdentity(user)：
 *   1. 讀 schools/{id}/emailIndex/{我的email} 拿 teacherId（Stage 0 §3.4a）。
 *   2. 若 email 在 config.initialAdminEmails 清單中（白名單，主任初始名單）
 *      → 找到 teacherId 則升級該教師檔為 director；
 *        找不到則建立一筆「教務主任」教師紀錄並綁定為 director（全新學校 bootstrap）。
 *   3. 若 email 對到 emailIndex 中的 teacherId（一般教師）
 *      → 設為該教師（role 依 teachers 紀錄；舊 'admin' 由 normalizeRole 轉為 'director'）。
 *   4. 否則
 *      → 寫 joinAttempt 紀錄，拒絕登入（回傳 null，呼叫端自行 signOut）。
 *
 * 成功綁定時會將身份寫入 roleService（setCurrentIdentity，內部自動 normalizeRole）。
 *
 * Stage 0（2026-07-31，見 docs/RESEARCH-multitenancy-semester.md §3.3/§3.4）：
 * firestore.rules 的 teachers 讀取從「任何登入者」收緊為「isMember(schoolId)」（成員限定），
 * 首登（尚無 userMappings）因此讀不到 teachers 集合，原本「讀 teachers 集合以 email 配對」
 * 的流程必須改走 emailIndex（規則只開放 get 自己那一份，不需成員資格）。
 *
 * ⚠ 寫入順序不可顛倒：mapping 尚未建立時 isMember(schoolId) 恆為 false，此刻直接
 * getDoc(teachers/{id}) 一樣會被拒——必須「先用 emailIndex 查到的 teacherId 建立
 * userMappings（其 create 規則靠內部 get() 驗證 email 相符，不受 teachers 的 read
 * 規則限制），mapping 建立後才讀教師檔本體」。config 讀取同理收緊為
 * isMemberOrBootstrapDirector，見 getInitialDirectorEmails() 的容錯處理。
 *
 * 驗收修復（2026-07-31）：
 *   - S5：getEmailIndexEntry() 查詢包 try/catch，失敗一律視同查無配對，走正常拒絕
 *     流程，不讓例外變成未捕捉的系統錯誤。
 *   - S6：emailIndex 查無條目時，後備讀自己的 userMappings/{uid}（自己讀自己不需要
 *     成員資格），取既有 linkedTeacherId 接著跑完整流程——索引缺條目不會把「本來就是
 *     成員」的既有教師擋在登入門外。
 *   - S6-R：上述後備路徑取到 teacherId 時代表 mapping 已經存在（isMember 已成立），
 *     跳過 upsertUserMapping 直接讀教師檔——不重複寫入，代價是這次登入不刷新
 *     lastLoginAt 等欄位，見 resolveIdentity() 內 `mappingAlreadyExists` 分支的說明。
 *
 * v2.0.0 升級：白名單建立角色從 ADMIN 改為 DIRECTOR；舊資料 role='admin' 視同 director。
 * Firestore config.initialAdminEmails 欄位名稱維持（避免破壞既有 schools/default config 文件）。
 *
 * Stage 3（2026-07-31，RESEARCH-multitenancy-semester.md §8 Stage 3／§4 集合設計預告）：
 * SCHOOL_ID 動態化。以下所有 dataSvc 呼叫（getConfig/getEmailIndexEntry/getTeacher/...）
 * 內部都透過 SCHEMA_PATHS 依賴 schemaConstants.getActiveSchoolId()，因此本函式必須在
 * 呼叫任何一個 dataSvc 函式「之前」，先解析出這位使用者所屬的學校並呼叫
 * schemaConstants.setActiveSchoolId()——順序寫在 resolveIdentity() 最開頭，
 * 見 resolveSchoolIdForUid() 的完整說明（含目前唯一支援的 fallback 策略）。
 */

import * as dataSvc from './schoolDataService.js';
import * as logger  from './operationLogger.js';
import * as roleSvc from './roleService.js';
import { ROLES, normalizeRole, DEFAULT_SCHOOL_ID, getActiveSchoolId, setActiveSchoolId, resetActiveSchoolId } from './schemaConstants.js';

/**
 * 解析這個 uid 屬於哪所學校，供 resolveIdentity() 在任何 dataSvc 呼叫之前先設定
 * getActiveSchoolId()。
 *
 * 解析順序：
 *   1. 讀頂層 userDirectory/{uid}（不需要知道 schoolId，見 SCHEMA_PATHS.userDirectoryDoc
 *      定義處的說明）。找到就直接回傳裡面記的 schoolId。
 *   2. 找不到（回填腳本尚未執行、或這是一個從未被任何 userDirectory 記錄過的使用者，
 *      Firestore 對這種情況的回應是 `snap.exists()===false`，不是拋錯）：
 *      相容期 fallback 到 DEFAULT_SCHOOL_ID（目前恆為 'inhu'，唯一正式服務的學校）——
 *      這保證現有 inhu 使用者在回填腳本尚未執行的過渡期內，登入行為與 Stage 3 之前
 *      完全一致，不會因為查不到 userDirectory 就被拒於門外。
 *
 * ⚠ Stage 3 opus 驗收 中2：「查無條目」與「讀取本身失敗」語意不同，回傳值用 readFailed
 * 旗標區分（呼叫端見 resolveIdentity()），不能都 fallback 到 DEFAULT_SCHOOL_ID 混為一談——
 * 「查無條目」是 Firestore 明確告訴我們「這份文件不存在」，fallback 有依據；「讀取失敗」是
 * 我們根本不知道答案。在 Stage 3 現況（只有一所學校）兩者 fallback 後看起來沒有差異，但
 * Stage 4 開放多校後，一個屬於其他學校的使用者若剛好遇到暫時性讀取失敗，會被錯誤地當成
 * inhu 的人登入——這是需要提前擋下的錯置風險。
 *
 * 但這裡進一步把 `permission-denied` 從「讀取失敗」中排除、仍視同「查無條目」處理，理由是
 * 部署過渡期的已知情境（見 docs/STAGE0-DEPLOY.md「附註：Stage 3」組合②：新 client × 舊
 * rules，`userDirectory` 尚未加入 match 區塊，Firestore 對未匹配路徑一律 DENY）——在**新**
 * 規則下，讀自己 uid 的 userDirectory 恆放行（`request.auth.uid == uid` 必成立），這個錯誤
 * 碼理論上不會再出現於穩定態，可以安全地當作「這個功能還沒佈署好」而非「我們不知道答案」。
 * 其餘任何錯誤碼（網路逾時、服務不可用等）才真正代表「不知道」，readFailed=true。
 *
 * TODO（Stage 4，§8 路線圖「多租戶開通」）：開放註冊上線後，「查無條目」這條路徑不該再無
 * 條件 fallback 到 DEFAULT_SCHOOL_ID——那等於把所有查無 userDirectory 的人都靜默當成 inhu
 * 的人，一旦出現第二所學校，這個假設就不成立了。屆時應改為回傳 null，讓呼叫端把使用者導向
 * 「申請加入 / 建立新學校」的流程，而不是在這裡替使用者決定學校。
 */
async function resolveSchoolIdForUid(uid) {
    let entry = null;
    let readFailed = false;
    try {
        entry = await dataSvc.getUserDirectoryEntry(uid);
    } catch (e) {
        if (e?.code === 'permission-denied') {
            console.warn('[v2] 讀取 userDirectory 遭拒（部署過渡期已知情境，見函式註解），改用預設學校 fallback：', e?.message || e);
        } else {
            readFailed = true;
            console.error('[v2] 讀取 userDirectory 失敗（非查無條目，是讀取本身出錯）：', e?.message || e);
        }
    }
    return { schoolId: entry?.schoolId || DEFAULT_SCHOOL_ID, existed: !!entry?.schoolId, readFailed };
}

async function getInitialDirectorEmails() {
    let cfg;
    try {
        cfg = await dataSvc.getConfig();
    } catch (e) {
        // Stage 0 R2 收緊後（isMemberOrBootstrapDirector），尚非成員且不在白名單的
        // 使用者讀不到 config——這正好等同「不是白名單主任」（若在白名單，isInitialDirector
        // 內部 get() 就會讓這次 read 通過），直接視為空清單即可，不阻斷後續 emailIndex 配對。
        cfg = null;
    }
    // 欄位名稱維持 initialAdminEmails 以兼容既有 Firestore config 文件
    const raw = cfg?.initialAdminEmails || cfg?.initialDirectorEmails || [];
    return raw.map(e => (e || '').toLowerCase().trim()).filter(Boolean);
}

function buildMappingPatch(email, googleUser, providerId) {
    return {
        email,
        googleName: googleUser.displayName || null,
        googlePhotoUrl: googleUser.photoURL || null,
        lastProviderId: providerId,
    };
}

/**
 * 給定「呼叫前 getActiveSchoolId() 已指向的學校」，依 email 走完整配對流程並回傳教師檔
 * （查無配對回傳 null）。
 *
 * 抽成獨立函式的理由（Stage 3 opus 驗收 中3）：下方 resolveIdentity() 的自救機制需要對
 * 兩個不同的 schoolId（userDirectory 記錄的值、以及自救時嘗試的 DEFAULT_SCHOOL_ID）各跑
 * 一次同一套邏輯，不重複貼兩份幾乎一樣的程式碼。呼叫前呼叫端必須已經呼叫過
 * setActiveSchoolId()，本函式內部所有 dataSvc 呼叫都依賴這個值。
 */
async function attemptResolveTeacherForActiveSchool(email, googleUser, mappingPatch) {
    const initialDirectors  = await getInitialDirectorEmails();
    const isInitialDirector = initialDirectors.includes(email);

    // Stage 0：先查 emailIndex（get 自己那一份，不需成員資格），拿到既有 teacherId 才知道
    // 「已有教師檔、只是還沒 mapping」與「全新教師/全新學校」的區別。
    // 驗收修復 S5：查詢失敗（規則拒絕、暫時性網路錯誤等）一律視同查無配對，讓流程繼續走
    // 下面既有成員的後備路徑或正常的拒絕流程，不讓例外把登入炸成未捕捉的系統錯誤。
    let indexEntry = null;
    try {
        indexEntry = await dataSvc.getEmailIndexEntry(email);
    } catch (e) {
        console.warn('[v2] 讀取 emailIndex 失敗，視同查無配對：', e?.message || e);
    }
    let teacherId = indexEntry?.teacherId || null;

    // 驗收修復 S6：索引查無條目時的後備——若使用者其實已經是成員（userMappings 已存在，
    // 例如 Stage 0 上線前就登入過、或回填腳本漏掉的舊資料），直接用既有 mapping 的
    // linkedTeacherId，不因索引缺漏把既有成員擋在登入門外。自己讀自己的 userMappings
    // 不需要成員資格（rules 的 userMappings read 對本人一律開放，見 firestore.rules）。
    // 驗收修復 S6-R：這條後備路徑取到 teacherId 時，userMappings 文件本身「已經存在」
    // （不然 getUserMapping 不會回傳非 null 的 linkedTeacherId），isMember(schoolId) 此刻
    // 已成立——不需要、也不應該再呼叫一次 upsertUserMapping 才能讀教師檔，用
    // `mappingAlreadyExists` 記住這個狀態，下面直接跳過 upsert、只讀教師檔本體。
    let mappingAlreadyExists = false;
    if (!teacherId) {
        try {
            const existingMapping = await dataSvc.getUserMapping(googleUser.uid);
            if (existingMapping?.linkedTeacherId) {
                teacherId = existingMapping.linkedTeacherId;
                mappingAlreadyExists = true;
            }
        } catch (e) {
            console.warn('[v2] 讀取既有 userMapping 後備失敗：', e?.message || e);
        }
    }

    let teacher = null;

    if (teacherId) {
        try {
            if (mappingAlreadyExists) {
                // S6-R：mapping 已存在、isMember 已成立，直接讀教師檔即可。代價是這次
                // 登入不會刷新 mapping 上的 lastLoginAt/googleName/googlePhotoUrl/
                // lastProviderId——這條路徑只在 emailIndex 缺條目時觸發（正常穩定態下
                // 不會發生，因為 createTeacher/updateTeacher 已同步維護 emailIndex），
                // 若要修回「每次登入都更新」，重新跑一次回填腳本補上索引即可，之後
                // 該教師的登入會改走上面的 emailIndex 正常路徑。
                teacher = await dataSvc.getTeacher(teacherId);
            } else {
                // 先建立/更新 mapping：規則內部 get() 驗證 email 相符，不受 teachers 的 read
                // 規則限制。mapping 寫入成功後 isMember(schoolId) 才成立，才能真正讀到教師檔。
                await dataSvc.upsertUserMapping(googleUser.uid, { ...mappingPatch, linkedTeacherId: teacherId });
                teacher = await dataSvc.getTeacher(teacherId);
            }
        } catch (e) {
            // emailIndex 條目與 teachers 集合不同步（理論上不會發生，防禦式處理）：
            // mapping 規則的 exists(teachers/{id}) 驗證會直接擋下寫入，視同找不到教師。
            console.warn('[v2] emailIndex 指向的教師檔不存在或 mapping 建立失敗：', e?.message || e);
            teacher = null;
        }
        if (teacher && isInitialDirector && normalizeRole(teacher.role) !== ROLES.DIRECTOR) {
            teacher = await dataSvc.updateTeacher(teacherId, { role: ROLES.DIRECTOR });
        }
    } else if (isInitialDirector) {
        // 全新學校、白名單主任第一次登入：尚無教師檔也尚無 emailIndex 條目，自建 director
        // 教師檔（createTeacher 內部會同步寫入 emailIndex，見 schoolDataService.js）。
        // isDirector(schoolId) 在此靠 isInitialDirector 白名單分支成立，不需要先有 mapping。
        teacher = await dataSvc.createTeacher({
            name:  googleUser.displayName || email.split('@')[0] || '教務主任',
            email,
            role:  ROLES.DIRECTOR,
        });
        await dataSvc.upsertUserMapping(googleUser.uid, { ...mappingPatch, linkedTeacherId: teacher.teacherId });
    }

    return teacher;
}

/**
 * @returns {Promise<Identity|null>} 綁定成功的身份；null 表示未綁定，呼叫端應登出
 */
export async function resolveIdentity(googleUser) {
    if (!googleUser || !googleUser.email) return null;
    const email = googleUser.email.toLowerCase().trim();
    // Phase 1.6.c：providerId 來自 Firebase user.providerData[0].providerId
    //   'google.com' → Google 登入；'password' → Email/密碼登入
    const providerId = googleUser.providerId || null;
    const mappingPatch = buildMappingPatch(email, googleUser, providerId);

    // Stage 3：必須排在本函式其餘所有 dataSvc 呼叫之前——attemptResolveTeacherForActiveSchool()
    // 以下每一步都透過 SCHEMA_PATHS 依賴 getActiveSchoolId()，這裡先設定好，後面才會
    // 讀到正確學校的 config/emailIndex/teachers。
    let { schoolId, existed: userDirectoryExisted, readFailed } = await resolveSchoolIdForUid(googleUser.uid);
    if (readFailed) {
        // Stage 3 opus 驗收 中2：讓這個錯誤沿用 v2-app.js 既有的「resolveIdentity 本身失敗」
        // 外層 catch（_v2GateError=true + 「請點下方按鈕重試」，不 signOut、保留 Firebase
        // session），比在這裡自行處理更一致——那個 catch 本來就是為「身份解析這一步驟失敗」
        // 設計的唯一負責邊界（見 v2-app.js safeBootstrapStep() 檔頭註解：resolveIdentity 那
        // 一段刻意不套 wrapper，就是要維持「解析失敗就鎖住＋可重試」）。不寫 joinAttempt——
        // 這不是「身份被拒」，是「暫時無法確認」，語意不同，不該污染稽核用的拒絕紀錄。
        // opus 重驗 4：訊息不重複加「請重試/請重新整理」——v2-app.js 的遮罩渲染（renderAuthGate）
        // 已經統一在這段訊息後面接上「，請點下方按鈕重試，或重新整理頁面。」，這裡只需要交代
        // 「發生了什麼事」，避免兩段呼籲重試的文字疊在一起讀起來很怪。
        throw new Error('無法確認使用者所屬學校（讀取 userDirectory 失敗）');
    }
    setActiveSchoolId(schoolId);

    let teacher = await attemptResolveTeacherForActiveSchool(email, googleUser, mappingPatch);

    // Stage 3 opus 驗收 中3：自救——若這個 schoolId 是從既有 userDirectory 條目讀來的
    // （不是 fallback 預設值，即 userDirectoryExisted===true），但在這所學校底下找不到任何
    // 教師配對，且該 schoolId 不是 DEFAULT_SCHOOL_ID，代表 userDirectory 可能記錯了學校
    // （資料損毀／人工誤植／理論上的邊界情況——目前只有一所學校，正常流程不會走到這裡）。
    // 與其讓使用者永久被鎖死在一個查無教師檔的學校，值得再試一次 DEFAULT_SCHOOL_ID（僅
    // 一次、不遞迴，天然防迴圈——下面不論成敗都不會再進入這個分支第二次）。
    // 刻意不在這裡自動改寫 userDirectory 的既有條目：若真正的問題不是「userDirectory 記錯」
    // 而是「該學校的教師檔本身被誤刪」，自動改寫成 DEFAULT 會掩蓋這個資料完整性問題。這裡
    // 只解決「這次登入」，讓使用者能先用得了系統；殘留的 userDirectory 不一致會在每次登入
    // 都重新觸發這個自救分支（console.warn 可見），這是刻意的——比默默改寫更容易被日後排查
    // 發現，需要人工介入才會真正修正 userDirectory/{uid} 那份文件。
    if (!teacher && userDirectoryExisted && schoolId !== DEFAULT_SCHOOL_ID) {
        console.warn(`[v2] schoolId=${schoolId}（來自 userDirectory）查無教師配對，嘗試自救改用 DEFAULT_SCHOOL_ID=${DEFAULT_SCHOOL_ID}（僅一次，若仍失敗則正常走拒絕流程）`);
        setActiveSchoolId(DEFAULT_SCHOOL_ID);
        teacher = await attemptResolveTeacherForActiveSchool(email, googleUser, mappingPatch);
        // 注意：不更新 userDirectoryExisted——維持 true，讓下面「查無既有條目才補寫」的判斷
        // 繼續跳過，避免把這次自救的暫時結果誤寫回一份可能仍不正確的學校歸屬。
    }

    if (!teacher) {
        await logger.logJoinAttempt(googleUser.uid, { email, reason: 'no_teacher_match' });
        return null;
    }

    // Stage 3：登入成功（確定屬於 getActiveSchoolId() 目前指向的學校，可能已經過上面的自救
    // 改成 DEFAULT_SCHOOL_ID）且 userDirectory 尚未有這位使用者的條目時，寫入一筆，讓下次
    // 登入直接命中、不必再靠 resolveSchoolIdForUid() 的 fallback。只在「查無既有條目」時才
    // 寫——已存在的條目（含上面自救情境的舊條目）不重寫，避免每次登入都多一次寫入，也避免
    // 自救情境下覆蓋一份可能仍需要人工檢視的既有資料；失敗不阻擋登入（單純的收斂優化，不是
    // 這次登入成立與否的必要條件）。
    if (!userDirectoryExisted) {
        try {
            await dataSvc.upsertUserDirectoryEntry(googleUser.uid, getActiveSchoolId());
        } catch (e) {
            console.warn('[v2] 寫入 userDirectory 失敗（不阻擋登入）：', e?.message || e);
        }
    }

    // 記錄登入 provider 到 teachers doc（給教師管理 UI 判斷「寄密碼信」按鈕是否顯示）
    if (providerId && teacher.authProvider !== providerId) {
        try {
            teacher = await dataSvc.updateTeacher(teacher.teacherId, { authProvider: providerId });
        } catch (e) {
            console.warn('[v2] 寫入 teachers.authProvider 失敗（不阻擋登入）：', e?.message || e);
        }
    }

    const identity = {
        uid:       googleUser.uid,
        email,
        teacherId: teacher.teacherId,
        name:      teacher.name,
        role:      normalizeRole(teacher.role) || ROLES.TEACHER,
        authProvider: providerId,
    };
    roleSvc.setCurrentIdentity(identity);
    return identity;
}

export function clear() {
    roleSvc.clearCurrentIdentity();
    // Stage 3：登出時一併清空 activeSchoolId，下次登入重新走 resolveSchoolIdForUid()——
    // 不留著上一位使用者所屬學校的殘值（實際的登出路徑目前走 v2-app.js 的
    // onAuthStateChange(user=null) 分支直接呼叫 schemaConstants.resetActiveSchoolId()，
    // 這裡同步補上是為了讓本函式本身維持行為完整、不依賴呼叫端記得多做一步）。
    resetActiveSchoolId();
}
