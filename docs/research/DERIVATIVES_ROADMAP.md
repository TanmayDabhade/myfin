# Derivatives Analytics — Roadmap

Status: proposal for review. Nothing here is implemented. Written 2026-11-17.
Efforts assume one developer working in the existing codebase: **Low** ≈ ≤ 3 days, **Medium** ≈ 1–2 weeks, **High** ≈ 3+ weeks.

## 1. What changed from the starting hypothesis, and why

| Hypothesis | Revised | Reason |
|---|---|---|
| Phase 1 "foundational analytics" | Kept, but defined as **things that need no new data provider**: options math, realized vol, VIX/rates from FRED, theoretical strategy lab | FRED (already wired) carries VIX, VIX3M and T-bill rates; Twelve Data bars are OHLC. Real user value at zero data cost |
| Phase 2 options research | Kept, and it **starts the EOD snapshot recorder as early as possible** | IV rank, IV history, event IV crush and skew history all need *time*. No free source provides historical IV, so every week without recording is lost history |
| Phase 3 advanced vol, Phase 4 portfolio | **Swapped** | Advanced vol (IV rank, event studies with implied moves, VRP on single names) is gated by months of recorded history. Portfolio Greeks and options paper trading depend only on Phase 2 and are core to Aperture's paper-trading identity, so they fill the waiting time |
| Hedging in Phase 4 | Delta-hedge **simulator** moves to Phase 3 | It needs only underlying paths (already in the workspace) and the Phase 1 pricer |
| GEX in Phase 5 | Kept in Phase 5 | Its assumptions are the weakest of anything here. It depends on chains, OI history and a mature quality layer |
| India in scope | **User-imported EOD only** until a broker adapter is chosen | NSE terms prohibit automated collection (Feasibility §3.3) |

**The time-gated dependency:** IV rank and percentile need 252 recorded trading days. A recorder that starts at Milestone 2 gives single-name IV rank around **Milestone 2 + 12 months**, unless Massive EOD backfill is bought (approximate, last-trade-based). VIX IV rank is available at Milestone 1 because VIX history is on FRED.

## 2. Phases and features

### Phase 1: Foundations (no new providers)

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| Options math core `src/options/{bsm,iv,american,forward,rates}.js` + test suite + Python oracle | Correct, reproducible prices, IV and Greeks; everything else depends on this | `engine.js` style pure modules; `tests/*.test.js`; `quant.py` pattern for the oracle | None (inputs only) | — | BSM with q, Black-76, Leisen–Reimer binomial with discrete dividends, Newton+Brent IV, analytic Greeks incl. 2nd order | **Medium** | None | High once verified against Hull/Haug and identities | **P0** |
| Rate curve from FRED | Term-matched r for each expiry | `fetchData("fred", …)`, `macroSeries` in `main.js` | `DTB4WK`, `DTB3`, `DTB6`, `DTB1YR` (and `SOFR`) | **Existing** (FRED key) | Bill-yield → continuous zero; linear interpolation | **Low** | FRED | High | **P0** |
| Realized-vol module `realized.js` + split filter | RV estimators with correct conventions; base for VRP | `asset.bars` (OHLC); `prepareBars` gap warnings | Daily OHLC | **Existing** | Close-to-close (log), Parkinson, GK, RS, **Yang–Zhang**; vol cone percentiles | **Low** | None | High, except across unadjusted splits (flagged) | **P0** |
| Volatility page: VIX, VIX3M, term ratio, VIX IV rank/percentile, VIX vs SPY RV, VRP, regime band | Market-level vol context; first VRP research | New sidebar page in Markets; `lineChart`/`hover` from `riskcharts.js` | `VIXCLS`, `VXVCLS`; SPY bars | **Existing**; FRED history needs `observation_start`/pagination for > 2 years | VRP = VIX(t) − RV(t→t+21), shown only once known; regime buckets | **Low–Medium** | Realized module; FRED param change | High (observed series); regime labels are definitions, shown as such | **P0** |
| VOL view, realized half (stock page) | Vol profile of any stock in the workspace | `VIEWS` in `stock.js`; `stockGrid()` tile | OHLC | **Existing** | Cone, RV history, estimator switch | **Low** | Realized module | High | **P1** |
| OSA, theoretical mode | Payoffs, Greeks curves, scenario grid with model prices; the main learning tool | New stock view; `riskcharts.js` builders | Spot (existing), user IV or RV, rate curve | **Existing** | Full revaluation; sticky-strike / sticky-moneyness toggle | **Medium** | Math core | High as a model; **labelled "Model price"** | **P1** |
| Synthetic demo chain in `sample.js` | Demo mode and E2E tests without keys | `sample()`, `scripts/smoke.cjs` | — | — | SVI smile + term structure + noise, seeded | **Low** | Math core | n/a (synthetic, badged) | **P1** |
| India VIX CSV import | India vol context without violating NSE terms | Existing CSV import rules (`parseCSV`) | User-downloaded NSE file | **User import** | — | **Low** | Volatility page | High (official file) | **P2** |

