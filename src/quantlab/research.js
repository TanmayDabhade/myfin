// Quant Lab research: metrics, chronological splits, walk-forward folds,
// candidate search and reproducible run manifests. Search and ranking use
// the training and validation windows only; the holdout is evaluated by
// evaluateHoldout, which the store lets run once per frozen selection.
import { ENGINE_VERSION, INDICATORS, PERIODS, TEMPLATES, canonical, describe, sha256, strategyHash, validateStrategy, unitOf } from "./dsl.js";
import { backtest, windowIndex } from "./engine.js";

export const LIMITS = { maxCandidates: 2000, population: 200, generations: 50, folds: 10, depth: 4 };
const YEAR = 252;

// ---- Metrics --------------------------------------------------------------
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
export function dailyReturns(equity, initial) {
  return equity.map((v, i) => v / (i ? equity[i - 1] : initial) - 1);
}
function drawdown(equity, initial) {
  let peak = initial,
    max = 0,
    since = 0,
    longest = 0;
  for (const v of equity) {
    if (v >= peak) {
      peak = v;
      since = 0;
    } else since++;
    longest = Math.max(longest, since);
    max = Math.min(max, v / peak - 1);
  }
  return { max, longest };
}

// Every metric is for one window. Values that the sample can't support are
// null, never 0 or Infinity.
export function metrics(run, { riskFree = 0, minClosedTrades = 10, benchmark = null } = {}) {
  const n = run.equity.length;
  if (!n) return { bars: 0, informative: false, note: "No bars in this window" };
  const r = dailyReturns(run.equity, run.initialCash);
  const end = run.equity.at(-1),
    total = end / run.initialCash - 1,
    years = n / YEAR;
  const sd = stdev(r);
  const vol = sd == null ? null : sd * Math.sqrt(YEAR);
  const sharpe = sd ? ((mean(r) - riskFree / YEAR) / sd) * Math.sqrt(YEAR) : null;
  const dd = drawdown(run.equity, run.initialCash);
  const cagr = years >= 1 ? (end / run.initialCash) ** (1 / years) - 1 : null;
  const closed = run.trades.length,
    enough = closed >= minClosedTrades;
  const wins = run.trades.filter((t) => t.pnl > 0),
    losses = run.trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0),
    grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const traded = run.fills.reduce((s, f) => s + f.qty * f.price, 0);
  const avgEquity = mean(run.equity);
  const realized = run.trades.reduce((s, t) => s + t.pnl, 0);
  const out = {
    bars: n,
    from: run.dates[0],
    to: run.dates.at(-1),
    totalReturn: total,
    cagr,
    vol,
    sharpe,
    maxDrawdown: dd.max,
    drawdownBars: dd.longest,
    calmar: cagr != null && dd.max < 0 ? cagr / -dd.max : null,
    exposure: mean(run.exposure),
    turnover: avgEquity > 0 ? traded / avgEquity / Math.max(years, 1 / YEAR) : null,
    trades: closed,
    entries: run.fills.filter((f) => f.side === "buy").length,
    winRate: enough ? wins.length / closed : null,
    profitFactor: enough && grossLoss > 0 ? grossWin / grossLoss : null,
    expectancy: enough ? realized / closed : null,
    realizedPnl: realized,
    unrealizedPnl: run.openPosition?.unrealizedPnl ?? 0,
    costs: run.fills.reduce((s, f) => s + f.commission + f.slippage, 0),
    informative: enough,
    riskFree,
  };
  if (benchmark) {
    const b = benchmarkReturn(benchmark, run.dates);
    out.benchmarkReturn = b;
    out.excessReturn = b == null ? null : total - b;
  }
  return out;
}

// Buy-and-hold close to close over the same dates, no costs, no dividends
// beyond what the provider's adjustment includes.
export function benchmarkReturn(bench, dates) {
  const closes = benchmarkCurve(bench, dates);
  const known = closes.filter((x) => x != null);
  return known.length > 1 ? known.at(-1) / known[0] - 1 : null;
}
export function benchmarkCurve(bench, dates) {
  const map = new Map(bench.bars.map((b) => [b.date, b.close]));
  return dates.map((d) => map.get(d) ?? null);
}

