# 版本紀錄 (Changelog)

## [Unreleased - v2.0.0-alpha] - feature/permission-system branch

> 本段變更僅存在於 `feature/permission-system` 分支，尚未合併回 master。穩定版 `組長穩定版1.0` 不受影響。

### 新增（V2 權限系統）
- **角色制度**：`admin`（組長）與 `teacher`（教師）雙角色
  - 組長識別依 `schools/default/config/main.initialAdminEmails` 或 `teachers/{id}.role`
  - 教師以 Google email 綁定 `teachers/{id}.email`
- **教師帳號管理頁籤（admin 專用）**：指派 email、切換角色、新增/刪除教師、從課表一鍵匯入教師
- **登入綁定機制（authGuardV2）**：未綁定 email 的 Google 帳號拒絕登入並提示
- **調課同意流程（pendingRequestService）**：教師發起 → 寫入 `pendingRequests` → 對方同意後轉為 `substituteRecords` → 或對方拒絕 / 發起人撤回
- **待辦清單頁籤**：顯示「待我同意」「我已發起」兩區塊
- **組長代發起模式**：組長可代任一教師直接建立紀錄，跳過同意流程
- **完整操作日誌**：所有寫入事件（create_request / approve / reject / cancel / admin_create / edit / delete / teacher_bind_email / role_change / login_denied / permission_denied 等）都寫入 `operationLogs` 集合；組長看全部、教師只看相關
- **全新 Firestore Schema**：`schools/default/`（與舊 `users/{uid}/data/…` 完全物理隔離）

### 新增檔案
- `src/js/v2-app.js`（V2 入口）
- `src/js/modules/v2/schemaConstants.js`
- `src/js/modules/v2/envDetector.js`
- `src/js/modules/v2/firebaseV2.js`
- `src/js/modules/v2/schoolDataService.js`
- `src/js/modules/v2/roleService.js`
- `src/js/modules/v2/operationLogger.js`
- `src/js/modules/v2/teacherAccountManager.js`
- `src/js/modules/v2/pendingRequestService.js`
- `src/js/modules/v2/authGuardV2.js`
- `src/js/modules/v2/README.md`
- `docs/V2_PERMISSION_SYSTEM.md`

### 相容性
- 穩定版 master 的 `index.html`、`app.js`、Firestore 資料路徑完全未動
- V2 僅在 URL `?v2=1` 或 hostname 含 `preview` 時啟動
- 啟動時透過 `body.v2-active` class 顯示 V2 專屬頁籤，隱藏/取代既有行為

### 2026-04-20（部署）Firestore 初始資料 + 安全規則發布
- **`schools/default/config/main` 文件已建立**：schoolName="XX 國中"、initialAdminEmails=["uplilt31311227@gmail.com"]
- **Firestore 安全規則 v2 發布**：新增 `schools/{schoolId}/{document=**}` 允許登入者讀寫，保留原 `users/{uid}/{document=**}` 僅擁有者讀寫
- 規則檔提交至 repo (`firestore.rules`) 作為 source of truth
- 測試階段規則寬鬆；正式上線前需改為依 email 白名單與 role 判讀

### 2026-04-20（補丁）衝堂檢查 + 紀錄頁籤清理 + gitignore
- **V2 衝堂檢查修復**：新增同步 cache (`_v2RecordsCache` / `_v2PendingCache`)，由 onSnapshot 更新，`dm.checkExistingRecord` 在 V2 模式下改查 cache（含 pending 尚未被處理者），解決原 local 陣列空導致偵測不到 V2 既有紀錄的問題
- **V2 下隱藏原紀錄表格**：CSS 隱藏 `#records-no-data` 與 `#records-content`，避免空表格與 V2 全校紀錄表格並存造成混淆；V2 紀錄區塊改為頁籤主內容
- **擴充 .gitignore**：排除 uv/pyproject 產物、test-results/、test PDFs、schedule xls、臨時 analysis/extracted_text 檔
- **冒煙測試擴充**：新增 `test/v2-patch-test.js`（驗證 patch 套用）與 `test/v2-isolation-test.js`（驗證穩定版 URL 未被污染）

