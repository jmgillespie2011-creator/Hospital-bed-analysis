"""Daily tests of the flexibility idea, using winter daily situation reports by trust.

Before the pandemic: winter daily sitreps 2017/18, 2018/19, 2019/20 (data/raw/winter_sitreps_pre).
After: UEC daily sitreps 2022/23 and 2023/24 (data/raw/uec_sitreps_post, if fetched), 2024/25 and 2025/26
(data/raw/corridor_care). Each gives, by trust and day, G&A core beds, escalation beds and occupied beds, and
ambulance handovers with the number delayed over 60 minutes.

Test 2 (same-day curves): within each trust, how does the share of ambulance handovers delayed over 60 minutes
rise with that day's occupancy, before and after the pandemic? If hospitals now behave as if their beds are in
smaller pools, delays should be higher at the same occupancy and rise less steeply (in proportion) with it.

Test 5 (escalation used up): before the pandemic, were delays concentrated on days when a trust had opened (nearly)
all the escalation beds it opened that winter? If escalation was the reserve that kept waits short, delays should
rise sharply once it was used up, and that step should be smaller now, when delays are common on ordinary days.
Also at trust-month level before the pandemic, with 12-hour waits from decision to admit (A&E monthly by provider).

Writes web/data/daily_tests.json and data/processed/daily_trust_panel.csv.  Usage: python scripts/daily_tests.py
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
RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"
CODE = re.compile(r"^[A-Z0-9]{3,5}$")


def sitrep_sheet(f: Path, sheet: str, code_label: str = "Code") -> pd.DataFrame:
    """Long table (org, date, label, value) from a sitrep time-series sheet: a header row naming 'Code' and the
    measures, and a row above it with the date at the first column of each day's block."""
    d = pd.read_excel(f, sheet_name=sheet, header=None)
    h = next(i for i in range(min(40, len(d))) if any(str(v).strip() == code_label for v in d.iloc[i]))
    labels = d.iloc[h].map(lambda v: str(v).strip())
    cc = int(next(i for i, v in enumerate(labels) if v == code_label))
    dates = None
    for r in range(h - 1, max(h - 5, -1), -1):
        row = pd.to_datetime(d.iloc[r], errors="coerce")
        if row.notna().sum() > 3:
            dates = row.ffill()
            break
    body = d.iloc[h + 1:]
    body = body[body.iloc[:, cc].astype(str).str.strip().str.match(CODE)]
    out = []
    for j in range(cc + 1, d.shape[1]):
        if dates is None or pd.isna(dates.iloc[j]) or labels.iloc[j] in ("nan", ""):
            continue
        out.append(pd.DataFrame({"org": body.iloc[:, cc].astype(str).str.strip().values, "date": dates.iloc[j],
                                 "label": labels.iloc[j], "value": pd.to_numeric(body.iloc[:, j], errors="coerce").values}))
    return pd.concat(out) if out else pd.DataFrame(columns=["org", "date", "label", "value"])


def pick(long: pd.DataFrame, pats: dict[str, str]) -> pd.DataFrame:
    rows = []
    for name, pat in pats.items():
        x = long[long.label.str.contains(pat, case=False, regex=True)]
        rows.append(x.groupby(["org", "date"]).value.first().rename(name))
    return pd.concat(rows, axis=1).reset_index()


def winter_of(date: pd.Timestamp) -> str:
    y = date.year if date.month >= 7 else date.year - 1
    return f"{y}/{str(y + 1)[2:]}"


def load_pre() -> pd.DataFrame:
    frames = []
    for f in sorted((RAW / "winter_sitreps_pre").glob("*.xlsx")):
        if not re.search(r"(?i)time.?series", f.name) or "111" in f.name:
            continue
        sheets = pd.ExcelFile(f).sheet_names
        ga = next(s for s in sheets if s.lower().startswith("g&a"))
        amb = next(s for s in sheets if s.lower().startswith("ambulance"))
        b = pick(sitrep_sheet(f, ga), {"core": r"^core beds", "escalation": r"^escalation beds", "open": r"^total beds open", "occupied": r"occ'?d"})
        a = pick(sitrep_sheet(f, amb), {"arrivals": r"arriving", "delay30_60": r"30-60", "delay60": r">\s?60"})
        a["delay30"] = a.delay30_60 + a.delay60
        frames.append(b.merge(a, on=["org", "date"], how="inner"))
    return pd.concat(frames).assign(post=0)


