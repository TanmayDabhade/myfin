// Order flow from trade prints: buying and selling volume at each price,
// running delta, and the tape grouped the way crypto exchanges show it.
// Input rows come from tapeStats (stock.js), which marks each print "buy"
// or "sell" by the tick rule. Free feeds carry no bid/ask, so the side is an
// estimate of who was more aggressive, not a record of it.

// Prints at or after `sinceMs`; 0 keeps everything.
export const since = (rows, sinceMs) => (sinceMs > 0 ? rows.filter((r) => r.time >= sinceMs) : rows);

// Consecutive prints with the same time, price and side are usually one
// order filled against several resting orders: show them as one row.
export function groupPrints(rows) {
  const out = [];
  for (const r of rows || []) {
    const g = out.at(-1);
    if (g && g.time === r.time && g.price === r.price && g.side === r.side) {
      g.size += r.size;
      g.count++;
    } else out.push({ time: r.time, price: r.price, size: r.size, side: r.side, tick: r.tick, count: 1, conditions: r.conditions });
  }
  return out;
}

const STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 250, 500, 1000];
// The smallest round price step that fits the range into about `levels` rows.
export function priceStep(low, high, levels = 24) {
  const raw = (high - low) / Math.max(1, levels);
  return STEPS.find((s) => s >= raw - 1e-9) || STEPS.at(-1);
}
const cents = (x) => Math.round(x * 100) / 100;

// Volume at price, split by side. Rows are price levels, highest first.
// `poc` is the busiest level (the point of control).
export function volumeAtPrice(rows, levels = 24) {
  const priced = (rows || []).filter((r) => r.price > 0);
  if (!priced.length) return { rows: [], step: null, poc: null, max: 0 };
  let low = Infinity,
    high = -Infinity;
  for (const r of priced) {
    low = Math.min(low, r.price);
    high = Math.max(high, r.price);
  }
  const step = priceStep(low, high, levels);
  const map = new Map();
  for (const r of priced) {
    const price = cents(Math.floor(r.price / step + 1e-9) * step);
    const l = map.get(price) || { price, buy: 0, sell: 0, other: 0, count: 0 };
    if (r.side === "buy") l.buy += r.size;
    else if (r.side === "sell") l.sell += r.size;
    else l.other += r.size;
    l.count++;
    map.set(price, l);
  }
  const out = [...map.values()].map((l) => ({ ...l, total: l.buy + l.sell + l.other, delta: l.buy - l.sell })).sort((a, b) => b.price - a.price);
  const poc = out.reduce((m, l) => (!m || l.total > m.total ? l : m), null);
  return { rows: out, step, poc: poc?.price ?? null, max: poc?.total || 0 };
}
// The level a price falls in, for marking the last trade and VWAP.
export const levelOf = (price, step) => (price == null || !step ? null : cents(Math.floor(price / step + 1e-9) * step));

// Running buy-minus-sell volume, one point per second (the last value in it).
// `toTime` maps Unix ms to the chart's time axis.
export function cumulativeDelta(rows, toTime = (ms) => Math.floor(ms / 1000)) {
  const out = [];
  let d = 0;
  for (const r of rows || []) {
    if (r.side === "buy") d += r.size;
    else if (r.side === "sell") d -= r.size;
    const time = toTime(r.time),
      last = out.at(-1);
    if (last && last.time === time) last.value = d;
    else if (!last || time > last.time) out.push({ time, value: d });
  }
  return out;
}

// What counts as a large print: at least 10x the median size and 1,000
// shares, or the top 1% of prints, whichever is bigger.
export function largeSize(rows) {
  const sizes = (rows || [])
    .map((r) => r.size)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  if (sizes.length < 20) return Infinity;
  const median = sizes[Math.floor(sizes.length / 2)],
    top = sizes[Math.floor(sizes.length * 0.99)];
  return Math.max(median * 10, 1000, top);
}

// Totals for a set of classified prints.
export function flowSummary(rows) {
  let volume = 0,
    notional = 0,
    buy = 0,
    sell = 0,
    high = null,
    low = null,
    largest = null;
  for (const r of rows || []) {
    volume += r.size;
    notional += r.size * r.price;
    if (r.side === "buy") buy += r.size;
    else if (r.side === "sell") sell += r.size;
    high = high == null ? r.price : Math.max(high, r.price);
    low = low == null ? r.price : Math.min(low, r.price);
    if (!largest || r.size > largest.size) largest = r;
  }
  return {
    count: rows?.length || 0,
    volume,
    vwap: volume > 0 ? notional / volume : null,
    buy,
    sell,
    delta: buy - sell,
    buyShare: buy + sell > 0 ? buy / (buy + sell) : null,
    high,
    low,
    first: rows?.[0] || null,
    last: rows?.at(-1) || null,
    largest: largest?.size > 0 ? largest : null,
  };
}
