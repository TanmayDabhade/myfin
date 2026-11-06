# Market Lens Desktop

A local-first financial research and paper-trading application built with **Tauri 2, Rust, SQLite, and a lightweight Vite/JavaScript interface**. There is no Electron runtime or hosted backend. All trades are simulations.

## Install and update with Homebrew (preview channel)

Available after the release workflow is merged and the first eligible PR build publishes:

```sh
brew tap tanmaydabhade/myfin https://github.com/TanmayDabhade/myfin.git
brew install --cask tanmaydabhade/myfin/market-lens-preview
```

To replace the installed app with the newer build:

```sh
brew update
brew upgrade --cask tanmaydabhade/myfin/market-lens-preview
```

The cask uses versioned, checksum-verified universal Mac builds. These are unsigned/unnotarized previews of individual PRs. See [release behavior, activation, and install-or-upgrade command](docs/RELEASES.md). Windows and Linux installers are attached to each successful PR prerelease.

## Start on macOS

Install Node.js 22 or later, Rust stable, and the Xcode command-line tools (`xcode-select --install`). Use the official [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS. Then open Terminal in this project:

```sh
npm ci
npm run tauri dev
```

This starts the actual native desktop window. `npm run dev` alone starts a browser preview with demo data only; live data needs the desktop app.

Create an application and installer on your Mac:

```sh
npm run tauri build
```

Outputs are under `src-tauri/target/release/bundle/`. Building on an Intel Mac produces an Intel application; Apple Silicon produces ARM unless a target is specified. A macOS installer must be built on macOS. This source archive does not contain a signed or notarized macOS application.

Windows requires Microsoft C++ Build Tools and WebView2. Linux requires WebKitGTK 4.1 development libraries, GTK, librsvg, libayatana-appindicator and patchelf. See the official prerequisites linked above. The GitHub Actions workflow builds packages on all three operating systems when this project is put in your repository; it has not been run for you.

## First session

1. Launch the app. The first screen asks for your free API keys:
   - **Twelve Data**: daily prices with about 5 years of history (800 requests/day). [Get a key](https://twelvedata.com/register)
   - **Alpha Vantage**: company profile, statements, news, earnings calendar (25 requests/day). [Get a key](https://www.alphavantage.co/support/#api-key)
   - **FRED**: US economic series. [Get a key](https://fredaccount.stlouisfed.org/apikeys)

   - **AISStream** (optional): live vessel positions on the Commodities page. [Get a key](https://aisstream.io/authenticate)
   - **SEC EDGAR** (optional contact email): filing lists and revenue history load with no key; adding your email also lets the app read 10-K text to find suppliers and customers. SEC asks automated tools to declare a contact; it is sent only to sec.gov.

   One key is enough to start. Choose where prices come from and press **Connect and load data**.
2. That's it. Your watchlist loads right away and refreshes every 30 minutes while the app is open. Type any ticker in the search box (or the watchlist's **Add** field) and it is pulled from your price source.
3. **Research** loads the company profile, financial statements and news automatically for the selected ticker. **Economy** loads all six FRED series, and **Commodities** loads IMF PortWatch shipping activity, which needs no key.
4. Keys are saved once, in `credentials.json` in the app-data folder with owner-only file permissions. Change or remove them in **Settings → Data sources**, where each provider's last error is also shown. `TWELVE_DATA_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `FRED_API_KEY`, `AISSTREAM_API_KEY` and `SEC_CONTACT_EMAIL` environment variables override saved values.
5. **Demo data** (top-right switch) is a synthetic workspace with its own paper account. Use it to explore without keys.
6. Use **Trade** to record simulated fills at the last daily close or your own price, including fees.

## Commodities and shipping

- **Commodity prices**: WTI and Brent crude, Henry Hub natural gas, US gasoline and copper from FRED (series DCOILWTICO, DCOILBRENTEU, DHHNGSP, GASREGW, PCOPPUSDM), loaded automatically with your FRED key.
- **Port and chokepoint activity**: IMF PortWatch daily counts (no key).
- **Live vessels**: with an AISStream key, the app streams AIS positions within about 1° of the selected location while the Commodities page is open, and stops when you leave. Vessels are classed from their broadcast ship type (70–79 cargo, 80–89 tanker); a tanker class describes the hull, not its cargo or load. At most 2,000 vessels are kept, for 2 hours. The connection reconnects with exponential backoff and jitter, and stops for good if AISStream rejects the key. The key is only sent inside the encrypted subscription message and never reaches the UI.

## SEC filing discovery

- **Research → SEC filings** lists recent 10-K, 10-Q, 8-K and similar filings with links, plus annual revenue and year-over-year growth from XBRL company facts (latest restatement per period). No key needed. The company's CIK comes from Alpha Vantage, the relationship graph or SEC's company list.
- **Relationships → Find suppliers & customers** reads the two latest annual reports, resolves company names against SEC's company list and graph aliases (legal suffixes ignored; one-word names need a legal suffix in the sentence), and adds sentences with supplier or customer wording as **unreviewed** candidates dated to the filing. Revenue concentration is stored only when the same sentence discloses it. The panel compares the two reports: counterparties new this year and no longer mentioned.
- Candidates never become reviewed automatically; use **Mark source reviewed** after reading the filing.

## Implemented workflows

| Workspace | Features |
|---|---|
| Overview | Asset lookup, saved watchlist, daily changes, local-universe movers, performance heatmap |
| Research | Candlestick/line chart, volume, hover inspection, wheel zoom, time ranges, MA20/MA50, normalized comparison overlay, chart SVG export, source/date labels, company profile, ratios, annual/quarterly statements, linked news, earnings calendar, dividend metadata, EDGAR link, saved thesis |
| Trade | Buy/sell beside chart, fractional shares, fees, manual slippage, rationale, execution markers, chronological ledger, cash/position checks, separate demo/market accounts, CSV journal |
| Portfolio | Holdings, average cost, cash, realized/unrealized P&L, allocation, historical paper-equity curve, volatility, drawdown, per-asset Sharpe, correlation matrix, uniform price-shock scenario, benchmark context, position export |
| Screener | Local-universe P/E, growth and sector filters, saved screens, result export, peer comparison |
| Valuation | Five-year unlevered DCF, bear/base/bull cases, terminal growth, net debt, diluted shares, discount/growth sensitivity, model export |
| Economy | FRED CPI, unemployment, policy rate, 2Y/10Y Treasury yields and real GDP, loaded automatically, with source links and history charts |
| Alerts | Persistent above/below price conditions; latching status; reevaluated on workspace load and stored-data changes |
| Settings | Saved provider keys, price-source choice, sync status and last errors, starting cash, JSON backup (restore under Advanced) |

## Architecture and data handling

- Rust handles provider HTTP requests, request accounting, response caching, native exports, and SQLite persistence.
- Native paper trades are validated in Rust and appended within a SQLite transaction. The browser preview uses the tested JavaScript counterpart.
- Analytics/chart rendering use small pure JavaScript functions. Rust is used for native operations and the trade execution boundary; this is not a claim that every calculation runs in Rust.
- SQLite uses WAL mode. Tables contain the versioned workspace, raw response cache, and request timestamps. The database is in the OS application-data directory for `com.marketlens.desktop`.
- API keys are stored only in `credentials.json` (owner-only permissions) in the app-data folder, never in localStorage, SQLite, JSON backups or log messages. Provider error messages are shown with any key text masked. Keys are sent only to fixed HTTPS provider endpoints. Requests have a 20-second timeout and do not follow redirects.
- Free-plan limits are enforced locally and requests are queued rather than rejected: Alpha Vantage 25/day, 13 s apart, reused for 6 h; Twelve Data 800/day, 8 s apart, reused for 1 h; FRED reused for 12 h. Failed calls count toward the budget. When a provider fails or the daily budget is spent, saved data is shown and marked stale.
- IMF PortWatch's ArcGIS host intermittently rejects valid queries (observed November 2026); the app retries up to six times with backoff.
- Data loads automatically only from your own provider accounts and public APIs, within their free limits. No scraping, proxy rotation, key sharing, paywall bypass or quota evasion.
- Source provenance and dates are visible. Missing ratios display “—”; absence is not zero. Every price series is labeled with its provider.

## Data providers and usage rights

Use your own keys and comply with the provider and underlying exchange/series owners' terms. “Free to access” does not imply permission to redistribute. This application is designed for personal research; the code cannot guarantee legal clearance for commercial deployment or redistribution of data.

- [Twelve Data documentation](https://twelvedata.com/docs), [terms](https://twelvedata.com/terms)
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
- No file uploads apart from restoring a full JSON backup (Settings → Advanced); broker-specific transaction import is not included.
- No paid-feed workaround is represented as legally safe. An API denial is displayed, not bypassed.
- Saved keys, database and backups are local plaintext protected by your OS account; no encryption-at-rest claim is made.

## Project map

- `src/main.js`: UI/workflows and chart rendering
- `src/engine.js`: pure analytics, validation, imports and preview accounting
- `src/sample.js`: deterministic synthetic demonstration data
- `src/bridge.js`: native/browser storage and provider boundary
- `src/sources.js`: provider catalog, price-source choice and Twelve Data normalization
- `src-tauri/src/providers.rs`: saved keys, free-plan budgets, request building and provider error handling
- `src-tauri/src/main.rs`: native commands, SQLite, HTTP/cache/quota and exports
- `src-tauri/src/ledger.rs`: native order validation
- `tests/`: numerical/import regression tests
- `scripts/smoke.cjs`: executable browser workflow test
- `.github/workflows/build.yml`: desktop package CI
# myfin
