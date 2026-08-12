import { assert, assertEquals, assertRejects } from "@std/assert";

// ---------------------------------------------------------------------------
// watchlist-quotes-pipeline.test.ts
//
// Tests `resolveWatchlistQuotes` — the whole body of
// GET /api/stock/watchlist-quotes, minus the HTTP shell.
//
// Why this file exists separately from watchlist-quotes-logic.test.ts: that file
// proves each decision in isolation, which is necessary but not sufficient. The
// defects this round fixed were all WIRING defects — the right helper existed
// and the handler used it on one path and not another. Asserting the pieces
// could not have caught any of them. So the pipeline takes its four effects
// (cache read, cache write, upstream call, budget) as injected callbacks, and
// every test below records what those callbacks were actually asked to do.
//
// In particular: no assertion here is satisfied by "the row degraded correctly".
// A deadline-starved symbol degraded correctly before the fix too. What was
// wrong was the cache write and the budget charge that came with it, so those
// are what get asserted.
// ---------------------------------------------------------------------------

import {
  resolveWatchlistQuotes,
  TRANSIENT_FAILURE_TTL_MS,
  UNKNOWN_SYMBOL_TTL_MS,
  QUOTE_TTL_MS,
  type NegativeCacheReason,
  type QuoteCacheLookup,
  type WatchlistQuotesConfig,
  type WatchlistQuotesDeps,
} from "../../lib/watchlist-quotes-logic.ts";
import type { FinnhubQuote, QuoteResponse } from "../../lib/finnhub/types.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Matches the Route Handler's constants, so the tests describe real behaviour. */
const ROUTE_CONFIG: WatchlistQuotesConfig = {
  maxConcurrentFetches: 5,
  perQuoteTimeoutMs: 4_000,
  deadlineMs: 8_000,
};

interface NegativeWrite {
  symbol: string;
  reason: NegativeCacheReason;
  ttlMs: number;
}

interface QuoteWrite {
  symbol: string;
  quote: QuoteResponse;
  ttlMs: number;
}

interface Recorder {
  deps: WatchlistQuotesDeps<{ granted: number }>;
  /** Symbols an upstream call was actually dispatched for, in dispatch order. */
  dispatched: string[];
  negativeWrites: NegativeWrite[];
  quoteWrites: QuoteWrite[];
  /** Budget reservation requests and grants. */
  reserved: { requested: number; granted: number }[];
  /** Refunds handed back. */
  released: number[];
  /** Current fake clock, in ms. */
  clock: () => number;
}

interface ScenarioOptions {
  /** Positive cache contents. */
  cached?: Record<string, QuoteResponse>;
  /** Negative cache contents. */
  negative?: Record<string, NegativeCacheReason>;
  /** Upstream budget granted per request. Defaults to everything asked for. */
  budget?: number;
  /**
   * What the upstream does for a symbol. Numbers resolve as that price, "throw"
   * rejects, "hang" consumes its whole timeout and then times out — the shape
   * that closes the deadline on later symbols.
   */
  upstream?: Record<string, number | "throw" | "hang">;
  /** Default upstream behaviour for symbols not named above. */
  upstreamDefault?: number | "throw" | "hang";
  marketOpen?: boolean;
}

/**
 * Builds injected dependencies over a FAKE clock.
 *
 * The clock only moves when an upstream call consumes time, so an 8-second
 * deadline is exercised in microseconds of real time and the tests are
 * deterministic rather than timing-dependent. `fetchQuote` advances the clock by
 * exactly the timeout it was handed before rejecting, which is what a genuinely
 * hung Finnhub does to the request budget.
 */
