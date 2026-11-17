// Option-chain helpers for the OMON view: grouping, the strikes around the
// money, smile and term structure points, and a deterministic synthetic
// chain for demo mode (same shape as the desktop app's analyzed chain, and
// always labelled synthetic). Prices and IVs come from the Rust maths.
import { bsm, impliedVol } from "./math.js";

export const DAY_MS = 864e5;

// Rows for one expiry: [{ strike, call, put }] sorted by strike.
export function strikeRows(chain, expiry) {
  const by = new Map();
  for (const q of chain?.quotes || []) {
    if (q.expiry !== expiry) continue;
    const r = by.get(q.strike) || { strike: q.strike, call: null, put: null };
    r[q.kind] = q;
    by.set(q.strike, r);
  }
  return [...by.values()].sort((a, b) => a.strike - b.strike);
}
// The n strikes either side of the forward (all when n is falsy).
export function nearMoney(rows, forward, n) {
  if (!n || rows.length <= 2 * n + 1) return rows;
  let i = rows.findIndex((r) => r.strike >= forward);
  if (i < 0) i = rows.length - 1;
  return rows.slice(Math.max(0, i - n), i + n);
}
// Out-of-the-money IV by strike (what the smile chart draws), plus the vendor's.
export function smile(chain, expiry) {
  const info = chain.expiries.find((e) => e.expiry === expiry);
  const f = info?.forward ?? chain.spot;
  return strikeRows(chain, expiry)
    .map((r) => {
      const q = r.strike >= f ? r.call : r.put;
      return { strike: r.strike, iv: q?.iv ?? null, vendor: q?.vendor_iv ?? null };
    })
    .filter((p) => p.iv != null || p.vendor != null);
}
export const termPoints = (chain) => chain.expiries.filter((e) => e.atm_iv != null).map((e) => ({ expiry: e.expiry, days: e.days, iv: e.atm_iv }));

// Typical listed strike spacing for a price.
export function strikeStep(price) {
  return price < 25 ? 1 : price < 100 ? 2.5 : price < 250 ? 5 : 10;
}

// A synthetic chain for demo data: a skewed smile and gently rising term
// structure around `vol`, priced by Black–Scholes, with bid/ask around the
// price. Deterministic for a symbol, spot and date.
export function syntheticChain(symbol, spot, asOfDate, { vol = 0.25, rate = 0.04, q = 0.01 } = {}) {
  const asOf = Date.parse(asOfDate + "T21:00:00Z");
  const step = strikeStep(spot);
  const quotes = [];
  const expiries = [];
  // Fridays 1, 2, 4 weeks out, then roughly monthly for a year.
  const base = new Date(asOf);
  const toFri = (5 - base.getUTCDay() + 7) % 7 || 7;
  const offsets = [toFri, toFri + 7, toFri + 21, toFri + 49, toFri + 77, toFri + 140, toFri + 231, toFri + 357];
  let seed = [...symbol].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32);
  for (const d of offsets) {
    const expiry = new Date(asOf + d * DAY_MS).toISOString().slice(0, 10);
    const t = (d * DAY_MS - 5 * 3600e3) / (365 * DAY_MS);
    const f = spot * Math.exp((rate - q) * t);
    const df = Math.exp(-rate * t);
    const atm = vol * (0.92 + 0.08 * Math.min(1, t * 2));
    let withIv = 0;
    const lo = Math.max(step, Math.floor((spot * 0.6) / step) * step);
    for (let k = lo; k <= spot * 1.4; k += step) {
      const m = Math.log(k / f);
      const sigma = Math.max(0.05, atm - 0.35 * m / Math.max(0.35, Math.sqrt(t * 4)) + 0.4 * m * m);
      for (const kind of ["call", "put"]) {
        const g = bsm({ kind, s: spot, k, t, r: rate, q, sigma });
        const half = Math.max(0.01, g.price * 0.03);
        const bid = Math.max(0, +(g.price - half).toFixed(2));
        const ask = +(g.price + half).toFixed(2);
        const otm = (kind === "call" && k >= f) || (kind === "put" && k < f);
        const mid = (bid + ask) / 2;
        const solved = bid > 0 && otm ? impliedVol({ kind, price: mid, f, k, t, df }).iv : null;
        const ivv = solved ?? null;
        const gg = ivv ? bsm({ kind, s: spot, k, t, r: rate, q, sigma: ivv }) : null;
        if (ivv) withIv++;
        quotes.push({
          symbol: `${symbol}${expiry.slice(2).replaceAll("-", "")}${kind === "call" ? "C" : "P"}${String(Math.round(k * 1000)).padStart(8, "0")}`,
          kind, strike: k, expiry, bid, ask, last: +g.price.toFixed(2),
          volume: Math.round(rnd() * 2000 * Math.exp(-Math.abs(m) * 6)),
          open_interest: Math.round(rnd() * 20000 * Math.exp(-Math.abs(m) * 4)),
          quote_time: new Date(asOf).toISOString(), multiplier: 100, style: "american",
          vendor_iv: sigma, vendor_delta: g.delta,
          iv: ivv, delta: gg?.delta ?? null, gamma: gg?.gamma ?? null, theta: gg?.theta ?? null, vega: gg?.vega ?? null, rho: gg?.rho ?? null,
          flags: ["synthetic"],
        });
      }
    }
    expiries.push({ expiry, days: d, t, forward: f, forward_source: "synthetic", forward_range: 0, df, atm_iv: atm, skew: null, contracts: 0, with_iv: withIv });
  }
  // IV for in-the-money options: the out-of-the-money option's at the same strike.
  for (const e of expiries) {
    const rows = strikeRows({ quotes }, e.expiry);
    for (const r of rows) {
      const src = r.strike >= e.forward ? r.call : r.put;
      const other = r.strike >= e.forward ? r.put : r.call;
      if (src?.iv && other) {
        const g = bsm({ kind: other.kind, s: spot, k: r.strike, t: e.t, r: rate, q, sigma: src.iv });
        Object.assign(other, { iv: src.iv, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, rho: g.rho });
      }
    }
    e.contracts = rows.length * 2;
  }
  const near30 = expiries.reduce((a, b) => (Math.abs(b.days - 30) < Math.abs(a.days - 30) ? b : a));
  return { underlying: symbol, spot, rate, rate_source: "assumed 4% (demo)", as_of: Math.floor(asOf / 1000), expiries, quotes, summary: { atm30: near30.atm_iv, atm60: null, atm90: null, skew30: null }, synthetic: true };
}

