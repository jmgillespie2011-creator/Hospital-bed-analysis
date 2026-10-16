import { buildParams, defaultSettings, populationFor, demandBreakdown } from "./demand.js";

const REPS_A = 30;   // replications for "today's hospitals" (small bed pools; fast)
let REPS_B = 6;      // replications for "pre-pandemic flexibility": set on load so both systems simulate the same total beds

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = {
  pct: (x, d = 1) => `${(100 * x).toFixed(d)}%`,
  int: (x) => Math.round(x).toLocaleString("en-GB"),
  k: (x) => x >= 1e6 ? `${(x / 1e6).toFixed(2)}m` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : Math.round(x).toLocaleString("en-GB"),
};

let SWEEP_B = 3;
let trends = null, losChart = null, longChart = null;
let base, settings, baseline = {}, result = {}, dailyChart, sweepCharts = [];

// Two workers: one for the scenario, one for the bed sweep, so a sweep never delays the next scenario.
function makeWorker() {
  const w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const pending = new Map();
  let msgId = 0;
  w.onmessage = (e) => {
    const { id, progress, result: r, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    if (progress != null) { p.onProgress && p.onProgress(progress); return; }
    pending.delete(id);
    error ? p.reject(new Error(error)) : p.resolve(r);
  };
  return (kind, params, reps, extra = {}, onProgress) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ id, kind, params, reps, ...extra });
  });
}
const call = makeWorker();
const callSweep = makeWorker();