function scenario(options: ScenarioOptions = {}): Recorder {
  const cached = options.cached ?? {};
  const negative = options.negative ?? {};
  const upstream = options.upstream ?? {};
  const upstreamDefault = options.upstreamDefault ?? 100;

  let clock = 0;
  const dispatched: string[] = [];
  const negativeWrites: NegativeWrite[] = [];
  const quoteWrites: QuoteWrite[] = [];
  const reserved: { requested: number; granted: number }[] = [];
  const released: number[] = [];

  const lookup = (symbol: string): QuoteCacheLookup => {
    const quote = cached[symbol];
    if (quote) return { kind: "quote", quote };
    const reason = negative[symbol];
    if (reason) return { kind: "unavailable", reason };
    return { kind: "miss" };
  };

  const deps: WatchlistQuotesDeps<{ granted: number }> = {
    lookup,
    reserveUpstream: (requested) => {
      const granted = Math.min(requested, options.budget ?? requested);
      reserved.push({ requested, granted });
      return { granted };
    },
    releaseUpstream: (_grant, unused) => {
      released.push(unused);
    },
    fetchQuote: async (symbol, timeoutMs): Promise<FinnhubQuote> => {
      dispatched.push(symbol);
      const behaviour = upstream[symbol] ?? upstreamDefault;

      if (behaviour === "hang") {
        // A hung call burns its entire timeout before failing — the exact shape
        // that starves later symbols of deadline.
        //
        // The completion time is computed at DISPATCH and applied at
        // COMPLETION, so concurrent calls share wall-clock time instead of
        // queueing behind each other. Advancing the clock on the way in would
        // model five parallel four-second calls as twenty seconds of elapsed
        // time, and the deadline would close after two calls rather than ten —
        // silently testing a scenario nobody has.
        const completeAt = clock + timeoutMs;
        // One microtask is enough: every worker in the pool dispatches
        // synchronously before any of them resumes.
        await Promise.resolve();
        clock = Math.max(clock, completeAt);
        throw new Error(
          `Finnhub request timed out after ${timeoutMs}ms: /api/v1/quote`
        );
      }
      if (behaviour === "throw") {
        throw new Error(`upstream exploded for ${symbol}`);
      }
      return finnhubQuote({ c: behaviour });
    },
    cacheQuote: (symbol, quote, ttlMs) => {
      quoteWrites.push({ symbol, quote, ttlMs });
    },
    cacheNegative: (symbol, reason, ttlMs) => {
      negativeWrites.push({ symbol, reason, ttlMs });
    },
    now: () => clock,
    isMarketOpen: () => options.marketOpen ?? true,
  };

  return {
    deps,
    dispatched,
    negativeWrites,
    quoteWrites,
    reserved,
    released,
    clock: () => clock,
  };
}

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
  return { ...finnhubQuote(), isMarketOpen: true, ...overrides };
}

/** N distinct valid-looking symbols: SYMA, SYMB, ... */
function symbols(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    `SYM${String.fromCharCode(65 + i)}`
  );
}

function reasonOf(
  outcome: Awaited<ReturnType<typeof resolveWatchlistQuotes>>,
  symbol: string
): string | undefined {
  return outcome.response.quotes.find((q) => q.symbol === symbol)?.reason;
}

// ---------------------------------------------------------------------------
// WQP-01: the happy path
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-01: every symbol prices, nothing is degraded, nothing is negative-cached", async () => {
  const s = scenario({ upstreamDefault: 42 });
  const outcome = await resolveWatchlistQuotes(
    ["AAPL", "MSFT"],
    s.deps,
    ROUTE_CONFIG
  );

  assertEquals(outcome.response.degraded, false);
  assertEquals(outcome.response.quotes.map((q) => q.status), ["ok", "ok"]);
  assertEquals(outcome.response.quotes.map((q) => q.price), [42, 42]);
  assertEquals(outcome.upstreamCallsMade, 2);
  assertEquals(s.negativeWrites, []);
  assertEquals(s.quoteWrites.map((w) => w.ttlMs), [QUOTE_TTL_MS, QUOTE_TTL_MS]);
  assertEquals(s.released, [], "nothing was reserved and left unspent");
});

Deno.test("watchlist-quotes-pipeline WQP-01b: cached symbols cost no upstream call and no budget", async () => {
  const s = scenario({ cached: { AAPL: quoteResponse({ c: 190 }) } });
  const outcome = await resolveWatchlistQuotes(
    ["AAPL", "MSFT"],
    s.deps,
    ROUTE_CONFIG
  );

  assertEquals(s.dispatched, ["MSFT"]);
  assertEquals(s.reserved, [{ requested: 1, granted: 1 }]);
  assertEquals(outcome.response.quotes[0].price, 190);
  assertEquals(outcome.response.degraded, false);
});

