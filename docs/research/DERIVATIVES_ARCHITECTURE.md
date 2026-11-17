# Derivatives Analytics — Proposed Architecture

Status: proposal, not implemented. Written 2026-11-17 against `main` at `096acef`.
Read [Feasibility](DERIVATIVES_FEASIBILITY.md) first for data sources and model choices.

## 1. Principles

1. **Keep the stack.** Tauri 2 + Rust + SQLite + vanilla JS + Lightweight Charts + SVG builders + the bundled Python. No new runtime, no server, no microservices. Nothing in this plan needs one: the heaviest workload (a full American chain) is seconds of CPU on a laptop.
2. **Ingestion in Rust, math in pure JS, batch fitting in Python.** This mirrors the current split:
   - Rust owns keys, quotas, HTTP and SQLite (`providers.rs`, `fetch_data` in `main.rs`).
   - Calculations are pure, testable JS modules (`engine.js`, `quantlab/*`) run on the UI thread or in a Worker.
   - Heavy scientific work runs as a fixed script in the bundled Python (`quant.py` via `quant.rs`).
3. **One canonical implementation per formula.** Options math lives in `src/options/` (JS). Rust only *stores* derived numbers and never recomputes them. Python reimplements the core formulas **only as a test oracle** (§8), plus the SVI fitter, which has no JS counterpart.
4. **Provider-independent contracts.** Every chain source normalizes to one `OptionQuote` schema before anything else sees it.
5. **Separate large data from the workspace blob.** Chains and history go to a new `options.sqlite`, as 13F data went to `reference.sqlite`.
6. **Every number carries its class** (observed / derived / model / simulation; see Feasibility §2) and its provenance.

## 2. Component map

