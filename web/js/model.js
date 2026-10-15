// Discrete-event simulation of NHS England general & acute (G&A) bed occupancy.
//
// One engine is used both in the browser (web/js/worker.js) and for calibration
// in Node (scripts/calibrate.mjs), so the website and the published analysis
// always run the same model. Documented in web/methods.html.
//
// Time unit: hours. Day 0 of the simulated year is 1 April (a Monday).

// ---------------------------------------------------------------- random numbers
export function rng(seed) {
  // xoshiro128** seeded via splitmix32
  let s = seed >>> 0;
  const sm = () => {
    s = (s + 0x9e3779b9) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = sm(), b = sm(), c = sm(), d = sm();
  const next = () => {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9);
    const t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    return (r >>> 0) / 4294967296;
  };
  let spare = null;
  const normal = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u, v, q;
    do { u = 2 * next() - 1; v = 2 * next() - 1; q = u * u + v * v; } while (q >= 1 || q === 0);
    const f = Math.sqrt(-2 * Math.log(q) / q);
    spare = v * f;
    return u * f;
  };
  const gamma = (shape, scale) => {
    if (shape < 1) return gamma(shape + 1, scale) * Math.pow(next(), 1 / shape);
    const d3 = shape - 1 / 3, c3 = 1 / Math.sqrt(9 * d3);
    for (;;) {
      let x, v;
      do { x = normal(); v = 1 + c3 * x; } while (v <= 0);
      v = v * v * v;
      const u = next();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d3 * (1 - v + Math.log(v))) return d3 * v * scale;
    }
  };
  const poisson = (lam) => {
    if (lam <= 0) return 0;
    if (lam > 50) return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal()));
    const L = Math.exp(-lam);
    let k = 0, p = 1;
    do { k++; p *= next(); } while (p > L);
    return k - 1;
  };
  return { next, normal, gamma, poisson };
}
function rotl(x, k) { return (x << k) | (x >>> (32 - k)); }

// ---------------------------------------------------------------- binary heap
class MinHeap {
  constructor() { this.t = []; this.k = []; }
  get size() { return this.t.length; }
  peek() { return this.t.length ? this.t[0] : Infinity; }
  push(time, key) {
    const t = this.t, k = this.k;
    let i = t.length; t.push(time); k.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (t[p] <= time) break;
      t[i] = t[p]; k[i] = k[p]; i = p;
    }
    t[i] = time; k[i] = key;
  }
  pop() {
    const t = this.t, k = this.k;
    const top = k[0], lastT = t.pop(), lastK = k.pop();
    const n = t.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && t[c + 1] < t[c]) c++;
        if (t[c] >= lastT) break;
        t[i] = t[c]; k[i] = k[c]; i = c;
      }
      t[i] = lastT; k[i] = lastK;
    }
    return top;
  }
}

// ---------------------------------------------------------------- defaults
// Relative emergency admission rate by hour of day and day of week (Mon first).
export const HOURLY = normalise([0.45, 0.35, 0.3, 0.25, 0.25, 0.3, 0.45, 0.7, 1.0, 1.25, 1.4, 1.5,
  1.55, 1.55, 1.5, 1.45, 1.4, 1.35, 1.3, 1.2, 1.05, 0.9, 0.7, 0.55]);
export const WEEKDAY = normalise([1.10, 1.03, 1.0, 1.0, 1.02, 0.93, 0.92]);
function normalise(a) { const m = a.reduce((x, y) => x + y, 0) / a.length; return a.map((x) => x / m); }