def load_post() -> pd.DataFrame:
    frames = []
    dirs = [RAW / "uec_sitreps_post", RAW / "corridor_care"]
    uec = [f for d in dirs if d.exists() for f in sorted(d.glob("*.xlsx")) if re.search(r"(?i)uec.*sit.?rep|daily.?sitrep", f.name)
           and re.search(r"(?i)time.?series", f.name)]
    ambf = [f for d in dirs if d.exists() for f in sorted(d.glob("*.xlsx")) if re.search(r"(?i)ambulance", f.name) and re.search(r"(?i)time.?series", f.name)]
    beds = []
    for f in uec:
        sheets = pd.ExcelFile(f).sheet_names
        ce = next((s for s in sheets if re.search(r"(?i)^(total )?g&a core esc", s)), None)
        tot = next((s for s in sheets if re.search(r"(?i)^(total )?g&a beds$", s)), None)
        if not tot:
            print("  skip (layout)", f.name)
            continue
        y = pick(sitrep_sheet(f, tot), {"open": r"beds open", "occupied": r"occ'?d"})
        if ce:  # core / escalation split (not published in 2022/23)
            y = y.merge(pick(sitrep_sheet(f, ce), {"core": r"core beds", "escalation": r"escalation beds"}), on=["org", "date"], how="left")
        else:
            y["core"] = np.nan; y["escalation"] = np.nan
        beds.append(y)
    amb = []
    for f in ambf:
        sh = pd.ExcelFile(f).sheet_names[0]
        try:
            a = pick(sitrep_sheet(f, sh, code_label="NHS Trust code"), {"arrivals": r"^all handovers$", "delay30": r"^over 30", "delay60": r"^over 60"})
        except StopIteration:  # 2022/23 layout, as before the pandemic
            a = pick(sitrep_sheet(f, sh), {"arrivals": r"arriving", "delay30_60": r"30-60", "delay60": r">\s?60"})
            a["delay30"] = a.delay30_60 + a.delay60
            a = a.drop(columns="delay30_60")
        amb.append(a)
    if not beds or not amb:
        return pd.DataFrame()
    b = pd.concat(beds).drop_duplicates(["org", "date"]); a = pd.concat(amb).drop_duplicates(["org", "date"])
    return b.merge(a, on=["org", "date"], how="inner").assign(post=1)


class _Fit:
    def __init__(self, params, bse, pvalues):
        self.params, self.bse, self.pvalues = params, bse, pvalues


def clustered_poisson(formula: str, data: pd.DataFrame, exposure: str):
    """Poisson with an exposure offset; C(x) terms become absorbed fixed effects (pyfixest). Errors clustered by trust."""
    import pyfixest as pf
    y, rhs = [t.strip() for t in formula.split("~")]
    terms = [t.strip() for t in rhs.split("+")]
    fe = [t[2:-1] for t in terms if t.startswith("C(")]
    xs = [t for t in terms if not t.startswith("C(")]
    data = data.dropna(subset=[y, exposure] + [c for c in ("occ_pts", "esc_full") if c in rhs]).copy()
    data = data[data[exposure] > 0]
    data["_off"] = np.log(data[exposure])
    fml = f"{y} ~ {' + '.join(xs)}" + (f" | {' + '.join(fe)}" if fe else "")
    m = pf.fepois(fml, data=data, vcov={"CRV1": "org"}, offset="_off")
    return _Fit(m.coef(), m.se(), m.pvalue())


def eff(m, k: str) -> dict:
    b, se = m.params[k], m.bse[k]
    return {"pct": 100 * (np.exp(b) - 1), "lo": 100 * (np.exp(b - 1.96 * se) - 1), "hi": 100 * (np.exp(b + 1.96 * se) - 1), "p": float(m.pvalues[k])}


