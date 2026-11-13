/**
 * e2e 網路防線的分類規則（純 node、離線）
 * 執行：node test/test-e2e-netguard.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { classifyRequest, E2E_CHROMIUM_ARGS, BLOCKED_DOMAINS } from './e2e/netGuard.mjs';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => { cond ? passed++ : failed++; process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + detail}\n`); };
const act = (u) => classifyRequest(u).action;

for (const u of ['http://localhost:8000/index.html', 'http://127.0.0.1:8080/v1/projects/demo-stsystem/x', 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp', 'data:text/html,x', 'blob:http://localhost:8000/abc'])
    check(`放行：${u}`, act(u) === 'allow', act(u));
for (const u of ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js'])
    check(`放行 CDN：${u}`, act(u) === 'allow', act(u));
for (const u of [
    'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel', 'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
    'https://securetoken.googleapis.com/v1/token', 'https://content-firebaseappcheck.googleapis.com/v1/projects/x:exchangeRecaptchaV3Token',
    'https://firebaseinstallations.googleapis.com/v1/projects/x/installations', 'https://stsystem-9d5fe.firebaseapp.com/__/auth/handler',
    'https://www.google.com/recaptcha/api.js?render=abc', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', 'https://www.recaptcha.net/recaptcha/api.js',
    'https://apis.google.com/js/api.js', 'https://accounts.google.com/gsi/client',
]) check(`違規：${u}`, act(u) === 'violation', act(u));
for (const u of ['https://fonts.gstatic.com/s/x.woff2', 'https://example.com/a.js', 'https://evil.cdnjs.cloudflare.com.attacker.io/x.js', 'not a url'])
    check(`其他外部一律攔截：${u}`, act(u) === 'block', act(u));
check('www.gstatic.com 非 firebasejs 路徑不放行', act('https://www.gstatic.com/other/x.js') === 'block', act('https://www.gstatic.com/other/x.js'));
check('封鎖清單涵蓋 googleapis／google／gstatic／firebaseapp／firebaseio／web.app／recaptcha',
    ['googleapis.com', 'google.com', 'gstatic.com', 'firebaseapp.com', 'firebaseio.com', 'web.app', 'recaptcha.net'].every(d => BLOCKED_DOMAINS.includes(d)));
check('封鎖清單中的每個網域，其網址（含子網域）classifyRequest 都判為 violation',
    BLOCKED_DOMAINS.every(d => classifyRequest(d === 'gstatic.com' ? 'https://www.gstatic.com/recaptcha/x' : `https://x.${d}/x`).action === 'violation'));
check('阻擋不使用全域 catch-all route，也不使用 DNS 規則（實測會拖垮 Firestore 連線）',
    E2E_CHROMIUM_ARGS.length === 0 && !/page\.route\(['"`]\*\*/.test(readFileSync(new URL('./e2e/netGuard.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));

/* v2-redirect.js：轉址必須保留既有查詢參數（尤其 emu=1）、路徑與 hash */
function redirectOf(url) {
    const u = new URL(url);
    let replaced = null;
    const win = { location: { search: u.search, hostname: u.hostname, pathname: u.pathname, hash: u.hash, replace: (x) => { replaced = x; } } };
    win.top = win; win.self = win;
    vm.runInNewContext(readFileSync(new URL('../src/js/v2-redirect.js', import.meta.url), 'utf8'), { window: win, URLSearchParams, document: { documentElement: { style: {} } } });
    return replaced;
}
check('轉址：?emu=1 → /?emu=1&v2=1（保留 emu）', redirectOf('http://localhost:8000/?emu=1') === '/?emu=1&v2=1', String(redirectOf('http://localhost:8000/?emu=1')));
check('轉址：保留其他參數與 hash', redirectOf('http://localhost:8000/?emu=1&x=1#settings') === '/?emu=1&x=1&v2=1#settings', String(redirectOf('http://localhost:8000/?emu=1&x=1#settings')));
check('轉址：已帶 v2=1 不轉址', redirectOf('http://localhost:8000/?v2=1&emu=1') === null);

process.stdout.write(`\n${failed ? '失敗' : '全部通過'}：通過 ${passed}、失敗 ${failed}\n`);
process.exit(failed ? 1 : 0);
