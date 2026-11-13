/**
 * 還原批次大小校準（emulator）：實測 backupService 的 writeBatch 在 firestore.rules 下最多能放幾筆。
 * 規則引擎有「單次請求 1000 個運算式」與「批次寫入的文件存取呼叫（get／exists）上限」兩道限制，
 * 值取決於規則實作，不能用猜的。用法：node test/emulator/calibrate-restore-batch.mjs
 * 輸出每個批次大小的結果，並印出建議值（最大成功值的一半，取整）。
 */
import { assertEmulator, commitBatch } from './emu-client.mjs';
import { setup, as, SCHOOL } from './kit.mjs';

await assertEmulator();
const W = await setup();
const { fixture, dir } = W;
const ROOT = `schools/${SCHOOL}`;
const tpl = fixture.substituteRecords.find(r => r.private);
const semesterId = fixture.config.currentSemester;

let seq = 0;
// 最壞情況的 private：allowedTeacherIds 放滿 30 個（rules idList30 的上限），表達式成本最高
const worstPrivate = { ...tpl.private, allowedTeacherIds: Array.from({ length: 30 }, (_, i) => `tch_w${String(i).padStart(2, '0')}`) };
const recordWrites = (n, withPrivate, priv = tpl.private) => {
    const w = [];
    for (let i = 0; i < n; i++) {
        const id = `rec_calib_${Date.now()}_${seq++}`;
        if (withPrivate) w.push({ set: `${ROOT}/substituteRecords/${id}/private/detail`, data: priv });
        w.push({ set: `${ROOT}/substituteRecords/${id}`, data: { ...tpl.public, semesterId } });
    }
    return w;
};
const teacherWrites = (n) => {
    const w = [];
    for (let i = 0; i < n; i++) {
        const id = `tch_calib_${Date.now()}_${seq++}`;
        const email = `calib${seq}@alpha.demo.test`;
        w.push({ set: `${ROOT}/teachers/${id}`, data: { name: `校準${seq}`, email, role: 'teacher', domains: [], homeroomClass: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
        w.push({ set: `${ROOT}/emailIndex/${email}`, data: { teacherId: id } });
    }
    return w;
};

async function probe(label, make, sizes) {
    let maxOk = 0;
    for (const n of sizes) {
        const res = await commitBatch(make(n), as(dir));
        console.log(`${label} 批次 ${String(n).padStart(3)} 筆（${make(n).length} 個寫入）：${res.ok ? '成功' : `失敗 HTTP ${res.status} ${String(res.error).slice(0, 110)}`}`);
        if (res.ok) maxOk = n; else break;
    }
    return maxOk;
}

const recMax = await probe('紀錄＋private/detail', (n) => recordWrites(n, true), [1, 2, 4, 6, 8, 10, 12, 16, 20, 25, 30, 40, 60]);
const recWorstMax = await probe('紀錄＋private（最壞：30 位當事人）', (n) => recordWrites(n, true, worstPrivate), [1, 2, 4, 6, 8, 10, 12, 16]);
const recNoPrivMax = await probe('紀錄（無 private）', (n) => recordWrites(n, false), [8, 16, 32, 64, 128, 250]);
const tchMax = await probe('教師＋emailIndex', teacherWrites, [1, 5, 10, 20, 30, 40, 60, 100, 150, 240]);
console.log(`\n最大成功：紀錄＋private ${recMax} 筆（最壞 private ${recWorstMax} 筆）；紀錄（無 private）${recNoPrivMax} 筆；教師＋emailIndex ${tchMax} 位`);
console.log(`建議（取最大成功值的一半，保留餘裕，且不超過 Firestore 500 寫入上限）：紀錄 ${Math.max(1, Math.floor(Math.min(recMax, recWorstMax) / 2))}、教師 ${Math.max(1, Math.floor(tchMax / 2))}`);
