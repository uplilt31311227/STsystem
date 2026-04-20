/**
 * V2 環境偵測
 *
 * V2（權限系統）啟用條件：
 * 1. URL 參數 ?v2=1（並寫入 localStorage 維持狀態）
 * 2. URL 參數 ?v2=0 明確停用
 * 3. hostname 包含 'preview'（預覽站點自動啟用）
 * 4. localStorage.stsystem_v2_enabled === '1'
 */

const STORAGE_KEY = 'stsystem_v2_enabled';

export function isV2Enabled() {
    if (typeof window === 'undefined') return false;

    const params = new URLSearchParams(window.location.search);
    const flag   = params.get('v2');

    if (flag === '1') {
        try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
        return true;
    }
    if (flag === '0') {
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
        return false;
    }

    if (window.location.hostname.includes('preview')) return true;

    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (_) {
        return false;
    }
}

export function disableV2() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}

export function enableV2() {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (_) {}
}
