"""Observed series for the blog page (web/blog.html), built from data/processed.

Writes web/data/blog_observed.json. Every number shown on the blog's "observed" charts comes from here.
"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
P = ROOT / "data" / "processed"
OUT = ROOT / "web" / "data" / "blog_observed.json"


def fy_start(fy: str) -> int:
    return int(fy[:4])


def ae_arrival_4h() -> pd.DataFrame:
    f = next((ROOT / "data" / "raw" / "ae_attendances").glob("Monthly-AE-Time-Series-*.xls"))
    d = pd.read_excel(f, sheet_name="Performance", header=None)
    hdr = d.index[d[1].astype(str).str.strip().eq("Period")][0]
    rows = d.iloc[hdr + 1:]
    rows = rows[pd.to_datetime(rows[1], errors="coerce").notna()]
    # columns: 2 = type 1 within 4 hours, 6 = type 1 over 4 hours
    a = pd.DataFrame({"month": pd.to_datetime(rows[1]), "type1_under4": pd.to_numeric(rows[2]), "type1_over4": pd.to_numeric(rows[6])})
    a["type1_att"] = a.type1_under4 + a.type1_over4
    a["fy"] = a.month.map(lambda t: f"{t.year}/{str(t.year + 1)[2:]}" if t.month >= 4 else f"{t.year - 1}/{str(t.year)[2:]}")
    return a


def main() -> None:
    out: dict = {}

    # 1. Beds since 1987/88 (consistent definition) and per 1,000 people (mid-year population of the year the FY starts)
    kh = pd.read_csv(P / "kh03_annual_england.csv")
    pop = pd.read_csv(P / "ons_england_population_single_age.csv")
    tot = pop.groupby("year").population.sum()
    old = pop[pop.age >= 75].groupby("year").population.sum()
    rows = []
    for _, r in kh.iterrows():
        y = fy_start(r.year)
        if y not in tot.index:
            continue
        rows.append(dict(fy=r.year, beds=round(r.ga_available), occupancy=None if pd.isna(r.ga_occupancy) else round(r.ga_occupancy, 4),
                         population=int(tot[y]), pop75=int(old[y]),
                         perThousand=round(1000 * r.ga_available / tot[y], 3),
                         per75=round(1000 * r.ga_available / old[y], 1),
                         bridged=not str(r.definition).startswith("KH03 2010")))
    out["beds"] = rows

    # 2. Quarterly occupancy against the share of emergency admissions waiting >12h from decision to admit
    q = pd.read_csv(P / "kh03_quarterly_england.csv")
    ae = pd.read_csv(P / "ae_monthly_england.csv", parse_dates=["month"])
    qmap = {4: "Q1", 5: "Q1", 6: "Q1", 7: "Q2", 8: "Q2", 9: "Q2", 10: "Q3", 11: "Q3", 12: "Q3", 1: "Q4", 2: "Q4", 3: "Q4"}
    ae["quarter"] = ae.month.dt.month.map(qmap)
    aq = ae.groupby(["fy", "quarter"]).agg(adm=("emergency_admissions", "sum"), w12=("dta_over_12h", "sum"),
                                           w4=("dta_over_4h", "sum"), n=("month", "count")).reset_index()
    m = q.merge(aq, left_on=["year", "quarter"], right_on=["fy", "quarter"])
    m = m[m.n == 3]
    # type 1 A&E attendances spending over 4 hours in A&E, counted from arrival (A&E time series, Performance sheet).
    # Unlike the decision-to-admit measures, this does not depend on when the decision to admit was recorded.
    arr = ae_arrival_4h()
    arr["quarter"] = arr.month.dt.month.map(qmap)
    arq = arr.groupby(["fy", "quarter"]).agg(att=("type1_att", "sum"), over4=("type1_over4", "sum"), n4=("month", "count")).reset_index()
    m = m.merge(arq, on=["fy", "quarter"], how="left")
    out["quarters"] = [dict(fy=r.year, q=r.quarter, occupancy=round(r.ga_occupancy, 4), wait12=round(r.w12 / r.adm, 5),
                            wait4=round(r.w4 / r.adm, 4),
                            arrival4=None if pd.isna(r.att) or r.n4 != 3 else round(r.over4 / r.att, 4)) for _, r in m.iterrows()]

    # 3. Monthly waits over 12 hours from decision to admit
    out["monthly"] = [dict(month=r.month.strftime("%Y-%m"), w12=int(r.dta_over_12h), adm=int(r.emergency_admissions),
                           share=round(r.dta_over_12h / r.emergency_admissions, 5))
                      for _, r in ae.dropna(subset=["dta_over_12h", "emergency_admissions"]).iterrows()]

    # 4. Two flu seasons, daily G&A beds occupied by flu patients
    w = pd.read_csv(P / "winter_daily_england.csv", parse_dates=["date"])
    out["flu"] = {s: [dict(date=r.date.strftime("%Y-%m-%d"), beds=int(r.flu_ga_beds), occupancy=round(r.occupancy, 4))
                      for _, r in g.iterrows() if pd.notna(r.flu_ga_beds)] for s, g in w.groupby("winter")}

    # 5. Trusts: occupancy and long waits, 2025/26
    t = pd.read_csv(P / "trust_panel_2025_26.csv")
    out["trusts"] = [dict(name=r.org_name.title().replace("Nhs", "NHS"), beds=round(r.ga_available), occupancy=round(r.occupancy_8am, 4),
                          wait12=round(r.wait12_share, 5), admissions=int(r.emergency_admissions))
                     for _, r in t.dropna(subset=["occupancy_8am", "wait12_share"]).iterrows()]

    # 6. Patients no longer meeting the criteria to reside, daily
    n = pd.read_csv(P / "nctr_daily_england.csv", parse_dates=["date"])
    n = n.set_index("date").nctr.rolling(7).mean().dropna()
    out["nctr"] = [dict(date=d.strftime("%Y-%m-%d"), nctr=round(v)) for d, v in n.iloc[::7].items()]

    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print("wrote", OUT, {k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
