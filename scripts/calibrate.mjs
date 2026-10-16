// Calibrate the simulator to measured 2025/26 targets and write web/data/baseline.json.
//
// Usage: node scripts/calibrate.mjs   (reads data/processed/model_inputs.json from scripts/build_inputs.py)
//
// Uses the same model code as the website (web/js/model.js). Each unknown parameter is fitted to
// one measured target (bisection), cycling until all targets are met together:
//   median acute length of stay  -> KH03 G&A occupancy (midnight)
//   share discharged same day    -> HES midnights per emergency admission
//   spread (sigma) of stays      -> share of occupied beds with patients in hospital 21+ days (sitrep)
//   share delayed once fit       -> share discharged after their Discharge Ready Date (DRD)
//   weekend discharging          -> weekend/weekday discharge-rate ratio (discharge sitrep)
//   flu admissions               -> peak flu patients in G&A beds (winter sitrep)
//   effective bed-pool size      -> share of emergency admissions waiting >12h from decision to admit
//   corridor (escalation) spaces -> patients receiving corridor care on G&A wards at 08:00 (NHS England
//                                   corridor-care collection, May 2026 onwards, same calendar days)
// The delay-length distribution (gamma) is fixed from the DRD delay bands.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inp = JSON.parse(fs.readFileSync(path.join(ROOT, "data/processed/model_inputs.json"), "utf8"));
const T = inp.targets;
const log = (...a) => console.log(...a);
const REPS = 48;

const base = {
  ...inp,
  generated: new Date().toISOString().slice(0, 10),
  calibration: {
    A: {
      poolSize: 90, losMedianDays: 3, losSigma: 1.1, sameDayFrac: 0.3, delayProb: 0.1,
      delayMeanDays: inp.delays.mean, delayShape: inp.delays.shape, weekendDischargePct: 75, electiveFrontLoad: 0, electiveLosSigma: 0.8,
      electiveLosMedianDays: inp.elective.meanBedDays / Math.exp(0.8 ** 2 / 2), seasonAmp: 0.04, fluAdmissions: 40000,
      corridorPct: T.wardCorridor8am != null ? 4 : 0,
    },
    B: null,
    targets: T,
  },
};

function measure(which, reps = which === "B" ? 4 : REPS) {
  const s = defaultSettings(base);
  // exact (unrounded) corridor spaces while fitting; the website uses the value rounded to 0.1%
  return run(buildParams(base, { ...s, corridorPct: base.calibration[which].corridorPct ?? 0, flexibility: which }), reps);
}
// patients in corridor spaces on wards at 08:00, averaged over the calendar days NHS England has published
const ccDays = (inp.corridorCare?.daily || []).map((d) => d.day);
const wardCorridor = (r) => ccDays.reduce((s, d) => s + r.escalationDaily8[d], 0) / Math.max(ccDays.length, 1);

// Bisection on one parameter so that metric(result) hits target; increasing=true if metric rises with param.
function fit1(which, key, metric, target, lo, hi, increasing, iters = 11, reps = undefined) {
  const c = base.calibration[which];
  for (let k = 0; k < iters; k++) {
    const mid = (lo + hi) / 2;
    c[key] = mid;
    const m = metric(measure(which, reps));
    if ((m < target) === increasing) lo = mid; else hi = mid;
  }
  c[key] = (lo + hi) / 2;
  return c[key];
}

// Weekend discharging is fitted to the measured weekend/weekday discharge-rate ratio (discharge sitrep).
// How planned admissions are spread over Mon-Fri, and the spread of planned stays, are then fitted to
// the observed weekday pattern of winter 08:00 occupancy (daily sitrep) by grid search on its shape.
// (Fitting weekend discharging to that pattern as well pushed it far below the measured ratio.)
const obsWeek = base.winterValidation[base.baseYearLabel].weekday.map((x) => 100 * x);
function weekShape(r) {
  const wk = [0, 0, 0, 0, 0, 0, 0], n = [0, 0, 0, 0, 0, 0, 0];
  r.daily8.forEach((v, i) => { if (i >= 238 && i <= 362) { wk[i % 7] += 100 * v; n[i % 7]++; } });
  const w = wk.map((v, i) => v / n[i]), m = w.reduce((a, b) => a + b) / 7, mo = obsWeek.reduce((a, b) => a + b) / 7;
  return Math.sqrt(w.reduce((s, v, i) => s + ((v - m) - (obsWeek[i] - mo)) ** 2, 0) / 7);
}
function fitWeekly(which) {
  const c = base.calibration[which];
  let best = null;
  const wd = c.weekendDischargePct;
  for (const fl of [0, 0.15, 0.3, 0.45]) for (const sg of [0.8, 1.2]) {
    Object.assign(c, { electiveFrontLoad: fl, electiveLosSigma: sg,
      electiveLosMedianDays: inp.elective.meanBedDays / Math.exp(sg ** 2 / 2) });
    const e = weekShape(measure(which, which === "B" ? 4 : 12));
    if (!best || e < best.e) best = { e, wd, fl, sg };
  }
  Object.assign(c, { weekendDischargePct: best.wd, electiveFrontLoad: best.fl, electiveLosSigma: best.sg,
    electiveLosMedianDays: inp.elective.meanBedDays / Math.exp(best.sg ** 2 / 2) });
  log(`   weekly pattern fit (weekend fixed at ${best.wd.toFixed(0)}%): front-load ${best.fl}, elective sigma ${best.sg}, shape RMSE ${best.e.toFixed(2)} pts`);
}

