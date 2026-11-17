// SVG charts for volatility: several series over time, signed bars around
// zero, and the volatility cone. Same conventions as riskcharts.js: each
// builder returns { svg, n, x, tip, mode } for hover(), at a given width.
import { INK, MUTED, ABOVE, BELOW, SURFACE, ticks } from "./riskcharts.js";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const text = (x, y, s, anchor = "start", cls = "") => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}"${cls ? ` class="${cls}"` : ""}>${esc(s)}</text>`;
const wrap = (W, H, body, y1, y2) => `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${body}<line class="rc-cross" y1="${y1}" y2="${y2}" stroke="#8d8d8d" visibility="hidden"/></svg>`;
const finite = (v) => v != null && Number.isFinite(v);

// Polyline points, broken into separate runs where values are missing.
function runs(values, x, y) {
  const out = [];
  let cur = [];
  values.forEach((v, i) => {
    if (finite(v)) cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    else if (cur.length) out.push(cur), (cur = []);
  });
  if (cur.length) out.push(cur);
  return out;
}

export const SERIES_COLORS = { ink: INK, blue: ABOVE, orange: BELOW, muted: MUTED };

// Lines over shared dates. series: [{ label, values, color, dash, width }].
// opts: fmt for values, ref (horizontal reference value), shade (boolean per
// date, drawn as a light background band), H.
export function multiLine(dates, series, { fmt, ref = null, shade = null, H = 220 } = {}, W) {
  const L = 4, R = 64, T = 12, B = 24, iw = W - L - R, ih = H - T - B;
  const all = series.flatMap((s) => s.values.filter(finite)).concat(ref == null ? [] : [ref]);
  if (!all.length || dates.length < 2) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;
  const x = (i) => L + (i / Math.max(1, dates.length - 1)) * iw;
  const y = (v) => T + ((hi - v) / (hi - lo)) * ih;
  let out = "";
  if (shade) {
    const step = iw / Math.max(1, dates.length - 1);
    shade.forEach((on, i) => {
      if (on) out += `<rect x="${(x(i) - step / 2).toFixed(1)}" y="${T}" width="${Math.max(1, step).toFixed(1)}" height="${ih}" fill="${BELOW}" opacity="0.13"/>`;
    });
  }
  for (const v of ticks(lo, hi, 3)) out += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gridline"/>${text(W - R + 8, y(v) + 3, fmt(v))}`;
  if (ref != null) out += `<line x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}" stroke="${MUTED}"/>`;
  for (const s of series)
    for (const pts of runs(s.values, x, y))
      out += `<polyline fill="none" stroke="${s.color || INK}" stroke-width="${s.width || 1.6}"${s.dash ? ' stroke-dasharray="5 4"' : ""} stroke-linejoin="round" stroke-linecap="round" points="${pts.join(" ")}"/>`;
  out += text(x(0), H - 7, dates[0], "start") + text(x(dates.length - 1), H - 7, dates.at(-1), "end");
  const tip = (i) => [dates[i], series.map((s) => [s.label, finite(s.values[i]) ? fmt(s.values[i]) : "—"])];
  return { svg: wrap(W, H, out, T, H - B), n: dates.length, x, tip, mode: "x" };
}

// Bars up from zero for positive values, down for negative.
export function signedBars(dates, values, { fmt, label = "Value", H = 170 } = {}, W) {
  const L = 4, R = 64, T = 10, B = 24, iw = W - L - R, ih = H - T - B;
  const v = values.filter(finite);
  if (!v.length) return null;
  const lo = Math.min(0, ...v), hi = Math.max(0, ...v);
  const pad = (hi - lo) * 0.06 || 1;
  const top = hi + pad, bot = lo - pad;
  const x = (i) => L + ((i + 0.5) / dates.length) * iw;
  const y = (val) => T + ((top - val) / (top - bot)) * ih;
  const bw = Math.max(0.6, iw / dates.length - 0.4);
  let out = "";
  for (const t of ticks(bot, top, 3)) out += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="gridline"/>${text(W - R + 8, y(t) + 3, fmt(t))}`;
  values.forEach((val, i) => {
    if (!finite(val)) return;
    const y0 = y(0), y1 = y(val);
    out += `<rect x="${(x(i) - bw / 2).toFixed(2)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(2)}" height="${Math.max(0.5, Math.abs(y1 - y0)).toFixed(1)}" fill="${val >= 0 ? ABOVE : BELOW}" opacity="0.85"/>`;
  });
  out += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="${MUTED}"/>`;
  out += text(L, H - 7, dates[0], "start") + text(W - R, H - 7, dates.at(-1), "end");
  const tip = (i) => [dates[i], [[label, finite(values[i]) ? fmt(values[i]) : "not known yet"]]];
  return { svg: wrap(W, H, out, T, H - B), n: dates.length, x, tip, mode: "x" };
}

// Volatility cone: per window, the full range (light), middle half (dark),
// median (tick) and the latest value (dot).
export function coneChart(rows, { fmt, H = 220 } = {}, W) {
  const L = 4, R = 64, T = 12, B = 26, iw = W - L - R, ih = H - T - B;
  const r = rows.filter((x) => finite(x.min) && finite(x.max));
  if (!r.length) return null;
  const vals = r.flatMap((x) => [x.min, x.max, x.current].filter(finite));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.08 || 0.01;
  lo = Math.max(0, lo - pad);
  hi += pad;
  const x = (i) => L + ((i + 0.5) / r.length) * iw;
  const y = (v) => T + ((hi - v) / (hi - lo)) * ih;
  const bw = Math.min(46, (iw / r.length) * 0.5);
  let out = "";
  for (const t of ticks(lo, hi, 4)) out += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="gridline"/>${text(W - R + 8, y(t) + 3, fmt(t))}`;
  r.forEach((row, i) => {
    const cx = x(i);
    out += `<rect data-i="${i}" x="${(cx - bw / 2).toFixed(1)}" y="${y(row.max).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y(row.min) - y(row.max)).toFixed(1)}" fill="${INK}" opacity="0.1" rx="2"/>`;
    out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y(row.p75).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y(row.p25) - y(row.p75)).toFixed(1)}" fill="${INK}" opacity="0.28" rx="2"/>`;
    out += `<line x1="${(cx - bw / 2).toFixed(1)}" x2="${(cx + bw / 2).toFixed(1)}" y1="${y(row.median).toFixed(1)}" y2="${y(row.median).toFixed(1)}" stroke="${INK}" stroke-width="1.5"/>`;
    if (finite(row.current)) out += `<circle cx="${cx.toFixed(1)}" cy="${y(row.current).toFixed(1)}" r="5" fill="${ABOVE}" stroke="${SURFACE}" stroke-width="2"/>`;
    out += text(cx, H - 8, `${row.window}d`, "middle");
  });
  const tip = (i) => {
    const row = r[i];
    return [`${row.window}-day realized volatility`, [["Now", finite(row.current) ? fmt(row.current) : "—"], ["Highest", fmt(row.max)], ["Upper quarter from", fmt(row.p75)], ["Median", fmt(row.median)], ["Lower quarter to", fmt(row.p25)], ["Lowest", fmt(row.min)], ["Windows measured", String(row.count)]]];
  };
  return { svg: wrap(W, H, out, T, H - B), n: r.length, x, tip, mode: "x" };
}
