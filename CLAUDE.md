# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Stocks App is a stock market dashboard web application. Users search for a company, select it from results, and are shown a dashboard with the current stock value, a historical price chart, and a news feed.

## Tech Stack

- **Runtime**: Deno
- **Framework**: Next.js (with TypeScript)
- **Styling**: Tailwind CSS
- **UI Components**: Shadcn
- **Charting**: Chart.js
- **Testing**: Deno's built-in test library + Playwright (E2E)

## Commands

> Commands will be confirmed and added here once the project is scaffolded with Deno + Next.js.

Typical Deno + Next.js commands will follow this pattern:

```bash
# Development
deno task dev

# Build
deno task build

# Run tests (unit)
deno test

# Run a single test file
deno test path/to/file.test.ts

# Run Playwright E2E tests
deno task test:e2e
```

## Architecture

### Core User Flow

1. **Homepage** — Search bar centered on screen with app title below it and a footer.
2. **Search** — As the user types, results populate from a stock data API. User selects a company.
3. **Dashboard** — Displays current stock price, a Chart.js historical price chart, and a company news feed. Users can switch companies via a dropdown.

### Agent Responsibilities

When implementing new features, use the appropriate specialized agent:

- **solution-architect** — Technology and system design decisions (use context7)
- **frontend-craft** — UI components and styling (use context7)
- **qa-strategist** — Test planning and coverage (use context7)

### Styling Conventions

- Professional/financial aesthetic, similar to Tesla's design language
- Font: closest match to "Universal Sans Display"
- Button color semantics:
  - Green → positive/confirm actions (e.g., Search)
  - Red → destructive actions (e.g., Delete chart)
  - Yellow → edit/modify actions (e.g., Edit summary)

### Data Fetching

Stock data should come from a free public API (TBD — to be decided during planning). API calls to external stock services should be proxied through a Next.js API route to avoid exposing keys on the client.

### Testing

User stories in `requirements-documentation.md` define the acceptance criteria for tests. Unit tests cover individual utilities and components; Playwright E2E tests cover the three core flows: homepage render, search, and dashboard population.

### Branching

Feature branches off `main`. Each new feature gets its own branch before being merged.
