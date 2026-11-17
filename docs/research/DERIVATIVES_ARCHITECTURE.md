# Derivatives Analytics — Proposed Architecture

Status: proposal, not implemented. Written 2026-11-17 against `main` at `096acef`. Revised the same day for the recorded decisions: $0 data budget, background agent as the primary recorder, Rust as the single maths implementation, India deferred, naked shorts as a stretch goal, and the compliance rules in [Feasibility §10](DERIVATIVES_FEASIBILITY.md#10-staying-out-of-trouble-binding-rules).
Read [Feasibility](DERIVATIVES_FEASIBILITY.md) first for data sources and model choices.

## 1. Principles

1. **Keep the stack.** Tauri 2 + Rust + SQLite + vanilla JS + Lightweight Charts + SVG builders + the bundled Python. No server, queue or database server. The one new process is a small scheduled agent built from the same Rust code.
2. **One maths implementation, in Rust.** Pricing, IV, Greeks, realized vol, summaries, scenarios and hedging simulations live in one dependency-free Rust crate, used three ways:
   - **natively by the background agent**, which runs with no window and therefore no JavaScript engine (this is the deciding reason);
   - **natively by Tauri commands** for batch work: whole chains, history, Monte Carlo;
   - **in the interface as WebAssembly** for instant slider-driven work (payoff, scenario grid) and for the browser preview and Playwright smoke tests, which run without Tauri today (`scripts/smoke.cjs`).
   
   Measured speed (Feasibility §6.3): Rust is 1.5–2× faster than JS. That is useful, but it isn't the reason for the choice.
3. **Python is an oracle and a fitter, not a second pricer.** `vol.py` reimplements the core formulas only to test the Rust crate, and it runs the SVI fit (scipy), which has no Rust counterpart worth writing.
4. **Ingestion and calculation are separate.** Provider adapters only fetch and normalize. Calculation never makes network calls.
5. **Provider-independent contracts.** Every chain source normalizes to one `OptionQuote` schema.
6. **Large data stays out of the workspace blob.** Chains and history go to a new `options.sqlite`, as 13F data went to `reference.sqlite`.
7. **Every number carries its class** (observed / derived / model / simulation) and its provenance.
8. **The compliance rules are design constraints** (Feasibility §10): read-only market data, local budgets shared between app and agent, no real data in the repo, and a visible, removable agent.

## 2. Crates and processes

```
crates/options-math/          NEW  pure Rust, no dependencies (std only; serde behind a feature)
  src/bsm.rs  black76.rs  american.rs (Leisen–Reimer, CRR, discrete dividends)
  src/iv.rs (Newton + Brent, no-solution flags)   forward.rs (put–call parity forward)
  src/rates.rs (bill yield → continuous zero curve)   realized.rs (C2C, Parkinson, GK, RS, Yang–Zhang, cone)
  src/surface.rs (constant-maturity ATM IV, 25Δ RR/BF, term)   events.rs (implied move, event variance, attribution)
  src/exposure.rs (GEX under named conventions)   portfolio.rs (position/book Greeks, β-weighting, scenario grid)
  src/hedge.rs (delta-hedge simulator, seeded RNG)   margin.rs (stretch: strategy-based margin)
  src/quality.rs (quote sanity, parity residual, monotonic/convex/calendar checks)

crates/options-wasm/          NEW  thin wasm-bindgen wrapper → src/options/pkg/ (imported by Vite)

src-tauri/                    EXISTING crate, gains:
  src/options.rs              provider JSON → OptionQuote, OCC symbol parse, snapshot hashing, options.sqlite access
  src/agent.rs                the recorder's job logic (pure parts unit-tested like ledger.rs)
  src/bin/aperture-agent.rs   NEW headless binary: no Tauri, no webview
  src/main.rs                 + commands: options_chain, options_history, options_eval, agent_install/remove/status
```

Cargo becomes a small workspace (`src-tauri`, `crates/options-math`, `crates/options-wasm`). `src-tauri` depends on `options-math` by path. The existing `cargo test --no-default-features --lib` gate keeps working, and `options-math` adds its own `cargo test`.

**Why a separate maths crate:** the `src-tauri` library pulls in rusqlite (bundled C), reqwest and tokio, which cannot compile to `wasm32-unknown-unknown`. A dependency-free crate compiles to native and to WebAssembly unchanged.

**WebAssembly build cost** (the one new toolchain step): `rustup target add wasm32-unknown-unknown` plus `wasm-bindgen-cli` pinned to the crate's version. A `scripts/build-wasm.cjs` step runs before `vite build`, and CI caches it. Only aarch64/x86_64 Apple targets are installed locally today. **Fallback** if WebAssembly proves to be friction: the interface calls `options_eval` over Tauri IPC (a 600-point payoff evaluates in ~30 µs, so the IPC round trip dominates at about a millisecond), and the browser preview shows a precomputed demo. That is acceptable, but it loses E2E coverage of the strategy lab.

## 3. Background agent (primary recorder)

### 3.1 Shape

- **A separate headless binary** `aperture-agent`, shipped inside the app bundle as a Tauri sidecar (`bundle.externalBin`, target-triple naming). It links `options-math`, `providers.rs`, `options.rs`, rusqlite and reqwest. It has no webview and no window.
- **It is not a resident daemon.** The OS starts it every 30 minutes. It checks whether any work is due, does it, and exits. Most runs end within milliseconds.
- **Scheduling, per user, with no admin rights:**

| OS | Mechanism | Notes |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.aperture.agent.plist`, `StartInterval 1800`, `RunAtLoad false` | macOS 13+ shows a "Background Items Added" notice and lists the agent under Login Items. Whether launchd can start an **unsigned** sidecar inside a quarantined bundle must be tested on real hardware (*unverified*); the current builds are unsigned and not notarized |
| Windows | Task Scheduler per-user task: `schtasks /Create /SC MINUTE /MO 30 /TN Aperture\Agent` | Runs only while the user is logged on, so no stored password is needed |
| Linux | `systemd --user` timer (`OnCalendar=*:0/30`); fallback: XDG autostart, which only works while logged in | |

- **Install and remove** come from Settings ("Record option chains in the background"), with an explicit description of what it does, when it runs and which providers it calls. Status shows the last run, next run, result and a link to the log file in the app-data folder.
- **Uninstall cleanup:** the Homebrew cask (`Casks/aperture-preview.rb`) gains `uninstall launchctl: "com.aperture.agent"` and a `zap` entry for the plist. The Scoop manifest (`bucket/aperture-preview.json`) gains a `pre_uninstall` step that deletes the scheduled task. The app also removes the agent when it detects it is being replaced by a build without one.

### 3.2 Due work (decided on each wake-up)

| Job | When due | Provider calls |
|---|---|---|
| **EOD chain capture** for the recorder list (default: watchlist, ≤ 30 symbols) | Trading day, between 16:15 and 23:59 ET, not yet captured today | Alpaca option snapshots + contracts (OI), paginated |
| Summaries (ATM IV by constant maturity, RR/BF, term, GEX by convention) | After each capture | None (Rust maths) |
| SVI fits | After capture, batched | None (bundled Python `vol.py`, one start) |
| FRED vol and rate series | Every 12 h (as the app does today) | FRED |
| **Massive backfill** (tiers 0–4, Feasibility §3.1a) | Until done, then gap-filling for missed recorder days and a weekly corporate-actions refresh | Massive free tier (one account), ≥ 13 s between calls, shared across Options and Stocks endpoints; resumable queue in `options.sqlite` |
| Retention pruning | Weekly | None |

- **Trading calendar:** a bundled NYSE holiday list (maintained yearly, sourced) cross-checked against Alpaca's market calendar endpoint. That endpoint is part of Alpaca's trading API, read-only (*endpoint not verified this session*).
- **Capture validity:** a capture taken after 23:59 ET, or after the next session opens, is **not** recorded as that day's close. The day becomes a gap. A sleeping laptop therefore produces gaps, never mislabeled data.
- **Concurrency with the open app:** SQLite WAL with `busy_timeout`; a lock file so only one agent runs; the app and agent share the `requests` table, so free-plan budgets are counted once (Feasibility §10, rule 2).
- **Credentials:** read from the same owner-only `credentials.json`. Environment variable overrides don't exist under launchd or Task Scheduler; the docs say so.
- **Failure behaviour:** provider errors are logged, the day stays a gap, and backoff follows the provider's rules. A rejected key stops the job until the user fixes it, as AISStream handling does today.

### 3.3 In-app fallback

If the agent isn't installed, the same job runs inside the desktop app while it is open (the `watchFresh` loop). Captures are flagged `captured_by: "app"` or `"agent"`.

## 4. Data model

### 4.1 Normalized contract and quote

```rust
// OptionContract: static per contract
struct OptionContract {
    id: String,            // "O:" + OCC symbol without padding, e.g. "O:AAPL261218C00250000"
    underlying: String,    // workspace symbol
    root: String,          // OCC root (differs after adjustments, e.g. "AAPL1")
    kind: Call | Put,
    strike: f64,
    expiry: Date,
    expiry_time: ExpiryTime,  // PM close 16:00 ET | AM-settled | market-specific
    style: American | European,
    settlement: Physical | Cash,
    multiplier: f64,       // cash multiplier
    deliverable: f64,      // shares on exercise; ≠ multiplier → adjusted
    adjusted: bool,
    currency: String,
}
// OptionQuote: one observation
struct OptionQuote {
    contract_id: String, provider: String, feed: Indicative | Opra | Eod | Import,
    quote_time: i64, retrieved_at: i64,
    bid, ask, bid_size, ask_size, last, last_time, volume: Option<f64>,
    open_interest: Option<f64>, oi_date: Option<Date>,
    vendor: Option<VendorGreeks>,       // kept only for cross-checks, never mixed with ours
    underlying_price: f64, underlying_time: i64,
    flags: Vec<Flag>,                   // Indicative, WideSpread, StaleQuote, BelowIntrinsic, …
}
```

Our IV and Greeks are a separate derived record keyed by (contract, quote_time, model_version).

### 4.2 `options.sqlite` (new, in the app-data folder)

```sql
CREATE TABLE contracts(id TEXT PRIMARY KEY, underlying TEXT, root TEXT, type TEXT, strike REAL,
  expiry TEXT, style TEXT, settlement TEXT, multiplier REAL, deliverable REAL, adjusted INTEGER,
  currency TEXT, first_seen INTEGER, last_seen INTEGER);
CREATE INDEX contracts_u ON contracts(underlying, expiry, strike);

CREATE TABLE snapshots(id TEXT PRIMARY KEY,             -- "snap_" + sha256(content)[:20], write-once
  underlying TEXT, provider TEXT, feed TEXT, taken_at INTEGER, underlying_price REAL,
  underlying_time INTEGER, rate_curve TEXT, model_version TEXT, content_sha256 TEXT,
  kind TEXT,                                            -- eod | manual | backfill | import
  captured_by TEXT);                                    -- agent | app
CREATE INDEX snapshots_u ON snapshots(underlying, taken_at);

CREATE TABLE quotes(snapshot TEXT, contract TEXT, bid REAL, ask REAL, last REAL, volume REAL,
  oi REAL, oi_date TEXT, quote_time INTEGER, v_iv REAL, v_delta REAL, v_gamma REAL,
  iv REAL, delta REAL, gamma REAL, theta REAL, vega REAL, rho REAL, flags TEXT,
  PRIMARY KEY(snapshot, contract)) WITHOUT ROWID;

CREATE TABLE daily_summary(underlying TEXT, date TEXT, source_snapshot TEXT,
  atm_iv_30 REAL, atm_iv_60 REAL, atm_iv_90 REAL, rr25_30 REAL, bf25_30 REAL,
  term TEXT, svi TEXT, gex TEXT, quality TEXT,          -- JSON
  PRIMARY KEY(underlying, date)) WITHOUT ROWID;

CREATE TABLE events(id TEXT PRIMARY KEY, underlying TEXT, kind TEXT,  -- earnings|fomc|cpi|dividend
  date TEXT, timing TEXT, source TEXT, source_url TEXT, recorded_at INTEGER);

CREATE TABLE agent_runs(started INTEGER PRIMARY KEY, finished INTEGER, job TEXT, result TEXT, detail TEXT);
```

Retention: `quotes` pruned after N days (default 90; Settings → Reference data, like 13F quarters). `snapshots` and `daily_summary` are kept. Snapshots referenced by Quant Lab runs or saved event studies are never pruned. This uses the write-once idea of `lab.rs`.

**This database is personal data under provider licences** (Feasibility §10, rule 4). It lives only in the app-data folder. It is excluded from the JSON backup export, as API keys are today, and never synced, uploaded or committed.

### 4.3 Workspace additions (small, in the JSON blob)

- `account.trades[]` gains `instrument: { kind: "equity" | "option", contractId?, multiplier? }`. Migration: `SCHEMA` 2 → 3 in `engine.js migrate()`; old trades become `kind: "equity"`.
- `state.options = { recorder: [...underlyings], gexConvention: "compare" }`. Whether the agent is installed is read from the OS, not stored.

## 5. Pipelines

### 5.1 Chain fetch (on demand, in the app)

```
OMON opens AAPL
 └ bridge.optionsChain("AAPL")                           JS
    └ invoke options_chain                                Rust
       ├ providers::validate("alpaca", "option_snapshots", "AAPL")
       ├ cache "alpaca:option_snapshots:AAPL"  (15 min in market hours, 12 h closed)
       ├ budget + gap gate (fast_gate), shared `requests` log
       ├ paginate snapshots (limit 1000) + contracts (OI, multiplier, style)
       ├ options::normalize → Vec<OptionQuote>
       └ options_math: forward → iv → greeks → quality      (native, ~ms)
 └ view model → OMON table, smile, term charts (SVG builders from riskcharts.js)
```

### 5.2 Interactive maths (in the interface)

The strategy lab sliders and scenario grids call the WebAssembly build of `options-math` directly. There is no IPC and no round trip. The same function signatures exist natively, so a grid computed in the interface and one computed by `options_eval` are bit-identical by construction. A test asserts this on fixtures.

### 5.3 EOD capture (agent, or in-app fallback)

§3.2. Each capture writes one write-once snapshot, its quotes and a `daily_summary` row; missed days stay gaps.

### 5.4 Massive backfill (decided 2026-11-17)

```
Tier queue (breadth-first across symbols: all Tier 0, then all Tier 1, …)
 ├ T0  splits, dividends, adjusted daily bars, stock minute bars, contract lists (expired=true)
 ├ T1  monthly expiries × ~6 near-money strikes × call+put   → ATM IV 30/60/90, term, IV rank
 ├ T2  ~±10–15% OTM strikes                                  → skew history
 ├ T3  weekly expiries around each earnings date             → implied vs realized moves, crush
 └ T4  remaining traded strikes, idle time only
Per contract: one options minute-aggregates request for its life
  → keep, per day, the last minute bar in 15:30–16:00 ET + the underlying's bar in the same minute
  → Rust maths: parity forward (call+put pairs), IV, Greeks → snapshot kind "backfill"
  → daily_summary rows with quality.source = "backfill"
```

- **Queue table:** `backfill_queue(id, underlying, tier, request, status, attempts, done_at)`. Each request is a documented Massive URL plus parameters. Progress survives restarts and is shown in Settings.
- **Pacing:** one request at a time, ≥ 13 s apart, 429 → exponential backoff. The agent's wake-ups are 30 minutes apart, so a backfill run keeps working until shortly before the next wake-up. A lock file prevents overlap.
- **Before the agent exists (M1):** the same queue runs as an in-app background job, like the 13F download in `main.rs` (`holdings_update` with job status).
- **Storage:** raw minute bars are reduced to the per-day closing-window pair at once and then discarded. Only that pair, the corporate actions, the adjusted daily bars and the derived rows are kept. That is a few MB per symbol rather than hundreds.
- **Source tagging and purge:** every row has `source` (`alpaca` | `massive` | `fred` | …). `options_purge(source)` deletes all rows from one source, including derived IVs and summaries, and is exposed in Settings (Feasibility §10, rule 11).
- **Gap filler:** after the recorder misses a day, enqueue T1 requests for currently listed expiries only, for that week.

### 5.5 Volatility indices and rates

Existing `fetch_data("fred", "observations", id)` with `VIXCLS`, `VXVCLS`, `DTB4WK`, `DTB3`, `DTB6`, `DTB1YR`, `SOFR`. Rust change: allow `observation_start` (or a higher `limit`) for long history. `options_math::rates` converts bill yields to continuous zero rates; the convention is documented and tested.

### 5.6 Realized vol

`options_math::realized` on the workspace OHLC bars, through WebAssembly in the interface and natively in the agent for summaries. A split filter starts from `prepareBars` gap warnings and moves to Massive Basic corporate actions if the user enables that account.

## 6. Paper trading and portfolio

| Change | Where | Detail |
|---|---|---|
| Instrument model | `ledger.rs`, `engine.js` | `Trade.instrument`; option ids validated against the OCC pattern, replacing the 20-character regex for options |
| Multiplier-aware cash | `book()`, `ledger.rs` | cash −= qty·price·multiplier + fee |
| **Defined-risk shorts (planned)** | `ledger.rs` | Allowed when **covered** (shares ≥ 100 × short calls), **cash-secured** (cash ≥ strike × multiplier per short put, reserved), or **inside a spread** submitted as one order whose maximum loss is reserved. Anything else is refused with the reason |
| Multi-leg orders | `Order { legs[] }` | Validated atomically; one id; fees per leg |
| Expiry processing | `settle_expiries(account, closes, date)` | ITM by > $0.01: exercise/assignment (physical → shares at strike, cash → difference); OTM expires. Recorded as `source: "expiry"` trades, keeping the ledger chronological and replayable |
| Marks | `portfolio()` | Recorded snapshot mid when fresh; otherwise a **model mark** flagged as such |
| Fills | Options ticket | Default: delayed/indicative **ask for buys, bid for sells**, plus user slippage and per-contract fee, stamped with the quote time |
| **Stretch: naked shorts with a margin model** | `options_math::margin`, `ledger.rs` | Strategy-based, Reg T-style paper margin. Standard published formula for a short equity option: 100% of premium + max(20% of underlying − out-of-the-money amount, 10% of underlying for calls / 10% of strike for puts) × multiplier; broad-based index options use 15% / 10%. *Percentages from the standard Cboe/FINRA formula: verify against the current Cboe Margin Manual before implementing.* Recomputed daily from marks. A deficit raises a paper **margin call**; if it isn't cured by the next session, the position is closed at the ask plus slippage, and that is recorded. Labelled "Simulated margin. Brokers set higher house requirements." Paper only |
| Equity curve | `equityCurve()` | Recorded marks where captured, model marks otherwise (flagged) |

Rust remains the validation boundary, as today. The JS ledger counterpart used by the browser preview calls the same WebAssembly maths for marks and margin.

## 7. Quant Lab integration

Quant Lab's guarantees (hashed snapshots, write-once records, sealed holdout, look-ahead-safe fills) apply unchanged. New experiment types, not new engines:

- **Vol-selling study:** short ATM straddle or 25Δ strangle on recorded or backfilled chains, bid/ask fills, fees, exit rules; P&L distribution vs VRP at entry.
- **Event study:** implied vs realized moves with the snapshot hash of each event.
- **Hedging study:** simulator runs with a seed.

`lab.rs` `KINDS` gains `"vol_study"` and `"event_study"`.

## 8. Hedging simulator (`options_math::hedge`)

Inputs: option position(s); a path source (historical bars from a date, bootstrap like `quant.py`, GBM, jump-diffusion); an IV path (recorded, constant, or RV-linked); a rebalance rule (every n days, |Δ| band, or both); costs (per-share fee, half-spread bps, option fees); the rate curve.
Outputs: P&L path, terminal distribution, Σ costs, rebalance count, tracking error, and a decomposition into ½Γ(dS)² − θdt + vega·dσ + costs + residual. Seeded deterministically. Runs natively through `options_eval` for 10k-path Monte Carlo, or in WebAssembly for single paths.

## 9. Testing

| Layer | Tests |
|---|---|
| `options-math` | `cargo test`: Hull/Haug reference values; parity and Greek identities; BSM PDE residual; finite difference vs analytic; solver edge cases (deep ITM/OTM, T→0, σ bounds, below-intrinsic → none); binomial convergence; parity forward with dividends; rate conversions; margin formula cases (stretch) |
| Python oracle | `vol.py --oracle` compares 10,000 random inputs with the Rust results to 1e-9; runs in CI after `bundle-python.cjs` |
| WebAssembly parity | `node --test` loads the WebAssembly package and checks bit-identical outputs against native fixtures |
| `options.rs` | Normalization of **synthetic** fixtures shaped like Alpaca/Massive responses (no real vendor data in the repo, Feasibility §10, rule 4); OCC round-trip; write-once refusal |
| `agent.rs` | Due-work logic: trading day, capture window, gap on late wake, lock file, budget sharing; pure functions with injected clock |
| `providers.rs` | `validate`/`request` for new kinds and key masking; live contract test `#[ignore]` like `live_demo_keys` |
| Ledger | Multiplier cash, covered/secured/spread validation, expiry settlement, schema-2 migration; margin calls (stretch) |
| E2E | `scripts/smoke.cjs` opens VOL/OSA/OMON in demo mode with a deterministic synthetic chain from `sample.js` |

## 10. Demo data

`src/sample.js` gains a seeded synthetic chain (SVI smile + term structure + noise) for demo mode and tests. It is always badged "Demo data · synthetic", and site screenshots use only this.

## 11. Relevant existing files

| File | Role |
|---|---|
| `src-tauri/src/providers.rs` | Alpaca option kinds; **Massive provider** (`massive`: contracts reference, options/stocks minute and daily aggregates, splits, dividends) with a 13 s gap and a shared budget; FRED history params |
| `src-tauri/src/main.rs` | New commands; open `options.sqlite` like `open_reference` |
| `src-tauri/src/lib.rs` | Export `options`, `agent` modules for the agent binary and tests |
| `src-tauri/Cargo.toml` | Workspace membership; `[[bin]] aperture-agent` without the `desktop` feature |
| `src-tauri/tauri.conf.json` | `bundle.externalBin` for the agent sidecar |
| `Casks/aperture-preview.rb`, `bucket/aperture-preview.json` | Agent removal on uninstall |
| `src-tauri/src/lab.rs` | Write-once pattern; new Quant Lab kinds |
| `src-tauri/src/quant.rs`, `quant.py` | Pattern for `vol.py` |
| `src-tauri/src/ledger.rs`, `src/engine.js` | Instrument model, multiplier, expiry, shorts, margin (stretch) |
| `src/bridge.js` | Invoke wrappers; WebAssembly loader |
| `src/stock.js` | `VIEWS` gains `VOL`, `OMON`, `OSA`, `EVT`, `GEX` |
| `src/riskcharts.js` | `ticks`, `wrap`, `hover`, `lineChart` for the new charts |
| `src/main.js` `analystFacts()` | Vol facts with source ids and class labels |
| `src/sample.js` | Synthetic demo chain |

## 12. Explicitly not proposed

- A resident daemon, a server, or a cloud service.
- Rewriting existing JS analytics (`engine.js`, Quant Lab) in Rust. Only the new options maths is Rust.
- Real-time OPRA streaming, order routing, or any real-money execution.
- Paid data, scraping, undocumented endpoints, or a second Massive account or key (Feasibility §10).
- Indian markets, until that work is resumed.
