// Tests of the pool-size idea: that the post-pandemic break is a loss of bed flexibility, which the model represents
// as smaller effective bed pools. A single pool size makes two predictions that are not fitted:
//   1. Two outcomes, one parameter. The pool size that reproduces a year's 12-hour waits also fixes its 4-hour waits
//      (decision to admit to admission). If the pool idea is right, both should match.
//   2. Slope. Smaller pools make waits less sensitive, in proportional terms, to each extra point of occupancy.
//      The model's slope at each fitted pool size can be compared with slopes measured within trusts.
// Each year gets its own beds, emergency admissions and population; length of stay is re-fitted so occupancy
// matches that year's KH03 figure (as in flexibility_check.mjs).
// Writes web/data/pool_tests.json.  Usage: node scripts/pool_tests.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const POOL_TODAY = base.calibration.A.poolSize;
const repsFor = (pool, r) => Math.max(4, Math.round(r * POOL_TODAY / pool));

// observed 4-hour waits from decision to admit, national, by financial year (A&E monthly situation reports)
const ae = fs.readFileSync(path.join(ROOT, "data/processed/ae_monthly_england.csv"), "utf8").trim().split("\n");
const H = ae[0].split(","), col = (n) => H.indexOf(n);
const obsYear = {};
for (const line of ae.slice(1)) {
  const c = line.split(","), fy = c[col("fy")];
  const o = (obsYear[fy] ||= { months: 0, adm: 0, w4: 0, w12: 0 });
  o.months++; o.adm += +c[col("emergency_admissions")]; o.w4 += +c[col("dta_over_4h")]; o.w12 += +c[col("dta_over_12h")];
}

function sim(s, pool, reps, beds) {
  const p = buildParams(base, { ...s, flexibility: "A", ...(beds ? { beds } : {}) });
  return run({ ...p, poolSize: pool }, repsFor(pool, reps));
}
function yearSettings(bt) {
  const s = { ...defaultSettings(base), beds: bt.beds, popYear: parseInt(bt.fy.slice(0, 4), 10), otherGrowthPct: 0 };
  const p = buildParams(base, s);
  s.otherGrowthPct = 100 * (bt.emergency_admissions / (p.emergPerYear + p.fluPerYear) - 1);
  return s;
}
function fitOccupancy(s, pool, target) {
  let lo = -45, hi = 40;
  for (let k = 0; k < 8; k++) {
    const mid = (lo + hi) / 2;
    if (sim({ ...s, losChangePct: mid }, pool, 24).occMidnight < target) lo = mid; else hi = mid;
  }
  return { ...s, losChangePct: (lo + hi) / 2 };
}
// pool size reproducing an observed share for one outcome ("wait12" or "wait4")
function poolFor(s0, occ, key, target) {
  let a = Math.log(8), b = Math.log(3000);
  for (let k = 0; k < 8; k++) {
    const pool = Math.exp((a + b) / 2);
    const r = sim(fitOccupancy(s0, pool, occ), pool, 32);
    if (r[key] > target) a = Math.log(pool); else b = Math.log(pool);
  }
  return Math.exp((a + b) / 2);
}
// proportional change in waits per point of occupancy, from runs with beds 2% and 4% either side
function slope(s, pool) {
  const pts = [];
  for (const f of [0.96, 0.98, 1, 1.02, 1.04]) {
    const r = sim(s, pool, 48, Math.round(s.beds * f));
    pts.push({ occ: 100 * r.occMidnight, w4: r.wait4, w12: r.wait12 });
  }
  const fit = (k) => {
    const xs = pts.filter((q) => q[k] > 0), n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((a, q) => a + q.occ, 0) / n, my = xs.reduce((a, q) => a + Math.log(q[k]), 0) / n;
    const b = xs.reduce((a, q) => a + (q.occ - mx) * (Math.log(q[k]) - my), 0) / xs.reduce((a, q) => a + (q.occ - mx) ** 2, 0);
    return 100 * (Math.exp(b) - 1);
  };
  return { points: pts, wait4PerPoint: fit("w4"), wait12PerPoint: fit("w12") };
}

const out = { generated: new Date().toISOString().slice(0, 10), poolToday: POOL_TODAY, years: [] };
for (const fy of ["2018/19", "2019/20", "2024/25"]) {
  const bt = base.backtests.find((b) => b.fy === fy), o = obsYear[fy];
  if (!bt || !o) continue;
  const s0 = yearSettings(bt);
  const obs = { occupancy: bt.occupancy, wait4: o.w4 / o.adm, wait12: o.w12 / o.adm };
  const yr = { fy, observed: obs, fits: [] };
  for (const key of ["wait12", "wait4"]) {
    const pool = poolFor(s0, bt.occupancy, key, obs[key]);
    const s = fitOccupancy(s0, pool, bt.occupancy);
    const r = sim(s, pool, 96);
    const sl = slope(s, pool);
    yr.fits.push({ fittedTo: key, pool, occupancy: r.occMidnight, wait4: r.wait4, wait12: r.wait12, slope: sl });
    log(fy, `pool fitted to ${key}: ${Math.round(pool)} beds -> occ ${(100 * r.occMidnight).toFixed(1)}%, >4h ${(100 * r.wait4).toFixed(2)}% (obs ${(100 * obs.wait4).toFixed(2)}%), >12h ${(100 * r.wait12).toFixed(3)}% (obs ${(100 * obs.wait12).toFixed(3)}%); per occupancy point: >4h ${sl.wait4PerPoint?.toFixed(0)}%, >12h ${sl.wait12PerPoint?.toFixed(0)}%`);
  }
  out.years.push(yr);
}
fs.writeFileSync(path.join(ROOT, "web/data/pool_tests.json"), JSON.stringify(out, null, 1));
log("wrote web/data/pool_tests.json");
