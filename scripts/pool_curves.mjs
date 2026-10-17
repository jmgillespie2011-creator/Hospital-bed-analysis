// Why pool size matters: today's patients (2025/26) run at a range of bed numbers, with beds split into pools of
// different sizes and everything else as calibrated for today's system. Shows how 12-hour waits rise with occupancy
// for small and large pools (the blog's queueing explainer). Each pool size simulates about the same total number of
// beds, so smaller pools get more runs.
// Writes web/data/pool_curves.json.  Usage: node scripts/pool_curves.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
const s0 = defaultSettings(base);
const poolA = base.calibration.A.poolSize, poolB = base.calibration.B.poolSize;
const POOLS = [30, poolA, poolB, 500];
const BEDS = [98000, 100000, 102000, 104000, 106000, 108000, 111000, 114000, 118000, 122000];
const REPS_A = 100;
const out = { generated: new Date().toISOString().slice(0, 10), baseYear: base.baseYearLabel, bedsNow: s0.beds, poolA, poolB, curves: [] };
for (const pool of POOLS) {
  const reps = Math.max(4, Math.round(REPS_A * poolA / pool));
  const pts = [];
  for (const beds of BEDS) {
    const p = buildParams(base, { ...s0, beds, flexibility: "A" });
    p.poolSize = pool;
    const r = run(p, reps);
    pts.push({ beds, occupancy: r.occMidnight, wait12: r.wait12, wait12PerYear: r.wait12PerYear, wait4: r.wait4, nightsFull: r.nightsFull });
    console.log(`pool ${Math.round(pool)} beds ${beds}: occupancy ${(100 * r.occMidnight).toFixed(1)}%, >12h ${(100 * r.wait12).toFixed(2)}%`);
  }
  out.curves.push({ pool, reps, points: pts });
}
fs.writeFileSync(path.join(ROOT, "web/data/pool_curves.json"), JSON.stringify(out, null, 1));
console.log("wrote web/data/pool_curves.json");
