"""把 205 筆「內容不同」的 diff 分類：
A. 純科目名稱簡化（教師相同、科目只是縮寫）
B. 教師不同
C. 兩者都不同
"""
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

SYSTEM_CSV = Path("schedule_export.csv")
NEW_CSV = Path(r"C:\Disk D\桌面\內湖國中\教學組\排課\新竹市立內湖國民中學(114-2)完整課表.csv")


def load_sys():
    rows = []
    with SYSTEM_CSV.open(encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for r in reader:
            sub = (r.get("語言別/校訂課程名稱") or "").strip() or r["科目"].strip()
            rows.append({
                "weekday": r["週次"].strip(),
                "period": r["節次"].strip(),
                "className": r["班級"].strip(),
                "teacher": r["教師姓名"].strip(),
                "subject": sub,
            })
    return rows


def load_new():
    rows = []
    with NEW_CSV.open(encoding="big5") as f:
        reader = csv.DictReader(f)
        for r in reader:
            grade_str = r["年級"].strip()
            grade_map = {"七年級": 7, "八年級": 8, "九年級": 9}
            grade = grade_map.get(grade_str, 0)
            cls_raw = r["班級"].strip()
            m = re.match(r"^第(\d+)班$", cls_raw)
            cls = f"{grade}年{int(m.group(1))}班" if m and grade else cls_raw
            rows.append({
                "weekday": r["週次"].strip(),
                "period": r["節次"].strip(),
                "className": cls,
                "teacher": r["教師姓名"].strip(),
                "subject": r["校訂課程名稱"].strip(),
            })
    return rows


def to_dict(rows):
    d = defaultdict(list)
    for r in rows:
        key = (r["className"], r["weekday"], r["period"])
        d[key].append((r["teacher"], r["subject"]))
    return d


def main():
    sys_d = to_dict(load_sys())
    new_d = to_dict(load_new())
    both = set(sys_d.keys()) & set(new_d.keys())

    only_subject = []   # A. 教師同、科目不同
    only_teacher = []   # B. 教師不同、科目同
    both_diff = []      # C. 兩者都不同

    for k in both:
        s = sorted(sys_d[k])
        n = sorted(new_d[k])
        if s == n:
            continue
        # 兩邊 list 都只 1 筆才比較有意義（>1 筆視為複雜，跳到 both_diff）
        if len(s) == 1 and len(n) == 1:
            st, ss = s[0]
            nt, ns = n[0]
            if st == nt and ss != ns:
                only_subject.append((k, ss, ns))
            elif st != nt and ss == ns:
                only_teacher.append((k, st, nt, ss))
            else:
                both_diff.append((k, s[0], n[0]))
        else:
            both_diff.append((k, s, n))

    print(f"A. 純科目名稱簡化（教師相同）: {len(only_subject)} 筆")
    # 列出科目名稱對應表
    pair_count = defaultdict(int)
    for _, ss, ns in only_subject:
        pair_count[(ss, ns)] += 1
    print("   科目名稱對應表（出現次數）:")
    for (ss, ns), cnt in sorted(pair_count.items(), key=lambda x: -x[1]):
        print(f"   {ss:>20s}  →  {ns:<10s}  ({cnt} 筆)")
    print()

    print(f"B. 教師不同（科目相同）: {len(only_teacher)} 筆")
    for k, st, nt, ss in only_teacher:
        print(f"   {k[0]} {k[1]}{k[2]} {ss}：{st} → {nt}")
    print()

    print(f"C. 兩者都不同: {len(both_diff)} 筆")
    for k, s, n in both_diff:
        print(f"   {k[0]} {k[1]}{k[2]}")
        print(f"      系統: {s}")
        print(f"      新:   {n}")


if __name__ == "__main__":
    main()
