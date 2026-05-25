import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Amazon BDD Scenarios
// Fixtures are derived from live Finnhub data observed on 2026-05-25.
// All API routes are mocked — tests never hit a live external service.
// ---------------------------------------------------------------------------

const AMAZON_SEARCH_FIXTURE = {
  results: [
    { symbol: "AMZN", displaySymbol: "AMZN", description: "Amazon.com Inc" },
    { symbol: "AZFL", displaySymbol: "AZFL", description: "Amazonas Florestal Ltd" },
  ],
};

const AMAZON_QUOTE_FIXTURE = {
  c: 266.34,
  d: -2.12,
  dp: -0.7897,
  h: 269.79,
  l: 266.24,
  o: 268.66,
  pc: 268.46,
  t: 1779480000,
  isMarketOpen: true,
};

const AMAZON_CANDLES_FIXTURE = {
  t: [1769731200, 1769817600, 1769904000],
  c: [195.3, 196.7, 197.1],
  s: "ok",
};

const AMAZON_NEWS_FIXTURE = {
  articles: [
    {
      id: 140410418,
      datetime: 1779715933,
      headline: "You've been trying to get around Amazon – but it's not that easy",
      source: "Yahoo",
      summary:
        "For shoppers trying to avoid Amazon, its expansion into shipping and logistics makes that choice more difficult.",
      url: "https://example.com/amazon-news-1",
      image: "",
    },
    {
      id: 140410181,
      datetime: 1779699456,
      headline: "Amazon: The Numbers Might Not Add Up",
      source: "SeekingAlpha",
      summary: "Amazon delivered strong Q1/26 results, with 16.6% revenue growth and 74.8% EPS growth.",
      url: "https://example.com/amazon-news-2",
      image: "",
    },
  ],
};

// Real Finnhub logo URL observed in live DOM — the <img> tag uses this as src
// and renders with alt="AMZN logo".
const AMAZON_PROFILE_FIXTURE = {
  logo: "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/AMZN.png",
  name: "Amazon.com Inc",
};

// ---------------------------------------------------------------------------
// Helper: wire up all API mocks needed for the Amazon dashboard.
// The TickerTape fetches /api/stock/movers — stub it with [] to avoid
// strict-mode violations when multiple elements contain "AMZN" text.
// ---------------------------------------------------------------------------
function mockAmazonDashboard(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"]
) {
  page.route("**/api/stock/movers*", (route) => route.fulfill({ json: [] }));
  page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ json: AMAZON_QUOTE_FIXTURE })
  );
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ json: AMAZON_CANDLES_FIXTURE })
  );
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: AMAZON_NEWS_FIXTURE })
  );
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: AMAZON_PROFILE_FIXTURE })
  );
}

// ---------------------------------------------------------------------------
// Scenario 1
//
// GIVEN I am a user
// WHEN I open the homepage
// AND I type in 'Amazon' in the search box
// THEN Amazon is shown in the search results
// ---------------------------------------------------------------------------
test("searching for 'Amazon' shows Amazon in the search results", async ({ page }) => {
  // GIVEN the search API is mocked to return Amazon results
  await page.route("**/api/stock/search*", (route) =>
    route.fulfill({ json: AMAZON_SEARCH_FIXTURE })
  );
  // Suppress TickerTape movers to prevent "AMZN" strict-mode multi-match
  await page.route("**/api/stock/movers*", (route) =>
    route.fulfill({ json: [] })
  );

  // WHEN I open the homepage
  await page.goto("/");

  // AND I type 'Amazon' in the search box
  await page.getByRole("searchbox").fill("Amazon");

  // THEN Amazon is shown in the search results —
  // the live DOM renders each result as a <button> with the ticker + company name.
  // The button label is "AMZN Amazon.com Inc" (visible in accessibility snapshot).
  await expect(page.getByRole("button", { name: /AMZN/ })).toBeVisible();
  await expect(page.getByText("Amazon.com Inc")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Scenario 2
//
// GIVEN I am a user
// WHEN I open the homepage
// AND I type in 'Amazon' in the search box
// AND I select 'Amazon' from the list of results
// THEN the stock information page for Amazon will be displayed
// AND there is a chart showing the historical stock price
// AND there is the current stock price
// AND there is a list of news items
// AND there is an icon for Amazon
// ---------------------------------------------------------------------------
test("selecting Amazon shows the dashboard with chart, price, news, and icon", async ({
  page,
}) => {
  // GIVEN all dashboard APIs are mocked
  await page.route("**/api/stock/search*", (route) =>
    route.fulfill({ json: AMAZON_SEARCH_FIXTURE })
  );
  mockAmazonDashboard(page);

  // WHEN I open the homepage
  await page.goto("/");

  // AND I type 'Amazon' in the search box
  await page.getByRole("searchbox").fill("Amazon");

  // AND I select Amazon from the results list
  // The result button label in the live DOM is "AMZN Amazon.com Inc"
  await page.getByRole("button", { name: /AMZN/ }).first().click();

  // THEN the stock information page for Amazon will be displayed
  // (URL changes to /dashboard?symbol=AMZN and "AMZN" / company name appear)
  await expect(page).toHaveURL(/\/dashboard\?symbol=AMZN/);
  await expect(page.getByText("AMZN").first()).toBeVisible();
  await expect(page.getByText("Amazon.com Inc")).toBeVisible();

  // AND there is a chart showing the historical stock price
  await expect(page.getByText("Price History")).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();

  // AND there is the current stock price (mocked to $266.34)
  await expect(page.getByText("$266.34")).toBeVisible();

  // AND there is a list of news items
  await expect(page.getByText("Latest News")).toBeVisible();
  await expect(
    page.getByText("You've been trying to get around Amazon – but it's not that easy")
  ).toBeVisible();

  // AND there is an icon for Amazon
  // Live DOM: <img alt="AMZN logo" src="https://static2.finnhub.io/.../AMZN.png">
  // The profile mock provides the logo URL; the component renders it as an <img>.
  await expect(page.getByRole("img", { name: "AMZN logo" })).toBeVisible();
});
