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
 * ⚠ 驗收修復（輕 11，Stage 3 已處理，見下）：本模組只有單一模組層級變數，這個設計成立的
 * 前提是「一個瀏覽器分頁內同時只服務一所學校」——Stage 3（2026-07-31，§8 Stage 3
 * 「SCHOOL_ID 動態化」）把 `schemaConstants.SCHOOL_ID` 這個 import-time 單點常數改成
 * `getActiveSchoolId()`（登入後由 `authGuardV2.resolveIdentity()` 動態解析設定），
 * 理論上同一使用者確實可能在不同次登入屬於不同學校。
 *
 * 這裡刻意**不**把本模組改成 `Map<schoolId, semesterId>`——因為「一個分頁同時只服務一所
 * 學校」這個前提在 Stage 3 之後依然成立（`getActiveSchoolId()` 本身也只有單一模組層級變數，
 * 同一分頁同一時刻只可能有一個 activeSchoolId，不會同時服務兩所學校），改用 Map 只是換一種
 * 形式維護同一份「單一作用中值」的狀態，不會多解決任何問題。真正需要處理的是「切換學校時
 * 舊值不能殘留」：`v2-app.js` 的 `resetV2ViewState()`（身份「實際改變」時必呼叫，schoolId
 * 改變必然伴隨身份改變，見該函式呼叫點的 identityChanged 守門）新增了
 * `semesterState.setCurrentSemesterId(null)` 這一步，把本模組納入「school 切換」要清空的
 * 狀態清單，下一次 bootstrap 的「學期設定」步驟會重新讀新學校的 `config.currentSemester`
 * 填回正確值。
 */

let _currentSemesterId = null;

export function getCurrentSemesterId() {
    return _currentSemesterId;
}

export function setCurrentSemesterId(id) {
    _currentSemesterId = id || null;
}
