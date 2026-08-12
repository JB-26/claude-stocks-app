import { assert, assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// watchlist-quotes-logic.test.ts
//
// Unit tests for lib/watchlist-quotes-logic.ts — the pure logic behind
// GET /api/stock/watchlist-quotes.
//
// The Route Handler itself cannot be imported here: it resolves modules through
// Next.js's "@/" path alias, which plain `deno test` does not understand (see
// tests/unit/search-route.test.ts and lib/watchlist-quotes-validation.ts for
// the same constraint). Every branch that used to live inline in the handler —
// the cache hit/miss split, the don't-cache-a-transient-failure decision, the
// `!(raw.c > 0)` heuristic, budget-denied symbols, deadline-starved symbols and
// row construction — is now a pure function and is covered below.
// ---------------------------------------------------------------------------

import {
  allocateUpstreamWork,
  asNegativeCacheReason,
  buildWatchlistQuotes,
  buildWatchlistResponse,
  classifyQuoteResult,
  isDegraded,
  MIN_VIABLE_UPSTREAM_MS,
  partitionSymbols,
  QUOTE_TTL_MS,
  quoteCacheKey,
  timeoutForDeadline,
  TRANSIENT_FAILURE_TTL_MS,
  UNKNOWN_SYMBOL_TTL_MS,
  unavailableCacheKey,
  type NegativeCacheReason,
  type QuoteCacheLookup,
  type QuoteOutcome,
  type QuoteRowReason,
  type UpstreamAttempt,
} from "../../lib/watchlist-quotes-logic.ts";
import type { FinnhubQuote, QuoteResponse } from "../../lib/finnhub/types.ts";

/**
 * Narrowing helpers — assert an outcome's kind and return it narrowed.
 *
 * Mirrors `fulfilledValue` in concurrency.test.ts and `okSymbols` in
 * watchlist-quotes-validation.test.ts. Written as explicit casts rather than
 * relying on `assert()`'s asserts-signature so the file type-checks the same
 * way under `deno test` and under `npx tsc --noEmit`.
 */
function asOk(outcome: QuoteOutcome): Extract<QuoteOutcome, { kind: "ok" }> {
  assertEquals(outcome.kind, "ok");
  return outcome as Extract<QuoteOutcome, { kind: "ok" }>;
}

function asFailed(
  outcome: QuoteOutcome
): Extract<QuoteOutcome, { kind: "failed" }> {
  assertEquals(outcome.kind, "failed");
  return outcome as Extract<QuoteOutcome, { kind: "failed" }>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function finnhubQuote(overrides: Partial<FinnhubQuote> = {}): FinnhubQuote {
  return {
    c: 150,
    d: 1.5,
    dp: 1.01,
    h: 152,
    l: 148,
    o: 149,
    pc: 148.5,
    t: 1_700_000_000,
    ...overrides,
  };
}

function quoteResponse(overrides: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    c: 150,
    d: 1.5,
    dp: 1.01,
    h: 152,
    l: 148,
    o: 149,
    pc: 148.5,
    t: 1_700_000_000,
    isMarketOpen: true,
    ...overrides,
  };
}

/** A settled slot that reached Finnhub and got an answer. */
function answered(
  overrides: Partial<FinnhubQuote> = {}
): PromiseSettledResult<UpstreamAttempt> {
  return {
    status: "fulfilled",
    value: { kind: "quote", quote: finnhubQuote(overrides) },
  };
}

/** A settled slot the deadline closed before it was ever dispatched. */
function skipped(): PromiseSettledResult<UpstreamAttempt> {
  return { status: "fulfilled", value: { kind: "skipped" } };
}

/** A settled slot that was dispatched and threw. */
function threw(reason: unknown): PromiseSettledResult<UpstreamAttempt> {
  return { status: "rejected", reason };
}

/** Builds a cache lookup fn from a plain description of what the cache holds. */
function lookupFrom(
  positives: Record<string, QuoteResponse>,
  negatives: Record<string, NegativeCacheReason> = {}
): (symbol: string) => QuoteCacheLookup {
  return (symbol) => {
    const quote = positives[symbol];
    if (quote) return { kind: "quote", quote };
    const reason = negatives[symbol];
    if (reason) return { kind: "unavailable", reason };
    return { kind: "miss" };
  };
}

// ---------------------------------------------------------------------------
// WQL-01: cache keys are namespaced so a negative marker can never be served
//         as a quote by /api/stock/quote
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-logic WQL-01: quoteCacheKey matches the /api/stock/quote key format", () => {
  assertEquals(quoteCacheKey("AAPL"), "quote:AAPL");
});

