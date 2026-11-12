// Quant Lab backtest engine: data checks, indicators and order simulation on
// daily bars. A signal is known only after the close of bar t and fills at
// the open of bar t+1, so a rule can never trade on the bar that produced it.
import { canonical, sha256 } from "./dsl.js";

const DAY = 86400000;
const dayOf = (d) => Date.parse(d + "T00:00:00Z");

// Sorts, de-duplicates and checks bars. Blocking problems stop scoring;
// warnings are shown with every result that uses the data.
export function prepareBars(input) {
  const blocking = [],
    warnings = [];
  const byDate = new Map();
  for (const b of input || []) {
    const date = String(b?.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      blocking.push(`Bar without a valid date: ${JSON.stringify(b?.date)}`);
      continue;
    }
    const bar = { date, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: Number.isFinite(+b.volume) ? +b.volume : 0 };
    const prev = byDate.get(date);
    if (prev && canonical(prev) !== canonical(bar)) blocking.push(`${date} appears twice with different prices`);
    byDate.set(date, bar);
  }
  const bars = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  bars.forEach((b, i) => {
    const ok = [b.open, b.high, b.low, b.close].every((x) => Number.isFinite(x) && x > 0);
    if (!ok) blocking.push(`${b.date}: missing or non-positive price`);
    else if (b.high < b.low || b.open > b.high || b.open < b.low || b.close > b.high || b.close < b.low) blocking.push(`${b.date}: open/close outside the day's high-low range`);
    const p = bars[i - 1];
    if (!p) return;
    const gap = (dayOf(b.date) - dayOf(p.date)) / DAY;
    if (gap > 6) warnings.push(`No bars between ${p.date} and ${b.date} (${gap} calendar days); nothing is filled in.`);
    if (ok && p.close > 0 && Math.abs(b.open / p.close - 1) > 0.4)
      warnings.push(`${b.date} opens ${((b.open / p.close - 1) * 100).toFixed(0)}% from the prior close: possibly a split the provider did not adjust.`);
  });
  return { bars, blocking, warnings };
}

// An immutable, hashed copy of the bars a run used.
export function makeSnapshot({ symbol, providerId, source, adjustment, bars, fetchedAt = null }) {
  const prepared = prepareBars(bars);
  const body = { symbol, providerId, adjustment, bars: prepared.bars };
  const contentSha256 = sha256(canonical(body));
  return {
    id: "ds_" + contentSha256.slice(0, 20),
    contentSha256,
    symbol,
    providerId,
    source: source || providerId,
    adjustment,
    calendar: "Provider trading days (US exchanges)",
    from: prepared.bars[0]?.date || null,
    to: prepared.bars.at(-1)?.date || null,
    count: prepared.bars.length,
    fetchedAt,
    warnings: prepared.warnings,
    blocking: prepared.blocking,
    bars: prepared.bars,
  };
}

// ---- Indicators -----------------------------------------------------------
// Each value at index t uses bars 0..t only.
function field(bars, f) {
  return bars.map((b) => b[f || "close"]);
}
function sma(values, p) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= p) sum -= values[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}
function ema(values, p) {
  const out = new Array(values.length).fill(null);
  if (values.length < p) return out;
  const k = 2 / (p + 1);
  let v = values.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = v;
  for (let i = p; i < values.length; i++) out[i] = v = values[i] * k + v * (1 - k);
  return out;
}
function rsi(closes, p) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= p) return out;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= p;
  loss /= p;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[p] = val();
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (p - 1) + Math.max(d, 0)) / p;
    loss = (loss * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = val();
  }
  return out;
}
function atr(bars, p) {
  const out = new Array(bars.length).fill(null);
  const tr = bars.map((b, i) => (i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low));
  if (bars.length < p) return out;
  let v = tr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = v;
  for (let i = p; i < bars.length; i++) out[i] = v = (v * (p - 1) + tr[i]) / p;
  return out;
}
export function indicatorSeries(bars, ind, cache = new Map()) {
  const key = canonical(ind);
  if (cache.has(key)) return cache.get(key);
  let s;
  if (ind.kind === "price") s = field(bars, ind.field);
  else if (ind.kind === "volume") s = field(bars, "volume");
  else if (ind.kind === "sma") s = sma(field(bars, ind.field), ind.period);
  else if (ind.kind === "ema") s = ema(field(bars, ind.field), ind.period);
  else if (ind.kind === "rsi") s = rsi(field(bars, "close"), ind.period);
  else if (ind.kind === "atr") s = atr(bars, ind.period);
  else throw Error(`Unsupported indicator ${ind.kind}`);
  cache.set(key, s);
  return s;
}