def main() -> int:
    pre, post = load_pre(), load_post()
    p = pd.concat([pre, post], ignore_index=True)
    p["date"] = pd.to_datetime(p.date)
    p["winter"] = p.date.map(winter_of)
    # same window each winter: December to February
    p = p[p.date.dt.month.isin([12, 1, 2])]
    p["open"] = p.open.fillna(p.core + p.escalation)
    p = p[(p.open > 150) & (p.arrivals > 5) & p.occupied.notna()]
    p["occ_pts"] = 100 * p.occupied / p.open            # occupied as % of all G&A beds open (core + escalation)
    p = p[p.occ_pts.between(60, 105)].copy()
    # escalation used up: escalation beds open at or above 90% of the most this trust opened that winter (95th percentile)
    mx = p.groupby(["org", "winter"]).escalation.quantile(0.95).rename("esc_max")
    p = p.join(mx, on=["org", "winter"])
    p["esc_full"] = np.where(p.escalation.isna(), np.nan, ((p.esc_max > 0) & (p.escalation >= 0.9 * p.esc_max)).astype(float))
    keep = p.groupby("org").post.agg(lambda s: (s == 0).any() and (s == 1).any())
    p = p[p.org.isin(keep[keep].index)].copy()
    p["occ_c"] = p.occ_pts - p.groupby("org").occ_pts.transform("mean")
    p.to_csv(OUT / "daily_trust_panel.csv", index=False)
    print(f"panel: {len(p)} trust-days, {p.org.nunique()} trusts, winters {sorted(p.winter.unique())}")

    out = {"n_trust_days": int(len(p)), "n_trusts": int(p.org.nunique()), "winters": sorted(p.winter.unique().tolist())}
    # descriptive: by period
    out["periods"] = {("after" if k else "before"): {"occupancy": float(g.occupied.sum() / g.open.sum()),
                                                      "delay60_share": float(g.delay60.sum() / g.arrivals.sum()),
                                                      "esc_full_days": float(g.esc_full.mean()), "escalation_share": float(g.escalation.sum() / g.open[g.escalation.notna()].sum())} for k, g in p.groupby("post")}
    # binned curves (occupancy of core beds) for the chart
    p["bin"] = pd.cut(p.occ_pts, [60, 86, 88, 90, 92, 94, 96, 98, 100, 105])
    curve = p.groupby(["post", "bin"], observed=True).agg(arr=("arrivals", "sum"), d60=("delay60", "sum"), n=("org", "size"),
                                                          occ=("occ_pts", "mean")).reset_index()
    out["curve"] = [{"period": "after" if r.post else "before", "occ": float(r.occ), "delay60_share": float(r.d60 / r.arr), "trust_days": int(r.n)}
                    for r in curve.itertuples() if r.n >= 50]

    # Test 2: within-trust slopes. Trust x winter fixed effects absorb each trust's level in each winter;
    # date fixed effects absorb national day-to-day shocks (weather, flu, weekday).
    p["tw"] = p.org + "_" + p.winter
    p["day"] = p.date.dt.strftime("%Y-%m-%d")
    p["dow"] = p.date.dt.dayofweek
    t2 = {}
    for k, g in p.groupby("post"):
        g = g[g.arrivals > 0]
        m = clustered_poisson("delay60 ~ occ_pts + C(tw) + C(day)", g, "arrivals")
        t2["after" if k else "before"] = eff(m, "occ_pts")
    m = clustered_poisson("delay60 ~ occ_pts + occ_pts:post + C(tw) + C(day)", p, "arrivals")
    t2["change"] = eff(m, "occ_pts:post")
    # level at the same occupancy: after vs before, trust fixed effects
    m = clustered_poisson("delay60 ~ post + occ_pts + C(org) + C(dow)", p, "arrivals")
    t2["level_after_same_occupancy"] = eff(m, "post")
    out["test2"] = t2
    for k, r in t2.items():
        print(f"test2 {k}: {r['pct']:+.1f}% ({r['lo']:+.1f} to {r['hi']:+.1f}), p={r['p']:.3f}")

    # Test 5: escalation used up, holding occupancy
    t5 = {}
    for k, g in p.dropna(subset=["esc_full"]).groupby("post"):
        m = clustered_poisson("delay60 ~ esc_full + occ_pts + C(tw) + C(day)", g, "arrivals")
        t5["after" if k else "before"] = {"esc_full": eff(m, "esc_full"), "occ_pts": eff(m, "occ_pts"), "share_days_full": float(g.esc_full.mean())}
    m = clustered_poisson("delay60 ~ esc_full + esc_full:post + occ_pts + occ_pts:post + C(tw) + C(day)", p.dropna(subset=["esc_full"]), "arrivals")
    t5["change"] = eff(m, "esc_full:post")
    out["test5"] = t5
    for k in ("before", "after"):
        r = t5[k]["esc_full"]
        print(f"test5 {k}: escalation used up {r['pct']:+.0f}% ({r['lo']:+.0f} to {r['hi']:+.0f}), p={r['p']:.3f}; {100 * t5[k]['share_days_full']:.0f}% of days")
    print(f"test5 change: {t5['change']['pct']:+.0f}% p={t5['change']['p']:.3f}")

    # Test 5b: trust-months before the pandemic, 12-hour waits from decision to admit
    m5b = monthly_12h(p[p.post == 0])
    if m5b:
        out["test5_monthly_12h"] = m5b
    (WEB / "daily_tests.json").write_text(json.dumps(out, indent=1, default=float))
    print("wrote web/data/daily_tests.json")
    return 0


