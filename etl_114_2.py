"""ETL：將 114-2 完整課表（縮寫版、Big5）轉成系統 schedule_export.csv 格式（12 欄、UTF-8）

讀取：C:\\Disk D\\桌面\\內湖國中\\教學組\\排課\\新竹市立內湖國民中學(114-2)完整課表.csv
輸出：schedule_114_2_export.csv（同目錄、與系統匯入功能相容）

轉換邏輯：
1. 班級欄：年級「七年級」+ 班級「第01班」 → 7年級 + 7年1班
2. 科目縮寫還原：國文→國語文、英文→英語文、自然→生物(7)/理化(8-9)...
3. 補上身分證、類別、領域、科目、上課頻率、起始週欄位
4. 本土語文依教師對應方言（從系統舊資料抓）

執行：uv run python etl_114_2.py
"""
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

SYSTEM_CSV = Path("schedule_export.csv")
NEW_CSV = Path(r"C:\Disk D\桌面\內湖國中\教學組\排課\新竹市立內湖國民中學(114-2)完整課表.csv")
OUTPUT_CSV = Path("schedule_114_2_export.csv")

# 科目縮寫還原（年級無關）
SUBJECT_RESTORE = {
    "國文": "國語文",
    "英文": "英語文",
    "公民": "公民與社會",
    "健康": "健康教育",
    "視藝": "視覺藝術",
    "表藝": "表演藝術",
    "生科": "生活科技",
    "資科": "資訊科技",
    "地科": "地球科學",
    # 校訂課程
    "書田": "慮得書田",
    "國際": "國際視野",
    "茶花": "人文茶花",
    "園圃": "湖心園圃",
    "生數": "生活藝數",
    "論壇": "內中論壇",
}

# 校訂課程集合（→ 彈性學習 + 統整性主題/專題/議題探究 領域）
ELECTIVE_SUBJECTS = {"慮得書田", "國際視野", "人文茶花", "湖心園圃", "生活藝數", "內中論壇"}

# 主科 → (領域, 類別, 科目欄位值)
# 注意：對校訂課程，科目欄位 = 統整性主題/...、校訂欄位 = 具體名稱
# 對領域學習，科目 = 校訂 = 具體名稱
DOMAIN_MAP = {
    "國語文": "語文領域",
    "英語文": "語文領域",
    "數學": "數學領域",
    "生物": "自然科學領域",
    "理化": "自然科學領域",
    "地球科學": "自然科學領域",
    "歷史": "社會領域",
    "地理": "社會領域",
    "公民與社會": "社會領域",
    "體育": "健康與體育領域",
    "健康教育": "健康與體育領域",
    "視覺藝術": "藝術領域",
    "音樂": "藝術領域",
    "表演藝術": "藝術領域",
    "生活科技": "科技領域",
    "資訊科技": "科技領域",
    "童軍": "綜合活動領域",
    "家政": "綜合活動領域",
    "輔導": "綜合活動領域",
}


def grade_to_str(grade_zh: str) -> tuple[int, str]:
    """七年級 → (7, '7年級')"""
    m = {"七年級": 7, "八年級": 8, "九年級": 9}
    g = m.get(grade_zh.strip(), 0)
    return g, f"{g}年級" if g else grade_zh


def class_name(grade: int, cls_raw: str) -> str:
    """第01班 → 7年1班"""
    m = re.match(r"^第(\d+)班$", cls_raw.strip())
    if m and grade:
        return f"{grade}年{int(m.group(1))}班"
    return cls_raw


def build_local_lang_map():
    """從系統舊資料建立 {teacher: 客語文/四縣腔 or 閩南語文/閩南語}"""
    m = {}
    with SYSTEM_CSV.open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            course_name = (r.get("語言別/校訂課程名稱") or "").strip()
            if course_name in ("客語文/四縣腔", "閩南語文/閩南語"):
                m[r["教師姓名"].strip()] = course_name
    return m


def restore_subject(abbr: str, grade: int) -> str:
    """還原科目縮寫為完整名稱"""
    if abbr == "自然":
        return "生物" if grade == 7 else "理化"
    return SUBJECT_RESTORE.get(abbr, abbr)


