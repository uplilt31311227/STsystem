/**
 * 管理腳本的參數解析（純函式，可單元測試：test/test-script-safety.mjs）。
 * 解析錯誤一律丟 Error，由呼叫端決定如何顯示與結束。
 */
const { parseWriteMode } = require('./script-safety');

/**
 * bootstrap-platform-admin.js 的參數。
 * 寫入判斷與 parseWriteMode 一致：任何 dry-run 旗標（--dry-run、--dry-run=true）存在即不寫。
 * 為相容既有上線文件，--dry-run=false 視為 --apply（與 dry-run 旗標並存時仍不寫）。
 */
function parseAdminArgs(args) {
    const flags = { uid: null, email: null, list: false, remove: false, dryRun: true, note: null, forceRemoveLast: false };
    for (const a of args) {
        if (a === '--list') flags.list = true;
        else if (a === '--remove') flags.remove = true;
        else if (a === '--force-remove-last') flags.forceRemoveLast = true;
        else if (a.startsWith('--uid=')) flags.uid = a.slice('--uid='.length);
        else if (a.startsWith('--email=')) flags.email = a.slice('--email='.length).toLowerCase().trim();
        else if (a.startsWith('--account=')) { /* 操作者帳號，由 script-safety.resolveOperatorAccount 處理 */ }
        else if (a.startsWith('--note=')) flags.note = a.slice('--note='.length);
        else if (a === '--dry-run' || a === '--dry-run=true' || a === '--dry-run=false' || a === '--apply') { /* 由 parseWriteMode 判斷 */ }
        else throw new Error(`未知參數：${a}`);
    }
    flags.dryRun = parseWriteMode(args, { dryRunFalseIsApply: true }).dryRun;
    return flags;
}

/**
 * firestore-bootstrap-inhu.js 的參數。以「--」開頭的 token 不得被當成值吃掉。
 */
function parseInhuArgs(args) {
    const flags = { addTeacher: false, name: null, email: null, role: 'teacher', domains: [], homeroom: '' };
    const valueOf = (i, name) => {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`${name} 需要一個值，但後面是 ${v === undefined ? '（空）' : v}`);
        return v;
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--add-teacher') flags.addTeacher = true;
        else if (a === '--name')     { flags.name = valueOf(i, a); i++; }
        else if (a === '--email')    { flags.email = valueOf(i, a); i++; }
        else if (a === '--role')     { flags.role = valueOf(i, a); i++; }
        else if (a === '--domains')  { flags.domains = valueOf(i, a).split(',').map(s => s.trim()).filter(Boolean); i++; }
        else if (a === '--homeroom') { flags.homeroom = valueOf(i, a); i++; }
        else if (a === '--apply' || a === '--dry-run' || a === '--dry-run=true' || a === '--dry-run=false' || a.startsWith('--project=') || a.startsWith('--account=') || a.startsWith('--director=')) { /* 由 safety 處理 */ }
        else throw new Error(`未知參數：${a}`);
    }
    return flags;
}

module.exports = { parseAdminArgs, parseInhuArgs };
