/**
 * 完整假學校資料集
 *
 * 一份 fixture 涵蓋：學校 config、教師名冊（三層角色 + 未綁定 email + 不任課教師）、
 * 兩個學期的課表、已成立調代課紀錄（八種假別 + 三種調課）、六種狀態的待審請求、
 * 操作日誌。第二所學校（beta）用來驗證跨校隔離。
 *
 * 所有內容由固定 seed 產生，同一份程式每次跑出完全相同的資料——測試失敗時可重現。
 * 日期一律寫死為西元字串，不呼叫 Date.now()，避免測試結果隨執行日期漂移。
 */

import { makeRng, shuffle } from './rng.mjs';
import {
    SUBJECT_PLAN, WEEKDAYS, PERIODS,
    buildBestSchedule, rowsToParsedShape,
} from './schedule-builder.mjs';

/* ===================== 學校設定 ===================== */

export const ALPHA = Object.freeze({
    schoolId: 'demo-alpha',
    schoolName: '示範國民中學',
    currentSemester: '115-1',
    previousSemester: '114-2',
    classes: ['7年1班', '7年2班', '7年3班', '8年1班', '8年2班', '8年3班', '9年1班', '9年2班', '9年3班'],
    emailDomain: 'alpha.demo.test',
    seed: 20260811,
});

export const BETA = Object.freeze({
    schoolId: 'demo-beta',
    schoolName: '示範國民中學（乙校）',
    currentSemester: '115-1',
    previousSemester: '114-2',
    classes: ['7年1班', '7年2班', '8年1班', '8年2班', '9年1班', '9年2班'],
    emailDomain: 'beta.demo.test',
    seed: 77771234,
});

/* ===================== 教師名冊 ===================== */

/**
 * 20 位任課教師，人數與順序必須對齊 SUBJECT_PLAN 的 teachers 欄位總和。
 * role 只在此標註特例，其餘一律 teacher。
 */
const FACULTY = [
    { name: '李士箴', subject: 'chinese',     role: 'director' },
    { name: '陳美玲', subject: 'chinese',     role: 'section_chief' },
    { name: '林彥廷', subject: 'chinese' },
    { name: '王大明', subject: 'english' },
    { name: '張淑芬', subject: 'english' },
    { name: '黃志偉', subject: 'math' },
    { name: '吳佩珊', subject: 'math' },
    { name: '劉建宏', subject: 'science' },
    { name: '蔡雅婷', subject: 'science' },
    { name: '鄭文彬', subject: 'social' },
    { name: '謝孟儒', subject: 'social',      noEmail: true },
    { name: '洪聖傑', subject: 'pe' },
    { name: '邱曉萍', subject: 'pe' },
    { name: '徐子涵', subject: 'art',         noEmail: true },
    { name: '高俊豪', subject: 'art' },
    { name: '廖詩涵', subject: 'integrative' },
    { name: '賴柏翰', subject: 'integrative' },
    { name: '簡宏達', subject: 'tech' },
    { name: '曾雅琳', subject: 'flexible' },
    { name: '周宜蓁', subject: 'flexible',    noEmail: true },
];

/** 不任課的行政人員：驗證結算對「名冊有、課表無」的教師是否給出 0 節而非崩潰。 */
const NON_TEACHING = [
    { name: '沈家瑋', role: 'teacher' },
    { name: '許雅文', role: 'teacher' },
];

/** email 一律小寫（firestore.rules 的 isInitialDirector 與 emailIndex 都假設小寫）。 */
function emailFor(index, domain) {
    return `t${String(index + 1).padStart(2, '0')}@${domain}`;
}

function buildTeachers(preset) {
    const now = '2026-08-01T00:00:00.000Z';
    const teachers = [];

    FACULTY.forEach((f, i) => {
        teachers.push({
            teacherId: `tch_${preset.schoolId}_${String(i + 1).padStart(2, '0')}`,
            name: f.name,
            email: f.noEmail ? null : emailFor(i, preset.emailDomain),
            domains: [],                       // 由課表統計後回填
            homeroomClass: '',                 // 稍後指派
            role: f.role || 'teacher',
            subjectKey: f.subject,
            createdAt: now,
            updatedAt: now,
        });
    });

    NON_TEACHING.forEach((f, i) => {
        const idx = FACULTY.length + i;
        teachers.push({
            teacherId: `tch_${preset.schoolId}_${String(idx + 1).padStart(2, '0')}`,
            name: f.name,
            email: emailFor(idx, preset.emailDomain),
            domains: [],
            homeroomClass: '',
            role: f.role,
            subjectKey: null,
            createdAt: now,
            updatedAt: now,
        });
    });

    return teachers;
}

