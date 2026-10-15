import { buildParams, defaultSettings, populationFor, demandBreakdown } from "./demand.js";

const REPS_A = 30;   // replications for "today's system" (small bed pools; fast)
const REPS_B = 6;    // replications for the "more flexible system" (large pools; slower, less noisy)

const $ = (id) => document.getElementById(id);
const fmt = {
  pct: (x, d = 1) => `${(100 * x).toFixed(d)}%`,
  int: (x) => Math.round(x).toLocaleString("en-GB"),
  k: (x) => x >= 1e6 ? `${(x / 1e6).toFixed(2)}m` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : Math.round(x).toLocaleString("en-GB"),
};

let base, settings, baselineA, baselineB, resultA, resultB, dailyChart, sweepCharts = [];
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let msgId = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, progress, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  if (progress != null) { p.onProgress && p.onProgress(progress); return; }
  pending.delete(id);
  error ? p.reject(new Error(error)) : p.resolve(result);
};
function call(kind, params, reps, extra = {}, onProgress) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, kind, params, reps, ...extra });
  });
}

// ---------------------------------------------------------------- controls
function controlSpec() {
  const years = Object.keys(base.ageBands[0].pop).map(Number);
  const ymin = Math.min(...years), ymax = Math.max(...years);
  const sign = (v, u = "%") => (v > 0 ? "+" : "") + v + u;
  const rf = (base.riskFactors || []).map((r) => ({
    key: "risk:" + r.key, label: r.label, min: r.min, max: r.max, step: r.step,
    fmt: (v) => r.type === "prevalence" ? `${v}%` : sign(v),
    help: r.help,
  }));
  return [
    { section: "Hospital capacity" },
    { key: "beds", label: "General & acute beds", min: 80000, max: 160000, step: 1, fmt: fmt.int,
      help: `Beds open overnight in England. Today: ${fmt.int(base.national.beds)}. Use the presets above for historical levels.` },
    { key: "staffingPct", label: "Nursing posts filled", min: 70, max: 100, step: 1, fmt: (v) => v + "%",
      help: "A bed can only be used if it is staffed. Recruitment and retention policies move this. Available beds = beds × % filled." },
    { key: "escalationPct", label: "Extra winter beds", min: 0, max: 10, step: 0.5, fmt: (v) => "+" + v + "%",
      help: "Additional beds opened from December to March." },
    { key: "corridorPct", label: "Temporary escalation spaces (corridor care)", min: 0, max: 8, step: 0.5, fmt: (v) => v + "% of beds",
      help: "Extra trolleys or chairs in corridors and on wards, used only when every proper bed is full. Cuts waits in A&E but means more patients are cared for in a corridor rather than a bed." },
    { key: "electivePct", label: "Planned surgery & treatment (elective activity)", min: 50, max: 150, step: 5, fmt: (v) => v + "% of today",
      help: "Planned overnight admissions, e.g. to clear waiting lists. These compete with emergency patients for beds." },
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
    { key: "sameDayPct", label: "Same day emergency care", min: 15, max: 50, step: 1, fmt: (v) => v + "% of emergency patients",
      help: "Emergency patients assessed and treated without an overnight stay (SDEC units, frailty assessment)." },
    { key: "delayChangePct", label: "Delayed discharges (social care & community capacity)", min: -100, max: 50, step: 5, fmt: (v) => sign(v),
      help: "Change in the time medically fit patients wait to leave hospital for care homes, home care or community beds. −100% removes delays entirely." },
    { key: "weekendDischargePct", label: "7-day discharging", min: 0, max: 100, step: 5, fmt: (v) => v + "% at weekends",
      help: "Share of patients ready to leave at the weekend who are discharged then, rather than waiting for Monday." },
    { key: "prepHours", label: "Faster discharge on the day", min: 0.5, max: 6, step: 0.5, fmt: (v) => v + " h after ward round",
      help: "Average time from the morning ward round to the patient leaving (medicines to take home, transport, discharge lounges, criteria-led discharge). Not measured nationally: 3 hours is an assumption." },
    { key: "virtualWardPct", label: "Virtual wards / hospital at home", min: 0, max: 30, step: 1, fmt: (v) => v + "% of stay",
      help: "Share of older patients' (75+) hospital stay delivered at home instead." },
    { key: "admissionAvoidancePct", label: "Community urgent response for older people", min: 0, max: 30, step: 1, fmt: (v) => v + "% avoided",
      help: "Emergency admissions of people aged 75+ avoided by 2-hour community response, frailty and falls services." },
    { key: "losChangePct", label: "Length of stay programmes", min: -30, max: 20, step: 1, fmt: (v) => sign(v),
      help: "Change in time needed in hospital from faster diagnostics, consultant-led ward rounds, GIRFT-type improvements." },
    { section: "Context (not policy levers)" },
    { key: "popYear", label: "Population of year", min: ymin, max: ymax, step: 1, fmt: (v) => String(v),
      help: `Size and age of England's population (ONS${ymax > base.baseYear ? " estimates and projections" : ""}). Older populations need more beds.` },
    { key: "winterSeverityPct", label: "Severity of the flu season", min: 0, max: 300, step: 25, fmt: (v) => v + "% of " + BY,
      help: `Size of the winter flu wave before vaccination effects. ${BY} peaked at about ${fmt.int(base.calibration.targets.fluPeakBeds)} flu patients in G&A beds (7-day average); 2024/25 was bigger, about 5,400 at its peak (175%).` },
    { key: "otherGrowthPct", label: "Other change in emergency demand", min: -30, max: 50, step: 1, fmt: (v) => sign(v),
      help: "Anything not covered above." },
  ];
}

