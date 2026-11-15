/**
 * 班級時段佔用與「當日有效課表」（純函式，node 可測；不碰 Firebase、不碰 DOM）
 *
 * 背景（P6，審計 L1／L3）：調課紀錄 R 同時動到兩個「班級時段」：
 *   - 時段 A（date／period／className）：原任課教師 originalTeacher 離開，由 swapTeacher 上課
 *   - 時段 B（swapDate／swapPeriod／className）：swapTeacher 離開，由 originalTeacher 上課
 * 舊流程只用 date 索引、只比對時段 A，於是時段 B 沒被當成已被處理：
 *   - 同一班同一節可以先調課、再被原任課教師請假代課，兩人同時排進同一節，代課費照發；
 *   - 調課移進來的節次，原任課教師請假時課表仍顯示舊的任課者，看不到那一節。
 *
 * 本檔提供：
 *   1. matchesRecordSlot：送出前「同課堂已有紀錄」比對（時段 A 原本就比；補上時段 B）
 *   2. findClassSlotConflict：核准／送出重驗用的「班級時段」衝突（不只教師本人）
 *   3. applySwapsToSchedule：套用已成立的調課，得到某一天的有效課表
 */

const norm = (v) => (v == null ? '' : String(v).trim());
const sameName = (a, b) => { const x = norm(a); return x !== '' && x === norm(b); };

/** 已成立的紀錄（V1 無 status 視為成立；在途申請轉成的佔用紀錄不算）。 */
export function isEstablishedRecord(r) {
    return !!r && !r.__pending && (!r.status || r.status === 'approved');
}

/** 兩筆紀錄／申請是否屬於同一批（batchId 相同且發起者相同）。批次內連調會重複使用同一個班級時段。 */
export function isSameBatch(a, b) {
    if (!a || !b || !a.batchId || a.batchId !== b.batchId) return false;
    const ka = a.adminOperatorId || a.initiatedBy || '';
    const kb = b.adminOperatorId || b.initiatedBy || '';
    return ka === kb;
}

/**
 * 送出前「同課堂已有紀錄」比對（取代 date/period/className/originalTeacher 四欄全等的舊比對）。
 *   - 時段 A：date／period／className 相同，且 originalTeacher 相同（舊行為）
 *   - 時段 B：type 為調課，swapDate／swapPeriod／className 相同，且 swapTeacher 就是要請假的教師
 *     （該教師的這一節已被調課換走，不能再為它申請代課或調課）
 * @returns {'A'|'B'|null}
 */
export function matchesRecordSlot(item, date, period, className, originalTeacher) {
    if (!item) return null;
    if (item.date === date && item.period === period && item.className === className
        && item.originalTeacher === originalTeacher) return 'A';
    // 自我調課：同一位教師把自己的課換到時段 B，B 現在是他的課，不算「已被調走」，仍可為它請假或再調課
    const isSelf = item.isSelfSwap === true || sameName(item.originalTeacher, item.swapTeacher);
    if (!isSelf && item.type === '調課' && item.swapDate === date && item.swapPeriod === period
        && item.className === className && item.swapTeacher === originalTeacher) return 'B';
    return null;
}

/**
 * 送出前「此課堂已有紀錄」警告的文字內容。顯示實際衝突的那一節（命中時段 B 時是 swapDate／swapPeriod，
 * 不是紀錄的時段 A），並依紀錄性質給不同說明：在途申請提示等待審核，已成立紀錄才提示去刪除。
 * @returns {{when:string, what:string, who:string, advice:string, pending:boolean}}
 */
export function describeExistingRecord(rec, date, period, className, teacher) {
    const slot = matchesRecordSlot(rec, date, period, className, teacher);
    const atB = slot === 'B';
    const d = atB ? rec.swapDate : rec.date;
    const wd = atB ? rec.swapWeekday : rec.weekday;
    const pd = atB ? rec.swapPeriod : rec.period;
    const type = rec.type || '代課';
    const counterpart = atB ? rec.originalTeacher : (rec.swapTeacher || rec.substituteTeacher);
    const who = type === '調課'
        ? (rec.isSelfSwap ? '教師自行調課' : `調課教師：${counterpart || ''}`)
        : `代課教師：${rec.substituteTeacher || ''}`;
    const pending = !!rec.__pending;
    const advice = pending
        ? `已有待審的申請${rec.__pendingLabel ? `（${rec.__pendingLabel}）` : ''}，請等候審核，或請申請人先撤回該申請`
        : '如需重新安排，請先至「調代課紀錄」刪除該筆紀錄';
    return {
        when: [d, wd, pd].filter(Boolean).join(' '),
        what: `${rec.className || className || ''} ${rec.subject || ''}（${type}）`.replace(/\s+（/, '（'),
        who, advice, pending,
    };
}

