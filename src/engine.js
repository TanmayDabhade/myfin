export const finite = (x) =>
  Number.isFinite(Number(x)) && x !== "" && x !== null;
export function number(x) {
  return finite(x) ? Number(x) : null;
}
export function returns(bars) {
  return bars.slice(1).map((b, i) => b.close / bars[i].close - 1);
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
export function risk(bars, rf = 0.04) {
  const r = returns(bars);
  if (r.length < 2) return null;
  const avg = mean(r),
    sd = Math.sqrt(r.reduce((s, x) => s + (x - avg) ** 2, 0) / (r.length - 1));
  let peak = bars[0].close,
    dd = 0;
  for (const b of bars) {
    peak = Math.max(peak, b.close);
    dd = Math.min(dd, b.close / peak - 1);
  }
  return {
    vol: sd * Math.sqrt(252),
    sharpe: sd ? ((avg - rf / 252) / sd) * Math.sqrt(252) : null,
    drawdown: dd,
    total: bars.at(-1).close / bars[0].close - 1,
    observations: r.length,
  };
}
export function correlation(a, b) {
  const bm = new Map(
    b.map((x, i) => [x.date, i ? x.close / b[i - 1].close - 1 : null]),
  );
  const pairs = a
    .slice(1)
    .map((x, i) => [x.close / a[i].close - 1, bm.get(x.date)])
    .filter((x) => x[1] != null);
  if (pairs.length < 3) return null;
  const am = mean(pairs.map((x) => x[0])),
    mb = mean(pairs.map((x) => x[1]));
  const den = Math.sqrt(
    pairs.reduce((s, x) => s + (x[0] - am) ** 2, 0) *
      pairs.reduce((s, x) => s + (x[1] - mb) ** 2, 0),
  );
  return den
    ? pairs.reduce((s, x) => s + (x[0] - am) * (x[1] - mb), 0) / den
    : null;
}
export function sma(bars, n) {
  return bars.map((b, i) =>
    i < n - 1 ? null : mean(bars.slice(i - n + 1, i + 1).map((x) => x.close)),
  );
}
export function rsi(bars, n = 14) {
  if (bars.length <= n) return null;
  let up = 0,
    down = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    let d = bars[i].close - bars[i - 1].close;
    up += Math.max(d, 0);
    down += Math.max(-d, 0);
  }
  return down === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / down);
}
export function dcf({
  fcf,
  growth,
  discount,
  terminal,
  netDebt,
  shares,
  years = 5,
}) {
  if (
    ![fcf, growth, discount, terminal, netDebt, shares, years].every(
      Number.isFinite,
    ) ||
    shares <= 0 ||
    discount <= terminal ||
    discount <= -1 ||
    growth <= -1 ||
    years < 1 ||
    years > 30
  )
    throw Error(
      "Require finite values, positive shares, and discount rate above terminal growth.",
    );
  let pv = 0,
    flow = fcf;
  for (let i = 1; i <= years; i++) {
    flow *= 1 + growth;
    pv += flow / (1 + discount) ** i;
  }
  const tv =
    (flow * (1 + terminal)) / (discount - terminal) / (1 + discount) ** years;
  return {
    enterprise: pv + tv,
    equity: pv + tv - netDebt,
    perShare: (pv + tv - netDebt) / shares,
    terminalShare: tv / (pv + tv),
  };
}
// Option contracts are traded by OCC symbol (AAPL260206C00250000) with a
// multiplier; stocks by ticker. Positions are signed: a short option is a
// negative quantity. Shares are long only.
export const OCC = /^[A-Z.]{1,6}\d{6}[CP]\d{8}$/;
export function parseContract(sym) {
  const m = /^([A-Z.]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym || "");
  if (!m) return null;
  return { underlying: m[1], expiry: `20${m[2]}-${m[3]}-${m[4]}`, kind: m[5] === "C" ? "call" : "put", strike: +m[6] / 1000 };
}
const multOf = (t) => (t.instrument === "option" ? t.multiplier || 100 : 1);

// Cash, realized P&L and signed positions, by average cost. Opening or
// adding costs qty × price × multiplier + fee (a short's cost is negative:
// the credit received, less the fee); closing realizes the cash flow minus
// the proportional cost basis.
export function book(account) {
  let cash = account.initial,
    realized = 0;
  const holdings = {};
  for (const t of account.trades) {
    const m = multOf(t);
    const p = holdings[t.symbol] || { qty: 0, cost: 0, realized: 0, ...(t.instrument === "option" ? { instrument: "option", multiplier: m, ...parseContract(t.symbol) } : {}) };
    const dq = t.side === "buy" ? t.qty : -t.qty;
    const flow = -dq * t.price * m - t.fee;
    cash += flow;
    if (p.qty === 0 || Math.sign(dq) === Math.sign(p.qty)) {
      p.cost -= flow;
      p.qty += dq;
    } else {
      const closing = Math.min(Math.abs(dq), Math.abs(p.qty));
      const basis = (p.cost * closing) / Math.abs(p.qty);
      const gain = flow - basis;
      p.cost -= basis;
      p.qty += Math.sign(dq) * closing;
      p.realized += gain;
      realized += gain;
      if (Math.abs(p.qty) < 1e-9) p.qty = 0, p.cost = 0;
    }
    holdings[t.symbol] = p;
  }
  return { cash, realized, holdings };
}

