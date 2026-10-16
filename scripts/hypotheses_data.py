"""Evidence for three explanations of full hospitals: social care, general practice, and hospital flow.

  delays        why patients fit to leave are still in hospital: acute discharge sitrep delay reasons (national,
                from June 2024), grouped into who has to act (social care, community health services, joint
                arrangements, the hospital itself, housing, patient and family / legal)
  dtocResp      delayed transfers of care by responsible organisation (NHS, social care, both), acute and non-acute,
                month-end snapshot, August 2010 to March 2017 (the older, narrower measure)
  ascof         delays attributable to social care per 100,000 adults, by council (ASCOF 2C), 2011/12-2018/19
  acsc          emergency admissions and bed days for chronic ambulatory care sensitive conditions (conditions that good
                primary care can often keep out of hospital), HES primary diagnosis tables, general and acute scope
  demand        A&E attendances and emergency admissions per 1,000 people (A&E monthly, ONS)
Writes web/data/hypotheses_data.json.  Usage: python scripts/hypotheses_data.py
"""
from __future__ import annotations

import glob
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT, WEB = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "web" / "data"
sys.path.insert(0, str(Path(__file__).resolve().parent))

# who has to act for each published delay reason. "Capacity" reasons: the service is not available; "process" reasons:
# arrangements are still being made. Interface arrangements are assigned to whoever provides the service being arranged.
GROUPS = [
    ("Housing", r"housing|homeless"),
    ("Patient, family and legal", r"^Wellbeing|choice discussions"),
    ("Social care", r"(residential/nursing home|home-based social care|restart of existing social care|self-funded care package)"),
    ("Community health services", r"(rehabilitation|reablement|community health|end of life|equipment|mental health admitted)"),
    ("Hospital processes", r"^Hospital process"),
    ("Care transfer hubs and other joint processes", r"^(Care transfer hub|Interface process)"),
]


def clean(metric: str) -> str:
    try:  # files saved as UTF-8 but read as cp1252
        metric = metric.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    metric = re.sub(r"[\u2013\u2014\x96]", "-", metric).replace("\xa0", " ").replace("\u202f", " ").replace("?(", " (")
    return re.sub(r"\s+", " ", metric).strip(" ?")


def group_of(metric: str) -> str:
    return next((name for name, pat in GROUPS if re.search(pat, metric, re.I)), "Other")


def kind_of(metric: str) -> str:
    return "Service not available" if metric.startswith("Capacity") else ("Arrangements under way" if re.match(r"^(Interface|Care transfer)", metric)
                                                                          else "Other")


def read_sitrep_csv(f: str) -> pd.DataFrame:
    d = pd.read_csv(f, encoding="cp1252", low_memory=False)
    d.columns = [re.sub(r"^[^A-Za-z]+", "", c).strip() for c in d.columns]
    return d


def delays() -> dict:
    rows = []
    for f in sorted(glob.glob(str(RAW / "discharge_acute" / "*.csv"))):
        d = read_sitrep_csv(f)
        if "Metric Group" not in d or "Level" not in d:
            continue
        n = d[d.Level.astype(str).str.lower() == "national"].copy()
        n["date"] = pd.to_datetime(n.Period, dayfirst=True, errors="coerce")
        n["Value"] = pd.to_numeric(n.Value, errors="coerce")
        for gname, base in (("Delay reason", "all"), ("Delay reason LOS 7+", "7+"), ("Delay reason LOS 14+", "14+")):
            g = n[n["Metric Group"] == gname]
            if g.empty:
                continue
            month = g.date.dt.to_period("M").mode().iloc[0]
            per = g.groupby("Metric").Value.mean()
            for metric, v in per.items():
                mm = clean(metric)
                rows.append(dict(month=str(month), base=base, metric=mm, group=group_of(mm), kind=kind_of(mm), value=float(v)))
        nn = n[n["Metric Group"] == "NCTR not discharged"]
        if not nn.empty:
            rows.append(dict(month=str(nn.date.dt.to_period("M").mode().iloc[0]), base="nctr", metric="NCTR not discharged",
                             group="total", value=float(nn.Value.mean())))
    t = pd.DataFrame(rows).drop_duplicates(["month", "base", "metric"], keep="last")
    out = {"groups": [g for g, _ in GROUPS], "series": {}, "reasons": {}}
    for base in ("all", "7+", "14+"):
        b = t[t.base == base]
        if b.empty:
            continue
        m = b.groupby(["month", "group"]).value.sum().unstack(fill_value=0)
        share = m.div(m.sum(axis=1), axis=0)
        out["series"][base] = [{"month": i, "total": float(m.loc[i].sum()), **{k: float(share.loc[i, k]) for k in share.columns}}
                               for i in share.index]
        last12 = sorted(b.month.unique())[-12:]
        r = b[b.month.isin(last12)].groupby(["group", "metric"]).value.mean().reset_index()
        r["share"] = r.value / r.value.sum()
        r = r.merge(b[["metric", "kind"]].drop_duplicates("metric"), on="metric", how="left")
        out["reasons"][base] = {"months": [last12[0], last12[-1]], "rows": r.sort_values("value", ascending=False).to_dict(orient="records"),
                                "byGroup": r.groupby("group").share.sum().sort_values(ascending=False).to_dict(),
                                "byGroupKind": r.groupby(["group", "kind"]).share.sum().unstack(fill_value=0).to_dict(orient="index")}
    nc = t[t.base == "nctr"].sort_values("month")
    out["nctrMonthly"] = nc[["month", "value"]].to_dict(orient="records")
    other = t[(t.group == "Other") & (t.base != "nctr")].metric.unique().tolist()
    if other:
        print("  ungrouped delay reasons:", other)
    return out