export const DEFAULTS = {
  beds: 102423,               // physical G&A beds, England
  staffingPct: 100,           // % of nursing establishment in post; available beds scale with it (capped at 100)
  escalationPct: 0,           // extra % of beds opened 1 Dec - 31 Mar
  corridorPct: 0,             // temporary escalation spaces (trolleys/chairs in corridors and wards) as % of beds,
                              // used only when every proper bed is full
  poolSize: 92,               // effective pool size (bed flexibility)
  emergPerYear: 6.6e6,        // emergency admissions (all routes), England
  electivePerYear: 1.6e6,     // elective overnight admissions
  // patient groups: share of emergency admissions and multipliers (see demand.js)
  groups: [{ name: "All", share: 1, losMult: 1, delayMult: 1 }],
  sameDayFrac: 0.30,          // emergency admissions discharged same day (SDEC-like)
  losMedianDays: 3.0,         // emergency overnight acute LOS median (lognormal)
  losSigma: 1.0,
  losChangePct: 0,            // scenario change to acute LOS
  delayProb: 0.20,            // share of overnight emergency patients delayed once medically fit
  delayMeanDays: 4.3,         // mean delay (gamma, shape 1.5)
  electiveLosMedianDays: 2.0,
  electiveLosSigma: 0.8,
  seasonAmp: 0.04,            // +/- non-flu emergency demand, peak mid-January
  fluPerYear: 0,              // emergency admissions with influenza (separate winter wave)
  fluPeakDoy: 5,              // day of year of the flu peak (5 January)
  fluSdDays: 21,              // spread of the flu wave (standard deviation, days)
  fluLosMult: 1.3,            // flu patients' stay relative to the average emergency patient
  dischargeStart: 10,         // discharge window (hours)
  dischargeEnd: 20,
  weekendDischargePct: 50,    // % of weekend-ready patients discharged at the weekend
  electiveWaitUntil: 20,      // electives without a bed by this hour are cancelled
  days: 365,
  warmupDays: 60,
};

