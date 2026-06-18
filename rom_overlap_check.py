"""檢查舊備份的 ROM 課程，在新 114-2 課表的同 slot 是否有別的老師
(用以判斷需要『共同授課』還是『新增單獨 slot』)"""
import json, csv, sys
sys.stdout.reconfigure(encoding='utf-8')

data = json.load(open(r'C:\Users\uplil\Downloads\調代課系統備份_2026-05-21.json', encoding='utf-8'))
rom_courses = [r for r in data['scheduleData'] if r['teacher'] == '外師 Rom']
print(f'ROM 課程 {len(rom_courses)} 筆（114-1 學期）')
print()

new = {}
with open('schedule_export.csv', encoding='utf-8-sig') as f:
    for r in csv.DictReader(f):
        key = (r['班級'], r['週次'], r['節次'])
        new[key] = (r['教師姓名'], r['科目'])

print(f'{"班級":<8s} {"星期/節次":<10s} {"ROM 科目":<10s} | 新版同 slot')
print('-' * 70)
for r in rom_courses:
    key = (r['className'], r['weekday'], r['period'])
    slot_str = f"{r['weekday']}{r['period']}"
    if key in new:
        t, s = new[key]
        print(f"{key[0]:<8s} {slot_str:<10s} {r['subject']:<10s} | {t} 教 {s}")
    else:
        print(f"{key[0]:<8s} {slot_str:<10s} {r['subject']:<10s} | (新版同 slot 無)")
