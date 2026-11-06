import locations from "./maritime-locations.json" with { type: "json" };
import land from "./world-land.js";
export { locations };
const e = (x) =>
  String(x ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const num = (v) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
export function normalizeActivity(payload, id) {
  if (payload?.error || !Array.isArray(payload?.features))
    throw Error("Invalid PortWatch response");
  const cp = id.startsWith("chokepoint");
  const seen = new Set();
  return payload.features
    .map((f) => {
      const a = f.attributes;
      if (a?.portid !== id) throw Error("Location mismatch");
      const raw = a.date;
      const date =
        typeof raw === "number"
          ? new Date(raw).toISOString().slice(0, 10)
          : String(raw || "").slice(0, 10);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        seen.has(date)
      )
        throw Error("Invalid or duplicate observation date");
      seen.add(date);
      return {
        date,
        tanker: num(a[cp ? "n_tanker" : "portcalls_tanker"]),
        cargo: num(a[cp ? "n_cargo" : "portcalls_cargo"]),
        total: num(a[cp ? "n_total" : "portcalls"]),
        container: num(a[cp ? "n_container" : "portcalls_container"]),
        dry_bulk: num(a[cp ? "n_dry_bulk" : "portcalls_dry_bulk"]),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
export function summary(rows, metric) {
  const latest = rows.at(-1);
  const last = rows.slice(-7).map((r) => r[metric]);
  const before = rows.slice(-14, -7).map((r) => r[metric]);
  const avg = (a) =>
    a.length === 7 && a.every((v) => v !== null)
      ? a.reduce((s, v) => s + v, 0) / 7
      : null;
  const recent = avg(last),
    prior = avg(before);
  return {
    latest: latest?.[metric] ?? null,
    date: latest?.date ?? null,
    recent,
    change: recent !== null && prior > 0 ? recent / prior - 1 : null,
  };
}
const value = (x) =>
  x === null || x === undefined
    ? "N/A"
    : Number(x).toLocaleString("en", { maximumFractionDigits: 1 });
export function activityChart(rows, metric) {
  const max = Math.max(1, ...rows.map((r) => r[metric] || 0));
  let path = "",
    open = false;
  rows.forEach((r, i) => {
    if (r[metric] === null) {
      open = false;
      return;
    }
    path += `${open ? "L" : "M"}${20 + (i / Math.max(1, rows.length - 1)) * 660},${180 - (r[metric] / max) * 145}`;
    open = true;
  });
  return `<svg viewBox="0 0 720 220" role="img" aria-label="Daily ${metric} vessel activity"><path d="${path}" fill="none" stroke="#c2c2c2" stroke-width="2"/><text x="20" y="210" fill="#a2a2a2">${e(rows[0]?.date || "")}</text><text x="560" y="210" fill="#a2a2a2">${e(rows.at(-1)?.date || "")}</text><text x="20" y="20" fill="#a2a2a2">Peak ${value(max)} · count / day</text></svg>`;
}
export function maritimeView(
  store = {},
  selected = "chokepoint6",
  metric = "tanker",
) {
  const loc = locations.find((x) => x.id === selected) || locations[0];
  const saved = store[loc.id];
  let rows = [];
  try {
    if (saved) rows = normalizeActivity(saved.data, loc.id);
  } catch {}
  const stats = summary(rows, metric);
  return `<section class="panel"><div class="panel-head"><h2>Commodity shipping intelligence</h2><span class="tag">PUBLIC AGGREGATES · NO API KEY</span></div><div class="filters"><label>Port / chokepoint<select id="maritime-location">${locations.map((x) => `<option value="${x.id}" ${x.id === loc.id ? "selected" : ""}>${e(x.name)} (${x.kind})</option>`).join("")}</select></label><label>Vessel category<select id="maritime-metric">${[
    ["tanker", "Tankers"],
    ["cargo", "Cargo (provider category)"],
    ["container", "Container"],
    ["dry_bulk", "Dry bulk"],
    ["total", "All vessels"],
  ]
    .map(
      ([k, v]) =>
        `<option value="${k}" ${metric === k ? "selected" : ""}>${v}</option>`,
    )
    .join(
      "",
    )}</select></label><button data-action="maritime-fetch">Refresh</button><button data-action="maritime-export">Export observations</button></div><p>IMF PortWatch counts daily ${loc.kind === "port" ? "port calls" : "chokepoint transits"}. These are not live ship positions or cargo manifests. A tanker classification does not identify petroleum cargo, loading status, ownership, or destination.</p><div class="maritime-map"><svg viewBox="0 0 720 360" role="img" aria-label="Global port and chokepoint locations"><rect width="720" height="360" fill="#1d1d1d"/><path d="${land}" fill="#3c3c3c" stroke="#5c5c5c" stroke-width=".4"/>${locations
    .map((x) => {
      let count = null;
      try {
        if (store[x.id])
          count = summary(
            normalizeActivity(store[x.id].data, x.id),
            metric,
          ).latest;
      } catch {}
      return `<g data-location="${x.id}" role="button" tabindex="0" aria-label="Select ${e(x.name)}"><circle cx="${(x.lon + 180) * 2}" cy="${(90 - x.lat) * 2}" r="${x.id === loc.id ? 7 : 4}" fill="${count === null ? "#8f8f8f" : "#c2c2c2"}" stroke="${x.id === loc.id ? "#ffffff" : "#1d1d1d"}" stroke-width="2"/><title>${e(x.name)} · ${count === null ? "Not downloaded" : value(count) + " on last available day"}</title></g>`;
    })
    .join(
      "",
    )}</svg><small>Natural Earth public-domain land; locations from PortWatch catalog, retrieved 2026-11-05. Gray markers: no downloaded observations. Coordinates are location reference points, not vessels.</small></div></section><div class="stats"><div class="stat"><span>Latest ${e(metric)} count</span><strong>${value(stats.latest)}</strong><small>${e(stats.date || "No observations")}</small></div><div class="stat"><span>Last 7 observations average</span><strong>${value(stats.recent)}</strong><small>Requires 7 known values</small></div><div class="stat"><span>Versus prior 7 observations</span><strong>${stats.change === null ? "N/A" : (stats.change * 100).toFixed(1) + "%"}</strong><small>Not a price or volume change</small></div><div class="stat"><span>Observation coverage</span><strong>${rows.length}</strong><small>${saved?.stale ? "STALE CACHE" : saved ? "Downloaded observations" : "No download yet"}</small></div></div><section class="panel"><div class="panel-head"><h2>${e(loc.name)} · ${e(metric)}</h2></div>${rows.length ? activityChart(rows, metric) : '<div class="empty">Loading the latest 90 days from IMF PortWatch… (desktop app only). Nothing is shown until the source responds.</div>'}<p>${saved ? "Retrieved " + e(new Date(saved.fetchedAt * 1000).toISOString()) + ". Latest observation " + e(stats.date) + "." : ""} ${e(saved?.warning || "")}</p><div class="table-wrap"><table><thead><tr><th>Date</th><th>Tanker</th><th>Cargo</th><th>Container</th><th>Dry bulk</th><th>All vessels</th></tr></thead><tbody>${rows
    .slice(-20)
    .reverse()
    .map(
      (r) =>
        `<tr>${[r.date, r.tanker, r.cargo, r.container, r.dry_bulk, r.total].map((v) => `<td>${typeof v === "string" ? e(v) : value(v)}</td>`).join("")}</tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><p><a href="https://portwatch.imf.org/" target="_blank" rel="noreferrer">Source and methodology: IMF PortWatch ↗</a> · <a href="https://www.imf.org/external/terms.htm" target="_blank" rel="noreferrer">IMF terms ↗</a></p><small>PortWatch coverage can change or be revised. No inference of disruption, congestion or investment signal is made from a count alone. The selected locations are a curated catalog, not all world ports. Commodity prices and live vessels are shown in their own panels on this page.</small></section>`;
}
