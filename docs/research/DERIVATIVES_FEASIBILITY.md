# Derivatives, Options & Volatility — Feasibility Assessment

Status: research only, no implementation. Written 2026-11-17 against `main` at `096acef` (after PR #47).
Companion documents: [Architecture](DERIVATIVES_ARCHITECTURE.md) · [Product design](DERIVATIVES_PRODUCT_DESIGN.md) · [Roadmap](DERIVATIVES_ROADMAP.md) · [Learning map](DERIVATIVES_LEARNING_MAP.md)

## Decisions recorded 2026-11-17

| Question | Decision | Effect on this document |
|---|---|---|
| Data budget | **$0** | Paid sources stay in the tables for reference only. The plan uses Alpaca's free indicative feed, FRED, existing providers, and **one free Massive account** (Options Basic + Stocks Basic) to backfill as much history as possible (§3.1a) |
| India | **Deferred** | §3.3 stays as background research. Nothing Indian is scheduled |
| Short options on paper | Covered and spread-only first; **naked shorts with a margin model as a stretch goal** | See Architecture §6 |
| Snapshot recorder | **A background agent is the primary path** | The recorder runs headless, without the app window. Option maths must therefore run in Rust. See Architecture §2–§4 |
| Maths language | **Rust as the single implementation**, compiled to WebAssembly for the interface; Python only as a test oracle | Measured speeds in §6.3 |
| Legal risk | **Nothing that could cause trouble** | Binding rules in §10 |

Labels used throughout:

| Label | Meaning |
|---|---|
| **Verified (code)** | Read in this repository |
| **Verified (web, 2026-11-17)** | Read on the provider's own documentation or pricing page |
| **Secondary** | Reported by a third-party page; confirm before building |
| **Unverified** | My understanding, not checked this session |

---

## 1. What Aperture has today (verified in code)

### 1.1 Stack

| Layer | What exists | Files |
|---|---|---|
| Shell | Tauri 2 desktop app, no hosted backend | `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs` |
| Native | Rust: provider HTTP, quotas, cache, SQLite, exports, paper-trade validation, websocket streams | `src-tauri/src/*.rs` |
| UI | Vanilla JS with template-string rendering (`render()` rebuilds `#app`), Vite build. **Not React**: `Aperture_Quant_Lab_Feature_Spec.md` assumed React; the code doesn't use it | `src/main.js` (4,547 lines), `src/style.css` |
| Charts | TradingView Lightweight Charts 5.2.1 for price/volume; hand-built SVG builders with hover for analytics; canvas for the Quant Lab replay | `src/pricechart.js`, `src/riskcharts.js`, `src/quantlab/replay.js` |
| Python | Bundled CPython 3.13 with numpy 2.5, scipy 1.18, pandas 3.1, statsmodels 0.15, gs-quant 2.2.5 (hash-pinned). One fixed script runs with `python -I -B`, gets JSON on stdin and returns JSON | `src-tauri/src/quant.py`, `src-tauri/src/quant.rs`, `scripts/bundle-python.cjs` |
| Background compute | Web Worker for Quant Lab research | `src/quantlab/worker.js` |
| Tests | `node --test` (calculation tests), `cargo test --no-default-features --lib`, Playwright smoke | `tests/*.test.js`, `scripts/smoke.cjs` |

### 1.2 Persistence

| Store | Contents | Notes for derivatives |
|---|---|---|
| `aperture.sqlite` → `workspace(id, body)` | **The whole workspace as one JSON blob**: assets with all bars, account, watchlist, datasets, notes (`save_state`, `main.rs:276`) | Option chains must not go here: a single chain snapshot for SPY is several MB, and the blob is rewritten on every save |
| `aperture.sqlite` → `cache(id, body, stamp)` | Raw provider responses keyed `provider:kind:symbol`, plus `quant:SYMBOL` results | Fine for "latest chain" caching; not a history store, since each key is overwritten |
| `aperture.sqlite` → `requests(provider, stamp)` | Request accounting for quotas | Reuse as-is for new providers |
| `aperture.sqlite` → `quant_lab(kind, id, parent, body, immutable, created)` | Write-once Quant Lab records; a different body for the same id is refused (`src-tauri/src/lab.rs`) | This pattern suits chain snapshots and event studies, which have to be reproducible |
| `reference.sqlite` | 13F positions, CUSIP map, world listing directory (`f13.rs`, `universe.rs`) | The model for a separate, large, bulk-loaded `options.sqlite` |

### 1.3 Data providers (`src-tauri/src/providers.rs`)

| Provider | Datasets the app is allowed to request | Local budget | Relevance to derivatives |
|---|---|---|---|
| Twelve Data | `TIME_SERIES` daily (1,300 bars ≈ 5 years), intraday 1m–4h | 800/day, 8 s apart, 1 h reuse | OHLC, so range-based realized-vol estimators work. Prices are **unadjusted** (README "Calculation definitions") |
| Alpha Vantage | `TIME_SERIES_DAILY`, `OVERVIEW`, statements, `EARNINGS`, `EARNINGS_CALENDAR`, `NEWS_SENTIMENT` | 25/day, 13 s apart | `OVERVIEW` has `DividendYield`, `DividendDate`, `ExDividendDate`. `HISTORICAL_OPTIONS` exists on Alpha Vantage, but it is **not** in `ALPHA_KINDS` (`providers.rs:10`) |
| Finnhub | `company-news`, `metric`, `profile2`, `earnings` calendar (400 days back, 120 forward), plus the trade websocket (50 symbols) | 1 s apart | The earnings calendar gives event dates with BMO/AMC timing. That is the anchor for event studies |
| Alpaca | `trades` only: IEX prints, the last 6 days (`providers.rs`, `request("alpaca")`) | 1 s apart, 5 min reuse | **The user's Alpaca key and secret already exist.** The same credentials unlock Alpaca's free indicative options feed. See §3 |
| FRED | `observations` for any series id, newest 500 points (`providers.rs:265`) | 12 h reuse | VIX, VIX3M, T-bill and SOFR rates are all FRED series. They work today with no code change in Rust. The 500-point limit caps history at about 2 years of daily data |
| SEC EDGAR | Filings, XBRL facts, 13F datasets (with `PUTCALL`), 13D/G, Forms 3/4/5 | Keyless + contact email | The 13F put/call ratio (`holders.js:185`) is a **quarterly disclosure of manager-held option notional**. It is not exchange option volume and not dealer positioning |
| AISStream | Vessel positions | — | Not relevant |

### 1.4 Analytics that already exist

| Capability | Where | Reusable for |
|---|---|---|
| Arithmetic daily returns, sample stdev, ×√252 annualization, Sharpe, drawdown | `src/engine.js` `risk()` | Close-to-close realized vol (but see §6.2 for the estimator choice) |
| Aligned correlation by date | `src/engine.js` `correlation()` | Cross-asset vol comparisons |
| gs-quant `volatility`, `beta`, `correlation`, `max_drawdown`, `zscores`, Bollinger bands; **10,000-path block-bootstrap Monte Carlo** seeded from symbol+date; daily-move distribution vs normal | `src-tauri/src/quant.py` | Realized-vol history, the hedging simulator (same bootstrap), tail-risk scenarios |
| Cash rate from FRED `FEDFUNDS` | `src/quant.js` `fredRate()` | Risk-free input, but options should use a term-matched T-bill rate (§3.4) |
| Uniform price-shock stress test | `portfolioPage()` in `src/main.js` | Replace with a full-revaluation spot × vol grid once options are held |
| Paper ledger: long-only, whole/fractional shares, fees, chronological; Rust validation mirrors JS | `src-tauri/src/ledger.rs`, `src/engine.js` `execute()` | Must be extended for options (§7) |
| Quant Lab: hashed bar snapshots, look-ahead-safe fills (signal at close t, fill at open t+1), sealed holdout, reproducible manifests | `src/quantlab/*` | The discipline to reuse for vol-selling and event studies |
| Aperture Analyst briefing with cited source ids | `analystFacts()` in `src/main.js:1917`, `src/analyst.js` | Vol facts can be added to the briefing with sources |

### 1.5 What does not exist (verified by search)

No option chains, contract model, Black-Scholes, IV solver, Greeks, VIX or rates in the UI, dividend or corporate-action processing, or futures. The README's own "Current boundaries" section says *"No live quotes, live orders, options chains, futures…"*. gs-quant's `implied_volatility()` (`gs_quant/timeseries/measures.py:904`) fetches from Goldman's Marquee service (`asset.get_marquee_id()` → `get_historical_and_last_for_measure`). **gs-quant gives Aperture no offline option pricing or IV.** Option math has to be written in-house. scipy, which is already bundled, supplies the numerical tools.

---

## 2. Data taxonomy

Every figure shown must carry one of these classes, in the UI and in exports:

| Class | Examples | Display rule |
|---|---|---|
| **Observed** | Bid, ask, last, volume, open interest, VIX close, T-bill yield | Provider, feed (OPRA / indicative / EOD), quote timestamp, retrieval time |
| **Derived (deterministic)** | Mid, spread %, intrinsic/extrinsic, moneyness, days to expiry, realized vol, IV from a mid via our solver | Show the inputs and the formula; the same inputs always give the same output |
| **Model estimate** | Greeks, implied forward, fitted smile/SVI, event variance, implied move, IV rank (depends on what history exists), **dealer GEX** | Show the model name, assumptions and a quality flag |
| **Simulation** | Hedging P&L paths, Monte Carlo scenarios, bootstrap fans | Label it "Simulation"; record the seed |
| **Not computable** | Actual dealer inventory, true customer/dealer side of OI, executable size behind indicative quotes | Say so in the UI; never fill these in with estimates |

---

## 3. Market-data availability

### 3.1 US equity and ETF options chains

| Source | Cost | Timing | Greeks/IV | Open interest | History | Licence/terms | Verdict |
|---|---|---|---|---|---|---|---|
| **Alpaca indicative feed** (`/v1beta1/options/snapshots/{underlying}`) | Free with the Alpaca account the user already has | Quotes are **modified** indicative quotes, not OPRA; trades delayed 15 min. *Verified (web)* | `delta, gamma, theta, vega, rho` (Black-Scholes) and `impliedVolatility` in the chain snapshot schema. *Verified (web)* | Not in the snapshot. `GET /v2/options/contracts` has `open_interest`, `open_interest_date`, `close_price`, `multiplier`, `size`, `style`. *Verified (web)* | Option bars/trades since Feb 2024. *Verified (web)* | Personal use under Alpaca's terms | **Best free starting point.** No new account is needed. Indicative quotes are fine for research, but never for spread or fill realism |
| **Massive (formerly Polygon.io) Options Basic** | $0 | End-of-day, 5 calls/min | Not listed | Not listed | 2 years | Individual use | Good for EOD history of contract **aggregates** (bars). No Greeks or OI, so IV must be recomputed from closes. *Verified (web)* |
| **Massive Options Starter** | $29/mo | 15-min delayed | Yes, snapshot (current values only; no historical Greeks) | Daily | 2 years | Individual use | **Best paid value.** The full chain snapshot has quotes, IV, Greeks and OI. *Verified (web)* |
| Massive Options Developer / Advanced | $79 / $199 per month | Delayed / real-time | Yes | Daily | 4 / 5+ years | Individual use | Advanced adds real-time quotes. Needed only for intraday or live-quote research. *Verified (web)* |
| Tradier sandbox | Free | Delayed | Not on delayed. Hourly ORATS-computed Greeks for brokerage accounts | — | — | Developer terms | Weaker than Alpaca for this use. *Verified (web), sources conflict on delayed Greeks* |
| Alpha Vantage `HISTORICAL_OPTIONS` | Reported free on 25/day | EOD per date | IV and Greeks reported | Reported | Per-date chain | AV terms | **Secondary.** Could backfill IV history one day per call, but the 25/day budget is already used for statements. `REALTIME_OPTIONS` is premium |
| Finnhub option chain | Unclear for the free plan | — | — | — | — | — | **Unverified.** Don't plan on it |
| Cboe `cdn.cboe.com` delayed-quotes JSON | — | Delayed | Some | Some | None | **Undocumented, no published terms** | **Rejected.** `docs/ROADMAP.md` "Data contract" requires public documented endpoints |
| ORATS, Cboe DataShop, IVolatility, OptionMetrics | Hundreds of $/mo to institutional | EOD to real-time | Yes, with smoothed surfaces | Yes | Decades | Commercial | Only path to **deep historical IV and surfaces** without waiting. Phase 5+ decision |

**Conclusion:** a credible US options workspace can be built at **$0** with Alpaca indicative data, our own IV computation and our own EOD snapshot recorder. Paid tiers (Massive Starter at $29/month and up) are **out of plan** under the $0 budget. They are listed only so the trade-off stays visible. No tier gives historical IV older than what we record or recompute ourselves.

**Optional free backfill (Massive Options Basic, $0, individual use).** Basic includes end-of-day contract aggregates for 2 years (*verified (web)*, custom-bars endpoint: "Options Basic · End-of-day · 2 years"). One request returns the daily bars of **one contract** for a date range. At 5 calls/minute, a constant-maturity ATM IV history needs roughly 10 strikes near the money × ~24 monthly expiries ≈ 240 contracts per symbol, about **50 minutes per symbol**. Over a weekend the background agent could backfill a 20–30 symbol watchlist. The result is approximate: closes are last trades, sometimes hours stale, and there is no bid/ask. It is stored as `quality.source = "backfill"` and drawn differently from recorded data. **Decided 2026-11-17: the user is opening one free Massive account.** The full plan is in §3.1a; the minute-bar method there replaces the daily-close estimate above.

Alpha Vantage `HISTORICAL_OPTIONS` stays unverified. Alpha Vantage's own documentation page didn't load its options section in this session. Even if it is free, the 25/day budget belongs to financial statements, so it isn't in the plan.

### 3.1a Massive free tier: what it provides and the backfill plan (decided 2026-11-17)

The user will open **one** free Massive account and use it to fill as much history as possible. What Options Basic and Stocks Basic include ($0, individual use, end-of-day, 2 years of history, **5 calls/minute**; *verified (web)* on massive.com plan and endpoint pages):

| Need | Massive endpoint (Basic) | Calls | Gives |
|---|---|---|---|
| Which contracts existed, including expired ones | `/v3/reference/options/contracts` with `underlying_ticker`, `expired=true`, `expiration_date`/`strike_price` ranges, `limit ≤ 1000` | ~1 per 1,000 contracts | Type, strike, expiry, `exercise_style`, `shares_per_contract`, `additional_underlyings` (adjusted contracts) |
| Option prices with a time | Options **minute** aggregates for one contract over a date range (base aggregates per request ≤ 50,000) | ~1 per contract (whole life) | OHLC, volume, VWAP and trade count per minute with trades |
| Underlying prices at the same minutes | Stocks minute aggregates | ~4–5 per symbol for 2 years | Time-matched spot for each option print |
| Split-adjusted daily bars | Stocks daily aggregates (`adjusted=true`) | 1 per symbol | Fixes the unadjusted-split problem in today's bars |
| Splits | `/stocks/…/splits` (Corporate Actions) | 1 per symbol | Execution date, ratio, adjustment factor |
| Dividends | Corporate Actions (dividends endpoint) | 1 per symbol | Ex-dates and amounts for American pricing and forwards. *Endpoint name and fields not verified this session* |

Not in Basic: snapshots, quotes (bid/ask), trades, open interest, Greeks/IV, flat files, websockets. **Backfilled IV is therefore computed from trade prints, not quotes**, and is flagged approximate.

**Why minute bars rather than daily bars:** a daily option close is the last trade, which can be hours before the 16:00 underlying close, and that mismatch distorts IV. For each contract and day, Aperture takes the **last minute bar in 15:30–16:00 ET** and pairs it with the underlying's price in the **same minute**. The call cost is the same (one request per contract), and the time-matching is far better. Days with no print in that window are marked stale for that contract, never filled.

**What to download, in priority order.** Each tier runs across **all** symbols before the next tier starts, so every symbol gets usable history early:

| Tier | Contracts per symbol | Purpose | Calls/symbol | Time/symbol at ~4.6 calls/min |
|---|---|---|---|---|
| 0. Reference | Splits, dividends, adjusted daily bars, stock minute bars, contract lists | Inputs for everything | ~30 | ~7 min |
| 1. ATM core | Monthly expiries in the 2-year window plus currently listed ones (~27); the ~6 strikes that were nearest the money 20–100 days before expiry; calls **and** puts (both are needed for the parity forward) | Constant-maturity ATM IV 30/60/90, term structure, **IV rank** | ~300 | ~65 min |
| 2. Skew | ~4 more strikes per expiry at ~10–15% OTM (puts below, calls above) | 25Δ risk reversal and skew history | ~110 | ~25 min |
| 3. Events | Weekly expiries straddling each earnings date in the window (~8 events × 2 expiries × ~6 contracts) | **Implied vs realized earnings moves, IV crush** | ~100 | ~22 min |
| 4. Wider chain | Remaining strikes with any volume, nearest-the-money first | Smile shape, GEX history inputs | open-ended | runs only when idle |

For a 30-symbol recorder list (SPY and QQQ first), tiers 0–3 come to about **540 calls per symbol, roughly 16,000 calls, about 60 hours of running at 4.6 calls/min.** The work is resumable and runs from the background agent. In practice that is 3–5 days on a computer that is usually on. Tier 1 for all 30 symbols finishes first, in about 36 hours. SPY's daily expiries make its contract lists much longer; restricting tiers to monthly and event expiries keeps it in line.

**The 2-year window rolls forward daily.** Data older than 2 years drops out of the free tier, so the backfill should start as early as possible (Roadmap: M1). Data already downloaded may be kept while the account stays active (see §10).

**After the backfill:**
- **Gap filler:** when the Alpaca recorder missed a day (computer asleep), the agent re-pulls minute bars for the Tier 1 contracts of currently listed expiries only (~70 calls per symbol), and only for weeks that contain a gap.
- **Corporate actions:** a weekly refresh, 2 calls per symbol.

**Quality flags on backfilled data:** `backfill-trade-print` (no bid/ask), `stale` (no print in the closing window), `adjusted-contract`, `low-volume` (fewer than N trades that day). Backfilled series are drawn dashed and never mixed silently with recorded quote-based IV. Charts that combine them show where the source changes.

### 3.2 Volatility indices

| Series | Source | Status |
|---|---|---|
| VIX daily close since 1990 | FRED `VIXCLS` (Cboe copyright, citation required) and Cboe `VIX_History.csv` | **Available now** through the existing FRED key. *Verified (web)* |
| VIX3M (93-day) | FRED `VXVCLS`; Cboe `VIX3M_History.csv` (OHLC) | Available now. *Verified (web)* |
| VIX9D | Cboe CSV (from 2011, OHLC) | **Not planned.** The download URL is unverified. FRED covers VIX and VIX3M, so Cboe files aren't needed |
| VVIX, SKEW, VIX1D, VXN, RVX, GVZ, OVX | Cboe historical-data page; several also on FRED | **Unverified** per series. Check each id before building |
| VIX futures term structure | Cboe Futures Exchange (CFE) historical data | Daily settlement files appear free. **Unverified** licence |
| India VIX | NSE publishes history on its India VIX page and in its reports section. *Verified (web)* | **Deferred.** Manual download only if resumed; NSE Data's portal terms prohibit *"systematic or automated data collection"*. *Verified (web), clause truncated* |

FRED's `limit=500` (`providers.rs:265`) gives about 2 years of daily values. A 1-year IV rank and percentile on VIX needs at least 252 points, so this works, but a regime study across 2008/2020 needs the limit raised or pagination (`offset`/`observation_start`). That is a small Rust change.

### 3.3 Indian derivatives (NIFTY, BANKNIFTY), deferred

*Deferred by decision on 2026-11-17. Kept as background research for when India is resumed.*

| Fact | Status |
|---|---|
| Since 20 Nov 2024 (SEBI circular SEBI/HO/MRD/TPD-1/P/CIR/2024/132), each exchange may list **weekly** expiries on one benchmark index only. NSE kept **NIFTY weekly**. **BANKNIFTY is monthly only** (last weekly expiry 13 Nov 2024) | *Verified (web, secondary brokers' notices)* |
| The NIFTY weekly expiry **weekday** has changed more than once (sources disagree between Tuesday and Thursday). It must be read from contract data, never hard-coded | *Verified (web): sources conflict* |
| NIFTY/BANKNIFTY index options are **European, cash-settled**. Lot sizes are revised periodically by NSE | European style: *Unverified this session, well established*. Lot size must be data |
| NSE's public option-chain endpoints are undocumented, and NSE Data's terms prohibit automated collection | *Verified (web)* |
| Broker APIs: Upstox documents an option-chain endpoint with Greeks (a community thread reports wrong Greeks); Zerodha Kite Connect offers quotes and instruments (paid), but no native chain-with-Greeks endpoint was confirmed | *Verified (web, docs + forums)* |
| Licensed vendors (TrueData and others) sell NSE F&O feeds | *Verified (web)*; prices not checked |

**Feasible routes, in order of preference:**
1. **User-imported EOD files.** The user downloads NSE's daily F&O bhavcopy (settlement prices, OI, contracts traded) and India VIX history manually, then imports them as CSV. This fits the existing `parseCSV`/`validateBars` path and has no automated-collection issue. It gives EOD chains with settle prices but no bid/ask.
2. **The user's own broker API** (Upstox or Kite Connect) through a new provider adapter, under that broker's terms. It needs an Indian brokerage account, and Aperture never places orders.
3. Licensed vendor (paid).

**Not acceptable:** scraping `nseindia.com/api/option-chain-*`. It violates the documented terms and the project's data contract.

**India VIX vs. the IV of one NIFTY option.** India VIX is NSE's 30-day *index* of expected NIFTY variance. It is computed from near- and next-month out-of-the-money NIFTY option quotes across many strikes with a Cboe-style variance-swap formula, then interpolated to a constant 30 days (methodology follows Cboe VIX; *unverified this session against NSE's current whitepaper*). The IV of one NIFTY option is a Black-Scholes inversion at **one strike and one expiry**. The two differ by skew (OTM puts carry higher IV), by term (a 6-day weekly vs. a 30-day index) and by method (model-free variance vs. a lognormal model). The ATM 30-day IV is usually close to, but below, India VIX, because the variance-swap strip includes the put wing. The UI must never present one as the other.

### 3.4 Pricing inputs other than option quotes

| Input | Source | Available now? | Notes |
|---|---|---|---|
| Spot | Existing daily bars and Finnhub stream | Yes | Quote timestamps must match option timestamps (§5.1) |
| Risk-free rate by tenor | FRED `DTB4WK`, `DTB3`, `DTB6`, `DTB1YR` (T-bill), `DGS1MO`…`DGS1` (constant maturity), `SOFR` | Yes (FRED key) | Interpolate to each expiry. Today `fredRate()` uses overnight `FEDFUNDS`, fine for Sharpe but too crude for 1-year rho. The series ids are long-standing FRED series: *unverified this session* |
| Dividends (discrete, with ex-dates) | Alpha Vantage `OVERVIEW` has only the next date and yield. Massive Basic lists corporate actions (free). Alpaca has a corporate-actions API (*unverified*) | Partial | **Prefer the implied forward from put-call parity** (§6.1), which makes the dividend input largely unnecessary for European-style IV |
| Splits / adjustments | Not processed anywhere today. `prepareBars` only warns on >40% gaps (`src/quantlab/engine.js:35`) | No | Realized vol across an unadjusted split is badly wrong. A split filter is a Phase 1 requirement |
| Contract multiplier and deliverable | Alpaca `multiplier`/`size`; Massive reference data | With chain provider | Adjusted contracts after corporate actions (non-100 deliverables) must be flagged and excluded from surfaces |
| Earnings dates | Finnhub calendar (`earnings`, ±400/120 days), Alpha Vantage `EARNINGS` (history of reported dates) | Yes | BMO/AMC timing decides which expiry contains the event |
| Macro event dates (FOMC, CPI, NFP) | Fed's FOMC calendar page; BLS release schedule; FRED `releases/dates` API | Not wired | FRED release-dates needs a new `kind` in `providers.rs`. FOMC dates can be a maintained, sourced JSON like `src/data/relationships.json` |
| Index levels (SPX, NDX) | Twelve Data symbol coverage for indices on the free plan is **unverified** | Unknown | SPY/QQQ (ETFs) are available now. SPX options are European and cash-settled, unlike SPY's |

### 3.5 Delayed vs. real-time

| Use | Delayed or EOD enough? |
|---|---|
| IV history, IV rank/percentile, term structure, skew history, VRP, event studies, GEX history | **EOD is enough**, and better: one consistent snapshot time per day |
| Chain exploration, payoff and scenario modelling, learning tools | **15-min delayed is enough**, labelled with the quote time |
| Paper fills at "market" prices | Delayed is OK **if** the fill uses the delayed bid/ask with explicit slippage and the fill time is the quote time, never "now" |
| Intraday gamma, 0DTE research, live hedging | Needs real-time OPRA (Massive Advanced, $199/mo, or a broker). **Out of scope** for this plan |

---

## 4. Feasibility by concept

Legend for **Data**: E = existing provider, F = free with a new adapter, P = paid, U = unavailable.

### 4.1 Options pricing and Greeks

| Metric | Raw inputs | History needed | Computable in-house? | Model | Data | Delayed OK? | Cost | Reliability |
|---|---|---|---|---|---|---|---|---|
| IV from a market price | Bid/ask (or settle), spot or forward, strike, expiry timestamp, rate, dividends/forward, exercise style | None | Yes | BSM/Black-76 inversion for European; binomial or de-Americanized for American | F (Alpaca); paid tiers excluded | Yes | ~0.25 µs per contract (measured, §6.3) | High for liquid OTM near-ATM; **low** for deep ITM American, stale or wide quotes, and below-intrinsic mids (no IV exists) |
| Historical IV (ATM 30d constant maturity) | Daily chain snapshots | ≥252 trading days for rank | Yes, from snapshots | Interpolate total variance between bracketing expiries | Record from day 1 (F). Backfill from Massive contract EOD bars (P, 2 yrs). VIX for SPX (E) | EOD | ~1 row/symbol/day | High once recorded. Backfill from EOD **last trades** is noisy (stale prints); prefer close-time mids |
| IV vs realized | IV series + OHLC | ≥30 days | Yes | RV estimators §6.2 | E + F | EOD | Trivial | High, provided windows are matched (30-day IV vs **next** 30-day RV) |
| IV rank / percentile | IV history | 252 days | Yes | rank = (IV − min)/(max − min); percentile = share of days below | E for VIX/VIX3M now; F for stocks after a year of recording | EOD | Trivial | Meaningless before ~1 year of data. The UI must show "n days of history" |
| IV term structure | ATM IV per expiry | None (snapshot) | Yes | Forward-ATM IV per expiry; forward variance between expiries | F | Yes | Trivial | High for liquid names; earnings humps are real features, not noise |
| IV across strikes (smile) | Chain | None | Yes | IV per strike vs log-moneyness or delta | F | Yes | Trivial | OTM side only; wing quotes are often wide |
| Delta, gamma, theta, vega, rho (contract) | Same as IV, plus the IV | None | Yes | Closed-form BSM/Black-76; finite differences for binomial | F | Yes | Trivial | Model-dependent. Alpaca's vendor Greeks are a cross-check, not ground truth |
| Position and portfolio Greeks | Positions + contract Greeks + multiplier | None | Yes | Sum of qty × multiplier × Greek; dollar delta = Δ·S·m; dollar gamma per 1% = ½Γ·S²·0.01²·m | E (ledger) + F | Yes | Trivial | Sums are exact given the per-contract Greeks; cross-underlying sums need beta-weighting (model) |
| Vanna, charm, vomma, speed, color | As Greeks | None | Yes | Closed-form BSM | F | Yes | Trivial | Sensitive to IV error. **Advanced; display in an expandable section only** |
| Weekend/holiday theta | Trading calendar, expiry time | — | Yes | Choose a time measure: calendar time vs trading time (252) vs a variance clock | E | — | Trivial | A convention, not a fact. Show both clocks |

**Immediate research value:** IV, delta, gamma, theta, vega, and position/portfolio aggregation. **Advanced:** rho (it matters only for LEAPS and high-rate regimes), vanna/charm (hedging and dealer-flow narratives), vomma, speed.

### 4.2 Volatility analytics

| Metric | Data | Computable? | Notes |
|---|---|---|---|
| CBOE VIX, VIX3M, VIX/VIX3M ratio (term-structure slope), IV rank of VIX | **E (FRED)** | Yes | **Deliverable in Phase 1 with zero new providers** |
| India VIX | User import | Yes | No automated pull (§3.3) |
| Historical/realized vol (close-to-close, Parkinson, Garman–Klass, Rogers–Satchell, Yang–Zhang) | **E** (Twelve Data OHLC) | Yes | Needs a split filter. Yang–Zhang is the best default for daily OHLC with overnight gaps |
| Vol cone (RV percentiles by window) | E | Yes | Classic, cheap and genuinely useful |
| VRP (IV − subsequently realized) | VIX (E) or our IV (F) + OHLC | Yes | For SPX: VIX² vs realized SPY variance over the next 21 sessions. **Look-ahead discipline:** the ex-post VRP for date t is known only at t+21 |
| Regimes and clustering | E | Yes | GARCH(1,1) via statsmodels? **Not bundled:** `arch` is not in `constraints.txt`. statsmodels has no GARCH; a 2-parameter MLE in scipy is easy. Simple regimes: VIX percentile buckets plus term-structure inversion (VIX > VIX3M) |
| Skew (25Δ risk reversal, 90/110 moneyness skew), smile | F | Yes | Delta-based skew needs Greeks first |
| Surface | F | Yes | Per-expiry SVI fit in scipy; see §6.5 |
| Event vol, implied move, IV crush | F + earnings dates (E) | Yes | §4.6 |

### 4.3 Moneyness and contract analytics

All are **derived** and become available as soon as a chain exists: spot moneyness K/S, forward moneyness K/F, log-moneyness ln(K/F), standardized moneyness ln(K/F)/(σ√T), delta-bucket moneyness, DTE with exact expiry time (US equity options stop trading at 16:00 ET on expiry day; AM-settled index options differ, and SPX AM vs PM must be carried per contract), intrinsic/extrinsic, spread in $ and as % of mid, volume, OI (previous-day value; OCC publishes it once a day), volume/OI ratio, quote age.

**Liquidity score** (derived and transparent): spread % of mid, quote age, OI, volume, and whether the bid is zero. Every contract shows which threshold it failed. Indicative (Alpaca free) quotes carry a permanent "indicative, not OPRA" flag, and spread-based scores are greyed out for them.

### 4.4 Gamma exposure and dealer positioning

**What can be computed:** per strike and expiry, OI × Γ(model) × multiplier × S² × 0.01 gives the **dollar gamma per 1% move held by the holders of that open interest**. Summing with signs gives an aggregate, re-evaluating Γ over a spot grid gives an exposure profile, and the zero crossing of that profile is the "gamma flip".

**What cannot be observed from public data:**
1. **Who is long and who is short.** OI is a count of open contracts. Every contract has one long and one short side. Public OI says nothing about which side dealers hold.
2. **Dealer inventory.** Market makers' books, hedges in futures/ETFs/other strikes and OTC positions are not published anywhere for free.
3. **Intraday OI.** OCC updates OI once a day. Intraday GEX therefore uses stale OI.
4. **The vol dynamics used to re-evaluate Γ across spot** (sticky strike vs sticky delta). This is an assumption.

**Model conventions to offer side by side, never one alone:**
- *Naive:* customers long calls and long puts, dealers short both (all gamma negative).
- *Common retail convention:* dealers long calls (customers overwrite) and short puts (customers buy protection). This is the convention behind most published "GEX" numbers.
- *Volume-signed (Phase 5+):* sign by trade aggressor (tick rule against bid/ask). It needs trade-level OPRA data (paid), is still noisy, and is unavailable on Alpaca's indicative feed.

**Required UI language:** "Estimated dealer gamma (model). Assumes dealers are {convention}. Actual dealer positions are not public." Show a sensitivity band across conventions and an OI-staleness badge. Never "dealers are short gamma".

**Data:** F (Alpaca OI via contracts endpoint plus snapshot IV), better with P. **Reliability:** low to medium. It is a description of open-interest structure, not evidence of flows. **Priority:** P2–P3, after the chain, Greeks and history are solid.

### 4.5 Hedging and risk management

| Feature | Feasible? | Inputs | Notes |
|---|---|---|---|
| Delta-neutral construction, hedge ratio | Yes | Position Greeks | Shares to trade = −Σ position Δ |
| Dynamic delta-hedge **simulation** | Yes | Historical underlying path (E) or bootstrap paths (`quant.py`); IV assumption | Two modes: (a) historical replay, with the IV path from recorded snapshots once available and otherwise constant IV labelled as such; (b) Monte Carlo. Rebalance by time or by Δ band; per-trade fees + half-spread; outputs P&L distribution, tracking error, Σ costs, gamma-theta decomposition |
| Gamma/vega hedging scenarios | Yes | Chain + Greeks | Solve a 2×2 or 3×3 linear system across hedging contracts; full revaluation to show second-order residuals |
| Protective puts, put spreads, collars | Yes | Chain | Cost vs payoff at horizon; full-revaluation scenario grid |
| Crash stress tests | Yes | Spot shock + **vol shock** + skew steepening | A uniform price shock (today's Portfolio stress test) mis-states option books; the vol response must be part of the scenario. Historical-analogue shocks (e.g. Feb–Mar 2020 SPY −34% with VIX at 80) need VIX history (E) |
| Hedging cost vs expected protection | Partly | IV vs RV distribution | The "expected" protection is model-dependent. Show protection under several RV/jump assumptions, never one number |

### 4.6 Event premium and IV crush

| Feature | Method | Data | Caveats |
|---|---|---|---|
| Implied move | ATM straddle mid / S for the first expiry after the event. Alternatively, the event variance decomposition below | Chain (F) + earnings date with BMO/AMC (E) | The straddle includes diffusive variance up to expiry; subtract it for the pure event move |
| Event variance | Model total implied variance as w(T) = σ²_base·T + E, where E is the one-day event variance for an event inside (0, T]. With two expiries T1 < T2 that both contain the event, and wᵢ = σᵢ²Tᵢ: σ²_base = (w2 − w1)/(T2 − T1) and **E = (w1·T2 − w2·T1)/(T2 − T1)**. Event move ≈ √E (1-sd, as a fraction of spot). If only T2 contains the event, use a pre-event expiry for σ_base: E = w2 − σ²_base·T2. T must be in trading days or a variance clock | F | Unstable when expiries are close together or quotes are wide; flag when E < 0 or σ²_base < 0 |
| Expected vs realized move | |close(after) / close(before) − 1| vs implied | E (bars) + recorded chains | Use the close before the announcement and the close after (or open after for AMC, chosen by the user) |
| IV crush | ATM IV of the event expiry before vs after | Recorded EOD snapshots | Needs the pre-event snapshot **recorded at the time**. Not reconstructible without paid history |
| Option value decomposition across an event | ΔV ≈ Δ·dS + ½Γ·dS² + vega·dσ + θ·dt + residual, or exact full revaluation split by sequential input changes | Snapshots before and after | **A long straddle can make money despite IV crush** if the move is larger than implied. The decomposition shows exactly which input moved the value, which is the answer to "did crush kill the trade?" |
| Historical event studies | Panel of past events per symbol | Earnings history (Alpha Vantage `EARNINGS` dates; E) + our recorded snapshots or paid history | Starting at $0, the study covers only **realized** moves (bars exist). Implied-move history needs recording, or the optional free Massive Basic backfill (approximate) |
| Macro events (FOMC, CPI) | Same decomposition on SPY/SPX | Event dates (new, small) | Index event premia are small and can be swamped by term-structure noise |
| Dividends, corporate actions | Early-exercise risk on calls before ex-date; adjusted contracts | Ex-dates (partial) | Flag, don't model, until a dividend source is wired |

---

## 5. Data quality rules (must be in place before any analytics)

1. **Timestamp coherence.** Option quote time and the underlying price used must be within a tolerance (e.g. 60 s intraday). EOD analytics use the underlying close with the closing option snapshot. A mismatch flags the IV `stale-underlying`.
2. **Quote sanity.** bid ≤ ask; bid > 0 for any IV used in surfaces; mid ≥ intrinsic (discounted); spread % below a threshold; quote age below a threshold. Failures are kept and flagged, never silently dropped.
3. **No-arbitrage checks per expiry.** Call prices decreasing and convex in strike; put-call parity residual within the spread; calendar: total variance non-decreasing in T at fixed forward moneyness.
4. **Non-standard contracts** (multiplier ≠ 100, adjusted deliverables) are excluded from surfaces and GEX and flagged in the chain.
5. **Indicative vs OPRA.** Indicative quotes never feed spread, liquidity or fill-quality analytics.
6. **Missing ≠ zero** (already a project rule): missing OI is not OI = 0, and a failed snapshot is not "no options".

---

## 6. Models and numerical methods

### 6.1 Which pricing model for which contract

| Contract | Exercise | Settlement | Model for IV and Greeks |
|---|---|---|---|
| US single-stock options | American | Physical | **CRR or Leisen–Reimer binomial with discrete dividends** for prices and IV of ITM/dividend-sensitive contracts; BSM on the implied forward for OTM options where the early-exercise premium is negligible (flagged as an approximation) |
| US ETF options (SPY, QQQ, IWM) | American | Physical | As above. SPY's quarterly dividend makes ITM calls before ex-date early-exercisable |
| SPX, NDX, RUT index options | European | Cash | **Black-76 on the implied forward** from put-call parity |
| NIFTY, BANKNIFTY | European | Cash | **Black-76 on the implied forward** (or the NIFTY future of the same expiry) |
| Options on futures (VIX, ES) | European (VIX) / American (ES) | Cash / futures | Black-76 against the matching future. **VIX options price off VIX futures, not spot VIX** |

**Implied forward from put-call parity** (preferred for European, and used to de-dividend American OTM): for strikes near ATM, F = K + e^{rT}(C − P), using the median across the 3–5 strikes nearest the money with tight spreads. This absorbs dividends and borrow without an explicit dividend input, and the residual spread across strikes is itself a quality metric.

### 6.2 Realized volatility estimators

| Estimator | Inputs | Efficiency vs close-to-close | Bias issues |
|---|---|---|---|
| Close-to-close (log) | C | 1× | None, but noisy |
| Parkinson | H, L | ~5× | Ignores overnight gaps; underestimates for stocks |
| Garman–Klass | O, H, L, C | ~7× | Ignores overnight drift |
| Rogers–Satchell | O, H, L, C | ~8× | Drift-independent, ignores the overnight gap |
| **Yang–Zhang** | O, H, L, C + previous C | ~14× | Handles overnight gaps and drift. **Recommended default** |

Annualize with 252. Use log returns (today's `engine.js risk()` uses arithmetic returns, which is fine for Sharpe but not for variance-matching against IV). Exclude bars flagged as unadjusted splits.

### 6.3 IV solver

- Bracket: σ ∈ [1e-4, 5.0]. Reject the price if it is outside [intrinsic·DF, upper bound], where the upper bound is S·e^{−qT} for a call. Those contracts get *no IV*, not a clamped one.
- Method: Newton on vega from a Brenner–Subrahmanyam initial guess (σ₀ ≈ √(2π/T)·C/S), falling back to Brent when vega < 1e-8 or a step leaves the bracket. Tolerance 1e-10 in price, max 100 iterations. Jäckel's "Let's Be Rational" gives machine precision in two iterations, but the extra code isn't worth it at this scale.
- For American contracts, the solver wraps the binomial pricer (≈ 200–500 steps; Leisen–Reimer converges much faster than CRR for the same step count).
- **Measured cost** (2026-11-17, Intel i9-9880H, same algorithms in both languages, identical outputs to 1e-3 over 1M evaluations; erf-approximation normal CDF, Newton IV, CRR tree with precomputed node prices):

| Operation | JavaScript (Node 24, V8) | Rust 1.98 (`-O`) |
|---|---|---|
| BSM price + vega | ~80 ns | ~44 ns |
| IV solve (Newton, to 1e-10) | ~480 ns | ~240 ns |
| American put, CRR 300 steps | ~102 µs | ~69 µs |

  That works out to a 5,000-contract European chain in ≈ 1–2.5 ms, and an American chain (≈ 10 tree prices per IV) in ≈ 3.5 s in Rust or ≈ 5 s in JS. Rust is 1.5–2× faster, and both are fast enough for interactive use. **The language choice is decided by the headless background agent, not by speed** (Architecture §2). WebAssembly speed was not measured; it is usually close to native for scalar floating-point code (*unverified*).

### 6.4 Greeks

Analytic closed forms for BSM/Black-76 (Δ, Γ, ν, Θ, ρ, vanna, charm, vomma, speed). Central finite differences on the binomial pricer for American contracts, with step sizes tied to the input scale (h_S = 0.1%·S, h_σ = 0.1 vol point) and reusing the same tree (lattice Greeks from the first two tree levels for Δ and Γ). **Verification:** analytic vs finite-difference agreement to 1e-6 relative on a grid of (S, K, T, σ, r, q); put-call parity on prices and Δ_C − Δ_P = e^{−qT}.

### 6.5 Smile and surface

- **Phase 2 (display):** raw IV points per expiry against log-moneyness, with a monotone cubic (PCHIP) through liquid OTM points. No extrapolation beyond the last quoted strike.
- **Phase 3 (surface):** raw-SVI per expiry, w(k) = a + b(ρ(k − m) + √((k − m)² + σ²)), fitted by vega-weighted least squares (`scipy.optimize.least_squares`) with Gatheral's butterfly-arbitrage constraints; linear interpolation of total variance in T at fixed k; calendar-arbitrage check. Store the parameters with fit RMSE and the arbitrage flags. Runs in the bundled Python as a second fixed script beside `quant.py`.
- **Rejected for now:** SABR (rates-market convention, little benefit for equity display), local vol (Dupire is unstable on sparse retail chains), stochastic-vol calibration (Heston). These are teaching topics in the Learning Map, not product features.

### 6.6 Portfolio scenarios and Monte Carlo

- **Full revaluation grid:** spot shocks −30%…+20% × vol shocks −10…+30 vol points × horizon (today, +1 week, expiry). Each cell reprices every position. That is a few hundred thousand BSM evaluations, about 10–20 ms in Rust or WebAssembly (from the measured ~44 ns per price).
- **Monte Carlo:** reuse the `quant.py` block bootstrap for underlying paths. For hedging simulations, add GBM and a jump-diffusion toggle so users can see how hedging fails under jumps. Seeded and recorded in the manifest, as Quant Lab runs are.
- MC is justified only for path-dependent questions (hedging P&L, drawdown under a strategy). Vanilla options are priced in closed form or on a tree, never by MC.

### 6.7 Verification methodology

1. **Reference values** from Hull's textbook examples and Haug's *Complete Guide to Option Pricing Formulas*, encoded as `cargo test` fixtures in `crates/options-math`.
2. **Identities:** parity, the Greek relations above, Γ = ∂Δ/∂S by finite difference, the BSM PDE residual Θ + ½σ²S²Γ + (r − q)SΔ − rV ≈ 0.
3. **Cross-implementation:** Rust results, native and WebAssembly, against an independent scipy implementation run through the bundled Python, on random inputs, in CI.
4. **Vendor cross-check (informational, not a test):** our IV vs Alpaca/Massive IV per contract. Show the difference distribution in a debug view. Large disagreements usually reveal timestamp or dividend issues.
5. **Golden snapshots:** a frozen chain JSON fixture with expected IVs and Greeks, so refactors can't change numbers silently, mirroring Quant Lab's result hashes.

---

## 7. Integration constraints found in the code

| Constraint | Location | Consequence |
|---|---|---|
| Symbol validation allows ≤ 20 chars `[A-Z0-9.^_-]` | `ledger.rs:33`, `engine.js execute()` | OCC option symbols are up to 21 chars (`AAPL  261218C00250000` padded; 6 root + 6 date + 1 type + 8 strike). The ledger needs an **instrument model**, not a longer regex |
| Ledger is long-only; selling more than held is rejected | `ledger.rs:63`, test `cannot_short` | Writing options (covered calls, short puts, spreads) needs short positions with collateral rules. Phase 4 proposes defined-risk shorts only (covered, cash-secured, or inside a spread) |
| No multiplier in cash accounting | `book()` in `engine.js` | cash −= qty × price × **multiplier** + fee |
| No expiry, exercise or assignment events | — | A daily "expiry processor" must settle ITM contracts (physical → shares, cash → cash), and paper assignment of American shorts is a modelling choice to document |
| Workspace is one JSON blob | `save_state` | Option positions (small) can live in the account; chains and snapshots (large) go to `options.sqlite` |
| FRED fixed at 500 newest observations | `providers.rs:265` | Raise or paginate for long vol-regime history |
| Unadjusted prices | README | Split filter before any RV/VRP work |
| Uniform price-shock stress test | `portfolioPage()` | Must be replaced by full revaluation when options exist; it would otherwise mis-state option risk |
| Portfolio Sharpe uses a hard-coded 4% rf while Risk analytics uses FRED fed funds | `engine.js risk()`, `quant.py` | Unify on one rates module (§3.4) |
| 13F "put/call ratio" exists | `holders.js:185` | Rename or annotate it as "13F disclosed put/call notional ratio" before an exchange volume PCR appears, to avoid confusion |

---

## 8. Storage and compute budget (desktop)

| Item | Estimate | Basis |
|---|---|---|
| Contracts per chain | AAPL ~2–3k; SPY ~8–10k; mid-cap ~200–800 | *Unverified, order-of-magnitude* |
| Row size (normalized, compact) | ~120 B | ids, bid, ask, last, vol, OI, IV, 5 Greeks, flags |
| One EOD snapshot of a 30-symbol watchlist | ~30 × 2.5k × 120 B ≈ 9 MB | |
| A year of EOD snapshots | ≈ 2.3 GB raw; ≈ 0.5 GB if wings beyond 5Δ and >1 yr expiries are dropped, or if only the derived per-expiry summary is kept for history | Keep full chains for 30–90 days and derived summaries (ATM IV per expiry, 25Δ RR/BF, SVI params, GEX by strike) forever |
| Derived daily summary | ~2–5 KB per symbol per day | 30 symbols × 10 years ≈ 1.5 GB worst case; realistically < 200 MB |
| Alpaca snapshot calls | 1 call per 1,000 contracts (pagination) | ~3–10 calls per symbol; 30 symbols ≈ 300 calls per EOD run, needs a budget entry in `providers.rs` |
| IV + Greeks for a full chain | ≈ 1–2.5 ms (European); ≈ 3.5 s American binomial, measured in Rust (§6.3) | Native in the agent and commands; WebAssembly in the interface |
| SVI fit | ~5–50 ms per expiry in scipy | Batched in one Python start (the `quant.py` batch pattern) |

---

## 9. Bottom line

| Category | Items |
|---|---|
| **Supportable immediately (existing providers)** | VIX/VIX3M levels, term-structure ratio, VIX IV rank/percentile; realized-vol estimators and vol cones on every stock; T-bill rate curve; earnings calendars for event timing; an options **math and payoff lab** using user-entered or model prices (clearly labelled theoretical) |
| **Free with one new adapter (Alpaca, credentials already stored)** | Delayed/indicative chains with vendor and own IV/Greeks, daily OI, smile and term structure, payoff with market mids, an EOD snapshot recorder that builds Aperture's own IV history from day one |
| **Free with the Massive account (decided)** | 2 years of approximate IV history from time-matched minute prints, earnings implied-move history, split-adjusted bars, splits and dividends, expired-contract reference (§3.1a) |
| **Excluded by the $0 budget** | Real (non-indicative) delayed quotes from Massive Starter ($29/mo) and above |
| **Needs significant paid infrastructure** | Historical IV surfaces older than our own recording, intraday OPRA quotes and trades, aggressor-signed volume for GEX, real-time Indian F&O |
| **Not possible from public data** | Actual dealer positions or inventory; true direction of open interest |

---

## 10. Staying out of trouble (binding rules)

These rules apply to every feature in this plan, including the background agent. They extend the "Data contract" in `docs/ROADMAP.md`. This is an engineering policy, not legal advice. Provider terms change, so reread them before adding any new source.

**Where data comes from**
1. Only **documented, public APIs** reached with **the user's own keys**. No scraping, no undocumented endpoints (NSE `option-chain` API, Cboe `cdn.cboe.com` quote JSON), and no reverse-engineered app or broker endpoints.
2. **Free-plan limits are enforced locally, in the agent too.** The agent and the app share the `requests` table, so the daily budget per key is counted once across both. No key sharing, key rotation, proxies or retry storms.
3. **Read-only broker access.** The Alpaca integration only *reads* market data, contract reference and the market calendar. Aperture never calls an order, position-changing or account-changing endpoint. The Settings copy recommends **paper-account Alpaca keys** so a live brokerage account is never involved.

**Who can see the data**
4. **Personal use only. Alpaca's market data and Massive's Basic tier are licensed for individual use.** Aperture must not redistribute them:
   - No recorded chains, IV history or vendor responses are committed to the repo, published on the project site, or bundled into installers.
   - Test fixtures are **synthetic**, matching the provider's response *shape* but containing no real data.
   - Screenshots and demo captures (`scripts/capture-demo.cjs`, `site/`) use **Demo data** only.
   - Exports are labelled "For your own research. Check the data provider's terms before sharing."
5. **Index data copyright.** VIX and VIX3M from FRED carry a Cboe copyright and a citation requirement. The UI cites "Cboe, retrieved from FRED" beside the series. The series is not re-published.
6. **Non-professional status.** Free and individual tiers assume the user is a non-professional subscriber: not using the data for a business or as a registered market professional. If that ever changes, the data plan has to change too. The indicative feed avoids OPRA fees, but not provider terms.

**What the app says and does**
7. **Paper only.** No order routing and no real-money execution, at any phase. Naked shorts and margin are paper simulations, labelled as such.
8. **Not investment advice.** No buy/sell signals presented as recommendations. Estimates (GEX, risk-neutral probabilities, implied moves) keep their class labels everywhere, including in Aperture Analyst answers. This matches the Analyst rules already in `src/analyst.js`.
9. **A visible background agent.** It is opt-in, listed in Settings with its last run and log, removable with one click, and removed on uninstall. Nothing hidden or self-reinstalling.

**Massive-specific rules** (from Massive's Individuals Terms of Service and Market Data Terms, read 2026-11-17; a summary, not legal advice)
10. **One account, one key, and the rate limit enforced locally.** The terms prohibit "creating multiple accounts or rotating Credentials" and circumventing "rate limits, usage quotas". Aperture spaces Massive calls at least 13 s apart (≈ 4.6/min, under the 5/min limit). It treats the limit as **shared across Options and Stocks endpoints**, because the plan pages don't say otherwise. It backs off on any 429 and never retries in parallel.
11. **Storage is allowed while the licence is active, and deletable on demand.** The terms allow you to "access, download, store and use the Information" for personal use. When the licence ends you must delete it "within thirty (30) days", including "stored copies and caches".
    - Every row in `options.sqlite` carries its **source**. That includes our derived IVs and Greeks, because data that "can reasonably be used to recreate" the original counts as Information.
    - Settings has **Delete all Massive data**, and the agent also deletes it if the Massive key is removed and the user confirms the account has ended.
    - `options.sqlite` stays out of the JSON backup.
12. **No sharing, no publishing, no index products.** Nothing Massive-derived leaves the computer. Aperture's constant-maturity ATM IV series are personal research measures ("your own research, analysis"). They are never published, and never presented as an index or benchmark (§5(d) prohibits creating or publishing an index or reference price without a licence).
13. **No AI training, and care with online models.** The terms prohibit using the data to "train, fine-tune or distill" models, and prohibit letting an AI tool use it "for its own purposes".
    - Aperture trains nothing.
    - The **local** Aperture Analyst (llama.cpp on this computer) may use options figures in its briefing.
    - When the Analyst is set to an **online account** (OpenRouter or Hugging Face), the briefing leaves out Massive- and Alpaca-derived figures and says so. Sending licensed data to a third-party model service is the kind of "make it available to others" use the terms forbid.
    - *Follow-up outside this plan:* review whether the existing online-Analyst briefing sends other providers' licensed data (Finnhub news text, Twelve Data prices) off the computer.
14. **Attribution.** Views that use Massive data name it as the source, as every Aperture panel does.
15. **Non-professional status.** The free plans assume you're a non-professional: a natural person using data only for personal, non-business use, not registered with the SEC or similar. If that changes, these plans stop being the right licence.

**Deferred work**
16. **India stays deferred.** When it returns, the only routes are the user's own broker API under that broker's terms, or files the user downloads and imports manually.
