import {
  assertEquals,
  assertArrayIncludes,
  assert,
} from "@std/assert";

// ---------------------------------------------------------------------------
// watchlist.test.ts
//
// Unit tests for lib/watchlist.ts
//
// The module is pure TypeScript with no React or Next.js dependencies, but it
// reads and writes localStorage. Deno DOES provide a real, disk-persisted
// Web Storage implementation (unlike a browserless Node/jsdom-less
// environment), which is exactly the problem: we don't want tests reading or
// writing that real, cross-process storage. So we polyfill localStorage with
// a simple in-memory implementation before each test and restore the
// original property afterwards. This gives us an SSR-free, hermetic client
// environment.
// ---------------------------------------------------------------------------

import {
  WATCHLIST_KEY,
  MAX_WATCHLIST,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  isInWatchlist,
  saveWatchlist,
} from "../../lib/watchlist.ts";
import {
  hasPrice,
  hasAnyDisplayablePrice,
  mergeQuoteEntry,
  computeShowDegradedBanner,
  type QuoteState,
} from "../../lib/watchlist-panel-logic.ts";
import type { WatchlistQuoteEntry } from "../../lib/finnhub/types.ts";

// ---------------------------------------------------------------------------
// localStorage polyfill
// ---------------------------------------------------------------------------

