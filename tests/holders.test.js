import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseCommand,
  sharesSeries,
  sharesAt,
  compareHolders,
  ownershipHistory,
  comparePortfolio,
  parseSchedule13,
  bigHolders,
  parseOwnership,
  insiderSummary,
  ownershipFilings,
  alphaSymbol,
} from "../src/holders.js";

const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

test("terminal commands accept either order and ignore filler words", () => {
  assert.deepEqual(parseCommand("aapl hds"), { command: "HDS", page: "Stock", view: "HDS", ticker: "AAPL" });
  assert.deepEqual(parseCommand("HDS MSFT"), { command: "HDS", page: "Stock", view: "HDS", ticker: "MSFT" });
  assert.deepEqual(parseCommand("AAPL US Equity HDS <GO>"), { command: "HDS", page: "Stock", view: "HDS", ticker: "AAPL" });
  assert.equal(parseCommand("HDS").ticker, null);
  assert.equal(parseCommand("AAPL"), null);
  assert.equal(parseCommand("EQS").page, "Universe");
});

test("shares outstanding sums share classes reported on one date", () => {
  const s = sharesSeries({
    units: {
      shares: [
        { end: "2026-04-17", val: 100, filed: "2026-05-01", accn: "a" },
        { end: "2026-07-18", val: 90, filed: "2026-08-01", accn: "b" },
        { end: "2026-07-18", val: 10, filed: "2026-08-01", accn: "b" },
      ],
    },
  });
  assert.equal(s.length, 2);
  assert.equal(s[1].shares, 100);
  assert.equal(s[1].classes, 2);
  assert.equal(sharesAt(s, "2026-06-30").date, "2026-04-17");
  assert.equal(sharesAt(s, "2026-01-01").date, "2026-04-17"); // nothing earlier
  assert.equal(sharesAt([], "2026-01-01"), null);
});

const row = (period, cik, shares, value, extra = {}) => ({
  period,
  cik,
  putcall: 0,
  shares,
  value,
  portfolio: 10000,
  positions: 50,
  rank: 3,
  name: `Fund ${cik}`,
  filed: "2026-08-10",
  accession: `acc-${cik}`,
  ...extra,
});
const data = {
  period: "2026-06-30",
  prior: "2026-03-31",
  reported: [4],
  tenure: { 1: { quarters: 4, since: "2025-09-30" } },
  rows: [
    row("2026-06-30", 1, 150, 1500), // added
    row("2026-03-31", 1, 100, 900),
    row("2026-06-30", 2, 50, 500), // new
    row("2026-06-30", 3, 80, 800), // reduced
    row("2026-03-31", 3, 100, 950),
    row("2026-03-31", 4, 70, 600), // sold out (filed without it)
    row("2026-03-31", 5, 30, 300), // hasn't filed yet
    { ...row("2026-06-30", 1, 20, 200), putcall: 1 },
    { ...row("2026-06-30", 2, 40, 400), putcall: 2 },
  ],
};

test("holders are classified new, added, reduced, sold out or not yet filed", () => {
  const r = compareHolders(data, 1000);
  const by = Object.fromEntries(r.holders.map((h) => [h.cik, h]));
  assert.equal(by[1].status, "added");
  assert.equal(by[1].change, 50);
  assert.equal(by[1].changePct, 0.5);
  assert.equal(by[1].weight, 0.15);
  assert.equal(by[1].pctOut, 0.15);
  assert.equal(by[1].quarters, 4);
  assert.equal(by[2].status, "new");
  assert.equal(by[3].status, "reduced");
  assert.equal(by[4].status, "exited");
  assert.equal(by[4].change, -70);
  assert.equal(by[5].status, "not-filed");
  assert.equal(by[5].change, null);
  assert.equal(r.holders[0].cik, 1); // largest first
  const s = r.summary;
  assert.equal(s.holders, 3);
  assert.equal(s.shares, 280);
  assert.equal(s.pctOut, 0.28);
  assert.equal(s.prevShares, 270); // excludes the manager that hasn't filed
  assert.deepEqual([s.newPositions, s.added, s.reduced, s.exited, s.notFiled], [1, 1, 1, 1, 1]);
  assert.equal(s.bought, 100);
  assert.equal(s.sold, 90);
  assert.equal(s.netChange, 10);
  assert.equal(s.putCall, 0.5);
  assert.equal(r.options.length, 2);
  assert.equal(r.options[0].status, "new");
});

