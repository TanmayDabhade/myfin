import test from "node:test";
import assert from "node:assert/strict";
import { execute, book, requirements, settleExpiries, portfolio, parseContract } from "../src/engine.js";

const opt = (symbol, side, qty, price, extra = {}) => ({ symbol, side, qty, price, fee: 0.65, instrument: "option", multiplier: 100, date: "2026-11-02T15:00:00Z", ...extra });
const C250 = "AAPL261218C00250000",
  C260 = "AAPL261218C00260000",
  P240 = "AAPL261218P00240000",
  P230 = "AAPL261218P00230000";

test("contracts parse and long options cost premium × 100", () => {
  assert.deepEqual(parseContract(C250), { underlying: "AAPL", expiry: "2026-12-18", kind: "call", strike: 250 });
  const a = execute({ initial: 10000, trades: [] }, opt(C250, "buy", 2, 5.1));
  const b = book(a);
  assert.ok(Math.abs(b.cash - (10000 - 2 * 5.1 * 100 - 0.65)) < 1e-9);
  assert.equal(b.holdings[C250].qty, 2);
  // Closing half realizes against half the basis.
  const c = book(execute(a, opt(C250, "sell", 1, 7, { date: "2026-11-03T15:00:00Z" })));
  assert.ok(Math.abs(c.realized - (700 - 0.65 - (1020 + 0.65) / 2)) < 1e-9);
  assert.throws(() => execute({ initial: 100, trades: [] }, opt(C250, "buy", 1, 5)), /Insufficient paper cash/);
  assert.throws(() => execute({ initial: 1e5, trades: [] }, opt(C250, "buy", 1.5, 5)), /whole contracts/);
});

test("short calls need shares or a long call; naked calls are refused", () => {
  const empty = { initial: 50000, trades: [] };
  assert.throws(() => execute(empty, opt(C250, "sell", 1, 5)), /Naked short calls/);
  // Covered call: 100 shares cover one contract.
  let a = execute(empty, { symbol: "AAPL", side: "buy", qty: 100, price: 248, date: "2026-11-02T14:00:00Z" });
  a = execute(a, opt(C260, "sell", 1, 2));
  assert.equal(book(a).holdings[C260].qty, -1);
  assert.equal(requirements(book(a).holdings).lockedShares.AAPL, 100);
  // The covering shares can't be sold while the call is open.
  assert.throws(() => execute(a, { symbol: "AAPL", side: "sell", qty: 50, price: 250, date: "2026-11-03T14:00:00Z" }), /uncovered/);
  // Call spread: long 250, short 260 reserves nothing (long strike below short).
  let s = execute(empty, opt(C250, "buy", 1, 6));
  s = execute(s, opt(C260, "sell", 1, 2));
  assert.equal(requirements(book(s).holdings).required, 0);
  // Reverse: short 250 covered by a long 260 reserves the 10-point width.
  let r = execute(empty, opt(C260, "buy", 1, 2));
  r = execute(r, opt(C250, "sell", 1, 6));
  assert.equal(requirements(book(r).holdings).required, 1000);
});

test("short puts are cash-secured or part of a spread", () => {
  assert.throws(() => execute({ initial: 10000, trades: [] }, opt(P240, "sell", 1, 3)), /must be held against short puts/);
  const a = execute({ initial: 30000, trades: [] }, opt(P240, "sell", 1, 3));
  assert.equal(requirements(book(a).holdings).required, 24000);
  let s = execute({ initial: 10000, trades: [] }, opt(P230, "buy", 1, 1.5));
  s = execute(s, opt(P240, "sell", 1, 3));
  assert.equal(requirements(book(s).holdings).required, 1000, "put spread reserves its 10-point width");
  // A long can't flip straight to a short.
  assert.throws(() => execute(execute({ initial: 1e5, trades: [] }, opt(C250, "buy", 1, 5)), opt(C250, "sell", 2, 5)), /Close it first/);
});

test("expired options settle at intrinsic value", () => {
  let a = execute({ initial: 50000, trades: [] }, opt(C250, "buy", 2, 5));
  a = execute(a, opt(P240, "sell", 1, 3));
  const closes = { "2026-12-18": 262 };
  const settled = settleExpiries(a, (u, d) => closes[d], "2026-12-21");
  const b = book(settled);
  assert.equal(b.holdings[C250].qty, 0);
  assert.equal(b.holdings[P240].qty, 0);
  const t = settled.trades.filter((x) => x.source === "expiry");
  assert.equal(t.length, 2);
  assert.equal(t.find((x) => x.symbol === C250).price, 12);
  assert.equal(t.find((x) => x.symbol === P240).price, 0);
  assert.ok(Math.abs(b.realized - (2 * 100 * (12 - 5) - 0.65 + (300 - 0.65))) < 1e-6);
  // Nothing to do before expiry.
  assert.equal(settleExpiries(a, () => 262, "2026-12-18").trades.length, 2);
});

test("portfolio marks options by the given marks", () => {
  const a = execute({ initial: 10000, trades: [] }, opt(C250, "buy", 1, 5));
  const p = portfolio(a, {}, { [C250]: { price: 6, source: "model" } });
  assert.equal(p.positions[0].market, 600);
  assert.equal(p.positions[0].markSource, "model");
  assert.ok(Math.abs(p.value - (10000 - 500.65 + 600)) < 1e-9);
});
