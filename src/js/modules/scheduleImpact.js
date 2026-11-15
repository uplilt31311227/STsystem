/**
 * 課表或教師名單異動後，找出「受影響」的在途申請與未來的已成立紀錄（純函式，node 可測）
 *
 * 問題（P6，審計 Medium「重新匯入課表或刪除教師後不重新驗證」）：申請與紀錄存的是姓名與時段，
 * 重新匯入課表或刪除教師後，既有的在途申請與未來的紀錄可能指向已經不存在的人或課，
 * 系統完全沒有提示，之後核准或產生調代課單才會出錯。
 *
 * 本檔只「找出並說明」，不改動任何資料；顯示由呼叫端負責（異動後的清單視窗、待辦卡片與紀錄列的提示）。
 * 判斷依據：
 *   - 教師姓名（原任課、代課、互換）不在目前的教師名單，也不在課表上
 *   - 申請指定的班級時段，在「當日有效課表」（排除自己這一筆後套用其他已成立的調課）上的任課者，
 *     與申請當時認定的任課者不同，或該時段已經沒有課
 */
import { applySwapsToSchedule, isEstablishedRecord } from './slotOccupancy.js';

const norm = (v) => (v == null ? '' : String(v).trim());

/**
 * @param {Object} p
 * @param {Array} p.scheduleData - 目前課表
 * @param {Array<string|{name:string}>} p.teachers - 目前教師名單
 * @param {Array} [p.requests] - 在途申請（待同意／待核准）
 * @param {Array} [p.records] - 已成立紀錄（只看日期為今天或之後者）
 * @param {string} p.today - YYYY-MM-DD
 * @returns {{requests:Array<{item:Object, reasons:string[]}>, records:Array<{item:Object, reasons:string[]}>}}
 */
export function findScheduleImpact({ scheduleData = [], teachers = [], requests = [], records = [], today = '' }) {
    const known = new Set();
    for (const t of teachers || []) known.add(norm(typeof t === 'string' ? t : t && t.name));
    for (const c of scheduleData || []) known.add(norm(c.teacher));
    known.delete('');
    const established = (records || []).filter(isEstablishedRecord);

    const itemKey = (r) => r.recordId || r.reqId || r.id;
    const slotTeacher = (item, date, weekday, period, className) => {
        const others = established.filter(r => itemKey(r) !== itemKey(item) && r.fromRequestId !== item.reqId);
        const eff = applySwapsToSchedule(scheduleData, others, date);
        return eff.find(c => c.weekday === weekday && c.period === period && c.className === className) || null;
    };

    const analyze = (item) => {
        const reasons = [];
        const roles = [['原任課教師', item.originalTeacher]];
        if (item.type === '調課') roles.push(['互換教師', item.swapTeacher]);
        else roles.push(['代課教師', item.substituteTeacher]);
        for (const [label, name] of roles) {
            if (norm(name) && !known.has(norm(name))) reasons.push(`${label}「${norm(name)}」已不在教師名單與課表中`);
        }
        const check = (label, date, weekday, period, expectedTeacher) => {
            if (!date || !period || !item.className || !norm(expectedTeacher)) return;
            const c = slotTeacher(item, date, weekday, period, item.className);
            if (!c) reasons.push(`課表已沒有${weekday || ''}${period} ${item.className} 的課（${label}）`);
            else if (norm(c.teacher) !== norm(expectedTeacher)) {
                reasons.push(`${label}：${weekday || ''}${period} ${item.className} 現在是「${norm(c.teacher)}」的課，與申請的「${norm(expectedTeacher)}」不符`);
            }
        };
        check(item.type === '調課' ? '時段 A' : '請假節次', item.date, item.weekday, item.period, item.originalTeacher);
        if (item.type === '調課' && !item.isSelfSwap) {
            check('時段 B', item.swapDate, item.swapWeekday, item.swapPeriod, item.swapTeacher);
        }
        return reasons;
    };

    const out = { requests: [], records: [] };
    for (const r of requests || []) {
        if (!r || r.isSelfSwap) continue;
        if (r.date && today && r.date < today && !(r.swapDate && r.swapDate >= today)) continue;
        const reasons = analyze(r);
        if (reasons.length) out.requests.push({ item: r, reasons });
    }
    for (const r of established) {
        if (!r || !r.date || (today && r.date < today && !(r.swapDate && r.swapDate >= today))) continue;
        const reasons = analyze(r);
        if (reasons.length) out.records.push({ item: r, reasons });
    }
    return out;
}

/** 把影響清單轉成顯示用的短文字（一筆）。 */
export function describeImpactItem(entry) {
    const it = entry.item;
    const when = `${it.date || ''} ${it.period || ''} ${it.className || ''}`.trim();
    return `${when}（${it.type || ''}）：${entry.reasons.join('；')}`;
}
