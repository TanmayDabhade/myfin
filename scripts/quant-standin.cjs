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
      return {
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
