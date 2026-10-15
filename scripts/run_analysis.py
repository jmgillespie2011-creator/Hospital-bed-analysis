"""Calibrate the bed DES, back-test it, and run historical bed-base scenarios.

Two calibrations are carried through every scenario:

* Model A ("today's system"): effective pool size fitted so that 2024/25
  occupancy, delayed discharges AND >12h decision-to-admit waits are matched.
* Model B ("2015/16-like flexibility"): large effective pools (1,000 beds),
  which reproduce the near-zero >12h waits of 2015/16 but under-predict the
  waits seen in 2024/25.

Occupancy results barely differ between A and B; waits differ a lot, so they
are reported as a range.

Usage: PYTHONPATH=src python3 scripts/run_analysis.py
Writes CSVs and charts to outputs/.
"""

from __future__ import annotations

import json
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from bedsim.calibrate import fit_los_and_delay, fit_pool_size  # noqa: E402
from bedsim.des import Params, run  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs"
OUT.mkdir(exist_ok=True)
REPS_A, REPS_B = 40, 6
POOL_B = 1000

inp = pd.read_csv(ROOT / "data/inputs/national_headline_figures.csv").set_index("key")["value"]

# ------------------------------------------------------------ targets
beds_now = inp["ga_beds_2024_25"]
occ_now = inp["ga_occ_2024_25"]
nctr_now = inp["nctr_not_discharged_2024_25"] / (beds_now * occ_now)
wait12_now = inp["dta_12h_2024_25"] / inp["emerg_adm_2024_25"]
beds_15, occ_15, nctr_15 = inp["ga_beds_2015_16"], inp["ga_occ_2015_16"], inp["dtoc_acute_share_2015_16"]
wait12_15 = inp["dta_12h_2015"] / 5.6e6
base = Params(beds_national=beds_now, emerg_per_year=inp["emerg_adm_2024_25"],
              elec_per_year=inp["elective_ordinary_adm"])
print(f"Targets 2024/25: occupancy {occ_now:.3f}, NCTR share {nctr_now:.3f}, >12h {wait12_now:.4f}")

# ------------------------------------------------------------ model A
rows, _, _ = fit_pool_size(base, occ_now, nctr_now, wait12_now,
                           sizes=(60, 80, 90, 100, 120, 160, 240, 400), reps=20)
grid = pd.DataFrame(rows)
grid.to_csv(OUT / "calibration_pool_size.csv", index=False)
g = grid.sort_values("pool_size")
S_A = int(round(np.interp(-np.log(wait12_now), -np.log(g["share_wait_12h"].values),
                          g["pool_size"].values)))
cal_A = fit_los_and_delay(base.with_(pool_size=S_A), occ_now, nctr_now, reps=30)
p15_A = fit_los_and_delay(cal_A.with_(beds_national=beds_15, emerg_per_year=inp["emerg_adm_2015_16"]),
                          occ_15, nctr_15, reps=30)
s15_A = run(p15_A, reps=REPS_A)
print("Model A:", S_A, cal_A.los_median_days, cal_A.delay_mean_days)

# ------------------------------------------------------------ model B
cal_B = fit_los_and_delay(cal_A.with_(pool_size=POOL_B), occ_now, nctr_now, reps=4, iters=3)
p15_B = fit_los_and_delay(cal_B.with_(beds_national=beds_15, emerg_per_year=inp["emerg_adm_2015_16"],
                                      los_median_days=p15_A.los_median_days,
                                      delay_mean_days=p15_A.delay_mean_days),
                          occ_15, nctr_15, reps=4, iters=3)
s15_B = run(p15_B, reps=REPS_B)
base_A, base_B = run(cal_A, reps=REPS_A), run(cal_B, reps=REPS_B)

calib = pd.DataFrame([
    dict(model="A", year="2024/25", pool_size=S_A, occ_obs=occ_now, occ_model=base_A.occ_midnight,
         wait12_obs=wait12_now, wait12_model=base_A.share_wait_12h),
    dict(model="A", year="2015/16 (back-test)", pool_size=S_A, occ_obs=occ_15, occ_model=s15_A.occ_midnight,
         wait12_obs=wait12_15, wait12_model=s15_A.share_wait_12h),
    dict(model="B", year="2024/25", pool_size=POOL_B, occ_obs=occ_now, occ_model=base_B.occ_midnight,
         wait12_obs=wait12_now, wait12_model=base_B.share_wait_12h),
    dict(model="B", year="2015/16", pool_size=POOL_B, occ_obs=occ_15, occ_model=s15_B.occ_midnight,
         wait12_obs=wait12_15, wait12_model=s15_B.share_wait_12h),
])
calib.to_csv(OUT / "calibration_summary.csv", index=False)
print(calib.round(4).to_string())