Deno.test("watchlist-quotes-logic WQL-01b: the negative-cache key is a different namespace from the quote key", () => {
  assertEquals(unavailableCacheKey("AAPL"), "quote:unavailable:AAPL");
  assert(
    unavailableCacheKey("AAPL") !== quoteCacheKey("AAPL"),
    "a negative marker written under the quote key would poison /api/stock/quote"
  );
});

Deno.test("watchlist-quotes-logic WQL-01c: no SYMBOL_RE-valid symbol can collide the two namespaces", () => {
  // SYMBOL_RE is /^[A-Z]{1,10}$/ — no colons, no lowercase — so no valid symbol
  // can produce the string "unavailable:X" and land on a negative key.
  const keys = ["AAPL", "MSFT", "A", "ABCDEFGHIJ"].flatMap((s) => [
    quoteCacheKey(s),
    unavailableCacheKey(s),
  ]);
  assertEquals(new Set(keys).size, keys.length);
});

// ---------------------------------------------------------------------------
// WQL-02: cache hit / miss split
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-logic WQL-02: symbols in the positive cache are hits and cost no upstream call", () => {
  const aapl = quoteResponse({ c: 190 });
  const result = partitionSymbols(
    ["AAPL", "MSFT"],
    lookupFrom({ AAPL: aapl })
  );

  assertEquals([...result.cached.keys()], ["AAPL"]);
  assertEquals(result.cached.get("AAPL"), aapl);
  assertEquals(result.missing, ["MSFT"]);
  assertEquals(result.knownUnavailable.size, 0);
});

Deno.test("watchlist-quotes-logic WQL-02b: an all-miss request puts every symbol in `missing`, in input order", () => {
  const result = partitionSymbols(["TSLA", "AAPL", "NVDA"], lookupFrom({}));

  assertEquals(result.missing, ["TSLA", "AAPL", "NVDA"]);
  assertEquals(result.cached.size, 0);
});

Deno.test("watchlist-quotes-logic WQL-02c: an all-hit request issues no upstream work at all", () => {
  const result = partitionSymbols(
    ["AAPL", "MSFT"],
    lookupFrom({ AAPL: quoteResponse(), MSFT: quoteResponse({ c: 400 }) })
  );

  assertEquals(result.missing, []);
  assertEquals(result.cached.size, 2);
});

Deno.test("watchlist-quotes-logic WQL-02d: a negative-cache hit skips the upstream call and carries its cause forward", () => {
  const result = partitionSymbols(
    ["AAPL", "ZZZZZ", "FLAKY"],
    lookupFrom({}, { ZZZZZ: "unavailable", FLAKY: "failed" })
  );

  assertEquals(result.missing, ["AAPL"], "only the un-cached symbol is fetched");
  assertEquals(result.knownUnavailable.get("ZZZZZ"), "unavailable");
  assertEquals(
    result.knownUnavailable.get("FLAKY"),
    "failed",
    "a cached transient failure must not be reported to the client as a " +
      "permanent property of the symbol"
  );
});

Deno.test("watchlist-quotes-logic WQL-02e: a cached entry with a non-positive price is re-fetched, never served as a price", () => {
  const result = partitionSymbols(
    ["AAPL"],
    lookupFrom({ AAPL: quoteResponse({ c: 0 }) })
  );

  assertEquals(result.cached.size, 0);
  assertEquals(result.missing, ["AAPL"]);
});

