// How much did the fall in beds per person matter? Today's demand (2025/26) run with the number of G&A beds needed
// to match each earlier year's beds per head (KH03 beds, ONS population), in today's system and with pre-pandemic
// flexibility. Also the beds needed to match 2010/11 per unit of age-adjusted demand: the model's occupied beds with
// today's population against 2010's (same age-specific admission rates and stays).
// Writes web/data/beds_per_head.json.  Usage: node scripts/beds_per_head.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
const beds = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/blog_observed.json"), "utf8")).beds;
const REPS_A = 48, REPS_B = Math.max(4, Math.round(REPS_A * base.calibration.A.poolSize / base.calibration.B.poolSize));
const s0 = defaultSettings(base);
const sim = (over, sys) => run(buildParams(base, { ...s0, ...over, flexibility: sys }), sys === "A" ? REPS_A : REPS_B);
const now = beds.find((r) => r.fy === base.baseYearLabel) || beds[beds.length - 1];

const ageNow = sim({}, "A"), age2010 = sim({ popYear: 2010 }, "A");
const ageFactor = ageNow.occupiedBedsNational / age2010.occupiedBedsNational;
const pick = (r) => ({ occupancy: r.occMidnight, wait12: r.wait12, wait12PerYear: r.wait12PerYear, wait4: r.wait4, nightsFull: r.nightsFull, corridor8am: r.corridorCare8am });
const out = { generated: new Date().toISOString().slice(0, 10), baseYear: now.fy, bedsNow: s0.beds, population: now.population,
  ageFactor2010: ageFactor, populationFactor2010: now.population / beds.find((r) => r.fy === "2010/11").population, rows: [] };
const years = ["2010/11", "2012/13", "2015/16", "2017/18", "2019/20", "2022/23", now.fy];
const cases = years.map((fy) => { const r = beds.find((x) => x.fy === fy); return { label: fy, kind: "per head", perThousand: r.perThousand, beds: Math.round(r.beds * now.population / r.population) }; });
const r10 = beds.find((x) => x.fy === "2010/11");
cases.push({ label: "2010/11", kind: "per unit of age-adjusted demand", beds: Math.round(r10.beds * ageFactor) });
for (const c of cases) {
  const a = sim({ beds: c.beds }, "A"), b = sim({ beds: c.beds }, "B");
  out.rows.push({ ...c, extraBeds: c.beds - Math.round(s0.beds), A: pick(a), B: pick(b) });
  console.log(`${c.label} (${c.kind}): ${c.beds} beds -> occupancy ${(100 * a.occMidnight).toFixed(1)}%, >12h ${(100 * a.wait12).toFixed(2)}% (flexible ${(100 * b.wait12).toFixed(2)}%)`);
}
fs.writeFileSync(path.join(ROOT, "web/data/beds_per_head.json"), JSON.stringify(out, null, 1));
console.log("wrote web/data/beds_per_head.json");
