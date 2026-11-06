# Commodities and live vessels

The Commodities page has two parts:

- **Live vessels** (top): AIS positions from AISStream within about 1° of a selected port or chokepoint, on a Leaflet map. Needs an AISStream key.
- **Commodity prices**: WTI, Brent, Henry Hub, US gasoline and copper from FRED. Needs a FRED key.

## Live vessels

- The Rust backend holds the AISStream websocket; the key goes only into the subscription message and never reaches the UI. AISStream does not allow direct browser clients.
- The stream runs only while the Commodities page is open in Live data mode. It reconnects with exponential backoff and jitter, and stops for good if the key is rejected.
- At most 2,000 vessels are kept, each for 2 hours after its last report.
- The UI polls the backend snapshot every 2 seconds and moves map markers in place. The map element is created once and reused across page renders, so tiles and zoom are kept.
- Class comes from the broadcast AIS ship type (70–79 cargo, 80–89 tanker). A tanker class describes the hull, not its cargo or whether it is loaded.
- Locations come from `src/maritime-locations.json` (28 chokepoints and four ports; coordinates originally taken from the IMF PortWatch catalog on 2026-11-05).

Map tiles: Esri World Dark Gray Canvas (base and labels), no key required. Attribution "Esri, HERE, Garmin, © OpenStreetMap contributors" is shown on the map. CARTO basemaps were tried first, but they now return "API key required" tiles. The tile host is allowed in the Tauri CSP (`img-src`).

## IMF PortWatch (removed)

Daily port-call and chokepoint-transit counts from IMF PortWatch were removed in November 2026. Its public ArcGIS query endpoint kept rejecting valid requests (`400 Invalid URL`), so the panel never showed data. Its retries also held the shared provider lock, which delayed FRED and price loads by up to a couple of minutes. Old cached PortWatch rows are deleted from SQLite on startup.