// ---- Configuration --------------------------------------------------------
const addBars = (dates, date, k) => {
  const i = dates.findIndex((d) => d >= date);
  return i < 0 ? null : dates[Math.min(dates.length - 1, i + k)];
};
// Default chronological windows over the available bars: 60% train,
// 25% validation, 15% holdout, with `embargo` bars between them.
export function defaultSplits(dates, embargo = 5) {
  const n = dates.length,
    t = Math.floor(n * 0.6),
    v = Math.floor(n * 0.85);
  return {
    train: { from: dates[0], to: dates[t - 1] },
    validation: { from: dates[Math.min(n - 1, t + embargo)], to: dates[v - 1] },
    holdout: { from: dates[Math.min(n - 1, v + embargo)], to: dates[n - 1] },
  };
}

function barsBetween(dates, from, to) {
  return dates.filter((d) => d > from && d < to).length;
}

// Problems that stop an experiment before any work starts.
export function validateConfig(c, dates = null) {
  const e = [];
  if (!c || c.schemaVersion !== 1) return ["Unsupported experiment config"];
  if (!c.name?.trim()) e.push("Name the experiment.");
  if (!["manual", "sweep", "discovery"].includes(c.mode)) e.push("Unknown mode.");
  const ids = c.universe?.instrumentIds || [];
  if (ids.length !== 1) e.push("This version backtests one instrument per experiment.");
  if (!/^[A-Z0-9.\-^:&]{1,20}$/.test(ids[0] || "")) e.push("Choose a valid symbol.");
  if (!/^[A-Z0-9.\-^:&]{1,20}$/.test(c.benchmarkInstrumentId || "")) e.push("Choose a valid benchmark symbol.");
  const p = c.portfolio || {};
  if (!(p.initialCash >= 1000 && p.initialCash <= 1e9)) e.push("Starting cash must be $1,000 to $1,000,000,000.");
  if (!(p.maxPositionWeight > 0 && p.maxPositionWeight <= 1)) e.push("Max position weight must be above 0% and at most 100%.");
  const x = c.execution || {};
  if (x.signalAt !== "close" || x.fillAt !== "next_open") e.push("Signals are taken at the close and filled at the next open.");
  for (const k of ["commissionBps", "slippageBps"]) if (!(x[k] >= 0 && x[k] <= 500)) e.push(`${k} must be 0 to 500 basis points.`);
  if (!(x.minCommissionUsd >= 0 && x.minCommissionUsd <= 100)) e.push("Minimum commission must be $0 to $100.");
  const v = c.validation || {};
  const w = ["train", "validation", "holdout"].map((k) => v[k]);
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (w.some((x) => !x || !iso.test(x.from) || !iso.test(x.to) || x.from > x.to)) e.push("Each window needs a start date on or before its end date.");
  else {
    if (!(w[0].to < w[1].from && w[1].to < w[2].from)) e.push("Windows must be in order (train, then validation, then holdout) and must not overlap.");
    if (dates) {
      if (w[0].from < dates[0] || w[2].to > dates.at(-1)) e.push(`The data covers ${dates[0]} to ${dates.at(-1)}; keep the windows inside it.`);
      const emb = v.embargoBars || 0;
      if (barsBetween(dates, w[0].to, w[1].from) < emb || barsBetween(dates, w[1].to, w[2].from) < emb) e.push(`Leave at least ${emb} embargo bars between windows.`);
      const len = (x) => dates.filter((d) => d >= x.from && d <= x.to).length;
      if (len(w[0]) < 60) e.push("The training window needs at least 60 bars.");
      if (len(w[1]) < 20 * Math.max(1, v.walkForwardFolds || 1)) e.push("The validation window needs at least 20 bars per fold.");
      if (len(w[2]) < 20) e.push("The holdout window needs at least 20 bars.");
    }
  }
  if (!Number.isInteger(v.walkForwardFolds) || v.walkForwardFolds < 1 || v.walkForwardFolds > LIMITS.folds) e.push(`Folds must be 1 to ${LIMITS.folds}.`);
  if (!Number.isInteger(v.embargoBars) || v.embargoBars < 0 || v.embargoBars > 60) e.push("Embargo must be 0 to 60 bars.");
  if (!Number.isInteger(v.minClosedTrades) || v.minClosedTrades < 1 || v.minClosedTrades > 500) e.push("Minimum closed trades must be 1 to 500.");
  const s = c.search || {};
  if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 2 ** 31) e.push("Seed must be a whole number.");
  if (!Number.isInteger(s.maxCandidates) || s.maxCandidates < 1 || s.maxCandidates > LIMITS.maxCandidates) e.push(`Search budget must be 1 to ${LIMITS.maxCandidates} candidates.`);
  if (c.mode === "manual") e.push(...validateStrategy(c.strategy).map((m) => "Strategy: " + m));
  if (c.mode === "sweep") e.push(...sweepProblems(c.strategy, s.maxCandidates));
  if (c.mode === "discovery") e.push(...discoveryProblems(c.strategy));
  return e;
}

