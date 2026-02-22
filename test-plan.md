# Claude Stocks App — Test Plan

**Version**: 1.1
**Date**: 2026-02-21
**Author**: QA Strategist Agent
**Status**: Authoritative — pre-implementation

---

## Table of Contents

1. [Testing Strategy Overview](#1-testing-strategy-overview)
2. [Risk Assessment](#2-risk-assessment)
3. [Unit Tests](#3-unit-tests)
4. [Integration Tests](#4-integration-tests)
5. [E2E Tests (Playwright)](#5-e2e-tests-playwright)
6. [Error State Coverage](#6-error-state-coverage)
7. [Security Tests](#7-security-tests)
8. [Test Data and Fixtures](#8-test-data-and-fixtures)
9. [Coverage Targets](#9-coverage-targets)
10. [Test Execution and CI](#10-test-execution-and-ci)

---

## 1. Testing Strategy Overview

### 1.1 Layer Responsibilities

The test suite is structured in three distinct layers. Each layer has a defined responsibility and tool set. No layer duplicates the concerns of another.

| Layer | Tool | Location | Purpose |
|---|---|---|---|
| Unit | Deno native test runner + `@std/assert` | `tests/unit/` | Pure TypeScript logic: cache TTL, formatters, market hours, input validation, Finnhub client URL construction |
| Integration | Deno native test runner + `@std/assert` | `tests/integration/` | Next.js Route Handler behaviour: request validation, Finnhub client wiring, response shape, error propagation |
| E2E | Playwright (`@playwright/test` 1.51+) | `tests/e2e/` | Full browser flows mapped directly to the three user stories in `requirements-documentation.md` |

### 1.2 Tool Selection Rationale

**Deno test runner** is used for unit and integration tests because:
- It is the project's native runtime (Deno 2.x, `deno task test`).
- No additional test framework installation is required.
- `@std/assert` provides `assertEquals`, `assertThrows`, `assertRejects`, `assertObjectMatch`, `assertMatch`, and `assertArrayIncludes` — sufficient for all pure-logic assertions.
- `@std/testing/mock` provides `stub`, `spy`, and `assertSpyCalls` for mocking `globalThis.fetch` and asserting call counts.
- `@std/testing/time` provides `FakeTime` for deterministic control over `Date.now()` in `isMarketOpen` tests.
- Unit tests must use relative imports (e.g., `../../lib/cache.ts`) because the Next.js `@/` path alias is not available in Deno's module resolution.

**Playwright** is used for E2E tests because:
- The three user stories require real browser interaction (typing, clicking, navigation, visual rendering).
- `page.route()` enables deterministic API mocking — tests never depend on the live Finnhub API, preventing rate-limit flakiness in CI.
- `@playwright/test` 1.51.0 is listed in `package.json` devDependencies.

### 1.3 How the Layers Relate

```
Unit Tests (fast, ~2s)
  └── Verify: cache TTL, date math, formatters, symbol validation, URL building

Integration Tests (medium, ~10s)
  └── Verify: Route Handler request/response contracts, error codes, caching behaviour

E2E Tests (slowest, ~60s)
  └── Verify: user stories end-to-end, UI rendering, navigation, error UI
```

The unit and integration tests provide fast feedback on business logic regressions. The E2E suite validates that the assembled application meets the acceptance criteria from `requirements-documentation.md`. If a unit test fails, the defect is in a library function. If only an E2E test fails, the defect is likely in component wiring, state management, or UI rendering.

### 1.4 User Story Mapping

Every E2E test traces back to a user story from `requirements-documentation.md`. The mapping is:

| User Story | Spec File | Test IDs |
|---|---|---|
| "Given I open the application... I can see the title, a search bar, and a footer" | `tests/e2e/homepage.spec.ts` | E2E-HOME-01 through E2E-HOME-06 |
| "When I search for a company, the search bar populates with results" | `tests/e2e/search.spec.ts` | E2E-SRCH-01 through E2E-SRCH-08 |
| "When I click on the chosen company, the dashboard appears" | `tests/e2e/search.spec.ts` | E2E-SRCH-03 |
| "I can see the current value, a chart, and a news feed" | `tests/e2e/dashboard.spec.ts` | E2E-DASH-01 through E2E-DASH-07 |

### 1.5 Commands

```bash
# Run all unit tests
deno task test

# Run a specific unit test file
deno test tests/unit/cache.test.ts --allow-env --allow-read

# Run all integration tests
deno test tests/integration/ --allow-net --allow-env --allow-read

# Run unit + integration with coverage
deno task test:coverage

# Run E2E tests (headless)
deno task test:e2e

# Run E2E tests with Playwright UI (debugging)
npx playwright test --config=tests/e2e/playwright.config.ts --ui
```

---

## 2. Risk Assessment

The following risk classifications drive test prioritisation. Higher-risk items have more extensive test cases.

| Component | Risk | Severity | Likelihood | Rationale |
|---|---|---|---|---|
| API key exposure | Client bundle or API response contains `FINNHUB_API_KEY` | Critical | Low | Key is server-only with `server-only` guard; but one misconfigured `NEXT_PUBLIC_` prefix would expose it to every browser |
| Input validation (symbol/query/range) | Malformed input forwarded to Finnhub | Critical | Medium | Injection/SSRF risk if Route Handler validation is bypassed |
| `lib/cache.ts` TTL logic | Stale data served after expiry; or cache never expires (memory leak) | High | Medium | Module-scoped Map is long-lived in serverless warm instances |
| `isMarketOpen` computation | Wrong timezone handling produces incorrect badge | High | Medium | Date arithmetic with ET offsets and DST transitions is error-prone |
| Finnhub `s: "no_data"` candle response | Chart renders empty or crashes when Finnhub returns no candle data | High | High | Free-tier known limitation for some symbols; tested explicitly |
| `useDebounce` timing | Excessive Finnhub calls from rapid typing; or results lag unacceptably | Medium | Medium | Debounce delay of 350 ms is specified; covered by E2E debounce test |
| `CompanySelector` sessionStorage | Stale symbol list after browser refresh; crash if sessionStorage unavailable | Medium | Low | sessionStorage is unavailable in some embedded/private-browsing contexts |
| Per-panel error isolation | One failing panel causes all three panels to fail | Medium | Low | Architecture guarantees per-panel independence; tested with cross-panel mocks |
| Chart.js dynamic import | SSR crash if `next/dynamic` with `{ ssr: false }` is omitted or misconfigured | Medium | Medium | Chart.js cannot run server-side; confirmed risk in architecture docs |
| Candle `range` parameter | Missing or invalid range breaks dashboard chart silently | Medium | Medium | Route Handler must validate against allowlist `['1M', '3M', '1Y']` |

---

## 3. Unit Tests

Unit tests live in `tests/unit/` and are run with `deno task test`. All tests use `Deno.test()` and `@std/assert`. Tests are pure: no HTTP calls, no DOM, no Next.js runtime.

**Import pattern**: Because the Next.js `@/` path alias does not work under Deno's module resolver, unit tests must use relative imports pointing directly into `lib/` (e.g., `../../lib/cache.ts`). If a source file cannot be cleanly imported by Deno (e.g., due to `server-only` or JSX), the function under test should be extracted to a pure `.ts` utility file before writing tests.

**Assertion imports**:

```typescript
import { assertEquals, assertRejects, assertObjectMatch, assertMatch } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";
import { FakeTime } from "jsr:@std/testing/time";
```

---

### 3.1 `tests/unit/cache.test.ts`

Tests the `getCached<T>` and `setCached<T>` functions from `lib/cache.ts`.

**File under test**: `lib/cache.ts`

| Test ID | Description | Input / Setup | Expected Output | Priority |
|---|---|---|---|---|
| CACHE-01 | Miss on empty cache | `getCached("nonexistent")` | `null` | Critical |
| CACHE-02 | Hit before TTL expires | `setCached("k", "v", 5000)` then `getCached("k")` immediately | `"v"` | Critical |
| CACHE-03 | Miss after TTL expires | `setCached("k", "v", 1)` then wait 10 ms, call `getCached("k")` | `null` | Critical |
| CACHE-04 | Overwrite existing key | `setCached("k", "v1", 5000)` then `setCached("k", "v2", 5000)`, `getCached("k")` | `"v2"` | High |
| CACHE-05 | TTL reset on overwrite | `setCached("k", "v", 1)` then `setCached("k", "v", 5000)` immediately, wait 10 ms, `getCached("k")` | `"v"` (TTL was reset, not expired) | High |
| CACHE-06 | Type is preserved (number) | `setCached("n", 42, 5000)`, `getCached<number>("n")` | `42` | Medium |
| CACHE-07 | Type is preserved (object) | `setCached("obj", { a: 1 }, 5000)`, `getCached<{a: number}>("obj")` | `{ a: 1 }` | Medium |
| CACHE-08 | Different keys are independent | Set `"k1"` = `"a"` (TTL 1 ms), set `"k2"` = `"b"` (TTL 5000 ms), wait 10 ms | `getCached("k1")` = `null`, `getCached("k2")` = `"b"` | High |
| CACHE-09 | Zero TTL expires immediately | `setCached("k", "v", 0)`, `getCached("k")` called synchronously | `null` (expires at call time or before) | Medium |

**Example test structure:**

```typescript
// tests/unit/cache.test.ts
import { assertEquals } from "jsr:@std/assert";
import { getCached, setCached } from "../../lib/cache.ts";

// Use unique key suffixes to prevent cross-test pollution in the module-scoped Map
Deno.test("CACHE-01: returns null on cache miss", () => {
  const result = getCached<string>("nonexistent-key-" + Date.now());
  assertEquals(result, null);
});

Deno.test("CACHE-02: returns value before TTL expires", () => {
  const key = "cache-hit-" + Date.now();
  setCached(key, "hello", 5000);
  assertEquals(getCached<string>(key), "hello");
});

Deno.test("CACHE-03: returns null after TTL expires", async () => {
  const key = "cache-ttl-" + Date.now();
  setCached(key, "value", 1); // 1 ms TTL
  await new Promise(resolve => setTimeout(resolve, 10));
  assertEquals(getCached<string>(key), null);
});

Deno.test("CACHE-08: different keys are independent", async () => {
  const k1 = "expire-key-" + Date.now();
  const k2 = "persist-key-" + Date.now();
  setCached(k1, "a", 1);
  setCached(k2, "b", 5000);
  await new Promise(resolve => setTimeout(resolve, 10));
  assertEquals(getCached<string>(k1), null);
  assertEquals(getCached<string>(k2), "b");
});
```

---

### 3.2 `tests/unit/utils.test.ts`

Tests utility functions in `lib/utils.ts`: number formatters, date range computation, `RANGE_DAYS` mapping, and `isMarketOpen` computation.

**File under test**: `lib/utils.ts`

**Note**: `RANGE_DAYS` and `isMarketOpen` must live in `lib/utils.ts` (not inside a React component file) to be importable by Deno unit tests without a JSX compiler.

#### 3.2.1 Number Formatters

| Test ID | Description | Input | Expected Output | Priority |
|---|---|---|---|---|
| FMT-01 | Format positive price (typical) | `formatPrice(185.43)` | `"$185.43"` | High |
| FMT-02 | Format price with more than 2 decimal places | `formatPrice(185.4321)` | `"$185.43"` (rounded to 2 dp) | High |
| FMT-03 | Format price of zero | `formatPrice(0)` | `"$0.00"` | Medium |
| FMT-04 | Format negative price | `formatPrice(-10.50)` | `"-$10.50"` | Medium |
| FMT-05 | Format large price (Berkshire-style) | `formatPrice(500000)` | `"$500,000.00"` | Medium |
| FMT-06 | Format positive percent change | `formatPercentChange(2.34)` | `"+2.34%"` | High |
| FMT-07 | Format negative percent change | `formatPercentChange(-1.25)` | `"-1.25%"` | High |
| FMT-08 | Format zero percent change | `formatPercentChange(0)` | `"0.00%"` | Medium |

#### 3.2.2 `RANGE_DAYS` Mapping

| Test ID | Description | Input | Expected Output | Priority |
|---|---|---|---|---|
| RNG-01 | 1M maps to 30 days | `RANGE_DAYS['1M']` | `30` | High |
| RNG-02 | 3M maps to 90 days | `RANGE_DAYS['3M']` | `90` | High |
| RNG-03 | 1Y maps to 365 days | `RANGE_DAYS['1Y']` | `365` | High |

#### 3.2.3 Date Range Computation

These tests verify `computeDateRange(range: ChartRange): { from: number; to: number }`, which produces Unix timestamps for candle requests. The function lives in `lib/utils.ts` and is called by the candles Route Handler.

| Test ID | Description | Input / Setup | Expected Behaviour | Priority |
|---|---|---|---|---|
| DATE-01 | 1M `to` is approximately equal to now | `computeDateRange('1M').to` | Within 5 seconds of `Math.floor(Date.now() / 1000)` | High |
| DATE-02 | 1M difference is approximately 30 days | `computeDateRange('1M')`: `to - from` | Between `29 * 86400` and `31 * 86400` seconds | High |
| DATE-03 | 3M difference is approximately 90 days | `computeDateRange('3M')`: `to - from` | Between `89 * 86400` and `91 * 86400` seconds | High |
| DATE-04 | 1Y difference is approximately 365 days | `computeDateRange('1Y')`: `to - from` | Between `364 * 86400` and `366 * 86400` seconds | High |
| DATE-05 | `from` is always less than `to` for all ranges | All three ranges | `from < to` in every case | Critical |

#### 3.2.4 `isMarketOpen` Computation

These tests verify the server-side function that determines whether NYSE regular trading hours are active. The function signature is `isMarketOpen(nowUtcMs: number): boolean`.

Tests use fixed UTC timestamps to eliminate flakiness from real-time execution. NYSE regular hours are 09:30–16:00 Eastern Time (ET). ET is UTC-5 in winter (EST) and UTC-4 in summer (EDT).

**Note on `FakeTime`**: `FakeTime` from `@std/testing/time` is used here only if `isMarketOpen` reads `Date.now()` internally rather than accepting a parameter. The preferred implementation accepts `nowUtcMs` as a parameter (pure function), which makes `FakeTime` unnecessary and makes tests simpler.

| Test ID | Description | Input (UTC timestamp) | Expected | Priority |
|---|---|---|---|---|
| MKT-01 | Wednesday at 12:00 EST (market open) | `new Date('2026-02-18T17:00:00Z').getTime()` (12:00 EST = 17:00 UTC) | `true` | Critical |
| MKT-02 | Wednesday at 09:29 EST (one minute before open) | `new Date('2026-02-18T14:29:00Z').getTime()` | `false` | Critical |
| MKT-03 | Wednesday at 09:30 EST (exactly at open) | `new Date('2026-02-18T14:30:00Z').getTime()` | `true` | Critical |
| MKT-04 | Wednesday at 16:00 EST (exactly at close) | `new Date('2026-02-18T21:00:00Z').getTime()` | `false` | Critical |
| MKT-05 | Wednesday at 15:59 EST (one minute before close) | `new Date('2026-02-18T20:59:00Z').getTime()` | `true` | Critical |
| MKT-06 | Saturday at 12:00 EST (weekend) | `new Date('2026-02-21T17:00:00Z').getTime()` | `false` | High |
| MKT-07 | Sunday at 12:00 EST (weekend) | `new Date('2026-02-22T17:00:00Z').getTime()` | `false` | High |
| MKT-08 | Summer DST: Wednesday at 12:00 EDT | `new Date('2026-07-15T16:00:00Z').getTime()` (12:00 EDT = 16:00 UTC) | `true` | High |
| MKT-09 | Summer DST: Wednesday at 09:30 EDT | `new Date('2026-07-15T13:30:00Z').getTime()` | `true` | High |
| MKT-10 | Summer DST: boundary at 09:29 EDT | `new Date('2026-07-15T13:29:00Z').getTime()` | `false` | High |

**Example:**

```typescript
// tests/unit/utils.test.ts
import { assertEquals } from "jsr:@std/assert";
import { isMarketOpen } from "../../lib/utils.ts";

Deno.test("MKT-01: market open at 12:00 EST on a weekday", () => {
  const ts = new Date("2026-02-18T17:00:00Z").getTime(); // 12:00 EST
  assertEquals(isMarketOpen(ts), true);
});

Deno.test("MKT-04: market closed at exactly 16:00 EST", () => {
  const ts = new Date("2026-02-18T21:00:00Z").getTime(); // 16:00 EST
  assertEquals(isMarketOpen(ts), false);
});

Deno.test("MKT-06: market closed on Saturday", () => {
  const ts = new Date("2026-02-21T17:00:00Z").getTime(); // Saturday
  assertEquals(isMarketOpen(ts), false);
});

Deno.test("MKT-08: market open at 12:00 EDT (summer DST)", () => {
  const ts = new Date("2026-07-15T16:00:00Z").getTime(); // 12:00 EDT
  assertEquals(isMarketOpen(ts), true);
});
```

---

### 3.3 `tests/unit/finnhub-client.test.ts`

Tests `lib/finnhub/client.ts` — the typed Finnhub fetch wrapper. Finnhub network calls are intercepted using `stub` from `@std/testing/mock`.

**File under test**: `lib/finnhub/client.ts`

**Mocking approach**: Use `stub(globalThis, "fetch", ...)` to intercept all `fetch` calls. The stub is restored in a `finally` block to prevent cross-test contamination. Set `Deno.env.set("FINNHUB_API_KEY", "test-key")` in test setup.

```typescript
// tests/unit/finnhub-client.test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";
import { searchSymbols, getQuote, getCandles, getCompanyNews } from "../../lib/finnhub/client.ts";
import { SEARCH_FIXTURE, QUOTE_FIXTURE_MARKET_OPEN, CANDLES_FIXTURE_3M, NEWS_FIXTURE_RAW } from "../fixtures/index.ts";

function makeFetchStub(responseBody: unknown, status = 200) {
  return stub(globalThis, "fetch", () =>
    Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
}
```

#### 3.3.1 `searchSymbols(query)`

| Test ID | Description | Mocked Response | Expected Behaviour | Priority |
|---|---|---|---|---|
| CLI-01 | Constructs correct Finnhub URL for search | `SEARCH_FIXTURE` | Request URL contains `/search?q=Apple` | Critical |
| CLI-02 | Sends `X-Finnhub-Token` header, not query param | `SEARCH_FIXTURE` | Captured request has `X-Finnhub-Token: test-key`; URL does not contain `token=` | Critical |
| CLI-03 | Returns parsed `FinnhubSearchResponse` on success | `SEARCH_FIXTURE` (200) | Result matches fixture shape | High |
| CLI-04 | Throws on non-200 response | 500 status | `assertRejects` — error is thrown | High |
| CLI-05 | Handles empty result set | `{ count: 0, result: [] }` | Returns object with `result: []` without error | Medium |

#### 3.3.2 `getQuote(symbol)`

| Test ID | Description | Mocked Response | Expected Behaviour | Priority |
|---|---|---|---|---|
| CLI-06 | Constructs correct URL for quote | `QUOTE_FIXTURE_MARKET_OPEN` | Request URL contains `/quote?symbol=AAPL` | Critical |
| CLI-07 | Returns `FinnhubQuote` shape on success | `QUOTE_FIXTURE_MARKET_OPEN` | Fields `c`, `d`, `dp`, `h`, `l`, `o`, `pc`, `t` all present | High |
| CLI-08 | Throws on 403 (invalid API key) | 403 status, `{"error": "API limit reached"}` | `assertRejects` | High |

#### 3.3.3 `getCandles(symbol, from, to)`

| Test ID | Description | Mocked Response | Expected Behaviour | Priority |
|---|---|---|---|---|
| CLI-09 | Constructs correct URL with `resolution=D` | `CANDLES_FIXTURE_3M` | URL contains `resolution=D`, `from=`, `to=` | Critical |
| CLI-10 | Returns `FinnhubCandles` with `t` and `c` arrays | `CANDLES_FIXTURE_3M` | `t` and `c` are number arrays of equal length | High |
| CLI-11 | Returns `s: "no_data"` response as-is | `{ s: "no_data" }` | Returns the object unchanged; Route Handler decides how to handle it | High |

#### 3.3.4 `getCompanyNews(symbol, from, to)`

| Test ID | Description | Mocked Response | Expected Behaviour | Priority |
|---|---|---|---|---|
| CLI-12 | Constructs correct URL for company news | `NEWS_FIXTURE_RAW` | URL contains `/company-news?symbol=AAPL`, `from=`, `to=` | Critical |
| CLI-13 | Returns array of `FinnhubNewsArticle` | `NEWS_FIXTURE_RAW` | Each article has `headline`, `source`, `summary`, `url`, `datetime` | High |
| CLI-14 | Returns empty array when no news | `[]` | Returns `[]` without error | Medium |

#### 3.3.5 Input Validation

These tests verify `validateSymbol(symbol: string): boolean`, `sanitizeQuery(query: string): string`, and `validateRange(range: string): boolean` from `lib/utils.ts`.

| Test ID | Description | Input | Expected | Priority |
|---|---|---|---|---|
| VAL-01 | Valid ticker passes symbol check | `"AAPL"` | `true` | Critical |
| VAL-02 | Lowercase ticker fails | `"aapl"` | `false` | Critical |
| VAL-03 | Symbol too long (>10 chars) fails | `"AAPLLLLLLLL"` | `false` | High |
| VAL-04 | Empty string fails | `""` | `false` | High |
| VAL-05 | Symbol with numbers fails | `"AAP1"` | `false` | High |
| VAL-06 | Symbol with special chars fails | `"A<script>"` | `false` | Critical |
| VAL-07 | Valid single-letter ticker passes | `"A"` | `true` | Medium |
| VAL-08 | Exactly 10 uppercase letters passes | `"AAAAAAAAAA"` | `true` | Medium |
| VAL-09 | Valid query string returned unchanged | `"Apple Inc"` | `"Apple Inc"` | High |
| VAL-10 | Query with disallowed chars is stripped | `"Apple<script>"` | `"Apple"` (chars outside `[A-Za-z0-9 .\-&]` removed) | Critical |
| VAL-11 | Query longer than reasonable limit is truncated | 300-character string | Truncated to max allowed length (implementation-defined, e.g. 100) | Medium |
| VAL-12 | Valid range passes | `"3M"` | `true` | High |
| VAL-13 | Invalid range fails | `"5Y"` | `false` | High |
| VAL-14 | Range with wrong case fails | `"1m"` | `false` | High |
| VAL-15 | Empty range fails | `""` | `false` | High |

---

## 4. Integration Tests

Integration tests live in `tests/integration/` and test Next.js Route Handlers at the HTTP contract level. The Route Handler `GET` functions are imported directly and invoked with constructed `Request` objects; the returned `Response` is asserted on. This avoids the complexity of running a full Next.js server while still exercising the full validation + cache + client orchestration path.

**All integration tests must stub `lib/finnhub/client.ts` functions** to return fixture data using `stub` from `@std/testing/mock`. Tests must never make real Finnhub network calls.

**Import pattern:**

```typescript
// tests/integration/search.test.ts
import { assertEquals } from "jsr:@std/assert";
import { stub } from "jsr:@std/testing/mock";
import { GET } from "../../app/api/stock/search/route.ts";
import * as finnhubClient from "../../lib/finnhub/client.ts";
import { SEARCH_FIXTURE } from "../fixtures/index.ts";

Deno.test("INT-SRCH-01: returns US-only results on valid query", async () => {
  const searchStub = stub(finnhubClient, "searchSymbols", () =>
    Promise.resolve(SEARCH_FIXTURE)
  );
  try {
    const req = new Request("http://localhost/api/stock/search?q=Apple");
    const res = await GET(req);
    const json = await res.json();
    assertEquals(res.status, 200);
    // All returned results must be US MIC codes only
    for (const result of json.results) {
      assertEquals(["XNAS", "XNYS", "XASE"].includes(result.mic), true);
    }
  } finally {
    searchStub.restore();
  }
});
```

---

### 4.1 `/api/stock/search` Route Handler

**File**: `app/api/stock/search/route.ts`

| Test ID | Description | Request | Finnhub Mock | Expected Response | Priority |
|---|---|---|---|---|---|
| INT-SRCH-01 | Happy path: valid query returns US-only results | `GET /api/stock/search?q=Apple` | `SEARCH_FIXTURE` (includes US and non-US results) | 200, `{ results: [...] }` — only XNAS/XNYS entries present | Critical |
| INT-SRCH-02 | Empty query returns 400 | `GET /api/stock/search?q=` | Not called | 400, JSON error body | High |
| INT-SRCH-03 | Missing `q` param returns 400 | `GET /api/stock/search` | Not called | 400, JSON error body | High |
| INT-SRCH-04 | Whitespace-only query returns 400 | `GET /api/stock/search?q=%20%20` | Not called | 400 | High |
| INT-SRCH-05 | All non-US results filtered out | `GET /api/stock/search?q=Vodafone` | `SEARCH_FIXTURE_NON_US` | 200, `{ results: [] }` | High |
| INT-SRCH-06 | Finnhub network failure returns 502 | `GET /api/stock/search?q=Apple` | `searchSymbols` throws `TypeError` | 502 or 503, JSON error body | High |
| INT-SRCH-07 | SQL-injection chars are sanitised | `GET /api/stock/search?q=Apple'; DROP TABLE` | Only `Apple` forwarded to Finnhub | 200 or 400; server does not crash | Critical |
| INT-SRCH-08 | XSS payload is sanitised | `GET /api/stock/search?q=<script>alert(1)</script>` | Sanitised string forwarded | 200 with empty results or 400 | Critical |
| INT-SRCH-09 | Very long query is rejected or truncated | 500-character `q` value | Not forwarded as-is | 400 or truncated to max length | Medium |

---

### 4.2 `/api/stock/quote` Route Handler

**File**: `app/api/stock/quote/route.ts`

| Test ID | Description | Request | Finnhub Mock | Expected Response | Priority |
|---|---|---|---|---|---|
| INT-QUOT-01 | Happy path: valid symbol returns quote | `GET /api/stock/quote?symbol=AAPL` | `QUOTE_FIXTURE_MARKET_OPEN` | 200, fields `c`, `d`, `dp`, `h`, `l`, `o`, `pc`, `t`, `isMarketOpen` all present | Critical |
| INT-QUOT-02 | `isMarketOpen` is `true` during market hours | Same request; stub `Date.now` to return midday ET weekday | `QUOTE_FIXTURE_MARKET_OPEN` | `isMarketOpen: true` | Critical |
| INT-QUOT-03 | `isMarketOpen` is `false` outside market hours | Same request; stub `Date.now` to return 8 PM ET | `QUOTE_FIXTURE_MARKET_OPEN` | `isMarketOpen: false` | Critical |
| INT-QUOT-04 | `isMarketOpen` is `false` on weekends | Stub `Date.now` to return Saturday midday ET | `QUOTE_FIXTURE_MARKET_OPEN` | `isMarketOpen: false` | High |
| INT-QUOT-05 | Missing `symbol` param returns 400 | `GET /api/stock/quote` | Not called | 400 | High |
| INT-QUOT-06 | Lowercase symbol returns 400 | `GET /api/stock/quote?symbol=aapl` | Not called | 400 (fails `/^[A-Z]{1,10}$/`) | High |
| INT-QUOT-07 | Symbol too long returns 400 | `GET /api/stock/quote?symbol=AAPLLLLLLLL` | Not called | 400 | High |
| INT-QUOT-08 | Finnhub network failure returns 502 | `GET /api/stock/quote?symbol=AAPL` | `getQuote` throws | 502 or 503 | High |
| INT-QUOT-09 | Cache hit does not call Finnhub twice | Two sequential calls with same symbol | `getQuote` spy — assert call count | Second call returns same data; `getQuote` called exactly once | High |
| INT-QUOT-10 | Response body never contains the API key value | `GET /api/stock/quote?symbol=AAPL`, `FINNHUB_API_KEY=test-sentinel` | `QUOTE_FIXTURE_MARKET_OPEN` | Response body does not contain `"test-sentinel"` | Critical |

---

### 4.3 `/api/stock/candles` Route Handler

**File**: `app/api/stock/candles/route.ts`

| Test ID | Description | Request | Finnhub Mock | Expected Response | Priority |
|---|---|---|---|---|---|
| INT-CND-01 | Happy path: 3M range returns candle data | `GET /api/stock/candles?symbol=AAPL&range=3M` | `CANDLES_FIXTURE_3M` | 200, `{ t: number[]; c: number[]; s: "ok" }` | Critical |
| INT-CND-02 | 1M range is accepted | `GET /api/stock/candles?symbol=AAPL&range=1M` | `CANDLES_FIXTURE_1M` | 200 | High |
| INT-CND-03 | 1Y range is accepted | `GET /api/stock/candles?symbol=AAPL&range=1Y` | `CANDLES_FIXTURE_1Y` | 200 | High |
| INT-CND-04 | Invalid range `5Y` returns 400 | `GET /api/stock/candles?symbol=AAPL&range=5Y` | Not called | 400 | Critical |
| INT-CND-05 | Missing `range` param returns 400 | `GET /api/stock/candles?symbol=AAPL` | Not called | 400 | High |
| INT-CND-06 | Missing `symbol` param returns 400 | `GET /api/stock/candles?range=3M` | Not called | 400 | High |
| INT-CND-07 | Finnhub returns `s: "no_data"` — passed through cleanly | `GET /api/stock/candles?symbol=XXXX&range=3M` | `CANDLES_FIXTURE_NO_DATA` | 200 with `{ s: "no_data" }`, or 404 with a structured error body; must not crash | High |
| INT-CND-08 | `from` timestamp is before `to` in Finnhub call | `GET /api/stock/candles?symbol=AAPL&range=1M` | Spy on `getCandles` — inspect arguments | `from < to` in the arguments passed to `getCandles` | Critical |
| INT-CND-09 | 3M `from` is approximately 90 days before `to` | `GET /api/stock/candles?symbol=AAPL&range=3M` | Spy on `getCandles` | `to - from` is between 89 and 91 days in seconds | High |
| INT-CND-10 | Finnhub network failure returns 502 | Any valid request | `getCandles` throws | 502 or 503 | High |
| INT-CND-11 | Cache hit does not call Finnhub twice | Two identical requests | `getCandles` spy — assert call count = 1 | Second response identical; call count = 1 | High |

---

### 4.4 `/api/stock/news` Route Handler

**File**: `app/api/stock/news/route.ts`

| Test ID | Description | Request | Finnhub Mock | Expected Response | Priority |
|---|---|---|---|---|---|
| INT-NEWS-01 | Happy path: returns up to 10 articles | `GET /api/stock/news?symbol=AAPL` | `NEWS_FIXTURE_RAW` (15 articles) | 200, `{ articles: [...] }`, array length `<= 10` | Critical |
| INT-NEWS-02 | Returns all articles when fewer than 10 available | `GET /api/stock/news?symbol=AAPL` | `NEWS_FIXTURE_RAW` (3 articles) | 200, `{ articles: [...] }`, array length = 3 | High |
| INT-NEWS-03 | Returns empty array when Finnhub returns `[]` | `GET /api/stock/news?symbol=AAPL` | `[]` | 200, `{ articles: [] }` | Medium |
| INT-NEWS-04 | Missing `symbol` param returns 400 | `GET /api/stock/news` | Not called | 400 | High |
| INT-NEWS-05 | Lowercase symbol returns 400 | `GET /api/stock/news?symbol=aapl` | Not called | 400 | High |
| INT-NEWS-06 | Finnhub network failure returns 502 | `GET /api/stock/news?symbol=AAPL` | `getCompanyNews` throws | 502 or 503 | High |
| INT-NEWS-07 | Cache TTL: second call within 5 minutes does not re-fetch | Two sequential calls | `getCompanyNews` spy — call count = 1 | Second call returns cached data | High |
| INT-NEWS-08 | News window is approximately 30 days | Spy on `getCompanyNews` — inspect `from`/`to` arguments | `NEWS_FIXTURE_RAW` | `to - from` is approximately 30 days (in date string difference) | Medium |

---

## 5. E2E Tests (Playwright)

E2E tests live in `tests/e2e/` and run via `deno task test:e2e`. The Playwright config at `tests/e2e/playwright.config.ts` auto-starts the Next.js dev server.

**Critical rule**: All tests must set up `page.route()` interceptors before calling `page.goto()`. Tests must never depend on the live Finnhub API. Route mocks are set up per-test to guarantee isolation.

**Playwright config** (`tests/e2e/playwright.config.ts`):

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './',
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: 'http://localhost:3000',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'deno run -A --unstable-bare-node-builtins --unstable-sloppy-imports npm:next dev',
    url: 'http://localhost:3000',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
```

**Shared route mock helper** (`tests/e2e/helpers/mock-api.ts`):

```typescript
// tests/e2e/helpers/mock-api.ts
import type { Page } from '@playwright/test';
import {
  SEARCH_FIXTURE,
  QUOTE_FIXTURE_MARKET_OPEN,
  CANDLES_FIXTURE_3M,
  NEWS_FIXTURE,
} from '../fixtures/index.ts';

export async function mockDashboardAPIs(page: Page, overrides: {
  quote?: object;
  candles?: object;
  news?: object;
} = {}) {
  await page.route('**/api/stock/quote**', route =>
    route.fulfill({ json: overrides.quote ?? QUOTE_FIXTURE_MARKET_OPEN })
  );
  await page.route('**/api/stock/candles**', route =>
    route.fulfill({ json: overrides.candles ?? CANDLES_FIXTURE_3M })
  );
  await page.route('**/api/stock/news**', route =>
    route.fulfill({ json: overrides.news ?? NEWS_FIXTURE })
  );
}
```

---

### 5.1 `tests/e2e/homepage.spec.ts`

**User story**: "Given I open the application, when I look for components, then I can see the title 'Claude Stocks App', a search bar above it, and a footer."

No API mocks are needed for homepage tests — the homepage performs no data fetching on load.

| Test ID | Description | Setup | Steps | Expected Assertions | Priority |
|---|---|---|---|---|---|
| E2E-HOME-01 | Page title heading is visible | None | `page.goto('/')` | `page.getByRole('heading', { name: 'Claude Stocks App' })` is visible | Critical |
| E2E-HOME-02 | Search bar is visible | None | `page.goto('/')` | `page.getByRole('searchbox')` (or `page.getByPlaceholder(...)`) is visible | Critical |
| E2E-HOME-03 | Footer is visible | None | `page.goto('/')` | `page.getByRole('contentinfo')` is visible | Critical |
| E2E-HOME-04 | Search bar is above the title | None | `page.goto('/')` | Search bar `boundingBox().y` is less than heading `boundingBox().y` | High |
| E2E-HOME-05 | Document `<title>` reflects app name | None | `page.goto('/')` | `page.title()` contains `"Claude Stocks App"` | Medium |
| E2E-HOME-06 | No dashboard panels visible on homepage | None | `page.goto('/')` | Price header, chart `<canvas>`, and news feed elements are absent from the DOM | High |

**Example:**

```typescript
// tests/e2e/homepage.spec.ts
import { test, expect } from '@playwright/test';

test('E2E-HOME-01: page title heading is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Claude Stocks App' })).toBeVisible();
});

test('E2E-HOME-03: footer is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('contentinfo')).toBeVisible();
});

test('E2E-HOME-04: search bar is positioned above the title', async ({ page }) => {
  await page.goto('/');
  const searchBox = page.getByRole('searchbox');
  const heading = page.getByRole('heading', { name: 'Claude Stocks App' });
  const searchY = (await searchBox.boundingBox())!.y;
  const headingY = (await heading.boundingBox())!.y;
  expect(searchY).toBeLessThan(headingY);
});
```

---

### 5.2 `tests/e2e/search.spec.ts`

**User stories**:
- "When I search for a company in the search bar, the search bar populates with results."
- "When I click on the chosen company, the dashboard appears."

| Test ID | Description | Setup / API Mock | Steps | Expected Assertions | Priority |
|---|---|---|---|---|---|
| E2E-SRCH-01 | Typing shows results dropdown | Mock `/api/stock/search` → `SEARCH_FIXTURE` | `goto('/')`, fill search bar with `"Apple"`, wait 500 ms | A dropdown with at least one result item is visible | Critical |
| E2E-SRCH-02 | Results contain the searched company name | Mock `/api/stock/search` → `SEARCH_FIXTURE` | `goto('/')`, fill `"Apple"`, wait | At least one result item contains `"Apple"` or `"AAPL"` text | Critical |
| E2E-SRCH-03 | Clicking a result navigates to the dashboard | Mock search + mock all dashboard APIs | Type `"Apple"`, click first result | URL changes to `/dashboard?symbol=AAPL` | Critical |
| E2E-SRCH-04 | No results shown for empty input | None | `goto('/')`, click search bar but do not type | Results dropdown is absent | High |
| E2E-SRCH-05 | Debounce: API called only once after rapid typing | Mock `/api/stock/search`, track call count via `route.request()` | Type `"A"`, `"AP"`, `"APP"`, `"APPL"`, `"APPLE"` with < 100 ms between keystrokes, then wait 600 ms | API called only once (debounce settles after 350 ms) | High |
| E2E-SRCH-06 | Skeleton loader shown while search is in progress | Mock `/api/stock/search` with 300 ms artificial delay | Type `"Apple"`, observe immediately after keystroke | Skeleton or spinner visible before results appear | Medium |
| E2E-SRCH-07 | Empty results shows empty state or closed dropdown | Mock `/api/stock/search` → `{ results: [] }` | Type `"ZZZZZZ"`, wait | No result items visible; no JavaScript error | Medium |
| E2E-SRCH-08 | Search API error shows Alert near search bar | Mock `/api/stock/search` → status 500 | Type `"Apple"`, wait | A Shadcn `Alert` element is visible in or near the search area | High |

**API mock examples for search:**

```typescript
// tests/e2e/search.spec.ts
import { test, expect } from '@playwright/test';
import { SEARCH_FIXTURE, QUOTE_FIXTURE_MARKET_OPEN, CANDLES_FIXTURE_3M, NEWS_FIXTURE } from './fixtures/index.ts';

test('E2E-SRCH-01: typing shows results dropdown', async ({ page }) => {
  await page.route('**/api/stock/search**', route =>
    route.fulfill({ json: SEARCH_FIXTURE })
  );

  await page.goto('/');
  await page.getByRole('searchbox').fill('Apple');
  // Allow debounce (350 ms) + render time
  await page.waitForTimeout(500);
  await expect(page.getByRole('listbox')).toBeVisible();
});

test('E2E-SRCH-05: debounce fires API only once for rapid input', async ({ page }) => {
  let callCount = 0;
  await page.route('**/api/stock/search**', route => {
    callCount++;
    return route.fulfill({ json: SEARCH_FIXTURE });
  });

  await page.goto('/');
  const searchbox = page.getByRole('searchbox');
  // Type each character quickly without waiting
  for (const char of ['A', 'P', 'P', 'L', 'E']) {
    await searchbox.press(char);
    await page.waitForTimeout(50);
  }
  // Wait for debounce to settle and response to arrive
  await page.waitForTimeout(600);
  expect(callCount).toBe(1);
});

test('E2E-SRCH-08: search API error shows Alert', async ({ page }) => {
  await page.route('**/api/stock/search**', route =>
    route.fulfill({ status: 500, body: '{}' })
  );

  await page.goto('/');
  await page.getByRole('searchbox').fill('Apple');
  await page.waitForTimeout(500);
  await expect(page.getByRole('alert')).toBeVisible();
});

test('E2E-SRCH-03: clicking a result navigates to the dashboard', async ({ page }) => {
  await page.route('**/api/stock/search**', route =>
    route.fulfill({ json: SEARCH_FIXTURE })
  );
  await page.route('**/api/stock/quote**', route =>
    route.fulfill({ json: QUOTE_FIXTURE_MARKET_OPEN })
  );
  await page.route('**/api/stock/candles**', route =>
    route.fulfill({ json: CANDLES_FIXTURE_3M })
  );
  await page.route('**/api/stock/news**', route =>
    route.fulfill({ json: NEWS_FIXTURE })
  );

  await page.goto('/');
  await page.getByRole('searchbox').fill('Apple');
  await page.waitForTimeout(500);
  await page.getByRole('listbox').getByRole('option').first().click();
  await expect(page).toHaveURL(/\/dashboard\?symbol=AAPL/);
});
```

---

### 5.3 `tests/e2e/dashboard.spec.ts`

**User story**: "Given the dashboard appears, when I have searched for a company, then I can see at the top the current value of the stock, a chart, and a news feed."

All dashboard tests navigate directly to `/dashboard?symbol=AAPL` after setting up route mocks. This bypasses the search flow (which is tested in `search.spec.ts`), keeping tests independent.

#### 5.3.1 Dashboard Population

| Test ID | Description | API Mocks | Steps | Expected Assertions | Priority |
|---|---|---|---|---|---|
| E2E-DASH-01 | Price header shows current price | `QUOTE_FIXTURE_MARKET_OPEN` | `goto('/dashboard?symbol=AAPL')` | Formatted price (e.g. `"$185.43"`) is visible in the price header | Critical |
| E2E-DASH-02 | Price change and percent change are visible | `QUOTE_FIXTURE_MARKET_OPEN` | `goto('/dashboard?symbol=AAPL')` | A change value (e.g. `"+2.34"` or `"-1.25"`) and percent (e.g. `"1.28%"`) are visible | High |
| E2E-DASH-03 | Chart canvas is rendered | `CANDLES_FIXTURE_3M` | `goto('/dashboard?symbol=AAPL')` | A `<canvas>` element is visible in the chart panel | Critical |
| E2E-DASH-04 | News feed shows article headlines | `NEWS_FIXTURE` | `goto('/dashboard?symbol=AAPL')` | At least one article headline from the fixture is visible | Critical |
| E2E-DASH-05 | News article source is visible | `NEWS_FIXTURE` | `goto('/dashboard?symbol=AAPL')` | Source name (e.g. `"Reuters"`) visible in at least one article card | High |
| E2E-DASH-06 | News articles have valid `href` links | `NEWS_FIXTURE` | Inspect `<a>` elements in news panel | Each article link has a non-empty `href` attribute | High |
| E2E-DASH-07 | All three panels visible simultaneously | All fixtures | `goto('/dashboard?symbol=AAPL')` | Price, chart `<canvas>`, and at least one news headline all visible in the same viewport | Critical |

**Example:**

```typescript
// tests/e2e/dashboard.spec.ts
import { test, expect } from '@playwright/test';
import { mockDashboardAPIs } from './helpers/mock-api.ts';

test('E2E-DASH-01: price header shows current price', async ({ page }) => {
  await mockDashboardAPIs(page);
  await page.goto('/dashboard?symbol=AAPL');
  await expect(page.getByText('$185.43')).toBeVisible();
});

test('E2E-DASH-03: chart canvas is rendered', async ({ page }) => {
  await mockDashboardAPIs(page);
  await page.goto('/dashboard?symbol=AAPL');
  await expect(page.locator('canvas')).toBeVisible();
});

test('E2E-DASH-07: all three panels visible simultaneously', async ({ page }) => {
  await mockDashboardAPIs(page);
  await page.goto('/dashboard?symbol=AAPL');
  await expect(page.getByText('$185.43')).toBeVisible();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Apple Reports Record Q1 Revenue')).toBeVisible();
});
```

#### 5.3.2 Market Closed Badge

| Test ID | Description | API Mocks | Steps | Expected Assertions | Priority |
|---|---|---|---|---|---|
| E2E-DASH-08 | "Market closed" badge absent when market is open | `QUOTE_FIXTURE_MARKET_OPEN` (`isMarketOpen: true`) | `goto('/dashboard?symbol=AAPL')` | No element with text `"Market closed"` is visible | High |
| E2E-DASH-09 | "Market closed" badge present when market is closed | `QUOTE_FIXTURE_MARKET_CLOSED` (`isMarketOpen: false`) | `goto('/dashboard?symbol=AAPL')` | Element with text `"Market closed"` is visible | Critical |

```typescript
test('E2E-DASH-09: market closed badge shown when isMarketOpen is false', async ({ page }) => {
  await mockDashboardAPIs(page, { quote: QUOTE_FIXTURE_MARKET_CLOSED });
  await page.goto('/dashboard?symbol=AAPL');
  await expect(page.getByText('Market closed')).toBeVisible();
});
```

#### 5.3.3 Time-Range Switching

| Test ID | Description | API Mocks | Steps | Expected Assertions | Priority |
|---|---|---|---|---|---|
| E2E-DASH-10 | Default range is 3M (active button state) | `CANDLES_FIXTURE_3M` | `goto('/dashboard?symbol=AAPL')` | The `"3M"` button has an active/selected visual state (aria-pressed or CSS class) | High |
| E2E-DASH-11 | Clicking 1M fires new candles API call with `range=1M` | `CANDLES_FIXTURE_1M` for 1M requests | Click `"1M"` button; await response | `/api/stock/candles?symbol=AAPL&range=1M` request is observed; chart re-renders | Critical |
| E2E-DASH-12 | Clicking 1Y fires new candles API call with `range=1Y` | `CANDLES_FIXTURE_1Y` for 1Y requests | Click `"1Y"` button; await response | `/api/stock/candles?symbol=AAPL&range=1Y` request is observed | Critical |
| E2E-DASH-13 | Active range button visual state updates | All candles fixtures | Click each range button in sequence | The clicked button shows active state; the previous button reverts to inactive | High |
| E2E-DASH-14 | Loading indicator shown during range switch | `CANDLES_FIXTURE_1M` with 300 ms delay | Click `"1M"` button | A loading indicator or skeleton is visible before chart data arrives | Medium |

**Range-switch example with `waitForResponse`:**

```typescript
test('E2E-DASH-11: clicking 1M fires candles call with range=1M', async ({ page }) => {
  let capturedRange: string | null = null;

  await page.route('**/api/stock/candles**', async route => {
    const url = new URL(route.request().url());
    capturedRange = url.searchParams.get('range');
    await route.fulfill({ json: CANDLES_FIXTURE_1M });
  });
  await page.route('**/api/stock/quote**', route =>
    route.fulfill({ json: QUOTE_FIXTURE_MARKET_OPEN })
  );
  await page.route('**/api/stock/news**', route =>
    route.fulfill({ json: NEWS_FIXTURE })
  );

  await page.goto('/dashboard?symbol=AAPL');

  // Click 1M and wait for the candles network response
  const [response] = await Promise.all([
    page.waitForResponse('**/api/stock/candles**'),
    page.getByRole('button', { name: '1M' }).click(),
  ]);

  expect(capturedRange).toBe('1M');
  expect(response.status()).toBe(200);
});
```

**Delayed response example for loading state test:**

```typescript
test('E2E-DASH-14: loading state shown during range switch', async ({ page }) => {
  await page.route('**/api/stock/candles**', async route => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ json: CANDLES_FIXTURE_1M });
  });
  await page.route('**/api/stock/quote**', route =>
    route.fulfill({ json: QUOTE_FIXTURE_MARKET_OPEN })
  );
  await page.route('**/api/stock/news**', route =>
    route.fulfill({ json: NEWS_FIXTURE })
  );

  await page.goto('/dashboard?symbol=AAPL');
  await page.getByRole('button', { name: '1M' }).click();

  // Skeleton or spinner must be visible immediately after click
  await expect(page.getByTestId('chart-skeleton')).toBeVisible();
  // Chart eventually renders
  await expect(page.locator('canvas')).toBeVisible();
});
```

#### 5.3.4 Company Switching

| Test ID | Description | API Mocks | Steps | Expected Assertions | Priority |
|---|---|---|---|---|---|
| E2E-DASH-15 | CompanySelector dropdown is visible | All fixtures | `goto('/dashboard?symbol=AAPL')` | A Shadcn `Select` component is visible | High |
| E2E-DASH-16 | Selecting a new company reloads all panels | Mock AAPL + TSLA fixtures | Select TSLA from dropdown | URL changes to `/dashboard?symbol=TSLA`; panels re-fetch with new symbol | Critical |
| E2E-DASH-17 | Recently viewed company appears in dropdown | Visit AAPL then TSLA | Navigate to AAPL, then navigate to TSLA | AAPL appears as an option in the CompanySelector dropdown | Medium |

---

## 6. Error State Coverage

Every data-fetching panel must render a Shadcn `Alert` component when its API call fails. The alert must be isolated to the affected panel — other panels must continue to render correctly.

### 6.1 Error Triggers and Assertions

| Panel | Trigger | What causes it | Assertion |
|---|---|---|---|
| `PriceHeader` | `/api/stock/quote` returns 500 | Finnhub down or Route Handler crash | `Alert` visible in price panel; chart `<canvas>` and at least one news headline still render |
| `StockChart` | `/api/stock/candles` returns 500 | Finnhub down or Route Handler crash | `Alert` visible in chart panel; price value and news still render |
| `StockChart` | Finnhub returns `s: "no_data"` | Symbol has no candle data (non-US or delisted) | `Alert` or empty-state message visible; no `<canvas>` crash |
| `NewsFeed` | `/api/stock/news` returns 500 | Finnhub down or Route Handler crash | `Alert` visible in news panel; price and `<canvas>` still render |
| SearchBar | `/api/stock/search` returns 500 | Finnhub down or Route Handler crash | `Alert` visible near search bar; page does not navigate away |

### 6.2 Isolation Test Cases

These are explicit cross-panel isolation tests — Critical priority because the architecture explicitly guarantees per-panel failure isolation.

| Test ID | Description | Mocks | Expected Behaviour | Priority |
|---|---|---|---|---|
| ERR-ISO-01 | Quote failure does not break chart or news | Quote → 500, Candles → 200 `CANDLES_FIXTURE_3M`, News → 200 `NEWS_FIXTURE` | Alert in price panel; `<canvas>` and news headline still visible | Critical |
| ERR-ISO-02 | Candles failure does not break price or news | Quote → 200 `QUOTE_FIXTURE_MARKET_OPEN`, Candles → 500, News → 200 | Alert in chart panel; price and news still visible | Critical |
| ERR-ISO-03 | News failure does not break price or chart | Quote → 200, Candles → 200, News → 500 | Alert in news panel; price and `<canvas>` still visible | Critical |
| ERR-ISO-04 | All three panels fail simultaneously | All three → 500 | Each panel shows its own independent Alert; page does not crash or show a blank screen | High |
| ERR-ISO-05 | Alert message is neutral and non-technical | Any panel error | Alert text contains no stack trace, Finnhub domain, API key value, or internal path | Critical |
| ERR-ISO-06 | `s: "no_data"` candle response does not crash the chart panel | Quote → 200, Candles → `CANDLES_FIXTURE_NO_DATA`, News → 200 | Chart panel shows an Alert or empty state; no uncaught JavaScript error; other panels unaffected | High |

**E2E isolation test examples:**

```typescript
// tests/e2e/dashboard.spec.ts

test('ERR-ISO-01: quote failure does not break chart or news', async ({ page }) => {
  await page.route('**/api/stock/quote**', route =>
    route.fulfill({ status: 500, body: '{}' })
  );
  await page.route('**/api/stock/candles**', route =>
    route.fulfill({ json: CANDLES_FIXTURE_3M })
  );
  await page.route('**/api/stock/news**', route =>
    route.fulfill({ json: NEWS_FIXTURE })
  );

  await page.goto('/dashboard?symbol=AAPL');

  // Price panel shows alert
  await expect(page.getByRole('alert').first()).toBeVisible();

  // Chart and news still render
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('Apple Reports Record Q1 Revenue')).toBeVisible();
});

test('ERR-ISO-04: all panels fail simultaneously — page does not crash', async ({ page }) => {
  await page.route('**/api/stock/quote**', route =>
    route.fulfill({ status: 500, body: '{}' })
  );
  await page.route('**/api/stock/candles**', route =>
    route.fulfill({ status: 500, body: '{}' })
  );
  await page.route('**/api/stock/news**', route =>
    route.fulfill({ status: 500, body: '{}' })
  );

  await page.goto('/dashboard?symbol=AAPL');

  // All three panels show their own Alerts
  const alerts = page.getByRole('alert');
  await expect(alerts).toHaveCount(3);

  // No uncaught error on the page
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  expect(errors).toHaveLength(0);
});
```

---

## 7. Security Tests

### 7.1 API Key Never Exposed to Client

These tests verify that `FINNHUB_API_KEY` (or any value it holds) never reaches the browser in any form.

| Test ID | Description | Method | Expected | Priority |
|---|---|---|---|---|
| SEC-01 | API key not present in Next.js client bundle | Build with `deno task build`; search `.next/static/chunks/` for the key value | No match in any chunk file | Critical |
| SEC-02 | API key value not in `/api/stock/quote` response body | Integration test: set `FINNHUB_API_KEY=test-sentinel-value`; inspect response JSON | `"test-sentinel-value"` absent from response body | Critical |
| SEC-03 | API key value not in `/api/stock/search` response body | Same sentinel approach | `"test-sentinel-value"` absent from response body | Critical |
| SEC-04 | `NEXT_PUBLIC_` prefix never applied to `FINNHUB_API_KEY` | Code search: `grep -r "NEXT_PUBLIC_FINNHUB"` in source | Zero matches | Critical |
| SEC-05 | `lib/finnhub/client.ts` imports `server-only` | Code inspection: read the file | `import 'server-only'` present at top of file | High |
| SEC-06 | `.env.local` is listed in `.gitignore` | Read `.gitignore` | `.env.local` entry present | Critical |
| SEC-07 | Finnhub token sent as `X-Finnhub-Token` header, not URL query param | Unit test: inspect captured request from `client.ts` stub | Request has `X-Finnhub-Token` header; URL does not contain `?token=` or `&token=` | High |

### 7.2 Input Validation Security Tests

These complement the unit tests in section 3.3.5. They are restated here for their security significance.

| Test ID | Description | Input | Expected | Priority |
|---|---|---|---|---|
| SEC-08 | Symbol injection attempt rejected | `symbol=AAPL; DROP TABLE stocks` | 400 — fails regex `/^[A-Z]{1,10}$/` before reaching Finnhub | Critical |
| SEC-09 | Search query XSS attempt is sanitised | `q=<script>alert(document.cookie)</script>` | Stripped to `""` or alphanumeric only; never forwarded as-is to Finnhub | Critical |
| SEC-10 | Candles range SSRF attempt rejected | `range=http://internal-host/` | 400 — not in allowlist `['1M', '3M', '1Y']` | Critical |
| SEC-11 | Symbol path traversal attempt rejected | `symbol=../../../etc/passwd` | 400 — fails uppercase alpha-only regex | Critical |
| SEC-12 | Extremely long symbol rejected | `symbol=` + `A` × 1000 | 400 — exceeds max length of 10 | High |
| SEC-13 | API key not leaked in error responses | Trigger a 502 by making `getQuote` throw | Error body is a neutral JSON message; does not contain the key value | Critical |

---

## 8. Test Data and Fixtures

All fixture files live in `tests/fixtures/` and are imported by unit, integration, and E2E tests.

**Barrel export** (`tests/fixtures/index.ts`):

```typescript
export * from './search.ts';
export * from './quote.ts';
export * from './candles.ts';
export * from './news.ts';
```

---

### 8.1 `tests/fixtures/search.ts`

Represents a Finnhub `GET /search` response with a mix of US-listed and non-US results, to verify the Route Handler's US-only filtering.

```typescript
// tests/fixtures/search.ts

// Raw Finnhub /search response shape
export const SEARCH_FIXTURE = {
  count: 4,
  result: [
    {
      description: "APPLE INC",
      displaySymbol: "AAPL",
      symbol: "AAPL",
      type: "Common Stock",
      mic: "XNAS",       // NASDAQ — US, should be included
    },
    {
      description: "APPLE INC CDR",
      displaySymbol: "AAPL",
      symbol: "AAPL:CA",
      type: "Common Stock",
      mic: "XTSE",       // Toronto Stock Exchange — non-US, should be filtered out
    },
    {
      description: "APPLE INC EUR",
      displaySymbol: "APC",
      symbol: "APC:GR",
      type: "Common Stock",
      mic: "XETR",       // Frankfurt — non-US, should be filtered out
    },
    {
      description: "APPLETON PAPERS",
      displaySymbol: "APPVL",
      symbol: "APPVL",
      type: "Common Stock",
      mic: "XNYS",       // NYSE — US, should be included
    },
  ],
};

// For testing "all results filtered out" scenario
export const SEARCH_FIXTURE_NON_US = {
  count: 1,
  result: [
    {
      description: "VODAFONE GROUP PLC",
      displaySymbol: "VOD",
      symbol: "VOD:LN",
      type: "Common Stock",
      mic: "XLON",       // London Stock Exchange — non-US
    },
  ],
};

export const SEARCH_FIXTURE_EMPTY = {
  count: 0,
  result: [],
};
```

---

### 8.2 `tests/fixtures/quote.ts`

Two primary variants — market open and market closed — plus a zero-value variant Finnhub returns for invalid symbols.

```typescript
// tests/fixtures/quote.ts

// Used by: E2E-DASH-01 through E2E-DASH-07, ERR-ISO-01, ERR-ISO-02, ERR-ISO-03
export const QUOTE_FIXTURE_MARKET_OPEN = {
  c: 185.43,    // current price
  d: 2.34,      // change
  dp: 1.28,     // percent change
  h: 186.00,    // day high
  l: 183.20,    // day low
  o: 183.50,    // open
  pc: 183.09,   // previous close
  t: 1740067200, // Unix timestamp (weekday during market hours)
  isMarketOpen: true,
};

// Used by: E2E-DASH-09
export const QUOTE_FIXTURE_MARKET_CLOSED = {
  c: 185.43,
  d: 2.34,
  dp: 1.28,
  h: 186.00,
  l: 183.20,
  o: 183.50,
  pc: 183.09,
  t: 1740067200,
  isMarketOpen: false,
};

// Finnhub returns all zeros when a symbol is invalid or has no data
export const QUOTE_FIXTURE_ZERO = {
  c: 0,
  d: 0,
  dp: 0,
  h: 0,
  l: 0,
  o: 0,
  pc: 0,
  t: 0,
  isMarketOpen: false,
};
```

---

### 8.3 `tests/fixtures/candles.ts`

Three variants for the three time ranges. The `t` (timestamps) and `c` (close prices) arrays must always be the same length. Fixtures use deterministic data (not `Math.random`) so snapshot comparisons remain stable across test runs.

```typescript
// tests/fixtures/candles.ts

// Helper: generate N evenly-spaced Unix timestamps going backwards from a fixed date
// Fixed date avoids flakiness from time-dependent generation
function generateTimestamps(count: number): number[] {
  const FIXED_END = 1740067200; // 2026-02-21 00:00:00 UTC
  const DAY_SECONDS = 86400;
  return Array.from({ length: count }, (_, i) =>
    FIXED_END - (count - 1 - i) * DAY_SECONDS
  );
}

function generatePrices(count: number, base = 185, amplitude = 10): number[] {
  return Array.from({ length: count }, (_, i) =>
    parseFloat((base + Math.sin(i / 5) * amplitude).toFixed(2))
  );
}

// ~22 trading days in 1 calendar month
export const CANDLES_FIXTURE_1M = {
  s: "ok",
  t: generateTimestamps(22),
  c: generatePrices(22),
  o: generatePrices(22, 184, 8),
  h: generatePrices(22, 187, 10),
  l: generatePrices(22, 182, 8),
  v: Array.from({ length: 22 }, (_, i) => 30_000_000 + i * 500_000),
};

// ~65 trading days in 3 calendar months
export const CANDLES_FIXTURE_3M = {
  s: "ok",
  t: generateTimestamps(65),
  c: generatePrices(65),
  o: generatePrices(65, 184, 8),
  h: generatePrices(65, 187, 10),
  l: generatePrices(65, 182, 8),
  v: Array.from({ length: 65 }, (_, i) => 30_000_000 + i * 200_000),
};

// ~252 trading days in 1 calendar year
export const CANDLES_FIXTURE_1Y = {
  s: "ok",
  t: generateTimestamps(252),
  c: generatePrices(252),
  o: generatePrices(252, 184, 8),
  h: generatePrices(252, 187, 10),
  l: generatePrices(252, 182, 8),
  v: Array.from({ length: 252 }, (_, i) => 30_000_000 + i * 50_000),
};

// Finnhub "no data" response — used for ERR-ISO-06 and INT-CND-07
export const CANDLES_FIXTURE_NO_DATA = {
  s: "no_data",
};
```

---

### 8.4 `tests/fixtures/news.ts`

Finnhub returns a raw JSON array from `GET /company-news` — not an object with an `articles` key. The Route Handler wraps it in `{ articles: [...] }`. The raw fixture matches what Finnhub returns; the Route Handler produces the wrapped shape.

```typescript
// tests/fixtures/news.ts

// Raw Finnhub /company-news response (array, not object)
// Used by: CLI-12, CLI-13, INT-NEWS-01, INT-NEWS-02
export const NEWS_FIXTURE_RAW = [
  {
    id: 7001,
    headline: "Apple Reports Record Q1 Revenue, iPhone Sales Up 8%",
    source: "Reuters",
    summary: "Apple Inc. reported record first-quarter revenue of $124 billion, as strong iPhone sales in China offset headwinds elsewhere.",
    url: "https://www.reuters.com/technology/apple-q1-revenue-2026",
    datetime: 1740067200,
    related: "AAPL",
    image: "https://www.reuters.com/img/apple-revenue.jpg",
    category: "company",
  },
  {
    id: 7002,
    headline: "Apple Vision Pro 2 Rumoured for Late 2026 Launch",
    source: "Bloomberg",
    summary: "Analysts expect Apple to release a second-generation Vision Pro headset with improved display resolution and reduced weight.",
    url: "https://www.bloomberg.com/news/apple-vision-pro-2-2026",
    datetime: 1739980800,
    related: "AAPL",
    image: "",
    category: "company",
  },
  {
    id: 7003,
    headline: "Tim Cook Discusses AI Strategy at Goldman Sachs Conference",
    source: "CNBC",
    summary: "Apple CEO Tim Cook outlined the company's approach to on-device AI, emphasising privacy and Siri enhancements coming in iOS 20.",
    url: "https://www.cnbc.com/apple-ai-goldman-2026",
    datetime: 1739894400,
    related: "AAPL",
    image: "",
    category: "company",
  },
];

// Wrapped shape returned by /api/stock/news — used by E2E tests that mock the Route Handler response
// The Route Handler slices to max 10 articles and wraps the array
export const NEWS_FIXTURE = {
  articles: NEWS_FIXTURE_RAW,
};

// For testing "fewer than 10 articles" scenario (INT-NEWS-02)
export const NEWS_FIXTURE_RAW_3 = NEWS_FIXTURE_RAW.slice(0, 3);

export const NEWS_FIXTURE_3 = {
  articles: NEWS_FIXTURE_RAW_3,
};

export const NEWS_FIXTURE_EMPTY = {
  articles: [],
};
```

---

## 9. Coverage Targets

Coverage thresholds apply to the unit and integration test suite only. Playwright E2E coverage is defined by scenario completeness, not line coverage numbers.

| Module | Target Line Coverage | Target Branch Coverage | Rationale |
|---|---|---|---|
| `lib/cache.ts` | 100% | 100% | Small, pure, high-risk module. All branches must be exercised. |
| `lib/utils.ts` | 95%+ | 90%+ | Formatters and date math are business-critical; minor logging lines may be excluded. |
| `lib/finnhub/client.ts` | 90%+ | 85%+ | Core data path; all four endpoints and all error branches must be covered. |
| `app/api/stock/search/route.ts` | 85%+ | 80%+ | More conditional branches: validation, US-filter, caching, error paths. |
| `app/api/stock/quote/route.ts` | 85%+ | 80%+ | `isMarketOpen` computation adds many branches. |
| `app/api/stock/candles/route.ts` | 85%+ | 80%+ | Range validation allowlist + `no_data` handling adds branches. |
| `app/api/stock/news/route.ts` | 85%+ | 80%+ | Simpler handler; 85% is achievable with the integration tests above. |
| `hooks/useDebounce.ts` | 80%+ | N/A | React hook; covered primarily by the E2E debounce test (E2E-SRCH-05). |

### 9.1 Coverage Collection

```json
// In deno.json tasks:
"test:coverage": "deno test --allow-net --allow-env --allow-read --coverage=.coverage/ tests/unit/ && deno coverage .coverage/"
```

Add `.coverage/` to `.gitignore`.

### 9.2 What Not to Chase

Do not write tests purely to hit a line count. A 95% coverage figure is meaningless if the 95% covers only the happy path. The tests defined in sections 3 and 4 are specifically designed to exercise:

- All validation branches (valid, invalid, boundary values, injection payloads)
- All cache states (hit, miss, expired, overwrite)
- All market hours cases (open, closed, weekend, DST transition)
- All Finnhub response shapes (normal, `no_data`, empty array, network failure, 403, 500)

---

## 10. Test Execution and CI

### 10.1 Local Development Workflow

```bash
# Fast feedback during development (pure logic only)
deno task test                            # Unit tests (~2s)

# Before committing a feature
deno task test                            # Unit tests
deno test tests/integration/ --allow-net --allow-env --allow-read   # Integration tests

# Before raising a PR
deno task test:e2e                        # Full Playwright suite (~60s)

# With coverage report
deno task test:coverage
```

### 10.2 CI Pipeline Order

The pipeline is ordered fast-to-slow so developers get the earliest possible signal on the most common failure types.

```
Stage 1 — Lint & Type Check (~5s)
  deno lint
  deno task build            # Also validates TypeScript compilation

Stage 2 — Unit Tests (~2s)
  deno task test

Stage 3 — Integration Tests (~10s)
  deno test tests/integration/ --allow-net --allow-env --allow-read

Stage 4 — E2E Tests (~60s)
  deno task test:e2e
```

A lint error fails within seconds. An E2E failure takes the full browser startup time (~30s). Stopping at Stage 1 on a type error saves the full pipeline cost.

### 10.3 CI Environment Requirements

- Set `CI=true` in the CI environment. The Playwright config already handles `reuseExistingServer: !process.env.CI` — a fresh Next.js server is always started in CI.
- Set `FINNHUB_API_KEY=ci-placeholder` to satisfy any `process.env` checks at startup without making real API calls. All API calls are mocked via `page.route()`.
- No test in any layer may make a real call to `finnhub.io`. Unit and integration tests mock the client; E2E tests mock the Route Handlers.

### 10.4 Test Isolation Requirements

- **Unit tests**: Each `Deno.test` must be self-contained. The in-memory cache in `lib/cache.ts` is module-scoped — tests must use unique keys (e.g., appending `Date.now()` to the key string) to prevent cross-test pollution from the shared Map.
- **Integration tests**: Stub Finnhub client functions using `stub()` from `@std/testing/mock`, and always call `.restore()` in a `finally` block.
- **E2E tests**: Each test must set up its own `page.route()` interceptors. Do not rely on state, mocks, or navigation from a previous test. Use `test.beforeEach` only for shared mock configuration that applies to every test in a file.
- **No test may**: write to disk, call the real Finnhub API, read `FINNHUB_API_KEY` from the environment (beyond verifying it exists), or depend on system clock without explicitly using `FakeTime` or a fixed timestamp parameter.
