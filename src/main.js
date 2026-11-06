import { maritimeView, normalizeActivity, locations } from "./maritime.js";
import land from "./world-land.js";
import {
  seedGraph,
  validateGraph,
  mergeGraph,
  relationshipsView,
} from "./relationships.js";
import {
  screenerView,
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
} from "./filings.js";
import { REVENUE_TAGS } from "./sec-tags.js";
import "./style.css";
import {
  load,
  save,
  keyStatus,
  saveKeys,
  clearKey,
  fetchData,
  fetchMaritime,
  fetchSEC,
  aisStart,
  aisStop,
  aisSnapshot,
  native,
  nativeTrade,
} from "./bridge.js";
import {
  providers,
  priceProviders,
  priceSource,
  normalizeTwelve,
  stale,
} from "./sources.js";
import { sample } from "./sample.js";
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
let state = await load(),
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
  graphCandidates = false;
state.sources ||= { prices: "twelve" };
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
const pages = [
  "Overview",
  "Research",
  "Relationships",
  "Trade",
  "Portfolio",
  "Screener",
  "Valuation",
  "Economy",
  "Alerts",
  "Commodities",
  "Settings",
];
let maritimeSelected = "chokepoint6",
  maritimeMetric = "tanker";
function commodities() {
  return (
    commodityPrices() +
    maritimeView(state.maritime || {}, maritimeSelected, maritimeMetric) +
    `<section class="panel" id="vessel-panel">${vesselPanel()}</section>`
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
    .join("")}</div><small>Spot and benchmark prices as published by FRED's sources (EIA, IMF). Daily series lag by a few days. Prices give market context; they are not linked to any vessel below.</small></section>`;
}
// ---- Live vessels (AISStream) --------------------------------------------
let vesselClass = "all",
  ais = null, // latest snapshot
  aisTimer = null;
