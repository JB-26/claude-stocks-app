# Claude Stocks App

A professional stock market dashboard built with Deno, Next.js, and TypeScript. Search for any company, view the current stock price, a historical price chart, and a company news feed — all in one place.

---

## How This App Was Built

This project was a deliberate experiment in human-agent collaboration. Each stage of the build had a clear owner.

### 1. Designed by Joshua Blewitt

Joshua wrote the product requirements in [`requirements-documentation.md`](./requirements-documentation.md). This document defines:

- The core user flow (search → select → dashboard)
- The tech stack choices (Deno, Next.js, TypeScript, Tailwind, Chart.js, Shadcn)
- The visual design language — a professional, financial aesthetic inspired by Tesla's design system, with colour-coded button semantics (green = confirm, red = delete, yellow = edit)
- The user stories that define what the app must do

The requirements document was written before any code was written, giving the agents a clear brief to work from.

### 2. Planned by Agents

Three specialised agents translated the requirements into detailed plans:

- **Solution Architect agent** produced [`architecture.md`](./architecture.md) — a comprehensive technical blueprint covering the folder structure, component breakdown, data flow diagrams, API selection rationale, security model, state management strategy, and a 16-task implementation plan with dependencies.

- **QA Strategist agent** produced [`test-plan.md`](./test-plan.md) — a three-layer testing strategy covering unit tests (Deno's built-in test library), integration tests, and Playwright E2E tests, with each test mapped to a specific user story and acceptance criterion.

Both documents were produced using context7 to access up-to-date documentation for Deno, Next.js, Playwright, Finnhub, and Chart.js.

### 3. Built by Claude Code

Claude Code implemented the entire application by working through the 16-task plan in `architecture.md`. Each task was completed, committed, and verified before moving to the next.

---

## Human Feedback Along the Way

This wasn't a fully automated build. Joshua reviewed the work at each stage and provided feedback that meaningfully shaped the final application. Here are the key moments:

**Search wasn't returning results.**
After the search feature was implemented, Joshua tested it and found no results were appearing. This led to the discovery of a bug in the Finnhub search filter — the code was filtering by a `mic` field that Finnhub doesn't always include in free-tier responses, causing all results to be silently dropped. Removing the overly strict filter fixed search immediately.

**Chart data failed to load.**
Joshua spotted that the historical price chart was broken and shared the browser error. Investigating the server logs revealed that Finnhub's `/stock/candle` endpoint — listed as available on the free tier in their documentation — actually returns a 403 for free accounts. The candles data source was switched to Yahoo Finance's chart API, which works reliably without authentication.

**Layout preference: vertical stack over side-by-side.**
After the styling pass, a two-column grid layout was proposed (chart on the left, news on the right). Joshua preferred the original vertical layout — chart above news — because it let both panels use the full page width. The layout was reverted to match his preference.

**Company logo suggestion.**
Joshua suggested adding a company logo next to the stock ticker and price on the dashboard, to give users a visual anchor for the company they're viewing. This became a post-launch feature: a new `/api/stock/profile` route fetches the logo URL from Finnhub's profile endpoint, and a `CompanyLogo` component renders it with graceful fallback if no logo is available.

**Branch discipline.**
Before the logo changes were committed, Joshua asked to create a dedicated `features/company-logo` branch. This was a good reminder to follow the branching strategy laid out in the architecture plan — one feature branch per feature, merged to `main` via pull request.

**CI/CD to reduce feedback loops.**
Joshua suggested adding a GitHub Actions workflow so that tests would run automatically on every push, rather than requiring manual test runs during development. This produced two parallel CI jobs — one for unit tests, one for Playwright E2E tests — and caught two real bugs in the process: a working directory issue in the Playwright config that only manifested in CI (fixed by switching from `import.meta.url` to `process.cwd()`).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Deno 2.x |
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict mode) |
| Styling | Tailwind CSS v4 |
| UI Components | Shadcn |
| Charting | Chart.js + react-chartjs-2 |
| Stock data | Finnhub (search, quotes, news, company profile) |
| Historical data | Yahoo Finance (price chart) |
| Unit testing | Deno built-in test library |
| E2E testing | Playwright |
| CI | GitHub Actions |

---

## Getting Started

### Prerequisites

- [Deno 2.x](https://deno.com)
- A free [Finnhub API key](https://finnhub.io/register)

### Setup

```bash
# Clone the repository
git clone <repo-url>
cd claude-stocks-app

# Copy the environment template and add your API key
cp .env.example .env.local
# Edit .env.local and set FINNHUB_API_KEY=your_key_here

# Install dependencies
deno install

# Start the development server
deno task dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Running Tests

```bash
# Unit tests
deno task test

# Playwright E2E tests
deno task test:e2e
```

---

## Project Structure

```
├── app/
│   ├── page.tsx                  # Homepage (search bar + title + footer)
│   ├── dashboard/page.tsx        # Dashboard page
│   └── api/stock/                # API route handlers (proxy to Finnhub / Yahoo Finance)
├── components/
│   ├── search/                   # SearchBar, SearchResults
│   ├── dashboard/                # PriceHeader, StockChart, NewsFeed, CompanySelector, CompanyLogo
│   └── layout/                   # Header, Footer
├── lib/
│   ├── finnhub/                  # Typed Finnhub API client + types
│   ├── yahoo.ts                  # Yahoo Finance historical data client
│   ├── cache.ts                  # Server-side TTL cache
│   └── utils.ts                  # Date helpers, number formatters
├── hooks/
│   └── useDebounce.ts
├── tests/
│   ├── unit/                     # Deno unit tests
│   └── e2e/                      # Playwright E2E tests
├── architecture.md               # Full technical plan (Solution Architect agent)
├── test-plan.md                  # Full test strategy (QA Strategist agent)
└── requirements-documentation.md # Product requirements (Joshua Blewitt)
```

---

## Security

- The Finnhub API key is stored in `.env.local` and never committed.
- All external API calls are proxied through Next.js Route Handlers on the server — the key is never sent to the browser.
- The `server-only` package guards `lib/finnhub/client.ts` against accidental client-side imports.
- Input parameters (`symbol`, `range`, search query) are validated and sanitised in every Route Handler before being forwarded upstream.
