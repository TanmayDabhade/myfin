import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadMath, bsm, black76, impliedVol, treePrice, realizedRolling, realizedCone, splitSuspects } from "../src/options/math.js";
import { fredSeries, rankPercentile, vrpSeries, termRatio, regime, volProfile } from "../src/vol.js";

await loadMath(readFileSync(new URL("../src/options/options.wasm", import.meta.url)));

// The same scipy/numpy reference values the Rust crate is tested against,
// now through the WebAssembly build the interface uses.
const oracle = readFileSync(new URL("../src-tauri/crates/options-math/tests/oracle.txt", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split(" "))
  .map(([tag, ...v]) => ({ tag, v: v.map(Number) }));
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

test("WebAssembly prices and Greeks match scipy", () => {
  const rows = oracle.filter((r) => r.tag === "bsm");
  assert.equal(rows.length, 400);
  for (const { v } of rows) {
    const g = bsm({ kind: v[0] === 1 ? "call" : "put", s: v[1], k: v[2], t: v[3], r: v[4], q: v[5], sigma: v[6] });
    ["price", "delta", "gamma", "vega", "theta", "rho"].forEach((name, i) => {
      const want = v[7 + i];
      assert.ok(Math.abs(g[name] - want) <= 1e-10 * Math.max(1, Math.abs(want)) || rel(g[name], want) < 1e-10, `${name} ${g[name]} vs ${want}`);
    });
  }
});

test("WebAssembly implied volatility matches scipy's Brent solve", () => {
  for (const { v } of oracle.filter((r) => r.tag === "iv")) {
    const [kind, price, s, k, t, r, q, want] = v;
    const out = impliedVol({ kind: kind === 1 ? "call" : "put", price, f: s * Math.exp((r - q) * t), k, t, df: Math.exp(-r * t) });
    assert.ok(Math.abs(out.iv - want) < 1e-9, `${out.iv} vs ${want}`);
  }
  assert.deepEqual(impliedVol({ kind: "call", price: 1, f: 100, k: 50, t: 1, df: 1 }), { error: "below intrinsic value" });
  assert.deepEqual(impliedVol({ kind: "call", price: 120, f: 100, k: 50, t: 1, df: 1 }), { error: "above the no-arbitrage maximum" });
  assert.throws(() => impliedVol({ kind: "straddle", price: 1, f: 1, k: 1, t: 1, df: 1 }));
});

test("WebAssembly realized volatility matches numpy", () => {
  const bars = oracle.filter((r) => r.tag === "bar").map(({ v }, i) => ({ date: String(i), open: v[0], high: v[1], low: v[2], close: v[3] }));
  const ids = ["c2c", "park", "gk", "rs", "yz"];
  for (const { v } of oracle.filter((r) => r.tag === "rv")) {
    const got = realizedRolling(bars, { estimator: ids[v[0]], window: v[1] }).at(-1);
    assert.ok(rel(got, v[2]) < 1e-12, `${ids[v[0]]} ${v[1]}: ${got} vs ${v[2]}`);
  }
});

test("Black-76, the binomial tree and parity behave", () => {
  const c = black76({ kind: "call", f: 19, k: 19, t: 0.75, r: 0.1, sigma: 0.28 });
  assert.ok(Math.abs(c.price - 1.7011) < 5e-5, "Haug's futures option example");
  const am = treePrice({ kind: "put", s: 50, k: 50, t: 5 / 12, r: 0.1, sigma: 0.4, steps: 501 });
  assert.ok(Math.abs(am - 4.28) < 0.01, `Hull's American put ${am}`);
  const eu = treePrice({ kind: "call", s: 100, k: 95, t: 0.5, r: 0.05, q: 0.02, sigma: 0.25, early: false, steps: 201 });
  assert.ok(Math.abs(eu - bsm({ kind: "call", s: 100, k: 95, t: 0.5, r: 0.05, q: 0.02, sigma: 0.25 }).price) < 2e-4);
  const div = treePrice({ kind: "call", s: 100, k: 80, t: 0.5, r: 0.05, sigma: 0.2, dividends: [{ t: 0.25, amount: 5 }] });
  assert.ok(div < treePrice({ kind: "call", s: 100, k: 80, t: 0.5, r: 0.05, sigma: 0.2 }));
});

// A year and a half of synthetic daily bars, with an unadjusted 2-for-1 split.
function synthetic(n = 400, split = 300) {
  let seed = 9;
  const rnd = () => ((seed = (1103515245 * seed + 12345) >>> 0) / 2 ** 32) - 0.5;
  const bars = [];
  let c = 100;
  for (let i = 0; i < n; i++) {
    const o = c * Math.exp(rnd() * 0.01);
    c = o * Math.exp(rnd() * 0.03);
    const f = i >= split ? 0.5 : 1;
    const day = new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    bars.push({ date: day, open: o * f, high: Math.max(o, c) * 1.004 * f, low: Math.min(o, c) * 0.996 * f, close: c * f });
  }
  return bars;
}

test("split days are found and left out of realized volatility", () => {
  const bars = synthetic();
  const s = splitSuspects(bars);
  assert.equal(s.count, 1);
  assert.equal(s.flags.indexOf(true), 300);
  // A 126-day window ending at the last bar contains the split day (bar 300).
  const raw = realizedRolling(bars, { estimator: "c2c", window: 126 }).at(-1);
  const clean = realizedRolling(bars, { estimator: "c2c", window: 126, exclude: s.flags }).at(-1);
  assert.ok(raw > 2 * clean, `${raw} vs ${clean}`);
  const cone = realizedCone(bars, { windows: [21, 63], exclude: s.flags });
  assert.equal(cone[0].window, 21);
  assert.ok(cone[0].min <= cone[0].median && cone[0].median <= cone[0].max);
  assert.deepEqual(realizedRolling([], {}), []);
});

test("reads FRED observations and ranks the latest value", () => {
  const s = fredSeries({ data: { observations: [{ date: "2026-11-03", value: "20" }, { date: "2026-11-02", value: "." }, { date: "2026-11-01", value: "10" }, { date: "bad", value: "1" }] } });
  assert.deepEqual(s, [{ date: "2026-11-01", value: 10 }, { date: "2026-11-03", value: 20 }]);
  const series = [10, 30, 20, 15, 25].map((value, i) => ({ date: `2026-01-0${i + 1}`, value }));
  const r = rankPercentile(series, 252);
  assert.equal(r.current, 25);
  assert.equal(r.rank, 0.75);
  assert.equal(r.percentile, 0.75, "3 of the 4 earlier values are lower");
  assert.equal(r.full, false);
  assert.equal(rankPercentile(series.slice(0, 1)), null);
});

test("the volatility risk premium never uses future data at a past date", () => {
  const bars = synthetic(260, 1e9);
  const vix = bars.map((b, i) => ({ date: b.date, value: 15 + (i % 10) }));
  const full = vrpSeries(vix, bars, { window: 21 });
  // Cut the price history short: every VRP value that is still defined must
  // be identical, and the last 21 dates must have none.
  const cut = vrpSeries(vix, bars.slice(0, 200), { window: 21 });
  const known = cut.rows.filter((r) => r.vrp != null);
  assert.equal(known.length, 200 - 21, "defined only where the next 21 sessions exist");
  for (const r of known) assert.equal(r.vrp, full.rows.find((x) => x.date === r.date).vrp);
  assert.ok(cut.rows.slice(-21).every((r) => r.vrp == null));
  assert.equal(cut.stats.knownThrough, bars[178].date);
  const r0 = full.rows.find((r) => r.vrp != null);
  assert.ok(Math.abs(r0.vrp - (r0.vix - r0.rvForward)) < 1e-12);
});

test("term ratio and the stated regime rules", () => {
  const t = termRatio([{ date: "a", value: 20 }, { date: "b", value: 30 }], [{ date: "a", value: 25 }, { date: "b", value: 25 }]);
  assert.deepEqual(t.map((x) => x.value), [0.8, 1.2]);
  assert.equal(regime(0.2, 0.9).label, "Calm");
  assert.equal(regime(0.8, 0.9).level, "Elevated");
  assert.equal(regime(0.95, 1.1).label, "Stressed · inverted");
  assert.equal(regime(null, 1), null);
});

test("a stock's volatility profile", () => {
  const p = volProfile(synthetic());
  assert.equal(p.excluded, 1);
  assert.equal(p.excludedDates.length, 1);
  assert.deepEqual(p.cone.map((r) => r.window), [10, 21, 63, 126, 252]);
  assert.ok(p.rank.percentile >= 0 && p.rank.percentile <= 1);
  assert.ok(Object.values(p.byEstimator).every((v) => v > 0 && v < 1));
  assert.equal(volProfile([]), null);
});
