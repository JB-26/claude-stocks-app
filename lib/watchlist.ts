// ---------------------------------------------------------------------------
// Watchlist — localStorage-backed persistent symbol list
//
// All functions guard against SSR (typeof window === 'undefined') and
// malformed storage data. The module is intentionally free of React
// dependencies so it can be imported in both components and unit tests.
//
// Schema: localStorage key "watchlist" → JSON.stringify(string[])
// Example: '["AAPL","TSLA","MSFT"]'
// ---------------------------------------------------------------------------

export const WATCHLIST_KEY = "watchlist";
export const MAX_WATCHLIST = 20;

/**
 * A symbol regex matching the server-side quote route validation.
 *
 * Exported so server-side validation (lib/watchlist-quotes-validation.ts) can
 * share this single definition rather than adding another duplicate.
 */
export const SYMBOL_RE = /^[A-Z]{1,10}$/;

/** The persisted type: an ordered array of uppercase ticker symbols. */
export type Watchlist = string[];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when localStorage is available in the current environment.
 * During SSR, `window` is undefined and this returns false.
 */
function isClient(): boolean {
  return typeof window !== "undefined";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the current watchlist from localStorage.
 * Returns an empty array on SSR, on parse error, or when no list is stored.
 */
export function getWatchlist(): Watchlist {
  if (!isClient()) return [];
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter to ensure only valid string symbols are returned — guards against
    // corrupted or externally modified localStorage values.
    const valid = parsed.filter(
      (item): item is string => typeof item === "string" && SYMBOL_RE.test(item)
    );
    // De-duplicate, preserving first-occurrence order — another form of the
    // same "corrupted or externally modified localStorage" defense above.
    // '["AAPL","AAPL"]' is valid JSON and passes the filter above unchanged;
    // without this, callers that key React lists by symbol (WatchlistPanel)
    // would render duplicate keys, and removing one occurrence would strip
    // both since removeFromWatchlist filters by symbol equality.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const symbol of valid) {
      if (!seen.has(symbol)) {
        seen.add(symbol);
        deduped.push(symbol);
      }
    }
    // Cap at MAX_WATCHLIST — the last line of defense against corrupted or
    // externally modified localStorage, matching the shape/regex filter and
    // de-dup above. addToWatchlist() enforces the cap on write, but this
    // read path is the one explicitly hardened against storage that didn't
    // go through addToWatchlist at all (hand-edited devtools, a future bug
    // elsewhere, a shared/synced profile). Without this, a caller could hand
    // more than MAX_WATCHLIST symbols to the server's watchlist-quotes
    // route, whose validator (lib/watchlist-quotes-validation.ts) treats
    // exceeding the cap as a hard 400 error rather than truncating — its
    // docstring justifies that hard error with "a spec-compliant client can
    // never legitimately exceed the cap", which this read path must
    // actually guarantee for that reasoning to hold. Keeping the first
    // MAX_WATCHLIST entries (rather than the last) matches addToWatchlist's
    // "most-recently-added" ordering, where index 0 is most recent.
    return deduped.slice(0, MAX_WATCHLIST);
  } catch {
    return [];
  }
}

/**
 * Writes a watchlist directly to localStorage.
 * Silently no-ops on SSR or if localStorage is unavailable.
 */
export function saveWatchlist(symbols: Watchlist): void {
  if (!isClient()) return;
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(symbols));
  } catch {
    // localStorage may be full or disabled — silently ignore.
  }
}

/**
 * Adds a symbol to the watchlist. If the symbol is already present it is
 * moved to the front (most-recently-added ordering). If the watchlist is
 * already at MAX_WATCHLIST capacity the call is a no-op.
 *
 * Returns the updated watchlist.
 */
export function addToWatchlist(symbol: string): Watchlist {
  if (!isClient()) return [];
  if (!SYMBOL_RE.test(symbol)) return getWatchlist();

  const current = getWatchlist();

  // Deduplicate: remove any existing entry for this symbol before prepending.
  const deduped = [symbol, ...current.filter((s) => s !== symbol)];

  // Enforce the cap on the deduped list (prepend counts as the "active" slot).
  if (deduped.length > MAX_WATCHLIST) {
    // The list was already at MAX_WATCHLIST and the symbol was not present —
    // do not allow it to grow beyond the cap.
    if (!current.includes(symbol)) {
      return current;
    }
    // If the symbol was already in the list, deduplication reduced the count
    // back to MAX_WATCHLIST — this is fine to save.
  }

  const next = deduped.slice(0, MAX_WATCHLIST);
  saveWatchlist(next);
  return next;
}

/**
 * Removes a symbol from the watchlist. If the symbol is not present the call
 * is a no-op.
 *
 * Returns the updated watchlist.
 */
export function removeFromWatchlist(symbol: string): Watchlist {
  const current = getWatchlist();
  const next = current.filter((s) => s !== symbol);
  if (next.length !== current.length) {
    saveWatchlist(next);
  }
  return next;
}

/**
 * Returns true if the given symbol is currently in the watchlist.
 * Returns false on SSR.
 */
export function isInWatchlist(symbol: string): boolean {
  return getWatchlist().includes(symbol);
}
