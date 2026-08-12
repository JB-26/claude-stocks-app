// ---------------------------------------------------------------------------
// Pure decision logic for WatchlistPanel — extracted so it can be unit
// tested directly instead of being re-implemented (and silently drifting
// from) test-only replicas.
//
// WatchlistPanel.tsx is a "use client" React component and can't be
// imported into a Deno test (no DOM, no React renderer available there —
// see tests/unit/retryable-fetch-logic.test.ts's header comment for the
// same constraint on useRetryableFetch). Everything here is plain,
// framework-free TypeScript that both the component and
// tests/unit/watchlist.test.ts import from this single source, so a change
// to the component's actual merge/gating behaviour breaks the tests instead
// of leaving them green against a stale copy.
// ---------------------------------------------------------------------------

import type { WatchlistQuoteEntry } from "./finnhub/types";

/**
 * A per-symbol quote plus client-side provenance of that quote.
 *
 * `stale` is true when the LATEST poll for this symbol came back
 * "deferred" or "failed" and we deliberately kept the previous "ok" entry
 * instead of clobbering it — see `mergeQuoteEntry`. `entry` in that case is
 * still the last known-good data, just no longer guaranteed fresh as of
 * this poll.
 */
export interface QuoteState {
  entry: WatchlistQuoteEntry;
  stale: boolean;
}

/**
 * True when this entry carries a real, displayable price.
 *
 * By server contract (see `buildWatchlistQuotes` in
 * lib/watchlist-quotes-logic.ts) a `status: "ok"` row always has a non-null
 * `price` — only `change`/`changePercent` can be null on an otherwise-ok
 * row (a symbol with no previous close, e.g. an IPO's first session).
 * Checking `price !== null` directly, rather than trusting `status` alone,
 * is a defensive belt-and-suspenders against that contract ever changing
 * server-side without this file being updated in lockstep.
 *
 * This is the fix for the defect where a real price was hidden behind an
 * em-dash whenever `change`/`changePercent` were null: a missing delta must
 * suppress only the delta, never the price itself.
 */
export function hasPrice(
  entry: WatchlistQuoteEntry
): entry is WatchlistQuoteEntry & { price: number } {
  return entry.status === "ok" && entry.price !== null;
}

/**
 * Per-symbol merge decision for a freshly-fetched quote entry against
 * whatever this symbol's row currently holds.
 *
 * "deferred"/"failed" describe the SERVER or THIS CALL, not the symbol —
 * the price already held is still the best data available and must not be
 * thrown away for an em-dash. "unavailable" is different: it's a fact about
 * the symbol itself (Finnhub answered and there is no usable price), so
 * replacing a stale price with the em-dash there is correct, not a
 * regression.
 *
 * A row that itself carries a real price (an "ok" row, with or without a
 * delta) is never treated as something to retain-through — it always
 * applies and clears any prior `stale` flag, since it's fresher data than
 * whatever came before.
 */
export function mergeQuoteEntry(
  existing: QuoteState | undefined,
  incoming: WatchlistQuoteEntry
): QuoteState {
  const isTransientError =
    incoming.status === "error" &&
    (incoming.reason === "deferred" || incoming.reason === "failed");

  if (isTransientError && existing !== undefined && hasPrice(existing.entry)) {
    // Keep the good price, just flag it as no longer guaranteed-fresh so
    // the UI can show a subtle affordance.
    return { entry: existing.entry, stale: true };
  }

  return { entry: incoming, stale: false };
}

/**
 * Prunes a quotes map down to only the symbols currently on the watchlist.
 *
 * Used both when merging a fresh response (a symbol removed while the
 * request was in flight must not have its pre-removal price re-applied)
 * and when the symbol list itself changes (a removed symbol's row must
 * disappear immediately, not wait for the next poll).
 */
export function pruneToCurrentSymbols(
  quotes: ReadonlyMap<string, QuoteState>,
  currentSymbols: ReadonlySet<string> | readonly string[]
): Map<string, QuoteState> {
  const set =
    currentSymbols instanceof Set ? currentSymbols : new Set(currentSymbols);
  const next = new Map<string, QuoteState>();
  for (const [symbol, state] of quotes) {
    if (set.has(symbol)) next.set(symbol, state);
  }
  return next;
}

