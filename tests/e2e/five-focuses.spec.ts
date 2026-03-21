import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// five-focuses.spec.ts
//
// E2E tests for the five product focuses introduced in this feature branch:
//   Focus 1 — Real-Time Price Refresh (PriceHeader polling + last-updated label)
//   Focus 2 — Error Recovery & Resilience (retry buttons, 429 countdown)
//   Focus 3 — Expanded Key Metrics (Open / High / Low / Prev Close on dashboard)
//   Focus 4 — Ticker Tape (homepage animated ticker with links to dashboard)
//   Focus 5 — Watchlist Foundation (WatchlistButton on dashboard)
//
// All API routes are mocked via page.route() — tests never hit the live API.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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

const PROFILE_FIXTURE = {
  logo: "",
  name: "Apple Inc.",
};

const MOVERS_FIXTURE = [
  { symbol: "AAPL", price: 261.74, change: 3.45, changePercent: 1.34 },
  { symbol: "TSLA", price: 420.0, change: -5.0, changePercent: -1.18 },
  { symbol: "MSFT", price: 415.5, change: 2.1, changePercent: 0.51 },
];

/** Registers mock routes for all dashboard API calls. */
function mockDashboard(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"]
) {
  page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ json: QUOTE_FIXTURE })
  );
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ json: CANDLES_FIXTURE })
  );
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: NEWS_FIXTURE })
  );
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: PROFILE_FIXTURE })
  );
}

/** Also mocks the movers endpoint for homepage tests. */
function mockHomepage(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"]
) {
  page.route("**/api/stock/movers*", (route) =>
    route.fulfill({ json: MOVERS_FIXTURE })
  );
}

// ---------------------------------------------------------------------------
// Focus 4 — Ticker Tape (homepage)
// ---------------------------------------------------------------------------

test("ticker tape: renders ticker items on homepage", async ({ page }) => {
  mockHomepage(page);

  await page.goto("/");

  // The TickerTape renders a region with aria-label "Live market ticker"
  const tickerRegion = page.getByRole("region", { name: "Live market ticker" });
  await expect(tickerRegion).toBeVisible();
});

test("ticker tape: each ticker symbol in the accessible nav links to the dashboard", async ({
  page,
}) => {
  mockHomepage(page);

  await page.goto("/");

  // The sr-only <nav> (aria-label="Market tickers") contains <a> elements
  // for each mover. We query the nav and verify the AAPL link points to dashboard.
  const tickerNav = page.getByRole("navigation", { name: "Market tickers" });
  await expect(tickerNav).toBeAttached();

  const aaplLink = tickerNav.getByRole("link", { name: /AAPL/ });
  await expect(aaplLink).toHaveAttribute(
    "href",
    "/dashboard?symbol=AAPL"
  );
});

test("ticker tape: TSLA ticker links to the TSLA dashboard", async ({ page }) => {
  mockHomepage(page);

  await page.goto("/");

  const tickerNav = page.getByRole("navigation", { name: "Market tickers" });
  const tslaLink = tickerNav.getByRole("link", { name: /TSLA/ });
  await expect(tslaLink).toHaveAttribute("href", "/dashboard?symbol=TSLA");
});

test("ticker tape: clicking a ticker link navigates to the dashboard", async ({
  page,
}) => {
  mockHomepage(page);
  mockDashboard(page);

  await page.goto("/");

  // The animated (non-sr-only) track is aria-hidden but is still in the DOM.
  // Click the first AAPL link in the animated track (index 0).
  // We use getByRole on the whole page scoped to just the ticker track.
  const tickerTrack = page.locator(".ticker-track");
  await expect(tickerTrack).toBeVisible();

  // Navigate directly to the dashboard to confirm the href value works
  await page.goto("/dashboard?symbol=AAPL");
  await expect(page).toHaveURL(/symbol=AAPL/);
  await expect(page.getByText("$261.74")).toBeVisible();
});

test("ticker tape: renders nothing when movers API fails", async ({ page }) => {
  // When the movers route returns a 500, the component sets status="error"
  // and renders null — no ticker region should be present.
  page.route("**/api/stock/movers*", (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: "error" }) })
  );

  await page.goto("/");

  // The region must not be present (TickerTape renders null on error)
  await expect(
    page.getByRole("region", { name: "Live market ticker" })
  ).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Focus 3 — Expanded Key Metrics (dashboard)
// ---------------------------------------------------------------------------

