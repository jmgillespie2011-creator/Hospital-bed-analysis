"""Observed slopes for the pool-size test (scripts/pool_tests.mjs): within each acute trust, how much do waits from
decision to admit rise for each extra point of G&A occupancy, before and after the pandemic? Smaller effective pools
predict a flatter proportional slope. Also reports, by period, how many 4-hour waiters go on to wait 12 hours.

Same trust-year panel as scripts/trust_flexibility.py (KH03 quarterly occupancy, A&E quarterly by provider), with
4-hour waits added. Poisson with trust and year fixed effects, admissions as exposure, errors clustered by trust.
Writes web/data/pool_slopes.json.  Usage: python scripts/pool_slopes.py
"""
from __future__ import annotations

import json
import re
import sys

import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
import trust_flexibility as T  # noqa: E402


def ae_trusts_4h() -> pd.DataFrame:
    rows = []
    for f in sorted((T.RAW / "ae_attendances").glob("*.xls*")):
        if not re.search(r"(?i)quarter", f.name) or "Time-Series" in f.name:
            continue
        fy = T.fy_from_text(f.name.replace("2025-2026", "2025-26"))
        if fy not in T.YEARS:
            continue
        d = T.read_excel_any(f, "Provider Level Data")
        hdr = d.index[d.apply(lambda r: r.map(lambda v: str(v).strip()).eq("Code").any(), axis=1)][0]
        h = d.iloc[hdr].map(lambda v: str(v).strip())
        col = lambda pat: int(next(i for i, v in enumerate(h) if re.search(pat, v)))  # noqa: E731
        body = d.iloc[hdr + 1:]
        body = body[body[col(r"^Code$")].astype(str).str.match(r"^[A-Z0-9]{3,5}$")]
        q = re.search(r"Quarter-(\d|One|Two|Three|Four)", f.name)
        rows.append(pd.DataFrame({"fy": fy, "quarter": q.group(1) if q else f.name,
                                  "org": body[col(r"^Code$")].astype(str).str.strip(),
                                  "emergency_admissions": pd.to_numeric(body[col(r"^Total Emergency Admissions$")], errors="coerce"),
                                  "waits4": pd.to_numeric(body[col(r">\s?4 hours from decision")], errors="coerce"),
                                  "waits12": pd.to_numeric(body[col(r">\s?12 hours")], errors="coerce")}))
    a = pd.concat(rows).dropna().drop_duplicates(["fy", "quarter", "org"], keep="last")
    return a.groupby(["org", "fy"]).agg(ae_quarters=("quarter", "nunique"), emergency_admissions=("emergency_admissions", "sum"),
                                        waits4=("waits4", "sum"), waits12=("waits12", "sum")).reset_index()


def main() -> int:
    p = T.kh03_trusts().merge(ae_trusts_4h(), on=["org", "fy"], how="inner")
    p = p[(p.quarters >= 3) & (p.ae_quarters >= 3)].copy()
    p["occupancy"] = p.ga_occupied / p.ga_available
    p = p[(p.ga_available > 150) & (p.emergency_admissions > 10000) & p.occupancy.between(0.5, 1.05)]
    n = p.groupby("org").fy.agg(lambda s: (s.isin(T.PRE).sum(), s.isin(T.POST).sum()))
    p = p[p.org.isin(n[n.map(lambda t: t[0] >= 2 and t[1] >= 2)].index)].copy()
    p["post"] = p.fy.isin(T.POST).astype(int)
    p["occ_pts"] = 100 * p.occupancy
    out = {"n_trusts": int(p.org.nunique()), "n_trust_years": int(len(p)), "slopes": {}, "ratio": {}}
    for y in ["waits4", "waits12"]:
        # 4-hour waits include the 12-hour waits, so both are "at least" counts
        m = smf.glm(f"{y} ~ occ_pts + occ_pts:post + C(org) + C(fy)", data=p, family=sm.families.Poisson(),
                    offset=np.log(p.emergency_admissions)).fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(p.org)[0]})
        b, V = m.params, m.cov_params()
        pre, ch = b["occ_pts"], b["occ_pts:post"]
        post, se_post = pre + ch, float(np.sqrt(V.loc["occ_pts", "occ_pts"] + V.loc["occ_pts:post", "occ_pts:post"] + 2 * V.loc["occ_pts", "occ_pts:post"]))
        r = lambda c, se: {"pct": 100 * (np.exp(c) - 1), "lo": 100 * (np.exp(c - 1.96 * se) - 1), "hi": 100 * (np.exp(c + 1.96 * se) - 1)}  # noqa: E731
        out["slopes"][y] = {"before": r(pre, m.bse["occ_pts"]), "after": r(post, se_post),
                            "change_p": float(m.pvalues["occ_pts:post"])}
        s = out["slopes"][y]
        print(f"{y}: per occupancy point before {s['before']['pct']:+.1f}% ({s['before']['lo']:+.1f} to {s['before']['hi']:+.1f}), "
              f"after {s['after']['pct']:+.1f}% ({s['after']['lo']:+.1f} to {s['after']['hi']:+.1f}); change p={s['change_p']:.3f}")
    for per, g in p.groupby("post"):
        out["ratio"]["after" if per else "before"] = {"wait4": float(g.waits4.sum() / g.emergency_admissions.sum()),
                                                      "wait12": float(g.waits12.sum() / g.emergency_admissions.sum()),
                                                      "share_of_4h_reaching_12h": float(g.waits12.sum() / g.waits4.sum())}
    print("ratio", out["ratio"])
    # which trusts lost the cap? 12-hour waits with 4-hour waits as exposure: did the share of 4-hour waiters
    # reaching 12 hours rise more in bigger trusts or in trusts with more long-stay patients?
    t = pd.read_csv(T.OUT / "trust_panel_2025_26.csv")
    z = p[p.post == 0].groupby("org").ga_available.mean().rename("beds_pre").reset_index()
    z = z.merge(t.assign(long_stay=t.los_21plus / t.ga_occupied)[["org", "long_stay"]], on="org", how="left")
    z["log_beds_z"] = (np.log(z.beds_pre) - np.log(z.beds_pre).mean()) / np.log(z.beds_pre).std()
    z["long_stay_z"] = (z.long_stay - z.long_stay.mean()) / z.long_stay.std()
    q = p.merge(z, on="org").dropna(subset=["long_stay_z"])
    q = q[q.waits4 > 0]
    m = smf.glm("waits12 ~ occ_pts + post:log_beds_z + post:long_stay_z + C(org) + C(fy)", data=q, family=sm.families.Poisson(),
                offset=np.log(q.waits4)).fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(q.org)[0]})
    out["tail_by_trust"] = {"n_trusts": int(q.org.nunique()), "terms": {k: {"pct": 100 * (np.exp(m.params[k]) - 1), "lo": 100 * (np.exp(m.conf_int().loc[k, 0]) - 1),
                            "hi": 100 * (np.exp(m.conf_int().loc[k, 1]) - 1), "p": float(m.pvalues[k])} for k in ["post:log_beds_z", "post:long_stay_z", "occ_pts"]}}
    for k, r in out["tail_by_trust"]["terms"].items():
        print(f"tail {k}: {r['pct']:+.0f}% ({r['lo']:+.0f} to {r['hi']:+.0f}), p={r['p']:.3f}")
    (T.WEB / "pool_slopes.json").write_text(json.dumps(out, indent=1))
    print("wrote web/data/pool_slopes.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
