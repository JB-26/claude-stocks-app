import { NextResponse } from "next/server";
import { getQuote } from "@/lib/finnhub/client";
import { getCached, setCached } from "@/lib/cache";
import {
  checkRateLimit,
  getClientIdentity,
  releaseUpstreamCalls,
  reserveUpstreamCalls,
  type UpstreamBudgetBucket,
} from "@/lib/ratelimit";
import { parseSymbolsParam } from "@/lib/watchlist-quotes-validation";
import {
  asNegativeCacheReason,
  quoteCacheKey,
  resolveWatchlistQuotes,
  unavailableCacheKey,
  type QuoteCacheLookup,
} from "@/lib/watchlist-quotes-logic";
import { isMarketOpen } from "@/lib/utils";
import type { QuoteResponse } from "@/lib/finnhub/types";

// ---------------------------------------------------------------------------
// Protecting the shared Finnhub API key
//
// Every visitor shares ONE free-tier key capped at 60 calls/minute. This is the
// only fan-out route on the app: one request can ask for up to MAX_WATCHLIST
// (20) symbols, and Finnhub's free tier has no batch-quote endpoint, so each
// cache miss is its own upstream call.
//
// Caching alone does not bound that. The per-symbol `quote:` cache only helps
// when symbols REPEAT — a caller cycling regex-valid but bogus tickers
// (AAAAA, AAAAB, ...) or rotating through the thousands of real ones gets a 0%
// hit rate, so cache hits cannot be relied on as the primary protection. Three
// mechanisms therefore bound the upstream cost directly:
//
//   1. A tighter per-client request limit on this pathname (below). The 30/min
//      default is sized for the house pattern of 1 request → 1 upstream call
//      (/api/stock/quote); at a fan-out of 20 it would permit 600 upstream
//      calls/min from a single client against a 60/min key. This is a coarse
//      first gate — it reduces the ceiling but cannot set it.
//   2. Upstream call budgets, per-client and global, metered on the OUTBOUND
//      side so the ceiling is a number of Finnhub calls per minute rather than
//      (requests × fan-out). The global bucket is what /api/stock/movers gets
//      for free from its single `movers:snapshot` key — it fans out to 14, but
//      costs at most 14 upstream calls/minute in total, for everyone.
//   3. Negative caching of unavailable and failed lookups, so a bogus or
//      currently-broken symbol stops being a free re-fetch on every request.
//      TTLs are split by cause (see lib/watchlist-quotes-logic.ts): unknown
//      symbols are cached for a full minute, transient failures for only 10s so
//      a real symbol recovers promptly. Symbols that were never contacted are
//      NOT cached at all — see "Honest degradation" below.
//
// Sustained worst case: 25 upstream calls/min from any single identified
// client, and 30/min across all clients combined. With movers' 14/min that
// leaves at least 16/min of the free tier for the dashboard routes (quote,
// search, news).
//
// "Sustained" is the operative word. These are FIXED 60-second windows, like
// every other limiter in lib/ratelimit.ts, so a burst straddling a window
// boundary can place up to 2x the limit in a short span (worst case ~60 calls
// across the couple of seconds spanning a boundary) before settling back to
// 30/min. Finnhub's own quota is also per-minute, so a boundary burst can cost
// one minute of degraded rows on the other routes; that is an accepted cost of
// fixed windows, not a claim that 30/min is an instantaneous ceiling.
//
// A symbol already warmed by an open dashboard is genuinely free: /api/stock/
// quote writes `quote:${symbol}` with the same 60s TTL. The ticker tape does
// NOT warm anything for this route — /api/stock/movers writes only its
// `movers:snapshot` key and never any per-symbol `quote:` entry.
//
// Honest degradation
//
// Budgets bound cost by refusing work, which means this route routinely returns
// rows it could not price. Every such row carries a `reason` saying which kind
// of nothing it is, and the response carries `degraded: true` whenever any row
// was never even attempted. The three causes are not interchangeable:
// "unavailable" is a fact about the symbol and may be cached; "failed" is one
// bad attempt and is cached briefly; "deferred" is a fact about this server's
// budget or clock at this instant and is never cached, because doing so would
// convert a momentary local shortage into a minute of stale errors for
// everyone. See WatchlistQuoteEntry in lib/finnhub/types.ts.
// ---------------------------------------------------------------------------

/**
 * Requests per identified client per minute for this pathname, overriding the
 * 30/min default.
 *
 * Sized from the panel's actual behaviour: a 60s poll, plus one refetch per
 * watchlist addition. A user can make at most MAX_WATCHLIST (20) additions
 * before the list is full, and each addition costs exactly one upstream call
 * because every other symbol is already cached — so 20 requests/min covers the
 * worst legitimate burst without ever 429ing a real user mid-edit.
 *
 * This is a coarse first gate only. It cannot bound the API-key cost on its
 * own (20 requests x 20 symbols is still 400 potential upstream calls); the
 * budgets below are what actually bind.
 */
