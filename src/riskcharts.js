// SVG charts for the Risk analytics view: the simulation fan, outcome
// histogram, market scenarios, daily-move distribution and rolling lines.
// Each builder returns { svg, tip, ... } for a given pixel width; hover()
// adds the crosshair or per-mark tooltip. Colors: one neutral ink for data,
// and a validated blue/orange pair (above/below today) for polarity only.

export const INK = "#ededed",
  MUTED = "#6b6b6b",
  GRID = "#313131",
  ABOVE = "#3a95d8",
  BELOW = "#d07a24",
  SURFACE = "#1d1d1d";

const money = (v) => (v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 }));
const pct = (v, d = 1) => (v == null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const plain = (v, d = 1) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export { money, pct, plain };

// Clean tick values covering [lo, hi].
export function ticks(lo, hi, count = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count,
    mag = 10 ** Math.floor(Math.log10(raw)),
    step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

const text = (x, y, s, anchor = "start", cls = "") => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ""}>${esc(s)}</text>`;
const pts = (arr) => arr.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

// Where the price could go: history, then simulated percentile bands.
export function fanChart(sim, history, horizon, W, H = 300, { examples = true } = {}) {
  const back = Math.min(history.length, Math.max(63, horizon));
  const hist = history.slice(-back);
  const fwd = horizon;
  const band = (k) => sim.bands[k].slice(0, fwd);
  // Price axis on the left, so the right edge is free for the end labels.
  const L = 62, R = 112, T = 16, B = 30, iw = W - L - R, ih = H - T - B;
  const n = back + fwd;
  const x = (i) => L + (i / (n - 1)) * iw;
  const values = [...hist.map((h) => h[1]), ...band("p5"), ...band("p95")];
  let lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo) * 0.06;
  lo -= pad; hi += pad;
  const y = (v) => T + ((hi - v) / (hi - lo)) * ih;
  const today = back - 1;
  const fx = (j) => x(today + 1 + j);
  const clip = `rc-clip-${Math.random().toString(36).slice(2, 8)}`;
  let out = `<defs><clipPath id="${clip}"><rect x="${L}" y="${T}" width="${iw}" height="${ih}"/></clipPath></defs>`;
  for (const v of ticks(lo, hi)) out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gridline"/>${text(L - 8, y(v) + 3, money(v), "end")}`;
  const area = (a, b) => `${pts([[x(today), y(sim.start)], ...band(a).map((v, j) => [fx(j), y(v)])])} ${pts(band(b).map((v, j) => [fx(j), y(v)]).reverse())}`;
  out += `<polygon points="${area("p5", "p95")}" fill="${INK}" opacity="0.08"/>`;
  out += `<polygon points="${area("p25", "p75")}" fill="${INK}" opacity="0.16"/>`;
  if (examples) for (const path of sim.examples) out += `<polyline clip-path="url(#${clip})" fill="none" stroke="${MUTED}" stroke-width="1" points="${pts([[x(today), y(sim.start)], ...path.slice(0, fwd).map((v, j) => [fx(j), y(v)])])}"/>`;
  out += `<polyline fill="none" stroke="${INK}" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round" points="${pts([[x(today), y(sim.start)], ...band("p50").map((v, j) => [fx(j), y(v)])])}"/>`;
  out += `<polyline fill="none" stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts(hist.map((h, i) => [x(i), y(h[1])]))}"/>`;
  out += `<line x1="${x(today)}" x2="${x(today)}" y1="${T}" y2="${H - B}" stroke="${MUTED}"/>${text(x(today) - 6, T + 10, "Today", "end", "strong")}`;
  out += `<circle cx="${x(today)}" cy="${y(sim.start)}" r="4" fill="${INK}" stroke="${SURFACE}" stroke-width="2"/>`;
  // End labels for the outer band and the median, dropped when they would collide.
  const ends = [["p95", "95%"], ["p50", "median"], ["p5", "5%"]].map(([k, l]) => ({ y: y(band(k).at(-1)), l: `${l} ${money(band(k).at(-1))}` }));
  let lastY = -Infinity;
  for (const e of ends) if (e.y - lastY > 13) { out += text(W - R + 8, e.y + 3, e.l, "start", "end-label"); lastY = e.y; }
  const dates = [hist[0][0], hist[today][0], sim.dates[fwd - 1]];
  out += text(x(0), H - 8, dates[0], "start") + text(x(n - 1), H - 8, dates[2], "end");
  // The "today" date only when it has room between the two ends (~70px per date).
  if (x(today) - x(0) > 140 && x(n - 1) - x(today) > 140) out += text(x(today), H - 8, dates[1], "middle");
  const tip = (i) => {
    if (i <= today) return [hist[i][0], [["Close", money(hist[i][1])]]];
    const j = i - today - 1;
    return [`${sim.dates[j]} (simulated)`, [["95th percentile", money(sim.bands.p95[j])], ["75th", money(sim.bands.p75[j])], ["Median", money(sim.bands.p50[j])], ["25th", money(sim.bands.p25[j])], ["5th percentile", money(sim.bands.p5[j])]]];
  };
  return { svg: wrap(W, H, out, T, H - B), n, x, tip, mode: "x" };
}