### 2026-04-29（規則正式版 + 驗證工具）
- **Firestore 安全規則 v2.1 撰寫完成**（`firestore.rules`，待部署）：
  - 新增 helpers：`isInitialAdmin` / `myTeacherId` / `myTeacherDoc` / `isAdmin(schoolId)`
  - `teachers`：建立／刪除僅 admin；初始管理員可 bootstrap 自己的 admin 檔
  - `pendingRequests`：建立要求 `initiatedBy == 自己`；更新限 `requiredApproverId` 或 admin；刪除限 `initiatedBy` / `requiredApproverId` / admin
  - `substituteRecords`：建立要求 `approvedBy` 或 `requiredApproverId == 自己`（同意人成立）或 admin；編輯／刪除僅 admin
  - `userMappings`：自己讀寫自己；admin 全可
  - `operationLogs`：任何登入者可寫，不可改／刪
  - master `users/{uid}/{document=**}` 規則維持不變
- **新增部署腳本 `scripts/firestore-deploy-rules.js`**：用 gcloud token 透過 firebaserules.googleapis.com 建 ruleset 並發布 release，支援 `--dry` / `--list`
- **新增健康檢查腳本 `scripts/firestore-health-check.js`**：驗證 config、teachers、userMappings、pendingRequests、substituteRecords、operationLogs 結構完整性
- **新增 `docs/V2_E2E_CHECKLIST.md`**：7 大情境（admin bootstrap / 未綁定拒絕 / 教師管理 / pending 流程 / admin 代發起 / 規則攻擊測試 / master 隔離）的人工驗證清單
- **不合併回 master**：所有變更僅存於 `feature/permission-system` 與 preview repo

### 2026-04-20（補丁）同意前不產 PDF + rejected 保留狀態
- **同意前完全不產 PDF**：教師發起 pending 時不再產生 PDF，避免使用者誤以為紀錄已成立；同意方按「同意並產生 PDF」後才在同意方瀏覽器下載
- **攔截 app 層 PDF 生成**：`patchPdfGenerators()` 包裹 `generateSubstitutePDF` / `generateMultiCoursePDF`，對含 `__v2NeedsApproval` 標記的 record 略過；同時吞掉 app.js 原「PDF 已生成」toast
- **rejected 狀態保留**：`rejectRequest` 改 soft-reject（status=rejected），發起人在「我已發起」看到「❌ 被拒絕」與拒絕原因，按「我知道了」（`dismissRejectedRequest`）才真正刪除
- **送出 toast 重寫**：pending 送出改顯示「已送出給 ○○ 同意。對方同意後紀錄才會正式成立並產生 PDF。」
- **紀錄列表新增「下載 PDF」**：發起人當下不在線時，可在「全校調代課紀錄」事後補下載 PDF
- **相關檔案**：
  - `src/js/modules/v2/pendingRequestService.js`（soft-reject、dismissRejectedRequest）
  - `src/js/modules/v2/schoolDataService.js`（updatePendingRequest）
  - `src/js/v2-app.js`（v2NeedsApproval、patchPdfGenerators、generatePdfForRecord、rejected 徽章、下載 PDF 按鈕）

---

## [1.9.0] - 2026-04-13

### 新增
- **課表匯入頁籤資料備份還原**：在左側面板新增「資料備份還原」區塊，可直接匯出備份或匯入 JSON 還原資料，含檔案預覽確認

### 介面改進
- **全站緊湊布局改造**：所有頁籤統一採用緊湊卡片、toolbar 化操作列、雙欄並排設計
  - 課表匯入：左右雙欄（上傳+備份 / 教師屬性）
  - 課表編輯：教師選擇 toolbar 化，操作按鈕移至課表標題行
  - 調代課申請：步驟一+步驟二並排顯示，異動類型卡片緊湊化
  - 調代課紀錄：篩選條件 toolbar 化（標題+日期+教師+查詢同一行）
  - 月結算：選擇條件 toolbar 化（標題+學年度+月份+按鈕同一行）
  - 設定：雲端同步+資料管理雙欄布局
- **Toast 通知系統**：全站通知改為右上角懸浮淡入淡出樣式，取代原有的 `alert()` 阻塞式對話框
  - 支援 success / error / warning / info 四種類型
  - 自動消失並可手動關閉

### 重構
- **移除課表編輯頁籤的新增教師功能**：統一由課表匯入頁籤管理教師資料

### 修復
- 修正設定匯入時呼叫不存在的 `saveData()` 方法導致匯入失敗（改為 `saveDataToStorage()`）
- 調代課申請步驟二固定顯示，不再隨教師選擇切換

---

## [1.8.0] - 2026-04-10

