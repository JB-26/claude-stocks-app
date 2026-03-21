# Next Five Product Focuses

> Filename: `docs/next-five-product-focuses.md`
> Date: 2026-03-19
> Author: product-owner-strategist

---

## Context: What Exists Today

The Claude Stocks App delivers a functional core loop: search for a US-listed company, view its current price with day change, browse a 1M/3M/1Y historical chart, and read up to 10 recent news articles. The app also supports split-view (2 companies) and multi-view (3 companies) comparison, recently viewed chips on the homepage, a market open/closed indicator, and a company logo display. Server-side proxying protects the Finnhub API key, rate limiting is in place, security headers are configured, and there is solid test coverage (30 unit, 13 E2E).

The foundation is strong. What follows are the five product focuses that would deliver the most meaningful impact for users of a stock market dashboard, ordered by priority.

---

## Focus 1: Real-Time Price Refresh

### The Problem

Every piece of price data on the dashboard is fetched once on mount and never updated. A user who keeps the dashboard open for 10 minutes is looking at stale data without knowing it. For a financial tool, stale-without-indication is the single most trust-damaging behaviour. Today the only way to get fresh prices is to navigate away and back, or manually reload the page.

### Why Now

This is the highest-impact gap between user expectation and product reality. Every competing dashboard (Yahoo Finance, Google Finance, Bloomberg) shows prices that update automatically. Users coming from those tools will assume prices here are live. When they realise they are not, the app loses credibility immediately. The `PriceHeader` component already has the fetch logic and the `QuoteResponse` type -- the infrastructure is in place, just the refresh loop is missing.

### What Success Looks Like

- **Hypothesis:** We believe active dashboard users will perceive the app as more trustworthy and stay on the page longer if prices visibly refresh. We will know this is true when we can observe at least one successful auto-refresh per session for users who keep the tab open for more than 2 minutes.
- Price data refreshes on a 60-second interval while the tab is visible (matching the server cache TTL).
- A subtle "last updated" timestamp or pulse animation indicates freshness.
- Refresh pauses when the tab is backgrounded (using `document.visibilitychange`) to avoid wasting Finnhub quota.
- The chart does not auto-refresh (candle data changes at most daily); only `PriceHeader` refreshes.

### Scope

**Small.** The change is localised to `PriceHeader.tsx` (add a `setInterval` inside the existing `useEffect`, gated by `document.visibilityState`). No new API routes, no new components, no backend changes.

### Handoff

- **solution-architect**: Confirm the polling interval aligns with cache TTL and Finnhub rate limits, especially in multi-view where 3 panels poll simultaneously (3 quote calls per 60s is well within the 30 req/IP/route/minute limit).
- **frontend-craft**: Implement the `setInterval` + visibility API pattern in `PriceHeader.tsx` and add a "last updated" indicator.
- **qa-strategist**: Add a unit test for the refresh interval logic and an E2E test confirming the price element updates after a simulated wait.

---

## Focus 2: Error Recovery and Resilience UX

### The Problem

When any API call fails (network error, rate limit, Finnhub outage), the user sees a red error alert that says "Unable to load [X]. Please try again." -- but there is no mechanism to actually try again without a full page reload. There is no retry button, no automatic retry, and no distinction between transient errors (network blip, 429 rate limit) and permanent ones (invalid symbol). In multi-view, a single panel's failure is visually jarring against two healthy panels, and the user has no recourse other than reloading the entire page.

The 429 responses from the rate limiter also lack a `Retry-After` header (flagged in the security audit as a Medium finding), which means even future programmatic retry logic would have to guess when to retry.

### Why Now

This compounds with Focus 1 (auto-refresh): if prices auto-refresh every 60 seconds, transient failures will become more visible and more frequent. Without resilience UX, auto-refresh would actually make the experience worse when errors occur. Solving this now prevents auto-refresh from creating new problems.

The `Retry-After` header fix is also a security audit remediation item that has a direct product benefit.

### What Success Looks Like

- **Hypothesis:** We believe users encountering transient API errors will recover without a page reload if given an inline retry mechanism. We will know this is true when the retry button is clicked and succeeds at least 50% of the time (indicating the error was genuinely transient).
- Each error alert in `PriceHeader`, `StockChart`, and `NewsFeed` includes a "Retry" button that re-triggers the fetch.
- 429 rate limit errors show a specific message ("Too many requests -- retrying in X seconds") using the `Retry-After` header value.
- The `checkRateLimit` function is refactored to return `retryAfterMs` when rate-limited (as specified in the security audit).
- Automatic retry with exponential backoff (1 attempt, 3-second delay) for 5xx errors before showing the error state.

### Scope

**Small-Medium.** Backend: refactor `checkRateLimit` return type and update all 5 route handlers to include `Retry-After`. Frontend: add retry button and auto-retry logic to `PriceHeader`, `StockChart`, and `NewsFeed` -- three components, same pattern.

