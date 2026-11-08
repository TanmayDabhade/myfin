import test from "node:test";
import assert from "node:assert/strict";
import { ticks, fanChart, outcomeHistogram, scenarioChart, dailyHistogram, lineChart } from "../src/riskcharts.js";

const dates = (n, from = Date.UTC(2026, 0, 1)) => Array.from({ length: n }, (_, i) => new Date(from + i * 864e5).toISOString().slice(0, 10));
const sim = (() => {
  const days = dates(252, Date.UTC(2027, 0, 1));
  const band = (f) => days.map((_, j) => 100 * (1 + f * Math.sqrt((j + 1) / 252)));
  const hist = { edges: Array.from({ length: 41 }, (_, i) => 60 + i * 2), counts: Array.from({ length: 40 }, (_, i) => 40 - Math.abs(20 - i)) };
  return { start: 100, dates: days, bands: { p5: band(-0.3), p25: band(-0.1), p50: band(0), p75: band(0.1), p95: band(0.35) }, examples: [band(0.2), band(-0.2), band(0.05)], horizons: { 252: { days: 252, hist } } };
})();

test("ticks are round numbers covering the range", () => {
  assert.deepEqual(ticks(0, 100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(ticks(283, 412, 4), [300, 350, 400]);
  assert.deepEqual(ticks(5, 5), [5]);
});

test("fan chart draws history, bands, median and a hover readout per day", () => {
  const history = dates(300).map((d, i) => [d, 80 + i / 15]);
  const c = fanChart(sim, history, 63, 900);
  assert.equal((c.svg.match(/<polygon/g) || []).length, 2, "middle 50% and 90% bands");
  assert.match(c.svg, /stroke-dasharray="5 4"/, "dashed median");
  assert.match(c.svg, /clip-path/, "single simulations stay inside the plot");
  assert.equal(c.n, 63 + 63);
  assert.equal(c.tip(10)[1][0][0], "Close");
  assert.match(c.tip(70)[0], /simulated/);
  assert.equal(c.tip(70)[1].length, 5);
  assert.doesNotMatch(fanChart(sim, history, 252, 300, 150, { examples: false }).svg, /clip-path="url/, "mini fan has no single paths");
});

test("outcome histogram colors bars by side of today's price", () => {
  const c = outcomeHistogram(sim.horizons[252], 100, 400);
  assert.equal((c.svg.match(/data-i=/g) || []).length, 40);
  assert.match(c.svg, /#d07a24/);
  assert.match(c.svg, /#3a95d8/);
  assert.match(c.svg, /Today \$100\.00/);
  assert.match(c.tip(0)[1][0][1], /%$/);
});

test("market scenarios mark buckets with too few months", () => {
  const market = { benchmark: "SPY", rows: [{ label: "Down 10%+", share: 0.001, count: 20 }, { label: "Up 0–5%", share: 0.4, count: 16000, p10: -0.03, p50: 0.02, p90: 0.07 }] };
  const c = scenarioChart(market, "AAPL", 600);
  assert.match(c.svg, /Too rare to estimate/);
  assert.match(c.svg, /\+2\.0% typical/);
  assert.match(c.tip(1)[1][1][1], /-3\.0% and \+7\.0%/);
});

test("daily histogram and line charts render with hover", () => {
  const d = { edges: Array.from({ length: 51 }, (_, i) => -0.05 + i * 0.002), counts: Array(50).fill(3), normal: Array(50).fill(2.5) };
  assert.equal(dailyHistogram(d, 500).n, 50);
  const rows = dates(30).map((t, i) => [t, -i / 100]);
  const c = lineChart(rows, { fmt: (v) => v.toFixed(2), wash: "below" }, 400);
  assert.match(c.svg, /<polygon/);
  assert.equal(c.tip(29)[1][0][1], "-0.29");
});
