"""Follow-up tests of the long-stay finding (see scripts/trust_flexibility.py).

A. Month by month within trusts (Aug 2023 - Mar 2024 and Apr 2025 onwards, when the bed sitrep reports long stays):
   in months when a trust has more beds held by patients in hospital 21+ days, does it have more 12-hour waits than
   its occupancy that month predicts? Trust and month fixed effects remove anything fixed about a trust and any
   national month-to-month change.
C. Competing explanations on the before/after panel: add region x after, and patients no longer meeting the criteria
   to reside (discharge delays) x after, alongside long stays x after.

Writes web/data/longstay_tests.json.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from build_inputs import _month_from_name  # noqa: E402

RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"
MONTHS = {m: i + 1 for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august",
                                          "september", "october", "november", "december"])}


def sitrep_month(f: Path) -> pd.DataFrame | None:
    x = pd.ExcelFile(f)
    sh = next((s for s in x.sheet_names if "all" in s.lower()), None)
    if sh is None:
        return None
    d = pd.read_excel(f, sheet_name=sh, header=None)
    # the "Period:" cell is more reliable than the file name; it can be text ("January 2026") or a date
    per = None
    for i in range(10):
        row = [v for v in d.iloc[i].tolist() if pd.notna(v)]
        if row and str(row[0]).strip() == "Period:" and len(row) > 1:
            per = row[1]
            break
    if isinstance(per, (pd.Timestamp,)) or hasattr(per, "year"):
        month = pd.Timestamp(per.year, per.month, 1)
    else:
        m = re.match(r"([a-z]+)\s+(\d{4})", str(per).strip().lower())
        if not m or m.group(1) not in MONTHS:
            return None
        month = pd.Timestamp(int(m.group(2)), MONTHS[m.group(1)], 1)
    h = d.iloc[14].map(lambda v: str(v).strip())
    if not h.str.contains("21 or more days").any():
        return None
    col = lambda pat: int(next(i for i, v in enumerate(h) if v.startswith(pat)))  # noqa: E731
    body = d.iloc[15:]
    code_col = next(c for c in range(8) if body[c].astype(str).str.match(r"^[A-Z0-9]{3,5}$").sum() > 50)
    body = body[body[code_col].astype(str).str.match(r"^[A-Z0-9]{3,5}$")]
    num = lambda c: pd.to_numeric(body[c], errors="coerce")  # noqa: E731
    return pd.DataFrame({"month": month, "org": body[code_col].astype(str).str.strip(),
                         "ga_available": num(col("G&A beds available")), "ga_occupied": num(col("G&A beds occupied")),
                         "los21": num(col("21 or more days"))})


def ae_months() -> pd.DataFrame:
    rows = []
    for f in (RAW / "ae_attendances").glob("*.csv"):
        m = _month_from_name(f.name)
        if m is None:
            continue
        d = pd.read_csv(f)
        if "Org Code" not in d.columns:
            continue
        num = lambda c: pd.to_numeric(d[c], errors="coerce").fillna(0)  # noqa: E731
        rows.append(pd.DataFrame({
            "month": m, "org": d["Org Code"].astype(str).str.strip(),
            "emergency_admissions": num("Emergency admissions via A&E - Type 1") + num("Emergency admissions via A&E - Type 2")
            + num("Emergency admissions via A&E - Other A&E department") + num("Other emergency admissions"),
            "waits12": num("Patients who have waited 12+ hrs from DTA to admission")}))
    return pd.concat(rows).drop_duplicates(["month", "org"], keep="last")


def nctr_months() -> pd.DataFrame:
    rows = []
    for f in (RAW / "discharge_acute").glob("*CSV*.csv"):
        d = pd.read_csv(f, encoding="latin1", low_memory=False)
        d.columns = [c.replace("ï»¿", "").strip() for c in d.columns]
        if not {"Metric", "Period", "Org Code", "Value", "Level"} <= set(d.columns):
            continue  # older layout
        d = d[d.Metric.astype(str).str.startswith("Number of patients who no longer meet")]
        d = d[~d["Org Code"].isin(["ENG"]) & (d.Level != "Region") & (d.Level != "National")]
        dt = pd.to_datetime(d.Period, format="%d/%m/%Y", errors="coerce")
        g = d.assign(month=dt.dt.to_period("M").dt.to_timestamp(), v=pd.to_numeric(d.Value, errors="coerce")).groupby(["month", "Org Code"]).v.mean()
        rows.append(g.reset_index().rename(columns={"Org Code": "org", "v": "nctr"}))
    return pd.concat(rows).drop_duplicates(["month", "org"], keep="last") if rows else pd.DataFrame(columns=["month", "org", "nctr"])


def winter_pre() -> pd.DataFrame:
    """Winter (Dec-Mar) mean share of occupied G&A beds held by patients in hospital over 21 days, by trust,
    2017/18-2019/20, from the winter daily sitrep time series."""
    rows = []
    for f, fy in [("Winter-data-Timeseries-20180304.xlsx", "2017/18"), ("Winter-data-timeseries-20190307.xlsx", "2018/19"),
                  ("Winter-SitRep-Acute-Time-series-2-December-2019-1-March-2020.xlsx", "2019/20")]:
        path = RAW / "winter_sitreps_pre" / f
        if not path.exists():
            continue
        out = {}
        for sheet, pat, key in [("Beds Occ by long stay patients", "> 21 days", "los21"), ("G&A beds", "Total beds occ", "occupied")]:
            d = pd.read_excel(path, sheet_name=sheet, header=None)
            h = d.iloc[14].map(lambda v: str(v).strip())
            cols = [i for i, v in enumerate(h) if v.startswith(pat)]
            cc = int(next(i for i, v in enumerate(h) if v == "Code"))
            body = d.iloc[15:]
            body = body[body[cc].astype(str).str.match(r"^[A-Z0-9]{3,5}$")]
            vals = body[cols].apply(pd.to_numeric, errors="coerce")
            out[key] = pd.Series(vals.mean(axis=1).values, index=body[cc].astype(str).str.strip())
        df = pd.DataFrame(out).dropna()
        df = df[df.occupied > 150]
        rows.append(pd.DataFrame({"org": df.index, "fy": fy, "ls_share": (df.los21 / df.occupied).values}))
    return pd.concat(rows) if rows else pd.DataFrame(columns=["org", "fy", "ls_share"])


def poisson(f, d, cluster="org"):
    return smf.glm(f, data=d, family=sm.families.Poisson(), offset=np.log(d.emergency_admissions)).fit(
        cov_type="cluster", cov_kwds={"groups": pd.factorize(d[cluster])[0]}, maxiter=300)


def summarise(m, keys, unit):
    out = {}
    for k in keys:
        b, se = m.params[k], m.bse[k]
        out[k] = dict(pct=float(100 * (np.exp(b) - 1)), lo=float(100 * (np.exp(b - 1.96 * se) - 1)),
                      hi=float(100 * (np.exp(b + 1.96 * se) - 1)), p=float(m.pvalues[k]), unit=unit.get(k, ""))
        print(f"   {k:26s} {out[k]['pct']:+6.1f}% per {out[k]['unit']:<28s} (95% CI {out[k]['lo']:+.1f} to {out[k]['hi']:+.1f}; p={out[k]['p']:.3f})")
    return out


def main() -> None:
    res = {}
    # ---------------------------------------------------------------- A: monthly within-trust panel
    sr = [x for f in sorted((RAW / "ga_sitreps").glob("20*.xlsx")) if (x := sitrep_month(f)) is not None]
    sr = pd.concat(sr).drop_duplicates(["month", "org"], keep="last")
    m = sr.merge(ae_months(), on=["month", "org"]).merge(nctr_months(), on=["month", "org"], how="left")
    m = m[(m.ga_available > 150) & (m.emergency_admissions > 800)].dropna(subset=["ga_occupied", "los21"])
    m["occ_pts"] = 100 * m.ga_occupied / m.ga_available
    m["ls_pts"] = 100 * m.los21 / m.ga_occupied
    m["nctr_pts"] = 100 * m.nctr / m.ga_occupied
    m = m[m.occ_pts.between(50, 105) & m.ls_pts.between(0, 60)]
    m["occ_c"], m["ls_c"] = m.occ_pts - m.occ_pts.mean(), m.ls_pts - m.ls_pts.mean()
    m.to_csv(OUT / "longstay_monthly_panel.csv", index=False)
    print(f"A. monthly panel: {len(m)} trust-months, {m.org.nunique()} trusts, {m.month.nunique()} months "
          f"({m.month.min():%b %Y} to {m.month.max():%b %Y}); within-trust SD of long-stay share "
          f"{m.groupby('org').ls_pts.transform(lambda s: s - s.mean()).std():.2f} pts")
    U = {"occ_c": "point of occupancy", "ls_c": "point of long-stay share", "nctr_pts": "point of beds held by patients fit to leave",
         "occ_c:ls_c": "point x point (interaction)"}
    fe = "waits12 ~ C(org) + C(month) + occ_c + ls_c"
    print(" A1 Poisson, trust and month fixed effects:")
    res["A1"] = dict(label="Long-stay share and occupancy, within trusts", n=int(len(m)), trusts=int(m.org.nunique()),
                     terms=summarise(poisson(fe, m), ["occ_c", "ls_c"], U))
    print(" A2 adding the interaction (do long stays matter more when the trust is fuller?):")
    res["A2"] = dict(label="With occupancy x long-stay interaction", n=int(len(m)), terms=summarise(poisson(fe + " + occ_c:ls_c", m), ["occ_c", "ls_c", "occ_c:ls_c"], U))
    mn = m.dropna(subset=["nctr_pts"])
    print(f" A3 adding patients fit to leave (NCTR), {len(mn)} trust-months:")
    res["A3"] = dict(label="Adding patients no longer meeting the criteria to reside", n=int(len(mn)), trusts=int(mn.org.nunique()),
                     terms=summarise(poisson(fe + " + nctr_pts", mn), ["occ_c", "ls_c", "nctr_pts"], U))
    print(" A4 least squares on log rate:")
    mm = m.assign(log_rate=np.log((m.waits12 + 0.5) / m.emergency_admissions))
    o = smf.ols("log_rate ~ C(org) + C(month) + occ_c + ls_c", data=mm).fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(mm.org)[0]})
    res["A4"] = dict(label="Least squares, log rate", n=int(len(mm)), terms=summarise(o, ["occ_c", "ls_c"], U))

    # ---------------------------------------------------------------- A5/A6: which comes first? (consecutive months only)
    m = m.sort_values(["org", "month"])
    g = m.groupby("org")
    m["w12_rate"] = 100 * m.waits12 / m.emergency_admissions
    for c in ["ls_pts", "occ_pts", "w12_rate"]:
        m[c + "_lag1"], m[c + "_lag3"] = g[c].shift(1), g[c].shift(3)
    m["gap1"], m["gap3"] = (m.month - g.month.shift(1)).dt.days, (m.month - g.month.shift(3)).dt.days
    d1 = m[m.gap1.between(28, 31)].dropna(subset=["ls_pts_lag1", "occ_pts_lag1", "w12_rate_lag1"])
    print(f" A5 long stays last month -> 12-hour waits this month (holding occupancy and last month's waits), {len(d1)} trust-months:")
    r = poisson("waits12 ~ C(org) + C(month) + occ_pts + occ_pts_lag1 + ls_pts_lag1 + np.log1p(w12_rate_lag1)", d1)
    res["A5"] = dict(label="Long stays last month predicting waits this month", n=int(len(d1)),
                     terms=summarise(r, ["ls_pts_lag1"], {"ls_pts_lag1": "point of long-stay share last month"}))
    res["A6"] = dict(label="Waits earlier predicting long stays now (points of long-stay share per log-unit of the waits rate)", terms={})
    for lag, gap, lo_, hi_ in [("lag1", "gap1", 28, 31), ("lag3", "gap3", 84, 93)]:
        d = m[m[gap].between(lo_, hi_)].dropna(subset=[f"w12_rate_{lag}", f"ls_pts_{lag}", f"occ_pts_{lag}"])
        o = smf.ols(f"ls_pts ~ C(org) + C(month) + occ_pts + occ_pts_{lag} + ls_pts_{lag} + np.log1p(w12_rate_{lag})", data=d).fit(
            cov_type="cluster", cov_kwds={"groups": pd.factorize(d.org)[0]})
        k = f"np.log1p(w12_rate_{lag})"
        res["A6"]["terms"][lag] = dict(coef=float(o.params[k]), lo=float(o.params[k] - 1.96 * o.bse[k]), hi=float(o.params[k] + 1.96 * o.bse[k]), p=float(o.pvalues[k]), n=int(len(d)))
        print(f" A6 waits {lag[-1]} month(s) earlier -> long-stay share now: {o.params[k]:+.2f} pts (95% CI {o.params[k] - 1.96 * o.bse[k]:+.2f} to {o.params[k] + 1.96 * o.bse[k]:+.2f}; p={o.pvalues[k]:.3f})")

    # ---------------------------------------------------------------- C: competing explanations on the before/after panel
    p = pd.read_csv(OUT / "trust_flexibility_panel.csv")
    reg = sr.copy()
    region = {}
    for f in (RAW / "ga_sitreps").glob("*CSV*.csv"):
        d = pd.read_csv(f)
        if {"Org Code", "Region", "Level"} <= set(d.columns):
            region.update(d[d.Level == "Provider"].drop_duplicates("Org Code").set_index("Org Code").Region.to_dict())
    p["region"] = p.org.map(region)
    nc = nctr_months()
    nc = nc[(nc.month >= "2025-04-01") & (nc.month < "2026-04-01")].groupby("org").nctr.mean()
    occ2526 = sr[(sr.month >= "2025-04-01") & (sr.month < "2026-04-01")].groupby("org").ga_occupied.mean()
    p["nctr_share"] = p.org.map(nc / occ2526)
    std = lambda s: (s - s.mean()) / s.std()  # noqa: E731
    p = p.dropna(subset=["long_stay", "nctr_share", "region"]).copy()
    p["occ_pts"] = 100 * (p.occupancy - p.occupancy.mean())
    p["long_stay_z"], p["nctr_z"], p["log_beds_z"] = std(p.long_stay), std(p.nctr_share), std(np.log(p.beds_pre))
    print(f"\nC. before/after panel with controls: {len(p)} trust-years, {p.org.nunique()} trusts; "
          f"correlation of long-stay and fit-to-leave shares across trusts: {p.groupby('org')[['long_stay', 'nctr_share']].first().corr().iloc[0, 1]:.2f}")
    UC = {"post:long_stay_z": "SD of long-stay share", "post:nctr_z": "SD of fit-to-leave share", "post:log_beds_z": "SD of trust size"}
    base = "waits12 ~ C(org) + C(fy) + occ_pts + post:occ_pts + post:log_beds_z"
    for key, f, label in [("C1", base + " + post:long_stay_z", "Long stays (as before)"),
                          ("C2", base + " + post:nctr_z", "Patients fit to leave instead of long stays"),
                          ("C3", base + " + post:long_stay_z + post:nctr_z", "Long stays and patients fit to leave together"),
                          ("C4", base + " + post:long_stay_z + post:nctr_z + post:C(region)", "Plus region x after")]:
        print(f" {key} {label}:")
        mod = poisson(f, p)
        res[key] = dict(label=label, n=int(len(p)), trusts=int(p.org.nunique()),
                        terms=summarise(mod, [k for k in ["post:long_stay_z", "post:nctr_z", "post:log_beds_z"] if k in mod.params], UC))
    # ---------------------------------------------------------------- B: long stays measured before the pandemic
    w = winter_pre()
    if len(w):
        pre_ls = w.groupby("org").ls_share.mean()
        post_w = sr[(sr.month >= "2025-12-01") & (sr.month <= "2026-03-01")].groupby("org").apply(lambda g: g.los21.sum() / g.ga_occupied.sum())
        both = pd.DataFrame({"pre": pre_ls, "post": post_w}).dropna()
        print(f"\nB. winter long-stay share (21+ days), {len(both)} trusts with both: before {both.pre.mean():.1%} -> after {both.post.mean():.1%}; "
              f"correlation before vs after {both.corr().iloc[0, 1]:.2f}")
        res["B_descriptive"] = dict(trusts=int(len(both)), mean_before=float(both.pre.mean()), mean_after=float(both.post.mean()),
                                    correlation=float(both.corr().iloc[0, 1]))
        q = pd.read_csv(OUT / "trust_flexibility_panel.csv")
        q["ls_pre"], q["ls_post_w"] = q.org.map(pre_ls), q.org.map(post_w)
        q = q.dropna(subset=["ls_pre", "ls_post_w"]).copy()
        q["occ_pts"] = 100 * (q.occupancy - q.occupancy.mean())
        q["ls_pre_z"] = std(q.ls_pre)
        q["ls_rise_z"] = std(q.ls_post_w - q.ls_pre)
        q["log_beds_z"] = std(np.log(q.beds_pre))
        UB = {"ls_pre_z": "SD of long-stay share before", "post:ls_pre_z": "SD of long-stay share before",
              "post:ls_rise_z": "SD of rise in long-stay share", "post:log_beds_z": "SD of trust size"}
        pre_only = q[q.post == 0]
        print(f" B1 before the pandemic only: did trusts with more long stays then have more 12-hour waits then? ({len(pre_only)} trust-years)")
        res["B1"] = dict(label="Before only: long stays then vs waits then", n=int(len(pre_only)),
                         terms=summarise(poisson("waits12 ~ C(fy) + occ_pts + ls_pre_z", pre_only), ["ls_pre_z"], UB))
        print(f" B2 before/after: level before and rise since ({len(q)} trust-years, {q.org.nunique()} trusts)")
        mod = poisson("waits12 ~ C(org) + C(fy) + occ_pts + post:occ_pts + post:log_beds_z + post:ls_pre_z + post:ls_rise_z", q)
        res["B2"] = dict(label="After the pandemic: long-stay level before vs rise since", n=int(len(q)), trusts=int(q.org.nunique()),
                         terms=summarise(mod, ["post:ls_pre_z", "post:ls_rise_z", "post:log_beds_z"], UB))

    (WEB / "longstay_tests.json").write_text(json.dumps(res, default=float, indent=1))
    print("\nwrote web/data/longstay_tests.json")


if __name__ == "__main__":
    main()