test("ownership history adds % of shares outstanding per quarter", () => {
  const h = ownershipHistory([{ period: "2026-06-30", shares: 50 }], [{ date: "2026-04-17", shares: 200 }]);
  assert.equal(h[0].pctOut, 0.25);
});

test("a manager's portfolio shows new, added and sold-out positions", () => {
  const p = comparePortfolio({
    period: "2026-06-30",
    prior: "2026-03-31",
    filings: [
      { period: "2026-06-30", total: 1000, positions: 2 },
      { period: "2026-03-31", total: 800, positions: 2 },
    ],
    rows: [
      { period: "2026-06-30", cusip: "A", putcall: 0, shares: 10, value: 600 },
      { period: "2026-03-31", cusip: "A", putcall: 0, shares: 5, value: 280 },
      { period: "2026-06-30", cusip: "B", putcall: 0, shares: 4, value: 400 },
      { period: "2026-03-31", cusip: "C", putcall: 0, shares: 9, value: 520 },
    ],
  });
  const by = Object.fromEntries(p.rows.map((r) => [r.cusip, r]));
  assert.equal(by.A.status, "added");
  assert.equal(by.A.flow, 300); // 5 shares bought at 60
  assert.equal(by.A.weight, 0.6);
  assert.equal(by.B.status, "new");
  assert.equal(by.C.status, "exited");
  assert.equal(p.summary.positions, 2);
  assert.equal(p.summary.sold, 520);
});

test("Schedule 13G cover page gives the owner, shares, percent and CUSIP", () => {
  const g = parseSchedule13(fixture("schedule13g.xml"));
  assert.equal(g.form, "SCHEDULE 13G");
  assert.equal(g.activist, false);
  assert.deepEqual(g.cusips, ["037833100"]);
  assert.equal(g.eventDate, "2026-03-31");
  assert.equal(g.persons[0].name, "Vanguard Capital Management");
  assert.equal(g.persons[0].shares, 1099168953);
  assert.equal(g.persons[0].percent, 7.48);
  assert.equal(g.persons[0].soleVote, 145321305);
  assert.equal(g.persons[0].type, "IA");
  assert.equal(g.filerCik, "0002100119");
});

test("Schedule 13D gives activist stake details and purpose", () => {
  const d = parseSchedule13(fixture("schedule13d.xml"));
  assert.equal(d.activist, true);
  assert.equal(d.amendment, true);
  assert.equal(d.amendmentNo, 11);
  assert.equal(d.eventDate, "2026-04-13");
  assert.equal(d.persons[0].shares, 173511);
  assert.equal(d.persons[0].percent, 6.5);
  assert.equal(d.persons[0].fundSource, "PF");
  assert.match(d.purpose, /Board representation/);
});

