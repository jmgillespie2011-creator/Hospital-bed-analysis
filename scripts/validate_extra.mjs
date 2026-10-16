// Further validation of the simulator (see the validation page, section "Further validation").
//   E1 Forecast from the past: refit length of stay and pool size to 2023/24 only (occupancy and 12-hour waits), then
//      predict 2024/25 and 2025/26 from those years' beds, admissions, population and measured length of stay.
//   E2 Month by month: each financial year 2022/23-2025/26 with its own beds, admissions, length of stay and flu wave
//      (peak size and date from the UEC daily sitrep); monthly occupancy and 12-hour waits against the published series.
//   E3 Trusts with their own length of stay: as V7, adding each trust's HES mean length of stay relative to England.
//   E4 Shape of the waits: 4-hour waits, the share of 4-hour waiters who reach 12 hours, and how fast waits rise with
//      occupancy, against measured values.
//   E5 Effects of change: model's change in 12-hour waits when patients fit to leave fall, against the within-trust
//      estimate; and the occupancy elasticity, against within-trust month-to-month estimates.
//   E6 Uncertainty and sensitivity: refit the pool size under a +/-10% 12-hour target and under different assumptions
//      that have no data behind them, and see how much two policy answers move (+5,000 beds; stays 10% shorter).
// Inputs: web/data/baseline.json, data/processed/validation_extra_inputs.json (scripts/validation_data.py),
// web/data/blog_trends.json, web/data/longstay_tests.json, web/data/pool_slopes.json.
// Writes web/data/validation_extra.json.  Usage: node scripts/validate_extra.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const J = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const base = J("web/data/baseline.json"), inp = J("data/processed/validation_extra_inputs.json"), trends = J("web/data/blog_trends.json");
const lt = J("web/data/longstay_tests.json"), slopes = J("web/data/pool_slopes.json");
const T = base.calibration.targets, A = base.calibration.A;
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const corr = (a, b) => { const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); o.forEach(([, i], k) => (r[i] = k)); return r; };
const spearman = (a, b) => corr(rank(a), rank(b));
const out = { generated: new Date().toISOString().slice(0, 10), tests: [] };

const losBy = Object.fromEntries(trends.years.filter((y) => y.mean_los != null).map((y) => [y.fy, y.mean_los]));
const losRefYear = Object.keys(losBy).sort().at(-1);
const losPct = (fy) => (losBy[fy] != null ? 100 * (losBy[fy] / losBy[losRefYear] - 1) : 0);
function yearSettings(fy, extra = {}) {
  const bt = base.backtests.find((b) => b.fy === fy);
  if (!bt || fy === base.baseYearLabel) return { ...defaultSettings(base), losChangePct: losPct(fy === base.baseYearLabel ? losRefYear : fy), ...extra };
  const s = { ...defaultSettings(base), beds: bt.beds, popYear: parseInt(fy.slice(0, 4), 10), otherGrowthPct: 0, losChangePct: losPct(fy), ...extra };
  const p = buildParams(base, s);
  s.otherGrowthPct = 100 * (bt.emergency_admissions / (p.emergPerYear + p.fluPerYear) - 1);
  return s;
}
const obsYear = (fy) => fy === base.baseYearLabel ? { occupancy: T.occupancy, wait12: T.wait12Share } : (() => { const b = base.backtests.find((x) => x.fy === fy); return { occupancy: b.occupancy, wait12: b.wait12_share }; })();
const sim = (s, reps = 24, over = {}) => run({ ...buildParams(base, { ...s, flexibility: "A" }), ...over }, reps);
// re-fit stays (as a % change on top of the settings) so occupancy matches a target
function fitLos(s, target, over = {}, reps = 24) {
  let lo = s.losChangePct - 30, hi = s.losChangePct + 30;
  for (let k = 0; k < 9; k++) { const mid = (lo + hi) / 2; if (sim({ ...s, losChangePct: mid }, reps, over).occMidnight < target) lo = mid; else hi = mid; }
  return { ...s, losChangePct: (lo + hi) / 2 };
}
// pool size (and stays, for occupancy) so 12-hour waits match a target
function fitPool(s, occTarget, waitTarget, over = {}, reps = 24) {
  let a = Math.log(15), b = Math.log(400), ss = s;
  for (let k = 0; k < 8; k++) {
    const pool = Math.exp((a + b) / 2);
    ss = fitLos(s, occTarget, { ...over, poolSize: pool }, reps);
    if (sim(ss, reps, { ...over, poolSize: pool }).wait12 > waitTarget) a = Math.log(pool); else b = Math.log(pool);
  }
  const pool = Math.exp((a + b) / 2);
  return { pool, s: fitLos(s, occTarget, { ...over, poolSize: pool }, reps) };
}

