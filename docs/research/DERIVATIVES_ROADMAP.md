# Derivatives Analytics — Roadmap

Status: proposal for review. Nothing here is implemented. Written 2026-11-17, revised the same day with the decisions below.
Efforts assume one developer in the existing codebase: **Low** ≈ ≤ 3 days, **Medium** ≈ 1–2 weeks, **High** ≈ 3+ weeks.

## 0. Decisions (2026-11-17)

| # | Decision |
|---|---|
| 1 | **Data budget $0.** No paid feeds. Free sources: Alpaca's indicative options feed (existing key), FRED, existing providers, and **one free Massive account** (Options Basic + Stocks Basic), used to backfill as much history as possible (Feasibility §3.1a) |
| 2 | **India deferred.** Nothing Indian is scheduled |
| 3 | **Covered and spread-only shorts** are planned. **Naked shorts with a margin model are a stretch goal** |
| 4 | **A background agent is the primary recorder.** It runs headless on an OS schedule; the in-app recorder is the fallback |
| 5 | **Rust is the single maths implementation.** Measured 1.5–2× faster than JS (Feasibility §6.3). The deciding reason is that the headless agent has no JS engine. It compiles to WebAssembly for the interface |
| 6 | **Nothing that could cause trouble.** The binding rules are in [Feasibility §10](DERIVATIVES_FEASIBILITY.md#10-staying-out-of-trouble-binding-rules) |

## 1. How the plan differs from the original phase hypothesis

| Original phase | Now | Reason |
|---|---|---|
| Phase 1 foundational analytics | Kept, defined as **work that needs no new provider**: the Rust maths crate, realized vol, VIX and rates from FRED, a theoretical strategy lab | FRED already carries VIX, VIX3M and T-bills; Twelve Data bars are OHLC |
| Phase 2 options research | Kept, and it **ships the background agent** so history starts accruing | No free source has historical IV. Every unrecorded day is lost |
| Phase 3 advanced vol / Phase 4 portfolio | **Swapped** | Advanced vol waits on months of recorded history. Portfolio and options paper trading only need Phase 2 |
| Hedging in Phase 4 | Simulator moves to Phase 3 | It needs only underlying paths and the pricer |
| GEX in Phase 5 | Kept | Weakest assumptions; needs mature quality checks and OI history |
| India | Deferred | Decision 2 |

**Time-gated, now mostly solved by the backfill:** single-name IV rank needs 252 trading days. The Massive backfill supplies about 2 years of approximate (trade-print-based) history within days of starting, so IV rank, skew history and earnings implied-move history become usable **in M2** rather than a year later. Recorded quote-based history then takes over going forward. Massive's free window covers only the last 2 years and moves forward daily, so **the backfill starts in M1.** VIX IV rank is available at M1 from FRED.

## 2. Phases and features

### Phase 1: Foundations (no new providers)

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| `crates/options-math` (Rust) + test suite + Python oracle | Correct, reproducible prices, IV and Greeks for everything else | New workspace crate; `src-tauri` depends on it; `quant.py` pattern for the oracle | None | — | BSM with q, Black-76, Leisen–Reimer binomial with discrete dividends, Newton+Brent IV, analytic Greeks incl. 2nd order | **Medium** | None | High once verified (Hull/Haug, identities, oracle) | **P0** |
| WebAssembly build of the maths crate | Instant sliders; browser preview and E2E tests keep working without Tauri | `crates/options-wasm` → `src/options/pkg`; `scripts/build-wasm.cjs` before `vite build`; CI target | — | — | — | **Low–Medium** | Maths crate | High (bit-identical test vs native) | **P0** |
| Rate curve from FRED | Term-matched r per expiry | `fetchData("fred", …)` | `DTB4WK`, `DTB3`, `DTB6`, `DTB1YR`, `SOFR` | **Existing** | Bill yield → continuous zero, linear interpolation | **Low** | Maths crate | High | **P0** |
| Realized vol + split filter | Correct RV conventions; basis for VRP | Workspace OHLC bars; `prepareBars` gap warnings | Daily OHLC | **Existing** | C2C (log), Parkinson, GK, RS, **Yang–Zhang**; cone | **Low** | Maths crate | High, except across unadjusted splits (flagged) | **P0** |
| Volatility page (Markets): VIX, VIX3M, term ratio, VIX IV rank/percentile, VIX vs SPY RV, VRP, regimes | Market-level vol context; first VRP research | New sidebar page; `riskcharts.js` builders | `VIXCLS`, `VXVCLS`; SPY bars | **Existing**; FRED `observation_start` for > 2 years | VRP = VIX(t) − RV(t→t+21), shown only once known | **Low–Medium** | Realized vol; FRED param | High; regime labels are stated definitions | **P0** |
| VOL view, realized half | Vol profile of any workspace stock | `VIEWS` in `stock.js`; grid tile | OHLC | **Existing** | Cone, RV history, estimator switch | **Low** | Realized vol | High | **P1** |
| OSA, theoretical mode | Payoffs, Greeks curves, scenario grid with model prices; the main learning tool | New stock view | Spot, user IV or RV, rates | **Existing** | Full revaluation; sticky strike vs sticky moneyness | **Medium** | WebAssembly | High as a model; labelled "Model price" | **P1** |
| Synthetic demo chain | Demo mode and E2E without keys | `sample.js`, `scripts/smoke.cjs` | — | — | Seeded SVI smile + term + noise | **Low** | Maths crate | n/a (badged synthetic) | **P1** |
| **Massive provider + backfill downloader** (in-app background job; tiers 0–3; resumable queue; purge by source) | Start capturing the rolling 2-year window now; split-adjusted bars and corporate actions for correct RV | `providers.rs` new `massive` provider; 13F-style job in `main.rs`; Settings key row + progress | Contract lists, option and stock minute aggregates, adjusted daily bars, splits, dividends | **Free** (one account, 5/min, individual use) | Raw storage only in M1; IV computed when `options.rs` lands in M2 | **Medium** | `options.sqlite` schema (pulled forward from M2) | High as raw data; IV from trade prints is approximate (flagged) | **P0** |

**M1 exit criteria:** the maths crate passes reference, identity, oracle and WebAssembly-parity tests in CI. The Volatility page shows VIX/VIX3M with "Cboe, retrieved from FRED" attribution and a VRP chart that never uses future data at a past date. OSA prices a vertical spread and a collar with a scenario grid. The demo chain renders in browser preview.

### Phase 2: Options research and the background agent

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| Alpaca options adapter (`option_snapshots`, `option_contracts`), read-only | Real chains at $0 | `providers.rs` kinds + budget; existing Alpaca key/secret; `fast_gate` | Chain snapshot, contract reference (OI, multiplier, style) | **Free** (indicative quotes; trades 15-min delayed) | — | **Medium** | None | Medium: indicative ≠ OPRA | **P0** |
| `options.rs` normalizer + `options.sqlite` | Provider-independent schema; storage outside the workspace | `open_reference` pattern; `lab.rs` write-once | — | — | OCC parse; content hash | **Medium** | Adapter | High | **P0** |
| Quality checks (`options_math::quality`) | Bad quotes made visible before they turn into bad analytics | Every view shows used/excluded counts | Quotes + times | — | Spread, age, intrinsic, parity residual, monotonic/convex checks | **Low–Medium** | Normalizer | High | **P0** |
| OMON chain view | Contract research: IV, Greeks, liquidity, moneyness, compare | New stock view + tile | Chain | Free | Our IV on the parity forward; vendor IV as a cross-check | **Medium** | Adapter, maths, quality | Medium–High for liquid names | **P0** |
| **Background agent `aperture-agent`** (launchd / Task Scheduler / systemd user timer), opt-in from Settings, removed on uninstall | **Starts the history clock** without needing the app open | Tauri sidecar; shares `options.sqlite`, `requests` budget log and `credentials.json`; Homebrew cask and Scoop uninstall hooks | Recorder list (watchlist, ≤ 30) at 16:15–23:59 ET on trading days | Free | Same maths natively; summaries; SVI via `vol.py` | **High** | Adapter, normalizer, maths | High for captured days; gaps stay gaps. **Risk:** an unsigned macOS sidecar under launchd must be tested on hardware | **P0** |
| In-app recorder fallback | Recording without the agent | `watchFresh` loop | Same | Free | Same | **Low** | Agent job logic (shared) | Same | **P1** |
| VOL implied half: smile, term, IV vs RV | Core equity-vol facts | VOL view | Chain + OHLC | Free | Display smile; forward variance | **Medium** | Recorder | Medium–High | **P1** |
| OSA market mode | Strategies on real mids with optional spread cost | OSA | Chain | Free | Same | **Low** | OMON | Medium (indicative) | **P1** |
| Backfill → IV history: parity forward + IV on time-matched closing-window prints; `daily_summary` backfill rows; the queue moves into the agent; gap filler | 2 years of ATM IV, term, skew and earnings implied moves, available in M2 | Agent; VOL/EVT charts draw backfill dashed | Downloaded M1 data | **Free** (Massive) | Rust maths on minute-matched pairs | **Medium** | M1 downloader, normalizer, maths | Medium (trade prints, no bid/ask; flagged) | **P0** |

**M2 exit criteria:**
- OMON loads AAPL and SPY with our IV; every excluded contract shows a reason; vendor IV disagreements are viewable.
- The agent installs and uninstalls cleanly on macOS, Windows and Linux.
- The agent captures one write-once snapshot and summary per recorder symbol per trading day, and never labels a late capture as that day's close.
- The app and agent share one request budget.
- Uninstalling through Homebrew or Scoop removes the schedule.

### Phase 3: Options paper trading, portfolio risk and hedging

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| Ledger instrument model, multiplier, expiry settlement (long options) | Paper-trade options correctly | `ledger.rs`, `engine.js`, `migrate()` → schema 3 | Contract reference | Free | Cash with multiplier; ITM settlement | **Medium–High** | Phase 2 | High | **P0** |
| Options ticket + multi-leg orders | Execute OSA strategies on paper | Trade page | Quotes with times | Free | Bid/ask fills + slippage + per-contract fees | **Medium** | Ledger | Medium (delayed/indicative fills) | **P1** |
| Covered calls, cash-secured puts, spreads | The common defined-risk structures | `ledger.rs` validation | — | — | Collateral reservation | **Medium** | Ledger | High | **P1** |
| Portfolio Greeks + β-weighted delta | Book exposure | Portfolio → Risk tab; RSK's gs-quant `beta1y` | Positions, chain | Free | Σ qty·m·Greek; β-weighting | **Low–Medium** | Ledger | Medium (β is a model) | **P0** |
| Full-revaluation scenario grid + crash presets | Replaces the uniform shock; real stress tests | Portfolio stress panel | Positions; VIX history | Existing + Free | Spot × vol × horizon revaluation | **Medium** | Maths, ledger | Model-dependent, transparent | **P0** |
| Delta-hedge simulator | Hedging costs, rebalance trade-offs, jump risk | From OSA/Portfolio | Underlying bars | **Existing** | Discrete re-hedging; bootstrap/GBM/jump paths; gamma–theta decomposition | **Medium** | Maths | High as a simulation (labelled) | **P1** |
| Protective put / collar / put spread comparison | Tail-hedge cost vs protection | Portfolio hedge ideas | Chain | Free | Scenario rows | **Low** | Grid | Medium | **P1** |
| Option marks in the equity curve | Honest paper equity history | `equityCurve()` | Recorded snapshots | Free | Recorded mid, otherwise flagged model mark | **Medium** | Recorder, ledger | Medium | **P2** |
| **Stretch: naked shorts + margin model** | Simulate short-premium strategies honestly, margin calls included | `options_math::margin`, `ledger.rs` | Marks | Free | Strategy-based Reg T-style formula (verify against the Cboe Margin Manual); daily recompute; margin call → next-session paper liquidation | **High** | Covered/spread shorts, marks | Medium; labelled "simulated margin, brokers require more" | **P3** |

**M3 exit criteria:**
- An option can be bought, sold and expired on paper with cash correct to the cent.
- A covered call and a put spread validate; a naked short is refused with a reason until the stretch goal ships.
- Book Greeks and the scenario grid match OSA for a single-position book.
- The simulator reproduces hedging error falling as √Δt on GBM paths.

### Phase 4: Advanced volatility (once 3–6+ months are recorded)

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| Single-name IV rank / percentile, IV history | IV relative to its own past | VOL, DES, workspace Screener columns, Alerts | ≥ 252 days of `daily_summary` | Free (time-gated) | rank / percentile | **Low** | Recorder history | High once n ≥ 252; n always shown | **P1** |
| EVT: implied move, event variance, implied vs realized, IV-crush attribution | Price event risk; test whether options over- or under-price events | EVT view; Finnhub/Alpha earnings dates; GP markers | Pre/post-event snapshots | Free (needs recorded events) | Straddle move; two-expiry event variance; sequential revaluation | **Medium** | Recorder | Medium; small samples flagged | **P1** |
| Vol-selling study in Quant Lab | Does selling vol pay after costs, here? | New Quant Lab experiment type | Recorded/backfilled chains | Free (time-gated) | Short straddle/strangle with bid/ask fills; sealed holdout | **High** | Ledger semantics, recorder | Medium; survivorship and sample labels | **P2** |
| SVI surface + arbitrage checks (`vol.py`) | Smooth, arbitrage-aware smiles; skew metrics; small multiples | Bundled scipy, batch pattern | Chains | Free | Raw SVI, vega-weighted least squares | **Medium–High** | Phase 2 | Medium (fit quality reported) | **P2** |
| Skew history (25Δ RR/BF) | Skew regimes | VOL | `daily_summary` | Free (time-gated) | — | **Low** | Recorder | Medium | **P2** |
| Macro event dates (FOMC, CPI) | Index event premia | Volatility page; EVT for SPY | Sourced static JSON + FRED release dates | Free | As EVT | **Low–Medium** | EVT | Medium | **P3** |
| Optional 3D surface | Visual intuition | VOL | SVI params | Free | — | **Low** | SVI | n/a | **P3** |

### Phase 5: Advanced derivatives research

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| GEX by strike, profile across spot, flip range under named conventions | Describe OI-implied gamma structure | GEX view; Analyst with "estimated" label | Chain + daily OI | Free | OI·Γ·m·S²·0.01 with assumed signs | **Medium** | Recorder, quality | **Low–Medium**; never presented as observed | **P2** |
| OI by strike and OI change | Observed positioning structure (sides unknown) | OMON / GEX | Daily OI | Free | — | **Low** | Recorder | High (observed) | **P2** |
| Second-order Greeks panel | Advanced sensitivity | OMON Advanced, OSA | Chain | Free | Closed form | **Low** | Maths | Medium (IV-error sensitive) | **P2** |
| GARCH(1,1) forecast vs IV | Model forecast vs market | VOL; `vol.py` | OHLC | Existing | MLE in scipy | **Low–Medium** | Realized vol | Medium | **P3** |
| India (broker adapter or manual imports) | NIFTY research | — | — | — | Black-76 vs future | — | — | — | **Deferred** |
| Paid feeds, real-time OPRA, intraday GEX, 0DTE | — | — | — | Paid | — | — | — | — | **Not planned ($0)** |

## 3. Dependency graph

```
options-math (Rust) ─┬─► WebAssembly ─► OSA theoretical, VOL realized, Volatility page
                     ├─► Hedging simulator
FRED rates/VIX ──────┤
                     └─► Alpaca adapter ─► normalizer ─► quality ─► OMON ─► OSA market ─► Ledger options ─► Portfolio Greeks / grid
                                              │                                             └─► (stretch) margin model
                                              └─► options.sqlite ─► background agent ══ time: 3–12 months ══► IV rank, EVT, skew history,
                                                                     (+ in-app fallback)                       vol-selling study, GEX
                                                                     └─► optional Massive Basic backfill
```

## 4. First three milestones

### M1: Rust maths core and vol foundations (≈ 4–5 weeks)
1. Cargo workspace; `crates/options-math` (BSM, Black-76, binomial, IV, Greeks, forward, rates, realized) with `cargo test` reference and identity suites.
2. `crates/options-wasm` + `scripts/build-wasm.cjs`; WebAssembly-parity tests in `node --test`; CI target.
3. `vol.py --oracle` in CI.
4. FRED VIX/VIX3M/T-bill/SOFR; `observation_start` in `providers.rs` with tests.
4a. **Massive provider and backfill downloader** (tiers 0–3, in-app job, resumable, ≥ 13 s pacing, purge by source); `options.sqlite` raw tables pulled forward from M2. Start it in week 1 of M1, because the free window rolls.
5. Volatility page; VOL realized half + tile.
6. OSA theoretical mode + synthetic demo chain + smoke test.
**Not in M1:** Alpaca options, IV from backfilled data (raw download only), ledger changes, the agent.
**M1 estimate grows to ≈ 5–6 weeks** with the Massive downloader.

### M2: Chains, OMON and the background agent (≈ 6–7 weeks)
1. Alpaca read-only option kinds, budgets, `#[ignore]` live contract test.
2. `options.rs` normalizer on synthetic fixtures; `options.sqlite`; retention.
3. Quality checks and used/excluded counts.
4. OMON + tile; VOL implied half; OSA market mode.
5. `aperture-agent` sidecar: due-work logic, OS scheduling for all three platforms, Settings install/status/remove, log, lock file, shared budget; cask and Scoop uninstall hooks; in-app fallback.
6. Backfill → IV history (forward, IV, summaries from the M1 download); queue moves into the agent; gap filler; IV rank, skew and earnings implied-move history usable.
**Not in M2:** paper options trading, GEX.

### M3: Options paper trading and portfolio risk (≈ 4–6 weeks)
1. Schema 3 migration; multiplier-aware ledger in Rust and JS with mirrored tests.
2. Long options, then covered calls, cash-secured puts and spreads; multi-leg orders; expiry settlement.
3. Options ticket with bid/ask fills, quote-time stamps and indicative warnings.
4. Portfolio Risk tab: book Greeks, β-weighted delta, scenario grid with crash presets, hedge ideas.
5. Delta-hedge simulator.
**Not in M3:** naked shorts and the margin model (stretch, after M3).

## 5. MVP boundary

**MVP = M1 + M2:** a verified pricer, realized and index vol, real chains with quality flags, and a background recorder building history at $0. Anything that needs history is shown as "accruing, n days", never faked.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Indicative quotes mislead | Permanent badge; liquidity analytics disabled for indicative quotes |
| launchd refuses an unsigned or quarantined sidecar on macOS | Test on hardware early in M2; in-app fallback always available; signing is a separate release decision |
| WebAssembly toolchain friction | IPC fallback (Architecture §2); decide by the end of M1 week 2 |
| Agent and app writing the same database | WAL + `busy_timeout` + agent lock file; one shared `requests` log |
| Silent numerical errors | Oracle, identity, WebAssembly-parity and golden-fixture tests |
| History gaps (machine asleep or off) | Gaps shown; filled only from Massive minute prints, flagged as backfill |
| Massive terms or limits change, or the free tier ends | Weekly `source-health.yml` check; source-tagged rows and one-click purge; recorded Alpaca history unaffected |
| Storage growth | Quote retention; summaries kept; size shown in Settings |
| GEX or N(d2) read as forecasts | Labelling rules (Product Design §14); Analyst keeps class labels |
| Unadjusted splits | Split filter in M1; Massive Basic corporate actions if enabled |
| Ledger migration breaks old accounts | Migration tests on saved workspaces |
| A licence or terms change | Feasibility §10; the weekly `source-health.yml` workflow catches endpoint breakage; reread terms when adding a source |

## 7. Still open (small)

1. ~~Massive free account~~: decided yes (2026-11-17).
2. **Recorder and backfill list:** default to the watchlist (≤ 30 symbols)? SPY and QQQ are always included for index vol.
