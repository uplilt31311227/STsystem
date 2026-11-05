/**
 * 課表匯入紀錄單元測試（離線，不連 Firebase）
 * 執行：node test/test-schedule-import-history.mjs
 *
 * 涵蓋：建立紀錄欄位、版本號遞增、V1 上限 10 版、還原產生新版（含 restoredFromVersion）、
 *       快照不受後續編輯影響、無紀錄／壞資料時的格式化與讀取。
 */
import {
    V1_MAX_VERSIONS, V1_HISTORY_KEY,
    createImportRecord, nextVersionNo, makeSnapshot, computeFingerprint,
    loadV1History, appendV1History, getRestorableSnapshot,
    formatImportDate, formatLastImport, formatSource,
} from '../src/js/modules/scheduleImportHistory.js';

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; }
    else { fail++; console.error(`✗ ${label}`); }
}
function eq(actual, expected, label) {
    ok(JSON.stringify(actual) === JSON.stringify(expected),
        `${label}：預期 ${JSON.stringify(expected)}，實得 ${JSON.stringify(actual)}`);
}

// 記憶體版 storage
function memStorage(quotaBytes = Infinity) {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => {
            if (v.length > quotaBytes) throw new Error('QuotaExceededError');
            m.set(k, v);
        },
    };
}

const sched = (n) => Array.from({ length: n }, (_, i) => ({ teacher: `T${i}`, className: '701', weekday: '星期一', period: '第1節' }));
const teachers = [{ name: 'T0' }, { name: 'T1' }];
const classes = ['701', '702', '703'];

// 1. 建立紀錄欄位
{
    const now = new Date('2026-11-05T08:30:00');
    const rec = createImportRecord({
        scheduleData: sched(5), teachers, classes, fileName: '114-測試國中-課表.xlsx',
        skippedCount: 2, versionNo: 3, importedBy: { name: '王小明', teacherId: 't1' }, now,
    });
    ok(typeof rec.id === 'string' && rec.id.length > 0, '紀錄有 id');
    eq(rec.versionNo, 3, '版本號');
    eq(rec.source, 'file', '預設來源 file');
    eq(rec.fileName, '114-測試國中-課表.xlsx', '檔名');
    eq(rec.counts, { entries: 5, classes: 3, teachers: 2, skipped: 2 }, '計數');
    eq(rec.importedAt, now.toISOString(), 'importedAt 為 ISO');
    eq(rec.importedBy, { name: '王小明', teacherId: 't1' }, '匯入者');
    ok(/^[0-9a-f]{8}$/.test(rec.fingerprint), '指紋為 8 碼 hex');
    ok(!('restoredFromVersion' in rec), '檔案匯入無 restoredFromVersion');
    ok(!('snapshot' in rec), '中繼資料不含快照');

    const noUser = createImportRecord({ scheduleData: sched(1) });
    eq(noUser.importedBy, null, 'V1 無匯入者為 null');
    eq(noUser.counts.skipped, 0, '預設略過 0');
}

// 2. 指紋與版本號
{
    ok(computeFingerprint(sched(3)) === computeFingerprint(sched(3)), '相同內容指紋相同');
    ok(computeFingerprint(sched(3)) !== computeFingerprint(sched(4)), '不同內容指紋不同');
    eq(nextVersionNo(null), 1, '無紀錄下一版為 1');
    eq(nextVersionNo({ versionNo: 7 }), 8, '版本號遞增');
    eq(nextVersionNo({ versionNo: 'x' }), 1, '壞版本號回到 1');
}

// 3. V1 上限 10 版
{
    const st = memStorage();
    for (let v = 1; v <= 13; v++) {
        const rec = createImportRecord({ scheduleData: sched(v), versionNo: v, fileName: `f${v}.xlsx` });
        appendV1History(rec, makeSnapshot({ scheduleData: sched(v), teachers, classes }), st);
    }
    const list = loadV1History(st);
    eq(list.length, V1_MAX_VERSIONS, 'V1 只留 10 版');
    eq(list[0].versionNo, 13, '最新在最前');
    eq(list[list.length - 1].versionNo, 4, '最舊的 1~3 版被淘汰');
    ok(list.every(e => getRestorableSnapshot(e) !== null), '每版都有快照');
}

