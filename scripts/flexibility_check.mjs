// Fitting check: can "today's hospitals" (bed flexibility fitted to 2025/26) reproduce pre-pandemic long waits once
// each year's own measured inputs are used? If yes, the post-pandemic break needs no change in flexibility.
//
// For 2018/19 and 2019/20 the model gets that year's beds, emergency admissions and population, and its length of
// stay is re-fitted so occupancy matches that year's KH03 figure. Discharge delays and corridor spaces before 2020
// were not measured on today's definitions, so they are varied over a wide range (today's level down to none).
// Then the pool size that reproduces each year's 12-hour waits is found.
// Writes web/data/flexibility_check.json.  Usage: node scripts/flexibility_check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const POOL_TODAY = base.calibration.A.poolSize, CORR_TODAY = base.calibration.A.corridorPct;
const repsFor = (pool, r) => Math.max(4, Math.round(r * POOL_TODAY / pool)); // bigger pools: fewer, longer runs

function sim(s, pool, reps, over = {}) {
  const p = buildParams(base, { ...s, flexibility: "A" });
  return run({ ...p, poolSize: pool, ...(typeof over === "function" ? over(p) : over) }, repsFor(pool, reps));
}
// emergency admissions for a past year: population is applied through popYear, the rest through "other change"
function yearSettings(bt) {
  const s = { ...defaultSettings(base), beds: bt.beds, popYear: parseInt(bt.fy.slice(0, 4), 10), otherGrowthPct: 0 };
  const p = buildParams(base, s);
  s.otherGrowthPct = 100 * (bt.emergency_admissions / (p.emergPerYear + p.fluPerYear) - 1);
  return s;
}
// re-fit length of stay (through the length-of-stay setting) so occupancy matches the year's KH03 figure
function fitOccupancy(s, pool, target, over = {}) {
  let lo = -45, hi = 40;
  for (let k = 0; k < 8; k++) {
    const mid = (lo + hi) / 2;
    if (sim({ ...s, losChangePct: mid }, pool, 24, over).occMidnight < target) lo = mid; else hi = mid;
  }
  return { ...s, losChangePct: (lo + hi) / 2 };
}

const out = { generated: new Date().toISOString().slice(0, 10), poolToday: POOL_TODAY, corridorToday: CORR_TODAY, years: [] };
for (const fy of ["2018/19", "2019/20"]) {
  const bt = base.backtests.find((b) => b.fy === fy);
  if (!bt) continue;
  const s0 = yearSettings(bt);
  const yr = { fy, beds: bt.beds, admissions: bt.emergency_admissions, occupancyObserved: bt.occupancy, wait12Observed: bt.wait12_share, grid: [] };
  // 1. today's flexibility, that year's inputs, delays and corridor spaces varied
  for (const delayChangePct of [0, -50, -100]) for (const corridorPct of [CORR_TODAY, 0]) {
    const s = fitOccupancy({ ...s0, delayChangePct, corridorPct }, POOL_TODAY, bt.occupancy);
    const r = sim(s, POOL_TODAY, 48);
    yr.grid.push({ delayChangePct, corridorPct, losChangePct: s.losChangePct, occupancy: r.occMidnight, wait12: r.wait12, wait12SE: r.wait12SE });
    log(fy, `delays ${delayChangePct}% corridor ${corridorPct}%: occ ${(100 * r.occMidnight).toFixed(1)} (obs ${(100 * bt.occupancy).toFixed(1)}), >12h ${(100 * r.wait12).toFixed(2)}% (obs ${(100 * bt.wait12_share).toFixed(2)}%)`);
  }
  // 1b. at a fixed occupancy, waits depend on how variable demand and stays are and on corridor spaces, so make
  // each of those as favourable as is plausible, alone and together (today's flexibility throughout)
  const FAV = [
    ["stays 20% less variable", (p) => ({ losSigma: p.losSigma * 0.8 })],
    ["full 7-day discharging", { weekendDischargePct: 100 }],
    ["no flu wave and no seasonal swing", { fluPerYear: 0, seasonAmp: 0 }],
    ["twice today's corridor spaces", { corridorPct: 2 * CORR_TODAY }],
    ["all of the above", (p) => ({ losSigma: p.losSigma * 0.8, weekendDischargePct: 100, fluPerYear: 0, seasonAmp: 0, corridorPct: 2 * CORR_TODAY })],
  ];
  yr.favourable = [];
  for (const [label, over] of FAV) {
    const s = fitOccupancy({ ...s0 }, POOL_TODAY, bt.occupancy, over);
    const r = sim(s, POOL_TODAY, 48, over);
    yr.favourable.push({ label, occupancy: r.occMidnight, wait12: r.wait12, wait12SE: r.wait12SE });
    log(fy, `favourable: ${label}: occ ${(100 * r.occMidnight).toFixed(1)}, >12h ${(100 * r.wait12).toFixed(2)}%`);
  }
  // 2. the pool size that reproduces the year's waits, under the most favourable and the central assumption
  yr.poolNeeded = [];
  for (const [label, delayChangePct, corridorPct] of [["delays as today, no corridor spaces", 0, 0], ["no delays at all, no corridor spaces", -100, 0]]) {
    let a = Math.log(POOL_TODAY), b = Math.log(3000), last = null;
    for (let k = 0; k < 7; k++) {
      const pool = Math.exp((a + b) / 2);
      const s = fitOccupancy({ ...s0, delayChangePct, corridorPct }, pool, bt.occupancy);
      last = { pool, r: sim(s, pool, 48) };
      if (last.r.wait12 > bt.wait12_share) a = Math.log(pool); else b = Math.log(pool);
    }
    const pool = Math.exp((a + b) / 2);
    yr.poolNeeded.push({ label, delayChangePct, corridorPct, pool, wait12AtPool: last.r.wait12 });
    log(fy, `pool needed (${label}): ~${Math.round(pool)} beds (today ${Math.round(POOL_TODAY)})`);
  }
  out.years.push(yr);
}
fs.writeFileSync(path.join(ROOT, "web/data/flexibility_check.json"), JSON.stringify(out, null, 1));
log("wrote web/data/flexibility_check.json");
