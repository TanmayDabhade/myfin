// The options maths for the interface: a thin wrapper over the WebAssembly
// build of src-tauri/crates/options-math, the same Rust code the desktop app
// and the background recorder run. Nothing is calculated here; this file only
// moves numbers in and out of the module's memory.
//
// Load once with loadMath(bytes | Response | Promise<Response>), then call
// the functions. They throw if the module isn't loaded.

let ex = null;

export const ESTIMATORS = [
  { id: "yz", code: 4, label: "Yang–Zhang", note: "Overnight gap + open-to-close + Rogers–Satchell. Uses open, high, low and close; handles opening gaps and drift." },
  { id: "c2c", code: 0, label: "Close-to-close", note: "Standard deviation of daily log returns. Simple, noisy." },
  { id: "gk", code: 2, label: "Garman–Klass", note: "Uses the day's range and open-to-close move. Ignores overnight gaps, so it reads low for stocks that gap." },
  { id: "rs", code: 3, label: "Rogers–Satchell", note: "Range-based and unaffected by drift. Ignores overnight gaps." },
  { id: "park", code: 1, label: "Parkinson", note: "High–low range only. Ignores overnight gaps and the close." },
];
const estimatorCode = (id) => {
  const e = ESTIMATORS.find((x) => x.id === id);
  if (!e) throw Error(`Unknown estimator ${id}`);
  return e.code;
};

export const IV_ERRORS = { 1: "bad input", 2: "below intrinsic value", 3: "no time value", 4: "above the no-arbitrage maximum", 5: "no solution" };
const KIND = { call: 1, put: -1 };
const kindCode = (k) => {
  if (!(k in KIND)) throw Error(`Option kind must be "call" or "put", not ${k}`);
  return KIND[k];
};

export async function loadMath(source) {
  if (ex) return ex;
  let s = await source;
  if (s && typeof s.arrayBuffer === "function") {
    if (s.ok === false) throw Error(`Options maths failed to load (HTTP ${s.status})`);
    s = await s.arrayBuffer();
  }
  const { instance } = await WebAssembly.instantiate(s, {});
  if (instance.exports.abi_version() !== 1) throw Error("Options maths module is a different version");
  ex = instance.exports;
  return ex;
}
export const mathReady = () => !!ex;
function need() {
  if (!ex) throw Error("Options maths not loaded");
  return ex;
}

// Copies arrays in, runs fn(pointers), copies `outLen` values out, frees everything.
function withArrays(inputs, outLen, fn) {
  const e = need();
  const ptrs = inputs.map((a) => (a ? [e.alloc_f64(a.length), a] : [0, null]));
  const out = outLen ? e.alloc_f64(outLen) : 0;
  try {
    // Views are made after every allocation: growing memory detaches older views.
    for (const [p, a] of ptrs) if (a) new Float64Array(e.memory.buffer, p, a.length).set(a);
    const ret = fn(ptrs.map(([p]) => p), out);
    const result = outLen ? Float64Array.from(new Float64Array(e.memory.buffer, out, outLen)) : null;
    return { ret, result };
  } finally {
    for (const [p, a] of ptrs) if (a) e.free_f64(p, a.length);
    if (outLen) e.free_f64(out, outLen);
  }
}

const GREEK_NAMES = ["price", "delta", "gamma", "vega", "theta", "rho", "vanna", "charm", "vomma", "speed"];
const greeks = (arr) => Object.fromEntries(GREEK_NAMES.map((n, i) => [n, arr[i]]));

