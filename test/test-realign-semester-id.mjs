/**
 * scripts/lib/semester-realign.js 單元測試：公式與正式模組逐日一致、planRealign 分類正確。
 * 執行：node test/test-realign-semester-id.mjs
 */
import { createRequire } from 'module';
import { dateToSemesterId } from '../src/js/modules/v2/semesterUtils.js';
const require = createRequire(import.meta.url);
const { dateToSemesterId: scriptFn, planRealign } = require('../scripts/lib/semester-realign.js');

let pass = 0, fail = 0;
const eq = (a, b, l) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.error(`✗ ${l}：預期 ${JSON.stringify(b)}，實得 ${JSON.stringify(a)}`); } };

// 2024～2029 逐日比對（含閏年、含不存在日期）
let diff = 0;
for (let y = 2024; y <= 2029; y++) for (let m = 1; m <= 13; m++) for (let d = 1; d <= 32; d++) {
    const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (scriptFn(s) !== dateToSemesterId(s)) diff++;
}
eq(diff, 0, '腳本公式與 semesterUtils.dateToSemesterId 逐日一致');

const archived = new Set(['114-2']);
const plan = planRealign([
    { id: 'ok',      data: { semesterId: '115-1', date: '2026-11-17' } },
    { id: 'early',   data: { semesterId: '115-1', date: '2027-02-01' } },   // 預登下學期第一天，舊語意記成目前學期
    { id: 'late',    data: { semesterId: '115-2', date: '2027-01-31' } },   // 補登上學期最後一天
    { id: 'arch',    data: { semesterId: '115-1', date: '2026-07-31' } },   // 推算 114-2，已封存
    { id: 'nosid',   data: { date: '2026-11-17' } },
    { id: 'baddate', data: { semesterId: '115-1', date: '2027-02-31' } },
    { id: 'nodate',  data: { semesterId: '115-1' } },
], archived);
eq(plan.ok, 1, '一致 1 筆');
eq(plan.mismatched, [{ id: 'early', from: '115-1', to: '115-2', date: '2027-02-01' }, { id: 'late', from: '115-2', to: '115-1', date: '2027-01-31' }], '不一致可校正');
eq(plan.blockedByArchive.map(x => x.id), ['arch'], '已封存不自動改');
eq(plan.noSemesterId.map(x => x.id), ['nosid'], '缺 semesterId 交 backfill');
eq(plan.unresolved.map(x => x.id), ['baddate', 'nodate'], 'date 不合法／缺漏');

// 拼錯的旗標必須被拒（exit 2），不可默默當成 dry-run
import { spawnSync } from 'node:child_process';
const r = spawnSync('node', ['scripts/realign-semester-id.js', '--aply'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
eq(r.status, 2, '未知旗標 --aply → exit 2');
eq(/未知參數/.test(r.stderr), true, '未知旗標 → 訊息說明');
eq(/dry-run/.test(r.stdout), false, '未知旗標 → 沒有繼續往下執行');

console.log(`\n[realign-semester-id] ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
