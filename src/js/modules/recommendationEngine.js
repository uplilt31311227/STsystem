/**
 * 智慧推薦引擎模組
 *
 * 代課教師推薦邏輯：
 * 1. 首先篩選出該時段有空堂的教師
 * 2. 依照以下優先順序排序：
 *    - 優先度 1：同領域教師（例如：數學課優先找數學領域老師）
 *    - 優先度 2：該班級導師
 *    - 優先度 3：其他空堂教師
 *
 * 演算法思維：
 * 1. 取得目標課程的資訊（班級、節次、領域）
 * 2. 從課表中找出該時段有課的教師（busy teachers）
 * 3. 從全部教師中排除 busy teachers 和原任課教師，得到空堂教師
 * 4. 對空堂教師進行評分：
 *    - 同領域：+100 分
 *    - 班導師：+50 分
 *    - 基礎分：10 分
 * 5. 依分數降序排列
 */

export class RecommendationEngine {
    constructor() {
        // 評分權重設定
        this.weights = {
            sameDomain: 100,   // 同領域教師權重
            homeroom: 50,      // 班導師權重
            base: 10           // 基礎分數（空堂）
        };
    }

    /**
     * 取得推薦代課教師列表
     * @param {Object} targetCourse - 目標課程資訊
     * @param {Array} scheduleData - 全部課表資料
     * @param {Array} teachers - 全部教師資料
     * @param {string} date - 調課日期（用於判斷星期）
     * @param {Array} [substituteRecords=[]] - 已存在的調代課紀錄（用於排除已被指派的教師）
     * @returns {Array} 推薦教師列表（已排序）
     */
    getRecommendations(targetCourse, scheduleData, teachers, date, substituteRecords = []) {
        const { weekday, period, className, domain, originalTeacher } = targetCourse;

        console.log('===== 智慧推薦引擎開始運算 =====');
        console.log('目標課程:', { weekday, period, className, domain, originalTeacher });

        // 步驟 1：找出該時段有原課的教師
        const scheduledBusy = this.getBusyTeachers(scheduleData, weekday, period);

        // 步驟 1.5：找出該日該節已被指派為代課/調課的教師（避免重複指派造成衝堂）
        const assignedBusy = this.getAssignedTeachers(substituteRecords, date, period);

        const busyTeachers = [...new Set([...scheduledBusy, ...assignedBusy])];
        console.log('有課教師（含已派代/調課）:', busyTeachers);

        // 步驟 2：篩選出空堂教師（排除有課者和原任課教師）
        const freeTeachers = teachers.filter(teacher =>
            !busyTeachers.includes(teacher.name) &&
            teacher.name !== originalTeacher
        );
        console.log('空堂教師:', freeTeachers.map(t => t.name));

        // 步驟 3：計算每位空堂教師的推薦分數
        const scoredTeachers = freeTeachers.map(teacher => {
            const score = this.calculateScore(teacher, targetCourse);
            return {
                teacher,
                score: score.total,
                reason: score.primaryReason,
                reasonText: score.reasonText
            };
        });

        // 步驟 4：依分數降序排列
        scoredTeachers.sort((a, b) => b.score - a.score);

        console.log('推薦結果:', scoredTeachers.map(r =>
            `${r.teacher.name}: ${r.score}分 (${r.reasonText})`
        ));
        console.log('===== 推薦引擎運算完成 =====');

        return scoredTeachers;
    }

    /**
     * 取得指定時段有課的教師清單
     * @param {Array} scheduleData - 課表資料
     * @param {string} weekday - 星期
     * @param {string} period - 節次
     * @returns {Array} 有課的教師姓名清單
     */
    getBusyTeachers(scheduleData, weekday, period) {
        return scheduleData
            .filter(course => course.weekday === weekday && course.period === period)
            .map(course => course.teacher);
    }