// Evaluates a rule tree into one boolean per bar (false while warming up).
export function signalSeries(bars, expr, cache = new Map()) {
  const n = bars.length;
  if (expr.all || expr.any) {
    const parts = (expr.all || expr.any).map((e) => signalSeries(bars, e, cache));
    return Array.from({ length: n }, (_, i) => (expr.all ? parts.every((p) => p[i]) : parts.some((p) => p[i])));
  }
  const side = (o) => ("constant" in o ? null : indicatorSeries(bars, o.indicator, cache));
  const L = side(expr.lhs),
    R = side(expr.rhs);
  const at = (S, o, i) => (S ? S[i] : o.constant);
  const out = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const l = at(L, expr.lhs, i),
      r = at(R, expr.rhs, i);
    if (l == null || r == null) continue;
    if (expr.op === "gt") out[i] = l > r;
    else if (expr.op === "lt") out[i] = l < r;
    else if (i > 0) {
      const pl = at(L, expr.lhs, i - 1),
        pr = at(R, expr.rhs, i - 1);
      if (pl == null || pr == null) continue;
      out[i] = expr.op === "crosses_above" ? pl <= pr && l > r : pl >= pr && l < r;
    }
  }
  return out;
}

// Index range of bars inside [from, to], inclusive.
export function windowIndex(bars, from, to) {
  let a = bars.findIndex((b) => b.date >= from);
  let b = -1;
  for (let i = bars.length - 1; i >= 0; i--)
    if (bars[i].date <= to) {
      b = i;
      break;
    }
  return a < 0 || b < a ? null : [a, b];
}

// Long-only simulation of one strategy over bars[a..b]. Starts flat with
// initialCash; an open position at the end stays open and is marked to the
// last close. Whole shares only.
export function backtest(bars, strategy, opts, cache = new Map()) {
  const { from, to, initialCash, maxPositionWeight = 1, commissionBps = 0, slippageBps = 0, minCommissionUsd = 0 } = opts;
  const win = windowIndex(bars, from, to);
  if (!win) return { dates: [], equity: [], exposure: [], fills: [], trades: [], rejected: [{ at: from, reason: "NO_DATA_IN_WINDOW" }], openPosition: null, initialCash };
  const [a, b] = win;
  const entry = signalSeries(bars, strategy.entry, cache),
    exit = signalSeries(bars, strategy.exit, cache);
  const fee = (notional) => (notional > 0 ? Math.max(minCommissionUsd, (notional * commissionBps) / 1e4) : 0);
  const slip = slippageBps / 1e4,
    fraction = Math.min(strategy.sizing.fraction, maxPositionWeight),
    cooldown = strategy.constraints?.cooldownBars || 0,
    maxHold = strategy.constraints?.maxHoldingBars;
  let cash = initialCash,
    qty = 0,
    entryFill = null,
    lastExit = -Infinity,
    pending = null;
  const dates = [],
    equity = [],
    exposure = [],
    fills = [],
    trades = [],
    rejected = [];
  for (let i = a; i <= b; i++) {
    const bar = bars[i];
    if (pending) {
      const { side, signalAt, reason } = pending;
      pending = null;
      if (side === "buy") {
        const price = bar.open * (1 + slip);
        let n = Math.floor((cash * fraction) / price);
        while (n > 0 && n * price + fee(n * price) > cash) n--;
        if (n < 1) rejected.push({ at: bar.date, signalAt, reason: "INSUFFICIENT_CASH" });
        else {
          const commission = fee(n * price);
          cash -= n * price + commission;
          qty = n;
          entryFill = { index: i, date: bar.date, price, commission, signalAt };
          fills.push({ signalAt, filledAt: bar.date, side: "buy", qty: n, price, commission, slippage: n * bar.open * slip, realizedPnl: null, reason });
        }
      } else {
        const price = bar.open * (1 - slip),
          commission = fee(qty * price);
        const pnl = qty * price - commission - (qty * entryFill.price + entryFill.commission);
        cash += qty * price - commission;
        fills.push({ signalAt, filledAt: bar.date, side: "sell", qty, price, commission, slippage: qty * bar.open * slip, realizedPnl: pnl, reason });
        trades.push({
          entryAt: entryFill.date,
          exitAt: bar.date,
          qty,
          entryPrice: entryFill.price,
          exitPrice: price,
          pnl,
          return: pnl / (qty * entryFill.price + entryFill.commission),
          bars: i - entryFill.index,
          exitReason: reason,
        });
        qty = 0;
        entryFill = null;
        lastExit = i;
      }
    }
    dates.push(bar.date);
    equity.push(cash + qty * bar.close);
    exposure.push(qty > 0 ? 1 : 0);
    // Signals at this close fill at the next bar's open.
    let want = null;
    if (qty === 0 && entry[i] && i - lastExit >= cooldown) want = { side: "buy", reason: "entry rule" };
    else if (qty > 0 && exit[i]) want = { side: "sell", reason: "exit rule" };
    else if (qty > 0 && maxHold && i - entryFill.index + 1 >= maxHold) want = { side: "sell", reason: `held ${maxHold} bars` };
    if (want) {
      if (i < b) pending = { ...want, signalAt: bar.date };
      else rejected.push({ at: bar.date, signalAt: bar.date, reason: "NO_NEXT_BAR_IN_WINDOW", side: want.side });
    }
  }
  return {
    dates,
    equity,
    exposure,
    fills,
    trades,
    rejected,
    initialCash,
    openPosition: qty > 0 ? { qty, entryAt: entryFill.date, entryPrice: entryFill.price, markedAt: dates.at(-1), markPrice: bars[b].close, unrealizedPnl: qty * (bars[b].close - entryFill.price) - entryFill.commission } : null,
  };
}
