// Validate the calibrated simulator against data it was NOT calibrated on, and write
// web/data/validation.json for the website's Validation page.
//
// Usage: node scripts/validate.mjs   (after scripts/calibrate.mjs)
//
// Checks (see docs/validation-plan.md):
//   V1  forecast 2024/25 with that year's beds and admissions
//   V2  back-cast earlier years (occupancy and >12h waits)
//   V3  winter day-to-day variation of national G&A occupancy (daily sitrep, 08:00)
//   V4  weekday pattern of winter occupancy
//   V5  patients medically fit but still in hospital (NCTR), not used in calibration
//   V6  delay-length distribution vs Discharge Ready Date bands (only the shape was fitted)
//   V7  trust-level cross-section 2025/26: occupancy and >12h waits for ~120 trusts
//   V9  COVID-19 year 2020/21 as a natural experiment
// Lever-effect checks (placebo outcomes) are summarised from scripts/effects_analysis.py.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
const log = (...a) => console.log(...a);
const pct = (x, d = 1) => (x == null ? "n/a" : (100 * x).toFixed(d) + "%");

function scenario(over, which = "A", reps = 24, paramOver = {}) {
  const s = { ...defaultSettings(base), ...over, flexibility: which };
  return run({ ...buildParams(base, s), ...paramOver }, reps);
}
const baseEmerg = base.national.emergPerYear;
const yearSettings = (bt) => ({
  beds: bt.beds,
  popYear: parseInt(bt.fy.slice(0, 4), 10),
  otherGrowthPct: 0,
});
// emergency admissions for a past year: population effect is already applied through popYear, so
// any remaining difference from the observed total goes into "other change"
function matchAdmissions(bt) {
  const s0 = { ...defaultSettings(base), ...yearSettings(bt) };
  const p = buildParams(base, s0);
  return 100 * (bt.emergency_admissions / (p.emergPerYear + p.fluPerYear) - 1);
}

const out = { generated: new Date().toISOString().slice(0, 10), checks: [], years: [], trusts: [], winter: {} };

// ---------------------------------------------------------------- V1 + V2: years
for (const bt of base.backtests) {
  const set = { ...yearSettings(bt), otherGrowthPct: matchAdmissions(bt) };
  const a = scenario(set, "A", 24), b = scenario(set, "B", 4);
  out.years.push({
    fy: bt.fy, beds: bt.beds, admissions: bt.emergency_admissions,
    occ_obs: bt.occupancy, occ_A: a.occMidnight, occ_B: b.occMidnight,
    wait12_obs: bt.wait12_share, wait12_A: a.wait12, wait12_B: b.wait12,
    nctr_obs: bt.nctr_share, nctr_A: a.nctrShare,
  });
  log(bt.fy, "occ", pct(bt.occupancy), pct(a.occMidnight), pct(b.occMidnight), " >12h", pct(bt.wait12_share, 2), pct(a.wait12, 2), pct(b.wait12, 2));
}
const yrs = out.years.filter((y) => y.fy !== "2020/21");
const mae = (k) => yrs.reduce((s, y) => s + Math.abs(y[k] - y.occ_obs), 0) / yrs.length;
const v1 = out.years.find((y) => y.fy === "2024/25");
out.checks.push({
  id: "V1", name: "Forecast 2024/25 (beds and admissions of that year; parameters from 2025/26)",
  observed: `occupancy ${pct(v1.occ_obs)}, >12h ${pct(v1.wait12_obs, 2)}`,
  modelA: `occupancy ${pct(v1.occ_A)}, >12h ${pct(v1.wait12_A, 2)}`,
  modelB: `occupancy ${pct(v1.occ_B)}, >12h ${pct(v1.wait12_B, 2)}`,
  criterion: "occupancy within ±1.5 pts; >12h within a factor of 1.5",
  pass: Math.abs(v1.occ_A - v1.occ_obs) <= 0.015 && v1.wait12_A / v1.wait12_obs <= 1.5 && v1.wait12_A / v1.wait12_obs >= 1 / 1.5,
});
out.checks.push({
  id: "V2", name: `Back-cast occupancy, ${yrs.map((y) => y.fy).join(", ")}`,
  observed: yrs.map((y) => `${y.fy}: ${pct(y.occ_obs)}`).join("; "),
  modelA: `mean absolute error ${(100 * mae("occ_A")).toFixed(1)} pts`,
  modelB: `mean absolute error ${(100 * mae("occ_B")).toFixed(1)} pts`,
  criterion: "mean absolute error < 2 pts",
  pass: mae("occ_A") < 0.02,
  note: "Length of stay and delays are held at 2025/26 values, so this tests whether bed numbers and admissions alone explain the trend.",
});
const old = out.years.filter((y) => ["2015/16", "2018/19", "2019/20"].includes(y.fy));
out.checks.push({
  id: "V2b", name: "Back-cast >12h waits before the pandemic (2015/16-2019/20)",
  observed: old.map((y) => `${y.fy}: ${pct(y.wait12_obs, 2)}`).join("; "),
  modelA: old.map((y) => `${pct(y.wait12_A, 2)}`).join("; "),
  modelB: old.map((y) => `${pct(y.wait12_B, 2)}`).join("; "),
  criterion: "reported, not scored (known structural change)",
  pass: null,
  note: "Today's system (pool size fitted to 2025/26) over-predicts pre-pandemic waits; the more flexible system matches them. Waits depend on how flexibly beds are used, which has changed.",
});