// ---------------------------------------------------------------------------
// WQP-02: DEFECT 1 — a deadline-starved symbol must not be negative-cached
//
// The reported scenario, reproduced exactly: 20 misses, concurrency 5, per-call
// timeout 4s, deadline 8s, and a Finnhub that hangs. Rounds 1-2 time out at
// t=4s and t=8s; rounds 3-4 find the deadline already gone and make zero
// upstream calls. Before the fix, all ten of those symbols were rejected with a
// synthetic "Deadline exceeded" Error, classified as transient failures, and
// negative-cached for 10s — recording a purely local scheduling shortage as a
// property of the symbol.
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-02: symbols the deadline starved are never contacted and never negative-cached", async () => {
  const requested = symbols(20);
  const s = scenario({ upstreamDefault: "hang" });

  const outcome = await resolveWatchlistQuotes(requested, s.deps, ROUTE_CONFIG);

  // Two rounds of five got as far as a real (hanging) call; the other ten did
  // not, because the 8s deadline was gone by then.
  assertEquals(s.dispatched.length, 10, "only two rounds of five were dispatched");
  assertEquals(outcome.upstreamCallsMade, 10);
  assertEquals(outcome.deadlineDeferred.length, 10);
  assertEquals(outcome.failed.length, 10, "the dispatched ten really did fail");

  const cachedSymbols = new Set(s.negativeWrites.map((w) => w.symbol));
  assertEquals(
    cachedSymbols.size,
    10,
    "exactly the ten ATTEMPTED symbols may be negative-cached"
  );
  for (const symbol of outcome.deadlineDeferred) {
    assert(
      !cachedSymbols.has(symbol),
      `${symbol} was never contacted, so nothing about it may be written down`
    );
  }
});

Deno.test("watchlist-quotes-pipeline WQP-02b: deadline-starved symbols report 'deferred', not 'failed'", async () => {
  const requested = symbols(20);
  const s = scenario({ upstreamDefault: "hang" });

  const outcome = await resolveWatchlistQuotes(requested, s.deps, ROUTE_CONFIG);

  for (const symbol of outcome.deadlineDeferred) {
    assertEquals(
      reasonOf(outcome, symbol),
      "deferred",
      `${symbol} was never contacted; calling it 'failed' claims an attempt ` +
        `that never happened`
    );
  }
  for (const symbol of outcome.failed) {
    assertEquals(reasonOf(outcome, symbol), "failed");
  }
});

Deno.test("watchlist-quotes-pipeline WQP-02c: a deadline shortage sets degraded, so a 200 is not mistaken for success", async () => {
  const s = scenario({ upstreamDefault: "hang" });
  const outcome = await resolveWatchlistQuotes(symbols(20), s.deps, ROUTE_CONFIG);

  assertEquals(outcome.response.degraded, true);
  assertEquals(outcome.response.quotes.length, 20, "no row is ever dropped");
});

Deno.test("watchlist-quotes-pipeline WQP-02d: a second identical request re-fetches the starved symbols rather than serving stale errors", async () => {
  // The point of not caching a deferred symbol: the next poll must be a genuine
  // retry. Under the old behaviour these ten were pinned to "error" for 10s.
  const requested = symbols(20);
  const first = scenario({ upstreamDefault: "hang" });
  const firstOutcome = await resolveWatchlistQuotes(
    requested,
    first.deps,
    ROUTE_CONFIG
  );

  const starved = firstOutcome.deadlineDeferred;
  assert(starved.length > 0);

  // Second request: only the attempted symbols carry negative-cache entries.
  const second = scenario({
    negative: Object.fromEntries(
      first.negativeWrites.map((w) => [w.symbol, w.reason])
    ),
    upstreamDefault: 55,
  });
  const secondOutcome = await resolveWatchlistQuotes(
    requested,
    second.deps,
    ROUTE_CONFIG
  );

  for (const symbol of starved) {
    assert(
      second.dispatched.includes(symbol),
      `${symbol} must get a real retry, not a cached error row`
    );
    assertEquals(reasonOf(secondOutcome, symbol), undefined);
  }
  assertEquals(secondOutcome.response.degraded, false);
});

