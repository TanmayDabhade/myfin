import {
  locations,
  mountVesselMap,
  updateVessels,
  clearVessels,
  focusVessel,
} from "./maritime.js";
import {
  seedGraph,
  validateGraph,
  mergeGraph,
  relationshipsView,
  resolveCenter,
  ensureCompany,
  companyGroup,
  neighborhood,
  parentTicker,
} from "./relationships.js";
import {
  screenerView,
  marketMapView,
  screenRows,
  defaults as screenDefaults,
} from "./screener.js";
import {
  padCIK,
  recentFilings,
  annualReports,
  revenueHistory,
  buildDirectory,
  extractCandidates,
  candidatesToGraph,
  compareMentions,
  prettyName,
  searchPhrases,
  mentionsOf,
  filingURL,
} from "./filings.js";
import { REVENUE_TAGS, VALUE_TAGS } from "./sec-tags.js";
import { VIEWS, VIEW_CODES, viewLabel, pushRecent, tapeStats, ownershipFeed, valuationInputs, keyStats, pastPrints, minuteSession } from "./stock.js";
import {
  parseCommand,
  sharesSeries,
  sharesAt,
  compareHolders,
  ownershipHistory,
  comparePortfolio,
  parseSchedule13,
  bigHolders,
  parseOwnership,
  insiderSummary,
  ownershipFilings,
  alphaSymbol,
  isUSKey,
  STATUS_LABEL,
  TX_CODES,
} from "./holders.js";
import "./style.css";
import {
  load,
  save,
  keyStatus,
  saveKeys,
  clearKey,
  fetchData,
  fetchSEC,
  aisStart,
  aisStop,
  aisSnapshot,
  quotesStart,
  quotesStop,
  quotesSnapshot,
  quotesTape,
  native,
  nativeTrade,
  holdingsStatus,
  holdingsUpdate,
  holdersFor,
  holderPortfolio,
  universeStatus,
  universeRefresh,
  universeSearch,
  universeBrowse,
  universeFacets,
  universeGet,
  marketStatus,
  marketRefresh,
  marketSnapshot,
} from "./bridge.js";
import {
  providers,
  priceProviders,
  priceSource,
  normalizeTwelve,
  stale,
} from "./sources.js";
import { sample } from "./sample.js";
import { BENCHMARK, quantRequest, quantKey, fredRate, RISK_ROWS, formatRisk, bandPosition } from "./quant.js";
import { quantStatus, quantChoose, quantForget, quantAnalyze } from "./bridge.js";
import { applyTrade, nyDate } from "./live.js";
import {
  risk,
  equityCurve,
  sma,
  rsi,
  dcf,
  book,
  execute,
  portfolio,
  correlation,
  parseCSV,
  validateBars,
  normalizeAlpha,
  csv,
  checkAlerts,
  validateWorkspace,
  migrate,
  number,
} from "./engine.js";
const $ = (s) => document.querySelector(s),
  esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const fmt = (x, d = 2) =>
  x == null || !Number.isFinite(+x)
    ? "—"
    : Number(x).toLocaleString("en-US", {
        maximumFractionDigits: d,
        minimumFractionDigits: d,
      });
const pct = (x) => (x == null ? "—" : fmt(x * 100) + "%"),
  money = (x) => (x == null ? "—" : "$" + fmt(x)),
  compact = (x) =>
    x == null
      ? "—"
      : Intl.NumberFormat("en", {
          notation: "compact",
          maximumFractionDigits: 2,
        }).format(x);
let state = migrate(await load()),
  page = "Overview",
  keyInfo = await keyStatus().catch(() => null),
  symbol = "AAPL",
  range = 90,
  candles = true,
  compare = "",
  busy = false,
  screen = { pe: 100, growth: -100, sector: "" },
  statement = "INCOME_STATEMENT",
  period = "annualReports";
let graphCenter = "apple",
  graphCandidates = true,
  graphTrail = ["apple"], // companies visited, for Back and the breadcrumb
  graphSymbol = "AAPL", // ticker the explorer last followed
  scanningId = null; // entity whose filings are being read right now
const scanErrors = {};
const scanProgress = {}; // entity -> { done, total } while other reports are read
function scanText(id) {
  if (scanningId === id) return "Reading its annual reports…";
  const p = scanProgress[id];
  return p ? `Checking other companies' reports that name it · ${p.done}/${p.total}` : "";
}
// Open a company in the explorer and remember the way back.
function goToEntity(id) {
  id = resolveCenter(graph(), id);
  if (id === graphCenter) return;
  graphCenter = id;
  graphTrail = [...graphTrail.filter((x) => x !== id), id].slice(-12);
}
// Open the company behind a ticker, adding it in live mode so its filings
// can be scanned. Returns false when there is nothing to show.
function centerOnTicker(s, name) {
  const g = graph();
  const known = g.nodes.some((x) => x.ticker === s || x.parent?.endsWith(`(${s})`));
  if (!known && !live()) return false;
  const n = ensureCompany(g, s, name);
  if (!n.cik && cikFor(s)) n.cik = cikFor(s);
  graphSymbol = s;
  goToEntity(n.id);
  if (!known) persist();
  return true;
}
state.sources ||= { prices: "twelve" };
delete state.maritime; // old PortWatch cache, no longer used
const lastError = {}; // provider -> latest failure message, shown in Settings
const attempted = new Set(); // automatic loads tried this session
let syncLabel = "";
const anyKey = () =>
  !!keyInfo && Object.values(keyInfo).some((k) => k.configured);
const hasKey = (p) => !!keyInfo?.[p]?.configured;
const live = () => native && state.mode === "market";
// First launch in the desktop app: ask for keys, unless they already exist.
if (native && !state.setupDone) {
  if (anyKey()) {
    state.setupDone = true;
    state.mode = "market";
  } else page = "Setup";
}
const graph = () => (state.relationshipGraph ||= seedGraph());
if (state.relationshipGraph) validateGraph(state.relationshipGraph);
// Market-wide and personal pages. Everything about one company lives on the
// stock page, which the sidebar lists by ticker.
const navGroups = [
  ["Markets", ["Overview", "Universe", "Screener", "Economy", "Commodities"]],
  ["Your account", ["Portfolio", "Trade", "Alerts"]],
];
const navIcons = { Overview: "◫", Universe: "◍", Screener: "☷", Economy: "◎", Commodities: "≋", Portfolio: "◉", Trade: "⇄", Alerts: "◇", Settings: "⚙" };
// Dover Strait by default: AISStream's coverage is strong there and thin in
// some Middle East and open-ocean areas. The last pick is remembered.
let maritimeSelected = locations.some((x) => x.id === state.vesselLocation)
  ? state.vesselLocation
  : "chokepoint9";
function commodities() {
  return (
    `<section class="panel" id="vessel-panel">${vesselPanel()}</section>` +
    commodityPrices()
  );
}
const commoditySeries = {
  DCOILWTICO: "WTI crude oil · USD per barrel, daily",
  DCOILBRENTEU: "Brent crude oil · USD per barrel, daily",
  DHHNGSP: "Henry Hub natural gas · USD per MMBtu, daily",
  GASREGW: "US regular gasoline · USD per gallon, weekly",
  PCOPPUSDM: "Copper · USD per metric ton, monthly",
};
function seriesCard(s, label, note) {
  const d = state.macro[s];
  if (!d)
    return `<section class="macro-card"><h3>${esc(label)}</h3><strong>—</strong><small>${esc(loadErrors["fred:" + s] || (note ? "Not connected" : "Loading…"))}</small></section>`;
  const rows = d.data.observations
    .filter((x) => number(x.value) != null)
    .slice()
    .reverse();
  const latest = rows.at(-1);
  return `<section class="macro-card"><h3>${esc(label)}</h3><strong>${fmt(number(latest?.value))}</strong><small>${esc(latest?.date)} · ${esc(s)}</small>${spark(rows.map((x) => +x.value))}${link("https://fred.stlouisfed.org/series/" + encodeURIComponent(s), "View series and source")}${datasetStamp({ ...d, provider: "fred" })}</section>`;
}
function commodityPrices() {
  const note = !native
    ? "Commodity prices load in the desktop app."
    : !hasKey("fred")
      ? "Add a free FRED key in Settings → Data sources for commodity prices."
      : "";
  return `<section class="panel"><div class="panel-head"><h2>Commodity prices</h2><small>FRED · original units</small></div>${note ? `<p><b>${esc(note)}</b></p>` : ""}<div class="macro-grid commodity-grid">${Object.entries(commoditySeries)
    .map(([s, label]) => seriesCard(s, label, note))
    .join("")}</div><small>Spot and benchmark prices as published by FRED's sources (EIA, IMF). Daily series lag by a few days. Prices give market context; they are not linked to any vessel above.</small></section>`;
}
// ---- Live vessels (AISStream) --------------------------------------------
let vesselClass = "all",
  ais = null, // latest snapshot
  aisTimer = null;
const vesselLoc = () =>
  locations.find((x) => x.id === maritimeSelected) || locations[0];
function vesselBlocker() {
  return !native
    ? "Live vessels stream in the desktop app."
    : state.mode !== "market"
      ? "Switch to Live data for vessel positions."
      : !hasKey("ais")
        ? "Add a free AISStream key in Settings → Data sources to see vessels moving here."
        : "";
}
function shownVessels() {
  const all = ais?.area === vesselLoc().id ? ais.vessels : [];
  return {
    all,
    shown: all.filter((v) => vesselClass === "all" || v.class === vesselClass),
  };
}
// Static frame: header, controls and the map slot. Rebuilt only on page render.
function vesselPanel() {
  const loc = vesselLoc();
  return `<div class="panel-head"><h2>Live vessels</h2><div class="vessel-controls"><select id="vessel-location" aria-label="Location">${locations.map((x) => `<option value="${x.id}" ${x.id === loc.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select><select id="vessel-class" aria-label="Vessel class"><option value="all" ${vesselClass === "all" ? "selected" : ""}>All vessels</option><option value="tanker" ${vesselClass === "tanker" ? "selected" : ""}>Tankers</option><option value="cargo" ${vesselClass === "cargo" ? "selected" : ""}>Cargo</option></select></div></div><p class="muted" id="vessel-status">${esc(vesselStatus())}</p><div class="vessel-layout"><div id="vessel-map-slot" class="vessel-leaflet"></div><div id="vessel-list">${vesselList()}</div></div><small>AIS positions within about 1° of the selected location (dashed box), kept for 2 hours (at most 2,000 vessels). Click another marker on the map to move there. Class comes from the vessel's broadcast ship type: "tanker" describes the hull, not whether it carries petroleum, what it carries, or whether it is loaded. "Unknown" means no type report has been received yet. Positions are self-reported and can be missing or wrong. Map tiles © Esri, HERE, Garmin, © OpenStreetMap contributors.</small>`;
}
function vesselStatus() {
  const blocker = vesselBlocker();
  if (blocker) return blocker;
  const { all, shown } = shownVessels();
  const status =
    !ais || ais.area !== vesselLoc().id
      ? "Connecting to AISStream…"
      : ais.error ||
        {
          live: "Live",
          subscribed: "Connected; waiting for vessel reports…",
          connecting: "Connecting…",
          reconnecting: "Reconnecting…",
        }[ais.status] ||
        ais.status;
  return `${status}${ais?.lastMessage ? " · last report " + new Date(ais.lastMessage * 1000).toLocaleTimeString() : ""} · ${shown.length} of ${all.length} vessels shown`;
}
function vesselList() {
  const blocker = vesselBlocker();
  if (blocker) return empty(esc(blocker));
  const { shown } = shownVessels();
  if (!shown.length) return empty("Waiting for vessel reports…");
  return table(
    ["Vessel", "Class", "Speed", "Status", "Destination", "Seen"],
    shown.slice(0, 80).map(
      (v) =>
        `<tr data-mmsi="${v.mmsi}"><td>${esc(v.name)}<small> · ${esc(v.mmsi)}</small></td><td><span class="ship-key ${esc(v.class)}"></span>${esc(v.class)}</td><td>${v.sog == null ? "—" : fmt(v.sog, 1) + " kn"}</td><td>${esc(v.status)}</td><td>${esc(v.destination || "—")}</td><td>${new Date(v.seen * 1000).toLocaleTimeString()}</td></tr>`,
    ),
  );
}
// Update status, table and markers in place; the map itself is never rebuilt.
function refreshVessels() {
  const status = $("#vessel-status"),
    list = $("#vessel-list");
  if (!status || !list) return;
  status.textContent = vesselStatus();
  const scroll = list.querySelector(".table-wrap")?.scrollTop || 0;
  list.innerHTML = vesselList();
  const wrap = list.querySelector(".table-wrap");
  if (wrap) wrap.scrollTop = scroll;
  updateVessels(vesselBlocker() ? [] : shownVessels().shown);
}
function pickVesselLocation(id) {
  if (id === maritimeSelected) return;
  maritimeSelected = state.vesselLocation = id;
  persist().catch(() => {});
  ais = null;
  clearVessels();
  const sel = $("#vessel-location");
  if (sel) sel.value = id;
  mountVesselMap($("#vessel-map-slot"), vesselLoc(), pickVesselLocation);
  refreshVessels();
  syncVesselStream();
}
// Run the stream only while Commodities is open in live mode.
function syncVesselStream() {
  const want = page === "Commodities" && live() && hasKey("ais");
  if (!want) {
    if (aisTimer) {
      clearInterval(aisTimer);
      aisTimer = null;
      ais = null;
      aisStop().catch(() => {});
    }
    return;
  }
  const loc = vesselLoc();
  aisStart(loc.id, loc.lat, loc.lon).catch((e) => notify(message(e), true));
  const poll = async () => {
    try {
      ais = await aisSnapshot();
    } catch {
      return;
    }
    refreshVessels();
  };
  if (!aisTimer) {
    poll();
    aisTimer = setInterval(poll, 2000);
  }
}
function bindVessel() {
  if (!$("#vessel-panel")) return;
  mountVesselMap($("#vessel-map-slot"), vesselLoc(), pickVesselLocation);
  updateVessels(vesselBlocker() ? [] : shownVessels().shown);
  $("#vessel-class").onchange = (e) => {
    vesselClass = e.target.value;
    refreshVessels();
  };
  $("#vessel-location").onchange = (e) => pickVesselLocation(e.target.value);
  $("#vessel-list").onclick = (e) => {
    const row = e.target.closest("tr[data-mmsi]");
    if (row) focusVessel(Number(row.dataset.mmsi));
  };
}
function activeMap() {
  return state.mode === "sample" ? state.assets : (state.marketAssets ||= {});
}
function assets() {
  return Object.values(activeMap()).filter((a) =>
    state.mode === "sample" ? a.origin === "sample" : a.origin !== "sample",
  );
}
function asset() {
  return assets().find((a) => a.symbol === symbol) || assets()[0];
}
function account() {
  return state.accounts[state.mode];
}
function price(a) {
  return a?.bars.at(-1)?.close;
}
function change(a) {
  const b = a.bars;
  return b.length > 1 ? b.at(-1).close / b.at(-2).close - 1 : null;
}
// Price and change cells that the real-time stream updates in place.
// Listings outside the US are priced in their own currency.
function priceText(a, x) {
  return a?.currency && a.currency !== "USD" ? (x == null ? "—" : `${fmt(x)} ${esc(a.currency)}`) : money(x);
}
function livePrice(a) {
  return `<span data-live-price="${esc(a.symbol)}">${priceText(a, price(a))}</span>`;
}
function liveChange(a, suffix = "") {
  return `<span data-live-change="${esc(a.symbol)}" data-suffix="${esc(suffix)}" class="${tone(change(a))}">${pct(change(a))}${suffix}</span>`;
}
function tone(x) {
  return x >= 0 ? "up" : "down";
}
function stat(label, value, detail = "") {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
}
function empty(text) {
  return `<div class="empty">${text}</div>`;
}
function badge(a) {
  return `<span class="tag">${esc(a?.source || "No data")}</span><span class="muted">${a?.bars?.at(-1) ? "Through " + a.bars.at(-1).date : ""}</span>`;
}
function table(headers, rows) {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function button(text, action, cls = "", data = "") {
  return `<button class="${cls}" data-action="${action}" ${data}>${text}</button>`;
}
function ticker(a) {
  return `<button class="ticker" data-symbol="${esc(a.symbol)}"><b>${esc(a.symbol)}</b><small>${esc(a.name)}</small></button>`;
}
function link(url, label) {
  return `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label)} ↗</a>`;
}
function safeURL(x) {
  try {
    const u = new URL(x);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}
async function persist() {
  state.alerts = state.alerts.map(
    (a) =>
      checkAlerts(
        [a],
        a.mode === "sample" ? state.assets : state.marketAssets || {},
      )[0],
  );
  await save(state);
}
function notify(message, error = false) {
  $("#toast")?.remove();
  const el = document.createElement("div");
  el.id = "toast";
  el.className = error ? "error" : "";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 7000);
}
// Pixel width available to the relationship graph, measured from the last
// render (or estimated on the first), so the SVG is drawn 1:1 and its text
// stays the same size on any monitor.
let lastGraphWidth = 0,
  fixingWidth = false;
function graphWidth() {
  const el = document.querySelector(".relationship-graph") || document.querySelector(".content");
  const w = el?.clientWidth || window.innerWidth - 320;
  return (lastGraphWidth = Math.max(760, Math.round(w) - 2));
}
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (inGraph() || page === "Screener") render();
    else drawCharts();
  }, 150);
});
function render() {
  const a = asset();
  if (!symbol && a) symbol = a.symbol;
  const views = {
    Setup: setup,
    Overview: overview,
    Stock: stockPage,
    Universe: universePage,
    Trade: trade,
    Portfolio: portfolioPage,
    Screener: screener,
    Economy: economy,
    Alerts: alerts,
    Commodities: commodities,
    Settings: settings,
  };
  const demo = page !== "Setup" && state.mode === "sample";
  document.getElementById("app").innerHTML =
    `<aside><div class="brand"><i>◈</i> APERTURE</div><div class="side-search"><input id="search" placeholder="Ticker or AAPL HDS" aria-label="Search any listing or type a function like AAPL HDS" autocomplete="off" spellcheck="false"><kbd>↵</kbd><div id="search-results" class="combo-list" role="listbox" hidden></div></div><nav>${sideNav()}</nav><div class="sidebar-bottom"><div id="stream-status">${streamText()}</div><div class="mode-switch"><span class="dot ${live() ? "on" : ""}"></span><select id="mode" aria-label="Data workspace"><option value="market" ${state.mode === "market" ? "selected" : ""}>Live data</option><option value="sample" ${state.mode === "sample" ? "selected" : ""}>Demo data</option></select></div><small id="sync-status">${esc(syncText())}</small></div></aside><main><section class="content">${page === "Stock" ? "" : `<div class="title-row"><div><p class="eyebrow">${page === "Setup" ? "FIRST RUN" : page === "Universe" ? "EVERY LISTING WE CAN FIND" : state.mode === "sample" ? "DEMONSTRATION" : "LIVE RESEARCH"}</p><h1>${page === "Overview" ? "Your market, in focus." : page === "Setup" ? "Connect your data" : page}</h1></div>${page === "Setup" ? "" : `<div class="title-tags">${demo ? '<span class="tag warn" title="Prices and company metrics are synthetic. Switch to Live data at the bottom of the sidebar.">Demo data · synthetic prices</span>' : ""}<span class="tag">${assets().length} assets in workspace</span></div>`}</div>`}${views[page]()}</section><footer>Aperture 0.3 · USD equity workspace · Daily prices with real-time trades when streaming · Paper trades only · No investment recommendations</footer></main>`;
  bind();
  bindVessel();
  drawCharts();
  // One corrective pass at most (a scrollbar appearing could otherwise loop).
  const g = document.querySelector(".relationship-graph");
  const mm = document.querySelector(".mm-wrap");
  if (!fixingWidth && ((g && Math.abs(Math.max(760, g.clientWidth - 2) - lastGraphWidth) > 4) || (mm && Math.abs(mm.clientWidth - lastMapWidth) > 4))) {
    fixingWidth = true;
    render();
    fixingWidth = false;
    return;
  }
  autoLoad();
  syncVesselStream();
  syncPriceStream();
  syncTape();
}
// Sidebar: market and account pages, then the loaded stock and recent ones.
function sideNav() {
  const item = (p) => `<button class="nav ${page === p ? "selected" : ""}" data-page="${p}"><span>${navIcons[p]}</span>${p}</button>`;
  const map = activeMap();
  const stockItem = (t, current) => {
    const a = map[t];
    const c = a && a.bars?.length > 1 ? change(a) : null;
    return `<button class="nav stock-nav ${current && page === "Stock" ? "selected" : ""}" ${current ? 'data-page="Stock"' : `data-recent="${esc(t)}"`} title="${esc(a?.name || t)}"><span>${current ? "◆" : "·"}</span>${esc(t)}${c == null ? "" : `<small data-live-change="${esc(t)}" data-suffix="" class="${tone(c)}">${pct(c)}</small>`}</button>`;
  };
  const recent = (state.recent || []).filter((t) => t !== symbol).slice(0, 5);
  return (
    navGroups.map(([label, list]) => `<div class="nav-group">${label}</div>${list.map(item).join("")}`).join("") +
    (symbol ? `<div class="nav-group">Stock</div>${stockItem(symbol, true)}${recent.map((t) => stockItem(t, false)).join("")}` : "") +
    `<div class="nav-group"></div>${item("Settings")}`
  );
}
// ---- Real-time prices (Finnhub) -------------------------------------------
let quoteTimer = null,
  quoteSnap = null,
  quoteError = "",
  streamList = "";