// 4. 還原產生新版
{
    const st = memStorage();
    const v1 = createImportRecord({ scheduleData: sched(5), teachers, classes, versionNo: 1, fileName: 'a.xlsx' });
    appendV1History(v1, makeSnapshot({ scheduleData: sched(5), teachers, classes }), st);
    const v2 = createImportRecord({ scheduleData: sched(9), teachers, classes, versionNo: 2, fileName: 'b.xlsx' });
    appendV1History(v2, makeSnapshot({ scheduleData: sched(9), teachers, classes }), st);

    const target = loadV1History(st).find(e => e.versionNo === 1);
    const snap = getRestorableSnapshot(target);
    eq(snap.scheduleData.length, 5, '快照為第 1 版的 5 節');

    const restored = createImportRecord({
        scheduleData: snap.scheduleData, teachers: snap.teachers, classes: snap.classes,
        fileName: target.fileName, versionNo: nextVersionNo(v2),
        source: 'restore', restoredFromVersion: target.versionNo,
    });
    appendV1History(restored, makeSnapshot(snap), st);
    const list = loadV1History(st);
    eq(list.length, 3, '還原多出新的一版而非覆蓋');
    eq(list[0].versionNo, 3, '還原為新的第 3 版');
    eq(list[0].source, 'restore', '來源為 restore');
    eq(list[0].restoredFromVersion, 1, 'restoredFromVersion 指向第 1 版');
    eq(list[0].fingerprint, v1.fingerprint, '還原後內容指紋與第 1 版相同');
    eq(formatSource(list[0]), '還原自 v1', '來源標籤（還原）');
    eq(formatSource(list[2]), '檔案匯入', '來源標籤（檔案）');
}

// 5. 快照獨立於後續編輯
{
    const live = sched(3);
    const snap = makeSnapshot({ scheduleData: live, teachers, classes });
    live[0].teacher = '被改了';
    live.push({ teacher: 'X' });
    eq(snap.scheduleData.length, 3, '快照長度不隨編輯變');
    eq(snap.scheduleData[0].teacher, 'T0', '快照內容不隨編輯變');
}

// 6. 容量不足：丟掉最舊版重試；單版放不下則只存中繼資料
{
    const small = memStorage(2500);
    for (let v = 1; v <= 5; v++) {
        const rec = createImportRecord({ scheduleData: sched(10), versionNo: v });
        appendV1History(rec, makeSnapshot({ scheduleData: sched(10), teachers, classes }), small);
    }
    const list = loadV1History(small);
    ok(list.length >= 1 && list.length < 5, '容量不足時自動縮減版本數');
    eq(list[0].versionNo, 5, '縮減後仍保留最新版');

    const tiny = memStorage(400);
    const rec = createImportRecord({ scheduleData: sched(50), versionNo: 1 });
    appendV1History(rec, makeSnapshot({ scheduleData: sched(50), teachers, classes }), tiny);
    const l2 = loadV1History(tiny);
    eq(l2.length, 1, '單版放不下仍保留中繼資料');
    eq(getRestorableSnapshot(l2[0]), null, '該版無快照、不可還原');
}

// 7. 無紀錄／壞資料時不報錯
{
    eq(formatLastImport(null), '尚無匯入紀錄', 'null lastImport');
    eq(formatLastImport(undefined), '尚無匯入紀錄', 'undefined lastImport');
    eq(formatLastImport({}), '尚無匯入紀錄', '空物件 lastImport');
    eq(formatLastImport({ importedAt: 'garbage' }), '尚無匯入紀錄', '壞日期');
    eq(formatImportDate(''), '', '空日期');
    eq(loadV1History(memStorage()), [], '空 storage');
    const bad = memStorage();
    bad.setItem(V1_HISTORY_KEY, '{not json');
    eq(loadV1History(bad), [], '壞 JSON');
    bad.setItem(V1_HISTORY_KEY, '{"a":1}');
    eq(loadV1History(bad), [], '非陣列');
    eq(getRestorableSnapshot(null), null, 'null 條目無快照');
    eq(getRestorableSnapshot({ snapshot: {} }), null, '缺 scheduleData 無快照');
}

// 8. 格式化
{
    const d = new Date(2026, 10, 5, 8, 7); // 本機時區 2026/11/05 08:07
    eq(formatImportDate(d.toISOString()), '2026/11/05 08:07', '日期格式');
    const full = createImportRecord({
        scheduleData: sched(1), fileName: 'x.xlsx', now: d,
        importedBy: { name: '李老師', teacherId: 't2' },
    });
    eq(formatLastImport(full), '最後匯入：2026/11/05 08:07 · 李老師 · x.xlsx', '完整格式');
    const v1only = createImportRecord({ scheduleData: sched(1), fileName: 'x.xlsx', now: d });
    eq(formatLastImport(v1only), '最後匯入：2026/11/05 08:07 · x.xlsx', 'V1 省略匯入者');
}

console.log(`\n課表匯入紀錄測試：${pass} 通過，${fail} 失敗`);
if (fail > 0) process.exit(1);
