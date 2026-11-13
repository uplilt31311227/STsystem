/**
 * 課表匯入預覽的差異計算（純 node、離線）
 * 執行：node test/test-schedule-import-preview.mjs
 *
 * 涵蓋：新增／移除教師與班級、節數變化、空課表（首次匯入／解析無內容）、相同課表、
 *       解析警告彙整、目標學期與今天推算學期不一致（先開學期再匯入防呆）、名單截斷。
 * 期望值寫死，不由被測函式產生。
 */
import {
    diffScheduleSnapshots, summarizeParseWarnings, evaluateTargetSemester,
    buildImportPreviewModel, truncateList, PREVIEW_LIST_LIMIT,
} from '../src/js/modules/scheduleImportPreview.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) passed++; else failed++;
    process.stdout.write(`${cond ? '✓' : '✗'} ${name}${cond ? '' : `  ${detail}`}\n`);
}
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b), `實得 ${JSON.stringify(a)} 預期 ${JSON.stringify(b)}`);

const e = (t, c, p, w = '週一') => ({ teacher: t, className: c, weekday: w, period: p });
const OLD = {
    scheduleData: [e('王', '7年1班', '第一節'), e('王', '7年2班', '第二節'), e('李', '7年1班', '第三節'), e('陳', '8年1班', '第一節')],
    teachers: [{ name: '王' }, { name: '李' }, { name: '陳' }],
    classes: ['7年1班', '7年2班', '8年1班'],
};

/* ----- 新增／移除教師與班級、節數變化 ----- */
{
    const NEW = {
        scheduleData: [e('王', '7年1班', '第一節'), e('李', '7年1班', '第三節'), e('張', '9年1班', '第一節'), e('張', '9年1班', '第二節'), e('張', '9年1班', '第三節')],
        teachers: [{ name: '王' }, { name: '李' }, { name: '張' }],
        classes: ['7年1班', '9年1班'],
    };
    const d = diffScheduleSnapshots(OLD, NEW);
    eq('節數：4 → 5（+1）', d.entries, { old: 4, new: 5, delta: 1 });
    eq('教師數 3 → 3', [d.teachers.old, d.teachers.new], [3, 3]);
    eq('新增教師 = 張', d.teachers.added, ['張']);
    eq('消失教師 = 陳', d.teachers.removed, ['陳']);
    eq('新增班級 = 9年1班', d.classes.added, ['9年1班']);
    eq('消失班級 = 7年2班、8年1班', d.classes.removed, ['7年2班', '8年1班']);
    check('現有非空、新的非空、不相同', !d.oldEmpty && !d.newEmpty && !d.identical);
}

/* ----- 相同課表 ----- */
{
    const d = diffScheduleSnapshots(OLD, JSON.parse(JSON.stringify(OLD)));
    check('相同課表 → identical', d.identical === true);
    eq('相同課表節數差 0', d.entries.delta, 0);
    eq('相同課表無新增／消失', [d.teachers.added, d.teachers.removed, d.classes.added, d.classes.removed], [[], [], [], []]);
    // 名單相同但課程不同 → 不算 identical
    const changed = JSON.parse(JSON.stringify(OLD));
    changed.scheduleData[0].period = '第五節';
    check('名單相同但課程內容不同 → 不是 identical', diffScheduleSnapshots(OLD, changed).identical === false);
}

/* ----- 空課表 ----- */
{
    const first = diffScheduleSnapshots(null, OLD);
    check('現有為 null（尚無課表）→ oldEmpty，所有教師班級皆為新增', first.oldEmpty && first.teachers.added.length === 3 && first.classes.added.length === 3);
    const emptyShell = diffScheduleSnapshots({ scheduleData: [], teachers: [], classes: [] }, OLD);
    check('現有為空殼 → oldEmpty', emptyShell.oldEmpty === true && emptyShell.entries.delta === 4);
    const toEmpty = diffScheduleSnapshots(OLD, { scheduleData: [], teachers: [], classes: [] });
    check('新的為空 → newEmpty，教師班級全消失', toEmpty.newEmpty && toEmpty.teachers.removed.length === 3 && toEmpty.classes.removed.length === 3 && toEmpty.entries.delta === -4);
    check('兩邊皆空 → 不是 identical（沒有內容可比）', diffScheduleSnapshots(null, null).identical === false);
}

