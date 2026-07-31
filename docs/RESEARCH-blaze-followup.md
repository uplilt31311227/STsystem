# 研究報告：Blaze 升級前置查證（RESEARCH-multitenancy-semester.md §9 待查證項）

> 專案：STsystem（國中調代課自動化系統），Firebase 專案 `stsystem-9d5fe`
> 撰寫日期：2026-07-31
> 目的：解決 `docs/RESEARCH-multitenancy-semester.md` §9 的 Q1–Q5 待查證項，作為「是否升級 Blaze、以及升級後如何控管支出」的決策依據
> 查證方式：官方文件 WebFetch/瀏覽器互動、本專案 Firestore REST API 唯讀查詢、本專案 Cloud Console 配額頁唯讀檢視
> **全程唯讀，未對 Firestore 或任何 GCP 資源做任何寫入或設定變更**

---

## 0. 結論總表（先讀這裡）

| 編號 | 問題 | 結論 | 信心 |
|---|---|---|---|
| 1 | Blaze 免費額度是否保留 | ✅ 保留，官方明文「Blaze 包含 Spark 的免費用量」；例外項目與原報告 C09/C19 一致（TTL/PITR/備份/還原/複製不含免費額度，named database 無免費額度） | 高（官方文件） |
| Q3 | Blaze 有無硬性支出上限 | ❌ 沒有。Budget 只能發警報；官方「自動停用」做法需要 Cloud Function；Firestore API 在 Cloud Console 的配額頁**經本專案實測沒有可調整的「每日可計費讀寫次數」上限**，此路不通 | 高（含本專案即時查驗） |
| Q4 | reCAPTCHA 超額單價 | Enterprise 超過 10,000 次/月後 **US$0.001/次**；但 App Check 也支援 **classic reCAPTCHA v3，免費額度是每月 100 萬次**，遠高於本案估算的 16,000 次/月，建議直接換 provider 迴避此成本 | 高（官方文件） |
| Q1/Q2 | 實際部署區域與單價 | 資料庫實際部署在 **asia-east1（台灣）**，且是單區域（非 nam5 多區域）。asia-east1 單價**全面低於**報告 §7 使用的 nam5 單價（讀/寫/刪各便宜約 42%，儲存便宜約 4%） | 高（本專案 REST API 直查 + 官方定價頁） |
| 5 | Blaze 升級本身有無月費 | ✅ 確認沒有，純用量計費 | 高（官方文件） |

---

## 1. Blaze 免費額度保留

**結論**：Blaze 方案確認包含 Spark 的免費用量，且該免費用量以每日為單位持續適用；只有超出的部分才計費。

- 來源：https://firebase.google.com/pricing
  原文（頁面摘要確認）：Blaze 方案列出的權益包含 **"No-cost usage from Spark plan included."**
- 交叉印證：本專案資料庫 metadata（見 §4）回傳欄位 `"freeTier": true`，確認 `(default)` 資料庫本身即為享有免費額度的那一個資料庫。
- 已知例外（與原報告 [C09][C19][C05][C08] 一致，本次重新確認未變）：
  - 依存留時間刪除（TTL）、PITR 資料、備份資料、復原作業、複製作業 **不含免費用量**，這五項不論 Spark/Blaze 一律計費（Blaze 定價頁「依所在位置計價」表格下方明文列出這五項，見 §4 引句）。
  - 自行命名（非 `(default)`）的資料庫**沒有免費配額**，且只能在啟用計費後建立（同原報告 C05/C08，本次於 asia-east1 頁面上再次確認同一段文字）。
- Auth／App Check：Auth 標準登入方式免費至 50K MAU（原報告 S31，未重新查證，但無跡象顯示已變動）；App Check 本身不直接計費，成本來源是底下呼叫的 reCAPTCHA（見 §3）。

**未發現新的例外項目**。原報告 §7 的免費額度假設（A1/A2）成立，可繼續沿用。

---

## 2. Q3（最關鍵）：Blaze 有沒有硬性支出上限機制

### (a) GCP Budget 是否只有警報、無自動斷流

**結論：只有警報，沒有自動斷流。**

