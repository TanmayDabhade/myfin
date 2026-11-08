// Keeping the watchlist current in the background: when the US market is
// open, which new SEC filings arrived since the last check and what they
// make stale, and when a stock's risk analytics are due for a rerun.

const nyParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Regular US session: Monday to Friday, 9:30 to 16:00 New York time.
// Exchange holidays are not modeled; on those days prices simply don't move.
export function usMarketOpen(ms = Date.now()) {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const minutes = +p.hour * 60 + +p.minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

// Filings in `next` that were not in `prev`. A first load (no `prev`) is not
// "new": everything would look new.
export function newFilings(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return [];
  const seen = new Set(prev.map((f) => f.accession));
  return next.filter((f) => f.accession && !seen.has(f.accession));
}

const REPORTS = ["10-K", "10-Q", "20-F", "40-F", "6-K"];
// What a batch of new filings makes stale, and a one-line summary.
export function refreshPlan(symbol, filings) {
  const forms = [...new Set(filings.map((f) => f.form))];
  const statements = forms.some((f) => REPORTS.includes(f));
  const events = forms.includes("8-K");
  return {
    statements, // financial statements, valuation inputs, revenue history
    news: statements || events, // news, earnings and metrics usually move with them
    summary: forms.length ? `${symbol} filed ${forms.join(", ")}${statements ? " · financials updated" : ""}` : "",
  };
}

// Whether a stock's analytics should be recomputed. Same inputs: never.
// A new trading day: always. Otherwise (live prices moving within a day)
// at most every `minAge` seconds.
export function quantDue(prev, req, now = Date.now() / 1000, minAge = 900) {
  if (!req?.closes?.length) return false;
  if (!prev?.data) return true;
  if (prev.key === req.key) return false;
  if (prev.lastDate !== req.closes.at(-1)[0]) return true;
  return now - (prev.at || 0) >= minAge;
}
