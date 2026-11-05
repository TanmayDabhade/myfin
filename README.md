# Market Lens Desktop

A local-first financial research and paper-trading application built with **Tauri 2, Rust, SQLite, and a lightweight Vite/JavaScript interface**. There is no Electron runtime or hosted backend. All trades are simulations.

## Start on macOS

Install Node.js 22 or later, Rust stable, and the Xcode command-line tools (`xcode-select --install`). Use the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. Then open Terminal in this project:

```sh
npm ci
npm run tauri dev
```

This starts the actual native desktop window. `npm run dev` alone starts a browser preview with localStorage persistence; provider connections are disabled in browser preview.

Create an application and installer on your Mac:

```sh
npm run tauri build
```

Outputs are under `src-tauri/target/release/bundle/`. Building on an Intel Mac produces an Intel application; Apple Silicon produces ARM unless a target is specified. A macOS installer must be built on macOS. This source archive does not contain a signed or notarized macOS application.

Windows requires Microsoft C++ Build Tools and WebView2. Linux requires WebKitGTK 4.1 development libraries, GTK, librsvg, libayatana-appindicator and patchelf. See the official prerequisites linked above. The GitHub Actions workflow builds packages on all three operating systems when this project is put in your repository; it has not been run for you.

## First session

1. Explore the **Sample workspace**. Its prices, financial ratios, and companies' numeric data are synthetic demonstrations, not historical observations.
2. Select **My market data**. It starts empty and has its own paper account.
3. In **Settings**, enter your Alpha Vantage and/or FRED API keys. Keys live in Rust memory until the app exits. Alternatively set `ALPHA_VANTAGE_API_KEY` and `FRED_API_KEY` before starting the app.
4. Enter a symbol and download daily prices, or import an OHLCV CSV you have permission to use. Imports require `date,open,high,low,close`, with optional `volume`; dates use YYYY-MM-DD. The interface and portfolio assume USD.
5. Open **Research** to download company overview, financial statements, company news and the earnings calendar. Each is a separate user-initiated request. The free plan may not include every endpoint.
6. Use **Trade** to record manual simulated fills. The initial fill price is the last available daily close, not a real-time quote. Enter a different fill to simulate slippage, and include fees. Trades must be chronological and cannot exceed available paper cash or shares.
7. Export a full JSON backup periodically. CSV and chart SVG exports use the OS save dialog in the desktop app.

## Implemented workflows

| Workspace | Features |
|---|---|
| Overview | Asset lookup, saved watchlist, daily changes, local-universe movers, performance heatmap |
| Research | Candlestick/line chart, volume, hover inspection, wheel zoom, time ranges, MA20/MA50, normalized comparison overlay, chart SVG export, source/date labels, company profile, ratios, annual/quarterly statements, linked news, earnings calendar, dividend metadata, EDGAR link, saved thesis |
| Trade | Buy/sell beside chart, fractional shares, fees, manual slippage, rationale, execution markers, chronological ledger, cash/position checks, separate demo/market accounts, CSV journal |
| Portfolio | Holdings, average cost, cash, realized/unrealized P&L, allocation, historical paper-equity curve, volatility, drawdown, per-asset Sharpe, correlation matrix, uniform price-shock scenario, benchmark context, position export |
| Screener | Local-universe P/E, growth and sector filters, saved screens, result export, peer comparison |
| Valuation | Five-year unlevered DCF, bear/base/bull cases, terminal growth, net debt, diluted shares, discount/growth sensitivity, model export |
| Economy | FRED CPI, unemployment, policy rate, 2Y/10Y Treasury yields and real GDP, source links and history charts |
| Alerts | Persistent above/below price conditions; latching status; reevaluated on workspace load and stored-data changes |
| Settings | Session-only keys, CSV imports, starting cash, JSON backup/restore, data policy and source links |

## Architecture and data handling

- Rust handles provider HTTP requests, request accounting, response caching, native exports, and SQLite persistence.
- Native paper trades are validated in Rust and appended within a SQLite transaction. The browser preview uses the tested JavaScript counterpart.
- Analytics/chart rendering use small pure JavaScript functions. Rust is used for native operations and the trade execution boundary; this is not a claim that every calculation runs in Rust.
- SQLite uses WAL mode. Tables contain the versioned workspace, raw response cache, and request timestamps. The database is in the OS application-data directory for `com.marketlens.desktop`.
- API keys are never put in localStorage, SQLite, JSON backups, or log messages. They are sent only to fixed HTTPS provider endpoints. Requests have a 20-second timeout and do not follow redirects.
- Alpha Vantage is limited locally to 25 requests per rolling 24 hours with at least 13 seconds between requests. Failed calls consume the local budget. The provider can impose stricter limits. The cache TTL is six hours; network/provider failures can return explicitly stale cached responses.
- No background scraping, proxy rotation, key sharing, paywall bypass or quota evasion.
- Source provenance and dates are visible. Missing ratios display “—”; absence is not zero. CSV imports are attributed to the user-specified source.