// ---------------------------------------------------------------- V3/V4: winter daily pattern
const ref = scenario({}, "A", 48);
const MS = [0, 30, 61, 91, 122, 153, 183, 214, 245, 275, 306, 334, 365];
const day0dow = 0; // simulated day 0 = 1 April (Monday)
const winterIdx = [];
for (let i = MS[7] + 24; i < MS[11] + 29; i++) winterIdx.push(i); // ~24 Nov - 29 Mar, as published
const w8 = winterIdx.map((i) => ref.daily8[i]);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
const wk = [0, 0, 0, 0, 0, 0, 0], wn = [0, 0, 0, 0, 0, 0, 0];
winterIdx.forEach((i) => { const d = (i + day0dow) % 7; wk[d] += ref.daily8[i]; wn[d]++; });
const weekdayModel = wk.map((v, i) => v / wn[i]);
const wv = base.winterValidation[base.baseYearLabel];
out.winter = { observed: wv, model: { occ_mean: mean(w8), occ_sd: sd(w8), weekday: weekdayModel }, series: winterIdx.map((i) => ref.daily8[i]) };
out.checks.push({
  id: "V3", name: `Day-to-day variation of national occupancy, winter ${base.baseYearLabel} (08:00)`,
  observed: `SD ${(100 * wv.occ_sd).toFixed(1)} pts`, modelA: `SD ${(100 * sd(w8)).toFixed(1)} pts`, modelB: "",
  criterion: "SD within 1 pt of observed", pass: Math.abs(sd(w8) - wv.occ_sd) <= 0.01,
});
const amp = (a) => Math.max(...a) - Math.min(...a);
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
out.checks.push({
  id: "V4", name: "Weekday pattern of winter occupancy (Mon-Sun)",
  observed: `range ${(100 * amp(wv.weekday)).toFixed(1)} pts; ${wv.weekday.map((x) => (100 * x).toFixed(1)).join(", ")}`,
  modelA: `range ${(100 * amp(weekdayModel)).toFixed(1)} pts; ${weekdayModel.map((x) => (100 * x).toFixed(1)).join(", ")}`,
  modelB: `correlation ${corr(wv.weekday, weekdayModel).toFixed(2)}`,
  criterion: "same shape (correlation > 0.7), range within 50%",
  pass: corr(wv.weekday, weekdayModel) > 0.7 && Math.abs(amp(weekdayModel) / amp(wv.weekday) - 1) <= 0.5,
});

// ---------------------------------------------------------------- V5: NCTR
out.checks.push({
  id: "V5", name: "Beds occupied by patients no longer meeting the criteria to reside (end of day)",
  observed: pct(base.calibration.targets.nctrShare), modelA: pct(ref.nctrShare), modelB: "",
  criterion: "within 20% of observed", pass: Math.abs(ref.nctrShare / base.calibration.targets.nctrShare - 1) <= 0.2,
  note: "Calibration used the Discharge Ready Date measure of delays instead; the two NHS measures define readiness differently.",
});