def trust_delays() -> pd.DataFrame:
    """Monthly patients delayed 7+ days by trust and by who has to act (provider level), for the trust tests."""
    rows = []
    for f in sorted(glob.glob(str(RAW / "discharge_acute" / "*.csv"))):
        d = read_sitrep_csv(f)
        if "Metric Group" not in d or "Level" not in d:
            continue
        p = d[(d.Level.astype(str).str.upper() == "PROVIDER") & (d["Metric Group"] == "Delay reason LOS 7+")].copy()
        if p.empty:
            continue
        p["date"] = pd.to_datetime(p.Period, dayfirst=True, errors="coerce")
        p["Value"] = pd.to_numeric(p.Value, errors="coerce")
        month = p.date.dt.to_period("M").mode().iloc[0]
        p["group"] = p.Metric.map(lambda m: group_of(clean(m)))
        g = p.groupby(["Org Code", "group", "Metric"]).Value.mean().groupby(level=[0, 1]).sum().unstack(fill_value=0)
        g["month"] = month.to_timestamp()
        rows.append(g.reset_index().rename(columns={"Org Code": "org"}))
    t = pd.concat(rows).drop_duplicates(["org", "month"], keep="last").fillna(0)
    t.to_csv(OUT / "trust_delay_reasons_monthly.csv", index=False)
    return t


def dtoc_resp() -> list[dict]:
    f = RAW / "dtoc" / "Patient-Snapshot-Timeseries-to-March-2017-Revised.xls"
    d = pd.read_excel(f, sheet_name="Patient Snapshot by resp org", header=None)
    h, c0 = next((i, j) for i in range(30) for j in range(3) if str(d.iloc[i, j]).strip() == "Year")
    hdr = [re.sub(r"\s+", " ", str(v)).strip() for v in d.iloc[h]]
    sub = [re.sub(r"\s+", " ", str(v)).strip() for v in d.iloc[h - 1]]
    body = d.iloc[h + 1:].copy()
    body = body[body.iloc[:, c0].astype(str).str.match(r"^\d{4}-\d\d$")]
    print("  DTOC by responsible organisation, columns:", list(zip(sub, hdr))[c0:c0 + 12])
    cols = {j: hdr[j].lower().replace(" ", "_") for j in range(c0 + 2, len(hdr)) if hdr[j] not in ("nan", "")}
    rows = []
    for _, r in body.iterrows():
        rec = {"fy": str(r.iloc[c0]).replace("-", "/"), "month": str(r.iloc[c0 + 1])}
        for j, k in cols.items():
            rec[k] = pd.to_numeric(r.iloc[j], errors="coerce")
        rows.append(rec)
    t = pd.DataFrame(rows)
    g = t.groupby("fy").agg(**{k: (k, "mean") for k in cols.values()}, months=("month", "size")).reset_index()
    return g[g.months == 12].replace({np.nan: None}).to_dict(orient="records")


# chronic ambulatory care sensitive conditions (NHS Outcomes Framework 2.3i), three-character approximation
ACSC = {"Angina": r"^I20$", "Asthma": r"^J4[56]$", "Atrial fibrillation": r"^I48$", "Heart failure": r"^(I50|I11|J81)$",
        "Epilepsy and convulsions": r"^(G4[01]|R56)$", "COPD": r"^J4[1-4]$|^J47$", "Dementia": r"^F0[0-3]$",
        "Diabetes": r"^E1[0-4]$", "Hypertension": r"^I10$", "Iron deficiency and nutritional anaemia": r"^D5[0-2]$"}


