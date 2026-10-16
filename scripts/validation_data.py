"""Observed inputs and targets for scripts/validate_extra.mjs (all from raw files already in data/raw).

  monthly        G&A occupancy at 08:00 (monthly bed sitrep) and the share of emergency admissions waiting over 12 hours
                 from decision to admit (A&E monthly), financial years 2022/23 onwards
  flu            peak 7-day mean of G&A beds occupied by patients with flu, and its date, each winter (UEC daily sitreps)
  trustLos       each acute trust's mean length of stay relative to England (HES provider table, 2024/25)
  waits          4-hour and 12-hour waits from decision to admit, 2025/26 (A&E monthly)
Writes data/processed/validation_extra_inputs.json.  Usage: python scripts/validation_data.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT = ROOT / "data" / "raw", ROOT / "data" / "processed"


def fy_of(m: pd.Timestamp) -> str:
    y = m.year if m.month >= 4 else m.year - 1
    return f"{y}/{str(y + 1)[2:]}"


def flu_peaks() -> list[dict]:
    fs = [f for d in ("uec_sitreps_post", "corridor_care") for f in sorted((RAW / d).glob("*.xlsx"))
          if re.search(r"(?i)uec.*sit.?rep|daily.?sitrep", f.name) and re.search(r"(?i)time.?series", f.name)]
    series = []
    for f in fs:
        x = pd.ExcelFile(f)
        sh = next((s for s in x.sheet_names if s.strip().lower() == "flu"), None)
        if not sh:
            continue
        d = pd.read_excel(f, sheet_name=sh, header=None)
        h = next(i for i in range(25) if any(str(v).strip() == "Code" for v in d.iloc[i]))
        labels = d.iloc[h].map(lambda v: str(v).strip())
        dates = None
        for r in range(h - 1, max(h - 5, -1), -1):
            row = pd.to_datetime(d.iloc[r], errors="coerce")
            if row.notna().sum() > 3:
                dates = row.ffill()
                break
        eng = next(i for i in range(h + 1, h + 6) if "ENGLAND" in str(d.iloc[i, 4]).upper() or "ENGLAND" in str(d.iloc[i, 3]).upper())
        # G&A beds occupied by flu patients: the label for G&A (not critical care)
        cols = [j for j in range(5, d.shape[1]) if pd.notna(dates.iloc[j]) and re.search(r"(?i)g&a|general", labels.iloc[j])]
        if not cols:  # some files have one measure per day
            cols = [j for j in range(5, d.shape[1]) if pd.notna(dates.iloc[j]) and labels.iloc[j] not in ("nan", "")]
            seen, keep = set(), []
            for j in cols:
                if dates.iloc[j] not in seen:
                    seen.add(dates.iloc[j]); keep.append(j)
            cols = keep
        s = pd.Series({dates.iloc[j]: pd.to_numeric(d.iloc[eng, j], errors="coerce") for j in cols}).sort_index()
        series.append(s)
    out = []
    if not series:
        return out
    s = pd.concat(series)
    s = s[~s.index.duplicated(keep="last")].sort_index().dropna()
    for w, g in s.groupby([f"{(d.year if d.month >= 7 else d.year - 1)}/{str((d.year if d.month >= 7 else d.year - 1) + 1)[2:]}" for d in s.index]):
        r7 = g.rolling(7).mean()
        out.append({"winter": w, "peak7": float(r7.max()), "peakDate": r7.idxmax().strftime("%Y-%m-%d"), "days": int(len(g))})
    return out


def trust_los() -> list[dict]:
    f = next((RAW / "hes_apc_mirror").glob("*hosp-prov-2024-25*.xlsx"), None)
    if f is None:
        return []
    d = pd.read_excel(f, sheet_name=0, header=None)
    h = next(i for i in range(30) if d.iloc[i].astype(str).str.contains("Mean length of stay").any())
    hd = d.iloc[h].map(lambda v: re.sub(r"\s+", " ", str(v)).strip().lower())
    c_los = next(j for j, v in enumerate(hd) if v.startswith("mean length of stay"))
    c_em = next(j for j, v in enumerate(hd) if v.startswith("emergency"))
    c_fae = next(j for j, v in enumerate(hd) if v.startswith("admissions") or v.startswith("finished admission"))
    tot = next(i for i in range(h + 1, h + 5) if str(d.iloc[i, 0]).strip().lower() == "total")
    nat = float(d.iloc[tot, c_los])
    body = d.iloc[h + 1:]
    body = body[body.iloc[:, 0].astype(str).str.match(r"^R[A-Z0-9]{2}$")]
    return [{"org": str(r.iloc[0]).strip(), "mean_los": float(r.iloc[c_los]), "los_rel": float(r.iloc[c_los]) / nat,
             "emergency": float(r.iloc[c_em]), "admissions": float(r.iloc[c_fae])} for _, r in body.iterrows()
            if pd.notna(pd.to_numeric(r.iloc[c_los], errors="coerce"))]


def main() -> int:
    sr = pd.read_csv(OUT / "sitrep_monthly_england.csv", parse_dates=["month"])
    ae = pd.read_csv(OUT / "ae_monthly_england.csv", parse_dates=["month"])
    m = sr[["month", "ga_occupancy_8am"]].merge(ae[["month", "emergency_admissions", "dta_over_4h", "dta_over_12h"]], on="month")
    m["fy"] = m.month.map(fy_of)
    m = m[m.fy >= "2022/23"]
    full = m.groupby("fy").month.count()
    m = m[m.fy.isin(full[full == 12].index)]
    monthly = [{"month": r.month.strftime("%Y-%m"), "fy": r.fy, "occ8": float(r.ga_occupancy_8am),
                "wait12": float(r.dta_over_12h / r.emergency_admissions), "wait4": float(r.dta_over_4h / r.emergency_admissions)} for r in m.itertuples()]
    w = ae.assign(fy=ae.month.map(fy_of)).groupby("fy").agg(n=("month", "count"), adm=("emergency_admissions", "sum"),
                                                           w4=("dta_over_4h", "sum"), w12=("dta_over_12h", "sum"))
    waits = {fy: {"wait4": float(r.w4 / r.adm), "wait12": float(r.w12 / r.adm), "reach12": float(r.w12 / r.w4)} for fy, r in w[w.n == 12].iterrows()}
    out = {"monthly": monthly, "flu": flu_peaks(), "trustLos": trust_los(), "waits": waits}
    print("monthly", len(monthly), "flu", out["flu"], "trusts with HES LOS", len(out["trustLos"]))
    (OUT / "validation_extra_inputs.json").write_text(json.dumps(out, indent=1))
    print("wrote data/processed/validation_extra_inputs.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