```
                         ┌───────────────────────────── UI (src/main.js + views) ─────────────────────────────┐
                         │ Stock page: OMON · VOL · OSA · EVT · GEX     Markets: Volatility page              │
                         │ Portfolio: Greeks, scenario grid             Trade: option ticket                   │
                         │ Quant Lab: vol/event experiments              Analyst: vol facts in briefing        │
                         └───────────────▲───────────────────────────────▲───────────────────────────────▲────┘
                                         │ view models                   │                               │
              ┌──────────────────────────┴──────────┐      ┌─────────────┴────────────┐      ┌───────────┴──────────┐
              │ src/options/ (pure JS, node-tested) │      │ src/options/worker.js    │      │ src/riskcharts.js +  │
              │  contract.js   normalize, OCC ids   │      │ chain-wide IV/Greeks,    │      │ src/options/charts.js│
              │  bsm.js        BSM / Black-76       │◄────►│ scenario grids, hedging  │      │ smile, term, payoff, │
              │  american.js   LR/CRR binomial      │      │ sims (off UI thread)     │      │ GEX, heatmap (SVG)   │
              │  iv.js         solver + flags       │      └──────────────────────────┘      └──────────────────────┘
              │  forward.js    parity forward       │
              │  rates.js      curve from FRED      │      ┌──────────────────────────────────────────────────────┐
              │  realized.js   YZ/GK/Parkinson, cone│      │ src-tauri/src/vol.py (bundled Python, fixed script)   │
              │  surface.js    smile/term summaries │◄────►│ SVI fit + arbitrage checks · GARCH(1,1) MLE ·          │
              │  events.js     implied move, E, crush│     │ oracle tests for bsm/iv                               │
              │  exposure.js   GEX (conventions)    │      └──────────────────────────▲───────────────────────────┘
              │  portfolio.js  position/book Greeks │                                 │ stdin/stdout JSON (quant.rs pattern)
              │  hedge.js      delta-hedge sim      │                                 │
              │  quality.js    staleness, arb checks│                                 │
              └──────────────────▲──────────────────┘                                 │
                                 │ bridge.js (invoke)                                 │
┌────────────────────────────────┴──────────────── Rust (src-tauri/src) ─────────────┴───────────────────────────────┐
│ providers.rs  + "alpaca" kinds: option_contracts, option_snapshots; "massive" provider (optional, paid)           │
│               + "fred" observation_start/offset;  + budgets                                                       │
│ options.rs    NEW pure module: normalize provider JSON → OptionQuote rows; OCC symbol parse; snapshot schema        │
│ main.rs       commands: options_chain, options_snapshot_record, options_history, options_import_csv, vol_fit       │
│ ledger.rs     + instrument kind, multiplier, expiry/settlement events, defined-risk shorts                          │
│ options.sqlite NEW: contracts, snapshots, quotes, daily_summary, events  (WAL, separate from workspace)            │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Data model

### 3.1 Normalized contract and quote (JS and Rust share this shape)

```js
// OptionContract: static per contract
{
  id: "O:AAPL261218C00250000",   // provider-independent: "O:" + OCC symbol (no padding)
  underlying: "AAPL",            // workspace symbol; Indian: "NIFTY:XNSE"
  root: "AAPL",                  // OCC root (differs after adjustments, e.g. "AAPL1")
  type: "call" | "put",
  strike: 250,                   // in underlying currency
  expiry: "2026-12-18",
  expiryTime: "16:00 America/New_York" | "09:30 America/New_York (AM-settled)" | "15:30 Asia/Kolkata",
  style: "american" | "european",
  settlement: "physical" | "cash",
  multiplier: 100,               // cash multiplier
  deliverable: 100,              // shares on exercise; ≠ multiplier → "adjusted"
  adjusted: false,
  currency: "USD",
}
// OptionQuote: one observation
{
  contractId, provider: "alpaca", feed: "indicative" | "opra" | "eod" | "import",
  quoteTime: 1794076205000, retrievedAt: 1794076210000,
  bid, ask, bidSize, askSize, last, lastTime, volume, openInterest, oiDate,
  vendor: { iv, delta, gamma, theta, vega, rho } | null,   // what the provider said; never mixed with ours
  underlyingPrice, underlyingTime,                          // what we priced against
  flags: ["indicative", "wide-spread", "stale-quote", "below-intrinsic", ...]
}
```

**Our** computed IV and Greeks are a separate derived record keyed by (contractId, quoteTime, modelVersion). Vendor values are kept only for cross-checking.

### 3.2 `options.sqlite` (new, in the app-data folder)

```sql
CREATE TABLE contracts(id TEXT PRIMARY KEY, underlying TEXT, root TEXT, type TEXT, strike REAL,
  expiry TEXT, style TEXT, settlement TEXT, multiplier REAL, deliverable REAL, adjusted INTEGER,
  currency TEXT, first_seen INTEGER, last_seen INTEGER);
CREATE INDEX contracts_u ON contracts(underlying, expiry, strike);

-- One immutable capture of a chain (write-once, like quant_lab snapshots)
CREATE TABLE snapshots(id TEXT PRIMARY KEY,             -- "snap_" + sha256(content)[:20]
  underlying TEXT, provider TEXT, feed TEXT, taken_at INTEGER, underlying_price REAL,
  underlying_time INTEGER, rate_curve TEXT, model_version TEXT, content_sha256 TEXT,
  kind TEXT);                                           -- "eod" | "manual" | "import"
CREATE INDEX snapshots_u ON snapshots(underlying, taken_at);

CREATE TABLE quotes(snapshot TEXT, contract TEXT, bid REAL, ask REAL, last REAL, volume REAL,
  oi REAL, oi_date TEXT, quote_time INTEGER, v_iv REAL, v_delta REAL, v_gamma REAL,
  iv REAL, delta REAL, gamma REAL, theta REAL, vega REAL, rho REAL, flags TEXT,
  PRIMARY KEY(snapshot, contract)) WITHOUT ROWID;