// ---------------------------------------------------------------- V7: trusts
const trustCsv = fs.readFileSync(path.join(ROOT, base.trustPanel.file), "utf8").trim().split("\n");
const hdr = trustCsv[0].split(",");
const col = (row, k) => row[hdr.indexOf(k)];
const trusts = trustCsv.slice(1).map((l) => {
  const r = l.match(/("[^"]*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, ""));
  return { org: col(r, "org"), name: col(r, "org_name"), beds: +col(r, "ga_available"), occ: +col(r, "occupancy_8am"),
    adm: +col(r, "emergency_admissions"), wait12: +col(r, "wait12_share") };
});
const natBedsPerAdm = base.national.beds / base.national.emergPerYear;
for (const t of trusts) {
  // a trust = its own beds and emergency admissions; planned admissions scaled to its size
  const scale = t.adm / base.national.emergPerYear;
  const s = { ...defaultSettings(base), beds: t.beds, flexibility: "A" };
  const p = buildParams(base, s);
  const k = t.adm / (p.emergPerYear + p.fluPerYear);
  const pt = { ...p, groups: p.groups, emergPerYear: p.emergPerYear * k, fluPerYear: p.fluPerYear * k,
    electivePerYear: base.national.electivePerYear * scale };
  const r = run(pt, 4);
  out.trusts.push({ org: t.org, name: t.name, beds: t.beds, admissions: t.adm, bedsPerAdm: t.beds / t.adm / natBedsPerAdm,
    occ_obs: t.occ, occ_model: r.occ8am, wait12_obs: t.wait12, wait12_model: r.wait12 });
}
// V7b: given each trust's own observed occupancy (length of stay scaled to match it), does the
// model's queueing mechanism predict which trusts have long waits for a bed?
for (const t of trusts) {
  const scale = t.adm / base.national.emergPerYear;
  const p = buildParams(base, { ...defaultSettings(base), beds: t.beds, flexibility: "A" });
  const k = t.adm / (p.emergPerYear + p.fluPerYear);
  const pt = { ...p, emergPerYear: p.emergPerYear * k, fluPerYear: p.fluPerYear * k, electivePerYear: base.national.electivePerYear * scale };
  let lo = 0.3, hi = 3, r;
  for (let it = 0; it < 7; it++) {
    const mid = (lo + hi) / 2;
    r = run({ ...pt, losChangePct: 100 * (mid - 1) }, 3);
    if (r.occ8am < Math.min(t.occ, 0.995)) lo = mid; else hi = mid;
  }
  const tr = out.trusts.find((x) => x.org === t.org);
  tr.los_scale = (lo + hi) / 2;
  tr.wait12_model_matched = r.wait12;
  tr.occ_model_matched = r.occ8am;
}
const waitRhoMatched = (() => {
  const a = out.trusts.map((t) => t.wait12_model_matched), b = out.trusts.map((t) => t.wait12_obs);
  const rk = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(v.length); o.forEach(([, i], k) => (r[i] = k)); return r; };
  const ra = rk(a), rb = rk(b), m = (ra.length - 1) / 2;
  let n = 0, da = 0, db = 0; for (let i = 0; i < ra.length; i++) { n += (ra[i] - m) * (rb[i] - m); da += (ra[i] - m) ** 2; db += (rb[i] - m) ** 2; }
  return n / Math.sqrt(da * db);
})();
const xs = out.trusts.map((t) => t.occ_model), ys = out.trusts.map((t) => t.occ_obs);
const slope = (() => { const mx = mean(xs), my = mean(ys); let n = 0, d = 0; for (let i = 0; i < xs.length; i++) { n += (xs[i] - mx) * (ys[i] - my); d += (xs[i] - mx) ** 2; } return n / d; })();
const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k)); return r; };
const spearman = (a, b) => corr(rank(a), rank(b));
const occCorr = corr(xs, ys);
const waitRho = spearman(out.trusts.map((t) => t.wait12_model), out.trusts.map((t) => t.wait12_obs));
out.checks.push({
  id: "V7", name: `Trust-level cross-section, ${base.trustPanel.fy} (${out.trusts.length} acute trusts, each with its own beds and admissions)`,
  observed: "occupancy and >12h share by trust",
  modelA: `occupancy: correlation ${occCorr.toFixed(2)}, calibration slope ${slope.toFixed(2)}; >12h waits: rank correlation ${waitRho.toFixed(2)}`,
  modelB: "",
  criterion: "occupancy slope 0.8-1.2; >12h rank correlation > 0.5",
  pass: slope >= 0.8 && slope <= 1.2 && waitRho > 0.5,
  note: "Trusts differ in case mix, length of stay and bed flexibility, none of which the national model knows about; the test is how much is explained by beds and admissions alone.",
});