### Handoff

- **solution-architect**: Refactor `checkRateLimit` to return a `RateLimitResult` type and update route handlers with `Retry-After` header.
- **frontend-craft**: Add retry buttons and auto-retry logic to the three data-fetching components.
- **qa-strategist**: Test retry behaviour for 429, 500, and network error scenarios in both unit and E2E tests.

---

## Focus 3: Expanded Key Metrics (Company Profile Data)

### The Problem

The dashboard shows only the current price, day change, and a line chart of closing prices. For a user trying to evaluate a stock, this is not enough to form even a basic opinion. Key data points that every financial dashboard shows are absent: market cap, P/E ratio, 52-week high/low, volume, open price, and previous close. The Finnhub quote response already returns `h` (high), `l` (low), `o` (open), and `pc` (previous close) -- this data is fetched, typed in `QuoteResponse`, and cached, but never displayed to the user.

Additionally, the `getCompanyProfile` function exists in `lib/finnhub/client.ts` and is called for the logo, but the company name from the profile (`raw.name`) is returned in the API response and never shown in the UI. The user sees "AAPL" but never "Apple Inc."

### Why Now

This is the lowest-effort, highest-information-density improvement available. The data is already fetched and cached -- it is literally in the JSON response being sent to the browser. Displaying it requires zero new API calls and zero new backend code. It turns the dashboard from a "price ticker with a chart" into something that resembles an actual financial research tool.

### What Success Looks Like

- **Hypothesis:** We believe users will engage more deeply with the dashboard (spending more time per session, viewing more symbols) if they can see fundamental metrics alongside price data. We will know this is true when average time on the dashboard page increases.
- The company's full name (from the profile endpoint) is displayed alongside the ticker symbol.
- A key metrics row or card below the price header shows: Open, High, Low, Previous Close (all from the existing `QuoteResponse`).
- The data is presented in a compact, scannable format consistent with the existing monochrome aesthetic.
- No new API calls are added -- all data comes from the existing `/api/stock/quote` and `/api/stock/profile` responses.

### Scope

**Small.** Frontend-only. Create a `KeyMetrics` component that receives the `QuoteResponse` and renders the four additional fields. Update `CompanyPanel` to show the company name from the profile. No backend changes.

### Handoff

- **frontend-craft**: Build a `KeyMetrics` component and integrate it into `CompanyPanel`. Surface the company name from the existing profile fetch in `CompanyLogo` (or a sibling component).
- **qa-strategist**: Add E2E assertions for the new metrics display. Unit test the formatting of open/high/low/previous close values.

---

## Focus 4: Ticker Tape (Homepage Market Context)

### The Problem

The homepage is minimal: a search bar, a tagline, a market open/closed indicator, and recently viewed chips. For a first-time user who has never searched for anything, there are no recently viewed chips -- the page is essentially empty. There is no ambient market data, no signal that the app is connected to live prices, and no entry point for users who do not already know what ticker they want to look up. The homepage fails to answer the implicit question: "What is happening in the market right now?"

The `homepage-improvements.md` document already identified a ticker tape as the highest-impact suggestion (rated "Very High impact" but "Medium-High effort").

### Why Now

Focuses 1-3 improve the experience for users who have already reached the dashboard. This focus addresses the funnel step before that: getting users from the homepage to the dashboard for the first time. A ticker tape showing live prices for major indices and companies (AAPL, MSFT, TSLA, GOOGL, SPY, etc.) serves as both social proof ("this app has real data") and a navigation shortcut ("click any ticker to see its dashboard").

This is prioritised below Focuses 1-3 because it requires a new API route (`/api/stock/movers`), has Finnhub rate limit implications (15 parallel quote calls), and requires an architectural decision about ISR vs. module-level caching that the `homepage-improvements.md` document flagged as unresolved.

### What Success Looks Like

- **Hypothesis:** We believe first-time visitors are more likely to click through to a dashboard if the homepage shows live price data for recognisable tickers. We will know this is true when the click-through rate from homepage to dashboard increases for users with no recently viewed symbols.
- A horizontally scrolling ticker tape at the top of the homepage shows 10-15 major US stocks with current price and day change (green/red).
- Each ticker is a clickable link to `/dashboard?symbol=TICKER`.
- The tape respects `prefers-reduced-motion` by displaying statically instead of scrolling.
- Data is cached aggressively (60s TTL minimum) and ideally served via ISR to avoid burning Finnhub quota per-visitor.

### Scope

**Medium.** New API route (`/api/stock/movers`), new client component (`TickerTape`), CSS animation in `globals.css`, ISR configuration decision, accessibility considerations (duplicate DOM for seamless loop requires `aria-hidden`).

### Handoff