test("big holders keep each filer's latest schedule and its change", () => {
  const g = { ...parseSchedule13(fixture("schedule13g.xml")), filed: "2026-04-29", accession: "b", url: "u2" };
  const older = { ...g, filed: "2025-07-29", accession: "a", persons: [{ ...g.persons[0], shares: 1e9, percent: 7.1 }] };
  const out = { ...g, filerCik: "9", filed: "2026-01-01", accession: "c", persons: [{ name: "Former Holder", shares: 10, percent: 3.2 }] };
  const rows = bigHolders([older, g, out]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Vanguard Capital Management");
  assert.equal(rows[0].change, 99168953);
  assert.equal(rows[0].prevPercent, 7.1);
  assert.equal(rows[0].filings, 2);
  assert.equal(rows[1].below5, true);
});

test("Form 4 parses the insider, role, trades and shares owned after", () => {
  const f = parseOwnership(fixture("form4.xml"));
  assert.equal(f.type, "4");
  assert.equal(f.issuer.symbol, "AAPL");
  assert.equal(f.owners[0].name, "Newstead Jennifer");
  assert.equal(f.owners[0].officer, true);
  assert.equal(f.owners[0].title, "SVP, GC and Government Affairs");
  assert.equal(f.plan, true);
  const [t] = f.rows;
  assert.deepEqual([t.code, t.shares, t.price, t.ad, t.after, t.direct], ["S", 2399, 325.75, "D", 29997, true]);
  const s = insiderSummary([{ ...f, filed: "2026-11-05", accession: "x", url: "u" }]);
  assert.equal(s.people[0].direct, 29997);
  assert.equal(s.people[0].role, "SVP, GC and Government Affairs");
  assert.equal(s.people[0].sold, 2399);
  assert.equal(s.summary.sells, 1);
  assert.equal(s.summary.planSales, 1);
  assert.ok(Math.abs(s.summary.soldValue - 2399 * 325.75) < 1e-6);
});

test("insider holdings come from each person's latest form only", () => {
  const form = (filed, after, code = "P") => ({
    type: "4",
    filed,
    accession: filed,
    url: "",
    plan: false,
    owners: [{ cik: "1", name: "Director One", director: true }],
    rows: [
      { security: "Common Stock", date: filed, code, shares: 10, price: 5, ad: "A", after, direct: true, nature: "", derivative: false, holding: false },
      { security: "Common Stock", date: null, code: "", shares: null, price: null, ad: "", after: 400, direct: false, nature: "By Trust", derivative: false, holding: true },
    ],
  });
  const s = insiderSummary([form("2026-01-01", 100), form("2026-03-01", 110)]);
  assert.equal(s.people.length, 1);
  assert.equal(s.people[0].direct, 110);
  assert.equal(s.people[0].indirect, 400);
  assert.equal(s.people[0].bought, 20);
  assert.equal(s.people[0].role, "Director");
  assert.equal(s.log.length, 2);
});

test("ownership filings are split into schedules, legacy text and insider forms", () => {
  const f = ownershipFilings({
    cik: "320193",
    filings: {
      recent: {
        form: ["4", "SCHEDULE 13G/A", "SC 13G/A", "10-K", "3"],
        accessionNumber: ["0001-26-1", "0002-26-2", "0003-24-3", "0004-26-4", "0005-26-5"],
        filingDate: ["2026-11-05", "2026-03-26", "2024-02-14", "2026-10-31", "2026-01-02"],
        primaryDocument: ["xslF345X06/form4.xml", "xslSCHEDULE_13G_X02/primary_doc.xml", "d751537dsc13ga.htm", "a.htm", "xslF345X02/form3.xml"],
      },
    },
  });
  assert.equal(f.insiders.length, 2);
  assert.equal(f.insiders[0].doc, "form4.xml");
  assert.equal(f.schedules[0].doc, "primary_doc.xml");
  assert.equal(f.legacy.length, 1);
  assert.equal(f.schedules[0].url, "https://www.sec.gov/Archives/edgar/data/320193/0002262/xslSCHEDULE_13G_X02/primary_doc.xml");
});

test("listings outside the US map to Alpha Vantage suffixes where documented", () => {
  assert.equal(alphaSymbol("AAPL"), "AAPL");
  assert.equal(alphaSymbol("VOD:XLON"), "VOD.LON");
  assert.equal(alphaSymbol("SHOP:XTSE"), "SHOP.TRT");
  assert.equal(alphaSymbol("7203:XJPX"), null);
});
