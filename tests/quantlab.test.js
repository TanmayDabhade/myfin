import test from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, validateStrategy, strategyHash, sha256, canonical } from "../src/quantlab/dsl.js";
import { backtest, makeSnapshot, prepareBars, signalSeries } from "../src/quantlab/engine.js";
import { metrics, validateConfig, defaultSplits, runExperiment, runDetail, folds, sweepGrid, correlations } from "../src/quantlab/research.js";
import { createStore, memoryBackend } from "../src/quantlab/store.js";

const day = (i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10);
// Weekdays only, so the calendar looks like a market's.
function bars(closes, opens = null) {
  const out = [];
  let d = 0;
  closes.forEach((c, i) => {
    while ([0, 6].includes(new Date(day(d)).getUTCDay())) d++;
    const o = opens ? opens[i] : c;
    out.push({ date: day(d++), open: o, high: Math.max(o, c) + 0.5, low: Math.min(o, c) - 0.5, close: c, volume: 1000 + i });
  });
  return out;
}
const always = { op: "gt", lhs: { indicator: { kind: "price", field: "close" } }, rhs: { constant: 0 } };
const never = { op: "lt", lhs: { indicator: { kind: "price", field: "close" } }, rhs: { constant: 0 } };
const strat = (entry, exit, extra = {}) => ({ schemaVersion: 1, name: "t", entry, exit, sizing: { method: "fixed_fraction", fraction: 1 }, constraints: { cooldownBars: 0, ...extra } });
const opts = (b, x = {}) => ({ from: b[0].date, to: b.at(-1).date, initialCash: 10000, ...x });

test("a signal at close t fills at the open of t+1, never earlier", () => {
  const b = bars([10, 11, 12, 13, 14], [10, 20, 30, 40, 50]);
  const r = backtest(b, strat(always, never), opts(b));
  assert.equal(r.fills[0].signalAt, b[0].date);
  assert.equal(r.fills[0].filledAt, b[1].date);
  assert.equal(r.fills[0].price, 20);
  assert.equal(r.fills[0].qty, 500);
});

test("a signal on the last bar of a window is logged, not filled", () => {
  const b = bars([10, 10, 10]);
  const enterLast = { op: "gt", lhs: { indicator: { kind: "price", field: "close" } }, rhs: { constant: 10 } };
  b[2].close = 11;
  b[2].high = 11.5;
  const r = backtest(b, strat(enterLast, never), opts(b));
  assert.equal(r.fills.length, 0);
  assert.equal(r.rejected[0].reason, "NO_NEXT_BAR_IN_WINDOW");
});

test("commission, minimum commission and slippage apply to entries and exits", () => {
  const b = bars([100, 100, 100, 100], [100, 100, 100, 100]);
  const exitAfterOne = strat(always, always);
  const r = backtest(b, exitAfterOne, opts(b, { commissionBps: 10, slippageBps: 50, minCommissionUsd: 5 }));
  const [buy, sell] = r.fills;
  assert.ok(Math.abs(buy.price - 100.5) < 1e-9);
  assert.ok(Math.abs(sell.price - 99.5) < 1e-9);
  assert.ok(buy.commission >= 5 && sell.commission >= 5);
  assert.ok(Math.abs(buy.commission - buy.qty * buy.price * 0.001) < 1e-9);
  const cost = buy.qty * buy.price + buy.commission;
  assert.ok(cost <= 10000);
  assert.ok(Math.abs(r.trades[0].pnl - (sell.qty * sell.price - sell.commission - cost)) < 1e-9);
  assert.ok(r.trades[0].pnl < 0);
});

test("position size respects cash and the max weight", () => {
  const b = bars([50, 50, 50], [50, 50, 50]);
  const r = backtest(b, strat(always, never), opts(b, { maxPositionWeight: 0.25 }));
  assert.equal(r.fills[0].qty, 50);
  const tiny = backtest(b, strat(always, never), opts(b, { initialCash: 40 }));
  assert.equal(tiny.fills.length, 0);
  assert.equal(tiny.rejected[0].reason, "INSUFFICIENT_CASH");
});

test("zero trades give null win rate, profit factor and expectancy, not 0 or Infinity", () => {
  const b = bars(Array.from({ length: 30 }, (_, i) => 10 + i));
  const m = metrics(backtest(b, strat(never, never), opts(b)), { minClosedTrades: 1 });
  assert.equal(m.trades, 0);
  for (const k of ["winRate", "profitFactor", "expectancy"]) assert.equal(m[k], null);
  assert.equal(m.informative, false);
  assert.equal(m.sharpe, null);
});

test("crossovers need the prior bar; warm-up bars never signal", () => {
  const b = bars([5, 4, 3, 2, 10, 11, 12]);
  const s = signalSeries(b, { op: "crosses_above", lhs: { indicator: { kind: "price", field: "close" } }, rhs: { indicator: { kind: "sma", period: 3 } } });
  assert.deepEqual(s, [false, false, false, false, true, false, false]);
});