來源：https://docs.cloud.google.com/billing/docs/how-to/budgets
原文：
> "Setting an *alerts-only* budget doesn't automatically cap Google Cloud or Google Maps Platform usage or spending."
> "Budget alert emails might prompt you to take action to control your costs, but they don't automatically prevent the use or billing of your services when the alerts-only budget amount or threshold rules are met or exceeded."

同一份文件也在 Firestore 定價頁（`cloud.google.com/firestore/pricing`「管理費用」一節）重複強調：
> "重要注意事項：即便您已超過 Google Cloud 每月預算上限，向 Firestore 和其他 Google Cloud 服務發出的要求仍會成功。您必須自行改變使用模式，讓費用維持在 Google Cloud 預算範圍內。"

### (b) 官方「自動停用計費」的建議做法是否需要 Cloud Function

**結論：需要。** 官方沒有提供「勾選即生效」的自動斷流開關；標準做法是自建 Pub/Sub + Cloud Function 管線。

來源：https://docs.cloud.google.com/billing/docs/how-to/budgets（連結指向 `Disable billing with notifications` 與 `Control resource usage with notifications` 兩份操作指南）＋ https://docs.cloud.google.com/billing/docs/how-to/disable-billing-with-notifications
- 流程：Budget 連到 Cloud Pub/Sub topic → 觸發門檻時 Google 送一則資料訊息到該 topic → 需要**自己寫一個 Cloud Function（或 Cloud Run function）訂閱該 topic**，收到訊息後呼叫 Cloud Billing API 停用該專案的計費。
- 官方明確警告：**停用計費會讓整個專案的所有 Google Cloud 服務（含免費層服務）一起終止**，因此「只適合開發/沙箱環境」，不建議用在正式營運專案（因為一旦誤觸發，20+ 校會全部斷線，比帳單超支更糟）。

### (c) 有沒有不需後端的替代——Firestore API 的 Cloud Console 配額上限設定

這是本次查證新增的關鍵項目：**是否能比照舊版 App Engine spending limit，用 Cloud Console 的 API Quotas 頁面把 Firestore 的「每日可計費讀寫次數」設一個自訂上限？**

一般性文件確實提到這種機制存在：
來源：https://docs.cloud.google.com/apis/docs/capping-api-usage
原文：「On the requests per day or requests per 100 seconds per user line, you can click the edit icon, then enter the preferred total billable daily quota... You can set daily billable limits only on billable APIs.」
但同一份文件也警告：「If the Quotas tab is not present in the tab nav, it means the API you've selected doesn't have quotas defined.」——**不是每個 API 都支援這個機制**，取決於該 API 有沒有暴露「requests per day」這個可調配額維度。

**本次直接在本專案（`stsystem-9d5fe`）的 Cloud Console 唯讀查驗結果**（`console.cloud.google.com/apis/api/firestore.googleapis.com/quotas?project=stsystem-9d5fe`，17 項配額/系統限制全列出）：

| 項目 | 類型 | 值 | 是否可調整 |
|---|---|---|---|
| Free daily read operations per project | **系統限制** | 50,000/天 | **否** |
| Free daily write operations per project | **系統限制** | 20,000/天 | **否** |
| Free daily delete operations per project | **系統限制** | 20,000/天 | **否** |
| Databases Per Project | 配額 | 100 | 是 |
| Composite Indexes per Database | 配額 | 1,000 | 是 |
| Export/Import Requests Per Minute | 配額 | 20 | 是 |
| Database Operations Per Minute | 配額 | 60 | 是 |
| Locations Requests Per Minute | 配額 | 60 | 是 |

**結論：不可行。** Firestore API 在 Cloud Console 暴露的「可調整」（是否可調整=是）配額，全部是索引數量、資料庫數量、每分鐘管理面 API 呼叫數這類**管理面/結構性上限**，唯獨真正決定帳單的「每日讀/寫/刪次數」被歸類為**系統限制**且明確標示**不可調整**。這代表 Firestore（不同於 Maps Platform、Custom Search 這類傳統「按呼叫計費」API）**沒有暴露自助式的每日計費請求上限**，`capping-api-usage` 文件描述的機制對 Firestore 不適用。這也解釋了為什麼 §2.2(a) 的官方文件會反覆強調「超過預算後請求仍會成功」——因為技術上真的沒有攔截點。

