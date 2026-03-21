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
// reads and writes localStorage. Deno does not provide a DOM, so we polyfill
// localStorage with a simple in-memory implementation before each test and
// restore it afterwards. This gives us an SSR-free client environment.
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
 * cleanup function that removes it so SSR-guard tests can verify the
 * `typeof window === 'undefined'` path.
 */
function installFakeLocalStorage(): () => void {
  const fake = makeFakeStorage();
  // deno-lint-ignore no-explicit-any
  (globalThis as any).window = globalThis;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).localStorage = fake;
  return () => {
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).window;
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).localStorage;
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