const MAX_REQUESTS_PER_MINUTE = 20;

/**
 * Requests per minute for the SHARED bucket that unattributable callers all
 * count against together.
 *
 * MAX_REQUESTS_PER_MINUTE is one user's allowance. Charging it to a bucket that
 * may hold every visitor at once — which is what happens on a deployment whose
 * runtime supplies no connecting address at all — would cap the entire app at
 * one user's worth of traffic and 429 the second visitor, turning a fairness
 * control into an outage. It is deliberately much larger.
 *
 * A larger allowance is only defensible while membership cannot be chosen by
 * the caller, which is precisely what `getClientIdentity` now guarantees: this
 * bucket is reachable only via `source: "absent"`, i.e. no X-Forwarded-For at
 * all. Sending an empty or comma-only header used to reach it, which bought any
 * client 6x this route's inbound allowance and skipped
 * MAX_UPSTREAM_CALLS_PER_IP; such a caller is now metered as one client against
 * UNTRUSTED_CLIENT and gets MAX_REQUESTS_PER_MINUTE like everybody else.
 *
 * Raising it does not raise the key's exposure. The upstream budgets are what
 * bound Finnhub calls, and MAX_UPSTREAM_CALLS_GLOBAL (30/min) applies to every
 * caller identified or not; once it is spent, further requests are pure cache
 * reads. So this number only needs to bound inbound request volume — CPU, URL
 * parsing, cache churn — for which 2/second across the whole deployment is
 * ample headroom for a handful of shared-bucket users and still stops a runaway
 * client loop dead.
 */
const UNIDENTIFIED_MAX_REQUESTS_PER_MINUTE = 120;

/**
 * Upstream Finnhub calls one IDENTIFIED client may cause per minute.
 *
 * 25 is a little above MAX_WATCHLIST (20) so a cold start of a full watchlist
 * plus a partial refresh fits inside one window. A client that exceeds it does
 * not get an error: the surplus symbols are served as "deferred" rows and
 * recover on the next poll.
 *
 * Applied ONLY to identified clients. There is no per-client budget for the
 * shared bucket, because a per-client budget spread over an unknown number of
 * clients is not one — it would mean the first visitor's cold start ate 20 of
 * everyone's 25 and left the rest of the deployment permanently deferred. When
 * clients cannot be told apart the only meaningful bound is the global one, and
 * that one still applies in full.
 */
const MAX_UPSTREAM_CALLS_PER_IP = 25;

/**
 * Upstream Finnhub calls this route may cause per minute across ALL clients.
 *
 * This is the route's share of the 60/min key, and the only budget that does
 * not depend on being able to identify the caller. It means a distributed
 * caller gains nothing from spreading across IPs, at the cost of deferring rows
 * for everyone once the budget is spent — a bounded, graceful degradation
 * rather than starving /api/stock/quote, /search and /news. Subject to the
 * fixed-window caveat noted above.
 */
const MAX_UPSTREAM_CALLS_GLOBAL = 30;

/** Shared budget key — one bucket for the whole deployment. */
const GLOBAL_UPSTREAM_BUDGET_KEY = "watchlist-quotes:upstream:global";

/** Bounds the burst shape of a cold start. Applies to cache misses only. */
const MAX_CONCURRENT_FETCHES = 5;

/** Per-symbol upstream timeout. */
const PER_QUOTE_TIMEOUT_MS = 4_000;

/**
 * Wall-clock budget for the whole fan-out.
 *
 * Without it, worst-case latency is (misses / concurrency) x per-call timeout.
 * Symbols not reached before the deadline are never dispatched at all and
 * degrade to "deferred" rows, so the handler always answers well inside a
 * normal request timeout.
 */
const UPSTREAM_DEADLINE_MS = 8_000;

/**
 * Reads both cache namespaces for one symbol.
 *
 * The positive entry only counts as an answer when it carries a usable price.
 * /api/stock/quote caches its response unconditionally, including Finnhub's
 * `{ c: 0 }` reply for an unknown ticker, so `quote:${symbol}` can hold a
 * priceless entry for a full minute. Returning that as a hit made the negative
 * cache unreachable for exactly the symbols it exists to protect: the row still
 * degraded correctly, but the symbol was re-fetched from Finnhub on every
 * single request for the life of the entry, and every negative-cache write for
 * it was dead code. Falling through to the negative namespace is what makes an
 * unavailable symbol cost one upstream call per minute instead of one per
 * request.
 */
