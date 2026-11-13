/**
 * e2e 網路防線：e2e 只能碰 localhost／127.0.0.1（本機網頁伺服器與 emulator）與唯讀 CDN 函式庫，
 * 絕不可連到正式 Firebase／reCAPTCHA／App Check。
 *
 * 背景：e2e-08 曾前往不帶 emu=1 的網址，轉址後 app 以正式設定初始化，向正式專案載入 reCAPTCHA、
 * 交換 App Check token。這裡把「哪些請求可以出去」寫成純函式（可在 node 單元測試），
 * helpers.mjs 的 newPage() 呼叫 installNetGuard()：以窄範圍 page.route 擋下封鎖清單網域，並用 request 事件偵測、記錄違規（不用 DNS 規則）。
 *
 * 分類：
 *   allow      放行：本機、data/blob、cdnjs.cloudflare.com、cdn.sheetjs.com、www.gstatic.com/firebasejs/（SDK 本體）
 *   violation  請求被 page.route 以 abort 擋下（blockedbyclient），並讓當下的測試案例失敗：*.googleapis.com、*.firebaseapp.com、*.firebaseio.com、
 *              www.google.com／recaptcha.net／www.gstatic.com 的 recaptcha、其他 *.google.com
 *   block      其餘外部主機：封鎖清單內的同樣被 abort，其餘只觀察記錄、不讓測試失敗（例如字型 CDN）
 */

const ALLOWED_CDN_HOSTS = new Set(['cdnjs.cloudflare.com', 'cdn.sheetjs.com']);

export function classifyRequest(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch { return { action: 'block', reason: '無法解析的網址' }; }
    if (['data:', 'blob:', 'about:'].includes(u.protocol)) return { action: 'allow', reason: u.protocol };
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return { action: 'allow', reason: '本機' };

    // 正式服務：一律違規
    if (host === 'googleapis.com' || host.endsWith('.googleapis.com')) return { action: 'violation', reason: 'googleapis（Firebase／Google API）' };
    if (host.endsWith('.firebaseapp.com') || host === 'firebaseapp.com') return { action: 'violation', reason: 'firebaseapp.com（正式 Auth 網域）' };
    if (host.endsWith('.firebaseio.com') || host.endsWith('.web.app')) return { action: 'violation', reason: 'Firebase 正式主機' };
    if (host === 'recaptcha.net' || host.endsWith('.recaptcha.net')) return { action: 'violation', reason: 'reCAPTCHA' };
    if (host === 'www.google.com' && u.pathname.startsWith('/recaptcha')) return { action: 'violation', reason: 'reCAPTCHA' };
    if (host === 'www.gstatic.com' && u.pathname.startsWith('/recaptcha')) return { action: 'violation', reason: 'reCAPTCHA' };
    if (host === 'google.com' || host.endsWith('.google.com')) return { action: 'violation', reason: 'Google 服務' };

    // 放行的 CDN
    if (ALLOWED_CDN_HOSTS.has(host)) return { action: 'allow', reason: 'CDN 函式庫' };
    if (host === 'www.gstatic.com' && u.pathname.startsWith('/firebasejs/')) return { action: 'allow', reason: 'Firebase SDK（CDN）' };

    return { action: 'block', reason: '非白名單外部主機' };
}

/** 全域記錄：harness 的 Suite.case 以它判斷「這個案例期間有沒有違規請求」。 */
export function getGuardState() {
    return (globalThis.__e2eNetGuard ||= { violations: [], blocked: [], allowedExternal: new Set() });
}

/**
 * 封鎖清單：classifyRequest() 判為 violation 的全部網域（含子網域）。
 * 阻擋方式見 installNetGuard：只對這些網域安裝窄範圍的 page.route，本機請求完全不經過任何攔截處理常式。
 *
 * 設計備註（實測紀錄）：曾懷疑全域 catch-all route、`--host-resolver-rules` DNS 規則會讓 Firestore 連 emulator 變慢
 * （e2e-04／05／09 因「client is offline」、第一次 schedules 查詢卡 30～60 秒而失敗）。後來以「完全不裝防線」的對照
 * 實測（helpers 路徑與純 chromium 皆然，含還原成 HEAD 的 firestore.rules）仍有同樣的 30～60 秒延遲，
 * 所以延遲是本機 emulator 的環境問題（同一個 REST 讀取只要 12ms），與防線無關。
 * 保留的作法是：單一窄範圍 route（只處理封鎖清單網域的請求）＋ request 事件偵測；不用 DNS 規則、不用全域 catch-all。
 */
export const BLOCKED_DOMAINS = ['googleapis.com', 'google.com', 'gstatic.com', 'firebaseapp.com', 'firebaseio.com', 'web.app', 'recaptcha.net'];
export const E2E_CHROMIUM_ARGS = [];
export const BLOCKED_URL_RE = new RegExp(`^https?://([^/]+[.])?(${BLOCKED_DOMAINS.map(d => d.replace(/[.]/g, '[.]')).join('|')})([:/]|$)`, 'i');

/**
 * 在 page 上安裝防線：
 *   - 阻擋：對 BLOCKED_DOMAINS 的每個網域（含子網域）安裝窄範圍 route，abort 並記錄為違規。
 *     SDK 快取的 route（helpers.mjs，www.gstatic.com/firebasejs/**）必須在這之後註冊——後註冊者優先，
 *     才能讓 firebasejs 由快取回應，其餘 gstatic（例如 recaptcha）落到這裡被擋。
 *     被測試自己的 page.route 模擬回應的請求（例如 e2e-07 的日曆 API）同樣是後註冊者優先，不會落到這裡。
 *   - 偵測放行的外部主機：request 事件（只觀察）。
 * violation 類請求一出現，Suite.case 就把當下案例判為失敗。
 */
export async function installNetGuard(page) {
    const state = getGuardState();
    // 單一 route（正規表示式）而不是每個網域各裝數條：實測 route 數量多會拖慢 Firestore 連線（見 BLOCKED_DOMAINS 註解）
    await page.route(BLOCKED_URL_RE, async (route) => {
        const url = route.request().url();
        state.violations.push({ url: url.slice(0, 200), reason: classifyRequest(url).reason, at: new Date().toISOString() });
        await route.abort('blockedbyclient');
    });
    page.on('request', (req) => {
        const url = req.url();
        if (classifyRequest(url).action !== 'allow') return;
        if (!/^(data:|blob:|about:)/.test(url) && !/^https?:..(localhost|127[.]0[.]0[.]1)[:/]/.test(url)) {
            state.allowedExternal.add(new URL(url).host);
        }
    });
}