-- Derived, small, kept forever: the basis of IV history, rank, skew history, event studies
CREATE TABLE daily_summary(underlying TEXT, date TEXT, source_snapshot TEXT,
  atm_iv_30 REAL, atm_iv_60 REAL, atm_iv_90 REAL, rr25_30 REAL, bf25_30 REAL,
  term TEXT,            -- JSON [{expiry, T, F, atmIV, n_ok}]
  svi TEXT,             -- JSON per expiry {a,b,rho,m,sigma,rmse,arb}
  gex TEXT,             -- JSON {convention: {total, flip, byStrike}}
  quality TEXT, PRIMARY KEY(underlying, date)) WITHOUT ROWID;

CREATE TABLE events(id TEXT PRIMARY KEY, underlying TEXT, kind TEXT,  -- earnings|fomc|cpi|dividend
  date TEXT, timing TEXT, source TEXT, source_url TEXT, recorded_at INTEGER);
```

Retention: `quotes` pruned after N days (default 90, configurable in Settings → Reference data, the way 13F quarters are). `snapshots` and `daily_summary` are kept. Pruning never touches a snapshot referenced by a Quant Lab run or a saved event study. The Rust check is the same `immutable` idea as `lab.rs`.

### 3.3 Workspace additions (small, in the JSON blob)

- `account.trades[]` gains `instrument: { kind: "equity" | "option", contractId?, multiplier? }`. Older trades migrate to `kind: "equity"`, with `SCHEMA` bumped from 2 to 3 in `engine.js migrate()`.
- `state.options = { watch: [...underlyings], recorder: { enabled, time: "16:15 ET" }, gexConvention: "compare" }`.

## 4. Pipelines

### 4.1 Chain fetch (on demand)

```
UI opens OMON for AAPL
 └─ bridge.optionsChain("AAPL", {expiries})          JS
     └─ invoke options_chain                          Rust
         ├─ providers::validate("alpaca","option_snapshots","AAPL")
         ├─ cache lookup  "alpaca:option_snapshots:AAPL"   (ttl 15 min market hours, 12 h closed)
         ├─ budget/gap gate (fast_gate, like Finnhub/Alpaca today)
         ├─ paginate snapshots (limit 1000, page_token) + contracts (OI, multiplier, style)
         └─ options::normalize → Vec<OptionQuote>   (pure, unit-tested on fixtures)
 └─ options/worker.js: forward.js → iv.js → greeks → quality.js   JS (pure)
 └─ view model → OMON table, smile, term charts
```

The underlying price is the Finnhub stream price if streaming and fresh, otherwise the latest daily close, and the option quote time is compared against it (`quality.js` rule 1).

### 4.2 EOD snapshot recorder (builds history from day one)

```
Once per trading day after 16:15 ET while the app is open (or at next launch, labelled "late capture"):
 for each underlying in state.options.watch (cap ~30):
   chain fetch (4.1) → compute IV/Greeks → write snapshot + quotes (write-once)
   → summarize (ATM IV by constant maturity, 25Δ RR/BF, term JSON, GEX by convention)
   → batch SVI fits through vol.py (one Python start for all symbols)
   → daily_summary row
