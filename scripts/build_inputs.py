"""Process the raw NHS England / ONS files into tidy CSVs in data/processed/.

Every number the model and website use is derived here (or in
scripts/effects_analysis.py) from files in data/raw/, which are listed with
their source URLs and checksums in data/raw/manifest.csv.

Usage: python3 scripts/build_inputs.py
"""

from __future__ import annotations

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


if __name__ == "__main__":
    main()