// ---- Parameter sweep ------------------------------------------------------
function range({ from, to, step }) {
  const out = [];
  for (let v = from; v <= to + 1e-9 && out.length <= LIMITS.maxCandidates; v += step) out.push(+v.toFixed(6));
  return out;
}
export function sweepGrid(spec) {
  const t = TEMPLATES[spec?.template];
  if (!t) return [];
  const names = Object.keys(t.params);
  let combos = [{}];
  for (const k of names) combos = combos.flatMap((c) => range(spec.ranges[k]).map((v) => ({ ...c, [k]: v })));
  return combos.filter(t.valid).map((p) => t.build(p));
}
function sweepProblems(spec, budget) {
  const t = TEMPLATES[spec?.template];
  if (!t) return ["Choose a template to sweep."];
  const e = [];
  for (const [k, [lo, hi]] of Object.entries(t.params)) {
    const r = spec.ranges?.[k];
    if (!r || !(r.step > 0) || r.from > r.to || r.from < lo || r.to > hi) e.push(`${k}: range must be inside ${lo}–${hi} with a positive step.`);
  }
  if (e.length) return e;
  const n = sweepGrid(spec).length;
  if (!n) e.push("No valid parameter combinations in these ranges.");
  if (n > budget) e.push(`The sweep has ${n} combinations; raise the budget or narrow the ranges (budget ${budget}).`);
  return e;
}

// ---- Genetic discovery ----------------------------------------------------
function discoveryProblems(d) {
  const e = [];
  if (!d || d.schemaVersion !== 1) return ["Discovery settings missing"];
  if (!Array.isArray(d.allowedIndicators) || !d.allowedIndicators.length || d.allowedIndicators.some((k) => !INDICATORS.includes(k))) e.push("Pick indicators from the list.");
  if (!d.allowedIndicators?.some((k) => ["sma", "ema", "rsi"].includes(k))) e.push("Allow at least one of SMA, EMA or RSI.");
  if (!Number.isInteger(d.maxExpressionDepth) || d.maxExpressionDepth < 1 || d.maxExpressionDepth > LIMITS.depth) e.push(`Rule depth must be 1 to ${LIMITS.depth}.`);
  if (!Number.isInteger(d.population) || d.population < 4 || d.population > LIMITS.population) e.push(`Population must be 4 to ${LIMITS.population}.`);
  if (!Number.isInteger(d.generations) || d.generations < 1 || d.generations > LIMITS.generations) e.push(`Generations must be 1 to ${LIMITS.generations}.`);
  for (const k of ["mutationRate", "crossoverRate"]) if (!(d[k] >= 0 && d[k] <= 1)) e.push(`${k} must be 0 to 1.`);
  return e;
}
// mulberry32: small, fast and fully determined by the seed.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const PERIOD_CHOICES = [3, 5, 8, 10, 13, 15, 20, 26, 30, 34, 40, 50, 60, 75, 100, 150, 200];
const RSI_LEVELS = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90];
const periodFor = (r, kind) => pick(r, PERIOD_CHOICES.filter((p) => p >= PERIODS[kind][0] && p <= PERIODS[kind][1]));

