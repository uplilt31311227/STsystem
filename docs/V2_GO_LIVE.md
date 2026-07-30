---
created: 2026-07-29
updated: 2026-07-29
tags:
  - deployment
  - go-live
  - v2.0.0
---

# V2 全校上線作業手冊

> 對象：教務主任（director）｜分支：`feature/permission-system`｜preview 站：https://uplilt31311227.github.io/STsystem-preview/
>
> 本文是「從現在的狀態到全校可用」的完整步驟。程式面的商用整備已於 2026-07-29 完成（見 CHANGELOG 同日條目），**剩下的都是只有你能做的資料與決策工作**。

---

## 零、目前系統實際狀態（2026-07-29 收尾時的實測快照）

| 項目 | 狀態 |
|---|---|
| `schools/inhu/teachers` | 32 筆＝29 位真實教師 + 3 個 `[測試]` 帳號。**其中 26 位真實教師沒有 email**，沒有 email 就無法登入 → 見第一節步驟 3 |
| `schools/inhu/data/schedule` | 1 筆，內容是**測試課表**（12 筆課程、2 個班級），必須用正式課表覆蓋 → 見步驟 1 |
| `schools/inhu/pendingRequests` | 0 筆（測試資料已於收尾時清理完畢） |
| `schools/inhu/substituteRecords` | 1 筆，為 2026-07-10 的正式紀錄，未受測試影響 |
| `schools/inhu/operationLogs` | 51 筆，含測試期間的稽核紀錄（依安全規則不可刪，屬正常留存） |
| 健檢 `firestore-health-check` | 只剩 1 項 FAIL：重複的主任教師檔 → 見步驟 4 |
| 自動化測試 | 162 項單元測試 + 26 案安全矩陣全綠 |

**結論：程式面已具備上線條件，擋住上線的是資料準備**——26 位教師沒有 email、課表是測試課表。這兩件事完成後即可開始試用。

---

## 一、上線前必做（依序執行，缺一不可）

### 1. 上傳全校課表 ⚠ 最重要

系統目前的 `schools/inhu/data/schedule` 是測試期間放的**精簡測試課表**，必須用真正的當學期課表覆蓋。

1. 用主任帳號（`uplilt31311227@gmail.com`，Google 登入）進 preview 站
2. 到「課表匯入」頁籤，上傳人力資源網 2.0 匯出的課表檔（CSV 或 Excel）
3. 上傳完成後右下角會顯示同步成功提示

**為什麼最重要**：沒有課表時，`canSwitchToTab()` 會鎖住教師端除「課表匯入」外的所有頁籤，全校教師登入後什麼都做不了。

### 2. 設定學校名稱並按確認

在同一頁的學校名稱欄位填入「新竹市立內湖國民中學」後**按確認按鈕**。

**不可省略**：頁籤解鎖同時需要「有課表」與「有學校名稱」兩個條件。此欄位只有 approver 能設定，教師端是靠雲端同步取得的——這一步沒做，全校教師會卡在「請先設定學校名稱」而他們自己無法解決。（此回寫機制為 2026-07-29 修復，先前版本即使按了確認也不會同步。）

### 3. 匯入全校教師名單

到「教師管理」頁籤 →「📥 批次匯入 CSV」。

> 2026-07-30 起「教師管理」頁只有一張合併表（姓名／Email／角色／任教領域／導師班級），所有欄位**變更即時自動儲存**，沒有「儲存」按鈕。領域與導師班級教學組長也能改，Email 與角色僅主任可改。手動「新增教師」需先匯入課表，且同名／同 email 會被擋下（避免重複建檔）。

- 欄位格式：`姓名,Email,角色,領域,導師班`
- 角色可填中文（主任／組長／教師）或英文代碼（director／section_chief／teacher），留空預設為教師
- 詳細規則與範例見 [V2_ROSTER_CSV.md](./V2_ROSTER_CSV.md)，範例檔 `test/roster-sample.csv`
- 系統會先顯示預覽（新增／更新／略過／錯誤逐列說明），**確認無誤才按匯入**
- 同一份 CSV 重跑不會產生重複資料，可安心修正後重匯

**Email 必須正確**：教師登入後系統以 email 比對教師檔來決定身份，比對不到就會被拒絕登入。

### 4. 清理重複的主任教師檔 ✅ 已於 2026-07-30 完成

`schools/inhu/teachers` 原有兩筆同名同 email 的主任檔，已在「教師管理」頁刪除孤兒那筆：

| teacherId | authProvider | 處理 |
|---|---|---|
| `tch_1780040513944_kl4wgr9` | google.com | **保留**（實際登入綁定的那筆） |
| `tch_1780040513944_qf7vp5g` | （空） | 已刪除（零引用孤兒，從未被任何登入綁定） |

刪除後已驗證：教師數 32→31、主任身份與該筆的領域資料完好、同名重複警示消失。

**根因不是 bootstrap 競態**：`authGuardV2.ensureDirectorTeacher()` 只依 email 查既有教師檔，而課表匯入的教師檔 email 是 `null`，初始主任首次登入查不到自己那筆就另建一筆——這正對應兩筆 `authProvider` 一為 `google.com`、一為空。此路徑仍存在（修它需放寬 `firestore.rules` 的 `isInitialDirector` 分支並重新部署），若日後又出現重複，教師管理頁會顯示「同名重複帳號檔」警示，依警示保留有登入紀錄的那筆即可。詳見 [ISSUES_LOG.md](./ISSUES_LOG.md) 2026-07-30 條目。