function streamSymbols() {
  const map = activeMap();
  return [...new Set([...state.watchlist, symbol, compare, ...state.alerts.filter((x) => x.mode === "market").map((x) => x.symbol)])]
    .filter((s) => s && map[s] && isUSKey(s))
    .slice(0, 50);
}
function streamText() {
  if (!live()) return "";
  if (!hasKey("finnhub"))
    return `<button class="stream-cta" data-action="goto-settings">Add a free Finnhub key for real-time prices</button>`;
  const err = quoteError || quoteSnap?.error;
  if (err) return `<span class="stream down" title="${esc(err)}">● ${esc(err.length > 48 ? err.slice(0, 47) + "…" : err)}</span>`;
  const n = quoteSnap?.symbols?.length || 0;
  if (!quoteSnap || ["connecting", "reconnecting"].includes(quoteSnap.status))
    return `<span class="stream">● Connecting to real-time prices…</span>`;
  const last = quoteSnap.lastMessage;
  const recent = last && Date.now() / 1000 - last < 120;
  return `<span class="stream ${recent ? "on" : ""}">● ${recent ? "Real-time" : "Streaming · no trades right now"} · ${n} symbol${n === 1 ? "" : "s"}${last ? " · " + new Date(last * 1000).toLocaleTimeString() : ""}</span>`;
}
function syncPriceStream() {
  if (!live() || !hasKey("finnhub")) {
    if (quoteTimer) {
      clearInterval(quoteTimer);
      quoteTimer = null;
      quoteSnap = null;
      streamList = "";
      quotesStop().catch(() => {});
    }
    return;
  }
  const list = streamSymbols();
  if (list.join(",") !== streamList) {
    streamList = list.join(",");
    quotesStart(list)
      .then(() => (quoteError = ""))
      .catch((e) => (quoteError = message(e)));
  }
  if (!quoteTimer) quoteTimer = setInterval(pollQuotes, 1000);
}
let chartPaintedAt = 0;
async function pollQuotes() {
  try {
    quoteSnap = await quotesSnapshot();
  } catch {
    return;
  }
  const map = activeMap(),
    changed = [];
  if (live())
    for (const [s, q] of Object.entries(quoteSnap.quotes || {}))
      if (map[s] && applyTrade(map[s], q)) changed.push(s);
  if (changed.length) paintLive(changed);
  const el = $("#stream-status");
  if (el) el.innerHTML = streamText();
}
// Update prices where they are shown, without re-rendering the page.
function paintLive(symbols) {
  const map = activeMap();
  for (const s of symbols) {
    const a = map[s];
    document.querySelectorAll(`[data-live-price="${CSS.escape(s)}"]`).forEach((el) => {
      const before = number(el.textContent.replace(/[$,]/g, ""));
      el.textContent = money(price(a));
      if (before != null && before !== price(a)) {
        el.classList.remove("tick-up", "tick-down");
        void el.offsetWidth; // restart the flash animation
        el.classList.add(price(a) > before ? "tick-up" : "tick-down");
      }
    });
    document.querySelectorAll(`[data-live-change="${CSS.escape(s)}"]`).forEach((el) => {
      el.textContent = pct(change(a)) + (el.dataset.suffix || "");
      el.className = tone(change(a));
    });
    document.querySelectorAll(`.heat[data-symbol="${CSS.escape(s)}"]`).forEach((el) => {
      el.classList.remove("up", "down");
      el.classList.add(tone(change(a)));
      const span = el.querySelector("span");
      if (span) span.textContent = pct(change(a));
    });
  }
  // Redraw affected charts at most every 2 seconds, and never under the cursor.
  if (Date.now() - chartPaintedAt > 2000) {
    const hit = new Set(symbols);
    if ([...document.querySelectorAll("[data-chart]")].some((el) => (hit.has(el.dataset.chart) || hit.has(compare)) && !el.matches(":hover"))) {
      chartPaintedAt = Date.now();
      drawCharts(hit);
    }
  }
}
function syncText() {
  if (syncLabel) return syncLabel;
  if (!native) return "Live data needs the desktop app";
  if (!anyKey()) return "No data source connected";
  return state.lastSync
    ? "Updated " + new Date(state.lastSync * 1000).toLocaleTimeString()
    : "Connected";
}
function setSync(text) {
  syncLabel = text;
  const el = $("#sync-status");
  if (el) el.textContent = syncText();
}
// Re-render without wiping something the user is typing.
function refresh() {
  const f = document.activeElement;
  if (f && ["INPUT", "TEXTAREA", "SELECT"].includes(f.tagName) && f.id !== "mode")
    return setSync(syncLabel);
  render();
}
function overview() {
  const all = assets();
  if (!all.length) return liveEmpty();
  const a = asset();
  return `<div class="stats">${all
    .slice(0, 4)
    .map((a) =>
      stat(
        a.symbol,
        livePrice(a),
        liveChange(a, " vs prior close"),
      ),
    )
    .join(
      "",
    )}</div><div class="grid main-grid"><section class="panel"><div class="panel-head"><h2>${esc(a.symbol)} <small>${esc(a.name)}</small><span class="head-price">${livePrice(a)}${liveChange(a)}</span></h2>${button(`Open ${esc(a.symbol)} →`, "research", "", `data-value="${esc(a.symbol)}"`)}</div>${chartTools()}${chart(a)}<div class="source-line">${badge(a)}</div></section><section class="panel"><div class="panel-head"><h2>Watchlist</h2></div><div class="watch-add"><input id="watch-input" placeholder="Add ticker" maxlength="20" aria-label="Add ticker to watchlist">${button("Add", "watch-add")}</div>${
    state.watchlist
      .map((s) => all.find((a) => a.symbol === s))
      .filter(Boolean)
      .map(
        (a) =>
          `<div class="watch-row">${ticker(a)}<div>${livePrice(a)}<small>${liveChange(a)}</small></div>${button("×", "watch-remove", "icon", `data-value="${esc(a.symbol)}"`)}</div>`,
      )
      .join("") || empty("Add an asset to your watchlist.")
  }</section></div><div class="grid halves"><section class="panel"><div class="panel-head"><h2>Workspace performance map</h2><small>Last session · not the full market</small></div><div class="heatmap">${all.map((a) => `<button data-symbol="${a.symbol}" class="heat ${tone(change(a))}"><b>${a.symbol}</b><span>${pct(change(a))}</span><small>${esc(a.sector || "Unclassified")}</small></button>`).join("")}</div></section><section class="panel"><div class="panel-head"><h2>Movers in your universe</h2></div>${table(
    ["Asset", "Last", "Change"],
    [...all]
      .sort((a, b) => Math.abs(change(b)) - Math.abs(change(a)))
      .slice(0, 5)
      .map(
        (a) =>
          `<tr><td>${ticker(a)}</td><td>${livePrice(a)}</td><td>${liveChange(a)}</td></tr>`,
      ),
  )}</section></div>`;
}
function liveEmpty() {
  if (!native)
    return empty(
      "Live data runs in the desktop app. Switch to Demo data to explore here.",
    );
  if (!priceSource(state.sources.prices, keyInfo))
    return `<div class="empty">No price source connected yet.<br>${button("Connect a data source", "goto-settings", "primary")}</div>`;
  return empty(
    esc(syncLabel) ||
      "Loading your watchlist from " +
        providers[priceSource(state.sources.prices, keyInfo)].name +
        "…",
  );
}
function chartTools() {
  return `<div class="chart-tools"><select id="asset-select" aria-label="Chart symbol">${assets()
    .map(
      (a) =>
        `<option ${a.symbol === symbol ? "selected" : ""}>${a.symbol}</option>`,
    )
    .join(
      "",
    )}</select>${[30, 90, 252, 9999].map((n) => button(n === 9999 ? "ALL" : n + "D", "range", range === n ? "active" : "", `data-value="${n}"`)).join("")}${button(candles ? "Candles" : "Line", "chart-type")}${button("Export SVG", "chart-export")}<select id="compare" aria-label="Compare asset"><option value="">Compare…</option>${assets()
    .filter((a) => a.symbol !== symbol)
    .map(
      (a) =>
        `<option ${a.symbol === compare ? "selected" : ""}>${a.symbol}</option>`,
    )
    .join("")}</select><small>MA20 / MA50</small></div>`;
}
function chart(a, id = "price-chart") {
  return `<div class="chart" id="${id}" data-chart="${esc(a.symbol)}"></div><div class="chart-legend">${compare ? "Comparison normalized to first common date · " : ""}Hover to inspect · mouse wheel to zoom · trade markers show executions</div>`;
}
function drawCharts(only) {
  document.querySelectorAll("[data-chart]").forEach((el) => {
    if (only && ((!only.has(el.dataset.chart) && !only.has(compare)) || el.matches(":hover"))) return;
    const a = activeMap()[el.dataset.chart];
    let bars = a.bars.slice(-range);
    if (!bars.length) return;
    // Draw at the element's real pixel width so text never scales with the screen.
    const W = Math.max(480, Math.round(el.clientWidth || 1000)),
      H = 330,
      left = 18,
      right = 80,
      top = 25,
      bottom = 40,
      iw = W - left - right,
      ih = H - top - bottom;
    const peer = activeMap()[compare];
    let peerMap = new Map(peer?.bars.map((b) => [b.date, b.close]) || []);
    const first = bars.find((b) => peerMap.has(b.date));
    const scalePeer = (v) =>
      first ? (v / peerMap.get(first.date)) * first.close : v;
    let values = bars.flatMap((b) => [b.low, b.high]);
    if (compare && first)
      values.push(
        ...bars
          .filter((b) => peerMap.has(b.date))
          .map((b) => scalePeer(peerMap.get(b.date))),
      );
    let low = Math.min(...values) * 0.99,
      high = Math.max(...values) * 1.01;
    const y = (v) => top + ((high - v) / (high - low)) * ih,
      x = (i) => left + ((i + 0.5) / bars.length) * iw;
    let out = "";
    for (let i = 0; i < 5; i++) {
      const v = low + ((high - low) * i) / 4;
      out += `<line x1="${left}" y1="${y(v)}" x2="${W - right}" y2="${y(v)}" class="gridline"/><text x="${W - right + 12}" y="${y(v) + 4}">${fmt(v)}</text>`;
    }
    const volMax = Math.max(...bars.map((b) => b.volume), 1);
    out += bars
      .map(
        (b, i) =>
          `<rect x="${x(i) - (iw / bars.length) * 0.32}" y="${H - bottom - (b.volume / volMax) * 45}" width="${(iw / bars.length) * 0.64}" height="${(b.volume / volMax) * 45}" fill="${b.close >= b.open ? "#4cc38a" : "#f0716a"}" opacity=".12"/>`,
      )
      .join("");
    if (candles)
      out += bars
        .map((b, i) => {
          const color = b.close >= b.open ? "#4cc38a" : "#f0716a";
          return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${color}"/><rect x="${x(i) - Math.max(1, (iw / bars.length) * 0.3)}" y="${y(Math.max(b.close, b.open))}" width="${Math.max(1, (iw / bars.length) * 0.6)}" height="${Math.max(1, Math.abs(y(b.open) - y(b.close)))}" fill="${color}"/>`;
        })
        .join("");
    else
      out += `<polyline clip-path="url(#plot-area)" fill="none" stroke="#f5f5f5" stroke-width="2" points="${bars.map((b, i) => `${x(i)},${y(b.close)}`).join(" ")}"/>`;
    for (const [n, c] of [
      [20, "#a3a3a3"],
      [50, "#5c5c5c"],
    ]) {
      const ma = sma(a.bars, n).slice(-bars.length);
      out += `<polyline clip-path="url(#plot-area)" fill="none" stroke="${c}" stroke-width="1.5" points="${ma
        .map((v, i) => (v === null ? "" : `${x(i)},${y(v)}`))
        .filter(Boolean)
        .join(" ")}"/>`;
    }
    if (compare && first)
      out += `<polyline clip-path="url(#plot-area)" fill="none" stroke="#ffffff" stroke-dasharray="5 4" stroke-width="1.5" points="${bars
        .map((b, i) =>
          peerMap.has(b.date)
            ? `${x(i)},${y(scalePeer(peerMap.get(b.date)))}`
            : "",
        )
        .filter(Boolean)
        .join(" ")}"/>`;
    for (const t of account().trades.filter((t) => t.symbol === a.symbol)) {
      const i = bars.findIndex((b) => b.date === t.date.slice(0, 10));
      if (i >= 0)
        out += `<circle cx="${x(i)}" cy="${y(t.price)}" r="6" fill="${t.side === "buy" ? "#fff" : "#f0716a"}"><title>${esc(t.side)} ${t.qty} @ ${t.price}</title></circle>`;
    }
    for (const i of [0, Math.floor(bars.length / 2), bars.length - 1])
      out += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${bars[i].date}</text>`;
    el.innerHTML = `<div class="chart-readout">${esc(a.symbol)} · ${bars.at(-1).date} · ${money(bars.at(-1).close)}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${a.symbol} daily price chart"><defs><clipPath id="plot-area"><rect x="${left}" y="${top}" width="${iw}" height="${ih}"/></clipPath></defs>${out}<line id="crosshair" y1="${top}" y2="${H - bottom}" stroke="#8d8d8d" stroke-dasharray="4" visibility="hidden"/></svg>`;
    el.onpointermove = (e) => {
      const rect = el.querySelector("svg").getBoundingClientRect();
      const i = Math.max(
        0,
        Math.min(
          bars.length - 1,
          Math.floor(
            ((((e.clientX - rect.left) / rect.width) * W - left) / iw) *
              bars.length,
          ),
        ),
      );
      const b = bars[i];
      el.querySelector(".chart-readout").textContent =
        `${a.symbol} · ${b.date}   O ${fmt(b.open)}   H ${fmt(b.high)}   L ${fmt(b.low)}   C ${fmt(b.close)}   VOL ${compact(b.volume)}`;
      const cross = el.querySelector("#crosshair");
      cross.setAttribute("x1", x(i));
      cross.setAttribute("x2", x(i));
      cross.setAttribute("visibility", "visible");
    };
    el.onwheel = (e) => {
      e.preventDefault();
      range = Math.max(
        20,
        Math.min(
          a.bars.length,
          Math.round(
            Math.min(range, a.bars.length) * (e.deltaY > 0 ? 1.2 : 0.8),
          ),
        ),
      );
      drawCharts();
    };
  });
}
// ---- Reference data status (13F holdings, listing directory) ---------------
let refStatus = null, // holdings_status
  uniStatus = null, // universe_status
  refTimer = null;
