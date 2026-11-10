---
created: 2026-11-10
updated: 2026-11-10
tags:
  - deployment
  - billing
---

# 帳單自動斷線（billing kill switch）

2026-11-10 起啟用。起因：[[ISSUES_LOG]] 2026-11-10 V1 寫入迴圈事故（11/8–11/9 燒掉約 TWD 277）。預算警報只寄信、不會擋下扣款，這支函式是唯一能自動止血的機制。

## 運作方式

```
Budget「STsystem 自動斷線 TWD 1000」(b31a4d41-5fec-4da8-8d79-a837e0bcb0e5)
   │ 一天多次送出目前花費
   ▼
Pub/Sub topic: projects/stsystem-9d5fe/topics/billing-kill-switch
   ▼
Cloud Function (gen2) billing-kill-switch @ asia-east1
   │ 當月「實際」花費 >= TWD 1000？（不看預測值）
   ▼
解除 stsystem-9d5fe 與帳單帳戶 01A75D-93C4DE-69DE70 的綁定
```

- 程式：`cloud-functions/billing-kill-switch/`（判斷邏輯在 `decide.js`，單元測試 `npm test`）。
- 只回應指定的預算 ID 與帳單帳戶，其他預算（250／300／500 警報）的訊息會被忽略。
- 執行身分：`billing-kill-switch@stsystem-9d5fe.iam.gserviceaccount.com`，權限只有 `roles/billing.projectManager`（解除綁定）、`roles/browser`（讀取專案帳單狀態需要 `resourcemanager.projects.get`；少了它 `getProjectBillingInfo` 會 PERMISSION_DENIED，2026-11-10 DRY_RUN 驗證時發現）、`roles/run.invoker`、`roles/eventarc.eventReceiver`。

## ⚠️ 觸發後會發生什麼

- **整個 stsystem-9d5fe 退回免費方案**：Firestore 超過每日免費額度（讀 5 萬／寫 2 萬）後，**全校都無法讀寫**；時間點還原（PITR）等付費功能停止；這支函式本身也會停止。
- 不會刪除任何資料，Firestore 資料完整保留。
- 不會自動恢復。

## 觸發後如何恢復

1. 先找出費用來源並止血（Cloud Console 帳單報表依 SKU 分組；Cloud Monitoring 的 `firestore.googleapis.com/document/write_count`、`read_count`），處理方式參考 ISSUES_LOG 2026-11-10。
2. 確認不會再失控後，重新綁定：
   ```bash
   gcloud billing projects link stsystem-9d5fe --billing-account=01A75D-93C4DE-69DE70 --account=uplilt31311227@gmail.com
   ```
3. ⚠️ 當月花費仍 >= 1000，預算下次送通知時**會再度斷線**。要在當月內恢復，得先把斷線預算的金額調高（或暫時移除 Pub/Sub 連結），下個月 1 日再調回：
   ```bash
   gcloud billing budgets update b31a4d41-5fec-4da8-8d79-a837e0bcb0e5 --billing-account=01A75D-93C4DE-69DE70 --budget-amount=2000TWD --account=uplilt31311227@gmail.com --billing-project=stsystem-9d5fe
   ```

## 其他預算警報（只寄信，不斷線）

| 預算 | 範圍 | 門檻 |
|---|---|---|
| Firebase Project stsystem-9d5fe — TWD 250 | 專案 | 實際 5%／50%／100%，預測 150% |
| STsystem 帳單帳戶 TWD 300 | 帳單帳戶 | 實際 50%／90%／100%，預測 100% |
| STsystem 帳單帳戶 TWD 500 | 帳單帳戶 | 實際 50%／90%／100%，預測 100% |

## 重新部署

```bash
gcloud functions deploy billing-kill-switch --gen2 --region=asia-east1 --runtime=nodejs20 \
  --source=cloud-functions/billing-kill-switch --entry-point=billingKillSwitch \
  --trigger-topic=billing-kill-switch \
  --service-account=billing-kill-switch@stsystem-9d5fe.iam.gserviceaccount.com \
  --trigger-service-account=billing-kill-switch@stsystem-9d5fe.iam.gserviceaccount.com \
  --memory=256Mi --max-instances=1 --ingress-settings=internal-only \
  --set-env-vars=TARGET_PROJECT_ID=stsystem-9d5fe,BUDGET_ID=b31a4d41-5fec-4da8-8d79-a837e0bcb0e5,BILLING_ACCOUNT_ID=01A75D-93C4DE-69DE70,DRY_RUN=false \
  --project=stsystem-9d5fe --account=uplilt31311227@gmail.com
```

驗證時把 `DRY_RUN=true` 部署，再用 `gcloud pubsub topics publish billing-kill-switch` 送模擬訊息（帶 `budgetId`、`billingAccountId` 屬性），檢查 Cloud Run 日誌出現 `DRY_RUN：…本來會解除…`。**不要在 DRY_RUN=false 時送超標的模擬訊息**，會真的斷線。

## 與架構前提的關係

本專案原本是「無自建後端」（見 `docs/STAGE4-DEPLOY.md`「為何不做自動斷流」）。2026-11-10 事故後，使用者決定加上這支函式：它沒有業務邏輯、不接觸 Firestore 資料，只負責止血。門檻設在 TWD 1000，大約是平常月費的數百倍，正常使用不會誤觸。
