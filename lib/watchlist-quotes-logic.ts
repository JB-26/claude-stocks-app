// ---------------------------------------------------------------------------
// Pure logic for GET /api/stock/watchlist-quotes
//
// Extracted from the Route Handler for the same reason as
// lib/watchlist-quotes-validation.ts: route handlers import via the "@/" path
// alias, which plain `deno test` cannot resolve. Nothing here imports Next.js,
// the cache, the rate limiter or the Finnhub client — the small functions are
// pure over plain data, and `resolveWatchlistQuotes` takes the four effects it
// needs (cache read, cache write, upstream call, budget) as injected callbacks.
//
// The handler is therefore reduced to glue: build the dependencies, call
// `resolveWatchlistQuotes`, log, respond. Every branch that used to be
// untestable — cache hit/miss split, don't-cache-failures, the `c > 0`
// heuristic, budget-denied symbols, deadline-starved symbols, budget refunds
// and row construction — is covered by tests/unit/watchlist-quotes-logic.test.ts
// and tests/unit/watchlist-quotes-pipeline.test.ts.
// ---------------------------------------------------------------------------

import { mapWithConcurrencyLimit } from "./concurrency";
import type {
  FinnhubQuote,
  QuoteResponse,
  WatchlistQuoteEntry,
  WatchlistQuotesResponse,
} from "./finnhub/types";

// ---------------------------------------------------------------------------
// Why a row has no price
// ---------------------------------------------------------------------------

/**
 * The `reason` carried by an "error" row. See WatchlistQuoteEntry for the full
 * semantics — in short: "unavailable" is a fact about the SYMBOL, "deferred" is
 * a fact about THIS SERVER right now, "failed" is a fact about one attempt.
 */
export type QuoteRowReason = NonNullable<WatchlistQuoteEntry["reason"]>;

/**
 * The subset of reasons that may be written to the negative cache.
 *
 * "deferred" is excluded AT THE TYPE LEVEL, not by convention. A deferred
 * symbol was never contacted — the shortage was in this server's budget or
 * clock, not in the symbol — so recording it as a symbol-level fact would
 * extend a momentary local shortage into a minute of stale "error" rows for
 * every subsequent caller, including ones with budget to spare.
 */
export type NegativeCacheReason = Exclude<QuoteRowReason, "deferred">;

/**
 * Reads a value out of the negative cache as a reason.
 *
 * Anything unrecognised — a marker written by an older build during a rolling
 * deploy, say — is reported as "failed" rather than "unavailable". Both are
 * error rows, but "failed" is the transient, retryable one: mislabelling a
 * temporary blip as a permanent property of the symbol is the more harmful
 * direction of the two, since the client is entitled to give up on a symbol
 * that reports itself unavailable.
 */
export function asNegativeCacheReason(value: unknown): NegativeCacheReason {
  return value === "unavailable" ? "unavailable" : "failed";
}

// ---------------------------------------------------------------------------
// Cache keys and TTLs
// ---------------------------------------------------------------------------

/**
 * Positive cache key. Identical format and TTL to /api/stock/quote
 * (`quote:${symbol}`, 60s) so the two routes genuinely share entries: a symbol
 * warmed by an open dashboard costs this route nothing.
 */
export function quoteCacheKey(symbol: string): string {
  return `quote:${symbol}`;
}

/**
 * Negative cache key — records that a symbol has no usable price right now,
 * and which of the two cacheable causes applies.
 *
 * Deliberately a DIFFERENT namespace from `quoteCacheKey`. /api/stock/quote
 * reads `quote:${symbol}` and returns whatever it finds verbatim, so writing a
 * marker under that key would poison its response body. Collision is
 * impossible in the other direction too: SYMBOL_RE (/^[A-Z]{1,10}$/) admits no
 * colons or lowercase, so no valid symbol can produce "unavailable:...".
 */
export function unavailableCacheKey(symbol: string): string {
  return `quote:unavailable:${symbol}`;
}

