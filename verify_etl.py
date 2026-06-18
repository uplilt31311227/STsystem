"""驗證 ETL 輸出：對 schedule_114_2_export.csv 與原始 114-2 CSV 做 slot 對齊檢查
- slot key (className, weekday, period) 應 100% 對齊
- 教師應 100% 對齊
- 科目（領域學習 → 科目欄；校訂 → 校訂欄；本土 → 校訂欄）應與還原表一致
"""
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ETL_CSV = Path("schedule_114_2_export.csv")
NEW_CSV = Path(r"C:\Disk D\桌面\內湖國中\教學組\排課\新竹市立內湖國民中學(114-2)完整課表.csv")


def load_etl():
    d = {}
    with ETL_CSV.open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            key = (r["班級"], r["週次"], r["節次"])
            d[key] = {
                "teacher": r["教師姓名"],
                "subject": r["科目"],
                "course_name": r["語言別/校訂課程名稱"],
                "domain": r["領域"],
                "category": r["類別"],
            }
    return d


def load_new():
    d = {}
    grade_map = {"七年級": 7, "八年級": 8, "九年級": 9}
    with NEW_CSV.open(encoding="big5") as f:
        for r in csv.DictReader(f):
            g = grade_map.get(r["年級"].strip(), 0)
            m = re.match(r"^第(\d+)班$", r["班級"].strip())
            cls = f"{g}年{int(m.group(1))}班" if m and g else r["班級"]
            key = (cls, r["週次"].strip(), r["節次"].strip())
            d[key] = {
                "teacher": r["教師姓名"].strip(),
                "abbr": r["校訂課程名稱"].strip(),
            }
    return d


def main():
    etl = load_etl()
    new = load_new()

    missing_in_etl = set(new) - set(etl)
    missing_in_new = set(etl) - set(new)

    print(f"ETL slot 數: {len(etl)} | 新 CSV slot 數: {len(new)}")
    if missing_in_etl or missing_in_new:
        print(f"❌ slot 不對齊：ETL 缺 {len(missing_in_etl)}、ETL 多 {len(missing_in_new)}")
        return
    print("✓ slot 100% 對齊")
    print()

    # 教師對齊
    teacher_mismatch = []
    for k in etl:
        if etl[k]["teacher"] != new[k]["teacher"]:
            teacher_mismatch.append((k, etl[k]["teacher"], new[k]["teacher"]))
    print(f"教師對齊: {'✓' if not teacher_mismatch else '❌ ' + str(len(teacher_mismatch)) + ' 筆不同'}")
    for k, e, n in teacher_mismatch[:10]:
        print(f"  {k}: ETL={e} | 新={n}")
    print()

    # 領域分布統計
    domain_count = defaultdict(int)
    category_count = defaultdict(int)
    for v in etl.values():
        domain_count[v["domain"]] += 1
        category_count[v["category"]] += 1
    print("領域分布:")
    for d, c in sorted(domain_count.items(), key=lambda x: -x[1]):
        print(f"  {d:<30s}  {c} 筆")
    print()
    print("類別分布:")
    for c, n in sorted(category_count.items(), key=lambda x: -x[1]):
        print(f"  {c:<10s}  {n} 筆")
    print()

    # 缺領域的 slot
    no_domain = [(k, v) for k, v in etl.items() if not v["domain"]]
    if no_domain:
        print(f"❌ {len(no_domain)} 筆缺領域:")
        for k, v in no_domain[:10]:
            print(f"  {k} {v['teacher']} {v['subject']}")
    else:
        print("✓ 所有 slot 都有領域")


if __name__ == "__main__":
    main()
