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

/** A symbol regex matching the server-side quote route validation. */
const SYMBOL_RE = /^[A-Z]{1,10}$/;

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
    return parsed.filter(
      (item): item is string => typeof item === "string" && SYMBOL_RE.test(item)
    );
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