// ---------------------------------------------------------------- controls
function controlSpec() {
  const years = Object.keys(base.ageBands[0].pop).map(Number);
  const ymin = Math.min(...years), ymax = Math.max(...years);
  const sign = (v, u = "%") => (v > 0 ? "+" : "") + v + u;
  const fluPrev = (base.flu?.seasons || []).find((x) => x.winter !== BY && x.peak_beds_7day > base.calibration.targets.fluPeakBeds);
  const rf = (base.riskFactors || []).map((r) => ({
    key: "risk:" + r.key, label: r.label, min: r.min, max: r.max, step: r.step,
    fmt: (v) => r.type === "prevalence" ? `${v}%` : sign(v),
    help: r.help,
  }));
  return [
    { section: "Hospital capacity" },
    { key: "beds", label: "General & acute beds", min: 80000, max: 160000, step: 1, fmt: fmt.int, number: true,
      help: `Beds open overnight in England. Today: ${fmt.int(base.national.beds)}. Type an exact number, or use the presets above for historical levels.` },
    { key: "staffingPct", label: "Nursing posts filled", min: 70, max: 100, step: 1, fmt: (v) => v + "%",
      help: "A bed can only be used if it is staffed. Recruitment and retention policies move this. Available beds = beds × % filled." },
    { key: "escalationPct", label: "Extra winter beds", min: 0, max: 10, step: 0.5, fmt: (v) => "+" + v + "%",
      help: "Additional beds opened from December to March." },
    { key: "corridorPct", label: "Corridor care spaces on wards", min: 0, max: 15, step: 0.1, fmt: (v) => v + "% of beds",
      help: "Trolleys or chairs outside a bed space on wards, used only when every proper bed is full. The starting value is fitted to NHS England's count of ward corridor care (2026). Fewer spaces means patients wait in A&E instead; 0 means no corridor care on wards." },
    { key: "electivePct", label: "Planned surgery & treatment", min: 50, max: 150, step: 5, fmt: (v) => v + "% of today",
      help: "Planned (elective) overnight admissions, e.g. to clear waiting lists. These compete with emergency patients for beds." },
    { section: "Public health" },
    { key: "evidence", label: "Evidence for public-health effects", type: "select",
      options: [["published", "OHID attributable estimates and cohort studies"], ["area", "This project's area analysis (where available)"]],
      help: "Smoking and alcohol use OHID's attributable-admission counts either way. For obesity, the published cohort estimate (relative risk 1.28) is much smaller than the association between areas found in this project's analysis (2.49), which is likely confounded. See Validation." },
    ...rf,
    ...(base.flu ? [{ key: "fluUptake65", label: "Flu vaccination uptake, people aged 65+", min: 40, max: 100, step: 1, fmt: (v) => v + "%",
      help: `Today ${base.flu.uptake65}% (${base.flu.uptakeSeason}). Each extra vaccinated person aged 65+ is protected with vaccine effectiveness ${Math.round(100 * base.flu.ve)}% against hospital admission. Changes the size of the winter flu wave.` }] : []),
    ...(base.deprivation ? [{ key: "deprivationGapPct", label: "Close the deprivation gap", min: 0, max: 100, step: 5, fmt: (v) => v + "% closed",
      help: base.deprivation.help }] : []),
    { section: "Hospital flow" },
    { key: "sameDayPct", label: "Same day emergency care", min: 20, max: 80, step: 1, fmt: (v) => v + "% of emergency patients",
      help: `Emergency patients assessed and treated without an overnight stay (SDEC units, frailty assessment). The starting value is fitted so that the share of emergency admissions with no night in hospital matches HES (${(100 * base.calibration.targets.emZeroNightShare).toFixed(1)}%); it is higher than that because patients who arrive late in the evening pass midnight before going home.` },
    { key: "delayChangePct", label: "Delayed discharges", min: -100, max: 50, step: 5, fmt: (v) => sign(v),
      help: "Change in the time medically fit patients wait to leave hospital, whatever the reason: social care, NHS community services, or the hospital's own processes. −100% removes delays entirely." },
    { key: "weekendDischargePct", label: "7-day discharging", min: 0, max: 100, step: 1, fmt: (v) => v + "% at weekends",
      help: "Share of patients ready to leave at the weekend who are discharged then, rather than waiting for Monday." },
    { key: "prepHours", label: "Time from ward round to leaving", min: 0.5, max: 6, step: 0.5, fmt: (v) => v + " h",
      help: "Average time from the morning ward round to the patient leaving (medicines to take home, transport, discharge lounges, criteria-led discharge). Discharge timing within the day is not measured nationally: 3 hours is an assumption, so treat this setting as exploratory." },
    { key: "virtualWardPct", label: "Virtual wards / hospital at home", min: 0, max: 30, step: 1, fmt: (v) => v + "% of stay",
      help: "Share of older patients' (75+) hospital stay delivered at home instead." },
    { key: "admissionAvoidancePct", label: "Community urgent response for older people", min: 0, max: 30, step: 1, fmt: (v) => v + "% avoided",
      help: "Emergency admissions of people aged 75+ avoided by 2-hour community response, frailty and falls services." },
    ...(base.readmissions ? [{ key: "readmissionRatePct", label: "Emergency readmissions within 30 days", min: 8, max: 20, step: 0.1, fmt: (v) => v.toFixed(1) + "% of discharges",
      help: `Today: ${(100 * base.readmissions.rate).toFixed(1)}% (${base.readmissions.year}; ${(100 * base.readmissions.history[0].rate).toFixed(1)}% in ${base.readmissions.history[0].year}). Lowered by better discharge planning, follow-up calls, medicines reconciliation and community follow-up. Readmissions are part of emergency admissions, so fewer readmissions means fewer admissions overall, including readmissions after readmissions. Source: OHID Fingertips 41101.` }] : []),
    { key: "losChangePct", label: "Length of stay programmes", min: -30, max: 20, step: 1, fmt: (v) => sign(v),
      help: "Change in time needed in hospital from faster diagnostics, consultant-led ward rounds, GIRFT-type improvements." },
    { section: "Context (not policy levers)" },
    { key: "popYear", label: "Population of year", min: ymin, max: ymax, step: 1, fmt: (v) => String(v),
      help: `Size and age of England's population (ONS${ymax > base.baseYear ? " estimates and projections" : ""}). Older populations need more beds.` },
    { key: "winterSeverityPct", label: "Severity of the flu season", min: 0, max: 300, step: 25, fmt: (v) => v + "% of " + BY,
      help: `Size of the winter flu wave before vaccination effects. ${BY} peaked at about ${fmt.int(base.calibration.targets.fluPeakBeds)} flu patients in G&A beds (7-day average); ${fluPrev ? `${fluPrev.winter} was bigger, about ${fmt.int(Math.round(fluPrev.peak_beds_7day / 100) * 100)} at its peak (${Math.round(100 * fluPrev.peak_beds_7day / base.calibration.targets.fluPeakBeds / 5) * 5}%).` : ""}` },
    { key: "otherGrowthPct", label: "Other change in emergency demand", min: -30, max: 50, step: 1, fmt: (v) => sign(v),
      help: "Anything not covered above." },
  ];
}

const getVal = (key, s = settings) => key.startsWith("risk:") ? s.risk[key.slice(5)] : s[key];
function setVal(key, v) { if (key.startsWith("risk:")) settings.risk[key.slice(5)] = v; else settings[key] = v; }
const ctlId = (key) => "ctl-" + key.replace(/[^a-z0-9]/gi, "_");
let SPEC = [];