function vesselPanel() {
  const loc = locations.find((x) => x.id === maritimeSelected) || locations[0];
  const head = `<div class="panel-head"><h2>Live vessels near ${esc(loc.name)}</h2><select id="vessel-class" aria-label="Vessel class"><option value="all" ${vesselClass === "all" ? "selected" : ""}>All vessels</option><option value="tanker" ${vesselClass === "tanker" ? "selected" : ""}>Tankers</option><option value="cargo" ${vesselClass === "cargo" ? "selected" : ""}>Cargo</option></select></div>`;
  const blocker = !native
    ? "Live vessels stream in the desktop app."
    : state.mode !== "market"
      ? "Switch to Live data for vessel positions."
      : !hasKey("ais")
        ? "Add a free AISStream key in Settings → Data sources to see vessels moving here."
        : "";
  if (blocker) return head + empty(esc(blocker));
  const all = ais?.area === loc.id ? ais.vessels : [];
  const shown = all.filter((v) => vesselClass === "all" || v.class === vesselClass);
  const status = !ais || ais.area !== loc.id
    ? "Connecting to AISStream…"
    : ais.error || { live: "Live", subscribed: "Connected; waiting for vessel reports…", connecting: "Connecting…", reconnecting: "Reconnecting…" }[ais.status] || ais.status;
  // Zoom the world map to a 2°×2° box: the land path uses x=(lon+180)*2, y=(90-lat)*2.
  const vx = (loc.lon - 1 + 180) * 2,
    vy = (90 - loc.lat - 1) * 2;
  const dots = shown
    .map((v) => `<circle cx="${(v.lon + 180) * 2}" cy="${(90 - v.lat) * 2}" r="0.045" class="vessel ${esc(v.class)}"><title>${esc(v.name)} · ${esc(v.class)} · ${v.sog == null ? "speed n/a" : fmt(v.sog, 1) + " kn"}</title></circle>`)
    .join("");
  return `${head}<p class="muted">${esc(status)}${ais?.lastMessage ? " · last report " + new Date(ais.lastMessage * 1000).toLocaleTimeString() : ""} · ${shown.length} of ${all.length} vessels shown</p><div class="grid halves"><div class="vessel-map"><svg viewBox="${vx} ${vy} 4 4" role="img" aria-label="Vessel positions near ${esc(loc.name)}"><rect x="${vx}" y="${vy}" width="4" height="4" fill="#0a0a0a"/><path d="${land}" fill="#262626" stroke="#3a3a3a" stroke-width="0.01"/>${dots}</svg></div><div>${table(
    ["Vessel", "Class", "Speed", "Status", "Destination", "Seen"],
    shown.slice(0, 60).map(
      (v) =>
        `<tr><td>${esc(v.name)}<small> · ${esc(v.mmsi)}</small></td><td>${esc(v.class)}</td><td>${v.sog == null ? "—" : fmt(v.sog, 1) + " kn"}</td><td>${esc(v.status)}</td><td>${esc(v.destination || "—")}</td><td>${new Date(v.seen * 1000).toLocaleTimeString()}</td></tr>`,
    ),
  )}</div></div><small>AIS positions within about 1° of the location, kept for 2 hours (at most 2,000 vessels). Class comes from the vessel's broadcast ship type: "tanker" describes the hull, not whether it carries petroleum, what it carries, or whether it is loaded. "Unknown" means no type report has been received yet. Positions are self-reported and can be missing or wrong.</small>`;
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
  const loc = locations.find((x) => x.id === maritimeSelected) || locations[0];
  aisStart(loc.id, loc.lat, loc.lon).catch((e) => notify(message(e), true));
  if (!aisTimer)
    aisTimer = setInterval(async () => {
      try {
        ais = await aisSnapshot();
      } catch {
        return;
      }
      const el = $("#vessel-panel");
      if (el && document.activeElement?.id !== "vessel-class") {
        el.innerHTML = vesselPanel();
        bindVessel();
      }
    }, 4000);
}
function bindVessel() {
  if ($("#vessel-class"))
    $("#vessel-class").onchange = (e) => {
      vesselClass = e.target.value;
      $("#vessel-panel").innerHTML = vesselPanel();
      bindVessel();
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
function render() {
  const a = asset();
  if (a) symbol = a.symbol;
  const views = {
    Setup: setup,
    Overview: overview,
    Research: research,
    Relationships: () =>
      relationshipsView(graph(), graphCenter, graphCandidates) + filingScan(),
    Trade: trade,
    Portfolio: portfolioPage,
    Screener: screener,
    Valuation: valuation,
    Economy: economy,
    Alerts: alerts,
    Commodities: commodities,
    Settings: settings,
  };
  const notice =
    page === "Relationships"
      ? "SOURCED RELATIONSHIPS · Dated historical disclosures. Coverage is limited; current status is unverified."
      : state.mode === "sample"
        ? "DEMO DATA · Prices and company metrics here are synthetic. Switch to Live data in the top right."
        : "LIVE DATA · Daily prices from your connected sources. Paper trades only; no broker execution.";
  document.getElementById("app").innerHTML =
    `<aside><div class="brand"><i>◈</i> MARKET LENS</div><div class="workspace-label">PERSONAL TERMINAL</div><nav>${pages.map((p, i) => `<button class="nav ${page === p ? "selected" : ""}" data-page="${p}"><span>${["◫", "⌕", "⋈", "⇄", "◉", "☷", "ƒ", "◎", "◇", "≋", "⚙"][i]}</span>${p}</button>`).join("")}</nav><div class="sidebar-bottom"><span class="dot ${live() ? "on" : ""}"></span>${native ? (live() ? "Live data" : "Demo data") : "Browser preview"}<small id="sync-status">${esc(syncText())}</small></div></aside><main><header><div class="breadcrumb">Workspace <span>/</span> ${page}</div><input id="search" placeholder="Ticker, e.g. AAPL — press Enter" aria-label="Search or add a ticker"><select id="mode" aria-label="Data workspace"><option value="market" ${state.mode === "market" ? "selected" : ""}>Live data</option><option value="sample" ${state.mode === "sample" ? "selected" : ""}>Demo data</option></select></header>${page === "Setup" ? "" : `<div class="notice">${notice}</div>`}<section class="content"><div class="title-row"><div><p class="eyebrow">MARKET INTELLIGENCE / ${page === "Setup" ? "FIRST RUN" : page === "Relationships" ? "COMPANY RELATIONSHIPS" : state.mode === "sample" ? "DEMONSTRATION" : "LIVE RESEARCH"}</p><h1>${page === "Overview" ? "Your market, in focus." : page === "Setup" ? "Connect your data" : page}</h1></div>${page === "Setup" ? "" : `<span class="tag">${assets().length} assets in workspace</span>`}</div>${views[page]()}</section><footer>Market Lens 0.2 · USD equity workspace · Daily, unadjusted prices · No investment recommendations</footer></main>`;
  bind();
  bindVessel();
  drawCharts();
  autoLoad();
  syncVesselStream();
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
        money(price(a)),
        `<span class="${tone(change(a))}">${pct(change(a))} last session</span>`,
      ),
    )
    .join(
      "",
    )}</div><div class="grid main-grid"><section class="panel"><div class="panel-head"><h2>${esc(a.symbol)} <small>${esc(a.name)}</small></h2>${button("Research →", "research")}</div>${chartTools()}${chart(a)}<div class="source-line">${badge(a)}</div></section><section class="panel"><div class="panel-head"><h2>Watchlist</h2></div><div class="watch-add"><input id="watch-input" placeholder="Add ticker" maxlength="20" aria-label="Add ticker to watchlist">${button("Add", "watch-add")}</div>${
    state.watchlist
      .map((s) => all.find((a) => a.symbol === s))
      .filter(Boolean)
      .map(
        (a) =>
          `<div class="watch-row">${ticker(a)}<div>${money(price(a))}<small class="${tone(change(a))}">${pct(change(a))}</small></div>${button("×", "watch-remove", "icon", `data-value="${esc(a.symbol)}"`)}</div>`,
      )
      .join("") || empty("Add an asset to your watchlist.")
  }</section></div><div class="grid halves"><section class="panel"><div class="panel-head"><h2>Workspace performance map</h2><small>Last session · not the full market</small></div><div class="heatmap">${all.map((a) => `<button data-symbol="${a.symbol}" class="heat ${tone(change(a))}"><b>${a.symbol}</b><span>${pct(change(a))}</span><small>${esc(a.sector || "Unclassified")}</small></button>`).join("")}</div></section><section class="panel"><div class="panel-head"><h2>Movers in your universe</h2></div>${table(
    ["Asset", "Last", "Change"],
    [...all]
      .sort((a, b) => Math.abs(change(b)) - Math.abs(change(a)))
      .slice(0, 5)
      .map(
        (a) =>
          `<tr><td>${ticker(a)}</td><td>${money(price(a))}</td><td class="${tone(change(a))}">${pct(change(a))}</td></tr>`,
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
function drawCharts() {
  document.querySelectorAll("[data-chart]").forEach((el) => {
    const a = activeMap()[el.dataset.chart];
    let bars = a.bars.slice(-range);
    if (!bars.length) return;
    const W = 1000,
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
function research() {
  const a = asset();
  if (!a) return empty("Import or download an asset in Settings.");
  const o = a.overview || {},
    r = risk(a.bars),
    data =
      state.mode === "market"
        ? state.datasets[`${symbol}:${statement}`]?.data?.[period]
        : null;
  const news =
    state.mode === "market" ? state.datasets[`${symbol}:NEWS_SENTIMENT`] : null;
  return `<section class="panel"><div class="panel-head"><h2>${esc(a.symbol)} <small>${esc(a.name)}</small></h2>${state.mode === "market" ? button("Refresh", "research-refresh") : ""}${button("Supplier / customer graph", "graph-open")}</div>${chartTools()}${chart(a)}<div class="source-line">${badge(a)}</div></section><div class="stats">${stat("P/E", fmt(number(o.PERatio)))}${stat("Profit margin", pct(number(o.ProfitMargin)))}${stat("Revenue growth YoY", pct(number(o.QuarterlyRevenueGrowthYOY)))}${stat("Market cap", compact(number(o.MarketCapitalization)))}</div><div class="grid halves"><section class="panel"><div class="panel-head"><h2>Company profile</h2></div><p>${esc(o.Description || waiting("OVERVIEW", "the company profile"))}</p><div class="metrics"><span>Sector</span><b>${esc(a.sector || "—")}</b><span>Dividend yield</span><b>${pct(number(o.DividendYield))}</b><span>52-week high / low</span><b>${fmt(number(o["52WeekHigh"]))} / ${fmt(number(o["52WeekLow"]))}</b><span>RSI (14, simple)</span><b>${fmt(rsi(a.bars))}</b><span>Annualized volatility</span><b>${pct(r?.vol)}</b><span>Max drawdown in data</span><b>${pct(r?.drawdown)}</b></div>${link("https://www.sec.gov/edgar/search/", "SEC filings search")}<p><small>Search company name or ticker on EDGAR. Metrics retain provider definitions and reported currencies.</small></p></section><section class="panel"><div class="panel-head"><h2>Research journal</h2></div><textarea id="note" rows="8" placeholder="Thesis, catalysts, valuation assumptions, and what would change your mind…">${esc(state.notes[`${state.mode}:${symbol}`] || "")}</textarea>${button("Save thesis", "note-save", "primary")}</section></div><section class="panel"><div class="panel-head"><h2>Financial statements</h2><select id="statement">${["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"].map((s) => `<option ${s === statement ? "selected" : ""}>${s}</option>`).join("")}</select><select id="period"><option value="annualReports" ${period === "annualReports" ? "selected" : ""}>Annual</option><option value="quarterlyReports" ${period === "quarterlyReports" ? "selected" : ""}>Quarterly</option></select></div>${
    data?.length
      ? table(
          ["Metric", ...data.slice(0, 4).map((r) => esc(r.fiscalDateEnding))],
          Object.keys(data[0])
            .filter(
              (k) => !["fiscalDateEnding", "reportedCurrency"].includes(k),
            )
            .map(
              (k) =>
                `<tr><td>${esc(k)}</td>${data
                  .slice(0, 4)
                  .map(
                    (r) =>
                      `<td>${number(r[k]) == null ? "—" : compact(+r[k])}</td>`,
                  )
                  .join("")}</tr>`,
            ),
        )
      : empty(esc(waiting(statement, "financial statements")))
  }<small>Reported currency: ${esc(data?.[0]?.reportedCurrency || "—")}. Raw provider figures; “None” is missing, not zero.</small></section><div class="grid halves"><section class="panel"><div class="panel-head"><h2>Company news</h2></div>${
    news?.data.feed
      ?.slice(0, 10)
      .map((n) => {
        const url = safeURL(n.url);
        return `<article>${url ? link(url, n.title) : esc(n.title)}<small>${esc(n.source)} · ${esc(n.time_published)}</small><p>${esc(n.summary)}</p></article>`;
      })
      .join("") ||
    empty(esc(waiting("NEWS_SENTIMENT", "company news")))
  } ${datasetStamp(news)}</section><section class="panel"><div class="panel-head"><h2>Earnings calendar</h2>${state.mode === "market" ? button("Load calendar", "calendar-fetch") : ""}</div>${calendar()}<small>Calendar availability depends on provider access. Dividend dates are available in the company overview: ${esc(o.DividendDate || "—")}.</small></section></div>${secPanel()}`;
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
  const why =
    state.mode === "sample"
      ? "Switch to Live data for SEC filings."
      : !native
        ? "SEC filings load in the desktop app."
        : !cikFor(symbol) && !hasKey("sec")
          ? "Add your SEC contact email in Settings → Data sources (or an Alpha Vantage key) so the app can find this company on EDGAR."
          : loadErrors["sec:" + symbol] || "Loading filings from SEC EDGAR…";
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
        : "";
  const list = (items) =>
    items?.length
      ? items.map((c) => `${esc(c.name)} <small>(${esc(c.role)})</small>`).join(", ")
      : "None";
  return `<section class="panel"><div class="panel-head"><h2>Find suppliers & customers in SEC filings</h2>${blocker ? "" : button("Scan " + esc(n.name) + "'s annual reports", "sec-scan", "primary")}</div><p>Reads the two most recent annual reports (10-K or 20-F) on EDGAR, matches company names against SEC's company list, and adds sentences that name a supplier or customer as <b>unreviewed candidates</b>. Revenue shares are kept only when the same sentence discloses them. A candidate is not a relationship until you read the source and mark it reviewed.</p>${blocker ? `<p><b>${esc(blocker)}</b></p>` : ""}${
    scan
      ? `<div class="metrics"><span>Latest report</span><b>${esc(scan.current.form)} filed ${esc(scan.current.filed)} · ${scan.current.count} mention${scan.current.count === 1 ? "" : "s"}</b><span>Prior report</span><b>${scan.prior ? `${esc(scan.prior.form)} filed ${esc(scan.prior.filed)} · ${scan.prior.count} mention${scan.prior.count === 1 ? "" : "s"}` : "None found"}</b><span>New since prior report</span><b>${scan.prior ? list(scan.added) : "—"}</b><span>No longer mentioned</span><b>${scan.prior ? list(scan.dropped) : "—"}</b></div><small>Scanned ${esc(scan.at)}. Mentions are matched names in sentences with supplier or customer wording; absence from a filing does not mean a relationship ended.</small>`
      : ""
  }</section>`;
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
function screener() {
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
function valuation() {
  return `<div class="grid halves"><section class="panel"><div class="panel-head"><h2>Discounted cash flow</h2><span class="tag">USER ASSUMPTIONS</span></div><p>Unlevered free cash flow model. All amounts in the same currency, in millions; shares in millions. Inputs are illustrative until you replace them.</p><div class="form-grid">${[
    ["fcf", "Base free cash flow", 1000],
    ["growth", "Annual growth (%)", 8],
    ["discount", "Discount rate (%)", 10],
    ["terminal", "Terminal growth (%)", 2.5],
    ["netDebt", "Net debt", 2000],
    ["shares", "Diluted shares", 500],
  ]
    .map(
      ([id, label, val]) =>
        `<label>${label}<input id="${id}" type="number" step="any" value="${val}"></label>`,
    )
    .join(
      "",
    )}</div>${button("Calculate scenarios", "dcf", "primary")}${button("Export model", "dcf-export")}<small>Five explicit forecast years; Gordon-growth terminal value. Negative enterprise/equity values are shown, not clipped.</small></section><section class="panel"><div class="panel-head"><h2>Valuation range</h2></div><div id="dcf-results"></div></section></div><section class="panel"><div class="panel-head"><h2>Sensitivity · value per share</h2><small>Discount rate × terminal growth</small></div><div id="sensitivity"></div></section>`;
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
      base = dcf(m);
    $("#dcf-results").innerHTML =
      ["Bear", "Base", "Bull"]
        .map((name, i) => {
          const result = dcf({
            ...m,
            growth: m.growth + (i - 1) * 0.03,
            discount: m.discount - (i - 1) * 0.01,
          });
          return `<div class="scenario"><span>${name}</span><strong>${fmt(result.perShare)}</strong><small>Growth ${pct(m.growth + (i - 1) * 0.03)} · discount ${pct(m.discount - (i - 1) * 0.01)}</small></div>`;
        })
        .join("") +
      `<p>Enterprise value: ${compact(base.enterprise)} million</p><p>Terminal value: ${pct(base.terminalShare)} of enterprise value</p>`;
    const gs = [-0.01, 0, 0.01].map((x) => m.terminal + x);
    $("#sensitivity").innerHTML = table(
      ["Discount / terminal", ...gs.map(pct)],
      [-0.02, -0.01, 0, 0.01, 0.02].map((x) => {
        let rate = m.discount + x;
        return `<tr><td>${pct(rate)}</td>${gs.map((g) => `<td>${rate > g ? fmt(dcf({ ...m, discount: rate, terminal: g }).perShare) : "Invalid"}</td>`).join("")}</tr>`;
      }),
    );
  } catch (e) {
    $("#dcf-results").textContent = e.message;
    $("#sensitivity").textContent = "";
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
  return `<svg class="spark" viewBox="0 0 400 90"><polyline fill="none" stroke="#e5e5e5" stroke-width="2" points="${values.map((v, i) => `${(i / (values.length - 1)) * 400},${80 - ((v - min) / (max - min || 1)) * 70}`).join(" ")}"/></svg>`;
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
  return `<div class="source-row"><div class="source-info"><h3>${info.name} ${setupMode ? "" : status}</h3><small>${info.provides}<br>${info.limits}</small>${!setupMode && lastError[p] ? `<small class="down">Last error: ${esc(lastError[p])}</small>` : ""}</div><div class="source-key"><input id="key-${p}" type="${info.email ? "email" : "password"}" autocomplete="off" spellcheck="false" placeholder="${info.email ? (k?.configured ? "Replace contact email" : "you@example.com (optional)") : k?.configured ? "Replace saved key" : "Paste API key"}" aria-label="${info.name} ${info.email ? "contact email" : "API key"}">${!setupMode && k?.source === "saved" ? button("Remove", "key-remove", "icon", `data-value="${p}"`) : ""}${link(info.keyURL, info.label || "Get a free key")}</div></div>`;
}
function priceSelect() {
  return `<label>Prices from<select id="price-source">${priceProviders.map((p) => `<option value="${p}" ${state.sources.prices === p ? "selected" : ""}>${providers[p].name}${hasKey(p) ? "" : " (no key)"}</option>`).join("")}</select></label>`;
}
function setup() {
  return `<section class="panel setup"><p>Paste your free API keys once. They are saved on this computer, in a file only your user account can read, and the app loads data on its own from then on. One key is enough to start; all three gives you everything.</p>${["twelve", "alpha", "fred", "ais", "sec"].map((p) => keyRow(p, true)).join("")}${priceSelect()}<div class="setup-actions">${button("Connect and load data", "setup-connect", "primary")}${button("Explore demo data instead", "setup-demo")}</div><small>Shipping activity (IMF PortWatch) needs no key. Recommended: Twelve Data for prices, Alpha Vantage for company research, FRED for the economy.</small></section>`;
}
function settings() {
  if (!native)
    return `<section class="panel"><div class="panel-head"><h2>Data sources</h2></div>${empty("Live data connects in the desktop app (npm run tauri dev or the installed app). This browser preview only has demo data.")}</section>${workspacePanel()}`;
  return `<section class="panel"><div class="panel-head"><h2>Data sources</h2>${button("Save keys", "keys-save", "primary")}${button("Sync now", "sync")}</div>${["twelve", "alpha", "fred", "ais", "sec"].map((p) => keyRow(p, false)).join("")}<div class="source-row"><div class="source-info"><h3>IMF PortWatch <span class="pill on">No key needed</span></h3><small>Daily port calls and chokepoint transits</small></div></div>${priceSelect()}<small>Keys are saved in credentials.json in your app-data folder (owner-only permissions), never in backups or the workspace. Environment variables ALPHA_VANTAGE_API_KEY, TWELVE_DATA_API_KEY, FRED_API_KEY, AISSTREAM_API_KEY and SEC_CONTACT_EMAIL override saved values. Requests stay inside each free plan: saved data is reused for 1 hour (Twelve Data), 6 hours (Alpha Vantage) or 12 hours (FRED).</small></section>${workspacePanel()}<section class="panel"><div class="panel-head"><h2>Source policy & coverage</h2></div><p>Data comes only from your own provider accounts and public sources. No scraping, paywall bypass, shared credentials or quota evasion. Free access is not a redistribution license.</p><p>Coverage: USD stock/ETF daily prices, company fundamentals, news, earnings calendar, FRED macro series and PortWatch shipping activity. Not included: tick data, options chains, corporate-action processing, live brokerage execution or tax accounting.</p>${link("https://twelvedata.com/terms", "Twelve Data terms")} · ${link("https://www.alphavantage.co/terms_of_service/", "Alpha Vantage terms")} · ${link("https://fred.stlouisfed.org/docs/api/terms_of_use.html", "FRED terms")}</section>`;
}
function workspacePanel() {
  return `<section class="panel"><div class="panel-head"><h2>Workspace</h2>${button("Export full backup", "backup")}${button("Export selected prices", "prices-export")}</div><label>Paper account starting cash<input id="initial-cash" type="number" min="1" value="${account().initial}" ${account().trades.length ? "disabled" : ""}></label>${button("Set starting cash", "cash")}<small>Starting cash is editable only before the first trade. Native data lives in market-lens.sqlite in your OS app-data folder.</small><details class="advanced"><summary>Advanced</summary><label>Restore a backup file (replaces the workspace)<input id="restore" type="file" accept=".json"></label></details></section>`;
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
  try {
    const d =
      p === "twelve"
        ? await fetchData("twelve", "TIME_SERIES", s)
        : await fetchData("alpha", "TIME_SERIES_DAILY", s);
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
      source: providers[p].name + " · daily" + (d.stale ? " · STALE" : ""),
      fetchedAt: d.fetchedAt,
    };
    delete loadErrors["prices:" + s];
    if (d.warning) lastError[p] = d.warning;
    return d;
  } catch (e) {
    loadErrors["prices:" + s] = message(e);
    lastError[p] = `${s}: ${message(e)}`;
    throw e;
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
async function loadMaritime(id) {
  const d = await fetchMaritime(id);
  normalizeActivity(d.data, id);
  (state.maritime ||= {})[id] = d;
  if (d.warning) notify(d.warning, true);
}
// Pull whatever the current page needs and doesn't have yet.
function autoLoad() {
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
    }).catch((e) => {
      if (key.startsWith("pw:")) notify(message(e), true);
    });
  };
  const a = asset();
  if (page === "Research" && a && hasKey("alpha")) {
    const s = a.symbol;
    if (!a.overview) once(`${s}:OVERVIEW`, () => loadDataset("OVERVIEW", s));
    if (!state.datasets[`${s}:${statement}`])
      once(`${s}:${statement}`, () => loadDataset(statement, s));
    if (!state.datasets[`${s}:NEWS_SENTIMENT`])
      once(`${s}:NEWS_SENTIMENT`, () => loadDataset("NEWS_SENTIMENT", s));
  }
  if (page === "Research" && a && (cikFor(a.symbol) || hasKey("sec")) && stale(state.secData?.[a.symbol], 86400)) {
    const s = a.symbol;
    once("sec:" + s, () => loadSEC(s));
  }
  if (page === "Economy" && hasKey("fred"))
    for (const id of Object.keys(macroSeries))
      if (stale(state.macro[id], 43200)) once("fred:" + id, () => loadMacro(id));
  if (page === "Commodities" && hasKey("fred"))
    for (const id of Object.keys(commoditySeries))
      if (stale(state.macro[id], 43200)) once("fred:" + id, () => loadMacro(id));
  if (page === "Commodities" && stale(state.maritime?.[maritimeSelected], 21600)) {
    const id = maritimeSelected;
    once("pw:" + id, () => loadMaritime(id));
  }
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
async function addTicker(s, openResearch) {
  s = s.trim().toUpperCase();
  if (!/^[A-Z0-9.^_-]{1,20}$/.test(s)) throw Error("Enter a ticker like AAPL.");
  if (state.mode === "sample" && !activeMap()[s])
    throw Error("Demo data only has its sample tickers. Switch to Live data to add " + s + ".");
  if (live() && !activeMap()[s]) {
    setSync(`Loading ${s}…`);
    try {
      await enqueue("prices:" + s, () => loadPrices(s));
    } finally {
      setSync("");
    }
  }
  if (!state.watchlist.includes(s)) state.watchlist.push(s);
  symbol = s;
  if (openResearch) page = "Research";
  await persist();
  render();
}
function bind() {
  const recenter = (id) => {
    graphCenter = id;
    render();
  };
  document.querySelectorAll("[data-entity]").forEach((el) => {
    el.onclick = () => recenter(el.dataset.entity);
    el.onkeydown = (event) => {
      if (["Enter", " "].includes(event.key)) {
        event.preventDefault();
        recenter(el.dataset.entity);
      }
    };
  });
  if ($("#graph-center"))
    $("#graph-center").onchange = (event) => recenter(event.target.value);
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
  if ($("#maritime-location"))
    $("#maritime-location").onchange = (e) => {
      maritimeSelected = e.target.value;
      render();
    };
  if ($("#maritime-metric"))
    $("#maritime-metric").onchange = (e) => {
      maritimeMetric = e.target.value;
      render();
    };
  document.querySelectorAll("[data-location]").forEach((el) => {
    el.onclick = () => {
      maritimeSelected = el.dataset.location;
      render();
    };
    el.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        el.onclick();
      }
    };
  });

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
        page = el.dataset.page;
        render();
      }),
  );
  document.querySelectorAll("[data-symbol]").forEach(
    (el) =>
      (el.onclick = () => {
        symbol = el.dataset.symbol;
        if (!["Overview", "Research", "Trade"].includes(page))
          page = "Research";
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
  $("#search").onkeydown = (e) => {
    if (e.key === "Enter") {
      const q = e.target.value.toUpperCase(),
        a =
          assets().find((a) => a.symbol === q) ||
          assets().find((a) => a.name.toUpperCase().includes(q));
      if (a) {
        symbol = a.symbol;
        page = "Research";
        render();
      } else if (live())
        addTicker(q, true).catch((err) => notify(message(err), true));
      else notify("No match in demo data. Switch to Live data to look up " + q + ".", true);
    }
  };
  if ($("#asset-select"))
    $("#asset-select").onchange = (e) => {
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
  if (page === "Valuation") calcDCF();
  if ($("#restore"))
    $("#restore").onchange = async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 20e6) throw Error("Backup limit is 20 MB");
        const restored = validateWorkspace(JSON.parse(await file.text()));
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
    case "graph-open": {
      const a = asset();
      let entity = graph().nodes.find((n) => n.ticker === a?.symbol);
      if (!entity && a && state.mode === "market") {
        // Start an entity for this ticker so its filings can be scanned.
        entity = { id: "t-" + a.symbol.toLowerCase().replace(/[^a-z0-9]/g, "-"), name: a.overview?.Name || state.secData?.[a.symbol]?.name || a.symbol, ticker: a.symbol };
        if (cikFor(a.symbol)) entity.cik = cikFor(a.symbol);
        graph().nodes.push(entity);
        await persist();
      }
      if (!entity) {
        notify("No relationship coverage for this ticker in demo data.", true);
        break;
      }
      graphCenter = entity.id;
      page = "Relationships";
      render();
      break;
    }
    case "sec-scan": {
      const n = graph().nodes.find((x) => x.id === graphCenter) || graph().nodes[0];
      if (!hasKey("sec")) throw Error("Add your SEC contact email in Settings → Data sources first.");
      const cik = n.cik ? padCIK(n.cik) : await resolveCIK(n.ticker);
      notify("Reading " + n.name + "'s annual reports on EDGAR…");
      const sub = (await fetchSEC("submissions", cik)).data;
      const reports = annualReports(sub, 2);
      if (!reports.length) throw Error(n.name + " has no 10-K or 20-F on EDGAR.");
      const directory = buildDirectory((await fetchSEC("tickers")).data, graph());
      const filer = { cik, name: n.name, ticker: n.ticker, nodeId: n.id };
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
      graphCandidates = true;
      await persist();
      render();
      notify(`Found ${results[0].found.length} candidate mention(s) in the latest report; ${added} new to the graph. Review each source before relying on it.`);
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
    case "maritime-fetch":
      notify("Loading PortWatch observations…");
      await enqueue("pw:" + maritimeSelected, () => loadMaritime(maritimeSelected));
      await persist();
      render();
      notify("PortWatch observations updated.");
      break;
    case "maritime-export": {
      const d = state.maritime?.[maritimeSelected];
      if (!d) throw Error("Download a location first");
      download(
        "portwatch-" + maritimeSelected + ".csv",
        csv(
          normalizeActivity(d.data, maritimeSelected).map((r) => ({
            ...r,
            provider: "IMF PortWatch",
            retrieved: new Date(d.fetchedAt * 1000).toISOString(),
          })),
        ),
        "text/csv",
      );
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
      page = "Research";
      render();
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
      if (hasKey("alpha"))
        for (const kind of ["OVERVIEW", statement, "NEWS_SENTIMENT"])
          jobs.push(enqueue(`${s}:${kind}`, () => loadDataset(kind, s)));
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
    case "goto-settings":
      page = "Settings";
      render();
      break;
    case "setup-connect":
    case "keys-save": {
      const entered = Object.fromEntries(
        ["twelve", "alpha", "fred", "ais", "sec"].map((p) => [p, $("#key-" + p).value.trim()]),
      );
      if (act === "setup-connect" && !Object.values(entered).some(Boolean))
        throw Error("Paste at least one API key, or explore the demo data.");
      keyInfo = await saveKeys(entered);
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
      break;
    }
    case "key-remove":
      keyInfo = await clearKey(value);
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
      download("market-lens-trades.csv", csv(account().trades), "text/csv");
      break;
    case "positions-export":
      download(
        "market-lens-positions.csv",
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
        "market-lens-backup.json",
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
    case "dcf":
      calcDCF();
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
render();
syncWatchlist();
// Daily data: re-check every 30 minutes. Cached data costs no requests.
setInterval(() => syncWatchlist(), 30 * 60 * 1000);
