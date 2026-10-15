// Turn the user's policy settings into simulation parameters.
//
// Three kinds of setting:
//  1. Hospital capacity: beds, staffing, winter escalation beds.
//  2. Public health: risk-factor prevalence (smoking, obesity), alcohol harm and
//     the deprivation gap. These change how many people need admitting.
//  3. Hospital flow: same day emergency care, delayed discharges (social care),
//     7-day discharge, earlier discharge, virtual wards, length of stay.
// Population (year) and winter severity are context, not policy levers.
// Every formula below is described on methods.html.

import { DEFAULTS } from "./model.js";

export function defaultSettings(base) {
  const c = base.calibration.A;
  return {
    // capacity
    beds: base.national.beds,
    staffingPct: 100,
    escalationPct: 0,
    corridorPct: 0,
    electivePct: 100,
    // public health (current values = no change)
    risk: Object.fromEntries((base.riskFactors || []).map((r) => [r.key, r.current])),
    deprivationGapPct: 0,
    fluUptake65: base.flu ? base.flu.uptake65 : 75,
    evidence: "published",   // "published": OHID attributable counts and cohort studies; "area": this project's area analysis
    // hospital flow
    sameDayPct: Math.round(100 * (c.sameDayFrac ?? DEFAULTS.sameDayFrac)),
    delayChangePct: 0,
    weekendDischargePct: Math.round(c.weekendDischargePct ?? DEFAULTS.weekendDischargePct),
    prepHours: DEFAULTS.prepHours,
    virtualWardPct: 0,
    admissionAvoidancePct: 0,
    losChangePct: 0,
    // context
    popYear: base.baseYear,
    winterSeverityPct: 100,
    otherGrowthPct: 0,
    flexibility: "A",
  };
}

export function populationFor(base, band, year) {
  const pop = band.pop;
  if (pop[year] != null) return pop[year];
  const ys = Object.keys(pop).map(Number).sort((a, b) => a - b);
  if (year <= ys[0]) return pop[ys[0]];
  if (year >= ys[ys.length - 1]) return pop[ys[ys.length - 1]];
  let lo = ys[0];
  for (const y of ys) if (y <= year) lo = y;
  const hi = ys.find((y) => y > year);
  return pop[lo] + (pop[hi] - pop[lo]) * (year - lo) / (hi - lo);
}

// Relative change in admissions from one risk factor (1 = no change).
export function riskFactorMultiplier(r, value, evidence = "published") {
  if (r.type === "prevalence") {
    // Population attributable fraction: PAF = p(RR-1) / (1 + p(RR-1)).
    // RR is derived from published attributable counts / cohort studies, or from this project's
    // area analysis where that gives an estimate (see data.html).
    const rr = evidence === "area" && r.relativeRiskAreaData ? r.relativeRiskAreaData : r.relativeRisk;
    const p0 = r.current / 100, p1 = value / 100;
    return (1 + p1 * (rr - 1)) / (1 + p0 * (rr - 1));
  }
  if (r.type === "attributable") {
    // value = % change in attributable admissions; share = attributable admissions / all admissions
    return 1 + r.share * (value - r.current) / 100;
  }
  return 1;
}

// Flu admissions relative to today for a given vaccine uptake among people aged 65+.
// Only vaccinated people are protected (direct effect; protection of others through less
// transmission is ignored, so the effect is conservative):
//   flu admissions(65+) ∝ 1 − VE × uptake
export function fluVaccineMultiplier(f, uptake) {
  if (!f) return 1;
  const m65 = (1 - f.ve * uptake / 100) / (1 - f.ve * f.uptake65 / 100);
  return f.share65 * m65 + (1 - f.share65);
}

// Relative change in admissions from narrowing the deprivation gap by g (0..1).
// Each deprivation fifth has a relative admission rate; the gap to the least deprived fifth shrinks.
export function deprivationMultiplier(base, g) {
  const d = base.deprivation;
  if (!d) return 1;
  const r = d.relativeRates, min = Math.min(...r);
  const now = r.reduce((s, x) => s + x, 0);
  const scen = r.reduce((s, x) => s + min + (x - min) * (1 - g), 0);
  return scen / now;
}

