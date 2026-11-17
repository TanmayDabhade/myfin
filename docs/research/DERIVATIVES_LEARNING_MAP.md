# Derivatives & Volatility — Learning Map

How the concepts fit together, the mathematics each one needs, and which Aperture feature lets you test it on real data. Written 2026-11-17. Feature codes refer to [Product Design](DERIVATIVES_PRODUCT_DESIGN.md); phases to the [Roadmap](DERIVATIVES_ROADMAP.md).

## 1. Concept graph

```
                 Returns & log returns ──► Realized volatility (estimators, clustering, regimes)
                          │                               │
                          ▼                               ▼
      Lognormal model / GBM ──► Black–Scholes–Merton ◄── Implied volatility (inversion)
            │                      │        │                   │
            │                      │        ▼                   ├─► Smile / skew (by strike)
            │                      │     Greeks ─┬─ Δ ─► hedge ratio ─► Delta hedging ─► gamma–theta P&L
            │                      │             ├─ Γ ─► convexity, rebalancing cost, GEX (estimated)
            │                      │             ├─ Θ ─► time decay, weekend clock
            │                      │             ├─ ν ─► vol exposure, IV crush
            │                      │             └─ ρ ─► rates, forwards
            │                      ▼                            ├─► Term structure ─► event variance, implied move
            │        Forward, put–call parity, dividends        │
            │                      │                            ▼
            ▼                      ▼                    IV − future RV = Volatility risk premium ─► option-selling returns
   Monte Carlo / bootstrap ──► Scenario & stress testing ──► Portfolio Greeks ─► tail hedging (puts, collars, spreads)
```

## 2. Concepts, maths and the experiment that tests each one

### 2.1 Returns and realized volatility
- **Idea:** volatility is the standard deviation of log returns, scaled by √(periods per year). Daily OHLC holds more information than closes alone.
- **Maths:** r_t = ln(C_t/C_{t−1}); σ̂ = √(252/(n−1) Σ(r − r̄)²). Range estimators (Parkinson: σ² = (1/(4 ln 2))·E[ln(H/L)²]), Garman–Klass, Rogers–Satchell, Yang–Zhang (a weighted sum of overnight, open-to-close and RS variances). Annualization assumes i.i.d. returns, which volatility clustering violates.
- **Explore in Aperture:** `VOL` estimator switch. Compare the estimators on the same stock: how far do they differ in calm vs stressed months? The vol cone shows where today's 20-day RV sits in its own history.
- **Hypothesis to test:** *Volatility clusters.* Correlate |r_t| with |r_{t−k}| for k = 1…20 (an ACF of absolute returns). It is positive and slowly decaying, while the ACF of raw returns is near zero. RSK's daily-move histogram already shows the fat tails.

### 2.2 Black–Scholes–Merton and the forward
- **Idea:** with continuous hedging and lognormal prices, an option has one arbitrage-free price given σ. All other inputs are observable.
- **Maths:** C = S e^{−qT}N(d1) − K e^{−rT}N(d2); d1 = [ln(S/K) + (r − q + σ²/2)T]/(σ√T), d2 = d1 − σ√T. Put–call parity: C − P = S e^{−qT} − K e^{−rT}, equivalently = e^{−rT}(F − K). Black-76 is the same formula written on F. American options add the early-exercise premium (binomial trees; calls on dividend payers before ex-date, deep ITM puts).
- **Explore:** `OSA` theoretical mode. Change one input at a time. Check that parity holds on a real chain in `OMON`: the parity residual is a quality flag, and its size shows how far quotes are from frictionless.
- **Hypothesis:** *Dividends lower call values and raise put values via the forward.* Compare the parity-implied forward with spot·e^{(r)T} before an ex-dividend date.

### 2.3 Implied volatility
- **Idea:** IV is the σ that makes the model price equal to the market price. It is a quoting convention, not a forecast and not a measured quantity.
- **Maths:** solve f(σ) = BSM(σ) − P_mkt = 0; Newton step σ ← σ − f/ν. No solution exists if the price is below intrinsic or above the upper bound. Use the mid, and treat the bid/ask IVs as the uncertainty band.
- **Explore:** `OMON` shows our IV against the vendor's. Wide-spread contracts show large bid-IV/ask-IV bands; that band is the honest error bar.
- **Hypothesis:** *IV is not constant across strikes* (Black–Scholes is wrong in a structured way). This leads to the smile.

