#!/usr/bin/env node
/**
 * LC-L7／LF-M8（rules v2.18）：校正 substituteRecords／pendingRequests 的 semesterId
 *
 * 背景：v2.18 起紀錄與申請的學期歸屬依該筆 date 推算。v2.18 之前寫入的文件，semesterId 是「建立（或核准）當下的
 * 目前學期」，若 date 落在別的學期（換學期前預登下學期、換學期後補登上學期），兩者不一致。
 * 月結算依日期取資料，不受影響；影響的是「學期檢視／封存／歷史學期刪除鎖」的歸屬。
 *
 * 用法：
 *   node scripts/realign-semester-id.js [--school=<id>]            # 預設 dry-run，只列出不一致的文件
 *   node scripts/realign-semester-id.js [--school=<id>] --apply    # 才實際把 semesterId 改成依日期推算的值
 *
 * 規則：
 *   - 只處理 semesterId 為字串且與日期推算結果不同的文件；缺 semesterId 的交給 backfill-semester-id.js。
 *   - 推算結果落在「已封存學期」（archives/{id} 存在）者不自動改，只列出（封存後該學期不應再出現紀錄）。
 *   - date 缺漏或不合法者只列出（UNRESOLVED）。
 *   - 只改 semesterId 一個欄位（PATCH updateMask），經 Admin 憑證寫入，不受 Security Rules 限制。
 * 認證與安全：沿用 scripts/lib/script-safety.js（預設 dry-run、--apply 才寫、目標專案橫幅）。
 * exit code：0 = 無待處理；1 = 有不一致／無法處理的文件（dry-run 或有略過）；2 = 執行中斷。
 */
const safety = require('./lib/script-safety');
const { planRealign, buildCommitBody } = require('./lib/semester-realign');

const _argv = process.argv.slice(2);
const _bad = safety.findUnknownFlags(_argv, ['--apply', '--dry-run', '--dry-run=true'], ['--school=', '--project=', '--account=']);
if (_bad.length) { console.error(`❌ 未知參數：${_bad.join(' ')}（拼錯的旗標不會被當成 dry-run 默默執行）`); process.exit(2); }

const TARGET = safety.resolveTarget(process.env);
const PROJECT = TARGET.project;
const SCHOOL_ID = process.argv.find(a => a.startsWith('--school='))?.split('=')[1] || 'inhu';
const WRITE_MODE = safety.parseWriteMode(process.argv.slice(2));
const DRY_RUN = WRITE_MODE.dryRun;
safety.targetBanner(TARGET, { action: '校正紀錄 semesterId（依日期推算）', apply: WRITE_MODE.apply }).forEach(l => console.log(l));
const BASE = `${safety.databaseBase(TARGET)}/documents`;

const getToken = () => safety.getAccessToken(TARGET, safety.resolveOperatorAccount(process.argv.slice(2), process.env, TARGET));
const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Goog-User-Project': PROJECT });

async function listCollection(path) {
    let all = [], pageToken;
    do {
        const qs = new URLSearchParams({ pageSize: '300' });
        if (pageToken) qs.set('pageToken', pageToken);
        const res = await fetch(`${BASE}/${path}?${qs}`, { headers: headers(getToken()) });
        if (!res.ok) throw new Error(`${res.status} LIST ${path}\n${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        if (data.documents) all = all.concat(data.documents);
        pageToken = data.nextPageToken;
    } while (pageToken);
    return all;
}
async function patchSemesterId(docPath, semesterId, updateTime) {
    // 用 :commit 並帶 currentDocument.updateTime 前置條件：規劃（列出）之後文件若被別人改過就拒寫，不蓋掉新內容
    const res = await fetch(`${BASE}:commit`, {
        method: 'POST', headers: headers(getToken()), body: JSON.stringify(buildCommitBody(PROJECT, docPath, semesterId, updateTime)),
    });
    if (!res.ok) throw new Error(`${res.status} COMMIT ${docPath}（文件在列出之後被改動時會被拒絕，請重新執行 dry-run）
${(await res.text()).slice(0, 300)}`);
}
const str = (f) => (f && 'stringValue' in f ? f.stringValue : null);
const toDocs = (raw) => raw.map(d => ({ id: d.name.split('/').pop(), updateTime: d.updateTime, data: { semesterId: str(d.fields?.semesterId), date: str(d.fields?.date) } }));

async function main() {
    console.log(`📡 校正 semesterId → schools/${SCHOOL_ID}（專案 ${PROJECT}）${DRY_RUN ? '  [dry-run，不寫入]' : ''}\n`);
    const archived = new Set((await listCollection(`schools/${SCHOOL_ID}/archives`)).map(d => d.name.split('/').pop()));
    let pending = 0, blocked = 0;
    const plans = [];
    for (const name of ['substituteRecords', 'pendingRequests']) {
        const path = `schools/${SCHOOL_ID}/${name}`;
        const plan = planRealign(toDocs(await listCollection(path)), archived);
        plans.push({ name, path, plan });
        console.log(`===== ${name} =====`);
        console.log(`  一致：${plan.ok}；缺 semesterId（交給 backfill）：${plan.noSemesterId.length}；date 缺漏或不合法：${plan.unresolved.length}`);
        console.log(`  不一致、可校正：${plan.mismatched.length}`);
        for (const m of plan.mismatched) console.log(`    ${m.id}：date ${m.date}  ${m.from} → ${m.to}`);
        console.log(`  不一致、但推算學期已封存（不自動改）：${plan.blockedByArchive.length}`);
        for (const m of plan.blockedByArchive) console.log(`    ! ${m.id}：date ${m.date}  ${m.from} → ${m.to}（已封存）`);
        for (const u of plan.unresolved) console.log(`    ! ${u.id}：date=${u.date}`);
        pending += plan.mismatched.length;
        blocked += plan.blockedByArchive.length + plan.unresolved.length;
        console.log('');
    }
    if (DRY_RUN) {
        console.log('（dry-run（預設）：僅顯示計畫，不會寫入。確認無誤後加上 --apply 才會實際寫入）');
        process.exit(pending + blocked > 0 ? 1 : 0);
    }
    let done = 0;
    for (const { name, path, plan } of plans) {
        for (const m of plan.mismatched) { await patchSemesterId(`${path}/${m.id}`, m.to, m.updateTime); done++; }
        console.log(`  ✓ ${name}：已校正 ${plan.mismatched.length} 筆`);
    }
    console.log(`\n✅ 完成，共校正 ${done} 筆（略過 ${blocked} 筆：已封存或 date 不合法，需人工處理）`);
    process.exit(blocked > 0 ? 1 : 0);
}
main().catch(e => { console.error('\n❌ 失敗：', e.message); process.exit(2); });
