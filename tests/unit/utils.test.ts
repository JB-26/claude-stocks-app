import { assertEquals } from "jsr:@std/assert";
import {
  formatChange,
  formatPercent,
  formatPrice,
  getNextMarketOpenLabel,
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

// ---------------------------------------------------------------------------
// getNextMarketOpenLabel
// ---------------------------------------------------------------------------

// Helper: replaces globalThis.Date with a controlled stub, returns a teardown
// function that restores the original Date constructor.
// All test dates use Feb 2026 where Feb 23 = Monday, Feb 27 = Friday,
// Feb 28 = Saturday, Mar 1 = Sunday. ET = UTC-5 (EST) in February.
function stubDate(utcMs: number): { restore: () => void } {
  const OriginalDate = globalThis.Date;
  const fakeNow = new OriginalDate(utcMs);

  // deno-lint-ignore no-explicit-any
  const FakeDate = function (...args: any[]) {
    if (args.length === 0) {
      return new OriginalDate(utcMs);
    }
    // @ts-ignore: spread construct
    return new OriginalDate(...args);
  } as unknown as DateConstructor;

  FakeDate.prototype = OriginalDate.prototype;
  FakeDate.now = () => utcMs;
  FakeDate.parse = OriginalDate.parse;
  FakeDate.UTC = OriginalDate.UTC;

  globalThis.Date = FakeDate;
  return { restore: () => { globalThis.Date = OriginalDate; } };
}

Deno.test("getNextMarketOpenLabel: Friday 16:01 ET returns Monday", () => {
  // Friday Feb 27 2026, 16:01 ET = 21:01 UTC
  const { restore } = stubDate(Date.UTC(2026, 1, 27, 21, 1));
  try {
    assertEquals(getNextMarketOpenLabel(), "Monday at 9:30 AM ET");
  } finally {
    restore();
  }
});

Deno.test("getNextMarketOpenLabel: Saturday returns Monday", () => {
  // Saturday Feb 28 2026, 12:00 ET = 17:00 UTC
  const { restore } = stubDate(Date.UTC(2026, 1, 28, 17, 0));
  try {
    assertEquals(getNextMarketOpenLabel(), "Monday at 9:30 AM ET");
  } finally {
    restore();
  }
});

Deno.test("getNextMarketOpenLabel: Sunday returns Monday", () => {
  // Sunday Mar 1 2026, 12:00 ET = 17:00 UTC
  const { restore } = stubDate(Date.UTC(2026, 2, 1, 17, 0));
  try {
    assertEquals(getNextMarketOpenLabel(), "Monday at 9:30 AM ET");
  } finally {
    restore();
  }
});

Deno.test("getNextMarketOpenLabel: Monday 09:29 ET returns today", () => {
  // Monday Feb 23 2026, 09:29 ET = 14:29 UTC
  const { restore } = stubDate(Date.UTC(2026, 1, 23, 14, 29));
  try {
    assertEquals(getNextMarketOpenLabel(), "today at 9:30 AM ET");
  } finally {
    restore();
  }
});

Deno.test("getNextMarketOpenLabel: Monday 16:01 ET returns Tuesday", () => {
  // Monday Feb 23 2026, 16:01 ET = 21:01 UTC
  const { restore } = stubDate(Date.UTC(2026, 1, 23, 21, 1));
  try {
    assertEquals(getNextMarketOpenLabel(), "Tuesday at 9:30 AM ET");
  } finally {
    restore();
  }
});

Deno.test("getNextMarketOpenLabel: Wednesday 16:01 ET returns Thursday", () => {
  // Wednesday Feb 25 2026, 16:01 ET = 21:01 UTC
  const { restore } = stubDate(Date.UTC(2026, 1, 25, 21, 1));
  try {
    assertEquals(getNextMarketOpenLabel(), "Thursday at 9:30 AM ET");
  } finally {
    restore();
  }
});
