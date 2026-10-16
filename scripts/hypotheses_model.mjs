// The simulator applied to three explanations of full hospitals: social care, general practice, and hospital flow.
//
// 1. What changed between 2018/19 and 2025/26? Five measured changes, each switched from its 2018/19 value to today's:
//      demand        emergency admissions and the population's age mix (A&E monthly, ONS)
//      beds          G&A beds (KH03)
//      stays         nights per overnight emergency admission (HES, Health Foundation definitions; includes delays)
//      same-day      share of emergency patients going home the same day (HES zero bed day cases)
//      flexibility   bed-pool size: pre-pandemic (fitted to 2018/19 12-hour waits counted from arrival) to today's
//    Each change's contribution to occupancy and 12-hour waits is its Shapley value: the average effect of switching it
//    over every order of switching the five, so contributions add up exactly to the total change.
// 2. Today's year with one explanation removed: delays by who has to act (acute discharge sitrep delay reasons), chronic
//    ambulatory-care-sensitive admissions (HES), 7-day discharging, and pre-pandemic flexibility.
// Writes web/data/hypotheses_model.json.  Usage: node scripts/hypotheses_model.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const base = J("web/data/baseline.json"), trends = J("web/data/blog_trends.json"), hd = J("web/data/hypotheses_data.json");
const A = base.calibration.A, POOL_A = A.poolSize, POOL_B = base.calibration.B.poolSize;
const REPS = +(process.env.REPS || 40);
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sim = (s, pool = POOL_A, reps = REPS) => run({ ...buildParams(base, { ...s, flexibility: "A" }), poolSize: pool }, Math.max(4, Math.round(reps * POOL_A / pool)));
const pick = (r) => ({ occupancy: r.occMidnight, occupiedBeds: r.occupiedBedsNational, wait12: r.wait12, wait12PerYear: r.wait12PerYear, wait4: r.wait4,
  zeroNight: r.emZeroNightShare, losOvernight: r.emBedDaysPerOvernight });

// measured stays and same-day share, relative to the latest HES year (as in the validation back-casts)
const H = Object.fromEntries(trends.years.filter((y) => y.hf_em_los_linked != null).map((y) => [y.fy, y]));
const ref = Object.keys(H).sort().at(-1);
const losPct = (fy) => 100 * (H[fy].hf_em_los_linked / H[ref].hf_em_los_linked - 1);
const sdPct = (fy) => 100 * A.sameDayFrac * (H[fy].em_same_day_share ?? H[ref].em_same_day_share) / H[ref].em_same_day_share;

// ---------------------------------------------------------------- 1. decomposition
const FROM = process.env.FROM || "2018/19";
const bt = base.backtests.find((b) => b.fy === FROM);
const s0 = defaultSettings(base);
const today = { beds: s0.beds, popYear: s0.popYear, otherGrowthPct: 0, losChangePct: losPct(ref), sameDayPct: sdPct(ref) };
const past = { beds: bt.beds, popYear: parseInt(FROM.slice(0, 4), 10), otherGrowthPct: 0, losChangePct: losPct(FROM), sameDayPct: sdPct(FROM) };
{ const p = buildParams(base, { ...s0, ...past }); past.otherGrowthPct = 100 * (bt.emergency_admissions / (p.emergPerYear + p.fluPerYear) - 1); }
const FACTORS = [
  { id: "demand", label: "More patients (emergency admissions and an older population)", keys: ["popYear", "otherGrowthPct"] },
  { id: "beds", label: "Change in bed numbers", keys: ["beds"] },
  { id: "stays", label: "Longer stays for patients admitted overnight", keys: ["losChangePct"] },
  { id: "sameDay", label: "More patients sent home the same day", keys: ["sameDayPct"] },
  { id: "flex", label: "Less flexible use of beds", keys: [] },
];
const cache = new Map();
function at(mask) {
  if (cache.has(mask)) return cache.get(mask);
  const s = { ...s0 };
  FACTORS.forEach((f, i) => { const src = mask & (1 << i) ? today : past; for (const k of f.keys) s[k] = src[k]; });
  const pool = mask & (1 << 4) ? POOL_A : POOL_B;
  const r = pick(sim(s, pool));
  cache.set(mask, r);
  return r;
}
const N = FACTORS.length, FULL = (1 << N) - 1;
const fact = (n) => (n <= 1 ? 1 : n * fact(n - 1));
const bits = (m) => m.toString(2).split("").filter((c) => c === "1").length;
const metrics = ["occupancy", "wait12", "wait12PerYear", "occupiedBeds"];
const shapley = FACTORS.map((f, i) => {
  const out = Object.fromEntries(metrics.map((k) => [k, 0]));
  for (let m = 0; m <= FULL; m++) {
    if (m & (1 << i)) continue;
    const w = fact(bits(m)) * fact(N - bits(m) - 1) / fact(N);
    const a = at(m), b = at(m | (1 << i));
    for (const k of metrics) out[k] += w * (b[k] - a[k]);
  }
  log(`${f.id}: occupancy ${(100 * out.occupancy).toFixed(2)} pts, 12h ${(100 * out.wait12).toFixed(2)} pts (${Math.round(out.wait12PerYear)} a year)`);
  return { id: f.id, label: f.label, ...out };
});
const start = at(0), end = at(FULL);
log(`${FROM} model: occupancy ${(100 * start.occupancy).toFixed(1)}%, 12h ${(100 * start.wait12).toFixed(2)}%; today: ${(100 * end.occupancy).toFixed(1)}%, ${(100 * end.wait12).toFixed(2)}%`);

