import test from "node:test";
import assert from "node:assert/strict";
import {
  book,
  execute,
  portfolio,
  dcf,
  risk,
  correlation,
  validateBars,
  parseCSV,
  csv,
  normalizeAlpha,
  validateWorkspace,
  checkAlerts,
} from "../src/engine.js";
import { sample } from "../src/sample.js";
const account = () => ({ initial: 1000, trades: [] });
const buy = (a, qty = 2, price = 100, fee = 1) =>
  execute(a, { symbol: "AAPL", side: "buy", qty, price, fee });
const bars = [100, 110, 99, 120].map((c, i) => ({
  date: `2026-01-0${i + 1}`,
  open: c,
  high: c,
  low: c,
  close: c,
  volume: 10,
}));
test("buy accounts for fees and cash", () => {
  const b = book(buy(account()));
  assert.equal(b.cash, 799);
  assert.equal(b.holdings.AAPL.cost, 201);
});
test("partial sell uses average cost", () => {
  const a = execute(buy(account()), {
    symbol: "AAPL",
    side: "sell",
    qty: 1,
    price: 120,
    fee: 1,
  });
  const b = book(a);
  assert.equal(b.cash, 918);
  assert.equal(b.realized, 18.5);
  assert.equal(b.holdings.AAPL.cost, 100.5);
});
test("round trip reconciles equity and realized profit", () => {
  const a = execute(buy(account()), {
    symbol: "AAPL",
    side: "sell",
    qty: 2,
    price: 120,
    fee: 1,
  });
  assert.equal(book(a).cash, 1038);
  assert.equal(book(a).realized, 38);
});
test("reject insufficient cash, shorts, invalid numbers", () => {
  assert.throws(() => buy(account(), 20));
  assert.throws(() => buy(account(), NaN));
  assert.throws(() => buy(account(), -1));
  assert.throws(() =>
    execute(account(), { symbol: "AAPL", side: "sell", qty: 1, price: 100 }),
  );
  assert.throws(() => buy(account(), 1, Infinity));
});
test("fractional shares", () =>
  assert.equal(book(buy(account(), 0.25, 100, 0)).cash, 975));
test("portfolio marks missing data explicitly", () => {
  const p = portfolio(buy(account()), {});
  assert.equal(p.incomplete, true);
  assert.equal(p.value, 1000);
  assert.equal(p.positions[0].price, null);
});
test("portfolio mark reconciliation", () => {
  const p = portfolio(buy(account()), { AAPL: { bars } });
  assert.equal(p.value, 1039);
  assert.equal(p.unrealized, 39);
});
test("DCF zero growth perpetuity", () => {
  const v = dcf({
    fcf: 100,
    growth: 0,
    discount: 0.1,
    terminal: 0,
    netDebt: 0,
    shares: 10,
  });
  assert.ok(Math.abs(v.perShare - 100) < 1e-9);
});
test("DCF rejects divergent terminal growth", () =>
  assert.throws(() =>
    dcf({
      fcf: 100,
      growth: 0,
      discount: 0.02,
      terminal: 0.03,
      netDebt: 0,
      shares: 10,
    }),
  ));
test("risk drawdown and returns", () => {
  const r = risk(bars);
  assert.ok(Math.abs(r.drawdown + 0.1) < 1e-9);
  assert.ok(Math.abs(r.total - 0.2) < 1e-9);
  assert.equal(r.observations, 3);
});
test("correlation aligns dates", () =>
  assert.ok(Math.abs(correlation(bars, bars) - 1) < 1e-9));
test("insufficient risk history", () =>
  assert.equal(risk(bars.slice(0, 1)), null));
test("CSV quotes, commas, newline fields", () =>
  assert.deepEqual(parseCSV('name,note\r\n"A,B","C\nD"\r\n'), [
    { name: "A,B", note: "C\nD" },
  ]));
test("CSV export neutralizes spreadsheet formulas", () =>
  assert.ok(csv([{ name: '=HYPERLINK("x")' }]).includes("'=HYPERLINK")));
test("reject malformed OHLC, duplicate dates, impossible dates", () => {
  assert.throws(() => validateBars([{ ...bars[0], high: 1 }]));
  assert.throws(() => validateBars([bars[0], bars[0]]));
  assert.throws(() => validateBars([{ ...bars[0], date: "2026-02-30" }]));
});
test("normalize API response", () =>
  assert.equal(
    normalizeAlpha({
      "Time Series (Daily)": {
        "2026-01-01": {
          "1. open": "100",
          "2. high": "101",
          "3. low": "99",
          "4. close": "100",
          "5. volume": "10",
        },
      },
    })[0].close,
    100,
  ));
test("sample backup roundtrip", () =>
  assert.equal(
    validateWorkspace(JSON.parse(JSON.stringify(sample()))).version,
    1,
  ));
test("alerts trigger and remain latched", () => {
  const a = checkAlerts([{ symbol: "AAPL", direction: "above", target: 110 }], {
    AAPL: { bars },
  });
  assert.equal(a[0].triggered, true);
  assert.equal(checkAlerts(a, {})[0].triggered, true);
});

import { equityCurve } from "../src/engine.js";
test("historical equity uses historical marks, not latest price", () => {
  let a = execute(account(), {
    symbol: "AAPL",
    side: "buy",
    qty: 2,
    price: 110,
    fee: 1,
    date: "2026-01-02T12:00:00Z",
  });
  let c = equityCurve(a, { AAPL: { bars } });
  assert.deepEqual(
    c.map((x) => x.close),
    [1000, 999, 977, 1019],
  );
});
