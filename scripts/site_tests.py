"""Test 4: split sites. A trust spread over several acute hospital sites has smaller natural bed pools than one with
the same beds on one site, because patients are rarely moved between sites. If lost flexibility is what changed,
trusts with more acute sites (for their size) should have seen bigger rises in 12-hour waits at the same occupancy.
The same estates data also give single bedrooms, which make beds easier to use for any patient (no same-sex bays,
easier isolation), so trusts with more single rooms per bed should have lost less.

Sites and rooms: ERIC 2018/19 site data (before the pandemic), general acute and mixed-service hospital sites, single
bedrooms with and without en-suite. Panel and model as scripts/trust_flexibility.py: trust-years before
(2017/18-2019/20) and after (2022/23, 2023/24, 2025/26), Poisson with trust and year fixed effects.
Writes web/data/site_tests.json.  Usage: python scripts/site_tests.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"


def eric_sites() -> pd.DataFrame:
    f = next((RAW / "eric_mirror").glob("ERIC*201819*Site*.csv"))
    d = pd.read_csv(f, encoding="latin1", low_memory=False)
    acute = d[d["Site Type"].astype(str).str.contains(r"General acute hospital|Mixed service hospital", regex=True)]
    num = lambda c: pd.to_numeric(acute[c].astype(str).str.replace(",", ""), errors="coerce").fillna(0)  # noqa: E731
    acute = acute.assign(single=num("Single bedrooms for patients with en-suite facilities (No.)")
                         + num("Single bedrooms for patients without en-suite facilities (No.)"))
    return acute.groupby("Trust Code").agg(sites=("Site Code", "nunique"), single_rooms=("single", "sum")).reset_index().rename(columns={"Trust Code": "org"})


def main() -> int:
    import pyfixest as pf
    sites = eric_sites()
    p = pd.read_csv(OUT / "trust_flexibility_panel.csv")
    z = p.groupby("org").agg(beds_pre=("beds_pre", "first"), long_stay=("long_stay", "first")).reset_index().merge(sites, on="org", how="left")
    z = z.dropna(subset=["sites"])
    z["beds_per_site"] = z.beds_pre / z.sites
    z["single_per_bed"] = z.single_rooms / z.beds_pre
    for c, v in (("log_beds_z", np.log(z.beds_pre)), ("sites_z", np.log(z.sites)), ("long_stay_z", z.long_stay),
                 ("beds_per_site_z", np.log(z.beds_per_site)), ("single_z", z.single_per_bed)):
        z[c] = (v - v.mean()) / v.std()
    q = p.drop(columns=[c for c in ("long_stay",) if c in p.columns]).merge(z, on="org").dropna(subset=["long_stay_z"])
    q["occ_pts"] = 100 * q.occupancy
    q["_off"] = np.log(q.emergency_admissions)
    for c in ("log_beds_z", "sites_z", "long_stay_z", "beds_per_site_z", "single_z"):
        q[f"post_{c}"] = q.post * q[c]
    out = {"n_trusts": int(q.org.nunique()), "sites": {"median": float(z.sites.median()), "mean": float(z.sites.mean()),
           "share_multi_site": float((z.sites > 1).mean()), "max": int(z.sites.max()),
           "single_per_bed_median": float(z.single_per_bed.median())}, "models": {}}
    specs = {"sites alone": "post_sites_z", "sites and size": "post_sites_z + post_log_beds_z",
             "beds per site": "post_beds_per_site_z", "with long stays": "post_sites_z + post_log_beds_z + post_long_stay_z",
             "single rooms": "post_single_z + post_log_beds_z", "all together": "post_sites_z + post_log_beds_z + post_single_z + post_long_stay_z"}
    for name, rhs in specs.items():
        m = pf.fepois(f"waits12 ~ occ_pts + {rhs} | org + fy", data=q, vcov={"CRV1": "org"}, offset="_off")
        b, se, pv = m.coef(), m.se(), m.pvalue()
        out["models"][name] = {k: {"pct": 100 * (np.exp(b[k]) - 1), "lo": 100 * (np.exp(b[k] - 1.96 * se[k]) - 1),
                                   "hi": 100 * (np.exp(b[k] + 1.96 * se[k]) - 1), "p": float(pv[k])} for k in b.index if k.startswith("post_")}
        print(name, {k: f"{v['pct']:+.0f}% ({v['lo']:+.0f} to {v['hi']:+.0f}) p={v['p']:.3f}" for k, v in out["models"][name].items()})
    print("sites per trust:", out["sites"])
    (WEB / "site_tests.json").write_text(json.dumps(out, indent=1, default=float))
    print("wrote web/data/site_tests.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
