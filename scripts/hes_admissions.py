"""Hospital use per admission (not per episode), England, 2008/09 to 2024/25.

HES "mean length of stay" is per finished consultant episode, and only counts episodes with at least one night. An
admission (a spell) can hold several episodes, so per-episode figures understate how long patients stay. This builds
per-admission measures from the HES primary diagnosis 3-character tables, one row per diagnosis:

  bed days         "FCE bed days", summed over all episodes of all admissions (so it is also the admissions' bed days)
  admissions       finished admission episodes (one per admission), and emergency admissions among them
  day cases        planned same-day admissions (counted on episodes; a day case is a one-episode admission)
  zero-night       "zero bed day cases" by admission method (from 2013/14): admissions that leave the same day
                   without being booked day cases, e.g. same-day emergency care

Scope matches the model's (scripts/build_inputs.py hes_derived): general and acute care, so maternity (O), perinatal
(P), live-born infants (Z38) and mental illness other than organic disorders (F10-F99) are left out.

  emergency bed days        each diagnosis's bed days times its emergency share of admissions (HES does not split
                            bed days by admission method), summed over diagnoses
  per emergency admission   emergency bed days / emergency admissions (the model's calibration target, 2023/24)
  per overnight emergency   emergency bed days / (emergency admissions - zero-night emergency cases), from 2013/14
  per overnight admission   all bed days / (admissions - day cases - zero-night cases), from 2013/14
  emergency share 75+       each diagnosis's emergency admissions split by its age profile (HES gives age for all
                            episodes of a diagnosis only), share aged 75 and over

Health Foundation definitions ("Longer hospital stays and fewer admissions", 2023, record-level HES, adults): mean stay
over admissions lasting at least one night, day cases and same-day admissions left out; same-day share reported
separately. The published tables do not split bed days by admission method, and sharing each diagnosis's bed days out by
its admissions (above) gives planned patients the same stays as emergency ones, which understates emergency stays. So,
as in scripts/build_inputs.py, emergency stays are measured on diagnoses where at least 85% of admissions are
emergencies (about half of all emergency admissions), and planned stays on diagnoses where at least 85% are planned:
  hf_em_los                 nights per overnight admission, emergency-dominated diagnoses (from 2013/14)
  hf_el_los                 nights per overnight admission, planned-dominated diagnoses (from 2013/14)
  hf_em_bd_per_adm          nights per admission, emergency-dominated diagnoses, same-day admissions included (all years)
Against the Health Foundation's figures (2019 and 2022, calendar years, adults): emergency 7.9 and 9.1, planned 5.2 and
5.1, all overnight admissions 7.3 and 8.3 (printed by this script as a check).

Writes data/processed/hes_admissions.csv and returns the table.  Usage: python scripts/hes_admissions.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT = ROOT / "data" / "raw", ROOT / "data" / "processed"


def _files() -> dict[str, Path]:
    out = {}
    for d in ("hes_apc_diag_old_mirror", "hes_apc_diag_mirror", "hes_files"):
        for f in sorted((RAW / d).glob("*.xls*")):
            m = re.search(r"diag-(20\d\d)-(\d\d)-tab", f.name) or re.search(r"3cha-(\d\d)-(\d\d)-tab", f.name)
            if m:
                y = m.group(1) if len(m.group(1)) == 4 else "20" + m.group(1)
                out[f"{y}/{m.group(2)}"] = f
    return dict(sorted(out.items()))


def parse(f: Path) -> pd.DataFrame:
    x = pd.ExcelFile(f)
    sh = next(s for s in x.sheet_names if re.search(r"(?i)primary diag.*3", s))
    d = pd.read_excel(f, sheet_name=sh, header=None)
    h = next(i for i in range(40) if d.iloc[i].astype(str).str.contains(r"(?i)fce bed days").any())
    names = [re.sub(r"\s+", " ", str(v)).strip().lower() for v in d.iloc[h]]
    code = d[0].astype(str).str.extract(r"^\s*([A-Z]\d\d)\b")[0]
    rows = d[code.notna()].copy()
    rows["code"] = code[code.notna()]
    num = lambda j: pd.to_numeric(rows[j], errors="coerce").fillna(0).to_numpy()  # noqa: E731
    first = lambda pat: next(j for j, n in enumerate(names) if re.match(pat, n))  # noqa: E731
    jbd = first(r"fce bed days")
    out = pd.DataFrame({"code": rows.code.to_numpy(), "fae": num(first(r"admissions|finished admission")),
                        "emergency": num(first(r"emergency")), "day_case": num(first(r"day case")), "bed_days": num(jbd)})
    if d.shape[1] > jbd + 3 and re.search(r"(?i)zero bed day", " ".join(map(str, d.iloc[h - 1].tolist()))):
        for k, nm in enumerate(("zero_emergency", "zero_elective", "zero_other")):
            out[nm] = num(jbd + 1 + k)
    ages = {}
    for j, n in enumerate(names):
        m = re.match(r"age (\d+)(?:-(\d+)|(\+))?", n)
        if m:
            ages[j] = int(m.group(1))
    tot = sum(num(j) for j in ages)
    old = sum(num(j) for j, a in ages.items() if a >= 75)
    out["share75"] = np.where(tot > 0, old / np.where(tot > 0, tot, 1), 0)
    return out


HF = {"2019/20": dict(em=7.9, el=5.2, all=7.3), "2022/23": dict(em=9.1, el=5.1, all=8.3)}  # calendar 2019 and 2022, adults


def summarise(fy: str, t: pd.DataFrame) -> dict:
    g = t[~t.code.str.match(r"^(O|P|F[1-9])") & (t.code != "Z38")]
    es = (g.emergency / g.fae.replace(0, np.nan)).fillna(0).clip(0, 1)
    e_dom, l_dom = g[es >= 0.85], g[(es <= 0.15) & (g.fae > 0)]
    ebd = (g.bed_days * es).sum()
    r = {"fy": fy, "admissions": g.fae.sum(), "emergency": g.emergency.sum(), "day_case": g.day_case.sum(), "bed_days": g.bed_days.sum(),
         "emergency_bed_days": ebd, "em_bd_per_adm": ebd / g.emergency.sum(),
         "share75_emergency": (g.emergency * g.share75).sum() / g.emergency.sum(),
         "hf_em_bd_per_adm": e_dom.bed_days.sum() / e_dom.fae.sum(), "hf_em_coverage": e_dom.emergency.sum() / g.emergency.sum()}
    if "zero_emergency" in g:
        r["zero_emergency"] = g.zero_emergency.sum()
        r["zero_all"] = (g.zero_emergency + g.zero_elective + g.zero_other).sum()
        r["em_overnight"] = r["emergency"] - r["zero_emergency"]
        r["em_bd_per_overnight"] = ebd / r["em_overnight"]
        r["overnight"] = r["admissions"] - r["day_case"] - r["zero_all"]
        r["bd_per_overnight"] = r["bed_days"] / r["overnight"]
        r["em_same_day_share"] = r["zero_emergency"] / r["emergency"]
        ov = lambda d: (d.fae - d.day_case - d.zero_emergency - d.zero_elective - d.zero_other).sum()  # noqa: E731
        r["hf_em_los"] = e_dom.bed_days.sum() / ov(e_dom)
        r["hf_el_los"] = l_dom.bed_days.sum() / ov(l_dom)
    return r


def hes_admissions() -> pd.DataFrame:
    rows = [summarise(fy, parse(f)) for fy, f in _files().items()]
    t = pd.DataFrame(rows)
    t.to_csv(OUT / "hes_admissions.csv", index=False)
    return t


if __name__ == "__main__":
    pd.set_option("display.width", 200)
    t = hes_admissions()
    print(t.round(3).to_string(index=False))
    for fy, h in HF.items():
        r = t[t.fy == fy].iloc[0]
        print(f"{fy} vs Health Foundation: emergency {r.hf_em_los:.2f} ({h['em']}), planned {r.hf_el_los:.2f} ({h['el']}), "
              f"all overnight {r.bd_per_overnight:.2f} ({h['all']})")
    sys.exit(0)
