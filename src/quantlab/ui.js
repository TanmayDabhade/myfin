// Quant Lab screens: experiments, the three-panel setup, the leaderboard,
// sealed holdout evaluation, run detail and comparison. Research runs in a
// Web Worker; everything shown is a historical backtest unless labelled.
import { TEMPLATES, HORIZONS, INDICATORS, canonical, describe, sha256, validateStrategy, indicatorLabel } from "./dsl.js";
import { makeSnapshot, backtest } from "./engine.js";
import { mountReplay } from "./replay.js";
import { validateConfig, defaultSplits, sweepGrid, windowsOf, correlations, SCORE_TEXT, LIMITS, trimCandidates } from "./research.js";
import { createStore, memoryBackend, nativeBackend } from "./store.js";
import { lineChart, hover, ticks } from "../riskcharts.js";

let ctx, store;
const ql = { horizon: "all", sim: null, view: "home", filter: "all", tab: "overview", picks: new Set(), sort: "score", minTrades: 0, maxDD: "", draft: null, exp: null, run: null, compare: null, confirm: null, experiments: [], selections: [], holdouts: {}, events: [] };
const jobs = new Map();
let runWorker = null,
  reqSeq = 0;
const pending = new Map();

const MODES = { manual: "Manual rules", sweep: "Parameter sweep", discovery: "Discover strategies" };
const STATUS = { draft: "Draft", queued: "Queued", running: "Running", completed: "Complete", failed: "Failed", cancelled: "Cancelled · incomplete" };
const VERDICT = { ranked: "Ranked", not_informative: "Not statistically informative", rejected: "Rejected" };
const CODES = { TOO_FEW_TRADES: "Too few closed trades", NO_SIGNALS_IN_TRAIN: "No entries in training", NO_SIGNALS_IN_VALIDATION: "No entries in validation", EXCESSIVE_TURNOVER: "Turnover above 50× a year" };
const DEF = {
  totalReturn: "End equity ÷ starting cash − 1, for this window only, after costs.",
  cagr: "(End ÷ start)^(1 ÷ years) − 1 with 252 bars a year. Blank under one year.",
  sharpe: "Mean daily return minus the daily risk-free rate, ÷ the standard deviation of daily returns, × √252.",
  maxDrawdown: "Largest fall of daily equity from its running peak (starting cash counts as the first peak).",
  vol: "Standard deviation of daily returns × √252.",
  profitFactor: "Gross profit of winning trades ÷ gross loss of losing trades. Blank below the minimum closed trades or with no losses.",
  trades: "Closed round trips (entry and exit filled) in this window.",
  exposure: "Share of bars that ended holding a position.",
  turnover: "Value of all fills ÷ average equity, per year.",
  benchmarkReturn: "Buy-and-hold of the benchmark's closes over the same dates, no costs.",
  score: SCORE_TEXT,
  stability: "Share of walk-forward folds with a Sharpe above 0.",
};

const e = (s) => ctx.esc(String(s ?? ""));
const f2 = (x) => ctx.fmt(x, 2);
const p = (x) => ctx.pct(x);
const th = (label, key) => `<span title="${e(DEF[key] || "")}">${label}</span>`;
const nowIso = () => new Date().toISOString();
const btn = (text, act, value = "", cls = "", extra = "") => `<button class="${cls}" data-action="${act}" data-value="${e(value)}" ${extra}>${text}</button>`;
const onPage = () => ctx.page() === "Quant Lab";
let renderTimer = null;
const soon = () => {
  if (!onPage() || renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (onPage() && !document.activeElement?.matches?.("#app input, #app textarea, #app select")) ctx.render();
  }, 400);
};

