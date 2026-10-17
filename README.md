# NHS bed occupancy simulator

A discrete-event simulation of general and acute (G&A) hospital beds in England. Change bed numbers, staffing, discharge practice, the population, or a few public-health settings, and it reruns a year of synthetic patients and shows occupancy and waits for a bed.

It is for research and for those "what if" questions. It is a research model, not an official NHS statistic.

The site is [https://nhs-bed-occupancy-simulator.vercel.app](https://nhs-bed-occupancy-simulator.vercel.app).

## How the model works

The engine is `web/js/model.js`. The browser runs it in a web worker (`web/js/worker.js`). Calibration in Node imports the same file.

England's beds are not one shared pool. The model splits available beds into many identical pools, simulates one pool, and scales the counts back to England. The fitted pool is about 60 beds for today's hospitals and about 102 beds for pre-pandemic flexibility. In `web/data/baseline.json` those are `calibration.A.poolSize` 59.7553572564957 and `calibration.B.poolSize` 101.62513437786383. The [Methods](web/methods.html) page also describes the pre-pandemic pool as about 102 beds. Smaller pools share less, so the same occupancy produces more waiting.

Emergency patients arrive through the day and night, with weekday and seasonal patterns. Planned overnight patients arrive on weekday afternoons. Length of stay is random. Some emergency patients go home the same day. Some overnight patients are delayed after they are medically fit. A patient who becomes fit is confirmed at the next morning ward round (09:00 to 12:00) and then leaves during the daytime discharge window, after a short preparation time. Only some of the patients who are ready at the weekend leave at the weekend.

Available beds are physical beds times the share of nursing posts filled, and staffing cannot make more beds than exist. Extra winter beds can be opened from 1 December to 31 March. Corridor spaces are used only when every proper bed in the pool is full.

Scenarios share random numbers. Arrivals are drawn at a reference rate and then kept or dropped to match the scenario, and each patient keeps their own draws. Less demand removes some patients and leaves the others unchanged, so the comparison is not a fresh set of random patients.

The baseline year is 2025/26 (`baseYearLabel` in `web/data/baseline.json`).

## Layout

- `web/` is the site: plain HTML, CSS, and ES-module JavaScript. Chart.js 4.4.1 is vendored at `web/vendor/chart-4.4.1.umd.min.js`. Pages are Model (`index.html`), Blog, Methods, Data & sources, and Validation. The JSON those pages load is in `web/data/`, including `baseline.json`.
- `tests/model.test.mjs` checks the engine.
- `scripts/` holds the analysis. The `.mjs` scripts call `web/js/model.js`. The `.py` scripts build tables from the raw files and run checks that do not need the simulator. `scripts/calibrate.mjs` writes the baseline the site loads.
- `data/raw/` is the downloaded NHS England, NHS England Digital, ONS and OHID files, with `manifest.csv`. `data/processed/` holds the tidy tables and `model_inputs.json`. `data/inputs/` holds only the old headline file described below.
- `src/bedsim/` is the earlier Python simulator. It is legacy. The site does not use it. `scripts/run_analysis.py` still runs that model and writes charts to `outputs/`.
- `docs/` has a scoping note, an older results write-up, and the validation plan. `docs/results.md` describes that earlier Python run, on 2024/25 headline figures, rather than the current website.

## Run the site locally

Nothing to install for the site. Serve `web/` over HTTP. The pages use ES modules and a worker, so opening the HTML files directly will not run the model.

```bash
python3 -m http.server 8000 --directory web
```

Then open [http://localhost:8000/](http://localhost:8000/).

## Tests

```bash
node --test tests/model.test.mjs
```

That is the command in `.github/workflows/tests.yml`, which uses Node 22. There is no `package.json` and no `npm install`.

## Calibration

`scripts/calibrate.mjs` reads `data/processed/model_inputs.json` and writes `web/data/baseline.json`.

```bash
node scripts/calibrate.mjs
```

`scripts/build_inputs.py` builds `model_inputs.json` from `data/raw/`. `scripts/fetch_raw_data.py` downloads those files. `.github/workflows/fetch-data.yml` runs that download on Python 3.12, with requests, beautifulsoup4 and Playwright, and commits the files back. Those fetch packages are not in `requirements.txt`.

```bash
pip install -r requirements.txt
pip install openpyxl "xlrd>=2.0.1" scipy
python3 scripts/build_inputs.py
```

`requirements.txt` lists numpy, pandas and matplotlib. The input script also needs three packages that file does not list. `openpyxl` and `xlrd` read the `.xlsx` and `.xls` workbooks. `scipy` fits the delay distribution (`from scipy import optimize, stats` in `scripts/build_inputs.py`). Without `openpyxl` the script stops on the first `.xlsx` file. Without `xlrd` it stops on `data/raw/kh03_main/Beds-Time-Series-_-1987-88-to-2009-10-XLS-34K.xls`. Without `scipy` it finishes the table reads and then stops while assembling `model_inputs.json`.

## Data and sources

Every input the site uses is listed, with its source, on the [Data & sources](web/data.html) page. That page is filled from `web/data/baseline.json`. The [Methods](web/methods.html) page describes the structure, the formulas, and what is fitted. The [Validation](web/validation.html) page says where the model matches published figures and where it does not.

The inputs behind those pages come from NHS England KH03 bed availability and occupancy, A&E attendances and emergency admissions, urgent and emergency care daily situation reports, acute discharge and Discharge Ready Date statistics, the corridor-care collection, NHS England Digital Hospital Episode Statistics, ONS population estimates and projections, and OHID Fingertips. Copies of the files are in `data/raw/`. `scripts/build_inputs.py` and `scripts/hes_admissions.py` turn them into model inputs. Each row in `web/data/baseline.json` under `inputs` names the publication and the period.

The 85% used for length of stay is a diagnosis rule, following the Health Foundation definitions in `scripts/hes_admissions.py` and `scripts/build_inputs.py`: emergency stays are measured on diagnoses where at least 85% of admissions are emergencies, and planned stays on diagnoses where at least 85% are planned. That 85% is not a bed occupancy target.

## Legacy headline file

`data/inputs/national_headline_figures.csv` is not used by the website or by `web/js/model.js`. The only code that reads it is the legacy script `scripts/run_analysis.py`. Several notes in the file are marked `ASSUMPTION`, including elective admissions, some population figures, the 2015/16 delayed-transfer share, and the full-year occupancy for 2024/25. The rows are for 2024/25 and earlier. The app's baseline is 2025/26. Treat the file as a leftover from the first Python model.

To rerun that old model:

```bash
pip install -r requirements.txt
PYTHONPATH=src python3 scripts/run_analysis.py
```

## Limitations

The Validation page (`web/validation.html`, "What this means for using the simulator") states these limits:

- Waits for a bed depend on how flexibly beds are used. That flexibility is inferred rather than measured. The two versions, today's hospitals and pre-pandemic flexibility, are a range.
- Waits in the model respond to occupancy several times more steeply than hospitals' waits do. Treat changes in waits as upper bounds. Occupancy is the firmer result.
- Pool size is fitted, not measured. Today's pools are fitted to the 2025/26 share of emergency admissions waiting more than 12 hours from the decision to admit. The pre-pandemic pools are fitted to 2018/19 waits counted from arrival. See the calibration section of `web/methods.html` and `scripts/calibrate.mjs`.

## Deployment

The live site is the static files in `web/`, hosted on Vercel at the address above. The Model, Methods, Data & sources and Validation pages on that host match the files in this repository. There is no application server here, and no `vercel.json`. This GitHub repository is private.
