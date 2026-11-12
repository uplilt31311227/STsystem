---
created: 2026-11-10
updated: 2026-11-12
tags:
  - deployment
  - billing
---

# 帳單自動斷線（billing kill switch）

2026-11-10 起啟用。起因：[[ISSUES_LOG]] 2026-11-10 V1 寫入迴圈事故（11/8–11/9 燒掉約 TWD 277）。預算警報只寄信、不會擋下扣款，這支函式是唯一能自動止血的機制。

> ⚠️ **2026-11-12 現況**：帳單於 16:49 手動解除、22:05（台灣）重新綁定（ISSUES_LOG 2026-11-12）。門檻已由 1000 調為 **TWD 500**。函式目前**暫停中**：`DISARMED_UNTIL=2026-12-01T08:00:00Z`（當月已花 414.01，接近門檻），**11 月剩餘期間沒有自動斷線保護**，12/1 起自動恢復。現行 revision `billing-kill-switch-00005-quk`（Node 22）。

## 運作方式

```
Budget「STsystem 自動斷線 TWD 500」(b31a4d41-5fec-4da8-8d79-a837e0bcb0e5)
   │ 一天多次送出目前花費
   ▼
Pub/Sub topic: projects/stsystem-9d5fe/topics/billing-kill-switch
   ▼
Cloud Function (gen2) billing-kill-switch @ asia-east1
   │ 當月「實際」花費 >= TWD 500？（不看預測值）
   ▼
解除 stsystem-9d5fe 與帳單帳戶 01A75D-93C4DE-69DE70 的綁定
```

- 程式：`cloud-functions/billing-kill-switch/`（判斷邏輯在 `decide.js`，單元測試 `npm test`，27 項）。
- 斷線預算的範圍**只有 stsystem-9d5fe 專案**（`budgetFilter.projects = projects/192019928674`），帳單帳戶下其他專案的花費不會觸發。
- 判斷原則是 **fail-closed**（不確定就不斷線）：
  - 只回應指定的預算 ID 與帳單帳戶；`BUDGET_ID`／`BILLING_ACCOUNT_ID` 沒設定時一律不動作。
  - 只看實際花費，不看預測值。
  - 只處理本月（美國太平洋時間，與預算的日曆月一致）的訊息，延遲或重送的上月訊息不動作。
  - `DRY_RUN` 只有明確設成 `false` 才會真的斷線；未設定、`true`、`TRUE`、`1` 等一律只記錄。
  - `DISARMED_UNTIL`（ISO 時間）之前不動作，格式錯誤也不動作。
- 日誌為結構化 JSON，依嚴重度分級：不動作 `INFO`、DRY_RUN `WARNING`、已斷線 `ALERT`、**斷線失敗或設定缺漏 `CRITICAL`**（保護失效，需人工處理）。
- 執行身分：`billing-kill-switch@stsystem-9d5fe.iam.gserviceaccount.com`，權限只有 `roles/billing.projectManager`（解除綁定）、`roles/browser`（讀取專案帳單狀態需要 `resourcemanager.projects.get`；少了它 `getProjectBillingInfo` 會 PERMISSION_DENIED，2026-11-10 DRY_RUN 驗證時發現）、`roles/run.invoker`、`roles/eventarc.eventReceiver`。

## ⚠️ 觸發後會發生什麼

- **整個 stsystem-9d5fe 退回免費方案**：Firestore 超過每日免費額度（讀 5 萬／寫 2 萬）後，**全校都無法讀寫**；時間點還原（PITR）等付費功能停止；這支函式本身也會停止。
- 不會刪除任何資料，Firestore 資料完整保留。
- 不會自動恢復。

## 觸發後如何恢復

1. 先找出費用來源並止血（Cloud Console 帳單報表依 SKU 分組；Cloud Monitoring 的 `firestore.googleapis.com/document/write_count`、`read_count`），處理方式參考 ISSUES_LOG 2026-11-10。
2. ⚠️ **先暫停斷線，再重新綁定**。當月花費仍 >= 門檻，不暫停的話預算下次送通知（一天多次）時會再度斷線。把 `DISARMED_UNTIL` 設到下個月 1 日（太平洋時間 00:00 = UTC 08:00；夏令時間為 07:00，取 08:00 較保守），到期後自動恢復保護，不用記得改回：
   ```bash
   gcloud functions deploy billing-kill-switch --gen2 --region=asia-east1 \
     --update-env-vars=DISARMED_UNTIL=2026-12-01T08:00:00Z \
     --project=stsystem-9d5fe --account=uplilt31311227@gmail.com
   ```
   （函式在專案斷線期間無法部署，要先完成第 3 步再回來做這一步，並盡快做完；或在第 3 步之前先暫時移除預算的 Pub/Sub 連結。）
