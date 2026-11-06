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
