/**
 * 智慧推薦引擎模組
 *
 * 代課教師推薦邏輯：
 * 1. 候選名單 = 教師名單 ∪ 課表上出現的所有教師（只存在於課表、尚未加入名單者也會列出）
 * 2. 排除該時段有課、當日該節已被指派代/調課者，以及原任課教師 → 全部可代課教師
 * 3. 依以下優先順序排序（全部列出，不截斷）：
 *    - 優先度 1：同科目教師（課表上也教這一科，或任教領域欄填了這一科）
 *    - 優先度 2：該班導師
 *    - 優先度 3：同任課班級教師（課表上也有教這個班）
 *    - 優先度 4：其他空堂教師
 *    - 優先度 5：兼課教師（teacher.partTime === true，不論是否符合上述條件一律排最後）
 *
 * 同一優先度內，符合的條件越多越前面；再以「同領域」微調；同分者「本月已代節數」少者優先
 * （公平性 tie-break，不改分數、不會壓過上述任何一層），最後依姓名排序以保持穩定。
 */

/**
 * 單一衝堂判斷來源：某教師在指定日期／星期／節次是否已無法再被指派代課。
 * 推薦過濾（RecommendationEngine）與送出前攔截（DataManager.checkSubstituteTeacherConflict）
 * 共用此函式，避免兩份邏輯日後各自漂移。
 *
 * 檢查兩件事（先「有課」後「已代課」）：
 *   (1) kind:'teaching' 該教師當星期當節原本有自己的課（scheduleData；呼叫端負責傳入有效課表）
 *   (2) kind:'covering' 該教師同日同節已被指派為代課(role:'代課')或調課(role:'調課')
 * 姓名比對皆去除前後空白。
 *
 * @param {Object} p
 * @param {string} p.teacherName - 教師姓名
 * @param {string} p.date - 日期 YYYY-MM-DD
 * @param {string} [p.weekday] - 星期；未提供則略過「有課」檢查
 * @param {string} p.period - 節次
 * @param {Array} [p.scheduleData] - 課表
 * @param {Array} [p.records] - 已存在的調代課紀錄（呼叫端自行決定是否含 V2 在途請求）
 * @param {string} [p.excludeRecordId] - 編輯既有紀錄時排除該 id
 * @returns {{kind:'teaching', detail:Object}|{kind:'covering', detail:Object, role:string}|null}
 */
export function findTeacherConflict({ teacherName, date, weekday, period, scheduleData = [], records = [], excludeRecordId = null }) {
    const name = teacherName == null ? '' : String(teacherName).trim();
    if (!name || !period) return null;
    const same = v => v != null && String(v).trim() === name;

    if (weekday) {
        const own = (scheduleData || []).find(c =>
            c.weekday === weekday && c.period === period && same(c.teacher));
        if (own) return { kind: 'teaching', detail: own };
    }

    if (date) {
        const hit = (records || []).find(r =>
            r.id !== excludeRecordId && r.date === date && r.period === period &&
            (same(r.substituteTeacher) || same(r.swapTeacher)));
        if (hit) return { kind: 'covering', detail: hit, role: same(hit.swapTeacher) ? '調課' : '代課' };
    }
    return null;
}

export class RecommendationEngine {
    constructor() {
        // 評分權重：各層相差夠大，確保高優先條件永遠壓過低優先條件的組合
        // （同科目 1000 > 班導師 300 + 同任課班級 100 + 同領域 5）
        this.weights = {
            sameSubject: 1000,  // 同科目教師
            homeroom: 300,      // 該班導師
            sameClass: 100,     // 同任課班級教師
            sameDomain: 5,      // 同領域（僅作同層微調）
            base: 10,           // 基礎分數（空堂）
            partTime: -10000    // 兼課教師：整批排到最後
        };
    }