function buildControls() {
  SPEC = controlSpec();
  const root = $("ctl-root");
  root.innerHTML = "";
  const narrow = matchMedia("(max-width: 960px)").matches;
  let sec = null, nSec = 0;
  for (const c of SPEC) {
    if (c.section) {
      sec = document.createElement("details");
      sec.className = "sec";
      sec.open = !narrow || nSec === 0; // on phones only the first section starts open
      sec.innerHTML = `<summary><h2>${c.section}</h2><span class="sec-count"></span></summary>`;
      root.append(sec); nSec++;
      continue;
    }
    const div = document.createElement("div");
    div.className = "ctl";
    const id = ctlId(c.key);
    const helpBtn = c.help ? `<button type="button" class="info" aria-expanded="false" aria-controls="${id}-help" title="What is this?">i</button>` : "";
    const resetBtn = `<button type="button" class="undo" title="Back to ${BY}" aria-label="Reset ${esc(c.label)} to ${BY}">↺</button>`;
    const help = c.help ? `<div class="help" id="${id}-help" hidden>${esc(c.help)}</div>` : "";
    if (c.type === "select") {
      div.innerHTML = `<div class="ctl-head"><label for="${id}">${esc(c.label)}</label>${helpBtn}${resetBtn}</div>
        <select id="${id}">${c.options.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("")}</select>${help}`;
    } else {
      const value = c.number
        ? `<input type="number" class="num-in" id="${id}-num" min="${c.min}" max="${c.max}" step="100" aria-label="${esc(c.label)} (exact)">`
        : `<output id="${id}-out" for="${id}"></output>`;
      div.innerHTML = `<div class="ctl-head"><label for="${id}">${esc(c.label)}</label>${helpBtn}${resetBtn}${value}</div>
        <input type="range" id="${id}" min="${c.min}" max="${c.max}" step="${c.step}">${help}`;
    }
    (sec || root).append(div);
    const input = div.querySelector(c.type === "select" ? "select" : "input[type=range]");
    const commit = (v) => { setVal(c.key, v); syncControls(); schedule(); };
    if (c.type === "select") input.addEventListener("change", () => commit(input.value));
    else {
      input.addEventListener("input", () => showValue(c, Number(input.value)));
      input.addEventListener("change", () => commit(Number(input.value)));
      const num = div.querySelector(".num-in");
      if (num) num.addEventListener("change", () => {
        const v = Math.min(c.max, Math.max(c.min, Math.round(Number(num.value) || getVal(c.key))));
        commit(v);
      });
    }
    const info = div.querySelector(".info");
    if (info) info.onclick = () => {
      const h = div.querySelector(".help"), open = h.hidden;
      h.hidden = !open; info.setAttribute("aria-expanded", String(open));
    };
    div.querySelector(".undo").onclick = () => commit(getVal(c.key, defaultSettings(base)));
  }
  // presets: actual bed numbers, and bed numbers scaled to today's population
  for (const [box, perHead] of [[$("presets-year"), false], [$("presets-head"), true]]) {
    box.innerHTML = "";
    for (const p of base.presets.filter((x) => /per head/.test(x.label) === perHead)) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = p.label.replace(/ per head/, "");
      b.dataset.beds = Math.round(p.beds);
      b.title = `${fmt.int(p.beds)} beds${perHead ? ` (that year's beds per person, applied to today's population)` : ""}${p.note ? ". " + p.note : ""}`;
      b.onclick = () => { settings.beds = Math.round(p.beds); syncControls(); schedule(); };
      box.append(b);
    }
  }
  syncControls();
}

function showValue(c, v) {
  const id = ctlId(c.key);
  if (c.number) $(id + "-num").value = v; else $(id + "-out").textContent = c.fmt(v);
}

function syncControls() {
  const d = defaultSettings(base);
  const changedBySection = new Map();
  let secEl = null;
  for (const c of SPEC) {
    if (c.section) continue;
    const id = ctlId(c.key), input = $(id);
    if (!input) continue;
    input.value = getVal(c.key);
    if (c.type !== "select") showValue(c, Number(input.value));
    const changed = getVal(c.key) !== getVal(c.key, d);
    const div = input.closest(".ctl");
    div.classList.toggle("changed", changed);
    secEl = div.closest("details");
    if (secEl) changedBySection.set(secEl, (changedBySection.get(secEl) || 0) + (changed ? 1 : 0));
  }
  for (const [el, n] of changedBySection) el.querySelector(".sec-count").textContent = n ? `${n} changed` : "";
  document.querySelectorAll(".presets button").forEach((b) => {
    const on = Number(b.dataset.beds) === settings.beds;
    b.classList.toggle("active", on); b.setAttribute("aria-pressed", String(on));
  });
}

// ---------------------------------------------------------------- running
let timer = null, runToken = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(runScenario, 150); writeHash(); setStale(true); }
function setStale(on) {
  $("resultsBody").classList.toggle("stale", on);
  $("mbar").classList.toggle("stale", on);
  if (on) $("status").textContent = "Updating…";
}

async function runScenario() {
  const token = ++runToken;
  const status = $("status");
  const pA = buildParams(base, { ...settings, flexibility: "A" });
  const pB = buildParams(base, { ...settings, flexibility: "B" });
  const [a, b] = await Promise.all([
    call("run", pA, REPS_A, {}, (f) => { if (token === runToken) status.textContent = `Updating… ${Math.round(f * 100)}%`; }),
    call("run", pB, REPS_B),
  ]);
  if (token !== runToken) return;
  result = { A: a, B: b };
  setStale(false);
  status.textContent = `Simulated ${REPS_A} years of patients (today's hospitals) and ${REPS_B} (pre-pandemic flexibility).`;
  render(pA);
  scheduleSweep();
}

// ---------------------------------------------------------------- rendering
let BY = "baseline";
const SYS_NOTE = {
  A: "Today's hospitals: bed flexibility fitted to 2025/26 long waits and corridor care.",
  B: "Pre-pandemic flexibility: beds shared as freely as in 2018/19, fitted to that year's 12-hour waits counted from arrival in A&E. Occupancy is almost the same; waits are not.",
};