**Milestone 1 exit criteria:** math core passes the reference, identity and oracle tests in CI; the Volatility page shows VIX/VIX3M with source and date and a VRP chart that never uses future data at a past date; OSA prices a vertical spread and a collar in model mode with scenario grid; the demo chain renders in browser preview.

### Phase 2: Options research (chains, IV, recorder)

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| Alpaca options adapter (`option_snapshots`, `option_contracts`) | First real chains at $0 | `providers.rs` kinds + budget; the Alpaca key/secret already stored; `fast_gate` | Chain snapshot, contract reference (OI, multiplier, style) | **Free** (indicative quotes; trades 15-min delayed) | — | **Medium** | None | Medium: indicative ≠ OPRA | **P0** |
| `options.rs` normalizer + `options.sqlite` | Provider-independent schema; storage outside the workspace blob | `open_reference` pattern; `lab.rs` write-once | — | — | OCC parse; content hash | **Medium** | Adapter | High | **P0** |
| Quality layer `quality.js` | Make bad quotes visible before they become bad analytics | Shown in every view | Quotes + times | — | Spread, age, intrinsic, parity residual, monotonic/convex checks | **Low–Medium** | Normalizer | High | **P0** |
| OMON chain view | Contract-level research: IV, Greeks, liquidity, moneyness, compare | New stock view + tile | Chain | Free | Our IV/Greeks on parity forward; vendor values for cross-check | **Medium** | Adapter, math core, quality | Medium–High for liquid names | **P0** |
| EOD snapshot recorder + `daily_summary` | **Starts the history clock** for IV rank, skew history, events | Runs while the app is open (like `watchFresh`); Settings → Reference data retention | Watchlist chains at ~16:15 ET | Free | Constant-maturity ATM IV (variance interpolation), 25Δ RR/BF | **Medium** | OMON pipeline | High for captured days; gaps are gaps | **P0** |
| VOL implied half: smile, term structure, IV vs RV | Core equity-vol facts | VOL view | Chain + OHLC | Free | PCHIP display smile; forward variance | **Medium** | Recorder, realized module | Medium–High | **P1** |
| OSA market mode | Strategies with real mids, bid/ask cost toggle | OSA | Chain | Free | Same as Phase 1 | **Low** | OMON | Medium (indicative quotes) | **P1** |
| Massive provider (optional, paid) | Real delayed quotes, daily OI, 2y contract EOD aggregates | Second provider behind the same normalizer | Starter $29/mo | **Paid** | — | **Medium** | Normalizer | High for quotes; backfilled IV approximate | **P2** (needs your budget decision) |

**Milestone 2 exit criteria:** OMON loads AAPL and SPY chains with our IV within tolerance of vendor IV for > 90% of liquid OTM contracts (an investigation tool, not a pass/fail on the vendor); every excluded contract shows a reason; the recorder writes one hashed snapshot and summary per watchlist symbol per trading day, and pruning never deletes a referenced snapshot.

