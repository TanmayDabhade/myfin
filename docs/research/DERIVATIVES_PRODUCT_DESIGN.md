# Derivatives Analytics — Product Design

Status: proposal. Written 2026-11-17. Follows Aperture's existing interaction model: a stock page with a panel grid and terminal-style function codes (`AAPL HDS`), sidebar pages for markets and the account, black/neutral high-density UI, and every figure labelled with source and date.

## 1. Design decisions

1. **No new "Options app".** Options analytics become **functions on the stock page**, reachable like every existing one (`AAPL OMON`, `SPY VOL`). One new **market page**, *Volatility*, covers index and cross-asset vol. Portfolio and Trade gain option awareness. This answers "select a stock and see its vol profile, chain, earnings IV and exposure without navigating away".
2. **Codes follow terminal mnemonics where one exists**, as `src/stock.js` already does:

| Code | Name | Where | Phase |
|---|---|---|---|
| `VOL` | Volatility (realized now, implied once chains exist) | Stock page | 1 |
| `OSA` | Option strategy & scenario lab (payoff, Greeks curves, scenario P&L) | Stock page | 1 (theoretical) → 2 (market prices) |
| `OMON` | Option monitor (chain) | Stock page | 2 |
| `EVT` | Events: implied vs realized move, IV crush | Stock page | 3 |
| `GEX` | Estimated gamma exposure (model) | Stock page | 5 |
| `VIX` / page **Volatility** | VIX, VIX3M, term ratio, regimes (India VIX deferred) | Markets group in sidebar | 1 |
| `PRSK` | Portfolio risk: Greeks, scenario grid, hedging | Portfolio page tab | 4 |

3. **Every derived value is clickable to its inputs.** Hover shows the class (Observed/Derived/Model/Simulation), the inputs and the formula name. This is the "make uncertainty visible" requirement, and it is also the main learning surface.
4. **Quality before beauty.** Each chart shows the count of contracts used and dropped, with the reason ("41 used · 12 wide spread · 3 below intrinsic").

## 2. Navigation

```
Sidebar
  Markets      Overview · Universe · Screener · Economy · Commodities · Volatility (new)
  Research     Quant Lab
  Your account Portfolio (+ Risk tab) · Trade (+ Options ticket) · Alerts
  Stock        ◆ AAPL  · recent…

Stock page function strip
  Grid · DES · GP · ASK · FA · CN · HDS · OWN · SPLC · DCF · RSK · VOL · OMON · OSA · EVT · TAS · CF
```

Command search accepts `AAPL OMON`, `OMON` (current stock), `SPY VOL`, `VIX`, and `AAPL 261218C250` to open a single contract in OSA.

## 3. Stock page grid additions

Two tiles join the grid (`stockGrid()` in `src/main.js`):

```
┌ Volatility  VOL ───────────────────────────┐  ┌ Options  OMON ──────────────────────────────┐
│ 30d realized (Yang–Zhang)   24.1%          │  │ ATM IV 30d     27.8%   Indicative · 15:58 ET│
│ 1y RV percentile            38th           │  │ IV − RV(30d)   +3.7 pts                     │
│ ATM IV 30d                  27.8%  (model) │  │ Next earnings  Jan 29 AMC · in Feb 20 exp   │
│ IV rank (1y)    — 41 days of history       │  │ Implied move   ±5.2%  (straddle, model)     │
│ ▁▂▃▅▃▂▂▃▄▆▅▃  RV 1y                         │  │ 25Δ skew       +4.1 pts puts over calls     │
└────────────────────────────────────────────┘  └─────────────────────────────────────────────┘
```

Before chains exist (Phase 1), the OMON tile says what it needs ("Options data needs an Alpaca key: Settings → Data sources"), as other tiles do today.

## 4. VOL: Volatility view