### (d) 結論：無後端條件下，最接近「支出保險絲」的可行組合

**沒有真正的硬性上限存在**，這點必須寫進決策文件、不能迴避。無 Cloud Functions 的條件下，能做的只有「降低失控機率」與「縮短失控後的反應時間」，不是「防止失控」：

**首選組合（零額外基礎設施）**：
1. **多層 Budget 警報**（50% / 90% / 100% / 150% 門檻皆發信給開發者本人與至少一位 platform admin 的 email，而非只設一道）——原報告已提到要設，這裡補強為多門檻。
2. **人工「緊急煞車」腳本**（原報告 §4.5 已提出，本次確認這是本案在無後端條件下唯一能「立即停止服務」的手段）：預先寫好一份會把 `firestore.rules` 全部改成 `allow read, write: if false` 並 `firebase deploy --only firestore:rules` 的一鍵腳本，收到高門檻警報後由人工執行。這不是自動化，但反應時間可壓到幾分鐘內。
3. **App Check 換用 classic reCAPTCHA v3**（見 §3）而非 Enterprise：不會降低「合法使用者濫用配額」這個原報告 §4.5 認定的無解攻擊面，但能擋掉一部分非本站來源的自動化流量，降低被瞬間刷爆的機率。
4. **每日/每週人工巡檢** Firebase console 的 Firestore Usage 頁，及早發現異常增長趨勢（而非等 Budget 警報才發現）。

**第二選擇（願意接受「一個極小的後端」時）**：
- 官方標準做法：Budget → Pub/Sub → 一個只做一件事的 Cloud Function（收到超支通知就呼叫 Cloud Billing API 停用計費）。
- 這是目前唯一的**真自動化**手段，代價是：(a) 需要維護一支 Cloud Function（違背專案「無自建後端」的架構前提，但這支函式極簡單、無業務邏輯、攻擊面小）；(b) 一旦觸發是**整專案斷線**（含所有學校），不是優雅降級。
- 建議：若要採用，觸發門檻設在遠高於正常預算的倍數（例如平時月費的 5–10 倍），只當「真的失控」才自動斷線，避免因單日尖峰誤殺全平台。

---

## 3. Q4：reCAPTCHA Enterprise 超額單價 ／ reCAPTCHA v3 免費額度

**reCAPTCHA Enterprise**：每月 10,000 次評估免費，超過後單價 **US$0.001／次**（即 US$1／1,000 次）。
來源：https://docs.cloud.google.com/recaptcha/docs/billing-information（原 `cloud.google.com/recaptcha/docs/billing-information` 重新導向後的網址）
（頁面另註記大量客戶可洽詢 Google 業務團隊談客製化折扣價，非標準單價的一部分，不影響本案的量級判斷。）

**reCAPTCHA v3（classic，非 Enterprise）**：**免費額度是每月 100 萬次呼叫**，遠高於 Enterprise 的 10,000 次。超過額度後**不是直接擋掉**，而是「fail open」：
來源：https://developers.google.com/recaptcha/docs/faq
原文：
> "If a v3 site key exceeds its monthly quota, then `site_verify` may fail open by returning a static score 0.9 and an error message `"Over free quota."` for the remainder of the month."
> "Site keys are considered over quota if more than 1,000,000 calls per month are used for any domain."

**與本案的關聯**：App Check 的 Web provider 官方支援 reCAPTCHA Enterprise **與** reCAPTCHA v3 兩者（原報告 [C14][C15]，本次於 `firebase.google.com/docs/app-check` 與 `firebase.google.com/docs/app-check/web/recaptcha-provider` 重新確認兩個 provider 選項均存在）。原報告 §4.5 估算「20 校 × 40 師 × 每月 20 次 session ≈ 16,000 次／月」已超過 Enterprise 的免費額度（10,000），但**遠低於 v3 的免費額度（1,000,000）**。

**建議**：App Check 的 Web provider 直接選 **reCAPTCHA v3（classic）而非 Enterprise**，在本案預期規模（16,000／月，即使 50 校擴大數倍也大概率仍在 1,000,000 之內）下可完全迴避這項成本，且超額時的「fail open 給 0.9 分」設計比 Enterprise 更寬容（不會粗暴擋下請求）。若日後規模成長到真的逼近 100 萬次／月，屆時再評估切回 Enterprise 或付費升級。