function lookupSymbol(symbol: string): QuoteCacheLookup {
  const quote = getCached<QuoteResponse>(quoteCacheKey(symbol));
  if (quote && quote.c > 0) return { kind: "quote", quote };

  const negative = getCached<unknown>(unavailableCacheKey(symbol));
  if (negative !== null) {
    return { kind: "unavailable", reason: asNegativeCacheReason(negative) };
  }

  return { kind: "miss" };
}

export async function GET(request: Request): Promise<NextResponse> {
  // Resolved once and threaded through both gates, so the request limit and the
  // upstream budget provably meter the same client.
  const identity = getClientIdentity(request);

  const rateLimit = checkRateLimit(request, {
    maxRequests: MAX_REQUESTS_PER_MINUTE,
    unidentifiedMaxRequests: UNIDENTIFIED_MAX_REQUESTS_PER_MINUTE,
    identity,
  });
  if (!rateLimit.allowed) {
    const retryAfterSeconds = Math.ceil(rateLimit.retryAfterMs / 1000);
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }

  const { searchParams } = new URL(request.url);
  const validation = parseSymbolsParam(searchParams.get("symbols"));

  if (!validation.ok) {
    return NextResponse.json(
      {
        error:
          validation.error === "missing"
            ? "Missing symbols parameter"
            : "Too many symbols",
      },
      { status: 400 }
    );
  }

  const { symbols } = validation;

  // Per-client budget for every caller that may be charged as one client — a
  // forwarded address, or a caller that sent a junk X-Forwarded-For and is
  // therefore metered against UNTRUSTED_CLIENT. Skipped only for the genuinely
  // unattributable case (`source: "absent"`), where a per-client budget spread
  // over an unknown number of clients would not be one. The global budget
  // always applies. See MAX_UPSTREAM_CALLS_PER_IP.
  const buckets: UpstreamBudgetBucket[] = [];
  if (identity.identified) {
    buckets.push({
      key: `watchlist-quotes:upstream:${identity.key}`,
      limit: MAX_UPSTREAM_CALLS_PER_IP,
      // Pinned only when the key is a constant. The untrusted bucket is the one
      // a caller producing thousands of distinct keys lands in, so letting its
      // own key pressure evict it would hand the budget straight back. A real
      // `ip:` key is request-derived and must stay evictable.
      pinned: identity.source === "untrusted",
    });
  }
  buckets.push({
    key: GLOBAL_UPSTREAM_BUDGET_KEY,
    limit: MAX_UPSTREAM_CALLS_GLOBAL,
    // The only ceiling that does not depend on identifying the caller, so it
    // must not be the first casualty of eviction. See evictOldestIfFull.
    pinned: true,
  });

  try {
    const outcome = await resolveWatchlistQuotes(
      symbols,
      {
        lookup: lookupSymbol,
        reserveUpstream: (requested) => reserveUpstreamCalls(buckets, requested),
        releaseUpstream: (reservation, unused) =>
          releaseUpstreamCalls(reservation, unused),
        fetchQuote: (symbol, timeoutMs) => getQuote(symbol, { timeoutMs }),
        cacheQuote: (symbol, quote, ttlMs) =>
          setCached(quoteCacheKey(symbol), quote, ttlMs),
        cacheNegative: (symbol, reason, ttlMs) =>
          setCached(unavailableCacheKey(symbol), reason, ttlMs),
        now: Date.now,
        isMarketOpen,
      },
      {
        maxConcurrentFetches: MAX_CONCURRENT_FETCHES,
        perQuoteTimeoutMs: PER_QUOTE_TIMEOUT_MS,
        deadlineMs: UPSTREAM_DEADLINE_MS,
      }
    );

    if (outcome.failed.length > 0) {
      // One summary line rather than one per symbol — a Finnhub outage would
      // otherwise emit 20 stack traces per request.
      console.error(
        `[/api/stock/watchlist-quotes] ${outcome.failed.length} upstream lookup(s) failed: ${outcome.failed.join(", ")}`
      );
    }
    if (outcome.response.degraded) {
      // The two causes are logged apart because they call for different
      // responses: budget exhaustion means the caps are too tight for real
      // demand, deadline exhaustion means Finnhub is slow.
      console.warn(
        `[/api/stock/watchlist-quotes] degraded response — deferred ${outcome.budgetDeferred.length} symbol(s) on budget, ${outcome.deadlineDeferred.length} on deadline`
      );
    }

    // One entry per valid requested symbol, in first-occurrence input order.
    // Rows are never dropped — only their price data degrades — and `degraded`
    // is derived from the rows themselves so it cannot disagree with them.
    return NextResponse.json(outcome.response);
  } catch (err) {
    // Individual upstream failures never reach here — they are settled into
    // status "error" entries above. This is for unexpected server-side faults.
    console.error("[/api/stock/watchlist-quotes]", err);
    return NextResponse.json(
      { error: "Failed to fetch watchlist quotes" },
      { status: 500 }
    );
  }
}
