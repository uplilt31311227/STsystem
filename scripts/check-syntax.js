#!/usr/bin/env node
/**
 * 語法檢查工具（CI 與本機共用）
 *
 * 對 src/js 目錄（含子目錄）與 scripts 目錄（僅頂層）下所有 .js 檔逐一做語法檢查，
 * 有語法錯誤時列出檔名與錯誤訊息並以非零狀態碼結束。
 *
 * 用法：node scripts/check-syntax.js
 *      （或 npm run check）
 *      node scripts/check-syntax.js --self-test   只跑反例自測
 *
 * ⚠ ES module 檢查（2026-11 修正）：src/js 下的檔案是 ES module，但 package.json 沒有 "type":"module"，
 * 對這種檔案直接 `node --check file.js` 會用 CommonJS 規則解析——實測含「單引號字串內斷行」之類真正的
 * 語法錯誤時仍回傳 0（抓不到）。改為把檔案內容從 stdin 餵給 `node --check --input-type=module`，
 * 一律以 ES module 解析；scripts/ 下是 CommonJS，沿用原本的 `node --check file`。
 * 每次執行都會先跑反例自測（確認「壞的 ESM／壞的 CJS 一定被抓到、好的一定通過」），自測失敗就中止。
 *
 * 對應 .github/workflows/test.yml 的「Syntax check」步驟，確保本機與 CI 行為一致。
 */
const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function collectJsFiles(relDir, { recursive }) {
    const dir = path.join(ROOT, relDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive })
        .filter(name => name.endsWith('.js'))
        .map(name => path.join(dir, name))
        .filter(full => fs.statSync(full).isFile());
}

/** 以 ES module 規則檢查原始碼文字；回傳 { ok, message }。 */
function checkEsmSource(source) {
    const r = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: source, encoding: 'utf8' });
    return { ok: r.status === 0, message: String(r.stderr || '').trim() };
}

/** 以 CommonJS 規則檢查檔案；回傳 { ok, message }。 */
function checkCjsFile(file) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return { ok: r.status === 0, message: String(r.stderr || '').trim() };
}

/**
 * 反例自測：證明檢查器真的會抓錯。
 *   - 壞的 ESM（含 import／export、字串內斷行、括號不成對）必須失敗
 *   - 好的 ESM（含頂層 await）必須通過
 *   - 壞的 CJS 必須失敗
 */
function selfTest() {
    const NL = String.fromCharCode(10);   // 真正的換行字元（避免在原始碼裡寫跳脫序列被誤處理）
    const results = [];
    const expect = (name, got, want) => results.push({ name, pass: got === want });
    expect('壞的 ESM（字串內斷行）被抓到',
        checkEsmSource(["import a from 'x';", "export const b = 'abc", "def';", ''].join(NL)).ok, false);
    expect('壞的 ESM（括號不成對）被抓到',
        checkEsmSource(['export function f() {', '  return (1 + ;', '}', ''].join(NL)).ok, false);
    expect('好的 ESM（含 import／export／頂層 await）通過',
        checkEsmSource(["import a from 'x';", 'export const b = await Promise.resolve(1);', ''].join(NL)).ok, true);
    const tmp = path.join(os.tmpdir(), `check-syntax-selftest-${process.pid}.js`);
    fs.writeFileSync(tmp, ["const a = require('x');", "module.exports = 'abc", ";", ''].join(NL));
    try { expect('壞的 CJS 被抓到', checkCjsFile(tmp).ok, false); } finally { fs.rmSync(tmp, { force: true }); }
    return results;
}

const selfResults = selfTest();
for (const r of selfResults) console.log(`  ${r.pass ? '✓' : '✗'} 自測：${r.name}`);
if (selfResults.some(r => !r.pass)) {
    console.error('\n❌ 語法檢查器自測失敗：它抓不到已知的語法錯誤，結果不可信，已中止。');
    process.exit(2);
}
if (process.argv.includes('--self-test')) {
    console.log('\n自測通過');
    process.exit(0);
}
console.log('');

const targets = [
    ...collectJsFiles('src/js', { recursive: true }).map(file => ({ file, esm: true })),
    ...collectJsFiles('scripts', { recursive: false }).map(file => ({ file, esm: false })),
];

console.log(`🔍 語法檢查（src/js 以 ES module、scripts 以 CommonJS）共 ${targets.length} 個檔案\n`);

let failed = 0;
for (const { file, esm } of targets) {
    const rel = path.relative(ROOT, file);
    const r = esm ? checkEsmSource(fs.readFileSync(file, 'utf8')) : checkCjsFile(file);
    if (r.ok) {
        console.log(`  ✓ ${rel}`);
    } else {
        failed++;
        console.error(`  ✗ ${rel}`);
        console.error(r.message.split('\n').map(l => `      ${l}`).join('\n'));
    }
}

console.log(`\n結果：${targets.length - failed} 通過，${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);
