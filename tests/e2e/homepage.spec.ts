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

// ---------------------------------------------------------------------------
// Watchlist panel — takes over from RecentlyViewedChips whenever
// localStorage.watchlist is non-empty (WatchlistSection's gating decision).
// ---------------------------------------------------------------------------

const WATCHLIST_QUOTES_FIXTURE = {
  quotes: [
    { symbol: "AAPL", status: "ok", price: 261.74, change: 3.45, changePercent: 1.34 },
    { symbol: "TSLA", status: "ok", price: 248.5, change: -2.1, changePercent: -0.84 },
  ],
  degraded: false,
};

/** Forces WatchlistPanel's visibilitychange handler to fire a fresh poll
 * immediately, without waiting for the real 60s POLL_INTERVAL_MS. Used to
 * deterministically trigger a *second* /watchlist-quotes request in tests
 * that need to assert on how a later response is merged with the first. */
async function forceVisibilityRepoll(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("watchlist panel renders saved symbols with live quotes and hides the recently-viewed chips", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL", "TSLA"]));
    // Present at the same time to prove the panel wins the gating decision
    // in WatchlistSection rather than both rendering.
    sessionStorage.setItem("recentSymbols", JSON.stringify(["MSFT"]));
  });
  await page.route("**/api/stock/watchlist-quotes*", (route) =>
    route.fulfill({ json: WATCHLIST_QUOTES_FIXTURE })
  );

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByText("AAPL")).toBeVisible();
  await expect(panel.getByText("TSLA")).toBeVisible();
  await expect(panel.getByText("$261.74")).toBeVisible();

  // Each row links to its dashboard.
  await expect(
    panel.getByRole("link", { name: /AAPL/ })
  ).toHaveAttribute("href", "/dashboard?symbol=AAPL");

  // Chips must not also render.
  await expect(
    page.locator('nav[aria-label="Recently viewed stocks"]')
  ).toHaveCount(0);
});

test("removing a symbol from the watchlist panel removes its row and persists the change", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL", "TSLA"]));
  });
  await page.route("**/api/stock/watchlist-quotes*", (route) =>
    route.fulfill({ json: WATCHLIST_QUOTES_FIXTURE })
  );

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  await expect(panel.getByText("AAPL")).toBeVisible();

  await page.getByRole("button", { name: "Remove AAPL from watchlist" }).click();

  await expect(panel.getByText("AAPL")).toHaveCount(0);
  await expect(panel.getByText("TSLA")).toBeVisible();

  const stored = await page.evaluate(() => localStorage.getItem("watchlist"));
  expect(JSON.parse(stored ?? "[]")).toEqual(["TSLA"]);
});

test("watchlist panel shows a degraded row instead of an infinite skeleton when the quotes request fails", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL"]));
  });
  await page.route("**/api/stock/watchlist-quotes*", (route) =>
    route.fulfill({ status: 500, json: { error: "Internal Server Error" } })
  );

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  await expect(panel.getByText("AAPL")).toBeVisible();
  // Terminal degraded state (an alert banner plus a row that gives up on
  // the price), not a forever-pulsing skeleton with no way to know
  // something's actually wrong.
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.locator(".animate-pulse")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Per-symbol `reason` handling and the `degraded` flag — added after an
// adversarial review found that a per-symbol "deferred"/"failed" error row
// silently overwrote an already-good price with no explanation, and that a
// fully budget-denied response (HTTP 200, every row `status: "error"`)
// rendered as 20 silent em-dashes indistinguishable from a healthy but
// dataless panel. All fixtures below are `page.route`-stubbed and
// deterministic — no real Finnhub calls.
// ---------------------------------------------------------------------------

test("a 'deferred' row does not clobber a previously-good price, and flags it stale instead", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL"]));
  });

  const QUOTES_ROUTE = "**/api/stock/watchlist-quotes*";
  await page.route(QUOTES_ROUTE, (route) => route.fulfill({ json: WATCHLIST_QUOTES_FIXTURE }));

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  // Waiting for the price here (rather than counting requests) is immune to
  // React StrictMode's dev-only double-invoke of the mount effect, which
  // fires this same route twice in quick succession before settling — a
  // request-count-based fixture would nondeterministically consume its
  // "second" branch on that duplicate instead of on the explicit re-poll
  // below.
  await expect(panel.getByText("$261.74")).toBeVisible();

  // Swap in a response that would clobber the price if the merge logic
  // were wrong, then explicitly trigger exactly one more poll.
  await page.unroute(QUOTES_ROUTE);
  await page.route(QUOTES_ROUTE, (route) =>
    route.fulfill({
      json: {
        quotes: [
          {
            symbol: "AAPL",
            status: "error",
            price: null,
            change: null,
            changePercent: null,
            reason: "deferred",
          },
        ],
        degraded: true,
      },
    })
  );
  await forceVisibilityRepoll(page);

  // Price is retained (not replaced by an em-dash) and flagged stale.
  await expect(panel.getByText("stale")).toBeVisible();
  await expect(panel.getByText("$261.74")).toBeVisible();
});