Deno.test("watchlist-quotes-logic WQL-02f: an empty symbol list partitions to nothing", () => {
  const result = partitionSymbols([], lookupFrom({}));

  assertEquals(result.missing, []);
  assertEquals(result.knownUnavailable.size, 0);
  assertEquals(result.cached.size, 0);
});

// ---------------------------------------------------------------------------
// WQL-03: upstream budget allocation
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-logic WQL-03: a full allowance fetches every miss and defers none", () => {
  const missing = ["AAPL", "MSFT", "TSLA"];
  assertEquals(allocateUpstreamWork(missing, 3), {
    fetch: missing,
    deferred: [],
  });
});

Deno.test("watchlist-quotes-logic WQL-03b: a partial allowance fetches the first N in input order", () => {
  assertEquals(allocateUpstreamWork(["AAPL", "MSFT", "TSLA"], 2), {
    fetch: ["AAPL", "MSFT"],
    deferred: ["TSLA"],
  });
});

Deno.test("watchlist-quotes-logic WQL-03c: a zero allowance defers everything and fetches nothing", () => {
  assertEquals(allocateUpstreamWork(["AAPL", "MSFT"], 0), {
    fetch: [],
    deferred: ["AAPL", "MSFT"],
  });
});

Deno.test("watchlist-quotes-logic WQL-03d: an allowance larger than the miss count never invents work", () => {
  assertEquals(allocateUpstreamWork(["AAPL"], 99), {
    fetch: ["AAPL"],
    deferred: [],
  });
});

Deno.test("watchlist-quotes-logic WQL-03e: a non-finite or negative allowance fails closed to zero", () => {
  assertEquals(allocateUpstreamWork(["AAPL"], NaN).fetch, []);
  assertEquals(allocateUpstreamWork(["AAPL"], -1).fetch, []);
  assertEquals(allocateUpstreamWork(["AAPL"], Infinity).fetch, []);
});

// ---------------------------------------------------------------------------
// WQL-04: classification of settled upstream slots
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-logic WQL-04: a fulfilled quote with a positive price is cached for the quote TTL", () => {
  const outcome = asOk(classifyQuoteResult(answered({ c: 190.5 }), true));

  assertEquals(outcome.ttlMs, QUOTE_TTL_MS);
  assertEquals(outcome.quote.c, 190.5);
  assertEquals(outcome.quote.isMarketOpen, true);
});

Deno.test("watchlist-quotes-logic WQL-04b: isMarketOpen is stamped from the caller, not from Finnhub", () => {
  const outcome = asOk(classifyQuoteResult(answered(), false));

  assertEquals(outcome.quote.isMarketOpen, false);
});

Deno.test("watchlist-quotes-logic WQL-04c: a zero price is unavailable, negative-cached for a full minute", () => {
  // Finnhub answers HTTP 200 with { c: 0 } for a ticker it does not know. This
  // is the branch that used to cache nothing at all, which is what let a caller
  // cycling bogus symbols get a 0% cache hit rate forever.
  const outcome = classifyQuoteResult(answered({ c: 0 }), true);

  assertEquals(outcome.kind, "unavailable");
  assertEquals(
    outcome.kind === "unavailable" ? outcome.ttlMs : -1,
    UNKNOWN_SYMBOL_TTL_MS
  );
});

Deno.test("watchlist-quotes-logic WQL-04d: a negative or non-finite price is also treated as unavailable", () => {
  for (const c of [-1, NaN]) {
    const outcome = classifyQuoteResult(answered({ c }), true);
    assertEquals(outcome.kind, "unavailable", `c=${c} must not be served`);
  }
});

