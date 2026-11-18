// openRichDialog 替身：記錄呼叫參數，回傳值由 globalThis.__rd.handler(args) 決定（測試端模擬使用者操作）。
const R = () => (globalThis.__rd ||= { calls: [], handler: async () => true });
export const rdText = (t) => `<p>${t}</p>`;
export const rdHeading = (t) => `<h4>${t}</h4>`;
export const rdList = (items) => (items || []).map(t => `<li>${t}</li>`).join('');
export const rdNotice = (kind, t) => `<div class="${kind}">${t}</div>`;
export const rdTable = (h, rows) => `<table>${(h || []).join('|')}${(rows || []).map(r => r.join('|')).join(';')}</table>`;
export async function openRichDialog(args) {
    R().calls.push(args);
    return R().handler(args, R().calls.length);
}
