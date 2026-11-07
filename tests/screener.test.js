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

import { squarify, mapTiles, mapShade, marketMapView } from "../src/screener.js";
test("squarify fills the rectangle with near-square tiles", () => {
  const r = squarify([6, 6, 4, 3, 2, 2, 1].map((value) => ({ value })), { x: 0, y: 0, w: 6, h: 4 });
  assert.equal(r.length, 7);
  assert.ok(Math.abs(r.reduce((t, x) => t + x.w * x.h, 0) - 24) < 1e-9);
  // The textbook example: the two largest stack in a 3-wide column.
  assert.deepEqual([r[0].x, r[0].y, r[0].w, r[0].h], [0, 0, 3, 2]);
  for (const x of r) assert.ok(x.x >= 0 && x.y >= 0 && x.x + x.w <= 6 + 1e-9 && x.y + x.h <= 4 + 1e-9);
  assert.deepEqual(squarify([{ value: 0 }], { x: 0, y: 0, w: 5, h: 5 }), []);
});
test("map tiles size by market cap, give unknown caps a small tile, and filter", () => {
  const snap = {
    tiles: [
      { symbol: "A", name: "Alpha", sector: "Tech", price: 10, cap: 100, returns: { d1: 0.01 } },
      { symbol: "B", name: "Beta", sector: "Tech", price: 10, cap: 300, returns: { d1: -0.02 } },
      { symbol: "C", name: "Gamma", sector: "Energy", price: 10, cap: null, returns: {} },
      { symbol: "D", name: "Delta", sector: "Energy", price: null, cap: 50, returns: {} },
    ],
  };
  const t = mapTiles(snap);
  assert.deepEqual(t.map((x) => [x.symbol, x.value]), [["A", 100], ["B", 300], ["C", 60]]);
  assert.deepEqual(mapTiles(snap, { mapSize: "equal" }).map((x) => x.value), [1, 1, 1]);
  assert.deepEqual(mapTiles(snap, { mapSector: "Tech", mapQuery: "bet" }).map((x) => x.symbol), ["B"]);
  assert.equal(mapShade(null, 0.03), "#2a2a2a");
  assert.notEqual(mapShade(0.03, 0.03), mapShade(-0.03, 0.03));
  const html = marketMapView({ ...snap, source: "finnhub", members: 4 }, { mapPeriod: "y1" }, 800);
  assert.match(html, /data-symbol="A"/);
  assert.match(html, /Today's change only/);
  assert.match(html, /Top gainers · 1 day/);
});