test("results do not depend on input order; duplicates and bad bars are caught", () => {
  const b = bars(Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 5)));
  const s = TEMPLATES.sma_cross.build({ fast: 5, slow: 20 });
  const a = backtest(prepareBars(b).bars, s, opts(b));
  const shuffled = prepareBars([...b].reverse()).bars;
  assert.deepEqual(backtest(shuffled, s, opts(b)), a);
  const dup = prepareBars([...b, { ...b[3], close: 999 }]);
  assert.ok(dup.blocking.some((m) => m.includes("twice")));
  const split = [...b.slice(0, 40), ...b.slice(40).map((x) => ({ ...x, open: x.open / 4, high: x.high / 4, low: x.low / 4, close: x.close / 4 }))];
  assert.ok(prepareBars(split).warnings.some((m) => m.includes("split")));
});

test("bad strategy trees fail validation before any backtest", () => {
  const good = TEMPLATES.rsi_reversion.build({ period: 14, buyBelow: 30, sellAbove: 55 });
  assert.deepEqual(validateStrategy(good), []);
  const bad = [
    { ...good, entry: { op: "gt", lhs: { indicator: { kind: "sma", period: 1 } }, rhs: { constant: 3 } } },
    { ...good, entry: { op: "gt", lhs: { indicator: { kind: "rsi", period: 14 } }, rhs: { indicator: { kind: "sma", period: 20 } } } },
    { ...good, entry: { op: "eval", lhs: { constant: 1 }, rhs: { constant: 2 } } },
    { ...good, entry: { op: "gt", lhs: { indicator: { kind: "python", period: 3 } }, rhs: { constant: 1 } } },
    { ...good, entry: { all: [] } },
    { ...good, entry: { all: [{ all: [{ all: [{ all: [{ all: [good.entry] }] }] }] }] } },
    { ...good, sizing: { method: "fixed_fraction", fraction: 2 } },
    { ...good, code: "process.exit()" },
  ];
  for (const s of bad) assert.ok(validateStrategy(s).length, JSON.stringify(s));
});

test("sha256 matches the standard test vectors", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256("a".repeat(1000)).length, 64);
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

// ---- Experiments ----------------------------------------------------------
function series(n, seed = 1) {
  let x = 100,
    s = seed;
  const closes = [],
    opens = [];
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const shock = (s / 2147483647 - 0.5) * 0.04;
    opens.push(+(x * (1 + shock / 3)).toFixed(4));
    x = x * (1 + shock + 0.0004 * Math.sin(i / 30));
    closes.push(+x.toFixed(4));
  }
  return bars(closes, opens);
}
function experiment(mode, strategy, extra = {}) {
  const b = series(900);
  const snapshot = makeSnapshot({ symbol: "TEST", providerId: "fixture", adjustment: "synthetic", bars: b });
  const benchmark = makeSnapshot({ symbol: "SPY", providerId: "fixture", adjustment: "synthetic", bars: series(900, 7) });
  const config = {
    schemaVersion: 1,
    name: "T",
    mode,
    universe: { instrumentIds: ["TEST"], survivorshipPolicy: "fixed_declared" },
    benchmarkInstrumentId: "SPY",
    data: { providerId: "fixture", frequency: "1d", from: snapshot.from, to: snapshot.to, priceAdjustment: "split_only", snapshotPolicy: "freeze" },
    portfolio: { initialCash: 10000, currency: "USD", longOnly: true, maxPositionWeight: 1 },
    execution: { signalAt: "close", fillAt: "next_open", commissionBps: 1, slippageBps: 2, minCommissionUsd: 0 },
    validation: { ...defaultSplits(snapshot.bars.map((x) => x.date), 5), walkForwardFolds: 3, embargoBars: 5, minClosedTrades: 3 },
    strategy,
    search: { seed: 42, maxCandidates: 60, maxParallelJobs: 1 },
    ...extra,
  };
  return { config, data: { snapshot, benchmark } };
}

test("config validation rejects overlapping windows and oversized budgets", () => {
  const { config, data } = experiment("manual", TEMPLATES.sma_cross.build({ fast: 10, slow: 30 }));
  const dates = data.snapshot.bars.map((b) => b.date);
  assert.deepEqual(validateConfig(config, dates), []);
  const overlap = structuredClone(config);
  overlap.validation.holdout.from = overlap.validation.validation.to;
  assert.ok(validateConfig(overlap, dates).some((m) => m.includes("overlap")));
  const greedy = structuredClone(config);
  greedy.search.maxCandidates = 1e6;
  assert.ok(validateConfig(greedy, dates).length);
  const fold = folds(dates, config.validation.validation, 3, 5);
  assert.ok(fold[0].to < fold[1].from && fold[1].to < fold[2].from);
});

test("search never touches the holdout window", async () => {
  const { config, data } = experiment("sweep", { template: "sma_cross", ranges: { fast: { from: 5, to: 20, step: 5 }, slow: { from: 30, to: 60, step: 15 } } });
  const out = await runExperiment(config, data);
  const h = config.validation.holdout.from;
  for (const c of out.candidates) {
    for (const m of [c.train, c.validation, ...c.folds]) assert.ok(m.to < h, `${m.to} reaches the holdout`);
  }
  assert.equal(out.candidates.length, sweepGrid(config.strategy).length);
});

