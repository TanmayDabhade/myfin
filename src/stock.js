// The stock page: one loaded stock, every view of it. Pure helpers for the
// panel grid, the time-and-sales tape, the ownership-changes feed and the
// valuation inputs taken from the company's own filings.

// Functions on the loaded stock, in the order they appear. Codes follow
// terminal mnemonics where one exists.
export const VIEWS = [
  { code: "DES", label: "Description" },
  { code: "GP", label: "Chart" },
  { code: "FA", label: "Financials" },
  { code: "CN", label: "News" },
  { code: "HDS", label: "Holders" },
  { code: "OWN", label: "Ownership changes" },
  { code: "SPLC", label: "Suppliers & customers" },
  { code: "DCF", label: "Valuation" },
  { code: "RSK", label: "Risk analytics" },
  { code: "TAS", label: "Time & sales" },
  { code: "CF", label: "Filings" },
];
export const VIEW_CODES = new Set(VIEWS.map((v) => v.code));
export const viewLabel = (code) => VIEWS.find((v) => v.code === code)?.label || "";

// Most recent first, no duplicates, at most `max`.
export function pushRecent(list, ticker, max = 8) {
  const t = String(ticker || "").trim().toUpperCase();
  if (!t) return [...(list || [])];
  return [t, ...(list || []).filter((x) => x !== t)].slice(0, max);
}

// ---- Time and sales ---------------------------------------------------------
// Prints are { price, size, time } oldest first. Each print is classed by the
// tick rule: above the previous price is buyer-initiated, below is
// seller-initiated, unchanged keeps the previous side. This is an estimate;
// the feed carries no bid/ask, so it cannot say who crossed the spread.
export function tapeStats(prints) {
  const rows = [];
  let prev = null,
    side = "";
  let volume = 0,
    notional = 0,
    buy = 0,
    sell = 0,
    high = null,
    low = null,
    largest = null;
  for (const p of prints || []) {
    if (!(p?.price > 0) || !Number.isFinite(p.time)) continue;
    const size = Number.isFinite(p.size) && p.size > 0 ? p.size : 0;
    const tick = prev == null ? 0 : Math.sign(p.price - prev);
    if (tick > 0) side = "buy";
    else if (tick < 0) side = "sell";
    rows.push({ ...p, size, tick, side });
    volume += size;
    notional += size * p.price;
    if (side === "buy") buy += size;
    if (side === "sell") sell += size;
    high = high == null ? p.price : Math.max(high, p.price);
    low = low == null ? p.price : Math.min(low, p.price);
    if (!largest || size > largest.size) largest = rows.at(-1);
    prev = p.price;
  }
  return {
    rows,
    count: rows.length,
    volume,
    vwap: volume > 0 ? notional / volume : null,
    buyVolume: buy,
    sellVolume: sell,
    buyShare: buy + sell > 0 ? buy / (buy + sell) : null,
    high,
    low,
    first: rows[0] || null,
    last: rows.at(-1) || null,
    largest: largest?.size > 0 ? largest : null,
  };
}

// ---- Ownership changes ------------------------------------------------------
const STATUS_ACTION = { new: "New position", added: "Added", reduced: "Reduced", exited: "Sold out" };

// One dated list of disclosed ownership changes, newest first:
// - 13F: managers that opened, added, reduced or closed a position last
//   quarter (the largest `top13F` by estimated dollar change, so thousands of
//   small managers don't bury everything else);
// - Schedules 13D/G: each 5%+ filer's latest filing and its change;
// - Forms 4: insiders' open-market purchases (P) and sales (S).
// `holders` are compareHolders() rows, `big` bigHolders() rows and
// `insiders` the insiderSummary() log.
export function ownershipFeed({ holders = [], big = [], insiders = [] } = {}, { top13F = 25, limit = 100 } = {}) {
  const items = [];
  const f13 = [];
  for (const h of holders) {
    if (!STATUS_ACTION[h.status] || h.change == null || h.change === 0) continue;
    const price = h.price ?? (h.prevShares > 0 ? h.prevValue / h.prevShares : null);
    f13.push({
      date: h.filed || "",
      source: "13F",
      who: h.name,
      role: "Institution",
      action: STATUS_ACTION[h.status],
      shares: h.change,
      after: h.shares,
      value: price != null ? h.change * price : null,
      cik: h.cik,
      accession: h.accession,
      url: null,
    });
  }
  f13.sort((a, b) => Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
  items.push(...f13.slice(0, top13F));
  for (const b of big) {
    items.push({
      date: b.filed || "",
      source: b.activist ? "13D" : "13G",
      who: b.name,
      role: b.activist ? "5%+ owner, activist" : "5%+ owner",
      action: b.below5 ? "Fell below 5%" : b.change == null ? (b.filings > 1 ? "Refiled" : "Disclosed stake") : b.change > 0 ? "Increased stake" : b.change < 0 ? "Cut stake" : "Refiled",
      shares: b.change,
      after: b.shares,
      percent: b.percent,
      value: null,
      url: b.url,
    });
  }
  for (const x of insiders) {
    if (x.derivative || (x.code !== "P" && x.code !== "S")) continue;
    items.push({
      date: x.date || x.filed || "",
      source: "Form " + (x.form || "4"),
      who: x.owner,
      role: x.role,
      action: x.code === "P" ? "Bought" : x.plan ? "Sold (10b5-1 plan)" : "Sold",
      shares: x.shares == null ? null : x.code === "S" ? -x.shares : x.shares,
      after: x.after,
      price: x.price,
      value: x.value == null ? null : x.code === "S" ? -x.value : x.value,
      url: x.url,
    });
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0));
  return items.slice(0, limit);
}