- **solution-architect**: Design the `/api/stock/movers` route and resolve the ISR vs. module-cache architecture question. Confirm Finnhub rate limit budget for 15 batched quote calls.
- **frontend-craft**: Build the `TickerTape` component with CSS marquee animation and `prefers-reduced-motion` handling.
- **qa-strategist**: E2E tests for ticker tape rendering, click navigation, and reduced-motion behaviour.

---

## Focus 5: Watchlist with Persistent Storage

### The Problem

The "recently viewed" concept (stored in `sessionStorage`) is the app's only form of personalisation, and it is fragile. Session storage clears when the browser closes. A user who checks the same five stocks every day must re-search all of them each session. There is no way to explicitly "save" or "favourite" a stock. The recently viewed list is also implicit -- it tracks what you happened to visit, not what you care about.

More fundamentally, financial dashboard users have a core job-to-be-done that the app does not support: **monitoring a portfolio of stocks over time**. The multi-view feature partially addresses this for within-session comparison, but there is no cross-session persistence.

### Why Now

This is the first feature that would give users a reason to return to the app regularly rather than using it for one-off lookups. It transforms the product from a "search tool" into a "monitoring tool." However, it is ranked fifth because it requires a storage decision (localStorage, IndexedDB, or a backend persistence layer) and introduces new UX patterns (add/remove from watchlist, watchlist management) that are meaningfully more complex than the preceding focuses.

### What Success Looks Like

- **Hypothesis:** We believe users who can save a personal watchlist will return to the app more frequently. We will know this is true when repeat-visit rate increases for users who have added at least one stock to their watchlist.
- A "star" or "save" button on the dashboard allows adding the current stock to a watchlist.
- The homepage shows the watchlist (distinct from recently viewed) with current prices for each saved stock.
- Watchlist data persists in `localStorage` (simplest MVP) so it survives browser restarts.
- The watchlist is limited to a reasonable size (e.g., 20 symbols) to stay within free-tier API constraints.
- The existing recently viewed chips remain as a separate, secondary navigation aid.

### Scope

**Large.** New `lib/watchlist.ts` module, new `WatchlistPanel` homepage component, "save to watchlist" button on the dashboard, watchlist data fetching on homepage load (batched quote calls, similar architecture to the ticker tape), and management UX (remove from watchlist). If the team decides on backend persistence (for cross-device sync), scope increases significantly.

### Handoff

- **solution-architect**: Define the storage strategy (localStorage MVP vs. backend). Design the homepage data fetching approach for watchlist prices (shared architecture with the ticker tape movers endpoint).
- **frontend-craft**: Build the watchlist save/remove UX on the dashboard and the watchlist panel on the homepage.
- **qa-strategist**: Test watchlist CRUD operations, persistence across page reloads, and the 20-symbol limit.

---

## Summary Table

| Priority | Focus | User Problem | Scope | Key Assumption to Validate |
|----------|-------|-------------|-------|---------------------------|
| 1 | Real-Time Price Refresh | Prices go stale silently; users lose trust | Small | Users keep the dashboard tab open long enough for refresh to matter |
| 2 | Error Recovery and Resilience UX | Errors are dead-ends with no recovery path | Small-Medium | Most errors are transient and a retry will succeed |
| 3 | Expanded Key Metrics | Dashboard shows too little data to be useful for stock evaluation | Small | Users want quick fundamental data, not just price |
| 4 | Ticker Tape (Homepage Market Context) | Homepage gives first-time users no reason to engage | Medium | Live market data on the homepage increases click-through to dashboard |
| 5 | Watchlist with Persistent Storage | No cross-session memory; users must re-search daily | Large | Users want to monitor the same stocks repeatedly, not just do one-off lookups |

---

## What Was Considered But Deferred

The following ideas were evaluated and intentionally left out of this top-five list:

| Idea | Why Deferred |
|------|-------------|
| **Per-panel company switching in multi-view** | The `feature-report.md` already flags this as a future enhancement. It adds significant complexity to the URL schema and view state management. The current auto-populate-from-recent approach is adequate for now. |
| **Remaining security audit items** (HSTS header, HTTPS-only news URLs, logo URL validation) | All three are Low severity with existing mitigations in place (CSP, `upgrade-insecure-requests`). They should be addressed but are not product-differentiating. Bundle them into a housekeeping PR. |
| **Background dot-grid texture** | Pure aesthetic polish. Low impact relative to the functional gaps above. |
| **Mobile responsive design** | The `feature-report.md` explicitly states "Desktop only" for the multi-view feature. Responsive design is important long-term but is a separate initiative that should be scoped holistically, not tacked onto individual features. |
| **Market holiday awareness for `isMarketOpen()`** | A known limitation (noted in `lib/utils.ts`). The fix is straightforward (hardcoded holiday list) but the user impact is narrow (wrong status shown on ~9 days/year). |
| **Dark/light theme toggle** | No user signal requesting this. The dark theme is consistent with the professional financial aesthetic. |
