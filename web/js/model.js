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
  deadlineH: 0,               // research option (off by default): once the longest-waiting emergency patient has waited
  deadlinePct: 0,             // this many hours, extra spaces (as % of beds) open for patients past that wait
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
  delayMeanDays: 4.3,         // mean delay (gamma distribution)
  delayShape: 1.5,            // gamma shape of the delay distribution
  electiveLosMedianDays: 2.0,
  electiveLosSigma: 0.8,
  electiveWeekday: [1, 1, 1, 1, 1], // relative planned admissions Mon-Fri
  seasonAmp: 0.04,            // +/- non-flu emergency demand, peak mid-January
  fluPerYear: 0,              // emergency admissions with influenza (separate winter wave)
  fluPeakDoy: 5,              // day of year of the flu peak (5 January)
  fluSdDays: 21,              // spread of the flu wave (standard deviation, days)
  fluLosMult: 1.3,            // flu patients' stay relative to the average emergency patient
  prepHours: 3,               // average hours from ward round to leaving hospital
  dischargeStart: 9,          // discharge window (hours)
  dischargeEnd: 20,
  weekendDischargePct: 50,    // % of weekend-ready patients discharged at the weekend
  electiveWaitUntil: 20,      // electives without a bed by this hour are cancelled
  days: 365,
  warmupDays: 60,
};

