// Calibrate the simulator to processed inputs and write web/data/baseline.json.
//
// Usage: node scripts/calibrate.mjs [data/processed/model_inputs.json]
//
// Uses the same model code as the website (web/js/model.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inPath = process.argv[2] || path.join(ROOT, "data/processed/model_inputs.json");
const inp = JSON.parse(fs.readFileSync(inPath, "utf8"));
const log = (...a) => console.log(...a);

const POOL_B = 1000;
const REPS = 24, REPS_B = 4;

// A "base" object in the shape the website uses; calibration fields filled in below.
const base = {
  generated: new Date().toISOString().slice(0, 10),
  baseYear: inp.baseYear,
  national: inp.national,
  ageBands: inp.ageBands,
  ageNote: inp.ageNote,
  conditions: inp.conditions,
  conditionNote: inp.conditionNote,
  otherConditionLosMult: inp.otherConditionLosMult,
  presets: inp.presets,
  inputs: inp.inputs,
  bedHistory: inp.bedHistory,
  rawFiles: inp.rawFiles,
  riskFactors: inp.riskFactors,
  deprivation: inp.deprivation,
  flu: inp.flu ? { ...inp.flu, admissions: inp.flu.admissionsGuess || 50000 } : undefined,
  calibration: {
    A: { poolSize: 92, losMedianDays: 3, delayMeanDays: 4 },
    B: { poolSize: POOL_B, losMedianDays: 3, delayMeanDays: 4 },
    targets: inp.targets,
  },
};

function paramsFor(which, overrides = {}, settingsOverride = {}) {
  const s = { ...defaultSettings(base), ...settingsOverride, flexibility: which };
  return { ...buildParams(base, s), ...overrides };
}

function fitLosDelay(which, occT, nctrT, reps, extra = {}, settingsOverride = {}) {
  const cal = base.calibration[which];
  for (let it = 0; it < 4; it++) {
    let lo = 0.3, hi = 12;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      cal.losMedianDays = mid;
      const r = run(paramsFor(which, extra, settingsOverride), reps);
      if (r.occMidnight < occT) lo = mid; else hi = mid;
    }
    cal.losMedianDays = (lo + hi) / 2;
    const r = run(paramsFor(which, extra, settingsOverride), reps);
    const ratio = nctrT / Math.max(r.nctrShare, 1e-6);
    if (Math.abs(ratio - 1) < 0.02) break;
    cal.delayMeanDays = Math.max(0.05, cal.delayMeanDays * ratio);
  }
  return { ...cal };
}

const T = inp.targets;
log("Targets", T);

// --- size of the flu wave: scale flu admissions so the simulated peak number of flu
// patients in beds matches the observed peak (peak occupancy is proportional to admissions)
if (base.flu) {
  base.calibration.A.poolSize = 100;
  for (let it = 0; it < 3; it++) {
    fitLosDelay("A", T.occupancy, T.nctrShare, 12);
    const r = run(paramsFor("A"), 12);
    const ratio = base.flu.peakBedsTarget / r.fluBedsPeak;
    log("flu admissions", Math.round(base.flu.admissions), "peak beds", Math.round(r.fluBedsPeak));
    base.flu.admissions *= ratio;
    if (Math.abs(ratio - 1) < 0.03) break;
  }
  base.flu.admissions = Math.round(base.flu.admissions);
}

// --- model A: grid over pool sizes, interpolate on log(>12h share)
const grid = [];
for (const S of [50, 70, 90, 110, 140, 200, 300]) {
  base.calibration.A.poolSize = S;
  const c = fitLosDelay("A", T.occupancy, T.nctrShare, REPS);
  const r = run(paramsFor("A"), REPS);
  grid.push({ S, ...c, wait12: r.wait12, occ: r.occMidnight });
  log("pool", S, "wait12", r.wait12.toFixed(4), "occ", r.occMidnight.toFixed(4));
}
const lw = (x) => -Math.log(Math.max(x, 1e-6));
let S_A = grid[grid.length - 1].S;
for (let i = 0; i < grid.length - 1; i++) {
  const a = grid[i], b = grid[i + 1];
  if ((lw(a.wait12) - lw(T.wait12Share)) * (lw(b.wait12) - lw(T.wait12Share)) <= 0) {
    S_A = Math.round(a.S + (b.S - a.S) * (lw(T.wait12Share) - lw(a.wait12)) / (lw(b.wait12) - lw(a.wait12)));
    break;
  }
}
base.calibration.A.poolSize = S_A;
fitLosDelay("A", T.occupancy, T.nctrShare, REPS);
base.calibration.B.poolSize = POOL_B;
base.calibration.B.losMedianDays = base.calibration.A.losMedianDays;
base.calibration.B.delayMeanDays = base.calibration.A.delayMeanDays;
fitLosDelay("B", T.occupancy, T.nctrShare, REPS_B);
log("Calibrated", base.calibration);