// ---------------------------------------------------------------- E1 forecast from the past
{
  const fit = "2023/24", o = obsYear(fit);
  const f = fitPool(yearSettings(fit), o.occupancy, o.wait12);
  const losShift = f.s.losChangePct - yearSettings(fit).losChangePct; // stays re-fitted on top of the measured change
  log(`E1 fitted to ${fit}: pool ${f.pool.toFixed(0)} (today's calibration ${A.poolSize.toFixed(0)}), extra stay change ${losShift.toFixed(1)}%`);
  const rows = [];
  for (const fy of ["2024/25", base.baseYearLabel]) {
    const s = yearSettings(fy); s.losChangePct += losShift;
    const r = sim(s, 48, { poolSize: f.pool }), ob = obsYear(fy);
    rows.push({ fy, occ_obs: ob.occupancy, occ_model: r.occMidnight, wait12_obs: ob.wait12, wait12_model: r.wait12 });
    log(`E1 ${fy}: occupancy ${pct(r.occMidnight)} (obs ${pct(ob.occupancy)}), >12h ${pct(r.wait12, 2)} (obs ${pct(ob.wait12, 2)})`);
  }
  const occErr = Math.max(...rows.map((r) => Math.abs(r.occ_model - r.occ_obs))), waitErr = Math.max(...rows.map((r) => Math.abs(r.wait12_model / r.wait12_obs - 1)));
  out.tests.push({ id: "E1", name: "Forecast from the past: fitted to 2023/24 only, predicting 2024/25 and 2025/26", fittedTo: fit, pool: f.pool, losShiftPct: losShift, rows,
    criterion: "occupancy within 1.5 pts and 12-hour waits within 25% in both years", pass: occErr < 0.015 && waitErr < 0.25,
    summary: rows.map((r) => `${r.fy}: occupancy ${pct(r.occ_model)} (observed ${pct(r.occ_obs)}), >12h ${pct(r.wait12_model, 1)} (observed ${pct(r.wait12_obs, 1)})`).join("; "),
    note: "Only stays (to match occupancy) and pool size (to match 12-hour waits) are refitted to 2023/24; other settings come from the 2025/26 calibration, so this is a partial hold-out. Each later year uses its own beds, admissions and population, and HES length of stay where published (2025/26: not yet published, held at 2024/25)." });
}

