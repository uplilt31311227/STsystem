// node 自訂載入器：把 https://www.gstatic.com/firebasejs/… 的動態 import 導向本機假 SDK（gstatic-stub.mjs），
// 讓服務層（schoolDataService／pendingRequestService）能在 node 下離線執行，不連任何 Firebase。
export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('https://www.gstatic.com/firebasejs/')) {
        return { url: new URL('./gstatic-stub.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
