import { maritimeView, normalizeActivity } from "./maritime.js";
import {
  screenerView,
  screenRows,
  defaults as screenDefaults,
} from "./screener.js";
import "./style.css";
import { load, save, keys, fetchData, native, nativeTrade } from "./bridge.js";
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
  symbol = "AAPL",
  range = 90,
  candles = true,
  compare = "",
  busy = false,
  screen = { pe: 100, growth: -100, sector: "" },
  statement = "INCOME_STATEMENT",
  period = "annualReports";
const pages = [
  "Overview",
  "Research",
  "Trade",
  "Portfolio",
  "Screener",
  "Valuation",
  "Economy",
  "Alerts",
  "Settings",
  "Commodities",
];
let maritimeSelected = "chokepoint6",
  maritimeMetric = "tanker";
function commodities() {
  return maritimeView(state.maritime || {}, maritimeSelected, maritimeMetric);
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
  document.getElementById("app").innerHTML =
    `<aside><div class="brand"><i>◈</i> MARKET LENS</div><div class="workspace-label">PERSONAL TERMINAL</div><nav>${pages.map((p, i) => `<button class="nav ${page === p ? "selected" : ""}" data-page="${p}"><span>${["◫", "⌕", "⇄", "◉", "☷", "ƒ", "◎", "◇", "⚙", "◌"][i]}</span>${p}</button>`).join("")}</nav><div class="sidebar-bottom"><span class="dot"></span>${native ? "Native · SQLite" : "Browser preview"}<small>Local-first research workspace</small></div></aside><main><header><div class="breadcrumb">Workspace <span>/</span> ${page}</div><input id="search" placeholder="Search ticker or company…" aria-label="Search assets"><select id="mode" aria-label="Data workspace"><option value="sample" ${state.mode === "sample" ? "selected" : ""}>Sample workspace</option><option value="market" ${state.mode === "market" ? "selected" : ""}>My market data</option></select></header><div class="notice">${page === "Commodities" ? "MARITIME DATA · Downloaded PortWatch aggregates; observation dates and retrieval times are shown separately." : state.mode === "sample" ? "SAMPLE DATA · All prices and company metrics here are synthetic. Trades use a separate demo account." : "DAILY DATA · No real-time quotes or broker execution. Paper trades use your selected historical or manual price."}</div><section class="content"><div class="title-row"><div><p class="eyebrow">MARKET INTELLIGENCE / ${state.mode === "sample" ? "DEMONSTRATION" : "PERSONAL RESEARCH"}</p><h1>${page === "Overview" ? "Your market, in focus." : page}</h1></div><span class="tag">${assets().length} assets in workspace</span></div>${{ Overview: overview, Research: research, Trade: trade, Portfolio: portfolioPage, Screener: screener, Valuation: valuation, Economy: economy, Alerts: alerts, Settings: settings, Commodities: commodities }[page]()}</section><footer>Market Lens 0.1 · USD equity workspace · Prices are unadjusted unless your CSV supplies adjusted OHLC · No investment recommendations</footer></main>`;
  bind();
  drawCharts();
}
function overview() {
  const all = assets();
  if (!all.length)
    return empty(
      "Your market workspace is empty. Open Settings to import OHLCV CSV data, or download a symbol with your API key.",
    );
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
    )}</div><div class="grid main-grid"><section class="panel"><div class="panel-head"><h2>${esc(a.symbol)} <small>${esc(a.name)}</small></h2>${button("Research →", "research")}</div>${chartTools()}${chart(a)}<div class="source-line">${badge(a)}</div></section><section class="panel"><div class="panel-head"><h2>Watchlist</h2>${button("+ Add", "watch-add")}</div>${
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
          `<rect x="${x(i) - (iw / bars.length) * 0.32}" y="${H - bottom - (b.volume / volMax) * 45}" width="${(iw / bars.length) * 0.64}" height="${(b.volume / volMax) * 45}" fill="${b.close >= b.open ? "#44cba4" : "#ed7a80"}" opacity=".12"/>`,
      )
      .join("");
    if (candles)
      out += bars
        .map((b, i) => {
          const color = b.close >= b.open ? "#44cba4" : "#ed7a80";
          return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${color}"/><rect x="${x(i) - Math.max(1, (iw / bars.length) * 0.3)}" y="${y(Math.max(b.close, b.open))}" width="${Math.max(1, (iw / bars.length) * 0.6)}" height="${Math.max(1, Math.abs(y(b.open) - y(b.close)))}" fill="${color}"/>`;
        })
        .join("");
    else
      out += `<polyline clip-path="url(#plot-area)" fill="none" stroke="#44cba4" stroke-width="2" points="${bars.map((b, i) => `${x(i)},${y(b.close)}`).join(" ")}"/>`;
    for (const [n, c] of [
      [20, "#c9a75d"],
      [50, "#869bea"],
    ]) {
      const ma = sma(a.bars, n).slice(-bars.length);
      out += `<polyline clip-path="url(#plot-area)" fill="none" stroke="${c}" stroke-width="1.5" points="${ma
        .map((v, i) => (v === null ? "" : `${x(i)},${y(v)}`))
        .filter(Boolean)
        .join(" ")}"/>`;
    }
    if (compare && first)
      out += `<polyline clip-path="url(#plot-area)" fill="none" stroke="#da8cd4" stroke-width="2" points="${bars
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
        out += `<circle cx="${x(i)}" cy="${y(t.price)}" r="6" fill="${t.side === "buy" ? "#fff" : "#ed7a80"}"><title>${esc(t.side)} ${t.qty} @ ${t.price}</title></circle>`;
    }
    for (const i of [0, Math.floor(bars.length / 2), bars.length - 1])
      out += `<text x="${x(i)}" y="${H - 10}" text-anchor="middle">${bars[i].date}</text>`;
    el.innerHTML = `<div class="chart-readout">${esc(a.symbol)} · ${bars.at(-1).date} · ${money(bars.at(-1).close)}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${a.symbol} daily price chart"><defs><clipPath id="plot-area"><rect x="${left}" y="${top}" width="${iw}" height="${ih}"/></clipPath></defs>${out}<line id="crosshair" y1="${top}" y2="${H - bottom}" stroke="#829093" stroke-dasharray="4" visibility="hidden"/></svg>`;
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
  return `<section class="panel"><div class="panel-head"><h2>${esc(a.symbol)} <small>${esc(a.name)}</small></h2>${button("Download prices", "prices")}${button("Company overview", "overview-fetch")}</div>${chartTools()}${chart(a)}<div class="source-line">${badge(a)}</div></section><div class="stats">${stat("P/E", fmt(number(o.PERatio)))}${stat("Profit margin", pct(number(o.ProfitMargin)))}${stat("Revenue growth YoY", pct(number(o.QuarterlyRevenueGrowthYOY)))}${stat("Market cap", compact(number(o.MarketCapitalization)))}</div><div class="grid halves"><section class="panel"><div class="panel-head"><h2>Company profile</h2></div><p>${esc(o.Description || "Download the company overview for a sourced business description.")}</p><div class="metrics"><span>Sector</span><b>${esc(a.sector || "—")}</b><span>Dividend yield</span><b>${pct(number(o.DividendYield))}</b><span>52-week high / low</span><b>${fmt(number(o["52WeekHigh"]))} / ${fmt(number(o["52WeekLow"]))}</b><span>RSI (14, simple)</span><b>${fmt(rsi(a.bars))}</b><span>Annualized volatility</span><b>${pct(r?.vol)}</b><span>Max drawdown in data</span><b>${pct(r?.drawdown)}</b></div>${link("https://www.sec.gov/edgar/search/", "SEC filings search")}<p><small>Search company name or ticker on EDGAR. Metrics retain provider definitions and reported currencies.</small></p></section><section class="panel"><div class="panel-head"><h2>Research journal</h2></div><textarea id="note" rows="8" placeholder="Thesis, catalysts, valuation assumptions, and what would change your mind…">${esc(state.notes[`${state.mode}:${symbol}`] || "")}</textarea>${button("Save thesis", "note-save", "primary")}</section></div><section class="panel"><div class="panel-head"><h2>Financial statements</h2><select id="statement">${["INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"].map((s) => `<option ${s === statement ? "selected" : ""}>${s}</option>`).join("")}</select><select id="period"><option value="annualReports" ${period === "annualReports" ? "selected" : ""}>Annual</option><option value="quarterlyReports" ${period === "quarterlyReports" ? "selected" : ""}>Quarterly</option></select>${button("Download statement", "statement-fetch")}</div>${
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
      : empty(
          "No downloaded statements. Each statement download uses one API request.",
        )
  }<small>Reported currency: ${esc(data?.[0]?.reportedCurrency || "—")}. Raw provider figures; “None” is missing, not zero.</small></section><div class="grid halves"><section class="panel"><div class="panel-head"><h2>Company news</h2>${button("Download news", "news-fetch")}</div>${
    news?.data.feed
      ?.slice(0, 10)
      .map((n) => {
        const url = safeURL(n.url);
        return `<article>${url ? link(url, n.title) : esc(n.title)}<small>${esc(n.source)} · ${esc(n.time_published)}</small><p>${esc(n.summary)}</p></article>`;
      })
      .join("") ||
    empty("Connect your API key and download news. No fabricated headlines.")
  } ${datasetStamp(news)}</section><section class="panel"><div class="panel-head"><h2>Earnings calendar</h2>${button("Download calendar", "calendar-fetch")}</div>${calendar()}<small>Calendar availability depends on provider access. Dividend dates are available in the company overview: ${esc(o.DividendDate || "—")}.</small></section></div>`;
}
function datasetStamp(d) {
  return d
    ? `<small>Alpha Vantage · downloaded ${new Date(d.fetchedAt * 1000).toLocaleString()}${d.stale ? " · STALE CACHE" : ""}</small>`
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
  return `<section class="panel"><div class="panel-head"><h2>Economic observatory</h2><select id="macro-series">${Object.entries(
    macroSeries,
  )
    .map(([k, v]) => `<option value="${k}">${k} — ${v}</option>`)
    .join(
      "",
    )}</select>${button("Download series", "macro-fetch", "primary")}</div><p>FRED observations through your free API key. Values retain the original units; GDP is quarterly, CPI and unemployment monthly, Treasury yields daily.</p><div class="macro-grid">${
    Object.entries(state.macro)
      .map(([s, d]) => {
        const rows = d.data.observations
          .filter((x) => number(x.value) != null)
          .slice()
          .reverse();
        const latest = rows.at(-1);
        return `<section class="macro-card"><h3>${esc(macroSeries[s] || s)}</h3><strong>${fmt(number(latest?.value))}</strong><small>${esc(latest?.date)} · ${esc(s)}</small>${spark(rows.map((x) => +x.value))}${link("https://fred.stlouisfed.org/series/" + encodeURIComponent(s), "View series and source")}${datasetStamp({ ...d, provider: "fred" }).replace("Alpha Vantage", "FRED")}</section>`;
      })
      .join("") || empty("No downloaded economic series yet.")
  }</div></section>`;
}
function spark(values) {
  if (values.length < 2) return "";
  let min = Math.min(...values),
    max = Math.max(...values);
  return `<svg class="spark" viewBox="0 0 400 90"><polyline fill="none" stroke="#44cba4" stroke-width="2" points="${values.map((v, i) => `${(i / (values.length - 1)) * 400},${80 - ((v - min) / (max - min || 1)) * 70}`).join(" ")}"/></svg>`;
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
function settings() {
  return `<div class="grid halves"><section class="panel"><div class="panel-head"><h2>Data connections</h2><span class="tag">SESSION-ONLY KEYS</span></div><label>Alpha Vantage API key<input id="alpha-key" type="password" autocomplete="off" placeholder="Your free key"></label><label>FRED API key<input id="fred-key" type="password" autocomplete="off" placeholder="Your free key"></label>${button("Connect for this session", "connect", "primary")}<p>Keys stay in Rust memory and are excluded from backups. You can also set ALPHA_VANTAGE_API_KEY and FRED_API_KEY before launching.</p>${link("https://www.alphavantage.co/support/#api-key", "Get Alpha Vantage key")} · ${link("https://fred.stlouisfed.org/docs/api/api_key.html", "Get FRED key")}<p>Requests are user initiated. Alpha budget: 25 per rolling 24 hours, ≥13 seconds apart; cache lifetime 6 hours. Your provider may impose additional limits or plan restrictions.</p></section><section class="panel"><div class="panel-head"><h2>Add market data</h2></div><label>Symbol<input id="import-symbol" placeholder="AAPL" maxlength="20"></label><label>Source / attribution<input id="import-source" placeholder="Provider name / exported from…"></label>${button("Download daily prices", "download-symbol", "primary")}<label class="file-label">Import OHLCV CSV<input id="csv-import" type="file" accept=".csv,text/csv"></label><p>Required columns: date, open, high, low, close. Optional: volume. Dates YYYY-MM-DD, USD prices. Use files you are permitted to access. Imports switch to My market data.</p>${button("Download CSV template", "template")}</section></div><section class="panel"><div class="panel-head"><h2>Workspace & portability</h2></div>${button("Export full backup", "backup")}${button("Export selected prices", "prices-export")}<label class="file-label">Restore backup<input id="restore" type="file" accept=".json"></label><p>Restore replaces local research, accounts, and settings after confirmation. Backups exclude API keys and the raw Rust response cache. Native data is stored in your OS application-data folder in market-lens.sqlite.</p><label>Paper account starting cash<input id="initial-cash" type="number" min="1" value="${account().initial}" ${account().trades.length ? "disabled" : ""}></label>${button("Set starting cash", "cash")}<small>Starting cash is editable only before the first trade.</small></section><section class="panel"><div class="panel-head"><h2>Source policy & coverage</h2></div><p>No scraping of gated pages, paywall bypass, credential sharing, proxy rotation, or quota evasion. Download only data available to your own provider account. Free access is not a redistribution license. Review provider and underlying exchange terms before sharing data or distributing a commercial version.</p><p>Initial coverage: USD stock / ETF daily OHLCV, company fundamentals, news, earnings calendar, FRED macro series, and user-owned CSV imports. Not included: tick data, options chains, corporate-action processing, live brokerage execution, tax accounting, or guaranteed free access to every endpoint.</p>${link("https://www.alphavantage.co/terms_of_service/", "Alpha Vantage terms")} · ${link("https://fred.stlouisfed.org/docs/api/terms_of_use.html", "FRED terms")}</section>`;
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
async function getData(kind, s = symbol) {
  if (state.mode === "sample")
    throw Error("Switch to My market data before downloading real datasets.");
  notify("Downloading " + kind + "…");
  const d = await fetchData("alpha", kind, s);
  if (kind === "TIME_SERIES_DAILY") {
    const bars = normalizeAlpha(d.data);
    const previous = activeMap()[s]?.origin !== "sample" ? activeMap()[s] : {};
    activeMap()[s] = {
      ...previous,
      symbol: s,
      name: previous?.name || s,
      bars,
      origin: "alpha",
      source: "Alpha Vantage · daily unadjusted" + (d.stale ? " · STALE" : ""),
      fetchedAt: d.fetchedAt,
    };
    symbol = s;
  } else {
    state.datasets[`${s}:${kind}`] = d;
    if (kind === "OVERVIEW") {
      if (!d.data.Symbol) throw Error("No company overview returned.");
      activeMap()[s] = {
        ...activeMap()[s],
        name: d.data.Name,
        sector: d.data.Sector,
        overview: d.data,
      };
    }
  }
  await persist();
  notify(d.warning || "Saved dataset locally.");
  render();
}
function bind() {
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
    await persist();
    render();
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
      } else notify("No local match. Add the symbol in Settings.", true);
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
  if ($("#csv-import"))
    $("#csv-import").onchange = async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 10e6) throw Error("CSV limit is 10 MB");
        const s = $("#import-symbol").value.trim().toUpperCase();
        if (!/^[A-Z0-9.^_-]{1,20}$/.test(s))
          throw Error("Enter a valid symbol first.");
        const bars = validateBars(parseCSV(await file.text()));
        state.mode = "market";
        activeMap()[s] = {
          symbol: s,
          name: s,
          bars,
          origin: "import",
          source: $("#import-source").value.trim() || "User CSV import",
          fetchedAt: Date.now() / 1000,
        };
        state.mode = "market";
        symbol = s;
        await persist();
        page = "Research";
        render();
      } catch (e) {
        notify(e.message, true);
      }
    };
  if ($("#restore"))
    $("#restore").onchange = async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 20e6) throw Error("Backup limit is 20 MB");
        const restored = validateWorkspace(JSON.parse(await file.text()));
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
    case "maritime-fetch": {
      if (!native)
        throw Error(
          "PortWatch downloads use the native Rust backend. Start with npm run tauri dev.",
        );
      const id = maritimeSelected;
      notify("Downloading public PortWatch observations…");
      const d = await window.__TAURI__.core.invoke("fetch_maritime", { id });
      normalizeActivity(d.data, id);
      (state.maritime ||= {})[id] = d;
      await persist();
      render();
      notify(d.warning || "PortWatch observations saved.");
      break;
    }
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
      if (!state.watchlist.includes(symbol)) state.watchlist.push(symbol);
      await persist();
      render();
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
    case "prices":
      await getData("TIME_SERIES_DAILY");
      break;
    case "overview-fetch":
      await getData("OVERVIEW");
      break;
    case "statement-fetch":
      await getData(statement);
      break;
    case "news-fetch":
      await getData("NEWS_SENTIMENT");
      break;
    case "calendar-fetch":
      await getData("EARNINGS_CALENDAR");
      break;
    case "connect":
      await keys($("#alpha-key").value.trim(), $("#fred-key").value.trim());
      $("#alpha-key").value = "";
      $("#fred-key").value = "";
      notify("Keys set in Rust memory for this session.");
      break;
    case "download-symbol": {
      const s = $("#import-symbol").value.trim().toUpperCase();
      if (!/^[A-Z0-9.^_-]{1,20}$/.test(s)) throw Error("Enter a valid symbol.");
      state.mode = "market";
      await getData("TIME_SERIES_DAILY", s);
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
        "text{fill:#8196a2;font:10px monospace}.gridline{stroke:#293b44}svg{background:#151f25}";
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
    case "template":
      download(
        "prices-template.csv",
        "date,open,high,low,close,volume\n2026-01-02,100,103,99,102,1500000\n2026-01-05,102,104,101,103,1700000\n",
        "text/csv",
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
    case "macro-fetch": {
      const s = $("#macro-series").value;
      state.macro[s] = await fetchData("fred", "observations", s);
      await persist();
      render();
      break;
    }
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