// ---------------------------------------------------------------- 2. one explanation removed, today
const R7 = hd.delays.reasons["7+"].byGroup;
const acsc = hd.acsc.at(-1);
const nowS = { ...s0, ...today };
const baseA = pick(sim(nowS)), baseB = pick(sim(nowS, POOL_B));
const cf = [
  { id: "socialCare", hyp: "Social care", label: "Delays waiting for social care removed", note: `${(100 * R7["Social care"]).toFixed(0)}% of delayed bed days`, s: { delayChangePct: -100 * R7["Social care"] } },
  { id: "socialJoint", hyp: "Social care", label: "Social care and joint (care transfer hub) delays removed", note: `${(100 * (R7["Social care"] + R7["Care transfer hubs and other joint processes"])).toFixed(0)}% of delayed bed days`,
    s: { delayChangePct: -100 * (R7["Social care"] + R7["Care transfer hubs and other joint processes"]) } },
  { id: "community", hyp: "Community health services", label: "Delays waiting for NHS community services removed", note: `${(100 * R7["Community health services"]).toFixed(0)}% of delayed bed days`,
    s: { delayChangePct: -100 * R7["Community health services"] } },
  { id: "allDelays", hyp: "All discharge delays", label: "Every discharge delay removed", note: "upper bound", s: { delayChangePct: -100 } },
  { id: "acscAll", hyp: "General practice", label: "No emergency admissions for conditions good primary care can manage", note: `${(100 * acsc.acsc_share_adm).toFixed(1)}% of emergency admissions (chronic ambulatory care sensitive conditions), upper bound`,
    s: { otherGrowthPct: -100 * acsc.acsc_share_adm } },
  { id: "acscQuarter", hyp: "General practice", label: "A quarter of those admissions avoided", note: `${(25 * acsc.acsc_share_adm).toFixed(1)}% of emergency admissions`, s: { otherGrowthPct: -25 * acsc.acsc_share_adm } },
  { id: "hospitalProcess", hyp: "Hospital flow and management", label: "Delays from hospital processes removed", note: `${(100 * R7["Hospital processes"]).toFixed(0)}% of delayed bed days`, s: { delayChangePct: -100 * R7["Hospital processes"] } },
  { id: "sevenDay", hyp: "Hospital flow and management", label: "Full 7-day discharging", note: `weekend discharge rate ${s0.weekendDischargePct}% to 100% of weekdays`, s: { weekendDischargePct: 100 } },
  { id: "flex", hyp: "Hospital flow and management", label: "Pre-pandemic flexibility in using beds", note: `bed pools of ${Math.round(POOL_B)} instead of ${Math.round(POOL_A)}`, s: {}, pool: POOL_B },
  { id: "beds5k", hyp: "Beds", label: "5,000 more beds", note: "for scale", s: { beds: s0.beds + 5000 } },
];
const scenarios = cf.map((c) => {
  const r = pick(sim({ ...nowS, ...c.s }, c.pool || POOL_A));
  log(`${c.id}: occupancy ${(100 * (r.occupancy - baseA.occupancy)).toFixed(2)} pts, 12h ${Math.round(r.wait12PerYear - baseA.wait12PerYear)} a year`);
  return { ...c, ...r, dOcc: r.occupancy - baseA.occupancy, dBeds: r.occupiedBeds - baseA.occupiedBeds, dWait12PerYear: r.wait12PerYear - baseA.wait12PerYear };
});
const out = { generated: new Date().toISOString().slice(0, 10), reps: REPS, from: FROM, to: base.baseYearLabel, poolA: POOL_A, poolB: POOL_B,
  settings: { past, today }, start, end, shapley, base: baseA, baseFlexible: baseB, scenarios };
fs.writeFileSync(path.join(ROOT, "web/data/hypotheses_model.json"), JSON.stringify(out, null, 1));
log("wrote web/data/hypotheses_model.json");
