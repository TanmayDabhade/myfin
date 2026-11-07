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
  return { inputs: { fcf, growth, discount: 0.09, terminal: 0.025, netDebt, shares }, sources, missing };
}
