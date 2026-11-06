import test from "node:test";
import assert from "node:assert/strict";
import { applyTrade, nyDate } from "../src/live.js";

const asset = () => ({
  bars: [
    { date: "2026-11-04", open: 1, high: 2, low: 1, close: 2, volume: 9 },
    { date: "2026-11-05", open: 10, high: 11, low: 9, close: 10, volume: 9 },
  ],
});
// 2026-11-05 15:00 New York = 20:00 UTC; 2026-11-06 01:00 UTC is still the 5th in New York.
const nov5 = Date.UTC(2026, 10, 5, 20),
  lateNov5 = Date.UTC(2026, 10, 6, 1),
  nov6 = Date.UTC(2026, 10, 6, 15);

test("session dates use New York time", () => {
  assert.equal(nyDate(lateNov5), "2026-11-05");
  assert.equal(nyDate(nov6), "2026-11-06");
});
test("a trade in the current session updates the last bar", () => {
  const a = asset();
  assert.ok(applyTrade(a, { price: 12, time: nov5 }));
  assert.deepEqual(a.bars.at(-1), { date: "2026-11-05", open: 10, high: 12, low: 9, close: 12, volume: 9 });
  assert.ok(applyTrade(a, { price: 8.5, time: lateNov5 }));
  assert.equal(a.bars.at(-1).low, 8.5);
  assert.equal(a.bars.length, 2);
});
test("a new session starts a new bar; stale and bad trades are ignored", () => {
  const a = asset();
  assert.ok(applyTrade(a, { price: 11, time: nov6 }));
  assert.equal(a.bars.length, 3);
  assert.deepEqual(a.bars.at(-1), { date: "2026-11-06", open: 11, high: 11, low: 11, close: 11, volume: 0 });
  assert.ok(!applyTrade(a, { price: 99, time: nov5 }), "older than the last applied trade");
  assert.ok(!applyTrade(a, { price: 0, time: nov6 + 1 }));
  assert.ok(!applyTrade({ bars: [] }, { price: 1, time: nov6 }));
  const b = asset();
  assert.ok(!applyTrade(b, { price: 1, time: Date.UTC(2026, 10, 3, 15) }), "before the stored history");
});