/** 依 SUBJECT_PLAN 把教師分組成排課器需要的 { subjectKey: [教師姓名] }。 */
function groupTeachersBySubject(teachers) {
    const bySubject = {};
    for (const plan of SUBJECT_PLAN) bySubject[plan.key] = [];
    for (const t of teachers) {
        if (t.subjectKey && bySubject[t.subjectKey]) bySubject[t.subjectKey].push(t.name);
    }
    for (const plan of SUBJECT_PLAN) {
        if (bySubject[plan.key].length !== plan.teachers) {
            throw new Error(
                `科目 ${plan.key} 的教師人數（${bySubject[plan.key].length}）與 SUBJECT_PLAN.teachers（${plan.teachers}）不符，` +
                `排課配額會算錯，請同步修正 FACULTY 與 SUBJECT_PLAN`
            );
        }
    }
    return bySubject;
}

/* ===================== 日期工具 ===================== */

const WEEKDAY_TO_DOW = { 週一: 1, 週二: 2, 週三: 3, 週四: 4, 週五: 5 };

/** 該月第 nth 個指定星期的日期字串（YYYY-MM-DD），UTC 計算避開時區位移。 */
export function nthWeekdayOfMonth(year, month, weekdayLabel, nth = 1) {
    const target = WEEKDAY_TO_DOW[weekdayLabel];
    if (!target) throw new Error(`未知的星期標籤：${weekdayLabel}`);
    const first = new Date(Date.UTC(year, month - 1, 1));
    const shift = (target - first.getUTCDay() + 7) % 7;
    const day   = 1 + shift + (nth - 1) * 7;
    const d     = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) throw new Error(`${year}-${month} 沒有第 ${nth} 個 ${weekdayLabel}`);
    return d.toISOString().slice(0, 10);
}

/* ===================== 調代課紀錄 ===================== */

/**
 * 八種假別 × 中英文代碼混用。
 * settlementCalculator 對 official/longsick/funeral/swap 不扣時數，其餘扣 1 節；
 * 且同時支援英文代碼與中文名稱——這裡刻意兩種都造，驗證相容分支真的有效。
 */
const LEAVE_CASES = [
    { leaveType: 'official', leaveTypeName: '公假',     deduct: false },
    { leaveType: '公假',      leaveTypeName: '公假',     deduct: false },
    { leaveType: 'longsick', leaveTypeName: '長期病假', deduct: false },
    { leaveType: 'funeral',  leaveTypeName: '喪假',     deduct: false },
    { leaveType: 'personal', leaveTypeName: '事假',     deduct: true  },
    { leaveType: '病假',      leaveTypeName: '病假',     deduct: true  },
    { leaveType: 'rest',     leaveTypeName: '休假',     deduct: true  },
    { leaveType: 'other',    leaveTypeName: '其他',     deduct: true  },
];

/** 建立「某時段誰有課、誰空堂」的索引，供挑選代課教師。 */
function buildSlotIndex(parsedRows, allTeacherNames) {
    const bySlot = new Map();   // `${weekday}|${period}` -> { busy:Set, courses:[] }
    for (const w of WEEKDAYS) {
        for (const p of PERIODS) bySlot.set(`${w}|${p}`, { busy: new Set(), courses: [] });
    }
    for (const r of parsedRows) {
        const slot = bySlot.get(`${r.weekday}|${r.period}`);
        if (!slot) continue;
        slot.busy.add(r.teacher);
        slot.courses.push(r);
    }
    for (const slot of bySlot.values()) {
        slot.free = allTeacherNames.filter(n => !slot.busy.has(n));
    }
    return bySlot;
}

/**
 * 產生已成立的調代課紀錄。
 * 代課紀錄的代課教師一律取自「該時段真的空堂」的教師，避免假資料本身就是不可能成立的排班。
 */
