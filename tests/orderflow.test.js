import test from "node:test";
import assert from "node:assert/strict";
import { groupPrints, priceStep, volumeAtPrice, levelOf, cumulativeDelta, largeSize, since, flowSummary } from "../src/orderflow.js";

const row = (time, price, size, side) => ({ time, price, size, side, tick: 0 });

test("prints of one order are grouped into a row", () => {
  const g = groupPrints([row(1, 10, 40, "sell"), row(1, 10, 40, "sell"), row(1, 10, 10, "buy"), row(2, 10, 5, "sell")]);
  assert.deepEqual(
    g.map((x) => [x.time, x.size, x.count, x.side]),
    [
      [1, 80, 2, "sell"],
      [1, 10, 1, "buy"],
      [2, 5, 1, "sell"],
    ],
  );
  assert.equal(since(g, 2).length, 1);
  assert.equal(since(g, 0).length, 3);
});

test("price steps are round and fit the range", () => {
  assert.equal(priceStep(347.7, 347.9, 24), 0.01);
  assert.equal(priceStep(340, 352, 24), 0.5);
  assert.equal(priceStep(100, 100, 24), 0.01);
});

test("volume at price splits buying and selling per level", () => {
  const v = volumeAtPrice([row(1, 10.01, 100, "buy"), row(2, 10.02, 50, "sell"), row(3, 10.02, 30, "buy"), row(4, 10.01, 20, "")], 24);
  assert.equal(v.step, 0.01);
  assert.deepEqual(
    v.rows.map((l) => [l.price, l.buy, l.sell, l.other, l.total, l.delta]),
    [
      [10.02, 30, 50, 0, 80, -20],
      [10.01, 100, 0, 20, 120, 100],
    ],
  );
  assert.equal(v.poc, 10.01);
  assert.equal(v.max, 120);
  assert.equal(levelOf(10.019, 0.01), 10.01);
  assert.deepEqual(volumeAtPrice([]).rows, []);
});

test("cumulative delta keeps one point per second", () => {
  const d = cumulativeDelta([row(1000, 1, 10, "buy"), row(1500, 1, 4, "sell"), row(2100, 1, 1, ""), row(3000, 1, 20, "sell")]);
  assert.deepEqual(d, [
    { time: 1, value: 6 },
    { time: 2, value: 6 },
    { time: 3, value: -14 },
  ]);
});

test("large prints stand out from the usual size", () => {
  assert.equal(largeSize([row(1, 1, 100)]), Infinity);
  const rows = Array.from({ length: 200 }, (_, i) => row(i, 1, i === 0 ? 50000 : 100));
  assert.equal(largeSize(rows), 1000);
});

test("flow summary totals a window of prints", () => {
  const s = flowSummary([row(1, 10, 100, "buy"), row(2, 11, 50, "sell"), row(3, 12, 10, "")]);
  assert.equal(s.count, 3);
  assert.equal(s.volume, 160);
  assert.equal(s.delta, 50);
  assert.equal(s.buyShare, 100 / 150);
  assert.equal(s.vwap, (1000 + 550 + 120) / 160);
  assert.equal(s.high, 12);
  assert.equal(s.largest.size, 100);
  assert.equal(flowSummary([]).vwap, null);
});
