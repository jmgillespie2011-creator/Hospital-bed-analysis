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
  new Chart($("chartTrusts"), { type: "scatter", data: { datasets: [
    { label: "Acute trusts", data: v.trusts.map((t) => ({ x: 100 * t.wait12_model_matched, y: 100 * t.wait12_obs, name: t.name })),
      backgroundColor: css("--series-scn"), pointRadius: 4 },
  ] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false },
    tooltip: { callbacks: { label: (c) => `${c.raw.name}: model ${c.raw.x.toFixed(1)}%, observed ${c.raw.y.toFixed(1)}%` } } },
    scales: { x: { title: { display: true, text: "Model: >12h share (given trust occupancy)" } }, y: { title: { display: true, text: "Observed >12h share" } } } } });
  if (v.effects) {
    $("effects").innerHTML = table(["Outcome", "Risk factor", "Design", "% change per point", "95% CI", "p"],
      v.effects.map((e) => [esc(e.outcome), esc(e.exposure), esc(e.design), Number.isFinite(e.pct) ? e.pct.toFixed(2) : "not estimable (one period only)",
        Number.isFinite(e.lo) ? `${e.lo.toFixed(2)} to ${e.hi.toFixed(2)}` : "not estimable", Number.isFinite(e.p) ? e.p.toFixed(3) : ""]), [3]);
  }
}

main().catch((e) => { document.body.insertAdjacentHTML("beforeend", `<p class="wrap">Could not load data: ${esc(e.message)}</p>`); });
