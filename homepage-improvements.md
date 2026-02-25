# Homepage Improvement Suggestions

## Current State Assessment

`app/page.tsx` is a minimal 18-line Server Component: a vertically centred `<main>` with `SearchBar` and an `<h1>`, plus a `Footer`. The page is clean but sparse — a dark void with a floating search bar. Against references like Bloomberg, Yahoo Finance, and Google Finance, the homepage reads more like a prototype than a product. There is no ambient market context, no reason to trust the app before searching, and no path for users who arrive unsure of what to look for.

---

## Suggestion 1: Ticker Tape (Biggest Movers)

### What it is

A horizontally scrolling strip pinned to the top of the page showing 10–15 prominent tickers (AAPL, MSFT, TSLA, GOOGL, AMZN, META, NVDA, SPY etc.) with their current price and day change in green or red. The strip loops seamlessly via a CSS `@keyframes` animation. Each ticker item is a click target navigating to `/dashboard?symbol=TICKER`.

Visually: a thin bar (~36–40px), `bg-zinc-800` against the page's `bg-zinc-950`, bottom border, mono-spaced ticker data using the existing `font-mono` + `text-zinc-100` / `text-green-400` / `text-red-400` treatment already established in `SearchResults.tsx`.

### Why it fits

The ticker tape is the single most recognisable element of financial media — Bloomberg, CNBC, and Reuters all use it. It immediately signals "live financial data" before the user does anything, and proves the app is connected to real prices.

### Implementation

- New `GET /api/stock/movers` route batching `getQuote()` calls via `Promise.all` across 10–15 hardcoded benchmark symbols.
- Cached using the existing `getCached`/`setCached` pattern in `lib/cache.ts` (60s TTL).
- **Architecture decision required:** the module-level cache resets on cold starts and is not shared across serverless instances. The correct approach is `export const revalidate = 60` (ISR) on the movers route so data is cached at the CDN level rather than per-process. This differs from how the other routes work and should be a deliberate decision before implementation.
- Client component that fetches on mount and re-fetches every 60s via `setInterval`.
- Scroll animation: CSS `@keyframes marquee` in `app/globals.css`, translating X from `0` to `-50%` (list duplicated twice for seamless loop). `@media (prefers-reduced-motion: reduce)` stops the animation and renders the strip statically.
- Rendered as `<nav aria-label="Market movers">` containing an `<ol>` of `<Link>` items. The duplicated copy is `aria-hidden="true"`.

### Trade-offs

- **Rate limit risk:** Finnhub free tier allows 60 calls/min. Fetching 15 symbols in parallel on every page load consumes 15 calls immediately. The ISR approach above is the mitigation.
- Accessibility: animated content requires `prefers-reduced-motion` handling (covered above).
- Duplicate DOM nodes for the loop require `aria-hidden` on the second copy to avoid duplicate screen reader targets.

---

## Suggestion 2: Market Status Bar

### What it is

A slim contextual line (~24px) directly above the search bar showing one of two states:

- **Market open:** small green dot + "US Markets Open" + current Eastern time
- **Market closed:** grey dot + "US Markets Closed" + "Opens [next open day] at 9:30 AM ET"

### Why it fits

Bloomberg and Yahoo Finance always show market status in the header. "Is the market open right now?" is the first contextual question a user has — answering it before they search establishes the app as data-aware.

### Implementation

`isMarketOpen()` is already exported from `lib/utils.ts`. Because `app/page.tsx` is a Server Component, this renders with zero API calls, zero client-side JavaScript, and zero network requests — just a direct function call and a `<p>` element.

### Trade-offs

`isMarketOpen()` does not account for US market holidays (e.g. it will show "Open" on Thanksgiving). Acceptable for an MVP; a future iteration can add a hardcoded holiday list.

---

## Suggestion 3: Recently Viewed Chips

### What it is

A row of pill-shaped chips below the search bar (e.g. "AAPL", "TSLA", "NVDA") that appear only for returning users. Each chip navigates directly to that symbol's dashboard. Ghost treatment: `border border-zinc-700 text-zinc-400`, small, clearly secondary to the search bar.

### Why it fits

Google Finance's homepage shows a Watchlist section. Returning users expect continuity — right now, a user who closed the tab and came back must re-type their search with no shortcuts.

### Implementation

- Reads from the same `sessionStorage` key already managed by `lib/session.ts` (`loadRecent()`).
- Must be a `"use client"` component reading `sessionStorage` inside a `useEffect` (avoids hydration mismatch).
- Renders nothing on server and on first paint if the list is empty — no skeleton, to avoid CLS.

### Trade-offs

`sessionStorage` clears when the browser is closed. `localStorage` would give stronger persistence but is a product/privacy decision — the implementation is identical either way, only the storage key in `lib/session.ts` changes.

---

## Suggestion 4: Headline Tagline Refinement

### What it is

The current `<h1>` reads "Claude Stocks App" in `text-zinc-400` — the app name, not a value proposition. Replace with a confident tagline (e.g. *"Track any stock, instantly"*) and demote the app name to a top-left wordmark in a thin `<header>` bar.

### Why it fits

Bloomberg's search entry says "Search securities". Financial tools project authority. "Claude Stocks App" as a headline reads like a dev placeholder.

### Implementation

Pure `app/page.tsx` and `app/layout.tsx` change — no new components, no new files. The `<title>` in layout metadata stays "Claude Stocks App" for SEO. The visual `<h1>` becomes the tagline; the wordmark in the header is a styled `<span>` or `<p>`, not a heading element.

### Trade-offs

None significant. The heading hierarchy remains correct (one `<h1>` per page) as long as the tagline takes that slot.

---

## Suggestion 5: Subtle Background Texture

### What it is

A faint dot-grid SVG background pattern on the page body with a radial gradient vignette (darker toward the edges, slightly lighter at the centre behind the search bar) to draw the eye to the focal point. Similar to Vercel's and Linear's homepages.

### Why it fits

Bloomberg Terminal uses a grid. Data-heavy financial tools implicitly associate grids with precision and structure. This elevates "empty dark page" to "intentional dark canvas".

### Implementation

A single addition to `app/globals.css`: an SVG data-URI `background-image` on `body`, layered with a `radial-gradient` using CSS `background` shorthand. No JavaScript, no new components, no network requests. `prefers-reduced-motion` is irrelevant (no animation).

### Trade-offs

At low brightness (OLED screens) a dot grid can look noisy. Worth testing on a real OLED device — the opacity threshold that reads "subtle" on a calibrated desktop can look "busy" on a phone display with different gamma.

---

## Priority Ranking

| Priority | Suggestion | Effort | Impact |
|---|---|---|---|
| 1 | Market Status Bar | Very Low | High |
| 2 | Headline Tagline Refinement | Very Low | Medium |
| 3 | Recently Viewed Chips | Low | High |
| 4 | Ticker Tape | Medium–High | Very High |
| 5 | Background Texture | Very Low | Low |

**Recommended order:** Ship the Market Status Bar and Tagline Refinement first — both are near-zero effort and immediate professionalism upgrades. Add Recently Viewed Chips next as they directly improve returning-user UX using infrastructure already in place. Tackle the Ticker Tape in a dedicated feature branch after deciding on the ISR vs. module-cache architecture for the movers endpoint.
