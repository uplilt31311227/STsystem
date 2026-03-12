# 版本紀錄 (Changelog)

## [1.0.0] - 2026-03-12

### 新增功能
- **課表匯入**：支援人力資源網2.0匯出的 CSV/Excel 課表檔案
- **調代課申請**：
  - 智慧推薦演算法（同領域優先、導師班級加分、空堂教師篩選）
  - 異動類型區分：代課（他人代理授課）/ 調課（兩位教師互換）
  - 假別選擇：公假、事假、病假、休假、其他
  - 公假字號動態欄位（選擇公假時必填）
  - 調課班級驗證（僅顯示同時段有相同班級的教師可互換）
- **PDF 通知單生成**：
  - 四聯單輸出（原任課教師、代課教師、班級公告、教學組存查）
  - html2canvas 中文字型支援
  - 僅顯示異動課程，其他節次留空
- **調課紀錄**：依日期、教師篩選查詢
- **月結算報表**：
  - 假別區分計算邏輯
  - 公假/調課不扣時數（學校公費支付/互換）
  - 事假/病假/休假/其他扣減時數
  - Excel 匯出功能
- **Google Sheets 雲端同步**：
  - Apps Script Web App 後端
  - 支援新增、更新、刪除、批次同步
  - 欄位：ID、異動類型、日期、星期、節次、班級、科目、領域、原任課教師、代課教師、假別代碼、假別名稱、公假字號、事由、建立時間

### 技術架構
- 純前端 SPA（可部署於 GitHub Pages）
- ES6 模組化設計
- CDN 引入：PapaParse、jsPDF、jsPDF-AutoTable、SheetJS (xlsx)、html2canvas
- LocalStorage 本地儲存
- Playwright E2E 測試

### 檔案結構
```
STsystem/
├── index.html              # 主頁面
├── src/
│   ├── css/
│   │   └── style.css       # 樣式表
│   └── js/
│       ├── app.js          # 主應用程式
│       └── modules/
│           ├── dataManager.js         # 資料管理
│           ├── scheduleParser.js      # 課表解析
│           ├── recommendationEngine.js # 推薦引擎
│           ├── pdfGenerator.js        # PDF 生成
│           └── settlementCalculator.js # 月結算計算
├── google-apps-script/
│   └── Code.gs             # Google Apps Script 後端
└── test/
    ├── test-runner.html    # 測試頁面
    └── test-data.csv       # 測試資料
```