Deno.test("watchlist-quotes-logic WQL-04e: a rejected lookup is negative-cached only briefly so it retries soon", () => {
  const reason = new Error("Finnhub request timed out after 4000ms: /quote");
  const outcome = asFailed(classifyQuoteResult(threw(reason), true));

  assertEquals(outcome.detail, reason);
  assertEquals(outcome.ttlMs, TRANSIENT_FAILURE_TTL_MS);
  assert(
    outcome.ttlMs < UNKNOWN_SYMBOL_TTL_MS,
    "a transient failure must expire well before an unavailable symbol does, " +
      "so a real symbol is not pinned to 'error' for a whole minute by one blip"
  );
  assert(outcome.ttlMs > 0, "caching nothing at all makes every retry a free upstream call");
});

Deno.test("watchlist-quotes-logic WQL-04f: a slot the deadline closed is deferred, NOT a failure", () => {
  // REGRESSION: a deadline-starved symbol used to reject with a synthetic
  // "Deadline exceeded" Error, which classified as a transient failure and got
  // the symbol negative-cached for 10s — recording a purely local scheduling
  // shortage as a property of the symbol, after making zero upstream calls.
  const outcome = classifyQuoteResult(skipped(), true);

  assertEquals(outcome.kind, "deferred");
});

Deno.test("watchlist-quotes-logic WQL-04g: a deferred outcome carries no TTL, so it cannot be negative-cached", () => {
  // The handler's negative-cache write reads `outcome.ttlMs`. Deferred has no
  // such field — the impossibility of caching it is enforced by the type, and
  // this asserts the runtime shape backs that up.
  const outcome = classifyQuoteResult(skipped(), true);

  assert(
    !("ttlMs" in outcome),
    "a symbol that was never contacted must not carry a cache lifetime"
  );
});

// ---------------------------------------------------------------------------
// WQL-05: response rows — one per requested symbol, never dropped
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-logic WQL-05: an empty symbol list produces an empty quotes array", () => {
  assertEquals(buildWatchlistQuotes([], new Map()), []);
});

Deno.test("watchlist-quotes-logic WQL-05b: every requested symbol gets a row, in input order", () => {
  const rows = buildWatchlistQuotes(
    ["AAPL", "MSFT", "TSLA"],
    new Map([["MSFT", quoteResponse({ c: 400 })]])
  );

  assertEquals(rows.length, 3);
  assertEquals(rows.map((r) => r.symbol), ["AAPL", "MSFT", "TSLA"]);
});

Deno.test("watchlist-quotes-logic WQL-05c: a symbol with no quote degrades to an error row rather than being dropped", () => {
  const rows = buildWatchlistQuotes(
    ["ZZZZZ"],
    new Map(),
    new Map<string, QuoteRowReason>([["ZZZZZ", "unavailable"]])
  );

  assertEquals(rows, [
    {
      symbol: "ZZZZZ",
      status: "error",
      price: null,
      change: null,
      changePercent: null,
      reason: "unavailable",
    },
  ]);
});

Deno.test("watchlist-quotes-logic WQL-05d: a usable quote produces an ok row carrying price and change", () => {
  const rows = buildWatchlistQuotes(
    ["AAPL"],
    new Map([["AAPL", quoteResponse({ c: 190.5, d: -2.25, dp: -1.17 })]])
  );

  assertEquals(rows, [
    {
      symbol: "AAPL",
      status: "ok",
      price: 190.5,
      change: -2.25,
      changePercent: -1.17,
    },
  ]);
});

Deno.test("watchlist-quotes-logic WQL-05e: a cached quote with a non-positive price degrades to an error row", () => {
  const rows = buildWatchlistQuotes(
    ["AAPL"],
    new Map([["AAPL", quoteResponse({ c: 0 })]])
  );

  assertEquals(rows[0].status, "error");
  assertEquals(rows[0].price, null);
});