test("a fully budget-denied cold start (every row deferred) shows a visible degraded banner, not silent em-dashes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL", "TSLA"]));
  });
  await page.route("**/api/stock/watchlist-quotes*", (route) =>
    route.fulfill({
      json: {
        quotes: [
          {
            symbol: "AAPL",
            status: "error",
            price: null,
            change: null,
            changePercent: null,
            reason: "deferred",
          },
          {
            symbol: "TSLA",
            status: "error",
            price: null,
            change: null,
            changePercent: null,
            reason: "deferred",
          },
        ],
        degraded: true,
      },
    })
  );

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  await expect(panel.getByText("AAPL")).toBeVisible();
  await expect(panel.getByText("TSLA")).toBeVisible();

  // This is a success-shaped failure (HTTP 200) — it must still surface as
  // a visible, honest banner rather than a silently populated panel of
  // em-dashes.
  const banner = panel.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("temporarily unavailable");
});

test("a total upstream failure (every row 'failed', HTTP 200, degraded:false) shows a visible banner, not a silent wall of em-dashes", async ({
  page,
}) => {
  // Regression guard for fix 1: `degraded` only ever means "the server
  // deferred a symbol under upstream-budget pressure" — it is FALSE when
  // Finnhub is down (or the shared rate-limit budget is already spent by
  // other routes) and every dispatched symbol simply throws. That response
  // is still HTTP 200 with every row `status: "error", reason: "failed"`.
  // Gating the banner on `degraded` hid it in exactly this case; it's now
  // gated on whether any row is actually showing a visible gap on screen,
  // independent of what the server's flag says. Still `page.route`-stubbed
  // and deterministic — no real Finnhub calls, zero quota pressure.
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL", "TSLA"]));
  });
  await page.route("**/api/stock/watchlist-quotes*", (route) =>
    route.fulfill({
      json: {
        quotes: [
          {
            symbol: "AAPL",
            status: "error",
            price: null,
            change: null,
            changePercent: null,
            reason: "failed",
          },
          {
            symbol: "TSLA",
            status: "error",
            price: null,
            change: null,
            changePercent: null,
            reason: "failed",
          },
        ],
        degraded: false,
      },
    })
  );

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  await expect(panel.getByText("AAPL")).toBeVisible();
  await expect(panel.getByText("TSLA")).toBeVisible();

  const banner = panel.getByRole("alert");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("temporarily unavailable");
  // Zero rows have a price, so the "showing what we have" phrasing (used
  // when at least one row still has a real price) would be inaccurate here.
  await expect(banner).not.toContainText("showing what we have");
});

test("a symbol with no data ('unavailable') renders an em-dash without triggering the degraded banner", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["ZZZZ"]));
  });
  await page.route("**/api/stock/watchlist-quotes*", (route) =>
    route.fulfill({
      json: {
        quotes: [
          {
            symbol: "ZZZZ",
            status: "error",
            price: null,
            change: null,
            changePercent: null,
            reason: "unavailable",
          },
        ],
        degraded: false,
      },
    })
  );

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  await expect(panel.getByText("ZZZZ")).toBeVisible();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(
    panel.getByText("No price data available for this symbol")
  ).toBeVisible();
});

// ---------------------------------------------------------------------------
// Defect 1 (round-3 review): a `status: "ok"` row with a real price but a
// null change/changePercent — the shape the server deliberately emits for a
// symbol with no previous close (e.g. an IPO's first session, see
// lib/watchlist-quotes-logic.ts's `toFiniteOrNull` and its regression test
// WQL-05f) — was being rendered as an em-dash because the client's "does
// this row have a price" check also required a non-null delta. The price is
// genuinely available; only the delta is missing. These tests fail if that
// regresses.
// ---------------------------------------------------------------------------

test("a status:'ok' row with a real price and a null change renders the price, not an em-dash, and shows no delta", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["IPOX"]));
  });
  await page.route("**/api/stock/watchlist-quotes*", (route) =>
    route.fulfill({
      json: {
        quotes: [
          {
            symbol: "IPOX",
            status: "ok",
            price: 150,
            change: null,
            changePercent: null,
          },
        ],
        degraded: false,
      },
    })
  );

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  await expect(panel.getByText("IPOX")).toBeVisible();
  // The price must render — this is the exact case that silently collapsed
  // to an em-dash before the fix.
  await expect(panel.getByText("$150.00")).toBeVisible();
  // No delta to show (change/changePercent are null) — the percent
  // formatter always wraps its output in parentheses, so its total absence
  // from the row confirms no delta span was rendered at all.
  await expect(panel.getByText(/\(.*%\)/)).toHaveCount(0);
  // Never mistaken for an error row: no alert banner, no "stale" affordance
  // (this is fresh data, not a retained price).
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByText("stale")).toHaveCount(0);
});

