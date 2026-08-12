import { assert, assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// watchlist-quotes-validation.test.ts
//
// Unit tests for lib/watchlist-quotes-validation.ts — parseSymbolsParam.
//
// The function is the trust boundary for GET /api/stock/watchlist-quotes. It
// lives outside the Route Handler precisely so it can be imported here with a
// relative path — route handlers use "@/" aliases that plain `deno test`
// cannot resolve (see tests/unit/search-route.test.ts for the same note).
// ---------------------------------------------------------------------------

import { parseSymbolsParam } from "../../lib/watchlist-quotes-validation.ts";
import { MAX_WATCHLIST } from "../../lib/watchlist.ts";

/** Narrowing helper — asserts the result is ok and returns its symbols. */
function okSymbols(result: ReturnType<typeof parseSymbolsParam>): string[] {
  assert(result.ok, `expected ok result, got error "${!result.ok && result.error}"`);
  return result.symbols;
}

// ---------------------------------------------------------------------------
// WQV-01: a missing param is an error (route → 400 "Missing symbols parameter")
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-validation WQV-01: null returns error 'missing'", () => {
  assertEquals(parseSymbolsParam(null), { ok: false, error: "missing" });
});

Deno.test("watchlist-quotes-validation WQV-01b: empty string returns error 'missing'", () => {
  assertEquals(parseSymbolsParam(""), { ok: false, error: "missing" });
});

Deno.test("watchlist-quotes-validation WQV-01c: whitespace-only string returns error 'missing'", () => {
  assertEquals(parseSymbolsParam("   "), { ok: false, error: "missing" });
});

// ---------------------------------------------------------------------------
// WQV-02: the happy path preserves input order
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-validation WQV-02: a valid comma-separated list is returned in input order", () => {
  assertEquals(okSymbols(parseSymbolsParam("AAPL,MSFT,TSLA")), [
    "AAPL",
    "MSFT",
    "TSLA",
  ]);
});

Deno.test("watchlist-quotes-validation WQV-02b: a single symbol is accepted", () => {
  assertEquals(okSymbols(parseSymbolsParam("V")), ["V"]);
});

// ---------------------------------------------------------------------------
// WQV-03: the MAX_WATCHLIST cap is a hard error, not silent truncation
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-validation WQV-03: more than MAX_WATCHLIST distinct symbols returns error 'too_many'", () => {
  const letters = "ABCDEFGHIJKLMNOPQRSTU"; // 21 letters
  const symbols = Array.from(letters, (letter) => `X${letter}`);
  assertEquals(symbols.length, MAX_WATCHLIST + 1);

  assertEquals(parseSymbolsParam(symbols.join(",")), {
    ok: false,
    error: "too_many",
  });
});

Deno.test("watchlist-quotes-validation WQV-03b: exactly MAX_WATCHLIST symbols is accepted", () => {
  const letters = "ABCDEFGHIJKLMNOPQRST"; // 20 letters
  const symbols = Array.from(letters, (letter) => `X${letter}`);
  assertEquals(symbols.length, MAX_WATCHLIST);

  assertEquals(okSymbols(parseSymbolsParam(symbols.join(","))), symbols);
});

Deno.test("watchlist-quotes-validation WQV-03c: the cap is applied AFTER dedup, so 21 segments with a duplicate still pass", () => {
  const letters = "ABCDEFGHIJKLMNOPQRST"; // 20 distinct
  const symbols = Array.from(letters, (letter) => `X${letter}`);
  const withDuplicate = [...symbols, "XA"]; // 21 segments, 20 distinct

  assertEquals(okSymbols(parseSymbolsParam(withDuplicate.join(","))), symbols);
});

// ---------------------------------------------------------------------------
// WQV-04: dedup preserves first-occurrence order
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-validation WQV-04: duplicate segments are deduped, keeping first-occurrence order", () => {
  assertEquals(okSymbols(parseSymbolsParam("AAPL,AAPL,MSFT")), [
    "AAPL",
    "MSFT",
  ]);
});

Deno.test("watchlist-quotes-validation WQV-04b: a later duplicate does not move a symbol's position", () => {
  assertEquals(okSymbols(parseSymbolsParam("MSFT,AAPL,MSFT,TSLA")), [
    "MSFT",
    "AAPL",
    "TSLA",
  ]);
});

// ---------------------------------------------------------------------------
// WQV-05: invalid segments are silently dropped, not surfaced as errors
//
// NOTE: "BRK.B" is asserted to be DROPPED here on purpose. SYMBOL_RE
// (/^[A-Z]{1,10}$/) rejects dotted tickers — a known defect tracked as backlog
// item F5, deliberately NOT fixed in this feature. Because addToWatchlist()
// applies the same regex on write, "BRK.B" can never reach this route from our
// own client anyway. Do not "fix" this test before F5 lands; the regex must be
// changed in one place, not piecemeal per route.
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-validation WQV-05: lowercase and dotted segments are dropped, valid ones kept", () => {
  assertEquals(okSymbols(parseSymbolsParam("AAPL,brk.b,BRK.B,TSLA")), [
    "AAPL",
    "TSLA",
  ]);
});

Deno.test("watchlist-quotes-validation WQV-05b: segments over 10 characters are dropped", () => {
  assertEquals(okSymbols(parseSymbolsParam("AAPL,ABCDEFGHIJK,MSFT")), [
    "AAPL",
    "MSFT",
  ]);
});

Deno.test("watchlist-quotes-validation WQV-05c: segments containing digits or symbols are dropped", () => {
  assertEquals(okSymbols(parseSymbolsParam("AAPL,MS4FT,TS-LA,NVDA")), [
    "AAPL",
    "NVDA",
  ]);
});

Deno.test("watchlist-quotes-validation WQV-05d: empty segments from stray commas are dropped", () => {
  assertEquals(okSymbols(parseSymbolsParam("AAPL,,MSFT,")), ["AAPL", "MSFT"]);
});

// ---------------------------------------------------------------------------
// WQV-06: whitespace around segments is trimmed
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-validation WQV-06: whitespace around segments is trimmed before validation", () => {
  assertEquals(okSymbols(parseSymbolsParam("AAPL, MSFT ,\tTSLA")), [
    "AAPL",
    "MSFT",
    "TSLA",
  ]);
});

// ---------------------------------------------------------------------------
// WQV-07: all-invalid input is a successful empty result, not an error
// (mirrors the route's 200 { "quotes": [] } contract)
// ---------------------------------------------------------------------------

Deno.test("watchlist-quotes-validation WQV-07: an all-invalid list returns ok with an empty symbol array", () => {
  assertEquals(okSymbols(parseSymbolsParam("aapl,brk.b,123")), []);
});

Deno.test("watchlist-quotes-validation WQV-07b: a comma-only string returns ok with an empty symbol array", () => {
  assertEquals(okSymbols(parseSymbolsParam(",,,")), []);
});