/**
 * 班級時段衝突：同一班同一日同一節，已有其他紀錄改變了「這一節的任課者」。
 *
 * 要處理的時段 (date, period, className)，申請方認定該節目前的任課者是 teacher：
 *   - 既有代課：同一班級時段已有同一位原任課教師的代課 → 衝突（重複請假，一節課只能有一位代課者）
 *   - 既有調課，本節是它的時段 A：調課後任課者是 swapTeacher；teacher 不等於它 → 衝突
 *   - 既有調課，本節是它的時段 B：調課後任課者是 originalTeacher；teacher 不等於它 → 衝突
 *     （原任課教師被調進來的那一節，申請方若以「調進來的人」為任課者則放行，這是 L3 的正常情境）
 *   - 自我調課：同一人搬動自己的課，teacher 與其相同即衝突
 * 同批（isSameBatch）的紀錄不算：批次內連調本來就會重複使用同一個班級時段，由批次自己的檢查負責。
 *
 * @param {Object} p
 * @param {string} p.className
 * @param {string} p.date
 * @param {string} p.period
 * @param {string} p.teacher - 申請方認定的該節任課者
 * @param {Array} p.records - 已成立紀錄（可含在途佔用紀錄，帶 __pendingLabel 者訊息會標示）
 * @param {string} [p.excludeRecordId]
 * @param {Object} [p.anchor] - 申請本身（用來排除同批紀錄）
 * @param {Array} [p.scheduleData] - 週課表；提供時，協同教學（同班同節兩位以上教師）的其他教師不受單一教師的異動影響
 * @returns {{kind:'classSlot', teacher:string, date:string, period:string, role:string, detail:Object, slot:'A'|'B'}|null}
 */
export function findClassSlotConflict({ className, date, period, teacher, records = [], excludeRecordId = null, anchor = null, scheduleData = null }) {
    if (!className || !date || !period) return null;
    for (const r of records || []) {
        if (!r || r.className !== className) continue;
        const rid = r.id ?? r.recordId;
        if (excludeRecordId && (rid === excludeRecordId || r.recordId === excludeRecordId)) continue;
        if (anchor && isSameBatch(anchor, r)) continue;
        // needsSchedule：teacher 既不是該紀錄換走的人，也不是換進來的人；可能是協同教學的另一位教師
        const make = (role, slot, needsSchedule = false) => ({ kind: 'classSlot', teacher: norm(teacher), date, period, role, detail: r, slot, needsSchedule });
        // 協同教學：同班同節在週課表有兩位以上教師，且申請方是其中之一，這筆異動與他無關
        const coTeacherSkip = () => isCoTeacher(scheduleData, date, period, className, teacher);

        if (r.type === '調課') {
            const isSelf = r.isSelfSwap === true || sameName(r.originalTeacher, r.swapTeacher);
            if (r.date === date && r.period === period) {
                if (isSelf) {
                    // 自我調課的時段 A：這位教師的課已被搬走
                    if (sameName(teacher, r.originalTeacher)) return make('調課', 'A');
                } else if (!sameName(teacher, r.swapTeacher)) {
                    const third = !sameName(teacher, r.originalTeacher);
                    if (!(third && coTeacherSkip())) return make('調課', 'A', third);
                }
            }
            if (r.swapDate === date && r.swapPeriod === period) {
                // 自我調課的時段 B：這節現在是該教師的課，只有他本人（或協同教師）可以再處理
                if (!sameName(teacher, r.originalTeacher)) {
                    const third = isSelf || !sameName(teacher, r.swapTeacher);
                    if (!(third && coTeacherSkip())) return make('調課', 'B', third);
                }
                // teacher 就是換進來的原任課教師（或自我調課的本人）：放行（L3 正常情境）
            }
        } else if (r.date === date && r.period === period && (r.type === '代課' || r.substituteTeacher)
            && sameName(r.originalTeacher, teacher)) {
            return make('代課', 'A');
        }
    }
    return null;
}

/**
 * 週課表中，指定日期（以星期判斷）同班同節是否有兩位以上教師，且 teacher 是其中之一（協同教學、隔週雙列）。
 * 沒有課表資料時回傳 false（保守：維持純班級時段判斷）。
 */