// Black–Scholes–Merton on spot with continuous dividend yield q. Units: years,
// decimals; theta per year, vega per 1.00 of volatility (see the crate docs).
export function bsm({ kind, s, k, t, r = 0, q = 0, sigma }) {
  const { ret, result } = withArrays([], 10, (_, out) => need().bsm_greeks(kindCode(kind), s, k, t, r, q, sigma, out));
  if (!ret) throw Error("Invalid option kind");
  return greeks(result);
}
// Black-76 on a forward or futures price.
export function black76({ kind, f, k, t, r = 0, sigma }) {
  const { result } = withArrays([], 10, (_, out) => need().black76_greeks(kindCode(kind), f, k, t, r, sigma, out));
  return greeks(result);
}
// Implied volatility of a European option from its price, on forward f with
// discount factor df. Returns { iv } or { error }.
export function impliedVol({ kind, price, f, k, t, df }) {
  const v = need().implied_vol(kindCode(kind), price, f, k, t, df);
  return v >= 0 ? { iv: v } : { error: IV_ERRORS[-v] || "no solution" };
}
// American (early: true) or European price on the Leisen–Reimer tree.
// dividends: [{ t, amount }] in years from now.
export function treePrice({ kind, s, k, t, r = 0, q = 0, sigma, steps = 301, early = true, dividends = [] }) {
  const { ret } = withArrays([dividends.map((d) => d.t), dividends.map((d) => d.amount)], 0, ([dt, da]) =>
    need().tree_price(kindCode(kind), s, k, t, r, q, sigma, steps, early ? 1 : 0, dt, da, dividends.length),
  );
  return ret;
}

const columns = (bars) => ["open", "high", "low", "close"].map((f) => Float64Array.from(bars, (b) => +b[f]));

// Bars whose open gaps more than `threshold` from the prior close, likely an
// unadjusted split. Returns { flags: boolean[], count }.
export function splitSuspects(bars, threshold = 0.4) {
  const [o, , , c] = columns(bars);
  const { ret, result } = withArrays([o, c], bars.length, ([po, pc], out) => need().split_suspects(po, pc, bars.length, threshold, out));
  return { flags: Array.from(result || [], (v) => v === 1), count: ret };
}
// Rolling annualized realized volatility (decimals), one value per bar; null until enough bars.
export function realizedRolling(bars, { estimator = "yz", window = 21, exclude = null } = {}) {
  if (bars.length === 0) return [];
  const ex_ = exclude ? Float64Array.from(exclude, (b) => (b ? 1 : 0)) : null;
  const { result } = withArrays([...columns(bars), ex_], bars.length, ([o, h, l, c, x], out) => need().realized_rolling(estimatorCode(estimator), o, h, l, c, x, bars.length, window, out));
  return Array.from(result, (v) => (Number.isFinite(v) ? v : null));
}
// Volatility cone rows: { window, min, p25, median, p75, max, current, count }.
export function realizedCone(bars, { estimator = "yz", windows = [10, 21, 63, 126, 252], exclude = null } = {}) {
  if (bars.length === 0) return [];
  const ex_ = exclude ? Float64Array.from(exclude, (b) => (b ? 1 : 0)) : null;
  const { result } = withArrays([...columns(bars), ex_, Float64Array.from(windows)], 8 * windows.length, ([o, h, l, c, x, w], out) =>
    need().realized_cone(estimatorCode(estimator), o, h, l, c, x, bars.length, w, windows.length, out),
  );
  const keys = ["window", "min", "p25", "median", "p75", "max", "current", "count"];
  return windows.map((_, i) => Object.fromEntries(keys.map((k, j) => [k, Number.isFinite(result[8 * i + j]) ? result[8 * i + j] : null])));
}

// SVI smile fit for one expiry: points [{ k: ln(K/F), iv }], t in years.
// Returns { a, b, rho, m, sigma, rmse, minG, points, iv(k) } or null.
export function sviFit(points, t) {
  const ks = Float64Array.from(points, (p) => p.k),
    vs = Float64Array.from(points, (p) => p.iv);
  const { ret, result } = withArrays([ks, vs], 8, ([pk, pv], out) => need().svi_fit(pk, pv, points.length, t, out));
  if (!ret) return null;
  const [a, b, rho, m, sigma, rmse, minG, n] = result;
  const w = (k) => a + b * (rho * (k - m) + Math.sqrt((k - m) ** 2 + sigma * sigma));
  return { a, b, rho, m, sigma, rmse, minG, points: n, arbitrageFree: minG >= 0, iv: (k) => Math.sqrt(Math.max(0, w(k)) / t) };
}
