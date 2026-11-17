#!/usr/bin/env node
/**
 * rules v2.17 的變異測試（P9 批次 A2）：逐條「暫時拿掉」新限制，確認 rules-p9-authz.mjs 對應的 ATTACK 案例轉為 ALLOW 而失敗，
 * 然後還原 firestore.rules 並用 cmp（位元組比對）確認與原檔完全相同。
 *
 * 做法：備份原檔 → 套用單一文字變異（from→to，必須剛好出現一次）→ 以 emulators:exec 跑 rules-p9-authz.mjs →
 * 解析輸出的 ❌ 案例 → 還原並 cmp。基準（未變異）必須先全數通過。任何一輪結束（含例外、Ctrl+C）都會還原。
 *
 * 用法：node test/emulator/mutate-p9.mjs            # 全部變異
 *       node test/emulator/mutate-p9.mjs M-L9-gate  # 只跑指定編號
 * 只用 emulator（--project demo-stsystem），不連正式 Firebase；不 commit。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RULES = path.join(ROOT, 'firestore.rules');
const BACKUP = path.join(os.tmpdir(), `firestore.rules.p9-mutation-backup-${process.pid}`);
const CMD = 'npx firebase emulators:exec --project demo-stsystem --only auth,firestore "node test/emulator/rules-p9-authz.mjs"';

const MUTATIONS = [
    { id: 'M-L9-gate', desc: '拿掉 isInitialDirector 的旗標檢查（白名單永不失效）',
      from: "        && configDoc(schoolId).get('directorEstablished', false) != true\n", to: '',
      expect: ['L9-ATK'] },
    { id: 'M-L9-flag', desc: '拿掉旗標單向閘（directorFlagKept 恆真，旗標可改回 false／拿掉）',
      from: "    function directorFlagKept(docId) {\n      return docId != 'main'", to: "    function directorFlagKept(docId) {\n      return true || docId != 'main'",
      expect: ['L9-FLAG'] },
    { id: 'M-L9-del', desc: '拿掉「已確立的 config/main 不可刪除」',
      from: "        allow delete: if isDirector(schoolId)\n          && (docId != 'main' || resource.data.get('directorEstablished', false) != true);", to: '        allow delete: if isDirector(schoolId);',
      expect: ['L9-DEL'] },
    { id: 'M-SOD', desc: '拿掉職務分離（核准分支不再檢查 isOwnRequestBlocked）',
      from: ' && !isOwnRequestBlocked(od, me))', to: ')',
      expect: ['SOD-ATK'] },
    { id: 'M-SOD-selfonly', desc: '自我調課例外恆成立（isSelfOnlyRequest 恆真）',
      from: "    function isSelfOnlyRequest(od, id) {\n      return od.get('isSelfSwap', false) == true", to: "    function isSelfOnlyRequest(od, id) {\n      return true || od.get('isSelfSwap', false) == true",
      expect: ['SOD-ATK'] },
    { id: 'M-PA-actor', desc: '核准／駁回的 approvedBy／rejectedBy 不再必須是本人（isActorId 恆真）',
      from: "      return id is string && ((me != '' && id == me)", to: "      return true || id is string && ((me != '' && id == me)",
      expect: ['PA-ID'] },
    { id: 'M-PA-actor-pa', desc: '拿掉 isActorId 的 isPlatformAdmin()（任何人都能以 request.auth.uid 當 approvedBy／rejectedBy）',
      from: "|| (isPlatformAdmin() && id == request.auth.uid));", to: "|| (id == request.auth.uid));",
      expect: ['PA-UID'] },
    { id: 'M-PA-log', desc: '拿掉 platformAdmin 日誌 actor.teacherId 必須是自己的檢查',
      from: "          || (isPlatformAdmin()\n            && d.actor.teacherId == request.auth.uid\n", to: "          || (isPlatformAdmin()\n",
      expect: ['PA-ID'] },
    { id: 'M-PA-log-role', desc: '拿掉 platformAdmin 日誌 actor.role 只能是 director／空 的限制',
      from: "            && string(d.actor.get('name', '')).size() <= 100" + String.fromCharCode(10) + "            && d.actor.get('role', null) in [null, 'director'])", to: "            && string(d.actor.get('name', '')).size() <= 100)",
      expect: ['PA-ID'] },
    { id: 'M-PA-log-name', desc: '拿掉 platformAdmin 日誌 actor.name 長度上限',
      from: "            && string(d.actor.get('name', '')).size() <= 100" + String.fromCharCode(10) + "            && d.actor.get('role', null) in [null, 'director'])", to: "            && d.actor.get('role', null) in [null, 'director'])",
      expect: ['PA-ID'] },
    { id: 'M-PA-roster', desc: 'platformAdmins 改為 platformAdmin 可寫（可新增、修改、刪除名冊）',
      from: "      allow read:  if isSignedIn() && request.auth.uid == uid;\n      allow write: if false;", to: "      allow read:  if isSignedIn() && request.auth.uid == uid;\n      allow write: if isPlatformAdmin();",
      expect: ['PA-ROSTER'] },
    { id: 'M-PA-read', desc: 'canReadSchool 恆真（任何登入者可讀任何學校）',
      from: "    function canReadSchool(schoolId) {\n      return isMember(schoolId) || isPlatformAdmin();", to: "    function canReadSchool(schoolId) {\n      return true;",
      expect: ['PA-READ'] },
    { id: 'M-PA-gate', desc: 'isPlatformAdmin 不再查名冊（任何登入者都是 platformAdmin）',
      from: "      return isSignedIn()\n        && exists(/databases/$(database)/documents/platformAdmins/$(request.auth.uid));", to: '      return isSignedIn();',
      expect: ['PA-READ', 'L9-ATK'] },
];

function run() {
    const r = spawnSync(CMD, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    const failed = out.split('\n').filter(l => l.includes('❌') || l.includes('💥')).map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim());
    const summary = out.split('\n').find(l => l.includes('通過') && l.includes('/')) || '(無摘要)';
    return { status: r.status, failed, summary: summary.trim(), out };
}

function cmpOriginal() {
    return Buffer.compare(fs.readFileSync(RULES), fs.readFileSync(BACKUP)) === 0;
}

function restore() {
    if (fs.existsSync(BACKUP)) fs.copyFileSync(BACKUP, RULES);
}

fs.copyFileSync(RULES, BACKUP);
process.on('SIGINT', () => { restore(); process.exit(130); });
const only = process.argv.slice(2);
let bad = 0;
try {
    const base = run();
    console.log(`基準（未變異）：${base.summary}，失敗 ${base.failed.length}`);
    if (base.status !== 0) { console.error('❌ 基準必須全數通過，中止'); base.failed.forEach(l => console.error('   ' + l)); process.exit(1); }

    for (const m of MUTATIONS) {
        if (only.length && !only.includes(m.id)) continue;
        const original = fs.readFileSync(BACKUP, 'utf8');
        const count = original.split(m.from).length - 1;
        if (count !== 1) { console.error(`❌ ${m.id}：變異目標文字出現 ${count} 次（必須剛好 1 次）`); bad++; continue; }
        fs.writeFileSync(RULES, original.replace(m.from, () => m.to), 'utf8');
        const res = run();
        restore();
        const hit = m.expect.map(prefix => ({ prefix, cases: res.failed.filter(l => l.includes(prefix)) }));
        const ok = hit.every(h => h.cases.length > 0);
        console.log(`\n${ok ? '✅' : '❌'} ${m.id}：${m.desc}`);
        console.log(`   變異後：${res.summary}`);
        for (const h of hit) {
            console.log(`   預期轉 ALLOW 而失敗的案例（${h.prefix}）：${h.cases.length ? h.cases.length + ' 個' : '沒有！變異未被測試抓到'}`);
            h.cases.slice(0, 2).forEach(l => console.log('     ' + l.slice(0, 110)));
        }
        const others = res.failed.filter(l => !m.expect.some(p => l.includes(p)));
        if (others.length) console.log(`   其他連帶失敗：${others.length} 個（${others.map(l => l.slice(2, 14)).join('、')}）`);
        if (!ok) bad++;
    }
} finally {
    restore();
    const same = cmpOriginal();
    console.log(`\n還原後 firestore.rules 與原檔位元組比對（cmp）：${same ? '相同' : '不同！請立刻檢查'}`);
    try { fs.unlinkSync(BACKUP); } catch (_) { /* 忽略 */ }
    if (!same) process.exitCode = 1;
}
if (bad) { console.error(`\n❌ ${bad} 個變異未被抓到或無法套用`); process.exitCode = 1; }
else console.log('\n✅ 全部變異都被測試抓到');
