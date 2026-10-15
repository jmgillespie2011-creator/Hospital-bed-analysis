"""Calibrate the DES to observed national headline figures."""

from __future__ import annotations

import numpy as np

from .des import Params, run


def fit_los_and_delay(p: Params, occ_target: float, nctr_target: float,
                      reps: int = 20, iters: int = 4) -> Params:
    """Find the emergency LOS median and delay length that reproduce the
    observed midnight occupancy and delayed-discharge share of occupied beds."""
    for _ in range(iters):
        lo, hi = 0.3, 12.0
        for _ in range(14):
            mid = 0.5 * (lo + hi)
            s = run(p.with_(los_median_days=mid), reps=reps)
            if s.occ_midnight < occ_target:
                lo = mid
            else:
                hi = mid
        p = p.with_(los_median_days=0.5 * (lo + hi))
        s = run(p, reps=reps)
        ratio = nctr_target / max(s.nctr_share, 1e-6)
        if abs(ratio - 1) < 0.02:
            break
        p = p.with_(delay_mean_days=max(p.delay_mean_days * ratio, 0.05))
    return p


def fit_pool_size(base: Params, occ_target: float, nctr_target: float,
                  wait12_target: float, sizes=(40, 60, 80, 120, 160, 240, 400),
                  reps: int = 20):
    """For each effective pool size, fit LOS/delay, then record the share of
    emergency admissions waiting >12h. Returns the table and the best Params."""
    rows, fitted = [], {}
    for S in sizes:
        p = fit_los_and_delay(base.with_(pool_size=S), occ_target, nctr_target, reps)
        s = run(p, reps=reps)
        fitted[S] = p
        rows.append(dict(pool_size=S, los_median_days=p.los_median_days,
                         delay_mean_days=p.delay_mean_days, **s.as_row()))
    w = np.array([r["share_wait_12h"] for r in rows])
    best = min(sizes, key=lambda S: abs(rows[sizes.index(S)]["share_wait_12h"] - wait12_target))
    return rows, fitted[best], w
