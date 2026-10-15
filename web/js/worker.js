// Runs simulations off the main thread so the page stays responsive.
import { run } from "./model.js";

self.onmessage = (e) => {
  const { id, kind, params, reps, sweep } = e.data;
  try {
    if (kind === "run") {
      const r = run(params, reps, 1000, (f) => self.postMessage({ id, progress: f }));
      self.postMessage({ id, result: r });
    } else if (kind === "sweep") {
      const points = [];
      sweep.beds.forEach((beds, i) => {
        const r = run({ ...params, beds }, reps, 1000);
        points.push({ beds, occ: r.occMidnight, wait12PerYear: r.wait12PerYear, nightsFull: r.nightsFull });
        self.postMessage({ id, progress: (i + 1) / sweep.beds.length });
      });
      self.postMessage({ id, result: points });
    }
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
