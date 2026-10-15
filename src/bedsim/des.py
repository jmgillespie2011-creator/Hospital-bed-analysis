"""Discrete-event simulation of general & acute (G&A) bed occupancy.

The national bed base is represented as a set of identical, independent
"effective pools" of ``pool_size`` beds (a proxy for the fragmentation of real
hospitals into trusts, wards and specialties). One pool is simulated per
replication; demand is the national demand divided by the number of pools.

Patients
--------
* Emergency admissions arrive as a non-homogeneous Poisson process with
  seasonal, weekday and hour-of-day variation. A share are same-day stays
  (a few hours, never in a bed at midnight). The rest have a lognormal acute
  length of stay; a share of those then have a delayed-discharge period
  ("no criteria to reside"). If no bed is free they queue (a proxy for waiting
  in A&E after a decision to admit) and are admitted first-come-first-served.
* Elective (overnight) admissions arrive on weekdays 11:00-15:00. If no bed is
  free they wait, behind any queueing emergency patients, until 20:00; if still
  without a bed the admission is cancelled (not rebooked).
* Discharges only happen 10:00-20:00 and a share of weekend discharges slip
  to Monday.

Occupancy is measured at midnight (as in KH03) and at 08:00 (as in the daily
sitreps).
"""

from __future__ import annotations

import heapq
from collections import deque
from dataclasses import dataclass, replace

import numpy as np

HOURS_PER_DAY = 24
DAYS_PER_YEAR = 365.0

# Relative emergency admission rate by hour of day (decision-to-admit times
# cluster from late morning to evening). Normalised to mean 1 below.
_HOURLY = np.array([0.45, 0.35, 0.3, 0.25, 0.25, 0.3, 0.45, 0.7, 1.0, 1.25, 1.4, 1.5,
                    1.55, 1.55, 1.5, 1.45, 1.4, 1.35, 1.3, 1.2, 1.05, 0.9, 0.7, 0.55])
_HOURLY = _HOURLY / _HOURLY.mean()
# Day of week, Monday first. Mondays are busiest, weekends quieter.
_WEEKDAY = np.array([1.10, 1.03, 1.0, 1.0, 1.02, 0.93, 0.92])
_WEEKDAY = _WEEKDAY / _WEEKDAY.mean()


@dataclass(frozen=True)
class Params:
    beds_national: float
    emerg_per_year: float
    elec_per_year: float
    pool_size: int = 200
    # Emergency overnight acute length of stay (days), lognormal.
    los_median_days: float = 3.0
    los_sigma: float = 1.0
    same_day_frac: float = 0.30
    # Delayed discharge after becoming medically fit.
    delay_prob: float = 0.20
    delay_mean_days: float = 5.0
    # Elective overnight length of stay (days), lognormal.
    elec_los_median_days: float = 2.0
    elec_los_sigma: float = 0.8
    season_amp: float = 0.04  # +/- share of emergency demand, peak mid-January
    weekend_defer_prob: float = 0.5
    days: int = 365
    warmup_days: int = 60

    @property
    def n_pools(self) -> float:
        return self.beds_national / self.pool_size

    def with_(self, **kw) -> "Params":
        return replace(self, **kw)


@dataclass
class Result:
    occ_midnight: float
    occ_8am: float
    share_nights_full: float
    nctr_share: float
    emerg_admitted: int
    wait_mean_h: float
    share_wait_4h: float
    share_wait_12h: float
    elec_offered: int
    elec_cancelled: int
    daily_occ: np.ndarray  # midnight occupancy by day (post warm-up)

    @property
    def elec_cancel_rate(self) -> float:
        return self.elec_cancelled / max(self.elec_offered, 1)


def _discharge_time(ready: float, day0_dow: int, rng: np.random.Generator,
                    defer_p: float) -> float:
    """Move a clinically-ready time into the next discharge window."""
    day, hr = divmod(ready, HOURS_PER_DAY)
    if hr < 10:
        t = day * 24 + 10 + rng.random() * 10
    elif hr >= 20:
        day += 1
        t = day * 24 + 10 + rng.random() * 10
    else:
        t = ready
    dow = int(day + day0_dow) % 7
    if dow >= 5 and rng.random() < defer_p:
        day += 7 - dow  # to Monday
        t = day * 24 + 10 + rng.random() * 10
    return t


