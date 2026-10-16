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
      This is an association across trusts, not proof of cause. The follow-up tests below ask what lies behind it. Other explanations, such as
      changes in how decision-to-admit times are recorded or in A&amp;E processes, cannot be tested with these data.`;
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
    $("lsSummary").innerHTML = `<strong>What the follow-up tests show.</strong>
      Before the pandemic, trusts with more long-stay patients did not have more long waits (B1: ${sgn(b1.pct)}% per SD, p=${b1.p.toFixed(2)}).
      Long stays themselves changed little: ${pct(lt.B_descriptive.mean_before)} of beds before, ${pct(lt.B_descriptive.mean_after)} after.
      After the pandemic, both the level of long stays before (${sgn(b2["post:ls_pre_z"].pct)}%, p=${b2["post:ls_pre_z"].p.toFixed(2)}) and the rise since
      (${sgn(b2["post:ls_rise_z"].pct)}%, p=${b2["post:ls_rise_z"].p.toFixed(3)}) predict the increase in long waits.
      Within trusts, months with more long-stay patients have more long waits (A1: ${sgn(a1.pct, 1)}% per point, p=${a1.p.toFixed(3)}), but last month's long stays do not predict this month's waits
      (A5: ${sgn(a5.pct, 1)}%, p=${a5.p.toFixed(2)}) and earlier waits do not predict long stays (A6). The link is same-month only, so neither clearly drives the other.
      Patients fit to leave do not explain it (C2: ${sgn(c2.pct)}%, p=${c2.p.toFixed(2)}), and the long-stay effect survives regional differences (C4: ${sgn(c4.pct)}%, p=${c4.p.toFixed(3)}).
      The ward simulation explains the national break: with fully shared beds, waits over 12 hours are ${pct(full.wait12, 2)}; when patients can rarely be placed outside their own ward
      they reach today's level. But in that simulation, raising long stays from ${pct(lo.longShare, 0)} to ${pct(hi.longShare, 0)} of beds only moves waits from ${pct(lo.wait12, 1)} to ${pct(hi.wait12, 1)},
      and concentrating long-stay patients on some wards makes no difference. So beds blocked by long-stay patients are probably not the mechanism.
      More likely, a high long-stay share marks trusts whose patients or local services (older, frailer populations; weaker community and social care)
      suffer most once flexibility is lost, or it shares a common cause with long waits.`;
  }
  await renderPoolTests();
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

async function renderPoolTests() {
  if (!$("poolTests")) return;
  const names = ["pool_tests", "deadline_test", "pool_slopes", "daily_tests", "infection_tests", "site_tests", "clock_test"];
  const J = Object.fromEntries(await Promise.all(names.map((n) => fetch(`data/${n}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((d) => [n, d]))));
  const sg = (x, d = 0) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
  const ef = (r, d = 0) => `${sg(r.pct, d)}%`, ci = (r, d = 0) => `${r.lo.toFixed(d)}% to ${r.hi.toFixed(d)}%`;
  const pv = (p) => (p < 0.05 ? `<b>${p < 0.001 ? "&lt;0.001" : p.toFixed(3)}</b>` : `<span class="na">${p.toFixed(3)}</span>`);
  let h = "";
  const pt = J.pool_tests;
  if (pt) {
    const rows = [];
    for (const y of pt.years) {
      rows.push([`<b>${esc(y.fy)}</b>`, "observed", "", pct(y.observed.wait4, 1), pct(y.observed.wait12, 2)]);
      for (const f of y.fits) rows.push(["", `pool fitted to ${f.fittedTo === "wait12" ? "12-hour" : "4-hour"} waits`, `${num(f.pool)} beds`, pct(f.wait4, 1), pct(f.wait12, 2)]);
    }
    h += `<h4>A. Two outcomes, one setting</h4>` + table(["Year", "Run", "Pool size", "Waiting over 4 hours", "Waiting over 12 hours"], rows, [2, 3, 4]) +
      `<p class="cap">Waits from decision to admit, share of emergency admissions. Each year with its own beds, admissions and occupancy.
      A single pool size cannot match both outcomes before the pandemic: a plain queue cannot produce many 4-hour waits with almost no 12-hour ones.</p>`;
  }
  const dl = J.deadline_test;
  if (dl) {
    const rows = dl.runs.map((r) => [`${r.deadlineH} hours`, esc(r.fy), `${num(r.pool)} beds`, `${r.deadlinePct.toFixed(1)}%`, pct(r.wait4, 1) + ` (${pct(r.observed.wait4, 1)})`, pct(r.wait12, 2) + ` (${pct(r.observed.wait12, 2)})`, num(r.inDeadlineSpaces8am)]);
    h += `<h4>B. A deadline: escalation space for patients approaching 12 hours</h4>` +
      table(["Deadline", "Year", "Pool (fitted to 4h)", "Extra space, % of beds (fitted to 12h)", "Over 4h (observed)", "Over 12h (observed)", "In escalation spaces 08:00"], rows, [2, 3, 4, 5, 6]) +
      `<p class="cap">The model's research option <code>deadlineH</code>/<code>deadlinePct</code>: once a patient has waited the deadline, extra spaces can take them.
      Two settings are fitted to two figures, so the fit itself proves nothing; the checks are the size of the settings and the 08:00 count, which was not fitted
      (NHS England's ward corridor count for 2025/26: ${num(dl.corridorObserved8am)}).</p>`;
  }
  const sl = J.pool_slopes;
  if (sl) {
    const rows = [];
    for (const [k, r] of Object.entries(sl.slopes)) rows.push([k === "waits4" ? "Over 4 hours" : "Over 12 hours", `${ef(r.before, 1)} (${ci(r.before, 1)})`, `${ef(r.after, 1)} (${ci(r.after, 1)})`, pv(r.change_p)]);
    const t = sl.tail_by_trust.terms;
    h += `<h4>C. Slopes and which trusts lost the cap</h4>` + table(["Waits from decision to admit", "Per point of occupancy, before", "After", "p (change)"], rows, [1, 2, 3]) +
      `<p class="cap">${sl.n_trusts} trusts, trust-years 2017/18–2019/20 and 2022/23–2025/26, trust and year fixed effects. Smaller pools predict a flatter proportional slope.
      Share of 4-hour waiters reaching 12 hours: before ${pct(sl.ratio.before.share_of_4h_reaching_12h, 1)}, after ${pct(sl.ratio.after.share_of_4h_reaching_12h, 1)}.
      That share rose more in trusts with more long-stay patients (${ef(t["post:long_stay_z"])} per SD, p=${t["post:long_stay_z"].p.toFixed(3)})
      than in smaller trusts (bigger trusts ${ef(t["post:log_beds_z"])}, p=${t["post:log_beds_z"].p.toFixed(2)}).</p>`;
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
      (against ${pct(dt.test5_monthly_12h.share_of_4h_in_those_months, 0)} of 4-hour waits).` : ""}</p>`;
  }
  const it = J.infection_tests;
  if (it) {
    const rows = it.by_year.map((y) => [esc(y.fy), pct(y.wait12, 1), pct(y.covid_share, 1), pct(y.void_share, 2), pct(y.explained, 1)]);
    h += `<h4>G. Infection control</h4>` + table(["Year", "Waiting over 12 hours", "G&A beds with COVID-19 patients", "COVID void beds", "Share of 12-hour waits explained"], rows, [1, 2, 3, 4]) +
      `<p class="cap">${num(it.n_trust_months)} trust-months, ${it.months.join(" to ")}. Within trusts, holding occupancy: COVID inpatients ${ef(it.covid.covid_pts, 1)} per point of beds (p=${it.covid.covid_pts.p.toFixed(2)}),
      void beds ${ef(it.void.void_pts, 1)} per point (p=${it.void.void_pts.p.toFixed(2)}). The "explained" column applies these estimates.</p>`;
  }
  const st = J.site_tests;
  if (st) {
    const NM = { post_sites_z: "Hospital sites (log, per SD)", post_log_beds_z: "Trust size (per SD)", post_long_stay_z: "Long-stay share (per SD)", post_beds_per_site_z: "Beds per site (per SD)", post_single_z: "Single bedrooms per bed (per SD)" };
    const rows = [];
    for (const [m, terms] of Object.entries(st.models)) for (const [k, r] of Object.entries(terms)) rows.push([esc(m), NM[k] || esc(k), ef(r), ci(r), pv(r.p)]);
    h += `<h4>H. Split sites and single rooms</h4>` + table(["Model", "After the pandemic ×", "Change in 12-hour waits", "95% CI", "p"], rows, [2, 3, 4]) +
      `<p class="cap">${st.n_trusts} trusts. General acute and mixed-service hospital sites per trust and single bedrooms, from ERIC 2018/19 site data (median ${st.sites.median} sites,
      ${pct(st.sites.share_multi_site, 0)} of trusts have more than one; median ${st.sites.single_per_bed_median.toFixed(2)} single bedrooms per G&amp;A bed).</p>`;
  }
  $("poolTests").innerHTML = h;
  if ($("poolSummary")) $("poolSummary").innerHTML = POOL_SUMMARY;
}


