"""Are trusts' fitted pool sizes a stable, measurable property, and what goes with them?

Reads data/processed/trust_pools.csv and trust_pools_oos.csv (scripts/trust_pools.mjs).
  stability     correlation of each trust's log pool between post-pandemic years (uncensored pools; Spearman, which
                also tolerates censored values at the ends), and the share of variation that is between trusts
  prediction    each trust's 2023/24 pool, run with its 2025/26 beds, admissions and occupancy, against its observed
                2025/26 12-hour waits; the same with the national pool. Rank correlation and mean absolute error.
  correlates    log pool (2025/26) against trust size, long-stay share, occupancy, and delays per 100 beds by who has to act
                (discharge sitrep, April 2025 onwards): correlations and a joint regression
Writes web/data/trust_pools.json.  Usage: python scripts/trust_pools_analysis.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
OUT, WEB = ROOT / "data" / "processed", ROOT / "web" / "data"
GROUPS = {"Social care": "sc", "Community health services": "ch", "Hospital processes": "hp",
          "Care transfer hubs and other joint processes": "jt"}


def main() -> int:
    t = pd.read_csv(OUT / "trust_pools.csv")
    t["censored"] = t.censored.fillna("")
    t["lp"] = np.log(t.pool)
    out = {"n": {fy: {"trusts": int(len(g)), "wholeHospital": int((g.censored == "whole hospital").sum()), "smallest": int((g.censored == "smallest").sum()),
                      "medianPool": float(g.loc[g.censored == "", "pool"].median()), "q1": float(g.loc[g.censored == "", "pool"].quantile(0.25)),
                      "q3": float(g.loc[g.censored == "", "pool"].quantile(0.75)), "medianShare": float(g.loc[g.censored == "", "poolShare"].median())}
                 for fy, g in t.groupby("fy")}}
    w = t.pivot(index="org", columns="fy", values="lp")
    c = t.pivot(index="org", columns="fy", values="censored")
    pairs = []
    yrs = sorted(w.columns)
    for i in range(len(yrs)):
        for j in range(i + 1, len(yrs)):
            a, b = yrs[i], yrs[j]
            both = w[[a, b]].dropna()
            unc = both[(c.loc[both.index, a] == "") & (c.loc[both.index, b] == "")]
            rs = stats.spearmanr(both[a], both[b])
            pr = stats.pearsonr(unc[a], unc[b]) if len(unc) > 5 else (np.nan, np.nan)
            pairs.append({"a": a, "b": b, "n": int(len(both)), "spearman": float(rs.statistic), "p": float(rs.pvalue),
                          "nUncensored": int(len(unc)), "pearsonUncensored": float(pr[0])})
            print(f"  log pool {a} vs {b}: Spearman {rs.statistic:.2f} (p={rs.pvalue:.3g}, n={len(both)}); uncensored Pearson {pr[0]:.2f} (n={len(unc)})")
    out["stability"] = pairs
    # share of variance between trusts (uncensored trust-years, trusts seen at least twice)
    u = t[t.censored == ""]
    u = u[u.groupby("org").org.transform("size") >= 2]
    m = smf.mixedlm("lp ~ C(fy)", u, groups=u.org).fit()
    vb, vw = float(m.cov_re.iloc[0, 0]), float(m.scale)
    out["icc"] = {"betweenTrust": vb / (vb + vw), "n": int(len(u)), "trusts": int(u.org.nunique())}
    print(f"  share of variation in log pool that is between trusts: {vb / (vb + vw):.2f} ({u.org.nunique()} trusts)")

    o = pd.read_csv(OUT / "trust_pools_oos.csv")
    res = {}
    for k in ("ownPool", "nationalPool"):
        rho = stats.spearmanr(o[k], o.observed)
        err = (o[k] - o.observed).abs()
        within = float(((o[k] / o.observed.clip(lower=0.002)).between(0.5, 2)).mean())
        res[k] = {"spearman": float(rho.statistic), "p": float(rho.pvalue), "mae": float(err.mean()), "medae": float(err.median()), "withinFactor2": within}
        print(f"  2025/26 waits predicted with {k}: rank correlation {rho.statistic:.2f} (p={rho.pvalue:.3g}), median absolute error {100 * err.median():.2f} pts "
              f"(mean {100 * err.mean():.2f}), within a factor of 2: {100 * within:.0f}% of trusts")
    res["n"] = int(len(o))
    res["observedMean"] = float(o.observed.mean())
    out["prediction"] = res
    out["oos"] = o.astype(object).where(o.notna(), None).to_dict(orient="records")

    # correlates, 2025/26
    td = pd.read_csv(OUT / "trust_delay_reasons_monthly.csv", parse_dates=["month"]).rename(columns=GROUPS)
    td = td[td.month.dt.to_period("M").between(pd.Period("2025-04", "M"), pd.Period("2026-03", "M"))].groupby("org")[list(GROUPS.values())].mean()
    x = t[t.fy == "2025/26"].set_index("org").join(td, how="left")
    for k in GROUPS.values():
        x[k] = 100 * x[k] / x.beds
    x["log_beds"] = np.log(x.beds)
    x["occ_pts"] = 100 * x.occupancy
    x["ls_pts"] = 100 * x.longStay
    cor = {}
    for k, lab in (("log_beds", "Trust size (log beds)"), ("ls_pts", "Long-stay share"), ("occ_pts", "Occupancy"), ("hp", "Hospital-process delays per 100 beds"),
                   ("sc", "Social care delays per 100 beds"), ("ch", "Community health delays per 100 beds"), ("jt", "Joint-process delays per 100 beds")):
        d = x[["lp", k]].dropna()
        rs = stats.spearmanr(d[k], d.lp)
        cor[k] = {"label": lab, "spearman": float(rs.statistic), "p": float(rs.pvalue), "n": int(len(d))}
        print(f"  log pool ~ {lab}: Spearman {rs.statistic:+.2f} (p={rs.pvalue:.3f}, n={len(d)})")
    out["correlates"] = cor
    d = x.dropna(subset=["lp", "log_beds", "ls_pts", "hp", "sc", "ch"])
    for v in ("log_beds", "ls_pts", "hp", "sc", "ch"):
        d[v + "_z"] = (d[v] - d[v].mean()) / d[v].std()
    r = smf.ols("lp ~ log_beds_z + ls_pts_z + hp_z + sc_z + ch_z", data=d).fit(cov_type="HC1")
    out["joint"] = {"n": int(r.nobs), "r2": float(r.rsquared), "terms": {k: {"pct": float(100 * (np.exp(r.params[k]) - 1)), "lo": float(100 * (np.exp(r.conf_int().loc[k, 0]) - 1)),
                    "hi": float(100 * (np.exp(r.conf_int().loc[k, 1]) - 1)), "p": float(r.pvalues[k])} for k in r.params.index if k != "Intercept"}}
    for k, v in out["joint"]["terms"].items():
        print(f"  joint: {k}: {v['pct']:+.0f}% pool per SD ({v['lo']:+.0f} to {v['hi']:+.0f}), p={v['p']:.3f}")
    print(f"  joint R2 {r.rsquared:.2f}, n={int(r.nobs)}")
    def clean(v):  # JSON has no NaN
        if isinstance(v, dict):
            return {k: clean(x) for k, x in v.items()}
        if isinstance(v, list):
            return [clean(x) for x in v]
        return None if isinstance(v, float) and not np.isfinite(v) else v
    (WEB / "trust_pools.json").write_text(json.dumps(clean(out), indent=1, default=float, allow_nan=False))
    print("wrote web/data/trust_pools.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