3. 重新綁定：
   ```bash
   gcloud billing projects link stsystem-9d5fe --billing-account=01A75D-93C4DE-69DE70 --account=uplilt31311227@gmail.com
   ```
4. 下個月檢查日誌出現 `不動作：未達門檻`，確認保護已恢復。

## 其他預算警報（只寄信，不斷線）

| 預算 | 範圍 | 門檻 |
|---|---|---|
| Firebase Project stsystem-9d5fe — TWD 250 | 專案 | 實際 5%／50%／100%，預測 150% |
| STsystem 帳單帳戶 TWD 300 | 帳單帳戶 | 實際 50%／90%／100%，預測 100% |
| STsystem 帳單帳戶 TWD 500 | 帳單帳戶 | 實際 50%／90%／100%，預測 100% |

## 重新部署

```bash
gcloud functions deploy billing-kill-switch --gen2 --region=asia-east1 --runtime=nodejs22 \
  --source=cloud-functions/billing-kill-switch --entry-point=billingKillSwitch \
  --trigger-topic=billing-kill-switch \
  --service-account=billing-kill-switch@stsystem-9d5fe.iam.gserviceaccount.com \
  --trigger-service-account=billing-kill-switch@stsystem-9d5fe.iam.gserviceaccount.com \
  --memory=256Mi --max-instances=1 --ingress-settings=internal-only \
  --set-env-vars=TARGET_PROJECT_ID=stsystem-9d5fe,BUDGET_ID=b31a4d41-5fec-4da8-8d79-a837e0bcb0e5,BILLING_ACCOUNT_ID=01A75D-93C4DE-69DE70,DRY_RUN=false \
  --project=stsystem-9d5fe --account=uplilt31311227@gmail.com
```

⚠️ `--set-env-vars` 會覆蓋全部變數；若正在暫停中，記得一併帶上 `DISARMED_UNTIL`。

驗證時把 `DRY_RUN=true` 部署，再用 `gcloud pubsub topics publish billing-kill-switch` 送模擬訊息（帶 `budgetId`、`billingAccountId` 屬性，內容要有本月的 `costIntervalStart`），檢查 Cloud Run 日誌出現 `DRY_RUN：…本來會解除…`。**不要在 DRY_RUN=false 時送超標的模擬訊息**，會真的斷線。Windows PowerShell 5.1 會吃掉 `--message` JSON 的雙引號，請用 Git Bash 執行。

### 2026-11-10 驗收紀錄
- DRY_RUN：本月超標 → `WARNING DRY_RUN…本來會解除`；上月訊息 → `非本月訊息`；其他預算 → `不是斷線預算`；未超標 → `未達門檻`；JSON 損壞 → `無法解析`。
- 第一次 DRY_RUN 發現 service account 缺 `roles/browser`（`getProjectBillingInfo` PERMISSION_DENIED），補上後通過。
- 真實預算通知已實際送達：`未達門檻：284.89 < 1000 TWD`（2026-11-10 16:30）。
- 正式模式 revision `billing-kill-switch-00004-lin`，`DRY_RUN=false`、只接受內部流量；部署後帳單仍綁定。

### 2026-11-12 重新部署紀錄
- Node 20 執行環境已被 GCP 停用：`gcloud functions deploy --update-env-vars`（不帶 `--runtime`）與 `gcloud run services update` 都被拒（`Runtime nodejs20 is decommissioned`）。改以 `--runtime=nodejs22` 完整重新部署，`package.json` 的 `engines.node` 同步改為 22；本機 `npm test` 27/27。**「觸發後如何恢復」第 2 步若再遇到執行環境停用，請改用下方完整部署指令並帶上 `DISARMED_UNTIL`。**
- 驗證：送出低於門檻的模擬訊息（cost 1／budget 500），新 revision 記錄 `不動作：已暫停至 2026-12-01T08:00:00.000Z`；帳單仍綁定。
- gcloud 預設配額專案的 Cloud Billing API 常回 `RESOURCE_EXHAUSTED`；`gcloud billing …` 指令加 `--billing-project=stsystem-9d5fe` 可避開（預算指令必須加）。

## 與架構前提的關係

本專案原本是「無自建後端」（見 `docs/STAGE4-DEPLOY.md`「為何不做自動斷流」）。2026-11-10 事故後，使用者決定加上這支函式：它沒有業務邏輯、不接觸 Firestore 資料，只負責止血。門檻原設 TWD 1000；2026-11-12 第二次迴圈事故後調為 TWD 500（門檻就是預算金額，改預算即可，函式不必重新部署）。