```
┌ AAPL · Volatility ────────────────────────────────────────────────────────────── [1Y][3Y][5Y] ─┐
│ Realized  20d 22.4%  60d 25.0%  1y 27.3%     Estimator [Yang–Zhang ▾]  ⓘ split filter on      │
│ Implied   ATM 30d 27.8%  60d 28.6%  90d 29.0%   IV rank 1y —  (41 days recorded) ⓘ             │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ IMPLIED vs REALIZED                                                                            │
│  35% ┤        ╭╮                     ── ATM IV 30d (recorded)   ┄┄ backfill (last-trade, approx)│
│  30% ┤ ╭──╮  ╭╯╰╮   ╭─╮              ── RV 30d trailing                                         │
│  25% ┤─╯  ╰──╯  ╰───╯ ╰──            ░░ VRP = IV(t) − RV(t → t+21)  (known 21 days later)       │
│      └─────────────────────────── ▲earnings ▲earnings                                           │
├───────────────────────────────┬────────────────────────────────────────────────────────────────┤
│ VOLATILITY CONE                │ TERM STRUCTURE (today vs 1 week ago)                          │
│  RV percentiles by window      │  IV ┤ •──•──•                                                 │
│  max ─  ─  ─  ─  ─             │     ┤      ╲•──•──•   ← earnings hump in Feb                    │
│  p75 ─  ─  ─  ─  ─   ● = today │     └ 7d 30d 60d 90d 180d                                      │
│  p25 ─  ─  ─  ─  ─   ◆ = IV    │  Forward vol between expiries shown on hover                  │
│       20d 60d 120d 250d        │                                                               │
├───────────────────────────────┴────────────────────────────────────────────────────────────────┤
│ SMILE (expiry ▾ Dec 18)   IV vs log-moneyness ln(K/F)   [strike | Δ | ln(K/F)]                  │
│   • OTM puts  • OTM calls  ○ excluded (hover for reason)   F = 251.30 (parity, 5 strikes)       │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Phase 1 ships the realized half (top line, cone and RV chart) with no options provider. The implied half lights up in Phase 2.

## 5. OMON: Option monitor (chain)

```
┌ AAPL · Options ── Spot 250.12 (Finnhub 15:59:58) · Quotes: Alpaca indicative · 15:58 ET ─ [↻] ┐
│ Expiry: [Nov 21 4d] [Nov 28 11d] [Dec 18 31d ●] [Jan 16] [Feb 20 ▲E] [Mar 20] … [All]       │
│ Show [±10 strikes ▾]  Columns [Standard ▾]  Filter: OI ≥ [100] spread ≤ [10%] Δ [0.05–0.95] │
├──────────────────── CALLS ─────────────────────┬───────┬──────────────────── PUTS ───────────┤
│  OI    Vol   Bid   Ask   IV    Δ     Γ    Θ/d  │ Strike│  Bid   Ask   IV    Δ     Γ    Θ/d  │
│ 12.1k  3.2k 9.80 10.05 27.1% .62  .021 −.09   │  245  │ 4.60  4.75 28.9% −.38 .021 −.08    │
│  8.4k  5.1k 6.95  7.10 27.6% .51  .023 −.10   │▸ 250 ◂│ 6.80  6.95 28.1% −.49 .023 −.09    │
│  9.9k  4.0k 4.60  4.70 27.9% .40  .022 −.09   │  255  │ 9.55  9.80 27.6% −.60 .022 −.08    │
│   ⚠ wide spread    ○ below intrinsic: no IV                                                    │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Selected: AAPL Dec18 250C  mid 7.025 · intrinsic 0.12 · extrinsic 6.91 · spread 2.1% of mid    │
│ IV 27.6% (ours, BSM on parity forward) · vendor 27.4% · Δ .51 Γ .023 ν .29 Θ −.10/day ρ .10   │
│ [Open in OSA] [Add leg] [Paper trade…] [Compare]                                               │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- Column presets: *Standard*, *Greeks* (Δ Γ ν Θ ρ), *Liquidity* (spread %, quote age, OI, Vol/OI), *Advanced* (vanna, charm, vomma, speed), *Moneyness* (K/S, K/F, ln(K/F), standardized, Δ-bucket).
- The ATM row is the strike nearest the **forward**, not spot.
- **Compare** opens a side-by-side table of up to four contracts with the same columns plus break-even, probability ITM (risk-neutral N(d2), labelled as such, not a forecast), and theta as % of extrinsic.
- With indicative quotes, the Liquidity preset is disabled with a one-line reason.

## 6. OSA: Strategy & scenario lab

The core learning and analysis surface. It works in Phase 1 with **theoretical** prices (the user enters IV or uses realized vol) and switches to market mids when chains exist. The price basis is always shown in the header.

