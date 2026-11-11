/**
 * 2026-11-10 停用舊版（V1）網址：未帶 ?v2=1 且非預覽站時，一律轉址到 V2。
 * V1 個人雲端即時同步曾造成無限寫入迴圈與帳單事故（docs/ISSUES_LOG.md 2026-11-10）。
 * 判斷條件與 src/js/modules/v2/envDetector.js isV2Enabled() 一致；同步執行（classic script，
 * 解析 <head> 時阻塞載入），在任何 V1 程式載入前就轉走。保留原路徑、其他參數與 hash。
 *
 * 2026-11 資安補強：原本是 index.html 內的 inline <script>。為了讓 CSP 的 script-src 不必
 * 'unsafe-inline'，移成外部檔（行為不變）。
 */
(function () {
    var l = window.location;
    var p = new URLSearchParams(l.search);
    if (p.get('v2') === '1') return;
    if ((l.hostname || '').indexOf('preview') !== -1) return;
    if (/(^|\/)[^/]*-preview(\/|$)/.test(l.pathname || '')) return;
    p.set('v2', '1');
    l.replace(l.pathname + '?' + p.toString() + l.hash);
})();

/**
 * 防點擊劫持（審計 L4）：GitHub Pages 無法設定 X-Frame-Options／frame-ancestors，
 * meta CSP 也不支援 frame-ancestors，因此以 script 退而求其次——被別的網站嵌入 iframe 時，
 * 嘗試把最上層導回本頁，導不了就把整份文件隱藏（讓攻擊頁無法誘導使用者點擊）。
 */
(function () {
    try {
        if (window.top === window.self) return;
    } catch (e) { /* 跨來源存取 top 會丟例外 → 表示被嵌入 */ }
    try { window.top.location.href = window.self.location.href; } catch (e) { /* 跨來源可能被瀏覽器擋 */ }
    document.documentElement.style.display = 'none';
})();
