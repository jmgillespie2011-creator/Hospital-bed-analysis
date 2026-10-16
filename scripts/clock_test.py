"""Test 1: when does the clock start?

12-hour waits are counted two ways. From the decision to admit ("trolley waits", A&E monthly situation reports) and
from arrival in A&E (HES A&E before the pandemic, ECDS after; type 1 departments; NHS England Digital's
Home Nations Comparison tables). If the pre-pandemic cap on 12-hour waits was in beds, both measures should show it.
If long waits from arrival were common while long waits from the decision to admit were not, much of the cap sat in
when the decision to admit was made or recorded, not in finding a bed.

The arrival measure covers all type 1 attendances, admitted or not (HES does not split it by outcome).
Writes web/data/clock_test.json.  Usage: python scripts/clock_test.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"


def home_nations(f: Path) -> dict | None:
    x = pd.ExcelFile(f)
    sh = next((s for s in x.sheet_names if s.strip().lower() == "england"), None) or \
        next((s for s in x.sheet_names if s.lower().startswith("home nations comparison")), None)
    d = pd.read_excel(f, sheet_name=sh, header=None)
    # the HES/ECDS column: second numeric block in the England rows (the first is MSitAE)
    att = over12 = None
    for _, r in d.iterrows():
        cells = r.tolist()
        li = next((i for i, v in enumerate(cells) if isinstance(v, str) and v.strip()), None)
        if li is None:
            continue
        label = cells[li].strip().lower()
        r = pd.Series(cells[li:])
        nums = [float(v) for v in pd.to_numeric(pd.Series(r.iloc[1:].tolist()).astype(str).str.replace(",", "").str.strip(), errors="coerce") if pd.notna(v)]
        if label == "number of attendances" and len(nums) >= 2:
            att = nums[1]
        if re.search(r"over 1?2 hours|over 12", label) and "4 hour" not in label and nums:
            # rows are (count, share) pairs: MSitAE has no 12-hour-from-arrival count, so the first pair is HES/ECDS
            over12 = (nums[0], nums[1] if len(nums) > 1 and nums[1] < 1 else None)
    if att is None or over12 is None:
        return None
    return {"attendances": float(att), "over12_from_arrival": float(over12[0]), "share": float(over12[1]) if over12[1] else float(over12[0] / att)}


def main() -> int:
    rows = {}
    for f in sorted((RAW / "hes_ae_mirror").glob("*Home_Nations*.xlsx")):
        m = re.match(r"AE_?(\d\d)(\d\d)", f.name)
        if not m:
            continue
        fy = f"20{m.group(1)}/{m.group(2)}"
        r = home_nations(f)
        if r:
            rows[fy] = r
    ae = pd.read_csv(OUT / "ae_monthly_england.csv")
    g = ae.groupby("fy").agg(n=("month", "count"), adm=("emergency_admissions", "sum"), w12=("dta_over_12h", "sum"), w4=("dta_over_4h", "sum"))
    out = {"years": []}
    for fy, r in rows.items():
        if fy not in g.index or g.loc[fy, "n"] < 12:
            continue
        dta = g.loc[fy]
        y = {"fy": fy, "arrival_over12": r["over12_from_arrival"], "arrival_share": r["share"], "attendances_type1": r["attendances"],
             "dta_over12": float(dta.w12), "dta_share": float(dta.w12 / dta.adm), "ratio": r["over12_from_arrival"] / max(float(dta.w12), 1)}
        out["years"].append(y)
        print(f"{fy}: from arrival {y['arrival_over12']:,.0f} ({100 * y['arrival_share']:.1f}% of type 1 attendances); "
              f"from decision to admit {y['dta_over12']:,.0f} ({100 * y['dta_share']:.2f}% of emergency admissions); ratio {y['ratio']:.0f}")
    ys = {y["fy"]: y for y in out["years"]}
    pre = [ys[k] for k in ("2017/18", "2018/19", "2019/20") if k in ys]
    post = [ys[k] for k in ("2022/23", "2024/25") if k in ys]
    if pre and post:
        a0 = sum(y["arrival_share"] for y in pre[:2]) / len(pre[:2]); a1 = sum(y["arrival_share"] for y in post) / len(post)
        d0 = sum(y["dta_share"] for y in pre[:2]) / len(pre[:2]); d1 = sum(y["dta_share"] for y in post) / len(post)
        out["rise_from_arrival"] = a1 / a0
        out["rise_from_decision"] = d1 / d0
        print(f"rise 2017/18-2018/19 to 2022/23-2024/25: from arrival x{a1 / a0:.1f}, from decision to admit x{d1 / d0:.0f}")
    fmt = lambda v: f"{v:,.0f}"  # noqa: E731
    body = "".join(f"<tr><td>{y['fy']}</td><td class=\"num\">{fmt(y['arrival_over12'])}</td><td class=\"num\">{100 * y['arrival_share']:.1f}%</td>"
                   f"<td class=\"num\">{fmt(y['dta_over12'])}</td><td class=\"num\">{100 * y['dta_share']:.2f}%</td><td class=\"num\">{y['ratio']:.0f}</td></tr>"
                   for y in out["years"])
    out["html"] = ("<div class=\"table-scroll\"><table><thead><tr><th>Year</th><th class=\"num\">Over 12 hours from arrival</th><th class=\"num\">% of type 1 attendances</th>"
                   "<th class=\"num\">Over 12 hours from decision to admit</th><th class=\"num\">% of emergency admissions</th><th class=\"num\">Ratio</th></tr></thead>"
                   f"<tbody>{body}</tbody></table></div><p class=\"cap\">From arrival: HES A&amp;E (to 2019/20) and ECDS (2022/23 on), type 1 departments, all attendances "
                   "whether admitted or not (NHS England Digital, Hospital A&amp;E Activity, Home Nations Comparison). From decision to admit: A&amp;E monthly situation reports. "
                   + (f"Between 2017/18–2018/19 and 2022/23–2024/25, 12-hour waits rose about {out['rise_from_arrival']:.0f}-fold from arrival but about "
                      f"{out['rise_from_decision']:.0f}-fold from the decision to admit." if "rise_from_arrival" in out else "") + "</p>")
    (WEB / "clock_test.json").write_text(json.dumps(out, indent=1))
    print("wrote web/data/clock_test.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