function buildSubstituteRecords({ preset, teachers, parsedRows, semesterId, year, month, rng }) {
    const nameToId = new Map(teachers.map(t => [t.name, t.teacherId]));
    const allNames = teachers.filter(t => t.subjectKey).map(t => t.name);
    const bySlot   = buildSlotIndex(parsedRows, allNames);
    const approver = teachers.find(t => t.role === 'section_chief');

    const records = [];
    const usedSlots = new Set();

    /** 挑一堂「教師不是 approver 本人、且該時段有其他教師空堂」的課。 */
    function takeCourse(weekdayIdx, periodIdx, nth) {
        const weekday = WEEKDAYS[weekdayIdx];
        const period  = PERIODS[periodIdx];
        const slot    = bySlot.get(`${weekday}|${period}`);
        const pool    = shuffle(rng, slot.courses.filter(c => !usedSlots.has(`${c.className}|${weekday}|${period}`)));
        const course  = pool[0];
        if (!course || !slot.free.length) return null;
        usedSlots.add(`${course.className}|${weekday}|${period}`);
        return { course, sub: shuffle(rng, slot.free)[0], date: nthWeekdayOfMonth(year, month, weekday, nth) };
    }

    // --- 代課紀錄：八種假別各一筆 ---
    LEAVE_CASES.forEach((leave, i) => {
        const picked = takeCourse(i % 5, i % 7, 1 + (i % 3));
        if (!picked) throw new Error(`無法為假別 ${leave.leaveType} 找到合適的課堂`);
        const { course, sub, date } = picked;
        const recordId = `rec_${preset.schoolId}_${semesterId}_sub${String(i + 1).padStart(2, '0')}`;
        records.push({
            recordId,
            public: {
                id: recordId,
                type: '代課',
                date,
                weekday: course.weekday,
                period: course.period,
                className: course.className,
                subject: course.subject,
                domain: course.domain,
                originalTeacher: course.teacher,
                originalTeacherId: nameToId.get(course.teacher),
                substituteTeacher: sub,
                substituteTeacherId: nameToId.get(sub),
                docNumber: leave.deduct ? '' : `府教字第${11500000 + i}號`,
                semesterId,
                approvedBy: approver.teacherId,
                approvedByName: approver.name,
                approvedAt: `${date}T10:00:00.000Z`,
                createdAt: `${date}T08:00:00.000Z`,
                isSelfSwap: false,
            },
            private: {
                leaveType: leave.leaveType,
                leaveTypeName: leave.leaveTypeName,
                reason: `${leave.leaveTypeName}（假資料 #${i + 1}）`,
                allowedTeacherIds: [
                    nameToId.get(course.teacher),
                    nameToId.get(sub),
                    approver.teacherId,
                ].filter(Boolean),
            },
            expected: { deduct: leave.deduct, isSwap: false },
        });
    });

    // --- 調課紀錄：兩人互換 2 筆（英文碼／中文各一）+ 自行調課 1 筆 ---
    const swapCases = [
        { leaveType: 'swap', isSelf: false },
        { leaveType: '調課', isSelf: false },
        { leaveType: '調課', isSelf: true  },
    ];
    swapCases.forEach((sc, i) => {
        const a = takeCourse((i + 2) % 5, (i + 3) % 7, 2);
        const b = takeCourse((i + 4) % 5, (i + 5) % 7, 3);
        if (!a || !b) throw new Error(`無法為調課案例 #${i + 1} 找到兩個時段`);

        const teacherA = a.course.teacher;
        const teacherB = sc.isSelf ? teacherA : b.course.teacher;
        const recordId = `rec_${preset.schoolId}_${semesterId}_swap${String(i + 1).padStart(2, '0')}`;
        records.push({
            recordId,
            public: {
                id: recordId,
                type: '調課',
                date: a.date,
                swapDate: b.date,
                weekday: a.course.weekday,
                period: a.course.period,
                className: a.course.className,
                subject: a.course.subject,
                domain: a.course.domain,
                originalTeacher: teacherA,
                originalTeacherId: nameToId.get(teacherA),
                swapWeekday: b.course.weekday,
                swapPeriod: b.course.period,
                swapTeacher: teacherB,
                swapTeacherId: nameToId.get(teacherB),
                swapSubject: b.course.subject,
                swapDomain: b.course.domain,
                substituteTeacher: teacherB,
                substituteTeacherId: nameToId.get(teacherB),
                docNumber: '',
                isSelfSwap: sc.isSelf,
                isMultiSwap: true,
                semesterId,
                approvedBy: approver.teacherId,
                approvedByName: approver.name,
                approvedAt: `${a.date}T10:00:00.000Z`,
                createdAt: `${a.date}T08:00:00.000Z`,
            },
            private: {
                leaveType: sc.leaveType,
                leaveTypeName: '調課',
                reason: sc.isSelf
                    ? `${teacherA} 自行調課（假資料）`
                    : `${teacherA} 與 ${teacherB} 課程互換（假資料）`,
                allowedTeacherIds: [
                    nameToId.get(teacherA),
                    nameToId.get(teacherB),
                    approver.teacherId,
                ].filter(Boolean),
            },
            expected: { deduct: false, isSwap: true },
        });
    });

    return records;
}