// ---------------------------------------------------------------- E2 month by month
{
  const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"], MS = [0, 30, 61, 91, 122, 153, 183, 214, 245, 275, 306, 334, 365];
  const fluBy = Object.fromEntries(inp.flu.map((f) => [f.winter, f]));
  const fluRef = fluBy[base.baseYearLabel] || { peak7: base.flu.peakBedsTarget };
  const years = [...new Set(inp.monthly.map((m) => m.fy))];
  const rows = [], perYear = [];
  for (const fy of years) {
    const fl = fluBy[fy];
    const doy = fl ? Math.round((new Date(fl.peakDate) - new Date(fl.peakDate.slice(0, 4) + "-01-01")) / 864e5) + 1 : base.flu.peakDoy;
    const s = yearSettings(fy, fl ? { winterSeverityPct: 100 * fl.peak7 / fluRef.peak7 } : {});
    const r = sim(s, 48, { fluPeakDoy: doy });
    const occM = MS.slice(0, 12).map((st, i) => mean(r.daily8.slice(st, MS[i + 1])));
    const obs = inp.monthly.filter((m) => m.fy === fy);
    obs.forEach((m, i) => rows.push({ month: m.month, fy, occ_obs: m.occ8, occ_model: occM[i], wait12_obs: m.wait12, wait12_model: r.wait12Monthly[i] }));
    const y = rows.filter((x) => x.fy === fy);
    perYear.push({ fy, occCorr: corr(y.map((x) => x.occ_obs), y.map((x) => x.occ_model)), waitCorr: corr(y.map((x) => x.wait12_obs), y.map((x) => x.wait12_model)),
      occMae: mean(y.map((x) => Math.abs(x.occ_model - x.occ_obs))), waitObs: mean(y.map((x) => x.wait12_obs)), waitModel: mean(y.map((x) => x.wait12_model)),
      ampObs: Math.max(...y.map((x) => x.wait12_obs)) / Math.max(1e-6, Math.min(...y.map((x) => x.wait12_obs))),
      ampModel: Math.max(...y.map((x) => x.wait12_model)) / Math.max(1e-6, Math.min(...y.map((x) => x.wait12_model))), fluSeverity: s.winterSeverityPct, fluPeakDoy: doy });
    log(`E2 ${fy}: occupancy shape r=${perYear.at(-1).occCorr.toFixed(2)}, MAE ${(100 * perYear.at(-1).occMae).toFixed(1)} pts; 12h shape r=${perYear.at(-1).waitCorr.toFixed(2)}; peak/trough 12h obs ${perYear.at(-1).ampObs.toFixed(1)}x model ${perYear.at(-1).ampModel.toFixed(1)}x`);
  }
  const all = (k1, k2) => corr(rows.map((r) => r[k1]), rows.map((r) => r[k2]));
  const oc = all("occ_obs", "occ_model"), wc = all("wait12_obs", "wait12_model");
  out.tests.push({ id: "E2", name: "Month by month, 2022/23 to 2025/26 (each year's own beds, admissions, stays and flu wave)", rows, perYear, months: MONTHS,
    criterion: "monthly occupancy and 12-hour waits correlate with the published series (r > 0.6) across the 48 months", pass: oc > 0.6 && wc > 0.6,
    summary: `occupancy r = ${oc.toFixed(2)}, mean error ${(100 * mean(rows.map((r) => Math.abs(r.occ_model - r.occ_obs)))).toFixed(1)} pts; 12-hour waits r = ${wc.toFixed(2)}; winter peak / summer trough of 12-hour waits: observed ${mean(perYear.map((y) => y.ampObs)).toFixed(1)}x, model ${mean(perYear.map((y) => y.ampModel)).toFixed(1)}x`,
    note: "Occupancy is at 08:00 (monthly bed sitrep). Flu wave size scaled by each winter's peak flu occupancy and centred on its peak date; the wave's width is held at the 2025/26 fit." });
}

// ---------------------------------------------------------------- E3 trusts with their own length of stay
{
  const csv = fs.readFileSync(path.join(ROOT, base.trustPanel.file), "utf8").trim().split("\n"), hdr = csv[0].split(",");
  const col = (row, k) => row[hdr.indexOf(k)];
  const losMap = Object.fromEntries(inp.trustLos.map((t) => [t.org, t.los_rel]));
  const trusts = csv.slice(1).map((l) => { const r = l.match(/("[^"]*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, ""));
    return { org: col(r, "org"), beds: +col(r, "ga_available"), occ: +col(r, "occupancy_8am"), adm: +col(r, "emergency_admissions"), wait12: +col(r, "wait12_share"),
      long21: +col(r, "los_21plus") / +col(r, "ga_occupied") }; }).filter((t) => losMap[t.org] != null && t.beds > 0 && t.adm > 0);
  const res = [];
  for (const t of trusts) {
    const scale = t.adm / base.national.emergPerYear;
    const p = buildParams(base, { ...defaultSettings(base), beds: t.beds, flexibility: "A", losChangePct: 100 * (losMap[t.org] - 1) });
    const k = t.adm / (p.emergPerYear + p.fluPerYear);
    const pt = { ...p, emergPerYear: p.emergPerYear * k, fluPerYear: p.fluPerYear * k, electivePerYear: base.national.electivePerYear * scale };
    const r = run(pt, 4);
    res.push({ org: t.org, los_rel: losMap[t.org], occ_obs: t.occ, occ_model: r.occ8am, wait12_obs: t.wait12, wait12_model: r.wait12 });
  }
  const oc = corr(res.map((r) => r.occ_model), res.map((r) => r.occ_obs)), wr = spearman(res.map((r) => r.wait12_model), res.map((r) => r.wait12_obs));
  log(`E3 ${res.length} trusts: occupancy r=${oc.toFixed(2)}, 12h rank r=${wr.toFixed(2)}`);
  out.tests.push({ id: "E3", name: `Trusts with their own length of stay (${res.length} acute trusts)`, trusts: res,
    criterion: "occupancy correlation > 0.5 and 12-hour waits rank correlation > 0.3", pass: oc > 0.5 && wr > 0.3,
    summary: `occupancy correlation ${oc.toFixed(2)} (V7 without trust stays: see V7); 12-hour waits rank correlation ${wr.toFixed(2)}`,
    note: "Each trust: its own G&A beds and emergency admissions (2025/26), and its HES mean length of stay (2024/25, all admissions) relative to England. HES counts stays across all a trust's activity, including specialties outside G&A." });
}

