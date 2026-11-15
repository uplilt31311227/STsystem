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
 */
export const LEAVE_TYPES = [
    { code: 'official',    label: '公假',           deduct: false, group: 'paid' },
    { code: 'longsick',    label: '長期病假',       deduct: false, group: 'paid' },
    { code: 'funeral',     label: '喪假',           deduct: false, group: 'paid' },
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

export function leaveTypeLabel(code) {
    const t = findLeaveType(code);
    return t ? t.label : code;
}