test("identical seed, data and config give identical discovery rankings", async () => {
  const d = { schemaVersion: 1, allowedIndicators: ["sma", "ema", "rsi", "atr", "price", "volume"], maxExpressionDepth: 3, population: 10, generations: 3, mutationRate: 0.6, crossoverRate: 0.5, objective: "validation_sharpe_with_penalties" };
  const a = experiment("discovery", d),
    b = experiment("discovery", d);
  const ra = await runExperiment(a.config, a.data),
    rb = await runExperiment(b.config, b.data);
  assert.ok(ra.evaluated > 10 && ra.evaluated <= 60);
  assert.deepEqual(ra.candidates.map((c) => [c.strategyId, c.score, c.rank]), rb.candidates.map((c) => [c.strategyId, c.score, c.rank]));
  for (const c of ra.candidates) assert.deepEqual(validateStrategy(c.strategy, 3), []);
  const other = experiment("discovery", d, { search: { seed: 7, maxCandidates: 60, maxParallelJobs: 1 } });
  const rc = await runExperiment(other.config, other.data);
  assert.notDeepEqual(rc.candidates.map((c) => c.strategyId), ra.candidates.map((c) => c.strategyId));
});

test("cancelling keeps finished candidates and reports cancelled", async () => {
  const { config, data } = experiment("sweep", { template: "sma_cross", ranges: { fast: { from: 5, to: 50, step: 5 }, slow: { from: 60, to: 100, step: 10 } } });
  let n = 0;
  const out = await runExperiment(config, data, { emit: (t) => t === "progress" && n++, cancelled: () => n >= 1 });
  assert.equal(out.cancelled, true);
  assert.ok(out.candidates.length >= 10 && out.candidates.length < sweepGrid(config.strategy).length);
});

test("runs reproduce byte for byte from the same manifest inputs", () => {
  const { config, data } = experiment("manual", TEMPLATES.ema_cross.build({ fast: 12, slow: 34 }));
  const a = runDetail(config, data, config.strategy, "validation", config.validation.validation);
  const b = runDetail(config, data, config.strategy, "validation", config.validation.validation);
  assert.equal(a.id, b.id);
  assert.equal(a.artifactsSha256, b.artifactsSha256);
  assert.equal(a.manifest.dataset.sha256, data.snapshot.contentSha256);
  assert.equal(a.manifest.strategySha256, strategyHash(config.strategy));
  assert.equal(a.initialCash, config.portfolio.initialCash);
  // Fill timestamps line up with the bars the chart draws.
  for (const f of a.fills) assert.ok(a.dates.includes(f.filledAt));
  const changed = runDetail({ ...config, execution: { ...config.execution, commissionBps: 5 } }, data, config.strategy, "validation", config.validation.validation);
  assert.notEqual(changed.id, a.id);
  const corr = correlations([a, b]);
  assert.ok(Math.abs(corr[0][1] - 1) < 1e-9 || corr[0][1] === null);
});

test("a frozen selection's holdout is evaluated once and a later one is not untouched", async () => {
  const { config, data } = experiment("sweep", { template: "sma_cross", ranges: { fast: { from: 5, to: 15, step: 5 }, slow: { from: 30, to: 60, step: 30 } } });
  const out = await runExperiment(config, data);
  const store = createStore(memoryBackend());
  const exp = { id: "exp_1", status: "completed", candidates: out.candidates, datasetId: data.snapshot.id };
  await store.saveExperiment(exp);
  const sel = await store.freezeSelection(exp, [out.candidates[0].strategyId]);
  assert.equal(sel.holdoutPreviouslyViewed, false);
  const run = runDetail(config, data, sel.strategies[0], "holdout", config.validation.holdout);
  const rec = await store.recordHoldout(exp, sel, [run]);
  assert.equal(rec.untouched, true);
  await assert.rejects(store.recordHoldout(exp, sel, [run]), /already evaluated/);
  await assert.rejects(store.backend.put("holdout", sel.id, exp.id, { tampered: true }, true), /already recorded/);
  const second = await store.freezeSelection(exp, [out.candidates[1].strategyId]);
  assert.equal(second.holdoutPreviouslyViewed, true);
  const rec2 = await store.recordHoldout(exp, second, [runDetail(config, data, second.strategies[0], "holdout", config.validation.holdout)]);
  assert.equal(rec2.untouched, false);
  assert.equal(exp.holdout.evaluations, 2);
});

test("manual mode with too few trades is not statistically informative, never passed", async () => {
  const { config, data } = experiment("manual", TEMPLATES.sma_cross.build({ fast: 50, slow: 200 }), {});
  config.validation.minClosedTrades = 50;
  const out = await runExperiment(config, data);
  assert.equal(out.candidates[0].verdict === "ranked", false);
});