// ---------------------------------------------------------------- one replication
export function simulate(p, seed = 1, wantDaily = true) {
  const R = rng(seed);
  const nDays = p.warmupDays + p.days;
  const warmH = p.warmupDays * 24, endH = nDays * 24;
  const availableBeds = p.beds * Math.min(1, p.staffingPct / 100);
  const nPools = availableBeds / p.poolSize;
  const S0 = p.poolSize;
  const doy0 = 91 - p.warmupDays; // day-of-year of simulated day 0 (1 April = ~91)
  const dow0 = (7 - (p.warmupDays % 7)) % 7; // so that day warmupDays is a Monday
  const losScale = 1 + p.losChangePct / 100;
  const weekendDefer = 1 - p.weekendDischargePct / 100;
  const dStart = p.dischargeStart, dLen = Math.max(1, p.dischargeEnd - p.dischargeStart);

  // capacity by day (winter escalation beds, stochastic rounding)
  const capByDay = new Int32Array(nDays);
  const escBeds = S0 * p.escalationPct / 100;
  // Capacity settings use their own random stream so that changing them never changes the
  // simulated patients (common random numbers across scenarios).
  const RC = rng((seed * 2654435761) ^ 0x5bd1e995);
  const escInt = Math.floor(escBeds) + (RC.next() < escBeds - Math.floor(escBeds) ? 1 : 0);
  for (let d = 0; d < nDays; d++) {
    const doy = (((d + doy0) % 365) + 365) % 365;
    const winter = doy >= 334 || doy < 90; // 1 Dec - 31 Mar
    capByDay[d] = S0 + (winter ? escInt : 0);
  }

  // group sampling table
  const g = p.groups;
  const gTot = g.reduce((s, x) => s + x.share, 0);
  const gCum = []; let acc = 0;
  for (const x of g) { acc += x.share / gTot; gCum.push(acc); }
  const pickGroup = () => { const u = R.next(); for (let i = 0; i < gCum.length; i++) if (u < gCum[i]) return i; return gCum.length - 1; };

  const dischargeTime = (ready) => {
    let day = Math.floor(ready / 24), hr = ready - day * 24, t = ready;
    if (hr < dStart) t = day * 24 + dStart + R.next() * dLen;
    else if (hr >= dStart + dLen) { day += 1; t = day * 24 + dStart + R.next() * dLen; }
    const dow = (day + dow0) % 7;
    if (dow >= 5 && R.next() < weekendDefer) { day += 7 - dow; t = day * 24 + dStart + R.next() * dLen; }
    return t;
  };

  // emergency arrivals, generated hour by hour
  const lamDay = p.emergPerYear / 365 / nPools;
  const arr = [];
  for (let d = 0; d < nDays; d++) {
    const season = 1 + p.seasonAmp * Math.cos(2 * Math.PI * (d + doy0 - 15) / 365);
    const wk = WEEKDAY[(d + dow0) % 7];
    for (let h = 0; h < 24; h++) {
      const n = R.poisson(lamDay / 24 * season * wk * HOURLY[h]);
      for (let i = 0; i < n; i++) arr.push(d * 24 + h + R.next());
    }
  }
  // influenza wave: Gaussian in time around the peak day
  const flu = [];
  if (p.fluPerYear > 0) {
    const perPool = p.fluPerYear / nPools, norm = 1 / (p.fluSdDays * Math.sqrt(2 * Math.PI));
    for (let d = 0; d < nDays; d++) {
      const doy = d + doy0;
      // distance to the nearest peak (peak each January)
      let dist = ((doy - p.fluPeakDoy) % 365 + 365) % 365;
      if (dist > 182.5) dist -= 365;
      const lam = perPool * norm * Math.exp(-0.5 * (dist / p.fluSdDays) ** 2);
      for (let h = 0; h < 24; h++) {
        const n = R.poisson(lam / 24 * HOURLY[h]);
        for (let i = 0; i < n; i++) flu.push(d * 24 + h + R.next());
      }
    }
  }
  // merge: emergency arrivals carry a flag for flu patients
  const nFluOffset = arr.length;
  for (const t of flu) arr.push(t);
  const order = Array.from(arr.keys()).sort((a, b) => arr[a] - arr[b]);
  const isFlu = new Uint8Array(arr.length);
  { const sorted = order.map((i) => arr[i]); order.forEach((i, j) => { if (i >= nFluOffset) isFlu[j] = 1; }); arr.length = 0; for (const t of sorted) arr.push(t); }
  // elective arrivals: weekdays 11:00-15:00
  const lamEl = p.electivePerYear / 365 / nPools * 7 / 5;
  const el = [];
  for (let d = 0; d < nDays; d++) {
    if ((d + dow0) % 7 < 5) {
      const n = R.poisson(lamEl);
      for (let i = 0; i < n; i++) el.push(d * 24 + 11 + 4 * R.next());
    }
  }
  el.sort((a, b) => a - b);

  const heap = new MinHeap();
  const readyOf = new Map(); // in-bed key -> time medically fit
  const queue = []; let qHead = 0; // emergency queue (indices into arr)
  const elQueue = []; let eHead = 0;
  let occupied = 0, key = 0;
  let ia = 0, ie = 0, snapT = 0;
  const waits = [];
  let elecOffered = 0, elecCancelled = 0;
  const occMid = [], occ8 = [], nctrMid = [], capMid = [], fluMid = [];
  const fluInBed = new Set();

  const cap = (t) => capByDay[Math.min(nDays - 1, Math.floor(t / 24))];
  const tesN = S0 * (p.corridorPct || 0) / 100;
  const tesSpaces = Math.floor(tesN) + (RC.next() < tesN - Math.floor(tesN) ? 1 : 0);
  const capE = (t) => cap(t) + tesSpaces; // proper beds + temporary escalation spaces
  const queueMid = [], queue8 = [], tesMid = [], tes8 = [];

  const FLU_GROUP = { losMult: p.fluLosMult, delayMult: 1 };
  const admitEmergency = (t, i) => {
    key++;
    const grp = isFlu[i] ? FLU_GROUP : g[pickGroup()];
    let ready, dis;
    if (R.next() < p.sameDayFrac) {
      ready = dis = t + 3 + 7 * R.next();
    } else {
      const los = 24 * p.losMedianDays * losScale * grp.losMult * Math.exp(p.losSigma * R.normal());
      ready = dischargeTime(t + los);
      dis = ready;
      if (R.next() < Math.min(1, p.delayProb * grp.delayMult)) {
        dis = dischargeTime(ready + 24 * R.gamma(1.5, p.delayMeanDays / 1.5));
      }
    }
    heap.push(dis, key); readyOf.set(key, ready); occupied++;
    if (isFlu[i]) fluInBed.add(key);
  };
  const admitElective = (t) => {
    key++;
    const dis = dischargeTime(t + 24 * p.electiveLosMedianDays * losScale * Math.exp(p.electiveLosSigma * R.normal()));
    heap.push(dis, key); readyOf.set(key, dis); occupied++;
  };
  const deadline = (j) => Math.floor(el[j] / 24) * 24 + p.electiveWaitUntil;
  const fillFreeBeds = (t) => {
    while (occupied < capE(t)) {
      if (qHead < queue.length) {
        const i = queue[qHead++];
        if (arr[i] >= warmH) waits.push(t - arr[i]);
        admitEmergency(t, i);
      } else if (eHead < elQueue.length) {
        const j = elQueue[eHead++];
        if (t <= deadline(j)) admitElective(t);
        else if (el[j] >= warmH) elecCancelled++;
      } else break;
    }
  };

  for (;;) {
    const ta = ia < arr.length ? arr[ia] : Infinity;
    const te = ie < el.length ? el[ie] : Infinity;
    const td = heap.peek();
    const t = Math.min(ta, te, td, snapT);
    if (t >= endH) break;
    if (t === snapT) {
      const isMidnight = snapT % 24 === 0;
      if (isMidnight) fillFreeBeds(t); // capacity may change at midnight
      if (t >= warmH) {
        if (isMidnight) {
          occMid.push(Math.min(occupied, cap(t))); capMid.push(cap(t)); fluMid.push(fluInBed.size);
          queueMid.push(queue.length - qHead); tesMid.push(Math.max(0, occupied - cap(t)));
          let n = 0; for (const r of readyOf.values()) if (r <= t) n++;
          nctrMid.push(n);
        } else {
          occ8.push(Math.min(occupied, cap(t)));
          queue8.push(queue.length - qHead); tes8.push(Math.max(0, occupied - cap(t)));
        }
      }
      snapT += isMidnight ? 8 : 16;
    } else if (t === td) {
      const k = heap.pop(); readyOf.delete(k); fluInBed.delete(k); occupied--;
      fillFreeBeds(t);
    } else if (t === ta) {
      if (occupied < capE(t) && qHead >= queue.length) {
        if (ta >= warmH) waits.push(0);
        admitEmergency(t, ia);
      } else queue.push(ia);
      ia++;
    } else {
      if (te >= warmH) elecOffered++;
      if (occupied < cap(t) && qHead >= queue.length) admitElective(t); // planned patients never go to a corridor
      else elQueue.push(ie);
      ie++;
    }
  }
  for (let j = eHead; j < elQueue.length; j++) if (el[elQueue[j]] >= warmH) elecCancelled++;
  for (let q = qHead; q < queue.length; q++) if (arr[queue[q]] >= warmH) waits.push(endH - arr[queue[q]]);

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const occSum = sum(occMid), capSum = sum(capMid);
  let w4 = 0, w12 = 0, wSum = 0;
  for (const w of waits) { wSum += w; if (w > 4) w4++; if (w > 12) w12++; }
  let full = 0; for (let i = 0; i < occMid.length; i++) if (occMid[i] >= capMid[i]) full++;
  return {
    occMidnight: occSum / capSum,
    occ8am: sum(occ8) / (S0 * occ8.length),
    nightsFull: full / occMid.length,
    nctrShare: sum(nctrMid) / Math.max(occSum, 1),
    nctrBeds: sum(nctrMid) / nctrMid.length,
    occupiedBeds: occSum / occMid.length,
    emergAdmitted: waits.length,
    waitMeanH: waits.length ? wSum / waits.length : 0,
    wait4: waits.length ? w4 / waits.length : 0,
    wait12: waits.length ? w12 / waits.length : 0,
    elecOffered, elecCancelled,
    daily: wantDaily ? occMid.map((o, i) => o / capMid[i]) : null,
    fluDaily: fluMid,
    queue8: sum(queue8) / queue8.length,          // patients waiting in A&E for a bed at 08:00
    queue8Max: Math.max(...queue8),
    tes8: sum(tes8) / tes8.length,                // patients in temporary escalation spaces at 08:00
    corridorDaily8: queue8.map((q, i) => q + tes8[i]),
    nPools,
  };
}

