/**
 * 「找學校」搜尋框（ARIA combobox + listbox）。
 *
 * 只負責輸入、候選清單與鍵盤操作；選到學校後呼叫 onSelect(school)，其餘流程由呼叫端處理。
 * 所有學校資料皆來自外部網站，一律經 escapeHtml，事件一律 addEventListener（CSP 不允許 inline handler）。
 */
import { escapeHtml } from '../htmlEscape.js';
import { searchSchools, levelsLabel } from './schoolCodes.js';

/** 搜尋框 HTML。idPrefix 讓同一頁可有多個（例如平台管理員選校）。 */
export function renderSchoolPickerHtml(idPrefix, { label = '找學校（輸入學校名稱或代碼）', placeholder = '例如：內湖國中、新竹 內湖、183511' } = {}) {
    const p = escapeHtml(idPrefix);
    return `
        <div class="v2-school-picker" id="${p}">
            <label for="${p}-input">${escapeHtml(label)}</label>
            <input type="text" id="${p}-input" role="combobox" aria-expanded="false" aria-controls="${p}-list"
                   aria-autocomplete="list" aria-haspopup="listbox" autocomplete="off" placeholder="${escapeHtml(placeholder)}">
            <ul id="${p}-list" role="listbox" class="v2-school-picker-list" aria-label="符合的學校" hidden></ul>
            <div id="${p}-status" class="hint" role="status" aria-live="polite"></div>
            <button type="button" id="${p}-retry" class="btn btn-secondary btn-sm" hidden>重試載入學校名單</button>
        </div>`;
}

/**
 * 綁定搜尋框。
 * @param {ParentNode} root 內含 renderSchoolPickerHtml 產生的節點
 * @param {object} o
 * @param {string} o.idPrefix
 * @param {() => Promise<Array>} o.loadList 取得學校清單（呼叫端負責快取）
 * @param {(school:object) => void} o.onSelect
 * @param {number} [o.debounceMs=150]
 * @returns {{destroy():void}|null}
 */
export function bindSchoolPicker(root, { idPrefix, loadList, onSelect, debounceMs = 150 }) {
    const input = root.querySelector(`#${idPrefix}-input`);
    const list = root.querySelector(`#${idPrefix}-list`);
    const status = root.querySelector(`#${idPrefix}-status`);
    const retry = root.querySelector(`#${idPrefix}-retry`);
    if (!input || !list || !status) return null;

    let results = [];
    let active = -1;
    let timer = null;
    let token = 0;
    let schools = null;

    const close = () => {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    };
    const setActive = (i) => {
        active = i;
        list.querySelectorAll('[role="option"]').forEach((li, idx) => li.setAttribute('aria-selected', String(idx === i)));
        if (i >= 0) {
            input.setAttribute('aria-activedescendant', `${idPrefix}-opt-${i}`);
            list.querySelector(`#${idPrefix}-opt-${i}`)?.scrollIntoView?.({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    };
    const choose = (i) => {
        const s = results[i];
        if (!s) return;
        input.value = s.n;
        close();
        status.textContent = '';
        onSelect(s);
    };
    const render = () => {
        list.innerHTML = results.map((s, i) => `
            <li role="option" id="${escapeHtml(idPrefix)}-opt-${i}" aria-selected="false" data-index="${i}">
                <span class="v2-sp-name">${escapeHtml(s.n)}</span>
                <span class="v2-sp-meta">${escapeHtml(s.ct)} ${escapeHtml(s.d)}・${escapeHtml(levelsLabel(s))}・代碼 ${escapeHtml(s.c)}</span>
            </li>`).join('');
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        active = -1;
    };

    const run = async () => {
        const q = input.value;
        const my = ++token;
        if (retry) retry.hidden = true;
        if (!q.trim()) { results = []; close(); status.textContent = ''; return; }
        try {
            if (!schools) {
                status.textContent = '載入學校名單中…';
                schools = await loadList();
            }
        } catch (e) {
            if (my !== token) return;
            console.warn('[v2] 載入學校代碼失敗:', e);
            close();
            status.textContent = '學校名單載入失敗，請檢查網路後按「重試」。';
            if (retry) retry.hidden = false;
            return;
        }
        if (my !== token) return;
        // 使用者已 Tab 離開（debounce 或首次載入期間失焦）：不要再把清單打開
        if (typeof document !== 'undefined' && document.activeElement !== input) { close(); return; }
        results = searchSchools(schools, q, 20);
        if (!results.length) {
            close();
            status.textContent = '找不到符合的學校';
            return;
        }
        render();
        status.textContent = `找到 ${results.length} 所學校，可用上下鍵選擇、Enter 確認`;
    };

    retry?.addEventListener('click', () => { schools = null; run(); input.focus(); });
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, debounceMs); });
    input.addEventListener('keydown', (e) => {
        const open = !list.hidden && results.length > 0;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!open) { clearTimeout(timer); run(); return; }
            setActive((active + 1) % results.length);
        } else if (e.key === 'ArrowUp' && open) {
            e.preventDefault();
            setActive(active <= 0 ? results.length - 1 : active - 1);
        } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            choose(active >= 0 ? active : (results.length === 1 ? 0 : -1));
        } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault());   // 點選時不讓輸入框失焦
    list.addEventListener('click', (e) => {
        const li = e.target.closest?.('[role="option"]');
        if (li) choose(Number(li.dataset.index));
    });
    input.addEventListener('blur', (e) => { if (e.relatedTarget === retry) return; setTimeout(close, 120); });

    return { destroy() { clearTimeout(timer); token++; } };
}