// ---------------------------------------------------------------------------
// WQP-03: DEFECT 2 — a doomed request is never dispatched
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-03: no upstream call is dispatched with a sliver of deadline left", async () => {
  // A per-call timeout that leaves an awkward remainder: two rounds of one call
  // each consume 3990ms apiece, leaving 20ms of the 8000ms deadline. Before the
  // fix that produced getQuote(symbol, { timeoutMs: 20 }) — a real HTTP request
  // to Finnhub, aborted 20ms later, charged to the shared key for nothing.
  const s = scenario({ upstreamDefault: "hang" });
  const outcome = await resolveWatchlistQuotes(symbols(4), s.deps, {
    maxConcurrentFetches: 1,
    perQuoteTimeoutMs: 3_990,
    deadlineMs: 8_000,
  });

  assertEquals(s.dispatched.length, 2, "only two calls had viable time");
  assertEquals(
    s.clock(),
    7_980,
    "20ms of deadline remained — enough for the old code to fire a third call"
  );
  assertEquals(outcome.deadlineDeferred.length, 2);
  assertEquals(outcome.upstreamCallsMade, 2);
});

Deno.test("watchlist-quotes-pipeline WQP-03b: a skipped call costs neither an upstream slot nor a cache entry", async () => {
  const s = scenario({ upstreamDefault: "hang" });
  const outcome = await resolveWatchlistQuotes(symbols(4), s.deps, {
    maxConcurrentFetches: 1,
    perQuoteTimeoutMs: 3_990,
    deadlineMs: 8_000,
  });

  for (const symbol of outcome.deadlineDeferred) {
    assert(!s.dispatched.includes(symbol));
    assert(!s.negativeWrites.some((w) => w.symbol === symbol));
  }
});

// ---------------------------------------------------------------------------
// WQP-04: DEFECT 3 — reserved-but-unspent budget is refunded
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-04: budget reserved for calls the deadline cancelled is returned", async () => {
  const s = scenario({ upstreamDefault: "hang" });
  const outcome = await resolveWatchlistQuotes(symbols(20), s.deps, ROUTE_CONFIG);

  assertEquals(s.reserved, [{ requested: 20, granted: 20 }]);
  assertEquals(
    s.released,
    [10],
    "ten calls were reserved and never made; charging the shared key's budget " +
      "for them starves later callers of allowance nothing was bought with"
  );
  assertEquals(
    outcome.upstreamCallsMade + s.released[0],
    20,
    "every reserved token is either spent or returned"
  );
});

Deno.test("watchlist-quotes-pipeline WQP-04b: a request that spends its whole grant refunds nothing", async () => {
  const s = scenario({ upstreamDefault: 10 });
  const outcome = await resolveWatchlistQuotes(symbols(20), s.deps, ROUTE_CONFIG);

  assertEquals(outcome.upstreamCallsMade, 20);
  assertEquals(s.released, [], "a full spend must not hand back phantom tokens");
});

Deno.test("watchlist-quotes-pipeline WQP-04c: a failed call still counts as spent — it did reach Finnhub", async () => {
  const s = scenario({ upstreamDefault: "throw" });
  const outcome = await resolveWatchlistQuotes(["AAPL", "MSFT"], s.deps, ROUTE_CONFIG);

  assertEquals(outcome.upstreamCallsMade, 2);
  assertEquals(
    s.released,
    [],
    "an error response still consumed a slot of the upstream quota"
  );
  assertEquals(outcome.failed, ["AAPL", "MSFT"]);
});

Deno.test("watchlist-quotes-pipeline WQP-04d: budget is refunded even if the fan-out throws unexpectedly", async () => {
  // The refund lives in a `finally`, so a fault between reservation and
  // reconciliation cannot leak allowance.
  const s = scenario();
  s.deps.fetchQuote = () => {
    throw new Error("synchronous fault");
  };
  // A synchronous throw is captured per-item by mapWithConcurrencyLimit, so the
  // pipeline still settles; the counter must reflect the attempts.
  const outcome = await resolveWatchlistQuotes(["AAPL"], s.deps, ROUTE_CONFIG);

  assertEquals(outcome.failed, ["AAPL"]);
  assertEquals(outcome.upstreamCallsMade, 1);
  assertEquals(s.released, []);
});

