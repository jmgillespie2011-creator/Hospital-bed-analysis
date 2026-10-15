# Scoping: discrete-event simulation (DES) of NHS bed occupancy

**Question:** Can we build a DES of NHS bed occupancy using only public data, and run "what if" scenarios through it, such as "bed numbers frozen at 2015/16 levels"?

**Answer: Yes, with limits.** It works for **England-wide general & acute (G&A) beds**, and probably for individual trusts or ICBs. It is not a replay of real patient records. It uses **synthetic patients** whose arrival rates and lengths of stay are fitted to published aggregate statistics. The biggest gaps are:

1. there are no public patient-level length-of-stay distributions;
2. demand that was turned away (because no bed was free) is not observed;
3. key data series change definition or break around 2020.

Each gap has a workable fix, described below.

---

## Prior work

A quick search (not a systematic review) found related work in four groups. None runs today's actual demand through the bed numbers England actually had in earlier years and reports the effects in patient terms (waits for a bed, cancelled operations). That is the gap this project would fill. The search did not cover think-tank grey literature (Nuffield Trust, RCEM, BMA) or NHS England's internal capacity modelling in depth.

| Group | Study | What it did | Relevance here |
|---|---|---|---|
| Simulation of bed occupancy | [Bagust, Place & Posnett (1999), *BMJ*](https://pubmed.ncbi.nlm.nih.gov/10406748) | Stochastic simulation of emergency admissions in a hypothetical English acute hospital; risk of no free bed as occupancy rises. Usually cited as the source of the "85% occupancy" rule of thumb | Closest in method to this project. Models one generic hospital, not real NHS bed numbers over time |
| Critiques of the 85% figure | [Keegan (2010), *Medical Journal of Australia*](https://www.mja.com.au/journal/2010/192/1/myths-ideal-hospital-occupancy); Proudlove (2020), "The 85% bed occupancy fallacy" ([talk slides](https://www.strategyunitwm.nhs.uk/sites/default/files/2024-11/MAN%20Huddle%2021.03.24.pdf)) | Argue a safe occupancy level depends on hospital size and how variable demand is, so occupancy should be treated as an output, not a target | Supports reporting waits and turned-away patients rather than occupancy % alone, and modelling at trust level |
| Bed-need projections | [Health Foundation REAL Centre (2022)](https://www.health.org.uk/sites/default/files/upload/publications/2022/Final_Beds_analysis_July2022.pdf); [peer-reviewed version, *Health Policy* (2023)](https://www.sciencedirect.com/science/article/pii/S0168851023001008) | Projects England needs ~23,000–39,000 more G&A beds by 2030/31, assuming 87% occupancy | Forward-looking demand projections, not simulations. Comparison point for our future scenarios |
| Bed-need projections | [King's Fund, "NHS hospital bed numbers: past, present, future"](https://www.kingsfund.org.uk/insight-and-analysis/long-reads/nhs-hospital-bed-numbers) | Descriptive trends; occupancy rose from 87.1% (2010/11) to over 90% | Context and cross-check on historical bed counts |
| Occupancy vs A&E performance | [Friebel & Fernandez (2020), *Health Policy*](https://pubmed.ncbi.nlm.nih.gov/32811683/) | Data from 143 English trusts: +1 percentage point occupancy linked to a 9.5 point lower chance of meeting the 4-hour target; stronger above 90% | Statistical, not a simulation. Benchmark to check our model's results against |
| Forecasting | [Emergency bed forecasting for an NHS trust (MSARIMA)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9021768/); [UK emergency bed requirement forecasting](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8517824/) | Time-series forecasts of emergency admissions and bed occupancy | Forward forecasting only; no "what if" scenarios. Possible source of seasonality assumptions |
| Python DES tooling | [Monks & Harper (2023)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10593330/) | Open-source approach for NHS DES models in Python with web front ends | Template for the build (SimPy + Streamlit) |

---

## 1. Proposed model structure

```
 Emergency arrivals ─┐                         ┌─> discharged
 (daily, seasonal)   ├─> [ G&A bed pool, N ] ──┤
 Elective arrivals ──┘     acute LOS            └─> "discharge-ready" delay ─> discharged
 (weekday, plannable)      + delayed-discharge
                           tail

 When no bed is free:
   emergency → waits in a queue (proxy for ED / corridor wait)
   elective  → cancelled / deferred (re-queued)
```

- **Unit:** one patient spell (admission to discharge), not one consultant episode.
- **Time step:** event-driven, reported daily at 08:00 to match the daily sitrep snapshot.
- **Cohorts:** admission method (emergency or elective), crossed with age band (for example 0–17, 18–64, 65–84, 85+). This gives cohorts whose lengths of stay differ meaningfully and which population projections can scale.
- **Outputs:** daily occupancy %, days above 92% or 95%, emergency bed-wait time and queue length, elective cancellations, and the number of patients staying longer than 7, 14 or 21 days.
- **Tooling:** Python plus SimPy (or `ciw`), using multiple replications and a warm-up period. An optional Streamlit front end could follow the published Monks & Harper approach for NHS DES models.

## 2. Data each parameter needs, and where it comes from

| Model input | Public source | Detail level | Period | Fit for purpose? |
|---|---|---|---|---|
| **Bed supply (N)**, G&A available and occupied | NHS England **KH03** (quarterly bed availability and occupancy) | Trust × sector (and specialty); quarterly average | 2010/11 onwards (annual back to 1987/88) | ✅ Main source for the "beds as N years ago" lever |
| **Daily occupancy** (used for validation) | NHS England **UEC daily sitreps**: G&A beds open and occupied, plus 7/14/21+ day stayers | Trust × day (winter only in early years; year-round since 2020-ish) | Winters from ~2010/11; all year recently | ✅ Main calibration target. ⚠️ 08:00 snapshot, differs from KH03 midnight count |
| **Emergency admissions** (arrival rate) | NHS England **A&E Attendances & Emergency Admissions** (monthly) | Trust × month | Weekly Nov 2010–Jun 2015, then monthly | ✅ Gives monthly arrival rates; daily and weekday pattern must be assumed or taken from HES/sitreps |
| **Elective / all admissions by age and method** | NHS England Digital **Hospital Admitted Patient Care Activity (HES APC)**, annual, plus provisional monthly HES | National / provider × age band × admission method × diagnosis / specialty | 1998/99 onwards annually | ✅ Gives cohort mix and volumes |
| **Length of stay** | HES APC tables: **mean and median LOS and bed days** by diagnosis, specialty, age, admission method | Aggregate summaries only | Annual | ⚠️ **No full distribution.** Fit lognormal or gamma curves to mean + median and calibrate the tail to the 7/14/21+ day stayer counts in the sitreps |
| **Delayed discharges** | **Acute discharge sitrep (NCTR)**: daily patients no longer meeting criteria to reside, discharged / not discharged | Provider × day | Apr 2022 onwards (definitions changed May 2024) | ✅ for recent years. ⚠️ Older **DTOC** series (Aug 2010–Feb 2020) uses a different, non-comparable measure. New GOV.UK "Discharge Ready Date" series (2025 onwards) gives delay length directly |
| **Weekday discharge pattern** | NCTR daily discharges (2022 onwards) | Provider × day | 2022 onwards | ✅ Good enough to model fewer discharges at weekends |
| **Demand growth** | **ONS** population estimates and national / subnational projections by age | Local authority × single year of age | Historical and projected | ✅ Scale cohort arrival rates by population and age |

## 3. Gaps and how to work around them

| Gap | Impact | Workaround |
|---|---|---|
| No patient-level LOS distribution (HES record-level data needs a DARS application, which can take months) | The long tail of stays drives occupancy | Fit parametric distributions per cohort to the published mean and median. Tune the tail to the sitrep 7/14/21+ day stayer counts. Run sensitivity tests on the tail shape |
| **Rationed demand is unobserved**: admissions are already shaped by current bed numbers | Feeding today's admissions into a smaller bed base understates harm; feeding them into a larger one overstates the benefit | Model rejected or deferred demand explicitly (emergency queue, elective deferral). Report "unmet demand" as an output rather than squeezing it into occupancy. State plainly that the result is "today's demand on yesterday's beds" |
| Definition breaks: KH03 (midnight, quarterly) vs sitrep (08:00, daily); DTOC → NCTR; G&A adult/paediatric split from 2025/26 | Comparisons across years are not like-for-like | Calibrate on one consistent window (suggest 2023/24–2025/26). Use KH03 only for bed **counts** in the scenario lever |
| Covid-era distortion (2020/21–2021/22): infection-control bed closures; NHS England says occupancy is not directly comparable with pre-pandemic years | Distorts calibration and the historical baseline | Exclude those years from calibration |
| Ward fragmentation: in reality beds are split by specialty and sex, so a single national pool over-pools capacity | A national single-pool model looks more efficient than reality (it reaches higher occupancy for the same waits) | Run at **trust** level and/or apply an "effective pooling" factor. Check against observed occupancy at each trust. Present national results as a sum of trust runs |
| Beds ≠ staffed beds | Adding beds in a scenario assumes they come with staff | State this as a scenario assumption |

## 4. Validation plan

1. **Reproduce the base year:** feed in 2024/25 inputs and check that simulated daily G&A occupancy matches the sitrep distribution (mean, winter peak, share of days above 95%) and the number of 21+ day stayers.
2. **Back-test:** feed in 2015/16 inputs (KH03 beds, A&E emergency admissions, HES LOS, DTOC as the delay proxy). Check that the model reproduces the ~90% G&A occupancy reported for that period. This tests whether the model still holds up on data from a different period.
3. **Sensitivity:** vary LOS tail shape, pooling factor and weekend discharge drop, then report how much each one moves the headline result.

## 5. Scenarios it would support

- G&A bed count frozen at 2010/11, 2015/16 or 2019/20 levels, with today's demand
- Today's beds with 2015/16 demand (isolating the effect of an ageing population)
- Delayed discharges halved or removed
- Shorter LOS for particular cohorts
- Future demand (ONS projections to 2030/2035) with various bed growth paths

## 6. Practical blockers for building it in this environment

- **Network access:** this cloud session cannot reach `england.nhs.uk`, `digital.nhs.uk` or `ons.gov.uk` (the network policy blocks them). To download data here, add those domains under the environment's allowed domains. Otherwise the data files can be downloaded manually and committed to the repo.
- **File formats:** most sources are per-year Excel files with layouts that change from year to year. Expect real effort writing data-loading code; this is the largest single task.

## 7. Suggested phases

| Phase | Output | Rough effort |
|---|---|---|
| 1. Data collection | Scripts to download and tidy KH03, sitreps, A&E, NCTR, HES summary and ONS data into tidy CSVs | Largest phase (messy Excel files) |
| 2. Static and queueing baseline | Simple ratio and Erlang model as a sense check (Option 1/2) | Small |
| 3. DES core | SimPy model: national single pool, then trust level | Medium |
| 4. Calibration and validation | Base-year fit, 2015/16 back-test, sensitivity | Medium |
| 5. Scenarios and reporting | Scenario runner, charts, optional Streamlit / interactive page | Small–medium |

**Recommendation:** go ahead. Start with Phase 1 plus the Phase 2 sense check. That confirms the data actually loads and gives an early answer to "beds as 10 years ago" before investing in the full simulation.

## Sources

- [KH03 bed availability and occupancy (statistical press notices)](https://www.england.nhs.uk/statistics/wp-content/uploads/sites/2/2024/02/KH03-Q3-2023-24-Statistical-Press-Notice-FINAL.pdf)
- [Critical care and G&A beds – UEC daily sitreps](https://www.england.nhs.uk/statistics/bed-availability-and-occupancy/critical-care-and-general-acute-beds-urgent-and-emergency-care-daily-situation-reports)
- [A&E Attendances and Emergency Admissions](https://www.england.nhs.uk/statistics/statistical-work-areas/ae-waiting-times-and-activity/ae-attendances-and-emergency-admissions-2025-26)
- [Hospital Admitted Patient Care Activity (HES APC)](https://digital.nhs.uk/data-and-information/publications/statistical/hospital-admitted-patient-care-activity/2023-24/about-this-publication)
- [Discharge delays (Acute) – NCTR](https://www.england.nhs.uk/statistics/statistical-work-areas/discharge-delays-acute-data/)
- [(Discontinued) Delayed Transfers of Care](https://www.england.nhs.uk/statistics/statistical-work-areas/delayed-transfers-of-care/)
- [Timeliness of acute hospital discharges (Discharge Ready Date)](https://www.gov.uk/government/statistics/timeliness-of-acute-hospital-discharges-discharge-ready-date-for-july-2026)
- [Monks & Harper – open health DES models in Python and web apps](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10593330/)
