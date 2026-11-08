import test from "node:test";
import assert from "node:assert/strict";
import { usMarketOpen, newFilings, refreshPlan, quantDue } from "../src/fresh.js";

test("knows the regular US session in New York time", () => {
  assert.equal(usMarketOpen(Date.parse("2026-11-09T15:00:00Z")), true, "Monday 10:00 New York");
  assert.equal(usMarketOpen(Date.parse("2026-11-09T14:29:00Z")), false, "9:29, before the open");
  assert.equal(usMarketOpen(Date.parse("2026-11-09T14:30:00Z")), true, "9:30, the open");
  assert.equal(usMarketOpen(Date.parse("2026-11-09T21:00:00Z")), false, "16:00, the close");
  assert.equal(usMarketOpen(Date.parse("2026-11-08T16:00:00Z")), false, "Sunday");
  assert.equal(usMarketOpen(Date.parse("2026-07-06T13:45:00Z")), true, "summer time: 9:45 EDT");
});

test("only filings not seen before are new, and a first load has none", () => {
  const a = { accession: "1", form: "8-K" }, b = { accession: "2", form: "10-Q" };
  assert.deepEqual(newFilings([a], [b, a]), [b]);
  assert.deepEqual(newFilings(undefined, [a, b]), []);
  assert.deepEqual(newFilings([a, b], [a, b]), []);
});

test("a new 10-Q refreshes financials and news; an 8-K refreshes news only", () => {
  const q = refreshPlan("AAPL", [{ form: "10-Q" }]);
  assert.equal(q.statements, true);
  assert.equal(q.news, true);
  assert.equal(q.summary, "AAPL filed 10-Q · financials updated");
  const k = refreshPlan("AAPL", [{ form: "8-K" }, { form: "8-K" }]);
  assert.equal(k.statements, false);
  assert.equal(k.news, true);
  assert.equal(k.summary, "AAPL filed 8-K");
  assert.equal(refreshPlan("AAPL", []).summary, "");
});

test("analytics rerun on new inputs, on a new day, and at most every few minutes intraday", () => {
  const req = (key, date) => ({ key, closes: [[date, 1]] });
  const prev = { data: {}, key: "a", lastDate: "2026-11-09", at: 1000 };
  assert.equal(quantDue(null, req("a", "2026-11-09"), 1000), true, "nothing computed yet");
  assert.equal(quantDue(prev, req("a", "2026-11-09"), 99999), false, "same inputs");
  assert.equal(quantDue(prev, req("b", "2026-11-10"), 1001), true, "new trading day");
  assert.equal(quantDue(prev, req("b", "2026-11-09"), 1000 + 299, 300), false, "live price moved, too soon");
  assert.equal(quantDue(prev, req("b", "2026-11-09"), 1000 + 300, 300), true, "live price moved, due");
  assert.equal(quantDue(prev, { key: "x", closes: [] }), false);
});
