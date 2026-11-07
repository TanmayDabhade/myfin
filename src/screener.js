import { number } from "./engine.js";
export const periods = { d1: 1, w1: 5, m1: 21, m3: 63, y1: 252, ytd: "ytd" };
export function performance(bars, period = "d1") {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const last = bars.at(-1);
  let base;
  if (period === "ytd") {
    const year = last.date.slice(0, 4);
    base = bars.filter((b) => b.date.slice(0, 4) < year).at(-1);
  } else {
    const n = periods[period];
    if (typeof n !== "number" || bars.length <= n) return null;
    base = bars.at(-1 - n);
  }
  return base && base.close > 0 && Number.isFinite(last.close)
    ? last.close / base.close - 1
    : null;
}
export function metric(asset, key, period) {
  const o = asset.overview || {};
  switch (key) {
    case "return":
      return performance(asset.bars, period);
    case "margin":
      return number(o.ProfitMargin);
    case "growth":
      return number(o.QuarterlyRevenueGrowthYOY);
    case "pe": {
      const v = number(o.PERatio);
      return v > 0 ? v : null;
    }
    case "cap": {
      const v = number(o.MarketCapitalization);
      return v > 0 ? v : null;
    }
    default:
      return null;
  }
}
export const defaults = {
  period: "m1",
  metric: "return",
  size: "equal",
  sector: "",
  minGrowth: "",
  maxPE: "",
  query: "",
  sort: "return",
  direction: "desc",
  view: "both",
};
export function screenRows(assets, options = {}) {
  const v = { ...defaults, ...options };
  return assets
    .filter((a) => {
      const pe = metric(a, "pe"),
        g = metric(a, "growth");
      return (
        (!v.sector || a.sector === v.sector) &&
        (!v.query ||
          `${a.symbol} ${a.name}`
            .toLowerCase()
            .includes(v.query.toLowerCase())) &&
        (v.maxPE === "" || (pe !== null && pe <= Number(v.maxPE))) &&
        (v.minGrowth === "" || (g !== null && g * 100 >= Number(v.minGrowth)))
      );
    })
    .sort((a, b) => {
      const av = v.sort === "symbol" ? a.symbol : metric(a, v.sort, v.period),
        bv = v.sort === "symbol" ? b.symbol : metric(b, v.sort, v.period);
      if (av === null && bv === null) return a.symbol.localeCompare(b.symbol);
      if (av === null) return 1;
      if (bv === null) return -1;
      const c = typeof av === "string" ? av.localeCompare(bv) : av - bv;
      return (
        (v.direction === "asc" ? 1 : -1) * c || a.symbol.localeCompare(b.symbol)
      );
    });
}
export function shade(v, key) {
  if (v === null || !Number.isFinite(v)) return "#333333";
  const percent =
    key === "pe" ? Math.min(v / 60, 1) : Math.min(Math.abs(v) / 0.15, 1);
  if (key === "pe") return `hsl(0 0% ${16 + percent * 22}%)`;
  return `hsl(${v >= 0 ? 148 : 4} ${22 + percent * 28}% ${14 + percent * 16}%)`;
}
const e = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const f = (v, key) =>
  v === null
    ? "N/A"
    : key === "pe"
      ? v.toFixed(1) + "×"
      : (v * 100).toFixed(2) + "%";