test("a status:'ok' row with a real price and a null change replaces a previous full-delta price cleanly on a later poll, without the price vanishing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL"]));
  });

  const QUOTES_ROUTE = "**/api/stock/watchlist-quotes*";
  await page.route(QUOTES_ROUTE, (route) => route.fulfill({ json: WATCHLIST_QUOTES_FIXTURE }));

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  // Same StrictMode-safety reasoning as the "does not clobber" test above:
  // wait for the rendered price rather than counting requests.
  await expect(panel.getByText("$261.74")).toBeVisible();

  // Next poll: same symbol, still status "ok" (fresh, real data — not a
  // transient error), but this time with no delta at all.
  await page.unroute(QUOTES_ROUTE);
  await page.route(QUOTES_ROUTE, (route) =>
    route.fulfill({
      json: {
        quotes: [
          { symbol: "AAPL", status: "ok", price: 150, change: null, changePercent: null },
        ],
        degraded: false,
      },
    })
  );
  await forceVisibilityRepoll(page);

  // The new price must be shown — not an em-dash, and not the stale old
  // price either, since this IS fresh data (a status:"ok" row is never
  // "retained-through" the way a transient-error row is).
  await expect(panel.getByText("$150.00")).toBeVisible();
  await expect(panel.getByText("$261.74")).toHaveCount(0);
  await expect(panel.getByText(/\(.*%\)/)).toHaveCount(0);
  await expect(panel.getByText("stale")).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Defect 2 (round-3 review): `degraded` was only ever reset on a successful
// response, and "is the panel cold" was measured by `quotes.size === 0` —
// wrong, since a fully budget-denied cold start populates one error entry
// per symbol. Combined, a dead server arriving right after a degraded cold
// start left the amber "retrying automatically" banner showing forever,
// displaying nothing, with no way to retry. This test fails if that
// regresses.
// ---------------------------------------------------------------------------

test("a dead server after a degraded, priceless cold start shows the terminal error banner (with Retry), not a permanent amber banner over nothing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL", "TSLA"]));
  });

  const QUOTES_ROUTE = "**/api/stock/watchlist-quotes*";
  const DEGRADED_COLD_START = {
    quotes: [
      { symbol: "AAPL", status: "error", price: null, change: null, changePercent: null, reason: "deferred" },
      { symbol: "TSLA", status: "error", price: null, change: null, changePercent: null, reason: "deferred" },
    ],
    degraded: true,
  };
  await page.route(QUOTES_ROUTE, (route) => route.fulfill({ json: DEGRADED_COLD_START }));

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  await expect(panel.getByText("AAPL")).toBeVisible();
  const degradedBanner = panel.getByRole("alert");
  await expect(degradedBanner).toBeVisible();
  await expect(degradedBanner).toContainText("temporarily unavailable");

  // The server now dies entirely — every subsequent poll fails outright.
  await page.unroute(QUOTES_ROUTE);
  await page.route(QUOTES_ROUTE, (route) => route.abort("failed"));
  await forceVisibilityRepoll(page);

  // The banner must switch from the soft "we're retrying" amber message to
  // an honest terminal error — the panel holds zero real prices and the
  // server is unreachable, so "retrying automatically" would be a lie.
  const banner = panel.getByRole("alert");
  await expect(banner).toContainText("Unable to load watchlist prices", {
    timeout: 5_000,
  });
  await expect(banner).not.toContainText("temporarily unavailable");
  // A live retry affordance must be present — this is a terminal state the
  // user can act on, not a silently-stuck poll.
  await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("the rate-limit banner's copy stays accurate once the countdown reaches zero", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL"]));
  });
  await page.route("**/api/stock/watchlist-quotes*", (route) =>
    route.fulfill({
      status: 429,
      headers: { "Retry-After": "2" },
      body: "",
    })
  );

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  const banner = panel.getByRole("alert");
  await expect(banner).toContainText("retry available in 2 seconds");
  await expect(banner.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // Past the 2s countdown: copy must update to reflect that retrying is now
  // possible, and the Retry button must appear — not a frozen "N seconds"
  // message with nothing actionable next to it.
  await expect(banner).toContainText("you can retry now", { timeout: 4000 });
  await expect(banner.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a 429 on a warm panel (existing good data) stays silent, matching other poll failures", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("watchlist", JSON.stringify(["AAPL"]));
  });

  const QUOTES_ROUTE = "**/api/stock/watchlist-quotes*";
  await page.route(QUOTES_ROUTE, (route) => route.fulfill({ json: WATCHLIST_QUOTES_FIXTURE }));

  await page.goto("/");

  const panel = page.locator('section[aria-label="Your watchlist"]');
  // See the "does not clobber" test above for why waiting on the rendered
  // price (rather than counting requests) is what makes this immune to
  // StrictMode's dev-only duplicate mount fetch.
  await expect(panel.getByText("$261.74")).toBeVisible();

  await page.unroute(QUOTES_ROUTE);
  await page.route(QUOTES_ROUTE, (route) =>
    route.fulfill({ status: 429, headers: { "Retry-After": "5" }, body: "" })
  );
  await forceVisibilityRepoll(page);

  // Give the (silent) re-poll a moment to resolve, then confirm no banner
  // appears and the existing price is untouched — same philosophy as any
  // other silent poll failure once the panel is warm.
  await page.waitForTimeout(300);
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByText("$261.74")).toBeVisible();
});