/* ----- 解析警告彙整 ----- */
{
    const w = summarizeParseWarnings([
        { row: 3, reason: '缺教師', summary: 'a' }, { row: 7, reason: '缺班級', summary: 'b' },
        { row: 9, reason: '缺教師', summary: 'c' }, { row: 12, reason: '缺教師', summary: 'd' },
    ], 4);
    check('警告總數 4', w.total === 4);
    eq('依原因分組並依數量排序', w.groups.map(g => [g.reason, g.count]), [['缺教師', 3], ['缺班級', 1]]);
    eq('缺教師的列號', w.groups[0].rows, [3, 9, 12]);
    const many = summarizeParseWarnings(Array.from({ length: 30 }, (_, i) => ({ row: i + 2, reason: '缺教師' })), 30);
    check('同一原因列號最多列 10 個，count 仍為 30', many.groups[0].rows.length === 10 && many.groups[0].count === 30);
    check('無警告 → total 0、無分組', summarizeParseWarnings([], 0).total === 0 && summarizeParseWarnings(undefined).groups.length === 0);
    check('warnings 空但 skippedCount>0 → 以 skippedCount 為 total', summarizeParseWarnings([], 5).total === 5);
}

/* ----- 目標學期防呆（先開學期再匯入） ----- */
{
    check('目標與今天推算相同 → 無警告', evaluateTargetSemester({ targetSemesterId: '115-1', todaySemesterId: '115-1' }).mismatch === false);
    const m = evaluateTargetSemester({ targetSemesterId: '115-1', todaySemesterId: '115-2' });
    check('目標 115-1、今天屬 115-2 → mismatch，訊息點名兩個學期並指引先開學期',
        m.mismatch && m.message.includes('115-1') && m.message.includes('115-2') && m.message.includes('開新學期'));
    check('V1（無目標學期）→ 不判定', evaluateTargetSemester({}).mismatch === false && evaluateTargetSemester({ targetSemesterId: null, todaySemesterId: '115-1' }).mismatch === false);
    check('今天學期未知 → 不判定為不一致', evaluateTargetSemester({ targetSemesterId: '115-1', todaySemesterId: null }).mismatch === false);
}

/* ----- 完整預覽模型 ----- */
{
    const NEW = { scheduleData: [e('王', '7年1班', '第一節')], teachers: [{ name: '王' }], classes: ['7年1班'] };
    const m = buildImportPreviewModel({
        current: OLD, incoming: NEW, fileName: 'x.xlsx',
        warnings: [{ row: 5, reason: '缺班級', summary: '' }], skippedCount: 1,
        target: { semesterId: '115-1', todaySemesterId: '115-2' },
    });
    check('模型：目標學期、willReplace、needsSemesterAck、warnings', m.targetSemesterId === '115-1' && m.willReplace && m.needsSemesterAck && m.warnings.total === 1 && m.blocked === '');
    const blocked = buildImportPreviewModel({ current: OLD, incoming: { scheduleData: [], teachers: [], classes: [] }, target: { semesterId: '115-1', todaySemesterId: '115-1' } });
    check('模型：解析無內容 → blocked 有訊息、不需勾選學期', blocked.blocked.length > 0 && blocked.needsSemesterAck === false);
    const firstTime = buildImportPreviewModel({ current: null, incoming: NEW, target: { semesterId: '115-1', todaySemesterId: '115-1' } });
    check('模型：首次匯入 → willReplace false', firstTime.willReplace === false && firstTime.diff.oldEmpty);
    const v1 = buildImportPreviewModel({ current: OLD, incoming: NEW });
    check('模型：V1（無 target）→ 無目標學期、不需勾選', v1.targetSemesterId === null && v1.needsSemesterAck === false);
}

/* ----- 只有教師、沒有課程：預覽要擋下（P5 驗收 Low）----- */
{
    const onlyTeachers = { scheduleData: [], teachers: [{ name: '王' }, { name: '李' }], classes: ['7年1班'] };
    const m = buildImportPreviewModel({ current: OLD, incoming: onlyTeachers, target: { semesterId: '115-1', todaySemesterId: '115-1' } });
    check('模型：只有教師與班級、沒有任何課程 → blocked 有訊息且點名「沒有任何課程」', m.blocked.includes('沒有任何課程') && m.blocked.length > 0);
    const m2 = buildImportPreviewModel({ current: null, incoming: onlyTeachers });
    check('模型：首次匯入但只有教師名單 → 同樣擋下', m2.blocked.length > 0);
    const ok = buildImportPreviewModel({ current: OLD, incoming: { scheduleData: [e('王', '7年1班', '第一節')], teachers: [], classes: [] } });
    check('模型：有課程（教師名單空）→ 不擋', ok.blocked === '');
}

/* ----- 名單截斷 ----- */
{
    const names = Array.from({ length: PREVIEW_LIST_LIMIT + 7 }, (_, i) => `T${i}`);
    const t = truncateList(names);
    check(`名單超過 ${PREVIEW_LIST_LIMIT} 個只顯示前 ${PREVIEW_LIST_LIMIT}，其餘計數`, t.shown.length === PREVIEW_LIST_LIMIT && t.more === 7);
    check('名單不超過上限 → 全顯示', truncateList(['a', 'b']).more === 0);
}

process.stdout.write(`\n${failed ? '失敗' : '全部通過'}：通過 ${passed}、失敗 ${failed}\n`);
process.exit(failed ? 1 : 0);
