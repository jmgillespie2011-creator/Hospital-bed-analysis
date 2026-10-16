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
    const g0 = (y.grid || []).find((g) => g.delayChangePct === 0 && g.corridorPct === fc.corridorToday) || (y.grid || [])[0];
    if (g0) fill("flexToday", pct(g0.wait12, 1));
  }
  const lsT = tf?.models?.["all together"]?.terms?.["post:long_stay_z"];
  if (lsT) fill("flexLS", `+${lsT.pct.toFixed(0)}% (95% CI +${lsT.lo.toFixed(0)}% to +${lsT.hi.toFixed(0)}%)`);
  const fmtEff = (t) => `${t.pct >= 0 ? "+" : "−"}${Math.abs(t.pct).toFixed(0)}%, p = ${t.p.toFixed(2)}`;
  const mName = (pre) => tf && Object.keys(tf.models).find((k) => k.startsWith(pre));
  const plT = tf?.models?.[mName("placebo")]?.terms?.["post:long_stay_z"], nbT = tf?.models?.[mName("robustness: without")]?.terms?.["post:long_stay_z"];
  if (plT) fill("lsPlacebo", fmtEff(plT));
  if (nbT) fill("lsNoBig", fmtEff(nbT));
  const ck = await fetch("data/clock_test.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (ck) {
    const y = ck.years.find((x) => x.fy === "2018/19");
    if (y) { fill("clkArr0", Math.round(y.arrival_over12).toLocaleString("en-GB")); fill("clkDta0", Math.round(y.dta_over12).toLocaleString("en-GB")); }
    if (ck.rise_from_arrival) { fill("clkRiseA", ck.rise_from_arrival.toFixed(0)); fill("clkRiseD", (10 * Math.round(ck.rise_from_decision / 10)).toFixed(0)); }
  }
  const [lt, lm] = await Promise.all(["data/longstay_tests.json", "data/longstay_mechanism.json"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  if (lt) {
    const e = (t, d = 0) => `${t.pct >= 0 ? "+" : "−"}${Math.abs(t.pct).toFixed(d)}% per SD, p ${t.p < 0.001 ? "&lt; 0.001" : "= " + t.p.toFixed(t.p < 0.05 ? 3 : 2)}`;
    fill("lsPreMean", pct(lt.B_descriptive.mean_before, 0));
    fill("lsPostMean", pct(lt.B_descriptive.mean_after, 0));
    fill("lsB1", e(lt.B1.terms.ls_pre_z));
    fill("lsB2pre", e(lt.B2.terms["post:ls_pre_z"]));
    fill("lsB2rise", e(lt.B2.terms["post:ls_rise_z"]));
    fill("lsNctr", e(lt.C2.terms["post:nctr_z"]));
    fill("lsRegion", e(lt.C4.terms["post:long_stay_z"]));
    const a1 = lt.A1.terms.ls_c, a5 = lt.A5.terms.ls_pts_lag1;
    fill("lsMonth", `${a1.pct >= 0 ? "+" : "−"}${Math.abs(a1.pct).toFixed(1)}%`);
    fill("lsLag", `${a5.pct >= 0 ? "+" : "−"}${Math.abs(a5.pct).toFixed(1)}%, p = ${a5.p.toFixed(2)}`);
  }
  if (lm) {
    const full = lm.calibration.find((c) => c.outlying === 1);
    const at = (lf) => lm.rows.find((r) => r.outlying === lm.outlyingToday && r.longFrac === lf && !r.clustered);
    const lo = at(0.025), hi = at(0.045);
    fill("lsMechFull", `${pct(full.wait12, 2)} of emergency admissions`);
    fill("lsMechLo", `${pct(lo.longShare, 0)} to ${pct(hi.longShare, 0)} of beds only moves waits from ${pct(lo.wait12, 1)} to ${pct(hi.wait12, 1)}`);
  }
  Chart.defaults.color = css("--text-2");
  Chart.defaults.borderColor = css("--grid");
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  const BLUE = css("--series-scn"), ORANGE = css("--series-b"), GREY = css("--series-base");
  const BY = sc.baseYear;
  fill("baseYear", BY);
  if (base.calibration?.B) { fill("poolB", Math.round(base.calibration.B.poolSize)); fill("poolA", Math.round(base.calibration.A.poolSize)); }
  if (base.calibration?.flexibleFit) fill("flexTarget", pct(base.calibration.flexibleFit.target, 1));
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

  // ---------------------------------------------------------------- 1b. beds per person, and how hospital use changed
  const [TR, PH] = await Promise.all(["data/blog_trends.json", "data/beds_per_head.json"].map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  if (TR) {
    const Y = TR.years.filter((y) => y.occupied_per1000 != null && y.fy >= "2010/11");
    const y0 = Y[0], yN = Y.at(-1);
    const bedsCh = yN.perThousand / y0.perThousand - 1, useCh = yN.occupied_per1000 / y0.occupied_per1000 - 1;
    const occNoCut = y0.occupancy * (1 + useCh); // beds per person held at the first year's level
    $("perHeadStats").innerHTML =
      stat("Beds per 1,000 people", yN.perThousand.toFixed(2), `${signed(100 * bedsCh, (v) => v.toFixed(0) + "%")} since ${y0.fy} (${y0.perThousand.toFixed(2)})`) +
      stat("Beds in use per 1,000 people", yN.occupied_per1000.toFixed(2), `${signed(100 * useCh, (v) => v.toFixed(0) + "%")} since ${y0.fy} (${y0.occupied_per1000.toFixed(2)})`) +
      stat("Occupancy", pct(yN.occupancy), `${pct(y0.occupancy)} in ${y0.fy}`) +
      stat("Occupancy if beds had kept pace", pct(occNoCut, 0), "today's use per person, " + y0.fy + " beds per person");
    legend("lPerHead", [["Beds open", BLUE], ["Beds in use", ORANGE]]);
    new Chart($("cPerHead"), { type: "line", data: { labels: Y.map((y) => y.fy), datasets: [
      { label: "Beds open per 1,000 people", data: Y.map((y) => y.perThousand), borderColor: BLUE, borderWidth: 2, pointRadius: 3, pointBackgroundColor: BLUE },
      { label: "Beds in use per 1,000 people", data: Y.map((y) => y.occupied_per1000), borderColor: ORANGE, borderWidth: 2, pointRadius: 3, pointBackgroundColor: ORANGE }] },
      options: lineOpts("Per 1,000 people", { scales: { x: { grid: { display: false } }, y: { min: 1.2, title: { display: true, text: "Per 1,000 people" } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}` } } } }) });
    $("tPerHead").innerHTML = table(["Year", "Beds open per 1,000", "Beds in use per 1,000", "Occupancy"],
      Y.map((y) => [y.fy, y.perThousand.toFixed(3), y.occupied_per1000.toFixed(3), pct(y.occupancy)]), [1, 2, 3]);
    const y19 = Y.find((y) => y.fy === "2019/20");
    $("perHeadText").innerHTML = `Between ${y0.fy} and ${yN.fy}, beds per person fell ${pct(-bedsCh, 0)}. On its own, that would have
      pushed occupancy above 100%. It did not, because hospitals also used ${pct(-useCh, 0)} fewer beds per person, mainly through shorter stays per admission and more patients going home the same day.
      Had beds kept pace with the population, today's use per person would fill only about <b>${pct(occNoCut, 0)}</b> of them. Instead it fills
      <b>${pct(yN.occupancy)}</b>. So the cut in beds per person is why hospitals now run so full; the fall in use per person is why they are not
      fuller still. Most of the cut happened before ${y19 ? "2019/20" : "the pandemic"}: since then beds per person have fallen only from
      ${y19 ? y19.perThousand.toFixed(2) : ""} to ${yN.perThousand.toFixed(2)}. That is why the cuts cannot explain the sudden rise in long waits
      after 2020, but they explain why hospitals were so exposed to it.`;
    const H = TR.years.filter((y) => y.em_bd_per_adm != null);
    const lineOne = (id, tid, rows, f, yTitle, fmt, extra = {}) => {
      new Chart($(id), { type: "line", data: { labels: rows.map((r) => r.fy), datasets: [{ data: rows.map(f), borderColor: BLUE, borderWidth: 2, pointRadius: 3, pointBackgroundColor: BLUE }] },
        options: lineOpts(yTitle, { scales: { x: { grid: { display: false } }, y: { title: { display: true, text: yTitle }, ...extra } },
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt(c.parsed.y) } } } }) });
      $(tid).innerHTML = table(["Year", yTitle], rows.map((r) => [r.fy, fmt(f(r))]), [1]);
    };
    const nights = (v) => (v == null ? "" : v.toFixed(2) + " nights");
    const HO = H.filter((r) => r.hf_em_los != null), HF = TR.healthFoundation || [];
    const hfAt = (k) => HO.map((r) => { const h = HF.find((x) => x.fy === r.fy); return h ? h[k] : null; });
    legend("lLos", [["Emergency", BLUE], ["Planned", GREY], ["All overnight admissions", ORANGE]]);
    new Chart($("cLos"), { type: "line", data: { labels: HO.map((r) => r.fy), datasets: [
      { label: "Emergency", data: HO.map((r) => r.hf_em_los), borderColor: BLUE, borderWidth: 2, pointRadius: 3, pointBackgroundColor: BLUE },
      { label: "Planned", data: HO.map((r) => r.hf_el_los), borderColor: GREY, borderWidth: 2, pointRadius: 3, pointBackgroundColor: GREY },
      { label: "All overnight admissions", data: HO.map((r) => r.bd_per_overnight), borderColor: ORANGE, borderWidth: 2, pointRadius: 3, pointBackgroundColor: ORANGE },
      ...[["emergency", BLUE], ["elective", GREY], ["all", ORANGE]].map(([k, c]) => ({ label: `Health Foundation (${k === "elective" ? "planned" : k})`, data: hfAt(k),
        showLine: false, pointStyle: "rectRot", pointRadius: 7, pointBackgroundColor: "transparent", pointBorderColor: c, borderColor: c, pointBorderWidth: 2 }))] },
      options: lineOpts("Nights per overnight admission", { interaction: { mode: "index", intersect: false }, scales: { x: { grid: { display: false } }, y: { min: 0, title: { display: true, text: "Nights per overnight admission" } } },
        plugins: { legend: { display: false }, tooltip: { filter: (c) => c.parsed.y != null, callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}` } } } }) });
    $("tLos").innerHTML = table(["Year", "Emergency", "Planned", "All overnight admissions", "Emergency, all diagnoses (bed days split by admissions)"],
      HO.map((r) => [r.fy, nights(r.hf_em_los), nights(r.hf_el_los), nights(r.bd_per_overnight), nights(r.em_bd_per_overnight)]), [1, 2, 3, 4]) +
      `<p class="cap">Health Foundation (adults, patient-level HES): ${HF.map((h) => `${h.year}: emergency ${h.emergency}, planned ${h.elective}, all ${h.all} days`).join("; ")}.</p>`;
    lineOne("cEmerg", "tEmerg", TR.years.filter((y) => y.hes_emergency_per1000 != null), (r) => r.hes_emergency_per1000, "Per 1,000 people", (v) => v.toFixed(1) + " per 1,000", { min: 0 });
    lineOne("cSame", "tSame", H.filter((r) => r.em_same_day_share != null), (r) => 100 * r.em_same_day_share, "% of emergency admissions", (v) => v.toFixed(1) + "%", { min: 0 });
    lineOne("cAge", "tAge", H, (r) => 100 * r.share75_emergency, "% of emergency admissions", (v) => v.toFixed(1) + "%", { min: 0 });
    lineOne("cEbd", "tEbd", H.filter((r) => r.em_bed_days_per1000 != null), (r) => r.em_bed_days_per1000, "Bed days per 1,000 people", (v) => Math.round(v) + " per 1,000", { min: 0 });
    {
      const f = (fy) => H.find((r) => r.fy === fy), h0 = H[0], h19 = f("2019/20"), hN = H.at(-1), z0 = H.find((r) => r.em_same_day_share != null);
      const ch = (a, b) => pct(b / a - 1, 0);
      if (h19) {
        const h22 = f("2022/23");
        fill("hfEm19", nights(h19.hf_em_los)); fill("hfEm22", nights(h22.hf_em_los)); fill("hfAll19", nights(h19.bd_per_overnight));
        fill("hfAll22", nights(h22.bd_per_overnight)); fill("hfEl19", nights(h19.hf_el_los));
        $("trendsText").innerHTML = `All of these are counted per admission (one per hospital stay), not per consultant episode, using the
          Health Foundation's definitions. Before the pandemic, emergency patients who stayed overnight stayed about as long each year
          (${z0.hf_em_los.toFixed(1)} nights in ${z0.fy}, ${h19.hf_em_los.toFixed(1)} in ${h19.fy}), while more emergency patients went home the
          same day (${pct(z0.em_same_day_share, 0)} of emergency admissions in ${z0.fy}, ${pct(h19.em_same_day_share, 0)} in ${h19.fy}). So nights per
          emergency admission fell, and hospitals absorbed rising admissions. After the pandemic, overnight emergency stays jumped:
          ${h22.hf_em_los.toFixed(1)} nights in ${h22.fy}, ${ch(h19.hf_em_los, h22.hf_em_los)} more than in ${h19.fy} (the Health Foundation found 15%), and
          ${hN.hf_em_los.toFixed(1)} in ${hN.fy}. Nights spent in hospital after an emergency admission, per person, are now higher than in ${h0.fy}
          (${Math.round(hN.em_bed_days_per1000)} against ${Math.round(h0.em_bed_days_per1000)} per 1,000 people). The share of beds held by people in hospital for
          three weeks or more has also crept up.`;
      }
    }
    const LS = TR.longStays;
    legend("lLong", [["In hospital over 7 days", BLUE], ["Over 21 days", ORANGE]]);
    new Chart($("cLong"), { type: "bar", data: { labels: LS.map((r) => r.winter), datasets: [
      { label: "Over 7 days", data: LS.map((r) => 100 * r.share7), backgroundColor: BLUE, borderRadius: 4, borderSkipped: false },
      { label: "Over 21 days", data: LS.map((r) => 100 * r.share21), backgroundColor: ORANGE, borderRadius: 4, borderSkipped: false }] },
      options: lineOpts("% of occupied beds", { interaction: { mode: "index", intersect: false }, scales: { x: { grid: { display: false } }, y: { min: 0, title: { display: true, text: "% of occupied beds" } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } } }) });
    $("tLong").innerHTML = table(["Winter", "Over 7 days", "Over 21 days", "Occupied beds"], LS.map((r) => [r.winter, pct(r.share7), pct(r.share21), int(r.occupied)]), [1, 2, 3]);
  }
  if (PH) {
    const R = PH.rows.filter((r) => r.kind === "per head").sort((a, b) => a.beds - b.beds);
    legend("lPh", [["Today's system", BLUE], ["Pre-pandemic flexibility", ORANGE]]);
    new Chart($("cPh"), { type: "bar", data: { labels: R.map((r) => [`${k(r.beds)} beds`, r.label === PH.baseYear ? "today" : `as ${r.label}`]), datasets: [
      { label: "Today's system", data: R.map((r) => r.A.wait12PerYear / 1000), backgroundColor: BLUE, borderRadius: 4, borderSkipped: false },
      { label: "Pre-pandemic flexibility", data: R.map((r) => r.B.wait12PerYear / 1000), backgroundColor: ORANGE, borderRadius: 4, borderSkipped: false }] },
      options: lineOpts("Thousands a year", { interaction: { mode: "index", intersect: false }, scales: { x: { grid: { display: false } }, y: { min: 0, title: { display: true, text: "Waits over 12 hours, thousands a year" } } },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${int(1000 * c.parsed.y)} a year` } } } }) });
    $("tPh").innerHTML = table(["Beds per person as in", "Beds", "Extra beds", "Occupancy", "Over 12h (today's system)", "Over 12h (pre-pandemic flexibility)"],
      R.map((r) => [r.label === PH.baseYear ? `${r.label} (today)` : r.label, int(r.beds), r.extraBeds ? signed(r.extraBeds, int) : "", pct(r.A.occupancy),
        `${pct(r.A.wait12)} (${int(r.A.wait12PerYear)})`, `${pct(r.B.wait12)} (${int(r.B.wait12PerYear)})`]), [1, 2, 3, 4, 5]);
    const now = R.find((r) => r.label === PH.baseYear), r10 = R.find((r) => r.label === "2010/11"), r15 = R.find((r) => r.label === "2015/16");
    const age = PH.rows.find((r) => r.kind !== "per head");
    const r1k = (x) => int(1000 * Math.round(x / 1000));
    if (now && r10 && r15) $("phText").innerHTML = `If beds had kept pace with the population since 2010/11, England would have about
      <b>${r1k(r10.beds)}</b> G&amp;A beds, about ${r1k(r10.extraBeds)} more than today. With today's patients the simulator puts them at about
      ${pct(r10.A.occupancy, 0)} occupancy (a little above the 78% from the arithmetic above, because patients now waiting in corridors and A&amp;E
      would be in beds), and 12-hour waits fall from about ${r1k(now.A.wait12PerYear)} a year to about
      <b>${r1k(r10.A.wait12PerYear)}</b>, around ${pct(1 - r10.A.wait12PerYear / now.A.wait12PerYear, 0)} fewer. Matching 2015/16 instead (about ${r1k(r15.extraBeds)} more beds) cuts them by
      ${pct(1 - r15.A.wait12PerYear / now.A.wait12PerYear, 0)}.
      ${age ? `Allowing for the older population changes little: matching 2010/11 per unit of age-adjusted demand needs about ${r1k(age.beds)} beds.` : ""}
      For comparison, restoring pre-pandemic flexibility with today's beds cuts them to about ${r1k(now.B.wait12PerYear)}. Both matter, and on
      a similar scale. These runs hold admissions fixed, so they leave out patients who would be admitted only if a bed were free, and they assume the
      extra beds are fully staffed.`;
  }

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

  // ---------------------------------------------------------------- 3. who is to blame (scripts/hypotheses_*.{py,mjs})
  const [HM, HD, HT] = await Promise.all(["data/hypotheses_model.json", "data/hypotheses_data.json", "data/hypotheses_tests.json"]
    .map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  if (HM && HD) renderBlame(HM, HD, HT, { BLUE, ORANGE, GREY, TEAL: css("--series-c"), PURPLE: css("--series-d"), BY });
}

function renderBlame(HM, HD, HT, C) {
  const pp = (x, d = 1) => signed(100 * x, (v) => v.toFixed(d)) + " pts";
  const ap = (x, d = 1) => Math.abs(100 * x).toFixed(d) + " points";             // unsigned, for sentences
  const r1k = (x) => int(1000 * Math.round(Math.abs(x) / 1000));
  const r100 = (x) => int(100 * Math.round(Math.abs(x) / 100));
  const kk = (x) => signed(x / 1000, (v) => v.toFixed(0) + "k");
  const HYP = { "Social care": C.ORANGE, "Community health services": C.TEAL, "General practice": C.PURPLE, "Hospital flow and management": C.BLUE,
    "All discharge delays": C.GREY, Beds: C.GREY };
  const hbar = (xTitle, fmt, extra = {}) => ({ indexAxis: "y", responsive: true, maintainAspectRatio: false, animation: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { title: (c) => c[0].label.replaceAll(",", " "), label: (c) => fmt(c.parsed.x, c) } } },
    scales: { x: { title: { display: true, text: xTitle }, ticks: { maxRotation: 0, maxTicksLimit: 7 }, grid: { color: (c) => (c.tick.value === 0 ? css("--text-3") : css("--grid")) } },
      y: { grid: { display: false }, ticks: { autoSkip: false } } }, ...extra });
  fill("hmFrom", HM.from);

  // what changed
  const S = HM.shapley, tot = HM.end.wait12 - HM.start.wait12, sh = (id) => S.find((x) => x.id === id);
  new Chart($("cDecomp"), { type: "bar", data: { labels: S.map((x) => wrap(x.label, 30)), datasets: [{ data: S.map((x) => 100 * x.wait12),
    backgroundColor: S.map((x) => (x.id === "flex" ? C.BLUE : x.wait12 > 0 ? C.ORANGE : C.GREY)), borderRadius: 4, borderSkipped: false, barPercentage: 0.8 }] },
    options: hbar("Change in share waiting over 12 hours, percentage points", (v) => signed(v, (z) => z.toFixed(2)) + " pts") });
  $("tDecomp").innerHTML = table(["Change", "Occupancy", "12-hour waits (share)", "12-hour waits a year"],
    [...S.map((x) => [esc(x.label), pp(x.occupancy), pp(x.wait12, 2), kk(x.wait12PerYear)]),
      ["<b>Total</b>", pp(HM.end.occupancy - HM.start.occupancy), pp(tot, 2), kk(HM.end.wait12PerYear - HM.start.wait12PerYear)]], [1, 2, 3]);
  const flowNet = ["demand", "beds", "stays", "sameDay"].reduce((a, id) => a + sh(id).wait12, 0);
  $("decompText").innerHTML = `In the simulator, 12-hour waits rose from ${pct(HM.start.wait12)} of emergency admissions in ${HM.from} to
    ${pct(HM.end.wait12)} today. Longer stays for patients admitted overnight pushed them up by ${ap(sh("stays").wait12)}, but more patients going home the
    same day pulled them down by almost as much (${ap(sh("sameDay").wait12)}). More patients added ${ap(sh("demand").wait12)}; slightly more beds took off
    ${ap(sh("beds").wait12)}. Together, the four changes in patients and beds add only ${ap(flowNet)}. The rest, <b>${ap(sh("flex").wait12)}, or
    ${pct(sh("flex").wait12 / tot, 0)} of the rise</b>, comes from beds being used less flexibly: the same occupancy now produces far longer waits.
    Flexibility is not measured directly. It is what the simulator needs, once patients and beds are accounted for, to match each year's waits,
    so it stands for everything else that changed. That is where the three explanations have to be tested.`;

  // social care
  const R = HD.delays.reasons["7+"], G = R.byGroup, gk = R.byGroupKind;
  fill("drMonths", `${R.months[0]} to ${R.months[1]}`);
  const nctr = HD.delays.nctrMonthly.slice(-12), nctrMean = nctr.reduce((a, r) => a + r.value, 0) / nctr.length;
  const dtoc = HD.dtocResp, d0 = dtoc[dtoc.length - 1];
  $("scText1").innerHTML = `On an average day, about ${int(100 * Math.round(nctrMean / 100))} patients in England's acute hospitals no longer need to be there but have not
    left (acute discharge sitrep, last 12 months). That is about one bed in seven. The common story is that they are waiting for social care. Since
    2024 NHS England has published the reason for every patient delayed a week or more. Social care, meaning a care home place, home care or
    restarting a care package, accounts for <b>${pct(G["Social care"], 0)}</b> of them. NHS community services (rehabilitation, reablement,
    community beds, end-of-life care) account for <b>${pct(G["Community health services"], 0)}</b>, and the hospital's own processes for
    <b>${pct(G["Hospital processes"], 0)}</b>.`;
  const order = Object.keys(gk).sort((a, b) => (G[b] || 0) - (G[a] || 0));
  const kinds = [["Service not available", C.ORANGE], ["Arrangements under way", C.BLUE], ["Other", C.GREY]];
  legend("lDelay", kinds.map(([k2, c]) => [k2 === "Other" ? "Hospital, family or legal reasons" : k2, c]));
  new Chart($("cDelay"), { type: "bar", data: { labels: order.map((g) => wrap(g, 28)), datasets: kinds.map(([k2, c]) => ({ label: k2, data: order.map((g) => 100 * (gk[g][k2] || 0)),
    backgroundColor: c, borderRadius: 4, borderSkipped: false, barPercentage: 0.8 })) },
    options: { ...hbar("% of patients delayed 7+ days", (v, c) => `${c.dataset.label}: ${v.toFixed(1)}%`),
      scales: { x: { stacked: true, title: { display: true, text: "% of patients delayed 7+ days" }, grid: { color: css("--grid") } }, y: { stacked: true, grid: { display: false }, ticks: { autoSkip: false } } } } });
  $("tDelay").innerHTML = table(["Reason", "Who has to act", "Patients (average)", "Share"], R.rows.map((r) => [esc(r.metric), esc(r.group), int(r.value), pct(r.share)]), [2, 3]);
  $("scText2").innerHTML = `So social care is a real part of the problem but not most of it: the NHS's own community services hold up more patients,
    and hospitals' internal processes (waiting for a discharge decision, medicines, letters, a therapy review or transport) almost as many.
    ${dtoc.length ? `The older measure, delayed transfers of care (${dtoc[0].fy} to ${d0.fy}), told a similar story: delays attributed to the NHS were
    ${pct(d0.nhs / d0.total, 0)} of the total in ${d0.fy}, social care ${pct(d0.social_care / d0.total, 0)} and both ${pct(d0.both / d0.total, 0)}.` : ""}`;
  const sc1 = HM.scenarios.find((x) => x.id === "socialCare"), sc2 = HM.scenarios.find((x) => x.id === "socialJoint");
  const T = HT && HT.trustDelays;
  const AS = HT && HT.areaSocial, asr = (o, e, fe) => AS && AS.rows.find((r) => r.outcome === o && r.exposure === e && r.design.startsWith(fe ? "within" : "between"));
  const fyr = (y) => { const [a, b] = y.split("-").map(Number); return `${a}/${String(a + 1).slice(2)} to ${b}/${String(b + 1).slice(2)}`; };
  const fs = (r) => `${signed(r.pct, (v) => v.toFixed(0))}% (95% interval ${signed(r.lo, (v) => v.toFixed(0))}% to ${signed(r.hi, (v) => v.toFixed(0))}%)`;
  const s1 = asr("dtoc_sc", "spend", false), s2 = asr("dtoc_sc", "care_home_beds", false), s3 = asr("dtoc_sc", "care_home_beds", true);
  const asText = s1 && s2 ? `Nor do councils' social care resources predict social care delays. Across ${s1.areas} councils (${fyr(s1.years)}), each extra
    £100 a year of adult social care spending per adult went with ${fs(s1)} delayed transfers attributable to social care, after allowing
    for deprivation, and each extra care home bed per 100 people aged 75+ with ${fs(s2)}${s3 ? `; within councils over time, ${fs(s3)}` : ""}. Councils
    with more need spend more, so spending cannot be read as a cause, but there is no sign in these data that places with more social care
    have fewer delays.` : "";
  if (T) {
    fill("tdN", `${T.trusts} acute trusts, ${T.months[0]} to ${T.months[1]}`);
    const lab = { sc: "Social care", ch: "Community health services", hp: "Hospital processes", jt: "Care transfer hubs and other joint processes" };
    const ks = ["sc", "ch", "hp", "jt"], col = { sc: C.ORANGE, ch: C.TEAL, hp: C.BLUE, jt: C.GREY };
    legend("lTd", [["Estimate", C.GREY], ["95% confidence interval", C.GREY, true]]);
    const W = T.withinBeyondOcc;
    new Chart($("cTd"), { type: "bar", data: { labels: ks.map((x2) => wrap(lab[x2], 28)), datasets: [
      { label: "95% interval", data: ks.map((x2) => [W[x2].lo, W[x2].hi]), backgroundColor: ks.map((x2) => col[x2] + "55"), borderColor: ks.map((x2) => col[x2]), borderWidth: 1, borderSkipped: false, barPercentage: 0.5, grouped: false },
      { label: "Estimate", data: ks.map((x2) => W[x2].est), type: "scatter", pointStyle: "rectRot", pointRadius: 7, backgroundColor: ks.map((x2) => col[x2]), borderColor: css("--surface"), borderWidth: 2 }] },
      options: hbar("% change in 12-hour waits per extra delayed patient per 100 beds", (v, c) => (Array.isArray(c.raw) ? `95% interval ${c.raw[0].toFixed(1)}% to ${c.raw[1].toFixed(1)}%` : `${v.toFixed(1)}%`)) });
    $("tTd").innerHTML = table(["Delays for", "Within trusts, beyond occupancy", "Within trusts, total", "Between trusts, beyond occupancy", "Average per 100 beds"],
      ks.map((x2) => { const f = (o) => (o && o[x2] ? `${signed(o[x2].est, (v) => v.toFixed(1))}% (${o[x2].lo.toFixed(1)} to ${o[x2].hi.toFixed(1)}), p=${o[x2].p.toFixed(3)}` : ""); return [lab[x2], f(T.withinBeyondOcc), f(T.withinTotal), f(T.betweenBeyondOcc), T.meanPer100[x2].toFixed(2)]; }), [1, 2, 3, 4]);
    const sig = (o) => o.p < 0.05;
    $("scText3").innerHTML = `If social care delays drove long waits, months in which a hospital had more patients stuck waiting for social care should
      also be months with more 12-hour waits. They are not: ${signed(W.sc.est, (v) => v.toFixed(1))}% per extra delayed patient per 100 beds (95% interval
      ${signed(W.sc.lo, (v) => v.toFixed(1))}% to ${signed(W.sc.hi, (v) => v.toFixed(1))}%). Delays from <b>hospital processes</b> do track waits: ${W.hp.est.toFixed(1)}% more per extra patient
      per 100 beds${sig(W.hp) ? " (statistically clear)" : ""}, and delays for NHS community services ${W.ch.est.toFixed(1)}%${sig(W.ch) ? " (just significant)" : ""}. Between trusts
      the pattern is similar: hospitals with more process delays have ${T.betweenBeyondOcc.hp.est.toFixed(0)}% more 12-hour waits per extra patient per 100 beds
      at the same occupancy (p ${T.betweenBeyondOcc.hp.p < 0.001 ? "< 0.001" : "= " + T.betweenBeyondOcc.hp.p.toFixed(3)}), against ${T.betweenBeyondOcc.sc.est.toFixed(0)}% for social care delays
      (p = ${T.betweenBeyondOcc.sc.p.toFixed(2)}). This is an association: a hospital under
      pressure may also be slower to process discharges. In the simulator, removing every delay caused by social care would free about
      ${r100(sc1.dBeds)} beds and cut 12-hour waits by about ${r1k(sc1.dWait12PerYear)} a year; adding the joint care-transfer-hub delays, about ${r100(sc2.dBeds)} beds
      and ${r1k(sc2.dWait12PerYear)}. That is worth having, but it would not undo the rise since ${HM.from}. ${asText}`;
  }

  // general practice
  const D = HD.demand, dmB = D.find((r) => r.fy === "2011/12") || D[0], d19 = D.find((r) => r.fy === "2019/20"), dN = D[D.length - 1];
  fill("dmBase", dmB.fy);
  const idx = (r, k2) => 100 * r[k2] / dmB[k2];
  legend("lDemand", [["All A&E attendances", C.PURPLE], ["Major (type 1) A&E attendances", C.PURPLE, true], ["Emergency admissions", C.BLUE]]);
  new Chart($("cDemand"), { type: "line", data: { labels: D.map((r) => r.fy), datasets: [
    { label: "All A&E attendances", data: D.map((r) => idx(r, "attend_all_per1000")), borderColor: C.PURPLE, borderWidth: 2, pointRadius: 3, pointBackgroundColor: C.PURPLE },
    { label: "Major A&E attendances", data: D.map((r) => idx(r, "attend_type1_per1000")), borderColor: C.PURPLE, borderDash: [5, 4], borderWidth: 2, pointRadius: 2, pointBackgroundColor: C.PURPLE },
    { label: "Emergency admissions", data: D.map((r) => idx(r, "adm_emergency_per1000")), borderColor: C.BLUE, borderWidth: 2, pointRadius: 3, pointBackgroundColor: C.BLUE }] },
    options: lineOpts("Index", { scales: { x: { grid: { display: false } }, y: { title: { display: true, text: `Per person, ${dmB.fy} = 100` } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}` } } } }) });
  $("tDemand").innerHTML = table(["Year", "A&E attendances per 1,000", "Major A&E per 1,000", "Emergency admissions per 1,000", "Major A&E attendances admitted"],
    D.map((r) => [r.fy, r.attend_all_per1000.toFixed(0), r.attend_type1_per1000.toFixed(0), r.adm_emergency_per1000.toFixed(1), pct(r.type1_conversion)]), [1, 2, 3, 4]);
  const AC = HD.acsc, a0 = AC[0], aN = AC[AC.length - 1], a19 = AC.find((r) => r.fy === "2019/20"), aL = AC.filter((r) => r.acsc_per1000 != null).at(-1);
  legend("lAcsc", [["Share of emergency admissions", C.PURPLE], ["Share of emergency bed days", C.PURPLE, true]]);
  new Chart($("cAcsc"), { type: "line", data: { labels: AC.map((r) => r.fy), datasets: [
    { label: "Admissions", data: AC.map((r) => 100 * r.acsc_share_adm), borderColor: C.PURPLE, borderWidth: 2, pointRadius: 3, pointBackgroundColor: C.PURPLE },
    { label: "Bed days", data: AC.map((r) => 100 * r.acsc_share_bd), borderColor: C.PURPLE, borderDash: [5, 4], borderWidth: 2, pointRadius: 2, pointBackgroundColor: C.PURPLE }] },
    options: lineOpts("%", { scales: { x: { grid: { display: false } }, y: { min: 0, title: { display: true, text: "% of emergency admissions / bed days" } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } } }) });
  $("tAcsc").innerHTML = table(["Year", "Emergency admissions for these conditions", "Share of emergency admissions", "Share of emergency bed days"],
    AC.map((r) => [r.fy, int(r.acsc_emergency), pct(r.acsc_share_adm), pct(r.acsc_share_bd)]), [1, 2, 3]);
  const GW = HD.gpWorkforce || [], gw0 = GW[0], gwN = GW[GW.length - 1];
  $("gpText1").innerHTML = `${gw0 ? `General practice is under real strain: there were ${gw0.per100k.toFixed(1)} fully qualified GPs (full-time equivalent)
    per 100,000 people in ${gw0.date} and ${gwN.per100k.toFixed(1)} in ${gwN.date}, ${pct(1 - gwN.per100k / gw0.per100k, 0)} fewer (NHS England Digital GP workforce). ` : ""}If patients who cannot see a GP were ending up in hospital, emergency admissions per person would be rising. Since
    ${d19.fy}, A&E attendances per person have risen ${pct(dN.attend_all_per1000 / d19.attend_all_per1000 - 1, 0)}, which fits pressure on general practice,
    but emergency admissions per person have <i>fallen</i> ${pct(1 - dN.adm_emergency_per1000 / d19.adm_emergency_per1000, 0)}: hospitals now admit
    ${pct(dN.type1_conversion)} of major A&amp;E attendances, against ${pct(d19.type1_conversion)} in ${d19.fy}. More people turn up at A&amp;E; it is not
    more of them filling beds. Conditions that good primary care can often keep out of hospital (asthma, COPD, diabetes, heart failure and
    others) are about ${pct(aN.acsc_share_adm, 0)} of emergency admissions and of emergency bed days, a share that has fallen since ${a0.fy} (${pct(a0.acsc_share_adm, 0)}). Per person, these admissions were
    ${a19.acsc_per1000.toFixed(1)} per 1,000 people in ${a19.fy} and ${aL.acsc_per1000.toFixed(1)} in ${aL.fy}: they have not grown.`;
  const ga = HM.scenarios.find((x) => x.id === "acscAll"), gq = HM.scenarios.find((x) => x.id === "acscQuarter");
  const AG = HT && HT.areaGp;
  const agr = (o, fe) => AG && AG.rows.find((r) => r.outcome === o && r.design.startsWith(fe ? "within" : "between"));
  const fx = (r) => `${signed(r.pct, (v) => v.toFixed(1))}% per point; 95% interval ${signed(r.lo, (v) => v.toFixed(1))}% to ${signed(r.hi, (v) => v.toFixed(1))}%`;
  const cb = agr("copd", false), cw = agr("copd", true), aw = agr("asthma", true);
  const agText = cb && cw ? `Comparing ${cb.areas} local NHS areas (${cb.years}): where patients rate their GP practice better (GP patient survey), emergency
    admissions for COPD are lower (${fx(cb)} of patients reporting a good experience). But that comparison cannot separate GP access from
    deprivation and other differences between places. Following the same areas over time, years in which GP experience improved did not bring
    fewer COPD admissions (${fx(cw)})${aw ? ` or asthma admissions (${fx(aw)})` : ""}.` : "";
  $("gpText2").innerHTML = `Even if general practice prevented every one of those admissions, which no health system manages, the simulator frees about
    ${r100(ga.dBeds)} beds and cuts 12-hour waits by about ${r1k(ga.dWait12PerYear)} a year. Preventing a quarter of them, a large improvement, frees about
    ${r100(gq.dBeds)} beds and cuts about ${r1k(gq.dWait12PerYear)} long waits. ${agText} Because hospitals are so full, any cut in admissions
    cuts long waits sharply, so better general practice would help, and would help patients most of all. But it cannot explain the rise: the break
    in long waits came while emergency admissions per person, and admissions for these conditions, were flat or falling.`;

  // flow
  const fl = HM.scenarios.find((x) => x.id === "flex"), sd = HM.scenarios.find((x) => x.id === "sevenDay"), hp = HM.scenarios.find((x) => x.id === "hospitalProcess");
  $("flowText1").innerHTML = `The evidence for flow is the strongest of the three, although it is indirect. Section 2 showed that the same occupancy now
    produces far longer waits than before the pandemic, that at the same occupancy this is not explained by delays, flu, weekend discharging or longer stays, and that a
    hospital that can no longer place patients flexibly across its wards reproduces the break on its own. The decomposition above puts
    ${pct(sh("flex").wait12 / tot, 0)} of the simulated rise in long waits there. Delays caused by hospitals' own processes are ${pct(G["Hospital processes"], 0)} of
    long discharge delays, and they are the delays that track long waits most closely${T ? `, within trusts and between them` : ""}.`;
  $("flowText2").innerHTML = `What "flexibility" is made of cannot be seen in national data. It covers how easily a patient can be placed on another
    specialty's ward, how quickly beds are turned round, staffing, infection-control rules and escalation. Some of that is management, some is
    rules and resources set nationally. In the simulator, restoring pre-pandemic flexibility with today's patients and beds cuts 12-hour waits by about
    ${r1k(fl.dWait12PerYear)} a year; removing delays from hospital processes, about ${r1k(hp.dWait12PerYear)}; full 7-day discharging, about ${r1k(sd.dWait12PerYear)}.`;

  // verdict
  const V = HM.scenarios.slice().sort((a, b) => a.dWait12PerYear - b.dWait12PerYear);
  legend("lVerdict", [["Hospital flow and management", C.BLUE], ["Social care", C.ORANGE], ["NHS community services", C.TEAL], ["General practice", C.PURPLE], ["All delays / beds (for scale)", C.GREY]]);
  new Chart($("cVerdict"), { type: "bar", data: { labels: V.map((x) => wrap(x.label, 34)), datasets: [{ data: V.map((x) => x.dWait12PerYear / 1000),
    backgroundColor: V.map((x) => HYP[x.hyp] || C.GREY), borderRadius: 4, borderSkipped: false, barPercentage: 0.8 }] },
    options: hbar("Change in waits over 12 hours, thousands a year", (v) => signed(v, (z) => z.toFixed(0) + "k") + " a year") });
  $("tVerdict").innerHTML = table(["Fix", "Tests", "Size", "Occupancy", "Beds freed", "12-hour waits a year"],
    V.map((x) => [esc(x.label), esc(x.hyp), esc(x.note), pp(x.dOcc), signed(-x.dBeds, int), signed(x.dWait12PerYear, int)]), [3, 4, 5]);
  const ad = HM.scenarios.find((x) => x.id === "allDelays");
  $("verdictText").innerHTML = `<b>Is it social care?</b> Partly. It explains about ${pct(G["Social care"], 0)} of the patients stuck in hospital, more if
    joint arrangements are counted, and fixing it would free one to two thousand beds. But social care delays do not move with long waits from month to
    month, and there is no comparable count from before the pandemic to show whether they grew. <b>Is it all the GPs' fault?</b> No. Emergency admissions per person have not risen since ${d19.fy}, nor have
    admissions for conditions GPs can manage. Preventing more of those admissions would help a full hospital a lot, but their growth is not what
    broke the system. <b>Is it how hospitals run?</b> The
    largest single cause in the data is a loss of flexibility in how beds are used, and the delays that track waits most closely are the hospital's own. That
    points to flow inside hospitals as the predominant cause of the post-pandemic break, though not necessarily to poor management alone: staffing,
    infection-control rules and specialty ring-fencing sit behind flow too. And the underlying arithmetic still matters. Removing every discharge
    delay of any kind would cut long waits by about ${r1k(ad.dWait12PerYear)} a year and free ${r100(ad.dBeds)} beds; 5,000 more beds would cut them by about
    ${r1k(HM.scenarios.find((x) => x.id === "beds5k").dWait12PerYear)}. Hospitals running above 90% full have no slack, so every one of these causes bites harder than it would
    in a hospital with room to spare.`;
  $("blameStats").innerHTML =
    stat("Rise in long waits from less flexible beds", pct(sh("flex").wait12 / tot, 0), `simulated, ${HM.from} to ${C.BY}`) +
    stat("Long delays due to social care", pct(G["Social care"], 0), `NHS community services ${pct(G["Community health services"], 0)}, hospital processes ${pct(G["Hospital processes"], 0)}`) +
    stat("Emergency admissions per person", signed(100 * (dN.adm_emergency_per1000 / d19.adm_emergency_per1000 - 1), (v) => v.toFixed(0) + "%"), `${d19.fy} to ${dN.fy}; A&E attendances ${signed(100 * (dN.attend_all_per1000 / d19.attend_all_per1000 - 1), (v) => v.toFixed(0) + "%")}`);
}

main().catch((e) => { console.error(e); document.querySelector("article").insertAdjacentHTML("afterbegin", `<p class="callout warn">Could not load data: ${esc(e.message)}</p>`); });