---

## 4. Q1/Q2：Firestore 資料庫的實際部署區域與該區單價

### 4.1 實際區域（唯讀 REST 查詢）

依 `scripts/firestore-health-check.js` 的既有做法，用個人 gcloud 帳號取存取權杖，唯讀 GET 專案的資料庫 metadata：

```
gcloud auth print-access-token --account=uplilt31311227@gmail.com
GET https://firestore.googleapis.com/v1/projects/stsystem-9d5fe/databases
```

回應（節錄，唯讀操作，未做任何寫入）：

```json
{
  "databases": [
    {
      "name": "projects/stsystem-9d5fe/databases/(default)",
      "locationId": "asia-east1",
      "type": "FIRESTORE_NATIVE",
      "databaseEdition": "STANDARD",
      "freeTier": true,
      "pointInTimeRecoveryEnablement": "POINT_IN_TIME_RECOVERY_ENABLED",
      "deleteProtectionState": "DELETE_PROTECTION_DISABLED"
    }
  ]
}
```

**確認：本專案的 `(default)` 資料庫實際部署在 `asia-east1`（台灣），是單一區域（regional）位置，不是原報告 §7 假設使用的 `nam5`（北美多區域）。** 另外順帶查出兩項原報告未提及、但對後續決策有意義的現況設定：`pointInTimeRecoveryEnablement: POINT_IN_TIME_RECOVERY_ENABLED`（PITR 目前已啟用，這項不含免費用量，見 §1）與 `deleteProtectionState: DELETE_PROTECTION_DISABLED`（刪除保護目前關閉）。這兩項是本次查證的副產品，不在原問題範圍內，但建議一併記錄供後續參考。

### 4.2 asia-east1 實際單價

透過 `cloud.google.com/firestore/pricing` 頁面的互動式地區選擇器切換到「Taiwan (asia-east1)」後讀取「依所在位置計價」表格（Default，即超出免費配額後的單價）：

| 項目 | asia-east1 單價 | nam5 單價（報告 §7 原用值） | 差異 |
|---|---|---|---|
| 文件讀取 | **US$0.0345 / 100,000 份文件** | US$0.06 / 100,000 | **便宜 42.5%** |
| 文件寫入 | **US$0.1042 / 100,000 份文件** | US$0.18 / 100,000 | **便宜 42.1%** |
| 文件刪除（含 TTL 刪除） | **US$0.0115 / 100,000 份文件** | US$0.02 / 100,000 | **便宜 42.5%** |
| 儲存空間 | **US$0.1725 / GiB / 月** | US$0.18 / GiB / 月 | 便宜 4.2% |

來源：https://cloud.google.com/firestore/pricing （「依所在位置計價」表格，地區選擇器切至 Taiwan (asia-east1)，計價模式為 Default／每月）
（作業方式說明：此頁面的定價表以互動元件動態載入，純文字擷取無法取得特定地區數值；本次以瀏覽器實際切換地區下拉選單後讀取渲染後的頁面文字，儲存單價另以「每小時／每個月」切換鈕核對過，確認 US$0.1725 為**每月**單價，US$0.000236301 為對應的每小時單價，兩者互相印證一致。）

**重要修正**：原報告 §7.4／§9-Q1 的推測是「亞太區域通常較貴」，本次查證結果**相反**——asia-east1 讀/寫/刪單價反而比 nam5 便宜四成以上。原因是 **nam5 是多區域（multi-region）位置，asia-east1 是單區域（regional）位置**；Google Cloud 的定價結構是「多區域永遠比單區域貴」，這個價差主要來自區域類型（regional vs multi-region），而不是地理位置（美洲 vs 亞太）。與 asia-east1 同為單區域的 `us-central1` 單價（US$0.03／US$0.09／US$0.01／約 US$0.15/GiB-月，本次查證順帶取得）比 asia-east1 略便宜，符合「美國本土單區域 < 亞太單區域 < 任何多區域」的直覺排序，但 asia-east1 vs nam5 的比較方向與原報告推測相反。

### 4.3 20 校／50 校月費重估（asia-east1 實際單價，沿用報告 §7 用量假設）