### Phase 3: Portfolio options and hedging

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| Ledger instrument model, multiplier, expiry settlement (long options only first) | Paper-trade options correctly | `ledger.rs`, `engine.js` `execute/book/portfolio`, `migrate()` to schema 3 | Contract reference | Free | Cash with multiplier; ITM settlement | **Medium–High** | Phase 2 | High (deterministic accounting) | **P0** |
| Options ticket + multi-leg orders | Execute OSA strategies on paper | Trade page | Chain quotes with times | Free | Fill at bid/ask + slippage + per-contract fee | **Medium** | Ledger | Medium (fills from delayed/indicative quotes) | **P1** |
| Defined-risk shorts (covered, cash-secured, spreads) | Covered calls, CSPs, credit spreads | `ledger.rs` validation | — | — | Collateral reservation | **Medium** | Ledger | High | **P1** |
| Portfolio Greeks + β-weighted delta | Book-level exposure | Portfolio → Risk tab | Positions, chain, β (gs-quant `beta1y` already computed in RSK) | Free | Σ qty·m·Greek; β-weighting | **Low–Medium** | Ledger, recorder marks | Medium (β is a model) | **P0** |
| Full-revaluation scenario grid + crash presets | Replace the uniform shock; real stress testing | Portfolio stress panel | Positions; VIX history for analogues | Existing + Free | Spot × vol × horizon revaluation | **Medium** | Math core, ledger | Model-dependent, transparent | **P0** |
| Delta-hedge simulator | Learn hedging costs, rebalance trade-offs, jump risk | Opens from OSA/Portfolio; `quant.py` bootstrap paths | Underlying bars | **Existing** | Discrete re-hedging; GBM/bootstrap/jump paths; gamma-theta P&L decomposition | **Medium** | Math core | High as a simulation; labelled | **P1** |
| Protective put / collar / put-spread comparison | Tail-hedge cost vs protection | Portfolio → hedge ideas | Chain | Free | Scenario rows per hedge | **Low** | Scenario grid | Medium | **P1** |
| Option marks in equity curve | Honest paper equity history | `equityCurve()` | Recorded snapshots | Free (from recorder) | Mid if recorded, model mark otherwise (flagged) | **Medium** | Recorder, ledger | Medium | **P2** |

**Milestone 3 exit criteria:** buy, sell and expire an option on paper with correct cash to the cent (multiplier and fees); a covered call and a put spread validate, a naked short is refused with a reason; Portfolio shows book Greeks and a scenario grid that matches OSA for a single-position book; the hedging simulator reproduces textbook results (hedging error ∝ σ√(Δt) as rebalance frequency rises) on GBM paths.

### Phase 4: Advanced volatility intelligence (once 3–6+ months are recorded)

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| Single-name IV rank / percentile, IV history | Is IV high relative to its own past? | VOL, DES, Screener columns, Alerts | ≥ 252 days of `daily_summary` | Free (time-gated) or Paid backfill | rank/percentile | **Low** | Recorder history | High once n ≥ 252; shown with n | **P1** |
| EVT: implied move, event variance, expected vs realized, IV crush decomposition | Price event risk; test whether options over- or under-price events | EVT view; Finnhub/Alpha earnings dates; GP markers | Pre/post-event snapshots; earnings dates with timing | Free (needs recorded events) | Straddle move; two-expiry event variance; sequential revaluation attribution | **Medium** | Recorder, math core | Medium; small samples flagged | **P1** |
| Single-name VRP and vol-selling study in Quant Lab | Does selling vol pay after costs, here, historically? | Quant Lab new experiment type; `lab.rs` kinds | Recorded or backfilled chains | Free (time-gated) / Paid | Short straddle/strangle backtest with bid/ask fills; holdout discipline | **High** | Ledger semantics, recorder, Quant Lab | Medium; survivorship and sample-size labels | **P2** |
| SVI surface fit + arbitrage checks (`vol.py`) | Smooth, arbitrage-aware smiles; skew metrics; small-multiples view | Bundled scipy; `quant.rs` batch pattern | Chains | Free | Raw SVI, vega-weighted LSQ, butterfly/calendar checks | **Medium–High** | Phase 2 | Medium (fit quality reported) | **P2** |
| Skew history (25Δ RR/BF over time) | Skew regime research | VOL | `daily_summary` | Free (time-gated) | — | **Low** | Recorder | Medium | **P2** |
| Macro event calendar (FOMC, CPI) | Index event premia | Volatility page; EVT for SPY | Sourced static JSON + FRED release dates | Free | Same as EVT | **Low–Medium** | EVT | Medium | **P3** |
| Optional 3D surface view | Visual intuition | VOL | SVI params | Free | — | **Low** | SVI | n/a | **P3** |