// ---------------------------------------------------------------------------
// WQP-05: budget-deferred symbols
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-05: a partial grant fetches the first N and defers the rest without caching them", async () => {
  const s = scenario({ budget: 2, upstreamDefault: 30 });
  const outcome = await resolveWatchlistQuotes(
    ["AAPL", "MSFT", "TSLA", "NVDA"],
    s.deps,
    ROUTE_CONFIG
  );

  assertEquals(s.dispatched, ["AAPL", "MSFT"]);
  assertEquals(outcome.budgetDeferred, ["TSLA", "NVDA"]);
  assertEquals(s.negativeWrites, [], "a budget shortage says nothing about a symbol");
  assertEquals(outcome.response.degraded, true);
  assertEquals(outcome.response.quotes.map((q) => q.reason), [
    undefined,
    undefined,
    "deferred",
    "deferred",
  ]);
});

Deno.test("watchlist-quotes-pipeline WQP-05b: a zero grant makes no upstream calls at all and degrades every row", async () => {
  const s = scenario({ budget: 0 });
  const outcome = await resolveWatchlistQuotes(symbols(5), s.deps, ROUTE_CONFIG);

  assertEquals(s.dispatched, []);
  assertEquals(outcome.upstreamCallsMade, 0);
  assertEquals(s.negativeWrites, []);
  assertEquals(s.released, [], "nothing was granted, so nothing can be refunded");
  assertEquals(outcome.response.degraded, true);
  assertEquals(
    outcome.response.quotes.every((q) => q.reason === "deferred"),
    true
  );
});

Deno.test("watchlist-quotes-pipeline WQP-05c: cached symbols still price normally when the budget is spent", async () => {
  // Degradation must be confined to the symbols that needed a call. A user
  // whose watchlist is mostly warm should barely notice a busy minute.
  const s = scenario({
    budget: 0,
    cached: { AAPL: quoteResponse({ c: 190 }), MSFT: quoteResponse({ c: 400 }) },
  });
  const outcome = await resolveWatchlistQuotes(
    ["AAPL", "MSFT", "TSLA"],
    s.deps,
    ROUTE_CONFIG
  );

  assertEquals(outcome.response.quotes.map((q) => q.status), ["ok", "ok", "error"]);
  assertEquals(outcome.response.quotes.map((q) => q.price), [190, 400, null]);
  assertEquals(outcome.response.degraded, true);
});

// ---------------------------------------------------------------------------
// WQP-06: DEFECT 4 — the negative cache must be reachable
//
// The handler's `lookupSymbol` is what fixes this, but the pipeline is what
// proves it matters: a negative-cache hit has to actually suppress the upstream
// call, otherwise every negative-cache write is dead code and an unavailable
// symbol costs a fresh Finnhub call on every single request.
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-06: a negative-cache hit suppresses the upstream call entirely", async () => {
  const s = scenario({ negative: { ZZZZZ: "unavailable" }, upstreamDefault: 10 });
  const outcome = await resolveWatchlistQuotes(
    ["AAPL", "ZZZZZ"],
    s.deps,
    ROUTE_CONFIG
  );

  assertEquals(s.dispatched, ["AAPL"]);
  assertEquals(
    s.reserved,
    [{ requested: 1, granted: 1 }],
    "a known-unavailable symbol must not even consume budget"
  );
  assertEquals(reasonOf(outcome, "ZZZZZ"), "unavailable");
  assertEquals(outcome.response.degraded, false);
});

Deno.test("watchlist-quotes-pipeline WQP-06b: the cached cause is reported back, not flattened to one reason", async () => {
  const s = scenario({
    negative: { GONE: "unavailable", FLAKY: "failed" },
    upstreamDefault: 10,
  });
  const outcome = await resolveWatchlistQuotes(
    ["GONE", "FLAKY"],
    s.deps,
    ROUTE_CONFIG
  );

  assertEquals(s.dispatched, []);
  assertEquals(reasonOf(outcome, "GONE"), "unavailable");
  assertEquals(reasonOf(outcome, "FLAKY"), "failed");
});

Deno.test("watchlist-quotes-pipeline WQP-06c: an unavailable symbol costs one upstream call, then none for the TTL", async () => {
  // The full cycle: first request learns the symbol has no price and writes it
  // down with a full-minute TTL; the second serves that fact for free. Before
  // defect 4 was fixed, the stale `quote:` entry made the second request pay
  // again — and every request after it, for the whole 60s.
  const first = scenario({ upstream: { ZZZZZ: 0 }, upstreamDefault: 0 });
  await resolveWatchlistQuotes(["ZZZZZ"], first.deps, ROUTE_CONFIG);

  assertEquals(first.dispatched, ["ZZZZZ"]);
  assertEquals(first.negativeWrites, [
    { symbol: "ZZZZZ", reason: "unavailable", ttlMs: UNKNOWN_SYMBOL_TTL_MS },
  ]);

  const second = scenario({ negative: { ZZZZZ: "unavailable" } });
  await resolveWatchlistQuotes(["ZZZZZ"], second.deps, ROUTE_CONFIG);

  assertEquals(
    second.dispatched,
    [],
    "an unavailable symbol must stop costing a Finnhub call on every request"
  );
});