// Estimated gamma exposure from open interest. Who holds each side of an
// open contract isn't public, so this is a model under a stated convention:
//   "dealers long calls, short puts": the usual published convention
//   (customers sell calls and buy puts);
//   "dealers short everything": customers own all open options.
// Dollar gamma per 1% move: Γ × OI × 100 × S² × 0.01.
export const GEX_CONVENTIONS = {
  lcsp: { label: "Dealers long calls, short puts", sign: { call: 1, put: -1 } },
  short: { label: "Dealers short every option", sign: { call: -1, put: -1 } },
};
export function gammaExposure(chain, { expiry = null, range = 0.15, points = 41 } = {}) {
  const S = chain.spot;
  const tOf = Object.fromEntries(chain.expiries.map((e) => [e.expiry, e.t]));
  const qs = chain.quotes.filter((q) => q.iv > 0 && q.open_interest > 0 && tOf[q.expiry] > 0 && (!expiry || q.expiry === expiry));
  const dollarGamma = (q, s) => bsm({ kind: q.kind, s, k: q.strike, t: tOf[q.expiry], r: chain.rate || 0, sigma: q.iv }).gamma * q.open_interest * 100 * s * s * 0.01;
  const strikes = new Map();
  for (const q of qs) {
    const row = strikes.get(q.strike) || { strike: q.strike, call: 0, put: 0 };
    row[q.kind] += dollarGamma(q, S);
    strikes.set(q.strike, row);
  }
  const byStrike = [...strikes.values()].sort((a, b) => a.strike - b.strike);
  const total = (conv, s) => qs.reduce((sum, q) => sum + GEX_CONVENTIONS[conv].sign[q.kind] * dollarGamma(q, s), 0);
  const grid = Array.from({ length: points }, (_, i) => S * (1 - range + (2 * range * i) / (points - 1)));
  const out = { spot: S, contracts: qs.length, byStrike, oiDates: [...new Set(chain.quotes.map((q) => q.oi_date).filter(Boolean))].sort(), conventions: {} };
  for (const conv of Object.keys(GEX_CONVENTIONS)) {
    const profile = grid.map((s) => ({ spot: s, gex: total(conv, s) }));
    // The zero crossing nearest today's price, if the profile has one.
    let flip = null;
    for (let i = 1; i < profile.length; i++) {
      const [a, b] = [profile[i - 1], profile[i]];
      if (a.gex === 0 || Math.sign(a.gex) !== Math.sign(b.gex)) {
        const x = a.spot + ((b.spot - a.spot) * -a.gex) / (b.gex - a.gex || 1);
        if (flip == null || Math.abs(x - S) < Math.abs(flip - S)) flip = x;
      }
    }
    out.conventions[conv] = { total: total(conv, S), profile, flip };
  }
  return out;
}

// Implied move for an event on `date` ("bmo" before the open, "amc" after
// the close): the at-the-money straddle of the first expiry that includes
// it, as a share of spot, and the event-only move from two expiries that
// both include it (total variance w = σ²T = σ²_base·T + E).
export function impliedMove(chain, date, hour = "amc") {
  const after = chain.expiries.filter((e) => (hour === "bmo" ? e.expiry >= date : e.expiry > date) && e.atm_iv != null);
  if (!after.length) return null;
  const e1 = after[0];
  const rows = strikeRows(chain, e1.expiry);
  const atm = rows.reduce((a, b) => (Math.abs(b.strike - e1.forward) < Math.abs(a.strike - e1.forward) ? b : a), rows[0]);
  const mid = (q) => (q && q.bid > 0 && q.ask >= q.bid ? (q.bid + q.ask) / 2 : null);
  const straddle = mid(atm?.call) != null && mid(atm?.put) != null ? mid(atm.call) + mid(atm.put) : null;
  let eventOnly = null;
  const e2 = after[1];
  if (e2) {
    const [w1, w2] = [e1.atm_iv ** 2 * e1.t, e2.atm_iv ** 2 * e2.t];
    const E = (w1 * e2.t - w2 * e1.t) / (e2.t - e1.t);
    if (E > 0) eventOnly = Math.sqrt(E) * Math.sqrt(2 / Math.PI); // expected absolute move
  }
  return { expiry: e1.expiry, days: e1.days, straddle, strike: atm?.strike, move: straddle == null ? null : straddle / chain.spot, eventOnly, secondExpiry: e2?.expiry ?? null };
}

// Realized moves around past earnings: before the open → close of the day
// before to close of the day; after the close → close of the day to the next.
export function earningsMoves(bars, events) {
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const out = [];
  for (const ev of events) {
    let i = idx.get(ev.date);
    if (i == null) continue;
    const [from, to] = ev.hour === "bmo" ? [i - 1, i] : [i, i + 1];
    if (from < 0 || to >= bars.length) continue;
    out.push({ date: ev.date, hour: ev.hour || "amc", move: bars[to].close / bars[from].close - 1 });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
