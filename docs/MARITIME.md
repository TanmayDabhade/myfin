# Commodity / maritime intelligence

This feature is a first vertical slice, not a vessel-tracking terminal. It adds a geospatial explorer for 28 chokepoints and four selected ports, cargo/tanker/container/dry-bulk counts, 90-observation history, 7-observation comparisons, caching, provenance, and CSV exports.

Sources:
- IMF PortWatch: https://portwatch.imf.org/
- Catalogs: `PortWatch_chokepoints_database` and `PortWatch_ports_database` under https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services
- Daily schemas: `Daily_Chokepoints_Data` and `Daily_Ports_Data`, FeatureServer table 0.
- Source terms: https://www.imf.org/external/terms.htm
- Map geography: Natural Earth 1:110m land via world-atlas 2.0.2. Natural Earth geographic data is public domain; this project's static SVG path was generated from that dataset, not copied from WorldMonitor code.

Catalog metadata and table fields were retrieved on 2026-11-05. Chokepoint transit fields use `n_*`; port calls use `portcalls_*`. The UI preserves those category definitions rather than assuming cargo and tanker counts are disjoint. Null stays unknown; zero stays zero. A tanker is not necessarily carrying petroleum.

The Rust provider is fixed to the documented public ArcGIS host and rejects malformed IDs. It makes a bounded query for the latest 90 records and caches responses for six hours; provider failures may return a distinctly labeled stale cache. No token is needed for these documented public layers. User API requests are not background-polled.

## Validation and blocking issue

Unit and browser tests exercise normalization, null handling, rolling summaries, input restrictions, maps, controls and empty states. The Rust library has an explicit ignored live contract test:

```
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib live_portwatch_contract -- --ignored --nocapture
```

The actual public query endpoint returned a provider error (`400 Invalid URL`) during verification even though catalog and table metadata were readable. The implementation must remain a DRAFT PR until a live contract check succeeds, or a verified replacement endpoint is adopted. No observations are fabricated, and no ready/live claim should be made. Native desktop runtime and IPC were not exercised in this environment.

Remaining in #6: authorized backend AIS stream, vessel-level positions/details, reconnect/backoff, retention, commodity prices and commodity-specific context. AISStream credentials must stay in Rust/server memory; its documented feed does not permit direct browser clients. WorldMonitor is a UX reference, not an implementation or data license.