def ae_month_files() -> pd.DataFrame:
    rows = []
    for f in sorted((RAW / "ae_attendances").glob("*.xls")):
        m = re.match(r"(?i)(?:monthly-ae-)?(december|january|february|march)-(20\d\d)", f.name)
        if not m or "Quarter" in f.name:
            continue
        month = pd.Timestamp(f"{m.group(1)} 1 {m.group(2)}")
        if not (pd.Timestamp("2017-12-01") <= month <= pd.Timestamp("2020-02-01")):
            continue
        try:
            d = pd.read_excel(f, sheet_name="Provider Level Data", header=None)
        except Exception:  # noqa: BLE001
            continue
        h = d.index[d.apply(lambda r: r.map(lambda v: str(v).strip()).eq("Code").any(), axis=1)][0]
        hd = d.iloc[h].map(lambda v: str(v).strip())
        col = lambda pat: int(next(i for i, v in enumerate(hd) if re.search(pat, v)))  # noqa: E731
        body = d.iloc[h + 1:]
        body = body[body.iloc[:, col(r"^Code$")].astype(str).str.match(CODE)]
        rows.append(pd.DataFrame({"org": body.iloc[:, col(r"^Code$")].astype(str).str.strip(), "month": month,
                                  "adm": pd.to_numeric(body.iloc[:, col(r"^Total Emergency Admissions$")], errors="coerce"),
                                  "w4": pd.to_numeric(body.iloc[:, col(r">\s?4 hours from decision")], errors="coerce"),
                                  "w12": pd.to_numeric(body.iloc[:, col(r">\s?12 hours")], errors="coerce")}))
    return pd.concat(rows).dropna().drop_duplicates(["org", "month"], keep="last") if rows else pd.DataFrame()


def monthly_12h(pre: pd.DataFrame) -> dict | None:
    ae = ae_month_files()
    if ae.empty:
        return None
    pre = pre.assign(month=pre.date.dt.to_period("M").dt.to_timestamp())
    mo = pre.groupby(["org", "month"]).agg(esc_full=("esc_full", "mean"), occ_pts=("occ_pts", "mean"), winter=("winter", "first")).reset_index()
    q = mo.merge(ae, on=["org", "month"])
    q = q[q.adm > 500]
    q["tw"] = q.org + "_" + q.winter
    res = {"n_trust_months": int(len(q)), "n_trusts": int(q.org.nunique()),
           "w12_share": float(q.w12.sum() / q.adm.sum()), "w4_share": float(q.w4.sum() / q.adm.sum())}
    # share of 12-hour waits that occurred in the trust-months with escalation used up on at least half of days
    hi = q.esc_full >= 0.5
    res["share_months_mostly_full"] = float(hi.mean())
    res["share_of_12h_in_those_months"] = float(q.loc[hi, "w12"].sum() / max(q.w12.sum(), 1))
    res["share_of_4h_in_those_months"] = float(q.loc[hi, "w4"].sum() / max(q.w4.sum(), 1))
    q = q.dropna(subset=["esc_full"])
    q["month_s"] = q.month.dt.strftime("%Y-%m")
    for y in ("w12", "w4"):
        m = clustered_poisson(f"{y} ~ esc_full + occ_pts + C(org) + C(month_s)", q, "adm")
        res[f"{y}_per_10pts_days_full"] = eff_scaled(m, "esc_full", 0.1)
    m = clustered_poisson("w12 ~ esc_full + occ_pts + C(org) + C(month_s)", q[q.w4 > 0], "w4")
    res["w12_given_w4_per_10pts_days_full"] = eff_scaled(m, "esc_full", 0.1)
    print("test5 monthly (before):", json.dumps(res, default=float)[:600])
    return res


def eff_scaled(m, k: str, s: float) -> dict:
    b, se = m.params[k] * s, m.bse[k] * s
    return {"pct": 100 * (np.exp(b) - 1), "lo": 100 * (np.exp(b - 1.96 * se) - 1), "hi": 100 * (np.exp(b + 1.96 * se) - 1), "p": float(m.pvalues[k])}


if __name__ == "__main__":
    sys.exit(main())