export async function labInit(c) {
  ctx = c;
  store = createStore(c.native ? nativeBackend(c.invoke) : memoryBackend(globalThis.localStorage));
  await reload();
  // Jobs don't survive a restart; label them instead of leaving them "running".
  for (const x of ql.experiments.filter((x) => ["running", "queued"].includes(x.status))) {
    x.status = "cancelled";
    x.job = { ...(x.job || {}), state: "cancelled", finishedAt: nowIso(), interrupted: true };
    x.warnings = [...(x.warnings || []), "Aperture closed while this experiment ran. Candidates saved at the last checkpoint are kept; the run is incomplete."];
    await store.saveExperiment(x);
  }
}
async function reload() {
  ql.experiments = (await store.listExperiments()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (ql.exp) {
    ql.exp = ql.experiments.find((x) => x.id === ql.exp.id) || null;
    if (ql.exp) {
      ql.selections = await store.listSelections(ql.exp.id);
      ql.holdouts = {};
      for (const s of ql.selections) ql.holdouts[s.id] = await store.getHoldout(s.id);
      ql.events = ql.exp.job?.id ? (await store.listEvents(ql.exp.job.id)).slice(-200) : [];
    }
  }
}

// ---- Entry points from the rest of the app --------------------------------
export function labOpen(symbol) {
  ql.view = "new";
  ql.draft = null;
  return newDraft(symbol);
}
export function labPage() {
  try {
    if (ql.view === "new") return newView();
    if (ql.view === "exp" && ql.exp) return expView(ql.exp);
    if (ql.view === "run" && ql.run) return runView();
    if (ql.view === "compare" && ql.compare) return compareView();
    return homeView();
  } catch (err) {
    return `<section class="panel">${ctx.empty("Quant Lab could not draw this view: " + e(err.message))}${btn("Back to experiments", "ql-home")}</section>`;
  }
}

// ---- Landing --------------------------------------------------------------
function holdoutText(x) {
  const n = x.holdout?.evaluations || 0;
  return n ? `<span class="pill">Holdout evaluated${n > 1 ? ` ×${n}` : ""}</span>` : x.status === "completed" ? `<span class="pill on">Sealed</span>` : "—";
}
function homeView() {
  const filters = { all: "All", running: "Running", completed: "Completed", cancelled: "Incomplete", archived: "Archived" };
  const list = ql.experiments.filter((x) => (ql.filter === "archived" ? x.archived : !x.archived && (ql.filter === "all" || x.status === ql.filter || (ql.filter === "running" && x.status === "queued"))));
  const rows = list.map((x) => {
    const best = x.candidates?.find((c) => c.verdict === "ranked");
    const v = x.config.validation;
    return `<tr class="ql-row" tabindex="0" data-ql-open="${e(x.id)}"><td><button class="link" data-action="ql-open" data-value="${e(x.id)}">${e(x.name)}</button></td><td>${e(x.config.universe.instrumentIds.join(", "))}</td><td>${e(v.train.from)} → ${e(v.holdout.to)}</td><td>${MODES[x.mode || x.config.mode]}</td><td>${x.counts?.evaluated ?? x.candidates?.length ?? 0}</td><td><span class="pill ${x.status === "running" ? "on" : ""}">${STATUS[x.status] || e(x.status)}</span></td><td title="${e(SCORE_TEXT)}">${best ? f2(best.score) : "—"}</td><td>${holdoutText(x)}</td></tr>`;
  });
  const sels = ql.experiments.flatMap((x) => (x.savedSelections || []).map((s) => ({ ...s, exp: x })));
  return `<section class="panel"><div class="panel-head"><h2>Experiments</h2><div class="ql-actions">${btn("New experiment", "ql-new", "", "primary")}<label class="ql-file">Import JSON<input type="file" accept=".json,application/json" data-ql-import></label></div></div>
  <p class="muted">Define or discover rule-based strategies, backtest them on daily bars with costs, rank them on a validation window, then check a frozen short list once on a sealed holdout. Every result here is a historical backtest, not a forecast or a recommendation.</p>
  <div class="ql-seg" role="group" aria-label="Filter experiments">${Object.entries(filters).map(([k, l]) => btn(l, "ql-filter", k, ql.filter === k ? "active" : "")).join("")}</div>
  ${list.length ? ctx.table(["Name", "Instrument", "Data window", "Mode", "Candidates", "Status", th("Best validation score", "score"), "Holdout"], rows) : ctx.empty(ql.experiments.length ? "No experiments match this filter." : `Quant Lab tests trading rules on past prices. Start with an SMA crossover on one stock, or let it search for rules within limits you set. ${btn("Create first experiment", "ql-new", "", "primary")}`)}</section>
  <div class="grid halves"><section class="panel"><div class="panel-head"><h2>Frozen selections</h2></div>${sels.length ? ctx.table(["Experiment", "Strategies", "Frozen", "Holdout"], sels.map((s) => `<tr><td><button class="link" data-action="ql-open" data-value="${e(s.exp.id)}">${e(s.exp.name)}</button></td><td>${s.count}</td><td>${e(s.selectedAt.slice(0, 10))}</td><td>${s.evaluated ? (s.untouched ? "Evaluated · untouched" : "Evaluated · reused") : "Sealed"}</td></tr>`)) : ctx.empty("Freeze a short list from an experiment's leaderboard to evaluate its holdout.")}</section>
  <section class="panel"><div class="panel-head"><h2>Forward testing</h2><span class="pill">Paper only · not in this version</span></div><p class="muted">Forward testing of accepted strategies on new market data, in a separately labelled paper account, comes later. Quant Lab never sends orders anywhere, real or paper.</p></section></div>`;
}

// ---- New experiment --------------------------------------------------------
// Three values per parameter around its default keeps a sweep small.
const sweepDefault = (k) =>
  SWEEP_DEFAULT[k] ||
  Object.fromEntries(
    Object.entries(TEMPLATES[k].params).map(([n, [lo, hi, d]]) => {
      const from = Math.max(lo, Math.round(d * 0.5)), to = Math.min(hi, Math.max(from + 2, Math.round(d * 1.5)));
      return [n, { from, to, step: Math.max(1, Math.ceil((to - from) / 2)) }];
    }),
  );
const TEMPLATE_PARAMS = (t) => Object.fromEntries(Object.entries(TEMPLATES[t].params).map(([k, [, , d]]) => [k, d]));
const SWEEP_DEFAULT = {
  sma_cross: { fast: { from: 5, to: 30, step: 5 }, slow: { from: 20, to: 120, step: 20 } },
  ema_cross: { fast: { from: 5, to: 30, step: 5 }, slow: { from: 20, to: 100, step: 10 } },
  rsi_reversion: { period: { from: 2, to: 14, step: 4 }, buyBelow: { from: 10, to: 40, step: 10 }, sellAbove: { from: 50, to: 80, step: 10 } },
  vol_breakout: { trend: { from: 20, to: 100, step: 20 }, fastAtr: { from: 5, to: 10, step: 5 }, slowAtr: { from: 20, to: 40, step: 20 } },
};
async function newDraft(symbol, base = null) {
  const s = (symbol || ctx.symbol() || "SPY").toUpperCase();
  const d = {
    name: base?.name ? `${base.name} (copy)` : `${s} research`,
    symbol: s,
    benchmark: base?.benchmarkInstrumentId || "SPY",
    initialCash: base?.portfolio.initialCash ?? 100000,
    maxWeight: (base?.portfolio.maxPositionWeight ?? 1) * 100,
    commissionBps: base?.execution.commissionBps ?? 1,
    slippageBps: base?.execution.slippageBps ?? 5,
    minCommissionUsd: base?.execution.minCommissionUsd ?? 0,
    riskFree: (base?.riskFree ?? 0) * 100,
    folds: base?.validation.walkForwardFolds ?? 4,
    embargo: base?.validation.embargoBars ?? 5,
    minTrades: base?.validation.minClosedTrades ?? 5,
    seed: base?.search.seed ?? 42,
    budget: base?.search.maxCandidates ?? 300,
    mode: base?.mode || "manual",
    manual: { template: "price_sma", params: TEMPLATE_PARAMS("price_sma"), json: "" },
    sweep: { template: "sma_cross", ranges: structuredClone(SWEEP_DEFAULT.sma_cross) },
    discovery: { allowedIndicators: ["sma", "ema", "rsi", "atr", "price"], maxExpressionDepth: 3, population: 30, generations: 8, mutationRate: 0.5, crossoverRate: 0.6 },
    windows: base?.validation ? { train: { ...base.validation.train }, validation: { ...base.validation.validation }, holdout: { ...base.validation.holdout } } : null,
    coverage: null,
    errors: [],
  };
  if (base?.mode === "manual") d.manual = { template: "custom", params: {}, json: JSON.stringify(base.strategy, null, 2) };
  if (base?.mode === "sweep") d.sweep = structuredClone(base.strategy);
  if (base?.mode === "discovery") d.discovery = structuredClone(base.strategy);
  ql.draft = d;
  await loadCoverage(!d.windows);
  return d;
}
async function loadCoverage(resetWindows) {
  const d = ql.draft;
  d.coverage = { loading: true };
  try {
    const got = await ctx.barsFor(d.symbol);
    const snap = makeSnapshot({ symbol: d.symbol, providerId: got.providerId, source: got.source, adjustment: got.adjustment, bars: got.bars, fetchedAt: got.fetchedAt });
    draftBars = snap.bars;
    tradeCache.clear();
    ql.sim = null;
    d.coverage = { from: snap.from, to: snap.to, count: snap.count, source: got.source, adjustment: snap.adjustment, warnings: snap.warnings, blocking: snap.blocking };
    if (resetWindows || !d.windows) {
      const dates = snap.bars.map((b) => b.date);
      d.windows = defaultSplits(dates, d.embargo);
      // Enough bars per fold to mean something: about 30, at most 4 folds.
      const n = dates.filter((x) => x >= d.windows.validation.from && x <= d.windows.validation.to).length;
      d.folds = Math.max(1, Math.min(4, Math.floor(n / 30)));
    }
  } catch (err) {
    d.coverage = { error: err.message };
  }
}
// ---- Strategy library -----------------------------------------------------------
// Below this many closed trades in training + validation a backtest says too
// little to be worth running, so the prebuilt card is greyed out.
const MIN_LIBRARY_TRADES = 6;
let draftBars = null;
const tradeCache = new Map(),
  indCache = new Map();
const PARAM_LABEL = { fast: "Fast period", slow: "Slow period", period: "Period", buyBelow: "Buy below", sellAbove: "Sell above", trend: "Trend average", hold: "Max hold (days)", ema: "EMA period", volume: "Volume average", enter: "Enter above", exit: "Exit below", cooldown: "Cooldown (days)", exitPeriod: "Exit average", fastAtr: "Fast ATR", slowAtr: "Slow ATR" };
// Counted on training + validation only: the holdout stays unseen.
function simOpts(d) {
  return { from: d.windows?.train.from, to: d.windows?.validation.to, initialCash: +d.initialCash || 100000, maxPositionWeight: Math.min(1, (+d.maxWeight || 100) / 100), commissionBps: +d.commissionBps || 0, slippageBps: +d.slippageBps || 0, minCommissionUsd: +d.minCommissionUsd || 0 };
}
function tradeCount(d, key, params) {
  const t = TEMPLATES[key];
  if (!draftBars || !d.windows || !t.valid(params)) return null;
  const k = key + canonical(params) + d.windows.train.from + d.windows.validation.to;
  if (!tradeCache.has(k)) {
    if (indCache.bars !== draftBars) (indCache.clear(), (indCache.bars = draftBars));
    const r = backtest(draftBars, t.build(params), { ...simOpts(d), initialCash: 1e7 }, indCache);
    tradeCache.set(k, r.trades.length + (r.openPosition ? 1 : 0));
  }
  return tradeCache.get(k);
}
const tradesText = (n) => (n == null ? "Load data to count trades" : `${n} trade${n === 1 ? "" : "s"} in training + validation`);
function gallery(d) {
  const sel = d.manual.template;
  const cards = Object.entries(TEMPLATES)
    .filter(([, t]) => ql.horizon === "all" || t.horizon === ql.horizon)
    .map(([k, t]) => {
      const n = tradeCount(d, k, k === sel ? d.manual.params : TEMPLATE_PARAMS(k));
      const few = n != null && n < MIN_LIBRARY_TRADES && k !== sel;
      return `<button class="ql-card ${k === sel ? "active" : ""}" data-action="ql-tpl" data-value="${k}" ${few ? `disabled title="Only ${n} trade${n === 1 ? "" : "s"} on this data, fewer than ${MIN_LIBRARY_TRADES}: too few to judge"` : ""}><span class="ql-card-top"><b>${e(t.label)}</b><span class="ql-hz ql-hz-${t.horizon}">${HORIZONS[t.horizon].label}</span></span><small>${e(t.blurb)}</small><span class="ql-card-n ${few ? "down" : ""}">${few ? `Only ${n} trade${n === 1 ? "" : "s"}: too few to judge` : tradesText(n)}</span></button>`;
    });
  cards.push(`<button class="ql-card ${sel === "custom" ? "active" : ""}" data-action="ql-tpl" data-value="custom"><span class="ql-card-top"><b>Custom rules</b><span class="ql-hz">JSON</span></span><small>Write your own entry and exit rules from the same indicators.</small><span class="ql-card-n">Any horizon</span></button>`);
  const hz = { all: { label: "All", hint: `${Object.keys(TEMPLATES).length} prebuilt strategies. Shorter holding periods make more trades; longer ones fewer.` }, ...HORIZONS };
  return `<div class="ql-seg" role="group" aria-label="Holding period">${Object.entries(hz).map(([k, h]) => btn(h.label, "ql-horizon", k, ql.horizon === k ? "active" : "")).join("")}</div><p class="muted ql-hint">${e(hz[ql.horizon].hint)} Strategies with fewer than ${MIN_LIBRARY_TRADES} trades on this data are greyed out.</p><div class="ql-gallery">${cards.join("")}</div>`;
}
function chosen(d) {
  const t = TEMPLATES[d.manual.template];
  return `<div class="ql-chosen"><div class="ql-card-top"><h3>${e(t.label)}</h3><span class="ql-hz ql-hz-${t.horizon}">${HORIZONS[t.horizon].label}</span></div><p class="ql-how-text">${e(t.how)}</p><div class="ql-params">${Object.entries(t.params).map(([k, [lo, hi]]) => field(PARAM_LABEL[k] || k, `manual.params.${k}`, d.manual.params[k], "number", `min="${lo}" max="${hi}" step="1"`)).join("")}</div><div data-ql-preview>${preview(d)}</div><div class="ql-actions">${btn("▶ Watch it trade", "ql-sim", "", "primary")}<span class="muted">Replays this strategy bar by bar over training + validation.</span></div></div>${HOW_IT_WORKS}`;
}
const HOW_IT_WORKS = `<details class="ql-how"><summary>How Quant Lab tests a strategy</summary><ol>
<li><b>Rules, not guesses.</b> A strategy is an entry rule and an exit rule built from moving averages, RSI, ATR, price and volume. Every rule is checked before it runs.</li>
<li><b>No peeking ahead.</b> Each signal is read at a day's close and filled at the next day's open, with your commission and slippage taken off. Positions are long only, in whole shares.</li>
<li><b>Three windows.</b> History is split into training, validation and a sealed holdout. Searches only learn from training; candidates are ranked on validation, cut into walk-forward folds so one lucky stretch can't carry a result.</li>
<li><b>Enough trades to mean something.</b> A result from two or three trades is noise. Strategies need at least the minimum closed trades to be ranked, and the library hides prebuilt ones that trade fewer than ${MIN_LIBRARY_TRADES} times on your data.</li>
<li><b>One look at the holdout.</b> Freeze a short list and the holdout is evaluated once. That is the closest a backtest gets to unseen data.</li>
<li><b>Watch it trade.</b> The replay reveals the finished backtest a bar at a time: buys, sells, the equity curve and each closed trade, at a speed you choose.</li></ol>
<p class="muted">Shorter holding periods (Short-term) mean more trades and more cost drag; trend strategies trade rarely and need longer history. Everything here is a simulation on past prices, not a forecast.</p></details>`;
const field = (label, path, value, type = "number", extra = "") => `<label>${label}<input type="${type}" data-ql="${path}" value="${e(value)}" ${extra}></label>`;
function strategyCenter(d) {
  const tabs = `<div class="ql-seg" role="group" aria-label="Strategy mode">${Object.entries(MODES).map(([k, l]) => btn(l, "ql-mode", k, d.mode === k ? "active" : "")).join("")}</div>`;
  const tplSelect = (path, value, custom) => `<label>Template<select data-ql="${path}" data-ql-rerender>${Object.entries(HORIZONS).map(([h, hz]) => `<optgroup label="${hz.label}">${Object.entries(TEMPLATES).filter(([, t]) => t.horizon === h).map(([k, t]) => `<option value="${k}" ${value === k ? "selected" : ""}>${t.label}</option>`).join("")}</optgroup>`).join("")}${custom ? `<option value="custom" ${value === "custom" ? "selected" : ""}>Custom rules (JSON)</option>` : ""}</select></label>`;
  if (d.mode === "manual") {
    const m = d.manual;
    if (m.template !== "custom") return tabs + gallery(d) + chosen(d);
    {
      const parsed = (() => {
        try {
          const s = JSON.parse(m.json || "null");
          const errs = validateStrategy(s);
          return errs.length ? `<p class="down">${errs.map(e).join("<br>")}</p>` : `<p class="muted">Entry: ${e(describe(s.entry))}<br>Exit: ${e(describe(s.exit))}</p>`;
        } catch {
          return `<p class="down">Not valid JSON yet.</p>`;
        }
      })();
      return `${tabs}${gallery(d)}<label>Strategy definition<textarea rows="16" spellcheck="false" data-ql="manual.json" data-type="text" class="ql-json">${e(m.json || JSON.stringify(TEMPLATES.sma_cross.build(TEMPLATE_PARAMS("sma_cross")), null, 2))}</textarea></label>${parsed}<small>Indicators: ${INDICATORS.join(", ")}. Comparisons: gt, lt, crosses_above, crosses_below, grouped with all / any. Rules are data; nothing in them is run as code.</small><div class="ql-actions">${btn("▶ Watch it trade", "ql-sim", "", "primary")}</div>${HOW_IT_WORKS}`;
    }
  }
  if (d.mode === "sweep") {
    const t = TEMPLATES[d.sweep.template];
    return `${tabs}${tplSelect("sweep.template", d.sweep.template, false)}${table3(Object.entries(t.params).map(([k, [lo, hi]]) => `<tr><td>${PARAM_LABEL[k] || k}</td>${["from", "to", "step"].map((x) => `<td><input type="number" data-ql="sweep.ranges.${k}.${x}" value="${e(d.sweep.ranges[k]?.[x])}" min="${x === "step" ? 1 : lo}" max="${hi}" aria-label="${k} ${x}"></td>`).join("")}</tr>`))}<div data-ql-preview>${preview(d)}</div>`;
  }
  const x = d.discovery;
  return `${tabs}<p class="muted">A seeded genetic search over rule trees built only from the indicators you allow. It breeds candidates by their training Sharpe; the leaderboard then ranks them on validation.</p><fieldset class="ql-checks"><legend>Allowed indicators</legend>${INDICATORS.map((k) => `<label><input type="checkbox" data-ql-indicator="${k}" ${x.allowedIndicators.includes(k) ? "checked" : ""}>${k.toUpperCase()}</label>`).join("")}</fieldset><div class="ql-params">${field("Max rule depth", "discovery.maxExpressionDepth", x.maxExpressionDepth, "number", `min="1" max="${LIMITS.depth}"`)}${field("Population", "discovery.population", x.population, "number", `min="4" max="${LIMITS.population}"`)}${field("Generations", "discovery.generations", x.generations, "number", `min="1" max="${LIMITS.generations}"`)}${field("Mutation rate", "discovery.mutationRate", x.mutationRate, "number", 'min="0" max="1" step="0.05"')}${field("Crossover rate", "discovery.crossoverRate", x.crossoverRate, "number", 'min="0" max="1" step="0.05"')}</div>`;
}
// Text that follows the inputs, updated in place so typing never re-renders
// the form (a re-render mid-click would swallow the Run button's click).
function preview(d) {
  if (d.mode === "sweep") return `<p class="muted">${sweepGrid(d.sweep).length} valid combinations. Each is tested on training, validation and every fold.</p>`;
  if (d.mode !== "manual" || d.manual.template === "custom") return "";
  const t = TEMPLATES[d.manual.template];
  if (!t.valid(d.manual.params)) return `<p class="down">These parameters don't make a valid ${t.label}.</p>`;
  const s = t.build(d.manual.params);
  const n = tradeCount(d, d.manual.template, d.manual.params);
  const hold = s.constraints.maxHoldingBars ? ` Exit after ${s.constraints.maxHoldingBars} days at the latest.` : "";
  return `<p class="muted">Enter when ${e(describe(s.entry))}. Exit when ${e(describe(s.exit))}.${hold}</p>${n == null ? "" : n < MIN_LIBRARY_TRADES ? `<p class="down">${tradesText(n)}: fewer than ${MIN_LIBRARY_TRADES}, too few to judge. Shorten the periods or the holding limit.</p>` : `<p class="up">${tradesText(n)}.</p>`}`;
}
const workloadText = (d) => {
  const load = workload(d);
  return `Estimated workload: ${load.n} candidate${load.n === 1 ? "" : "s"}, ${load.runs} backtests, on this computer in the background.`;
};
const table3 = (rows) => `<div class="table-wrap"><table><thead><tr><th>Parameter</th><th>From</th><th>To</th><th>Step</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
function workload(d) {
  const per = 2 + (+d.folds || 1);
  const n = d.mode === "manual" ? 1 : d.mode === "sweep" ? Math.min(sweepGrid(d.sweep).length, d.budget) : Math.min(d.budget, d.discovery.population * (d.discovery.generations + 1));
  return { n, runs: n * per };
}
function newView() {
  const d = ql.draft;
  if (!d) return `<section class="panel">${ctx.empty("Preparing…")}</section>`;
  const c = d.coverage || {};
  const cov = c.loading ? "Loading prices…" : c.error ? `<span class="down">${e(c.error)}</span>` : c.count ? `${c.count} daily bars, ${e(c.from)} → ${e(c.to)} · ${e(c.source)}` : "";
  const adj = { split_only: "Split-adjusted (dividends not included)", none: "Not adjusted by the provider", synthetic: "Synthetic demo prices" }[c.adjustment] || "—";
  const w = d.windows || {};
  const win = (k, label) => `<div class="ql-window"><b>${label}</b>${field("From", `windows.${k}.from`, w[k]?.from || "", "date")}${field("To", `windows.${k}.to`, w[k]?.to || "", "date")}</div>`;
  return `<div class="ql-crumbs">${btn("← Experiments", "ql-home", "", "link")}</div>
  <div class="ql-cols">
  <section class="panel"><div class="panel-head"><h2>Research setup</h2></div>
    ${field("Name", "name", d.name, "text", 'maxlength="120"')}
    <div class="ql-inline">${field("Instrument", "symbol", d.symbol, "text", 'maxlength="20" autocomplete="off" spellcheck="false"')}${btn("Load data", "ql-load")}</div>
    <p class="muted ql-cov">${cov}</p>
    ${(c.blocking || []).length ? `<p class="down">Data problems block scoring: ${c.blocking.slice(0, 3).map(e).join("; ")}</p>` : ""}
    ${(c.warnings || []).length ? `<details><summary>${c.warnings.length} data warning${c.warnings.length > 1 ? "s" : ""}</summary><ul>${c.warnings.slice(0, 20).map((x) => `<li>${e(x)}</li>`).join("")}</ul></details>` : ""}
    ${field("Benchmark", "benchmark", d.benchmark, "text", 'maxlength="20" autocomplete="off" spellcheck="false"')}
    <dl class="ql-facts"><dt>Bars</dt><dd>Daily (1D)</dd><dt>Prices</dt><dd>${adj}</dd><dt>Positions</dt><dd>Long only, whole shares</dd><dt>Universe</dt><dd>One instrument, fixed by you (survivorship-biased)</dd></dl>
    ${field("Starting cash ($)", "initialCash", d.initialCash, "number", 'min="1000" step="1000"')}
    ${field("Max position weight (%)", "maxWeight", d.maxWeight, "number", 'min="1" max="100"')}
  </section>
  <section class="panel"><div class="panel-head"><h2>Strategy</h2></div>${strategyCenter(d)}</section>
  <section class="panel"><div class="panel-head"><h2>Validation & costs</h2></div>
    ${win("train", "Training")}${win("validation", "Validation")}${win("holdout", "Holdout")}
    <p class="ql-warn">Final holdout is evaluated only after selection is frozen, and only once.</p>
    <div class="ql-params">${field("Walk-forward folds", "folds", d.folds, "number", `min="1" max="${LIMITS.folds}"`)}${field("Embargo (bars)", "embargo", d.embargo, "number", 'min="0" max="60"')}${field("Min closed trades", "minTrades", d.minTrades, "number", 'min="1" max="500"')}${field("Commission (bps)", "commissionBps", d.commissionBps, "number", 'min="0" max="500" step="0.5"')}${field("Slippage (bps)", "slippageBps", d.slippageBps, "number", 'min="0" max="500" step="0.5"')}${field("Min commission ($)", "minCommissionUsd", d.minCommissionUsd, "number", 'min="0" max="100" step="0.5"')}${field("Risk-free rate (%/yr)", "riskFree", d.riskFree, "number", 'min="0" max="20" step="0.1"')}${field("Seed", "seed", d.seed, "number", 'min="0" step="1"')}${field("Max candidates", "budget", d.budget, "number", `min="1" max="${LIMITS.maxCandidates}"`)}</div>
    <p class="muted" data-ql-workload>${workloadText(d)}</p>
    ${d.errors.length ? `<ul class="down ql-errors">${d.errors.map((x) => `<li>${e(x)}</li>`).join("")}</ul>` : ""}
    ${btn("Run research", "ql-run", "", "primary", c.count && !(c.blocking || []).length ? "" : "disabled")}
  </section></div>${ql.sim ? `<section class="panel ql-sim-panel"><div class="panel-head"><h2>Simulation · ${e(ql.sim.title)} <span class="pill">Training + validation · ${e(ql.sim.from)} → ${e(ql.sim.to)}</span></h2>${btn("Close", "ql-sim-close")}</div><div data-ql-replay="draft"></div></section>` : ""}`;
}
function buildConfig(d) {
  const strategy =
    d.mode === "manual"
      ? d.manual.template === "custom"
        ? (() => {
            try {
              return JSON.parse(d.manual.json);
            } catch {
              return null;
            }
          })()
        : TEMPLATES[d.manual.template].build(d.manual.params)
      : d.mode === "sweep"
        ? { template: d.sweep.template, ranges: d.sweep.ranges }
        : { schemaVersion: 1, ...d.discovery, objective: "validation_sharpe_with_penalties" };
  return {
    schemaVersion: 1,
    name: d.name.trim(),
    mode: d.mode,
    universe: { instrumentIds: [d.symbol], survivorshipPolicy: "fixed_declared" },
    benchmarkInstrumentId: d.benchmark,
    data: { providerId: d.coverage?.source || "", frequency: "1d", from: d.windows?.train.from, to: d.windows?.holdout.to, priceAdjustment: d.coverage?.adjustment === "split_only" ? "split_only" : d.coverage?.adjustment || "split_only", snapshotPolicy: "freeze" },
    portfolio: { initialCash: +d.initialCash, currency: "USD", longOnly: true, maxPositionWeight: +d.maxWeight / 100 },
    execution: { signalAt: "close", fillAt: "next_open", commissionBps: +d.commissionBps, slippageBps: +d.slippageBps, minCommissionUsd: +d.minCommissionUsd },
    validation: { ...structuredClone(d.windows), walkForwardFolds: +d.folds, embargoBars: +d.embargo, minClosedTrades: +d.minTrades },
    riskFree: +d.riskFree / 100,
    strategy,
    search: { seed: +d.seed, maxCandidates: d.mode === "manual" ? 1 : +d.budget, maxParallelJobs: 1 },
  };
}

// ---- Jobs ------------------------------------------------------------------
async function startResearch() {
  const d = ql.draft;
  d.errors = [];
  const config = buildConfig(d);
  let main, bench;
  try {
    main = await ctx.barsFor(d.symbol);
    bench = await ctx.barsFor(d.benchmark);
  } catch (err) {
    d.errors = [err.message];
    return;
  }
  const snapshot = makeSnapshot({ symbol: d.symbol, providerId: main.providerId, source: main.source, adjustment: main.adjustment, bars: main.bars, fetchedAt: main.fetchedAt });
  const benchmark = makeSnapshot({ symbol: d.benchmark, providerId: bench.providerId, source: bench.source, adjustment: bench.adjustment, bars: bench.bars, fetchedAt: bench.fetchedAt });
  config.data.providerId = main.providerId;
  config.data.priceAdjustment = snapshot.adjustment;
  const few = d.mode === "manual" && d.manual.template !== "custom" ? tradeCount(d, d.manual.template, d.manual.params) : null;
  if (few != null && few < MIN_LIBRARY_TRADES) {
    d.errors = [`This strategy makes only ${few} trade${few === 1 ? "" : "s"} in training + validation. Pick one with at least ${MIN_LIBRARY_TRADES}, or shorten its periods.`];
    return;
  }
  d.errors = validateConfig(config, snapshot.bars.map((b) => b.date)).concat(snapshot.blocking.map((x) => "Data: " + x));
  if (d.errors.length) return;
  await store.saveSnapshot(snapshot);
  await store.saveSnapshot(benchmark);
  const createdAt = nowIso();
  const exp = { id: "exp_" + sha256(canonical(config) + createdAt).slice(0, 16), name: config.name, mode: config.mode, config, datasetId: snapshot.id, benchmarkId: benchmark.id, createdAt, status: "queued", candidates: [], warnings: [...snapshot.warnings, ...benchmark.warnings.map((w) => `Benchmark: ${w}`)] };
  if (snapshot.adjustment === "none") exp.warnings.push("These prices are not adjusted for splits or dividends. Use Twelve Data for split-adjusted daily history.");
  await store.saveExperiment(exp);
  await launch(exp, { snapshot, benchmark });
  ql.view = "exp";
  ql.tab = "overview";
  ql.exp = exp;
  ql.picks.clear();
  await reload();
}
async function dataOf(exp) {
  const [snapshot, benchmark] = await Promise.all([store.getSnapshot(exp.datasetId), store.getSnapshot(exp.benchmarkId)]);
  if (!snapshot) throw Error("This experiment's frozen dataset is missing.");
  return { snapshot, benchmark };
}
async function launch(exp, data) {
  if (jobs.has(exp.id)) return jobs.get(exp.id).jobId; // never two jobs for one experiment
  const jobId = "job_" + sha256(exp.id + nowIso()).slice(0, 16);
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  jobs.set(exp.id, { worker, jobId });
  exp.status = "running";
  exp.job = { id: jobId, state: "running", startedAt: nowIso(), lastSeq: 0, progress: { evaluated: 0, budget: exp.config.search.maxCandidates } };
  await store.saveExperiment(exp);
  let chain = Promise.resolve();
  worker.onmessage = ({ data: ev }) => {
    chain = chain.then(() => onEvent(exp.id, ev)).catch((err) => ctx.notify(err.message, true));
  };
  worker.onerror = (err) => {
    chain = chain.then(() => onEvent(exp.id, { jobId, seq: exp.job.lastSeq + 1, at: nowIso(), type: "failed", payload: { message: err.message || "The research worker stopped." } }));
  };
  worker.postMessage({ type: "start", jobId, config: exp.config, data });
  return jobId;
}
async function onEvent(expId, ev) {
  const exp = ql.experiments.find((x) => x.id === expId) || (await store.getExperiment(expId));
  if (!exp || exp.job?.id !== ev.jobId || ev.seq <= exp.job.lastSeq) return;
  const small = { type: ev.type, seq: ev.seq, at: ev.at, payload: ev.type === "completed" || ev.type === "cancelled" || ev.type === "checkpoint" ? { evaluated: ev.payload.evaluated ?? ev.payload.candidates?.length } : ev.payload };
  await store.appendEvents(ev.jobId, [small]);
  exp.job.lastSeq = ev.seq;
  if (ev.type === "progress") exp.job.progress = ev.payload;
  if (ev.type === "warning") exp.warnings = [...(exp.warnings || []), ev.payload.message].filter((x, i, a) => a.indexOf(x) === i);
  if (ev.type === "checkpoint") exp.candidates = ev.payload.candidates;
  if (["completed", "cancelled", "failed"].includes(ev.type)) {
    if (ev.type !== "failed") {
      exp.candidates = ev.payload.candidates;
      exp.counts = ev.payload.counts;
    } else exp.job.error = ev.payload.message;
    exp.status = ev.type;
    exp.job.state = ev.type;
    exp.job.finishedAt = ev.at;
    jobs.get(expId)?.worker.terminate();
    jobs.delete(expId);
  }
  await store.saveExperiment(exp);
  if (ql.exp?.id === expId) ql.exp = exp;
  if (["completed", "cancelled", "failed"].includes(ev.type)) {
    await reload();
    if (onPage()) ctx.render();
    if (ev.type === "failed") ctx.notify(`Research failed: ${ev.payload.message}`, true);
  } else soon();
}
function runInWorker(config, data, items) {
  runWorker ||= new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  runWorker.onmessage = ({ data: m }) => {
    const r = pending.get(m.reqId);
    pending.delete(m.reqId);
    if (r) m.error ? r.reject(Error(m.error)) : r.resolve(m.runs);
  };
  const reqId = ++reqSeq;
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    runWorker.postMessage({ type: "run", reqId, config, data, items });
  });
}

// ---- Experiment detail ------------------------------------------------------
function expView(x) {
  const tabs = { overview: "Overview", leaderboard: "Leaderboard", validation: "Validation", activity: "Activity", settings: "Settings" };
  const v = x.config.validation;
  const job = x.job || {};
  const running = x.status === "running" || x.status === "queued";
  const best = x.candidates?.find((c) => c.verdict === "ranked");
  const head = `<div class="ql-crumbs">${btn("← Experiments", "ql-home", "", "link")}</div><section class="panel"><div class="panel-head"><h2>${e(x.name)} <span class="pill ${running ? "on" : ""}">${STATUS[x.status]}</span></h2><div class="ql-actions">${running ? btn("Cancel", "ql-cancel", x.id) : btn("Re-run", "ql-rerun", x.id)}${btn("Duplicate settings", "ql-duplicate", x.id)}${btn("Export", "ql-export-exp", x.id)}${btn(x.archived ? "Unarchive" : "Archive", "ql-archive", x.id)}</div></div>
  <p class="muted">${e(x.config.universe.instrumentIds.join(", "))} vs ${e(x.config.benchmarkInstrumentId)} · Daily · ${e(v.train.from)} → ${e(v.holdout.to)} · ${MODES[x.config.mode]} · dataset <code title="SHA-256 of the frozen bars">${e(x.datasetId)}</code></p>
  <div class="ql-seg" role="tablist">${Object.entries(tabs).map(([k, l]) => btn(l, "ql-tab", k, ql.tab === k ? "active" : "", `role="tab" aria-selected="${ql.tab === k}"`)).join("")}</div></section>`;
  const pr = job.progress || {};
  const stats = `<div class="ql-kpis">${kpi("Candidates tested", x.counts?.evaluated ?? pr.evaluated ?? 0)}${kpi("Ranked", x.counts?.ranked ?? x.candidates.filter((c) => c.verdict === "ranked").length)}${kpi("Best validation score", best ? f2(best.score) : "—", SCORE_TEXT)}${kpi("Holdout", x.holdout?.evaluations ? `Used ${x.holdout.evaluations}×` : "Untouched")}</div>`;
  const progress = running ? `<div class="ql-progress"><progress max="${pr.budget || 1}" value="${pr.evaluated || 0}"></progress><span>${pr.evaluated || 0} of up to ${pr.budget || "?"} candidates</span></div>` : "";
  const warn = (x.warnings || []).length ? `<details ${x.warnings.length < 4 ? "open" : ""}><summary>${x.warnings.length} warning${x.warnings.length > 1 ? "s" : ""}</summary><ul>${x.warnings.slice(0, 40).map((w) => `<li>${e(w)}</li>`).join("")}</ul></details>` : "";
  const body = {
    overview: () => `<section class="panel">${stats}${progress}${job.error ? `<p class="down">${e(job.error)}</p>` : ""}${x.status === "cancelled" ? `<p class="ql-warn">Incomplete: stopped before the search finished. The candidates below are the ones that finished.</p>` : ""}${warn}${leaderboard(x, 10)}</section>`,
    leaderboard: () => `<section class="panel">${leaderboard(x)}</section>`,
    validation: () => validationTab(x),
    activity: () => `<section class="panel">${ql.events.length ? ctx.table(["#", "Time", "Event", "Detail"], ql.events.slice().reverse().map((ev) => `<tr><td>${ev.seq}</td><td>${e(ev.at.slice(11, 19))}</td><td>${e(ev.type)}</td><td><small>${e(ev.payload?.message || (ev.payload?.evaluated != null ? `${ev.payload.evaluated} evaluated` : ev.payload?.generation != null ? `generation ${ev.payload.generation}` : ""))}</small></td></tr>`)) : ctx.empty("No activity recorded.")}</section>`,
    settings: () => `<section class="panel"><pre class="ql-json">${e(JSON.stringify(x.config, null, 2))}</pre></section>`,
  }[ql.tab] || (() => "");
  return head + body();
}
const kpi = (label, value, title = "") => `<div class="stat" title="${e(title)}"><span>${label}</span><strong>${value}</strong></div>`;
function leaderboard(x, limit = null) {
  const minT = +ql.minTrades || 0,
    maxDD = ql.maxDD === "" ? null : -Math.abs(+ql.maxDD) / 100;
  let list = x.candidates.filter((c) => (c.validation.trades ?? 0) >= minT && (maxDD == null || (c.validation.maxDrawdown ?? 0) >= maxDD));
  const key = { score: (c) => c.score, sharpe: (c) => c.validation.sharpe ?? -99, ret: (c) => c.validation.totalReturn, dd: (c) => c.validation.maxDrawdown ?? -1, trades: (c) => c.validation.trades, stability: (c) => c.stability }[ql.sort];
  if (ql.sort !== "score") list = [...list].sort((a, b) => key(b) - key(a));
  const shown = limit ? list.slice(0, limit) : list;
  const sortBtn = (k, label, def) => `<button class="th-sort ${ql.sort === k ? "on" : ""}" data-action="ql-sort" data-value="${k}" title="${e(DEF[def] || "")}">${label}${ql.sort === k ? " ▼" : ""}</button>`;
  const bench = x.candidates[0]?.validation.benchmarkReturn;
  const rows = shown.map(
    (c) =>
      `<tr class="${c.verdict !== "ranked" ? "ql-dim" : ""}"><td><input type="checkbox" data-ql-pick="${e(c.strategyId)}" ${ql.picks.has(c.strategyId) ? "checked" : ""} aria-label="Select ${e(c.strategy.name)}"></td><td>${c.rank ?? "—"}</td><td class="ql-strat"><b>${e(c.strategy.name)}</b><small title="${e(`Entry: ${c.rules.entry}\nExit: ${c.rules.exit}`)}">${e(c.rules.entry)}</small></td><td>${f2(c.score)}</td><td>${f2(c.validation.sharpe)}</td><td class="${c.validation.totalReturn >= 0 ? "up" : "down"}">${p(c.validation.totalReturn)}</td><td>${p(c.validation.maxDrawdown)}</td><td>${c.validation.trades}</td><td>${f2(c.validation.turnover)}×</td><td>${p(c.stability)}</td><td>${f2(c.train.sharpe)}</td><td><small class="ql-status">${c.verdict === "ranked" ? "Ranked" : e([VERDICT[c.verdict], ...c.codes.map((k) => CODES[k] || k)].filter((v, i, a) => a.indexOf(v) === i).join(" · "))}</small></td><td>${btn("Inspect", "ql-inspect", c.strategyId, "link")}</td></tr>`,
  );
  const n = x.counts?.evaluated ?? x.candidates.length;
  const filters = limit ? "" : `<div class="ql-inline ql-filters"><label>Min validation trades<input type="number" min="0" data-ql-filter="minTrades" value="${e(ql.minTrades)}"></label><label>Max drawdown (%)<input type="number" min="0" max="100" data-ql-filter="maxDD" value="${e(ql.maxDD)}" placeholder="any"></label></div>`;
  return `<div class="panel-head"><h3>Leaderboard · validation window</h3><div class="ql-actions">${btn(`Freeze selection (${ql.picks.size})`, "ql-freeze", x.id, "primary", ql.picks.size >= 1 && ql.picks.size <= 4 && x.status === "completed" ? "" : 'disabled title="Select one to four candidates of a completed experiment"')}${btn("Compare", "ql-compare", x.id, "", ql.picks.size >= 2 && ql.picks.size <= 4 ? "" : 'disabled title="Select two to four candidates"')}</div></div>${filters}
  ${n > 1 ? `<p class="ql-warn">${n} candidates were compared on the validation window, so the top score is the best of ${n} tries and flatters the strategy. The sealed holdout exists to check it.</p>` : ""}
  ${x.candidates.length ? ctx.table(["", "Rank", "Strategy", sortBtn("score", "Score", "score"), sortBtn("sharpe", "Sharpe", "sharpe"), sortBtn("ret", "Return", "totalReturn"), sortBtn("dd", "Max DD", "maxDrawdown"), sortBtn("trades", "Trades", "trades"), th("Turnover", "turnover"), sortBtn("stability", "Stability", "stability"), "Train Sharpe", "Status", ""], rows) + (limit && list.length > limit ? btn(`All ${list.length} candidates`, "ql-tab", "leaderboard", "link") : "") : ctx.empty(x.status === "running" ? "Candidates appear as they finish." : "No candidates.")}
  ${bench != null ? `<small>Benchmark ${e(x.config.benchmarkInstrumentId)} buy-and-hold over the validation window: ${p(bench)}. Score: ${e(SCORE_TEXT)}</small>` : ""}`;
}
function validationTab(x) {
  const v = x.config.validation;
  const sels = ql.selections.map((s) => {
    const h = ql.holdouts[s.id];
    const label = h ? (h.untouched ? `<span class="pill on">Holdout evaluated · untouched</span>` : `<span class="pill">Holdout reused · not untouched</span>`) : `<span class="pill">Sealed</span>`;
    const action = h
      ? ""
      : ql.confirm === s.id
        ? `${btn("Evaluate holdout once", "ql-holdout", s.id, "primary")} ${btn("Not yet", "ql-holdout-cancel", s.id)}<p class="ql-warn">This uses up the holdout for this list. Changing a strategy after seeing it means the holdout is no longer untouched.</p>`
        : btn("Evaluate holdout…", "ql-holdout-ask", s.id);
    return `<div class="ql-sel"><div class="panel-head"><h3>Frozen ${e(s.selectedAt.slice(0, 16).replace("T", " "))} ${label}</h3>${action}</div>${s.holdoutPreviouslyViewed && !h ? `<p class="ql-warn">This experiment's holdout was already viewed for an earlier selection, so a result here would not be untouched.</p>` : ""}<ul>${s.strategies.map((st, i) => `<li>${btn(e(st.name), "ql-inspect", s.strategyIds[i], "link")} <small>${e(describe(st.entry))}</small></li>`).join("")}</ul>${h ? `<div data-ql-holdout="${e(s.id)}">${holdoutTable(s, h)}</div>` : ""}<small>Manifest <code>${e(s.manifestSha256.slice(0, 16))}</code></small></div>`;
  });
  return `<section class="panel"><div class="panel-head"><h2>Windows</h2></div>${ctx.table(["Window", "From", "To", "Use"], [
    `<tr><td>Training</td><td>${e(v.train.from)}</td><td>${e(v.train.to)}</td><td>Search fitness (discovery breeds on this)</td></tr>`,
    `<tr><td>Validation</td><td>${e(v.validation.from)}</td><td>${e(v.validation.to)}</td><td>Ranking: ${v.walkForwardFolds} walk-forward fold${v.walkForwardFolds > 1 ? "s" : ""}, ${v.embargoBars}-bar embargo</td></tr>`,
    `<tr><td>Holdout</td><td>${e(v.holdout.from)}</td><td>${e(v.holdout.to)}</td><td>Sealed until a selection is frozen, then evaluated once</td></tr>`,
  ])}</section><section class="panel"><div class="panel-head"><h2>Frozen selections</h2></div>${sels.length ? sels.join("") : ctx.empty("Select one to four candidates on the leaderboard and freeze them. Only a frozen list can be evaluated on the holdout.")}<small>A single holdout can't undo overfitting across the whole research process. Treat a good holdout as evidence, not proof.</small></section>`;
}
function holdoutTable(s, h) {
  const runs = ql.holdoutRuns?.[s.id];
  if (!runs) return `<p class="muted">Loading holdout results…</p>`;
  return ctx.table(
    ["Strategy", th("Return", "totalReturn"), th("Benchmark", "benchmarkReturn"), th("Sharpe", "sharpe"), th("Max DD", "maxDrawdown"), th("Trades", "trades"), "Evidence"],
    runs.map((r) => `<tr><td>${e(r.manifest.strategy.name)}</td><td class="${r.metrics.totalReturn >= 0 ? "up" : "down"}">${p(r.metrics.totalReturn)}</td><td>${p(r.metrics.benchmarkReturn)}</td><td>${f2(r.metrics.sharpe)}</td><td>${p(r.metrics.maxDrawdown)}</td><td>${r.metrics.trades}</td><td>${r.metrics.informative ? (h.untouched ? "Holdout · untouched" : "Holdout · reused") : "Not statistically informative"}</td></tr>`),
  );
}

