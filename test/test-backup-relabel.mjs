/**
 * 備份還原：標目前學期、但日期屬別學期的紀錄，依日期改標學期後還原（rules v2.18）。
 * 執行：node test/test-backup-relabel.mjs
 */
import { planRestore, describeNotRestored } from '../src/js/modules/v2/backupFormat.js';

let pass = 0, fail = 0;
const eq = (a, b, l) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.error(`✗ ${l}：預期 ${JSON.stringify(b)}，實得 ${JSON.stringify(a)}`); } };

const rec = (id, date, semesterId, extra = {}) => ({ id, data: { type: '代課', date, semesterId, ...extra } });
const backup = {
    config: {}, teachers: [], schedules: [], scheduleImports: [], pendingRequests: [],
    substituteRecords: [
        rec('ok', '2026-11-17', '115-1'),                    // 一致
        rec('early', '2027-02-01', '115-1'),                 // 預登下學期，舊語意 → 改標 115-2
        rec('late', '2026-07-31', '115-1'),                  // 日期屬 114-2（上一學期）
        rec('far', '2028-03-01', '115-1'),                   // 日期屬 116-2，超出 ±1 → 略過
        rec('hist', '2026-03-01', '114-2'),                  // 本來就是歷史學期 → historical
        rec('bad', '2027-02-31', '115-1'),                   // 日期不存在 → 略過
    ],
};
const cloudBase = { teachers: [], recordIds: [], pendingIds: [], schedules: {}, configMainExists: true, settlement: null };

// 未提供封存清單：上一學期無法判斷 → 保守略過；下一學期可改標
let plan = planRestore({ backup, cloud: { ...cloudBase }, currentSemesterId: '115-1' });
eq(plan.records.create.sort(), ['early', 'ok'], '未知封存狀態：只還原一致者與下一學期改標者');
eq(plan.records.relabel, { early: '115-2' }, '改標對照');
eq(plan.records.mismatch, 4, '日期與學期不一致 4 筆（early、late、far、bad）');
eq(plan.records.mismatchSkipped, 3, '略過 3 筆');
eq(plan.records.historical, 1, '歷史學期 1 筆');

// 提供封存清單且 114-2 未封存：上一學期可改標
plan = planRestore({ backup, cloud: { ...cloudBase, archivedSemesterIds: ['113-2'] }, currentSemesterId: '115-1' });
eq(plan.records.create.sort(), ['early', 'late', 'ok'], '114-2 未封存：late 改標後可還原');
eq(plan.records.relabel, { early: '115-2', late: '114-2' }, '改標對照（含上一學期）');
eq(plan.records.mismatchSkipped, 2, '略過 far、bad');

// 114-2 已封存：略過
plan = planRestore({ backup, cloud: { ...cloudBase, archivedSemesterIds: ['114-2'] }, currentSemesterId: '115-1' });
eq(plan.records.create.sort(), ['early', 'ok'], '114-2 已封存：late 不還原');
eq(plan.records.relabel, { early: '115-2' }, '已封存者不改標');

// 提示文字：單獨列出並提示先跑 realign
const txt = describeNotRestored(plan).join('\n');
eq(/日期與學期不一致的調代課紀錄 4 筆/.test(txt) && /realign-semester-id/.test(txt), true, '提示單獨列出並建議先跑 realign');

// 目前學期非標準格式：不啟用改標
plan = planRestore({ backup: { ...backup, substituteRecords: [rec('x', '2027-02-01', 's1')] }, cloud: { ...cloudBase }, currentSemesterId: 's1' });
eq([plan.records.create, plan.records.mismatch], [['x'], 0], '非標準目前學期：維持舊行為');

console.log(`\n[backup-relabel] ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