export function screenerView(assets, options, saved = []) {
  const v = { ...defaults, ...options },
    rows = screenRows(assets, v),
    groups = Object.groupBy(rows, (a) => a.sector || "Unclassified");
  const known = rows.filter(
    (a) => metric(a, v.metric, v.period) !== null,
  ).length;
  const select = (id, values) =>
    `<select data-screen-field="${id}">${values.map(([key, label]) => `<option value="${key}" ${v[id] === key ? "selected" : ""}>${e(label)}</option>`).join("")}</select>`;
  return `<section class="panel"><div class="panel-head"><h2>Visual screener</h2><span class="tag">${rows.length} / ${assets.length} assets</span><button data-action="visual-screen-save">Save view</button><button data-action="visual-screen-export">Export results</button></div><div class="filters"><label>Search<input data-screen-field="query" value="${e(v.query)}" placeholder="Symbol / company"></label><label>Sector${select("sector", [["", "All sectors"], ...[...new Set(assets.map((a) => a.sector).filter(Boolean))].sort().map((s) => [s, s])])}</label><label>Maximum P/E<input data-screen-field="maxPE" type="number" min="0" value="${e(v.maxPE)}" placeholder="Any"></label><label>Minimum growth %<input data-screen-field="minGrowth" type="number" value="${e(v.minGrowth)}" placeholder="Any"></label></div><div class="filters"><label>Color${select(
    "metric",
    [
      ["return", "Price return"],
      ["growth", "Revenue growth YoY"],
      ["margin", "Profit margin"],
      ["pe", "P/E ratio"],
    ],
  )}</label><label>Horizon${select("period", [
    ["d1", "1 session"],
    ["w1", "5 sessions"],
    ["m1", "21 sessions"],
    ["m3", "63 sessions"],
    ["ytd", "YTD"],
    ["y1", "252 sessions"],
  ])}</label><label>Tile width${select("size", [
    ["equal", "Equal"],
    ["cap", "Market cap"],
  ])}</label><label>Sort${select("sort", [
    ["return", "Price return"],
    ["cap", "Market cap"],
    ["pe", "P/E"],
    ["margin", "Margin"],
    ["growth", "Growth"],
    ["symbol", "Symbol"],
  ])}</label><label>Order${select("direction", [
    ["desc", "Descending"],
    ["asc", "Ascending"],
  ])}</label><label>View${select("view", [
    ["both", "Heatmap + table"],
    ["heatmap", "Heatmap"],
    ["table", "Table"],
  ])}</label></div><p class="muted">${known}/${rows.length} have the selected color metric. Gray = unavailable; zero is neutral. Price horizons count observations; YTD needs a prior-year close. Returns exclude dividends and corporate actions.</p>${
    v.view !== "table"
      ? `<div class="screen-map">${
          Object.entries(groups)
            .map(([sector, items]) => {
              const capTotal = items.reduce(
                (s, a) => s + (metric(a, "cap") || 0),
                0,
              );
              return `<section class="screen-sector"><h3>${e(sector)} <small>${items.length} assets</small></h3><div class="screen-tiles">${items
                .map((a) => {
                  const val = metric(a, v.metric, v.period),
                    cap = metric(a, "cap");
                  return `<button data-symbol="${e(a.symbol)}" class="screen-tile" style="background:${shade(val, v.metric)};flex-grow:${v.size === "cap" && capTotal ? Math.max(((cap || 0) / capTotal) * 100, 0.1) : 1}" title="${e(a.name)} · ${e(a.source)} · through ${e(a.bars?.at(-1)?.date || "unknown")}" aria-label="Research ${e(a.symbol)}, ${f(val, v.metric)}"><strong>${e(a.symbol)}</strong><span>${f(val, v.metric)}</span><small>${e(a.name)}</small><small>${e(a.bars?.at(-1)?.date || "No prices")}</small></button>`;
                })
                .join("")}</div></section>`;
            })
            .join("") || "<p>No matches. Clear filters or add data.</p>"
        }</div><p><small>Color: ${v.metric === "pe" ? "blue intensity = higher P/E, not a recommendation" : "red = negative; green = positive; intensity capped at ±15%"} · Cap sizing has a minimum readable width; missing caps use minimum width.</small></p>`
      : ""
  }${v.view !== "heatmap" ? `<div class="table-wrap"><table><thead><tr>${["Company", "Sector", "Return", "P/E", "Margin", "Growth", "Market cap", "Price date"].map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.map((a) => `<tr><td><button data-symbol="${e(a.symbol)}">${e(a.symbol)}</button></td><td>${e(a.sector || "—")}</td><td>${f(metric(a, "return", v.period), "return")}</td><td>${f(metric(a, "pe"), "pe")}</td><td>${f(metric(a, "margin"), "margin")}</td><td>${f(metric(a, "growth"), "growth")}</td><td>${metric(a, "cap") === null ? "N/A" : Intl.NumberFormat("en", { notation: "compact" }).format(metric(a, "cap"))}</td><td>${e(a.bars?.at(-1)?.date || "—")}</td></tr>`).join("")}</tbody></table></div>` : ""}<div class="panel-head"><h2>Saved views</h2></div>${saved.map((x, i) => `<button data-action="visual-screen-load" data-value="${i}">${e(x.name)}</button>`).join("") || "<small>No saved views.</small>"}</section>`;
}