### Phase 5: Advanced derivatives research

| Feature | Research purpose | Existing integration | Required data | Data availability | Mathematical model | Effort | Dependencies | Reliability | Priority |
|---|---|---|---|---|---|---|---|---|---|
| GEX by strike, profile across spot, flip range, under 2–3 named conventions | Describe OI-implied gamma structure | GEX view; Analyst briefing with "estimated" label | Chain + OI (daily) | Free | OI·Γ·m·S²·0.01 with assumed signs; re-evaluation over spot grid | **Medium** | Recorder, quality layer | **Low–Medium**; never presented as observed | **P2** |
| OI by strike (mirrored) and OI change | Observed positioning structure (sides unknown) | OMON/GEX | Daily OI | Free | — | **Low** | Recorder | High (observed) | **P2** |
| Second-order Greeks panel (vanna, charm, vomma, speed) | Advanced sensitivity | OMON Advanced preset, OSA | Chain | Free | Closed form | **Low** | Math core | Medium (IV-error sensitive) | **P2** |
| India broker adapter (Upstox or Kite Connect) | Live/EOD NIFTY chains under the user's own broker terms | New provider; `contract.style = european`, cash settlement | Broker account (KYC) | **User's broker** (cost per broker) | Black-76 vs NIFTY future | **Medium–High** | Normalizer | Medium (broker Greeks reported unreliable; we compute our own) | **P3** |
| NSE bhavcopy import (EOD chains) | Indian EOD research without automation | `options_import_csv` | User-downloaded files | **User import** | Black-76 on settle vs future settle | **Medium** | Normalizer | Medium–High (settle prices, no bid/ask) | **P2** |
| Massive backfill → approximate IV history | Skip the 12-month wait | Recorder tables, `quality.source = backfill` | Starter/Developer plan | **Paid** | IV from EOD closes | **Medium** | Massive adapter | Medium–Low (stale last trades) | **P3** |
| GARCH(1,1) forecast vs IV | Model-based vol forecast comparison | VOL; `vol.py` | OHLC | Existing | MLE in scipy | **Low–Medium** | Realized module | Medium | **P3** |
| Real-time OPRA / intraday GEX / 0DTE | Intraday research | — | $199/mo+ | Paid | — | **High** | Everything | — | **Not planned** |

## 3. Dependency graph

```
Math core ─┬─► OSA (theoretical) ─────────────┐
           ├─► Hedging simulator               │
Rates ─────┤                                   │
Realized ──┼─► Volatility page, VOL realized   │
           │                                   ▼
           └─► Alpaca adapter ─► normalizer ─► quality ─► OMON ─► OSA market ─► Ledger options ─► Portfolio Greeks/grid
                                    │                       │                                     └► equity curve marks
                                    └─► options.sqlite ─► EOD recorder ══(time: 3–12 months)══► IV rank, EVT, skew history,
                                                                       │                         vol-selling study
                                                                       └─► SVI fits ─► surface views
                                                                       └─► GEX (with quality + OI history)
```

## 4. First three milestones (concrete)

### M1: Vol foundations and the options math core (≈ 3–4 weeks)
1. `src/options/bsm.js`, `iv.js`, `american.js`, `forward.js`, `rates.js`, `realized.js` + `tests/options.*.test.js` (Hull/Haug values, identities, PDE residual, FD vs analytic, solver edge cases).
2. `src-tauri/src/vol.py --oracle` + `scripts/options-oracle.cjs` in `pr-checks.yml`.
3. FRED: add VIX/VIX3M/T-bill/SOFR series; allow `observation_start` in `providers.rs` with a test.
4. Volatility page (Markets): VIX, VIX3M, ratio, VIX rank/percentile, VIX vs SPY Yang–Zhang RV, VRP shown only for dates ≥ 21 sessions old, regime band.
5. `VOL` stock view, realized half + tile.
6. `OSA` theoretical mode (legs, templates, payoff, Greeks curves, scenario grid) + synthetic demo chain + smoke test.
**Not in M1:** any option chain provider, ledger changes.

