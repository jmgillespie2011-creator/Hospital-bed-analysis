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
        r("Emergency patients discharged the same day (%)", "sameDayFrac", 1, (x) => 100 * x, `Midnights per emergency admission ${num(t.emBedDaysPerAdm, 2)} (HES)`),
        r("Overnight emergency patients delayed once fit (%)", "delayProb", 1, (x) => 100 * x, `Discharged after Discharge Ready Date ${pct(t.delayedShare)} (DRD)`),
        r("Weekend-ready patients discharged at the weekend (%)", "weekendDischargePct", 0, (x) => x, `Weekend/weekday discharge-rate ratio ${num(t.weekendRatio, 2)} (discharge sitrep)`),
        r("Planned admissions front-loaded towards Monday", "electiveFrontLoad", 2, (x) => x, "Weekday pattern of winter occupancy (daily sitrep)"),
        r("Flu admissions per year (simulated wave)", "fluAdmissions", 0, (x) => x, `Flu patients in G&A beds at peak ${num(t.fluPeakBeds)} (winter sitrep, 7-day mean)`),
        r("Effective bed pool size (beds)", "poolSize", 0, (x) => x, `Emergency admissions waiting >12h ${pct(t.wait12Share, 2)} (A&E); flexible system fixed at 1,000`),
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
  if (!window.Chart) return;
  const css = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  Chart.defaults.color = css("--text-2"); Chart.defaults.borderColor = css("--grid");
  const yrs = v.years.slice().reverse();
  new Chart($("chartYears"), { type: "line", data: { labels: yrs.map((y) => y.fy), datasets: [
    { label: "Observed (KH03)", data: yrs.map((y) => 100 * y.occ_obs), borderColor: css("--text"), borderWidth: 2, pointRadius: 4 },
    { label: "Today's system", data: yrs.map((y) => 100 * y.occ_A), borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 4 },
    { label: "More flexible system", data: yrs.map((y) => 100 * y.occ_B), borderColor: css("--series-b"), borderWidth: 2, borderDash: [5, 3], pointRadius: 4 },
  ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } },
    scales: { y: { title: { display: true, text: "Average G&A occupancy (%)" } } } } });
  new Chart($("chartWaits"), { type: "line", data: { labels: yrs.map((y) => y.fy), datasets: [
    { label: "Observed (A&E)", data: yrs.map((y) => 100 * y.wait12_obs), borderColor: css("--text"), borderWidth: 2, pointRadius: 4 },
    { label: "Today's system", data: yrs.map((y) => 100 * y.wait12_A), borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 4 },
    { label: "More flexible system", data: yrs.map((y) => 100 * y.wait12_B), borderColor: css("--series-b"), borderWidth: 2, borderDash: [5, 3], pointRadius: 4 },
  ] }, options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}%` } } },
    scales: { y: { title: { display: true, text: "Emergency admissions waiting >12h (%)" }, beginAtZero: true } } } });
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
    tooltip: { callbacks: { label: (c) => `${c.raw.name}: model ${c.raw.x.toFixed(1)}%, observed ${c.raw.y.toFixed(1)}%` } } },
    scales: { x: { title: { display: true, text: "Model: >12h share (given trust occupancy)" } }, y: { title: { display: true, text: "Observed >12h share" } } } } });
  const [fc, tf] = await Promise.all(["data/flexibility_check.json", "data/trust_flexibility.json"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  if (fc && $("flexCheck")) {
    const rows = [];
    for (const y of fc.years) {
      rows.push([`<b>${esc(y.fy)}</b>`, `<b>observed</b>`, pct(y.occupancyObserved), `<b>${pct(y.wait12Observed, 2)}</b>`]);
      for (const g of y.grid) rows.push(["", `Today's flexibility; delays ${g.delayChangePct === 0 ? "as today" : g.delayChangePct === -100 ? "none" : g.delayChangePct + "%"}; corridor spaces ${g.corridorPct ? g.corridorPct + "% of beds" : "none"}`, pct(g.occupancy), pct(g.wait12, 2)]);
      for (const g of y.favourable || []) rows.push(["", `Today's flexibility; ${esc(g.label)}`, pct(g.occupancy), pct(g.wait12, 2)]);
      for (const n of y.poolNeeded) rows.push(["", `Pool size that reproduces ${esc(y.fy)} waits (${esc(n.label)})`, "", `<b>${num(n.pool)} beds</b> (today ${num(fc.poolToday)})`]);
    }
    $("flexCheck").innerHTML = table(["Year", "Model run", "Occupancy", "Waiting over 12 hours"], rows, [2, 3]);
  }
  if (tf && $("trustTest")) {
    const NAMES = { "post:log_beds_z": "Trust size (log beds)", "post:long_stay_z": "Long-stay share (patients in hospital 21+ days)", "post:single_rooms_z": "Single rooms per bed (ERIC)", "post:occ_pts": "Change in the occupancy slope (per point)" };
    const rows = [];
    for (const [name, m] of Object.entries(tf.models)) {
      for (const [k, r] of Object.entries(m.terms)) {
        if (!NAMES[k] || k === "post:occ_pts") continue;
        const sig = r.p < 0.05;
        rows.push([esc(name), NAMES[k], `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(0)}%`, `${r.lo.toFixed(0)}% to ${r.hi.toFixed(0)}%`, sig ? `<b>${r.p.toFixed(3)}</b>` : `<span class="na">${r.p.toFixed(3)}</span>`, `${m.n_trusts} trusts`]);
      }
    }
    $("trustTest").innerHTML = table(["Model", "Characteristic (after the pandemic ×)", "Change in long waits per SD", "95% CI", "p", "Sample"], rows, [2, 3, 4]) +
      `<p class="cap">${tf.eric ? `Single rooms from ERIC ${esc(tf.eric.year)}.` : "Single rooms (ERIC) not included: the estates data could not be downloaded from this project's pipeline."}
      Long-stay share is measured in 2025/26, inside the "after" period, because trust-level length-of-stay data starts in 2020. Surgical hubs are not tested: there is no complete public list of hubs and their opening dates.</p>`;
  }
  if (fc && tf && $("flexSummary")) {
    const y = fc.years.find((x) => x.fy === "2018/19") || fc.years[0];
    const fav = (y.favourable || []).find((g) => /all/.test(g.label));
    const pn = y.poolNeeded.map((n) => n.pool), all = tf.models["all together"]?.terms || {};
    const ls = all["post:long_stay_z"], bd = all["post:log_beds_z"], pl = tf.models[Object.keys(tf.models).find((k) => k.startsWith("placebo"))]?.terms["post:long_stay_z"];
    $("flexSummary").innerHTML = `<strong>What the tests show.</strong> With ${esc(y.fy)}'s own beds, admissions and occupancy and today's flexibility,
      the model predicts ${fav ? `at least ${pct(fav.wait12, 1)} of emergency admissions waiting over 12 hours even with every favourable assumption` : "far more long waits than observed"},
      against ${pct(y.wait12Observed, 2)} observed. Reproducing ${esc(y.fy)} needs pools of about ${num(Math.min(...pn))}–${num(Math.max(...pn))} beds against ${num(fc.poolToday)} today.
      Average length of stay barely changed nationally, so slower turnover overall cannot explain the break.
      Across trusts, size made no clear difference${bd ? ` (${bd.pct >= 0 ? "+" : ""}${bd.pct.toFixed(0)}% per SD, p=${bd.p.toFixed(2)})` : ""}, which is not what simple pooling theory predicts.
      Trusts with more long-stay patients saw much bigger rises${ls ? ` (${ls.pct >= 0 ? "+" : ""}${ls.pct.toFixed(0)}% per SD, p=${ls.p.toFixed(3)})` : ""},
      and the same pattern is absent before the pandemic${pl ? ` (placebo ${pl.pct >= 0 ? "+" : ""}${pl.pct.toFixed(0)}%, p=${pl.p.toFixed(2)})` : ""}.
      One reading consistent with both: patients who stay for weeks hold particular beds, mostly on medical and elderly-care wards, so the beds
      that emergency patients can actually use turn over less often. The hospital behaves as if it has smaller pools, even though average stays
      are unchanged. This is an association across trusts, not proof of cause. Other explanations, such as changes in how decision-to-admit
      times are recorded or in A&amp;E processes, cannot be tested with these data.`;
  }
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