function randomPredicate(r, allowed) {
  const kinds = [];
  if (allowed.includes("sma") || allowed.includes("ema")) kinds.push("trend", "trend");
  if (allowed.includes("rsi")) kinds.push("rsi", "rsi");
  if (allowed.includes("atr")) kinds.push("atr");
  if (allowed.includes("volume") && (allowed.includes("sma") || allowed.includes("ema"))) kinds.push("volume");
  const kind = pick(r, kinds);
  const ma = () => pick(r, ["sma", "ema"].filter((k) => allowed.includes(k)));
  if (kind === "rsi") return { op: pick(r, ["lt", "gt", "crosses_above", "crosses_below"]), lhs: { indicator: { kind: "rsi", period: pick(r, [2, 3, 5, 7, 9, 14, 21, 28]) } }, rhs: { constant: pick(r, RSI_LEVELS) } };
  if (kind === "atr") {
    const [a, b] = [periodFor(r, "atr"), periodFor(r, "atr")].sort((x, y) => x - y);
    return { op: pick(r, ["gt", "lt"]), lhs: { indicator: { kind: "atr", period: a } }, rhs: { indicator: { kind: "atr", period: a === b ? Math.min(100, b * 2) : b } } };
  }
  if (kind === "volume") return { op: "gt", lhs: { indicator: { kind: "volume" } }, rhs: { indicator: { kind: ma(), period: periodFor(r, "sma"), field: "volume" } } };
  const usePrice = allowed.includes("price") && r() < 0.4;
  const p1 = periodFor(r, "sma");
  let p2 = periodFor(r, "sma");
  if (p2 === p1) p2 = Math.min(400, p1 * 2);
  const lhs = usePrice ? { indicator: { kind: "price", field: "close" } } : { indicator: { kind: ma(), period: Math.min(p1, p2) } };
  return { op: pick(r, ["gt", "lt", "crosses_above", "crosses_below"]), lhs, rhs: { indicator: { kind: ma(), period: Math.max(p1, p2) } } };
}
function randomExpression(r, allowed, depth) {
  if (depth <= 1 || r() < 0.55) return randomPredicate(r, allowed);
  const n = int(r, 2, 3);
  return { [r() < 0.7 ? "all" : "any"]: Array.from({ length: n }, () => randomExpression(r, allowed, depth - 1)) };
}
function randomStrategy(r, d) {
  const s = {
    schemaVersion: 1,
    name: "",
    entry: randomExpression(r, d.allowedIndicators, d.maxExpressionDepth),
    exit: randomExpression(r, d.allowedIndicators, Math.min(2, d.maxExpressionDepth)),
    sizing: { method: "fixed_fraction", fraction: 1 },
    constraints: { cooldownBars: pick(r, [0, 0, 1, 3, 5]), ...(r() < 0.3 ? { maxHoldingBars: pick(r, [5, 10, 20, 40, 60]) } : {}) },
  };
  return named(s);
}
function named(s) {
  return { ...s, name: `Discovered ${strategyHash({ ...s, name: "" }).slice(0, 6)}` };
}
// Replace one random node (subtree) of an expression.
function nodes(expr, out = []) {
  out.push(expr);
  for (const e of expr.all || expr.any || []) nodes(e, out);
  return out;
}
function mutate(r, s, d) {
  const c = structuredClone(s);
  const roll = r();
  const target = r() < 0.65 ? "entry" : "exit";
  if (roll < 0.45) {
    const preds = nodes(c[target]).filter((n) => n.op);
    const p = pick(r, preds);
    for (const side of [p.lhs, p.rhs]) {
      if (side.indicator?.period) {
        const k = side.indicator.kind,
          [lo, hi] = PERIODS[k];
        side.indicator.period = Math.max(lo, Math.min(hi, Math.round(side.indicator.period * pick(r, [0.5, 0.75, 1.25, 1.5, 2]))));
      }
      if ("constant" in side) side.constant = pick(r, RSI_LEVELS);
    }
    if (r() < 0.3) p.op = pick(r, ["gt", "lt", "crosses_above", "crosses_below"]);
  } else if (roll < 0.85) {
    const all = nodes(c[target]);
    const victim = pick(r, all);
    const fresh = randomExpression(r, d.allowedIndicators, 2);
    for (const k of Object.keys(victim)) delete victim[k];
    Object.assign(victim, fresh);
  } else c.constraints = { cooldownBars: pick(r, [0, 1, 3, 5]), ...(r() < 0.3 ? { maxHoldingBars: pick(r, [5, 10, 20, 40, 60]) } : {}) };
  return named(c);
}
function crossover(r, a, b) {
  return named({ ...structuredClone(a), [r() < 0.5 ? "entry" : "exit"]: structuredClone(r() < 0.5 ? b.entry : b.exit) });
}

