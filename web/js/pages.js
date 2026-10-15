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
    $("calibration").innerHTML = table(
      ["Quantity", "Today's system", "More flexible system"],
      [
        ["Effective bed pool size (beds)", num(c.A.poolSize), num(c.B.poolSize)],
        ["Median acute length of stay, emergency overnight patients (days)", num(c.A.losMedianDays, 2), num(c.B.losMedianDays, 2)],
        ["Mean discharge delay for delayed patients (days)", num(c.A.delayMeanDays, 2), num(c.B.delayMeanDays, 2)],
        ["Target: average G&A occupancy", pct(t.occupancy), pct(t.occupancy)],
        ["Target: beds occupied by patients fit to leave (share of occupied)", pct(t.nctrShare), pct(t.nctrShare)],
        ["Target: emergency admissions waiting >12h from decision to admit", pct(t.wait12Share, 2), "not targeted"],
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
  if ($("conds")) {
    $("conds").innerHTML = table(
      ["Condition group", "Share of emergency admissions", "Length-of-stay multiplier", "Definition"],
      base.conditions.map((c) => [esc(c.label || c.name), pct(c.share), num(c.losMult, 2), esc(c.definition || "")]),
      [1, 2]);
    if ($("condsNote")) $("condsNote").innerHTML = esc(base.conditionNote || "");
  }
  if ($("history")) {
    $("history").innerHTML = table(
      ["Year", "G&A beds (as published)", "G&A beds (consistent definition)", "Occupancy", "Population (England)", "Beds per 1,000", "Note"],
      (base.bedHistory || []).map((h) => [esc(h.year), num(h.bedsPublished), num(h.beds), pct(h.occupancy), num(h.population), num(1000 * h.beds / h.population, 2), esc(h.note)]),
      [1, 2, 3, 4, 5]);
  }
  if ($("validation")) {
    $("validation").innerHTML = table(
      ["Check", "Observed", "Today's system", "More flexible system", "Comment"],
      (base.validation || []).map((v) => [esc(v.check), esc(v.observed), esc(v.modelA), esc(v.modelB), esc(v.comment)]),
      [1, 2, 3]);
  }
  if ($("files")) {
    $("files").innerHTML = table(["Dataset", "Files used", "Publisher page"],
      (base.rawFiles || []).map((f) => [esc(f.dataset), (f.files || []).map(esc).join("<br>"), link(f.page, "page")]));
  }
}
main().catch((e) => { document.body.insertAdjacentHTML("beforeend", `<p class="wrap">Could not load data: ${esc(e.message)}</p>`); });
