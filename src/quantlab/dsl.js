// Quant Lab strategy language. Strategies are plain data: indicators,
// comparisons and all/any groups from a fixed list. Nothing here is ever
// evaluated as code; the engine interprets the tree node by node.

export const ENGINE_VERSION = "quantlab-js/1.0.0";
export const INDICATORS = ["sma", "ema", "rsi", "atr", "price", "volume"];
export const FIELDS = ["open", "high", "low", "close", "volume"];
export const OPS = ["gt", "lt", "crosses_above", "crosses_below"];
export const PERIODS = { sma: [2, 400], ema: [2, 400], rsi: [2, 100], atr: [2, 100] };
const MAX_NODES = 32;

// What an indicator measures, so a rule can't compare RSI with a price.
export function unitOf(ind) {
  if (ind.kind === "rsi") return "oscillator";
  if (ind.kind === "atr") return "range";
  if (ind.kind === "volume") return "volume";
  if (ind.kind === "price") return ind.field === "volume" ? "volume" : "price";
  return ind.field === "volume" ? "volume" : "price";
}

export function indicatorLabel(ind) {
  const f = ind.field && ind.field !== "close" ? `${ind.field} ` : "";
  if (ind.kind === "price") return ind.field || "close";
  if (ind.kind === "volume") return "volume";
  return `${ind.kind.toUpperCase()}(${f}${ind.period})`;
}
const OP_TEXT = { gt: ">", lt: "<", crosses_above: "crosses above", crosses_below: "crosses below" };
export function describe(expr) {
  if (expr.all) return expr.all.map((e) => (e.any ? `(${describe(e)})` : describe(e))).join(" AND ");
  if (expr.any) return expr.any.map((e) => (e.all ? `(${describe(e)})` : describe(e))).join(" OR ");
  const side = (o) => ("constant" in o ? String(o.constant) : indicatorLabel(o.indicator));
  return `${side(expr.lhs)} ${OP_TEXT[expr.op]} ${side(expr.rhs)}`;
}

function checkIndicator(ind, path, errors) {
  if (!ind || typeof ind !== "object") return errors.push(`${path}: indicator missing`);
  const extra = Object.keys(ind).filter((k) => !["kind", "period", "field"].includes(k));
  if (extra.length) errors.push(`${path}: unknown keys ${extra.join(", ")}`);
  if (!INDICATORS.includes(ind.kind)) return errors.push(`${path}: unsupported indicator "${ind.kind}"`);
  if (ind.field != null && !FIELDS.includes(ind.field)) errors.push(`${path}: unsupported field "${ind.field}"`);
  if (ind.kind === "rsi" || ind.kind === "atr") {
    if (ind.field != null && ind.field !== "close") errors.push(`${path}: ${ind.kind} is computed from prices only`);
  }
  const range = PERIODS[ind.kind];
  if (range) {
    if (!Number.isInteger(ind.period) || ind.period < range[0] || ind.period > range[1])
      errors.push(`${path}: ${ind.kind} period must be a whole number from ${range[0]} to ${range[1]}`);
  } else if (ind.period != null) errors.push(`${path}: ${ind.kind} takes no period`);
}

function checkExpression(expr, path, depth, errors, count) {
  count.n++;
  if (count.n > MAX_NODES) return errors.push(`${path}: rule has more than ${MAX_NODES} parts`);
  if (!expr || typeof expr !== "object") return errors.push(`${path}: condition missing`);
  if (expr.all || expr.any) {
    const list = expr.all || expr.any;
    if (Object.keys(expr).length !== 1) errors.push(`${path}: a group has exactly one of all/any`);
    if (depth < 1) return errors.push(`${path}: rule is nested too deeply`);
    if (!Array.isArray(list) || !list.length) return errors.push(`${path}: empty group`);
    list.forEach((e, i) => checkExpression(e, `${path}.${expr.all ? "all" : "any"}[${i}]`, depth - 1, errors, count));
    return;
  }
  const extra = Object.keys(expr).filter((k) => !["op", "lhs", "rhs"].includes(k));
  if (extra.length) errors.push(`${path}: unknown keys ${extra.join(", ")}`);
  if (!OPS.includes(expr.op)) errors.push(`${path}: unsupported comparison "${expr.op}"`);
  const sides = [];
  for (const side of ["lhs", "rhs"]) {
    const o = expr[side];
    if (o && "constant" in o) {
      if (Object.keys(o).length !== 1 || typeof o.constant !== "number" || !Number.isFinite(o.constant))
        errors.push(`${path}.${side}: constant must be a finite number`);
      sides.push(null);
    } else if (o && "indicator" in o && Object.keys(o).length === 1) {
      checkIndicator(o.indicator, `${path}.${side}`, errors);
      sides.push(INDICATORS.includes(o.indicator?.kind) ? unitOf(o.indicator) : null);
    } else {
      errors.push(`${path}.${side}: must be an indicator or a constant`);
      sides.push(null);
    }
  }
  if (expr.lhs && expr.rhs && "constant" in expr.lhs && "constant" in expr.rhs) errors.push(`${path}: compares two constants`);
  if (sides[0] && sides[1] && sides[0] !== sides[1]) errors.push(`${path}: compares ${sides[0]} with ${sides[1]}`);
}