out.checks.push({
  id: "V7b", name: "Trusts: given each trust's own occupancy, does the model rank trusts' >12h waits correctly?",
  observed: ">12h share by trust", modelA: `rank correlation ${waitRhoMatched.toFixed(2)}`, modelB: "",
  criterion: "rank correlation > 0.5", pass: waitRhoMatched > 0.5,
  note: "Each trust's length of stay is scaled so the model matches its observed occupancy; this isolates the link from fullness to waits.",
});

// ---------------------------------------------------------------- V9: COVID year
const cv = out.years.find((y) => y.fy === "2020/21");
if (cv) out.checks.push({
  id: "V9", name: "COVID-19 year 2020/21 (observed beds and admissions; 2025/26 behaviour)",
  observed: `occupancy ${pct(cv.occ_obs)}`, modelA: `occupancy ${pct(cv.occ_A)}`, modelB: `occupancy ${pct(cv.occ_B)}`,
  criterion: "within ±3 pts", pass: Math.abs(cv.occ_A - cv.occ_obs) <= 0.03,
  note: "Infection-control bed closures and changed lengths of stay in 2020/21 are not modelled.",
});

// ---------------------------------------------------------------- lever-effect checks
const estPath = path.join(ROOT, "data/processed/effects_estimates.csv");
if (fs.existsSync(estPath)) {
  const lines = fs.readFileSync(estPath, "utf8").trim().split("\n");
  const h = lines[0].split(",");
  const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [h[i], v])));
  const numOrNaN = (v) => (v === "" || v == null ? NaN : +v);
  out.effects = rows.map((r) => {
    // a within-area estimate needs several years per area; with one observation per area it is not estimable
    const estimable = !(r.design.startsWith("within") && +r.n_obs <= +r.n_areas);
    return { outcome: r.outcome, exposure: r.exposure, adjustedFor: r.adjusted_for || "", design: r.design, pct: estimable ? numOrNaN(r.pct_per_point) : NaN,
      lo: estimable ? numOrNaN(r.ci_low) : NaN, hi: estimable ? numOrNaN(r.ci_high) : NaN, p: estimable ? numOrNaN(r.p) : NaN, n: +r.n_obs };
  });
  const plac = out.effects.filter((e) => ["falls65", "hip_fracture"].includes(e.outcome) && e.exposure === "flu_uptake65");
  out.checks.push({
    id: "L1", name: "Placebo test: flu vaccine uptake should not predict falls or hip-fracture admissions",
    observed: "no effect expected",
    modelA: plac.map((e) => `${e.outcome} ${e.design.startsWith("between") ? "between" : "within"}: ${e.pct.toFixed(2)}%/pt${Number.isFinite(e.p) && e.p < 0.05 ? " (significant)" : ""}`).join("; "),
    modelB: "", criterion: "no significant association", pass: !plac.some((e) => Number.isFinite(e.p) && e.p < 0.05),
    note: "Failure means area-level data cannot isolate the effect of flu vaccination, so the simulator uses measured vaccine effectiveness from a test-negative study instead.",
  });
}

fs.writeFileSync(path.join(ROOT, "web/data/validation.json"), JSON.stringify(out, null, 1));
for (const c of out.checks) log(c.pass === true ? "PASS" : c.pass === false ? "FAIL" : "----", c.id, c.name, "|", c.observed, "|", c.modelA, "|", c.modelB);
log("Wrote web/data/validation.json");
