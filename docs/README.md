---
created: 2026-03-12
updated: 2026-07-29
tags:
  - project
  - education
---

# 國中調代課自動化系統 (STsystem)

一套純前端的國中調代課管理系統，專為台灣國中教學組設計，支援人力資源網2.0匯出的課表格式。

> 目前正式版（`master` 分支）：**v1.13.2**｜開發中：**v2.0.0** 三層角色權限系統（`feature/permission-system` 分支）

## 功能特色

### 課表管理
- 支援 Excel (.xls, .xlsx) 和 CSV 格式匯入
- 自動解析人力資源網2.0的課表格式
- 教師課表手動編輯功能
- 任教領域可編輯
- 課表上傳排課衝突檢查
- 科目↔領域對應表：匯入自動擷取對應關係，設定頁可手動增修（v1.13.0）

### 調代課申請
- 步驟式引導介面（選教師→選類型→選課程→確認）
- 智慧推薦代課教師（同領域 > 班導師 > 空堂教師）
- 多節課調代課模式
- 多重調課批次功能
- 教師自行調課功能
- 送出前衝堂攔截：代課教師重複指派、班級時段衝突（v1.10.0）
- 「九年級已畢業」開關：停用九年級課程，避免擋住相關時段調代課安排（v1.12.0）

### PDF 通知單
- 一式四聯（原任課教師、代課教師、班級、教學組）
- 黑白列印優化
- 週課表異動標示
- 「列印本週彙整」：一鍵產生整週綜合 PDF，按收件方分頁（v1.11.0）

### 月結算報表
- 自動計算代課/被代課時數
- 假別區分計算（公假/調課不扣時數）
- Excel 匯出

### 雲端同步
- Firebase Authentication（Google 登入）
- Firebase Realtime Database 即時同步
- 離線自動切換本地儲存

## V2 三層角色權限系統（開發中）

`feature/permission-system` 分支正在開發的 v2.0.0：全校共用一份課表與紀錄（取代 v1.x 各自一份資料的模式），新增 director／section_chief／teacher 三層角色與代課單簽／調課雙簽／多重調課全員同意三種審核工作流、完整操作日誌。僅於 preview 站與 `?v2=1` 啟用，不影響 master 正式站。

- [[V2_PERMISSION_SYSTEM|V2 權限系統架構]]
- [[PLAN_v2.0.0|v2.0.0 開發計畫與進度]]
- [src/js/modules/v2/README.md](../src/js/modules/v2/README.md)（V2 模組清單）

## 技術架構

- **前端**：HTML + CSS + JavaScript (ES6 Modules)
- **儲存**：localStorage + Firebase Realtime Database（master）／ Firestore（V2）
- **部署**：GitHub Pages
- **CDN**：PapaParse、SheetJS、jsPDF、Firebase SDK

## 相關文件

- [[CHANGELOG|版本紀錄]]
- [[DEPLOYMENT|部署資訊]]
- [[ISSUES_LOG|問題追蹤]]

## 連結

- **GitHub**: [STsystem](https://github.com/uplilt31311227/STsystem) (private)
- **線上版**: GitHub Pages 部署