/** TTL for a successful quote. Matches /api/stock/quote. */
export const QUOTE_TTL_MS = 60_000;

/**
 * TTL for a symbol Finnhub answered for but reported no price on (HTTP 200
 * with `c: 0` — how it responds to an unknown ticker).
 *
 * This condition is stable, not transient: a ticker that does not exist will
 * not start existing within the minute. Caching it for the full quote TTL is
 * what stops a caller cycling regex-valid-but-bogus symbols from getting a 0%
 * cache hit rate and a free upstream call on every single request.
 */
export const UNKNOWN_SYMBOL_TTL_MS = 60_000;

/**
 * TTL for a symbol whose lookup was attempted and threw — network error,
 * timeout, Finnhub 429 or 5xx.
 *
 * Deliberately much shorter than UNKNOWN_SYMBOL_TTL_MS. These failures are
 * transient and the original code cached them for 0s precisely so the next
 * poll would retry; pinning a real symbol to "error" for a full 60s because of
 * one blip would be a regression. 10s preserves a prompt retry while still
 * collapsing a storm of repeated failures onto ~6 upstream calls per minute
 * per symbol instead of one per request.
 */
export const TRANSIENT_FAILURE_TTL_MS = 10_000;

// ---------------------------------------------------------------------------
// Cache partitioning
// ---------------------------------------------------------------------------

/** What the handler's cache lookup found for one symbol. */
export type QuoteCacheLookup =
  | { kind: "quote"; quote: QuoteResponse }
  | { kind: "unavailable"; reason: NegativeCacheReason }
  | { kind: "miss" };

export interface SymbolPartition {
  /** Symbols served straight from the positive cache. */
  cached: Map<string, QuoteResponse>;
  /**
   * Symbols with a fresh negative-cache entry, mapped to the cause recorded
   * when the entry was written. No upstream call; the row degrades.
   */
  knownUnavailable: Map<string, NegativeCacheReason>;
  /** Symbols that require an upstream call, in input order. */
  missing: string[];
}

/**
 * Splits the requested symbols into cache hits, known-unavailable symbols, and
 * symbols needing an upstream call.
 *
 * A cached entry with a non-positive price is treated as a miss rather than as
 * a hit: it can only come from another route that does not apply the `c > 0`
 * heuristic, and serving it as "ok" would show a £0.00 price. The handler's
 * lookup is expected to have already fallen through to the negative cache in
 * that case (see `lookupSymbol`); this check is the second line of defence.
 */
export function partitionSymbols(
  symbols: readonly string[],
  lookup: (symbol: string) => QuoteCacheLookup
): SymbolPartition {
  const cached = new Map<string, QuoteResponse>();
  const knownUnavailable = new Map<string, NegativeCacheReason>();
  const missing: string[] = [];

  for (const symbol of symbols) {
    const found = lookup(symbol);
    if (found.kind === "quote" && found.quote.c > 0) {
      cached.set(symbol, found.quote);
    } else if (found.kind === "unavailable") {
      knownUnavailable.set(symbol, found.reason);
    } else {
      missing.push(symbol);
    }
  }

  return { cached, knownUnavailable, missing };
}

// ---------------------------------------------------------------------------
// Upstream budget allocation
// ---------------------------------------------------------------------------

export interface UpstreamAllocation {
  /** Symbols the budget allows to be fetched now, in input order. */
  fetch: string[];
  /** Symbols denied by the budget — deferred, and NOT negative-cached. */
  deferred: string[];
}

/**
 * Splits cache misses into the ones the upstream budget permits and the ones it
 * does not.
 *
 * Input order decides who gets served, so the allocation is deterministic and a
 * caller cannot influence it by reordering. Deferred symbols must NOT be
 * negative-cached — the budget says nothing about the symbol, and caching a
 * budget rejection would extend a momentary shortage into a minute of stale
 * "error" rows.
 */
