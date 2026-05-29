---
created: 2026-05-29
purpose: v1.11.0 → v2.0.0 升級前的資料快照存放區
---

# 升級備份目錄

此目錄用於存放 v1.11.0 → v2.0.0 多角色升級期間的資料快照與還原素材。

## 為什麼需要這個目錄

多角色版本會把 Firestore 路徑從 `users/{uid}/data/substituteSystem`（每人各一份）改為 `schools/{schoolId}/...`（全校共用），既有 v1.11.0 的所有調代課紀錄在升級過程必須一次遷移過去。這個目錄存放遷移前的原始備份，作為「萬一遷移腳本壞掉」的還原來源。

## 此目錄包含什麼

| 檔案 | 何時建立 | 用途 |
|---|---|---|
| `README.md` | 升級規劃時 | 本文件，會進 git |
| `v1.11.0-baseline-YYYY-MM-DD.json` | Phase 0 / Phase 5 遷移前 | 完整資料 dump（從應用內「設定 → 資料管理 → 匯出資料」按鈕產生） |
| `v1.11.0-roster-bootstrap.csv` | Phase 1 開始時 | 從現有 scheduleData 撈出的初始教師清單（姓名 + 角色 + 領域），供主任補 email 後匯入 |

## 重要規則（在 .gitignore 已生效）

- `docs/backup/*.json`、`docs/backup/*.csv` **不進 git**（可能含教師姓名 / 班級等個資）
- **只有本文件** `README.md` 進 git
- 個資檔請放到 OneDrive / USB / 私人加密磁碟，並在團隊內告知存放位置

## 如何產生 v1.11.0 baseline JSON

1. 在 master 分支（v1.11.0）啟動 `python start-server.py`
2. 瀏覽器開 `http://localhost:8000`
3. 用平常使用的 Google 帳號登入
4. 切到「設定」頁籤 → 「資料管理」區 → 點「匯出資料」按鈕
5. 把下載的 JSON 改名為 `v1.11.0-baseline-2026-05-29.json` 並放入本目錄
6. **不要 git add 此檔案**（已被 .gitignore 阻擋）

## 如何用 baseline JSON 做災難還原

1. 在 v1.11.0 master 啟動服務、登入
2. 設定 → 資料管理 → 「匯入資料」按鈕 → 選此 JSON
3. 確認紀錄筆數正確
4. 若是要還原到 v2.0.0：用主任帳號登入新系統 → 走「Phase 5 一鍵遷移」流程（v2.0.0 開發完成後提供）

## 升級期間的關鍵 tag / branch 對照

- `v1.11.0-stable` — Phase 0 完成時打的 tag，可隨時 `git checkout v1.11.0-stable` 回滾到升級前狀態
- `feature/permission-system` — V2 開發分支（含 admin/teacher 2 層 V2 alpha，後續評估是否擴充為 3 層）
- `master` — 在 v2.0.0 通過驗收前**維持 v1.11.0**，學校現場繼續使用