### 2.4 Smile, skew and term structure
- **Idea:** equity IV is higher for low strikes (crash fear, leverage effect), and it varies by expiry; events show up as humps.
- **Maths:** log-moneyness k = ln(K/F); total variance w(k, T) = σ²T. No-arbitrage: w increases in T at fixed k (calendar), and call prices are convex in K (butterfly). SVI parameterizes w(k) per expiry. Forward variance between T1 and T2 is (w2 − w1)/(T2 − T1).
- **Explore:** `VOL` smile and term charts; small multiples across expiries (Phase 4).
- **Hypothesis:** *Skew steepens when the market falls.* Correlate the daily change in 25Δ risk reversal with the SPY return, using `daily_summary` once recorded.

### 2.5 Greeks
| Greek | Meaning | Formula (BSM call, q) | Intuition to test in `OSA` |
|---|---|---|---|
| Δ | ∂V/∂S | e^{−qT}N(d1) | Δ approaches a step function as expiry nears |
| Γ | ∂²V/∂S² | e^{−qT}φ(d1)/(Sσ√T) | ATM gamma explodes near expiry; that is why 0DTE options behave like lottery tickets |
| Θ | ∂V/∂t | −Sφ(d1)σe^{−qT}/(2√T) − rKe^{−rT}N(d2) + qSe^{−qT}N(d1) | ATM extrinsic value decays roughly like √T, so most of it is lost in the final weeks |
| ν | ∂V/∂σ | S e^{−qT}φ(d1)√T | Long-dated options carry more vega; IV crush hits short-dated event options in vol points, and long-dated ones in dollars per point |
| ρ | ∂V/∂r | KTe^{−rT}N(d2) | Negligible for 1-month options, material for LEAPS |
| Vanna | ∂Δ/∂σ | −e^{−qT}φ(d1)d2/σ | Why delta changes when IV moves without spot moving |
| Charm | ∂Δ/∂t | (closed form) | Delta drift into the weekend or expiry |
| Vomma | ∂ν/∂σ | ν·d1·d2/σ | Wing options gain vega as vol rises |
| Speed | ∂Γ/∂S | −Γ(1 + d1/(σ√T))/S | How quickly gamma hedging needs change |

- **Key relation (the "one equation" of options):** Θ + ½σ²S²Γ + (r − q)SΔ − rV = 0. For a delta-hedged position, the daily P&L ≈ ½Γ S²(σ²_realized − σ²_implied)·dt. **Long gamma earns when realized vol exceeds implied; theta is what you pay for that.** Every hedging and VRP experiment below is a test of this one line.

