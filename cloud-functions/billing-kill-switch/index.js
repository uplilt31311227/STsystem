/**
 * 帳單自動斷線（billing kill switch）
 *
 * 流程：Budget「STsystem 自動斷線 TWD 1000」→ Pub/Sub topic `billing-kill-switch`
 *       → 本函式 → 當月實際花費達預算時，解除 stsystem-9d5fe 的帳單帳戶綁定。
 *
 * ⚠️ 解除綁定 = 整個專案退回免費方案：Firestore 超過每日免費額度後全校無法讀寫，
 *    Cloud Functions 等付費服務停止（包含本函式）。恢復需人工重新綁定，見
 *    docs/BILLING-KILL-SWITCH.md。
 *
 * 環境變數：
 *   TARGET_PROJECT_ID   要斷線的專案（stsystem-9d5fe）
 *   BUDGET_ID           只回應這個預算的訊息（必填，缺少則不動作）
 *   BILLING_ACCOUNT_ID  只回應這個帳單帳戶的訊息（必填，缺少則不動作）
 *   DRY_RUN             只有 'false' 才會真的斷線；其他值（含未設定）只記錄
 *   DISARMED_UNTIL      ISO 時間；在此之前不動作（恢復服務後暫停用）
 */
import functions from '@google-cloud/functions-framework';
import { CloudBillingClient } from '@google-cloud/billing';
import { decide, isArmed } from './decide.js';

const billing = new CloudBillingClient();

/** 結構化日誌：Cloud Logging 會依 severity 分級，方便設定告警 */
function log(severity, message, extra = {}) {
    console.log(JSON.stringify({ severity, message: `[kill-switch] ${message}`, ...extra }));
}

functions.cloudEvent('billingKillSwitch', async (cloudEvent) => {
    const msg = cloudEvent?.data?.message || {};
    const attributes = msg.attributes || {};
    let payload = null;
    try {
        payload = JSON.parse(Buffer.from(msg.data || '', 'base64').toString('utf8'));
    } catch (e) {
        log('WARNING', `無法解析訊息：${e.message}`);
        return;
    }

    const projectId = process.env.TARGET_PROJECT_ID;
    const armed = isArmed(process.env.DRY_RUN);
    const { action, reason } = decide(payload, attributes, {
        budgetId: process.env.BUDGET_ID,
        billingAccountId: process.env.BILLING_ACCOUNT_ID,
        disarmedUntil: process.env.DISARMED_UNTIL,
    });

    if (action !== 'unlink') {
        log('INFO', `不動作：${reason}`);
        return;
    }
    if (!projectId) {
        log('CRITICAL', `${reason}，但未設定 TARGET_PROJECT_ID，無法斷線`);
        return;
    }

    const name = `projects/${projectId}`;
    try {
        const [info] = await billing.getProjectBillingInfo({ name });
        if (!info.billingEnabled) {
            log('NOTICE', `${reason}；${projectId} 已經沒有綁定帳單，不需動作`);
            return;
        }
        if (!armed) {
            log('WARNING', `DRY_RUN：${reason}；本來會解除 ${projectId} 與 ${info.billingAccountName} 的綁定`);
            return;
        }
        await billing.updateProjectBillingInfo({ name, projectBillingInfo: { billingAccountName: '' } });
        log('ALERT', `🚨 已解除 ${projectId} 的帳單綁定（原帳戶 ${info.billingAccountName}）：${reason}`);
    } catch (e) {
        // 斷線失敗＝保護失效，必須留下高嚴重度紀錄
        log('CRITICAL', `${reason}，但斷線失敗：${e.code ?? ''} ${e.message}`, { error: String(e.stack || e) });
    }
});
