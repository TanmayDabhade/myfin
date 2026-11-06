const { chromium } = require("playwright");
const { spawn } = require("child_process");
// Stand-in for the Rust backend with fixed fake responses, so the desktop
// data flow can be exercised in a browser without network or real keys.
function fakeBackend() {
  const store = (k, v) =>
    v === undefined ? JSON.parse(localStorage.getItem(k) || "null") : localStorage.setItem(k, JSON.stringify(v));
  const bars = (n) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(2026, 6, 1) + i * 864e5).toISOString().slice(0, 10);
      const c = 100 + Math.sin(i / 5) * 8 + i * 0.2;
      return { datetime: d, open: String(c - 1), high: String(c + 2), low: String(c - 2), close: String(c), volume: "1000000" };
    }).reverse();
  const handlers = {
    load_state: () => store("native-state"),
    save_state: ({ state }) => store("native-state", state),
    key_status: () => {
      const k = store("native-keys") || {};
      return Object.fromEntries(["alpha", "twelve", "fred", "sec", "ais", "finnhub"].map((p) => [p, { configured: !!k[p], source: k[p] ? "saved" : "none" }]));
    },
    set_keys: ({ keys }) => {
      const k = store("native-keys") || {};
      for (const [p, v] of Object.entries(keys)) if (v) k[p] = v;
      store("native-keys", k);
      return handlers.key_status();
    },
    fetch_data: ({ provider, kind, symbol }) => {
      const wrap = (data) => ({ data, fetchedAt: Date.now() / 1000, cached: false, provider });
      if (provider === "twelve") return wrap({ status: "ok", values: bars(80) });
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
    fetch_sec: ({ kind, accession }) => {
      if (kind !== "submissions" && kind !== "revenue" && !(store("native-keys") || {}).sec)
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
            form: ["10-K", "8-K", "10-K"],
            filingDate: ["2026-11-03", "2026-08-01", "2025-10-31"],
            reportDate: ["2026-09-26", "", "2025-09-27"],
            accessionNumber: ["0000320193-26-000026", "0000320193-26-000020", "0000320193-25-000079"],
            primaryDocument: ["cur.htm", "e.htm", "prior.htm"],
          } },
        });
      if (kind === "revenue")
        return wrap({ units: { USD: [
          { start: "2024-09-29", end: "2025-09-27", val: 400e9, form: "10-K", filed: "2025-10-31", accn: "b" },
          { start: "2025-09-28", end: "2026-09-26", val: 440e9, form: "10-K", filed: "2026-11-03", accn: "c" },
        ] } });
      return wrap({ text: accession.endsWith("026")
        ? "The Company relies on Taiwan Semiconductor Manufacturing Company Limited as a sole-source supplier of processors."
        : "Net sales to Amazon.com, Inc., a reseller, accounted for 11% of total net sales in 2025." });
    },
    fetch_maritime: ({ id }) => ({
      data: { features: Array.from({ length: 20 }, (_, i) => ({ attributes: { portid: id, date: new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10), n_tanker: 10 + i, n_cargo: 5, n_total: 20, n_container: 1, n_dry_bulk: 2 } })) },
      fetchedAt: Date.now() / 1000,
      provider: "IMF PortWatch",
    }),
  };
  window.__TAURI__ = {
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
async function liveFlow(browser, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(fakeBackend);
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
  await page.click('[data-page="Research"]');
  await page.waitForSelector("text=Fixture company profile");
  await page.waitForSelector("text=Fixture headline");
  await page.waitForSelector("td:has-text('totalRevenue')");
  await page.waitForSelector("h2:has-text('CIK 0000320193')");
  if (!(await page.locator("body").innerText()).includes("10.00%")) throw Error("SEC revenue growth missing");
  await page.click('[data-action="graph-open"]');
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
  await page.waitForSelector(".maritime-map");
  await page.waitForFunction(() => document.body.innerText.includes("Retrieved"));
  await page.waitForFunction(() => document.querySelectorAll(".commodity-grid .macro-card strong").length === 5 && [...document.querySelectorAll(".commodity-grid .macro-card strong")].every((x) => x.textContent === "4.10"));
  await page.waitForSelector("#vessel-panel td:has-text('FIXTURE TANKER')", { timeout: 10000 });
  await page.selectOption("#vessel-class", "tanker");
  if ((await page.locator("#vessel-panel td:has-text('FIXTURE CARGO')").count()) !== 0) throw Error("Vessel class filter failed");
  if ((await page.locator("#vessel-panel circle.vessel").count()) !== 1) throw Error("Vessel map markers wrong");
  await page.fill("#search", "TSLA");
  await page.press("#search", "Enter");
  await page.waitForSelector("h2:has-text('TSLA')");
  await page.reload();
  await page.waitForSelector("h1");
  if ((await page.locator("h1").innerText()).includes("Connect")) throw Error("Keys were not remembered");
  await page.click('[data-page="Settings"]');
  if ((await page.locator(".pill.on").count()) < 3) throw Error("Connected sources not shown");
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
    "Research",
    "Relationships",
    "Trade",
    "Portfolio",
    "Screener",
    "Valuation",
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
  await page.click('[data-page="Research"]');
  await page.click('[data-action="graph-open"]');
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
  await page.click('[data-page="Valuation"]');
  await page.fill("#terminal", "11");
  await page.click('[data-action="dcf"]');
  if (!(await page.locator("#dcf-results").innerText()).includes("discount rate above"))
    throw Error("Invalid DCF assumptions not rejected");
  await page.click('[data-page="Trade"]');
  await page.fill("#fee", "2");
  if (!(await page.locator("#order-total").innerText()).includes("$"))
    throw Error("Order total did not compute");
  // No upload controls anywhere outside the collapsed Advanced section.
  for (const name of ["Overview", "Research", "Relationships", "Economy", "Commodities", "Settings"]) {
    await page.click(`[data-page="${name}"]`);
    if ((await page.locator('input[type="file"]:visible').count()) !== 0)
      throw Error("Visible upload control on " + name);
  }
  await liveFlow(browser, errors);
  console.log(
    JSON.stringify({
      errors,
      result:
        "UI navigation, graph traversal, trades, persistence, alerts, no uploads, first-run setup and automatic live loading passed",
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
