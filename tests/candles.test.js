import test from "node:test";
import assert from "node:assert/strict";
import { nyWall, parseWall, inSession, bucketStart, fromTwelve, dailyBars, weeklyBars, applyPrints, movingAverage, barsDue, intervalOf, isIntraday } from "../src/candles.js";

const ms = (iso) => Date.parse(iso);

test("wall-clock times follow New York, including daylight saving", () => {
  assert.equal(nyWall(ms("2026-11-10T14:30:00Z")), parseWall("2026-11-10 09:30:00"));
  assert.equal(nyWall(ms("2026-07-01T13:30:05Z")), parseWall("2026-07-01 09:30:05"));
  assert.equal(parseWall("2026-11-10"), Date.UTC(2026, 10, 10) / 1000);
  assert.equal(parseWall("nope"), null);
});

test("session and bar alignment", () => {
  const t = parseWall("2026-11-10 10:47:12"); // a Tuesday
  assert.ok(inSession(t));
  assert.ok(!inSession(parseWall("2026-11-10 16:00:00")));
  assert.ok(!inSession(parseWall("2026-11-10 08:00:00")));
  assert.ok(!inSession(parseWall("2026-11-14 11:00:00"))); // Saturday
  assert.equal(bucketStart(t, "1m"), parseWall("2026-11-10 10:47"));
  assert.equal(bucketStart(t, "5m"), parseWall("2026-11-10 10:45"));
  assert.equal(bucketStart(t, "15m"), parseWall("2026-11-10 10:45"));
  assert.equal(bucketStart(t, "1h"), parseWall("2026-11-10 10:30"));
  assert.equal(bucketStart(t, "4h"), parseWall("2026-11-10 09:30"));
  assert.equal(bucketStart(parseWall("2026-11-10 13:31"), "4h"), parseWall("2026-11-10 13:30"));
  assert.equal(bucketStart(t, "1D"), parseWall("2026-11-10"));
  assert.equal(bucketStart(t, "1W"), parseWall("2026-11-09")); // Monday
  assert.ok(isIntraday("15m") && !isIntraday("1D"));
  assert.equal(intervalOf("bogus").id, "1D");
});

test("Twelve Data bars become sorted chart bars", () => {
  const bars = fromTwelve({
    values: [
      { datetime: "2026-11-10 09:31:00", open: "10", high: "11", low: "9.5", close: "10.5", volume: "300" },
      { datetime: "2026-11-10 09:30:00", open: "9", high: "10", low: "9", close: "10", volume: "200" },
      { datetime: "2026-11-10 09:30:00", open: "9", high: "10", low: "9", close: "10", volume: "200" },
      { datetime: "bad", open: "1", high: "1", low: "1", close: "1" },
    ],
  });
  assert.deepEqual(
    bars.map((b) => [b.time, b.close, b.volume]),
    [
      [parseWall("2026-11-10 09:30"), 10, 200],
      [parseWall("2026-11-10 09:31"), 10.5, 300],
    ],
  );
  assert.deepEqual(fromTwelve(null), []);
});

test("weekly bars roll up daily bars by Monday", () => {
  const days = dailyBars([
    { date: "2026-11-05", open: 1, high: 3, low: 1, close: 2, volume: 10 }, // Thu
    { date: "2026-11-06", open: 2, high: 4, low: 2, close: 3, volume: 10 }, // Fri
    { date: "2026-11-09", open: 3, high: 5, low: 0.5, close: 4, volume: 5 }, // Mon
    { date: "2026-11-10", open: 4, high: 6, low: 3, close: 5, volume: 5 },
  ]);
  const w = weeklyBars(days);
  assert.equal(w.length, 2);
  assert.deepEqual(
    { ...w[0] },
    { time: parseWall("2026-11-02"), open: 1, high: 4, low: 1, close: 3, volume: 20 },
  );
  assert.deepEqual({ ...w[1] }, { time: parseWall("2026-11-09"), open: 3, high: 6, low: 0.5, close: 5, volume: 10 });
});

test("live prints update the newest bar and start new ones", () => {
  const bars = [{ time: parseWall("2026-11-10 10:00"), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 }];
  const used = applyPrints(
    bars,
    [
      { price: 101.5, size: 10, time: ms("2026-11-10T15:00:20Z") }, // 10:00:20 NY
      { price: 102, size: 5, time: ms("2026-11-10T15:01:02Z") }, // new minute
      { price: 98, size: 7, time: ms("2026-11-10T15:00:59Z") }, // late print, earlier bar
      { price: 103, size: 1, time: ms("2026-11-10T21:30:00Z") }, // after the close
      { price: -1, size: 1, time: ms("2026-11-10T15:02:00Z") },
    ],
    "1m",
  );
  assert.equal(used, 3);
  assert.equal(bars.length, 2);
  assert.deepEqual({ ...bars[0] }, { time: parseWall("2026-11-10 10:00"), open: 100, high: 101.5, low: 98, close: 101.5, volume: 1017 });
  assert.deepEqual({ ...bars[1] }, { time: parseWall("2026-11-10 10:01"), open: 102, high: 102, low: 102, close: 102, volume: 5 });
});

test("moving average skips the warm-up", () => {
  const bars = [1, 2, 3, 4].map((c, i) => ({ time: i, close: c }));
  assert.deepEqual(movingAverage(bars, 3), [
    { time: 2, value: 2 },
    { time: 3, value: 3 },
  ]);
});

test("intraday bars are downloaded again only when useful", () => {
  const now = 1_000_000_000_000;
  assert.ok(barsDue(null, { now, open: true }));
  const st = { fetchedAt: now / 1000 - 300 };
  assert.ok(barsDue(st, { now, open: true, streaming: false }));
  assert.ok(!barsDue(st, { now, open: true, streaming: true }));
  assert.ok(barsDue(st, { now, open: false, wasOpen: true }));
  assert.ok(!barsDue(st, { now, open: false, wasOpen: false }));
});
