# Hospital bed analysis

Simulation model of NHS England general & acute (G&A) bed occupancy, used to ask
"what if" questions such as *what would occupancy and A&E bed waits look like today
if England still had the number of beds it had in 2005/06, 2008/09, 2010/11 or 2015/16?*

- `docs/des-scoping.md`: scoping note (data availability, prior work, method)
- `docs/results.md`: results write-up
- `data/inputs/national_headline_figures.csv`: every input figure with its source and notes
- `src/bedsim/des.py`: discrete-event simulation
- `src/bedsim/calibrate.py`: calibration routines
- `scripts/run_analysis.py`: calibration, back-test, scenarios and charts, written to `outputs/`

```bash
pip install -r requirements.txt
PYTHONPATH=src python3 scripts/run_analysis.py
```

The model currently runs on national headline figures gathered from published
statistics. Swapping in the raw NHS England / NHS Digital / ONS files (see the scoping
note) is the main next step.
