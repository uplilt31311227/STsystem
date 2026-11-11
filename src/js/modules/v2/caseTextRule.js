/**
 * 前端對照 firestore.rules `hasSafeCaseText(d)` 的送出前預檢（純函式，node 可測）。
 *
 * rules 把案件的文字／id／數字類欄位串成一個字串：
 *   string(d.get(f1, 預設)) + '|' + string(d.get(f2, 預設)) + …
 * 然後要求總長 <= 1000 且不含 < > "。欄位清單與順序必須與 rules 完全一致——
 * test/test-html-escape.mjs 會讀取 firestore.rules 比對 CASE_TEXT_FIELDS，兩邊漂移時測試會失敗。
 *
 * 長度以 JS 的 UTF-16 長度（.length）計，>= rules 以字元計的長度，因此「前端放行 ⇒ rules 必放行」。
 */

/** [欄位, rules 缺欄預設值, 顯示名稱]；順序同 hasSafeCaseText。 */
export const CASE_TEXT_FIELDS = [
    ['type', '', '類型'], ['date', '', '日期'], ['swapDate', '', '對調日期'], ['weekday', '', '星期'],
    ['swapWeekday', '', '對調星期'], ['period', '', '節次'], ['swapPeriod', '', '對調節次'],
    ['className', '', '班級'], ['subject', '', '科目'], ['swapSubject', '', '對調科目'],
    ['domain', '', '領域'], ['swapDomain', '', '對調領域'],
    ['originalTeacher', '', '原任課教師'], ['substituteTeacher', '', '代課／調課教師'], ['swapTeacher', '', '對調教師'],
    ['docNumber', '', '公文文號'], ['initiatedByName', '', '發起人姓名'], ['requiredApproverName', '', '核准對象姓名'],
    ['id', '', '紀錄 id'], ['batchId', '', '批次 id'], ['multiCourseGroupId', '', '多節群組 id'],
    ['originalTeacherId', '', '原任課教師 id'], ['substituteTeacherId', '', '代課教師 id'],
    ['swapTeacherId', '', '對調教師 id'], ['requiredApproverId', '', '核准對象 id'],
    ['batchSize', 0, '批次筆數'], ['multiCourseIndex', 0, '多節序號'], ['multiCourseTotal', 0, '多節總數'],
    ['isMultiSwap', false, '多重調課旗標'], ['isMultiCourse', false, '多節旗標'],
];

export const CASE_TEXT_MAX_LENGTH = 1000;

/** rules 的 string(x)：null → 'null'、數字／布林 → 文字、字串原樣；其他型別（map／list）在 rules 會求值錯誤＝拒絕。 */
function ruleString(v, label) {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string') return v;
    if (t === 'number' || t === 'boolean') return String(v);
    throw new Error(`「${label}」欄位內容格式不正確，無法送出。請檢查課表資料是否異常。`);
}

/** 組出與 rules 相同的串接字串（缺欄用 rules 的預設值）。 */
export function caseTextString(d) {
    return CASE_TEXT_FIELDS.map(([field, dflt, label]) => {
        const has = d && Object.prototype.hasOwnProperty.call(d, field) && d[field] !== undefined;
        return ruleString(has ? d[field] : dflt, label);
    }).join('|');
}

/**
 * 送出前檢查：含 < > " 的欄位 → 指出是哪個欄位；總長超過 1000 → 通用訊息。
 * 傳入的 d 愈接近最終寫入文件愈準確（writeV2Record 在組好 payload 後再呼叫一次）。
 */
export function assertRuleSafeCaseText(d) {
    for (const [field, dflt, label] of CASE_TEXT_FIELDS) {
        const has = d && Object.prototype.hasOwnProperty.call(d, field) && d[field] !== undefined;
        const s = ruleString(has ? d[field] : dflt, label);
        if (/[<>"]/.test(s)) {
            throw new Error(`「${label}」含有系統不允許的字元（< > "）：${s}
請到課表資料或表單中移除這些字元後再送出。`);
        }
    }
    if (caseTextString(d).length > CASE_TEXT_MAX_LENGTH) {
        throw new Error('班級、科目、教師姓名等欄位內容過長，無法送出。請檢查課表資料是否異常。');
    }
}