// ---------------------------------------------------------------------------
// WQP-07: cause-specific cache lifetimes
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-07: an unknown ticker is cached for a minute, a failure for ten seconds", async () => {
  const s = scenario({ upstream: { GONE: 0, BROKE: "throw", FINE: 12 } });
  const outcome = await resolveWatchlistQuotes(
    ["GONE", "BROKE", "FINE"],
    s.deps,
    ROUTE_CONFIG
  );

  const byName = new Map(s.negativeWrites.map((w) => [w.symbol, w]));
  assertEquals(byName.get("GONE"), {
    symbol: "GONE",
    reason: "unavailable",
    ttlMs: UNKNOWN_SYMBOL_TTL_MS,
  });
  assertEquals(byName.get("BROKE"), {
    symbol: "BROKE",
    reason: "failed",
    ttlMs: TRANSIENT_FAILURE_TTL_MS,
  });
  assertEquals(byName.has("FINE"), false);
  assertEquals(outcome.response.degraded, false, "neither cause is a capacity failure");
});

Deno.test("watchlist-quotes-pipeline WQP-07b: the stored marker is the reason itself, so the cause survives a cache round trip", async () => {
  const first = scenario({ upstream: { BROKE: "throw" } });
  await resolveWatchlistQuotes(["BROKE"], first.deps, ROUTE_CONFIG);

  const second = scenario({
    negative: Object.fromEntries(
      first.negativeWrites.map((w) => [w.symbol, w.reason])
    ),
  });
  const outcome = await resolveWatchlistQuotes(["BROKE"], second.deps, ROUTE_CONFIG);

  assertEquals(
    reasonOf(outcome, "BROKE"),
    "failed",
    "a cached transient failure must not resurface as a permanent 'unavailable'"
  );
});

// ---------------------------------------------------------------------------
// WQP-08: everything at once
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-08: a batch mixing all five outcomes reports each one correctly", async () => {
  const s = scenario({
    cached: { WARM: quoteResponse({ c: 190 }) },
    negative: { GONE: "unavailable" },
    budget: 2,
    upstream: { FRESH: 25, BROKE: "throw" },
  });

  const outcome = await resolveWatchlistQuotes(
    ["WARM", "GONE", "FRESH", "BROKE", "LATER"],
    s.deps,
    ROUTE_CONFIG
  );

  assertEquals(s.dispatched, ["FRESH", "BROKE"], "only the granted two are called");
  assertEquals(outcome.budgetDeferred, ["LATER"]);
  assertEquals(outcome.failed, ["BROKE"]);
  assertEquals(outcome.response.quotes, [
    { symbol: "WARM", status: "ok", price: 190, change: 1.5, changePercent: 1.01 },
    {
      symbol: "GONE",
      status: "error",
      price: null,
      change: null,
      changePercent: null,
      reason: "unavailable",
    },
    { symbol: "FRESH", status: "ok", price: 25, change: 1.5, changePercent: 1.01 },
    {
      symbol: "BROKE",
      status: "error",
      price: null,
      change: null,
      changePercent: null,
      reason: "failed",
    },
    {
      symbol: "LATER",
      status: "error",
      price: null,
      change: null,
      changePercent: null,
      reason: "deferred",
    },
  ]);
  assertEquals(outcome.response.degraded, true, "one deferred row degrades the batch");
});

Deno.test("watchlist-quotes-pipeline WQP-08b: an empty symbol list touches nothing", async () => {
  const s = scenario();
  const outcome = await resolveWatchlistQuotes([], s.deps, ROUTE_CONFIG);

  assertEquals(outcome.response, { quotes: [], degraded: false });
  assertEquals(s.dispatched, []);
  assertEquals(s.reserved, [{ requested: 0, granted: 0 }]);
  assertEquals(s.negativeWrites, []);
});

