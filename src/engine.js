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
export function book(account) {
  let cash = account.initial,
    realized = 0;
  const holdings = {};
  for (const t of account.trades) {
    let p = holdings[t.symbol] || { qty: 0, cost: 0, realized: 0 };
    if (t.side === "buy") {
      cash -= t.qty * t.price + t.fee;
      p.cost += t.qty * t.price + t.fee;
      p.qty += t.qty;
    } else {
      let basis = p.qty ? (p.cost / p.qty) * t.qty : 0;
      let gain = t.qty * t.price - t.fee - basis;
      cash += t.qty * t.price - t.fee;
      p.cost -= basis;
      p.qty -= t.qty;
      p.realized += gain;
      realized += gain;
    }
    holdings[t.symbol] = p;
  }
  return { cash, realized, holdings };
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
  },
) {
  if (
    !/^[A-Z0-9.^_-]{1,20}$/.test(symbol) ||
    !["buy", "sell"].includes(side) ||
    ![qty, price, fee].every(Number.isFinite) ||
    qty <= 0 ||
    price <= 0 ||
    fee < 0
  )
    throw Error(
      "Invalid order: enter positive quantity and price, and nonnegative fees.",
    );
  const b = book(account);
  if (side === "buy" && qty * price + fee > b.cash + 1e-8)
    throw Error("Insufficient paper cash.");
  if (side === "sell" && qty > (b.holdings[symbol]?.qty || 0) + 1e-8)
    throw Error("Cannot sell more shares than held.");
  if (side === "sell" && b.cash + qty * price - fee < 0)
    throw Error("Insufficient cash for fees.");
  return {
    ...account,
    trades: [
      ...account.trades,
      {
        id: globalThis.crypto.randomUUID(),
        symbol,
        side,
        qty,
        price,
        fee,
        note,
        date,
        source,
      },
    ],
  };
}
export function portfolio(account, assets) {
  const b = book(account);
  let value = b.cash,
    unrealized = 0;
  const positions = Object.entries(b.holdings)
    .filter(([, p]) => p.qty > 1e-8)
    .map(([symbol, p]) => {
      const price = assets[symbol]?.bars?.at(-1)?.close ?? null;
      const market = price === null ? null : price * p.qty;
      value += market ?? p.cost;
      unrealized += market === null ? 0 : market - p.cost;
      return {
        symbol,
        ...p,
        price,
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
    throw Error("Not a Market Lens v1 backup.");
  for (const [symbol, a] of Object.entries({
    ...s.assets,
    ...s.marketAssets,
  })) {
    if (!/^[A-Z0-9.^_-]{1,20}$/.test(symbol)) throw Error("Invalid symbol");
    a.bars = validateBars(a.bars);
    if (!["sample", "import", "alpha"].includes(a.origin))
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