// ---- Candidate evaluation -------------------------------------------------
function execOpts(c, window) {
  return { from: window.from, to: window.to, initialCash: c.portfolio.initialCash, maxPositionWeight: c.portfolio.maxPositionWeight, commissionBps: c.execution.commissionBps, slippageBps: c.execution.slippageBps, minCommissionUsd: c.execution.minCommissionUsd };
}
// Walk-forward folds: the validation window cut into k consecutive pieces,
// with `embargo` bars dropped at the start of each piece after the first.
export function folds(dates, window, k, embargo) {
  const inside = dates.filter((d) => d >= window.from && d <= window.to);
  const size = Math.floor(inside.length / k);
  return Array.from({ length: k }, (_, i) => {
    const start = i * size + (i ? embargo : 0),
      end = i === k - 1 ? inside.length - 1 : (i + 1) * size - 1;
    return { from: inside[Math.min(start, end)], to: inside[end] };
  });
}
// The ranking score. Raw metrics are shown next to it.
export const SCORE_TEXT =
  "Mean walk-forward validation Sharpe, minus 2 × (worst fold drawdown beyond 25%), minus 0.05 × (annual turnover beyond 12×), minus 1 when validation has fewer closed trades than the minimum. Single-asset experiments have no concentration penalty.";
export function score(validation, foldMetrics, minTrades) {
  const sharpes = foldMetrics.map((m) => m.sharpe ?? 0);
  const worst = Math.min(0, ...foldMetrics.map((m) => m.maxDrawdown ?? 0));
  let s = mean(sharpes);
  s -= 2 * Math.max(0, -worst - 0.25);
  s -= 0.05 * Math.max(0, (validation.turnover ?? 0) - 12);
  if (validation.trades < minTrades) s -= 1;
  return +s.toFixed(6);
}
export function evaluateCandidate(config, data, strategy, cache) {
  const v = config.validation,
    bars = data.snapshot.bars,
    dates = bars.map((b) => b.date);
  const m = (w) => metrics(backtest(bars, strategy, execOpts(config, w), cache), { riskFree: config.riskFree || 0, minClosedTrades: v.minClosedTrades, benchmark: data.benchmark });
  const train = m(v.train),
    validation = m(v.validation);
  const foldMetrics = folds(dates, v.validation, v.walkForwardFolds, v.embargoBars).map(m);
  const codes = [];
  if (!train.entries) codes.push("NO_SIGNALS_IN_TRAIN");
  if (!validation.entries) codes.push("NO_SIGNALS_IN_VALIDATION");
  if ((validation.turnover ?? 0) > 50) codes.push("EXCESSIVE_TURNOVER");
  if (validation.trades < v.minClosedTrades) codes.push("TOO_FEW_TRADES");
  const sc = score(validation, foldMetrics, v.minClosedTrades);
  const verdict = codes.some((c) => c !== "TOO_FEW_TRADES") ? "rejected" : codes.includes("TOO_FEW_TRADES") ? "not_informative" : "ranked";
  return {
    strategyId: strategyHash(strategy),
    strategy,
    rules: { entry: describe(strategy.entry), exit: describe(strategy.exit) },
    train,
    validation,
    folds: foldMetrics,
    stability: foldMetrics.filter((f) => (f.sharpe ?? 0) > 0).length / foldMetrics.length,
    score: sc,
    fitness: (train.sharpe ?? -5) - (train.trades < v.minClosedTrades ? 1 : 0),
    codes,
    verdict,
  };
}
export function rankCandidates(list) {
  const order = { ranked: 0, not_informative: 1, rejected: 2 };
  const sorted = [...list].sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score || (a.strategyId < b.strategyId ? -1 : 1));
  let rank = 0;
  return sorted.map((c) => ({ ...c, rank: c.verdict === "ranked" ? ++rank : null }));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Runs the search. `emit(type, payload)` reports progress; `cancelled()`