// Returns a list of problems; empty means the strategy can run.
export function validateStrategy(s, maxDepth = 4) {
  const errors = [];
  if (!s || typeof s !== "object") return ["Strategy missing"];
  if (s.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof s.name !== "string" || !s.name.trim() || s.name.length > 120) errors.push("name is required (up to 120 characters)");
  for (const k of ["entry", "exit"]) checkExpression(s[k], k, maxDepth, errors, { n: 0 });
  const f = s.sizing?.fraction;
  if (s.sizing?.method !== "fixed_fraction" || !(f > 0 && f <= 1)) errors.push("sizing must be fixed_fraction with a fraction above 0 and at most 1");
  const c = s.constraints || {};
  if (!Number.isInteger(c.cooldownBars) || c.cooldownBars < 0 || c.cooldownBars > 250) errors.push("constraints.cooldownBars must be 0 to 250");
  if (c.maxHoldingBars != null && (!Number.isInteger(c.maxHoldingBars) || c.maxHoldingBars < 1 || c.maxHoldingBars > 2520))
    errors.push("constraints.maxHoldingBars must be 1 to 2520");
  const extra = Object.keys(s).filter((k) => !["schemaVersion", "name", "entry", "exit", "sizing", "constraints"].includes(k));
  if (extra.length) errors.push(`unknown keys ${extra.join(", ")}`);
  return errors;
}

// Canonical JSON: sorted keys, no whitespace. Same strategy, same text.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

// SHA-256 (FIPS 180-4) over UTF-8 text, synchronous so the worker, the page
// and the tests all hash identically.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length,
    total = (((len + 9 + 63) >> 6) << 6) >>> 0;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  dv.setUint32(total - 4, bits >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15],
        b = W[i - 2];
      W[i] = (W[i - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + W[i - 7] + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return Array.from(H, (x) => x.toString(16).padStart(8, "0")).join("");
}
export const strategyHash = (s) => sha256(canonical(s));

// ---- Templates ------------------------------------------------------------
const ind = (kind, period, field) => ({ indicator: { kind, ...(period ? { period } : {}), ...(field ? { field } : {}) } });
const close = { indicator: { kind: "price", field: "close" } };
const base = (name, entry, exit) => ({ schemaVersion: 1, name, entry, exit, sizing: { method: "fixed_fraction", fraction: 1 }, constraints: { cooldownBars: 0 } });

export const TEMPLATES = {
  sma_cross: {
    label: "SMA crossover",
    params: { fast: [5, 100, 20], slow: [10, 400, 50] },
    valid: (p) => p.fast < p.slow,
    build: (p) => base(`SMA ${p.fast}/${p.slow} crossover`, { op: "crosses_above", lhs: ind("sma", p.fast), rhs: ind("sma", p.slow) }, { op: "crosses_below", lhs: ind("sma", p.fast), rhs: ind("sma", p.slow) }),
  },
  ema_cross: {
    label: "EMA crossover",
    params: { fast: [5, 100, 12], slow: [10, 400, 34] },
    valid: (p) => p.fast < p.slow,
    build: (p) => base(`EMA ${p.fast}/${p.slow} crossover`, { op: "crosses_above", lhs: ind("ema", p.fast), rhs: ind("ema", p.slow) }, { op: "crosses_below", lhs: ind("ema", p.fast), rhs: ind("ema", p.slow) }),
  },
  rsi_reversion: {
    label: "RSI mean reversion",
    params: { period: [2, 30, 14], buyBelow: [5, 45, 30], sellAbove: [50, 95, 55] },
    valid: (p) => p.buyBelow < p.sellAbove,
    build: (p) => base(`RSI(${p.period}) < ${p.buyBelow}, exit > ${p.sellAbove}`, { op: "lt", lhs: ind("rsi", p.period), rhs: { constant: p.buyBelow } }, { op: "gt", lhs: ind("rsi", p.period), rhs: { constant: p.sellAbove } }),
  },
  vol_breakout: {
    label: "Volatility breakout",
    params: { trend: [10, 200, 50], fastAtr: [2, 30, 5], slowAtr: [10, 100, 20] },
    valid: (p) => p.fastAtr < p.slowAtr,
    build: (p) =>
      base(
        `Close > SMA ${p.trend} with ATR ${p.fastAtr} > ATR ${p.slowAtr}`,
        { all: [{ op: "crosses_above", lhs: close, rhs: ind("sma", p.trend) }, { op: "gt", lhs: ind("atr", p.fastAtr), rhs: ind("atr", p.slowAtr) }] },
        { op: "crosses_below", lhs: close, rhs: ind("sma", p.trend) },
      ),
  },
};