/* ===================== 待審請求 ===================== */

function buildPendingRequests({ preset, teachers, parsedRows, semesterId, year, month, rng }) {
    const nameToId = new Map(teachers.map(t => [t.name, t.teacherId]));
    const allNames = teachers.filter(t => t.subjectKey).map(t => t.name);
    const bySlot   = buildSlotIndex(parsedRows, allNames);
    const approver = teachers.find(t => t.role === 'section_chief');
    const director = teachers.find(t => t.role === 'director');

    // 固定挑週三第三節，避開上面代課紀錄用掉的時段組合
    const slot   = bySlot.get('週三|第三節');
    const pool   = shuffle(rng, slot.courses);
    const date   = nthWeekdayOfMonth(year, month, '週三', 4);
    const idOf   = (n) => nameToId.get(n);

    // 下面固定取用 pool[0]～pool[5] 六堂課。每班每週有一節空堂（配額 34 < 35 個時段），
    // 班級數少的學校（beta 只有 6 班）剛好卡在下限——若某次排課把某班的空堂排在這一格，
    // pool[5] 會是 undefined，錯誤會以 `Cannot read properties of undefined` 的形式炸在
    // seedAll() 裡、落在任何測試案例之外。這裡先擋下並說清楚原因。
    const NEEDED = 6;
    if (pool.length < NEEDED) {
        throw new Error(
            `建立待審請求需要「週三第三節」至少 ${NEEDED} 堂課，${preset.schoolId} 只有 ${pool.length} 堂。` +
            `原因是該時段有班級排到空堂。請調整 preset.seed 或 SUBJECT_PLAN 的配額後重試。`
        );
    }

    const base = (course, extra) => ({
        type: extra.type || '代課',
        date,
        weekday: course.weekday,
        period: course.period,
        className: course.className,
        subject: course.subject,
        domain: course.domain,
        originalTeacher: course.teacher,
        originalTeacherId: idOf(course.teacher),
        semesterId,
        requiredApproverId: approver.teacherId,
        createdAt: `${date}T07:30:00.000Z`,
        ...extra,
    });

    const requests = [];
    const mk = (suffix, publicPart, privatePart, note) => {
        const reqId = `req_${preset.schoolId}_${semesterId}_${suffix}`;
        requests.push({ reqId, public: { ...publicPart, reqId }, private: privatePart, note });
    };

    // 1. 代課單簽，等核准
    {
        const c   = pool[0];
        const sub = shuffle(rng, slot.free)[0];
        mk('sub_pending_approval', base(c, {
            requestType: 'substitute',
            status: 'pending_approval',
            pendingConsentTeacherIds: [],
            swapConsents: {},
            initiatedBy: idOf(c.teacher),
            initiatedByName: c.teacher,
            substituteTeacher: sub,
            substituteTeacherId: idOf(sub),
        }), {
            leaveType: 'personal', leaveTypeName: '事假', reason: '家中有事（假資料）',
            allowedTeacherIds: [idOf(c.teacher), idOf(sub), approver.teacherId].filter(Boolean),
        }, '代課單簽，待組長核准');
    }

    // 2. 調課雙簽，等對方同意
    {
        const c    = pool[1];
        const peer = shuffle(rng, slot.free)[1];
        mk('swap_pending_consent', base(c, {
            type: '調課',
            requestType: 'swap',
            status: 'pending_swap_consent',
            pendingConsentTeacherIds: [idOf(peer)],
            swapConsents: {},
            initiatedBy: idOf(c.teacher),
            initiatedByName: c.teacher,
            swapTeacher: peer,
            swapTeacherId: idOf(peer),
            substituteTeacher: peer,
            substituteTeacherId: idOf(peer),
        }), {
            leaveType: '調課', leaveTypeName: '調課', reason: '課程互換（假資料）',
            allowedTeacherIds: [idOf(c.teacher), idOf(peer), approver.teacherId].filter(Boolean),
        }, '調課雙簽，對方尚未同意');
    }

    // 3. 調課雙簽，對方已同意，等核准
    {
        const c    = pool[2];
        const peer = shuffle(rng, slot.free)[2];
        mk('swap_pending_approval', base(c, {
            type: '調課',
            requestType: 'swap',
            status: 'pending_approval',
            pendingConsentTeacherIds: [],
            swapConsents: { [idOf(peer)]: `${date}T09:00:00.000Z` },
            initiatedBy: idOf(c.teacher),
            initiatedByName: c.teacher,
            swapTeacher: peer,
            swapTeacherId: idOf(peer),
            substituteTeacher: peer,
            substituteTeacherId: idOf(peer),
            statusUpdatedAt: `${date}T09:00:00.000Z`,
        }), {
            leaveType: '調課', leaveTypeName: '調課', reason: '對方已同意，待核准（假資料）',
            allowedTeacherIds: [idOf(c.teacher), idOf(peer), approver.teacherId].filter(Boolean),
        }, '調課雙簽，已同意待核准');
    }

    // 4. 多重調課，三人中一人已同意
    {
        const c     = pool[3];
        const peers = shuffle(rng, slot.free).slice(3, 6);
        mk('multiswap_partial', base(c, {
            type: '調課',
            requestType: 'multi_swap',
            status: 'pending_swap_consent',
            pendingConsentTeacherIds: [idOf(peers[1]), idOf(peers[2])],
            swapConsents: { [idOf(peers[0])]: `${date}T09:15:00.000Z` },
            initiatedBy: idOf(c.teacher),
            initiatedByName: c.teacher,
            swapTeacher: peers[0],
            swapTeacherId: idOf(peers[0]),
            substituteTeacher: peers[0],
            substituteTeacherId: idOf(peers[0]),
        }), {
            leaveType: '調課', leaveTypeName: '調課', reason: '三人連環調課（假資料）',
            allowedTeacherIds: [idOf(c.teacher), ...peers.map(idOf), approver.teacherId].filter(Boolean),
        }, '多重調課，尚有兩人未同意');
    }

    // 5. 已駁回（soft-reject，保留文件供發起人 dismiss）
    {
        const c   = pool[4];
        const sub = shuffle(rng, slot.free)[6];
        mk('rejected', base(c, {
            requestType: 'substitute',
            status: 'rejected',
            pendingConsentTeacherIds: [],
            swapConsents: {},
            initiatedBy: idOf(c.teacher),
            initiatedByName: c.teacher,
            substituteTeacher: sub,
            substituteTeacherId: idOf(sub),
            rejectedBy: director.teacherId,
            rejectedByName: director.name,
            rejectReason: '當日已有其他代課安排（假資料）',
            statusUpdatedAt: `${date}T11:00:00.000Z`,
        }), {
            leaveType: 'rest', leaveTypeName: '休假', reason: '休假（假資料）',
            allowedTeacherIds: [idOf(c.teacher), idOf(sub), director.teacherId].filter(Boolean),
        }, '已被駁回');
    }

    // 6. alpha 期舊資料：status='pending' 且無 requestType，讀取時應由 normalizeLegacyRequest 映射
    {
        const c    = pool[5];
        const peer = shuffle(rng, slot.free)[7];
        mk('legacy_pending', {
            type: '調課',
            date,
            weekday: c.weekday,
            period: c.period,
            className: c.className,
            subject: c.subject,
            originalTeacher: c.teacher,
            originalTeacherId: idOf(c.teacher),
            initiatedBy: idOf(c.teacher),
            initiatedByName: c.teacher,
            requiredApproverId: idOf(peer),
            status: 'pending',
            createdAt: '2026-04-10T02:00:00.000Z',
            // 刻意不帶 requestType / pendingConsentTeacherIds / swapConsents / semesterId，
            // 這正是 alpha 期舊文件的形狀
        }, null, 'alpha 期舊資料（status=pending、無 requestType、無 semesterId）');
    }

    return requests;
}