// Pool size and corridor spaces interact: smaller pools raise both long waits and corridor use, while more
// corridor spaces cut waits. Fitting them in turn oscillates, so solve them together: for each pool size,
// find the corridor spaces that reproduce the ward corridor count; then choose the pool size along that
// curve that reproduces the share waiting over 12 hours (monotone: smaller pools, more long waits).
// Long waits and corridor counts depend on rare runs of busy days, so they are noisy: the final solve uses
// more replications.
function fitPoolAndCorridor(which, [lo, hi], roundCorridor = false, reps = REPS, withLos = false) {
  const c = base.calibration[which];
  const corridorFor = () => {
    // pool size also moves occupancy (smaller pools leave more patients waiting rather than in beds), and long
    // waits are very sensitive to occupancy, so the final solve re-fits length of stay at every step
    if (withLos) fit1(which, "losMedianDays", (x) => x.occMidnight, T.occupancy, c.losMedianDays * 0.85, c.losMedianDays * 1.15, true, 8, reps);
    if (T.wardCorridor8am == null) return;
    fit1(which, "corridorPct", wardCorridor, T.wardCorridor8am, 0, 15, true, 7, reps);
    if (roundCorridor) c.corridorPct = +c.corridorPct.toFixed(1); // the website's slider works in 0.1% steps
  };
  // bisection on log(pool size); waits fall as pools grow
  let a = Math.log(lo), b = Math.log(hi);
  for (let k = 0; k < 8; k++) {
    c.poolSize = Math.exp((a + b) / 2);
    corridorFor();
    // too many long waits -> pools must be larger
    if (measure(which, reps).wait12 > T.wait12Share) a = Math.log(c.poolSize); else b = Math.log(c.poolSize);
  }
  c.poolSize = Math.exp((a + b) / 2);
  corridorFor();
}

function fitAll(which, rounds = 3, withPool = false, behaviour = true) {
  for (let r = 0; r < rounds; r++) {
    if (behaviour) {
      fit1(which, "weekendDischargePct", (x) => x.weekendDischargeRatio, T.weekendRatio, 30, 100, true, 8);
      if (r === 0 || r === rounds - 1) fitWeekly(which);
    }
    fit1(which, "losSigma", (x) => x.long21Share, T.long21Share, 0.6, 1.8, true, 9);
    fit1(which, "sameDayFrac", (x) => x.emBedDaysPerAdm, T.emBedDaysPerAdm, 0.05, 0.6, false, 9);
    fit1(which, "losMedianDays", (x) => x.occMidnight, T.occupancy, 0.5, 8, true, 11);
    fit1(which, "delayProb", (x) => x.delayedShareOvernight, T.delayedShare, 0.0, 0.4, true, 9);
    if (base.flu) fit1(which, "fluAdmissions", (x) => x.fluBedsPeak, T.fluPeakBeds, 5000, 150000, true, 9);
    if (withPool) fitPoolAndCorridor(which, r === 0 ? [15, 600] : [15, 250]);
    if (r === rounds - 1) {
      // final polish: the last parameters fitted shift occupancy, so re-fit it (and pool size) last
      fit1(which, "losMedianDays", (x) => x.occMidnight, T.occupancy, 2, 6, true, 10);
      if (withPool) {
        // occupancy, pool size and corridor spaces interact: solve all three together
        fitPoolAndCorridor(which, [15, 250], false);
        fitPoolAndCorridor(which, [25, 150], true, 96, true);
      }
    }
    const m = measure(which, which === "B" ? 8 : 96);
    log(`[${which}] round ${r + 1}`, JSON.stringify(Object.fromEntries(Object.entries(base.calibration[which]).map(([k, v]) => [k, +(+v).toFixed(4)]))));
    log(`   occ ${m.occMidnight.toFixed(4)}/${T.occupancy.toFixed(4)}  bd/adm ${m.emBedDaysPerAdm.toFixed(2)}/${T.emBedDaysPerAdm.toFixed(2)}  21+ ${m.long21Share.toFixed(3)}/${T.long21Share.toFixed(3)}  delayed ${m.delayedShareOvernight.toFixed(3)}/${T.delayedShare.toFixed(3)}  wkend ${m.weekendDischargeRatio.toFixed(3)}/${T.weekendRatio.toFixed(3)}  week-shape ${weekShape(m).toFixed(2)}  flu ${Math.round(m.fluBedsPeak)}/${T.fluPeakBeds}  >12h ${m.wait12.toFixed(4)}/${T.wait12Share.toFixed(4)}  ward corridor ${Math.round(wardCorridor(m))}/${Math.round(T.wardCorridor8am ?? 0)}  nctr ${m.nctrShare.toFixed(3)} (validation ${T.nctrShare.toFixed(3)})`);
  }
}

// Model A: everything, including pool size, fitted to 2025/26.
// WARM=1 starts from the current web/data/baseline.json values and runs fewer rounds.
const warm = process.env.WARM === "1" && fs.existsSync(path.join(ROOT, "web/data/baseline.json"));
if (warm) Object.assign(base.calibration.A, JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8")).calibration.A);
fitAll("A", warm ? 1 : 6, true);
// Model B: large pools (2015/16-like flexibility); same targets except >12h waits.
base.calibration.B = { ...base.calibration.A, poolSize: 1000 };
fitAll("B", 2, false, false); // keeps model A's discharge behaviour (weekend, planned-admission timing)

fs.mkdirSync(path.join(ROOT, "web/data"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "web/data/baseline.json"), JSON.stringify(base, null, 1));
log("Wrote web/data/baseline.json");
