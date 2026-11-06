import { test, expect } from "@playwright/test";
test("research, trading, persistence, and workspace separation", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Your market");
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
    await expect(page.locator("h1")).toHaveText(name);
    expect(
      await page.locator("body").evaluate((el) => el.scrollWidth > innerWidth),
    ).toBe(false);
  }
  await page.click('[data-page="Trade"]');
  await page.click('[data-action="buy"]');
  await expect(page.locator("tbody")).toContainText("BUY");
  await page.reload();
  await page.click('[data-page="Portfolio"]');
  await expect(page.locator("tbody").first()).toContainText("AAPL");
  await page.click('[data-page="Alerts"]');
  await page.fill("#alert-target", "1");
  await page.click('[data-action="alert-add"]');
  await expect(page.locator("tbody")).toContainText("Triggered");
  await page.selectOption("#mode", "market");
  await page.click('[data-page="Overview"]');
  await expect(page.locator(".empty")).toContainText("desktop app");
  await page.click('[data-page="Trade"]');
  await expect(page.locator("body")).not.toContainText("BUY");
  await page.selectOption("#mode", "sample");
  await expect(page.locator(".source-line")).toContainText("Synthetic");
  await expect(page.locator("tbody")).toContainText("BUY");
  await expect(page.locator('input[type="file"]:visible')).toHaveCount(0);
  expect(errors).toEqual([]);
});
test("DCF invalid assumptions and overspending are rejected", async ({
  page,
}) => {
  await page.goto("/");
  await page.click('[data-page="Valuation"]');
  await page.fill("#terminal", "11");
  await page.click('[data-action="dcf"]');
  await expect(page.locator("#dcf-results")).toContainText(
    "discount rate above",
  );
  await page.click('[data-page="Trade"]');
  await page.fill("#qty", "100000000");
  await page.click('[data-action="buy"]');
  await expect(page.locator("#toast")).toContainText("Insufficient");
  await expect(page.locator("tbody tr")).toHaveCount(0);
});