def acsc() -> list[dict]:
    from hes_admissions import _files, parse
    out = []
    for fy, f in _files().items():
        t = parse(f)
        g = t[~t.code.str.match(r"^(O|P|F[1-9])") & (t.code != "Z38")]
        es = (g.emergency / g.fae.replace(0, np.nan)).fillna(0).clip(0, 1)
        g = g.assign(ebd=g.bed_days * es)
        rec = {"fy": fy, "emergency": float(g.emergency.sum()), "emergency_bed_days": float(g.ebd.sum())}
        tot_e = tot_b = 0.0
        for name, pat in ACSC.items():
            s = g[g.code.str.match(pat)]
            rec[f"adm_{name}"] = float(s.emergency.sum())
            tot_e += s.emergency.sum()
            tot_b += s.ebd.sum()
        rec["acsc_emergency"] = float(tot_e)
        rec["acsc_bed_days"] = float(tot_b)
        rec["acsc_share_adm"] = float(tot_e / rec["emergency"])
        rec["acsc_share_bd"] = float(tot_b / rec["emergency_bed_days"])
        out.append(rec)
    return out


def demand() -> list[dict]:
    f = next((RAW / "ae_attendances").glob("Monthly-AE-Time-Series-*.xls"))
    d = pd.read_excel(f, sheet_name="Activity", header=None)
    hdr = d.index[d[1].astype(str).str.strip().eq("Period")][0]
    rows = d.iloc[hdr + 1:].copy()
    rows.columns = [str(c).strip() for c in d.iloc[hdr]]
    rows = rows[pd.to_datetime(rows["Period"], errors="coerce").notna()]
    m = pd.DataFrame({"month": pd.to_datetime(rows["Period"]),
                      "attend_type1": pd.to_numeric(rows["Type 1 Departments - Major A&E"], errors="coerce"),
                      "attend_all": pd.to_numeric(rows["Total Attendances"], errors="coerce"),
                      "adm_via_type1": pd.to_numeric(rows["Emergency Admissions via Type 1 A&E"], errors="coerce"),
                      "adm_emergency": pd.to_numeric(rows["Total Emergency Admissions"], errors="coerce"),
                      "adm_not_via_ae": pd.to_numeric(rows["Other Emergency Admissions (i.e not via A&E)"], errors="coerce")})
    m["fy"] = [f"{x.year if x.month >= 4 else x.year - 1}/{str((x.year if x.month >= 4 else x.year - 1) + 1)[2:]}" for x in m.month]
    g = m.groupby("fy").agg(n=("month", "count"), **{c: (c, "sum") for c in m.columns if c not in ("month", "fy")}).reset_index()
    beds = pd.DataFrame(json.loads((WEB / "blog_observed.json").read_text())["beds"])[["fy", "population", "pop75"]]
    g = g[g.n == 12].merge(beds, on="fy", how="inner")
    for c in ("attend_type1", "attend_all", "adm_via_type1", "adm_emergency", "adm_not_via_ae"):
        g[c + "_per1000"] = 1000 * g[c] / g.population
    g["type1_conversion"] = g.adm_via_type1 / g.attend_type1   # share of major A&E attendances admitted
    return g.replace({np.nan: None}).to_dict(orient="records")


def main() -> int:
    td = trust_delays()
    print(f"trust delay reasons: {td.org.nunique()} trusts, {td.month.nunique()} months ({td.month.min():%Y-%m} to {td.month.max():%Y-%m})")
    out = {"delays": delays(), "dtocResp": dtoc_resp(), "acsc": acsc(), "demand": demand()}
    r = out["delays"]["reasons"]
    for base, v in r.items():
        print(f"delay reasons ({base}, {v['months'][0]} to {v['months'][1]}):", {k: round(x, 3) for k, x in v["byGroup"].items()})
    a = out["acsc"]
    print("ACSC share of emergency admissions / bed days:", [(x["fy"], round(x["acsc_share_adm"], 3), round(x["acsc_share_bd"], 3)) for x in a[::4] + a[-1:]])
    print("demand columns:", list(out["demand"][0].keys()))
    (WEB / "hypotheses_data.json").write_text(json.dumps(out, indent=1, default=float))
    print("wrote web/data/hypotheses_data.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
