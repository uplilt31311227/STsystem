---
created: 2026-09-11
updated: 2026-09-11
tags:
  - deployment
  - security
---

# App Check enforcement：現況、判準與開啟步驟

App Check 的**用戶端**（classic reCAPTCHA v3）自 2026-08-01 起就在正式站跑著，但 Firebase Console 端的
**enforcement（強制）開關一直沒開**。原訂「觀察 1-2 週再決定」，到 2026-09-11 已逾五週未回頭處理。
本文把「該不該開、怎麼判斷、怎麼開、出事怎麼退」寫成一頁，讓這個決定不必再重新研究一次。

程式碼面的背景與當初的部署步驟見 `docs/STAGE4-DEPLOY.md`「App Check（classic reCAPTCHA v3）啟用步驟」，
本文不重複。

## 一、現況（2026-09-11 查證）

| 項目 | 狀態 | 佐證 |
|---|---|---|
| 用戶端 App Check 已初始化 | ✅ 是 | 正式站實測：載入 `firebase-app-check.js` 1 個資源、reCAPTCHA 相關資源 3 個、`window.grecaptcha` 存在 |
| Firestore enforcement | ❔ 應為「未強制」 | 依 2026-08-01 的紀錄，程式碼從未觸碰這個開關（它只存在於 Console）。**開之前請在 Console 再確認一次現值** |
| 觀察期 | 已逾期 | 原訂 1-2 週，實際已滿 5 週以上，累積的 Metrics 足夠判斷 |

## 二、開之前要在 Console 看什麼

Firebase Console → 專案 `stsystem-9d5fe` → **App Check** → **APIs** 頁籤：

1. **Cloud Firestore** 那一列，看最近 7 天的請求組成：
   - **Verified**（已驗證）：帶著有效 App Check token 的請求。
   - **Unverified**（未驗證）：沒帶 token 或 token 無效——**開了 enforcement 之後這些會被直接拒絕**。
   - **Outdated client**（用戶端過舊）：載入的前端沒有 App Check 程式碼，通常是瀏覽器快取了舊版檔案的使用者。
2. **判準**：連續數日 Unverified + Outdated client 合計 ≈ 0（或只剩零星、且能解釋來源）才開。
   只要還看得到穩定的未驗證流量，就代表現在開會**直接鎖住這些合法使用者**。
3. **Identity Toolkit（Firebase Authentication）** 是另一列、另一個開關。本系統的登入走這條路徑，
   一旦強制而使用者的 token 取得失敗，症狀是「連登入都失敗」，比 Firestore 被擋更嚴重。
   建議先只強制 Firestore，Auth 那列維持未強制，觀察一週再說。

## 三、開啟步驟

1. 先跑一次完整備份（現行課表已納入，見 `scripts/firestore-backup.js`）：
   `node scripts/firestore-backup.js backup`
2. 挑**非上班時段**動手（週間晚上或週末），避開教師實際要送調代課的時間。
3. Console → App Check → APIs → Cloud Firestore → **強制執行（Enforce）**。
4. 立刻做三項煙霧測試，任何一項失敗就退回（見第四節）：
   - 開無痕視窗載入正式站 V2（`?v2=1`），以真實帳號登入，確認看得到課表與紀錄。
   - 送出一筆測試申請並在待辦頁核准，確認寫入成功（事後刪除）。
   - 跑 `node scripts/firestore-health-check.js`，確認離線腳本仍能讀取。
5. 三項都過，再公告全校（公告稿見 `docs/ANNOUNCEMENT-115-1.md`，其中已含「請硬重新整理」一句）。

## 四、回滾

Console → App Check → APIs → Cloud Firestore → 切回 **未強制（Unenforced）**。生效很快，
不需要改程式碼、不需要重新部署。這是這個決定風險可控的主因：它是一個可以隨時扳回來的開關。

## 五、風險與尚未查證的事

- **舊快取的前端**：GitHub Pages 靜態資源 `Cache-Control: max-age=600`，且被動態 import 的子模組
  （`firebaseConfig.js` 等）沒有版本查詢參數。剛好在快取窗內載入舊檔的使用者會呈現 Outdated client。
  這是「公告請大家硬重新整理」的實際理由之一。
- **離線腳本（`scripts/*.js`）不受影響——推論，未實測**。這些腳本走的是 gcloud OAuth access token
  直接呼叫 Firestore REST API，不經 Firebase 用戶端 API key 路徑，照 App Check 的設計不在強制範圍內。
  但本專案沒有實際在 enforcement 開啟的狀態下跑過，所以列為推論；第三節的煙霧測試第 3 項就是用來
  當場驗證這一條，不要跳過。
- **App Check 擋不了合法使用者的濫用**：任何已核准的教師仍可開 devtools 對自己學校做無限查詢。
  這是純前端 + Firestore 架構下的既有限制（見 `docs/RESEARCH-multitenancy-semester.md` §4.5），
  開 enforcement 不會改變這一點。它擋的是「不是從我們網站來的請求」。
- **reCAPTCHA 被網路環境擋掉**：校園網路若有過濾 `google.com` / `gstatic.com` 的設備，token 取不到，
  該使用者在 enforcement 開啟後會完全無法使用。目前沒有這類回報，但這是開啟後最可能的新故障型態。

## 六、建議

**建議開，但只開 Firestore、不開 Auth，並照第三節的順序做。** 理由：用戶端已跑滿五週、Metrics 足夠；
回滾是一個 Console 開關、成本極低；而不開的話，Blaze 方案下「非本站來源的請求」這條路徑一直是敞開的。
唯一的前置條件是第二節的 Metrics 判準——**若 Unverified 仍有穩定量，就先不要開**，先查清那些流量是誰。
