/**
 * 假課表產生器
 *
 * 產出「人力資源網 2.0 匯出格式」的原始列（12 欄），可直接轉成 CSV 餵給 ScheduleParser，
 * 也可轉成 parser 產出的形狀直接餵給 SettlementCalculator。
 *
 * 排課保證（產生後由 validateSchedule() 實際驗證，不是註解宣告）：
 *   - 同一位教師不會在同一個時段出現在兩個班（無衝堂）
 *   - 同一個班同一個時段只有一門課
 *   - 每個 (班級, 科目) 固定由同一位教師任教（真實課表的性質，也讓結算數字有意義）
 *
 * 排課用貪婪法：逐時段、逐班挑「剩餘節數 ÷ 該科教師數」最高（最稀缺）的科目先排。
 * 稀缺度優先是必要的——科技科只有 1 位教師卻要教 9 個班，若不優先排，最後會排不完。
 * 仍排不完時由呼叫端換 seed 重試（見 buildBestSchedule）。
 */

import { shuffle } from './rng.mjs';

export const WEEKDAYS = ['週一', '週二', '週三', '週四', '週五'];
export const PERIODS  = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節'];

/** CSV 標題列（人力資源網 2.0 匯出格式，欄位順序與 test/test-data.csv 一致） */
export const CSV_HEADERS = [
    '週次', '節次', '年級', '班級', '教師姓名', '身分證字號或居留證號',
    '類別', '領域', '科目', '語言別/校訂課程名稱', '上課頻率', '起始週',
];

/**
 * 每班每週的科目配額，合計 34 節。
 * 刻意比時段總數（35）少 1 節，每班每週留一格空堂——真實國中課表本來就不是每格都有課
 * （導師時間／朝會等），而且「配額 = 時段數」等於要求排課器產出完美的正交排列，
 * 貪婪法無法保證，留 1 節餘裕才能穩定排滿。
 * teachers 為該科的教師人數，同時決定「同一時段最多幾個班能上這一科」。
 */
export const SUBJECT_PLAN = [
    { key: 'chinese',     subject: '國語文',       domain: '語文領域',       periods: 5, teachers: 3 },
    { key: 'english',     subject: '英語文',       domain: '語文領域',       periods: 4, teachers: 2 },
    { key: 'math',        subject: '數學',         domain: '數學領域',       periods: 4, teachers: 2 },
    { key: 'science',     subject: null,           domain: '自然科學領域',   periods: 4, teachers: 2 },
    { key: 'social',      subject: null,           domain: '社會領域',       periods: 4, teachers: 2 },
    { key: 'pe',          subject: '健康與體育',   domain: '健康與體育領域', periods: 3, teachers: 2 },
    { key: 'art',         subject: '視覺藝術',     domain: '藝術領域',       periods: 3, teachers: 2 },
    { key: 'integrative', subject: '綜合活動',     domain: '綜合活動領域',   periods: 3, teachers: 2 },
    { key: 'tech',        subject: '資訊科技',     domain: '科技領域',       periods: 2, teachers: 1 },
    // 彈性學習：帶「語言別/校訂課程名稱」，用來驗證 parser 的 courseName 優先於 subject；
    // 其領域屬 ScheduleParser.excludedDomains，用來驗證該領域不計入教師任教領域統計。
    {
        key: 'flexible', subject: '彈性學習課程', domain: '統整性主題/專題/議題探究',
        periods: 2, teachers: 2, courseName: '閱讀素養', category: '彈性學習',
    },
];

export const TOTAL_PERIODS_PER_WEEK = WEEKDAYS.length * PERIODS.length;

/** 自然科依年級分科；社會科依班序輪替，兩者都讓假資料看起來像真的課表。 */
function resolveSubject(plan, grade, classIndex) {
    if (plan.key === 'science') return grade === 7 ? '生物' : '理化';
    if (plan.key === 'social')  return ['歷史', '地理', '公民'][classIndex % 3];
    return plan.subject;
}

function gradeOf(className) {
    const m = /^(\d+)年/.exec(className);
    return m ? Number(m[1]) : 0;
}

/**
 * 為每個 (班級, 科目) 指派固定任教教師，同科教師之間平均分攤班級數。
 * @returns {Map<string, string>} key 為 `${className}|${subjectKey}`，值為教師姓名
 */
function assignClassTeachers(rng, classes, teachersBySubject) {
    const assign = new Map();
    for (const plan of SUBJECT_PLAN) {
        const pool = teachersBySubject[plan.key];
        if (!pool || !pool.length) throw new Error(`科目 ${plan.key} 沒有可用教師`);
        shuffle(rng, classes).forEach((cls, i) => {
            assign.set(`${cls}|${plan.key}`, pool[i % pool.length]);
        });
    }
    return assign;
}

/**
 * 單次排課嘗試。
 * @returns {{ rows: Array<object>, unplaced: number }}
 */
