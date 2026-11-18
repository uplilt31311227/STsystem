// node 自訂載入器：gstatic Firebase SDK 換成假 SDK；backupController 的 richDialog.js 換成對話框替身（記錄參數、由測試決定回傳）。
export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('https://www.gstatic.com/firebasejs/')) {
        return { url: new URL('./gstatic-stub.mjs', import.meta.url).href, shortCircuit: true };
    }
    if (specifier.endsWith('/richDialog.js') && context.parentURL && context.parentURL.includes('/v2/backupController.js')) {
        return { url: new URL('./richdialog-stub.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
