// Pool size for the "more flexible" (pre-pandemic) system, fitted to 12-hour waits counted from arrival.
//
// The official 12-hour measure starts at the decision to admit. Before the pandemic it was held down by when
// decisions were recorded (scripts/clock_test.py): counted from arrival, 12-hour waits in type 1 A&E were 2.0%
// of attendances in 2018/19 and 10.6% in 2024/25, a ~5-fold rise; counted from the decision to admit, ~160-fold.
// The model's waits run from the decision to admit to a bed. To express pre-pandemic flexibility in those units,
// assume bed waits fell by the same proportion as 12-hour waits from arrival:
//     target(2018/19) = 12-hour share from decision to admit (2024/25) x arrival share (2018/19) / arrival share (2024/25)
// Then find the pool size that reproduces that target with 2018/19's own beds, emergency admissions, population and
// occupancy (length of stay re-fitted to its KH03 occupancy), everything else as in today's calibration.
// A second year pair (2022/23 and 2017/18) gives a sensitivity range.
//
// Used by scripts/calibrate.mjs; on its own (node scripts/flexible_pool.mjs) it prints the fit without writing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../web/js/model.js";
import { buildParams, defaultSettings } from "../web/js/demand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function flexibleTarget(clock, pair = ["2018/19", "2024/25"]) {
  const y = Object.fromEntries(clock.years.map((r) => [r.fy, r]));
  const [pre, post] = pair.map((k) => y[k]);
  if (!pre || !post) return null;
  return { pre: pre.fy, post: post.fy, ratio: pre.arrival_share / post.arrival_share, dtaPost: post.dta_share,
    target: post.dta_share * pre.arrival_share / post.arrival_share };
}

export function fitFlexiblePool(base, { log = console.log, fy = "2018/19", target, reps = 64 } = {}) {
  const bt = base.backtests.find((b) => b.fy === fy);
  const s0 = { ...defaultSettings(base), beds: bt.beds, popYear: parseInt(fy.slice(0, 4), 10), otherGrowthPct: 0 };
  const p0 = buildParams(base, s0);
  s0.otherGrowthPct = 100 * (bt.emergency_admissions / (p0.emergPerYear + p0.fluPerYear) - 1);
  const POOL_A = base.calibration.A.poolSize;
  const sim = (s, pool, r) => run({ ...buildParams(base, { ...s, flexibility: "A" }), poolSize: pool }, Math.max(4, Math.round(r * POOL_A / pool)));
  const fitOcc = (s, pool) => {
    let lo = -45, hi = 40;
    for (let k = 0; k < 11; k++) {
      const mid = (lo + hi) / 2;
      if (sim({ ...s, losChangePct: mid }, pool, reps).occMidnight < bt.occupancy) lo = mid; else hi = mid;
    }
    return { ...s, losChangePct: (lo + hi) / 2 };
  };
  let a = Math.log(POOL_A), b = Math.log(1000), last = null;
  for (let k = 0; k < 9; k++) {
    const pool = Math.exp((a + b) / 2);
    const s = fitOcc(s0, pool);
    last = { pool, r: sim(s, pool, reps), s };
    if (last.r.wait12 > target) a = Math.log(pool); else b = Math.log(pool);
    log(`   ${fy} pool ${pool.toFixed(0)}: occ ${(100 * last.r.occMidnight).toFixed(1)}% (obs ${(100 * bt.occupancy).toFixed(1)}%), >12h ${(100 * last.r.wait12).toFixed(2)}% (target ${(100 * target).toFixed(2)}%)`);
  }
  const pool = Math.exp((a + b) / 2);
  const s = fitOcc(s0, pool);
  const r = sim(s, pool, reps * 2);
  return { fy, pool, target, occupancy: r.occMidnight, wait12: r.wait12, wait4: r.wait4 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/baseline.json"), "utf8"));
  const clock = JSON.parse(fs.readFileSync(path.join(ROOT, "web/data/clock_test.json"), "utf8"));
  for (const pair of [["2018/19", "2024/25"], ["2017/18", "2022/23"]]) {
    const t = flexibleTarget(clock, pair);
    console.log(`target from ${pair.join(" and ")}: ${(100 * t.target).toFixed(2)}%`);
    const f = fitFlexiblePool(base, { target: t.target, fy: pair[0] === "2017/18" ? "2018/19" : pair[0] });
    console.log(`-> pool ${f.pool.toFixed(0)} beds; >12h ${(100 * f.wait12).toFixed(2)}%, >4h ${(100 * f.wait4).toFixed(1)}%`);
  }
}
