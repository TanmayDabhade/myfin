import test from "node:test";
import assert from "node:assert/strict";
import {
  recentFilings,
  annualReports,
  revenueHistory,
  normalizeName,
  buildDirectory,
  extractCandidates,
  candidatesToGraph,
  compareMentions,
} from "../src/filings.js";
import { validateGraph, seedGraph } from "../src/relationships.js";

const submissions = {
  cik: "320193",
  filings: {
    recent: {
      form: ["8-K", "10-K", "4", "10-Q", "10-K"],
      filingDate: ["2026-11-04", "2026-11-03", "2026-11-01", "2026-08-01", "2025-10-31"],
      reportDate: ["", "2026-09-26", "", "2026-06-27", "2025-09-27"],
      accessionNumber: ["0000320193-26-000030", "0000320193-26-000026", "0000320193-26-000020", "0000320193-26-000010", "0000320193-25-000079"],
      primaryDocument: ["a.htm", "aapl-20260926.htm", "x.xml", "q.htm", "aapl-20250927.htm"],
    },
  },
};

test("recent filings skip ownership forms and link to EDGAR archives", () => {
  const f = recentFilings(submissions);
  assert.deepEqual(f.map((x) => x.form), ["8-K", "10-K", "10-Q", "10-K"]);
  assert.equal(f[1].url, "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm");
  assert.deepEqual(annualReports(submissions).map((x) => x.filed), ["2026-11-03", "2025-10-31"]);
});

test("revenue history keeps annual periods, latest restatement, and growth", () => {
  const usd = [
    { start: "2023-10-01", end: "2024-09-28", val: 391e9, form: "10-K", filed: "2024-11-01", accn: "a" },
    { start: "2024-09-29", end: "2025-09-27", val: 416e9, form: "10-K", filed: "2025-10-31", accn: "b" },
    { start: "2024-09-29", end: "2025-09-27", val: 416.1e9, form: "10-K", filed: "2026-11-03", accn: "c" },
    { start: "2025-06-29", end: "2025-09-27", val: 100e9, form: "10-K", filed: "2025-10-31", accn: "q" },
  ];
  const h = revenueHistory({ units: { USD: usd } });
  assert.equal(h.length, 2);
  assert.equal(h[1].revenue, 416.1e9);
  assert.ok(Math.abs(h[1].growth - (416.1 / 391 - 1)) < 1e-12);
  assert.equal(h[0].growth, null);
});

test("names normalize away legal suffixes and punctuation", () => {
  assert.equal(normalizeName("Taiwan Semiconductor Manufacturing Co., Ltd."), " TAIWAN SEMICONDUCTOR MANUFACTURING ");
  assert.equal(normalizeName("AT&T Inc."), " AT AND T ");
});

const tickers = {
  0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  1: { cik_str: 1046179, ticker: "TSM", title: "Taiwan Semiconductor Manufacturing Co Ltd" },
  2: { cik_str: 27419, ticker: "TGT", title: "Target Corp" },
  3: { cik_str: 1018724, ticker: "AMZN", title: "Amazon.com, Inc." },
  4: { cik_str: 804328, ticker: "QCOM", title: "Qualcomm Inc/DE" },
};

test("extracts directional candidates with disclosed concentration only", () => {
  const graph = seedGraph();
  const dir = buildDirectory(tickers, graph);
  const filer = { cik: "0000320193", name: "Apple Inc.", ticker: "AAPL", nodeId: "apple" };
  const text = [
    "The Company relies on Taiwan Semiconductor Manufacturing Company Limited as a sole-source supplier of processors.",
    "Net sales to Amazon.com, Inc., a reseller, accounted for 11% of total net sales in 2026.",
    "Our stores compete with Target in many markets and customers compare prices.",
    "Apple Inc. is a customer of itself in this made-up sentence about customers.",
    "We also mention Qualcomm in a sentence with no supply-chain cue at all here.",
  ].join("\n");
  const c = extractCandidates(text, dir, filer);
  assert.deepEqual(
    c.map((x) => [x.counterparty.ticker, x.role, x.revenueShare]),
    [["TSM", "supplier", null], ["AMZN", "customer", 0.11]],
  );
  assert.equal(c[1].revenueBasis, "total net sales");
});

test("candidates become unreviewed, valid, deduplicated graph edges", () => {
  const graph = seedGraph();
  const filer = { cik: "0000320193", name: "Apple Inc.", ticker: "AAPL", nodeId: "apple" };
  const filing = { accession: "0000320193-26-000026", filed: "2026-11-03", period: "2026-09-26", form: "10-K", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm" };
  const cands = extractCandidates(
    "Net sales to Amazon.com, Inc., a reseller, accounted for 11% of total net sales in 2026.",
    buildDirectory(tickers, graph),
    filer,
  );
  const first = candidatesToGraph(graph, filer, filing, cands, "2026-11-06");
  assert.equal(first.added, 1);
  const edge = first.graph.edges.at(-1);
  assert.equal(edge.review, "unreviewed");
  assert.equal(edge.supplier, "apple");
  assert.equal(edge.customer, "cik-0001018724");
  validateGraph(first.graph);
  const again = candidatesToGraph(first.graph, filer, filing, cands, "2026-11-06");
  assert.equal(again.added, 0);
});

test("comparison shows counterparties added and dropped since the prior report", () => {
  const m = (cik, role) => ({ counterparty: { cik }, role });
  const r = compareMentions([m("1", "supplier"), m("2", "customer")], [m("1", "supplier"), m("3", "supplier")]);
  assert.deepEqual([r.added.length, r.dropped.length, r.kept.length], [1, 1, 1]);
  assert.equal(r.dropped[0].counterparty.cik, "3");
});