function placeCourses(rng, classes, assign) {
    const remaining = new Map();
    classes.forEach(cls => {
        const quota = new Map();
        SUBJECT_PLAN.forEach(p => quota.set(p.key, p.periods));
        remaining.set(cls, quota);
    });

    const rows = [];
    for (let d = 0; d < WEEKDAYS.length; d++) {
        for (let p = 0; p < PERIODS.length; p++) {
            const busy = new Set();
            // 班級順序每個時段重新打亂，避免固定順序讓排在後面的班永遠吃虧；
            // 打亂後再依「可選科目數」升冪處理（most-constrained-first）——被卡最緊的班先挑，
            // 剩餘彈性大的班留到後面，可把排不完的節數壓到 0（純隨機順序會殘留 1~3 節）。
            const pending = shuffle(rng, classes);
            while (pending.length) {
                const options = pending.map(cls => {
                    const cands = [];
                    for (const plan of SUBJECT_PLAN) {
                        const left = remaining.get(cls).get(plan.key);
                        if (!left) continue;
                        const teacher = assign.get(`${cls}|${plan.key}`);
                        if (busy.has(teacher)) continue;
                        cands.push({ plan, teacher, score: left / plan.teachers });
                    }
                    return { cls, cands };
                });
                // 先處理仍有課可排、且選擇最少的班
                options.sort((a, b) => {
                    const av = a.cands.length || Infinity;
                    const bv = b.cands.length || Infinity;
                    return av - bv;
                });
                const chosen = options[0];
                pending.splice(pending.indexOf(chosen.cls), 1);

                const cls  = chosen.cls;
                const best = chosen.cands.sort((a, b) => b.score - a.score)[0];
                if (!best) continue;  // 這個班這個時段排不進任何科目 → 空堂

                remaining.get(cls).set(best.plan.key, remaining.get(cls).get(best.plan.key) - 1);
                busy.add(best.teacher);

                const grade      = gradeOf(cls);
                const classIndex = classes.indexOf(cls);
                const subject    = resolveSubject(best.plan, grade, classIndex);
                rows.push({
                    週次: WEEKDAYS[d],
                    節次: PERIODS[p],
                    年級: `${grade}年級`,
                    班級: cls,
                    教師姓名: best.teacher,
                    身分證字號或居留證號: '',
                    類別: best.plan.category || '領域學習',
                    領域: best.plan.domain,
                    科目: subject,
                    '語言別/校訂課程名稱': best.plan.courseName || '',
                    上課頻率: '1',
                    起始週: '1',
                });
            }
        }
    }

    let unplaced = 0;
    remaining.forEach(quota => quota.forEach(n => { unplaced += n; }));
    return { rows, unplaced };
}

/**
 * 排課並驗證，回傳問題清單（空陣列＝完全乾淨）。
 * 這是 fixture 的自我檢查：假資料本身若有衝堂，後續所有測試的結論都不可信。
 */
export function validateSchedule(rows) {
    const problems = [];
    const teacherSlot = new Map();  // `${週次}|${節次}|${教師}` -> 班級
    const classSlot   = new Map();  // `${週次}|${節次}|${班級}` -> 科目

    for (const r of rows) {
        const tKey = `${r.週次}|${r.節次}|${r.教師姓名}`;
        if (teacherSlot.has(tKey)) {
            problems.push(`教師衝堂：${r.教師姓名} 於 ${r.週次}${r.節次} 同時在 ${teacherSlot.get(tKey)} 與 ${r.班級}`);
        }
        teacherSlot.set(tKey, r.班級);

        const cKey = `${r.週次}|${r.節次}|${r.班級}`;
        if (classSlot.has(cKey)) {
            problems.push(`班級重複排課：${r.班級} 於 ${r.週次}${r.節次} 同時有 ${classSlot.get(cKey)} 與 ${r.科目}`);
        }
        classSlot.set(cKey, r.科目);
    }
    return problems;
}

/**
 * 多 seed 重試，取排得最滿的一份；並驗證無衝堂。
 * @param {(seed:number)=>Function} makeRngForSeed 由呼叫端提供（避免本模組自行決定 seed 語意）
 */
export function buildBestSchedule(makeRngForSeed, { classes, teachersBySubject, attempts = 300, baseSeed = 20260811 }) {
    let best = null;
    for (let i = 0; i < attempts; i++) {
        const rng    = makeRngForSeed(baseSeed + i * 7919);
        const assign = assignClassTeachers(rng, classes, teachersBySubject);
        const result = placeCourses(rng, classes, assign);
        if (!best || result.unplaced < best.unplaced) best = { ...result, assign, seed: baseSeed + i * 7919 };
        if (best.unplaced === 0) break;
    }

    const problems = validateSchedule(best.rows);
    if (problems.length) {
        throw new Error(`排課器產出的假課表本身有衝突，測試資料不可用：\n${problems.join('\n')}`);
    }
    return best;
}

/** 原始列陣列 → CSV 字串（含 BOM 選項，供測試中文編碼） */
export function rowsToCsv(rows, { withBom = false, headers = CSV_HEADERS } = {}) {
    const escape = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => escape(r[h])).join(','));
    return (withBom ? '﻿' : '') + lines.join('\n') + '\n';
}

/**
 * 原始列 → ScheduleParser.processRawData() 產出的形狀。
 * 讓不經過 parser 的測試（例如結算）也能直接使用同一份課表。
 */
export function rowsToParsedShape(rows) {
    return rows.map(r => {
        const rawSubject = r.科目 || '';
        const courseName = r['語言別/校訂課程名稱'] || '';
        return {
            weekday: r.週次,
            period: r.節次,
            className: r.班級,
            teacher: r.教師姓名,
            domain: r.領域 || '',
            subject: courseName || rawSubject,
            rawSubject,
            courseName,
            category: r.類別 || '',
        };
    });
}