export function isCoTeacher(scheduleData, date, period, className, teacher) {
    if (!Array.isArray(scheduleData) || scheduleData.length === 0 || !norm(teacher)) return false;
    const wd = weekdayOfDate(date);
    const names = new Set();
    for (const c of scheduleData) {
        if (c && c.weekday === wd && c.period === period && c.className === className && norm(c.teacher)) names.add(norm(c.teacher));
    }
    return names.size >= 2 && names.has(norm(teacher));
}

const WEEKDAY_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
function weekdayOfDate(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    if (!m) return '';
    return WEEKDAY_NAMES[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}

/** 班級時段衝突的一句話描述（不含前綴）。 */
export function describeClassSlotConflict(hit) {
    const d = hit.detail || {};
    const tag = d.__pendingLabel ? `（${d.__pendingLabel}）` : '';
    if (hit.role === '代課') {
        return `${d.className || ''} ${hit.date} ${hit.period}已有代課紀錄${tag}，這一節已安排代課教師；若要更換代課教師，請先到調代課紀錄刪除原紀錄再重新送出`;
    }
    return `${d.className || ''} ${hit.date} ${hit.period}已有${hit.role}紀錄${tag}，這一節的任課者已經異動`;
}

/**
 * 套用已成立的調課，回傳「指定日期」的有效課表（不改動傳入的陣列與物件）。
 *   - 時段 A 在該日：該班該節的任課者改為 swapTeacher（科目 swapSubject）
 *   - 時段 B 在該日：該班該節的任課者改為 originalTeacher（科目 subject）
 * 依 createdAt（再依 id）排序套用，連調時以最後一筆為準。自我調課不改變任課者，略過。
 * 代課不改變「誰的課」（原任課教師仍是課的主人，只是當天有人代），所以不套用。
 * 被改動的格子帶 __swapped: true，供畫面標示。
 *
 * @param {Array} scheduleData - 週課表
 * @param {Array} records - 紀錄（只採用已成立者）
 * @param {string} date - YYYY-MM-DD
 * @returns {Array}
 */
export function applySwapsToSchedule(scheduleData, records, date) {
    const base = (scheduleData || []).map(c => ({ ...c }));
    if (!date) return base;
    const swaps = (records || [])
        .filter(r => isEstablishedRecord(r) && r.type === '調課' && !r.isSelfSwap
            && norm(r.originalTeacher) && norm(r.swapTeacher) && !sameName(r.originalTeacher, r.swapTeacher)
            && (r.date === date || r.swapDate === date))
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
            || String(a.id ?? a.recordId ?? '').localeCompare(String(b.id ?? b.recordId ?? '')));

    // leaving：離開這一格的教師。同班同節有多位教師（協同教學、隔週雙列）時只改 leaving 那一格；
    // 找不到 leaving 時，僅在「同班同節只有一格」才沿用純班級時段判斷（課表姓名與紀錄不一致時的舊行為）。
    const place = (weekday, period, className, leaving, teacher, subject, domain) => {
        if (!weekday || !period || !className) return;
        const slotRows = base.filter(c => c.weekday === weekday && c.period === period && c.className === className);
        const hit = slotRows.find(c => sameName(c.teacher, leaving)) || (slotRows.length === 1 ? slotRows[0] : null);
        if (hit) {
            hit.teacher = teacher;
            if (subject) { hit.subject = subject; hit.rawSubject = subject; hit.courseName = subject; }
            if (domain) hit.domain = domain;
            hit.__swapped = true;
        } else {
            base.push({ weekday, period, className, teacher, subject: subject || '', rawSubject: subject || '',
                courseName: subject || '', domain: domain || '', category: '領域學習', __swapped: true });
        }
    };
    for (const r of swaps) {
        if (r.date === date) place(r.weekday, r.period, r.className, r.originalTeacher, norm(r.swapTeacher), r.swapSubject, r.swapDomain);
        if (r.swapDate === date) place(r.swapWeekday, r.swapPeriod, r.className, r.swapTeacher, norm(r.originalTeacher), r.subject, r.domain);
    }
    return base;
}

/** 有效課表中某教師的課（單日檢視用）。 */
export function teacherCoursesOnDate(effectiveSchedule, teacherName, weekday) {
    return (effectiveSchedule || []).filter(c => sameName(c.teacher, teacherName) && c.weekday === weekday);
}
