import test from "node:test";
import assert from "node:assert/strict";
import { pushRecent, tapeStats, ownershipFeed, annualSeries, latestInstant, valuationInputs, VIEW_CODES } from "../src/stock.js";
import { parseCommand } from "../src/holders.js";

test("recent stocks keep the newest first without duplicates", () => {
  assert.deepEqual(pushRecent(["MSFT", "AAPL"], "aapl"), ["AAPL", "MSFT"]);
  assert.deepEqual(pushRecent(["A", "B", "C"], "D", 3), ["D", "A", "B"]);
  assert.deepEqual(pushRecent(["A"], ""), ["A"]);
});

test("stock functions route to the stock page with their view", () => {
  assert.deepEqual(parseCommand("aapl hds"), { command: "HDS", page: "Stock", view: "HDS", ticker: "AAPL" });
  assert.deepEqual(parseCommand("RELS NVDA"), { command: "RELS", page: "Stock", view: "SPLC", ticker: "NVDA" });
  assert.equal(parseCommand("QR").view, "TAS");
  assert.equal(parseCommand("DCF").ticker, null);
  // The function is the last command word: CF Industries' holders.
  assert.deepEqual(parseCommand("CF HDS"), { command: "HDS", page: "Stock", view: "HDS", ticker: "CF" });
  // "CF EQUITY" is the ticker, not the filings function.
  assert.equal(parseCommand("CF US EQUITY"), null);
  assert.deepEqual(parseCommand("ECO"), { command: "ECO", page: "Economy", view: null, ticker: null });
  for (const c of ["HDS", "DES", "GP", "FA", "CN", "OWN", "SPLC", "DCF", "TAS", "CF"]) assert.ok(VIEW_CODES.has(parseCommand(c).view), c);
});

test("tape classifies prints by the tick rule and totals volume", () => {
  const s = tapeStats([
    { price: 10, size: 100, time: 1 },
    { price: 10.1, size: 200, time: 2 },
    { price: 10.1, size: 50, time: 3 },
    { price: 10, size: 300, time: 4 },
    { price: -1, size: 5, time: 5 },
  ]);
  assert.deepEqual(s.rows.map((r) => r.side), ["", "buy", "buy", "sell"]);
  assert.equal(s.count, 4);
  assert.equal(s.volume, 650);
  assert.equal(s.buyVolume, 250);
  assert.equal(s.sellVolume, 300);
  assert.ok(Math.abs(s.vwap - (1000 + 2020 + 505 + 3000) / 650) < 1e-9);
  assert.equal(s.largest.size, 300);
  assert.equal(s.high, 10.1);
  assert.equal(tapeStats([]).vwap, null);
});

test("ownership feed merges 13F, 13D/G and insider trades newest first", () => {
  const holders = [
    { name: "Big Fund", status: "added", change: 1000, shares: 5000, price: 10, filed: "2026-08-10", cik: 1, accession: "a" },
    { name: "Tiny Fund", status: "reduced", change: -1, shares: 9, price: 10, filed: "2026-08-12", cik: 2, accession: "b" },
    { name: "Steady", status: "unchanged", change: 0, shares: 10, price: 10, filed: "2026-08-12" },
    { name: "Late", status: "not-filed", change: null, shares: 0, filed: "2026-05-01" },
  ];
  const big = [{ name: "Activist LP", activist: true, change: 200, shares: 9000, percent: 6.1, filed: "2026-09-01", url: "u1", filings: 2 }];
  const insiders = [
    { owner: "CEO", role: "CEO", code: "S", shares: 50, value: 500, price: 10, date: "2026-10-01", form: "4", url: "u2", plan: true },
    { owner: "CFO", role: "CFO", code: "A", shares: 10, date: "2026-10-02" },
    { owner: "Dir", role: "Director", code: "P", shares: 5, value: 50, date: "2026-10-03", derivative: true },
  ];
  const feed = ownershipFeed({ holders, big, insiders }, { top13F: 1 });
  assert.deepEqual(feed.map((x) => x.who), ["CEO", "Activist LP", "Big Fund"]);
  assert.equal(feed[0].action, "Sold (10b5-1 plan)");
  assert.equal(feed[0].shares, -50);
  assert.equal(feed[1].action, "Increased stake");
  assert.equal(feed[2].value, 10000);
  assert.deepEqual(ownershipFeed(), []);
});

const fact = (end, val, start, filed = end, form = "10-K") => ({ end, val, start, filed, form, accn: "x" });
test("valuation inputs come from annual cash flow, balance sheet and shares", () => {
  const facts = {
    NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fact("2025-09-27", 120e9, "2024-09-29"), fact("2025-06-28", 30e9, "2025-03-30", "2025-08-01", "10-Q"), fact("2024-09-28", 110e9, "2023-10-01")] } },
    PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [fact("2025-09-27", 12e9, "2024-09-29")] } },
    LongTermDebt: { units: { USD: [fact("2025-09-27", 100e9), fact("2025-06-28", 105e9, undefined, "2025-08-01", "10-Q")] } },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [fact("2025-09-27", 30e9)] } },
    sharesOut: { date: "2025-10-17", shares: 15e9 },
    revenue: [{ revenue: 300 }, { revenue: 330 }, { revenue: 363 }, { revenue: 399.3 }],
  };
  const v = valuationInputs(facts);
  assert.equal(v.inputs.fcf, 108000);
  assert.equal(v.inputs.netDebt, 70000);
  assert.equal(v.inputs.shares, 15000);
  assert.ok(Math.abs(v.inputs.growth - 0.1) < 1e-9);
  assert.deepEqual(v.missing, []);
  assert.match(v.sources.fcf, /2025-09-27/);
  assert.match(v.sources.netDebt, /2025-09-27/);
});

test("valuation inputs say what is missing instead of inventing it", () => {
  const v = valuationInputs({ revenue: [{ revenue: 100 }, { revenue: 1000 }] });
  assert.equal(v.inputs.fcf, null);
  assert.equal(v.inputs.shares, null);
  assert.equal(v.inputs.growth, 0.15);
  assert.equal(v.inputs.netDebt, 0);
  assert.deepEqual(v.missing, ["free cash flow", "debt", "cash", "shares"]);
  // Debt split into current and non-current parts is summed.
  const parts = valuationInputs({
    LongTermDebtNoncurrent: { units: { USD: [fact("2025-12-31", 80e6)] } },
    LongTermDebtCurrent: { units: { USD: [fact("2025-12-31", 20e6)] } },
    WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [fact("2025-12-31", 50e6, "2025-01-01")] } },
  });
  assert.equal(parts.inputs.netDebt, 100);
  assert.equal(parts.inputs.shares, 50);
  assert.equal(annualSeries(null).length, 0);
  assert.equal(latestInstant({ units: { USD: [fact("2025-01-01", 1, "2024-01-01")] } }), null);
});

test("valuation XBRL concepts match the desktop whitelist", async () => {
  const { readFileSync } = await import("node:fs");
  const { VALUE_TAGS } = await import("../src/sec-tags.js");
  const rust = readFileSync(new URL("../src-tauri/src/sec.rs", import.meta.url), "utf8");
  const block = rust.match(/pub const VALUE_TAGS: \[&str; (\d+)\] = \[([\s\S]*?)\];/);
  assert.ok(block, "VALUE_TAGS not found in sec.rs");
  assert.deepEqual([...block[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]), VALUE_TAGS);
  assert.equal(Number(block[1]), VALUE_TAGS.length);
});