// ---- Valuation inputs from XBRL company facts -------------------------------
const ANNUAL = ["10-K", "20-F", "40-F"];
// Full-year values by fiscal period end, latest filing per period.
export function annualSeries(concept, unit = "USD") {
  const byEnd = new Map();
  for (const x of concept?.units?.[unit] || []) {
    if (!ANNUAL.includes(x.form) || !x.start || !x.end || !Number.isFinite(x.val)) continue;
    if ((Date.parse(x.end) - Date.parse(x.start)) / 864e5 < 300) continue;
    const old = byEnd.get(x.end);
    if (!old || x.filed > old.filed) byEnd.set(x.end, x);
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end)).map((x) => ({ end: x.end, val: x.val, filed: x.filed, accn: x.accn }));
}
// The latest point-in-time value (balance-sheet items have no start date).
export function latestInstant(concept, unit = "USD") {
  let best = null;
  for (const x of concept?.units?.[unit] || []) {
    if (x.start || !x.end || !Number.isFinite(x.val)) continue;
    if (!best || x.end > best.end || (x.end === best.end && x.filed > best.filed)) best = x;
  }
  return best ? { end: best.end, val: best.val, filed: best.filed } : null;
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const M = 1e6;

// Starting assumptions for the five-year DCF, in millions, with where each
// came from. `facts` holds raw XBRL concept responses keyed by tag, plus
// `sharesOut` (latest cover-page shares) and `revenue` (revenueHistory rows).
// Anything missing is listed so the page can say so rather than guess.
export function valuationInputs(facts = {}) {
  const sources = {},
    missing = [];
  const ocf = annualSeries(facts.NetCashProvidedByUsedInOperatingActivities).at(-1);
  const capexRows = annualSeries(facts.PaymentsToAcquirePropertyPlantAndEquipment);
  let fcf = null;
  if (ocf) {
    const capex = capexRows.find((x) => x.end === ocf.end);
    fcf = (ocf.val - (capex?.val ?? 0)) / M;
    sources.fcf = `Fiscal year ending ${ocf.end}: operating cash flow${capex ? " − capital spending" : " (no capital spending reported)"}`;
  } else missing.push("free cash flow");

  let growth = 0.05;
  const rev = (facts.revenue || []).filter((r) => r.revenue > 0);
  if (rev.length >= 2) {
    const n = Math.min(3, rev.length - 1);
    const a = rev.at(-1 - n).revenue,
      b = rev.at(-1).revenue;
    growth = clamp((b / a) ** (1 / n) - 1, -0.05, 0.15);
    sources.growth = `Revenue growth over the last ${n} fiscal year${n === 1 ? "" : "s"}, limited to −5%…15%`;
  } else sources.growth = "Default; no revenue history loaded";

  const debtTotal = latestInstant(facts.LongTermDebt);
  const debtParts = [latestInstant(facts.LongTermDebtNoncurrent), latestInstant(facts.LongTermDebtCurrent)].filter(Boolean);
  const shortDebt = latestInstant(facts.ShortTermBorrowings);
  const cash = latestInstant(facts.CashAndCashEquivalentsAtCarryingValue);
  const longDebt = debtTotal ? debtTotal.val : debtParts.length ? debtParts.reduce((t, x) => t + x.val, 0) : null;
  const debt = longDebt == null && !shortDebt ? null : (longDebt || 0) + (shortDebt?.val || 0);
  if (debt == null) missing.push("debt");
  if (!cash) missing.push("cash");
  const netDebt = ((debt || 0) - (cash?.val || 0)) / M;
  const asOf = [debtTotal, ...debtParts, shortDebt, cash].filter(Boolean).map((x) => x.end).sort().at(-1);
  sources.netDebt = debt == null && !cash ? "Not reported; assumed zero" : `Debt − cash as of ${asOf}${debt == null ? " (no debt reported)" : ""}`;

  let shares = null;
  if (facts.sharesOut?.shares > 0) {
    shares = facts.sharesOut.shares / M;
    sources.shares = `Shares outstanding on the cover page, ${facts.sharesOut.date}`;
  } else {
    const d = annualSeries(facts.WeightedAverageNumberOfDilutedSharesOutstanding, "shares").at(-1);
    if (d) {
      shares = d.val / M;
      sources.shares = `Diluted weighted-average shares, fiscal year ending ${d.end}`;
    } else missing.push("shares");
  }
  sources.discount = "Default assumption";
  sources.terminal = "Default assumption";
  // Raw figures the key statistics reuse (market cap, P/E, margin).
  const basis = { sharesOut: facts.sharesOut?.shares > 0 ? facts.sharesOut : null, netIncome: annualSeries(facts.NetIncomeLoss).at(-1) || null, revenue: rev.at(-1) || null };
  return { inputs: { fcf, growth, discount: 0.09, terminal: 0.025, netDebt, shares }, sources, missing, basis };
}

// ---- Key statistics -----------------------------------------------------------
const val = (x) => {
  if (x == null || x === "" || x === "None" || x === "-") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const DAY_MS = 864e5;
// P/E, margin, revenue growth, market cap, 52-week range and dividend yield.
// Each is calculated from the live price, the company's statements and SEC
// shares outstanding when possible, then falls back to a provider's figure
// (Finnhub metrics, then the Alpha Vantage overview). Every value says
// where it came from.
//   overview: Alpha Vantage OVERVIEW; metric: Finnhub metric.metric;
//   income: Alpha Vantage INCOME_STATEMENT (annualReports/quarterlyReports,
//   newest first); basis: valuationInputs().basis; price; bars: daily bars.
export function keyStats({ overview = {}, metric = {}, income = null, basis = {}, price = null, bars = [] } = {}) {
  const q = income?.quarterlyReports || [],
    a = income?.annualReports || [];
  const sum4 = (k) => (q.length >= 4 && q.slice(0, 4).every((r) => val(r[k]) != null) ? q.slice(0, 4).reduce((t, r) => t + val(r[k]), 0) : null);
  const out = {};
  const pick = (name, ...options) => {
    const hit = options.find((o) => o && o.value != null && Number.isFinite(o.value));
    out[name] = hit ? { value: hit.value, source: hit.source, note: hit.note || "" } : { value: null, source: "", note: options.find((o) => o?.note)?.note || "" };
  };
  const shares = basis.sharesOut?.shares || val(overview.SharesOutstanding);
  const sharesSource = basis.sharesOut ? `SEC cover page, ${basis.sharesOut.date}` : "Alpha Vantage";
  const fh = (k, scale = 1) => (val(metric[k]) == null ? null : { value: val(metric[k]) * scale, source: "Finnhub" });
  const av = (k) => (val(overview[k]) == null ? null : { value: val(overview[k]), source: "Alpha Vantage" });

  pick("marketCap", price > 0 && shares > 0 && { value: price * shares, source: `Price × shares outstanding (${sharesSource})` }, av("MarketCapitalization"), fh("marketCapitalization", 1e6));

  // Earnings: trailing four quarters, else the latest fiscal year.
  const ttmIncome = sum4("netIncome");
  const earnings =
    ttmIncome != null
      ? { value: ttmIncome, label: `last four quarters to ${q[0].fiscalDateEnding}` }
      : basis.netIncome
        ? { value: basis.netIncome.val, label: `fiscal year ending ${basis.netIncome.end}` }
        : val(a[0]?.netIncome) != null
          ? { value: val(a[0].netIncome), label: `fiscal year ending ${a[0].fiscalDateEnding}` }
          : null;
  const loss = earnings && earnings.value <= 0;
  pick(
    "pe",
    price > 0 && shares > 0 && earnings && !loss && { value: (price * shares) / earnings.value, source: `Price ÷ earnings per share; net income ${earnings.label}` },
    loss ? { note: "Not meaningful: the company lost money" } : null,
    fh("peTTM") || fh("peBasicExclExtraTTM"),
    av("PERatio"),
  );

  const ttmRevenue = sum4("totalRevenue");
  const annualMargin = basis.netIncome && basis.revenue && basis.netIncome.end === basis.revenue.end && basis.revenue.revenue > 0 ? basis.netIncome.val / basis.revenue.revenue : null;
  pick(
    "margin",
    ttmIncome != null && ttmRevenue > 0 && { value: ttmIncome / ttmRevenue, source: `Net income ÷ revenue, last four quarters to ${q[0].fiscalDateEnding}` },
    annualMargin != null && { value: annualMargin, source: `Net income ÷ revenue, fiscal year ending ${basis.revenue.end} (SEC)` },
    val(a[0]?.netIncome) != null && val(a[0]?.totalRevenue) > 0 && { value: val(a[0].netIncome) / val(a[0].totalRevenue), source: `Net income ÷ revenue, fiscal year ending ${a[0].fiscalDateEnding}` },
    fh("netProfitMarginTTM", 0.01),
    av("ProfitMargin"),
  );

  // Latest quarter against the same quarter a year earlier.
  let quarterly = null;
  if (q.length && val(q[0].totalRevenue) != null) {
    const t0 = Date.parse(q[0].fiscalDateEnding);
    const prior = q.find((r) => {
      const gap = (t0 - Date.parse(r.fiscalDateEnding)) / DAY_MS;
      return gap > 330 && gap < 400 && val(r.totalRevenue) > 0;
    });
    if (prior) quarterly = { value: val(q[0].totalRevenue) / val(prior.totalRevenue) - 1, source: `Quarter ending ${q[0].fiscalDateEnding} vs ${prior.fiscalDateEnding}` };
  }
  pick(
    "growth",
    quarterly,
    basis.revenue?.growth != null && { value: basis.revenue.growth, source: `Fiscal year ending ${basis.revenue.end} vs the year before (SEC)` },
    fh("revenueGrowthQuarterlyYoy", 0.01),
    av("QuarterlyRevenueGrowthYOY"),
  );

  // 52-week range from daily bars when a year of them is loaded.
  const last = bars.at(-1);
  const year = last ? bars.filter((b) => Date.parse(last.date) - Date.parse(b.date) <= 365 * DAY_MS) : [];
  const covered = year.length > 200;
  pick("high52", covered && { value: Math.max(...year.map((b) => b.high)), source: "Daily prices, last 52 weeks" }, fh("52WeekHigh"), av("52WeekHigh"));
  pick("low52", covered && { value: Math.min(...year.map((b) => b.low)), source: "Daily prices, last 52 weeks" }, fh("52WeekLow"), av("52WeekLow"));
  pick("dividendYield", fh("dividendYieldIndicatedAnnual", 0.01) || fh("currentDividendYieldTTM", 0.01), av("DividendYield"));
  return out;
}

// ---- Past trades ------------------------------------------------------------
const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
// Alpaca historical trades (newest first) -> tape prints of the most recent
// session in the response, oldest first.
export function pastPrints(data) {
  const prints = (data?.trades || [])
    .map((t) => ({ price: val(t.p), size: val(t.s) ?? 0, time: Date.parse(t.t), conditions: Array.isArray(t.c) ? t.c.map(String).filter((c) => c.trim()) : [] }))
    .filter((p) => p.price > 0 && Number.isFinite(p.time));
  if (!prints.length) return { date: null, prints: [] };
  const date = nyDay.format(new Date(Math.max(...prints.map((p) => p.time))));
  return { date, prints: prints.filter((p) => nyDay.format(new Date(p.time)) === date).sort((x, y) => x.time - y.time) };
}
// Twelve Data 1-minute bars -> the most recent session's minutes, oldest
// first, with session totals. Volume-weighted price uses each minute's
// typical price (high + low + close) / 3.
export function minuteSession(data) {
  const rows = (data?.values || [])
    .map((v) => ({ time: v.datetime, open: val(v.open), high: val(v.high), low: val(v.low), close: val(v.close), volume: val(v.volume) ?? 0 }))
    .filter((r) => r.close != null && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(r.time || ""));
  if (!rows.length) return { date: null, rows: [], volume: 0, vwap: null, high: null, low: null };
  const date = rows.map((r) => r.time.slice(0, 10)).sort().at(-1);
  const day = rows.filter((r) => r.time.startsWith(date)).sort((x, y) => x.time.localeCompare(y.time));
  const volume = day.reduce((t, r) => t + r.volume, 0);
  const pv = day.reduce((t, r) => t + r.volume * ((r.high + r.low + r.close) / 3), 0);
  return { date, rows: day, volume, vwap: volume > 0 ? pv / volume : null, high: Math.max(...day.map((r) => r.high)), low: Math.min(...day.map((r) => r.low)), open: day[0].open, close: day.at(-1).close };
}