// Simulated prices at the horizon, split at today's price.
export function outcomeHistogram(h, start, W, H = 150) {
  const { edges, counts } = h.hist;
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const L = 4, R = 4, T = 18, B = 22, iw = W - L - R, ih = H - T - B;
  const max = Math.max(...counts, 1);
  const bw = iw / counts.length;
  const x = (v) => L + ((v - edges[0]) / (edges.at(-1) - edges[0])) * iw;
  let out = "";
  counts.forEach((c, i) => {
    const hgt = (c / max) * ih, mid = (edges[i] + edges[i + 1]) / 2;
    out += `<rect data-i="${i}" x="${(L + i * bw + 1).toFixed(1)}" y="${(T + ih - hgt).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${hgt.toFixed(1)}" rx="${Math.min(2, bw / 4).toFixed(1)}" fill="${mid < start ? BELOW : ABOVE}"/>`;
  });
  if (start > edges[0] && start < edges.at(-1)) out += `<line x1="${x(start)}" x2="${x(start)}" y1="${T - 4}" y2="${T + ih}" stroke="${INK}"/>${text(x(start), T - 7, `Today ${money(start)}`, "middle", "strong")}`;
  out += `<line x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}" class="gridline"/>`;
  out += text(L, H - 6, money(edges[0]), "start") + text(W - R, H - 6, money(edges.at(-1)), "end");
  const tip = (i) => [`${money(edges[i])} – ${money(edges[i + 1])}`, [["Share of simulations", plain(counts[i] / total)]]];
  return { svg: wrap(W, H, out), n: counts.length, x: (i) => L + (i + 0.5) * bw, tip, mode: "bar" };
}

// The stock's simulated month, grouped by what the market did that month.
export function scenarioChart(market, symbol, W) {
  const rows = market.rows;
  const rowH = 34, T = 8, B = 26, H = T + rows.length * rowH + B;
  const L = 96, R = 108, iw = W - L - R;
  const vals = rows.flatMap((r) => (r.p50 == null ? [] : [r.p10, r.p90]));
  const span = Math.max(0.05, ...vals.map(Math.abs)) * 1.1;
  const x = (v) => L + ((v + span) / (2 * span)) * iw;
  let out = "";
  for (const v of ticks(-span, span, 4)) out += `<line x1="${x(v)}" x2="${x(v)}" y1="${T}" y2="${H - B}" class="gridline"/>${text(x(v), H - 8, pct(v, 0), "middle")}`;
  out += `<line x1="${x(0)}" x2="${x(0)}" y1="${T}" y2="${H - B}" stroke="${MUTED}"/>`;
  rows.forEach((r, i) => {
    const cy = T + i * rowH + rowH / 2;
    out += `<rect data-i="${i}" x="0" y="${T + i * rowH}" width="${W}" height="${rowH}" fill="transparent"/>`;
    out += text(L - 12, cy + 4, r.label, "end");
    if (r.p50 == null) {
      out += text(x(0) + 8, cy + 4, "Too rare to estimate", "start", "muted");
      return;
    }
    out += `<line x1="${x(r.p10)}" x2="${x(r.p90)}" y1="${cy}" y2="${cy}" stroke="${MUTED}" stroke-width="2" stroke-linecap="round"/>`;
    out += `<circle cx="${x(r.p50)}" cy="${cy}" r="5" fill="${r.p50 < 0 ? BELOW : ABOVE}" stroke="${SURFACE}" stroke-width="2"/>`;
    out += text(W - R + 12, cy + 4, `${pct(r.p50)} typical`, "start");
  });
  const tip = (i) => {
    const r = rows[i];
    const head = `${market.benchmark} ${r.label.toLowerCase()} in a month · ${plain(r.share)} of simulated months`;
    return r.p50 == null ? [head, [[symbol, "too few months to estimate"]]] : [head, [[`${symbol} typical`, pct(r.p50)], ["8 in 10 between", `${pct(r.p10)} and ${pct(r.p90)}`]]];
  };
  return { svg: wrap(W, H, out), n: rows.length, y: (i) => T + i * rowH + rowH / 2, tip, mode: "row", H };
}

