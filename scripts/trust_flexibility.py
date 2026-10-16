"""Trust-level test of the post-pandemic break between occupancy and long waits.

Builds a panel of acute trusts x financial years (three before the pandemic, three after) with each trust's
G&A occupancy (KH03, quarterly, averaged over the year) and its emergency admissions and patients waiting more
than 12 hours from decision to admit (A&E quarterly by provider). Then asks: at the same occupancy, did long
waits rise more after the pandemic in trusts with particular characteristics?

    log E[waits_it] = trust_i + year_t + b * occupancy_it + c * post_t * occupancy_it + sum_k d_k * post_t * Z_ik
                      + log(emergency admissions_it)

Poisson regression with trust and year fixed effects, standard errors clustered by trust. The trust effects
absorb anything fixed about a trust; the year effects absorb the national shift. d_k > 0 means trusts with more
of Z saw a bigger rise in long waits than other trusts at the same occupancy.

Characteristics Z (measured before or independently of the outcome where possible):
  beds         size of the trust (pre-pandemic mean G&A beds, log): pooling theory says bigger is more resilient
  single_rooms share of beds in single rooms (ERIC): infection-control rules bite harder where bays dominate
  long_stay    share of G&A beds occupied by patients in hospital 21+ days, 2025/26 (sitrep): the delays explanation

Writes data/processed/trust_flexibility_panel.csv and web/data/trust_flexibility.json.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"
PRE, POST = ["2017/18", "2018/19", "2019/20"], ["2022/23", "2023/24", "2025/26"]
YEARS = PRE + POST


def fy_from_text(s: str) -> str | None:
    m = re.search(r"(20\d\d)[-_ ]?(\d\d)(?!\d)", s)
    if m and int(m.group(2)) == (int(m.group(1)) + 1) % 100:
        return f"{m.group(1)}/{m.group(2)}"
    m = re.search(r"(?<!\d)(\d\d)(\d\d)-Q", s)  # e.g. 1920-Q1
    if m and int(m.group(2)) == int(m.group(1)) + 1:
        return f"20{m.group(1)}/{m.group(2)}"
    return None


def read_excel_any(f: Path, sheet: str) -> pd.DataFrame:
    try:
        return pd.read_excel(f, sheet_name=sheet, header=None)
    except Exception:  # noqa: BLE001  some .xls files need converting first
        tmp = Path(tempfile.mkdtemp())
        subprocess.run(["soffice", "--headless", "--convert-to", "xlsx", "--outdir", str(tmp), str(f)],
                       check=True, capture_output=True, timeout=180)
        return pd.read_excel(next(tmp.glob("*.xlsx")), sheet_name=sheet, header=None)


# ------------------------------------------------------------------ KH03 by trust, quarterly
def kh03_trusts() -> pd.DataFrame:
    rows = []
    for f in sorted((RAW / "kh03_overnight").glob("*.xls*")):
        if not re.search(r"(Beds-Open-Overnight|NHS-organisations-in-England-Quarter)", f.name):
            continue
        try:
            sheets = pd.ExcelFile(f).sheet_names
        except Exception:  # noqa: BLE001
            continue
        sh = next((s for s in sheets if "Trust by Sector" in s or "Trust" in s), None)
        if sh is None:
            continue
        d = read_excel_any(f, sh)
        hdr = d.index[d.apply(lambda r: r.map(lambda v: str(v).strip()).eq("Org Code").any(), axis=1)]
        if not len(hdr):
            continue
        h = d.iloc[hdr[0]].map(lambda v: str(v).strip())
        ga = [i for i, v in enumerate(h) if v.startswith("General & Acute")]
        code = int(np.where(h == "Org Code")[0][0])
        ycol = int(np.where(h == "Year")[0][0]) if (h == "Year").any() else None
        if len(ga) < 2:
            continue
        body = d.iloc[hdr[0] + 1:]
        body = body[body[code].astype(str).str.match(r"^[A-Z0-9]{3,5}$") & (body[code].astype(str) != "England")]
        fy = None
        if ycol is not None:
            y = body[ycol].dropna().astype(str)
            fy = fy_from_text(y.iloc[0]) if len(y) else None
        fy = fy or fy_from_text(f.name)
        if fy not in YEARS:
            continue
        q = re.search(r"Q([1-4])|Quarter-([1-4])", f.name)
        rows.append(pd.DataFrame({"fy": fy, "quarter": (q.group(1) or q.group(2)) if q else f.name,
                                  "org": body[code].astype(str).str.strip(),
                                  "ga_available": pd.to_numeric(body[ga[0]], errors="coerce"),
                                  "ga_occupied": pd.to_numeric(body[ga[1]], errors="coerce")}))
    k = pd.concat(rows).dropna()
    k = k.drop_duplicates(["fy", "quarter", "org"], keep="last")
    return k.groupby(["org", "fy"]).agg(quarters=("quarter", "nunique"), ga_available=("ga_available", "mean"),
                                        ga_occupied=("ga_occupied", "mean")).reset_index()


# ------------------------------------------------------------------ A&E by provider, quarterly
def ae_trusts() -> pd.DataFrame:
    rows = []
    for f in sorted((RAW / "ae_attendances").glob("*.xls*")):
        if not re.search(r"(?i)quarter", f.name) or "Time-Series" in f.name:
            continue
        fy = fy_from_text(f.name.replace("2025-2026", "2025-26"))
        if fy not in YEARS:
            continue
        d = read_excel_any(f, "Provider Level Data")
        hdr = d.index[d.apply(lambda r: r.map(lambda v: str(v).strip()).eq("Code").any(), axis=1)][0]
        h = d.iloc[hdr].map(lambda v: str(v).strip())
        col = lambda pat: int(next(i for i, v in enumerate(h) if re.search(pat, v)))  # noqa: E731
        body = d.iloc[hdr + 1:]
        body = body[body[col(r"^Code$")].astype(str).str.match(r"^[A-Z0-9]{3,5}$")]
        q = re.search(r"Quarter-(\d|One|Two|Three|Four)", f.name)
        rows.append(pd.DataFrame({"fy": fy, "quarter": q.group(1) if q else f.name,
                                  "org": body[col(r"^Code$")].astype(str).str.strip(),
                                  "emergency_admissions": pd.to_numeric(body[col(r"^Total Emergency Admissions$")], errors="coerce"),
                                  "waits12": pd.to_numeric(body[col(r">\s?12 hours")], errors="coerce")}))
    a = pd.concat(rows).dropna()
    a = a.drop_duplicates(["fy", "quarter", "org"], keep="last")
    return a.groupby(["org", "fy"]).agg(ae_quarters=("quarter", "nunique"), emergency_admissions=("emergency_admissions", "sum"),
                                        waits12=("waits12", "sum")).reset_index()


# ------------------------------------------------------------------ ERIC single rooms (if fetched)
def eric_single_rooms() -> pd.DataFrame | None:
    files = sorted((RAW / "eric").glob("*.csv")) + sorted((RAW / "eric_pages").glob("*.csv")) if (RAW / "eric").exists() or (RAW / "eric_pages").exists() else []
    best = None
    for f in files:
        try:
            d = pd.read_csv(f, encoding="latin1", low_memory=False)
        except Exception:  # noqa: BLE001
            continue
        cols = {c: c.lower() for c in d.columns}
        single = [c for c, l in cols.items() if "single bedroom" in l and "(no" in l]
        org = next((c for c, l in cols.items() if l.strip() in ("trust code", "organisation code", "trust code ")), None)
        if not single or org is None:
            continue
        yr = fy_from_text(f.name) or "?"
        g = d.assign(single=d[single].apply(pd.to_numeric, errors="coerce").sum(axis=1)).groupby(org).single.sum()
        cand = pd.DataFrame({"org": g.index.astype(str).str.strip(), "single_rooms": g.values, "eric_year": yr, "eric_file": f.name})
        if best is None or yr > best.eric_year.iloc[0]:
            best = cand
    return best


def main() -> None:
    k, a = kh03_trusts(), ae_trusts()
    p = k.merge(a, on=["org", "fy"], how="inner")
    p = p[(p.quarters >= 3) & (p.ae_quarters >= 3)]
    p["scale"] = 4 / p.ae_quarters
    p["emergency_admissions"] *= p.scale
    p["waits12"] *= p.scale
    p["occupancy"] = p.ga_occupied / p.ga_available
    p = p[(p.ga_available > 150) & (p.emergency_admissions > 10000) & p.occupancy.between(0.5, 1.05)]
    # balanced enough: trusts with at least two years in each period
    n = p.groupby("org").fy.agg(lambda s: (s.isin(PRE).sum(), s.isin(POST).sum()))
    keep = n[n.map(lambda t: t[0] >= 2 and t[1] >= 2)].index
    p = p[p.org.isin(keep)].copy()
    p["post"] = p.fy.isin(POST).astype(int)

    # trust characteristics
    pre = p[p.post == 0].groupby("org").ga_available.mean()
    z = pd.DataFrame({"org": pre.index, "beds_pre": pre.values})
    tp = OUT / "trust_panel_2025_26.csv"
    if tp.exists():
        t = pd.read_csv(tp)
        z = z.merge(t.assign(long_stay=t.los_21plus / t.ga_occupied)[["org", "long_stay"]], on="org", how="left")
    er = eric_single_rooms()
    if er is not None:
        z = z.merge(er, on="org", how="left")
        z["single_rooms_share"] = z.single_rooms / z.beds_pre
    p = p.merge(z, on="org", how="left")
    p.to_csv(OUT / "trust_flexibility_panel.csv", index=False)

    std = lambda s: (s - s.mean()) / s.std()  # noqa: E731
    p["occ_pts"] = 100 * (p.occupancy - p.occupancy.mean())
    p["log_beds_z"] = std(np.log(p.beds_pre))
    terms = ["log_beds_z"]
    if "long_stay" in p and p.long_stay.notna().sum() > 50:
        p["long_stay_z"] = std(p.long_stay)
        terms.append("long_stay_z")
    if "single_rooms_share" in p and p.single_rooms_share.notna().sum() > 50:
        p["single_rooms_z"] = std(p.single_rooms_share.clip(upper=p.single_rooms_share.quantile(0.99)))
        terms.append("single_rooms_z")

    results = {}
    def fit(name, extra, data=None, ols=False):
        d = (p if data is None else data).dropna(subset=["waits12", "emergency_admissions", "occ_pts", *extra]).copy()
        f = "C(org) + C(fy) + occ_pts + post:occ_pts" + "".join(f" + post:{t}" for t in extra)
        if ols:  # robustness: log rate with a small continuity correction
            d["log_rate"] = np.log((d.waits12 + 0.5) / d.emergency_admissions)
            m = smf.ols("log_rate ~ " + f, data=d).fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(d.org)[0]})
        else:
            m = smf.glm("waits12 ~ " + f, data=d, family=sm.families.Poisson(), offset=np.log(d.emergency_admissions)).fit(
                cov_type="cluster", cov_kwds={"groups": pd.factorize(d.org)[0]}, maxiter=200)
        keys = ["occ_pts", "post:occ_pts", *[f"post:{t}" for t in extra]]
        res = {kk: dict(coef=float(m.params[kk]), se=float(m.bse[kk]), p=float(m.pvalues[kk]),
                        pct=float(100 * (np.exp(m.params[kk]) - 1)),
                        lo=float(100 * (np.exp(m.params[kk] - 1.96 * m.bse[kk]) - 1)),
                        hi=float(100 * (np.exp(m.params[kk] + 1.96 * m.bse[kk]) - 1))) for kk in keys}
        yfe = {fy: float(100 * (np.exp(m.params.get(f"C(fy)[T.{fy}]", 0.0)) - 1)) for fy in YEARS}
        results[name] = dict(n_obs=int(m.nobs), n_trusts=int(d.org.nunique()), terms=res, year_effects=yfe)
        print(f"\n== {name}: {int(m.nobs)} trust-years, {d.org.nunique()} trusts")
        for kk, r in res.items():
            print(f"  {kk:22s} {r['pct']:+7.1f}% per unit  (95% CI {r['lo']:+.1f} to {r['hi']:+.1f}; p={r['p']:.3f})")

    fit("each characteristic alone: size", ["log_beds_z"])
    if "long_stay_z" in terms:
        fit("each characteristic alone: long stays", ["long_stay_z"])
    if "single_rooms_z" in terms:
        fit("each characteristic alone: single rooms", ["single_rooms_z"])
    fit("all together", terms)
    # robustness
    fit("robustness: log-rate least squares", terms, ols=True)
    big = p.groupby("org").waits12.sum().nlargest(10).index
    fit("robustness: without the 10 trusts with most long waits", terms, data=p[~p.org.isin(big)])
    # placebo: a fake "pandemic" inside the pre-pandemic years (2019/20 vs 2017/18); a real pre-trend would show here
    pl = p[p.fy.isin(["2017/18", "2019/20"])].copy()
    pl["post"] = (pl.fy == "2019/20").astype(int)
    fit("placebo: 2019/20 vs 2017/18 (no pandemic)", terms, data=pl)

    # descriptive: national pre/post at similar occupancy
    desc = p.groupby("post").apply(lambda g: pd.Series({"trust_years": len(g), "occupancy": g.ga_occupied.sum() / g.ga_available.sum(),
                                                         "wait12_share": g.waits12.sum() / g.emergency_admissions.sum()})).to_dict()
    out = dict(pre=PRE, post=POST, n_trusts=int(p.org.nunique()), n_trust_years=int(len(p)), descriptive=desc, models=results,
               characteristics=dict(log_beds_z="log of pre-pandemic G&A beds, standardised",
                                    long_stay_z="share of G&A beds occupied by patients in hospital 21+ days (2025/26), standardised",
                                    single_rooms_z="single bedrooms (ERIC) per pre-pandemic G&A bed, standardised"),
               eric=None if er is None else dict(year=str(er.eric_year.iloc[0]), file=str(er.eric_file.iloc[0])),
               trusts=p[["org", "fy", "occupancy", "waits12", "emergency_admissions", "post"]].assign(
                   wait12_share=lambda x: x.waits12 / x.emergency_admissions).round(5).to_dict(orient="records"))
    (WEB / "trust_flexibility.json").write_text(json.dumps(out, default=float))
    print("\nwrote web/data/trust_flexibility.json")


if __name__ == "__main__":
    sys.exit(main())