export function allocateUpstreamWork(
  missing: readonly string[],
  allowance: number
): UpstreamAllocation {
  const granted = Number.isFinite(allowance)
    ? Math.min(missing.length, Math.max(0, Math.floor(allowance)))
    : 0;

  return {
    fetch: missing.slice(0, granted),
    deferred: missing.slice(granted),
  };
}

// ---------------------------------------------------------------------------
// The request deadline
// ---------------------------------------------------------------------------

/**
 * The shortest slice of the request deadline worth spending on an upstream
 * call.
 *
 * A quote round-trip to Finnhub does not complete in single-digit milliseconds,
 * so dispatching one with (say) 10ms left does not produce a quote — it opens a
 * real HTTP request against the shared API key, aborts it moments later, and
 * charges the key's per-minute quota for an answer nobody receives. Below this
 * floor the call is skipped entirely and the symbol is deferred instead, which
 * costs nothing and is honest about what happened.
 *
 * 250ms is chosen to be comfortably shorter than a healthy round-trip (tens of
 * ms) so a viable call is never skipped, while still refusing the doomed tail
 * of the deadline.
 */
export const MIN_VIABLE_UPSTREAM_MS = 250;

/**
 * The timeout to give one upstream call, or `null` if it should not be made.
 *
 * `null` means "defer this symbol": either the deadline has already passed or
 * too little of it remains for a call to plausibly succeed. Non-finite input
 * fails closed to `null` for the same reason `normaliseLimit` clamps to 1 — a
 * garbage value must not be read as "unlimited time" on the one code path whose
 * job is to bound spend against a shared key.
 */
export function timeoutForDeadline(
  remainingMs: number,
  perCallTimeoutMs: number
): number | null {
  if (!Number.isFinite(remainingMs) || !Number.isFinite(perCallTimeoutMs)) {
    return null;
  }
  if (remainingMs < MIN_VIABLE_UPSTREAM_MS) return null;
  return Math.min(perCallTimeoutMs, remainingMs);
}

// ---------------------------------------------------------------------------
// Upstream result classification
// ---------------------------------------------------------------------------

/**
 * The result of one slot in the fan-out.
 *
 * A slot that the deadline closed before dispatch resolves as "skipped" rather
 * than rejecting. A rejection means "we called Finnhub and it went wrong"; a
 * skip means "we never called Finnhub". Collapsing the two — which is what
 * rejecting with a `Deadline exceeded` Error did — makes a purely local
 * scheduling shortage indistinguishable from an upstream fault, and gets the
 * symbol negative-cached for something it did not do.
 */
export type UpstreamAttempt =
  | { kind: "quote"; quote: FinnhubQuote }
  | { kind: "skipped" };

/**
 * What to do with one settled upstream slot.
 *
 * For every error kind, `kind` IS the row's `reason` — the two vocabularies are
 * deliberately the same so a mismatch cannot be introduced by a mapping table.
 *
 * Note that "deferred" has no `ttlMs` field. That is the point: the negative
 * cache write in the handler reads `outcome.ttlMs`, so a deferred outcome
 * cannot be negative-cached without a compile error.
 */
export type QuoteOutcome =
  | { kind: "ok"; quote: QuoteResponse; ttlMs: number }
  | { kind: "unavailable"; ttlMs: number }
  | { kind: "failed"; detail: unknown; ttlMs: number }
  | { kind: "deferred" };

/**
 * Classifies a settled upstream slot into a cache action and a row value.
 *
 * - fulfilled with a quote, `c > 0` → cache for QUOTE_TTL_MS, row is "ok".
 * - fulfilled with a quote, `c <= 0` (or a non-finite `c`) → Finnhub's HTTP 200
 *   answer for an unknown or dataless ticker. A property of the symbol, so it
 *   is negative-cached for UNKNOWN_SYMBOL_TTL_MS. Same `c > 0` heuristic
 *   /api/stock/movers uses to drop stale rows.
 * - fulfilled with "skipped" → never contacted. "deferred", not cacheable.
 * - rejected → attempted and errored. Negative-cached for the much shorter
 *   TRANSIENT_FAILURE_TTL_MS.
 */
