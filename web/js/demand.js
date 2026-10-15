// Turn the user's settings into simulation parameters.
//
// Demand is built bottom-up from age bands:
//   emergency admissions in band b = base-year admissions(b)
//                                    x population(b, chosen year) / population(b, base year)
// then split by condition group i with weight s_i x (1 + prevalence change_i),
// where s_i is the condition's share of emergency admissions in the base year.
// Each age x condition cell becomes a patient group with its own length-of-stay
// and delayed-discharge multipliers (age and condition effects multiply; this
// independence is an assumption, documented on the methods page).

import { DEFAULTS } from "./model.js";

export function defaultSettings(base) {
  return {
    beds: base.national.beds,
    staffingPct: 100,
    escalationPct: 0,
    flexibility: "A",
    popYear: base.baseYear,
    otherGrowthPct: 0,
    electivePct: 100,
    conditions: Object.fromEntries(base.conditions.map((c) => [c.name, 0])),
    losChangePct: 0,
    sameDayPct: Math.round(DEFAULTS.sameDayFrac * 100),
    delayProbPct: Math.round(DEFAULTS.delayProb * 100),
    delayLengthPct: 100,
    dischargeStart: DEFAULTS.dischargeStart,
    dischargeEnd: DEFAULTS.dischargeEnd,
    weekendDischargePct: DEFAULTS.weekendDischargePct,
    winterSeverityPct: 100,
  };
}

export function populationFor(base, band, year) {
  const pop = band.pop;
  if (pop[year] != null) return pop[year];
  // linear interpolation between the nearest available years
  const ys = Object.keys(pop).map(Number).sort((a, b) => a - b);
  if (year <= ys[0]) return pop[ys[0]];
  if (year >= ys[ys.length - 1]) return pop[ys[ys.length - 1]];
  let lo = ys[0];
  for (const y of ys) { if (y <= year) lo = y; }
  const hi = ys.find((y) => y > year);
  return pop[lo] + (pop[hi] - pop[lo]) * (year - lo) / (hi - lo);
}

export function buildParams(base, s) {
  const cal = s.flexibility === "B" ? base.calibration.B : base.calibration.A;
  const groups = [];
  let emerg = 0;
  const condShareTotal = base.conditions.reduce((t, c) => t + c.share, 0);
  const condW = base.conditions.map((c) => ({
    name: c.name, w: c.share * (1 + (s.conditions[c.name] || 0) / 100), losMult: c.losMult,
  }));
  const otherLos = base.otherConditionLosMult;
  condW.push({ name: "Other conditions", w: 1 - condShareTotal, losMult: otherLos });
  const condTotal = condW.reduce((t, c) => t + c.w, 0);
  const growth = 1 + s.otherGrowthPct / 100;
  for (const b of base.ageBands) {
    const adm = b.emergAdm * populationFor(base, b, s.popYear) / populationFor(base, b, base.baseYear);
    for (const c of condW) {
      const share = adm * c.w * growth;
      groups.push({ name: `${b.band} / ${c.name}`, share, losMult: b.losMult * c.losMult, delayMult: b.delayMult });
      emerg += share;
    }
  }
  return {
    ...DEFAULTS,
    beds: s.beds,
    staffingPct: s.staffingPct,
    escalationPct: s.escalationPct,
    poolSize: cal.poolSize,
    emergPerYear: emerg,
    electivePerYear: base.national.electivePerYear * s.electivePct / 100,
    groups,
    sameDayFrac: s.sameDayPct / 100,
    losMedianDays: cal.losMedianDays,
    losChangePct: s.losChangePct,
    delayProb: s.delayProbPct / 100,
    delayMeanDays: cal.delayMeanDays * s.delayLengthPct / 100,
    seasonAmp: DEFAULTS.seasonAmp * s.winterSeverityPct / 100,
    dischargeStart: s.dischargeStart,
    dischargeEnd: s.dischargeEnd,
    weekendDischargePct: s.weekendDischargePct,
    _condTotal: condTotal,
  };
}