// Real daily moves against a normal curve with the same spread.
export function dailyHistogram(d, W, H = 190) {
  const { edges, counts, normal } = d;
  const L = 4, R = 4, T = 10, B = 24, iw = W - L - R, ih = H - T - B;
  const max = Math.max(...counts, ...normal, 1);
  const bw = iw / counts.length;
  const xv = (v) => L + ((v - edges[0]) / (edges.at(-1) - edges[0])) * iw;
  const y = (c) => T + ih - (c / max) * ih;
  let out = `<line x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}" class="gridline"/>`;
  counts.forEach((c, i) => {
    out += `<rect data-i="${i}" x="${(L + i * bw + 1).toFixed(1)}" y="${y(c).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(T + ih - y(c)).toFixed(1)}" rx="${Math.min(2, bw / 4).toFixed(1)}" fill="${MUTED}"/>`;
  });
  out += `<polyline fill="none" stroke="${INK}" stroke-width="2" stroke-linejoin="round" points="${pts(normal.map((c, i) => [L + (i + 0.5) * bw, y(c)]))}"/>`;
  for (const v of ticks(edges[0], edges.at(-1), 4)) out += text(xv(v), H - 7, pct(v, 0), "middle");
  const tip = (i) => [`Daily moves ${pct(edges[i])} to ${pct(edges[i + 1])}`, [["Days", String(counts[i])], ["Normal curve expects", normal[i].toFixed(1)]]];
  return { svg: wrap(W, H, out), n: counts.length, x: (i) => L + (i + 0.5) * bw, tip, mode: "bar" };
}

