/**
 * 假別對照表（月結算「是否扣原任課教師時數」的唯一定義處）
 *
 * deduct: true  = 被代課時扣原任課教師的授課時數（由教師自行負擔代課）
 * deduct: false = 不扣（公費支應代課鐘點，或調課互換）
 *
 * 既有假別（official／longsick／funeral／personal／sick／rest／other／swap）維持原本行為，不得更動。
 * 新增假別的預設值是依「教師請假規則」常見做法推定，屬校務規定判斷，學校若有不同做法，
 * 只需改本表的 deduct 即可（測試 test-p7-settlement.mjs（C1、C2 案例） 會逐項檢查本表）：
 *   marriage    婚假：法定給薪假，課務由學校派代，不扣
 *   maternity   產假：法定給薪假，課務由學校派代（長期代理），不扣
 *   paternity   陪產假（含陪產檢）：法定給薪假，不扣
 *   injury      公傷假：因公受傷，比照公假，不扣
 *   miscarriage 流產假：比照產假，不扣
 *   family      家庭照顧假：併入事假計算，扣
 *   menstrual   生理假：併入病假計算，扣
 * 未知的假別代碼或缺假別一律扣（維持既有行為）。
 *
 * requiresDocNumber: true = 申請時必須填字號／證明文號（申請表單、送出檢核、紀錄詳情顯示都讀這個欄位）。
 * 目前只有公假、長期病假、喪假要求，這是既有行為，維持不變。
 * 新增的婚假、產假、陪產假、公傷假、流產假是否要求證明文號：使用者已於 2026-11-18 決定「不要求」
 * （沒有 requiresDocNumber 欄位＝不要求）。日後若要改，只需在對應項目加上
 *   requiresDocNumber: true，並在 app.js 的 onLeaveTypeChanged 與紀錄詳情補上標籤與提示文字（審計 PL-23）。
 */
export const LEAVE_TYPES = [
    { code: 'official',    label: '公假',           deduct: false, group: 'paid', requiresDocNumber: true },
    { code: 'longsick',    label: '長期病假',       deduct: false, group: 'paid', requiresDocNumber: true },
    { code: 'funeral',     label: '喪假',           deduct: false, group: 'paid', requiresDocNumber: true },
    { code: 'marriage',    label: '婚假',           deduct: false, group: 'paid', isNew: true },
    { code: 'maternity',   label: '產假',           deduct: false, group: 'paid', isNew: true },
    { code: 'paternity',   label: '陪產假',         deduct: false, group: 'paid', isNew: true },
    { code: 'injury',      label: '公傷假',         deduct: false, group: 'paid', isNew: true },
    { code: 'miscarriage', label: '流產假',         deduct: false, group: 'paid', isNew: true },
    { code: 'personal',    label: '事假',           deduct: true,  group: 'general' },
    { code: 'sick',        label: '病假',           deduct: true,  group: 'general' },
    { code: 'rest',        label: '休假',           deduct: true,  group: 'general' },
    { code: 'family',      label: '家庭照顧假',     deduct: true,  group: 'general', isNew: true },
    { code: 'menstrual',   label: '生理假',         deduct: true,  group: 'general', isNew: true },
    { code: 'other',       label: '其他',           deduct: true,  group: 'general' },
];

/** 調課不是假別，但結算上與不扣假別同一處理；保留在此集中管理。 */
export const SWAP_CODES = ['swap', '調課'];

/** 不扣時數的代碼與中文名稱（供 SettlementCalculator 使用）。 */
export function noDeductCodesAndLabels() {
    const out = [];
    for (const t of LEAVE_TYPES) if (!t.deduct) out.push(t.code, t.label);
    out.push(...SWAP_CODES);
    return out;
}

/** 以代碼或中文名稱找假別，找不到回 null。 */
export function findLeaveType(codeOrLabel) {
    return LEAVE_TYPES.find(t => t.code === codeOrLabel || t.label === codeOrLabel) || null;
}

/** 這個假別申請時是否必須填字號／證明文號（代碼或中文名稱皆可；未知假別回 false）。 */
export function requiresDocNumber(codeOrLabel) {
    const t = findLeaveType(codeOrLabel);
    return !!(t && t.requiresDocNumber === true);
}

export function leaveTypeLabel(code) {
    const t = findLeaveType(code);
    return t ? t.label : code;
}

/**
 * 紀錄 leaveType／leaveTypeName 欄位寫入用的名稱：假別代碼轉中文；'swap' 轉「調課」（調課不是假別，
 * 不在 LEAVE_TYPES）；已是中文名稱或未知值原樣回傳。結算的 noDeductCodesAndLabels 以這些字串判定。
 */
export function leaveTypeDisplayName(code) {
    return code === 'swap' ? '調課' : leaveTypeLabel(code);
}