# ------------------------------------------------------------ scenarios
pop = {y: inp[f"pop_england_{y}"] for y in (2005, 2008, 2010, 2015, 2024)}
k = inp["kh03_2010_method_break"]
beds_hist = {  # harmonised to the 2010/11+ KH03 definition
    "2005/06": inp["ga_beds_2005_06_olddef"] * k,
    "2008/09": inp["ga_beds_2008_09_olddef"] * k,
    "2010/11": inp["ga_beds_2010_11"],
    "2015/16": beds_15,
}
pop_year = {"2005/06": 2005, "2008/09": 2008, "2010/11": 2010, "2015/16": 2015}

scen: list[tuple[str, float | None, dict]] = [("Baseline 2024/25", beds_now, {})]
for yr, b in beds_hist.items():
    scen.append((f"{yr} bed count", b, {}))
    if yr in ("2005/06", "2008/09"):
        scen.append((f"{yr} bed count, as published (old definition)", b / k, {}))
for yr, b in beds_hist.items():
    scen.append((f"{yr} beds per head of population", b * pop[2024] / pop[pop_year[yr]], {}))
scen += [
    ("Delayed discharges halved", beds_now, dict(delay_scale=0.5)),
    ("Delayed discharges at 2015/16 level", beds_now, dict(delay_scale=nctr_15 / nctr_now)),
    ("2015/16 demand on today's beds", beds_now, dict(demand_2015=True)),
]

occupied_now = base_A.occ_midnight * beds_now


def scenario_params(cal: Params, p15: Params, beds: float, opts: dict) -> Params:
    if opts.get("demand_2015"):
        return p15.with_(beds_national=beds)
    p = cal.with_(beds_national=beds)
    if "delay_scale" in opts:
        p = p.with_(delay_mean_days=cal.delay_mean_days * opts["delay_scale"])
    return p


srows = []
for name, beds, opts in scen:
    sa = run(scenario_params(cal_A, p15_A, beds, opts), reps=REPS_A)
    sb = run(scenario_params(cal_B, p15_B, beds, opts), reps=REPS_B)
    n_em = inp["emerg_adm_2015_16"] if opts.get("demand_2015") else inp["emerg_adm_2024_25"]
    srows.append(dict(
        scenario=name, beds=round(beds),
        static_occ=occupied_now / beds if not opts else np.nan,
        occ_A=sa.occ_midnight, occ_B=sb.occ_midnight,
        nights_full_A=sa.share_nights_full,
        wait12_share_A=sa.share_wait_12h, wait12_share_B=sb.share_wait_12h,
        wait12_per_year_A=sa.share_wait_12h * n_em, wait12_per_year_B=sb.share_wait_12h * n_em,
        wait4_share_A=sa.share_wait_4h, elec_cancel_A=sa.elec_cancel_rate,
        elec_cancel_B=sb.elec_cancel_rate,
    ))
    print(f"{name:52s} beds {beds:9.0f} occ A {sa.occ_midnight:.3f} B {sb.occ_midnight:.3f} "
          f">12h A {sa.share_wait_12h:.4f} B {sb.share_wait_12h:.4f}")
sc = pd.DataFrame(srows)
sc.to_csv(OUT / "scenarios.csv", index=False)

# ------------------------------------------------------------ bed curve
crows = []
for b in np.arange(96_000, 150_001, 3_000):
    sa = run(cal_A.with_(beds_national=float(b)), reps=30)
    sb = run(cal_B.with_(beds_national=float(b)), reps=4)
    crows.append(dict(beds=b, occ_A=sa.occ_midnight, occ_B=sb.occ_midnight,
                      wait12_A=sa.share_wait_12h * cal_A.emerg_per_year,
                      wait12_B=sb.share_wait_12h * cal_B.emerg_per_year,
                      elec_cancel_A=sa.elec_cancel_rate))
curve = pd.DataFrame(crows)
curve.to_csv(OUT / "bed_curve.csv", index=False)