### 新增
- **多重調課批次功能**：支援一次處理多筆調課申請
- **任教領域可編輯**：教師的任教領域可手動修改
- **教師自行調課功能**：教師可自行發起調課申請
- **課表上傳衝突檢查**：上傳課表時自動檢查並提醒教師排課衝突
- **多重調課彈性選課**：移除選課強制限制，改為送出時整批檢查衝突

### 修復
- 修復多重調課批次面板被隱藏及流程中斷問題
- 修正多重調課衝突檢查誤報未涉及節次的原始排課衝突

---

## [1.7.0] - 2026-04-09

### 新增
- **教師課表手動編輯功能**：可直接在介面上編輯教師課表

### 維護
- 整理專案結構，建立 docs 文件目錄

---

## [1.6.0] - 2026-03-27

### 新增功能
- **多節課調代課模式**：一次操作可處理多節課的代課申請
  - 步驟三新增「多節課模式」切換開關
  - 開啟後可點擊選擇多節課程，再次點擊可取消選擇
  - 已選課程以藍色標籤 (chip) 顯示於課表下方
  - 可個別移除或一鍵清除全部已選課程

### 功能優化
- **多節課確認摘要**：步驟四顯示表格形式的多節課清單
  - 依節次排序，清楚顯示班級、科目
  - 共用同一位代課教師和假別
- **多節課 PDF 生成**：
  - 一份四聯 PDF 包含所有選中的課程
  - 週課表中同時標記多個異動節次
  - 班級/科目欄位以標籤形式列出所有課程
  - 檔名包含節次資訊（如：`調代課通知_20260327_王老師_1-3節.pdf`）

### 介面改進
- 新增 `.multi-course-toggle` 滑動切換開關樣式
- 新增 `.course-chip` 已選課程標籤樣式
- 新增 `.schedule-course.multi-selected` 多選狀態樣式（藍色 + 勾選標記）
- 新增 `.multi-course-summary` 多節課摘要表格
- 多節課模式下自動禁用「調課」選項（僅支援代課）

---

## [1.5.0] - 2026-03-25

### 新增功能
- **登入資料同步智慧判斷**：
  - 登入時自動比較本地與雲端的學校名稱
  - 學校名稱相同時：詢問是否合併資料
  - 學校名稱不同時：清除本地資料，載入雲端資料
  - 避免不同學校資料混淆

### 功能優化
- **PDF 課表表格放大**：提升課表可讀性
  - 表格整體字體從 12px 增加至 14px
  - 表頭 padding 從 6px 增加至 10px
  - 節次欄位寬度從 50px 增加至 60px
  - 異動格子字體從 9px 增加至 12px
  - 空白格子高度從 35px 增加至 45px
- **PDF 課表異動欄位**：同時顯示班級、科目及教師資訊
  - 格式：「班級 科目」+ 換行 +「原 OOO / 代 OOO」
- **PDF 表格欄位順序調整**：
  - 第一列：異動類型 | 原任課教師
  - 第二列：日期 | 代課教師

### 修復
- 修復代課教師推薦功能在選擇課程後無法顯示的問題
- 修復 checkExistingRecord 方法調用問題（瀏覽器快取相容性）

---

## [1.4.0] - 2026-03-24

### 重大變更
- **移除 Google Sheets 雲端同步**：改用 Firebase 實現更穩定的雲端同步
- **新增 Firebase 雲端同步**：
  - Google 帳號一鍵登入（Firebase Authentication）
  - Firebase Realtime Database 即時資料同步
  - 支援多設備共享調代課紀錄
  - 離線時自動切換本地儲存模式
- **內建 Firebase 設定**：使用者無需自行設定，開箱即用
- **新增網站底部製作者資訊**

---

## [1.3.3] - 2026-03-23

### 功能優化
- **PDF 通知單黑白列印優化**：全面改用灰階樣式，適合黑白印表機
  - 所有彩色元素改為灰階色調
  - 表頭、標籤等統一使用深灰色系
- **各聯網底標識**：以深灰網底標識各聯重點欄位，便於快速辨識
  - 原任課教師聯：「原任課教師」欄位加網底
  - 代（調）課教師聯：「代課教師」欄位加網底
  - 班級聯：「班級/科目」欄位加網底
  - 教學組聯：無特殊網底，顯示完整資訊
- **各聯資訊差異化顯示**：
  - 代（調）課教師聯：移除「公假字號」欄位
  - 班級聯：移除「請假假別」及「公假字號」欄位