### M2: Chains, OMON and the recorder (≈ 4–5 weeks)
1. Alpaca `option_snapshots` + `option_contracts` kinds, budgets, live contract test (`#[ignore]`).
2. `options.rs` normalizer + fixtures; `options.sqlite` with write-once snapshots and retention settings.
3. `quality.js` rules and the per-chart used/excluded counts.
4. `OMON` (chain, presets, compare, our vs vendor IV) and the OMON tile.
5. EOD recorder for the watchlist + `daily_summary` (ATM IV 30/60/90, 25Δ RR/BF, term JSON).
6. VOL implied half (smile, term, IV vs RV); OSA market mode.
**Not in M2:** paid providers, paper trading options, GEX.

### M3: Options paper trading and portfolio risk (≈ 4–6 weeks)
1. Schema 3 migration: `instrument` on trades; multiplier-aware `book()`/`portfolio()` in JS and Rust with mirrored tests.
2. Long options, then covered/cash-secured/spread shorts; multi-leg atomic orders; expiry settlement as `source: "expiry"` trades.
3. Options ticket with bid/ask fills, quote-time stamping and indicative warnings.
4. Portfolio → Risk: book Greeks, β-weighted delta, full-revaluation grid with crash presets, hedge ideas.
5. Delta-hedge simulator (historical, bootstrap, GBM, jump) with cost/tracking-error frontier.
**Not in M3:** margin model for naked shorts, early-exercise assignment simulation beyond documented rules.

## 5. MVP boundary

The **MVP is M1 + M2**: a correct pricer, realized and index vol, real chains with honest quality flags, and a recorder building history. That is a credible options and vol research tool at $0 data cost. Everything requiring history (IV rank on single names, event studies with implied moves, vol-selling backtests) is visibly "accruing", never faked.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Alpaca indicative quotes mislead (modified quotes) | Permanent badge; liquidity analytics disabled for indicative; optional Massive Starter |
| Silent numerical errors | Oracle tests, identity tests, golden chain fixture, vendor cross-check view |
| History gaps because the app wasn't open at 16:15 ET | Late-capture flag; gaps shown; optional tray/launch-agent recorder later (an OS-specific decision) |
| Storage growth | Retention for full quotes; summaries kept; Settings shows the size, as 13F quarters do |
| Users read GEX or N(d2) as forecasts | Fixed labelling rules (Product Design §13); Analyst instructed to keep the class labels |
| Unadjusted splits corrupt RV/VRP | Split filter in M1; a corporate-actions source in Phase 2 (Massive Basic free tier lists corporate actions) |
| Ledger change breaks existing paper accounts | Schema migration with tests on saved workspaces (`tests/migrate.test.js` pattern) |
| Expiry weekdays and lot sizes change (India) | Always taken from contract data, never constants |

## 7. Decisions needed from you

1. **Data budget:** stay at $0 (Alpaca indicative + recorder) or add Massive Options Starter ($29/mo, individual use) for real delayed quotes and backfill?
2. **India:** is user-imported NSE EOD data enough, or should a broker adapter (Upstox vs Kite Connect) be planned, given it needs your Indian brokerage account?
3. **Short options on paper:** defined-risk only (recommended), or also naked shorts with a margin model?
4. **Recorder scope and timing:** watchlist only (recommended, ≤ 30 symbols) at 16:15 ET; and is a background launch agent acceptable later so captures don't depend on the window being open?
5. **Math location:** JS canonical with Python as test oracle (recommended) vs Rust canonical.
6. **Undocumented endpoints:** confirm the project rule stays (no Cboe CDN JSON, no NSE API scraping).
