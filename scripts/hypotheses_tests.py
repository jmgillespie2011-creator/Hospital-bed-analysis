"""Statistical tests of three explanations of long waits for a bed: social care, general practice, hospital flow.

  trustDelays   acute trusts, monthly, April 2025 onwards: do months (within a trust) and trusts with more patients delayed
                7+ days for each reason have more 12-hour waits? Delays per 100 G&A beds by who has to act (discharge sitrep
                delay reasons); 12-hour waits from decision to admit (A&E monthly); occupancy at 08:00 (bed sitrep).
                Poisson regression of 12-hour waits with emergency admissions as exposure, trust and month fixed effects,
                with and without occupancy (with: the effect beyond filling beds; without: the total effect).
  areaGp        councils, yearly: do areas where patients find it easier to get GP care have fewer emergency admissions
                for conditions that primary care can manage (COPD, asthma, dementia)? Between areas (adjusted for
                deprivation) and within areas over time (area and year fixed effects). Needs the Fingertips GP survey files.
  areaSocial    councils, yearly: do councils that spend more on adult social care per older person have fewer delayed
                transfers of care attributable to social care (ASCOF 2C)? Needs the ASC-FR files.
Writes web/data/hypotheses_tests.json.  Usage: python scripts/hypotheses_tests.py
"""
from __future__ import annotations

import glob
import json
import re
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parents[1]
RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"
GROUPS = {"Social care": "sc", "Community health services": "ch", "Hospital processes": "hp",
          "Care transfer hubs and other joint processes": "jt", "Patient, family and legal": "pf", "Housing": "ho"}


def coefs(fit, names, scale=1.0, pct=True):
    tb = fit.tidy()
    out = {}
    for n in names:
        if n not in tb.index:
            continue
        b, se, p = tb.loc[n, "Estimate"], tb.loc[n, "Std. Error"], tb.loc[n, "Pr(>|t|)"]
        f = (lambda x: 100 * (np.exp(x * scale) - 1)) if pct else (lambda x: x * scale)
        out[n] = {"est": float(f(b)), "lo": float(f(b - 1.96 * se)), "hi": float(f(b + 1.96 * se)), "p": float(p)}
    return out


def trust_delays() -> dict:
    import pyfixest as pf
    ls = pd.read_csv(OUT / "longstay_monthly_panel.csv", parse_dates=["month"])
    td = pd.read_csv(OUT / "trust_delay_reasons_monthly.csv", parse_dates=["month"]).rename(columns=GROUPS)
    d = ls.merge(td, on=["org", "month"], how="inner")
    d = d[(d.ga_available > 100) & (d.emergency_admissions > 500)].copy()
    for k in GROUPS.values():
        d[k] = 100 * d[k] / d.ga_available          # delayed patients per 100 G&A beds
    d["all_delays"] = d[list(GROUPS.values())].sum(axis=1)
    d["log_adm"] = np.log(d.emergency_admissions)
    d["mkey"] = d.month.dt.strftime("%Y-%m")
    keys = ["sc", "ch", "hp", "jt"]
    res = {"n": int(len(d)), "trusts": int(d.org.nunique()), "months": [d.mkey.min(), d.mkey.max()],
           "meanPer100": {k: float(d[k].mean()) for k in keys + ["pf", "ho", "all_delays"]}}
    rhs = " + ".join(keys + ["pf", "ho"])
    m1 = pf.fepois(f"waits12 ~ occ_pts + {rhs} | org + mkey", data=d, offset="log_adm", vcov={"CRV1": "org"})
    m2 = pf.fepois(f"waits12 ~ {rhs} | org + mkey", data=d, offset="log_adm", vcov={"CRV1": "org"})
    m3 = pf.feols(f"occ_pts ~ {rhs} | org + mkey", data=d, vcov={"CRV1": "org"})
    res["withinBeyondOcc"] = coefs(m1, keys + ["occ_pts"])          # % change in 12-hour waits per extra delayed patient per 100 beds
    res["withinTotal"] = coefs(m2, keys)
    res["withinOcc"] = coefs(m3, keys, pct=False)                      # occupancy points per extra delayed patient per 100 beds
    # between trusts: averages over the period
    g = d.groupby("org").agg(waits12=("waits12", "sum"), adm=("emergency_admissions", "sum"), occ_pts=("occ_pts", "mean"),
                             **{k: (k, "mean") for k in keys + ["pf", "ho"]}).reset_index()
    g["log_adm"] = np.log(g.adm)
    b1 = pf.fepois(f"waits12 ~ occ_pts + {rhs}", data=g, offset="log_adm", vcov="hetero")
    b2 = pf.fepois(f"waits12 ~ {rhs}", data=g, offset="log_adm", vcov="hetero")
    res["betweenBeyondOcc"] = coefs(b1, keys + ["occ_pts"])
    res["betweenTotal"] = coefs(b2, keys)
    res["sdBetween"] = {k: float(g[k].std()) for k in keys}
    for k, v in res["withinBeyondOcc"].items():
        print(f"  within, beyond occupancy  {k}: {v['est']:+.1f}% ({v['lo']:+.1f} to {v['hi']:+.1f}), p={v['p']:.3f}")
    for k, v in res["withinTotal"].items():
        print(f"  within, total             {k}: {v['est']:+.1f}% ({v['lo']:+.1f} to {v['hi']:+.1f}), p={v['p']:.3f}")
    for k, v in res["betweenBeyondOcc"].items():
        print(f"  between, beyond occupancy {k}: {v['est']:+.1f}% ({v['lo']:+.1f} to {v['hi']:+.1f}), p={v['p']:.3f}")
    for k, v in res["withinOcc"].items():
        print(f"  occupancy points per delayed patient per 100 beds {k}: {v['est']:+.2f} ({v['lo']:+.2f} to {v['hi']:+.2f})")
    return res


