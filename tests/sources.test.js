import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTwelve, priceSource, stale } from "../src/sources.js";

test("Twelve Data bars are sorted oldest-first and numeric", () => {
  const bars = normalizeTwelve({
    status: "ok",
    values: [
      { datetime: "2026-11-05", open: "353.89", high: "355.38", low: "342.06", close: "344.17", volume: "75457100" },
      { datetime: "2026-11-04", open: "341.57", high: "354.5", low: "340.99", close: "349.51", volume: "89637700" },
    ],
  });
  assert.deepEqual(bars.map((b) => b.date), ["2026-11-04", "2026-11-05"]);
  assert.equal(bars[1].close, 344.17);
  assert.equal(bars[1].volume, 75457100);
});

test("provider rounding of high/low is clamped instead of rejecting the series", () => {
  const [bar] = normalizeTwelve({
    values: [{ datetime: "2026-11-05", open: "10", high: "10.999", low: "9", close: "11" }],
  });
  assert.equal(bar.high, 11);
  assert.equal(bar.volume, 0);
});

test("missing values are an error, not an empty chart", () => {
  assert.throws(() => normalizeTwelve({ status: "error" }), /no prices/);
});

test("price source falls back to whichever provider has a key", () => {
  const status = { twelve: { configured: false }, alpha: { configured: true } };
  assert.equal(priceSource("twelve", status), "alpha");
  assert.equal(priceSource("alpha", status), "alpha");
  assert.equal(priceSource("twelve", { twelve: { configured: true } }), "twelve");
  assert.equal(priceSource("twelve", null), null);
});

test("staleness uses the download timestamp", () => {
  assert.equal(stale(undefined, 60), true);
  assert.equal(stale({ fetchedAt: 1000 }, 60, 1030), false);
  assert.equal(stale({ fetchedAt: 1000 }, 60, 1100), true);
});
