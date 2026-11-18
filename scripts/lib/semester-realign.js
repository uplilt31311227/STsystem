/**
 * 紀錄學期歸屬校正的純函式（LC-L7／LF-M8，rules v2.18）。
 * 腳本以 CommonJS 執行，不能 import ESM，故學期推算公式在此重寫一份，與
 * src/js/modules/v2/semesterUtils.js dateToSemesterId 同式；一致性由
 * test/test-realign-semester-id.mjs 對正式模組逐日比對把關。
 */
function dateToSemesterId(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!m) return null;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    if (month < 1 || month > 12) return null;
    const rt = new Date(year, month - 1, day);
    if (rt.getFullYear() !== year || rt.getMonth() !== month - 1 || rt.getDate() !== day) return null;
    const roc = month >= 8 ? (year - 1911) : (year - 1912);
    return `${roc}-${(month >= 8 || month === 1) ? 1 : 2}`;
}

/**
 * 找出「semesterId 與日期推算結果不一致」的文件。
 * @param {Array<{id:string, data:object}>} docs
 * @param {Set<string>} archivedSemesterIds 已封存學期（推算結果落在這些學期的文件不自動改，只列出）
 * @returns {{ok:number, noSemesterId:Array, unresolved:Array, mismatched:Array<{id,from,to,date}>, blockedByArchive:Array}}
 */
function planRealign(docs, archivedSemesterIds = new Set()) {
    const out = { ok: 0, noSemesterId: [], unresolved: [], mismatched: [], blockedByArchive: [] };
    for (const { id, data, updateTime } of docs) {
        if (!data || typeof data.semesterId !== 'string' || !data.semesterId) { out.noSemesterId.push({ id }); continue; }
        const derived = dateToSemesterId(data.date);
        if (!derived) { out.unresolved.push({ id, date: data.date ?? null }); continue; }
        if (derived === data.semesterId) { out.ok++; continue; }
        const item = { id, from: data.semesterId, to: derived, date: data.date, updateTime };
        if (archivedSemesterIds.has(derived)) out.blockedByArchive.push(item);
        else out.mismatched.push(item);
    }
    return out;
}

/**
 * 組出 Firestore REST `:commit` 的請求內容：只改 semesterId 一個欄位，並帶 currentDocument.updateTime 前置條件
 * （規劃之後文件若被別人改過，整個 commit 會失敗、不覆寫）。沒有 updateTime 直接丟錯（不退回無條件寫入）。
 */
function buildCommitBody(project, docPath, semesterId, updateTime) {
    if (!updateTime) throw new Error(`${docPath} 缺少 updateTime，無法建立前置條件，拒絕寫入`);
    return {
        writes: [{
            update: { name: `projects/${project}/databases/(default)/documents/${docPath}`, fields: { semesterId: { stringValue: semesterId } } },
            updateMask: { fieldPaths: ['semesterId'] },
            currentDocument: { updateTime },
        }],
    };
}

module.exports = { dateToSemesterId, planRealign, buildCommitBody };