直接套用原報告 §7.3 已算出的每日讀取量（用量假設本身不重算，只換單價）：

**bounded query 改造後（推薦的目標狀態）**：

| 情境 | 每日讀取量 | 每日超額讀取 | 月超額讀取 | asia-east1 讀取費 | nam5 讀取費（原報告） | 儲存超額費 | **asia-east1 月費合計** |
|---|---|---|---|---|---|---|---|
| 20 校 × 40 師 | 124 K | 74 K | 2.22 M | $0.77 | $1.3 | $0（未超 1GiB） | **≈ US$0.8／月** |
| 50 校 × 50 師 | 386 K | 336 K | 10.08 M | $3.48 | $6.0 | $0.026（0.15GiB × $0.1725） | **≈ US$3.5／月** |

**現行全量訂閱模式（未做讀取止血改造，僅供對照，凸顯改造急迫性不變）**：

| 情境 | 每日讀取量 | 月超額讀取 | asia-east1 讀取費 | nam5 讀取費（原報告） |
|---|---|---|---|---|
| 20 校 × 40 師 | 7.7 M | 229.5 M | **≈ US$79／月** | ≈ US$138／月 |
| 50 校 × 50 師 | 44.7 M | 1,339.5 M | **≈ US$462／月** | ≈ US$804／月 |

**結論**：換算成本專案實際部署區域後，Blaze 費用比原報告的 nam5 估算**更低**，不是更高。原報告 §7 的「bounded query 改造後 20 校約 $1.3/月、50 校約 $6/月」這個「進 Blaze 代價極小」的核心論證**成立且更寬鬆**（實際約 $0.8／$3.5）；「不做改造就擴張，帳單會是兩位數到四位數美元」的警告同樣成立（實際約 $79／$462，量級不變）。原報告的決策結論（§1 預算結論、§7.4 最終預算判斷）不需要修改，只需要把金額換成本節數字，方向更樂觀。

---

## 5. Blaze 升級本身有無月費或最低消費

**確認：沒有。** Blaze 是純用量計費，沒有基本費、沒有訂閱費、沒有最低消費門檻。

來源：https://firebase.google.com/pricing
原文（頁面摘要確認）：Blaze 方案列為「Pay as you go」，權益包含「Access more services and higher usage」與前述「No-cost usage from Spark plan included」；升級需要綁定一個付款方式，但沒有強制性的每月固定費用——不使用（或用量落在免費層內）就是 US$0／月。
另外頁面提到符合資格者可取得 US$300 升級免費額度（一次性，非本次查證重點，順帶記錄）。

---

## 6. 本次查證方法備忘（供日後複查參考）

- Firestore 定價頁（`cloud.google.com/firestore/pricing`）的地區價目表是 Angular 動態渲染元件，純文字擷取（WebFetch／原始 HTML grep）**擷取不到依地區變動的數字**——這與原報告 §9-Q1 記錄的「WebFetch 三次皆截斷」現象一致，是同一個根因。本次改用瀏覽器自動化（`claude-in-chrome`）實際點開地區下拉選單、切換到 Taiwan (asia-east1) 後再讀取渲染後文字才成功取得數字。日後若要查其他地區單價，建議直接用同樣方式（開瀏覽器 → 點地區選單 → 讀文字），不要嘗試 WebFetch 這個特定頁面。
- 「Firestore API 是否有可調每日配額上限」這項，僅讀官方文件會得到模稜兩可的答案（`capping-api-usage` 文件本身是寫給「有 QPD 配額的 API」的通用說明，沒有明講 Firestore 是否屬於這類）。本次改為直接唯讀查本專案 Cloud Console 的配額頁（17 項配額/系統限制清單）取得決定性答案，這比只讀文件可靠。
- 兩項 REST／Console 查詢皆為唯讀（GET / 檢視頁面），未觸發任何寫入、未變更任何專案設定。

---

*本報告為 `docs/RESEARCH-multitenancy-semester.md` §9 的補充查證，解決 Q1–Q5（Q6 onSnapshot 實測用量與 Q7 舊說法盤查不在本次範圍內，仍待查證）。實作前建議一併更新原報告 §7、§9、附錄 C 的 nam5 單價為本報告 §4.2 的 asia-east1 實際單價。*