// What the option book ties up, by the paper rules: each short call is
// covered by 100 shares or paired with a long call (expiring no earlier),
// each short put paired with a long put or secured by strike × 100 in cash.
// A spread reserves its maximum loss. Uncovered short calls aren't allowed.
export function requirements(holdings) {
  const by = {};
  for (const [sym, p] of Object.entries(holdings)) {
    if (!p.qty) continue;
    if (p.instrument === "option") {
      const u = (by[p.underlying] ||= { shares: 0, legs: [] });
      u.legs.push({ sym, kind: p.kind, strike: p.strike, expiry: p.expiry, n: Math.abs(p.qty), short: p.qty < 0, m: p.multiplier || 100 });
    } else (by[sym] ||= { shares: 0, legs: [] }).shares += p.qty;
  }
  let required = 0;
  const uncovered = [];
  const lockedShares = {};
  for (const [u, g] of Object.entries(by)) {
    let shares = g.shares;
    const longs = (kind) => g.legs.filter((l) => !l.short && l.kind === kind).map((l) => ({ ...l, left: l.n }));
    const lc = longs("call"),
      lp = longs("put");
    for (const sc of g.legs.filter((l) => l.short && l.kind === "call").sort((a, b) => a.strike - b.strike)) {
      let n = sc.n;
      const fromShares = Math.min(n, Math.floor(shares / sc.m));
      shares -= fromShares * sc.m;
      lockedShares[u] = (lockedShares[u] || 0) + fromShares * sc.m;
      n -= fromShares;
      for (const l of lc.filter((x) => x.expiry >= sc.expiry).sort((a, b) => a.strike - b.strike)) {
        if (!n) break;
        const k = Math.min(n, l.left);
        l.left -= k;
        n -= k;
        required += k * sc.m * Math.max(0, l.strike - sc.strike);
      }
      if (n) uncovered.push(`${n} ${sc.sym}`);
    }
    for (const sp of g.legs.filter((l) => l.short && l.kind === "put").sort((a, b) => b.strike - a.strike)) {
      let n = sp.n;
      for (const l of lp.filter((x) => x.expiry >= sp.expiry).sort((a, b) => b.strike - a.strike)) {
        if (!n) break;
        const k = Math.min(n, l.left);
        l.left -= k;
        n -= k;
        required += k * sp.m * Math.max(0, sp.strike - l.strike);
      }
      required += n * sp.m * sp.strike;
    }
  }
  return { required, uncovered, lockedShares };
}

export function execute(
  account,
  {
    symbol,
    side,
    qty,
    price,
    fee = 0,
    note = "",
    date = new Date().toISOString(),
    source = "manual",
    instrument = "stock",
    multiplier = 100,
    iv = null,
  },
) {
  const option = instrument === "option";
  if (
    !(option ? OCC.test(symbol) : /^[A-Z0-9.^_-]{1,20}$/.test(symbol)) ||
    !["buy", "sell"].includes(side) ||
    ![qty, price, fee].every(Number.isFinite) ||
    qty <= 0 ||
    price < 0 ||
    (price === 0 && source !== "expiry") ||
    fee < 0 ||
    (option && (!Number.isFinite(multiplier) || multiplier <= 0))
  )
    throw Error(
      "Invalid order: enter positive quantity and price, and nonnegative fees.",
    );
  if (option && !Number.isInteger(qty)) throw Error("Option orders are whole contracts.");
  const trade = { id: globalThis.crypto.randomUUID(), symbol, side, qty, price, fee, note, date, source, ...(option ? { instrument, multiplier, ...(iv == null ? {} : { iv }) } : {}) };
  const before = book(account);
  const held = before.holdings[symbol]?.qty || 0;
  if (!option && side === "sell" && qty > held + 1e-8) throw Error("Cannot sell more shares than held.");
  const dq = side === "buy" ? qty : -qty;
  if (option && held && Math.sign(held) !== Math.sign(dq) && qty > Math.abs(held) + 1e-9)
    throw Error(`That would turn a ${held > 0 ? "long" : "short"} position into the opposite one. Close it first, then open the new one.`);
  const next = { ...account, trades: [...account.trades, trade] };
  const after = book(next);
  const req = requirements(after.holdings);
  if (req.uncovered.length)
    throw Error(`Short calls must be covered by 100 shares each or paired with a long call (a spread): ${req.uncovered.join(", ")} would be uncovered. Naked short calls aren't supported.`);
  const opening = side === "buy" || (option && held <= 0);
  if (opening && after.cash < req.required - 1e-8)
    throw Error(req.required > 0 ? `Insufficient paper cash: ${money2(after.cash)} left, but ${money2(req.required)} must be held against short puts and spreads.` : "Insufficient paper cash.");
  if (!opening && after.cash < -1e-8) throw Error("Insufficient cash for fees.");
  return next;
}
const money2 = (x) => "$" + x.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