function getVal(key) { return key.startsWith("risk:") ? settings.risk[key.slice(5)] : settings[key]; }
function setVal(key, v) { if (key.startsWith("risk:")) settings.risk[key.slice(5)] = v; else settings[key] = v; }

function buildControls() {
  const root = $("ctl-root");
  root.innerHTML = "";
  for (const c of controlSpec()) {
    if (c.section) { const h = document.createElement("h2"); h.textContent = c.section; root.append(h); continue; }
    const div = document.createElement("div");
    div.className = "ctl";
    const id = "ctl-" + c.key.replace(/[^a-z0-9]/gi, "_");
    if (c.type === "select") {
      div.innerHTML = `<label for="${id}"><span>${c.label}</span></label><select id="${id}">${c.options.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>${c.help ? `<div class="help">${c.help}</div>` : ""}`;
      root.append(div);
      const sel = div.querySelector("select");
      sel.value = getVal(c.key);
      sel.addEventListener("change", () => { setVal(c.key, sel.value); schedule(); });
      continue;
    }
    div.innerHTML = `<label for="${id}"><span>${c.label}</span><output id="${id}-out"></output></label>
      <input type="range" id="${id}" min="${c.min}" max="${c.max}" step="${c.step}">
      ${c.help ? `<div class="help">${c.help}</div>` : ""}`;
    root.append(div);
    const input = div.querySelector("input"), out = div.querySelector("output");
    input.value = getVal(c.key);
    out.textContent = c.fmt(Number(input.value));
    input.addEventListener("input", () => { out.textContent = c.fmt(Number(input.value)); });
    input.addEventListener("change", () => { setVal(c.key, Number(input.value)); schedule(); });
    c.input = input; c.out = out;
  }
  const pre = $("presets");
  pre.innerHTML = "";
  for (const p of base.presets) {
    const b = document.createElement("button");
    b.textContent = p.label;
    b.title = p.note || "";
    b.onclick = () => { settings.beds = Math.round(p.beds); syncControls(); schedule(); };
    pre.append(b);
  }
}
function syncControls() {
  for (const c of controlSpec()) {
    if (c.section) continue;
    const id = "ctl-" + c.key.replace(/[^a-z0-9]/gi, "_");
    const input = $(id); if (!input) continue;
    if (c.type === "select") { input.value = getVal(c.key); continue; }
    input.value = getVal(c.key);
    $(id + "-out").textContent = c.fmt(Number(input.value));
  }
}

// ---------------------------------------------------------------- running
let timer = null, runToken = 0;
function schedule() { clearTimeout(timer); timer = setTimeout(runScenario, 150); writeHash(); }