// Is the change from the baseline bigger than simulation noise? Scenario and baseline share random numbers run by run,
// so test the run-by-run differences: a change smaller than about two standard errors is reported as "no clear change".
// `pick` is a per-run key, or a function returning the per-run values from perRep. Returns full and short text.
function change(pick, now, then, size, judge = true) {
  const get = typeof pick === "function" ? pick : (p) => p[pick];
  const a = get(result[sys()].perRep), b = get(baseline[sys()].perRep);
  const d = a.map((x, i) => x - b[i]);
  const m = d.reduce((s, x) => s + x, 0) / d.length;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(d.length - 1, 1));
  const se = sd / Math.sqrt(d.length);
  const diff = now - then;
  if (Math.abs(diff) < 1e-12 && sd < 1e-12) return { full: `<span class="chg same">Same as ${BY}</span>`, short: `<span class="chg same">no change</span>` };
  if (Math.abs(m) < 2 * se || Math.abs(diff) < 1e-9) return {
    full: `<span class="chg same" title="The change is smaller than the simulation's random noise">No clear change from ${BY}</span>`,
    short: `<span class="chg same">no clear change</span>` };
  const lower = diff < 0; // where judged, lower is better
  const arrow = `<span aria-hidden="true">${lower ? "▼" : "▲"}</span>`, verdict = lower ? "better" : "worse";
  const cls = judge ? verdict : "same", tail = judge ? ` · <b>${verdict}</b>` : "";
  return {
    full: `<span class="chg ${cls}">${arrow} ${size(Math.abs(diff))} ${lower ? "lower" : "higher"} than ${BY}${tail}</span>`,
    short: `<span class="chg ${cls}">${arrow} ${size(Math.abs(diff)).replace(" a year", "")}${judge ? "<br>" + verdict : ""}</span>` };
}
const pts = (x) => `${(100 * x).toFixed(1)} pts`;
const sys = () => (settings.flexibility === "B" ? "B" : "A");

function render(pA) {
  const s = sys(), R = result[s], R0 = baseline[s];
  const emerg = pA.emergPerYear + pA.fluPerYear;
  // simulation noise on 12-hour waits (95% range for the level)
  const w = R.perRep.wait12, wm = w.reduce((a, b) => a + b, 0) / w.length;
  const wse = Math.sqrt(w.reduce((a, b) => a + (b - wm) ** 2, 0) / Math.max(w.length - 1, 1) / w.length);
  const waitRange = wse > 0 ? ` <span class="range">± ${fmt.k(1.96 * wse * emerg)} simulation noise</span>` : "";
  // the ward count is fitted on the calendar days NHS England has published, so compare on those days
  const ccDays = (base.corridorCare?.daily || []).map((d) => d.day);
  const wardSame = ccDays.length ? ccDays.reduce((a, d) => a + R.escalationDaily8[d], 0) / ccDays.length : null;
  const wardCount = base.corridorCare && wardSame != null ? ` On the days NHS England counted (May–Sep 2026): ${fmt.int(wardSame)} in the model, ${fmt.int(base.corridorCare.wardMean)} counted.` : "";
  const head = [
    { name: "Average bed occupancy", val: fmt.pct(R.occMidnight),
      unit: "of beds in use at midnight", chg: change("occ", R.occMidnight, R0.occMidnight, pts) },
    { name: "Waits over 12 hours for a bed", val: fmt.k(R.wait12PerYear), unit: `a year (${fmt.pct(R.wait12)} of emergency admissions)${waitRange}`,
      chg: change("wait12", R.wait12PerYear, R0.wait12PerYear, (x) => fmt.k(x) + " a year") },
    { name: "Corridor care", val: fmt.k(R.inEscalationSpaces8am),
      unit: `patients on wards outside a bed space at 8am, year average; plus ${fmt.k(R.waitingForBed8am)} waiting in A&E for a bed.${wardCount}`,
      chg: change("ward8", R.inEscalationSpaces8am, R0.inEscalationSpaces8am, (x) => fmt.k(x)) },
  ];
  $("headline").innerHTML = head.map((t) => `<div class="kpi big"><div class="name">${t.name}</div><div class="val">${t.val}</div><div class="unit">${t.unit}</div>${t.chg.full}</div>`).join("");
  const pm = peakMonth(R.daily), pm0 = peakMonth(R0.daily);
  const tiles = [
    { name: "Nights with every bed full", val: fmt.pct(R.nightsFull, 0), sub: "Share of nights a bed pool is 100% full", chg: change("nightsFull", R.nightsFull, R0.nightsFull, pts) },
    { name: "Waiting over 4h for a bed", val: fmt.pct(R.wait4), sub: "Share of emergency admissions", chg: change("wait4", R.wait4, R0.wait4, pts) },
    { name: "Planned admissions lost", val: fmt.pct(R.elecCancelRate), sub: "Slots lost for lack of a bed", chg: change("elec", R.elecCancelRate, R0.elecCancelRate, pts) },
    { name: "Busiest month", val: fmt.pct(pm.v), sub: `Average occupancy in ${pm.m}`, chg: change((p) => p.monthly.map((m) => m[pm.i]), pm.v, pm0.v, pts) },
    ...(base.flu ? [{ name: "Flu patients at the winter peak", val: fmt.k(R.fluBedsPeak), sub: "7-day average", chg: change("fluPeak", R.fluBedsPeak, R0.fluBedsPeak, (x) => fmt.k(x), false) }] : []),
    { name: "Beds held by patients fit to leave", val: fmt.k(R.nctrBedsNational), sub: `${fmt.pct(R.nctrShare)} of occupied beds`, chg: change("nctrBeds", R.nctrBedsNational, R0.nctrBedsNational, (x) => fmt.k(x)) },
  ];
  $("kpis").innerHTML = tiles.map((t) => `<div class="kpi"><div class="name">${t.name}</div><div class="val">${t.val}</div><div class="sub">${t.sub}</div>${t.chg.full}</div>`).join("");
  $("sysNote").textContent = SYS_NOTE[s];
  const SHORT = ["Occupancy", "12h waits / yr", "Corridor care"];
  $("mbarItems").innerHTML = head.map((t, i) => `<div><span class="n">${SHORT[i]}</span><b>${t.val}</b>${t.chg.short}</div>`).join("");
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.sys === s)));
  renderDaily();
  renderLos();
  renderInputs(pA);
}

