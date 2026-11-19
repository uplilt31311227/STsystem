/**
 * 月結算計算模組
 *
 * 負責計算教師每月的實際授課時數
 *
 * 計算邏輯（含假別區分）：
 * 1. 原定授課時數 = 該教師在課表中的每週授課節數 × 當月上課週數
 * 2. 代課增加時數 = 該月該教師為他人代課的總節數（不論假別皆 +1）
 * 3. 被代課減少時數 = 該月他人為該教師代課的總節數
 *    【公付假別 - 不扣時數（學校支付公費）】
 *    - 公假 (official)
 *    - 長期病假 (longsick)：3日以上
 *    - 喪假 (funeral)
 *    【一般假別 - 扣時數 (-1)】
 *    - 事假/病假/休假/其他
 *    【調課 - 不扣時數（互換）】
 *    - 調課 (swap)
 * 4. 實際授課時數 = max(0, 原定時數 + 代課增加 - 被代課減少)
 *    下限 0：寒暑假（7、8 月預設 0 週，或使用者覆寫為 0 週）若仍有代課紀錄，被代者的
 *    原定時數是 0，直接相減會出現負數。實際授課時數不可能為負，故以 0 為下限；
 *    「被代課減少」欄仍照實計數（不被下限吞掉），明細才能對帳。
 *    因此該列會出現「原定 + 增加 − 減少 ≠ 實際」，Excel 彙總表尾會加註記說明。
 * 5. 超鐘點時數 = max(0, 實際授課時數 - 基本授課時數×週數)
 *    週數為 0 時基本時數也是 0，代課者的代課節數全部算超鐘點（寒暑假代課都是額外）。
 *
 * 紀錄成立防線（isEffectiveRecord，篩月時一律套用，彙總與明細共用）：
 * - 沒有 status 欄位（V1 本機紀錄）視為已成立。
 * - 有 status 時只有 'approved' 算成立（pending / pending_swap_consent / pending_approval /
 *   rejected 與未知值一律排除；schemaConstants.REQUEST_STATUS 中只有 APPROVED 代表已成立）。
 * - deleted 或 isDeleted 為真者排除（目前專案資料層尚無此欄位，屬預防性防線）。
 */

import { noDeductCodesAndLabels, LEAVE_TYPES } from './leaveTypes.js';
import { periodIndex } from './periods.js';

/** 姓名比對用正規化（與 v2/teacherIdentity.normalizeTeacherName 相同規則：全形空白轉半形、去前後空白）。 */
function normName(name) {
    return String(name == null ? '' : name).replace(/\u3000/g, ' ').trim();
}

/** 同一節次的隔週列以班級去重：完全重複（同班同節）只算 1 列，不同班輪替才各算 0.5。 */
function slotUnits(v) {
    return v.weekly ? 1 : Math.min(1, 0.5 * v.half.size);
}
function courseClass(course) {
    return String((course && course.className) == null ? '' : course.className).trim();
}

/** 課表列的每週權重：每週上課 1；上課頻率為隔週（2）算 0.5。 */
function rowWeight(course) {
    const f = course && (course.frequency ?? course.biweekly);
    if (f === true || f === 2 || f === '2') return 0.5;
    return 1;
}

/**
 * 把一列課表記入「星期＋節次」槽位表（getTeacherWeeklyHours 與 calculate 的每段每週節數共用）：
 * 依 星期＋節次 去重（完全重複列、合班只算 1 節）；隔週課（rowWeight 0.5）以班級去重，不同班輪替才各算 0.5。
 */
function addCourseToSlots(slotMap, course) {
    const slot = `${course.weekday}|${course.period}`;
    const cur = slotMap.get(slot) || { weekly: false, half: new Set() };
    if (rowWeight(course) === 1) cur.weekly = true; else cur.half.add(courseClass(course));
    slotMap.set(slot, cur);
}

/** 槽位表的每週節數合計。 */
function totalSlotUnits(slotMap) {
    let total = 0;
    for (const v of slotMap.values()) total += slotUnits(v);
    return total;
}

/**
 * 逐人基本節數的文字格式（設定頁的文字框）：每行「姓名,每週節數」。
 * @returns {{map:Object<string,number>, errors:string[]}}
 */
export function parseBaseMapText(text) {
    const map = {};
    const errors = [];
    String(text || '').split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();
        if (!t) return;
        const m = /^(.+?)\s*[,，、\t]\s*(\d+(?:\.\d+)?)$/.exec(t);
        if (!m) { errors.push(`第 ${i + 1} 行「${t.slice(0, 20)}」`); return; }
        const n = Number(m[2]);
        const name = normName(m[1]);
        if (!name || !Number.isFinite(n) || n < 0 || n > 40) { errors.push(`第 ${i + 1} 行「${t.slice(0, 20)}」`); return; }
        map[name] = n;
    });
    return { map, errors };
}