/* ===================== 操作日誌 ===================== */

function buildOperationLogs({ preset, teachers, semesterId, records }) {
    const director = teachers.find(t => t.role === 'director');
    const approver = teachers.find(t => t.role === 'section_chief');
    const logs = [];
    // 欄位形狀必須對齊 firestore.rules 的 operationLogs create 白名單
    // （action / actor / timestamp / targetType / targetId / details / semesterId），
    // actor 是 map——種子雖然以 admin 身分繞過規則寫入，形狀寫錯的話後續權限測試會
    // 測到一份現實中不可能存在的資料。
    const push = (i, action, targetType, targetId, actor, details) => {
        logs.push({
            logId: `log_${preset.schoolId}_${semesterId}_${String(i).padStart(3, '0')}`,
            data: {
                action, targetType, targetId,
                actor: { teacherId: actor.teacherId, name: actor.name },
                timestamp: `2026-09-0${(i % 9) + 1}T03:00:00.000Z`,
                semesterId,
                details: details || {},
            },
        });
    };

    push(1, 'schedule_import', 'schedule', semesterId, approver, { rows: 315 });
    push(2, 'roster_import', 'teacher', null, director, { created: teachers.length });
    records.slice(0, 5).forEach((r, i) => {
        push(3 + i, 'approve', 'substituteRecord', r.recordId, approver, {
            summary: { type: r.public.type, date: r.public.date, className: r.public.className },
        });
    });
    push(8, 'semester_switch', 'system', semesterId, director, { from: '114-2', to: semesterId });
    return logs;
}

