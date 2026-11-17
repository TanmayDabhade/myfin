// Volatility research helpers for the Volatility page and the stock page's
// VOL view. Pure functions over FRED payloads and workspace bars; the
// estimators themselves run in the Rust options maths (src/options/math.js).
import { realizedRolling, realizedCone, splitSuspects } from "./options/math.js";

// FRED series on the Volatility page. VIX and VIX3M are Cboe indices that
// FRED republishes with Cboe's permission; they must be cited as such.
export const VOL_SERIES = {
  VIXCLS: { label: "VIX", note: "Cboe Volatility Index: 30-day implied volatility of the S&P 500" },
  VXVCLS: { label: "VIX3M", note: "Cboe S&P 500 3-Month Volatility Index: 93-day implied volatility" },
};
export const VOL_CITATION = "Chicago Board Options Exchange, retrieved from FRED, Federal Reserve Bank of St. Louis";
export const YEAR = 252;
export const RV_WINDOWS = [10, 21, 63, 126, 252];

// FRED observations (newest first, "." for missing) → [{ date, value }] oldest first.
export function fredSeries(payload) {
  const obs = payload?.data?.observations || payload?.observations || [];
  return obs
    .filter((o) => o && o.value !== "." && Number.isFinite(Number(o.value)) && /^\d{4}-\d{2}-\d{2}$/.test(o.date))
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Where the latest value sits in its own last `n` observations.
// rank = (x − min)/(max − min); percentile = share of the prior values below x.
export function rankPercentile(series, n = YEAR) {
  if (series.length < 2) return null;
  const tail = series.slice(-n);
  const cur = tail.at(-1);
  const vals = tail.map((x) => x.value);
  const min = Math.min(...vals),
    max = Math.max(...vals);
  const prior = vals.slice(0, -1);
  return {
    date: cur.date,
    current: cur.value,
    min,
    max,
    n: tail.length,
    full: tail.length >= n,
    rank: max > min ? (cur.value - min) / (max - min) : null,
    percentile: prior.filter((v) => v < cur.value).length / prior.length,
  };
}

// Realized volatility of a stock, with unadjusted-split days left out.
export function realized(bars, { estimator = "yz", window = 21 } = {}) {
  const { flags, count } = splitSuspects(bars);
  const values = realizedRolling(bars, { estimator, window, exclude: flags });
  return { values, excluded: count, dates: bars.map((b) => b.date) };
}

// Volatility risk premium: VIX on day t against the S&P 500's (SPY's)
// realized volatility over the next `window` sessions, t+1 … t+window.
// That realized figure is only known `window` sessions later, so a VRP value
// exists only for dates at least that old; nothing here uses a future value
// at an earlier date. VIX is in points (16.4); outputs are in vol points.
export function vrpSeries(vix, bars, { window = 21, estimator = "yz" } = {}) {
  const rv = realized(bars, { estimator, window });
  const byDate = new Map(vix.map((x) => [x.date, x.value]));
  const rows = [];
  for (let i = 0; i < bars.length; i++) {
    const v = byDate.get(bars[i].date);
    if (v == null) continue;
    const trail = rv.values[i];
    const fwd = i + window < bars.length ? rv.values[i + window] : null;
    rows.push({
      date: bars[i].date,
      vix: v,
      rvTrailing: trail == null ? null : trail * 100,
      rvForward: fwd == null ? null : fwd * 100,
      vrp: fwd == null ? null : v - fwd * 100,
    });
  }
  const known = rows.filter((r) => r.vrp != null);
  const stats = known.length
    ? {
        n: known.length,
        mean: known.reduce((s, r) => s + r.vrp, 0) / known.length,
        positive: known.filter((r) => r.vrp > 0).length / known.length,
        knownThrough: known.at(-1).date,
        from: known[0].date,
      }
    : null;
  return { rows, stats, excluded: rv.excluded, window };
}

// VIX / VIX3M by date. Above 1 (backwardation) means near-term implied
// volatility is above 3-month: the market is pricing stress now.
export function termRatio(vix, vix3m) {
  const m = new Map(vix3m.map((x) => [x.date, x.value]));
  return vix.filter((x) => m.get(x.date) > 0).map((x) => ({ date: x.date, value: x.value / m.get(x.date) }));
}

// A stated, simple regime definition, not a model. Uses VIX's percentile
// in its own past year and whether the VIX term structure is inverted.
export const REGIME_RULES = "Calm: VIX below its 1-year 40th percentile. Normal: 40th–75th. Elevated: 75th–90th. Stressed: 90th and above. Inverted: VIX above VIX3M, whatever the level.";
export function regime(percentile, ratio) {
  if (percentile == null) return null;
  const level = percentile < 0.4 ? "Calm" : percentile < 0.75 ? "Normal" : percentile < 0.9 ? "Elevated" : "Stressed";
  return { level, inverted: ratio != null && ratio > 1, label: ratio != null && ratio > 1 ? `${level} · inverted` : level };
}

// Everything the VOL view shows for one stock.
export function volProfile(bars, estimator = "yz") {
  if (!bars || bars.length < 12) return null;
  const { flags, count } = splitSuspects(bars);
  const cone = realizedCone(bars, { estimator, windows: RV_WINDOWS, exclude: flags }).filter((r) => r.count > 0);
  const r21 = realizedRolling(bars, { estimator, window: 21, exclude: flags });
  const series = bars.map((b, i) => ({ date: b.date, value: r21[i] })).filter((x) => x.value != null);
  const rank = series.length > 20 ? rankPercentile(series, YEAR) : null;
  const byEstimator = {};
  for (const e of ["yz", "c2c", "gk", "rs", "park"]) byEstimator[e] = realizedRolling(bars, { estimator: e, window: 21, exclude: flags }).at(-1);
  return { estimator, cone, series, rank, excluded: count, excludedDates: bars.filter((_, i) => flags[i]).map((b) => b.date), byEstimator, bars: bars.length, asOf: bars.at(-1).date };
}