// ---------------------------------------------------------------- one replication
export function simulate(p, seed = 1, wantDaily = true) {
  // Common random numbers. Arrivals are drawn as candidates at a fixed reference rate and each is kept
  // with probability (actual rate / reference rate); every candidate carries its own random seed for
  // everything that happens to that patient. A scenario with less demand therefore removes some
  // patients and leaves all the others exactly as they were, and a scenario with fewer beds faces the
  // same patients. This makes scenario-minus-baseline differences far more precise.
  const RA = rng(seed);                                  // emergency arrivals
  const RF = rng((seed * 0x9e3779b1) ^ 0x2545f491);      // influenza arrivals
  const RE = rng((seed * 0x85ebca6b) ^ 0x68e31da4);      // planned arrivals
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
  const pickGroup = (u) => { for (let i = 0; i < gCum.length; i++) if (u < gCum[i]) return i; return gCum.length - 1; };

  // Discharge process. A patient who becomes medically fit is confirmed ready at the next morning
  // ward round (09:00-12:00; anyone fit after 12:00 waits for the next day's round): that date is
  // their Discharge Ready Date. They leave after the preparation time (medicines, transport,
  // paperwork), never after the end of the discharge window. At weekends only the chosen share of
  // ready patients are discharged; the rest leave on Monday.
  const wardRound = (fit, P) => {
    let day = Math.floor(fit / 24);
    if (fit - day * 24 > 12) day += 1;
    return day * 24 + 9 + 3 * P.next();
  };
  const prep = p.prepHours;
  const leaveAfter = (ready, P) => {
    // the same draws are used whatever the branch, so a patient's randomness does not depend on settings
    const u1 = P.next(), u2 = P.next(), u3 = P.next(), u4 = P.next(), u5 = P.next(), u6 = P.next();
    let t = ready + prep * (0.4 + 1.2 * u1);
    let day = Math.floor(t / 24);
    if (t - day * 24 >= dStart + dLen) { day += 1; t = day * 24 + 9 + 3 * u2 + prep * (0.4 + 1.2 * u3); }
    const dow = (day + dow0) % 7;
    if (dow >= 5 && u4 < weekendDefer) { day += 7 - dow; t = day * 24 + 9 + 3 * u5 + prep * (0.4 + 1.2 * u6); }
    return t;
  };
  // reference (candidate) rates per pool; see the note at the top of this function
  const ref = p.crnRef || {};
  const headroom = (actual, reference) => {
    if (!(reference > 0)) return Math.max(actual, 1e-9) * 2.5;
    let h = 2.5;
    while (actual > reference * h) h *= 2; // extreme scenarios: still correct, but no longer paired with the baseline
    return reference * h;
  };

  const seedOf = (S) => (S.next() * 4294967296) >>> 0;
  // emergency arrivals, generated hour by hour
  const lamDay = p.emergPerYear / 365 / nPools;
  const candDay = headroom(lamDay, ref.emergPerBedDay * p.poolSize);
  const keepE = lamDay / candDay;
  const raw = []; // [time, seed, flu]
  for (let d = 0; d < nDays; d++) {
    const season = 1 + p.seasonAmp * Math.cos(2 * Math.PI * (d + doy0 - 15) / 365);
    const wk = WEEKDAY[(d + dow0) % 7];
    for (let h = 0; h < 24; h++) {
      const n = RA.poisson(candDay / 24 * season * wk * HOURLY[h]);
      for (let i = 0; i < n; i++) {
        const t = d * 24 + h + RA.next(), u = RA.next(), sd = seedOf(RA);
        if (u < keepE) raw.push([t, sd, 0]);
      }
    }
  }
  // influenza wave: Gaussian in time around the peak day
  if (p.fluPerYear > 0) {
    const perPool = p.fluPerYear / nPools, norm = 1 / (p.fluSdDays * Math.sqrt(2 * Math.PI));
    const candPool = headroom(perPool, ref.fluPerBedYear * p.poolSize);
    const keepF = perPool / candPool;
    for (let d = 0; d < nDays; d++) {
      const doy = d + doy0;
      // distance to the nearest peak (peak each January)
      let dist = ((doy - p.fluPeakDoy) % 365 + 365) % 365;
      if (dist > 182.5) dist -= 365;
      const lam = candPool * norm * Math.exp(-0.5 * (dist / p.fluSdDays) ** 2);
      for (let h = 0; h < 24; h++) {
        const n = RF.poisson(lam / 24 * HOURLY[h]);
        for (let i = 0; i < n; i++) {
          const t = d * 24 + h + RF.next(), u = RF.next(), sd = seedOf(RF);
          if (u < keepF) raw.push([t, sd, 1]);
        }
      }
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const arr = raw.map((x) => x[0]);
  const arrSeed = new Uint32Array(raw.map((x) => x[1]));
  const isFlu = new Uint8Array(raw.map((x) => x[2]));
  // elective arrivals: weekdays 11:00-15:00
  const lamEl = p.electivePerYear / 365 / nPools * 7 / 5;
  const candEl = headroom(lamEl, ref.electivePerBedDay * p.poolSize * 7 / 5);
  const keepL = lamEl / candEl;
  const elW = p.electiveWeekday || [1, 1, 1, 1, 1];
  const elWm = elW.reduce((a, b) => a + b, 0) / 5;
  const elRaw = [];
  for (let d = 0; d < nDays; d++) {
    if ((d + dow0) % 7 < 5) {
      const n = RE.poisson(candEl * elW[(d + dow0) % 7] / elWm);
      for (let i = 0; i < n; i++) {
        const t = d * 24 + 11 + 4 * RE.next(), u = RE.next(), sd = seedOf(RE);
        if (u < keepL) elRaw.push([t, sd]);
      }
    }
  }
  elRaw.sort((a, b) => a[0] - b[0]);
  const el = elRaw.map((x) => x[0]);
  const elSeed = new Uint32Array(elRaw.map((x) => x[1]));

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
  const admitOf = new Map();
  let emBedDays = 0, emCount = 0, emDelayed = 0, emOvernight = 0, elDelayed = 0, elOvernight = 0;
  const long21_8 = [], long7_8 = [], long14_8 = [];
  // discharges of patients who were medically fit before the day began, by weekday (Mon=0),
  // and the matching midnight stock, to compare with NHS England's discharge sitrep
  const nctrDisWk = new Float64Array(7), nctrStockWk = new Float64Array(7);
  let lastMidnightNctr = 0;

  const cap = (t) => capByDay[Math.min(nDays - 1, Math.floor(t / 24))];
  const tesN = S0 * (p.corridorPct || 0) / 100;
  const tesSpaces = Math.floor(tesN) + (RC.next() < tesN - Math.floor(tesN) ? 1 : 0);
  const capE = (t) => cap(t) + tesSpaces; // proper beds + temporary escalation spaces
  const dlN = p.deadlineH > 0 ? S0 * (p.deadlinePct || 0) / 100 : 0;
  const dlSpaces = dlN > 0 ? Math.floor(dlN) + (RC.next() < dlN - Math.floor(dlN) ? 1 : 0) : 0;
  // next time the queue head reaches the deadline, while a deadline space is free
  // (never earlier than the last event handled, tNow)
  let tNow = 0;
  const nextDeadline = () => (dlSpaces > 0 && qHead < queue.length && occupied < capE(tNow) + dlSpaces ? Math.max(tNow, arr[queue[qHead]] + p.deadlineH) : Infinity);
  const queueMid = [], queue8 = [], tesMid = [], tes8 = [], queue8_45 = [];
  // emergency patients whose wait for a bed passed 45 minutes, by day of arrival (comparable with NHS England's
  // count of patients receiving corridor care in ED for 45+ minutes during each day)
  const wait45ByDay = new Float64Array(nDays);

  const FLU_GROUP = { losMult: p.fluLosMult, delayMult: 1 };
  const admitEmergency = (t, i) => {
    key++;
    const P = rng(arrSeed[i]);
    // fixed order of draws for every patient
    const uGroup = P.next(), uSame = P.next(), uSameT = P.next(), z = P.normal(), uDelay = P.next();
    const delayDays = P.gamma(p.delayShape, p.delayMeanDays / p.delayShape);
    const grp = isFlu[i] ? FLU_GROUP : g[pickGroup(uGroup)];
    let ready, dis, overnight = false;
    if (uSame < p.sameDayFrac) {
      ready = dis = t + 3 + 7 * uSameT;
    } else {
      overnight = true;
      const los = 24 * p.losMedianDays * losScale * grp.losMult * Math.exp(p.losSigma * z);
      ready = wardRound(t + los, P);
      dis = leaveAfter(ready, P);
      if (uDelay < Math.min(1, p.delayProb * grp.delayMult)) {
        dis = leaveAfter(ready + 24 * delayDays, P);
      }
    }
    heap.push(dis, key); readyOf.set(key, ready); occupied++;
    admitOf.set(key, t);
    if (isFlu[i]) fluInBed.add(key);
    if (t >= warmH) {
      // midnights spent in hospital (KH03 bed days); for overnight patients, whether they left on a
      // later date than the date they became medically fit (the Discharge Ready Date measure)
      emBedDays += Math.floor(dis / 24) - Math.floor(t / 24); emCount++;
      if (overnight) { emOvernight++; if (Math.floor(dis / 24) > Math.floor(ready / 24)) emDelayed++; }
    }
  };
  const admitElective = (t, j) => {
    key++;
    const P = rng(elSeed[j]);
    const ready = wardRound(t + 24 * p.electiveLosMedianDays * losScale * Math.exp(p.electiveLosSigma * P.normal()), P);
    const dis = leaveAfter(ready, P);
    heap.push(dis, key); readyOf.set(key, ready); occupied++;
    admitOf.set(key, t);
    if (t >= warmH) { elOvernight++; if (Math.floor(dis / 24) > Math.floor(ready / 24)) elDelayed++; }
  };
  const deadline = (j) => Math.floor(el[j] / 24) * 24 + p.electiveWaitUntil;
  const fillFreeBeds = (t) => {
    while (occupied < capE(t)) {
      if (qHead < queue.length) {
        const i = queue[qHead++];
        if (arr[i] >= warmH) waits.push(t - arr[i]);
        if (t - arr[i] >= 0.75) wait45ByDay[Math.floor(arr[i] / 24)]++;
        admitEmergency(t, i);
      } else if (eHead < elQueue.length) {
        const j = elQueue[eHead++];
        if (t <= deadline(j)) admitElective(t, j);
        else if (el[j] >= warmH) elecCancelled++;
      } else break;
    }
    // deadline escalation: patients past the deadline may use the extra spaces
    while (dlSpaces > 0 && qHead < queue.length && t - arr[queue[qHead]] >= p.deadlineH - 1e-9 && occupied < capE(t) + dlSpaces) {
      const i = queue[qHead++];
      if (arr[i] >= warmH) waits.push(t - arr[i]);
      if (t - arr[i] >= 0.75) wait45ByDay[Math.floor(arr[i] / 24)]++;
      admitEmergency(t, i);
    }
  };

  for (;;) {
    const ta = ia < arr.length ? arr[ia] : Infinity;
    const te = ie < el.length ? el[ie] : Infinity;
    const td = heap.peek();
    const tdl = nextDeadline();
    const t = Math.min(ta, te, td, snapT, tdl);
    if (t >= endH) break;
    tNow = t;
    if (t === tdl && t < Math.min(ta, te, td, snapT)) {
      fillFreeBeds(t);
    } else if (t === snapT) {
      const isMidnight = snapT % 24 === 0;
      if (isMidnight) fillFreeBeds(t); // capacity may change at midnight
      if (t >= warmH) {
        if (isMidnight) {
          occMid.push(Math.min(occupied, cap(t))); capMid.push(cap(t)); fluMid.push(fluInBed.size);
          queueMid.push(queue.length - qHead); tesMid.push(Math.max(0, occupied - cap(t)));
          let n = 0; for (const r of readyOf.values()) if (r <= t) n++;
          nctrMid.push(n);
          nctrStockWk[(Math.floor(t / 24) + dow0) % 7] += n;
        } else {
          occ8.push(Math.min(occupied, cap(t)));
          let n21 = 0, n7 = 0, n14 = 0;
          for (const a of admitOf.values()) { const d = t - a; if (d >= 7 * 24) { n7++; if (d >= 14 * 24) { n14++; if (d >= 21 * 24) n21++; } } }
          long21_8.push(n21); long7_8.push(n7); long14_8.push(n14);
          queue8.push(queue.length - qHead); tes8.push(Math.max(0, occupied - cap(t)));
          // NHS England's corridor-care definition: at least 45 minutes in an inappropriate area
          let n45 = 0; for (let q = qHead; q < queue.length; q++) if (t - arr[queue[q]] >= 0.75) n45++;
          queue8_45.push(n45);
        }
      }
      snapT += isMidnight ? 8 : 16;
    } else if (t === td) {
      const k = heap.pop();
      if (t >= warmH && readyOf.get(k) <= Math.floor(t / 24) * 24) nctrDisWk[(Math.floor(t / 24) + dow0) % 7]++;
      readyOf.delete(k); fluInBed.delete(k); admitOf.delete(k); occupied--;
      fillFreeBeds(t);
    } else if (t === ta) {
      if (occupied < capE(t) && qHead >= queue.length) {
        if (ta >= warmH) waits.push(0);
        admitEmergency(t, ia);
      } else queue.push(ia);
      ia++;
    } else {
      if (te >= warmH) elecOffered++;
      if (occupied < cap(t) && qHead >= queue.length) admitElective(t, ie); // planned patients never go to a corridor
      else elQueue.push(ie);
      ie++;
    }
  }
  for (let j = eHead; j < elQueue.length; j++) if (el[elQueue[j]] >= warmH) elecCancelled++;
  for (let q = qHead; q < queue.length; q++) {
    if (arr[queue[q]] >= warmH) waits.push(endH - arr[queue[q]]);
    if (endH - arr[queue[q]] >= 0.75) wait45ByDay[Math.floor(arr[queue[q]] / 24)]++;
  }

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
    daily8: wantDaily ? occ8.map((o, i) => o / capMid[Math.min(i, capMid.length - 1)]) : null,
    fluDaily: fluMid,
    nctrDisWk: Array.from(nctrDisWk), nctrStockWk: Array.from(nctrStockWk),
    long21Share8: sum(long21_8) / Math.max(sum(occ8), 1),          // share of occupied beds with stay >= 21 days (08:00)
    long7Share8: sum(long7_8) / Math.max(sum(occ8), 1), long14Share8: sum(long14_8) / Math.max(sum(occ8), 1),
    emBedDaysPerAdm: emBedDays / Math.max(emCount, 1),               // midnights per emergency admission
    // share of overnight discharges (emergency and planned) leaving after their Discharge Ready Date
    delayedShareOvernight: (emDelayed + elDelayed) / Math.max(emOvernight + elOvernight, 1),
    queue8: sum(queue8) / queue8.length,          // patients waiting in A&E for a bed at 08:00
    queue8Max: Math.max(...queue8),
    tes8: sum(tes8) / tes8.length,                // patients in temporary escalation spaces at 08:00
    corridorDaily8: queue8.map((q, i) => q + tes8[i]),
    queue45Daily8: queue8_45, tesDaily8: tes8, wait45Daily: Array.from(wait45ByDay.slice(p.warmupDays)),
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
  // national 08:00 series: England is the average of many independent bed pools, so the average
  // across replications (each one pool) approximates the national daily series
  const daily8 = new Array(out[0].daily8.length).fill(0);
  for (const x of out) for (let i = 0; i < daily8.length; i++) daily8[i] += x.daily8[i] / out.length;
  const nPools = out[0].nPools;
  const corridor8 = new Array(days).fill(0);
  for (const x of out) for (let i = 0; i < Math.min(days, x.corridorDaily8.length); i++) corridor8[i] += x.corridorDaily8[i] * nPools / out.length;
  const ed45Daily8 = new Array(days).fill(0), wardDaily8 = new Array(days).fill(0), wait45Daily = new Array(days).fill(0);
  for (const x of out) for (let i = 0; i < Math.min(days, x.tesDaily8.length); i++) {
    ed45Daily8[i] += x.queue45Daily8[i] * nPools / out.length; wardDaily8[i] += x.tesDaily8[i] * nPools / out.length;
    wait45Daily[i] += x.wait45Daily[i] * nPools / out.length;
  }
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
    // peak of the 7-day rolling mean (robust to day-to-day noise; same definition used for the data)
    fluBedsPeak: Math.max(...fluDaily.map((_, i) => i < 6 ? 0 : fluDaily.slice(i - 6, i + 1).reduce((a, b) => a + b, 0) / 7)),
    long21Share: mean((x) => x.long21Share8),
    long7Share: mean((x) => x.long7Share8), long14Share: mean((x) => x.long14Share8),
    emBedDaysPerAdm: mean((x) => x.emBedDaysPerAdm),
    delayedShareOvernight: mean((x) => x.delayedShareOvernight),
    waitingForBed8am: mean((x) => x.queue8) * nPools,
    inEscalationSpaces8am: mean((x) => x.tes8) * nPools,
    corridorCare8am: mean((x) => x.queue8 + x.tes8) * nPools,
    corridorCarePeak: Math.max(...corridor8),
    corridorDaily8: corridor8,
    // one value per replication, for telling real changes from simulation noise. Scenario and baseline use the
    // same random numbers replication by replication, so compare them pair by pair (see app.js)
    perRep: {
      occ: out.map((x) => x.occMidnight),
      nightsFull: out.map((x) => x.nightsFull),
      wait12: out.map((x) => x.wait12),
      wait4: out.map((x) => x.wait4),
      elec: out.map((x) => x.elecCancelled / Math.max(x.elecOffered, 1)),
      ward8: out.map((x) => x.tes8 * nPools),
      queue8: out.map((x) => x.queue8 * nPools),
      nctrBeds: out.map((x) => x.nctrBeds * nPools),
      monthly: out.map((x) => [0, 30, 61, 91, 122, 153, 183, 214, 245, 275, 306, 334, 365].slice(0, 12)
        .map((st, i, a) => { const e = i < 11 ? a[i + 1] : 365; let t = 0; for (let d = st; d < e; d++) t += x.daily[d]; return t / (e - st); })),
      fluPeak: out.map((x) => { let best = 0, run7 = 0; const f = x.fluDaily;
        for (let i = 0; i < f.length; i++) { run7 += f[i] - (i >= 7 ? f[i - 7] : 0); if (i >= 6) best = Math.max(best, run7 / 7); } return best * nPools; }),
    },
    // 08:00 snapshot, as NHS England's corridor-care collection: emergency patients waiting 45+ minutes for a
    // bed, and patients in temporary escalation spaces on wards (day 0 = 1 April)
    waiting45Daily8: ed45Daily8, escalationDaily8: wardDaily8,
    // emergency patients per day whose wait for a bed reached 45 minutes. In all daily series, day i is
    // i days after 1 April and falls on weekday i % 7 (Monday = 0)
    waited45Daily: wait45Daily,
    // weekend / weekday ratio of discharge rates among medically fit patients
    weekendDischargeRatio: (() => {
      const dis = [0, 0, 0, 0, 0, 0, 0], st = [0, 0, 0, 0, 0, 0, 0];
      for (const x of out) for (let i = 0; i < 7; i++) { dis[i] += x.nctrDisWk[i]; st[i] += x.nctrStockWk[i]; }
      const r = dis.map((d, i) => d / Math.max(st[i], 1));
      return ((r[5] + r[6]) / 2) / ((r[0] + r[1] + r[2] + r[3] + r[4]) / 5);
    })(),
    fluBedsDaily: fluDaily,
    daily8,
    reps,
  };
}
