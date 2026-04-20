/**
 * V2 環境偵測（純 URL 判斷，不使用 localStorage）
 *
 * V2（權限系統）啟用條件（任一成立）：
 * 1. URL 參數 ?v2=1
 * 2. hostname 包含 'preview'（如 preview.example.com）
 * 3. pathname 以 /STsystem-preview/ 開頭或包含 '-preview/'（GitHub Pages
 *    專案頁形式 https://uplilt31311227.github.io/STsystem-preview/）
 *
 * ⚠️ 刻意不使用 localStorage 做持久化：master 站點與 preview 站點共享 origin
 * （uplilt31311227.github.io），localStorage flag 會誤讓穩定版啟用 V2。
 */

export function isV2Enabled() {
    if (typeof window === 'undefined') return false;

    const params = new URLSearchParams(window.location.search);
    if (params.get('v2') === '1') return true;

    const host = window.location.hostname || '';
    if (host.includes('preview')) return true;

    const path = window.location.pathname || '';
    if (/(^|\/)[^/]*-preview(\/|$)/.test(path)) return true;

    return false;
}