/* ===================== 組裝 ===================== */

/**
 * 產生一所學校的完整假資料。
 * @param {object} preset ALPHA / BETA
 */
export function buildSchoolFixture(preset) {
    const teachers    = buildTeachers(preset);
    const bySubject   = groupTeachersBySubject(teachers);

    // 目前學期與前一學期各排一份課表（seed 不同 → 兩學期課表確實不同，可驗證 per-semester 隔離）
    const current = buildBestSchedule(makeRng, {
        classes: [...preset.classes], teachersBySubject: bySubject, baseSeed: preset.seed,
    });
    const previous = buildBestSchedule(makeRng, {
        classes: [...preset.classes], teachersBySubject: bySubject, baseSeed: preset.seed + 100003,
    });

    const parsedCurrent = rowsToParsedShape(current.rows);

    // 依課表回填每位教師的任教領域（排除 ScheduleParser.excludedDomains 涵蓋的領域）
    const EXCLUDED = ['統整性主題/專題/議題探究', '社團活動與技藝課程'];
    const domainMap = new Map();
    for (const r of parsedCurrent) {
        if (!r.domain || EXCLUDED.includes(r.domain)) continue;
        if (!domainMap.has(r.teacher)) domainMap.set(r.teacher, new Set());
        domainMap.get(r.teacher).add(r.domain);
    }
    teachers.forEach(t => { t.domains = [...(domainMap.get(t.name) || [])]; });

    // 導師：前 9 位任課教師依序帶班
    preset.classes.forEach((cls, i) => { teachers[i].homeroomClass = cls; });

    const rng = makeRng(preset.seed + 555);
    const records = buildSubstituteRecords({
        preset, teachers, parsedRows: parsedCurrent,
        semesterId: preset.currentSemester, year: 2026, month: 9, rng,
    });
    const prevRecords = buildSubstituteRecords({
        preset, teachers, parsedRows: rowsToParsedShape(previous.rows),
        semesterId: preset.previousSemester, year: 2026, month: 4, rng,
    });
    const pendingRequests = buildPendingRequests({
        preset, teachers, parsedRows: parsedCurrent,
        semesterId: preset.currentSemester, year: 2026, month: 9, rng,
    });
    const logs = buildOperationLogs({ preset, teachers, semesterId: preset.currentSemester, records });

    const director = teachers.find(t => t.role === 'director');

    return {
        preset,
        schoolId: preset.schoolId,
        config: {
            schoolName: preset.schoolName,
            currentSemester: preset.currentSemester,
            initialAdminEmails: [director.email],
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z',
        },
        teachers,
        schedules: {
            [preset.currentSemester]:  { rows: current.rows,  parsed: parsedCurrent },
            [preset.previousSemester]: { rows: previous.rows, parsed: rowsToParsedShape(previous.rows) },
        },
        substituteRecords: records,
        previousSemesterRecords: prevRecords,
        pendingRequests,
        operationLogs: logs,
        meta: {
            unplacedCurrent: current.unplaced,
            unplacedPrevious: previous.unplaced,
            totalPeriods: current.rows.length,
        },
    };
}

/** 課表中每位教師的每週節數（供結算測試比對）。 */
export function weeklyHoursByTeacher(parsedRows) {
    const counts = new Map();
    for (const r of parsedRows) counts.set(r.teacher, (counts.get(r.teacher) || 0) + 1);
    return counts;
}