function jobLine(job, idle = "") {
  if (!job) return idle;
  if (job.running) {
    const p = job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
    return `<span class="job">${esc(job.stage)}${p != null ? ` · ${p}%` : ""}</span>${p != null ? `<progress max="100" value="${p}"></progress>` : ""}`;
  }
  if (job.error) return `<span class="down">${esc(job.error)}</span>`;
  return job.finished ? `<span class="muted">${esc(job.stage)} · ${new Date(job.finished * 1000).toLocaleString()}</span>` : idle;
}
function paintJobs() {
  document.querySelectorAll("[data-job]").forEach((el) => {
    const j = el.dataset.job;
    el.innerHTML = jobLine(j === "holdings" ? refStatus?.job : j === "market" ? marketInfo?.job : uniStatus?.job);
  });
}
async function readReference() {
  if (!native) return;
  try {
    [refStatus, uniStatus] = await Promise.all([holdingsStatus(), universeStatus()]);
  } catch (e) {
    lastError.reference = message(e);
  }
}
// Polls while a download runs, then re-renders with the new data.
async function watchReference() {
  await readReference();
  paintJobs();
  if (refTimer || !(refStatus?.job?.running || uniStatus?.job?.running)) return;
  refTimer = setInterval(async () => {
    const was = { h: refStatus?.job?.running, u: uniStatus?.job?.running };
    await readReference();
    paintJobs();
    if (refStatus?.job?.running || uniStatus?.job?.running) return;
    clearInterval(refTimer);
    refTimer = null;
    if (was.h) for (const d of Object.values(hdsData)) delete d.holders;
    if (was.u) uni.data = uni.facets = null;
    refresh();
  }, 1000);
}
// The listing directory loads by itself (no key); 13F data refreshes by
// itself once the user has downloaded it the first time.
async function autoReference() {
  if (!native) return;
  await readReference();
  const week = 7 * 86400;
  if (uniStatus && (!uniStatus.listings || Date.now() / 1000 - (uniStatus.fetched || 0) > week)) await universeRefresh().catch((e) => (lastError.reference = message(e)));
  // 13F holdings: the first download starts as soon as SEC's contact email
  // is saved; after that the app checks for a new quarter every few days.
  // Also resumes when fewer quarters are loaded than wanted (a download cut
  // short by closing the app); quarters already loaded are kept.
  const want = state.holdings?.quarters || 2;
  const missing = (refStatus?.quarters?.length || 0) < want && !refStatus?.job?.running && !refStatus?.job?.error;
  if (hasKey("sec") && (missing || Date.now() - (state.holdings?.checked || 0) > 3 * 864e5)) {
    state.holdings = { quarters: 2, ...(state.holdings || {}), checked: Date.now() };
    await holdingsUpdate(state.holdings.quarters).catch((e) => (lastError.sec = message(e)));
    persist();
  }
  watchReference();
}
// ---- Holders (HDS) ----------------------------------------------------------
const hds = { tab: "institutions", filter: "all", q: "", sort: "value", dir: -1, limit: 100, fund: null, fundFilter: "all", fundSort: "value", fundLimit: 100, insiderSince: "" };
const hdsData = {}; // ticker -> loaded holder data for this session
const hdsTicker = () => (symbol || "").toUpperCase();
const hdsEntry = (t) => (hdsData[t] ||= { errors: {}, loading: {}, only: null, period: null });
function openHolders(t) {
  openStock(t || symbol, "HDS");
}
async function companyName(t) {
  const a = activeMap()[t];
  const known = a?.overview?.Name || state.secData?.[t]?.name || (a?.name !== t ? a?.name : "");
  if (known) return known;
  const l = await universeGet(t).catch(() => null);
  return l?.name || t;
}
function loadHolders(t, force = false) {
  const d = hdsEntry(t);
  if (!native || d.loading.holders || (!force && (d.holders || d.errors.holders))) return;
  if (!refStatus?.quarters?.length) return;
  d.loading.holders = true;
  (async () => {
    d.name ||= await companyName(t);
    const extra = [...new Set((d.schedules || []).flatMap((s) => s.cusips))].slice(0, 10);
    d.holders = await holdersFor(t, d.name, extra, d.only, d.period);
    d.comp = null;
    delete d.errors.holders;
  })()
    .catch((e) => (d.errors.holders = message(e)))
    .finally(() => {
      d.loading.holders = false;
      refresh();
    });
}
// 5%+ owners and insiders from the company's own EDGAR filing list.
function loadOwnership(t) {
  const d = hdsEntry(t);
  if (!native || d.loading.sec || d.secDone || d.errors.sec || !isUSKey(t)) return;
  if (!hasKey("sec") && !cikFor(t)) return;
  d.loading.sec = true;
  (async () => {
    d.cik ||= await resolveCIK(t);
    const [sub, shares] = await Promise.all([fetchSEC("submissions", d.cik), fetchSEC("shares", d.cik).catch(() => null)]);
    d.series = shares ? sharesSeries(shares.data) : [];
    if (sub.data.name) d.name = prettyName(sub.data.name);
    const f = ownershipFilings(sub.data);
    Object.assign(d, { legacy: f.legacy, scheduleList: f.schedules, insiderList: f.insiders, comp: null });
    refresh();
    if (!hasKey("sec")) throw Error("Add your SEC contact email in Settings → Data sources to read 13D/G and Form 4 filings.");
    d.schedules = [];
    const list = f.schedules.slice(0, 40);
    d.scheduleProgress = { done: 0, total: list.length };
    for (const s of list) {
      // Another stock is open: stop so its filings come first. Reads resume
      // (mostly from cache) when this stock is opened again.
      if (symbol !== t) return;
      try {
        const xml = (await fetchSEC("xml", d.cik, s.accession, s.doc)).data.xml;
        d.schedules.push({ ...parseSchedule13(xml), filed: s.filed, accession: s.accession, url: s.url });
      } catch {
        // Skip one unreadable filing.
      }
      d.scheduleProgress.done++;
    }
    d.scheduleProgress = null;
    if (!d.holders?.securities?.length && d.schedules.some((s) => s.cusips.length)) loadHolders(t, true);
    refresh();
    if (!(await loadInsiders(t, 40))) return;
    d.secDone = true;
  })()
    .catch((e) => (d.errors.sec = message(e)))
    .finally(() => {
      d.loading.sec = false;
      d.scheduleProgress = null;
      refresh();
    });
}
async function loadInsiders(t, n) {
  const d = hdsEntry(t);
  d.insiderForms ||= [];
  const have = new Set(d.insiderForms.map((f) => f.accession));
  const todo = (d.insiderList || []).filter((f) => !have.has(f.accession)).slice(0, n);
  d.insiderProgress = { done: 0, total: todo.length };
  for (const f of todo) {
    if (symbol !== t) {
      d.insiderProgress = null;
      return false;
    }
    try {
      const xml = (await fetchSEC("xml", d.cik, f.accession, f.doc)).data.xml;
      d.insiderForms.push({ ...parseOwnership(xml), filed: f.filed, accession: f.accession, url: f.url });
    } catch {
      // Skip one unreadable filing.
    }
    d.insiderProgress.done++;
    if (d.insiderProgress.done % 8 === 0) refresh();
  }
  d.insiderProgress = null;
  d.insiderView = null;
  return true;
}
function sharesOutFor(d) {
  return sharesAt(d.series, d.holders?.period || new Date().toISOString().slice(0, 10));
}
function holderComparison(d) {
  if (!d.holders) return null;
  return (d.comp ||= compareHolders(d.holders, sharesOutFor(d)?.shares ?? null));
}
const int = (x) => (x == null || !Number.isFinite(+x) ? "—" : Math.round(x).toLocaleString("en-US"));
const signed = (x, f = int) => (x == null ? "—" : x > 0 ? "+" + f(x) : f(x));
const toneOf = (x) => (x > 0 ? "up" : x < 0 ? "down" : "");
const usd = (x) => (x == null ? "—" : (x < 0 ? "−$" : "$") + compact(Math.abs(x)));
function sortable(label, key, current, dir, act = "hds-sort") {
  const on = current === key;
  return `<button class="th-sort ${on ? "on" : ""}" data-action="${act}" data-value="${key}">${label}${on ? (dir < 0 ? " ▼" : " ▲") : ""}</button>`;
}
function sortBy(rows, key, dir) {
  const v = (r) => (r[key] == null ? -Infinity : typeof r[key] === "string" ? r[key].toUpperCase() : r[key]);
  return [...rows].sort((a, b) => (v(a) < v(b) ? -dir : v(a) > v(b) ? dir : 0));
}
const HOLDER_FILTERS = [
  ["all", "All"],
  ["new", "New"],
  ["added", "Added"],
  ["reduced", "Reduced"],
  ["exited", "Sold out"],
  ["not-filed", "No filing yet"],
  ["conviction", "≥1% of portfolio"],
  ["top", "Top-10 holding"],
];
function holderRows(c) {
  const q = hds.q.trim().toUpperCase();
  const f = hds.filter;
  return c.holders.filter((h) => {
    if (q && !`${h.name} ${h.city} ${h.state}`.toUpperCase().includes(q)) return false;
    if (f === "all") return h.shares > 0;
    if (f === "conviction") return h.weight >= 0.01;
    if (f === "top") return h.rank != null && h.rank <= 10;
    return h.status === f;
  });
}
function filingIndex(cik, accession) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${String(accession).replace(/-/g, "")}/`;
}
// 13F data downloads by itself once SEC's contact email is saved; this
// panel shows progress, or what's missing.
function holdersSetup() {
  const job = refStatus?.job;
  const q = state.holdings?.quarters || 2;
  const intro = `<p>Every investment manager with $100 million or more in US-listed securities files Form 13F each quarter. SEC publishes them together as one file per quarter (about 100 MB to download, 200 MB once loaded), so you see every disclosed manager for every US-listed stock, ETF and ADR.</p>`;
  if (!hasKey("sec"))
    return `<section class="panel"><div class="panel-head"><h2>Institutional holdings</h2></div>${intro}<p><b>SEC asks for a contact email before bulk downloads.</b> Add it once and the download starts by itself. ${button("Add it in Settings", "goto-settings", "primary")}</p></section>`;
  const status = job?.running ? "Downloading SEC 13F data. You can keep using the app meanwhile." : job?.error ? "The last download failed." : "Starting the SEC 13F download…";
  return `<section class="panel"><div class="panel-head"><h2>Institutional holdings</h2>${job?.error ? button("Try again", "hds-download", "primary") : ""}</div>${intro}<p>${esc(status)}</p><div class="job-line" data-job="holdings">${jobLine(job)}</div><small>Keeping ${q} quarters (about ${q * 200} MB); change it in Settings → Reference data. After the first download the app checks SEC for a new quarter every few days. 13F data sets appear about a month after the filing deadline (45 days after quarter end).</small></section>`;
}
function securitiesLine(d) {
  const h = d.holders;
  if (!h) return "";
  const included = new Set(h.included || []);
  const chip = (s) => `<label class="chip"><input type="checkbox" data-cusip="${esc(s.cusip)}" ${included.has(s.cusip) ? "checked" : ""}> <b>${esc(s.cusip)}</b> ${esc(prettyName(s.issuer || ""))} ${esc(s.class || "")} · ${int(s.holders)} holders <small>${esc(s.source)}</small></label>`;
  const all = [...(h.securities || []), ...(h.related || [])];
  if (!all.length) return "";
  return `<div class="chips">${all.map(chip).join("")}${button("Update", "hds-securities")}</div>`;
}
function holderStats(d, c) {
  const s = c?.summary;
  const out = sharesOutFor(d);
  const big = d.bigView || [];
  const ins = d.insiderView?.summary;
  const tiles = [];
  if (s) {
    tiles.push(
      stat("13F holders", int(s.holders), `${signed(s.holders - s.prevHolders)} vs ${esc(c.prior || "—")}`),
      stat("Shares held by 13F filers", compact(s.shares), s.prevShares ? `${signed(s.shares / s.prevShares - 1, pct)} vs prior quarter` : ""),
      stat("% of shares outstanding", pct(s.pctOut), out ? `${compact(out.shares)} shares out at ${esc(out.date)}${out.classes > 1 ? ` (${out.classes} classes)` : ""}` : "Shares outstanding not loaded"),
      stat("Value at quarter end", usd(s.value), s.price ? `≈ $${fmt(s.price)} per share` : ""),
      stat("New · sold out", `${int(s.newPositions)} · ${int(s.exited)}`, s.notFiled ? `${int(s.notFiled)} prior holders haven't filed yet` : "All prior holders have filed"),
      stat("Added · reduced", `${int(s.added)} · ${int(s.reduced)}`, `${int(s.unchanged)} unchanged`),
      stat("Net shares bought", `<span class="${toneOf(s.netChange)}">${signed(s.netChange, compact)}</span>`, `Bought ${compact(s.bought)} · sold ${compact(s.sold)}`),
      stat("Top 10 holders", pct(s.top10Share), "of shares held by 13F filers"),
      stat("High conviction", int(s.highConviction), `holders with ≥1% of their portfolio here · #1 holding for ${int(s.topHolding)}`),
      stat("Median portfolio weight", pct(s.medianWeight), "across holders"),
      stat("13F put/call ratio", fmt(s.putCall), `${int(s.putHolders)} put and ${int(s.callHolders)} call holders`),
    );
  }
  if (d.schedules) tiles.push(stat("5%+ owners", int(big.filter((b) => !b.below5).length), "latest Schedule 13D/G per filer"));
  if (ins) tiles.push(stat("Insider buys · sales", `${int(ins.buys)} · ${int(ins.sells)}`, `open-market, in the ${int(d.insiderForms?.length)} latest Forms 3/4/5`));
  return tiles.length ? `<div class="stats hds-stats">${tiles.join("")}</div>` : "";
}
function institutionsTab(d, c) {
  if (!refStatus?.quarters?.length) return holdersSetup();
  if (d.errors.holders) return `<section class="panel">${empty(esc(d.errors.holders))}</section>`;
  if (!d.holders) return `<section class="panel">${empty("Loading 13F holders…")}</section>`;
  if (!d.holders.included?.length)
    return `<section class="panel">${empty(`No 13F securities found for ${esc(hdsTicker())}. 13F covers US-listed stocks, ETFs and ADRs; ${d.loading.sec ? "checking 13G cover pages for a CUSIP…" : "this one may not be on SEC's 13(f) list."}`)}</section>`;
  const rows = sortBy(holderRows(c), hds.sort, hds.dir);
  const shown = rows.slice(0, hds.limit);
  const H = (l, k) => sortable(l, k, hds.sort, hds.dir);
  const sm = c.summary;
  const counts = { all: sm.holders, new: sm.newPositions, added: sm.added, reduced: sm.reduced, exited: sm.exited, "not-filed": sm.notFiled, conviction: sm.highConviction, top: c.holders.filter((h) => h.rank != null && h.rank <= 10).length };
  return `<section class="panel"><div class="panel-head"><h2>Institutional holders <small>Form 13F · quarter ending ${esc(c.period)} vs ${esc(c.prior || "—")}</small></h2><input id="hds-q" placeholder="Filter by manager or city" value="${esc(hds.q)}" aria-label="Filter holders"></div><div class="filters segmented">${HOLDER_FILTERS.map(([k, l]) => button(`${l} <small>${int(counts[k])}</small>`, "hds-filter", hds.filter === k ? "active" : "", `data-value="${k}"`)).join("")}</div>${table(
    [H("Holder", "name"), H("Shares", "shares"), H("Change", "change"), H("Change %", "changePct"), H("Value", "value"), H("% out", "pctOut"), H("% of portfolio", "weight"), H("Rank in portfolio", "rank"), H("Positions", "positions"), H("Portfolio", "portfolio"), H("Quarters held", "quarters"), "Status", "Voting sole / shared / none", "Discretion", H("Filed", "filed")],
    shown.map(
      (h) =>
        `<tr><td class="holder"><button class="link" data-action="hds-fund" data-value="${h.cik}">${esc(prettyName(h.name))}</button><small>${esc([h.city, h.state].filter(Boolean).join(", "))}</small></td><td>${int(h.shares)}</td><td class="${toneOf(h.change)}">${signed(h.change)}</td><td class="${toneOf(h.changePct)}">${h.changePct == null ? "—" : signed(h.changePct, pct)}</td><td>${usd(h.value)}</td><td>${pct(h.pctOut)}</td><td>${pct(h.weight)}</td><td>${h.rank ?? "—"}</td><td>${int(h.positions)}</td><td>${usd(h.portfolio)}</td><td>${h.quarters ? `${h.quarters} <small>since ${esc(h.since)}</small>` : "—"}</td><td><span class="pill st-${h.status}">${STATUS_LABEL[h.status]}</span></td><td><small>${int(h.sole)} / ${int(h.sharedVote)} / ${int(h.noVote)}</small></td><td>${esc(h.discretion || "—")}</td><td>${link(filingIndex(h.cik, h.accession), h.filed)}</td></tr>`,
    ),
  )}${rows.length > shown.length ? button(`Show ${Math.min(500, rows.length - shown.length)} more of ${int(rows.length - shown.length)}`, "hds-more") : ""}<small>Value is the manager's reported market value at quarter end (US dollars). Shares are reported shares or principal amount. "% of portfolio" is the position's share of everything the manager reported, a measure of conviction. "Rank" is its place among the manager's positions by value (1 = largest). "No filing yet" means a prior holder hasn't filed for this quarter, not that it sold. 13F excludes short positions, non-US securities and managers under $100M.</small></section>`;
}
function optionsTab(c) {
  if (!c) return `<section class="panel">${empty("Load 13F data on the Institutions tab first.")}</section>`;
  const rows = c.options;
  return `<section class="panel"><div class="panel-head"><h2>Options positions <small>13F puts and calls · quarter ending ${esc(c.period)}</small></h2></div>${rows.length ? table(["Holder", "Type", "Underlying shares", "Change", "Notional value", "Status", "Filed"], rows.map((o) => `<tr><td><button class="link" data-action="hds-fund" data-value="${o.cik}">${esc(prettyName(o.name))}</button></td><td>${o.type}</td><td>${int(o.shares)}</td><td class="${toneOf(o.change)}">${signed(o.change)}</td><td>${usd(o.value)}</td><td><span class="pill st-${o.status}">${STATUS_LABEL[o.status]}</span></td><td>${link(filingIndex(o.cik, o.accession), o.filed)}</td></tr>`)) : empty("No 13F filer reported puts or calls on this security.")}<small>Managers report options by underlying shares and the value of those shares, not premium. Puts are not necessarily bearish (they often hedge a long position).</small></section>`;
}
function historyTab(d) {
  const h = d.holders?.history;
  if (!h?.length) return `<section class="panel">${empty(refStatus?.quarters?.length ? "Loading ownership history…" : "Download 13F data to see ownership history.")}</section>`;
  const rows = ownershipHistory(h, d.series).reverse();
  return `<section class="panel"><div class="panel-head"><h2>Ownership by quarter <small>${rows.length} quarters loaded</small></h2>${spark(rows.map((r) => r.holders).reverse())}</div>${table(
    ["Quarter", "13F holders", "Shares held", "% of shares out", "Value", "Put holders", "Put shares", "Call holders", "Call shares"],
    rows.map((r) => `<tr><td>${esc(r.period)}</td><td>${int(r.holders)}</td><td>${int(r.shares)}</td><td>${pct(r.pctOut)}</td><td>${usd(r.value)}</td><td>${int(r.putHolders)}</td><td>${int(r.putShares)}</td><td>${int(r.callHolders)}</td><td>${int(r.callShares)}</td></tr>`),
  )}<small>Keep more quarters in Settings → Reference data for a longer history. Shares outstanding come from the company's own cover-page filings nearest each quarter.</small></section>`;
}
function bigTab(d) {
  if (!isUSKey(hdsTicker())) return `<section class="panel">${empty("Schedules 13D and 13G are SEC filings for US-registered companies.")}</section>`;
  const p = d.scheduleProgress;
  const rows = (d.bigView ||= d.schedules ? bigHolders(d.schedules) : null);
  const head = `<div class="panel-head"><h2>5%+ beneficial owners <small>Schedules 13D (activist) and 13G (passive)</small></h2>${p ? `<span class="muted">Reading filings ${p.done}/${p.total}…</span>` : ""}</div>`;
  if (d.errors.sec && !rows) return `<section class="panel">${head}${empty(esc(d.errors.sec))}</section>`;
  if (!rows) return `<section class="panel">${head}${empty(hasKey("sec") ? "Loading Schedule 13D/G filings from EDGAR…" : "Add your SEC contact email in Settings → Data sources to read these filings.")}</section>`;
  const legacy = d.legacy || [];
  return `<section class="panel">${head}${rows.length ? table(
    ["Owner", "Type", "Shares", "% of class", "Change vs prior filing", "Sole vote", "Shared vote", "Sole dispose", "Shared dispose", "Form", "Event date", "Filed"],
    rows.map((b) => `<tr class="${b.below5 ? "faded" : ""}"><td class="holder">${esc(prettyName(b.name))}${b.members > 1 ? `<small>${b.members} reporting persons</small>` : ""}</td><td>${esc(b.typeLabel || "—")}</td><td>${int(b.shares)}</td><td>${b.percent == null ? "—" : fmt(b.percent) + "%"}${b.below5 ? ` <span class="pill">below 5%</span>` : ""}</td><td class="${toneOf(b.change)}">${signed(b.change)}${b.prevPercent != null ? ` <small>was ${fmt(b.prevPercent)}%</small>` : ""}</td><td>${int(b.soleVote)}</td><td>${int(b.sharedVote)}</td><td>${int(b.soleDispose)}</td><td>${int(b.sharedDispose)}</td><td>${esc(b.form)}${b.activist ? ' <span class="pill warn">activist</span>' : ""}</td><td>${esc(b.eventDate || "—")}</td><td>${link(b.url, b.filed)}</td></tr>${b.purpose ? `<tr class="sub"><td colspan="12"><small>Purpose (Item 4): ${esc(b.purpose.slice(0, 600))}${b.purpose.length > 600 ? "…" : ""}</small></td></tr>` : ""}`),
  ) : empty("No structured Schedule 13D/G filings name this company.")}<small>A 13G is filed by passive investors above 5%, a 13D by anyone who may seek influence. Percent is of the class at the event date. A filing below 5% usually reports an exit from the 5% level. Structured filings began in December 2024${legacy.length ? `; ${legacy.length} older text filings: ${legacy.slice(0, 6).map((l) => link(l.url, `${l.form} ${l.filed}`)).join(", ")}` : ""}.</small></section>`;
}
function insidersTab(d) {
  if (!isUSKey(hdsTicker())) return `<section class="panel">${empty("Forms 3, 4 and 5 are SEC filings for US-registered companies.")}</section>`;
  const p = d.insiderProgress;
  const head = (h, extra = "") => `<div class="panel-head"><h2>${h}</h2>${p ? `<span class="muted">Reading Forms 3/4/5 ${p.done}/${p.total}…</span>` : extra}</div>`;
  if (!d.insiderForms?.length) return `<section class="panel">${head("Insiders <small>Forms 3, 4 and 5</small>")}${empty(esc(d.errors.sec || (hasKey("sec") ? "Loading insider filings from EDGAR…" : "Add your SEC contact email in Settings → Data sources to read insider filings.")))}</section>`;
  const v = (d.insiderView ||= insiderSummary(d.insiderForms));
  const out = sharesOutFor(d)?.shares;
  const more = (d.insiderList?.length || 0) > d.insiderForms.length;
  const codes = hds.insiderCodes || "open";
  const log = v.log.filter((x) => (codes === "all" ? true : codes === "open" ? x.code === "P" || x.code === "S" : !x.derivative));
  return `<section class="panel">${head(`Insiders <small>${v.people.length} people in the ${d.insiderForms.length} latest Forms 3/4/5</small>`, more ? button("Read 40 older forms", "hds-insiders-more") : "")}<div class="stats">${stat("Open-market buys", int(v.summary.buys), `${int(v.summary.buyers)} people · ${compact(v.summary.boughtShares)} shares · ${usd(v.summary.boughtValue)}`)}${stat("Open-market sales", int(v.summary.sells), `${int(v.summary.sellers)} people · ${compact(v.summary.soldShares)} shares · ${usd(v.summary.soldValue)}`)}${stat("Sales under 10b5-1 plans", int(v.summary.planSales), "pre-scheduled trading plans")}</div>${table(
    ["Insider", "Role", "Direct shares", "Indirect shares", "% of shares out", "Bought", "Sold", "Last form"],
    v.people.map((x) => `<tr><td class="holder">${esc(prettyName(x.name))}</td><td>${esc(x.role)}</td><td>${int(x.direct)}</td><td>${int(x.indirect)}</td><td>${pct(out ? ((x.direct || 0) + (x.indirect || 0)) / out : null)}</td><td class="up">${x.bought ? int(x.bought) : "—"}</td><td class="down">${x.sold ? int(x.sold) : "—"}</td><td>${link(x.url, `Form ${x.lastForm} · ${x.lastFiled}`)}</td></tr>`),
  )}</section><section class="panel"><div class="panel-head"><h2>Insider transactions</h2><select id="hds-codes" aria-label="Transactions shown"><option value="open" ${codes === "open" ? "selected" : ""}>Open-market buys and sales</option><option value="stock" ${codes === "stock" ? "selected" : ""}>All stock transactions</option><option value="all" ${codes === "all" ? "selected" : ""}>Everything, including options</option></select></div>${log.length ? table(
    ["Date", "Insider", "Role", "Transaction", "Security", "Shares", "Price", "Value", "Owned after", "Ownership", "Plan", "Filing"],
    log.slice(0, 300).map((x) => `<tr><td>${esc(x.date || x.filed)}</td><td>${esc(prettyName(x.owner))}</td><td><small>${esc(x.role)}</small></td><td class="${x.code === "P" ? "up" : x.code === "S" ? "down" : ""}">${esc(x.code)} · ${esc(TX_CODES[x.code] || "")}</td><td><small>${esc(x.security)}</small></td><td>${x.ad === "D" ? "−" : ""}${int(x.shares)}</td><td>${x.price ? "$" + fmt(x.price) : "—"}</td><td>${usd(x.value)}</td><td>${int(x.after)}</td><td>${x.direct ? "Direct" : esc(x.nature || "Indirect")}</td><td>${x.plan ? "10b5-1" : ""}</td><td>${link(x.url, `Form ${x.form}`)}</td></tr>`),
  ) : empty("No transactions of this kind in the forms read so far.")}<small>Holdings are each person's position after their latest form. Code S is an open-market sale and P a purchase; awards (A), tax withholding (F) and option exercises (M) are not market trades.</small></section>`;
}
function fundPanel() {
  const f = hds.fund;
  if (!f) return "";
  if (!f.data) return `<section class="panel fund"><div class="panel-head"><h2>Manager portfolio</h2>${button("Close", "hds-fund-close")}</div>${empty(esc(f.error || "Loading the manager's full 13F portfolio…"))}</section>`;
  const v = (f.view ||= comparePortfolio(f.data));
  const s = v.summary,
    info = v.filing || {};
  const rows = sortBy(v.rows.filter((r) => hds.fundFilter === "all" || r.status === hds.fundFilter), hds.fundSort, -1);
  const shown = rows.slice(0, hds.fundLimit);
  const H = (l, k) => sortable(l, k, hds.fundSort, -1, "hds-fund-sort");
  return `<section class="panel fund"><div class="panel-head"><h2>${esc(prettyName(info.name || "CIK " + f.cik))} <small>${esc([info.city, info.state].filter(Boolean).join(", "))} · CIK ${f.cik} · 13F for ${esc(v.period)}</small></h2>${link(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${f.cik}&type=13F`, "13F filings on EDGAR")}${button("Export CSV", "hds-fund-export")}${button("Close", "hds-fund-close")}</div><div class="stats">${stat("Reported value", usd(s.total), s.prevTotal ? `${signed(s.total / s.prevTotal - 1, pct)} vs ${esc(v.prior)}` : "")}${stat("Positions", int(s.positions), s.prevPositions != null ? `${signed(s.positions - s.prevPositions)} vs prior quarter` : "")}${stat("New · sold out", `${int(s.newPositions)} · ${int(s.exited)}`, `${int(s.added)} added · ${int(s.reduced)} reduced`)}${stat("Estimated buying · selling", `${usd(s.bought)} · ${usd(s.sold)}`, "share changes × quarter-end price")}${stat("Top 10 weight", pct(s.top10Weight), `${int(s.options)} option positions`)}</div><div class="filters segmented">${[["all", "All"], ["new", "New"], ["added", "Added"], ["reduced", "Reduced"], ["exited", "Sold out"]].map(([k, l]) => button(l, "hds-fund-filter", hds.fundFilter === k ? "active" : "", `data-value="${k}"`)).join("")}</div>${table(
    [H("Issuer", "issuer"), H("Rank", "rank"), "Class", "CUSIP", H("Shares", "shares"), H("Change", "change"), H("Change %", "changePct"), H("Value", "value"), H("Weight", "weight"), H("Est. flow", "flow"), "Status"],
    shown.map((r) => `<tr><td class="holder">${r.ticker ? `<button class="link" data-action="hds-open" data-value="${esc(r.ticker)}">${esc(r.ticker)}</button> ` : ""}${esc(prettyName(r.issuer || ""))}${r.putcall ? ` <span class="pill">${r.putcall === 1 ? "Put" : "Call"}</span>` : ""}</td><td>${r.rank ?? "—"}</td><td><small>${esc(r.class || "")}</small></td><td><small>${esc(r.cusip)}</small></td><td>${int(r.shares)}</td><td class="${toneOf(r.change)}">${signed(r.change)}</td><td>${r.changePct == null ? "—" : signed(r.changePct, pct)}</td><td>${usd(r.value)}</td><td>${pct(r.weight)}</td><td class="${toneOf(r.flow)}">${r.flow == null ? "—" : signed(r.flow, usd)}</td><td><span class="pill st-${r.status}">${STATUS_LABEL[r.status]}</span></td></tr>`),
  )}${rows.length > shown.length ? button(`Show more (${int(rows.length - shown.length)} left)`, "hds-fund-more") : ""}<small>Tickers come from SEC's fails-to-deliver lists; click one to see its holders. Estimated flow assumes trades at the quarter-end price.</small></section>`;
}
function holdersPage() {
  const t = hdsTicker();
  if (!native) return `<section class="panel">${empty("Holder data comes from SEC filings and loads in the desktop app.")}</section>`;
  if (!t) return `<section class="panel">${empty("Type a ticker followed by HDS in the search box, for example AAPL HDS.")}</section>`;
  const d = hdsEntry(t);
  const c = holderComparison(d);
  if (d.schedules && !d.bigView) d.bigView = bigHolders(d.schedules);
  if (d.insiderForms?.length && !d.insiderView) d.insiderView = insiderSummary(d.insiderForms);
  const quarters = d.holders?.quarters || refStatus?.quarters || [];
  const tabs = [
    ["institutions", "Institutions (13F)"],
    ["big", "5%+ owners (13D/G)"],
    ["insiders", "Insiders (Forms 3/4/5)"],
    ["options", "Options (13F)"],
    ["history", "History"],
  ];
  const head = `<section class="panel"><div class="panel-head"><h2>Holders <small>SEC 13F, 13D/G and Forms 3/4/5</small></h2>${quarters.length ? `<label class="inline">Quarter<select id="hds-period">${quarters.map((q) => `<option value="${esc(q.period)}" ${q.period === (d.period || d.holders?.period) ? "selected" : ""}>${esc(q.period)} · ${int(q.filers)} managers</option>`).join("")}</select></label>` : ""}${button("Export CSV", "hds-export")}${button("Reload", "hds-reload")}</div>${securitiesLine(d)}<div class="tabs">${tabs.map(([k, l]) => button(l, "hds-tab", hds.tab === k ? "active" : "", `data-value="${k}"`)).join("")}</div></section>`;
  const body = { institutions: () => institutionsTab(d, c), big: () => bigTab(d), insiders: () => insidersTab(d), options: () => optionsTab(c), history: () => historyTab(d) }[hds.tab]();
  return head + holderStats(d, c) + (["institutions", "options"].includes(hds.tab) ? fundPanel() : "") + body + `<small class="source-note">Sources: SEC Form 13F data sets (${esc((refStatus?.sets || []).map((s) => s.name.replace("_form13f", "")).join(", ") || "not downloaded")}), SEC fails-to-deliver files for ticker ↔ CUSIP, EDGAR Schedules 13D/G and Forms 3/4/5, XBRL cover-page shares outstanding. Filings are disclosures as of their dates, not live positions.</small>`;
}
// ---- Universe (every listing) ---------------------------------------------
const uni = { country: "", mic: "", kind: "", q: "", offset: 0, data: null, facets: null, loading: false, error: "" };
function loadUniverse() {
  if (!native || uni.loading || !uniStatus?.listings || (uni.data && uni.facets)) return;
  uni.loading = true;
  Promise.all([uni.facets ? null : universeFacets(), universeBrowse({ country: uni.country, mic: uni.mic, kind: uni.kind, q: uni.q, offset: uni.offset, limit: 100 })])
    .then(([f, d]) => {
      if (f) uni.facets = f;
      uni.data = d;
      uni.error = "";
    })
    .catch((e) => (uni.error = message(e)))
    .finally(() => {
      uni.loading = false;
      refresh();
    });
}
function universePage() {
  if (!native) return `<section class="panel">${empty("The world listing directory loads in the desktop app.")}</section>`;
  const s = uniStatus;
  const top = `<section class="panel"><div class="panel-head"><h2>Every listed stock and ETF <small>${s?.listings ? `${int(s.listings)} listings · ${int(s.countries)} countries · ${int(s.exchanges)} exchanges` : "not downloaded yet"}</small></h2>${button(s?.job?.running ? "Updating…" : "Update list", "uni-refresh")}</div><div class="job-line" data-job="universe">${jobLine(s?.job, s?.fetched ? `<span class="muted">Updated ${new Date(s.fetched * 1000).toLocaleString()} · Twelve Data reference lists${s.sec ? ` + ${int(s.sec)} SEC filers` : ""}</span>` : "")}</div><small>Search any of them from the box on the left. US listings open with their ticker (AAPL); others carry their exchange (VOD:XLON). Daily prices come from your price source where its plan covers that exchange; holders (HDS) cover US-listed securities.</small></section>`;
  if (!s?.listings) return top + `<section class="panel">${empty(s?.job?.running ? "Downloading the listing directory (about 75 MB)…" : esc(s?.job?.error || "Press Update list to download the directory."))}</section>`;
  const f = uni.facets;
  const sel = (id, label, opts, cur) => `<label>${label}<select id="${id}"><option value="">All</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  const countries = (f?.countries || []).filter((c) => c[0]).map((c) => [c[0], `${c[0]} (${int(c[3])})`]);
  const exchanges = (f?.exchanges || []).filter((e) => e[0] && (!uni.country || e[2] === uni.country)).map((e) => [e[0], `${e[1] || e[0]} · ${e[0]}${e[2] ? " · " + e[2] : ""} (${int(e[3])})`]);
  const kinds = [["Stock", "Stocks (common, ADR, REIT)"], ...(f?.kinds || []).filter((k) => k[0]).map((k) => [k[0], `${k[0]} (${int(k[3])})`])];
  const d = uni.data;
  const filters = `<section class="panel"><div class="filters">${sel("uni-country", "Country", countries, uni.country)}${sel("uni-mic", "Exchange", exchanges, uni.mic)}${sel("uni-kind", "Type", kinds, uni.kind)}<label>Name or ticker<input id="uni-q" value="${esc(uni.q)}" placeholder="e.g. bank, 7203, SAP"></label>${button("Search", "uni-search")}</div>${
    d
      ? `<p class="muted">${int(d.total)} matching listings${d.total > 100 ? ` · showing ${int(uni.offset + 1)}–${int(Math.min(d.total, uni.offset + 100))}` : ""}</p><div class="uni-table">${table(
          ["Ticker", "Name", "Exchange", "Country", "Currency", "Type", ""],
          d.rows.map((r) => `<tr><td><b>${esc(r.symbol)}</b></td><td>${esc(r.name)}</td><td>${esc(r.exchange || "")} <small>${esc(r.mic || "")}</small></td><td>${esc(r.country || "—")}</td><td>${esc(r.currency || "")}</td><td><small>${esc(r.kind || "—")}</small></td><td class="actions">${button("Open", "uni-open", "", `data-value="${esc(r.key)}"`)}${isUSKey(r.key) ? button("HDS", "hds-open", "", `data-value="${esc(r.key)}"`) : ""}</td></tr>`),
        )}</div><div class="pager">${uni.offset > 0 ? button("← Previous", "uni-page", "", 'data-value="-100"') : ""}${uni.offset + 100 < d.total ? button("Next →", "uni-page", "", 'data-value="100"') : ""}</div>`
      : empty(esc(uni.error || "Loading listings…"))
  }</section>`;
  return top + filters;
}
// ---- Stock page ---------------------------------------------------------------
// One loaded stock (`symbol`) and every view of it. The grid shows a summary
// panel per function; clicking a panel, its tab or typing its code (AAPL HDS)
// opens the full view. Esc goes back to the grid.
let stockView = null; // null = the panel grid, otherwise a VIEWS code
state.recent ||= [];
const tickerPattern = /^[A-Z0-9.^_&-]{1,24}(:[A-Z0-9]{3,5})?$/;
const stockAsset = () => assets().find((a) => a.symbol === symbol) || null;
const inGraph = () => page === "Stock" && stockView === "SPLC";
// Loads a stock everywhere at once. Keeps the current view when already on
// the stock page, so typing another ticker on Holders shows its holders.
function openStock(t, view = page === "Stock" ? stockView : null, meta = null) {
  t = String(t || symbol || "").trim().toUpperCase();
  if (!tickerPattern.test(t)) return notify("Enter a ticker like AAPL, or pick a listing from the search list.", true);
  const known = assets().some((a) => a.symbol === t);
  if (!known && !native) return notify("No match in demo data. Switch to Live data to look up " + t + ".", true);
  if (t !== symbol) {
    symbol = t;
    compare = "";
    Object.assign(hds, { fund: null, filter: "all", q: "", limit: 100 });
  }
  state.recent = pushRecent(state.recent, t);
  page = "Stock";
  stockView = VIEW_CODES.has(view) ? view : null;
  if (stockView === "SPLC") followGraph();
  persist().catch(() => {});
  render();
  if (!known && live()) ensureAsset(t, meta).then(refresh).catch((e) => notify(message(e), true));
}
// The relationship explorer follows the loaded stock.
function followGraph() {
  if (symbol === graphSymbol) return;
  const a = activeMap()[symbol];
  if (!centerOnTicker(symbol, a?.overview?.Name || state.secData?.[symbol]?.name)) graphSymbol = symbol;
}
// Finnhub REST datasets for the loaded stock: news, metrics, profile, earnings.
const fh = (kind, s = symbol) => (state.mode === "market" ? state.datasets[`${s}:FH_${kind}`]?.data : null);
async function loadFinnhub(kind, s) {
  const key = `${s}:FH_${kind}`;
  try {
    const d = await fetchData("finnhub", kind, s);
    state.datasets[key] = d;
    delete loadErrors[key];
    if (d.warning) lastError.finnhub = d.warning;
  } catch (e) {
    loadErrors[key] = lastError.finnhub = message(e);
    throw e;
  }
}
function stockName() {
  const a = stockAsset();
  return a?.overview?.Name || fh("profile2")?.name || (a && a.name !== symbol ? a.name : "") || state.secData?.[symbol]?.name || hdsData[symbol]?.name || "";
}
// Key statistics, calculated where possible (see keyStats in stock.js).
function stockStats() {
  const a = stockAsset();
  return keyStats({
    overview: a?.overview || {},
    metric: fh("metric")?.metric || {},
    income: state.mode === "market" ? state.datasets[`${symbol}:INCOME_STATEMENT`]?.data : null,
    basis: (state.mode === "market" && state.valuationData?.[symbol]?.basis) || {},
    price: price(a),
    bars: a?.bars || [],
  });
}
const statTile = (label, x, f) => stat(label, x.value == null ? (x.note ? "NM" : "—") : f(x.value), esc(x.value == null ? x.note || "Not available yet" : x.source));
function statTiles(k) {
  return `<div class="stats">${statTile("P/E", k.pe, (v) => fmt(v))}${statTile("Profit margin", k.margin, pct)}${statTile("Revenue growth YoY", k.growth, pct)}${statTile("Market cap", k.marketCap, compact)}</div>`;
}
function stockHead() {
  const a = stockAsset();
  const watching = state.watchlist.includes(symbol);
  const where = [a?.exchange, a?.country, a?.currency].filter(Boolean).join(" · ") || a?.sector || "";
  const quote = a ? `${livePrice(a)}${liveChange(a)}` : `<span class="muted">${live() ? "Loading prices…" : "No prices in this workspace"}</span>`;
  return `<section class="stock-head"><div class="sh-top"><div class="sh-id"><h1>${esc(symbol)}</h1><div><b>${esc(prettyName(stockName()))}</b><small>${esc(where)}</small></div></div><div class="sh-price head-price">${quote}</div><div class="sh-actions">${state.mode === "sample" ? '<span class="tag warn" title="Prices and company metrics are synthetic. Switch to Live data at the bottom of the sidebar.">Demo data · synthetic prices</span>' : ""}${button(watching ? "★ In watchlist" : "☆ Add to watchlist", "watch-toggle", watching ? "active" : "")}${a ? button("Trade", "goto-trade") : ""}${state.mode === "market" && a ? button("Refresh", "research-refresh") : ""}</div></div><nav class="fn-strip" aria-label="Views of ${esc(symbol)}">${button("Grid", "stock-view", stockView ? "" : "active", 'data-value=""')}${VIEWS.map((v) => button(`${v.label}<kbd>${v.code}</kbd>`, "stock-view", stockView === v.code ? "active" : "", `data-value="${v.code}"`)).join("")}</nav></section>`;
}
function stockPage() {
  return stockHead() + (stockView ? stockBody() : stockGrid());
}
function stockGrid() {
  const tile = (code, body, cls = "") =>
    `<section class="panel tile ${cls}" data-tile="${code}"><div class="panel-head"><h2><button class="tile-title" data-action="stock-view" data-value="${code}">${viewLabel(code)}</button><kbd>${code}</kbd></h2><button class="icon" data-action="stock-view" data-value="${code}" title="Open ${viewLabel(code)}" aria-label="Open ${viewLabel(code)}">⤢</button></div>${body}</section>`;
  return `<div class="stock-grid">${tile("GP", chartBody(), "t-chart")}${tile("CN", newsList(5))}${tile("TAS", `<div id="tape-slot">${tapeBody(12)}</div>`)}${tile("HDS", holdersTile())}${tile("OWN", ownershipBody(false))}${tile("DCF", valuationTile())}${tile("RSK", riskTile())}${tile("DES", profileTile())}${tile("FA", financialsTile())}${tile("SPLC", relationsTile())}${tile("CF", filingsTile(), "t-wide")}</div>`;
}
function stockBody() {
  const views = {
    DES: descriptionView,
    GP: () => `<section class="panel">${chartBody()}</section>`,
    FA: financialsView,
    CN: () => `<div class="grid halves"><section class="panel"><div class="panel-head"><h2>Company news</h2></div>${newsList(30, true)}</section>${calendarPanel()}</div>`,
    HDS: holdersPage,
    OWN: ownershipView,
    SPLC: relationsView,
    DCF: valuation,
    RSK: riskView,
    TAS: tapeView,
    CF: secPanel,
  };
  return views[stockView]();
}
const noStock = () => empty(esc(live() ? `Loading ${symbol} prices…` : native ? `No prices for ${symbol} in demo data. Holder and filing views still work.` : `No prices for ${symbol}.`));
function chartBody() {
  const a = stockAsset();
  return a ? `${chartTools()}${chart(a)}<div class="source-line">${badge(a)}</div>` : noStock();
}
// "20261105T120000" -> "2026-11-05 12:00"
const newsTime = (t) => String(t || "").replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d).*$/, "$1-$2-$3 $4:$5");
function newsList(n, full = false) {
  // Finnhub company news (free); older Alpha Vantage news if that's all there is.
  const fhNews = state.mode === "market" ? state.datasets[`${symbol}:FH_company-news`] : null;
  const avNews = state.mode === "market" ? state.datasets[`${symbol}:NEWS_SENTIMENT`] : null;
  const items = Array.isArray(fhNews?.data)
    ? [...fhNews.data].sort((x, y) => (y.datetime || 0) - (x.datetime || 0)).map((x) => ({ title: x.headline, url: x.url, source: x.source, when: x.datetime ? new Date(x.datetime * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "", summary: x.summary }))
    : (avNews?.data?.feed || []).map((x) => ({ title: x.title, url: x.url, source: x.source, when: newsTime(x.time_published), summary: x.summary }));
  const shown = items.filter((x) => x.title).slice(0, n);
  if (!shown.length) {
    const why =
      state.mode === "sample"
        ? "Switch to Live data for company news."
        : !native
          ? "Company news loads in the desktop app."
          : !isUSKey(symbol)
            ? "Finnhub's free company news covers US-listed stocks."
            : !hasKey("finnhub")
              ? "finnhub"
              : loadErrors[`${symbol}:FH_company-news`] || (fhNews ? "No news for this company in the last 7 days." : "Loading company news…");
    return why === "finnhub" ? `<div class="empty">Company news comes from Finnhub (free key).<br>${button("Add it in Settings", "goto-settings")}</div>` : empty(esc(why));
  }
  return (
    shown
      .map((x) => {
        const url = safeURL(x.url);
        return `<article class="news-item">${url ? link(url, x.title) : esc(x.title)}<small>${esc(x.source)} · ${esc(x.when)}</small>${full && x.summary ? `<p>${esc(x.summary)}</p>` : ""}</article>`;
      })
      .join("") + (full ? datasetStamp(fhNews || avNews) : "")
  );
}
function calendarPanel() {
  const rows = fh("earnings")?.earningsCalendar;
  if (Array.isArray(rows)) {
    const sorted = [...rows].sort((x, y) => String(y.date).localeCompare(String(x.date)));
    const today = new Date().toISOString().slice(0, 10);
    const big = (x) => (x == null ? "—" : compact(x));
    return `<section class="panel"><div class="panel-head"><h2>Earnings <small>reported and upcoming</small></h2></div>${
      sorted.length
        ? table(
            ["Date", "Quarter", "EPS estimate", "EPS actual", "Surprise", "Revenue estimate", "Revenue actual"],
            sorted.slice(0, 12).map((r) => {
              const surprise = r.epsActual != null && r.epsEstimate ? r.epsActual / Math.abs(r.epsEstimate) - Math.sign(r.epsEstimate) : null;
              return `<tr><td>${esc(r.date)}${r.date >= today ? ' <span class="pill">upcoming</span>' : ""}${r.hour === "bmo" ? " <small>before open</small>" : r.hour === "amc" ? " <small>after close</small>" : ""}</td><td>Q${esc(r.quarter)} ${esc(r.year)}</td><td>${fmt(r.epsEstimate)}</td><td>${fmt(r.epsActual)}</td><td class="${surprise == null ? "" : tone(surprise)}">${surprise == null ? "—" : signed(surprise, pct)}</td><td>${big(r.revenueEstimate)}</td><td>${big(r.revenueActual)}</td></tr>`;
            }),
          )
        : empty("No earnings dates in Finnhub's window.")
    }<small>Finnhub earnings calendar. Surprise is actual EPS against the estimate.</small></section>`;
  }
  const why = state.mode !== "market" ? "Switch to Live data for earnings dates." : hasKey("finnhub") ? loadErrors[`${symbol}:FH_earnings`] || "Loading earnings dates…" : "";
  return `<section class="panel"><div class="panel-head"><h2>Earnings calendar</h2>${state.mode === "market" && !hasKey("finnhub") && hasKey("alpha") ? button("Load calendar", "calendar-fetch") : ""}</div>${why ? empty(esc(why)) : calendar()}<small>${hasKey("finnhub") ? "Finnhub earnings calendar." : "Add a free Finnhub key for reported and upcoming earnings."} Dividend date from the company overview: ${esc(stockAsset()?.overview?.DividendDate || "—")}.</small></section>`;
}
function profileTile() {
  const a = stockAsset(),
    o = a?.overview || {};
  const k = stockStats(),
    p = fh("profile2") || {};
  const blurb = o.Description || (p.name ? `${p.name}${p.finnhubIndustry ? ` · ${p.finnhubIndustry}` : ""}${p.ipo ? ` · listed since ${p.ipo}` : ""}` : "");
  return `<div class="metrics"><span>Sector</span><b>${esc(o.Sector || a?.sector || "—")}</b><span>Industry</span><b>${esc(o.Industry || p.finnhubIndustry || "—")}</b><span>52-week range</span><b>${k.low52.value == null ? "—" : `${fmt(k.low52.value)} – ${fmt(k.high52.value)}`}</b><span>Dividend yield</span><b>${pct(k.dividendYield.value)}</b></div>${blurb ? `<p class="clamp">${esc(blurb)}</p>` : `<p class="muted">${esc(a ? waiting("OVERVIEW", "the company profile") : "No profile loaded.")}</p>`}`;
}
function descriptionView() {
  const a = stockAsset();
  if (!a) return `<section class="panel">${noStock()}</section>`;
  const o = a.overview || {},
    r = risk(a.bars);
  const k = stockStats(),
    p = fh("profile2") || {};
  const web = safeURL(p.weburl);
  return `${statTiles(k)}<div class="grid halves"><section class="panel"><div class="panel-head"><h2>Company profile</h2>${web ? link(web, "Website") : ""}</div><p>${esc(o.Description || (p.name ? `${p.name}${p.finnhubIndustry ? `, ${p.finnhubIndustry}` : ""}${p.country ? `, ${p.country}` : ""}.` : waiting("OVERVIEW", "the company profile")))}</p><div class="metrics"><span>Sector</span><b>${esc(o.Sector || a.sector || "—")}</b><span>Industry</span><b>${esc(o.Industry || p.finnhubIndustry || "—")}</b>${p.ipo ? `<span>Listed since</span><b>${esc(p.ipo)}</b>` : ""}<span>Dividend yield</span><b>${pct(k.dividendYield.value)}</b><span>52-week high / low</span><b>${fmt(k.high52.value)} / ${fmt(k.low52.value)}</b><span>RSI (14, simple)</span><b>${fmt(rsi(a.bars))}</b><span>Annualized volatility</span><b>${pct(r?.vol)}</b><span>Max drawdown in data</span><b>${pct(r?.drawdown)}</b></div><small>Ratios are calculated from the live price, the latest statements and SEC shares outstanding where possible; the source is under each figure.</small></section><section class="panel"><div class="panel-head"><h2>Research journal</h2></div><textarea id="note" rows="10" placeholder="Thesis, catalysts, valuation assumptions, and what would change your mind…">${esc(state.notes[`${state.mode}:${symbol}`] || "")}</textarea>${button("Save thesis", "note-save", "primary")}</section></div>${calendarPanel()}`;
}
function financialsTile() {
  const k = stockStats(),
    rev = (state.mode === "market" ? state.secData?.[symbol]?.revenue : null) || [];
  return `<div class="mini-stats"><span>P/E <b>${k.pe.value == null ? (k.pe.note ? "NM" : "—") : fmt(k.pe.value)}</b></span><span>Margin <b>${pct(k.margin.value)}</b></span><span>Growth <b>${pct(k.growth.value)}</b></span><span>Market cap <b>${compact(k.marketCap.value)}</b></span></div>${
    rev.length
      ? table(
          ["Fiscal year end", "Revenue", "YoY"],
          rev.slice(-4).reverse().map((r) => `<tr><td>${esc(r.end)}</td><td>${compact(r.revenue)}</td><td class="${r.growth == null ? "" : tone(r.growth)}">${pct(r.growth)}</td></tr>`),
        )
      : `<p class="muted">${esc(state.mode === "market" ? secWhy() : "Revenue history loads from SEC filings with Live data.")}</p>`
  }`;
}
function statementsPanel() {
  const data = state.mode === "market" ? state.datasets[`${symbol}:${statement}`]?.data?.[period] : null;
  return `<section class="panel"><div class="panel-head"><h2>Financial statements</h2><select id="statement" aria-label="Statement">${["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"].map((s) => `<option ${s === statement ? "selected" : ""}>${s}</option>`).join("")}</select><select id="period" aria-label="Period"><option value="annualReports" ${period === "annualReports" ? "selected" : ""}>Annual</option><option value="quarterlyReports" ${period === "quarterlyReports" ? "selected" : ""}>Quarterly</option></select></div>${
    data?.length
      ? table(
          ["Metric", ...data.slice(0, 4).map((r) => esc(r.fiscalDateEnding))],
          Object.keys(data[0])
            .filter((k) => !["fiscalDateEnding", "reportedCurrency"].includes(k))
            .map((k) => `<tr><td>${esc(k)}</td>${data.slice(0, 4).map((r) => `<td>${number(r[k]) == null ? "—" : compact(+r[k])}</td>`).join("")}</tr>`),
        )
      : empty(esc(waiting(statement, "financial statements")))
  }<small>Reported currency: ${esc(data?.[0]?.reportedCurrency || "—")}. Raw provider figures; “None” is missing, not zero.</small></section>`;
}
function financialsView() {
  return `${statTiles(stockStats())}${statementsPanel()}<section class="panel"><div class="panel-head"><h2>Annual revenue <small>SEC XBRL</small></h2></div>${financialsTile()}</section>`;
}
// ---- Time and sales (the trade tape) ----
const tapes = {}; // symbol -> prints received this session, oldest first
let tapeTimer = null,
  tapeError = "";
const tapeClock = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" }) + "." + String(ms % 1000).padStart(3, "0");
// Live prints from the stream when there are any; otherwise the most recent
// session's trades (Alpaca, IEX) or its 1-minute bars (Twelve Data).
const pastTape = {}; // symbol -> { kind: "prints"|"minutes", date, ... }
const hasAlpaca = () => hasKey("alpaca") && hasKey("alpacasecret");
function streamBlocker() {
  if (!live()) return native ? "The trade tape streams with Live data." : "The trade tape streams in the desktop app.";
  if (!hasKey("finnhub")) return "finnhub";
  if (!isUSKey(symbol)) return "US only";
  if (!stockAsset()) return "Waiting for prices…";
  return "";
}
const tapeBlocker = streamBlocker;
function tapeTable(rows, full, big = Infinity) {
  return `<div class="table-wrap"><table class="tape"><thead><tr><th>Time (NY)</th><th>Price</th><th>Size</th><th>Side</th>${full ? "<th>Conditions</th>" : ""}</tr></thead><tbody>${rows
    .map((r) => `<tr class="${r.size >= big ? "big" : ""}"><td>${esc(tapeClock(r.time))}</td><td class="${r.tick > 0 ? "up" : r.tick < 0 ? "down" : ""}">${r.tick > 0 ? "▲" : r.tick < 0 ? "▼" : "·"} ${fmt(r.price)}</td><td>${int(r.size)}</td><td class="${r.side === "buy" ? "up" : r.side === "sell" ? "down" : ""}">${r.side ? (r.side === "buy" ? "Buy" : "Sell") : "—"}</td>${full ? `<td><small>${esc((r.conditions || []).join(" "))}</small></td>` : ""}</tr>`)
    .join("")}</tbody></table></div>`;
}
function printsBody(s, n, full, label) {
  const sum = `<p class="tape-label">${label}</p><div class="mini-stats"><span>VWAP <b>${fmt(s.vwap)}</b></span><span>Volume <b>${compact(s.volume)}</b></span><span>Buy · sell <b><span class="up">${pct(s.buyShare)}</span> · <span class="down">${s.buyShare == null ? "—" : pct(1 - s.buyShare)}</span></b></span></div>`;
  const stats = `<p class="tape-label">${label}</p><div class="stats">${stat("Prints", int(s.count), `${esc(tapeClock(s.first.time))} – ${esc(tapeClock(s.last.time))} New York`)}${stat("Volume", compact(s.volume), `VWAP ${fmt(s.vwap)} · range ${fmt(s.low)} – ${fmt(s.high)}`)}${stat("Buy · sell volume", `${compact(s.buyVolume)} · ${compact(s.sellVolume)}`, `estimated, ${pct(s.buyShare)} buyer-initiated`)}${stat("Largest print", int(s.largest?.size), s.largest ? `at ${fmt(s.largest.price)}, ${esc(tapeClock(s.largest.time))}` : "")}</div>`;
  return (full ? stats : sum) + tapeTable(s.rows.slice(-n).reverse(), full, full && s.largest ? s.largest.size : Infinity);
}
function minutesBody(m, n, full) {
  const label = `Last session ${esc(m.date)} · 1-minute bars from Twelve Data (no individual trades without an Alpaca key)`;
  const head = full
    ? `<div class="stats">${stat("Open · close", `${fmt(m.open)} · ${fmt(m.close)}`, `${m.rows.length} minutes`)}${stat("Range", `${fmt(m.low)} – ${fmt(m.high)}`)}${stat("Volume", compact(m.volume), "consolidated, all exchanges")}${stat("VWAP", fmt(m.vwap), "from each minute's typical price")}</div>`
    : `<div class="mini-stats"><span>VWAP <b>${fmt(m.vwap)}</b></span><span>Volume <b>${compact(m.volume)}</b></span><span>Range <b>${fmt(m.low)} – ${fmt(m.high)}</b></span></div>`;
  const rows = m.rows.slice(-n).reverse();
  return `<p class="tape-label">${label}</p>${head}<div class="table-wrap"><table class="tape"><thead><tr><th>Minute (NY)</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th></tr></thead><tbody>${rows
    .map((r, i) => {
      const prev = rows[i + 1]?.close;
      return `<tr><td>${esc(r.time.slice(11, 16))}</td><td>${fmt(r.open)}</td><td>${fmt(r.high)}</td><td>${fmt(r.low)}</td><td class="${prev == null ? "" : tone(r.close - prev)}">${fmt(r.close)}</td><td>${int(r.volume)}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}
function tapeBody(n, full = false) {
  const live_ = tapes[symbol] || [];
  if (live_.length) return printsBody(tapeStats(live_), n, full, "Live · trades as Finnhub streams them since this stock was opened");
  const past = pastTape[symbol];
  if (past?.kind === "prints" && past.prints.length) {
    const today = nyDate(Date.now()) === past.date;
    return printsBody(tapeStats(past.prints), n, full, `${today ? "Today, up to 15 minutes ago" : `Last session ${esc(past.date)}`} · IEX exchange only, via Alpaca · newest ${int(past.prints.length)} prints${hasKey("finnhub") ? " · live prints replace this as they arrive" : ""}`);
  }
  if (past?.kind === "minutes" && past.rows.length) return minutesBody(past, n, full);
  if (!live()) return empty(native ? "Time and sales loads with Live data." : "Time and sales loads in the desktop app.");
  if (!isUSKey(symbol)) return empty("Trade data here covers US-listed stocks only.");
  const loading = past?.loading;
  if (!hasAlpaca() && !hasKey("twelve") && !hasKey("finnhub")) return `<div class="empty">Add a free Alpaca key for past trades, or Finnhub for live ones.<br>${button("Open Settings", "goto-settings")}</div>`;
  return empty(esc(loading ? "Loading the last session's trades…" : past?.error || tapeError || "Waiting for trades…"));
}
function tapeView() {
  return `<section class="panel"><div class="panel-head"><h2>Time and sales <small>trade prints, newest first</small></h2></div><div id="tape-slot">${tapeBody(stockView === "TAS" ? 2000 : 12, true)}</div><small>Live prints come from the Finnhub stream (up to 500 kept). When the market is closed, or before live prints arrive, the most recent session shows instead: individual trades on the IEX exchange from Alpaca's free plan (a small share of all volume; the free plan can't read the latest 15 minutes), or 1-minute bars from Twelve Data if there's no Alpaca key. Buy and sell are estimated with the tick rule (a print above the previous price counts as buyer-initiated); free feeds have no bid/ask quotes, so there's no order book (market depth).${hasAlpaca() ? "" : " Add a free Alpaca key in Settings for past trade prints."}</small></section>`;
}
async function loadPastTape(s) {
  const p = (pastTape[s] ||= {});
  p.loading = true;
  try {
    if (hasAlpaca()) {
      const d = await fetchData("alpaca", "trades", s);
      Object.assign(p, { kind: "prints", ...pastPrints(d.data), fetchedAt: d.fetchedAt, error: "" });
      if (!p.prints.length) throw Error("Alpaca returned no IEX trades for the last few sessions.");
    } else if (hasKey("twelve")) {
      const d = await fetchData("twelve", "TIME_SERIES_1MIN", s);
      Object.assign(p, { kind: "minutes", ...minuteSession(d.data), fetchedAt: d.fetchedAt, error: "" });
      if (!p.rows.length) throw Error("Twelve Data returned no 1-minute bars.");
    }
  } catch (e) {
    p.error = message(e);
    lastError[hasAlpaca() ? "alpaca" : "twelve"] = p.error;
  } finally {
    p.loading = false;
  }
}
function syncTape() {
  const want = page === "Stock" && (!stockView || stockView === "TAS") && !streamBlocker();
  if (!want) {
    clearInterval(tapeTimer);
    tapeTimer = null;
    return;
  }
  if (!tapeTimer) tapeTimer = setInterval(pollTape, 1000);
}
async function pollTape() {
  const s = symbol,
    buf = (tapes[s] ||= []);
  try {
    const r = await quotesTape(s, buf.at(-1)?.time ?? 0);
    tapeError = r.streaming ? "" : "Connecting this stock to the real-time stream…";
    if (!r.prints?.length) return;
    buf.push(...r.prints);
    if (buf.length > 500) buf.splice(0, buf.length - 500);
    const el = $("#tape-slot");
    if (el && s === symbol && !el.matches(":hover")) el.innerHTML = stockView === "TAS" ? tapeBody(2000, true) : tapeBody(12);
  } catch (e) {
    tapeError = message(e);
  }
}
// ---- Holders and ownership changes ----
function holdersTile() {
  if (!native) return empty("Holder data loads in the desktop app.");
  if (!isUSKey(symbol)) return empty("SEC holder filings cover US-listed securities.");
  if (!refStatus?.quarters?.length)
    return hasKey("sec")
      ? `<div class="empty">Downloading SEC 13F holdings…<div class="job-line" data-job="holdings">${jobLine(refStatus?.job)}</div></div>`
      : `<div class="empty">Holders need your SEC contact email; the 13F download then starts by itself.<br>${button("Add it in Settings", "goto-settings")}</div>`;
  const d = hdsEntry(symbol),
    c = holderComparison(d);
  if (d.errors.holders) return empty(esc(d.errors.holders));
  if (!c) return empty("Loading 13F holders…");
  const top = c.holders.filter((h) => h.shares > 0).slice(0, 5);
  if (!top.length) return empty(`No 13F holders found for ${esc(symbol)}.`);
  const s = c.summary;
  return `<div class="mini-stats"><span>Holders <b>${int(s.holders)}</b></span><span>% of shares out <b>${pct(s.pctOut)}</b></span><span>New · sold out <b>${int(s.newPositions)} · ${int(s.exited)}</b></span></div>${table(
    ["Holder", "Shares", "Change"],
    top.map((h) => `<tr><td class="holder">${esc(prettyName(h.name))}</td><td>${compact(h.shares)}</td><td class="${toneOf(h.change)}">${h.status === "new" ? "New" : h.changePct == null ? "—" : signed(h.changePct, pct)}</td></tr>`),
  )}<small>Form 13F · quarter ending ${esc(c.period)}</small>`;
}
const own = { filter: "all" };
const OWN_FILTERS = [
  ["all", "All"],
  ["13F", "Funds (13F)"],
  ["13DG", "5%+ owners (13D/G)"],
  ["insider", "Insiders (Form 4)"],
];
function ownershipNotes(d) {
  const notes = [];
  if (!refStatus?.quarters?.length) notes.push("Fund moves (13F) appear once SEC 13F data is downloaded on Holders.");
  else if (d.loading.holders) notes.push("Loading 13F holders…");
  if (!hasKey("sec")) notes.push("Add your SEC contact email in Settings → Data sources to read 13D/G and Form 4 filings.");
  if (d.scheduleProgress) notes.push(`Reading Schedules 13D/G ${d.scheduleProgress.done}/${d.scheduleProgress.total}…`);
  if (d.insiderProgress) notes.push(`Reading Forms 3/4/5 ${d.insiderProgress.done}/${d.insiderProgress.total}…`);
  if (d.errors.sec) notes.push(d.errors.sec);
  return notes;
}
function ownershipItems(full) {
  const d = hdsEntry(symbol),
    c = holderComparison(d);
  const big = d.schedules ? (d.bigView ||= bigHolders(d.schedules)) : [];
  const log = d.insiderForms?.length ? (d.insiderView ||= insiderSummary(d.insiderForms)).log : [];
  return { d, items: ownershipFeed({ holders: c?.holders || [], big, insiders: log }, { top13F: full ? 50 : 25, limit: full ? 400 : 50 }) };
}
const ownLink = (x) => (x.url ? link(x.url, x.source) : x.cik ? link(filingIndex(x.cik, x.accession), x.source) : esc(x.source));
const ownTone = (x) => toneOf(x.shares ?? (x.action === "New position" ? 1 : x.action === "Sold out" ? -1 : 0));
function ownershipBody() {
  if (!native) return empty("Ownership filings load in the desktop app.");
  if (!isUSKey(symbol)) return empty("SEC ownership filings cover US-registered companies.");
  const { d, items } = ownershipItems(false);
  const notes = ownershipNotes(d);
  if (!items.length) return empty(esc(notes.join(" ") || "No disclosed ownership changes found yet."));
  return `${table(
    ["Date", "Who", "Change"],
    items.slice(0, 7).map((x) => `<tr><td><small>${esc(x.date)}</small></td><td class="holder">${esc(prettyName(x.who))}<small>${esc(x.source)} · ${esc(x.role || "")}</small></td><td class="${ownTone(x)}">${esc(x.action)}${x.shares != null ? `<small>${signed(x.shares, compact)} sh</small>` : ""}</td></tr>`),
  )}${notes.length ? `<small>${esc(notes[0])}</small>` : ""}`;
}
function ownershipView() {
  if (!native || !isUSKey(symbol)) return `<section class="panel">${ownershipBody()}</section>`;
  const { d, items } = ownershipItems(true);
  const pick = (k) => (x) => (k === "13F" ? x.source === "13F" : k === "13DG" ? /^13[DG]$/.test(x.source) : k === "insider" ? x.source.startsWith("Form") : true);
  const rows = items.filter(pick(own.filter));
  const counts = Object.fromEntries(OWN_FILTERS.map(([k]) => [k, items.filter(pick(k)).length]));
  const notes = ownershipNotes(d);
  return `<section class="panel"><div class="panel-head"><h2>Ownership changes <small>disclosed in SEC filings, newest first</small></h2>${button("All holders →", "stock-view", "", 'data-value="HDS"')}</div><div class="filters segmented">${OWN_FILTERS.map(([k, l]) => button(`${l} <small>${int(counts[k])}</small>`, "own-filter", own.filter === k ? "active" : "", `data-value="${k}"`)).join("")}</div>${notes.length ? `<p class="muted">${esc(notes.join(" "))}</p>` : ""}${
    rows.length
      ? table(
          ["Date", "Who", "Role", "Change", "Shares", "Value", "Holds after", "Filing"],
          rows.map((x) => `<tr><td>${esc(x.date)}</td><td class="holder">${esc(prettyName(x.who))}</td><td><small>${esc(x.role || "")}</small></td><td class="${ownTone(x)}">${esc(x.action)}</td><td class="${toneOf(x.shares)}">${signed(x.shares)}</td><td class="${toneOf(x.value)}">${x.value == null ? "—" : signed(x.value, usd)}</td><td>${int(x.after)}${x.percent != null ? ` <small>${fmt(x.percent)}% of class</small>` : ""}</td><td>${ownLink(x)}</td></tr>`),
        )
      : empty("No changes of this kind in the filings read so far.")
  }<small>Dates are filing dates (Form 4 trades use the trade date). Fund rows are the largest 13F moves from the latest quarter by estimated dollar change (shares × quarter-end price), reported up to 45 days after quarter end. 13D/G rows are each 5%+ owner's latest schedule. Insider rows are open-market purchases and sales only; awards, tax withholding and option exercises are on Holders → Insiders.</small></section>`;
}
// ---- Valuation ----
const ILLUSTRATIVE = { fcf: 1000, growth: 0.08, discount: 0.1, terminal: 0.025, netDebt: 2000, shares: 500 };
const modelKey = () => `${state.mode}:${symbol}`;
// Where the model's inputs come from: your saved edits, the company's
// filings, or illustrative numbers when neither exists.
function dcfModel() {
  const filed = state.mode === "market" ? state.valuationData?.[symbol] : null;
  const saved = state.valuations?.[modelKey()];
  if (saved) return { inputs: saved, sources: filed?.sources || {}, missing: [], origin: "saved" };
  if (filed) return { inputs: filed.inputs, sources: filed.sources, missing: filed.missing, origin: "filings", fetchedAt: filed.fetchedAt };
  return { inputs: ILLUSTRATIVE, sources: {}, missing: [], origin: "illustrative" };
}
function scenarios(m) {
  return ["Bear", "Base", "Bull"].map((name, i) => {
    const growth = m.growth + (i - 1) * 0.03,
      discount = m.discount - (i - 1) * 0.01;
    let perShare = null;
    try {
      perShare = dcf({ ...m, growth, discount }).perShare;
    } catch {
      // Missing or invalid inputs: shown as —.
    }
    return { name, growth, discount, perShare };
  });
}
const ORIGIN = { saved: "Your saved assumptions", filings: "Inputs from the company's SEC filings", illustrative: "Illustrative inputs; replace them with your own" };
function valuationTile() {
  const loading = live() && isUSKey(symbol) && !state.valuationData?.[symbol] && !loadErrors["val:" + symbol] && (cikFor(symbol) || hasKey("sec"));
  if (loading && !state.valuations?.[modelKey()]) return empty("Reading cash flow, debt and shares from SEC filings…");
  const m = dcfModel(),
    px = m.origin === "illustrative" ? null : price(stockAsset());
  const sc = scenarios(m.inputs);
  if (sc[1].perShare == null) return empty(esc(m.missing.length ? `The filings don't report ${m.missing.join(", ")}. Open to fill them in.` : "Open to set assumptions."));
  return `<div class="scenarios compact">${sc.map((s) => `<div class="scenario"><span>${s.name}</span><strong>${fmt(s.perShare)}</strong>${px && s.perShare != null ? `<small class="${tone(s.perShare / px - 1)}">${signed(s.perShare / px - 1, pct)} vs price</small>` : ""}</div>`).join("")}</div><small>${ORIGIN[m.origin]}${loadErrors["val:" + symbol] && m.origin === "illustrative" ? ` · ${esc(loadErrors["val:" + symbol])}` : ""}</small>`;
}
const inputValue = (k, v) => (v == null ? "" : ["growth", "discount", "terminal"].includes(k) ? +(v * 100).toFixed(2) : +v.toFixed(2));
function valuation() {
  const m = dcfModel();
  const fields = [
    ["fcf", "Base free cash flow (millions)"],
    ["growth", "Annual growth (%)"],
    ["discount", "Discount rate (%)"],
    ["terminal", "Terminal growth (%)"],
    ["netDebt", "Net debt (millions)"],
    ["shares", "Diluted shares (millions)"],
  ];
  const missing = m.missing.length ? `<p class="notice">The filings don't report ${esc(m.missing.join(", "))}; enter ${m.missing.length > 1 ? "them" : "it"} to value the stock.</p>` : "";
  return `<div class="grid halves"><section class="panel"><div class="panel-head"><h2>Discounted cash flow</h2><span class="tag">${esc(ORIGIN[m.origin].toUpperCase())}</span></div><p>Unlevered free cash flow model, five forecast years plus a terminal value. Amounts in millions of the reporting currency; shares in millions.</p>${missing}<div class="form-grid">${fields
    .map(([id, label]) => `<label>${label}<input id="${id}" type="number" step="any" value="${inputValue(id, m.inputs[id])}">${m.sources[id] ? `<small>${esc(m.sources[id])}</small>` : ""}</label>`)
    .join("")}</div>${button("Calculate and save", "dcf", "primary")}${m.origin === "saved" && state.mode === "market" ? button("Use filing values", "dcf-reset") : ""}${button("Export model", "dcf-export")}<small>Negative enterprise or equity values are shown, not clipped. ${m.fetchedAt ? `SEC XBRL company facts, read ${new Date(m.fetchedAt * 1000).toLocaleDateString()}.` : ""}</small></section><section class="panel"><div class="panel-head"><h2>Valuation range</h2></div><div id="dcf-results"></div></section></div><section class="panel"><div class="panel-head"><h2>Sensitivity · value per share</h2><small>Discount rate × terminal growth</small></div><div id="sensitivity"></div></section>`;
}
async function loadValuation(s) {
  try {
    const cik = await resolveCIK(s);
    const facts = {};
    for (const tag of VALUE_TAGS) {
      // Debt reported as one total doesn't need its parts.
      if (facts.LongTermDebt && /^LongTermDebt(Non)?[Cc]urrent$/.test(tag)) continue;
      try {
        facts[tag] = (await fetchSEC("concept", cik, "", tag)).data;
      } catch {
        // Not every company reports every concept.
      }
    }
    const shares = await fetchSEC("shares", cik).catch(() => null);
    facts.sharesOut = shares ? sharesSeries(shares.data).at(-1) || null : null;
    if (!state.secData?.[s]) await loadSEC(s).catch(() => {});
    facts.revenue = state.secData?.[s]?.revenue || [];
    (state.valuationData ||= {})[s] = { ...valuationInputs(facts), fetchedAt: Date.now() / 1000 };
    delete loadErrors["val:" + s];
  } catch (e) {
    loadErrors["val:" + s] = message(e);
    throw e;
  }
}
// ---- Suppliers and customers ----
function relationsTile() {
  const g = graph();
  const n = g.nodes.find((x) => x.ticker === symbol);
  if (!n) return `<div class="empty">No supplier or customer data for ${esc(symbol)} yet.${live() ? `<br>${button("Find in filings", "stock-view", "", 'data-value="SPLC"')}` : ""}</div>`;
  const nb = neighborhood(g, n.id, { includeUnreviewed: graphCandidates });
  const name = (id) => prettyName(g.nodes.find((x) => x.id === id)?.name || id);
  const list = (edges, key) => {
    const ids = [...new Set(edges.map((e) => e[key]))];
    return { n: ids.length, html: ids.slice(0, 5).map((id) => `<li>${esc(name(id))}</li>`).join("") || `<li class="muted">None on file</li>` };
  };
  const s = list(nb.suppliers, "supplier"),
    c = list(nb.customers, "customer");
  return `<div class="rel-mini"><div><h3>Suppliers <small>${s.n}</small></h3><ul>${s.html}</ul></div><div><h3>Customers <small>${c.n}</small></h3><ul>${c.html}</ul></div></div><small>${graphCandidates ? "Includes unreviewed mentions found in filings." : "Reviewed sources only."}</small>`;
}
function relationsView() {
  const center = graph().nodes.find((x) => x.id === graphCenter);
  const elsewhere = center && center.ticker !== symbol && parentTicker(center) !== symbol;
  const note = elsewhere && graphSymbol === symbol ? `<p class="notice">No relationship data for ${esc(symbol)}${state.mode === "sample" ? " in demo data" : ""}. Showing ${esc(prettyName(center.name))}, the last company you explored.</p>` : "";
  return (
    note +
    relationshipsView(graph(), graphCenter, graphCandidates, {
      width: graphWidth(),
      trail: graphTrail,
      progress: scanText(graphCenter),
    }) +
    filingScan()
  );
}
// ---- Filings ----
function secWhy() {
  return state.mode === "sample"
    ? "Switch to Live data for SEC filings."
    : !native
      ? "SEC filings load in the desktop app."
      : !isUSKey(symbol)
        ? "SEC filings cover US-registered companies."
        : !cikFor(symbol) && !hasKey("sec")
          ? "Add your SEC contact email in Settings → Data sources (or an Alpha Vantage key) so the app can find this company on EDGAR."
          : loadErrors["sec:" + symbol] || "Loading filings from SEC EDGAR…";
}
function filingsTile() {
  const d = state.mode === "market" ? state.secData?.[symbol] : null;
  if (!d) return `<p class="muted">${esc(secWhy())}</p>`;
  return `<div class="filing-strip">${d.filings
    .slice(0, 8)
    .map((f) => {
      const url = safeURL(f.url);
      return `<span><b>${esc(f.form)}</b> ${esc(f.filed)}${url ? " " + link(url, "Open") : ""}</span>`;
    })
    .join("")}</div>`;
}
// ---- Command line and search -------------------------------------------------
function runCommand(cmd) {
  if (cmd.page === "Stock") return openStock(cmd.ticker || symbol, cmd.view);
  page = cmd.page;
  render();
}
// A ticker, or a company name already in the workspace.
function openTicker(q, meta) {
  const a = assets().find((a) => a.symbol === q) || (!meta && assets().find((a) => a.name.toUpperCase().includes(q)));
  openStock(a ? a.symbol : q, undefined, meta);
}
function openListing(r) {
  openTicker(r.key, r);
}
function runSearch(raw) {
  const q = raw.trim().toUpperCase();
  if (!q) return;
  const cmd = parseCommand(q);
  if (cmd) return runCommand(cmd);
  openTicker(q);
}
// Sidebar search: commands ("AAPL HDS"), plus suggestions from every listing.
function bindSearch() {
  const input = $("#search"),
    list = $("#search-results");
  let results = [],
    active = -1,
    timer = null;
  const close = () => {
    list.hidden = true;
    active = -1;
  };
  const paint = () => {
    list.innerHTML = results
      .map((r, i) => `<button type="button" role="option" class="combo-item ${i === active ? "active" : ""}" data-i="${i}"><b>${esc(r.symbol)} <span>${esc(r.name)}</span></b><small>${esc(r.mic || r.exchange || "")}${r.country ? " · " + esc(r.country) : ""}</small></button>`)
      .join("");
    list.hidden = !results.length;
    list.querySelectorAll(".combo-item").forEach(
      (el) =>
        (el.onmousedown = (e) => {
          e.preventDefault();
          close();
          input.value = "";
          openListing(results[+el.dataset.i]);
        }),
    );
  };
  input.oninput = () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!native || !uniStatus?.listings || !q || parseCommand(q)) {
      results = [];
      return close();
    }
    timer = setTimeout(async () => {
      try {
        const r = await universeSearch(q, 8);
        if (input.value.trim() !== q) return;
        results = r;
        active = -1;
        paint();
      } catch {
        results = [];
        close();
      }
    }, 120);
  };
  input.onblur = () => setTimeout(close, 120);
  input.onkeydown = (e) => {
    if (!list.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      active = e.key === "ArrowDown" ? (active + 1) % results.length : active <= 0 ? results.length - 1 : active - 1;
      return paint();
    }
    if (e.key === "Escape") {
      input.value = "";
      return close();
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const pick = !list.hidden && active >= 0 ? results[active] : null;
    close();
    const text = input.value;
    input.value = "";
    if (pick) return openListing(pick);
    runSearch(text);
  };
}
// Inputs on the Holders, Universe and Settings pages.
function bindReference() {
  const on = (id, ev, f) => {
    const el = $("#" + id);
    if (el) el[ev] = f;
  };
  const d = () => hdsEntry(hdsTicker());
  // Filtering re-renders the table; keep the cursor in the box.
  let qTimer = null;
  on("hds-q", "oninput", (e) => {
    clearTimeout(qTimer);
    const v = e.target.value,
      at = e.target.selectionStart;
    qTimer = setTimeout(() => {
      hds.q = v;
      hds.limit = 100;
      render();
      const el = $("#hds-q");
      if (el) {
        el.focus();
        el.setSelectionRange(at, at);
      }
    }, 200);
  });
  on("hds-period", "onchange", (e) => {
    const x = d();
    x.period = e.target.value;
    x.holders = null;
    x.comp = null;
    hds.fund = null;
    render();
  });
  on("hds-quarters", "onchange", async (e) => {
    state.holdings = { ...(state.holdings || {}), quarters: +e.target.value };
    await persist();
  });
  on("hds-codes", "onchange", (e) => {
    hds.insiderCodes = e.target.value;
    render();
  });
  for (const [id, key] of [["uni-country", "country"], ["uni-mic", "mic"], ["uni-kind", "kind"]])
    on(id, "onchange", (e) => {
      uni[key] = e.target.value;
      if (key === "country") uni.mic = "";
      uni.offset = 0;
      uni.data = null;
      render();
    });
  on("uni-q", "onkeydown", (e) => {
    if (e.key === "Enter") action("uni-search").catch((x) => notify(message(x), true));
  });
}
function referencePanel() {
  const r = refStatus,
    u = uniStatus;
  const q = state.holdings?.quarters || 2;
  return `<section class="panel"><div class="panel-head"><h2>Reference data</h2></div><div class="source-row"><div class="source-info"><h3>World listing directory ${u?.listings ? '<span class="pill on">Loaded</span>' : '<span class="pill">Not loaded</span>'}</h3><small>${u?.listings ? `${int(u.listings)} stocks and ETFs on ${int(u.exchanges)} exchanges in ${int(u.countries)} countries` : "Every stock and ETF Twelve Data lists, plus SEC's US filers"}. No key needed. Refreshed weekly.</small><div class="job-line" data-job="universe">${jobLine(u?.job)}</div></div><div class="source-key">${button("Update now", "uni-refresh")}</div></div><div class="source-row"><div class="source-info"><h3>SEC 13F institutional holdings ${r?.quarters?.length ? `<span class="pill on">${r.quarters.length} quarters</span>` : '<span class="pill">Not downloaded</span>'}</h3><small>${r?.quarters?.length ? `Quarters: ${r.quarters.map((x) => esc(x.period)).join(", ")} · ${int(r.mapped)} CUSIPs mapped to tickers` : "About 100 MB to download and 200 MB on disk per quarter. Needs your SEC contact email."}</small><div class="job-line" data-job="holdings">${jobLine(r?.job)}</div></div><div class="source-key"><select id="hds-quarters" aria-label="Quarters to keep">${[2, 4, 8].map((n) => `<option value="${n}" ${n === q ? "selected" : ""}>Keep ${n} quarters</option>`).join("")}</select>${button(r?.quarters?.length ? "Check for new data" : "Download", "hds-download")}</div></div><small>Both live in reference.sqlite in the app-data folder, separate from your workspace and backups.</small></section>`;
}
// ---- SEC EDGAR -----------------------------------------------------------
function cikFor(s) {
  const c =
    activeMap()[s]?.overview?.CIK ||
    graph().nodes.find((n) => n.ticker === s)?.cik ||
    state.secCIK?.[s];
  return c && /^\d{1,10}$/.test(String(c)) ? padCIK(c) : null;
}
async function resolveCIK(s) {
  const known = cikFor(s);
  if (known) return known;
  if (!hasKey("sec"))
    throw Error(`Add your SEC contact email in Settings → Data sources so the app can look up ${s} on EDGAR.`);
  const t = await fetchSEC("tickers");
  const hit = Object.values(t.data).find((x) => x.ticker === s);
  if (!hit) throw Error(`${s} isn't in SEC's company list (it may not file with the SEC).`);
  (state.secCIK ||= {})[s] = padCIK(hit.cik_str);
  return state.secCIK[s];
}
async function loadSEC(s) {
  try {
    const cik = await resolveCIK(s);
    const sub = await fetchSEC("submissions", cik);
    let revenue = [];
    for (const tag of REVENUE_TAGS) {
      try {
        revenue = revenueHistory((await fetchSEC("revenue", cik, "", tag)).data);
      } catch {
        revenue = [];
      }
      if (revenue.length) break;
    }
    (state.secData ||= {})[s] = {
      cik,
      name: sub.data.name,
      filings: recentFilings(sub.data),
      revenue,
      fetchedAt: sub.fetchedAt,
    };
    delete loadErrors["sec:" + s];
  } catch (e) {
    loadErrors["sec:" + s] = lastError.sec = message(e);
    throw e;
  }
}
function secPanel() {
  const d = state.mode === "market" ? state.secData?.[symbol] : null;
  const why = secWhy();
  if (!d)
    return `<section class="panel"><div class="panel-head"><h2>SEC filings</h2><small>EDGAR · no key needed</small></div>${empty(esc(why))}</section>`;
  return `<section class="panel"><div class="panel-head"><h2>SEC filings <small>${esc(d.name)} · CIK ${esc(d.cik)}</small></h2>${link("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=" + d.cik, "All filings on EDGAR")}</div><div class="grid halves"><div>${table(
    ["Form", "Filed", "Period", ""],
    d.filings.map((f) => {
      const url = safeURL(f.url);
      return `<tr><td>${esc(f.form)}</td><td>${esc(f.filed)}</td><td>${esc(f.period || "—")}</td><td>${url ? link(url, "Open") : ""}</td></tr>`;
    }),
  )}</div><div>${
    d.revenue.length
      ? table(
          ["Fiscal year end", "Revenue", "YoY"],
          d.revenue
            .slice()
            .reverse()
            .map(
              (r) =>
                `<tr><td>${esc(r.end)}</td><td>${compact(r.revenue)}</td><td class="${r.growth == null ? "" : tone(r.growth)}">${pct(r.growth)}</td></tr>`,
            ),
        )
      : empty("No annual revenue reported in XBRL under the standard tags.")
  }<small>Reported annual revenue from XBRL company facts (USD), latest restatement per period.</small></div></div><small>SEC EDGAR · updated ${new Date(d.fetchedAt * 1000).toLocaleString()}</small></section>`;
}
function filingScan() {
  const n = graph().nodes.find((x) => x.id === graphCenter) || graph().nodes[0];
  if (!n) return "";
  const scan = state.filingScans?.[n.id];
  const blocker = !native
    ? "Filing scans run in the desktop app."
    : !hasKey("sec")
      ? "Add your SEC contact email in Settings → Data sources to scan filings."
      : !n.ticker && !n.cik
        ? "This entity has no ticker or CIK to look up on EDGAR."
        : scanErrors[n.id] || "";
  const list = (items) =>
    items?.length
      ? items.map((c) => `${esc(c.name)} <small>(${esc(c.role)})</small>`).join(", ")
      : "None";
  return `<section class="panel"><div class="panel-head"><h2>Find suppliers & customers in SEC filings</h2>${blocker && !scanErrors[n.id] ? "" : button((scan ? "Rescan " : "Scan ") + esc(n.name) + "'s annual reports", "sec-scan", scan ? "" : "primary")}</div><p>Reads the two most recent annual reports (10-K or 20-F) on EDGAR, matches company names against SEC's company list, and adds sentences that name a supplier or customer as <b>unreviewed candidates</b>. Revenue shares are kept only when the same sentence discloses them. A candidate is not a relationship until you read the source and mark it reviewed.</p>${blocker ? `<p><b>${esc(blocker)}</b></p>` : ""}${
    scan
      ? `<div class="metrics"><span>Latest report</span><b>${esc(scan.current.form)} filed ${esc(scan.current.filed)} · ${scan.current.count} mention${scan.current.count === 1 ? "" : "s"}</b><span>Prior report</span><b>${scan.prior ? `${esc(scan.prior.form)} filed ${esc(scan.prior.filed)} · ${scan.prior.count} mention${scan.prior.count === 1 ? "" : "s"}` : "None found"}</b><span>New since prior report</span><b>${scan.prior ? list(scan.added) : "—"}</b><span>No longer mentioned</span><b>${scan.prior ? list(scan.dropped) : "—"}</b></div><small>Scanned ${esc(scan.at)}. Mentions are matched names in sentences with supplier or customer wording; absence from a filing does not mean a relationship ended.</small>`
      : ""
  }</section>`;
}
// Read a company's two latest annual reports and add named suppliers and
// customers as unreviewed candidates.
async function scanFilings(id) {
  const n = graph().nodes.find((x) => x.id === id);
  if (!n) throw Error("Company not found");
  scanningId = id;
  refresh();
  try {
    const cik = n.cik ? padCIK(n.cik) : await resolveCIK(n.ticker);
    const sub = (await fetchSEC("submissions", cik)).data;
    const reports = annualReports(sub, 2);
    if (!reports.length) throw Error(n.name + " has no 10-K or 20-F on EDGAR.");
    const directory = buildDirectory((await fetchSEC("tickers")).data, graph());
    // The company's own subsidiaries are not its suppliers or customers.
    const filer = { cik, name: n.name, ticker: n.ticker, nodeId: n.id, skip: [...companyGroup(graph(), n.id)] };
    const results = [];
    for (const f of reports) {
      const text = (await fetchSEC("document", cik, f.accession, f.doc)).data.text;
      results.push({ filing: f, found: extractCandidates(text, directory, filer) });
    }
    const today = new Date().toISOString().slice(0, 10);
    let g = graph(),
      added = 0;
    for (const r of results) {
      const out = candidatesToGraph(g, filer, r.filing, r.found, today);
      g = out.graph;
      added += out.added;
    }
    state.relationshipGraph = validateGraph(g);
    graph().nodes.find((x) => x.id === n.id).cik ||= cik;
    const label = (c) => ({ name: c.counterparty.name, role: c.role });
    const cmp = results[1] ? compareMentions(results[0].found, results[1].found) : null;
    const summary = (r) => r && { form: r.filing.form, filed: r.filing.filed, count: r.found.length };
    (state.filingScans ||= {})[n.id] = {
      at: today,
      current: summary(results[0]),
      prior: summary(results[1]),
      added: cmp?.added.map(label) || [],
      dropped: cmp?.dropped.map(label) || [],
    };
    delete scanErrors[n.id];
    await persist();
    return { found: results[0].found.length, added };
  } catch (e) {
    scanErrors[n.id] = "Couldn't scan filings: " + message(e);
    throw e;
  } finally {
    scanningId = null;
    refresh();
  }
}
// SEC's company list (about 10,000 filers), loaded once per session.
let secDir = null;
async function secDirectory() {
  if (secDir) return secDir;
  const d = (await fetchSEC("tickers")).data;
  const list = Object.values(d).map((c) => ({ cik: padCIK(c.cik_str), ticker: c.ticker, title: prettyName(c.title) }));
  // The first listing per CIK is the primary share class.
  secDir = { list, byCik: new Map([...list].reverse().map((x) => [x.cik, x])) };
  return secDir;
}
// Scan a company in the background when it is opened: its own annual
// reports, then other companies' reports that name it. Runs at most once a
// week per company; leaving a company pauses the second part.
const scanRuns = new Set();
function autoScan(id) {
  if (!live() || !hasKey("sec") || scanRuns.has(id)) return;
  const n = graph().nodes.find((x) => x.id === id);
  if (!n || !(n.ticker || n.cik) || scanErrors[id]) return;
  const fresh = (x) => x?.at && Date.now() - Date.parse(x.at) < 7 * 864e5;
  const done = state.filingScans?.[id];
  if (fresh(done) && fresh(done.mentions)) return;
  scanRuns.add(id);
  (async () => {
    if (!fresh(done)) await scanFilings(id).catch(() => {});
    await scanMentions(id);
  })()
    .catch((e) => (scanErrors[id] = "Couldn't check other companies' reports: " + message(e)))
    .finally(() => {
      scanRuns.delete(id);
      refresh();
    });
}
// Other companies' annual reports from the last 18 months that name this
// company as a supplier or customer. Suppliers rarely name customers in the
// customer's own 10-K, but customers over 10% of revenue must be disclosed.
async function scanMentions(id) {
  const n = graph().nodes.find((x) => x.id === id);
  const cik = n.cik ? padCIK(n.cik) : await resolveCIK(n.ticker);
  n.cik ||= cik;
  const since = new Date(Date.now() - 548 * 864e5).toISOString().slice(0, 10);
  const hits = [];
  for (const phrase of searchPhrases(n.name))
    hits.push(...(await fetchSEC("search", "", since, phrase)).data.hits);
  const own = new Set([cik]);
  const filers = [];
  for (const h of hits) {
    const c = padCIK(h.cik);
    if (own.has(c)) continue;
    own.add(c);
    filers.push(h);
  }
  const todo = filers.slice(0, 20);
  const dir = await secDirectory();
  const today = new Date().toISOString().slice(0, 10);
  scanProgress[id] = { done: 0, total: todo.length };
  refresh();
  let found = 0,
    added = 0;
  try {
    for (const f of todo) {
      if (graphCenter !== id || !live()) return; // paused; resumes when reopened
      try {
        const c = padCIK(f.cik),
          listed = dir.byCik.get(c);
        const existing = graph().nodes.find((x) => x.cik === c || (listed?.ticker && x.ticker === listed.ticker));
        const filer = { cik: c, name: existing?.name || listed?.title || prettyName(f.name), ticker: listed?.ticker || "", nodeId: existing?.id };
        const text = (await fetchSEC("document", c, f.accession, f.doc)).data.text;
        const named = mentionsOf(text, n, filer);
        if (named.length) {
          const filing = { accession: f.accession, filed: f.filed, form: f.form, period: f.period, url: filingURL(c, f.accession, f.doc) };
          const out = candidatesToGraph(graph(), filer, filing, named, today);
          state.relationshipGraph = validateGraph(out.graph);
          found += named.length;
          added += out.added;
        }
      } catch {
        // One unreadable filing shouldn't stop the rest.
      }
      scanProgress[id].done++;
      refresh();
    }
    const scans = (state.filingScans ||= {});
    scans[id] = { ...scans[id], mentions: { at: today, checked: todo.length, found, added } };
    await persist();
  } finally {
    delete scanProgress[id];
  }
}
// Company search: entities already in the graph first, then every company
// in SEC's list (live mode).
function bindCompanySearch(recenter) {
  const input = $("#graph-search"),
    list = $("#graph-results");
  let results = [],
    active = 0;
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  };
  const pick = async (r) => {
    if (!r) return;
    close();
    if (r.node) return recenter(r.node.id);
    const n = ensureCompany(graph(), r.ticker, r.title);
    n.cik ||= r.cik;
    await persist();
    recenter(n.id);
  };
  const paint = () => {
    list.innerHTML = results.length
      ? results
          .map(
            (r, i) =>
              `<button type="button" role="option" class="combo-item ${i === active ? "active" : ""}" data-i="${i}" aria-selected="${i === active}"><b>${esc(r.node ? prettyName(r.node.name) : r.title)}</b><small>${esc(r.ticker || "")}${r.node ? " · in your graph" : ""}</small></button>`,
          )
          .join("")
      : `<div class="combo-empty">${!live() ? "Switch to Live data to search every SEC-listed company." : !hasKey("sec") ? "Add your SEC contact email in Settings to search every SEC-listed company." : "No matching company."}</div>`;
    list.querySelectorAll(".combo-item").forEach((el) => (el.onmousedown = (e) => (e.preventDefault(), pick(results[+el.dataset.i]))));
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const search = async () => {
    const q = input.value.trim().toUpperCase();
    if (!q) return close();
    const score = (name, ticker) => (ticker === q ? 0 : ticker?.startsWith(q) ? 1 : name.toUpperCase().startsWith(q) ? 2 : name.toUpperCase().includes(q) ? 3 : 9);
    const nodes = graph()
      .nodes.map((n) => ({ node: n, ticker: n.ticker, s: score(n.name, n.ticker) }))
      .filter((r) => r.s < 9);
    let sec = [];
    if (live() && hasKey("sec")) {
      try {
        const dir = await secDirectory();
        const inGraph = new Set(graph().nodes.flatMap((n) => [n.ticker, n.cik].filter(Boolean)));
        sec = dir.list
          .map((c) => ({ ...c, s: score(c.title, c.ticker) }))
          .filter((r) => r.s < 9 && !inGraph.has(r.ticker) && !inGraph.has(r.cik));
      } catch (e) {
        notify(message(e), true);
      }
    }
    if (input.value.trim().toUpperCase() !== q) return; // a newer keystroke won
    const seen = new Set();
    results = [...nodes, ...sec]
      .sort((a, b) => a.s - b.s || !!b.node - !!a.node)
      .filter((r) => {
        const k = r.node?.id || r.cik;
        return !seen.has(k) && seen.add(k);
      })
      .slice(0, 10);
    active = 0;
    paint();
  };
  input.oninput = search;
  input.onfocus = () => input.value && search();
  input.onblur = close;
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === "Escape") {
      input.value = "";
      close();
    }
  };
}
const loadErrors = {}; // dataset key -> message from the last failed load
// What to show while a company dataset isn't loaded yet.
function waiting(kind, label) {
  if (state.mode === "sample")
    return "Switch to Live data for sourced " + label + ".";
  if (!native) return "Live " + label + " load in the desktop app.";
  if (!hasKey("alpha"))
    return "Add an Alpha Vantage key in Settings → Data sources to load " + label + ".";
  return loadErrors[`${symbol}:${kind}`] || "Loading " + label + "…";
}
function datasetStamp(d) {
  return d
    ? `<small>${providers[d.provider]?.name || "Alpha Vantage"} · updated ${new Date(d.fetchedAt * 1000).toLocaleString()}${d.stale ? " · STALE CACHE" : ""}</small>`
    : "";
}
function calendar() {
  const d =
    state.mode === "market"
      ? state.datasets[`${symbol}:EARNINGS_CALENDAR`]
      : null;
  if (!d) return empty("No downloaded calendar.");
  const rows = parseCSV(d.data.csv || "");
  return (
    table(
      ["Company", "Report date", "Estimate", "Currency"],
      rows
        .slice(0, 20)
        .map(
          (r) =>
            `<tr><td>${esc(r.name || r.symbol)}</td><td>${esc(r.reportdate)}</td><td>${esc(r.estimate)}</td><td>${esc(r.currency)}</td></tr>`,
        ),
    ) + datasetStamp(d)
  );
}
function trade() {
  const a = asset();
  if (!a) return empty("Import or download an asset to paper trade.");
  const p = portfolio(
    account(),
    Object.fromEntries(assets().map((a) => [a.symbol, a])),
  );
  return `<div class="stats">${stat("Paper equity", money(p.value))}${stat("Available cash", money(p.cash))}${stat("Realized P&L", money(p.realized))}${stat("Unrealized P&L", money(p.unrealized))}</div><div class="grid trade-grid"><section class="panel"><div class="panel-head"><h2>${symbol} · Trading workspace</h2></div>${chartTools()}${chart(a)}<div class="source-line">${badge(a)}</div></section><section class="panel order"><div class="panel-head"><h2>Paper order</h2><span class="tag">SIMULATION</span></div><label>Quantity<input id="qty" type="number" min="0.000001" step="any" value="10"></label><label>Fill price (USD)<input id="fill" type="number" min="0.000001" step="any" value="${price(a).toFixed(4)}"></label><label>Commission / fee (USD)<input id="fee" type="number" min="0" step="any" value="0"></label><label>Trade date<input id="trade-date" type="date" value="${a.bars.at(-1).date}"></label><label>Trade rationale<textarea id="trade-note" rows="2" placeholder="Why this trade?"></textarea></label><div class="order-total">Estimated buy cost <b id="order-total"></b></div><div class="buy-sell">${button("Buy " + symbol, "buy", "buy")}${button("Sell " + symbol, "sell", "sell")}</div><small>Manual simulated fills, including fees. No real orders. Change price to model slippage. Long-only; no borrowing.</small></section></div><section class="panel"><div class="panel-head"><h2>Trade journal</h2>${button("Export CSV", "trades-export")}</div>${tradeTable()}</section>`;
}
function tradeTable() {
  return table(
    ["Date", "Asset", "Side", "Quantity", "Fill", "Fee", "Rationale"],
    [...account().trades]
      .reverse()
      .map(
        (t) =>
          `<tr><td>${esc(t.date.slice(0, 10))}</td><td>${esc(t.symbol)}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side.toUpperCase()}</td><td>${fmt(t.qty, 4)}</td><td>${money(t.price)}</td><td>${money(t.fee)}</td><td>${esc(t.note)}</td></tr>`,
      ),
  );
}
function portfolioPage() {
  const universe = Object.fromEntries(assets().map((a) => [a.symbol, a])),
    p = portfolio(account(), universe);
  return `<div class="stats">${stat("Portfolio value", money(p.value), p.incomplete ? "Includes cost-basis fallback for missing marks" : "Cash + latest available marks")}${stat("Return since inception", pct(p.value / account().initial - 1), "No external flows")}${stat("Realized P&L", money(p.realized), "Average-cost accounting, fees included")}${stat("Cash allocation", pct(p.cash / p.value))}</div><section class="panel"><div class="panel-head"><h2>Positions & allocation</h2>${button("Export positions", "positions-export")}</div>${table(
    [
      "Asset",
      "Shares",
      "Average cost",
      "Last mark",
      "Market value",
      "Weight",
      "Unrealized P&L",
    ],
    p.positions.map(
      (p1) =>
        `<tr><td>${esc(p1.symbol)}</td><td>${fmt(p1.qty, 4)}</td><td>${money(p1.cost / p1.qty)}</td><td>${money(p1.price)}</td><td>${money(p1.market)}</td><td>${pct(p1.market / p.value)}</td><td class="${tone(p1.pnl)}">${money(p1.pnl)}</td></tr>`,
    ),
  )}${!p.positions.length ? empty("Buy shares in the Trade workspace to build a portfolio.") : ""}<div class="allocation">${p.positions.map((x) => `<div style="flex:${x.market || 0}" title="${esc(x.symbol)} ${pct(x.market / p.value)}">${esc(x.symbol)}</div>`).join("")}<div style="flex:${p.cash}">Cash</div></div></section><section class="panel"><div class="panel-head"><h2>Paper equity history</h2><small>Daily marks · no dividends or external cash flows</small></div>${equityCurve(account(), universe).length ? spark(equityCurve(account(), universe).map((x) => x.close)) : empty("Your trade history will appear here.")}<div class="metrics"><span>Portfolio volatility</span><b>${pct(risk(equityCurve(account(), universe))?.vol)}</b><span>Portfolio max drawdown</span><b>${pct(risk(equityCurve(account(), universe))?.drawdown)}</b></div><small>Uses historical closes available at each date and the recorded trade ledger. Missing marks fall back to cost basis. Corporate actions and distributions are not processed.</small></section><div class="grid halves"><section class="panel"><div class="panel-head"><h2>Asset risk</h2></div>${table(
    ["Asset", "Volatility", "Max drawdown", "Sharpe¹"],
    p.positions.map((p) => {
      const r = universe[p.symbol] ? risk(universe[p.symbol].bars) : null;
      return `<tr><td>${esc(p.symbol)}</td><td>${pct(r?.vol)}</td><td>${pct(r?.drawdown)}</td><td>${fmt(r?.sharpe)}</td></tr>`;
    }),
  )}<small>¹ Daily close returns, 252 trading days/year, 4% annual risk-free assumption. Price returns, not total returns. This describes each asset, not historical portfolio performance.</small></section><section class="panel"><div class="panel-head"><h2>Portfolio stress test</h2></div><label>Uniform asset-price shock (%)<input id="shock" type="range" min="-60" max="40" value="-20"></label><div id="stress" class="stress"></div><small>Static positions; cash unchanged. No correlations, options, taxes, or liquidity effects.</small><div class="panel-head"><h2>Benchmark context</h2></div>${[
    "SPY",
    "QQQ",
  ]
    .map((s) => {
      const a = universe[s];
      return a
        ? `<p>${s}: ${pct(risk(a.bars)?.total)} over ${a.bars[0].date} → ${a.bars.at(-1).date}</p>`
        : "";
    })
    .join(
      "",
    )}<small>Benchmark windows may differ from your account inception. Not an excess-return calculation.</small></section></div><section class="panel"><div class="panel-head"><h2>Return correlation</h2></div>${table(
    ["Asset", ...p.positions.map((x) => esc(x.symbol))],
    p.positions.map(
      (x) =>
        `<tr><td>${esc(x.symbol)}</td>${p.positions.map((y) => `<td>${universe[x.symbol] && universe[y.symbol] ? fmt(correlation(universe[x.symbol].bars, universe[y.symbol].bars)) : "—"}</td>`).join("")}</tr>`,
    ),
  )}<small>Daily returns aligned by calendar date. At least 3 overlapping return observations.</small></section>`;
}
function filtered() {
  return assets().filter((a) => {
    const o = a.overview || {};
    return (
      number(o.PERatio) != null &&
      +o.PERatio <= screen.pe &&
      number(o.QuarterlyRevenueGrowthYOY) != null &&
      +o.QuarterlyRevenueGrowthYOY * 100 >= screen.growth &&
      (!screen.sector || a.sector === screen.sector)
    );
  });
}
function screenConfig() {
  return ((state.visualScreens ||= {})[state.mode] ||= { ...screenDefaults });
}
// ---- Screener: the S&P 500 market map, or your workspace -----------------
let marketSnap = null, // latest map snapshot from the desktop app
  marketInfo = null, // { built, job }
  marketTimer = null,
  marketError = "",
  marketChecked = 0,
  lastMapWidth = 0;
