"""Process the raw NHS England / ONS files into tidy CSVs in data/processed/.

Every number the model and website use is derived here (or in
scripts/effects_analysis.py) from files in data/raw/, which are listed with
their source URLs and checksums in data/raw/manifest.csv.

Usage: python3 scripts/build_inputs.py
"""

from __future__ import annotations

import datetime as _dt
import re
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"
OUT.mkdir(parents=True, exist_ok=True)


def fy_of(date: pd.Timestamp) -> str:
    """Financial year label (April-March) for a date, e.g. 2024-05-01 -> '2024/25'."""
    y = date.year if date.month >= 4 else date.year - 1
    return f"{y}/{str(y + 1)[-2:]}"


# ------------------------------------------------------------------ KH03 beds
def kh03() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Quarterly G&A beds open overnight, England (2010/11 onwards, current definition),
    and annual G&A beds 1987/88-2009/10 (old ward-based definition)."""
    f = RAW / "kh03_main" / "Beds-Timeseries-2010-11-onwards-Q1-2026-27.xlsx"
    d = pd.read_excel(f, sheet_name="Open Overnight", header=None)
    hdr = d.index[d[1].astype(str).str.strip().eq("Year")][0]
    rows = d.iloc[hdr + 1:]
    rows = rows[rows[3].astype(str).str.strip().eq("England")]
    q = pd.DataFrame({
        "year": rows[1].ffill().astype(str).str.strip(),
        "quarter": rows[2].astype(str).str.strip(),
        "ga_available": pd.to_numeric(rows[5]),
        "ga_occupied": pd.to_numeric(rows[11]),
        "all_available": pd.to_numeric(rows[4]),
    })
    q["year"] = q["year"].where(q["year"].str.match(r"\d{4}/\d\d"))
    q["year"] = q["year"].ffill()
    q["ga_occupancy"] = q.ga_occupied / q.ga_available
    q.to_csv(OUT / "kh03_quarterly_england.csv", index=False)

    f = RAW / "kh03_main" / "Beds-Time-Series-_-1987-88-to-2009-10-XLS-34K.xls"
    h = pd.read_excel(f, header=None)
    h = h[h[0].astype(str).str.match(r"\d{4}-\d\d")]
    hist = pd.DataFrame({
        "year": h[0].str.replace("-", "/"),
        "ga_available_olddef": pd.to_numeric(h[2]),
        "acute_olddef": pd.to_numeric(h[3]),
        "geriatric_olddef": pd.to_numeric(h[4]),
    })
    hist.to_csv(OUT / "kh03_annual_1987_2010_olddef.csv", index=False)
    return q, hist


def kh03_annual(q: pd.DataFrame, hist: pd.DataFrame) -> pd.DataFrame:
    """Annual G&A beds on one consistent (2010/11+) definition.

    The bridge between definitions is measured, not assumed: the ratio of the first
    new-definition year (2010/11, mean of four quarters) to the last old-definition
    year (2009/10). It therefore also contains one year's genuine change, which is
    noted on the Data page."""
    full = q.groupby("year").filter(lambda g: len(g) == 4)
    ann = full.groupby("year").agg(ga_available=("ga_available", "mean"), ga_occupied=("ga_occupied", "mean")).reset_index()
    ann["ga_occupancy"] = ann.ga_occupied / ann.ga_available
    ann["definition"] = "KH03 2010/11+ (consultant specialty, quarterly)"
    bridge = ann.loc[ann.year == "2010/11", "ga_available"].iloc[0] / hist.loc[hist.year == "2009/10", "ga_available_olddef"].iloc[0]
    old = hist.assign(ga_available=hist.ga_available_olddef * bridge, ga_occupied=np.nan, ga_occupancy=np.nan,
                      definition=f"KH03 pre-2010 (ward type, annual) x {bridge:.3f} bridge")
    out = pd.concat([old[ann.columns.tolist() + ["ga_available_olddef"]], ann], ignore_index=True)
    out["bridge_ratio"] = bridge
    out.to_csv(OUT / "kh03_annual_england.csv", index=False)
    return out


# ------------------------------------------------------------------ A&E monthly
def ae_monthly() -> pd.DataFrame:
    f = next((RAW / "ae_attendances").glob("Monthly-AE-Time-Series-*.xls"))
    d = pd.read_excel(f, sheet_name="Activity", header=None)
    hdr = d.index[d[1].astype(str).str.strip().eq("Period")][0]
    cols = [str(c).strip() for c in d.iloc[hdr]]
    rows = d.iloc[hdr + 1:].copy()
    rows.columns = cols
    rows = rows[pd.to_datetime(rows["Period"], errors="coerce").notna()]
    m = pd.DataFrame({
        "month": pd.to_datetime(rows["Period"]),
        "emergency_admissions": pd.to_numeric(rows["Total Emergency Admissions"]),
        "emergency_admissions_via_ae": pd.to_numeric(rows["Total Emergency Admissions via A&E"]),
        "dta_over_4h": pd.to_numeric(rows["Number of patients spending >4 hours from decision to admit to admission"]),
        "dta_over_12h": pd.to_numeric(rows["Number of patients spending >12 hours from decision to admit to admission"]),
    })
    # Before June 2015 the series is weekly data apportioned to months: monthly figures are estimates.
    m["fy"] = m.month.map(fy_of)
    m.to_csv(OUT / "ae_monthly_england.csv", index=False)
    return m


# ------------------------------------------------------------------ G&A sitrep (monthly means of daily)
def sitrep_monthly() -> pd.DataFrame:
    f = next((RAW / "ga_sitreps").glob("Beds-publication-Timeseries-*.xlsx"))
    d = pd.read_excel(f, sheet_name="TS - All Acutes", header=None)
    hdr = d.index[d[1].astype(str).str.strip().eq("Month")][0]
    rows = d.iloc[hdr + 1:]
    rows = rows[pd.to_numeric(rows[2], errors="coerce").notna()]
    s = pd.DataFrame({
        "month": pd.to_datetime(rows[1].astype(str), format="%B %Y"),
        "ga_available_8am": pd.to_numeric(rows[2]),
        "ga_core": pd.to_numeric(rows[3]),
        "ga_escalation": pd.to_numeric(rows[4]),
        "ga_occupied_8am": pd.to_numeric(rows[6]),
        "ga_occupancy_8am": pd.to_numeric(rows[7]),
        "los_7plus": pd.to_numeric(rows[32], errors="coerce"),
        "los_14plus": pd.to_numeric(rows[33], errors="coerce"),
        "los_21plus": pd.to_numeric(rows[34], errors="coerce"),
    })
    s["fy"] = s.month.map(fy_of)
    s.to_csv(OUT / "sitrep_monthly_england.csv", index=False)
    return s


# ------------------------------------------------------------------ discharge (NCTR) daily
def nctr_daily() -> pd.DataFrame:
    f = sorted((RAW / "discharge_acute").glob("Daily-discharge-sitrep-timeseries-data-webfile-April2021-*.xlsx"))[-1]
    d = pd.read_excel(f, sheet_name="Daily Series", header=None)
    hdr = d.index[d[1].astype(str).str.strip().eq("Date")][0]
    cols = [str(c).strip() for c in d.iloc[hdr]]
    rows = d.iloc[hdr + 1:]
    rows = rows[pd.to_datetime(rows[1], errors="coerce").notna()]
    n = pd.DataFrame({
        "date": pd.to_datetime(rows[1]),
        "nctr": pd.to_numeric(rows[2], errors="coerce"),
        "nctr_discharged": pd.to_numeric(rows[3], errors="coerce"),
        "nctr_remaining": pd.to_numeric(rows[4], errors="coerce"),
    })
    n["fy"] = n.date.map(fy_of)
    n["weekday"] = n.date.dt.dayofweek
    n.attrs["columns"] = cols[:6]
    n.to_csv(OUT / "nctr_daily_england.csv", index=False)
    return n


# ------------------------------------------------------------------ ONS population by age
def ons_england_by_age() -> pd.DataFrame:
    f = RAW / "ons_population" / "ukpopulationestimates18382025.xlsx"
    d = pd.read_excel(f, sheet_name="Table 11", header=None)
    hdr = d.index[d[0].astype(str).str.strip().eq("Age")][0]
    cols = [str(c).strip() for c in d.iloc[hdr]]
    rows = d.iloc[hdr + 1:].copy()
    rows.columns = cols
    rows = rows[rows["Sex"].astype(str).str.strip().eq("Persons") & ~rows["Age"].astype(str).str.contains("All")]
    long = rows.melt(id_vars=["Age", "Sex"], var_name="year", value_name="population")
    long["year"] = long["year"].str.extract(r"(\d{4})").astype(int)
    long["age"] = long["Age"].astype(str).str.extract(r"(\d+)").astype(int)
    long["population"] = pd.to_numeric(long["population"])
    out = long[["year", "age", "population"]].sort_values(["year", "age"])
    out.to_csv(OUT / "ons_england_population_single_age.csv", index=False)
    return out


def main() -> None:
    q, hist = kh03()
    ann = kh03_annual(q, hist)
    print(ann.tail(20).round(3).to_string())
    m = ae_monthly()
    print(m.groupby("fy")[["emergency_admissions", "dta_over_12h"]].sum().tail(12))
    s = sitrep_monthly()
    print(s.groupby("fy")[["ga_available_8am", "ga_occupied_8am", "ga_occupancy_8am", "los_21plus"]].mean().round(3))
    n = nctr_daily()
    print(n.groupby("fy")[["nctr", "nctr_remaining", "nctr_discharged"]].mean().round(0))
    p = ons_england_by_age()
    print(p.groupby("year").population.sum().loc[[1975, 2005, 2010, 2015, 2024, 2025]])
    t = trust_panel("2025/26")
    print(f"trust panel 2025/26: {len(t)} trusts")
    import json
    core = assemble()
    lp = json.loads((OUT / "lever_parameters.json").read_text())
    core["riskFactors"] = lp["riskFactors"]
    core["deprivation"] = lp["deprivation"]
    core["flu"].update(lp["flu"])
    core["inputs"] = headline_inputs(core)
    core["rawFiles"] = raw_file_summary()
    (OUT / "model_inputs.json").write_text(json.dumps(core, indent=1, default=float))
    print("wrote data/processed/model_inputs.json")


# ------------------------------------------------------------------ trust-level panel (validation V7)
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
          "October", "November", "December"]


def _month_from_name(name: str) -> pd.Timestamp | None:
    n = name.lower()
    for i, m in enumerate(MONTHS):
        for tok in (m.lower(), m[:3].lower() + "-"):
            if tok in n:
                y = re.search(r"(20\d\d)", n) or re.search(r"-(\d\d)-csv", n)
                if not y:
                    return None
                yr = int(y.group(1)) if len(y.group(1)) == 4 else 2000 + int(y.group(1))
                return pd.Timestamp(yr, i + 1, 1)
    return None


def trust_panel(fy: str = "2025/26") -> pd.DataFrame:
    start = pd.Timestamp(int(fy[:4]), 4, 1)
    months = pd.date_range(start, periods=12, freq="MS")
    # A&E by provider (monthly CSVs)
    ae = []
    for f in (RAW / "ae_attendances").glob("*.csv"):
        m = _month_from_name(f.name)
        if m is None or m not in months:
            continue
        d = pd.read_csv(f)
        if "Org Code" not in d.columns:
            continue
        num = lambda c: pd.to_numeric(d[c], errors="coerce").fillna(0)  # noqa: E731
        ae.append(pd.DataFrame({
            "month": m, "org": d["Org Code"].astype(str).str.strip(), "org_name": d["Org name"],
            "emergency_admissions": num("Emergency admissions via A&E - Type 1") + num("Emergency admissions via A&E - Type 2")
            + num("Emergency admissions via A&E - Other A&E department") + num("Other emergency admissions"),
            "dta_over_12h": num("Patients who have waited 12+ hrs from DTA to admission"),
            "dta_4_12h": num("Patients who have waited 4-12 hs from DTA to admission"),
        }))
    ae = pd.concat(ae).drop_duplicates(["month", "org"], keep="last")
    # G&A sitrep by provider (monthly means of daily 08:00 counts)
    sr = []
    for f in (RAW / "ga_sitreps").glob("*CSV*.csv"):
        m = _month_from_name(f.name.replace("-beds-sitrep", ""))
        if m is None or m not in months:
            continue
        d = pd.read_csv(f)
        d = d[(d["Level"] == "Provider") & (d["Type"] != "Other")]
        p = d.pivot_table(index="Org Code", columns="Metric", values="Value", aggfunc="first")
        sr.append(pd.DataFrame({
            "month": m, "org": p.index.astype(str).str.strip(),
            "ga_available": p.get("G&A beds available"), "ga_occupied": p.get("G&A beds occupied"),
            "los_21plus": p.get("Number of G&A beds occupied by patients with a length of stay of - 21 or more days"),
        }).reset_index(drop=True))
    sr = pd.concat(sr).drop_duplicates(["month", "org"], keep="last")
    panel = sr.merge(ae, on=["month", "org"], how="inner")
    yr = panel.groupby("org").agg(
        org_name=("org_name", "first"), months=("month", "nunique"),
        ga_available=("ga_available", "mean"), ga_occupied=("ga_occupied", "mean"),
        los_21plus=("los_21plus", "mean"),
        emergency_admissions=("emergency_admissions", "sum"), dta_over_12h=("dta_over_12h", "sum"),
    ).reset_index()
    yr = yr[(yr.months >= 10) & (yr.ga_available > 100) & (yr.emergency_admissions > 5000)]
    scale = 12 / yr.months
    yr["emergency_admissions"] *= scale
    yr["dta_over_12h"] *= scale
    yr["occupancy_8am"] = yr.ga_occupied / yr.ga_available
    yr["wait12_share"] = yr.dta_over_12h / yr.emergency_admissions
    yr["fy"] = fy
    yr.to_csv(OUT / f"trust_panel_{fy.replace('/', '_')}.csv", index=False)
    return yr



# ------------------------------------------------------------------ winter daily sitrep (national, daily)
def _winter_sheet(f: Path, sheet: str, wanted: dict[str, str]) -> pd.DataFrame:
    d = pd.read_excel(f, sheet_name=sheet, header=None)
    date_row = d.index[d.apply(lambda r: r.map(lambda v: isinstance(v, (pd.Timestamp, _dt.datetime))).sum() > 3, axis=1)][0]
    hdr = d.iloc[date_row + 1].astype(str).str.strip()
    eng = d.index[d[4].astype(str).str.startswith("ENGLAND (All")][0]
    dates = d.iloc[date_row].ffill()
    rows = []
    for col in d.columns[5:]:
        name = hdr[col]
        for key, prefix in wanted.items():
            if name.startswith(prefix) and pd.notna(dates[col]):
                rows.append(dict(date=pd.Timestamp(dates[col]), key=key, value=pd.to_numeric(d.at[eng, col], errors="coerce")))
    return pd.DataFrame(rows).pivot_table(index="date", columns="key", values="value", aggfunc="first").reset_index()


def winter_daily() -> pd.DataFrame:
    out = []
    for f in sorted((RAW / "corridor_care").glob("Web-File-Timeseries-UEC-Daily-SitRep*.xlsx")):
        ga = _winter_sheet(f, "Total G&A beds", {"ga_open": "Total G&A Beds Open", "ga_occupied": "Total G&A beds occ"})
        flu = _winter_sheet(f, "Flu", {"flu_ga_beds": "G&A flu beds"})
        out.append(ga.merge(flu, on="date", how="outer").assign(source=f.name))
    w = pd.concat(out).drop_duplicates("date", keep="last").sort_values("date")
    w["occupancy"] = w.ga_occupied / w.ga_open
    w["weekday"] = w.date.dt.dayofweek
    w["winter"] = w.date.map(lambda x: f"{x.year if x.month >= 7 else x.year - 1}/{str((x.year if x.month >= 7 else x.year - 1) + 1)[-2:]}")
    w.to_csv(OUT / "winter_daily_england.csv", index=False)
    return w


# ------------------------------------------------------------------ HES 2023/24 by diagnosis -> age bands, flu, electives
AGE_COLS = {"0": (0, 0), "1-4": (1, 4), "5-9": (5, 9), "10-14": (10, 14), "15": (15, 15), "16": (16, 16), "17": (17, 17),
            "18": (18, 18), "19": (19, 19), "20-24": (20, 24), "25-29": (25, 29), "30-34": (30, 34), "35-39": (35, 39),
            "40-44": (40, 44), "45-49": (45, 49), "50-54": (50, 54), "55-59": (55, 59), "60-64": (60, 64), "65-69": (65, 69),
            "70-74": (70, 74), "75-79": (75, 79), "80-84": (80, 84), "85-89": (85, 89), "90+": (90, 120)}
BANDS = [("0-17", 0, 17), ("18-64", 18, 64), ("65-74", 65, 74), ("75-84", 75, 84), ("85+", 85, 120)]


def hes_diagnosis(year: str = "2023-24") -> pd.DataFrame:
    f = RAW / "hes_files" / f"hosp-epis-stat-admi-diag-{year}-tab.xlsx"
    d = pd.read_excel(f, sheet_name="Primary Diagnosis 3 Character", header=None)
    hdr_row = d.index[d.apply(lambda r: r.astype(str).str.startswith("Finished consultant episodes").any(), axis=1)][0]
    names = [re.sub(r"\s+", " ", str(c)).strip() for c in d.iloc[hdr_row]]
    rows = d.iloc[hdr_row + 1:]
    rows = rows[rows[0].astype(str).str.match(r"^[A-Z]\d\d$")]
    def col(label: str, nth: int = 0) -> pd.Series:
        idx = [i for i, n in enumerate(names) if n.startswith(label)][nth]
        return pd.to_numeric(rows[idx], errors="coerce").fillna(0)
    out = pd.DataFrame({"code": rows[0].astype(str), "desc": rows[1].astype(str),
                        "fce": col("Finished consultant episodes"), "fae": col("Finished Admission Episodes"),
                        "emergency_fae": col("Emergency (FAE)"), "waiting_fae": col("Waiting list (FAE)"),
                        "planned_fae": col("Planned (FAE)"), "day_case_fce": col("Day case (FCE)"),
                        "bed_days": col("FCE bed days"), "mean_los": col("Mean length of stay")})
    for k in AGE_COLS:
        out[f"age_{k}"] = col(f"Age {k} (FCE)")
    out.to_csv(OUT / f"hes_primary_diagnosis_{year}.csv", index=False)
    return out


def hes_derived(h: pd.DataFrame) -> dict:
    """Age-band emergency admissions and bed days, flu, and elective overnight admissions.

    HES publishes age only for all episodes of a diagnosis, not by admission method, so each
    diagnosis's emergency admissions are split by that diagnosis's age profile. Because
    emergency conditions are age-specific (e.g. pneumonia, falls), summing over ~1,800
    diagnoses gives a good age profile for emergency admissions. Maternity (O) and perinatal
    (P) chapters and live-born infants (Z38) are excluded, as they are not G&A beds."""
    # G&A scope: drop maternity (O), perinatal (P), live births (Z38) and mental illness other than
    # organic disorders such as dementia and delirium (F10-F99 are mostly psychiatric beds).
    g = h[~h.code.str.match(r"^(O|P|F[1-9])") & (h.code != "Z38")].copy()
    agecols = [f"age_{k}" for k in AGE_COLS]
    tot_age = g[agecols].sum(axis=1).replace(0, np.nan)
    emerg_share = (g.emergency_fae / g.fae.replace(0, np.nan)).fillna(0).clip(0, 1)
    g["emergency_bed_days"] = g.bed_days * emerg_share
    bands = []
    for name, lo, hi in BANDS:
        cols = [f"age_{k}" for k, (a, b) in AGE_COLS.items() if a >= lo and b <= hi]
        share = (g[cols].sum(axis=1) / tot_age).fillna(0)
        bands.append(dict(band=name, lo=lo, hi=hi, emergency_admissions=float((g.emergency_fae * share).sum()),
                          emergency_bed_days=float((g.emergency_bed_days * share).sum())))
    b = pd.DataFrame(bands)
    mean_bd = b.emergency_bed_days.sum() / b.emergency_admissions.sum()
    b["los_mult"] = (b.emergency_bed_days / b.emergency_admissions) / mean_bd
    flu = g[g.code.isin(["J09", "J10", "J11"])]
    flu_age = flu[agecols].sum()
    over65 = sum(flu_age[f"age_{k}"] for k, (a, _) in AGE_COLS.items() if a >= 65)
    flu_info = dict(
        emergency_admissions=float(flu.emergency_fae.sum()),
        share65=float(over65 / flu_age.sum()),
        los_mult=float((flu.emergency_bed_days.sum() / flu.emergency_fae.sum()) / mean_bd),
        codes="J09-J11",
    )
    elective_overnight = float((g.waiting_fae + g.planned_fae).sum() - g.day_case_fce.sum())
    # Bed days per admission measured on diagnoses dominated (>=85%) by one admission type, where
    # bed days can be attributed to that type without the splitting assumption.
    e_dom = g[(g.emergency_fae / g.fae.replace(0, np.nan)) >= 0.85]
    l_dom = g[((g.waiting_fae + g.planned_fae) / g.fae.replace(0, np.nan)) >= 0.85]
    emerg_bd_per_adm = float(e_dom.bed_days.sum() / e_dom.fae.sum())
    elect_bd_per_overnight = float(l_dom.bed_days.sum() / max((l_dom.fae - l_dom.day_case_fce).clip(lower=0).sum(), 1))
    return dict(bands=b, flu=flu_info, elective_overnight=elective_overnight,
                emergency_total=float(g.emergency_fae.sum()), mean_emergency_bed_days=float(mean_bd),
                emergency_bed_days_per_admission_dominant=emerg_bd_per_adm,
                emergency_dominant_share=float(e_dom.emergency_fae.sum() / g.emergency_fae.sum()),
                elective_bed_days_per_overnight_dominant=elect_bd_per_overnight,
                elective_dominant_share=float((l_dom.waiting_fae + l_dom.planned_fae).sum() / (g.waiting_fae + g.planned_fae).sum()))


# ------------------------------------------------------------------ ONS projections (England derived from UK)
def ons_projection_england(est: pd.DataFrame) -> pd.DataFrame:
    """2022-based UK principal projection by single age, converted to England using the
    England/UK ratio for each single year of age in the latest estimate year (ONS Table 3/11)."""
    import io
    import zipfile
    z = zipfile.ZipFile(RAW / "ons_projections" / "uk.zip")
    b = z.read("uk/uk_ppp_machine_readable.xlsx")
    d = pd.read_excel(io.BytesIO(b), sheet_name="Population")
    d = d.copy()
    d["age"] = pd.to_numeric(d["Age"].astype(str).str.extract(r"(\d+)")[0])
    uk = d.drop(columns=["Sex", "Age"]).groupby("age").sum()
    f = RAW / "ons_population" / "ukpopulationestimates18382025.xlsx"
    t3 = pd.read_excel(f, sheet_name="Table 3", header=None)
    hdr = t3.index[t3[0].astype(str).str.strip().eq("Age")][0]
    t3.columns = [str(c).strip() for c in t3.iloc[hdr]]
    t3 = t3.iloc[hdr + 1:]
    t3 = t3[t3["Sex"].astype(str).str.strip().eq("Persons") & ~t3["Age"].astype(str).str.contains("All")]
    last = max(est.year)
    uk_est = pd.Series(pd.to_numeric(t3[f"Mid-{last}"]).values, index=t3["Age"].astype(str).str.extract(r"(\d+)")[0].astype(int))
    eng_est = est[est.year == last].set_index("age").population
    ratio = (eng_est / uk_est).reindex(uk.index).ffill()
    proj = uk.mul(ratio, axis=0)
    long = proj.reset_index().melt(id_vars="age", var_name="year", value_name="population")
    long["year"] = long.year.astype(int)
    long = long[long.year > last]
    long.to_csv(OUT / "ons_england_projection_single_age.csv", index=False)
    return long


# ------------------------------------------------------------------ delay distribution (Discharge Ready Date)
def drd_delays(fy_months: list[pd.Timestamp]) -> dict:
    """Share of discharges after the Discharge Ready Date and the distribution of delay lengths,
    with a gamma distribution fitted to the published delay bands by maximum likelihood."""
    from scipy import optimize, stats
    # several editions are published; use the one covering the most recent month
    cands = sorted((RAW / "discharge_acute").glob("Discharge-Ready-Date-Timeseries-webfile-*.xlsx"))
    d = max((pd.read_excel(c, sheet_name="Timeseries", header=None) for c in cands),
            key=lambda x: pd.to_datetime(x[0], errors="coerce").max())
    hdr = d.index[d[0].astype(str).str.strip().eq("Month")][0]
    cols = d.iloc[hdr].tolist()
    rows = d.iloc[hdr + 1:]
    rows = rows[pd.to_datetime(rows[0], errors="coerce").notna()].copy()
    rows["month"] = pd.to_datetime(rows[0])
    rows = rows[rows.month.isin(fy_months)]
    delayed_share = pd.to_numeric(rows[8]).mean()
    # % of delayed patients discharged within each band (columns 26-31)
    bands = [(1, 1), (2, 3), (4, 6), (7, 13), (14, 20), (21, np.inf)]
    shares = np.array([pd.to_numeric(rows[c]).mean() for c in range(26, 32)])
    shares = shares / shares.sum()
    avg_exc0 = pd.to_numeric(rows[41], errors="coerce").mean()
    # A delay of d days (continuous) is recorded as ceil(d) days.
    def nll(theta):
        k, scale = np.exp(theta)
        cdf = lambda x: stats.gamma.cdf(x, k, scale=scale)  # noqa: E731
        probs = [cdf(hi) - cdf(lo - 1) if np.isfinite(hi) else 1 - cdf(lo - 1) for lo, hi in bands]
        return -np.sum(shares * np.log(np.maximum(probs, 1e-12)))
    res = optimize.minimize(nll, x0=np.log([1.0, 6.0]), method="Nelder-Mead")
    k, scale = np.exp(res.x)
    return dict(delayed_share=float(delayed_share), band_shares=shares.round(4).tolist(),
                band_labels=["1 day", "2-3 days", "4-6 days", "7-13 days", "14-20 days", "21+ days"],
                avg_delay_exc0=float(avg_exc0), gamma_shape=float(k), gamma_mean=float(k * scale),
                months=f"{min(rows.month):%b %Y}-{max(rows.month):%b %Y}")


# ------------------------------------------------------------------ flu wave per winter (daily flu beds)
def flu_waves(w: pd.DataFrame) -> list[dict]:
    """Fit a Gaussian curve in time to the daily number of flu patients in G&A beds each winter.
    The peak occupancy and its date are taken directly from the data; the spread is the fitted SD."""
    from scipy import optimize
    out = []
    for winter, g in w.dropna(subset=["flu_ga_beds"]).groupby("winter"):
        x = (g.date - pd.Timestamp(int(winter[:4]), 1, 1)).dt.days.values.astype(float)  # day of year (Jan 1 = 0)
        y = g.flu_ga_beds.values.astype(float)
        f = lambda p, x: p[3] + p[0] * np.exp(-0.5 * ((x - p[1]) / p[2]) ** 2)  # noqa: E731
        p0 = [y.max(), x[np.argmax(y)], 20, y.min()]
        res = optimize.least_squares(lambda p: f(p, x) - y, p0, bounds=([0, 250, 3, 0], [2e4, 450, 80, 2e3]))
        a, mu, sd, base = res.x
        peak_date = pd.Timestamp(int(winter[:4]), 1, 1) + pd.Timedelta(days=float(mu))
        roll7 = pd.Series(y).rolling(7).mean().max()
        out.append(dict(winter=winter, peak_beds_observed=float(y.max()), peak_beds_7day=float(roll7),
                        peak_date_observed=str(g.date.iloc[int(np.argmax(y))].date()),
                        fitted_peak_date=str(peak_date.date()), fitted_peak_doy=int(peak_date.dayofyear),
                        fitted_sd_days=float(sd), fitted_height=float(a), fitted_baseline=float(base),
                        r2=float(1 - np.sum((f(res.x, x) - y) ** 2) / np.sum((y - y.mean()) ** 2))))
    return out


# ------------------------------------------------------------------ documentation lists for the website
NHSE_STATS = "https://www.england.nhs.uk/statistics/statistical-work-areas"
SRC = {
    "kh03": ("NHS England KH03 bed availability and occupancy", f"{NHSE_STATS}/bed-availability-and-occupancy/bed-availability-and-occupancy-kh03/"),
    "ae": ("NHS England A&E attendances and emergency admissions", f"{NHSE_STATS}/ae-waiting-times-and-activity/"),
    "sitrep": ("NHS England UEC daily situation reports (G&A beds)", f"{NHSE_STATS}/bed-availability-and-occupancy/critical-care-and-general-acute-beds-urgent-and-emergency-care-daily-situation-reports/"),
    "nctr": ("NHS England acute discharge situation report", f"{NHSE_STATS}/discharge-delays-acute-data/"),
    "drd": ("NHS England timeliness of discharges (Discharge Ready Date)", f"{NHSE_STATS}/discharge-delays-acute-data/"),
    "hes": ("NHS England Digital, Hospital Admitted Patient Care Activity 2023-24 (diagnosis tables)", "https://digital.nhs.uk/data-and-information/publications/statistical/hospital-admitted-patient-care-activity/2023-24"),
    "ons": ("ONS mid-year population estimates", "https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationestimates"),
    "onsp": ("ONS 2022-based national population projections", "https://www.ons.gov.uk/peoplepopulationandcommunity/populationandmigration/populationprojections"),
    "winter": ("NHS England UEC daily sitrep, winter daily time series", f"{NHSE_STATS}/uec-sitrep/"),
}


def headline_inputs(core: dict) -> list[dict]:
    t, n, fy = core["targets"], core["national"], core["baseYearLabel"]
    def row(label, value, unit, src, note="", period=fy):
        name, url = SRC[src]
        return dict(label=label, value=value, unit=unit, period=period, source=name, url=url, note=note)
    return [
        row("G&A beds open overnight (England)", n["beds"], "beds", "kh03", "Average of four quarters"),
        row("G&A occupancy (midnight)", t["occupancy"], "share", "kh03", "Calibration target"),
        row("Emergency admissions", n["emergPerYear"], "per year", "ae", "All routes (via A&E and other)"),
        row("Waiting >12h from decision to admit", t["wait12Share"], "share", "ae", "Share of emergency admissions; calibration target (pool size)"),
        row("Planned overnight admissions", n["electivePerYear"], "per year", "hes", "Waiting-list and planned admissions minus day cases, excluding maternity and psychiatry", "2023/24"),
        row("Planned stay, bed days per overnight admission", core["elective"]["meanBedDays"], "days", "hes", "Diagnoses where >=85% of admissions are planned", "2023/24"),
        row("Midnights per emergency admission", t["emBedDaysPerAdm"], "days", "hes", "Calibration target (share discharged the same day)", "2023/24"),
        row("Occupied beds with patients in hospital 21+ days", t["long21Share"], "share", "sitrep", "Calibration target (spread of length of stay)"),
        row("Discharged after Discharge Ready Date", t["delayedShare"], "share", "drd", "Calibration target (share delayed)"),
        row("Delay length distribution (gamma fit)", core["delays"]["mean"], "days (mean)", "drd", f"Shape {core['delays']['shape']:.2f}, fitted to the published delay bands"),
        row("Weekend / weekday discharge-rate ratio", t["weekendRatio"], "ratio", "nctr", "Patients no longer meeting criteria to reside; calibration target (weekend discharging)"),
        row("Patients no longer meeting criteria to reside, end of day", t["nctrShare"], "share", "nctr", "Share of occupied beds; validation only (not calibrated)"),
        row("Flu patients in G&A beds, winter peak (7-day mean)", t["fluPeakBeds"], "beds", "winter", "Calibration target (size of flu wave)"),
        row("Flu wave peak date and spread", core["flu"]["sdDays"], "days (SD)", "winter", f"Peak day-of-year {core['flu']['peakDoy']}; Gaussian fitted to daily flu beds"),
        row("Flu admissions aged 65+", core["flu"]["share65"], "share", "hes", "ICD-10 J09-J11 primary diagnosis", "2023/24"),
        row("England population", sum(b["pop"][str(core["baseYear"])] if str(core["baseYear"]) in b["pop"] else b["pop"][core["baseYear"]] for b in core["ageBands"]), "people", "ons", "Mid-year estimate", str(core["baseYear"])),
    ]


def raw_file_summary() -> list[dict]:
    import csv as _csv
    rows = list(_csv.DictReader(open(RAW / "manifest.csv")))
    names = {"kh03_overnight": "KH03 overnight beds (quarterly, by trust)", "kh03_main": "KH03 time series and historic tables",
             "ga_sitreps": "G&A bed sitreps (monthly, by trust)", "ae_attendances": "A&E attendances and emergency admissions",
             "discharge_acute": "Acute discharge sitrep and Discharge Ready Date", "dtoc": "Delayed transfers of care (to 2020)",
             "fingertips": "OHID Fingertips public health indicators", "hes_files": "HES admitted patient care tables",
             "corridor_care": "UEC daily sitrep time series (winter daily)", "ons_population": "ONS population estimates",
             "ons_projections": "ONS national population projections"}
    out = []
    for src in sorted({r["source"] for r in rows}):
        rs = [r for r in rows if r["source"] == src]
        out.append(dict(dataset=names.get(src, src), files=[f"{len(rs)} files, {sum(int(r['bytes'] or 0) for r in rs) / 1e6:.0f} MB"],
                        page=rs[0]["page"] if rs[0]["page"].startswith("http") else ""))
    return out


# ------------------------------------------------------------------ assemble model inputs
BASE_FY = "2025/26"   # calibration year (latest complete year in every source)
BASE_YEAR = 2025      # population mid-year matching the calibration year


def pop_by_band(est: pd.DataFrame, proj: pd.DataFrame) -> dict[str, dict[int, float]]:
    allp = pd.concat([est, proj])
    out = {}
    for name, lo, hi in BANDS:
        s = allp[(allp.age >= lo) & (allp.age <= hi)].groupby("year").population.sum()
        out[name] = {int(y): float(v) for y, v in s.items() if 2000 <= y <= 2045}
    return out


def assemble() -> dict:
    q, hist = kh03()
    ann = kh03_annual(q, hist)
    ae = ae_monthly()
    sr = sitrep_monthly()
    nc = nctr_daily()
    est = ons_england_by_age()
    proj = ons_projection_england(est)
    w = winter_daily()
    h = hes_diagnosis()
    hd = hes_derived(h)
    trust = trust_panel(BASE_FY)
    months = list(pd.date_range(f"{BASE_FY[:4]}-04-01", periods=12, freq="MS"))
    drd = drd_delays(months)
    waves = flu_waves(w)

    def year_row(fy):
        a = ann[ann.year == fy].iloc[0]
        e = ae[ae.fy == fy]
        n = nc[nc.fy == fy]
        s = sr[sr.fy == fy]
        return dict(
            fy=fy, beds=float(a.ga_available), occupied=float(a.ga_occupied), occupancy=float(a.ga_occupancy),
            # annualise partial years (the A&E series starts in August 2010)
            emergency_admissions=float(e.emergency_admissions.sum() * 12 / max(e.month.nunique(), 1)),
            dta_over_12h=float(e.dta_over_12h.sum() * 12 / max(e.month.nunique(), 1)),
            ae_months=int(e.month.nunique()),
            wait12_share=float(e.dta_over_12h.sum() / e.emergency_admissions.sum()),
            nctr_remaining=float(n.nctr_remaining.mean()) if len(n) else None,
            nctr_share=float(n.nctr_remaining.mean() / a.ga_occupied) if len(n) else None,
            long21_share=float((s.los_21plus / s.ga_occupied_8am).mean()) if len(s) and s.los_21plus.notna().any() else None,
            occupancy_8am=float(s.ga_occupancy_8am.mean()) if len(s) else None,
        )

    base = year_row(BASE_FY)
    nb = nc[nc.fy == BASE_FY].copy()
    nb["rate"] = nb.nctr_discharged / nb.nctr
    r = nb.groupby("weekday").rate.median()
    weekend_ratio = float(r[[5, 6]].mean() / r[[0, 1, 2, 3, 4]].mean())

    # age bands: HES 2023/24 shares applied to the calibration-year emergency total
    b = hd["bands"].copy()
    b["share"] = b.emergency_admissions / b.emergency_admissions.sum()
    pops = pop_by_band(est, proj)
    age_bands = [dict(band=row.band, emergAdm=float(row.share * base["emergency_admissions"]), losMult=float(row.los_mult),
                      delayMult=1.0, older=row.lo >= 75, pop=pops[row.band]) for row in b.itertuples()]

    wave = next(x for x in waves if x["winter"] == BASE_FY)
    flu_hist = [x for x in waves]

    bed_history = []
    for fy in ["2005/06", "2008/09", "2010/11", "2015/16", "2019/20", "2024/25", BASE_FY]:
        a = ann[ann.year == fy].iloc[0]
        yr = int(fy[:4])
        popn = float(est[est.year == yr].population.sum())
        bed_history.append(dict(year=fy, beds=float(a.ga_available),
                                bedsPublished=float(a.ga_available_olddef) if pd.notna(a.get("ga_available_olddef")) else float(a.ga_available),
                                occupancy=float(a.ga_occupancy) if pd.notna(a.ga_occupancy) else None,
                                population=popn, note=str(a.definition)))
    pop_now = float(est[est.year == BASE_YEAR].population.sum())
    presets = [dict(label=f"{BASE_FY} (today)", beds=base["beds"])]
    for h_ in bed_history[:-1]:
        presets.append(dict(label=h_["year"], beds=h_["beds"], note=h_["note"]))
    for h_ in bed_history[:4]:
        presets.append(dict(label=f"{h_['year']} per head", beds=h_["beds"] * pop_now / h_["population"],
                            note=f"{h_['year']} beds per head of population, applied to the {BASE_YEAR} population"))

    backtests = [year_row(fy) for fy in ["2024/25", "2023/24", "2022/23", "2019/20", "2018/19", "2015/16", "2010/11"]]
    winter_val = {}
    for wn, g in w.groupby("winter"):
        winter_val[wn] = dict(days=int(len(g)), occ_mean=float(g.occupancy.mean()), occ_sd=float(g.occupancy.std()),
                              occ_p5=float(g.occupancy.quantile(0.05)), occ_p95=float(g.occupancy.quantile(0.95)),
                              weekday=[float(x) for x in g.groupby("weekday").occupancy.mean().values],
                              start=str(g.date.min().date()), end=str(g.date.max().date()))

    inputs = dict(
        baseYear=BASE_YEAR, baseYearLabel=BASE_FY,
        national=dict(beds=base["beds"], emergPerYear=base["emergency_admissions"], electivePerYear=hd["elective_overnight"],
                      occupancy=base["occupancy"]),
        targets=dict(occupancy=base["occupancy"], nctrShare=base["nctr_share"], wait12Share=base["wait12_share"],
                     long21Share=base["long21_share"], weekendRatio=weekend_ratio, delayedShare=drd["delayed_share"],
                     emBedDaysPerAdm=hd["mean_emergency_bed_days"], fluPeakBeds=wave["peak_beds_7day"]),
        delays=dict(shape=drd["gamma_shape"], mean=drd["gamma_mean"], bands=drd["band_shares"], bandLabels=drd["band_labels"],
                    avgExc0=drd["avg_delay_exc0"]),
        elective=dict(meanBedDays=hd["elective_bed_days_per_overnight_dominant"]),
        ageBands=age_bands,
        flu=dict(admissionsCoded2324=hd["flu"]["emergency_admissions"], share65=hd["flu"]["share65"], losMult=hd["flu"]["los_mult"],
                 peakDoy=wave["fitted_peak_doy"], sdDays=wave["fitted_sd_days"], peakBedsTarget=wave["peak_beds_observed"],
                 seasons=flu_hist),
        bedHistory=bed_history, presets=presets, backtests=backtests, winterValidation=winter_val,
        trustPanel=dict(fy=BASE_FY, n=int(len(trust)), file=f"data/processed/trust_panel_{BASE_FY.replace('/', '_')}.csv"),
        hes=dict(year="2023/24", emergencyTotal=hd["emergency_total"], meanEmergencyBedDays=hd["mean_emergency_bed_days"],
                 emergencyBedDaysDominant=hd["emergency_bed_days_per_admission_dominant"]),
    )
    import json
    (OUT / "model_inputs_core.json").write_text(json.dumps(inputs, indent=1, default=float))
    return inputs


if __name__ == "__main__":
    main()
