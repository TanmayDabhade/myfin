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

// Delta-hedging simulation. Holds the option legs, trades shares every
// `rebalanceDays` trading days to stay delta-neutral (at each leg's implied
// volatility), and pays `costBps` of every share trade's value. Paths are
// geometric Brownian motion at `realizedVol` (plus optional crash jumps),
// seeded, so the same inputs give the same result. Horizon: the nearest
// expiry. Returns hedged and unhedged P&L distributions and costs.
export function hedgeSim(legs, spot, { realizedVol = 0.25, rebalanceDays = 1, costBps = 0, jumps = false, paths = 1000, seed = 1, r = 0.04 } = {}) {
  const opts = legs.filter((l) => l.kind !== "stock");
  const horizon = lastExpiry(opts);
  if (!opts.length || !Number.isFinite(horizon) || horizon < 1) return null;
  const steps = Math.max(1, Math.round((horizon * 252) / 365));
  const dtYears = horizon / 365 / steps;
  let s_ = seed >>> 0 || 1;
  const u = () => ((s_ = (1664525 * s_ + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  const normal = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  const lambda = jumps ? 1.5 : 0; // crashes a year
  const value = (s, elapsed) => opts.reduce((v, l) => v + l.qty * MULTIPLIER * legValue(l, s, { daysForward: elapsed, r }), 0);
  const delta = (s, elapsed) => positionGreeks(opts, s, { r, daysForward: elapsed }).delta;
  const entry = opts.reduce((v, l) => v + l.qty * MULTIPLIER * (l.entry ?? 0), 0);
  const hedged = [], unhedged = [], costs = [];
  let trades = 0;
  for (let p = 0; p < paths; p++) {
    let s = spot, hedge = -delta(s, 0), cash = -entry - hedge * s, cost = Math.abs(hedge * s) * costBps / 1e4;
    for (let i = 1; i <= steps; i++) {
      let z = (r - 0.5 * realizedVol ** 2) * dtYears + realizedVol * Math.sqrt(dtYears) * normal();
      if (lambda && u() < lambda * dtYears) z += Math.log(1 - 0.08 - 0.05 * Math.abs(normal()));
      s *= Math.exp(z);
      cash *= Math.exp(r * dtYears);
      const elapsed = (i * horizon) / steps;
      if (i < steps && i % rebalanceDays === 0) {
        const target = -delta(s, elapsed);
        const trade = target - hedge;
        cash -= trade * s;
        cost += (Math.abs(trade * s) * costBps) / 1e4;
        hedge = target;
        trades++;
      }
    }
    const end = value(s, horizon);
    hedged.push(end + cash + hedge * s - cost);
    unhedged.push(end - entry);
    costs.push(cost);
  }
  const stats = (a) => {
    const v = [...a].sort((x, y) => x - y);
    const mean = v.reduce((x, y) => x + y, 0) / v.length;
    const sd = Math.sqrt(v.reduce((x, y) => x + (y - mean) ** 2, 0) / (v.length - 1));
    const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
    return { mean, sd, p5: q(0.05), p50: q(0.5), p95: q(0.95) };
  };
  // Continuous-hedging theory at the start: ½ Γ S² (σ_realized² − σ_implied²) T.
  const g = positionGreeks(opts, spot, { r });
  const ivAvg = opts.reduce((a, l) => a + (l.iv ?? 0.25), 0) / opts.length;
  return {
    horizon,
    steps,
    hedged: stats(hedged),
    unhedged: stats(unhedged),
    cost: stats(costs).mean,
    rebalances: trades / paths,
    theory: 0.5 * g.gamma * spot * spot * (realizedVol ** 2 - ivAvg ** 2) * (horizon / 365),
  };
}
