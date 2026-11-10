/**
 * 操作日誌 details 的打包（v2.12b，H-2）——純函式，無任何瀏覽器／Firebase 依賴，
 * 讓 emulator 規則測試（test/emulator/kit.mjs）可以直接引用真正的實作。
 *
 * firestore.rules 對 operationLogs.details 只接受：null、空 map、或 ≤10000 字元的字串。
 */

// rules 允許 details 字串 ≤ 10000 字元；size() 可能以位元組計，所以前端以 UTF-8 位元組數控管並留餘裕。
const MAX_DETAILS_BYTES = 9000;
const _utf8 = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
function byteLen(s) { return _utf8 ? _utf8.encode(s).length : s.length * 3; }

/**
 * 把 details 打包成 rules 接受的形狀：無內容 → {}；其餘 → JSON 字串。超過上限時改存摘要
 * （_truncated + 原始鍵名 + 開頭預覽），確保日誌一定寫得進去、不會因為內容太大而整筆遺失。
 * 匯出供測試使用。
 */
export function packDetails(details) {
    if (details == null) return {};
    if (typeof details !== 'object') details = { value: String(details) };
    if (Object.keys(details).length === 0) return {};
    let json;
    try { json = JSON.stringify(details); } catch (_) { json = JSON.stringify({ _unserializable: true }); }
    if (byteLen(json) <= MAX_DETAILS_BYTES) return json;
    const keys = Object.keys(details).slice(0, 30);
    let previewLen = 3000;
    for (;;) {
        const packed = JSON.stringify({ _truncated: true, originalBytes: byteLen(json), keys, preview: json.slice(0, previewLen) });
        if (byteLen(packed) <= MAX_DETAILS_BYTES || previewLen <= 0) return packed;
        previewLen = Math.floor(previewLen / 2);
    }
}