export function demandBreakdown(base, s) {
  const out = {};
  out.population = base.ageBands.reduce((t, b) => t + b.emergAdm * populationFor(base, b, s.popYear) / populationFor(base, b, base.baseYear), 0) /
    base.ageBands.reduce((t, b) => t + b.emergAdm, 0);
  out.risk = {};
  let riskAll = 1;
  for (const r of base.riskFactors || []) {
    const m = riskFactorMultiplier(r, s.risk[r.key] ?? r.current, s.evidence);
    out.risk[r.key] = m;
    riskAll *= m;
  }
  out.riskAll = riskAll;
  out.deprivation = deprivationMultiplier(base, s.deprivationGapPct / 100);
  out.other = 1 + s.otherGrowthPct / 100;
  out.fluVaccine = fluVaccineMultiplier(base.flu, s.fluUptake65);
  out.fluSeverity = s.winterSeverityPct / 100;
  return out;
}

export function buildParams(base, s) {
  const cal = s.flexibility === "B" ? base.calibration.B : base.calibration.A;
  const dm = demandBreakdown(base, s);
  const publicHealth = dm.riskAll * dm.deprivation;
  const groups = [];
  let emerg = 0;
  // influenza admissions are simulated as a separate winter wave, so they are taken out of
  // the year-round age-band demand and added back through fluPerYear
  const flu0 = base.flu ? (cal.fluAdmissions ?? base.flu.admissions ?? 0) : 0;
  const total0 = base.ageBands.reduce((t, b) => t + b.emergAdm, 0);
  const nonFlu = 1 - flu0 / total0;
  for (const b of base.ageBands) {
    let adm = b.emergAdm * nonFlu * populationFor(base, b, s.popYear) / populationFor(base, b, base.baseYear);
    adm *= publicHealth * dm.other;
    let losMult = b.losMult;
    if (b.older) {
      adm *= 1 - s.admissionAvoidancePct / 100;  // community urgent response / frailty services
      losMult *= 1 - s.virtualWardPct / 100;      // part of the stay delivered by a virtual ward
    }
    groups.push({ name: b.band, share: adm, losMult, delayMult: b.delayMult });
    emerg += adm;
  }
  return {
    ...DEFAULTS,
    beds: s.beds,
    staffingPct: s.staffingPct,
    escalationPct: s.escalationPct,
    corridorPct: s.corridorPct,
    poolSize: cal.poolSize,
    emergPerYear: emerg,
    fluPerYear: flu0 * dm.population * dm.fluVaccine * dm.fluSeverity,
    fluLosMult: base.flu ? base.flu.losMult : 1.3,
    fluSdDays: base.flu ? base.flu.sdDays : 21,
    electivePerYear: base.national.electivePerYear * s.electivePct / 100 * publicHealth,
    groups,
    sameDayFrac: s.sameDayPct / 100,
    losMedianDays: cal.losMedianDays,
    losSigma: cal.losSigma ?? DEFAULTS.losSigma,
    losChangePct: s.losChangePct,
    delayProb: cal.delayProb ?? DEFAULTS.delayProb,
    delayMeanDays: (cal.delayMeanDays ?? DEFAULTS.delayMeanDays) * Math.max(0, 1 + s.delayChangePct / 100),
    delayShape: cal.delayShape ?? DEFAULTS.delayShape,
    electiveLosMedianDays: cal.electiveLosMedianDays ?? DEFAULTS.electiveLosMedianDays,
    electiveLosSigma: cal.electiveLosSigma ?? DEFAULTS.electiveLosSigma,
    electiveWeekday: cal.electiveFrontLoad != null
      ? [0, 1, 2, 3, 4].map((d) => 1 + cal.electiveFrontLoad * (2 - d)) : DEFAULTS.electiveWeekday,
    seasonAmp: cal.seasonAmp ?? DEFAULTS.seasonAmp,
    fluPeakDoy: base.flu ? base.flu.peakDoy : DEFAULTS.fluPeakDoy,
    prepHours: s.prepHours,
    weekendDischargePct: s.weekendDischargePct,
  };
}
