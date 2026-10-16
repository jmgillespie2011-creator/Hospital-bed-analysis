"""Long-run trends for the blog: how hospital use changed, year by year.

  beds and occupied beds per 1,000 people    KH03 (consistent G&A definition) and ONS population, from web/data/blog_observed.json
  emergency admissions per 1,000 people      A&E monthly situation reports (all emergency admissions), full financial years
  length of stay per admission               HES primary diagnosis 3-character tables, general and acute scope (scripts/hes_admissions.py):
                                             emergency bed days per emergency admission, per overnight emergency admission and
                                             bed days per overnight admission; share of emergency admissions aged 75+; same-day share
  (per episode, kept for reference)          HES summary table TOTAL row: mean length of stay per finished consultant episode
                                             with at least one night (ep_mean_los)
  admissions by type                         HES finished admission episodes: emergency and waiting-list/planned
  long stays                                 winter daily sitreps (2017/18-2019/20) and UEC daily sitreps (2022/23 onwards):
                                             England, share of occupied G&A beds held by patients in hospital over 7 and over
                                             21 days, mean of 1 December to end of February
  patients fit to leave                      acute discharge sitrep (no criteria to reside), daily, from April 2021
  delayed transfers of care                  the older, narrower measure (acute, month-end snapshot), August 2010 to March 2017

Writes web/data/blog_trends.json.  Usage: python scripts/blog_trends.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from hes_admissions import hes_admissions  # noqa: E402

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"


def fy_of(month: pd.Timestamp) -> str:
    y = month.year if month.month >= 4 else month.year - 1
    return f"{y}/{str(y + 1)[2:]}"


def hes_los() -> pd.DataFrame:
    rows = []
    for d in (RAW / "hes_apc_diag_old_mirror", RAW / "hes_apc_diag_mirror", RAW / "hes_apc_mirror", RAW / "hes_files"):
        if not d.exists():
            continue
        for f in sorted(d.glob("*.xls*")):
            m = re.search(r"(20\d\d)[-_](\d\d)", f.name)
            m2 = re.search(r"-(\d\d)-(\d\d)-tab", f.name)
            if not (m or m2) or not re.search(r"(?i)diag", f.name) or re.search(r"(?i)[34]cha", f.name):
                continue
            fy = f"{m.group(1)}/{m.group(2)}" if m else f"20{m2.group(1)}/{m2.group(2)}"
            try:
                x = pd.ExcelFile(f)
            except Exception:  # noqa: BLE001
                continue
            sh = next((s for s in x.sheet_names if re.search(r"(?i)primary diagnosis summary|summary$|^primary diagnosis$", s)), None) or \
                next((s for s in x.sheet_names if re.search(r"(?i)primary diag", s)), None)
            if sh is None:
                continue
            t = pd.read_excel(f, sheet_name=sh, header=None)
            hi = next((i for i in range(min(40, len(t))) if t.iloc[i].astype(str).str.contains(r"(?i)mean length of stay").any()), None)
            if hi is None:
                continue
            hd = t.iloc[hi].map(lambda v: re.sub(r"\s+", " ", str(v)).strip().lower())
            tot = next((i for i in range(hi + 1, min(hi + 6, len(t))) if str(t.iloc[i, 0]).strip().upper() in ("TOTAL", "ALL") or
                        str(t.iloc[i, 1]).strip().upper() in ("TOTAL", "ALL")), None)
            if tot is None:
                continue
            col = lambda pat: next((j for j, v in enumerate(hd) if re.search(pat, v)), None)  # noqa: E731
            val = lambda pat: pd.to_numeric(t.iloc[tot, col(pat)], errors="coerce") if col(pat) is not None else np.nan  # noqa: E731
            rows.append({"fy": fy, "file": f.name, "fce": val(r"^finished consultant"), "fae": val(r"^finished admission|^admissions"),
                         "emergency": val(r"^emergency"), "waiting_list": val(r"^waiting list"), "planned": val(r"^planned"),
                         "mean_los": val(r"^mean length of stay"), "median_los": val(r"^median length of stay"), "mean_age": val(r"^mean age")})
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows).sort_values("fy").drop_duplicates("fy", keep="last")


def long_stays() -> pd.DataFrame:
    fs = [f for d in ("winter_sitreps_pre", "uec_sitreps_post", "corridor_care") for f in sorted((RAW / d).glob("*.xlsx"))
          if re.search(r"(?i)time.?series", f.name) and not re.search(r"(?i)111|ambulance|covid|discharge|absence", f.name)]
    out = []
    for f in fs:
        x = pd.ExcelFile(f)
        ls = next((s for s in x.sheet_names if "long stay" in s.lower()), None)
        ga = next((s for s in x.sheet_names if re.search(r"(?i)^(total )?g&a beds$", s)), None)
        if not ls or not ga:
            continue

        def england(sheet):
            d = pd.read_excel(f, sheet_name=sheet, header=None)
            h = next(i for i in range(25) if any(str(v).strip() == "Code" for v in d.iloc[i]))
            labels = d.iloc[h].map(lambda v: str(v).strip())
            dates = None
            for r in range(h - 1, max(h - 5, -1), -1):
                row = pd.to_datetime(d.iloc[r], errors="coerce")
                if row.notna().sum() > 3:
                    dates = row.ffill()
                    break
            eng = next(i for i in range(h + 1, h + 6) if str(d.iloc[i, 4]).strip().upper().startswith("ENGLAND") or
                       str(d.iloc[i, 3]).strip().upper().startswith("ENGLAND"))
            rec = []
            for j in range(5, d.shape[1]):
                if pd.isna(dates.iloc[j]) or labels.iloc[j] in ("nan", ""):
                    continue
                rec.append((dates.iloc[j], labels.iloc[j], pd.to_numeric(d.iloc[eng, j], errors="coerce")))
            return pd.DataFrame(rec, columns=["date", "label", "value"])

        a = england(ls)
        b = england(ga)
        occ = b[b.label.map(lambda v: bool(re.search(r"(?i)occ'?d", v)))].groupby("date").value.first()
        w = a.pivot_table(index="date", columns="label", values="value", aggfunc="first")
        g = pd.DataFrame({"occupied": occ}).join(w, how="inner")
        out.append(g)
    g = pd.concat(out)
    g = g[~g.index.duplicated(keep="last")].sort_index()
    g = g[g.index.month.isin([12, 1, 2])]
    g["winter"] = [f"{d.year if d.month >= 7 else d.year - 1}/{str((d.year if d.month >= 7 else d.year - 1) + 1)[2:]}" for d in g.index]
    c7 = next(c for c in g.columns if re.search(r">\s?7", str(c)))
    c21 = next(c for c in g.columns if re.search(r">\s?21", str(c)))
    r = g.groupby("winter").agg(occupied=("occupied", "mean"), over7=(c7, "mean"), over21=(c21, "mean"), days=("occupied", "size")).reset_index()
    r["share7"] = r.over7 / r.occupied
    r["share21"] = r.over21 / r.occupied
    return r


def long_stays_year_round() -> list[dict]:
    """Year-round shares of occupied G&A beds held by patients in hospital 7, 14 and 21+ days (monthly bed sitrep CSVs),
    full financial years only."""
    rows = []
    for f in sorted((RAW / "ga_sitreps").glob("20*.csv")):
        m = re.match(r"(20\d\d)(\d\d)-", f.name)
        if not m:
            continue
        d = pd.read_csv(f)
        if "Level" not in d.columns or "Metric" not in d.columns:
            continue
        p = d[(d.Level == "Provider") & (d.Type != "Other")] if "Type" in d.columns else d[d.Level == "Provider"]
        g = p.pivot_table(index="Org Code", columns="Metric", values="Value", aggfunc="first").apply(pd.to_numeric, errors="coerce")
        k = lambda n: f"Number of G&A beds occupied by patients with a length of stay of - {n} or more days"  # noqa: E731
        if k(7) not in g:
            continue
        month = pd.Timestamp(int(m.group(1)), int(m.group(2)), 1)
        rows.append({"month": month, "occ": g["G&A beds occupied"].sum(), **{f"n{n}": g[k(n)].sum() for n in (7, 14, 21)}})
    if not rows:
        return []
    t = pd.DataFrame(rows).drop_duplicates("month")
    t["fy"] = t.month.map(fy_of)
    out = []
    for fy, g in t.groupby("fy"):
        if len(g) == 12:
            out.append({"fy": fy, **{f"share{n}": float(g[f"n{n}"].sum() / g.occ.sum()) for n in (7, 14, 21)}})
    return out


def dtoc_old() -> pd.DataFrame:
    f = RAW / "dtoc" / "Patient-Snapshot-Timeseries-to-March-2017-Revised.xls"
    if not f.exists():
        return pd.DataFrame()
    d = pd.read_excel(f, sheet_name="Patient Snapshot by type", header=None)
    h, c0 = next((i, j) for i in range(30) for j in range(3) if str(d.iloc[i, j]).strip() == "Year")
    body = d.iloc[h + 1:, c0:c0 + 5]
    body.columns = range(5)
    body = body.dropna(subset=[0])
    body.columns = ["fy", "month", "acute", "non_acute", "total"]
    body = body[body.fy.astype(str).str.match(r"^\d{4}-\d\d$")]
    body["acute"] = pd.to_numeric(body.acute, errors="coerce")
    g = body.groupby("fy").agg(acute=("acute", "mean"), months=("acute", "size")).reset_index()
    g["fy"] = g.fy.str.replace("-", "/")
    return g


def main() -> int:
    beds = json.loads((WEB / "blog_observed.json").read_text())["beds"]
    b = pd.DataFrame(beds)
    b = b[b.fy >= "2008/09"].copy()
    b["occupied_per1000"] = b.occupancy * b.perThousand
    ae = pd.read_csv(OUT / "ae_monthly_england.csv")
    g = ae.groupby("fy").agg(n=("month", "count"), adm=("emergency_admissions", "sum"))
    g = g[g.n == 12]
    t = b.merge(g.reset_index(), on="fy", how="left")
    t["emergency_per1000"] = 1000 * t.adm / t.population
    t["emergency_per1000_75"] = np.nan
    hes = hes_los()
    if not hes.empty:
        t = t.merge(hes[["fy", "fae", "emergency", "waiting_list", "planned", "mean_los"]].rename(columns={"mean_los": "ep_mean_los"}), on="fy", how="outer")
    adm = hes_admissions()
    # Health Foundation definitions: nights per overnight emergency admission, measured on emergency-dominated diagnoses
    # (from 2013/14, when same-day stays were first published). For earlier years the series is linked back using nights
    # per admission (same-day stays included) on the same diagnoses, scaled to match in 2013/14.
    first = adm.dropna(subset=["hf_em_los"]).iloc[0]
    adm["hf_em_los_linked"] = adm.hf_em_los.fillna(adm.hf_em_bd_per_adm * first.hf_em_los / first.hf_em_bd_per_adm)
    t = t.merge(adm[["fy", "em_bd_per_adm", "em_bd_per_overnight", "bd_per_overnight", "share75_emergency", "em_same_day_share",
                     "hf_em_los", "hf_el_los", "hf_em_los_linked", "hf_em_bd_per_adm",
                     "bed_days", "emergency_bed_days"]].rename(columns={"bed_days": "ga_bed_days"}), on="fy", how="left")
    t = t.sort_values("fy")
    if "emergency" in t:
        t["hes_emergency_per1000"] = 1000 * t.emergency / t.population
        t["hes_planned_per1000"] = 1000 * (t.waiting_list + t.planned) / t.population
        t["em_bed_days_per1000"] = 1000 * t.emergency_bed_days / t.population
    ls = long_stays()
    nctr = pd.read_csv(OUT / "nctr_daily_england.csv", parse_dates=["date"])
    nfy = nctr.groupby("fy").agg(nctr=("nctr_remaining", "mean"), days=("nctr", "size")).reset_index()  # still in hospital at the end of the day
    nfy = nfy[nfy.days >= 300]
    dt = dtoc_old()
    out = {
        "years": t.replace({np.nan: None}).to_dict(orient="records"),
        "longStays": ls.replace({np.nan: None}).to_dict(orient="records"),
        "nctr": nfy.to_dict(orient="records"),
        "longStaysYearRound": long_stays_year_round(),
        "dtocAcute": dt[dt.months == 12].to_dict(orient="records") if not dt.empty else [],
        "sources": {"hes_years": hes.fy.tolist() if not hes.empty else []},
        # published figures from the Health Foundation's briefing (calendar years 2019 and 2022, adults, record-level HES)
        "healthFoundation": [{"year": "2019", "fy": "2019/20", "emergency": 7.9, "elective": 5.2, "all": 7.3, "emergencyAdmissions": 5538000, "bedDays": 36233000},
                             {"year": "2022", "fy": "2022/23", "emergency": 9.1, "elective": 5.1, "all": 8.3, "emergencyAdmissions": 5017000, "bedDays": 35343000}],
    }
    for r in out["years"]:
        if r.get("fy") in ("2010/11", "2015/16", "2019/20", "2022/23", "2025/26"):
            print({k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items() if k in ("fy", "perThousand", "occupied_per1000", "occupancy", "emergency_per1000", "em_bd_per_adm", "em_bd_per_overnight", "bd_per_overnight", "share75_emergency")})
    print("HES years:", out["sources"]["hes_years"])
    print(ls[["winter", "share7", "share21", "days"]].round(3).to_string(index=False))
    print(nfy.round(0).to_string(index=False))
    print(dt.round(0).to_string(index=False))
    (WEB / "blog_trends.json").write_text(json.dumps(out, indent=1, default=float))
    print("wrote web/data/blog_trends.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