// ---------------------------------------------------------------- E4 shape of the waits
{
  const s0 = defaultSettings(base), ref = sim(s0, 96);
  const o = inp.waits[base.baseYearLabel] || inp.waits[Object.keys(inp.waits).sort().at(-1)];
  // proportional rise in 12-hour waits per point of occupancy: beds +/-2%
  const pts = [0.98, 1, 1.02].map((f) => { const r = sim({ ...s0, beds: s0.beds * f }, 48); return { occ: 100 * r.occMidnight, w12: r.wait12, w4: r.wait4 }; });
  const sl = (k) => 100 * (Math.exp((Math.log(pts[0][k]) - Math.log(pts[2][k])) / (pts[0].occ - pts[2].occ)) - 1);
  const occWithin = lt.A1?.terms?.occ_c;
  const after4 = slopes.slopes?.waits4?.after;
  out.tests.push({ id: "E4", name: "Shape of the waits (not fitted)",
    rows: [
      { measure: "Emergency admissions waiting over 4 hours for a bed", observed: o.wait4, model: ref.wait4, fmt: "pct" },
      { measure: "Of those waiting 4 hours, share reaching 12 hours", observed: o.reach12, model: ref.wait12 / ref.wait4, fmt: "pct" },
      { measure: "Rise in 12-hour waits per point of occupancy", observed: occWithin ? occWithin.pct / 100 : null, model: sl("w12") / 100, fmt: "pctpt",
        note: "observed: within trusts, month to month (test A1)" },
      { measure: "Rise in 4-hour waits per point of occupancy", observed: after4 ? after4.pct / 100 : null, model: sl("w4") / 100, fmt: "pctpt",
        note: "observed: within trusts, year to year since 2022/23" },
    ],
    criterion: "4-hour waits within 25% of observed", pass: Math.abs(ref.wait4 / o.wait4 - 1) < 0.25,
    summary: `4-hour waits ${pct(ref.wait4)} (observed ${pct(o.wait4)}); share of 4-hour waiters reaching 12 hours ${pct(ref.wait12 / ref.wait4, 0)} (observed ${pct(o.reach12, 0)}); 12-hour waits rise ${sl("w12").toFixed(0)}% per occupancy point (within trusts: ${occWithin ? occWithin.pct.toFixed(1) + "%" : "n/a"})`,
    note: "The model's waits run from the decision to admit to a bed. National and within-trust slopes are not the same quantity: within-trust month-to-month occupancy is measured with noise, which flattens measured slopes." });
  log("E4", out.tests.at(-1).summary);
}

// ---------------------------------------------------------------- E5 effects of change
{
  const s0 = defaultSettings(base), ref = sim(s0, 96), less = sim({ ...s0, delayChangePct: -30 }, 96);
  const dN = 100 * (ref.nctrShare - less.nctrShare), dOcc = 100 * (ref.occMidnight - less.occMidnight), dW = less.wait12 / ref.wait12 - 1;
  const perPt = -(Math.pow(1 + dW, 1 / dN) - 1); // change in 12-hour waits per point of beds held by patients fit to leave
  const nctrW = lt.A3?.terms?.nctr_pts, occW = lt.A3?.terms?.occ_c;
  const implied = occW ? Math.pow(1 + occW.pct / 100, dOcc / dN) - 1 : null; // via occupancy, at the within-trust occupancy slope
  out.tests.push({ id: "E5", name: "Effects of change: fewer patients waiting to leave",
    model: { nctrPts: dN, occPts: dOcc, perPoint: perPt, occPerNctrPt: dOcc / dN }, observed: { beyondOccupancy: nctrW || null, occupancySlope: occW || null, impliedPerPoint: implied },
    criterion: "(a) no extra effect beyond occupancy, as the model assumes: within-trust 95% CI below +2% per point",
    pass: nctrW ? nctrW.hi < 2 : null,
    summary: `(a) beyond occupancy: model 0 by design; within trusts ${nctrW ? `${nctrW.pct >= 0 ? "+" : ""}${nctrW.pct.toFixed(1)}% per point (95% CI ${nctrW.lo.toFixed(1)} to ${nctrW.hi.toFixed(1)})` : "n/a"}. ` +
      `(b) through occupancy: each point fewer beds held by patients fit to leave lowers occupancy ${(dOcc / dN).toFixed(2)} pts and 12-hour waits ${(100 * perPt).toFixed(0)}% in the model; ` +
      `at the within-trust occupancy slope (+${occW ? occW.pct.toFixed(1) : "?"}% per point) it would be ${implied != null ? (100 * implied).toFixed(0) + "%" : "n/a"}`,
    note: "Within-trust estimates are month-to-month (test A3), holding occupancy and trust and month effects fixed. Part (b) inherits E4's gap: the model's waits respond to occupancy several times more steeply than measured within trusts." });
  log("E5", out.tests.at(-1).summary);
}