## Data providers and usage rights

Use your own keys and comply with the provider and underlying exchange/series owners' terms. “Free to access” does not imply permission to redistribute. This application is designed for personal research; the code cannot guarantee legal clearance for commercial deployment or redistribution of data.

- [Alpha Vantage documentation](https://www.alphavantage.co/documentation/), [free key](https://www.alphavantage.co/support/#api-key), [terms](https://www.alphavantage.co/terms_of_service/)
- [FRED API keys](https://fred.stlouisfed.org/docs/api/api_key.html), [observations API](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), [terms](https://fred.stlouisfed.org/docs/api/terms_of_use.html)
- [SEC EDGAR search](https://www.sec.gov/edgar/search/)

Provider documentation consulted November 5, 2026. No paid subscriptions are required to use offline imports, analytics, or paper trading. API account entitlement determines online coverage; there is no guaranteed-free substitute for restricted real-time data.

## Calculation definitions

- Portfolio mark = cash + shares × latest stored close. Missing marks fall back to remaining cost basis and are flagged. Average-cost realized gains include both purchase and sale fees. This is not tax-lot accounting.
- Equity history reconstructs the trade ledger through each stored date, using only marks available by that date. Prices for missing dates carry forward; missing series fall back to cost basis. The account has fixed starting cash and no external flows.
- Risk uses arithmetic daily close returns, sample standard deviation, 252 observations/year, and a 4% annual risk-free assumption for Sharpe. Drawdown measures close-to-prior-peak decline. Correlations align daily return observations by date and require at least three pairs. Sparse/irregular imported series violate the daily-frequency assumption.
- Benchmark cards show the benchmark's own available-data window and explicitly do not claim matched-window excess returns.
- DCF discounts five forecast annual cash flows plus a Gordon-growth terminal value. Net debt is subtracted from enterprise value. Discount rate must exceed terminal growth. All monetary assumptions must use the same units; shares must be in matching millions.
- Data is unadjusted unless adjusted OHLC is supplied through CSV. Splits, dividends and other corporate actions are not automatically applied to holdings or returns.

## Verification

```sh
npm test                       # calculation/import tests
npx playwright install chromium
npm run test:e2e               # standalone browser workflow smoke test
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib
npm run build
npm run tauri build
```

See `VALIDATION.md` for the checks actually executed in the build environment and their limitations. Core Rust tests intentionally do not require desktop libraries; they test the same ledger module used by the desktop command. Browser tests do not validate the native IPC bridge or OS dialogs.

## Current boundaries

This is a substantial first implementation of the requested release and analysis workflows, not a complete Bloomberg replacement. Specific gaps are explicit:

- No live quotes, live orders, options chains, futures, multi-currency accounting, automatic dividends/splits, tax reports, or automatic brokerage import.
- No whole-market fundamentals database: the screener covers downloaded companies only. Free daily history depth is determined by your provider plan.
- Price alerts run when the app reads/updates stored data; no daemon, email, push notifications or monitoring while closed.
- News and earnings calendars need provider entitlement. Economic-release calendars, earnings-call transcript search, comprehensive dividend calendars, full-text filings, drawing tools, automated adjusted total returns, and native multi-workspace layouts are not implemented.
- Only CSV price imports and full-workspace JSON restore are supported; broker-specific transaction import is not included.
- No paid-feed workaround is represented as legally safe. An API denial is displayed, not bypassed.
- Keys must be reentered each launch unless provided as environment variables. Database/backups are local plaintext and rely on your OS account protection; no encryption-at-rest claim is made.

## Project map

- `src/main.js`: UI/workflows and chart rendering
- `src/engine.js`: pure analytics, validation, imports and preview accounting
- `src/sample.js`: deterministic synthetic demonstration data
- `src/bridge.js`: native/browser storage and provider boundary
- `src-tauri/src/main.rs`: native commands, SQLite, HTTP/cache/quota and exports
- `src-tauri/src/ledger.rs`: native order validation
- `tests/`: numerical/import regression tests
- `scripts/smoke.cjs`: executable browser workflow test
- `.github/workflows/build.yml`: desktop package CI
# myfin