/**
 * Merges a full watchlist-quotes response into the current quotes map:
 * prunes symbols no longer on the watchlist, then applies each incoming
 * entry via `mergeQuoteEntry`. Entries for symbols no longer on the
 * watchlist are ignored (same reasoning as `pruneToCurrentSymbols`).
 */
export function mergeQuotesResponse(
  prev: ReadonlyMap<string, QuoteState>,
  incomingEntries: readonly WatchlistQuoteEntry[],
  currentSymbols: readonly string[]
): Map<string, QuoteState> {
  const currentSet = new Set(currentSymbols);
  const next = pruneToCurrentSymbols(prev, currentSet);
  for (const entry of incomingEntries) {
    if (!currentSet.has(entry.symbol)) continue;
    next.set(entry.symbol, mergeQuoteEntry(next.get(entry.symbol), entry));
  }
  return next;
}

/**
 * Whether any row currently holds a real, displayable price.
 *
 * This is deliberately NOT `quotes.size === 0`. A fully budget-denied cold
 * start populates one entry per requested symbol — all `status: "error"` —
 * so `size` is nonzero even though the user has never seen a single number.
 * "Is the panel cold" must mean "do we hold any real, displayable price
 * data", not "does the Map have keys".
 */
export function hasAnyDisplayablePrice(
  quotes: ReadonlyMap<string, QuoteState>
): boolean {
  for (const state of quotes.values()) {
    if (hasPrice(state.entry)) return true;
  }
  return false;
}

/**
 * Whether a symbol's row is showing a real, retryable gap — an error caused
 * by server/call-level trouble ("deferred"/"failed" or an absent reason),
 * as opposed to a legitimate, permanent fact about the symbol itself
 * ("unavailable"). Rows still loading (`undefined`) don't count as a gap.
 */
export function hasVisibleGap(
  symbols: readonly string[],
  quotes: ReadonlyMap<string, QuoteState>
): boolean {
  return symbols.some((symbol) => {
    const state = quotes.get(symbol);
    return (
      state !== undefined &&
      state.entry.status === "error" &&
      state.entry.reason !== "unavailable"
    );
  });
}

/**
 * Whether the degraded banner ("Some prices are temporarily unavailable —
 * showing what we have and retrying automatically") should be shown.
 *
 * Gated on `hasVisibleGap` alone — NOT on the server's `degraded` flag.
 * `degraded` (see `isDegraded` in lib/watchlist-quotes-logic.ts) is derived
 * purely from whether the server *deferred* a symbol under upstream-budget
 * or time pressure; it says nothing about a symbol whose request was
 * actually dispatched and simply failed (`reason: "failed"`). A total
 * upstream outage — Finnhub down, or the shared rate-limit budget already
 * spent by other routes — dispatches every symbol, every one throws, and
 * the server returns HTTP 200 with every row `status: "error", reason:
 * "failed"` and `degraded: false`. Gating on `degraded` therefore hid the
 * banner in exactly the failure mode that most needed it: the user saw N
 * rows of "—" with no banner and no Retry, while `hasVisibleGap` (below)
 * already classifies that same "failed" row as a real, retryable gap. A
 * gap the user can actually see on screen must never depend on the server
 * having volunteered a flag about it — so `hasVisibleGap` alone decides.
 *
 * The server's `degraded` flag is deliberately NOT a parameter here. Every
 * deferred row is also an error row whose reason isn't "unavailable", so
 * `hasVisibleGap` is a strict superset of what `degraded` reports — taking
 * it as an argument would mean carrying a value this function must not
 * consult, which is how the outage-hiding bug above got written in the
 * first place. The field remains in `WatchlistQuotesResponse` and remains
 * correct and meaningful on the wire; it simply has no client-side reader
 * today. Re-plumbing it is one line if a future caller needs to tell a
 * capacity shortage apart from a total outage.
 *
 * The terminal-error banner always takes precedence: it's a stronger,
 * more specific statement ("we couldn't load anything") than the degraded
 * banner's softer "some rows are incomplete", and showing both would be
 * confusing plus redundant.
 */
export function computeShowDegradedBanner(
  symbols: readonly string[],
  quotes: ReadonlyMap<string, QuoteState>,
  showTerminalError: boolean
): boolean {
  return !showTerminalError && hasVisibleGap(symbols, quotes);
}
