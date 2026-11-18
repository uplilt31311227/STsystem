/**
 * 教師姓名「比對用」正規化（V1 推薦、衝堂、新增教師防重、重匯名冊合併使用）
 *
 * 專案裡有兩套正規化，各有用途，不可混為一談：
 *   - 本檔：NFKC＋去零寬字元＋CJK 字之間空白去除，較寬鬆。只用於比對，絕不寫回存檔的姓名。
 *   - v2/teacherIdentity.js 與 settlementCalculator.js（normName）：全形空白轉半形＋trim，較嚴。
 *     用於「姓名 → teacherId」解析與月結算；改動會牽動結算黃金值，故未合併。
 * 兩者都只做比對，存檔的姓名一律維持原字串（只 trim），這樣名冊、課表、紀錄、rules 的自我調課
 * 姓名檢查（isSelfSwapNamesOk）、刪除教師前的有課檢查都能以精確比對對得上。
 *
 * 為什麼需要：同一位教師在課表檔、名冊、紀錄裡可能有不同寫法（「李　小華」中間全形空白、
 * 「李小華 」尾端空白、全形英數字），過去各處各自 trim 或完全不處理，比對時被當成不同人。
 * 課表解析、推薦引擎、衝堂判斷、新增教師防重一律改用本函式。
 *
 * 規則：
 *   1. NFKC（全形空白、全形英數轉半形）
 *   2. 去除零寬字元與 BOM
 *   3. 連續空白合為一個、去除前後空白
 *   4. 兩側都是中日韓文字之間的空白一律去除（「李 小華」→「李小華」）；
 *      西文姓名（外師，例如「John Smith」）內部的單一空格保留
 *
 * 不處理括號註記（「李小華(代理)」）：那可能是另一個人，需人工判斷，不在自動合併範圍。
 * 回傳值只用於比對。
 *
 * @param {*} name
 * @returns {string}
 */
const CJK = '\u2E80-\u9FFF\uF900-\uFAFF';
const CJK_GAP = new RegExp(`(?<=[${CJK}]) (?=[${CJK}])`, 'g');

export function normalizeTeacherName(name) {
    if (name == null) return '';
    return String(name)
        .normalize('NFKC')
        .replace(/[​-‍⁠﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(CJK_GAP, '');
}