```
┌ AAPL · Strategy lab ── Price basis: [Market mids (indicative 15:58) ▾ | Model @ IV | Model @ RV] ┐
│ Legs  +1 Dec18 250C @ 7.03    −1 Dec18 265C @ 2.11    [+ leg] [Templates ▾ spreads, straddle,  │
│                                                               collar, protective put, condor]   │
│ Net debit 4.92 ×100 = $492 · Max loss $492 · Max gain $1,008 · Break-even 254.92                │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ P&L vs underlying                       ─ at expiry  ┄ today  ┄┄ in [14] days   │ Greeks now   │
│  +$1k ┤                    ┌────────────                                         │ Δ  +0.32·100 │
│     0 ┼──────────────╱╱───┘                                                      │ Γ  +0.004    │
│  −$500┤──────────────┘           shaded: ±1σ implied move to horizon            │ ν  +$9/pt    │
│       └ 230   240   250   260   270                                              │ Θ  −$4/day   │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Sliders: Spot [250.12]  IV shift [+0 pts]  Days forward [0]  Rate [4.3%]  Skew [sticky strike ▾]│
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SCENARIO GRID  P&L ($) at [14 days]   rows: spot move   cols: IV change                        │
│            −10pt   −5pt    0     +5pt   +10pt                                                  │
│   −10%     −480   −470   −455   −440   −420                                                    │
│    −5%     −390   −360   −330   −300   −270                                                    │
│     0%     −120    −80    −40      0     40                                                    │
│    +5%      310    330    350    365    380                                                    │
│   +10%      640    630    620    610    600                                                    │
│  Full revaluation · BSM on parity forward · costs not included [include spread cost ☐]         │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ GREEKS CURVES  [Δ ▾] vs spot for [today, +14d, expiry]  ·  THETA DECAY  value vs days (ATM/OTM) │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- The scenario grid is the most useful single chart for options risk. It is shared with the Portfolio risk view (§9).
- The theta decay chart shows the extrinsic value of ATM, 10% OTM and 10% ITM contracts against days to expiry. Toggling between calendar and trading-day clocks shows the weekend convention explicitly.
- "Skew" selector: sticky strike (IV per strike fixed) vs sticky moneyness (smile moves with spot). The two give visibly different P&L away from spot, which is the point of offering both.

## 7. EVT: Events

```
┌ AAPL · Events ────────────────────────────────────────────────────────────────────────────────┐
│ Next: Earnings Jan 29 after close (Finnhub)  · first expiry after: Jan 30 (W) · Feb 20 (M)     │
│ Implied move  ±5.2% straddle (Jan 30)  ·  event-only ±4.4% from term structure (E) ⓘ          │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ HISTORY   implied (bar) vs realized (dot)  |move| %                                            │
│   8% ┤      •                                                                                  │
│   6% ┤  ▇   ▇      •   ▇                                                                       │
│   4% ┤  ▇ • ▇  ▇   ▇   ▇ •                                                                     │
│      └ Q1'26 Q2'26 Q3'26 Q4'26     implied available only where a pre-event snapshot exists   │
│ Realized > implied in 3 of 6 recorded events · median ratio 0.92 · n is small ⓘ               │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ IV CRUSH  (last event)  ATM IV of the event expiry: 41.0% → 26.3% (−14.7 pts)                  │
│ Long ATM straddle P&L decomposition, close-before → close-after                                │
│   Δ·dS  +$310   ½Γ·dS²  +$190   vega·dσ  −$420   θ·dt  −$35   residual  +$12   = +$57        │
│   The move was large enough to cover the IV drop: crush did not make this straddle lose.       │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Realized-move history (bars only) is available in Phase 1. Implied history accrues with the recorder or a paid backfill, and the gap is stated rather than hidden.

## 8. Volatility page (market level)