interface FakeStorage {
  store: Record<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function makeFakeStorage(): FakeStorage {
  const store: Record<string, string> = {};
  return {
    store,
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key)
        ? store[key]
        : null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    removeItem(key: string) {
      delete store[key];
    },
    clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

/**
 * Installs a fresh in-memory localStorage on `globalThis` and returns a
 * cleanup function that restores the original property so SSR-guard tests
 * can verify the `typeof window === 'undefined'` path.
 *
 * Deno's `globalThis.localStorage` starts life as a GETTER-ONLY accessor
 * property (it lazily replaces itself with a real, disk-backed Storage
 * instance on first read/write). A plain assignment —
 * `(globalThis as any).localStorage = fake` — targets that accessor's
 * setter, which doesn't exist, so the assignment is silently discarded:
 * `globalThis.localStorage` is completely unchanged afterwards. That bites
 * exactly the FIRST test in the process to call this function, which would
 * silently run against Deno's real, cross-process, disk-persisted
 * localStorage instead of the fake — every subsequent test only "works" by
 * accident, because the previous test's cleanup happened to `delete` the
 * accessor entirely, leaving nothing but a plain writable slot behind.
 *
 * `Object.defineProperty` sidesteps this: it replaces the property's
 * descriptor outright rather than invoking a setter, so it installs the
 * fake correctly regardless of whether the existing property is an
 * accessor or a plain data property, and regardless of whether this is the
 * first call in the process or the hundredth.
 */
function installFakeLocalStorage(): () => void {
  const fake = makeFakeStorage();
  const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage"
  );
  // deno-lint-ignore no-explicit-any
  (globalThis as any).window = globalThis;
  Object.defineProperty(globalThis, "localStorage", {
    value: fake,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return () => {
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).window;
    // Restore exactly what was there before (accessor or data property),
    // rather than always `delete`-ing — a faithful restore regardless of
    // what shape the property happened to be in when we found it.
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(
        globalThis,
        "localStorage",
        originalLocalStorageDescriptor
      );
    } else {
      // deno-lint-ignore no-explicit-any
      delete (globalThis as any).localStorage;
    }
  };
}

// ---------------------------------------------------------------------------
// WL-01: getWatchlist returns [] when localStorage is empty
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-01: getWatchlist returns empty array when localStorage has no entry", () => {
  const cleanup = installFakeLocalStorage();
  try {
    const result = getWatchlist();
    assertEquals(result, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-02: saveWatchlist + getWatchlist round-trip persists and retrieves symbols
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-02: saveWatchlist then getWatchlist returns the persisted symbols", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL", "TSLA", "MSFT"]);
    const result = getWatchlist();
    assertEquals(result, ["AAPL", "TSLA", "MSFT"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-03: addToWatchlist adds a new symbol and returns it at index 0
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-03: addToWatchlist prepends a new symbol to the list", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["TSLA"]);
    const result = addToWatchlist("AAPL");
    assertEquals(result[0], "AAPL");
    assertEquals(result[1], "TSLA");
    assertEquals(result.length, 2);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-04: addToWatchlist deduplicates — re-adding moves symbol to front
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-04: addToWatchlist moves an existing symbol to the front without duplicating it", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL", "TSLA", "MSFT"]);
    const result = addToWatchlist("TSLA");
    // TSLA should be at index 0, original order otherwise preserved
    assertEquals(result[0], "TSLA");
    assertEquals(result.length, 3); // no duplicate
    assertArrayIncludes(result, ["AAPL", "MSFT"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-05: addToWatchlist rejects invalid symbols (lowercase, special chars)
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-05: addToWatchlist rejects a lowercase symbol and returns unchanged list", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL"]);
    const result = addToWatchlist("aapl"); // invalid — lowercase
    assertEquals(result, ["AAPL"]); // unchanged
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-05b: addToWatchlist rejects a symbol with special characters", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL"]);
    const result = addToWatchlist("AA PL"); // space is invalid
    assertEquals(result, ["AAPL"]);
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-05c: addToWatchlist rejects an empty string", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL"]);
    const result = addToWatchlist(""); // empty
    assertEquals(result, ["AAPL"]);
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-05d: addToWatchlist rejects a symbol longer than 10 characters", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL"]);
    const result = addToWatchlist("ABCDEFGHIJK"); // 11 chars — over limit
    assertEquals(result, ["AAPL"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-06: 20-symbol cap — 21st new symbol is rejected
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-06: addToWatchlist is a no-op when the list is already at MAX_WATCHLIST with a new symbol", () => {
  const cleanup = installFakeLocalStorage();
  try {
    // Fill exactly MAX_WATCHLIST (20) unique symbols
    const full: string[] = [];
    for (let i = 0; i < MAX_WATCHLIST; i++) {
      // Generate valid uppercase symbols: AA, AB, … using letter combinations
      const symbol = "S" + String(i).padStart(2, "0");
      // S00..S19 are all <= 3 chars and all uppercase letters + digits — wait,
      // the regex is /^[A-Z]{1,10}$/ which only allows letters.
      // Use multi-letter symbols instead.
      const letters = "ABCDEFGHIJKLMNOPQRST";
      full.push("X" + letters[i]);
    }
    saveWatchlist(full);
    assertEquals(getWatchlist().length, MAX_WATCHLIST);

    // Attempt to add a 21st symbol that isn't already in the list
    const before = getWatchlist();
    const result = addToWatchlist("ZZZ");
    // The list should not grow beyond 20
    assertEquals(result.length, MAX_WATCHLIST);
    assertEquals(result, before);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-07: 20-symbol cap — re-adding an existing symbol at cap is allowed (dedup keeps count at 20)
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-07: re-adding a symbol that is already in a full watchlist is allowed and moves it to front", () => {
  const cleanup = installFakeLocalStorage();
  try {
    const letters = "ABCDEFGHIJKLMNOPQRST";
    const full: string[] = [];
    for (let i = 0; i < MAX_WATCHLIST; i++) {
      full.push("X" + letters[i]);
    }
    saveWatchlist(full);

    // Re-add the last symbol (it's already in the list)
    const lastSymbol = full[MAX_WATCHLIST - 1];
    const result = addToWatchlist(lastSymbol);
    assertEquals(result.length, MAX_WATCHLIST); // still 20
    assertEquals(result[0], lastSymbol); // moved to front
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-08: removeFromWatchlist removes an existing symbol
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-08: removeFromWatchlist removes a symbol that is present", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL", "TSLA", "MSFT"]);
    const result = removeFromWatchlist("TSLA");
    assertEquals(result, ["AAPL", "MSFT"]);
    // Verify persistence
    assertEquals(getWatchlist(), ["AAPL", "MSFT"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-09: removeFromWatchlist is a no-op for a symbol not in the list
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-09: removeFromWatchlist is a no-op when the symbol is not present", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL", "TSLA"]);
    const result = removeFromWatchlist("NVDA");
    assertEquals(result, ["AAPL", "TSLA"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-10: isInWatchlist returns true for a present symbol and false otherwise
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-10: isInWatchlist returns true for a symbol that is in the list", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL", "TSLA"]);
    assert(isInWatchlist("AAPL"));
    assert(isInWatchlist("TSLA"));
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-10b: isInWatchlist returns false for a symbol that is not in the list", () => {
  const cleanup = installFakeLocalStorage();
  try {
    saveWatchlist(["AAPL"]);
    assertEquals(isInWatchlist("NVDA"), false);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-11: SSR guard — all functions return safe defaults when window is undefined
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-11: getWatchlist returns [] on SSR (window undefined)", () => {
  // Do NOT install fake localStorage — window is undefined in Deno by default
  const result = getWatchlist();
  assertEquals(result, []);
});

Deno.test(
  "watchlist WL-11b: addToWatchlist returns [] on SSR (window undefined)",
  () => {
    // Fixed: addToWatchlist now has `if (!isClient()) return [];` as its first
    // line, matching the SSR behaviour of getWatchlist, removeFromWatchlist,
    // and isInWatchlist.
    const result = addToWatchlist("AAPL");
    assertEquals(result, []);
  }
);

Deno.test("watchlist WL-11c: removeFromWatchlist returns [] on SSR (window undefined)", () => {
  const result = removeFromWatchlist("AAPL");
  assertEquals(result, []);
});

Deno.test("watchlist WL-11d: isInWatchlist returns false on SSR (window undefined)", () => {
  const result = isInWatchlist("AAPL");
  assertEquals(result, false);
});

Deno.test("watchlist WL-11e: saveWatchlist is a no-op on SSR (no throw)", () => {
  // Must not throw even though localStorage is unavailable
  saveWatchlist(["AAPL", "TSLA"]);
  // If we reach here, no exception was thrown — pass
});

// ---------------------------------------------------------------------------
// WL-12: getWatchlist filters corrupted localStorage entries
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-12: getWatchlist filters out non-string entries from corrupted localStorage", () => {
  const cleanup = installFakeLocalStorage();
  try {
    // Manually write corrupt data: mix valid symbols with invalid items
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify(["AAPL", 123, null, "tsla", "VALID", { x: 1 }, "MSFT"])
    );
    const result = getWatchlist();
    // Only uppercase-only strings matching /^[A-Z]{1,10}$/ should survive
    assertEquals(result, ["AAPL", "VALID", "MSFT"]);
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-12b: getWatchlist returns [] when localStorage contains malformed JSON", () => {
  const cleanup = installFakeLocalStorage();
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(WATCHLIST_KEY, "not-valid-json{{{");
    const result = getWatchlist();
    assertEquals(result, []);
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-12c: getWatchlist returns [] when localStorage contains a non-array JSON value", () => {
  const cleanup = installFakeLocalStorage();
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify({ symbol: "AAPL" })
    );
    const result = getWatchlist();
    assertEquals(result, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-13: addToWatchlist with valid 1-character and 10-character symbols
// (boundary values on the regex)
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-13: addToWatchlist accepts a 1-character symbol (minimum length)", () => {
  const cleanup = installFakeLocalStorage();
  try {
    const result = addToWatchlist("V"); // Single-letter ticker (Visa)
    assertEquals(result[0], "V");
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-13b: addToWatchlist accepts a 10-character symbol (maximum length)", () => {
  const cleanup = installFakeLocalStorage();
  try {
    const result = addToWatchlist("ABCDEFGHIJ"); // 10 chars — at the boundary
    assertEquals(result[0], "ABCDEFGHIJ");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-14: removeFromWatchlist on an empty list does not throw
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-14: removeFromWatchlist on an empty list returns [] without throwing", () => {
  const cleanup = installFakeLocalStorage();
  try {
    const result = removeFromWatchlist("AAPL");
    assertEquals(result, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-15: getWatchlist de-duplicates corrupted/externally-modified localStorage
//
// '["AAPL","AAPL"]' is valid JSON and passes the shape+regex filter unchanged
// — nothing before this stopped a literal duplicate from reaching the
// caller. Downstream, WatchlistPanel keys a React list by symbol, so an
// un-deduped read would render two <li key="AAPL"> siblings and a single
// remove click would filter out (strip) both of them at once, silently
// removing a symbol the user never asked to remove.
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-15: getWatchlist de-duplicates exact-duplicate entries, preserving first-occurrence order", () => {
  const cleanup = installFakeLocalStorage();
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify(["AAPL", "AAPL"])
    );
    assertEquals(getWatchlist(), ["AAPL"]);
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-15b: de-duplication preserves first-occurrence order with non-adjacent duplicates and other symbols interspersed", () => {
  const cleanup = installFakeLocalStorage();
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify(["AAPL", "TSLA", "AAPL", "MSFT", "TSLA", "NVDA"])
    );
    assertEquals(getWatchlist(), ["AAPL", "TSLA", "MSFT", "NVDA"]);
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-15c: removing a symbol that was duplicated on read removes it completely, not just one occurrence", () => {
  const cleanup = installFakeLocalStorage();
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify(["AAPL", "TSLA", "AAPL"])
    );
    // getWatchlist() has already deduped this down to ["AAPL", "TSLA"] by
    // the time removeFromWatchlist reads it internally.
    const result = removeFromWatchlist("AAPL");
    assertEquals(result, ["TSLA"]);
    assertEquals(getWatchlist(), ["TSLA"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-16: de-duplication composes with the existing shape/regex filtering —
// corrupted (non-string / invalid-symbol) entries are dropped AND surviving
// valid entries are deduped, in the same read.
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-16: getWatchlist both filters invalid entries and de-duplicates valid ones in a single read", () => {
  const cleanup = installFakeLocalStorage();
  try {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify(["AAPL", 123, "AAPL", null, "tsla", "MSFT", "MSFT"])
    );
    assertEquals(getWatchlist(), ["AAPL", "MSFT"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WL-17: getWatchlist enforces MAX_WATCHLIST on the read path — an
// adversarial review found that only addToWatchlist capped length;
// getWatchlist (explicitly hardened elsewhere in this file against
// "corrupted or externally modified localStorage") let an over-cap list
// straight through. That over-cap list then fails the server's validator
// (lib/watchlist-quotes-validation.ts's `too_many`, hard 400) on every
// single poll, permanently dead-ending the panel with no way for the user
// to recover short of clearing localStorage by hand.
// ---------------------------------------------------------------------------

Deno.test("watchlist WL-17: getWatchlist caps a corrupted list of more than MAX_WATCHLIST valid symbols", () => {
  const cleanup = installFakeLocalStorage();
  try {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXY"; // 25 distinct letters
    const oversized = Array.from({ length: 25 }, (_, i) => "X" + letters[i]);
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(
      WATCHLIST_KEY,
      JSON.stringify(oversized)
    );
    const result = getWatchlist();
    assertEquals(result.length, MAX_WATCHLIST);
    // First-occurrence order is preserved — the cap keeps the front of the
    // list (matching addToWatchlist's "index 0 is most recently added"
    // convention), not an arbitrary or reordered subset.
    assertEquals(result, oversized.slice(0, MAX_WATCHLIST));
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-17b: the read-path cap composes with de-duplication (dedup can still leave more than MAX_WATCHLIST)", () => {
  const cleanup = installFakeLocalStorage();
  try {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXY";
    const distinct = Array.from({ length: 25 }, (_, i) => "X" + letters[i]);
    // Interleave each symbol with a duplicate of itself so raw length is 50
    // but distinct count is still 25 — proves cap applies to the
    // *post-dedup* count, not the raw array length.
    const raw = distinct.flatMap((s) => [s, s]);
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(WATCHLIST_KEY, JSON.stringify(raw));
    const result = getWatchlist();
    assertEquals(result.length, MAX_WATCHLIST);
    assertEquals(result, distinct.slice(0, MAX_WATCHLIST));
  } finally {
    cleanup();
  }
});

Deno.test("watchlist WL-17c: a list of exactly MAX_WATCHLIST valid symbols is not over-trimmed", () => {
  const cleanup = installFakeLocalStorage();
  try {
    const letters = "ABCDEFGHIJKLMNOPQRST"; // 20 distinct letters
    const exact = Array.from({ length: MAX_WATCHLIST }, (_, i) => "X" + letters[i]);
    // deno-lint-ignore no-explicit-any
    (globalThis as any).localStorage.setItem(WATCHLIST_KEY, JSON.stringify(exact));
    assertEquals(getWatchlist(), exact);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WLQ: WatchlistPanel's per-symbol quote merge + degraded-banner decisions.
//
// WatchlistPanel.tsx is a "use client" React component and can't be
// imported into a Deno test (no DOM, no React renderer available here —
// see tests/unit/retryable-fetch-logic.test.ts's header comment for the
// same constraint on useRetryableFetch). Unlike an earlier version of this
// file, the decision logic below is NOT re-implemented here — it's imported
// from lib/watchlist-panel-logic.ts, the exact same module
// WatchlistPanel.tsx imports. An adversarial review correctly flagged the
// old approach (local copies of mergeQuoteEntry/computeShowDegradedBanner)
// as testing a replica that could silently drift from what the component
// actually does; importing the real functions means a regression in either
// file's logic can only happen by editing lib/watchlist-panel-logic.ts
// itself, which these tests exercise directly.
//
// What's under test:
//   1. A "deferred"/"failed" error row must NOT overwrite an existing good
//      price (the price already held is still the best data available);
//      an "unavailable" row must still overwrite, since that's a genuine
//      fact about the symbol. See mergeQuoteEntry / WLQ-01..WLQ-06.
//   2. A fully budget-denied OR fully failed response is HTTP 200 with
//      every row errored, which looks identical to success unless the
//      client separately checks whether any row is showing a real gap (as
//      opposed to a legitimately dataless "unavailable" row).
//      `computeShowDegradedBanner` is gated on that gap alone, NOT on the
//      server's `degraded` flag — `degraded` only means "deferred under
//      budget pressure" and is false when every symbol was dispatched and
//      simply failed (e.g. a total Finnhub outage), which is exactly the
//      case that most needs the banner. See computeShowDegradedBanner /
//      WLQ-07..WLQ-11.
//   3. A `status: "ok"` row with a real price but a null change/changePercent
//      (e.g. an IPO's first session, no previous close) must still be
//      treated as carrying a displayable price — not demoted to an error
//      just because its delta is missing. See hasPrice / WLQ-12..WLQ-15.
//   4. "Is the panel cold" must be measured by whether any row holds a real
//      price, not by whether the quotes Map merely has keys — a fully
//      budget-denied cold start populates one error entry per symbol. See
//      hasAnyDisplayablePrice / WLQ-16..WLQ-19.
// ---------------------------------------------------------------------------

const OK_AAPL: WatchlistQuoteEntry = {
  symbol: "AAPL",
  status: "ok",
  price: 261.74,
  change: 3.45,
  changePercent: 1.34,
};

/** An "ok" row with a real price but no delta — the shape the server emits
 * for a symbol with no previous close (e.g. an IPO's first session). See
 * lib/watchlist-quotes-logic.ts's `buildWatchlistQuotes` and its
 * `toFiniteOrNull` helper, and the regression test `WQL-05f` in
 * tests/unit/watchlist-quotes-logic.test.ts. */
const OK_AAPL_NO_DELTA: WatchlistQuoteEntry = {
  symbol: "AAPL",
  status: "ok",
  price: 150,
  change: null,
  changePercent: null,
};

Deno.test("watchlist WLQ-01: a 'deferred' error row does not clobber an existing good price", () => {
  const existing: QuoteState = { entry: OK_AAPL, stale: false };
  const incoming: WatchlistQuoteEntry = {
    symbol: "AAPL",
    status: "error",
    price: null,
    change: null,
    changePercent: null,
    reason: "deferred",
  };
  const result = mergeQuoteEntry(existing, incoming);
  assertEquals(result.entry, OK_AAPL);
  assertEquals(result.entry.price, 261.74);
  assert(result.stale, "retained price must be flagged stale");
});

Deno.test("watchlist WLQ-02: a 'failed' error row does not clobber an existing good price", () => {
  const existing: QuoteState = { entry: OK_AAPL, stale: false };
  const incoming: WatchlistQuoteEntry = {
    symbol: "AAPL",
    status: "error",
    price: null,
    change: null,
    changePercent: null,
    reason: "failed",
  };
  const result = mergeQuoteEntry(existing, incoming);
  assertEquals(result.entry.price, 261.74);
  assert(result.stale);
});

Deno.test("watchlist WLQ-03: an 'unavailable' error row DOES overwrite an existing good price", () => {
  const existing: QuoteState = { entry: OK_AAPL, stale: false };
  const incoming: WatchlistQuoteEntry = {
    symbol: "AAPL",
    status: "error",
    price: null,
    change: null,
    changePercent: null,
    reason: "unavailable",
  };
  const result = mergeQuoteEntry(existing, incoming);
  assertEquals(result.entry.price, null);
  assertEquals(result.entry.reason, "unavailable");
  assertEquals(result.stale, false);
});

Deno.test("watchlist WLQ-04: a fresh 'ok' row always applies and clears any prior stale flag", () => {
  const existing: QuoteState = { entry: OK_AAPL, stale: true };
  const incoming: WatchlistQuoteEntry = {
    symbol: "AAPL",
    status: "ok",
    price: 265.0,
    change: 6.71,
    changePercent: 2.6,
  };
  const result = mergeQuoteEntry(existing, incoming);
  assertEquals(result.entry.price, 265.0);
  assertEquals(result.stale, false);
});

Deno.test("watchlist WLQ-05: a 'deferred' row with no prior entry renders as a plain error (nothing to retain)", () => {
  const incoming: WatchlistQuoteEntry = {
    symbol: "TSLA",
    status: "error",
    price: null,
    change: null,
    changePercent: null,
    reason: "deferred",
  };
  const result = mergeQuoteEntry(undefined, incoming);
  assertEquals(result.entry, incoming);
  assertEquals(result.stale, false);
});

Deno.test("watchlist WLQ-06: a 'deferred' row does not retain a prior row that was itself an error (nothing good to keep)", () => {
  const existing: QuoteState = {
    entry: {
      symbol: "AAPL",
      status: "error",
      price: null,
      change: null,
      changePercent: null,
      reason: "unavailable",
    },
    stale: false,
  };
  const incoming: WatchlistQuoteEntry = {
    symbol: "AAPL",
    status: "error",
    price: null,
    change: null,
    changePercent: null,
    reason: "deferred",
  };
  const result = mergeQuoteEntry(existing, incoming);
  // existing.entry.status is "error", not "ok" — the transient-error branch
  // doesn't apply, so the new (deferred) entry is what's shown.
  assertEquals(result.entry.reason, "deferred");
  assertEquals(result.stale, false);
});

Deno.test("watchlist WLQ-07: a fully budget-denied response (all rows deferred) shows the degraded banner", () => {
  const symbols = ["AAPL", "TSLA"];
  const quotes = new Map<string, QuoteState>([
    [
      "AAPL",
      {
        entry: {
          symbol: "AAPL",
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "deferred",
        },
        stale: false,
      },
    ],
    [
      "TSLA",
      {
        entry: {
          symbol: "TSLA",
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "deferred",
        },
        stale: false,
      },
    ],
  ]);
  assert(computeShowDegradedBanner(symbols, quotes, false));
});

Deno.test("watchlist WLQ-08: an 'unavailable' row alone does not count as a visible gap (no banner)", () => {
  const symbols = ["AAPL"];
  const quotes = new Map<string, QuoteState>([
    [
      "AAPL",
      {
        entry: {
          symbol: "AAPL",
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "unavailable",
        },
        stale: false,
      },
    ],
  ]);
  // degraded may still be true from an unrelated deferred row elsewhere in
  // the same response, but this symbol's own dataless-ness isn't a gap.
  assertEquals(computeShowDegradedBanner(symbols, quotes, false), false);
});

Deno.test("watchlist WLQ-09: a visible gap shows the banner even when degraded=false (fix: banner no longer requires the server's `degraded` flag)", () => {
  const symbols = ["AAPL"];
  const quotes = new Map<string, QuoteState>([
    [
      "AAPL",
      {
        entry: {
          symbol: "AAPL",
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "failed",
        },
        stale: false,
      },
    ],
  ]);
  // `degraded` (see isDegraded in lib/watchlist-quotes-logic.ts) is only
  // ever true when the server *deferred* a symbol under upstream-budget
  // pressure — it says nothing about a symbol whose call was dispatched
  // and simply failed. This test used to assert the OPPOSITE of what's
  // below (that degraded=false suppresses the banner even with a real,
  // visible gap) — that was the bug: it hid the banner in exactly the
  // failure mode that most needed it. See WLQ-09b for the full end-to-end
  // shape of that failure.
  assert(computeShowDegradedBanner(symbols, quotes, false));
});

Deno.test("watchlist WLQ-09b: an all-'failed' HTTP-200 response (degraded:false, every row status:'error' reason:'failed') shows the banner, not a silent wall of em-dashes", () => {
  // Regression guard for fix 1. Reproduces the exact response shape a total
  // upstream outage produces: Finnhub down, or the shared rate-limit budget
  // already spent by other routes before this request was even dispatched.
  // Every symbol is dispatched, every one throws, every row comes back
  // `status: "error", reason: "failed"` — and because none of them were
  // *deferred*, the server's `degraded` flag is false. Before this fix,
  // `computeShowDegradedBanner` required `degraded === true`, so this
  // response rendered as N rows of "—" with no banner and no Retry.
  const symbols = ["AAPL", "TSLA", "NVDA"];
  const quotes = new Map<string, QuoteState>(
    symbols.map((symbol) => [
      symbol,
      {
        entry: {
          symbol,
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "failed",
        },
        stale: false,
      },
    ])
  );
  // The response carried `degraded: false` (no symbol was deferred — every
  // one was dispatched and threw). The banner must still show, which is
  // exactly why `computeShowDegradedBanner` takes no `degraded` argument.
  const showTerminalError = false; // HTTP 200 success path, not a fetch failure
  assert(computeShowDegradedBanner(symbols, quotes, showTerminalError));
});

Deno.test("watchlist WLQ-10: the terminal-error banner takes precedence over the degraded banner", () => {
  const symbols = ["AAPL"];
  const quotes = new Map<string, QuoteState>([
    [
      "AAPL",
      {
        entry: {
          symbol: "AAPL",
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "deferred",
        },
        stale: false,
      },
    ],
  ]);
  assertEquals(computeShowDegradedBanner(symbols, quotes, true), false);
});

Deno.test("watchlist WLQ-11: a stale-but-retained good price does not count as a visible gap", () => {
  const symbols = ["AAPL"];
  const quotes = new Map<string, QuoteState>([
    ["AAPL", { entry: OK_AAPL, stale: true }],
  ]);
  // The row is still showing a real (if possibly outdated) price — status
  // is "ok", so it must not trip the "gap" detector just because it's
  // flagged stale.
  assertEquals(computeShowDegradedBanner(symbols, quotes, false), false);
});

// ---------------------------------------------------------------------------
// WLQ-12..15: defect 1 — a real price must render even when the delta is
// null, and must never be discarded by the merge path either.
// ---------------------------------------------------------------------------

Deno.test("watchlist WLQ-12: hasPrice is true for an 'ok' row with a real price and a null change/changePercent", () => {
  assert(
    hasPrice(OK_AAPL_NO_DELTA),
    "a status:ok row with a real price must count as having a displayable price regardless of its delta"
  );
});

Deno.test("watchlist WLQ-13: hasPrice is false for an 'error' row even if price/change happen to be non-null", () => {
  // Defensive case: the server contract guarantees status:"error" rows have
  // null numeric fields, but this must not be trusted blindly — status is
  // checked explicitly, not inferred from price alone.
  const malformed: WatchlistQuoteEntry = {
    symbol: "AAPL",
    status: "error",
    price: 100,
    change: 1,
    changePercent: 1,
    reason: "unavailable",
  };
  assertEquals(hasPrice(malformed), false);
});

Deno.test("watchlist WLQ-14: an 'ok' row with a real price but null delta applies fresh (not retained-through, not discarded)", () => {
  const existing: QuoteState = { entry: OK_AAPL, stale: true };
  const result = mergeQuoteEntry(existing, OK_AAPL_NO_DELTA);
  // It's a fresh "ok" entry, not a transient error — it always applies and
  // clears any prior stale flag, exactly like WLQ-04's full-delta case.
  assertEquals(result.entry, OK_AAPL_NO_DELTA);
  assertEquals(result.entry.price, 150);
  assertEquals(result.stale, false);
  assert(hasPrice(result.entry), "the merged row must still carry a displayable price");
});

Deno.test("watchlist WLQ-15: a no-delta 'ok' row with no prior entry is retained as-is, not treated as an error", () => {
  const result = mergeQuoteEntry(undefined, OK_AAPL_NO_DELTA);
  assertEquals(result.entry, OK_AAPL_NO_DELTA);
  assertEquals(result.stale, false);
  assert(hasPrice(result.entry));
});

// ---------------------------------------------------------------------------
// WLQ-16..19: defect 2 — "is the panel cold" must be measured by whether
// any row holds a real price, not by whether the quotes Map has keys.
// ---------------------------------------------------------------------------

Deno.test("watchlist WLQ-16: hasAnyDisplayablePrice is false for an empty Map", () => {
  assertEquals(hasAnyDisplayablePrice(new Map()), false);
});

Deno.test("watchlist WLQ-17: hasAnyDisplayablePrice is false when every row is a budget-denied error (the cold-start-that-looks-warm case)", () => {
  const quotes = new Map<string, QuoteState>([
    [
      "AAPL",
      {
        entry: {
          symbol: "AAPL",
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "deferred",
        },
        stale: false,
      },
    ],
    [
      "TSLA",
      {
        entry: {
          symbol: "TSLA",
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "deferred",
        },
        stale: false,
      },
    ],
  ]);
  // The Map has 2 keys — a `quotes.size === 0` check would wrongly call
  // this "warm". Neither row has ever shown the user a real number.
  assertEquals(hasAnyDisplayablePrice(quotes), false);
});

Deno.test("watchlist WLQ-18: hasAnyDisplayablePrice is true when at least one row has a real price", () => {
  const quotes = new Map<string, QuoteState>([
    [
      "AAPL",
      {
        entry: {
          symbol: "AAPL",
          status: "error",
          price: null,
          change: null,
          changePercent: null,
          reason: "deferred",
        },
        stale: false,
      },
    ],
    ["TSLA", { entry: OK_AAPL, stale: false }],
  ]);
  assert(hasAnyDisplayablePrice(quotes));
});

Deno.test("watchlist WLQ-19: hasAnyDisplayablePrice is true for a no-delta 'ok' row (defect 1 and defect 2 composed)", () => {
  // Ties the two defects together: an IPO-style row with a price but no
  // delta must count as "the panel is warm", the same way it must render
  // its price (WLQ-12) rather than an em-dash.
  const quotes = new Map<string, QuoteState>([
    ["AAPL", { entry: OK_AAPL_NO_DELTA, stale: false }],
  ]);
  assert(hasAnyDisplayablePrice(quotes));
});