- **課表午休分隔行**：在第四節與第五節之間新增「午休」橫向分隔行，方便辨識上午/下午課程
- **課表異動欄位優化**：顯示原教師與調代課教師姓名（上下兩行排列）
  - 代課模式：「原 OOO / 代 OOO」
  - 調課模式：「原 OOO / 調 OOO」

---

## [1.3.2] - 2026-03-17

### 新增功能
- **資料匯入功能**：支援從備份檔案還原所有資料
  - 選擇 JSON 備份檔案後顯示資料預覽
  - 預覽包含學校名稱、課表筆數、教師數、班級數、調代課紀錄數
  - 確認匯入前會提醒使用者先備份目前資料
  - 匯入完成後自動重新載入頁面套用變更

### 功能優化
- **資料管理區塊重新設計**：
  - 分為「匯出備份」、「匯入還原」、「危險操作」三個區塊
  - 每個功能都有清楚的說明文字
  - 匯入流程加入預覽確認步驟，避免誤操作

---

## [1.3.1] - 2026-03-16

### 修復
- **PDF 課表異動標示**：修正課表異動無法顯示的問題
  - 節次格式從阿拉伯數字改為中文數字（第1節→第一節）
  - 新增節次格式轉換對照表，支援多種格式輸入

### 功能優化
- **調課日期分離**：調課時段 A 與時段 B 可選擇不同日期
  - 時段 A 日期：原課程的調課日期
  - 時段 B 日期：互換課程的調課日期
  - 支援跨週調課，更符合實際調課需求
- **調課介面改進**：
  - 時段 A 資訊卡片（藍色）顯示已選課程與日期
  - 時段 B 選擇區（黃色）選擇互換日期與課程
  - 課程列表根據時段 B 日期對應的星期自動過濾
- **調課預覽表格**：顯示完整的日期與時段資訊
- **PDF 調課通知單**：顯示時段 A 和時段 B 各自的日期

---

## [1.3.0] - 2026-03-16

### 新增功能
- **調代課申請流程優化**：全新步驟式引導介面
  - 步驟一：選擇原任課教師與調課日期
  - 步驟二：選擇異動類型（代課/調課）與假別
  - 步驟三：從課表選擇課程（僅顯示對應日期的課程）
  - 步驟四：確認資訊並提交

### 功能優化
- **異動類型選擇器**：改用卡片式 Radio Button 設計
  - 圖示 + 標題 + 說明，更直觀易懂
  - 代課：👤 他人代理授課
  - 調課：🔄 同班級兩堂課互換時段
- **假別選擇前置**：假別選項移至選擇課程前，減少操作步驟
- **課表日期限制**：根據選定日期自動高亮該日課程
  - 當日課程以黃色邊框標示，可點擊選擇
  - 非當日課程灰色禁用，避免日期錯誤
  - 欄位標題高亮顯示當日星期
- **課程摘要卡片**：選中課程資訊以網格布局呈現，一目了然

### 介面改進
- 新增 `.change-type-selector` 卡片式選擇器樣式
- 新增 `.selected-course-summary` 課程摘要網格
- 新增 `.schedule-course.today-highlight` 當日課程高亮
- 新增 `.schedule-header.active-day` 當日欄位標題高亮
- 步驟卡片過渡動畫，提升使用體驗

---

## [1.2.0] - 2026-03-13

### 新增功能
- **公付假別擴充**：新增兩種不扣時數的公付假別
  - 長期病假（3日以上）：需填寫核准文號
  - 喪假：需填寫喪假證明
- 假別選擇器改為分組顯示（公付假別 / 一般假別）
- 字號欄位依假別類型動態調整標籤和提示文字
- **日期與星期驗證**：防止調課日期與課程星期不符
  - 選擇課程後清空日期，提示用戶選擇正確星期
  - 日期變更時即時驗證，顯示符合（綠色）或不符（紅色）提示
  - 確認提交時再次驗證，不符時提示並建議調整
- **PDF 通知單改版**：全新一式四聯版面設計
  - 每頁左右各一聯，共兩頁（原任課教師聯+代課教師聯、班級聯+教學組聯）
  - 標題區：學校名稱 + 代課通知單 + 聯單類型標籤
  - 基本資訊表格：異動類型、日期、教師、節次、班級/科目、假別、公假字號
  - 該週課表異動表格：僅標記異動課程（藍色），其他留空
  - 底部簽章區：列印日期、申請人、教務處
