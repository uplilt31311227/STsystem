/**
 * 自動斷線判斷邏輯（純函式，便於單元測試）。
 *
 * Budget 會「定期」（一天多次）把目前狀態送到 Pub/Sub，不只在跨過門檻時才送，
 * 所以每則訊息都要自己比對 costAmount 是否已達 budgetAmount。
 * 只看實際花費（costAmount），不看預測值，避免月初預測暴衝就誤斷全校。
 *
 * @param {object} payload    Budget 通知 JSON（costAmount, budgetAmount, currencyCode, budgetDisplayName…）
 * @param {object} attributes Pub/Sub 訊息屬性（billingAccountId, budgetId, schemaVersion）
 * @param {object} cfg        { budgetId, billingAccountId }
 * @returns {{ action: 'unlink'|'ignore', reason: string }}
 */
export function decide(payload, attributes = {}, cfg = {}) {
    if (!payload || typeof payload !== 'object') {
        return { action: 'ignore', reason: '訊息內容無法解析' };
    }
    // 只認指定的斷線預算，其他預算（250/300/500 警報）就算接到同一個 topic 也不動作
    if (cfg.budgetId && attributes.budgetId !== cfg.budgetId) {
        return { action: 'ignore', reason: `不是斷線預算（budgetId=${attributes.budgetId || '無'}）` };
    }
    if (cfg.billingAccountId && attributes.billingAccountId !== cfg.billingAccountId) {
        return { action: 'ignore', reason: `帳單帳戶不符（${attributes.billingAccountId || '無'}）` };
    }
    const cost = Number(payload.costAmount);
    const budget = Number(payload.budgetAmount);
    if (!Number.isFinite(cost) || !Number.isFinite(budget) || budget <= 0) {
        return { action: 'ignore', reason: `金額欄位異常（cost=${payload.costAmount}, budget=${payload.budgetAmount}）` };
    }
    if (cost < budget) {
        return { action: 'ignore', reason: `未達門檻：${cost} < ${budget} ${payload.currencyCode || ''}`.trim() };
    }
    return { action: 'unlink', reason: `已達門檻：${cost} >= ${budget} ${payload.currencyCode || ''}`.trim() };
}
