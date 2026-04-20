/**
 * V2 環境偵測（純 URL / hostname 判斷，不使用 localStorage）
 *
 * V2（權限系統）啟用條件：
 * 1. URL 參數 ?v2=1
 * 2. hostname 包含 'preview'（預覽站點自動啟用）
 *
 * ⚠️ 刻意不使用 localStorage 做持久化：master 站點與 preview 站點可能共享 origin
 * （例：uplilt31311227.github.io），localStorage flag 會誤讓穩定版啟用 V2。
 * 若需持續 V2 模式，請使用書籤或改用 preview 子域名部署。
 */

export function isV2Enabled() {
    if (typeof window === 'undefined') return false;

    const params = new URLSearchParams(window.location.search);
    if (params.get('v2') === '1') return true;

    return window.location.hostname.includes('preview');
}
