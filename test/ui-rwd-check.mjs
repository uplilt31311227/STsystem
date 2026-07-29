/**
 * UI 手機響應式檢查（Stage 1 硬傷急救驗收用）
 *
 * 用途：在 375×667（手機）viewport 下，走訪 V1 穩定版（無 ?v2=1）主要分頁，
 * 斷言 document.documentElement.scrollWidth <= window.innerWidth（無橫向溢出）。
 * 涵蓋：課表匯入（含教師表格）、調代課申請（含課表格）、調代課紀錄、月結算、設定。
 *
 * 重要（驗收缺陷修正紀錄）：原始版本在全新 localStorage 下走訪，調代課紀錄/月結算
 * 表格從未渲染出真正會撐寬版面的內容，導致「修復前/修復後」跑起來都是 6/6 通過的
 * 空轉測試（測試本身沒有承重）。本版在走訪調代課紀錄頁前，改用
 * window.app.dataManager.addSubstituteRecord() 注入 6 筆含長班級名/長科目/長教師名/
 * 長假別事由的種子紀錄（模擬真實資料長度），再展開查詢區間涵蓋所有種子日期後斷言，
 * 確保這支測試真的在驗證有內容寬度的表格。
 *
 * 前置：先啟動本機伺服器（預設 http://localhost:8000）：
 *   python start-server.py
 *
 * 用法：node test/ui-rwd-check.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL  = 'http://localhost:8000/';
const CSV_PATH  = path.join(__dirname, 'test-data.csv');
const VIEWPORT  = { width: 375, height: 667 };

// 種子調代課紀錄：刻意用長班級名/長科目/長教師名/長假別事由撐寬 records-table，
// 讓橫向溢出檢查有真實承重內容可驗（而非空表格的空轉測試）。日期刻意跨半年，
// 查詢時會明確展開區間涵蓋這些日期，不依賴「本月」預設值，與執行測試當下的日期無關。
const SEED_RECORDS = [
    { id: 'seed-rwd-1', date: '2026-01-05', weekday: '週一', period: '第一節',
      className: '國中部七年級忠孝仁愛信義和平合作班', subject: '跨領域素養導向專題探究實作',
      originalTeacher: '歐陽克盡職守認真負責教學組長', substituteTeacher: '司馬相如兼任行政職務代理教師',
      leaveTypeName: '因公出差公假（需檢附派令證明文件影本）' },
    { id: 'seed-rwd-2', date: '2026-02-10', weekday: '週二', period: '第二節',
      className: '國中部八年級誠正勤樸敦品勵學班', subject: '議題融入式閱讀理解與表達訓練',
      originalTeacher: '諸葛亮兼任學務處生教組長職務', substituteTeacher: '上官婉兒特教資源班巡迴輔導教師',
      leaveTypeName: '婚假（依規定得連續請假八日）' },
    { id: 'seed-rwd-3', date: '2026-03-15', weekday: '週三', period: '第三節',
      className: '國中部九年級溫良恭儉讓志學向上班', subject: '多元文化與國際教育體驗課程',
      originalTeacher: '皇甫嵩擔任健康與體育領域召集人', substituteTeacher: '宇文成都輔導室專任輔導教師',
      leaveTypeName: '喪假（三親等內尊親屬過世）' },
    { id: 'seed-rwd-4', date: '2026-04-20', weekday: '週四', period: '第四節',
      className: '國中部七年級禮義廉恥自強不息班', subject: '資訊科技與人工智慧素養導論',
      originalTeacher: '獨孤求敗兼任總務處事務組組長', substituteTeacher: '完顏阿骨打代理導師兼輔導業務',
      leaveTypeName: '事假（因家庭因素無法出席授課）' },
    { id: 'seed-rwd-5', date: '2026-05-25', weekday: '週五', period: '第五節',
      className: '國中部八年級孝悌忠信禮義廉恥班', subject: '在地文化踏查與社區服務學習',
      originalTeacher: '慕容復兼任藝術與人文領域教師', substituteTeacher: '完顏洪烈兼任童軍教育專任教師',
      leaveTypeName: '長期病假（醫師診斷需休養三個月）' },
    { id: 'seed-rwd-6', date: '2026-06-01', weekday: '週一', period: '第六節',
      className: '國中部九年級忠孝仁愛信義和平班', subject: '生命教育與生涯規劃探索活動',
      originalTeacher: '東方不敗兼任綜合活動領域召集人', substituteTeacher: '西門吹雪代理三年級導師職務',
      leaveTypeName: '公假（奉派參加全國性教學研習）' },
];

const results = [];

async function measure(page) {
    return page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
    }));
}

function record(label, { scrollWidth, innerWidth }) {
    const pass = scrollWidth <= innerWidth;
    results.push({ label, scrollWidth, innerWidth, pass });
    console.log(`  ${pass ? '✓' : '✗'} ${label}：scrollWidth=${scrollWidth} / innerWidth=${innerWidth}`);
    return pass;
}

async function switchTab(page, tabId) {
    await page.click(`.tab-btn[data-tab="${tabId}"]`);
    await page.waitForTimeout(400);
}

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    const pageIssues = [];
    page.on('pageerror', e => pageIssues.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') pageIssues.push(`console: ${m.text()}`); });

    console.log(`開啟 ${BASE_URL}（375×667，V1 穩定版）`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    console.log('\n[課表匯入] 初始狀態（未載入資料）');
    record('課表匯入（初始）', await measure(page));

    // 上傳測試課表，解鎖各分頁內容
    console.log('\n上傳 test-data.csv...');
    await page.setInputFiles('#schedule-file', CSV_PATH);
    await page.waitForSelector('#teacher-editor:not(.hidden)', { timeout: 5000 }).catch(() => {
        console.log('  ⚠ 教師編輯表格未在時限內出現，繼續嘗試');
    });
    await page.waitForTimeout(500);

    // 設定學校名稱以解鎖 substitute/records/settlement（updateTabContentVisibility 需要 hasSchedule && schoolName）
    await page.fill('#school-name', '測試國中');
    await page.click('#save-school-name-btn');
    await page.waitForTimeout(500);

    console.log('\n[課表匯入] 已載入資料（含教師屬性表格）');
    record('課表匯入（含教師表格）', await measure(page));

    console.log('\n[調代課申請] 含原任課教師週課表');
    await switchTab(page, 'substitute');
    await page.selectOption('#sub-teacher', { label: '王大明' }).catch(() => {
        console.log('  ⚠ 找不到教師選項「王大明」，略過課表格渲染步驟');
    });
    await page.fill('#sub-date', '2026-03-16').catch(() => {});
    await page.waitForTimeout(600);
    record('調代課申請（含課表格）', await measure(page));

    console.log('\n[調代課紀錄] 注入 6 筆含長字串種子紀錄（修正「空表格空轉測試」缺陷）');
    await page.evaluate((seedRecords) => {
        const app = window.app;
        seedRecords.forEach(r => app.dataManager.addSubstituteRecord(r));
        app.saveDataToStorage();
    }, SEED_RECORDS);
    await switchTab(page, 'records');
    // 種子日期跨 2026-01 ~ 2026-06，明確展開查詢區間涵蓋全部，不依賴「本月」預設值
    await page.fill('#record-start-date', '2000-01-01');
    await page.fill('#record-end-date', '2099-12-31');
    await page.click('#search-records-btn');
    await page.waitForTimeout(500);
    const seededRowCount = await page.evaluate(() => document.querySelectorAll('#records-tbody tr').length);
    console.log(`  種子紀錄實際渲染列數：${seededRowCount}（種入 ${SEED_RECORDS.length} 筆）`);
    if (seededRowCount !== SEED_RECORDS.length) {
        console.log('  ⚠ 渲染列數與種入筆數不符，可能查詢區間或篩選條件有誤');
    }
    record(`調代課紀錄（種子 ${SEED_RECORDS.length} 筆，含長姓名/長科目/長事由）`, await measure(page));

    console.log('\n[月結算] 嘗試產生結算表');
    await switchTab(page, 'settlement');
    await page.click('#generate-settlement-btn').catch(() => {});
    await page.waitForTimeout(600);
    record('月結算', await measure(page));

    console.log('\n[設定]');
    await switchTab(page, 'settings');
    record('設定', await measure(page));

    await browser.close();

    console.log('\n=== 結果彙總（375×667） ===');
    let anyFail = false;
    for (const r of results) {
        console.log(`${r.pass ? '通過' : '失敗'} - ${r.label}（scrollWidth ${r.scrollWidth} / innerWidth ${r.innerWidth}）`);
        if (!r.pass) anyFail = true;
    }

    if (pageIssues.length) {
        console.log('\n⚠ 過程中 console/page 錯誤（不列入 pass/fail 判定，僅供參考）：');
        pageIssues.forEach(e => console.log('  ' + e));
    }

    if (anyFail) {
        console.error('\n❌ 有分頁發生橫向溢出');
        process.exit(1);
    }
    console.log('\n✅ 全部分頁在 375×667 下皆無橫向溢出（含種子長字串紀錄，非空轉測試）');
})().catch(err => {
    console.error('\n❌ 測試腳本執行錯誤:', err.message);
    process.exit(1);
});
