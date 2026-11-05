const { chromium } = require("playwright");
const { spawn } = require("child_process");
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
  await page.click('[data-entity="td-synnex"]');
  if ((await page.locator(".evidence-card").count()) !== 4)
    throw Error("Graph recenter failed");
  await page.selectOption("#graph-center", "apple");
  await page.locator('[data-entity="broadcom"]').focus();
  await page.keyboard.press("Enter");
  if ((await page.locator("#graph-center").inputValue()) !== "broadcom")
    throw Error("Graph keyboard traversal failed");
  const candidate = require("../src/data/relationships.json");
  candidate.edges = [{ ...candidate.edges[0], id: "test-import" }];
  await page.setInputFiles("#graph-import", {
    name: "evidence.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(candidate)),
  });
  await page.waitForSelector('[data-action="graph-review"]');
  await page.selectOption("#graph-candidates", "reviewed");
  if ((await page.locator(".evidence-card").count()) !== 1)
    throw Error("Import self-certified review");
  await page.selectOption("#graph-candidates", "all");
  page.once("dialog", (dialog) => dialog.accept());
  await page.click('[data-action="graph-review"]');
  await page.waitForFunction(
    () => !document.querySelector('[data-action="graph-review"]'),
  );
  await page.reload();
  await page.click('[data-page="Relationships"]');
  if ((await page.locator(".evidence-card").count()) !== 4)
    throw Error("Reviewed graph not persisted");
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
  await page.selectOption("#mode", "market");
  await page.click('[data-page="Settings"]');
  await page.fill("#import-symbol", "AAPL");
  await page.setInputFiles("#csv-import", {
    name: "prices.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "date,open,high,low,close,volume\n2026-01-02,100,102,99,101,10000\n2026-01-05,101,104,100,103,20000",
    ),
  });
  await page.waitForTimeout(200);
  if (
    !(await page
      .locator(".source-line")
      .innerText()
      .then((t) => t.includes("User CSV")))
  )
    throw Error("Import failed");
  await page.selectOption("#mode", "sample");
  if (
    await page
      .locator(".source-line")
      .innerText()
      .then((t) => t.includes("User CSV"))
  )
    throw Error("Workspace contamination");
  console.log(
    JSON.stringify({
      errors,
      result:
        "UI navigation, graph traversal/import/review, trades, persistence, alerts, CSV import, sample isolation passed",
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