// Length of stay card: published series (data/blog_trends.json) with this scenario's simulated value at the end
function renderLos() {
  if (!trends) return;
  chartDefaults();
  const s = sys(), R = result[s], R0 = baseline[s];
  const H = trends.years.filter((y) => y.hf_em_los != null), last = H.at(-1);
  // nights per overnight emergency admission (Health Foundation definitions); the model counts it directly
  const losScen = R.emBedDaysPerOvernight;
  const LS = trends.longStays;
  const grey = css("--series-base"), blue = css("--series-scn");
  const mk = (old, canvas, cfg) => { if (old) old.destroy(); return new Chart(canvas, cfg); };
  const labels1 = [...H.map((y) => y.fy), "This scenario"];
  losChart = mk(losChart, $("losChart"), { type: "line", data: { labels: labels1, datasets: [
    { label: "Published (HES)", data: [...H.map((y) => y.hf_em_los), null], borderColor: grey, borderWidth: 2, pointRadius: 3, pointBackgroundColor: grey },
    { label: "This scenario", data: [...H.map(() => null), losScen], borderColor: blue, backgroundColor: blue, pointRadius: 6, showLine: false }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)} nights` } } },
      scales: { x: { grid: { display: false }, ticks: { maxRotation: 50, autoSkip: true } }, y: { min: 0, title: { display: true, text: "Nights per overnight emergency admission" } } } } });
  const labels2 = [...LS.map((r) => r.winter), "This scenario"];
  longChart = mk(longChart, $("longChart"), { type: "bar", data: { labels: labels2, datasets: [{ label: "Over 21 days",
    data: [...LS.map((r) => 100 * r.share21), 100 * R.long21Share], backgroundColor: [...LS.map(() => grey), blue], borderRadius: 4, borderSkipped: false }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false },
      tooltip: { callbacks: { label: (c) => `${c.parsed.y.toFixed(1)}% of occupied beds` } } },
      scales: { x: { grid: { display: false } }, y: { min: 0, title: { display: true, text: "% of occupied beds" } } } } });
  $("losTable").innerHTML = `<table><thead><tr><th>Year</th><th class="num">Nights per overnight emergency admission</th><th class="num">Emergency admissions going home the same day</th></tr></thead><tbody>${
    H.map((y) => `<tr><td>${y.fy}</td><td class="num">${y.hf_em_los.toFixed(2)}</td><td class="num">${fmt.pct(y.em_same_day_share)}</td></tr>`).join("")}
    <tr><td><b>This scenario</b> (simulated)</td><td class="num"><b>${losScen.toFixed(2)}</b></td><td class="num"><b>${fmt.pct(R.emZeroNightShare)}</b></td></tr>
    <tr><td>${BY} baseline (simulated)</td><td class="num">${R0.emBedDaysPerOvernight.toFixed(2)}</td><td class="num">${fmt.pct(R0.emZeroNightShare)}</td></tr></tbody></table>
    <table><thead><tr><th>Winter</th><th class="num">Beds held over 21 days</th></tr></thead><tbody>${
    LS.map((r) => `<tr><td>${r.winter}</td><td class="num">${fmt.pct(r.share21)}</td></tr>`).join("")}
    <tr><td><b>This scenario</b> (simulated, 08:00)</td><td class="num"><b>${fmt.pct(R.long21Share)}</b></td></tr>
    <tr><td>${BY} baseline (simulated)</td><td class="num">${fmt.pct(R0.long21Share)}</td></tr></tbody></table>
    <p class="cap">The baseline is calibrated so the share of emergency admissions going home the same day matches HES ${base.hes?.year || ""}
    (${fmt.pct(base.calibration.targets.emZeroNightShare ?? 0)}). Nights per overnight emergency admission are not fitted: HES gives
    ${(base.calibration.targets.emLosOvernight ?? 0).toFixed(2)} in ${base.hes?.year || ""} (Health Foundation definitions); see <a href="validation.html">validation</a> V6b.</p>`;
}

function peakMonth(daily) {
  let best = { v: -1, m: "", i: 0 };
  for (let i = 0; i < 12; i++) {
    const a = daily.slice(MONTH_START[i], MONTH_START[i + 1]);
    const v = a.reduce((x, y) => x + y, 0) / a.length;
    if (v > best.v) best = { v, m: MONTHS_LONG[i], i };
  }
  return best;
}
const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const MONTHS_LONG = ["April", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February", "March"];
const MONTH_START = [0, 30, 61, 91, 122, 153, 183, 214, 245, 275, 306, 334, 365];
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function chartDefaults() {
  Chart.defaults.color = css("--text-2");
  Chart.defaults.borderColor = css("--grid");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
}
const roll7 = (a) => a.map((_, i) => { const lo = Math.max(0, i - 3), hi = Math.min(a.length, i + 4); let t = 0; for (let j = lo; j < hi; j++) t += a[j]; return t / (hi - lo); });

function renderDaily() {
  chartDefaults();
  const s = sys(), R = result[s], R0 = baseline[s];
  const raw = $("rawDaily").checked;
  const n = R.daily.length;
  const labels = Array.from({ length: n }, (_, i) => {
    const m = MONTH_START.findIndex((st) => st > i) - 1;
    return `${i - MONTH_START[m] + 1} ${MONTHS[m]}`;
  });
  const prep = (a) => (raw ? a : roll7(a)).map((x) => 100 * x);
  const data = {
    labels,
    datasets: [
      { label: "This scenario", data: prep(R.daily), borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 0, tension: 0 },
      { label: `${BY} baseline`, data: prep(R0.daily), borderColor: css("--series-base"), borderWidth: 1.5, pointRadius: 0, borderDash: [4, 3] },
    ],
  };
  const opts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%${raw ? "" : " (7-day average)"}` } } },
    scales: {
      x: { ticks: { callback: (v, i) => { const m = MONTH_START.indexOf(i); return m >= 0 && m < 12 ? MONTHS[m] : null; }, autoSkip: false, maxRotation: 0 }, grid: { display: false } },
      y: { title: { display: true, text: "Beds occupied (%)" }, suggestedMin: 70, suggestedMax: 100 },
    },
  };
  if (dailyChart) { dailyChart.data = data; dailyChart.options = opts; dailyChart.update(); }
  else dailyChart = new Chart($("dailyChart"), { type: "line", data, options: opts });
  const rows = MONTHS_LONG.map((m, i) => {
    const st = MONTH_START[i], e = MONTH_START[i + 1];
    const avg = (a) => a.slice(st, e).reduce((x, y) => x + y, 0) / (e - st);
    return `<tr><td>${m}</td><td class="num">${fmt.pct(avg(R.daily))}</td><td class="num">${fmt.pct(avg(R0.daily))}</td></tr>`;
  });
  $("dailyTable").innerHTML = `<table><thead><tr><th>Month</th><th class="num">This scenario</th><th class="num">${BY} baseline</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function renderInputs(pA) {
  const p0 = buildParams(base, { ...defaultSettings(base), flexibility: "A" });
  const mean = (p) => {
    const tot = p.groups.reduce((s, g) => s + g.share, 0);
    return p.groups.reduce((s, g) => s + g.share * g.losMult, 0) / tot;
  };
  const meanLos = (p) => p.losMedianDays * (1 + p.losChangePct / 100) * mean(p) * Math.exp(p.losSigma ** 2 / 2);
  const rows = [
    ["Physical G&A beds", fmt.int(p0.beds), fmt.int(pA.beds)],
    ["Available (staffed) beds", fmt.int(p0.beds * Math.min(1, p0.staffingPct / 100)), fmt.int(pA.beds * Math.min(1, pA.staffingPct / 100))],
    ["Winter escalation beds", "+0%", `+${pA.escalationPct}%`],
    ["Corridor care spaces on wards", fmt.int(p0.beds * Math.min(1, p0.staffingPct / 100) * p0.corridorPct / 100), fmt.int(pA.beds * Math.min(1, pA.staffingPct / 100) * pA.corridorPct / 100)],
    ["Emergency admissions per year (including flu)", fmt.int(p0.emergPerYear + p0.fluPerYear), fmt.int(pA.emergPerYear + pA.fluPerYear)],
    ["Planned overnight admissions per year", fmt.int(p0.electivePerYear), fmt.int(pA.electivePerYear)],
    ["Emergency patients going home same day", fmt.pct(p0.sameDayFrac, 0), fmt.pct(pA.sameDayFrac, 0)],
    ["Mean clinically needed stay, emergency patients not sent home the same day (days, before ward round and delays)", meanLos(p0).toFixed(2), meanLos(pA).toFixed(2)],
    ["Mean delay (days)", p0.delayMeanDays.toFixed(2), pA.delayMeanDays.toFixed(2)],
    ["Ward round to discharge (hours)", p0.prepHours.toFixed(1), pA.prepHours.toFixed(1)],
    ...demandRows(),
    ["Weekend discharging", `${p0.weekendDischargePct}%`, `${pA.weekendDischargePct}%`],
    ["Emergency admissions with flu per year", fmt.int(p0.fluPerYear), fmt.int(pA.fluPerYear)],
  ];
  const ageRows = base.ageBands.map((b) => {
    const p = populationFor(base, b, settings.popYear), p0b = populationFor(base, b, base.baseYear);
    return `<tr><td>${b.band}</td><td class="num">${fmt.k(p0b)}</td><td class="num">${fmt.k(p)}</td><td class="num">${fmt.int(b.emergAdm)}</td><td class="num">${fmt.int(b.emergAdm * p / p0b)}</td></tr>`;
  }).join("");
  $("inputsTable").innerHTML =
    `<table><thead><tr><th>Input</th><th class="num">${BY} baseline</th><th class="num">This scenario</th></tr></thead><tbody>` +
    rows.map((r) => `<tr${r[1] !== r[2] && r[2] !== "+0.0%" && r[2] !== "−0.0%" ? ' class="diff"' : ""}><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td></tr>`).join("") +
    `</tbody></table><h4 style="margin:14px 0 4px">Population and emergency admissions by age</h4>
    <table><thead><tr><th>Age</th><th class="num">Population ${base.baseYear} (baseline)</th><th class="num">Population ${settings.popYear} (scenario)</th><th class="num">Emergency admissions ${base.baseYear}</th><th class="num">Scenario (population change only)</th></tr></thead><tbody>${ageRows}</tbody></table>`;
}

function demandRows() {
  const d = demandBreakdown(base, settings), x = (m) => (m >= 1 ? "+" : "−") + Math.abs(100 * (m - 1)).toFixed(1) + "%";
  return [
    ["Demand effect: population size & age", "", x(d.population)],
    ...(base.riskFactors || []).map((r) => [`Demand effect: ${r.label.toLowerCase()}`, "", x(d.risk[r.key])]),
    ...(base.deprivation ? [["Demand effect: deprivation gap", "", x(d.deprivation)]] : []),
    ...(base.flu ? [["Flu admissions: vaccination effect", "", x(d.fluVaccine)], ["Flu admissions: season severity", "", x(d.fluSeverity)]] : []),
    ...(base.readmissions ? [["Demand effect: emergency readmissions", "", x(d.readmissions)]] : []),
    ["Demand effect: other", "", x(d.other)],
  ];
}

// ---------------------------------------------------------------- bed sweep (runs by itself when visible)
let sweepVisible = false, sweepBusy = false, sweepWanted = false, sweepTimer = null;
function scheduleSweep() {
  sweepWanted = true;
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => { if (sweepVisible) runSweep(); }, 400);
}
const vline = (getX, label) => ({
  id: "vline",
  afterDatasetsDraw(chart) {
    const { ctx, chartArea: a, scales } = chart;
    const px = scales.x.getPixelForValue(getX());
    if (!(px >= a.left && px <= a.right)) return;
    ctx.save(); ctx.strokeStyle = css("--text-3"); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = css("--text-2"); ctx.font = "12px " + Chart.defaults.font.family;
    ctx.textAlign = px > (a.left + a.right) / 2 ? "right" : "left";
    ctx.fillText(label, px + (ctx.textAlign === "right" ? -6 : 6), a.top + 12); ctx.restore();
  },
});
async function runSweep() {
  if (sweepBusy) return; // the finished run checks sweepWanted and goes again
  sweepBusy = true; sweepWanted = false;
  const snap = JSON.parse(JSON.stringify(settings));
  const cur = snap.beds, beds = [];
  for (let b = Math.max(80000, Math.round(cur * 0.85 / 1000) * 1000); b <= Math.min(170000, cur * 1.45); b += 4000) beds.push(b);
  const pA = buildParams(base, { ...snap, flexibility: "A" }), pB = buildParams(base, { ...snap, flexibility: "B" });
  $("sweepCard").classList.add("stale");
  $("sweepStatus").textContent = "Updating…";
  try {
    const [a, b] = await Promise.all([
      callSweep("sweep", pA, 10, { sweep: { beds } }, (f) => { $("sweepStatus").textContent = `Updating… ${Math.round(f * 100)}%`; }),
      callSweep("sweep", pB, SWEEP_B, { sweep: { beds } }),
    ]);
    drawSweep(beds, a, b, cur);
    $("sweepStatus").textContent = "";
  } finally {
    sweepBusy = false;
    $("sweepCard").classList.remove("stale");
    if (sweepWanted && sweepVisible) runSweep();
  }
}
function drawSweep(beds, a, b, cur) {
  chartDefaults();
  sweepCharts.forEach((c) => c.destroy());
  const mk = (canvas, key, scale, ytitle, tip) => new Chart(canvas, {
    type: "line",
    data: { datasets: [
      { label: "Today's hospitals", data: a.map((p) => ({ x: p.beds, y: scale(p[key]) })), borderColor: css("--series-scn"), backgroundColor: css("--series-scn"), borderWidth: 2, pointRadius: 3 },
      { label: "Pre-pandemic flexibility", data: b.map((p) => ({ x: p.beds, y: scale(p[key]) })), borderColor: css("--series-b"), backgroundColor: css("--series-b"), borderWidth: 2, pointRadius: 3, borderDash: [5, 3] },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => `${fmt.int(c[0].parsed.x)} beds`, label: tip } } },
      scales: { x: { type: "linear", title: { display: true, text: "G&A beds" }, ticks: { callback: (v) => fmt.k(v) }, grid: { display: false } },
        y: { title: { display: true, text: ytitle }, beginAtZero: key !== "occ" } } },
    plugins: [vline(() => cur, "This scenario")],
  });
  sweepCharts = [
    mk($("sweepOcc"), "occ", (x) => 100 * x, "Average occupancy (%)", (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%`),
    mk($("sweepWait"), "wait12PerYear", (x) => x / 1000, "Waits over 12 hours (thousands a year)", (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(0)}k a year`),
  ];
}

// ---------------------------------------------------------------- share / download
function writeHash() {
  const d = defaultSettings(base), diff = {};
  for (const k of Object.keys(settings)) {
    if (k === "risk") { for (const c in settings.risk) if (settings.risk[c] !== d.risk[c]) diff["r." + c] = settings.risk[c]; }
    else if (settings[k] !== d[k]) diff[k] = settings[k];
  }
  history.replaceState(null, "", Object.keys(diff).length ? "#" + new URLSearchParams(diff).toString() : location.pathname);
}
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of h) {
    if (k.startsWith("r.")) { if (k.slice(2) in settings.risk) settings.risk[k.slice(2)] = Number(v); }
    else if (k in settings) settings[k] = ["flexibility", "evidence"].includes(k) ? v : Number(v);
  }
}

async function main() {
  base = await (await fetch("data/baseline.json")).json();
  fetch("data/blog_trends.json").then((r) => (r.ok ? r.json() : null)).then((t) => { trends = t; if (!t) $("losCard").hidden = true; else if (result.A) renderLos(); }).catch(() => { $("losCard").hidden = true; });
  const ratioB = base.calibration.A.poolSize / base.calibration.B.poolSize;
  REPS_B = Math.max(4, Math.round(REPS_A * ratioB));
  SWEEP_B = Math.max(2, Math.round(10 * ratioB));
  BY = base.baseYearLabel || String(base.baseYear);
  document.querySelectorAll(".by").forEach((e) => (e.textContent = BY));
  settings = defaultSettings(base);
  readHash();
  buildControls();
  $("reset").onclick = () => { const f = settings.flexibility; settings = defaultSettings(base); settings.flexibility = f; syncControls(); schedule(); };
  $("share").onclick = async () => { writeHash(); try { await navigator.clipboard.writeText(location.href); $("share").textContent = "Link copied"; } catch { $("share").textContent = "Copy the address bar"; } setTimeout(() => ($("share").textContent = "Copy link to this scenario"), 2000); };
  $("download").onclick = () => {
    const strip = (r) => ({ ...r, daily: undefined, daily8: undefined, perRep: undefined });
    const blob = new Blob([JSON.stringify({ settings, params: buildParams(base, { ...settings, flexibility: "A" }), todaysHospitals: strip(result.A), prePandemicFlexibility: strip(result.B), baseline: strip(baseline.A) }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "bed-scenario.json"; a.click();
  };
  document.querySelectorAll(".seg button").forEach((b) => b.onclick = () => {
    settings.flexibility = b.dataset.sys; writeHash();
    if (result.A) render(buildParams(base, { ...settings, flexibility: "A" }));
  });
  $("rawDaily").onchange = () => result.A && renderDaily();
  // bed sweep: run when its card is on screen
  new IntersectionObserver((es) => { sweepVisible = es.some((e) => e.isIntersecting); if (sweepVisible && sweepWanted) runSweep(); }, { rootMargin: "200px" }).observe($("sweepCard"));
  // phone results bar: shown while the results are off screen
  new IntersectionObserver((es) => { $("mbar").classList.toggle("hide", es.some((e) => e.isIntersecting)); }, { threshold: 0.05 }).observe($("headline"));
  $("status").textContent = `Simulating the ${BY} baseline…`;
  setStale(true);
  const d = defaultSettings(base);
  const [bA, bB] = await Promise.all([
    call("run", buildParams(base, { ...d, flexibility: "A" }), REPS_A),
    call("run", buildParams(base, { ...d, flexibility: "B" }), REPS_B),
  ]);
  baseline = { A: bA, B: bB };
  await runScenario();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { dailyChart && dailyChart.destroy(); dailyChart = null; renderDaily(); renderLos(); });
}
main().catch((e) => { $("status").textContent = "Error: " + e.message; console.error(e); });
