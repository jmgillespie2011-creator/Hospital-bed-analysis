// Mechanism test D: can bed-specific blocking by long-stay patients explain why long stays started to matter after
// the pandemic? A hospital of specialty wards; each emergency patient has a home ward. With outlying allowed, a
// patient can take a free bed on any ward (and a freed bed can take a patient queuing for another ward); without
// it, patients wait for their own ward. Long-stay patients are either spread evenly or concentrated in a third of
// wards (as on elderly-care and general medical wards). Occupancy is held fixed by setting the arrival rate.
// Writes web/data/longstay_mechanism.json.  Usage: node scripts/longstay_mechanism.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const HOURLY = [0.45, 0.35, 0.3, 0.25, 0.25, 0.3, 0.45, 0.7, 1, 1.25, 1.4, 1.5, 1.55, 1.55, 1.5, 1.45, 1.4, 1.35, 1.3, 1.2, 1.05, 0.9, 0.7, 0.55];
const HM = HOURLY.reduce((a, b) => a + b) / 24, PEAK = Math.max(...HOURLY) / HM;

// One hospital: WARDS wards of BEDS beds. Patients: short stay (lognormal, median 3 days) or long stay (median 26 days).
// outlying: probability that a patient may use (or a freed bed may take) another ward's bed: 1 = fully shared, 0 = never
function simulate({ wards = 20, beds = 28, occ = 0.915, longFrac, clustered, outlying, years = 3, seed = 1 }) {
  const R = rng(seed), normal = () => { let u = 0; while (u === 0) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); };
  const SHORT = { med: 3 * 24, sig: 0.8 }, LONG = { med: 26 * 24, sig: 0.4 };
  const meanLos = (k) => k.med * Math.exp(k.sig ** 2 / 2);
  // long-stay probability by ward: even, or all long-stay patients on the first third of wards
  const hot = Math.round(wards / 3);
  const pLong = Array.from({ length: wards }, (_, w) => (clustered ? (w < hot ? Math.min(1, longFrac * wards / hot) : 0) : longFrac));
  // each ward gets demand matched to its capacity (equal offered load), as hospitals size wards to their patients
  const wardMean = pLong.map((p) => p * meanLos(LONG) + (1 - p) * meanLos(SHORT));
  const wWeight = wardMean.map((m) => 1 / m), wTot = wWeight.reduce((a, b) => a + b);
  const wCum = []; { let a = 0; for (const x of wWeight) { a += x / wTot; wCum.push(a); } }
  const lamH = occ * beds * wWeight.reduce((a, b) => a + b); // arrivals per hour, all wards
  const endH = years * 365 * 24, warmH = 120 * 24;
  const free = Array.from({ length: wards }, () => beds), queues = Array.from({ length: wards }, () => []);
  const heap = []; // discharge events [time, ward]
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= e[0]) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
  let waits = 0, long12 = 0, occH = 0, longBedH = 0, lastT = 0, inLong = 0, t = 0;
  const admit = (w, pt, now) => {
    free[w]--; const k = pt.long ? LONG : SHORT; push([now + k.med * Math.exp(k.sig * normal()), w, pt.long]);
    if (pt.long) inLong++;
    if (pt.t >= warmH) { waits++; if (now - pt.t > 12) long12++; }
  };
  const tick = (now) => { if (now > warmH) { const dt = now - Math.max(lastT, warmH); occH += (wards * beds - free.reduce((a, b) => a + b)) * dt; longBedH += inLong * dt; } lastT = now; };
  let nextArr = 0;
  const genArr = () => { for (;;) { nextArr += -Math.log(1 - R()) / (lamH * PEAK); if (R() < HOURLY[Math.floor(nextArr) % 24] / HM / PEAK) break; } const w = pickWard(R()); return { t: nextArr, w, long: R() < pLong[w] }; };
  const pickWard = (u) => { for (let i = 0; i < wards; i++) if (u < wCum[i]) return i; return wards - 1; };
  let pend = genArr();
  while (true) {
    const td = heap.length ? heap[0][0] : Infinity;
    t = Math.min(pend.t, td);
    if (t > endH) break;
    tick(t);
    if (td <= pend.t) {
      const [, w, wasLong] = pop(); free[w]++; if (wasLong) inLong--;
      // the freed bed takes its own ward's queue first; with outlying, otherwise the longest wait anywhere
      let from = queues[w].length ? w : -1;
      if (from < 0 && R() < outlying) { let best = Infinity; for (let v = 0; v < wards; v++) if (queues[v].length && queues[v][0].t < best) { best = queues[v][0].t; from = v; } }
      if (from >= 0) admit(w, queues[from].shift(), t);
    } else {
      const pt = pend; pend = genArr();
      let w = free[pt.w] > 0 && !queues[pt.w].length ? pt.w : -1;
      if (w < 0 && R() < outlying) { for (let v = 0; v < wards; v++) if (free[v] > 0) { w = v; break; } }
      if (w >= 0) admit(w, pt, t); else queues[pt.w].push(pt);
    }
  }
  const span = endH - warmH;
  return { occupancy: occH / (wards * beds * span), longShare: longBedH / Math.max(occH, 1), wait12: waits ? long12 / waits : 0 };
}

const out = { generated: new Date().toISOString().slice(0, 10), hospital: "20 wards x 28 beds, occupancy 91.5%", rows: [] };
const runAvg = (cfg) => { const r = [1, 2, 3, 4, 5, 6].map((seed) => simulate({ ...cfg, seed })); const a = (k) => r.reduce((s, x) => s + x[k], 0) / r.length; return { occupancy: a("occupancy"), longShare: a("longShare"), wait12: a("wait12") }; };
// 1. how much outlying reproduces today's waits (8.9%) with today's long-stay share (~19% of beds)?
const LF_TODAY = 0.033;
out.calibration = [];
for (const outlying of [1, 0.5, 0.3, 0.2, 0.15, 0.1, 0.05, 0]) {
  const r = runAvg({ longFrac: LF_TODAY, clustered: false, outlying });
  out.calibration.push({ outlying, ...r });
  console.log(`outlying ${outlying.toFixed(2)}: 21+ share ${(100 * r.longShare).toFixed(1)}%, occ ${(100 * r.occupancy).toFixed(1)}%, >12h ${(100 * r.wait12).toFixed(2)}%`);
}
const near = out.calibration.reduce((b, c) => (Math.abs(Math.log((c.wait12 + 1e-4) / 0.0885)) < Math.abs(Math.log((b.wait12 + 1e-4) / 0.0885)) ? c : b));
out.outlyingToday = near.outlying;
console.log(`-> outlying ${near.outlying} gives today's waits`);
// 2. at full sharing vs today's level, how much do long stays matter, spread or concentrated?
for (const outlying of [1, near.outlying]) for (const clustered of [false, true]) for (const longFrac of [0.025, 0.033, 0.045]) {
  const r = runAvg({ longFrac, clustered, outlying });
  out.rows.push({ outlying, clustered, longFrac, ...r });
  console.log(`outlying ${outlying}  long-stay ${clustered ? "concentrated" : "spread     "}  21+ share ${(100 * r.longShare).toFixed(1)}%  occ ${(100 * r.occupancy).toFixed(1)}%  >12h ${(100 * r.wait12).toFixed(2)}%`);
}
fs.writeFileSync(path.join(ROOT, "web/data/longstay_mechanism.json"), JSON.stringify(out, null, 1));
console.log("wrote web/data/longstay_mechanism.json");