json.dump(dict(model_A=cal_A.__dict__, model_A_2015=p15_A.__dict__,
               model_B=cal_B.__dict__, model_B_2015=p15_B.__dict__,
               targets=dict(occ=occ_now, nctr=nctr_now, wait12=wait12_now)),
          open(OUT / "calibration.json", "w"), indent=2, default=float)

# ------------------------------------------------------------ charts
plt.rcParams.update({"figure.dpi": 130, "axes.spines.top": False, "axes.spines.right": False,
                     "font.size": 9})
BLUE, RED, GREY = "#1f5f99", "#c0392b", "#7f8c8d"
marks = [(beds_now, "2024/25"), (beds_hist["2008/09"], "2008/09\n& 2010/11"),
         (beds_hist["2005/06"], "2005/06")]

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(11, 4.6))
ax1.plot(curve.beds / 1000, curve.occ_A * 100, color=BLUE, lw=2)
ax1.axhline(85, color=GREY, ls="--", lw=1)
ax1.set_xlabel("G&A beds, England (thousands)")
ax1.set_ylabel("Average midnight occupancy (%)")
ax1.set_title("Occupancy with today's demand", pad=26)
ax2.fill_between(curve.beds / 1000, curve.wait12_B / 1000, curve.wait12_A / 1000,
                 color=RED, alpha=0.15, label="Range between models")
ax2.plot(curve.beds / 1000, curve.wait12_A / 1000, color=RED, lw=2, label="Model A (today's system)")
ax2.plot(curve.beds / 1000, curve.wait12_B / 1000, color=RED, lw=1.2, ls="--",
         label="Model B (2015/16-like flexibility)")
ax2.set_xlabel("G&A beds, England (thousands)")
ax2.set_ylabel("Emergency patients waiting >12h for a bed, per year (thousands)")
ax2.set_title(">12h waits for a bed with today's demand", pad=26)
ax2.legend(frameon=False)
for ax in (ax1, ax2):
    for b, lab in marks:
        ax.axvline(b / 1000, color=GREY, ls=":", lw=1)
        ax.text(b / 1000, ax.get_ylim()[1], lab, ha="center", va="bottom", fontsize=7.5)
fig.tight_layout()
fig.savefig(OUT / "bed_curve.png")

fig, ax = plt.subplots(figsize=(9, 4.2))
yrs = list(beds_hist) + ["2024/25"]
harm = [beds_hist[y] for y in beds_hist] + [beds_now]
per_head = [beds_hist[y] / pop[pop_year[y]] * 1000 for y in beds_hist] + [beds_now / pop[2024] * 1000]
x = np.arange(len(yrs))
ax.bar(x, np.array(harm) / 1000, color=BLUE, width=0.6, label="Harmonised to 2010/11+ definition")
for i, y in enumerate(yrs):
    if y in ("2005/06", "2008/09"):
        ax.bar(i, beds_hist[y] / k / 1000, color="none", edgecolor=BLUE, ls="--", width=0.6,
               label="As published (pre-2010 definition)" if y == "2005/06" else None)
    ax.text(i, harm[i] / 1000 + 1, f"{per_head[i]:.2f}\nper 1,000", ha="center", fontsize=8)
ax.set_xticks(x, yrs)
ax.set_ylabel("G&A beds (thousands)")
ax.set_ylim(0, 150)
ax.set_title("G&A beds in England, and per 1,000 population")
ax.legend(frameon=False, loc="upper right")
fig.tight_layout()
fig.savefig(OUT / "bed_history.png")

fig, ax = plt.subplots(figsize=(9, 4.2))
days = np.arange(len(base_A.daily_occ))
ax.plot(days, base_A.daily_occ * 100, label=f"Baseline ({beds_now/1000:.1f}k beds)", color=BLUE)
for yr, col in (("2008/09", "#27ae60"), ("2005/06", "#8e44ad")):
    s = run(cal_A.with_(beds_national=beds_hist[yr]), reps=REPS_A)
    ax.plot(days, s.daily_occ * 100, label=f"{yr} bed count ({beds_hist[yr]/1000:.1f}k)", color=col)
ax.axhline(85, color=GREY, ls="--", lw=1)
ax.set_xticks([0, 30, 61, 91, 122, 153, 183, 214, 244, 275, 306, 334],
              ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"])
ax.set_ylabel("Midnight occupancy (%)")
ax.set_title("Simulated daily G&A occupancy across the year, today's demand (model A)")
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(OUT / "seasonal_occupancy.png")
print("done")
