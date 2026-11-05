import test from "node:test";
import assert from "node:assert/strict";
import { performance, metric, screenRows, shade } from "../src/screener.js";
const bars = Array.from({ length: 25 }, (_, i) => ({
  date: `2026-01-${String(i + 1).padStart(2, "0")}`,
  close: 100 + i,
}));
test("return horizons use required observations", () => {
  assert.equal(performance(bars, "d1"), 124 / 123 - 1);
  assert.equal(performance(bars, "m1"), 124 / 103 - 1);
  assert.equal(performance(bars, "m3"), null);
  assert.equal(performance(bars, "bogus"), null);
});
test("YTD needs previous year close", () => {
  assert.equal(performance(bars, "ytd"), null);
  assert.equal(
    performance([{ date: "2025-12-31", close: 100 }, ...bars], "ytd"),
    0.24,
  );
});
test("missing metrics are not zeros or excluded by default", () => {
  assert.equal(metric({ overview: { PERatio: "None" } }, "pe"), null);
  assert.equal(metric({ overview: { PERatio: 0 } }, "pe"), null);
  assert.equal(screenRows([{ symbol: "A", name: "A", bars: [] }]).length, 1);
});
test("missing sort values stay last in both directions", () => {
  const rows = [
    { symbol: "A", name: "A", overview: { PERatio: 10 } },
    { symbol: "B", name: "B" },
    { symbol: "C", name: "C", overview: { PERatio: 5 } },
  ];
  assert.deepEqual(
    screenRows(rows, { sort: "pe" }).map((x) => x.symbol),
    ["A", "C", "B"],
  );
  assert.deepEqual(
    screenRows(rows, { sort: "pe", direction: "asc" }).map((x) => x.symbol),
    ["C", "A", "B"],
  );
  assert.equal(screenRows(rows, { maxPE: 7 }).length, 1);
});
test("unknown colors remain distinct from a zero return", () =>
  assert.notEqual(shade(null, "return"), shade(0, "return")));