```

There is no daemon, consistent with the current app (Alerts run only while the app is open). A missed day is a **gap**, never interpolated. The snapshot time is recorded, and a late capture is flagged because next-morning quotes are not closing quotes.

### 4.3 Backfill (optional, paid)

Massive Basic/Starter EOD contract aggregates (2 years) → recompute IV from close prices against the underlying close. Each row is flagged `backfill-last-trade`, because closes are last trades and can be stale. Backfilled summaries are stored with `quality.source = "backfill"` and are visually distinct in charts.

### 4.4 Indian EOD import

User downloads the NSE F&O bhavcopy and the India VIX CSV → `options_import_csv` (Rust; reuses the CSV parsing rules in `engine.js parseCSV`, including formula neutralization) → contracts + snapshot `kind: "import"` with `feed: "eod"` and settle prices → Black-76 IV against the same-expiry NIFTY future settle from the same file. No network request is made.

### 4.5 Volatility indices and rates

Existing `fetch_data("fred", "observations", id)`. Add `VIXCLS`, `VXVCLS`, `DTB4WK`, `DTB3`, `DTB6`, `DTB1YR`, `SOFR` to a `volSeries`/`rateSeries` map beside `macroSeries` in `main.js`. Rust change: allow `observation_start` (or a higher `limit`) for the vol page's long history. `rates.js` builds a piecewise-linear zero curve from T-bill yields, converted from bank discount or bond-equivalent yields to continuous compounding. The conversion convention is documented and tested.

### 4.6 Realized vol

Pure JS `realized.js` on `asset.bars` (OHLC already in the workspace). A split filter uses `prepareBars` warnings as a first cut and a corporate-actions source later. The existing gs-quant `volatility()` stays as is in RSK. VOL uses `realized.js` so that the estimator is explicit and consistent with IV conventions (log returns, 252).

## 5. Portfolio and paper trading integration

| Change | File | Detail |
|---|---|---|
| Instrument model | `ledger.rs`, `engine.js` | `Trade.instrument`; validation per kind; option ids validated against the OCC pattern instead of the 20-char regex |
| Multiplier-aware cash | `book()`, `ledger.rs` | cash −= qty·price·multiplier + fee |
| Defined-risk shorts (Phase 4) | `ledger.rs` | Allowed if covered (enough shares per call), cash-secured (cash ≥ strike × multiplier per put), or part of a spread order whose max loss is reserved. Naked shorts are rejected with an explanation. A margin model is a separate decision |
| Multi-leg orders | new `Order { legs[] }` | Atomic validation; one id; fees per leg |
| Expiry processing | new pure fn `settleExpiries(account, closes, date)` | ITM by > $0.01 → exercise or assignment (physical → shares at strike; cash → difference). OTM → expire worthless. Recorded as synthetic trades with `source: "expiry"` so the ledger stays chronological and replayable |
| Marks | `portfolio()` | Option mark = recorded snapshot mid if fresh, else **model price flagged "model mark"**, never a silent last trade |
| Fills | Trade ticket | Default fill at the delayed/indicative **bid for sells and ask for buys** plus user slippage, timestamped with the quote time. Indicative quotes get a stronger warning |
| Equity curve | `equityCurve()` | Needs historical option marks → recorded snapshots, otherwise model marks with the IV assumption shown. Both are flagged |

## 6. Quant Lab integration

Quant Lab's guarantees (hashed snapshots, write-once records, sealed holdout, look-ahead-safe fills) apply unchanged. New experiment *types* rather than new engines:

- **Vol-selling study:** monthly short ATM straddle or 25Δ strangle on SPY, priced from **recorded or backfilled** chains, fills at bid/ask, the user-set commission, expiry or early close rules. Reports a P&L distribution and its relation to VRP at entry. Needs history; until then the UI says how many days exist.
- **Event study:** per-symbol panel of implied vs realized moves (§Feasibility 4.6) with snapshot hashes for each event.
- **Hedging study:** delta-hedge simulator runs (§7) saved as runs with a seed.

`lab.rs` `KINDS` gets `"vol_study"` and `"event_study"`. Bodies remain JSON, so nothing changes in Rust except the allow-list.

## 7. Hedging simulator (`hedge.js`)

Inputs: option position(s), a path source (historical bars from date d, or bootstrap/GBM/jump paths), an IV path (recorded, constant, or RV-linked), rebalance rule (every n days / |Δ| band / both), costs (per-share fee, half-spread bps, option fees), rate curve.
Per step: reprice, compute Δ, trade shares if the rule fires, accrue financing on cash and shares.
Outputs: P&L path, terminal P&L distribution (MC), Σ costs, number of rebalances, tracking error vs the perfect-hedge theoretical value, and a decomposition of the hedged P&L into ½Γ(dS)² − θdt (gamma-theta) + vega·dσ + costs + residual.
Runs in `options/worker.js`. Deterministic seed (as `quant.py`: crc32 of the inputs).

## 8. Testing strategy

| Layer | Tests |
|---|---|
| `src/options/*.js` | `tests/options.*.test.js`: reference values (Hull, Haug), parity and Greek identities, PDE residual, finite-difference vs analytic, solver edge cases (deep ITM/OTM, T→0, σ bounds, below-intrinsic → null), binomial convergence, forward from parity with dividends, rate-curve conversions |
| Python oracle | `scripts/options-oracle.cjs` runs `vol.py --oracle` on 10,000 random inputs and compares with JS to 1e-9. Runs in CI after `bundle-python.cjs` |
| `options.rs` | Normalization of recorded Alpaca/Massive fixture JSON (`tests/fixtures/options/*.json`), OCC parse round-trip, write-once snapshot refusal (as `lab.rs` tests) |
| `providers.rs` | `validate`/`request` for the new kinds, key masking; live contract test marked `#[ignore]` like `live_demo_keys` |
| Ledger | Multiplier cash, covered/secured short validation, expiry settlement, migration from schema 2 |
| E2E | `scripts/smoke.cjs` opens OMON/VOL/OSA in demo mode with a deterministic synthetic chain from `sample.js` (labelled synthetic, as demo prices are today) |

## 9. Demo data

`src/sample.js` gains a deterministic synthetic chain generator (SVI smile + term structure + noise) for demo mode, so the browser preview and smoke tests work without keys. It is **always** badged "Demo data · synthetic", exactly as today's demo prices are. The generator never runs in Live data mode.

## 10. Extensibility

- New exchange: a provider adapter in `providers.rs` + a normalizer in `options.rs` producing `OptionQuote`. `contract.style/settlement/expiryTime` carry the market rules; no market-specific branches in the math.
- New instrument (options on futures, VIX options): `underlyingKind: "future"` plus a futures price source; Black-76 already covers the pricing.
- Real-time later: a websocket adapter like `quotes.rs` that writes into the same in-memory book shape. Analytics don't change.

## 11. Relevant existing files

| File | Role in this plan |
|---|---|
| `src-tauri/src/providers.rs` | Add Alpaca option kinds, optional Massive provider, FRED history params, budgets |
| `src-tauri/src/main.rs` | New commands; open `options.sqlite` next to `reference.sqlite` (`open_reference` pattern) |
| `src-tauri/src/lab.rs` | Write-once pattern to copy; new Quant Lab kinds |
| `src-tauri/src/quant.rs`, `quant.py` | Pattern for `vol.py` (fixed script, `-I -B`, stdin JSON, batch) |
| `src-tauri/src/ledger.rs`, `src/engine.js` | Instrument model, multiplier, expiry, shorts |
| `src/bridge.js` | New invoke wrappers |
| `src/stock.js` | `VIEWS` gets `OMON`, `VOL`, `OSA`, `EVT`, `GEX` |
| `src/riskcharts.js` | `ticks`, `wrap`, `hover`, `lineChart` reused for smile/term/GEX/payoff |
| `src/pricechart.js` | Overlay realized/implied vol pane and event markers on GP |
| `src/quant.js` | `fredRate` superseded by `options/rates.js` |
| `src/quantlab/*` | Snapshot hashing, manifests, worker pattern |
| `src/main.js` `analystFacts()` | Add vol facts (ATM IV, IV rank with n days, implied move, next earnings) with source ids |
| `src/sample.js` | Synthetic demo chain |

## 12. Explicitly not proposed

- A separate service, message queue or database server.
- Moving the existing analytics to Rust or Python.
- Real-time OPRA streaming, order routing, or any real-money execution.
- Scraping undocumented endpoints (NSE option-chain API, Cboe CDN quotes JSON).