def transform_row(row, local_lang_map, warnings):
    grade_int, grade_str = grade_to_str(row["年級"])
    cls = class_name(grade_int, row["班級"])
    teacher = row["教師姓名"].strip()
    weekday = row["週次"].strip()
    period = row["節次"].strip()
    abbr = row["校訂課程名稱"].strip()

    # 本土語文：依教師對應方言
    if abbr == "本土":
        dialect = local_lang_map.get(teacher)
        if not dialect:
            warnings.append(f"教師「{teacher}」在系統舊資料找不到本土語對應方言（{cls} {weekday}{period}），預設為閩南語文/閩南語")
            dialect = "閩南語文/閩南語"
        return {
            "週次": weekday,
            "節次": period,
            "年級": grade_str,
            "班級": cls,
            "教師姓名": teacher,
            "身分證字號或居留證號": "",
            "類別": "領域學習",
            "領域": "語文領域",
            "科目": "本土語文/臺灣手語",
            "語言別/校訂課程名稱": dialect,
            "上課頻率": "1",
            "起始週": "1",
        }

    # 社團：彈性學習，社團活動與技藝課程領域
    if abbr == "社團":
        return {
            "週次": weekday,
            "節次": period,
            "年級": grade_str,
            "班級": cls,
            "教師姓名": teacher,
            "身分證字號或居留證號": "",
            "類別": "彈性學習",
            "領域": "社團活動與技藝課程",
            "科目": "社團活動與技藝課程",
            "語言別/校訂課程名稱": "",
            "上課頻率": "1",
            "起始週": "1",
        }

    # 主科 / 校訂課程
    full_subject = restore_subject(abbr, grade_int)

    if full_subject in ELECTIVE_SUBJECTS:
        # 校訂課程
        return {
            "週次": weekday,
            "節次": period,
            "年級": grade_str,
            "班級": cls,
            "教師姓名": teacher,
            "身分證字號或居留證號": "",
            "類別": "彈性學習",
            "領域": "統整性主題/專題/議題探究",
            "科目": "統整性主題/專題/議題探究",
            "語言別/校訂課程名稱": full_subject,
            "上課頻率": "1",
            "起始週": "1",
        }

    # 領域學習
    domain = DOMAIN_MAP.get(full_subject)
    if not domain:
        warnings.append(f"科目「{full_subject}」找不到領域對應（{teacher} {cls} {weekday}{period}），預設為空")
        domain = ""

    return {
        "週次": weekday,
        "節次": period,
        "年級": grade_str,
        "班級": cls,
        "教師姓名": teacher,
        "身分證字號或居留證號": "",
        "類別": "領域學習",
        "領域": domain,
        "科目": full_subject,
        "語言別/校訂課程名稱": full_subject,
        "上課頻率": "1",
        "起始週": "1",
    }


def main():
    local_lang_map = build_local_lang_map()
    print(f"本土語對應表（系統舊資料）:")
    for t, d in sorted(local_lang_map.items()):
        print(f"  {t}: {d}")
    print()

    warnings: list[str] = []
    output_rows: list[dict] = []
    teacher_set = set()
    class_set = set()

    with NEW_CSV.open(encoding="big5") as f:
        for r in csv.DictReader(f):
            out = transform_row(r, local_lang_map, warnings)
            output_rows.append(out)
            teacher_set.add(out["教師姓名"])
            class_set.add(out["班級"])

    fieldnames = [
        "週次", "節次", "年級", "班級", "教師姓名",
        "身分證字號或居留證號", "類別", "領域", "科目",
        "語言別/校訂課程名稱", "上課頻率", "起始週",
    ]

    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    print(f"已輸出: {OUTPUT_CSV.resolve()}")
    print(f"總筆數: {len(output_rows)}")
    print(f"教師數: {len(teacher_set)}")
    print(f"班級數: {len(class_set)} → {sorted(class_set)}")
    print()

    if warnings:
        print(f"=== 警告 ({len(warnings)} 筆，請人工確認）===")
        for w in warnings:
            print(f"  ⚠ {w}")
    else:
        print("✓ 無警告")


if __name__ == "__main__":
    main()