    /**
     * 取得推薦代課教師列表
     * @param {Object} targetCourse - 目標課程資訊
     * @param {Array} scheduleData - 全部課表資料
     * @param {Array} teachers - 全部教師資料
     * @param {string} date - 調課日期（用於判斷星期）
     * @param {Array} [substituteRecords=[]] - 已存在的調代課紀錄（用於排除已被指派的教師）
     * @param {Array|null} [monthRecords=null] - 目標日期所在月份的調代課紀錄（用於「本月已代 N 節」公平性
     *        tie-break）；不提供（null）則不做公平性排序也不顯示本月節數
     * @returns {Array} 推薦教師列表（已排序）：{ teacher, score, reason, reasonText, tags }
     */
    getRecommendations(targetCourse, scheduleData, teachers, date, substituteRecords = [], monthRecords = null) {
        const { weekday, period, className, domain, originalTeacher } = targetCourse;
        scheduleData = scheduleData || [];

        console.log('===== 智慧推薦引擎開始運算 =====');
        console.log('目標課程:', { weekday, period, className, domain, originalTeacher });

        // 步驟 1+2：篩選出空堂教師。衝堂（該節有課、當日該節已被指派代/調課）一律走共用的
        // findTeacherConflict；另排除原任課教師
        const original = this.normalizeName(originalTeacher);
        const freeTeachers = this.getCandidateTeachers(teachers, scheduleData).filter(teacher => {
            const name = this.normalizeName(teacher.name);
            return name && name !== original && !findTeacherConflict({
                teacherName: name, date, weekday, period, scheduleData, records: substituteRecords
            });
        });
        console.log('空堂教師:', freeTeachers.map(t => t.name));

        // 步驟 3：計算每位空堂教師的推薦分數
        const teachingIndex = this.buildTeachingIndex(scheduleData);
        const monthCounts = monthRecords ? this.countMonthlySubstitutes(monthRecords, date) : null;
        const scoredTeachers = freeTeachers.map(teacher => {
            const score = this.calculateScore(teacher, targetCourse, teachingIndex);
            const rec = {
                teacher,
                score: score.total,
                reason: score.primaryReason,
                reasonText: score.reasonText,
                tags: score.reasons
            };
            if (monthCounts) {
                // 有提供本月紀錄時一律標示：N>0 顯示「本月已代 N 節」，N=0 顯示「本月未代課」
                const n = monthCounts.get(this.normalizeName(teacher.name)) || 0;
                rec.monthlyCount = n;
                rec.reasonText += (rec.reasonText ? '、' : '') + (n > 0 ? `本月已代 ${n} 節` : '本月未代課');
            }
            return rec;
        });

        // 步驟 4：依分數降序；同分者本月已代節數少者優先（只在同分內生效，
        // 因此不可能壓過任何一層）；最後依姓名排序以保持穩定
        scoredTeachers.sort((a, b) =>
            (b.score - a.score) ||
            ((a.monthlyCount || 0) - (b.monthlyCount || 0)) ||
            String(a.teacher.name).localeCompare(String(b.teacher.name), 'zh-Hant'));

        console.log('推薦結果:', scoredTeachers.map(r =>
            `${r.teacher.name}: ${r.score}分 (${r.reasonText})`
        ));
        console.log('===== 推薦引擎運算完成 =====');

        return scoredTeachers;
    }

    /**
     * 候選教師 = 教師名單 ∪ 課表上出現的教師（依姓名去重，名單內的資料優先）
     *
     * Why: 教師名單可能漏人（課表編輯後新增的教師、V2 尚未補入名單者），
     * 只從名單挑會讓這些其實有空堂的老師從推薦中消失。
     *
     * @param {Array} teachers - 教師名單
     * @param {Array} scheduleData - 課表資料
     * @returns {Array} 教師資料陣列
     */
    getCandidateTeachers(teachers, scheduleData) {
        const byName = new Map();
        (teachers || []).forEach(t => {
            const name = this.normalizeName(t && t.name);
            if (name && !byName.has(name)) byName.set(name, t);
        });
        (scheduleData || []).forEach(course => {
            const name = this.normalizeName(course.teacher);
            if (name && !byName.has(name)) {
                byName.set(name, { name, domains: [], homeroomClass: '' });
            }
        });
        return [...byName.values()];
    }