async function runScenario() {
  const token = ++runToken;
  const status = $("status");
  status.textContent = "Simulating…";
  const pA = buildParams(base, { ...settings, flexibility: "A" });
  const pB = buildParams(base, { ...settings, flexibility: "B" });
  const [a, b] = await Promise.all([
    call("run", pA, REPS_A, {}, (f) => { if (token === runToken) status.textContent = `Simulating… ${Math.round(f * 100)}%`; }),
    call("run", pB, REPS_B),
  ]);
  if (token !== runToken) return;
  resultA = a; resultB = b;
  status.textContent = `Simulated ${REPS_A} years of patients (today's system) and ${REPS_B} (more flexible system).`;
  render(pA);
}

// ---------------------------------------------------------------- rendering
let BY = "baseline";
function delta(x, base0, kind = "pct", goodWhenLower = true) {
  const d = x - base0;
  if (Math.abs(d) < 1e-9) return `<span>same as ${BY}</span>`;
  const cls = d > 0 ? "delta-up" : "delta-down";
  const txt = kind === "pts" ? `${(100 * Math.abs(d)).toFixed(1)} pts` : kind === "int" ? fmt.k(Math.abs(d)) : `${Math.abs(d).toFixed(1)}`;
  return `<span class="${cls}">${txt} vs ${BY}</span>`;
}

function render(pA) {
  const A = resultA, B = resultB, A0 = baselineA, B0 = baselineB;
  const tiles = [
    { name: "Average bed occupancy (midnight)", val: fmt.pct(A.occMidnight),
      sub: `${delta(A.occMidnight, A0.occMidnight, "pts")}<br>Flexible system: ${fmt.pct(B.occMidnight)}` },
    { name: "Nights with every bed full", val: fmt.pct(A.nightsFull, 0),
      sub: `${delta(A.nightsFull, A0.nightsFull, "pts")}<br>Share of nights an effective bed pool is 100% full` },
    { name: "Emergency patients waiting >12h for a bed", val: fmt.k(A.wait12PerYear) + "/yr",
      sub: `${fmt.pct(A.wait12)} of emergency admissions. ${delta(A.wait12PerYear, A0.wait12PerYear, "int")}<br>Flexible system: ${fmt.k(B.wait12PerYear)}/yr` },
    { name: "Patients in corridor care at 8am", val: fmt.k(A.corridorCare8am),
      sub: `${fmt.k(A.waitingForBed8am)} waiting in A&E for a bed, ${fmt.k(A.inEscalationSpaces8am)} in temporary escalation spaces. Worst morning: ${fmt.k(A.corridorCarePeak)}. ${delta(A.corridorCare8am, A0.corridorCare8am, "int")}` },
    { name: "Waiting >4h for a bed", val: fmt.pct(A.wait4),
      sub: `${delta(A.wait4, A0.wait4, "pts")}<br>Flexible system: ${fmt.pct(B.wait4)}` },
    { name: "Planned admission slots lost for lack of a bed", val: fmt.pct(A.elecCancelRate),
      sub: `${delta(A.elecCancelRate, A0.elecCancelRate, "pts")}<br>Flexible system: ${fmt.pct(B.elecCancelRate)}` },
    { name: "Occupancy in the busiest month", val: fmt.pct(peakMonth(A.daily).v),
      sub: `${peakMonth(A.daily).m}. ${delta(peakMonth(A.daily).v, peakMonth(A0.daily).v, "pts")}` },
    ...(base.flu ? [{ name: "Flu patients in beds at the winter peak", val: fmt.k(A.fluBedsPeak),
      sub: `${delta(A.fluBedsPeak, A0.fluBedsPeak, "int")}` }] : []),
    { name: "Beds occupied by patients fit to leave", val: fmt.k(A.nctrBedsNational),
      sub: `${fmt.pct(A.nctrShare)} of occupied beds. ${delta(A.nctrBedsNational, A0.nctrBedsNational, "int")}` },
  ];
  $("kpis").innerHTML = tiles.map((t) => `<div class="kpi"><div class="name">${t.name}</div><div class="val">${t.val}</div><div class="sub">${t.sub}</div></div>`).join("");
  renderDaily();
  renderInputs(pA);
}

