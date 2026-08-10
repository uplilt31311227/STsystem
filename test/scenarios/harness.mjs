/**
 * 情境測試的最小骨架
 *
 * 刻意不用 node:test：這批測試要「全部跑完再一次回報」，單一案例失敗不得中斷後面的案例，
 * 而且需要把「已知缺陷」與「真正的失敗」分開列——node:test 的 runner 沒有這個概念。
 */

export class AssertionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AssertionError';
    }
}

const fmt = (v) => {
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`;
    if (v && typeof v === 'object') return JSON.stringify(v);
    return String(v);
};

export function ok(cond, label) {
    if (!cond) throw new AssertionError(`${label}：預期為真，實際為假`);
}

export function eq(actual, expected, label) {
    const a = fmt(actual), e = fmt(expected);
    if (a !== e) throw new AssertionError(`${label}\n      預期：${e}\n      實際：${a}`);
}

export function includes(haystack, needle, label) {
    if (!String(haystack).includes(needle)) {
        throw new AssertionError(`${label}\n      預期包含：${fmt(needle)}\n      實際內容：${fmt(haystack)}`);
    }
}

/** Firestore REST 回應：預期成功 */
export function allowed(res, label) {
    if (!res.ok) throw new AssertionError(`${label}：預期允許，卻被拒絕（HTTP ${res.status}：${res.error}）`);
}

/** Firestore REST 回應：預期被規則拒絕（403），而不是其他任何錯誤 */
export function denied(res, label) {
    if (res.ok) throw new AssertionError(`${label}：預期被拒絕，卻成功了（HTTP ${res.status}）`);
    if (res.status !== 403) {
        throw new AssertionError(
            `${label}：預期被 Security Rules 拒絕（403），實際是 HTTP ${res.status}：${res.error}\n` +
            `      （非 403 代表擋下來的不是權限規則，可能是路徑或資料格式問題，不算通過）`
        );
    }
}

export class Suite {
    constructor(title) {
        this.title = title;
        this.cases = [];
    }

    /**
     * 執行一個案例。
     * @param {string} name
     * @param {Function} fn
     * @param {{ knownGap?: string }} opts knownGap 用於「系統目前確實如此、但值得記錄」的行為
     */
    async case(name, fn, opts = {}) {
        const started = Date.now();
        try {
            await fn();
            this.cases.push({ name, status: 'pass', ms: Date.now() - started, knownGap: opts.knownGap });
        } catch (err) {
            this.cases.push({
                name,
                status: err instanceof AssertionError ? 'fail' : 'error',
                ms: Date.now() - started,
                message: err.message,
                stack: err instanceof AssertionError ? null : err.stack,
            });
        }
    }

    get passed() { return this.cases.filter(c => c.status === 'pass').length; }
    get failed() { return this.cases.filter(c => c.status !== 'pass').length; }
    get gaps()   { return this.cases.filter(c => c.knownGap); }

    print() {
        console.log(`\n━━ ${this.title} ━━`);
        for (const c of this.cases) {
            const icon = c.status === 'pass' ? '✅' : (c.status === 'fail' ? '❌' : '💥');
            console.log(`  ${icon} ${c.name}`);
            if (c.message) console.log(`      ${c.message.replace(/\n/g, '\n      ')}`);
            if (c.stack)   console.log(`      ${c.stack.split('\n').slice(1, 4).join('\n      ')}`);
        }
        console.log(`  — 通過 ${this.passed} / ${this.cases.length}`);
    }
}