export function formatBaseMapText(map) {
    return Object.entries(map || {}).map(([k, v]) => `${k},${v}`).join('\n');
}

export class SettlementCalculator {
    constructor() {
        // 每週基本授課時數（可依學校規定調整）
        this.baseWeeklyHours = 20;

        // 每月預設上課週數
        this.defaultWeeksPerMonth = 4;

        // 每月上課週數覆寫：{ "115": { "8": 1, "9": 4 } }（學年度 → 月份 → 週數）。
        // 有值的月份用覆寫，沒有的月份沿用 getWeeksInMonth() 內的寫死預設（向後相容）。
        this.weeksOverride = {};

        // 不扣時數的假別（公付假別由學校支付，調課為互換）
        // 支援中文和英文代碼
        // 清單由 leaveTypes.js 的對照表產生（唯一定義處）
        this.noDeductLeaveTypes = noDeductCodesAndLabels();
    }

    /**
     * 計算月結算資料
     * @param {number} year - 學年度
     * @param {number} month - 月份
     * @param {Array} scheduleData - 課表資料
     * @param {Array} substituteRecords - 調代課紀錄
     * @param {Array} teachers - 教師資料
     * @returns {Array} 結算資料陣列
     */
    calculate(year, month, scheduleData, substituteRecords, teachers, opts = {}) {
        const weeksInMonth = this.getWeeksInMonth(year, month);
        const monthlyRecords = this.filterMonthlyRecords(substituteRecords, year, month);

        // 分段：每段各自帶課表、名冊、週數（跨學期的月份用各自學期的資料）。未指定則整月一段。
        const segments = Array.isArray(opts.segments) && opts.segments.length
            ? opts.segments
            : [{ schedule: scheduleData, teachers, weeks: weeksInMonth }];
        for (const seg of segments) {
            if (!Array.isArray(seg.schedule) || !Array.isArray(seg.teachers)) {
                throw Object.assign(new Error(`找不到${seg.semesterId ? ' ' + seg.semesterId + ' 學期' : '該月所屬學期'}的課表或名冊`),
                    { name: 'SettlementScheduleMissing', semesterId: seg.semesterId || null });
            }
        }
        // 課表明顯殘缺（課表上的教師數不到名冊一半）：只警示，不中止、不改數字
        const sparseWarnings = [];
        for (const seg of segments) {
            const rosterN = new Set(seg.teachers.map(t => normName(t && t.name)).filter(Boolean)).size;
            const schedN = new Set(seg.schedule.map(c => normName(c && c.teacher)).filter(Boolean)).size;
            if (rosterN > 0 && schedN * 2 < rosterN) {
                sparseWarnings.push(`${seg.semesterId ? seg.semesterId + ' ' : ''}該學期課表的教師數明顯少於名冊，原定時數可能不完整，請確認課表（課表 ${schedN} 位、名冊 ${rosterN} 位）`);
            }
        }
        const segWeeks = seg => (Number.isFinite(seg.weeks) ? seg.weeks : weeksInMonth);
        const totalWeeks = segments.reduce((n, seg) => n + segWeeks(seg), 0);

        // ---- 人員集合：名冊 ∪ 課表出現者 ∪ 紀錄出現者；有 teacherId 以 id 為主鍵，否則以正規化姓名 ----
        const people = new Map();      // key → { key, name, teacherId, inRoster, ambiguous }
        const warnings = [...sparseWarnings];
        const order = [];
        const addPerson = (key, name, teacherId, inRoster) => {
            let p = people.get(key);
            if (!p) {
                p = { key, name, teacherId: teacherId || null, inRoster: !!inRoster, ambiguous: false };
                people.set(key, p);
                order.push(key);
            } else if (inRoster) p.inRoster = true;
            return p;
        };
        const nameIndex = new Map();   // 正規化姓名 → [key]（跨段合併的名冊）
        const segIndex = [];           // 每段：正規化姓名 → [key]
        for (const seg of segments) {
            const idx = new Map();
            for (const t of seg.teachers) {
                const n = normName(t && t.name);
                if (!n) continue;
                const id = t.teacherId || null;
                let key = id ? 'id:' + id : 'n:' + n;
                if (!id) {
                    // 沒有 id 的名冊列，若同名已有帶 id 的列就視為同一人（不重複）
                    const withId = (idx.get(n) || []).find(k => k.startsWith('id:'));
                    if (withId) key = withId;
                }
                addPerson(key, t.name, id, true);
                const list = idx.get(n) || [];
                if (!list.includes(key)) list.push(key);
                idx.set(n, list);
                const g = nameIndex.get(n) || [];
                if (!g.includes(key)) g.push(key);
                nameIndex.set(n, g);
            }
            segIndex.push(idx);
        }
        for (const [n, keys] of nameIndex) {
            if (keys.length > 1) {
                keys.forEach(k => { people.get(k).ambiguous = true; });
                warnings.push(`名冊內有 ${keys.length} 位同名教師「${n}」：課表只記姓名，無法依人區分節數，兩人都暫以課表上該姓名的節數計，請人工確認；代課紀錄依 teacherId 分開計算`);
            }
        }

        // 每個姓名已知的不同 teacherId（名冊 ∪ 本月紀錄兩側）。兩個以上＝同名兩位以上；
        // 此時沒有 teacherId 的同名紀錄無法判斷是哪一位，不歸給任何人（與紀錄出現順序無關，故先全部掃一遍）。
        const idsByName = new Map();
        const noteId = (name, id) => {
            const n = normName(name);
            if (!n || !id) return;
            if (!idsByName.has(n)) idsByName.set(n, new Set());
            idsByName.get(n).add(String(id));
        };
        for (const seg of segments) for (const t of seg.teachers) noteId(t && t.name, t && t.teacherId);
        for (const r of monthlyRecords) {
            noteId(r.originalTeacher, r.originalTeacherId);
            noteId(r.substituteTeacher, r.substituteTeacherId);
        }

        // 紀錄一側的人 → key
        const resolveRecordSide = (name, id) => {
            const n = normName(name);
            if (id) {
                const key = 'id:' + id;
                if (aliasId.has(key)) return aliasId.get(key);
                if (people.has(key)) return key;
                // 名冊（來自課表）只有姓名沒有 teacherId：同名只有一位時，第一個遇到的 id 綁到該名冊人員上
                const nk = 'n:' + n;
                const base = n ? people.get(nk) : null;
                if (base && base.inRoster && !base.teacherId) {
                    base.teacherId = id;
                    aliasId.set(key, nk);
                    return nk;
                }
                const sameNameInRoster = !!base && base.inRoster;
                const p = addPerson(key, n || String(id), id, sameNameInRoster);
                if (sameNameInRoster && (nameIndex.get(n) || []).length === 1) {
                    // 名冊只有一筆、紀錄卻出現第二個 teacherId：可能是同一位教師重新建檔。
                    // 課表節數（原定時數）只留在名冊那一筆，這一列不掛課表，避免原定時數與超鐘點重複計算；警示在紀錄歸人後統一加。
                } else if (sameNameInRoster) {
                    // 名冊有兩位以上同名：課表節數無法區分，兩人都暫用該姓名的節數
                    base.ambiguous = true;
                    p.ambiguous = true;
                    segIndex.forEach(idx => { const l = idx.get(n); if (l && l.includes(nk) && !l.includes(key)) l.push(key); });
                    warnings.push(`「${n}」在紀錄中對應到不同的 teacherId（同名兩位教師）：課表只記姓名，兩人都暫以課表上該姓名的節數計，請人工確認；代課紀錄已依 teacherId 分開計算`);
                }
                return key;
            }
            if (!n) return null;
            const cands = nameIndex.get(n) || [];
            const multiIds = (idsByName.get(n) || new Set()).size >= 2;
            if (cands.length === 1 && !multiIds) return cands[0];
            if (cands.length > 1 || (cands.length === 1 && multiIds)) {
                const key = 'amb:' + n;
                const p = addPerson(key, n, null, false);
                p.ambiguous = true;
                p.unresolved = true;
                return key;
            }
            return addPerson('n:' + n, n, null, false).key;
        };

        // ---- 紀錄歸人 ----
        const aliasId = new Map();
        const subCount = new Map();
        const subdCount = new Map();
        const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };
        for (const r of monthlyRecords) {
            const isSwap = r.type === 'swap' || r.type === '調課';
            const subKey = resolveRecordSide(r.substituteTeacher, r.substituteTeacherId);
            const origKey = resolveRecordSide(r.originalTeacher, r.originalTeacherId);
            if (!isSwap) bump(subCount, subKey);
            if (this.isDeductedFromOriginal(r)) bump(subdCount, origKey);
        }