Deno.test("watchlist-quotes-pipeline WQP-08c: the cached quote is stamped with the server's market state, not Finnhub's", async () => {
  // The entry written here is read back by /api/stock/quote, which returns it
  // verbatim — so a wrong isMarketOpen would leak into a different route's
  // response body for the full 60s TTL.
  for (const marketOpen of [true, false]) {
    const s = scenario({ upstreamDefault: 15, marketOpen });
    await resolveWatchlistQuotes(["AAPL"], s.deps, ROUTE_CONFIG);

    assertEquals(s.quoteWrites.length, 1);
    assertEquals(s.quoteWrites[0].quote.isMarketOpen, marketOpen);
    assertEquals(s.quoteWrites[0].quote.c, 15);
  }
});

// ---------------------------------------------------------------------------
// WQP-09: the concurrency limit is honoured, and matters
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-09: at most maxConcurrentFetches calls are in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const s = scenario();
  s.deps.fetchQuote = async (): Promise<FinnhubQuote> => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    return finnhubQuote({ c: 5 });
  };

  await resolveWatchlistQuotes(symbols(20), s.deps, ROUTE_CONFIG);

  assertEquals(peak, 5, "the fan-out onto the shared key must stay bounded");
});

// ---------------------------------------------------------------------------
// WQP-10: the budget refund is guaranteed on EVERY exit path
//
// The refund lives in a `finally`, but the reservation used to be followed by
// three statements that sat OUTSIDE the corresponding `try` — the allocation,
// the `reasons` seeding, and the deadline's `deps.now()` read. None of them can
// throw as currently written, so nothing leaked; but that made the invariant a
// property of those three statements rather than of the `finally`, and the
// budget it protects is a shared 60-second window that a leak would starve for
// the rest of the minute.
//
// `deps.now` is the honest probe: it is an INJECTED effect, it is read in the
// old gap, and a route is free to hand in something that throws. Under the old
// arrangement this test observes `released: []`.
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-pipeline WQP-10: a fault between reserving and fetching still returns the whole grant", async () => {
  const s = scenario({ upstreamDefault: 10 });
  s.deps.now = () => {
    throw new Error("clock exploded");
  };

  await assertRejects(
    () => resolveWatchlistQuotes(["AAPL", "MSFT"], s.deps, ROUTE_CONFIG),
    Error,
    "clock exploded"
  );

  assertEquals(
    s.reserved,
    [{ requested: 2, granted: 2 }],
    "the reservation was made, so it is owed back"
  );
  assertEquals(s.dispatched, [], "no upstream call was ever dispatched");
  assertEquals(
    s.released,
    [2],
    "all 2 reserved calls must be refunded — a leak here would charge the " +
      "shared key's budget for calls Finnhub never received, for the rest of " +
      "the 60s window"
  );
});

Deno.test("watchlist-quotes-pipeline WQP-10b: a partial grant leaks nothing when the same fault hits", async () => {
  // The budget-limited variant: only 3 of 8 were granted, so exactly 3 — not 8
  // — must come back. A refund larger than the grant would mint allowance.
  const s = scenario({ budget: 3, upstreamDefault: 10 });
  s.deps.now = () => {
    throw new Error("clock exploded");
  };

  await assertRejects(
    () => resolveWatchlistQuotes(symbols(8), s.deps, ROUTE_CONFIG),
    Error,
    "clock exploded"
  );

  assertEquals(s.reserved, [{ requested: 8, granted: 3 }]);
  assertEquals(s.released, [3], "refund the grant, never the request");
});

Deno.test("watchlist-quotes-pipeline WQP-10c: a grant of nothing refunds nothing", async () => {
  // The `unspent > 0` guard: a zero grant must not call releaseUpstream at all,
  // or a fault would look like a refund in the logs.
  const s = scenario({ budget: 0, upstreamDefault: 10 });
  s.deps.now = () => {
    throw new Error("clock exploded");
  };

  await assertRejects(
    () => resolveWatchlistQuotes(symbols(4), s.deps, ROUTE_CONFIG),
    Error,
    "clock exploded"
  );

  assertEquals(s.reserved, [{ requested: 4, granted: 0 }]);
  assertEquals(s.released, []);
});