    /**
     * 由課表建立「教師 → 任教科目／任教班級」索引
     * @param {Array} scheduleData - 課表資料
     * @returns {Map<string, {subjects: Set<string>, classes: Set<string>}>}
     */
    buildTeachingIndex(scheduleData) {
        const index = new Map();
        (scheduleData || []).forEach(course => {
            const name = this.normalizeName(course.teacher);
            if (!name) return;
            if (!index.has(name)) index.set(name, { subjects: new Set(), classes: new Set() });
            const entry = index.get(name);
            [course.subject, course.rawSubject].forEach(s => {
                const n = this.normalizeSubject(s);
                if (n) entry.subjects.add(n);
            });
            const cls = this.normalizeClassName(course.className);
            if (cls) entry.classes.add(cls);
        });
        return index;
    }

    /**
     * 統計目標日期所在月份，每位教師擔任代課教師(substituteTeacher)的節數
     *
     * 只算 type==='代課'；有 status 欄位且不是 'approved' 者不算（待同意／待核准／已拒絕）；
     * V1 紀錄沒有 status，視為已成立。每筆紀錄 = 一節。
     *
     * @param {Array} records - 調代課紀錄（可含其他月份，本函式會依日期前綴過濾）
     * @param {string} date - 目標日期 YYYY-MM-DD
     * @returns {Map<string, number>} 教師姓名（trim）→ 本月節數
     */
    countMonthlySubstitutes(records, date) {
        const counts = new Map();
        const month = String(date || '').slice(0, 7);
        if (!month) return counts;
        (records || []).forEach(r => {
            if (!r || r.type !== '代課' || !r.substituteTeacher) return;
            if (r.status && r.status !== 'approved') return;
            if (String(r.date || '').slice(0, 7) !== month) return;
            const name = this.normalizeName(r.substituteTeacher);
            counts.set(name, (counts.get(name) || 0) + 1);
        });
        return counts;
    }

    /**
     * 併班候選：同一星期同一節「正在上別班課」的教師（無人可代時的建議，僅供顯示）
     *
     * 排除原任課教師與目標班級自己的課；同年級優先，其次同科目，再依姓名排序。
     *
     * @param {Object} targetCourse - { weekday, period, className, subject, rawSubject, originalTeacher }
     * @param {Array} scheduleData - 課表（呼叫端傳有效課表）
     * @returns {Array<{teacher:string, className:string, subject:string, sameGrade:boolean, sameSubject:boolean}>}
     */
    getMergeOptions(targetCourse, scheduleData) {
        const { weekday, period, className, originalTeacher } = targetCourse || {};
        const original = this.normalizeName(originalTeacher);
        const targetClass = this.normalizeClassName(className);
        const gradeOf = c => { const m = this.normalizeClassName(c).match(/^(\d+)年/); return m ? m[1] : ''; };
        const targetGrade = gradeOf(className);
        const targetSubjects = [targetCourse && targetCourse.subject, targetCourse && targetCourse.rawSubject]
            .map(s => this.normalizeSubject(s)).filter(Boolean);

        const seen = new Set();
        const options = [];
        (scheduleData || []).forEach(course => {
            if (course.weekday !== weekday || course.period !== period) return;
            const teacher = this.normalizeName(course.teacher);
            if (!teacher || teacher === original) return;
            const cls = this.normalizeClassName(course.className);
            if (!cls || cls === targetClass) return;
            const key = `${teacher}|${cls}`;
            if (seen.has(key)) return;
            seen.add(key);
            options.push({
                teacher,
                className: course.className,
                subject: course.subject || course.rawSubject || '',
                sameGrade: !!targetGrade && gradeOf(course.className) === targetGrade,
                sameSubject: [course.subject, course.rawSubject]
                    .map(x => this.normalizeSubject(x)).some(x => x && targetSubjects.includes(x))
            });
        });
        options.sort((a, b) =>
            (Number(b.sameGrade) - Number(a.sameGrade)) ||
            (Number(b.sameSubject) - Number(a.sameSubject)) ||
            a.teacher.localeCompare(b.teacher, 'zh-Hant'));
        return options;
    }