// Expired options settle at intrinsic value against the underlying's close
// on expiry day (cash-settled here for simplicity, so an exercised call
// doesn't need cash for shares). `closeOn(underlying, date)` returns that close.
export function settleExpiries(account, closeOn, today = new Date().toISOString().slice(0, 10)) {
  let next = account;
  const b = book(account);
  for (const [sym, p] of Object.entries(b.holdings)) {
    if (p.instrument !== "option" || !p.qty || p.expiry >= today) continue;
    const s = closeOn(p.underlying, p.expiry);
    if (s == null) continue;
    const intrinsic = Math.max(0, (p.kind === "call" ? 1 : -1) * (s - p.strike));
    const last = next.trades.at(-1)?.date || "";
    const at = p.expiry + "T21:00:00Z";
    next = execute(next, {
      symbol: sym,
      side: p.qty > 0 ? "sell" : "buy",
      qty: Math.abs(p.qty),
      price: +intrinsic.toFixed(4),
      fee: 0,
      note: `Expired ${p.expiry}: settled at intrinsic value ${intrinsic.toFixed(2)} against ${p.underlying}'s close of ${s.toFixed(2)}${intrinsic > 0 ? " (in the money)" : " (worthless)"}`,
      date: last > at ? last : at,
      source: "expiry",
      instrument: "option",
      multiplier: p.multiplier,
    });
  }
  return next;
}

