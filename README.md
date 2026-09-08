# 國中調代課自動化系統

一套純前端的國中調代課管理系統，專為台灣國中教學組設計，支援 人力資源網2.0匯出的課表格式。

> 目前正式版（`master` 分支）：**v1.13.2**｜開發中：**v2.0.0** 三層角色權限系統（`feature/permission-system` 分支，詳見 [docs/V2_PERMISSION_SYSTEM.md](docs/V2_PERMISSION_SYSTEM.md) 與 [docs/PLAN_v2.0.0.md](docs/PLAN_v2.0.0.md)）

## 功能特色

### 1. 課表匯入與智慧推薦
- 支援 Excel (.xls, .xlsx) 和 CSV 格式匯入
- 自動解析 人力資源網2.0的課表格式
- 智慧推薦代課教師（優先順序：同領域 > 班導師 > 其他空堂教師）
- 科目↔領域對應表：匯入自動擷取「科目→領域」對應，設定頁可手動增修（v1.13.0）

### 2. 調代課申請與衝突防護
- 步驟式引導介面（選教師→選類型→選課程→確認）、多節課與多重調課批次模式
- 教師自行調課功能
- 送出前衝堂攔截：代課教師重複指派、班級時段衝突皆會被擋下（v1.10.0）
- 「九年級已畢業」開關：一鍵停用九年級課程，讓相關時段教師可正常被安排調代課（v1.12.0）

### 3. PDF 通知單生成
- 一式四聯（原任課教師、代課教師、班級公告、教學組存查）
- 「列印本週彙整」：一鍵產生整週綜合 PDF，按收件方分頁，紙張耗用大幅精簡（v1.11.0）

### 4. 月結算與時數統計
- 自動計算每位教師的原定授課時數
- 統計代課增加/被代課減少時數
- 計算實際授課時數與超鐘點時數
- 支援匯出 Excel 報表

### 5. Firebase 雲端同步
- Google 帳號一鍵登入
- Firebase Realtime Database 即時同步
- 支援多設備共享調課紀錄
- 離線時自動切換本地儲存

## V2 三層角色權限系統（開發中，`feature/permission-system` 分支）

全校共用一份課表與紀錄，取代 v1.x「每位登入者各自一份資料」的模式，新增角色分權與審核工作流：

- **三層角色**：director（教務主任）／section_chief（教學組長）／teacher（一般教師），各自可見範圍與操作權不同
- **審核工作流**：代課單簽、調課雙簽、多重調課全員同意三種流程分支
- **完整操作日誌**、Email/密碼雙軌登入、教師白名單管理
- 目前僅在 preview 站與 `?v2=1` 啟用，不影響 master 正式站

相關文件：[docs/V2_PERMISSION_SYSTEM.md](docs/V2_PERMISSION_SYSTEM.md)（架構與角色）、[docs/PLAN_v2.0.0.md](docs/PLAN_v2.0.0.md)（開發進度）、[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)（部署環境）、[src/js/modules/v2/README.md](src/js/modules/v2/README.md)（模組清單）

## 技術架構

- **前端**：純 HTML + CSS + JavaScript (ES6 Modules)
- **資料儲存**：localStorage + Firebase Realtime Database
- **身份驗證**：Firebase Authentication（Google 登入）
- **部署**：可直接部署至 GitHub Pages
- **無需自建後端伺服器**

## 使用的 CDN 套件