def simulate(p: Params, seed: int = 0) -> Result:
    rng = np.random.default_rng(seed)
    n_days = p.warmup_days + p.days
    S = int(p.pool_size)
    warm_h = p.warmup_days * 24.0
    end_h = n_days * 24.0
    # Simulated year starts on 1 April (day-of-year ~91); 1 April 2024 was a Monday.
    doy0, dow0 = 91 - p.warmup_days, 0

    # --- emergency arrivals -------------------------------------------------
    lam_day = p.emerg_per_year / DAYS_PER_YEAR / p.n_pools
    days = np.arange(n_days)
    season = 1 + p.season_amp * np.cos(2 * np.pi * (days + doy0 - 15) / 365.0)
    weekday = _WEEKDAY[(days + dow0) % 7]
    rate_h = (lam_day / 24.0) * np.repeat(season * weekday, 24) * np.tile(_HOURLY, n_days)
    counts = rng.poisson(rate_h)
    arr = np.repeat(np.arange(n_days * 24, dtype=float), counts) + rng.random(counts.sum())
    arr.sort()
    n_em = arr.size
    same_day = rng.random(n_em) < p.same_day_frac
    sd_dur = rng.uniform(3, 10, n_em)
    los_h = 24 * p.los_median_days * np.exp(p.los_sigma * rng.standard_normal(n_em))
    delayed = rng.random(n_em) < p.delay_prob
    delay_h = 24 * rng.gamma(1.5, p.delay_mean_days / 1.5, n_em)

    # --- elective arrivals (weekday mornings) --------------------------------
    lam_el = p.elec_per_year / DAYS_PER_YEAR / p.n_pools * 7 / 5
    el_times = []
    for d in range(n_days):
        if (d + dow0) % 7 < 5:
            k = rng.poisson(lam_el)
            el_times.extend(d * 24 + 11 + 4 * rng.random(k))
    el = np.sort(np.array(el_times))
    el_los_h = 24 * p.elec_los_median_days * np.exp(p.elec_los_sigma * rng.standard_normal(el.size))

    # --- event loop ----------------------------------------------------------
    heap: list[tuple[float, int]] = []  # (discharge time, patient key)
    ready_of: dict[int, float] = {}      # in-bed patient key -> clinically-ready time
    queue: deque[int] = deque()          # waiting emergency patient indices
    el_queue: deque[int] = deque()       # waiting elective patient indices
    free = S
    ia = ie = 0
    snap_t = 0.0
    waits: list[float] = []
    elec_offered = elec_cancelled = 0
    occ_mid, occ_8, nctr = [], [], []
    key = 0

    def admit_elective(j: int, t: float) -> None:
        nonlocal key
        key += 1
        dis = _discharge_time(t + el_los_h[j], dow0, rng, p.weekend_defer_prob)
        heapq.heappush(heap, (dis, key))
        ready_of[key] = dis

    def el_deadline(j: int) -> float:
        return (el[j] // 24) * 24 + 20

    def admit_emergency(i: int, t: float) -> None:
        nonlocal key
        key += 1
        if same_day[i]:
            ready = dis = t + sd_dur[i]
        else:
            ready = _discharge_time(t + los_h[i], dow0, rng, p.weekend_defer_prob)
            dis = ready
            if delayed[i]:
                dis = _discharge_time(ready + delay_h[i], dow0, rng, p.weekend_defer_prob)
        heapq.heappush(heap, (dis, key))
        ready_of[key] = ready if not same_day[i] else dis

    INF = float("inf")
    while True:
        ta = arr[ia] if ia < n_em else INF
        te = el[ie] if ie < el.size else INF
        td = heap[0][0] if heap else INF
        t = min(ta, te, td, snap_t)
        if t >= end_h:
            break
        if t == snap_t:
            if t >= warm_h:
                occ = S - free
                if (t / 24) % 1 == 0:
                    occ_mid.append(occ)
                    nctr.append(sum(1 for r in ready_of.values() if r <= t))
                else:
                    occ_8.append(occ)
            snap_t += 8.0 if (snap_t / 24) % 1 == 0 else 16.0
        elif t == td:
            _, k = heapq.heappop(heap)
            del ready_of[k]
            free += 1
            if queue:
                i = queue.popleft()
                free -= 1
                if arr[i] >= warm_h:
                    waits.append(t - arr[i])
                admit_emergency(i, t)
            else:
                while el_queue:
                    j = el_queue.popleft()
                    if t <= el_deadline(j):
                        free -= 1
                        admit_elective(j, t)
                        break
                    if el[j] >= warm_h:
                        elec_cancelled += 1
        elif t == ta:
            if free > 0:
                free -= 1
                if ta >= warm_h:
                    waits.append(0.0)
                admit_emergency(ia, t)
            else:
                queue.append(ia)
            ia += 1
        else:  # elective
            if te >= warm_h:
                elec_offered += 1
            if free > 0:
                free -= 1
                admit_elective(ie, t)
            else:
                el_queue.append(ie)
            ie += 1

    elec_cancelled += sum(1 for j in el_queue if el[j] >= warm_h)
    # Patients still queueing at the end: count their (censored) waits.
    waits.extend(end_h - arr[i] for i in queue if arr[i] >= warm_h)
    w = np.array(waits) if waits else np.zeros(1)
    om = np.array(occ_mid, dtype=float)
    return Result(
        occ_midnight=om.mean() / S,
        occ_8am=np.mean(occ_8) / S,
        share_nights_full=float((om >= S).mean()),
        nctr_share=float(np.sum(nctr) / max(om.sum(), 1)),
        emerg_admitted=len(waits),
        wait_mean_h=float(w.mean()),
        share_wait_4h=float((w > 4).mean()),
        share_wait_12h=float((w > 12).mean()),
        elec_offered=elec_offered,
        elec_cancelled=elec_cancelled,
        daily_occ=om / S,
    )


@dataclass
class Summary:
    occ_midnight: float
    occ_8am: float
    share_nights_full: float
    nctr_share: float
    wait_mean_h: float
    share_wait_4h: float
    share_wait_12h: float
    elec_cancel_rate: float
    occ_midnight_sd: float
    share_wait_12h_sd: float
    daily_occ: np.ndarray

    def as_row(self) -> dict:
        d = {k: v for k, v in self.__dict__.items() if k != "daily_occ"}
        return d


def run(p: Params, reps: int = 20, seed0: int = 1000) -> Summary:
    """Run ``reps`` replications (each one effective pool) and average them.

    Fixed seeds give common random numbers across scenarios.
    """
    rs = [simulate(p, seed0 + r) for r in range(reps)]
    occ = np.array([r.occ_midnight for r in rs])
    w12 = np.array([r.share_wait_12h for r in rs])
    n = np.array([r.emerg_admitted for r in rs], dtype=float)
    wt = lambda a: float(np.average(a, weights=n))  # noqa: E731
    return Summary(
        occ_midnight=float(occ.mean()),
        occ_8am=float(np.mean([r.occ_8am for r in rs])),
        share_nights_full=float(np.mean([r.share_nights_full for r in rs])),
        nctr_share=float(np.mean([r.nctr_share for r in rs])),
        wait_mean_h=wt([r.wait_mean_h for r in rs]),
        share_wait_4h=wt([r.share_wait_4h for r in rs]),
        share_wait_12h=wt(w12),
        elec_cancel_rate=float(np.sum([r.elec_cancelled for r in rs]) /
                               max(np.sum([r.elec_offered for r in rs]), 1)),
        occ_midnight_sd=float(occ.std(ddof=1) / np.sqrt(reps)),
        share_wait_12h_sd=float(w12.std(ddof=1) / np.sqrt(reps)),
        daily_occ=np.mean([r.daily_occ for r in rs], axis=0),
    )