def ft_series(iid: int, at: int, age: str | None = None) -> pd.DataFrame:
    """One Fingertips indicator for one area type: area, year (start year of the period), value."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from effects_analysis import start_year
    f = sorted(glob.glob(str(RAW / "fingertips" / f"*__{iid}__at{at}.csv")))
    if not f:
        return pd.DataFrame()
    d = pd.read_csv(f[0], low_memory=False)
    d = d[(d["Area Type"] != "England") & d["Category Type"].isna() & (d["Sex"].isin(["Persons", "Not applicable"]) | d["Sex"].isna())]
    if age is None and len(d):
        age = d["Age"].mode().iloc[0]
    d = d[d["Age"] == age]
    out = pd.DataFrame({"area": d["Area Code"], "name": d["Area Name"], "year": d["Time period"].astype(str).map(start_year),
                        "value": pd.to_numeric(d["Value"], errors="coerce")}).dropna(subset=["value", "year"])
    return out.groupby(["area", "year"], as_index=False).agg(value=("value", "mean"), name=("name", "first"))


def ols_rows(d: pd.DataFrame, outcome: str, exposure: str, fe: bool, controls: list[str] | None = None, label: str = "") -> dict | None:
    import statsmodels.formula.api as smf
    controls = controls or []
    d = d.dropna(subset=[outcome, exposure, *controls])
    d = d[d[outcome] > 0].copy()
    if d.area.nunique() < 15:
        return None
    d["y"] = np.log(d[outcome])
    if fe:
        m = smf.ols(f"y ~ {exposure} + C(area) + C(year)", data=d).fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(d.area)[0]})
    else:
        g = d.groupby("area")[["y", exposure, *controls]].mean().reset_index()
        m = smf.ols("y ~ " + " + ".join([exposure, *controls]), data=g).fit(cov_type="HC1")
    b, se = m.params[exposure], m.bse[exposure]
    return {"outcome": outcome, "exposure": exposure, "design": "within areas (area and year fixed effects)" if fe else
            ("between areas" + (" (adjusted for " + ", ".join(controls) + ")" if controls else "")), "label": label,
            "pct": float(100 * (np.exp(b) - 1)), "lo": float(100 * (np.exp(b - 1.96 * se) - 1)), "hi": float(100 * (np.exp(b + 1.96 * se) - 1)),
            "p": float(m.pvalues[exposure]), "n": int(m.nobs), "areas": int(d.area.nunique()),
            "years": f"{int(d.year.min())}-{int(d.year.max())}", "sdExposure": float(d.groupby("area")[exposure].mean().std())}


def area_gp() -> dict | None:
    """NHS sub-ICB areas: patients' experience of their GP practice (GP patient survey, % positive) against emergency
    admissions for COPD and asthma (directly standardised rates), the two primary-care-sensitive conditions
    published for the same areas. Survey year matched to the financial year starting in it."""
    exp = ft_series(93438, 66)
    outs = {"copd": ft_series(93577, 66), "asthma": ft_series(93573, 66)}
    if exp.empty:
        return None
    rows = []
    for k, o in outs.items():
        if o.empty:
            continue
        d = exp.rename(columns={"value": "gp_positive"})[["area", "year", "gp_positive"]].merge(
            o.rename(columns={"value": k})[["area", "year", k]], on=["area", "year"], how="inner")
        for fe in (False, True):
            r = ols_rows(d, k, "gp_positive", fe, label=f"{k} admissions per point of GP experience")
            if r:
                rows.append(r)
                print(f"  {k:7s} ~ GP experience, {r['design'][:14]}: {r['pct']:+.2f}% per point ({r['lo']:+.2f} to {r['hi']:+.2f}), "
                      f"p={r['p']:.3f}, {r['areas']} areas {r['years']}")
    g = exp.groupby("year").value.mean()
    return {"rows": rows, "gpPositiveByYear": {str(int(k)): float(v) for k, v in g.items()}}


def area_social() -> dict | None:
    """Councils: adult social care spending per adult (ASC-FR T16, 2017/18-2018/19) and care home beds per 100 people
    aged 75+ (CQC via Fingertips) against delayed transfers of care attributable to social care per 100,000 adults
    (ASCOF 2C, 2016/17-2018/19; social care plus jointly attributed delays)."""
    rows = []
    for f in sorted(glob.glob(str(RAW / "dtoc" / "ASCOF-indicators-*.xls"))):
        yr = int(re.search(r"(20\d\d)-\d\d", f).group(1))
        x = pd.ExcelFile(f)
        parts = {}
        for sh in x.sheet_names:
            d = pd.read_excel(f, sheet_name=sh, header=None)
            title = next((str(v) for v in d.iloc[:4].values.ravel() if "per 100,000" in str(v)), "")
            hi = next(i for i in range(20) if d.iloc[i].astype(str).str.contains("Org code").any())
            cc = [str(v) for v in d.iloc[hi]]
            ccode = next(j for j, v in enumerate(cc) if "Org code" in v)
            body = d.iloc[hi + 1:]
            body = body[body.iloc[:, ccode].astype(str).str.match(r"^\d{3}$")]
            num = body.iloc[:, ccode + 2].astype(float)
            pop = body.iloc[:, ccode + 3].astype(float)
            kind = "all" if "All delays" in title else ("both" if re.search(r"(?i)both nhs", title) else
                                                        ("sc_both" if re.search(r"(?i)social care and both", title) else "sc"))
            parts[kind] = pd.DataFrame({"la": body.iloc[:, ccode].astype(str).values, "n": num.values, "pop": pop.values})
        sc = parts.get("sc_both")
        if sc is None and "sc" in parts:
            sc = parts["sc"].merge(parts.get("both", parts["sc"].assign(n=0))[["la", "n"]], on="la", suffixes=("", "_b"))
            sc["n"] = sc.n + sc.n_b
        if sc is None:
            continue
        sc = sc.merge(parts["all"][["la", "n"]].rename(columns={"n": "n_all"}), on="la", how="left")
        rows.append(sc.assign(year=yr, dtoc_sc=100000 * sc.n / sc["pop"], dtoc_all=100000 * sc.n_all / sc["pop"]))
    if not rows:
        return None
    dt = pd.concat(rows)
    t = pd.read_excel(RAW / "asc_finance_mirror" / "ASCFR_and_SALT_Reference_Tables_2018-19.xlsx", sheet_name="T16", header=None)
    t = t[t[0].astype(str).str.match(r"^E\d{8}$")]
    sp = pd.concat([pd.DataFrame({"area": t[0].values, "la": t[1].astype(str).str.zfill(3).values, "year": 2017,
                                  "spend": pd.to_numeric(t[5], errors="coerce").values}),
                    pd.DataFrame({"area": t[0].values, "la": t[1].astype(str).str.zfill(3).values, "year": 2018,
                                  "spend": pd.to_numeric(t[8], errors="coerce").values})])
    sp["spend"] = sp.spend / 100                  # GBP thousands per 100,000 adults -> GBP per adult x 10 -> keep as GBP per 10 adults
    sp["spend"] = sp.spend * 10 / 1000            # = GBP hundreds per adult: one unit is GBP 100 per adult a year
    code = sp.drop_duplicates("la")[["la", "area"]]
    dt = dt.merge(code, on="la", how="inner")
    ch = ft_series(92489, 502).rename(columns={"value": "care_home_beds"})[["area", "year", "care_home_beds"]]
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from effects_analysis import deprivation_by_area
    d = dt.merge(sp[["area", "year", "spend"]], on=["area", "year"], how="left").merge(ch, on=["area", "year"], how="left") \
          .merge(deprivation_by_area(), on="area", how="left")
    out = []
    for exp, lab in (("spend", "per GBP 100 more social care spending per adult a year"), ("care_home_beds", "per extra care home bed per 100 people aged 75+")):
        for fe in (False, True):
            for o in ("dtoc_sc", "dtoc_all"):
                r = ols_rows(d[d.year >= 2016], o, exp, fe, controls=[] if fe else ["imd"], label=lab)
                if r:
                    out.append(r)
                    print(f"  {o:8s} ~ {exp:14s} {r['design'][:14]}: {r['pct']:+.1f}% {lab} ({r['lo']:+.1f} to {r['hi']:+.1f}), p={r['p']:.3f}, "
                          f"{r['areas']} councils {r['years']}")
    return {"rows": out, "meanSpendPerAdult": float(100 * d.spend.mean()), "meanCareHomeBeds": float(d.care_home_beds.mean())}


def main() -> int:
    out = {"generated": pd.Timestamp.now().strftime("%Y-%m-%d")}
    print("[trust delays]")
    out["trustDelays"] = trust_delays()
    print("[GP access and admissions, councils]")
    out["areaGp"] = area_gp()
    print("[social care spending and capacity, councils]")
    out["areaSocial"] = area_social()
    (WEB / "hypotheses_tests.json").write_text(json.dumps(out, indent=1))
    print("wrote web/data/hypotheses_tests.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
