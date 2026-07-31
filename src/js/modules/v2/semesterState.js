/**
 * 目前作用中學期 ID 的記憶體快取（Stage 2，RESEARCH-multitenancy-semester.md §5/§6.1）。
 *
 * 由 v2-app.js bootstrap 在身份解析完成後讀一次 `config.currentSemester`（找不到時以
 * semesterUtils.todaySemesterId() 依今天日期推算，見該處呼叫端註解）寫入本模組；之後
 * schoolDataService／pendingRequestService／operationLogger 等寫入路徑一律讀本模組取得
 * 「目前學期」，不必每個呼叫點各自重新讀 config（config 已在權限鏈其他地方被讀過，見報告
 * §3.6「學期鎖的計費成本為 0」的同一精神——這裡是把同一個值在單一 session 內只抓一次）。
 *
 * 學期切換 UI（「開新學期」）寫入 config.currentSemester 成功後，必須同步呼叫
 * setCurrentSemesterId() 更新這份快取，否則切換後同一 session 內的新寫入仍會被舊值蓋掉、
 * 送到 Firestore 後被學期唯讀鎖擋下（rules 端已認新學期，client 端快取還是舊的）。
 *
 * 身份切換／登出不需要清空這個值——currentSemester 是「學校」層級的設定，不是「個人身份」
 * 的一部分，同一學校內不同使用者登入看到的應該是同一個值；下一次 bootstrap 重新讀 config
 * 時自然會覆蓋成當下的正確值。
 *
 * ⚠ 驗收修復（輕 11）：本模組只有單一模組層級變數，這個設計成立的前提是「一個瀏覽器分頁
 * 內同時只服務一所學校」——目前整個 V2 架構本來就是如此（`schemaConstants.SCHOOL_ID` 是
 * import-time 的單點常數，見 §8 Stage 3「SCHOOL_ID 動態化」規劃），本模組沿用同一個假設，
 * 不是本模組獨有的限制。Stage 3 若把 `SCHOOL_ID` 改成 runtime 依登入使用者解析（多租戶、
 * 同一使用者可能屬於不同學校），本模組必須同步改為以 schoolId 為 key 的 Map
 * （例如 `Map<schoolId, semesterId>`），否則同一分頁內切換學校時，目前學期會被錯誤地
 * 沿用成上一個學校的值。這裡先記錄下來，避免 Stage 3 實作時漏掉這個相依。
 */

let _currentSemesterId = null;

export function getCurrentSemesterId() {
    return _currentSemesterId;
}

export function setCurrentSemesterId(id) {
    _currentSemesterId = id || null;
}