// ---------------------------------------------------------------- E6 uncertainty and sensitivity
{
  const s0 = defaultSettings(base);
  const policies = (pool, s, over) => {
    const b = sim(s, 48, { ...over, poolSize: pool });
    const beds = sim({ ...s, beds: s.beds + 5000 }, 48, { ...over, poolSize: pool });
    const los = sim({ ...s, losChangePct: s.losChangePct - 10 }, 48, { ...over, poolSize: pool });
    return { base12: b.wait12PerYear, beds5k: beds.wait12PerYear - b.wait12PerYear, los10: los.wait12PerYear - b.wait12PerYear, occBeds5k: beds.occMidnight - b.occMidnight };
  };
  const variants = [
    ["Central (today's calibration)", {}, 1],
    ["12-hour target 10% lower", {}, 0.9],
    ["12-hour target 10% higher", {}, 1.1],
    ["Discharges start 2 hours later (11:00)", { dischargeStart: 11 }, 1],
    ["Discharge window ends 4 hours earlier (16:00)", { dischargeEnd: 16 }, 1],
    ["Twice as long from ward round to leaving (6 h)", { prepHours: 6 }, 1],
    ["No seasonal swing in non-flu demand", { seasonAmp: 0 }, 1],
    ["Twice the seasonal swing", { seasonAmp: 0.08 }, 1],
  ];
  const rows = [];
  for (const [label, over, tf] of variants) {
    const f = label.startsWith("Central") ? { pool: A.poolSize, s: s0 } : fitPool(s0, T.occupancy, T.wait12Share * tf, over);
    const pr = policies(f.pool, f.s, over);
    rows.push({ label, pool: f.pool, ...pr });
    log(`E6 ${label}: pool ${f.pool.toFixed(0)}, +5,000 beds ${Math.round(pr.beds5k / 1000)}k a year, stays -10% ${Math.round(pr.los10 / 1000)}k a year`);
  }
  const c = rows[0], rng = (k) => [Math.min(...rows.map((r) => r[k])), Math.max(...rows.map((r) => r[k]))];
  out.tests.push({ id: "E6", name: "Uncertainty and sensitivity of the answers", rows,
    criterion: "policy effects within 25% of the central estimate across variants", pass: rows.every((r) => Math.abs(r.beds5k / c.beds5k - 1) < 0.25 && Math.abs(r.los10 / c.los10 - 1) < 0.25),
    summary: `pool size ${rng("pool").map((x) => x.toFixed(0)).join("–")} beds; +5,000 beds cuts 12-hour waits by ${rng("beds5k").map((x) => Math.round(-x / 1000)).reverse().join("–")}k a year (central ${Math.round(-c.beds5k / 1000)}k); stays 10% shorter: ${rng("los10").map((x) => Math.round(-x / 1000)).reverse().join("–")}k (central ${Math.round(-c.los10 / 1000)}k)`,
    note: "Each variant refits the pool size (and stays, to keep occupancy) so the model still matches 2025/26, then reruns the two policies. The ±10% target covers measurement and simulation noise in the 12-hour share." });
  log("E6", out.tests.at(-1).summary);
}

fs.writeFileSync(path.join(ROOT, "web/data/validation_extra.json"), JSON.stringify(out, null, 1));
log("wrote web/data/validation_extra.json");