        // 名冊只有一筆、紀錄中卻有兩個以上 teacherId 的姓名：課表節數只掛在名冊那一筆（nameIndex 第一個 key），
        // 其餘列原定時數為 0；全部列標示並警示一次（名冊有兩筆以上同名者維持原行為，不在此處理）。
        for (const [n, ids] of idsByName) {
            const rosterKeys = nameIndex.get(n) || [];
            if (ids.size < 2 || rosterKeys.length !== 1) continue;
            for (const p of people.values()) {
                if (normName(p.name) === n) p.multiId = true;
            }
            people.get(rosterKeys[0]).scheduleHolder = true;
            warnings.push(`「${n}」在本月紀錄中有多個教師編號，可能是同一位教師重新建檔。原定時數只計入其中一列，請確認並合併後再發放。`);
        }

        // ---- 每段每週節數（依 星期＋節次 去重；隔週課算 0.5）----
        const classesByKey = new Map();   // key → 任教班級（供 Excel 備註辨識同名教師）
        const weeklyBySeg = segments.map((seg, i) => {
            const idx = segIndex[i];
            const slots = new Map();   // key → Map(slot → { weekly, half:Set(班級) })
            for (const course of seg.schedule) {
                const n = normName(course && course.teacher);
                if (!n) continue;
                const keys = (idx.get(n) && idx.get(n).length) ? idx.get(n) : [addPerson('n:' + n, course.teacher, null, false).key];
                for (const key of keys) {
                    if (!slots.has(key)) slots.set(key, new Map());
                    addCourseToSlots(slots.get(key), course);
                    const cn = courseClass(course);
                    if (cn) {
                        if (!classesByKey.has(key)) classesByKey.set(key, new Set());
                        classesByKey.get(key).add(cn);
                    }
                }
            }
            const out = new Map();
            for (const [key, m] of slots) out.set(key, totalSlotUnits(m));
            return out;
        });