// ---------------------------------------------------------------- many replications
export function run(p, reps = 20, seed0 = 1000, onProgress = null) {
  const out = [];
  for (let r = 0; r < reps; r++) {
    out.push(simulate(p, seed0 + r, true));
    if (onProgress) onProgress((r + 1) / reps);
  }
  const mean = (f) => out.reduce((s, x) => s + f(x), 0) / out.length;
  const nW = out.reduce((s, x) => s + x.emergAdmitted, 0);
  const wmean = (f) => out.reduce((s, x) => s + f(x) * x.emergAdmitted, 0) / Math.max(nW, 1);
  const se = (f) => {
    const m = mean(f);
    return Math.sqrt(out.reduce((s, x) => s + (f(x) - m) ** 2, 0) / Math.max(out.length - 1, 1) / out.length);
  };
  const days = out[0].daily.length;
  const daily = new Array(days).fill(0);
  for (const x of out) for (let i = 0; i < days; i++) daily[i] += x.daily[i] / out.length;
  const nPools = out[0].nPools;
  const corridor8 = new Array(days).fill(0);
  for (const x of out) for (let i = 0; i < Math.min(days, x.corridorDaily8.length); i++) corridor8[i] += x.corridorDaily8[i] * nPools / out.length;
  const fluDaily = new Array(days).fill(0);
  for (const x of out) for (let i = 0; i < days; i++) fluDaily[i] += x.fluDaily[i] * nPools / out.length;
  const availableBeds = p.beds * Math.min(1, p.staffingPct / 100);
  return {
    occMidnight: mean((x) => x.occMidnight),
    occMidnightSE: se((x) => x.occMidnight),
    occ8am: mean((x) => x.occ8am),
    nightsFull: mean((x) => x.nightsFull),
    nctrShare: mean((x) => x.nctrShare),
    nctrBedsNational: mean((x) => x.nctrBeds) * nPools,
    occupiedBedsNational: mean((x) => x.occupiedBeds) * nPools,
    availableBeds,
    waitMeanH: wmean((x) => x.waitMeanH),
    wait4: wmean((x) => x.wait4),
    wait12: wmean((x) => x.wait12),
    wait12SE: se((x) => x.wait12),
    wait12PerYear: wmean((x) => x.wait12) * p.emergPerYear,
    wait4PerYear: wmean((x) => x.wait4) * p.emergPerYear,
    elecCancelRate: out.reduce((s, x) => s + x.elecCancelled, 0) / Math.max(out.reduce((s, x) => s + x.elecOffered, 0), 1),
    daily,
    fluBedsPeak: Math.max(...fluDaily),
    waitingForBed8am: mean((x) => x.queue8) * nPools,
    inEscalationSpaces8am: mean((x) => x.tes8) * nPools,
    corridorCare8am: mean((x) => x.queue8 + x.tes8) * nPools,
    corridorCarePeak: Math.max(...corridor8),
    corridorDaily8: corridor8,
    fluBedsDaily: fluDaily,
    reps,
  };
}