// One series over time, with an optional reference line and area wash.
export function lineChart(rows, { fmt, ref = null, wash = null, H = 160 } = {}, W) {
  const L = 4, R = 64, T = 12, B = 24, iw = W - L - R, ih = H - T - B;
  const vals = rows.map((r) => r[1]).concat(ref == null ? [] : [ref]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (wash === "below") hi = Math.max(hi, 0);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= wash === "below" ? pad : pad; hi += wash === "below" ? 0 : pad;
  const x = (i) => L + (i / Math.max(1, rows.length - 1)) * iw;
  const y = (v) => T + ((hi - v) / (hi - lo)) * ih;
  let out = "";
  for (const v of ticks(lo, hi, 3)) out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gridline"/>${text(W - R + 8, y(v) + 3, fmt(v))}`;
  if (wash === "below") out += `<polygon fill="${BELOW}" opacity="0.14" points="${pts([[x(0), y(0)], ...rows.map((r, i) => [x(i), y(r[1])]), [x(rows.length - 1), y(0)]])}"/>`;
  // The reference line is named in the chart's caption, not on the plot.
  if (ref != null) out += `<line x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}" stroke="${MUTED}"/>`;
  out += `<polyline fill="none" stroke="${wash === "below" ? BELOW : INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts(rows.map((r, i) => [x(i), y(r[1])]))}"/>`;
  const last = rows.at(-1);
  out += `<circle cx="${x(rows.length - 1)}" cy="${y(last[1])}" r="4" fill="${wash === "below" ? BELOW : INK}" stroke="${SURFACE}" stroke-width="2"/>`;
  out += text(x(0), H - 7, rows[0][0], "start") + text(x(rows.length - 1), H - 7, last[0], "end");
  const tip = (i) => [rows[i][0], [["Value", fmt(rows[i][1])]]];
  return { svg: wrap(W, H, out, T, H - B), n: rows.length, x, tip, mode: "x" };
}

function wrap(W, H, body, y1 = 0, y2 = H) {
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${body}<line class="rc-cross" y1="${y1}" y2="${y2}" stroke="#8d8d8d" visibility="hidden"/></svg>`;
}

// Crosshair (mode "x"), highlighted bar ("bar") or row ("row") with one tooltip.
export function hover(el, chart, label = (s) => s) {
  const svg = el.querySelector("svg"),
    tipEl = el.querySelector(".rc-tip"),
    cross = svg?.querySelector(".rc-cross");
  if (!svg || !tipEl) return;
  const nearest = (e) => {
    const r = svg.getBoundingClientRect(),
      sx = ((e.clientX - r.left) / r.width) * svg.viewBox.baseVal.width,
      sy = ((e.clientY - r.top) / r.height) * svg.viewBox.baseVal.height;
    let best = 0, d = Infinity;
    for (let i = 0; i < chart.n; i++) {
      const dd = chart.mode === "row" ? Math.abs(chart.y(i) - sy) : Math.abs(chart.x(i) - sx);
      if (dd < d) { d = dd; best = i; }
    }
    return { i: best, px: e.clientX - el.getBoundingClientRect().left, py: e.clientY - el.getBoundingClientRect().top };
  };
  const show = ({ i, px, py }) => {
    const [head, rows] = chart.tip(i);
    tipEl.replaceChildren();
    const h = document.createElement("div");
    h.className = "rc-tip-head";
    h.textContent = label(head);
    tipEl.append(h);
    for (const [k, v] of rows) {
      const row = document.createElement("div"),
        b = document.createElement("b"),
        s = document.createElement("span");
      b.textContent = v;
      s.textContent = k;
      row.append(b, s);
      tipEl.append(row);
    }
    tipEl.hidden = false;
    const w = el.clientWidth;
    tipEl.style.left = `${Math.min(Math.max(0, px + 14), w - tipEl.offsetWidth)}px`;
    tipEl.style.top = `${Math.max(0, py - tipEl.offsetHeight - 10)}px`;
    if (chart.mode === "x" && cross) {
      cross.setAttribute("x1", chart.x(i));
      cross.setAttribute("x2", chart.x(i));
      cross.setAttribute("visibility", "visible");
    }
    svg.querySelectorAll("[data-i]").forEach((m) => m.classList.toggle("rc-on", +m.dataset.i === i));
  };
  const hide = () => {
    tipEl.hidden = true;
    cross?.setAttribute("visibility", "hidden");
    svg.querySelectorAll(".rc-on").forEach((m) => m.classList.remove("rc-on"));
  };
  el.onpointermove = (e) => show(nearest(e));
  el.onpointerleave = hide;
  // Keyboard: arrow keys step through points.
  let k = chart.n - 1;
  el.tabIndex = 0;
  el.onkeydown = (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    k = Math.max(0, Math.min(chart.n - 1, k + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1)));
    const r = svg.getBoundingClientRect(), er = el.getBoundingClientRect();
    const sx = chart.mode === "row" ? r.width / 2 : (chart.x(k) / svg.viewBox.baseVal.width) * r.width;
    const sy = chart.mode === "row" ? (chart.y(k) / svg.viewBox.baseVal.height) * r.height : r.height / 3;
    show({ i: k, px: r.left - er.left + sx, py: r.top - er.top + sy });
  };
  el.onblur = hide;
}