- **學校名稱設定**：PDF 通知單左上角學校名稱管理
  - 自動從匯入檔名解析學校名稱（支援「國中」「國民中學」「中學」「高中」關鍵字）
  - 於「課表匯入」頁籤提供手動編輯功能
  - 未設定學校名稱時鎖定其他功能頁籤，確保 PDF 輸出完整性
  - 學校名稱持久化存儲於 localStorage

### 修復
- **調課邏輯修正**：重新設計調課功能，符合實際教學調課需求
  - 調課定義：同班級兩個不同時段的課程互換
  - 選擇原課程後，顯示同班級所有其他時段課程供選擇
  - 調課預覽表格：清楚顯示調課前後的時段與教師變化
  - 調課後雙方教師總時數不變，僅授課順序調整
  - PDF 調課通知單：顯示時段 A/B 互換資訊，課表標記兩個異動時段

---

## [1.1.0] - 2026-03-12

### 新增功能
- **設定頁籤**：獨立的系統設定頁面
  - Google Sheets 雲端同步設定
  - 詳細設定教學彈窗（四步驟完整指南）
  - 資料管理功能（匯出備份、清除資料）

### 功能優化
- **調代課紀錄頁籤**：
  - 頁籤名稱改為「調代課紀錄」
  - 表格「事由」欄位改為「假別」
  - 新增「更多」按鈕顯示詳細資料彈窗（事由、公假字號、建立時間等）
  - 切換頁籤時自動載入本月資料
- **月結算頁籤**：
  - 有變動的教師以黃色背景標記
  - 代課增加時數以綠色顯示（+N）
  - 被代課減少時數以紅色顯示（-N）
  - 新增「僅顯示有變動的教師」勾選篩選功能
  - 顯示變動教師總數統計

### 修復
- 新增網站 favicon 圖標，避免 404 錯誤
- Google Sheets 同步 CORS 問題修復（改用 text/plain Content-Type）

### 變更
- Google Sheets 紀錄欄位改用繁體中文
  - 異動類型：substitute → 代課、swap → 調課
  - 假別代碼：official → 公假、personal → 事假、sick → 病假、rest → 休假、other → 其他
- 月結算計算模組支援中英文代碼相容

---

## [1.0.0] - 2026-03-12

### 新增功能
- **課表匯入**：支援人力資源網2.0匯出的 CSV/Excel 課表檔案
- **調代課申請**：
  - 智慧推薦演算法（同領域優先、導師班級加分、空堂教師篩選）
  - 異動類型區分：代課（他人代理授課）/ 調課（兩位教師互換）
  - 假別選擇：公假、事假、病假、休假、其他
  - 公假字號動態欄位（選擇公假時必填）
  - 調課班級驗證（僅顯示同時段有相同班級的教師可互換）
- **PDF 通知單生成**：
  - 四聯單輸出（原任課教師、代課教師、班級公告、教學組存查）
  - html2canvas 中文字型支援
  - 僅顯示異動課程，其他節次留空
- **調課紀錄**：依日期、教師篩選查詢
- **月結算報表**：
  - 假別區分計算邏輯
  - 公假/調課不扣時數（學校公費支付/互換）
  - 事假/病假/休假/其他扣減時數
  - Excel 匯出功能
- **Google Sheets 雲端同步**：
  - Apps Script Web App 後端
  - 支援新增、更新、刪除、批次同步
  - 欄位：ID、異動類型、日期、星期、節次、班級、科目、領域、原任課教師、代課教師、假別代碼、假別名稱、公假字號、事由、建立時間

### 技術架構
- 純前端 SPA（可部署於 GitHub Pages）
- ES6 模組化設計
- CDN 引入：PapaParse、jsPDF、jsPDF-AutoTable、SheetJS (xlsx)、html2canvas
- LocalStorage 本地儲存
- Playwright E2E 測試

### 檔案結構
```
STsystem/
├── index.html              # 主頁面
├── src/
│   ├── css/
│   │   └── style.css       # 樣式表
│   └── js/
│       ├── app.js          # 主應用程式
│       └── modules/
│           ├── dataManager.js         # 資料管理
│           ├── scheduleParser.js      # 課表解析
│           ├── recommendationEngine.js # 推薦引擎
│           ├── pdfGenerator.js        # PDF 生成
│           └── settlementCalculator.js # 月結算計算
├── google-apps-script/
│   └── Code.gs             # Google Apps Script 後端
└── test/
    ├── test-runner.html    # 測試頁面
    └── test-data.csv       # 測試資料
```
