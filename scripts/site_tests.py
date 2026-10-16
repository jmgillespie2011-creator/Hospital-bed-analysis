"""Test 4: split sites. A trust spread over several hospital sites has smaller natural bed pools than one with the
same beds on one site, because patients are rarely moved between sites. If lost flexibility is what changed, trusts
with more hospital sites (for their size) should have seen bigger rises in 12-hour waits at the same occupancy.

Sites: ODS NHS trust sites file (ets), active sites whose name marks an inpatient hospital (HOSPITAL / INFIRMARY,
excluding clinics, health centres and the like). Panel and model as scripts/trust_flexibility.py: trust-years before
(2017/18-2019/20) and after (2022/23, 2023/24, 2025/26), Poisson with trust and year fixed effects.
Writes web/data/site_tests.json.  Usage: python scripts/site_tests.py
"""
from __future__ import annotations

import io
import json
import re
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"
HOSP = re.compile(r"(?i)\b(HOSPITAL|INFIRMARY)\b")
NOT_INPATIENT = re.compile(r"(?i)(CLINIC|HEALTH CENTRE|SURGERY|MEDICAL CENTRE|OFFICE|HQ|HEADQUARTERS|PHARMACY|LABORATORY|"
                           r"DAY HOSPITAL|DAY UNIT|ADMIN|RESOURCE CENTRE|CHILD DEVELOPMENT|DENTAL|MOBILE|SATELLITE|VIRTUAL|HOME)")


def read_ets() -> pd.DataFrame:
    f = next((p for p in (RAW / "ods_sites").glob("*") if re.search(r"(?i)ets", p.name) and p.suffix in (".zip", ".csv")), None)
    if f is None:
        raise SystemExit("ODS ets file not found in data/raw/ods_sites")
    if f.suffix == ".zip":
        z = zipfile.ZipFile(f)
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        raw = z.read(name)
    else:
        raw = f.read_bytes()
    d = pd.read_csv(io.BytesIO(raw), header=None, dtype=str, encoding="latin1")
    d = d.rename(columns={0: "site", 1: "name", 10: "open", 11: "close"})
    d["org"] = d.site.str[:3]
    return d


def main() -> int:
    import pyfixest as pf
    e = read_ets()
    active = e[e.close.isna() | (e.close.astype(str).str.strip() == "")]
    hosp = active[active.name.str.contains(HOSP) & ~active.name.str.contains(NOT_INPATIENT)]
    sites = hosp.groupby("org").size().rename("sites").reset_index()
    p = pd.read_csv(OUT / "trust_flexibility_panel.csv")
    z = p.groupby("org").agg(beds_pre=("beds_pre", "first"), long_stay=("long_stay", "first")).reset_index().merge(sites, on="org", how="left")
    z["sites"] = z.sites.fillna(1).clip(lower=1)
    z["beds_per_site"] = z.beds_pre / z.sites
    for c, v in (("log_beds_z", np.log(z.beds_pre)), ("sites_z", np.log(z.sites)), ("long_stay_z", z.long_stay),
                 ("beds_per_site_z", np.log(z.beds_per_site))):
        z[c] = (v - v.mean()) / v.std()
    q = p.drop(columns=[c for c in ("long_stay",) if c in p.columns]).merge(z, on="org").dropna(subset=["long_stay_z"])
    q["occ_pts"] = 100 * q.occupancy
    q["_off"] = np.log(q.emergency_admissions)
    for c in ("log_beds_z", "sites_z", "long_stay_z", "beds_per_site_z"):
        q[f"post_{c}"] = q.post * q[c]
    out = {"n_trusts": int(q.org.nunique()), "sites": {"median": float(z.sites.median()), "mean": float(z.sites.mean()),
           "share_multi_site": float((z.sites > 1).mean()), "max": int(z.sites.max())}, "models": {}}
    specs = {"sites alone": "post_sites_z", "sites and size": "post_sites_z + post_log_beds_z",
             "beds per site": "post_beds_per_site_z", "with long stays": "post_sites_z + post_log_beds_z + post_long_stay_z"}
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