// ---- Market map (S&P 500 treemap) -------------------------------------------
// Squarified treemap (Bruls, Huizing and van Wijk): lays out items with a
// positive `value` inside a rectangle, keeping tiles close to square.
// Returns [{ item, x, y, w, h }].
export function squarify(items, rect) {
  const list = items.filter((i) => i.value > 0);
  const total = list.reduce((t, i) => t + i.value, 0);
  if (!total || !(rect.w > 0) || !(rect.h > 0)) return [];
  const scale = (rect.w * rect.h) / total;
  const nodes = list.map((item) => ({ item, area: item.value * scale })).sort((a, b) => b.area - a.area);
  let { x, y, w, h } = rect;
  const out = [];
  const worst = (row, side) => {
    const s = row.reduce((t, r) => t + r.area, 0);
    const max = Math.max(...row.map((r) => r.area)),
      min = Math.min(...row.map((r) => r.area));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const place = (row) => {
    const s = row.reduce((t, r) => t + r.area, 0);
    if (w >= h) {
      const cw = s / h;
      let yy = y;
      for (const r of row) {
        const rh = r.area / cw;
        out.push({ item: r.item, x, y: yy, w: cw, h: rh });
        yy += rh;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = s / w;
      let xx = x;
      for (const r of row) {
        const rw = r.area / rh;
        out.push({ item: r.item, x: xx, y, w: rw, h: rh });
        xx += rw;
      }
      y += rh;
      h -= rh;
    }
  };
  let row = [];
  for (let i = 0; i < nodes.length; ) {
    const side = Math.min(w, h);
    if (!row.length || worst([...row, nodes[i]], side) <= worst(row, side)) row.push(nodes[i++]);
    else {
      place(row);
      row = [];
    }
  }
  if (row.length) place(row);
  return out;
}
// Horizons, with the change that gets full colour intensity.
export const MAP_PERIODS = [
  ["d1", "1 day", 0.03],
  ["w1", "1 week", 0.06],
  ["m1", "1 month", 0.1],
  ["m3", "3 months", 0.2],
  ["ytd", "Year to date", 0.35],
  ["y1", "1 year", 0.5],
];
export function mapShade(v, cap) {
  if (v == null || !Number.isFinite(v)) return "#2a2a2a";
  const t = Math.min(Math.abs(v) / cap, 1);
  return v >= 0 ? `hsl(148 ${30 + t * 35}% ${13 + t * 22}%)` : `hsl(2 ${35 + t * 35}% ${15 + t * 25}%)`;
}
const pctText = (v) => (v == null || !Number.isFinite(v) ? "—" : (v > 0 ? "+" : "") + (v * 100).toFixed(2) + "%");
const capText = (v) => (v == null ? "—" : "$" + Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v));
// The map's priced tiles after filters, each with the value used for its area.
// A company without a share count gets a small tile rather than none.
export function mapTiles(snapshot, { mapSector = "", mapQuery = "", mapSize = "cap" } = {}) {
  const q = mapQuery.trim().toUpperCase();
  const priced = (snapshot?.tiles || []).filter((t) => t.price != null);
  const caps = priced.map((t) => t.cap).filter((c) => c > 0).sort((a, b) => a - b);
  const floor = caps.length ? caps[Math.floor(caps.length / 2)] * 0.2 : 1;
  return priced
    .filter((t) => (!mapSector || t.sector === mapSector) && (!q || `${t.symbol} ${t.name}`.toUpperCase().includes(q)))
    .map((t) => ({ ...t, value: mapSize === "equal" ? 1 : t.cap > 0 ? t.cap : floor }));
}
export function marketMapView(snapshot, options = {}, width = 1000) {
  const o = { mapPeriod: "d1", mapSize: "cap", mapSector: "", mapQuery: "", ...options };
  const onlyToday = snapshot?.source === "finnhub";
  const period = onlyToday ? "d1" : o.mapPeriod;
  const [, periodLabel, cap] = MAP_PERIODS.find((p) => p[0] === period) || MAP_PERIODS[0];
  const tiles = mapTiles(snapshot, o);
  const W = Math.max(320, Math.round(width)),
    H = Math.round(Math.min(860, Math.max(460, W * 0.56)));
  const bySector = Object.groupBy(tiles, (t) => t.sector || "Other");
  const sectors = squarify(
    Object.entries(bySector).map(([name, list]) => ({ name, list, value: list.reduce((s, t) => s + t.value, 0) })),
    { x: 0, y: 0, w: W, h: H },
  );
  const cells = sectors
    .map((s) => {
      const head = s.h > 60 && s.w > 70 ? 17 : 0;
      const inner = squarify(s.item.list, { x: s.x + 1, y: s.y + head + 1, w: s.w - 2, h: s.h - head - 2 });
      const label = head ? `<div class="mm-sector" style="left:${s.x.toFixed(1)}px;top:${s.y.toFixed(1)}px;width:${s.w.toFixed(1)}px">${e(s.item.name)}</div>` : "";
      return (
        label +
        inner
          .map(({ item: t, x, y, w, h }) => {
            const v = t.returns?.[period];
            const big = w > 62 && h > 40,
              mid = w > 34 && h > 20;
            const fs = Math.max(9, Math.min(22, Math.sqrt(w * h) / 5));
            return `<button class="mm-tile" data-symbol="${e(t.symbol)}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px;width:${Math.max(0, w - 1).toFixed(1)}px;height:${Math.max(0, h - 1).toFixed(1)}px;background:${mapShade(v, cap)};font-size:${fs.toFixed(0)}px" title="${e(t.symbol)} · ${e(t.name)}&#10;${e(t.industry)}&#10;${pctText(v)} (${e(periodLabel)}) · $${t.price.toFixed(2)} · market cap ${capText(t.cap)}" aria-label="Open ${e(t.symbol)}, ${pctText(v)}">${mid ? `<b>${e(t.symbol)}</b>` : ""}${big ? `<span>${pctText(v)}</span>` : ""}</button>`;
          })
          .join("")
      );
    })
    .join("");
  const sel = (id, values, cur, disabled = false) =>
    `<select data-screen-field="${id}" ${disabled ? "disabled" : ""}>${values.map(([k, l]) => `<option value="${e(k)}" ${k === cur ? "selected" : ""}>${e(l)}</option>`).join("")}</select>`;
  const allSectors = [...new Set((snapshot?.tiles || []).map((t) => t.sector).filter(Boolean))].sort();
  const ranked = tiles.filter((t) => t.returns?.[period] != null).sort((a, b) => b.returns[period] - a.returns[period]);
  const list = (rows) =>
    rows.length
      ? `<div class="table-wrap"><table><tbody>${rows.map((t) => `<tr><td><button class="link" data-symbol="${e(t.symbol)}">${e(t.symbol)}</button> <small>${e(t.name)}</small></td><td class="${t.returns[period] >= 0 ? "up" : "down"}">${pctText(t.returns[period])}</td><td>$${t.price.toFixed(2)}</td><td>${capText(t.cap)}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">No data.</p>`;
  const priced = (snapshot?.tiles || []).filter((t) => t.price != null).length;
  const legend = [-1, -0.5, 0, 0.5, 1].map((k) => `<span style="background:${mapShade(k * cap, cap)}">${pctText(k * cap)}</span>`).join("");
  return `<section class="panel"><div class="panel-head"><h2>S&amp;P 500 market map <small>${priced} of ${snapshot?.members || 0} companies · prices through ${e(snapshot?.date || "—")}</small></h2><button data-action="market-refresh">Refresh</button></div><div class="filters"><label>Change over${sel("mapPeriod", MAP_PERIODS.map(([k, l]) => [k, l]), period, onlyToday)}</label><label>Tile size${sel("mapSize", [["cap", "Market cap"], ["equal", "Equal"]], o.mapSize)}</label><label>Sector${sel("mapSector", [["", "All sectors"], ...allSectors.map((s) => [s, s])], o.mapSector)}</label><label>Find<input data-screen-field="mapQuery" value="${e(o.mapQuery)}" placeholder="Symbol or company"></label></div>${onlyToday ? `<p class="notice">Today's change only: prices come from Finnhub quotes. Add a free Alpaca key in Settings for week, month, year-to-date and 1-year changes.</p>` : ""}<div class="mm-wrap" style="height:${H}px">${cells || `<p class="muted">No companies match.</p>`}</div><div class="mm-legend">${legend}<small>Click a company to open its stock page. Tile area is market cap: price × shares outstanding from SEC filings (share classes of one company split it evenly; a missing share count gets a small tile).</small></div><div class="grid halves"><section><h3>Top gainers · ${e(periodLabel)}</h3>${list(ranked.slice(0, 10))}</section><section><h3>Top losers · ${e(periodLabel)}</h3>${list(ranked.slice(-10).reverse())}</section></div><small>S&amp;P 500 members from the open s-and-p-500-companies dataset. ${snapshot?.source === "alpaca" ? "Daily bars from Alpaca's free IEX feed, split-adjusted; IEX closing trades can differ slightly from official closes." : "Quotes from Finnhub."} Returns exclude dividends. Built ${snapshot?.built ? new Date(snapshot.built * 1000).toLocaleString() : "—"}.</small></section>`;
}
