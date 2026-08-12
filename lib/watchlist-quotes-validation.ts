// ---------------------------------------------------------------------------
// Validation for the `symbols` query param of GET /api/stock/watchlist-quotes
//
// Extracted from the Route Handler as a pure function so it can be unit-tested
// directly — route handlers import via the "@/" path alias, which plain
// `deno test` cannot resolve (see tests/unit/search-route.test.ts for the same
// constraint).
//
// This is the real trust boundary for the route: the browser only ever sends
// symbols that already passed lib/watchlist.ts's regex on write, but a
// modified client or a direct curl can send anything.
// ---------------------------------------------------------------------------

import { MAX_WATCHLIST, SYMBOL_RE } from "./watchlist";

export type SymbolsValidationResult =
  | { ok: true; symbols: string[] }
  | { ok: false; error: "missing" | "too_many" };

/**
 * Parses and validates the comma-separated `symbols` query param.
 *
 * Rules:
 * - `null` or an empty string → `{ ok: false, error: "missing" }` (the route
 *   turns this into 400 "Missing symbols parameter").
 * - Each segment is trimmed, then tested against SYMBOL_RE. Segments that fail
 *   are **silently dropped** rather than surfaced as per-symbol errors —
 *   serving the valid subset is more robust than rejecting a whole batch that
 *   only a hand-crafted request could have malformed.
 * - Duplicates are removed, preserving first-occurrence order.
 * - More than MAX_WATCHLIST valid symbols after dedup →
 *   `{ ok: false, error: "too_many" }`. A hard error rather than silent
 *   truncation: a spec-compliant client can never legitimately exceed the cap,
 *   so this signals a client bug instead of quietly returning fewer entries.
 * - Zero valid symbols after filtering → `{ ok: true, symbols: [] }`. That is a
 *   legitimate "nothing to show" result, not an error.
 */
export function parseSymbolsParam(raw: string | null): SymbolsValidationResult {
  if (raw === null || raw.trim() === "") {
    return { ok: false, error: "missing" };
  }

  const valid = raw
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => SYMBOL_RE.test(segment));

  // Set iteration order is insertion order, so first-occurrence order survives.
  const deduped = Array.from(new Set(valid));

  if (deduped.length > MAX_WATCHLIST) {
    return { ok: false, error: "too_many" };
  }

  return { ok: true, symbols: deduped };
}
