import { test, expect } from "@playwright/test";

test("homepage renders the wordmark, tagline, search bar, and footer", async ({
  page,
}) => {
  await page.goto("/");

  // Wordmark in the header
  await expect(
    page.locator("header").getByText("Claude Stocks")
  ).toBeVisible();

  // H1 tagline
  await expect(
    page.getByRole("heading", { level: 1, name: "Track any stock, instantly." })
  ).toBeVisible();

  await expect(page.getByRole("searchbox")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
});

test("recently viewed chips are shown when sessionStorage has symbols", async ({
  page,
}) => {
  // Seed sessionStorage before any page script runs
  await page.addInitScript(() => {
    sessionStorage.setItem("recentSymbols", JSON.stringify(["AAPL", "TSLA"]));
  });

  await page.goto("http://localhost:3000");

  // Assert chip links are visible
  const aaplChip = page
    .locator('nav[aria-label="Recently viewed stocks"]')
    .getByText("AAPL");
  const tslaChip = page
    .locator('nav[aria-label="Recently viewed stocks"]')
    .getByText("TSLA");

  await expect(aaplChip).toBeVisible();
  await expect(tslaChip).toBeVisible();

  // Assert correct href values
  await expect(aaplChip).toHaveAttribute("href", "/dashboard?symbol=AAPL");
  await expect(tslaChip).toHaveAttribute("href", "/dashboard?symbol=TSLA");
});
