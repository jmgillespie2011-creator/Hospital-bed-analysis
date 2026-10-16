// Simulated scenarios for the blog page (web/blog.html): a sweep across bed numbers and a set of policy-sized
// changes to each setting, all run with the same engine and calibration as the simulator.
// Writes web/data/blog_scenarios.json.  Usage: node scripts/blog_scenarios.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings, demandBreakdown } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
const REPS_A = 60;
// model B: the same total number of simulated beds as model A
const REPS_B = Math.max(4, Math.round(REPS_A * base.calibration.A.poolSize / base.calibration.B.poolSize));
const s0 = defaultSettings(base);
const settings = (ch) => ({ ...s0, ...ch, risk: { ...s0.risk, ...(ch.risk || {}) } });

function sim(ch) {
  const out = {};
  for (const [sys, reps] of [["A", REPS_A], ["B", REPS_B]]) {
    const s = settings({ ...ch, flexibility: sys });
    const p = buildParams(base, s);
    const r = run(p, reps);
    out[sys] = {
      occupancy: r.occMidnight, occupiedBeds: r.occupiedBedsNational, nightsFull: r.nightsFull,
      wait12: r.wait12, wait12SE: r.wait12SE, wait12PerYear: r.wait12PerYear, wait4: r.wait4,
      corridor8am: r.corridorCare8am, elecLost: r.elecCancelRate, fluPeak: r.fluBedsPeak, nctrBeds: r.nctrBedsNational,
    };
  }
  return out;
}

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const out = { generated: new Date().toISOString().slice(0, 10), repsA: REPS_A, repsB: REPS_B, baseBeds: s0.beds, baseYear: base.baseYearLabel };

out.baseline = sim({});
log("baseline", out.baseline.A.occupancy.toFixed(4), out.baseline.A.wait12.toFixed(4));

// bed sweep
const popNow = base.bedHistory.at(-1).population;
out.history = base.bedHistory.map((h) => ({ year: h.year, beds: Math.round(h.beds), perHeadBeds: Math.round(h.beds / h.population * popNow) }));
out.sweep = [];
for (let beds = 90000; beds <= 140000; beds += 5000) {
  out.sweep.push({ beds, ...sim({ beds }) });
  log("beds", beds, out.sweep.at(-1).A.occupancy.toFixed(3), out.sweep.at(-1).A.wait12.toFixed(4));
}

// policy-sized changes. Each is a change that has been proposed or achieved somewhere, not a guess at an effect:
// the effect on admissions or length of stay comes from the simulator's measured parameters.
const r = Object.fromEntries((base.riskFactors || []).map((x) => [x.key, x]));
const levers = [
  { id: "beds5k", group: "Capacity", label: "5,000 more beds", ch: { beds: s0.beds + 5000 } },
  { id: "winter", group: "Capacity", label: "Extra winter beds (+3%)", ch: { escalationPct: 3 } },
  { id: "noCorridor", group: "Capacity", label: "End corridor care on wards", ch: { corridorPct: 0 } },
  { id: "smoking", group: "Public health", label: `Smoking down to 5% (from ${r.smoking?.current}%)`, ch: { risk: { smoking: 5 } } },
  { id: "obesity", group: "Public health", label: `Obesity down 5 points (from ${r.obesity?.current}%)`, ch: { risk: { obesity: (r.obesity?.current ?? 26) - 5 } } },
  { id: "flu", group: "Public health", label: `Flu vaccine uptake 65+ to 85% (from ${base.flu.uptake65}%)`, ch: { fluUptake65: 85 } },
  { id: "deprivation", group: "Public health", label: "Halve the gap to the least deprived fifth", ch: { deprivationGapPct: 50 } },
  { id: "delays", group: "Hospital flow", label: "Halve discharge delays", ch: { delayChangePct: -50 } },
  { id: "weekend", group: "Hospital flow", label: "Full 7-day discharging", ch: { weekendDischargePct: 100 } },
  { id: "sdec", group: "Hospital flow", label: "Same day emergency care +5 points", ch: { sameDayPct: s0.sameDayPct + 5 } },
  { id: "virtual", group: "Hospital flow", label: "Virtual wards: 10% of older patients' stay", ch: { virtualWardPct: 10 } },
  { id: "community", group: "Hospital flow", label: "Community response avoids 5% of older admissions", ch: { admissionAvoidancePct: 5 } },
  ...(base.readmissions ? [{ id: "readmissions", group: "Hospital flow",
    label: `Readmissions back to ${(100 * base.readmissions.history[0].rate).toFixed(1)}% (${base.readmissions.history[0].year} rate)`,
    ch: { readmissionRatePct: +(100 * base.readmissions.history[0].rate).toFixed(1) } }] : []),
  { id: "los", group: "Hospital flow", label: "Length of stay 5% shorter", ch: { losChangePct: -5 } },
  { id: "pop2030", group: "Context", label: `Population of 2030 (no other change)`, ch: { popYear: 2030 } },
  { id: "pop2035", group: "Context", label: `Population of 2035 (no other change)`, ch: { popYear: 2035 } },
];
out.levers = [];
for (const L of levers) {
  const d = demandBreakdown(base, settings(L.ch));
  out.levers.push({ ...L, demand: d, ...sim(L.ch) });
  const x = out.levers.at(-1);
  log(L.id, "occ", x.A.occupancy.toFixed(4), "beds", Math.round(x.A.occupiedBeds - out.baseline.A.occupiedBeds), "w12", x.A.wait12.toFixed(4));
}

// combined packages
const packages = [
  { id: "publicHealth", label: "Public-health package", ch: { risk: { smoking: 5, obesity: (r.obesity?.current ?? 26) - 5 }, fluUptake65: 85, deprivationGapPct: 50 } },
  { id: "flow", label: "Hospital-flow package", ch: { delayChangePct: -50, weekendDischargePct: 100, virtualWardPct: 10, admissionAvoidancePct: 5 } },
  { id: "both2035", label: "Both packages, population of 2035", ch: { popYear: 2035, risk: { smoking: 5, obesity: (r.obesity?.current ?? 26) - 5 }, fluUptake65: 85, deprivationGapPct: 50, delayChangePct: -50, weekendDischargePct: 100, virtualWardPct: 10, admissionAvoidancePct: 5 } },
];
out.packages = [];
for (const P of packages) {
  out.packages.push({ ...P, ...sim(P.ch) });
  log(P.id, out.packages.at(-1).A.occupancy.toFixed(4), out.packages.at(-1).A.wait12.toFixed(4));
}

// beds needed in 2035 to keep today's occupancy, with and without the packages
function bedsFor(ch, target) {
  let lo = 90000, hi = 180000;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    const p = buildParams(base, settings({ ...ch, beds: mid, flexibility: "A" }));
    const occ = run(p, 16).occMidnight;
    if (occ > target) lo = mid; else hi = mid;
  }
  return Math.round((lo + hi) / 2 / 100) * 100;
}
const target = out.baseline.A.occupancy;
out.bedsNeeded2035 = {
  target,
  noChange: bedsFor({ popYear: 2035 }, target),
  withPackages: bedsFor(packages[2].ch, target),
  at85: bedsFor({ popYear: base.baseYear }, 0.85),
  at85in2035: bedsFor({ popYear: 2035 }, 0.85),
};
log("beds needed", JSON.stringify(out.bedsNeeded2035));

fs.writeFileSync(path.join(ROOT, "web/data/blog_scenarios.json"), JSON.stringify(out));
log("wrote web/data/blog_scenarios.json");
