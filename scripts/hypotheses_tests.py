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


def area_gp() -> dict | None:
    """Councils: GP patient survey experience vs emergency admissions for conditions primary care can manage."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from effects_analysis import deprivation_by_area, fit, load_series
    expo = {"gp_experience": ("gp_experience_positive", 93438, None), "gp_contact": ("gp_contact_good", 94126, None)}
    outc = {"copd": ("copd_admissions", 92302, "35+ yrs"), "asthma": ("asthma_admissions_adults", 93573, None),
            "dementia": ("dementia_admissions", 91281, None), "emergency_all": ("emergency_all_causes", 93227, None)}
    panel = None
    meta = {}
    for var, (key, iid, age) in {**expo, **outc}.items():
        sr = load_series(key, iid, age)
        if sr.empty:
            print(f"  (no council data for {var})")
            continue
        meta[var] = dict(id=iid, name=sr.attrs.get("name"), years=f"{int(sr.year.min())}-{int(sr.year.max())}", areas=int(sr.area.nunique()))
        sr = sr.rename(columns={"value": var})[["area", "year", var]]
        panel = sr if panel is None else panel.merge(sr, on=["area", "year"], how="outer")
    if panel is None or not any(e in panel for e in expo):
        return None
    panel = panel.merge(deprivation_by_area(), on="area", how="left")
    rows = []
    for e in [x for x in expo if x in panel]:
        for o in [x for x in outc if x in panel]:
            for fe in (False, True):
                try:
                    rows += fit(panel, o, [e], fe)
                except Exception as ex:  # noqa: BLE001
                    print(f"  {o} ~ {e} ({'within' if fe else 'between'}): {ex}")
    for r in rows:
        print(f"  {r['outcome']:14s} ~ {r['exposure']:13s} {r['design'][:12]}: {r['pct_per_point']:+.2f}% per point "
              f"({r['ci_low']:+.2f} to {r['ci_high']:+.2f}), p={r['p']:.3f}, n={r['n_obs']}")
    return {"meta": meta, "rows": rows}


def main() -> int:
    out = {"generated": pd.Timestamp.now().strftime("%Y-%m-%d")}
    print("[trust delays]")
    out["trustDelays"] = trust_delays()
    print("[GP access and admissions, councils]")
    out["areaGp"] = area_gp()
    (WEB / "hypotheses_tests.json").write_text(json.dumps(out, indent=1))
    print("wrote web/data/hypotheses_tests.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