// --- validation
const rA = run(paramsFor("A"), 40), rB = run(paramsFor("B"), 8);
const fmtP = (x, d = 1) => (100 * x).toFixed(d) + "%";
const validation = [
  { check: `${inp.baseYearLabel} average G&A occupancy (calibration target)`, observed: fmtP(T.occupancy), modelA: fmtP(rA.occMidnight), modelB: fmtP(rB.occMidnight), comment: "Calibrated: matches by construction." },
  { check: `${inp.baseYearLabel} beds occupied by patients fit to leave (calibration target)`, observed: fmtP(T.nctrShare), modelA: fmtP(rA.nctrShare), modelB: fmtP(rB.nctrShare), comment: "Calibrated." },
  { check: `${inp.baseYearLabel} emergency admissions waiting >12h for a bed`, observed: fmtP(T.wait12Share, 2), modelA: fmtP(rA.wait12, 2), modelB: fmtP(rB.wait12, 2), comment: "Today's system is calibrated to this; the flexible system is not, and under-predicts it." },
];
const staticOcc = rA.occupiedBedsNational / inp.national.beds;
validation.push({ check: "Simple ratio check: occupied beds ÷ beds", observed: fmtP(T.occupancy), modelA: fmtP(staticOcc), modelB: "", comment: "Consistency check on the simulation's bed-day accounting." });

// seasonal pattern vs observed monthly occupancy (if supplied)
if (inp.monthlyOccupancy && inp.monthlyOccupancy.length === 12) {
  const MS = [0, 30, 61, 91, 122, 153, 183, 214, 245, 275, 306, 334, 365];
  const mm = MS.slice(0, 12).map((s, i) => rA.daily.slice(s, MS[i + 1]).reduce((a, b) => a + b, 0) / (MS[i + 1] - s));
  const obs = inp.monthlyOccupancy.map((m) => m.occupancy);
  const range = (a) => Math.max(...a) - Math.min(...a);
  const corr = (() => {
    const ma = mm.reduce((a, b) => a + b) / 12, mb = obs.reduce((a, b) => a + b) / 12;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { n += (mm[i] - ma) * (obs[i] - mb); da += (mm[i] - ma) ** 2; db += (obs[i] - mb) ** 2; }
    return n / Math.sqrt(da * db);
  })();
  validation.push({ check: `Seasonal swing: highest minus lowest monthly occupancy (${inp.monthlyOccupancySource})`, observed: `${(100 * range(obs)).toFixed(1)} pts`, modelA: `${(100 * range(mm)).toFixed(1)} pts`, modelB: "", comment: `Not calibrated. Correlation of monthly pattern: ${corr.toFixed(2)}. Observed is the 08:00 sitrep snapshot, model is midnight.` });
  base.monthlyValidation = MS.slice(0, 12).map((_, i) => ({ month: inp.monthlyOccupancy[i].month, observed: obs[i], model: mm[i] }));
}

// back-test(s): other years with their own beds and demand
for (const bt of inp.backtests || []) {
  const saved = JSON.parse(JSON.stringify(base.calibration));
  const res = {};
  for (const which of ["A", "B"]) {
    const settingsOverride = { beds: bt.beds, otherGrowthPct: 100 * (bt.emergPerYear / inp.national.emergPerYear - 1), popYear: inp.baseYear };
    fitLosDelay(which, bt.occupancy, bt.nctrShare, which === "A" ? REPS : REPS_B, {}, settingsOverride);
    res[which] = run(paramsFor(which, {}, settingsOverride), which === "A" ? 40 : 8);
  }
  base.calibration = saved;
  validation.push({ check: `${bt.label}: average occupancy (refitted)`, observed: fmtP(bt.occupancy), modelA: fmtP(res.A.occMidnight), modelB: fmtP(res.B.occMidnight), comment: "Length of stay and delays refitted to that year's occupancy and delayed discharges." });
  validation.push({ check: `${bt.label}: emergency admissions waiting >12h for a bed (not fitted)`, observed: fmtP(bt.wait12Share, 3), modelA: fmtP(res.A.wait12, 2), modelB: fmtP(res.B.wait12, 3), comment: bt.comment || "Out-of-sample test of the bed-pool structure." });
}
base.validation = validation;

fs.mkdirSync(path.join(ROOT, "web/data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "web/data/baseline.json"), JSON.stringify(base, null, 1));
fs.writeFileSync(path.join(ROOT, "data/processed/calibration_grid.json"), JSON.stringify(grid, null, 1));
log("Wrote web/data/baseline.json");
