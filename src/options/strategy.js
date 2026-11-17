// Option strategies for the OSA view: value a set of legs at any underlying
// price, date and volatility shift, the payoff at expiry, position Greeks,
// a scenario grid and break-evens. Prices use the Rust maths (BSM with a
// dividend yield); this file only adds legs up. Everything here is a model:
// the UI labels it so.
import { bsm } from "./math.js";

export const MULTIPLIER = 100;

// leg: { kind: "call" | "put" | "stock", strike, days (to expiry, from today),
//        qty (contracts or shares; negative = short), entry (price paid per
//        share), iv (decimal) }
export function legValue(leg, s, { daysForward = 0, ivShift = 0, r = 0.04, q = 0 } = {}) {
  if (leg.kind === "stock") return s;
  const t = Math.max(0, (leg.days - daysForward) / 365);
  const sigma = Math.max(0.01, (leg.iv ?? 0.25) + ivShift);
  if (t === 0) return Math.max(0, (leg.kind === "call" ? 1 : -1) * (s - leg.strike));
  return bsm({ kind: leg.kind, s, k: leg.strike, t, r, q, sigma }).price;
}
const mult = (leg) => (leg.kind === "stock" ? 1 : MULTIPLIER);

// Position P&L in dollars against the entry prices.
export function pnl(legs, s, opts = {}) {
  return legs.reduce((sum, l) => sum + l.qty * mult(l) * (legValue(l, s, opts) - (l.entry ?? 0)), 0);
}
export const netPremium = (legs) => legs.reduce((s, l) => s + l.qty * mult(l) * (l.entry ?? 0), 0);
export const lastExpiry = (legs) => Math.min(...legs.filter((l) => l.kind !== "stock").map((l) => l.days), Infinity);

// Dollar Greeks of the position at today's date.
export function positionGreeks(legs, s, { r = 0.04, q = 0, ivShift = 0, daysForward = 0 } = {}) {
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  for (const l of legs) {
    if (l.kind === "stock") {
      out.delta += l.qty;
      continue;
    }
    const t = Math.max(0, (l.days - daysForward) / 365);
    if (t === 0) continue;
    const g = bsm({ kind: l.kind, s, k: l.strike, t, r, q, sigma: Math.max(0.01, (l.iv ?? 0.25) + ivShift) });
    const m = l.qty * MULTIPLIER;
    out.delta += m * g.delta; // shares-equivalent
    out.gamma += m * g.gamma; // shares per $1
    out.theta += (m * g.theta) / 365; // $ per calendar day
    out.vega += (m * g.vega) / 100; // $ per volatility point
    out.rho += (m * g.rho) / 100; // $ per percentage point of rates
  }
  return out;
}

// P&L curves over a price grid, at expiry (of the nearest leg) and at chosen horizons.
export function curves(legs, spot, { horizons = [0], ivShift = 0, r = 0.04, q = 0, lo = 0.7, hi = 1.3, n = 121 } = {}) {
  const prices = Array.from({ length: n }, (_, i) => spot * (lo + ((hi - lo) * i) / (n - 1)));
  const expiry = lastExpiry(legs);
  const atExpiry = Number.isFinite(expiry) ? prices.map((s) => pnl(legs, s, { daysForward: expiry, ivShift, r, q })) : null;
  const lines = horizons.map((d) => ({ days: d, values: prices.map((s) => pnl(legs, s, { daysForward: Math.min(d, Number.isFinite(expiry) ? expiry : d), ivShift, r, q })) }));
  return { prices, atExpiry, lines, expiryDays: expiry };
}

// Underlying prices where the at-expiry P&L crosses zero.
export function breakEvens(prices, values) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    const [a, b] = [values[i - 1], values[i]];
    if (a === 0) out.push(prices[i - 1]);
    else if (a * b < 0) out.push(prices[i - 1] + ((prices[i] - prices[i - 1]) * -a) / (b - a));
  }
  return out;
}

// Max gain and loss at expiry. Unbounded when the payoff still slopes at the grid edges.
export function extremes(legs, spot) {
  const calls = legs.reduce((s, l) => s + (l.kind === "call" ? l.qty : 0), 0) + legs.reduce((s, l) => s + (l.kind === "stock" ? l.qty / MULTIPLIER : 0), 0);
  const { prices, atExpiry } = curves(legs, spot, { lo: 0.0001, hi: 3, n: 600 });
  if (!atExpiry) return null;
  return {
    maxGain: calls > 1e-9 ? Infinity : Math.max(...atExpiry),
    maxLoss: calls < -1e-9 ? -Infinity : Math.min(...atExpiry),
    breakEvens: breakEvens(prices, atExpiry),
  };
}

// P&L for spot moves × volatility shifts at a horizon.
export function scenarioGrid(legs, spot, { days = 0, moves = [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2], shifts = [-0.1, -0.05, 0, 0.05, 0.1], r = 0.04, q = 0 } = {}) {
  return moves.map((m) => ({ move: m, cells: shifts.map((v) => ({ shift: v, pnl: pnl(legs, spot * (1 + m), { daysForward: days, ivShift: v, r, q }) })) }));
}

// Starting points, relative to spot. `pick(kind, moneyness, days)` returns a leg's strike/iv/entry/days.
export const TEMPLATES = {
  "long-call": { label: "Long call", legs: [["call", 1.0, 1]] },
  "long-put": { label: "Long put", legs: [["put", 1.0, 1]] },
  "covered-call": { label: "Covered call", legs: [["stock", 0, 100], ["call", 1.05, -1]] },
  "protective-put": { label: "Protective put", legs: [["stock", 0, 100], ["put", 0.95, 1]] },
  collar: { label: "Collar", legs: [["stock", 0, 100], ["put", 0.95, 1], ["call", 1.05, -1]] },
  "bull-call": { label: "Bull call spread", legs: [["call", 1.0, 1], ["call", 1.05, -1]] },
  "bear-put": { label: "Bear put spread", legs: [["put", 1.0, 1], ["put", 0.95, -1]] },
  straddle: { label: "Long straddle", legs: [["call", 1.0, 1], ["put", 1.0, 1]] },
  strangle: { label: "Long strangle", legs: [["call", 1.05, 1], ["put", 0.95, 1]] },
  "iron-condor": { label: "Iron condor", legs: [["put", 0.9, 1], ["put", 0.95, -1], ["call", 1.05, -1], ["call", 1.1, 1]] },
};
export function buildTemplate(id, spot, pick) {
  return TEMPLATES[id].legs.map(([kind, m, qty]) => (kind === "stock" ? { kind, qty, entry: spot, strike: null, days: null, iv: null } : { kind, qty, ...pick(kind, spot * m) }));
}

// Book-level scenarios: several underlyings, each with its spot and legs
// (entries set to current marks), all moved by the same percentage and
// volatility shift. Returns the summed P&L grid.
export function bookScenario(groups, { days = 0, moves = [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2], shifts = [-0.1, -0.05, 0, 0.05, 0.1], r = 0.04 } = {}) {
  return moves.map((m) => ({
    move: m,
    cells: shifts.map((v) => ({ shift: v, pnl: groups.reduce((sum, g) => sum + pnl(g.legs, g.spot * (1 + m), { daysForward: days, ivShift: v, r }), 0) })),
  }));
}