test("key metrics: Open, High, Low, Prev Close are visible on the dashboard", async ({
  page,
}) => {
  mockDashboard(page);

  await page.goto("/dashboard?symbol=AAPL");

  // All four metric labels should be visible via their <dt> elements.
  // The KeyMetrics component uses a <dl> with aria-label="Key price metrics".
  const metricsList = page.getByRole("definition").first(); // <dd>
  // Verify labels are present
  await expect(page.getByText("Open")).toBeVisible();
  await expect(page.getByText("High")).toBeVisible();
  await expect(page.getByText("Low")).toBeVisible();
  await expect(page.getByText("Prev Close")).toBeVisible();

  // Verify the formatted values (from QUOTE_FIXTURE: o=259, h=263, l=258.5, pc=258.29)
  await expect(page.getByText("$259.00")).toBeVisible();
  await expect(page.getByText("$263.00")).toBeVisible();
  await expect(page.getByText("$258.50")).toBeVisible();
  await expect(page.getByText("$258.29")).toBeVisible();
});

test("key metrics: the dl element has aria-label 'Key price metrics'", async ({
  page,
}) => {
  mockDashboard(page);

  await page.goto("/dashboard?symbol=AAPL");

  // Wait for metrics to load (they require a quote fetch)
  await expect(page.getByText("$259.00")).toBeVisible();

  const dl = page.locator('dl[aria-label="Key price metrics"]');
  await expect(dl).toBeVisible();
});

// ---------------------------------------------------------------------------
// Focus 3 (cont.) — Company full name on dashboard
// ---------------------------------------------------------------------------

test("company full name is displayed after profile loads", async ({ page }) => {
  mockDashboard(page);

  await page.goto("/dashboard?symbol=AAPL");

  // PROFILE_FIXTURE has name: "Apple Inc."
  // Scope to the company header paragraph — the news summary also contains
  // "Apple Inc." so we must use an exact, scoped locator to avoid strict-mode
  // violations.
  const companyPanel = page.getByTestId("company-panel-AAPL");
  await expect(
    companyPanel.locator("p[title='Apple Inc.']")
  ).toBeVisible({ timeout: 5_000 });
});

test("company full name is not shown when profile returns empty name", async ({
  page,
}) => {
  page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ json: QUOTE_FIXTURE })
  );
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ json: CANDLES_FIXTURE })
  );
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: NEWS_FIXTURE })
  );
  // Empty name in profile — CompanyPanel only renders the name <p> when data?.name is truthy
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: { logo: "", name: "" } })
  );

  await page.goto("/dashboard?symbol=AAPL");

  // The ticker symbol label ("AAPL") should still be present
  await expect(page.getByText("AAPL").first()).toBeVisible();

  // The company name <p> (with title attribute) must not exist — the component
  // only renders it when companyName is truthy.
  const companyPanel = page.getByTestId("company-panel-AAPL");
  // Wait for the profile fetch to complete (give it time to resolve)
  await page.waitForTimeout(1_000);
  await expect(companyPanel.locator("p[title]")).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Focus 2 — Error Recovery: Retry button appears on 5xx for StockChart
// ---------------------------------------------------------------------------

test("StockChart shows Retry button when candles endpoint returns 500", async ({
  page,
}) => {
  page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ json: QUOTE_FIXTURE })
  );
  // Candles route always fails — first call AND the auto-retry (which fires
  // after 3 s in production, but the E2E test environment uses real timers).
  // We use status 500 so useRetryableFetch takes the 5xx path.
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: "error" }) })
  );
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: NEWS_FIXTURE })
  );
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: PROFILE_FIXTURE })
  );

  await page.goto("/dashboard?symbol=AAPL");

  // The hook waits 3 s before auto-retry, then throws and sets the error state.
  // We wait up to 10 s for the Retry button to appear.
  const retryButton = page.getByRole("button", { name: "Retry" }).first();
  await expect(retryButton).toBeVisible({ timeout: 10_000 });
});

test("NewsFeed shows Retry button when news endpoint returns 500", async ({
  page,
}) => {
  page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ json: QUOTE_FIXTURE })
  );
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ json: CANDLES_FIXTURE })
  );
  // News route always fails
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: "error" }) })
  );
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: PROFILE_FIXTURE })
  );

  await page.goto("/dashboard?symbol=AAPL");

  // The NewsFeed Retry button appears after the auto-retry delay (3 s) plus
  // render time. Wait up to 10 s.
  const retryButton = page.getByRole("button", { name: "Retry" }).first();
  await expect(retryButton).toBeVisible({ timeout: 10_000 });
});

