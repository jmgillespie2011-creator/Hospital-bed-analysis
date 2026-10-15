# Model validation plan

The simulator will be used to compare policies, so it has to show that it reproduces reality, especially on data it was **not** tuned to. This plan follows the usual structure for simulation models in health care:

1. **Verification:** does the code do what the design says?
2. **Calibration:** fit the few unknown parameters.
3. **Validation:** compare with data the model has not seen.
4. **Sensitivity / uncertainty analysis.**

All results will be published on the website's Validation page, failures included.

## 1. Verification (automated, runs on every push)

`tests/model.test.mjs` runs in GitHub Actions (`.github/workflows/tests.yml`).

| Test | What it checks |
|---|---|
| Little's law | Simulated average beds occupied ≈ admissions × mean bed-days per admission, with ample beds |
| Conservation | Every admitted patient is discharged or still in a bed at the end; occupied beds never exceed capacity |
| Limits | No waits with huge capacity; waits explode when demand exceeds capacity |
| Monotonicity | More beds never increase occupancy or waits; more demand never decreases them (beyond simulation noise) |
| Lever direction | Each policy lever moves results in the expected direction (e.g. less smoking → fewer admissions) |
| Attributable-fraction maths | Lever formulas reproduce hand-calculated values |
| Reproducibility | Same seed gives identical results; the 2024/25 baseline stays within tolerance of the published calibration (regression test) |
| Random-number generator | Samples from the Poisson, normal and gamma generators have the right mean and variance |

## 2. Calibration (separate from validation data)

- **Fitted to 2023/24 only:**
  - mean G&A occupancy (KH03)
  - NCTR (delayed-discharge) beds (acute discharge sitrep)
  - share of emergency admissions waiting >12h from decision to admit (A&E monthly)
  - flu peak beds (UEC sitrep).
- Unknowns fitted: median length of stay, delay length, effective pool size, flu wave size.
- Everything else (2024/25, earlier years, individual trusts, daily patterns) is kept back for validation.

## 3. Validation against data not used in calibration

| # | Test | Data | Pass criterion (set in advance) |
|---|---|---|---|
| V1 | **Next-year forecast**: run 2024/25 with 2024/25 beds and admissions, fixed 2023/24 parameters | KH03, A&E, NCTR 2024/25 | Occupancy within ±1.5 pts; >12h share within a factor of 1.5 |
| V2 | **Back-casting**: each year 2010/11–2024/25 with that year's beds, admissions and delays | KH03 time series, A&E, DTOC/NCTR | Occupancy trend tracked: mean absolute error < 2 pts. Waits reported, not scored, given the known structural change (see section 5) |
| V3 | **Daily distribution**: daily G&A occupancy distribution (mean, SD, 5th/95th percentiles, % of days > 95%) | UEC daily sitreps | Simulated SD and percentiles within 1 pt of observed |
| V4 | **Seasonal pattern**: monthly occupancy profile | Sitreps | Correlation > 0.7; peak month correct |
| V5 | **Day-of-week pattern**: occupancy by weekday (weekend discharge dip, Monday peak) | Sitreps | Correct shape; amplitude within 50% |
| V6 | **Long stays**: patients in hospital 7+, 14+ and 21+ days | Sitreps long-stay counts | Within 20% (tests the length-of-stay tail) |
| V7 | **Trust-level cross-section**: run each acute trust with its own beds and emergency admissions; compare predicted vs observed occupancy and >12h waits across ~120 trusts | KH03 by trust, A&E by trust, sitreps by trust | Calibration slope 0.8–1.2 for occupancy; rank correlation > 0.5 for waits |
| V8 | **Flu seasons**: simulated flu wave timing and size vs observed flu beds, season by season | Sitrep flu beds 2022/23 onwards | Peak timing ±2 weeks once the season's size is set |
| V9 | **Natural experiment, COVID 2020/21**: emergency demand fell sharply; does the model reproduce the fall in occupancy given observed admissions and the bed closures? | KH03, A&E 2020/21 | Direction and size within ±3 pts |

## 4. Validating the policy-lever effects

Effects come from the area-level analysis (`docs/effects-analysis.md`). They are checked by:

- **Out-of-sample prediction:** leave-one-year-out and leave-one-region-out cross-validation of the area regressions, reporting prediction error.
- **Comparison with independent epidemiology:** data-derived effects of smoking, obesity and alcohol compared with published attributable-admission estimates (NHS Digital/OHID) and cohort studies. Disagreements are reported, not hidden.
- **Placebo tests:** risk factors should not predict outcomes they cannot plausibly cause. For example, smoking prevalence should not "explain" admissions for injuries once deprivation is controlled. A significant placebo effect flags confounding.
- **Stability:** effects re-estimated with and without area fixed effects, and with different sets of control variables.

## 5. Known structural issue to test directly

The earlier version found that no single bed-pool structure reproduces both 2015/16 and 2024/25 waits. V2 and V7 test this explicitly:

- Is the change a step after 2020 (pandemic reconfiguration)?
- Or a gradual drift?
- Does it differ by trust?

The answer decides how the "today's system" and "more flexible system" range is presented.

## 6. Sensitivity and uncertainty

- **One-at-a-time sensitivity:** each assumed shape (hourly/weekday profile, LOS spread σ, delay distribution, discharge window) varied over a plausible range. Report the change in baseline-to-scenario differences for standard scenarios.
- **Parameter uncertainty:** lever effects carry confidence intervals from the regressions. The website shows a range by re-running with low/high estimates.
- **Simulation noise:** standard errors from replications shown alongside results.

## 7. Reporting

- Validation page on the website: table of V1–V9 with pass/fail against the criteria above, plus charts (predicted vs observed by year, by trust, daily distribution).
- Script: `scripts/validate.mjs` writes `web/data/validation.json`; re-run whenever data or model change.
