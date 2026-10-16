// Blog page: every number and chart is drawn from data files built by scripts/blog_data.py (observed)
// and scripts/blog_scenarios.mjs (simulated), so the text always matches the data.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const int = (x) => Math.round(x).toLocaleString("en-GB");
const pct = (x, d = 1) => (100 * x).toFixed(d) + "%";
const k = (x) => (x / 1000).toFixed(0) + "k";
const signed = (x, f) => (x > 0 ? "+" : x < 0 ? "−" : "") + f(Math.abs(x));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function table(head, rows, num = []) {
  return `<div class="table-scroll"><table><thead><tr>${head.map((h, i) => `<th class="${num.includes(i) ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c, i) => `<td class="${num.includes(i) ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function fill(key, html) { document.querySelectorAll(`[data-k="${key}"]`).forEach((e) => { e.innerHTML = html; }); }
function legend(id, items) {
  $(id).innerHTML = items.map(([label, color, dash]) => `<span style="--c:${color}"${dash ? ' class="dash"' : ""}>${esc(label)}</span>`).join("");
}
function stat(label, value, sub) {
  return `<div class="kpi"><div class="name">${esc(label)}</div><div class="val">${value}</div><div class="sub">${sub}</div></div>`;
}
// split a long category label into lines for horizontal bar charts
function wrap(s, n = 26) {
  const out = []; let line = "";
  for (const w of s.split(" ")) { if ((line + " " + w).trim().length > n) { out.push(line); line = w; } else line = (line + " " + w).trim(); }
  if (line) out.push(line);
  return out;
}
// vertical reference line at a given x value
const vline = (x, label) => ({
  id: "vline",
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: a, scales } = chart;
    const px = scales.x.getPixelForValue(x);
    if (px < a.left || px > a.right) return;
    ctx.save();
    ctx.strokeStyle = css("--text-3"); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = css("--text-2"); ctx.font = "12px " + Chart.defaults.font.family;
    ctx.textAlign = px > (a.left + a.right) / 2 ? "right" : "left";
    ctx.fillText(label, px + (ctx.textAlign === "right" ? -6 : 6), a.top + 12);
    ctx.restore();
  },
});
const lineOpts = (yTitle, extra = {}) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  interaction: { mode: "index", intersect: false },
  plugins: { legend: { display: false } },
  scales: { x: { grid: { display: false } }, y: { title: { display: true, text: yTitle } } },
  ...extra,
});