Deno.test("watchlist-quotes-logic WQL-05f: a valid price with null change stays status 'ok' with null change fields", () => {
  // DOCUMENTED DECISION: status is driven by whether a PRICE is available, not
  // by whether the delta is. Finnhub returns null d/dp for a symbol with no
  // previous close (an IPO's first session). The price is real and correct, and
  // WatchlistQuoteEntry already types change/changePercent as number | null, so
  // demoting the row to "error" would hide a good price behind a missing delta.
  const rows = buildWatchlistQuotes(
    ["IPOCO"],
    new Map([
      [
        "IPOCO",
        quoteResponse({
          c: 42,
          d: null as unknown as number,
          dp: null as unknown as number,
        }),
      ],
    ])
  );

  assertEquals(rows, [
    {
      symbol: "IPOCO",
      status: "ok",
      price: 42,
      change: null,
      changePercent: null,
    },
  ]);
});

Deno.test("watchlist-quotes-logic WQL-05g: undefined/NaN change fields are normalised to null, never left undefined", () => {
  // JSON.stringify DROPS undefined values, so an unnormalised undefined would
  // reach the client as a missing key rather than the null its type promises.
  const rows = buildWatchlistQuotes(
    ["AAPL"],
    new Map([
      [
        "AAPL",
        quoteResponse({
          c: 10,
          d: undefined as unknown as number,
          dp: NaN,
        }),
      ],
    ])
  );

  assertEquals(rows[0].change, null);
  assertEquals(rows[0].changePercent, null);
  assert("change" in rows[0], "the change key must exist on the row");
  assertEquals(
    JSON.parse(JSON.stringify(rows[0])).change,
    null,
    "change must survive JSON serialisation as null"
  );
});

Deno.test("watchlist-quotes-logic WQL-05h: a mixed batch keeps ok and error rows side by side in input order", () => {
  const rows = buildWatchlistQuotes(
    ["AAPL", "ZZZZZ", "MSFT"],
    new Map([
      ["AAPL", quoteResponse({ c: 190 })],
      ["MSFT", quoteResponse({ c: 400 })],
    ]),
    new Map<string, QuoteRowReason>([["ZZZZZ", "unavailable"]])
  );

  assertEquals(rows.map((r) => r.status), ["ok", "error", "ok"]);
  assertEquals(rows.map((r) => r.price), [190, null, 400]);
});

Deno.test("watchlist-quotes-logic WQL-05i: an ok row never carries a reason", () => {
  // A stale reason left on a priced row would tell the client to distrust a
  // price that is perfectly good.
  const rows = buildWatchlistQuotes(
    ["AAPL"],
    new Map([["AAPL", quoteResponse({ c: 190 })]]),
    new Map<string, QuoteRowReason>([["AAPL", "failed"]])
  );

  assertEquals(rows[0].status, "ok");
  assertEquals(rows[0].reason, undefined);
  assert(!("reason" in rows[0]), "the key must be absent, not undefined");
});

Deno.test("watchlist-quotes-logic WQL-05j: an error row with no recorded reason omits the key rather than guessing", () => {
  // Every handler path supplies a reason, so this state means a bug in the
  // handler. Emitting no reason keeps that visible; emitting a guessed
  // "unavailable" would invite the client to give up on a healthy symbol.
  const rows = buildWatchlistQuotes(["ZZZZZ"], new Map());

  assertEquals(rows[0].status, "error");
  assert(!("reason" in rows[0]));
});

// ---------------------------------------------------------------------------
// WQL-06: the deadline decides whether a call is worth dispatching at all
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-logic WQL-06: plenty of deadline left uses the full per-call timeout", () => {
  assertEquals(timeoutForDeadline(8_000, 4_000), 4_000);
});

Deno.test("watchlist-quotes-logic WQL-06b: less deadline than the per-call timeout shortens the call", () => {
  assertEquals(timeoutForDeadline(1_500, 4_000), 1_500);
});

Deno.test("watchlist-quotes-logic WQL-06c: a deadline already passed skips the call entirely", () => {
  assertEquals(timeoutForDeadline(0, 4_000), null);
  assertEquals(timeoutForDeadline(-250, 4_000), null);
});

