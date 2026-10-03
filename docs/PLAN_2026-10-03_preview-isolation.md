# 計畫：測試站與正式站完全分離（獨立 Firebase 專案）

> 日期：2026-10-03
> 決策：使用者選「獨立 Firebase 專案」＋「我用 CLI 建，使用者先 `firebase login`」

## 問題

`src/js/modules/firebaseConfig.js` 只有一份 config，`projectId: stsystem-9d5fe`。
測試站（`uplilt31311227.github.io/STsystem-preview/`）與正式站連的是**同一個 Firestore 與同一個 Auth 使用者池**，
只有本機帶 `?emu=1` 才會走 emulator。後果：在測試站做教師增刪、課表匯入、審核、
「清除所有資料」，寫的都是正式資料。歷史實例：2026-07-30 在 preview 站刪掉重複教師檔，
production `teachers` 直接從 32 筆變 31 筆（見 `ISSUES_LOG.md`）。

## 目標

測試站有自己的 Firebase 專案，資料庫、Auth 使用者池、讀寫配額全部獨立，可以在上面跑
破壞性測試而完全不影響正式資料。正式站行為零變動。

## 方案

新建 Firebase 專案（暫名 `stsystem-preview`），前端依網域選 config：

| 來源 | 連到的專案 |
|---|---|
| `uplilt31311227.github.io/STsystem/`（正式站） | `stsystem-9d5fe`（正式） |
| `uplilt31311227.github.io/STsystem-preview/`（測試站） | `stsystem-preview`（新） |
| `localhost` + `?emu=1` | `demo-stsystem`（emulator，不變） |
| `localhost`（不帶 emu） | **改為 `stsystem-preview`**，帶 `?prod=1` 才連正式 |

最後一列是刻意的安全預設變更：目前本機不帶參數就直接讀寫正式庫，這個預設太危險。

## 步驟

| # | 項目 | 狀態 |
|---|---|---|
| 1 | 使用者 `firebase login`（互動授權，我無法代做） | ⏸ 等待 |
| 2 | CLI 建專案 + 建 web app，取得 config | ⏸ |
| 3 | 新專案建 Firestore（nam5 或 asia-east1）、部署 `firestore.rules` 與索引 | ⏸ |
| 4 | Console 啟用 Google 與 Email/Password provider、Authorized domains 加 `uplilt31311227.github.io`（可能需使用者點） | ⏸ |
| 5 | `firebaseConfig.js` 改為依網域選 config（唯一出口 `getActiveFirebaseConfig()`） | ⏸ |
| 6 | 腳本支援 `--project=`（至少 backup／health-check／bootstrap／deploy-rules／create-indexes） | ⏸ |
| 7 | 新專案 bootstrap：`schools/inhu` config（含 `initialAdminEmails`）、測試教師名冊 | ⏸ |
| 8 | 推 preview 站驗證：登入、匯入測試課表、跑一次破壞性操作，確認正式庫筆數不變 | ⏸ |
| 9 | 更新 `DEPLOYMENT.md`／`CHANGELOG.md`／`ISSUES_LOG.md` | ⏸ |

## 驗收條件

- 測試站登入後，操作前後比對正式庫：`teachers`／`schedules`／`substituteRecords` 筆數完全不變（用 `firestore-backup.js` 或 `firestore-health-check.js` 對正式專案查，前後各一次）。
- 測試站可完整走：登入 → 匯入課表 → 送出代課申請 → 核准 → 產 PDF。
- 正式站 `master` 不動，正式站載入的 `firebaseConfig.js` 仍為 `stsystem-9d5fe`。
- `npm run check`、`npm test` 全通過；emulator e2e 不受影響（`demo-stsystem` 路徑未改）。

## 紅線

- 正式庫（`stsystem-9d5fe`）本次只做唯讀查驗與備份，不寫入。
- 動任何東西前先跑一次正式庫備份。
- 不把新專案的 config 誤填到正式站路徑；config 切換的判斷只能依網域／路徑，不依使用者可改的參數（`?prod=1` 例外，且只在 localhost 生效）。
- App Check：新專案的站台金鑰留空＝跳過初始化（現行機制已支援），不動正式站那把金鑰。

## 已知待確認

- Firebase 免費 Spark 方案下，單一 Google 帳號可建的專案數有上限（通常足夠，建失敗則需在 Console 申請配額或刪舊專案）。
- Auth 使用者池獨立 → 測試站的「初始主任白名單」要在新專案的 `schools/inhu/config/main` 重新設定，否則第一個登入者會被判定未授權。
