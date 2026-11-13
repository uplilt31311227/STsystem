/**
 * 全校課表寫入守門（純函式，無 DOM／Firebase 依賴，node 可直接單元測試）
 *
 * 背景（審計 ux H7／logic-flow M-4／H-1）：schedules/{semesterId} 過去是無條件整份 setDoc——
 *   1. 兩位 approver 先後編輯，後寫者的舊快照會靜默蓋掉先寫者的內容；
 *   2. 「開新學期」對已存在的學期寫入空殼，整份課表被清空；
 *   3. 任何呼叫端不慎傳入空資料，也會把有內容的課表覆寫成空白。
 * 本模組定義兩道前置條件，由 schoolDataService.saveSchedule() 在 transaction 內套用：
 *   - 版本前置條件（expected）：呼叫端讀取當時的 { version, updatedAt }，寫入時雲端必須仍是
 *     同一版，否則丟 ScheduleConflictError，不覆寫。
 *   - 空覆寫守門（allowEmpty）：寫入內容為空、而雲端課表非空時，除非呼叫端明確聲明
 *     allowEmpty（例如「清除所有資料」），否則丟 ScheduleEmptyOverwriteError。
 *
 * 版本號：寫入時 version = 雲端現值 + 1（舊文件沒有 version 欄位視為 0）。比對時同時檢查
 * version 與 updatedAt——舊版 client（不認識 version 的快取頁面）整份 setDoc 會讓 version 欄位
 * 消失，但 updatedAt 一定會變，所以只看 version 會漏掉「被舊 client 覆寫」的情況。
 */

export class ScheduleConflictError extends Error {
    constructor(message, detail = {}) {
        super(message);
        this.name = 'ScheduleConflictError';
        // 沿用錯誤碼慣例（uiFeedback 以 err.code 對照人話）；自訂碼不在對照表內，會顯示 message 本身
        this.code = 'schedule-conflict';
        this.detail = detail;
    }
}

export class ScheduleEmptyOverwriteError extends Error {
    constructor(message, detail = {}) {
        super(message);
        this.name = 'ScheduleEmptyOverwriteError';
        this.code = 'schedule-empty-overwrite';
        this.detail = detail;
    }
}

const len = (v) => (Array.isArray(v) ? v.length : 0);

/**
 * 課表文件是否「沒有內容」：不存在，或課表節次、教師、班級三者皆空。
 * （只看 scheduleData 會把「有教師名單但尚無課程」的文件誤判成空；三者皆空才是空殼。）
 */
export function isScheduleDocEmpty(doc) {
    if (!doc || typeof doc !== 'object') return true;
    return len(doc.scheduleData) === 0 && len(doc.teachers) === 0 && len(doc.classes) === 0;
}

/** 取文件目前的版本資訊。 */
export function scheduleVersionOf(doc) {
    if (!doc || typeof doc !== 'object') return { exists: false, version: 0, updatedAt: null };
    const v = Number(doc.version);
    return { exists: true, version: Number.isFinite(v) && v > 0 ? Math.floor(v) : 0, updatedAt: doc.updatedAt || null };
}

/** 寫入後的新版本號。 */
export function nextScheduleVersion(existingDoc) {
    return scheduleVersionOf(existingDoc).version + 1;
}

/**
 * 把「讀到的課表快照」轉成寫入時要帶的前置條件：
 *   快照不存在 → null（要求寫入時文件仍不存在）；存在 → { version, updatedAt }。
 */
export function expectedFromDoc(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const { version, updatedAt } = scheduleVersionOf(doc);
    return { version, updatedAt };
}

/**
 * 檢查一次課表寫入是否可進行。
 * @param {Object} p
 * @param {Object|null} p.existing  transaction 內讀到的雲端現值（不存在為 null）
 * @param {Object} p.incoming       要寫入的內容
 * @param {undefined|null|{version:number, updatedAt:string|null}} [p.expected]
 *        undefined＝不檢查版本；null＝要求文件不存在；物件＝要求雲端仍是這一版
 * @param {boolean} [p.allowEmpty]  明確允許以空內容覆寫非空課表
 * @returns {{ok:true}|{ok:false, reason:'conflict'|'empty-overwrite', message:string}}
 */
export function checkScheduleWrite({ existing = null, incoming, expected, allowEmpty = false } = {}) {
    if (expected !== undefined) {
        const cur = scheduleVersionOf(existing);
        if (expected === null) {
            if (cur.exists) {
                return {
                    ok: false, reason: 'conflict',
                    message: '這個學期的課表已經存在（可能剛被其他人建立），為避免覆寫，本次寫入已取消。請重新整理頁面後再操作。',
                };
            }
        } else {
            const sameVersion = Number(expected.version || 0) === cur.version;
            const sameStamp = (expected.updatedAt || null) === (cur.updatedAt || null);
            if (!cur.exists || !sameVersion || !sameStamp) {
                return {
                    ok: false, reason: 'conflict',
                    message: cur.exists
                        ? '全校課表剛剛被其他人更新過，你這次的修改沒有儲存（為避免蓋掉對方的內容）。畫面已改為最新版本，請確認後再修改一次。'
                        : '全校課表已不存在（可能剛被刪除），本次寫入已取消。請重新整理頁面後再操作。',
                };
            }
        }
    }
    if (!allowEmpty && isScheduleDocEmpty(incoming) && !isScheduleDocEmpty(existing)) {
        return {
            ok: false, reason: 'empty-overwrite',
            message: `拒絕以空白內容覆寫現有課表（現有 ${len(existing.scheduleData)} 節、${len(existing.teachers)} 位教師）。` +
                '若確實要清空，請使用「清除所有資料」。',
        };
    }
    return { ok: true };
}

/** 依檢查結果丟出對應的錯誤（ok 時不做事）。 */
export function assertScheduleWrite(args) {
    const verdict = checkScheduleWrite(args);
    if (verdict.ok) return;
    if (verdict.reason === 'conflict') {
        throw new ScheduleConflictError(verdict.message, { expected: args.expected, existing: scheduleVersionOf(args.existing) });
    }
    throw new ScheduleEmptyOverwriteError(verdict.message, { existing: scheduleVersionOf(args.existing) });
}