// is checked between candidates. Returns the ranked candidates so far.
export async function runExperiment(config, data, { emit = () => {}, cancelled = () => false } = {}) {
  const problems = validateConfig(config, data.snapshot.bars.map((b) => b.date));
  if (data.snapshot.blocking?.length) problems.push(...data.snapshot.blocking.map((b) => "Data: " + b));
  if (problems.length) throw Error(problems.join(" "));
  const cache = new Map(),
    seen = new Map(),
    budget = config.search.maxCandidates;
  const evaluated = [];
  let duplicates = 0;
  const consider = async (strategy, meta) => {
    const id = strategyHash(strategy);
    if (seen.has(id)) {
      duplicates++;
      return seen.get(id);
    }
    if (evaluated.length >= budget) return null;
    const c = { ...evaluateCandidate(config, data, strategy, cache), ...meta };
    seen.set(id, c);
    evaluated.push(c);
    if (evaluated.length % 10 === 0 || evaluated.length === budget) {
      emit("progress", { evaluated: evaluated.length, budget, duplicates });
      // Saved as it goes, so an interrupted run keeps what it finished.
      if (evaluated.length % 200 === 0) emit("checkpoint", { candidates: trimCandidates(rankCandidates(evaluated)), evaluated: evaluated.length });
      await tick();
    }
    return c;
  };
  for (const w of data.snapshot.warnings || []) emit("warning", { message: w });
  if (config.mode === "manual") await consider(config.strategy, { generation: 0, origin: "manual" });
  else if (config.mode === "sweep") {
    for (const s of sweepGrid(config.strategy)) {
      if (cancelled()) break;
      await consider(s, { generation: 0, origin: "sweep" });
    }
  } else {
    const d = config.strategy,
      r = rng(config.search.seed);
    let pop = [];
    for (let i = 0; i < d.population * 4 && pop.length < d.population && !cancelled() && evaluated.length < budget; i++) {
      const s = randomStrategy(r, d);
      if (validateStrategy(s, d.maxExpressionDepth).length) continue;
      const c = await consider(s, { generation: 0, origin: "random" });
      if (c && !pop.includes(c)) pop.push(c);
    }
    for (let g = 1; g <= d.generations && !cancelled() && evaluated.length < budget; g++) {
      // Selection by training fitness only; validation never steers search.
      const byFit = [...pop].sort((a, b) => b.fitness - a.fitness || (a.strategyId < b.strategyId ? -1 : 1));
      const next = byFit.slice(0, 2);
      const tournament = () => [pick(r, pop), pick(r, pop), pick(r, pop)].sort((a, b) => b.fitness - a.fitness)[0];
      for (let tries = 0; next.length < d.population && tries < d.population * 6 && !cancelled() && evaluated.length < budget; tries++) {
        const p1 = tournament();
        let child = r() < d.crossoverRate ? crossover(r, p1.strategy, tournament().strategy) : structuredClone(p1.strategy);
        if (r() < d.mutationRate) child = mutate(r, child, d);
        if (validateStrategy(child, d.maxExpressionDepth).length) continue;
        const c = await consider(child, { generation: g, origin: "evolved", parent: p1.strategyId });
        if (c && !next.includes(c)) next.push(c);
      }
      pop = next;
      emit("generation", { generation: g, best: Math.max(...pop.map((p) => p.fitness)) });
    }
  }
  const ranked = rankCandidates(evaluated);
  const counts = { evaluated: evaluated.length, duplicates, ranked: 0, not_informative: 0, rejected: 0 };
  for (const c of ranked) counts[c.verdict]++;
  // Only the best of each kind travel back; the counts stay exact.
  return { candidates: trimCandidates(ranked), counts, evaluated: evaluated.length, duplicates, cancelled: cancelled() };
}
const KEEP = { ranked: 300, not_informative: 100, rejected: 100 };
export function trimCandidates(list) {
  const seen = { ranked: 0, not_informative: 0, rejected: 0 };
  return list.filter((c) => ++seen[c.verdict] <= KEEP[c.verdict]);
}

