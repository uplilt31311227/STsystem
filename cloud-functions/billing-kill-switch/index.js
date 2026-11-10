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
 *   BUDGET_ID           只回應這個預算的訊息
 *   BILLING_ACCOUNT_ID  只回應這個帳單帳戶的訊息
 *   DRY_RUN             'true' 時只記錄、不真的解除（部署驗證用）
 */
import functions from '@google-cloud/functions-framework';
import { CloudBillingClient } from '@google-cloud/billing';
import { decide } from './decide.js';

const billing = new CloudBillingClient();

functions.cloudEvent('billingKillSwitch', async (cloudEvent) => {
    const msg = cloudEvent?.data?.message || {};
    const attributes = msg.attributes || {};
    let payload = null;
    try {
        payload = JSON.parse(Buffer.from(msg.data || '', 'base64').toString('utf8'));
    } catch (e) {
        console.error('[kill-switch] 無法解析訊息：', e.message);
        return;
    }

    const projectId = process.env.TARGET_PROJECT_ID;
    const dryRun = process.env.DRY_RUN === 'true';
    const { action, reason } = decide(payload, attributes, {
        budgetId: process.env.BUDGET_ID,
        billingAccountId: process.env.BILLING_ACCOUNT_ID,
    });

    if (action !== 'unlink') {
        console.log(`[kill-switch] 不動作：${reason}`);
        return;
    }
    if (!projectId) {
        console.error('[kill-switch] 未設定 TARGET_PROJECT_ID，無法斷線');
        return;
    }

    const name = `projects/${projectId}`;
    const [info] = await billing.getProjectBillingInfo({ name });
    if (!info.billingEnabled) {
        console.log(`[kill-switch] ${reason}；${projectId} 已經沒有綁定帳單，不需動作`);
        return;
    }
    if (dryRun) {
        console.warn(`[kill-switch] DRY_RUN：${reason}；本來會解除 ${projectId} 與 ${info.billingAccountName} 的綁定`);
        return;
    }

    await billing.updateProjectBillingInfo({ name, projectBillingInfo: { billingAccountName: '' } });
    console.error(`[kill-switch] 🚨 已解除 ${projectId} 的帳單綁定（原帳戶 ${info.billingAccountName}）：${reason}`);
});