### 5. （選用）遷移 V1 舊資料

若主任在舊版（master 正式站）累積的調代課紀錄需要帶進 V2：

「教師管理」頁下方會出現「V1 資料遷移」卡片（**偵測到舊資料才顯示**）→ 按「下載備份並開始遷移」。系統會先強制下載 JSON 備份才開始寫入，重複執行不會產生重複紀錄。遷移後的紀錄在「調代課紀錄」頁會標示灰底「舊系統」徽章，可用篩選切換。

---

## 二、上線驗收

執行 `docs/V2_E2E_CHECKLIST.md` 的 A–G 七組共 47 項。其中：

- **自動化可驗的部分**先跑：
  ```bash
  npm test                          # 41 項單元測試
  node test/test-roster-import.mjs  # CSV 匯入 48 項
  node test/test-legacy-migration.mjs  # 資料遷移 58 項
  node test/v2-rules-matrix.mjs     # 安全規則 26 案（需憑證檔）
  node scripts/firestore-health-check.js  # 線上資料健檢
  ```
- **人工驗的部分**：三角色實際登入、三種審核流程走一遍、登出鎖定、身份切換

建議先讓主任與組長在 preview 站試用兩週（`PLAN_v2.0.0.md` Phase 6 的閘門），再考慮合回 master。

---

## 三、部署

```bash
# preview 站（feature 分支）
git push preview feature/permission-system:main
# → https://uplilt31311227.github.io/STsystem-preview/

# 安全規則（改動 firestore.rules 後才需要）
node scripts/firestore-deploy-rules.js --list   # 先看現況
node scripts/firestore-deploy-rules.js --dry    # 語法驗證
node scripts/firestore-deploy-rules.js          # 正式發布
```

正式站（master → GitHub Pages）目前仍是 V1 v1.13.2，**V2 尚未合併回 master**，全校現行作業不受任何影響。

---

## 四、回滾

| 情境 | 做法 |
|---|---|
| preview 站出問題 | `git push preview <備份分支>:main -f`，回朔點 `614e4ff`（Phase 3）、`fdc0678`（2026-07-29 商用整備完成） |
| 安全規則出問題 | 把 release 指回前一個 ruleset：`0ad89275-0df4-46c6-99c8-825a6cc94889`。**現行 release 為 `618f5d1e-d350-4e8e-950e-b551eab97490`**（2026-07-29 重新部署，內容與前一版經位元級比對完全相同，本次未修改任何規則） |
| 程式碼要回到今天之前 | 本地備份分支 `backup-pre-commercial-20260729`；tag `v1.13.2-stable` 為 V1 穩定版 |
| 資料要還原 | 2026-07-29 基準快照見交接紀錄；遷移功能執行前一定會先下載 JSON 備份 |

---

## 五、已知限制與風險決策點

上線前請就以下兩點做出決定：

### 1. 全校請假紀錄的個資外洩 ✅ 已於 2026-07-29 修復

原本 `firestore.rules` 對 `substituteRecords` 與 `pendingRequests` 的讀取規則是「任何登入者皆可讀」，教師端只在前端過濾，任一教師用開發者工具就能讀到全校同仁的假別。**現已修復**：

- 假別與事由（`leaveType` / `leaveTypeName` / `reason`）搬到 `.../private/detail` 受限子文件，只有當事人與主任／組長讀得到
- 排課資訊（誰在哪節代誰的課）維持全校可讀——代課單本屬公告性質，且衝堂檢查與代課推薦需要
- 線上 ruleset：`bd1a6f7a-d662-48cf-8d6d-d2f87c055aab`（2026-07-29 部署，回滾點 `618f5d1e-d350-4e8e-950e-b551eab97490`）
- 既有那筆含「長期病假」的正式紀錄已一併遷移，父文件不再帶敏感欄位

**實測驗證**：教師讀不到非當事人的假別（DENY）、仍讀得到排課資訊（ALLOW）、組長讀得到假別（ALLOW）；教師嘗試注入公假／長期病假／喪假／事假來規避月結算扣減全被擋下（4/4 DENY），自我調課的合法路徑不受影響。

### 2. 其他已知限制（影響較小，不阻擋上線）

- 多節課的代課在 V2 會拆成 N 筆請求，核准者需逐筆核准、PDF 逐張產生
- 自我調課紀錄的姓名字串欄位未鎖定本人（僅影響顯示統計，無計費影響）
- 代課推薦在教師端使用完整紀錄快取以確保推薦正確性（見 `v2-app.js` `getSubstituteRecords` patch 的註解）
- 教師在「課表匯入」頁看得到「+新增教師／儲存資料／匯入還原」按鈕，但實際點擊會被安全規則擋下、不會改到任何資料（UI 冗餘，非安全問題）

---

## 六、測試帳號（可保留或刪除）

為了讓自動化測試（`test/v2-rules-matrix.mjs`、`test/v2-approval-flows.mjs`）能持續執行，系統中保留了三個測試帳號：

| Email | 教師檔名稱 | 角色 |
|---|---|---|
| `uplilt31311227+v2t1@gmail.com` | [測試]教師甲 | teacher |
| `uplilt31311227+v2t2@gmail.com` | [測試]教師乙 | teacher |
| `uplilt31311227+v2t3@gmail.com` | [測試]組長丙 | section_chief |

若不希望它們出現在教師名單中，可在「教師管理」頁刪除；但刪除後上述兩支自動化測試需重新建立帳號才能跑。密碼記錄在本次工作階段的暫存目錄，未進版控。
