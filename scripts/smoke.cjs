const { chromium } = require("playwright");
const { spawn } = require("child_process");
const quantStandin = require("./quant-standin.cjs");
// Stand-in for the Rust backend with fixed fake responses, so the desktop
// data flow can be exercised in a browser without network or real keys.
function fakeBackend() {
  const store = (k, v) =>
    v === undefined ? JSON.parse(localStorage.getItem(k) || "null") : localStorage.setItem(k, JSON.stringify(v));
  const bars = (n) =>
    Array.from({ length: n }, (_, i) => {
      // Always ends on the same day; longer histories reach further back.
      const k = i + 80 - n;
      const d = new Date(Date.UTC(2026, 6, 1) + k * 864e5).toISOString().slice(0, 10);
      const c = 100 + Math.sin(k / 5) * 8 + k * 0.2;
      return { datetime: d, open: String(c - 1), high: String(c + 2), low: String(c - 2), close: String(c), volume: "1000000" };
    }).reverse();
  const handlers = {
    quant_status: (a) => window.__quantStandin.status(a),
    quant_analyze: (a) => window.__quantStandin.analyze(a),
    quant_analyze_batch: ({ inputs }) => inputs.map((input) => ({ data: window.__quantStandin.analyze({ input }) })),
    quant_cached: () => ({}),
    quant_choose: () => null,
    quant_forget: (a) => window.__quantStandin.status(a),
    // Quant Lab records, with the desktop store's write-once rule.
    lab_put: ({ kind, id, parent, body, immutable }) => {
      const all = store("native-lab") || {};
      const k = kind + ":" + id;
      const once = immutable || ["snapshot", "run", "selection", "holdout", "event"].includes(kind);
      if (all[k] && (once || all[k].immutable) && all[k].body !== body) throw "This " + kind + " is already recorded and can't be changed.";
      all[k] = { kind, parent, body, immutable: once, created: all[k]?.created || Date.now() + Object.keys(all).length / 1e6 };
      store("native-lab", all);
    },
    lab_get: ({ kind, id }) => (store("native-lab") || {})[kind + ":" + id]?.body ?? null,
    lab_list: ({ kind, parent }) =>
      Object.values(store("native-lab") || {})
        .filter((r) => r.kind === kind && (parent == null || r.parent === parent))
        .sort((x, y) => x.created - y.created)
        .map((r) => r.body),
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
      const wrap = (data) => ({ data, fetchedAt: Date.now() / 1000, cached: false, provider });
      if (provider === "twelve" && kind === "TIME_SERIES_1MIN")
        return wrap({ status: "ok", values: [{ datetime: "2026-11-06 15:59:00", open: "150", high: "151", low: "149", close: "150.5", volume: "1000" }] });
      // Intraday chart bars: one session from 09:30 at the requested step.
      if (provider === "twelve" && kind.startsWith("INTRADAY_")) {
        const step = { INTRADAY_1MIN: 1, INTRADAY_5MIN: 5, INTRADAY_15MIN: 15, INTRADAY_1H: 60, INTRADAY_4H: 240 }[kind];
        const values = [];
        for (let m = 0; m < 390; m += step) {
          const t = 9 * 60 + 30 + m, c = 150 + Math.sin(m / 30) * 2;
          values.push({ datetime: `2026-11-06 ${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`, open: String(c - 0.2), high: String(c + 0.5), low: String(c - 0.5), close: String(c), volume: "5000" });
        }
        return wrap({ status: "ok", values: values.reverse() });
      }
      if (provider === "twelve") return wrap({ status: "ok", values: bars(300) });
      if (provider === "finnhub") {
        if (kind === "company-news") return wrap([{ headline: "Fixture headline", url: "https://example.com/n", source: "Fixture", datetime: 1794070000, summary: "Test" }]);
        if (kind === "metric") return wrap({ metric: { peTTM: 30, dividendYieldIndicatedAnnual: 0.5, netProfitMarginTTM: 25 } });
        if (kind === "profile2") return wrap({ name: symbol + " Fixture Inc", finnhubIndustry: "Technology", weburl: "https://example.com", ipo: "1980-12-12" });
        return wrap({ earningsCalendar: [{ date: "2026-10-30", quarter: 4, year: 2026, epsEstimate: 2, epsActual: 2.2, revenueEstimate: 1e11, revenueActual: 1.02e11, hour: "amc", symbol }] });
      }
      if (provider === "alpaca")
        return wrap({ symbol, trades: [{ t: "2026-11-06T20:59:59Z", p: 150.2, s: 300, c: ["@"] }, { t: "2026-11-06T20:59:58Z", p: 150.1, s: 100, c: ["@"] }] });
      if (provider === "fred")
        return wrap({ observations: [{ date: "2026-10-01", value: "4.1" }, { date: "2026-09-01", value: "4.3" }] });
      if (kind === "OVERVIEW")
        return wrap({ Symbol: symbol, Name: symbol + " Test Corp", Sector: "TECHNOLOGY", Description: "Fixture company profile for " + symbol, PERatio: "20" });
      if (kind === "NEWS_SENTIMENT")
        return wrap({ feed: [{ title: "Fixture headline", url: "https://example.com/n", source: "Fixture", time_published: "20261105T120000", summary: "Test" }] });
      return wrap({ annualReports: [{ fiscalDateEnding: "2025-12-31", reportedCurrency: "USD", totalRevenue: "1000" }] });
    },
    ais_start: ({ area }) => {
      if (!(store("native-keys") || {}).ais) throw "No AISStream key";
      window.__aisArea = area;
    },
    quotes_start: ({ symbols }) => {
      if (!(store("native-keys") || {}).finnhub) throw "No Finnhub key";
      window.__quoteSymbols = symbols;
    },
    quotes_stop: () => {
      window.__quoteSymbols = [];
    },
    // A price that moves every second, like a real trade feed.
    quotes_snapshot: () => {
      const now = Date.now();
      const symbols = window.__quoteSymbols || [];
      return {
        status: "live",
        error: "",
        lastMessage: now / 1000,
        symbols,
        quotes: Object.fromEntries(symbols.map((s) => [s, { price: 150 + (Math.floor(now / 1000) % 7), time: now }])),
      };
    },
    // One trade print per second, alternating up and down ticks.
    quotes_tape: ({ symbol, since }) => {
      const now = Date.now();
      const prints = [0, 1, 2]
        .map((i) => ({ price: 150 + (i % 2), size: 100 * (i + 1), time: Math.floor(now / 1000) * 1000 - (2 - i) * 1000, conditions: ["1"] }))
        .filter((p) => p.time > (since || 0) && !window.__noLivePrints);
      return { symbol, streaming: (window.__quoteSymbols || []).includes(symbol), prints };
    },
    // Aperture Analyst: a scripted stand-in for the local model. First turn
    // asks for a news search; after the tool result it answers with citations.
    analyst_status: () => {
      const c = (window.__anCfg ||= { choice: "", provider: "", model: "", keys: {} });
      const choice = c.choice || "gemma";
      const ready = choice === "gemma" ? !!window.__anInstalled : c.choice === "online" ? !!c.keys[c.provider] && !!c.model : false;
      const names = { openrouter: "OpenRouter", huggingface: "Hugging Face", openai: "OpenAI", anthropic: "Anthropic (Claude)", gemini: "Google Gemini" };
      const suggested = { openrouter: "anthropic/claude-opus-5.5", huggingface: "deepseek-ai/DeepSeek-V4-Pro" };
      return {
        supported: true,
        choice,
        chosen: !!c.choice,
        local: choice !== "online",
        ready,
        installed: ready,
        model: { name: "Gemma 4 E4B", file: "gemma.gguf", bytes: 4977171584, license: "Apache 2.0", installed: !!window.__anInstalled },
        runtime: { name: "llama.cpp b11927", license: "MIT", installed: !!window.__anInstalled },
        gguf: null,
        server: { url: "", model: "", hasKey: false },
        online: { provider: c.provider, name: names[c.provider] || "", model: c.model, providers: Object.entries(names).map(([id, name]) => ({ id, name, signIn: id in suggested, keyUrl: "https://example.com/keys", suggested: suggested[id] || "", connected: !!c.keys[id] })) },
        downloadBytes: window.__anInstalled ? 0 : 4993171584,
        gpu: true,
        running: false,
        job: { running: false, stage: "", done: 0, total: 0, error: "" },
      };
    },
    analyst_install: () => {
      window.__anInstalled = true;
    },
    analyst_remove: () => {
      window.__anInstalled = false;
    },
    analyst_configure: (args) => {
      Object.assign(window.__anCfg, Object.fromEntries(Object.entries(args).filter(([, v]) => v != null)));
      return window.__TAURI__.core.invoke("analyst_status");
    },
    analyst_sign_in: ({ provider = "openrouter" }) => {
      window.__anSignIns = [...(window.__anSignIns || []), provider];
      Object.assign(window.__anCfg, { choice: "online", provider, model: { openrouter: "anthropic/claude-opus-5.5", huggingface: "deepseek-ai/DeepSeek-V4-Pro" }[provider] });
      window.__anCfg.keys[provider] = "token-" + provider;
      return window.__TAURI__.core.invoke("analyst_status");
    },
    analyst_set_key: ({ provider, key }) => {
      window.__anCfg.keys[provider] = key;
      return window.__TAURI__.core.invoke("analyst_status");
    },
    analyst_sign_out: ({ provider }) => {
      delete window.__anCfg.keys[provider];
      return window.__TAURI__.core.invoke("analyst_status");
    },
    analyst_models: ({ target }) =>
      target === "huggingface" ? ["deepseek-ai/DeepSeek-V4-Pro", "deepseek-ai/DeepSeek-V4-Pro-0813", "moonshotai/Kimi-K3", "Qwen/Qwen3.8-27B", "zai-org/GLM-5.3", "openai/gpt-oss-120b", "meta-llama/Llama-4-Scout-17B-16E-Instruct"] : ["anthropic/claude-opus-5.5", "google/gemini-4-argon", "openai/gpt-5.6-sol"],
    analyst_cancel: () => {},
    analyst_news: () => [
      { title: "Fixture Corp faces EU fine over app store", url: "https://news.example.org/eu", source: "Example News", published: "Tue, 10 Nov 2026 13:00:00 GMT", snippet: "Regulators fined the company." },
      { title: "Fixture headline", url: "https://example.com/n", source: "Fixture", published: "", snippet: "" },
    ],
    analyst_read: ({ url }) => ({ url, title: "EU fine", text: "Regulators fined the company. ".repeat(20) }),
    analyst_chat: ({ id, messages, tools, allowTools }) => {
      window.__anMessages = messages;
      const say = (text) => (window.__anListeners || []).forEach((fn) => fn({ payload: { id, text } }));
      if (allowTools && tools.length && !messages.some((m) => m.role === "tool"))
        return { content: "", tool_calls: [{ id: "c1", name: "search_news", arguments: JSON.stringify({ query: "Fixture EU fine" }) }], finish: "tool_calls" };
      const text = "**Lower after an EU fine** [W1].\n- Selling outweighed buying [O]\n- Price and volume [P]";
      say(text);
      return { content: text, tool_calls: [], finish: "stop" };
    },
    // S&P 500 market map: built on request, then served as a snapshot.
    market_status: () => ({ built: window.__marketBuilt || null, job: { running: false, stage: "", done: 0, total: 0, error: "", finished: 0 } }),
    market_refresh: () => {
      window.__marketBuilt = Math.floor(Date.now() / 1000);
    },
    market_snapshot: () => {
      if (!window.__marketBuilt) return null;
      const sectors = ["Information Technology", "Financials", "Health Care", "Energy"];
      const tiles = Array.from({ length: 40 }, (_, i) => ({
        symbol: i === 0 ? "AAPL" : i === 1 ? "MSFT" : "T" + i,
        name: i === 0 ? "Apple Inc." : i === 1 ? "Microsoft" : "Test " + i,
        sector: sectors[i % 4],
        industry: "Fixture industry",
        price: 100 + i,
        date: "2026-11-06",
        returns: { d1: (i % 7) / 100 - 0.03, w1: 0.01, m1: 0.02, m3: 0.03, ytd: 0.1, y1: 0.2 },
        cap: i === 0 ? 4e12 : 1e11 / (i + 1),
        shares_date: "2026-10-20",
      }));
      return { source: "alpaca", built: window.__marketBuilt, date: "2026-11-06", complete: true, members: 40, tiles };
    },
    ais_stop: () => {
      window.__aisArea = null;
    },
    ais_snapshot: () => ({
      area: window.__aisArea,
      status: "live",
      error: "",
      lastMessage: Date.now() / 1000,
      vessels: [
        { mmsi: 123456789, name: "FIXTURE TANKER", lat: 26.5, lon: 56.3, sog: 11.2, cog: 90, status: "Under way (engine)", class: "tanker", type_code: 80, destination: "FIXTURE PORT", seen: Date.now() / 1000 },
        { mmsi: 223456789, name: "FIXTURE CARGO", lat: 26.6, lon: 56.1, sog: null, cog: null, status: "At anchor", class: "cargo", type_code: 70, destination: "", seen: Date.now() / 1000 },
      ],
    }),
    // Reference data: two 13F quarters and a small listing directory.
    holdings_status: () => ({
      quarters: [{ period: "2026-06-30", filers: 10940 }, { period: "2026-03-31", filers: 10800 }],
      sets: [{ name: "01jun2026-31aug2026_form13f", loaded: 1, filings: 2, rows: 4 }],
      mapped: 12000,
      job: { running: false, stage: "Up to date", done: 0, total: 0, error: "", finished: 1 },
    }),
    holdings_update: () => null,
    holders: ({ ticker }) => {
      const f = (period, cik, name, shares, value, portfolio, rank, putcall = 0) => ({ period, cik, putcall, value, shares, prn: false, discretion: "Sole", sole: shares, shared: 0, none: 0, rank, name, city: "Boston", state: "MA", portfolio, positions: 40, accession: "0000000001-26-000001", filed: "2026-08-10" });
      return {
        period: "2026-06-30",
        prior: "2026-03-31",
        quarters: [{ period: "2026-06-30", filers: 10940 }, { period: "2026-03-31", filers: 10800 }],
        securities: [{ cusip: "037833100", issuer: "APPLE INC", class: "COM", holders: 3, value: 9e9, source: "SEC fails-to-deliver list" }],
        related: [],
        included: ["037833100"],
        rows: [
          f("2026-06-30", 1, "FIXTURE CAPITAL LLC", 1500, 450000, 4500000, 1),
          f("2026-03-31", 1, "FIXTURE CAPITAL LLC", 1000, 280000, 4000000, 2),
          f("2026-06-30", 2, "NEWCOMER PARTNERS LP", 300, 90000, 9000000, 25),
          f("2026-03-31", 3, "DEPARTED ADVISORS INC", 700, 200000, 5000000, 4),
          f("2026-06-30", 1, "FIXTURE CAPITAL LLC", 100, 30000, 4500000, null, 1),
        ],
        history: [
          { period: "2026-03-31", holders: 2, shares: 1700, value: 480000, putHolders: 0, putShares: 0, callHolders: 0, callShares: 0 },
          { period: "2026-06-30", holders: 2, shares: 1800, value: 540000, putHolders: 1, putShares: 100, callHolders: 0, callShares: 0 },
        ],
        tenure: { 1: { quarters: 2, since: "2026-03-31" }, 2: { quarters: 1, since: "2026-06-30" } },
        reported: [3],
        ticker,
      };
    },
    holder_portfolio: ({ cik }) => ({
      cik,
      period: "2026-06-30",
      prior: "2026-03-31",
      quarters: [],
      filings: [
        { period: "2026-06-30", name: "FIXTURE CAPITAL LLC", city: "Boston", state: "MA", total: 4500000, positions: 2, accession: "a", filed: "2026-08-10" },
        { period: "2026-03-31", name: "FIXTURE CAPITAL LLC", city: "Boston", state: "MA", total: 4000000, positions: 2, accession: "b", filed: "2026-05-10" },
      ],
      rows: [
        { period: "2026-06-30", cusip: "037833100", putcall: 0, value: 450000, shares: 1500, prn: false, rank: 1, issuer: "APPLE INC", class: "COM", ticker: "AAPL" },
        { period: "2026-03-31", cusip: "037833100", putcall: 0, value: 280000, shares: 1000, prn: false, rank: 2, issuer: "APPLE INC", class: "COM", ticker: "AAPL" },
        { period: "2026-03-31", cusip: "594918104", putcall: 0, value: 300000, shares: 700, prn: false, rank: 1, issuer: "MICROSOFT CORP", class: "COM", ticker: "MSFT" },
      ],
    }),
    holders_find: () => [],
    universe_status: () => ({ listings: 4, countries: 3, exchanges: 3, fetched: 1, stocks: 3, etfs: 1, sec: 0, job: { running: false, stage: "", done: 0, total: 0, error: "", finished: 0 } }),
    universe_refresh: () => null,
    universe_search: ({ q }) =>
      [
        { key: "AAPL", symbol: "AAPL", name: "Apple Inc.", exchange: "NASDAQ", mic: "XNGS", country: "United States", currency: "USD", kind: "Common Stock" },
        { key: "VOD:XLON", symbol: "VOD", name: "Vodafone Group Plc", exchange: "LSE", mic: "XLON", country: "United Kingdom", currency: "GBp", kind: "Common Stock" },
      ].filter((r) => (r.symbol + r.name).toUpperCase().includes(String(q).toUpperCase())),
    universe_browse: () => ({
      total: 2,
      rows: [
        { key: "7203:XJPX", symbol: "7203", name: "Toyota Motor Corp", exchange: "JPX", mic: "XJPX", country: "Japan", currency: "JPY", kind: "Common Stock" },
        { key: "VOD:XLON", symbol: "VOD", name: "Vodafone Group Plc", exchange: "LSE", mic: "XLON", country: "United Kingdom", currency: "GBp", kind: "Common Stock" },
      ],
    }),
    universe_facets: () => ({ countries: [["Japan", "", "", 1], ["United Kingdom", "", "", 1]], exchanges: [["XJPX", "JPX", "Japan", 1], ["XLON", "LSE", "United Kingdom", 1]], kinds: [["Common Stock", "", "", 2]] }),
    universe_get: ({ key }) => (key === "VOD:XLON" ? { key, symbol: "VOD", name: "Vodafone Group Plc", exchange: "LSE", mic: "XLON", country: "United Kingdom", currency: "GBp", kind: "Common Stock" } : null),
    fetch_sec: ({ kind, accession, doc }) => {
      if (!["submissions", "revenue", "concept", "shares"].includes(kind) && !(store("native-keys") || {}).sec)
        throw "SEC contact email required";
      const wrap = (data) => ({ data, fetchedAt: Date.now() / 1000, provider: "sec" });
      if (kind === "tickers")
        return wrap({
          0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
          1: { cik_str: 1046179, ticker: "TSM", title: "Taiwan Semiconductor Manufacturing Co Ltd" },
          2: { cik_str: 1018724, ticker: "AMZN", title: "Amazon.com, Inc." },
          3: { cik_str: 772406, ticker: "CRUS", title: "CIRRUS LOGIC, INC." },
        });
      // Full-text search: one other company's annual report names Apple.
      if (kind === "search")
        return wrap({ total: 2, hits: [
          { cik: "0000320193", name: "Apple Inc.", accession: "0000320193-26-000026", doc: "cur.htm", form: "10-K", filed: "2026-11-03", period: "2026-09-26" },
          { cik: "0000772406", name: "CIRRUS LOGIC, INC.", accession: "0000772406-26-000010", doc: "crus.htm", form: "10-K", filed: "2026-05-20", period: "2026-03-28" },
        ] });
      if (kind === "document" && accession === "0000772406-26-000010")
        return wrap({ text: "Apple Inc. (\u201cApple\u201d) is our largest customer and accounted for 87% of our total net sales in fiscal 2026." });
      if (kind === "submissions")
        return wrap({
          cik: "320193",
          name: "Apple Inc.",
          filings: { recent: {
            form: ["4", "10-K", "SCHEDULE 13G", "8-K", "10-K"],
            filingDate: ["2026-11-05", "2026-11-03", "2026-04-29", "2026-08-01", "2025-10-31"],
            reportDate: ["2026-11-03", "2026-09-26", "", "", "2025-09-27"],
            accessionNumber: ["0001140361-26-042149", "0000320193-26-000026", "0002100119-26-000139", "0000320193-26-000020", "0000320193-25-000079"],
            primaryDocument: ["xslF345X06/form4.xml", "cur.htm", "xslSCHEDULE_13G_X02/primary_doc.xml", "e.htm", "prior.htm"],
          } },
        });
      if (kind === "shares") return wrap({ units: { shares: [{ end: "2026-07-17", val: 15000, filed: "2026-08-01", accn: "q" }] } });
      if (kind === "xml" && doc === "form4.xml")
        return wrap({ xml: "<ownershipDocument><documentType>4</documentType><issuer><issuerCik>0000320193</issuerCik><issuerName>Apple Inc.</issuerName><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerCik>1</rptOwnerCik><rptOwnerName>Fixture Insider</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isOfficer>true</isOfficer><officerTitle>Chief Fixture Officer</officerTitle></reportingOwnerRelationship></reportingOwner><aff10b5One>true</aff10b5One><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-11-03</value></transactionDate><transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>2399</value></transactionShares><transactionPricePerShare><value>325.75</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>29997</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>" });
      if (kind === "xml")
        return wrap({ xml: "<edgarSubmission><headerData><submissionType>SCHEDULE 13G</submissionType><filerInfo><filer><filerCredentials><cik>0002100119</cik></filerCredentials></filer></filerInfo></headerData><formData><coverPageHeader><eventDateRequiresFilingThisStatement>03/31/2026</eventDateRequiresFilingThisStatement><issuerInfo><issuerCik>0000320193</issuerCik><issuerName>Apple Inc</issuerName><issuerCusips><issuerCusipNumber>037833100</issuerCusipNumber></issuerCusips></issuerInfo></coverPageHeader><coverPageHeaderReportingPersonDetails><reportingPersonName>Fixture Index Funds</reportingPersonName><reportingPersonBeneficiallyOwnedNumberOfShares><soleVotingPower>100</soleVotingPower><sharedVotingPower>0</sharedVotingPower><soleDispositivePower>1200</soleDispositivePower><sharedDispositivePower>0</sharedDispositivePower></reportingPersonBeneficiallyOwnedNumberOfShares><reportingPersonBeneficiallyOwnedAggregateNumberOfShares>1200</reportingPersonBeneficiallyOwnedAggregateNumberOfShares><classPercent>8.00</classPercent><typeOfReportingPerson>IA</typeOfReportingPerson></coverPageHeaderReportingPersonDetails></formData></edgarSubmission>" });
      // Valuation inputs: cash flow, capital spending, debt and cash.
      if (kind === "concept") {
        const flow = { NetCashProvidedByUsedInOperatingActivities: 120e9, PaymentsToAcquirePropertyPlantAndEquipment: 12e9, NetIncomeLoss: 100e9 }[doc];
        const stock = { LongTermDebt: 100e9, CashAndCashEquivalentsAtCarryingValue: 30e9 }[doc];
        if (flow) return wrap({ units: { USD: [{ start: "2025-09-28", end: "2026-09-26", val: flow, form: "10-K", filed: "2026-11-03", accn: "c" }] } });
        if (stock) return wrap({ units: { USD: [{ end: "2026-09-26", val: stock, form: "10-K", filed: "2026-11-03", accn: "c" }] } });
        throw "SEC has no data for this company or concept.";
      }
      if (kind === "revenue")
        return wrap({ units: { USD: [
          { start: "2024-09-29", end: "2025-09-27", val: 400e9, form: "10-K", filed: "2025-10-31", accn: "b" },
          { start: "2025-09-28", end: "2026-09-26", val: 440e9, form: "10-K", filed: "2026-11-03", accn: "c" },
        ] } });
      return wrap({ text: accession.endsWith("026")
        ? "The Company relies on Taiwan Semiconductor Manufacturing Company Limited as a sole-source supplier of processors."
        : "Net sales to Amazon.com, Inc., a reseller, accounted for 11% of total net sales in 2025." });
    },
  };
  window.__TAURI__ = {
    event: {
      listen: async (name, fn) => {
        if (name === "analyst-delta") (window.__anListeners ||= []).push(fn);
        return () => {};
      },
    },
    core: {
      invoke: async (cmd, args) => {
        if (!handlers[cmd]) throw "Unsupported in fake backend: " + cmd;
        return handlers[cmd](args || {});
      },
    },
  };
}
const centerId = (page) => page.locator(".g-node.center").getAttribute("data-entity");
async function pickCompany(page, q) {
  await page.fill("#graph-search", q);
  await page.waitForSelector(".combo-item");
  await page.press("#graph-search", "Enter");
}
const shots = process.env.QL_SHOTS;
// Quant Lab on demo data: a parameter sweep runs in the worker, two
// candidates are frozen, the holdout is evaluated once, and a run opens.
async function quantLabFlow(page) {
  const shot = (n) => shots && page.screenshot({ path: `${shots}/${n}.png`, fullPage: true });
  await page.click('[data-page="Quant Lab"]');
  await page.waitForSelector("h1:has-text('Quant Lab')");
  await page.click('[data-action="ql-new"]');
  await page.waitForSelector(".ql-cov:has-text('daily bars')");
  // Strategy library: prebuilt cards with trade counts, and a bar-by-bar replay.
  await page.waitForSelector(".ql-card.active .ql-card-n:has-text('trades in training')");
  if ((await page.locator(".ql-card").count()) < 10) throw Error("Strategy library missing");
  await page.click('[data-action="ql-sim"]');
  await page.waitForSelector('[data-ql-replay="draft"] canvas');
  await page.waitForFunction(() => /Bar (\d+)/.exec(document.querySelector('[data-sim="date"]')?.textContent || "")?.[1] > 5);
  await page.locator('[data-sim="seek"]').evaluate((el) => ((el.value = el.max), el.dispatchEvent(new Event("input"))));
  if (!/Closed trades\s*[1-9]/.test(await page.locator('[data-sim="stats"]').innerText())) throw Error("Replay shows no trades at the end");
  if (shots) await page.locator(".ql-sim-panel").screenshot({ path: `${shots}/0-replay.png` });
  await shot("0-library");
  await page.fill('[data-ql="name"]', "AAPL trend sweep");
  await page.click('[data-action="ql-mode"][data-value="sweep"]');
  await page.waitForSelector("text=valid combinations");
  await shot("1-new");
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on Quant Lab setup");
  await page.click('[data-action="ql-run"]');
  await page.waitForSelector(".panel-head h2:has-text('Complete')", { timeout: 60000 });
  await page.click('[data-action="ql-tab"][data-value="leaderboard"]');
  await page.waitForSelector("[data-ql-pick]");
  await shot("2-leaderboard");
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on Quant Lab leaderboard");
  await page.locator("[data-ql-pick]").nth(0).check();
  await page.locator("[data-ql-pick]").nth(1).check();
  await page.click('[data-action="ql-freeze"]');
  await page.waitForSelector('[data-action="ql-holdout-ask"]');
  await page.click('[data-action="ql-holdout-ask"]');
  await page.click('[data-action="ql-holdout"]');
  await page.waitForSelector("text=Holdout evaluated · untouched");
  if (await page.locator('[data-action="ql-holdout-ask"]').count()) throw Error("Holdout offered twice");
  await shot("3-holdout");
  await page.locator('[data-action="ql-inspect"]').first().click();
  await page.waitForSelector('[data-ql-chart="equity"] svg');
  await page.waitForSelector('[data-ql-chart="price"] svg');
  await page.waitForSelector('[data-action="ql-split"][data-value="holdout"]');
  await page.waitForSelector('[data-ql-replay="run"] canvas');
  await shot("4-run");
  await page.click('[data-action="ql-rtab"][data-value="data"]');
  await page.waitForSelector("text=Manifest SHA-256");
  await page.reload();
  await page.click('[data-page="Quant Lab"]');
  const home = await page.locator("tbody").first().innerText();
  if (!home.includes("AAPL trend sweep") || !home.includes("Holdout evaluated")) throw Error("Quant Lab experiment not persisted");
  await shot("5-home");
  // A long discovery can be cancelled and keeps what it finished.
  await page.click('[data-action="ql-new"]');
  await page.waitForSelector(".ql-cov:has-text('daily bars')");
  await page.click('[data-action="ql-mode"][data-value="discovery"]');
  await page.fill('[data-ql="discovery.generations"]', "40");
  await page.fill('[data-ql="discovery.population"]', "80");
  await page.fill('[data-ql="budget"]', "2000");
  await page.click('[data-action="ql-run"]');
  await page.waitForSelector('[data-action="ql-cancel"], .ql-errors', { timeout: 30000 });
  if (await page.locator(".ql-errors").count()) throw Error("Discovery not started: " + (await page.locator(".ql-errors").innerText()));
  await page.click('[data-action="ql-cancel"]');
  await page.waitForSelector(".panel-head h2:has-text('Cancelled')", { timeout: 60000 });
  await page.waitForSelector("text=Incomplete: stopped before");
}
async function liveFlow(browser, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(quantStandin);
  await context.addInitScript(fakeBackend);
  // Linux CI reports a POSIX language name, which Intl rejects as a locale.
  await context.addInitScript(() => Object.defineProperty(navigator, "language", { get: () => "C.UTF-8" }));
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:1420");
  await page.waitForSelector("h1:has-text('Connect your data')");
  await page.fill("#key-twelve", "FAKEKEY1");
  await page.fill("#key-alpha", "FAKEKEY2");
  await page.fill("#key-fred", "FAKEKEY3");
  await page.fill("#key-sec", "analyst@example.com");
  await page.fill("#key-ais", "FAKEKEY4");
  await page.fill("#key-finnhub", "FAKEKEY5");
  await page.fill("#key-alpaca", "FAKEALPACA");
  await page.fill("#key-alpacasecret", "FAKESECRET");
  await page.click('[data-action="setup-connect"]');
  await page.waitForSelector(".watch-row");
  await page.waitForFunction(() => document.querySelectorAll(".watch-row").length === 5);
  if (!(await page.locator(".source-line").innerText()).includes("Twelve Data"))
    throw Error("Prices did not come from the selected source");
  // Real-time prices update in place, without a refresh or re-render.
  await page.waitForSelector("#stream-status .stream.on");
  const firstRow = await page.locator(".watch-row").first().elementHandle();
  const before = await page.locator('.watch-row [data-live-price]').first().innerText();
  await page.waitForFunction(
    (b) => document.querySelector(".watch-row [data-live-price]").innerText !== b,
    before,
    { timeout: 5000 },
  );
  if (!(await firstRow.evaluate((el) => el.isConnected))) throw Error("Live tick re-rendered the page");
  // A watchlist row opens the stock page: one grid of panels on that stock.
  await page.locator(".watch-row .ticker", { hasText: "AAPL" }).click();
  await page.waitForSelector(".stock-head h1:has-text('AAPL')");
  await page.waitForSelector(".stock-grid [data-tile='DES'] >> text=Fixture company profile");
  await page.waitForSelector(".stock-grid [data-tile='CN'] >> text=Fixture headline");
  // Key statistics are calculated: market cap from price × SEC shares, P/E from net income.
  await page.click('.fn-strip [data-value="DES"]');
  await page.waitForSelector(".stat:has-text('Market cap') >> text=SEC cover page");
  await page.waitForSelector(".stat:has-text('P/E') >> text=Price ÷ earnings per share");
  await page.waitForSelector("text=Q4 2026");
  await page.keyboard.press("Escape");
  // The trade tape fills from the stream with tick-rule sides, and order
  // flow shows buying and selling at each price.
  await page.waitForSelector("[data-tile='TAS'] .trades .tr-row.tr-buy", { timeout: 10000 });
  await page.waitForSelector("[data-tile='TAS'] .ladder .lad-row.poc");
  await page.waitForSelector("[data-tile='TAS'] .pressure-bar .pb-buy");
  // The chart draws candles on a canvas; intraday timeframes load Twelve Data bars.
  await page.waitForSelector("[data-tile='GP'] .lw-host canvas");
  await page.click('[data-tile="GP"] [data-action="chart-interval"][data-value="5m"]');
  await page.waitForFunction(() => /\d\d:\d\d/.test(document.querySelector("[data-tile='GP'] .chart-readout")?.textContent || ""), null, { timeout: 15000 });
  await page.selectOption("#chart-freq", "5s");
  await page.click('[data-tile="GP"] [data-action="chart-interval"][data-value="1D"]');
  await page.waitForFunction(() => !/\d\d:\d\d/.test(document.querySelector("[data-tile='GP'] .chart-readout")?.textContent || "x:"));
  // The full time-and-sales view adds the cumulative delta chart.
  await page.click('.fn-strip [data-value="TAS"]');
  await page.waitForSelector("#delta-chart canvas");
  await page.click('[data-action="flow-window"][data-value="1"]');
  await page.waitForSelector('[data-action="flow-window"][data-value="1"].active');
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on Time and sales");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".stock-grid");
  // Aperture Analyst: one-time setup, then a cited answer that used a web
  // search, with news Aperture already had filtered out of the results.
  await page.click('.fn-strip [data-value="ASK"]');
  // First visit offers the two ways to run it before any download.
  await page.waitForSelector('.an-path[data-value="online"]');
  if (await page.locator('[data-action="an-install"]').count()) throw Error("Analyst setup jumped to the Gemma download");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + "-first.png", fullPage: true });
  await page.click('.an-path[data-value="local"]');
  await page.click('[data-action="an-install"]');
  await page.click('[data-action="an-quick"][data-value="0"]');
  await page.waitForSelector(".an-answer a.cite[href='https://news.example.org/eu']", { timeout: 10000 });
  await page.waitForSelector(".an-steps li:has-text('1 new of 2 results')");
  await page.waitForSelector(".an-answer button.cite[data-value='TAS']");
  await page.waitForSelector(".an-sources >> text=Fixture Corp faces EU fine");
  const sys = await page.evaluate(() => window.__anMessages[0].content);
  for (const t of ["You are Aperture Analyst", "Never call yourself Gemma", "not personal financial advice", "[P] PRICE", "BRIEFING for AAPL"]) if (!sys.includes(t)) throw Error("Analyst instructions missing: " + t);
  await page.fill("#an-input", "What are the risks?");
  await page.press("#an-input", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".an-turn .an-answer:not(.an-draft)").length === 2, null, { timeout: 10000 });
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on Analyst");
  // Switching to an online account: sign in, pick a model, and the analyst
  // is told where it runs.
  await page.click('[data-action="an-change"]');
  await page.click('[data-action="an-mode"][data-value="online"]');
  await page.waitForSelector('[data-action="an-signin"][data-value="openrouter"]');
  await page.waitForSelector('[data-action="an-signin"][data-value="huggingface"]');
  if (await page.locator(".an-choose input[type=password]").count()) throw Error("Online setup asks for an API key");
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on Analyst setup");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + "-online.png", fullPage: true });
  await page.click('[data-action="an-signin"][data-value="openrouter"]');
  await page.waitForSelector("#an-input", { timeout: 10000 });
  if (!(await page.locator(".analyst-panel h2").innerText()).includes("Claude Opus 5.5 via OpenRouter")) throw Error("Analyst doesn't show the account in use");
  await page.click('[data-action="an-clear"]');
  await page.click('[data-action="an-quick"][data-value="3"]');
  await page.waitForFunction(() => document.querySelectorAll(".an-turn .an-answer:not(.an-draft)").length === 1, null, { timeout: 10000 });
  const onlineSys = await page.evaluate(() => window.__anMessages[0].content);
  if (!onlineSys.includes("user's OpenRouter account") || onlineSys.includes("entirely on the user's computer")) throw Error("Analyst not told it runs online");
  await page.click('[data-action="an-change"]');
  await page.click('[data-action="an-mode"][data-value="online"]');
  await page.waitForSelector("select#an-model-openrouter optgroup[label=Recommended] option", { state: "attached" });
  if ((await page.inputValue("select#an-model-openrouter")) !== "anthropic/claude-opus-5.5") throw Error("Model picker lost the model in use");
  if (await page.locator(".an-choose input[type=password]").count()) throw Error("Online setup asks for an API key");
  // Hugging Face: its own login, open models recommended, and the analyst
  // is told it runs there.
  await page.click('[data-action="an-signin"][data-value="huggingface"]');
  await page.waitForSelector("[data-account=huggingface] .an-tag", { timeout: 10000 });
  if ((await page.evaluate(() => window.__anSignIns)).at(-1) !== "huggingface") throw Error("Hugging Face login went to the wrong account");
  await page.waitForSelector("select#an-model-huggingface optgroup[label=Recommended] option", { state: "attached" });
  if ((await page.inputValue("select#an-model-huggingface")) !== "deepseek-ai/DeepSeek-V4-Pro") throw Error("Hugging Face picker didn't start on its suggested model");
  const hfFeatured = await page.locator("select#an-model-huggingface optgroup[label=Recommended] option").evaluateAll((os) => os.map((o) => o.value));
  for (const id of ["moonshotai/Kimi-K3", "Qwen/Qwen3.8-27B", "zai-org/GLM-5.3", "openai/gpt-oss-120b"]) if (!hfFeatured.includes(id)) throw Error("Hugging Face recommendations missing " + id);
  if (hfFeatured.includes("deepseek-ai/DeepSeek-V4-Pro-0813")) throw Error("Dated snapshot shown as recommended");
  await page.selectOption("select#an-model-huggingface", "moonshotai/Kimi-K3");
  await page.click('[data-action="an-model-save"][data-value="huggingface"]');
  await page.waitForFunction(() => window.__anCfg.model === "moonshotai/Kimi-K3");
  await page.waitForFunction(() => document.querySelector(".analyst-panel h2")?.innerText.includes("Kimi K3 via Hugging Face"));
  if (await page.locator("[data-account=openrouter] .an-tag").count()) throw Error("OpenRouter still marked in use");
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on Analyst accounts");
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + "-online-in.png", fullPage: true });
  await page.click('[data-action="an-mode"][data-value="local"]');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + "-local.png", fullPage: true });
  await page.click('[data-action="an-choice"][data-value="gemma"]');
  await page.waitForSelector("#an-input");
  if (!(await page.locator(".analyst-panel h2").innerText()).includes("Gemma 4 on this computer")) throw Error("Analyst didn't switch back to Gemma");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".stock-grid");
  // Valuation inputs come from the company's filings.
  await page.waitForSelector("[data-tile='DCF'] >> text=Inputs from the company's SEC filings", { timeout: 10000 });
  await page.click('.fn-strip [data-value="DCF"]');
  if ((await page.inputValue("#fcf")) !== "108000" || (await page.inputValue("#netDebt")) !== "70000") throw Error("DCF inputs not taken from filings");
  if (!(await page.locator("#dcf-results").innerText()).includes("vs ")) throw Error("DCF not compared to the price");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".stock-grid");
  // Risk analytics from GS Quant (stand-in backend).
  await page.waitForSelector("[data-tile='RSK'] >> text=Chance higher in a year", { timeout: 10000 });
  await page.click('.fn-strip [data-value="RSK"]');
  await page.waitForSelector("[data-rc='fan'] svg polygon");
  if (!(await page.locator(".panel-head h2 .pill").first().innerText()).startsWith("Updated")) throw Error("Background analytics stamp missing");
  for (const id of ["outcomes", "scenarios", "daily", "vol", "drawdown", "beta"]) if (!(await page.locator(`[data-rc='${id}'] svg`).count())) throw Error("Risk chart missing: " + id);
  // Hovering the fan shows simulated percentiles; the horizon switch redraws.
  const fan = await page.locator("[data-rc='fan']").boundingBox();
  await page.mouse.move(fan.x + fan.width * 0.9, fan.y + fan.height / 2);
  if (!(await page.locator("[data-rc='fan'] .rc-tip").innerText()).includes("Median")) throw Error("Fan tooltip missing");
  await page.click('[data-action="risk-horizon"][data-value="63"]');
  await page.waitForSelector('[data-action="risk-horizon"][data-value="63"].active');
  if (!(await page.locator(".outcome h3").innerText()).includes("3 months")) throw Error("Horizon switch failed");
  await page.click(".risk-details summary");
  await page.waitForSelector("td:has-text('Volatility · 1 month')");
  const rsk = await page.locator("main").innerText();
  for (const t of ["volatility(x, 22)", "GS Quant 2.2.5", "Chance of being higher", "If the market moves", "Bollinger band"]) if (!rsk.includes(t)) throw Error("Risk analytics missing " + t);
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on Risk analytics");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".stock-grid");
  await page.click('.fn-strip [data-value="FA"]');
  await page.waitForSelector("td[title='totalRevenue']:has-text('Total revenue')");
  if (!(await page.locator("body").innerText()).includes("10.00%")) throw Error("SEC revenue growth missing");
  await page.click('.fn-strip [data-value="CF"]');
  await page.waitForSelector("h2:has-text('CIK 0000320193')");
  await page.click('.fn-strip [data-value="SPLC"]');
  // Opening a company scans its filings, and other companies' reports that
  // name it, without a click.
  await page.waitForSelector("text=New since prior report");
  await page.waitForSelector('g[data-entity="cik-0000772406"]');
  if (!(await page.locator("body").innerText()).includes("Cirrus Logic, Inc."))
    throw Error("Supplier named in another company's report missing");
  // Any SEC-listed company can be searched, not just ones already in the graph.
  await page.fill("#graph-search", "Amazon");
  await page.waitForSelector(".combo-item:has-text('Amazon.com')");
  await page.press("#graph-search", "Enter");
  await page.waitForSelector('.g-node.center[data-entity="cik-0001018724"], .g-node.center[data-entity="t-amzn"]');
  const scanText = await page.locator("body").innerText();
  if (!scanText.includes("Named as supplier in filing (candidate)")) throw Error("Scan candidate missing");
  if (!/New since prior report\s+Taiwan Semiconductor/.test(scanText)) throw Error("Filing comparison missing");
  await page.selectOption("#graph-candidates", "reviewed");
  if ((await page.locator("text=Named as supplier in filing").count()) !== 0)
    throw Error("Scanned candidate treated as reviewed");
  await page.click('[data-page="Economy"]');
  await page.waitForFunction(() => [...document.querySelectorAll(".macro-card strong")].every((x) => x.textContent === "4.10"));
  await page.click('[data-page="Commodities"]');
  await page.waitForSelector("#vessel-panel .leaflet-container");
  await page.waitForFunction(() => document.querySelectorAll(".commodity-grid .macro-card strong").length === 5 && [...document.querySelectorAll(".commodity-grid .macro-card strong")].every((x) => x.textContent === "4.10"));
  await page.waitForSelector("#vessel-panel td:has-text('FIXTURE TANKER')", { timeout: 10000 });
  await page.selectOption("#vessel-class", "tanker");
  if ((await page.locator("#vessel-panel td:has-text('FIXTURE CARGO')").count()) !== 0) throw Error("Vessel class filter failed");
  if ((await page.locator("#vessel-panel .ship").count()) !== 1) throw Error("Vessel map markers wrong");
  if ((await page.locator("#vessel-panel .ship.tanker").count()) !== 1) throw Error("Tanker marker missing");
  if (/PortWatch/.test(await page.locator("body").innerText())) throw Error("PortWatch still shown");
  await page.selectOption("#vessel-location", "chokepoint1");
  await page.waitForFunction(() => document.querySelector("#vessel-location").value === "chokepoint1");
  // Switching location restarts the stream there and keeps the same map.
  await page.waitForFunction(() => window.__aisArea === "chokepoint1");
  if ((await page.locator("#vessel-panel .leaflet-container").count()) !== 1) throw Error("Map lost after location change");
  // Market closed (no live prints): the tape shows the last session's trades.
  await page.evaluate(() => (window.__noLivePrints = true));
  await page.fill("#search", "TSLA");
  await page.press("#search", "Enter");
  await page.waitForSelector(".stock-head h1:has-text('TSLA')");
  // From another page a ticker opens its panel grid.
  await page.waitForSelector(".stock-grid");
  await page.waitForSelector("[data-tile='TAS'] >> text=IEX exchange only, via Alpaca", { timeout: 10000 });
  if (!(await page.locator("[data-tile='TAS'] .trades").innerText()).includes("150.20")) throw Error("Past trades missing");
  await page.evaluate(() => (window.__noLivePrints = false));
  await page.reload();
  await page.waitForSelector("h1");
  if ((await page.locator("h1").innerText()).includes("Connect")) throw Error("Keys were not remembered");
  await page.click('[data-page="Settings"]');
  if ((await page.locator(".pill.on").count()) < 3) throw Error("Connected sources not shown");
  if (!(await page.locator("body").innerText()).includes("SEC 13F institutional holdings")) throw Error("Reference data panel missing");
  await page.waitForSelector(".pill.on:has-text('GS Quant 2.2.5')");
  // Terminal-style command: holders of any ticker.
  await page.fill("#search", "AAPL HDS");
  await page.press("#search", "Enter");
  await page.waitForSelector(".stock-head h1:has-text('AAPL')");
  await page.waitForSelector(".fn-strip .active:has-text('Holders')");
  await page.waitForSelector("td.holder:has-text('Fixture Capital')");
  const hds = await page.locator("body").innerText();
  for (const t of ["Newcomer Partners", "New", "Added", "+500"]) if (!hds.includes(t)) throw Error("Holders view missing " + t);
  if (!/% of shares outstanding\s+12\.00%/.test(hds)) throw Error("Institutional % of shares outstanding wrong");
  await page.click('[data-action="hds-filter"][data-value="exited"]');
  if ((await page.locator("td.holder").count()) !== 1 || !(await page.locator("td.holder").innerText()).includes("Departed Advisors")) throw Error("Sold-out filter wrong");
  await page.click('[data-action="hds-filter"][data-value="all"]');
  await page.click('[data-action="hds-fund"][data-value="1"]');
  await page.waitForSelector(".fund td:has-text('Microsoft')");
  if (!(await page.locator(".fund").innerText()).includes("Sold out")) throw Error("Fund exits missing");
  await page.click('[data-action="hds-tab"][data-value="big"]');
  await page.waitForSelector("td:has-text('Fixture Index Funds')");
  await page.click('[data-action="hds-tab"][data-value="insiders"]');
  await page.waitForSelector("td:has-text('Fixture Insider')");
  if (!(await page.locator("body").innerText()).includes("Chief Fixture Officer")) throw Error("Insider role missing");
  await page.click('[data-action="hds-tab"][data-value="history"]');
  await page.waitForSelector("td:has-text('2026-03-31')");
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on Holders");
  // Ownership changes: 13F moves, 13D/G owners and insider trades in one list.
  await page.click('.fn-strip [data-value="OWN"]');
  await page.waitForSelector("td.holder:has-text('Fixture Insider')");
  const ownText = await page.locator("body").innerText();
  for (const t of ["Fixture Index Funds", "Fixture Capital", "Sold (10b5-1 plan)", "Added"]) if (!ownText.includes(t)) throw Error("Ownership changes missing " + t);
  await page.click('[data-action="own-filter"][data-value="insider"]');
  if ((await page.locator("td.holder").count()) !== 1) throw Error("Ownership filter wrong");
  // Another ticker typed on the stock page keeps the view; the last one stays in the sidebar.
  await page.fill("#search", "TSLA");
  await page.press("#search", "Enter");
  await page.waitForSelector(".stock-head h1:has-text('TSLA')");
  if (!(await page.locator(".fn-strip .active").innerText()).includes("Ownership changes")) throw Error("View not kept for the new ticker");
  await page.click('[data-recent="AAPL"]');
  await page.waitForSelector(".stock-head h1:has-text('AAPL')");
  // Every listing: browse, and search suggestions from the whole directory.
  await page.click('[data-page="Universe"]');
  await page.waitForSelector("td:has-text('Toyota Motor')");
  await page.fill("#search", "voda");
  await page.waitForSelector("#search-results .combo-item:has-text('Vodafone')");
  await page.click("#search-results .combo-item:has-text('Vodafone')");
  await page.waitForSelector(".stock-head h1:has-text('VOD:XLON')");
  if (!(await page.locator(".head-price").innerText()).includes("GBp")) throw Error("Local currency not shown");
  // Screener: the S&P 500 market map; a tile opens that company's stock page.
  await page.click('[data-page="Screener"]');
  await page.waitForSelector(".mm-tile[data-symbol='AAPL']", { timeout: 10000 });
  if ((await page.locator(".mm-tile").count()) !== 40) throw Error("Market map tiles missing");
  const big = await page.locator(".mm-tile[data-symbol='AAPL']").boundingBox();
  const small = await page.locator(".mm-tile[data-symbol='T39']").boundingBox();
  if (!(big.width * big.height > 20 * small.width * small.height)) throw Error("Tiles not sized by market cap");
  if (await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)) throw Error("Overflow on market map");
  await page.selectOption('[data-screen-field="mapPeriod"]', "ytd");
  await page.waitForSelector("h3:has-text('Top gainers · Year to date')");
  await page.click(".mm-tile[data-symbol='MSFT']");
  await page.waitForSelector(".stock-head h1:has-text('MSFT')");
  await page.click('[data-page="Screener"]');
  await page.click('[data-action="screen-universe"][data-value="workspace"]');
  await page.waitForSelector("text=Visual screener");
  // Quant Lab through the desktop store and the live price loader.
  await page.click('[data-page="Quant Lab"]');
  await page.click('[data-action="ql-new"]');
  await page.waitForSelector(".ql-cov:has-text('daily bars')");
  await page.click('[data-action="ql-run"]');
  await page.waitForSelector(".panel-head h2:has-text('Complete')", { timeout: 60000 });
  const saved = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("native-lab") || "{}")));
  if (!saved.some((k) => k.startsWith("experiment:")) || !saved.some((k) => k.startsWith("snapshot:"))) throw Error("Quant Lab did not use the desktop store");
  await context.close();
}
const server = spawn(
  "node",
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1420"],
  { cwd: require("path").resolve(__dirname, ".."), stdio: "inherit" },
);
(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:1420");
  await page.waitForSelector("h1");
  for (const name of [
    "Universe",
    "Stock",
    "Trade",
    "Portfolio",
    "Screener",
    "Economy",
    "Alerts",
    "Settings",
    "Commodities",
  ]) {
    await page.click(`[data-page="${name}"]`);
    await page.waitForSelector("h1");
    if (
      await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth)
    )
      throw Error("Overflow on " + name);
  }
  await page.click('[data-page="Stock"]');
  await page.click('.fn-strip [data-value="SPLC"]');
  if ((await page.locator(".evidence-card").count()) !== 3)
    throw Error("Apple neighborhood absent");
  await page.click('g[data-entity="td-synnex"]');
  if ((await page.locator(".evidence-card").count()) !== 4)
    throw Error("Graph recenter failed");
  await pickCompany(page, "Apple");
  await page.locator('g[data-entity="broadcom"]').focus();
  await page.keyboard.press("Enter");
  if ((await centerId(page)) !== "broadcom")
    throw Error("Graph keyboard traversal failed");
  // A subsidiary opens its listed parent; Back returns to the previous company.
  await pickCompany(page, "Apple");
  await page.click('g[data-entity="qualcomm-tech"]');
  if ((await centerId(page)) !== "t-qcom")
    throw Error("Subsidiary did not open its parent company");
  if (!(await page.locator(".evidence-card").first().innerText()).includes("Qualcomm Technologies"))
    throw Error("Parent view lost the subsidiary's evidence");
  await page.click('[data-action="graph-back"]');
  if ((await centerId(page)) !== "apple" || (await page.locator(".evidence-card").count()) !== 3)
    throw Error("Back did not restore Apple's relationships");
  await page.click('[data-page="Trade"]');
  await page.click('[data-action="buy"]');
  await page.waitForTimeout(100);
  if (
    !(await page
      .locator("tbody")
      .innerText()
      .then((t) => t.includes("BUY")))
  )
    throw Error("Trade absent");
  await page.reload();
  await page.click('[data-page="Portfolio"]');
  if (
    !(await page
      .locator("tbody")
      .first()
      .innerText()
      .then((t) => t.includes("AAPL")))
  )
    throw Error("Position not persisted");
  await page.click('[data-page="Alerts"]');
  await page.fill("#alert-target", "1");
  await page.click('[data-action="alert-add"]');
  await page.waitForTimeout(100);
  if (
    !(await page
      .locator("tbody")
      .innerText()
      .then((t) => t.includes("Triggered")))
  )
    throw Error("Alert not triggered");
  await page.click('[data-page="Stock"]');
  await page.click('.fn-strip [data-value="DCF"]');
  await page.fill("#terminal", "11");
  await page.click('[data-action="dcf"]');
  if (!(await page.locator("#dcf-results").innerText()).includes("discount rate above"))
    throw Error("Invalid DCF assumptions not rejected");
  await page.click('[data-page="Trade"]');
  await page.fill("#fee", "2");
  if (!(await page.locator("#order-total").innerText()).includes("$"))
    throw Error("Order total did not compute");
  // No upload controls anywhere outside the collapsed Advanced section.
  for (const name of ["Overview", "Stock", "Economy", "Commodities", "Settings"]) {
    await page.click(`[data-page="${name}"]`);
    if ((await page.locator('input[type="file"]:visible').count()) !== 0)
      throw Error("Visible upload control on " + name);
  }
  await quantLabFlow(page);
  await liveFlow(browser, errors);
  console.log(
    JSON.stringify({
      errors,
      result:
        "UI navigation, graph traversal, trades, persistence, alerts, no uploads, Quant Lab research and holdout, first-run setup and automatic live loading passed",
    }),
  );
  await browser.close();
  server.kill();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