const screenUniverse = () => screenConfig().universe || (native ? "sp500" : "workspace");
function mapWidth() {
  const el = document.querySelector(".mm-wrap") || document.querySelector(".content");
  const w = el?.classList.contains("mm-wrap") ? el.clientWidth : (el?.clientWidth || window.innerWidth - 260) - 42;
  return (lastMapWidth = Math.max(320, Math.round(w)));
}
async function readMarket(full = false) {
  try {
    marketInfo = await marketStatus();
    if (full || (marketInfo.built && marketInfo.built !== marketSnap?.built)) marketSnap = await marketSnapshot();
  } catch (e) {
    marketError = message(e);
  }
}
// Rebuilds the map when it's missing or old (15 minutes with every horizon,
// an hour for Finnhub's slower quote-by-quote build), then polls while it runs.
async function ensureMarket(force = false) {
  if (!native) return;
  if (!marketInfo) await readMarket(true);
  const age = Date.now() / 1000 - (marketInfo?.built || 0);
  const maxAge = marketSnap?.source === "finnhub" ? 3600 : 900;
  // A build cut short (the app closed mid-way) starts again on the next launch.
  const unfinished = marketSnap && marketSnap.complete === false;
  if ((force || unfinished || age > maxAge) && !marketInfo?.job?.running && live() && (hasAlpaca() || hasKey("finnhub"))) {
    try {
      await marketRefresh();
      marketError = "";
    } catch (e) {
      marketError = message(e);
    }
    await readMarket();
  }
  if (marketTimer || !marketInfo?.job?.running) return refresh();
  let tick = 0;
  marketTimer = setInterval(async () => {
    await readMarket(++tick % 5 === 0);
    paintJobs();
    if (marketInfo?.job?.running && tick % 5) return;
    if (!marketInfo?.job?.running) {
      clearInterval(marketTimer);
      marketTimer = null;
      await readMarket(true);
    }
    if (page === "Screener") refresh();
  }, 1000);
}
function marketPanel() {
  if (!native) return `<section class="panel">${empty("The S&P 500 market map loads in the desktop app.")}</section>`;
  const job = marketInfo?.job;
  const status = `<div class="job-line" data-job="market">${jobLine(job)}</div>`;
  if (marketSnap?.tiles?.length) return (job?.running ? `<p class="muted">Updating the map…</p>${status}` : "") + marketMapView(marketSnap, screenConfig(), mapWidth());
  if (!hasAlpaca() && !hasKey("finnhub"))
    return `<section class="panel"><div class="empty">The market map needs a free Alpaca key (every horizon) or a Finnhub key (today's change).<br>${button("Add one in Settings", "goto-settings", "primary")}</div></section>`;
  if (state.mode !== "market") return `<section class="panel">${empty("Switch to Live data to load the S&P 500 market map.")}</section>`;
  return `<section class="panel"><div class="panel-head"><h2>S&amp;P 500 market map</h2>${job?.error || marketError ? button("Try again", "market-refresh", "primary") : ""}</div>${empty(esc(job?.error || marketError || "Building the market map: the S&P 500 list, shares outstanding from SEC, then prices."))}${status}</section>`;
}
function screener() {
  const which = screenUniverse();
  const tabs = `<div class="screen-universe">${button("S&amp;P 500 market map", "screen-universe", which === "sp500" ? "active" : "", 'data-value="sp500"')}${button(`Your workspace <small>${assets().length}</small>`, "screen-universe", which === "workspace" ? "active" : "", 'data-value="workspace"')}</div>`;
  return tabs + (which === "sp500" ? marketPanel() : workspaceScreener());
}
function workspaceScreener() {
  return screenerView(
    assets(),
    screenConfig(),
    (state.savedVisualScreens || []).filter((x) => x.mode === state.mode),
  );
}
function legacyScreener() {
  return `<section class="panel"><div class="panel-head"><h2>Screen your downloaded universe</h2>${button("Save screen", "screen-save")}${button("Export results", "screen-export")}</div><div class="filters"><label>Maximum P/E<input id="max-pe" type="number" value="${screen.pe}"></label><label>Minimum revenue growth (%)<input id="min-growth" type="number" value="${screen.growth}"></label><label>Sector<select id="sector"><option value="">All sectors</option>${[
    ...new Set(
      assets()
        .map((a) => a.sector)
        .filter(Boolean),
    ),
  ]
    .map(
      (s) =>
        `<option ${s === screen.sector ? "selected" : ""}>${esc(s)}</option>`,
    )
    .join(
      "",
    )}</select></label>${button("Apply filters", "screen-apply", "primary")}</div><p class="muted">Screens only locally downloaded company overviews. Missing ratios are excluded. ${filtered().length} matches / ${assets().length} assets.</p>${table(
    [
      "Company",
      "Sector",
      "Price",
      "P/E",
      "Margin",
      "Revenue growth YoY",
      "Market cap",
    ],
    filtered().map(
      (a) =>
        `<tr><td>${ticker(a)}</td><td>${esc(a.sector)}</td><td>${money(price(a))}</td><td>${fmt(number(a.overview.PERatio))}</td><td>${pct(number(a.overview.ProfitMargin))}</td><td>${pct(number(a.overview.QuarterlyRevenueGrowthYOY))}</td><td>${compact(number(a.overview.MarketCapitalization))}</td></tr>`,
    ),
  )}<div class="panel-head"><h2>Saved screens</h2></div>${state.screens.map((s, i) => button(esc(s.name), "screen-load", "", `data-value="${i}"`)).join("") || empty("Save filters for your next research session.")}</section><section class="panel"><div class="panel-head"><h2>Peer comparison</h2></div>${table(
    [
      "Metric",
      ...filtered()
        .slice(0, 6)
        .map((a) => a.symbol),
    ],
    [
      "PERatio",
      "PEGRatio",
      "PriceToBookRatio",
      "EVToEBITDA",
      "ProfitMargin",
      "ReturnOnEquityTTM",
    ].map(
      (k) =>
        `<tr><td>${k}</td>${filtered()
          .slice(0, 6)
          .map((a) => `<td>${fmt(number(a.overview[k]))}</td>`)
          .join("")}</tr>`,
    ),
  )}</section>`;
}
function modelInputs() {
  return Object.fromEntries(
    ["fcf", "growth", "discount", "terminal", "netDebt", "shares"].map((k) => [
      k,
      Number($("#" + k).value) /
        (["growth", "discount", "terminal"].includes(k) ? 100 : 1),
    ]),
  );
}
function calcDCF() {
  try {
    const m = modelInputs(),
      base = dcf(m),
      // Illustrative inputs say nothing about this stock; don't compare them to its price.
      px = dcfModel().origin === "illustrative" ? null : price(stockAsset());
    $("#dcf-results").innerHTML =
      scenarios(m)
        .map((r) => `<div class="scenario"><span>${r.name}</span><strong>${fmt(r.perShare)}</strong><small>Growth ${pct(r.growth)} · discount ${pct(r.discount)}${px && r.perShare != null ? ` · <span class="${tone(r.perShare / px - 1)}">${signed(r.perShare / px - 1, pct)} vs ${fmt(px)}</span>` : ""}</small></div>`)
        .join("") + `<p>Enterprise value: ${compact(base.enterprise)} million</p><p>Terminal value: ${pct(base.terminalShare)} of enterprise value</p>`;
    const gs = [-0.01, 0, 0.01].map((x) => m.terminal + x);
    $("#sensitivity").innerHTML = table(
      ["Discount / terminal", ...gs.map(pct)],
      [-0.02, -0.01, 0, 0.01, 0.02].map((x) => {
        let rate = m.discount + x;
        return `<tr><td>${pct(rate)}</td>${gs.map((g) => `<td>${rate > g ? fmt(dcf({ ...m, discount: rate, terminal: g }).perShare) : "Invalid"}</td>`).join("")}</tr>`;
      }),
    );
    return m;
  } catch (e) {
    $("#dcf-results").textContent = e.message;
    $("#sensitivity").textContent = "";
    return null;
  }
}
const macroSeries = {
  CPIAUCSL: "Consumer prices · index, 1982–84=100",
  UNRATE: "Unemployment · percent",
  FEDFUNDS: "Fed funds · percent",
  DGS10: "10Y Treasury yield · percent",
  DGS2: "2Y Treasury yield · percent",
  GDPC1: "Real GDP · billions of chained 2017 USD",
};
function economy() {
  const note = !native
    ? "Economic series load in the desktop app."
    : !hasKey("fred")
      ? "Add a free FRED key in Settings → Data sources to load these series."
      : "";
  return `<section class="panel"><div class="panel-head"><h2>Economic observatory</h2>${native && hasKey("fred") ? button("Refresh", "macro-refresh") : ""}</div><p>FRED observations in their original units: GDP is quarterly, CPI and unemployment monthly, Treasury yields daily.${note ? " <b>" + esc(note) + "</b>" : ""}</p><div class="macro-grid">${Object.entries(
    macroSeries,
  )
    .map(([s, label]) => seriesCard(s, label, note))
    .join("")}</div></section>`;
}
function spark(values) {
  if (values.length < 2) return "";
  let min = Math.min(...values),
    max = Math.max(...values);
  return `<svg class="spark" viewBox="0 0 400 90" preserveAspectRatio="none"><polyline fill="none" stroke="#e5e5e5" stroke-width="2" points="${values.map((v, i) => `${(i / (values.length - 1)) * 400},${80 - ((v - min) / (max - min || 1)) * 70}`).join(" ")}"/></svg>`;
}
function alerts() {
  return `<section class="panel"><div class="panel-head"><h2>Price alerts</h2></div><div class="filters"><label>Symbol<select id="alert-symbol">${assets()
    .map((a) => `<option>${a.symbol}</option>`)
    .join(
      "",
    )}</select></label><label>Condition<select id="alert-direction"><option value="above">At or above</option><option value="below">At or below</option></select></label><label>Price<input id="alert-target" type="number" min="0.01" step="any"></label>${button("Create alert", "alert-add", "primary")}</div><p>Evaluated against the latest stored close when data changes or the workspace opens. Alerts do not monitor markets while the app is closed.</p>${table(
    ["Asset", "Condition", "Target", "Status", ""],
    state.alerts
      .filter((a) => a.mode === state.mode)
      .map(
        (a) =>
          `<tr><td>${esc(a.symbol)}</td><td>${a.direction}</td><td>${money(a.target)}</td><td class="${a.triggered ? "up" : ""}">${a.triggered ? "Triggered" : "Watching"}</td><td>${button("Remove", "alert-remove", "", `data-value="${a.id}"`)}</td></tr>`,
      ),
  )}</section>`;
}
function keyRow(p, setupMode) {
  const info = providers[p],
    k = keyInfo?.[p];
  const status = k?.configured
    ? `<span class="pill on">Connected${k.source === "environment" ? " · environment variable" : ""}</span>`
    : `<span class="pill">Not connected</span>`;
  return `<div class="source-row"><div class="source-info"><h3>${info.name} ${setupMode ? "" : status}</h3><small>${info.provides}<br>${info.limits}</small>${!setupMode && lastError[p] ? `<small class="down">Last error: ${esc(lastError[p])}</small>` : ""}</div><div class="source-key"><input id="key-${p}" type="${info.email ? "email" : "password"}" autocomplete="off" spellcheck="false" placeholder="${info.email ? (k?.configured ? "Replace contact email" : "you@example.com (optional)") : k?.configured ? "Replace saved key" : "Paste API key"}" aria-label="${info.name} ${info.email ? "contact email" : info.secret ? "key ID" : "API key"}">${info.secret ? `<input id="key-${p}secret" type="password" autocomplete="off" spellcheck="false" placeholder="${keyInfo?.[p + "secret"]?.configured ? "Replace secret" : "Secret key"}" aria-label="${info.name} secret key">` : ""}${!setupMode && k?.source === "saved" ? button("Remove", "key-remove", "icon", `data-value="${p}"`) : ""}${link(info.keyURL, info.label || "Get a free key")}</div></div>`;
}
function priceSelect() {
  return `<label>Prices from<select id="price-source">${priceProviders.map((p) => `<option value="${p}" ${state.sources.prices === p ? "selected" : ""}>${providers[p].name}${hasKey(p) ? "" : " (no key)"}</option>`).join("")}</select></label>`;
}
function setup() {
  return `<section class="panel setup"><p>Paste your free API keys once. They are saved on this computer, in a file only your user account can read, and the app loads data on its own from then on. One key is enough to start; all three gives you everything.</p>${["twelve", "finnhub", "alpha", "alpaca", "fred", "ais", "sec"].map((p) => keyRow(p, true)).join("")}${priceSelect()}<div class="setup-actions">${button("Connect and load data", "setup-connect", "primary")}${button("Explore demo data instead", "setup-demo")}</div><small>Recommended: Twelve Data for price history, Finnhub for real-time prices, news and key metrics, Alpha Vantage for financial statements, Alpaca for past trades, FRED for the economy.</small></section>`;
}
function settings() {
  if (!native)
    return `<section class="panel"><div class="panel-head"><h2>Data sources</h2></div>${empty("Live data connects in the desktop app (npm run tauri dev or the installed app). This browser preview only has demo data.")}</section>${workspacePanel()}`;
  return `<section class="panel"><div class="panel-head"><h2>Data sources</h2>${button("Save keys", "keys-save", "primary")}${button("Sync now", "sync")}</div>${["twelve", "finnhub", "alpha", "alpaca", "fred", "ais", "sec"].map((p) => keyRow(p, false)).join("")}${priceSelect()}<small>Keys are saved in credentials.json in your app-data folder (owner-only permissions), never in backups or the workspace. Environment variables ALPHA_VANTAGE_API_KEY, TWELVE_DATA_API_KEY, FINNHUB_API_KEY, ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY, FRED_API_KEY, AISSTREAM_API_KEY and SEC_CONTACT_EMAIL override saved values. Requests stay inside each free plan: saved data is reused for 1 hour (Twelve Data), 6 hours (Alpha Vantage) or 12 hours (FRED).</small></section>${referencePanel()}${quantPanel()}${workspacePanel()}<section class="panel"><div class="panel-head"><h2>Source policy & coverage</h2></div><p>Data comes only from your own provider accounts and public sources. No scraping, paywall bypass, shared credentials or quota evasion. Free access is not a redistribution license.</p><p>Coverage: USD stock/ETF daily prices, company fundamentals, news, earnings calendar, FRED macro series, FRED commodity prices and live AIS vessel positions (AISStream). Not included: tick data, options chains, corporate-action processing, live brokerage execution or tax accounting.</p>${link("https://twelvedata.com/terms", "Twelve Data terms")} · ${link("https://www.alphavantage.co/terms_of_service/", "Alpha Vantage terms")} · ${link("https://fred.stlouisfed.org/docs/api/terms_of_use.html", "FRED terms")}</section>`;
}
function workspacePanel() {
  return `<section class="panel"><div class="panel-head"><h2>Workspace</h2>${button("Export full backup", "backup")}${button("Export selected prices", "prices-export")}</div><label>Paper account starting cash<input id="initial-cash" type="number" min="1" value="${account().initial}" ${account().trades.length ? "disabled" : ""}></label>${button("Set starting cash", "cash")}<small>Starting cash is editable only before the first trade. Native data lives in aperture.sqlite in your OS app-data folder.</small><details class="advanced"><summary>Advanced</summary><label>Restore a backup file (replaces the workspace)<input id="restore" type="file" accept=".json"></label></details></section>`;
}
function download(name, content, type = "text/plain") {
  if (native) {
    window.__TAURI__.core
      .invoke("export_file", { filename: name, contents: content })
      .then((saved) => {
        if (saved) notify("File saved.");
      })
      .catch((e) => notify(String(e), true));
    return;
  }

  const a = document.createElement("a"),
    url = URL.createObjectURL(new Blob([content], { type }));
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// ---- Risk analytics (GS Quant) ---------------------------------------------------
// gs-quant runs in the user's own Python through the desktop app (quant.rs).
// Results live for the session and are recomputed when prices change.
let quantEnv = null, // quant_status: { python, version, gsQuant, chosen, install } or { error }
  quantChecking = null;
const quantRuns = {}; // symbol -> { key, running } | { key, data, fed } | { key, error }
function checkQuant(again = false) {
  if (!native) return Promise.resolve(null);
  if (quantChecking) return quantChecking;
  quantChecking = quantStatus(again)
    .then((s) => (quantEnv = s))
    .catch((e) => (quantEnv = { error: message(e) }))
    .finally(() => {
      quantChecking = null;
      refresh();
    });
  return quantChecking;
}
function runQuant(force = false) {
  const a = stockAsset();
  if (!native || !quantEnv?.gsQuant || !a?.bars?.length) return;
  const bench = assets().find((x) => x.symbol === BENCHMARK) || null;
  const fed = state.mode === "market" ? fredRate(state.macro.FEDFUNDS) : null;
  const req = quantRequest(a.symbol, a.bars, bench, fed?.rate || 0);
  const key = quantKey(req),
    s = a.symbol,
    prev = quantRuns[s];
  if (prev?.running || (!force && prev?.key === key)) return;
  quantRuns[s] = { key, running: true };
  quantAnalyze(req)
    .then((data) => (quantRuns[s] = { key, data, fed }))
    .catch((e) => (quantRuns[s] = { key, error: message(e) }))
    .finally(refresh);
}
const gsQuantLink = () => link("https://github.com/goldmansachs/gs-quant", "gs-quant on GitHub");
// What's missing before analytics can run, or "" when ready.
function quantBlocker(full) {
  if (!native) return empty("Risk analytics run in the desktop app, using GS Quant in your own Python.");
  const e = quantEnv;
  if (!e) return empty("Looking for Python and GS Quant…");
  if (e.error) return empty(esc(e.error));
  const actions = full ? `<div class="quant-actions">${button("Check again", "quant-check")}${button("Choose Python…", "quant-choose")}</div>` : "";
  if (!e.python) return `<div class="empty">No Python 3 found. Install Python 3, then run<code class="cmd-line">${esc(e.install)}</code>${actions}</div>`;
  if (!e.gsQuant) return `<div class="empty">GS Quant isn't installed for Python ${esc(e.version)}. Run<code class="cmd-line">${esc(e.install)}</code>${actions || "then open this panel."}</div>`;
  return "";
}
function quantResult(full) {
  const r = quantRuns[symbol];
  if (!stockAsset()) return noStock();
  if (!r || r.running) return empty(`Calculating with GS Quant…${full ? "<br><small>The first run after installing can take a minute while Python compiles the library.</small>" : ""}`);
  if (r.error) return `<div class="empty">${esc(r.error)}${full ? `<div class="quant-actions">${button("Try again", "quant-run")}${button("Choose Python…", "quant-choose")}</div>` : ""}</div>`;
  return "";
}
function riskTile() {
  const wait = quantBlocker(false) || quantResult(false);
  if (wait) return wait;
  const d = quantRuns[symbol].data,
    m = d.metrics;
  const cell = (label, kind, v, note) => `<div class="scenario"><span>${label}</span><strong>${formatRisk(kind, v)}</strong><small>${note}</small></div>`;
  return `<div class="scenarios compact risk-cells">${cell("Volatility · 3M", "vol", m.vol3m, "annualized")}${cell("Sharpe · 1Y", "x", m.sharpe1y, "over cash")}${cell("Max drawdown · 1Y", "pct", m.maxDrawdown1y, "peak to trough")}${cell("Beta · 3M", "x", m.beta3m, d.benchmark ? "vs " + esc(d.benchmark) : "add " + BENCHMARK + " to compare")}</div>${spark(d.series.vol.map((x) => x[1]))}<small>Rolling 1-month volatility · GS Quant ${esc(d.gsQuant)}</small>`;
}
function riskChart(title, rows, kind) {
  if (!rows?.length) return "";
  return `<section class="macro-card"><h3>${title}</h3><strong>${formatRisk(kind, rows.at(-1)[1])}</strong><small>${esc(rows[0][0])} to ${esc(rows.at(-1)[0])}</small>${spark(rows.map((x) => x[1]))}</section>`;
}
function riskView() {
  const ready = native && quantEnv?.gsQuant;
  const head = `<div class="panel-head"><h2>Risk analytics · GS Quant</h2>${ready ? button("Recalculate", "quant-run") : ""}</div>`;
  const about = `<p class="muted">Calculated by Goldman Sachs' open-source gs-quant library (gs_quant.timeseries) in your own Python, from the daily closes in this workspace. Only offline functions are used: nothing is sent to Goldman Sachs and no Marquee account is needed. ${gsQuantLink()}</p>`;
  const wait = quantBlocker(true) || quantResult(true);
  if (wait) return `<section class="panel">${head}${about}${wait}</section>`;
  const r = quantRuns[symbol],
    d = r.data,
    m = d.metrics;
  const rows = RISK_ROWS.map((x) => [
    x.label,
    `<b>${formatRisk(x.kind, m[x.key])}</b>`,
    `<code>${esc(x.fn)}</code>`,
    esc(x.bench ? (d.benchmark ? `vs ${d.benchmark}, daily returns` : `Add ${BENCHMARK} to the watchlist to compare against the market`) : x.note || ""),
  ]);
  const band = bandPosition(stockAsset()?.bars?.at(-1)?.close, m.bollingerLow, m.bollingerHigh);
  if (m.bollingerLow != null)
    rows.push(["Bollinger band · 20 days", `<b>${fmt(m.bollingerLow)} – ${fmt(m.bollingerHigh)}</b>`, "<code>bollinger_bands(x, 20, 2)</code>", band == null ? "" : `last close at ${Math.round(band * 100)}% of the band`]);
  const rate = d.riskFree
    ? `Sharpe uses the fed funds rate from FRED, ${pct(d.riskFree)}${r.fed?.date ? ` (${esc(r.fed.date)})` : ""}, as the cash rate.`
    : `Sharpe uses a 0% cash rate${hasKey("fred") ? "; open Economy to load the fed funds rate" : ""}.`;
  return `<section class="panel">${head}${about}${table(["Measure", "Value", "gs_quant.timeseries", "Notes"], rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`))}<small>${esc(d.points)} daily closes through ${esc(d.asOf)} · GS Quant ${esc(d.gsQuant)} · Python ${esc(d.python)}. ${rate} Prices are not adjusted for dividends.</small></section><div class="macro-grid risk-charts">${riskChart("Rolling volatility · 1 month", d.series.vol, "vol")}${riskChart("Below 1-year high", d.series.drawdown, "pct")}${riskChart(`Rolling beta vs ${esc(d.benchmark || BENCHMARK)} · 3 months`, d.series.beta, "x")}</div>`;
}
function quantPanel() {
  const e = quantEnv;
  const status = !e ? '<span class="pill">Checking…</span>' : e.gsQuant ? `<span class="pill on">GS Quant ${esc(e.gsQuant)}</span>` : '<span class="pill">Not installed</span>';
  const where = e?.python ? `<p>Python ${esc(e.version)} · <code>${esc(e.python)}</code> · ${e.chosen ? "chosen by you" : "found automatically"}</p>` : e?.error ? `<p class="down">${esc(e.error)}</p>` : e ? "<p>No Python 3 found on this computer.</p>" : "";
  const install = e && !e.gsQuant ? `<p>Install it with <code class="cmd-line">${esc(e.install)}</code>then press Check again. Using a virtual environment? Choose its Python.</p>` : "";
  return `<section class="panel"><div class="panel-head"><h2>GS Quant ${status}</h2>${button("Check again", "quant-check")}${button("Choose Python…", "quant-choose")}${e?.chosen ? button("Find automatically", "quant-forget") : ""}</div><p>Risk analytics (<kbd>RSK</kbd> on each stock page) come from Goldman Sachs' open-source gs-quant library, run by your own Python. Only its offline timeseries functions are used; nothing is sent to Goldman Sachs and no Marquee account is needed. Set <code>APERTURE_PYTHON</code> to point at a specific interpreter. ${gsQuantLink()}</p>${where}${install}</section>`;
}
// ---- Data loading -------------------------------------------------------
// Every provider call goes through one queue so requests never pile up and
// each free plan's per-minute limit is respected by the backend.
let queue = Promise.resolve();
const queued = new Map();
function enqueue(key, job) {
  if (queued.has(key)) return queued.get(key);
  const run = queue.then(job);
  queue = run.catch(() => {});
  queued.set(key, run);
  run.finally(() => queued.delete(key)).catch(() => {});
  return run;
}
const message = (e) => String(e?.message || e);
async function loadPrices(s) {
  const p = priceSource(state.sources.prices, keyInfo);
  if (!p) throw Error("Connect a price source in Settings → Data sources.");
  // Listings outside the US can fall back to the other provider.
  const order = isUSKey(s) ? [p] : [p, p === "twelve" ? "alpha" : "twelve"].filter((x) => hasKey(x) && (x !== "alpha" || alphaSymbol(s)));
  const failures = [];
  for (const src of order) {
    try {
      return await loadPricesFrom(src, s);
    } catch (e) {
      failures.push(`${providers[src].name}: ${message(e)}`);
    }
  }
  const msg = failures.join(" · ") + (isUSKey(s) ? "" : " Free plans mostly cover US markets; other exchanges may need a paid plan.");
  loadErrors["prices:" + s] = msg;
  lastError[p] = `${s}: ${msg}`;
  throw Error(msg);
}
async function loadPricesFrom(p, s) {
  {
    const d =
      p === "twelve"
        ? await fetchData("twelve", "TIME_SERIES", s)
        : await fetchData("alpha", "TIME_SERIES_DAILY", alphaSymbol(s) || s);
    let bars;
    try {
      bars = p === "twelve" ? normalizeTwelve(d.data) : normalizeAlpha(d.data);
    } catch {
      throw Error(`${providers[p].name} has no daily prices for ${s}.`);
    }
    const map = (state.marketAssets ||= {}),
      prev = map[s]?.origin === "sample" ? {} : map[s] || {};
    map[s] = {
      ...prev,
      symbol: s,
      name: prev.name || s,
      bars,
      origin: p,
      source: providers[p].name + " · daily" + (d.stale ? " · STALE" : "") + (hasKey("finnhub") && isUSKey(s) ? " · real-time trades from Finnhub" : ""),
      fetchedAt: d.fetchedAt,
      live: undefined,
    };
    delete loadErrors["prices:" + s];
    if (d.warning) lastError[p] = d.warning;
    return d;
  }
}
async function loadDataset(kind, s) {
  const key = `${s}:${kind}`;
  try {
    const d = await fetchData("alpha", kind, s);
    state.datasets[key] = d;
    if (kind === "OVERVIEW") {
      if (!d.data.Symbol)
        throw Error(`Alpha Vantage has no company profile for ${s} (funds and ETFs usually don't).`);
      const map = (state.marketAssets ||= {});
      if (map[s])
        map[s] = { ...map[s], name: d.data.Name, sector: d.data.Sector, overview: d.data };
    }
    delete loadErrors[key];
    if (d.warning) lastError.alpha = d.warning;
  } catch (e) {
    loadErrors[key] = message(e);
    lastError.alpha = message(e);
    throw e;
  }
}
async function loadMacro(id) {
  try {
    state.macro[id] = await fetchData("fred", "observations", id);
    delete loadErrors["fred:" + id];
    delete lastError.fred;
  } catch (e) {
    loadErrors["fred:" + id] = lastError.fred = message(e);
    throw e;
  }
}
// Pull whatever the current page needs and doesn't have yet.
function autoLoad() {
  const v = page === "Stock" ? stockView || "GRID" : "";
  if (["GRID", "HDS", "OWN"].includes(v) && native && symbol) {
    loadHolders(symbol);
    loadOwnership(symbol);
  }
  if (page === "Universe") loadUniverse();
  // Check the map's age at most once a minute while the Screener is open.
  if (page === "Screener" && screenUniverse() === "sp500" && Date.now() - marketChecked > 60000) {
    marketChecked = Date.now();
    ensureMarket();
  }
  if (native && page === "Stock" && ["GRID", "RSK"].includes(v) && symbol) {
    if (!quantEnv) checkQuant().then(() => runQuant());
    else runQuant();
  }
  if (native && page === "Settings" && !quantEnv) checkQuant();
  if (!live()) return;
  const once = (key, job) => {
    if (attempted.has(key)) return;
    attempted.add(key);
    enqueue(key, async () => {
      try {
        await job();
      } finally {
        await persist();
        refresh();
      }
    }).catch(() => {});
  };
  // Fast sources skip the shared queue so they never wait behind Alpha
  // Vantage's 13-second spacing.
  const now_ = (key, job) => {
    if (attempted.has(key)) return;
    attempted.add(key);
    refresh();
    job()
      .catch(() => {})
      .finally(async () => {
        await persist();
        refresh();
      });
  };
  const a = stockAsset();
  if (["GRID", "DES", "FA"].includes(v) && a && hasKey("alpha") && isUSKey(a.symbol)) {
    const s = a.symbol;
    // Saved for a week: statements change quarterly and Alpha Vantage allows 25 calls a day.
    const week = 7 * 86400;
    if (!a.overview || stale(state.datasets[`${s}:OVERVIEW`], week)) once(`${s}:OVERVIEW`, () => loadDataset("OVERVIEW", s));
    // The income statement also feeds P/E, margin and growth.
    for (const kind of new Set(["INCOME_STATEMENT", statement]))
      if (stale(state.datasets[`${s}:${kind}`], week)) once(`${s}:${kind}`, () => loadDataset(kind, s));
  }
  if (hasKey("finnhub") && isUSKey(symbol) && page === "Stock") {
    const s = symbol;
    const want = { "company-news": ["GRID", "CN"], metric: ["GRID", "DES", "FA"], profile2: ["GRID", "DES"], earnings: ["DES", "CN"] };
    for (const [kind, views] of Object.entries(want))
      if (views.includes(v) && stale(state.datasets[`${s}:FH_${kind}`], 1800)) now_(`${s}:FH_${kind}`, () => loadFinnhub(kind, s));
  }
  if (["GRID", "TAS"].includes(v) && isUSKey(symbol) && (hasAlpaca() || hasKey("twelve")) && !(tapes[symbol] || []).length) {
    const s = symbol;
    now_(`past:${s}:${Math.floor(Date.now() / 300000)}`, () => loadPastTape(s));
  }
  if (["GRID", "FA", "CF"].includes(v) && isUSKey(symbol) && (cikFor(symbol) || hasKey("sec")) && stale(state.secData?.[symbol], 86400)) {
    const s = symbol;
    once("sec:" + s, () => loadSEC(s));
  }
  // Filing figures also feed the key statistics (shares, net income).
  if (["GRID", "DCF", "DES", "FA"].includes(v) && isUSKey(symbol) && (cikFor(symbol) || hasKey("sec")) && (stale(state.valuationData?.[symbol], 7 * 86400) || !state.valuationData[symbol].basis)) {
    const s = symbol;
    once("val:" + s, () => loadValuation(s));
  }
  if (v === "SPLC") autoScan(graphCenter);
  if (page === "Economy" && hasKey("fred"))
    for (const id of Object.keys(macroSeries))
      if (stale(state.macro[id], 43200)) once("fred:" + id, () => loadMacro(id));
  if (page === "Commodities" && hasKey("fred"))
    for (const id of Object.keys(commoditySeries))
      if (stale(state.macro[id], 43200)) once("fred:" + id, () => loadMacro(id));
}
let syncing = null;
async function syncWatchlist() {
  if (!native || state.mode !== "market" || syncing) return syncing;
  const p = priceSource(state.sources.prices, keyInfo);
  if (!p) return;
  const list = [...new Set(state.watchlist)];
  const failed = [];
  let done = 0;
  syncing = (async () => {
    for (const s of list)
      enqueue("prices:" + s, async () => {
        setSync(`Updating ${s} (${++done}/${list.length})…`);
        try {
          await loadPrices(s);
          refresh();
        } catch {
          failed.push(s);
        }
      });
    await queue;
    state.lastSync = Date.now() / 1000;
    syncLabel = failed.length ? `Couldn't update ${failed.join(", ")} · see Settings` : "";
    await persist();
    refresh();
  })().finally(() => (syncing = null));
  return syncing;
}
// Loads daily prices and listing details for a ticker not yet in the
// workspace, without adding it to the watchlist.
async function ensureAsset(s, meta = null) {
  if (!live() || activeMap()[s]) return;
  setSync(`Loading ${s}…`);
  try {
    await enqueue("prices:" + s, () => loadPrices(s));
  } finally {
    setSync("");
  }
  // Listing details from the directory: name, exchange, currency.
  const l = meta || (await universeGet(s).catch(() => null));
  if (l && activeMap()[s]) Object.assign(activeMap()[s], { name: l.name || s, exchange: l.exchange, country: l.country, currency: l.currency, kind: l.kind, sector: activeMap()[s].sector || l.kind });
  await persist();
}
async function addTicker(s, openIt, meta = null) {
  s = s.trim().toUpperCase();
  if (!tickerPattern.test(s)) throw Error("Enter a ticker like AAPL, or pick a listing from the search list.");
  if (state.mode === "sample" && !activeMap()[s])
    throw Error("Demo data only has its sample tickers. Switch to Live data to add " + s + ".");
  await ensureAsset(s, meta);
  if (!state.watchlist.includes(s)) state.watchlist.push(s);
  await persist();
  if (openIt) return openStock(s);
  render();
}
function bind() {
  const recenter = (id) => {
    goToEntity(id);
    render();
  };
  // Highlight a company's links while the pointer is over it.
  document.querySelectorAll(".g-node:not(.center)").forEach((el) => {
    const svg = el.ownerSVGElement;
    el.onmouseenter = () => {
      svg.classList.add("hovering");
      svg.querySelectorAll(`[data-edge-for="${CSS.escape(el.dataset.entity)}"]`).forEach((p) => p.classList.add("hot"));
    };
    el.onmouseleave = () => {
      svg.classList.remove("hovering");
      svg.querySelectorAll(".hot").forEach((p) => p.classList.remove("hot"));
    };
  });
  document.querySelectorAll("[data-entity]").forEach((el) => {
    el.onclick = () => recenter(el.dataset.entity);
    el.onkeydown = (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        recenter(el.dataset.entity);
      }
    };
  });
  if ($("#graph-search")) bindCompanySearch(recenter);
  if ($("#graph-candidates"))
    $("#graph-candidates").onchange = (event) => {
      graphCandidates = event.target.value === "all";
      render();
    };
  if ($("#graph-import"))
    $("#graph-import").onchange = async (event) => {
      try {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 5e6) throw Error("Graph import limit is 5 MB");
        const next = mergeGraph(graph(), JSON.parse(await file.text()));
        state.relationshipGraph = next;
        await persist();
        graphCandidates = true;
        render();
        notify(
          "Evidence imported as unreviewed claims. Select an entity to inspect sources.",
        );
      } catch (error) {
        notify(error.message, true);
      }
    };

  document.querySelectorAll("[data-screen-field]").forEach(
    (el) =>
      (el.onchange = async () => {
        screenConfig()[el.dataset.screenField] = el.value;
        try {
          await persist();
          render();
        } catch (e) {
          notify(e.message, true);
        }
      }),
  );

  document.querySelectorAll("[data-page]").forEach(
    (el) =>
      (el.onclick = () => {
        if (el.dataset.page === "Stock") return openStock(symbol, stockView);
        page = el.dataset.page;
        // Trading needs a stock with prices in this workspace.
        if (page === "Trade" && !stockAsset() && asset()) symbol = asset().symbol;
        render();
      }),
  );
  document.querySelectorAll("[data-recent]").forEach((el) => (el.onclick = () => openStock(el.dataset.recent, page === "Stock" ? stockView : null)));
  // Watchlist rows, heatmap cells and movers open the stock page; on Trade
  // they pick the stock to trade.
  document.querySelectorAll("[data-symbol]").forEach(
    (el) =>
      (el.onclick = () => {
        if (page !== "Trade") return openStock(el.dataset.symbol, null);
        symbol = el.dataset.symbol;
        render();
      }),
  );
  document.querySelectorAll("[data-action]").forEach(
    (el) =>
      (el.onclick = async () => {
        if (busy) return;
        busy = true;
        el.disabled = true;
        try {
          await action(el.dataset.action, el.dataset.value);
        } catch (e) {
          notify(String(e.message || e), true);
        } finally {
          busy = false;
          el.disabled = false;
        }
      }),
  );
  $("#mode").onchange = async (e) => {
    state.mode = e.target.value;
    compare = "";
    if (page === "Setup") page = "Overview";
    await persist();
    render();
    syncWatchlist();
  };
  if ($("#price-source"))
    $("#price-source").onchange = async (e) => {
      state.sources.prices = e.target.value;
      await persist();
    };
  if ($("#watch-input"))
    $("#watch-input").onkeydown = (e) => {
      if (e.key === "Enter") $('[data-action="watch-add"]').click();
    };
  bindSearch();
  if ($("#asset-select"))
    $("#asset-select").onchange = (e) => {
      if (page === "Stock") return openStock(e.target.value);
      symbol = e.target.value;
      render();
    };
  if ($("#compare"))
    $("#compare").onchange = (e) => {
      compare = e.target.value;
      drawCharts();
    };
  if ($("#statement"))
    $("#statement").onchange = (e) => {
      statement = e.target.value;
      render();
    };
  if ($("#period"))
    $("#period").onchange = (e) => {
      period = e.target.value;
      render();
    };
  if ($("#qty")) {
    const calc = () =>
      ($("#order-total").textContent = money(
        +$("#qty").value * +$("#fill").value + +$("#fee").value,
      ));
    ["qty", "fill", "fee"].forEach((id) => ($("#" + id).oninput = calc));
    calc();
  }
  if ($("#shock")) {
    const calc = () => {
      const p = portfolio(
          account(),
          Object.fromEntries(assets().map((a) => [a.symbol, a])),
        ),
        shock = +$("#shock").value / 100;
      $("#stress").innerHTML =
        `<strong>${money(p.cash + (p.value - p.cash) * (1 + shock))}</strong><span>${pct(shock)} asset shock · portfolio impact ${money((p.value - p.cash) * shock)}</span>`;
    };
    $("#shock").oninput = calc;
    calc();
  }
  if (page === "Stock" && stockView === "DCF") calcDCF();
  bindReference();
  if ($("#restore"))
    $("#restore").onchange = async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 20e6) throw Error("Backup limit is 20 MB");
        const restored = migrate(validateWorkspace(JSON.parse(await file.text())));
        if (restored.relationshipGraph)
          validateGraph(restored.relationshipGraph, { imported: true });
        if (
          !confirm(
            "Replace the entire current workspace with this backup? Export a backup first if needed.",
          )
        )
          return;
        state = restored;
        await persist();
        render();
        notify("Backup restored.");
      } catch (e) {
        notify(e.message, true);
      }
    };
  document.querySelectorAll('a[target="_blank"]').forEach(
    (a) =>
      (a.onclick = (e) => {
        if (native) {
          e.preventDefault();
          window.__TAURI__.core
            .invoke("plugin:opener|open_url", { url: a.href })
            .catch((e) => notify(String(e), true));
        }
      }),
  );
}
async function action(act, value) {
  switch (act) {
    case "graph-open":
      openStock(symbol, "SPLC");
      break;
    case "stock-view":
      openStock(symbol, value || null);
      break;
    case "watch-toggle":
      if (state.watchlist.includes(symbol)) state.watchlist = state.watchlist.filter((x) => x !== symbol);
      else if (stockAsset()) state.watchlist.push(symbol);
      else throw Error(`No prices for ${symbol} yet, so it can't be watched.`);
      await persist();
      render();
      break;
    case "goto-trade":
      page = "Trade";
      render();
      break;
    case "screen-universe":
      screenConfig().universe = value;
      await persist();
      render();
      break;
    case "market-refresh":
      await ensureMarket(true);
      notify("Rebuilding the S&P 500 market map…");
      break;
    case "own-filter":
      own.filter = value;
      render();
      break;
    case "graph-back":
      if (graphTrail.length > 1) {
        graphTrail = graphTrail.slice(0, -1);
        graphCenter = graphTrail.at(-1);
        render();
      }
      break;
    case "graph-crumb":
      graphTrail = graphTrail.slice(0, +value + 1);
      graphCenter = graphTrail.at(-1);
      render();
      break;
    case "sec-scan": {
      if (!hasKey("sec")) throw Error("Add your SEC contact email in Settings → Data sources first.");
      notify("Reading annual reports on EDGAR…");
      const r = await scanFilings(graphCenter);
      notify(`Found ${r.found} candidate mention(s) in the latest report; ${r.added} new to the graph. Review each source before relying on it.`);
      break;
    }
    case "graph-export":
      download(
        "company-relationships.json",
        JSON.stringify(graph(), null, 2),
        "application/json",
      );
      break;
    case "graph-review": {
      const edge = graph().edges.find((x) => x.id === value);
      if (!edge) throw Error("Relationship not found");
      if (
        !confirm(
          "Have you read the source and verified the named supplier, customer, direction and disclosure date? This marks evidence reviewed, not the relationship currently active.",
        )
      )
        return;
      edge.review = "reviewed";
      edge.reviewedOn = new Date().toISOString().slice(0, 10);
      await persist();
      render();
      break;
    }
    case "visual-screen-save":
      (state.savedVisualScreens ||= []).push({
        name: `${screenConfig().metric} / ${screenConfig().period} / ${screenConfig().sector || "All sectors"}`,
        mode: state.mode,
        options: { ...screenConfig() },
      });
      await persist();
      render();
      break;
    case "visual-screen-load": {
      const view = state.savedVisualScreens.filter(
        (x) => x.mode === state.mode,
      )[+value];
      state.visualScreens[state.mode] = { ...view.options };
      await persist();
      render();
      break;
    }
    case "visual-screen-export":
      download(
        "screener.csv",
        csv(
          screenRows(assets(), screenConfig()).map((a) => ({
            symbol: a.symbol,
            name: a.name,
            sector: a.sector,
            priceDate: a.bars.at(-1)?.date,
            source: a.source,
            ...a.overview,
          })),
        ),
        "text/csv",
      );
      break;

    case "research":
      openStock(value || symbol, null);
      break;
    case "range":
      range = +value;
      render();
      break;
    case "chart-type":
      candles = !candles;
      render();
      break;
    case "watch-add":
      await addTicker($("#watch-input")?.value || symbol, false);
      break;
    case "watch-remove":
      state.watchlist = state.watchlist.filter((x) => x !== value);
      await persist();
      render();
      break;
    case "note-save":
      state.notes[`${state.mode}:${symbol}`] = $("#note").value;
      await persist();
      notify("Thesis saved.");
      break;
    case "research-refresh": {
      const s = symbol;
      const jobs = [enqueue("prices:" + s, () => loadPrices(s))];
      if (hasKey("alpha") && isUSKey(s))
        for (const kind of new Set(["OVERVIEW", "INCOME_STATEMENT", statement]))
          jobs.push(enqueue(`${s}:${kind}`, () => loadDataset(kind, s)));
      if (hasKey("finnhub") && isUSKey(s))
        for (const kind of ["company-news", "metric", "profile2", "earnings"]) jobs.push(loadFinnhub(kind, s));
      notify("Refreshing " + s + "…");
      const results = await Promise.allSettled(jobs);
      await persist();
      render();
      const bad = results.find((r) => r.status === "rejected");
      notify(bad ? message(bad.reason) : s + " is up to date.", !!bad);
      break;
    }
    case "calendar-fetch":
      try {
        await enqueue(`${symbol}:EARNINGS_CALENDAR`, () =>
          loadDataset("EARNINGS_CALENDAR", symbol),
        );
      } finally {
        await persist();
        render();
      }
      break;
    case "hds-open":
      openHolders(value);
      break;
    case "hds-tab":
      hds.tab = value;
      render();
      break;
    case "hds-filter":
      hds.filter = value;
      hds.limit = 100;
      render();
      break;
    case "hds-sort":
      hds.dir = hds.sort === value ? -hds.dir : value === "name" ? 1 : -1;
      hds.sort = value;
      render();
      break;
    case "hds-more":
      hds.limit += 500;
      render();
      break;
    case "hds-reload": {
      const t = hdsTicker();
      const x = hdsEntry(t);
      delete hdsData[t];
      Object.assign(hdsEntry(t), { only: x.only, period: x.period });
      await readReference();
      render();
      break;
    }
    case "hds-securities": {
      const x = hdsEntry(hdsTicker());
      x.only = [...document.querySelectorAll("[data-cusip]")].filter((el) => el.checked).map((el) => el.dataset.cusip);
      if (!x.only.length) throw Error("Pick at least one security.");
      x.holders = null;
      x.comp = null;
      render();
      break;
    }
    case "hds-fund": {
      const cik = +value;
      hds.fund = { cik, data: null, error: "" };
      Object.assign(hds, { fundFilter: "all", fundSort: "value", fundLimit: 100 });
      render();
      document.querySelector(".fund")?.scrollIntoView({ block: "start" });
      try {
        hds.fund.data = await holderPortfolio(cik, hdsEntry(hdsTicker()).holders?.period || null);
      } catch (e) {
        hds.fund.error = message(e);
      }
      if (hds.fund?.cik === cik) render();
      break;
    }
    case "hds-fund-close":
      hds.fund = null;
      render();
      break;
    case "hds-fund-filter":
      hds.fundFilter = value;
      hds.fundLimit = 100;
      render();
      break;
    case "hds-fund-sort":
      hds.fundSort = value;
      render();
      break;
    case "hds-fund-more":
      hds.fundLimit += 500;
      render();
      break;
    case "hds-fund-export": {
      const v = hds.fund?.view;
      if (!v) break;
      download(
        `13f-${hds.fund.cik}-${v.period}.csv`,
        csv(v.rows.map((r) => ({ period: v.period, ticker: r.ticker || "", issuer: r.issuer, class: r.class, cusip: r.cusip, putcall: ["", "Put", "Call"][r.putcall], shares: r.shares, prevShares: r.prevShares, change: r.change, value: r.value, weight: r.weight, rank: r.rank, status: r.status }))),
        "text/csv",
      );
      break;
    }
    case "hds-export": {
      const t = hdsTicker(),
        x = hdsEntry(t),
        c = holderComparison(x);
      const sets = {
        institutions: () => c && holderRows(c).map((h) => ({ ticker: t, quarter: c.period, holder: h.name, cik: h.cik, city: h.city, state: h.state, shares: h.shares, prevShares: h.prevShares, change: h.change, changePct: h.changePct, value: h.value, pctOut: h.pctOut, portfolioWeight: h.weight, rankInPortfolio: h.rank, positions: h.positions, portfolioValue: h.portfolio, quartersHeld: h.quarters, since: h.since, status: h.status, votingSole: h.sole, votingShared: h.sharedVote, votingNone: h.noVote, discretion: h.discretion, filed: h.filed, accession: h.accession })),
        options: () => c?.options.map((o) => ({ ticker: t, quarter: c.period, holder: o.name, cik: o.cik, type: o.type, shares: o.shares, change: o.change, value: o.value, status: o.status })),
        history: () => x.holders && ownershipHistory(x.holders.history, x.series),
        big: () => x.bigView,
        insiders: () => x.insiderView?.log.map(({ ownerKey, ...r }) => r),
      };
      const rows = sets[hds.tab]?.();
      if (!rows?.length) throw Error("Nothing to export yet.");
      download(`${t}-${hds.tab}.csv`, csv(rows), "text/csv");
      break;
    }
    case "hds-download": {
      const q = +($("#hds-quarters")?.value || state.holdings?.quarters || 2);
      state.holdings = { ...(state.holdings || {}), quarters: q, checked: Date.now() };
      await persist();
      await holdingsUpdate(q);
      notify("Downloading SEC 13F data. You can keep using the app meanwhile.");
      await watchReference();
      render();
      break;
    }
    case "hds-insiders-more": {
      const t = hdsTicker();
      await loadInsiders(t, 40);
      render();
      break;
    }
    case "uni-refresh":
      await universeRefresh();
      await watchReference();
      render();
      break;
    case "uni-search":
      uni.q = $("#uni-q")?.value || "";
      uni.offset = 0;
      uni.data = null;
      render();
      break;
    case "uni-page":
      uni.offset = Math.max(0, uni.offset + +value);
      uni.data = null;
      render();
      break;
    case "uni-open": {
      const r = uni.data?.rows.find((x) => x.key === value);
      openTicker(value, r);
      break;
    }
    case "goto-settings":
      page = "Settings";
      render();
      break;
    case "quant-check":
      checkQuant(true).then(() => runQuant(true));
      break;
    case "quant-choose":
      quantChoose()
        .then((s) => {
          if (!s) return;
          quantEnv = s;
          notify(s.gsQuant ? `Using GS Quant ${s.gsQuant} from ${s.python}` : `GS Quant isn't installed for ${s.python}.`, !s.gsQuant);
          runQuant(true);
          render();
        })
        .catch((e) => notify(message(e), true));
      break;
    case "quant-forget":
      quantForget()
        .then((s) => {
          quantEnv = s;
          runQuant(true);
          render();
        })
        .catch((e) => notify(message(e), true));
      break;
    case "quant-run":
      runQuant(true);
      break;
    case "setup-connect":
    case "keys-save": {
      const entered = Object.fromEntries(
        ["twelve", "finnhub", "alpha", "alpaca", "alpacasecret", "fred", "ais", "sec"].map((p) => [p, $("#key-" + p)?.value.trim() || ""]),
      );
      if (act === "setup-connect" && !Object.values(entered).some(Boolean))
        throw Error("Paste at least one API key, or explore the demo data.");
      keyInfo = await saveKeys(entered);
      if (entered.finnhub) {
        // Reconnect the price stream with the new key.
        streamList = quoteError = "";
        await quotesStop().catch(() => {});
      }
      state.sources.prices = $("#price-source").value;
      for (const p of Object.keys(entered)) if (entered[p]) delete lastError[p];
      attempted.clear();
      if (act === "setup-connect") {
        state.setupDone = true;
        state.mode = "market";
        page = "Overview";
      }
      await persist();
      render();
      notify("Keys saved. Loading your data…");
      syncWatchlist();
      // The SEC contact email starts the 13F holdings download.
      if (entered.sec) autoReference().then(() => refresh());
      break;
    }
    case "key-remove":
      keyInfo = await clearKey(value);
      if (value === "alpaca") keyInfo = await clearKey("alpacasecret");
      render();
      notify(providers[value].name + " key removed.");
      break;
    case "setup-demo":
      state.setupDone = true;
      state.mode = "sample";
      page = "Overview";
      await persist();
      render();
      break;
    case "sync":
      attempted.clear();
      notify("Syncing your watchlist…");
      await syncWatchlist();
      notify(syncLabel || "Watchlist up to date.", !!syncLabel);
      break;
    case "macro-refresh": {
      const results = await Promise.allSettled(
        Object.keys(macroSeries).map((id) =>
          enqueue("fred:" + id, () => loadMacro(id)),
        ),
      );
      await persist();
      render();
      const bad = results.find((r) => r.status === "rejected");
      if (bad) notify(message(bad.reason), true);
      break;
    }
    case "buy":
    case "sell": {
      if (asset()?.currency && asset().currency !== "USD")
        throw Error(`Paper trading uses a USD account; ${asset().symbol} trades in ${asset().currency}.`);
      const date = $("#trade-date").value;
      if (!date) throw Error("Select a trade date");
      if (date > new Date().toISOString().slice(0, 10))
        throw Error("Future trade dates are not allowed.");
      if (account().trades.at(-1)?.date.slice(0, 10) > date)
        throw Error("Trades must be entered chronologically.");
      const previous = account();
      state.accounts[state.mode] = execute(previous, {
        symbol,
        side: act,
        qty: +$("#qty").value,
        price: +$("#fill").value,
        fee: +$("#fee").value,
        note: $("#trade-note").value,
        date: date + "T12:00:00Z",
        source: asset().source,
      });
      try {
        if (native) {
          const order = account().trades.at(-1);
          state.accounts[state.mode] = previous;
          await persist();
          state = await nativeTrade(state.mode, order);
        } else await persist();
      } catch (e) {
        state.accounts[state.mode] = previous;
        throw e;
      }
      render();
      notify("Paper " + act + " recorded.");
      break;
    }
    case "trades-export":
      download("aperture-trades.csv", csv(account().trades), "text/csv");
      break;
    case "positions-export":
      download(
        "aperture-positions.csv",
        csv(portfolio(account(), activeMap()).positions),
        "text/csv",
      );
      break;
    case "chart-export": {
      const svg = document.querySelector(".chart svg")?.cloneNode(true);
      if (!svg) throw Error("No chart to export");
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const style = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "style",
      );
      style.textContent =
        "text{fill:#929292;font:10px monospace}.gridline{stroke:#383838}svg{background:#1d1d1d}";
      svg.prepend(style);
      download(symbol + "-chart.svg", svg.outerHTML, "image/svg+xml");
      break;
    }
    case "prices-export":
      if (!asset()) throw Error("Select an asset first");
      download(symbol + "-prices.csv", csv(asset().bars), "text/csv");
      break;
    case "backup":
      download(
        "aperture-backup.json",
        JSON.stringify(state, null, 2),
        "application/json",
      );
      break;
    case "cash":
      if (account().trades.length)
        throw Error("Starting cash is locked after the first trade");
      if (
        !Number.isFinite(+$("#initial-cash").value) ||
        +$("#initial-cash").value <= 0
      )
        throw Error("Enter positive starting cash");
      account().initial = +$("#initial-cash").value;
      await persist();
      notify("Starting cash updated.");
      break;
    case "screen-apply":
      screen = {
        pe: +$("#max-pe").value,
        growth: +$("#min-growth").value,
        sector: $("#sector").value,
      };
      render();
      break;
    case "screen-save":
      state.screens.push({
        name: `P/E ≤ ${screen.pe}, growth ≥ ${screen.growth}% ${screen.sector}`,
        ...screen,
      });
      await persist();
      render();
      break;
    case "screen-load":
      screen = { ...state.screens[+value] };
      render();
      break;
    case "screen-export":
      download(
        "screen-results.csv",
        csv(
          filtered().map((a) => ({
            symbol: a.symbol,
            sector: a.sector,
            ...a.overview,
          })),
        ),
        "text/csv",
      );
      break;
    case "dcf": {
      const m = calcDCF();
      if (m) {
        (state.valuations ||= {})[modelKey()] = m;
        await persist();
        render();
      }
      break;
    }
    case "dcf-reset":
      delete state.valuations?.[modelKey()];
      await persist();
      render();
      break;
    case "dcf-export":
      download(
        "valuation.json",
        JSON.stringify(
          { assumptions: modelInputs(), result: dcf(modelInputs()) },
          null,
          2,
        ),
        "application/json",
      );
      break;
    case "alert-add": {
      const target = +$("#alert-target").value,
        s = $("#alert-symbol").value;
      if (!s || !Number.isFinite(target) || target <= 0)
        throw Error("Choose an asset and positive target");
      state.alerts.push({
        id: crypto.randomUUID(),
        symbol: s,
        target,
        direction: $("#alert-direction").value,
        mode: state.mode,
        triggered: false,
      });
      await persist();
      render();
      break;
    }
    case "alert-remove":
      state.alerts = state.alerts.filter((a) => a.id !== value);
      await persist();
      render();
      break;
  }
}
state.alerts = state.alerts.map(
  (a) =>
    checkAlerts(
      [a],
      a.mode === "sample" ? state.assets : state.marketAssets || {},
    )[0],
);
// Esc on a stock view goes back to the stock's panel grid.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || page !== "Stock" || !stockView) return;
  if (e.target.closest?.("input, textarea, select, .combo-list")) return;
  openStock(symbol, null);
});
render();
syncWatchlist();
autoReference().then(() => refresh());
// Daily data: re-check every 30 minutes. Cached data costs no requests.
setInterval(() => syncWatchlist(), 30 * 60 * 1000);
