---
created: 2026-03-12
updated: 2026-04-13
tags:
  - project
  - education
---

# 國中調代課自動化系統 (STsystem)

一套純前端的國中調代課管理系統，專為台灣國中教學組設計，支援人力資源網2.0匯出的課表格式。

## 功能特色

### 課表管理
- 支援 Excel (.xls, .xlsx) 和 CSV 格式匯入
- 自動解析人力資源網2.0的課表格式
- 教師課表手動編輯功能
- 任教領域可編輯
- 課表上傳排課衝突檢查

### 調代課申請
- 步驟式引導介面（選教師→選類型→選課程→確認）
- 智慧推薦代課教師（同領域 > 班導師 > 空堂教師）
- 多節課調代課模式
- 多重調課批次功能
- 教師自行調課功能

### PDF 通知單
- 一式四聯（原任課教師、代課教師、班級、教學組）
- 黑白列印優化
- 週課表異動標示

### 月結算報表
- 自動計算代課/被代課時數
- 假別區分計算（公假/調課不扣時數）
- Excel 匯出

### 雲端同步
- Firebase Authentication（Google 登入）
- Firebase Realtime Database 即時同步
- 離線自動切換本地儲存

## 技術架構

- **前端**：HTML + CSS + JavaScript (ES6 Modules)
- **儲存**：localStorage + Firebase Realtime Database
- **部署**：GitHub Pages
- **CDN**：PapaParse、SheetJS、jsPDF、Firebase SDK

## 相關文件

- [[CHANGELOG|版本紀錄]]
- [[DEPLOYMENT|部署資訊]]
- [[ISSUES_LOG|問題追蹤]]

## 連結

- **GitHub**: [STsystem](https://github.com/uplilt31311227/STsystem) (private)
- **線上版**: GitHub Pages 部署
