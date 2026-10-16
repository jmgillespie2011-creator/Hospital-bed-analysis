// Verification tests for the simulator (see docs/validation-plan.md, section 1).
// Run: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULTS, rng, run, simulate } from "../web/js/model.js";
import { buildParams, defaultSettings, deprivationMultiplier, fluVaccineMultiplier, riskFactorMultiplier } from "../web/js/demand.js";

const close = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${msg}: ${a} vs ${b} (±${100 * rel}%)`);

// A small, fast configuration: 2,000 national beds in pools of 100.
const small = { ...DEFAULTS, beds: 2000, emergPerYear: 2000 * 365 / 6.5 * 0.85, electivePerYear: 0, poolSize: 100, days: 200, warmupDays: 60 };

test("random numbers: Poisson, normal and gamma have the right moments", () => {
  const R = rng(42), n = 60000;
  for (const lam of [0.7, 3, 80]) {
    let s = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const x = R.poisson(lam); s += x; s2 += x * x; }
    const m = s / n, v = s2 / n - m * m;
    close(m, lam, 0.03, `Poisson(${lam}) mean`);
    close(v, lam, 0.08, `Poisson(${lam}) variance`);
  }
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const x = R.normal(); s += x; s2 += x * x; }
  assert.ok(Math.abs(s / n) < 0.02, "normal mean ~ 0");
  close(s2 / n, 1, 0.03, "normal variance");
  s = 0; s2 = 0;
  for (let i = 0; i < n; i++) { const x = R.gamma(1.5, 2); s += x; s2 += x * x; }
  close(s / n, 3, 0.03, "gamma mean");
  close(s2 / n - (s / n) ** 2, 6, 0.08, "gamma variance");
});

test("reproducible: same seed gives identical results", () => {
  const a = simulate(small, 7), b = simulate(small, 7);
  assert.equal(a.occMidnight, b.occMidnight);
  assert.equal(a.wait12, b.wait12);
});

test("Little's law: beds occupied at midnight = admissions per day x midnights per stay (ample beds)", () => {
  const p = { ...small, beds: 1e6, poolSize: 1e6 / 2, emergPerYear: 365 * 400, electivePerYear: 0, seasonAmp: 0 };
  const r = run(p, 3);
  close(r.occupiedBedsNational, 400 * r.emBedDaysPerAdm, 0.03, "occupied beds");
});

test("capacity is never exceeded", () => {
  const r = simulate({ ...small, emergPerYear: small.emergPerYear * 1.3 }, 3);
  assert.ok(Math.max(...r.daily) <= 1 + 1e-9, "midnight occupancy <= 100%");
});

test("limits: huge capacity gives no waits; overload gives long waits", () => {
  const roomy = run({ ...small, beds: 20000, poolSize: 2000 }, 2);
  assert.equal(roomy.wait12, 0);
  const tight = run({ ...small, beds: 1000, poolSize: 100 }, 2); // demand needs ~1,700 beds
  assert.ok(tight.wait12 > 0.3, `overloaded system should have many >12h waits (got ${tight.wait12})`);
});

test("monotone: more beds lower occupancy and waits", () => {
  const a = run({ ...small, beds: 1900 }, 8), b = run({ ...small, beds: 2300 }, 8);
  assert.ok(b.occMidnight < a.occMidnight);
  assert.ok(b.wait12 <= a.wait12);
});

test("common random numbers: capacity settings do not change the simulated patients", () => {
  // With spare capacity, adding winter or corridor spaces must not change anything patients experience.
  const roomy = { ...small, beds: 20000, poolSize: 2000 };
  const a = simulate(roomy, 5), b = simulate({ ...roomy, escalationPct: 3.3, corridorPct: 2.7 }, 5);
  assert.equal(a.emergAdmitted, b.emergAdmitted);
  assert.equal(a.nctrBeds, b.nctrBeds);
});

test("corridor spaces: used only when beds are full, and reduce waits", () => {
  const t = { ...small, beds: 1300, poolSize: 100 }; // busy: ~90% occupied
  const a = run(t, 6), b = run({ ...t, corridorPct: 5 }, 6);
  assert.ok(b.wait12 < a.wait12, "corridor spaces cut long waits");
  assert.ok(b.inEscalationSpaces8am > 0 && a.inEscalationSpaces8am === 0);
  assert.ok(Math.max(...b.daily) <= 1 + 1e-9, "proper-bed occupancy still capped at 100%");
  assert.equal(b.waited45Daily.length, b.daily.length, "daily count of patients waiting 45+ minutes");
});

test("monotone: more demand raises occupancy", () => {
  const a = run(small, 8), b = run({ ...small, emergPerYear: small.emergPerYear * 1.1 }, 8);
  assert.ok(b.occMidnight > a.occMidnight);
});

test("flu wave adds winter beds and peaks in winter", () => {
  const r = run({ ...small, days: 365, fluPerYear: 5000 }, 4);
  assert.ok(r.fluBedsPeak > 0);
  const peakDay = r.fluBedsDaily.indexOf(Math.max(...r.fluBedsDaily)); // day 0 = 1 April
  assert.ok(peakDay > 240 && peakDay < 310, `flu peak should be Dec-Jan (day ${peakDay})`);
});

test("attributable fraction maths", () => {
  close(riskFactorMultiplier({ type: "prevalence", relativeRisk: 2, current: 20 }, 10), 1.1 / 1.2, 1e-12, "prevalence formula");
  close(riskFactorMultiplier({ type: "attributable", share: 0.04, current: 0 }, -50), 0.98, 1e-12, "attributable formula");
  close(fluVaccineMultiplier({ ve: 0.5, uptake65: 50, share65: 1 }, 100), 0.5 / 0.75, 1e-12, "flu formula");
  close(deprivationMultiplier({ deprivation: { relativeRates: [2, 1, 1, 1, 1] } }, 1), 5 / 6, 1e-12, "deprivation formula");
});

// Policy levers move inputs in the expected direction.
const testBase = {
  baseYear: 2024,
  national: { beds: 100000, electivePerYear: 1.6e6 },
  calibration: { A: { poolSize: 100, losMedianDays: 3, delayMeanDays: 4 }, B: { poolSize: 1000, losMedianDays: 3, delayMeanDays: 4 } },
  ageBands: [
    { band: "0-74", pop: { 2024: 50e6, 2040: 52e6 }, emergAdm: 4e6, losMult: 0.8, delayMult: 0.5 },
    { band: "75+", pop: { 2024: 6e6, 2040: 9e6 }, emergAdm: 2.6e6, losMult: 1.3, delayMult: 1.8, older: true },
  ],
  riskFactors: [{ key: "smoking", type: "prevalence", relativeRisk: 1.3, current: 12 }],
  deprivation: { relativeRates: [1.5, 1.2, 1, 0.9, 0.8] },
  flu: { admissions: 50000, uptake65: 75, ve: 0.4, share65: 0.6 },
};
test("policy levers move model inputs in the expected direction", () => {
  const s0 = defaultSettings(testBase), p0 = buildParams(testBase, s0);
  const p = (ch) => buildParams(testBase, { ...s0, ...ch, risk: { ...s0.risk, ...(ch.risk || {}) } });
  assert.ok(p({ risk: { smoking: 5 } }).emergPerYear < p0.emergPerYear, "less smoking, fewer admissions");
  assert.ok(p({ deprivationGapPct: 50 }).emergPerYear < p0.emergPerYear, "smaller deprivation gap, fewer admissions");
  assert.ok(p({ fluUptake65: 95 }).fluPerYear < p0.fluPerYear, "more vaccination, fewer flu admissions");
  assert.ok(p({ popYear: 2040 }).emergPerYear > p0.emergPerYear, "bigger, older population, more admissions");
  assert.ok(p({ admissionAvoidancePct: 20 }).emergPerYear < p0.emergPerYear, "community response avoids admissions");
  assert.ok(p({ delayChangePct: -50 }).delayMeanDays < p0.delayMeanDays, "shorter delays");
  const vw = p({ virtualWardPct: 20 });
  assert.ok(vw.groups.find((g) => g.name === "75+").losMult < p0.groups.find((g) => g.name === "75+").losMult, "virtual wards shorten older patients' stays");
  assert.equal(p({ staffingPct: 90 }).staffingPct, 90);
});

test("baseline reproduces its calibration targets (regression test)", { skip: !fs.existsSync("web/data/baseline.json") }, () => {
  const base = JSON.parse(fs.readFileSync("web/data/baseline.json", "utf8"));
  if (base._note || !base.calibration.targets) return; // placeholder data file
  const r = run(buildParams(base, defaultSettings(base)), 20);
  assert.ok(Math.abs(r.occMidnight - base.calibration.targets.occupancy) < 0.01, `occupancy ${r.occMidnight}`);
  const cc = base.corridorCare;
  if (cc && base.calibration.targets.wardCorridor8am) {
    const m = cc.daily.reduce((s, d) => s + r.escalationDaily8[d.day], 0) / cc.daily.length;
    assert.ok(Math.abs(m / base.calibration.targets.wardCorridor8am - 1) < 0.25, `ward corridor care ${m}`);
  }
});