// ---- Run detail -------------------------------------------------------------
async function openRun(exp, strategyId) {
  const c = exp.candidates.find((x) => x.strategyId === strategyId);
  const sel = ql.selections.find((s) => s.strategyIds.includes(strategyId) && ql.holdouts[s.id]);
  const data = await dataOf(exp);
  const items = windowsOf(exp.config, data.snapshot.bars.map((b) => b.date)).map(([split, window]) => ({ strategy: c.strategy, split, window }));
  const runs = await runInWorker(exp.config, data, items);
  for (const r of runs.slice(0, 2)) await store.saveRun(r, exp.id);
  if (sel) {
    const h = ql.holdouts[sel.id];
    for (const id of h.runIds) {
      const r = await store.getRun(id);
      if (r?.manifest.strategySha256 === strategyId) runs.push({ ...r, split: h.untouched ? "holdout" : "holdout (reused)" });
    }
  }
  ql.run = { exp, candidate: c, runs, split: "validation", tab: "replay", bars: data.snapshot.bars };
  ql.view = "run";
}
function runView() {
  const { exp, candidate: c, runs, split, tab } = ql.run;
  const r = runs.find((x) => x.split === split) || runs[0];
  const m = r.metrics;
  const isHoldout = r.split.startsWith("holdout");
  const label = isHoldout ? (r.split === "holdout" ? "Holdout · evaluated once" : "Holdout · reused, not untouched") : `Historical backtest · ${r.split}`;
  const strip = m.bars
    ? `<div class="ql-kpis">${[
        ["Total return", p(m.totalReturn), "totalReturn"],
        ["CAGR", m.cagr == null ? "— <small>under 1 year</small>" : p(m.cagr), "cagr"],
        ["Sharpe", f2(m.sharpe), "sharpe"],
        ["Max drawdown", p(m.maxDrawdown), "maxDrawdown"],
        ["Volatility", p(m.vol), "vol"],
        ["Profit factor", m.profitFactor == null ? "— <small>not enough trades</small>" : f2(m.profitFactor), "profitFactor"],
        ["Closed trades", m.trades, "trades"],
        ["Exposure", p(m.exposure), "exposure"],
        [`${e(exp.config.benchmarkInstrumentId)} buy & hold`, m.benchmarkReturn == null ? "—" : `${p(m.benchmarkReturn)}`, "benchmarkReturn"],
      ]
        .map(([l, v, k]) => kpi(l, v, `${DEF[k] || ""} Window: ${r.split}, ${m.from} → ${m.to}.`))
        .join("")}</div>${m.informative ? "" : `<p class="ql-warn">Not statistically informative: ${m.trades} closed trade${m.trades === 1 ? "" : "s"}, below the minimum of ${exp.config.validation.minClosedTrades}.</p>`}`
    : ctx.empty("No bars in this window.");
  const tabs = { replay: "Replay", trades: "Trades", rules: "Rules", robustness: "Robustness", data: "Data & assumptions", log: "Execution log" };
  const body = {
    replay: () => `<p class="muted">The ${e(r.split)} backtest revealed bar by bar. The numbers are final; only the drawing is paced.</p><div data-ql-replay="run"></div>`,
    trades: () =>
      (r.trades.length
        ? ctx.table(["Entry", "Exit", "Shares", "Entry price", "Exit price", "P&L", "Return", "Bars", "Exit reason"], r.trades.map((t) => `<tr><td>${e(t.entryAt)}</td><td>${e(t.exitAt)}</td><td>${t.qty}</td><td>${ctx.money(t.entryPrice)}</td><td>${ctx.money(t.exitPrice)}</td><td class="${t.pnl >= 0 ? "up" : "down"}">${ctx.money(t.pnl)}</td><td>${p(t.return)}</td><td>${t.bars}</td><td>${e(t.exitReason)}</td></tr>`))
        : ctx.empty("No closed trades in this window.")) +
      (r.openPosition ? `<p class="muted">Open at the end: ${r.openPosition.qty} shares from ${e(r.openPosition.entryAt)}, marked at ${ctx.money(r.openPosition.markPrice)} on ${e(r.openPosition.markedAt)} (unrealized ${ctx.money(r.openPosition.unrealizedPnl)}).</p>` : "") +
      `<details><summary>All ${r.fills.length} fills</summary>${ctx.table(["Signal (close)", "Filled (open)", "Side", "Shares", "Price", "Commission", "Slippage"], r.fills.map((f) => `<tr><td>${e(f.signalAt)}</td><td>${e(f.filledAt)}</td><td>${f.side}</td><td>${f.qty}</td><td>${ctx.money(f.price)}</td><td>${ctx.money(f.commission)}</td><td>${ctx.money(f.slippage)}</td></tr>`))}</details><p class="muted">Realized ${ctx.money(m.realizedPnl)} · unrealized ${ctx.money(m.unrealizedPnl)} · costs ${ctx.money(m.costs)}</p>`,
    rules: () => `<p><b>Enter</b> when ${e(describe(c.strategy.entry))}.<br><b>Exit</b> when ${e(describe(c.strategy.exit))}${c.strategy.constraints.maxHoldingBars ? `, or after ${c.strategy.constraints.maxHoldingBars} bars` : ""}.${c.strategy.constraints.cooldownBars ? ` Wait ${c.strategy.constraints.cooldownBars} bars after an exit before re-entering.` : ""}</p><pre class="ql-json">${e(JSON.stringify(c.strategy, null, 2))}</pre><small>Strategy SHA-256 <code>${e(c.strategyId)}</code>${c.parent ? ` · bred from <code>${e(c.parent.slice(0, 12))}</code> in generation ${c.generation}` : ""}</small>`,
    robustness: () => ctx.table(["Window", "From", "To", th("Return", "totalReturn"), th("Sharpe", "sharpe"), th("Max DD", "maxDrawdown"), th("Trades", "trades"), th("Benchmark", "benchmarkReturn")], runs.map((x) => `<tr><td>${e(x.split)}</td><td>${e(x.metrics.from || "—")}</td><td>${e(x.metrics.to || "—")}</td><td class="${x.metrics.totalReturn >= 0 ? "up" : "down"}">${p(x.metrics.totalReturn)}</td><td>${f2(x.metrics.sharpe)}</td><td>${p(x.metrics.maxDrawdown)}</td><td>${x.metrics.trades ?? 0}</td><td>${p(x.metrics.benchmarkReturn)}</td></tr>`)) + `<p class="muted">Stability: ${p(c.stability)} of folds had a positive Sharpe. Score ${f2(c.score)}. ${e(SCORE_TEXT)}</p>`,
    data: () => `<dl class="ql-facts"><dt>Dataset</dt><dd><code>${e(r.manifest.dataset.id)}</code> · ${e(r.manifest.dataset.symbol)} · ${e(r.manifest.dataset.source)}</dd><dt>Bars</dt><dd>${r.manifest.dataset.bars} · ${e(r.manifest.dataset.from)} → ${e(r.manifest.dataset.to)}</dd><dt>Data SHA-256</dt><dd><code>${e(r.manifest.dataset.sha256)}</code></dd><dt>Benchmark</dt><dd>${r.manifest.benchmark ? `<code>${e(r.manifest.benchmark.id)}</code> ${e(r.manifest.benchmark.symbol)}` : "—"}</dd><dt>Engine</dt><dd>${e(r.manifest.engineVersion)}</dd><dt>Manifest SHA-256</dt><dd><code>${e(r.manifestSha256)}</code></dd><dt>Results SHA-256</dt><dd><code>${e(r.artifactsSha256)}</code></dd></dl><ul>${r.manifest.assumptions.map((a) => `<li>${e(a)}</li>`).join("")}</ul>${r.manifest.warnings.length ? `<p class="ql-warn">${r.manifest.warnings.map(e).join("<br>")}</p>` : ""}`,
    log: () => (r.rejected.length ? ctx.table(["Bar", "Signal", "What happened"], r.rejected.map((x) => `<tr><td>${e(x.at)}</td><td>${e(x.signalAt || "")}</td><td>${e({ NO_NEXT_BAR_IN_WINDOW: `${x.side === "sell" ? "Exit" : "Entry"} signal on the window's last bar; no next open to fill at`, INSUFFICIENT_CASH: "Entry skipped: not enough cash for one share after costs", NO_DATA_IN_WINDOW: "No bars in this window" }[x.reason] || x.reason)}</td></tr>`)) : ctx.empty("Every signal in this window was filled.")),
  }[tab]();
  return `<div class="ql-crumbs">${btn("← " + e(exp.name), "ql-open", exp.id, "link")}</div><section class="panel"><div class="panel-head"><h2>${e(c.strategy.name)} <span class="pill ${isHoldout ? "on" : ""}">${label}</span></h2><div class="ql-actions">${btn("Export manifest", "ql-export", "manifest")}${btn("Trades CSV", "ql-export", "trades")}${btn("Strategy JSON", "ql-export", "strategy")}${btn("Report", "ql-export", "report")}<button disabled title="Paper forward testing comes in a later version">Paper forward test</button></div></div>
  <div class="ql-seg" role="tablist">${runs.map((x) => btn(e(x.split), "ql-split", x.split, x.split === r.split ? "active" : "")).join("")}</div>
  <p class="muted">${e(m.from || "")} → ${e(m.to || "")} · ${e(exp.config.universe.instrumentIds[0])} · costs ${exp.config.execution.commissionBps} + ${exp.config.execution.slippageBps} bps · fills at next open</p>${strip}
  <div class="grid halves"><div><h3>Equity vs ${e(exp.config.benchmarkInstrumentId)} (start = 0%)</h3><div class="rc" data-ql-chart="equity" style="min-height:220px"><div class="rc-tip" hidden></div></div></div><div><h3>Drawdown</h3><div class="rc" data-ql-chart="dd" style="min-height:220px"><div class="rc-tip" hidden></div></div></div></div>
  <h3>Price with entries ▲ and exits ▼</h3><div class="rc" data-ql-chart="price" style="min-height:240px"><div class="rc-tip" hidden></div></div></section>
  <section class="panel"><div class="ql-seg" role="tablist">${Object.entries(tabs).map(([k, l]) => btn(l, "ql-rtab", k, tab === k ? "active" : "")).join("")}</div>${body}</section>`;
}

// Two-line chart sharing hover with the risk charts.
function multiLine(dates, series, { fmt, H = 220, marks = [] }, W) {
  const L = 4, R = 64, T = 12, B = 24, iw = W - L - R, ih = H - T - B;
  const vals = series.flatMap((s) => s.values).filter((v) => v != null && Number.isFinite(v));
  if (!vals.length || dates.length < 2) return null;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  lo -= pad;
  hi += pad;
  const x = (i) => L + (i / Math.max(1, dates.length - 1)) * iw;
  const y = (v) => T + ((hi - v) / (hi - lo)) * ih;
  let out = "";
  for (const v of ticks(lo, hi, 3)) out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gridline"/><text x="${W - R + 8}" y="${y(v) + 3}">${ctx.esc(fmt(v))}</text>`;
  for (const s of series) {
    let seg = [];
    const flush = () => {
      if (seg.length > 1) out += `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width || 1.6}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round" points="${seg.join(" ")}"/>`;
      seg = [];
    };
    s.values.forEach((v, i) => (v == null ? flush() : seg.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`)));
    flush();
  }
  for (const mk of marks) {
    const cx = x(mk.i), cy = y(mk.value);
    out += mk.kind === "buy" ? `<path d="M${cx - 4},${cy + 9} L${cx + 4},${cy + 9} L${cx},${cy + 3} Z" fill="#3a95d8"/>` : `<path d="M${cx - 4},${cy - 9} L${cx + 4},${cy - 9} L${cx},${cy - 3} Z" fill="#d07a24"/>`;
  }
  out += `<text x="${x(0)}" y="${H - 7}">${ctx.esc(dates[0])}</text><text x="${x(dates.length - 1)}" y="${H - 7}" text-anchor="end">${ctx.esc(dates.at(-1))}</text>`;
  const legend = series.map((s, i) => `<g transform="translate(${L + 4 + i * 120},${T + 2})"><line x1="0" x2="14" y1="4" y2="4" stroke="${s.color}" stroke-width="2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""}/><text x="18" y="7">${ctx.esc(s.name)}</text></g>`).join("");
  return {
    svg: `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${out}${legend}<line class="rc-cross" y1="${T}" y2="${H - B}" stroke="#8d8d8d" visibility="hidden"/></svg>`,
    n: dates.length,
    x,
    mode: "x",
    tip: (i) => [dates[i], series.map((s) => [s.name, s.values[i] == null ? "—" : fmt(s.values[i])])],
  };
}
function paintRun() {
  const { runs, split, bars } = ql.run;
  const r = runs.find((x) => x.split === split) || runs[0];
  if (!r?.dates.length) return;
  const eq = r.equity.map((v) => v / r.initialCash - 1);
  const firstB = r.benchmarkCurve.find((v) => v != null);
  const bq = r.benchmarkCurve.map((v) => (v == null || !firstB ? null : v / firstB - 1));
  const idx = new Map(r.dates.map((d, i) => [d, i]));
  const close = new Map(bars.map((b) => [b.date, b.close]));
  const build = {
    equity: (W) => multiLine(r.dates, [{ name: "Strategy", values: eq, color: "#ededed", width: 2 }, { name: ql.run.exp.config.benchmarkInstrumentId, values: bq, color: "#8d8d8d", dash: "4 3" }], { fmt: (v) => ctx.pct(v) }, W),
    dd: (W) => {
      let peak = r.initialCash;
      const rows = r.equity.map((v, i) => [r.dates[i], ((peak = Math.max(peak, v)), v / peak - 1)]);
      return rows.length > 1 && lineChart(rows, { fmt: (v) => (v * 100).toFixed(1) + "%", wash: "below", H: 220 }, W);
    },
    price: (W) =>
      multiLine(r.dates, [{ name: "Close", values: r.dates.map((d) => close.get(d) ?? null), color: "#ededed" }], {
        fmt: (v) => ctx.money(v),
        H: 240,
        marks: r.fills.filter((f) => idx.has(f.filledAt)).map((f) => ({ i: idx.get(f.filledAt), value: f.price, kind: f.side })),
      }, W),
  };
  document.querySelectorAll("[data-ql-chart]").forEach((el) => {
    const W = Math.max(240, Math.round(el.clientWidth));
    const chart = build[el.dataset.qlChart]?.(W);
    el.querySelector("svg")?.remove();
    if (!chart) return;
    el.insertAdjacentHTML("afterbegin", chart.svg);
    el.style.minHeight = "";
    hover(el, chart);
  });
}

// ---- Comparison --------------------------------------------------------------
function compareView() {
  const { exp, runs, candidates } = ql.compare;
  const corr = correlations(runs);
  const rows = [
    ["Score", (i) => f2(candidates[i].score), "score"],
    ["Total return", (i) => p(runs[i].metrics.totalReturn), "totalReturn"],
    ["CAGR", (i) => p(runs[i].metrics.cagr), "cagr"],
    ["Sharpe", (i) => f2(runs[i].metrics.sharpe), "sharpe"],
    ["Max drawdown", (i) => p(runs[i].metrics.maxDrawdown), "maxDrawdown"],
    ["Volatility", (i) => p(runs[i].metrics.vol), "vol"],
    ["Profit factor", (i) => f2(runs[i].metrics.profitFactor), "profitFactor"],
    ["Closed trades", (i) => runs[i].metrics.trades, "trades"],
    ["Exposure", (i) => p(runs[i].metrics.exposure), "exposure"],
    ["Turnover", (i) => f2(runs[i].metrics.turnover) + "×", "turnover"],
    ["Stability", (i) => p(candidates[i].stability), "stability"],
    [`Benchmark (${e(exp.config.benchmarkInstrumentId)})`, (i) => p(runs[i].metrics.benchmarkReturn), "benchmarkReturn"],
  ];
  return `<div class="ql-crumbs">${btn("← " + e(exp.name), "ql-open", exp.id, "link")}</div><section class="panel"><div class="panel-head"><h2>Compare · validation window</h2></div><p class="muted">Same experiment: the same validation window (${e(exp.config.validation.validation.from)} → ${e(exp.config.validation.validation.to)}), costs, starting cash and benchmark, so these runs are directly comparable.</p>
  ${ctx.table(["Metric", ...runs.map((r) => e(r.manifest.strategy.name))], rows.map(([l, fn, k]) => `<tr><td title="${e(DEF[k] || "")}">${l}</td>${runs.map((_, i) => `<td>${fn(i)}</td>`).join("")}</tr>`))}
  <h3>Correlation of daily returns</h3>${ctx.table(["", ...runs.map((r) => e(r.manifest.strategy.name))], runs.map((r, i) => `<tr><td>${e(r.manifest.strategy.name)}</td>${corr[i].map((c) => `<td>${c == null ? "—" : c.toFixed(2)}</td>`).join("")}</tr>`))}<small>Pearson correlation over shared dates, including flat days.</small></section>`;
}

// ---- Exports -----------------------------------------------------------------
function csv(rows) {
  return rows.map((r) => r.map((v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";
}
function exportRun(kind) {
  const { candidate: c, runs, split, exp } = ql.run;
  const r = runs.find((x) => x.split === split) || runs[0];
  const base = `${exp.config.universe.instrumentIds[0]}-${c.strategyId.slice(0, 8)}-${r.split.replace(/\W+/g, "-")}`;
  if (kind === "manifest") return ctx.download(`${base}-manifest.json`, JSON.stringify({ manifest: r.manifest, manifestSha256: r.manifestSha256, artifactsSha256: r.artifactsSha256, metrics: r.metrics }, null, 2), "application/json");
  if (kind === "strategy") return ctx.download(`${base}-strategy.json`, JSON.stringify(c.strategy, null, 2), "application/json");
  if (kind === "trades") return ctx.download(`${base}-fills.csv`, csv([["signal_at", "filled_at", "side", "qty", "price", "commission", "slippage", "realized_pnl", "reason"], ...r.fills.map((f) => [f.signalAt, f.filledAt, f.side, f.qty, f.price.toFixed(6), f.commission.toFixed(6), f.slippage.toFixed(6), f.realizedPnl?.toFixed(6), f.reason])]), "text/csv");
  const m = r.metrics;
  const report = `# ${c.strategy.name}\n\nHistorical backtest, ${r.split} window ${m.from} to ${m.to}. Not a forecast or a recommendation.\n\n- Entry: ${describe(c.strategy.entry)}\n- Exit: ${describe(c.strategy.exit)}\n\n| Metric | Value |\n|---|---|\n${[["Total return", p(m.totalReturn)], ["CAGR", p(m.cagr)], ["Sharpe", f2(m.sharpe)], ["Max drawdown", p(m.maxDrawdown)], ["Closed trades", m.trades], ["Benchmark return", p(m.benchmarkReturn)]].map(([k, v]) => `| ${k} | ${v} |`).join("\n")}\n\n## Assumptions\n\n${r.manifest.assumptions.map((a) => `- ${a}`).join("\n")}\n\nDataset ${r.manifest.dataset.id} (SHA-256 ${r.manifest.dataset.sha256}), engine ${r.manifest.engineVersion}, manifest SHA-256 ${r.manifestSha256}.\n`;
  ctx.download(`${base}-report.md`, report, "text/markdown");
}

// ---- Simulation replay ------------------------------------------------------------
function simulate() {
  const d = ql.draft;
  if (!draftBars || !d?.windows) return ctx.notify("Load data first.", true);
  const strategy = buildConfig(d).strategy;
  const errs = strategy ? validateStrategy(strategy) : ["Not valid JSON yet."];
  if (errs.length) return ctx.notify(errs[0], true);
  const o = simOpts(d);
  if (indCache.bars !== draftBars) (indCache.clear(), (indCache.bars = draftBars));
  ql.sim = { title: strategy.name, from: o.from, to: o.to, data: { bars: draftBars, result: backtest(draftBars, strategy, o, indCache) } };
}
function mountReplays() {
  const draft = document.querySelector('#app [data-ql-replay="draft"]');
  if (draft && ql.sim) mountReplay(draft, "draft", ql.sim.data);
  const run = document.querySelector('#app [data-ql-replay="run"]');
  if (run && ql.run) {
    const r = ql.run.runs.find((x) => x.split === ql.run.split) || ql.run.runs[0];
    mountReplay(run, "run:" + r.manifestSha256 + r.split, (ql.run.replay ||= new Map()).get(r) || ql.run.replay.set(r, { bars: ql.run.bars, result: r }).get(r));
  }
}

// ---- Actions and bindings ------------------------------------------------------
export async function labAction(act, value) {
  switch (act) {
    case "ql-home":
      ql.view = "home";
      ql.exp = null;
      await reload();
      break;
    case "ql-filter":
      ql.filter = value;
      break;
    case "ql-new":
      ql.view = "new";
      await newDraft(ctx.symbol());
      break;
    case "ql-load":
      readForm();
      await loadCoverage(true);
      break;
    case "ql-horizon":
      ql.horizon = value;
      break;
    case "ql-tpl":
      readForm();
      ql.draft.manual.template = value;
      if (value === "custom") ql.draft.manual.json ||= JSON.stringify(TEMPLATES.price_sma.build(TEMPLATE_PARAMS("price_sma")), null, 2);
      else ql.draft.manual.params = TEMPLATE_PARAMS(value);
      if (ql.sim) simulate();
      break;
    case "ql-sim":
      readForm();
      simulate();
      requestAnimationFrame(() => document.querySelector("#app .ql-sim-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }));
      break;
    case "ql-sim-close":
      ql.sim = null;
      break;
    case "ql-mode":
      readForm();
      ql.draft.mode = value;
      break;
    case "ql-run":
      readForm();
      await startResearch();
      break;
    case "ql-open":
      ql.view = "exp";
      ql.tab = "overview";
      ql.exp = ql.experiments.find((x) => x.id === value) || (await store.getExperiment(value));
      ql.picks.clear();
      await reload();
      await loadHoldoutRuns();
      break;
    case "ql-tab":
      ql.tab = value;
      if (value === "validation") await loadHoldoutRuns();
      break;
    case "ql-sort":
      ql.sort = value;
      break;
    case "ql-cancel":
      jobs.get(value)?.worker.postMessage({ type: "cancel" });
      break;
    case "ql-rerun": {
      const exp = ql.experiments.find((x) => x.id === value);
      const data = await dataOf(exp);
      const createdAt = nowIso();
      const copy = { ...structuredClone(exp), id: "exp_" + sha256(canonical(exp.config) + createdAt).slice(0, 16), name: `${exp.name} (re-run)`, createdAt, status: "queued", candidates: [], counts: null, holdout: null, archived: false, job: null, savedSelections: [] };
      await store.saveExperiment(copy);
      await launch(copy, data);
      ql.exp = copy;
      ql.tab = "overview";
      await reload();
      ctx.notify("Re-running on the same frozen dataset.");
      break;
    }
    case "ql-duplicate": {
      const exp = ql.experiments.find((x) => x.id === value);
      ql.view = "new";
      await newDraft(exp.config.universe.instrumentIds[0], exp.config);
      ctx.notify("Settings copied. Load data gets a fresh snapshot.");
      break;
    }
    case "ql-archive": {
      const exp = ql.experiments.find((x) => x.id === value);
      exp.archived = !exp.archived;
      await store.saveExperiment(exp);
      await reload();
      break;
    }
    case "ql-export-exp": {
      const exp = ql.experiments.find((x) => x.id === value);
      const selections = await store.listSelections(exp.id);
      const holdouts = await Promise.all(selections.map((s) => store.getHoldout(s.id)));
      ctx.download(`${exp.name.replace(/\W+/g, "-")}-experiment.json`, JSON.stringify({ experiment: exp, selections, holdouts }, null, 2), "application/json");
      break;
    }
    case "ql-freeze": {
      const exp = ql.exp;
      const sel = await store.freezeSelection(exp, [...ql.picks]);
      exp.savedSelections = [...(exp.savedSelections || []).filter((s) => s.id !== sel.id), { id: sel.id, count: sel.strategyIds.length, selectedAt: sel.selectedAt, evaluated: false }];
      await store.saveExperiment(exp);
      ql.picks.clear();
      ql.tab = "validation";
      await reload();
      ctx.notify("Selection frozen. Its holdout is still sealed.");
      break;
    }
    case "ql-holdout-ask":
      ql.confirm = value;
      break;
    case "ql-holdout-cancel":
      ql.confirm = null;
      break;
    case "ql-holdout": {
      ql.confirm = null;
      const exp = ql.exp;
      const sel = ql.selections.find((s) => s.id === value);
      if (await store.getHoldout(sel.id)) throw Error("This selection's holdout was already evaluated.");
      const data = await dataOf(exp);
      const runs = await runInWorker(exp.config, data, sel.strategies.map((strategy) => ({ strategy, split: "holdout", window: exp.config.validation.holdout })));
      const rec = await store.recordHoldout(exp, sel, runs);
      exp.savedSelections = (exp.savedSelections || []).map((s) => (s.id === sel.id ? { ...s, evaluated: true, untouched: rec.untouched } : s));
      await store.saveExperiment(exp);
      await reload();
      await loadHoldoutRuns();
      break;
    }
    case "ql-inspect":
      await openRun(ql.exp, value);
      break;
    case "ql-split":
      ql.run.split = value;
      break;
    case "ql-rtab":
      ql.run.tab = value;
      break;
    case "ql-export":
      exportRun(value);
      return true;
    case "ql-compare": {
      const exp = ql.exp;
      const candidates = [...ql.picks].map((id) => exp.candidates.find((c) => c.strategyId === id));
      const runs = await runInWorker(exp.config, await dataOf(exp), candidates.map((c) => ({ strategy: c.strategy, split: "validation", window: exp.config.validation.validation })));
      ql.compare = { exp, runs, candidates };
      ql.view = "compare";
      break;
    }
    default:
      return false;
  }
  ctx.render();
  return true;
}
async function loadHoldoutRuns() {
  ql.holdoutRuns = {};
  for (const s of ql.selections) {
    const h = ql.holdouts[s.id];
    if (h) ql.holdoutRuns[s.id] = (await Promise.all(h.runIds.map((id) => store.getRun(id)))).filter(Boolean);
  }
}
function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ||= {};
  o[keys.at(-1)] = value;
}
function readForm() {
  if (!ql.draft) return;
  document.querySelectorAll("#app [data-ql]").forEach((el) => {
    const v = el.type === "number" ? (el.value === "" ? "" : +el.value) : el.dataset.type === "text" ? el.value : el.tagName === "SELECT" ? el.value : el.value.trim();
    setPath(ql.draft, el.dataset.ql, el.dataset.ql === "symbol" || el.dataset.ql === "benchmark" ? String(v).toUpperCase() : v);
  });
  const checks = [...document.querySelectorAll("#app [data-ql-indicator]")];
  if (checks.length) ql.draft.discovery.allowedIndicators = checks.filter((c) => c.checked).map((c) => c.dataset.qlIndicator);
}
export function labPaint() {
  if (ql.view === "run" && ql.run) paintRun();
  mountReplays();
  document.querySelectorAll("#app [data-ql]").forEach((el) => {
    el.onchange = () => {
      const before = ql.draft?.manual.template + "|" + ql.draft?.sweep.template;
      readForm();
      const d = ql.draft;
      if (el.dataset.ql === "manual.template" && d.manual.template !== "custom") d.manual.params = TEMPLATE_PARAMS(d.manual.template);
      if (el.dataset.ql === "manual.template" && d.manual.template === "custom" && !d.manual.json) d.manual.json = JSON.stringify(TEMPLATES.sma_cross.build(TEMPLATE_PARAMS("sma_cross")), null, 2);
      if (el.dataset.ql === "sweep.template") d.sweep.ranges = structuredClone(sweepDefault(d.sweep.template));
      if (el.hasAttribute("data-ql-rerender") || before !== d.manual.template + "|" + d.sweep.template) return ctx.render();
      const pv = document.querySelector("#app [data-ql-preview]"),
        wl = document.querySelector("#app [data-ql-workload]");
      if (pv) pv.innerHTML = preview(d);
      if (ql.sim && el.dataset.ql.startsWith("manual.")) (simulate(), mountReplays());
      if (wl) wl.textContent = workloadText(d);
    };
  });
  document.querySelectorAll("#app [data-ql-indicator]").forEach((el) => (el.onchange = () => (readForm(), ctx.render())));
  document.querySelectorAll("#app [data-ql-pick]").forEach(
    (el) =>
      (el.onchange = () => {
        el.checked ? ql.picks.add(el.dataset.qlPick) : ql.picks.delete(el.dataset.qlPick);
        ctx.render();
      }),
  );
  document.querySelectorAll("#app [data-ql-filter]").forEach((el) => (el.onchange = () => ((ql[el.dataset.qlFilter] = el.value), ctx.render())));
  document.querySelectorAll("#app [data-ql-open]").forEach(
    (el) =>
      (el.onkeydown = (ev) => {
        if (ev.key === "Enter") labAction("ql-open", el.dataset.qlOpen).catch((err) => ctx.notify(err.message, true));
      }),
  );
  document.querySelectorAll("#app [data-ql-import]").forEach(
    (el) =>
      (el.onchange = async () => {
        try {
          const json = JSON.parse(await el.files[0].text());
          const config = json.experiment?.config || (json.schemaVersion === 1 && json.mode ? json : null);
          const strategy = json.entry && json.exit ? json : json.manifest?.strategy;
          ql.view = "new";
          if (config) await newDraft(config.universe.instrumentIds[0], config);
          else if (strategy) {
            await newDraft(ctx.symbol());
            ql.draft.mode = "manual";
            ql.draft.manual = { template: "custom", params: {}, json: JSON.stringify(strategy, null, 2) };
          } else throw Error("That file is not a Quant Lab experiment, manifest or strategy.");
          ctx.render();
        } catch (err) {
          ctx.notify(err.message, true);
        }
      }),
  );
}
export { indicatorLabel };
