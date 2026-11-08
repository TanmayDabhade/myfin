// Captures the product tour for the website: drives the real UI in a browser
// against a stand-in backend with sample data, and saves a screenshot per
// step plus where the cursor clicks next. Output: site/demo/*.jpg and
// site/demo/steps.json. Run: node scripts/capture-demo.cjs
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const quantStandin = require("./quant-standin.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "site", "demo");
const VIEW = { width: 1440, height: 900 };

// ---- Sample data -------------------------------------------------------------
// Everything below runs inside the page. Names of funds and insiders are made
// up; prices, holdings and returns are synthetic. Only company names, sectors
// and the relationship graph (shipped with the app) are real.
function demoBackend(constituents) {
  const store = (k, v) => (v === undefined ? JSON.parse(localStorage.getItem(k) || "null") : localStorage.setItem(k, JSON.stringify(v)));
  // Deterministic pseudo-random numbers per seed string.
  const rng = (seed) => {
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  };
  const BASE = { AAPL: 342, MSFT: 518, NVDA: 206, SPY: 682, GLD: 371, AMZN: 247, GOOGL: 284, META: 712, TSLA: 412, JPM: 301 };
  const NAMES = { AAPL: "Apple Inc.", MSFT: "Microsoft Corporation", NVDA: "NVIDIA Corporation", SPY: "SPDR S&P 500 ETF Trust", GLD: "SPDR Gold Shares", AMZN: "Amazon.com, Inc.", GOOGL: "Alphabet Inc.", META: "Meta Platforms, Inc.", TSLA: "Tesla, Inc.", JPM: "JPMorgan Chase & Co." };
  const day = (i) => new Date(Date.UTC(2026, 10, 6) - i * 864e5);
  function bars(symbol) {
    const r = rng(symbol);
    const out = [];
    let p = BASE[symbol] || 50 + r() * 200;
    // Walk backwards from today's price over weekdays.
    for (let i = 0, n = 0; n < 320; i++) {
      const d = day(i);
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const drift = (r() - 0.485) * 0.024;
      const close = p;
      const open = close / (1 + (r() - 0.5) * 0.012);
      const high = Math.max(open, close) * (1 + r() * 0.008);
      const low = Math.min(open, close) * (1 - r() * 0.008);
      out.push({ datetime: d.toISOString().slice(0, 10), open: open.toFixed(2), high: high.toFixed(2), low: low.toFixed(2), close: close.toFixed(2), volume: String(Math.round(2e7 + r() * 6e7)) });
      p = close / (1 + drift);
      n++;
    }
    return out;
  }
  const wrap = (data, provider) => ({ data, fetchedAt: Date.now() / 1000, cached: false, provider });
  const MANAGERS = ["Harborline Index Funds", "Northwind Capital Management", "Granite Peak Advisors", "Meridian Asset Management", "Tidewater Partners", "Blue Lantern Capital", "Millbrook Investment Co", "Cedar Ridge Wealth", "Lakeshore Teachers Pension", "Sablefish Partners", "Copperline Global", "Ironbridge Advisors", "Saltmarsh Capital", "Juniper Hill Investors", "Redwood Arch Partners", "Fairhaven Trust Company", "Kestrel Point Capital", "Bayview Quant Strategies"];
  function holders(ticker) {
    const r = rng("h" + ticker);
    const price = BASE[ticker] || 100;
    const rows = [];
    MANAGERS.forEach((name, i) => {
      const cik = 1000 + i;
      const size = Math.round(1.4e9 / (i + 1) ** 1.35);
      const before = i === 4 ? 0 : Math.round(size * (1 + (r() - 0.5) * 0.3));
      const now = i === 9 ? 0 : size;
      const portfolio = Math.round((5 + r() * 60) * 1e9 * (i < 3 ? 40 : 1));
      if (now) rows.push({ period: "2026-06-30", cik, putcall: 0, value: now * price * 0.93, shares: now, prn: false, discretion: "SOLE", sole: now, shared: 0, none: 0, rank: 1 + Math.floor(r() * 12), name: name.toUpperCase(), city: ["Boston", "New York", "San Francisco", "Chicago", "Valley Forge"][i % 5], state: ["MA", "NY", "CA", "IL", "PA"][i % 5], portfolio, positions: 120 + Math.floor(r() * 2000), accession: `0001${cik}-26-000123`, filed: "2026-08-14" });
      if (before) rows.push({ period: "2026-03-31", cik, putcall: 0, value: before * price * 0.85, shares: before, prn: false, discretion: "SOLE", sole: before, shared: 0, none: 0, rank: 2, name: name.toUpperCase(), city: "Boston", state: "MA", portfolio, positions: 300, accession: `0001${cik}-26-000045`, filed: "2026-05-15" });
    });
    rows.push({ period: "2026-06-30", cik: 1002, putcall: 1, value: 4.1e9, shares: 1.2e7, prn: false, name: "GRANITE PEAK ADVISORS", city: "Chicago", state: "IL", portfolio: 9e11, positions: 900, accession: "a", filed: "2026-08-14" });
    return {
      period: "2026-06-30",
      prior: "2026-03-31",
      quarters: [{ period: "2026-06-30", filers: 10940 }, { period: "2026-03-31", filers: 10812 }],
      securities: [{ cusip: "037833100", issuer: (NAMES[ticker] || ticker).toUpperCase(), class: "COM", holders: 5312, value: 3.2e12, source: "SEC 13(f) securities list" }],
      related: [],
      included: ["037833100"],
      rows,
      history: [
        { period: "2026-03-31", holders: 5201, shares: 9.7e9, value: 2.8e12, putHolders: 812, putShares: 1.1e8, callHolders: 1004, callShares: 1.6e8 },
        { period: "2026-06-30", holders: 5312, shares: 9.9e9, value: 3.2e12, putHolders: 790, putShares: 1.0e8, callHolders: 1051, callShares: 1.7e8 },
      ],
      tenure: Object.fromEntries(MANAGERS.map((_, i) => [1000 + i, { quarters: 8 - (i % 6), since: "2024-09-30" }])),
      reported: [1009],
      ticker,
    };
  }
  const form4 = (name, title, code, shares, price, date, after, plan) =>
    `<ownershipDocument><documentType>4</documentType><issuer><issuerCik>0000320193</issuerCik><issuerName>Issuer</issuerName><issuerTradingSymbol>X</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerCik>${shares}</rptOwnerCik><rptOwnerName>${name}</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>true</isOfficer><officerTitle>${title}</officerTitle></reportingOwnerRelationship></reportingOwner><aff10b5One>${plan}</aff10b5One><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>${date}</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${code === "P" ? "A" : "D"}</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>${after}</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;
  const INSIDERS = [
    ["Dana Whitfield", "Chief Financial Officer", "S", 48500, 338.2, "2026-11-03", 210000, true],
    ["Marcus Oyelaran", "SVP, Operations", "S", 21000, 336.9, "2026-10-28", 96000, true],
    ["Priya Raman", "Director", "P", 3000, 331.4, "2026-10-21", 12000, false],
    ["Elena Sorvino", "General Counsel", "S", 12400, 340.1, "2026-10-15", 61000, false],
  ];
  const schedule13g = (name, shares, pct) =>
    `<edgarSubmission><headerData><submissionType>SCHEDULE 13G/A</submissionType><filerInfo><filer><filerCredentials><cik>0000102909</cik></filerCredentials></filer></filerInfo></headerData><formData><coverPageHeader><eventDateRequiresFilingThisStatement>09/30/2026</eventDateRequiresFilingThisStatement><issuerInfo><issuerCik>0000320193</issuerCik><issuerName>Issuer</issuerName><issuerCusips><issuerCusipNumber>037833100</issuerCusipNumber></issuerCusips></issuerInfo></coverPageHeader><coverPageHeaderReportingPersonDetails><reportingPersonName>${name}</reportingPersonName><reportingPersonBeneficiallyOwnedNumberOfShares><soleVotingPower>${Math.round(shares * 0.1)}</soleVotingPower><sharedVotingPower>0</sharedVotingPower><soleDispositivePower>${shares}</soleDispositivePower><sharedDispositivePower>0</sharedDispositivePower></reportingPersonBeneficiallyOwnedNumberOfShares><reportingPersonBeneficiallyOwnedAggregateNumberOfShares>${shares}</reportingPersonBeneficiallyOwnedAggregateNumberOfShares><classPercent>${pct}</classPercent><typeOfReportingPerson>IA</typeOfReportingPerson></coverPageHeaderReportingPersonDetails></formData></edgarSubmission>`;
  function marketSnapshot() {
    const big = { NVDA: 5.0e12, AAPL: 5.05e12, MSFT: 3.85e12, GOOGL: 2.0e12, GOOG: 1.45e12, AMZN: 2.6e12, META: 1.8e12, AVGO: 1.6e12, TSLA: 1.35e12, "BRK.B": 1.05e12, LLY: 0.9e12, JPM: 0.83e12, WMT: 0.82e12, V: 0.66e12, ORCL: 0.62e12, MA: 0.52e12, XOM: 0.48e12, NFLX: 0.5e12, COST: 0.41e12, JNJ: 0.45e12, PLTR: 0.43e12, HD: 0.38e12, ABBV: 0.4e12, BAC: 0.39e12, PG: 0.35e12, AMD: 0.4e12, UNH: 0.3e12, CVX: 0.3e12, KO: 0.3e12, GE: 0.3e12, CSCO: 0.29e12, IBM: 0.28e12, CRM: 0.24e12, WFC: 0.26e12, MS: 0.24e12 };
    const bias = { "Information Technology": 0.006, "Communication Services": 0.003, Energy: -0.008, Utilities: -0.004, "Health Care": -0.002, Financials: 0.002 };
    const tiles = constituents.map((m) => {
      const r = rng("m" + m.symbol);
      const z = () => (r() + r() + r() - 1.5) / 1.5;
      const d1 = (bias[m.sector] || 0) + z() * 0.018;
      const price = BASE[m.symbol] || Math.round((20 + r() * 400) * 100) / 100;
      const cap = big[m.symbol] || Math.exp(23.2 + z() * 1.1);
      return { symbol: m.symbol, name: m.name, sector: m.sector, industry: m.industry, price, date: "2026-11-06", returns: { d1, w1: d1 * 1.6 + z() * 0.02, m1: z() * 0.06 + (bias[m.sector] || 0) * 6, m3: z() * 0.12, ytd: z() * 0.2 + 0.1, y1: z() * 0.3 + 0.12 }, cap, shares_date: "2026-10-20" };
    });
    return { source: "alpaca", built: Math.floor(Date.now() / 1000), date: "2026-11-06", complete: true, members: tiles.length, tiles };
  }
  const handlers = {
    quant_status: (a) => window.__quantStandin.status(a),
    quant_analyze: (a) => window.__quantStandin.analyze(a),
    quant_choose: () => null,
    quant_forget: (a) => window.__quantStandin.status(a),
    load_state: () => store("native-state"),
    save_state: ({ state }) => store("native-state", state),
    key_status: () => {
      const k = store("native-keys") || {};
      return Object.fromEntries(["alpha", "twelve", "fred", "sec", "ais", "finnhub", "alpaca", "alpacasecret"].map((p) => [p, { configured: !!k[p], source: k[p] ? "saved" : "none" }]));
    },
    set_keys: ({ keys }) => {
      const k = store("native-keys") || {};
      for (const [p, v] of Object.entries(keys)) if (v) k[p] = v;
      store("native-keys", k);
      return handlers.key_status();
    },
    fetch_data: ({ provider, kind, symbol }) => {
      const name = NAMES[symbol] || symbol;
      if (provider === "twelve" && kind === "TIME_SERIES") return wrap({ status: "ok", values: bars(symbol) }, provider);
      if (provider === "twelve") return wrap({ status: "ok", values: [] }, provider);
      if (provider === "fred") return wrap({ observations: Array.from({ length: 24 }, (_, i) => ({ date: `20${26 - Math.floor(i / 12)}-${String(12 - (i % 12)).padStart(2, "0")}-01`, value: (4 + Math.sin(i / 3) * 0.4).toFixed(2) })) }, provider);
      if (provider === "alpaca") {
        const r = rng("t" + symbol);
        let p = BASE[symbol] || 100;
        const trades = Array.from({ length: 600 }, (_, i) => {
          p *= 1 + (r() - 0.5) * 0.0006;
          return { t: new Date(Date.UTC(2026, 10, 6, 20, 59, 59) - i * 2300).toISOString(), p: +p.toFixed(2), s: [100, 50, 200, 10, 300, 1200, 25][Math.floor(r() * 7)], c: ["@"] };
        });
        return wrap({ symbol, trades }, provider);
      }
      if (provider === "finnhub") {
        if (kind === "company-news")
          return wrap(
            [
              ["Apple to report fiscal fourth-quarter results after the close", "Market Wire"],
              ["Supplier commentary points to steady handset demand into the holidays", "Industry Daily"],
              ["Services revenue remains the focus for analysts this quarter", "The Ledger"],
              ["Options traders position for a larger-than-usual earnings move", "Derivatives Desk"],
              ["Index rebalancing to shift weightings among megacap technology names", "Fund Flows"],
              ["Retail investors added to large-cap tech positions last week", "Broker Notes"],
            ].map(([headline, source], i) => ({ headline: headline.replace("Apple", name.split(" ")[0]), url: "https://example.com/news/" + i, source, datetime: Math.floor(Date.UTC(2026, 10, 6, 21) / 1000) - i * 15000, summary: "Sample headline for the product demo." })),
            provider,
          );
        if (kind === "metric") return wrap({ metric: { peTTM: 34.1, netProfitMarginTTM: 24.9, dividendYieldIndicatedAnnual: 0.41, revenueGrowthQuarterlyYoy: 7.9 } }, provider);
        if (kind === "profile2") return wrap({ name, finnhubIndustry: "Technology", weburl: "https://example.com", ipo: "1980-12-12", country: "US" }, provider);
        return wrap({ earningsCalendar: [
          { date: "2027-01-28", quarter: 1, year: 2027, epsEstimate: 2.61, epsActual: null, revenueEstimate: 1.38e11, revenueActual: null, hour: "amc", symbol },
          { date: "2026-10-29", quarter: 4, year: 2026, epsEstimate: 1.86, epsActual: 1.97, revenueEstimate: 1.02e11, revenueActual: 1.051e11, hour: "amc", symbol },
          { date: "2026-07-30", quarter: 3, year: 2026, epsEstimate: 1.62, epsActual: 1.71, revenueEstimate: 9.4e10, revenueActual: 9.62e10, hour: "amc", symbol },
          { date: "2026-04-30", quarter: 2, year: 2026, epsEstimate: 1.79, epsActual: 1.84, revenueEstimate: 9.9e10, revenueActual: 1.003e11, hour: "amc", symbol },
        ] }, provider);
      }
      if (kind === "OVERVIEW")
        return wrap({ Symbol: symbol, Name: name, Sector: "TECHNOLOGY", Industry: "CONSUMER ELECTRONICS", CIK: "320193", Description: `${name} designs, makes and sells devices, software and services used by consumers and businesses worldwide. (Sample profile for the demo.)`, DividendYield: "0.0041", "52WeekHigh": "349.10", "52WeekLow": "231.80", SharesOutstanding: "14700000000" }, provider);
      const q = (end, rev, ni) => ({ fiscalDateEnding: end, reportedCurrency: "USD", totalRevenue: String(rev), costOfRevenue: String(Math.round(rev * 0.54)), grossProfit: String(Math.round(rev * 0.46)), operatingIncome: String(Math.round(rev * 0.31)), netIncome: String(ni), ebitda: String(Math.round(rev * 0.35)) });
      return wrap({
        annualReports: [q("2026-09-30", 4.16e11, 1.12e11), q("2025-09-30", 3.91e11, 9.4e10), q("2024-09-30", 3.83e11, 9.7e10), q("2023-09-30", 3.94e11, 9.98e10)],
        quarterlyReports: [q("2026-09-30", 1.051e11, 2.74e10), q("2026-06-30", 9.62e10, 2.34e10), q("2026-03-31", 1.003e11, 2.56e10), q("2025-12-31", 1.31e11, 3.62e10), q("2025-09-30", 9.79e10, 2.31e10)],
      }, provider);
    },
    quotes_start: ({ symbols }) => {
      window.__quoteSymbols = symbols;
    },
    quotes_stop: () => {
      window.__quoteSymbols = [];
    },
    quotes_snapshot: () => {
      const now = Date.now();
      const symbols = window.__quoteSymbols || [];
      return { status: "live", error: "", lastMessage: now / 1000, symbols, quotes: Object.fromEntries(symbols.map((s) => [s, { price: +((BASE[s] || 100) * (1 + Math.sin(now / 4000 + s.length) * 0.002)).toFixed(2), time: now }])) };
    },
    quotes_tape: ({ symbol, since }) => {
      const now = Date.now();
      const p = BASE[symbol] || 100;
      const prints = Array.from({ length: 6 }, (_, i) => {
        const t = Math.floor(now / 250) * 250 - (5 - i) * 250;
        return { price: +(p * (1 + Math.sin(t / 3000) * 0.001)).toFixed(2), size: [100, 25, 300, 50, 1500, 10][(t / 250) % 6 | 0], time: t, conditions: ["@"] };
      }).filter((x) => x.time > (since || 0));
      return { symbol, streaming: true, prints };
    },
    market_status: () => ({ built: window.__marketBuilt || null, job: { running: false, stage: "", done: 0, total: 0, error: "", finished: 0 } }),
    market_refresh: () => {
      window.__marketBuilt = Math.floor(Date.now() / 1000);
    },
    market_snapshot: () => (window.__marketBuilt ? marketSnapshot() : null),
    ais_start: () => {},
    ais_stop: () => {},
    ais_snapshot: () => ({ status: "live", error: "", lastMessage: Date.now() / 1000, vessels: [] }),
    holdings_status: () => ({ quarters: [{ period: "2026-06-30", filers: 10940 }, { period: "2026-03-31", filers: 10812 }], sets: [{ name: "01jun2026-31aug2026_form13f", loaded: 1 }], mapped: 21000, job: { running: false, stage: "Up to date", done: 0, total: 0, error: "", finished: 1 } }),
    holdings_update: () => null,
    holders: ({ ticker }) => holders(ticker),
    holder_portfolio: ({ cik }) => ({ cik, period: "2026-06-30", prior: "2026-03-31", quarters: [], filings: [], rows: [] }),
    holders_find: () => [],
    universe_status: () => ({ listings: 267412, countries: 58, exchanges: 90, fetched: Date.now() / 1000, stocks: 230000, etfs: 37000, sec: 0, job: { running: false, stage: "", done: 0, total: 0, error: "", finished: 0 } }),
    universe_refresh: () => null,
    universe_search: () => [],
    universe_browse: () => ({ total: 0, rows: [] }),
    universe_facets: () => ({ countries: [], exchanges: [], kinds: [] }),
    universe_get: () => null,
    fetch_sec: ({ kind, accession, doc }) => {
      const w = (d) => wrap(d, "sec");
      if (kind === "tickers") return w({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
      if (kind === "search") return w({ total: 0, hits: [] });
      if (kind === "document") return w({ text: "" });
      if (kind === "submissions") {
        const forms = ["4", "4", "4", "4", "10-K", "SCHEDULE 13G/A", "8-K", "10-Q", "8-K", "10-Q", "DEF 14A", "10-Q"];
        const dates = ["2026-11-05", "2026-10-30", "2026-10-23", "2026-10-17", "2026-10-31", "2026-10-09", "2026-10-30", "2026-08-01", "2026-07-31", "2026-05-02", "2026-01-10", "2026-01-31"];
        return w({ cik: "320193", name: "Apple Inc.", filings: { recent: { form: forms, filingDate: dates, reportDate: dates, accessionNumber: forms.map((_, i) => `0000320193-26-0000${10 + i}`), primaryDocument: forms.map((f, i) => (f === "4" ? `xslF345X06/form4-${i}.xml` : f.startsWith("SCHEDULE") ? "xslSCHEDULE_13G_X02/primary_doc.xml" : "doc.htm")) } } });
      }
      if (kind === "shares") return w({ units: { shares: [{ end: "2026-10-17", val: 14.7e9, filed: "2026-10-31", accn: "q" }] } });
      if (kind === "xml" && doc.startsWith("form4-")) {
        const x = INSIDERS[+doc.match(/-(\d+)/)[1] % INSIDERS.length];
        return w({ xml: form4(...x) });
      }
      if (kind === "xml") return w({ xml: schedule13g("Harborline Index Funds", 1250000000, "8.40") });
      if (kind === "revenue")
        return w({ units: { USD: [
          { start: "2022-09-25", end: "2023-09-30", val: 3.3e11, form: "10-K", filed: "2023-11-03", accn: "a" },
          { start: "2023-10-01", end: "2024-09-28", val: 3.58e11, form: "10-K", filed: "2024-11-01", accn: "b" },
          { start: "2024-09-29", end: "2025-09-27", val: 3.87e11, form: "10-K", filed: "2025-10-31", accn: "c" },
          { start: "2025-09-28", end: "2026-09-26", val: 4.16e11, form: "10-K", filed: "2026-10-31", accn: "d" },
        ] } });
      if (kind === "concept") {
        const flow = { NetCashProvidedByUsedInOperatingActivities: 1.38e11, PaymentsToAcquirePropertyPlantAndEquipment: 1.21e10, NetIncomeLoss: 1.12e11 }[doc];
        const stock = { LongTermDebt: 9.1e10, CashAndCashEquivalentsAtCarryingValue: 3.4e10 }[doc];
        if (flow) return w({ units: { USD: [{ start: "2025-09-28", end: "2026-09-26", val: flow, form: "10-K", filed: "2026-10-31", accn: "d" }] } });
        if (stock) return w({ units: { USD: [{ end: "2026-09-26", val: stock, form: "10-K", filed: "2026-10-31", accn: "d" }] } });
        throw "SEC has no data for this company or concept.";
      }
      return w({});
    },
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (cmd.startsWith("plugin:")) return null;
        if (!handlers[cmd]) throw "Not in the demo backend: " + cmd;
        return handlers[cmd](args || {});
      },
    },
  };
}

// ---- Tour ----------------------------------------------------------------------
async function constituents() {
  const res = await fetch("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv");
  const lines = (await res.text()).trim().split("\n").slice(1);
  const field = (line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
  return lines.map((l) => field(l)).map((f) => ({ symbol: f[0], name: f[1], sector: f[2], industry: f[3] }));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const members = await constituents();
  const server = spawn("node", ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1421", "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1800));
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2 });
  await context.addInitScript(quantStandin);
  await context.addInitScript(demoBackend, members);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const steps = [];
  const center = async (selector) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw Error("Not on screen: " + selector);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  // Saves the current screen with the caption, and where the next click lands.
  async function shot(name, caption, next, extra = {}) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.getElementById("toast")?.remove();
    });
    await page.waitForTimeout(700);
    const file = `${String(steps.length + 1).padStart(2, "0")}-${name}.jpg`;
    await page.screenshot({ path: path.join(OUT, file), type: "jpeg", quality: 80 });
    const target = next ? await center(next) : null;
    steps.push({ image: `demo/${file}`, caption, click: target, ...extra });
    if (next) await page.click(next);
  }
  try {
    await page.goto("http://127.0.0.1:1421");
    await page.waitForSelector("h1:has-text('Connect your data')");
    for (const [id, v] of Object.entries({ twelve: "DEMO1", finnhub: "DEMO2", alpha: "DEMO3", alpaca: "DEMO4", alpacasecret: "DEMO5", fred: "DEMO6", sec: "demo@example.com" })) await page.fill("#key-" + id, v);
    await page.click('[data-action="setup-connect"]');
    await page.waitForFunction(() => document.querySelectorAll(".watch-row").length === 5);
    for (const t of ["AMZN", "GOOGL", "META"]) {
      await page.fill("#watch-input", t);
      await page.click('[data-action="watch-add"]');
      await page.waitForSelector(`.watch-row .ticker[data-symbol="${t}"]`);
    }
    await page.waitForTimeout(1500);

    await shot("overview", "Your watchlist, with real-time prices streaming in.", '.watch-row .ticker[data-symbol="AAPL"]');
    await page.waitForSelector("[data-tile='DCF'] .scenario");
    await page.waitForSelector("[data-tile='TAS'] table.tape");
    await shot("stock", "Pick a stock and everything about it is on one page: chart, news, live trades, holders, valuation.", '.fn-strip [data-value="HDS"]');
    await page.waitForSelector("td.holder");
    await shot("holders", "Holders: every fund that disclosed a position in SEC 13F filings, with what it bought or sold last quarter.", '.fn-strip [data-value="OWN"]');
    await page.waitForSelector("td.holder:has-text('Dana Whitfield')");
    await shot("ownership", "Ownership changes: fund moves, 5%+ owners and insider trades in one dated feed.", '.fn-strip [data-value="DCF"]');
    await shot("valuation", "Valuation: a DCF pre-filled from the company's own SEC filings, each input sourced.", '.fn-strip [data-value="RSK"]');
    await page.waitForSelector("td:has-text('Volatility · 1 month')");
    await shot("risk", "Risk analytics: volatility, Sharpe, drawdown and beta, calculated by Goldman Sachs' open-source GS Quant.", '.fn-strip [data-value="TAS"]');
    await page.waitForSelector("#tape-slot table.tape");
    await shot("tape", "Time and sales: every trade print with VWAP and a buy/sell estimate, or the last session's when the market is closed.", '.fn-strip [data-value="SPLC"]');
    await page.waitForSelector(".g-node.center");
    await shot("relationships", "Suppliers and customers, traced from annual reports with the evidence attached.", '[data-page="Screener"]');
    await page.waitForSelector(".mm-tile[data-symbol='NVDA']");
    await page.waitForTimeout(500);
    await shot("market-map", "The whole S&P 500 at a glance: sized by market cap, coloured by today's move.", ".mm-tile[data-symbol='NVDA']");
    await page.waitForSelector(".stock-head h1:has-text('NVDA')");
    await page.waitForSelector("[data-tile='HDS'] td.holder");
    await shot("nvda", "Click any company to open its stock page.", "#search");
    await page.keyboard.type("MSFT HDS", { delay: 40 });
    await shot("command", "Or type a terminal-style command: MSFT HDS.", null, { key: "Enter" });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".stock-head h1:has-text('MSFT')");
    await page.waitForSelector("td.holder");
    await shot("msft-holders", "Microsoft's holders, one keystroke later.", null);
  } finally {
    await browser.close();
    server.kill();
  }
  fs.writeFileSync(path.join(OUT, "steps.json"), JSON.stringify({ width: VIEW.width, height: VIEW.height, steps }, null, 2) + "\n");
  console.log(JSON.stringify({ steps: steps.length, errors }));
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
