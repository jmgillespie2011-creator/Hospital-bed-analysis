"""Estimate the effect of public-health policy levers on hospital admissions from data.

Data: OHID Fingertips indicators for ~150 upper-tier local authorities in England over
many years (data/raw/fingertips/), downloaded by scripts/fetch_raw_data.py.

For each outcome (an age-standardised emergency admission rate) we estimate how it
varies with risk-factor prevalence using two designs:

* Between areas: log(rate) on risk factors and deprivation across areas, averaged over
  the latest years. Uses large, stable differences between places, but is open to
  confounding by anything else that differs between places.
* Within areas over time (two-way fixed effects): log(rate) on risk factors with area
  and year fixed effects, so fixed differences between areas and national trends are
  removed. Less confounded, but risk factors change slowly, so estimates are noisier.

Standard errors are clustered by area. Coefficients are converted to the "% change in
admissions per percentage-point change in prevalence" the simulator uses.

Outputs: data/processed/effects_estimates.csv, data/processed/effects_panel.csv and a
markdown summary in docs/effects-analysis.md (written by hand from these outputs).

Usage: python3 scripts/effects_analysis.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

ROOT = Path(__file__).resolve().parents[1]
FT = ROOT / "data" / "raw" / "fingertips"
OUT = ROOT / "data" / "processed"
OUT.mkdir(parents=True, exist_ok=True)

LA_TYPE = "Counties & UAs (from Apr 2023)"

# variable -> (file key, indicator id, age group)
SERIES = {
    "smoking": ("smoking_prevalence", 92443, "18+ yrs"),
    "obesity": ("obesity_prevalence", 93881, "18+ yrs"),
    "inactivity": ("inactivity", 93015, "19+ yrs"),
    "flu_uptake65": ("flu_vaccination", 30314, "65+ yrs"),
    "alcohol_narrow": ("alcohol_admissions", 93764, "All ages"),
    "copd": ("copd_admissions", 92302, "35+ yrs"),
    "falls65": ("falls_admissions", 22401, "65+ yrs"),
    "emergency_all": ("emergency_all_causes", 93227, None),
    "pneumonia": ("pneumonia_admissions", 93574, None),
    "respiratory": ("respiratory_admissions", 93575, None),
    "chd": ("chd_admissions", 93229, None),
    "stroke": ("stroke_admissions", 93231, None),
    "hip_fracture": ("hip_fracture_admissions", 93241, None),
}


def start_year(period: str) -> float:
    """'2015/16' -> 2015; '2015' -> 2015; '2013 - 15' or '2013/14 - 15/16' -> mid-point."""
    p = str(period)
    years = [int(y) for y in re.findall(r"(?<!\d)(20\d\d)(?!\d)", p)]
    if not years:
        return np.nan
    if re.search(r"\s-\s", p):  # pooled period: use the mid-point
        a = years[0]
        tail = re.findall(r"-\s*(\d\d)(?:/\d\d)?$", p)
        b = 2000 + int(tail[0]) if tail else years[-1]
        if "/" in p:
            b -= 0  # 2013/14 - 15/16 -> starts 2013, ends 2015/16 (start 2015)
        return (a + b) / 2
    return float(years[0])


def load_series(key: str, iid: int, age: str | None) -> pd.DataFrame:
    files = sorted(FT.glob(f"{key}__{iid}__at502.csv")) or sorted(FT.glob(f"*__{iid}__at502.csv"))
    if not files:
        return pd.DataFrame()
    d = pd.read_csv(files[0], low_memory=False)
    if d.empty:
        return pd.DataFrame()
    name = str(d["Indicator Name"].iloc[0])
    d = d[(d["Area Type"] == LA_TYPE) & (d["Sex"] == "Persons") & d["Category Type"].isna()]
    if age is None:  # most common age band for this indicator
        age = d["Age"].mode().iloc[0] if len(d) else None
    d = d[d["Age"] == age]
    out = pd.DataFrame({
        "area": d["Area Code"], "area_name": d["Area Name"], "period": d["Time period"].astype(str),
        "value": pd.to_numeric(d["Value"], errors="coerce"),
    }).dropna(subset=["value"])
    out["year"] = out.period.map(start_year)
    out = out.groupby(["area", "year"], as_index=False).agg(value=("value", "mean"), area_name=("area_name", "first"))
    out.attrs["age"] = age
    out.attrs["name"] = name
    return out


def deprivation_by_area() -> pd.DataFrame:
    f = sorted(FT.glob("*__93553__at502.csv"))
    d = pd.read_csv(f[0], low_memory=False)
    d = d[(d["Area Type"] == LA_TYPE) & d["Category Type"].isna()]
    return pd.DataFrame({"area": d["Area Code"], "imd": pd.to_numeric(d["Value"], errors="coerce")}).drop_duplicates("area")


def build_panel() -> tuple[pd.DataFrame, dict]:
    meta, panel = {}, None
    for var, (key, iid, age) in SERIES.items():
        s = load_series(key, iid, age)
        if s.empty:
            print(f"  (no data for {var})")
            continue
        meta[var] = dict(indicator_id=iid, name=s.attrs.get("name"), age=s.attrs.get("age"),
                         years=f"{int(s.year.min())}-{int(s.year.max())}", areas=int(s.area.nunique()))
        s = s.rename(columns={"value": var})[["area", "year", var] + (["area_name"] if panel is None else [])]
        panel = s if panel is None else panel.merge(s, on=["area", "year"], how="outer")
    panel = panel.merge(deprivation_by_area(), on="area", how="left")
    panel.to_csv(OUT / "effects_panel.csv", index=False)
    return panel, meta


def fit(panel: pd.DataFrame, outcome: str, exposures: list[str], fe: bool, years: tuple[int, int] | None = None):
    cols = [outcome, *exposures] + ([] if fe else ["imd"])
    d = panel.dropna(subset=cols).copy()
    if years:
        d = d[(d.year >= years[0]) & (d.year <= years[1])]
    d = d[d[outcome] > 0]
    d["y"] = np.log(d[outcome])
    if fe:
        f = "y ~ " + " + ".join(exposures) + " + C(area) + C(year)"
        m = smf.ols(f, data=d).fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(d.area)[0]})
    else:
        # between-area: average each area over the years it has data
        g = d.groupby("area")[cols + ["y"]].mean().reset_index()
        f = "y ~ " + " + ".join(exposures) + " + imd"
        m = smf.ols(f, data=g).fit(cov_type="HC1")
        d = g
    rows = []
    for x in exposures:
        b, se = m.params[x], m.bse[x]
        rows.append(dict(outcome=outcome, exposure=x, design="within-area (area+year FE)" if fe else "between-area (adjusted for deprivation)",
                         beta=b, se=se, pct_per_point=100 * (np.exp(b) - 1),
                         ci_low=100 * (np.exp(b - 1.96 * se) - 1), ci_high=100 * (np.exp(b + 1.96 * se) - 1),
                         p=m.pvalues[x], n_obs=int(m.nobs), n_areas=int(d.area.nunique()) if "area" in d else None,
                         r2=m.rsquared))
    return rows


def main() -> None:
    panel, meta = build_panel()
    print(json.dumps(meta, indent=1))
    specs = [
        # (outcome, exposures)
        ("copd", ["smoking"]),
        ("copd", ["smoking", "obesity"]),
        ("emergency_all", ["smoking", "obesity", "flu_uptake65", "alcohol_narrow"]),
        ("emergency_all", ["smoking", "obesity"]),
        ("pneumonia", ["flu_uptake65", "smoking"]),
        ("respiratory", ["flu_uptake65", "smoking"]),
        ("chd", ["smoking", "obesity"]),
        ("stroke", ["smoking", "obesity"]),
        # placebo: falls in older people should not depend on smoking prevalence once deprivation is held fixed
        ("falls65", ["smoking", "flu_uptake65"]),
        ("hip_fracture", ["flu_uptake65"]),
    ]
    rows = []
    for outcome, xs in specs:
        if outcome not in panel or any(x not in panel for x in xs):
            continue
        for fe in (False, True):
            try:
                rows += fit(panel, outcome, xs, fe)
            except Exception as e:  # noqa: BLE001
                print("  !", outcome, xs, fe, e)
    est = pd.DataFrame(rows)
    est.to_csv(OUT / "effects_estimates.csv", index=False)
    pd.set_option("display.width", 220)
    print(est[["outcome", "exposure", "design", "pct_per_point", "ci_low", "ci_high", "p", "n_obs", "n_areas"]].round(3).to_string())
    json.dump(meta, open(OUT / "effects_meta.json", "w"), indent=1)


if __name__ == "__main__":
    main()
