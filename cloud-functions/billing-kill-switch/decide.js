/**
 * 自動斷線判斷邏輯（純函式，便於單元測試）。
 *
 * 原則：任何不確定都「不斷線」（fail-closed）。誤斷 = 全校停擺，比多燒一點錢更糟。
 *
 * Budget 會「定期」（一天多次）把目前狀態送到 Pub/Sub，不只在跨過門檻時才送，
 * 所以每則訊息都要自己比對 costAmount 是否已達 budgetAmount。
 * 只看實際花費（costAmount），不看預測值，避免月初預測暴衝就誤斷全校。
 *
 * @param {object} payload    Budget 通知 JSON（costAmount, budgetAmount, currencyCode, costIntervalStart…）
 * @param {object} attributes Pub/Sub 訊息屬性（billingAccountId, budgetId, schemaVersion）
 * @param {object} cfg        { budgetId, billingAccountId, disarmedUntil?, now?: Date }
 * @returns {{ action: 'unlink'|'ignore', reason: string }}
 */
export function decide(payload, attributes = {}, cfg = {}) {
    const ignore = (reason) => ({ action: 'ignore', reason });
    const now = cfg.now instanceof Date ? cfg.now : new Date();

    // 設定缺漏 → 不斷線（否則篩選會被略過，任何預算訊息都可能觸發）
    if (!cfg.budgetId || !cfg.billingAccountId) {
        return ignore('未設定 BUDGET_ID 或 BILLING_ACCOUNT_ID，為安全起見不動作');
    }
    // 人工暫停（恢復服務後到月底前避免再次斷線）
    if (cfg.disarmedUntil) {
        const until = new Date(cfg.disarmedUntil);
        if (Number.isNaN(until.getTime())) {
            return ignore(`DISARMED_UNTIL 格式錯誤（${cfg.disarmedUntil}），為安全起見不動作`);
        }
        if (now < until) return ignore(`已暫停至 ${until.toISOString()}`);
    }
    if (!payload || typeof payload !== 'object') {
        return ignore('訊息內容無法解析');
    }
    // 只認指定的斷線預算，其他預算（250/300/500 警報）就算接到同一個 topic 也不動作
    if (attributes.budgetId !== cfg.budgetId) {
        return ignore(`不是斷線預算（budgetId=${attributes.budgetId || '無'}）`);
    }
    if (attributes.billingAccountId !== cfg.billingAccountId) {
        return ignore(`帳單帳戶不符（${attributes.billingAccountId || '無'}）`);
    }
    // 只處理「本月」的訊息：延遲或重送的上月訊息不可在新月份斷線。
    // 預算的日曆月依帳單帳戶時區（美國太平洋時間）計算。
    const start = new Date(payload.costIntervalStart);
    if (Number.isNaN(start.getTime())) {
        return ignore(`缺少或無法解析 costIntervalStart（${payload.costIntervalStart}）`);
    }
    if (pacificYearMonth(start) !== pacificYearMonth(now)) {
        return ignore(`非本月訊息（costIntervalStart=${payload.costIntervalStart}）`);
    }
    const cost = Number(payload.costAmount);
    const budget = Number(payload.budgetAmount);
    if (!Number.isFinite(cost) || !Number.isFinite(budget) || budget <= 0) {
        return ignore(`金額欄位異常（cost=${payload.costAmount}, budget=${payload.budgetAmount}）`);
    }
    if (cost < budget) {
        return ignore(`未達門檻：${cost} < ${budget} ${payload.currencyCode || ''}`.trim());
    }
    return { action: 'unlink', reason: `已達門檻：${cost} >= ${budget} ${payload.currencyCode || ''}`.trim() };
}

/** 以美國太平洋時間取 'YYYY-MM' */
export function pacificYearMonth(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit',
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    return `${y}-${m}`;
}

/** 只有明確設定 DRY_RUN=false 才會真的斷線；未設定、拼錯或其他值一律視為試跑。 */
export function isArmed(dryRunEnv) {
    return String(dryRunEnv ?? '').trim().toLowerCase() === 'false';
}
