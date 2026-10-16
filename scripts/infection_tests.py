"""Test 3: did infection control cut bed flexibility?

COVID-19 isolation and cohorting rules closed beds in bays around infected patients ("covid void beds") and split
wards into COVID and non-COVID areas. If that is why hospitals now behave as if their beds are in smaller pools:
  (a) within a trust, months with more COVID inpatients or more void beds should have more 12-hour waits than the
      month's occupancy predicts;
  (b) the national rise in long waits should fade as COVID inpatients and void beds fell.

Data: monthly G&A bed sitrep by trust (beds available, occupied, covid void beds from October 2022), COVID-19 hospital
activity (patients in beds with COVID-19, daily by trust), A&E monthly by provider (12-hour waits from decision to
admit and emergency admissions). Poisson with trust and month fixed effects, admissions as exposure, errors clustered
by trust (pyfixest).
Writes web/data/infection_tests.json.  Usage: python scripts/infection_tests.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from longstay_tests import ae_months  # noqa: E402

RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"
CODE = r"^[A-Z0-9]{3,5}$"
MONTHS = {m[:3]: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                               "september", "october", "november", "december"])}


def sitrep_months() -> pd.DataFrame:
    rows = []
    for f in sorted((RAW / "ga_sitreps").glob("20*")):
        m = re.match(r"(20\d\d)(\d\d)-([A-Za-z]+)", f.name)
        if not m:
            continue
        # the month in the name after the yyyymm prefix is the reliable one (one file is misnumbered)
        mon = MONTHS.get(m.group(3)[:3].lower())
        yr = int(m.group(1))
        if mon is None:
            continue
        month = pd.Timestamp(yr, mon, 1)
        if f.suffix == ".csv":
            d = pd.read_csv(f)
            if "Metric" not in d.columns:
                continue
            d = d[(d.Level == "Provider") & (d.Type != "Other")] if "Type" in d.columns else d[d.Level == "Provider"]
            p = d.pivot_table(index="Org Code", columns="Metric", values="Value", aggfunc="first")
            rows.append(pd.DataFrame({"month": month, "org": p.index.astype(str).str.strip(), "src": "csv",
                                      "avail": pd.to_numeric(p.get("G&A beds available"), errors="coerce").values,
                                      "occ": pd.to_numeric(p.get("G&A beds occupied"), errors="coerce").values,
                                      "void": pd.to_numeric(p.get("G&A covid void beds"), errors="coerce").values if "G&A covid void beds" in p else np.nan}))
            continue
        x = pd.ExcelFile(f)
        sh = next((s for s in x.sheet_names if "all" in str(s).lower() and "previous" not in str(s).lower()), None)
        if sh is None:
            continue
        d = pd.read_excel(f, sheet_name=sh, header=None)
        h = next(i for i in range(25) if d.iloc[i].astype(str).str.contains("G&A beds available").any())
        hd = d.iloc[h].map(lambda v: str(v).strip())
        col = lambda pat: next((i for i, v in enumerate(hd) if v == pat), None)  # noqa: E731
        body = d.iloc[h + 1:]
        cc = next(c for c in range(8) if body[c].astype(str).str.match(CODE).sum() > 50)
        body = body[body[cc].astype(str).str.match(CODE)]
        num = lambda c: pd.to_numeric(body[c], errors="coerce").values if c is not None else np.nan  # noqa: E731
        rows.append(pd.DataFrame({"month": month, "org": body[cc].astype(str).str.strip().values, "src": "xlsx",
                                  "avail": num(col("G&A beds available")), "occ": num(col("G&A beds occupied")),
                                  "void": num(col("G&A covid void beds"))}))
    s = pd.concat(rows)
    # prefer the Excel file where both exist (CSV and Excel carry the same numbers)
    return s.sort_values("src", ascending=False).drop_duplicates(["month", "org"]).drop(columns="src")


def covid_beds() -> pd.DataFrame:
    rows = []
    for f in sorted((RAW / "covid_activity").glob("*.xlsx")):
        x = pd.ExcelFile(f)
        sh = next((s for s in x.sheet_names if s.strip().lower() in ("ga beds occupied covid",)), None) or \
            next((s for s in x.sheet_names if s.strip().lower() == "total beds occupied covid"), None)
        if sh is None:
            continue
        d = pd.read_excel(f, sheet_name=sh, header=None)
        h = next((i for i in range(30) if any(str(v).strip() == "Code" for v in d.iloc[i])), None)
        if h is None:
            continue
        cc = int(next(i for i, v in enumerate(d.iloc[h]) if str(v).strip() == "Code"))
        dates = pd.to_datetime(d.iloc[h], errors="coerce")
        body = d.iloc[h + 1:]
        body = body[body.iloc[:, cc].astype(str).str.match(CODE)]
        cols = [j for j in range(d.shape[1]) if pd.notna(dates.iloc[j])]
        long = body.iloc[:, [cc] + cols].melt(id_vars=body.columns[cc], var_name="j", value_name="covid")
        long["date"] = long.j.map(lambda j: dates.iloc[j])
        long = long.rename(columns={body.columns[cc]: "org"})
        long["covid"] = pd.to_numeric(long.covid, errors="coerce")
        long["sheet"] = sh
        rows.append(long[["org", "date", "covid", "sheet"]])
    c = pd.concat(rows).dropna(subset=["covid"])
    # G&A-only counts where published, otherwise all beds (critical care COVID patients are a small share)
    c = c.sort_values("sheet").drop_duplicates(["org", "date"], keep="first")
    c["month"] = c.date.dt.to_period("M").dt.to_timestamp()
    return c.groupby(["org", "month"]).covid.mean().reset_index()


def fit(formula: str, data: pd.DataFrame, exposure: str = "emergency_admissions"):
    import pyfixest as pf
    data = data.copy()
    data["_off"] = np.log(data[exposure])
    return pf.fepois(formula, data=data, vcov={"CRV1": "org"}, offset="_off")


def eff(m, k: str, scale: float = 1.0) -> dict:
    b, se, p = m.coef()[k] * scale, m.se()[k] * scale, float(m.pvalue()[k])
    return {"pct": 100 * (np.exp(b) - 1), "lo": 100 * (np.exp(b - 1.96 * se) - 1), "hi": 100 * (np.exp(b + 1.96 * se) - 1), "p": p}


def main() -> int:
    s, c, a = sitrep_months(), covid_beds(), ae_months()
    p = s.merge(a, on=["month", "org"]).merge(c, on=["org", "month"], how="left")
    p = p[(p.avail > 150) & (p.emergency_admissions > 500)].copy()
    p["occ_pts"] = 100 * p.occ / p.avail
    p = p[p.occ_pts.between(60, 105)]
    p["covid_pts"] = 100 * p.covid / p.avail
    p["void_pts"] = 100 * p.void / p.avail
    p["month_s"] = p.month.dt.strftime("%Y-%m")
    p.to_csv(OUT / "infection_panel.csv", index=False)
    out = {"n_trust_months": int(len(p)), "n_trusts": int(p.org.nunique()),
           "months": [p.month.min().strftime("%Y-%m"), p.month.max().strftime("%Y-%m")]}
    # national monthly series for the chart
    g = p.groupby("month").agg(adm=("emergency_admissions", "sum"), w12=("waits12", "sum"), avail=("avail", "sum"),
                               occ=("occ", "sum"), covid=("covid", "sum"), void=("void", "sum"))
    nat = pd.DataFrame({"month": g.index.strftime("%Y-%m"), "wait12": g.w12 / g.adm, "occupancy": g.occ / g.avail,
                        "covid_share": g.covid / g.avail, "void_share": g.void.where(g.void > 0) / g.avail})
    out["national"] = nat.replace({np.nan: None}).to_dict(orient="records")
    # (a) within-trust: COVID inpatients and void beds, holding occupancy
    q = p.dropna(subset=["covid_pts"])
    m1 = fit("waits12 ~ occ_pts + covid_pts | org + month_s", q)
    out["covid"] = {"n": int(m1._N), "occ_pts": eff(m1, "occ_pts"), "covid_pts": eff(m1, "covid_pts")}
    q2 = p.dropna(subset=["void_pts", "covid_pts"])
    m2 = fit("waits12 ~ occ_pts + covid_pts + void_pts | org + month_s", q2)
    out["void"] = {"n": int(m2._N), "occ_pts": eff(m2, "occ_pts"), "covid_pts": eff(m2, "covid_pts"), "void_pts": eff(m2, "void_pts")}
    for k in ("covid", "void"):
        print(k, {t: f"{v['pct']:+.1f}% ({v['lo']:+.1f} to {v['hi']:+.1f}) p={v['p']:.3f}" for t, v in out[k].items() if t != "n"}, "n", out[k]["n"])
    # (b) how much of each year's waits would go if COVID inpatients and void beds were zero, using the estimates
    b_c, b_v = m2.coef()["covid_pts"], m2.coef()["void_pts"]
    q2 = q2.assign(fy=q2.month.map(lambda d: f"{d.year if d.month >= 4 else d.year - 1}/{str((d.year if d.month >= 4 else d.year - 1) + 1)[2:]}"))
    share = []
    for fy, g in q2.groupby("fy"):
        w = g.waits12.sum()
        w0 = (g.waits12 * np.exp(-(b_c * g.covid_pts + b_v * g.void_pts.fillna(0)))).sum()
        share.append({"fy": fy, "wait12": float(w / g.emergency_admissions.sum()), "covid_share": float(g.covid.sum() / g.avail.sum()),
                      "void_share": float(g.void.sum() / g.avail.sum()), "explained": float(1 - w0 / w)})
        print(f"{fy}: >12h {100 * w / g.emergency_admissions.sum():.1f}%, COVID {100 * g.covid.sum() / g.avail.sum():.1f}% of beds, "
              f"void {100 * g.void.sum() / g.avail.sum():.2f}%, share of long waits explained {100 * (1 - w0 / w):.1f}%")
    out["by_year"] = share
    (WEB / "infection_tests.json").write_text(json.dumps(out, indent=1, default=float))
    print("wrote web/data/infection_tests.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
