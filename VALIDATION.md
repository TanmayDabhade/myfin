# Validation record — November 5, 2026

Executed in the Linux build environment:

| Check | Result |
|---|---|
| Dependency installation | Passed; package-lock.json included |
| `npm test` | 19 passing calculation/import regression tests |
| Rust ledger unit tests (`cargo test --no-default-features --lib`) | 3 passed |
| `npm run build` | Passed; production assets generated |
| `cargo check --manifest-path src-tauri/Cargo.toml` | Passed with Tauri, WebKitGTK, SQLite, HTTP, opener and native-dialog dependencies |
| Browser workflow smoke test | Passed; zero page errors across all nine screens |
| Browser persistence | Buy → reload → holdings verified |
| Alert workflow | Create threshold → triggered status verified |
| CSV import and workspace isolation | Imported AAPL prices verified; synthetic prices and trades remain separate |
| Visual review | Overview rendered and inspected at 1440px; no horizontal overflow across tested screens |

Numerical tests cover buy/sell fees, average-cost partial sales, round-trip realized profit, insufficient cash, short-selling rejection, fractional shares, missing marks, mark-to-market reconciliation, DCF perpetuity and invalid terminal growth, historical equity without future marks, volatility/drawdown inputs, aligned correlation, CSV quoting and spreadsheet-formula neutralization, malformed/duplicate OHLC rows, API-response normalization, JSON round-trip, and alert latching.

Not verified here:

- A linked, launched, packaged or signed native application on macOS or Windows. `cargo check` is type-checking, not final binary linking or an installer build.
- Native window interactions, native save dialogs or live IPC through an actual OS webview. Browser smoke tests exercise the same UI through its offline browser adapter.
- Live authenticated Alpha Vantage/FRED requests: no user API keys were supplied. Endpoints follow official documentation, provider errors are surfaced, and payload normalization has a test fixture.
- A deployed GitHub Actions build. The workflow is provided as source.
- Corporate-action-correct total returns, multi-currency portfolios, or reliable real-time coverage; these are not implemented or claimed.

This is an executable source project with tested core workflows, not a signed application installer or a claim that every item in the broader original financial-platform feature catalog is complete. See README's boundaries and workflow table before using real research data.
