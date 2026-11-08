// Stand-in for the desktop app's GS Quant commands, used by the browser smoke
// test and the website capture (neither runs Python). Runs inside the page via
// addInitScript. Volatility and drawdown are computed the simple way from the
// closes sent; the remaining figures are fixed placeholders.
module.exports = function quantStandin() {
  const vol = (a) => {
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    return Math.sqrt((a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) * 252) * 100;
  };
  window.__quantStandin = {
    status: () => ({ python: "/Applications/Aperture.app/Contents/Resources/python/aarch64-apple-darwin/bin/python3", version: "3.13.16", gsQuant: "2.2.5", chosen: false, bundled: true, install: "" }),
    analyze: ({ input }) => {
      const c = input.closes.map((x) => x[1]),
        d = input.closes.map((x) => x[0]),
        n = c.length;
      const r = c.slice(1).map((v, i) => v / c[i] - 1);
      const dd = c.map((v, i) => [d[i], v / Math.max(...c.slice(Math.max(0, i - 251), i + 1)) - 1]).slice(-252);
      const b = !!input.benchmark;
      // A small block bootstrap with a fixed seed, shaped like quant.py's output.
      let seed = 7;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const lr = c.slice(1).map((v, i) => Math.log(v / c[i])).slice(-756);
      const mean = lr.reduce((s, x) => s + x, 0) / lr.length;
      const drift = Math.log1p(input.riskFree || 0) / 252;
      const steps = lr.map((x) => x - mean + drift);
      const start = c.at(-1), P = 2000, Hz = 252;
      const paths = Array.from({ length: P }, () => {
        const out = [];
        let v = start;
        while (out.length < Hz) {
          const s0 = Math.floor(rand() * (steps.length - 5));
          for (let k = 0; k < 5 && out.length < Hz; k++) out.push((v *= Math.exp(steps[s0 + k])));
        }
        return out;
      });
      const q = (arr, p) => {
        const a = [...arr].sort((x, y) => x - y);
        return a[Math.min(a.length - 1, Math.floor(p * a.length))];
      };
      const dates = [];
      for (let t = new Date(d.at(-1) + "T00:00:00Z"); dates.length < Hz; ) {
        t = new Date(t.getTime() + 864e5);
        if (t.getUTCDay() % 6) dates.push(t.toISOString().slice(0, 10));
      }
      const bands = { p5: [], p25: [], p50: [], p75: [], p95: [] };
      for (let j = 0; j < Hz; j++) {
        const col = paths.map((p) => p[j]);
        for (const [k, pq] of [["p5", 0.05], ["p25", 0.25], ["p50", 0.5], ["p75", 0.75], ["p95", 0.95]]) bands[k].push(q(col, pq));
      }
      const horizons = {};
      for (const hz of [21, 63, 126, 252]) {
        const end = paths.map((p) => p[hz - 1]);
        const lo = q(end, 0.005), hi = q(end, 0.995);
        const edges = Array.from({ length: 41 }, (_, i) => lo + ((hi - lo) * i) / 40);
        const counts = Array(40).fill(0);
        for (const v of end) if (v >= lo && v <= hi) counts[Math.min(39, Math.floor(((v - lo) / (hi - lo)) * 40))]++;
        const share = (f) => end.filter(f).length / P;
        horizons[hz] = { days: hz, date: dates[hz - 1], p5: q(end, 0.05), p25: q(end, 0.25), p50: q(end, 0.5), p75: q(end, 0.75), p95: q(end, 0.95), up: share((v) => v > start), up10: share((v) => v >= start * 1.1), down10: share((v) => v <= start * 0.9), down20: share((v) => v <= start * 0.8), cvar5: q(end, 0.02), drawdownMedian: -0.08, drawdown5: -0.2, hist: { edges, counts } };
      }
      const sim = { method: "block bootstrap", paths: P, block: 5, lookback: lr.length, drift: input.riskFree || 0, start, dates, bands, examples: [paths[1], paths[2], paths[3]], horizons };
      const market = b ? { benchmark: input.benchmark.symbol, days: 21, rows: [["Down 10%+", 0.01, null], ["Down 5–10%", 0.08, -0.07], ["Down 0–5%", 0.41, -0.02], ["Up 0–5%", 0.42, 0.025], ["Up 5–10%", 0.07, 0.07], ["Up 10%+", 0.01, null]].map(([label, share, p50]) => ({ label, share, count: Math.round(share * 40000), ...(p50 == null ? {} : { p10: p50 - 0.05, p50, p90: p50 + 0.05 }) })) } : null;
      const sd = Math.sqrt(r.reduce((s, x) => s + x * x, 0) / r.length);
      const lo = Math.min(...r), hi = Math.max(...r);
      const edges = Array.from({ length: 51 }, (_, i) => lo + ((hi - lo) * i) / 50);
      const counts = Array(50).fill(0);
      for (const x of r) counts[Math.min(49, Math.floor(((x - lo) / (hi - lo || 1)) * 50))]++;
      const w = edges[1] - edges[0];
      const normal = counts.map((_, i) => { const m = (edges[i] + edges[i + 1]) / 2; return (r.length * w * Math.exp(-(m * m) / (2 * sd * sd))) / (sd * Math.sqrt(2 * Math.PI)); });
      const daily = { days: r.length, edges, counts, normal, sd, bigDays: 2, bigExpected: r.length * 0.0027, best: { date: d.at(-5), move: hi }, worst: { date: d.at(-9), move: lo } };
      return {
        sim,
        market,
        daily,
        gsQuant: "2.2.5",
        python: "3.13.16",
        symbol: input.symbol,
        benchmark: b ? input.benchmark.symbol : null,
        asOf: d.at(-1),
        points: n,
        riskFree: input.riskFree,
        metrics: {
          vol1m: vol(r.slice(-22)),
          vol3m: vol(r.slice(-66)),
          vol1y: n > 252 ? vol(r.slice(-252)) : null,
          return1y: n > 252 ? c.at(-1) / c.at(-253) - 1 : null,
          sharpe1y: n > 252 ? 0.84 : null,
          maxDrawdown1y: Math.min(...dd.map((x) => x[1])),
          drawdown: dd.at(-1)[1],
          rsi14: 54.2,
          zscore3m: 0.61,
          bollingerLow: c.at(-1) * 0.96,
          bollingerHigh: c.at(-1) * 1.03,
          beta3m: b ? 1.12 : null,
          beta1y: b && n > 252 ? 1.08 : null,
          corr3m: b ? 0.71 : null,
        },
        series: {
          vol: d.slice(22).map((day, i) => [day, vol(r.slice(i, i + 22))]).slice(-252),
          drawdown: dd,
          beta: b ? d.slice(-252).map((day, i) => [day, 1.1 + 0.15 * Math.sin(i / 20)]) : [],
        },
      };
    },
  };
};
