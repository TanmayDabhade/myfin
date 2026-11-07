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
   - **Finnhub**: real-time US trades, company news, key metrics, company profile and the earnings calendar (60 requests/minute). [Get a key](https://finnhub.io/register)
   - **Alpha Vantage**: financial statements and the company description (25 requests/day; its news endpoint is premium, so news comes from Finnhub). [Get a key](https://www.alphavantage.co/support/#api-key)
   - **Alpaca** (optional, key ID and secret): the last session's trade prints for time and sales when the market is closed. [Sign up](https://app.alpaca.markets/signup)
   - **FRED**: US economic series. [Get a key](https://fredaccount.stlouisfed.org/apikeys)

   - **AISStream** (optional): live vessel positions on the Commodities page. [Get a key](https://aisstream.io/authenticate)
   - **SEC EDGAR** (optional contact email): filing lists and revenue history load with no key; adding your email also starts the 13F holders download and lets the app read 10-K text, 13D/G and Form 4 filings. SEC asks automated tools to declare a contact; it is sent only to sec.gov.

   One key is enough to start. Choose where prices come from and press **Connect and load data**.
2. That's it. Your watchlist loads right away and refreshes every 30 minutes while the app is open. Type any ticker in the search box (or the watchlist's **Add** field) and it is pulled from your price source.
3. Click any stock (watchlist, search, Universe) to open its **stock page**: a grid of panels for that one stock, loaded automatically. See [The stock page](#the-stock-page). **Economy** loads all six FRED series, and **Commodities** loads FRED commodity prices and, with an AISStream key, a live vessel map.
4. Keys are saved once, in `credentials.json` in the app-data folder with owner-only file permissions. Change or remove them in **Settings → Data sources**, where each provider's last error is also shown. `TWELVE_DATA_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `FRED_API_KEY`, `AISSTREAM_API_KEY` and `SEC_CONTACT_EMAIL` environment variables override saved values.
5. **Demo data** (top-right switch) is a synthetic workspace with its own paper account. Use it to explore without keys.
6. Use **Trade** to record simulated fills at the last daily close or your own price, including fees.

## Commodities and shipping

- **Commodity prices**: WTI and Brent crude, Henry Hub natural gas, US gasoline and copper from FRED (series DCOILWTICO, DCOILBRENTEU, DHHNGSP, GASREGW, PCOPPUSDM), loaded automatically with your FRED key.
- **Live vessels**: with an AISStream key, the app streams AIS positions within about 1° of the selected port or chokepoint while the Commodities page is open, on a zoomable map (Leaflet, Esri dark gray tiles; no tile key needed). Moving ships point along their course and are coloured by class; click a table row to find the ship, or another location marker to move there. The stream stops when you leave the page. Vessels are classed from their broadcast ship type (70–79 cargo, 80–89 tanker); a tanker class describes the hull, not its cargo or load. At most 2,000 vessels are kept, for 2 hours. The connection reconnects with exponential backoff and jitter, and stops for good if AISStream rejects the key. The key is only sent inside the encrypted subscription message and never reaches the UI.

## The stock page

Load a stock once and every view follows it. Type a ticker in the sidebar search, or click one in the watchlist, heatmap, Universe or a fund's portfolio. The stock page opens with a grid of panels, each a summary of one function:

| Panel | Code | Full view |
|---|---|---|
| Description | `DES` | Profile, key statistics, risk metrics, research journal, earnings (reported and upcoming, EPS and revenue vs estimates) |
| Chart | `GP` | Candles or line, ranges, MA20/MA50, comparison overlay, SVG export |
| Financials | `FA` | Annual/quarterly statements (Alpha Vantage) and SEC revenue history |
| News | `CN` | Company news from the last 7 days with summaries (Finnhub) |
| Holders | `HDS` | Everything under [Holders (HDS)](#holders-hds) |
| Ownership changes | `OWN` | One dated list of disclosed changes: the largest 13F fund moves last quarter, each 5%+ owner's latest 13D/G, insiders' open-market Form 4 buys and sales |
| Suppliers & customers | `SPLC` (or `RELS`) | The relationship explorer, centred on the stock |
| Valuation | `DCF` | Five-year DCF pre-filled from the company's SEC filings (cash flow − capital spending, debt − cash, shares outstanding, recent revenue growth), each input labelled with its source; your edits are saved per stock |
| Time & sales | `TAS` (or `QR`) | Trade prints (time, price, size, conditions) with VWAP, volume, largest print and a buy/sell estimate: live from the Finnhub stream, or the last session's when the market is closed |
| Filings | `CF` | Recent 10-K, 10-Q, 8-K and similar filings |

- Click a panel's title, a tab under the stock header, or type `AAPL HDS`, `TSLA DCF`, `HDS` (current stock) and so on. **Esc** returns to the grid.
- Typing another ticker on the stock page keeps the view you're on. The sidebar lists the loaded stock and the last few you opened.
- Opening a stock that isn't in the workspace loads its prices without adding it to your watchlist; **Add to watchlist** in the header keeps it there.
- Key statistics (P/E, profit margin, revenue growth, market cap, 52-week range) are calculated from the live price, the latest statements (trailing four quarters when available) and SEC shares outstanding, then fall back to Finnhub's and Alpha Vantage's figures. Each figure names its source; a loss-making company's P/E shows NM.
- Time and sales: live prints come from the Finnhub stream. When the market is closed, or before live prints arrive, the most recent session shows instead: the newest 10,000 trades on the IEX exchange from Alpaca's free plan (IEX is a small share of all volume, and the latest 15 minutes aren't available), or, without an Alpaca key, that session's 1-minute bars from Twelve Data. Buy/sell is estimated by the tick rule (a print above the previous price counts as buyer-initiated), because free feeds have no bid/ask. There is no order book (market depth) on free data.
- Ownership changes are disclosures as of their filing dates: 13F appears up to 45 days after quarter end, Forms 4 within two business days of the trade.

## Market map (Screener)

**Screener** opens on a heatmap of every S&P 500 company, grouped by sector. Tile area is market cap and colour is the change over the chosen horizon (1 day, 1 week, 1 month, 3 months, year to date, 1 year). Click any tile, or a row in Top gainers / Top losers, to open that company's stock page. **Your workspace** switches to the screener for the stocks in your workspace.

- Members, sectors and sub-industries come from the open [s-and-p-500-companies](https://github.com/datasets/s-and-p-500-companies) dataset.
- Prices: with an Alpaca key, a year of split-adjusted daily bars for all members (IEX feed, about 20 requests), refreshed when older than 15 minutes. With only a Finnhub key, one quote per company inside the 60-a-minute limit (about 10 minutes for a full map; it fills in as it goes), today's change only, refreshed hourly.
- Market cap = price × shares outstanding from SEC's XBRL frames (cover-page share counts for every filer in three requests, plus per-company lookups for multi-class companies). Share classes of one company (GOOGL, GOOG) split its cap evenly. Companies without a share count get a small tile.
- Built in the background and cached in `market-lens.sqlite`, so the last map shows immediately on the next launch.

## SEC filing discovery

- **Stock page → Filings (CF)** lists recent 10-K, 10-Q, 8-K and similar filings with links, plus annual revenue and year-over-year growth from XBRL company facts (latest restatement per period). No key needed. The company's CIK comes from Alpha Vantage, the relationship graph or SEC's company list.
- **Stock page → Suppliers & customers (SPLC)** reads the two latest annual reports, resolves company names against SEC's company list and graph aliases (legal suffixes ignored; one-word names need a legal suffix in the sentence), and adds sentences with supplier or customer wording as **unreviewed** candidates dated to the filing. Revenue concentration is stored only when the same sentence discloses it. The panel compares the two reports: counterparties new this year and no longer mentioned.
- Candidates never become reviewed automatically; use **Mark source reviewed** after reading the filing.

## Holders (HDS)

Type **`AAPL HDS`** (or `HDS AAPL`, or just `HDS` for the current ticker) in the sidebar search box. The stock page's Holders view shows everyone who has disclosed a position, from SEC filings:

- **Institutions (Form 13F)**: every manager with $100M+ in US-listed securities, for any US-listed stock, ETF or ADR. Per holder: shares, change vs the prior quarter, value, % of shares outstanding, **% of the manager's portfolio** (conviction), the position's rank in that portfolio, portfolio size and value, quarters held, voting authority and investment discretion, with a link to the filing. Filters for new positions, adds, reductions, sell-outs, prior holders that haven't filed yet, ≥1% of portfolio and top-10 holdings. Click a manager to see its whole portfolio and what it bought and sold.
- **Summary**: holder count, institutional shares and % of shares outstanding, new/sold-out/added/reduced counts, net shares bought, top-10 concentration, high-conviction holders, median portfolio weight, 13F put/call ratio.
- **5%+ owners (Schedules 13D/G)**: shares, % of class, voting and dispositive power, change vs the filer's previous schedule, activist (13D) purpose text.
- **Insiders (Forms 3/4/5)**: each insider's role and direct/indirect holdings, open-market buys and sales, 10b5-1 plan sales, and the full transaction log.
- **Options** (13F puts and calls) and **History** (holders, shares and % outstanding per stored quarter). Every tab exports to CSV.

13F data comes from SEC's quarterly [Form 13F data sets](https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets): about 100 MB to download and about 200 MB on disk per quarter (2 quarters by default, 4 or 8 in Settings → Reference data; the download starts by itself once the SEC contact email is saved, and new quarters are fetched automatically). It is loaded into `reference.sqlite` in the app-data folder, separate from the workspace. 13F reports identify securities by CUSIP; tickers are mapped with SEC's [fails-to-deliver files](https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data), 13G cover pages and issuer names. Requires the SEC contact email. Limits: 13F data sets appear about a month after each filing deadline (45 days after quarter end); 13F excludes short positions, non-US securities and managers under $100M; Schedule 13D/G parsing covers the structured filings SEC has required since December 2024 (older ones are linked).

## Every listed company (Universe)

The **Universe** page and the sidebar search cover every stock and ETF in Twelve Data's public reference lists (about 267,000 listings on about 90 exchanges in 58 countries; no key needed), merged with SEC's company list (adds CIKs and any US filer missing). The directory downloads by itself on first launch and refreshes weekly. US listings keep their ticker (`AAPL`); others carry their exchange code (`VOD:XLON`, `7203:XJPX`). Prices for non-US listings come from Twelve Data with the exchange code, falling back to Alpha Vantage for the exchanges it documents (London, Toronto, TSX Venture, XETRA, Frankfurt, BSE, Shanghai, Shenzhen). Free plans mostly cover US markets, so some exchanges need a paid plan for prices. Non-USD listings are shown in their own currency and can't be paper-traded in the USD account.

## Implemented workflows

| Workspace | Features |
|---|---|
| Universe | Every listed stock and ETF worldwide: country, exchange and type filters, search, open any listing |
| Stock page | One loaded stock, a panel grid and ten full views: description, chart, financials, news, holders, ownership changes, suppliers & customers, valuation, time & sales, filings; terminal codes (`AAPL HDS`), recent stocks, Esc back to the grid |
| Holders (on the stock page) | `TICKER HDS`: 13F institutions with changes and conviction, manager portfolios, 13D/G 5%+ owners, Forms 3/4/5 insiders, options, ownership history, CSV export |
| Overview | Asset lookup, saved watchlist, daily changes, local-universe movers, performance heatmap |
| Description, chart, financials, news (on the stock page) | Candlestick/line chart, volume, hover inspection, wheel zoom, time ranges, MA20/MA50, normalized comparison overlay, chart SVG export, source/date labels, company profile, ratios, annual/quarterly statements, linked news, earnings calendar, dividend metadata, EDGAR link, saved thesis |
| Trade | Buy/sell beside chart, fractional shares, fees, manual slippage, rationale, execution markers, chronological ledger, cash/position checks, separate demo/market accounts, CSV journal |
| Portfolio | Holdings, average cost, cash, realized/unrealized P&L, allocation, historical paper-equity curve, volatility, drawdown, per-asset Sharpe, correlation matrix, uniform price-shock scenario, benchmark context, position export |
| Screener | S&P 500 market map (treemap by sector, tiles sized by market cap, coloured by 1-day to 1-year change, top gainers/losers; click a company to open its stock page) and the workspace screener: P/E, growth and sector filters, saved screens, result export |
| Valuation (on the stock page) | Inputs pre-filled from SEC XBRL filings with sources, five-year unlevered DCF, bear/base/bull cases, terminal growth, net debt, diluted shares, discount/growth sensitivity, model export |
| Economy | FRED CPI, unemployment, policy rate, 2Y/10Y Treasury yields and real GDP, loaded automatically, with source links and history charts |
| Alerts | Persistent above/below price conditions; latching status; reevaluated on workspace load and stored-data changes |
| Settings | Saved provider keys, price-source choice, sync status and last errors, starting cash, JSON backup (restore under Advanced) |

## Architecture and data handling

- Rust handles provider HTTP requests, request accounting, response caching, native exports, and SQLite persistence.
- Native paper trades are validated in Rust and appended within a SQLite transaction. The browser preview uses the tested JavaScript counterpart.
- Analytics/chart rendering use small pure JavaScript functions. Rust is used for native operations and the trade execution boundary; this is not a claim that every calculation runs in Rust.
- SQLite uses WAL mode. Tables contain the versioned workspace, raw response cache, and request timestamps. The database is in the OS application-data directory for `com.marketlens.desktop`.
- API keys are stored only in `credentials.json` (owner-only permissions) in the app-data folder, never in localStorage, SQLite, JSON backups or log messages. Provider error messages are shown with any key text masked. Keys are sent only to fixed HTTPS provider endpoints. Requests have a 20-second timeout and do not follow redirects.
- Free-plan limits are enforced locally and requests are queued rather than rejected: Alpha Vantage 25/day, 13 s apart, reused for 6 h; Twelve Data 800/day, 8 s apart, reused for 1 h; Finnhub 1 s apart, reused for 30 min; Alpaca reused for 5 min; FRED reused for 12 h. Finnhub and Alpaca queue separately so they never wait behind Alpha Vantage. Failed calls count toward the budget. When a provider fails or the daily budget is spent, saved data is shown and marked stale.
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

- **Source health**: `.github/workflows/source-health.yml` runs the live provider contract tests (`cargo test ... -- --ignored`) every Monday and on demand.
- **Native launch**: PR desktop builds start the built Linux app under a virtual display and fail if it exits within 20 seconds.
- **Workspace migrations**: `migrate()` in `src/engine.js` upgrades saved workspaces (and restored backups) from older schema versions in place, and refuses workspaces from newer versions.

See `VALIDATION.md` for the checks actually executed in the build environment and their limitations. Core Rust tests intentionally do not require desktop libraries; they test the same ledger module used by the desktop command. Browser tests do not validate the native IPC bridge or OS dialogs.

## Current boundaries

This is a substantial first implementation of the requested release and analysis workflows, not a complete Bloomberg replacement. Specific gaps are explicit:

- No live quotes, live orders, options chains, futures, multi-currency accounting, automatic dividends/splits, tax reports, or automatic brokerage import.
- No whole-market fundamentals database: the screener covers downloaded companies only. Free daily history depth is determined by your provider plan.
- Price alerts run when the app reads/updates stored data; no daemon, email, push notifications or monitoring while closed.
- News and earnings calendars cover US-listed stocks (Finnhub free plan). Economic-release calendars, earnings-call transcript search, comprehensive dividend calendars, full-text filings, drawing tools, automated adjusted total returns, and native multi-workspace layouts are not implemented.
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
