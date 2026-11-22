"""教師總課表(直式) xlsx -> 人力資源網 2.0 課表 CSV。
用法: uv run --no-project --with openpyxl python -I scripts/convert-teacher-grid-xlsx.py <in.xlsx> <out.csv> [report.json]
"""
import sys, re, csv, json, collections
import openpyxl

DAYS = ['週一', '週二', '週三', '週四', '週五']
PERIODS = ['第一節', '第二節', '第三節', '第四節', '第五節', '第六節', '第七節', '第八節']
SKIP_TEACHERS = {'外師'}
# 縮寫 -> (類別, 領域, 科目, 語言別/校訂課程名稱)
L, F = '領域學習', '彈性學習'
M = {
 '國文': (L, '語文領域', '國語文', '國語文'),
 '英文': (L, '語文領域', '英語文', '英語文'),
 '本土': (L, '語文領域', '閩南語文/閩南語', '閩南語文/閩南語'),
 '數學': (L, '數學領域', '數學', '數學'),
 '健康': (L, '健康與體育領域', '健康教育', '健康教育'),
 '體育': (L, '健康與體育領域', '體育', '體育'),
 '地理': (L, '社會領域', '地理', '地理'),
 '歷史': (L, '社會領域', '歷史', '歷史'),
 '公民': (L, '社會領域', '公民與社會', '公民與社會'),
 '生科': (L, '科技領域', '生活科技', '生活科技'),
 '資科': (L, '科技領域', '資訊科技', '資訊科技'),
 '家政': (L, '綜合活動領域', '家政', '家政'),
 '童軍': (L, '綜合活動領域', '童軍', '童軍'),
 '輔導': (L, '綜合活動領域', '輔導', '輔導'),
 '理化': (L, '自然科學領域', '理化', '理化'),
 '生物': (L, '自然科學領域', '生物', '生物'),
 '地科': (L, '自然科學領域', '地球科學', '地球科學'),
 '音樂': (L, '藝術領域', '音樂', '音樂'),
 '視藝': (L, '藝術領域', '視覺藝術', '視覺藝術'),
 '表藝': (L, '藝術領域', '表演藝術', '表演藝術'),
 '書田': (F, '統整性主題/專題/議題探究', '慮得書田', '慮得書田'),
 '國際': (F, '統整性主題/專題/議題探究', '國際視野', '國際視野'),
 '生數': (F, '統整性主題/專題/議題探究', '生活藝數', '生活藝數'),
 '論壇': (F, '統整性主題/專題/議題探究', '內中論壇', '內中論壇'),
 '茶花': (F, '統整性主題/專題/議題探究', '人文茶花', '人文茶花'),
 '園圃': (F, '統整性主題/專題/議題探究', '湖心園圃', '湖心園圃'),
 '社團': (F, '社團活動與技藝課程', '社團活動', '社團'),
}
# 本土語預設閩南語；沿用 v2 正式庫已知為客語的教師（Excel 只寫「本土」）
# repo 公開，不寫真實姓名：以環境變數 HAKKA_TEACHERS（逗號分隔）指定
import os
HAKKA_TEACHERS = {n.strip() for n in os.environ.get('HAKKA_TEACHERS', '').split(',') if n.strip()}
HAKKA = (L, '語文領域', '客語文/四縣腔', '客語文/四縣腔')
CELL = re.compile(r'^([^0-9]*)(\d{3})\s*[/\n]\s*(.+)$', re.S)

sys.stdout.reconfigure(encoding='utf-8')

def main():
    src, out = sys.argv[1], sys.argv[2]
    rep_path = sys.argv[3] if len(sys.argv) > 3 else None
    ws = openpyxl.load_workbook(src, data_only=True).worksheets[0]
    teachers = {c: str(ws.cell(1, c).value or '').strip() for c in range(1, 26)}
    rows, prefixes, skipped, unknown, odd = [], collections.Counter(), [], collections.Counter(), []
    for r in range(2, 42):  # 5 天 x 8 節
        d, p = divmod(r - 2, 8)
        for c in range(1, 26):
            t = teachers[c]
            v = ws.cell(r, c).value
            if v is None or str(v).strip() == '':
                continue
            v = str(v).strip()
            if t in SKIP_TEACHERS:
                skipped.append((t, DAYS[d], PERIODS[p], v, '外師不匯入'))
                continue
            m = CELL.match(v)
            if not m:
                skipped.append((t, DAYS[d], PERIODS[p], v, '無班級碼'))
                continue
            pre, code, subj = m.groups()
            if pre: prefixes[pre] += 1
            subj = subj.strip()
            if subj not in M:
                unknown[subj] += 1
                continue
            cat, dom, sub, lang = HAKKA if (subj == '本土' and t in HAKKA_TEACHERS) else M[subj]
            g, cl = int(code[0]), int(code[1:])
            rows.append([DAYS[d], PERIODS[p], f'{g}年級', f'{g}年{cl}班', t, '', cat, dom, sub, lang, 1, 1])
    with open(out, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['週次','節次','年級','班級','教師姓名','身分證字號或居留證號','類別','領域','科目','語言別/校訂課程名稱','上課頻率','起始週'])
        w.writerows(rows)
    totals = {teachers[c]: str(ws.cell(46, c).value or '') for c in range(1, 26)}
    per = collections.Counter(r[4] for r in rows)
    rep = dict(rows=len(rows), prefixes=prefixes, skipped=skipped, unknown=unknown, totals=totals, per=per)
    print('rows', len(rows)); print('prefixes', dict(prefixes)); print('unknown', dict(unknown))
    print('skipped', len(skipped))
    for s in skipped:
        if s[4] != '外師不匯入': print('  ', s)
    print('teacher | rows | row46')
    for t in teachers.values():
        if t and t not in SKIP_TEACHERS: print(f'{t} | {per[t]} | {totals[t]}')
    if rep_path:
        json.dump(rep, open(rep_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

main()