const POOL_SUMMARY = `<strong>What the pool tests show.</strong>
  The sixfold drop in pool size that the model needs is mostly a product of the 12-hour measure it is fitted to.
  Before the pandemic about 320,000 patients a year spent over 12 hours in A&amp;E from arrival, but only about 3,300 were counted
  as waiting 12 hours from the decision to admit (D). Measured from arrival, 12-hour waits rose about fivefold, not 140-fold.
  Other measures that do not depend on when a decision is recorded tell the same story: 4-hour waits from the decision to admit rose
  about 2.5-fold, and ambulance handover delays about fourfold at the same occupancy (E). Fitted to 4-hour waits, pools shrink by about
  40%, not sixfold (B). Part of what changed is the room to escalate: hospitals open fewer escalation beds at the same occupancy, and
  running out of them now matters less, because delays are common on ordinary days too (F). But the handover curve moved up at every
  occupancy, including around 80%, rather than changing shape, which points to pressures outside the bed pool as well (emergency department
  crowding, staffing, processes). Infection control (G), split sites and single rooms (H) do not explain which trusts got worse; a high
  long-stay share does (C, H). Implication for the simulator: its "pre-pandemic flexibility" setting, fitted to 12-hour waits from the
  decision to admit, overstates how much flexibility hospitals had and so overstates the gain from getting it back.`;
