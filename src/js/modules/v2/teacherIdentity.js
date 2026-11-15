/**
 * 教師姓名 → teacherId 的解析（純函式，node 可測）
 *
 * 問題（P6，審計：同名教師）：申請與紀錄存的是姓名，送出時用 teachers.find(t => t.name === name)
 * 取第一筆，同名的兩位教師會被當成同一人——同意權、核准對象、之後的結算都會落到錯的人身上。
 * 本檔把解析改成三種明確結果，同名時一定要由使用者明確選擇，不再默默取第一筆。
 * P7（月結算）依 teacherId 區分同名教師時，可直接使用 normalizeTeacherName／resolveTeacherIdByName。
 */

/** 姓名正規化：去除前後空白與全形空白（只用於比對，不改寫儲存的姓名）。 */
export function normalizeTeacherName(name) {
    return String(name == null ? '' : name).replace(/　/g, ' ').trim();
}

/** 以正規化姓名找出所有同名教師。 */
export function findTeachersByName(teachers, name) {
    const n = normalizeTeacherName(name);
    if (!n) return [];
    return (teachers || []).filter(t => t && normalizeTeacherName(t.name) === n);
}

/**
 * @param {Array} teachers - V2 教師檔（含 teacherId）
 * @param {string} name
 * @param {{preferTeacherId?:string, chosenTeacherId?:string}} [opts]
 *   preferTeacherId：呼叫端已知的身分（例如登入者本人），同名時若在候選之中就直接採用
 *   chosenTeacherId：使用者明確選擇的結果，必須是候選之一
 * @returns {{status:'ok', teacherId:string}|{status:'none'}|{status:'ambiguous', candidates:Array}}
 */
export function resolveTeacherIdByName(teachers, name, { preferTeacherId = null, chosenTeacherId = null } = {}) {
    const candidates = findTeachersByName(teachers, name).filter(t => t.teacherId);
    if (candidates.length === 0) return { status: 'none' };
    if (candidates.length === 1) return { status: 'ok', teacherId: candidates[0].teacherId };
    if (chosenTeacherId && candidates.some(t => t.teacherId === chosenTeacherId)) {
        return { status: 'ok', teacherId: chosenTeacherId };
    }
    if (preferTeacherId && candidates.some(t => t.teacherId === preferTeacherId)) {
        return { status: 'ok', teacherId: preferTeacherId };
    }
    return { status: 'ambiguous', candidates };
}

/** 供選擇畫面顯示的候選說明：姓名、信箱（若有）、導師班級、識別碼末六碼。 */
export function describeTeacherCandidate(t) {
    const parts = [];
    if (t.email) parts.push(t.email);
    if (t.homeroomClass) parts.push(`導師 ${t.homeroomClass}`);
    if (Array.isArray(t.domains) && t.domains.length) parts.push(t.domains.join('、'));
    parts.push(`代碼 ${String(t.teacherId || '').slice(-6)}`);
    return `${t.name}（${parts.join('，')}）`;
}

/**
 * 解析一次申請牽涉的多位教師。同名時依序：登入者本人（preferTeacherId）→ 呼叫端提供的 chooser（使用者選擇）；
 * 都沒有就丟出錯誤，不默默取第一筆。
 * @param {Array} teachers
 * @param {Array<{key:string, name:string, preferTeacherId?:string}>} wanted - 要解析的欄位
 * @param {(name:string, candidates:Array)=>Promise<string|null>} [chooser] - 回傳選定的 teacherId，取消回 null
 * @returns {Promise<Object>} key → teacherId|null（查無此人為 null）
 */
export async function resolveTeacherIds(teachers, wanted, chooser = null) {
    const out = {};
    const chosenByName = new Map();
    for (const w of wanted) {
        const name = normalizeTeacherName(w.name);
        if (!name) { out[w.key] = null; continue; }
        let r = resolveTeacherIdByName(teachers, name, { preferTeacherId: w.preferTeacherId, chosenTeacherId: chosenByName.get(name) });
        if (r.status === 'ambiguous') {
            if (!chooser) {
                throw Object.assign(new Error(`有 ${r.candidates.length} 位同名教師「${name}」，請先在教師管理改成可區分的姓名，或由系統提供選擇後再送出`), { code: 'AMBIGUOUS_TEACHER' });
            }
            const picked = await chooser(name, r.candidates);
            if (!picked) throw Object.assign(new Error('已取消送出：同名教師尚未選擇'), { code: 'AMBIGUOUS_TEACHER_CANCELLED' });
            chosenByName.set(name, picked);
            r = resolveTeacherIdByName(teachers, name, { chosenTeacherId: picked });
        }
        out[w.key] = r.status === 'ok' ? r.teacherId : null;
    }
    return out;
}
