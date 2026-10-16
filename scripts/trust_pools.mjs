// A pool size for every acute trust in every post-pandemic year, and whether it predicts the trust's later waits.
//
// For each trust-year (KH03 beds and occupancy, A&E emergency admissions and 12-hour waits from the decision to admit;
// data/processed/trust_flexibility_panel.csv): the national model scaled to the trust's beds and admissions, stays
// scaled so its midnight occupancy matches the trust's, and the pool size fitted (bisection on its log) so its share
// waiting over 12 hours matches. A trust whose waits are below what one whole-hospital pool gives is "censored" at
// its bed count; one whose waits are above what the smallest pool gives is censored at that pool.
// Out-of-sample test: each trust's 2023/24 pool, run with its 2025/26 beds, admissions and occupancy, against
// its observed 2025/26 waits; compared with the national pool (today's calibration) run the same way.
// Writes data/processed/trust_pools.csv and trust_pools_oos.csv.  Usage: node scripts/trust_pools.mjs
// (runs four shards of trusts in parallel worker processes and merges them; SHARD=i NSHARD=n runs one shard)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
const REPS = +(process.env.REPS || 6), MIN_POOL = 8;
const YEARS = ["2022/23", "2023/24", "2025/26"];
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const csv = fs.readFileSync(path.join(ROOT, "data/processed/trust_flexibility_panel.csv"), "utf8").trim().split("\n");
const H = csv[0].split(",");
const NSHARD = +(process.env.NSHARD || 0), SHARD = +(process.env.SHARD || 0);
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
if (!process.env.NSHARD) {
  // parent: run the shards in parallel, then merge
  const n = 4;
  await Promise.all(Array.from({ length: n }, (_, i) => new Promise((res, rej) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, SHARD: String(i), NSHARD: String(n) }, stdio: "inherit" });
    c.on("exit", (code) => (code ? rej(new Error(`shard ${i} failed`)) : res()));
  })));
  const fits = [], oos = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(ROOT, `data/processed/.trust_pools_part${i}.json`), j = JSON.parse(fs.readFileSync(f, "utf8"));
    fits.push(...j.fits); oos.push(...j.oos); fs.unlinkSync(f);
  }
  fits.sort((a, b) => (a.fy + a.org).localeCompare(b.fy + b.org));
  fs.writeFileSync(path.join(ROOT, "data/processed/trust_pools.csv"), ["org,fy,beds,admissions,occupancy,wait12,longStay,pool,poolShare,censored,losChangePct",
    ...fits.map((f) => [f.org, f.fy, f.beds.toFixed(0), f.admissions, f.occupancy.toFixed(4), f.wait12.toFixed(5), f.longStay, f.pool.toFixed(1), f.poolShare.toFixed(4), f.censored, f.losChangePct.toFixed(1)].join(","))].join("\n"));
  fs.writeFileSync(path.join(ROOT, "data/processed/trust_pools_oos.csv"), ["org,observed,ownPool,nationalPool,pool2324,censored2324",
    ...oos.map((o) => [o.org, o.observed, o.ownPool, o.nationalPool, o.pool2324.toFixed(1), o.censored2324].join(","))].join("\n"));
  for (const fy of YEARS) {
    const f = fits.filter((x) => x.fy === fy), unc = f.filter((x) => !x.censored).map((x) => x.pool).sort((a, b) => a - b);
    log(`${fy}: ${f.length} trusts, median pool ${unc.length ? unc[unc.length >> 1].toFixed(0) : "?"} beds, censored at whole hospital ${f.filter((x) => x.censored === "whole hospital").length}, at smallest ${f.filter((x) => x.censored === "smallest").length}`);
  }
  log("wrote data/processed/trust_pools.csv and trust_pools_oos.csv");
  process.exit(0);
}
const rows = csv.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [H[i], isNaN(+v) || v === "" ? v : +v])))
  .filter((r) => YEARS.includes(r.fy) && r.ga_available > 100 && r.emergency_admissions > 5000 && r.occupancy > 0.6 && hash(r.org) % NSHARD === SHARD);

const s0 = defaultSettings(base);
function trustParams(t) {
  const p = buildParams(base, { ...s0, beds: t.ga_available, flexibility: "A" });
  const k = t.emergency_admissions / (p.emergPerYear + p.fluPerYear);
  return { ...p, emergPerYear: p.emergPerYear * k, fluPerYear: p.fluPerYear * k,
    electivePerYear: base.national.electivePerYear * t.emergency_admissions / base.national.emergPerYear };
}
const sim = (p, pool, los) => run({ ...p, poolSize: Math.min(pool, p.beds), losChangePct: los }, REPS);
function fitLos(p, pool, occ) {
  let lo = -60, hi = 120;
  for (let i = 0; i < 9; i++) { const mid = (lo + hi) / 2; if (sim(p, pool, mid).occMidnight < Math.min(occ, 0.995)) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function fitTrust(t) {
  const p = trustParams(t), w = t.waits12 / t.emergency_admissions;
  let los = fitLos(p, base.calibration.A.poolSize, t.occupancy);
  const at = (pool) => sim(p, pool, los).wait12;
  let censored = "";
  const wMax = at(p.beds), wMin = at(MIN_POOL);
  let pool;
  if (w <= wMax) { pool = p.beds; censored = "whole hospital"; }
  else if (w >= wMin) { pool = MIN_POOL; censored = "smallest"; }
  else {
    let a = Math.log(MIN_POOL), b = Math.log(p.beds);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 9; i++) { const m = (a + b) / 2; if (at(Math.exp(m)) > w) a = m; else b = m; }
      pool = Math.exp((a + b) / 2);
      if (pass === 0) { los = fitLos(p, pool, t.occupancy); a = Math.log(MIN_POOL); b = Math.log(p.beds); }
    }
  }
  return { org: t.org, fy: t.fy, beds: t.ga_available, admissions: t.emergency_admissions, occupancy: t.occupancy, wait12: w,
    longStay: t.long_stay, pool, poolShare: pool / p.beds, censored, losChangePct: los };
}

const fits = [];
for (const fy of YEARS) {
  for (const t of rows.filter((r) => r.fy === fy)) fits.push(fitTrust(t));
  log(`shard ${SHARD}: ${fy} done`);
}

// out of sample: 2023/24 pool (or the national pool) with 2025/26 conditions
const by = (fy) => Object.fromEntries(fits.filter((x) => x.fy === fy).map((x) => [x.org, x]));
const prev = by("2023/24"), last = by("2025/26"), first = by("2022/23");
const oos = [];
for (const [org, t] of Object.entries(last)) {
  const src = prev[org];
  if (!src) continue;
  const r = rows.find((x) => x.org === org && x.fy === "2025/26"), p = trustParams(r);
  const los = fitLos(p, src.pool, r.occupancy), losN = fitLos(p, base.calibration.A.poolSize, r.occupancy);
  oos.push({ org, observed: t.wait12, ownPool: sim(p, src.pool, los).wait12, nationalPool: sim(p, base.calibration.A.poolSize, losN).wait12,
    pool2324: src.pool, censored2324: src.censored });
}
fs.writeFileSync(path.join(ROOT, `data/processed/.trust_pools_part${SHARD}.json`), JSON.stringify({ fits, oos }));
log(`shard ${SHARD} done`);