- [PapaParse](https://www.papaparse.com/) - CSV 解析
- [SheetJS (xlsx)](https://sheetjs.com/) - Excel 讀取
- [jsPDF](https://github.com/parallax/jsPDF) - PDF 生成
- [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable) - PDF 表格

## 快速開始

### 本地測試

1. 使用 Python 啟動簡易伺服器：
   ```bash
   python start-server.py
   ```

2. 或使用其他 HTTP 伺服器：
   ```bash
   # Node.js
   npx serve

   # Python 3
   python -m http.server 8000
   ```

3. 開啟瀏覽器訪問 `http://localhost:8000`

### 部署到 GitHub Pages

1. 建立 GitHub Repository
2. 將專案檔案推送到 `main` 分支
3. 在 Repository Settings > Pages 中啟用 GitHub Pages
4. 選擇 `main` 分支作為來源

## 課表格式說明

系統支援 人力資源網2.0匯出的標準格式，包含以下欄位：

| 欄位名稱 | 說明 | 範例 |
|---------|------|------|
| 週次 | 星期幾 | 週一、週二... |
| 節次 | 第幾節課 | 第一節、第二節... |
| 年級 | 年級 | 7年級、8年級、9年級 |
| 班級 | 班級名稱 | 7年1班、8年2班... |
| 教師姓名 | 任課教師 | 王大明 |
| 類別 | 課程類別 | 領域學習、彈性學習 |
| 領域 | 學習領域 | 數學領域、語文領域... |
| 科目 | 科目名稱 | 數學、國語文... |

### 範例課表

`test/sample-schedule.csv` 提供一份欄位格式與真實課表完全相同、但教師姓名與班級都是虛構資料的範例課表（6 個班級 × 一週課表，教師姓名為「陳小美」「林大明」等明顯虛構名，班級代號為 701、702 這類通用編號）。

想快速體驗課表匯入功能、又還沒有自己學校的人力資源網 2.0 匯出檔時，可以直接下載 `test/sample-schedule.csv`，在系統的「匯入課表」功能選擇這個檔案上傳即可看到完整效果。正式使用時請改上傳自己學校匯出的真實課表檔案。

## 雲端同步功能

系統內建 Firebase 雲端同步，使用者只需：

1. 點擊「登入」按鈕
2. 使用 Google 帳號授權登入
3. 資料將自動同步至雲端

登入後可在多台設備間同步調代課紀錄，登出後自動切換為本地儲存模式。

## 專案結構

```
STsystem/
├── index.html              # 主頁面
├── start-server.py         # 本地測試伺服器
├── src/
│   ├── css/
│   │   └── style.css       # 樣式表
│   └── js/
│       ├── app.js          # 主應用程式
│       └── modules/
│           ├── dataManager.js          # 資料管理（含 Firebase 同步）
│           ├── scheduleParser.js       # 課表解析
│           ├── recommendationEngine.js # 智慧推薦
│           ├── pdfGenerator.js         # PDF 生成
│           └── settlementCalculator.js # 月結算
└── test/
    └── ...                 # 測試檔案
```

## 智慧推薦演算法

代課教師推薦依照以下優先順序排序：

1. **同領域教師**（+100 分）
   - 例如：數學課優先推薦數學領域老師

2. **該班導師**（+50 分）
   - 該班級的導師，熟悉學生狀況

3. **其他空堂教師**（+10 分）
   - 該時段沒有課的教師

## 月結算計算邏輯

```
實際授課時數 = 原定授課時數 + 代課增加時數 - 被代課減少時數

其中：
- 原定授課時數 = 每週節數 × 當月上課週數
- 代課增加時數 = 該月為他人代課的總節數
- 被代課減少時數 = 該月被他人代課的總節數
```

## 授權條款

MIT License，詳見 [LICENSE](LICENSE)。

## 免責聲明

本專案為個人開發、無償公開分享的工具，依「現況」（as is）提供，不保證沒有錯誤、不保證持續維護或技術支援，也不對使用本工具造成的任何損失負責。

若您要用在自己的學校，請注意：

- 課表、教師姓名、學生資料都屬於個資，上傳、匯出、分享前請自行確認資料的保存與流通方式符合貴校規範與個資法要求。
- 建議先用 `test/sample-schedule.csv` 這類範例資料試用，確認功能符合需求後，再匯入真實課表。
- 使用 Firebase 雲端同步時，資料會傳輸並存放在您自己設定的 Firebase 專案中，是否要啟用雲端同步、如何管理存取權限，請自行評估。
- 本專案不會、也無法替您做資料去識別化或加密，任何去識別化處理都需要使用者自己完成。

簡言之：這是我自己在用、也願意分享出來的工具，但資料安全與合規使用的最終責任在使用者自己身上。
