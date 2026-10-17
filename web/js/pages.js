// Renders the Data & sources and Validation pages from data/baseline.json,
// so the documentation always shows exactly the numbers the model uses.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (x, d = 0) => typeof x === "number" ? x.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }) : esc(x);
const pct = (x, d = 1) => typeof x === "number" ? (100 * x).toFixed(d) + "%" : esc(x);
const link = (url, text) => url ? `<a href="${esc(url)}">${esc(text || "source")}</a>` : "";

function table(head, rows, numCols = []) {
  return `<div class="table-scroll"><table><thead><tr>${head.map((h, i) => `<th class="${numCols.includes(i) ? "num" : ""}">${h}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numCols.includes(i) ? "num" : ""}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function fmtVal(v, unit) {
  if (typeof v !== "number") return esc(v);
  if (unit === "share") return pct(v);
  return num(v, Math.abs(v) < 10 ? 2 : 0);
}

async function main() {
  const base = await (await fetch("data/baseline.json")).json();
  BASE0 = base;
  if ($("generated")) $("generated").textContent = base.generated || "";
  if ($("inputs")) {
    $("inputs").innerHTML = table(
      ["Input", "Value", "Period", "Source", "Notes"],
      (base.inputs || []).map((x) => [esc(x.label), fmtVal(x.value, x.unit) + (x.unit && x.unit !== "share" ? ` <span style="color:var(--text-3)">${esc(x.unit)}</span>` : ""), esc(x.period), link(x.url, x.source), esc(x.note)]),
      [1]);
  }
  if ($("calibration")) {
    const c = base.calibration, t = c.targets || {};
    const r = (label, k, d = 2, f = (x) => x, target = "") => [esc(label), num(f(c.A[k]), d), c.B ? num(f(c.B[k]), d) : "", esc(target)];
    $("calibration").innerHTML = table(
      ["Fitted quantity", "Today's system", "More flexible system", "Fitted to (measured target)"],
      [
        r("Median acute length of stay, overnight emergency patients (days)", "losMedianDays", 2, (x) => x, `G&A occupancy ${pct(t.occupancy)} (KH03)`),
        r("Spread of length of stay (lognormal sigma)", "losSigma", 2, (x) => x, `Occupied beds with stays of 21+ days ${pct(t.long21Share)} (sitrep)`),
        r("Emergency patients discharged the same day (%)", "sameDayFrac", 1, (x) => 100 * x, `Emergency admissions with no night in hospital ${t.emZeroNightShare != null ? pct(t.emZeroNightShare) : ""} (HES zero bed day cases)`),
        r("Overnight emergency patients delayed once fit (%)", "delayProb", 1, (x) => 100 * x, `Discharged after Discharge Ready Date ${pct(t.delayedShare)} (DRD)`),
        r("Weekend-ready patients discharged at the weekend (%)", "weekendDischargePct", 0, (x) => x, `Weekend/weekday discharge-rate ratio ${num(t.weekendRatio, 2)} (discharge sitrep)`),
        r("Planned admissions front-loaded towards Monday", "electiveFrontLoad", 2, (x) => x, "Weekday pattern of winter occupancy (daily sitrep)"),
        r("Flu admissions per year (simulated wave)", "fluAdmissions", 0, (x) => x, `Flu patients in G&A beds at peak ${num(t.fluPeakBeds)} (winter sitrep, 7-day mean)`),
        r("Effective bed pool size (beds)", "poolSize", 0, (x) => x, `Emergency admissions waiting >12h ${pct(t.wait12Share, 2)} (A&E). Flexible system: ${c.flexibleFit ? `2018/19 waits counted from arrival, translated to ${pct(c.flexibleFit.target, 2)} from decision to admit (methods)` : "fitted to 2018/19"}`),
        ...(t.wardCorridor8am != null ? [r("Corridor care spaces on wards (% of beds)", "corridorPct", 1, (x) => x, `Patients in ward corridor care at 08:00: ${num(t.wardCorridor8am)} (NHS England, May-Sep 2026); flexible system uses the same spaces`)] : []),
        r("Mean delay for delayed patients (days, fixed)", "delayMeanDays", 2, (x) => x, `Gamma shape ${num(c.A.delayShape, 2)}, fitted to Discharge Ready Date delay bands`),
      ], [1, 2]);
  }
  if ($("ages")) {
    const years = Object.keys(base.ageBands[0].pop).map(Number).sort((a, b) => a - b);
    const show = years.filter((y) => [2005, 2008, 2010, 2015, base.baseYear, 2030, 2035, 2040].includes(y));
    $("ages").innerHTML = table(
      ["Age band", `Emergency admissions ${base.baseYear}`, "Length-of-stay multiplier", "Delay multiplier", ...show.map((y) => `Population ${y}`)],
      base.ageBands.map((b) => [esc(b.band), num(b.emergAdm), num(b.losMult, 2), num(b.delayMult, 2), ...show.map((y) => num(b.pop[y]))]),
      [1, 2, 3, ...show.map((_, i) => 4 + i)]);
    if ($("agesNote")) $("agesNote").innerHTML = esc(base.ageNote || "");
  }
  if ($("risks")) {
    $("risks").innerHTML = table(
      ["Setting", "Today", "Method", "Key parameter", "Source", "Notes"],
      (base.riskFactors || []).map((r) => [esc(r.label), r.type === "prevalence" ? `${r.current}%` : "no change",
        r.type === "prevalence" ? "Attributable fraction from prevalence" : "Attributable admissions",
        r.type === "prevalence" ? `Relative risk ${num(r.relativeRisk, 2)} (attributable share today ${pct(r.paf)})` : `Share of admissions ${pct(r.share)}`,
        (r.sources || []).map((x) => link(x.url, x.name)).join("<br>"), esc(r.note || "")]));
    if (base.deprivation) $("risks").innerHTML += `<h3>Deprivation</h3>` + table(
      ["Deprivation fifth", "Relative emergency admission rate"],
      base.deprivation.relativeRates.map((x, i) => [i === 0 ? "Most deprived" : i === 4 ? "Least deprived" : String(i + 1), num(x, 2)]), [1]) +
      `<p>${esc(base.deprivation.note || "")} ${(base.deprivation.sources || []).map((x) => link(x.url, x.name)).join(", ")}</p>`;
  }
  if ($("history")) {
    $("history").innerHTML = table(
      ["Year", "G&A beds (as published)", "G&A beds (consistent definition)", "Occupancy", "Population (England)", "Beds per 1,000", "Note"],
      (base.bedHistory || []).map((h) => [esc(h.year), num(h.bedsPublished), num(h.beds), pct(h.occupancy), num(h.population), num(1000 * h.beds / h.population, 2), esc(h.note)]),
      [1, 2, 3, 4, 5]);
  }
  if ($("validation")) await renderValidation();
  if ($("delays") && base.delays) {
    const d = base.delays;
    $("delays").innerHTML = table(["Delay", "Share of delayed patients"], d.bandLabels.map((l, i) => [esc(l), pct(d.bands[i])]), [1]) +
      `<p>Fitted gamma distribution: mean ${num(d.mean, 2)} days, shape ${num(d.shape, 2)} (a long tail: most delays are short, a few last weeks). Published average delay excluding same-day: ${num(d.avgExc0, 1)} days.</p>`;
  }
  if ($("flu") && base.flu) {
    const f = base.flu;
    $("flu").innerHTML = table(["Quantity", "Value", "Source"], [
      ["Flu vaccine uptake, aged 65+", `${f.uptake65}% (${esc(f.uptakeSeason)})`, link(f.uptakeSource?.url, f.uptakeSource?.name)],
      ["Vaccine effectiveness against hospitalisation, aged 65+", `${pct(f.ve)} (95% CI ${pct(f.veRange[0], 0)}–${pct(f.veRange[1], 0)})`, link(f.veSource?.url, f.veSource?.name)],
      ["Share of flu admissions aged 65+", pct(f.share65), "HES 2023/24, ICD-10 J09–J11"],
      ["Flu patients' stay relative to average emergency stay", num(f.losMult, 2), "HES 2023/24"],
      ["Flu wave peak / spread (baseline year)", `day ${f.peakDoy} / SD ${num(f.sdDays, 1)} days`, "Gaussian fitted to daily flu beds (winter sitrep)"],
      ...(f.seasons || []).map((x) => [`Season ${esc(x.winter)}: observed peak`, `${num(x.peak_beds_observed)} beds on ${esc(x.peak_date_observed)}`, `fit R² ${num(x.r2, 2)}`]),
    ]) + `<p>${esc(f.note || "")}</p>`;
  }
  if ($("files")) {
    $("files").innerHTML = table(["Dataset", "Files used", "Publisher page"],
      (base.rawFiles || []).map((f) => [esc(f.dataset), (f.files || []).map(esc).join("<br>"), link(f.page, "page")]));
  }
}
async function renderValidation() {
  const v = await (await fetch("data/validation.json")).json();
  const badge = (p) => p === true ? '<span class="pass">✓ pass</span>' : p === false ? '<span class="fail">✗ fail</span>' : '<span class="na">reported</span>';
  $("validation").innerHTML = table(["", "Check", "Observed", "Today's system", "More flexible system", "Pass criterion", "Comment"],
    v.checks.map((c) => [badge(c.pass), `<strong>${esc(c.id)}</strong> ${esc(c.name)}`, esc(c.observed), esc(c.modelA), esc(c.modelB), esc(c.criterion), esc(c.note || "")]));
  const get = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [X, CK, TP, FC] = await Promise.all(["data/validation_extra.json", "data/clock_test.json", "data/trust_pools.json", "data/flexibility_check.json"].map(get));
  narrative(v, X, CK, TP, FC, BASE0);
  if (!window.Chart) return;
  const css = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  Chart.defaults.color = css("--text-2"); Chart.defaults.borderColor = css("--grid");
  const yrs = v.years.slice().reverse();
  new Chart($("chartYears"), { type: "line", data: { labels: yrs.map((y) => y.fy), datasets: [
    { label: "Observed (KH03)", data: yrs.map((y) => 100 * y.occ_obs), borderColor: css("--text"), borderWidth: 2, pointRadius: 4 },
    { label: "Today's system", data: yrs.map((y) => 100 * y.occ_A), borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 4 },
    { label: "More flexible system", data: yrs.map((y) => 100 * y.occ_B), borderColor: css("--series-b"), borderWidth: 2, borderDash: [5, 3], pointRadius: 4 },
    ...(yrs.some((y) => y.occ_A_hesLos != null) ? [{ label: "Today's system, each year's measured stays (HES)", data: yrs.map((y) => (y.occ_A_hesLos != null ? 100 * y.occ_A_hesLos : null)),
      borderColor: css("--series-scn"), borderWidth: 2, borderDash: [2, 3], pointRadius: 4, pointStyle: "rectRot" }] : []),
  ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } },
    scales: { y: { title: { display: true, text: "Average G&A occupancy (%)" } } } } });
  const eq = arrivalEquivalent(CK, BASE0);
  new Chart($("chartWaits"), { type: "line", data: { labels: yrs.map((y) => y.fy), datasets: [
    { label: "Published, from the decision to admit", data: yrs.map((y) => 100 * y.wait12_obs), borderColor: css("--text"), borderWidth: 2, pointRadius: 4 },
    ...(eq ? [{ label: "Published from arrival, in the same units", data: yrs.map((y) => (eq[y.fy] != null ? 100 * eq[y.fy] : null)), borderColor: css("--text-3"), borderWidth: 2, borderDash: [4, 3], pointRadius: 4, spanGaps: true }] : []),
    { label: "Simulated, today's flexibility", data: yrs.map((y) => 100 * y.wait12_A), borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 4 },
    { label: "Simulated, pre-pandemic flexibility", data: yrs.map((y) => 100 * y.wait12_B), borderColor: css("--series-b"), borderWidth: 2, borderDash: [5, 3], pointRadius: 4 },
  ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}%` } } },
    scales: { y: { title: { display: true, text: "% waiting over 12 hours" }, beginAtZero: true } } } });
  if (CK && $("chartClock")) {
    const Y = CK.years;
    new Chart($("chartClock"), { type: "bar", data: { labels: Y.map((y) => y.fy), datasets: [
      { label: "From arrival", data: Y.map((y) => y.arrival_over12 / 1000), backgroundColor: css("--series-base"), borderRadius: 4, borderSkipped: false },
      { label: "From the decision to admit", data: Y.map((y) => y.dta_over12 / 1000), backgroundColor: css("--series-scn"), borderRadius: 4, borderSkipped: false }] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Math.round(1000 * c.parsed.y).toLocaleString("en-GB")}` } } },
        scales: { x: { grid: { display: false } }, y: { min: 0, title: { display: true, text: "Thousands a year" } } } } });
    $("tClock").innerHTML = CK.html || "";
  }
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  new Chart($("chartWeek"), { type: "line", data: { labels: days, datasets: [
    { label: "Observed (winter, 08:00)", data: v.winter.observed.weekday.map((x) => 100 * x), borderColor: css("--text"), borderWidth: 2, pointRadius: 4 },
    { label: "Today's system", data: v.winter.model.weekday.map((x) => 100 * x), borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 4 },
  ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } },
    scales: { y: { title: { display: true, text: "Occupancy (%)" } } } } });
  if (v.corridor && $("chartCorrMonth")) {
    const c = v.corridor, MONTHN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mlab = c.months.map((m) => `${MONTHN[+m.slice(5) - 1]} ${m.slice(0, 4)}${c.provisionalFrom && m >= c.provisionalFrom.slice(0, 7) ? " (provisional)" : ""}`);
    const bars = (obs, mod) => ({ labels: mlab, datasets: [
      { label: "Observed (NHS England)", data: obs, backgroundColor: css("--series-base"), borderRadius: 4, borderSkipped: false },
      { label: "Today's system", data: mod, backgroundColor: css("--series-scn"), borderRadius: 4, borderSkipped: false }] });
    const bopts = (y) => ({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" },
      tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${Math.round(x.parsed.y).toLocaleString("en-GB")}` } } },
      scales: { x: { grid: { display: false } }, y: { min: 0, title: { display: true, text: y } } } });
    new Chart($("chartCorrMonth"), { type: "bar", data: bars(c.ward.monthlyObs, c.ward.monthlyModel), options: bopts("Patients at 08:00") });
    new Chart($("chartCorrWeek"), { type: "line", data: { labels: days, datasets: [
      { label: "Observed (NHS England)", data: c.ward.weekdayObs, borderColor: css("--text"), borderWidth: 2, pointRadius: 4 },
      { label: "Today's system", data: c.ward.weekdayModel, borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 4 },
    ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } },
      scales: { y: { min: 0, title: { display: true, text: "Patients at 08:00" } } } } });
  } else if ($("corridorCharts")) $("corridorCharts").hidden = true;
  new Chart($("chartTrusts"), { type: "scatter", data: { datasets: [
    { label: "Acute trusts", data: v.trusts.map((t) => ({ x: 100 * t.wait12_model_matched, y: 100 * t.wait12_obs, name: t.name })),
      backgroundColor: css("--series-scn"), pointRadius: 4 },
  ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false },
    tooltip: { callbacks: { label: (c) => `${c.raw.name}: simulated ${c.raw.x.toFixed(1)}%, published ${c.raw.y.toFixed(1)}%` } } },
    scales: { x: { title: { display: true, text: "Simulated: % waiting over 12 hours" } }, y: { title: { display: true, text: "Published: % waiting over 12 hours" } } } } });
  const [fc, tf] = await Promise.all(["data/flexibility_check.json", "data/trust_flexibility.json"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  if (fc && $("flexCheck")) {
    const rows = [];
    for (const y of fc.years) {
      rows.push([`<b>${esc(y.fy)}</b>`, `<b>recorded</b> (from the decision to admit)`, pct(y.occupancyObserved), `<b>${pct(y.wait12Observed, 2)}</b>`]);
      const ft = BASE0?.calibration?.flexibleFit;
      if (ft && ft.fittedYear === y.fy) rows.push(["", `<b>arrival-based equivalent</b> (the target the pre-pandemic setting is fitted to)`, "", `<b>${pct(ft.target, 2)}</b>`]);
      for (const g of y.grid) rows.push(["", `Today's flexibility; delays ${g.delayChangePct === 0 ? "as today" : g.delayChangePct === -100 ? "none" : g.delayChangePct + "%"}; corridor spaces ${g.corridorPct ? g.corridorPct + "% of beds" : "none"}`, pct(g.occupancy), pct(g.wait12, 2)]);
      for (const g of y.favourable || []) rows.push(["", `Today's flexibility; ${esc(g.label)}`, pct(g.occupancy), pct(g.wait12, 2)]);
      for (const n of y.poolNeeded) rows.push(["", `Pool size that reproduces the recorded ${esc(y.fy)} waits (${esc(n.label)})`, "", `<b>${num(n.pool)} beds</b> (today ${num(fc.poolToday)})`]);
    }
    $("flexCheck").innerHTML = table(["Year", "Model run", "Occupancy", "Waiting over 12 hours"], rows, [2, 3]);
  }
  if (tf && $("trustTest")) {
    const NAMES = { "post:log_beds_z": "Trust size (log beds)", "post:long_stay_z": "Long-stay share (patients in hospital 21+ days)", "post:single_rooms_z": "Single rooms per bed (ERIC)", "post:occ_pts": "Change in the occupancy slope (per point)" };
    const rows = [];
    const blocks = [["12-hour waits from the decision to admit", tf.models], ["4-hour waits from arrival (type 1 A&E)", tf.arrival_models || {}]];
    for (const [title, models] of blocks) for (const [name, m] of Object.entries(models)) {
      for (const [k, r] of Object.entries(m.terms)) {
        if (!NAMES[k] || k === "post:occ_pts") continue;
        const sig = r.p < 0.05;
        rows.push([`${esc(name)}<br><span class="na">${title}</span>`, NAMES[k], `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(0)}%`, `${r.lo.toFixed(0)}% to ${r.hi.toFixed(0)}%`, sig ? `<b>${r.p.toFixed(3)}</b>` : `<span class="na">${r.p.toFixed(3)}</span>`, `${m.n_trusts} trusts`]);
      }
    }
    $("trustTest").innerHTML = table(["Model", "Characteristic (after the pandemic ×)", "Change in long waits per SD", "95% CI", "p", "Sample"], rows, [2, 3, 4]) +
      `<p class="cap">${tf.eric ? `Single rooms from ERIC ${esc(tf.eric.year)}. ` : ""}Long-stay share is measured in 2025/26, inside the "after" period, because trust-level length-of-stay data starts in 2020.</p>`;
  }
  if (fc && tf && $("flexSummary")) {
    const y = fc.years.find((x) => x.fy === "2018/19") || fc.years[0];
    const fav = (y.favourable || []).find((g) => /all/.test(g.label));
    const pn = y.poolNeeded.map((n) => n.pool), all = tf.models["all together"]?.terms || {};
    const ls = all["post:long_stay_z"], bd = all["post:log_beds_z"], pl = tf.models[Object.keys(tf.models).find((k) => k.startsWith("placebo"))]?.terms["post:long_stay_z"];
    const ft = BASE0?.calibration?.flexibleFit, g0 = (y.grid || []).find((g) => g.delayChangePct === 0 && g.corridorPct === fc.corridorToday);
    $("flexSummary").innerHTML = `<strong>No.</strong> With ${esc(y.fy)}'s own beds, admissions and occupancy and today's flexibility,
      the model predicts ${g0 ? pct(g0.wait12, 1) : "far more"} of emergency admissions waiting over 12 hours${ft ? `, against the ${pct(ft.target, 1)} that ${esc(y.fy)}'s
      waits counted from arrival imply` : ""}. No single change closes the gap, including removing discharge delays; only every favourable assumption at once
      comes close${fav ? ` (${pct(fav.wait12, 1)})` : ""}. ${ft ? `Matching the arrival-based figure needs pools of about ${num(ft.pool)} beds against ${num(fc.poolToday)} today;
      matching the recorded decision-to-admit figure (${pct(y.wait12Observed, 2)}) without corridor spaces would need ${num(Math.min(...pn))}–${num(Math.max(...pn))}, but that figure was held down by when
      decisions were recorded (see the next test).` : ""} Longer stays work through occupancy, which these runs hold at each year's observed level, so they cannot explain
      longer waits at the same occupancy. So within the model, only a loss of flexibility closes the gap.`;
    const aa = tf.arrival_models?.["all together"]?.terms || {}, lsa = aa["post:long_stay_z"], bda = aa["post:log_beds_z"];
    const fx = (r, d = 2) => `${r.pct >= 0 ? "+" : "−"}${Math.abs(r.pct).toFixed(0)}% per SD, p=${r.p.toFixed(d)}`;
    if ($("trustSummary")) $("trustSummary").innerHTML = `<strong>No characteristic clearly stands out.</strong> On 12-hour waits from the decision
      to admit, trusts with more long-stay patients saw much bigger rises${ls ? ` (${fx(ls, 3)})` : ""}, with no such pattern before the pandemic${pl ? ` (placebo ${fx(pl)})` : ""}.
      But that measure was near zero everywhere before 2020 because of when decisions were recorded, so a trust's "rise" on it mostly compares
      today's waits with a recording artefact. On 4-hour waits counted from arrival, which do not have that problem, the long-stay pattern
      disappears${lsa ? ` (${fx(lsa)})` : ""}: every group of trusts roughly doubled. Size made no clear difference on the first measure${bd ? ` (${fx(bd)})` : ""}
      and, if anything, bigger trusts did slightly better on the second${bda ? ` (${fx(bda)})` : ""}, the opposite of what simple pooling theory predicts.
      The arrival measure mostly covers patients who are never admitted, so it is a blunt test of anything that blocks beds; the follow-up tests
      below look further.`;
  }
  const [lt, lm] = await Promise.all(["data/longstay_tests.json", "data/longstay_mechanism.json"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  const sgn = (x, d = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
  const pv = (p) => (p < 0.05 ? `<b>${p < 0.001 ? "&lt;0.001" : p.toFixed(3)}</b>` : `<span class="na">${p.toFixed(3)}</span>`);
  if (lt && $("lsTests")) {
    const LAB = { occ_c: "Occupancy (per point)", ls_c: "Long-stay share (per point)", "occ_c:ls_c": "Occupancy × long-stay share",
      nctr_pts: "Beds held by patients fit to leave (per point)", ls_pts_lag1: "Long-stay share last month (per point)",
      "post:long_stay_z": "After × long-stay share (per SD)", "post:nctr_z": "After × fit-to-leave share (per SD)", "post:log_beds_z": "After × trust size (per SD)",
      ls_pre_z: "Long-stay share before (per SD)", "post:ls_pre_z": "After × long-stay share before (per SD)", "post:ls_rise_z": "After × rise in long-stay share (per SD)" };
    const GROUP = { A: "A. Month by month, within trusts (Aug 2023 onwards)", B: "B. Long stays measured before the pandemic", C: "C. Competing explanations (trust panel)" };
    const rows = [];
    for (const g of ["A", "B", "C"]) {
      rows.push([`<b>${GROUP[g]}</b>`, "", "", "", "", ""]);
      for (const [key, m] of Object.entries(lt)) {
        if (key[0] !== g || !m.terms) continue;
        if (key === "A6") {
          for (const [lag, r] of Object.entries(m.terms))
            rows.push([`${key}. Waits ${lag.slice(3)} month${lag === "lag1" ? "" : "s"} earlier predicting long stays now`, "Points of long-stay share per log-unit of the waits rate",
              `${sgn(r.coef, 2)} pts`, `${r.lo.toFixed(2)} to ${r.hi.toFixed(2)}`, pv(r.p), `${num(r.n)} trust-months`]);
          continue;
        }
        for (const [k, r] of Object.entries(m.terms)) {
          const d = Math.abs(r.hi - r.lo) < 20 ? 1 : 0;
          rows.push([`${key}. ${esc(m.label)}`, LAB[k] || esc(k), `${sgn(r.pct, d)}%`, `${r.lo.toFixed(d)}% to ${r.hi.toFixed(d)}%`, pv(r.p),
            m.trusts ? `${num(m.n)} obs, ${m.trusts} trusts` : `${num(m.n)} obs`]);
        }
      }
    }
    if (lt.arrival) {
      rows.push([`<b>Same tests, 4-hour waits from arrival (type 1 A&amp;E)</b>`, "", "", "", "", ""]);
      for (const [key, m] of Object.entries(lt.arrival)) for (const [k, r] of Object.entries(m.terms))
        rows.push([`${key}. ${esc(m.label)}`, LAB[k] || esc(k), `${sgn(r.pct, 1)}%`, `${r.lo.toFixed(1)}% to ${r.hi.toFixed(1)}%`, pv(r.p),
          m.trusts ? `${num(m.n)} obs, ${m.trusts} trusts` : `${num(m.n)} obs`]);
    }
    const bd = lt.B_descriptive;
    $("lsTests").innerHTML = table(["Test", "Term", "Change in long waits", "95% CI", "p", "Sample"], rows, [2, 3, 4]) +
      `<p class="cap">Poisson regressions of 12-hour waits with emergency admissions as exposure, trust and period fixed effects, errors clustered by trust.
      A4 is least squares on the log rate. Monthly long-stay share is the share of occupied G&amp;A beds held by patients in hospital 21 days or more.
      ${bd ? `Before the pandemic (winter sitreps) the average trust had ${pct(bd.mean_before)} of beds held by long-stay patients, against ${pct(bd.mean_after)} after; the two measures correlate at ${bd.correlation.toFixed(2)} across ${bd.trusts} trusts.` : ""}</p>`;
  }
  if (lm && $("lsMech")) {
    const rows = lm.calibration.map((c) => [`Outlying probability ${c.outlying}`, "spread", pct(c.longShare), pct(c.occupancy), pct(c.wait12, 2)]);
    const r2 = lm.rows.map((r) => [`Outlying probability ${r.outlying}`, r.clustered ? "concentrated on a third of wards" : "spread", pct(r.longShare), pct(r.occupancy), pct(r.wait12, 2)]);
    $("lsMech").innerHTML = `<h4>D. Ward-level simulation: ${esc(lm.hospital)}</h4>` +
      table(["Run", "Long-stay patients", "Beds held 21+ days", "Occupancy", "Waiting over 12 hours"], [...rows, ["<b>Varying long stays</b>", "", "", "", ""], ...r2], [2, 3, 4]) +
      `<p class="cap">Each emergency patient belongs to one ward. "Outlying probability" is the chance that a patient can be placed in, or a freed bed can take a patient from, another ward:
      1 means fully shared beds, 0 means every patient waits for their own ward. Ward demand is matched to ward capacity, and occupancy is held at 91.5%. Six runs of three years each.
      An outlying probability of about ${lm.outlyingToday} reproduces today's national rate of 12-hour waits.</p>`;
  }
  if (lt && lm && $("lsSummary")) {
    const a1 = lt.A1.terms.ls_c, a5 = lt.A5.terms.ls_pts_lag1, b1 = lt.B1.terms.ls_pre_z, b2 = lt.B2.terms, c2 = lt.C2.terms["post:nctr_z"], c4 = lt.C4.terms["post:long_stay_z"];
    const at = (o, lf, cl) => lm.rows.find((r) => r.outlying === o && r.longFrac === lf && r.clustered === cl);
    const lo = at(lm.outlyingToday, 0.025, false), hi = at(lm.outlyingToday, 0.045, false), full = lm.calibration.find((c) => c.outlying === 1);
    const A = lt.arrival || {}, ab2 = A.B2?.terms, ac1 = A.C1?.terms?.["post:long_stay_z"];
    const e2 = (r, d = 2) => `${sgn(r.pct)}%, p${r.p < 0.001 ? "&lt;0.001" : "=" + r.p.toFixed(d)}`;
    $("lsSummary").innerHTML = `<strong>Probably not.</strong>
      Long stays themselves changed little: ${pct(lt.B_descriptive.mean_before)} of beds before the pandemic, ${pct(lt.B_descriptive.mean_after)} after.
      Before the pandemic, trusts with more long-stay patients did not have more long waits on either measure (B1: ${e2(b1)} from the decision to admit${A.B1 ? `; ${e2(A.B1.terms.ls_pre_z)} from arrival` : ""}).
      After it, both the level of long stays before (${e2(b2["post:ls_pre_z"])}) and the rise since (${e2(b2["post:ls_rise_z"], 3)}) predict the increase in
      12-hour waits from the decision to admit${ab2 ? `, but not the increase in 4-hour waits from arrival (${e2(ab2["post:ls_pre_z"])}; ${e2(ab2["post:ls_rise_z"])})` : ""}; the first of these
      measures was held down before 2020 by when decisions were recorded. On the decision-to-admit measure, patients fit to leave do not explain the
      long-stay pattern (C2: ${e2(c2)}) and it survives regional differences (C4: ${e2(c4, 3)})${ac1 ? `; on the arrival measure there is no pattern to explain (C1: ${e2(ac1)})` : ""}.
      Since the pandemic, within trusts, months with more long-stay patients have more 12-hour waits (A1: ${sgn(a1.pct, 1)}% per point, p=${a1.p.toFixed(3)}), but last month's long stays do not predict this month's waits
      (A5: ${sgn(a5.pct, 1)}%, p=${a5.p.toFixed(2)}) and earlier waits do not predict long stays (A6), so neither clearly drives the other.
      The ward simulation can reproduce the national break: with fully shared beds, waits over 12 hours are ${pct(full.wait12, 2)}; when patients can rarely be placed outside their own ward
      they reach today's level. But raising long stays from ${pct(lo.longShare, 0)} to ${pct(hi.longShare, 0)} of beds only moves waits from ${pct(lo.wait12, 1)} to ${pct(hi.wait12, 1)},
      and concentrating long-stay patients on some wards makes no difference. So long-stay patients go with longer waits for a bed today, but beds
      blocked by them are probably not what broke the system.`;
  }
  await renderPoolTests(BASE0);
  await renderTrustPools();
  await renderExtra();
  if (v.effects) {
    const OUT = { emergency_all: "All emergency admissions", copd: "COPD", chd: "Coronary heart disease", stroke: "Stroke",
      pneumonia: "Pneumonia", respiratory: "Respiratory", falls65: "Falls, 65+ (placebo)", hip_fracture: "Hip fracture, 65+ (placebo)" };
    const EXP = { smoking: "Smoking %", obesity: "Obesity %", flu_uptake65: "Flu vaccine uptake 65+ %", alcohol_narrow: "Alcohol admissions", deprivation: "deprivation" };
    const lab = (s) => s.split(" + ").map((x) => EXP[x] || x).join(", ");
    const est = v.effects.filter((e) => Number.isFinite(e.pct));
    const dropped = v.effects.length - est.length;
    $("effects").innerHTML = table(["Outcome", "Risk factor", "Also adjusted for", "Design", "% change per point", "95% CI", "p"],
      est.map((e) => [esc(OUT[e.outcome] || e.outcome), esc(EXP[e.exposure] || e.exposure), esc(e.adjustedFor ? lab(e.adjustedFor) : ""),
        esc(e.design), e.pct.toFixed(2), Number.isFinite(e.lo) ? `${e.lo.toFixed(2)} to ${e.hi.toFixed(2)}` : "", Number.isFinite(e.p) ? e.p.toFixed(3) : ""]), [4, 6]) +
      (dropped ? `<p class="cap">${dropped} within-area estimates are omitted: those outcomes are published for one period only, so change over time within an area cannot be measured.</p>` : "");
  }
}

main().catch((e) => { document.body.insertAdjacentHTML("beforeend", `<p class="wrap">Could not load data: ${esc(e.message)}</p>`); });

async function renderPoolTests(base) {
  if (!$("poolTests")) return;
  if (base?.calibration?.B) POOL_B = base.calibration.B.poolSize;
  const names = ["pool_tests", "deadline_test", "pool_slopes", "daily_tests", "infection_tests", "site_tests", "clock_test"];
  const J = Object.fromEntries(await Promise.all(names.map((n) => fetch(`data/${n}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => [n, d]))));
  const sg = (x, d = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
  const ef = (r, d = 0) => `${sg(r.pct, d)}%`, ci = (r, d = 0) => `${r.lo.toFixed(d)}% to ${r.hi.toFixed(d)}%`;
  const pv = (p) => (p < 0.05 ? `<b>${p < 0.001 ? "&lt;0.001" : p.toFixed(3)}</b>` : `<span class="na">${p.toFixed(3)}</span>`);
  let h = "";
  const pt = J.pool_tests;
  if (pt?.years?.length) {
    const f12 = (y) => y.fits.find((f) => f.fittedTo === "wait12"), a = pt.years[0], z = pt.years[pt.years.length - 1];
    if (f12(a) && f12(z)) POOL_FITS = { pre: f12(a).pool, preFy: a.fy, post: f12(z).pool, postFy: z.fy };
  }
  if (pt) {
    const rows = [];
    for (const y of pt.years) {
      rows.push([`<b>${esc(y.fy)}</b>`, "observed", "", pct(y.observed.wait4, 1), pct(y.observed.wait12, 2)]);
      for (const f of y.fits) rows.push(["", `pool fitted to ${f.fittedTo === "wait12" ? "12-hour" : "4-hour"} waits`, `${num(f.pool)} beds`, pct(f.wait4, 1), pct(f.wait12, 2)]);
    }
    h += `<h4>A. Two outcomes, one setting</h4>` + table(["Year", "Run", "Pool size", "Waiting over 4 hours", "Waiting over 12 hours"], rows, [2, 3, 4]) +
      `<p class="cap">Waits from decision to admit, share of emergency admissions. Each year with its own beds, admissions and occupancy.
      A single pool size cannot match both outcomes before the pandemic: a plain queue cannot produce many 4-hour waits with almost no 12-hour ones.
      Both pre-pandemic figures are timed from the decision to admit, which was often recorded late (test D), so much of the mismatch is a recording artefact.</p>`;
  }
  const dl = J.deadline_test;
  if (dl) {
    const rows = dl.runs.map((r) => [`${r.deadlineH} hours`, esc(r.fy), `${num(r.pool)} beds`, `${r.deadlinePct.toFixed(1)}%`, pct(r.wait4, 1) + ` (${pct(r.observed.wait4, 1)})`, pct(r.wait12, 2) + ` (${pct(r.observed.wait12, 2)})`, num(r.inDeadlineSpaces8am)]);
    h += `<h4>B. A deadline: escalation space for patients approaching 12 hours</h4>` +
      table(["Deadline", "Year", "Pool (fitted to 4h)", "Extra space, % of beds (fitted to 12h)", "Over 4h (observed)", "Over 12h (observed)", "In escalation spaces 08:00"], rows, [2, 3, 4, 5, 6]) +
      `<p class="cap">The model's research option <code>deadlineH</code>/<code>deadlinePct</code>: once a patient has waited the deadline, extra spaces can take them.
      Two settings are fitted to two figures, so the fit itself proves nothing, and the pre-pandemic figures are timed from the decision to admit (test D);
      the checks are the size of the settings and the 08:00 count, which was not fitted
      (NHS England's ward corridor count for 2025/26: ${num(dl.corridorObserved8am)}).</p>`;
  }
  const sl = J.pool_slopes;
  if (sl) {
    const rows = [];
    const SL = { waits4: "Over 4 hours from the decision to admit", waits12: "Over 12 hours from the decision to admit", arrival4: "Over 4 hours from arrival (type 1 A&amp;E)" };
    for (const [k, r] of Object.entries(sl.slopes)) rows.push([SL[k] || esc(k), `${ef(r.before, 1)} (${ci(r.before, 1)})`, `${ef(r.after, 1)} (${ci(r.after, 1)})`, pv(r.change_p)]);
    const t = sl.tail_by_trust.terms;
    h += `<h4>C. Slopes and which trusts lost the cap</h4>` + table(["Waits", "Per point of occupancy, before", "After", "p (change)"], rows, [1, 2, 3]) +
      `<p class="cap">${sl.n_trusts} trusts, trust-years 2017/18–2019/20 and 2022/23–2025/26, trust and year fixed effects. Smaller pools predict a flatter proportional slope.
      Share of 4-hour waiters reaching 12 hours: before ${pct(sl.ratio.before.share_of_4h_reaching_12h, 1)}, after ${pct(sl.ratio.after.share_of_4h_reaching_12h, 1)}.
      That share rose more in trusts with more long-stay patients (${ef(t["post:long_stay_z"])} per SD, p=${t["post:long_stay_z"].p.toFixed(3)})
      than in smaller trusts (bigger trusts ${ef(t["post:log_beds_z"])}, p=${t["post:log_beds_z"].p.toFixed(2)}), but the "before" share is held down by when decisions
      to admit were recorded (test D), so these comparisons rest on that artefact. The slope from arrival does not: it flattened too.</p>`;
  }
  const ck = J.clock_test;
  if (ck) h += `<h4>D. When does the clock start?</h4>${ck.html || ""}`;
  const dt = J.daily_tests;
  if (dt) {
    const t2 = dt.test2, t5 = dt.test5;
    const cv = dt.curve, bk = (c) => 2 * Math.round(c.occ / 2), bins = [...new Set(cv.map(bk))].sort((a, b) => a - b);
    const rows = bins.map((b) => { const f = (per) => cv.find((c) => c.period === per && bk(c) === b); const x = f("before"), y = f("after");
      return [`${b}%`, x ? pct(x.delay60_share, 1) : "", y ? pct(y.delay60_share, 1) : ""]; });
    h += `<h4>E. Same-day curves: ambulance handover delays and that day's occupancy</h4>` +
      table(["Occupancy of open G&A beds (band mean)", "Handovers delayed over 60 min, before", "After"], rows, [1, 2]) +
      `<p class="cap">Winter daily sitreps, December–February, ${num(dt.n_trusts)} trusts, ${num(dt.n_trust_days)} trust-days (${dt.winters.join(", ")}).
      Within a trust and winter, with date fixed effects, delays rise ${ef(t2.before, 1)} per point of occupancy before and ${ef(t2.after, 1)} after
      (change p=${t2.change.p.toFixed(2)}). At the same occupancy, delays are ${ef(t2.level_after_same_occupancy)} higher after (p&lt;0.001).
      Pure pool shrinkage would also flatten the slope; the curve has moved up, not changed shape.</p>` +
      `<h4>F. Escalation used up</h4>` + table(["Period", "Days with escalation beds at the winter maximum", "Extra delays on those days, same occupancy", "95% CI", "p"],
        ["before", "after"].map((k) => [k === "before" ? "Before (2017/18–2019/20)" : "After (2023/24–2025/26)", pct(t5[k].share_days_full, 0), ef(t5[k].esc_full), ci(t5[k].esc_full), pv(t5[k].esc_full.p)]), [1, 2, 3, 4]) +
      `<p class="cap">Escalation beds open at 90% or more of the trust's 95th-percentile level that winter. Change in the effect p=${t5.change.p.toFixed(3)}.
      Escalation beds as a share of open beds: before ${pct(dt.periods.before.escalation_share, 1)}, after ${pct(dt.periods.after.escalation_share, 1)}.
      ${dt.test5_monthly_12h ? `Before the pandemic, ${pct(dt.test5_monthly_12h.share_of_12h_in_those_months, 0)} of 12-hour waits fell in the ${pct(dt.test5_monthly_12h.share_months_mostly_full, 0)} of trust-months with escalation used up on most days
      (against ${pct(dt.test5_monthly_12h.share_of_4h_in_those_months, 0)} of 4-hour waits), both timed from the decision to admit.` : ""}</p>`;
  }
  const it = J.infection_tests;
  if (it) {
    const rows = it.by_year.map((y) => [esc(y.fy), pct(y.wait12, 1), pct(y.covid_share, 1), pct(y.void_share, 2), pct(y.explained, 1)]);
    h += `<h4>G. Infection control</h4>` + table(["Year", "Waiting over 12 hours", "G&A beds with COVID-19 patients", "COVID void beds", "Share of 12-hour waits explained"], rows, [1, 2, 3, 4]) +
      `<p class="cap">${num(it.n_trust_months)} trust-months, ${it.months.map((m) => `${MONTH_NAMES[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`).join(" to ")}. Within trusts, holding occupancy: COVID inpatients ${ef(it.covid.covid_pts, 1)} per point of beds (p=${it.covid.covid_pts.p.toFixed(2)}),
      void beds ${ef(it.void.void_pts, 1)} per point (p=${it.void.void_pts.p.toFixed(2)}). The "explained" column applies these estimates.</p>`;
  }
  const st = J.site_tests;
  if (st) {
    const NM = { post_sites_z: "Hospital sites (log, per SD)", post_log_beds_z: "Trust size (per SD)", post_long_stay_z: "Long-stay share (per SD)", post_beds_per_site_z: "Beds per site (per SD)", post_single_z: "Single bedrooms per bed (per SD)" };
    const rows = [];
    for (const [title, models] of [["12-hour waits from the decision to admit", st.models], ["4-hour waits from arrival (type 1 A&amp;E)", st.arrival_models || {}]])
      for (const [m, terms] of Object.entries(models)) for (const [k, r] of Object.entries(terms)) rows.push([`${esc(m)}<br><span class="na">${title}</span>`, NM[k] || esc(k), ef(r), ci(r), pv(r.p)]);
    h += `<h4>H. Split sites and single rooms</h4>` + table(["Model", "After the pandemic ×", "Change in waits", "95% CI", "p"], rows, [2, 3, 4]) +
      `<p class="cap">${st.n_trusts} trusts. General acute and mixed-service hospital sites per trust and single bedrooms, from ERIC 2018/19 site data (median ${st.sites.median} sites,
      ${pct(st.sites.share_multi_site, 0)} of trusts have more than one; median ${st.sites.single_per_bed_median.toFixed(2)} single bedrooms per G&amp;A bed).</p>`;
  }
  $("poolTests").innerHTML = h;
  if ($("poolSummary")) $("poolSummary").innerHTML = poolSummary();
}


let POOL_B = 96, POOL_FITS = null;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// how much the pool fitted to 12-hour waits from the decision to admit shrank (pool test A), in words
const poolDrop = () => {
  const f = POOL_FITS;
  if (!f) return "The drop in pool size that the model needs is mostly a product of the 12-hour measure it is fitted to.";
  return `Fitted to 12-hour waits from the decision to admit, the pool shrinks from ${num(f.pre)} beds (${f.preFy}) to ${num(f.post)} (${f.postFy}), about
  ${(f.pre / f.post).toFixed(1)}-fold, and that drop is mostly a product of the measure it is fitted to.`;
};
const poolSummary = () => `<strong>Mostly real, but smaller than the recorded figures suggest.</strong>
  ${poolDrop()}
  Before the pandemic about 320,000 patients a year spent over 12 hours in A&amp;E from arrival, but only about 3,300 were counted
  as waiting 12 hours from the decision to admit (D). Measured from arrival, 12-hour waits rose about fivefold, not 140-fold.
  Other measures that do not depend on when a decision is recorded tell the same story at the same occupancy: 4-hour waits counted from
  arrival roughly doubled (see the blog), and ambulance handover delays rose about fourfold (E). Fitted to 4-hour waits from the decision
  to admit, pools shrink by about 40% (B), far less than the 12-hour fit suggests, though that measure is also timed from the decision. Part of what changed is the room to escalate: hospitals open fewer escalation beds at the same occupancy, and
  running out of them now matters less, because delays are common on ordinary days too (F). But the handover curve moved up at every
  occupancy, including around 80%, rather than changing shape, which points to pressures outside the bed pool as well. Infection control (G), split sites and single rooms (H) do not explain which trusts got worse, on
  either measure. A high long-stay share goes with a bigger rise in 12-hour waits from the decision to admit (C, H), but not in 4-hour waits from
  arrival, so that result may rest on the recording artefact. For this reason the simulator's "pre-pandemic flexibility" setting is fitted to 12-hour waits counted from
  arrival, not from the decision to admit: pools of about ${Math.round(POOL_B)} beds (see the methods page).`;

async function renderTrustPools() {
  if (!$("trustPools")) return;
  const tp = await fetch("data/trust_pools.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!tp) return;
  const sg = (x, d = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
  const yrs = Object.keys(tp.n).sort();
  let h = table(["Year", "Trusts", "Median pool (middle half)", "Median pool as a share of beds", "Waits too low for any pool (whole hospital shared)"],
    yrs.map((fy) => { const n = tp.n[fy]; return [esc(fy), num(n.trusts), `${num(n.medianPool)} beds (${num(n.q1)}–${num(n.q3)})`, pct(n.medianShare, 1), num(n.wholeHospital)]; }), [1, 2, 3, 4]);
  h += `<h3>Stability</h3>` + table(["Years", "Rank correlation of trusts' pools", "p", "Trusts"],
    tp.stability.map((s) => [`${esc(s.a)} and ${esc(s.b)}`, s.spearman.toFixed(2), s.p < 0.001 ? "<0.001" : s.p.toFixed(3), num(s.n)]), [1, 2, 3]) +
    `<p class="cap">${pct(tp.icc.betweenTrust, 0)} of the variation in (log) pool size is between trusts rather than from year to year
    (${num(tp.icc.trusts)} trusts with at least two uncensored years).</p>`;
  const P = tp.prediction;
  h += `<h3>Predicting 2025/26 from 2023/24</h3>` + table(["Pool used", "Rank correlation with observed 12-hour waits", "Median absolute error", "Within a factor of 2"],
    [["Each trust's own 2023/24 pool", P.ownPool.spearman.toFixed(2), `${(100 * P.ownPool.medae).toFixed(1)} pts`, pct(P.ownPool.withinFactor2, 0)],
      ["The national pool (today's calibration)", P.nationalPool.spearman.toFixed(2), `${(100 * P.nationalPool.medae).toFixed(1)} pts`, pct(P.nationalPool.withinFactor2, 0)]], [1, 2, 3]) +
    `<p class="cap">${num(P.n)} trusts, each run with its own 2025/26 beds, admissions and occupancy. Mean observed share waiting over 12 hours:
    ${pct(P.observedMean, 1)}. A few trusts recorded near 100% occupancy, where the model's waits explode, so mean errors are larger than median ones.</p>`;
  const C = tp.correlates, J = tp.joint;
  h += `<h3>What goes with a trust's pool size (2025/26)</h3>` + table(["Characteristic", "Rank correlation with pool size", "p", "Trusts"],
    Object.values(C).map((c) => [esc(c.label), sg(c.spearman, 2), c.p < 0.001 ? "<0.001" : c.p.toFixed(3), num(c.n)]), [1, 2, 3]) +
    `<p class="cap">Smaller pool = less flexible. Delays per 100 G&amp;A beds, April 2025 to March 2026 (acute discharge sitrep). In a joint regression
    (R² ${J.r2.toFixed(2)}, ${num(J.n)} trusts), each standard deviation more hospital-process delays goes with a ${sg(J.terms.hp_z.pct)}% pool
    (95% CI ${sg(J.terms.hp_z.lo)}% to ${sg(J.terms.hp_z.hi)}%, p=${J.terms.hp_z.p.toFixed(3)}); social care delays ${sg(J.terms.sc_z.pct)}% (p=${J.terms.sc_z.p.toFixed(2)}),
    long-stay share ${sg(J.terms.ls_pts_z.pct)}% (p=${J.terms.ls_pts_z.p.toFixed(2)}), size ${sg(J.terms.log_beds_z.pct)}% (p=${J.terms.log_beds_z.p.toFixed(2)}).
    The positive link with occupancy is partly built in: a trust that runs very full with modest waits can only be fitted with a large pool.</p>`;
  const s1 = tp.stability.find((s) => s.a === "2022/23" && s.b === "2023/24"), s2 = tp.stability.find((s) => s.a === "2023/24" && s.b === "2025/26");
  const callout = `<div class="callout"><strong>Yes.</strong> Trusts' flexibility is a real, persistent property: a trust's fitted pool in one year
    ranks closely with its pool the next (${s1 ? s1.spearman.toFixed(2) : ""}) and two years later (${s2 ? s2.spearman.toFixed(2) : ""}), and
    ${pct(tp.icc.betweenTrust, 0)} of the variation is between trusts. Using each trust's own earlier pool ranks its later waits far better than
    one national pool (${P.ownPool.spearman.toFixed(2)} against ${P.nationalPool.spearman.toFixed(2)}), but predicts their level only roughly
    (median error ${(100 * P.ownPool.medae).toFixed(1)} points), because the model's waits respond too steeply to occupancy (E4). Less flexible
    trusts are not the smaller ones, nor clearly those with more long-stay patients or social care delays; they are the ones with more delays
    from their own discharge processes, though that explains only a small part of the differences (R² ${J.r2.toFixed(2)}).</div>`;
  if ($("trustPoolsSummary")) $("trustPoolsSummary").innerHTML = callout; else h += callout;
  $("trustPools").innerHTML = h;
}

async function renderExtra() {
  if (!$("extraSummary")) return;
  const x = await fetch("data/validation_extra.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!x) { $("extraSummary").innerHTML = "<p class=\"cap\">Not yet run.</p>"; return; }
  const css = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  const tag = (p) => (p == null ? "<span class=\"na\">reported</span>" : p ? "<b>PASS</b>" : "<b>FAIL</b>");
  $("extraSummary").innerHTML = table(["", "Test", "Result", "Pass criterion"], x.tests.map((t) => [tag(t.pass), `${esc(t.id)}. ${esc(t.name)}`, esc(t.summary), esc(t.criterion)]), []) +
    `<p class="cap">${x.tests.map((t) => `<b>${esc(t.id)}</b>: ${esc(t.note)}`).join(" ")}</p>`;
  const e2 = x.tests.find((t) => t.id === "E2");
  if (e2) {
    const lab = e2.rows.map((r) => r.month);
    const ds = (k, label, color, dash) => ({ label, data: e2.rows.map((r) => 100 * r[k]), borderColor: color, borderWidth: 2, pointRadius: 2, ...(dash ? { borderDash: [5, 3] } : {}) });
    const opt = (yt) => ({ responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } },
      scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 }, grid: { display: false } }, y: { title: { display: true, text: yt } } } });
    new Chart($("chartE2occ"), { type: "line", data: { labels: lab, datasets: [ds("occ_obs", "Published (sitrep)", css("--text")), ds("occ_model", "Simulated", css("--series-scn"), true)] }, options: opt("Occupancy at 08:00 (%)") });
    new Chart($("chartE2wait"), { type: "line", data: { labels: lab, datasets: [ds("wait12_obs", "Published (A&E)", css("--text")), ds("wait12_model", "Simulated", css("--series-scn"), true)] }, options: opt("Over 12 hours (%)") });
    $("extraE2").innerHTML = table(["Year", "Occupancy shape (r)", "Occupancy error", "12-hour waits shape (r)", "12-hour waits: published / simulated", "Winter peak ÷ summer trough: published / simulated"],
      e2.perYear.map((y) => [esc(y.fy), y.occCorr.toFixed(2), `${(100 * y.occMae).toFixed(1)} pts`, y.waitCorr.toFixed(2), `${pct(y.waitObs)} / ${pct(y.waitModel)}`, `${y.ampObs.toFixed(1)}× / ${y.ampModel.toFixed(1)}×`]), [1, 2, 3, 4, 5]);
  }
  let h = "";
  const e1 = x.tests.find((t) => t.id === "E1");
  if (e1) h += `<h3>E1. Forecast from the past</h3>` + table(["Year", "Occupancy: published", "Forecast", "12-hour waits: published", "Forecast"],
    e1.rows.map((r) => [esc(r.fy), pct(r.occ_obs), pct(r.occ_model), pct(r.wait12_obs, 2), pct(r.wait12_model, 2)]), [1, 2, 3, 4]) +
    `<p class="cap">Fitted to ${esc(e1.fittedTo)}: pool size ${num(e1.pool)} beds (today's calibration ${num(base0().calibration.A.poolSize)}).</p>`;
  const e4 = x.tests.find((t) => t.id === "E4");
  if (e4) h += `<h3>E4. Shape of the waits</h3>` + table(["Measure", "Observed", "Model", "Note"],
    e4.rows.map((r) => [esc(r.measure), r.observed == null ? "" : r.fmt === "pctpt" ? `${(100 * r.observed).toFixed(1)}% per point` : pct(r.observed),
      r.fmt === "pctpt" ? `${(100 * r.model).toFixed(1)}% per point` : pct(r.model), esc(r.note || "")]), [1, 2]);
  const e6 = x.tests.find((t) => t.id === "E6");
  if (e6) h += `<h3>E6. Uncertainty and sensitivity</h3>` + table(["Variant", "Pool size", "12-hour waits a year", "+5,000 beds", "Stays 10% shorter"],
    e6.rows.map((r) => [esc(r.label), num(r.pool), num(r.base12), num(r.beds5k), num(r.los10)]), [1, 2, 3, 4]) +
    `<p class="cap">Changes in emergency patients a year waiting over 12 hours, today's system. Each variant is refitted to 2025/26 before the policies are run,
      with fewer simulation runs than the main results, so its central figures differ by a few percent from those quoted elsewhere on the site.</p>`;
  $("extraDetail").innerHTML = h;
  const g = (id) => x.tests.find((t) => t.id === id) || {};
  const E4 = g("E4"), E5 = g("E5"), E6 = g("E6");
  const slope = E4.rows ? E4.rows.find((r) => r.measure.startsWith("Rise in 12-hour")) : null;
  const E5o = E5.observed;
  $("extraTakeaway").innerHTML = `<strong>Trust the occupancy; treat the effects on waits as upper bounds.</strong>
    The model's waits respond to occupancy far more steeply than hospitals' do:
    ${slope ? `${(100 * slope.model).toFixed(0)}% more 12-hour waits per point of occupancy, against about ${(100 * slope.observed).toFixed(0)}% within trusts (E4)` : ""}.
    So when a scenario frees beds or shortens stays, <b>the simulator probably overstates how much waits fall</b>.
    ${E5o ? `Its assumption that discharge delays matter only by filling beds holds up: within trusts, months with more patients fit to leave
    have no more long waits once occupancy is held fixed (${E5o.beyondOccupancy.pct.toFixed(1)}% per point, 95% CI ${E5o.beyondOccupancy.lo.toFixed(1)} to ${E5o.beyondOccupancy.hi.toFixed(1)}; E5).` : ""}
    ${E6.summary ? `The answers are steady under uncertainty in the inputs: refitting the model under different assumptions moves the effect of
    5,000 more beds or 10% shorter stays by less than a quarter (${esc(E6.summary.split("; ").slice(1).join("; "))}; E6).` : ""}`;
}
let BASE0 = null;
const base0 = () => BASE0;


// 12-hour waits counted from arrival, converted into the decision-to-admit units the model uses: each year's
// arrival-based share relative to the reference year, times that year's decision-to-admit share (the same
// translation the pre-pandemic setting is fitted with; see methods)
function arrivalEquivalent(ck, base) {
  const ref = base?.calibration?.flexibleFit;
  if (!ck || !ref) return null;
  const post = ck.years.find((y) => y.fy === ref.post);
  if (!post) return null;
  return Object.fromEntries(ck.years.map((y) => [y.fy, ref.dtaPost * y.arrival_share / post.arrival_share]));
}

// The narrative text of the validation page, written from the results so the words always match the numbers
function narrative(v, X, CK, TP, FC, base) {
  const chk = (id) => v.checks.find((c) => c.id === id) || {};
  const ext = (id) => (X?.tests || []).find((t) => t.id === id) || {};
  const commas = (str) => esc(str).replace(/\d{4,}/g, (n) => num(+n));
  const grab = (str, re) => { const m = String(str || "").match(re); return m ? m[1] : null; };
  const set = (id, html) => { if ($(id)) $(id).innerHTML = html; };
  const cal = base?.calibration;
  document.querySelectorAll("[data-k]").forEach((el) => {
    const k = el.dataset.k;
    if (k === "poolA" && cal) el.textContent = num(cal.A.poolSize);
    if (k === "poolB" && cal?.B) el.textContent = num(cal.B.poolSize);
  });

  // occupancy
  const v2 = grab(chk("V2").modelA, /error ([\d.]+) pts/), v2c = grab(chk("V2c").modelA, /error ([\d.]+) pts/);
  const ys = v.years.filter((y) => y.occ_A_hesLos != null);
  const worst = ys.reduce((a, y) => (Math.abs(y.occ_A_hesLos - y.occ_obs) > Math.abs(a.occ_A_hesLos - a.occ_obs) ? y : a), ys[0]);
  const E1 = ext("E1"), E2 = ext("E2"), E4 = ext("E4"), E3 = ext("E3");
  const e1r = E1.rows || [];
  const e1Occ = e1r.length ? Math.max(...e1r.map((r) => Math.abs(r.occ_model - r.occ_obs))) : null;
  const e1Wait = e1r.length ? Math.max(...e1r.map((r) => Math.abs(r.wait12_model / r.wait12_obs - 1))) : null;
  const rOcc = grab(E2.summary, /occupancy r = ([\d.]+)/), rWait = grab(E2.summary, /12-hour waits r = ([\d.]+)/);
  set("occText1", `The simulator is set up on 2025/26. Run backwards with only each year's own beds and emergency admissions, it misses
    past occupancy by ${v2} points on average: stays have changed over the years, and it is not told. Given each year's measured overnight
    stays and same-day share as well (HES, on the Health Foundation's definitions), the average error falls to ${v2c} points${worst ? `. The
    worst year is ${esc(worst.fy)}, ${pct(worst.occ_A_hesLos)} simulated against ${pct(worst.occ_obs)} published${worst.fy < "2013/14" ? `, a year whose
    stays have to be linked back from an older HES measure` : ""}` : ""}. Tuned to 2023/24 alone, it forecasts occupancy in the two following years within
    ${e1Occ != null ? (100 * e1Occ).toFixed(1) : "?"} points (E1)${rOcc ? `, and month by month it follows the published series (correlation ${rOcc}; E2)` : ""}.`);
  const w = v.winter, D = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const peak = (a) => D[a.indexOf(Math.max(...a))];
  const v6b = chk("V6b");
  set("occText2", `What it gets less right is the detail. Its day-to-day swings in occupancy are a little smaller than real ones
    (${esc(chk("V3").modelA)} against ${esc(chk("V3").observed)}; V3). Its week peaks on ${peak(w.model.weekday)}, while real hospitals are
    fullest on ${peak(w.observed.weekday)} and their weekly swing is half the size (V4). And its mix of stays is off: it has slightly too few
    patients in hospital 7 to 13 days (V6), and its overnight emergency patients stay ${esc(String(v6b.modelA || "").split(" (")[0])} against
    ${esc(String(v6b.observed || "").split(" (")[0])} in HES (V6b), because published occupancy leaves room for fewer bed days than HES records.`);

  // long waits
  const y0 = CK?.years.find((y) => y.fy === "2018/19");
  const eq = arrivalEquivalent(CK, base);
  if (CK && y0) set("waitText1", `Long waits are harder. NHS England's headline measure, 12-hour waits from the decision to admit, rose about
    ${num(10 * Math.round(CK.rise_from_decision / 10))}-fold between 2018/19 and 2024/25. But before the pandemic that decision was often
    recorded late, so the measure missed most long waits. Counted from arrival, ${num(y0.arrival_over12)} patients spent over 12 hours in
    A&amp;E in 2018/19, against ${num(y0.dta_over12)} counted from the decision to admit, and the rise since then is about
    ${num(CK.rise_from_arrival)}-fold. Any test of the model before 2020 has to use the arrival-based figure.`);
  const f18 = FC?.years.find((y) => y.fy === "2018/19");
  const g0 = f18 ? (f18.grid || []).find((g) => g.delayChangePct === 0 && g.corridorPct === FC.corridorToday) : null;
  set("waitText2", `The model as set up on 2025/26 matches the years since the pandemic: tuned to 2023/24 alone, it forecasts 12-hour
    waits in 2024/25 and 2025/26 within ${e1Wait != null ? (100 * e1Wait).toFixed(0) : "?"}% (E1). It does not match the years before. Given
    2018/19's own beds, admissions and occupancy, it predicts ${g0 ? pct(g0.wait12, 1) : "far more"} of emergency admissions waiting over 12 hours,
    against ${eq?.["2018/19"] != null ? pct(eq["2018/19"], 1) : "far fewer"} on the arrival-based measure. Hospitals then produced far fewer long
    waits at the same fullness, so the simulator has a second version, with larger bed pools (more flexibility), fitted to that figure.
    Section 3 tests what the change is.`);
  const e4 = (m) => (E4.rows || []).find((r) => r.measure.startsWith(m)) || {};
  const amp = E2.perYear ? [E2.perYear.reduce((s, y) => s + y.ampObs, 0) / E2.perYear.length, E2.perYear.reduce((s, y) => s + y.ampModel, 0) / E2.perYear.length] : null;
  const w4 = e4("Emergency admissions waiting over 4"), w412 = e4("Of those waiting 4"), sl = e4("Rise in 12-hour");
  set("waitText3", `The timing and shape of the waits are less right. Month by month the model follows the published waits
    ${rWait ? `(correlation ${rWait})` : ""}, but its winter peak is ${amp ? amp[1].toFixed(0) : "?"} times its summer trough, against about
    ${amp ? amp[0].toFixed(0) : "?"} times in reality (E2). It has too few 4-hour waits (${pct(w4.model, 0)} of emergency admissions against
    ${pct(w4.observed, 0)}), too many of which go on to 12 hours (${pct(w412.model, 0)} against ${pct(w412.observed, 0)}),
    and its 12-hour waits rise ${sl.model != null ? (100 * sl.model).toFixed(0) : "?"}% per point of occupancy against about
    ${sl.observed != null ? (100 * sl.observed).toFixed(0) : "?"}% within trusts (E4). Real hospitals have buffers a plain queue lacks:
    escalation beds, moving patients, extra staff. So the model is right about the level of waits today, but probably too sensitive to changes
    in occupancy.`);

  // corridor care
  const C1 = chk("C1"), C2 = chk("C2"), C3 = chk("C3"), C4 = chk("C4");
  set("corrText", `Fitted to the average ward count (${esc(C1.observed)}, May to September 2026), the model also matches the month-to-month
    pattern it was not fitted to (${esc(C3.modelB || C3.modelA)}; C3), but not the weekly one: real ward corridor care is highest early in the week
    and falls at weekends, while the model's peaks on ${peak(v.corridor?.ward?.weekdayModel || [0])} (${esc(C2.modelB)}; C2). In emergency departments NHS England counted
    ${commas(C4.observed)}; in the model, ${commas(C4.modelA)}, a related but different measure (C4).`);

  // trusts
  const v7 = grab(chk("V7").modelA, /occupancy: correlation (-?[\d.]+)/), v7b = grab(chk("V7b").modelA, /rank correlation (-?[\d.]+)/);
  const e3 = grab(E3.summary, /occupancy correlation (-?[\d.]+)/);
  set("trustText", `The national model treats every trust alike. Given only each trust's beds and emergency admissions, it cannot tell which
    trusts are fullest (correlation ${v7}; V7), and adding each trust's own length of stay does not help (${e3}; E3). Even given each trust's
    own occupancy, it ranks their 12-hour waits only weakly (rank correlation ${v7b}; V7b and the chart below). Trusts at similar occupancy
    have very different waits, so they must differ in something the national model leaves out.`);

  // in brief
  const scored = [...v.checks, ...(X?.tests || [])].filter((c) => c.pass === true || c.pass === false);
  const passed = scored.filter((c) => c.pass).length;
  const P = TP?.prediction;
  const items = [
    `<b>How full hospitals are: yes.</b> Given each year's beds, admissions and measured stays, the model reproduces occupancy back to
      2010/11 within ${v2c} points on average, and forecasts later years within ${e1Occ != null ? (100 * e1Occ).toFixed(1) : "?"} points.`,
    `<b>Long waits: only with a change after 2020.</b> At the same fullness, hospitals now produce about ${CK ? num(CK.rise_from_arrival) : "five"} times as
      many 12-hour waits (counted from arrival) as in 2018/19. The model matches both periods only if beds became less flexible to use; nothing
      else in it closes the gap.`,
    `<b>Too sensitive.</b> The model's 12-hour waits rise ${sl.model && sl.observed ? `about ${Math.round(sl.model / sl.observed)} times` : "several times"}
      more steeply with occupancy than hospitals' do, so treat its effects on waits as upper bounds. Occupancy is the firmer result.`,
    `<b>Trusts differ.</b> One national model cannot say which trusts have the longest waits. Giving each trust its own flexibility ranks
      them well${P ? ` (rank correlation ${P.ownPool.spearman.toFixed(2)}, against ${P.nationalPool.spearman.toFixed(2)} with one national setting)` : ""}.`,
    `<b>Scorecard.</b> ${passed} of ${scored.length} scored checks pass. The failures are mostly about the shape of the waits, the weekly
      pattern and differences between trusts; all are listed <a href="#scorecard">at the end</a>.`,
  ];
  set("vBrief", `<strong>In brief.</strong><ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`);
}
