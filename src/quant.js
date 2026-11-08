// Risk analytics (RSK) from Goldman Sachs' open-source gs-quant library. The
// desktop app runs gs_quant.timeseries in the user's own Python (see
// src-tauri/src/quant.py); these helpers build what the page sends and label
// what comes back.

export const BENCHMARK = "SPY";
const MAX_POINTS = 5000; // about 20 years of trading days

const closes = (bars = []) =>
  bars
    .filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b?.date) && Number.isFinite(+b.close) && +b.close > 0)
    .map((b) => [b.date, +b.close])
    .slice(-MAX_POINTS);

// `bench` is the benchmark asset ({ symbol, bars }) or null.
export function quantRequest(symbol, bars, bench = null, riskFree = 0) {
  const b = bench && bench.symbol !== symbol ? closes(bench.bars) : [];
  return {
    symbol,
    closes: closes(bars),
    benchmark: b.length ? { symbol: bench.symbol, closes: b } : null,
    riskFree: Number.isFinite(riskFree) ? riskFree : 0,
  };
}

// Same prices, benchmark and rate -> same result, so it is computed once.
export const quantKey = (r) =>
  [r.symbol, r.closes.length, r.closes.at(-1)?.join(":"), r.benchmark?.closes.at(-1)?.join(":") || "-", r.riskFree].join("|");

// Latest value of a FRED percent series (e.g. FEDFUNDS) as a decimal rate.
export function fredRate(payload) {
  let best = null;
  for (const o of payload?.data?.observations || []) {
    const v = Number(o.value);
    if (o.value !== "." && Number.isFinite(v) && (!best || o.date > best.date)) best = { rate: v / 100, date: o.date };
  }
  return best;
}

// The rows of the view, in order. kind: "vol" (gs-quant reports annualized
// volatility in percent), "pct" (a fraction), "x" (a plain number).
export const RISK_ROWS = [
  { key: "vol1m", label: "Volatility · 1 month", kind: "vol", fn: "volatility(x, 22)", note: "annualized, daily returns" },
  { key: "vol3m", label: "Volatility · 3 months", kind: "vol", fn: "volatility(x, 66)", note: "annualized, daily returns" },
  { key: "vol1y", label: "Volatility · 1 year", kind: "vol", fn: "volatility(x, 252)", note: "annualized, daily returns" },
  { key: "return1y", label: "Return · 1 year", kind: "pct", fn: "returns(x, 252)", note: "price only, no dividends" },
  { key: "sharpe1y", label: "Sharpe ratio · 1 year", kind: "x", fn: "sharpe_ratio(excess_returns_pure(x, cash), 252)", note: "excess return over cash ÷ volatility" },
  { key: "maxDrawdown1y", label: "Max drawdown · 1 year", kind: "pct", fn: "max_drawdown(x, 252)", note: "worst peak-to-trough fall" },
  { key: "drawdown", label: "Below 1-year high", kind: "pct", fn: "x / max(x, 252) − 1", note: "how far the last close is under the high" },
  { key: "beta3m", label: "Beta · 3 months", kind: "x", fn: "beta(x, benchmark, 66)", bench: true },
  { key: "beta1y", label: "Beta · 1 year", kind: "x", fn: "beta(x, benchmark, 252)", bench: true },
  { key: "corr3m", label: "Correlation · 3 months", kind: "x", fn: "correlation(x, benchmark, 66)", bench: true },
  { key: "rsi14", label: "RSI · 14 days", kind: "x", fn: "relative_strength_index(x, 14)", note: "above 70 overbought, below 30 oversold" },
  { key: "zscore3m", label: "Z-score · 3 months", kind: "x", fn: "zscores(x, 66)", note: "last close vs its 3-month mean, in std devs" },
];

export function formatRisk(kind, v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (kind === "vol") return v.toFixed(1) + "%";
  if (kind === "pct") return (v * 100).toFixed(1) + "%";
  return v.toFixed(2);
}

// Where the last close sits in its 20-day Bollinger band: 0 = lower, 1 = upper.
export function bandPosition(close, low, high) {
  if (![close, low, high].every(Number.isFinite) || high <= low) return null;
  return (close - low) / (high - low);
}