async function main() {
  const [obs, sc, base] = await Promise.all(["data/blog_observed.json", "data/blog_scenarios.json", "data/baseline.json"]
    .map((u) => fetch(u).then((r) => r.json())));
  const [fc, tf] = await Promise.all(["data/flexibility_check.json", "data/trust_flexibility.json"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  if (fc) {
    const y = fc.years.find((x) => x.fy === "2018/19") || fc.years[0];
    const fav = (y.favourable || []).find((g) => /all/.test(g.label));
    if (fav) fill("flexFav", pct(fav.wait12, 1));
    fill("flexObs", pct(y.wait12Observed, 2));
    const pn = y.poolNeeded.map((n) => n.pool / fc.poolToday);
    const lo = Math.round(Math.min(...pn)), hi = Math.round(Math.max(...pn));
    fill("flexPoolX", lo === hi ? `about ${lo}` : `${lo}–${hi}`);
  }
  const lsT = tf?.models?.["all together"]?.terms?.["post:long_stay_z"];
  if (lsT) fill("flexLS", `+${lsT.pct.toFixed(0)}% (95% CI +${lsT.lo.toFixed(0)}% to +${lsT.hi.toFixed(0)}%)`);
  const fmtEff = (t) => `${t.pct >= 0 ? "+" : "−"}${Math.abs(t.pct).toFixed(0)}%, p = ${t.p.toFixed(2)}`;
  const mName = (pre) => tf && Object.keys(tf.models).find((k) => k.startsWith(pre));
  const plT = tf?.models?.[mName("placebo")]?.terms?.["post:long_stay_z"], nbT = tf?.models?.[mName("robustness: without")]?.terms?.["post:long_stay_z"];
  if (plT) fill("lsPlacebo", fmtEff(plT));
  if (nbT) fill("lsNoBig", fmtEff(nbT));
  Chart.defaults.color = css("--text-2");
  Chart.defaults.borderColor = css("--grid");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  const BLUE = css("--series-scn"), ORANGE = css("--series-b"), GREY = css("--series-base");
  const BY = sc.baseYear;
  fill("baseYear", BY);
  $("genDate").textContent = new Date(sc.generated).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  // ---------------------------------------------------------------- 1. beds
  const B = obs.beds, b0 = B[0], bN = B.at(-1);
  const b2010 = B.find((x) => x.fy === "2010/11");
  fill("beds1987", int(b0.beds)); fill("bedsNow", int(bN.beds));
  fill("pop75_1987", (b0.pop75 / 1e6).toFixed(1) + " million"); fill("pop75Now", (bN.pop75 / 1e6).toFixed(1) + " million");
  fill("occ2010", pct(b2010.occupancy)); fill("occNow", pct(bN.occupancy));
  const bd = base.ageBands.map((a) => a.emergAdm * a.losMult), bdAll = bd.reduce((s, x) => s + x, 0);
  const bd75 = base.ageBands.reduce((s, a, i) => s + (["75-84", "85+"].includes(a.band) ? bd[i] : 0), 0);
  fill("share75bd", pct(bd75 / bdAll, 0));
  const last12 = obs.monthly.slice(-12), w12yr = last12.reduce((s, m) => s + m.w12, 0), adm12 = last12.reduce((s, m) => s + m.adm, 0);
  fill("wait12Now", pct(w12yr / adm12, 0) + ` (${int(w12yr)} people in the 12 months to ${MON[+last12.at(-1).month.slice(5) - 1]} ${last12.at(-1).month.slice(0, 4)})`);
  $("heroStats").innerHTML =
    stat("G&A beds", int(bN.beds), `${BY}; ${int(b0.beds)} in ${b0.fy}`) +
    stat("Beds per 1,000 people aged 75+", bN.per75.toFixed(1), `${b0.per75.toFixed(1)} in ${b0.fy}`) +
    stat("Average occupancy", pct(bN.occupancy), `${BY}; ${pct(b2010.occupancy)} in 2010/11`) +
    stat("Waits over 12 hours for a bed", int(w12yr), `last 12 months; ${int(obs.monthly.filter((m) => m.month >= "2018-04" && m.month < "2019-04").reduce((s, m) => s + m.w12, 0))} in 2018/19`);

  const dashBridged = { borderDash: (c) => (B[c.p1DataIndex]?.bridged ? [5, 4] : undefined) };
  new Chart($("cBeds"), { type: "line", data: { labels: B.map((x) => x.fy), datasets: [
    { label: "G&A beds", data: B.map((x) => x.beds), borderColor: BLUE, borderWidth: 2, pointRadius: 0, segment: dashBridged }] },
    options: lineOpts("Beds", { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${int(c.parsed.y)} beds${B[c.dataIndex].bridged ? " (converted)" : ""}` } } } }) });
  new Chart($("cBeds75"), { type: "line", data: { labels: B.map((x) => x.fy), datasets: [
    { label: "Beds per 1,000 aged 75+", data: B.map((x) => x.per75), borderColor: BLUE, borderWidth: 2, pointRadius: 0, segment: dashBridged }] },
    options: lineOpts("Beds per 1,000 aged 75+", { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y.toFixed(1)} per 1,000 aged 75+` } } } }) });
  const bedRows = B.map((x) => [x.fy, int(x.beds), x.occupancy ? pct(x.occupancy) : "", (x.population / 1e6).toFixed(2) + "m", (x.pop75 / 1e6).toFixed(2) + "m", x.perThousand.toFixed(2), x.per75.toFixed(1)]);
  $("tBeds").innerHTML = table(["Year", "G&A beds", "Occupancy", "Population", "Aged 75+", "Beds per 1,000", "Per 1,000 aged 75+"], bedRows, [1, 2, 3, 4, 5, 6]);
  $("tBeds75").innerHTML = $("tBeds").innerHTML;

  // ---------------------------------------------------------------- 2. waits and the break
  const M = obs.monthly;
  new Chart($("cWaits"), { type: "line", data: { labels: M.map((m) => m.month), datasets: [
    { label: "Waits over 12 hours", data: M.map((m) => m.w12), borderColor: BLUE, borderWidth: 2, pointRadius: 0 }] },
    options: lineOpts("Patients per month", {
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => { const m = M[c[0].dataIndex].month; return `${MON[+m.slice(5) - 1]} ${m.slice(0, 4)}`; },
        label: (c) => `${int(c.parsed.y)} patients (${pct(M[c.dataIndex].share)} of emergency admissions)` } } },
      scales: { x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, callback: (v, i) => (M[i].month.endsWith("-04") && +M[i].month.slice(0, 4) % 2 === 0 ? M[i].month.slice(0, 4) : null) } },
        y: { title: { display: true, text: "Patients per month" } } } }) });
  $("tWaits").innerHTML = table(["Month", "Waits over 12 hours", "Emergency admissions", "Share"], M.slice().reverse().map((m) => [m.month, int(m.w12), int(m.adm), pct(m.share, 2)]), [1, 2, 3]);

  const Q = obs.quarters;
  const era = (q) => (q.fy < "2020/21" ? 0 : q.fy < "2022/23" ? 1 : 2);
  const ERAS = [["2010/11 to 2019/20", GREY], ["2020/21 to 2021/22 (pandemic)", ORANGE], ["2022/23 onwards", BLUE]];
  legend("lBreak", ERAS.map(([l, c]) => [l, c]));
  new Chart($("cBreak"), { type: "scatter", data: { datasets: ERAS.map(([label, color], e) => ({
    label, data: Q.filter((q) => era(q) === e).map((q) => ({ x: 100 * q.occupancy, y: 100 * q.wait12, q })),
    backgroundColor: color, borderColor: css("--surface"), borderWidth: 1.5, pointRadius: 5, pointHoverRadius: 7 })) },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw.q.fy} ${c.raw.q.q}: occupancy ${c.parsed.x.toFixed(1)}%, ${c.parsed.y.toFixed(2)}% waited >12h` } } },
      scales: { x: { min: 80, title: { display: true, text: "G&A occupancy (%)" } }, y: { title: { display: true, text: "Waiting over 12 hours (%)" }, min: 0 } } } });
  const off = Q.filter((q) => 100 * q.occupancy < 80);
  if (off.length) $("capBreak").textContent += ` Not shown: ${off.map((q) => `${q.fy} ${q.q}`).join(" and ")}, when occupancy fell below 80% during the pandemic.`;
  $("tBreak").innerHTML = table(["Quarter", "Occupancy", "Waiting >12h", "Waiting >4h"], Q.map((q) => [`${q.fy} ${q.q}`, pct(q.occupancy), pct(q.wait12, 2), pct(q.wait4)]), [1, 2, 3]);

  // ---------------------------------------------------------------- long-stay clue (trust panel)
  const LF = tf?.long_stay_fifths || [];
  if (LF.length) {
    const lo = LF[0], hiF = LF.at(-1);
    fill("lsTrusts", int(LF.reduce((t, f) => t + f.trusts, 0)));
    fill("lsLow", pct(lo.wait12_after, 1)); fill("lsHigh", pct(hiF.wait12_after, 1));
    const occs = LF.map((f) => f.occupancy_after);
    fill("lsOcc", `${pct(Math.min(...occs), 1)} to ${pct(Math.max(...occs), 1)} across the five groups`);
    const names = LF.map((f, i) => `${i === 0 ? "Fewest long-stay" : i === LF.length - 1 ? "Most long-stay" : `Fifth ${f.fifth}`} (${pct(f.long_stay, 0)} of beds)`);
    const labels = LF.map((f) => pct(f.long_stay, 0));
    legend("lLongStay", [["Before the pandemic", GREY], ["After the pandemic", BLUE]]);
    new Chart($("cLongStay"), { type: "bar", data: { labels, datasets: [
      { label: "Before the pandemic", data: LF.map((f) => 100 * f.wait12_before), backgroundColor: GREY, borderRadius: 4, borderSkipped: false, barPercentage: 0.85, categoryPercentage: 0.7 },
      { label: "After the pandemic", data: LF.map((f) => 100 * f.wait12_after), backgroundColor: BLUE, borderRadius: 4, borderSkipped: false, barPercentage: 0.85, categoryPercentage: 0.7 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => names[c[0].dataIndex],
          label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}% waited over 12 hours (occupancy ${pct(LF[c.dataIndex][c.datasetIndex ? "occupancy_after" : "occupancy_before"], 1)})` } } },
        scales: { x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0 },
          title: { display: true, text: "Share of beds held by long-stay patients (one bar pair per fifth of trusts)" } },
          y: { min: 0, title: { display: true, text: "Waiting over 12 hours (%)" } } } } });
    $("tLongStay").innerHTML = table(["Group", "Trusts", "Long-stay share", "Occupancy before", "Occupancy after", "12h waits before", "12h waits after"],
      LF.map((f, i) => [names[i], f.trusts, pct(f.long_stay), pct(f.occupancy_before), pct(f.occupancy_after), pct(f.wait12_before, 2), pct(f.wait12_after, 1)]), [1, 2, 3, 4, 5, 6]);
  }

  // ---------------------------------------------------------------- 3. bed sweep
  const S = sc.sweep;
  legend("lSweep", [["Today's system", BLUE], ["More flexible system", ORANGE]]);
  legend("lSweep2", [["Today's system", BLUE], ["More flexible system", ORANGE]]);
  const sweepOpts = (yTitle, fmt) => ({ responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => `${int(c[0].parsed.x)} beds`, label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y)}` } } },
    scales: { x: { type: "linear", title: { display: true, text: "G&A beds" }, ticks: { callback: (v) => k(v) } }, y: { title: { display: true, text: yTitle }, min: 0 } } });
  const ds = (sys, f, color, label) => ({ label, data: S.map((s) => ({ x: s.beds, y: f(s[sys]) })), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 3 });
  new Chart($("cSweepOcc"), { type: "line", data: { datasets: [ds("A", (r) => 100 * r.occupancy, BLUE, "Today's system"), ds("B", (r) => 100 * r.occupancy, ORANGE, "More flexible system")] },
    options: { ...sweepOpts("Occupancy (%)", (y) => y.toFixed(1) + "%"), scales: { ...sweepOpts("").scales, y: { title: { display: true, text: "Occupancy (%)" }, min: 60, max: 100 } } },
    plugins: [vline(sc.baseBeds, "Today")] });
  new Chart($("cSweepWait"), { type: "line", data: { datasets: [ds("A", (r) => r.wait12PerYear / 1000, BLUE, "Today's system"), ds("B", (r) => r.wait12PerYear / 1000, ORANGE, "More flexible system")] },
    options: sweepOpts("Thousands a year", (y) => y.toFixed(0) + "k a year"), plugins: [vline(sc.baseBeds, "Today")] });
  $("tSweep").innerHTML = table(["Beds", "Occupancy (today's system)", "Occupancy (flexible)", ">12h waits a year (today's)", ">12h waits a year (flexible)", "Planned admissions lost"],
    S.map((s) => [int(s.beds), pct(s.A.occupancy), pct(s.B.occupancy), int(s.A.wait12PerYear), int(s.B.wait12PerYear), pct(s.A.elecLost)]), [0, 1, 2, 3, 4, 5]);
  const interp = (beds, f) => { for (let i = 1; i < S.length; i++) if (S[i].beds >= beds) { const a = S[i - 1], b = S[i], w = (beds - a.beds) / (b.beds - a.beds); return f(a) + w * (f(b) - f(a)); } return f(S.at(-1)); };
  const bedsAt = (occ) => { for (let i = 1; i < S.length; i++) if (S[i].A.occupancy <= occ) { const a = S[i - 1], b = S[i], w = (a.A.occupancy - occ) / (a.A.occupancy - b.A.occupancy); return a.beds + w * (b.beds - a.beds); } return NaN; };
  const h2010 = sc.history.find((h) => h.year === "2010/11"), h2005 = sc.history.find((h) => h.year === "2005/06");
  const A0 = sc.baseline.A;
  $("sweepText").innerHTML = `With ${BY} demand, the simulator puts today's ${int(sc.baseBeds)} beds at ${pct(A0.occupancy)} occupancy,
    with ${int(A0.wait12PerYear)} emergency patients a year waiting over 12 hours for a bed. The published figure for ${BY} is ${int(M.filter((m) => m.month >= "2025-04" && m.month < "2026-04").reduce((s, m) => s + m.w12, 0))}, so the model somewhat understates long waits.
    Waits do not rise in a straight line. Each bed removed costs more than the last, because a nearly full hospital has no slack to absorb a busy day.
    Going back to the ${int(h2010.beds)} beds of 2010/11 would bring occupancy to about ${pct(interp(h2010.beds, (s) => s.A.occupancy))} and cut 12-hour waits
    to about ${int(interp(h2010.beds, (s) => s.A.wait12PerYear))} a year. Getting to the 85% often quoted as safe would take about
    ${int(Math.round(bedsAt(0.85) / 100) * 100)} beds, roughly ${int(Math.round((bedsAt(0.85) - sc.baseBeds) / 100) * 100)} more than today.
    For comparison, 2005/06's beds per head would mean ${int(h2005.perHeadBeds)} beds today.`;
  const cc = base.corridorCare, nc = sc.levers.find((l) => l.id === "noCorridor");
  const MONTHL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ccEnd = cc ? `${MONTHL[+cc.end.slice(5, 7) - 1]} ${cc.end.slice(0, 4)}` : "";
  $("corridorBox").innerHTML = cc ? `<strong>Corridor care.</strong> Since May 2026 NHS England has counted patients cared for in corridors for
    45 minutes or more. From May to ${ccEnd} an average of ${int(cc.wardMean)} patients were on a ward but outside a bed space at 08:00. Over each day,
    ${int(cc.edMean)} patients received corridor care in emergency departments. The simulator gives wards corridor spaces equal to
    ${base.calibration.A.corridorPct}% of beds, used only when every proper bed is full, and fits that number to the ward count. Corridor care
    hides some of the shortage: a patient on a trolley on a ward is no longer counted as waiting in A&amp;E.
    ${nc ? `Ending ward corridor care with no other change would raise 12-hour waits from ${int(A0.wait12PerYear)} to ${int(nc.A.wait12PerYear)} a year in the model.` : ""}
    The <a href="validation.html#corridor">validation page</a> compares the model with both counts.` : "";

  // ---------------------------------------------------------------- 4. levers
  const L = sc.levers.filter((l) => l.group !== "Context");
  const dBeds = (l) => l.A.occupiedBeds - A0.occupiedBeds;
  const dWait = (l) => l.A.wait12PerYear - A0.wait12PerYear;
  const barOpts = (xTitle, fmt) => ({ indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => c[0].label.replaceAll(",", " "), label: (c) => fmt(c.parsed.x) } } },
    scales: { x: { title: { display: true, text: xTitle }, ticks: { maxRotation: 0, maxTicksLimit: 6 }, grid: { color: (c) => (c.tick.value === 0 ? css("--text-3") : css("--grid")) } }, y: { grid: { display: false }, ticks: { autoSkip: false } } } });
  const Lb = L.filter((l) => l.group !== "Capacity").sort((a, b) => dBeds(a) - dBeds(b));
  new Chart($("cLevBeds"), { type: "bar", data: { labels: Lb.map((l) => wrap(l.label)), datasets: [{ data: Lb.map(dBeds), backgroundColor: BLUE, borderRadius: 4, borderSkipped: false, barPercentage: 0.8 }] },
    options: barOpts("Change in occupied beds", (x) => signed(x, int) + " beds") });
  const Lw = L.slice().sort((a, b) => dWait(a) - dWait(b));
  new Chart($("cLevWait"), { type: "bar", data: { labels: Lw.map((l) => wrap(l.label)), datasets: [{ data: Lw.map((l) => dWait(l) / 1000), backgroundColor: Lw.map((l) => (l.group === "Capacity" ? GREY : BLUE)), borderRadius: 4, borderSkipped: false, barPercentage: 0.8 }] },
    options: barOpts("Change, thousands a year", (x) => signed(x, (v) => v.toFixed(0) + "k") + " waits over 12 hours a year") });
  $("tLevers").innerHTML = table(["Policy", "Type", "Occupancy", "Change in occupied beds", ">12h waits a year (today's system)", ">12h waits a year (flexible system)", "Planned admissions lost"],
    [["Today", "", pct(A0.occupancy), "", int(A0.wait12PerYear), int(sc.baseline.B.wait12PerYear), pct(A0.elecLost)],
      ...sc.levers.concat(sc.packages.map((p) => ({ ...p, group: "Package" }))).map((l) => [esc(l.label), l.group, pct(l.A.occupancy), signed(l.A.occupiedBeds - A0.occupiedBeds, int), int(l.A.wait12PerYear), int(l.B.wait12PerYear), pct(l.A.elecLost)])],
    [2, 3, 4, 5, 6]);
  const by = (id) => sc.levers.find((l) => l.id === id);
  const top = Lb.slice(0, 3);
  const ph = sc.packages.find((p) => p.id === "publicHealth"), fl = sc.packages.find((p) => p.id === "flow");
  $("leverText").innerHTML = `The biggest single effects come from ${top.map((l) => `${esc(l.label.toLowerCase())} (${signed(dBeds(l), int)} beds)`).join(", ")}.
    The deprivation result is an upper bound. It assumes every area's admission rate moves halfway to that of the least deprived fifth.
    Part of the measured gap reflects factors other than deprivation itself.
    Public-health measures act slowly in reality, because people who quit smoking or lose weight do not stop needing hospital care overnight.
    The figures show the eventual effect once the change has worked through. Put together, the public-health package frees ${int(-(ph.A.occupiedBeds - A0.occupiedBeds))} beds
    and the hospital-flow package frees ${int(-(fl.A.occupiedBeds - A0.occupiedBeds))}. For comparison, 5,000 more beds cut 12-hour waits by
    ${int(-dWait(by("beds5k")))} a year, against ${int(-(ph.A.wait12PerYear - A0.wait12PerYear))} for the public-health package and
    ${int(-(fl.A.wait12PerYear - A0.wait12PerYear))} for the flow package. Patients ready to leave but still in hospital are the most direct target: halving
    their delays frees ${int(-dBeds(by("delays")))} beds.`;
  const N = obs.nctr;
  new Chart($("cNctr"), { type: "line", data: { labels: N.map((x) => x.date), datasets: [{ label: "Patients ready to leave", data: N.map((x) => x.nctr), borderColor: BLUE, borderWidth: 2, pointRadius: 0 }] },
    options: lineOpts("Patients", { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${int(c.parsed.y)} patients (7-day average)` } } },
      scales: { x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, callback: (v, i) => (i > 0 && N[i].date.slice(0, 4) !== N[i - 1].date.slice(0, 4) ? N[i].date.slice(0, 4) : null) } }, y: { title: { display: true, text: "Patients" }, min: 0 } } }) });
  $("tNctr").innerHTML = table(["Week ending", "Patients ready to leave (7-day average)"], N.slice().reverse().map((x) => [x.date, int(x.nctr)]), [1]);

  // ---------------------------------------------------------------- readmissions
  const RM = base.readmissions, rl = by("readmissions");
  if (RM && rl) {
    const H = RM.history, h0 = H[0], hN = H.at(-1);
    const extra = Math.round((hN.rate - h0.rate) * RM.discharges);
    $("readmText1").innerHTML = `About one emergency admission in seven is a patient who left hospital in the previous 30 days. In
      ${esc(RM.year)} there were <b>${int(RM.count)}</b> emergency readmissions within 30 days, out of ${(RM.discharges / 1e6).toFixed(2)} million
      eligible discharges: <b>${pct(hN.rate)}</b>. In ${esc(h0.year)} the rate was ${pct(h0.rate)}. At today's number of discharges, that rise
      means about ${int(Math.round(extra / 1000) * 1000)} extra emergency admissions a year.`;
    new Chart($("cReadm"), { type: "line", data: { labels: H.map((h) => h.year), datasets: [
      { label: "Readmitted within 30 days", data: H.map((h) => 100 * h.rate), borderColor: BLUE, backgroundColor: BLUE, borderWidth: 2, pointRadius: 4 }] },
      options: lineOpts("Share of discharges (%)", { plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.parsed.y.toFixed(1)}% of eligible discharges` } } },
        scales: { x: { grid: { display: false } }, y: { title: { display: true, text: "Share of discharges (%)" }, min: 10, max: 17 } } }) });
    $("tReadm").innerHTML = table(["Year", "Readmitted within 30 days"], H.map((h) => [h.year, pct(h.rate)]), [1]);
    const dAdm = 1 - rl.demand.readmissions;
    $("readmText2").innerHTML = `Readmissions are not extra patients on top of emergency admissions; they are part of them. Fewer readmissions
      also means fewer discharges, which in turn means fewer readmissions after those. Taking both into account, getting back to the
      ${esc(h0.year)} rate would cut emergency admissions by <b>${pct(dAdm)}</b>. In the simulation that frees <b>${int(-dBeds(rl))}</b> beds,
      takes occupancy from ${pct(A0.occupancy)} to ${pct(rl.A.occupancy)}, and cuts 12-hour waits by about <b>${int(Math.round(-dWait(rl) / 1000) * 1000)}</b> a year.
      That is a similar size to the community response for older people (${int(-dBeds(by("community")))} beds), and smaller than halving
      discharge delays (${int(-dBeds(by("delays")))}). Two caveats. The national rate is not published by age, so the effect is spread evenly
      across ages, although older patients are readmitted more often. And community response and virtual wards also prevent some
      readmissions, so their effects partly overlap; the policy packages above leave readmissions out to avoid double counting.`;
  }

  // ---------------------------------------------------------------- 5. flu
  const seasons = Object.keys(obs.flu).sort();
  const offset = (d, s) => Math.round((new Date(d) - new Date(`${s.slice(0, 4)}-11-01`)) / 864e5);
  const fluColors = [GREY, BLUE];
  legend("lFlu", seasons.map((s, i) => [`Winter ${s}`, fluColors[i % 2]]));
  new Chart($("cFlu"), { type: "line", data: { datasets: seasons.map((s, i) => ({ label: `Winter ${s}`, data: obs.flu[s].map((x) => ({ x: offset(x.date, s), y: x.beds, date: x.date })),
    borderColor: fluColors[i % 2], borderWidth: 2, pointRadius: 0 })) },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => new Date(c[0].raw.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }), label: (c) => `${c.dataset.label}: ${int(c.parsed.y)} beds` } } },
      scales: { x: { type: "linear", min: 0, max: 150, ticks: { stepSize: 30.4, callback: (v) => ["1 Nov", "1 Dec", "1 Jan", "1 Feb", "1 Mar", "1 Apr"][Math.round(v / 30.4)] ?? "" }, grid: { display: false } },
        y: { title: { display: true, text: "Beds occupied by flu patients" }, min: 0 } } } });
  $("tFlu").innerHTML = table(["Date", ...seasons.map((s) => `Flu beds ${s}`)],
    [...Array(Math.max(...seasons.map((s) => obs.flu[s].length))).keys()].map((i) => [obs.flu[seasons.at(-1)][i]?.date?.slice(5) ?? obs.flu[seasons[0]][i]?.date?.slice(5) ?? "", ...seasons.map((s) => (obs.flu[s][i] ? int(obs.flu[s][i].beds) : ""))]), [1, 2]);
  const peak = (s) => Math.max(...obs.flu[s].map((x) => x.beds));
  fill("flu2425", int(peak("2024/25"))); fill("flu2526", int(peak("2025/26")));
  const fluL = by("flu");
  $("fluText").innerHTML = `Vaccination is the main policy lever. ${base.flu.uptake65}% of people aged 65+ were vaccinated in ${esc(base.flu.uptakeSeason || "2024/25")}. A UK test-negative study estimated the vaccine
    prevented ${pct(base.flu.ve, 0)} of flu hospitalisations in that age group. Raising uptake to 85% would prevent about ${pct(1 - fluL.demand.fluVaccine, 0)} of flu admissions in the model.
    That is ${int(A0.fluPeak - fluL.A.fluPeak)} fewer flu patients in beds at the peak, and ${int(A0.wait12PerYear - fluL.A.wait12PerYear)} fewer 12-hour waits over the year.
    The benefit is concentrated in the worst weeks of winter, which is when beds are scarcest.`;

  // ---------------------------------------------------------------- 6. trusts
  const T = obs.trusts;
  fill("nTrusts", T.length);
  new Chart($("cTrusts"), { type: "scatter", data: { datasets: [{ label: "Acute trusts", data: T.map((t) => ({ x: 100 * t.occupancy, y: 100 * t.wait12, t })), backgroundColor: BLUE, borderColor: css("--surface"), borderWidth: 1.5, pointRadius: 5, pointHoverRadius: 7 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw.t.name}: ${c.parsed.x.toFixed(1)}% occupied, ${c.parsed.y.toFixed(1)}% waited >12h (${int(c.raw.t.beds)} beds)` } } },
      scales: { x: { title: { display: true, text: "Occupancy at 08:00 (%)" } }, y: { title: { display: true, text: "Waiting over 12 hours (%)" }, min: 0 } } } });
  $("tTrusts").innerHTML = table(["Trust", "Beds", "Occupancy", "Waiting >12h"], T.slice().sort((a, b) => b.wait12 - a.wait12).map((t) => [esc(t.name), int(t.beds), pct(t.occupancy), pct(t.wait12)]), [1, 2, 3]);

  // ---------------------------------------------------------------- 7. future
  const F = sc.bedsNeeded2035, p35 = by("pop2035"), both = sc.packages.find((p) => p.id === "both2035");
  $("futureText").innerHTML = `England's population is projected to keep growing and ageing. The number of people aged 85 and over grows fastest.
    If nothing else changed, the population of 2035 alone would push occupancy to ${pct(p35.A.occupancy)} and 12-hour waits to about ${int(p35.A.wait12PerYear)} a year in the model.
    Keeping occupancy at today's ${pct(F.target)} would need about ${int(F.noChange)} beds by 2035. With both the public-health and the hospital-flow packages
    in place it would need about ${int(F.withPackages)}, and the packages alone would leave occupancy at ${pct(both.A.occupancy)} with today's beds.`;
  $("futureStats").innerHTML =
    stat("Beds for 85% occupancy today", int(F.at85), `${signed(F.at85 - sc.baseBeds, int)} on ${BY}`) +
    stat("Beds to stand still by 2035", int(F.noChange), `${signed(F.noChange - sc.baseBeds, int)}, occupancy held at ${pct(F.target)}`) +
    stat("…with both policy packages", int(F.withPackages), `${signed(F.withPackages - sc.baseBeds, int)} on ${BY}`) +
    stat("Beds for 85% occupancy in 2035", int(F.at85in2035), `${signed(F.at85in2035 - sc.baseBeds, int)} on ${BY}`);
}

main().catch((e) => { console.error(e); document.querySelector("article").insertAdjacentHTML("afterbegin", `<p class="callout warn">Could not load data: ${esc(e.message)}</p>`); });