function peakMonth(daily) {
  let best = { v: -1, m: "" };
  for (let i = 0; i < 12; i++) {
    const a = daily.slice(MONTH_START[i], MONTH_START[i + 1]);
    const v = a.reduce((x, y) => x + y, 0) / a.length;
    if (v > best.v) best = { v, m: MONTHS[i] };
  }
  return best;
}
const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const MONTH_START = [0, 30, 61, 91, 122, 153, 183, 214, 245, 275, 306, 334, 365];
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function chartDefaults() {
  Chart.defaults.color = css("--text-2");
  Chart.defaults.borderColor = css("--grid");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
}
function renderDaily() {
  chartDefaults();
  const n = resultA.daily.length;
  const labels = Array.from({ length: n }, (_, i) => {
    const m = MONTH_START.findIndex((s) => s > i) - 1;
    return `${MONTHS[m]} day ${i - MONTH_START[m] + 1}`;
  });
  const data = {
    labels,
    datasets: [
      { label: "This scenario", data: resultA.daily.map((x) => 100 * x), borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 0, tension: 0 },
      { label: `${BY} baseline`, data: baselineA.daily.map((x) => 100 * x), borderColor: css("--series-base"), borderWidth: 1.5, pointRadius: 0, borderDash: [4, 3] },
    ],
  };
  const opts = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } },
    scales: {
      x: { ticks: { callback: (v, i) => { const m = MONTH_START.indexOf(i); return m >= 0 && m < 12 ? MONTHS[m] : null; }, autoSkip: false, maxRotation: 0 }, grid: { display: false } },
      y: { title: { display: true, text: "Beds occupied (%)" }, suggestedMin: 60, suggestedMax: 100 },
    },
  };
  if (dailyChart) { dailyChart.data = data; dailyChart.update(); }
  else dailyChart = new Chart($("dailyChart"), { type: "line", data, options: opts });
  const rows = MONTHS.map((m, i) => {
    const s = MONTH_START[i], e = MONTH_START[i + 1];
    const avg = (a) => a.slice(s, e).reduce((x, y) => x + y, 0) / (e - s);
    return `<tr><td>${m}</td><td class="num">${fmt.pct(avg(resultA.daily))}</td><td class="num">${fmt.pct(avg(baselineA.daily))}</td></tr>`;
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
    ["Temporary escalation (corridor) spaces", "0", fmt.int(pA.beds * Math.min(1, pA.staffingPct / 100) * pA.corridorPct / 100)],
    ["Emergency admissions per year (including flu)", fmt.int(p0.emergPerYear + p0.fluPerYear), fmt.int(pA.emergPerYear + pA.fluPerYear)],
    ["Planned overnight admissions per year", fmt.int(p0.electivePerYear), fmt.int(pA.electivePerYear)],
    ["Emergency patients going home same day", fmt.pct(p0.sameDayFrac, 0), fmt.pct(pA.sameDayFrac, 0)],
    ["Mean acute stay, overnight emergency patients (days)", meanLos(p0).toFixed(2), meanLos(pA).toFixed(2)],
    ["Mean delay (days)", p0.delayMeanDays.toFixed(2), pA.delayMeanDays.toFixed(2)],
    ["Ward round to discharge (hours)", p0.prepHours.toFixed(1), pA.prepHours.toFixed(1)],
    ...demandRows(),
    ["Weekend discharging", `${p0.weekendDischargePct}%`, `${pA.weekendDischargePct}%`],
    ["Emergency admissions with flu per year", fmt.int(p0.fluPerYear), fmt.int(pA.fluPerYear)],
  ];
  // age mix
  const ageRows = base.ageBands.map((b) => {
    const p = populationFor(base, b, settings.popYear), p0b = populationFor(base, b, base.baseYear);
    return `<tr><td>${b.band}</td><td class="num">${fmt.k(p0b)}</td><td class="num">${fmt.k(p)}</td><td class="num">${fmt.int(b.emergAdm)}</td><td class="num">${fmt.int(b.emergAdm * p / p0b)}</td></tr>`;
  }).join("");
  $("inputsTable").innerHTML =
    `<table><thead><tr><th>Input</th><th class="num">${BY} baseline</th><th class="num">This scenario</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td></tr>`).join("") +
    `</tbody></table><h4 style="margin:14px 0 4px">Population and emergency admissions by age</h4>
    <table><thead><tr><th>Age</th><th class="num">Population ${base.baseYear}</th><th class="num">Population ${settings.popYear}</th><th class="num">Emergency admissions ${base.baseYear}</th><th class="num">Scenario (population change only)</th></tr></thead><tbody>${ageRows}</tbody></table>`;
}

