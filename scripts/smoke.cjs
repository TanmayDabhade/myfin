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
        "UI navigation, trades, persistence, alerts, CSV import, sample isolation passed",
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