// Marks: stocks at the latest close, options at `optionMarks[symbol].price`
// (a chain mid or a model price, said so by `.source`); cost basis otherwise.
export function portfolio(account, assets, optionMarks = {}) {
  const b = book(account);
  let value = b.cash,
    unrealized = 0;
  const positions = Object.entries(b.holdings)
    .filter(([, p]) => Math.abs(p.qty) > 1e-8)
    .map(([symbol, p]) => {
      const m = p.instrument === "option" ? p.multiplier || 100 : 1;
      const mark = p.instrument === "option" ? optionMarks[symbol] || null : null;
      const price = p.instrument === "option" ? (mark?.price ?? null) : (assets[symbol]?.bars?.at(-1)?.close ?? null);
      const market = price === null ? null : price * p.qty * m;
      value += market ?? p.cost;
      unrealized += market === null ? 0 : market - p.cost;
      return {
        symbol,
        ...p,
        price,
        markSource: mark?.source || null,
        market,
        pnl: market === null ? null : market - p.cost,
      };
    });
  return {
    ...b,
    positions,
    value,
    unrealized,
    incomplete: positions.some((p) => p.price === null),
  };
}
export function validateBars(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100000)
    throw Error("Expected 1–100,000 price rows.");
  const seen = new Set();
  return rows
    .map((r) => {
      const date = String(r.date);
      const b = {
        date,
        open: +r.open,
        high: +r.high,
        low: +r.low,
        close: +r.close,
        volume: +(r.volume || 0),
      };
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        seen.has(date) ||
        ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
        Math.min(b.open, b.high, b.low, b.close) <= 0 ||
        b.low > Math.min(b.open, b.close) ||
        b.high < Math.max(b.open, b.close) ||
        b.volume < 0
      )
        throw Error(`Invalid or duplicate OHLCV row: ${date}`);
      seen.add(date);
      return b;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
export function parseCSV(text) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (quoted) throw Error("Unterminated quoted CSV cell");
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map((h) =>
    h
      .trim()
      .replace(/^\uFEFF/, "")
      .toLowerCase(),
  );
  return rows.map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, r[i]?.trim() ?? ""])),
  );
}
export function csv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (x) =>
    '"' +
    String(x ?? "")
      .replace(/^[=+@\-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  return [
    keys.map(esc).join(","),
    ...rows.map((r) => keys.map((k) => esc(r[k])).join(",")),
  ].join("\r\n");
}
export function normalizeAlpha(data) {
  return validateBars(
    Object.entries(data["Time Series (Daily)"] || {}).map(([date, r]) => ({
      date,
      open: r["1. open"],
      high: r["2. high"],
      low: r["3. low"],
      close: r["4. close"],
      volume: r["5. volume"],
    })),
  );
}
export function checkAlerts(alerts, assets) {
  return alerts.map((a) => {
    const price = assets[a.symbol]?.bars?.at(-1)?.close;
    return {
      ...a,
      triggered:
        a.triggered ||
        (price != null &&
          (a.direction === "above" ? price >= a.target : price <= a.target)),
    };
  });
}
// Workspace schema. v1 = 0.1 (then called Aperture); v2 adds data sources, first-run
// state, SEC and commodity data. Older workspaces are upgraded in place.
export const SCHEMA = 2;
export function migrate(s) {
  if (!s || typeof s !== "object") return s;
  const from = s.schema || 1;
  if (from > SCHEMA)
    throw Error("This workspace was saved by a newer version of Aperture. Update the app to open it.");
  if (from < 2) {
    s.sources ||= { prices: "twelve" };
    s.marketAssets ||= {};
    for (const k of ["macro", "datasets", "notes"]) s[k] ||= {};
    for (const k of ["screens", "alerts", "watchlist"]) s[k] ||= [];
    // 0.1 users who already have their own data skip the first-run screen.
    if (s.setupDone == null && Object.values(s.marketAssets).some((a) => a.origin !== "sample"))
      s.setupDone = true;
  }
  s.schema = SCHEMA;
  return s;
}
export function validateWorkspace(s) {
  if (
    !s ||
    !["sample", "market"].includes(s.mode) ||
    !s.notes ||
    typeof s.notes !== "object" ||
    !s.datasets ||
    typeof s.datasets !== "object" ||
    !s.macro ||
    typeof s.macro !== "object" ||
    !Array.isArray(s.screens)
  )
    throw Error("Incomplete workspace backup");
  for (const a of s.alerts || []) {
    if (
      !["sample", "market"].includes(a.mode) ||
      !["above", "below"].includes(a.direction) ||
      !Number.isFinite(a.target) ||
      a.target <= 0 ||
      !/^[A-Za-z0-9-]+$/.test(a.id) ||
      !/^[A-Z0-9.^_-]{1,20}$/.test(a.symbol)
    )
      throw Error("Invalid alert in backup");
  }

  if (
    !s ||
    s.version !== 1 ||
    !s.assets ||
    !Array.isArray(s.watchlist) ||
    !Array.isArray(s.alerts) ||
    !s.accounts ||
    !s.accounts.sample ||
    !s.accounts.market
  )
    throw Error("Not an Aperture v1 backup.");
  for (const [symbol, a] of Object.entries({
    ...s.assets,
    ...s.marketAssets,
  })) {
    if (!/^[A-Z0-9.^_-]{1,20}$/.test(symbol)) throw Error("Invalid symbol");
    a.bars = validateBars(a.bars);
    if (!["sample", "import", "alpha", "twelve"].includes(a.origin))
      throw Error("Invalid data origin");
  }
  for (const ac of Object.values(s.accounts)) {
    if (
      !Number.isFinite(ac.initial) ||
      ac.initial <= 0 ||
      !Array.isArray(ac.trades)
    )
      throw Error("Invalid account");
    let test = { initial: ac.initial, trades: [] };
    for (const t of ac.trades) test = execute(test, t);
  }
  return s;
}

// Historical paper equity uses only closes available on or before each date.
export function equityCurve(account, assets) {
  if (!account.trades.length) return [];
  const firstTrade = account.trades[0].date.slice(0, 10);
  const symbols = [...new Set(account.trades.map((t) => t.symbol))];
  const allDates = [
    ...new Set(
      symbols.flatMap((s) => assets[s]?.bars.map((b) => b.date) || []),
    ),
  ].sort();
  const baseline = allDates.filter((d) => d < firstTrade).at(-1);
  const dates = allDates.filter((d) => d >= firstTrade);
  const marks = {},
    pointers = Object.fromEntries(symbols.map((s) => [s, 0]));
  const curve = baseline ? [{ date: baseline, close: account.initial }] : [];
  for (const date of dates) {
    for (const s of symbols) {
      const bars = assets[s]?.bars || [];
      while (pointers[s] < bars.length && bars[pointers[s]].date <= date)
        marks[s] = bars[pointers[s]++].close;
    }
    const b = book({
      ...account,
      trades: account.trades.filter((t) => t.date.slice(0, 10) <= date),
    });
    let value = b.cash;
    for (const [s, p] of Object.entries(b.holdings))
      value += marks[s] == null ? p.cost : p.qty * marks[s];
    curve.push({ date, close: value });
  }
  return curve;
}