    /**
     * 取得指定日期+節次已被指派為代課/調課的教師清單
     *
     * Why: 推薦引擎原本只看原始課表的空堂狀態，
     * 但同一日同一節該教師可能已被指派代別人的課（substituteRecord 已存在），
     * 再次推薦會造成同時段重複指派、實際代課當下兩堂課衝堂。
     *
     * @param {Array} substituteRecords - 已存在的調代課紀錄
     * @param {string} date - 目標日期 (YYYY-MM-DD)
     * @param {string} period - 目標節次
     * @returns {Array} 該日該節已被指派的教師姓名清單（substituteTeacher / swapTeacher）
     */
    getAssignedTeachers(substituteRecords, date, period) {
        if (!substituteRecords || substituteRecords.length === 0 || !date || !period) {
            return [];
        }
        const names = [];
        substituteRecords.forEach(r => {
            if (r.date !== date || r.period !== period) return;
            if (r.substituteTeacher) names.push(r.substituteTeacher);
            if (r.swapTeacher) names.push(r.swapTeacher);
        });
        return [...new Set(names)];
    }

    /**
     * 計算教師推薦分數
     * @param {Object} teacher - 教師資料
     * @param {Object} targetCourse - 目標課程資訊
     * @returns {Object} 分數詳情
     */
    calculateScore(teacher, targetCourse) {
        let total = this.weights.base;
        let primaryReason = 'free';
        let reasonText = '該時段空堂';
        const reasons = [];

        // 檢查是否為同領域教師
        if (this.isSameDomain(teacher, targetCourse.domain)) {
            total += this.weights.sameDomain;
            reasons.push('same_domain');
        }

        // 檢查是否為該班導師
        if (this.isHomeroomTeacher(teacher, targetCourse.className)) {
            total += this.weights.homeroom;
            reasons.push('homeroom');
        }

        // 決定主要推薦理由
        if (reasons.includes('same_domain') && reasons.includes('homeroom')) {
            primaryReason = 'same_domain';
            reasonText = `同領域教師（${teacher.domains.join('、')}）且為該班導師`;
        } else if (reasons.includes('same_domain')) {
            primaryReason = 'same_domain';
            reasonText = `同領域教師（${teacher.domains.join('、')}）`;
        } else if (reasons.includes('homeroom')) {
            primaryReason = 'homeroom';
            reasonText = `該班導師（${teacher.homeroomClass}）`;
        }

        return {
            total,
            primaryReason,
            reasonText,
            reasons
        };
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
     * 進階推薦：考慮教師近期代課頻率
     * （避免同一位教師被過度推薦）
     * @param {Array} recommendations - 初步推薦列表
     * @param {Array} recentRecords - 近期調課紀錄
     * @param {number} days - 考慮的天數
     * @returns {Array} 調整後的推薦列表
     */
    adjustForFrequency(recommendations, recentRecords, days = 7) {
        // 計算每位教師近期代課次數
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);

        const frequencyMap = new Map();
        recentRecords.forEach(record => {
            const recordDate = new Date(record.date);
            if (recordDate >= cutoffDate) {
                const count = frequencyMap.get(record.substituteTeacher) || 0;
                frequencyMap.set(record.substituteTeacher, count + 1);
            }
        });

        // 根據頻率調整分數（代課越多，分數略微降低）
        return recommendations.map(rec => {
            const frequency = frequencyMap.get(rec.teacher.name) || 0;
            const adjustedScore = rec.score - (frequency * 5); // 每次代課扣 5 分
            return {
                ...rec,
                score: adjustedScore,
                frequency,
                reasonText: frequency > 0
                    ? `${rec.reasonText}（近 ${days} 天已代課 ${frequency} 次）`
                    : rec.reasonText
            };
        }).sort((a, b) => b.score - a.score);
    }

    /**
     * 更新評分權重
     * @param {Object} newWeights - 新的權重設定
     */
    setWeights(newWeights) {
        this.weights = { ...this.weights, ...newWeights };
    }
}