### 2.6 Delta hedging and hedging costs
- **Idea:** a hedged option's P&L depends on the *path's* realized variance against the implied variance, plus discrete-hedging error and costs.
- **Maths:** hedging error std ≈ √(π/4)·σ·ν/√N with N = T/Δt rebalances (Derman–Kamal; see also Boyle–Emanuel); it shrinks like √Δt while transaction costs grow like 1/√Δt, so an optimal rebalancing band exists (Leland's adjusted volatility, Whalley–Wilmott bands).
- **Explore:** the hedging simulator. Run GBM paths at rebalance intervals of 1, 2, 5 and 10 days, then switch to jump paths. Plot cost against tracking error. Then replay a real historical window from the workspace bars.
- **Hypothesis:** *Hedging can't remove gap risk.* Under the jump-diffusion setting, the P&L tail of a short-gamma hedged book stays fat regardless of rebalance frequency.

### 2.7 Volatility risk premium and option selling
- **Idea:** implied vol has historically exceeded subsequent realized vol on average for equity indices. Sellers earn a premium for bearing crash risk; the premium arrives in small amounts and losses come in large ones.
- **Maths:** VRP_t = IV_t(30d) − RV_{t→t+21}. Use variance (σ²) for additive comparisons. The ex-post VRP at t is known only at t + 21, the look-ahead trap.
- **Explore:** the Volatility page's VIX vs SPY RV chart (Phase 1, real data back to 1990); then the Quant Lab vol-selling study (Phase 4) with bid/ask fills, fees and a sealed holdout.
- **Hypothesis:** *VRP is positive on average but the short-straddle return distribution has negative skew and a fat left tail.* Report the mean, median, worst month, skew and the share of P&L lost in the worst 5% of months. Then add costs and see how much survives.

### 2.8 Events, implied moves and IV crush
- **Idea:** scheduled events add a lump of variance to the expiries that include them. After the event, that variance is gone, which is IV crush.
- **Maths:** w(T) = σ²_base·T + E; implied move ≈ √E; straddle ≈ 0.8·S·σ√T (from √(2/π)). Value change across the event ≈ Δ·dS + ½Γ·dS² + ν·dσ + Θ·dt + residual. Compute it exactly with sequential revaluation, attributing each input change in turn.
- **Explore:** `EVT` (implied vs realized history; the crush decomposition for the last event).
- **Hypothesis:** *Options over-price earnings moves on average for large caps.* Compare the median ratio realized/implied over recorded events, with sample size and a confidence interval. **Counter-check:** a long straddle can still profit through crush when |move| > implied move; the decomposition makes that visible per event.

### 2.9 Gamma exposure (estimated)
- **Idea:** if dealers are net long gamma, their hedging dampens moves; if net short, it amplifies them. Public data shows open interest but not who holds which side.
- **Maths:** GEX_strike = Σ OI·Γ·m·S²·0.01·sign(convention); the profile over a spot grid; the "flip" is the zero crossing.
- **Explore:** `GEX` (Phase 5), always with two or three conventions shown together.
- **Hypothesis to test critically:** *Days that start with estimated positive GEX have lower subsequent realized intraday range.* Test it on recorded history with a holdout. Expect weak or convention-dependent results; finding that the sign assumption drives the conclusion is itself the lesson.

### 2.10 Portfolio risk and tail hedging
- **Idea:** option books are non-linear. Risk is a surface over spot, vol and time, not a single number.
- **Maths:** full revaluation; β-weighted delta Δ_SPY = Σ Δ_i·S_i·β_i / S_SPY; scenario analysis vs VaR (and why VaR on option books via delta-normal is wrong).
- **Explore:** Portfolio → Risk scenario grid and crash presets; compare protective puts, put spreads and collars by cost and payoff at −10/−20/−35%.
- **Hypothesis:** *Put spreads give most of the protection for moderate crashes at a fraction of the cost, but fail in true tail events.* The scenario rows show exactly where each hedge stops working.

## 3. Learning path

| Stage | Concepts | Aperture feature | Available |
|---|---|---|---|
| 1 | Returns, RV estimators, clustering, regimes | VOL (realized), Volatility page, RSK | M1 |
| 2 | BSM, parity, forwards, payoff, Greeks shapes, theta clock | OSA theoretical | M1 |
| 3 | IV inversion, smile, term structure, liquidity | OMON, VOL implied | M2 |
| 4 | Hedging: gamma–theta, costs, jumps | Hedging simulator | M3 |
| 5 | Portfolio non-linearity, tail hedges | Portfolio Risk | M3 |
| 6 | VRP and option selling | Volatility page (index, now), Quant Lab vol-selling study | M1 (index) / Phase 4 |
| 7 | Events and IV crush | EVT | Phase 4 (needs recorded events) |
| 8 | Dealer gamma, critically | GEX | Phase 5 |

## 4. Reproducibility rules (inherited from Quant Lab)

- Every study names its data snapshot hashes, model version, seed and assumptions, and exports a manifest.
- No study uses information dated after its decision time. VRP and realized moves are marked "known at t + h".
- Costs are on by default: bid/ask fills, per-contract fees, slippage.
- Small samples are labelled "not statistically informative", using the same rule as Quant Lab's minimum-trades threshold.
- A finding on one hand-picked symbol is flagged as survivorship-biased, as Quant Lab does today.

## 5. Recommended reading (standard references, not verified for current editions)

- J. Hull, *Options, Futures, and Other Derivatives*: the source for M1 reference values.
- E. G. Haug, *The Complete Guide to Option Pricing Formulas*: closed forms for Greeks, Black-76, binomial variants.
- J. Gatheral, *The Volatility Surface*: SVI, arbitrage conditions, skew dynamics.
- E. Sinclair, *Volatility Trading* and *Positional Option Trading*: VRP, hedging, event trading in practice.
- C. Bennett, *Trading Volatility*: skew, term structure, dispersion; practitioner conventions.
- Cboe VIX white paper; NSE India VIX methodology document: variance-swap index construction.
