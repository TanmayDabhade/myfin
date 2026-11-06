import { validateBars } from "./engine.js";

// Data providers the desktop app can pull from. Keys are free to create.
export const providers = {
  twelve: {
    name: "Twelve Data",
    provides: "Daily prices, about 5 years of history",
    limits: "Free plan: 800 requests/day, 8/minute",
    keyURL: "https://twelvedata.com/register",
  },
  alpha: {
    name: "Alpha Vantage",
    provides: "Company fundamentals, statements, news, earnings; prices",
    limits: "Free plan: 25 requests/day, about 100 days of prices",
    keyURL: "https://www.alphavantage.co/support/#api-key",
  },
  fred: {
    name: "FRED",
    provides: "US economic series (CPI, unemployment, rates, GDP)",
    limits: "Free, generous limits",
    keyURL: "https://fredaccount.stlouisfed.org/apikeys",
  },
  sec: {
    name: "SEC EDGAR",
    provides: "Filing list and revenue history need nothing. Add your contact email to also scan 10-K text for suppliers and customers.",
    limits: "No key. SEC asks automated tools for a contact email; it is sent only to sec.gov",
    keyURL: "https://www.sec.gov/os/accessing-edgar-data",
    label: "About SEC access",
    email: true,
  },
};

export const priceProviders = ["twelve", "alpha"];

// Pick the preferred price provider, falling back to whichever has a key.
export function priceSource(preferred, status) {
  const has = (p) => !!status?.[p]?.configured;
  if (preferred && has(preferred)) return preferred;
  return priceProviders.find(has) || null;
}

export function normalizeTwelve(data) {
  if (!Array.isArray(data?.values)) throw Error("Twelve Data returned no prices.");
  return validateBars(
    data.values
      .map((v) => {
        const [open, high, low, close] = [v.open, v.high, v.low, v.close].map(Number);
        // Providers occasionally round high/low inside the open-close range.
        return {
          date: String(v.datetime).slice(0, 10),
          open,
          high: Math.max(high, open, close),
          low: Math.min(low, open, close),
          close,
          volume: v.volume ?? 0,
        };
      })
      .reverse(),
  );
}

// Is a downloaded dataset older than maxAge seconds?
export function stale(dataset, maxAge, now = Date.now() / 1000) {
  return !dataset?.fetchedAt || now - dataset.fetchedAt > maxAge;
}
