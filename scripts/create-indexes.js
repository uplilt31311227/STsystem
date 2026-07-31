#!/usr/bin/env node
/**
 * Firestore 複合索引建立（依 firestore.indexes.json）
 *
 * 用法：node scripts/create-indexes.js [--dry-run] [--wait] [--school=<id>]
 *   --dry-run : 只列出「現有 vs 待建立」的比對計畫，不建立（預設不帶時才會實際建立）
 *   --wait    : 建立後輪詢直到全部索引狀態為 READY（每 15 秒查一次，最多 20 分鐘）
 *
 * 認證與 API 慣例比照 scripts/firestore-health-check.js：
 *   gcloud 個人帳號 token + Firestore Admin REST API。
 *   建立端點：POST /v1/projects/{p}/databases/(default)/collectionGroups/{cg}/indexes
 *   查詢端點：GET  同路徑（列出該 collection group 的全部索引與狀態）
 *
 * 冪等：建立前先列出既有索引，欄位組合完全相同者跳過；重複建立時 API 會回
 * ALREADY_EXISTS，也視為成功。索引建置為非同步作業（state: CREATING → READY），
 * 部署 client 前必須等到 READY（見 docs/STAGE0-DEPLOY.md 的硬性順序）。
 */
const { execSync } = require('child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT = 'stsystem-9d5fe';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)`;
const DRY_RUN = process.argv.includes('--dry-run');
const WAIT = process.argv.includes('--wait');

function getToken() {
    return execSync('gcloud auth print-access-token --account=uplilt31311227@gmail.com')
        .toString().trim();
}

async function api(method, p, body) {
    const res = await fetch(`${BASE}/${p}`, {
        method,
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

/** 欄位組合的正規化簽章，用於比對「這條索引是否已存在」 */
function sig(collectionGroup, fields) {
    const fieldSig = fields
        .filter(f => f.fieldPath !== '__name__') // API 回傳會自動附上 __name__，比對時忽略
        .map(f => `${f.fieldPath}:${f.order || f.arrayConfig}`)
        .join(',');
    return `${collectionGroup}|${fieldSig}`;
}

async function listExisting(collectionGroup) {
    const { status, json } = await api('GET', `collectionGroups/${collectionGroup}/indexes`);
    if (status !== 200) throw new Error(`列出 ${collectionGroup} 索引失敗：HTTP ${status} ${JSON.stringify(json).slice(0, 200)}`);
    return json.indexes || [];
}

(async () => {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
    const wanted = spec.indexes;
    const groups = [...new Set(wanted.map(i => i.collectionGroup))];

    const existing = new Map(); // sig → index 物件
    for (const g of groups) {
        for (const idx of await listExisting(g)) {
            existing.set(sig(g, idx.fields), idx);
        }
    }

    const toCreate = [];
    console.log(`📋 索引比對（firestore.indexes.json 共 ${wanted.length} 條）：`);
    for (const w of wanted) {
        const s = sig(w.collectionGroup, w.fields);
        const hit = existing.get(s);
        const label = `${w.collectionGroup}（${w.fields.map(f => `${f.fieldPath} ${f.order === 'ASCENDING' ? '↑' : '↓'}`).join(', ')}）`;
        if (hit) {
            console.log(`  ✓ 已存在（${hit.state}）：${label}`);
        } else {
            console.log(`  + 待建立：${label}`);
            toCreate.push(w);
        }
    }

    if (DRY_RUN) {
        console.log(`\n（--dry-run：待建立 ${toCreate.length} 條，未執行）`);
        return;
    }

    for (const w of toCreate) {
        const { status, json } = await api('POST', `collectionGroups/${w.collectionGroup}/indexes`, {
            queryScope: w.queryScope,
            fields: w.fields,
        });
        if (status === 200) {
            console.log(`  🚀 已送出建立：${w.collectionGroup}（作業：${(json.name || '').split('/').pop()}）`);
        } else if (status === 409) {
            console.log(`  ✓ API 回報已存在：${w.collectionGroup}`);
        } else {
            throw new Error(`建立 ${w.collectionGroup} 索引失敗：HTTP ${status} ${JSON.stringify(json).slice(0, 300)}`);
        }
    }

    if (!WAIT) {
        console.log('\n已送出全部建立請求。索引建置需數分鐘，用 --wait 或重跑本腳本（--dry-run）查狀態。');
        return;
    }

    const deadline = Date.now() + 20 * 60 * 1000;
    for (;;) {
        const states = [];
        for (const g of groups) {
            for (const idx of await listExisting(g)) {
                const s = sig(g, idx.fields);
                if (wanted.some(w => sig(w.collectionGroup, w.fields) === s)) {
                    states.push({ label: s, state: idx.state });
                }
            }
        }
        const notReady = states.filter(x => x.state !== 'READY');
        console.log(`⏳ ${new Date().toLocaleTimeString()} 狀態：READY ${states.length - notReady.length}/${wanted.length}`);
        if (states.length >= wanted.length && notReady.length === 0) {
            console.log('✅ 全部索引 READY。');
            return;
        }
        if (Date.now() > deadline) {
            console.error('❌ 超過 20 分鐘仍未全部 READY，請至 Firebase Console 查看。');
            process.exit(1);
        }
        await new Promise(r => setTimeout(r, 15000));
    }
})().catch(e => { console.error('❌', e.message); process.exit(2); });
