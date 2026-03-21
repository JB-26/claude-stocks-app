import { test, expect } from "@playwright/test";

const SEARCH_FIXTURE = {
  results: [
    { symbol: "AAPL", displaySymbol: "AAPL", description: "APPLE INC" },
  ],
};

const QUOTE_FIXTURE = {
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

test("typing in the search bar shows a results dropdown", async ({ page }) => {
  await page.route("**/api/stock/search*", (route) =>
    route.fulfill({ json: SEARCH_FIXTURE })
  );
  // Suppress the TickerTape — it renders AAPL in the DOM too, causing
  // getByText("AAPL") to match multiple elements (strict-mode violation).
  await page.route("**/api/stock/movers*", (route) =>
    route.fulfill({ json: [] })
  );

  await page.goto("/");
  await page.getByRole("searchbox").fill("Apple");

  await expect(page.getByText("APPLE INC")).toBeVisible();
  // Scope to the search results listbox to avoid matching other AAPL text
  // (e.g. recently-viewed chips or any other component that shows the ticker).
  await expect(
    page.getByRole("button", { name: /AAPL/ })
  ).toBeVisible();
});

test("selecting a result navigates to the dashboard", async ({ page }) => {
  await page.route("**/api/stock/search*", (route) =>
    route.fulfill({ json: SEARCH_FIXTURE })
  );
  await page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ json: QUOTE_FIXTURE })
  );
  await page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ json: CANDLES_FIXTURE })
  );
  await page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: NEWS_FIXTURE })
  );
  await page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: { logo: "", name: "" } })
  );

  await page.goto("/");
  await page.getByRole("searchbox").fill("Apple");
  await page.getByText("APPLE INC").click();

  await expect(page).toHaveURL(/\/dashboard\?symbol=AAPL/);
  await expect(page.getByText("AAPL").first()).toBeVisible();
});