// ---- Runs and manifests ---------------------------------------------------
export function assumptions(config, snapshot) {
  return [
    "Signals are computed after the close of bar t and filled at the open of bar t+1.",
    `Commission ${config.execution.commissionBps} bps (minimum $${config.execution.minCommissionUsd}) and slippage ${config.execution.slippageBps} bps on every fill, entries and exits.`,
    "Long only, whole shares, one instrument. Each window starts flat with the full starting cash.",
    "An open position at the end of a window is marked to the last close and reported as unrealized.",
    `Sharpe uses a ${((config.riskFree || 0) * 100).toFixed(2)}% annual risk-free rate and 252 trading days.`,
    `Prices: ${snapshot.adjustment === "split_only" ? "split-adjusted, dividends not included" : snapshot.adjustment === "synthetic" ? "synthetic demo prices" : "as delivered by the provider, not adjusted for splits or dividends"}.`,
    `The instrument list is fixed by you, not point-in-time: results are survivorship-biased.`,
    "Benchmark is buy-and-hold of the benchmark's closes over the same dates, without costs.",
  ];
}
export function runDetail(config, data, strategy, split, window) {
  const run = backtest(data.snapshot.bars, strategy, execOpts(config, window));
  const m = metrics(run, { riskFree: config.riskFree || 0, minClosedTrades: config.validation.minClosedTrades, benchmark: data.benchmark });
  const manifest = {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    strategy,
    strategySha256: strategyHash(strategy),
    config: JSON.parse(canonical({ ...config, strategy: undefined })),
    dataset: { id: data.snapshot.id, sha256: data.snapshot.contentSha256, symbol: data.snapshot.symbol, provider: data.snapshot.providerId, source: data.snapshot.source, adjustment: data.snapshot.adjustment, calendar: data.snapshot.calendar, from: data.snapshot.from, to: data.snapshot.to, bars: data.snapshot.count, fetchedAt: data.snapshot.fetchedAt },
    benchmark: data.benchmark ? { id: data.benchmark.id, sha256: data.benchmark.contentSha256, symbol: data.benchmark.symbol } : null,
    split,
    window,
    seed: config.search.seed,
    assumptions: assumptions(config, data.snapshot),
    warnings: data.snapshot.warnings,
  };
  const manifestSha256 = sha256(canonical(manifest));
  const artifacts = { fills: run.fills, trades: run.trades, dates: run.dates, equity: run.equity, rejected: run.rejected, openPosition: run.openPosition };
  return {
    id: `run_${manifestSha256.slice(0, 24)}`,
    manifest,
    manifestSha256,
    artifactsSha256: sha256(canonical(artifacts)),
    metrics: m,
    split,
    initialCash: config.portfolio.initialCash,
    ...artifacts,
    exposure: run.exposure,
    benchmarkCurve: data.benchmark ? benchmarkCurve(data.benchmark, run.dates) : [],
  };
}
export function windowsOf(config, dates) {
  const v = config.validation;
  return [["train", v.train], ["validation", v.validation], ...folds(dates, v.validation, v.walkForwardFolds, v.embargoBars).map((w, i) => [`fold ${i + 1}`, w])];
}
// Pairwise correlation of daily returns on the dates the runs share.
export function correlations(runs) {
  const maps = runs.map((r) => {
    const ret = dailyReturns(r.equity, r.manifest.config.portfolio.initialCash);
    return new Map(r.dates.map((d, i) => [d, ret[i]]));
  });
  return runs.map((_, i) =>
    runs.map((_, j) => {
      const common = [...maps[i].keys()].filter((d) => maps[j].has(d));
      if (common.length < 20) return null;
      const a = common.map((d) => maps[i].get(d)),
        b = common.map((d) => maps[j].get(d));
      const ma = mean(a),
        mb = mean(b);
      let num = 0,
        da = 0,
        db = 0;
      for (let k = 0; k < a.length; k++) {
        num += (a[k] - ma) * (b[k] - mb);
        da += (a[k] - ma) ** 2;
        db += (b[k] - mb) ** 2;
      }
      return da && db ? num / Math.sqrt(da * db) : null;
    }),
  );
}
export { unitOf, windowIndex };
