# 專案規則：國中調代課自動化系統 (STsystem)

> 此文件定義 Claude Code 在此專案中的行為規則

## 專案基本資訊

- **專案名稱**: STsystem（國中調代課自動化系統）
- **建立日期**: 2026-03-12
- **技術棧**: JavaScript (ES6 Modules) / Firebase / GitHub Pages
- **部署位置**: GitHub Pages（自動部署 master 分支）
- **Git Repo**: https://github.com/uplilt31311227/STsystem (private)

## 專案結構

```
STsystem/
├── CLAUDE.md           ← 本文件
├── CHANGELOG.md        ← 版本紀錄（主要）
├── README.md           ← 專案總覽（主要）
├── index.html          ← 主頁面（單頁應用）
├── docs/               ← 文件（Obsidian 連結目標）
│   ├── README.md       ← 專案總覽（Obsidian 用）
│   ├── DEPLOYMENT.md   ← 部署資訊
│   ├── CHANGELOG.md    ← 變更記錄（Obsidian 用）
│   └── ISSUES_LOG.md   ← 問題追蹤
├── src/
│   ├── css/
│   │   └── style.css   ← 樣式表
│   └── js/
│       ├── app.js      ← 主應用程式
│       └── modules/
│           ├── dataManager.js          ← 資料管理（含 Firebase 同步）
│           ├── scheduleParser.js       ← 課表解析
│           ├── recommendationEngine.js ← 智慧推薦
│           ├── pdfGenerator.js         ← PDF 生成
│           └── settlementCalculator.js ← 月結算
├── google-apps-script/
│   └── Code.gs         ← Google Apps Script（已棄用）
└── test/               ← 測試檔案
```

## 開發規則

### 程式碼風格
- 純前端 SPA，所有邏輯在 `index.html` 和 `src/js/` 中
- ES6 模組化設計
- CDN 引入外部套件（PapaParse、SheetJS、jsPDF、Firebase SDK）
- localStorage 為主要本地儲存方式

### 測試要求
- 主要功能變更需在瀏覽器中手動測試
- PDF 生成需驗證輸出格式
- Firebase 同步功能需測試線上/離線模式

### 提交規則
- Commit message 格式：`type: 描述`
- type: feat / fix / refactor / chore / docs / style
- 使用繁體中文撰寫描述

## 文件更新規則

### 必須更新 CHANGELOG.md 的情況
- 完成新功能開發
- 修復 Bug
- 重構程式碼
- 更新依賴套件

### 必須更新 ISSUES_LOG.md 的情況
- 發現新問題
- 解決問題後記錄解法
- 記錄 workaround 或暫時解法

### 必須更新 DEPLOYMENT.md 的情況
- 部署環境變更
- 環境變數新增或修改
- 依賴版本重大更新
- 部署流程變更

## 快速指令

```bash
# 啟動開發環境
python start-server.py
# 或
python -m http.server 8000

# 開啟瀏覽器
# http://localhost:8000
```

## Obsidian 連結

- 📝 開啟專案筆記：`obsidian://open?vault=ObsidianVault&file=Projects/STsystem/README`

## 注意事項

- 本專案為純前端 SPA，無後端伺服器
- Firebase config 為前端公開設定，已包含在 index.html 中
- 課表格式僅支援人力資源網2.0匯出格式
- PDF 生成使用 jsPDF + AutoTable，需注意中文字型支援
