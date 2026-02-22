import { assertEquals } from "jsr:@std/assert";
import {
  formatChange,
  formatPercent,
  formatPrice,
  isMarketOpen,
} from "../../lib/utils.ts";
import { RANGE_DAYS } from "../../lib/finnhub/types.ts";

// ---------------------------------------------------------------------------
// formatPrice
// ---------------------------------------------------------------------------

Deno.test("formatPrice: formats a positive price with $ and 2 decimal places", () => {
  assertEquals(formatPrice(261.74), "$261.74");
});

Deno.test("formatPrice: formats zero", () => {
  assertEquals(formatPrice(0), "$0.00");
});

Deno.test("formatPrice: rounds to 2 decimal places", () => {
  assertEquals(formatPrice(10.005), "$10.01");
});

// ---------------------------------------------------------------------------
// formatChange
// ---------------------------------------------------------------------------

Deno.test("formatChange: prefixes positive change with +", () => {
  assertEquals(formatChange(3.45), "+3.45");
});

Deno.test("formatChange: does not double-prefix negative change", () => {
  assertEquals(formatChange(-1.23), "-1.23");
});

Deno.test("formatChange: treats zero as positive", () => {
  assertEquals(formatChange(0), "+0.00");
});

// ---------------------------------------------------------------------------
// formatPercent
// ---------------------------------------------------------------------------

Deno.test("formatPercent: wraps positive percent in parentheses with + prefix", () => {
  assertEquals(formatPercent(1.34), "(+1.34%)");
});

Deno.test("formatPercent: wraps negative percent in parentheses without + prefix", () => {
  assertEquals(formatPercent(-2.5), "(-2.50%)");
});

Deno.test("formatPercent: treats zero as positive", () => {
  assertEquals(formatPercent(0), "(+0.00%)");
});

// ---------------------------------------------------------------------------
// RANGE_DAYS
// ---------------------------------------------------------------------------

Deno.test("RANGE_DAYS: 1M maps to 30", () => {
  assertEquals(RANGE_DAYS["1M"], 30);
});

Deno.test("RANGE_DAYS: 3M maps to 90", () => {
  assertEquals(RANGE_DAYS["3M"], 90);
});

Deno.test("RANGE_DAYS: 1Y maps to 365", () => {
  assertEquals(RANGE_DAYS["1Y"], 365);
});

// ---------------------------------------------------------------------------
// isMarketOpen
// ---------------------------------------------------------------------------

Deno.test("isMarketOpen: returns a boolean", () => {
  // The return value is time-dependent; we can only assert the type here.
  assertEquals(typeof isMarketOpen(), "boolean");
});