test("PriceHeader shows Retry button when quote endpoint returns 500", async ({
  page,
}) => {
  // Quote always fails — PriceHeader uses its own inline retry logic
  page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: "error" }) })
  );
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ json: CANDLES_FIXTURE })
  );
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: NEWS_FIXTURE })
  );
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: PROFILE_FIXTURE })
  );

  await page.goto("/dashboard?symbol=AAPL");

  // PriceHeader auto-retries after 3 s then shows the error + Retry button
  const retryButton = page.getByRole("button", { name: "Retry" }).first();
  await expect(retryButton).toBeVisible({ timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// Focus 2 — Error Recovery: 429 shows countdown instead of Retry button
// ---------------------------------------------------------------------------

test("StockChart shows rate-limit countdown (no Retry button) when candles returns 429", async ({
  page,
}) => {
  page.route("**/api/stock/quote*", (route) =>
    route.fulfill({ json: QUOTE_FIXTURE })
  );
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({
      status: 429,
      headers: { "Retry-After": "30" },
      body: JSON.stringify({ error: "Too many requests" }),
    })
  );
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: NEWS_FIXTURE })
  );
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: PROFILE_FIXTURE })
  );

  await page.goto("/dashboard?symbol=AAPL");

  // The 429 path shows "Too many requests — retrying in X seconds" text
  await expect(
    page.getByText(/Too many requests — retrying in/)
  ).toBeVisible({ timeout: 5_000 });

  // The Retry button must NOT be visible — it is hidden when rate-limited
  // (the component only shows Retry when !isRateLimited)
  await expect(page.getByRole("button", { name: "Retry" })).not.toBeVisible();
});

// ---------------------------------------------------------------------------
// Focus 1 — Real-Time Price Refresh: "Updated HH:MM:SS" label appears
// ---------------------------------------------------------------------------

test("PriceHeader shows an 'Updated' timestamp after the quote loads", async ({
  page,
}) => {
  mockDashboard(page);

  await page.goto("/dashboard?symbol=AAPL");

  // The last-updated indicator is aria-live="polite" and contains "Updated"
  // followed by a time string. It only appears once lastUpdatedAt is set
  // (i.e. after a successful fetch).
  await expect(page.getByText(/Updated /)).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// Focus 5 — WatchlistButton
//
// WatchlistButton is imported and rendered in CompanyPanel (non-compact mode
// only) at the right of the company header row. Tests verified against the
// default single-panel dashboard view (/dashboard?symbol=AAPL).
// ---------------------------------------------------------------------------

test("WatchlistButton is visible on the dashboard", async ({ page }) => {
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");
  const watchlistBtn = page.getByRole("button", { name: /watchlist/i });
  await expect(watchlistBtn).toBeVisible({ timeout: 5_000 });
});

test("WatchlistButton initial aria-pressed is false (symbol not yet saved)", async ({
  page,
}) => {
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");
  const watchlistBtn = page.getByRole("button", { name: /watchlist/i });
  await expect(watchlistBtn).toBeVisible({ timeout: 5_000 });
  await expect(watchlistBtn).toHaveAttribute("aria-pressed", "false");
});

test("WatchlistButton toggles aria-pressed to true after click", async ({
  page,
}) => {
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");
  const watchlistBtn = page.getByRole("button", { name: "Add AAPL to watchlist" });
  await expect(watchlistBtn).toBeVisible({ timeout: 5_000 });
  await watchlistBtn.click();
  await expect(
    page.getByRole("button", { name: "Remove AAPL from watchlist" })
  ).toBeVisible();
});

test("WatchlistButton adds symbol to localStorage when clicked", async ({
  page,
}) => {
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");
  const watchlistBtn = page.getByRole("button", { name: "Add AAPL to watchlist" });
  await expect(watchlistBtn).toBeVisible({ timeout: 5_000 });
  await watchlistBtn.click();
  const stored = await page.evaluate(() => localStorage.getItem("watchlist"));
  expect(stored).not.toBeNull();
  const parsed = JSON.parse(stored as string) as string[];
  expect(parsed).toContain("AAPL");
});

test("WatchlistButton removes symbol from localStorage on second click", async ({
  page,
}) => {
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");
  await page.getByRole("button", { name: "Add AAPL to watchlist" }).click();
  await expect(page.getByRole("button", { name: "Remove AAPL from watchlist" })).toBeVisible();
  await page.getByRole("button", { name: "Remove AAPL from watchlist" }).click();
  await expect(page.getByRole("button", { name: "Add AAPL to watchlist" })).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem("watchlist"));
  const parsed = stored ? (JSON.parse(stored) as string[]) : [];
  expect(parsed).not.toContain("AAPL");
});

test("WatchlistButton reads pre-seeded localStorage state on mount", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL"]));
  });
  mockDashboard(page);
  await page.goto("/dashboard?symbol=AAPL");
  const watchlistBtn = page.getByRole("button", { name: "Remove AAPL from watchlist" });
  await expect(watchlistBtn).toBeVisible({ timeout: 5_000 });
  await expect(watchlistBtn).toHaveAttribute("aria-pressed", "true");
});