    /**
     * 計算教師推薦分數
     * @param {Object} teacher - 教師資料
     * @param {Object} targetCourse - 目標課程資訊
     * @param {Map} [teachingIndex] - buildTeachingIndex() 的結果；未提供時只看教師資料本身
     * @returns {Object} 分數詳情：{ total, primaryReason, reasonText, reasons }
     */
    calculateScore(teacher, targetCourse, teachingIndex = new Map()) {
        const w = this.weights;
        const teaching = teachingIndex.get(this.normalizeName(teacher.name));
        let total = w.base;
        const reasons = [];
        const texts = [];

        if (this.isSameSubject(teacher, targetCourse, teaching)) {
            total += w.sameSubject;
            reasons.push('same_subject');
            texts.push(`同科目（${targetCourse.subject}）`);
        } else if (this.isSameDomain(teacher, targetCourse.domain)) {
            // 同領域不在五層順序中，只作同層內微調與說明
            total += w.sameDomain;
            reasons.push('same_domain');
            texts.push(`同領域（${teacher.domains.join('、')}）`);
        }

        if (this.isHomeroomTeacher(teacher, targetCourse.className)) {
            total += w.homeroom;
            reasons.push('homeroom');
            texts.push(`該班導師（${teacher.homeroomClass}）`);
        }

        if (teaching && teaching.classes.has(this.normalizeClassName(targetCourse.className))) {
            total += w.sameClass;
            reasons.push('same_class');
            texts.push(`同任課班級（也有教 ${targetCourse.className}）`);
        }

        if (teacher.partTime) {
            total += w.partTime;
            reasons.push('part_time');
            texts.push('兼課教師');
        }

        // 主要推薦理由：依五層順序取第一個符合者（same_domain 不算一層，歸在空堂）
        const primaryReason = ['same_subject', 'homeroom', 'same_class', 'part_time'].find(r => reasons.includes(r))
            || 'free';
        const onlyFree = !reasons.some(r => r !== 'part_time' && r !== 'same_domain');
        const reasonText = onlyFree ? [...texts, '該時段空堂'].join('、') : texts.join('、');

        return {
            total,
            primaryReason,
            reasonText,
            reasons
        };
    }

    /**
     * 檢查教師是否教同科目
     * 判準：課表上該教師也教這一科，或教師「任教領域」欄手動填了這一科（例如「國文」）
     * @param {Object} teacher - 教師資料
     * @param {Object} targetCourse - 目標課程（使用 subject / rawSubject）
     * @param {Object} [teaching] - 該教師的課表索引 { subjects, classes }
     * @returns {boolean}
     */
    isSameSubject(teacher, targetCourse, teaching) {
        const targets = [targetCourse.subject, targetCourse.rawSubject]
            .map(s => this.normalizeSubject(s))
            .filter(Boolean);
        if (targets.length === 0) return false;
        if (teaching && targets.some(t => teaching.subjects.has(t))) return true;
        return (teacher.domains || []).some(d => targets.includes(this.normalizeSubject(d)));
    }

    /**
     * 標準化科目名稱（去空白、統一常見同義寫法）
     * @param {string} subject - 科目名稱
     * @returns {string}
     */
    normalizeSubject(subject) {
        if (!subject) return '';
        const s = String(subject).replace(/\s+/g, '');
        const aliases = { '國語': '國文', '英文': '英語', '美術': '視覺藝術' };
        return aliases[s] || s;
    }

