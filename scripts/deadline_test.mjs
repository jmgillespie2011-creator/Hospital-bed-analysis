// Deadline test. scripts/pool_tests.mjs found that no single pool size reproduces both 4-hour and 12-hour waits
// (decision to admit to admission): before the pandemic only about 1 in 200 patients who waited 4 hours went on to
// wait 12, where a plain queue predicts about half. One explanation is that hospitals acted on a deadline:
// a 12-hour wait was a reportable breach, so as one approached, patients were moved to escalation spaces.
//
// The model's research option deadlineH / deadlinePct adds that rule: once a patient has waited deadlineH hours,
// extra spaces (deadlinePct of beds) can take them. For each year the pool size is fitted to 4-hour waits and the
// deadline spaces to 12-hour waits (corridor spaces otherwise off). The questions:
//   - Does the fitted pool stay roughly stable across the pandemic while the deadline capacity collapses?
//   - For 2025/26, do the fitted deadline spaces imply a plausible number of patients in escalation spaces at 08:00,
//     compared with NHS England's corridor-care count (not used in the fit)?
//   - How sensitive is this to the deadline chosen?
// Writes web/data/deadline_test.json.  Usage: node scripts/deadline_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
const T = base.calibration.targets;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const POOL_TODAY = base.calibration.A.poolSize;
const repsFor = (pool, r) => Math.max(4, Math.round(r * POOL_TODAY / pool));

const ae = fs.readFileSync(path.join(ROOT, "data/processed/ae_monthly_england.csv"), "utf8").trim().split("\n");
const H = ae[0].split(","), col = (n) => H.indexOf(n);
const obsYear = {};
for (const line of ae.slice(1)) {
  const c = line.split(","), fy = c[col("fy")];
  const o = (obsYear[fy] ||= { adm: 0, w4: 0, w12: 0 });
  o.adm += +c[col("emergency_admissions")]; o.w4 += +c[col("dta_over_4h")]; o.w12 += +c[col("dta_over_12h")];
}

const sim = (s, pool, reps, over = {}) => run({ ...buildParams(base, { ...s, flexibility: "A", corridorPct: 0 }), poolSize: pool, ...over }, repsFor(pool, reps));
function yearSettings(fy) {
  if (fy === base.calibration.baseYear || fy === "2025/26") return { ...defaultSettings(base) };
  const bt = base.backtests.find((b) => b.fy === fy);
  const s = { ...defaultSettings(base), beds: bt.beds, popYear: parseInt(fy.slice(0, 4), 10), otherGrowthPct: 0 };
  const p = buildParams(base, s);
  s.otherGrowthPct = 100 * (bt.emergency_admissions / (p.emergPerYear + p.fluPerYear) - 1);
  return s;
}
const occTarget = (fy) => (fy === "2025/26" ? T.occupancy : base.backtests.find((b) => b.fy === fy).occupancy);
function fitOccupancy(s, pool, target) {
  let lo = -45, hi = 40;
  for (let k = 0; k < 8; k++) {
    const mid = (lo + hi) / 2;
    if (sim({ ...s, losChangePct: mid }, pool, 24).occMidnight < target) lo = mid; else hi = mid;
  }
  return { ...s, losChangePct: (lo + hi) / 2 };
}
// deadline spaces (% of beds) that reproduce the 12-hour share, for a given pool
function fitDeadline(s, pool, D, target) {
  let lo = 0, hi = 25;
  if (sim(s, pool, 24, { deadlineH: D, deadlinePct: 0 }).wait12 <= target) return 0;
  for (let k = 0; k < 9; k++) {
    const mid = (lo + hi) / 2;
    if (sim(s, pool, 24, { deadlineH: D, deadlinePct: mid }).wait12 > target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const out = { generated: new Date().toISOString().slice(0, 10), corridorObserved8am: T.wardCorridor8am, runs: [] };
for (const D of [10, 8, 11]) {
  for (const fy of ["2018/19", "2019/20", "2025/26"]) {
    const o = obsYear[fy], obs = { wait4: o.w4 / o.adm, wait12: o.w12 / o.adm };
    const s0 = yearSettings(fy);
    let a = Math.log(10), b = Math.log(1000), best = null;
    for (let k = 0; k < 8; k++) {
      const pool = Math.exp((a + b) / 2);
      const s = fitOccupancy(s0, pool, occTarget(fy));
      const K = fitDeadline(s, pool, D, obs.wait12);
      const r = sim(s, pool, 24, { deadlineH: D, deadlinePct: K });
      best = { pool, K, s };
      if (r.wait4 > obs.wait4) a = Math.log(pool); else b = Math.log(pool);
    }
    const r = sim(best.s, best.pool, 96, { deadlineH: D, deadlinePct: best.K });
    const row = { deadlineH: D, fy, observed: obs, pool: best.pool, deadlinePct: best.K, occupancy: r.occMidnight, wait4: r.wait4, wait12: r.wait12,
      inDeadlineSpaces8am: r.inEscalationSpaces8am };
    out.runs.push(row);
    log(`deadline ${D}h ${fy}: pool ${Math.round(best.pool)}, deadline spaces ${best.K.toFixed(2)}% of beds -> occ ${(100 * r.occMidnight).toFixed(1)}%, >4h ${(100 * r.wait4).toFixed(2)}% (obs ${(100 * obs.wait4).toFixed(2)}), >12h ${(100 * r.wait12).toFixed(3)}% (obs ${(100 * obs.wait12).toFixed(3)}), in escalation spaces at 08:00 ${Math.round(r.inEscalationSpaces8am)}`);
  }
  if (D === 10) fs.writeFileSync(path.join(ROOT, "web/data/deadline_test.json"), JSON.stringify(out, null, 1));
}
fs.writeFileSync(path.join(ROOT, "web/data/deadline_test.json"), JSON.stringify(out, null, 1));
log("wrote web/data/deadline_test.json");
