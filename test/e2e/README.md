# 全流程操作測試（e2e）— 現況與已知限制

真的開瀏覽器、真的點畫面、真的送出表單，資料寫進本機 Emulator。
前端連 emulator 靠網址參數 `?v2=1&emu=1`（見 `src/js/modules/firebaseConfig.js` 的
`shouldUseEmulator()`：**必須** hostname 是 localhost/127.0.0.1 **且**帶 `emu=1`，
正式站無法命中）。

## 執行

```bash
# 三個都要開著
npm run emu                       # 終端機 A：Firebase Emulator
python start-server.py            # 終端機 B：本機網頁伺服器（port 8000）
npm run seed && npm run test:e2e  # 終端機 C：種資料後跑操作測試
```

## ⚠ 已知限制：登入不穩定，這組測試目前無法完整跑完

在這個環境（headless Chromium ＋ 本機 Firebase Emulator）下，登入成功率實測約
**兩到四成**。失敗時的表現有兩種：

1. Firebase 認證成功（`currentUser` 有值），但畫面停在登入遮罩——bootstrap 的某個
   Firestore 一次性查詢永不回應（不逾時、不拋錯、無 console 錯誤），
   於是 `unlockV2App()` 不會執行。
2. 登入視窗直接顯示「請先完成 Firebase 設定」——`initializeFirebase()` 沒能完成。

已排除的原因（逐一驗證過，都不是）：

- 種子資料不完整、`projectId` 命名空間不符（這兩項是真的問題，**已修**）
- `initAuthService()` 重複掛監聽器導致 bootstrap 跑兩次（真的問題，**已修**）
- `initializeFirebase()` 缺併發保護（真的問題，**已修**）
- Firestore 改用 long-polling、重啟 emulator、每次全新瀏覽器、
  快取 Firebase SDK 避免重複下載（都試過，**沒有根本改善**）

最可疑但尚未證實的方向：`index.html` 不打包 Firebase，SDK 是在執行期從
`gstatic.com` 動態 import 的，每個全新瀏覽器環境都要重新載入整套 SDK；
一旦載入不完整，後續 Firestore 查詢就會永遠不回應。已加上 route 層快取
（`installSdkCache`）但仍未解決，代表問題可能不只在下載這一段。

**尚未能判斷正式環境是否同樣受影響**——不會拿正式站做這種驗證。
真實使用者是在一般瀏覽器、有 HTTP 快取、連正式 Firestore 的條件下操作，
與這裡的條件差異很大，不應直接把這個成功率套用到正式環境。

## 目前的內容

| 檔案 | 內容 | 狀態 |
|---|---|---|
| `e2e-00-login-stability.mjs` | 連續 6 次登入的成功率，**刻意不重試** | 可跑，如實回報數字 |
| `e2e-01-auth.mjs` | 三種角色可見範圍、密碼錯誤、名冊外帳號、跨校資料隔離 | 曾完整通過 6/6，會受不穩定影響 |
| `e2e-02-substitute-flow.mjs` | 代課推薦正確性、公假必填字號、未選課不可送出、教師只能為自己申請、申請→待辦→核准 | **未能穩定跑完** |

其他情境（課表匯入異常檔、月結算、學期切換、清除資料閘門）尚未撰寫——
在登入穩定之前，寫了也無法得到可信的結論。

## 這組測試已經測出來的東西

即使沒跑完，過程中確實發現並修掉了三個真實問題（見 CHANGELOG 2026-08-11 條目），
其中兩個是與 emulator 無關的生產程式碼缺陷。另記錄一項 UI 落差：
「教師管理」頁籤對教學組長也可見（實際增刪改由規則擋下，規則層已由情境 2 驗證）。