    /**
     * 標準化教師姓名（去除前後空白）
     * @param {string} name - 教師姓名
     * @returns {string}
     */
    normalizeName(name) {
        return name == null ? '' : String(name).trim();
    }

    /**
     * 檢查教師是否為同領域
     * @param {Object} teacher - 教師資料
     * @param {string} targetDomain - 目標領域
     * @returns {boolean}
     */
    isSameDomain(teacher, targetDomain) {
        if (!teacher.domains || teacher.domains.length === 0) {
            return false;
        }

        // 標準化領域名稱進行比對
        const normalizedTarget = this.normalizeDomain(targetDomain);
        return teacher.domains.some(d =>
            this.normalizeDomain(d) === normalizedTarget
        );
    }

    /**
     * 標準化領域名稱
     * @param {string} domain - 領域名稱
     * @returns {string} 標準化後的領域名稱
     */
    normalizeDomain(domain) {
        if (!domain) return '';

        // 移除「領域」後綴
        let normalized = domain.replace(/領域$/, '').trim();

        // 處理常見的領域別名
        const domainAliases = {
            '國語': '語文',
            '國文': '語文',
            '英語': '語文',
            '英文': '語文',
            '本土語': '語文',
            '閩南語': '語文',
            '客語': '語文',
            '原住民語': '語文',
            '數學': '數學',
            '理化': '自然科學',
            '生物': '自然科學',
            '地球科學': '自然科學',
            '地理': '社會',
            '歷史': '社會',
            '公民': '社會',
            '音樂': '藝術',
            '視覺藝術': '藝術',
            '美術': '藝術',
            '表演藝術': '藝術',
            '體育': '健康與體育',
            '健康教育': '健康與體育',
            '健康': '健康與體育',
            '家政': '綜合活動',
            '童軍': '綜合活動',
            '輔導': '綜合活動',
            '資訊': '科技',
            '資訊科技': '科技',
            '生活科技': '科技'
        };

        // 嘗試比對別名
        for (const [alias, standard] of Object.entries(domainAliases)) {
            if (normalized.includes(alias)) {
                return standard;
            }
        }

        return normalized;
    }

    /**
     * 檢查教師是否為該班導師
     * @param {Object} teacher - 教師資料
     * @param {string} className - 班級名稱
     * @returns {boolean}
     */
    isHomeroomTeacher(teacher, className) {
        if (!teacher.homeroomClass) {
            return false;
        }

        // 標準化班級名稱進行比對
        return this.normalizeClassName(teacher.homeroomClass) ===
            this.normalizeClassName(className);
    }

    /**
     * 標準化班級名稱
     * @param {string} className - 班級名稱
     * @returns {string} 標準化後的班級名稱
     */
    normalizeClassName(className) {
        if (!className) return '';

        // 移除空白並標準化格式
        let normalized = className.replace(/\s+/g, '');

        // 處理常見格式變化：701 -> 7年1班, 七年一班 -> 7年1班
        const numberMatch = normalized.match(/^(\d)(\d{2})$/);
        if (numberMatch) {
            // 格式如 701
            return `${numberMatch[1]}年${parseInt(numberMatch[2])}班`;
        }

        // 處理中文數字
        const chineseNumbers = {
            '一': '1', '二': '2', '三': '3', '四': '4', '五': '5',
            '六': '6', '七': '7', '八': '8', '九': '9', '十': '10'
        };

        for (const [cn, num] of Object.entries(chineseNumbers)) {
            normalized = normalized.replace(new RegExp(cn, 'g'), num);
        }

        return normalized;
    }

    /**
     * 更新評分權重
     * @param {Object} newWeights - 新的權重設定
     */
    setWeights(newWeights) {
        this.weights = { ...this.weights, ...newWeights };
    }
}
