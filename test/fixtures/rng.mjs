/**
 * 確定性亂數（mulberry32）
 *
 * 假資料一律用固定 seed 產生，理由：測試若吃 Math.random()，同一份斷言時而通過時而失敗，
 * 失敗時也無法重現。所有 fixture 產生函式都必須接受外部傳入的 rng，不得自行呼叫
 * Math.random()／Date.now()。
 */

/** @param {number} seed 32-bit 整數 */
export function makeRng(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** [0, n) 的整數 */
export function randInt(rng, n) {
    return Math.floor(rng() * n);
}

/** 從陣列取一個元素 */
export function pick(rng, arr) {
    return arr[randInt(rng, arr.length)];
}

/** Fisher-Yates，回傳新陣列，不動原陣列 */
export function shuffle(rng, arr) {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
        const j = randInt(rng, i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