Deno.test("watchlist-quotes-logic WQL-06d: a doomed sliver of deadline skips the call instead of dispatching it", () => {
  // REGRESSION: `Math.min(PER_QUOTE_TIMEOUT_MS, remainingMs)` with 10ms left
  // produced getQuote(symbol, { timeoutMs: 10 }) — and the client's
  // `setTimeout(..., Math.max(1, timeoutMs))` means the HTTP request really is
  // dispatched to Finnhub and aborted 10ms later. That burns a slot of the
  // shared key's per-minute quota to obtain nothing.
  assertEquals(timeoutForDeadline(10, 4_000), null);
  assertEquals(timeoutForDeadline(MIN_VIABLE_UPSTREAM_MS - 1, 4_000), null);
});

Deno.test("watchlist-quotes-logic WQL-06e: exactly the minimum viable slice is still dispatched", () => {
  assertEquals(
    timeoutForDeadline(MIN_VIABLE_UPSTREAM_MS, 4_000),
    MIN_VIABLE_UPSTREAM_MS
  );
});

Deno.test("watchlist-quotes-logic WQL-06f: the viability floor is short enough never to skip a healthy call", () => {
  assert(
    MIN_VIABLE_UPSTREAM_MS > 0 && MIN_VIABLE_UPSTREAM_MS <= 500,
    "the floor must be well under a normal Finnhub round-trip, or it would " +
      "defer symbols that would have answered in time"
  );
});

Deno.test("watchlist-quotes-logic WQL-06g: non-finite inputs fail closed to skipping", () => {
  assertEquals(timeoutForDeadline(NaN, 4_000), null);
  assertEquals(timeoutForDeadline(Infinity, 4_000), null);
  assertEquals(timeoutForDeadline(4_000, NaN), null);
});

// ---------------------------------------------------------------------------
// WQL-07: reading a cause back out of the negative cache
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-logic WQL-07: the two cacheable causes round-trip", () => {
  assertEquals(asNegativeCacheReason("unavailable"), "unavailable");
  assertEquals(asNegativeCacheReason("failed"), "failed");
});

Deno.test("watchlist-quotes-logic WQL-07b: an unrecognised marker degrades to the transient cause, not the permanent one", () => {
  // `true` is what an older build wrote for BOTH causes; during a rolling
  // deploy such entries are still live. Reporting them as "failed" tells the
  // client to retry, which is recoverable. Reporting them as "unavailable"
  // would invite the client to write off a healthy symbol.
  for (const value of [true, null, undefined, 1, "deferred", "nonsense"]) {
    assertEquals(
      asNegativeCacheReason(value),
      "failed",
      `${JSON.stringify(value)} must not be read as a permanent symbol fact`
    );
  }
});

// ---------------------------------------------------------------------------
// WQL-08: `degraded` and per-row `reason`
//
// A capacity shortage otherwise reaches the client as an ordinary HTTP 200 full
// of error rows, indistinguishable from success. `degraded` is how a
// success-shaped failure announces itself.
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-logic WQL-08: an all-ok response is not degraded and carries no reasons", () => {
  const response = buildWatchlistResponse(
    ["AAPL", "MSFT"],
    new Map([
      ["AAPL", quoteResponse({ c: 190 })],
      ["MSFT", quoteResponse({ c: 400 })],
    ]),
    new Map()
  );

  assertEquals(response.degraded, false);
  assertEquals(response.quotes.map((q) => q.status), ["ok", "ok"]);
  assertEquals(response.quotes.every((q) => q.reason === undefined), true);
});

Deno.test("watchlist-quotes-logic WQL-08b: unavailable symbols are error rows but do NOT degrade the response", () => {
  // An unknown ticker is a complete, correct answer. Flagging the response as
  // degraded would tell the user the server is struggling when it is not, and
  // would train them to ignore the flag that matters.
  const response = buildWatchlistResponse(
    ["AAPL", "ZZZZZ"],
    new Map([["AAPL", quoteResponse({ c: 190 })]]),
    new Map<string, QuoteRowReason>([["ZZZZZ", "unavailable"]])
  );

  assertEquals(response.degraded, false);
  assertEquals(response.quotes[1].reason, "unavailable");
});

