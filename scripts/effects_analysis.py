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


# ------------------------------------------------------------------ parameters for the simulator's public-health levers
def england_value(key: str, iid: int, age: str, period_pattern: str | None = None) -> tuple[float, str, float | None]:
    d = pd.read_csv(FT / f"{key}__{iid}__at15.csv", low_memory=False)
    e = d[(d["Area Name"] == "England") & (d.Sex == "Persons") & d["Category Type"].isna() & (d.Age == age)]
    if period_pattern:
        e = e[e["Time period"].astype(str).str.fullmatch(period_pattern)]
    row = e.iloc[-1]
    return float(row.Value), str(row["Time period"]), (float(row.Count) if pd.notna(row.Count) else None)


def lever_parameters(est: pd.DataFrame, panel: pd.DataFrame) -> dict:
    hes = pd.read_csv(OUT / "hes_primary_diagnosis_2023-24.csv")
    agecols = [c for c in hes.columns if c.startswith("age_")]
    fce_by_age = hes[agecols].sum()
    over35 = sum(v for c, v in fce_by_age.items() if re.match(r"age_(35|4|5|6|7|8|9)", c))
    fae_total = hes.fae.sum()
    fae_35 = fae_total * over35 / fce_by_age.sum()

    # Smoking: OHID smoking-attributable admissions (aged 35+) / all admissions aged 35+ = attributable fraction.
    smk_adm, smk_period, smk_count = england_value("smoking_admissions", 93753, "35+ yrs")
    paf = smk_count / fae_35
    p_then, p_then_period, _ = england_value("smoking_prevalence", 92443, "18+ yrs", smk_period[:4])
    p_now, p_now_period, _ = england_value("smoking_prevalence", 92443, "18+ yrs", r"20\d\d")
    rr = 1 + paf / ((1 - paf) * p_then / 100)
    smoking = dict(key="smoking", label="Adult smoking rate", type="prevalence", current=round(p_now, 1),
                   relativeRisk=rr, paf=paf, min=0, max=25, step=0.5,
                   derivation=(f"OHID smoking-attributable admissions {smk_period} ({smk_count:,.0f}, ages 35+) divided by all hospital "
                               f"admissions aged 35+ (HES 2023/24, {fae_35:,.0f}) gives an attributable fraction of {paf:.1%}. With adult "
                               f"smoking prevalence {p_then:.1f}% ({p_then_period}) this implies a relative risk of {rr:.2f}."),
                   note="OHID's attributable count includes harm in ex-smokers, so the effect of quitting builds up over many years.",
                   sources=[dict(name="OHID Fingertips 93753", url="https://fingertips.phe.org.uk/search/93753"),
                            dict(name="OHID Fingertips 92443 (APS)", url="https://fingertips.phe.org.uk/search/92443")],
                   help=f"Adults who smoke. Today {p_now:.1f}% ({p_now_period}).")

    # Alcohol: OHID narrow measure is already an attributable count.
    alc_rate, alc_period, alc_count = england_value("alcohol_admissions", 93764, "All ages")
    alcohol = dict(key="alcohol", label="Alcohol harm", type="attributable", current=0, share=alc_count / fae_total,
                   min=-50, max=50, step=5,
                   derivation=(f"OHID alcohol-related admissions, narrow measure, {alc_period}: {alc_count:,.0f}, "
                               f"{alc_count / fae_total:.1%} of all admissions (HES 2023/24)."),
                   sources=[dict(name="OHID Fingertips 93764", url="https://fingertips.phe.org.uk/search/93764")],
                   help="Change in admissions caused by alcohol (e.g. from minimum unit pricing or treatment services).")

    # Obesity: between-area association with all-cause emergency admissions (no official attributable count).
    est_ = pd.read_csv(OUT / "effects_estimates.csv")
    ob = est_[(est_.outcome == "emergency_all") & (est_.exposure == "obesity") & est_.design.str.startswith("between")]
    ob = ob.sort_values("n_obs").iloc[-1]
    ob_now, ob_period, _ = england_value("obesity_prevalence", 93881, "18+ yrs", r"20\d\d/\d\d")
    pct = ob.pct_per_point / 100
    rr_ob = 1 + pct * (1 + ob_now / 100 * 0)  # per point of prevalence; converted below
    # Express as a relative risk so it fits the attributable-fraction formula:
    # d log(rate) / d p = (RR-1) / (1 + p (RR-1))  =>  RR - 1 = b / (1 - b p)
    b = np.log(1 + pct) * 100  # per unit of prevalence (fraction)
    rr_ob = 1 + b / (1 - b * ob_now / 100)
    # Published alternative: Million Women Study (Reeves et al. 2014) standardised admission rates per woman over
    # 10 years: 2.4 (BMI 22.5-25), 2.6 (25-30), 3.0 (30-35), 3.5 (35+). Relative risk of obesity (BMI 30+) versus
    # BMI under 30 = mean of the 30+ rates, weighted by the share of obese adults with BMI 35+ (about 40%,
    # HSE), divided by the mean of the under-30 rates weighted equally between healthy weight and overweight.
    rr_mws = (0.6 * 3.0 + 0.4 * 3.5) / (0.5 * 2.4 + 0.5 * 2.6)
    obesity = dict(key="obesity", label="Adult obesity rate", type="prevalence", current=round(ob_now, 1), relativeRisk=rr_mws,
                   relativeRiskAreaData=rr_ob,
                   derivationPublished=(f"Million Women Study (Reeves et al. 2014): admission rates per woman over 10 years of 3.0 "
                                        f"(BMI 30-35) and 3.5 (35+) versus 2.4-2.6 below BMI 30, giving a relative risk of "
                                        f"{rr_mws:.2f} for obesity."),
                   paf=(ob_now / 100) * (rr_mws - 1) / (1 + ob_now / 100 * (rr_mws - 1)),
                   pafAreaData=(ob_now / 100) * (rr_ob - 1) / (1 + ob_now / 100 * (rr_ob - 1)), min=10, max=40, step=0.5,
                   derivation=(f"Between-area regression of age-standardised emergency admissions (OHID 93227) on adult obesity "
                               f"prevalence, adjusted for deprivation and smoking, across {int(ob.n_areas)} local authorities: "
                               f"{ob.pct_per_point:+.2f}% admissions per percentage point (95% CI {ob.ci_low:+.2f} to {ob.ci_high:+.2f}). "
                               f"Equivalent relative risk {rr_ob:.2f}."),
                   note=("Default: Million Women Study relative risk. Alternative ('area analysis' evidence setting): this project's "
                         "between-area estimate, an association that is probably inflated by confounding; see the Validation page."),
                   ci_pct_per_point=[float(ob.ci_low), float(ob.ci_high)],
                   sources=[dict(name="OHID Fingertips 93881", url="https://fingertips.phe.org.uk/search/93881"),
                            dict(name="OHID Fingertips 93227", url="https://fingertips.phe.org.uk/search/93227"),
                            dict(name="Reeves et al. 2014, BMC Medicine", url="https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4003825/")],
                   help=f"Adults living with obesity. Today {ob_now:.1f}% ({ob_period}).")

    # Deprivation: emergency admission ratio by fifth of local authorities ranked by IMD 2019 score.
    sar = load_series("emergency_all_causes", 93227, None).rename(columns={"value": "sar"})
    imd = deprivation_by_area()
    pop = pd.read_csv(OUT / "effects_panel.csv")[["area"]].drop_duplicates()
    g = sar.merge(imd, on="area").dropna()
    g["fifth"] = pd.qcut(g.imd.rank(method="first", ascending=False), 5, labels=[1, 2, 3, 4, 5])
    rel = g.groupby("fifth", observed=True).sar.mean()
    rel = (rel / rel.mean()).round(4).tolist()
    deprivation = dict(relativeRates=rel,
                       note=(f"Age-standardised emergency admission ratio (OHID 93227, {sar.year.min():.0f}-based pooled period) for "
                             f"{len(g)} upper-tier local authorities grouped into fifths by IMD 2019 deprivation score "
                             "(most deprived first), relative to the average. Area-level, so it understates the gap between individuals."),
                       sources=[dict(name="OHID Fingertips 93227", url="https://fingertips.phe.org.uk/search/93227"),
                                dict(name="OHID Fingertips 93553 (IMD 2019)", url="https://fingertips.phe.org.uk/search/93553")],
                       help="Narrow the gap in emergency admission rates between the most and least deprived fifths of areas.")

    # Flu vaccination: uptake from OHID; effectiveness against hospitalisation from published test-negative studies.
    up, up_period, _ = england_value("flu_vaccination", 30314, "65+ yrs")
    flu = dict(uptake65=round(up, 1), uptakeSeason=up_period, ve=0.423, veRange=[0.332, 0.501],
               veSource=dict(name="Bucholc et al. 2026, Influenza Other Respir Viruses (Northern Ireland 2024/25, aged 65+)",
                             url="https://onlinelibrary.wiley.com/doi/10.1111/irv.70303"),
               uptakeSource=dict(name="OHID Fingertips 30314", url="https://fingertips.phe.org.uk/search/30314"),
               note=("Vaccine effectiveness cannot be estimated from area-level data (placebo outcomes fail; see Validation), "
                     "so the measured estimate from a UK test-negative study is used."))
    return dict(riskFactors=[smoking, obesity, alcohol], deprivation=deprivation, flu=flu)




if __name__ == "__main__":
    import sys
    if sys.argv[1:] != ["levers"]:
        main()
    lp = lever_parameters(None, pd.read_csv(OUT / "effects_panel.csv"))
    (OUT / "lever_parameters.json").write_text(json.dumps(lp, indent=1, default=float))
    print(json.dumps(lp, indent=1, default=float)[:4000])