```
┌ Volatility ───────────────────────────────────────────────────────────────────────────────────┐
│ VIX 16.4 (FRED VIXCLS, Nov 14)  VIX3M 18.9  Ratio 0.87 contango  · 1y IV rank 22 · pct 31     │
│ Regime: Calm (VIX < 1y p40, contango)  ⓘ definition                                            │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ VIX vs SPY 21d realized (Yang–Zhang)  and VRP = VIX(t) − RV(t→t+21)   [2Y][5Y][Max]            │
│ Regime timeline (colour band): calm / elevated / stressed / inverted term structure            │
├───────────────────────────────┬────────────────────────────────────────────────────────────────┤
│ Term ratio VIX/VIX3M history   │ Cross-asset (your watchlist)  ATM IV 30d · RV 30d · IV−RV ·  │
│ inversions shaded              │ IV rank (n days) — sortable table                             │
├───────────────────────────────┴────────────────────────────────────────────────────────────────┤
│ Attribution: VIX and VIX3M © Cboe, retrieved from FRED                                         │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Phase 1 content is all FRED data plus existing SPY bars. The cross-asset table fills in as chains are recorded.

## 9. Portfolio risk (Portfolio → Risk tab)

```
┌ Portfolio · Risk ─────────────────────────────────────────────────────────────────────────────┐
│ Net Δ $ +41,200 (≈ 0.82 β-weighted SPY)  Γ $/1% +1,150  ν $/pt +380  Θ $/day −62  ρ $/pt +40  │
│ by underlying ▸ AAPL  Δ$ +18k  Γ +600 …   by expiry ▸ Dec  Jan  Feb                            │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SCENARIO GRID (whole book)  spot shock × vol shock × [horizon]   ▣ heatmap   [Crash presets ▾] │
│   Presets: −10% & +15pt · Mar-2020 analogue (SPY −34%, VIX 80) · rates +100bp                  │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ HEDGE IDEAS (analysis only; no orders)                                                         │
│  To flatten Δ: sell 165 SPY  · cost ≈ spread $8                                                │
│  Protective put  SPY Jan 520P ×2: cost $1,840 (1.8% of book) · P&L at −20%: book −$14k → −$6k  │
│  Collar  … · Put spread … — each with full-revaluation scenario rows                           │
│  [Open in hedging simulator]                                                                   │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Hedging simulator** (opens from here or from OSA): choose the position, a path source (historical window, bootstrap like RSK, GBM, jump-diffusion), a rebalance rule and costs; then run. Output: a P&L fan, cost vs tracking-error frontier across rebalance thresholds, and the gamma-theta decomposition. It is always labelled "Simulation · seed …".

The current "uniform asset-price shock" panel is replaced by the scenario grid once any option is held. For stock-only books it stays, but gains a vol-agnostic note.

## 10. Trade: options ticket

```
┌ Paper option order ── SIMULATION ─────────────────────────────────────────────┐
│ Contract  AAPL Dec18 250C   (from OMON / OSA)                                  │
│ Side [Buy to open ▾]  Qty [1] contracts ×100                                   │
│ Fill  [Ask 7.10 ▾ | Bid | Mid | Custom]   Slippage [0.02]   Fee/contract [0.65]│
│ Quote time 15:58 ET (indicative) ⚠ indicative quotes are not executable prices │
│ Cost $712 + $0.65 · Max loss $712.65 · Break-even 257.12                       │
│ Rationale [                                   ]                                │
│ [Place paper order]                                                            │
└────────────────────────────────────────────────────────────────────────────────┘
```

Multi-leg orders come from OSA's leg list as one atomic paper order. Short legs are allowed only when covered, cash-secured or inside a defined-risk spread (Phase 3; see Architecture §6). Naked shorts with simulated margin are a stretch goal after M3.

## 11. Integrations with existing features

| Existing feature | Integration |
|---|---|
| GP chart (`pricechart.js`) | Optional lower pane: RV 20d and ATM IV 30d; earnings markers; ±1σ implied-move cone from today to the selected expiry, labelled model |
| RSK (gs-quant) | Link "Compare to market-implied" when ATM IV exists: shows the bootstrap fan's 1-month band against the IV-implied lognormal band, a direct historical vs implied comparison |
| DES key statistics | ATM IV 30d, IV rank (with n), next earnings implied move |
| Screener | New columns (only for symbols with recorded chains): ATM IV, IV−RV, IV rank, 25Δ skew; workspace screener only |
| Watchlist | Optional IV column; the watchlist is also the default recorder list |
| Alerts | New conditions: ATM IV above/below, IV rank above/below, VIX/VIX3M > 1 |
| Aperture Analyst | Briefing facts with ids: `vol.atm30`, `vol.ivrank (n days)`, `evt.impliedMove`, `vol.vix`. The Analyst must quote the label class, e.g. "estimated" for GEX. Options figures go **only to the local model**. With an online account, the briefing omits Massive/Alpaca-derived figures and says why (Feasibility §10, rule 13) |
| Quant Lab | Vol-selling, event-study and hedging experiment types (Architecture §6) |
| HDS options tab | Rename the 13F statistic "13F put/call ratio (disclosed notional)" and link to OMON's exchange volume/OI put/call ratio to make the difference explicit |

