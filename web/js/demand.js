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
  return {
    // capacity
    beds: base.national.beds,
    staffingPct: 100,
    escalationPct: 0,
    electivePct: 100,
    // public health (current values = no change)
    risk: Object.fromEntries((base.riskFactors || []).map((r) => [r.key, r.current])),
    deprivationGapPct: 0,
    // hospital flow
    sameDayPct: Math.round(DEFAULTS.sameDayFrac * 100),
    delayChangePct: 0,
    weekendDischargePct: DEFAULTS.weekendDischargePct,
    dischargeStart: DEFAULTS.dischargeStart,
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
export function riskFactorMultiplier(r, value) {
  if (r.type === "prevalence") {
    // Population attributable fraction: PAF = p(RR-1) / (1 + p(RR-1)).
    // RR is derived from the published attributable fraction at the reference prevalence.
    const rr = r.relativeRisk;
    const p0 = r.current / 100, p1 = value / 100;
    return (1 + p1 * (rr - 1)) / (1 + p0 * (rr - 1));
  }
  if (r.type === "attributable") {
    // value = % change in attributable admissions; share = attributable admissions / all admissions
    return 1 + r.share * (value - r.current) / 100;
  }
  return 1;
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
    const m = riskFactorMultiplier(r, s.risk[r.key] ?? r.current);
    out.risk[r.key] = m;
    riskAll *= m;
  }
  out.riskAll = riskAll;
  out.deprivation = deprivationMultiplier(base, s.deprivationGapPct / 100);
  out.other = 1 + s.otherGrowthPct / 100;
  return out;
}

export function buildParams(base, s) {
  const cal = s.flexibility === "B" ? base.calibration.B : base.calibration.A;
  const dm = demandBreakdown(base, s);
  const publicHealth = dm.riskAll * dm.deprivation;
  const groups = [];
  let emerg = 0;
  for (const b of base.ageBands) {
    let adm = b.emergAdm * populationFor(base, b, s.popYear) / populationFor(base, b, base.baseYear);
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
    poolSize: cal.poolSize,
    emergPerYear: emerg,
    electivePerYear: base.national.electivePerYear * s.electivePct / 100 * publicHealth,
    groups,
    sameDayFrac: s.sameDayPct / 100,
    losMedianDays: cal.losMedianDays,
    losChangePct: s.losChangePct,
    delayProb: DEFAULTS.delayProb,
    delayMeanDays: cal.delayMeanDays * Math.max(0, 1 + s.delayChangePct / 100),
    seasonAmp: DEFAULTS.seasonAmp * s.winterSeverityPct / 100,
    dischargeStart: s.dischargeStart,
    dischargeEnd: DEFAULTS.dischargeEnd,
    weekendDischargePct: s.weekendDischargePct,
  };
}
