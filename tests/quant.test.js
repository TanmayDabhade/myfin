import test from "node:test";
import assert from "node:assert/strict";
import { quantRequest, quantKey, fredRate, formatRisk, bandPosition, RISK_ROWS } from "../src/quant.js";
import { VIEW_CODES } from "../src/stock.js";

const bars = (n, from = 100) => Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10), close: from + i }));

test("builds the request gs-quant reads", () => {
  const r = quantRequest("AAPL", [...bars(3), { date: "bad", close: 5 }, { date: "2026-02-01", close: -1 }], { symbol: "SPY", bars: bars(2, 500) }, 0.0433);
  assert.deepEqual(r.closes, [["2026-01-01", 100], ["2026-01-02", 101], ["2026-01-03", 102]]);
  assert.deepEqual(r.benchmark, { symbol: "SPY", closes: [["2026-01-01", 500], ["2026-01-02", 501]] });
  assert.equal(r.riskFree, 0.0433);
  // A stock is not its own benchmark, and a missing benchmark is null.
  assert.equal(quantRequest("SPY", bars(3), { symbol: "SPY", bars: bars(3) }).benchmark, null);
  assert.equal(quantRequest("AAPL", bars(3), null, NaN).riskFree, 0);
  assert.equal(quantRequest("AAPL", bars(6000)).closes.length, 5000, "capped at about 20 years");
});

test("recalculates only when prices, benchmark or rate change", () => {
  const a = quantRequest("AAPL", bars(40), { symbol: "SPY", bars: bars(40) });
  assert.equal(quantKey(a), quantKey(quantRequest("AAPL", bars(40), { symbol: "SPY", bars: bars(40) })));
  assert.notEqual(quantKey(a), quantKey(quantRequest("AAPL", bars(41), { symbol: "SPY", bars: bars(40) })));
  assert.notEqual(quantKey(a), quantKey(quantRequest("AAPL", bars(40), null)));
  assert.notEqual(quantKey(a), quantKey(quantRequest("AAPL", bars(40), { symbol: "SPY", bars: bars(40) }, 0.04)));
});

test("reads the latest fed funds rate from FRED", () => {
  const payload = { data: { observations: [{ date: "2026-09-01", value: "4.33" }, { date: "2026-10-01", value: "4.08" }, { date: "2026-11-01", value: "." }] } };
  assert.deepEqual(fredRate(payload), { rate: 0.0408, date: "2026-10-01" });
  assert.equal(fredRate(null), null);
});

test("formats each kind of measure", () => {
  assert.equal(formatRisk("vol", 21.5037), "21.5%");
  assert.equal(formatRisk("pct", -0.1728), "-17.3%");
  assert.equal(formatRisk("x", 1.2987), "1.30");
  assert.equal(formatRisk("x", null), "—");
  assert.equal(bandPosition(100, 90, 110), 0.5);
  assert.equal(bandPosition(100, 110, 110), null);
});

test("every row names its gs-quant function, and RSK is a stock view", () => {
  assert.ok(RISK_ROWS.every((r) => r.key && r.label && r.fn && ["vol", "pct", "x"].includes(r.kind)));
  assert.ok(VIEW_CODES.has("RSK"));
});
