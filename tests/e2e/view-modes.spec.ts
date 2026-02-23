import { test, expect } from "@playwright/test";

function mockDashboardMulti(
  page: Parameters<Parameters<typeof test>[1]>[0]["page"]
) {
  const quotes: Record<string, object> = {
    AAPL: {
      c: 261.74, d: 3.45, dp: 1.34, h: 263.0, l: 258.5,
      o: 259.0, pc: 258.29, t: 1609459200, isMarketOpen: true,
    },
    TSLA: {
      c: 420.0, d: -5.0, dp: -1.18, h: 425.0, l: 415.0,
      o: 425.0, pc: 425.0, t: 1609459200, isMarketOpen: true,
    },
    MSFT: {
      c: 415.5, d: 2.1, dp: 0.51, h: 417.0, l: 413.0,
      o: 413.0, pc: 413.4, t: 1609459200, isMarketOpen: true,
    },
  };

  const candlesFixture = {
    t: [1609459200, 1609545600, 1609632000],
    c: [132.69, 130.96, 131.97],
    s: "ok",
  };

  const newsFixture = { articles: [] };

  page.route("**/api/stock/quote*", (route) => {
    const url = new URL(route.request().url());
    const symbol = url.searchParams.get("symbol") ?? "AAPL";
    route.fulfill({ json: quotes[symbol] ?? quotes.AAPL });
  });
  page.route("**/api/stock/candles*", (route) =>
    route.fulfill({ json: candlesFixture })
  );
  page.route("**/api/stock/news*", (route) =>
    route.fulfill({ json: newsFixture })
  );
  page.route("**/api/stock/profile*", (route) =>
    route.fulfill({ json: { logo: "", name: "" } })
  );
}

// User Story 1 — Split View Activation
test("split view shows current company and top recent company", async ({ page }) => {
  mockDashboardMulti(page);

  await page.goto("/dashboard?symbol=AAPL");

  // Seed sessionStorage after the page has loaded (requires a DOM context)
  await page.evaluate(() => {
    sessionStorage.setItem("recentSymbols", JSON.stringify(["AAPL", "TSLA"]));
  });

  // Activate split view
  await page.getByRole("button", { name: "Select dashboard view mode" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Split View" }).click();

  // URL should reflect split view
  await expect(page).toHaveURL(/view=split/);
  await expect(page).toHaveURL(/symbol2=TSLA/);

  // Both panels must be visible
  await expect(page.getByTestId("company-panel-AAPL")).toBeVisible();
  await expect(page.getByTestId("company-panel-TSLA")).toBeVisible();
});

// User Story 2 — Multi View Activation
test("multi view shows three companies", async ({ page }) => {
  mockDashboardMulti(page);

  await page.goto("/dashboard?symbol=AAPL");

  // Seed sessionStorage after the page has loaded (requires a DOM context)
  await page.evaluate(() => {
    sessionStorage.setItem(
      "recentSymbols",
      JSON.stringify(["AAPL", "TSLA", "MSFT"])
    );
  });

  await page.getByRole("button", { name: "Select dashboard view mode" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Multi View" }).click();

  await expect(page).toHaveURL(/view=multi/);
  await expect(page).toHaveURL(/symbol2=TSLA/);
  await expect(page).toHaveURL(/symbol3=MSFT/);

  await expect(page.getByTestId("company-panel-AAPL")).toBeVisible();
  await expect(page.getByTestId("company-panel-TSLA")).toBeVisible();
  await expect(page.getByTestId("company-panel-MSFT")).toBeVisible();
});

// User Story 3 — Return to Default from Split View
test("selecting default view from split view shows one panel", async ({ page }) => {
  mockDashboardMulti(page);
  await page.goto("/dashboard?symbol=AAPL&view=split&symbol2=TSLA");

  // Confirm split view is active
  await expect(page.getByTestId("company-panel-AAPL")).toBeVisible();
  await expect(page.getByTestId("company-panel-TSLA")).toBeVisible();

  // Switch back to default
  await page.getByRole("button", { name: "Select dashboard view mode" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Default View" }).click();

  await expect(page).toHaveURL(/symbol=AAPL/);
  await expect(page).not.toHaveURL(/view=split/);

  // Only one panel should exist
  await expect(page.getByTestId("company-panel-AAPL")).toBeVisible();
  await expect(page.getByTestId("company-panel-TSLA")).not.toBeVisible();
});

// User Story 4 — Return to Default from Multi View
test("selecting default view from multi view shows one panel", async ({ page }) => {
  mockDashboardMulti(page);
  await page.goto("/dashboard?symbol=AAPL&view=multi&symbol2=TSLA&symbol3=MSFT");

  await expect(page.getByTestId("company-panel-AAPL")).toBeVisible();
  await expect(page.getByTestId("company-panel-TSLA")).toBeVisible();
  await expect(page.getByTestId("company-panel-MSFT")).toBeVisible();

  await page.getByRole("button", { name: "Select dashboard view mode" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Default View" }).click();

  await expect(page).toHaveURL(/symbol=AAPL/);
  await expect(page).not.toHaveURL(/view=multi/);

  await expect(page.getByTestId("company-panel-AAPL")).toBeVisible();
  await expect(page.getByTestId("company-panel-TSLA")).not.toBeVisible();
  await expect(page.getByTestId("company-panel-MSFT")).not.toBeVisible();
});

// Robustness: Placeholder panel when insufficient recent symbols
test("split view with only one recent symbol shows placeholder for second panel", async ({
  page,
}) => {
  mockDashboardMulti(page);

  await page.goto("/dashboard?symbol=AAPL");
  await page.evaluate(() => {
    sessionStorage.setItem("recentSymbols", JSON.stringify(["AAPL"]));
  });

  await page.getByRole("button", { name: "Select dashboard view mode" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Split View" }).click();

  await expect(page.getByTestId("company-panel-AAPL")).toBeVisible();
  await expect(page.getByTestId("placeholder-panel")).toBeVisible();
});

// Robustness: Direct URL navigation (bookmarkable)
test("split view URL is bookmarkable and loads correctly on direct navigation", async ({
  page,
}) => {
  mockDashboardMulti(page);
  await page.goto("/dashboard?symbol=AAPL&view=split&symbol2=TSLA");

  await expect(page.getByTestId("company-panel-AAPL")).toBeVisible();
  await expect(page.getByTestId("company-panel-TSLA")).toBeVisible();
});