## 12. Visualizations: keep or skip

| Visualization | Verdict | Why |
|---|---|---|
| Payoff at expiry + today + horizon | **Keep (P0)** | The single most informative option picture |
| Scenario P&L grid / heatmap (spot × vol) | **Keep (P0)** | Shows non-linearity and vega risk at once; the right replacement for the uniform shock |
| IV smile per expiry, ln(K/F) axis | **Keep (P1)** | Skew is the core equity-vol fact |
| IV term structure, with event humps | **Keep (P1)** | Directly readable; reveals event premia |
| IV vs RV with VRP shading | **Keep (P1)** | The core "is vol cheap" research chart |
| Volatility cone | **Keep (P1)** | Context for any IV number |
| Implied vs realized event moves | **Keep (P1)** | Tests a falsifiable claim per event |
| Greeks vs spot curves (3 horizons) | **Keep (P1)** | High learning value, cheap |
| Theta decay curves (ATM/OTM/ITM) | **Keep (P2)** | Teaches the √T shape and weekend clocks |
| OI by strike (calls/puts mirrored) | **Keep (P2)** | Observed data, low assumption |
| Estimated GEX by strike with convention band | **Keep, guarded (P3)** | Useful only with the assumption banner and sensitivity band |
| Regime timeline band | **Keep (P2)** | Cheap, and it anchors the time-series charts |
| Delta-hedge simulation fan + cost frontier | **Keep (P2)** | Best tool for teaching hedging costs |
| 3D volatility surface | **Skip as primary**; offer as an optional view in Phase 3 | It looks impressive but hides values. A smile-per-expiry small-multiples grid plus a heatmap of IV (strike-bucket × expiry) carries the same information legibly |
| Theta decay surface (3D) | **Skip** | The 2D curves say the same thing |
| Gamma flip as a single headline number | **Skip** | Implies false precision; show the profile and its range across conventions instead |

## 13. Background recorder (Settings → Reference data)

```
┌ Option chain recorder ────────────────────────────────────────────────────────────────────────┐
│ Background agent  ● Installed · runs every 30 min · captures after 16:15 ET on trading days     │
│ Last capture  Nov 17, 16:22 ET · 30 symbols · 71,840 contracts · 6.8 MB   Next: Nov 18          │
│ History  SPY 41 days · AAPL 41 days · NVDA 12 days … (gaps: Nov 3 — computer asleep)           │
│ Calls today  Alpaca 212 · Massive 1,860 (≤ 5/min, shared with the app's budget)                 │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Massive history backfill (free plan · 2-year window, moving daily)                              │
│ Tier 0 reference ██████████ 30/30   Tier 1 ATM ██████░░░░ 18/30   Tier 2 skew ░░░░ 0/30         │
│ Tier 3 earnings ░░░░ 0/30   About 31 h left at 4.6 calls/min · resumes after restarts           │
│ [Pause] [Delete all Massive data]   Backfilled values are trade prints, not quotes: shown dashed│
│ [View log]  [Remove background agent]   Keep full chains for [90 days ▾]  Summaries: forever    │
│ What it does: reads option quotes from your Alpaca account (read-only, never places orders),    │
│ computes IV and Greeks on this computer, and saves them here. Nothing is uploaded or shared.    │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Before the agent is installed, the panel explains the same thing and offers **Install background agent**. The in-app recorder is used meanwhile, and captures are tagged by which one made them.

## 14. Labelling rules (UI copy)

- Header badge per view: `Observed · Alpaca indicative · 15:58 ET` / `Model · BSM on parity forward` / `Simulation · seed 2148…`.
- IV rank and percentile always show **n days of history**. With fewer than 252 days: "IV rank needs a year of history; 41 days recorded."
- Probabilities from N(d2) are "risk-neutral probability", never "chance".
- GEX: "Estimated from open interest under an assumed dealer side. Dealer positions are not public."
- Demo mode: a synthetic chain with the same "Demo data · synthetic" tag used for prices today.
- Exports of recorded data: "For your own research. Check the data provider's terms before sharing." (Feasibility §10).
- Site screenshots and demo captures use demo data only.