        const baseOf = (p) => {
            const map = opts.weeklyBaseByTeacher || {};
            let v = p.teacherId ? map[p.teacherId] : undefined;
            if (v === undefined || v === null || v === '') v = map[p.name];
            if (v === undefined || v === null || v === '') v = map[normName(p.name)];
            const n = Number(v);
            return (v === undefined || v === null || v === '' || !Number.isFinite(n) || n < 0) ? this.baseWeeklyHours : n;
        };

        const rows = order.map(key => {
            const p = people.get(key);
            let originalHours = 0;
            let weeklyHours = 0;
            let topWeeks = -1;
            segments.forEach((seg, i) => {
                const w = weeklyBySeg[i].get(key) || 0;
                const wk = segWeeks(seg);
                originalHours += w * wk;
                if (wk > topWeeks) { topWeeks = wk; weeklyHours = w; }
            });
            const substituteHours = subCount.get(key) || 0;
            const substitutedHours = subdCount.get(key) || 0;
            const actualHours = Math.max(0, originalHours + substituteHours - substitutedHours);
            const baseWeekly = baseOf(p);
            const baseMonthlyHours = baseWeekly * totalWeeks;
            const overtimeHours = Math.max(0, actualHours - baseMonthlyHours);
            const row = {
                teacherName: p.name,
                weeklyHours,
                originalHours,
                substituteHours,
                substitutedHours,
                actualHours,
                overtimeHours,
                baseMonthlyHours
            };
            if (!p.inRoster) {
                row.notInRoster = true;
                // 「無法判斷是哪一位」那列的人其實在名冊內，只有另有警示，不再說他不在名冊
                if ((substituteHours || substitutedHours) && !p.unresolved) {
                    warnings.push(`「${p.name}」不在名冊內，但當月有代課或被代課紀錄，已列入結算`);
                }
            }
            if (p.unresolved) {
                warnings.push(`紀錄中的「${p.name}」有同名教師且紀錄沒有 teacherId，無法判斷是哪一位，已另列一行，請人工確認`);
            }
            if (p.ambiguous) row.ambiguousName = true;
            if (p.unresolved) row.unresolved = true;
            if (p.multiId && !p.unresolved) { row.multiId = true; if (p.scheduleHolder) row.scheduleHolder = true; }
            // 供 Excel 備註辨識：只有特殊列（名冊外、同名、無法判斷）才帶，一般列欄位維持不變
            if (!p.inRoster || p.ambiguous || row.multiId) {
                row.teacherId = p.teacherId || null;
                row.classNames = [...(classesByKey.get(key) || [])].sort();
            }
            if (baseWeekly !== this.baseWeeklyHours) row.baseWeeklyHours = baseWeekly;
            return row;
        });
        // 教師集合＝名冊 ∪ 課表 ∪ 紀錄（P7 規格）：名冊外但有課或有紀錄的人一律列入，不可從結算表消失。
        const settlementData = rows;
        settlementData.sort((a, b) => b.actualHours - a.actualHours);
        Object.defineProperty(settlementData, 'warnings', { value: warnings, enumerable: false });
        return settlementData;
    }

    /**
     * 設定某學年度的每月上課週數覆寫（整份取代該學年度的舊覆寫）。
     * 只接受 0–6 的整數，其餘（空、NaN、超出範圍）視為未設定，該月沿用預設。
     * @param {number|string} year - 學年度（民國）
     * @param {Object} map - { 月份: 週數 }
     */
    setWeeksOverride(year, map) {
        const clean = {};
        for (const [m, v] of Object.entries(map || {})) {
            const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : v;
            if (Number.isInteger(n) && n >= 0 && n <= 6) clean[String(Number(m))] = n;
        }
        if (Object.keys(clean).length) this.weeksOverride[String(year)] = clean;
        else delete this.weeksOverride[String(year)];
    }

    /**
     * 取得該月的上課週數
     * @param {number} year - 年份
     * @param {number} month - 月份
     * @returns {number} 上課週數
     */
    getWeeksInMonth(year, month) {
        const override = this.weeksOverride[String(year)];
        const key = String(Number(month));
        if (override && Object.prototype.hasOwnProperty.call(override, key)) {
            return override[key];
        }

        // 這裡使用簡化的計算方式
        // 實際應用中可以根據學校行事曆調整

        // 特殊月份處理
        const specialMonths = {
            1: 2,   // 1 月（寒假）
            2: 3,   // 2 月（寒假）
            7: 0,   // 7 月（暑假）
            8: 0,   // 8 月（暑假）
        };

        if (Object.prototype.hasOwnProperty.call(specialMonths, Number(month))) {
            return specialMonths[Number(month)];
        }

        return this.defaultWeeksPerMonth;
    }

    /**
     * 篩選該月份的調代課紀錄
     * @param {Array} records - 全部紀錄
     * @param {number} year - 年份
     * @param {number} month - 月份
     * @returns {Array} 該月份的紀錄
     */
    filterMonthlyRecords(records, year, month) {
        const { prefix } = this._resolveMonth(year, month);
        return records.filter(record =>
            this.isEffectiveRecord(record) && record.date && record.date.startsWith(prefix));
    }

    /**
     * 紀錄是否「已成立」可計入結算（calculate 與 getMonthlyDetailRows 都經 filterMonthlyRecords
     * 走到這裡，所以彙總與明細口徑一致）。
     * - deleted／isDeleted 為真：排除
     * - 沒有 status（undefined／null／空字串，V1 本機紀錄）：視為已成立
     * - 有 status：只有 'approved' 成立，其餘（含 rejected、pending_*、legacy pending、未知值）排除
     * @param {Object} record
     * @returns {boolean}
     */
    isEffectiveRecord(record) {
        if (!record || record.deleted || record.isDeleted) return false;
        const status = record.status;
        if (status === undefined || status === null || status === '') return true;
        return status === 'approved';
    }

    /**
     * 依民國學年度＋月份換算西元年月（抽出自 filterMonthlyRecords，供 getMonthDateRange 共用）。
     * @returns {{ actualYear: number, monthStr: string, prefix: string }}
     */
    _resolveMonth(year, month) {
        // 將學年度轉換為西元年
        // 台灣學年度：114 學年度 = 2025/8 ~ 2026/7
        const westernYear = parseInt(year) + 1911;

        // 根據學年度和月份計算實際年份
        // 1-7 月屬於學年度 +1 的年份
        // 8-12 月屬於學年度的年份
        const actualYear = month >= 8 ? westernYear : westernYear + 1;
        const monthStr = String(month).padStart(2, '0');

        return { actualYear, monthStr, prefix: `${actualYear}-${monthStr}` };
    }

    /**
     * Stage 1（讀取成本止血，RESEARCH-multitenancy-semester.md §5.6）：把「學年度＋月份」換算
     * 成 Firestore range query 可用的日期字串範圍，供呼叫端在資料來源改為即時訂閱＋按需查詢
     * （不再是全量本地陣列）時，把日期範圍下推到查詢層，而不是抓全部歷史紀錄回來再用
     * filterMonthlyRecords() 篩。
     *
     * endDate 固定用 `-31`：字典序範圍查詢只需要「夠大」的上界，不需要真的存在的日期
     * （例如 2 月查到 `-31` 不影響結果，Firestore 是純字串比較，不會驗證日期合法性）；
     * calculate() 內部仍會呼叫 filterMonthlyRecords() 對查回來的資料做一次精確的 startsWith
     * 比對，所以就算 range query 抓寬一點也不影響最終計算結果的正確性。
     * @returns {{ startDate: string, endDate: string }}
     */
    getMonthDateRange(year, month) {
        const { prefix } = this._resolveMonth(year, month);
        return { startDate: `${prefix}-01`, endDate: `${prefix}-31` };
    }

    /**
     * 計算教師每週授課節數
     * @param {Array} scheduleData - 課表資料
     * @param {string} teacherName - 教師姓名
     * @returns {number} 每週授課節數
     */
    getTeacherWeeklyHours(scheduleData, teacherName) {
        // 依 星期＋節次 去重（完全重複列、合班只算 1 節）；隔週課（frequency 為 2）算 0.5
        const n = normName(teacherName);
        const slots = new Map();
        for (const course of scheduleData) {
            if (normName(course.teacher) !== n) continue;
            addCourseToSlots(slots, course);
        }
        return totalSlotUnits(slots);
    }

    /**
     * 計算代課增加時數
     * 所有代課（不論假別）皆增加時數 +1
     * 調課互換不增加時數（因為是交換，不是額外代課）
     * @param {Array} records - 該月調課紀錄
     * @param {string} teacherName - 教師姓名
     * @returns {number} 代課節數
     */
    countSubstituteHours(records, teacherName) {
        return records.filter(record =>
            record.substituteTeacher === teacherName &&
            record.type !== 'swap' && record.type !== '調課'  // 調課互換不計入代課增加
        ).length;
    }

    /**
     * 計算被代課減少時數
     * 根據假別區分：
     * - 公假 (official)：不扣時數（學校支付公費）
     * - 調課 (swap)：不扣時數（互換）
     * - 事假/病假/休假/其他：扣時數 (-1)
     * @param {Array} records - 該月調課紀錄
     * @param {string} teacherName - 教師姓名
     * @returns {number} 被代課節數
     */
    countSubstitutedHours(records, teacherName) {
        return records.filter(record =>
            record.originalTeacher === teacherName && this.isDeductedFromOriginal(record)
        ).length;
    }

    /**
     * 這筆紀錄是否要扣原任課教師的時數（countSubstitutedHours 與明細表共用的唯一判斷，確保同一口徑）
     * - 調課（type 為 swap／調課）：不扣
     * - 假別在 noDeductLeaveTypes（公假／長期病假／喪假…）：不扣
     * - 其他（事假／病假／休假／其他／缺假別）：扣
     * @param {Object} record - 單筆調代課紀錄
     * @returns {boolean}
     */
    isDeductedFromOriginal(record) {
        // 調課不扣時數（檢查 type 欄位，支援中英文）
        if (record.type === 'swap' || record.type === '調課') {
            return false;
        }

        // 公假和調課不扣時數（檢查 leaveType 欄位）
        const leaveType = record.leaveType || '';
        if (this.noDeductLeaveTypes.includes(leaveType)) {
            return false;
        }

        // 其他假別扣時數
        return true;
    }

    /**
     * 取得詳細的結算明細（含假別分類）
     * @param {Array} records - 該月調課紀錄
     * @param {string} teacherName - 教師姓名
     * @returns {Object} 分類統計
     */
    getDetailedSettlement(records, teacherName) {
        // 與彙總共用成立防線：排除非核准／刪除旗標紀錄（呼叫端即使傳入未過濾陣列也不會誤算）
        records = (records || []).filter(r => this.isEffectiveRecord(r));
        const asSubstitute = records.filter(r => r.substituteTeacher === teacherName);
        const asOriginal = records.filter(r => r.originalTeacher === teacherName);

        // 代課統計（排除調課，支援中英文）
        const substituteCount = asSubstitute.filter(r =>
            r.type !== 'swap' && r.type !== '調課'
        ).length;
        const swapAsSubCount = asSubstitute.filter(r =>
            r.type === 'swap' || r.type === '調課'
        ).length;

        // 被代課統計（按假別分類，支援中英文代碼）
        const substitutedByLeaveType = {
            official: asOriginal.filter(r => r.leaveType === 'official' || r.leaveType === '公假').length,
            longsick: asOriginal.filter(r => r.leaveType === 'longsick' || r.leaveType === '長期病假').length,
            funeral: asOriginal.filter(r => r.leaveType === 'funeral' || r.leaveType === '喪假').length,
            personal: asOriginal.filter(r => r.leaveType === 'personal' || r.leaveType === '事假').length,
            sick: asOriginal.filter(r => r.leaveType === 'sick' || r.leaveType === '病假').length,
            rest: asOriginal.filter(r => r.leaveType === 'rest' || r.leaveType === '休假').length,
            other: asOriginal.filter(r => r.leaveType === 'other' || r.leaveType === '其他').length,
            swap: asOriginal.filter(r => r.type === 'swap' || r.type === '調課').length
        };

        // 新增假別（婚假、產假…）另外計數，不放進 substitutedByLeaveType（維持該物件的既有欄位）
        const newTypeCount = t => asOriginal.filter(r => r.leaveType === t.code || r.leaveType === t.label).length;
        // 實際扣減時數（排除公付假別和調課）
        const deductedHours = substitutedByLeaveType.personal +
                              substitutedByLeaveType.sick +
                              substitutedByLeaveType.rest +
                              substitutedByLeaveType.other +
                              LEAVE_TYPES.filter(t => t.isNew && t.deduct).reduce((n, t) => n + newTypeCount(t), 0);

        // 公付假別總次數（不扣時數）
        const paidLeaveCount = substitutedByLeaveType.official +
                               substitutedByLeaveType.longsick +
                               substitutedByLeaveType.funeral +
                               LEAVE_TYPES.filter(t => t.isNew && !t.deduct).reduce((n, t) => n + newTypeCount(t), 0);

        return {
            teacherName,
            substituteCount,        // 代課增加（不含調課）
            swapCount: swapAsSubCount + substitutedByLeaveType.swap,  // 調課次數
            substitutedByLeaveType, // 被代課（按假別）
            deductedHours,          // 實際扣減時數
            paidLeaveCount,         // 公付假別總次數（不扣）
            officialLeaveCount: substitutedByLeaveType.official  // 公假次數（保留相容性）
        };
    }

    /**
     * 匯出結算表為 Excel
     * @param {Array} settlementData - 結算資料
     * @param {number} year - 學年度
     * @param {number} month - 月份
     */
    exportToExcel(settlementData, year, month, records = []) {
        const wb = this.buildWorkbook(settlementData, year, month, records);

        // 下載檔案
        const fileName = `授課時數結算表_${year}學年度_${month}月.xlsx`;
        XLSX.writeFile(wb, fileName);
    }

    /**
     * 建立結算表工作簿（兩個分頁：「結算表」彙總、「明細」逐節）。
     * 與下載動作分開，方便單元測試；XLSX 預設取全域（瀏覽器 CDN），測試時可注入 node 版。
     * @param {Array} settlementData - calculate() 的結果
     * @param {number} year - 學年度
     * @param {number} month - 月份
     * @param {Array} records - 與 calculate() 相同來源的調代課紀錄（內部會再經 filterMonthlyRecords 篩月）
     * @param {Object} [xlsxLib] - SheetJS 實體
     * @returns {Object} workbook
     */
    buildWorkbook(settlementData, year, month, records = [], xlsxLib = globalThis.XLSX) {
        const XLSX = xlsxLib;
        // 建立工作表資料
        // 備註欄：只有出現名冊外、同名、無法判斷的列時才加（一般情況的表維持原樣）
        const noteOf = (row) => {
            const parts = [];
            if (row.unresolved) parts.push('無法判斷是哪一位（同名教師，紀錄沒有 teacherId）');
            else if (row.notInRoster) parts.push('名冊外');
            if (row.multiId) parts.push(row.scheduleHolder ? '多個教師編號（原定時數只計入此列）' : '多個教師編號（原定時數 0，已計入另一列）');
            if (row.ambiguousName && !row.unresolved) {
                const id = row.teacherId ? `teacherId 尾碼 ${String(row.teacherId).slice(-4)}` : '無 teacherId';
                const cls = (row.classNames || []).length ? `任教班級 ${row.classNames.join('、')}` : '';
                parts.push(`同名（${[id, cls].filter(Boolean).join('；')}）`);
            }
            return parts.join('；');
        };
        const notes = settlementData.map(noteOf);
        const hasNotes = notes.some(n => n);
        const warnings = settlementData.warnings || [];
        const wsData = [
            [`${year} 學年度 ${month} 月 教師授課時數結算表`],
            [],
            ['教師姓名', '每週節數', '原定授課時數', '代課增加', '被代課減少', '實際授課時數', '超鐘點時數']
        ];
        if (hasNotes) wsData[2].push('備註');

        settlementData.forEach((row, i) => {
            const line = [
                row.teacherName,
                row.weeklyHours,
                row.originalHours,
                row.substituteHours,
                row.substitutedHours,
                row.actualHours,
                row.overtimeHours
            ];
            if (hasNotes) line.push(notes[i]);
            wsData.push(line);
        });

        // 加入合計列
        const totalRow = [
            '合計',
            settlementData.reduce((sum, r) => sum + r.weeklyHours, 0),
            settlementData.reduce((sum, r) => sum + r.originalHours, 0),
            settlementData.reduce((sum, r) => sum + r.substituteHours, 0),
            settlementData.reduce((sum, r) => sum + r.substitutedHours, 0),
            settlementData.reduce((sum, r) => sum + r.actualHours, 0),
            settlementData.reduce((sum, r) => sum + r.overtimeHours, 0)
        ];
        if (hasNotes) totalRow.push('');
        wsData.push(totalRow);

        // 下限註記：實際授課時數最低以 0 計（見檔頭說明）。任何一列「原定 + 增加 − 減少 ≠ 實際」
        // 時，合計列也會不平，於表尾說明，避免對帳時誤以為算錯。
        const clamped = settlementData.filter(r =>
            r.actualHours !== r.originalHours + r.substituteHours - r.substitutedHours);
        if (clamped.length) {
            wsData.push([]);
            wsData.push([`註：實際授課時數最低以 0 計（寒暑假等 0 週月份，被代課節數大於原定時數時不計負數），` +
                `故下列教師「原定＋代課增加−被代課減少」不等於「實際授課時數」，合計列亦同：` +
                `${clamped.map(r => r.teacherName).join('、')}。「被代課減少」欄仍為實際被代節數。`]);
        }

        // 建立工作簿
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(wsData);

        // 設定欄寬
        ws['!cols'] = [
            { wch: 12 },  // 教師姓名
            { wch: 10 },  // 每週節數
            { wch: 14 },  // 原定授課時數
            { wch: 10 },  // 代課增加
            { wch: 12 },  // 被代課減少
            { wch: 14 },  // 實際授課時數
            { wch: 12 }   // 超鐘點時數
        ];
        if (hasNotes) ws['!cols'].push({ wch: 40 });   // 備註

        // 合併標題儲存格
        ws['!merges'] = [
            { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }
        ];

        XLSX.utils.book_append_sheet(wb, ws, '結算表');

        // 第二分頁：逐節明細（與彙總同一口徑：同樣經過 filterMonthlyRecords 與 isDeductedFromOriginal）
        const detailRows = this.getMonthlyDetailRows(records, year, month);
        const detailData = [
            [`${year} 學年度 ${month} 月 調代課逐節明細`],
            [],
            ['日期', '星期', '節次', '班級', '科目', '類型', '原任課教師', '代課／調課教師', '假別', '是否扣原任課教師時數'],
            ...detailRows.map(r => [
                r.date, r.weekday, r.period, r.className, r.subject,
                r.type, r.originalTeacher, r.substituteTeacher, r.leaveType, r.deducted ? '是' : '否'
            ])
        ];
        const wsDetail = XLSX.utils.aoa_to_sheet(detailData);
        wsDetail['!cols'] = [
            { wch: 12 }, { wch: 6 }, { wch: 8 }, { wch: 10 }, { wch: 12 },
            { wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 20 }
        ];
        wsDetail['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }];
        XLSX.utils.book_append_sheet(wb, wsDetail, '明細');

        // 第三分頁：畫面上的警示列（同名教師、名冊外等），交給會計時一併可見
        if (warnings.length) {
            const wsWarn = XLSX.utils.aoa_to_sheet([
                [`${year} 學年度 ${month} 月 結算警示`],
                [],
                ...warnings.map(w => [w])
            ]);
            wsWarn['!cols'] = [{ wch: 100 }];
            XLSX.utils.book_append_sheet(wb, wsWarn, '警示');
        }

        return wb;
    }

    /**
     * 當月逐節明細列（月結算 Excel「明細」分頁的資料來源）。
     * 篩月沿用 filterMonthlyRecords，與 calculate() 納入的紀錄完全相同；
     * 「是否扣時數」呼叫 isDeductedFromOriginal，與 countSubstitutedHours 同一判斷。
     * @param {Array} records - 調代課紀錄（可含全部月份）
     * @param {number} year - 學年度
     * @param {number} month - 月份
     * @returns {Array<Object>} 依日期、節次排序的明細列
     */
    getMonthlyDetailRows(records, year, month) {
        const leaveLabels = Object.fromEntries([...LEAVE_TYPES.map(t => [t.code, t.label]), ['swap', '調課']]);
        const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];

        return this.filterMonthlyRecords(records || [], year, month)
            .map(r => {
                const isSwap = r.type === 'swap' || r.type === '調課';
                const [y, m, d] = String(r.date).split('-').map(Number);
                const dow = new Date(y, m - 1, d).getDay();
                return {
                    date: r.date,
                    weekday: Number.isNaN(dow) ? '' : '週' + weekdayLabels[dow],
                    period: r.period || '',
                    className: r.className || '',
                    subject: r.subject || '',
                    type: isSwap ? '調課' : '代課',
                    originalTeacher: r.originalTeacher || '',
                    substituteTeacher: r.substituteTeacher || '',
                    leaveType: isSwap ? '調課' : (leaveLabels[r.leaveType] || r.leaveType || ''),
                    deducted: this.isDeductedFromOriginal(r)
                };
            })
            .sort((a, b) => a.date.localeCompare(b.date) || periodIndex(a.period) - periodIndex(b.period));
    }

    /**
     * 設定每週基本授課時數
     * @param {number} hours - 時數
     */
    setBaseWeeklyHours(hours) {
        this.baseWeeklyHours = hours;
    }

    /**
     * 設定每月上課週數
     * @param {number} weeks - 週數
     */
    setDefaultWeeksPerMonth(weeks) {
        this.defaultWeeksPerMonth = weeks;
    }

    /**
     * 取得詳細的調課明細
     * @param {Array} records - 調課紀錄
     * @param {string} teacherName - 教師姓名
     * @returns {Object} 調課明細
     */
    getSubstituteDetails(records, teacherName) {
        records = (records || []).filter(r => this.isEffectiveRecord(r));
        const asSubstitute = records.filter(r => r.substituteTeacher === teacherName);
        const asOriginal = records.filter(r => r.originalTeacher === teacherName);

        return {
            teacherName,
            substituteRecords: asSubstitute.map(r => ({
                date: r.date,
                period: r.period,
                className: r.className,
                subject: r.subject,
                for: r.originalTeacher
            })),
            substitutedRecords: asOriginal.map(r => ({
                date: r.date,
                period: r.period,
                className: r.className,
                subject: r.subject,
                by: r.substituteTeacher,
                reason: r.reason
            }))
        };
    }
}