Deno.test("watchlist-quotes-logic WQL-08c: failed symbols are error rows but do NOT degrade the response", () => {
  // A failure means the server did the work and the upstream let it down —
  // real, reported, and retried on the next poll. `degraded` is reserved for
  // work this server declined to do.
  const response = buildWatchlistResponse(
    ["AAPL", "FLAKY"],
    new Map([["AAPL", quoteResponse({ c: 190 })]]),
    new Map<string, QuoteRowReason>([["FLAKY", "failed"]])
  );

  assertEquals(response.degraded, false);
  assertEquals(response.quotes[1].reason, "failed");
});

Deno.test("watchlist-quotes-logic WQL-08d: a single deferred row degrades the whole response", () => {
  const response = buildWatchlistResponse(
    ["AAPL", "MSFT", "TSLA"],
    new Map([
      ["AAPL", quoteResponse({ c: 190 })],
      ["MSFT", quoteResponse({ c: 400 })],
    ]),
    new Map<string, QuoteRowReason>([["TSLA", "deferred"]])
  );

  assertEquals(response.degraded, true);
  assertEquals(response.quotes.map((q) => q.reason), [
    undefined,
    undefined,
    "deferred",
  ]);
});

Deno.test("watchlist-quotes-logic WQL-08e: a fully deferred response (budget granted 0) is degraded end to end", () => {
  const symbols = ["AAPL", "MSFT", "TSLA"];
  const { fetch: toFetch, deferred } = allocateUpstreamWork(symbols, 0);
  assertEquals(toFetch, []);

  const response = buildWatchlistResponse(
    symbols,
    new Map(),
    new Map<string, QuoteRowReason>(deferred.map((s) => [s, "deferred"]))
  );

  assertEquals(response.degraded, true);
  assertEquals(response.quotes.every((q) => q.status === "error"), true);
  assertEquals(response.quotes.every((q) => q.reason === "deferred"), true);
});

Deno.test("watchlist-quotes-logic WQL-08f: a mixed response reports every cause distinctly", () => {
  const response = buildWatchlistResponse(
    ["OK", "GONE", "BROKE", "LATER"],
    new Map([["OK", quoteResponse({ c: 12 })]]),
    new Map<string, QuoteRowReason>([
      ["GONE", "unavailable"],
      ["BROKE", "failed"],
      ["LATER", "deferred"],
    ])
  );

  assertEquals(response.degraded, true);
  assertEquals(response.quotes.map((q) => q.reason), [
    undefined,
    "unavailable",
    "failed",
    "deferred",
  ]);
});

Deno.test("watchlist-quotes-logic WQL-08g: degraded is derived from the rows, so it cannot disagree with them", () => {
  // isDegraded reads the built rows rather than a counter kept beside them.
  // A reason recorded for a symbol that ended up priced anyway must not raise
  // the flag, because no row will show the user anything is missing.
  const quotes = buildWatchlistQuotes(
    ["AAPL"],
    new Map([["AAPL", quoteResponse({ c: 190 })]]),
    new Map<string, QuoteRowReason>([["AAPL", "deferred"]])
  );

  assertEquals(isDegraded(quotes), false);
  assertEquals(isDegraded([]), false);
});

Deno.test("watchlist-quotes-logic WQL-08h: the response body matches WatchlistQuotesResponse after a JSON round trip", () => {
  const response = buildWatchlistResponse(
    ["AAPL", "LATER"],
    new Map([["AAPL", quoteResponse({ c: 190 })]]),
    new Map<string, QuoteRowReason>([["LATER", "deferred"]])
  );

  const parsed = JSON.parse(JSON.stringify(response));
  assertEquals(parsed.degraded, true, "degraded must survive serialisation");
  assertEquals(parsed.quotes[1].reason, "deferred");
  assertEquals(parsed.quotes.length, 2);
});