function demandRows() {
  const d = demandBreakdown(base, settings), x = (m) => (m >= 1 ? "+" : "−") + Math.abs(100 * (m - 1)).toFixed(1) + "%";
  return [
    ["Demand effect: population size & age", "", x(d.population)],
    ...(base.riskFactors || []).map((r) => [`Demand effect: ${r.label.toLowerCase()}`, "", x(d.risk[r.key])]),
    ...(base.deprivation ? [["Demand effect: deprivation gap", "", x(d.deprivation)]] : []),
    ...(base.flu ? [["Flu admissions: vaccination effect", "", x(d.fluVaccine)], ["Flu admissions: season severity", "", x(d.fluSeverity)]] : []),
    ["Demand effect: other", "", x(d.other)],
  ];
}

async function runSweep() {
  const btn = $("sweepBtn");
  btn.disabled = true;
  const beds = [];
  const cur = settings.beds;
  for (let b = Math.max(80000, Math.round(cur * 0.85 / 1000) * 1000); b <= Math.min(170000, cur * 1.45); b += 3000) beds.push(b);
  const pA = buildParams(base, { ...settings, flexibility: "A" });
  const pB = buildParams(base, { ...settings, flexibility: "B" });
  btn.textContent = "Running…";
  const [a, b] = await Promise.all([
    call("sweep", pA, 16, { sweep: { beds } }, (f) => { btn.textContent = `Running… ${Math.round(f * 100)}%`; }),
    call("sweep", pB, 3, { sweep: { beds } }),
  ]);
  btn.textContent = "Run bed-number sweep";
  btn.disabled = false;
  $("sweepCharts").hidden = false;
  chartDefaults();
  sweepCharts.forEach((c) => c.destroy());
  const mk = (canvas, key, scale, ytitle, tip) => new Chart(canvas, {
    type: "line",
    data: { labels: beds.map((x) => fmt.k(x)), datasets: [
      { label: "Today's system", data: a.map((p) => scale(p[key])), borderColor: css("--series-scn"), borderWidth: 2, pointRadius: 3 },
      { label: "More flexible system", data: b.map((p) => scale(p[key])), borderColor: css("--series-b"), borderWidth: 2, pointRadius: 3, borderDash: [5, 3] },
    ] },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => `${beds[c[0].dataIndex].toLocaleString("en-GB")} beds`, label: tip } } },
      scales: { x: { title: { display: true, text: "G&A beds" }, grid: { display: false } }, y: { title: { display: true, text: ytitle }, beginAtZero: key !== "occ" } } },
  });
  sweepCharts = [
    mk($("sweepOcc"), "occ", (x) => 100 * x, "Average occupancy (%)", (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%`),
    mk($("sweepWait"), "wait12PerYear", (x) => x / 1000, ">12h waits for a bed (thousands/yr)", (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(0)}k a year`),
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
  BY = base.baseYearLabel || String(base.baseYear);
  document.querySelectorAll(".by").forEach((e) => (e.textContent = BY));
  settings = defaultSettings(base);
  readHash();
  buildControls();
  $("reset").onclick = () => { settings = defaultSettings(base); syncControls(); schedule(); };
  $("share").onclick = async () => { writeHash(); try { await navigator.clipboard.writeText(location.href); $("share").textContent = "Link copied"; } catch { $("share").textContent = "Copy the address bar"; } setTimeout(() => ($("share").textContent = "Copy link to this scenario"), 2000); };
  $("download").onclick = () => {
    const blob = new Blob([JSON.stringify({ settings, params: buildParams(base, { ...settings, flexibility: "A" }), todaysSystem: { ...resultA, daily: undefined }, flexibleSystem: { ...resultB, daily: undefined }, baseline: { ...baselineA, daily: undefined } }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "bed-scenario.json"; a.click();
  };
  $("sweepBtn").onclick = runSweep;
  $("status").textContent = `Simulating the ${BY} baseline…`;
  const d = defaultSettings(base);
  [baselineA, baselineB] = await Promise.all([
    call("run", buildParams(base, { ...d, flexibility: "A" }), REPS_A),
    call("run", buildParams(base, { ...d, flexibility: "B" }), REPS_B),
  ]);
  await runScenario();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { dailyChart && dailyChart.destroy(); dailyChart = null; renderDaily(); });
}
main().catch((e) => { $("status").textContent = "Error: " + e.message; console.error(e); });
