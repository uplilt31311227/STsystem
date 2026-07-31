#!/usr/bin/env node
/**
 * 語法檢查工具（CI 與本機共用）
 *
 * 對 src/js 目錄（含子目錄）與 scripts 目錄（僅頂層）下所有 .js 檔逐一執行 node --check，
 * 有語法錯誤時列出檔名與錯誤訊息並以非零狀態碼結束。
 *
 * 用法：node scripts/check-syntax.js
 *      （或 npm run check）
 *
 * 對應 .github/workflows/test.yml 的「Syntax check」步驟，確保本機與 CI 行為一致。
 */
const { execFileSync } = require('child_process');
const fs   = require('fs');
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

const targets = [
    ...collectJsFiles('src/js', { recursive: true }),
    ...collectJsFiles('scripts', { recursive: false }),
];

console.log(`🔍 語法檢查（node --check）共 ${targets.length} 個檔案\n`);

let failed = 0;
for (const file of targets) {
    const rel = path.relative(ROOT, file);
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        console.log(`  ✓ ${rel}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${rel}`);
        const msg = String(e.stderr || e.message).trim();
        console.error(msg.split('\n').map(l => `      ${l}`).join('\n'));
    }
}

console.log(`\n結果：${targets.length - failed} 通過，${failed} 失敗`);
process.exit(failed === 0 ? 0 : 1);
