/**
 * 送出申請後的合併通知文字（審計 UX-M7）
 * 多節代課、多重調課批次逐筆建立申請時，不逐筆跳通知，改合併成一則。純函式，供 node 測試。
 * @param {Array<{msg:string, isSubstitute:boolean}>} entries
 */
export function composeSubmitSummary(entries) {
    if (!entries || !entries.length) return '';
    if (entries.length === 1) return entries[0].msg;
    return entries.every(e => e.isSubstitute)
        ? `已送出 ${entries.length} 節代課申請，等待組長／主任核准。核准後才會正式成立並產生 PDF。`
        : `已送出 ${entries.length} 筆申請：調課類需對方教師同意，全員同意並經組長／主任核准後才會正式成立並產生 PDF。`;
}
