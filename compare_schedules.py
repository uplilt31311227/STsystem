"""比對兩份課表 CSV
- system: schedule_export.csv (UTF-8, 12 欄)
- new:    完整課表.csv          (Big5, 7 欄)
產出差異清單到 stdout
"""
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

SYSTEM_CSV = Path("schedule_export.csv")
NEW_CSV = Path(r"C:\Disk D\桌面\內湖國中\教學組\排課\新竹市立內湖國民中學(114-2)完整課表.csv")


def norm_class(s: str) -> str:
    """『第01班』『7年1班』『7年級 第01班』→ 統一為 '7年1班'。
    需要外層傳 grade。直接從 className 字串中解析。"""
    s = s.strip()
    m = re.match(r"^(\d+)年(\d+)班$", s)
    if m:
        return f"{int(m.group(1))}年{int(m.group(2))}班"
    m = re.match(r"^第(\d+)班$", s)
    if m:
        return f"?年{int(m.group(1))}班"  # caller 需補年級
    return s


def grade_to_int(g: str) -> int:
    mapping = {"七年級": 7, "八年級": 8, "九年級": 9}
    if g in mapping:
        return mapping[g]
    m = re.match(r"^(\d+)年級$", g)
    if m:
        return int(m.group(1))
    return 0


def load_system(path):
    """system: weekday,period,grade,className,teacher,id,category,domain,subject,courseName,freq,startWeek"""
    rows = []
    with path.open(encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for r in reader:
            cls = r["班級"].strip()
            sub = (r.get("語言別/校訂課程名稱") or "").strip() or r["科目"].strip()
            rows.append({
                "weekday": r["週次"].strip(),
                "period": r["節次"].strip(),
                "className": cls,
                "teacher": r["教師姓名"].strip(),
                "subject": sub,
            })
    return rows


def load_new(path):
    """new: 週次,節次,年級,班級,教師姓名,校訂課程名稱,上課頻率
    需把 grade + 第01班 → 7年1班"""
    rows = []
    with path.open(encoding="big5") as f:
        reader = csv.DictReader(f)
        for r in reader:
            grade = grade_to_int(r["年級"].strip())
            cls_raw = r["班級"].strip()
            m = re.match(r"^第(\d+)班$", cls_raw)
            if m and grade:
                cls = f"{grade}年{int(m.group(1))}班"
            else:
                cls = cls_raw
            rows.append({
                "weekday": r["週次"].strip(),
                "period": r["節次"].strip(),
                "className": cls,
                "teacher": r["教師姓名"].strip(),
                "subject": r["校訂課程名稱"].strip(),
            })
    return rows


def to_dict(rows):
    """key = (className, weekday, period) → list[(teacher, subject)]"""
    d = defaultdict(list)
    for r in rows:
        key = (r["className"], r["weekday"], r["period"])
        d[key].append((r["teacher"], r["subject"]))
    return d


def main():
    sys_rows = load_system(SYSTEM_CSV)
    new_rows = load_new(NEW_CSV)

    sys_d = to_dict(sys_rows)
    new_d = to_dict(new_rows)

    sys_keys = set(sys_d.keys())
    new_keys = set(new_d.keys())

    print(f"系統課表筆數: {len(sys_rows)} | 新課表筆數: {len(new_rows)}")
    print(f"系統 slot 數: {len(sys_keys)} | 新 slot 數: {len(new_keys)}")
    print()

    # 1) 新課表有但系統沒有
    only_new = new_keys - sys_keys
    # 2) 系統有但新課表沒有
    only_sys = sys_keys - new_keys
    # 3) 兩邊都有但內容不同
    both = sys_keys & new_keys
    diffs = []
    for k in both:
        s = sorted(sys_d[k])
        n = sorted(new_d[k])
        if s != n:
            diffs.append((k, s, n))

    # 班級集合差異
    sys_classes = {k[0] for k in sys_keys}
    new_classes = {k[0] for k in new_keys}
    print(f"班級數: 系統 {len(sys_classes)} | 新 {len(new_classes)}")
    print(f"  系統獨有班級: {sorted(sys_classes - new_classes)}")
    print(f"  新獨有班級:   {sorted(new_classes - sys_classes)}")
    print()

    print(f"=== 新課表新增的 slot ({len(only_new)} 個) ===")
    for k in sorted(only_new)[:50]:
        print(f"  + {k[0]} {k[1]}{k[2]} → {new_d[k]}")
    if len(only_new) > 50:
        print(f"  ... 共 {len(only_new)} 個，僅顯示前 50")
    print()

    print(f"=== 系統獨有的 slot (新課表沒有) ({len(only_sys)} 個) ===")
    for k in sorted(only_sys)[:50]:
        print(f"  - {k[0]} {k[1]}{k[2]} → {sys_d[k]}")
    if len(only_sys) > 50:
        print(f"  ... 共 {len(only_sys)} 個，僅顯示前 50")
    print()

    print(f"=== 內容不同的 slot ({len(diffs)} 個) ===")
    for k, s, n in sorted(diffs)[:80]:
        print(f"  ~ {k[0]} {k[1]}{k[2]}")
        print(f"      系統: {s}")
        print(f"      新:   {n}")
    if len(diffs) > 80:
        print(f"  ... 共 {len(diffs)} 個，僅顯示前 80")
    print()

    # 教師集合差異
    sys_teachers = {r["teacher"] for r in sys_rows}
    new_teachers = {r["teacher"] for r in new_rows}
    print(f"教師數: 系統 {len(sys_teachers)} | 新 {len(new_teachers)}")
    print(f"  系統獨有教師: {sorted(sys_teachers - new_teachers)}")
    print(f"  新獨有教師:   {sorted(new_teachers - sys_teachers)}")


if __name__ == "__main__":
    main()
