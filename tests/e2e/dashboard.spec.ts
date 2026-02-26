import { test, expect } from "@playwright/test";

const QUOTE_OPEN = {
  c: 261.74,
  d: 3.45,
  dp: 1.34,
  h: 263.0,
  l: 258.5,
  o: 259.0,
  pc: 258.29,
  t: 1609459200,
  isMarketOpen: true,
};

const QUOTE_CLOSED = { ...QUOTE_OPEN, isMarketOpen: false };

const CANDLES_FIXTURE = {
  t: [1609459200, 1609545600, 1609632000],
  c: [132.69, 130.96, 131.97],
  s: "ok",
};

const NEWS_FIXTURE = {
  articles: [
    {
      id: 1,
      datetime: 1609459200,
      headline: "Apple Reports Record Revenue",
      source: "Reuters",
      summary: "Apple Inc. reported record quarterly revenue.",
      url: "https://example.com/1",
      image: "",
    },
  ],
};

function mockDashboard(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"],
  quoteFixture = QUOTE_OPEN
) {
  page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ json: quoteFixture })
  );
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ json: CANDLES_FIXTURE })
  );
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: NEWS_FIXTURE })
  );
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: { logo: "", name: "" } })
  );
}

test("dashboard shows current price, chart, and news", async ({ page }) => {
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");

  // Price header
  await expect(page.getByText("$261.74")).toBeVisible();

  // Chart section
  await expect(page.getByText("Price History")).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();

  // News section
  await expect(page.getByText("Latest News")).toBeVisible();
  await expect(page.getByText("Apple Reports Record Revenue")).toBeVisible();
});

test("market closed badge is shown when the market is not open", async ({
  page,
}) => {
  mockDashboard(page, QUOTE_CLOSED);
  await page.goto("/dashboard?symbol=AAPL");

  await expect(page.getByText("Market closed")).toBeVisible();
});

test("clicking a range button re-fetches candles with the new range", async ({
  page,
}) => {
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");

  // Wait for chart to load before changing range
  await expect(page.locator("canvas")).toBeVisible();

  const candlesRequest = page.waitForRequest(
    (req) =>
      req.url().includes("/api/stock/candles") &&
      req.url().includes("range=1Y")
  );

  await page.getByRole("button", { name: "1Y" }).click();
  await candlesRequest;
});

test("the back link navigates to the homepage", async ({ page }) => {
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");

  await page.getByRole("link", { name: "← Search" }).click();
  await expect(page).toHaveURL("/");
});