export function classifyQuoteResult(
  result: PromiseSettledResult<UpstreamAttempt>,
  marketOpen: boolean
): QuoteOutcome {
  if (result.status === "rejected") {
    return {
      kind: "failed",
      detail: result.reason,
      ttlMs: TRANSIENT_FAILURE_TTL_MS,
    };
  }

  if (result.value.kind === "skipped") {
    return { kind: "deferred" };
  }

  const raw = result.value.quote;
  if (!(raw.c > 0)) {
    return { kind: "unavailable", ttlMs: UNKNOWN_SYMBOL_TTL_MS };
  }

  return {
    kind: "ok",
    ttlMs: QUOTE_TTL_MS,
    quote: {
      c: raw.c,
      d: raw.d,
      dp: raw.dp,
      h: raw.h,
      l: raw.l,
      o: raw.o,
      pc: raw.pc,
      t: raw.t,
      isMarketOpen: marketOpen,
    },
  };
}

// ---------------------------------------------------------------------------
// Response construction
// ---------------------------------------------------------------------------

/**
 * Normalises a numeric field to `number | null`.
 *
 * Finnhub types `d`/`dp` as numbers but returns `null` for them on symbols with
 * no previous close. Passing that through unchanged risks emitting `undefined`,
 * which JSON.stringify drops entirely — the client would then see a missing key
 * rather than the `null` its type promises.
 */
function toFiniteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Builds one response row per requested symbol, in input order.
 *
 * Rows are never dropped — a symbol with no usable quote degrades to status
 * "error" with null numeric fields so the client can still render the row. The
 * `reason` on that row comes from `reasonsBySymbol`, which the handler builds
 * to cover every symbol it could not price.
 *
 * A quote with a valid price but a null/absent change is deliberately status
 * "ok" with `change: null` / `changePercent: null`, NOT "error". The price is
 * genuinely available; only the delta is missing (a stock with no previous
 * close, e.g. an IPO's first session). Demoting the whole row to "error" would
 * hide a real, correct price, and the response type already allows null change
 * fields alongside a non-null price.
 *
 * An error row with no entry in `reasonsBySymbol` is emitted with no `reason`
 * at all rather than a guessed one. Every path in the handler supplies a
 * reason, so an absent one means a bug in the handler — and a row that admits
 * it does not know is far easier to diagnose (and far safer for a client
 * deciding whether to keep a previous price) than one that confidently reports
 * the wrong cause.
 */
export function buildWatchlistQuotes(
  symbols: readonly string[],
  quotesBySymbol: ReadonlyMap<string, QuoteResponse>,
  reasonsBySymbol: ReadonlyMap<string, QuoteRowReason> = new Map()
): WatchlistQuoteEntry[] {
  return symbols.map((symbol) => {
    const quote = quotesBySymbol.get(symbol);

    if (!quote || !(quote.c > 0)) {
      const reason = reasonsBySymbol.get(symbol);
      return {
        symbol,
        status: "error",
        price: null,
        change: null,
        changePercent: null,
        ...(reason ? { reason } : {}),
      };
    }

    return {
      symbol,
      status: "ok",
      price: quote.c,
      change: toFiniteOrNull(quote.d),
      changePercent: toFiniteOrNull(quote.dp),
    };
  });
}

/**
 * Whether a response is degraded — i.e. the server knowingly returned
 * incomplete data because it ran out of upstream budget or time.
 *
 * Derived from the rows that were actually built, not from a parallel counter
 * kept alongside them. The flag therefore cannot drift out of agreement with
 * the body it describes: if no row says "deferred", the response is not
 * degraded, by construction.
 */
export function isDegraded(quotes: readonly WatchlistQuoteEntry[]): boolean {
  return quotes.some((quote) => quote.reason === "deferred");
}

/** Assembles the response body, deriving `degraded` from the rows themselves. */
export function buildWatchlistResponse(
  symbols: readonly string[],
  quotesBySymbol: ReadonlyMap<string, QuoteResponse>,
  reasonsBySymbol: ReadonlyMap<string, QuoteRowReason>
): WatchlistQuotesResponse {
  const quotes = buildWatchlistQuotes(symbols, quotesBySymbol, reasonsBySymbol);
  return { quotes, degraded: isDegraded(quotes) };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * The part of a budget reservation this pipeline needs.
 *
 * Structural, so `UpstreamReservation` from lib/ratelimit.ts satisfies it
 * without this module importing the rate limiter — and so a test can supply a
 * counter instead of a real 60-second window.
 */
export interface UpstreamGrant {
  readonly granted: number;
}

/** The effects `resolveWatchlistQuotes` needs, supplied by the Route Handler. */
export interface WatchlistQuotesDeps<G extends UpstreamGrant = UpstreamGrant> {
  /** Reads both cache namespaces for one symbol. */
  lookup: (symbol: string) => QuoteCacheLookup;
  /** Reserves upstream budget. May grant fewer calls than requested, or none. */
  reserveUpstream: (requested: number) => G;
  /** Returns reserved calls that were never made. */
  releaseUpstream: (grant: G, unused: number) => void;
  /** One upstream quote lookup, already bounded by `timeoutMs`. */
  fetchQuote: (symbol: string, timeoutMs: number) => Promise<FinnhubQuote>;
  /** Writes a usable quote to the positive cache. */
  cacheQuote: (symbol: string, quote: QuoteResponse, ttlMs: number) => void;
  /**
   * Writes a negative-cache marker. The reason type makes it impossible to
   * record a deferred symbol here.
   */
  cacheNegative: (
    symbol: string,
    reason: NegativeCacheReason,
    ttlMs: number
  ) => void;
  /** Wall clock, injectable so the deadline is testable without real waiting. */
  now: () => number;
  /** Evaluated once the fan-out settles, matching /api/stock/quote's stamping. */
  isMarketOpen: () => boolean;
}

/** Tunables the Route Handler owns. */
export interface WatchlistQuotesConfig {
  maxConcurrentFetches: number;
  perQuoteTimeoutMs: number;
  deadlineMs: number;
}

export interface WatchlistQuotesOutcome {
  response: WatchlistQuotesResponse;
  /** Upstream calls actually dispatched — what the budget really bought. */
  upstreamCallsMade: number;
  /** Symbols never contacted because the budget was already spent. */
  budgetDeferred: string[];
  /** Symbols never contacted because the deadline closed first. */
  deadlineDeferred: string[];
  /** Symbols whose lookup was dispatched and threw. */
  failed: string[];
}

/**
 * Runs one watchlist batch: cache, budget, bounded fan-out, cache writes, rows.
 *
 * The invariants worth stating, because each one is a defect that was fixed
 * here rather than an accident of the code:
 *
 * - A symbol that was never contacted is NEVER negative-cached. Both flavours
 *   of "never contacted" — budget spent, deadline closed — are facts about this
 *   server at this instant, not about the symbol. Writing either one down would
 *   extend a momentary local shortage into a minute of stale "error" rows for
 *   every later caller, including ones with budget to spare.
 * - A call is only dispatched with enough deadline left to plausibly complete.
 *   Firing one with milliseconds to spare does not produce a quote; it produces
 *   an aborted HTTP request that still cost a slot of the shared key's quota.
 * - Reserved budget that goes unspent is returned, on EVERY exit path including
 *   a thrown one. Reservation necessarily happens before the work, so a slow
 *   minute would otherwise charge both budgets for calls Finnhub never
 *   received. Nothing at all sits between the reservation and the `try` that
 *   guarantees this, so the guarantee holds by construction rather than by
 *   inspection of what the statements in between happen to do.
 */
export async function resolveWatchlistQuotes<G extends UpstreamGrant>(
  symbols: readonly string[],
  deps: WatchlistQuotesDeps<G>,
  config: WatchlistQuotesConfig
): Promise<WatchlistQuotesOutcome> {
  const partition = partitionSymbols(symbols, deps.lookup);

  // Accumulates the cause for every symbol this request cannot price. Seeded
  // with the negative-cache hits; the budget, the deadline and the upstream
  // results add to it below.
  const reasons = new Map<string, QuoteRowReason>(partition.knownUnavailable);

  let upstreamCallsMade = 0;
  let toFetch: string[] = [];
  let budgetDeferred: string[] = [];
  let settled: PromiseSettledResult<UpstreamAttempt>[];

  // The reservation is the LAST statement before the try, and everything that
  // consumes it is inside. Allocation, the deadline read and the fan-out all
  // used to sit in the gap between the two: none of them can throw today, so
  // nothing leaked, but "nothing leaks" was a fact about the current call sites
  // rather than a guarantee of the `finally`. An injected `now` that throws, or
  // any future statement added here, would have leaked the whole grant for the
  // rest of the window. Now the guarantee is total by construction.
  const grant = deps.reserveUpstream(partition.missing.length);

  try {
    const allocation = allocateUpstreamWork(partition.missing, grant.granted);
    toFetch = allocation.fetch;
    budgetDeferred = allocation.deferred;
    for (const symbol of budgetDeferred) reasons.set(symbol, "deferred");

    const deadline = deps.now() + config.deadlineMs;

    settled = await mapWithConcurrencyLimit(
      toFetch,
      config.maxConcurrentFetches,
      async (symbol): Promise<UpstreamAttempt> => {
        const timeoutMs = timeoutForDeadline(
          deadline - deps.now(),
          config.perQuoteTimeoutMs
        );
        // Too little of the deadline left for a call to plausibly land.
        if (timeoutMs === null) return { kind: "skipped" };

        upstreamCallsMade++;
        return { kind: "quote", quote: await deps.fetchQuote(symbol, timeoutMs) };
      }
    );
  } finally {
    // In a `finally` so an unexpected fault cannot leak budget either. The
    // counter is incremented at the moment of dispatch, so this is exactly the
    // calls that were reserved and never made.
    const unspent = grant.granted - upstreamCallsMade;
    if (unspent > 0) deps.releaseUpstream(grant, unspent);
  }

  const marketOpen = deps.isMarketOpen();
  const quotesBySymbol = new Map(partition.cached);
  const failed: string[] = [];
  const deadlineDeferred: string[] = [];

  settled.forEach((result, index) => {
    // mapWithConcurrencyLimit returns exactly one settled result per input item
    // in input order, so index maps back to the symbol.
    const symbol = toFetch[index];
    const outcome = classifyQuoteResult(result, marketOpen);

    if (outcome.kind === "ok") {
      deps.cacheQuote(symbol, outcome.quote, outcome.ttlMs);
      quotesBySymbol.set(symbol, outcome.quote);
      return;
    }

    if (outcome.kind === "deferred") {
      // Never contacted. Nothing was learned about the symbol, so nothing about
      // the symbol is written down — only the row degrades.
      reasons.set(symbol, "deferred");
      deadlineDeferred.push(symbol);
      return;
    }

    // "unavailable" or "failed": Finnhub was asked and answered (or errored),
    // so the result is a cacheable fact about the symbol. The TTL carries the
    // cause, and so does the stored value, so a later request can tell the two
    // apart without re-fetching.
    deps.cacheNegative(symbol, outcome.kind, outcome.ttlMs);
    reasons.set(symbol, outcome.kind);
    if (outcome.kind === "failed") failed.push(symbol);
  });

  return {
    response: buildWatchlistResponse(symbols, quotesBySymbol, reasons),
    upstreamCallsMade,
    budgetDeferred,
    deadlineDeferred,
    failed,
  };
}
